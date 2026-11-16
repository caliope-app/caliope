// Calls to the local server. Every API call carries the per-start API key the server requires (see
// server/http.js): it arrives in the address after the launcher's link (#key=...) and stays for this window.

const API_KEY = (() => {
  const fromAddress = new URLSearchParams(location.hash.slice(1)).get('key');
  try {
    if (fromAddress) {
      sessionStorage.setItem('caliope-key', fromAddress);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return fromAddress || sessionStorage.getItem('caliope-key') || '';
  } catch {
    return fromAddress || '';
  }
})();

/** An API address with the key in the query, for requests that cannot set a header (downloads, events). */
export function withKey(url) {
  const keyed = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(API_KEY)}`;
  return keyed;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const options = { method, headers: { 'X-Caliope': API_KEY } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError('Caliope is not running. Start it again with its launcher.', 0);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

/**
 * Listen to server events.
 * - `onEvent(event)` runs for each event.
 * - EventSource reconnects by itself. `onOpen(reconnected)` runs on every open, with `reconnected` true after
 *   the first, so the app can reload what it missed.
 */
export function connectEvents({ onEvent, onOpen, onError }) {
  let opened = false;
  const source = new EventSource(withKey('/api/events'));
  source.onopen = () => {
    onOpen?.(opened);
    opened = true;
  };
  source.onerror = () => onError?.();
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch (error) {
      console.error('Bad event', error, message.data);
    }
  };
  return source;
}
