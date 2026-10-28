// OpenAI Chat Completions format (Copilot's /chat/completions), used for non-Claude models.
import { summaryText, toolResultText } from './conversation.js';

/**
 * Convert stored session messages into Chat Completions messages.
 * - Tool results become `tool` messages placed right after the assistant call that asked for them.
 * - Thinking blocks are left out: this format has no way to replay them. So is OpenAI's encrypted
 *   compaction. Claude's compaction summary goes along as user text.
 */
export function toOpenAiMessages(system, history) {
  const messages = [{ role: 'system', content: system }];
  for (const message of history) {
    const compaction = message.role === 'assistant' ? message.content.find((block) => block.type === 'compaction' && typeof block.content === 'string') : null;
    if (compaction) messages.push({ role: 'user', content: summaryText(compaction.content) });
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n');
      const toolCalls = message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
      if (!text && toolCalls.length === 0) continue;
      const assistantMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      messages.push(assistantMessage);
    } else if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block) });
        }
      }
      const parts = [];
      for (const block of message.content) {
        if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
        if (block.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } });
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
          }
        }
      }
      if (parts.length === 0) continue;
      const onlyText = parts.every((part) => part.type === 'text');
      const content = onlyText ? parts.map((part) => part.text).join('\n\n') : parts;
      const previous = messages[messages.length - 1];
      if (previous?.role === 'user' && typeof previous.content === 'string' && typeof content === 'string') {
        previous.content += `\n\n${content}`;
      } else {
        messages.push({ role: 'user', content });
      }
    }
  }
  return messages;
}

export function buildOpenAiRequest({ model, system, tools, history, effort, maxTokens, adaptations = {} }) {
  const body = {
    model: model.id,
    messages: toOpenAiMessages(system, history),
    stream: true,
    max_tokens: maxTokens,
  };
  if (!adaptations.noStreamOptions) body.stream_options = { include_usage: true };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  }
  if (effort && !adaptations.noEffort && model.efforts.includes(effort)) body.reasoning_effort = effort;
  return body;
}

export function openAiAdaptationFor400(message, adaptations) {
  const text = String(message).toLowerCase();
  if (!adaptations.noEffort && (text.includes('reasoning_effort') || text.includes('effort'))) return 'noEffort';
  if (!adaptations.noStreamOptions && text.includes('stream_options')) return 'noStreamOptions';
  return null;
}

const FINISH_REASONS = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

/**
 * Accumulate a Chat Completions SSE stream into the app's content blocks.
 * - Merges every choice: Copilot sometimes sends text and tool calls in separate choices.
 */
export class OpenAiStreamAccumulator {
  constructor() {
    this.text = '';
    this.reasoning = '';
    this.toolCalls = [];
    this.stopReason = null;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: null };
    this.model = null;
    this.finished = false;
    this.textStarted = false;
    this.reasoningStarted = false;
  }

  handle({ data }) {
    if (data === '[DONE]') {
      this.finished = true;
      return [];
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return [];
    }
    if (payload.error) {
      throw new Error(payload.error.message || 'The model stream reported an error.');
    }
    const deltas = [];
    if (payload.model) this.model = payload.model;
    if (payload.usage) {
      // prompt_tokens includes the cached ones. `input` holds only the uncached part, as on /v1/messages.
      const cached = payload.usage.prompt_tokens_details?.cached_tokens || 0;
      if (payload.usage.prompt_tokens) this.usage.input = payload.usage.prompt_tokens - cached;
      this.usage.output = payload.usage.completion_tokens || this.usage.output;
      if (cached) this.usage.cacheRead = cached;
    }
    if (typeof payload.copilot_usage?.total_nano_aiu === 'number') this.usage.nanoAiu = payload.copilot_usage.total_nano_aiu;
    for (const choice of payload.choices || []) {
      const delta = choice.delta || choice.message || {};
      const reasoning = delta.reasoning_text ?? delta.reasoning_content ?? null;
      if (typeof reasoning === 'string' && reasoning) {
        if (!this.reasoningStarted) {
          this.reasoningStarted = true;
          deltas.push({ kind: 'block_start', index: 0, blockType: 'thinking' });
        }
        this.reasoning += reasoning;
        deltas.push({ kind: 'thinking', index: 0, text: reasoning });
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (!this.textStarted) {
          this.textStarted = true;
          deltas.push({ kind: 'block_start', index: 1, blockType: 'text' });
        }
        this.text += delta.content;
        deltas.push({ kind: 'text', index: 1, text: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        const position = Number.isInteger(call.index) ? call.index : this.toolCalls.length;
        let toolCall = this.toolCalls[position];
        if (!toolCall) {
          toolCall = { id: call.id || `call_${position}`, name: '', arguments: '' };
          this.toolCalls[position] = toolCall;
          deltas.push({ kind: 'block_start', index: 2 + position, blockType: 'tool_use', name: call.function?.name, id: toolCall.id });
        }
        if (call.id) toolCall.id = call.id;
        if (call.function?.name) toolCall.name += call.function.name;
        if (call.function?.arguments) {
          toolCall.arguments += call.function.arguments;
          deltas.push({ kind: 'tool_input', index: 2 + position, length: toolCall.arguments.length });
        }
      }
      if (choice.finish_reason) {
        const mapped = FINISH_REASONS[choice.finish_reason] || 'end_turn';
        // A tool call in any choice decides the turn.
        if (this.stopReason !== 'tool_use') this.stopReason = mapped;
      }
    }
    return deltas;
  }

  result() {
    const content = [];
    if (this.reasoning) content.push({ type: 'thinking', thinking: this.reasoning });
    if (this.text) content.push({ type: 'text', text: this.text });
    for (const toolCall of this.toolCalls.filter(Boolean)) {
      const block = { type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} };
      try {
        block.input = toolCall.arguments.trim() ? JSON.parse(toolCall.arguments) : {};
      } catch {
        block.invalidJson = toolCall.arguments;
      }
      content.push(block);
    }
    if (this.toolCalls.length > 0 && this.stopReason === 'end_turn') this.stopReason = 'tool_use';
    const result = { content, stopReason: this.stopReason, stopDetails: null, usage: { ...this.usage }, model: this.model, finished: this.finished || Boolean(this.stopReason) };
    return result;
  }

  partialText() {
    return this.text.trim() ? [{ type: 'text', text: this.text }] : [];
  }
}
