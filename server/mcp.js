// MCP servers (Model Context Protocol): tools from other programs, such as Azure DevOps.
// - Servers come from Settings → MCP servers (every project) and from a project's .mcp.json, which
//   Caliope only reads once the user trusted the folder. With the same name, Settings win.
// - A session's MCP tools are fixed when it starts, like its other tools, and are named
//   mcp__<server>__<tool>.
// - A server starts when a session needs it and keeps running for the sessions in that folder until
//   Caliope closes or the server stops by itself. Changed settings start a new one.
// - An HTTP server that asks for a sign-in gets one through OAuth, as the MCP authorization spec describes:
//   Settings → MCP servers → Sign in (see McpHub.signIn). The tokens are saved encrypted, by server address.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_VERSION } from './config.js';
import { commandEnvironment } from './tools/shell.js';
import { killProcessTree, protectSecret, unprotectSecret } from './windows.js';
import { readSseEvents } from './sse-parser.js';
import { pathKey } from './tools/paths.js';
import { isPlainObject, readJson, truncateMiddle, writeJsonAtomic } from './util.js';

const PROTOCOL_VERSION = '2025-06-18';
// npx may first download the server.
const START_TIMEOUT_MS = 120000;
const CALL_TIMEOUT_MS = 300000;
const MAX_RESULT_CHARS = 30000;
const MAX_TOOLS_PER_SERVER = 200;
const MAX_PROJECT_SERVERS = 30;
// A message from a stdio server must fit in this. A server that writes more without a line break is stopped.
const MAX_LINE_CHARS = 20 * 1024 * 1024;
const NOTIFY_TIMEOUT_MS = 15000;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
// How long a sign-in waits for the browser to come back.
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// An access token this close to its expiry is refreshed before the next request.
const REFRESH_MARGIN_MS = 60 * 1000;

/**
 * Check MCP server settings, { name: server }. Throws a message naming the problem.
 * - A server is a program to start ({ command, args, env }) or an HTTP address ({ url, headers }).
 */
export function validateMcpServers(servers) {
  if (!isPlainObject(servers)) throw new Error('expected servers by name');
  const entries = Object.entries(servers);
  if (entries.length > 30) throw new Error('expected up to 30 servers');
  const valid = {};
  for (const [name, server] of entries) {
    if (!SERVER_NAME.test(name)) throw new Error(`"${name}": use up to 40 letters, digits, - and _`);
    valid[name] = normalizeServer(name, server);
  }
  return valid;
}

function normalizeServer(name, server) {
  if (!isPlainObject(server)) throw new Error(`"${name}" must be an object`);
  const stringMap = (map) => (isPlainObject(map) ? Object.fromEntries(Object.entries(map).map(([key, value]) => [key, String(value)])) : {});
  if (typeof server.url === 'string' && server.url.trim()) {
    if (!/^https?:\/\//i.test(server.url.trim())) throw new Error(`"${name}": the url must start with https://`);
    if (server.type === 'sse') throw new Error(`"${name}": the old SSE transport is not supported; use the server's streamable HTTP address`);
    const httpServer = { url: server.url.trim(), headers: stringMap(server.headers) };
    return httpServer;
  }
  if (typeof server.command === 'string' && server.command.trim()) {
    const programServer = { command: server.command.trim(), args: Array.isArray(server.args) ? server.args.map(String) : [], env: stringMap(server.env) };
    // The program starts through cmd.exe, where a line break would end the command and start another.
    if ([programServer.command, ...programServer.args].some((word) => /[\r\n]/.test(word))) throw new Error(`"${name}": the command and arguments cannot contain line breaks`);
    return programServer;
  }
  throw new Error(`"${name}" needs a command (the program to start) or a url`);
}

/**
 * The MCP servers a session can use: the user's from Settings, plus those in `root`/.mcp.json when
 * the folder is trusted (`root` is null otherwise). Reads both the "mcpServers" (Claude Code) and the
 * "servers" (VS Code) layout. Servers it cannot use are listed in `skipped`.
 */
export async function mcpServersFor({ settingsServers, root }) {
  const servers = { ...settingsServers };
  const skipped = [];
  if (!root) return { servers, skipped };
  let file;
  try {
    file = JSON.parse(await fsp.readFile(path.join(root, '.mcp.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') skipped.push(`.mcp.json could not be read: ${error.message}`);
    return { servers, skipped };
  }
  const entries = Object.entries(file?.mcpServers || file?.servers || {});
  if (entries.length > MAX_PROJECT_SERVERS) skipped.push(`.mcp.json lists ${entries.length} servers; Caliope starts only the first ${MAX_PROJECT_SERVERS}.`);
  for (const [name, server] of entries.slice(0, MAX_PROJECT_SERVERS)) {
    if (name in servers) continue;
    try {
      if (!SERVER_NAME.test(name)) throw new Error(`"${name}": use up to 40 letters, digits, - and _`);
      servers[name] = normalizeServer(name, server);
    } catch (error) {
      skipped.push(`.mcp.json: ${error.message}`);
    }
  }
  return { servers, skipped };
}

/** ${NAME} and ${env:NAME} become environment variables, so tokens need not be written in a file. */
function expandVariables(text) {
  const expanded = String(text).replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match);
  return expanded;
}

/** The headers from an HTTP server's settings, with variables expanded. */
function serverHeaders(server) {
  const headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expandVariables(value)]));
  return headers;
}

/** A tool name the model APIs accept (letters, digits, _ and -, up to 64). */
function toolNameFor(server, tool) {
  const name = `mcp__${server}__${String(tool).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
  return name;
}

class McpError extends Error {}

/** One running server: requests and their answers over stdio or HTTP. */
class McpConnection {
  constructor({ name, server, cwd, extraPath, signIns, onClose }) {
    this.name = name;
    this.server = server;
    this.cwd = cwd;
    this.extraPath = extraPath;
    this.signIns = signIns;
    this.onClose = onClose;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
    this.httpSession = null;
    this.tools = [];
    this.instructions = '';
  }

  async start() {
    if (!this.server.url) this.startProcess();
    const signal = AbortSignal.timeout(START_TIMEOUT_MS);
    const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Caliope', version: APP_VERSION } }, { signal });
    this.protocolVersion = init.protocolVersion || PROTOCOL_VERSION;
    this.instructions = typeof init.instructions === 'string' ? init.instructions : '';
    await this.notify('notifications/initialized');
    const tools = [];
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {}, { signal });
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS_PER_SERVER);
    this.tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
    return this;
  }

  /**
   * Start the server program. On Windows it goes through cmd.exe, because npx and similar are .cmd files.
   * - A plain command name such as npx stays unquoted: cmd.exe gives a quoted "npx" found on PATH the
   *   current folder as its own folder, and npm's npx.cmd then cannot find npx-cli.js.
   */
  startProcess() {
    const env = { ...commandEnvironment(this.extraPath), ...Object.fromEntries(Object.entries(this.server.env).map(([key, value]) => [key, expandVariables(value)])) };
    const words = [this.server.command, ...this.server.args].map(expandVariables);
    const options = { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    // Backslashes at the end are doubled, or "C:\work dir\" would escape its closing quote.
    const quote = (word) => `"${word.replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;
    const commandLine = [/^[\w.\\:/-]+$/.test(words[0]) ? words[0] : quote(words[0]), ...words.slice(1).map(quote)].join(' ');
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { ...options, windowsVerbatimArguments: true })
        : spawn(words[0], words.slice(1), options);
    this.child = child;
    let buffered = '';
    const decoder = new TextDecoder('utf-8');
    child.stdout.on('data', (chunk) => {
      buffered += decoder.decode(chunk, { stream: true });
      if (buffered.length > MAX_LINE_CHARS) {
        this.close('wrote a message larger than 20 MB');
        return;
      }
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          // A server that logs to stdout: not a message.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.close(`could not start: ${error.message}`));
    child.on('close', (code) => this.close(`stopped (exit code ${code})`));
  }

  handleMessage(message) {
    if (message.method && message.id !== undefined) {
      // Requests from the server: answer pings. Caliope offers no other client features.
      const answer = message.method === 'ping' ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Caliope does not support ${message.method}.` } };
      this.send(answer).catch(() => {});
      return;
    }
    const waiting = message.id !== undefined ? this.pending.get(message.id) : null;
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new McpError(message.error.message || `error ${message.error.code}`));
    else waiting.resolve(message.result ?? {});
  }

  async request(method, params, { signal }) {
    if (this.closed) throw new McpError(this.closedReason);
    const id = this.nextId++;
    const answer = new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(signal.reason?.name === 'TimeoutError' ? new McpError(`no answer to ${method} in time`) : signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
    });
    // Not awaited: an HTTP server may keep the answer's event stream open after answering.
    this.send({ jsonrpc: '2.0', id, method, params }, signal).catch((error) => this.pending.get(id)?.reject(error));
    return answer;
  }

  async notify(method) {
    await this.send({ jsonrpc: '2.0', method }, AbortSignal.timeout(NOTIFY_TIMEOUT_MS));
  }

  async send(message, signal) {
    if (!this.server.url) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    // Streamable HTTP: each message is a POST. The answer comes as JSON or as an event stream.
    const url = expandVariables(this.server.url);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...serverHeaders(this.server) };
    if (this.httpSession) headers['Mcp-Session-Id'] = this.httpSession;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    // A server the user signed in to gets its OAuth token on every request, in place of a header from the settings.
    const post = (authorization) => fetch(url, { method: 'POST', headers: authorization ? { ...headers, Authorization: authorization } : headers, body: JSON.stringify(message), signal });
    const signedIn = await this.signIns.authorization(this.server.url);
    let response = await post(signedIn);
    // The server can end a token before it expires. A refreshed token gets one more try.
    if (response.status === 401 && signedIn) {
      await response.body?.cancel().catch(() => {});
      const refreshed = await this.signIns.authorization(this.server.url, { force: true });
      if (refreshed) response = await post(refreshed);
    }
    this.httpSession = response.headers.get('mcp-session-id') || this.httpSession;
    if (response.status === 401) throw new McpError(signedIn ? 'no longer accepts the sign-in (HTTP 401). Choose Sign in for it again in Settings → MCP servers' : 'asks for a sign-in (HTTP 401). Choose Sign in for it in Settings → MCP servers, or put a token in the server\'s headers');
    if (response.status === 403) throw new McpError('refused the request (HTTP 403). The sign-in or the token in the headers lacks a permission the server needs');
    if (!response.ok) throw new McpError(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    // Only Caliope's own requests get answers. For notifications and replies the body is not needed.
    if (!message.method || message.id === undefined) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      for await (const event of readSseEvents(response.body)) {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch {
          // Not a JSON-RPC message.
        }
        // Answered: stop reading, which closes a stream the server keeps open.
        if (!this.pending.has(message.id)) break;
      }
      return;
    }
    const text = await response.text();
    if (!text.trim()) return;
    const parsed = JSON.parse(text);
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) this.handleMessage(item);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    const stderr = this.stderr.trim();
    this.closedReason = `The MCP server "${this.name}" ${reason}.${stderr ? ` Its last output: ${truncateMiddle(stderr, 1500)}` : ''}`;
    for (const waiting of this.pending.values()) waiting.reject(new McpError(this.closedReason));
    this.pending.clear();
    if (this.child && this.child.exitCode === null) killProcessTree(this.child.pid);
    this.onClose();
  }
}

/**
 * OAuth sign-ins of HTTP MCP servers, by the server address as written in the settings, in `file` next to
 * settings.json. The address is kept unexpanded, so a ${env:...} variable in it is not written to the file.
 * - Encrypted for this Windows user (DPAPI) like the GitHub sign-in; plain only where `plainSecrets` is set
 *   (tests, other systems). Without a file (tests of other parts), there are no sign-ins.
 * - A sign-in: { issuer, tokenEndpoint, clientId, clientSecret, clientAuth, resource, accessToken, refreshToken, expiresAt }.
 */
class McpSignIns {
  constructor({ file, plainSecrets, log }) {
    this.file = file;
    this.plainSecrets = plainSecrets;
    this.log = log;
    this.cache = new Map();
    this.refreshing = new Map();
    this.saving = Promise.resolve();
  }

  /** The saved sign-in for `url`, or null. One that cannot be decrypted (another Windows user) counts as none. */
  async get(url) {
    if (!this.file) return null;
    if (!this.cache.has(url)) {
      const stored = (await readJson(this.file, {}))[url];
      let signIn = null;
      try {
        signIn = stored?.dpapi ? JSON.parse(await unprotectSecret(stored.dpapi)) : stored?.plain || null;
      } catch {
        // Sign in again.
      }
      this.cache.set(url, signIn);
    }
    return this.cache.get(url);
  }

  /**
   * Keep the sign-in for `url` in memory and save it in the file.
   * - Returns null, or why it could not be saved, for example on a Node.js without node:ffi (see callDpapi). It then
   *   lasts until Caliope closes, as the GitHub sign-in does.
   */
  async save(url, signIn) {
    this.cache.set(url, signIn);
    // One write at a time, so two refreshes at once do not drop each other's tokens.
    const write = this.saving.then(async () => {
      const stored = await readJson(this.file, {});
      stored[url] = this.plainSecrets ? { plain: signIn } : { dpapi: await protectSecret(JSON.stringify(signIn)) };
      await writeJsonAtomic(this.file, stored);
    });
    this.saving = write.catch(() => {});
    try {
      await write;
      return null;
    } catch (error) {
      this.log.warn(`The MCP sign-in for ${url} could not be saved; it lasts until Caliope closes.`, error.message);
      return error.message;
    }
  }

  /** Sign out of `url`: its tokens leave memory and the file. */
  async remove(url) {
    // null, not deleted: a request meanwhile would otherwise read the tokens back from the file before it is written.
    this.cache.set(url, null);
    const write = this.saving.then(async () => {
      const stored = await readJson(this.file, {});
      if (!(url in stored)) return;
      delete stored[url];
      await writeJsonAtomic(this.file, stored);
    });
    this.saving = write.catch(() => {});
    await write;
  }

  /**
   * The Authorization header for `url`, or null without a usable sign-in.
   * - An access token that expires soon, or any token with `force` (after a 401), is refreshed first.
   */
  async authorization(url, { force = false } = {}) {
    let signIn = await this.get(url);
    if (signIn && (force || (signIn.expiresAt && signIn.expiresAt - REFRESH_MARGIN_MS < Date.now()))) signIn = await this.refresh(url, signIn);
    const header = signIn ? `Bearer ${signIn.accessToken}` : null;
    return header;
  }

  /**
   * New tokens from the refresh token, saved; null when there is none or the server refuses it.
   * - Sessions in several folders share a sign-in, and a refresh token may work only once: they share one refresh.
   */
  refresh(url, signIn) {
    if (!this.refreshing.has(url)) {
      const refreshing = (async () => {
        if (!signIn.refreshToken) return null;
        let tokens;
        try {
          tokens = await tokenRequest(signIn, { grant_type: 'refresh_token', refresh_token: signIn.refreshToken });
        } catch {
          return null;
        }
        // The server may keep the refresh token and leave it out of the answer.
        const refreshed = { ...signIn, ...tokens, refreshToken: tokens.refreshToken || signIn.refreshToken };
        await this.save(url, refreshed);
        return refreshed;
      })().finally(() => this.refreshing.delete(url));
      this.refreshing.set(url, refreshing);
    }
    return this.refreshing.get(url);
  }
}

/**
 * A token request (OAuth 2.1 section 3.2) for the sign-in's client and resource.
 * - Returns { accessToken, refreshToken, expiresAt }. Throws the server's reason when it refuses.
 */
async function tokenRequest(signIn, params) {
  const body = new URLSearchParams({ ...params, client_id: signIn.clientId, resource: signIn.resource });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  // A client the server registered with a secret sends it the way the registration says.
  if (signIn.clientSecret && signIn.clientAuth === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(signIn.clientId)}:${encodeURIComponent(signIn.clientSecret)}`).toString('base64')}`;
  else if (signIn.clientSecret) body.set('client_secret', signIn.clientSecret);
  const response = await fetch(signIn.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || typeof answer.access_token !== 'string') throw new McpError(answer.error_description || answer.error || `HTTP ${response.status}`);
  const tokens = { accessToken: answer.access_token, refreshToken: answer.refresh_token || null, expiresAt: answer.expires_in ? Date.now() + Number(answer.expires_in) * 1000 : null };
  return tokens;
}

/** A JSON document, or null when the address does not answer with one. */
async function getJson(url) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const document = response.ok ? await response.json() : null;
    return isPlainObject(document) ? document : null;
  } catch {
    return null;
  }
}

/** The parameters of a WWW-Authenticate header, such as resource_metadata and scope (RFC 6750 section 3). */
function challengeParameters(header) {
  const parameters = {};
  for (const [, key, quoted, plain] of String(header || '').matchAll(/([A-Za-z_]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) parameters[key.toLowerCase()] = quoted ?? plain;
  return parameters;
}

/** True for an https address, or http on this PC. The sign-in sends codes and tokens to these addresses. */
function secureAddress(address) {
  const parsed = new URL(address);
  const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
  return secure;
}

/**
 * The protected resource metadata (RFC 9728) of the MCP server at `url`: at the address from the 401 answer, or
 * else at the well-known address with the server's path, then at the root.
 * - Its `resource` must be the server's address or a part of its origin above it, and it must name an authorization server.
 */
async function protectedResourceMetadata(name, url, fromChallenge) {
  const address = new URL(url);
  const serverPath = address.pathname.replace(/\/$/, '');
  const candidates = fromChallenge ? [fromChallenge] : [...(serverPath ? [`${address.origin}/.well-known/oauth-protected-resource${serverPath}`] : []), `${address.origin}/.well-known/oauth-protected-resource`];
  for (const candidate of candidates) {
    // The metadata names the authorization server, so it must come over https too.
    if (!URL.canParse(candidate) || !secureAddress(candidate)) throw new McpError(`The MCP server "${name}" describes its sign-in at an address without https (${candidate}), so Caliope does not sign in.`);
    const metadata = await getJson(candidate);
    if (!metadata) continue;
    const resource = URL.canParse(metadata.resource) ? new URL(metadata.resource) : null;
    const resourcePath = resource?.pathname.replace(/\/$/, '');
    const covers = resource && resource.origin === address.origin && (address.pathname === resourcePath || address.pathname.startsWith(`${resourcePath}/`));
    if (!covers) throw new McpError(`The MCP server "${name}" describes its sign-in for another address (${metadata.resource}), so Caliope does not sign in.`);
    if (typeof metadata.authorization_servers?.[0] !== 'string') throw new McpError(`The MCP server "${name}" names no authorization server to sign in with.`);
    return metadata;
  }
  throw new McpError(`The MCP server "${name}" asks for a sign-in but does not describe it (OAuth protected resource metadata), so Caliope cannot sign in. Put a token in its headers instead.`);
}

/**
 * The metadata of an authorization server (RFC 8414 or OpenID Connect Discovery), tried at the addresses the MCP
 * spec lists for an issuer with or without a path.
 * - The document must name the same issuer, or another server could stand in for it.
 */
async function authorizationServerMetadata(name, issuer) {
  const address = new URL(issuer);
  const issuerPath = address.pathname.replace(/\/$/, '');
  const candidates = issuerPath
    ? [`${address.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${address.origin}/.well-known/openid-configuration${issuerPath}`, `${address.origin}${issuerPath}/.well-known/openid-configuration`]
    : [`${address.origin}/.well-known/oauth-authorization-server`, `${address.origin}/.well-known/openid-configuration`];
  for (const candidate of candidates) {
    const metadata = await getJson(candidate);
    if (metadata?.issuer === issuer) return metadata;
  }
  throw new McpError(`Caliope could not read the sign-in settings of ${issuer}, the authorization server of "${name}".`);
}

/**
 * A one-time web server on 127.0.0.1, at a random port, for the browser's redirect after the sign-in.
 * - Returns { redirectUri, answer, close }. `answer` resolves with the query parameters of the redirect that carries
 *   `state`, or with null when none came within SIGN_IN_TIMEOUT_MS.
 * - A request with another state is refused, and the wait goes on: another program on this PC that finds the port
 *   cannot end the sign-in with an answer of its own.
 */
async function loopbackRedirect(state) {
  let deliver;
  const answer = new Promise((resolve) => {
    deliver = resolve;
  });
  const server = http.createServer((request, response) => {
    const address = new URL(request.url, 'http://127.0.0.1');
    if (address.pathname !== '/callback' || address.searchParams.get('state') !== state) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Caliope</title><p>You can close this tab and go back to Caliope.</p>');
    deliver(address.searchParams);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => deliver(null), SIGN_IN_TIMEOUT_MS);
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  const redirect = { redirectUri: `http://127.0.0.1:${server.address().port}/callback`, answer, close };
  return redirect;
}

/** The running MCP servers, shared by the sessions in one folder. */
export class McpHub {
  /** `signInFile`: where OAuth sign-ins are saved (see McpSignIns). */
  constructor({ log, signInFile = null, plainSecrets = false }) {
    this.log = log;
    this.connections = new Map();
    this.signIns = new McpSignIns({ file: signInFile, plainSecrets, log });
  }

  /**
   * Sign in to an HTTP MCP server with OAuth, as the MCP authorization spec describes, and save the tokens for its address.
   * - The server's 401 answer leads to its protected resource metadata, which names the authorization server.
   * - Caliope registers itself there (dynamic client registration) and opens the sign-in page with `openUrl`. The page
   *   sends the browser back to 127.0.0.1 with a code, which Caliope exchanges with PKCE (S256).
   * - Throws a message for the user when the server needs no sign-in, or offers no sign-in Caliope can use.
   * - Returns null, or why the tokens could not be saved: the sign-in then lasts until Caliope closes.
   */
  async signIn({ name, server, openUrl }) {
    const url = expandVariables(server.url);
    // An initialize request without a token: the 401 answer says where to sign in.
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Caliope', version: APP_VERSION } } };
    const probe = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...serverHeaders(server) }, body: JSON.stringify(initialize), signal: AbortSignal.timeout(30000) });
    await probe.body?.cancel().catch(() => {});
    if (probe.status !== 401) throw new McpError(probe.ok ? `The MCP server "${name}" does not ask for a sign-in.` : `The MCP server "${name}" answered HTTP ${probe.status} instead of asking for a sign-in.`);
    const challenge = challengeParameters(probe.headers.get('www-authenticate'));
    const resourceMetadata = await protectedResourceMetadata(name, url, challenge.resource_metadata);
    const issuer = resourceMetadata.authorization_servers[0];
    if (!secureAddress(issuer)) throw new McpError(`The authorization server of "${name}" does not use https, so Caliope does not sign in.`);
    const metadata = await authorizationServerMetadata(name, issuer);
    // The spec requires PKCE, and an authorization server that does not list S256 may not check it.
    if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new McpError(`The authorization server of "${name}" does not support PKCE (S256), so Caliope does not sign in.`);
    if (typeof metadata.registration_endpoint !== 'string') throw new McpError(`The authorization server of "${name}" does not let apps register themselves (dynamic client registration), which Caliope needs. Put a token in the server's headers instead.`);
    if (![metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint].every((endpoint) => typeof endpoint === 'string' && secureAddress(endpoint))) throw new McpError(`The authorization server of "${name}" gives sign-in addresses without https, so Caliope does not sign in.`);

    const state = crypto.randomBytes(16).toString('base64url');
    const redirect = await loopbackRedirect(state);
    try {
      // A new registration for each sign-in: the redirect address has a new port each time, and servers compare it exactly.
      const registration = { client_name: 'Caliope', redirect_uris: [redirect.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' };
      const registered = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(registration), signal: AbortSignal.timeout(30000) });
      const client = await registered.json().catch(() => ({}));
      if (!registered.ok || typeof client.client_id !== 'string') throw new McpError(`The authorization server of "${name}" refused to register Caliope: ${client.error_description || client.error || `HTTP ${registered.status}`}.`);

      const verifier = crypto.randomBytes(32).toString('base64url');
      // Scopes: the ones the 401 asked for, else the server's list. offline_access asks for a refresh token where the server offers one.
      const scopes = (challenge.scope || resourceMetadata.scopes_supported?.join(' ') || '').split(' ').filter(Boolean);
      if (scopes.length > 0 && metadata.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access')) scopes.push('offline_access');
      const authorizationUrl = new URL(metadata.authorization_endpoint);
      const query = { response_type: 'code', client_id: client.client_id, redirect_uri: redirect.redirectUri, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, resource: resourceMetadata.resource, ...(scopes.length ? { scope: scopes.join(' ') } : {}) };
      for (const [key, value] of Object.entries(query)) authorizationUrl.searchParams.set(key, value);
      openUrl(authorizationUrl.href);

      const answer = await redirect.answer;
      if (!answer) throw new McpError(`The sign-in for "${name}" was not finished within ${SIGN_IN_TIMEOUT_MS / 60000} minutes.`);
      // RFC 9207: an answer from another authorization server is ignored, also its error.
      const iss = answer.get('iss');
      if (iss !== null ? iss !== metadata.issuer : metadata.authorization_response_iss_parameter_supported === true) throw new McpError(`The sign-in answer for "${name}" did not come from its authorization server, so Caliope ignored it.`);
      if (answer.get('error')) throw new McpError(`The sign-in for "${name}" did not succeed: ${answer.get('error_description') || answer.get('error')}.`);

      const signIn = { issuer, tokenEndpoint: metadata.token_endpoint, clientId: client.client_id, clientSecret: client.client_secret || null, clientAuth: client.token_endpoint_auth_method || 'none', resource: resourceMetadata.resource };
      let tokens;
      try {
        tokens = await tokenRequest(signIn, { grant_type: 'authorization_code', code: answer.get('code') || '', redirect_uri: redirect.redirectUri, code_verifier: verifier });
      } catch (error) {
        throw new McpError(`The authorization server of "${name}" did not give a token for the sign-in: ${error.message}.`);
      }
      const saveFailed = await this.signIns.save(server.url, { ...signIn, ...tokens });
      return saveFailed;
    } finally {
      redirect.close();
    }
  }

  /** The running connection for a server (started when needed). */
  connect({ name, server, cwd, extraPath }) {
    const key = `${pathKey(cwd)}|${name}|${JSON.stringify(server)}`;
    let entry = this.connections.get(key);
    if (!entry) {
      const connection = new McpConnection({ name, server, cwd, extraPath, signIns: this.signIns, onClose: () => this.connections.delete(key) });
      const started = connection.start().catch((error) => {
        connection.close(error.message);
        this.connections.delete(key);
        throw new McpError(connection.closedReason || `The MCP server "${name}" did not start: ${error.message}`);
      });
      entry = { connection, started };
      this.connections.set(key, entry);
    }
    return entry.started;
  }

  /**
   * Start the servers and list their tools.
   * - Returns { tools: [{ name, server, tool, description, inputSchema, readOnly }], errors }: a server
   *   that does not start adds a message to `errors` and no tools.
   */
  async toolsFor({ servers, cwd, extraPath }) {
    const tools = [];
    const errors = [];
    const names = new Set();
    const started = await Promise.allSettled(Object.entries(servers).map(([name, server]) => this.connect({ name, server, cwd, extraPath }).then((connection) => ({ name, connection }))));
    for (const outcome of started) {
      if (outcome.status === 'rejected') {
        errors.push(outcome.reason.message);
        continue;
      }
      const { name, connection } = outcome.value;
      for (const tool of connection.tools) {
        const toolName = toolNameFor(name, tool.name);
        if (names.has(toolName)) {
          errors.push(`The MCP server "${name}" has a tool "${tool.name}" whose name, shortened to fit, is taken by another tool; it is left out.`);
          continue;
        }
        names.add(toolName);
        const schema = isPlainObject(tool.inputSchema) ? { type: 'object', properties: {}, ...tool.inputSchema } : { type: 'object', properties: {} };
        tools.push({
          name: toolName,
          server: name,
          tool: tool.name,
          description: `${String(tool.description || tool.title || tool.name).slice(0, 4000)}\n(Tool of the MCP server "${name}".)`,
          inputSchema: schema,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
    }
    return { tools, errors };
  }

  /** Call a tool; returns a tool result (text, and images the server sends). */
  async call({ name, server, cwd, extraPath, tool, input, signal }) {
    const connection = await this.connect({ name, server, cwd, extraPath });
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
    const answer = await connection.request('tools/call', { name: tool, arguments: input }, { signal: callSignal });
    const content = [];
    for (const item of answer.content || []) {
      if (item.type === 'text') content.push({ type: 'text', text: item.text });
      else if (item.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(item.mimeType)) content.push({ type: 'image', mediaType: item.mimeType, data: item.data });
      else if (item.type === 'resource' && typeof item.resource?.text === 'string') content.push({ type: 'text', text: `${item.resource.uri}:\n${item.resource.text}` });
      else if (item.type === 'resource_link') content.push({ type: 'text', text: `Link: ${item.uri}${item.name ? ` (${item.name})` : ''}` });
    }
    if (content.length === 0 && answer.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(answer.structuredContent, null, 2) });
    const text = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n\n');
    const images = content.filter((item) => item.type === 'image');
    const shown = truncateMiddle(text || '(no output)', MAX_RESULT_CHARS);
    const result = { content: images.length > 0 ? [...images, { type: 'text', text: shown }] : shown, isError: answer.isError === true, meta: { server: name, tool, output: shown } };
    return result;
  }

  /** Stop every server (when Caliope closes), also those still starting. */
  closeAll() {
    const entries = [...this.connections.values()];
    this.connections.clear();
    for (const { connection } of entries) connection.close();
  }
}
