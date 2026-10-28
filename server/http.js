// Local HTTP server for the app window.
//
// Security: the agent can run commands, so the API must only answer the app window.
// - Listens on 127.0.0.1 only and rejects other Host headers (blocks DNS rebinding).
// - Every request needs the session cookie, which the launcher sets through /auth?token=...
//   That token works once and only for two minutes: the browser's command line and history can be
//   read by other programs, so the link never carries the launch secret. A second launcher asks the
//   running server for a token with that secret (from server.json, new for every start) in a header
//   (POST /launch). A newer version that starts after an update stops the old server the same way
//   (POST /shutdown).
//   The cookie is SameSite=Strict, so other websites cannot send it. Its value is new for every server
//   start and never the launch secret.
// - Browsers also send the cookie to every other server on 127.0.0.1 (cookies ignore the port), so a
//   server another user runs there could capture it. API requests therefore also need the per-start API
//   key: /auth hands it to the app window in the address (#key=...), which no other origin can read, and
//   the window sends it in the X-Caliope header (or ?key= where a header is not possible). Cross-site
//   pages cannot add that header without a CORS preflight, which this server never approves.
// - Changing requests also need a matching Origin when one is sent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE = 'caliope';
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const LAUNCH_TOKEN_MS = 2 * 60 * 1000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createAppServer({ config, secret, routes, hub, log, onShutdown }) {
  let port = 0;
  // Launch token -> expiry time.
  const launchTokens = new Map();
  const sessionCookie = crypto.randomBytes(32).toString('hex');
  const apiKey = crypto.randomBytes(32).toString('hex');

  function createLaunchToken() {
    const token = crypto.randomBytes(32).toString('hex');
    launchTokens.set(token, Date.now() + LAUNCH_TOKEN_MS);
    return token;
  }

  /** True for an unused, unexpired launch token; it cannot be used again. */
  function useLaunchToken(token) {
    const expiresAt = launchTokens.get(token);
    launchTokens.delete(token);
    for (const [other, otherExpiry] of launchTokens) if (otherExpiry < Date.now()) launchTokens.delete(other);
    const valid = Boolean(expiresAt) && Date.now() < expiresAt;
    return valid;
  }
  const server = http.createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      const status = error.status || 500;
      // The path only: a query can carry the API key.
      if (status >= 500) log.error(`${request.method} ${request.url.split('?')[0]} failed.`, error);
      if (!response.headersSent) sendJson(response, status, { error: error.message || 'Request failed.' });
      else response.end();
    }
  });
  server.keepAliveTimeout = 65000;

  async function handle(request, response) {
    const host = String(request.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.writeHead(421, { 'Content-Type': 'text/plain' });
      response.end('Wrong host.');
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    if (url.pathname === '/api/ping') {
      sendJson(response, 200, { app: 'Caliope' });
      return;
    }
    if (url.pathname === '/launch' && request.method === 'POST') {
      if (!safeEqual(request.headers['x-caliope-secret'] || '', secret)) {
        sendJson(response, 403, { error: 'Not authorized.' });
        return;
      }
      sendJson(response, 200, { token: createLaunchToken() });
      return;
    }
    if (url.pathname === '/shutdown' && request.method === 'POST') {
      if (!safeEqual(request.headers['x-caliope-secret'] || '', secret)) {
        sendJson(response, 403, { error: 'Not authorized.' });
        return;
      }
      sendJson(response, 200, { ok: true });
      // "update" when a newer version stops this one. Otherwise the uninstall or another program asked.
      onShutdown?.(request.headers['x-caliope-reason'] === 'update' ? 'update' : 'stopped');
      return;
    }
    if (url.pathname === '/auth') {
      if (!useLaunchToken(url.searchParams.get('token') || '')) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('This link is not valid any more. Start Caliope with its launcher.');
        return;
      }
      response.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`,
        Location: `/#key=${apiKey}`,
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    if (url.pathname === '/favicon.svg' || url.pathname === '/icon.svg') {
      serveFile(response, path.join(config.webDir, 'icon.svg'));
      return;
    }
    if (!safeEqual(readCookie(request.headers.cookie, COOKIE) || '', sessionCookie)) {
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 401, { error: 'Not authorized. Start Caliope with its launcher.' });
      } else {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
        response.end('<!doctype html><meta charset="utf-8"><title>Caliope</title><body style="font-family:system-ui;padding:40px;background:#111;color:#eee"><h1>Caliope</h1><p>Open Caliope with its launcher (Caliope.cmd or the desktop shortcut).</p></body>');
      }
      return;
    }
    if (url.pathname.startsWith('/api/') && !safeEqual(request.headers['x-caliope'] || url.searchParams.get('key') || '', apiKey)) {
      sendJson(response, 403, { error: 'Not authorized. Start Caliope with its launcher.' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        sendJson(response, 403, { error: 'Cross-site request refused.' });
        return;
      }
    }
    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write('retry: 2000\n\n');
      hub.add(response);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const match = matchRoute(routes, request.method, url.pathname);
      if (!match) throw new HttpError(404, `No API route for ${request.method} ${url.pathname}.`);
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? await readJsonBody(request) : null;
      const result = await match.handler({ params: match.params, query: url.searchParams, body, request, response });
      if (!response.headersSent && !response.writableEnded) sendJson(response, 200, result ?? { ok: true });
      return;
    }
    serveStatic(url.pathname, response);
  }

  function serveStatic(pathname, response) {
    let root = config.webDir;
    let relative = decodeURIComponent(pathname);
    if (relative.startsWith('/shared/')) {
      root = config.sharedDir;
      relative = relative.slice('/shared'.length);
    }
    if (relative === '/' || relative === '') relative = '/index.html';
    const file = path.resolve(root, `.${relative}`);
    if (!file.startsWith(path.resolve(root) + path.sep)) {
      response.writeHead(400);
      response.end();
      return;
    }
    serveFile(response, file);
  }

  function serveFile(response, file) {
    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Not found');
        return;
      }
      const extension = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[extension] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      if (extension === '.html') {
        headers['Content-Security-Policy'] = CSP;
        headers['Referrer-Policy'] = 'no-referrer';
      }
      response.writeHead(200, headers);
      response.end(data);
    });
  }

  return {
    server,
    createLaunchToken,
    async listen(preferredPort) {
      port = await listenOnFreePort(server, preferredPort);
      return port;
    },
  };
}

function listenOnFreePort(server, preferredPort) {
  // Not 4317 and 4318: OpenTelemetry collectors listen there.
  const candidates = preferredPort ? [preferredPort] : [47380, 47381, 47382, 47383, 47384, 47385, 47386, 47387, 47388, 0];
  return new Promise((resolve, reject) => {
    const tryNext = (index) => {
      if (index >= candidates.length) {
        reject(new Error('No free port for the Caliope server.'));
        return;
      }
      const onError = (error) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') tryNext(index + 1);
        else reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidates[index], '127.0.0.1');
    };
    tryNext(0);
  });
}

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { handler: route.handler, params: match.groups || {} };
  }
  return null;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'The request body is not valid JSON.'));
        return;
      }
      // Every route takes an object. `null` or a list would otherwise fail inside a handler.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) reject(new HttpError(400, 'The request body must be a JSON object.'));
      else resolve(parsed);
    });
    request.on('error', reject);
  });
}

export function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function route(method, pathPattern, handler) {
  const source = pathPattern.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)');
  return { method, pattern: new RegExp(`^${source}$`), handler };
}
