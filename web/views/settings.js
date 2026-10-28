// Settings page.
import { h, clear, formatTokens, relativeTime } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { toast, toastError } from './dialogs.js';

const SECTIONS = [
  ['account', 'Account'],
  ['models', 'Models'],
  ['permissions', 'Permissions'],
  ['commands', 'Commands'],
  ['instructions', 'Instructions'],
  ['skills', 'Skills'],
  ['mcp', 'MCP servers'],
  ['budget', 'Costs'],
  ['network', 'Network'],
  ['appearance', 'Appearance'],
  ['app', 'App'],
];

export function mountSettings(container) {
  const subscriptions = [];
  let section = 'account';
  const nav = h('nav', { class: 'settings-nav' });
  const content = h('div');
  const page = h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('h1', {}, 'Settings'), h('p', { class: 'lead' }, 'Saved for your Windows account on this PC. New sessions pick up instruction and tool changes. Running sessions keep what they started with.'), h('div', { class: 'settings-layout' }, nav, content)));
  container.append(h('div', { class: 'view' }, page));

  function render() {
    clear(nav);
    for (const [id, label] of SECTIONS) nav.append(h('button', { class: section === id ? 'active' : '', onClick: () => { section = id; render(); } }, label));
    clear(content);
    const settings = state.settings;
    if (!settings) return;
    const builders = { account, models, permissions, commands, instructions, skills, mcp: mcpServers, budget, network, appearance, app };
    content.append(builders[section](settings));
  }

  function field(label, help, control) {
    return h('div', { class: 'field' }, h('div', {}, h('div', { class: 'field-label' }, label), help ? h('div', { class: 'field-help' }, help) : null), h('div', {}, control));
  }

  function select(value, options, onChange) {
    const element = h('select', { class: 'select' }, options.map(([optionValue, label]) => h('option', { value: optionValue ?? '' }, label)));
    element.value = value ?? '';
    element.addEventListener('change', () => onChange(element.value));
    return element;
  }

  function toggle(value, onChange) {
    const input = h('input', { type: 'checkbox', checked: value });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch' }, input, h('span'));
  }

  function numberInput(value, min, max, onChange) {
    const input = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), value: String(value), style: { width: '140px' } });
    input.addEventListener('change', () => {
      const number = Number(input.value);
      if (Number.isInteger(number) && number >= min && number <= max) onChange(number);
      else {
        toast(`Enter a whole number from ${min} to ${max}.`, { kind: 'error' });
        input.value = String(value);
      }
    });
    return input;
  }

  function textList(value, placeholder, onSave, rows = 4) {
    const area = h('textarea', { class: 'textarea mono', rows, placeholder, style: { fontSize: '12.5px' } });
    area.value = (value || []).join('\n');
    area.addEventListener('change', () => onSave(area.value.split('\n').map((line) => line.trim()).filter(Boolean)));
    return area;
  }

  const save = (patch) => actions.saveSettings(patch).then((ok) => ok && toast('Saved.'));

  function account() {
    const auth = state.auth || {};
    const wrapper = h('div', { class: 'card' });
    if (auth.signedIn) {
      wrapper.append(
        field('Signed in', auth.kind === 'oauth' ? 'GitHub sign-in (Caliope app).' : auth.kind === 'device' ? 'GitHub sign-in (Copilot editor-plugin identity).' : 'Personal access token (Copilot CLI identity).', h('div', { class: 'stack' }, h('strong', {}, auth.login || 'Unknown account'), h('span', { class: 'faint' }, auth.savedAt ? `Since ${new Date(auth.savedAt).toLocaleString()}` : ''), auth.saveFailed ? h('span', { class: 'danger-text' }, 'Not saved: PowerShell is restricted on this PC, so Windows could not encrypt the sign-in. Sign in again after Caliope restarts.') : null)),
        field('Switch or remove', 'Signing out deletes the saved token from this PC. Sessions stay.', h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => actions.showView('signin') }, 'Use another token'), h('button', { class: 'btn danger', onClick: actions.signOut }, h('span', { html: icon('log-out', 14) }), 'Sign out'))),
      );
    } else {
      wrapper.append(field('Not signed in', auth.error || 'Connect your own GitHub Copilot subscription.', h('button', { class: 'btn primary', onClick: () => actions.showView('signin') }, 'Sign in')));
    }
    return wrapper;
  }

  function models(settings) {
    const usable = state.models.filter((model) => model.protocol && model.toolCalls);
    const options = [[null, 'Automatic'], ...usable.map((model) => [model.id, model.name])];
    const effortOptions = state.boot.efforts.map((effort) => [effort, effort]);
    const defaults = state.modelDefaults || {};
    const name = (id) => state.models.find((model) => model.id === id)?.name || id || 'none available';
    const wrapper = h('div', { class: 'stack' });
    wrapper.append(
      h(
        'div',
        { class: 'card' },
        field('Default model', `New sessions start with it. Switch a session's model in the bar under the message box. Automatic picks the newest Claude Opus. Now: ${name(defaults.build)}.`, select(settings.buildModel, options, (value) => save({ buildModel: value || null }))),
        field('Default effort', 'Medium is a good default for coding. Low is faster and cheaper for routine changes.', select(settings.buildEffort, effortOptions, (value) => save({ buildEffort: value }))),
        field('Planning model', `Used in Plan mode and for /review. Automatic picks the newest Claude Opus. Now: ${name(defaults.plan)}.`, select(settings.planModel, options, (value) => save({ planModel: value || null }))),
        field('Planning effort', 'How long the planning model thinks. Higher is more thorough and costs more.', select(settings.planEffort, effortOptions, (value) => save({ planEffort: value }))),
        field('Title model', `Writes the short session titles. Automatic picks a model Copilot includes at no cost. Now: ${name(defaults.title) || 'the session model'}.`, select(settings.titleModel, options, (value) => save({ titleModel: value || null }))),
      ),
      h(
        'div',
        { class: 'card' },
        field('Subagents', 'Lets the agent in new sessions hand tasks to other models (Claude, GPT, Gemini… whatever your Copilot plan offers): searches, investigations, reviews, several at once. Their costs count towards the session, and their edits and commands need the same approvals.', toggle(settings.subagents, (value) => save({ subagents: value }))),
        field('Default subagent model', 'Used when the agent does not name a model. "Same as the session" uses the session\'s current model. A smaller model such as Sonnet or Haiku is cheaper for searches.', select(settings.subagentModel, [[null, 'Same as the session'], ...usable.map((model) => [model.id, model.name])], (value) => save({ subagentModel: value || null }))),
        field('Subagent effort', 'Default reasoning effort for subagents, for models that support it.', select(settings.subagentEffort, effortOptions, (value) => save({ subagentEffort: value }))),
      ),
    );
    const list = h('div', { class: 'card' });
    list.append(
      h(
        'div',
        { class: 'row', style: { marginBottom: '6px' } },
        h('strong', { class: 'grow' }, `Models on your Copilot plan (${state.models.length})`),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, state.modelsFetchedAt ? `updated ${relativeTime(state.modelsFetchedAt)}` : ''),
        h('button', { class: 'btn small', onClick: actions.refreshModels }, h('span', { html: icon('refresh-cw', 13) }), 'Refresh'),
      ),
    );
    if (state.modelsError) list.append(h('div', { class: 'callout error' }, state.modelsError));
    for (const model of state.models) {
      let status;
      if (!model.protocol) status = h('span', { class: 'faint' }, 'endpoint not supported here');
      else if (model.policyState === 'disabled') status = h('span', { class: 'warning-text' }, 'disabled by policy');
      else if (model.policyState === 'unconfigured') {
        status = h('button', {
          class: 'btn small',
          title: 'Accept this model\'s terms for your account, as GitHub\'s editor plugins do',
          onClick: async () => {
            try {
              const result = await api.post(`/api/models/${encodeURIComponent(model.id)}/enable`);
              actions.applyModels(result);
              toast(`${model.name} enabled.`);
            } catch (error) {
              toastError(error);
            }
          },
        }, 'Enable');
      } else status = h('span', { class: 'success-text' }, 'available');
      list.append(
        h(
          'div',
          { class: 'model-row' },
          h('div', { class: 'grow' }, h('div', {}, model.name, model.preview ? h('span', { class: 'faint' }, ' (preview)') : null), h('div', { class: 'faint mono', style: { fontSize: '11.5px' } }, `${model.id} · ${model.vendor || ''}${model.maxPromptTokens ? ` · ${formatTokens(model.maxPromptTokens)} context` : ''}${model.efforts.length ? ` · effort ${model.efforts.join('/')}` : ''}`)),
          status,
        ),
      );
    }
    if (state.models.length === 0) list.append(h('div', { class: 'faint' }, state.auth?.signedIn ? 'No models loaded yet. Click Refresh.' : 'Sign in to load your models.'));
    wrapper.append(list);
    return wrapper;
  }

  function permissions(settings) {
    return h(
      'div',
      { class: 'card' },
      field(
        'Default mode for new sessions',
        'Ask permissions is the safest. Auto lets a small model decide which commands need you (file edits in the project apply). Plan starts every session with the planning model.',
        select(settings.defaultMode, [['auto', 'Auto'], ['ask', 'Ask permissions'], ['edits', 'Accept edits'], ['plan', 'Plan'], ['full', 'Full access']], (value) => save({ defaultMode: value })),
      ),
      field('Browser tool', 'Gives new sessions a browser window the agent can control (open pages, read, click, type, screenshots). Each project has its own browser profile, separate from yours. Reading the open page never asks. Before opening a page on a new site, or clicking or typing there, the agent asks once. In Auto the safety check decides instead.', toggle(settings.browserTools, (value) => save({ browserTools: value }))),
      field('Commands that never ask', 'One command prefix per line, for example "git status" or "npm test". A command runs without asking only when every part of it (split at ; | && ||) starts with one of these, and it uses no redirection or subexpressions.', textList(settings.allowedCommands, 'git status\ngit diff\nnpm test', (value) => save({ allowedCommands: value }))),
      field('Protected files', 'One pattern per line. The agent\'s file tools cannot read or change matching files, and searches skip them. A pattern without a slash matches the file name in any folder (".env", "*.pem"). One with a slash matches the path in the project ("config/prod/*.json"), and one starting with ~/ the path in your home folder ("~/.aws/credentials").', textList(settings.protectedFiles, '.env\n*.pem', (value) => save({ protectedFiles: value }))),
    );
  }

  function commands(settings) {
    const detected = state.boot.extraPathDetected || [];
    return h(
      'div',
      { class: 'card' },
      field('Shell', 'Used by run_command. The model is told which shell it is using.', select(settings.shell, [['powershell', 'Windows PowerShell 5.1'], ['cmd', 'Command Prompt (cmd.exe)']], (value) => save({ shell: value }))),
      field('Extra PATH folders', `Added in front of PATH for agent commands, so tools that are not on PATH (like a portable git or python) work. Leave empty to detect them automatically${detected.length ? `; detected now:\n${detected.join('\n')}` : ''}.`, textList(settings.extraPath, detected.join('\n') || 'C:\\tools\\bin', (value) => save({ extraPath: value.length ? value : null }), 4)),
      field('Command time limit', 'Seconds before a command is stopped. The model can ask for up to 600 seconds per command.', numberInput(settings.commandTimeoutSec, 5, 600, (value) => save({ commandTimeoutSec: value }))),
    );
  }

  function instructions(settings) {
    const area = h('textarea', { class: 'textarea', rows: 8, placeholder: 'For example: Use Dutch for comments. Prefer small functions. Never commit without asking.' });
    area.value = settings.globalInstructions;
    area.addEventListener('change', () => save({ globalInstructions: area.value }));
    const wrapper = h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        field('Instructions for every session', 'Added to the system prompt of new sessions. Your ~/.claude/CLAUDE.md is read automatically, and so are the project files AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md and .github/copilot-instructions.md, from the project folder up to the git root. Per-project instructions are on each project page.', area),
        field('Instruction files', 'Other files added to every new session, one path per line. ~ means your home folder, for example ~/.codex/AGENTS.md.', textList(settings.instructionFiles, '~/.codex/AGENTS.md', (value) => save({ instructionFiles: value }), 3)),
      ),
    );
    return wrapper;
  }

  function skills(settings) {
    const list = h('div', { class: 'faint' }, 'Loading…');
    const wrapper = h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        field(
          'Use your Claude skills',
          'Also offer the skills in ~/.claude/skills (the same SKILL.md format). Project skills (.github/skills, .claude/skills, .agents/skills) and Caliope\'s own skills folder are always used.',
          toggle(settings.useClaudeSkills, (value) => save({ useClaudeSkills: value })),
        ),
        field(
          'Caliope skills folder',
          'Put a folder with a SKILL.md in it here (front matter with name and description, then instructions). New sessions pick it up.',
          h('button', { class: 'btn small', onClick: () => api.get('/api/skills').then((result) => actions.openPath(result.skillsFolder, false)).catch(toastError) }, h('span', { html: icon('folder-open', 13) }), 'Open skills folder'),
        ),
      ),
      h('div', { class: 'card' }, h('div', { class: 'field-label', style: { marginBottom: '8px' } }, 'Skills found (outside projects)'), list),
    );
    api
      .get('/api/skills')
      .then((result) => {
        clear(list);
        list.className = '';
        if (result.skills.length === 0) list.append(h('div', { class: 'faint' }, 'No skills yet.'));
        else list.append(h('table', { class: 'data-table' }, h('tbody', {}, result.skills.map((skill) => h('tr', {}, h('td', { class: 'mono', style: { whiteSpace: 'nowrap' } }, `/${skill.name}`), h('td', { class: 'muted' }, skill.description), h('td', { class: 'faint' }, skill.source))))));
      })
      .catch((error) => {
        list.textContent = error.message;
      });
    return wrapper;
  }

  /**
   * MCP servers for every project: a program Caliope starts (npx, node, python…) or an HTTP address.
   * "Check" starts the server and lists its tools.
   */
  function mcpServers(settings) {
    const servers = settings.mcpServers || {};
    const saveServers = (next) => actions.saveSettings({ mcpServers: next }).then((ok) => ok && toast('Saved. New sessions get these tools.'));
    const words = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
    const pairs = (text, separator) => Object.fromEntries(text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => [line.slice(0, line.indexOf(separator)).trim(), line.slice(line.indexOf(separator) + 1).trim()]).filter(([key]) => key));
    const checkResult = h('div', { class: 'faint', style: { fontSize: '12.5px' } });

    async function check(name) {
      checkResult.textContent = `Starting ${name}…`;
      try {
        const result = await api.post('/api/mcp/check', { name });
        clear(checkResult);
        checkResult.append(
          result.errors.length ? h('div', { class: 'danger-text' }, result.errors.join('\n')) : h('div', {}, `${name}: ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} (${result.tools.filter((tool) => tool.readOnly).length} read-only, which run without asking).`),
          result.tools.length ? h('div', { class: 'mono', style: { marginTop: '4px' } }, result.tools.map((tool) => tool.tool).join(', ')) : null,
        );
      } catch (error) {
        checkResult.textContent = error.message;
      }
    }

    const rows = Object.entries(servers).map(([name, server]) =>
      h(
        'tr',
        {},
        h('td', { class: 'mono' }, name),
        h('td', { class: 'mono muted', style: { wordBreak: 'break-all' } }, server.url || [server.command, ...server.args].join(' ')),
        h(
          'td',
          { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
          h('button', { class: 'btn small', onClick: () => check(name) }, 'Check'),
          h('button', { class: 'btn ghost small icon-only', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, html: icon('trash-2', 13), onClick: () => saveServers(Object.fromEntries(Object.entries(servers).filter(([other]) => other !== name))) }),
        ),
      ),
    );

    const nameInput = h('input', { class: 'input', placeholder: 'ado', style: { maxWidth: '160px' } });
    const commandInput = h('input', { class: 'input mono', placeholder: 'npx -y @azure-devops/mcp your-organization   or   https://example.com/mcp' });
    const extraInput = h('textarea', { class: 'textarea mono', rows: 3, placeholder: 'Program: environment variables, NAME=value per line\nHTTP: headers, Name: value per line (${env:TOKEN} reads a variable)', style: { fontSize: '12.5px' } });
    const orgInput = h('input', { class: 'input', placeholder: 'Organization, for example contoso', style: { maxWidth: '260px' } });
    function add() {
      const name = nameInput.value.trim();
      const line = commandInput.value.trim();
      if (!name || !line) {
        toast('Enter a name and a command or address.', { kind: 'error' });
        return;
      }
      const isUrl = /^https?:\/\//i.test(line);
      const [command, ...args] = words(line);
      const server = isUrl ? { url: line, headers: pairs(extraInput.value, ':') } : { command, args, env: pairs(extraInput.value, '=') };
      saveServers({ ...servers, [name]: server });
    }
    function azureDevOps() {
      const organization = orgInput.value.trim();
      if (!organization) {
        toast('Enter your Azure DevOps organization first.', { kind: 'error' });
        return;
      }
      // The core, work items, repositories, pipelines and wiki tools. Every domain adds many tool definitions.
      saveServers({ ...servers, ado: { command: 'npx', args: ['-y', '@azure-devops/mcp', organization, '-d', 'core', 'work', 'work-items', 'repositories', 'pipelines', 'wiki'], env: {} } });
    }

    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'field-label' }, 'MCP servers'),
        h('div', { class: 'field-help', style: { marginBottom: '10px' } }, 'Tools from other programs (Model Context Protocol), in every project. A project can add its own in .mcp.json. Caliope uses those only after you trust the folder. Tools that a server marks read-only run without asking. Others ask first (in Auto, the safety check decides), and never run in plan mode. New sessions get the tools. Each tool definition adds to every request, so keep servers to what you use.'),
        rows.length ? h('table', { class: 'data-table' }, h('tbody', {}, rows)) : h('div', { class: 'faint' }, 'None yet.'),
        checkResult,
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'field-label' }, 'Azure DevOps'),
        h('div', { class: 'field-help', style: { marginBottom: '10px' } }, 'Microsoft\'s local Azure DevOps server: work items, repositories, pull requests, pipelines and wiki. It runs with the Node.js and npx included in Caliope. The first start downloads it from npm and opens a Microsoft sign-in in your browser. (Microsoft\'s hosted server at mcp.dev.azure.com only accepts Visual Studio and VS Code for now.)'),
        h('div', { class: 'row' }, orgInput, h('button', { class: 'btn primary small', onClick: azureDevOps }, 'Add Azure DevOps')),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'field-label' }, 'Add a server'),
        h('div', { class: 'stack', style: { marginTop: '8px' } }, h('div', { class: 'row' }, nameInput, h('div', { class: 'grow' }, commandInput)), extraInput, h('div', {}, h('button', { class: 'btn primary small', onClick: add }, 'Add'))),
      ),
    );
  }

  function budget(settings) {
    return h(
      'div',
      { class: 'card' },
      field('Show costs in', '1 AI credit = US$0.01 under GitHub Copilot usage-based billing. To cap spending, set a budget for Copilot on github.com.', select(settings.costUnit, [['credits', 'AI credits'], ['usd', 'US dollars']], (value) => save({ costUnit: value }))),
      field('Thinking shown', 'Summarized shows a summary of the model\'s reasoning. Hidden saves screen space. Billing is the same.', select(settings.thinkingDisplay, [['summarized', 'Summarized'], ['omitted', 'Hidden']], (value) => save({ thinkingDisplay: value }))),
      field('Compact the conversation at', 'Percent of the model\'s context window. Claude and GPT then summarize the earlier messages themselves. For other models Caliope writes the summary. Each compaction restarts the prompt cache, but a larger conversation makes every request dearer.', h('div', { class: 'row' }, numberInput(settings.autoCompactPercent, 50, 95, (value) => save({ autoCompactPercent: value })), h('span', { class: 'muted' }, '%'))),
      field(
        'Summaries written by',
        'Claude and GPT always summarize themselves while they work, which is the cheapest. This applies to other models and to /compact. The session\'s own model rereads the conversation from the prompt cache. Another model reads it all at the full price.',
        h(
          'div',
          { class: 'row' },
          select(settings.compactModel, [[null, 'The session\'s model'], ...state.models.filter((model) => model.protocol && model.policyState !== 'disabled').map((model) => [model.id, model.name])], (value) => save({ compactModel: value || null })),
          settings.compactModel ? select(settings.compactEffort, [[null, 'Session effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (value) => save({ compactEffort: value || null })) : null,
        ),
      ),
      field('Maximum output tokens', 'Per response, including thinking. Lower it only if responses are cut off for a reason.', numberInput(settings.maxOutputTokens, 1024, 128000, (value) => save({ maxOutputTokens: value }))),
    );
  }

  function network(settings) {
    const proxyInput = h('input', { class: 'input mono', placeholder: 'http://proxy.company.com:8080', value: settings.proxy });
    proxyInput.addEventListener('change', () => save({ proxy: proxyInput.value.trim() }).then(showProxy));
    const bypassInput = h('input', { class: 'input mono', placeholder: '.company.local, intranet', value: settings.noProxy });
    bypassInput.addEventListener('change', () => save({ noProxy: bypassInput.value.trim() }).then(showProxy));
    const status = h('div', { class: 'field-help' }, 'Checking…');
    // What is in use now, and what Windows itself uses, read when the section opens.
    async function showProxy() {
      try {
        const proxy = await api.get('/api/proxy');
        clear(status);
        status.append(proxy.url ? `In use: ${proxy.url}${proxy.source === 'environment' ? ' (from the HTTPS_PROXY environment variable)' : ''}.` : 'In use: no proxy.');
        if (proxy.unsupported) status.append(h('div', { class: 'danger-text' }, 'The Node.js that runs Caliope is too old to send its own requests through a proxy. Use the Caliope download, which includes a newer one.'));
        if (proxy.windows.proxy && proxy.windows.proxy !== proxy.url) {
          status.append(h('div', { class: 'row', style: { marginTop: '6px' } }, `Windows uses ${proxy.windows.proxy}.`, h('button', { class: 'btn small', onClick: () => save({ proxy: proxy.windows.proxy, noProxy: proxy.windows.bypass || '' }).then(showProxy) }, 'Use it')));
        }
        if (proxy.windows.script) status.append(h('div', { style: { marginTop: '6px' } }, `Windows finds its proxy with a script (${proxy.windows.script}), which Caliope can't read. If requests fail, ask IT for the proxy address and enter it above.`));
      } catch (error) {
        status.textContent = error.message;
      }
    }
    showProxy();
    return h(
      'div',
      { class: 'card' },
      field('Proxy', 'Only needed when your company network blocks direct internet access. Caliope, git, MCP servers and the agent\'s commands then go through it. Leave empty to use the HTTPS_PROXY environment variable, if set. Proxies that need your Windows sign-in (NTLM or Kerberos) are not supported.', proxyInput),
      field('Skip the proxy for', 'Hosts that are reached directly, separated by commas. Caliope itself (127.0.0.1) always is.', bypassInput),
      status,
    );
  }

  function appearance(settings) {
    return h(
      'div',
      { class: 'card' },
      field(
        'Browser',
        'Where Caliope\'s window opens (next start), where links you click open, and which browser the agent drives (if your organization blocks remote debugging in it, the agent uses the other one). Windows default opens Caliope as a normal tab.',
        select(settings.browser, [['chrome', 'Google Chrome'], ['edge', 'Microsoft Edge'], ['system', 'Windows default browser']], (value) => save({ browser: value })),
      ),
      field('Theme', null, select(settings.theme, [['system', 'Same as Windows'], ['light', 'Light'], ['dark', 'Dark']], (value) => save({ theme: value }))),
      field(
        'Notifications',
        'A Windows notification when a background session finishes or needs you.',
        toggle(settings.notifications, async (value) => {
          if (value) await actions.requestNotificationPermission();
          save({ notifications: value });
        }),
      ),
    );
  }

  function app(settings) {
    const apiBase = h('input', { class: 'input mono', placeholder: 'https://api.githubcopilot.com', value: settings.apiBase });
    apiBase.addEventListener('change', () => save({ apiBase: apiBase.value.trim() }));
    return h(
      'div',
      { class: 'card' },
      field(
        'Version',
        'Open source under the MIT license, without any warranty. Not affiliated with GitHub, Microsoft, Anthropic, OpenAI or Google. You use Copilot under GitHub\'s terms and your own plan.',
        h(
          'div',
          { class: 'row' },
          h('span', {}, state.boot.version),
          !state.update?.available
            ? h('button', { class: 'btn small', onClick: () => actions.checkForUpdate() }, 'Check for updates')
            : state.update.installed
              ? h('button', { class: 'btn small primary', onClick: () => actions.installUpdate() }, `Update to ${state.update.latest}`)
              : h('a', { class: 'btn small primary', href: state.update.downloadUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Download the new zip and unzip it to a new folder' }, `Get ${state.update.latest}`),
        ),
      ),
      field('Check for updates', 'When Caliope starts and every 6 hours, it looks up the latest version on GitHub: one request without any data about you. Nothing installs until you click Update, unless the next setting is on.', toggle(settings.checkUpdates, (value) => save({ checkUpdates: value }))),
      field('Install updates automatically', 'When Caliope finds a new version, it installs it. The new version runs from the next start. Only for Caliope installed with the install line, not an unzipped copy.', toggle(settings.autoUpdate, (value) => save({ autoUpdate: value }))),
      field('Data folder', 'Sessions, settings, the usage ledger and logs.', h('div', { class: 'stack' }, h('span', { class: 'mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, state.boot.dataDir), h('button', { class: 'btn small', style: { alignSelf: 'flex-start' }, onClick: () => actions.openPath(state.boot.dataDir, false) }, h('span', { html: icon('folder-open', 13) }), 'Open'))),
      field(
        'Desktop shortcut',
        'Creates "Caliope" on your desktop that starts the app.',
        h('button', {
          class: 'btn',
          onClick: async () => {
            try {
              const result = await api.post('/api/shortcut');
              toast(`Shortcut created: ${result.path}`);
            } catch (error) {
              toastError(error);
            }
          },
        }, h('span', { html: icon('monitor', 14) }), 'Create shortcut'),
      ),
      field('Copilot API address', 'Leave empty. Only change it if your company uses a GitHub Enterprise data-residency address.', apiBase),
    );
  }

  subscriptions.push(on('settings', render), on('models', render), on('auth', render), on('update', render));
  render();

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      container.firstChild?.remove();
    },
  };
}
