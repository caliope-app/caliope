// Company proxies. Caliope's own requests and the programs it starts (git, npx MCP servers, the agent's
// commands) go through the same proxy: the one in Settings, or else HTTPS_PROXY / HTTP_PROXY / NO_PROXY
// from the environment.
// - Caliope's own address stays direct: the launcher, the window and local MCP servers talk to 127.0.0.1.
// - Node.js cannot use proxy scripts (PAC) or proxies that need the Windows sign-in (NTLM, Kerberos).
import http from 'node:http';
import { execFile } from 'node:child_process';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];
const VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'];

// The environment as Caliope started, so clearing the Settings proxy brings back the user's own variables.
const original = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
let restore = null;
let current = { source: null, url: null, unsupported: false };

/** The proxy in use, for Settings: { source, url, unsupported }. */
export function currentProxy() {
  return current;
}

/**
 * Apply the proxy for this process and the programs it starts. Call again after Settings change.
 * - Returns { source: 'settings' | 'environment' | null, url, unsupported }. `unsupported` means this
 *   Node.js cannot send Caliope's own requests through a proxy (the programs it starts still use it).
 */
export function applyProxy({ proxy = '', noProxy = '' } = {}) {
  restore?.();
  restore = null;
  for (const name of VARIABLES) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  const url = proxy || original.HTTPS_PROXY || original.HTTP_PROXY || '';
  current = { source: null, url: null, unsupported: false };
  if (!url) return current;
  const bypass = [...new Set([...`${noProxy},${original.NO_PROXY || ''}`.split(',').map((host) => host.trim()).filter(Boolean), ...LOOPBACK])].join(',');
  process.env.HTTPS_PROXY = proxy || original.HTTPS_PROXY || url;
  process.env.HTTP_PROXY = proxy || original.HTTP_PROXY || url;
  process.env.NO_PROXY = bypass;
  // Node.js programs Caliope starts (npx MCP servers) use these variables only with this flag.
  process.env.NODE_USE_ENV_PROXY = '1';
  // Node.js 24.14 and later. Caliope's zip has it, an older Node.js on PATH may not.
  const supported = typeof http.setGlobalProxyFromEnv === 'function';
  if (supported) restore = http.setGlobalProxyFromEnv({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: bypass });
  // Shown in Settings: without a password an environment variable may hold.
  current = { source: proxy ? 'settings' : 'environment', url: url.replace(/\/\/[^@/]*@/, '//'), unsupported: !supported };
  return current;
}

/** A proxy address for Settings: http(s)://host:port, without a password (Caliope does not store one). */
export function validateProxyUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`"${text}" is not a proxy address. Use the form http://proxy.company.com:8080.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The proxy address starts with http:// or https://.');
  if (url.username || url.password) throw new Error('Caliope does not store proxy passwords. Put the address with the password in the HTTPS_PROXY environment variable instead.');
  const address = `${url.protocol}//${url.host}`;
  return address;
}

/** The proxy Windows itself uses (Internet Options), as a hint for Settings; see parseInternetSettings. */
export function windowsProxy() {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, timeout: 5000 }, (_error, stdout) => resolve(parseInternetSettings(String(stdout || ''))));
  });
}

/**
 * Read `reg query` output of Internet Settings.
 * - Returns { proxy, bypass, script } with nulls for what is not set. A proxy script (PAC) cannot be used by Node.js.
 */
export function parseInternetSettings(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  const enabled = /^0x0*1$/i.test(values.ProxyEnable || '');
  const server = values.ProxyServer || '';
  // "host:port" for every protocol, or "http=host:port;https=host:port;…".
  const perProtocol = Object.fromEntries(server.split(';').filter((part) => part.includes('=')).map((part) => part.split('=').map((piece) => piece.trim())));
  const hostPort = server.includes('=') ? perProtocol.https || perProtocol.http || '' : server;
  const proxy = enabled && hostPort ? (/^[a-z][\w+.-]*:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`) : null;
  const bypass = enabled && values.ProxyOverride ? values.ProxyOverride.split(';').filter((host) => host && host !== '<local>').join(',') : null;
  const found = { proxy, bypass, script: values.AutoConfigURL || null };
  return found;
}
