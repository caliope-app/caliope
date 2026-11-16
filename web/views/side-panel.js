// The session's side panel: tasks, changed files, the approved plan, the agent's browser, and what the session cost.
import { h, clear, formatCost, formatTokens, debounce, relativeTime, pluralize } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { state, runtimeOf, modelById, modelLabel, loadPreference, savePreference } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { todoList } from './transcript.js';
import { MODES } from './composer.js';
import { renderDiff, diffStat } from './diff-view.js';
import { toastError } from './dialogs.js';
import { BrowserView } from './browser-view.js';

const TABS = [
  ['tasks', 'Tasks', 'list-todo'],
  ['changes', 'Changes', 'file-pen'],
  ['plan', 'Plan', 'map'],
  ['browser', 'Browser', 'globe'],
  ['info', 'Info', 'coins'],
];

export class SidePanel {
  /** - `onToggle()`: called when the panel opens, closes or switches tab, so the header can mark its button. */
  constructor({ onToggle }) {
    this.onToggle = onToggle;
    this.tab = loadPreference('panelTab', 'tasks');
    this.isOpen = loadPreference('panelOpen', false);
    this.changesSource = loadPreference('changesSource', 'session');
    this.expandedChanges = new Set();
    this.element = h('aside', { class: 'side-panel', hidden: true, 'aria-label': 'Session panel' });
    this.resizer = h('div', { class: 'resizer panel-resizer', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize', hidden: true });
    // Kept across panel renders, so its live stream only restarts when the session changes.
    this.browserView = new BrowserView({ onPageChange: () => this.applyWidth() });
    /** Reload the open Changes panel. Uncommitted git changes reload only when asked (`withGit`), since each load runs git. */
    this.refreshChangesSoon = debounce((withGit = false) => {
      if (this.showing('changes') && (withGit || this.changesSource === 'session')) this.render();
    }, 600);

    this.resizer.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.resizer.classList.add('dragging');
      const body = this.element.parentElement;
      const widthAt = (clientX) => Math.min(body.getBoundingClientRect().right - clientX, body.clientWidth - 380);
      const onMove = (moveEvent) => this.applyWidth(widthAt(moveEvent.clientX));
      const onUp = (upEvent) => {
        this.resizer.classList.remove('dragging');
        savePreference(this.widthKey(), this.applyWidth(widthAt(upEvent.clientX)));
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    this.resizer.addEventListener('dblclick', () => savePreference(this.widthKey(), this.applyWidth(this.defaultWidth(this.widthKey()))));
  }

  showing(tab) {
    return this.isOpen && this.tab === tab;
  }

  open(tab) {
    this.tab = tab;
    this.isOpen = true;
    savePreference('panelTab', tab);
    savePreference('panelOpen', true);
    this.render();
    this.onToggle();
  }

  close() {
    this.isOpen = false;
    savePreference('panelOpen', false);
    this.render();
    this.onToggle();
  }

  // The panel's width, dragged by the user: one for a Browser panel that shows a page (by default all but 440
  // pixels for the transcript, at least half), one for everything else. The transcript keeps at least 380 pixels.
  widthKey() {
    const key = this.tab === 'browser' && this.browserView.state.hasPage ? 'browserPanelWidth' : 'panelWidth';
    return key;
  }

  defaultWidth(key) {
    const body = this.element.parentElement;
    const width = key === 'browserPanelWidth' ? Math.round(Math.max(body.clientWidth / 2, body.clientWidth - 440)) : 360;
    return width;
  }

  applyWidth(width = null) {
    const key = this.widthKey();
    const chosen = Math.round(Math.max(280, width ?? loadPreference(key, this.defaultWidth(key))));
    this.element.style.width = `${chosen}px`;
    return chosen;
  }

  render() {
    const panel = this.element;
    panel.hidden = !this.isOpen;
    this.resizer.hidden = !this.isOpen;
    if (!(this.isOpen && this.tab === 'browser' && state.active)) this.browserView.hide();
    if (!this.isOpen || !state.active) return;
    this.applyWidth();
    clear(panel);
    // Only the open tab shows its name, so the tabs and the close button fit the narrowest panel. Tab reaches the
    // open tab, and the Left and Right arrows open the one next to it.
    const tabs = h('div', { class: 'side-panel-tabs', role: 'tablist' });
    for (const [tab, label, iconName] of TABS) {
      const selected = this.tab === tab;
      tabs.append(h('button', { class: selected ? 'active' : '', type: 'button', role: 'tab', id: `panel-tab-${tab}`, 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', title: label, 'aria-label': label, onClick: () => this.open(tab) }, h('span', { html: icon(iconName, 14) }), selected ? h('span', {}, label) : null));
    }
    tabs.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = TABS.findIndex(([tab]) => tab === this.tab);
      const [next] = TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
      this.open(next);
      this.element.querySelector(`#panel-tab-${next}`)?.focus();
    });
    const content = h('div', { class: 'side-panel-body', role: 'tabpanel', 'aria-labelledby': `panel-tab-${this.tab}` });
    panel.append(h('div', { class: 'side-panel-head' }, tabs, iconButton('x', 'Close panel', () => this.close())), content);
    if (this.tab === 'tasks') content.append(todoList(state.active.todos || []));
    else if (this.tab === 'plan') {
      content.append(state.active.plan ? h('div', { class: 'prose', html: renderMarkdown(state.active.plan) }) : h('div', { class: 'faint' }, 'No approved plan yet. Use Plan mode (Shift+Tab or /plan) to have the planning model write one.'));
    } else if (this.tab === 'changes') this.renderChanges(content);
    else if (this.tab === 'browser') {
      content.append(this.browserView.element);
      this.browserView.show(state.activeId, lastBrowserPage(state.active));
    } else this.renderInfo(content);
  }

  /** Changes panel: the files the agent changed in this session, or everything uncommitted in git. */
  async renderChanges(content) {
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
            class: this.changesSource === source ? 'active' : '',
            type: 'button',
            onClick: () => {
              this.changesSource = source;
              savePreference('changesSource', source);
              this.render();
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
      if (this.changesSource === 'git') {
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
      const key = `${this.changesSource}:${change.path}`;
      const diffContainer = h('div', { hidden: true });
      const head = h(
        'div',
        { class: 'change-file-head', title: change.path, role: 'button', tabindex: '0', 'aria-expanded': 'false' },
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
        head.setAttribute('aria-expanded', String(open));
        if (open) this.expandedChanges.add(key);
        else this.expandedChanges.delete(key);
      };
      head.addEventListener('click', () => toggle(diffContainer.hidden));
      head.addEventListener('keydown', (event) => {
        if (event.target === head && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          toggle(diffContainer.hidden);
        }
      });
      if (this.expandedChanges.has(key)) toggle(true);
      list.append(h('div', { class: 'change-file' }, head, diffContainer));
    }
  }

  renderInfo(content) {
    const meta = state.active.meta;
    const usage = meta.usage || {};
    const model = modelById(meta.model);
    const rows = (pairs) => h('dl', { class: 'kv' }, pairs.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value)]));
    // Background commands come first: the "running" chip in the header opens this tab to show them.
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
          rows(byModel.sort((a, b) => b[1].nanoAiu - a[1].nanoAiu).map(([id, entry]) => [modelLabel(id), `${formatCost(entry.nanoAiu, state.settings?.costUnit)} · ${pluralize(entry.requests, 'request')}`])),
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
          ['Created', new Date(meta.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })],
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
          : h('div', { class: 'faint', style: { fontSize: '12.5px' } }, 'Nothing yet. An "Allow … in session" button on a command or website approval adds it here.'),
      ),
    );
    content.append(h('button', { class: 'btn small', onClick: () => actions.showSystemPrompt(meta.id) }, h('span', { html: icon('scroll-text', 14) }), 'Show system prompt and tools'));
  }

  destroy() {
    this.browserView.destroy();
  }
}

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

function iconButton(iconName, title, onClick) {
  return h('button', { class: 'btn ghost small icon-only', type: 'button', title, 'aria-label': title, html: icon(iconName, 15), onClick });
}
