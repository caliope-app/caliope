// GitHub Copilot sign-in. Two kinds of sign-in record, both sent straight to the Copilot API:
// - "oauth": device sign-in with Caliope's own GitHub OAuth App (config.oauthClientId), as GitHub documents
//   for apps built on Copilot (Copilot SDK). Preferred.
// - "token": a fine-grained personal access token with the "Copilot Requests" permission. This is how
//   GitHub's own Copilot CLI and Copilot SDK authenticate.
import { readJson, writeJsonAtomic, sleep } from './util.js';
import { protectSecret, unprotectSecret } from './windows.js';
import { APP_NAME, APP_VERSION } from './config.js';

export const DEFAULT_API_BASE = 'https://api.githubcopilot.com';

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class AuthManager {
  constructor({ file, config, settings, log, onChange }) {
    this.file = file;
    this.config = config;
    this.settings = settings;
    this.log = log;
    this.onChange = onChange || (() => {});
    // Set by the routes: loads the model list after any successful sign-in (token or device code).
    this.onSignedIn = null;
    this.record = null;
    this.loadError = null;
    this.device = null;
  }

  async load() {
    let stored;
    try {
      stored = await readJson(this.file, null);
    } catch (error) {
      this.log.warn('Sign-in file could not be read.', error);
      this.loadError = 'The saved sign-in could not be read. Sign in again.';
      return;
    }
    if (!stored?.token) return;
    // Versions before 1.0 could sign in with the identity of GitHub's editor plugins ("device").
    if (stored.kind !== 'oauth' && stored.kind !== 'token') {
      this.loadError = 'Caliope now signs in as itself. Sign in with GitHub again.';
      return;
    }
    try {
      const githubToken = stored.token.dpapi ? await unprotectSecret(stored.token.dpapi) : stored.token.plain;
      if (!githubToken) throw new Error('empty token');
      this.record = { kind: stored.kind, githubToken, login: stored.login || null, savedAt: stored.savedAt, remembered: true };
    } catch (error) {
      this.log.warn('Saved token could not be decrypted.', error);
      this.loadError = 'The saved sign-in could not be decrypted for this Windows user. Sign in again.';
    }
  }

  status() {
    const status = {
      signedIn: Boolean(this.record),
      kind: this.record?.kind || null,
      login: this.record?.login || null,
      savedAt: this.record?.savedAt || null,
      remembered: Boolean(this.record?.remembered),
      // True when "remember" was asked but Windows' encryption could not run (restricted PowerShell).
      saveFailed: Boolean(this.record?.saveFailed),
      error: this.record ? null : this.loadError,
      device: this.device
        ? {
            state: this.device.state,
            userCode: this.device.userCode,
            verificationUri: this.device.verificationUri,
            expiresAt: this.device.expiresAt,
            error: this.device.error || null,
          }
        : null,
    };
    return status;
  }

  /**
   * Save a personal access token after checking it against the Copilot API.
   * - `verify(access)` must throw when Copilot rejects the token.
   */
  async signInWithToken(token, verify, { remember = true } = {}) {
    const githubToken = String(token || '').trim();
    if (!/^(github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]+$/.test(githubToken)) {
      throw new AuthError('This does not look like a GitHub token. Fine-grained tokens start with "github_pat_".', 400);
    }
    const record = { kind: 'token', githubToken, login: null, savedAt: new Date().toISOString() };
    const verified = await verify(this.accessFor(record));
    record.login = await this.fetchLogin(githubToken);
    await this.saveRecord(record, remember);
    await this.onSignedIn?.(verified);
    return this.status();
  }

  /** Start GitHub's device sign-in with Caliope's own OAuth App. */
  async startDeviceFlow(verify, { remember = true } = {}) {
    const clientId = this.config.oauthClientId;
    if (!clientId) throw new AuthError('This build of Caliope has no GitHub OAuth App (GITHUB_OAUTH_CLIENT_ID in server/config.js). Use a personal access token instead.', 400);
    this.rememberDevice = remember;
    let response;
    try {
      response = await fetch(`${this.config.githubWeb}/login/device/code`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent() },
        body: new URLSearchParams({ client_id: clientId, scope: 'read:user' }),
      });
    } catch (error) {
      // Node reports only "fetch failed". The reason (proxy, certificate, DNS) is in its cause.
      throw new AuthError(`Could not reach GitHub: ${error.cause?.message || error.message}. Check the proxy in Settings → Network.`, 502);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.device_code) {
      throw new AuthError(`GitHub did not start the device sign-in: ${body.error_description || body.error || response.status}`, 502);
    }
    this.device = {
      state: 'pending',
      clientId,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresAt: Date.now() + (body.expires_in || 900) * 1000,
      interval: body.interval || 5,
      error: null,
    };
    this.onChange();
    this.pollDevice(this.device, verify).catch((error) => {
      this.log.error('Device sign-in failed.', error);
      if (this.device?.deviceCode === body.device_code) {
        this.device.state = 'error';
        this.device.error = error.message;
        this.onChange();
      }
    });
    return this.status();
  }

  cancelDeviceFlow() {
    this.device = null;
    this.onChange();
  }

  async pollDevice(device, verify) {
    let waitSeconds = device.interval;
    while (Date.now() < device.expiresAt) {
      await sleep(waitSeconds * 1000);
      if (this.device !== device) return;
      let body;
      try {
        const response = await fetch(`${this.config.githubWeb}/login/oauth/access_token`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent() },
          body: new URLSearchParams({
            client_id: device.clientId,
            device_code: device.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        body = await response.json().catch(() => ({}));
      } catch (error) {
        // A dropped connection while waiting is not a reason to give up.
        this.log.warn('Device sign-in poll failed; trying again.', error);
        continue;
      }
      if (this.device !== device) return;
      if (body.access_token) {
        const record = { kind: 'oauth', githubToken: body.access_token, login: null, savedAt: new Date().toISOString() };
        const verified = await verify(this.accessFor(record));
        record.login = await this.fetchLogin(body.access_token);
        await this.saveRecord(record, this.rememberDevice !== false);
        await this.onSignedIn?.(verified);
        device.state = 'success';
        this.onChange();
        return;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        waitSeconds = body.interval || waitSeconds + 5;
        continue;
      }
      device.state = 'error';
      device.error = body.error_description || body.error || 'GitHub refused the sign-in.';
      this.onChange();
      return;
    }
    if (this.device === device) {
      device.state = 'error';
      device.error = 'The code expired before it was entered. Start again.';
      this.onChange();
    }
  }

  async signOut() {
    this.record = null;
    this.device = null;
    this.loadError = null;
    await writeJsonAtomic(this.file, {});
    this.onChange();
  }

  /** Base URL and headers for a Copilot API request. */
  async getAccess() {
    if (!this.record) throw new AuthError('Not signed in to GitHub Copilot.');
    const access = this.accessFor(this.record);
    return access;
  }

  /** The GitHub token itself, for GitHub (not Copilot) endpoints such as the allowance. */
  githubCredentials() {
    if (!this.record) return null;
    const credentials = { githubToken: this.record.githubToken };
    return credentials;
  }

  accessFor(record) {
    const access = {
      apiBase: this.apiBase(),
      headers: { Authorization: `Bearer ${record.githubToken}`, 'Copilot-Integration-Id': 'copilot-developer-cli' },
    };
    return access;
  }

  apiBase() {
    const base = this.config.apiBaseOverride || this.settings.get().apiBase || DEFAULT_API_BASE;
    return base.replace(/\/+$/, '');
  }

  async fetchLogin(githubToken) {
    try {
      const response = await fetch(`${this.config.githubApi}/user`, {
        headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': userAgent() },
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body.login || null;
    } catch {
      return null;
    }
  }

  /**
   * Keep the sign-in. With `remember`, the token is saved encrypted for this Windows user (DPAPI).
   * Without it, the token lives in memory only and is gone when the app closes.
   */
  async saveRecord(record, remember = true) {
    let remembered = false;
    if (remember) {
      try {
        const token = this.config.plainSecrets ? { plain: record.githubToken } : { dpapi: await protectSecret(record.githubToken) };
        await writeJsonAtomic(this.file, { kind: record.kind, login: record.login, savedAt: record.savedAt, token });
        remembered = true;
      } catch (error) {
        // The encryption runs through PowerShell. Where a company restricts it (Constrained Language Mode),
        // the sign-in lasts until Caliope closes instead of failing.
        this.log.warn('The sign-in could not be saved encrypted; it lasts until Caliope closes.', error.message);
        record.saveFailed = true;
      }
    }
    if (!remembered) await writeJsonAtomic(this.file, {});
    record.remembered = remembered;
    this.record = record;
    this.loadError = null;
    this.onChange();
  }
}

export function userAgent() {
  return `${APP_NAME}/${APP_VERSION}`;
}
