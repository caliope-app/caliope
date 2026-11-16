// Windows without PowerShell: DPAPI and window lookups through node:ffi, with the Node.js that goes into a release
// (skipped on an older Node.js), the sign-in on a Node.js without node:ffi, the "from the internet" mark, and the
// Startup entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callDpapi, focusWindow, protectSecret, removeDownloadMarks, runPowerShell, setStartAtSignIn, unprotectSecret, virtualScreenLeft } from '../server/windows.js';
import { AuthManager } from '../server/auth.js';

const skip = process.platform !== 'win32' || Number.parseInt(process.versions.node, 10) < 26 ? 'needs Windows and Node.js 26' : false;
const hasFfi = Boolean(await import('node:ffi').catch(() => null));

test('a secret survives encrypting and decrypting without PowerShell', { skip }, async () => {
  const encrypted = await protectSecret('gho_José');
  const decrypted = callDpapi('CryptUnprotectData', Buffer.from(encrypted, 'base64'));
  assert.equal(decrypted.toString('utf8'), 'gho_José');
});

test('a sign-in saved by an older version through PowerShell still decrypts', { skip }, async () => {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())',
    "[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')))",
  ].join('\n');
  const savedToken = await runPowerShell(script, { input: 'gho_saved' });
  assert.equal(await unprotectSecret(savedToken), 'gho_saved');
});

test('data that Windows cannot decrypt fails, without a second try through PowerShell', { skip }, async () => {
  const notEncrypted = Buffer.from('not encrypted').toString('base64');
  await assert.rejects(unprotectSecret(notEncrypted), /CryptUnprotectData failed/);
});

test('window lookups and the screen edge work through node:ffi', { skip }, async () => {
  // No window of this test process has that title: nothing comes to the front, and nothing throws.
  await focusWindow(process.pid, 'Caliope test: no such window');
  assert.ok(Number.isInteger(await virtualScreenLeft()));
});

test('without node:ffi, a remembered sign-in lasts until Caliope closes and says which Node.js it needs', { skip: hasFfi ? 'this Node.js has node:ffi' : false }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-auth-'));
  const file = path.join(folder, 'auth.json');
  const options = { file, config: { plainSecrets: false }, settings: { get: () => ({}) }, log: { info() {}, warn() {}, error() {} } };
  try {
    const auth = new AuthManager(options);
    await auth.saveRecord({ kind: 'oauth', githubToken: 'gho_memory', login: 'someone', savedAt: new Date().toISOString() }, true);
    assert.equal(auth.status().signedIn, true);
    assert.equal(auth.status().remembered, false);
    assert.match(auth.status().saveFailed, /needs Node\.js 26\.1 or newer/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'nothing is saved, also not through PowerShell');

    // A sign-in that the release saved can't be read here, and the message says why.
    fs.writeFileSync(file, JSON.stringify({ kind: 'oauth', login: 'someone', token: { dpapi: 'AQAAANCMnd8BFdERjHoAwE' } }));
    const reloaded = new AuthManager(options);
    await reloaded.load();
    assert.equal(reloaded.status().signedIn, false);
    assert.match(reloaded.status().error, /needs Node\.js 26\.1 or newer/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the "from the internet" mark of an unzipped download is removed from every file', { skip: process.platform !== 'win32' ? 'needs Windows' : false }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-mark-'));
  const launcher = path.join(folder, 'Caliope.cmd');
  const nested = path.join(folder, 'server', 'main.js');
  const mark = '[ZoneTransfer]\r\nZoneId=3\r\n';
  try {
    fs.mkdirSync(path.dirname(nested));
    for (const file of [launcher, nested]) {
      fs.writeFileSync(file, 'content');
      fs.writeFileSync(`${file}:Zone.Identifier`, mark);
    }
    removeDownloadMarks(folder);
    for (const file of [launcher, nested]) {
      assert.equal(fs.existsSync(`${file}:Zone.Identifier`), false, `${file} still has the mark`);
      assert.equal(fs.readFileSync(file, 'utf8'), 'content');
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the Startup entry starts the launcher, also from a user folder with ë in its name', { skip: process.platform !== 'win32' ? 'needs Windows' : false }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-startup-'));
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  // A stand-in for the user folder C:\Users\Zoë.
  const home = path.join(folder, 'Zoë');
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  const entry = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Caliope.cmd');
  const installed = path.join(process.env.LOCALAPPDATA, 'Programs', 'Caliope', 'Caliope.cmd');
  const unzipped = path.join(home, 'Downloads', 'Caliope', 'Caliope.cmd');
  try {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    for (const launcher of [installed, unzipped]) {
      // A launcher that writes its arguments to a file next to it.
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.writeFileSync(launcher, '@echo %*> "%~dp0started.txt"\r\n');
      setStartAtSignIn(true, launcher);
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', entry], { windowsHide: true });
      assert.equal(fs.readFileSync(path.join(path.dirname(launcher), 'started.txt'), 'utf8').trim(), '--background', launcher);
    }
    assert.equal(fs.readFileSync(entry, 'utf8'), `@chcp 65001>nul\r\n@call "${unzipped}" --background\r\n`);
    // Off in the installed copy leaves the entry of the unzipped one. The unzipped copy removes its own.
    setStartAtSignIn(false, installed);
    assert.ok(fs.existsSync(entry));
    setStartAtSignIn(false, unzipped);
    assert.ok(!fs.existsSync(entry));
    setStartAtSignIn(true, installed);
    assert.equal(fs.readFileSync(entry, 'utf8'), '@call "%LOCALAPPDATA%\\Programs\\Caliope\\Caliope.cmd" --background\r\n', 'the installed launcher in plain ASCII');
  } finally {
    Object.assign(process.env, saved);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
