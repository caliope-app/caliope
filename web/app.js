// Caliope app: loads state, keeps it current through server events, and switches views.
import { api, connectEvents } from './lib/api.js';
import { state, on, emit, loadPreference, savePreference } from './lib/store.js';
import * as actions from './lib/actions.js';
import { h, clear } from './lib/dom.js';
import { installCodeCopy } from './lib/markdown.js';
import { mountSidebar } from './views/sidebar.js';
import { mountSession } from './views/session.js';
import { mountNewSession, mountSignIn } from './views/pages.js';
import { mountSettings } from './views/settings.js';
import { mountUsage } from './views/usage.js';
import { mountProject } from './views/project.js';
import { mountPullRequests } from './views/pulls.js';
import { toast, toastError } from './views/dialogs.js';

const app = document.getElementById('app');
const main = document.getElementById('main');
let currentView = null;
let currentViewName = null;
// Banners above every view: the connection, sessions that could not be saved, a server that stopped.
const notices = h('div');
let connectionBanner = null;
let saveBanner = null;

/**
 * Web links open in the browser chosen in Settings, not in the browser that hosts the app window.
 */
function installLinkHandling() {
  const handle = (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
    event.preventDefault();
    api.post('/api/open-url', { url: url.href }).catch(toastError);
  };
  document.addEventListener('click', handle);
  document.addEventListener('auxclick', (event) => {
    if (event.button === 1) handle(event);
  });
}

async function boot() {
  installCodeCopy(document.body);
  installLinkHandling();
  state.sidebar.group = loadPreference('sidebarGroup', 'project');
  applySidebarWidth(loadPreference('sidebarWidth', 288));
  if (loadPreference('sidebarCollapsed', false)) app.classList.add('sidebar-collapsed');
  try {
    await loadState();
  } catch (error) {
    clear(main).append(h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('h1', {}, 'Caliope could not load'), h('p', { class: 'muted' }, error.message))));
    return;
  }
  mountSidebar(document.getElementById('sidebar'));
  connect();
  on('save_errors', renderSaveBanner);
  on('shutdown', showShutdown);
  on('view', renderMain);
  on('auth', () => {
    if (!state.auth?.signedIn && state.view === 'new') renderMain();
  });
  on('sidebar:toggle', toggleSidebar);
  installResizer();
  installShortcuts();
  if (!state.auth?.signedIn) state.view = 'signin';
  renderMain();
  renderSaveBanner();
  // Reopen the session that was open when the window closed or reloaded.
  const lastSession = loadPreference('lastSession', null);
  if (state.auth?.signedIn && lastSession && state.sessions.has(lastSession)) actions.openSession(lastSession);
  window.addEventListener('focus', () => {
    if (state.activeId && document.visibilityState === 'visible') actions.markSeen(state.activeId);
  });
}

async function loadState() {
  const boot = await api.get('/api/state');
  state.boot = { version: boot.version, user: boot.user, home: boot.home, dataDir: boot.dataDir, efforts: boot.efforts, extraPathDetected: boot.extraPathDetected };
  state.auth = boot.auth;
  state.settings = boot.settings;
  state.sessions = new Map(boot.sessions.map((meta) => [meta.id, meta]));
  state.runtimes = new Map(Object.entries(boot.runtimes || {}));
  state.allowance = boot.allowance || { allowance: null, error: null };
  state.update = boot.update || null;
  state.saveErrors = boot.saveErrors || {};
  actions.applyModels(boot);
  actions.applyTheme();
  state.ready = true;
}

function connect() {
  connectEvents({
    onEvent: actions.handleServerEvent,
    onOpen: async (reconnected) => {
      setConnected(true);
      if (!reconnected) return;
      // Events sent while disconnected are lost. Reload what the window shows.
      try {
        await loadState();
        emit('sessions');
        emit('auth');
        emit('settings');
        emit('allowance');
        renderSaveBanner();
        if (state.activeId) await actions.reloadActive();
      } catch (error) {
        toastError(error);
      }
    },
    onError: () => setConnected(false),
  });
}

function setConnected(connected) {
  state.connected = connected;
  if (connected) {
    connectionBanner?.remove();
    connectionBanner = null;
  } else if (!connectionBanner && !state.shutdownNotice) {
    connectionBanner = h('div', { class: 'connection-banner' }, 'Connection to Caliope lost. Reconnecting… If this stays, start the app again with its launcher.');
    notices.prepend(connectionBanner);
  }
}

/** A warning while sessions could not be saved; it goes once they save again. */
function renderSaveBanner() {
  saveBanner?.remove();
  saveBanner = null;
  const errors = Object.entries(state.saveErrors || {});
  if (errors.length === 0) return;
  const titles = errors.map(([id]) => `"${state.sessions.get(id)?.title || id}"`).join(', ');
  saveBanner = h('div', { class: 'connection-banner' }, `Caliope could not save ${errors.length === 1 ? 'the session' : `${errors.length} sessions`} ${titles}: ${errors[0][1].replace(/\.?$/, '.')} Free some disk space or close programs that lock ${state.boot.dataDir}; Caliope saves again with the next change.`);
  notices.append(saveBanner);
}

/** The server stopped for a newer version (which opens its own window) or because it was asked to. */
function showShutdown() {
  connectionBanner?.remove();
  connectionBanner = null;
  const updated = state.shutdownNotice === 'update';
  notices.prepend(h('div', { class: 'connection-banner' }, updated ? 'Caliope was updated and opens again in a new window. You can close this one.' : 'Caliope was stopped. You can close this window.'));
  // A window the launcher opened can close itself. Where the browser refuses, the banner stays.
  if (updated) setTimeout(() => window.close(), 3000);
}

function renderMain() {
  let view = state.view;
  if (view === 'new' && !state.auth?.signedIn) view = 'signin';
  if (view === 'session' && !state.activeId) view = 'new';
  if (view === 'project' && !state.projectFolder) view = 'new';
  if (view === currentViewName && view !== 'session' && view !== 'project') return;
  if (view === 'session' && currentViewName === 'session') {
    // Same view, different session: the session view re-renders on the 'active' event.
    return;
  }
  currentView?.destroy();
  clear(main);
  main.append(notices);
  currentViewName = view;
  const mounts = { session: mountSession, new: mountNewSession, signin: mountSignIn, settings: mountSettings, usage: mountUsage, project: mountProject, pulls: mountPullRequests };
  currentView = mounts[view](main);
  document.title = 'Caliope';
}

// ---------- Sidebar size ----------

function applySidebarWidth(width) {
  const clamped = Math.max(220, Math.min(480, width));
  document.documentElement.style.setProperty('--sidebar-w', `${clamped}px`);
  return clamped;
}

function installResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  resizer.addEventListener('mousedown', (event) => {
    event.preventDefault();
    resizer.classList.add('dragging');
    const onMove = (moveEvent) => applySidebarWidth(moveEvent.clientX);
    const onUp = (upEvent) => {
      resizer.classList.remove('dragging');
      savePreference('sidebarWidth', applySidebarWidth(upEvent.clientX));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  resizer.addEventListener('dblclick', () => savePreference('sidebarWidth', applySidebarWidth(288)));
}

function toggleSidebar() {
  app.classList.toggle('sidebar-collapsed');
  savePreference('sidebarCollapsed', app.classList.contains('sidebar-collapsed'));
}

// ---------- Shortcuts ----------

function installShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === 'n' && !event.shiftKey) {
      event.preventDefault();
      actions.showView('new');
    } else if (key === 'k') {
      event.preventDefault();
      if (app.classList.contains('sidebar-collapsed')) toggleSidebar();
      emit('sidebar:search');
    } else if (key === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (key === ',') {
      event.preventDefault();
      actions.showView('settings');
    }
  });
  // Keep the window title useful in the taskbar: how many sessions need you.
  on('runtime', updateTitle);
  on('sessions', updateTitle);
}

function updateTitle() {
  let waiting = 0;
  for (const runtime of state.runtimes.values()) if (runtime.waiting) waiting++;
  document.title = waiting ? `(${waiting}) Caliope – needs you` : 'Caliope';
}

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  toast(event.reason?.message || 'Something went wrong.', { kind: 'error' });
});

boot();
