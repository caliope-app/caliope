// The session screen: header, transcript, approval cards, side panel and composer.
import { h, clear, basename, formatCost, projectFolder, pluralize } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on, runtimeOf, modelById } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { Transcript } from './transcript.js';
import { Composer, showHelp } from './composer.js';
import { approvalCard, answerByKey } from './approvals.js';
import { SidePanel } from './side-panel.js';
import { openMenu, confirmDialog, toast, toastError, announce } from './dialogs.js';

export function mountSession(container) {
  const subscriptions = [];
  const listen = (topic, handler) => subscriptions.push(on(topic, handler));
  let stickToBottom = true;
  let lastJobsKey = '';
  let lastWaitingId = null;
  let lastRunState = null;
  let branch = null;
  let sessionSkills = [];
  let sessionCommands = [];

  const header = h('header', { class: 'session-header' });
  const scroller = h('div', { class: 'transcript-scroll' });
  const jumpButton = h('button', { class: 'btn small jump-bottom', hidden: true, onClick: () => scrollToBottom(true) }, h('span', { html: icon('arrow-down', 14) }), 'Latest');
  const transcript = new Transcript({
    onRewind: (messageId) => actions.rewindTo(messageId),
    onFork: (messageId) => actions.forkSession(state.activeId, messageId),
    onRetry: () => actions.retryTurn(),
    onContinue: () => actions.sendMessage('Continue.'),
    onSignIn: () => actions.showView('signin'),
    onOpenProject: (folder) => actions.openProject(folder),
    onContentChange: () => {
      if (stickToBottom) scrollToBottom(false);
    },
  });
  scroller.append(transcript.element);
  const approvalArea = h('div');
  const signedOutNotice = h('div', { class: 'callout warn', hidden: true, style: { marginBottom: '8px' } });
  const composer = new Composer({
    sessionId: () => state.activeId,
    mode: () => state.active?.meta.mode || 'ask',
    setMode: (mode) => changeMode(mode),
    model: () => state.active?.meta.model,
    effort: () => state.active?.meta.effort,
    setModel: (model) => actions.setModel(model),
    setEffort: (effort) => actions.setModel(null, effort),
    running: () => runtimeOf(state.activeId).state === 'running',
    queue: () => runtimeOf(state.activeId).queue || [],
    waiting: () => Boolean(runtimeOf(state.activeId).waiting),
    queuePaused: () => Boolean(runtimeOf(state.activeId).queuePaused),
    context: () => {
      const meta = state.active?.meta;
      const model = modelById(meta?.model);
      return meta && model?.maxPromptTokens ? { used: meta.lastInputTokens || 0, max: model.maxPromptTokens } : null;
    },
    cost: () => {
      const usage = state.active?.meta.usage;
      if (!usage || usage.requests === 0) return null;
      const unit = state.settings?.costUnit;
      return {
        text: formatCost(usage.nanoAiu, unit, { unpriced: usage.unpricedRequests || 0 }),
        title: `This session: ${formatCost(usage.nanoAiu, 'credits')} (${formatCost(usage.nanoAiu, 'usd')}) over ${pluralize(usage.requests, 'request')}${usage.unpricedRequests ? `; ${usage.unpricedRequests} without a reported cost` : ''}. Click the coins in the header for details.`,
      };
    },
    onSubmit: (text, images, options) => actions.sendMessage(text, images, options),
    onUnqueue: (index, text) => api.del(`/api/sessions/${state.activeId}/queue/${index}?text=${encodeURIComponent(text)}`).catch(toastError),
    onSendNow: (index, text) => api.post(`/api/sessions/${state.activeId}/queue/${index}/send?text=${encodeURIComponent(text)}`).catch(toastError),
    onResumeQueue: () => api.post(`/api/sessions/${state.activeId}/queue/resume`).catch(toastError),
    onClearQueue: () => api.del(`/api/sessions/${state.activeId}/queue`).catch(toastError),
    skills: () => sessionSkills,
    commands: () => sessionCommands,
    onStop: () => actions.stopTurn(),
    onSlash: (name, argument) => runSlash(name, argument),
    onDraft: (text, sessionId = state.activeId) => state.composerDrafts.set(sessionId, text),
  });
  const composerArea = h('div', { class: 'composer-area' }, h('div', { class: 'composer-inner' }, signedOutNotice, approvalArea), composer.element);
  const transcriptColumn = h('div', { class: 'transcript-column' }, scroller, jumpButton, composerArea);
  const sidePanel = new SidePanel({ onToggle: () => renderHeader() });
  const body = h('div', { class: 'session-body' }, transcriptColumn, sidePanel.resizer, sidePanel.element);
  const root = h('div', { class: 'view' }, header, body);
  container.append(root);
  // Below 900 pixels the side panel lies over the transcript and the message box (styles.css). As with the sidebar
  // in a narrow window, a click outside it closes it.
  const panelOverlays = window.matchMedia('(max-width: 900px)');
  transcriptColumn.addEventListener('mousedown', () => {
    if (panelOverlays.matches && sidePanel.isOpen) sidePanel.close();
  });

  scroller.addEventListener('scroll', () => {
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    stickToBottom = nearBottom;
    jumpButton.hidden = nearBottom;
  });

  function scrollToBottom(smooth) {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickToBottom = true;
    jumpButton.hidden = true;
  }

  async function changeMode(mode) {
    if (mode === 'full') {
      const ok = await confirmDialog({
        title: 'Switch to full access?',
        message: 'The agent will change files and run commands without asking. Use it for trusted tasks in a folder under version control. Auto mode is the safer middle ground: a safety check asks you about risky commands.',
        confirmLabel: 'Switch to full access',
        danger: true,
      });
      if (!ok) return;
    }
    actions.setMode(mode);
  }

  async function runSlash(name, argument) {
    const id = state.activeId;
    switch (name) {
      case 'plan':
        await actions.updateSession(id, { mode: 'plan' });
        if (argument) await actions.sendMessage(argument);
        return true;
      case 'build':
        actions.setMode('edits');
        return true;
      case 'ask':
        actions.setMode('ask');
        return true;
      case 'auto':
        await changeMode('auto');
        return true;
      case 'full':
        await changeMode('full');
        return true;
      case 'model':
        composer.openModelMenu();
        return true;
      case 'effort':
        if (state.boot.efforts.includes(argument)) actions.setModel(null, argument);
        else composer.openEffortMenu();
        return true;
      case 'compact':
        await actions.compactSession(id, argument);
        return true;
      case 'review':
        await actions.runCommand('review');
        return true;
      case 'init':
        await actions.runCommand('init');
        return true;
      case 'commit':
        await actions.runCommand('commit');
        return true;
      case 'pr':
        await actions.runCommand('pr');
        return true;
      case 'remember':
        if (!argument) {
          toast('Write the note after /remember, for example: /remember Run tests with pytest -q');
          return true;
        }
        api.post(`/api/sessions/${id}/remember`, { note: argument }).then(() => toast('Saved to the project memory.')).catch(toastError);
        return true;
      case 'new':
        if (state.active) await actions.createSession({ cwd: projectFolder(state.active.meta), mode: state.settings?.defaultMode }).catch(toastError);
        return true;
      case 'fork':
        await actions.forkSession(id);
        return true;
      case 'rename':
        if (argument) await actions.updateSession(id, { title: argument });
        else await actions.renameSession(id);
        return true;
      case 'export':
        actions.exportSession(id);
        return true;
      case 'usage':
        actions.showView('usage');
        return true;
      case 'settings':
        actions.showView('settings');
        return true;
      case 'help':
        showHelp();
        return true;
      default:
        return false;
    }
  }

  // ----- Header -----

  function renderHeader() {
    clear(header);
    const meta = state.active?.meta || state.sessions.get(state.activeId);
    if (!meta) return;
    const title = h('button', { class: 'session-title', type: 'button', title: 'Click to rename' }, meta.title);
    title.addEventListener('click', () => editTitle(title, meta));
    header.append(title);
    const chips = h('div', { class: 'header-chips' });
    chips.append(h('button', { class: 'chip', title: `${meta.cwd}\nClick to open in Explorer`, onClick: () => actions.openPath(meta.cwd) }, h('span', { html: icon('folder', 13) }), basename(projectFolder(meta))));
    const worktree = meta.worktree && !meta.worktree.removed ? meta.worktree : null;
    if (branch || worktree) {
      const branchTitle = worktree ? `Own git worktree on branch ${worktree.branch}\n${worktree.folder}\nRepository: ${worktree.repoRoot}` : 'Git branch when the session view opened';
      chips.append(h('span', { class: `chip${worktree ? ' on' : ''}`, title: branchTitle }, h('span', { html: icon('git-branch', 13) }), branch || worktree.branch));
    }
    const runningJobs = (runtimeOf(state.activeId).jobs || []).filter((job) => job.running).length;
    if (runningJobs > 0) chips.append(h('button', { class: 'chip on', title: 'Commands the agent started in the background. Click to see or stop them.', onClick: () => sidePanel.open('info') }, h('span', { html: icon('terminal', 13) }), `${runningJobs} running`));
    header.append(chips);

    const actionsElement = h('div', { class: 'header-actions' });
    const usage = meta.usage || {};
    const unit = state.settings?.costUnit;
    actionsElement.append(
      h(
        'button',
        { class: 'chip', title: 'What this session has cost so far. Click for details.', onClick: () => sidePanel.open('info') },
        h('span', { html: icon('coins', 13) }),
        usage.requests ? formatCost(usage.nanoAiu, unit, { unpriced: usage.unpricedRequests || 0 }) : formatCost(0, unit),
      ),
    );
    const todos = state.active?.todos || [];
    const done = todos.filter((todo) => todo.status === 'completed').length;
    actionsElement.append(panelButton('tasks', 'list-todo', 'Tasks', todos.length ? `${done}/${todos.length}` : null));
    actionsElement.append(panelButton('changes', 'file-pen', 'Changed files', state.active?.changedFiles || null));
    actionsElement.append(panelButton('browser', 'globe', 'Browser', null));
    const more = iconButton('ellipsis', 'More', () => openMoreMenu(more, meta));
    actionsElement.append(more);
    header.append(actionsElement);
  }

  function panelButton(tab, iconName, label, badge) {
    const showing = sidePanel.showing(tab);
    const button = h('button', { class: `btn ghost small${showing ? ' active' : ''}`, title: label, 'aria-label': label, onClick: () => (showing ? sidePanel.close() : sidePanel.open(tab)) }, h('span', { html: icon(iconName, 15) }), badge !== null && badge !== undefined && badge !== 0 ? h('span', { class: 'badge' }, String(badge)) : null);
    return button;
  }

  function editTitle(titleElement, meta) {
    const input = h('input', { class: 'session-title', value: meta.title, 'aria-label': 'Session title' });
    titleElement.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== meta.title) await actions.updateSession(meta.id, { title: input.value.trim() });
      renderHeader();
      header.querySelector('.session-title')?.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function openMoreMenu(anchor, meta) {
    const worktree = meta.worktree && !meta.worktree.removed;
    openMenu(
      anchor,
      [
        { label: 'Rename', icon: 'square-pen', onSelect: () => actions.renameSession(meta.id) },
        { label: meta.pinned ? 'Unpin' : 'Pin to top', icon: meta.pinned ? 'pin-off' : 'pin', onSelect: () => actions.togglePin(meta.id) },
        { label: 'Fork into a new session', icon: 'git-fork', onSelect: () => actions.forkSession(meta.id) },
        { label: 'Compact conversation now', icon: 'layers', onSelect: () => actions.compactSession(meta.id) },
        { label: 'Regenerate title', icon: 'sparkles', onSelect: () => api.post(`/api/sessions/${meta.id}/title`).catch(toastError) },
        'separator',
        { label: 'Export as Markdown', icon: 'download', onSelect: () => actions.exportSession(meta.id) },
        { label: 'Show system prompt and tools', icon: 'scroll-text', onSelect: () => actions.showSystemPrompt(meta.id) },
        { label: 'Open folder in Explorer', icon: 'folder-open', onSelect: () => actions.openPath(meta.cwd) },
        { label: 'Project page', icon: 'layers', onSelect: () => actions.openProject(projectFolder(meta)) },
        worktree ? { label: 'Remove worktree…', icon: 'git-branch', onSelect: () => actions.removeWorktree(meta) } : null,
        { label: 'Commands and shortcuts', icon: 'terminal', onSelect: showHelp },
        'separator',
        { label: meta.archived ? 'Restore from archive' : 'Archive', icon: meta.archived ? 'archive-restore' : 'archive', onSelect: () => actions.toggleArchive(meta.id) },
        { label: 'Delete session', icon: 'trash-2', danger: true, onSelect: () => actions.deleteSession(meta.id) },
      ],
      { align: 'right' },
    );
  }

  // ----- Approval cards -----

  function renderApproval() {
    clear(approvalArea);
    const waiting = runtimeOf(state.activeId).waiting;
    transcript.setWaiting(waiting);
    if (!waiting) {
      lastWaitingId = null;
      return;
    }
    approvalArea.append(approvalCard(waiting));
    // Screen readers hear about a new card once, not on every redraw.
    if (waiting.id !== lastWaitingId) announce(approvalArea.querySelector('.approval-head .grow')?.textContent || 'The agent needs you.');
    lastWaitingId = waiting.id;
    if (stickToBottom) scrollToBottom(false);
  }

  function onApprovalKeys(event) {
    answerByKey(event, runtimeOf(state.activeId).waiting);
  }
  document.addEventListener('keydown', onApprovalKeys);

  function onEscape(event) {
    if (event.key !== 'Escape' || document.querySelector('.modal-backdrop, .menu')) return;
    // Esc in another text field (feedback, title) belongs to that field.
    const tag = document.activeElement?.tagName;
    if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && document.activeElement !== composer.textarea) return;
    if (runtimeOf(state.activeId).state === 'running') {
      event.preventDefault();
      actions.stopTurn();
    }
  }
  document.addEventListener('keydown', onEscape);

  function renderSignedOut() {
    signedOutNotice.hidden = Boolean(state.auth?.signedIn);
    clear(signedOutNotice);
    if (!state.auth?.signedIn) {
      signedOutNotice.append(h('span', { html: icon('key-round', 15) }), h('span', { class: 'grow' }, 'You are not signed in to GitHub Copilot. You can read this session, but not continue it.'), h('button', { class: 'btn small', onClick: () => actions.showView('signin') }, 'Sign in'));
    }
  }

  // ----- Wiring -----

  function renderAll() {
    renderHeader();
    renderSignedOut();
    if (!state.active) {
      clear(transcript.messagesElement).append(h('div', { class: 'empty-transcript' }, h('span', { class: 'spin', html: icon('loader-circle', 22) })));
      return;
    }
    transcript.setSession(state.active);
    lastRunState = runtimeOf(state.activeId).state;
    renderApproval();
    sidePanel.render();
    composer.refresh();
    // Each session keeps its own unsent text.
    const draft = state.composerDrafts.get(state.activeId) || '';
    if (composer.textarea.value !== draft) composer.setText(draft);
    scrollToBottom(false);
    loadBranch();
    loadSkills();
    loadCommands();
  }

  /** Custom commands (.claude/commands, .github/prompts) for the / menu. */
  async function loadCommands() {
    const id = state.activeId;
    sessionCommands = [];
    try {
      const result = await api.get(`/api/commands?folder=${encodeURIComponent(state.active.meta.cwd)}`);
      if (state.activeId === id) sessionCommands = result.commands;
    } catch {
      // The menu then shows the built-in commands only.
    }
  }

  async function loadSkills() {
    const id = state.activeId;
    if (state.active?.skills) {
      sessionSkills = state.active.skills;
      return;
    }
    try {
      const result = await api.get(`/api/skills?folder=${encodeURIComponent(state.active.meta.cwd)}`);
      if (state.activeId === id) sessionSkills = result.skills;
    } catch {
      sessionSkills = [];
    }
  }

  async function loadBranch() {
    const id = state.activeId;
    try {
      const result = await api.get(`/api/sessions/${id}/branch`);
      if (state.activeId !== id) return;
      branch = result.branch;
      renderHeader();
    } catch {
      branch = null;
    }
  }

  listen('active', renderAll);
  listen('active:meta', () => {
    renderHeader();
    composer.refresh();
    if (sidePanel.showing('info')) sidePanel.render();
  });
  listen('active:message', (message) => {
    transcript.append(message);
    if (message.role === 'user' && message.kind === 'tool_results') sidePanel.refreshChangesSoon();
  });
  listen('active:message_update', (message) => {
    transcript.update(message);
    sidePanel.refreshChangesSoon();
  });
  listen('active:live', ({ kind }) => transcript.live(kind));
  listen('active:tool', (event) => transcript.tool(event));
  listen('active:runtime', () => {
    renderApproval();
    composer.refresh();
    const runtime = runtimeOf(state.activeId);
    // Background commands started or ended: update the header chip and the Info panel.
    const jobsKey = JSON.stringify((runtime.jobs || []).map((job) => [job.id, job.running]));
    if (jobsKey !== lastJobsKey) {
      lastJobsKey = jobsKey;
      renderHeader();
      if (sidePanel.showing('info')) sidePanel.render();
    }
    transcript.updateStatus(state.active?.runtime);
    if (lastRunState === 'running' && runtime.state === 'idle') announce('The agent is done.');
    lastRunState = runtime.state;
    if (runtime.state === 'idle') {
      transcript.clearLive();
      sidePanel.refreshChangesSoon(true);
      api.get(`/api/sessions/${state.activeId}`).then((payload) => {
        if (state.active && payload.meta.id === state.activeId) {
          state.active.changedFiles = payload.changedFiles;
          renderHeader();
        }
      }).catch(() => {});
    }
  });
  listen('active:todos', () => {
    renderHeader();
    if (sidePanel.showing('tasks')) sidePanel.render();
  });
  listen('models', () => composer.refresh());
  listen('settings', () => composer.refresh());
  listen('auth', renderSignedOut);
  listen('composer:restore', ({ text, images }) => {
    // Keep it as the draft too, so a re-render of the session (session_reload) does not wipe it.
    state.composerDrafts.set(state.activeId, text || '');
    composer.setText(text || '', images || []);
  });
  listen('composer:focus', () => composer.focus());

  renderAll();

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      document.removeEventListener('keydown', onApprovalKeys);
      document.removeEventListener('keydown', onEscape);
      sidePanel.destroy();
      transcript.destroy();
      root.remove();
    },
  };
}

function iconButton(iconName, title, onClick) {
  return h('button', { class: 'btn ghost small icon-only', type: 'button', title, 'aria-label': title, html: icon(iconName, 15), onClick });
}
