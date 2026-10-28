// MCP servers (Model Context Protocol): tools from other programs, such as Azure DevOps.
// - Servers come from Settings → MCP servers (every project) and from a project's .mcp.json, which
//   Caliope only reads once the user trusted the folder. With the same name, Settings win.
// - A session's MCP tools are fixed when it starts, like its other tools, and are named
//   mcp__<server>__<tool>.
// - A server starts when a session needs it and keeps running for the sessions in that folder until
//   Caliope closes or the server stops by itself. Changed settings start a new one.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_VERSION } from './config.js';
import { commandEnvironment } from './tools/shell.js';
import { killProcessTree } from './windows.js';
import { readSseEvents } from './sse-parser.js';
import { pathKey } from './tools/paths.js';
import { isPlainObject, truncateMiddle } from './util.js';

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

/** A tool name the model APIs accept (letters, digits, _ and -, up to 64). */
function toolNameFor(server, tool) {
  const name = `mcp__${server}__${String(tool).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
  return name;
}

class McpError extends Error {}

/** One running server: requests and their answers over stdio or HTTP. */
class McpConnection {
  constructor({ name, server, cwd, extraPath, onClose }) {
    this.name = name;
    this.server = server;
    this.cwd = cwd;
    this.extraPath = extraPath;
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
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...Object.fromEntries(Object.entries(this.server.headers).map(([key, value]) => [key, expandVariables(value)])) };
    if (this.httpSession) headers['Mcp-Session-Id'] = this.httpSession;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    const response = await fetch(expandVariables(this.server.url), { method: 'POST', headers, body: JSON.stringify(message), signal });
    this.httpSession = response.headers.get('mcp-session-id') || this.httpSession;
    if (response.status === 401 || response.status === 403) throw new McpError(`the server refused the sign-in (HTTP ${response.status}). Caliope sends the headers from the server's settings; servers that need an OAuth sign-in are not supported.`);
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

/** The running MCP servers, shared by the sessions in one folder. */
export class McpHub {
  constructor({ log }) {
    this.log = log;
    this.connections = new Map();
  }

  /** The running connection for a server (started when needed). */
  connect({ name, server, cwd, extraPath }) {
    const key = `${pathKey(cwd)}|${name}|${JSON.stringify(server)}`;
    let entry = this.connections.get(key);
    if (!entry) {
      const connection = new McpConnection({ name, server, cwd, extraPath, onClose: () => this.connections.delete(key) });
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
