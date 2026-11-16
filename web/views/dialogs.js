// Modals, confirmations, menus, toasts, and the folder browser.
import { h, clear } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';

const overlays = () => document.getElementById('overlays');
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Show a modal and return { close, element }.
 * - `body` and `footer` are nodes, or functions that get `close(value)` and return nodes.
 * - Esc and a click on the backdrop close it with no value. `onClose(value)` runs once.
 * - Tab stays inside the modal. Focus goes to an [autofocus] element or the first field, else to the modal
 *   itself, so a stray Enter answers nothing. It returns to where it was when the modal closes.
 */
export function openModal({ title, body, footer, wide = false, onClose }) {
  let closed = false;
  const previousFocus = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : 'Dialog', tabindex: '-1' });
  function close(value) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previousFocus?.isConnected) previousFocus.focus();
    onClose?.(value);
  }
  function onKey(event) {
    // A modal opened from this one (the folder browser in New project) handles the keys while it is open.
    if ([...overlays().querySelectorAll('.modal-backdrop')].at(-1) !== backdrop) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(undefined);
    } else if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll(FOCUSABLE)].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!modal.contains(document.activeElement) || (event.shiftKey && (document.activeElement === first || document.activeElement === modal))) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  if (title) modal.append(h('div', { class: 'modal-head' }, title));
  modal.append(h('div', { class: 'modal-body' }, typeof body === 'function' ? body(close) : body));
  if (footer) modal.append(h('div', { class: 'modal-foot' }, typeof footer === 'function' ? footer(close) : footer));
  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close(undefined);
  });
  document.addEventListener('keydown', onKey, true);
  overlays().append(backdrop);
  const focusTarget = modal.querySelector('[autofocus], input, textarea, select') || modal;
  focusTarget.focus();
  return { close, element: modal };
}

/** Ask for confirmation; resolves true or false. A dangerous action starts with the focus on Cancel. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, extra = null }) {
  const answer = new Promise((resolve) => {
    openModal({
      title,
      body: h('div', { class: 'stack' }, typeof message === 'string' ? h('p', { style: { margin: '0' } }, message) : message, extra),
      footer: (close) => [
        h('button', { class: 'btn', type: 'button', autofocus: danger, onClick: () => close(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', autofocus: !danger, onClick: () => close(true) }, confirmLabel),
      ],
      onClose: (value) => resolve(Boolean(value)),
    });
  });
  return answer;
}

/** Ask for a line of text. Resolves the text, or null when canceled. */
export function promptDialog({ title, value = '', placeholder = '', confirmLabel = 'Save' }) {
  const answer = new Promise((resolve) => {
    const input = h('input', { class: 'input', placeholder, autofocus: true, 'aria-label': title });
    input.value = value;
    let modalHandle;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        modalHandle.close(input.value);
      }
    });
    modalHandle = openModal({
      title,
      body: h('div', { class: 'stack' }, input),
      footer: (close) => [
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => close(input.value) }, confirmLabel),
      ],
      onClose: (result) => resolve(result === undefined ? null : result),
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
  return answer;
}

/**
 * Let the user pick a folder in the app: drives, the home folder and recent folders, then subfolders.
 * Resolves the chosen path, or null when canceled.
 */
export function openFolderBrowser({ title = 'Choose a project folder', initial = '' } = {}) {
  const answer = new Promise((resolve) => {
    let current = null;
    const list = h('div', { class: 'folder-browser' });
    const pathLabel = h('div', { class: 'mono faint', style: { fontSize: '12px', wordBreak: 'break-all' } });
    const useButton = h('button', { class: 'btn primary', type: 'button', disabled: true, onClick: () => modalHandle.close(current) }, 'Use this folder');
    const row = (iconName, label, onClick) => h('button', { class: 'menu-item', type: 'button', onClick }, h('span', { html: icon(iconName, 15) }), h('span', { class: 'ellipsis grow' }, label));
    async function load(target) {
      try {
        const result = await api.get(`/api/folders${target ? `?path=${encodeURIComponent(target)}` : ''}`);
        current = result.path;
        useButton.disabled = !current;
        clear(list);
        pathLabel.textContent = result.path || 'This PC';
        if (!result.path) {
          for (const drive of result.drives) list.append(row('monitor', drive, () => load(drive)));
          list.append(row('user', result.home, () => load(result.home)));
          for (const recent of result.recent) list.append(row('history', recent, () => load(recent)));
        } else {
          list.append(row('arrow-up', '..', () => load(result.parent)));
          for (const name of result.folders) list.append(row('folder', name, () => load(`${result.path.replace(/\\$/, '')}\\${name}`)));
          if (result.folders.length === 0) list.append(h('div', { class: 'faint', style: { padding: '8px 10px', fontSize: '12.5px' } }, 'No subfolders.'));
        }
        list.querySelector('button')?.focus();
      } catch (error) {
        toastError(error);
        // A first folder that cannot be opened (moved, or no access) starts the browser at the drives instead.
        if (target && !list.firstChild) load('');
      }
    }
    const modalHandle = openModal({
      title,
      body: h('div', { class: 'stack' }, pathLabel, list),
      footer: (close) => [h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'), useButton],
      onClose: (value) => resolve(value || null),
    });
    load(initial);
  });
  return answer;
}

let openMenuHandle = null;

/**
 * Show a menu next to `anchor`; the first item takes the focus and the arrow keys move between items.
 * - Items: { label, icon, onSelect, danger, checked, hint, disabled } | 'separator' | { section: 'Label' }.
 * - An item with `checked` (true or false) is one choice of several, and screen readers hear which one is on.
 */
export function openMenu(anchor, items, { align = 'left', above = false } = {}) {
  openMenuHandle?.close();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (item.section) {
      menu.append(h('div', { class: 'menu-label' }, item.section));
      continue;
    }
    const choice = typeof item.checked === 'boolean';
    const button = h(
      'button',
      {
        class: `menu-item${item.danger ? ' danger' : ''}`,
        type: 'button',
        role: choice ? 'menuitemradio' : 'menuitem',
        'aria-checked': choice ? String(item.checked) : null,
        disabled: item.disabled,
        title: item.title,
        onClick: () => {
          close();
          // Back on the button that opened the menu, so a dialog the item opens returns the focus there.
          anchor.focus?.();
          item.onSelect?.();
        },
      },
      item.icon ? h('span', { html: icon(item.icon, 15) }) : null,
      h('span', { class: 'ellipsis grow' }, item.label),
      item.hint ? h('span', { class: 'hint' }, item.hint) : null,
      item.checked ? h('span', { class: 'check', html: icon('check', 15) }) : null,
    );
    if (!item.disabled) buttons.push(button);
    menu.append(button);
  }
  overlays().append(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = align === 'right' ? rect.right - menuRect.width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  let top = above ? rect.top - menuRect.height - 4 : rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  let focused = 0;
  buttons[0]?.focus();
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      anchor.focus?.();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && buttons.length) {
      event.preventDefault();
      focused = (focused + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[focused].focus();
    } else if (event.key === 'Tab') {
      // The menu's buttons go away with it, so the focus goes back to the button that opened the menu.
      event.preventDefault();
      close();
      anchor.focus?.();
    }
  }
  function onPointer(event) {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  }
  function close() {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onPointer, true);
    if (openMenuHandle?.menu === menu) openMenuHandle = null;
  }
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onPointer, true), 0);
  openMenuHandle = { close, menu };
  return openMenuHandle;
}

/**
 * A short message at the top right, where it covers none of the message box.
 * - Errors stay until the user closes them (the three newest are kept), so a long message can be read.
 */
export function toast(message, { kind = 'info', timeout = 4000 } = {}) {
  const toasts = document.getElementById('toasts');
  const error = kind === 'error';
  const element = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, h('span', { class: 'grow' }, message));
  if (error) {
    element.append(h('button', { class: 'toast-close', type: 'button', title: 'Close', 'aria-label': 'Close', html: icon('x', 14), onClick: () => element.remove() }));
    const errors = toasts.querySelectorAll('.toast.error');
    if (errors.length >= 3) errors[0].remove();
  } else {
    setTimeout(() => element.remove(), timeout);
  }
  toasts.append(element);
}

export function toastError(error) {
  toast(error?.message || String(error), { kind: 'error' });
}

/** Tell screen readers about something that changed on the screen, such as an approval that now waits. */
export function announce(message) {
  const region = document.getElementById('announcer');
  // A new text node, so the same message twice in a row is read twice.
  clear(region).append(document.createTextNode(message));
}
