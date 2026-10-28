// The message box: text, images, / commands, @file mentions, and the mode / model / effort pickers.
import { h, clear, readImage, formatTokens, formatCost, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, modelById } from '../lib/store.js';
import { openMenu, toastError } from './dialogs.js';

export const MODES = [
  { id: 'ask', name: 'Ask permissions', short: 'Ask', icon: 'hand', description: 'Approve each file change and command.' },
  { id: 'edits', name: 'Accept edits', short: 'Accept edits', icon: 'pencil', description: 'File changes apply, commands ask.' },
  { id: 'auto', name: 'Auto', short: 'Auto', icon: 'shield-check', description: 'Work runs. A safety check asks you only about risky actions.' },
  { id: 'plan', name: 'Plan', short: 'Plan', icon: 'map', description: 'Research and plan only (planning model).' },
  { id: 'full', name: 'Full access', short: 'Full access', icon: 'zap', description: 'Everything runs without asking.' },
];

export const SLASH_COMMANDS = [
  { name: 'plan', args: '[request]', description: 'Plan mode with the planning model, optionally with a request' },
  { name: 'build', description: 'Accept edits mode with the building model' },
  { name: 'ask', description: 'Ask permissions mode' },
  { name: 'auto', description: 'Auto mode: a safety check decides which commands need approval' },
  { name: 'full', description: 'Full access mode (no approvals)' },
  { name: 'model', description: 'Choose the model for this session' },
  { name: 'effort', args: 'low|medium|high|xhigh|max', description: 'Set the reasoning effort' },
  { name: 'compact', args: '[focus]', description: 'Summarize the conversation to free up context' },
  { name: 'review', description: 'Have the planning model review this session\'s changes' },
  { name: 'init', description: 'Create or improve AGENTS.md for this project' },
  { name: 'commit', description: 'Have the agent commit the current changes with git (no push)' },
  { name: 'pr', description: 'Have the agent commit, push and open a pull request on GitHub or Azure DevOps' },
  { name: 'remember', args: '<note>', description: 'Save a note to this project\'s memory (new sessions start with it)' },
  { name: 'new', description: 'New session in the same folder' },
  { name: 'fork', description: 'Copy this session into a new one' },
  { name: 'rename', args: '[title]', description: 'Rename this session' },
  { name: 'export', description: 'Download this session as Markdown' },
  { name: 'usage', description: 'Open spending and allowance' },
  { name: 'settings', description: 'Open settings' },
  { name: 'help', description: 'Show commands and shortcuts' },
];

const MODE_CYCLE = ['ask', 'edits', 'auto', 'plan'];

export class Composer {
  constructor(controller) {
    this.controller = controller;
    this.images = [];
    this.popover = null;
    this.popoverItems = [];
    this.popoverIndex = 0;
    this.popoverKind = null;

    this.textarea = h('textarea', { rows: 1, placeholder: controller.placeholder || 'Message the agent… (/ for commands, @ to mention files)', 'aria-label': 'Message' });
    this.attachmentsElement = h('div', { class: 'composer-attachments', hidden: true });
    this.fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
    this.modeButton = h('button', { class: 'picker-btn', type: 'button' });
    this.modelButton = h('button', { class: 'picker-btn', type: 'button', title: 'Model for this session' });
    this.effortButton = h('button', { class: 'picker-btn', type: 'button', title: 'Reasoning effort: higher thinks longer and costs more' });
    this.contextElement = h('span', { class: 'context-ring' });
    this.costElement = h('span', { class: 'context-ring' });
    this.attachButton = h('button', { class: 'picker-btn', type: 'button', title: 'Attach images (or paste / drop them)', html: icon('paperclip', 15) });
    // While the agent works: Enter queues the message for when it is done, Ctrl+Enter ("Send now") stops the agent
    // and sends it, and Stop (Esc) only stops. While an approval or a question waits, a message always goes now.
    this.nowButton = h('button', { class: 'send-btn now', type: 'button', title: 'Send now: stops the agent and sends this (Ctrl+Enter)', 'aria-label': 'Send now', html: icon('zap', 15), hidden: true });
    this.sendButton = h('button', { class: 'send-btn', type: 'button', title: 'Send (Enter)', 'aria-label': 'Send' });
    this.stopButton = h('button', { class: 'send-btn stop', type: 'button', title: 'Stop (Esc)', 'aria-label': 'Stop', html: icon('square', 14), hidden: true });
    this.queuedElement = h('div', { class: 'queued', hidden: true });

    this.box = h(
      'div',
      { class: 'composer' },
      this.attachmentsElement,
      this.textarea,
      h('div', { class: 'composer-bar' }, this.modeButton, this.modelButton, this.effortButton, h('span', { class: 'spacer' }), this.costElement, this.contextElement, this.attachButton, this.nowButton, this.sendButton, this.stopButton),
      this.fileInput,
    );
    this.element = h('div', { class: 'composer-inner' }, this.queuedElement, this.box);

    this.textarea.addEventListener('input', () => {
      this.autosize();
      this.updatePopover();
      this.updateSendButton();
      controller.onDraft?.(this.textarea.value);
    });
    this.textarea.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.textarea.addEventListener('paste', (event) => this.onPaste(event));
    this.textarea.addEventListener('blur', () => setTimeout(() => this.closePopover(), 150));
    this.box.addEventListener('dragover', (event) => {
      if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file')) {
        event.preventDefault();
        this.box.classList.add('dragover');
      }
    });
    this.box.addEventListener('dragleave', () => this.box.classList.remove('dragover'));
    this.box.addEventListener('drop', (event) => {
      this.box.classList.remove('dragover');
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) {
        event.preventDefault();
        this.addImages(files);
      }
    });
    this.attachButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      this.addImages([...this.fileInput.files]);
      this.fileInput.value = '';
    });
    this.sendButton.addEventListener('click', () => this.submit());
    this.nowButton.addEventListener('click', () => this.submit({ interrupt: true }));
    this.stopButton.addEventListener('click', () => this.controller.onStop());
    this.modeButton.addEventListener('click', () => this.openModeMenu());
    this.modelButton.addEventListener('click', () => this.openModelMenu());
    this.effortButton.addEventListener('click', () => this.openEffortMenu());
    this.mentionSearch = debounce((query) => this.searchFiles(query), 120);
    this.refresh();
  }

  hasContent() {
    return this.textarea.value.trim().length > 0 || this.images.length > 0;
  }

  focus() {
    this.textarea.focus();
  }

  setText(text = '', images = []) {
    this.textarea.value = text;
    this.images = images.map((image) => ({ ...image }));
    this.renderAttachments();
    this.autosize();
    this.updateSendButton();
    this.textarea.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
  }

  autosize() {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  /** Re-render pickers and buttons from the controller's current values. */
  refresh() {
    const mode = MODES.find((item) => item.id === this.controller.mode()) || MODES[0];
    clear(this.modeButton).append(h('span', { html: icon(mode.icon, 14) }), h('span', {}, mode.short), h('span', { html: icon('chevron-down', 12) }));
    this.modeButton.className = `picker-btn mode-${mode.id}`;
    this.modeButton.title = `${mode.name}: ${mode.description} (Shift+Tab to switch)`;

    const modelId = this.controller.model();
    const model = modelById(modelId);
    clear(this.modelButton).append(h('span', { html: icon('sparkles', 14) }), h('span', { class: 'ellipsis' }, model ? model.name : modelId || 'Default model'), h('span', { html: icon('chevron-down', 12) }));
    const effort = this.controller.effort();
    const efforts = model?.efforts || [];
    this.effortButton.hidden = efforts.length === 0;
    clear(this.effortButton).append(h('span', { html: icon('gauge', 14) }), h('span', {}, efforts.includes(effort) ? effort : effort || 'default'), h('span', { html: icon('chevron-down', 12) }));

    const context = this.controller.context?.();
    clear(this.contextElement);
    if (context && context.max) {
      const percent = Math.min(100, Math.round((context.used / context.max) * 100));
      const radius = 7;
      const circumference = 2 * Math.PI * radius;
      const color = percent >= 85 ? 'var(--danger)' : percent >= 65 ? 'var(--warning)' : 'var(--accent)';
      this.contextElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="${radius}" fill="none" stroke="var(--border-strong)" stroke-width="2.5"/><circle cx="9" cy="9" r="${radius}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="${(circumference * percent) / 100} ${circumference}" transform="rotate(-90 9 9)" stroke-linecap="round"/></svg><span>${percent}%</span>`;
      const compactAt = Math.round((context.max * (state.settings?.autoCompactPercent ?? 90)) / 100);
      this.contextElement.title = `Context: ${formatTokens(context.used)} of ${formatTokens(context.max)} tokens used (${percent}%). The conversation is compacted automatically at ${formatTokens(compactAt)} tokens.`;
    }
    const cost = this.controller.cost?.();
    clear(this.costElement);
    if (cost) {
      this.costElement.append(h('span', { html: icon('coins', 13) }), h('span', {}, cost.text));
      this.costElement.title = cost.title;
    }
    this.renderQueued();
    this.updateSendButton();
  }

  /** Messages waiting for the agent to be done (the queue, paused after a stop). */
  renderQueued() {
    const queue = this.controller.queue?.() || [];
    clear(this.queuedElement);
    this.queuedElement.hidden = queue.length === 0;
    if (queue.length > 0 && this.controller.queuePaused?.()) {
      this.queuedElement.append(
        h(
          'div',
          { class: 'queued-row paused' },
          h('span', { class: 'grow' }, 'Queue paused because you stopped the agent.'),
          h('button', { class: 'btn small', type: 'button', onClick: () => this.controller.onResumeQueue() }, 'Resume'),
          h('button', { class: 'btn ghost small', type: 'button', onClick: () => this.controller.onClearQueue() }, 'Clear'),
        ),
      );
    }
    queue.forEach((text, index) => {
      this.queuedElement.append(
        h(
          'div',
          { class: 'queued-row', title: `${text}\n\nSent when the agent is done.` },
          h('span', { class: 'faint', html: icon('history', 13) }),
          h('span', { class: 'ellipsis grow' }, text),
          h('button', { class: 'btn ghost small', type: 'button', title: 'Send now: stops the agent and sends this', onClick: () => this.controller.onSendNow(index, text) }, h('span', { html: icon('zap', 12) }), 'Send now'),
          h('button', { class: 'btn ghost small icon-only', type: 'button', title: 'Edit: back into the message box', 'aria-label': 'Edit queued message', html: icon('pencil', 12), onClick: () => this.editQueued(index, text) }),
          h('button', { class: 'btn ghost small icon-only', type: 'button', title: 'Delete queued message', 'aria-label': 'Delete queued message', html: icon('x', 12), onClick: () => this.controller.onUnqueue(index, text) }),
        ),
      );
    });
  }

  /** Take a queued message back into the message box, with its images, after what is typed there. */
  async editQueued(index, text) {
    const input = (await this.controller.onUnqueue(index, text))?.removed;
    if (!input) return;
    const current = this.textarea.value.trim();
    const queuedText = input.text || '';
    this.setText(current && queuedText ? `${current}\n\n${queuedText}` : current || queuedText, [...this.images, ...(input.images || [])]);
  }

  updateSendButton() {
    const running = this.controller.running();
    const content = this.hasContent();
    this.stopButton.hidden = !running;
    this.nowButton.hidden = !(running && content && this.controller.sessionId());
    this.sendButton.hidden = running && !content;
    this.sendButton.innerHTML = icon('arrow-up', 16);
    // While an approval or a question waits, Enter sends now: the message answers in its place.
    const queues = running && !this.controller.waiting?.();
    this.sendButton.title = queues ? 'Queue: sent when the agent is done (Enter)' : 'Send (Enter)';
    this.sendButton.setAttribute('aria-label', queues ? 'Queue' : 'Send');
    this.sendButton.disabled = !content;
  }

  /**
   * Built-in commands, then the project's custom commands and skills.
   * - Custom commands and skills are sent as messages. The server and the model handle them.
   * - A custom command with a built-in name is left out, so the built-in one keeps working.
   */
  slashCommands() {
    const builtIn = new Set(SLASH_COMMANDS.map((command) => command.name));
    const custom = (this.controller.commands?.() || []).filter((command) => !builtIn.has(command.name)).map((command) => ({ name: command.name, args: '[arguments]', description: `${command.source === 'personal' ? 'Your command' : 'Project command'}: ${command.description || command.name}`, sendAsMessage: true }));
    const taken = new Set([...builtIn, ...custom.map((command) => command.name)]);
    const skills = (this.controller.skills?.() || []).filter((skill) => !taken.has(skill.name)).map((skill) => ({ name: skill.name, args: '[request]', description: `Skill: ${skill.description || skill.name}`, sendAsMessage: true }));
    const commands = [...SLASH_COMMANDS, ...custom, ...skills];
    return commands;
  }

  async submit({ interrupt = false } = {}) {
    const text = this.textarea.value;
    if (!text.trim() && this.images.length === 0) return;
    const slash = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const command = slash && this.images.length === 0 ? this.slashCommands().find((item) => item.name === slash[1]) : null;
    if (command && !command.sendAsMessage) {
      const handled = await this.controller.onSlash(slash[1], (slash[2] || '').trim());
      if (handled) {
        this.setText('');
        this.controller.onDraft?.('');
        return;
      }
    }
    const images = this.images.map(({ mediaType, data }) => ({ mediaType, data }));
    this.sendButton.disabled = true;
    const ok = await this.controller.onSubmit(text, images, { interrupt });
    if (ok) {
      this.setText('');
      this.controller.onDraft?.('');
    } else {
      this.updateSendButton();
    }
  }

  onKeyDown(event) {
    if (this.popover) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.popoverIndex = (this.popoverIndex + (event.key === 'ArrowDown' ? 1 : -1) + this.popoverItems.length) % this.popoverItems.length;
        this.renderPopover();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && this.popoverItems.length) {
        event.preventDefault();
        this.choosePopoverItem(this.popoverItems[this.popoverIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closePopover();
        return;
      }
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      const current = this.controller.mode();
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
      this.controller.setMode(next);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit({ interrupt: event.ctrlKey && this.controller.running() });
    }
  }

  async onPaste(event) {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (files.length) {
      event.preventDefault();
      await this.addImages(files);
    }
  }

  async addImages(files) {
    for (const file of files) {
      try {
        if (this.images.length >= 10) throw new Error('Up to 10 images per message.');
        this.images.push(await readImage(file));
      } catch (error) {
        toastError(error);
      }
    }
    this.renderAttachments();
    this.updateSendButton();
  }

  renderAttachments() {
    clear(this.attachmentsElement);
    this.attachmentsElement.hidden = this.images.length === 0;
    this.images.forEach((image, index) => {
      this.attachmentsElement.append(
        h(
          'div',
          { class: 'attachment-thumb' },
          h('img', { src: `data:${image.mediaType};base64,${image.data}`, alt: 'Attachment' }),
          h('button', {
            type: 'button',
            title: 'Remove',
            html: icon('x', 11),
            onClick: () => {
              this.images.splice(index, 1);
              this.renderAttachments();
              this.updateSendButton();
            },
          }),
        ),
      );
    });
  }

  // ----- Popovers (/ commands and @ mentions) -----

  updatePopover() {
    const value = this.textarea.value;
    const caret = this.textarea.selectionStart;
    const beforeCaret = value.slice(0, caret);
    const slash = /^\/([\w.:-]*)$/.exec(beforeCaret);
    if (slash) {
      const query = slash[1].toLowerCase();
      const items = this.slashCommands().filter((command) => command.name.toLowerCase().startsWith(query)).map((command) => ({
        kind: 'slash',
        label: `/${command.name}${command.args ? ` ${command.args}` : ''}`,
        hint: command.description,
        value: command.name,
        takesArgs: Boolean(command.args),
      }));
      this.showPopover('slash', items);
      return;
    }
    const mention = /(^|\s)@([^\s@"]*)$/.exec(beforeCaret);
    if (mention && this.controller.sessionId()) {
      this.mentionStart = caret - mention[2].length - 1;
      this.mentionSearch(mention[2]);
      return;
    }
    this.closePopover();
  }

  async searchFiles(query) {
    const sessionId = this.controller.sessionId();
    if (!sessionId) return;
    try {
      const result = await api.get(`/api/files?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`);
      const caretText = this.textarea.value.slice(0, this.textarea.selectionStart);
      if (!/(^|\s)@([^\s@"]*)$/.test(caretText)) return;
      this.showPopover(
        'mention',
        result.files.map((file) => ({ kind: 'mention', label: file, value: file })),
      );
    } catch {
      this.closePopover();
    }
  }

  showPopover(kind, items) {
    if (items.length === 0) {
      this.closePopover();
      return;
    }
    this.popoverKind = kind;
    this.popoverItems = items;
    this.popoverIndex = Math.min(this.popoverIndex, items.length - 1);
    if (!this.popover) {
      this.popover = h('div', { class: 'popover', role: 'listbox' });
      this.element.append(this.popover);
    }
    // Open on the side with more room: below the message box on the new-session page, near the top.
    const box = this.box.getBoundingClientRect();
    const above = box.top;
    const below = window.innerHeight - box.bottom;
    const openBelow = above < 300 && below > above;
    this.popover.classList.toggle('below', openBelow);
    this.popover.style.maxHeight = `${Math.max(120, Math.min(300, (openBelow ? below : above) - 16))}px`;
    this.renderPopover();
  }

  renderPopover() {
    clear(this.popover);
    this.popoverItems.forEach((item, index) => {
      const element = h(
        'div',
        {
          class: `popover-item${index === this.popoverIndex ? ' selected' : ''}`,
          role: 'option',
          onMousedown: (event) => {
            event.preventDefault();
            this.choosePopoverItem(item);
          },
        },
        h('span', { html: icon(item.kind === 'slash' ? 'terminal' : 'file-text', 14) }),
        h('span', { class: item.kind === 'mention' ? 'mono ellipsis' : 'popover-label' }, item.label),
        item.hint ? h('span', { class: 'hint' }, item.hint) : null,
      );
      this.popover.append(element);
      if (index === this.popoverIndex) element.scrollIntoView({ block: 'nearest' });
    });
  }

  choosePopoverItem(item) {
    if (item.kind === 'slash') {
      this.textarea.value = `/${item.value}${item.takesArgs ? ' ' : ''}`;
      this.closePopover();
      if (!item.takesArgs) this.submit();
    } else {
      const value = this.textarea.value;
      const caret = this.textarea.selectionStart;
      const inserted = /\s/.test(item.value) ? `@"${item.value}" ` : `@${item.value} `;
      this.textarea.value = value.slice(0, this.mentionStart) + inserted + value.slice(caret);
      const position = this.mentionStart + inserted.length;
      this.textarea.setSelectionRange(position, position);
      this.closePopover();
    }
    this.autosize();
    this.updateSendButton();
    this.textarea.focus();
  }

  closePopover() {
    this.popover?.remove();
    this.popover = null;
    this.popoverItems = [];
    this.popoverIndex = 0;
  }

  // ----- Picker menus -----

  openModeMenu() {
    const current = this.controller.mode();
    openMenu(
      this.modeButton,
      MODES.map((mode) => ({
        label: mode.name,
        icon: mode.icon,
        hint: mode.description,
        checked: mode.id === current,
        onSelect: () => this.controller.setMode(mode.id),
      })),
      { above: true },
    );
  }

  openModelMenu() {
    const current = this.controller.model();
    // Copilot marks internal models (such as its compaction model) as not for pickers.
    const models = state.models.filter((model) => model.protocol && model.toolCalls && (model.pickerEnabled !== false || model.id === current));
    if (models.length === 0) {
      openMenu(this.modelButton, [{ label: state.auth?.signedIn ? 'No models loaded. Open Settings → Models.' : 'Sign in to load your models.', disabled: true }], { above: true });
      return;
    }
    const defaults = state.modelDefaults || {};
    const items = [{ section: 'Recommended' }];
    for (const [role, label] of [
      ['plan', 'for planning'],
      ['build', 'for building'],
    ]) {
      const model = modelById(defaults[role]);
      if (model) items.push({ label: model.name, hint: label, icon: role === 'plan' ? 'map' : 'pencil', checked: model.id === current, onSelect: () => this.controller.setModel(model.id) });
    }
    const vendors = new Map();
    for (const model of models) {
      const vendor = model.vendor || 'Other';
      if (!vendors.has(vendor)) vendors.set(vendor, []);
      vendors.get(vendor).push(model);
    }
    for (const [vendor, list] of vendors) {
      items.push('separator', { section: vendor });
      for (const model of list) {
        const unavailable = model.policyState === 'disabled';
        // Copilot's list has no prices (its multiplier is 1× for every model), so show what requests cost the user so far.
        const cost = state.modelCosts?.[model.id];
        const costText = cost ? (cost.nanoPerRequest === 0 ? 'free' : `≈ ${formatCost(cost.nanoPerRequest, state.settings?.costUnit)} / request`) : null;
        const details = [model.maxPromptTokens ? `${formatTokens(model.maxPromptTokens)} ctx` : null, costText].filter(Boolean).join(' · ');
        items.push({
          label: model.name + (model.preview ? ' (preview)' : ''),
          hint: unavailable ? 'disabled by policy' : model.policyState === 'unconfigured' ? 'needs enabling' : details,
          title: cost ? `Average cost of a request to this model in your use of Caliope (${cost.requests} request${cost.requests === 1 ? '' : 's'}; longer conversations cost more per request).` : 'No requests to this model yet, so its cost is not known.',
          checked: model.id === current,
          disabled: unavailable,
          onSelect: () => this.controller.setModel(model.id),
        });
      }
    }
    openMenu(this.modelButton, items, { above: true });
  }

  openEffortMenu() {
    const model = modelById(this.controller.model());
    const efforts = model?.efforts || [];
    const current = this.controller.effort();
    const notes = { low: 'fastest, cheapest', medium: 'balanced', high: 'thorough', xhigh: 'very thorough', max: 'maximum, slowest' };
    openMenu(
      this.effortButton,
      efforts.map((effort) => ({ label: effort, hint: notes[effort] || '', checked: effort === current, onSelect: () => this.controller.setEffort(effort) })),
      { above: true },
    );
  }
}
