// The Browser panel: a live view of the session's own browser tab, where the user watches the agent and takes
// over: click, type, paste (Control+V pastes the Windows clipboard) and sign in. Frames arrive as JPEG over an
// event stream (see AgentBrowser.watch on the server). Input goes back in small batches.
import { h, clear } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api, withKey } from '../lib/api.js';
import { toastError } from './dialogs.js';

// Keys sent as key presses. Characters arrive through the hidden text field instead, so dead keys, AltGr and
// input methods type what the user's keyboard layout makes of them.
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
const MOUSE_BUTTONS = ['left', 'middle', 'right'];
const INPUT_INTERVAL_MS = 30;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class BrowserView {
  /** - `onPageChange()`: called when a page appears in the panel or goes away, so the panel can change its width. */
  constructor({ onPageChange } = {}) {
    this.onPageChange = onPageChange;
    this.sessionId = null;
    this.lastUrl = null;
    this.source = null;
    this.frameSize = { width: 1280, height: 800 };
    this.state = { hasPage: false, busy: false, shown: false, url: '' };
    this.pending = [];
    this.sending = false;
    this.pressedButton = null;

    const button = (iconName, title, onClick) => h('button', { class: 'btn ghost small icon-only', type: 'button', title, 'aria-label': title, html: icon(iconName, 15), onClick });
    this.addressInput = h('input', {
      class: 'input browser-address',
      placeholder: 'Type an address',
      spellcheck: 'false',
      onKeydown: (event) => {
        if (event.key !== 'Enter' || !this.addressInput.value.trim()) return;
        this.navigate({ url: this.addressInput.value });
        this.addressInput.blur();
      },
    });
    this.windowButton = h('button', { class: 'btn small', type: 'button', onClick: () => this.toggleWindow() });
    this.toolbar = h(
      'div',
      { class: 'browser-toolbar' },
      button('chevron-left', 'Back', () => this.navigate({ action: 'back' })),
      button('chevron-right', 'Forward', () => this.navigate({ action: 'forward' })),
      button('refresh-cw', 'Reload', () => this.navigate({ action: 'reload' })),
      this.addressInput,
      this.windowButton,
    );
    this.frame = h('img', { class: 'browser-frame', alt: '', draggable: 'false' });
    // Holds the keyboard focus while the user works in the page, and keeps the app's own shortcuts out.
    this.keys = h('textarea', { class: 'browser-keys', 'aria-label': 'Type into the page', autocomplete: 'off', spellcheck: 'false' });
    this.busyLabel = h('div', { class: 'browser-busy', hidden: true }, 'The agent is using the browser');
    this.stage = h('div', { class: 'browser-stage' }, this.frame, this.keys, this.busyLabel);
    this.notice = h('div', { class: 'faint browser-notice' });
    this.element = h('div', { class: 'browser-view' }, this.toolbar, this.stage, this.notice);
    this.bindInput();
    this.render();
    // The page is laid out at the panel's size, so a resized panel restarts the stream with the new size.
    this.streamSize = null;
    this.resizeTimer = null;
    this.onWindowResize = () => this.scheduleResize();
    this.resizeObserver = new ResizeObserver(this.onWindowResize);
    this.resizeObserver.observe(this.element);
    window.addEventListener('resize', this.onWindowResize);
  }

  destroy() {
    this.hide();
    clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
  }

  /** The page size that fills the panel: its width (pages keep at least 800 CSS pixels and then show smaller) and the height under the toolbar. */
  panelSize() {
    const width = this.element.clientWidth || 800;
    const room = (this.element.parentElement?.clientHeight || 600) - this.toolbar.offsetHeight - this.notice.offsetHeight - 40;
    const scale = width / Math.max(800, width);
    const size = { width: Math.round(Math.max(800, width)), height: Math.round(Math.max(300, room) / scale) };
    return size;
  }

  scheduleResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (!this.source || !this.element.isConnected || !this.streamSize) return;
      const size = this.panelSize();
      if (Math.abs(size.width - this.streamSize.width) > 16 || Math.abs(size.height - this.streamSize.height) > 16) this.connect();
    }, 400);
  }

  connect() {
    this.source?.close();
    this.streamSize = this.panelSize();
    this.source = new EventSource(withKey(`/api/sessions/${this.sessionId}/browser/stream?width=${this.streamSize.width}&height=${this.streamSize.height}`));
    this.source.onmessage = (message) => this.onEvent(JSON.parse(message.data));
  }

  /**
   * Stream the tab of `sessionId`. Nothing restarts when it already does.
   * - `lastUrl`: the page the session's browser showed last, offered again when its browser was closed (a restart).
   */
  show(sessionId, lastUrl = null) {
    const changed = lastUrl !== this.lastUrl;
    this.lastUrl = lastUrl;
    if (this.source && this.sessionId === sessionId) {
      if (changed) this.render();
      return;
    }
    this.hide();
    this.sessionId = sessionId;
    this.setState({ hasPage: false, busy: false, shown: false, url: '' });
    this.pending = [];
    this.frame.removeAttribute('src');
    this.connect();
  }

  /** Stop the stream: the server stops the screencast when no panel shows the tab. */
  hide() {
    this.source?.close();
    this.source = null;
    this.streamSize = null;
  }

  onEvent(event) {
    if (event.type === 'frame') {
      this.frameSize = { width: event.width, height: event.height };
      this.frame.src = `data:image/jpeg;base64,${event.data}`;
    } else if (event.type === 'state') {
      this.setState(event);
    }
  }

  setState(state) {
    const pageChanged = Boolean(state.hasPage) !== Boolean(this.state.hasPage);
    this.state = state;
    this.render();
    if (pageChanged) this.onPageChange?.();
  }

  render() {
    const { hasPage, busy, shown, url } = this.state;
    if (document.activeElement !== this.addressInput) this.addressInput.value = url && url !== 'about:blank' ? url : '';
    this.windowButton.textContent = shown ? 'Hide window' : 'Show window';
    this.windowButton.disabled = !hasPage;
    this.windowButton.title = shown ? 'Move the browser window out of sight again' : 'Show the real browser window, for sign-in prompts, certificates and downloads the panel cannot show';
    this.stage.hidden = !hasPage;
    this.stage.classList.toggle('busy', Boolean(busy));
    this.busyLabel.hidden = !busy;
    clear(this.notice);
    if (hasPage) this.notice.append('Click the page to type in it. Control+V pastes your clipboard.');
    else if (this.lastUrl) {
      this.notice.append(
        h('p', {}, "This session's browser was closed, for example when Caliope restarted. Its logins and drafts are kept."),
        h('button', { class: 'btn small', type: 'button', title: this.lastUrl, onClick: () => this.navigate({ url: this.lastUrl }) }, `Open ${hostOf(this.lastUrl)} again`),
      );
    } else this.notice.append('The agent has not opened a page in this session yet. Type an address above to open one yourself.');
  }

  navigate(body) {
    if (!this.sessionId) return;
    api.post(`/api/sessions/${this.sessionId}/browser/navigate`, body).catch(toastError);
  }

  toggleWindow() {
    if (!this.sessionId) return;
    api.post(`/api/sessions/${this.sessionId}/browser/window`, { visible: !this.state.shown }).catch(toastError);
  }

  bindInput() {
    const point = (event) => {
      const rect = this.frame.getBoundingClientRect();
      const x = Math.round(((event.clientX - rect.left) * this.frameSize.width) / rect.width);
      const y = Math.round(((event.clientY - rect.top) * this.frameSize.height) / rect.height);
      return { x, y };
    };
    // Pointer capture keeps the moves and the release of a drag that leaves the picture. Cancelling pointerdown
    // would also cancel the mouse events below, so mousedown is the one cancelled (it would move the focus away).
    this.frame.addEventListener('pointerdown', (event) => {
      this.frame.setPointerCapture(event.pointerId);
      this.keys.focus({ preventScroll: true });
    });
    this.frame.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.pressedButton = MOUSE_BUTTONS[event.button] || 'left';
      this.queue({ type: 'mouse', action: 'down', ...point(event), button: this.pressedButton, clickCount: event.detail || 1 });
    });
    this.frame.addEventListener('mousemove', (event) => this.queue({ type: 'mouse', action: 'move', ...point(event), button: this.pressedButton || 'none' }));
    this.frame.addEventListener('mouseup', (event) => {
      this.queue({ type: 'mouse', action: 'up', ...point(event), button: this.pressedButton || MOUSE_BUTTONS[event.button] || 'left', clickCount: event.detail || 1 });
      this.pressedButton = null;
    });
    this.frame.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.queue({ type: 'mouse', action: 'wheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY });
      },
      { passive: false },
    );
    this.frame.addEventListener('contextmenu', (event) => event.preventDefault());
    this.frame.addEventListener('dragstart', (event) => event.preventDefault());

    this.keys.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      // AltGr arrives as Control+Alt. It types a character (@, €, …), so it goes through the text field.
      const altGraph = event.getModifierState('AltGraph');
      const modifiers = [];
      if (event.ctrlKey && !altGraph) modifiers.push('Control');
      if (event.altKey && !altGraph) modifiers.push('Alt');
      if (event.metaKey) modifiers.push('Meta');
      const named = NAMED_KEYS.has(event.key);
      if (!named && (modifiers.length === 0 || event.key.length !== 1)) return;
      if (event.shiftKey) modifiers.push('Shift');
      event.preventDefault();
      event.stopPropagation();
      this.queue({ type: 'key', key: [...modifiers, event.key].join('+') });
    });
    this.keys.addEventListener('input', (event) => {
      if (!event.isComposing) this.sendTyped();
    });
    this.keys.addEventListener('compositionend', () => this.sendTyped());
  }

  sendTyped() {
    const text = this.keys.value;
    this.keys.value = '';
    if (text) this.queue({ type: 'text', text });
  }

  /** Queue an input event; moves replace the previous move, and one request at a time goes to the server. */
  queue(event) {
    if (!this.sessionId || !this.state.hasPage || this.state.busy) return;
    const last = this.pending.at(-1);
    if (event.action === 'move' && last?.action === 'move') this.pending[this.pending.length - 1] = event;
    else this.pending.push(event);
    if (!this.sending) setTimeout(() => this.flush(), INPUT_INTERVAL_MS);
  }

  async flush() {
    if (this.sending || this.pending.length === 0 || !this.sessionId) return;
    this.sending = true;
    const events = this.pending.splice(0);
    try {
      await api.post(`/api/sessions/${this.sessionId}/browser/input`, { events });
    } catch (error) {
      // The agent started a browser action meanwhile. The panel shows that already.
      if (!this.state.busy) toastError(error);
    } finally {
      this.sending = false;
      if (this.pending.length > 0) setTimeout(() => this.flush(), INPUT_INTERVAL_MS);
    }
  }
}
