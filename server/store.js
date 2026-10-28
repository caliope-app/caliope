// Session storage. Each session is a folder under sessions/:
//   meta.json     small summary used for the session list
//   session.json  the conversation, frozen system prompt, todos, permissions, checkpoints
//   blobs/        file contents saved before and after each edit, for rewind
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, readJson, writeJsonAtomic, KeyedQueue, sha256 } from './util.js';
import { toolSpecsFor } from './tools/index.js';

export const SESSION_VERSION = 1;

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nanoAiu: 0, requests: 0 };
}

export class SessionStore {
  /** `onSaveErrors(errors)` hears when a session could not be saved, or saves again (see saveErrors). */
  constructor({ sessionsDir, log, onSaveErrors = null }) {
    this.sessionsDir = sessionsDir;
    this.log = log;
    this.onSaveErrors = onSaveErrors;
    // Session id -> why its last save failed (a full disk, a locked file). The window warns while it has any.
    this.saveErrors = new Map();
    this.metas = new Map();
    this.sessions = new Map();
    this.queue = new KeyedQueue();
    this.saveStates = new Map();
    this.searchTexts = null;
  }

  async init() {
    await fsp.mkdir(this.sessionsDir, { recursive: true });
    const entries = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(this.sessionsDir, entry.name);
      try {
        const meta = await readJson(path.join(folder, 'meta.json'), null);
        if (meta?.id === entry.name) this.metas.set(meta.id, normalizeMeta(meta));
      } catch (error) {
        this.log.warn(`Session ${entry.name} has an unreadable meta.json; it is hidden from the list.`, error);
      }
    }
  }

  folder(id) {
    if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('Invalid session id.');
    return path.join(this.sessionsDir, id);
  }

  allMetas() {
    return [...this.metas.values()];
  }

  getMeta(id) {
    return this.metas.get(id) || null;
  }

  async create({ cwd, mode, model, effort, title = 'New session', worktree = null }) {
    const id = newId('s');
    const now = new Date().toISOString();
    const meta = normalizeMeta({ id, title, titleSource: null, cwd, createdAt: now, updatedAt: now, mode, model, effort, worktree });
    const session = { meta, data: emptyData() };
    this.metas.set(id, meta);
    this.sessions.set(id, session);
    await fsp.mkdir(this.folder(id), { recursive: true });
    await this.save(id);
    return session;
  }

  /**
   * Load a session.
   * - Repairs a conversation that stopped between a tool call and its result.
   * - A session saved before tool definitions were stored gets them from its tool names.
   */
  async get(id) {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const meta = this.metas.get(id);
    if (!meta) return null;
    const stored = await readJson(path.join(this.folder(id), 'session.json'), null);
    const data = { ...emptyData(), ...(stored || {}) };
    if (data.toolNames && !data.toolSpecs) data.toolSpecs = toolSpecsFor(data.toolNames);
    const session = { meta, data };
    if (repairUnansweredToolCalls(data.messages)) {
      this.log.info(`Session ${id}: added results for tool calls that never ran.`);
      this.save(id);
    }
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Save meta.json and session.json.
   * - Saves of one session never overlap. Calls made while a save waits to start share that save.
   */
  save(id) {
    let state = this.saveStates.get(id);
    if (state?.waiting) return state.promise;
    state = { waiting: true, promise: null };
    this.saveStates.set(id, state);
    // Callers often do not await saves. A failed save is logged here instead of becoming an unhandled rejection.
    state.promise = this.queue
      .run(id, async () => {
        state.waiting = false;
        const session = this.sessions.get(id);
        if (!session || !this.metas.has(id)) return;
        session.meta.messageCount = session.data.messages.length;
        await writeJsonAtomic(path.join(this.folder(id), 'session.json'), session.data, { pretty: false });
        await writeJsonAtomic(path.join(this.folder(id), 'meta.json'), session.meta);
        if (this.searchTexts) this.searchTexts.set(id, searchTextFor(session));
        this.saved(id, null);
      })
      .catch((error) => this.saved(id, error));
    return state.promise;
  }

  saveMeta(id) {
    return this.queue
      .run(id, async () => {
        const meta = this.metas.get(id);
        if (meta) await writeJsonAtomic(path.join(this.folder(id), 'meta.json'), meta);
      })
      .catch((error) => this.saved(id, error));
  }

  /** Record how a save ended; the next successful save of that session clears its error. */
  saved(id, error) {
    if (error) {
      this.log.error(`Could not save session ${id}.`, error);
      this.saveErrors.set(id, error.message);
    } else if (!this.saveErrors.delete(id)) {
      return;
    }
    this.onSaveErrors?.(Object.fromEntries(this.saveErrors));
  }

  /** Permanently delete a session folder (the user confirmed this in the app). */
  async remove(id) {
    this.metas.delete(id);
    this.sessions.delete(id);
    this.searchTexts?.delete(id);
    await this.queue.run(id, () => fsp.rm(this.folder(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }

  /**
   * Copy a session up to (not including) message `endIndex` into a new session.
   * - Keeps the frozen system prompt and tool list, so the copy continues with the same prompt cache.
   */
  async fork(id, endIndex) {
    const source = await this.get(id);
    if (!source) return null;
    const keptMessages = structuredClone(source.data.messages.slice(0, endIndex));
    const keptIds = new Set(keptMessages.map((message) => message.id));
    const checkpoints = source.data.checkpoints.filter((checkpoint) => keptIds.has(checkpoint.messageId));
    const fork = await this.create({
      cwd: source.meta.cwd,
      mode: source.meta.mode,
      model: source.meta.model,
      effort: source.meta.effort,
      title: `${source.meta.title} (fork)`,
      // The fork keeps working in the same worktree folder. Its own copy of the record tracks removal.
      worktree: source.meta.worktree ? { ...source.meta.worktree } : null,
    });
    fork.meta.titleSource = 'user';
    fork.meta.forkedFrom = id;
    Object.assign(fork.data, {
      systemPrompt: source.data.systemPrompt,
      toolNames: source.data.toolNames,
      toolSpecs: source.data.toolSpecs,
      mcpTools: structuredClone(source.data.mcpTools || null),
      messages: keptMessages,
      todos: structuredClone(source.data.todos),
      plan: source.data.plan,
      allowRules: [...source.data.allowRules],
      allowedHosts: [...source.data.allowedHosts],
      fetchHosts: [...(source.data.fetchHosts || [])],
      allowedMcpTools: [...(source.data.allowedMcpTools || [])],
      readFiles: {},
      checkpoints: structuredClone(checkpoints),
      lastMode: source.data.lastMode,
      skills: structuredClone(source.data.skills || null),
    });
    // A fork cut right after a tool call would leave it unanswered. The API rejects that.
    repairUnansweredToolCalls(fork.data.messages);
    fork.meta.usage = emptyUsage();
    fork.meta.lastInputTokens = source.meta.lastInputTokens;
    const blobs = new Set();
    for (const checkpoint of checkpoints) {
      if (checkpoint.before) blobs.add(checkpoint.before);
      if (checkpoint.after) blobs.add(checkpoint.after);
    }
    for (const blob of blobs) {
      const from = path.join(this.folder(id), 'blobs', blob);
      const to = path.join(this.folder(fork.meta.id), 'blobs', blob);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to).catch((error) => this.log.warn('Could not copy a checkpoint file to the fork.', error));
    }
    fork.meta.preview = previewFor(fork.data.messages);
    await this.save(fork.meta.id);
    return fork;
  }

  async writeBlob(id, buffer) {
    const hash = sha256(buffer);
    const file = path.join(this.folder(id), 'blobs', hash);
    if (!fs.existsSync(file)) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buffer);
    }
    return hash;
  }

  async readBlob(id, hash) {
    const buffer = await fsp.readFile(path.join(this.folder(id), 'blobs', hash));
    return buffer;
  }

  /**
   * Full-text search over titles, folders, prompts and answers.
   * - The text index is built on first use and kept current on every save.
   * - `snippetChars` and `snippetCount`: how much text around the matches each result carries in `snippets`.
   *   `snippet` is the first one.
   */
  async search(query, { limit = 50, snippetChars = 180, snippetCount = 1 } = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    if (!this.searchTexts) await this.buildSearchIndex();
    const results = [];
    for (const meta of this.metas.values()) {
      const header = `${meta.title}\n${meta.cwd}`.toLowerCase();
      const body = this.searchTexts.get(meta.id) || '';
      const haystack = `${header}\n${body}`;
      if (!terms.every((term) => haystack.includes(term))) continue;
      const titleHits = terms.filter((term) => header.includes(term)).length;
      const snippets = [];
      let position = body.indexOf(terms[0]);
      while (position >= 0 && snippets.length < snippetCount) {
        const start = Math.max(0, position - Math.round(snippetChars / 3));
        snippets.push(body.slice(start, start + snippetChars).replace(/\s+/g, ' ').trim());
        position = body.indexOf(terms[0], start + snippetChars);
      }
      results.push({ id: meta.id, title: meta.title, cwd: meta.cwd, updatedAt: meta.updatedAt, archived: meta.archived, snippet: snippets[0] || '', snippets, score: titleHits * 10 + 1 });
    }
    results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    return results.slice(0, limit);
  }

  async buildSearchIndex() {
    const texts = new Map();
    for (const id of this.metas.keys()) {
      try {
        const session = this.sessions.get(id) || { data: { messages: (await readJson(path.join(this.folder(id), 'session.json'), {})).messages || [] } };
        texts.set(id, searchTextFor(session));
      } catch (error) {
        this.log.warn(`Session ${id} could not be indexed for search.`, error);
      }
    }
    this.searchTexts = texts;
  }

  async flush() {
    await this.queue.drain();
  }
}

function emptyData() {
  return {
    version: SESSION_VERSION,
    systemPrompt: null,
    toolNames: null,
    // The tool definitions sent to the model, frozen with the session (see toolSpecsFor).
    toolSpecs: null,
    // MCP tools of the session by tool name: { server, tool, readOnly } (see prepareSession).
    mcpTools: null,
    messages: [],
    todos: [],
    plan: null,
    allowRules: [],
    // Sites the agent's browser may act on, and sites it may only read (web_fetch) without asking.
    allowedHosts: [],
    fetchHosts: [],
    // MCP tools the user allowed for the rest of the session.
    allowedMcpTools: [],
    readFiles: {},
    // Subfolders whose instruction files the agent has been given (see withFolderInstructions).
    instructionFolders: [],
    checkpoints: [],
    lastMode: null,
  };
}

function normalizeMeta(meta) {
  const normalized = {
    id: meta.id,
    title: meta.title || 'Untitled session',
    titleSource: meta.titleSource ?? null,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt || meta.createdAt,
    pinned: Boolean(meta.pinned),
    archived: Boolean(meta.archived),
    mode: meta.mode || 'ask',
    model: meta.model || null,
    effort: meta.effort || null,
    unread: Boolean(meta.unread),
    messageCount: meta.messageCount || 0,
    preview: meta.preview || '',
    usage: { ...emptyUsage(), ...(meta.usage || {}) },
    lastInputTokens: meta.lastInputTokens || 0,
    forkedFrom: meta.forkedFrom || null,
    // { repoRoot, folder, branch, cwd, sourceCwd } for a session in its own git worktree.
    worktree: meta.worktree || null,
    // { id, name, maxCredits } for a run of a scheduled task (see schedules.js).
    schedule: meta.schedule || null,
    // The month the project's 80% spending notice was shown in this session.
    spendingNoticeMonth: meta.spendingNoticeMonth || null,
  };
  return normalized;
}

/**
 * After a crash or a closed app, the last assistant message can hold tool calls without results.
 * The API rejects that, so add an error result for each missing one. Returns true when it changed anything.
 */
export function repairUnansweredToolCalls(messages) {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex === -1) return false;
  const toolUses = messages[lastAssistantIndex].content.filter((block) => block.type === 'tool_use');
  if (toolUses.length === 0) return false;
  const answered = new Set();
  for (const message of messages.slice(lastAssistantIndex + 1)) {
    if (message.role !== 'user') continue;
    for (const block of message.content) if (block.type === 'tool_result') answered.add(block.tool_use_id);
  }
  const missing = toolUses.filter((toolUse) => !answered.has(toolUse.id));
  if (missing.length === 0) return false;
  messages.push({
    id: newId('m'),
    role: 'user',
    kind: 'tool_results',
    ts: new Date().toISOString(),
    content: missing.map((toolUse) => ({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Not run: the app stopped before this tool call finished.',
      is_error: true,
      meta: { notRun: true },
    })),
  });
  return true;
}

function searchTextFor(session) {
  const parts = [];
  let length = 0;
  for (const message of session.data.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    // Summaries count too: they hold what the compacted messages said.
    const texts = message.content.filter((block) => block.type === 'text' && !block.hidden).map((block) => block.text);
    if (message.summary) texts.push(message.summary);
    for (const block of message.content) if (block.type === 'compaction' && block.content) texts.push(block.content);
    for (const text of texts) {
      parts.push(text);
      length += text.length;
    }
    if (length > 300000) break;
  }
  const text = parts.join('\n').toLowerCase();
  return text;
}

/** Last assistant text, shortened, for the session list. */
export function previewFor(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/[#*`>_|-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 160);
  }
  return '';
}
