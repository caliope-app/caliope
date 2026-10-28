// HTTP client for the GitHub Copilot API: model list, request headers, retries.
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, sleep, isAbortError } from './util.js';
import { AuthError, userAgent } from './auth.js';

// Matches what GitHub's Copilot CLI sends when it calls the API with a GitHub token.
const API_VERSION = '2025-05-01';
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 4;

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, body = null, retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryable = retryable;
  }
}

export class CopilotClient {
  constructor({ auth, log, cacheFile }) {
    this.auth = auth;
    this.log = log;
    this.cacheFile = cacheFile;
    this.models = [];
    this.modelsFetchedAt = null;
    this.modelsError = null;
  }

  async loadCachedModels() {
    const cached = await readJson(this.cacheFile, null).catch(() => null);
    if (cached?.models) {
      this.models = cached.models;
      this.modelsFetchedAt = cached.fetchedAt || null;
    }
  }

  /** Fetch and normalize the model list for the signed-in account. */
  async refreshModels() {
    try {
      const access = await this.auth.getAccess();
      const models = await this.fetchModels(access);
      this.models = models;
      this.modelsFetchedAt = new Date().toISOString();
      this.modelsError = null;
      await writeJsonAtomic(this.cacheFile, { fetchedAt: this.modelsFetchedAt, models });
    } catch (error) {
      this.modelsError = error.message;
      throw error;
    }
    return this.models;
  }

  /** Keep a model list fetched elsewhere (sign-in already fetched it to verify the token). */
  async setModels(models) {
    this.models = models;
    this.modelsFetchedAt = new Date().toISOString();
    this.modelsError = null;
    await writeJsonAtomic(this.cacheFile, { fetchedAt: this.modelsFetchedAt, models });
  }

  /** Used by sign-in to prove a token works before it is saved. */
  async fetchModels(access) {
    const response = await fetch(`${access.apiBase}/models`, { headers: this.headers(access, { initiator: 'agent' }) });
    if (!response.ok) throw await toApiError(response, 'Could not list Copilot models');
    const body = await response.json();
    const models = (Array.isArray(body.data) ? body.data : []).map(normalizeModel).filter(Boolean);
    return models;
  }

  findModel(id) {
    return this.models.find((model) => model.id === id) || null;
  }

  /**
   * Turn on a model whose policy is "unconfigured" (the account has not accepted its terms yet).
   * - The same call GitHub's editor plugins make when the user enables a model.
   */
  async enableModel(id) {
    const access = await this.auth.getAccess();
    const response = await fetch(`${access.apiBase}/models/${encodeURIComponent(id)}/policy`, {
      method: 'POST',
      headers: this.headers(access, { initiator: 'agent' }),
      body: JSON.stringify({ state: 'enabled' }),
    });
    if (!response.ok) throw await toApiError(response, 'Could not enable the model');
  }

  headers(access, { initiator = 'user', vision = false, anthropic = false, betas = [], stream = false } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      'User-Agent': userAgent(),
      'X-GitHub-Api-Version': API_VERSION,
      'Openai-Intent': 'conversation-agent',
      'X-Initiator': initiator,
      'X-Request-Id': crypto.randomUUID(),
      ...access.headers,
    };
    if (anthropic) headers['anthropic-version'] = '2023-06-01';
    if (betas.length > 0) headers['anthropic-beta'] = betas.join(',');
    if (vision) headers['Copilot-Vision-Request'] = 'true';
    return headers;
  }

  /**
   * POST a JSON body and return the successful Response (usually an SSE stream).
   * - Retries rate limits, server errors and dropped connections with backoff. `onRetry` reports each wait.
   */
  async post(pathname, body, { signal, initiator = 'user', vision = false, anthropic = false, betas = [], stream = true, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
      const access = await this.auth.getAccess();
      let response;
      try {
        response = await fetch(`${access.apiBase}${pathname}`, {
          method: 'POST',
          headers: this.headers(access, { initiator, vision, anthropic, betas, stream }),
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        if (attempt >= MAX_RETRIES) throw new ApiError(`Could not reach the Copilot API: ${describeNetworkError(error)}`, { retryable: true });
        const waitMs = backoffMs(attempt);
        onRetry?.({ attempt: attempt + 1, waitMs, reason: describeNetworkError(error) });
        await sleep(waitMs, signal);
        continue;
      }
      if (response.ok) return response;

      const error = await toApiError(response, 'Copilot request failed');
      if (error.status === 401) throw new AuthError(`Copilot rejected the sign-in: ${error.message}`);
      if (!error.retryable || attempt >= MAX_RETRIES) throw error;
      const waitMs = retryAfterMs(response) ?? backoffMs(attempt);
      onRetry?.({ attempt: attempt + 1, waitMs, reason: error.message });
      await sleep(waitMs, signal);
    }
  }
}

function backoffMs(attempt) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(120000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(120000, Math.max(0, date - Date.now())) : null;
}

function describeNetworkError(error) {
  const cause = error.cause;
  if (cause?.code) return `${cause.code}${cause.message ? ` (${cause.message})` : ''}`;
  return error.message;
}

/** Turn a failed response into an ApiError with the server's own message. */
export async function toApiError(response, prefix) {
  const text = await response.text().catch(() => '');
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain-text error body.
  }
  const detail = body?.error?.message || body?.message || body?.error_description || (typeof body?.error === 'string' ? body.error : null) || text.trim().slice(0, 500) || response.statusText;
  const code = body?.error?.code || body?.error?.type || body?.code || null;
  const error = new ApiError(`${prefix} (HTTP ${response.status}${code ? `, ${code}` : ''}): ${detail}`, {
    status: response.status,
    code,
    body: body ?? text,
    retryable: RETRY_STATUSES.has(response.status),
  });
  return error;
}

/**
 * Reduce a /models entry to what the app needs.
 * - Effort levels live in different places depending on the model. Read both known spots.
 * - `protocol` picks the endpoint: Anthropic Messages for Claude, Chat Completions when offered,
 *   else Responses (GPT-5 and later only offer that one).
 */
export function normalizeModel(raw) {
  if (!raw?.id) return null;
  const capabilities = raw.capabilities || {};
  const supports = capabilities.supports || {};
  const limits = capabilities.limits || {};
  if (capabilities.type && capabilities.type !== 'chat') return null;
  const endpoints = Array.isArray(raw.supported_endpoints) ? raw.supported_endpoints : ['/chat/completions'];
  let efforts = [];
  if (Array.isArray(raw.supportedReasoningEfforts)) efforts = raw.supportedReasoningEfforts;
  else if (Array.isArray(supports.reasoning_effort)) efforts = supports.reasoning_effort;
  let protocol = null;
  if (endpoints.includes('/v1/messages')) protocol = 'messages';
  else if (endpoints.includes('/chat/completions')) protocol = 'chat';
  else if (endpoints.includes('/responses')) protocol = 'responses';
  const model = {
    id: raw.id,
    name: raw.name || raw.id,
    vendor: raw.vendor || '',
    family: capabilities.family || '',
    preview: Boolean(raw.preview),
    pickerEnabled: raw.model_picker_enabled !== false,
    policyState: raw.policy?.state || null,
    endpoints,
    protocol,
    efforts: efforts.filter((effort) => typeof effort === 'string'),
    toolCalls: supports.tool_calls !== false,
    vision: Boolean(supports.vision),
    maxPromptTokens: limits.max_prompt_tokens || limits.max_context_window_tokens || null,
    maxOutputTokens: limits.max_output_tokens || null,
    maxContextTokens: limits.max_context_window_tokens || null,
    billing: raw.billing || null,
  };
  return model;
}
