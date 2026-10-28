// Builds the release files in dist/, with the same names for every version:
//   Caliope-windows-x64.zip  the app with Node.js inside (its files at the root of the zip)
//   manifest.json            version, size and SHA-256 of the zip, read by install.ps1 and the update check
//   install.ps1              the one-line installer, with this repository's releases address filled in
// .github/workflows/release.yml runs this for a v<version> tag and publishes the three files (see README.md).
// - runtime\ gets node.exe plus npm and npx from next to it, as the official Node.js download has them, so
//   MCP servers such as "npx -y @azure-devops/mcp" work on a PC without Node.js. A Node.js without npm
//   (such as Codex's) can only build with --no-npm, for a local test build.
// - Node.js may only be passed on with its license text (MIT, plus the licenses of the libraries inside
//   node.exe). It is taken from LICENSE next to node.exe, or from tools/licenses/node-LICENSE.txt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ZIP_NAME = 'Caliope-windows-x64.zip';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version, repository } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releasesUrl = `${repository.url.replace(/\.git$/, '')}/releases`;
const dist = path.join(root, 'dist');
const staging = path.join(dist, 'Caliope');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15)) throw new Error(`Run this with Node.js 22.15 or newer to bundle it (this is ${process.versions.node}).`);
const license = [path.join(path.dirname(process.execPath), 'LICENSE'), path.join(path.dirname(process.execPath), '..', 'LICENSE'), path.join(root, 'tools', 'licenses', 'node-LICENSE.txt')].find((file) => fs.existsSync(file));
if (!license && !process.argv.includes('--no-node-license')) {
  throw new Error('Node.js\'s LICENSE file was not found next to node.exe or in tools/licenses/node-LICENSE.txt. Add it (from https://github.com/nodejs/node/blob/<version>/LICENSE) before passing node.exe on.');
}
const nodeDir = path.dirname(process.execPath);
const withNpm = !process.argv.includes('--no-npm');
if (withNpm && !fs.existsSync(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'))) {
  throw new Error(`npm was not found next to ${process.execPath}. Build with the official Node.js (it has npm and npx), or with --no-npm for a local test build without them.`);
}
// A release tag must match package.json, so the zip, manifest and tag agree, and a public release signs in
// with Caliope's own GitHub OAuth App (README.md, "Before you share Caliope").
if (process.env.GITHUB_REF_TYPE === 'tag') {
  if (process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error(`The tag ${process.env.GITHUB_REF_NAME} does not match version ${version} in package.json.`);
  const { GITHUB_OAUTH_CLIENT_ID } = await import('../server/config.js');
  if (!GITHUB_OAUTH_CLIENT_ID) throw new Error('GITHUB_OAUTH_CLIENT_ID in server/config.js is empty. Register Caliope\'s GitHub OAuth App and fill in its client ID before releasing.');
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const entry of ['server', 'shared', 'web', 'assets', 'Caliope.cmd', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json']) {
  fs.cpSync(path.join(root, entry), path.join(staging, entry), { recursive: true });
}
fs.mkdirSync(path.join(staging, 'runtime'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(staging, 'runtime', 'node.exe'));
if (license) fs.copyFileSync(license, path.join(staging, 'runtime', 'LICENSE.txt'));
fs.writeFileSync(path.join(staging, 'runtime', 'README.txt'), `Node.js ${process.version} (https://nodejs.org), used to run Caliope${withNpm ? ', with npm and npx for MCP servers' : ''}. Its license, including the licenses of the libraries it contains, is in LICENSE.txt. npm's license and those of its dependencies are in node_modules\\npm.\r\n`);
if (withNpm) {
  fs.cpSync(path.join(nodeDir, 'node_modules', 'npm'), path.join(staging, 'runtime', 'node_modules', 'npm'), { recursive: true });
  for (const shim of ['npm.cmd', 'npx.cmd']) fs.copyFileSync(path.join(nodeDir, shim), path.join(staging, 'runtime', shim));
}

// The installer goes into the zip too: Windows' "Uninstall" runs the installed copy with -Uninstall.
const installer = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8').replaceAll('__RELEASES_URL__', releasesUrl);
fs.writeFileSync(path.join(staging, 'install.ps1'), installer);
fs.writeFileSync(path.join(dist, 'install.ps1'), installer);

const zip = path.join(dist, ZIP_NAME);
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${path.join(staging, '*').replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`], { stdio: 'inherit' });
const bytes = fs.readFileSync(zip);
const manifest = { version, files: { [ZIP_NAME]: { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length } } };
fs.writeFileSync(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Release ${version}: ${zip} (${(bytes.length / 1024 / 1024).toFixed(1)} MB), manifest.json, install.ps1`);
