// The proxy: Caliope's own requests, the programs it starts, and its own address on 127.0.0.1.
// A file of its own, because applying a proxy changes the whole test process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { applyProxy, validateProxyUrl, parseInternetSettings } from '../server/proxy.js';
import { commandEnvironment } from '../server/tools/shell.js';

// A proxy that serves one made-up host from the origin server, and refuses everything else. It tunnels
// https://. A plain http:// request comes in whole on Node.js 26 and as a tunnel on older versions.
const seen = [];
const origin = http.createServer((request, response) => response.end(`origin ${request.url}`));
const proxy = http.createServer((request, response) => {
  seen.push(`GET ${request.url}`);
  if (!request.url.startsWith('http://copilot.caliope.test/')) {
    response.writeHead(403);
    response.end();
    return;
  }
  response.end(`origin ${new URL(request.url).pathname}`);
});
proxy.on('connect', (request, socket, head) => {
  seen.push(`CONNECT ${request.url}`);
  if (!request.url.startsWith('copilot.caliope.test:')) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
});

test.before(async () => {
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
});

test.after(() => {
  applyProxy({});
  origin.close();
  proxy.close();
});

test('the proxy from Settings carries Caliope\'s requests and those of the programs it starts; 127.0.0.1 stays direct', async () => {
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  assert.deepEqual(applyProxy({ proxy: proxyUrl, noProxy: '.company.local' }), { source: 'settings', url: proxyUrl, unsupported: false });
  assert.equal(await (await fetch('http://copilot.caliope.test/models')).text(), 'origin /models');
  assert.equal(await (await fetch(`http://127.0.0.1:${origin.address().port}/direct`)).text(), 'origin /direct');
  assert.equal(seen.length, 1, 'the request to 127.0.0.1 did not go through the proxy');
  assert.match(seen[0], /copilot\.caliope\.test/);
  // Caliope's own requests are https:// and go through a tunnel. The test origin has no TLS, so this one fails.
  await assert.rejects(fetch('https://copilot.caliope.test/secure'));
  assert.equal(seen.at(-1), 'CONNECT copilot.caliope.test:443');

  const env = commandEnvironment([]);
  assert.equal(env.HTTPS_PROXY, proxyUrl);
  assert.match(env.NO_PROXY, /^\.company\.local,.*localhost,127\.0\.0\.1,::1$/);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.NODE_USE_SYSTEM_CA, '1');
  // A Node.js program Caliope starts (such as an npx MCP server) uses it too.
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', "fetch('http://copilot.caliope.test/child').then((r) => r.text()).then(console.log)"], { env }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  });
  assert.equal(output, 'origin /child');

  // Without a proxy in Settings, the environment as Caliope started applies again (here: none).
  assert.deepEqual(applyProxy({}), { source: null, url: null, unsupported: false });
  assert.equal(process.env.HTTPS_PROXY, undefined);
  await assert.rejects(fetch('http://copilot.caliope.test/after'), 'no proxy: the made-up host does not resolve');
});

test('proxy addresses in Settings', () => {
  assert.equal(validateProxyUrl(''), '');
  assert.equal(validateProxyUrl(' proxy.company.com:8080 '), 'http://proxy.company.com:8080');
  assert.equal(validateProxyUrl('https://proxy:3128/'), 'https://proxy:3128');
  assert.throws(() => validateProxyUrl('http://me:secret@proxy:8080'), /does not store proxy passwords/);
  assert.throws(() => validateProxyUrl('socks5://proxy:1080'), /http:\/\/ or https:\/\//);
});

test('the Windows proxy, read from Internet Settings', () => {
  const settings = (lines) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n${lines.map((line) => `    ${line}`).join('\r\n')}\r\n`;
  assert.deepEqual(parseInternetSettings(settings(['ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    proxy.corp:8080', 'ProxyOverride    REG_SZ    *.corp.local;<local>'])), { proxy: 'http://proxy.corp:8080', bypass: '*.corp.local', script: null });
  assert.equal(parseInternetSettings(settings(['ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    http=web:80;https=secure:3128;ftp=f:21'])).proxy, 'http://secure:3128');
  assert.deepEqual(parseInternetSettings(settings(['ProxyEnable    REG_DWORD    0x0', 'ProxyServer    REG_SZ    old:8080', 'AutoConfigURL    REG_SZ    http://wpad.corp/proxy.pac'])), { proxy: null, bypass: null, script: 'http://wpad.corp/proxy.pac' });
});
