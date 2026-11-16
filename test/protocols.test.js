import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toAnthropicMessages, buildAnthropicRequest, adaptationFor400, AnthropicStreamAccumulator, anthropicBetas } from '../server/protocol-anthropic.js';
import { toOpenAiMessages, buildOpenAiRequest, openAiAdaptationFor400, OpenAiStreamAccumulator } from '../server/protocol-openai.js';
import { toResponsesInput, buildResponsesRequest, responsesAdaptationFor400, ResponsesStreamAccumulator } from '../server/protocol-responses.js';
import { apiHistory, initiatorFor, recoverTodosAndPlan, renderTranscript, isPromptTooLong } from '../server/conversation.js';
import { CopilotClient, toApiError } from '../server/copilot.js';
import { streamModelRequest } from '../server/turn-helpers.js';

/** A 400 from Copilot with this JSON body, as the client throws it. */
function refusal(body) {
  const error = toApiError(new Response(JSON.stringify(body), { status: 400 }), 'Copilot request failed');
  return error;
}

/** A streamed response with these events, as Copilot sends it. */
function sseResponse(events, { done = true } = {}) {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (done) lines.push('data: [DONE]\n\n');
  const response = new Response(lines.join(''));
  return response;
}

test('a prompt that is too long is recognized in the wordings of Anthropic, OpenAI and Copilot', () => {
  for (const message of ['input length and `max_tokens` exceed context limit: 190000 + 64000 > 200000', 'prompt is too long: 210000 tokens > 200000 maximum', 'This model\'s maximum context length is 272000 tokens', 'prompt token count of 280000 exceeds the limit of 272000']) {
    assert.ok(isPromptTooLong({ status: 400, message }), message);
  }
  assert.ok(!isPromptTooLong({ status: 400, message: 'tools.0.name: invalid' }));
});

const model = { id: 'claude-opus-5.5', efforts: ['low', 'medium', 'high'], protocol: 'messages' };
const tools = [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: {}, required: [] } }];

const history = [
  { id: '1', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '<system-reminder>x</system-reminder>', hidden: true }] },
  { id: '2', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }] },
  { id: '3', role: 'user', kind: 'tool_results', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data', meta: { path: 'a' } }] },
  { id: '4', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'and then' }] },
  { id: '5', role: 'event', kind: 'mode', text: 'Plan' },
];

test('toAnthropicMessages merges same-role turns, puts tool results first, strips app fields', () => {
  const messages = toAnthropicMessages(history.filter((message) => message.role !== 'event'));
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig' });
  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.equal(messages[2].content[1].text, 'and then');
  assert.equal(messages[2].content[0].meta, undefined);
  assert.equal(messages[0].content[1].hidden, undefined);
});

test('toAnthropicMessages drops unsigned thinking and appends a user turn after a trailing assistant', () => {
  const messages = toAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'from another protocol' }, { type: 'text', text: 'a' }] },
  ]);
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages.at(-1).role, 'user');
});

test('buildAnthropicRequest sets effort, adaptive thinking and cache breakpoints, and honours adaptations', () => {
  const body = buildAnthropicRequest({ model, system: 'sys', tools, history: history.slice(0, 4), effort: 'medium', maxTokens: 64000, thinkingDisplay: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(body.tools[0].input_schema.type, 'object');
  const adapted = buildAnthropicRequest({ model, system: 'sys', tools, history: history.slice(0, 4), effort: 'xhigh', maxTokens: 1000, thinkingDisplay: 'summarized', adaptations: { noDisplay: true, noCacheControl: true } });
  assert.deepEqual(adapted.thinking, { type: 'adaptive' });
  assert.equal(adapted.output_config, undefined, 'unsupported effort is left out');
  assert.equal(adapted.system[0].cache_control, undefined);
});

test('a 400 turns off only the optional field it names', async () => {
  const anthropic = async (message) => adaptationFor400(await refusal({ type: 'error', error: { type: 'invalid_request_error', message } }), {});
  assert.equal(await anthropic('thinking.display: Extra inputs are not permitted'), 'noDisplay');
  assert.equal(await anthropic('system.0.cache_control: Extra inputs are not permitted'), 'noCacheControl');
  assert.equal(await anthropic('context_management: Extra inputs are not permitted'), 'noCompaction');
  assert.equal(adaptationFor400(await refusal({ error: { message: 'Reasoning effort xhigh is not supported for this model.', code: 'invalid_reasoning_effort' } }), {}), 'noEffort');
  // Errors about something else, though their text has "thinking", "display" or "summary" in it.
  assert.equal(await anthropic('messages.1.content.0: Invalid `signature` in `thinking` block'), null);
  assert.equal(await anthropic('messages.2.content.0.type: Expected `thinking` or `redacted_thinking`, but found `text`.'), null);
  assert.equal(await anthropic('max_tokens: must be below 64000 when thinking is on, to display a summary'), null);
  assert.equal(await anthropic('Each tool result must include a `tool_use_id`.'), null);
  // A bare field name, a field in a plain sentence, and the upstream error passed on as JSON text.
  assert.equal(await anthropic('This model does not support `effort`.'), 'noEffort');
  assert.equal(await anthropic('adaptive thinking is not supported on this model'), 'noThinking');
  const upstream = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.display: Extra inputs are not permitted' } });
  assert.equal(adaptationFor400(await refusal({ error: { message: upstream } }), {}), 'noDisplay');

  const responses = async (error) => responsesAdaptationFor400(await refusal({ error }), {});
  assert.equal(await responses({ message: "Invalid value: 'reasoning.encrypted_content'.", param: 'include[0]', code: 'invalid_value' }), 'noEncrypted', 'a path with an index');
  assert.equal(await responses({ message: "Unsupported parameter: 'reasoning.summary' is not supported with this model.", param: 'reasoning.summary', code: 'unsupported_parameter' }), 'noSummary');
  assert.equal(await responses({ message: 'Encrypted content is not supported with this model.', param: 'include' }), 'noEncrypted');
  assert.equal(await responses({ message: "Unknown parameter: 'context_management'." }), 'noCompaction');
  assert.equal(await responses({ message: 'Each function_call_output must include a call_id.', param: 'input' }), null, 'encrypted reasoning stays on');
  assert.equal(await responses({ message: 'Invalid request: a tool result must include an id and a summary.' }), null);
  assert.equal(await responses({ message: 'The encrypted content could not be decrypted.', code: 'invalid_encrypted_content' }), null);

  const chat = async (error) => openAiAdaptationFor400(await refusal({ error }), {});
  assert.equal(await chat({ message: "Unrecognized request argument supplied: 'stream_options'" }), 'noStreamOptions');
  assert.equal(await chat({ message: 'This model does not support it.', param: 'reasoning_effort' }), 'noEffort');
  assert.equal(await chat({ message: 'The effort you asked for must include a plan.' }), null);
});

test('a refused field is left out with a notice, and a restart remembers it; a refused value only lasts this run', async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-adaptations-')), 'models.json');
  const sol = { id: 'gpt-6-sol', name: 'GPT-6 Sol', protocol: 'responses', efforts: ['xhigh'] };
  const request = { request: { model: sol, system: 'S', tools: [], history: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], effort: 'xhigh', maxTokens: 1000 } };
  const bodies = [];
  const client = new CopilotClient({ auth: null, log: null, cacheFile });
  client.post = async (pathname, body) => {
    bodies.push(body);
    if (body.reasoning?.summary) throw await refusal({ error: { message: "Unsupported parameter: 'reasoning.summary'", param: 'reasoning.summary' } });
    if (body.reasoning?.effort) throw await refusal({ error: { message: 'Reasoning effort xhigh is not supported for this model.', code: 'invalid_reasoning_effort' } });
    return sseResponse([{ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } }]);
  };
  const notices = [];
  await streamModelRequest({ client, model: sol, adaptations: client.adaptationsFor(sol.id), makeRequest: () => request, onNotice: (text) => notices.push(text) });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1].reasoning.summary, undefined, 'the retry leaves the field out');
  assert.deepEqual(bodies[1].include, ['reasoning.encrypted_content'], 'the rest stays');
  assert.deepEqual(notices, [
    'Copilot refused reasoning summaries for GPT-6 Sol. It stays off for this model until Caliope updates or the model list is refreshed in Settings.',
    'Copilot refused the reasoning settings for GPT-6 Sol. It stays off for this model until Caliope restarts or the model list is refreshed in Settings.',
  ]);
  assert.deepEqual(client.adaptationsFor(sol.id), { noSummary: true, noReasoning: true });

  const restarted = new CopilotClient({ auth: null, log: null, cacheFile });
  await restarted.loadCachedModels();
  assert.deepEqual(restarted.adaptationsFor(sol.id), { noSummary: true }, 'the refused effort level is not saved');
  // Two refusals close together both reach the file. A refresh of the model list forgets them all.
  await Promise.all([restarted.saveAdaptation('claude-opus-5.5', 'noDisplay'), restarted.saveAdaptation('gpt-4.1', 'noStreamOptions')]);
  const again = new CopilotClient({ auth: null, log: null, cacheFile });
  await again.loadCachedModels();
  assert.deepEqual([again.adaptationsFor(sol.id), again.adaptationsFor('claude-opus-5.5'), again.adaptationsFor('gpt-4.1')], [{ noSummary: true }, { noDisplay: true }, { noStreamOptions: true }]);
  await again.clearAdaptations();
  assert.deepEqual(again.adaptationsFor(sol.id), {});
  const refreshed = new CopilotClient({ auth: null, log: null, cacheFile });
  await refreshed.loadCachedModels();
  assert.deepEqual(refreshed.adaptationsFor(sol.id), {});
  // Saved by another version: a new version tries the field again.
  const adaptationsFile = path.join(path.dirname(cacheFile), 'model-adaptations.json');
  fs.writeFileSync(adaptationsFile, JSON.stringify({ version: '0.0.1', models: { [sol.id]: { noSummary: true } } }));
  const updated = new CopilotClient({ auth: null, log: null, cacheFile });
  await updated.loadCachedModels();
  assert.deepEqual(updated.adaptationsFor(sol.id), {});
});

test('a stream that ends early still counts as a request, without tokens or cost when its usage never came', async () => {
  const gpt = { id: 'gpt-4.1', name: 'GPT-4.1', protocol: 'chat', efforts: [] };
  const request = { request: { model: gpt, system: 'S', tools: [], history: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], maxTokens: 1000 } };
  const streams = [
    sseResponse([{ choices: [{ index: 0, delta: { content: 'Half an ans' } }] }], { done: false }),
    sseResponse([{ choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 }, copilot_usage: { total_nano_aiu: 7 } }]),
  ];
  const unfinished = [];
  const client = { post: async () => streams.shift() };
  const result = await streamModelRequest({ client, model: gpt, adaptations: {}, makeRequest: () => request, onUnfinished: (usage) => unfinished.push(usage) });
  assert.deepEqual(unfinished, [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: null, cut: true }], 'the cut attempt counts once, marked as cut');
  assert.equal(result.usage.nanoAiu, 7, 'the retry counts itself');

  // A failure after the start keeps what Copilot counted for it.
  const sol = { id: 'gpt-6-sol', name: 'GPT-6 Sol', protocol: 'responses', efforts: [] };
  const failing = { post: async () => sseResponse([{ type: 'response.failed', response: { error: { code: 'invalid_prompt', message: 'Refused.' }, usage: { input_tokens: 40, output_tokens: 3 } } }]) };
  await assert.rejects(streamModelRequest({ client: failing, model: sol, adaptations: {}, makeRequest: () => ({ request: { ...request.request, model: sol } }), onUnfinished: (usage) => unfinished.push(usage) }), /Refused/);
  assert.deepEqual(unfinished[1], { input: 40, output: 3, cacheRead: 0, cacheWrite: 0, nanoAiu: null, cut: true });
});

test('AnthropicStreamAccumulator assembles thinking, text and tool input; ignores the [DONE] terminator', () => {
  const accumulator = new AnthropicStreamAccumulator();
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 90 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu', name: 'read_file', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pa' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"x"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 }, copilot_usage: { total_nano_aiu: 1500000000 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) accumulator.handle({ event, data: JSON.stringify(data) });
  accumulator.handle({ event: 'message', data: '[DONE]' });
  const result = accumulator.result();
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: 'hmm', signature: 'abc' },
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'tu', name: 'read_file', input: { path: 'x' } },
  ]);
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.usage.nanoAiu, 1500000000);
  assert.equal(result.usage.cacheRead, 90);
  assert.ok(result.finished);
});

test('AnthropicStreamAccumulator keeps cost unknown when Copilot reports none, and surfaces stream errors', () => {
  const accumulator = new AnthropicStreamAccumulator();
  accumulator.handle({ event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) });
  assert.equal(accumulator.result().usage.nanoAiu, null);
  assert.throws(() => accumulator.handle({ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }), /Overloaded/);
});

test('OpenAI conversion places tool messages right after the assistant call', () => {
  const messages = toOpenAiMessages('sys', history.filter((message) => message.role !== 'event'));
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"path":"a"}');
  const body = buildOpenAiRequest({ model: { id: 'gpt-5-mini', efforts: ['low'] }, system: 'sys', tools, history: [], effort: 'low', maxTokens: 100 });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.tools[0].type, 'function');
});

test('OpenAiStreamAccumulator merges tool-call fragments across chunks and choices', () => {
  const accumulator = new OpenAiStreamAccumulator();
  const chunks = [
    { choices: [{ index: 0, delta: { content: 'Look' } }] },
    { choices: [{ index: 1, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path"' } }] } }] },
    { choices: [{ index: 1, delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 5000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4000 } }, copilot_usage: { total_nano_aiu: 0 } },
  ];
  for (const chunk of chunks) accumulator.handle({ data: JSON.stringify(chunk) });
  accumulator.handle({ data: '[DONE]' });
  const result = accumulator.result();
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.content.at(-1), { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } });
  assert.equal(result.usage.nanoAiu, 0, 'a reported cost of zero stays zero');
  assert.equal(result.usage.input, 1000, 'cached tokens are not counted twice');
  assert.equal(result.usage.cacheRead, 4000);
});

test('ResponsesStreamAccumulator: reasoning, text and calls; a refusal ends the turn as declined', () => {
  const events = (list) => {
    const accumulator = new ResponsesStreamAccumulator();
    for (const payload of list) accumulator.handle({ data: JSON.stringify(payload) });
    return accumulator.result();
  };
  const normal = events([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Look first.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'enc' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.txt"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 7 } }, copilot_usage: { total_nano_aiu: 5 } },
  ]);
  assert.deepEqual(normal.content, [{ type: 'thinking', thinking: 'Look first.', encrypted: 'enc' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }]);
  assert.equal(normal.stopReason, 'tool_use');
  assert.deepEqual(normal.usage, { input: 40, output: 7, cacheRead: 60, cacheWrite: 0, nanoAiu: 5 });
  const refused = events([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.refusal.delta', output_index: 0, delta: 'I cannot help with that.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] } },
    { type: 'response.completed', response: {} },
  ]);
  assert.deepEqual(refused.content, [{ type: 'text', text: 'I cannot help with that.' }]);
  assert.equal(refused.stopReason, 'refusal');
  const input = toResponsesInput([
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'signed', signature: 'sig' }, { type: 'thinking', thinking: 'mine', encrypted: 'enc' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data', is_error: true }] },
  ]);
  assert.deepEqual(input.map((item) => item.type || item.role), ['user', 'reasoning', 'assistant', 'function_call', 'function_call_output'], "Claude's signed thinking is not sent");
  assert.equal(input[4].output, 'Error: data');
});

test('conversation helpers: history window, initiator, recovery, transcript', () => {
  const withSummary = [...history, { id: '6', role: 'user', kind: 'compact_summary', content: [{ type: 'text', text: 'summary', hidden: true }] }, { id: '7', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'next' }] }];
  assert.deepEqual(apiHistory(withSummary).map((message) => message.id), ['6', '7']);
  assert.equal(initiatorFor(apiHistory(withSummary)), 'user');
  assert.equal(initiatorFor(history.slice(0, 3)), 'agent');
  const recovered = recoverTodosAndPlan([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'todo_write', input: { todos: [{ content: 'x', status: 'pending' }] } }, { type: 'tool_use', id: 'b', name: 'present_plan', input: { plan: 'P' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'tool_result', tool_use_id: 'b', content: 'ok', meta: { approved: true } }] },
  ]);
  assert.equal(recovered.plan, 'P');
  assert.equal(recovered.todos.length, 1);
  const long = Array.from({ length: 50 }, (_, i) => ({ role: 'user', kind: 'prompt', content: [{ type: 'text', text: `message ${i} ${'x'.repeat(100)}` }] }));
  const transcript = renderTranscript(long, 2000);
  assert.ok(transcript.length < 2600);
  assert.match(transcript, /message 0/);
  assert.match(transcript, /message 49/);
  assert.match(transcript, /earlier entries omitted/);
});

// A session where Claude compacted once and GPT-6 Sol later compacted with its own encrypted item.
const compacted = [
  { id: 'u1', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Build the invoice export' }] },
  { id: 'a1', role: 'assistant', model: 'claude-opus-5.5', content: [{ type: 'text', text: 'Early answer' }] },
  { id: 'u2', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Continue' }] },
  { id: 'a2', role: 'assistant', model: 'claude-opus-5.5', content: [{ type: 'compaction', content: 'Summary: export invoices as CSV.' }, { type: 'text', text: 'After the summary' }] },
  { id: 'u3', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Now on GPT' }] },
  { id: 'a3', role: 'assistant', model: 'gpt-6-sol', content: [{ type: 'text', text: 'Before its compaction' }, { type: 'compaction', encrypted: 'cmp_gpt-6-sol_0', id: 'cmp_1' }, { type: 'text', text: 'GPT reply' }] },
  { id: 'u4', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Next step' }] },
];

test('the history a model sees starts at the latest compaction it can read', () => {
  const sol = apiHistory(compacted, 'gpt-6-sol');
  assert.deepEqual(sol.map((message) => message.id), ['a3', 'u4'], 'GPT reads its own compaction');
  assert.deepEqual(sol[0].content.map((block) => block.type), ['compaction', 'text'], 'what came before the block in that message is left out');
  assert.deepEqual(apiHistory(compacted, 'claude-opus-5.5').map((message) => message.id), ['a2', 'u3', 'a3', 'u4'], "another model starts at Claude's readable summary");
  assert.deepEqual(apiHistory(compacted).map((message) => message.id), ['a2', 'u3', 'a3', 'u4']);
  assert.match(renderTranscript(apiHistory(compacted), 10000), /EARLIER SUMMARY:\nSummary: export invoices as CSV\./);
});

test('compaction blocks go to each format in a form it can use', () => {
  const claudeHistory = apiHistory(compacted, 'claude-opus-5.5');
  const messages = toAnthropicMessages(claudeHistory);
  const blocks = messages.flatMap((message) => message.content);
  assert.deepEqual(blocks.find((block) => block.type === 'compaction'), { type: 'compaction', content: 'Summary: export invoices as CSV.' });
  assert.ok(!JSON.stringify(messages).includes('cmp_gpt-6-sol'), "OpenAI's encrypted compaction never goes to Claude");
  const asText = toAnthropicMessages(claudeHistory, { compactionBlocks: false }).flatMap((message) => message.content);
  assert.ok(!asText.some((block) => block.type === 'compaction'));
  assert.ok(asText.some((block) => block.type === 'text' && block.text.includes('Summary: export invoices as CSV.')));

  const body = buildAnthropicRequest({ model, system: 'S', tools, history: claudeHistory, maxTokens: 1000, thinkingDisplay: 'summarized', compactAt: 30000 });
  assert.equal(body.context_management.edits[0].trigger.value, 50000, 'never below the API minimum');
  assert.deepEqual(anthropicBetas(body), ['compact-2026-01-12']);
  const noCompaction = buildAnthropicRequest({ model, system: 'S', tools, history: history.slice(0, 1), maxTokens: 1000, thinkingDisplay: 'summarized', adaptations: { noCompaction: true }, compactAt: 150000 });
  assert.equal(noCompaction.context_management, undefined);
  assert.deepEqual(anthropicBetas(noCompaction), []);

  const solInput = toResponsesInput(apiHistory(compacted, 'gpt-6-sol'), 'gpt-6-sol');
  assert.deepEqual(solInput[0], { type: 'compaction', encrypted_content: 'cmp_gpt-6-sol_0', id: 'cmp_1' });
  const lunaInput = toResponsesInput(apiHistory(compacted, 'gpt-6-luna'), 'gpt-6-luna');
  assert.ok(!lunaInput.some((item) => item.type === 'compaction'), 'another GPT model cannot read it');
  assert.match(lunaInput[0].content[0].text, /<conversation_summary>\nSummary: export invoices as CSV\./);
  const responsesBody = buildResponsesRequest({ model: { id: 'gpt-6-sol', efforts: [] }, system: 'S', tools, history: [], maxTokens: 1000, compactAt: 150000 });
  assert.deepEqual(responsesBody.context_management, [{ type: 'compaction', compact_threshold: 150000 }]);
  const chat = toOpenAiMessages('S', apiHistory(compacted, 'gemini-3.8-flash'));
  assert.ok(chat.some((message) => message.role === 'user' && message.content.includes('Summary: export invoices as CSV.')));
});

test('stream accumulators keep the compaction a model returns', () => {
  const claude = new AnthropicStreamAccumulator();
  for (const data of [
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null } },
    { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'Summary so far.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]) claude.handle({ data: JSON.stringify(data) });
  assert.deepEqual(claude.result().content, [{ type: 'compaction', content: 'Summary so far.' }, { type: 'text', text: 'Done.' }]);

  const gpt = new ResponsesStreamAccumulator();
  for (const data of [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'cmp_1', type: 'compaction' } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'cmp_1', type: 'compaction', encrypted_content: 'secret' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', content: [{ type: 'output_text', text: 'OK' }] } },
    { type: 'response.completed', response: {} },
  ]) gpt.handle({ data: JSON.stringify(data) });
  assert.deepEqual(gpt.result().content, [{ type: 'compaction', encrypted: 'secret', id: 'cmp_1' }, { type: 'text', text: 'OK' }]);
});
