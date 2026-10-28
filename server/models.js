// Choosing models and effort levels from the account's Copilot model list.
import { EFFORTS } from './settings.js';

// Preferred models per role, best first. Of the models a pattern matches, the newest wins, so a new Claude
// Opus takes over without a code change.
// - The newest Opus plans and builds, as in Claude Code. Never Fable, which costs far more.
// - Titles and auto mode's safety check use a model Copilot includes at no cost (GPT-4.1, GPT-4o mini), else a small one.
// - Read-only subagents ("explore") use a small model with a large window, as Copilot CLI (GPT-5.4 mini) and
//   Claude Code (Haiku) do: reading many files there costs a fraction of the session's model.
const PREFERENCES = {
  plan: [/^claude-opus-[\d.]+$/, /opus/, /^claude-sonnet-[\d.]+$/, /sonnet/],
  build: [/^claude-opus-[\d.]+$/, /opus/, /^claude-sonnet-[\d.]+$/, /sonnet/],
  title: [/^gpt-4\.1$/, /^gpt-4o-mini$/, /^claude-haiku-5\.5$/, /haiku/, /gpt-.*mini/, /flash/],
  // Auto mode's safety check runs before every command, so it must answer fast: the free GPT-5.6 Luna
  // utility judged 70 of 70 test commands right in about 1.5 s. GPT-4.1 took 4 to 16 s.
  check: [/^gpt-5\.6-luna-utility$/, /luna-utility/, /^gpt-4o-mini$/, /^gpt-4\.1$/, /^claude-haiku-5\.5$/, /haiku/, /gpt-.*mini/, /flash/],
  explore: [/^gpt-5\.4-mini$/, /^claude-haiku-5\.5$/, /haiku/, /^gpt-([5-9]|\d{2})[\w.-]*-mini$/, /flash/],
  // web_search uses OpenAI's own web search, which Copilot runs on /responses models only (it refuses
  // Anthropic's). On the free GPT-5.6 Luna utility a search costs 0 credits. Without it, DuckDuckGo.
  search: [/^gpt-5\.6-luna-utility$/, /luna-utility/],
};

export function usableModels(models) {
  const usable = models.filter((model) => model.protocol && model.toolCalls && model.policyState !== 'disabled');
  return usable;
}

/** The model id for a role: the setting when it names a known model, else the best available match. */
export function defaultModelId(role, settings, models) {
  const configured = { plan: settings.planModel, build: settings.buildModel, title: settings.titleModel }[role] || null;
  const usable = usableModels(models);
  if (configured && (usable.some((model) => model.id === configured) || models.length === 0)) return configured;
  // A model whose terms the account has not accepted yet ("needs enabling" in Settings) only when nothing else fits.
  const ready = usable.filter((model) => model.policyState !== 'unconfigured');
  for (const candidates of [ready, usable]) {
    for (const pattern of PREFERENCES[role]) {
      const match = newestFirst(candidates.filter((model) => pattern.test(model.id)))[0];
      if (match) return match.id;
    }
  }
  if (role === 'title' || role === 'explore' || role === 'check' || role === 'search') return null;
  const fallback = usable.find((model) => model.protocol === 'messages') || usable[0];
  return fallback ? fallback.id : null;
}

/**
 * The usable model the agent means: an exact id or name, or words such as "sonnet" or "gpt mini".
 * - Among several matches, the highest version wins ("sonnet" picks Sonnet 5.5 over Sonnet 4.5).
 * - Returns null when nothing matches.
 */
export function matchModel(query, models) {
  const usable = usableModels(models);
  const wanted = String(query || '').trim().toLowerCase();
  if (!wanted) return null;
  const exact = usable.find((model) => model.id.toLowerCase() === wanted || model.name.toLowerCase() === wanted);
  if (exact) return exact;
  const words = wanted.split(/[\s_]+/).filter(Boolean);
  const matches = usable.filter((model) => words.every((word) => `${model.id} ${model.name}`.toLowerCase().includes(word)));
  const match = newestFirst(matches)[0] || null;
  return match;
}

/** `models` with the highest version first: claude-opus-5.5 before claude-opus-4.8. */
function newestFirst(models) {
  const sorted = [...models].sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
  return sorted;
}

/**
 * The effort to send for a model: the requested level if supported, otherwise the nearest supported one.
 * - Returns null for models without effort levels.
 */
export function effortFor(model, requested) {
  if (!model || model.efforts.length === 0) return null;
  if (!requested || model.efforts.includes(requested)) return requested || null;
  const wanted = EFFORTS.indexOf(requested);
  let best = null;
  let bestDistance = Infinity;
  for (const effort of model.efforts) {
    const index = EFFORTS.indexOf(effort);
    if (index === -1) continue;
    const distance = Math.abs(index - wanted);
    if (distance < bestDistance) {
      best = effort;
      bestDistance = distance;
    }
  }
  return best;
}

/** A stand-in when the model list could not be loaded: Claude ids use Messages, GPT-5 and later Responses. */
export function guessModel(id) {
  const isClaude = /claude/i.test(id);
  const isNewGpt = /^gpt-([5-9]|\d{2})/i.test(id);
  const guessed = {
    id,
    name: id,
    vendor: isClaude ? 'Anthropic' : '',
    protocol: isClaude ? 'messages' : isNewGpt ? 'responses' : 'chat',
    efforts: isClaude ? ['low', 'medium', 'high', 'xhigh', 'max'] : [],
    toolCalls: true,
    vision: true,
    maxPromptTokens: null,
    maxOutputTokens: null,
    guessed: true,
  };
  return guessed;
}
