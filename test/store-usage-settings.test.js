import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, repairUnansweredToolCalls } from '../server/store.js';
import { UsageLedger, parseAllowance, addToSessionUsage } from '../server/usage.js';
import { SettingsStore } from '../server/settings.js';
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
  const results = await reopened.search('billing parser');
  assert.equal(results[0].id, session.meta.id);
  assert.equal((await reopened.search('nonexistent words')).length, 0);

  const fork = await reopened.fork(session.meta.id, 2);
  assert.equal(fork.data.messages.length, 2);
  assert.equal((await reopened.readBlob(fork.meta.id, fork.data.checkpoints[0].before)).toString(), 'old');
  const partial = await reopened.fork(session.meta.id, 1);
  assert.equal(partial.data.checkpoints.length, 0);

  await reopened.remove(session.meta.id);
  assert.equal(reopened.getMeta(session.meta.id), null);
  assert.ok(!fs.existsSync(path.join(dir, session.meta.id)));
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

test('usage ledger totals by day, model, kind and session; unpriced requests are not free', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-usage-')), 'usage.jsonl');
  const ledger = new UsageLedger({ file, log });
  await ledger.init();
  ledger.record({ sessionId: 's1', model: 'opus', kind: 'chat', usage: { input: 100, output: 10, cacheRead: 50, nanoAiu: 2e9 } });
  ledger.record({ sessionId: 's1', model: 'haiku', kind: 'title', usage: { input: 10, output: 2, nanoAiu: null } });
  ledger.record({ sessionId: 's2', model: 'opus', kind: 'chat', usage: { input: 10, output: 1, nanoAiu: 1e9 } });
  const summary = ledger.summary();
  assert.equal(summary.total.nanoAiu, 3e9);
  assert.equal(summary.total.requests, 3);
  assert.equal(summary.total.unpricedRequests, 1);
  assert.equal(summary.bySession.find((entry) => entry.sessionId === 's1').nanoAiu, 2e9);
  assert.equal(summary.byModel[0].model, 'opus');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloaded = new UsageLedger({ file, log });
  await reloaded.init();
  assert.equal(reloaded.summary().total.requests, 3);

  const sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: 0, requests: 0 };
  addToSessionUsage(sessionUsage, 'opus', { input: 5, output: 1, nanoAiu: 7 });
  addToSessionUsage(sessionUsage, 'opus', { input: 5, output: 1, nanoAiu: null });
  assert.equal(sessionUsage.nanoAiu, 7);
  assert.equal(sessionUsage.unpricedRequests, 1);
  assert.equal(sessionUsage.byModel.opus.requests, 2);
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
  await settings.update({ buildEffort: 'low', allowedCommands: [' git status ', ''] });
  assert.equal(settings.get().buildEffort, 'low');
  assert.deepEqual(settings.get().allowedCommands, ['git status']);
  await assert.rejects(settings.update({ buildEffort: 'extreme' }), /Invalid value/);
  await assert.rejects(settings.update({ nope: 1 }), /Unknown setting/);
  await assert.rejects(settings.update({ apiBase: 'http://evil.example' }), /https/);
  fs.writeFileSync(file, '{broken');
  const damaged = new SettingsStore(file, log);
  await damaged.load();
  assert.equal(damaged.get().buildEffort, 'medium');
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
