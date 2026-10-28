// Project page: one per folder. Instructions for its sessions, skills it offers, its sessions and spending.
import { h, clear, relativeTime, formatCost, formatCredits, projectFolder } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { toast, toastError } from './dialogs.js';
import { MODES } from './composer.js';

const MODE_LABELS = Object.fromEntries(MODES.map((mode) => [mode.id, mode.name]));

// Limits are stored in AI credits and typed in the unit costs show in (1 credit is US$0.01).
const inDollars = () => (state.settings?.costUnit || 'usd') === 'usd';
const creditsToInput = (credits) => (inDollars() ? credits / 100 : credits);
const inputToCredits = (value) => (inDollars() ? Math.round(Number(value) * 100) : Number(value));
const limitUnit = () => (inDollars() ? 'US$' : 'AI credits');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Every weekday at 09:00", "Every hour at :15", "Every 10 minutes", "Once". */
function describeSchedule(schedule) {
  if (schedule.every === 'minutes') return `Every ${schedule.minutes} minutes`;
  if (schedule.every === 'once') return schedule.at ? `Once at ${schedule.at}` : 'Once';
  if (schedule.every === 'hourly') return `Every hour at :${schedule.at.slice(3)}`;
  const when = { daily: 'Every day', weekdays: 'Every weekday', weekly: `Every ${DAYS[schedule.day]}` }[schedule.every];
  return `${when} at ${schedule.at}`;
}

export function mountProject(container) {
  const subscriptions = [];
  const folder = state.projectFolder;
  const content = h('div', { class: 'page-inner' });
  container.append(h('div', { class: 'view' }, h('div', { class: 'page' }, content)));
  let details = null;

  async function load() {
    try {
      details = await api.get(`/api/project?folder=${encodeURIComponent(folder)}`);
      render();
    } catch (error) {
      clear(content).append(h('h1', {}, 'Project not available'), h('p', { class: 'muted' }, error.message));
    }
  }

  function render() {
    if (!details) return;
    clear(content);
    const unit = state.settings?.costUnit;
    const sessions = [...state.sessions.values()].filter((meta) => projectFolder(meta).toLowerCase() === folder.toLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const spent = sessions.reduce((sum, meta) => sum + (meta.usage?.nanoAiu || 0), 0);

    const nameInput = h('input', { class: 'input', value: details.project.name, style: { fontSize: '20px', fontWeight: '650', height: '40px' } });
    nameInput.addEventListener('change', () => save({ name: nameInput.value }));
    content.append(
      h('div', { class: 'row', style: { marginBottom: '6px' } }, h('span', { html: icon('folder', 22) }), h('div', { class: 'grow' }, nameInput)),
      h(
        'div',
        { class: 'row muted', style: { flexWrap: 'wrap', marginBottom: '18px', fontSize: '13px' } },
        h('span', { class: 'mono' }, folder),
        details.branch ? h('span', { class: 'chip' }, h('span', { html: icon('git-branch', 12) }), details.branch) : null,
        h('button', { class: 'btn small', onClick: () => actions.openPath(folder, false) }, h('span', { html: icon('folder-open', 13) }), 'Open folder'),
      ),
      h(
        'div',
        { class: 'row', style: { marginBottom: '22px' } },
        h('button', { class: 'btn primary', onClick: () => actions.newSessionIn(folder) }, h('span', { html: icon('plus', 15) }), 'New session in this project'),
        h('span', { class: 'muted', style: { marginLeft: '8px' } }, `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${formatCost(spent, unit)} spent`),
      ),
    );

    // Monthly spending limit: the agent stops calling models in this project once it is reached.
    const limit = details.project.creditLimit;
    const spentCredits = details.spentThisMonth / 1e9;
    const share = limit ? Math.min(1, spentCredits / limit) : 0;
    const limitInput = h('input', { class: 'input', type: 'number', min: '0', step: inDollars() ? '1' : '10', value: limit ? creditsToInput(limit) : '', placeholder: 'No limit', style: { maxWidth: '140px' } });
    const saveLimit = () => save({ creditLimit: inputToCredits(limitInput.value) || 0 }).then(load);
    limitInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveLimit();
    });
    content.append(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '6px' } }, h('strong', { class: 'grow' }, 'Monthly spending limit'), limitInput, h('span', { class: 'muted' }, limitUnit()), h('button', { class: 'btn small primary', onClick: saveLimit }, 'Save')),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `Spent this month: ${formatCost(details.spentThisMonth, state.settings?.costUnit)}${limit ? ` of ${formatCredits(limit, state.settings?.costUnit)}` : ''}. ${limit ? 'From 80% sessions show a notice. At the limit the agent stops until you raise it.' : 'Set a limit to get a notice at 80% and stop the agent at the limit.'} Requests Copilot reports no cost for are not counted.`),
        limit ? h('div', { class: `meter${share >= 1 ? ' over' : share >= 0.8 ? ' warn' : ''}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': spentCredits.toFixed(2), 'aria-label': 'Spent this month' }, h('div', { style: { width: `${(share * 100).toFixed(1)}%` } })) : null,
      ),
    );

    content.append(schedulesCard());

    const instructions = h('textarea', { class: 'textarea', rows: 7, placeholder: 'For example: This is the billing service. Use Python 3.12 and pytest. Never change the database schema without asking.' });
    instructions.value = details.project.instructions;
    content.append(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '6px' } }, h('strong', { class: 'grow' }, 'Project instructions'), h('button', { class: 'btn small primary', onClick: () => save({ instructions: instructions.value }) }, 'Save')),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } }, 'Added to every new session in this folder. Kept in Caliope, not in the repository. For instructions the whole team shares, use an AGENTS.md in the repository.'),
        instructions,
      ),
    );

    // Project memory: notes every new session starts with (the agent adds them with remember, you with /remember).
    const memory = h('textarea', { class: 'textarea mono', rows: 6, placeholder: '- Run tests with: pytest -q\n- Never touch the prod catalog' });
    memory.value = details.project.memory;
    content.append(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '6px' } }, h('strong', { class: 'grow' }, 'Project memory'), h('span', { class: 'faint', style: { fontSize: '12px' } }, `${details.project.memory.length} / 6000`), h('button', { class: 'btn small primary', onClick: () => save({ memory: memory.value }) }, 'Save')),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } }, 'Short notes every new session in this project starts with: commands that work, conventions, corrections. The agent adds notes with its remember tool. You can add one with /remember or edit them here. The notes are part of the cached system prompt, so they cost very little.'),
        memory,
      ),
    );

    // Trust: whether new sessions load the repository's own instruction files, commands, skills and MCP servers.
    const steeringFiles = details.projectFiles || [];
    const trusted = details.project.trusted === true;
    content.append(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Files from the repository'), h('span', { class: `chip${trusted ? ' on' : ''}` }, trusted ? 'trusted' : 'not trusted'), h('button', { class: 'btn small', onClick: () => save({ trusted: !trusted }).then(load) }, trusted ? 'Stop trusting' : 'Trust')),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, steeringFiles.length ? `This folder has files that steer the agent: ${steeringFiles.join(', ')}. ${trusted ? 'New sessions load them.' : 'New sessions ignore them.'}` : 'This folder has no instruction files, commands, skills or MCP servers of its own.'),
      ),
    );

    // Hooks: commands Caliope runs after the agent edits a file in this project (server/hooks.js).
    const hooks = details.project.hooks;
    const matchInput = h('input', { class: 'input mono', placeholder: '*.py', style: { maxWidth: '120px' } });
    const hookCommand = h('input', { class: 'input mono', placeholder: 'ruff format {file}' });
    const addHook = () => {
      if (!hookCommand.value.trim()) return;
      save({ hooks: [...hooks, { match: matchInput.value, command: hookCommand.value, timeoutSec: 60 }] }).then(render);
    };
    content.append(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, 'Hooks'),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 8px' } }, 'Commands that run after the agent changes a file matching the pattern, such as a formatter or linter. {file} is the changed file. The agent sees the output right away. Hooks are kept in Caliope, not in the repository.'),
        hooks.length
          ? h(
              'table',
              { class: 'data-table' },
              h(
                'tbody',
                {},
                hooks.map((hook, index) =>
                  h(
                    'tr',
                    {},
                    h('td', { style: { whiteSpace: 'nowrap' } }, `After editing ${hook.match || 'any file'}`),
                    h('td', { class: 'mono' }, hook.command),
                    h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn ghost small icon-only', title: 'Remove this hook', 'aria-label': 'Remove this hook', html: icon('x', 11), onClick: () => save({ hooks: hooks.filter((_, other) => other !== index) }).then(render) })),
                  ),
                ),
              ),
            )
          : h('div', { class: 'faint' }, 'None yet.'),
        h('div', { class: 'row', style: { marginTop: '10px' } }, matchInput, h('div', { class: 'grow' }, hookCommand), h('button', { class: 'btn small primary', onClick: addHook }, 'Add hook')),
      ),
    );

    // The agent's browser keeps its own logins per project.
    content.append(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row' },
          h('strong', { class: 'grow' }, "Agent's browser"),
          h('button', { class: 'btn small', onClick: () => api.post('/api/project/browser/open', { folder }).catch(toastError) }, 'Open'),
          h('button', { class: 'btn small', onClick: () => api.post('/api/project/browser/clear', { folder }).then(() => toast('Browser data cleared.')).catch(toastError) }, 'Clear browser data'),
        ),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, "The agent's browser has its own profile for this project, so its logins stay out of your own browser and other projects. Open it to sign in to a site yourself."),
      ),
    );

    const rules = details.project.allowedCommands;
    content.append(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, 'Commands that never ask in this project'),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 8px' } }, 'Added with "Allow in project" when you approve a command. A command runs without asking only when every part of it starts with one of these.'),
        rules.length
          ? h(
              'div',
              { class: 'row', style: { flexWrap: 'wrap' } },
              rules.map((rule) =>
                h('span', { class: 'chip mono' }, rule, h('button', { class: 'btn ghost small icon-only', title: `Remove "${rule}"`, 'aria-label': `Remove ${rule}`, html: icon('x', 11), onClick: () => save({ allowedCommands: rules.filter((other) => other !== rule) }).then(render) })),
              ),
            )
          : h('div', { class: 'faint' }, 'None yet.'),
      ),
    );

    const sites = details.project.allowedSites;
    content.append(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, 'Sites the agent\'s browser acts on without asking'),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 8px' } }, 'Added with "Allow site in project" when you approve a click or typing on a site. In Auto, the safety check decides about other sites.'),
        sites.length
          ? h(
              'div',
              { class: 'row', style: { flexWrap: 'wrap' } },
              sites.map((site) =>
                h('span', { class: 'chip mono' }, site, h('button', { class: 'btn ghost small icon-only', title: `Remove "${site}"`, 'aria-label': `Remove ${site}`, html: icon('x', 11), onClick: () => save({ allowedSites: sites.filter((other) => other !== site) }).then(render) })),
              ),
            )
          : h('div', { class: 'faint' }, 'None yet.'),
      ),
    );

    const files = details.instructionFiles;
    content.append(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, 'Instruction files in the repository'),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 8px' } }, `Read automatically from ${details.root}.`),
        files.length ? h('div', { class: 'row', style: { flexWrap: 'wrap' } }, files.map((file) => h('span', { class: 'chip mono' }, file))) : h('div', { class: 'faint' }, 'None yet.'),
        h(
          'button',
          {
            class: 'btn small',
            style: { marginTop: '10px' },
            onClick: async () => {
              try {
                await actions.createSession({ cwd: folder, mode: 'edits' });
                await actions.runCommand('init');
              } catch (error) {
                toastError(error);
              }
            },
          },
          h('span', { html: icon('sparkles', 13) }),
          files.includes('AGENTS.md') ? 'Improve AGENTS.md with the agent' : 'Write AGENTS.md with the agent',
        ),
      ),
    );

    content.append(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, `Skills available here (${details.skills.length})`),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 8px' } }, 'From the project (.github/skills, .claude/skills), Caliope\'s skills folder, and your ~/.claude/skills. The agent loads one when a task matches. You can also type /skill-name.'),
        details.skills.length
          ? h('table', { class: 'data-table' }, h('tbody', {}, details.skills.map((skill) => h('tr', {}, h('td', { class: 'mono', style: { whiteSpace: 'nowrap' } }, `/${skill.name}`), h('td', { class: 'muted' }, skill.description), h('td', { class: 'faint' }, skill.source)))))
          : h('div', { class: 'faint' }, 'No skills found.'),
      ),
    );

    content.append(h('h2', {}, 'Sessions'));
    if (sessions.length === 0) content.append(h('div', { class: 'faint' }, 'No sessions in this project yet.'));
    else {
      content.append(
        h(
          'div',
          { class: 'card', style: { padding: '4px 8px' } },
          h(
            'table',
            { class: 'data-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Session'), h('th', {}, 'Last activity'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Spent'))),
            h(
              'tbody',
              {},
              sessions.map((meta) =>
                h(
                  'tr',
                  { class: 'clickable', onClick: () => actions.openSession(meta.id) },
                  h('td', {}, meta.title, meta.archived ? h('span', { class: 'faint' }, ' (archived)') : null),
                  h('td', { class: 'faint' }, relativeTime(meta.updatedAt)),
                  h('td', { class: 'num' }, String(meta.usage?.requests || 0)),
                  h('td', { class: 'num' }, formatCost(meta.usage?.nanoAiu || 0, unit)),
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  // Scheduled tasks: a prompt that starts a new session here at set times (server/schedules.js).
  let editing = null;
  function schedulesCard() {
    const schedules = details.project.schedules;
    const card = h('div', { class: 'card' });
    card.append(
      h('div', { class: 'row', style: { marginBottom: '4px' } }, h('strong', { class: 'grow' }, 'Scheduled tasks'), editing ? null : h('button', { class: 'btn small', onClick: () => { editing = { every: 'weekdays', at: '09:00', day: 1, mode: 'ask', maxCredits: 50, enabled: true }; render(); } }, h('span', { html: icon('plus', 13) }), 'Add task')),
      h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } }, 'A task starts a new session with its prompt at the times you set, while Caliope is open. A time missed while Caliope was closed runs once when it opens again. Approvals wait for you, so pick the permission mode the task needs.'),
    );
    if (schedules.length === 0 && !editing) card.append(h('div', { class: 'faint' }, 'None yet. For example: every weekday at 09:00, "Check the failed pipeline runs and summarize why they failed".'));
    for (const schedule of schedules) {
      const enabled = h('input', { type: 'checkbox', checked: schedule.enabled, 'aria-label': `Run "${schedule.name}" at its times` });
      enabled.addEventListener('change', () => saveSchedules(schedules.map((item) => (item.id === schedule.id ? { ...item, enabled: enabled.checked } : item))));
      // A reminder or loop the agent set links to its session. Other tasks to their last run.
      const linked = schedule.sessionId || schedule.lastSessionId;
      const linkText = schedule.sessionId ? `in "${state.sessions.get(schedule.sessionId)?.title || 'a session'}"` : `last run ${relativeTime(schedule.lastRunAt)}`;
      const lastRun = linked && state.sessions.has(linked) ? h('a', { href: '#', onClick: (event) => { event.preventDefault(); actions.openSession(linked); } }, linkText) : null;
      card.append(
        h(
          'div',
          { class: 'row', style: { padding: '8px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' } },
          h('label', { class: 'switch', title: 'Run at its times' }, enabled, h('span')),
          h('div', { class: 'grow', style: { minWidth: '200px' } }, h('div', {}, schedule.name), h('div', { class: 'faint', style: { fontSize: '12px' } }, [describeSchedule(schedule), MODE_LABELS[schedule.mode], schedule.enabled && schedule.nextRunAt ? `next ${new Date(schedule.nextRunAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : null].filter(Boolean).join(' · '), lastRun ? ' · ' : '', lastRun)),
          h('button', { class: 'btn small', onClick: () => api.post('/api/project/schedules/run', { folder, id: schedule.id }).then((result) => actions.openSession(result.sessionId)).catch(toastError) }, 'Run now'),
          // Reminders and loops come from the agent. The form edits the repeating tasks.
          ['once', 'minutes'].includes(schedule.every) ? null : h('button', { class: 'btn small', onClick: () => { editing = { ...schedule }; render(); } }, 'Edit'),
          h('button', { class: 'btn ghost small icon-only', title: 'Delete this task', 'aria-label': `Delete ${schedule.name}`, html: icon('trash-2', 13), onClick: () => saveSchedules(schedules.filter((item) => item.id !== schedule.id)) }),
        ),
      );
    }
    if (editing) card.append(scheduleForm(schedules));
    return card;
  }

  function scheduleForm(schedules) {
    const draft = editing;
    const name = h('input', { class: 'input', placeholder: 'Pipeline check', value: draft.name || '' });
    const prompt = h('textarea', { class: 'textarea', rows: 4, placeholder: 'What the agent should do each time' });
    prompt.value = draft.prompt || '';
    // The selects size to their text, so the timing fits on one line.
    const inline = { width: 'auto' };
    const every = h('select', { class: 'select', style: inline, 'aria-label': 'How often' }, [['hourly', 'Every hour'], ['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week']].map(([value, label]) => h('option', { value, selected: value === draft.every }, label)));
    const at = h('input', { class: 'input', type: 'time', value: draft.at, style: { width: '120px' }, 'aria-label': 'Time' });
    const day = h('select', { class: 'select', style: inline, 'aria-label': 'Day' }, DAYS.map((label, index) => h('option', { value: String(index), selected: index === (draft.day ?? 1) }, `on ${label}`)));
    const showDay = () => {
      day.hidden = every.value !== 'weekly';
    };
    every.addEventListener('change', showDay);
    showDay();
    const mode = h('select', { class: 'select', style: inline, 'aria-label': 'Permission mode' }, Object.entries(MODE_LABELS).map(([value, label]) => h('option', { value, selected: value === draft.mode }, label)));
    const usable = state.models.filter((model) => model.protocol && model.toolCalls && model.policyState !== 'disabled');
    const model = h('select', { class: 'select', style: inline, 'aria-label': 'Model' }, h('option', { value: '' }, 'Default model'), usable.map((item) => h('option', { value: item.id, selected: item.id === draft.model }, item.name)));
    const maxCredits = h('input', { class: 'input', type: 'number', min: inDollars() ? '0.01' : '1', step: inDollars() ? '0.1' : '10', value: String(creditsToInput(draft.maxCredits ?? 50)), style: { width: '100px' }, 'aria-label': `Limit per run in ${limitUnit()}` });
    const worktree = h('input', { type: 'checkbox', checked: Boolean(draft.worktree) });
    const submit = () => {
      const schedule = { ...draft, name: name.value, prompt: prompt.value, every: every.value, at: at.value, day: Number(day.value), mode: mode.value, model: model.value || null, maxCredits: inputToCredits(maxCredits.value), worktree: worktree.checked };
      const list = draft.id ? schedules.map((item) => (item.id === draft.id ? schedule : item)) : [...schedules, schedule];
      saveSchedules(list, { closeForm: true });
    };
    return h(
      'div',
      { class: 'stack', style: { borderTop: '1px solid var(--border)', paddingTop: '10px', gap: '8px' } },
      name,
      prompt,
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, every, day, h('span', { class: 'muted' }, 'at'), at, mode, model),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('span', { class: 'muted' }, 'Stop a run at'), maxCredits, h('span', { class: 'muted' }, limitUnit()), details.branch ? h('label', { class: 'row', style: { gap: '6px' } }, worktree, 'In its own git worktree') : null),
      h('div', { class: 'row' }, h('button', { class: 'btn small primary', onClick: submit }, draft.id ? 'Save task' : 'Add task'), h('button', { class: 'btn small', onClick: () => { editing = null; render(); } }, 'Cancel')),
    );
  }

  async function saveSchedules(schedules, { closeForm = false } = {}) {
    try {
      const result = await api.put('/api/project', { folder, schedules });
      details.project = result.project;
      if (closeForm) editing = null;
      render();
      toast('Scheduled tasks saved.');
    } catch (error) {
      toastError(error);
    }
  }

  async function save(patch) {
    try {
      const result = await api.put('/api/project', { folder, ...patch });
      details.project = result.project;
      toast('Project saved.');
    } catch (error) {
      toastError(error);
    }
  }

  subscriptions.push(on('sessions', render), on('settings', render), on('projects', load));
  load();

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      container.firstChild?.remove();
    },
  };
}
