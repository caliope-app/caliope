import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, repairUnansweredToolCalls } from '../server/store.js';
import { UsageLedger, parseAllowance, addToSessionUsage } from '../server/usage.js';
import { SettingsStore } from '../server/settings.js';
import { ProjectStore } from '../server/projects.js';
import { AgentManager } from '../server/agent.js';
import { runSubagent } from '../server/subagent.js';
import { pathKey } from '../server/tools/paths.js';
import { defaultModelId, effortFor } from '../server/models.js';
import { normalizeModel } from '../server/copilot.js';
import { loadInstructions } from '../server/prompts.js';

const log = { info() {}, warn() {}, error() {} };

test('session store saves, reloads, searches, forks and deletes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-store-'));
  const store = new SessionStore({ sessionsDir: dir, log });
  await store.init();
  const session = await store.create({ cwd: 'C:\\proj', mode: 'ask', model: 'm', effort: 'medium' });
  session.data.messages.push({ id: 'm1', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Refactor the billing parser' }] });
  session.data.messages.push({ id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Done with the parser.' }] });
  session.data.checkpoints.push({ id: 'c', messageId: 'm2', path: 'C:\\proj\\a', before: await store.writeBlob(session.meta.id, Buffer.from('old')), after: await store.writeBlob(session.meta.id, Buffer.from('new')) });
  await store.save(session.meta.id);

  const reopened = new SessionStore({ sessionsDir: dir, log });
  await reopened.init();
  const loaded = await reopened.get(session.meta.id);
  assert.equal(loaded.data.messages.length, 2);
  assert.equal(loaded.meta.messageCount, 2);
  const results = await reopened.search('REFACTOR Billing');
  assert.equal(results[0].id, session.meta.id);
  // The search ignores case; the snippet shows the text as written.
  assert.match(results[0].snippet, /Refactor the billing parser/);
  assert.equal((await reopened.search('nonexistent words')).length, 0);
  assert.equal((await reopened.search('parser (')).length, 0, 'a word with ( is plain text, not a pattern');

  const fork = await reopened.fork(session.meta.id, 2);
  assert.equal(fork.data.messages.length, 2);
  assert.equal((await reopened.readBlob(fork.meta.id, fork.data.checkpoints[0].before)).toString(), 'old');
  const partial = await reopened.fork(session.meta.id, 1);
  assert.equal(partial.data.checkpoints.length, 0);

  await reopened.remove(session.meta.id);
  assert.equal(reopened.getMeta(session.meta.id), null);
  assert.ok(!fs.existsSync(path.join(dir, session.meta.id)));
});

test('loads of one session at the same time share one object, so a turn added to it is saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-store-'));
  const store = new SessionStore({ sessionsDir: dir, log });
  await store.init();
  const { meta } = await store.create({ cwd: 'C:\\proj', mode: 'ask', model: 'm', effort: 'medium' });
  const reopened = new SessionStore({ sessionsDir: dir, log });
  await reopened.init();
  const [first, second] = await Promise.all([reopened.get(meta.id), reopened.get(meta.id)]);
  assert.equal(first, second);
  second.data.messages.push({ id: 'm1', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Keep this turn' }] });
  await reopened.save(meta.id);
  const again = new SessionStore({ sessionsDir: dir, log });
  await again.init();
  assert.equal((await again.get(meta.id)).data.messages.length, 1);
});

test('images are saved once in blobs/, older sessions with images inside session.json still load, and a torn blob is replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-images-'));
  const store = new SessionStore({ sessionsDir: dir, log });
  await store.init();
  const session = await store.create({ cwd: 'C:\\proj', mode: 'ask', model: 'm', effort: 'medium' });
  const id = session.meta.id;
  const sessionFile = path.join(dir, id, 'session.json');
  const pasted = Buffer.from(`pasted screenshot ${'a'.repeat(200)}`).toString('base64');
  const page = Buffer.from(`pdf page one ${'b'.repeat(200)}`).toString('base64');
  session.data.messages.push({ id: 'm1', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'Look' }, { type: 'image', mediaType: 'image/png', data: pasted }] });
  session.data.messages.push({ id: 'm2', role: 'user', kind: 'tool_results', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Page 1:' }, { type: 'image', mediaType: 'image/jpeg', data: page }] }] });
  await store.save(id);
  const text = fs.readFileSync(sessionFile, 'utf8');
  assert.ok(!text.includes(pasted) && !text.includes(page), 'session.json holds no image data');
  assert.equal(fs.readdirSync(path.join(dir, id, 'blobs')).length, 2);
  assert.equal(session.data.messages[0].content[1].data, pasted, 'the session in memory keeps its images');

  const reopened = new SessionStore({ sessionsDir: dir, log });
  await reopened.init();
  const loaded = await reopened.get(id);
  assert.deepEqual(loaded.data.messages[0].content[1], { type: 'image', mediaType: 'image/png', data: pasted });
  assert.equal(loaded.data.messages[1].content[0].content[1].data, page);

  // A session saved by an older version: the image inside session.json. It loads and sends as it is,
  // and the next save moves the image to blobs/.
  fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(text), messages: [{ id: 'm1', role: 'user', kind: 'prompt', content: [{ type: 'image', mediaType: 'image/png', data: pasted }] }] }));
  const older = new SessionStore({ sessionsDir: dir, log });
  await older.init();
  const olderSession = await older.get(id);
  assert.equal(olderSession.data.messages[0].content[0].data, pasted);
  await older.save(id);
  assert.ok(!fs.readFileSync(sessionFile, 'utf8').includes(pasted));

  // An image file that cannot be read for another reason (here a folder in its place, like a file that antivirus
  // holds) fails the load instead of becoming a note. The next load gets the image back.
  const blobFile = path.join(dir, id, 'blobs', JSON.parse(fs.readFileSync(sessionFile, 'utf8')).messages[0].content[0].blob);
  const blobBytes = fs.readFileSync(blobFile);
  fs.rmSync(blobFile);
  fs.mkdirSync(blobFile);
  const locked = new SessionStore({ sessionsDir: dir, log });
  await locked.init();
  await assert.rejects(locked.get(id), (error) => error.code === 'EISDIR');
  fs.rmdirSync(blobFile);
  fs.writeFileSync(blobFile, blobBytes);
  assert.equal((await locked.get(id)).data.messages[0].content[0].data, pasted);

  // A missing image file must not break every request of the session.
  for (const name of fs.readdirSync(path.join(dir, id, 'blobs'))) fs.rmSync(path.join(dir, id, 'blobs', name));
  const missing = new SessionStore({ sessionsDir: dir, log });
  await missing.init();
  assert.equal((await missing.get(id)).data.messages[0].content[0].type, 'text');

  const hash = await store.writeBlob(id, Buffer.from('the whole file'));
  fs.writeFileSync(path.join(dir, id, 'blobs', hash), 'the wh');
  await store.writeBlob(id, Buffer.from('the whole file'));
  assert.equal((await store.readBlob(id, hash)).toString(), 'the whole file', 'a blob cut off by a crash is written again');
});

test('a damaged projects file is kept aside, and updates at the same time reach the file in order', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-projects-'));
  const file = path.join(folder, 'projects.json');
  fs.writeFileSync(file, '{"c:\\\\proj": {"trusted": tr');
  const warnings = [];
  const projects = new ProjectStore(file, { ...log, warn: (message) => warnings.push(message) });
  await projects.load();
  assert.equal(fs.readFileSync(`${file}.damaged`, 'utf8'), '{"c:\\\\proj": {"trusted": tr', 'the trust decisions can still be recovered');
  assert.equal(warnings.length, 1);
  assert.deepEqual(projects.saved(), []);
  await Promise.all(['one', 'two', 'three', 'four'].map((memory) => projects.update(folder, { memory })));
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))[0].memory, 'four');
});

test('repairUnansweredToolCalls adds results for tool calls that never ran', () => {
  const messages = [
    { id: '1', role: 'user', kind: 'prompt', content: [{ type: 'text', text: 'x' }] },
    { id: '2', role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: {} }, { type: 'tool_use', id: 'b', name: 'read_file', input: {} }] },
    { id: '3', role: 'user', kind: 'tool_results', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ];
  assert.ok(repairUnansweredToolCalls(messages));
  assert.equal(messages.at(-1).content[0].tool_use_id, 'b');
  assert.ok(!repairUnansweredToolCalls(messages));
});

test('usage ledger totals by day, model, kind, session and project; unpriced requests are not free', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-usage-')), 'usage.jsonl');
  const ledger = new UsageLedger({ file, log });
  await ledger.init();
  ledger.record({ sessionId: 's1', project: 'c:\\billing', model: 'opus', kind: 'chat', usage: { input: 100, output: 10, cacheRead: 50, nanoAiu: 2e9 } });
  ledger.record({ sessionId: 's1', project: 'c:\\billing', model: 'haiku', kind: 'title', usage: { input: 10, output: 2, nanoAiu: null } });
  ledger.record({ sessionId: 's2', project: 'c:\\shop', model: 'opus', kind: 'chat', usage: { input: 10, output: 1, nanoAiu: 1e9 } });
  const summary = ledger.summary();
  assert.equal(summary.total.nanoAiu, 3e9);
  assert.equal(summary.total.requests, 3);
  assert.equal(summary.total.unpricedRequests, 1);
  assert.equal(summary.bySession.find((entry) => entry.sessionId === 's1').nanoAiu, 2e9);
  assert.equal(summary.byModel[0].model, 'opus');
  assert.deepEqual(summary.byProject.map((entry) => [entry.project, entry.requests, entry.unpricedRequests, entry.nanoAiu]), [['c:\\billing', 2, 1, 2e9], ['c:\\shop', 1, 0, 1e9]]);
  // What the app waits for before it exits: every recorded line is in the file.
  await ledger.flush();
  const reloaded = new UsageLedger({ file, log });
  await reloaded.init();
  assert.equal(reloaded.summary().total.requests, 3);

  const sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: 0, requests: 0 };
  addToSessionUsage(sessionUsage, 'opus', { input: 5, output: 1, nanoAiu: 7 });
  addToSessionUsage(sessionUsage, 'opus', { input: 5, output: 1, nanoAiu: null });
  addToSessionUsage(sessionUsage, 'opus', { input: 0, output: 0, nanoAiu: null, cut: true });
  assert.equal(sessionUsage.nanoAiu, 7);
  assert.equal(sessionUsage.unpricedRequests, 1, 'a cut stream is not unpriced');
  assert.equal(sessionUsage.byModel.opus.requests, 3);

  // This month, per project and for all of Caliope. A /chat/completions stream cut before its usage
  // arrived (a stop by the user) has no tokens and no cost. It counts as a request, but not as unpriced.
  ledger.record({ sessionId: 's3', project: 'c:\\a', model: 'gpt', kind: 'chat', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: null, cut: true } });
  ledger.record({ sessionId: 's3', project: 'c:\\a', model: 'gpt', kind: 'chat', usage: { input: 9, output: 1, nanoAiu: 4e9 } });
  assert.deepEqual(ledger.spendThisMonth('c:\\a'), { nanoAiu: 4e9, unpricedRequests: 0 });
  assert.deepEqual(ledger.spendThisMonth(), { nanoAiu: 7e9, unpricedRequests: 1 });
  const { total } = ledger.summary();
  assert.deepEqual([total.requests, total.unpricedRequests], [5, 1]);
  await ledger.flush();
  const reread = new UsageLedger({ file, log });
  await reread.init();
  assert.deepEqual(reread.spendThisMonth('c:\\a'), { nanoAiu: 4e9, unpricedRequests: 0 }, 'the file keeps the mark');
});

test('spending limits: the monthly limit in Settings stops the agent, and requests without a cost are named once a month', () => {
  const ledger = new UsageLedger({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-limits-')), 'usage.jsonl'), log });
  const values = { creditLimit: 0 };
  const tasks = [{ id: 'nightly', maxCredits: 50 }];
  const manager = new AgentManager({
    config: {},
    settings: { get: () => ({ ...values }) },
    store: { save() {}, getMeta: () => null },
    hub: { broadcast() {} },
    log,
    ledger,
    projects: { get: () => ({ creditLimit: 0, schedules: tasks }) },
  });
  const session = (id, extra = {}) => ({ meta: { id, cwd: 'C:\\proj', usage: { nanoAiu: 0, unpricedRequests: 0 }, ...extra }, data: { messages: [] } });
  const notices = (target) => target.data.messages.map((message) => message.text);
  const chat = session('s1');
  ledger.record({ sessionId: 'elsewhere', project: 'c:\\other', model: 'opus', kind: 'chat', usage: { nanoAiu: 4.5e9 } });
  manager.checkSpendingLimit(chat);
  assert.deepEqual(notices(chat), [], 'no limit set');
  values.creditLimit = 5;
  manager.checkSpendingLimit(chat);
  assert.deepEqual(notices(chat), ['Caliope has used 90% of its 5 AI credits for this month.'], 'the limit counts every project');

  // A stream the user stopped before its usage came has no cost, but it is no request a limit misses.
  ledger.record({ sessionId: 's1', project: pathKey('C:\\proj'), model: 'gpt', kind: 'chat', usage: { input: 0, output: 0, nanoAiu: null, cut: true } });
  manager.checkSpendingLimit(chat);
  assert.equal(notices(chat).length, 1);
  // A request Copilot reported no cost for: one notice a month for the whole app, not one in every session.
  ledger.record({ sessionId: 's1', project: pathKey('C:\\proj'), model: 'gpt', kind: 'chat', usage: { input: 9, output: 1, nanoAiu: null } });
  const run = session('s2', { schedule: { id: 'nightly', name: 'Nightly', maxCredits: 50 }, usage: { nanoAiu: 0, unpricedRequests: 1 } });
  manager.checkSpendingLimit(run);
  manager.checkSpendingLimit(run);
  assert.deepEqual(notices(run).slice(1), ['Copilot reported no cost for some requests, so the limit per run of "Nightly" and the monthly limit in Settings cannot be fully enforced: those requests are not counted.']);
  manager.checkSpendingLimit(chat);
  assert.equal(notices(chat).length, 1);

  ledger.record({ sessionId: 's1', project: pathKey('C:\\proj'), model: 'opus', kind: 'chat', usage: { nanoAiu: 1e9 } });
  assert.throws(() => manager.checkSpendingLimit(chat), (error) => /Caliope reached its limit of 5 AI credits for this month \(5\.50 spent\)\. Raise the limit in Settings/.test(error.message) && error.project === undefined);
});

test('the project\'s limit and the limit in Settings each give their own 80% notice', () => {
  const ledger = new UsageLedger({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-limits-')), 'usage.jsonl'), log });
  const manager = new AgentManager({
    config: {},
    settings: { get: () => ({ creditLimit: 10 }) },
    store: { save() {}, getMeta: () => null },
    hub: { broadcast() {} },
    log,
    ledger,
    projects: { get: () => ({ creditLimit: 5, schedules: [] }) },
  });
  const chat = { meta: { id: 's1', cwd: 'C:\\proj', usage: { nanoAiu: 0, unpricedRequests: 0 } }, data: { messages: [] } };
  ledger.record({ sessionId: 's1', project: pathKey('C:\\proj'), model: 'opus', kind: 'chat', usage: { nanoAiu: 4.2e9 } });
  manager.checkSpendingLimit(chat);
  ledger.record({ sessionId: 'elsewhere', project: 'c:\\other', model: 'opus', kind: 'chat', usage: { nanoAiu: 4e9 } });
  manager.checkSpendingLimit(chat);
  manager.checkSpendingLimit(chat);
  assert.deepEqual(chat.data.messages.map((message) => message.text), ['This project has used 84% of its 5 AI credits for this month.', 'Caliope has used 82% of its 10 AI credits for this month.']);
});

test('Retry on a session that is gone says so', async () => {
  const manager = new AgentManager({ config: {}, store: { get: async () => null }, log });
  await assert.rejects(manager.runner('s-gone').retry(), /Session not found/);
});

test('a subagent gets the instruction files of a subfolder it reads, and the agent still gets them itself', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-subagent-'));
  fs.mkdirSync(path.join(project, 'billing'));
  fs.writeFileSync(path.join(project, 'billing', 'AGENTS.md'), 'Amounts are in cents.');
  fs.writeFileSync(path.join(project, 'billing', 'total.js'), 'export const total = 100;\n');
  const model = { id: 'gpt-4.1', name: 'GPT-4.1', protocol: 'chat', toolCalls: true, efforts: [] };
  // The subagent reads billing/total.js, then reports.
  const replies = [
    [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"billing/total.js"}' } }] }, finish_reason: 'tool_calls' }] }],
    [{ choices: [{ index: 0, delta: { content: 'Totals are in cents.' }, finish_reason: 'stop' }] }],
  ];
  const requests = [];
  const post = async (pathname, body) => {
    requests.push(body);
    const events = replies.shift().map((event) => `data: ${JSON.stringify(event)}\n\n`);
    return new Response(`${events.join('')}data: [DONE]\n\n`);
  };
  // cmd as the shell, so the test does not start PowerShell to check its language mode.
  const settings = { shell: 'cmd', maxOutputTokens: 4000, subagentModel: null, subagentEffort: 'medium', protectedFiles: [], globalInstructions: '', instructionFiles: [], creditLimit: 0 };
  const manager = new AgentManager({
    config: { dataDir: path.join(project, '.data'), tmpDir: path.join(project, '.tmp') },
    settings: { get: () => ({ ...settings }), effectiveExtraPath: () => [] },
    store: { save() {}, getMeta: () => null },
    client: { models: [model], adaptationsFor: () => ({}), post },
    hub: { broadcast() {} },
    log,
    ledger: { record() {}, spendThisMonth: () => ({ nanoAiu: 0, unpricedRequests: 0 }) },
    projects: { get: () => ({ trusted: true, creditLimit: 0, schedules: [], allowedSites: [], hooks: [] }) },
  });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: 0, requests: 0 };
  const session = { meta: { id: 's1', cwd: project, mode: 'ask', usage }, data: { messages: [], instructionFolders: [], readFiles: {}, checkpoints: [], allowedHosts: [] } };
  const input = { prompt: 'How are totals stored?', tools: 'read', model: 'gpt-4.1', description: 'Check totals' };
  const result = await runSubagent({ runner: manager.runner('s1'), session, assistant: { id: 'a1' }, input, signal: new AbortController().signal, progress() {} });
  assert.match(result.content, /^Totals are in cents\./);
  const toolResult = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(toolResult.content, /<instructions source="[^"]*AGENTS\.md">\nAmounts are in cents\.\n<\/instructions>/);
  assert.deepEqual(session.data.instructionFolders, [], 'the subagent keeps its own list');
});

test('parseAllowance reads token-based and missing fields without inventing zeros', () => {
  const allowance = parseAllowance({
    copilot_plan: 'business',
    quota_reset_date_utc: '2026-11-01T00:00:00Z',
    quota_snapshots: { premium_interactions: { entitlement: 1900, quota_remaining: 1450.5, percent_remaining: 76.3, unlimited: false, token_based_billing: true, credits_used: 449.5 } },
  });
  assert.equal(allowance.remaining, 1450.5);
  assert.equal(allowance.used, 449.5);
  assert.equal(allowance.tokenBased, true);
  const empty = parseAllowance({ copilot_plan: 'free' });
  assert.equal(empty.entitlement, null);
  assert.equal(empty.hasQuota, false);
  const derived = parseAllowance({ quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120 } } });
  assert.equal(derived.used, 180);
});

test('settings validate values and reject unknown keys', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-settings-')), 'settings.json');
  const settings = new SettingsStore(file, log);
  await settings.load();
  assert.deepEqual([settings.get().defaultMode, settings.firstRun], ['edits', true], 'a new install accepts edits and asks for a mode');
  await settings.update({ buildEffort: 'low', allowedCommands: [' git status ', ''] });
  assert.equal(settings.get().buildEffort, 'low');
  assert.deepEqual(settings.get().allowedCommands, ['git status']);
  assert.equal(settings.firstRun, true, 'until a default mode is chosen');
  await assert.rejects(settings.update({ buildEffort: 'extreme' }), /Invalid value/);
  await assert.rejects(settings.update({ nope: 1 }), /Unknown setting/);
  await assert.rejects(settings.update({ apiBase: 'http://evil.example' }), /https/);
  await assert.rejects(settings.update({ creditLimit: -1 }), /Invalid value for "creditLimit"/);
  await Promise.all(['high', 'max', 'medium', 'xhigh'].map((effort) => settings.update({ planEffort: effort })));
  const reread = new SettingsStore(file, log);
  await reread.load();
  assert.equal(reread.get().planEffort, 'xhigh', 'updates at the same time reach the file in order');
  await settings.update({ defaultMode: 'auto', creditLimit: 2000 });
  assert.equal(settings.firstRun, false);
  const saved = new SettingsStore(file, log);
  await saved.load();
  assert.deepEqual([saved.get().defaultMode, saved.get().creditLimit, saved.firstRun], ['auto', 2000, false], 'saved settings keep their mode');
  fs.writeFileSync(file, '{broken');
  const damaged = new SettingsStore(file, log);
  await damaged.load();
  assert.equal(damaged.get().buildEffort, 'medium');
});

test('the Startup entry\'s --background starts without a window and closes like a normal start', async () => {
  const { loadConfig } = await import('../server/config.js');
  const env = { LOCALAPPDATA: os.tmpdir() };
  const start = (argv) => {
    const { open, stay } = loadConfig(argv, env);
    return { open, stay };
  };
  // Caliope.cmd always passes --open, and passes the Startup entry's --background on after it.
  assert.deepEqual(start(['--open', '--background']), { open: false, stay: false });
  assert.deepEqual(start(['--open']), { open: true, stay: false });
  assert.deepEqual(start([]), { open: false, stay: true }, 'a start without --open is for development');
  assert.deepEqual(start(['--open', '--stay']), { open: true, stay: true });
});

test('instructions: the user\'s CLAUDE.md once, then the files Claude Code reads in the project', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-instructions-'));
  const userFile = path.join(folder, 'home-claude.md');
  fs.writeFileSync(userFile, 'Keep code direct.');
  const project = path.join(folder, 'project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Run npm test.');
  fs.writeFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'Use tabs.');
  fs.writeFileSync(path.join(project, 'CLAUDE.local.md'), 'My sandbox is dev-3.');
  const settings = { globalInstructions: '', instructionFiles: [userFile.toUpperCase()] };
  const items = await loadInstructions({ cwd: project, root: project, settings, userFile });
  assert.deepEqual(items.map((item) => item.text), ['Keep code direct.', 'Run npm test.', 'Use tabs.', 'My sandbox is dev-3.']);
  const untrusted = await loadInstructions({ cwd: project, root: project, settings, userFile, includeProject: false });
  assert.deepEqual(untrusted.map((item) => item.text), ['Keep code direct.'], 'an untrusted folder\'s own files are not read');
});

test('model defaults pick the newest Opus to plan and build; effort snaps to a supported level', () => {
  const models = [
    { id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', supports: { tool_calls: true, reasoning_effort: ['low', 'medium', 'high'] } } },
    { id: 'claude-fable-5.1', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', supports: { tool_calls: true, reasoning_effort: ['low', 'medium', 'high', 'xhigh', 'max'] } } },
    { id: 'claude-haiku-5.5', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', supports: { tool_calls: true } } },
    { id: 'gpt-6-sol', supported_endpoints: ['/responses'], capabilities: { type: 'chat', supports: { tool_calls: true } } },
    { id: 'embed', capabilities: { type: 'embeddings' } },
  ]
    .map(normalizeModel)
    .filter(Boolean);
  assert.equal(models.length, 4);
  assert.equal(models.find((model) => model.id === 'gpt-6-sol').protocol, 'responses', 'GPT-5 and later only offer /responses');
  const settings = { planModel: null, buildModel: null, titleModel: null };
  assert.equal(defaultModelId('plan', settings, models), 'claude-opus-5.5', 'not Fable, which costs far more');
  assert.equal(defaultModelId('build', settings, models), 'claude-opus-5.5');
  assert.equal(defaultModelId('title', settings, models), 'claude-haiku-5.5');
  assert.equal(defaultModelId('build', { ...settings, buildModel: 'gone' }, models), 'claude-opus-5.5');
  const claude = (id, state = 'enabled') => normalizeModel({ id, policy: { state }, supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', supports: { tool_calls: true } } });
  assert.equal(defaultModelId('build', settings, [...models, claude('claude-sonnet-5.5')]), 'claude-opus-5.5', 'Opus builds, also when Sonnet is there');
  assert.equal(defaultModelId('build', settings, [claude('claude-opus-4.8'), ...models, claude('claude-opus-5.5-1m')]), 'claude-opus-5.5', 'the newest plain Opus');
  assert.equal(defaultModelId('build', settings, [...models, claude('claude-opus-6', 'unconfigured')]), 'claude-opus-5.5', 'not a model that still needs enabling');
  assert.equal(defaultModelId('build', settings, [models[1], claude('claude-sonnet-5.5')]), 'claude-sonnet-5.5', 'Sonnet when there is no Opus, never Fable');
  assert.equal(effortFor(models[0], 'xhigh'), 'high');
  assert.equal(effortFor(models[0], 'medium'), 'medium');
  assert.equal(effortFor(models[2], 'medium'), null);
  // Read-only subagents explore on a small model with a large window, never on GPT-4o mini (12k tokens).
  const chat = (id) => normalizeModel({ id, supported_endpoints: [/^gpt-[5-9]/.test(id) ? '/responses' : '/chat/completions'], capabilities: { type: 'chat', supports: { tool_calls: true } } });
  assert.equal(defaultModelId('explore', settings, models), 'claude-haiku-5.5');
  assert.equal(defaultModelId('explore', settings, [...models, chat('gpt-4o-mini'), chat('gpt-5.4-mini')]), 'gpt-5.4-mini');
  assert.equal(defaultModelId('explore', settings, [models[0], chat('gpt-4o-mini')]), null);
  // Auto mode's safety check: the fast free utility model, else GPT-4o mini.
  assert.equal(defaultModelId('check', settings, [...models, chat('gpt-4.1'), chat('gpt-4o-mini'), chat('gpt-5.6-luna-utility')]), 'gpt-5.6-luna-utility');
  assert.equal(defaultModelId('check', settings, [...models, chat('gpt-4.1'), chat('gpt-4o-mini')]), 'gpt-4o-mini');
  // web_search: OpenAI's search on the free utility model only. Without it, DuckDuckGo.
  assert.equal(defaultModelId('search', settings, [...models, chat('gpt-6-luna'), chat('gpt-5.6-luna-utility')]), 'gpt-5.6-luna-utility');
  assert.equal(defaultModelId('search', settings, [...models, chat('gpt-6-luna')]), null);
});
