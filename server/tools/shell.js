// run_command: PowerShell (default) or cmd.exe, without a console, with a timeout and live output.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { newId, stripAnsi, truncateMiddle, formatDuration } from '../util.js';
import { killProcessTree } from '../windows.js';
import { resolvePath, displayPath } from './paths.js';
import { ToolInputError } from './fs-tools.js';

const MAX_RESULT_CHARS = 30000;
const HEAD_KEEP = 200000;
const TAIL_KEEP = 800000;

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

/**
 * The program, arguments and spawn options that run `command` in the chosen shell (PowerShell runs a temporary script).
 * - `stdin`: true to keep standard input open for the caller.
 */
async function shellInvocation({ command, cwd, shell, extraPath, tmpDir, stdin = false }) {
  const spawnOptions = { cwd, env: commandEnvironment(extraPath), windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] };
  if (shell === 'cmd') {
    spawnOptions.windowsVerbatimArguments = true;
    const invocation = { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"chcp 65001 >nul & ${command}"`], spawnOptions, scriptFile: null };
    return invocation;
  }
  await fsp.mkdir(tmpDir, { recursive: true });
  const scriptFile = path.join(tmpDir, `c-${newId()}.ps1`);
  await fsp.writeFile(scriptFile, `﻿${POWERSHELL_PRELUDE}${command}${POWERSHELL_EPILOGUE}`, 'utf8');
  const runScript = `& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(scriptFile)})))`;
  const invocation = { exe: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', runScript], spawnOptions, scriptFile };
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
    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');
    child.stdout.on('data', (chunk) => append(stdoutDecoder.decode(chunk, { stream: true })));
    child.stderr.on('data', (chunk) => append(stderrDecoder.decode(chunk, { stream: true })));
    if (input !== null) {
      // The command may end without reading all of its input.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      killProcessTree(child.pid);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ spawnError: error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      append(stdoutDecoder.decode());
      append(stderrDecoder.decode());
      resolve({ exitCode: code, timedOut, interrupted });
    });
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
 * - Returns the job. Read new output with readJobOutput, stop it with killProcessTree(job.pid).
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
      return { content: `${jobStatus(job)}\n${output}`, isError, meta: { background: true, job: job.id, running: job.running, exitCode: job.exitCode, cwd: displayPath(ctx.cwd, cwd), output } };
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
    return {
      content,
      isError,
      // The window shows the same 30,000 characters the model gets. More would only grow session.json.
      meta: { exitCode: result.exitCode, timedOut: result.timedOut, interrupted: result.interrupted, durationMs: result.durationMs, cwd: displayPath(ctx.cwd, cwd), output: truncateMiddle(result.output, MAX_RESULT_CHARS) },
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
      killProcessTree(job.pid);
      await waitForJob(job, 5000, ctx.signal);
    } else if (input.wait_sec > 0) {
      await waitForJob(job, Math.min(60, input.wait_sec) * 1000, ctx.signal);
    }
    const output = readJobOutput(job);
    return { content: `${jobStatus(job)}\n${output}`, meta: { job: job.id, running: job.running, exitCode: job.exitCode, output } };
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
 * True when every part of the command starts with an allowed prefix.
 * - Allow rules are a convenience for repeated commands, not a sandbox: they compare text.
 */
export function commandAllowed(command, prefixes) {
  if (prefixes.length === 0) return false;
  const parts = splitCommandParts(command);
  if (!parts || parts.length === 0) return false;
  const normalizedPrefixes = prefixes.map((prefix) => prefix.trim().toLowerCase()).filter(Boolean);
  const allowed = parts.every((part) => {
    const lower = part.toLowerCase();
    return normalizedPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix} `));
  });
  return allowed;
}

/**
 * Suggested allow rule for a command.
 * - git, npm and similar: the program and its subcommand, like "git status".
 * - Interpreters and launchers (python, node, npx, cmd…): up to the script or module they run, like
 *   "python -m pytest", because "python" alone would allow any code.
 * - Anything else: the program, like "Get-Content".
 */
export function suggestPrefix(command) {
  const parts = splitCommandParts(command);
  const first = (parts && parts[0]) || command.trim();
  const words = first.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const program = words[0];
  const second = words[1];
  if (/^(python\d*|py|node|npx|uv|uvx|deno|bun|cmd|powershell|pwsh|bash|sh|wsl|java|ruby|perl|php)(\.exe)?$/i.test(program)) {
    const firstNonOption = words.findIndex((word, index) => index > 0 && !/^[-/]/.test(word));
    const prefix = (firstNonOption === -1 ? words : words.slice(0, firstNonOption + 1)).join(' ');
    return prefix;
  }
  if (/^(git|npm|pnpm|yarn|dotnet|cargo|go|pip\d*|docker|kubectl|az|gh)(\.exe)?$/i.test(program)) {
    // An option before the subcommand (git -C dir status) is too specific to generalize.
    if (second?.startsWith('-')) return first;
    return second ? `${program} ${second}` : program;
  }
  return program;
}
