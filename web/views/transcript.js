// The conversation: messages, thinking, tool cards, events, and the live (streaming) response.
import { h, clear, formatTokens, formatCost, copyText, pluralize, onNextFrame } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/markdown.js';
import { state, modelLabel } from '../lib/store.js';
import { renderDiff, diffStat } from './diff-view.js';
import { toast } from './dialogs.js';
import { MODES } from './composer.js';

const TOOL_ICONS = {
  read_file: 'file-text',
  list_dir: 'folder-tree',
  glob: 'files',
  grep: 'text-search',
  edit_file: 'file-pen',
  write_file: 'file-plus',
  run_command: 'terminal',
  web_fetch: 'globe',
  web_search: 'search',
  notebook_edit: 'file-pen',
  list_pull_requests: 'git-pull-request',
  browser: 'monitor',
  todo_write: 'list-todo',
  ask_user: 'message-square',
  present_plan: 'map',
  run_agent: 'sparkles',
  create_pull_request: 'git-branch',
  merge_pull_request: 'git-branch',
  schedule: 'history',
  search_sessions: 'text-search',
  read_session: 'history',
  command_output: 'terminal',
  use_skill: 'scroll-text',
};

const MODE_NAMES = Object.fromEntries(MODES.map((mode) => [mode.id, mode.name]));

export class Transcript {
  constructor({ onRewind, onFork, onRetry, onContinue, onSignIn, onOpenProject, onContentChange }) {
    this.handlers = { onRewind, onFork, onRetry, onContinue, onSignIn, onOpenProject };
    this.onContentChange = onContentChange || (() => {});
    this.element = h('div', { class: 'transcript' });
    this.messagesElement = h('div');
    this.liveElement = null;
    this.statusElement = h('div', { class: 'status-line', hidden: true });
    this.element.append(this.messagesElement, this.statusElement);
    this.toolCards = new Map();
    this.liveFrame = null;
    this.statusTimer = null;
  }

  /** Render a whole session. */
  setSession(active) {
    clear(this.messagesElement);
    this.toolCards.clear();
    this.liveElement = null;
    const messages = active.messages;
    if (messages.length === 0) {
      this.messagesElement.append(
        h('div', { class: 'empty-transcript' }, h('div', { html: icon('sparkles', 28) }), h('p', {}, 'Describe what you want to build or change. Mention files with @path.')),
      );
    }
    for (const message of messages) this.renderMessage(message);
    for (const [toolUseId, run] of Object.entries(active.runtime?.toolRuns || {})) {
      const card = this.toolCards.get(toolUseId);
      if (card) {
        card.setRunning();
        card.appendOutput(run.output || '');
      }
    }
    if (active.runtime?.live) this.renderLive(active.runtime.live);
    this.setWaiting(active.runtime?.waiting || null);
    this.updateStatus(active.runtime);
    this.onContentChange();
  }

  append(message) {
    this.messagesElement.querySelector('.empty-transcript')?.remove();
    if (message.role === 'assistant') {
      // The final message replaces the streamed preview. Drop a preview render that is still queued.
      this.liveFrame?.cancel();
      this.liveFrame = null;
      this.clearLive();
    }
    this.renderMessage(message);
    this.onContentChange();
  }

  update(message) {
    if (message.role === 'user' && message.kind === 'tool_results') this.applyResults(message);
    this.onContentChange();
  }

  renderMessage(message) {
    if (message.role === 'event') {
      const element = this.renderEvent(message);
      if (element) this.messagesElement.append(element);
      return;
    }
    if (message.role === 'user') {
      if (message.kind === 'tool_results') {
        this.applyResults(message);
        return;
      }
      if (message.kind === 'compact_summary') {
        this.messagesElement.append(
          h(
            'details',
            { class: 'compact-card' },
            h('summary', {}, h('span', { html: icon('layers', 14) }), ' Earlier conversation compacted into a summary (click to read)'),
            h('div', { class: 'prose', html: renderMarkdown(message.summary || '') }),
          ),
        );
        return;
      }
      const element = this.renderUserPrompt(message);
      if (element) this.messagesElement.append(element);
      return;
    }
    this.messagesElement.append(this.renderAssistant(message));
  }

  renderUserPrompt(message) {
    const visibleText = message.content
      .filter((block) => block.type === 'text' && !block.hidden)
      .map((block) => block.text)
      .join('\n\n');
    const images = message.content.filter((block) => block.type === 'image');
    if (!visibleText && images.length === 0) return null;
    const attachmentBlock = message.content.find((block) => block.attachment);
    const attached = attachmentBlock ? [...attachmentBlock.text.matchAll(/<file path="([^"]+)">/g)].map((match) => match[1]) : [];
    const bubble = h(
      'div',
      { class: 'user-bubble' },
      visibleText,
      images.length ? h('div', { class: 'attachments' }, images.map((image) => h('img', { src: `data:${image.mediaType};base64,${image.data}`, alt: 'Attached image' }))) : null,
      attached.length ? h('div', { class: 'faint', style: { fontSize: '12px', marginTop: '4px' } }, `Attached: ${attached.join(', ')}`) : null,
    );
    const actions = h('div', { class: 'msg-actions' });
    actions.append(actionButton('copy', 'Copy', () => copyText(visibleText).then(() => toast('Copied.'))));
    if (!message.auto) {
      actions.append(actionButton('rotate-ccw', 'Rewind to here: edit and resend this message (optionally restoring files)', () => this.handlers.onRewind(message.id)));
      actions.append(actionButton('git-fork', 'Fork a new session from before this message', () => this.handlers.onFork(message.id)));
    }
    const label = message.scheduled ? `Scheduled task "${message.scheduled}"` : message.interjection ? 'Sent while the agent was working' : null;
    const wrapper = h('div', { class: 'msg user', dataset: { id: message.id } }, actions, h('div', { class: 'user-column' }, label ? h('div', { class: 'interjection-label' }, label) : null, bubble));
    return wrapper;
  }

  renderAssistant(message) {
    const element = h('div', { class: 'msg assistant', dataset: { id: message.id } });
    const texts = [];
    for (const block of message.content) {
      if (block.type === 'compaction') {
        element.append(compactionCard(block));
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        element.append(thinkingDetails(block.thinking));
      } else if (block.type === 'text' && block.text) {
        texts.push(block.text);
        element.append(h('div', { class: 'prose', html: renderMarkdown(block.text) }));
      } else if (block.type === 'tool_use') {
        const card = new ToolCard(block);
        this.toolCards.set(block.id, card);
        element.append(card.element);
      }
    }
    if (message.interrupted) element.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, '(stopped)'));
    const usage = message.usage;
    const detail = [
      modelLabel(message.model),
      message.effort ? `effort ${message.effort}` : null,
      usage ? `${formatTokens((usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0))} in (${formatTokens(usage.cacheRead || 0)} cached) / ${formatTokens(usage.output || 0)} out` : null,
      usage ? `cost ${typeof usage.nanoAiu === 'number' ? formatCost(usage.nanoAiu, state.settings?.costUnit) : 'not reported'}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const actions = h('div', { class: 'msg-actions' });
    if (texts.length) actions.append(actionButton('copy', 'Copy answer', () => copyText(texts.join('\n\n')).then(() => toast('Copied.'))));
    actions.append(h('span', { class: 'btn ghost small icon-only', title: detail, html: icon('info', 14) }));
    element.prepend(actions);
    return element;
  }

  renderEvent(message) {
    const time = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    switch (message.kind) {
      case 'error': {
        const box = h('div', { class: 'event-error-box' }, h('span', { html: icon('circle-alert', 16) }), h('div', { class: 'grow' }, h('div', {}, message.text), h('div', { class: 'faint', style: { fontSize: '11.5px' } }, time)));
        if (message.auth) box.append(h('button', { class: 'btn small', onClick: () => this.handlers.onSignIn() }, 'Sign in'));
        if (message.limitProject) box.append(h('button', { class: 'btn small', onClick: () => this.handlers.onOpenProject(message.limitProject) }, 'Open project'));
        if (!message.auth && message.retryable) box.append(h('button', { class: 'btn small', onClick: () => this.handlers.onRetry() }, h('span', { html: icon('refresh-cw', 13) }), 'Retry'));
        return box;
      }
      case 'notice':
        return h('div', { class: 'notice-line' }, h('span', { html: icon('triangle-alert', 14) }), message.text);
      case 'mode':
        return h('div', { class: 'event' }, `${MODE_NAMES[message.mode] || message.mode} · ${modelLabel(message.model)}${message.effort ? ` · ${message.effort}` : ''} · ${time}`);
      case 'model':
        return h('div', { class: 'event' }, `Model: ${modelLabel(message.model)}${message.effort ? ` · ${message.effort}` : ''} · ${time}`);
      case 'compact':
        return h('div', { class: 'event' }, `${message.text} · ${time}`);
      case 'interrupted':
        // A message that interrupted the agent is the next line, so there is nothing to continue.
        if (message.byMessage) return h('div', { class: 'event' }, `Interrupted by your message · ${time}`);
        // Continue only shows while this is the last line of the conversation (see styles.css).
        return h('div', { class: 'event stopped' }, `Stopped · ${time}`, h('button', { class: 'btn small', type: 'button', title: 'Let the agent go on where it stopped', onClick: () => this.handlers.onContinue() }, 'Continue'));
      default:
        return message.text ? h('div', { class: 'event' }, message.text) : null;
    }
  }

  applyResults(message) {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      this.toolCards.get(block.tool_use_id)?.setResult(block);
    }
  }

  // ----- Live response -----

  live(kind) {
    const live = state.active?.runtime?.live;
    if (kind === 'start') {
      this.liveElement?.remove();
      this.liveElement = null;
    }
    if (!live) return;
    if (this.liveFrame) return;
    this.liveFrame = onNextFrame(() => {
      this.liveFrame = null;
      this.renderLive(state.active?.runtime?.live);
    });
  }

  renderLive(live) {
    if (!live) return;
    if (!this.liveElement) {
      this.messagesElement.querySelector('.empty-transcript')?.remove();
      this.liveElement = h('div', { class: 'msg assistant live' });
      this.messagesElement.append(this.liveElement);
    }
    clear(this.liveElement);
    const blocks = live.blocks.filter(Boolean);
    for (const block of blocks) {
      if (block.type === 'thinking') {
        if (!block.done) {
          this.liveElement.append(h('div', { class: 'thinking-live' }, h('span', { html: icon('brain', 14) }), h('span', { class: 'shimmer' }, 'Thinking…')));
          if (block.text.trim()) this.liveElement.append(h('div', { class: 'thinking' }, h('div', { class: 'thinking-body' }, lastLines(block.text, 6))));
        } else if (block.text.trim()) {
          this.liveElement.append(thinkingDetails(block.text));
        }
      } else if (block.type === 'text') {
        this.liveElement.append(h('div', { class: 'prose', html: renderMarkdown(block.text) }));
      } else if (block.type === 'tool_use') {
        const preview = new ToolCard({ id: block.id, name: block.name, input: block.input || {} }, { preparing: !block.done, inputLength: block.inputLength });
        this.liveElement.append(preview.element);
      }
    }
    if (blocks.length === 0) {
      this.liveElement.append(h('div', { class: 'thinking-live' }, h('span', { html: icon('brain', 14) }), h('span', { class: 'shimmer' }, 'Thinking…')));
    }
    this.onContentChange();
  }

  clearLive() {
    this.liveElement?.remove();
    this.liveElement = null;
  }

  // ----- Tools -----

  tool(event) {
    const card = this.toolCards.get(event.toolUseId);
    if (!card) return;
    if (event.kind === 'start') card.setRunning();
    if (event.kind === 'output') card.appendOutput(event.text);
    this.onContentChange();
  }

  setWaiting(waiting) {
    for (const card of this.toolCards.values()) card.setWaiting(false);
    if (waiting?.toolUseId) this.toolCards.get(waiting.toolUseId)?.setWaiting(true, waiting.kind);
  }

  updateStatus(runtime) {
    clearInterval(this.statusTimer);
    const status = runtime?.status;
    if (!runtime || runtime.state !== 'running' || !status || status.phase === 'streaming' || status.phase === 'waiting_user') {
      this.statusElement.hidden = true;
      return;
    }
    const render = () => {
      const seconds = Math.max(0, Math.round((Date.now() - (status.since || Date.now())) / 1000));
      let text = 'Working…';
      if (status.phase === 'waiting_model') text = 'Thinking…';
      else if (status.phase === 'running_tool') text = 'Running…';
      else if (status.phase === 'compacting') text = 'Compacting the conversation to free up context…';
      else if (status.phase === 'retrying') {
        const left = Math.max(0, Math.round(((status.detail?.waitMs || 0) - (Date.now() - status.since)) / 1000));
        text = `Copilot did not answer (${status.detail?.reason || 'error'}). Retrying${left ? ` in ${left} s` : ''} (attempt ${status.detail?.attempt || 1})…`;
      }
      clear(this.statusElement).append(h('span', { class: 'spin', html: icon('loader-circle', 14) }), h('span', { class: status.phase === 'retrying' ? 'warning-text' : 'shimmer' }, text));
      if (seconds > 2) this.statusElement.append(h('span', { class: 'faint' }, `${seconds} s`));
    };
    this.statusElement.hidden = false;
    render();
    this.statusTimer = setInterval(render, 1000);
    if (this.liveElement) this.messagesElement.append(this.liveElement);
  }

  destroy() {
    clearInterval(this.statusTimer);
    this.liveFrame?.cancel();
  }
}

/** A compaction the model did itself: Claude's summary can be read; OpenAI keeps its summary encrypted. */
function compactionCard(block) {
  if (!block.content) return h('div', { class: 'event' }, h('span', { html: icon('layers', 13) }), ' Earlier conversation compacted by the model. OpenAI keeps this summary encrypted, so it cannot be shown.');
  const card = h('details', { class: 'compact-card' }, h('summary', {}, h('span', { html: icon('layers', 14) }), ' Earlier conversation compacted into a summary (click to read)'), h('div', { class: 'prose', html: renderMarkdown(block.content) }));
  return card;
}

function thinkingDetails(text) {
  return h('details', { class: 'thinking' }, h('summary', {}, h('span', { html: icon('brain', 14) }), 'Thought process'), h('div', { class: 'thinking-body' }, text));
}

function lastLines(text, count) {
  const lines = text.trim().split('\n');
  return lines.slice(-count).join('\n');
}

function actionButton(iconName, title, onClick) {
  return h('button', { class: 'btn ghost small icon-only', type: 'button', title, 'aria-label': title, html: icon(iconName, 14), onClick });
}

/** Short description of a tool call for the card header. */
function describe(toolUse) {
  const input = toolUse.input || {};
  switch (toolUse.name) {
    case 'read_file':
      return { verb: 'Read', target: input.path, code: true, extra: input.offset ? `from line ${input.offset}` : '' };
    case 'list_dir':
      return { verb: 'List', target: input.path || '.', code: true };
    case 'glob':
      return { verb: 'Find files', target: input.pattern, code: true, extra: input.path ? `in ${input.path}` : '' };
    case 'grep':
      return { verb: 'Search', target: input.pattern, code: true, extra: [input.glob ? `in ${input.glob}` : '', input.path ? `under ${input.path}` : ''].filter(Boolean).join(' ') };
    case 'edit_file':
      return { verb: 'Edit', target: input.path, code: true };
    case 'write_file':
      return { verb: 'Write', target: input.path, code: true };
    case 'run_command':
      return { verb: input.background ? 'Start' : 'Run', target: String(input.command || '').split('\n')[0], code: true, extra: input.description || '' };
    case 'command_output':
      return { verb: input.stop ? 'Stop job' : 'Check job', target: input.job || '', code: true };
    case 'web_fetch':
      return { verb: 'Fetch', target: input.url, code: false };
    case 'web_search':
      return { verb: 'Search the web', target: input.query, code: false };
    case 'notebook_edit':
      return { verb: { insert: 'Add cell', delete: 'Delete cell' }[input.edit_mode] || 'Edit cell', target: input.path, code: true, extra: input.cell_id ? `cell ${input.cell_id}` : '' };
    case 'list_pull_requests':
      return { verb: 'List pull requests', target: '', code: false };
    case 'browser': {
      const verbs = { navigate: 'Open', read: 'Read page', screenshot: 'Screenshot', click: 'Click', type: 'Type', press: 'Press', scroll: 'Scroll', back: 'Back', forward: 'Forward', wait: 'Wait', javascript: 'Run JavaScript', console: 'Console', network: 'Network', batch: 'Steps' };
      let target = '';
      if (input.action === 'navigate') target = input.url;
      else if (input.action === 'batch') target = (Array.isArray(input.steps) ? input.steps : []).map((step) => verbs[step?.action] || step?.action).join(', ');
      else if (input.action === 'click') target = input.ref ? `element [${input.ref}]` : `(${input.x}, ${input.y})`;
      else if (input.action === 'type') target = `"${String(input.text || '').slice(0, 60)}"${input.ref ? ` into [${input.ref}]` : ''}`;
      else if (input.action === 'press') target = input.key;
      else if (input.action === 'scroll') target = input.direction || 'down';
      return { verb: `Browser · ${verbs[input.action] || input.action}`, target, code: input.action === 'navigate' };
    }
    case 'todo_write': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return { verb: 'Tasks', target: `${todos.filter((todo) => todo.status === 'completed').length} of ${todos.length} done`, code: false };
    }
    case 'ask_user':
      return { verb: 'Question', target: input.question, code: false };
    case 'present_plan':
      return { verb: 'Implementation plan', target: '', code: false };
    case 'run_agent':
      return { verb: 'Subagent', target: input.description || '', code: false, extra: [input.model, input.tools === 'write' ? 'can edit' : input.tools === 'web' ? 'web' : ''].filter(Boolean).join(' · ') };
    case 'use_skill':
      return { verb: 'Skill', target: input.name, code: true };
    case 'create_pull_request':
      return { verb: 'Pull request', target: input.title, code: false, extra: input.target_branch ? `into ${input.target_branch}` : '' };
    case 'merge_pull_request':
      return { verb: 'Merge', target: input.number ? `pull request ${input.number}` : 'the pull request for this branch', code: false };
    case 'schedule':
      return { verb: input.action === 'delete' ? 'Unschedule' : input.action === 'list' ? 'Scheduled tasks' : 'Schedule', target: input.name || input.id || '', code: false };
    case 'search_sessions':
      return { verb: 'Search sessions', target: input.query, code: false, extra: '' };
    case 'read_session':
      return { verb: 'Read session', target: input.id, code: true };
    default: {
      // MCP tools are named mcp__<server>__<tool>.
      const [prefix, server, ...rest] = toolUse.name.split('__');
      if (prefix === 'mcp' && rest.length) return { verb: server, target: rest.join('__'), code: true };
      return { verb: toolUse.name, target: '', code: false };
    }
  }
}

class ToolCard {
  constructor(toolUse, { preparing = false, inputLength = 0 } = {}) {
    this.toolUse = toolUse;
    this.result = null;
    this.output = '';
    this.state = preparing ? 'preparing' : 'pending';
    const info = describe(toolUse);
    this.stateElement = h('span', { class: 'tool-state' });
    this.detailElement = h('span', { class: 'detail' });
    const label = h('span', { class: 'label' }, h('span', { class: 'verb' }, info.verb), info.target ? (info.code ? h('code', {}, info.target) : h('span', {}, info.target)) : null, info.extra ? h('span', { class: 'faint' }, ` ${info.extra}`) : null);
    this.head = h(
      'div',
      { class: 'tool-head', role: 'button', tabindex: '0', title: info.target || info.verb },
      h('span', { class: 'tool-icon', html: icon(TOOL_ICONS[toolUse.name] || 'zap', 15) }),
      label,
      this.detailElement,
      this.stateElement,
      h('span', { class: 'chev', html: icon('chevron-right', 14) }),
    );
    this.body = h('div', { class: 'tool-body' });
    this.element = h('div', { class: `tool${toolUse.name === 'present_plan' ? ' plan-card' : ''}`, dataset: { toolUseId: toolUse.id } }, this.head, this.body);
    this.head.addEventListener('click', () => this.toggle());
    this.head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.toggle();
      }
    });
    if (preparing) {
      this.stateElement.innerHTML = icon('loader-circle', 14, 'spin');
      this.stateElement.className = 'tool-state running';
      if (inputLength > 200) this.detailElement.textContent = `writing ${(inputLength / 1024).toFixed(1)} KB`;
    }
    this.renderBody();
    if (['present_plan', 'ask_user'].includes(toolUse.name) || (toolUse.name === 'browser' && toolUse.input?.action === 'screenshot')) this.element.classList.add('open');
  }

  toggle() {
    this.element.classList.toggle('open');
  }

  setRunning() {
    this.state = 'running';
    this.stateElement.className = 'tool-state running';
    this.stateElement.innerHTML = icon('loader-circle', 14, 'spin');
    if (this.toolUse.name === 'run_command' || this.toolUse.name === 'run_agent') this.element.classList.add('open');
    this.renderBody();
  }

  setWaiting(waiting, kind) {
    this.element.classList.toggle('status-waiting', waiting);
    if (waiting) {
      this.stateElement.className = 'tool-state waiting';
      this.stateElement.innerHTML = icon('hand', 14);
      this.detailElement.textContent = kind === 'plan' ? 'waiting for your review' : kind === 'question' ? 'waiting for your answer' : 'waiting for approval';
    } else if (this.state === 'running' || this.state === 'pending') {
      if (this.detailElement.textContent.startsWith('waiting')) this.detailElement.textContent = '';
    }
  }

  appendOutput(text) {
    if (!text) return;
    this.output += text;
    if (this.output.length > 200000) this.output = this.output.slice(-200000);
    if (this.outputElement) {
      const nearBottom = this.outputElement.scrollHeight - this.outputElement.scrollTop - this.outputElement.clientHeight < 40;
      this.outputElement.textContent = this.output;
      this.outputElement.hidden = false;
      if (nearBottom) this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }
  }

  setResult(block) {
    this.result = block;
    const meta = block.meta || {};
    let status = block.is_error ? 'error' : 'ok';
    if (meta.denied) status = 'denied';
    this.state = status;
    this.element.classList.toggle('status-error', status === 'error');
    this.element.classList.remove('status-waiting');
    this.stateElement.className = `tool-state ${status}`;
    this.stateElement.innerHTML = icon(status === 'ok' ? 'check' : status === 'denied' ? 'shield-alert' : 'x', 14);
    this.stateElement.title = status === 'denied' ? 'Denied' : status === 'error' ? 'Failed' : 'Done';
    this.detailElement.textContent = '';
    this.detailElement.append(this.resultDetail(block));
    if (status === 'error' && !meta.notRun && !meta.denied && this.toolUse.name !== 'run_command') this.element.classList.add('open');
    if ((this.toolUse.name === 'run_command' || this.toolUse.name === 'run_agent') && status === 'ok') this.element.classList.remove('open');
    if ((this.toolUse.name === 'edit_file' || this.toolUse.name === 'write_file') && status === 'ok') {
      const changed = (meta.added || 0) + (meta.removed || 0);
      if (changed > 0 && changed <= 40) this.element.classList.add('open');
    }
    this.renderBody();
  }

  resultDetail(block) {
    const meta = block.meta || {};
    const fragment = document.createDocumentFragment();
    if (meta.denied) {
      fragment.append('denied');
      return fragment;
    }
    if (meta.notRun) {
      fragment.append('not run');
      return fragment;
    }
    switch (this.toolUse.name) {
      case 'read_file':
        if (meta.totalLines !== undefined && meta.startLine) fragment.append(`lines ${meta.startLine}–${meta.endLine} of ${meta.totalLines}`);
        else if (meta.image) fragment.append('image');
        break;
      case 'edit_file':
      case 'write_file':
        if (meta.hunks) {
          if (meta.created) fragment.append('new file · ');
          fragment.append(diffStat(meta.added || 0, meta.removed || 0));
        }
        break;
      case 'run_command':
      case 'command_output':
        if (meta.timedOut) fragment.append('timed out');
        else if (meta.interrupted) fragment.append('stopped');
        else if (meta.running) fragment.append('running in the background');
        else if (meta.exitCode !== undefined && meta.exitCode !== null) fragment.append(meta.durationMs ? `exit ${meta.exitCode} · ${(meta.durationMs / 1000).toFixed(1)} s` : `exit ${meta.exitCode}`);
        break;
      case 'grep':
        if (meta.matches !== undefined) fragment.append(`${pluralize(meta.matches, 'match', 'matches')} in ${pluralize(meta.files, 'file')}`);
        break;
      case 'glob':
        if (meta.count !== undefined) fragment.append(pluralize(meta.count, 'file'));
        break;
      case 'list_dir':
        if (meta.count !== undefined) fragment.append(pluralize(meta.count, 'entry', 'entries'));
        break;
      case 'web_fetch':
        if (meta.status) fragment.append(`HTTP ${meta.status}`);
        break;
      case 'browser':
        if (meta.url) {
          try {
            fragment.append(new URL(meta.url).host || meta.url);
          } catch {
            fragment.append(meta.url);
          }
        }
        break;
      case 'present_plan':
        if (meta.approved) fragment.append(`approved · building with ${modelLabel(meta.model)}${meta.effort ? ` (${meta.effort})` : ''}`);
        else if (meta.approved === false) fragment.append('changes requested');
        break;
      case 'run_agent':
        if (meta.model) fragment.append(`${modelLabel(meta.model)} · ${pluralize(meta.trace?.length || 0, 'tool call')}${typeof meta.nanoAiu === 'number' ? ` · ${formatCost(meta.nanoAiu, state.settings?.costUnit)}` : ''}`);
        break;
      default:
        break;
    }
    return fragment;
  }

  renderBody() {
    clear(this.body);
    this.outputElement = null;
    const input = this.toolUse.input || {};
    const result = this.result;
    const meta = result?.meta || {};
    const resultText = typeof result?.content === 'string' ? result.content : (result?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    switch (this.toolUse.name) {
      case 'run_command': {
        const header = h('pre', { class: 'mono', style: { borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' } }, `> ${input.command || ''}${input.cwd ? `\n(in ${input.cwd})` : ''}`);
        this.body.append(header);
        const text = result ? (meta.output !== undefined ? meta.output : resultText) : this.output;
        // Hidden until there is output: a command waiting for approval has none yet.
        this.outputElement = h('pre', { hidden: !text && !result }, text || (result ? '(no output)' : ''));
        this.body.append(this.outputElement);
        if (result && result.is_error && meta.output === undefined) this.outputElement.classList.add('danger-text');
        return;
      }
      case 'edit_file':
      case 'write_file': {
        if (result && !result.is_error && meta.hunks) {
          this.body.append(renderDiff(meta, { emptyText: 'No line changes.' }));
          for (const hook of meta.hooks || []) this.body.append(h('pre', { class: `mono${hook.exitCode === 0 ? ' faint' : ' warning-text'}`, style: { borderTop: '1px solid var(--border)' } }, `hook> ${hook.command} (exit ${hook.exitCode ?? '?'})\n${hook.output || '(no output)'}`));
        } else if (result) {
          this.body.append(h('div', { class: 'tool-error-text' }, resultText));
        } else if (this.toolUse.name === 'edit_file') {
          this.body.append(renderDiff(simpleDiff(input.old_string || '', input.new_string || '')));
        } else {
          this.body.append(h('pre', {}, String(input.content || '').slice(0, 20000)));
        }
        return;
      }
      case 'todo_write': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        this.body.append(todoList(todos));
        return;
      }
      case 'ask_user': {
        const options = Array.isArray(input.options) ? input.options : [];
        this.body.append(
          h(
            'div',
            { class: 'prose' },
            h('p', {}, input.question || ''),
            options.length ? h('ul', {}, options.map((option) => h('li', {}, option))) : null,
            meta.answer ? h('p', {}, h('strong', {}, 'Your answer: '), meta.answer) : null,
          ),
        );
        return;
      }
      case 'present_plan': {
        this.body.append(h('div', { class: 'prose', html: renderMarkdown(input.plan || '') }));
        if (meta.approved === false && meta.feedback) this.body.append(h('div', { class: 'prose' }, h('p', { class: 'warning-text' }, `Your feedback: ${meta.feedback}`)));
        return;
      }
      case 'run_agent': {
        // The brief, what the subagent did (live while it runs), and its report.
        this.body.append(h('details', { class: 'agent-brief' }, h('summary', {}, 'Brief'), h('div', { class: 'prose', html: renderMarkdown(String(input.prompt || '')) })));
        if (!result) {
          this.outputElement = h('pre', { class: 'agent-progress' }, this.output || 'Starting…');
          this.body.append(this.outputElement);
          return;
        }
        const trace = meta.trace || [];
        if (trace.length) this.body.append(h('ul', { class: 'agent-trace' }, trace.map((step) => h('li', { class: step.error ? 'danger-text' : '' }, h('code', {}, step.tool), step.target ? ` ${step.target}` : ''))));
        const report = meta.report !== undefined ? meta.report : resultText;
        this.body.append(h('div', { class: `prose${result.is_error ? ' danger-text' : ''}`, html: renderMarkdown(result.is_error ? resultText : report || '(no report)') }));
        return;
      }
      case 'create_pull_request': {
        this.body.append(h('div', { class: 'prose', style: { padding: '8px 12px' } }, h('p', {}, h('strong', {}, input.title || '')), h('div', { html: renderMarkdown(String(input.description || '')) })));
        if (result) this.body.append(h('div', { style: { padding: '0 12px 10px' } }, meta.url ? h('a', { href: meta.url, target: '_blank', rel: 'noreferrer' }, meta.created ? `Pull request ${meta.number}` : 'Open the pull request page') : null, h('div', { class: result.is_error ? 'tool-error-text' : 'faint' }, resultText)));
        return;
      }
      case 'merge_pull_request': {
        if (result) this.body.append(h('div', { style: { padding: '8px 12px 10px' } }, meta.url ? h('a', { href: meta.url, target: '_blank', rel: 'noreferrer' }, `Pull request ${meta.number}`) : null, h('div', { class: result.is_error ? 'tool-error-text' : 'faint' }, resultText)));
        return;
      }
      default: {
        if (!result) {
          this.body.append(h('pre', { class: 'faint' }, JSON.stringify(input, null, 2)));
          return;
        }
        const image = Array.isArray(result.content) ? result.content.find((part) => part.type === 'image') : null;
        if (image) this.body.append(h('div', { style: { padding: '10px' } }, h('img', { src: `data:${image.mediaType};base64,${image.data}`, style: { maxWidth: '100%', maxHeight: '320px', borderRadius: '6px' } })));
        this.body.append(h('pre', { class: result.is_error ? 'danger-text' : '' }, resultText.length > 30000 ? `${resultText.slice(0, 30000)}\n…` : resultText));
      }
    }
  }
}

export function todoList(todos) {
  if (!todos.length) return h('div', { class: 'faint', style: { padding: '8px 12px', fontSize: '13px' } }, 'No tasks.');
  return h(
    'ul',
    { class: 'todo-list' },
    todos.map((todo) =>
      h('li', { class: todo.status }, h('span', { html: icon(todo.status === 'completed' ? 'circle-check' : todo.status === 'in_progress' ? 'circle-dot' : 'circle', 15) }), h('span', {}, todo.content)),
    ),
  );
}

/** Before the result arrives, show the edit as a plain before/after. */
function simpleDiff(oldText, newText) {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const lines = [...oldLines.map((text, i) => ({ kind: '-', text, oldNo: i + 1, newNo: null })), ...newLines.map((text, i) => ({ kind: '+', text, oldNo: null, newNo: i + 1 }))];
  return { hunks: [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines }] };
}
