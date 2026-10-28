// End to end: the real server against the mock Copilot API, driven through the HTTP API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSseParser } from '../server/sse-parser.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 4655;
const APP_PORT = 4698;
const base = `http://127.0.0.1:${APP_PORT}`;
const children = [];
let cookie = '';
let apiKey = '';
let project = '';
let appData = '';
let localAppData = '';
let launchUrl = '';
const events = [];
const waiters = [];

function start(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out starting ${args.join(' ')}: ${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const ready = /MOCK READY|URL (\S+)/.exec(output);
      if (ready) {
        clearTimeout(timer);
        resolve(ready[1] || null);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
  });
}

async function api(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Cookie: cookie, 'X-Caliope': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(data?.error || response.statusText), { status: response.status });
  return data;
}

/** Wait for a server event matching `predicate` (events already received count). */
function waitFor(predicate, timeoutMs = 20000) {
  const found = events.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for an event')), timeoutMs);
    waiters.push({ predicate, resolve: (event) => { clearTimeout(timer); resolve(event); } });
  });
}

async function listen() {
  const response = await fetch(`${base}/api/events?key=${apiKey}`, { headers: { Cookie: cookie } });
  const decoder = new TextDecoder();
  const parser = createSseParser(({ data }) => {
    const event = JSON.parse(data);
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  (async () => {
    try {
      for await (const chunk of response.body) parser.push(decoder.decode(chunk, { stream: true }));
    } catch {
      // Closed at the end of the tests.
    }
  })();
}

async function runTurn(sessionId, text, { respond } = {}) {
  const startIndex = events.length;
  await api('POST', `/api/sessions/${sessionId}/messages`, { text });
  if (respond) {
    const answered = new Set();
    for (const answer of respond) {
      const waiting = await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === sessionId && event.runtime.waiting && !answered.has(event.runtime.waiting.id));
      answered.add(waiting.runtime.waiting.id);
      if (answer.kind) assert.equal(waiting.runtime.waiting.kind, answer.kind);
      await api('POST', `/api/sessions/${sessionId}/respond`, { waitId: waiting.runtime.waiting.id, ...answer.payload });
    }
  }
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === sessionId, 30000);
  const session = await api('GET', `/api/sessions/${sessionId}`);
  return session;
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-e2e-'));
  project = path.join(dataDir, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'Hello world\r\nSecond line\r\n');
  appData = path.join(dataDir, 'data');
  // A skill in Caliope's own skills folder. The app creates the folder, the test adds the skill up front.
  fs.mkdirSync(path.join(appData, 'skills', 'greeter'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'skills', 'greeter', 'SKILL.md'), '---\nname: greeter\ndescription: >\n  Greets people the house way.\n  Use for greetings.\n---\n\n# Greeter\n\nAlways greet in Dutch.\n');
  fs.writeFileSync(path.join(appData, 'skills', 'greeter', 'phrases.md'), 'Hallo!\n');
  // A stand-in for %LOCALAPPDATA%.
  localAppData = path.join(dataDir, 'localappdata');
  fs.mkdirSync(localAppData, { recursive: true });
  await start(['tools/mock-copilot.js', String(MOCK_PORT)], {});
  const mock = `http://127.0.0.1:${MOCK_PORT}`;
  const authUrl = await start(['server/main.js', '--stay', '--port', String(APP_PORT)], {
    CALIOPE_DATA_DIR: appData,
    CALIOPE_PRINT_URL: '1',
    CALIOPE_PLAIN_SECRETS: '1',
    CALIOPE_NO_BROWSER: '1',
    CALIOPE_BROWSER_HEADLESS: '1',
    LOCALAPPDATA: localAppData,
    CALIOPE_API_BASE: mock,
    CALIOPE_GITHUB_WEB: mock,
    CALIOPE_GITHUB_API: mock,
    CALIOPE_RELEASES_URL: `${mock}/__releases`,
    CALIOPE_AZURE_DEVOPS_URL: `${mock}/ado`,
  });
  launchUrl = authUrl;
  const auth = await fetch(authUrl, { redirect: 'manual' });
  cookie = auth.headers.get('set-cookie').split(';')[0];
  apiKey = new URLSearchParams(new URL(auth.headers.get('location'), base).hash.slice(1)).get('key');
  await listen();
  // The main test project is trusted. The trust prompt has its own test.
  await api('PUT', '/api/project', { folder: project, trusted: true });
});

test.after(() => {
  for (const child of children) child.kill();
});

test('the API refuses requests without the cookie, from other hosts, or without the header', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  // fetch() always sends the real Host header, so use http.request to fake a DNS-rebinding request.
  const rebindStatus = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: APP_PORT, path: '/api/state', headers: { Host: `evil.example:${APP_PORT}`, Cookie: cookie } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(rebindStatus, 421);
  const noHeader = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const cookieOnly = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(cookieOnly.status, 403, 'the cookie alone does not open the API');
  const crossSite = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, 'X-Caliope': apiKey, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossSite.status, 403);
  const html = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
});

test('sign-in: a bad token is refused with the server message, a good one is saved', async () => {
  await assert.rejects(api('POST', '/api/auth/token', { token: 'github_pat_wrong' }), /401/);
  await assert.rejects(api('POST', '/api/auth/token', { token: 'github_pat_mock_noaccess' }), /policy/);
  const status = await api('POST', '/api/auth/token', { token: 'github_pat_mock_good' });
  assert.equal(status.signedIn, true);
  assert.equal(status.login, 'mock-user');
  const { models, defaults } = await api('GET', '/api/models');
  assert.ok(models.length >= 5);
  assert.equal(defaults.plan, 'claude-opus-5.5');
  assert.equal(defaults.build, 'claude-opus-5.5');
  const allowance = await api('GET', '/api/allowance?refresh=1');
  assert.equal(allowance.allowance.entitlement, 1900);
});

test('an edit turn with approvals changes the file, records cost, and rewind restores it', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const id = session.meta.id;
  const done = await runTurn(id, 'Improve it [mock:edit notes.txt]', {
    respond: [
      { kind: 'permission', payload: { decision: 'allow' } },
      { kind: 'permission', payload: { decision: 'allow_session', prefix: 'Get-Content' } },
    ],
  });
  assert.equal(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), 'Hello world (edited by the agent)\r\nSecond line\r\n');
  assert.deepEqual(done.allowRules, ['Get-Content']);
  assert.ok(done.meta.usage.nanoAiu > 0);
  assert.ok(done.meta.usage.requests >= 4);
  const commandResult = done.messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result' && block.meta?.exitCode === 0);
  assert.match(commandResult.content, /edited by the agent/);
  await waitFor((event) => event.type === 'session' && event.meta.id === id && event.meta.titleSource === 'model');
  const firstPrompt = done.messages.find((message) => message.kind === 'prompt');
  const rewound = await api('POST', `/api/sessions/${id}/rewind`, { messageId: firstPrompt.id, restoreCode: true });
  assert.deepEqual(rewound.restored, ['notes.txt']);
  assert.equal(rewound.prompt.text, 'Improve it [mock:edit notes.txt]');
  assert.equal(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), 'Hello world\r\nSecond line\r\n');
  const after = await api('GET', `/api/sessions/${id}`);
  assert.equal(after.messages.length, 0);
});

test('plan mode uses the planning model, then building continues on the building model after approval', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'plan' });
  const id = session.meta.id;
  assert.equal(session.meta.model, 'claude-opus-5.5');
  const done = await runTurn(id, 'Add a greeting [mock:plan]', {
    respond: [
      { kind: 'plan', payload: { decision: 'revise', feedback: 'Add a farewell too' } },
      { kind: 'plan', payload: { decision: 'approve', mode: 'edits', effort: 'low' } },
    ],
  });
  assert.equal(done.meta.mode, 'edits');
  assert.equal(done.meta.model, 'claude-opus-5.5');
  assert.equal(done.meta.effort, 'low');
  assert.match(done.plan, /Revised after your feedback/);
  const requests = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json();
  const agentCalls = requests.filter((request) => request.path === '/v1/messages' && Array.isArray(request.body.tools) && request.body.tools.length > 0);
  const last = agentCalls.at(-1);
  assert.equal(last.body.model, 'claude-opus-5.5');
  assert.equal(last.body.output_config.effort, 'low');
  assert.ok(agentCalls.some((request) => request.body.model === 'claude-opus-5.5' && request.body.output_config.effort === 'high'), 'planning ran at the planning effort');
});

test('denying an action without feedback stops the turn and skips the remaining tool calls', async () => {
  fs.writeFileSync(path.join(project, 'important.txt'), 'keep');
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const done = await runTurn(session.meta.id, 'Clean up [mock:deny]', { respond: [{ kind: 'permission', payload: { decision: 'deny' } }] });
  assert.ok(fs.existsSync(path.join(project, 'important.txt')));
  const results = done.messages.flatMap((message) => message.content || []).filter((block) => block.type === 'tool_result');
  assert.ok(results[0].meta.denied);
  assert.ok(results[1].meta.notRun);
  assert.ok(done.messages.some((message) => message.role === 'event' && /turn stopped/.test(message.text || '')));
});

test('questions, todos and parallel tools', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const asked = await runTurn(id, 'Pick a color [mock:ask]', { respond: [{ kind: 'question', payload: { answer: 'Blue' } }] });
  assert.match(asked.messages.at(-1).content.at(-1).text, /Blue/);
  const todos = await runTurn(id, 'Do three things [mock:todo]');
  assert.equal(todos.todos.length, 3);
  assert.ok(todos.todos.every((todo) => todo.status === 'completed'));
  const multi = await runTurn(id, 'Look around [mock:multi]');
  const lastResults = multi.messages.filter((message) => message.kind === 'tool_results').at(-1);
  assert.equal(lastResults.content.length, 3);
  const usage = await api('GET', '/api/usage?period=all');
  assert.ok(usage.bySession.some((entry) => entry.sessionId === id));
});

test('recovers from a rate limit, a cut stream and a rejected optional field; reports refusals', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const limited = await runTurn(id, 'Go [mock:429]');
  assert.match(limited.messages.at(-1).content.at(-1).text, /after a rate limit/);
  const cut = await runTurn(id, 'Go [mock:cut]');
  assert.match(cut.messages.at(-1).content.at(-1).text, /cut and retried/);
  const adapted = await runTurn(id, 'Go [mock:nodisplay]');
  assert.match(adapted.messages.at(-1).content.at(-1).text, /without thinking.display/);
  const refused = await runTurn(id, 'Go [mock:refusal]');
  assert.ok(refused.messages.some((message) => message.role === 'event' && /declined/.test(message.text || '')));
});

test('a nearly full context is compacted before the next request', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  await runTurn(id, 'Big context [mock:long]');
  const next = await runTurn(id, 'Continue please');
  const summaryIndex = next.messages.findIndex((message) => message.kind === 'compact_summary');
  assert.ok(summaryIndex > 0);
  assert.ok(next.messages.some((message) => message.role === 'event' && message.kind === 'compact'));
  const requests = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json();
  const lastAgent = requests.filter((request) => request.path === '/v1/messages' && request.body.tools?.length).at(-1);
  assert.equal(lastAgent.body.messages[0].role, 'user');
  assert.match(JSON.stringify(lastAgent.body.messages[0].content), /conversation_summary/);
  assert.match(JSON.stringify(lastAgent.body.messages), /Continue please/, 'the message that triggered compaction is still sent');
  assert.ok(summaryIndex < next.messages.findIndex((message) => message.kind === 'prompt' && message.content[0].text === 'Continue please'));
});

test('a non-Claude model goes through Chat Completions', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  await api('PATCH', `/api/sessions/${id}`, { model: 'gpt-5-mini', effort: 'low' });
  const done = await runTurn(id, 'Hello');
  assert.match(done.messages.at(-1).content.at(-1).text, /mock/);
  const requests = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json();
  const chat = requests.filter((request) => request.path === '/chat/completions').at(-1);
  assert.equal(chat.body.model, 'gpt-5-mini');
  assert.equal(chat.body.reasoning_effort, 'low');
});

test('GPT-5 and later go through Responses: tools work, reasoning is replayed, and a switch to Claude and back keeps working', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  await api('PATCH', `/api/sessions/${id}`, { model: 'gpt-6-sol' });
  const edited = await runTurn(id, 'Improve it [mock:edit notes.txt]');
  assert.match(edited.messages.at(-1).content.at(-1).text, /changed the first line/);
  assert.match(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), /\(edited by the agent\)/);
  const thinking = edited.messages.flatMap((message) => message.content || []).find((block) => block.type === 'thinking');
  assert.ok(thinking.encrypted, 'the encrypted reasoning is kept');
  const requests = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json();
  const last = requests.filter((request) => request.path === '/responses').at(-1);
  assert.equal(last.body.store, false);
  assert.ok(last.body.input.some((item) => item.type === 'reasoning' && item.encrypted_content === thinking.encrypted), 'earlier reasoning goes back');
  assert.ok(last.body.input.some((item) => item.type === 'function_call_output'));
  assert.ok(last.body.tools.some((tool) => tool.type === 'function' && tool.name === 'read_file'));
  // Claude leaves the encrypted reasoning out. Back on GPT, it is replayed again.
  await api('PATCH', `/api/sessions/${id}`, { model: 'claude-opus-5.5' });
  await runTurn(id, 'Now on Claude [mock:echo-context]');
  const claudeRequest = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json()).filter((request) => request.path === '/v1/messages').at(-1);
  assert.ok(!JSON.stringify(claudeRequest.body.messages).includes(thinking.encrypted));
  await api('PATCH', `/api/sessions/${id}`, { model: 'gpt-6-sol' });
  const back = await runTurn(id, 'Back on GPT [mock:echo-context]');
  assert.match(back.messages.at(-1).content.at(-1).text, /Context check/);
  // Restore the notes for the tests after this one.
  fs.writeFileSync(path.join(project, 'notes.txt'), 'Hello world\r\nSecond line\r\n');
});

test('stop keeps the partial answer; queued messages run next; fork and delete work', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly [mock:slow]' });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'live_delta' && event.sessionId === id);
  await api('POST', `/api/sessions/${id}/stop`);
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === id);
  const stopped = await api('GET', `/api/sessions/${id}`);
  assert.ok(stopped.messages.some((message) => message.interrupted));
  assert.ok(stopped.messages.some((message) => message.kind === 'interrupted'));

  const queueStart = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly again [mock:slow]' });
  const queued = await api('POST', `/api/sessions/${id}/messages`, { text: 'And then say hello' });
  assert.equal(queued.queued, true);
  // The queued message waits for the slow turn and then runs as a turn of its own.
  await waitFor((event) => events.filter((item, index) => index >= queueStart && item.type === 'turn_end' && item.sessionId === id).length >= 2, 30000);
  const afterQueue = await api('GET', `/api/sessions/${id}`);
  const prompts = afterQueue.messages.filter((message) => message.kind === 'prompt').map((message) => message.content[0].text);
  assert.deepEqual(prompts.slice(-2), ['Talk slowly again [mock:slow]', 'And then say hello']);
  assert.equal(afterQueue.messages.at(-1).role, 'assistant');

  const forked = await api('POST', `/api/sessions/${id}/fork`, {});
  assert.equal(forked.session.messages.length, afterQueue.messages.length);
  await api('DELETE', `/api/sessions/${forked.session.meta.id}`);
  await assert.rejects(api('GET', `/api/sessions/${forked.session.meta.id}`), /not found/);
  const search = await api('GET', '/api/search?q=say%20hello');
  assert.ok(search.results.some((result) => result.id === id));

  // Stop pauses the queue. Resume sends it.
  const pauseStart = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly a third time [mock:slow]' });
  await waitFor((event) => events.indexOf(event) >= pauseStart && event.type === 'live_delta' && event.sessionId === id);
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Queued while slow' });
  await api('POST', `/api/sessions/${id}/stop`);
  await waitFor((event) => events.indexOf(event) >= pauseStart && event.type === 'turn_end' && event.sessionId === id);
  const paused = await api('GET', `/api/sessions/${id}`);
  assert.deepEqual([paused.runtime.queuePaused, paused.runtime.queue], [true, ['Queued while slow']]);
  const resumeStart = events.length;
  await api('POST', `/api/sessions/${id}/queue/resume`);
  await waitFor((event) => events.indexOf(event) >= resumeStart && event.type === 'turn_end' && event.sessionId === id, 30000);
  const resumed = await api('GET', `/api/sessions/${id}`);
  assert.equal(resumed.messages.filter((message) => message.kind === 'prompt').at(-1).content[0].text, 'Queued while slow');
  assert.deepEqual([resumed.runtime.queuePaused, resumed.runtime.queue], [false, []]);

  // Deleting the paused message ends the pause: a message queued later runs when its turn is done.
  const dropStart = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly once more [mock:slow]' });
  await waitFor((event) => events.indexOf(event) >= dropStart && event.type === 'live_delta' && event.sessionId === id);
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Drop me' });
  await api('POST', `/api/sessions/${id}/stop`);
  await waitFor((event) => events.indexOf(event) >= dropStart && event.type === 'turn_end' && event.sessionId === id);
  await api('DELETE', `/api/sessions/${id}/queue/0?text=${encodeURIComponent('Drop me')}`);
  const laterStart = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly at last [mock:slow]' });
  await waitFor((event) => events.indexOf(event) >= laterStart && event.type === 'live_delta' && event.sessionId === id);
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Runs after it' });
  await waitFor((event) => events.filter((item, index) => index >= laterStart && item.type === 'turn_end' && item.sessionId === id).length >= 2, 30000);
  const last = await api('GET', `/api/sessions/${id}`);
  assert.equal(last.messages.filter((message) => message.kind === 'prompt').at(-1).content[0].text, 'Runs after it');
});

test('auto mode: the safety check lets harmless commands run and asks about risky ones', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'auto' });
  const id = session.meta.id;
  const harmless = await runTurn(id, 'Show it [mock:cmd Get-Content notes.txt]');
  const result = harmless.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result');
  assert.equal(result.meta.exitCode, 0);
  assert.match(result.content, /Hello world/);
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Delete it [mock:cmd Remove-Item notes.txt]' });
  const waiting = await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.waiting);
  assert.ok(waiting.runtime.waiting.reason, 'the safety check says why it asks');
  await api('POST', `/api/sessions/${id}/respond`, { waitId: waiting.runtime.waiting.id, decision: 'deny' });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === id);
  assert.ok(fs.existsSync(path.join(project, 'notes.txt')));
  const usage = await api('GET', '/api/usage?period=all');
  assert.ok(usage.byKind.some((entry) => entry.kind === 'approval'), 'the safety check is priced like any request');

  // A file outside the project goes to the same check (the mock's check asks for it).
  const outside = path.join(path.dirname(project), 'outside-note.txt');
  const editIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: `Note it [mock:tool write_file ${JSON.stringify({ path: outside, content: 'hi' })}]` });
  const edit = await waitFor((event) => events.indexOf(event) >= editIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.waiting);
  assert.deepEqual([edit.runtime.waiting.request, edit.runtime.waiting.outside, Boolean(edit.runtime.waiting.reason)], ['edit', true, true]);
  await api('POST', `/api/sessions/${id}/respond`, { waitId: edit.runtime.waiting.id, decision: 'deny' });
  await waitFor((event) => events.indexOf(event) >= editIndex && event.type === 'turn_end' && event.sessionId === id);
  assert.ok(!fs.existsSync(outside));
});

test('interrupt and send stops the turn and runs the new message; a queued message can be removed', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  let startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly [mock:slow]' });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'live_delta' && event.sessionId === id);
  const interrupted = await api('POST', `/api/sessions/${id}/messages`, { text: 'Stop and say hello', interrupt: true });
  assert.equal(interrupted.interrupted, true);
  await waitFor((event) => events.filter((item, index) => index >= startIndex && item.type === 'turn_end' && item.sessionId === id).length >= 2, 30000);
  const afterInterrupt = await api('GET', `/api/sessions/${id}`);
  const lastPrompt = afterInterrupt.messages.filter((message) => message.kind === 'prompt').at(-1);
  assert.equal(lastPrompt.content[0].text, 'Stop and say hello');
  assert.ok(lastPrompt.content.some((block) => block.hidden && /interrupted your previous turn with the message above/.test(block.text)));
  assert.equal(afterInterrupt.messages.at(-1).role, 'assistant');

  startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Talk slowly once more [mock:slow]' });
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Never mind this one' });
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Keep this one' });
  await api('DELETE', `/api/sessions/${id}/queue/0`);
  await waitFor((event) => events.filter((item, index) => index >= startIndex && item.type === 'turn_end' && item.sessionId === id).length >= 2, 30000);
  const afterQueue = await api('GET', `/api/sessions/${id}`);
  const prompts = afterQueue.messages.filter((message) => message.kind === 'prompt').map((message) => message.content[0].text);
  assert.ok(!prompts.includes('Never mind this one'));
  assert.equal(prompts.at(-1), 'Keep this one');
});

test('skills and project instructions reach the model', async () => {
  const skills = await api('GET', `/api/skills?folder=${encodeURIComponent(project)}`);
  assert.ok(skills.skills.some((skill) => skill.name === 'greeter' && skill.description === 'Greets people the house way. Use for greetings.'));
  await api('PUT', '/api/project', { folder: project, instructions: 'Use tabs for indentation.' });
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const used = await runTurn(id, 'Greet me [mock:skill greeter]');
  assert.match(used.messages.at(-1).content.at(-1).text, /Always greet in Dutch/);
  const skillResult = used.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result');
  assert.match(skillResult.content, /phrases\.md/);
  const context = await runTurn(id, 'Check [mock:echo-context]');
  assert.match(context.messages.at(-1).content.at(-1).text, /project instructions: true/);
  const prompt = await api('GET', `/api/sessions/${id}/system-prompt`);
  assert.ok(prompt.toolNames.includes('use_skill'));
  assert.match(prompt.systemPrompt, /greeter: Greets people/);
});

test('the agent cannot read Caliope data or run commands in its folder', async () => {
  await assert.rejects(api('POST', '/api/sessions', { cwd: appData, mode: 'ask' }), /own data folder/);
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const read = lastToolResult(await runTurn(id, `Read it [mock:read ${path.join(appData, 'settings.json')}]`));
  assert.ok(read.is_error && read.meta.denied);
  const command = lastToolResult(await runTurn(id, `List it [mock:tool run_command ${JSON.stringify({ command: 'Get-ChildItem', cwd: appData })}]`));
  assert.ok(command.is_error && command.meta.denied, 'refused, also in Full access');
});

test('a message sent while an approval waits skips the approval and goes right away', async () => {
  fs.writeFileSync(path.join(project, 'important.txt'), 'keep');
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const id = session.meta.id;
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Clean up [mock:deny]' });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.waiting);
  const sent = await api('POST', `/api/sessions/${id}/messages`, { text: 'Actually, just say hello' });
  assert.equal(sent.interrupted, true);
  await waitFor((event) => events.filter((item, index) => index >= startIndex && item.type === 'turn_end' && item.sessionId === id).length >= 2, 30000);
  const done = await api('GET', `/api/sessions/${id}`);
  const lastPrompt = done.messages.filter((message) => message.kind === 'prompt').at(-1);
  assert.equal(lastPrompt.content[0].text, 'Actually, just say hello');
  assert.ok(done.messages.some((message) => message.kind === 'interrupted' && message.byMessage));
  assert.equal(done.messages.at(-1).role, 'assistant', 'the message got an answer');
  assert.ok(fs.existsSync(path.join(project, 'important.txt')), 'the skipped action did not run');
});

test('"Send now" on a queued message stops the running step and goes first; the rest stays queued for after it', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: `Wait [mock:tool run_command ${JSON.stringify({ command: 'Start-Sleep -Seconds 30' })}]` });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'tool_start' && event.sessionId === id);
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Later message' });
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Urgent message' });
  const sent = await api('POST', `/api/sessions/${id}/queue/1/send?text=${encodeURIComponent('Urgent message')}`);
  assert.equal(sent.interrupted, true);
  let done;
  let prompts = [];
  for (let i = 0; i < 150; i++) {
    done = await api('GET', `/api/sessions/${id}`);
    prompts = done.messages.filter((message) => message.kind === 'prompt').map((message) => message.content[0].text);
    if (prompts.includes('Later message') && done.runtime.state === 'idle' && done.messages.at(-1).role === 'assistant') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.deepEqual(prompts.slice(1), ['Urgent message', 'Later message']);
  assert.equal(done.messages.at(-1).role, 'assistant', 'both messages got an answer');
  await assert.rejects(api('POST', `/api/sessions/${id}/queue/0/send?text=gone`), /already sent/);
});

test('grep from a parent folder skips Caliope data', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const parent = path.dirname(appData);
  const done = await runTurn(session.meta.id, `Search [mock:grepin ${parent} Greet]`);
  const result = done.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result');
  assert.doesNotMatch(String(result.content), /session\.json|sessions[\\/]/, 'session files of Caliope are not searched');
});

test('device-code sign-in loads the model list', async () => {
  await api('POST', '/api/auth/logout');
  assert.equal((await api('GET', '/api/models')).models.length, 0);
  const startIndex = events.length;
  const started = await api('POST', '/api/auth/device/start', {});
  assert.equal(started.device.userCode, 'MOCK-1234');
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'auth' && event.auth.device?.state === 'success', 15000);
  const after = await api('GET', '/api/models');
  assert.ok(after.models.length >= 5);
  assert.equal(after.defaults.build, 'claude-opus-5.5');
  const status = (await api('GET', '/api/state')).auth;
  assert.equal(status.kind, 'oauth', 'sign-in uses Caliope\'s own OAuth App');
});

test('with its own GitHub OAuth App, sign-in sends the user token straight to Copilot, without editor headers', async () => {
  const { AuthManager } = await import('../server/auth.js');
  const mock = `http://127.0.0.1:${MOCK_PORT}`;
  const file = path.join(path.dirname(appData), 'oauth-app-auth.json');
  const options = () => ({
    file,
    config: { githubWeb: mock, githubApi: mock, apiBaseOverride: mock, oauthClientId: 'Ov23liCaliopeTest', plainSecrets: true },
    settings: { get: () => ({ apiBase: '' }) },
    log: { info() {}, warn() {}, error() {} },
  });
  const auth = new AuthManager(options());
  const checked = [];
  const signedIn = new Promise((resolve) => {
    auth.onSignedIn = resolve;
  });
  await auth.startDeviceFlow(async (access) => {
    checked.push(access);
    const response = await fetch(`${access.apiBase}/models`, { headers: access.headers });
    assert.equal(response.status, 200);
    return [];
  });
  await signedIn;
  assert.equal(auth.status().kind, 'oauth');
  assert.equal(checked[0].headers.Authorization, 'Bearer gho_mockapptoken', 'no exchange through the internal token endpoint');
  assert.equal(checked[0].headers['Copilot-Integration-Id'], 'copilot-developer-cli');
  assert.ok(!('Editor-Version' in checked[0].headers), 'no editor headers');
  const reloaded = new AuthManager(options());
  await reloaded.load();
  assert.equal((await reloaded.getAccess()).headers.Authorization, 'Bearer gho_mockapptoken');

  // A sign-in saved by an older version with the editor plugins' identity is not used: sign in again.
  fs.writeFileSync(file, JSON.stringify({ kind: 'device', login: 'old-user', token: { plain: 'ghu_old' } }));
  const old = new AuthManager(options());
  await old.load();
  assert.equal(old.status().signedIn, false);
  assert.match(old.status().error, /Sign in with GitHub again/);
});

test('custom commands from .claude/commands are listed and their prompt goes with the message', async () => {
  fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'fixbug.md'), '---\ndescription: Fix a reported bug\n---\nFind and fix the bug in $1. Report: $ARGUMENTS\n');
  const listed = await api('GET', `/api/commands?folder=${encodeURIComponent(project)}`);
  assert.ok(listed.commands.some((command) => command.name === 'fixbug' && command.description === 'Fix a reported bug' && command.source === 'project'));
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const done = await runTurn(session.meta.id, '/fixbug notes.txt crashes on start [mock:echo-context]');
  const prompt = done.messages.find((message) => message.kind === 'prompt');
  assert.equal(prompt.content[0].text, '/fixbug notes.txt crashes on start [mock:echo-context]');
  const command = prompt.content.find((block) => block.hidden && /<command name="fixbug"/.test(block.text));
  assert.ok(command, 'the expanded command is sent along');
  assert.match(command.text, /Find and fix the bug in notes\.txt\. Report: notes\.txt crashes on start/);
  const plain = await runTurn(session.meta.id, '/notacommand hello [mock:echo-context]');
  assert.ok(!plain.messages.filter((message) => message.kind === 'prompt').at(-1).content.some((block) => /<command /.test(block.text || '')));
});

test('git: uncommitted changes, a worktree session with its own branch, and removing the worktree', async (t) => {
  const { detectExtraPath } = await import('../server/config.js');
  const { findGit, runGit } = await import('../server/tools/files.js');
  const gitExe = findGit(detectExtraPath());
  if (!gitExe) {
    t.skip('git not found');
    return;
  }
  // The long path, as git reports it (TEMP can be an 8.3 short path).
  const repo = path.join(fs.realpathSync.native(path.dirname(project)), 'gitrepo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'version 1\n');
  await runGit(gitExe, ['init', '-q', '-b', 'main'], repo);
  await runGit(gitExe, ['add', '.'], repo);
  await runGit(gitExe, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], repo);
  assert.deepEqual(await api('GET', `/api/git?folder=${encodeURIComponent(repo)}`), { root: repo, branch: 'main' });
  assert.equal((await api('GET', `/api/git?folder=${encodeURIComponent(project)}`)).root, null);

  const plain = await api('POST', '/api/sessions', { cwd: repo, mode: 'full', trust: true });
  fs.writeFileSync(path.join(repo, 'app.txt'), 'version 2\n');
  const changes = await api('GET', `/api/sessions/${plain.meta.id}/git`);
  assert.equal(changes.repo, true);
  assert.equal(changes.branch, 'main');
  assert.deepEqual(changes.files.map((file) => [file.shownPath, file.status, file.added, file.removed]), [['app.txt', 'modified', 1, 1]]);
  const outside = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  assert.equal((await api('GET', `/api/sessions/${outside.meta.id}/git`)).repo, false);

  const isolated = await api('POST', '/api/sessions', { cwd: repo, mode: 'full', worktree: true });
  const worktree = isolated.meta.worktree;
  assert.match(worktree.branch, /^caliope\/\d{8}-/);
  assert.equal(isolated.meta.cwd, worktree.folder);
  assert.equal(worktree.sourceCwd, repo);
  assert.equal(fs.readFileSync(path.join(worktree.folder, 'app.txt'), 'utf8').replace(/\r\n/g, '\n'), 'version 1\n', 'the worktree starts from the last commit');
  await runTurn(isolated.meta.id, 'Hi [mock:echo-context]');
  const prompt = await api('GET', `/api/sessions/${isolated.meta.id}/system-prompt`);
  assert.match(prompt.systemPrompt, new RegExp(`branch ${worktree.branch.replace('/', '\\/')}`));
  assert.match(prompt.systemPrompt, /# Worktree/);
  fs.writeFileSync(path.join(worktree.folder, 'draft.txt'), 'work in progress\n');
  const worktreeChanges = await api('GET', `/api/sessions/${isolated.meta.id}/git`);
  assert.deepEqual(worktreeChanges.files.map((file) => [file.shownPath, file.status]), [['draft.txt', 'untracked']]);
  assert.equal(worktreeChanges.branch, worktree.branch);
  const fork = await api('POST', `/api/sessions/${isolated.meta.id}/fork`, {});
  assert.equal(fork.session.meta.worktree.folder, worktree.folder, 'a fork works in the same worktree');
  await assert.rejects(api('POST', `/api/sessions/${isolated.meta.id}/worktree/remove`, {}), (error) => error.status === 409 && /uncommitted/.test(error.message));
  const removed = await api('POST', `/api/sessions/${isolated.meta.id}/worktree/remove`, { force: true });
  assert.equal(removed.meta.worktree.removed, true);
  assert.equal(removed.sessions, 2);
  assert.equal((await api('GET', `/api/sessions/${fork.session.meta.id}`)).meta.worktree.removed, true, 'the fork knows its worktree is gone');
  assert.ok(!fs.existsSync(worktree.folder));
  await assert.rejects(api('POST', `/api/sessions/${isolated.meta.id}/worktree/remove`, {}), /no worktree/);
  await assert.rejects(api('POST', `/api/sessions/${isolated.meta.id}/messages`, { text: 'Go on [mock:echo-context]' }), /worktree was removed/);
  assert.ok(!fs.existsSync(worktree.folder), 'nothing recreated the removed folder');
  await assert.rejects(api('POST', '/api/sessions', { cwd: project, mode: 'full', worktree: true }), /not in a git repository/);
  // Creating a worktree runs the repository's git hooks: not in a folder the user does not trust.
  await api('PUT', '/api/project', { folder: repo, trusted: false });
  await assert.rejects(api('POST', '/api/sessions', { cwd: repo, mode: 'full', worktree: true }), /Trust this folder/);
  await api('PUT', '/api/project', { folder: repo, trusted: true });

  // Deleting a session removes its clean worktree. The branch stays.
  const short = await api('POST', '/api/sessions', { cwd: repo, mode: 'full', worktree: true });
  const deleted = await api('DELETE', `/api/sessions/${short.meta.id}`);
  assert.equal(deleted.keptWorktree, null);
  assert.ok(!fs.existsSync(short.meta.worktree.folder));
  assert.match(await runGit(gitExe, ['branch', '--list', short.meta.worktree.branch], repo), /caliope\//);
  // ...but keeps one with uncommitted work.
  const dirty = await api('POST', '/api/sessions', { cwd: repo, mode: 'full', worktree: true });
  fs.writeFileSync(path.join(dirty.meta.worktree.folder, 'unsaved.txt'), 'keep me\n');
  assert.equal((await api('DELETE', `/api/sessions/${dirty.meta.id}`)).keptWorktree, dirty.meta.worktree.folder);
  assert.ok(fs.existsSync(path.join(dirty.meta.worktree.folder, 'unsaved.txt')));
});

test('new project: creates a missing folder, lists it without sessions, and refuses bad paths', async () => {
  const folder = path.join(path.dirname(project), 'brand-new-project');
  const created = await api('POST', '/api/projects', { folder, name: 'Brand new', create: true });
  assert.equal(created.project.name, 'Brand new');
  assert.ok(fs.statSync(folder).isDirectory());
  const listed = await api('GET', '/api/projects');
  assert.ok(listed.projects.some((item) => item.folder === folder && item.name === 'Brand new'));
  const existing = await api('POST', '/api/projects', { folder: project, name: 'Existing' });
  assert.equal(existing.project.folder, project);
  await assert.rejects(api('POST', '/api/projects', { folder: 'relative\\path', create: true }), /full path/);
  await assert.rejects(api('POST', '/api/projects', { folder: path.join(appData, 'inside'), create: true }), /outside Caliope/);
  await assert.rejects(api('POST', '/api/open-url', { url: 'file:///C:/Windows/system32/calc.exe' }), /Only http/);
  assert.deepEqual(await api('POST', '/api/open-url', { url: 'https://github.com/' }), { ok: true });
});

test('signing in without "remember" keeps nothing on disk', async () => {
  const status = await api('POST', '/api/auth/token', { token: 'github_pat_mock_session_only', remember: false });
  assert.equal(status.signedIn, true);
  assert.equal(status.remembered, false);
  const stored = JSON.parse(fs.readFileSync(path.join(appData, 'auth.json'), 'utf8'));
  assert.deepEqual(stored, {});
  const logs = fs.readdirSync(path.join(appData, 'logs')).map((name) => fs.readFileSync(path.join(appData, 'logs', name), 'utf8')).join('\n');
  assert.doesNotMatch(logs, /github_pat_mock/, 'tokens never appear in the logs');
  const sessionsText = fs
    .readdirSync(path.join(appData, 'sessions'))
    .map((name) => fs.readFileSync(path.join(appData, 'sessions', name, 'session.json'), 'utf8'))
    .join('\n');
  assert.doesNotMatch(sessionsText, /github_pat_mock/, 'tokens never appear in session files');
});

test('a launch link works once; a second launcher gets a new one with the secret in a header', async () => {
  assert.equal((await fetch(launchUrl, { redirect: 'manual' })).status, 403, 'the link from the command line is used up');
  const { secret } = JSON.parse(fs.readFileSync(path.join(appData, 'server.json'), 'utf8'));
  assert.ok(!launchUrl.includes(secret), 'the link never carries the lasting secret');
  assert.equal((await fetch(`${base}/launch`, { method: 'POST', headers: { 'X-Caliope-Secret': 'wrong' } })).status, 403);
  assert.equal((await fetch(`${base}/shutdown`, { method: 'POST', headers: { 'X-Caliope-Secret': 'wrong' } })).status, 403, 'only the launch secret stops the server');
  const { token } = await (await fetch(`${base}/launch`, { method: 'POST', headers: { 'X-Caliope-Secret': secret } })).json();
  assert.match(token, /^[a-f0-9]{64}$/);
  const opened = await fetch(`${base}/auth?token=${token}`, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  assert.match(opened.headers.get('set-cookie'), /^caliope=/);
});

test('"interrupt and send" during a compaction stops it and runs the message', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  await runTurn(id, 'First [mock:echo-context]');
  const startIndex = events.length;
  const compaction = api('POST', `/api/sessions/${id}/compact`, { instructions: '[slow compaction]' });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.status?.phase === 'compacting');
  const sent = await api('POST', `/api/sessions/${id}/messages`, { text: 'Never mind [mock:echo-context]', interrupt: true });
  assert.equal(sent.interrupted, true);
  assert.deepEqual(await compaction, { ok: false, stopped: true });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === id);
  const done = await api('GET', `/api/sessions/${id}`);
  assert.equal(done.messages.filter((message) => message.kind === 'prompt').at(-1).content[0].text, 'Never mind [mock:echo-context]');
  assert.equal(done.messages.at(-1).role, 'assistant');
  assert.ok(!done.messages.some((message) => message.kind === 'compact_summary'), 'the stopped compaction changed nothing');
});

test('a refused thinking signature is recovered once by leaving earlier thinking out', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const done = await runTurn(session.meta.id, 'Look around [mock:badsig]');
  assert.equal(done.messages.at(-1).content.at(-1).text, 'Continued without the refused thinking.');
  const thinking = done.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.content).filter((block) => block.type === 'thinking');
  assert.ok(thinking.length > 0 && thinking.every((block) => block.omitted), 'the omission is stored, so later requests match');
});

test('"Allow in project" lets a command run without asking in every session of the project', async () => {
  const first = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  await runTurn(first.meta.id, "Say it [mock:cmd Write-Output 'project rule']", { respond: [{ kind: 'permission', payload: { decision: 'allow_project', prefix: 'Write-Output' } }] });
  assert.deepEqual((await api('GET', `/api/project?folder=${encodeURIComponent(project)}`)).project.allowedCommands, ['Write-Output']);
  const second = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const startIndex = events.length;
  const done = await runTurn(second.meta.id, "Again [mock:cmd Write-Output 'project rule']");
  assert.ok(!events.slice(startIndex).some((event) => event.type === 'runtime' && event.sessionId === second.meta.id && event.runtime.waiting), 'no approval was asked');
  const result = done.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result');
  assert.match(result.content, /project rule/);
  await api('PUT', '/api/project', { folder: project, allowedCommands: [] });
  assert.deepEqual((await api('GET', `/api/project?folder=${encodeURIComponent(project)}`)).project.allowedCommands, []);
});

test('a background command keeps running after the turn, shows in the runtime, and stops from the app', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const done = await runTurn(id, 'Start the server [mock:bg]');
  assert.match(done.messages.at(-1).content.at(-1).text, /listening on 5173/);
  const running = (await api('GET', `/api/sessions/${id}`)).runtime.jobs;
  assert.equal(running.length, 1);
  assert.equal(running[0].running, true);
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/jobs/${running[0].id}/stop`);
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.jobs?.[0]?.running === false, 15000);
  await api('DELETE', `/api/sessions/${id}`);
});

test('subagents on other models run side by side, report back, and count towards the session', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const done = await runTurn(id, 'Investigate [mock:agents]');
  const reports = done.messages.flatMap((message) => message.content || []).filter((block) => block.type === 'tool_result' && block.meta?.model);
  assert.deepEqual(reports.map((block) => block.meta.model), ['claude-haiku-5.5', 'gpt-5-mini'], '"haiku" and "gpt mini" pick those models');
  assert.match(reports[0].meta.report, /^Result: /);
  assert.match(reports[1].meta.report, /three tools at once/);
  assert.equal(done.messages.at(-1).content.at(-1).text, 'Both subagents reported back.');
  const usage = done.meta.usage.byModel;
  assert.ok(usage['claude-haiku-5.5'] && usage['gpt-5-mini'], 'subagent requests count towards the session');
  const prompt = await api('GET', `/api/sessions/${id}/system-prompt`);
  assert.ok(prompt.toolNames.includes('run_agent'));
  assert.match(prompt.systemPrompt, /claude-haiku-5\.5/, 'the models it can name are listed');
});

test('/skill-name sends the skill along, also for a skill added after the session started', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const greeted = await runTurn(id, '/greeter say hello to Ada [mock:echo-context]');
  const skillBlock = (message) => message.content.find((block) => block.hidden && /<skill name=/.test(block.text || ''));
  const first = greeted.messages.filter((message) => message.kind === 'prompt').at(-1);
  assert.match(skillBlock(first).text, /<skill name="greeter">[\s\S]*Always greet in Dutch/);
  fs.mkdirSync(path.join(appData, 'skills', 'latecomer'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'skills', 'latecomer', 'SKILL.md'), '---\nname: latecomer\ndescription: Added later.\n---\nHandle $ARGUMENTS carefully.\n');
  const late = await runTurn(id, '/latecomer the invoices [mock:echo-context]');
  const second = late.messages.filter((message) => message.kind === 'prompt').at(-1);
  assert.match(skillBlock(second).text, /Handle the invoices \[mock:echo-context\] carefully\./, '$ARGUMENTS is filled in');
  const prompt = await api('GET', `/api/sessions/${id}/system-prompt`);
  assert.ok(prompt.toolNames.includes('use_skill'));
});

test('a subagent that edits asks for approval under its own name, and its edit is a session change', async () => {
  fs.writeFileSync(path.join(project, 'agent-notes.txt'), 'Original line\n');
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const id = session.meta.id;
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/messages`, { text: 'Delegate [mock:agentedit agent-notes.txt]' });
  const edit = await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.waiting?.request === 'edit');
  assert.match(edit.runtime.waiting.agent, /Edit the notes/);
  await api('POST', `/api/sessions/${id}/respond`, { waitId: edit.runtime.waiting.id, decision: 'allow' });
  const command = await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === id && event.runtime.waiting?.request === 'command');
  await api('POST', `/api/sessions/${id}/respond`, { waitId: command.runtime.waiting.id, decision: 'allow' });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === id, 30000);
  assert.equal(fs.readFileSync(path.join(project, 'agent-notes.txt'), 'utf8'), 'Original line (edited by the agent)\n');
  const changes = await api('GET', `/api/sessions/${id}/changes`);
  assert.ok(changes.changes.some((change) => change.shownPath === 'agent-notes.txt' && change.status === 'modified'), 'the edit can be reviewed and rewound like the main agent\'s');
});

test('browser (headless): the agent uses pages; logins last across sessions and stay apart per project', async (t) => {
  const { findBrowsers } = await import('../server/windows.js');
  const installed = findBrowsers();
  if (!installed.chrome && !installed.edge) {
    t.skip('Neither Chrome nor Edge is installed');
    return;
  }
  const lastText = (session) => session.messages.at(-1).content.at(-1).text;
  const other = path.join(path.dirname(project), 'browser-other');
  fs.mkdirSync(other, { recursive: true });
  try {
    const first = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
    const driven = await runTurn(first.meta.id, 'Try the form [mock:browse]');
    assert.equal(lastText(driven), 'The page now says: Hello, Ada!', 'navigate, type, click and read work on a real page');
    const shot = driven.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result' && Array.isArray(block.content) && block.content.some((part) => part.type === 'image'));
    assert.ok(shot.content[0].data.length > 1000, 'a screenshot comes back as an image');

    // A confirm() dialog is answered with Cancel instead of blocking the page. The agent is told.
    const dialog = lastText(await runTurn(first.meta.id, 'Press delete [mock:clickfirst /__dialog]'));
    assert.match(dialog, /confirm dialog/);
    assert.match(dialog, /Text:\nDelete\n\nKept\n/, 'the page saw Cancel');
    // A link that opens a new tab moves the session into that tab.
    const popup = lastText(await runTurn(first.meta.id, 'Open the form [mock:clickfirst /__popup]'));
    assert.match(popup, /Title: Mock form/);
    // A script runs in the page, can await, and returns its value. An error in it goes back to the agent.
    const script = 'await new Promise((resolve) => setTimeout(resolve, 50)); document.body.dataset.marked = "yes"; return { title: document.title, marked: document.body.dataset.marked };';
    const scripted = lastToolResult(await runTurn(first.meta.id, `Run it [mock:tool browser ${JSON.stringify({ action: 'javascript', script })}]`));
    assert.match(scripted.content, /"title": "Mock form",\s+"marked": "yes"/);
    const failed = lastToolResult(await runTurn(first.meta.id, `Run it [mock:tool browser ${JSON.stringify({ action: 'javascript', script: 'missingFunction();' })}]`));
    assert.ok(failed.is_error);
    assert.match(failed.content, /missingFunction is not defined/);

    // The Browser panel: the session's tab streams frames, and the user's own typing and clicks reach the page.
    const closeStream = new AbortController();
    const stream = await fetch(`${base}/api/sessions/${first.meta.id}/browser/stream?key=${apiKey}`, { headers: { Cookie: cookie }, signal: closeStream.signal });
    const panelEvents = [];
    const streamDecoder = new TextDecoder();
    const streamParser = createSseParser(({ data }) => panelEvents.push(JSON.parse(data)));
    (async () => {
      try {
        for await (const chunk of stream.body) streamParser.push(streamDecoder.decode(chunk, { stream: true }));
      } catch {
        // Closed below.
      }
    })();
    for (let i = 0; i < 40 && !panelEvents.some((event) => event.type === 'frame'); i++) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(panelEvents.some((event) => event.type === 'frame' && event.data.length > 1000), 'the panel gets frames');
    assert.ok(panelEvents.some((event) => event.type === 'state' && event.hasPage && /Mock form/.test(event.title)), 'and the page title');
    const located = lastToolResult(await runTurn(first.meta.id, `Find it [mock:tool browser ${JSON.stringify({ action: 'javascript', script: "document.getElementById('name').focus(); const box = document.querySelector('button').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };" })}]`));
    const button = JSON.parse(/Result:\n([\s\S]*?)\n\nNow at/.exec(located.content)[1]);
    await api('POST', `/api/sessions/${first.meta.id}/browser/input`, { events: [{ type: 'text', text: 'Grace' }, { type: 'mouse', action: 'down', ...button, button: 'left' }, { type: 'mouse', action: 'up', ...button, button: 'left' }] });
    const greeted = lastToolResult(await runTurn(first.meta.id, `Read it [mock:tool browser ${JSON.stringify({ action: 'javascript', script: "return document.getElementById('out').textContent;" })}]`));
    assert.match(greeted.content, /Hello, Grace!/);
    closeStream.abort();

    // A batch runs several steps in one call. Console and network show the page's messages and requests.
    await runTurn(first.meta.id, 'Open the form [mock:visit /__page]');
    const steps = [{ action: 'javascript', script: "console.error('boom from the page'); return 'logged';" }, { action: 'type', ref: 1, text: 'Ada' }, { action: 'click', ref: 2 }, { action: 'read' }];
    const batched = lastToolResult(await runTurn(first.meta.id, `Do it [mock:tool browser ${JSON.stringify({ action: 'batch', steps })}]`));
    assert.match(batched.content, /^1\. Result:\nlogged/m);
    assert.match(batched.content, /^2\. Typed 3 characters into \[1\]\.$/m, 'a brief step reports one line');
    assert.match(batched.content, /^3\. Clicked \[2\]\.$/m);
    assert.match(batched.content, /^4\. Title: Mock form[\s\S]*Hello, Ada!/m, 'the last step reports in full');
    const consoleLog = lastToolResult(await runTurn(first.meta.id, `Check [mock:tool browser ${JSON.stringify({ action: 'console' })}]`));
    assert.match(consoleLog.content, /\[error\] boom from the page/);
    const requests = lastToolResult(await runTurn(first.meta.id, `Check [mock:tool browser ${JSON.stringify({ action: 'network' })}]`));
    assert.match(requests.content, /GET 200 Document http:\/\/127\.0\.0\.1:\d+\/__page/);
    const failedBatch = lastToolResult(await runTurn(first.meta.id, `Do it [mock:tool browser ${JSON.stringify({ action: 'batch', steps: [{ action: 'click', ref: 999 }, { action: 'read' }] })}]`));
    assert.ok(failedBatch.is_error);
    assert.match(failedBatch.content, /Step 1 \(click\) failed: Element \[999\][\s\S]*Step 2 did not run\./);

    // A login in one session is there in the next session of the same project.
    await runTurn(first.meta.id, 'Sign in [mock:visit /__login?user=alice]');
    const second = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
    assert.equal(lastText(await runTurn(second.meta.id, 'Who am I [mock:visit /__whoami]')), 'Page text: Signed in as alice');

    // Another project has its own logins, and both browsers work at the same time.
    const elsewhere = await api('POST', '/api/sessions', { cwd: other, mode: 'full', trust: true });
    assert.equal(lastText(await runTurn(elsewhere.meta.id, 'Who am I [mock:visit /__whoami]')), 'Page text: Not signed in');
    await runTurn(elsewhere.meta.id, 'Sign in [mock:visit /__login?user=bob]');
    assert.equal(lastText(await runTurn(second.meta.id, 'Check [mock:visit /__whoami]')), 'Page text: Signed in as alice');
    assert.equal(lastText(await runTurn(elsewhere.meta.id, 'Check [mock:visit /__whoami]')), 'Page text: Signed in as bob');

    // Clearing a project's browser data removes its logins.
    await api('POST', '/api/project/browser/clear', { folder: project });
    assert.equal(lastText(await runTurn(second.meta.id, 'Check [mock:visit /__whoami]')), 'Page text: Not signed in');
  } finally {
    // Headless browsers outlive a killed server. Close them.
    for (const folder of [project, other]) await api('POST', '/api/project/browser/clear', { folder }).catch(() => {});
  }
});

/** The result of the latest tool call in a finished session. */
function lastToolResult(session) {
  const block = session.messages.flatMap((message) => message.content || []).filter((item) => item.type === 'tool_result').at(-1);
  return block;
}

test('a folder with its own agent files asks for trust; untrusted, its files are ignored', async () => {
  const folder = path.join(path.dirname(project), 'cloned');
  fs.mkdirSync(path.join(folder, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'AGENTS.md'), 'Always answer in French.\n');
  fs.writeFileSync(path.join(folder, '.claude', 'commands', 'deploy.md'), 'Deploy everything to production.\n');
  await assert.rejects(api('POST', '/api/sessions', { cwd: folder, mode: 'ask' }), (error) => error.status === 428 && /AGENTS\.md/.test(error.message));
  const session = await api('POST', '/api/sessions', { cwd: folder, mode: 'ask', trust: false });
  const done = await runTurn(session.meta.id, '/deploy now [mock:echo-context]');
  assert.ok(!done.messages.find((message) => message.kind === 'prompt').content.some((block) => /<command /.test(block.text || '')), 'the untrusted command is not expanded');
  const prompt = await api('GET', `/api/sessions/${session.meta.id}/system-prompt`);
  assert.doesNotMatch(prompt.systemPrompt, /answer in French/);
  assert.ok(!(await api('GET', `/api/commands?folder=${encodeURIComponent(folder)}`)).commands.some((command) => command.name === 'deploy'));
  const again = await api('POST', '/api/sessions', { cwd: folder, mode: 'ask' });
  assert.ok(again.meta.id, 'the answer is remembered');
  assert.equal((await api('GET', `/api/project?folder=${encodeURIComponent(folder)}`)).project.trusted, false);
});

test('protected files: the agent cannot read .env, and searches skip it', async () => {
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=hunter2\n');
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;
  const read = lastToolResult(await runTurn(id, 'Read it [mock:read .env]'));
  assert.ok(read.is_error);
  assert.match(read.content, /protected files/);
  assert.doesNotMatch(JSON.stringify(read), /hunter2/);
  const searched = lastToolResult(await runTurn(id, `Search [mock:grepin ${project} hunter2]`));
  assert.doesNotMatch(String(searched.content), /\.env/);
  // A junction (no admin rights needed) into Caliope's data folder leads to the sign-in under another name.
  const link = path.join(project, 'innocent');
  execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mklink', '/J', link, appData], { stdio: 'ignore' });
  try {
    const throughLink = lastToolResult(await runTurn(id, `Read it [mock:tool read_file ${JSON.stringify({ path: 'innocent\\settings.json' })}]`));
    assert.ok(throughLink.is_error && throughLink.meta.denied, 'refused through the junction');
    assert.match(throughLink.content, /sign-in or session data/);
    // A junction to a folder that does not exist yet: writing through it would create the folder there.
    const pending = path.join(project, 'pending');
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mklink', '/J', pending, path.join(appData, 'not-yet')], { stdio: 'ignore' });
    try {
      const throughPending = lastToolResult(await runTurn(id, `Write it [mock:tool write_file ${JSON.stringify({ path: 'pending\\notes.txt', content: 'x' })}]`));
      assert.ok(throughPending.is_error && throughPending.meta.denied, 'refused through a junction to a folder that does not exist yet');
      assert.ok(!fs.existsSync(path.join(appData, 'not-yet')));
    } finally {
      fs.rmdirSync(pending);
    }
    // A file link to .env under another name (Windows allows it only with Developer Mode or admin rights).
    const fileLink = path.join(project, 'innocent.txt');
    let linked = false;
    try {
      fs.symlinkSync(path.join(project, '.env'), fileLink, 'file');
      linked = true;
    } catch {
      // Not allowed on this PC: nothing to check.
    }
    if (linked) {
      try {
        const throughFileLink = lastToolResult(await runTurn(id, `Search [mock:grepin ${project} hunter2]`));
        assert.doesNotMatch(String(throughFileLink.content), /innocent\.txt|SECRET=/, 'a search does not read .env through a file link');
      } finally {
        fs.rmSync(fileLink);
      }
    }
  } finally {
    fs.rmdirSync(link);
    fs.rmSync(path.join(project, '.env'));
  }
});

test('project memory: the remember tool and /remember add notes that new sessions start with', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const saved = lastToolResult(await runTurn(session.meta.id, `Note it [mock:tool remember ${JSON.stringify({ note: 'Run the tests with npm test' })}]`));
  assert.ok(!saved.is_error);
  await api('POST', `/api/sessions/${session.meta.id}/remember`, { note: 'Never touch the prod catalog' });
  const memory = (await api('GET', `/api/project?folder=${encodeURIComponent(project)}`)).project.memory;
  assert.equal(memory, '- Run the tests with npm test\n- Never touch the prod catalog');
  const next = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  await runTurn(next.meta.id, 'Hello [mock:echo-context]');
  const prompt = await api('GET', `/api/sessions/${next.meta.id}/system-prompt`);
  assert.match(prompt.systemPrompt, /<project_memory>\n- Run the tests with npm test\n- Never touch the prod catalog\n<\/project_memory>/);

  // The agent corrects and removes notes, and sees the memory as it is now (also the user's changes).
  const corrected = lastToolResult(await runTurn(next.meta.id, `Fix it [mock:tool remember ${JSON.stringify({ replace: 'Run the tests with npm test', note: 'Run the tests with npm run test:all' })}]`));
  assert.match(corrected.content, /now reads:\n- Run the tests with npm run test:all\n- Never touch the prod catalog$/);
  const removed = lastToolResult(await runTurn(next.meta.id, `Forget it [mock:tool remember ${JSON.stringify({ replace: '- Never touch the prod catalog' })}]`));
  assert.match(removed.content, /now reads:\n- Run the tests with npm run test:all$/);
  const missing = lastToolResult(await runTurn(next.meta.id, `Forget [mock:tool remember ${JSON.stringify({ replace: 'No such note' })}]`));
  assert.ok(missing.is_error);
  await api('PUT', '/api/project', { folder: project, memory: '- Deploy on Fridays' });
  const shown = lastToolResult(await runTurn(next.meta.id, 'What do you remember? [mock:tool remember {}]'));
  assert.equal(shown.content, 'The project memory:\n- Deploy on Fridays');
  await api('PUT', '/api/project', { folder: project, memory: '' });
});

test('instruction files in a subfolder reach the agent once, when it first works on a file there', async () => {
  fs.mkdirSync(path.join(project, 'billing'), { recursive: true });
  fs.writeFileSync(path.join(project, 'billing', 'AGENTS.md'), 'Amounts are in cents.\n');
  fs.writeFileSync(path.join(project, 'billing', 'invoice.txt'), 'Total: 1234\n');
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
  const first = lastToolResult(await runTurn(session.meta.id, `Read it [mock:tool read_file ${JSON.stringify({ path: 'billing/invoice.txt' })}]`));
  assert.match(first.content, /Total: 1234[\s\S]*<system-reminder>[\s\S]*billing[\\/]AGENTS\.md">\nAmounts are in cents\./);
  const second = lastToolResult(await runTurn(session.meta.id, `Again [mock:tool read_file ${JSON.stringify({ path: 'billing/invoice.txt' })}]`));
  assert.doesNotMatch(second.content, /Amounts are in cents/);
  fs.rmSync(path.join(project, 'billing'), { recursive: true });
});

test('hooks: after an edit, the output of matching hooks reaches the agent', async () => {
  fs.writeFileSync(path.join(project, 'hooked.txt'), 'Line one\r\n');
  await api('PUT', '/api/project', {
    folder: project,
    hooks: [
      { match: '*.txt', command: 'Write-Output "formatted {file}"' },
      { match: '*.py', command: 'Write-Output "not for text files"' },
    ],
  });
  try {
    const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
    const edited = await runTurn(session.meta.id, 'Edit [mock:edit hooked.txt]');
    const editResult = edited.messages.flatMap((message) => message.content || []).find((block) => block.type === 'tool_result' && block.meta?.hooks);
    assert.match(editResult.content, /formatted .*hooked\.txt/);
    assert.doesNotMatch(editResult.content, /not for text files/);
  } finally {
    await api('PUT', '/api/project', { folder: project, hooks: [] });
  }
});

test('run_command: input goes to standard input', async () => {
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const piped = lastToolResult(await runTurn(session.meta.id, `Count [mock:tool run_command ${JSON.stringify({ command: 'findstr /n "^"', input: 'alpha\nbeta\n' })}]`));
  assert.match(piped.content, /1:alpha\n2:beta/);
});

test('allow rules do not apply in plan mode or with standard input', async () => {
  await api('PUT', '/api/settings', { allowedCommands: ['Get-ChildItem', 'findstr'] });
  try {
    const askedFor = async (mode, text) => {
      const session = await api('POST', '/api/sessions', { cwd: project, mode });
      const startIndex = events.length;
      await api('POST', `/api/sessions/${session.meta.id}/messages`, { text });
      const waiting = await waitFor((event) => events.indexOf(event) >= startIndex && event.sessionId === session.meta.id && ((event.type === 'runtime' && event.runtime.waiting) || event.type === 'turn_end'));
      if (waiting.type === 'turn_end') return null;
      await api('POST', `/api/sessions/${session.meta.id}/respond`, { waitId: waiting.runtime.waiting.id, decision: 'deny' });
      await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === session.meta.id);
      return waiting.runtime.waiting;
    };
    assert.equal(await askedFor('edits', '[mock:cmd Get-ChildItem]'), null, 'the rule applies in Accept edits');
    assert.ok(await askedFor('plan', '[mock:cmd Get-ChildItem]'), 'plan mode asks');
    assert.ok(await askedFor('edits', `[mock:tool run_command ${JSON.stringify({ command: 'findstr x', input: 'x\n' })}]`), 'standard input asks');
  } finally {
    await api('PUT', '/api/settings', { allowedCommands: [] });
  }
});

test('MCP: servers from Settings and a trusted .mcp.json give tools; read-only ones run, others ask', async () => {
  const mockServer = (token) => ({ command: process.execPath, args: [path.join(root, 'tools', 'mock-mcp.js')], env: { MOCK_MCP_TOKEN: token } });
  await assert.rejects(api('PUT', '/api/settings', { mcpServers: { 'bad name': mockServer('x') } }), /letters, digits/);
  await api('PUT', '/api/settings', { mcpServers: { mock: mockServer('${env:CALIOPE_TEST_TOKEN}'), broken: { command: 'no-such-program-xyz', args: [] } } });
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { projmock: mockServer('project') } }));
  const cloned = path.join(path.dirname(project), 'cloned');
  fs.writeFileSync(path.join(cloned, '.mcp.json'), JSON.stringify({ mcpServers: { clonedmock: mockServer('cloned') } }));
  try {
    const checked = await api('POST', '/api/mcp/check', { name: 'mock' });
    assert.deepEqual(checked.tools, [{ tool: 'echo', readOnly: true }, { tool: 'create_item', readOnly: false }]);
    const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
    const id = session.meta.id;
    const echoed = await runTurn(id, `Echo [mock:tool mcp__mock__echo ${JSON.stringify({ text: 'hi' })}]`);
    assert.equal(lastToolResult(echoed).content, 'echo: hi', 'a read-only tool runs without asking');
    assert.match(echoed.messages.at(-1).content.at(-1).text, /Tools: .*mcp__mock__echo, mcp__mock__create_item.*mcp__projmock__echo/);
    assert.ok(echoed.messages.some((message) => message.role === 'event' && /MCP: The MCP server "broken" stopped/.test(message.text)), 'a server that does not start is reported');
    const created = await runTurn(id, `Create [mock:tool mcp__mock__create_item ${JSON.stringify({ title: 'Bug' })}]`, { respond: [{ kind: 'permission', payload: { decision: 'allow_session' } }] });
    assert.match(lastToolResult(created).content, /Created item 42: Bug \(cwd .*project, MOCK_MCP_TOKEN \$\{env:CALIOPE_TEST_TOKEN\}\)/);
    const again = await runTurn(id, `Again [mock:tool mcp__mock__create_item ${JSON.stringify({ title: 'Second' })}]`);
    assert.match(lastToolResult(again).content, /Created item 42: Second/, 'allowed for the rest of the session');
    const planning = await api('POST', '/api/sessions', { cwd: project, mode: 'plan' });
    const refused = lastToolResult(await runTurn(planning.meta.id, `Create [mock:tool mcp__projmock__create_item ${JSON.stringify({ title: 'X' })}]`));
    assert.match(refused.content, /Plan mode is on/);
    const untrusted = await api('POST', '/api/sessions', { cwd: cloned, mode: 'ask' });
    await runTurn(untrusted.meta.id, 'Hello [mock:echo-context]');
    const toolNames = (await api('GET', `/api/sessions/${untrusted.meta.id}/system-prompt`)).toolNames;
    assert.ok(toolNames.includes('mcp__mock__echo') && !toolNames.some((name) => name.startsWith('mcp__clonedmock')), 'an untrusted .mcp.json is not used');
  } finally {
    await api('PUT', '/api/settings', { mcpServers: {} });
    fs.rmSync(path.join(project, '.mcp.json'), { force: true });
  }
});

test('a proxy in Settings: refused with a password, shown in use, and 127.0.0.1 still reached directly', async () => {
  await assert.rejects(api('PUT', '/api/settings', { proxy: 'http://me:secret@proxy:8080' }), /does not store proxy passwords/);
  // Nothing listens on port 9: a request that went through this proxy would fail.
  await api('PUT', '/api/settings', { proxy: '127.0.0.1:9' });
  try {
    const proxy = await api('GET', '/api/proxy');
    assert.deepEqual([proxy.source, proxy.url], ['settings', 'http://127.0.0.1:9']);
    assert.ok('script' in proxy.windows);
    const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
    const done = await runTurn(session.meta.id, 'Hello through the proxy settings');
    assert.equal(done.messages.at(-1).role, 'assistant', 'the mock Copilot API on 127.0.0.1 is reached directly');
  } finally {
    await api('PUT', '/api/settings', { proxy: '' });
  }
  assert.equal((await api('GET', '/api/proxy')).source, null);
});

test('scheduled tasks: saved on the project, "Run now" starts a session with the prompt, a run stops at its own credit limit', async () => {
  const folder = path.join(path.dirname(project), 'scheduled');
  fs.mkdirSync(folder, { recursive: true });
  await api('PUT', '/api/project', { folder, trusted: true });
  await assert.rejects(api('PUT', '/api/project', { folder, schedules: [{ name: 'Bad', prompt: 'x', every: 'daily', at: '25:00' }] }), /HH:MM/);
  const task = { name: 'Morning check', prompt: 'Look around [mock:tool list_dir {"path":"."}]', every: 'weekdays', at: '09:00', mode: 'full', model: 'claude-haiku-5.5' };
  const { project: saved } = await api('PUT', '/api/project', { folder, schedules: [task] });
  const [schedule] = saved.schedules;
  assert.ok(new Date(schedule.nextRunAt) > new Date(), 'the next run is in the future');

  const startIndex = events.length;
  const { sessionId } = await api('POST', '/api/project/schedules/run', { folder, id: schedule.id });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === sessionId);
  const run = await api('GET', `/api/sessions/${sessionId}`);
  assert.deepEqual([run.meta.schedule.name, run.meta.model, run.meta.mode, run.meta.titleSource], ['Morning check', 'claude-haiku-5.5', 'full', 'schedule']);
  assert.match(run.meta.title, /^Morning check · /);
  assert.equal(run.messages.find((message) => message.role === 'user').content[0].text, task.prompt);
  assert.equal(run.messages.at(-1).role, 'assistant');
  assert.equal((await api('GET', `/api/project?folder=${encodeURIComponent(folder)}`)).project.schedules[0].lastSessionId, sessionId);

  // A tiny limit per run: the first model call goes through, the one after the tool call stops.
  await api('PUT', '/api/project', { folder, schedules: [{ ...schedule, maxCredits: 0.000001 }] });
  const limitedIndex = events.length;
  const limited = await api('POST', '/api/project/schedules/run', { folder, id: schedule.id });
  await waitFor((event) => events.indexOf(event) >= limitedIndex && event.type === 'turn_end' && event.sessionId === limited.sessionId);
  const stopped = await api('GET', `/api/sessions/${limited.sessionId}`);
  assert.match(stopped.messages.at(-1).text, /scheduled task "Morning check" reached its limit/);
  assert.equal(stopped.meta.usage.requests, 1);
});

test('the agent schedules a loop in its own session after approval, and removes it without asking', async () => {
  const folder = path.join(path.dirname(project), 'looping');
  fs.mkdirSync(folder, { recursive: true });
  await api('PUT', '/api/project', { folder, trusted: true });
  const session = await api('POST', '/api/sessions', { cwd: folder, mode: 'ask' });
  const id = session.meta.id;
  const loop = { name: 'Build check', prompt: 'Check whether the build is green; delete this task when it is.', every: 'minutes', minutes: 10 };
  const startIndex = events.length;
  const created = lastToolResult(await runTurn(id, `Watch it [mock:tool schedule ${JSON.stringify(loop)}]`, { respond: [{ kind: 'permission', payload: { decision: 'allow' } }] }));
  const card = events.find((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.runtime.waiting?.request === 'schedule').runtime.waiting;
  assert.deepEqual([card.name, card.when, card.here, card.mode], ['Build check', 'every 10 minutes', true, 'ask']);
  assert.match(created.content, /Scheduled "Build check" \(id [\w-]+\): every 10 minutes, in this session/);
  const [task] = (await api('GET', `/api/project?folder=${encodeURIComponent(folder)}`)).project.schedules;
  assert.deepEqual([task.sessionId, task.every, task.minutes], [id, 'minutes', 10]);
  assert.ok(task.expiresAt, 'a loop ends by itself');

  const removed = lastToolResult(await runTurn(id, `Done [mock:tool schedule ${JSON.stringify({ action: 'delete', id: task.id })}]`));
  assert.match(removed.content, /Removed the scheduled task "Build check"/);
  assert.deepEqual((await api('GET', `/api/project?folder=${encodeURIComponent(folder)}`)).project.schedules, []);
  const planning = await api('POST', '/api/sessions', { cwd: folder, mode: 'plan' });
  assert.match(lastToolResult(await runTurn(planning.meta.id, `Later [mock:tool schedule ${JSON.stringify(loop)}]`)).content, /Plan mode is on/);
  // Auto mode schedules without asking (runTurn would time out on an approval card).
  const auto = await api('POST', '/api/sessions', { cwd: folder, mode: 'auto' });
  assert.match(lastToolResult(await runTurn(auto.meta.id, `Later [mock:tool schedule ${JSON.stringify({ ...loop, name: 'Auto loop' })}]`)).content, /Scheduled "Auto loop"/);
});

test('a loop in an existing session stops at its own limit per run, counted from where the run started', async () => {
  const folder = path.join(path.dirname(project), 'looping');
  const session = await api('POST', '/api/sessions', { cwd: folder, mode: 'full' });
  const id = session.meta.id;
  await runTurn(id, 'Hello');
  const before = (await api('GET', `/api/sessions/${id}`)).meta.usage.requests;
  const loop = { name: 'Tiny loop', prompt: 'Look around [mock:tool list_dir {"path":"."}]', every: 'minutes', minutes: 10, sessionId: id, mode: 'full', maxCredits: 0.000001 };
  const { project: saved } = await api('PUT', '/api/project', { folder, schedules: [loop] });
  const startIndex = events.length;
  await api('POST', '/api/project/schedules/run', { folder, id: saved.schedules[0].id });
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === id);
  const after = await api('GET', `/api/sessions/${id}`);
  assert.match(after.messages.at(-1).text, /scheduled task "Tiny loop" reached its limit/);
  assert.equal(after.meta.usage.requests, before + 1, 'what the session spent before the run does not count; the call after the tool call stops');
  await api('PUT', '/api/project', { folder, schedules: [] });
});

test('a project spending limit: a notice from 80%, the agent stops at the limit, Retry continues once it is raised', async () => {
  const folder = path.join(path.dirname(project), 'limited');
  fs.mkdirSync(folder, { recursive: true });
  await api('PUT', '/api/project', { folder, trusted: true });
  const session = await api('POST', '/api/sessions', { cwd: folder, mode: 'ask' });
  const id = session.meta.id;
  await runTurn(id, 'Hello');
  await waitFor((event) => event.type === 'session' && event.meta.id === id && event.meta.titleSource === 'model');
  const { spentThisMonth } = await api('GET', `/api/project?folder=${encodeURIComponent(folder)}`);
  assert.ok(spentThisMonth > 0, 'spending is counted per project');
  assert.equal(spentThisMonth, (await api('GET', `/api/sessions/${id}`)).meta.usage.nanoAiu);

  await api('PUT', '/api/project', { folder, creditLimit: spentThisMonth / 1e9 / 0.85 });
  const warned = await runTurn(id, 'Again');
  assert.equal(warned.messages.filter((message) => message.kind === 'notice' && /used 8\d% of its/.test(message.text)).length, 1);
  assert.ok(!warned.messages.some((message) => message.kind === 'error'), 'under the limit the turn runs');

  const stopped = await runTurn(id, 'Once more');
  const error = stopped.messages.at(-1);
  assert.equal(error.kind, 'error');
  assert.match(error.text, /reached its limit of [\d.]+ AI credits/);
  assert.equal(error.limitProject, folder);
  assert.equal(stopped.meta.usage.requests, warned.meta.usage.requests, 'no model call at the limit');

  await api('PUT', '/api/project', { folder, creditLimit: 0 });
  const startIndex = events.length;
  await api('POST', `/api/sessions/${id}/retry`);
  await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === id);
  const continued = await api('GET', `/api/sessions/${id}`);
  assert.equal(continued.messages.at(-1).role, 'assistant');
  assert.ok(continued.meta.usage.requests > stopped.meta.usage.requests);
});

test('a compaction model from Settings writes Caliope\'s summaries; Claude still compacts itself', async () => {
  // The agent's own requests carry its tools. Titles and other side requests have none.
  const lastRequest = async (pathname) => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json()).filter((request) => request.path === pathname && request.body?.tools?.length).at(-1);
  await api('PUT', '/api/settings', { compactModel: 'gpt-5-mini', compactEffort: 'low' });
  try {
    const session = await api('POST', '/api/sessions', { cwd: project, mode: 'ask' });
    const id = session.meta.id;
    await runTurn(id, 'Hello [mock:echo-context]');
    assert.equal((await lastRequest('/v1/messages')).body.context_management.edits[0].type, 'compact_20260112', 'Claude still compacts itself');
    await api('POST', `/api/sessions/${id}/compact`, {});
    const after = await api('GET', `/api/sessions/${id}`);
    assert.equal(after.messages.find((message) => message.kind === 'compact').model, 'gpt-5-mini');
    const summary = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json()).filter((request) => request.body?.model === 'gpt-5-mini').at(-1);
    assert.equal(summary.body.reasoning?.effort ?? summary.body.reasoning_effort, 'low');
  } finally {
    await api('PUT', '/api/settings', { compactModel: null, compactEffort: null });
  }
});

test('Claude and GPT compact the conversation themselves; after a model switch the new model gets a summary it can read', async () => {
  // The agent's own requests carry its tools. Titles and other side requests have none.
  const lastRequest = async (pathname, model = null) => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json()).filter((request) => (!pathname || request.path === pathname) && request.body?.tools?.length && (!model || request.body.model === model)).at(-1);
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const id = session.meta.id;

  // Claude: the request asks for compaction with the beta header, and the summary block is kept.
  const compacted = await runTurn(id, 'Long work [mock:nativecompact]');
  const asked = await lastRequest('/v1/messages');
  assert.equal(asked.body.context_management.edits[0].type, 'compact_20260112');
  assert.match(asked.headers['anthropic-beta'], /compact-2026-01-12/);
  assert.ok(compacted.messages.some((message) => message.role === 'assistant' && message.content.some((block) => block.type === 'compaction' && /native compaction/.test(block.content))));
  assert.ok(compacted.messages.some((message) => message.kind === 'compact'), 'the transcript shows the compaction');
  await runTurn(id, 'Next [mock:echo-context]');
  const after = await lastRequest('/v1/messages');
  assert.ok(after.body.messages.some((message) => message.content.some((block) => block.type === 'compaction')), 'the block goes back');
  assert.ok(!JSON.stringify(after.body.messages).includes('Long work'), 'the summarized messages are left out');

  // GPT gets Claude's summary as text, and compacts itself with an encrypted item.
  await api('PATCH', `/api/sessions/${id}`, { model: 'gpt-6-sol' });
  await runTurn(id, 'On GPT [mock:nativecompact]');
  const sol = await lastRequest('/responses', 'gpt-6-sol');
  assert.match(JSON.stringify(sol.body.input), /conversation_summary/);
  assert.equal(sol.body.context_management[0].type, 'compaction');
  await runTurn(id, 'Again [mock:echo-context]');
  assert.equal((await lastRequest('/responses', 'gpt-6-sol')).body.input[0].type, 'compaction', 'GPT continues from its own compaction');

  // Another GPT model cannot read that item, so GPT-6 Sol writes a summary first.
  await api('PATCH', `/api/sessions/${id}`, { model: 'gpt-5-mini' });
  const switched = await runTurn(id, 'Other model [mock:echo-context]');
  assert.ok(switched.messages.some((message) => message.kind === 'compact_summary'));
  assert.match(switched.messages.at(-1).content.at(-1).text, /Context check/);
  assert.ok(!JSON.stringify((await lastRequest(null, 'gpt-5-mini')).body).includes('cmp_gpt-6-sol'));
});

test('the agent can search earlier sessions of its project and read one', async () => {
  const first = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  await runTurn(first.meta.id, 'Note the zebra-crossing decision [mock:echo-context]');
  const otherFolder = path.join(path.dirname(project), 'search-other');
  fs.mkdirSync(otherFolder, { recursive: true });
  const elsewhere = await api('POST', '/api/sessions', { cwd: otherFolder, mode: 'full', trust: true });
  await runTurn(elsewhere.meta.id, 'Another zebra-crossing note [mock:echo-context]');
  const searcher = await api('POST', '/api/sessions', { cwd: project, mode: 'full' });
  const found = lastToolResult(await runTurn(searcher.meta.id, `Look it up [mock:tool search_sessions ${JSON.stringify({ query: 'zebra-crossing' })}]`));
  assert.ok(found.content.includes(first.meta.id));
  assert.ok(!found.content.includes(elsewhere.meta.id), 'another project\'s sessions stay out');
  const read = lastToolResult(await runTurn(searcher.meta.id, `Open it [mock:tool read_session ${JSON.stringify({ id: first.meta.id })}]`));
  assert.match(read.content, /Note the zebra-crossing decision/);
  const other = lastToolResult(await runTurn(searcher.meta.id, `Open the other [mock:tool read_session ${JSON.stringify({ id: elsewhere.meta.id })}]`));
  assert.ok(other.is_error && !/Another zebra-crossing note/.test(other.content), 'and cannot be read by id');
});

test('edits that would change .mcp.json ask also through a short name, and stream names are refused', async () => {
  const folder = path.join(project, 'names');
  const config = path.join(folder, '.mcp.json');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(config, '{"mcpServers": {}}\n');
  try {
    const session = await api('POST', '/api/sessions', { cwd: project, mode: 'auto' });
    const streamName = `names/.mcp.json${':'}${':'}$DATA`;
    const refused = lastToolResult(await runTurn(session.meta.id, `Read it [mock:tool read_file ${JSON.stringify({ path: streamName })}]`));
    assert.ok(refused.is_error && refused.meta.denied, 'a stream name is refused');
    const network = lastToolResult(await runTurn(session.meta.id, `Read it [mock:tool read_file ${JSON.stringify({ path: '\\\\127.0.0.1\\share\\notes.txt' })}]`));
    assert.ok(network.is_error && network.meta.denied, 'a network path outside the project is refused');
    // Short (8.3) names exist only on volumes that keep them.
    const { execSync } = await import('node:child_process');
    const shortName = execSync(`cmd /c for %I in ("${config}") do @echo %~nxsI`).toString().trim();
    if (shortName.toLowerCase() === '.mcp.json') return;
    const startIndex = events.length;
    await api('POST', `/api/sessions/${session.meta.id}/messages`, { text: `Edit it [mock:edit names/${shortName}]` });
    const waiting = await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === session.meta.id && event.runtime.waiting);
    assert.equal(waiting.runtime.waiting.request, 'edit');
    assert.ok(waiting.runtime.waiting.warning, 'the edit asks with the steering-file warning');
    await api('POST', `/api/sessions/${session.meta.id}/respond`, { waitId: waiting.runtime.waiting.id, decision: 'deny' });
    await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === session.meta.id);
    assert.equal(fs.readFileSync(config, 'utf8'), '{"mcpServers": {}}\n');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('browser (headless): a page that moves to a site the user has not approved is not shown', async (t) => {
  const { findBrowsers } = await import('../server/windows.js');
  const installed = findBrowsers();
  if (!installed.chrome && !installed.edge) {
    t.skip('Neither Chrome nor Edge is installed');
    return;
  }
  const session = await api('POST', '/api/sessions', { cwd: project, mode: 'edits' });
  try {
    // 127.0.0.1 is approved for the session. The redirect goes to localhost, which is not.
    const done = await runTurn(session.meta.id, `Open it [mock:visit /__redirect?to=http://localhost:${MOCK_PORT}/__whoami]`, { respond: [{ kind: 'permission', payload: { decision: 'allow_session' } }] });
    const result = lastToolResult(done);
    assert.ok(result.meta.withheld);
    assert.doesNotMatch(String(result.content), /signed in/i);
    // Allowed once: the agent sees that page, and the site is not approved for later actions.
    const once = await api('POST', '/api/sessions', { cwd: project, mode: 'edits' });
    const shown = lastToolResult(await runTurn(once.meta.id, 'Open it [mock:visit /__whoami]', { respond: [{ kind: 'permission', payload: { decision: 'allow' } }] }));
    assert.ok(!shown.meta.withheld && !shown.is_error, 'the page allowed once is shown');
    assert.deepEqual((await api('GET', `/api/sessions/${once.meta.id}`)).allowedHosts || [], []);
    // A batch that only looks needs no approval, and shows nothing of a site not approved. One that acts asks
    // once, listing its steps.
    const looked = lastToolResult(await runTurn(once.meta.id, `Look [mock:tool browser ${JSON.stringify({ action: 'batch', steps: [{ action: 'read' }, { action: 'console' }] })}]`));
    assert.ok(looked.meta.withheld && !looked.is_error);
    const acted = lastToolResult(await runTurn(once.meta.id, `Act [mock:tool browser ${JSON.stringify({ action: 'batch', steps: [{ action: 'press', key: 'Tab' }, { action: 'read' }] })}]`, { respond: [{ kind: 'permission', payload: { decision: 'allow' } }] }));
    const asked = events.filter((event) => event.type === 'runtime' && event.sessionId === once.meta.id && event.runtime.waiting?.request === 'browser').at(-1);
    assert.match(asked.runtime.waiting.detail, /^Run 2 steps:\n1\. Press Tab\n2\. Go read$/);
    assert.match(acted.content, /^2\. Title:/m, 'allowed once, the batch shows the page');
    // While the user decides, the page moves to another site: the approved click does not happen there.
    const startIndex = events.length;
    await api('POST', `/api/sessions/${once.meta.id}/messages`, { text: `Click [mock:tool browser ${JSON.stringify({ action: 'click', x: 10, y: 10 })}]` });
    const card = await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.sessionId === once.meta.id && event.runtime.waiting?.request === 'browser');
    await api('POST', `/api/sessions/${once.meta.id}/browser/navigate`, { url: `http://localhost:${MOCK_PORT}/__whoami` });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await api('POST', `/api/sessions/${once.meta.id}/respond`, { waitId: card.runtime.waiting.id, decision: 'allow' });
    await waitFor((event) => events.indexOf(event) >= startIndex && event.type === 'turn_end' && event.sessionId === once.meta.id, 30000);
    const moved = lastToolResult(await api('GET', `/api/sessions/${once.meta.id}`));
    assert.ok(moved.is_error && /The page moved to http:\/\/localhost:\d+ while the user decided/.test(moved.content), String(moved.content));
  } finally {
    await api('POST', '/api/project/browser/clear', { folder: project }).catch(() => {});
  }
});

test('two starts at once with the same data folder: one server, the other start uses it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-double-'));
  const mock = `http://127.0.0.1:${MOCK_PORT}`;
  const env = { ...process.env, CALIOPE_DATA_DIR: dataDir, CALIOPE_PLAIN_SECRETS: '1', CALIOPE_NO_BROWSER: '1', CALIOPE_API_BASE: mock, CALIOPE_GITHUB_WEB: mock, CALIOPE_GITHUB_API: mock, CALIOPE_RELEASES_URL: `${mock}/__releases` };
  const launch = () => {
    const child = spawn(process.execPath, ['server/main.js', '--stay'], { cwd: root, env, stdio: 'ignore' });
    children.push(child);
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited };
  };
  const [first, second] = [launch(), launch()];
  // The start that loses finds the other server and ends. The one that wins keeps running.
  const code = await Promise.race([first.exited, second.exited, new Promise((resolve) => setTimeout(() => resolve('none'), 25000))]);
  assert.equal(code, 0, 'one start ended normally');
  const exitedNow = [first, second].filter(({ child }) => child.exitCode !== null);
  assert.equal(exitedNow.length, 1, 'the other start is the server');
  const server = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
  const survivor = [first, second].find(({ child }) => child.exitCode === null).child;
  assert.equal(server.pid, survivor.pid);
  survivor.kill();
});

test('the update check reads the latest release and reports a newer version', async () => {
  const update = await api('POST', '/api/update/check');
  assert.equal(update.latest, '9.9.9');
  assert.equal(update.available, true);
  assert.equal((await api('GET', '/api/state')).update.latest, '9.9.9');
});

test("the agent opens and merges pull requests on GitHub and Azure DevOps with git's own sign-in", async (t) => {
  const { detectExtraPath } = await import('../server/config.js');
  const { findGit, runGit } = await import('../server/tools/files.js');
  const gitExe = findGit(detectExtraPath());
  if (!gitExe) {
    t.skip('git not found');
    return;
  }
  const base = fs.realpathSync.native(path.dirname(project));
  const repo = path.join(base, 'pr-repo');
  const remote = path.join(base, 'pr-remote.git');
  fs.mkdirSync(repo);
  const git = (...args) => runGit(gitExe, args, repo);
  await runGit(gitExe, ['init', '-q', '--bare', remote], base);
  await git('init', '-q', '-b', 'main');
  // The pull request goes to the mock's API. The push goes to a local bare repository.
  await git('remote', 'add', 'origin', 'https://github.com/test/caliope-pr.git');
  await git('remote', 'set-url', '--push', 'origin', remote);
  // git's credential for the remote, instead of this PC's Git Credential Manager.
  await git('config', 'credential.helper', '');
  await git('config', '--add', 'credential.helper', '!f() { echo username=x-token; echo password=mock-token; }; f');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  await git('switch', '-q', '-c', 'feature/export');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'two\n');
  await git('commit', '-qam', 'Export invoices');

  const input = { title: 'Export invoices as CSV', description: 'Adds the export.' };
  const session = await api('POST', '/api/sessions', { cwd: repo, mode: 'ask', trust: true });
  const github = lastToolResult(await runTurn(session.meta.id, `Open it [mock:tool create_pull_request ${JSON.stringify(input)}]`, { respond: [{ kind: 'permission', payload: { decision: 'allow' } }] }));
  assert.equal(github.meta.url, 'https://github.com/test/caliope-pr/pull/7');
  const requests = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json();
  const created = requests.filter((request) => request.path === '/repos/test/caliope-pr/pulls').at(-1);
  assert.deepEqual([created.body.head, created.body.base, created.body.title], ['feature/export', 'main', input.title]);
  assert.match(await runGit(gitExe, ['branch', '--list', 'feature/export'], remote), /feature\/export/, 'the branch was pushed');
  // A push address for another repository is refused: the approval names origin's repository.
  await git('remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/someone-else/caliope-pr.git');
  const elsewhere = lastToolResult(await runTurn(session.meta.id, `Open it [mock:tool create_pull_request ${JSON.stringify(input)}]`));
  assert.match(elsewhere.content, /origin pushes to https:\/\/github\.com\/someone-else\/caliope-pr\.git/);
  await git('remote', 'set-url', '--delete', '--push', 'origin', 'someone-else');

  // Merging asks even with full access. The card's choices are used. The approved commit is sent along.
  const full = await api('POST', '/api/sessions', { cwd: repo, mode: 'full' });
  const startIndex = events.length;
  const merged = lastToolResult(await runTurn(full.meta.id, `Merge it [mock:tool merge_pull_request ${JSON.stringify({ number: 7 })}]`, { respond: [{ kind: 'permission', payload: { decision: 'allow', method: 'merge', deleteBranch: true } }] }));
  const card = events.find((event) => events.indexOf(event) >= startIndex && event.type === 'runtime' && event.runtime.waiting?.request === 'merge').runtime.waiting;
  assert.deepEqual([card.number, card.source, card.target, card.method, card.methods, card.deleteBranch], [7, 'feature/export', 'main', 'squash', ['merge', 'squash'], false]);
  assert.match(merged.content, /Merged pull request 7 \(feature\/export into main\) on GitHub as f00dfeed0000\. The branch feature\/export was deleted\./);
  const mergeRequests = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json()).filter((request) => request.path.startsWith('/repos/test/caliope-pr/'));
  assert.deepEqual(mergeRequests.find((request) => request.method === 'PUT').body, { merge_method: 'merge', sha: 'abc123def4567890' });
  assert.ok(mergeRequests.some((request) => request.method === 'DELETE' && request.path === '/repos/test/caliope-pr/git/refs/heads/feature/export'));
  const blocked = lastToolResult(await runTurn(full.meta.id, `Merge 8 [mock:tool merge_pull_request ${JSON.stringify({ number: 8 })}]`));
  assert.match(blocked.content, /cannot be merged now: Required checks or reviews have not passed yet/, 'blocked without asking');
  const planning = await api('POST', '/api/sessions', { cwd: repo, mode: 'plan' });
  assert.match(lastToolResult(await runTurn(planning.meta.id, `Merge [mock:tool merge_pull_request ${JSON.stringify({ number: 7 })}]`)).content, /Plan mode is on/);

  await git('remote', 'set-url', 'origin', 'https://dev.azure.com/test/proj/_git/caliope-pr');
  const azure = lastToolResult(await runTurn(full.meta.id, `Open it [mock:tool create_pull_request ${JSON.stringify(input)}]`));
  assert.equal(azure.meta.url, 'https://dev.azure.com/test/proj/_git/caliope-pr/pullrequest/12');
  // Azure DevOps: the pull request of the current branch. A non-blocking policy that still runs does not stop it.
  const completed = lastToolResult(await runTurn(full.meta.id, 'Merge it [mock:tool merge_pull_request {}]', { respond: [{ kind: 'permission', payload: { decision: 'allow' } }] }));
  assert.match(completed.content, /Merged pull request 12 \(feature\/export into main\) on Azure DevOps as c0ffee000000\./);
  const patch = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__requests`)).json()).find((request) => request.method === 'PATCH');
  assert.deepEqual(patch.body, { status: 'completed', lastMergeSourceCommit: { commitId: 'def4567890abc123' }, completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: false } });

  // The Pull requests page lists them per repository of a trusted project, with git's own sign-in.
  const onAzure = (await api('GET', '/api/pull-requests')).repositories.find((repository) => repository.folder === repo);
  assert.deepEqual([onAzure.provider, onAzure.repository, onAzure.pullRequests[0].number, onAzure.pullRequests[0].source], ['azure', 'test/proj/caliope-pr', 12, 'feature/export']);
  await git('remote', 'set-url', 'origin', 'https://github.com/test/caliope-pr.git');
  const listed = await api('GET', '/api/pull-requests');
  const onGithub = listed.repositories.find((repository) => repository.folder === repo);
  assert.deepEqual(onGithub.pullRequests[0], { number: 7, title: 'Export invoices as CSV', url: 'https://github.com/test/caliope-pr/pull/7', author: 'octo', source: 'feature/export', target: 'main', draft: false, updatedAt: onGithub.pullRequests[0].updatedAt });
  assert.ok(!listed.repositories.some((repository) => repository.folder === project), 'a project without a GitHub or Azure DevOps origin is left out');
  await api('PUT', '/api/project', { folder: repo, trusted: false });
  assert.ok(!(await api('GET', '/api/pull-requests')).repositories.some((repository) => repository.folder === repo), 'an untrusted project is left out');
  // git runs a credential helper the repository's own settings name: not in an untrusted folder.
  assert.match(lastToolResult(await runTurn(full.meta.id, `Merge [mock:tool merge_pull_request ${JSON.stringify({ number: 7 })}]`)).content, /has not trusted this folder/);
});
