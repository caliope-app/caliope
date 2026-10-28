// Git: uncommitted changes with diffs, and worktrees that give a session its own branch and folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { diffTexts } from '../shared/diff.js';
import { findGit, looksBinary, runGit } from './tools/files.js';
import { isInside } from './tools/paths.js';
import { decodeText } from './tools/text-files.js';

const MAX_FILES = 150;
// Larger files are listed without a diff: reading and diffing them would stall the app.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * Every uncommitted change in the repository that contains `cwd`, compared with HEAD.
 * - Returns { repo: false } outside a git repository (or without git).
 * - Untracked files count as added. At most MAX_FILES files get a diff.
 */
export async function gitChanges(cwd, extraPath) {
  const gitExe = findGit(extraPath);
  if (!gitExe) return { repo: false, reason: 'git was not found on this PC.' };
  let root;
  try {
    root = path.resolve((await runGit(gitExe, ['rev-parse', '--show-toplevel'], cwd)).trim());
  } catch {
    return { repo: false, reason: 'This folder is not in a git repository.' };
  }
  const branch = (await runGit(gitExe, ['rev-parse', '--abbrev-ref', 'HEAD'], root).catch(() => '')).trim() || null;
  const hasHead = await runGit(gitExe, ['rev-parse', '--verify', 'HEAD'], root).then(() => true, () => false);
  const status = await runGit(gitExe, ['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  const allEntries = parseStatus(status);
  const entries = allEntries.slice(0, MAX_FILES);
  const headPaths = hasHead ? entries.filter((entry) => entry.code !== '??' && !entry.code.includes('A')).map((entry) => entry.oldPath || entry.path) : [];
  const headFiles = await headVersions(gitExe, root, headPaths);
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.path);
    const kind = entry.code === '??' ? 'untracked' : entry.code.includes('D') ? 'deleted' : entry.code.includes('A') ? 'added' : entry.code.includes('R') ? 'renamed' : 'modified';
    const shownPath = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
    const before = headFiles.get(entry.oldPath || entry.path) ?? Buffer.alloc(0);
    let after = Buffer.alloc(0);
    try {
      const stat = await fsp.stat(absolutePath);
      after = stat.size > MAX_DIFF_BYTES ? null : await fsp.readFile(absolutePath);
    } catch {
      // Deleted.
    }
    if (before === null || after === null) {
      files.push({ path: absolutePath, shownPath, status: kind, binary: false, tooLarge: true, added: 0, removed: 0, hunks: [] });
    } else if (looksBinary(before) || looksBinary(after)) {
      files.push({ path: absolutePath, shownPath, status: kind, binary: true, added: 0, removed: 0, hunks: [] });
    } else {
      const diff = diffTexts(decodeText(before).text, decodeText(after).text, { context: 3, maxLines: 1500 });
      files.push({ path: absolutePath, shownPath, status: kind, binary: false, ...diff });
    }
  }
  const changes = { repo: true, root, branch, files, truncated: allEntries.length > MAX_FILES, total: allEntries.length };
  return changes;
}

/**
 * The HEAD version of each repository path, read by two git processes instead of one per file.
 * - Returns a Map from path to Buffer. Paths that are not in HEAD are left out.
 * - Versions larger than MAX_DIFF_BYTES map to null.
 */
async function headVersions(gitExe, root, paths) {
  const versions = new Map();
  // cat-file reads one path per line, so a path with a line break cannot be asked for.
  const names = paths.filter((file) => !/[\r\n]/.test(file));
  if (names.length === 0) return versions;
  const checks = (await runGit(gitExe, ['cat-file', '--batch-check'], root, { input: names.map((file) => `HEAD:${file}\n`).join('') })).split('\n');
  const wanted = [];
  const sizes = new Map();
  names.forEach((file, index) => {
    const size = /^\S+ blob (\d+)$/.exec(checks[index] || '')?.[1];
    if (size === undefined) return;
    if (Number(size) > MAX_DIFF_BYTES) {
      versions.set(file, null);
      return;
    }
    wanted.push(file);
    sizes.set(file, size);
  });
  if (wanted.length === 0) return versions;
  // Output per object: "<sha> blob <size>\n<content>\n", or "<name> missing\n". Room for all of it.
  const totalBytes = wanted.reduce((sum, file) => sum + Number(sizes.get(file)) + file.length + 120, 0);
  const output = await runGit(gitExe, ['cat-file', '--batch'], root, { input: wanted.map((file) => `HEAD:${file}\n`).join(''), buffer: true, maxBuffer: totalBytes + 1024 * 1024 });
  let offset = 0;
  for (const file of wanted) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const size = /^\S+ blob (\d+)$/.exec(output.toString('utf8', offset, headerEnd))?.[1];
    if (size === undefined) {
      offset = headerEnd + 1;
      continue;
    }
    versions.set(file, output.subarray(headerEnd + 1, headerEnd + 1 + Number(size)));
    offset = headerEnd + 1 + Number(size) + 1;
  }
  return versions;
}

/** Parse `git status --porcelain=v1 -z`: "XY path\0"; a rename or copy (in either column) adds "oldpath\0". */
export function parseStatus(output) {
  const parts = output.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length < 4) continue;
    const code = part.slice(0, 2);
    const entry = { code: code.trim() || code, path: part.slice(3) };
    if (/[RC]/.test(code)) entry.oldPath = parts[++i];
    entries.push(entry);
  }
  return entries;
}

/**
 * Create a worktree for a session: a new branch `caliope/<name>` from HEAD, checked out in
 * `<parent of repo>/<repo>-worktrees/<name>`.
 * - `cwd`: the folder in the worktree that matches `cwd` in the repository.
 * - `sourceCwd`: the folder the user picked, so the session stays with that project.
 */
export async function createWorktree(cwd, extraPath, name) {
  const gitExe = findGit(extraPath);
  if (!gitExe) throw new Error('git was not found on this PC, so a worktree cannot be created.');
  let root;
  try {
    root = path.resolve((await runGit(gitExe, ['rev-parse', '--show-toplevel'], cwd)).trim());
  } catch {
    throw new Error('This folder is not in a git repository.');
  }
  await runGit(gitExe, ['rev-parse', '--verify', 'HEAD'], root).catch(() => {
    throw new Error('The repository has no commits yet; make a first commit before using a worktree.');
  });
  const folder = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, name);
  const branch = `caliope/${name}`;
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  await runGit(gitExe, ['worktree', 'add', '-b', branch, folder, 'HEAD'], root, { timeoutMs: 120000 });
  const relative = path.relative(root, path.resolve(cwd));
  const workFolder = isInside(root, cwd) ? path.join(folder, relative) : folder;
  // git does not check out empty folders. The session still needs its folder.
  fs.mkdirSync(workFolder, { recursive: true });
  const worktree = { repoRoot: root, folder, branch, cwd: workFolder, sourceCwd: path.resolve(cwd) };
  return worktree;
}

/** Remove a session's worktree. Refuses when it has uncommitted changes unless `force`; keeps the branch. */
export async function removeWorktree(worktree, extraPath, { force = false } = {}) {
  const gitExe = findGit(extraPath);
  if (!gitExe) throw new Error('git was not found on this PC.');
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktree.folder);
  await runGit(gitExe, args, worktree.repoRoot, { timeoutMs: 120000 });
}
