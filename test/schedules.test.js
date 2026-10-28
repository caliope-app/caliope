import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextRunTime, validateSchedules, Scheduler, scheduleFromAgent } from '../server/schedules.js';
import { ProjectStore } from '../server/projects.js';

const log = { info() {}, warn() {}, error() {} };
// Thursday 15 October 2026, local time.
const at = (day, time) => new Date(`2026-10-${String(day).padStart(2, '0')}T${time}:00`);

test('the next run time of hourly, daily, weekday and weekly tasks', () => {
  assert.deepEqual(nextRunTime({ every: 'hourly', at: '00:15' }, at(15, '10:20')), at(15, '11:15'));
  assert.deepEqual(nextRunTime({ every: 'hourly', at: '00:15' }, at(15, '10:05')), at(15, '10:15'));
  assert.deepEqual(nextRunTime({ every: 'daily', at: '09:00' }, at(15, '08:59')), at(15, '09:00'));
  assert.deepEqual(nextRunTime({ every: 'daily', at: '09:00' }, at(15, '09:00')), at(16, '09:00'), 'not the same minute again');
  assert.deepEqual(nextRunTime({ every: 'weekdays', at: '09:00' }, at(16, '10:00')), at(19, '09:00'), 'Friday after nine: Monday');
  assert.deepEqual(nextRunTime({ every: 'weekly', at: '17:30', day: 3 }, at(15, '18:00')), at(21, '17:30'), 'next Wednesday');
  assert.deepEqual(nextRunTime({ every: 'weekly', at: '17:30', day: 4 }, at(15, '17:00')), at(15, '17:30'), 'later today');
});

test('reminders and loops: run after some minutes, loops end after 7 days', () => {
  const now = at(15, '10:00');
  const [loop, reminder] = validateSchedules([
    { name: 'Build', prompt: 'Check the build', every: 'minutes', minutes: 10, sessionId: 's9' },
    { name: 'Deploy', prompt: 'Check the deploy', every: 'once', minutes: 30 },
  ], [], now);
  assert.deepEqual([loop.nextRunAt, loop.sessionId, loop.expiresAt], [at(15, '10:10').toISOString(), 's9', at(22, '10:00').toISOString()]);
  assert.equal(reminder.nextRunAt, at(15, '10:30').toISOString());
  assert.equal(reminder.expiresAt, null);
  assert.throws(() => validateSchedules([{ name: 'x', prompt: 'y', every: 'minutes', minutes: 2 }]), /5 to 1440 minutes/);
  assert.equal(validateSchedules([{ name: 'x', prompt: 'y', every: 'once', at: '17:00' }], [], now)[0].nextRunAt, at(15, '17:00').toISOString());
});

test('a reminder in a session comes back there once, waits while the session is busy, and an expired loop is removed', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-reminders-'));
  const projects = new ProjectStore(path.join(folder, 'projects.json'));
  const sent = [];
  const runners = new Map([['s1', { state: 'running', busy: () => true }]]);
  const agents = {
    runners,
    auth: { status: () => ({ signedIn: true }) },
    store: { get: async (id) => (id === 's1' ? { meta: { id, cwd: folder, archived: false } } : null) },
    runner: (id) => ({ submit: async (input) => sent.push({ id, text: `${input.scheduled.name} (${input.scheduled.when}): ${input.text}`, limit: [input.scheduled.id, input.scheduled.maxCredits] }) }),
  };
  const scheduler = new Scheduler({ agents, projects, hub: { broadcast() {} }, log });
  const tasks = validateSchedules([
    { id: 'remind', name: 'Deploy', prompt: 'Check the deploy', every: 'once', minutes: 30, sessionId: 's1' },
    { id: 'loop', name: 'Build', prompt: 'Check the build', every: 'minutes', minutes: 10, sessionId: 's1' },
  ], [], at(15, '10:00'));
  await projects.update(folder, { schedules: tasks });
  await scheduler.check(at(15, '10:31'));
  assert.equal(sent.length, 0, 'the session is busy');
  assert.ok(projects.get(folder).schedules.some((task) => task.id === 'remind'), 'the reminder waits');
  // The turn ended. A dev server the agent started keeps running in the background, which does not block.
  runners.set('s1', { state: 'idle', busy: () => true });
  await scheduler.check(at(15, '10:32'));
  assert.deepEqual(sent.map((item) => item.text), ['Deploy (once, 30 minutes after it was set): Check the deploy'], 'the loop skipped its busy 10:31 turn');
  assert.deepEqual(projects.get(folder).schedules.map((task) => task.id), ['loop'], 'the reminder is gone after it ran');
  await scheduler.check(at(15, '10:42'));
  assert.equal(sent.at(-1).text, 'Build (every 10 minutes): Check the build');
  assert.deepEqual(sent.at(-1).limit, ['loop', 50], 'each run brings the task\'s limit per run');
  assert.equal(projects.get(folder).schedules[0].runs, 1);
  await scheduler.check(at(22, '10:01'));
  assert.deepEqual(projects.get(folder).schedules, [], 'the loop ended after 7 days');
});

test('in plan mode, removing a task of another session asks the user first', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-plan-delete-'));
  const projects = new ProjectStore(path.join(folder, 'projects.json'));
  await projects.update(folder, { schedules: validateSchedules([{ id: 'loop', name: 'Build', prompt: 'Check the build', every: 'minutes', minutes: 10, sessionId: 's1' }]) });
  const manager = { projects, hub: { broadcast() {} } };
  const asked = [];
  const ask = async (request) => {
    asked.push(request.name);
    return { allowed: false, message: 'The user denied this action.' };
  };
  const result = await scheduleFromAgent({ manager, session: { meta: { id: 's2', cwd: folder, mode: 'plan' } }, input: { action: 'delete', id: 'loop' }, ask });
  assert.deepEqual(asked, ['Build']);
  assert.ok(result.isError);
  assert.equal(projects.get(folder).schedules.length, 1, 'the task stays');
});

test('scheduled tasks are checked; editing the prompt keeps the next run, changing the time moves it', () => {
  const now = at(15, '10:00');
  assert.throws(() => validateSchedules([{ name: 'x', prompt: '', every: 'daily', at: '09:00' }]), /name and a prompt/);
  assert.throws(() => validateSchedules([{ name: 'x', prompt: 'y', every: 'monthly', at: '09:00' }]), /"every"/);
  assert.throws(() => validateSchedules([{ name: 'x', prompt: 'y', every: 'daily', at: '9:00' }]), /HH:MM/);
  assert.throws(() => validateSchedules([{ name: 'x', prompt: 'y', every: 'weekly', at: '09:00' }]), /needs a day/);
  const [created] = validateSchedules([{ name: 'Report', prompt: 'Summarize', every: 'daily', at: '09:00', mode: 'nonsense' }], [], now);
  assert.equal(created.nextRunAt, at(16, '09:00').toISOString());
  assert.deepEqual([created.mode, created.maxCredits, created.enabled, created.worktree], ['ask', 50, true, false]);
  const ran = { ...created, lastRunAt: 'earlier', lastSessionId: 's1' };
  const [edited] = validateSchedules([{ ...ran, prompt: 'Summarize better' }], [ran], at(15, '12:00'));
  assert.deepEqual([edited.nextRunAt, edited.lastSessionId], [created.nextRunAt, 's1']);
  const [moved] = validateSchedules([{ ...ran, at: '13:00' }], [ran], at(15, '12:00'));
  assert.equal(moved.nextRunAt, at(15, '13:00').toISOString());
  const [paused] = validateSchedules([{ ...ran, enabled: false }], [ran], now);
  assert.equal(paused.nextRunAt, null);
});

test('the scheduler starts a due task once, skips a time while the previous run still works, and ignores paused tasks', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-schedules-'));
  const projects = new ProjectStore(path.join(folder, 'projects.json'));
  const started = [];
  const runners = new Map();
  const sessions = [];
  const agents = {
    runners,
    auth: { status: () => ({ signedIn: true }) },
    store: { save: async () => {} },
    resolveModel: (id) => (id === 'cheap' ? { id, protocol: 'messages' } : null),
    broadcastMeta() {},
    async createSession({ cwd, mode, trust }) {
      const session = { meta: { id: `s${sessions.length + 1}`, cwd, mode, model: 'default', trust } };
      sessions.push(session);
      return session;
    },
    runner: (id) => ({ submit: async (input) => started.push({ id, text: input.text }) }),
  };
  const scheduler = new Scheduler({ agents, projects, hub: { broadcast() {} }, log });
  const schedules = validateSchedules(
    [
      { id: 'due', name: 'Pipelines', prompt: 'Check the pipelines', every: 'daily', at: '09:00', mode: 'edits', model: 'cheap' },
      { id: 'paused', name: 'Paused', prompt: 'Nothing', every: 'daily', at: '09:00', enabled: false },
    ],
    [],
    at(14, '10:00'),
  );
  await projects.update(folder, { trusted: true, schedules });

  // Caliope was closed on the 15th and 16th: one run for the missed times, then the next one in the future.
  await scheduler.check(at(17, '08:00'));
  assert.deepEqual(started, [{ id: 's1', text: 'Check the pipelines' }]);
  assert.deepEqual([sessions[0].meta.mode, sessions[0].meta.model, sessions[0].meta.trust, sessions[0].meta.schedule.name], ['edits', 'cheap', null, 'Pipelines'], 'trust stays as the project has it');
  assert.match(sessions[0].meta.title, /^Pipelines · /);
  let saved = projects.get(folder).schedules[0];
  assert.deepEqual([saved.nextRunAt, saved.lastSessionId], [at(17, '09:00').toISOString(), 's1']);
  await scheduler.check(at(17, '08:30'));
  assert.equal(started.length, 1, 'not due again before 09:00');

  // At 09:00 the first run still waits for an approval: this time is skipped.
  runners.set('s1', { busy: () => true });
  await scheduler.check(at(17, '09:00'));
  assert.equal(started.length, 1);
  saved = projects.get(folder).schedules[0];
  assert.equal(saved.nextRunAt, at(18, '09:00').toISOString());
  runners.set('s1', { busy: () => false });
  await scheduler.check(at(18, '09:01'));
  assert.equal(started.length, 2);
  assert.equal(projects.get(folder).schedules[1].lastSessionId, null, 'a paused task never runs');
});
