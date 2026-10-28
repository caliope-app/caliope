// App state and a tiny publish/subscribe channel between the event stream, actions and views.

export const state = {
  ready: false,
  connected: true,
  boot: null,
  auth: null,
  settings: null,
  models: [],
  modelDefaults: {},
  // Average cost per request per model in the user's own usage (Copilot's list has no prices).
  modelCosts: {},
  modelsError: null,
  modelsFetchedAt: null,
  sessions: new Map(),
  runtimes: new Map(),
  allowance: { allowance: null, error: null },
  view: 'new',
  activeId: null,
  active: null,
  sidebar: { tab: 'active', group: 'date', query: '' },
  composerDrafts: new Map(),
};

const listeners = new Map();

/** Subscribe to a topic; returns the unsubscribe function. */
export function on(topic, listener) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(listener);
  return () => listeners.get(topic)?.delete(listener);
}

export function emit(topic, payload) {
  for (const listener of listeners.get(topic) || []) {
    try {
      listener(payload);
    } catch (error) {
      console.error(`Listener for ${topic} failed`, error);
    }
  }
}

export function runtimeOf(sessionId) {
  return state.runtimes.get(sessionId) || { state: 'idle', status: null, waiting: null, queue: [], queuePaused: false, jobs: [] };
}

export function modelById(id) {
  return state.models.find((model) => model.id === id) || null;
}

export function modelLabel(id) {
  if (!id) return 'Default model';
  const model = modelById(id);
  return model ? model.name : id;
}

/** Load a UI preference from localStorage. A missing or unreadable value gives `fallback`. */
export function loadPreference(key, fallback) {
  try {
    const value = localStorage.getItem(`caliope.${key}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function savePreference(key, value) {
  try {
    localStorage.setItem(`caliope.${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience only.
  }
}
