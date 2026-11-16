// Helpers over a session's stored messages.
//
// Stored message shapes:
//   { id, role: 'user', kind: 'prompt' | 'tool_results' | 'compact_summary', ts, content: [blocks] }
//   { id, role: 'assistant', ts, model, content: [blocks], stopReason, usage, interrupted? }
//   { id, role: 'event', kind, ts, text?, ... }   (shown in the app, never sent to the model)
// Text blocks with `hidden: true` go to the model but are not shown as the user's words.
// Compaction blocks in assistant messages come from the model's own compaction: { type: 'compaction',
// content } from Claude (readable text), { type: 'compaction', encrypted, id } from OpenAI (only the model
// that wrote it can read it).

/**
 * Messages a model sees: everything from the latest compaction point it can use, without events.
 * - Caliope's own summary and Claude's compaction block work for every model. OpenAI's encrypted
 *   compaction only for `modelId`, the model that wrote it. Without `modelId`, only readable points count.
 * - In the message that holds the compaction block, the blocks before it are left out.
 */
export function apiHistory(messages, modelId = null) {
  let start = 0;
  let firstBlock = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const usable = (block) => block.type === 'compaction' && (typeof block.content === 'string' || (Boolean(block.encrypted) && Boolean(modelId) && message.model === modelId));
    const blockIndex = message.role === 'assistant' ? message.content.findLastIndex(usable) : -1;
    if (message.kind !== 'compact_summary' && blockIndex === -1) continue;
    start = i;
    firstBlock = Math.max(0, blockIndex);
    break;
  }
  const history = messages.slice(start).filter((message) => message.role === 'user' || message.role === 'assistant');
  if (firstBlock > 0) history[0] = { ...history[0], content: history[0].content.slice(firstBlock) };
  return history;
}

/** The newest compaction: Caliope's summary message (`block` null) or a model's compaction block; null without one. */
export function latestCompaction(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind === 'compact_summary') return { message, block: null };
    const block = message.role === 'assistant' ? message.content.findLast((item) => item.type === 'compaction' && (item.content || item.encrypted)) : null;
    if (block) return { message, block };
  }
  return null;
}

/** The text that stands for a compaction summary when it goes to a model as plain text. */
export function summaryText(summary) {
  const text = `<conversation_summary>\n${summary}\n</conversation_summary>\nThis summary replaces the earlier part of the conversation. Continue the work from here.`;
  return text;
}

/** "user" when the person just wrote something; "agent" for tool-result follow-ups. */
export function initiatorFor(history) {
  const last = history[history.length - 1];
  if (!last || last.role !== 'user') return 'agent';
  const userWrote = last.kind === 'prompt' && !last.auto && last.content.some((block) => block.type === 'text' && !block.hidden);
  return userWrote ? 'user' : 'agent';
}

export function historyHasImages(history) {
  const hasImages = history.some((message) =>
    message.content.some((block) => block.type === 'image' || (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some((part) => part.type === 'image'))),
  );
  return hasImages;
}

/**
 * A tool result as text, for the OpenAI formats, which take no images in tool results.
 * - Images go along in the next user message. The text says so.
 */
export function toolResultText(block) {
  const prefix = block.is_error ? 'Error: ' : '';
  if (typeof block.content === 'string') return prefix + (block.content || '(no output)');
  const text = (block.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const hasImage = (block.content || []).some((part) => part.type === 'image');
  const resultText = prefix + (text || '(no output)') + (hasImage ? '\n(The image is attached in the next message.)' : '');
  return resultText;
}

/**
 * Rough size of the next request in tokens: the last reported prompt size plus what was added since.
 * - Uses 3.5 characters per token for the added part.
 */
export function estimateContextTokens(history, systemPrompt) {
  let base = 0;
  let addedChars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role === 'assistant' && message.usage && (message.usage.input || message.usage.cacheRead)) {
      base = (message.usage.input || 0) + (message.usage.cacheRead || 0) + (message.usage.cacheWrite || 0) + (message.usage.output || 0);
      break;
    }
    addedChars += messageChars(message);
  }
  if (base === 0) addedChars += (systemPrompt || '').length;
  const estimate = Math.round(base + addedChars / 3.5);
  return estimate;
}

function messageChars(message) {
  let total = 0;
  for (const block of message.content) {
    if (block.type === 'text') total += block.text.length;
    else if (block.type === 'tool_use') total += JSON.stringify(block.input ?? {}).length;
    else if (block.type === 'tool_result') total += typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length / 4;
    else if (block.type === 'image') total += 6000;
    else if (block.type === 'thinking') total += (block.thinking || '').length;
    else if (block.type === 'compaction') total += (block.content || '').length;
  }
  return total;
}

/**
 * Plain-text transcript for the compaction summary.
 * - Long tool output is shortened. When the whole transcript is too long, middle entries are dropped
 *   (the opening request and the most recent work matter most).
 */
export function renderTranscript(history, maxChars) {
  const entries = [];
  for (const message of history) {
    if (message.kind === 'compact_summary') {
      entries.push(`EARLIER SUMMARY:\n${textOf(message, true)}`);
      continue;
    }
    if (message.role === 'user') {
      const visible = textOf(message, false);
      if (visible) entries.push(`USER: ${visible}`);
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue;
        const content = typeof block.content === 'string' ? block.content : block.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        entries.push(`TOOL RESULT${block.is_error ? ' (error)' : ''}: ${shorten(content, 1500)}`);
      }
    } else {
      for (const block of message.content) {
        if (block.type === 'compaction' && block.content) entries.push(`EARLIER SUMMARY:\n${block.content}`);
        if (block.type === 'text' && block.text.trim()) entries.push(`ASSISTANT: ${block.text.trim()}`);
        if (block.type === 'tool_use') entries.push(`TOOL CALL ${block.name}: ${shorten(JSON.stringify(block.input ?? {}), 1200)}`);
      }
    }
  }
  let total = entries.reduce((sum, entry) => sum + entry.length + 2, 0);
  if (total <= maxChars) return entries.join('\n\n');
  const head = entries.slice(0, 3);
  const tail = entries.slice(3);
  let omitted = 0;
  while (tail.length > 1 && total > maxChars) {
    total -= tail.shift().length + 2;
    omitted++;
  }
  const transcript = [...head, `[… ${omitted} earlier entries omitted …]`, ...tail].join('\n\n');
  return transcript;
}

function textOf(message, includeHidden) {
  const text = message.content
    .filter((block) => block.type === 'text' && (includeHidden || !block.hidden))
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text;
}

function shorten(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/** The visible text and images of a user prompt, for putting it back in the composer. */
export function promptContent(message) {
  const text = message.content
    .filter((block) => block.type === 'text' && !block.hidden)
    .map((block) => block.text)
    .join('\n');
  const images = message.content.filter((block) => block.type === 'image').map((block) => ({ mediaType: block.mediaType, data: block.data }));
  return { text, images };
}

/** The latest todo list and approved plan in the remaining messages (used after a rewind). */
export function recoverTodosAndPlan(messages) {
  let todos = [];
  let plan = null;
  const toolUses = new Map();
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block.type === 'tool_use') toolUses.set(block.id, block);
      if (block.type === 'tool_result') {
        const toolUse = toolUses.get(block.tool_use_id);
        if (!toolUse) continue;
        if (toolUse.name === 'todo_write' && !block.is_error && Array.isArray(toolUse.input?.todos)) todos = toolUse.input.todos;
        if (toolUse.name === 'present_plan' && block.meta?.approved) plan = toolUse.input?.plan || null;
      }
    }
  }
  return { todos, plan };
}

export function isPromptTooLong(error) {
  return error?.status === 400 && /prompt is too long|context.?length|context window|context limit|maximum context|too many tokens|max_prompt_tokens|exceeds the limit/i.test(error.message || '');
}
