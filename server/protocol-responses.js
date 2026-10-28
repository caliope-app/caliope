// OpenAI Responses format (Copilot's /responses): the only one Copilot offers for GPT-5 and later.
// - Requests are stateless (store: false). The model's reasoning comes back encrypted, is kept as a
//   thinking block with `encrypted`, and is sent back as is, so the model keeps its earlier reasoning.
// - Thinking from Claude (signed) is never sent here, and this encrypted reasoning never goes to Claude.
// - Compaction: with `compactAt`, the model compacts the conversation itself once the input reaches that
//   many tokens and returns an encrypted compaction item. Like reasoning, only the model that wrote it can
//   read it. The history starts at the latest one (see apiHistory).
import { summaryText, toolResultText } from './conversation.js';

/**
 * The stored session messages as Responses input items.
 * - Encrypted reasoning and compaction go back only to the model that wrote them (`modelId`). Another GPT
 *   model cannot read them. A subagent's history has no model per message: it has one model throughout.
 * - Claude's compaction summary becomes a user message with the summary text.
 */
export function toResponsesInput(history, modelId = null) {
  const input = [];
  for (const message of history) {
    if (message.role === 'assistant') {
      const ownReasoning = !message.model || !modelId || message.model === modelId;
      for (const block of message.content) {
        if (block.type === 'compaction' && typeof block.content === 'string') {
          input.push({ role: 'user', content: [{ type: 'input_text', text: summaryText(block.content) }] });
        } else if (block.type === 'compaction' && block.encrypted && ownReasoning) {
          input.push({ type: 'compaction', encrypted_content: block.encrypted, ...(block.id ? { id: block.id } : {}) });
        } else if (block.type === 'thinking' && block.encrypted && !block.omitted && ownReasoning) {
          input.push({ type: 'reasoning', summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [], encrypted_content: block.encrypted });
        } else if (block.type === 'text' && block.text) {
          input.push({ role: 'assistant', content: block.text });
        } else if (block.type === 'tool_use') {
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        }
      }
    } else if (message.role === 'user') {
      const parts = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: toolResultText(block) });
          for (const part of Array.isArray(block.content) ? block.content : []) {
            if (part.type === 'image') parts.push({ type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` });
          }
        } else if (block.type === 'text' && block.text) {
          parts.push({ type: 'input_text', text: block.text });
        } else if (block.type === 'image') {
          parts.push({ type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}` });
        }
      }
      if (parts.length > 0) input.push({ role: 'user', content: parts });
    }
  }
  return input;
}

/**
 * Build a streaming /responses request body.
 * - `hostedTools` are tools OpenAI runs itself, such as { type: 'web_search' }. They go along as they are.
 */
export function buildResponsesRequest({ model, system, tools, hostedTools = [], history, effort, maxTokens, compactAt = null, adaptations = {} }) {
  const body = {
    model: model.id,
    instructions: system,
    input: toResponsesInput(history, model.id),
    stream: true,
    store: false,
  };
  if (!adaptations.noMaxTokens) body.max_output_tokens = maxTokens;
  const functionTools = tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
  if (functionTools.length + hostedTools.length > 0) body.tools = [...functionTools, ...hostedTools];
  if (!adaptations.noReasoning) {
    body.reasoning = {};
    if (effort && model.efforts.includes(effort)) body.reasoning.effort = effort;
    if (!adaptations.noSummary) body.reasoning.summary = 'auto';
    if (!adaptations.noEncrypted) body.include = ['reasoning.encrypted_content'];
  }
  if (compactAt && !adaptations.noCompaction) body.context_management = [{ type: 'compaction', compact_threshold: compactAt }];
  return body;
}

/** The optional field to leave out after a 400 that names it, or null. */
export function responsesAdaptationFor400(message, adaptations) {
  const text = String(message).toLowerCase();
  if (!adaptations.noCompaction && (text.includes('context_management') || text.includes('compaction'))) return 'noCompaction';
  if (!adaptations.noSummary && text.includes('summary')) return 'noSummary';
  if (!adaptations.noEncrypted && (text.includes('include') || text.includes('encrypted'))) return 'noEncrypted';
  if (!adaptations.noMaxTokens && text.includes('max_output_tokens')) return 'noMaxTokens';
  if (!adaptations.noReasoning && (text.includes('reasoning') || text.includes('effort'))) return 'noReasoning';
  return null;
}

const BLOCK_TYPES = { message: 'text', reasoning: 'thinking', function_call: 'tool_use' };

/**
 * Accumulate a /responses SSE stream into the app's content blocks (thinking, text, tool calls).
 * - `handle(event)` returns the same UI deltas as the other accumulators.
 */
export class ResponsesStreamAccumulator {
  constructor() {
    this.items = [];
    this.stopReason = null;
    this.stopDetails = null;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: null };
    this.model = null;
    this.finished = false;
    this.refused = false;
  }

  handle({ event, data }) {
    if (data === '[DONE]') return [];
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return [];
    }
    const type = payload.type || event;
    const deltas = [];
    const index = payload.output_index;
    const item = Number.isInteger(index) ? this.items[index] : null;
    this.mergeCopilotUsage(payload.copilot_usage);
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        this.model = payload.response?.model || this.model;
        break;
      case 'response.output_item.added': {
        const added = payload.item || {};
        this.items[index] = { type: added.type, text: '', summary: '', arguments: added.arguments || '', name: added.name || '', callId: added.call_id || added.id, encrypted: null, done: false };
        const blockType = BLOCK_TYPES[added.type];
        if (blockType) deltas.push({ kind: 'block_start', index, blockType, name: added.name, id: added.call_id });
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        // A refusal is shown as the reply's text, and the turn ends as declined.
        if (!item) break;
        if (type === 'response.refusal.delta') this.refused = true;
        item.text += payload.delta || '';
        deltas.push({ kind: 'text', index, text: payload.delta || '' });
        break;
      case 'response.reasoning_summary_part.added':
        // Each summary part is its own paragraph.
        if (item?.summary) {
          item.summary += '\n\n';
          deltas.push({ kind: 'thinking', index, text: '\n\n' });
        }
        break;
      case 'response.reasoning_summary_text.delta':
        if (!item) break;
        item.summary += payload.delta || '';
        deltas.push({ kind: 'thinking', index, text: payload.delta || '' });
        break;
      case 'response.function_call_arguments.delta':
        if (!item) break;
        item.arguments += payload.delta || '';
        deltas.push({ kind: 'tool_input', index, length: item.arguments.length });
        break;
      case 'response.output_item.done': {
        const done = payload.item || {};
        const current = item || (this.items[index] = { type: done.type, text: '', summary: '', arguments: '', name: '', callId: done.call_id, encrypted: null });
        if (done.type === 'compaction') {
          current.encrypted = done.encrypted_content || null;
          current.itemId = done.id || null;
        } else if (done.type === 'reasoning') {
          current.encrypted = done.encrypted_content || null;
          if (!current.summary) current.summary = (done.summary || []).map((part) => part.text).join('\n\n');
        } else if (done.type === 'function_call') {
          current.arguments = done.arguments ?? current.arguments;
          current.name = done.name || current.name;
          current.callId = done.call_id || current.callId;
        } else if (done.type === 'message' && !current.text) {
          const parts = (done.content || []).filter((part) => part.type === 'output_text' || part.type === 'refusal');
          if (parts.some((part) => part.type === 'refusal')) this.refused = true;
          current.text = parts.map((part) => part.text ?? part.refusal ?? '').join('');
        }
        current.done = true;
        const block = publicBlock(current);
        // A compaction item is not shown while the reply streams.
        if (block && done.type !== 'compaction') deltas.push({ kind: 'block_stop', index, block });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = payload.response || {};
        this.model = response.model || this.model;
        this.mergeUsage(response.usage);
        this.mergeCopilotUsage(response.copilot_usage);
        const reason = response.incomplete_details?.reason;
        if (type === 'response.incomplete') this.stopReason = reason === 'content_filter' ? 'refusal' : 'max_tokens';
        else if (this.refused) this.stopReason = 'refusal';
        else this.stopReason = this.items.some((entry) => entry?.type === 'function_call') ? 'tool_use' : 'end_turn';
        this.finished = true;
        break;
      }
      case 'response.failed': {
        const error = new Error(payload.response?.error?.message || 'The model reported a failure.');
        error.streamErrorType = payload.response?.error?.code === 'server_error' ? 'api_error' : 'error';
        throw error;
      }
      case 'error': {
        const error = new Error(payload.message || payload.error?.message || 'The model stream reported an error.');
        error.streamErrorType = payload.code === 'server_error' ? 'api_error' : 'error';
        throw error;
      }
      default:
        break;
    }
    return deltas;
  }

  mergeUsage(usage) {
    if (!usage) return;
    // input_tokens includes the cached ones. `input` holds only the uncached part, as on /v1/messages.
    const cached = usage.input_tokens_details?.cached_tokens || 0;
    if (usage.input_tokens) this.usage.input = usage.input_tokens - cached;
    if (cached) this.usage.cacheRead = cached;
    if (usage.output_tokens) this.usage.output = usage.output_tokens;
  }

  mergeCopilotUsage(copilotUsage) {
    if (typeof copilotUsage?.total_nano_aiu === 'number') this.usage.nanoAiu = copilotUsage.total_nano_aiu;
  }

  result() {
    const content = this.items.filter((item) => item?.done).map(publicBlock).filter(Boolean);
    const result = { content, stopReason: this.stopReason, stopDetails: this.stopDetails, usage: { ...this.usage }, model: this.model, finished: this.finished };
    return result;
  }

  /** Text to keep when the user stops mid-stream; unfinished reasoning and tool calls cannot be replayed. */
  partialText() {
    const content = this.items.filter((item) => item?.type === 'message' && item.text.trim()).map((item) => ({ type: 'text', text: item.text }));
    return content;
  }
}

function publicBlock(item) {
  if (item.type === 'compaction') return item.encrypted ? { type: 'compaction', encrypted: item.encrypted, ...(item.itemId ? { id: item.itemId } : {}) } : null;
  if (item.type === 'message') return item.text ? { type: 'text', text: item.text } : null;
  if (item.type === 'reasoning') return item.encrypted || item.summary ? { type: 'thinking', thinking: item.summary, encrypted: item.encrypted } : null;
  if (item.type === 'function_call') {
    const block = { type: 'tool_use', id: item.callId, name: item.name, input: {} };
    try {
      block.input = item.arguments.trim() ? JSON.parse(item.arguments) : {};
    } catch {
      block.invalidJson = item.arguments;
    }
    return block;
  }
  return null;
}
