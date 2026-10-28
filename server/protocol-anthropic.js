// Anthropic Messages format (Copilot's /v1/messages), used for Claude models.
//
// The conversation is kept append-only: the system prompt and tool list are frozen per session and
// earlier messages are replayed byte-for-byte, including thinking blocks. Opus 5.5 and Fable 5.1 reject
// or drop thinking blocks when earlier history changes, so nothing here rewrites past turns.
// - Compaction: requests ask Claude to compact the conversation itself once it reaches `compactAt` input
//   tokens (beta compact-2026-01-12, which Copilot passes on). The reply then starts with a compaction
//   block that holds the summary. From then on the history starts at that block (see apiHistory).
import { summaryText } from './conversation.js';

const COMPACTION_BETA = 'compact-2026-01-12';
// The API's smallest trigger.
const MIN_COMPACT_TOKENS = 50000;

/**
 * Convert stored session messages into Messages API messages.
 * - Input: session messages (user/assistant) after the last compaction point.
 * - Merges consecutive messages with the same role and puts tool results first in a user turn.
 * - Drops thinking blocks without a signature (they came from another protocol and cannot be replayed),
 *   and blocks marked `omitted` after the API refused them (see omitThinkingBlocks).
 * - Claude's compaction blocks go back as they came. Without `compactionBlocks` (Copilot refused the
 *   beta), as a plain text summary. OpenAI's encrypted compaction is left out.
 */
export function toAnthropicMessages(history, { compactionBlocks = true } = {}) {
  const merged = [];
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const blocks = message.content.map((block) => toAnthropicBlock(block, compactionBlocks)).filter(Boolean);
    if (blocks.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content.push(...blocks);
    else merged.push({ role: message.role, content: blocks });
  }
  for (const message of merged) {
    if (message.role === 'user') {
      const toolResults = message.content.filter((block) => block.type === 'tool_result');
      const others = message.content.filter((block) => block.type !== 'tool_result');
      message.content = [...toolResults, ...others];
    }
  }
  if (merged.length > 0 && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: '(Conversation continues.)' }] });
  }
  if (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  }
  return merged;
}

function toAnthropicBlock(block, compactionBlocks) {
  switch (block.type) {
    case 'compaction':
      if (typeof block.content !== 'string') return null;
      return compactionBlocks ? { type: 'compaction', content: block.content } : { type: 'text', text: summaryText(block.content) };
    case 'text':
      return block.text ? { type: 'text', text: block.text } : null;
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
    case 'thinking':
      return block.signature && !block.omitted ? { type: 'thinking', thinking: block.thinking || '', signature: block.signature } : null;
    case 'redacted_thinking':
      return block.omitted ? null : { type: 'redacted_thinking', data: block.data };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
    case 'tool_result': {
      const result = { type: 'tool_result', tool_use_id: block.tool_use_id, content: toolResultContent(block.content) };
      if (block.is_error) result.is_error = true;
      return result;
    }
    default:
      return null;
  }
}

function toolResultContent(content) {
  if (typeof content === 'string') return content || '(no output)';
  const blocks = (content || [])
    .map((part) => {
      if (part.type === 'text') return part.text ? { type: 'text', text: part.text } : null;
      if (part.type === 'image') return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } };
      return null;
    })
    .filter(Boolean);
  return blocks.length > 0 ? blocks : '(no output)';
}

/**
 * Build a streaming /v1/messages request body.
 * - `adaptations` lists optional fields Copilot rejected for this model earlier. They are left out.
 * - A cache breakpoint goes on the system prompt and on the last block of the conversation.
 * - With `compactAt`, Claude compacts the conversation itself at that many input tokens.
 */
export function buildAnthropicRequest({ model, system, tools, history, effort, maxTokens, thinkingDisplay, compactAt = null, adaptations = {} }) {
  const nativeCompaction = !adaptations.noCompaction;
  const messages = toAnthropicMessages(history, { compactionBlocks: nativeCompaction });
  const useCache = !adaptations.noCacheControl;
  const body = {
    model: model.id,
    max_tokens: maxTokens,
    stream: true,
    system: [{ type: 'text', text: system, ...(useCache ? { cache_control: { type: 'ephemeral' } } : {}) }],
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  }
  if (useCache && messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    const lastIndex = lastMessage.content.length - 1;
    lastMessage.content[lastIndex] = { ...lastMessage.content[lastIndex], cache_control: { type: 'ephemeral' } };
  }
  if (!adaptations.noThinking) {
    body.thinking = adaptations.noDisplay ? { type: 'adaptive' } : { type: 'adaptive', display: thinkingDisplay };
  }
  if (effort && !adaptations.noEffort && model.efforts.includes(effort)) {
    body.output_config = { effort };
  }
  if (compactAt && nativeCompaction) {
    body.context_management = { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: Math.max(MIN_COMPACT_TOKENS, compactAt) } }] };
  }
  return body;
}

/** The anthropic-beta values a request body needs: compaction, when it asks for it or carries a block. */
export function anthropicBetas(body) {
  const carriesBlock = body.messages.some((message) => message.content.some((block) => block.type === 'compaction'));
  const betas = body.context_management || carriesBlock ? [COMPACTION_BETA] : [];
  return betas;
}

/**
 * Decide which optional field to drop after a 400, or null when the error is not about one.
 * - Copilot's model metadata is not always accurate, so the app learns from the server's answer.
 */
export function adaptationFor400(message, adaptations) {
  const text = String(message).toLowerCase();
  if (!adaptations.noCompaction && (text.includes('context_management') || text.includes('compact'))) return 'noCompaction';
  if (!adaptations.noDisplay && text.includes('display')) return 'noDisplay';
  if (!adaptations.noEffort && (text.includes('effort') || text.includes('output_config'))) return 'noEffort';
  if (!adaptations.noCacheControl && text.includes('cache_control')) return 'noCacheControl';
  if (!adaptations.noThinking && text.includes('thinking') && !text.includes('signature')) return 'noThinking';
  return null;
}

/** True for the 400 that refuses a replayed thinking block ("Invalid `signature` in `thinking` block"). */
export function isThinkingSignatureError(message) {
  const text = String(message).toLowerCase();
  const refused = text.includes('signature') && text.includes('thinking');
  return refused;
}

/**
 * Mark every thinking block in the stored messages as omitted, so all later requests leave them out.
 * - Recovery for a refused signature: the session continues without its earlier reasoning, and because
 *   the omission is stored, every later request sends the same history (no new mismatch each turn).
 * - Returns the number of blocks marked.
 */
export function omitThinkingBlocks(messages) {
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content || []) {
      if ((block.type === 'thinking' || block.type === 'redacted_thinking') && !block.omitted) {
        block.omitted = true;
        count++;
      }
    }
  }
  return count;
}

/**
 * Accumulate a /v1/messages SSE stream into a complete assistant message.
 * - `handle(event)` returns UI deltas: { kind: 'block_start' | 'text' | 'thinking' | 'tool_input' | 'block_stop', index, ... }.
 * - `result()` returns content blocks in order, the stop reason and usage.
 */
export class AnthropicStreamAccumulator {
  constructor() {
    this.blocks = [];
    this.stopReason = null;
    this.stopDetails = null;
    // nanoAiu stays null when Copilot reports no cost, so "unknown" is never shown as free.
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: null };
    this.model = null;
    this.messageId = null;
    this.finished = false;
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
    switch (type) {
      case 'message_start': {
        const message = payload.message || {};
        this.messageId = message.id || null;
        this.model = message.model || null;
        this.mergeUsage(message.usage);
        break;
      }
      case 'content_block_start': {
        const block = structuredClone(payload.content_block || {});
        if (block.type === 'text') block.text = block.text || '';
        if (block.type === 'thinking') {
          block.thinking = block.thinking || '';
          block.signature = block.signature || '';
        }
        if (block.type === 'tool_use') {
          block.partialJson = '';
          block.input = {};
        }
        if (block.type === 'compaction') block.content = block.content || '';
        block.complete = false;
        this.blocks[payload.index] = block;
        // The compaction summary arrives whole and is shown with the finished message, not live.
        if (block.type === 'compaction') break;
        deltas.push({ kind: 'block_start', index: payload.index, blockType: block.type, name: block.name, id: block.id });
        if (block.type === 'text' && block.text) deltas.push({ kind: 'text', index: payload.index, text: block.text });
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks[payload.index];
        const delta = payload.delta || {};
        if (!block) break;
        if (delta.type === 'text_delta') {
          block.text += delta.text || '';
          deltas.push({ kind: 'text', index: payload.index, text: delta.text || '' });
        } else if (delta.type === 'thinking_delta') {
          block.thinking += delta.thinking || '';
          deltas.push({ kind: 'thinking', index: payload.index, text: delta.thinking || '' });
        } else if (delta.type === 'signature_delta') {
          block.signature = (block.signature || '') + (delta.signature || '');
        } else if (delta.type === 'input_json_delta') {
          block.partialJson += delta.partial_json || '';
          deltas.push({ kind: 'tool_input', index: payload.index, length: block.partialJson.length });
        } else if (delta.type === 'compaction_delta') {
          block.content += delta.content || '';
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks[payload.index];
        if (!block) break;
        if (block.type === 'tool_use') {
          const json = block.partialJson.trim();
          try {
            block.input = json ? JSON.parse(json) : {};
          } catch {
            block.input = {};
            block.invalidJson = block.partialJson;
          }
          delete block.partialJson;
        }
        block.complete = true;
        if (block.type !== 'compaction') deltas.push({ kind: 'block_stop', index: payload.index, block: publicBlock(block) });
        break;
      }
      case 'message_delta': {
        if (payload.delta?.stop_reason) this.stopReason = payload.delta.stop_reason;
        if (payload.delta?.stop_details) this.stopDetails = payload.delta.stop_details;
        this.mergeUsage(payload.usage);
        this.mergeCopilotUsage(payload.copilot_usage);
        break;
      }
      case 'message_stop':
        this.finished = true;
        this.mergeCopilotUsage(payload.copilot_usage);
        break;
      case 'error': {
        const error = new Error(payload.error?.message || 'The model stream reported an error.');
        error.streamErrorType = payload.error?.type || 'error';
        throw error;
      }
      default:
        break;
    }
    return deltas;
  }

  mergeUsage(usage) {
    if (!usage) return;
    if (usage.input_tokens) this.usage.input = usage.input_tokens;
    if (usage.output_tokens) this.usage.output = usage.output_tokens;
    if (usage.cache_read_input_tokens) this.usage.cacheRead = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens) this.usage.cacheWrite = usage.cache_creation_input_tokens;
  }

  mergeCopilotUsage(copilotUsage) {
    if (typeof copilotUsage?.total_nano_aiu === 'number') this.usage.nanoAiu = copilotUsage.total_nano_aiu;
  }

  /** Complete blocks only, in stream order. */
  result() {
    const content = this.blocks.filter((block) => block && block.complete).map(publicBlock);
    const result = { content, stopReason: this.stopReason, stopDetails: this.stopDetails, usage: { ...this.usage }, model: this.model, finished: this.finished };
    return result;
  }

  /**
   * Blocks to keep when the user stops mid-stream.
   * - Only text survives: an unfinished tool call cannot run, and thinking without a signature cannot be replayed.
   */
  partialText() {
    const content = this.blocks.filter((block) => block?.type === 'text' && block.text.trim()).map((block) => ({ type: 'text', text: block.text }));
    return content;
  }
}

function publicBlock(block) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
    case 'compaction':
      // Empty when Claude could not write a summary. Such a block is not sent back.
      return { type: 'compaction', content: block.content || null };
    case 'tool_use': {
      const toolUse = { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      if (block.invalidJson !== undefined) toolUse.invalidJson = block.invalidJson;
      return toolUse;
    }
    default: {
      const copy = { ...block };
      delete copy.complete;
      return copy;
    }
  }
}
