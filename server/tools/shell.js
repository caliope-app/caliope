// run_command: PowerShell (default) or cmd.exe, without a console, with a timeout and live output.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { newId, stripAnsi, truncateMiddle, formatDuration } from '../util.js';
import { killProcessTree, POWERSHELL } from '../windows.js';
import { resolvePath, displayPath } from './paths.js';
import { ToolInputError } from './fs-tools.js';

const MAX_RESULT_CHARS = 30000;
const HEAD_KEEP = 200000;
const TAIL_KEEP = 800000;
// How long a command's output may stay open after the command ended or was stopped (see runShellCommand).
const OUTPUT_GRACE_MS = 2000;

// The script is kept in a temporary .ps1 file and run as a script block (see shellInvocation): PowerShell
// then reports errors as plain text (with -EncodedCommand it writes them as CLIXML), `exit` passes the
// native exit code through, and a company's execution policy (AllSigned) does not block it, as it would -File.
const POWERSHELL_PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  '',
].join('\r\n');

// After the command: a native program's exit code, else 1 when the last statement failed (a cmdlet
// error such as a missing file), so a failed command never reports exit code 0.
const POWERSHELL_EPILOGUE = ['', '$caliopeLastOk = $?', 'if ($LASTEXITCODE) { exit $LASTEXITCODE }', 'if (-not $caliopeLastOk) { exit 1 }', 'exit 0', ''].join('\r\n');

/** Environment for agent commands: extra PATH folders first, no pagers or prompts. */
export function commandEnvironment(extraPath) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  if (extraPath.length > 0) env[pathKey] = [...extraPath, env[pathKey] || ''].join(path.delimiter);
  // cmd.exe and Windows otherwise look for a program in the current folder first, so a repository's own
  // npx.cmd or git.bat would run instead of the real one (also for allowed commands, hooks and MCP servers).
  env.NoDefaultCurrentDirectoryInExePath = '1';
  // Node.js programs (npx MCP servers, the project's own scripts) trust the Windows certificate store, as
  // Caliope does, so a company's TLS inspection does not break them.
  env.NODE_USE_SYSTEM_CA = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.NO_COLOR = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  return env;
}

let constrainedCheck = null;

/**
 * Whether Windows PowerShell runs in Constrained Language Mode on this PC (a company policy such as AppLocker).
 * - Checked once per server start; later calls get the same answer.
 * - In that mode PowerShell cannot run the script block that shellInvocation builds, so commands run in cmd.exe.
 */
export function powershellConstrained() {
  constrainedCheck ??= new Promise((resolve) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ExecutionContext.SessionState.LanguageMode'];
    execFile(POWERSHELL, args, { windowsHide: true, timeout: 20000 }, (error, stdout) => resolve(String(stdout).trim() === 'ConstrainedLanguage'));
  });
  return constrainedCheck;
}

/**
 * The shell commands really run in for the chosen `shell` ('powershell' or 'cmd'): 'cmd' when chosen, and
 * also when PowerShell is in Constrained Language Mode (see powershellConstrained).
 */
export async function effectiveShell(shell) {
  const runsInCmd = shell === 'cmd' || (await powershellConstrained());
  const used = runsInCmd ? 'cmd' : shell;
  return used;
}

/**
 * The program, arguments and spawn options that run `command` in the chosen shell (PowerShell runs a temporary script).
 * - cmd.exe also runs the commands when PowerShell is in Constrained Language Mode (see effectiveShell).
 * - `stdin`: true to keep standard input open for the caller.
 */
async function shellInvocation({ command, cwd, shell, extraPath, tmpDir, stdin = false }) {
  const spawnOptions = { cwd, env: commandEnvironment(extraPath), windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] };
  if ((await effectiveShell(shell)) === 'cmd') {
    spawnOptions.windowsVerbatimArguments = true;
    const invocation = { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"chcp 65001 >nul & ${command}"`], spawnOptions, scriptFile: null };
    return invocation;
  }
  await fsp.mkdir(tmpDir, { recursive: true });
  const scriptFile = path.join(tmpDir, `c-${newId()}.ps1`);
  await fsp.writeFile(scriptFile, `﻿${POWERSHELL_PRELUDE}${command}${POWERSHELL_EPILOGUE}`, 'utf8');
  const runScript = `& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(scriptFile)})))`;
  const invocation = { exe: POWERSHELL, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', runScript], spawnOptions, scriptFile };
  return invocation;
}

/**
 * Run one command and collect its output.
 * - `onOutput(text)` receives output as it arrives. The result keeps the start and the end of long output.
 * - `input` is written to the command's standard input, which is then closed. Without it there is no
 *   standard input, so anything waiting for input ends instead of hanging.
 */
export async function runShellCommand({ command, cwd, shell, timeoutMs, extraPath, tmpDir, signal, onOutput, input = null }) {
  const { exe, args, spawnOptions, scriptFile } = await shellInvocation({ command, cwd, shell, extraPath, tmpDir, stdin: input !== null });

  const started = Date.now();
  let head = '';
  let tail = '';
  let dropped = 0;
  function append(text) {
    if (!text) return;
    onOutput?.(text);
    if (head.length < HEAD_KEEP) {
      const room = HEAD_KEEP - head.length;
      head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    tail += text;
    if (tail.length > TAIL_KEEP) {
      dropped += tail.length - TAIL_KEEP;
      tail = tail.slice(tail.length - TAIL_KEEP);
    }
  }

  const result = await new Promise((resolve) => {
    // Stopped while the script was being written: don't start it.
    if (signal?.aborted) {
      resolve({ exitCode: null, timedOut: false, interrupted: true });
      return;
    }
    let child;
    try {
      child = spawn(exe, args, spawnOptions);
    } catch (error) {
      resolve({ spawnError: error });
      return;
    }
    let timedOut = false;
    let interrupted = false;
    let graceTimer = null;
    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');
    child.stdout.on('data', (chunk) => append(stdoutDecoder.decode(chunk, { stream: true })));
    child.stderr.on('data', (chunk) => append(stderrDecoder.decode(chunk, { stream: true })));
    if (input !== null) {
      // The command may end without reading all of its input.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const finish = (outcome) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      append(stdoutDecoder.decode());
      append(stderrDecoder.decode());
      resolve(outcome);
    };
    // A program the command started can keep its output open after the command itself ended (cmd's `start /b`),
    // and taskkill /T misses that program once its parent is gone. So after the command ends or is stopped,
    // Caliope waits a moment for the output to close, then stops reading it. That program keeps running.
    const stopReading = () => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: child.exitCode, timedOut, interrupted });
      }, OUTPUT_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      stopReading();
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      killProcessTree(child.pid);
      stopReading();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish({ spawnError: error }));
    // The command ended, so its time limit no longer applies.
    child.on('exit', () => {
      clearTimeout(timer);
      stopReading();
    });
    child.on('close', (code) => finish({ exitCode: code, timedOut, interrupted }));
  });
  if (scriptFile) fs.rm(scriptFile, { force: true }, () => {});
  if (result.spawnError) throw new ToolInputError(`Could not start ${exe}: ${result.spawnError.message}`);

  let output = head + (dropped > 0 ? `\n… [${dropped} characters omitted] …\n` : '') + tail;
  output = stripAnsi(output);
  if (scriptFile) output = output.split(scriptFile).join('<command>');
  const durationMs = Date.now() - started;
  return { ...result, output, durationMs };
}

/**
 * A PowerShell single-quoted string.
 * - PowerShell also ends a single-quoted string at the typographic quotes ‘ ’ ‚ ‛, so those are doubled
 *   too. Otherwise a file name such as x’;calc;’.py would run calc.
 */
export function psQuote(text) {
  const quoted = `'${String(text).replace(/['‘’‚‛]/g, '$&$&')}'`;
  return quoted;
}

const JOB_OUTPUT_KEEP = 400000;
const JOB_FIRST_WAIT_MS = 3000;

/**
 * Start a command that keeps running (a dev server, a watcher) and keep its output in memory.
 * - Returns the job. Read new output with readJobOutput, stop it with stopJob.
 * - `onExit` runs once the process has ended.
 */
export async function startBackgroundJob({ command, cwd, shell, extraPath, tmpDir, onExit }) {
  const { exe, args, spawnOptions, scriptFile } = await shellInvocation({ command, cwd, shell, extraPath, tmpDir });
  const child = spawn(exe, args, spawnOptions);
  // `produced` counts every character so far. `readUpTo` is where the agent's last read ended.
  const job = { id: newId('job'), command, pid: child.pid, child, running: true, exitCode: null, output: '', produced: 0, readUpTo: 0 };
  const append = (text) => {
    if (!text) return;
    job.output += text;
    job.produced += text.length;
    if (job.output.length > JOB_OUTPUT_KEEP) job.output = job.output.slice(job.output.length - JOB_OUTPUT_KEEP);
  };
  const stdoutDecoder = new TextDecoder('utf-8');
  const stderrDecoder = new TextDecoder('utf-8');
  child.stdout.on('data', (chunk) => append(stdoutDecoder.decode(chunk, { stream: true })));
  child.stderr.on('data', (chunk) => append(stderrDecoder.decode(chunk, { stream: true })));
  const finish = (exitCode, error) => {
    if (!job.running) return;
    append(stdoutDecoder.decode() + stderrDecoder.decode());
    if (error) append(`\nCould not start ${exe}: ${error.message}\n`);
    job.running = false;
    job.exitCode = exitCode;
    if (scriptFile) fs.rm(scriptFile, { force: true }, () => {});
    onExit?.(job);
  };
  child.on('error', (error) => finish(null, error));
  child.on('close', (code) => finish(code));
  return job;
}

/**
 * Stop a background job.
 * - As in runShellCommand: a program the job started can keep its output open after taskkill ended the job, so
 *   Caliope stops reading after a moment. The job then ends. That program keeps running.
 */
export function stopJob(job) {
  killProcessTree(job.pid);
  setTimeout(() => {
    if (!job.running) return;
    job.child.stdout.destroy();
    job.child.stderr.destroy();
  }, OUTPUT_GRACE_MS);
}

/** Wait until the job ends, `ms` pass, or the turn is stopped. */
function waitForJob(job, ms, signal) {
  return new Promise((resolve) => {
    if (!job.running) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      job.child.off('close', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    job.child.on('close', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The output the agent has not read yet (and mark it read). */
export function readJobOutput(job) {
  const firstKept = job.produced - job.output.length;
  const from = Math.max(job.readUpTo, firstKept);
  const missed = from - job.readUpTo;
  const text = stripAnsi(job.output.slice(from - firstKept)).trimEnd();
  job.readUpTo = job.produced;
  const shown = `${missed > 0 ? `[${missed} earlier characters were not kept]\n` : ''}${text}`;
  const output = shown ? truncateMiddle(shown, MAX_RESULT_CHARS) : '(no new output)';
  return output;
}

function jobStatus(job) {
  const status = job.running ? `Running in the background as job ${job.id} (process ${job.pid}). Read its output or stop it with command_output.` : `Job ${job.id} ended with exit code ${job.exitCode ?? 'unknown'}.`;
  return status;
}

export const runCommandTool = {
  name: 'run_command',
  kind: 'command',
  description:
    'Run a shell command in the project folder and return its combined output and exit code. ' +
    'The shell is Windows PowerShell 5.1 by default (no `&&`/`||`; use `;` or `if ($?) { ... }`), or cmd.exe if the user chose it. ' +
    'Commands run without a console: there is no input unless you pass `input`, and anything that waits for more input fails. ' +
    'When you know the answers to a prompt (a confirmation, a menu choice), pass them as `input`. ' +
    'When only the user can answer (a password, a sign-in code), ask them with ask_user to run the command in their own terminal. ' +
    'Each call is a new process: `cd` does not carry over, so use the `cwd` parameter. ' +
    'Programs are not looked up in the current folder: run a script there as `.\\build.cmd`. ' +
    'In PowerShell, exit code 1 can also mean that the last cmdlet reported an error (the output shows it). ' +
    'Use read_file, grep and glob instead of commands to read and search files. ' +
    'For a dev server or watcher that keeps running, set `background: true`: the call returns after a few seconds with the first output and a job id for command_output. Stop such jobs when you no longer need them.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run.' },
      description: { type: 'string', description: 'A few words saying what the command does, shown to the user.' },
      cwd: { type: 'string', description: 'Folder to run in, relative to the project folder. Default: the project folder.' },
      timeout_sec: { type: 'integer', description: 'Time limit in seconds (default from settings, max 600). Not used with background.' },
      background: { type: 'boolean', description: 'Keep the command running in the background (servers, watchers).' },
      input: { type: 'string', description: 'Text for the command\'s standard input, for example "y\\n" to answer a confirmation. End each answer with \\n.' },
    },
    required: ['command'],
  },
  async run(input, ctx) {
    const command = String(input.command || '').trim();
    if (!command) throw new ToolInputError('command is empty.');
    const cwd = resolvePath(ctx.cwd, input.cwd || '.');
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ToolInputError(`Folder ${displayPath(ctx.cwd, cwd)} does not exist.`);
    if (input.background) {
      const job = await startBackgroundJob({ command, cwd, shell: ctx.settings.shell, extraPath: ctx.extraPath, tmpDir: ctx.tmpDir, onExit: ctx.jobs.onExit });
      ctx.jobs.add(job);
      await waitForJob(job, JOB_FIRST_WAIT_MS, ctx.signal);
      const output = readJobOutput(job);
      const isError = !job.running && job.exitCode !== 0;
      return { content: `${jobStatus(job)}\n${output}`, isError, meta: { background: true, job: job.id, running: job.running, exitCode: job.exitCode, cwd: displayPath(ctx.cwd, cwd) } };
    }
    const defaultTimeout = ctx.settings.commandTimeoutSec;
    const timeoutSec = Math.min(600, Math.max(1, Number.isInteger(input.timeout_sec) ? input.timeout_sec : defaultTimeout));
    const result = await runShellCommand({
      command,
      cwd,
      shell: ctx.settings.shell,
      timeoutMs: timeoutSec * 1000,
      extraPath: ctx.extraPath,
      tmpDir: ctx.tmpDir,
      signal: ctx.signal,
      onOutput: ctx.emitOutput,
      input: typeof input.input === 'string' ? input.input : null,
    });
    const status = result.timedOut
      ? `Timed out after ${timeoutSec} s; the command was stopped.`
      : result.interrupted
        ? 'Stopped by the user.'
        : `Exit code ${result.exitCode} (${formatDuration(result.durationMs)})`;
    const output = result.output.trim() ? truncateMiddle(result.output.trimEnd(), MAX_RESULT_CHARS) : '(no output)';
    const content = `${status}\n${output}`;
    const isError = result.timedOut || result.interrupted || result.exitCode !== 0;
    // The window shows the output from `content`, below its status line: the same text the model gets.
    return {
      content,
      isError,
      meta: { exitCode: result.exitCode, timedOut: result.timedOut, interrupted: result.interrupted, durationMs: result.durationMs, cwd: displayPath(ctx.cwd, cwd) },
    };
  },
};

export const commandOutputTool = {
  name: 'command_output',
  kind: 'read',
  description:
    'Check a command started with run_command `background: true`: whether it still runs, its exit code once it ended, and the output since your last check. ' +
    'Optionally wait for it to end first, or stop it (with the processes it started).',
  inputSchema: {
    type: 'object',
    properties: {
      job: { type: 'string', description: 'The job id from run_command.' },
      wait_sec: { type: 'integer', description: 'Wait up to this many seconds (max 60) for the command to end before reading. Default 0.' },
      stop: { type: 'boolean', description: 'Stop the command.' },
    },
    required: ['job'],
  },
  async run(input, ctx) {
    const job = ctx.jobs.get(input.job);
    if (!job) throw new ToolInputError(`This session has no background job "${input.job}".`);
    if (input.stop && job.running) {
      stopJob(job);
      await waitForJob(job, 5000, ctx.signal);
    } else if (input.wait_sec > 0) {
      await waitForJob(job, Math.min(60, input.wait_sec) * 1000, ctx.signal);
    }
    const output = readJobOutput(job);
    return { content: `${jobStatus(job)}\n${output}`, meta: { job: job.id, running: job.running, exitCode: job.exitCode } };
  },
};

/**
 * Split a command into simple parts at ; && || | and line breaks, to check each against allow rules.
 * - Returns null when the command uses constructs that make a prefix check unreliable: parentheses
 *   (PowerShell runs `git status (Remove-Item x)` as two commands), subexpressions, backticks,
 *   redirection to files, script blocks, or control characters other than tab and line breaks
 *   (PowerShell also ends a statement at a lone carriage return).
 */
export function splitCommandParts(command) {
  if (/[`(){}<>]/.test(command)) return null;
  if (/[\x00-\x08\x0b-\x1f\x7f\x85\p{Zl}\p{Zp}]/u.test(command.replace(/\r\n/g, '\n'))) return null;
  const parts = command
    .split(/\r?\n|;|&&|\|\||\||&/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts;
}

/**
 * True when every part of the command matches an allow rule.
 * - A rule allows its own command and that command with more words, so "git log" allows "git log -5".
 * - A rule whose program prints files ("type notes.txt") allows only that exact command: more words could name more
 *   files. Only the program counts (see commandProgram), so "git diff HEAD" is an ordinary rule.
 * - Allow rules are a convenience for repeated commands, not a sandbox: they compare text.
 */
export function commandAllowed(command, prefixes) {
  if (prefixes.length === 0) return false;
  const parts = splitCommandParts(command);
  if (!parts || parts.length === 0) return false;
  const normalizedPrefixes = prefixes.map((prefix) => prefix.trim().toLowerCase()).filter(Boolean);
  const exactRules = new Set(normalizedPrefixes.filter((prefix) => FILE_READERS.test(commandProgram(prefix.split(/\s+/)).name)));
  const allowed = parts.every((part) => {
    const lower = part.toLowerCase();
    return normalizedPrefixes.some((prefix) => lower === prefix || (!exactRules.has(prefix) && lower.startsWith(`${prefix} `)));
  });
  return allowed;
}

// Programs that print files: "Get-Content" alone as a rule would read any file, also Caliope's own.
const FILE_READERS = /^(get-content|gc|type|cat|more|less|head|tail|select-string|sls|findstr|format-hex)$/;
// Programs that delete files, folders or disks.
const DELETERS = /^(remove-item|ri|rm|rmdir|rd|del|erase|rimraf|clear-content|clc|format|format-volume|clear-disk|diskpart)$/;
// Interpreters and launchers: what they run comes after their options.
const LAUNCHERS = /^(python\d*|py|node|npx|uv|uvx|deno|bun|cmd|powershell|pwsh|bash|sh|wsl|java|ruby|perl|php)(\.exe)?$/i;

/**
 * The program a command runs, for the reader and delete checks.
 * - `words`: the command split at spaces. Returns { at, name }: the program's index in `words`, and its name.
 * - The name is the file name in lower case, without quotes, .exe or .com: C:\Windows\System32\findstr.exe is findstr.
 * - After a launcher (cmd /c, powershell -Command, npx…) it is the program the launcher runs, so cmd /c "del x.txt"
 *   runs del. Later words, such as a filter after a pipe, never count.
 */
function commandProgram(words) {
  const nameOf = (word) => path.win32.basename(word.replace(/["']/g, '')).toLowerCase().replace(/\.(exe|com)$/, '');
  const launched = LAUNCHERS.test(nameOf(words[0])) ? words.findIndex((word, index) => index > 0 && !/^[-/]/.test(word)) : -1;
  const at = launched === -1 ? 0 : launched;
  const program = { at, name: nameOf(words[at]) };
  return program;
}

/**
 * True when `rule` runs a program that prints files but names no file, such as "Get-Content -Raw".
 * - commandAllowed matches such a rule only as that exact command, so it never lets a file be read.
 */
export function readerWithoutFile(rule) {
  const words = rule.trim().split(/\s+/);
  const { at, name } = commandProgram(words);
  const withoutFile = FILE_READERS.test(name) && !words.slice(at + 1).some((word) => !/^[-/]/.test(word));
  return withoutFile;
}

/**
 * Suggested allow rule for a command, or null when it should get none.
 * - git, npm and similar: the program and its subcommand, like "git status".
 * - Interpreters and launchers (python, node, npx, cmd…): up to the script or module they run, like
 *   "python -m pytest", because "python" alone would allow any code.
 * - Programs that print files (Get-Content, type, cat…): the whole command, like "Get-Content README.md",
 *   because the program alone would allow reading any file. commandAllowed matches such a rule exactly. null
 *   when it names no file.
 * - Deletes (Remove-Item, rm, del…, also by path or after cmd /c), and the git subcommands reset, clean, rm and
 *   force pushes: null, so the next one asks again. npm rm removes a package, not files, so it gets a rule.
 * - Anything else: the program, like "dir".
 */
export function suggestPrefix(command) {
  const parts = splitCommandParts(command);
  const first = (parts && parts[0]) || command.trim();
  const words = first.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const program = words[0];
  const second = words[1];
  let prefix = program;
  if (LAUNCHERS.test(program)) {
    const firstNonOption = words.findIndex((word, index) => index > 0 && !/^[-/]/.test(word));
    prefix = (firstNonOption === -1 ? words : words.slice(0, firstNonOption + 1)).join(' ');
  } else if (/^(git|npm|pnpm|yarn|dotnet|cargo|go|pip\d*|docker|kubectl|az|gh)(\.exe)?$/i.test(program)) {
    // An option before the subcommand (git -C dir status) is too specific to generalize.
    if (second?.startsWith('-')) prefix = first;
    else if (second) prefix = `${program} ${second}`;
  }
  // "git reset" as a rule would also allow git reset --hard. The subcommand is the first word that is no option and
  // not the folder or setting after -C or -c, so git -C sub reset --hard counts too, and git commit -m "clean up" not.
  const subcommand = /^git(\.exe)?$/i.test(program) ? words.find((word, index) => index > 0 && !word.startsWith('-') && !/^-[Cc]$/.test(words[index - 1]))?.toLowerCase() : null;
  const forcePush = subcommand === 'push' && words.some((word) => /^(-f|--force.*|\+.+)$/i.test(word));
  const { name } = commandProgram(words);
  if (DELETERS.test(name) || ['reset', 'clean', 'rm'].includes(subcommand) || forcePush) return null;
  if (FILE_READERS.test(name)) {
    const fileRule = readerWithoutFile(first) ? null : first;
    return fileRule;
  }
  return prefix;
}
