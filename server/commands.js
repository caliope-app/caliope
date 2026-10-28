// Custom slash commands: Markdown prompt files the user or the project keeps, in the formats Claude Code
// (.claude/commands/*.md) and GitHub Copilot (.github/prompts/*.prompt.md) use. "/name text" sends the file's
// prompt with $ARGUMENTS replaced by the text.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontMatter } from './skills.js';

function commandSources(projectRoot) {
  const sources = [];
  if (projectRoot) {
    sources.push({ dir: path.join(projectRoot, '.claude', 'commands'), suffix: '.md', source: 'project' });
    sources.push({ dir: path.join(projectRoot, '.github', 'prompts'), suffix: '.prompt.md', source: 'project' });
  }
  sources.push({ dir: path.join(os.homedir(), '.claude', 'commands'), suffix: '.md', source: 'personal' });
  return sources;
}

/** Command files in `dir`: "name.md" is /name, and "group/name.md" one folder down is /group:name. */
async function commandFiles(dir, suffix) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
      files.push({ name: entry.name.slice(0, -suffix.length), file: path.join(dir, entry.name) });
    } else if (entry.isDirectory()) {
      // Files only, as above: a link could point a cloned repository's command at a secret.
      const inner = await fsp.readdir(path.join(dir, entry.name), { withFileTypes: true }).catch(() => []);
      for (const file of inner.sort((a, b) => a.name.localeCompare(b.name))) {
        if (file.isFile() && file.name.toLowerCase().endsWith(suffix)) files.push({ name: `${entry.name}:${file.name.slice(0, -suffix.length)}`, file: path.join(dir, entry.name, file.name) });
      }
    }
  }
  return files;
}

/** Commands for a project, most specific first; a name found earlier wins. */
export async function discoverCommands(projectRoot) {
  const commands = [];
  const seen = new Set();
  for (const { dir, suffix, source } of commandSources(projectRoot)) {
    for (const { name, file } of await commandFiles(dir, suffix)) {
      if (!/^[\w.:-]{1,60}$/.test(name) || seen.has(name.toLowerCase())) continue;
      try {
        const { attributes, body } = parseFrontMatter(await fsp.readFile(file, 'utf8'));
        const firstLine = body.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() || '';
        seen.add(name.toLowerCase());
        commands.push({ name, description: String(attributes.description || firstLine).slice(0, 160), path: file, source });
      } catch {
        // Unreadable files are skipped.
      }
    }
  }
  return commands;
}

/**
 * The prompt for "/name arguments": the file body with $ARGUMENTS (and $1..$9) filled in.
 * - When the file has no placeholder, the arguments are added after it.
 */
export async function expandCommand(command, argumentText) {
  const { body } = parseFrontMatter(await fsp.readFile(command.path, 'utf8'));
  let text = fillArguments(body, argumentText);
  if (argumentText && !/\$ARGUMENTS|\$[1-9]/.test(body)) text = `${text.trim()}\n\n${argumentText}`;
  return text.trim();
}

/** Replace $ARGUMENTS with the whole argument text and $1..$9 with its words. */
export function fillArguments(text, argumentText) {
  const words = argumentText.split(/\s+/).filter(Boolean);
  // One pass, so a "$1" typed in the arguments is not replaced again.
  const filled = text.replace(/\$ARGUMENTS|\$([1-9])/g, (match, digit) => (digit ? (words[Number(digit) - 1] ?? '') : argumentText));
  return filled;
}
