// Update check: the version in the latest release's manifest.json, compared with this one.
// - One anonymous request to GitHub when the app starts and every 6 hours while it runs (if "Check for updates"
//   is on), or when the user asks.
// - Updating runs the install line in its own window. The new version then stops this one (see main.js).
// - A copy unzipped by hand is not updated that way (the install line would add a second copy): it gets
//   a link to the release page instead.
import { spawn } from 'node:child_process';

export class UpdateChecker {
  constructor({ releasesUrl, currentVersion, installed, hub, log }) {
    this.releasesUrl = releasesUrl;
    this.currentVersion = currentVersion;
    this.installed = installed;
    this.hub = hub;
    this.log = log;
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
   * Run the install line in a visible PowerShell window, so the user sees the download.
   * - Through the proxy from Settings or HTTPS_PROXY (see proxy.js), which PowerShell does not pick up by itself.
   * - `start: false` only installs. Otherwise the new version starts and stops this one, also a turn that runs.
   */
  install({ start = true } = {}) {
    const run = `& ([scriptblock]::Create((irm '${this.releasesUrl}/latest/download/install.ps1' @web)))${start ? '' : ' -NoStart'}`;
    // On a failure the window stays open, so the user can read why.
    const command = `$web = @{ UseBasicParsing = $true }; if ($env:HTTPS_PROXY) { $web.Proxy = $env:HTTPS_PROXY; $web.ProxyUseDefaultCredentials = $true }; try { ${run} } catch { Write-Host $_ -ForegroundColor Red; Read-Host 'Press Enter to close this window' }`;
    // `start` gives PowerShell a console of its own. Spawned directly, its output and Read-Host would go to NUL.
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "Caliope update" powershell.exe -NoProfile -Command "${command}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.unref();
  }
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
