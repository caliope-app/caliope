// Updates: the version in the latest release's manifest.json, compared with this one, and installing it.
// - One anonymous request to GitHub when the app starts and every 6 hours while it runs (if "Check for updates"
//   is on), or when the user asks.
// - Installing runs inside Caliope's own node.exe, without PowerShell. It downloads manifest.json and its signature
//   (manifest.json.sig) and checks the signature against RELEASE_PUBLIC_KEY in config.js. Then it downloads the zip
//   and checks it against the SHA-256 in that manifest. Windows' own tar.exe unpacks the zip into a new version
//   folder next to this one (the layout install.ps1 makes), and the launcher then points at that folder. The files
//   of the running version stay as they are, so its node.exe can keep running.
// - The new version starts once nothing runs here any more, and stops this one (see main.js).
// - A copy unzipped by hand is not updated that way (it has no launcher next to the version folders): it gets
//   a link to the release page instead.
// - install.ps1 stays the first install, and the way Caliope 1.0.4 and older update.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileAtomic, sha256, sleep } from './util.js';
import { systemProgram } from './windows.js';

const ZIP_NAME = 'Caliope-windows-x64.zip';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Caliope';
const TAR = systemProgram('tar.exe');
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const START_CHECK_MS = 5000;
const execFileAsync = promisify(execFile);

export class UpdateChecker {
  /**
   * - `root`: the folder with the launcher and the version folders (%LOCALAPPDATA%\Programs\Caliope), when `installed`.
   * - `isBusy()`: true while a turn, a question or a background command runs; the new version waits for it.
   */
  constructor({ releasesUrl, currentVersion, installed, root, publicKey, isBusy, hub, log }) {
    this.releasesUrl = releasesUrl;
    this.currentVersion = currentVersion;
    this.installed = installed;
    this.root = root;
    this.publicKey = publicKey;
    this.isBusy = isBusy;
    this.hub = hub;
    this.log = log;
    this.installing = null;
    this.startTimer = null;
    this.startInBackground = false;
    this.status = { current: currentVersion, latest: null, available: false, installed, downloadUrl: `${releasesUrl}/latest`, checkedAt: null, error: null };
  }

  async check() {
    try {
      const response = await fetch(`${this.releasesUrl}/latest/download/manifest.json`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
      const latest = String((await response.json()).version || '');
      this.status = { ...this.status, latest, available: isNewerVersion(latest, this.currentVersion), checkedAt: new Date().toISOString(), error: null };
    } catch (error) {
      this.log.warn('The update check failed.', error.message);
      this.status = { ...this.status, checkedAt: new Date().toISOString(), error: error.message };
    }
    this.hub.broadcast({ type: 'update', update: this.status });
    return this.status;
  }

  /**
   * Install the latest release next to this version. Returns its version.
   * - `start: false` only installs: the new version runs from the next start. Otherwise it starts once nothing
   *   runs here any more, and then stops this one.
   * - Throws a message for the user when a download or a check fails. The installed versions stay as they were.
   */
  async install({ start = true } = {}) {
    // A second click while the download runs waits for the same download.
    this.installing ??= this.installLatest().finally(() => {
      this.installing = null;
    });
    const version = await this.installing;
    if (start) this.startWhenIdle();
    return version;
  }

  /**
   * The steps of install, the same as install.ps1 takes. Returns the new version.
   * - Checks manifest.json against its signature, and refuses a release that is not newer than this version.
   * - Downloads, checks and unpacks its zip, unless that version folder is already complete.
   * - Copies the icon and the uninstaller next to the launcher, and shows the version in Settings > Apps.
   * - Points the launcher at the new version, then removes old versions.
   */
  async installLatest() {
    const latest = `${this.releasesUrl}/latest/download`;
    const manifestBytes = await download(`${latest}/manifest.json`);
    const signature = await download(`${latest}/manifest.json.sig`);
    const manifest = verifyManifest(manifestBytes, signature, this.publicKey);
    // Also refuses an older signed manifest that someone serves again.
    if (!isNewerVersion(manifest.version, this.currentVersion)) throw new Error(`The latest release (${manifest.version}) is not newer than this version (${this.currentVersion}).`);
    const target = path.join(this.root, manifest.version);
    if (!fs.existsSync(path.join(target, 'Caliope.cmd'))) {
      // The zip of the release the signed manifest names, also when a newer release appeared meanwhile.
      const zipBytes = await download(`${this.releasesUrl}/download/v${manifest.version}/${ZIP_NAME}`);
      verifyZip(zipBytes, manifest);
      await unpack(zipBytes, path.join(this.root, 'Caliope-windows-x64.download.zip'), target);
    }
    // As install.ps1 does: the icon, the uninstaller and the Settings > Apps entry stay in place across updates.
    fs.copyFileSync(path.join(target, 'assets', 'Caliope.ico'), path.join(this.root, 'Caliope.ico'));
    fs.copyFileSync(path.join(target, 'install.ps1'), path.join(this.root, 'install.ps1'));
    // The entry belongs to the install in %LOCALAPPDATA%\Programs\Caliope. It only shows the version, so a failure
    // goes to the log and the update goes on.
    if (this.root.toLowerCase() === path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Caliope').toLowerCase()) {
      await execFileAsync(systemProgram('reg.exe'), ['add', UNINSTALL_KEY, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', manifest.version, '/f'], { windowsHide: true, timeout: 10000 }).catch((error) => {
        this.log.warn('Could not show the new version in Settings > Apps.', error.message);
      });
    }
    // The switch: the Start menu shortcut runs this launcher, which now calls the new version.
    await writeFileAtomic(path.join(this.root, 'Caliope.cmd'), `@call "%~dp0${manifest.version}\\Caliope.cmd" %*\r\n`);
    this.log.info(`Installed Caliope ${manifest.version} in ${target}.`);
    this.removeOldVersions();
    return manifest.version;
  }

  /**
   * Keep the newest two versions. A version whose node.exe still runs is left alone (deleting the rest would remove
   * its web files while it serves them): a later update removes it.
   */
  removeOldVersions() {
    const versions = fs.readdirSync(this.root).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => (isNewerVersion(a, b) ? -1 : 1));
    for (const name of versions.slice(2)) {
      const folder = path.join(this.root, name);
      if (versionRuns(folder)) continue;
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch (error) {
        this.log.warn(`Could not remove the old version folder ${folder}.`, error.message);
      }
    }
  }

  /**
   * Start the launcher once no turn, question or background command runs here. The new version then stops this one.
   * - `background`: the new version starts without a window (--background), and only once no window is open here.
   *   A start with a window, which the user asked for, wins over one in the background.
   */
  startWhenIdle({ background = false } = {}) {
    this.startInBackground = this.startTimer ? this.startInBackground && background : background;
    if (this.startTimer) return;
    const startIfIdle = () => {
      if (this.isBusy() || (this.startInBackground && this.hub.clientCount > 0)) return;
      clearInterval(this.startTimer);
      this.startTimer = null;
      const launcher = path.join(this.root, 'Caliope.cmd');
      // With /s, cmd keeps the quotes around the launcher's path, also when the user folder has spaces or brackets.
      const command = `""${launcher}"${this.startInBackground ? ' --background' : ''}"`;
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
      child.on('error', (error) => this.log.warn('Could not start the new version.', error.message));
      child.unref();
    };
    this.startTimer = setInterval(startIfIdle, START_CHECK_MS);
    startIfIdle();
  }
}

/**
 * Check manifest.json against its signature and return its content.
 * - `signature`: the base64 text of manifest.json.sig. The release workflow makes it with the private key that
 *   belongs to `publicKey` (RELEASE_PUBLIC_KEY in config.js).
 * - Throws when the signature is missing or does not match: then the manifest does not come from Caliope's release.
 */
export function verifyManifest(manifestBytes, signature, publicKey) {
  const signatureBytes = Buffer.from(String(signature || '').trim(), 'base64');
  if (signatureBytes.length === 0) throw new Error('The release has no signature for manifest.json, so Caliope does not install it.');
  if (!crypto.verify(null, manifestBytes, publicKey, signatureBytes)) throw new Error('The signature of the release does not match Caliope\'s key, so Caliope does not install it.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  return manifest;
}

/** Check the downloaded zip against the SHA-256 in the (checked) manifest. Throws when it differs. */
export function verifyZip(zipBytes, manifest) {
  if (sha256(zipBytes) !== manifest.files?.[ZIP_NAME]?.sha256) throw new Error('The download is damaged: its checksum does not match the release. Try the update again.');
}

/** True when version `candidate` ("1.2.0") is newer than `current`. */
export function isNewerVersion(candidate, current) {
  const parse = (version) => String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${url}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes;
}

/**
 * Unpack the zip into the version folder `target` with Windows' own tar.exe.
 * - It unpacks into a folder next to `target` and then renames that, so a version folder is never half full.
 * - A `target` that a failed update left behind is removed first.
 * - Right after tar wrote the files, Windows can refuse the rename for a while, for example while antivirus
 *   software still scans them. It tries again for up to 30 seconds, as install.ps1 does.
 */
async function unpack(zipBytes, zipFile, target) {
  const staging = `${target}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(zipFile, zipBytes);
  try {
    await execFileAsync(TAR, ['-xf', zipFile, '-C', staging], { windowsHide: true, timeout: DOWNLOAD_TIMEOUT_MS });
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
  fs.rmSync(target, { recursive: true, force: true });
  for (let tries = 1; ; tries++) {
    try {
      fs.renameSync(staging, target);
      return;
    } catch (error) {
      if (tries === 60) throw error;
      await sleep(500);
    }
  }
}

/** True while a node.exe of this version folder runs: Windows does not open a running program for writing. */
function versionRuns(folder) {
  try {
    fs.closeSync(fs.openSync(path.join(folder, 'runtime', 'node.exe'), 'r+'));
    return false;
  } catch (error) {
    return error.code === 'EBUSY';
  }
}
