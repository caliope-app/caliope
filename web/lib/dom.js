// DOM and formatting helpers.

/**
 * Create an element.
 * - `attributes`: class, text, html (trusted markup only), dataset, on<Event> handlers, and plain attributes.
 * - `children`: nodes or strings (strings become text nodes).
 */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'html') element.innerHTML = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function clear(element) {
  while (element.firstChild) element.firstChild.remove();
  return element;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

export function basename(filePath) {
  const parts = String(filePath || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

/** The project a session belongs to: the folder the user picked, also for a session in its own worktree. */
export function projectFolder(meta) {
  const folder = meta.worktree?.sourceCwd || meta.cwd;
  return folder;
}

export function relativeTime(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

export function formatTokens(count) {
  if (!count) return '0';
  if (count < 1000) return String(count);
  if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
  return `${(count / 1000000).toFixed(2)}M`;
}

export const NANO_PER_CREDIT = 1e9;

/**
 * Format a cost given in nano-AIU.
 * - `unit` is 'credits' or 'usd' (1 AI credit = US$0.01).
 * - `unpriced` > 0 means some requests had no price, so the cost is shown as a minimum (≥).
 * - Returns '—' when the cost is unknown.
 */
export function formatCost(nanoAiu, unit = 'usd', { unpriced = 0 } = {}) {
  if (nanoAiu === null || nanoAiu === undefined) return '—';
  const credits = nanoAiu / NANO_PER_CREDIT;
  const approximate = unpriced > 0 ? '≥ ' : '';
  if (unit === 'usd') {
    const dollars = credits / 100;
    return `${approximate}$${dollars < 0.01 && dollars > 0 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
  }
  const digits = credits >= 100 ? 0 : credits >= 10 ? 1 : 2;
  return `${approximate}${credits.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} cr`;
}

export function formatCredits(credits, unit = 'usd') {
  if (credits === null || credits === undefined) return '—';
  if (unit === 'usd') return `$${(credits / 100).toFixed(2)}`;
  return `${Number(credits).toLocaleString(undefined, { maximumFractionDigits: 1 })} cr`;
}

/**
 * Run `callback` on the next animation frame, or after 100 ms if frames are paused
 * (Windows can stop painting a covered window while it still counts as visible).
 */
export function onNextFrame(callback) {
  let done = false;
  let frame = 0;
  let timer = 0;
  const run = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    callback();
  };
  frame = requestAnimationFrame(run);
  timer = setTimeout(run, 100);
  return {
    cancel() {
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    },
  };
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Read an image file as base64; large images are scaled down to fit 2000 px. */
export async function readImage(file) {
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error(`${file.name || 'This file'} is not a PNG, JPEG, GIF or WebP image.`);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('The image could not be read.'));
    element.src = dataUrl;
  });
  const maxSide = 2000;
  if (image.width <= maxSide && image.height <= maxSide && file.size <= 4 * 1024 * 1024) {
    return { mediaType: file.type, data: dataUrl.split(',')[1], width: image.width, height: image.height };
  }
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const scaled = canvas.toDataURL('image/jpeg', 0.9);
  return { mediaType: 'image/jpeg', data: scaled.split(',')[1], width: canvas.width, height: canvas.height };
}

export function pluralize(count, word, plural = `${word}s`) {
  return `${count} ${count === 1 ? word : plural}`;
}
