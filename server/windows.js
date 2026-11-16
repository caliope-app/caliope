// Windows integration: DPAPI secrets, Explorer, the app window, the Startup entry, and process trees.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Windows' own programs run by their full path, so a program of the same name in the current folder or on PATH
// never runs instead.
const WINDOWS_FOLDER = process.env.SystemRoot || 'C:\\Windows';

/** The full path of one of Windows' own programs in System32, such as reg.exe. */
export function systemProgram(name) {
  const program = path.join(WINDOWS_FOLDER, 'System32', name);
  return program;
}

export const POWERSHELL = systemProgram('WindowsPowerShell\\v1.0\\powershell.exe');

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
    const child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

// node:ffi calls Windows functions inside this process, without PowerShell. It comes with Node.js 26.1 and later,
// so with the release zip. Running from source on an older Node.js, it is null.
const ffi = await import('node:ffi').catch(() => null);
let windowsLibraries = null;

// CryptProtectData and CryptUnprotectData take the same arguments.
const DPAPI_SIGNATURE = { return: 'int32', arguments: ['buffer', 'pointer', 'pointer', 'pointer', 'pointer', 'uint32', 'buffer'] };
const CRYPTPROTECT_UI_FORBIDDEN = 1;
const SM_XVIRTUALSCREEN = 76;

/**
 * The Windows functions Caliope calls through node:ffi, loaded once, on first use.
 * - A handle or pointer is a bigint, a BOOL an int32. Text goes in as a Buffer from wideString.
 */
function windowsApi() {
  windowsLibraries ??= {
    crypt32: ffi.dlopen('crypt32.dll', { CryptProtectData: DPAPI_SIGNATURE, CryptUnprotectData: DPAPI_SIGNATURE }),
    kernel32: ffi.dlopen('kernel32.dll', { LocalFree: { return: 'pointer', arguments: ['pointer'] } }),
    user32: ffi.dlopen('user32.dll', {
      FindWindowExW: { return: 'pointer', arguments: ['pointer', 'pointer', 'pointer', 'pointer'] },
      IsWindowVisible: { return: 'int32', arguments: ['pointer'] },
      IsIconic: { return: 'int32', arguments: ['pointer'] },
      GetWindowThreadProcessId: { return: 'uint32', arguments: ['pointer', 'buffer'] },
      GetWindowRect: { return: 'int32', arguments: ['pointer', 'buffer'] },
      GetWindowTextW: { return: 'int32', arguments: ['pointer', 'buffer', 'int32'] },
      ShowWindow: { return: 'int32', arguments: ['pointer', 'int32'] },
      SetForegroundWindow: { return: 'int32', arguments: ['pointer'] },
      keybd_event: { return: 'void', arguments: ['uint8', 'uint8', 'uint32', 'uint64'] },
      GetSystemMetrics: { return: 'int32', arguments: ['int32'] },
      MessageBoxW: { return: 'int32', arguments: ['pointer', 'buffer', 'buffer', 'uint32'] },
    }),
  };
  return windowsLibraries;
}

/** `text` as a NUL-terminated UTF-16 string, for the Windows functions whose name ends in W. */
function wideString(text) {
  // Buffer.alloc gives memory of its own (see callDpapi), and its last two zero bytes are the NUL.
  const buffer = Buffer.alloc((text.length + 1) * 2);
  buffer.write(text, 'utf16le');
  return buffer;
}

/**
 * Encrypt or decrypt a Buffer for this Windows user, inside this process.
 * - `name`: CryptProtectData or CryptUnprotectData. Returns a Buffer.
 * - Throws when this Node.js has no node:ffi (older than 26.1, only when running from source), and when Windows
 *   refuses, for example for data of another Windows user.
 * - Never through PowerShell: security software flags PowerShell that decrypts DPAPI data, because credential
 *   stealers do that. A sign-in that Caliope 1.0.0 to 1.0.2 saved through PowerShell decrypts here too.
 */
export function callDpapi(name, input) {
  if (!ffi) throw new Error('Remembering the sign-in needs Node.js 26.1 or newer, which comes with the Caliope download.');
  const { crypt32, kernel32 } = windowsApi();
  // Buffer.alloc gives memory of its own: a small Buffer.from can share a pool, at an offset.
  const inputBytes = Buffer.alloc(input.length);
  input.copy(inputBytes);
  // A DATA_BLOB on 64-bit Windows: the size at byte 0 and the address at byte 8.
  const inputBlob = Buffer.alloc(16);
  inputBlob.writeUInt32LE(inputBytes.length, 0);
  inputBlob.writeBigUInt64LE(ffi.getRawPointer(inputBytes), 8);
  const outputBlob = Buffer.alloc(16);
  const succeeded = crypt32.functions[name](inputBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outputBlob);
  if (!succeeded) throw new Error(`${name} failed for this Windows user.`);
  const outputAddress = outputBlob.readBigUInt64LE(8);
  // A copy of the bytes, because LocalFree gives Windows' memory back right after.
  const output = ffi.toBuffer(outputAddress, outputBlob.readUInt32LE(0), true);
  kernel32.functions.LocalFree(outputAddress);
  return output;
}

export async function protectSecret(plainText) {
  const encrypted = callDpapi('CryptProtectData', Buffer.from(plainText, 'utf8'));
  const encryptedText = encrypted.toString('base64');
  return encryptedText;
}

export async function unprotectSecret(protectedBase64) {
  const decrypted = callDpapi('CryptUnprotectData', Buffer.from(protectedBase64, 'base64'));
  const decryptedText = decrypted.toString('utf8');
  return decryptedText;
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
  const child = spawn(path.join(WINDOWS_FOLDER, 'explorer.exe'), [argument], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.unref();
}

/** Open a file with its default Windows program (Explorer avoids cmd.exe quoting rules). */
export function openWithDefaultApp(target) {
  const child = spawn(path.join(WINDOWS_FOLDER, 'explorer.exe'), [target], { detached: true, stdio: 'ignore' });
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
        const output = execFileSync(systemProgram('reg.exe'), ['query', `${hive}\\SOFTWARE\\Policies\\${key}`, '/v', 'RemoteDebuggingAllowed'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
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
    const child = spawn(browser, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--start-maximized', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' });
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
  focusBrowser(processNames).catch(() => {});
}

// Windows keeps a window that a background program (this server) opens behind the active one. A pressed
// and released Alt key first lets the browser come forward. The app window itself has no " - Google Chrome"
// in its title, so it is never picked. The script is for a Node.js without node:ffi (see focusBrowser).
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

// The end of a normal browser window's title, per browser program. Edge has a zero-width space in "Microsoft Edge".
const BROWSER_TITLES = { chrome: / - Google Chrome$/, msedge: / - Microsoft.?Edge$/, firefox: / - Mozilla Firefox$/ };

/** Bring the window of `processNames` (comma-separated) to the front once the browser shows it (see above). */
async function focusBrowser(processNames) {
  if (!ffi) {
    await runPowerShell(FOCUS_BROWSER_SCRIPT, { input: processNames, timeoutMs: 20000 });
    return;
  }
  const titleEnds = processNames.split(',').map((name) => BROWSER_TITLES[name]);
  // A browser that was not running yet needs a moment for its window.
  for (let tries = 0; tries < 12; tries++) {
    await sleep(250);
    const window = visibleWindows().find((candidate) => !candidate.outOfSight && titleEnds.some((titleEnd) => titleEnd.test(candidate.title)));
    if (window) {
      bringToFront(window.handle);
      return;
    }
  }
}

/**
 * The visible top-level windows, front first, as { handle, processId, title, outOfSight }.
 * - `outOfSight`: left of every screen and not minimized, as the agent's browser windows that are out of sight.
 */
function visibleWindows() {
  const user32 = windowsApi().user32.functions;
  const screenLeft = user32.GetSystemMetrics(SM_XVIRTUALSCREEN);
  const processId = Buffer.alloc(4);
  const rect = Buffer.alloc(16);
  const text = Buffer.alloc(1024);
  const windows = [];
  // Without a parent, FindWindowExW steps through the top-level windows in Z order. After the last one, it returns 0n.
  for (let handle = user32.FindWindowExW(null, null, null, null); handle; handle = user32.FindWindowExW(null, handle, null, null)) {
    if (!user32.IsWindowVisible(handle)) continue;
    user32.GetWindowThreadProcessId(handle, processId);
    // A RECT holds left, top, right and bottom as 32-bit numbers.
    user32.GetWindowRect(handle, rect);
    const length = user32.GetWindowTextW(handle, text, text.length / 2);
    const outOfSight = rect.readInt32LE(8) <= screenLeft && !user32.IsIconic(handle);
    windows.push({ handle, processId: processId.readUInt32LE(0), title: text.toString('utf16le', 0, length * 2), outOfSight });
  }
  return windows;
}

/** Bring window `handle` to the front, restored when it is minimized. Alt goes first: see FOCUS_BROWSER_SCRIPT. */
function bringToFront(handle) {
  const user32 = windowsApi().user32.functions;
  if (user32.IsIconic(handle)) user32.ShowWindow(handle, 9);
  // Alt (0x12) down, then up (flag 2), as an extended key (flag 1).
  user32.keybd_event(0x12, 0, 1, 0);
  user32.keybd_event(0x12, 0, 3, 0);
  user32.SetForegroundWindow(handle);
}

// One window of a browser process, found by its title, on the screen: the agent's session windows that are out
// of sight are left of every screen, so the one just moved onto it is picked. For a Node.js without node:ffi.
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
  const titleStart = String(title).slice(0, 60);
  if (!ffi) {
    await runPowerShell(FOCUS_WINDOW_SCRIPT, { input: `${processId}\n${titleStart}`, timeoutMs: 20000 });
    return;
  }
  const window = visibleWindows().find((candidate) => candidate.processId === processId && !candidate.outOfSight && candidate.title.startsWith(titleStart));
  if (window) bringToFront(window.handle);
}

/** The left edge of the leftmost screen in pixels: 0, or below 0 with a screen left of the main one. */
export async function virtualScreenLeft() {
  if (ffi) {
    const left = windowsApi().user32.functions.GetSystemMetrics(SM_XVIRTUALSCREEN);
    return left;
  }
  const output = await runPowerShell('Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SystemInformation]::VirtualScreen.Left', { timeoutMs: 20000 });
  const left = Number(output.trim());
  return left;
}

/**
 * Show `message` in a Windows message box with an error icon, and wait until it is closed.
 * - Through node:ffi, this whole process waits meanwhile: only for errors before Caliope exits.
 */
export async function showErrorBox(message) {
  if (ffi) {
    // MB_ICONERROR, MB_SETFOREGROUND and MB_TOPMOST: the server has no window that the box could open in front of.
    windowsApi().user32.functions.MessageBoxW(null, wideString(message), wideString('Caliope'), 0x10 | 0x10000 | 0x40000);
    return;
  }
  const script = [
    'Add-Type -AssemblyName PresentationFramework',
    '$text = [Console]::In.ReadToEnd()',
    "[void][System.Windows.MessageBox]::Show($text, 'Caliope', 'OK', 'Error')",
  ].join('\n');
  await runPowerShell(script, { input: message, timeoutMs: 10 * 60 * 1000 });
}

/**
 * Remove the "from the internet" mark (a Zone.Identifier stream) from every file in `folder`.
 * - Files from a downloaded zip carry it, so Windows warns before every start of Caliope.cmd. Only while
 *   Caliope.cmd has it, so normally nothing is done.
 * - Caliope.cmd's mark goes last: when another file fails, the next start tries the rest again.
 */
export function removeDownloadMarks(folder) {
  const launcher = path.join(folder, 'Caliope.cmd');
  if (!fs.existsSync(`${launcher}:Zone.Identifier`)) return;
  for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && file !== launcher) fs.rmSync(`${file}:Zone.Identifier`, { force: true });
  }
  fs.rmSync(`${launcher}:Zone.Identifier`, { force: true });
}

/**
 * Start Caliope at sign-in without a window, or stop doing so: a .cmd in the user's Startup folder that calls `launcher`.
 * - No PowerShell and no registry. Task Manager lists it under Startup apps. The uninstall removes the installed copy's entry.
 * - cmd.exe reads a .cmd file in the console's code page, not as UTF-8, so a user folder such as C:\Users\Zoë would
 *   break the path. The installed launcher is written as %LOCALAPPDATA%\..., in plain ASCII. The entry of an unzipped
 *   copy first switches the code page to UTF-8.
 * - `enabled` false removes only this copy's entry: one that another copy of Caliope wrote stays.
 */
export function setStartAtSignIn(enabled, launcher) {
  const entry = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Caliope.cmd');
  const installedLauncher = path.join(process.env.LOCALAPPDATA, 'Programs', 'Caliope', 'Caliope.cmd');
  const content = launcher.toLowerCase() === installedLauncher.toLowerCase() ? '@call "%LOCALAPPDATA%\\Programs\\Caliope\\Caliope.cmd" --background\r\n' : `@chcp 65001>nul\r\n@call "${launcher}" --background\r\n`;
  if (enabled) fs.writeFileSync(entry, content);
  else if (fs.existsSync(entry) && fs.readFileSync(entry, 'utf8') === content) fs.rmSync(entry, { force: true });
}

function openWithSystemBrowser(url) {
  const child = spawn(systemProgram('rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(systemProgram('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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
