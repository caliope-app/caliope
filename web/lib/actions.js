// Things the user can do, and how server events update the state.
import { api, withKey } from './api.js';
import { state, emit, runtimeOf, savePreference } from './store.js';
import { h, basename, formatCost } from './dom.js';
import { confirmDialog, promptDialog, openModal, toast, toastError } from '../views/dialogs.js';

// ---------- Updates ----------

export async function checkForUpdate() {
  try {
    state.update = await api.post('/api/update/check');
    emit('update');
    if (state.update.error) toast(`Could not check for updates: ${state.update.error}`);
    else if (!state.update.available) toast(`Caliope ${state.update.current} is the latest version.`);
  } catch (error) {
    toastError(error);
  }
}

export async function installUpdate() {
  const latest = state.update?.latest;
  const ok = await confirmDialog({ title: `Update Caliope to ${latest}?`, message: 'The update downloads in a PowerShell window. Then the new version starts and this one closes. A turn that is still running stops.', confirmLabel: 'Update' });
  if (!ok) return;
  try {
    await api.post('/api/update/install');
    toast('Downloading the update in a PowerShell window.');
  } catch (error) {
    toastError(error);
  }
}

// ---------- Navigation ----------

export function showView(view) {
  state.view = view;
  if (view !== 'session') {
    state.activeId = null;
    state.active = null;
    savePreference('lastSession', null);
  }
  emit('view');
  emit('sessions');
}

// Messages for the session being opened that arrived while its history was loading.
let messagesWhileOpening = 0;

export async function openSession(id, { focusComposer = true } = {}) {
  if (!state.sessions.has(id)) return;
  savePreference('lastSession', id);
  state.view = 'session';
  state.activeId = id;
  state.active = null;
  emit('view');
  emit('sessions');
  try {
    // Messages that arrive while the history loads may or may not be in it, so load it again then.
    let payload = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      messagesWhileOpening = 0;
      payload = await api.get(`/api/sessions/${id}`);
      if (state.activeId !== id) return;
      if (messagesWhileOpening === 0) break;
    }
    state.active = payload;
    state.sessions.set(id, payload.meta);
    state.runtimes.set(id, stripRuntime(payload.runtime));
    emit('active');
    if (focusComposer) emit('composer:focus');
    if (payload.meta.unread) markSeen(id);
  } catch (error) {
    toastError(error);
  }
}

export function newSessionIn(folder) {
  state.newSessionFolder = folder;
  showView('new');
}

export function openProject(folder) {
  state.projectFolder = folder;
  state.view = 'project';
  state.activeId = null;
  state.active = null;
  savePreference('lastSession', null);
  emit('view');
  emit('sessions');
}

export async function reloadActive() {
  if (!state.activeId) return;
  const id = state.activeId;
  const payload = await api.get(`/api/sessions/${id}`);
  if (state.activeId !== id) return;
  state.active = payload;
  state.runtimes.set(id, stripRuntime(payload.runtime));
  emit('active');
}

function stripRuntime(runtime) {
  return { state: runtime.state, status: runtime.status, waiting: runtime.waiting, queue: runtime.queue, queuePaused: Boolean(runtime.queuePaused), jobs: runtime.jobs || [] };
}

export function markSeen(id) {
  const meta = state.sessions.get(id);
  if (!meta || !meta.unread) return;
  meta.unread = false;
  emit('sessions');
  api.patch(`/api/sessions/${id}`, { unread: false }).catch(() => {});
}

// ---------- Sessions ----------

/**
 * Start a session. The first session in a folder asks whether to trust it. The answer is remembered for the folder.
 */
export async function createSession({ cwd, mode, worktree = false }) {
  let payload;
  try {
    payload = await api.post('/api/sessions', { cwd, mode, worktree });
  } catch (error) {
    if (error.status !== 428) throw error;
    const trust = await new Promise((resolve) => {
      openModal({
        title: 'Do you trust this folder?',
        body: h('div', { class: 'stack' }, h('p', { style: { margin: 0 } }, error.message), h('p', { class: 'muted', style: { margin: 0, fontSize: '13px' } }, 'MCP servers and skills can run programs on your PC. Without trust, sessions here work without them. You can change this on the project page.')),
        footer: (close) => [
          h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Don\'t trust'),
          h('button', { class: 'btn primary', type: 'button', autofocus: true, onClick: () => close(true) }, 'Trust this folder'),
        ],
        onClose: (value) => resolve(typeof value === 'boolean' ? value : null),
      });
    });
    // Closing the dialog cancels the new session without deciding.
    if (trust === null) throw new Error('The session was not started.');
    payload = await api.post('/api/sessions', { cwd, mode, worktree, trust });
  }
  state.sessions.set(payload.meta.id, payload.meta);
  savePreference('lastSession', payload.meta.id);
  state.view = 'session';
  state.activeId = payload.meta.id;
  state.active = payload;
  emit('view');
  emit('sessions');
  emit('active');
  return payload;
}

/** Send a message; while the agent works it is queued, or with `interrupt` it stops the agent and goes now. */
export async function sendMessage(text, images = [], { interrupt = false } = {}) {
  const id = state.activeId;
  if (!id) return false;
  if (!state.auth?.signedIn) {
    toast('Sign in to GitHub Copilot first.', { kind: 'error' });
    showView('signin');
    return false;
  }
  try {
    await api.post(`/api/sessions/${id}/messages`, { text, images, interrupt });
    return true;
  } catch (error) {
    if (error.status === 401) {
      showView('signin');
    }
    toastError(error);
    return false;
  }
}

export async function runCommand(command) {
  const id = state.activeId;
  if (!id) return;
  try {
    await api.post(`/api/sessions/${id}/command`, { command });
  } catch (error) {
    toastError(error);
  }
}

export async function stopTurn() {
  if (!state.activeId) return;
  await api.post(`/api/sessions/${state.activeId}/stop`).catch(toastError);
}

export async function retryTurn() {
  if (!state.activeId) return;
  await api.post(`/api/sessions/${state.activeId}/retry`).catch(toastError);
}

export async function respond(waitId, payload) {
  if (!state.activeId) return;
  try {
    await api.post(`/api/sessions/${state.activeId}/respond`, { waitId, ...payload });
  } catch (error) {
    toastError(error);
    reloadActive().catch(() => {});
  }
}

export async function updateSession(id, patch) {
  try {
    const result = await api.patch(`/api/sessions/${id}`, patch);
    state.sessions.set(id, result.meta);
    if (state.active?.meta.id === id) state.active.meta = result.meta;
    emit('sessions');
    emit('active:meta');
    return result.meta;
  } catch (error) {
    toastError(error);
    return null;
  }
}

export function setMode(mode) {
  const id = state.activeId;
  if (!id) return;
  const meta = state.sessions.get(id);
  if (meta?.mode === mode) return;
  updateSession(id, { mode });
}

export function setModel(model, effort) {
  const id = state.activeId;
  if (!id) return;
  const patch = {};
  if (model) patch.model = model;
  if (effort !== undefined) patch.effort = effort;
  updateSession(id, patch);
}

export async function renameSession(id) {
  const meta = state.sessions.get(id);
  const title = await promptDialog({ title: 'Rename session', value: meta?.title || '', confirmLabel: 'Rename' });
  if (title && title.trim()) await updateSession(id, { title: title.trim() });
}

export function togglePin(id) {
  const meta = state.sessions.get(id);
  return updateSession(id, { pinned: !meta?.pinned });
}

export async function toggleArchive(id) {
  const meta = state.sessions.get(id);
  const archived = !meta?.archived;
  await updateSession(id, { archived });
  toast(archived ? 'Session archived. Find it under Archived.' : 'Session restored.');
  if (archived && state.activeId === id) showView('new');
}

export async function deleteSession(id) {
  const meta = state.sessions.get(id);
  const worktree = meta?.worktree && !meta.worktree.removed ? meta.worktree : null;
  const files = worktree
    ? `Its worktree folder is removed too when it has no uncommitted changes. The branch ${worktree.branch} stays.`
    : 'Files in the project folder are not touched.';
  const ok = await confirmDialog({
    title: 'Delete this session?',
    message: `"${meta?.title || 'Session'}" and its history will be deleted from this PC. ${files} This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await api.del(`/api/sessions/${id}`);
    state.sessions.delete(id);
    state.runtimes.delete(id);
    if (state.activeId === id) showView('new');
    emit('sessions');
    if (result.keptWorktree) toast(`The worktree folder ${result.keptWorktree} was kept: it has uncommitted changes or another session uses it.`);
  } catch (error) {
    toastError(error);
  }
}

export async function forkSession(id, messageId = null) {
  try {
    const result = await api.post(`/api/sessions/${id}/fork`, { messageId });
    const fork = result.session;
    state.sessions.set(fork.meta.id, fork.meta);
    savePreference('lastSession', fork.meta.id);
    state.view = 'session';
    state.activeId = fork.meta.id;
    state.active = fork;
    emit('view');
    emit('sessions');
    emit('active');
    if (result.prompt) emit('composer:restore', { text: result.prompt.text, images: result.prompt.images });
    toast('Forked into a new session.');
  } catch (error) {
    toastError(error);
  }
}

export function exportSession(id) {
  const link = h('a', { href: withKey(`/api/sessions/${id}/export`), download: '' });
  document.body.append(link);
  link.click();
  link.remove();
}

export async function compactSession(id, instructions = '') {
  toast('Compacting the conversation…');
  try {
    const result = await api.post(`/api/sessions/${id}/compact`, { instructions });
    toast(result.stopped ? 'Compaction stopped. The conversation is unchanged.' : 'Conversation compacted.');
  } catch (error) {
    toastError(error);
  }
}

/**
 * Rewind to before a message the user wrote: preview which files would be restored, then confirm.
 * - The message text goes back into the composer so it can be edited and sent again.
 */
export async function rewindTo(messageId) {
  const id = state.activeId;
  if (!id) return;
  if (runtimeOf(id).state === 'running') {
    toast('Stop the running turn first.', { kind: 'error' });
    return;
  }
  let preview;
  try {
    preview = await api.get(`/api/sessions/${id}/rewind?messageId=${encodeURIComponent(messageId)}`);
  } catch (error) {
    toastError(error);
    return;
  }
  const restoreBox = h('input', { type: 'checkbox', checked: preview.files.length > 0 });
  const forceBox = h('input', { type: 'checkbox' });
  const conflicts = preview.files.filter((file) => file.conflict);
  const fileList = preview.files.length
    ? h(
        'div',
        { class: 'stack' },
        h('label', { class: 'row' }, restoreBox, h('span', {}, `Also restore ${preview.files.length} file${preview.files.length === 1 ? '' : 's'} the agent changed after this message`)),
        h(
          'ul',
          { class: 'muted', style: { margin: '0', paddingLeft: '20px', fontSize: '12.5px', maxHeight: '180px', overflowY: 'auto' } },
          preview.files.map((file) =>
            h('li', { class: file.conflict ? 'warning-text' : '' }, `${file.action === 'delete' ? 'Delete' : 'Restore'} ${file.shownPath}${file.conflict ? ' (changed since, skipped unless you overwrite)' : ''}`),
          ),
        ),
        conflicts.length ? h('label', { class: 'row warning-text' }, forceBox, h('span', {}, `Overwrite the ${conflicts.length} file(s) changed since`)) : null,
      )
    : h('p', { class: 'muted', style: { margin: '0' } }, 'No files were changed by the agent after this message.');
  const ok = await confirmDialog({
    title: 'Rewind to this message?',
    message: 'The conversation from this message on is removed. The message goes back into the box below so you can edit it and send it again. Command side effects (installed packages, git commits) are not undone.',
    extra: fileList,
    confirmLabel: 'Rewind',
  });
  if (!ok) return;
  try {
    const result = await api.post(`/api/sessions/${id}/rewind`, { messageId, restoreCode: restoreBox.checked, force: forceBox.checked });
    await reloadActive();
    emit('composer:restore', { text: result.prompt.text, images: result.prompt.images });
    const parts = [];
    if (result.restored.length) parts.push(`restored ${result.restored.length} file(s)`);
    if (result.skipped.length) parts.push(`skipped ${result.skipped.length} changed file(s)`);
    toast(`Rewound${parts.length ? `: ${parts.join(', ')}` : ''}.`);
  } catch (error) {
    toastError(error);
  }
}

export async function showSystemPrompt(id) {
  const result = await api.get(`/api/sessions/${id}/system-prompt`).catch(toastError);
  if (!result) return;
  openModal({
    title: 'System prompt and tools',
    wide: true,
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'muted' }, result.systemPrompt ? 'Frozen when the session started, so the conversation stays valid and cacheable.' : 'Not created yet: it is built when you send the first message.'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, (result.toolNames || []).map((name) => h('span', { class: 'chip mono' }, name))),
      result.systemPrompt ? h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', fontSize: '12px', background: 'var(--code-bg)', padding: '12px', borderRadius: '8px', maxHeight: '55vh', overflow: 'auto' } }, result.systemPrompt) : null,
    ),
    footer: (close) => h('button', { class: 'btn', onClick: () => close() }, 'Close'),
  });
}

/** Delete a session's worktree folder; its branch stays. Uncommitted work is only thrown away after a second confirmation. */
export async function removeWorktree(meta) {
  const worktree = meta.worktree;
  const forks = [...state.sessions.values()].filter((other) => other.id !== meta.id && other.worktree?.folder === worktree.folder && !other.worktree.removed).length;
  const ok = await confirmDialog({
    title: 'Remove this worktree?',
    message: `The folder ${worktree.folder} is deleted. The branch ${worktree.branch} stays in the repository, so you can still merge or delete it. The session history stays, but the agent can no longer work in this session${forks ? ` or in the ${forks} forked ${forks === 1 ? 'session' : 'sessions'} that use the same worktree` : ''}.`,
    confirmLabel: 'Remove worktree',
  });
  if (!ok) return;
  try {
    await api.post(`/api/sessions/${meta.id}/worktree/remove`, {});
  } catch (error) {
    if (error.status !== 409 || !/uncommitted/.test(error.message)) {
      toastError(error);
      return;
    }
    const force = await confirmDialog({
      title: 'The worktree has uncommitted changes',
      message: `Removing it now throws those changes away. Commit them first (/commit) to keep them on ${worktree.branch}.`,
      confirmLabel: 'Remove and lose the changes',
      danger: true,
    });
    if (!force) return;
    try {
      await api.post(`/api/sessions/${meta.id}/worktree/remove`, { force: true });
    } catch (forceError) {
      toastError(forceError);
      return;
    }
  }
  toast(`Worktree removed. Branch ${worktree.branch} is kept.`);
}

export async function openPath(target, reveal = true) {
  await api.post('/api/open', { path: target, reveal }).catch(toastError);
}

// ---------- Settings, models, account ----------

export async function saveSettings(patch) {
  try {
    const result = await api.put('/api/settings', patch);
    state.settings = result.settings;
    applyTheme();
    emit('settings');
    return true;
  } catch (error) {
    toastError(error);
    return false;
  }
}

export async function refreshModels() {
  try {
    const result = await api.get('/api/models?refresh=1');
    applyModels(result);
    toast(`Loaded ${result.models.length} models.`);
  } catch (error) {
    toastError(error);
  }
}

export function applyModels(result) {
  state.models = result.models || [];
  // The server's startup refresh broadcasts the list without defaults and costs. Keep the known ones.
  state.modelDefaults = result.defaults || state.modelDefaults || {};
  state.modelCosts = result.costs || state.modelCosts || {};
  state.modelsError = result.error || null;
  state.modelsFetchedAt = result.fetchedAt || null;
  emit('models');
}

export async function signOut() {
  const ok = await confirmDialog({ title: 'Sign out?', message: 'The saved GitHub token is removed from this PC. Your sessions stay.', confirmLabel: 'Sign out' });
  if (!ok) return;
  try {
    state.auth = await api.post('/api/auth/logout');
    emit('auth');
    showView('signin');
  } catch (error) {
    toastError(error);
  }
}

export function applyTheme() {
  const theme = state.settings?.theme || 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// ---------- Server events ----------

export function handleServerEvent(event) {
  const active = state.active;
  const isActive = (sessionId) => Boolean(active) && active.meta.id === sessionId && state.activeId === sessionId;
  switch (event.type) {
    case 'session': {
      state.sessions.set(event.meta.id, event.meta);
      if (event.runtime) state.runtimes.set(event.meta.id, event.runtime);
      if (isActive(event.meta.id)) {
        active.meta = event.meta;
        emit('active:meta');
      }
      emit('sessions');
      break;
    }
    case 'session_deleted': {
      state.sessions.delete(event.sessionId);
      state.runtimes.delete(event.sessionId);
      if (state.activeId === event.sessionId) showView('new');
      emit('sessions');
      break;
    }
    case 'runtime': {
      const previous = runtimeOf(event.sessionId);
      state.runtimes.set(event.sessionId, event.runtime);
      if (isActive(event.sessionId)) {
        active.runtime = { ...active.runtime, ...event.runtime };
        emit('active:runtime');
      }
      emit('runtime', event.sessionId);
      if (!previous.waiting && event.runtime.waiting) notifyWaiting(event.sessionId, event.runtime.waiting);
      emit('sessions');
      break;
    }
    case 'message': {
      if (!isActive(event.sessionId)) {
        if (event.sessionId === state.activeId && !active) messagesWhileOpening++;
        break;
      }
      if (active.messages.some((message) => message.id === event.message.id)) break;
      active.messages.push(event.message);
      if (event.message.role === 'assistant') active.runtime.live = null;
      emit('active:message', event.message);
      break;
    }
    case 'message_update': {
      if (!isActive(event.sessionId)) {
        if (event.sessionId === state.activeId && !active) messagesWhileOpening++;
        break;
      }
      const index = active.messages.findIndex((message) => message.id === event.message.id);
      if (index >= 0) active.messages[index] = event.message;
      else active.messages.push(event.message);
      emit('active:message_update', event.message);
      break;
    }
    case 'live_start': {
      if (!isActive(event.sessionId)) break;
      active.runtime.live = { streamId: event.streamId, model: event.model, blocks: [] };
      emit('active:live', { kind: 'start' });
      break;
    }
    case 'live_delta': {
      if (!isActive(event.sessionId) || active.runtime.live?.streamId !== event.streamId) break;
      applyLiveDeltas(active.runtime.live, event.deltas);
      emit('active:live', { kind: 'delta' });
      break;
    }
    case 'live_end': {
      if (!isActive(event.sessionId)) break;
      if (active.runtime.live) active.runtime.live.ended = true;
      emit('active:live', { kind: 'end' });
      break;
    }
    case 'tool_start': {
      if (!isActive(event.sessionId)) break;
      active.runtime.toolRuns = active.runtime.toolRuns || {};
      active.runtime.toolRuns[event.toolUseId] = { output: '', startedAt: Date.now() };
      emit('active:tool', { kind: 'start', toolUseId: event.toolUseId });
      break;
    }
    case 'tool_output': {
      if (!isActive(event.sessionId)) break;
      const run = active.runtime.toolRuns?.[event.toolUseId];
      if (run) run.output += event.text;
      emit('active:tool', { kind: 'output', toolUseId: event.toolUseId, text: event.text });
      break;
    }
    case 'tool_end': {
      if (!isActive(event.sessionId)) break;
      if (active.runtime.toolRuns) delete active.runtime.toolRuns[event.toolUseId];
      emit('active:tool', { kind: 'end', toolUseId: event.toolUseId });
      break;
    }
    case 'todos': {
      if (!isActive(event.sessionId)) break;
      active.todos = event.todos;
      emit('active:todos');
      break;
    }
    case 'usage': {
      const meta = state.sessions.get(event.sessionId);
      if (meta) {
        meta.usage = event.usage;
        meta.lastInputTokens = event.lastInputTokens;
      }
      if (isActive(event.sessionId)) {
        active.meta.usage = event.usage;
        active.meta.lastInputTokens = event.lastInputTokens;
        emit('active:meta');
      }
      emit('sessions');
      emit('usage');
      break;
    }
    case 'turn_end': {
      if (isActive(event.sessionId) && document.visibilityState === 'visible') markSeen(event.sessionId);
      notifyTurnEnd(event.sessionId, event.spentNanoAiu);
      emit('usage');
      break;
    }
    case 'session_reload': {
      if (isActive(event.sessionId)) reloadActive().catch(() => {});
      break;
    }
    case 'auth': {
      state.auth = event.auth;
      emit('auth');
      break;
    }
    case 'models': {
      applyModels(event);
      break;
    }
    case 'settings': {
      state.settings = event.settings;
      applyTheme();
      emit('settings');
      break;
    }
    case 'allowance': {
      state.allowance = { allowance: event.allowance, error: event.error };
      emit('allowance');
      break;
    }
    case 'projects': {
      emit('projects');
      break;
    }
    case 'update': {
      state.update = event.update;
      emit('update');
      break;
    }
    case 'save_errors': {
      state.saveErrors = event.errors;
      emit('save_errors');
      break;
    }
    case 'shutdown': {
      state.shutdownNotice = event.notice;
      emit('shutdown');
      break;
    }
    default:
      break;
  }
}

/** Same rules as the server's live snapshot. */
export function applyLiveDeltas(live, deltas) {
  for (const delta of deltas) {
    if (delta.kind === 'block_start') live.blocks[delta.index] = { type: delta.blockType, text: '', name: delta.name || null, id: delta.id || null, inputLength: 0, done: false };
    const block = live.blocks[delta.index];
    if (!block) continue;
    if (delta.kind === 'text' || delta.kind === 'thinking') block.text += delta.text;
    if (delta.kind === 'tool_input') block.inputLength = delta.length;
    if (delta.kind === 'block_stop') {
      block.done = true;
      if (delta.input) block.input = delta.input;
    }
  }
}

// ---------- Notifications ----------

function notificationsAllowed() {
  return state.settings?.notifications && 'Notification' in window && Notification.permission === 'granted';
}

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

function shouldNotify(sessionId) {
  return document.visibilityState !== 'visible' || !document.hasFocus() || state.activeId !== sessionId;
}

function notify(sessionId, title, body) {
  if (!notificationsAllowed() || !shouldNotify(sessionId)) return;
  const notification = new Notification(title, { body, icon: '/icon.svg', tag: sessionId });
  notification.onclick = () => {
    window.focus();
    openSession(sessionId);
    notification.close();
  };
}

function notifyWaiting(sessionId, waiting) {
  const meta = state.sessions.get(sessionId);
  const what = waiting.kind === 'plan' ? 'A plan is ready for your review' : waiting.kind === 'question' ? 'The agent has a question' : 'The agent needs your approval';
  notify(sessionId, meta?.title || 'Caliope', what);
}

function notifyTurnEnd(sessionId, spentNanoAiu) {
  const meta = state.sessions.get(sessionId);
  const cost = typeof spentNanoAiu === 'number' && spentNanoAiu > 0 ? ` (${formatCost(spentNanoAiu, state.settings?.costUnit)})` : '';
  notify(sessionId, meta?.title || 'Caliope', `Finished${cost}. Folder: ${basename(meta?.cwd || '')}`);
}
