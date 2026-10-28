import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectExtraPath } from '../server/config.js';
import { findGit, runGit } from '../server/tools/files.js';
import { gitChanges, parseStatus, createWorktree, removeWorktree } from '../server/git.js';
import { discoverCommands, expandCommand } from '../server/commands.js';
import { isInside } from '../server/tools/paths.js';

const extraPath = detectExtraPath();
const gitExe = findGit(extraPath);

function tempFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caliope-test-'));
  return folder;
}

/** A repository with one commit: tracked.txt and old-name.txt. Its path is the long form git reports. */
async function tempRepository() {
  const repo = path.join(fs.realpathSync.native(tempFolder()), 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'old-name.txt'), 'moved\n');
  await runGit(gitExe, ['init', '-q', '-b', 'main'], repo);
  await runGit(gitExe, ['add', '.'], repo);
  await runGit(gitExe, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], repo);
  return repo;
}

test('parseStatus reads porcelain -z output with renames in either column and spaces', () => {
  const output = ' M src/app.js\0?? new file.txt\0R  new-name.txt\0old-name.txt\0D  gone.txt\0 R moved.txt\0original.txt\0';
  assert.deepEqual(parseStatus(output), [
    { code: 'M', path: 'src/app.js' },
    { code: '??', path: 'new file.txt' },
    { code: 'R', path: 'new-name.txt', oldPath: 'old-name.txt' },
    { code: 'D', path: 'gone.txt' },
    { code: 'R', path: 'moved.txt', oldPath: 'original.txt' },
  ]);
});

test('isInside treats a folder named "..x" as inside', () => {
  assert.ok(isInside('C:\\repo', 'C:\\repo\\..config'));
  assert.ok(isInside('C:\\repo', 'C:\\repo'));
  assert.ok(isInside('C:\\Repo', 'C:\\repo\\src\\a.js'), 'Windows paths ignore case');
  assert.ok(!isInside('C:\\repo', 'C:\\repo\\..\\x'));
  assert.ok(!isInside('C:\\repo', 'C:\\repo-other'));
  assert.ok(!isInside('C:\\repo', 'C:\\'));
});

test('gitChanges lists modified, untracked, renamed and deleted files with diffs', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'hello\n');
  await runGit(gitExe, ['mv', 'old-name.txt', 'new-name.txt'], repo);
  const changes = await gitChanges(repo, extraPath);
  assert.equal(changes.repo, true);
  assert.equal(changes.branch, 'main');
  const byPath = Object.fromEntries(changes.files.map((file) => [path.relative(repo, file.path), file]));
  assert.equal(byPath['tracked.txt'].status, 'modified');
  assert.equal(byPath['tracked.txt'].added, 1);
  assert.equal(byPath['tracked.txt'].removed, 1);
  assert.equal(byPath['new file.txt'].status, 'untracked');
  assert.equal(byPath['new-name.txt'].status, 'renamed');
  assert.equal(byPath['new-name.txt'].added, 0, 'a pure rename has no line changes');
  assert.equal(byPath['new-name.txt'].shownPath, 'old-name.txt → new-name.txt');
  const outside = await gitChanges(tempFolder(), extraPath);
  assert.equal(outside.repo, false);
});

test('gitChanges lists files over 2 MB without reading them into a diff', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.writeFileSync(path.join(repo, 'big.log'), 'x'.repeat(3 * 1024 * 1024));
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  const changes = await gitChanges(repo, extraPath);
  const big = changes.files.find((file) => file.shownPath === 'big.log');
  assert.equal(big.tooLarge, true);
  assert.deepEqual(big.hunks, []);
  const small = changes.files.find((file) => file.shownPath === 'tracked.txt');
  assert.equal(small.removed, 2, 'small files still get a diff from the HEAD version');
});

test('createWorktree makes a branch and folder; removeWorktree refuses uncommitted work unless forced', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.mkdirSync(path.join(repo, 'sub'));
  const worktree = await createWorktree(path.join(repo, 'sub'), extraPath, 'test1');
  assert.equal(worktree.branch, 'caliope/test1');
  assert.equal(worktree.repoRoot, repo);
  assert.equal(worktree.sourceCwd, path.join(repo, 'sub'));
  assert.equal(worktree.folder, path.join(path.dirname(repo), 'repo-worktrees', 'test1'));
  assert.ok(fs.existsSync(path.join(worktree.folder, 'tracked.txt')));
  // "sub" is empty, so git does not check it out. It is created so the session can start there.
  assert.equal(worktree.cwd, path.join(worktree.folder, 'sub'));
  assert.ok(fs.statSync(worktree.cwd).isDirectory());
  fs.writeFileSync(path.join(worktree.folder, 'work.txt'), 'unsaved\n');
  await assert.rejects(removeWorktree(worktree, extraPath), /modified or untracked/);
  await removeWorktree(worktree, extraPath, { force: true });
  assert.ok(!fs.existsSync(worktree.folder));
  const branches = await runGit(gitExe, ['branch', '--list', 'caliope/*'], repo);
  assert.match(branches, /caliope\/test1/, 'the branch is kept');
  await assert.rejects(createWorktree(tempFolder(), extraPath, 'x'), /not in a git repository/);
  // git's own reason is reported, not its progress output.
  await assert.rejects(createWorktree(repo, extraPath, 'test1'), /already exists/);
});

test('a worktree for a subfolder whose name starts with two dots keeps that subfolder', { skip: !gitExe && 'git not found' }, async () => {
  const repo = await tempRepository();
  fs.mkdirSync(path.join(repo, '..config'));
  const worktree = await createWorktree(path.join(repo, '..config'), extraPath, 'dots');
  assert.equal(worktree.cwd, path.join(worktree.folder, '..config'));
  await removeWorktree(worktree, extraPath, { force: true });
});

test('custom commands: discovery, description and argument expansion', async () => {
  const project = tempFolder();
  fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(project, '.github', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'fix.md'), '---\ndescription: Fix an issue\n---\nFix $1 because $ARGUMENTS.\n');
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'tidy.md'), '# Tidy the code\nRemove dead code.\n');
  fs.writeFileSync(path.join(project, '.github', 'prompts', 'fix.prompt.md'), 'Shadowed by .claude/commands/fix.md\n');
  fs.writeFileSync(path.join(project, '.github', 'prompts', 'explain.prompt.md'), 'Explain the code.\n');
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'notes.txt'), 'not a command');
  fs.mkdirSync(path.join(project, '.claude', 'commands', 'db'));
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'db', 'migrate.md'), 'Write a migration for $ARGUMENTS.\n');
  const commands = (await discoverCommands(project)).filter((command) => command.source === 'project');
  assert.deepEqual(
    commands.map(({ name, description }) => ({ name, description })),
    [
      { name: 'db:migrate', description: 'Write a migration for $ARGUMENTS.' },
      { name: 'fix', description: 'Fix an issue' },
      { name: 'tidy', description: 'Tidy the code' },
      { name: 'explain', description: 'Explain the code.' },
    ],
  );
  const fix = commands.find((command) => command.name === 'fix');
  assert.equal(await expandCommand(fix, 'login.js it crashes'), 'Fix login.js because login.js it crashes.');
  const tidy = commands.find((command) => command.name === 'tidy');
  assert.equal(await expandCommand(tidy, 'in src'), '# Tidy the code\nRemove dead code.\n\nin src');
  assert.equal(await expandCommand(tidy, ''), '# Tidy the code\nRemove dead code.');
});

