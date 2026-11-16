// The three request formats Copilot offers, chosen per model (see normalizeModel in copilot.js):
// Anthropic Messages for Claude, Responses for GPT-5 and later, Chat Completions for the rest.
import { buildAnthropicRequest, adaptationFor400, AnthropicStreamAccumulator, anthropicBetas } from './protocol-anthropic.js';
import { buildOpenAiRequest, openAiAdaptationFor400, OpenAiStreamAccumulator } from './protocol-openai.js';
import { buildResponsesRequest, responsesAdaptationFor400, ResponsesStreamAccumulator } from './protocol-responses.js';

const PROTOCOLS = {
  messages: { path: '/v1/messages', anthropic: true, nativeCompaction: true, buildRequest: buildAnthropicRequest, Accumulator: AnthropicStreamAccumulator, adaptationFor400, betas: anthropicBetas },
  responses: { path: '/responses', anthropic: false, nativeCompaction: true, buildRequest: buildResponsesRequest, Accumulator: ResponsesStreamAccumulator, adaptationFor400: responsesAdaptationFor400, betas: () => [] },
  chat: { path: '/chat/completions', anthropic: false, nativeCompaction: false, buildRequest: buildOpenAiRequest, Accumulator: OpenAiStreamAccumulator, adaptationFor400: openAiAdaptationFor400, betas: () => [] },
};

/**
 * Endpoint, request builder, stream accumulator and 400 adaptations for a model.
 * - `nativeCompaction`: the model can compact the conversation itself (Claude and OpenAI Responses).
 * - `betas(body)`: anthropic-beta values the request needs.
 */
export function protocolFor(model) {
  const protocol = PROTOCOLS[model.protocol] || PROTOCOLS.chat;
  return protocol;
}
