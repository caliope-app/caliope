// Checks the built release files as a user's PC would use them. The release workflow runs it before publishing.
//   node tools/release-check.mjs dist/Caliope-windows-x64.zip [--install]
// - Unpacks the zip, and starts Microsoft's Azure DevOps MCP server the way Settings > MCP servers >
//   "Add Azure DevOps" does, with only the zip's own Node.js and npx on PATH.
// - With --install (only on the release workflow's disposable runner: it installs for the current user):
//   serves dist\ as a local copy of the release, runs the install line against it, checks the installed
//   files and the Settings > Apps entry, and uninstalls again.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const zip = path.resolve(process.argv[2] || 'dist/Caliope-windows-x64.zip');
// The long form of the folder: a runner's TEMP can be a short 8.3 name such as RUNNER~1.
const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-release-')));
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${folder.replace(/'/g, "''")}'`], { stdio: 'inherit' });
for (const file of ['Caliope.cmd', 'install.ps1', 'runtime/node.exe', 'runtime/npx.cmd', 'runtime/npm.cmd', 'runtime/node_modules/npm/bin/npx-cli.js']) {
  if (!fs.existsSync(path.join(folder, file))) throw new Error(`The zip has no ${file}.`);
}

// No other Node.js may help: PATH keeps only Windows' own folders.
const windows = process.env.SystemRoot || 'C:\\Windows';
process.env.PATH = [path.join(windows, 'System32'), windows, path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter);
const load = (file) => import(pathToFileURL(path.join(folder, file)).href);
const { detectExtraPath } = await load('server/config.js');
const { McpHub } = await load('server/mcp.js');
const extraPath = detectExtraPath();
if (fs.realpathSync.native(extraPath[0] || '.') !== path.join(folder, 'runtime')) throw new Error(`Caliope does not put its runtime folder first on PATH: ${extraPath.join(', ')}`);

// On a PC with build tools, such as the release runner, npm also compiles an optional native part of the
// server on its first download. That can take longer than Caliope waits for a server to start, so the
// zip's own npm downloads it first.
const runtime = path.join(folder, 'runtime');
execFileSync(path.join(runtime, 'node.exe'), [path.join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'exec', '--yes', '--package=@azure-devops/mcp', '--', 'node', '--version'], { cwd: folder, stdio: 'inherit', timeout: 600000, env: { ...process.env, PATH: [runtime, process.env.PATH].join(path.delimiter) } });

const hub = new McpHub({ log: console });
const server = { command: 'npx', args: ['-y', '@azure-devops/mcp', 'caliope-release-check'], env: {} };
const { tools, errors } = await hub.toolsFor({ servers: { ado: server }, cwd: folder, extraPath });
hub.closeAll();
if (tools.length === 0) {
  console.error(`The Azure DevOps MCP server did not list its tools with the zip's npx: ${errors.join(' ') || 'no tools'}`);
  process.exit(1);
}
console.log(`The Azure DevOps MCP server started with the zip's npx and listed ${tools.length} tools, for example ${tools.slice(0, 3).map((tool) => tool.tool).join(', ')}.`);

if (process.argv.includes('--install')) await checkInstaller(path.dirname(zip));
process.exit(0);

async function checkInstaller(dist) {
  const { version } = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  // releases/latest/download/<file>, like GitHub serves them.
  const releases = http.createServer((request, response) => {
    const file = path.join(dist, path.basename(decodeURIComponent(new URL(request.url, 'http://x').pathname)));
    if (!request.url.startsWith('/latest/download/') || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => releases.listen(0, '127.0.0.1', resolve));
  const releasesUrl = `http://127.0.0.1:${releases.address().port}`;
  const powershell = (command) => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { env: { ...process.env, CALIOPE_RELEASES_URL: releasesUrl }, timeout: 300000 });
  try {
    // The install line, with -NoStart so the runner does not open Caliope.
    const installed = await powershell(`& ([scriptblock]::Create((irm '${releasesUrl}/latest/download/install.ps1' -UseBasicParsing))) -NoStart`);
    console.log(installed.stdout.trim());
    const root = path.join(process.env.LOCALAPPDATA, 'Programs', 'Caliope');
    for (const file of ['Caliope.cmd', 'Caliope.ico', `${version}/Caliope.cmd`, `${version}/runtime/npx.cmd`, `${version}/install.ps1`]) {
      if (!fs.existsSync(path.join(root, file))) throw new Error(`The installer did not create ${file}.`);
    }
    const entry = await powershell("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Caliope').DisplayVersion");
    if (entry.stdout.trim() !== version) throw new Error(`The Settings > Apps entry shows version "${entry.stdout.trim()}" instead of ${version}.`);
    const again = await powershell(`& ([scriptblock]::Create((irm '${releasesUrl}/latest/download/install.ps1' -UseBasicParsing))) -NoStart`);
    if (!/already installed/.test(again.stdout)) throw new Error(`Installing the same version again did not say it is already installed: ${again.stdout}`);
    // The uninstall command exactly as Settings > Apps runs it.
    const uninstall = (await powershell("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Caliope').UninstallString")).stdout.trim();
    await promisify(execFile)(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${uninstall}"`], { windowsVerbatimArguments: true, timeout: 300000 });
    if (fs.existsSync(root)) throw new Error(`The uninstall left ${root} behind.`);
    console.log(`The install line installed ${version}, recognized it on a second run, and the uninstall removed it.`);
  } finally {
    releases.close();
  }
}
