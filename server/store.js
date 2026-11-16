// Session storage. Each session is a folder under sessions/:
//   meta.json     small summary used for the session list
//   session.json  the conversation, frozen system prompt, todos, permissions, checkpoints
//   blobs/        file contents saved before and after each edit, for rewind, and the images in messages
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, readJson, writeJsonAtomic, writeFileAtomic, KeyedQueue, sha256, mapLimit } from './util.js';
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
    // Session id -> its load from disk while it runs, so callers at the same time get the same session object.
    this.loads = new Map();
    // Image block -> the blob that holds it, for images already in the session's blobs/ folder.
    this.imageBlobs = new WeakMap();
    this.queue = new KeyedQueue();
    this.saveStates = new Map();
    this.searchTexts = null;
  }

  async init() {
    await fsp.mkdir(this.sessionsDir, { recursive: true });
    const entries = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const metas = await mapLimit(folders, 16, async (name) => {
      try {
        const meta = await readJson(path.join(this.sessionsDir, name, 'meta.json'), null);
        return meta?.id === name ? meta : null;
      } catch (error) {
        this.log.warn(`Session ${name} has an unreadable meta.json; it is hidden from the list.`, error);
        return null;
      }
    });
    for (const meta of metas) if (meta) this.metas.set(meta.id, normalizeMeta(meta));
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
   * A session, loaded from disk the first time.
   * - Calls while it loads share that load: a second copy would lose what is added to the first.
   */
  async get(id) {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    if (!this.metas.has(id)) return null;
    let loading = this.loads.get(id);
    if (!loading) {
      loading = this.load(id).finally(() => this.loads.delete(id));
      this.loads.set(id, loading);
    }
    const session = await loading;
    return session;
  }

  /**
   * Read session.json and the images in blobs/.
   * - Repairs a conversation that stopped between a tool call and its result.
   * - A session saved before tool definitions were stored gets them from its tool names.
   */
  async load(id) {
    const meta = this.metas.get(id);
    const stored = await readJson(path.join(this.folder(id), 'session.json'), null);
    const data = { ...emptyData(), ...(stored || {}) };
    if (data.toolNames && !data.toolSpecs) data.toolSpecs = toolSpecsFor(data.toolNames);
    await this.loadImages(id, data.messages);
    const session = { meta, data };
    this.sessions.set(id, session);
    if (repairUnansweredToolCalls(data.messages)) {
      this.log.info(`Session ${id}: added results for tool calls that never ran.`);
      this.save(id);
    }
    return session;
  }

  /**
   * Put the images that session.json refers to back into their messages.
   * - Sessions saved before images went to blobs/ hold the images in session.json. They load as they are.
   * - An image whose file is missing from the session folder becomes a short note, so the session's requests
   *   still work.
   * - Any other read error (a file that antivirus or OneDrive holds) fails the load. The image is then still
   *   there the next time the session opens.
   */
  async loadImages(id, messages) {
    const references = imageBlocks(messages).filter((image) => image.blob);
    await mapLimit(references, 8, async (image) => {
      try {
        image.data = (await this.readBlob(id, image.blob)).toString('base64');
        this.imageBlobs.set(image, image.blob);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.log.warn(`Session ${id}: an image file is missing from its blobs folder.`, error);
        delete image.mediaType;
        Object.assign(image, { type: 'text', text: '(An image was here, but its file is missing from the session folder.)' });
      }
      delete image.blob;
    });
  }

  /** Write the images that are not in blobs/ yet: new ones, and those of sessions saved before images went there. */
  async saveImages(id, messages) {
    for (const image of imageBlocks(messages)) {
      // An image block without base64 text (a malformed MCP result) stays in session.json as it is.
      if (this.imageBlobs.has(image) || typeof image.data !== 'string') continue;
      const hash = await this.writeBlob(id, Buffer.from(image.data, 'base64'));
      this.imageBlobs.set(image, hash);
    }
  }

  /**
   * Save meta.json and session.json.
   * - Saves of one session never overlap. Calls made while a save waits to start share that save.
   * - Images go to blobs/ once. session.json refers to them by their hash, so it stays small.
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
        await this.saveImages(id, session.data.messages);
        const stored = { ...session.data, messages: withImageReferences(session.data.messages, this.imageBlobs) };
        await writeJsonAtomic(path.join(this.folder(id), 'session.json'), stored, { pretty: false });
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

  /**
   * Save file contents or an image under its hash.
   * - Written through a temporary file, so a crash never leaves half a blob.
   * - A blob of the same size is already complete and stays as it is. A blob of another size (cut off by an
   *   older version) is written again.
   */
  async writeBlob(id, buffer) {
    const hash = sha256(buffer);
    const file = path.join(this.folder(id), 'blobs', hash);
    const existing = await fsp.stat(file).catch(() => null);
    if (existing?.size !== buffer.length) await writeFileAtomic(file, buffer);
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
    // A pattern per word that ignores case. The index keeps the text as written, so it is searched without a
    // lowercase copy per query, and snippets show the text that way.
    const terms = String(query).split(/\s+/).filter(Boolean).map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    if (terms.length === 0) return [];
    if (!this.searchTexts) await this.buildSearchIndex();
    const results = [];
    for (const meta of this.metas.values()) {
      const header = `${meta.title}\n${meta.cwd}`;
      const text = this.searchTexts.get(meta.id) || '';
      if (!terms.every((term) => term.test(header) || term.test(text))) continue;
      const titleHits = terms.filter((term) => term.test(header)).length;
      const snippets = [];
      const firstTerm = new RegExp(terms[0].source, 'gi');
      let match = firstTerm.exec(text);
      while (match && snippets.length < snippetCount) {
        const start = Math.max(0, match.index - Math.round(snippetChars / 3));
        snippets.push(text.slice(start, start + snippetChars).replace(/\s+/g, ' ').trim());
        firstTerm.lastIndex = start + snippetChars;
        match = firstTerm.exec(text);
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
    // The months the 80% spending notices were shown in this session: for the project's limit, and for the
    // limit in Settings (see checkMonthlyLimit).
    spendingNoticeMonth: meta.spendingNoticeMonth || null,
    settingsSpendingNoticeMonth: meta.settingsSpendingNoticeMonth || null,
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

/** The image blocks of the messages: in the user's prompts and in tool results (screenshots, PDF pages). */
function imageBlocks(messages) {
  const images = [];
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block.type === 'image') images.push(block);
      if (block.type === 'tool_result' && Array.isArray(block.content)) images.push(...block.content.filter((part) => part.type === 'image'));
    }
  }
  return images;
}

/**
 * The messages as session.json stores them: each image saved in blobs/ as { type: 'image', mediaType, blob }.
 * - Only messages with images are copied. The session in memory keeps its images.
 */
function withImageReferences(messages, imageBlobs) {
  const reference = (part) => (part.type === 'image' && imageBlobs.has(part) ? { type: 'image', mediaType: part.mediaType, blob: imageBlobs.get(part) } : part);
  const stored = messages.map((message) => {
    if (imageBlocks([message]).length === 0) return message;
    const content = message.content.map((block) => (block.type === 'tool_result' && Array.isArray(block.content) ? { ...block, content: block.content.map(reference) } : reference(block)));
    return { ...message, content };
  });
  return stored;
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
  const text = parts.join('\n');
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
