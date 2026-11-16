import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectExtraPath } from '../server/config.js';
import { findGit, runGit } from '../server/tools/files.js';
import { gitChanges, parseStatus, createWorktree, removeWorktree } from '../server/git.js';
import { discoverCommands, expandCommand } from '../server/commands.js';
import { isInside } from '../server/tools/paths.js';
import { createPullRequestTool, readPullRequestTool } from '../server/tools/pull-request.js';
import { McpHub } from '../server/mcp.js';

const extraPath = detectExtraPath();
const gitExe = findGit(extraPath);

function tempFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-test-'));
  return folder;
}

/** tools/mock-copilot.js on a free port: the GitHub and Azure DevOps pull request API. Stops when the test ends. */
async function startMock(t) {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'tools', 'mock-copilot.js'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => /MOCK READY/.test(chunk) && resolve());
    child.on('exit', (code) => reject(new Error(`The mock stopped (exit code ${code}).`)));
  });
  const mock = `http://127.0.0.1:${port}`;
  return mock;
}

/**
 * A repository on branch feature/export whose origin is `remoteUrl`. Pushes go to a bare repository next to it, and
 * git's sign-in for the remote is "mock-token", as the mock expects.
 */
async function pullRequestRepository(remoteUrl) {
  const repo = await tempRepository();
  const bare = path.join(path.dirname(repo), 'remote.git');
  await runGit(gitExe, ['init', '-q', '--bare', bare], path.dirname(repo));
  const git = (...args) => runGit(gitExe, args, repo);
  await git('remote', 'add', 'origin', remoteUrl);
  await git('remote', 'set-url', '--push', 'origin', bare);
  await git('config', 'credential.helper', '');
  await git('config', '--add', 'credential.helper', '!f() { echo username=x-token; echo password=mock-token; }; f');
  await git('switch', '-q', '-c', 'feature/export');
  return repo;
}

/** The context the pull request tools get from a session in a trusted folder. */
function toolContext(repo, mock) {
  const ctx = { trusted: true, cwd: repo, extraPath, endpoints: { githubApi: mock, azureDevOpsUrl: `${mock}/ado` }, signal: AbortSignal.timeout(60000) };
  return ctx;
}

/** A repository with one commit: tracked.txt and old-name.txt. Its path is the long form git reports. */
async function tempRepository() {
  const repo = path.join(fs.realpathSync.native(tempFolder()), 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'old-name.txt'), 'moved\n');
  await runGit(gitExe, ['init', '-q', '-b', 'main'], repo);
  await runGit(gitExe, ['add', '.'], repo);
  await runGit(gitExe, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], repo);
  return repo;
}

test('parseStatus reads porcelain -z output with renames in either column and spaces', () => {
  const output = ' M src/app.js\0?? new file.txt\0R  new-name.txt\0old-name.txt\0D  gone.txt\0 R moved.txt\0original.txt\0';
  assert.deepEqual(parseStatus(output), [
    { code: 'M', path: 'src/app.js' },
    { code: '??', path: 'new file.txt' },
    { code: 'R', path: 'new-name.txt', oldPath: 'old-name.txt' },
    { code: 'D', path: 'gone.txt' },
    { code: 'R', path: 'moved.txt', oldPath: 'original.txt' },
  ]);
});

test('isInside treats a folder named "..x" as inside', () => {
  assert.ok(isInside('C:\\repo', 'C:\\repo\\..config'));
  assert.ok(isInside('C:\\repo', 'C:\\repo'));
  assert.ok(isInside('C:\\Repo', 'C:\\repo\\src\\a.js'), 'Windows paths ignore case');
  assert.ok(!isInside('C:\\repo', 'C:\\repo\\..\\x'));
  assert.ok(!isInside('C:\\repo', 'C:\\repo-other'));
  assert.ok(!isInside('C:\\repo', 'C:\\'));
});

test('gitChanges lists modified, untracked, renamed and deleted files with diffs', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'hello\n');
  await runGit(gitExe, ['mv', 'old-name.txt', 'new-name.txt'], repo);
  const changes = await gitChanges(repo, extraPath);
  assert.equal(changes.repo, true);
  assert.equal(changes.branch, 'main');
  const byPath = Object.fromEntries(changes.files.map((file) => [path.relative(repo, file.path), file]));
  assert.equal(byPath['tracked.txt'].status, 'modified');
  assert.equal(byPath['tracked.txt'].added, 1);
  assert.equal(byPath['tracked.txt'].removed, 1);
  assert.equal(byPath['new file.txt'].status, 'untracked');
  assert.equal(byPath['new-name.txt'].status, 'renamed');
  assert.equal(byPath['new-name.txt'].added, 0, 'a pure rename has no line changes');
  assert.equal(byPath['new-name.txt'].shownPath, 'old-name.txt → new-name.txt');
  const outside = await gitChanges(tempFolder(), extraPath);
  assert.equal(outside.repo, false);
});

test('gitChanges lists files over 2 MB without reading them into a diff', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.writeFileSync(path.join(repo, 'big.log'), 'x'.repeat(3 * 1024 * 1024));
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  const changes = await gitChanges(repo, extraPath);
  const big = changes.files.find((file) => file.shownPath === 'big.log');
  assert.equal(big.tooLarge, true);
  assert.deepEqual(big.hunks, []);
  const small = changes.files.find((file) => file.shownPath === 'tracked.txt');
  assert.equal(small.removed, 2, 'small files still get a diff from the HEAD version');
});

test('createWorktree makes a branch and folder; removeWorktree refuses uncommitted work unless forced', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.mkdirSync(path.join(repo, 'sub'));
  const worktree = await createWorktree(path.join(repo, 'sub'), extraPath, 'test1');
  assert.equal(worktree.branch, 'caliope/test1');
  assert.equal(worktree.repoRoot, repo);
  assert.equal(worktree.sourceCwd, path.join(repo, 'sub'));
  assert.equal(worktree.folder, path.join(path.dirname(repo), 'repo-worktrees', 'test1'));
  assert.ok(fs.existsSync(path.join(worktree.folder, 'tracked.txt')));
  // "sub" is empty, so git does not check it out. It is created so the session can start there.
  assert.equal(worktree.cwd, path.join(worktree.folder, 'sub'));
  assert.ok(fs.statSync(worktree.cwd).isDirectory());
  fs.writeFileSync(path.join(worktree.folder, 'work.txt'), 'unsaved\n');
  await assert.rejects(removeWorktree(worktree, extraPath), /modified or untracked/);
  await removeWorktree(worktree, extraPath, { force: true });
  assert.ok(!fs.existsSync(worktree.folder));
  const branches = await runGit(gitExe, ['branch', '--list', 'caliope/*'], repo);
  assert.match(branches, /caliope\/test1/, 'the branch is kept');
  await assert.rejects(createWorktree(tempFolder(), extraPath, 'x'), /not in a git repository/);
  // git's own reason is reported, not its progress output.
  await assert.rejects(createWorktree(repo, extraPath, 'test1'), /already exists/);
});

test('a worktree for a subfolder whose name starts with two dots keeps that subfolder', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.mkdirSync(path.join(repo, '..config'));
  const worktree = await createWorktree(path.join(repo, '..config'), extraPath, 'dots');
  assert.equal(worktree.cwd, path.join(worktree.folder, '..config'));
  await removeWorktree(worktree, extraPath, { force: true });
});

test('custom commands: discovery, description and argument expansion', async () => {
  const project = tempFolder();
  fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(project, '.github', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'fix.md'), '---\ndescription: Fix an issue\n---\nFix $1 because $ARGUMENTS.\n');
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'tidy.md'), '# Tidy the code\nRemove dead code.\n');
  fs.writeFileSync(path.join(project, '.github', 'prompts', 'fix.prompt.md'), 'Shadowed by .claude/commands/fix.md\n');
  fs.writeFileSync(path.join(project, '.github', 'prompts', 'explain.prompt.md'), 'Explain the code.\n');
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'notes.txt'), 'not a command');
  fs.mkdirSync(path.join(project, '.claude', 'commands', 'db'));
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'db', 'migrate.md'), 'Write a migration for $ARGUMENTS.\n');
  const commands = (await discoverCommands(project)).filter((command) => command.source === 'project');
  assert.deepEqual(
    commands.map(({ name, description }) => ({ name, description })),
    [
      { name: 'db:migrate', description: 'Write a migration for $ARGUMENTS.' },
      { name: 'fix', description: 'Fix an issue' },
      { name: 'tidy', description: 'Tidy the code' },
      { name: 'explain', description: 'Explain the code.' },
    ],
  );
  const fix = commands.find((command) => command.name === 'fix');
  assert.equal(await expandCommand(fix, 'login.js it crashes'), 'Fix login.js because login.js it crashes.');
  const tidy = commands.find((command) => command.name === 'tidy');
  assert.equal(await expandCommand(tidy, 'in src'), '# Tidy the code\nRemove dead code.\n\nin src');
  assert.equal(await expandCommand(tidy, ''), '# Tidy the code\nRemove dead code.');
});

test('Azure DevOps pull requests get reviewers by email or ID and linked work items; a cut description is reported', { skip: !gitExe && 'git not found' }, async (t) => {
  const mock = await startMock(t);
  const repo = await pullRequestRepository('https://dev.azure.com/test/proj/_git/caliope-pr');
  const ctx = toolContext(repo, mock);
  const createdOnAzure = async () => (await (await fetch(`${mock}/__requests`)).json()).filter((request) => request.method === 'POST' && request.path.endsWith('/pullrequests'));
  const input = { title: 'Export invoices as CSV', description: 'x'.repeat(4100), reviewers: ['ann@example.com', 'b0b00000-0000-4000-8000-000000000002'], work_items: [101] };
  const created = await createPullRequestTool.run(input, ctx, await createPullRequestTool.prepare(input, ctx));
  assert.equal(created.meta.url, 'https://dev.azure.com/test/proj/_git/caliope-pr/pullrequest/12');
  assert.match(created.content, /takes at most 4,000 characters of description, so the description was cut there/);
  const body = (await createdOnAzure()).at(-1).body;
  assert.deepEqual(body.reviewers, [{ id: 'a5b1c2d3-0000-4000-8000-000000000001' }, { id: 'b0b00000-0000-4000-8000-000000000002' }]);
  assert.deepEqual(body.workItemRefs, [{ id: '101' }]);
  assert.equal(body.description.length, 4000);
  // A reviewer that does not match exactly one user or group stops before a pull request is opened.
  const opened = (await createdOnAzure()).length;
  for (const [reviewer, reason] of [['Team', /more than one user or group for the reviewer "Team"/], ['nobody@example.com', /no user or group for the reviewer "nobody@example\.com"/]]) {
    const withReviewer = { ...input, reviewers: [reviewer] };
    await assert.rejects(createPullRequestTool.run(withReviewer, ctx, await createPullRequestTool.prepare(withReviewer, ctx)), reason);
  }
  assert.equal((await createdOnAzure()).length, opened);
});

test('read_pull_request on Azure DevOps: votes, work items, policies and review comments, without system notes', { skip: !gitExe && 'git not found' }, async (t) => {
  const mock = await startMock(t);
  const repo = await pullRequestRepository('https://dev.azure.com/test/proj/_git/caliope-pr');
  const read = (await readPullRequestTool.run({}, toolContext(repo, mock))).content;
  assert.match(read, /^Pull request 12 in test\/proj\/caliope-pr on Azure DevOps: Export invoices as CSV\nactive\. feature\/export → main, by Octo\./);
  assert.match(read, /\nReviewers: Ann \(approved, required\), Bob \(waiting for author\)\.\nWork items: 101\.\nPolicies: Minimum number of reviewers: approved \(required\); Build: running\.\n/);
  // The branch search shortens the description: the pull request itself is read for the whole text.
  assert.match(read, /\nDescription:\nAdds the export\.\n/);
  assert.match(read, /\nComments \(1 thread\):\n- active, \/app\.txt line 1:\n {2}Ann \(2026-11-10\): Please rename this\.\n {2}Octo \(2026-11-10\): Done\.$/);
  assert.doesNotMatch(read, /voted 10|Deleted thread/);
});

test('GitHub: reviewers are asked after the pull request opens; read_pull_request shows reviews, comments and checks', { skip: !gitExe && 'git not found' }, async (t) => {
  const mock = await startMock(t);
  const repo = await pullRequestRepository('https://github.com/test/caliope-pr.git');
  const ctx = toolContext(repo, mock);
  const input = { title: 'Export invoices as CSV', description: 'Adds the export.', reviewers: ['nobody'] };
  await assert.rejects(createPullRequestTool.prepare({ ...input, work_items: [101] }, ctx), /Work items are linked on Azure DevOps only/);
  const created = await createPullRequestTool.run(input, ctx, await createPullRequestTool.prepare(input, ctx));
  assert.match(created.content, /^Opened pull request 7 on GitHub: \S+\nGitHub did not add the reviewers \(HTTP 422\): Reviews may only be requested from collaborators\./);
  const read = (await readPullRequestTool.run({ number: 7 }, ctx)).content;
  assert.match(read, /\nReviewers: alice \(changes requested\), bob \(review requested\)\.\nChecks: build: success\.\n/);
  assert.match(read, /\n- On the pull request:\n {2}bob \(2026-11-09\): Looks useful\.\n- changes requested:\n {2}alice \(2026-11-10\): Please add a test\.\n- app\.txt line 1:\n {2}alice \(2026-11-10\): Rename this\.\n {2}octo \(2026-11-10\): Done\.$/);
  assert.doesNotMatch(read, /Work items/);
});

/**
 * An MCP server over HTTP that needs an OAuth sign-in, with its own authorization server, as the MCP spec describes.
 * - It accepts only `state.accessToken`; a refresh rotates the refresh token. `state.wrongIssuer` makes the sign-in
 *   page answer as another authorization server.
 * - `state.resourceMetadata`, `state.resource`, `state.issuer` and `state.challengeMethods` replace what the 401
 *   answer and the metadata say, when set.
 */
async function startOAuthServer(t) {
  const state = { accessToken: null, refreshToken: null, issued: 0, refused: 0, wrongIssuer: false, authorize: null, tokenRequests: [], resourceMetadata: null, resource: null, issuer: null, challengeMethods: null };
  let base;
  const server = http.createServer(async (request, response) => {
    const address = new URL(request.url, base);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (status, value, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (address.pathname === '/mcp') {
      if (request.headers.authorization !== `Bearer ${state.accessToken}`) {
        state.refused++;
        return json(401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${state.resourceMetadata ?? `${base}/.well-known/oauth-protected-resource/mcp`}", scope="tools:read"` });
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const results = { initialize: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oauth-mock', version: '1.0.0' } }, 'tools/list': { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }, 'tools/call': { content: [{ type: 'text', text: `echo: ${message.params?.arguments?.text}` }] } };
      return json(200, { jsonrpc: '2.0', id: message.id, result: results[message.method] });
    }
    if (address.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: state.resource ?? `${base}/mcp`, authorization_servers: [state.issuer ?? `${base}/auth`], scopes_supported: ['tools:read'] });
    if (address.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`, code_challenge_methods_supported: state.challengeMethods ?? ['S256'], scopes_supported: ['tools:read', 'offline_access'], authorization_response_iss_parameter_supported: true });
    if (address.pathname === '/auth/register') return json(201, { client_id: 'caliope-client', ...JSON.parse(body) });
    if (address.pathname === '/auth/authorize') {
      state.authorize = Object.fromEntries(address.searchParams);
      const back = new URL(state.authorize.redirect_uri);
      back.search = new URLSearchParams({ code: 'the-code', state: state.authorize.state, iss: state.wrongIssuer ? 'https://other.example' : `${base}/auth` });
      response.writeHead(302, { Location: back.href });
      response.end();
      return;
    }
    if (address.pathname === '/auth/token') {
      const form = Object.fromEntries(new URLSearchParams(body));
      state.tokenRequests.push(form);
      const verified = form.grant_type === 'authorization_code' && form.code === 'the-code' && crypto.createHash('sha256').update(form.code_verifier || '').digest('base64url') === state.authorize.code_challenge && form.redirect_uri === state.authorize.redirect_uri;
      const refreshed = form.grant_type === 'refresh_token' && form.refresh_token === state.refreshToken;
      if (form.resource !== `${base}/mcp` || form.client_id !== 'caliope-client' || !(verified || refreshed)) return json(400, { error: 'invalid_grant' });
      state.issued++;
      state.accessToken = `access-${state.issued}`;
      state.refreshToken = `refresh-${state.issued}`;
      return json(200, { access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 3600, token_type: 'Bearer' });
    }
    json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  base = `http://127.0.0.1:${server.address().port}`;
  const started = { base, state };
  return started;
}

test('MCP over HTTP: a 401 leads to an OAuth sign-in with PKCE, and ended or expired tokens are refreshed', async (t) => {
  const { base, state } = await startOAuthServer(t);
  const log = { info() {}, warn() {}, error() {} };
  const signInFile = path.join(tempFolder(), 'mcp-auth.json');
  const server = { url: `${base}/mcp`, headers: {} };
  const servers = { oauth: server };
  const hub = new McpHub({ log, signInFile, plainSecrets: true });
  t.after(() => hub.closeAll());
  const before = await hub.toolsFor({ servers, cwd: os.tmpdir(), extraPath });
  assert.match(before.errors[0], /^The MCP server "oauth" asks for a sign-in \(HTTP 401\)\. Choose Sign in for it in Settings → MCP servers/);

  // The "browser" follows the sign-in page's redirect back to Caliope.
  const browser = (url) => fetch(url).catch(() => {});
  state.wrongIssuer = true;
  await assert.rejects(hub.signIn({ name: 'oauth', server, openUrl: browser }), /did not come from its authorization server/);
  assert.equal(state.tokenRequests.length, 0, 'a code from another authorization server is not exchanged');
  state.wrongIssuer = false;
  await hub.signIn({ name: 'oauth', server, openUrl: browser });
  assert.deepEqual([state.authorize.client_id, state.authorize.code_challenge_method, state.authorize.resource, state.authorize.scope], ['caliope-client', 'S256', `${base}/mcp`, 'tools:read offline_access']);
  assert.match(state.authorize.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const after = await hub.toolsFor({ servers, cwd: os.tmpdir(), extraPath });
  assert.deepEqual([after.errors, after.tools.map((tool) => tool.tool)], [[], ['echo']]);

  // The server ends the token early: Caliope refreshes it once and repeats the request.
  state.accessToken = 'ended';
  const called = await hub.call({ name: 'oauth', server, cwd: os.tmpdir(), extraPath, tool: 'echo', input: { text: 'hi' }, signal: AbortSignal.timeout(30000) });
  assert.equal(called.content, 'echo: hi');
  const saved = JSON.parse(fs.readFileSync(signInFile, 'utf8'));
  assert.deepEqual([Object.keys(saved), saved[server.url].plain.refreshToken], [[server.url], 'refresh-2']);

  // After a restart, a token past its expiry is refreshed before the request, without a 401 first.
  saved[server.url].plain.expiresAt = Date.now() - 1000;
  fs.writeFileSync(signInFile, JSON.stringify(saved));
  const restarted = new McpHub({ log, signInFile, plainSecrets: true });
  t.after(() => restarted.closeAll());
  const refusedBefore = state.refused;
  assert.deepEqual((await restarted.toolsFor({ servers, cwd: os.tmpdir(), extraPath })).errors, []);
  assert.deepEqual([state.accessToken, state.refused], ['access-3', refusedBefore]);
});

test('an MCP sign-in waits for the answer with its own state, refuses unsafe sign-ins, and a sign-out removes the tokens', async (t) => {
  const { base, state } = await startOAuthServer(t);
  const log = { info() {}, warn() {}, error() {} };
  const signInFile = path.join(tempFolder(), 'mcp-auth.json');
  const server = { url: `${base}/mcp`, headers: {} };
  const hub = new McpHub({ log, signInFile, plainSecrets: true });
  t.after(() => hub.closeAll());

  // Another program on this PC finds the port first and sends an error with a guessed state. The sign-in goes on.
  let forged = null;
  const browser = async (url) => {
    const redirectUri = new URL(url).searchParams.get('redirect_uri');
    forged = (await fetch(`${redirectUri}?error=access_denied&state=guessed&iss=${encodeURIComponent(`${base}/auth`)}`)).status;
    await fetch(url).catch(() => {});
  };
  assert.equal(await hub.signIn({ name: 'oauth', server, openUrl: browser }), null);
  assert.deepEqual([forged, state.issued], [404, 1]);

  // Refused before the browser opens.
  const refusals = [
    [{ resource: 'https://other.example/mcp' }, /describes its sign-in for another address/],
    [{ resourceMetadata: 'http://metadata.example/.well-known/oauth-protected-resource' }, /describes its sign-in at an address without https/],
    [{ issuer: 'http://auth.example' }, /authorization server of "oauth" does not use https/],
    [{ challengeMethods: ['plain'] }, /does not support PKCE \(S256\)/],
  ];
  for (const [change, refusal] of refusals) {
    Object.assign(state, change);
    await assert.rejects(hub.signIn({ name: 'oauth', server, openUrl: () => assert.fail('the browser opened') }), refusal);
    Object.assign(state, { resource: null, resourceMetadata: null, issuer: null, challengeMethods: null });
  }

  // Removing the server from Settings signs out of it (see main.js).
  await hub.signIns.remove(server.url);
  assert.deepEqual(JSON.parse(fs.readFileSync(signInFile, 'utf8')), {});
  assert.match((await hub.toolsFor({ servers: { oauth: server }, cwd: os.tmpdir(), extraPath })).errors[0], /asks for a sign-in/);
});

test('without node:ffi, an MCP sign-in lasts until Caliope closes and says why it was not saved', { skip: (await import('node:ffi').catch(() => null)) ? 'this Node.js has node:ffi' : false }, async (t) => {
  const { base } = await startOAuthServer(t);
  const signInFile = path.join(tempFolder(), 'mcp-auth.json');
  const server = { url: `${base}/mcp`, headers: {} };
  const hub = new McpHub({ log: { info() {}, warn() {}, error() {} }, signInFile, plainSecrets: false });
  t.after(() => hub.closeAll());
  const saveFailed = await hub.signIn({ name: 'oauth', server, openUrl: (url) => fetch(url).catch(() => {}) });
  assert.match(saveFailed, /needs Node\.js 26\.1 or newer/);
  assert.equal(fs.existsSync(signInFile), false, 'nothing is saved');
  assert.deepEqual((await hub.toolsFor({ servers: { oauth: server }, cwd: os.tmpdir(), extraPath })).errors, [], 'the tokens work from memory');
});

