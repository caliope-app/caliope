// DPAPI through node:ffi, with the Node.js that goes into a release. Skipped on an older Node.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callDpapi, protectSecret, runPowerShell, unprotectSecret } from '../server/windows.js';

const skip = process.platform !== 'win32' || Number.parseInt(process.versions.node, 10) < 26 ? 'needs Windows and Node.js 26' : false;

test('a secret survives encrypting and decrypting without PowerShell', { skip }, async () => {
  const encrypted = await protectSecret('gho_José');
  const decrypted = await callDpapi('CryptUnprotectData', Buffer.from(encrypted, 'base64'));
  assert.ok(decrypted, 'This Node.js has no node:ffi, so a release would decrypt with PowerShell again.');
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
