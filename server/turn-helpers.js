// Pieces shared by the main agent loop, subagents and one-off requests: the model request with its
// retries, tool result blocks and stream error checks.
import { ApiError } from './copilot.js';
import { readSseEvents } from './sse-parser.js';
import { protocolFor } from './protocols.js';
import { sleep, isAbortError } from './util.js';

const MAX_TOOL_RESULT_CHARS = 60000;
const MAX_STREAM_RETRIES = 3;
// What the session loses when Copilot refuses an optional field, for the notice.
const ADAPTATION_FEATURES = {
  noCompaction: 'compaction by the model itself',
  noDisplay: 'the "Thinking shown" setting',
  noEffort: 'the effort level',
  noCacheControl: 'prompt caching',
  noThinking: 'thinking',
  noSummary: 'reasoning summaries',
  noEncrypted: 'encrypted reasoning',
  noMaxTokens: 'the output token limit',
  noReasoning: 'the reasoning settings',
  noStreamOptions: 'token counts in the stream',
};
// How Anthropic and OpenAI say that Copilot does not take a request field at all. Other 400s that name a
// field, such as invalid_reasoning_effort or "Unsupported value", refuse a value of it.
const FIELD_REFUSED = /extra inputs are not permitted|unknown[ _]parameter|unsupported[ _]parameter|unrecognized request argument/i;

export class StreamCutError extends Error {}

/**
 * One streamed model request through Copilot, with the retries every caller needs.
 * - `makeRequest()` runs before each attempt and returns { request, initiator, vision }: the
 *   protocol builder's input (without `adaptations`) and the request headers' details.
 * - A 400 goes to `onBadRequest(error)` first, which returns true to retry (the main loop compacts a
 *   prompt that is too long). Otherwise, a 400 that names an optional field leaves that field out from
 *   then on and tries again, and `onNotice(text)` gets a line for the session that says what is now off.
 * - A field Copilot does not take at all is saved per model, so it stays off after a restart (see
 *   CopilotClient.saveAdaptation). A refused value of a field is left out until Caliope restarts.
 * - A cut or overloaded stream is retried up to 3 times, with `onWait({ attempt, waitMs, reason })` first.
 * - `onDeltas(deltas)` gets the UI deltas as they arrive. On a stop by the user, the error carries
 *   `partial`: the text received so far.
 * - `onUnfinished(usage)` gets the usage of an attempt that started streaming but did not finish (cut off,
 *   failed or stopped), marked `cut: true`: Copilot accepted it, so it counts as a request. /chat/completions
 *   and /responses send their usage last, so a stream cut there reports no tokens and no cost (nanoAiu null).
 *   The ledger does not count such a request as unpriced (see UsageLedger.record).
 * - Returns the accumulator's result: { content, stopReason, stopDetails, usage, model }.
 */
export async function streamModelRequest({ client, log, model, adaptations, signal, makeRequest, onDeltas, onWait, onBadRequest, onUnfinished, onNotice }) {
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
      // Copilot accepted this attempt, so it counts: without tokens or cost when no usage arrived yet. A retry counts itself.
      if (streaming) onUnfinished?.({ ...accumulator.usage, cut: true });
      if (signal?.aborted || isAbortError(error)) {
        error.partial = accumulator.partialText();
        throw error;
      }
      if (error instanceof ApiError && error.status === 400) {
        if (await onBadRequest?.(error)) continue;
        const change = protocol.adaptationFor400(error, adaptations);
        if (change) {
          adaptations[change] = true;
          log?.info(`Model ${model.id}: leaving out an optional field after a 400 (${change}): ${error.message}`);
          // A refused value is not saved: another effort level, or Copilot after a change on its side, may take it.
          const fieldRefused = FIELD_REFUSED.test(error.message);
          if (fieldRefused) await client.saveAdaptation(model.id, change).catch((saveError) => log?.warn(`Could not save the fields Copilot refused: ${saveError.message}`));
          const until = fieldRefused ? 'Caliope updates' : 'Caliope restarts';
          onNotice?.(`Copilot refused ${ADAPTATION_FEATURES[change]} for ${model.name}. It stays off for this model until ${until} or the model list is refreshed in Settings.`);
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
