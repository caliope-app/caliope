import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileTool, editFileTool, writeFileTool, notebookEditTool, grepTool, globTool, listDirTool, ToolInputError } from '../server/tools/fs-tools.js';
import { runCommandTool, commandOutputTool, commandAllowed, splitCommandParts, suggestPrefix, psQuote } from '../server/tools/shell.js';
import { pathKey } from '../server/tools/paths.js';
import { validateToolInput, getTool, toolNamesForNewSession } from '../server/tools/index.js';
import { htmlToText, webFetchTool, webSearchTool, parseSearchResults } from '../server/tools/web.js';
import { hostApproved } from '../server/permissions.js';
import { protectedPattern, DEFAULT_PROTECTED_FILES } from '../server/protected-files.js';
import { validateHooks } from '../server/hooks.js';
import { validateMcpServers, mcpServersFor, McpHub } from '../server/mcp.js';

function makeContext(cwd) {
  const checkpoints = [];
  const ctx = {
    cwd,
    settings: { commandTimeoutSec: 30, shell: 'powershell' },
    extraPath: [],
    tmpDir: path.join(cwd, '.tmp'),
    signal: undefined,
    readFiles: {},
    recordRead: (absolutePath, stat) => {
      ctx.readFiles[pathKey(absolutePath)] = { mtimeMs: stat.mtimeMs, size: stat.size };
    },
    checkpoint: async (absolutePath, before, after) => checkpoints.push({ absolutePath, before, after }),
    emitOutput: () => {},
    checkpoints,
    exited: 0,
  };
  const jobs = new Map();
  ctx.jobs = { add: (job) => jobs.set(job.id, job), get: (id) => jobs.get(id), onExit: () => ctx.exited++ };
  return ctx;
}

function tempProject() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-test-'));
  return folder;
}

test('read_file numbers lines, pages long files and refuses folders', async () => {
  const cwd = tempProject();
  fs.writeFileSync(path.join(cwd, 'a.txt'), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n'));
  const ctx = makeContext(cwd);
  const first = await readFileTool.run({ path: 'a.txt' }, ctx);
  assert.match(first.content, /^1\tline 1$/m);
  assert.match(first.content, /Showing lines 1-2000 of 2500/);
  const second = await readFileTool.run({ path: 'a.txt', offset: 2400, limit: 5 }, ctx);
  assert.match(second.content, /2404\tline 2404/);
  await assert.rejects(readFileTool.run({ path: '.' }, ctx), ToolInputError);
  await assert.rejects(readFileTool.run({ path: 'missing.txt' }, ctx), /does not exist/);
});

test('edit_file requires a prior read, keeps CRLF and BOM, and checks uniqueness', async () => {
  const cwd = tempProject();
  const file = path.join(cwd, 'b.cs');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('class A\r\n{\r\n    int x = 1;\r\n    int y = 1;\r\n}\r\n')]));
  const ctx = makeContext(cwd);
  await assert.rejects(editFileTool.run({ path: 'b.cs', old_string: 'int x = 1;', new_string: 'int x = 2;' }, ctx), /Read b\.cs with read_file/);
  await readFileTool.run({ path: 'b.cs' }, ctx);
  await assert.rejects(editFileTool.run({ path: 'b.cs', old_string: '= 1;', new_string: '= 2;' }, ctx), /occurs 2 times/);
  const result = await editFileTool.run({ path: 'b.cs', old_string: '{\n    int x = 1;', new_string: '{\n    int x = 2;\n    int z = 3;' }, ctx);
  assert.match(result.content, /1 replacement/);
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString('utf8'), 'class A\r\n{\r\n    int x = 2;\r\n    int z = 3;\r\n    int y = 1;\r\n}\r\n');
  assert.equal(ctx.checkpoints.length, 1);
  assert.equal(result.meta.added, 2);
  assert.equal(result.meta.removed, 1);
  // A second edit right after works without another read.
  await editFileTool.run({ path: 'b.cs', old_string: 'int y = 1;', new_string: 'int y = 9;', replace_all: false }, ctx);
  assert.match(fs.readFileSync(file, 'utf8'), /int y = 9;/);
});

test('edit_file and write_file refuse a file changed on disk since it was read', async () => {
  const cwd = tempProject();
  const file = path.join(cwd, 'c.txt');
  fs.writeFileSync(file, 'one\n');
  const ctx = makeContext(cwd);
  await readFileTool.run({ path: 'c.txt' }, ctx);
  fs.writeFileSync(file, 'one changed elsewhere\n');
  await assert.rejects(editFileTool.run({ path: 'c.txt', old_string: 'one', new_string: 'two' }, ctx), /changed on disk/);
  await assert.rejects(writeFileTool.run({ path: 'c.txt', content: 'x' }, ctx), /changed on disk/);
});

test('write_file creates folders and files, keeps CRLF of existing files, and handles UTF-16 and Latin-1', async () => {
  const cwd = tempProject();
  const ctx = makeContext(cwd);
  const created = await writeFileTool.run({ path: 'new/dir/d.txt', content: 'hello\nworld\n' }, ctx);
  assert.match(created.content, /Created/);
  assert.equal(fs.readFileSync(path.join(cwd, 'new/dir/d.txt'), 'utf8'), 'hello\nworld\n');
  fs.writeFileSync(path.join(cwd, 'w.txt'), 'a\r\nb\r\n');
  await readFileTool.run({ path: 'w.txt' }, ctx);
  await writeFileTool.run({ path: 'w.txt', content: 'x\ny\n' }, ctx);
  assert.equal(fs.readFileSync(path.join(cwd, 'w.txt'), 'utf8'), 'x\r\ny\r\n');
  fs.writeFileSync(path.join(cwd, 'u16.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Write-Host "hi"\r\n', 'utf16le')]));
  const read = await readFileTool.run({ path: 'u16.ps1' }, ctx);
  assert.match(read.content, /Write-Host "hi"/);
  await editFileTool.run({ path: 'u16.ps1', old_string: '"hi"', new_string: '"hé"' }, ctx);
  const u16 = fs.readFileSync(path.join(cwd, 'u16.ps1'));
  assert.deepEqual([...u16.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(u16.subarray(2).toString('utf16le'), 'Write-Host "hé"\r\n');
  fs.writeFileSync(path.join(cwd, 'l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await readFileTool.run({ path: 'l1.txt' }, ctx);
  await editFileTool.run({ path: 'l1.txt', old_string: 'café', new_string: 'cafés' }, ctx);
  assert.deepEqual([...fs.readFileSync(path.join(cwd, 'l1.txt'))], [0x63, 0x61, 0x66, 0xe9, 0x73, 0x0a]);
});

test('grep, glob and list_dir', async () => {
  const cwd = tempProject();
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.mkdirSync(path.join(cwd, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'const alpha = 1;\nconst beta = 2;\n');
  fs.writeFileSync(path.join(cwd, 'src', 'b.py'), 'alpha = 3\n');
  fs.writeFileSync(path.join(cwd, 'node_modules', 'x', 'skip.js'), 'alpha');
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 97, 108, 112, 104, 97]));
  const ctx = makeContext(cwd);
  const content = await grepTool.run({ pattern: 'alpha' }, ctx);
  assert.equal(content.meta.matches, 2);
  assert.match(content.content, /src[\\/]a\.js:1:const alpha = 1;/);
  const filtered = await grepTool.run({ pattern: 'ALPHA', ignore_case: true, glob: '*.py', output_mode: 'files' }, ctx);
  assert.equal(filtered.content.trim(), path.join('src', 'b.py'));
  // Patterns and options the way ripgrep and Claude Code write them.
  const ripgrepStyle = await grepTool.run({ pattern: '(?i)ALPHA|gamma', glob: '*.py', output_mode: 'files_with_matches' }, ctx);
  assert.equal(ripgrepStyle.content.trim(), path.join('src', 'b.py'));
  assert.equal((await grepTool.run({ pattern: 'BETA', '-i': true }, ctx)).meta.matches, 1);
  await assert.rejects(grepTool.run({ pattern: '(' }, ctx), /Invalid regular expression/);
  fs.writeFileSync(path.join(cwd, 'src', 'slow.txt'), `${'a'.repeat(40)}b\n`);
  await assert.rejects(grepTool.run({ pattern: '(a+)+$', path: 'src/slow.txt' }, ctx), /took more than 3 seconds/);
  ctx.isHidden = (absolutePath) => absolutePath.endsWith('b.py');
  const hidden = await grepTool.run({ pattern: 'alpha', output_mode: 'files' }, ctx);
  assert.doesNotMatch(hidden.content, /b\.py/);
  const globbed = await globTool.run({ pattern: '**/*.js' }, ctx);
  assert.equal(globbed.meta.count, 1);
  const listing = await listDirTool.run({ path: 'src' }, ctx);
  assert.match(listing.content, /a\.js/);
});

test('run_command returns output and the native exit code; times out', async () => {
  const cwd = tempProject();
  const ctx = makeContext(cwd);
  const ok = await runCommandTool.run({ command: "Write-Output 'héllo ✓'; Write-Error 'bad thing'" }, ctx);
  assert.match(ok.content, /héllo ✓/);
  assert.match(ok.content, /bad thing/);
  assert.doesNotMatch(ok.content, /CLIXML/);
  const failed = await runCommandTool.run({ command: 'cmd /c exit 3' }, ctx);
  assert.equal(failed.meta.exitCode, 3);
  assert.ok(failed.isError);
  const slow = await runCommandTool.run({ command: 'Start-Sleep -Seconds 20', timeout_sec: 2 }, ctx);
  assert.ok(slow.meta.timedOut);
  assert.match(slow.content, /Timed out after 2 s/);
});

test('a background command keeps running; command_output reads new output and stops it', async () => {
  const cwd = tempProject();
  const ctx = makeContext(cwd);
  const started = await runCommandTool.run({ command: "Write-Output 'server ready'; Start-Sleep -Seconds 5; Write-Output 'request 1'; Start-Sleep -Seconds 60", background: true }, ctx);
  assert.equal(started.meta.running, true);
  assert.match(started.content, /Running in the background as job job\w+/);
  assert.match(started.content, /server ready/);
  assert.doesNotMatch(started.content, /request 1/);
  const later = await commandOutputTool.run({ job: started.meta.job, wait_sec: 6 }, ctx);
  assert.match(later.content, /request 1/);
  assert.doesNotMatch(later.content, /server ready/, 'only output the agent has not seen');
  const stopped = await commandOutputTool.run({ job: started.meta.job, stop: true }, ctx);
  assert.equal(stopped.meta.running, false);
  assert.match(stopped.content, /ended with exit code/);
  assert.equal(ctx.exited, 1, 'the session hears when a job ends');
  await assert.rejects(commandOutputTool.run({ job: 'job-unknown' }, ctx), /no background job/);
  const quick = await runCommandTool.run({ command: 'cmd /c exit 4', background: true }, ctx);
  assert.equal(quick.meta.running, false);
  assert.equal(quick.meta.exitCode, 4);
  assert.ok(quick.isError);
});

test('command allow rules check every part of a command', () => {
  assert.ok(commandAllowed('git status', ['git status']));
  assert.ok(commandAllowed('git status; git diff', ['git status', 'git diff']));
  assert.ok(!commandAllowed('git status; Remove-Item x', ['git status']));
  assert.ok(!commandAllowed('git status > out.txt', ['git status']));
  assert.ok(!commandAllowed('git status $(Remove-Item x)', ['git status']));
  assert.ok(!commandAllowed('git status (Remove-Item -Recurse -Force C:\\x)', ['git status']), 'PowerShell runs a parenthesized argument');
  assert.ok(!commandAllowed('git statusx', ['git status']));
  // PowerShell ends a statement at a lone carriage return too.
  assert.ok(!commandAllowed('git status \rRemove-Item -Recurse C:\\x', ['git status']));
  assert.ok(!commandAllowed(`git status${String.fromCharCode(0x2028)}Remove-Item x`, ['git status']));
  assert.ok(commandAllowed('git status\r\ngit diff', ['git status', 'git diff']));
  assert.deepEqual(splitCommandParts('a | b && c'), ['a', 'b', 'c']);
  assert.equal(splitCommandParts('if ($x) { Remove-Item y }'), null);
  assert.equal(suggestPrefix('git log --oneline -5'), 'git log');
  assert.equal(suggestPrefix('dir /s'), 'dir');
  // An interpreter's rule names what it runs. "python" alone would allow any code.
  assert.equal(suggestPrefix('python -m pytest -q'), 'python -m pytest');
  assert.equal(suggestPrefix('node --test'), 'node --test');
  assert.equal(suggestPrefix('npx -y create-vite app'), 'npx -y create-vite');
  assert.equal(suggestPrefix('cmd /c dir'), 'cmd /c dir');
  assert.equal(suggestPrefix('git -C sub status'), 'git -C sub status');
  assert.ok(commandAllowed('git log -5', ['git log']));
  assert.ok(commandAllowed('git -C sub status', [suggestPrefix('git -C sub status')]), 'the suggested rule for -C (a folder) works');
});

test('websites are approved per site: scheme, host and port', () => {
  assert.equal(webFetchTool.targetHost({ url: 'HTTPS://Docs.Example.com/a?b=1' }), 'https://docs.example.com');
  assert.equal(webFetchTool.targetHost({ url: 'about:blank' }), null);
  const session = (mode, allowedHosts = []) => ({ meta: { mode }, data: { allowedHosts } });
  const approved = session('edits', [webFetchTool.targetHost({ url: 'http://localhost:3000/login' })]);
  assert.equal(hostApproved(approved, 'http://localhost:3000'), true);
  assert.equal(hostApproved(approved, 'http://localhost:8080'), false, 'another local service on another port asks again');
  assert.equal(hostApproved(session('auto'), 'http://localhost:8080'), true, 'auto mode opens pages on this PC');
  assert.equal(hostApproved(session('auto'), 'https://example.com'), true, 'and shows any page: looking is reading');
  assert.equal(hostApproved(session('ask'), 'https://example.com'), false);
  assert.equal(hostApproved(session('edits'), 'https://teams.cloud.microsoft', ['https://teams.cloud.microsoft']), true, 'a site allowed in the project counts in every session');
});

test('browser press: single keys and combinations such as Control+V and Shift+Enter', async () => {
  const { parseKeyCombination } = await import('../server/tools/browser.js');
  assert.deepEqual(parseKeyCombination('Control+V'), { modifiers: ['Control'], bits: 2, key: 'v', code: 'KeyV', keyCode: 86, text: undefined });
  assert.deepEqual(parseKeyCombination('shift+enter'), { modifiers: ['Shift'], bits: 8, key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
  assert.deepEqual(parseKeyCombination('Tab'), { modifiers: [], bits: 0, key: 'Tab', code: 'Tab', keyCode: 9, text: undefined });
  assert.equal(parseKeyCombination('Ctrl+Shift+K').bits, 10);
  assert.equal(parseKeyCombination('Hyper+V'), null);
  assert.equal(parseKeyCombination('Control+F13'), null);
});

test('web_search reads organic results from DuckDuckGo\'s page, with the real addresses and without ads', () => {
  const html = [
    '<div class="result results_links results_links_deep result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Buy now</a></div>',
    '<div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fdate%2Dfns&amp;rut=abc">date-fns &amp; friends - npm</a></h2>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Modern <b>JavaScript</b> date utility library.</a></div>',
  ].join('');
  assert.deepEqual(parseSearchResults(html), [{ title: 'date-fns & friends - npm', url: 'https://www.npmjs.com/package/date-fns', snippet: 'Modern JavaScript date utility library.' }]);
});

test('web_search uses Copilot\'s search, and DuckDuckGo when that fails', async () => {
  const fromCopilot = await webSearchTool.run({ query: 'node lts' }, { searchWeb: async (query, limit) => `1. Node.js\n   https://nodejs.org/\n   ${query}, up to ${limit}` });
  assert.equal(fromCopilot.content, 'Results for "node lts":\n\n1. Node.js\n   https://nodejs.org/\n   node lts, up to 8');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<div class="result results_links web-result"><a class="result__a" href="https://nodejs.org/">Node.js</a></div>');
  try {
    const fallback = await webSearchTool.run({ query: 'node lts' }, { searchWeb: async () => { throw new Error('HTTP 403'); } });
    assert.equal(fallback.content, 'Results for "node lts":\n\n1. Node.js\n   https://nodejs.org/');
    assert.deepEqual(fallback.meta, { query: 'node lts', via: 'duckduckgo', count: 1, copilotError: 'HTTP 403' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** A two-page PDF with a filled square on each page, built by hand (offsets in the cross-reference table). */
function tinyPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
    '<< /Length 26 >>\nstream\n0 0 1 rg 50 50 100 100 re f\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

test('read_file returns a PDF as one image per page, rendered by Windows', { skip: process.platform !== 'win32' }, async () => {
  const cwd = tempProject();
  fs.writeFileSync(path.join(cwd, 'square.pdf'), tinyPdf(), 'latin1');
  const ctx = makeContext(cwd);
  const all = await readFileTool.run({ path: 'square.pdf' }, ctx);
  assert.equal(all.content.filter((block) => block.type === 'image').length, 2);
  assert.match(all.content[0].text, /pages 1-2 of 2/);
  const second = await readFileTool.run({ path: 'square.pdf', pages: '2' }, ctx);
  assert.equal(second.content.filter((block) => block.type === 'image').length, 1);
  assert.equal(Buffer.from(second.content.find((block) => block.type === 'image').data, 'base64').subarray(0, 2).toString('hex'), 'ffd8', 'a JPEG');
  await assert.rejects(readFileTool.run({ path: 'square.pdf', pages: '1-30' }, ctx), /at most 20 pages/);
});

test('notebooks: read_file shows cells and outputs; notebook_edit replaces, inserts and deletes cells', async () => {
  const cwd = tempProject();
  const notebook = {
    cells: [
      { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Sales\n', 'Monthly totals.'] },
      { cell_type: 'code', execution_count: 3, id: 'load', metadata: {}, outputs: [{ output_type: 'stream', name: 'stdout', text: ['rows: 12\n'] }], source: ['df = load()\n', 'print(len(df))'] },
    ],
    metadata: { kernelspec: { language: 'python', name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  fs.writeFileSync(path.join(cwd, 'sales.ipynb'), `${JSON.stringify(notebook, null, 1)}\n`);
  const ctx = makeContext(cwd);
  const read = await readFileTool.run({ path: 'sales.ipynb' }, ctx);
  assert.match(read.content, /<cell index=1 id="load" type=code execution_count=3>\ndf = load\(\)\nprint\(len\(df\)\)\n<\/cell>\n<output type=stream>\nrows: 12/);

  await notebookEditTool.run({ path: 'sales.ipynb', cell_id: 'load', new_source: 'df = load()\ndf.head()' }, ctx);
  let saved = JSON.parse(fs.readFileSync(path.join(cwd, 'sales.ipynb'), 'utf8'));
  assert.deepEqual(saved.cells[1], { cell_type: 'code', execution_count: null, id: 'load', metadata: {}, outputs: [], source: ['df = load()\n', 'df.head()'] }, 'old outputs are cleared');
  assert.match(fs.readFileSync(path.join(cwd, 'sales.ipynb'), 'utf8'), /^\{\n "cells"/, 'Jupyter\'s one-space indentation is kept');

  const inserted = await notebookEditTool.run({ path: 'sales.ipynb', cell_id: 'intro', edit_mode: 'insert', cell_type: 'markdown', new_source: 'Data from the ERP.' }, ctx);
  assert.match(inserted.content, /Inserted a markdown cell at index 1/);
  saved = JSON.parse(fs.readFileSync(path.join(cwd, 'sales.ipynb'), 'utf8'));
  assert.deepEqual(saved.cells.map((cell) => cell.cell_type), ['markdown', 'markdown', 'code']);
  const insertedId = saved.cells[1].id;
  assert.equal(new Set(saved.cells.map((cell) => cell.id).filter(Boolean)).size, 3, 'the new cell gets its own id');

  await notebookEditTool.run({ path: 'sales.ipynb', cell_index: 0, edit_mode: 'delete' }, ctx);
  saved = JSON.parse(fs.readFileSync(path.join(cwd, 'sales.ipynb'), 'utf8'));
  assert.deepEqual(saved.cells.map((cell) => cell.id), [insertedId, 'load']);
  await assert.rejects(notebookEditTool.run({ path: 'sales.ipynb', cell_id: 'missing', new_source: 'x' }, ctx), /no cell with id "missing"/);
});

test('web_fetch reads a text file sent as application/octet-stream, and still refuses binary files', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(request.url === '/spec.yml' ? 'openapi: 3.0.1\npaths:\n  /search: {}\n' : Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const spec = await webFetchTool.run({ url: `${base}/spec.yml` }, {});
    assert.match(spec.content, /^openapi: 3\.0\.1\npaths:/);
    await assert.rejects(webFetchTool.run({ url: `${base}/archive.zip` }, {}), /application\/octet-stream, which is not text/);
  } finally {
    server.close();
  }
});

test('web_fetch does not follow a redirect to https on another port without approval', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(302, { Location: 'https://127.0.0.1:8443/admin' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await webFetchTool.run({ url: `http://127.0.0.1:${server.address().port}/` }, {});
    assert.match(result.content, /on another site/);
  } finally {
    server.close();
  }
});

test('protected files: names match anywhere, paths only inside the project', () => {
  const root = 'C:\\proj';
  assert.equal(protectedPattern('C:\\proj\\.env', root, DEFAULT_PROTECTED_FILES), '.env');
  assert.equal(protectedPattern('C:\\proj\\.env.staging', root, DEFAULT_PROTECTED_FILES), '.env.staging');
  assert.equal(protectedPattern('C:\\proj\\api\\certs\\server.PEM', root, DEFAULT_PROTECTED_FILES), '*.pem');
  assert.equal(protectedPattern('C:\\proj\\.env.example', root, DEFAULT_PROTECTED_FILES), null, 'examples stay readable');
  assert.equal(protectedPattern('C:\\Users\\me\\.ssh\\id_ed25519', root, DEFAULT_PROTECTED_FILES), 'id_ed25519', 'name patterns apply outside the project too');
  assert.equal(protectedPattern('C:\\proj\\config\\prod\\db.json', root, ['config/prod/*.json']), 'config/prod/*.json');
  assert.equal(protectedPattern('C:\\other\\config\\prod\\db.json', root, ['config/prod/*.json']), null);
  const home = os.homedir();
  assert.equal(protectedPattern(path.join(home, '.aws', 'credentials'), root, DEFAULT_PROTECTED_FILES), '~/.aws/credentials', '~/ patterns match in the home folder');
  assert.equal(protectedPattern(path.join(home, '.azure', 'msal_token_cache.json'), root, DEFAULT_PROTECTED_FILES), '~/.azure/*');
  assert.equal(protectedPattern(path.join(root, '.npmrc'), root, DEFAULT_PROTECTED_FILES), null, 'a project\'s own .npmrc stays readable');
});

test('PowerShell quoting keeps a file name with typographic quotes as one literal string', async () => {
  const name = `x${String.fromCharCode(0x2019)};Write-Output INJECTED;${String.fromCharCode(0x2019)}.py`;
  const result = await runCommandTool.run({ command: `Write-Output ${psQuote(name)}` }, { cwd: os.tmpdir(), settings: { shell: 'powershell', commandTimeoutSec: 30 }, extraPath: [], tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-quote-')), emitOutput: () => {} });
  assert.equal(result.content.split('\n').slice(1).join('\n').trim(), name);
});

test('hook and MCP server settings are checked; .mcp.json in both layouts, with bad entries skipped', async () => {
  assert.throws(() => validateHooks([{ match: '*.py', command: '  ' }]));
  assert.deepEqual(validateHooks([{ match: '*.py', command: ' ruff format {file} ', timeoutSec: 9999 }]), [{ match: '*.py', command: 'ruff format {file}', timeoutSec: 600 }]);
  assert.throws(() => validateMcpServers({ 'a b': { command: 'x' } }), /letters, digits/);
  assert.throws(() => validateMcpServers({ ado: { args: ['x'] } }), /needs a command/);
  assert.throws(() => validateMcpServers({ old: { type: 'sse', url: 'https://example.com/sse' } }), /SSE transport/);
  assert.deepEqual(validateMcpServers({ ado: { command: 'npx', args: ['-y', '@azure-devops/mcp', 'org'] } }), { ado: { command: 'npx', args: ['-y', '@azure-devops/mcp', 'org'], env: {} } });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-mcp-'));
  fs.writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({ servers: { web: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:TOKEN}' } }, ado: { command: 'evil' }, bad: { args: [] } } }));
  const { servers, skipped } = await mcpServersFor({ settingsServers: { ado: { command: 'npx', args: [], env: {} } }, root: folder });
  assert.deepEqual(servers, { ado: { command: 'npx', args: [], env: {} }, web: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:TOKEN}' } } }, 'Settings win over the project');
  assert.throws(() => validateMcpServers({ x: { command: 'npx', args: ['a\r\ncalc'] } }), /line breaks/);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /"bad"/);
  assert.deepEqual((await mcpServersFor({ settingsServers: {}, root: null })).servers, {}, 'an untrusted folder gives nothing');
});

test('an MCP server started as "npx" finds npm next to the npx.cmd on PATH, from any folder', async () => {
  // npx.cmd as npm 10 and 11 write it: it finds node.exe and npx-cli.js through its own folder (%~dp0).
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-runtime-'));
  fs.writeFileSync(path.join(runtime, 'npx.cmd'), '@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nIF NOT EXIST "%NODE_EXE%" (\r\n  SET "NODE_EXE=node"\r\n)\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n');
  fs.mkdirSync(path.join(runtime, 'node_modules', 'npm', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'tools', 'mock-mcp.js'), path.join(runtime, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  const hub = new McpHub({ log: { info() {}, warn() {}, error() {} } });
  try {
    const { tools, errors } = await hub.toolsFor({ servers: { ado: { command: 'npx', args: ['-y', '@azure-devops/mcp', 'org'], env: {} } }, cwd: os.tmpdir(), extraPath: [runtime, path.dirname(process.execPath)] });
    assert.deepEqual(errors, []);
    assert.deepEqual(tools.map((tool) => tool.tool), ['echo', 'create_item']);
  } finally {
    hub.closeAll();
  }
});

test('tool input validation', () => {
  assert.match(validateToolInput(getTool('read_file'), {}), /"path"/);
  assert.match(validateToolInput(getTool('read_file'), { path: 'a', offset: '3' }), /"offset"/);
  assert.match(validateToolInput(getTool('grep'), { pattern: 'x', output_mode: 'lines' }), /"output_mode"/);
  assert.equal(validateToolInput(getTool('read_file'), { path: 'a' }), null);
  assert.ok(!toolNamesForNewSession({ browserTools: false }).includes('browser'));
  assert.ok(toolNamesForNewSession({ browserTools: true }).includes('browser'));
});

test('skill front matter', async () => {
  const { parseFrontMatter } = await import('../server/skills.js');
  const parsed = parseFrontMatter('---\r\nname: "x"\r\ndescription: |\r\n  line one\r\n  line two\r\nother: y\r\n---\r\nBody');
  assert.deepEqual(parsed.attributes, { name: 'x', description: 'line one\nline two', other: 'y' });
  assert.equal(parsed.body, 'Body');
  assert.deepEqual(parseFrontMatter('No front matter').attributes, {});
});

test('edits to files that give the agent tools or run programs always ask; instruction files do not', async () => {
  const { steeringFileWarning } = await import('../server/permissions.js');
  assert.equal(steeringFileWarning('AGENTS.md'), null);
  assert.equal(steeringFileWarning('docs\\CLAUDE.md'), null);
  assert.equal(steeringFileWarning('src\\app.py'), null);
  assert.ok(steeringFileWarning('.mcp.json'));
  assert.ok(steeringFileWarning('.git\\hooks\\pre-commit'));
  assert.ok(steeringFileWarning('.claude/skills/deploy/SKILL.md'));
  assert.ok(steeringFileWarning('.github\\prompts\\release.prompt.md'));
});

test('htmlToText keeps structure and drops scripts', () => {
  const text = htmlToText('<html><head><title>x</title></head><body><script>evil()</script><h2>Title</h2><p>One &amp; two</p><ul><li>a</li><li>b</li></ul></body></html>');
  assert.doesNotMatch(text, /evil/);
  assert.match(text, /## Title/);
  assert.match(text, /One & two/);
  assert.match(text, /- a\n- b/);
});

test('versions compare by their numbers', async () => {
  const { isNewerVersion } = await import('../server/updates.js');
  assert.ok(isNewerVersion('1.10.0', '1.9.3'));
  assert.ok(isNewerVersion('2.0.0', '1.99.99'));
  assert.ok(!isNewerVersion('1.0.0', '1.0.0'));
  assert.ok(!isNewerVersion('0.9.0', '1.0.0'));
});

test('pull request remotes: GitHub and Azure DevOps addresses in their https and SSH forms', async () => {
  const { parseRemote } = await import('../server/pull-requests.js');
  for (const url of ['https://github.com/acme/billing.git', 'git@github.com:acme/billing.git', 'ssh://git@github.com/acme/billing', 'https://user@github.com/acme/billing']) {
    assert.deepEqual([parseRemote(url).provider, parseRemote(url).owner, parseRemote(url).repo], ['github', 'acme', 'billing'], url);
  }
  for (const url of ['https://dev.azure.com/contoso/Data%20Analytics/_git/loader', 'https://contoso@dev.azure.com/contoso/Data%20Analytics/_git/loader', 'git@ssh.dev.azure.com:v3/contoso/Data%20Analytics/loader', 'https://contoso.visualstudio.com/DefaultCollection/Data%20Analytics/_git/loader']) {
    const remote = parseRemote(url);
    assert.deepEqual([remote.provider, remote.organization, remote.project, remote.repository], ['azure', 'contoso', 'Data Analytics', 'loader'], url);
  }
  assert.equal(parseRemote('https://dev.azure.com/contoso/Data%20Analytics/_git/loader').webUrl, 'https://dev.azure.com/contoso/Data%20Analytics/_git/loader');
  assert.equal(parseRemote('https://gitlab.com/acme/billing.git'), null);
  // Names that would change the API address or add lines to git's credential lookup.
  assert.equal(parseRemote('https://collector%2eexample%2f.visualstudio.com/%0ahost%3dgithub.com%0apath%3dacme/_git/repo'), null);
  assert.equal(parseRemote('https://dev.azure.com/contoso/proj%0ahost%3dgithub.com/_git/repo'), null);
  assert.equal(parseRemote('https://dev.azure.com/con.toso/proj/_git/repo'), null);
});
