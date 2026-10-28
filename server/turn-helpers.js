// Pieces shared by the main agent loop, subagents and one-off requests: the model request with its
// retries, tool result blocks and stream error checks.
import { ApiError } from './copilot.js';
import { readSseEvents } from './sse-parser.js';
import { protocolFor } from './protocols.js';
import { sleep, isAbortError } from './util.js';

const MAX_TOOL_RESULT_CHARS = 60000;
const MAX_STREAM_RETRIES = 3;

export class StreamCutError extends Error {}

/**
 * One streamed model request through Copilot, with the retries every caller needs.
 * - `makeRequest()` runs before each attempt and returns { request, initiator, vision }: the
 *   protocol builder's input (without `adaptations`) and the request headers' details.
 * - A 400 goes to `onBadRequest(error)` first, which returns true to retry (the main loop compacts a
 *   prompt that is too long). Otherwise, a 400 that names an optional field leaves that field out from
 *   then on (remembered per model in `adaptations`) and tries again.
 * - A cut or overloaded stream is retried up to 3 times, with `onWait({ attempt, waitMs, reason })` first.
 * - `onDeltas(deltas)` gets the UI deltas as they arrive. On a stop by the user, the error carries
 *   `partial`: the text received so far.
 * - `onUnfinished(usage)` gets the usage of an attempt that started streaming but did not finish (cut off,
 *   failed or stopped): Copilot accepted it, so it counts in the spending.
 * - Returns the accumulator's result: { content, stopReason, stopDetails, usage, model }.
 */
export async function streamModelRequest({ client, log, model, adaptations, signal, makeRequest, onDeltas, onWait, onBadRequest, onUnfinished }) {
  const protocol = protocolFor(model);
  let streamRetries = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const accumulator = new protocol.Accumulator();
    let streaming = false;
    try {
      const { request, initiator = 'agent', vision = false } = makeRequest();
      const body = protocol.buildRequest({ ...request, adaptations });
      const response = await client.post(protocol.path, body, { signal, initiator, vision, anthropic: protocol.anthropic, betas: protocol.betas(body), onRetry: onWait });
      streaming = true;
      for await (const event of readSseEvents(response.body)) {
        const deltas = accumulator.handle(event);
        if (deltas.length > 0) onDeltas?.(deltas);
      }
      const result = accumulator.result();
      if (!result.finished && !result.stopReason) throw new StreamCutError('The response stream ended early.');
      return result;
    } catch (error) {
      // Without any usage reported yet there is nothing to count. A later attempt counts itself.
      const { input, output, nanoAiu } = accumulator.usage;
      if (streaming && (input || output || nanoAiu !== null)) onUnfinished?.({ ...accumulator.usage });
      if (signal?.aborted || isAbortError(error)) {
        error.partial = accumulator.partialText();
        throw error;
      }
      if (error instanceof ApiError && error.status === 400) {
        if (await onBadRequest?.(error)) continue;
        const change = protocol.adaptationFor400(error.message, adaptations);
        if (change) {
          adaptations[change] = true;
          log?.info(`Model ${model.id}: leaving out an optional field after a 400 (${change}): ${error.message}`);
          continue;
        }
      }
      const retryable = error instanceof StreamCutError || error.streamErrorType === 'overloaded_error' || error.streamErrorType === 'api_error' || isConnectionDrop(error);
      if (retryable && streamRetries < MAX_STREAM_RETRIES) {
        streamRetries++;
        const waitMs = 1500 * 2 ** (streamRetries - 1);
        onWait?.({ attempt: streamRetries, waitMs, reason: error.message });
        await sleep(waitMs, signal);
        continue;
      }
      throw error;
    }
  }
  throw new Error('The request kept failing after adjusting optional fields.');
}

/** True for a dropped connection while streaming, which is worth one more try. */
export function isConnectionDrop(error) {
  const code = error?.cause?.code || error?.code;
  const droppedFetch = error?.name === 'TypeError' && /terminated|network|socket/i.test(error.message);
  return droppedFetch || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT'].includes(code);
}

export function errorResult(toolUse, message, meta = {}) {
  return { type: 'tool_result', tool_use_id: toolUse.id, content: message, is_error: true, meta };
}

/** A tool's result as a stored tool_result block; very long text is cut. */
export function toolResultBlock(toolUse, result) {
  let content = result.content;
  if (typeof content === 'string' && content.length > MAX_TOOL_RESULT_CHARS) {
    content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n… [${content.length - MAX_TOOL_RESULT_CHARS} more characters cut]`;
  }
  const block = { type: 'tool_result', tool_use_id: toolUse.id, content, meta: result.meta || {} };
  if (result.isError) block.is_error = true;
  return block;
}
