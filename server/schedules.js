// Scheduled tasks: a prompt that runs later or repeatedly in a project. The user adds them on the project
// page. The agent adds them with its schedule tool (reminders, loops, recurring checks).
// - They run only while Caliope runs. A time missed while it was closed or the PC slept gives one run
//   when Caliope is back, not one per missed time.
// - A task with a session (`sessionId`) sends its prompt to that session as a message, so the agent keeps
//   its context. Otherwise each run is a new session.
// - A run is an ordinary turn: approvals wait for the user, and the project's monthly limit and the
//   task's own credit limit (new sessions) stop it.
import fs from 'node:fs';
import { newId, truncateMiddle } from './util.js';
import { MODES } from './settings.js';
import { projectFolderOf } from './projects.js';

// `once` is a reminder (after `minutes`, or at the next `at`). `minutes` is a loop every `minutes`.
export const EVERY = ['once', 'minutes', 'hourly', 'daily', 'weekdays', 'weekly'];
const CHECK_MS = 60000;
// A loop stops by itself after this long, like Claude Code's, or after this many runs.
const LOOP_DAYS = 7;
const MAX_LOOP_RUNS = 100;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Check scheduled tasks. `previous` keeps the run state of tasks that already exist.
 * - A task: { id, name, prompt, every, at: 'HH:MM', minutes, day (0 = Sunday, weekly), mode, model,
 *   maxCredits, worktree, enabled, sessionId, expiresAt }.
 * - Throws a message naming the problem.
 */
export function validateSchedules(list, previous = [], now = new Date()) {
  if (!Array.isArray(list) || list.length > 20) throw new Error('A project can have up to 20 scheduled tasks.');
  const schedules = list.map((item) => {
    const name = String(item?.name || '').trim().slice(0, 80);
    const prompt = String(item?.prompt || '').trim();
    if (!name || !prompt) throw new Error('A scheduled task needs a name and a prompt.');
    if (prompt.length > 20000) throw new Error('The prompt of a scheduled task can be up to 20,000 characters.');
    if (!EVERY.includes(item.every)) throw new Error(`"every" is one of ${EVERY.join(', ')}.`);
    const minutes = item.every === 'minutes' || (item.every === 'once' && item.minutes != null) ? Number(item.minutes) : null;
    if (item.every === 'minutes' && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440)) throw new Error('A loop runs every 5 to 1440 minutes.');
    if (item.every === 'once' && minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080)) throw new Error('A reminder runs 1 to 10,080 minutes from now.');
    const at = minutes === null ? item.at : null;
    if (minutes === null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at || '')) throw new Error('The time is HH:MM, for example 09:00.');
    const day = item.every === 'weekly' ? Number(item.day) : null;
    if (item.every === 'weekly' && !(Number.isInteger(day) && day >= 0 && day <= 6)) throw new Error('A weekly task needs a day.');
    const mode = MODES.includes(item.mode) ? item.mode : 'ask';
    const maxCredits = Number(item.maxCredits ?? 50);
    if (!(maxCredits > 0 && maxCredits <= 100000)) throw new Error('The limit per run is a number of AI credits above 0.');
    const id = typeof item.id === 'string' && /^[\w-]{1,40}$/.test(item.id) ? item.id : newId('task');
    const before = previous.find((other) => other.id === id);
    const sessionId = typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : null;
    const expiresAt = before?.expiresAt || (item.every === 'minutes' ? new Date(now.getTime() + LOOP_DAYS * 86400000).toISOString() : null);
    const schedule = { id, name, prompt, every: item.every, at, minutes, day, mode, model: typeof item.model === 'string' && item.model ? item.model : null, maxCredits, worktree: item.worktree === true, enabled: item.enabled !== false, sessionId, expiresAt };
    // The next run stays when the timing did not change, so editing the prompt does not move or repeat a run.
    const sameTiming = before && before.every === schedule.every && before.at === schedule.at && before.minutes === schedule.minutes && before.day === schedule.day && before.enabled === schedule.enabled;
    schedule.nextRunAt = sameTiming ? before.nextRunAt : schedule.enabled ? nextRunTime(schedule, now).toISOString() : null;
    schedule.lastRunAt = before?.lastRunAt || null;
    schedule.lastSessionId = before?.lastSessionId || null;
    schedule.runs = before?.runs || 0;
    return schedule;
  });
  return schedules;
}

/** "every weekday at 09:00", "every 10 minutes", "once, 30 minutes after it was set". */
export function describeSchedule(schedule) {
  if (schedule.every === 'minutes') return `every ${schedule.minutes} minutes`;
  if (schedule.every === 'once') return schedule.minutes ? `once, ${schedule.minutes} minutes after it was set` : `once at ${schedule.at}`;
  if (schedule.every === 'hourly') return `every hour at :${schedule.at.slice(3)}`;
  const when = { daily: 'every day', weekdays: 'every weekday', weekly: `every ${DAYS[schedule.day]}` }[schedule.every];
  return `${when} at ${schedule.at}`;
}

/** The first time after `after` (local time) the task runs. Hourly tasks use the minutes of `at`. */
export function nextRunTime(schedule, after) {
  if (schedule.minutes) return new Date(after.getTime() + schedule.minutes * 60000);
  const [hours, minutes] = schedule.at.split(':').map(Number);
  const next = new Date(after);
  next.setSeconds(0, 0);
  if (schedule.every === 'hourly') {
    next.setMinutes(minutes);
    if (next <= after) next.setHours(next.getHours() + 1);
    return next;
  }
  next.setHours(hours, minutes);
  const fits = (date) => (schedule.every === 'weekdays' ? date.getDay() >= 1 && date.getDay() <= 5 : schedule.every === 'weekly' ? date.getDay() === schedule.day : true);
  while (next <= after || !fits(next)) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * The agent's schedule tool: list, add or remove the scheduled tasks of the session's project.
 * - Adding asks the user (`ask`) in ask and edits mode. In Auto, the safety check first reads a task that
 *   repeats beyond a loop or starts new sessions. Plan mode refuses. The task runs in the session's mode and model.
 * - `here` (default for reminders and loops): the prompt comes back as a message in this session.
 *   Otherwise every run is a new session.
 * - Returns { content, isError, stopTurn }.
 */
export async function scheduleFromAgent({ manager, session, input, ask, signal }) {
  const folder = projectFolderOf(session.meta);
  const project = manager.projects.get(folder);
  const where = (task) => (task.sessionId === session.meta.id ? 'in this session' : task.sessionId ? 'in another session' : 'a new session each time');
  if (input.action === 'list') {
    const lines = project.schedules.map((task) => `- "${task.name}" (id ${task.id}): ${describeSchedule(task)}, ${where(task)}${task.enabled ? '' : ', paused'}`);
    return { content: lines.length > 0 ? lines.join('\n') : 'This project has no scheduled tasks.' };
  }
  const asks = session.meta.mode === 'ask' || session.meta.mode === 'edits';
  if (input.action === 'delete') {
    // Plan mode changes nothing without the user: removing a task of the user or another session asks there too.
    const asksToDelete = asks || session.meta.mode === 'plan';
    const named = project.schedules.filter((item) => item.name === input.name);
    const task = project.schedules.find((item) => item.id === input.id) || (named.length === 1 ? named[0] : null);
    if (!task) return { content: `There is no single scheduled task "${input.id || input.name}". Use action "list" and delete it by id.`, isError: true };
    // Ending this session's own reminder or loop needs no approval. A task of the user or another session does.
    if (task.sessionId !== session.meta.id && asksToDelete) {
      const permission = await ask({ request: 'schedule', tool: 'schedule', remove: true, name: task.name, when: describeSchedule(task), here: false, mode: task.mode, prompt: truncateMiddle(task.prompt, 2000) });
      if (!permission.allowed) return { content: permission.message, isError: true, stopTurn: permission.stopTurn };
    }
    await manager.projects.update(folder, { schedules: manager.projects.get(folder).schedules.filter((item) => item.id !== task.id) });
    manager.hub.broadcast({ type: 'projects' });
    return { content: `Removed the scheduled task "${task.name}".` };
  }
  if (session.meta.mode === 'plan') return { content: 'Plan mode is on, so nothing can be scheduled yet. Put it in your plan.', isError: true };
  const here = input.here ?? ['once', 'minutes'].includes(input.every);
  const draft = { name: input.name, prompt: input.prompt, every: input.every, at: input.at, minutes: input.minutes, day: input.day, mode: session.meta.mode, model: session.meta.model, sessionId: here ? session.meta.id : null };
  let task;
  try {
    task = validateSchedules([...project.schedules, draft], project.schedules).at(-1);
  } catch (error) {
    return { content: error.message, isError: true };
  }
  const request = { request: 'schedule', tool: 'schedule', name: task.name, when: describeSchedule(task), here, mode: task.mode, prompt: truncateMiddle(task.prompt, 2000) };
  // Full access schedules without asking, and Auto a reminder or loop in this session. A task that repeats
  // every hour, day or week, or starts new sessions, runs later without anyone watching: in Auto, the safety
  // check reads its prompt first. Each run's commands still pass the mode's checks.
  let approved = !asks;
  if (session.meta.mode === 'auto' && (!here || !['once', 'minutes'].includes(task.every))) {
    const verdict = await manager.classifyCommand(session, { command: `Schedule "${task.name}" ${describeSchedule(task)}, ${here ? 'in this session' : 'in a new session each time'}, to run this prompt in Auto mode:\n${request.prompt}`, cwd: '.', description: 'Schedule a task', tool: { server: 'built-in', name: 'schedule' } }, signal);
    approved = verdict.decision === 'allow';
    if (!approved) request.reason = verdict.reason;
  }
  if (!approved) {
    const permission = await ask(request);
    if (!permission.allowed) return { content: permission.message, isError: true, stopTurn: permission.stopTurn };
  }
  await manager.projects.update(folder, { schedules: [...manager.projects.get(folder).schedules, task] });
  manager.hub.broadcast({ type: 'projects' });
  const first = new Date(task.nextRunAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const ending = task.every === 'minutes' ? ` Remove it with action "delete" once its goal is reached; it ends after ${MAX_LOOP_RUNS} runs or ${LOOP_DAYS} days at the latest.` : '';
  const content = `Scheduled "${task.name}" (id ${task.id}): ${describeSchedule(task)}, ${where(task)}, first run ${first}. It runs while Caliope is open.${ending}`;
  return { content };
}

/** Starts the tasks that are due, every minute while Caliope runs. */
export class Scheduler {
  constructor({ agents, projects, hub, log }) {
    this.agents = agents;
    this.projects = projects;
    this.hub = hub;
    this.log = log;
    this.timer = null;
    // One check at a time: creating a worktree can take longer than the minute between checks.
    this.checking = false;
    // Tasks whose run is being started, so "Run now" and a timed start cannot start one twice.
    this.starting = new Set();
  }

  start() {
    this.timer = setInterval(() => this.check().catch((error) => this.log.error('Scheduled tasks check failed.', error)), CHECK_MS);
    this.timer.unref?.();
    this.check().catch((error) => this.log.error('Scheduled tasks check failed.', error));
  }

  stop() {
    clearInterval(this.timer);
  }

  /**
   * Start every enabled task whose time has come.
   * - A task whose last run still works (a turn, an approval it waits for, or a background command) waits
   *   for the next time.
   */
  async check(now = new Date()) {
    // Nothing runs before the user is signed in. Due tasks wait for it.
    if (this.checking || !this.agents.auth.status().signedIn) return;
    this.checking = true;
    try {
      for (const { folder, schedules } of this.projects.saved()) {
        for (const { id } of schedules) {
          // Read the task again: an earlier run in this check may have taken time.
          const schedule = this.projects.get(folder).schedules.find((item) => item.id === id);
          if (schedule?.expiresAt && new Date(schedule.expiresAt) <= now) {
            await this.removeTask(folder, id);
            continue;
          }
          if (!schedule?.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) continue;
          // In the agent's own session a run waits while a turn works or waits for the user (a dev server it
          // started in the background does not count). A new-session task waits for its previous run.
          const runner = this.agents.runners.get(schedule.sessionId || schedule.lastSessionId);
          const busy = Boolean(runner && (schedule.sessionId ? runner.state === 'running' : runner.busy()));
          // A reminder waits until its session is free. A repeating task skips this time.
          if (busy && schedule.every === 'once') continue;
          // The next time is saved before the run starts, so a restart cannot start the same run twice.
          if (schedule.every !== 'once') await this.saveRun(folder, id, { nextRunAt: nextRunTime(schedule, now).toISOString() });
          if (busy) {
            this.log.info(`Scheduled task "${schedule.name}" in ${folder}: the previous run still works, so this one is skipped.`);
            continue;
          }
          await this.run(folder, id).catch((error) => this.log.warn(`Scheduled task "${schedule.name}" in ${folder} did not start: ${error.message}`));
        }
      }
    } finally {
      this.checking = false;
    }
  }

  /** Start one run now; a reminder is removed once it ran. Returns the session it runs in. */
  async run(folder, id) {
    const key = `${folder}|${id}`;
    if (this.starting.has(key)) throw new Error('This task is starting a run already.');
    this.starting.add(key);
    try {
      const schedule = this.projects.get(folder).schedules.find((item) => item.id === id);
      if (!schedule) throw new Error('There is no scheduled task with that id in this project.');
      const session = schedule.sessionId ? await this.continueSession(folder, schedule) : await this.startRun(folder, schedule);
      if (schedule.every === 'once') await this.removeTask(folder, id);
      return session;
    } finally {
      this.starting.delete(key);
    }
  }

  /**
   * A reminder or loop of the agent: the prompt goes to its session as a message, so the agent keeps its context.
   * - A deleted or archived session, or one whose folder is gone, ends the task.
   * - A loop the agent forgets to end stops after MAX_LOOP_RUNS runs.
   */
  async continueSession(folder, schedule) {
    const session = await this.agents.store.get(schedule.sessionId);
    if (!session || session.meta.archived || !fs.existsSync(session.meta.cwd)) {
      await this.removeTask(folder, schedule.id);
      throw new Error('Its session was deleted or archived, or its folder is gone, so the task was removed.');
    }
    const runs = (schedule.runs || 0) + 1;
    await this.saveRun(folder, schedule.id, { lastRunAt: new Date().toISOString(), lastSessionId: session.meta.id, runs });
    // `id` and `maxCredits`: this run stops at the task's limit, counted from what the session spent so far.
    await this.agents.runner(session.meta.id).submit({ text: schedule.prompt, scheduled: { id: schedule.id, name: schedule.name, when: describeSchedule(schedule), maxCredits: schedule.maxCredits } });
    if (schedule.every === 'minutes' && runs >= MAX_LOOP_RUNS) await this.removeTask(folder, schedule.id);
    this.log.info(`Scheduled task "${schedule.name}" continued session ${session.meta.id} in ${folder}.`);
    return session;
  }

  async startRun(folder, schedule) {
    const id = schedule.id;
    // Checked before the session exists, so a run that cannot start leaves no empty session behind.
    if (!this.agents.auth.status().signedIn) throw new Error('Sign in to GitHub Copilot first.');
    if (!fs.existsSync(folder)) throw new Error(`The project folder ${folder} no longer exists.`);
    // A folder nobody decided to trust yet runs without its own instruction files, skills and MCP servers.
    const session = await this.agents.createSession({ cwd: folder, mode: schedule.mode, worktree: schedule.worktree, trust: null });
    const started = new Date();
    session.meta.schedule = { id: schedule.id, name: schedule.name, maxCredits: schedule.maxCredits };
    session.meta.title = `${schedule.name} · ${started.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    session.meta.titleSource = 'schedule';
    if (schedule.model && this.agents.resolveModel(schedule.model)?.protocol) session.meta.model = schedule.model;
    await this.agents.store.save(session.meta.id);
    this.agents.broadcastMeta(session);
    const runs = (schedule.runs || 0) + 1;
    await this.saveRun(folder, id, { lastRunAt: started.toISOString(), lastSessionId: session.meta.id, runs });
    try {
      await this.agents.runner(session.meta.id).submit({ text: schedule.prompt, scheduled: { name: schedule.name, when: describeSchedule(schedule) } });
    } catch (error) {
      // The session shows why it did not start.
      this.agents.appendEvent(session, { kind: 'error', text: `The scheduled task did not start: ${error.message}`, retryable: false });
      throw error;
    }
    if (schedule.every === 'minutes' && runs >= MAX_LOOP_RUNS) await this.removeTask(folder, id);
    this.log.info(`Scheduled task "${schedule.name}" started session ${session.meta.id} in ${folder}.`);
    return session;
  }

  async removeTask(folder, id) {
    const project = this.projects.get(folder);
    await this.projects.update(folder, { schedules: project.schedules.filter((item) => item.id !== id) });
    this.hub.broadcast({ type: 'projects' });
  }

  async saveRun(folder, id, changes) {
    const project = this.projects.get(folder);
    await this.projects.update(folder, { schedules: project.schedules.map((item) => (item.id === id ? { ...item, ...changes } : item)) });
    this.hub.broadcast({ type: 'projects' });
  }
}
