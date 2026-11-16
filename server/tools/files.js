// Listing project files for glob, grep and @-mentions.
// Inside a git work tree, `git ls-files` gives the files git would track (it respects .gitignore).
// Elsewhere a folder walk skips dependency and cache folders.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SKIP_FOLDERS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.idea', '.vs']);
const MAX_FILES = 100000;

let gitCache = { key: null, exe: null };

/** Find git.exe in the extra PATH folders or on PATH. */
export function findGit(extraPath = []) {
  const key = extraPath.join(';');
  if (gitCache.key === key) return gitCache.exe;
  const folders = [...extraPath, ...String(process.env.PATH || process.env.Path || '').split(path.delimiter)];
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  let exe = null;
  for (const folder of folders) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = path.join(folder, name);
      if (fs.existsSync(candidate)) {
        exe = candidate;
        break;
      }
    }
    if (exe) break;
  }
  gitCache = { key, exe };
  return exe;
}

/**
 * Run git and return its output as text, or as a Buffer with `{ buffer: true }`.
 * - `input` is written to git's stdin.
 * - A failure's message is git's last "fatal:" or "error:" line (git prints progress lines first).
 */
export function runGit(gitExe, args, cwd, { timeoutMs = 20000, maxBuffer = 64 * 1024 * 1024, buffer = false, input = null, env = null } = {}) {
  const output = new Promise((resolve, reject) => {
    // A repository's own settings can name a program that git runs on every status and listing
    // (core.fsmonitor). Caliope's own git calls never run it.
    const child = execFile(gitExe, ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'buffer', env: env ? { ...process.env, ...env } : undefined }, (error, stdout, stderr) => {
      if (error) {
        const lines = (stderr?.toString('utf8') || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const reason = lines.findLast((line) => /^(fatal|error):/i.test(line)) || lines[0];
        if (reason) error.message = reason;
        reject(error);
      } else resolve(buffer ? stdout : stdout.toString('utf8'));
    });
    if (input !== null) {
      // git may exit before reading everything. The exit status reports the real problem.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
  return output;
}

/** The folder a project's files are found from: the git root, or the folder itself outside git. */
export async function projectRoot(folder, extraPath) {
  const root = (await gitRoot(folder, extraPath)) || folder;
  return root;
}

/**
 * List files under `root` as relative paths with forward slashes.
 * - Uses git when `root` is inside a work tree. Otherwise walks the folder.
 * - Returns at most MAX_FILES entries. `truncated` says when the limit was hit.
 */
export async function listProjectFiles(root, { extraPath = [], signal } = {}) {
  const gitExe = findGit(extraPath);
  if (gitExe) {
    try {
      const output = await runGit(gitExe, ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z'], root);
      const files = output.split('\0').filter(Boolean);
      const existing = files.length > MAX_FILES ? files.slice(0, MAX_FILES) : files;
      return { files: existing, truncated: files.length > MAX_FILES, source: 'git' };
    } catch {
      // Not a git work tree, or git failed: walk the folder instead.
    }
  }
  const files = [];
  let truncated = false;
  async function walk(folder, prefix) {
    if (signal?.aborted || truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_FOLDERS.has(entry.name)) continue;
        await walk(path.join(folder, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await walk(root, '');
  return { files, truncated, source: 'walk' };
}

/** True when the first 8 KB contain a NUL byte. */
export function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

export async function gitBranch(cwd, extraPath) {
  const gitExe = findGit(extraPath);
  if (!gitExe) return null;
  try {
    const branch = (await runGit(gitExe, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { timeoutMs: 5000 })).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * The changed files and the latest commits when a session starts, as Claude Code gives its model.
 * - Returns { status, commits } as text (status at most 40 lines), or null outside a git repository.
 * - Only for trusted folders: git status can run programs the repository's own settings name.
 */
export async function gitSnapshot(cwd, extraPath) {
  const gitExe = findGit(extraPath);
  if (!gitExe) return null;
  try {
    const [status, commits] = await Promise.all([
      runGit(gitExe, ['-c', 'core.quotepath=off', 'status', '--short'], cwd, { timeoutMs: 5000 }),
      runGit(gitExe, ['log', '--oneline', '-5'], cwd, { timeoutMs: 5000 }).catch(() => ''),
    ]);
    const lines = status.split('\n').filter(Boolean);
    const shownStatus = lines.length > 40 ? [...lines.slice(0, 40), `… and ${lines.length - 40} more`].join('\n') : lines.join('\n');
    const snapshot = { status: shownStatus, commits: commits.trim() };
    return snapshot;
  } catch {
    return null;
  }
}

export async function gitRoot(cwd, extraPath) {
  const gitExe = findGit(extraPath);
  if (!gitExe) return null;
  try {
    const root = (await runGit(gitExe, ['rev-parse', '--show-toplevel'], cwd, { timeoutMs: 5000 })).trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}
