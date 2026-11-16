// Full-page views: new session and sign-in.
import { h, clear, basename, relativeTime, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on, modelById, loadPreference, savePreference } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { Composer, MODES, showHelp } from './composer.js';
import { openMenu, openModal, openFolderBrowser, promptDialog, toast, toastError, confirmDialog } from './dialogs.js';

// ---------- New session ----------

export function mountNewSession(container) {
  const subscriptions = [];
  let folder = state.newSessionFolder || loadPreference('lastFolder', null) || state.settings?.recentFolders?.[0] || null;
  state.newSessionFolder = null;
  let mode = state.settings?.defaultMode || 'edits';
  // The model and effort picked here for the new session. null: the default for the mode, from Settings.
  let model = null;
  let effort = null;
  let creating = false;
  let useWorktree = false;
  let folderCommands = [];
  let folderSkills = [];

  const folderLabel = h('span', { class: 'ellipsis' });
  const folderButton = h('button', { class: 'chip folder-chip', type: 'button', title: 'Choose the project folder', onClick: (event) => openFolderMenu(event.currentTarget) }, h('span', { html: icon('folder', 14) }), folderLabel, h('span', { html: icon('chevron-down', 12) }));
  const worktreeLabel = h('span');
  const worktreeButton = h(
    'button',
    {
      class: 'chip folder-chip',
      type: 'button',
      hidden: true,
      title: 'Work on a new branch in a separate folder (git worktree), so this session cannot get in the way of your checkout or other sessions.',
      onClick: () => {
        useWorktree = !useWorktree;
        renderWorktree();
      },
    },
    h('span', { html: icon('git-branch', 14) }),
    worktreeLabel,
  );
  const recentElement = h('div', { class: 'recent-list' });

  const setMode = (next) => {
    mode = next;
    composer.refresh();
  };
  const composer = new Composer({
    placeholder: 'What should we work on? (Enter to start)',
    sessionId: () => null,
    mode: () => mode,
    setMode,
    model: () => model || (mode === 'plan' ? state.modelDefaults.plan : state.modelDefaults.build),
    effort: () => effort || (mode === 'plan' ? state.settings?.planEffort : state.settings?.buildEffort),
    setModel: (next) => {
      model = next;
      // Keep the effort only when the new model offers it.
      if (!modelById(next)?.efforts?.includes(effort)) effort = null;
      composer.refresh();
    },
    setEffort: (next) => {
      effort = next;
      composer.refresh();
    },
    running: () => creating,
    queue: () => [],
    commands: () => folderCommands,
    skills: () => folderSkills,
    onSubmit: (text, images) => start(text, images),
    onStop: () => {},
    onSlash: runSlash,
  });

  /** / commands before the session exists: modes, model and effort apply to it; the agent's commands start it. */
  async function runSlash(name, argument) {
    const modes = { plan: 'plan', build: 'edits', ask: 'ask', auto: 'auto', full: 'full' };
    if (modes[name]) {
      setMode(modes[name]);
      // A request that could not start goes back into the box.
      if (name === 'plan' && argument && !(await start(argument, []))) composer.setText(`/plan ${argument}`);
    } else if (name === 'model') composer.openModelMenu();
    else if (name === 'effort') {
      if (modelById(composer.controller.model())?.efforts?.includes(argument)) composer.controller.setEffort(argument);
      else composer.openEffortMenu();
    } else if (['review', 'init', 'commit', 'pr'].includes(name)) {
      if (await startSession()) await actions.runCommand(name);
    } else if (name === 'settings' || name === 'usage') actions.showView(name);
    else if (name === 'help') showHelp();
    else toast('Start the session first, then use that command.');
    return true;
  }

  const page = h(
    'div',
    { class: 'page' },
    h(
      'div',
      { class: 'new-session' },
      h('h1', {}, 'What should we build?'),
      h('div', { class: 'folder-row' }, folderButton, worktreeButton),
      composer.element,
      h('div', { class: 'composer-hint' }, 'Shift+Tab switches mode (Plan uses the planning model) · / for commands'),
      recentElement,
    ),
  );
  container.append(h('div', { class: 'view' }, page));

  function renderFolder() {
    // The folder's name. The full path shows on hover.
    folderLabel.textContent = folder ? basename(folder) : 'Choose a project folder…';
    folderButton.title = folder ? `${folder}\nClick to choose another folder` : 'Choose the project folder';
    folderLabel.classList.toggle('faint', !folder);
    checkRepository();
  }

  function renderWorktree() {
    worktreeLabel.textContent = useWorktree ? 'New worktree' : 'Current checkout';
    worktreeButton.classList.toggle('on', useWorktree);
  }

  /** The worktree choice only appears for folders in a git repository; the folder's custom commands and skills join the / menu. */
  async function checkRepository() {
    const checked = folder;
    let root = null;
    let commands = [];
    // Your own skills show even before a folder is chosen. A trusted folder adds its own.
    const skills = (await api.get(`/api/skills${checked ? `?folder=${encodeURIComponent(checked)}` : ''}`).catch(() => ({ skills: [] }))).skills;
    if (checked) {
      try {
        root = (await api.get(`/api/git?folder=${encodeURIComponent(checked)}`)).root;
        commands = (await api.get(`/api/commands?folder=${encodeURIComponent(checked)}`)).commands;
      } catch {
        // A missing folder is reported when the session starts.
      }
    }
    if (checked !== folder) return;
    folderCommands = commands;
    folderSkills = skills;
    worktreeButton.hidden = !root;
    if (!root) useWorktree = false;
    renderWorktree();
  }

  function renderRecent() {
    clear(recentElement);
    const recent = [...state.sessions.values()].filter((meta) => !meta.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
    if (recent.length === 0) return;
    recentElement.append(h('h2', { style: { fontSize: '14px', margin: '30px 0 8px', color: 'var(--text-muted)' } }, 'Continue where you left off'));
    for (const meta of recent) {
      recentElement.append(
        h(
          'button',
          { class: 'session-item', type: 'button', onClick: () => actions.openSession(meta.id) },
          h('span', { class: 'status', html: icon('message-square', 14) }),
          h('span', { class: 'body' }, h('span', { class: 'title' }, meta.title), h('span', { class: 'sub' }, h('span', { class: 'ellipsis' }, meta.cwd), h('span', {}, '·'), h('span', {}, relativeTime(meta.updatedAt)))),
        ),
      );
    }
  }

  function setFolder(value) {
    folder = value;
    savePreference('lastFolder', value);
    renderFolder();
  }

  async function browse() {
    const picked = await openFolderBrowser({ initial: folder || '' });
    if (picked) setFolder(picked);
  }

  function openFolderMenu(anchor) {
    const recent = state.settings?.recentFolders || [];
    openMenu(anchor, [
      recent.length ? { section: 'Recent folders' } : null,
      ...recent.map((item) => ({ label: item, icon: 'folder', checked: item === folder, onSelect: () => setFolder(item) })),
      recent.length ? 'separator' : null,
      { label: 'Browse…', icon: 'folder-tree', onSelect: browse },
      { label: 'Type a path…', icon: 'pencil', onSelect: typePath },
    ]);
  }

  async function typePath() {
    const value = await promptDialog({ title: 'Project folder', value: folder || '', placeholder: 'C:\\path\\to\\project', confirmLabel: 'Use folder' });
    if (value && value.trim()) setFolder(value.trim().replace(/^"|"$/g, ''));
  }

  /** Start the session with the folder, mode, model and effort chosen here. False when it did not start; the reason is shown. */
  async function startSession() {
    if (!folder) {
      toast('Choose a project folder first.', { kind: 'error' });
      openFolderMenu(folderButton);
      return false;
    }
    if (!state.auth?.signedIn) {
      toast('Sign in to GitHub Copilot first.', { kind: 'error' });
      actions.showView('signin');
      return false;
    }
    if (mode === 'full') {
      const ok = await confirmDialog({ title: 'Start with full access?', message: 'The agent will change files and run commands without asking. Auto mode is the safer middle ground: Claude asks you about risky commands.', confirmLabel: 'Start', danger: true });
      if (!ok) return false;
    }
    creating = true;
    composer.refresh();
    try {
      await actions.createSession({ cwd: folder, mode, worktree: useWorktree, model, effort });
      return true;
    } catch (error) {
      toastError(error);
      return false;
    } finally {
      creating = false;
    }
  }

  async function start(text, images) {
    const sent = (await startSession()) && (await actions.sendMessage(text, images));
    return sent;
  }

  subscriptions.push(on('models', () => composer.refresh()));
  subscriptions.push(on('settings', () => composer.refresh()));
  subscriptions.push(on('sessions', renderRecent));
  renderFolder();
  renderRecent();
  // A new install asks once which mode sessions start in. Closing the question keeps the mode from Settings
  // and asks again at the next start.
  if (state.boot.firstRun) {
    state.boot.firstRun = false;
    chooseDefaultMode().then((chosen) => {
      if (chosen) setMode(chosen);
      composer.focus();
    });
  } else {
    setTimeout(() => composer.focus(), 0);
  }

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      container.firstChild?.remove();
    },
  };
}

/** Ask which mode new sessions start in, with Accept edits chosen, and save the answer as the default. Resolves the mode, or null. */
function chooseDefaultMode() {
  const answer = new Promise((resolve) => {
    const options = ['edits', 'ask', 'auto', 'plan', 'full'].map((id) => MODES.find((mode) => mode.id === id));
    const radios = options.map((mode) => h('input', { type: 'radio', name: 'first-mode', value: mode.id, checked: mode.id === 'edits' }));
    openModal({
      title: 'How much should the agent do on its own?',
      body: h(
        'div',
        { class: 'stack', role: 'radiogroup', 'aria-label': 'Mode for new sessions' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'New sessions start in this mode. You can switch a session with Shift+Tab, and change the default in Settings → Permissions.'),
        options.map((mode, index) => h('label', { class: 'mode-choice' }, radios[index], h('span', {}, h('strong', {}, mode.name), h('span', { class: 'muted' }, ` ${mode.description}`)))),
      ),
      footer: (close) => h('button', { class: 'btn primary', type: 'button', onClick: () => close(radios.find((radio) => radio.checked).value) }, 'Use this mode'),
      onClose: async (mode) => {
        if (mode && (await actions.saveSettings({ defaultMode: mode }))) resolve(mode);
        else resolve(null);
      },
    });
  });
  return answer;
}

// ---------- Sign-in ----------

export function mountSignIn(container) {
  const subscriptions = [];
  const errorElement = h('div');
  const deviceElement = h('div');
  const tokenInput = h('input', { class: 'input mono', type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Personal access token' });
  const rememberBox = h('input', { type: 'checkbox', checked: true });
  const connectButton = h('button', { class: 'btn primary', type: 'button', onClick: connectToken }, 'Connect');
  let codeCopied = false;
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connectToken();
  });

  const page = h(
    'div',
    { class: 'page' },
    h(
      'div',
      { class: 'signin' },
      h('div', { class: 'brand-big' }, h('img', { src: '/icon.svg', alt: '' }), h('div', {}, h('h1', { style: { margin: 0 } }, 'Sign in to Caliope'), h('div', { class: 'muted' }, 'Uses your own GitHub Copilot subscription (Pro, Pro+, Business or Enterprise).'))),
      errorElement,
      h(
        'div',
        { class: 'card' },
        h(
          'p',
          { class: 'muted', style: { marginTop: 0, fontSize: '13px' } },
          'GitHub opens in your browser with a one-time code already copied. Paste it and authorize Caliope. Your Copilot subscription pays for what you use, and you can revoke access any time on GitHub under Settings → Applications.',
        ),
        deviceElement,
        h(
          'label',
          { class: 'row', style: { marginTop: '14px', cursor: 'pointer', fontSize: '13px' } },
          rememberBox,
          h('span', {}, h('strong', {}, 'Remember me on this PC. '), h('span', { class: 'muted' }, 'Off: nothing is saved to disk, and you sign in again each time Caliope starts.')),
        ),
      ),
      h(
        'details',
        { class: 'card advanced-signin' },
        h('summary', {}, 'Use a personal access token instead (advanced)'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, 'Open ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'GitHub → Fine-grained tokens → Generate new token'), '.'),
          h('li', {}, 'Under ', h('strong', {}, 'Permissions'), ', click ', h('strong', {}, 'Add permissions'), ', choose ', h('strong', {}, 'Copilot Requests'), ' and set it to ', h('strong', {}, 'Read-only'), '. No repository access is needed.'),
          h('li', {}, 'Generate the token and paste it here.'),
        ),
        h('div', { class: 'row' }, tokenInput, connectButton),
      ),
      h(
        'div',
        { class: 'callout info', style: { marginTop: '12px' } },
        h('span', { html: icon('shield-check', 16) }),
        h('div', {}, 'A remembered sign-in is encrypted with your Windows account (DPAPI), only sent to GitHub and never written to logs or sessions. The agent\'s file tools cannot open it and commands cannot run in Caliope\'s data folder. A command elsewhere could still read it, so check commands before you approve them and keep Full access for trusted work. Every person signs in with their own account. Nothing is shared through this app.'),
      ),
    ),
  );
  container.append(h('div', { class: 'view' }, page));

  function showError(message) {
    clear(errorElement);
    if (message) errorElement.append(h('div', { class: 'callout error', style: { marginBottom: '14px' } }, h('span', { html: icon('circle-alert', 16) }), h('div', {}, message, h('div', { class: 'faint', style: { marginTop: '4px' } }, hintFor(message)))));
  }

  function hintFor(message) {
    if (/Copilot Requests/i.test(message)) return 'The token is missing the "Copilot Requests" permission. Edit the token on GitHub and add it, or simply use "Sign in with GitHub" above.';
    if (/policy|disabled by your organization/i.test(message)) return 'Your organization does not allow this kind of access. Use "Sign in with GitHub" above.';
    if (/HTTP 401/.test(message)) return 'GitHub rejected the token: it may be expired, revoked or copied incompletely. "Sign in with GitHub" above avoids tokens altogether.';
    if (/HTTP 403/.test(message)) return 'Access was refused. Check that your Copilot seat is active, or use "Sign in with GitHub" above.';
    if (/HTTP 404/.test(message)) return 'No Copilot access was found for this account.';
    if (/reach|fetch failed|ENOTFOUND|ECONN|certificate/i.test(message)) return 'Caliope could not reach GitHub. Check your network, or set the proxy in Settings → Network.';
    return '';
  }

  async function connectToken() {
    const token = tokenInput.value.trim();
    if (!token) {
      tokenInput.focus();
      return;
    }
    connectButton.disabled = true;
    connectButton.textContent = 'Checking…';
    showError(null);
    try {
      state.auth = await api.post('/api/auth/token', { token, remember: rememberBox.checked });
      tokenInput.value = '';
      toast(`Connected${state.auth.login ? ` as ${state.auth.login}` : ''}.`);
      afterSignIn();
    } catch (error) {
      showError(error.message);
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = 'Connect';
    }
  }

  function renderDevice() {
    clear(deviceElement);
    const device = state.auth?.device;
    const signInButton = (label) => h('button', { class: 'btn primary signin-github', type: 'button', onClick: startDevice }, h('span', { html: icon('external-link', 16) }), label);
    if (!device || device.state === 'success') {
      deviceElement.append(signInButton('Sign in with GitHub'));
      return;
    }
    if (device.state === 'error') {
      deviceElement.append(h('div', { class: 'callout error', style: { marginBottom: '10px' } }, h('span', { html: icon('circle-alert', 16) }), device.error), signInButton('Try again'));
      return;
    }
    deviceElement.append(
      h(
        'div',
        { class: 'stack' },
        h('div', {}, `GitHub opened in your browser. Paste this code there${codeCopied ? ' (it is already copied)' : ''}, then click `, h('strong', {}, 'Authorize'), '.'),
        h('div', { class: 'row' }, h('span', { class: 'device-code' }, device.userCode), h('button', { class: 'btn small', type: 'button', onClick: () => copyText(device.userCode).then(() => toast('Code copied.')) }, h('span', { html: icon('copy', 13) }), 'Copy again')),
        h('div', { class: 'faint', style: { fontSize: '12.5px' } }, 'No browser tab? Open ', h('a', { href: device.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, device.verificationUri), '.'),
        h('div', { class: 'row muted' }, h('span', { class: 'spin', html: icon('loader-circle', 15) }), 'Waiting for GitHub… this page continues by itself.', h('button', { class: 'btn ghost small', type: 'button', onClick: () => api.post('/api/auth/device/cancel').then((auth) => { state.auth = auth; renderDevice(); }) }, 'Cancel')),
      ),
    );
  }

  async function startDevice() {
    showError(null);
    try {
      state.auth = await api.post('/api/auth/device/start', { remember: rememberBox.checked });
      const device = state.auth.device;
      // Copy first: once GitHub's page has focus, this window can no longer write to the clipboard.
      codeCopied = device?.userCode ? await copyText(device.userCode) : false;
      renderDevice();
      if (device?.verificationUri) await api.post('/api/open-url', { url: device.verificationUri });
    } catch (error) {
      showError(error.message);
    }
  }

  function afterSignIn() {
    actions.showView('new');
  }

  subscriptions.push(
    on('auth', () => {
      if (state.auth?.signedIn && state.auth?.device?.state === 'success') {
        toast(`Connected${state.auth.login ? ` as ${state.auth.login}` : ''}.`);
        afterSignIn();
        return;
      }
      renderDevice();
    }),
  );
  if (state.auth?.error) showError(state.auth.error);
  renderDevice();

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      container.firstChild?.remove();
    },
  };
}
