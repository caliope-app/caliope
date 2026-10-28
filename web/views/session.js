// The session screen: header, transcript, approval prompts, side panel and composer.
import { h, clear, basename, formatCost, formatTokens, debounce, relativeTime, projectFolder } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { state, on, runtimeOf, modelById, modelLabel, loadPreference, savePreference } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { Transcript, todoList } from './transcript.js';
import { Composer, MODES, SLASH_COMMANDS } from './composer.js';
import { renderDiff, diffStat } from './diff-view.js';
import { openMenu, confirmDialog, openModal, toast, toastError } from './dialogs.js';
import { BrowserView } from './browser-view.js';

export function mountSession(container) {
  const subscriptions = [];
  const listen = (topic, handler) => subscriptions.push(on(topic, handler));
  let panelTab = loadPreference('panelTab', 'tasks');
  let panelOpen = loadPreference('panelOpen', false);
  let stickToBottom = true;
  let changesSource = loadPreference('changesSource', 'session');
  const expandedChanges = new Set();
  let lastJobsKey = '';
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
        title: `This session: ${formatCost(usage.nanoAiu, 'credits')} (${formatCost(usage.nanoAiu, 'usd')}) over ${usage.requests} requests${usage.unpricedRequests ? `; ${usage.unpricedRequests} without a reported cost` : ''}. Click the coins in the header for details.`,
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
    onDraft: (text) => state.composerDrafts.set(state.activeId, text),
  });
  const composerArea = h('div', { class: 'composer-area' }, h('div', { class: 'composer-inner' }, signedOutNotice, approvalArea), composer.element);
  const transcriptColumn = h('div', { class: 'transcript-column' }, scroller, jumpButton, composerArea);
  const panel = h('aside', { class: 'side-panel', hidden: true });
  const panelResizer = h('div', { class: 'resizer panel-resizer', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize', hidden: true });
  // Kept across panel renders, so its live stream only restarts when the session changes.
  const browserView = new BrowserView({ onPageChange: () => applyPanelWidth() });
  const body = h('div', { class: 'session-body' }, transcriptColumn, panelResizer, panel);
  const root = h('div', { class: 'view' }, header, body);
  container.append(root);

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
    const title = h('div', { class: 'session-title', title: 'Click to rename' }, meta.title);
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
    if (runningJobs > 0) chips.append(h('button', { class: 'chip on', title: 'Commands the agent started in the background. Click to see or stop them.', onClick: () => openPanel('info') }, h('span', { html: icon('terminal', 13) }), `${runningJobs} running`));
    header.append(chips);

    const actionsElement = h('div', { class: 'header-actions' });
    const usage = meta.usage || {};
    const unit = state.settings?.costUnit;
    actionsElement.append(
      h(
        'button',
        { class: 'chip', title: 'What this session has cost so far. Click for details.', onClick: () => openPanel('info') },
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
    const button = h('button', { class: `btn ghost small${panelOpen && panelTab === tab ? ' active' : ''}`, title: label, onClick: () => (panelOpen && panelTab === tab ? closePanel() : openPanel(tab)) }, h('span', { html: icon(iconName, 15) }), badge !== null && badge !== undefined && badge !== 0 ? h('span', { class: 'badge' }, String(badge)) : null);
    return button;
  }

  function editTitle(titleElement, meta) {
    const input = h('input', { class: 'session-title', value: meta.title });
    titleElement.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== meta.title) await actions.updateSession(meta.id, { title: input.value.trim() });
      renderHeader();
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
        'separator',
        { label: meta.archived ? 'Restore from archive' : 'Archive', icon: meta.archived ? 'archive-restore' : 'archive', onSelect: () => actions.toggleArchive(meta.id) },
        { label: 'Delete session', icon: 'trash-2', danger: true, onSelect: () => actions.deleteSession(meta.id) },
      ],
      { align: 'right' },
    );
  }

  // ----- Side panel -----

  function openPanel(tab) {
    panelTab = tab;
    panelOpen = true;
    savePreference('panelTab', tab);
    savePreference('panelOpen', true);
    renderPanel();
    renderHeader();
  }

  function closePanel() {
    panelOpen = false;
    savePreference('panelOpen', false);
    renderPanel();
    renderHeader();
  }

  // The panel's width, dragged by the user: one for a Browser panel that shows a page (by default all but 440
  // pixels for the transcript, at least half), one for everything else. The transcript keeps at least 380 pixels.
  function panelWidthKey() {
    const key = panelTab === 'browser' && browserView.state.hasPage ? 'browserPanelWidth' : 'panelWidth';
    return key;
  }

  function defaultPanelWidth(key) {
    const width = key === 'browserPanelWidth' ? Math.round(Math.max(body.clientWidth / 2, body.clientWidth - 440)) : 360;
    return width;
  }

  function applyPanelWidth(width = null) {
    const key = panelWidthKey();
    const chosen = Math.round(Math.max(280, width ?? loadPreference(key, defaultPanelWidth(key))));
    panel.style.width = `${chosen}px`;
    return chosen;
  }

  panelResizer.addEventListener('mousedown', (event) => {
    event.preventDefault();
    panelResizer.classList.add('dragging');
    const widthAt = (clientX) => Math.min(body.getBoundingClientRect().right - clientX, body.clientWidth - 380);
    const onMove = (moveEvent) => applyPanelWidth(widthAt(moveEvent.clientX));
    const onUp = (upEvent) => {
      panelResizer.classList.remove('dragging');
      savePreference(panelWidthKey(), applyPanelWidth(widthAt(upEvent.clientX)));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  panelResizer.addEventListener('dblclick', () => savePreference(panelWidthKey(), applyPanelWidth(defaultPanelWidth(panelWidthKey()))));

  /** The page the session's browser showed last, from its browser tool results. */
  function lastBrowserPage(session) {
    const browserCalls = new Set();
    let url = null;
    for (const message of session?.messages || []) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_use' && block.name === 'browser') browserCalls.add(block.id);
        if (block.type === 'tool_result' && browserCalls.has(block.tool_use_id) && block.meta?.url && !block.meta.withheld) url = block.meta.url;
      }
    }
    return url;
  }

  function renderPanel() {
    panel.hidden = !panelOpen;
    panelResizer.hidden = !panelOpen;
    if (!(panelOpen && panelTab === 'browser' && state.active)) browserView.hide();
    if (!panelOpen || !state.active) return;
    applyPanelWidth();
    clear(panel);
    const tabs = h('div', { class: 'side-panel-tabs' });
    for (const [tab, label, iconName] of [
      ['tasks', 'Tasks', 'list-todo'],
      ['changes', 'Changes', 'file-pen'],
      ['plan', 'Plan', 'map'],
      ['browser', 'Browser', 'globe'],
      ['info', 'Info', 'coins'],
    ]) {
      tabs.append(h('button', { class: panelTab === tab ? 'active' : '', onClick: () => openPanel(tab) }, h('span', { html: icon(iconName, 14) }), label));
    }
    tabs.append(h('span', { class: 'grow' }), iconButton('x', 'Close panel', closePanel));
    const content = h('div', { class: 'side-panel-body' });
    panel.append(tabs, content);
    if (panelTab === 'tasks') content.append(todoList(state.active.todos || []));
    else if (panelTab === 'plan') {
      content.append(state.active.plan ? h('div', { class: 'prose', html: renderMarkdown(state.active.plan) }) : h('div', { class: 'faint' }, 'No approved plan yet. Use Plan mode (Shift+Tab or /plan) to have the planning model write one.'));
    } else if (panelTab === 'changes') renderChanges(content);
    else if (panelTab === 'browser') {
      content.append(browserView.element);
      browserView.show(state.activeId, lastBrowserPage(state.active));
    } else renderInfo(content);
  }

  /** Changes panel: the files the agent changed in this session, or everything uncommitted in git. */
  async function renderChanges(content) {
    const sessionId = state.activeId;
    const sourceToggle = h(
      'div',
      { class: 'segmented', style: { marginBottom: '10px' } },
      [
        ['session', 'This session'],
        ['git', 'Uncommitted (git)'],
      ].map(([source, label]) =>
        h(
          'button',
          {
            class: changesSource === source ? 'active' : '',
            type: 'button',
            onClick: () => {
              changesSource = source;
              savePreference('changesSource', source);
              renderPanel();
            },
          },
          label,
        ),
      ),
    );
    const list = h('div', {}, h('div', { class: 'faint' }, 'Loading…'));
    content.append(sourceToggle, list);
    let changes;
    let note;
    try {
      if (changesSource === 'git') {
        const result = await api.get(`/api/sessions/${sessionId}/git`);
        if (state.activeId !== sessionId) return;
        if (!result.repo) {
          clear(list).append(h('div', { class: 'faint' }, result.reason));
          return;
        }
        changes = result.files;
        note = h(
          'div',
          { class: 'row', style: { fontSize: '12px', marginBottom: '8px', flexWrap: 'wrap' } },
          h('span', { class: 'faint grow' }, `${result.total} uncommitted ${result.total === 1 ? 'file' : 'files'} on ${result.branch || 'a detached HEAD'}, compared with the last commit.${result.truncated ? ' Only the first 150 are shown.' : ''}`),
          result.total > 0 && state.active?.meta.mode !== 'plan' ? h('button', { class: 'btn small', type: 'button', title: 'The agent reviews the changes and commits them (it does not push)', onClick: () => actions.runCommand('commit') }, h('span', { html: icon('git-branch', 13) }), 'Commit…') : null,
          state.active?.meta.mode !== 'plan' ? h('button', { class: 'btn small', type: 'button', title: 'The agent commits the work, pushes the branch and opens a pull request on GitHub or Azure DevOps (you approve it first)', onClick: () => actions.runCommand('pr') }, h('span', { html: icon('git-branch', 13) }), 'Pull request…') : null,
        );
        if (changes.length === 0) {
          clear(list).append(h('div', { class: 'faint' }, `Nothing to commit on ${result.branch || 'this branch'}.`));
          return;
        }
      } else {
        const result = await api.get(`/api/sessions/${sessionId}/changes`);
        if (state.activeId !== sessionId) return;
        changes = result.changes.filter((change) => change.status !== 'unchanged');
        if (changes.length === 0) {
          clear(list).append(h('div', { class: 'faint' }, 'The agent has not changed any files with its edit tools in this session. "Uncommitted (git)" also shows changes made by commands.'));
          return;
        }
        note = h('div', { class: 'faint', style: { fontSize: '12px', marginBottom: '8px' } }, 'Each file compared with its state before the agent first changed it. Changes made by commands are in "Uncommitted (git)".');
      }
    } catch (error) {
      clear(list).append(h('div', { class: 'danger-text' }, error.message));
      return;
    }
    clear(list).append(note);
    for (const change of changes) {
      // Files the user opened stay open when the panel reloads.
      const key = `${changesSource}:${change.path}`;
      const diffContainer = h('div', { hidden: true });
      const head = h(
        'div',
        { class: 'change-file-head', title: change.path },
        h('span', { class: `status-tag ${change.status}` }, change.status),
        h('span', { class: 'ellipsis' }, change.shownPath),
        change.binary ? h('span', { class: 'faint' }, 'binary') : change.tooLarge ? h('span', { class: 'faint' }, 'too large') : diffStat(change.added, change.removed),
        change.status === 'deleted'
          ? null
          : iconButton('folder-open', 'Show in Explorer', (event) => {
              event.stopPropagation();
              actions.openPath(change.path);
            }),
      );
      const toggle = (open) => {
        if (open && !diffContainer.firstChild) diffContainer.append(renderDiff(change, { emptyText: change.binary ? 'Binary file.' : change.tooLarge ? 'Too large to show here.' : 'No differences.' }));
        diffContainer.hidden = !open;
        if (open) expandedChanges.add(key);
        else expandedChanges.delete(key);
      };
      head.addEventListener('click', () => toggle(diffContainer.hidden));
      if (expandedChanges.has(key)) toggle(true);
      list.append(h('div', { class: 'change-file' }, head, diffContainer));
    }
  }

  function renderInfo(content) {
    const meta = state.active.meta;
    const usage = meta.usage || {};
    const model = modelById(meta.model);
    const rows = (pairs) => h('dl', { class: 'kv' }, pairs.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value)]));
    content.append(
      h(
        'div',
        { class: 'panel-section' },
        h('h4', {}, 'Spent in this session'),
        rows([
          ['AI credits', formatCost(usage.nanoAiu || 0, 'credits')],
          ['US dollars', formatCost(usage.nanoAiu || 0, 'usd')],
          ['Requests', String(usage.requests || 0)],
          ['Without reported cost', String(usage.unpricedRequests || 0)],
          ['Input tokens', formatTokens(usage.input || 0)],
          ['Cached input tokens', formatTokens(usage.cacheRead || 0)],
          ['Output tokens', formatTokens(usage.output || 0)],
        ]),
      ),
    );
    const byModel = Object.entries(usage.byModel || {});
    if (byModel.length) {
      content.append(
        h(
          'div',
          { class: 'panel-section' },
          h('h4', {}, 'By model'),
          rows(byModel.sort((a, b) => b[1].nanoAiu - a[1].nanoAiu).map(([id, entry]) => [modelLabel(id), `${formatCost(entry.nanoAiu, state.settings?.costUnit)} · ${entry.requests} req`])),
        ),
      );
    }
    content.append(
      h(
        'div',
        { class: 'panel-section' },
        h('h4', {}, 'Session'),
        rows([
          ['Model', `${modelLabel(meta.model)}${meta.effort ? ` · ${meta.effort}` : ''}`],
          ['Context used', model?.maxPromptTokens ? `${formatTokens(meta.lastInputTokens || 0)} / ${formatTokens(model.maxPromptTokens)}` : formatTokens(meta.lastInputTokens || 0)],
          ['Mode', MODES.find((mode) => mode.id === meta.mode)?.name || meta.mode],
          ['Created', new Date(meta.createdAt).toLocaleString()],
          ['Last activity', relativeTime(meta.updatedAt)],
          ['Messages', String(meta.messageCount || 0)],
        ]),
        h('div', { class: 'mono faint', style: { fontSize: '11.5px', marginTop: '8px', wordBreak: 'break-all' } }, meta.cwd),
      ),
    );
    const rules = state.active.allowRules || [];
    const hosts = [...new Set([...(state.active.allowedHosts || []), ...(state.active.fetchHosts || [])])];
    content.append(
      h(
        'div',
        { class: 'panel-section' },
        h('h4', {}, 'Allowed in this session without asking'),
        rules.length || hosts.length
          ? h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [...rules.map((rule) => h('span', { class: 'chip mono' }, rule)), ...hosts.map((host) => h('span', { class: 'chip' }, host))])
          : h('div', { class: 'faint', style: { fontSize: '12.5px' } }, 'Nothing yet. Choose "Always allow" when approving a command or website.'),
      ),
    );
    const jobs = runtimeOf(state.activeId).jobs || [];
    if (jobs.length > 0) {
      content.append(
        h(
          'div',
          { class: 'panel-section' },
          h('h4', {}, 'Background commands'),
          jobs.map((job) =>
            h(
              'div',
              { class: 'row', style: { fontSize: '12.5px', marginBottom: '6px' } },
              h('span', { class: `chip${job.running ? ' on' : ''}` }, job.running ? 'running' : `ended (${job.exitCode ?? '?'})`),
              h('span', { class: 'mono ellipsis grow', title: job.command }, job.command),
              job.running ? h('button', { class: 'btn small', onClick: () => api.post(`/api/sessions/${state.activeId}/jobs/${job.id}/stop`).catch(toastError) }, 'Stop') : null,
            ),
          ),
        ),
      );
    }
    content.append(h('button', { class: 'btn small', onClick: () => actions.showSystemPrompt(meta.id) }, h('span', { html: icon('scroll-text', 14) }), 'Show system prompt and tools'));
  }

  /** Reload the open Changes panel. Uncommitted git changes reload only when asked (`withGit`), since each load runs git. */
  const refreshChangesSoon = debounce((withGit = false) => {
    if (panelOpen && panelTab === 'changes' && (withGit || changesSource === 'session')) renderPanel();
  }, 600);

  // ----- Approval prompts -----

  function renderApproval() {
    clear(approvalArea);
    const runtime = runtimeOf(state.activeId);
    const waiting = runtime.waiting;
    transcript.setWaiting(waiting);
    if (!waiting) return;
    if (waiting.kind === 'permission') approvalArea.append(permissionPrompt(waiting));
    else if (waiting.kind === 'question') approvalArea.append(questionPrompt(waiting));
    else if (waiting.kind === 'plan') approvalArea.append(planPrompt(waiting));
    if (stickToBottom) scrollToBottom(false);
  }

  function permissionPrompt(waiting) {
    const feedback = h('input', { class: 'input', placeholder: 'Or tell the agent what to do instead, then press Enter' });
    const deny = () => actions.respond(waiting.id, { decision: 'deny', feedback: feedback.value });
    feedback.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && feedback.value.trim()) deny();
    });
    const bodyElement = h('div', { class: 'approval-body' });
    if (waiting.agent) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('sparkles', 15) }), `Asked by the subagent "${waiting.agent}"`));
    let title;
    let allowLabel = 'Allow';
    let alwaysButton;
    // Options the user sets on the card itself, sent with "allow" (the merge method).
    let choices = () => ({});
    if (waiting.request === 'edit') {
      title = `Allow ${waiting.tool === 'write_file' ? (waiting.preview?.created ? 'creating' : 'overwriting') : 'this edit to'} ${waiting.path}?`;
      if (waiting.outside) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('triangle-alert', 15) }), 'This file is outside the project folder.'));
      if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
      if (waiting.warning) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('shield-alert', 15) }), waiting.warning));
      bodyElement.append(renderDiff(waiting.preview, { emptyText: 'No line changes.' }));
      alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, 'Allow all edits (switch to auto-accept)');
    } else if (waiting.request === 'command') {
      title = 'Run this command?';
      allowLabel = 'Run';
      if (waiting.warning) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('shield-alert', 15) }), waiting.warning));
      if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
      if (waiting.description) bodyElement.append(h('div', { class: 'muted' }, waiting.description));
      bodyElement.append(h('pre', { class: 'command' }, waiting.command));
      if (waiting.input) bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, 'With this input:'), h('pre', { class: 'command' }, waiting.input));
      if (waiting.cwd && waiting.cwd !== '.') bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, `In ${waiting.cwd}`));
      const prefix = h('input', { class: 'input prefix-input', value: waiting.suggestedPrefix || '', title: 'Commands starting with this run without asking' });
      alwaysButton = h(
        'span',
        { class: 'row' },
        h('button', { class: 'btn', title: 'For the rest of this session', onClick: () => actions.respond(waiting.id, { decision: 'allow_session', prefix: prefix.value }) }, 'Allow in session'),
        h('button', { class: 'btn', title: 'In every session of this project, from now on (remove it on the project page)', onClick: () => actions.respond(waiting.id, { decision: 'allow_project', prefix: prefix.value }) }, 'Allow in project'),
        prefix,
      );
    } else if (waiting.request === 'pull_request') {
      title = `Open this pull request on ${waiting.provider === 'azure' ? 'Azure DevOps' : 'GitHub'}?`;
      allowLabel = 'Open';
      bodyElement.append(h('div', { class: 'muted' }, `${waiting.branch} → ${waiting.target || 'the default branch'} in ${waiting.repository}${waiting.draft ? ' (draft)' : ''}. The branch is pushed first.`));
      if (waiting.uncommitted) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('triangle-alert', 15) }), 'There are uncommitted changes. They are not part of the pull request.'));
      bodyElement.append(h('div', { class: 'prose' }, h('p', {}, h('strong', {}, waiting.title))), h('div', { class: 'prose', html: renderMarkdown(waiting.description || '') }));
      alwaysButton = null;
    } else if (waiting.request === 'merge') {
      title = `Merge pull request ${waiting.number} on ${waiting.provider === 'azure' ? 'Azure DevOps' : 'GitHub'}?`;
      allowLabel = 'Merge';
      const methodNames = { squash: 'Squash into one commit', merge: 'Merge commit', rebase: 'Rebase' };
      const methodSelect = h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Merge method' }, waiting.methods.map((method) => h('option', { value: method, selected: method === waiting.method }, methodNames[method] || method)));
      const deleteBox = h('input', { type: 'checkbox', checked: waiting.deleteBranch });
      choices = () => ({ method: methodSelect.value, deleteBranch: deleteBox.checked });
      bodyElement.append(
        h('div', { class: 'prose' }, h('p', {}, h('strong', {}, waiting.title), ' ', h('a', { href: waiting.url, target: '_blank', rel: 'noreferrer' }, 'Open'))),
        h('div', { class: 'muted' }, `${waiting.source} into ${waiting.target} in ${waiting.repository}, at commit ${String(waiting.headSha || '').slice(0, 8)}. Required checks and reviews have passed.`),
        ...(waiting.warnings || []).map((warning) => h('div', { class: 'callout warn' }, h('span', { html: icon('triangle-alert', 15) }), warning)),
        h('div', { class: 'row', style: { marginTop: '8px' } }, methodSelect, h('label', { class: 'row', style: { gap: '6px' } }, deleteBox, `Delete ${waiting.source} afterwards`)),
      );
      alwaysButton = null;
    } else if (waiting.request === 'schedule') {
      const modeName = MODES.find((mode) => mode.id === waiting.mode)?.name || waiting.mode;
      title = waiting.remove ? `Remove the scheduled task "${waiting.name}"?` : `Schedule "${waiting.name}"?`;
      allowLabel = waiting.remove ? 'Remove' : 'Schedule';
      if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
      bodyElement.append(
        h('div', { class: 'muted' }, waiting.remove ? `It runs ${waiting.when}.` : `${waiting.when[0].toUpperCase()}${waiting.when.slice(1)}, ${waiting.here ? 'in this session' : 'in a new session each time'}, while Caliope is open, in ${modeName} mode. The project page lists it.`),
        h('pre', { class: 'command' }, waiting.prompt),
      );
      alwaysButton = null;
    } else if (waiting.request === 'mcp') {
      title = `Let ${waiting.server} run ${waiting.toolName}?`;
      allowLabel = 'Run';
      bodyElement.append(h('div', { class: 'muted' }, `A tool of the MCP server "${waiting.server}". The server does not mark it read-only, so it may change things.`));
      bodyElement.append(h('pre', { class: 'command' }, waiting.input || '{}'));
      alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, `Allow ${waiting.toolName} for this session`);
    } else if (waiting.request === 'browser') {
      title = waiting.action === 'navigate' ? `Let the agent's browser open ${waiting.host || 'this page'}?` : `Let the agent's browser act on ${waiting.host || 'this page'}?`;
      if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
      bodyElement.append(h('pre', { class: 'command' }, waiting.detail || waiting.url || ''));
      bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, waiting.planMode ? 'Plan mode: page actions ask every time, because clicks and typing can change things.' : 'The agent uses its own browser window, with this project\'s profile, not your own browser.'));
      alwaysButton = waiting.planMode || !waiting.host
        ? null
        : h(
            'span',
            { class: 'row' },
            h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, 'Allow site in session'),
            h('button', { class: 'btn', title: `In every session of this project, from now on (remove it on the project page)`, onClick: () => actions.respond(waiting.id, { decision: 'allow_project' }) }, 'Allow site in project'),
          );
    } else if (waiting.query) {
      title = 'Search the web?';
      bodyElement.append(h('pre', { class: 'command' }, waiting.query));
      bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, 'The search terms go to GitHub Copilot\'s web search, or to DuckDuckGo when that isn\'t available.'));
      alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, 'Allow web searches for this session');
    } else {
      title = 'Fetch this web page?';
      if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
      bodyElement.append(h('pre', { class: 'command' }, waiting.url));
      alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, `Allow ${waiting.host || 'this site'} for this session`);
    }
    const allowButton = h('button', { class: 'btn primary', onClick: () => actions.respond(waiting.id, { decision: 'allow', ...choices() }) }, allowLabel, waiting.request === 'merge' ? null : h('kbd', {}, '1'));
    const denyButton = h('button', { class: 'btn danger', onClick: deny }, 'Deny', h('kbd', {}, '3'));
    return h(
      'div',
      { class: 'approval' },
      h('div', { class: 'approval-head' }, h('span', { html: icon('hand', 16) }), h('span', { class: 'grow ellipsis' }, title)),
      bodyElement,
      h('div', { class: 'approval-actions' }, allowButton, alwaysButton, denyButton, feedback),
    );
  }

  function questionPrompt(waiting) {
    const answer = h('input', { class: 'input', placeholder: 'Type your answer and press Enter' });
    const send = (text) => text.trim() && actions.respond(waiting.id, { answer: text.trim() });
    answer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') send(answer.value);
    });
    return h(
      'div',
      { class: 'approval plan' },
      h('div', { class: 'approval-head' }, h('span', { html: icon('message-square', 16) }), h('span', { class: 'grow' }, 'The agent has a question')),
      h('div', { class: 'approval-body' }, h('div', { class: 'prose', html: renderMarkdown(waiting.question || '') }), waiting.options?.length ? h('div', { class: 'option-buttons' }, waiting.options.map((option, index) => h('button', { class: 'btn', onClick: () => send(option) }, option, index < 9 ? h('kbd', {}, String(index + 1)) : null))) : null),
      h('div', { class: 'approval-actions' }, answer, h('button', { class: 'btn primary', onClick: () => send(answer.value) }, 'Send answer')),
    );
  }

  function planPrompt(waiting) {
    const buildModels = state.models.filter((model) => model.protocol && model.toolCalls && model.policyState !== 'disabled');
    const modelSelect = h('select', { class: 'select', style: { width: 'auto' } }, buildModels.map((model) => h('option', { value: model.id }, model.name)));
    modelSelect.value = waiting.buildModel || state.modelDefaults.build || '';
    const effortSelect = h('select', { class: 'select', style: { width: 'auto' } });
    const fillEfforts = () => {
      clear(effortSelect);
      const efforts = modelById(modelSelect.value)?.efforts || [];
      for (const effort of efforts) effortSelect.append(h('option', { value: effort }, effort));
      effortSelect.hidden = efforts.length === 0;
      if (efforts.includes(waiting.buildEffort)) effortSelect.value = waiting.buildEffort;
    };
    fillEfforts();
    modelSelect.addEventListener('change', fillEfforts);
    const modeSelect = h(
      'select',
      { class: 'select', style: { width: 'auto' } },
      h('option', { value: 'auto' }, 'Auto'),
      h('option', { value: 'edits' }, 'Accept edits'),
      h('option', { value: 'ask' }, 'Ask permissions'),
      h('option', { value: 'full' }, 'Full access'),
    );
    // Build in the mode new sessions start in (Settings), unless that is Plan.
    if (['auto', 'edits', 'ask', 'full'].includes(state.settings?.defaultMode)) modeSelect.value = state.settings.defaultMode;
    const feedback = h('textarea', { class: 'textarea', rows: 2, placeholder: 'What should change in the plan? (Ctrl+Enter to send)' });
    const approve = () => actions.respond(waiting.id, { decision: 'approve', mode: modeSelect.value, model: modelSelect.value, effort: effortSelect.hidden ? null : effortSelect.value });
    const revise = () => {
      if (!feedback.value.trim()) {
        feedback.focus();
        toast('Write what should change first.');
        return;
      }
      actions.respond(waiting.id, { decision: 'revise', feedback: feedback.value });
    };
    feedback.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey) revise();
    });
    return h(
      'div',
      { class: 'approval plan' },
      h('div', { class: 'approval-head' }, h('span', { html: icon('map', 16) }), h('span', { class: 'grow' }, 'The plan is ready for your review'), h('button', { class: 'btn ghost small', onClick: () => document.querySelector(`[data-tool-use-id="${waiting.toolUseId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Read the plan')),
      h(
        'div',
        { class: 'approval-body' },
        h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('span', { class: 'muted' }, 'Build with'), modelSelect, effortSelect, h('span', { class: 'muted' }, 'in'), modeSelect, h('span', { class: 'muted' }, 'mode')),
        feedback,
      ),
      h('div', { class: 'approval-actions' }, h('button', { class: 'btn primary', onClick: approve }, h('span', { html: icon('check', 15) }), 'Approve and build'), h('button', { class: 'btn', onClick: revise }, 'Request changes')),
    );
  }

  function onApprovalKeys(event) {
    const waiting = runtimeOf(state.activeId).waiting;
    if (!waiting || event.ctrlKey || event.altKey || event.metaKey) return;
    // Number keys only answer when no text field has focus, so typing "1." in a message never approves anything.
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
    if (waiting.kind === 'permission') {
      // A merge takes a click on the card, with the method and branch choice shown there.
      if (event.key === '1' && waiting.request !== 'merge') {
        event.preventDefault();
        actions.respond(waiting.id, { decision: 'allow' });
      } else if (event.key === '3') {
        event.preventDefault();
        actions.respond(waiting.id, { decision: 'deny' });
      }
    } else if (waiting.kind === 'question' && /^[1-9]$/.test(event.key) && waiting.options?.[Number(event.key) - 1]) {
      event.preventDefault();
      actions.respond(waiting.id, { answer: waiting.options[Number(event.key) - 1] });
    }
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

  function showHelp() {
    openModal({
      title: 'Commands and shortcuts',
      wide: true,
      body: h(
        'div',
        { class: 'stack' },
        h('table', { class: 'data-table' }, h('tbody', {}, SLASH_COMMANDS.map((command) => h('tr', {}, h('td', { class: 'mono' }, `/${command.name}${command.args ? ` ${command.args}` : ''}`), h('td', {}, command.description))))),
        h(
          'table',
          { class: 'data-table' },
          h(
            'tbody',
            {},
            [
              ['Enter / Shift+Enter', 'Send, or while the agent works queue it for when it is done / new line'],
              ['Ctrl+Enter', 'While the agent works: send now, stopping what it is doing'],
              ['Shift+Tab', 'Switch mode: Ask → Accept edits → Auto → Plan'],
              ['Esc', 'Stop the agent'],
              ['1 / 3', 'Allow / deny when the agent asks for permission'],
              ['Ctrl+N', 'New session'],
              ['Ctrl+K', 'Search sessions'],
              ['Ctrl+B', 'Show or hide the sidebar'],
              ['@path', 'Attach a file to your message'],
            ].map(([keys, text]) => h('tr', {}, h('td', {}, h('kbd', {}, keys)), h('td', {}, text))),
          ),
        ),
      ),
      footer: (close) => h('button', { class: 'btn', onClick: () => close() }, 'Close'),
    });
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
    renderApproval();
    renderPanel();
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
    if (panelOpen && panelTab === 'info') renderPanel();
  });
  listen('active:message', (message) => {
    transcript.append(message);
    if (message.role === 'user' && message.kind === 'tool_results') refreshChangesSoon();
  });
  listen('active:message_update', (message) => {
    transcript.update(message);
    refreshChangesSoon();
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
      if (panelOpen && panelTab === 'info') renderPanel();
    }
    transcript.updateStatus(state.active?.runtime);
    if (runtime.state === 'idle') {
      transcript.clearLive();
      refreshChangesSoon(true);
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
    if (panelOpen && panelTab === 'tasks') renderPanel();
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
      browserView.destroy();
      transcript.destroy();
      root.remove();
    },
  };
}

function iconButton(iconName, title, onClick) {
  return h('button', { class: 'btn ghost small icon-only', type: 'button', title, 'aria-label': title, html: icon(iconName, 15), onClick });
}
