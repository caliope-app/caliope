// Hooks (project page): commands that run after the agent edits a file, such as a formatter or linter.
// - A hook runs after edit_file or write_file changed a file matching `match` (for example "*.py").
//   {file} stands for the changed file. The output goes back to the agent with the edit's result.
// - Hooks live in Caliope's data, never in the repository, so a cloned repository cannot add any.
import path from 'node:path';
import { runShellCommand, psQuote } from './tools/shell.js';
import { createGlobMatcher } from './tools/glob.js';
import { truncateMiddle } from './util.js';

const MAX_HOOK_OUTPUT = 8000;

/** Check a list of hooks from the project page; throws a message naming the problem. */
export function validateHooks(hooks) {
  if (!Array.isArray(hooks) || hooks.length > 30) throw new Error('Hooks must be a list of up to 30 entries.');
  const valid = hooks.map((hook, index) => {
    const command = String(hook?.command || '').trim();
    if (!command) throw new Error(`Hook ${index + 1}: the command is empty.`);
    const timeoutSec = Math.min(600, Math.max(5, Number.parseInt(hook.timeoutSec, 10) || 60));
    return { match: String(hook.match || '').trim().slice(0, 200), command: command.slice(0, 2000), timeoutSec };
  });
  return valid;
}

/** Run the hooks whose pattern matches `file` (relative to `cwd`); returns [{ command, exitCode, timedOut, output }]. */
export async function runEditHooks(hooks, { cwd, file, shell, extraPath, tmpDir, signal }) {
  const results = [];
  for (const hook of hooks) {
    if (hook.match && !createGlobMatcher(hook.match)(path.relative(cwd, file))) continue;
    // Windows file names cannot contain ", so double quotes are safe for cmd.exe.
    const quoted = shell === 'cmd' ? `"${file}"` : psQuote(file);
    // A function as replacement, so "$&" or "$'" in a file name stays literal.
    const command = hook.command.replaceAll('{file}', () => quoted);
    const result = await runShellCommand({ command, cwd, shell, timeoutMs: hook.timeoutSec * 1000, extraPath, tmpDir, signal });
    results.push({ command, exitCode: result.exitCode, timedOut: result.timedOut, output: truncateMiddle(result.output.trim(), MAX_HOOK_OUTPUT) });
  }
  return results;
}
