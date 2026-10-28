// Full-page views: new session and sign-in.
import { h, clear, basename, relativeTime, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on, loadPreference, savePreference } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { Composer } from './composer.js';
import { openMenu, openModal, toast, toastError, confirmDialog } from './dialogs.js';

// ---------- New session ----------

export function mountNewSession(container) {
  const subscriptions = [];
  let folder = state.newSessionFolder || loadPreference('lastFolder', null) || state.settings?.recentFolders?.[0] || null;
  state.newSessionFolder = null;
  let mode = state.settings?.defaultMode || 'auto';
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

  const composer = new Composer({
    placeholder: 'What should we work on? (Enter to start)',
    sessionId: () => null,
    mode: () => mode,
    setMode: (next) => {
      mode = next;
      composer.refresh();
    },
    model: () => (mode === 'plan' ? state.modelDefaults.plan : state.modelDefaults.build),
    effort: () => (mode === 'plan' ? state.settings?.planEffort : state.settings?.buildEffort),
    setModel: () => toast('Pick the model after the session starts, or set the defaults in Settings → Models.'),
    setEffort: () => toast('Set the default effort in Settings → Models, or change it once the session starts.'),
    running: () => creating,
    queue: () => [],
    commands: () => folderCommands,
    skills: () => folderSkills,
    onSubmit: (text, images) => start(text, images),
    onStop: () => {},
    onSlash: async (name) => {
      if (name === 'settings') actions.showView('settings');
      else if (name === 'usage') actions.showView('usage');
      else toast('Start the session first, then use that command.');
      return true;
    },
  });

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
          'div',
          { class: 'session-item', role: 'button', tabindex: '0', onClick: () => actions.openSession(meta.id) },
          h('span', { class: 'status', html: icon('message-square', 14) }),
          h('div', { class: 'body' }, h('div', { class: 'title' }, meta.title), h('div', { class: 'sub' }, h('span', { class: 'ellipsis' }, meta.cwd), h('span', {}, '·'), h('span', {}, relativeTime(meta.updatedAt)))),
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
    try {
      const result = await api.post('/api/pick-folder', { initial: folder || '' });
      if (result.path) setFolder(result.path);
    } catch (error) {
      toastError(error);
      openFolderBrowser();
    }
  }

  function openFolderMenu(anchor) {
    const recent = state.settings?.recentFolders || [];
    openMenu(anchor, [
      recent.length ? { section: 'Recent folders' } : null,
      ...recent.map((item) => ({ label: item, icon: 'folder', checked: item === folder, onSelect: () => setFolder(item) })),
      recent.length ? 'separator' : null,
      { label: 'Browse with Windows…', icon: 'folder-open', onSelect: browse },
      { label: 'Browse in the app…', icon: 'folder-tree', onSelect: openFolderBrowser },
      { label: 'Type a path…', icon: 'pencil', onSelect: typePath },
    ]);
  }

  async function typePath() {
    const { promptDialog } = await import('./dialogs.js');
    const value = await promptDialog({ title: 'Project folder', value: folder || '', placeholder: 'C:\\path\\to\\project', confirmLabel: 'Use folder' });
    if (value && value.trim()) setFolder(value.trim().replace(/^"|"$/g, ''));
  }

  function openFolderBrowser() {
    let current = folder;
    const list = h('div', { class: 'folder-browser' });
    const pathLabel = h('div', { class: 'mono faint', style: { fontSize: '12px', wordBreak: 'break-all' } });
    async function load(target) {
      try {
        const result = await api.get(`/api/folders${target ? `?path=${encodeURIComponent(target)}` : ''}`);
        current = result.path;
        clear(list);
        pathLabel.textContent = result.path || 'This PC';
        if (!result.path) {
          for (const drive of result.drives) list.append(menuRow('monitor', drive, () => load(drive)));
          list.append(menuRow('user', result.home, () => load(result.home)));
          for (const recent of result.recent) list.append(menuRow('history', recent, () => load(recent)));
          return;
        }
        list.append(menuRow('arrow-up', '..', () => load(result.parent)));
        for (const name of result.folders) list.append(menuRow('folder', name, () => load(`${result.path}\\${name}`)));
      } catch (error) {
        toastError(error);
      }
    }
    openModal({
      title: 'Choose a project folder',
      body: h('div', { class: 'stack' }, pathLabel, list),
      footer: (close) => [
        h('button', { class: 'btn', onClick: () => close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            onClick: () => {
              if (current) setFolder(current);
              close();
            },
          },
          'Use this folder',
        ),
      ],
    });
    load(folder || '');
  }

  async function start(text, images) {
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
      await actions.createSession({ cwd: folder, mode, worktree: useWorktree });
      return await actions.sendMessage(text, images);
    } catch (error) {
      toastError(error);
      return false;
    } finally {
      creating = false;
    }
  }

  subscriptions.push(on('models', () => composer.refresh()));
  subscriptions.push(on('settings', () => composer.refresh()));
  subscriptions.push(on('sessions', renderRecent));
  renderFolder();
  renderRecent();
  setTimeout(() => composer.focus(), 0);

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      container.firstChild?.remove();
    },
  };
}

function menuRow(iconName, label, onClick) {
  return h('button', { class: 'menu-item', type: 'button', onClick }, h('span', { html: icon(iconName, 15) }), h('span', { class: 'ellipsis grow' }, label));
}

// ---------- Sign-in ----------

export function mountSignIn(container) {
  const subscriptions = [];
  const errorElement = h('div');
  const deviceElement = h('div');
  const tokenInput = h('input', { class: 'input mono', type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false' });
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
