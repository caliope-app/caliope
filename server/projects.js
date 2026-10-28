// Projects (one per folder), kept in Caliope's data folder so nothing is written into the user's repositories.
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.js';
import { pathKey } from './tools/paths.js';

// Project memory goes into every new session's system prompt (cached, so cheap), so it stays small.
export const MAX_MEMORY_CHARS = 6000;

// Files in a repository that steer the agent. Caliope asks before loading them from an unknown folder.
export const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '.github/copilot-instructions.md', '.claude/commands', '.github/prompts', '.github/skills', '.claude/skills', '.agents/skills', '.mcp.json'];

/** The project a session belongs to: the folder the user picked, also for a session in its own worktree. */
export function projectFolderOf(meta) {
  const folder = meta.worktree?.sourceCwd || meta.cwd;
  return folder;
}

export class ProjectStore {
  constructor(file) {
    this.file = file;
    this.projects = {};
  }

  async load() {
    this.projects = (await readJson(this.file, {}).catch(() => ({}))) || {};
  }

  /**
   * Settings for a folder. Folders without saved settings get defaults.
   * - `allowedCommands`: command prefixes that run without asking in every session of this project.
   * - `allowedSites`: sites (scheme, host and port) the agent's browser may act on in every session of this project.
   * - `trusted`: true or false once the user answered "Do you trust this folder?", else null.
   * - `memory`: notes the agent and the user keep for this project (see the remember tool).
   * - `hooks`: commands Caliope runs after the agent edits a file (see hooks.js).
   * - `creditLimit`: AI credits this project may spend per calendar month, 0 for no limit.
   * - `schedules`: scheduled tasks (see schedules.js).
   */
  get(folder) {
    const saved = this.projects[pathKey(folder)];
    const project = {
      folder,
      name: saved?.name || path.basename(folder) || folder,
      instructions: saved?.instructions || '',
      allowedCommands: saved?.allowedCommands || [],
      allowedSites: saved?.allowedSites || [],
      trusted: typeof saved?.trusted === 'boolean' ? saved.trusted : null,
      memory: saved?.memory || '',
      hooks: saved?.hooks || [],
      creditLimit: saved?.creditLimit || 0,
      schedules: saved?.schedules || [],
      updatedAt: saved?.updatedAt || null,
    };
    return project;
  }

  /** Projects the user created or configured (they show in the sidebar even without sessions). */
  saved() {
    const projects = Object.values(this.projects).map((project) => this.get(project.folder));
    return projects;
  }

  async update(folder, { name, instructions, allowedCommands, allowedSites, trusted, memory, hooks, creditLimit, schedules }) {
    const key = pathKey(folder);
    const current = this.projects[key] || {};
    const commands = Array.isArray(allowedCommands) ? allowedCommands : current.allowedCommands || [];
    const sites = Array.isArray(allowedSites) ? allowedSites : current.allowedSites || [];
    this.projects[key] = {
      folder,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : current.name || path.basename(folder),
      instructions: typeof instructions === 'string' ? instructions.slice(0, 50000) : current.instructions || '',
      allowedCommands: [...new Set(commands.map((command) => String(command).trim()).filter(Boolean))].slice(0, 200),
      allowedSites: [...new Set(sites.map((site) => String(site).trim()).filter(Boolean))].slice(0, 200),
      trusted: typeof trusted === 'boolean' ? trusted : typeof current.trusted === 'boolean' ? current.trusted : null,
      memory: typeof memory === 'string' ? memory.slice(0, MAX_MEMORY_CHARS) : current.memory || '',
      hooks: Array.isArray(hooks) ? hooks : current.hooks || [],
      creditLimit: Number.isFinite(creditLimit) ? Math.min(1000000, Math.max(0, creditLimit)) : current.creditLimit || 0,
      schedules: Array.isArray(schedules) ? schedules : current.schedules || [],
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.file, this.projects);
    return this.get(folder);
  }
}
