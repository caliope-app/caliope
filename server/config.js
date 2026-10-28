import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimSlash } from './util.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
// Test addresses and the plain-text sign-in only count in a source checkout (the release zip has no test\). In a
// release, a program that sets an environment variable could otherwise send the sign-in or the update elsewhere.
const fromSource = fs.existsSync(path.join(appRoot, 'test'));

export const APP_NAME = 'Caliope';
// package.json holds the version and the repository. The releases page has install.ps1, the zip and manifest.json.
export const APP_VERSION = packageInfo.version;
export const RELEASES_URL = `${packageInfo.repository.url.replace(/\.git$/, '')}/releases`;

// Client ID of Caliope's own GitHub OAuth App (with "Enable Device Flow" on). With it, "Sign in with GitHub"
// uses the route GitHub documents for apps built on Copilot: the user authorizes Caliope and the token goes
// straight to the Copilot API, billed to that user's subscription. A fork needs its own OAuth App. Without
// one, only personal access tokens work. A client ID is public. It is not a secret.
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23lincmhY0oGK4DqDU';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('--')) continue;
    const [key, inlineValue] = argument.slice(2).split('=', 2);
    if (inlineValue !== undefined) args[key] = inlineValue;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

/**
 * Resolve paths and endpoints.
 * - Environment variables exist for tests (mock Copilot server, temporary data folder). The addresses only count
 *   in a source checkout (see fromSource).
 */
export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const testEnv = fromSource ? env : {};
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dataDir = path.resolve(args['data-dir'] || env.CALIOPE_DATA_DIR || path.join(localAppData, APP_NAME));
  const config = {
    appRoot,
    webDir: path.join(appRoot, 'web'),
    sharedDir: path.join(appRoot, 'shared'),
    dataDir,
    sessionsDir: path.join(dataDir, 'sessions'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.join(dataDir, 'tmp'),
    port: Number(args.port || env.CALIOPE_PORT || 0),
    open: Boolean(args.open),
    // --stay keeps the server running when no window is connected.
    stay: Boolean(args.stay) || !args.open,
    githubWeb: trimSlash(testEnv.CALIOPE_GITHUB_WEB || 'https://github.com'),
    githubApi: trimSlash(testEnv.CALIOPE_GITHUB_API || 'https://api.github.com'),
    apiBaseOverride: testEnv.CALIOPE_API_BASE ? trimSlash(testEnv.CALIOPE_API_BASE) : null,
    releasesUrl: trimSlash(testEnv.CALIOPE_RELEASES_URL || RELEASES_URL),
    // Azure DevOps API address instead of https://dev.azure.com (tests).
    azureDevOpsUrl: testEnv.CALIOPE_AZURE_DEVOPS_URL ? trimSlash(testEnv.CALIOPE_AZURE_DEVOPS_URL) : null,
    plainSecrets: testEnv.CALIOPE_PLAIN_SECRETS === '1' || process.platform !== 'win32',
    // Tests: never open app windows. Run the agent's browser without windows.
    noBrowser: env.CALIOPE_NO_BROWSER === '1',
    browserHeadless: env.CALIOPE_BROWSER_HEADLESS === '1',
    oauthClientId: testEnv.CALIOPE_GITHUB_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID || null,
    // Where Copilot editor plugins (JetBrains, Visual Studio, Vim) keep their GitHub sign-in: off limits to the agent.
    editorAuthDirs: [path.join(localAppData, 'github-copilot'), path.join(env.USERPROFILE || os.homedir(), '.config', 'github-copilot')],
  };
  return config;
}

/** The release zip's runtime\ folder (Node.js with npm and npx), when Caliope runs from the zip. */
export function bundledRuntime() {
  const bundled = path.join(appRoot, 'runtime');
  const folders = fs.existsSync(path.join(bundled, 'node.exe')) ? [bundled] : [];
  return folders;
}

/**
 * Folders that make node, npx, git and python usable in agent commands and MCP servers on this machine.
 * - The release zip has Node.js with npm and npx in runtime\, so "npx -y @azure-devops/mcp" works on a PC
 *   without Node.js.
 * - Run from source, it uses the copies the Codex app keeps under ~/.cache/codex-runtimes (not on PATH).
 *   A release uses only its own runtime and the user's PATH (more folders: Settings > Commands).
 */
export function detectExtraPath() {
  const own = bundledRuntime();
  if (own.length > 0) return own;
  const root = path.join(os.homedir(), '.cache', 'codex-runtimes');
  let runtimes = [];
  try {
    runtimes = fs.readdirSync(root).sort((a, b) => (a === 'codex-primary-runtime' ? -1 : b === 'codex-primary-runtime' ? 1 : a.localeCompare(b)));
  } catch {
    return [];
  }
  for (const runtime of runtimes) {
    const dependencies = path.join(root, runtime, 'dependencies');
    const candidates = [
      path.join(dependencies, 'native', 'git', 'cmd'),
      path.join(dependencies, 'python'),
      path.join(dependencies, 'python', 'Scripts'),
      path.join(dependencies, 'node', 'bin'),
    ];
    const existing = candidates.filter((folder) => fs.existsSync(folder));
    if (existing.length > 0) return existing;
  }
  return [];
}
