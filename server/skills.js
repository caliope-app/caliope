// Skills: folders with a SKILL.md (YAML front matter `name` and `description`, then instructions),
// the format Claude Code and the GitHub Copilot CLI use. The model sees the list and loads a skill
// with use_skill when a task matches.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Skill folders to search, most specific first: the project, then Caliope's own folder, then
 * the user's Claude and Copilot skill folders. A name found earlier wins.
 */
export function skillSources({ projectRoot, dataDir, settings }) {
  const sources = [];
  if (projectRoot) {
    for (const relative of ['.github/skills', '.claude/skills', '.agents/skills']) sources.push({ dir: path.join(projectRoot, relative), source: 'project' });
  }
  sources.push({ dir: path.join(dataDir, 'skills'), source: 'Caliope' });
  if (settings.useClaudeSkills) sources.push({ dir: path.join(os.homedir(), '.claude', 'skills'), source: 'Claude' });
  sources.push({ dir: path.join(os.homedir(), '.copilot', 'skills'), source: 'Copilot' });
  return sources;
}

export async function discoverSkills(options) {
  const skills = [];
  const seen = new Set();
  for (const { dir, source } of skillSources(options)) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const folder = path.join(dir, entry.name);
      // Skill folders are often junctions or symbolic links (shared toolkits). Follow them.
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(folder))) continue;
      const file = ['SKILL.md', 'skill.md', 'Skill.md'].map((name) => path.join(folder, name)).find((candidate) => fs.existsSync(candidate));
      if (!file) continue;
      try {
        // A linked folder is fine, but the file it opens must be a SKILL.md: a cloned repository could make it a
        // link to a secret.
        if (path.basename(fs.realpathSync.native(file)).toLowerCase() !== 'skill.md') continue;
        const { attributes } = parseFrontMatter(await fsp.readFile(file, 'utf8'));
        const name = String(attributes.name || entry.name).trim();
        const key = name.toLowerCase();
        if (!/^[\w.:-]{1,80}$/.test(name) || seen.has(key)) continue;
        seen.add(key);
        skills.push({ name, description: String(attributes.description || '').trim().slice(0, 1024), path: file, folder, source });
      } catch {
        // An unreadable skill is skipped.
      }
    }
  }
  return skills;
}

/** The fields of a skill the app window gets: not the path of its SKILL.md. */
export function publicSkill({ name, description, source, folder }) {
  return { name, description, source, folder };
}

/**
 * Read a Markdown file's front matter: minimal YAML with `key: value` lines, quoted values, and `|` / `>` blocks.
 * - Returns { attributes, body }. A file without front matter has empty attributes.
 */
export function parseFrontMatter(text) {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { attributes: {}, body: normalized };
  const attributes = {};
  const lines = match[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!line) continue;
    const [, key, rawValue] = line;
    let value = rawValue.trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = value.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }
  return { attributes, body: normalized.slice(match[0].length) };
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Contents of a skill for the model: its instructions and the other files it can read. */
export async function loadSkill(skill) {
  const { body } = parseFrontMatter(await fsp.readFile(skill.path, 'utf8'));
  const files = [];
  async function walk(folder, depth) {
    if (depth > 3 || files.length >= 60) return;
    let entries = [];
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) await walk(full, depth + 1);
      else if (full !== skill.path) files.push(full);
    }
  }
  await walk(skill.folder, 0);
  const listing = files.length ? `\n\nFiles in this skill (read them with read_file when the instructions refer to them):\n${files.map((file) => `- ${file}`).join('\n')}` : '';
  const content = `Skill "${skill.name}" from ${skill.folder}\n\n${body.trim()}${listing}`;
  return content;
}
