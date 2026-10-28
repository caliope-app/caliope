// A fake GitHub Copilot API for tests and demos. It speaks the same wire formats as the real service:
// /models, streaming /v1/messages (Anthropic), /chat/completions and /responses (OpenAI), the
// allowance endpoint, the device sign-in, and the token exchange.
//
// Scenarios are chosen with a tag in the user's message, for example "[mock:edit notes.txt]".
//   node tools/mock-copilot.js [port]
import http from 'node:http';

const port = Number(process.argv[2] || process.env.MOCK_PORT || 4555);
const requests = [];
const failOnce = new Set();
let spentNano = 0;
let deviceTokenPolls = 0;
let azureCompleted = false;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const claude = (id, name, extra = {}) => ({
  id,
  name,
  vendor: 'Anthropic',
  version: id,
  preview: false,
  model_picker_enabled: true,
  policy: { state: 'enabled' },
  supported_endpoints: ['/v1/messages', '/chat/completions'],
  capabilities: {
    type: 'chat',
    family: id,
    limits: { max_context_window_tokens: 200000, max_prompt_tokens: 200000, max_output_tokens: 64000 },
    supports: { tool_calls: true, parallel_tool_calls: true, streaming: true, vision: true, adaptive_thinking: true, reasoning_effort: EFFORTS },
  },
  ...extra,
});
const MODELS = [
  claude('claude-fable-5.1', 'Claude Fable 5.1'),
  claude('claude-opus-5.5', 'Claude Opus 5.5'),
  claude('claude-haiku-5.5', 'Claude Haiku 5.5'),
  claude('claude-sonnet-5.5', 'Claude Sonnet 5.5', { policy: { state: 'unconfigured' } }),
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    vendor: 'OpenAI',
    model_picker_enabled: true,
    policy: { state: 'enabled' },
    supported_endpoints: ['/chat/completions', '/responses'],
    capabilities: { type: 'chat', family: 'gpt-5-mini', limits: { max_prompt_tokens: 128000, max_output_tokens: 32000 }, supports: { tool_calls: true, streaming: true, vision: true, reasoning_effort: ['low', 'medium', 'high'] } },
  },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', vendor: 'OpenAI', model_picker_enabled: true, supported_endpoints: ['/responses'], capabilities: { type: 'chat', limits: {}, supports: { tool_calls: true } } },
  { id: 'text-embedding-3-small', name: 'Embedding', vendor: 'OpenAI', capabilities: { type: 'embeddings' } },
];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const body = await readBody(request);
  if (!url.pathname.startsWith('/__')) {
    requests.push({ method: request.method, path: url.pathname, headers: pickHeaders(request.headers), body });
    if (requests.length > 500) requests.shift();
  }
  try {
    await route(request, response, url, body);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: { message: error.message } });
    else response.end();
  }
});

async function route(request, response, url, body) {
  const path = url.pathname;
  if (path === '/__requests') return json(response, 200, requests);
  // A fake site login: /__login?user=NAME sets a cookie, and /__whoami shows who is signed in.
  if (path === '/__login') {
    const user = url.searchParams.get('user') || 'someone';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `who=${encodeURIComponent(user)}; Path=/; Max-Age=86400` });
    response.end(`<!doctype html><title>Signed in</title><p>Signed in as ${user.replace(/[<>&]/g, '')}.</p>`);
    return;
  }
  if (path === '/__whoami') {
    const who = /(?:^|;\s*)who=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Who</title><p id="who">${who ? `Signed in as ${decodeURIComponent(who).replace(/[<>&]/g, '')}` : 'Not signed in'}</p>`);
    return;
  }
  // The releases page for the update check.
  if (path === '/__releases/latest/download/manifest.json') return json(response, 200, { version: '9.9.9', files: {} });
  if (path === '/__redirect') {
    response.writeHead(302, { Location: url.searchParams.get('to') || '/__page' });
    response.end();
    return;
  }
  // A button that asks confirm(), and a link that opens a new tab.
  if (path === '/__dialog') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Dialog</title><button onclick="document.getElementById('out').textContent = confirm('Delete everything?') ? 'Deleted' : 'Kept'">Delete</button><p id="out">Waiting</p>`);
    return;
  }
  if (path === '/__popup') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Opener</title><a href="/__page" target="_blank">Open the form</a>`);
    return;
  }
  if (path === '/__page') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Mock form</title><h1>Mock form</h1><p id="out">Nothing submitted yet.</p><input id="name" placeholder="Your name"><button onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value+'!'">Greet</button>`);
    return;
  }
  // GitHub (github.com and api.github.com) endpoints.
  if (path === '/login/device/code' && request.method === 'POST') {
    deviceTokenPolls = 0;
    return json(response, 200, { device_code: 'mock-device-code', user_code: 'MOCK-1234', verification_uri: `http://127.0.0.1:${port}/login/device`, expires_in: 900, interval: 1 });
  }
  if (path === '/login/oauth/access_token' && request.method === 'POST') {
    deviceTokenPolls++;
    if (deviceTokenPolls < 2) return json(response, 200, { error: 'authorization_pending' });
    return json(response, 200, { access_token: 'gho_mockapptoken', token_type: 'bearer', scope: 'read:user' });
  }
  if (path === '/copilot_internal/user') {
    if (!/^token (github_pat_mock|gho_mock)/.test(request.headers.authorization || '')) return json(response, 401, { message: 'Bad credentials' });
    const entitlement = 1900;
    const used = 449.5 + spentNano / 1e9;
    return json(response, 200, {
      login: 'mock-user',
      copilot_plan: 'business',
      access_type_sku: 'copilot_business_seat',
      quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
      quota_snapshots: {
        chat: { unlimited: true, entitlement: 0, remaining: 0 },
        completions: { unlimited: true, entitlement: 0, remaining: 0 },
        premium_interactions: { entitlement, remaining: entitlement - used, quota_remaining: entitlement - used, percent_remaining: ((entitlement - used) / entitlement) * 100, unlimited: false, overage_permitted: false, overage_count: 0, token_based_billing: true, credits_used: used, has_quota: true },
      },
    });
  }
  if (path === '/user') {
    if (!/^Bearer (github_pat_mock|gho_mock)/.test(request.headers.authorization || '')) return json(response, 401, { message: 'Bad credentials' });
    return json(response, 200, { login: 'mock-user', id: 1 });
  }

  // Pull requests. Caliope signs in with git's credential for the remote. The tests' helper gives "mock-token".
  // Merging: GitHub pull request 7 can be merged, 8 waits for a required check. Azure DevOps pull request 12
  // completes in the background after the PATCH.
  const githubRepo = /^\/repos\/([^/]+)\/([^/]+)(\/pulls(?:\/(\d+)(\/merge)?)?|\/git\/refs\/heads\/.+)?$/.exec(path);
  if (githubRepo) {
    if (request.headers.authorization !== 'Bearer mock-token') return json(response, 401, { message: 'Bad credentials' });
    const [, owner, repo, rest, number, merge] = githubRepo;
    const pullUrl = (n) => `https://github.com/${owner}/${repo}/pull/${n}`;
    if (!rest) return json(response, 200, { default_branch: 'main', allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false });
    if (rest.startsWith('/git/refs/heads/') && request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (merge && request.method === 'PUT') return json(response, 200, { merged: true, sha: 'f00dfeed0000', message: 'Pull Request successfully merged' });
    if (number) return json(response, 200, { number: Number(number), title: 'Export invoices as CSV', html_url: pullUrl(number), state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: number === '8' ? 'blocked' : 'clean', head: { ref: 'feature/export', sha: 'abc123def4567890', repo: { full_name: `${owner}/${repo}` } }, base: { ref: 'main' } });
    if (request.method === 'POST') return json(response, 201, { number: 7, html_url: pullUrl(7) });
    if (request.method === 'GET') return json(response, 200, [{ number: 7, title: 'Export invoices as CSV', html_url: pullUrl(7), user: { login: 'octo' }, head: { ref: 'feature/export' }, base: { ref: 'main' }, draft: false, updated_at: new Date().toISOString() }]);
  }
  const azureRepo = /^\/ado\/[^/]+\/[^/]+\/_apis\/(?:git\/repositories\/[^/]+(\/pullrequests(?:\/(\d+))?)?|policy\/evaluations)$/.exec(path);
  if (azureRepo) {
    // Azure DevOps answers a refused token with a 203 and its sign-in page.
    if (request.headers.authorization !== `Basic ${Buffer.from(':mock-token').toString('base64')}`) {
      response.writeHead(203, { 'Content-Type': 'text/html' });
      response.end('<html>Sign in</html>');
      return;
    }
    const [, pullRequests, number] = azureRepo;
    const pull = () => ({ pullRequestId: 12, title: 'Export invoices as CSV', status: azureCompleted ? 'completed' : 'active', isDraft: false, mergeStatus: 'succeeded', sourceRefName: 'refs/heads/feature/export', targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: 'def4567890abc123' }, ...(azureCompleted ? { lastMergeCommit: { commitId: 'c0ffee000000' } } : {}), repository: { project: { id: 'project-guid' } } });
    if (path.endsWith('/policy/evaluations')) return json(response, 200, { value: [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Minimum number of reviewers' } } }, { status: 'running', configuration: { isBlocking: false, isEnabled: true, type: { displayName: 'Build' } } }] });
    if (!pullRequests) return json(response, 200, { defaultBranch: 'refs/heads/main' });
    if (number && request.method === 'PATCH') {
      const answer = pull();
      azureCompleted = true;
      return json(response, 200, answer);
    }
    if (number) return json(response, 200, pull());
    if (request.method === 'POST') return json(response, 201, { pullRequestId: 12 });
    if (request.method === 'GET') return json(response, 200, { value: [pull()] });
  }

  // Copilot API endpoints: a PAT or an app user token directly (the Copilot CLI/SDK way).
  const auth = request.headers.authorization || '';
  if (!/^Bearer (github_pat_mock|gho_mock)/.test(auth)) return json(response, 401, { error: { message: 'unauthorized: token expired or invalid', code: 'unauthorized' } });
  if (request.headers['copilot-integration-id'] !== 'copilot-developer-cli') return json(response, 400, { error: { message: 'missing integration id', code: 'bad_request' } });
  if (auth.startsWith('Bearer github_pat_mock_noaccess')) return json(response, 403, { error: { message: 'Copilot CLI access is disabled by your organization policy', code: 'policy_disabled' } });
  if (path === '/models' && request.method === 'GET') return json(response, 200, { object: 'list', data: MODELS });
  const policy = /^\/models\/([^/]+)\/policy$/.exec(path);
  if (policy && request.method === 'POST') {
    const model = MODELS.find((item) => item.id === decodeURIComponent(policy[1]));
    if (model) model.policy = { state: 'enabled' };
    return json(response, 200, { state: 'enabled' });
  }
  if (path === '/v1/messages' && request.method === 'POST') return anthropic(response, body, request.headers);
  if (path === '/chat/completions' && request.method === 'POST') return openai(response, body);
  if (path === '/responses' && request.method === 'POST') return responses(response, body);
  return json(response, 404, { error: { message: `No mock for ${request.method} ${path}` } });
}

// ---------- Scenario logic shared by all three formats ----------

function systemText(body) {
  if (typeof body.instructions === 'string') return body.instructions;
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) return body.system.map((block) => block.text).join('\n');
  const systemMessage = (body.messages || []).find((message) => message.role === 'system');
  return systemMessage ? String(systemMessage.content) : '';
}

/** Normalize any of the three formats to { role, texts[], toolResults[] } entries. */
function normalizedMessages(body) {
  if (Array.isArray(body.input)) return normalizedResponsesInput(body.input);
  const list = [];
  for (const message of body.messages || []) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      list.push({ role: 'user', texts: [], toolResults: [String(message.content)] });
      continue;
    }
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
    const texts = content.filter((block) => block.type === 'text').map((block) => block.text);
    const toolResults = content
      .filter((block) => block.type === 'tool_result')
      .map((block) => (typeof block.content === 'string' ? block.content : (block.content || []).map((part) => part.text || '').join('\n')));
    list.push({ role: message.role, texts, toolResults, hasToolCalls: Boolean(message.tool_calls) || content.some((block) => block.type === 'tool_use') });
  }
  return list;
}

/** Responses input items, with one assistant turn's reasoning, text and calls merged into one entry. */
function normalizedResponsesInput(input) {
  const list = [];
  for (const item of input) {
    const assistant = item.role === 'assistant' || item.type === 'reasoning' || item.type === 'function_call' || item.type === 'compaction';
    const role = assistant ? 'assistant' : 'user';
    let entry = list[list.length - 1];
    if (entry?.role !== role) {
      entry = { role, texts: [], toolResults: [], hasToolCalls: false, reasoning: [] };
      list.push(entry);
    }
    if (item.type === 'function_call') entry.hasToolCalls = true;
    else if (item.type === 'function_call_output') entry.toolResults.push(String(item.output));
    else if (item.type === 'reasoning') entry.reasoning.push(item.encrypted_content);
    else if (typeof item.content === 'string') entry.texts.push(item.content);
    else for (const part of item.content || []) if (part.type === 'input_text' || part.type === 'output_text') entry.texts.push(part.text);
  }
  return list;
}

/**
 * Work out the scenario and which step of it this request is.
 * - The scenario comes from the most recent user text with a [mock:...] tag.
 * - The step is the number of assistant messages after that text.
 */
function scenarioFor(body) {
  const messages = normalizedMessages(body);
  let tagIndex = -1;
  let tag = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    // A tool's JSON input may hold lists ([...]), so it runs to the last "}]".
    const match = message.texts.map((text) => /\[mock:(tool \S+ \{.*\})\]/.exec(text) || /\[mock:([^\]]+)\]/.exec(text)).find(Boolean);
    if (match) {
      tagIndex = i;
      tag = match[1].trim();
      break;
    }
  }
  const step = tagIndex === -1 ? 0 : messages.slice(tagIndex + 1).filter((message) => message.role === 'assistant').length;
  const lastResult = [...messages].reverse().find((message) => message.toolResults.length)?.toolResults.slice(-1)[0] || '';
  const [name, ...args] = (tag || 'default').split(/\s+/);
  return { name, args, step, lastResult, messages };
}

let toolCounter = 0;
const toolId = () => `toolu_mock_${Date.now().toString(36)}_${toolCounter++}`;

/** Returns { thinking, text, tools: [{name, input}], stop, usage, delayMs, chunks, failure } for a request. */
function plan(body) {
  const system = systemText(body);
  if (/short, specific titles/.test(system)) return { text: 'Mock session title' };
  const lastUser = normalizedMessages(body).filter((message) => message.role === 'user').at(-1);
  if (/handoff summaries/.test(system) || /write a handoff summary of this conversation/.test(lastUser?.texts.join('\n') || '')) {
    // "[slow compaction]" in the compaction instructions makes the summary take about 4 seconds.
    const slow = /\[slow compaction\]/.test(JSON.stringify(body.messages));
    return { text: '1. User requests: test the app.\n2. Decisions: none.\n3. Work done: edited files.\n4. Current state: working.\n5. Next steps: continue.\n6. Key details: none.', ...(slow ? { chunks: 40, delayMs: 100 } : {}) };
  }
  if (/may run without asking the user first/.test(system)) {
    // Auto-mode safety check: allow harmless commands, ask about deletes and anything unknown.
    const promptText = normalizedMessages(body)[0]?.texts.join('\n') || '';
    const command = (/<command>\n([\s\S]*?)\n<\/command>/.exec(promptText) || [])[1] || '';
    const safe = /^(Get-Content|Get-ChildItem|git (status|diff|log)|echo|Write-Output|dir)\b/i.test(command.trim());
    return { text: JSON.stringify(safe ? { decision: 'allow', reason: 'Reads information only.' } : { decision: 'ask', reason: 'This command deletes or changes things outside a simple read.' }) };
  }
  const { name, args, step, lastResult, messages } = scenarioFor(body);
  const key = JSON.stringify(body.messages?.slice(0, 1)) + name;
  switch (name) {
    case 'edit': {
      const file = args[0] || 'notes.txt';
      if (step === 0) return { thinking: 'The user wants an edit. Read the file first.', text: `I'll read ${file} first.`, tools: [{ name: 'read_file', input: { path: file } }] };
      if (step === 1) {
        const firstLine = (/^\s*1\t(.*)$/m.exec(lastResult) || [])[1] ?? '';
        return { text: 'Now I will change the first line.', tools: [{ name: 'edit_file', input: { path: file, old_string: firstLine, new_string: `${firstLine} (edited by the agent)` } }] };
      }
      if (step === 2) return { tools: [{ name: 'run_command', input: { command: `Get-Content -LiteralPath '${file}'`, description: 'Show the edited file' } }] };
      return { text: `Done. I changed the first line of \`${file}\` and checked the result.` };
    }
    case 'plan': {
      if (step === 0 || (step >= 1 && /did not approve/.test(lastResult) && step < 3)) {
        return {
          thinking: 'Plan the work before changing anything.',
          text: step === 0 ? 'I explored the project. Here is my plan.' : 'I revised the plan.',
          tools: [{ name: 'present_plan', input: { plan: `## Goal\nAdd a greeting.\n\n## Steps\n1. Create \`greeting.txt\`.\n2. Verify it exists.\n\n## Verification\nRead the file back.${step > 0 ? '\n\n(Revised after your feedback.)' : ''}` } }],
        };
      }
      return { text: 'The plan is approved. Implementation is complete (mock).' };
    }
    case 'ask':
      if (step === 0) return { tools: [{ name: 'ask_user', input: { question: 'Which color should the button be?', options: ['Red', 'Blue'] } }] };
      return { text: `Great, I'll use: ${lastResult.replace('The user answered: ', '')}.` };
    case 'todo':
      if (step === 0) return { text: 'Planning the steps.', tools: [{ name: 'todo_write', input: { todos: [{ content: 'Read code', status: 'in_progress' }, { content: 'Change code', status: 'pending' }, { content: 'Run tests', status: 'pending' }] } }] };
      if (step === 1) return { tools: [{ name: 'todo_write', input: { todos: [{ content: 'Read code', status: 'completed' }, { content: 'Change code', status: 'completed' }, { content: 'Run tests', status: 'completed' }] } }] };
      return { text: 'All three steps are done.' };
    case 'multi':
      if (step === 0) return { tools: [{ name: 'list_dir', input: {} }, { name: 'glob', input: { pattern: '*.txt' } }, { name: 'grep', input: { pattern: 'Hello', output_mode: 'content' } }] };
      return { text: 'I looked around the project with three tools at once.' };
    case 'cmd':
      if (step === 0) return { tools: [{ name: 'run_command', input: { command: args.join(' ') || 'git status', description: 'Run a command' } }] };
      return { text: 'The command finished.' };
    case 'tool':
      // Any tool with a JSON input: [mock:tool mcp__mock__echo {"text":"hi"}]. Lists the tools it was given.
      if (step === 0) return { tools: [{ name: args[0], input: JSON.parse(args.slice(1).join(' ') || '{}') }] };
      return { text: `Result: ${lastResult}\nTools: ${(body.tools || []).map((tool) => tool.name || tool.function?.name).join(', ')}` };
    case 'agents':
      // Two subagents at once on different models. Their own prompts pick their scenarios.
      if (step === 0) {
        return {
          tools: [
            { name: 'run_agent', input: { description: 'Read the notes', prompt: 'Report the first line of notes.txt. [mock:read notes.txt]', model: 'haiku' } },
            { name: 'run_agent', input: { description: 'Survey the files', prompt: 'Look around the project. [mock:multi]', model: 'gpt mini' } },
          ],
        };
      }
      return { text: 'Both subagents reported back.' };
    case 'agentedit':
      // A subagent that wants to change a file (its edit needs approval in Ask mode).
      if (step === 0) return { tools: [{ name: 'run_agent', input: { description: 'Edit the notes', prompt: `Edit notes.txt. [mock:edit ${args[0] || 'notes.txt'}]`, tools: 'write' } }] };
      return { text: 'The subagent finished its edit.' };
    case 'bg':
      // A dev server that keeps running.
      if (step === 0) return { tools: [{ name: 'run_command', input: { command: "Write-Output 'listening on 5173'; Start-Sleep -Seconds 120", description: 'Start the dev server', background: true } }] };
      return { text: `Server started: ${lastResult.slice(0, 200)}` };
    case 'deny':
      if (step === 0) return { tools: [{ name: 'run_command', input: { command: 'Remove-Item important.txt', description: 'Delete a file' } }, { name: 'list_dir', input: {} }] };
      return { text: 'Understood, I will not delete it.' };
    case 'browse':
      if (step === 0) return { text: 'Opening the page.', tools: [{ name: 'browser', input: { action: 'navigate', url: `http://127.0.0.1:${port}/__page` } }] };
      if (step === 1) return { tools: [{ name: 'browser', input: { action: 'type', ref: 1, text: 'Ada' } }] };
      if (step === 2) return { tools: [{ name: 'browser', input: { action: 'click', ref: 2 } }] };
      if (step === 3) return { tools: [{ name: 'browser', input: { action: 'read' } }] };
      if (step === 4) return { tools: [{ name: 'browser', input: { action: 'screenshot' } }] };
      return { text: `The page now says: ${(/Hello, [^!]*!/.exec(messages.flatMap((message) => message.toolResults).join('\n')) || ['(not found)'])[0]}` };
    case 'clickfirst':
      // Open a mock page, click its first element, then read the page.
      if (step === 0) return { tools: [{ name: 'browser', input: { action: 'navigate', url: `http://127.0.0.1:${port}${args[0]}` } }] };
      if (step === 1) return { tools: [{ name: 'browser', input: { action: 'click', ref: 1 } }] };
      if (step === 2) return { tools: [{ name: 'browser', input: { action: 'read' } }] };
      return { text: messages.flatMap((message) => message.toolResults).slice(-2).join('\n----\n') };
    case 'visit':
      // Open a page of this mock server (for example /__whoami) and report its text.
      if (step === 0) return { tools: [{ name: 'browser', input: { action: 'navigate', url: `http://127.0.0.1:${port}${args[0] || '/__page'}` } }] };
      return { text: `Page text: ${(/Text:\n([^\n]*)/.exec(lastResult) || [])[1] || '(none)'}` };
    case 'grepin':
      if (step === 0) return { tools: [{ name: 'grep', input: { path: args[0], pattern: args[1], output_mode: 'files' } }] };
      return { text: `Found:\n${lastResult}` };
    case 'read':
      if (step === 0) return { tools: [{ name: 'read_file', input: { path: args.join(' ') } }] };
      return { text: `Result: ${lastResult.slice(0, 300)}` };
    case 'skill':
      if (step === 0) return { tools: [{ name: 'use_skill', input: { name: args[0] || 'greeter' } }] };
      return { text: `I followed the skill: ${lastResult.split('\n').find((line) => /^Always/.test(line)) || '(no rule found)'}` };
    case 'echo-context':
      return { text: `Context check. System has project instructions: ${/<project_instructions>/.test(system)}.` };
    case 'slow':
      return { text: Array.from({ length: 60 }, (_, i) => `Word${i} `).join(''), chunks: 60, delayMs: 120 };
    case 'long':
      return { text: 'This reply reports a large prompt so the next turn compacts first.', usage: { input: 190000 } };
    case 'refusal':
      return { text: '', stop: 'refusal' };
    case '429':
      if (!failOnce.has(key + step)) {
        failOnce.add(key + step);
        return { failure: { status: 429, retryAfter: 1, body: { error: { message: 'Rate limit exceeded', code: 'rate_limited' } } } };
      }
      return { text: 'Answered after a rate limit.' };
    case 'cut':
      if (!failOnce.has(key + step)) {
        failOnce.add(key + step);
        return { text: 'This stream will be cut', cut: true };
      }
      return { text: 'Answered after the stream was cut and retried.' };
    case 'badsig': {
      // Refuses any replayed thinking block, like a history the API no longer accepts.
      if (step === 0) return { thinking: 'Look around first.', text: 'Listing the folder.', tools: [{ name: 'list_dir', input: { path: '.' } }] };
      const replaysThinking = (body.messages || []).some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'thinking'));
      if (replaysThinking) return { failure: { status: 400, body: { error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.', code: 'invalid_request_body' } } } };
      return { text: 'Continued without the refused thinking.' };
    }
    case 'nativecompact': {
      // The model compacts the conversation itself when the request asks for it (Claude and Responses).
      const asked = Boolean(body.context_management);
      return asked ? { compaction: `Summary: the user asked for native compaction (${body.model}).`, text: 'Compacted and answered.' } : { text: 'No compaction was requested.' };
    }
    case 'nodisplay':
      if (body.thinking?.display) return { failure: { status: 400, body: { error: { message: 'thinking.display: Extra inputs are not permitted', code: 'invalid_request_body' } } } };
      return { text: 'Answered without thinking.display.' };
    default:
      return {
        thinking: 'The user said something; answer with a little Markdown.',
        text: `Hello from the **mock** model (${body.model}).\n\n- Effort: \`${body.output_config?.effort || body.reasoning_effort || 'default'}\`\n- Messages: ${body.messages?.length}\n\n\`\`\`js\nconst greeting = 'hello';\nconsole.log(greeting);\n\`\`\`\n\n| Column | Value |\n|---|---|\n| a | 1 |\n\n<script>alert('xss')</script>`,
      };
  }
}

function costFor(input, output) {
  return input * 400000 + output * 2000000;
}

// ---------- Anthropic /v1/messages ----------

async function anthropic(response, body, headers = {}) {
  const carriesBlock = (body.messages || []).some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'compaction'));
  if ((body.context_management || carriesBlock) && !String(headers['anthropic-beta'] || '').includes('compact-2026-01-12')) {
    return json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'context_management: this parameter requires anthropic-beta: compact-2026-01-12' } });
  }
  const script = plan(body);
  if (script.failure) {
    const headers = { 'Content-Type': 'application/json' };
    if (script.failure.retryAfter) headers['retry-after'] = String(script.failure.retryAfter);
    response.writeHead(script.failure.status, headers);
    response.end(JSON.stringify(script.failure.body));
    return;
  }
  const inputTokens = script.usage?.input ?? Math.round(JSON.stringify(body.messages).length / 4) + 1200;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: `msg_mock_${Date.now()}`, type: 'message', role: 'assistant', model: body.model.replace(/\./g, '-'), content: [], usage: { input_tokens: Math.round(inputTokens * 0.3), cache_read_input_tokens: Math.round(inputTokens * 0.7), output_tokens: 1 } } });
  let index = 0;
  let outputTokens = 0;
  if (script.compaction) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'compaction', content: null } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'compaction_delta', content: script.compaction } });
    send('content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  if (script.thinking) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    const visible = body.thinking?.display === 'summarized' ? script.thinking : '';
    if (visible) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: visible } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `sig_${body.model}_${index}` } });
    send('content_block_stop', { type: 'content_block_stop', index });
    outputTokens += 40;
    index++;
  }
  if (script.text) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    const chunks = splitText(script.text, script.chunks || 6);
    for (const chunk of chunks) {
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
      if (script.delayMs) await sleep(script.delayMs);
      else await sleep(15);
      if (response.destroyed) return;
    }
    if (script.cut) {
      response.destroy();
      return;
    }
    send('content_block_stop', { type: 'content_block_stop', index });
    outputTokens += Math.round(script.text.length / 4);
    index++;
  }
  for (const tool of script.tools || []) {
    const json = JSON.stringify(tool.input);
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId(), name: tool.name, input: {} } });
    for (const piece of splitText(json, 3)) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
    send('content_block_stop', { type: 'content_block_stop', index });
    outputTokens += Math.round(json.length / 4) + 10;
    index++;
  }
  const nano = costFor(inputTokens, outputTokens);
  spentNano += nano;
  const stop = script.stop || (script.tools?.length ? 'tool_use' : 'end_turn');
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber' } } : {}) }, usage: { output_tokens: outputTokens }, copilot_usage: { total_nano_aiu: nano, token_details: [] } });
  send('message_stop', { type: 'message_stop' });
  // Copilot ends its Anthropic streams with a non-standard terminator.
  response.write('event: message\ndata: [DONE]\n\n');
  response.end();
}

// ---------- OpenAI /chat/completions ----------

async function openai(response, body) {
  const script = plan(body);
  if (script.failure) {
    response.writeHead(script.failure.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(script.failure.body));
    return;
  }
  const id = `chatcmpl-mock-${Date.now()}`;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
  if (script.text) {
    for (const chunk of splitText(script.text, 6)) {
      send({ ...base, choices: [{ index: 0, delta: { content: chunk } }] });
      await sleep(10);
    }
  }
  (script.tools || []).forEach((tool, position) => {
    const callId = `call_mock_${position}_${Date.now()}`;
    const json = JSON.stringify(tool.input);
    const [first, ...rest] = splitText(json, 2);
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: position, id: callId, type: 'function', function: { name: tool.name, arguments: first } }] } }] });
    for (const piece of rest) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: position, function: { arguments: piece } }] } }] });
  });
  const inputTokens = Math.round(JSON.stringify(body.messages).length / 4) + 800;
  const outputTokens = Math.round((script.text || '').length / 4) + 20;
  const nano = costFor(inputTokens, outputTokens) / 4;
  spentNano += nano;
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: script.tools?.length ? 'tool_calls' : 'stop' }] });
  send({ ...base, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, prompt_tokens_details: { cached_tokens: 0 } }, copilot_usage: { total_nano_aiu: nano } });
  response.write('data: [DONE]\n\n');
  response.end();
}

// ---------- OpenAI /responses ----------

async function responses(response, body) {
  const script = plan(body);
  if (script.failure) {
    response.writeHead(script.failure.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(script.failure.body));
    return;
  }
  // The stateless mode Caliope uses: encrypted reasoning must be asked for and replayed whole.
  if (body.store !== false) return json(response, 400, { error: { message: 'store must be false for this mock', code: 'invalid_request_body' } });
  const replayed = normalizedResponsesInput(body.input).flatMap((entry) => entry.reasoning || []);
  if (replayed.some((encrypted) => !String(encrypted).startsWith(`enc_${body.model}_`))) return json(response, 400, { error: { message: 'The encrypted content could not be decrypted.', code: 'invalid_encrypted_content' } });
  const compactions = body.input.filter((item) => item.type === 'compaction');
  if (compactions.some((item) => !String(item.encrypted_content).startsWith(`cmp_${body.model}_`))) return json(response, 400, { error: { message: 'The compaction item could not be decrypted.', code: 'invalid_encrypted_content' } });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (data) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  const responseId = `resp_mock_${Date.now()}`;
  send({ type: 'response.created', response: { id: responseId, model: body.model, status: 'in_progress' } });
  let outputIndex = 0;
  if (script.compaction) {
    const item = { id: `cmp_item_${outputIndex}`, type: 'compaction' };
    send({ type: 'response.output_item.added', output_index: outputIndex, item });
    send({ type: 'response.output_item.done', output_index: outputIndex, item: { ...item, encrypted_content: `cmp_${body.model}_${outputIndex}` } });
    outputIndex++;
  }
  if (script.thinking && body.include?.includes('reasoning.encrypted_content')) {
    const item = { id: `rs_${outputIndex}`, type: 'reasoning', summary: [] };
    send({ type: 'response.output_item.added', output_index: outputIndex, item });
    send({ type: 'response.reasoning_summary_part.added', output_index: outputIndex, item_id: item.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
    send({ type: 'response.reasoning_summary_text.delta', output_index: outputIndex, item_id: item.id, summary_index: 0, delta: script.thinking });
    send({ type: 'response.output_item.done', output_index: outputIndex, item: { ...item, summary: [{ type: 'summary_text', text: script.thinking }], encrypted_content: `enc_${body.model}_${outputIndex}` } });
    outputIndex++;
  }
  if (script.text) {
    const item = { id: `msg_${outputIndex}`, type: 'message', role: 'assistant', content: [] };
    send({ type: 'response.output_item.added', output_index: outputIndex, item });
    for (const chunk of splitText(script.text, 6)) {
      send({ type: 'response.output_text.delta', output_index: outputIndex, item_id: item.id, content_index: 0, delta: chunk });
      await sleep(10);
    }
    send({ type: 'response.output_item.done', output_index: outputIndex, item: { ...item, content: [{ type: 'output_text', text: script.text }] } });
    outputIndex++;
  }
  for (const tool of script.tools || []) {
    const json = JSON.stringify(tool.input);
    const item = { id: `fc_${outputIndex}`, type: 'function_call', call_id: `call_mock_${outputIndex}_${Date.now()}`, name: tool.name, arguments: '' };
    send({ type: 'response.output_item.added', output_index: outputIndex, item });
    for (const piece of splitText(json, 2)) send({ type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: piece });
    send({ type: 'response.output_item.done', output_index: outputIndex, item: { ...item, arguments: json } });
    outputIndex++;
  }
  const inputTokens = Math.round(JSON.stringify(body.input).length / 4) + 800;
  const outputTokens = Math.round((script.text || '').length / 4) + 20;
  const nano = costFor(inputTokens, outputTokens) / 8;
  spentNano += nano;
  const usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: Math.round(inputTokens / 2) }, output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 10 } };
  send({ type: 'response.completed', response: { id: responseId, model: body.model, status: 'completed', usage }, copilot_usage: { total_nano_aiu: nano } });
  response.end();
}

// ---------- Helpers ----------

function splitText(text, parts) {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(text)));
      }
    });
  });
}

function pickHeaders(headers) {
  const keep = ['authorization', 'copilot-integration-id', 'x-github-api-version', 'x-initiator', 'openai-intent', 'anthropic-version', 'anthropic-beta', 'copilot-vision-request', 'user-agent', 'editor-version', 'content-type', 'accept'];
  const picked = Object.fromEntries(keep.filter((key) => headers[key] !== undefined).map((key) => [key, headers[key]]));
  if (picked.authorization) picked.authorization = picked.authorization.replace(/(Bearer|token) (\S{0,14})\S*/, '$1 $2…');
  return picked;
}

server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK READY ${port}`);
});
