// Modals, confirmations, menus and toasts.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

const overlays = () => document.getElementById('overlays');

/**
 * Show a modal and return { close, element }.
 * - `body` and `footer` are nodes, or functions that get `close(value)` and return nodes.
 * - Esc and a click on the backdrop close it with no value. `onClose(value)` runs once.
 */
export function openModal({ title, body, footer, wide = false, onClose }) {
  let closed = false;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : 'Dialog' });
  function close(value) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(value);
  }
  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(undefined);
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
  const focusTarget = modal.querySelector('[autofocus], input, textarea, select, .btn.primary');
  focusTarget?.focus();
  return { close, element: modal };
}

/** Ask for confirmation; resolves true or false. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, extra = null }) {
  const answer = new Promise((resolve) => {
    openModal({
      title,
      body: h('div', { class: 'stack' }, typeof message === 'string' ? h('p', { style: { margin: '0' } }, message) : message, extra),
      footer: (close) => [
        h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', autofocus: true, onClick: () => close(true) }, confirmLabel),
      ],
      onClose: (value) => resolve(Boolean(value)),
    });
  });
  return answer;
}

/** Ask for a line of text. Resolves the text, or null when canceled. */
export function promptDialog({ title, value = '', placeholder = '', confirmLabel = 'Save' }) {
  const answer = new Promise((resolve) => {
    const input = h('input', { class: 'input', placeholder, autofocus: true });
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

let openMenuHandle = null;

/**
 * Show a menu next to `anchor`.
 * - Items: { label, icon, onSelect, danger, checked, hint, disabled } | 'separator' | { section: 'Label' }.
 */
export function openMenu(anchor, items, { align = 'left', above = false } = {}) {
  openMenuHandle?.close();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (item.section) {
      menu.append(h('div', { class: 'menu-label' }, item.section));
      continue;
    }
    const button = h(
      'button',
      {
        class: `menu-item${item.danger ? ' danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled,
        title: item.title,
        onClick: () => {
          close();
          item.onSelect?.();
        },
      },
      item.icon ? h('span', { html: icon(item.icon, 15) }) : null,
      h('span', { class: 'ellipsis grow' }, item.label),
      item.hint ? h('span', { class: 'hint' }, item.hint) : null,
      item.checked ? h('span', { class: 'check', html: icon('check', 15) }) : null,
    );
    buttons.push(button);
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
  let focused = -1;
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focused = (focused + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[focused].focus();
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

export function toast(message, { kind = 'info', timeout = 4000 } = {}) {
  const element = h('div', { class: `toast${kind === 'error' ? ' error' : ''}`, role: 'status' }, message);
  document.getElementById('toasts').append(element);
  setTimeout(() => element.remove(), timeout);
}

export function toastError(error) {
  toast(error?.message || String(error), { kind: 'error', timeout: 7000 });
}
