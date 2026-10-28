// Windows integration: DPAPI secrets, the folder picker, Explorer, the app window, and process trees.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/**
 * Run a PowerShell script with text on stdin and return stdout.
 * - Secrets go through stdin, never the command line, which other processes can read.
 * - The script goes as readable text, not -EncodedCommand: security software rightly distrusts hidden
 *   PowerShell that runs base64. Execution policy does not apply to -Command, so no Bypass is needed.
 */
export function runPowerShell(script, { input = '', sta = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
    if (sta) args.push('-STA');
    // UTF-8 both ways: a folder or user name such as "José" must survive stdin and stdout.
    const command = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${script}`;
    args.push('-Command', command);
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error('PowerShell helper timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        resolve(output);
        return;
      }
      // An error from -Command starts with the whole script ("<script> : message") and ends with
      // "+ CategoryInfo" lines. Keep the message.
      const errorText = decodeClixml(Buffer.concat(stderr).toString('utf8')).replace(/\r\n/g, '\n');
      const afterScript = errorText.startsWith(command) ? errorText.slice(command.length).replace(/^\s*:\s*/, '') : errorText;
      const message = afterScript.split(/\n\s*\+ CategoryInfo/)[0].trim();
      reject(new Error(`PowerShell helper failed (exit ${code}): ${message.slice(0, 500)}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

/** PowerShell can write errors as CLIXML (always with -EncodedCommand); turn them back into text. */
export function decodeClixml(text) {
  if (!text.startsWith('#< CLIXML')) return text.trim();
  const messages = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) =>
    match[1]
      .replace(/_x000D_/g, '\r')
      .replace(/_x000A_/g, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'),
  );
  const decoded = messages.join('').trim();
  return decoded;
}

// A PNG (base64 on standard input) onto the Windows clipboard. It stays there after PowerShell exits.
const COPY_IMAGE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$stream = New-Object System.IO.MemoryStream(,$bytes)',
  '$image = [System.Drawing.Image]::FromStream($stream)',
  '[System.Windows.Forms.Clipboard]::SetImage($image)',
].join('\n');

/** Put a PNG image on the Windows clipboard, so the agent's browser can paste it with Control+V. */
export async function copyImageToClipboard(png) {
  await runPowerShell(COPY_IMAGE_SCRIPT, { input: png.toString('base64'), sta: true });
}

// Windows' own PDF renderer (Windows.Data.Pdf), reached from Windows PowerShell 5.1 through WinRT: pages as
// JPEG images, which every model can read, also for scanned PDFs. Input: { path, first, last, width } as JSON.
const RENDER_PDF_SCRIPT = [
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
  '$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]',
  '$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]',
  '$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()',
  "$asTaskResult = $extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
  "$asTaskAction = $extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1",
  'function Wait-Result($operation, [Type]$type) { $task = $asTaskResult.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait() | Out-Null; $task.Result }',
  'function Wait-Action($action) { $asTaskAction.Invoke($null, @($action)).Wait() | Out-Null }',
  '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$file = Wait-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])',
  '$document = Wait-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])',
  '$pages = @()',
  '$last = [Math]::Min([int]$request.last, [int]$document.PageCount)',
  'for ($index = [int]$request.first - 1; $index -lt $last; $index++) {',
  '  $page = $document.GetPage([uint32]$index)',
  '  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream',
  '  $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions',
  '  $options.DestinationWidth = [uint32]$request.width',
  '  $options.BitmapEncoderId = [Windows.Graphics.Imaging.BitmapEncoder]::JpegEncoderId',
  '  Wait-Action ($page.RenderToStreamAsync($stream, $options))',
  '  $rendered = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))',
  '  $memory = New-Object System.IO.MemoryStream',
  '  $rendered.CopyTo($memory)',
  '  $pages += [Convert]::ToBase64String($memory.ToArray())',
  '  $page.Dispose()',
  '  $stream.Dispose()',
  '}',
  '[Console]::Out.Write((@{ pageCount = [int]$document.PageCount; pages = $pages } | ConvertTo-Json -Compress))',
  // Windows PowerShell 5.1 crashes while cleaning up the Windows Runtime objects at its normal exit. Leave directly.
  '[Console]::Out.Flush()',
  '[Environment]::Exit(0)',
].join('\n');

/**
 * Pages `first` to `last` (1-based) of a PDF as JPEG images `width` pixels wide.
 * - Returns { pageCount, pages: [base64] }. Throws when Windows cannot open the file (damaged or password-protected).
 */
export async function renderPdfPages(file, { first, last, width = 1200 }) {
  const output = await runPowerShell(RENDER_PDF_SCRIPT, { input: JSON.stringify({ path: file, first, last, width }), timeoutMs: 180000 });
  const rendered = JSON.parse(output);
  // ConvertTo-Json writes a single page as a string, not a list.
  const pages = Array.isArray(rendered.pages) ? rendered.pages : rendered.pages ? [rendered.pages] : [];
  const result = { pageCount: rendered.pageCount, pages };
  return result;
}

export async function protectSecret(plainText) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$plain = [Console]::In.ReadToEnd()',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)',
    "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($protected))',
  ].join('\n');
  const protectedText = (await runPowerShell(script, { input: plainText })).trim();
  return protectedText;
}

export async function unprotectSecret(protectedBase64) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$encoded = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($encoded)',
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
    '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))',
  ].join('\n');
  const plainText = await runPowerShell(script, { input: protectedBase64 });
  return plainText;
}

/**
 * Show the Windows folder picker and return the chosen folder, or null when cancelled.
 * - A hidden top-most owner form keeps the dialog in front of the app window.
 */
export async function pickFolder(initialFolder) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$initial = [Console]::In.ReadToEnd().Trim()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Choose the project folder for this session'",
    '$dialog.ShowNewFolderButton = $true',
    'if ($initial -and (Test-Path -LiteralPath $initial)) { $dialog.SelectedPath = $initial }',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    "$owner.StartPosition = 'CenterScreen'",
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.Show()',
    '$owner.Activate()',
    '$result = $dialog.ShowDialog($owner)',
    '$owner.Close()',
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ].join('\n');
  const output = (await runPowerShell(script, { input: initialFolder || '', sta: true, timeoutMs: 15 * 60 * 1000 })).trim();
  return output || null;
}

export function revealInExplorer(target) {
  let isFile = false;
  try {
    isFile = fs.statSync(target).isFile();
  } catch {
    // A missing path opens its parent folder below.
  }
  // Explorer only understands /select,"path" with the quotes around the path, so pass it verbatim.
  const folder = fs.existsSync(target) ? target : path.dirname(target);
  const argument = isFile ? `/select,"${target}"` : `"${folder}"`;
  const child = spawn('explorer.exe', [argument], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.unref();
}

/** Open a file with its default Windows program (Explorer avoids cmd.exe quoting rules). */
export function openWithDefaultApp(target) {
  const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Installed Chrome and Edge (Chrome is often installed per user, under LOCALAPPDATA). */
export function findBrowsers() {
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean);
  const first = (relative) => bases.map((base) => path.join(base, relative)).find((candidate) => fs.existsSync(candidate)) || null;
  const browsers = {
    chrome: first(path.join('Google', 'Chrome', 'Application', 'chrome.exe')),
    edge: first(path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')),
  };
  return browsers;
}

const debuggingPolicy = new Map();

/**
 * True when a company policy turns off remote debugging for 'chrome' or 'edge' (RemoteDebuggingAllowed = 0),
 * so the agent cannot drive that browser. Read once per run.
 */
export function remoteDebuggingBlocked(name) {
  if (debuggingPolicy.has(name)) return debuggingPolicy.get(name);
  let blocked = false;
  if (process.platform === 'win32') {
    const key = name === 'edge' ? 'Microsoft\\Edge' : 'Google\\Chrome';
    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const output = execFileSync('reg.exe', ['query', `${hive}\\SOFTWARE\\Policies\\${key}`, '/v', 'RemoteDebuggingAllowed'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        if (/RemoteDebuggingAllowed\s+REG_DWORD\s+0x0\s*$/im.test(output)) blocked = true;
      } catch {
        // The policy is not set.
      }
    }
  }
  debuggingPolicy.set(name, blocked);
  return blocked;
}

/**
 * The browser the agent drives: the chosen one, or the other when policy blocks remote debugging in it.
 * - Returns { name: 'chrome' | 'edge', path }, or { name: null, blocked: [names] } when none can be used.
 */
export function agentBrowser(choice) {
  const { chrome, edge } = findBrowsers();
  const order = choice === 'edge' ? [['edge', edge], ['chrome', chrome]] : [['chrome', chrome], ['edge', edge]];
  const installed = order.filter(([, exe]) => exe);
  const usable = installed.find(([name]) => !remoteDebuggingBlocked(name));
  const result = usable ? { name: usable[0], path: usable[1] } : { name: null, path: null, blocked: installed.map(([name]) => name) };
  return result;
}

/**
 * The browser program for a setting: 'chrome', 'edge', or 'system' (the Windows default browser).
 * - Returns null for 'system'.
 */
export function browserPath(choice) {
  const { chrome, edge } = findBrowsers();
  if (choice === 'edge') return edge || chrome;
  if (choice === 'chrome') return chrome || edge;
  return null;
}

/**
 * Open the app in its own window ("app" mode: no tabs, no address bar) in the chosen browser.
 * - The window has its own browser profile (`profileDir`): extensions in the user's own profile could
 *   otherwise read the app's key from the page. Web links still open in the user's browser (see web/app.js).
 * - With the Windows default browser, it opens as a normal tab.
 */
export function openAppWindow(url, choice, profileDir) {
  const browser = browserPath(choice);
  if (browser) {
    const child = spawn(browser, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--window-size=1440,920', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' });
    child.unref();
    return browser;
  }
  openWithSystemBrowser(url);
  return 'the Windows default browser';
}

/** Open a web link in the chosen browser (a new tab in its normal window) and bring that window to the front. */
export function openUrl(url, choice) {
  const browser = browserPath(choice);
  if (browser) {
    const child = spawn(browser, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    openWithSystemBrowser(url);
  }
  const processNames = browser ? path.basename(browser, '.exe') : 'chrome,msedge,firefox';
  runPowerShell(FOCUS_BROWSER_SCRIPT, { input: processNames, timeoutMs: 20000 }).catch(() => {});
}

// Windows keeps a window that a background program (this server) opens behind the active one. A pressed
// and released Alt key first lets the browser come forward. The app window itself has no " - Google Chrome"
// in its title, so it is never picked.
export const FOCUS_BROWSER_SCRIPT = [
  "Add-Type -Namespace Caliope -Name Window -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
  "'@",
  "$names = [Console]::In.ReadToEnd().Trim() -split ','",
  "$window = $null",
  'for ($i = 0; $i -lt 12 -and -not $window; $i++) {',
  '  Start-Sleep -Milliseconds 250',
  "  $window = Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match ' - (Google Chrome|Microsoft.?Edge|Mozilla Firefox)$' } | Select-Object -First 1",
  '}',
  'if ($window) {',
  '  $handle = $window.MainWindowHandle',
  '  if ([Caliope.Window]::IsIconic($handle)) { [void][Caliope.Window]::ShowWindow($handle, 9) }',
  '  [Caliope.Window]::keybd_event(0x12, 0, 1, [UIntPtr]::Zero)',
  '  [Caliope.Window]::keybd_event(0x12, 0, 3, [UIntPtr]::Zero)',
  '  [void][Caliope.Window]::SetForegroundWindow($handle)',
  '}',
].join('\n');

// One window of a browser process, found by its title, on the screen: the agent's session windows that are out
// of sight are left of every screen, so the one just moved onto it is picked.
const FOCUS_WINDOW_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  'using System; using System.Text; using System.Runtime.InteropServices;',
  'public static class CaliopeFocus {',
  '  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
  '  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
  '  public static bool Focus(uint processId, string title) {',
  '    IntPtr found = IntPtr.Zero;',
  '    EnumWindows((hWnd, unused) => {',
  '      uint owner; GetWindowThreadProcessId(hWnd, out owner);',
  '      if (owner != processId || !IsWindowVisible(hWnd)) return true;',
  '      Rect rect; GetWindowRect(hWnd, out rect);',
  '      var text = new StringBuilder(512); GetWindowText(hWnd, text, 512);',
  '      if (rect.Right <= 0 || !text.ToString().StartsWith(title)) return true;',
  '      found = hWnd;',
  '      return false;',
  '    }, IntPtr.Zero);',
  '    if (found == IntPtr.Zero) return false;',
  '    keybd_event(0x12, 0, 1, UIntPtr.Zero);',
  '    keybd_event(0x12, 0, 3, UIntPtr.Zero);',
  '    return SetForegroundWindow(found);',
  '  }',
  '}',
  "'@",
  '$lines = [Console]::In.ReadToEnd() -split "`n", 2',
  '[CaliopeFocus]::Focus([uint32]$lines[0], $lines[1])',
].join('\n');

/** Bring the window of browser process `processId` whose title starts with `title` to the front (see FOCUS_WINDOW_SCRIPT). */
export async function focusWindow(processId, title) {
  await runPowerShell(FOCUS_WINDOW_SCRIPT, { input: `${processId}\n${String(title).slice(0, 60)}`, timeoutMs: 20000 });
}

function openWithSystemBrowser(url) {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
