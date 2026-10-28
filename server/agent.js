// The agent: runs turns for each session, asks the user for permission, and keeps the session file current.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, isAbortError, abortError, sha256 } from './util.js';
import { AuthError } from './auth.js';
import { isThinkingSignatureError, omitThinkingBlocks } from './protocol-anthropic.js';
import { protocolFor } from './protocols.js';
import { getTool, toolSpecsFor, toolNamesForNewSession, validateToolInput } from './tools/index.js';
import { killProcessTree } from './windows.js';
import { ToolInputError, formatBytes } from './tools/fs-tools.js';
import { profileForFolder } from './tools/browser.js';
import { projectRoot } from './tools/files.js';
import { discoverSkills, loadSkill } from './skills.js';
import { discoverCommands, expandCommand, fillArguments } from './commands.js';
import { createWorktree, removeWorktree } from './git.js';
import { resolvePath, displayPath, isInside, pathKey } from './tools/paths.js';
import { looksBinary } from './tools/files.js';
import { decodeText } from './tools/text-files.js';
import {
  buildSystemPrompt,
  modeReminder,
  TITLE_SYSTEM,
  titlePrompt,
  COMPACT_SYSTEM,
  compactPrompt,
  compactInstruction,
  MODE_LABELS,
  CLASSIFIER_SYSTEM,
  classifierPrompt,
  WEB_SEARCH_SYSTEM,
  webSearchPrompt,
  instructionFolders,
  folderInstructions,
} from './prompts.js';
import { apiHistory, latestCompaction, initiatorFor, historyHasImages, estimateContextTokens, renderTranscript, promptContent, recoverTodosAndPlan, isPromptTooLong } from './conversation.js';
import { defaultModelId, effortFor, guessModel, usableModels } from './models.js';
import { addToSessionUsage, fetchAllowance, NANO_AIU_PER_CREDIT } from './usage.js';
import { previewFor } from './store.js';
import { PROJECT_FILES, MAX_MEMORY_CHARS, projectFolderOf } from './projects.js';
import { streamModelRequest, errorResult, toolResultBlock } from './turn-helpers.js';
import { authorize, refusedPath, refusedBeforePrepare, hostApproved } from './permissions.js';
import { runMetaTool } from './meta-tools.js';
import { runEditHooks } from './hooks.js';
import { mcpServersFor } from './mcp.js';

const MAX_MENTION_BYTES = 256 * 1024;
const MAX_MENTION_TOTAL_CHARS = 200000;
const LIVE_FLUSH_MS = 50;
const TOOL_OUTPUT_FLUSH_MS = 120;
// File tools after whose first use in a subfolder the agent gets that folder's instruction files.
const FOLDER_INSTRUCTION_TOOLS = new Set(['read_file', 'edit_file', 'write_file', 'notebook_edit']);

/** The project reached its monthly AI-credit limit. */
class SpendingLimitError extends Error {}

export class AgentManager {
  constructor({ config, settings, store, client, auth, hub, log, ledger, browser, mcp, projects }) {
    this.browser = browser;
    this.mcp = mcp;
    this.projects = projects;
    this.config = config;
    this.settings = settings;
    this.store = store;
    this.client = client;
    this.auth = auth;
    this.hub = hub;
    this.log = log;
    this.ledger = ledger;
    this.runners = new Map();
    this.adaptations = new Map();
    this.allowance = null;
    this.allowanceError = null;
    this.allowanceFetchedAt = 0;
    this.allowancePromise = null;
  }

  runner(sessionId) {
    let runner = this.runners.get(sessionId);
    if (!runner) {
      runner = new SessionRunner(this, sessionId);
      this.runners.set(sessionId, runner);
    }
    return runner;
  }

  runtime(sessionId) {
    const runner = this.runners.get(sessionId);
    return runner ? runner.summary() : idleRuntime();
  }

  /**
   * True while a turn runs (also when it waits for the user's answer) or a background command runs, so
   * Caliope stays open when its window closes. The launcher shows the waiting session again.
   */
  isBusy() {
    return [...this.runners.values()].some((runner) => runner.busy());
  }

  /** Stop every turn; with `jobs`, also every background command (when the app closes). */
  stopAll({ jobs = false } = {}) {
    for (const runner of this.runners.values()) {
      runner.stop();
      if (jobs) runner.stopJobs();
    }
  }

  defaultModelId(role) {
    return defaultModelId(role, this.settings.get(), this.client.models);
  }

  /** The small model read-only subagents explore with (see models.js), or null when none is available. */
  exploreModel() {
    const id = this.defaultModelId('explore');
    const model = id ? this.resolveModel(id) : null;
    return model?.protocol && model.toolCalls ? model : null;
  }

  /**
   * web_search through Copilot: OpenAI's own web search on the search model (see models.js).
   * - Returns the results as numbered text with addresses, or null when no search model is available.
   */
  async searchWeb(session, query, limit, signal) {
    const id = this.defaultModelId('search');
    const model = id ? this.resolveModel(id) : null;
    if (model?.protocol !== 'responses') return null;
    const results = await this.completeText({
      session,
      modelId: model.id,
      system: WEB_SEARCH_SYSTEM,
      prompt: webSearchPrompt(query, limit),
      effort: 'low',
      kind: 'search',
      signal,
      maxTokens: 4000,
      hostedTools: [{ type: 'web_search' }],
    });
    return results;
  }

  /**
   * Change a project's memory: add `note`, replace the note `replace` with it, or remove `replace` when
   * there is no new note. Without either, only show the memory.
   * - Returns a tool result with the whole memory as it is now, so the agent also sees the user's changes.
   * - Refused when `replace` isn't a note or the memory is full (the user tidies it on the project page).
   */
  async remember(folder, note, replace = null) {
    const line = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const old = String(replace || '').replace(/\s+/g, ' ').trim().replace(/^- /, '');
    const lines = this.projects.get(folder).memory.split('\n').filter((item) => item.trim());
    const noteText = (item) => item.replace(/^- /, '').trim().toLowerCase();
    const listed = (notes) => (notes.length > 0 ? notes.join('\n') : '(no notes)');
    if (!line && !old) return { content: `The project memory:\n${listed(lines)}` };
    let notes;
    if (old) {
      const index = lines.findIndex((item) => noteText(item) === old.toLowerCase());
      if (index < 0) return { content: `No note reads "${old}". The project memory:\n${listed(lines)}`, isError: true };
      notes = line ? lines.with(index, `- ${line}`) : lines.filter((item, position) => position !== index);
    } else {
      if (lines.some((item) => noteText(item) === line.toLowerCase())) return { content: 'That note is already in the project memory.' };
      notes = [...lines, `- ${line}`];
    }
    const memory = notes.join('\n');
    if (memory.length > MAX_MEMORY_CHARS) return { content: `The project memory is full (${MAX_MEMORY_CHARS} characters). Ask the user to tidy it on the project page.`, isError: true };
    await this.projects.update(folder, { memory });
    this.hub.broadcast({ type: 'projects' });
    const result = { content: `Saved; new sessions in this project start with it. The project memory now reads:\n${listed(notes)}`, meta: { note: line, replaced: old || null } };
    return result;
  }

  /**
   * Files that steer the agent in a session in `folder`: instructions, commands, skills, MCP servers.
   * - Looks in the same folders the instructions load from: the git root down to `folder`.
   */
  async projectFilesIn(folder) {
    const root = await projectRoot(folder, this.settings.effectiveExtraPath());
    const found = new Set();
    for (const dir of instructionFolders(folder, root)) {
      for (const name of PROJECT_FILES) if (fs.existsSync(path.join(dir, name))) found.add(displayPath(folder, path.join(dir, name)));
    }
    return [...found];
  }

  /** True when the user trusts the session's project folder (asked on its first session). */
  projectTrusted(meta) {
    const trusted = this.projects.get(projectFolderOf(meta)).trusted === true;
    return trusted;
  }

  /** The MCP servers a session can use: { servers, skipped }; a project's .mcp.json counts in trusted folders. */
  async mcpServersFor(session) {
    const root = this.projectTrusted(session.meta) ? await projectRoot(session.meta.cwd, this.settings.effectiveExtraPath()) : null;
    const servers = await mcpServersFor({ settingsServers: this.settings.get().mcpServers, root });
    return servers;
  }

  /** The tool for an MCP tool name of the session (see prepareSession), or null. */
  mcpTool(session, name) {
    const entry = session.data.mcpTools?.[name];
    if (!entry) return null;
    const run = async (input, ctx) => {
      const { servers } = await this.mcpServersFor(session);
      const server = servers[entry.server];
      if (!server) throw new ToolInputError(`The MCP server "${entry.server}" is no longer set up, so its tools cannot run.`);
      const result = await this.mcp.call({ name: entry.server, server, cwd: session.meta.cwd, extraPath: ctx.extraPath, tool: entry.tool, input, signal: ctx.signal });
      return result;
    };
    const tool = { name, kind: 'mcp', server: entry.server, toolName: entry.tool, readOnly: entry.readOnly, run };
    return tool;
  }

  resolveModel(modelId) {
    if (!modelId) return null;
    return this.client.findModel(modelId) || guessModel(modelId);
  }

  /** Input tokens at which a model's conversation is compacted: the setting's share of its window (128k if unknown). */
  compactThreshold(model) {
    const share = this.settings.get().autoCompactPercent / 100;
    const threshold = Math.round((model.maxPromptTokens || 128000) * share);
    return threshold;
  }

  /**
   * True when the model compacts its conversation itself (Claude and OpenAI Responses, unless Copilot refused
   * it). That happens inside the normal request, so it stays on whatever Settings say about summaries.
   */
  compactsItself(model) {
    const native = protocolFor(model).nativeCompaction && !this.adaptationsFor(model.id).noCompaction;
    return native;
  }

  /** The model chosen in Settings for the summaries Caliope writes (other models, /compact), or null for the session's own. */
  compactionModel() {
    const chosen = this.settings.get().compactModel;
    const model = chosen ? this.resolveModel(chosen) : null;
    return model?.protocol ? model : null;
  }

  adaptationsFor(modelId) {
    let adaptations = this.adaptations.get(modelId);
    if (!adaptations) {
      adaptations = {};
      this.adaptations.set(modelId, adaptations);
    }
    return adaptations;
  }

  /**
   * New session in `cwd`. With `worktree`, the session works on its own branch in a separate git
   * worktree, so parallel sessions in one repository don't touch each other's files.
   */
  async createSession({ cwd, mode, worktree = false, trust = undefined }) {
    if (isInside(cwd, this.config.dataDir) || isInside(this.config.dataDir, cwd)) {
      throw new ToolInputError('Choose a project folder that does not contain Caliope\'s own data folder.');
    }
    // The first session in a folder asks whether to trust it, like Claude Code and Copilot CLI do.
    // `trust: null` (a scheduled task) runs without the folder's own files and leaves the question open.
    if (typeof trust === 'boolean') {
      await this.projects.update(cwd, { trusted: trust });
    } else if (trust === undefined && this.projects.get(cwd).trusted === null) {
      const files = await this.projectFilesIn(cwd);
      const error = new Error(`Caliope loads a folder's own instructions, skills, commands and MCP servers only when you trust it.${files.length ? ` This folder has: ${files.join(', ')}.` : ''}`);
      error.status = 428;
      throw error;
    }
    const settings = this.settings.get();
    const chosenMode = mode || settings.defaultMode;
    const planning = chosenMode === 'plan';
    const extraPath = this.settings.effectiveExtraPath();
    let workTree = null;
    // `git worktree add` runs the repository's own hooks (post-checkout), so only in a folder the user trusts.
    if (worktree && this.projects.get(cwd).trusted !== true) throw new ToolInputError('Trust this folder on its project page to give a session its own worktree: creating one runs the repository\'s git hooks.');
    if (worktree) {
      const name = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${newId().slice(-6)}`;
      try {
        workTree = await createWorktree(cwd, extraPath, name);
      } catch (error) {
        throw new ToolInputError(`Could not create a worktree: ${error.message}`);
      }
    }
    let session;
    try {
      session = await this.store.create({
        cwd: workTree ? workTree.cwd : cwd,
        mode: chosenMode,
        model: this.defaultModelId(planning ? 'plan' : 'build'),
        effort: planning ? settings.planEffort : settings.buildEffort,
        worktree: workTree,
      });
    } catch (error) {
      // The new worktree is still empty. Don't leave it behind.
      if (workTree) await removeWorktree(workTree, extraPath, { force: true }).catch(() => {});
      throw error;
    }
    await this.settings.rememberFolder(cwd);
    this.broadcastMeta(session);
    return session;
  }

  broadcastMeta(session) {
    // A turn can finish after its session was deleted. Don't bring it back in the list.
    if (!this.store.getMeta(session.meta.id)) return;
    this.hub.broadcast({ type: 'session', meta: session.meta, runtime: this.runtime(session.meta.id) });
  }

  appendMessage(session, message) {
    session.data.messages.push(message);
    session.meta.updatedAt = new Date().toISOString();
    if (message.role === 'assistant') session.meta.preview = previewFor(session.data.messages) || session.meta.preview;
    this.hub.broadcast({ type: 'message', sessionId: session.meta.id, message });
    this.store.save(session.meta.id);
    this.broadcastMeta(session);
  }

  updateMessage(session, message) {
    this.hub.broadcast({ type: 'message_update', sessionId: session.meta.id, message });
    this.store.save(session.meta.id);
  }

  appendEvent(session, event) {
    const message = { id: newId('m'), role: 'event', ts: new Date().toISOString(), ...event };
    this.appendMessage(session, message);
    return message;
  }

  /**
   * Switch mode. Entering or leaving plan mode also switches to that role's model and effort, the planning
   * model or the default model (both set in Settings).
   */
  async changeMode(session, mode, { effort = null, announce = true } = {}) {
    const previous = session.meta.mode;
    const settings = this.settings.get();
    session.meta.mode = mode;
    if ((previous === 'plan') !== (mode === 'plan')) {
      const planning = mode === 'plan';
      session.meta.model = this.defaultModelId(planning ? 'plan' : 'build') || session.meta.model;
      session.meta.effort = planning ? settings.planEffort : settings.buildEffort;
    }
    if (effort) session.meta.effort = effort;
    if (announce && (previous !== mode || effort)) {
      this.appendEvent(session, { kind: 'mode', mode, model: session.meta.model, effort: session.meta.effort, text: `${MODE_LABELS[mode]} mode` });
    } else {
      await this.store.save(session.meta.id);
      this.broadcastMeta(session);
    }
  }

  async changeModel(session, modelId, effort) {
    const changedModel = modelId && modelId !== session.meta.model;
    if (modelId) session.meta.model = modelId;
    if (effort !== undefined) session.meta.effort = effort;
    if (changedModel || effort !== undefined) {
      this.appendEvent(session, { kind: 'model', model: session.meta.model, effort: session.meta.effort });
    }
  }

  /** Record one Copilot request against the session, the ledger and the running turn. */
  recordUsage(session, model, usage, kind, { context = false } = {}) {
    this.ledger.record({ sessionId: session?.meta.id, project: session ? pathKey(projectFolderOf(session.meta)) : null, model: model.id, kind, usage });
    if (!session) return;
    addToSessionUsage(session.meta.usage, model.id, usage);
    if (context) session.meta.lastInputTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    const runner = this.runners.get(session.meta.id);
    if (runner && typeof usage.nanoAiu === 'number') runner.turnSpendNano += usage.nanoAiu;
    this.hub.broadcast({ type: 'usage', sessionId: session.meta.id, usage: session.meta.usage, lastInputTokens: session.meta.lastInputTokens });
  }

  /**
   * Before the agent or a subagent calls the model: the project's monthly limit, set on the project page.
   * - At the limit it throws, so the turn stops with an error. Retry continues once the limit is raised.
   * - From 80% the session shows a notice, once per month.
   * - A scheduled task's run also stops at the task's own limit.
   */
  checkSpendingLimit(session) {
    const folder = projectFolderOf(session.meta);
    const { creditLimit, schedules } = this.projects.get(folder);
    // The task's current limit, so raising it on the project page lets Retry continue. A reminder or loop
    // running in an existing session counts from where it started. A run in a new session counts from zero.
    const run = session.data.scheduledRun || session.meta.schedule;
    const runLimit = run ? (schedules.find((task) => task.id === run.id)?.maxCredits ?? run.maxCredits) : 0;
    const runSpent = (session.meta.usage.nanoAiu - (run?.fromNanoAiu || 0)) / NANO_AIU_PER_CREDIT;
    if (runLimit && runSpent >= runLimit) {
      throw new SpendingLimitError(`This run of the scheduled task "${run.name}" reached its limit of ${runLimit} AI credits. Raise it on the project page, then press Retry.`);
    }
    if (!creditLimit) return;
    const spent = this.ledger.projectSpendThisMonth(pathKey(folder)) / NANO_AIU_PER_CREDIT;
    if (spent >= creditLimit) {
      throw new SpendingLimitError(`This project reached its limit of ${creditLimit} AI credits for this month (${spent.toFixed(2)} spent). Raise the limit on the project page, then press Retry.`);
    }
    const now = new Date();
    const month = `${now.getFullYear()}-${now.getMonth() + 1}`;
    if (spent >= creditLimit * 0.8 && session.meta.spendingNoticeMonth !== month) {
      session.meta.spendingNoticeMonth = month;
      this.appendEvent(session, { kind: 'notice', text: `This project has used ${Math.floor((spent / creditLimit) * 100)}% of its ${creditLimit} AI credits for this month.` });
    }
  }

  /**
   * One request without the agent's tools (titles, compaction, the safety check, web search). Returns the reply text.
   * - `hostedTools` are tools the provider runs itself (OpenAI's web search). Only /responses models take them.
   */
  async completeText({ session, modelId, system, prompt, effort, kind, signal, maxTokens = 16000, hostedTools = [] }) {
    const model = this.resolveModel(modelId);
    if (!model?.protocol) throw new Error(`Model ${modelId} cannot be used.`);
    const history = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const outputLimit = Math.min(maxTokens, model.maxOutputTokens || maxTokens);
    const result = await streamModelRequest({
      client: this.client,
      log: this.log,
      model,
      adaptations: this.adaptationsFor(model.id),
      signal,
      makeRequest: () => {
        // Before every attempt: a failed attempt may already have used up the limit.
        if (session) this.checkSpendingLimit(session);
        return { request: { model, system, tools: [], hostedTools, history, effort: effortFor(model, effort), maxTokens: outputLimit, thinkingDisplay: 'omitted' } };
      },
      onUnfinished: (usage) => this.recordUsage(session, model, usage, kind),
    });
    this.recordUsage(session, model, result.usage, kind);
    if (result.stopReason === 'refusal') throw new Error(`${model.name} declined the request.`);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text;
  }

  /**
   * Auto mode: ask a small model whether a command (or an MCP tool call, `tool`) can run without the user's approval.
   * - The user's latest request goes along: what they asked for can run.
   * - Returns { decision: 'allow' | 'ask', reason }. Any failure or unclear answer means 'ask'.
   * - Verdicts are cached per session and request, so a repeated command costs nothing.
   */
  async classifyCommand(session, { command, cwd, description, input = null, background = false, tool = null }, signal) {
    const lastRequest = session.data.messages.findLast((message) => message.role === 'user' && message.kind === 'prompt' && !message.auto);
    const request = lastRequest ? promptContent(lastRequest).text.slice(0, 2000) : '';
    const cacheKey = `${request}\n${tool ? `${tool.server}/${tool.name}` : cwd}\n${command}\n${background}\n${input ?? ''}`;
    session.classifierCache = session.classifierCache || new Map();
    if (session.classifierCache.has(cacheKey)) return session.classifierCache.get(cacheKey);
    const modelId = this.defaultModelId('check') || session.meta.model;
    let verdict;
    try {
      const text = await this.completeText({
        session,
        modelId,
        system: CLASSIFIER_SYSTEM,
        prompt: classifierPrompt({ projectFolder: session.meta.cwd, cwd, shell: this.settings.get().shell, description, command, input, background, dataDir: this.config.dataDir, request, tool }),
        effort: 'low',
        kind: 'approval',
        signal,
        maxTokens: 4000,
      });
      const json = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] || '{}');
      verdict = json.decision === 'allow' ? { decision: 'allow', reason: String(json.reason || '') } : { decision: 'ask', reason: String(json.reason || 'The safety check was not sure about this command.') };
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      verdict = { decision: 'ask', reason: `The automatic safety check failed (${error.message}), so it asks you.` };
    }
    session.classifierCache.set(cacheKey, verdict);
    return verdict;
  }

  async generateTitle(session) {
    if (session.meta.titleSource === 'user' || session.meta.titleSource === 'model') return;
    const first = session.data.messages.find((message) => message.role === 'user' && message.kind === 'prompt');
    if (!first) return;
    const request = promptContent(first).text;
    if (!request.trim()) return;
    const modelId = this.defaultModelId('title') || session.meta.model;
    try {
      const raw = await this.completeText({ session, modelId, system: TITLE_SYSTEM, prompt: titlePrompt(request), effort: 'low', kind: 'title', maxTokens: 2000 });
      const title = raw.split('\n')[0].replace(/^["'`#*\s]+|["'`*.\s]+$/g, '').slice(0, 80);
      if (title && session.meta.titleSource !== 'user') {
        session.meta.title = title;
        session.meta.titleSource = 'model';
        await this.store.save(session.meta.id);
        this.broadcastMeta(session);
      }
    } catch (error) {
      this.log.warn(`Title generation failed for ${session.meta.id}.`, error);
    }
  }

  /**
   * Caliope's own compaction: the model summarizes the conversation and the session continues from the summary.
   * - Used for models without native compaction, for /compact, after "prompt too long", and before a model
   *   switch when the last compaction is one that only the previous GPT model can read (`modelId`).
   * - Asks with the session's own request plus a summary instruction, so the prompt cache covers it (as
   *   Claude Code does). When that does not fit or gives no summary, the model summarizes a shortened text
   *   transcript instead.
   * - The user's last messages stay word for word next to the summary, with the task list, the approved
   *   plan, and project memory saved since the session started.
   */
  async compact(session, { instructions = '', signal, reason = 'Compacted on request.', modelId = null } = {}) {
    // Messages the user sent that the model has not answered yet stay after the summary,
    // so the model still sees them as the current request.
    const messages = session.data.messages;
    let tailStart = messages.length;
    while (tailStart > 0 && (messages[tailStart - 1].role === 'event' || (messages[tailStart - 1].role === 'user' && messages[tailStart - 1].kind === 'prompt'))) tailStart--;
    // An explicit model (the GPT model that must read its own compaction), else the one from Settings, else the session's.
    const model = modelId ? this.resolveModel(modelId) : this.compactionModel() || this.resolveModel(session.meta.model || this.defaultModelId(session.meta.mode === 'plan' ? 'plan' : 'build'));
    if (!model?.protocol) throw new Error('No Copilot model is available to write the summary.');
    const effort = this.settings.get().compactEffort || session.meta.effort;
    const earlier = messages.slice(0, tailStart);
    const history = apiHistory(earlier, model.id);
    if (history.length < 2) throw new Error('There is nothing to compact yet.');
    this.checkSpendingLimit(session);
    const summary = (await this.summarizeInPlace(session, model, history, instructions, signal, effort)) || (await this.summarizeTranscript(session, model, earlier, instructions, signal, effort));
    if (!summary) throw new Error('The model returned an empty summary.');
    const extras = [];
    const recentRequests = history
      .filter((message) => message.role === 'user' && message.kind === 'prompt' && !message.auto)
      .map((message) => promptContent(message).text.trim())
      .filter(Boolean)
      .slice(-3);
    if (recentRequests.length > 0) extras.push(`The user's latest messages, word for word:\n${recentRequests.map((request) => `<message>\n${request.slice(0, 3000)}\n</message>`).join('\n')}`);
    if (session.data.todos.length > 0) extras.push(`Current task list:\n${session.data.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join('\n')}`);
    if (session.data.plan) extras.push(`Approved plan:\n${session.data.plan}`);
    const memory = this.projects.get(projectFolderOf(session.meta)).memory.trim();
    if (memory && !(session.data.systemPrompt || '').includes(memory)) extras.push(`Project memory (changed since this session started):\n${memory}`);
    const text = [
      `<conversation_summary>\n${summary}\n</conversation_summary>`,
      ...extras,
      'This summary replaces the earlier part of the conversation, which no longer fits the context window. Continue the work from here.',
      modeReminder(session.meta.mode),
    ].join('\n\n');
    const now = new Date().toISOString();
    const inserted = [
      { id: newId('m'), role: 'event', kind: 'compact', ts: now, text: reason, model: model.id },
      { id: newId('m'), role: 'user', kind: 'compact_summary', ts: now, content: [{ type: 'text', text, hidden: true }], summary },
    ];
    const insertAt = Math.min(tailStart, session.data.messages.length);
    session.data.messages.splice(insertAt, 0, ...inserted);
    session.data.lastMode = session.meta.mode;
    session.meta.lastInputTokens = Math.round(((session.data.systemPrompt || '').length + text.length) / 3.5);
    session.meta.updatedAt = now;
    await this.store.save(session.meta.id);
    if (insertAt === session.data.messages.length - inserted.length) {
      for (const message of inserted) this.hub.broadcast({ type: 'message', sessionId: session.meta.id, message });
    } else {
      this.hub.broadcast({ type: 'session_reload', sessionId: session.meta.id });
    }
    this.broadcastMeta(session);
  }

  /**
   * The summary from the session's own request (system prompt, tools, messages) plus the summary
   * instruction, or null when the request fails, is cut off, or the model calls a tool instead.
   */
  async summarizeInPlace(session, model, history, instructions, signal, effort) {
    const settings = this.settings.get();
    const request = [...history, { role: 'user', kind: 'prompt', content: [{ type: 'text', text: compactInstruction(instructions) }] }];
    try {
      const result = await streamModelRequest({
        client: this.client,
        log: this.log,
        model,
        adaptations: this.adaptationsFor(model.id),
        signal,
        makeRequest: () => {
          this.checkSpendingLimit(session);
          const summaryRequest = { model, system: session.data.systemPrompt, tools: session.data.toolSpecs, history: request, effort: effortFor(model, effort), maxTokens: Math.min(32000, model.maxOutputTokens || 32000), thinkingDisplay: settings.thinkingDisplay };
          return { request: summaryRequest };
        },
        onUnfinished: (usage) => this.recordUsage(session, model, usage, 'compact'),
      });
      this.recordUsage(session, model, result.usage, 'compact');
      const summary = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
      const usable = summary && !result.content.some((block) => block.type === 'tool_use') && !['max_tokens', 'refusal'].includes(result.stopReason);
      return usable ? summary : null;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted || error instanceof SpendingLimitError) throw error;
      this.log.warn(`Session ${session.meta.id}: the summary request on ${model.id} failed; summarizing a text transcript instead. ${error.message}`);
      return null;
    }
  }

  /** The summary of a shortened text transcript of the readable history (see renderTranscript). */
  async summarizeTranscript(session, model, messages, instructions, signal, effort) {
    const maxChars = Math.round((model.maxPromptTokens || 128000) * 0.6 * 3.5);
    const transcript = renderTranscript(apiHistory(messages), maxChars);
    const summaryEffort = ['xhigh', 'max'].includes(effort) ? 'high' : effort;
    const summary = await this.completeText({ session, modelId: model.id, system: COMPACT_SYSTEM, prompt: compactPrompt(transcript, instructions), effort: summaryEffort, kind: 'compact', signal });
    return summary;
  }

  /** What a rewind to `messageId` would do to files changed after it. */
  async rewindPreview(session, messageId) {
    const index = session.data.messages.findIndex((message) => message.id === messageId);
    if (index === -1) throw new ToolInputError('That message is not in this session.');
    const target = session.data.messages[index];
    if (target.role !== 'user' || target.kind !== 'prompt' || target.auto) throw new ToolInputError('You can only rewind to a message you wrote.');
    const removedIds = new Set(session.data.messages.slice(index).map((message) => message.id));
    const affected = session.data.checkpoints.filter((checkpoint) => removedIds.has(checkpoint.messageId));
    const byPath = new Map();
    for (const checkpoint of affected) {
      const key = pathKey(checkpoint.path);
      const entry = byPath.get(key) || { path: checkpoint.path, first: checkpoint, last: checkpoint };
      entry.last = checkpoint;
      byPath.set(key, entry);
    }
    const files = [];
    for (const entry of byPath.values()) {
      let currentHash = null;
      try {
        currentHash = sha256(await fsp.readFile(entry.path));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const conflict = currentHash !== entry.last.after;
      const action = entry.first.before === null ? 'delete' : 'restore';
      files.push({ path: entry.path, shownPath: displayPath(session.meta.cwd, entry.path), action, conflict, before: entry.first.before });
    }
    const preview = { index, prompt: promptContent(target), files };
    return preview;
  }

  /**
   * Remove the message `messageId` and everything after it. Optionally put changed files back.
   * - A file that changed again after the agent's last edit is a conflict and is skipped unless `force`.
   */
  async rewind(session, messageId, { restoreCode = false, force = false } = {}) {
    const runner = this.runners.get(session.meta.id);
    if (runner?.state === 'running') throw new ToolInputError('Stop the running turn before rewinding.');
    const preview = await this.rewindPreview(session, messageId);
    const restored = [];
    const skipped = [];
    if (restoreCode) {
      for (const file of preview.files) {
        if (file.conflict && !force) {
          skipped.push(file.shownPath);
          continue;
        }
        if (file.action === 'delete') await fsp.rm(file.path, { force: true });
        else {
          await fsp.mkdir(path.dirname(file.path), { recursive: true });
          await fsp.writeFile(file.path, await this.store.readBlob(session.meta.id, file.before));
        }
        delete session.data.readFiles[pathKey(file.path)];
        restored.push(file.shownPath);
      }
    }
    const removed = session.data.messages.splice(preview.index);
    const removedIds = new Set(removed.map((message) => message.id));
    session.data.checkpoints = session.data.checkpoints.filter((checkpoint) => !removedIds.has(checkpoint.messageId));
    const recovered = recoverTodosAndPlan(session.data.messages);
    session.data.todos = recovered.todos;
    session.data.plan = recovered.plan;
    // The removed messages may have carried the mode reminder. Send it again.
    session.data.lastMode = null;
    session.data.interrupted = false;
    session.meta.preview = previewFor(session.data.messages);
    session.meta.updatedAt = new Date().toISOString();
    const lastAssistant = [...session.data.messages].reverse().find((message) => message.role === 'assistant' && message.usage);
    session.meta.lastInputTokens = lastAssistant ? (lastAssistant.usage.input || 0) + (lastAssistant.usage.cacheRead || 0) + (lastAssistant.usage.cacheWrite || 0) : 0;
    await this.store.save(session.meta.id);
    this.hub.broadcast({ type: 'session_reload', sessionId: session.meta.id });
    this.broadcastMeta(session);
    return { prompt: preview.prompt, restored, skipped };
  }

  async refreshAllowance({ force = false } = {}) {
    if (!force && Date.now() - this.allowanceFetchedAt < 60000) return this.allowanceState();
    if (!this.allowancePromise) {
      this.allowancePromise = (async () => {
        const credentials = this.auth.githubCredentials();
        if (!credentials) {
          this.allowance = null;
          this.allowanceError = null;
          return;
        }
        try {
          this.allowance = await fetchAllowance({ githubApi: this.config.githubApi, ...credentials });
          this.allowanceError = null;
        } catch (error) {
          this.allowanceError = error.status === 401 || error.status === 403 || error.status === 404
            ? 'GitHub does not share the Copilot allowance with this kind of sign-in. Spending in this app is still tracked.'
            : error.message;
        } finally {
          this.allowanceFetchedAt = Date.now();
        }
      })().finally(() => {
        this.allowancePromise = null;
      });
    }
    await this.allowancePromise;
    const state = this.allowanceState();
    this.hub.broadcast({ type: 'allowance', ...state });
    return state;
  }

  allowanceState() {
    return { allowance: this.allowance, error: this.allowanceError };
  }
}

class SessionRunner {
  constructor(manager, sessionId) {
    this.manager = manager;
    this.id = sessionId;
    this.state = 'idle';
    this.status = null;
    this.waiting = null;
    // Messages sent while the agent works start the next turn once this one is done. Stop pauses the queue
    // until the user resumes it. A message that interrupts the turn ("Send now") waits in afterStop.
    this.queue = [];
    this.queuePaused = false;
    this.afterStop = null;
    this.abortController = null;
    this.live = null;
    this.liveDeltas = [];
    this.liveTimer = null;
    this.toolRuns = new Map();
    this.turnSpendNano = 0;
    // Commands started with run_command background: true. They outlive turns. Deleting the session
    // or closing the app stops them.
    this.jobs = new Map();
    // The chain of questions to the user. Only one is shown at a time.
    this.userWaits = Promise.resolve();
  }

  get hub() {
    return this.manager.hub;
  }

  /** True while a turn runs or waits for the user, or a background command still runs. */
  busy() {
    const busy = this.state === 'running' || [...this.jobs.values()].some((job) => job.running);
    return busy;
  }

  /** The runtime state windows show; idleRuntime() has the same shape for a session that never ran. */
  summary() {
    const summary = {
      state: this.state,
      status: this.status,
      waiting: this.waiting ? publicWaiting(this.waiting) : null,
      queue: this.queue.map((input) => input.text || ''),
      queuePaused: this.queuePaused && this.queue.length > 0,
      jobs: [...this.jobs.values()].map(({ id, command, pid, running, exitCode }) => ({ id, command, pid, running, exitCode })),
    };
    return summary;
  }

  /** Stop one background job, or all of them. */
  stopJobs(jobId = null) {
    for (const job of this.jobs.values()) {
      if (job.running && (!jobId || job.id === jobId)) killProcessTree(job.pid);
    }
  }

  /** Runtime state for a window that opens this session mid-turn. */
  detail() {
    const toolRuns = {};
    for (const [toolUseId, run] of this.toolRuns) toolRuns[toolUseId] = { output: run.output, startedAt: run.startedAt };
    return { ...this.summary(), live: this.live, toolRuns };
  }

  broadcastRuntime() {
    this.hub.broadcast({ type: 'runtime', sessionId: this.id, runtime: this.summary() });
  }

  setStatus(phase, detail = null) {
    this.status = phase ? { phase, detail, since: Date.now() } : null;
    this.broadcastRuntime();
  }

  /**
   * Accept a message from the user. While the agent works:
   * - By default it is queued and starts the next turn once the agent is done.
   * - With `interrupt` ("Send now"), or while the agent waits for an approval or an answer, the running turn
   *   stops and this message starts the next one right away, as in Claude Code.
   */
  async submit(input, { interrupt = false } = {}) {
    const session = await this.manager.store.get(this.id);
    if (!session) throw new ToolInputError('Session not found.');
    if (!this.manager.auth.status().signedIn) throw new AuthError('Sign in to GitHub Copilot first.');
    checkSessionFolder(session);
    if (this.state === 'running') {
      if (interrupt || this.waiting) {
        this.afterStop = [...(this.afterStop || []), input];
        this.abortController?.abort();
        this.broadcastRuntime();
        return { queued: false, interrupted: true };
      }
      this.queue.push(input);
      this.broadcastRuntime();
      return { queued: true };
    }
    this.start(session, [input]);
    return { queued: false };
  }

  /**
   * Take back a queued message (it has not been sent to the model yet).
   * - `text` identifies the message, so a queue that moved on since the window rendered it is handled.
   */
  unqueue(index, text = null) {
    let position = index;
    if (text !== null && this.queue[position]?.text !== text) position = this.queue.findIndex((input) => input.text === text);
    if (position < 0 || position >= this.queue.length) return null;
    const [removed] = this.queue.splice(position, 1);
    // A pause belongs to the messages that were queued when the user stopped. An empty queue is not paused.
    if (this.queue.length === 0) this.queuePaused = false;
    this.broadcastRuntime();
    return removed;
  }

  /** "Send now" on a queued message: it interrupts the running turn (or starts now when idle). */
  async sendNow(index, text = null) {
    const position = text !== null && this.queue[index]?.text !== text ? this.queue.findIndex((input) => input.text === text) : index;
    const input = this.unqueue(index, text);
    if (!input) return null;
    try {
      const result = await this.submit(input, { interrupt: true });
      return result;
    } catch (error) {
      // Not signed in, or the folder is gone: the message stays where it was.
      this.queue.splice(Math.min(Math.max(position, 0), this.queue.length), 0, input);
      this.broadcastRuntime();
      throw error;
    }
  }

  /** After a stop: send the queued messages again, one turn each. */
  resumeQueue(session) {
    this.queuePaused = false;
    if (this.state !== 'running') this.startNext(session);
    this.broadcastRuntime();
  }

  clearQueue() {
    const cleared = this.queue.splice(0);
    this.queuePaused = false;
    this.broadcastRuntime();
    return cleared.length;
  }

  /** Run the agent again without a new message (after an error). */
  async retry() {
    const session = await this.manager.store.get(this.id);
    if (this.state === 'running') return;
    if (!this.manager.auth.status().signedIn) throw new AuthError('Sign in to GitHub Copilot first.');
    checkSessionFolder(session);
    this.start(session, []);
  }

  /** Start a turn with these messages (none: run again after an error). */
  start(session, inputs) {
    this.state = 'running';
    this.abortController = new AbortController();
    this.turnSpendNano = 0;
    this.setStatus('waiting_model');
    this.run(session, inputs, this.abortController.signal)
      .catch((error) => this.manager.log.error(`Turn failed in session ${this.id}.`, error))
      .finally(() => this.finishTurn(session));
  }

  /** Stop the turn. Messages the agent has not read yet stay queued, and the queue waits until the user resumes it. */
  stop() {
    if (this.state !== 'running') return false;
    this.abortController?.abort();
    if (this.queue.length > 0) this.queuePaused = true;
    this.broadcastRuntime();
    return true;
  }

  respond(waitId, payload) {
    if (!this.waiting || this.waiting.id !== waitId) return false;
    const waiting = this.waiting;
    this.waiting = null;
    waiting.resolve(payload);
    this.setStatus('running_tool');
    return true;
  }

  async run(session, firstInputs, signal) {
    const manager = this.manager;
    try {
      await this.prepareSession(session);
      for (const input of firstInputs) await this.appendUserInput(session, input);
      await this.agentLoop(session, signal);
      if (signal.aborted) this.markInterrupted(session);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.markInterrupted(session);
        return;
      }
      manager.log.error(`Session ${this.id}: ${error.stack || error.message}`);
      const isAuth = error instanceof AuthError;
      // The project's spending limit: the card links to the project page, where the limit is raised.
      const limitProject = error instanceof SpendingLimitError ? projectFolderOf(session.meta) : undefined;
      manager.appendEvent(session, { kind: 'error', text: error.message, auth: isAuth, retryable: !isAuth, limitProject });
      if (isAuth) manager.hub.broadcast({ type: 'auth', auth: manager.auth.status() });
    }
  }

  /** A stopped turn: by the Stop button, or by a message that interrupted it (the next turn starts with that). */
  markInterrupted(session) {
    const byMessage = Boolean(this.afterStop?.length);
    session.data.interrupted = byMessage ? 'message' : 'stop';
    this.manager.appendEvent(session, { kind: 'interrupted', text: byMessage ? 'Interrupted by your message.' : 'Stopped.', byMessage });
  }

  finishTurn(session) {
    clearTimeout(this.liveTimer);
    this.live = null;
    this.liveDeltas = [];
    this.toolRuns.clear();
    this.waiting = null;
    this.state = 'idle';
    this.abortController = null;
    this.status = null;
    session.meta.unread = true;
    session.meta.updatedAt = new Date().toISOString();
    this.manager.store.save(this.id);
    this.hub.broadcast({ type: 'turn_end', sessionId: this.id, spentNanoAiu: this.turnSpendNano });
    this.manager.broadcastMeta(session);
    if (session.meta.titleSource === 'prompt') this.manager.generateTitle(session);
    this.manager.refreshAllowance({ force: true }).catch(() => {});
    this.startNext(session);
  }

  /**
   * After a turn or a compaction: the message that interrupted it goes first. Otherwise the next queued
   * message starts its own turn, unless the user stopped and the queue waits.
   */
  startNext(session) {
    const first = this.afterStop || [];
    this.afterStop = null;
    if (!this.manager.store.getMeta(this.id)) return;
    if (first.length > 0) this.start(session, first);
    else if (!this.queuePaused && this.queue.length > 0) this.start(session, [this.queue.shift()]);
    else this.broadcastRuntime();
  }

  /** Freeze the system prompt and tool list the first time the session talks to a model. */
  async prepareSession(session) {
    if (session.data.systemPrompt && session.data.toolNames) return;
    const manager = this.manager;
    const settings = manager.settings.get();
    const extraPath = manager.settings.effectiveExtraPath();
    const root = await projectRoot(session.meta.cwd, extraPath);
    // In a folder the user does not trust, its own instructions, skills and commands are not loaded.
    const trusted = manager.projectTrusted(session.meta);
    const skills = await discoverSkills({ projectRoot: trusted ? root : null, dataDir: manager.config.dataDir, settings });
    if (!session.data.toolNames) {
      const builtIn = toolNamesForNewSession({ browserTools: settings.browserTools, subagents: settings.subagents });
      // MCP tools join the list now and stay with the session, like the built-in ones.
      const { servers, skipped } = await manager.mcpServersFor(session);
      const mcp = Object.keys(servers).length > 0 ? await manager.mcp.toolsFor({ servers, cwd: session.meta.cwd, extraPath }) : { tools: [], errors: [] };
      for (const problem of [...skipped, ...mcp.errors]) manager.appendEvent(session, { kind: 'notice', text: `MCP: ${problem}` });
      session.data.toolNames = [...builtIn, ...mcp.tools.map((tool) => tool.name)];
      session.data.toolSpecs = [...toolSpecsFor(builtIn), ...mcp.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))];
      session.data.mcpTools = Object.fromEntries(mcp.tools.map((tool) => [tool.name, { server: tool.server, tool: tool.tool, readOnly: tool.readOnly }]));
    }
    const toolNames = session.data.toolNames;
    session.data.skills = skills.map(({ name, description, path: file, folder, source }) => ({ name, description, path: file, folder, source }));
    session.data.systemPrompt = await buildSystemPrompt({
      cwd: session.meta.cwd,
      settings,
      extraPath,
      toolNames,
      skills: session.data.skills,
      project: manager.projects.get(projectFolderOf(session.meta)),
      worktree: session.meta.worktree,
      subagentModels: usableModels(manager.client.models),
      subagentDefault: settings.subagentModel || session.meta.model,
      exploreDefault: settings.subagentModel ? null : manager.exploreModel()?.id || null,
      trusted,
    });
    await manager.store.save(this.id);
  }

  /**
   * Turn what the user typed into a stored message.
   * - Adds a mode reminder when the mode changed, and the content of files mentioned as @path.
   */
  async appendUserInput(session, input) {
    const content = [];
    const text = String(input.text || '').trim();
    if (text) content.push({ type: 'text', text });
    for (const image of input.images || []) {
      if (/^image\/(png|jpeg|gif|webp)$/.test(image.mediaType) && typeof image.data === 'string') content.push({ type: 'image', mediaType: image.mediaType, data: image.data });
    }
    const commandBlock = await this.customCommandBlock(session, text);
    if (commandBlock) content.push({ type: 'text', text: commandBlock, hidden: true });
    const reminders = [];
    if (session.data.lastMode !== session.meta.mode) {
      reminders.push(modeReminder(session.meta.mode));
      session.data.lastMode = session.meta.mode;
    }
    if (session.data.interrupted) {
      reminders.push(session.data.interrupted === 'message' ? '<system-reminder>The user interrupted your previous turn with the message above.</system-reminder>' : '<system-reminder>The user stopped your previous turn before it finished.</system-reminder>');
      session.data.interrupted = false;
    }
    // A run of a scheduled task: its prompt was written when the task was scheduled, not typed by the user now.
    if (input.scheduled) reminders.push(`<system-reminder>This is the scheduled task "${input.scheduled.name}" (${input.scheduled.when}), not a message the user typed. Do what it says; if it is a loop whose goal is reached, delete it with the schedule tool.</system-reminder>`);
    const attachments = await this.mentionedFiles(session, text);
    if (attachments.length > 0) content.push({ type: 'text', text: attachments.join('\n\n'), hidden: true, attachment: true });
    if (reminders.length > 0) content.push({ type: 'text', text: reminders.join('\n'), hidden: true });

    const isFirstPrompt = !session.data.messages.some((message) => message.role === 'user' && message.kind === 'prompt');
    if (isFirstPrompt && !session.meta.titleSource && text) {
      session.meta.title = text.split('\n')[0].slice(0, 60) || 'New session';
      session.meta.titleSource = 'prompt';
    }
    const message = { id: newId('m'), role: 'user', kind: 'prompt', ts: new Date().toISOString(), content };
    // Not the user's words: rewind, compaction's "user's latest messages" and the request's initiator skip it.
    if (input.scheduled) Object.assign(message, { auto: true, scheduled: input.scheduled.name });
    // A reminder or loop in an existing session has a limit per run, counted from here. A typed message ends it.
    session.data.scheduledRun = input.scheduled?.maxCredits ? { id: input.scheduled.id, name: input.scheduled.name, maxCredits: input.scheduled.maxCredits, fromNanoAiu: session.meta.usage.nanoAiu || 0 } : null;
    this.manager.appendMessage(session, message);
    return message;
  }

  /**
   * "/name text" for a custom command file or a skill: its prompt, to send along with the message.
   * - Commands win over skills with the same name. Skills added since the session started work too.
   */
  async customCommandBlock(session, text) {
    const match = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return null;
    const argumentText = (match[2] || '').trim();
    const root = this.manager.projectTrusted(session.meta) ? await projectRoot(session.meta.cwd, this.manager.settings.effectiveExtraPath()) : null;
    const command = (await discoverCommands(root)).find((item) => item.name.toLowerCase() === match[1].toLowerCase());
    if (command) {
      const expanded = await expandCommand(command, argumentText);
      const block = `<command name="${command.name}" file="${command.path}">\n${expanded}\n</command>\nThe user ran the custom command /${command.name}. Do what it asks.`;
      return block;
    }
    const skill = await this.findSkill(session, match[1]);
    if (!skill) return null;
    const instructions = fillArguments(await loadSkill(skill), argumentText);
    const block = `<skill name="${skill.name}">\n${instructions}\n</skill>\nThe user invoked the skill /${skill.name}${argumentText ? ' for the request in their message' : ''}. Follow its instructions.`;
    return block;
  }

  /**
   * A skill by name: from the session's list, else found again on disk (a skill added after the
   * session started), which then joins the session's list.
   */
  async findSkill(session, name) {
    const wanted = String(name || '').trim().replace(/^\//, '').toLowerCase();
    const known = (session.data.skills || []).find((item) => item.name.toLowerCase() === wanted);
    if (known) return known;
    const manager = this.manager;
    const root = manager.projectTrusted(session.meta) ? await projectRoot(session.meta.cwd, manager.settings.effectiveExtraPath()) : null;
    const found = (await discoverSkills({ projectRoot: root, dataDir: manager.config.dataDir, settings: manager.settings.get() })).find((item) => item.name.toLowerCase() === wanted);
    if (!found) return null;
    const skill = { name: found.name, description: found.description, path: found.path, folder: found.folder, source: found.source };
    session.data.skills = [...(session.data.skills || []), skill];
    return skill;
  }

  /** Files written as @path (or @"path with spaces") are attached so the model sees them right away. */
  async mentionedFiles(session, text) {
    const attachments = [];
    let total = 0;
    const seen = new Set();
    for (const match of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g)) {
      const raw = (match[1] || match[2] || '').replace(/[),.;:!?]+$/, '');
      if (!raw) continue;
      const absolutePath = resolvePath(session.meta.cwd, raw);
      const key = pathKey(absolutePath);
      if (seen.has(key) || refusedPath(this.manager, session, absolutePath)) continue;
      seen.add(key);
      try {
        const stat = await fsp.stat(absolutePath);
        if (!stat.isFile()) continue;
        const shownPath = displayPath(session.meta.cwd, absolutePath);
        if (stat.size > MAX_MENTION_BYTES) {
          attachments.push(`<file path="${shownPath}">(${formatBytes(stat.size)}: too large to attach; use read_file.)</file>`);
          continue;
        }
        const buffer = await fsp.readFile(absolutePath);
        if (looksBinary(buffer)) continue;
        const fileText = decodeText(buffer).text;
        if (total + fileText.length > MAX_MENTION_TOTAL_CHARS) {
          attachments.push(`<file path="${shownPath}">(Not attached: the mentioned files are too large together; use read_file.)</file>`);
          continue;
        }
        total += fileText.length;
        const numbered = fileText
          .split(/\r?\n/)
          .map((line, i) => `${i + 1}\t${line}`)
          .join('\n');
        attachments.push(`<file path="${shownPath}">\n${numbered}\n</file>`);
        session.data.readFiles[key] = { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // Not a file path. Leave the text as it is.
      }
    }
    return attachments;
  }

  /** Model calls and tool runs until the model stops asking for tools, the user stops the turn, or a denial ends it. */
  async agentLoop(session, signal) {
    const manager = this.manager;
    while (true) {
      if (signal.aborted) return;
      await this.maybeCompact(session, signal);
      const assistant = await this.callModel(session, signal);
      if (!assistant) return;
      if (assistant.content.some((block) => block.type === 'compaction')) {
        manager.appendEvent(session, { kind: 'compact', text: 'Compacted automatically by the model.', model: assistant.model });
        // The mode reminder was in the summarized messages. The next message brings it again.
        session.data.lastMode = null;
      }
      manager.appendMessage(session, assistant);
      if (assistant.stopReason === 'refusal') {
        const category = assistant.stopDetails?.category ? ` (${assistant.stopDetails.category})` : '';
        manager.appendEvent(session, { kind: 'error', text: `The model declined this request${category}. Rephrase it or switch to another model.`, retryable: false });
        return;
      }
      if (assistant.stopReason === 'max_tokens') {
        manager.appendEvent(session, { kind: 'notice', text: 'The answer reached the output limit. Send "continue" to let it go on.' });
      }
      const toolUses = assistant.content.filter((block) => block.type === 'tool_use');
      if (toolUses.length === 0) return;
      const outcome = await this.runTools(session, assistant, toolUses, signal);
      if (signal.aborted) return;
      if (outcome.followUp) {
        manager.appendMessage(session, { id: newId('m'), role: 'user', kind: 'prompt', auto: true, ts: new Date().toISOString(), content: [{ type: 'text', text: outcome.followUp, hidden: true }] });
      }
      if (outcome.stopTurn) {
        manager.appendEvent(session, { kind: 'notice', text: 'You denied an action, so the turn stopped. Tell the agent what to do instead.' });
        return;
      }
    }
  }

  /**
   * Before a model call: compact with Caliope's own summary when needed.
   * - Claude and GPT models compact themselves at the threshold (see callModel). Caliope's summary is the
   *   safety net at 95% of their window. Other models get Caliope's summary at the threshold.
   * - After a switch away from a GPT model that compacted itself, that model summarizes first: only it can
   *   read its own compaction.
   */
  async maybeCompact(session, signal) {
    const manager = this.manager;
    const model = manager.resolveModel(session.meta.model);
    if (!model) return;
    const latest = latestCompaction(session.data.messages);
    const previous = latest?.block?.encrypted && latest.message.model !== model.id ? manager.resolveModel(latest.message.model) : null;
    if (previous?.protocol) {
      this.setStatus('compacting');
      try {
        await manager.compact(session, { signal, modelId: previous.id, reason: `Compacted by ${previous.name} for the model switch: only it can read its own compaction.` });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        // The new model summarizes what it can read instead, so the failing model is not asked again every step.
        manager.log.warn(`Session ${this.id}: compaction by ${previous.id} before the model switch failed. ${error.message}`);
        await manager.compact(session, { signal, reason: 'Compacted for the model switch.' });
      }
    }
    if (!model.maxPromptTokens) return;
    const compactAt = manager.compactThreshold(model);
    const limit = manager.compactsItself(model) ? Math.max(compactAt, Math.round(model.maxPromptTokens * 0.95)) : compactAt;
    const estimate = estimateContextTokens(apiHistory(session.data.messages, model.id), session.data.systemPrompt);
    if (estimate < limit) return;
    this.setStatus('compacting');
    await manager.compact(session, { signal, reason: `Compacted automatically: the conversation reached ${limit.toLocaleString('en-US')} tokens.` });
  }

  /**
   * Stream one model response.
   * - Returns the assistant message, or null when the user stopped it (partial text is kept).
   * - Retries as streamModelRequest does, compacts once if the prompt is too long, and continues
   *   without earlier thinking once if the model refuses to replay it.
   */
  async callModel(session, signal) {
    const manager = this.manager;
    const settings = manager.settings.get();
    const modelId = session.meta.model || manager.defaultModelId(session.meta.mode === 'plan' ? 'plan' : 'build');
    if (!modelId) throw new Error('No Copilot model is available for this account. Open Settings and refresh the model list.');
    const model = manager.resolveModel(modelId);
    if (!model.protocol) throw new Error(`${model.name} only works through an endpoint this app does not support. Pick another model.`);
    const tools = session.data.toolSpecs;
    const maxTokens = Math.min(settings.maxOutputTokens, model.maxOutputTokens || settings.maxOutputTokens);
    const effort = effortFor(model, session.meta.effort);
    let compactedForLength = false;
    let omittedThinking = false;
    let streaming = false;
    let result;
    try {
      result = await streamModelRequest({
        client: manager.client,
        log: manager.log,
        model,
        adaptations: manager.adaptationsFor(model.id),
        signal,
        makeRequest: () => {
          // Before every attempt, also retries: a compaction for a too-long prompt also costs credits.
          manager.checkSpendingLimit(session);
          // Each attempt reads the history again: a compaction may have changed it.
          const history = apiHistory(session.data.messages, model.id);
          this.endLive();
          this.beginLive(model);
          this.setStatus('waiting_model');
          streaming = false;
          const compactAt = manager.compactsItself(model) ? manager.compactThreshold(model) : null;
          const request = { model, system: session.data.systemPrompt, tools, history, effort, maxTokens, thinkingDisplay: settings.thinkingDisplay, compactAt };
          const attempt = { request, initiator: initiatorFor(history), vision: historyHasImages(history) };
          return attempt;
        },
        onDeltas: (deltas) => {
          if (!streaming) this.setStatus('streaming');
          streaming = true;
          this.applyLive(deltas);
        },
        onWait: (info) => this.setStatus('retrying', info),
        onUnfinished: (usage) => manager.recordUsage(session, model, usage, 'chat'),
        onBadRequest: async (error) => {
          if (isPromptTooLong(error) && !compactedForLength) {
            compactedForLength = true;
            this.setStatus('compacting');
            await manager.compact(session, { signal, reason: 'Compacted automatically: the conversation no longer fit the model\'s context window.' });
            return true;
          }
          if (protocolFor(model).anthropic && isThinkingSignatureError(error.message) && !omittedThinking) {
            // Retrying the same history would fail forever. Continue without the earlier reasoning instead.
            omittedThinking = true;
            const count = omitThinkingBlocks(session.data.messages);
            manager.store.save(this.id);
            manager.log.warn(`Session ${this.id}: ${model.id} refused replayed thinking; left out ${count} earlier thinking blocks. ${error.message}`);
            return count > 0;
          }
          return false;
        },
      });
    } catch (error) {
      this.endLive();
      if (signal.aborted || isAbortError(error)) {
        if (error.partial?.length > 0) {
          manager.appendMessage(session, { id: newId('m'), role: 'assistant', ts: new Date().toISOString(), model: model.id, content: error.partial, stopReason: 'interrupted', interrupted: true });
        }
        return null;
      }
      throw error;
    }
    this.endLive();
    manager.recordUsage(session, model, result.usage, 'chat', { context: true });
    const assistant = {
      id: newId('m'),
      role: 'assistant',
      ts: new Date().toISOString(),
      model: model.id,
      effort,
      content: result.content,
      stopReason: result.stopReason,
      stopDetails: result.stopDetails,
      usage: result.usage,
    };
    return assistant;
  }

  beginLive(model) {
    clearTimeout(this.liveTimer);
    this.liveDeltas = [];
    this.live = { streamId: newId('l'), model: model.id, blocks: [] };
    this.hub.broadcast({ type: 'live_start', sessionId: this.id, streamId: this.live.streamId, model: model.id });
  }

  applyLive(deltas) {
    if (!this.live) return;
    for (const delta of deltas) {
      const blocks = this.live.blocks;
      if (delta.kind === 'block_start') blocks[delta.index] = { type: delta.blockType, text: '', name: delta.name || null, id: delta.id || null, inputLength: 0, done: false };
      const block = blocks[delta.index];
      if (!block) continue;
      if (delta.kind === 'text' || delta.kind === 'thinking') block.text += delta.text;
      if (delta.kind === 'tool_input') block.inputLength = delta.length;
      if (delta.kind === 'block_stop') {
        block.done = true;
        if (delta.block?.type === 'tool_use') block.input = delta.block.input;
      }
      this.liveDeltas.push(delta.kind === 'block_stop' ? { kind: 'block_stop', index: delta.index, input: delta.block?.input } : delta);
    }
    if (!this.liveTimer) {
      this.liveTimer = setTimeout(() => this.flushLive(), LIVE_FLUSH_MS);
    }
  }

  flushLive() {
    this.liveTimer = null;
    if (!this.live || this.liveDeltas.length === 0) return;
    const deltas = this.liveDeltas;
    this.liveDeltas = [];
    this.hub.broadcast({ type: 'live_delta', sessionId: this.id, streamId: this.live.streamId, deltas });
  }

  endLive() {
    if (!this.live) return;
    clearTimeout(this.liveTimer);
    this.flushLive();
    this.hub.broadcast({ type: 'live_end', sessionId: this.id, streamId: this.live.streamId });
    this.live = null;
  }

  /**
   * Run the tool calls of one step and store the results as one user message, updated as each finishes.
   * - Calls run in order, except that consecutive run_agent calls run at the same time.
   */
  async runTools(session, assistant, toolUses, signal) {
    const manager = this.manager;
    const resultsMessage = { id: newId('m'), role: 'user', kind: 'tool_results', ts: new Date().toISOString(), content: [] };
    let appended = false;
    let followUp = null;
    let stopTurn = false;
    for (let index = 0; index < toolUses.length; index++) {
      let group = [toolUses[index]];
      if (toolUses[index].name === 'run_agent') {
        while (index + 1 < toolUses.length && toolUses[index + 1].name === 'run_agent') group.push(toolUses[++index]);
      }
      let blocks;
      if (signal.aborted) blocks = group.map((toolUse) => errorResult(toolUse, 'Not run: the user stopped the turn.', { notRun: true }));
      else if (stopTurn) blocks = group.map((toolUse) => errorResult(toolUse, 'Not run: the user denied an earlier action in this step.', { notRun: true }));
      else {
        const outcomes = await Promise.all(group.map((toolUse) => this.executeTool(session, assistant, toolUse, signal)));
        blocks = outcomes.map((outcome) => outcome.block);
        for (const outcome of outcomes) {
          if (outcome.followUp) followUp = outcome.followUp;
          if (outcome.stopTurn) stopTurn = true;
        }
      }
      resultsMessage.content.push(...blocks);
      if (!appended) {
        manager.appendMessage(session, resultsMessage);
        appended = true;
      } else {
        manager.updateMessage(session, resultsMessage);
      }
    }
    return { followUp, stopTurn };
  }

  async executeTool(session, assistant, toolUse, signal) {
    const tool = getTool(toolUse.name) || this.manager.mcpTool(session, toolUse.name);
    if (!tool || !session.data.toolNames.includes(toolUse.name)) {
      return { block: errorResult(toolUse, `There is no tool named "${toolUse.name}".`) };
    }
    if (toolUse.invalidJson !== undefined) {
      return { block: errorResult(toolUse, 'The tool input was not valid JSON (it may have been cut off). Try again, splitting large content into smaller edits.') };
    }
    // MCP servers check their own input, with schemas richer than validateToolInput reads.
    const problem = tool.kind === 'mcp' ? (toolUse.input && typeof toolUse.input === 'object' && !Array.isArray(toolUse.input) ? null : 'The tool input must be a JSON object.') : validateToolInput(tool, toolUse.input);
    if (problem) return { block: errorResult(toolUse, problem) };

    this.toolRuns.set(toolUse.id, { output: '', startedAt: Date.now(), pendingOutput: '', timer: null });
    this.setStatus('running_tool', { tool: toolUse.name, toolUseId: toolUse.id });
    this.hub.broadcast({ type: 'tool_start', sessionId: this.id, toolUseId: toolUse.id, name: toolUse.name });
    try {
      if (tool.kind === 'meta') return await runMetaTool(this, session, toolUse, signal, assistant);
      const ctx = this.toolContext(session, assistant, toolUse, signal);
      const refusal = refusedBeforePrepare(this.manager, session, tool, toolUse.input);
      if (refusal) return { block: errorResult(toolUse, refusal, { denied: true }) };
      const prepared = tool.prepare ? await tool.prepare(toolUse.input, ctx) : null;
      const decision = await authorize(this, session, tool, toolUse, prepared, signal, ctx);
      if (!decision.allowed) return { block: errorResult(toolUse, decision.message, { denied: true }), stopTurn: decision.stopTurn };
      const result = await this.runWithHooks(session, tool, toolUse, ctx, prepared);
      const withInstructions = ctx.trusted ? await this.withFolderInstructions(session, toolUse, result) : result;
      return { block: toolResultBlock(toolUse, withInstructions) };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return { block: errorResult(toolUse, 'Stopped by the user.', { interrupted: true }) };
      if (error instanceof ToolInputError) return { block: errorResult(toolUse, error.message) };
      this.manager.log.error(`Tool ${toolUse.name} failed.`, error);
      return { block: errorResult(toolUse, `The tool failed: ${error.message}`) };
    } finally {
      this.flushToolOutput(toolUse.id);
      this.toolRuns.delete(toolUse.id);
      this.hub.broadcast({ type: 'tool_end', sessionId: this.id, toolUseId: toolUse.id });
    }
  }

  /**
   * The first time a file tool works in a subfolder of the project, that folder's instruction files join its
   * result (see folderInstructions), as Claude Code does. Only in trusted folders: the files steer the agent.
   */
  async withFolderInstructions(session, toolUse, result) {
    if (result.isError || !FOLDER_INSTRUCTION_TOOLS.has(toolUse.name) || typeof toolUse.input.path !== 'string') return result;
    // Sessions from before this list have none yet.
    session.data.instructionFolders = session.data.instructionFolders || [];
    const items = await folderInstructions(session.meta.cwd, resolvePath(session.meta.cwd, toolUse.input.path), session.data.instructionFolders);
    if (items.length === 0) return result;
    const blocks = items.map((item) => `<instructions source="${item.source}">\n${item.text}\n</instructions>`).join('\n\n');
    const note = `<system-reminder>\nInstruction files for this part of the project. Follow them for the files in their folder.\n\n${blocks}\n</system-reminder>`;
    const content = Array.isArray(result.content) ? [...result.content, { type: 'text', text: note }] : `${result.content}\n\n${note}`;
    const withInstructions = { ...result, content };
    return withInstructions;
  }

  /** Run an approved tool call; after a successful edit, the project's hooks (hooks.js) run and their output joins the result. */
  async runWithHooks(session, tool, toolUse, ctx, prepared) {
    const result = await tool.run(toolUse.input, ctx, prepared);
    const hooks = this.manager.projects.get(projectFolderOf(session.meta)).hooks;
    if (tool.kind !== 'edit' || result.isError || hooks.length === 0) return result;
    const checks = await runEditHooks(hooks, { cwd: session.meta.cwd, file: prepared.absolutePath, shell: ctx.settings.shell, extraPath: ctx.extraPath, tmpDir: ctx.tmpDir, signal: ctx.signal });
    if (checks.length === 0) return result;
    const report = checks.map((check) => `Hook \`${check.command}\` (exit code ${check.exitCode ?? 'none'}${check.timedOut ? ', timed out' : ''}):\n${check.output || '(no output)'}`).join('\n\n');
    const withHooks = { ...result, content: `${result.content}\n\n${report}`, meta: { ...result.meta, hooks: checks } };
    return withHooks;
  }

  toolContext(session, assistant, toolUse, signal) {
    const manager = this.manager;
    const realFolders = new Map();
    const ctx = {
      cwd: session.meta.cwd,
      settings: manager.settings.get(),
      extraPath: manager.settings.effectiveExtraPath(),
      tmpDir: manager.config.tmpDir,
      endpoints: { githubApi: manager.config.githubApi, azureDevOpsUrl: manager.config.azureDevOpsUrl },
      // Whether the user trusts the project folder: git's sign-in runs the helper its own git settings name.
      trusted: manager.projectTrusted(session.meta),
      signal,
      readFiles: session.data.readFiles,
      recordRead: (absolutePath, stat) => {
        session.data.readFiles[pathKey(absolutePath)] = { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      checkpoint: async (absolutePath, beforeBuffer, afterBuffer) => {
        const before = beforeBuffer ? await manager.store.writeBlob(this.id, beforeBuffer) : null;
        const after = await manager.store.writeBlob(this.id, afterBuffer);
        session.data.checkpoints.push({ id: newId('c'), messageId: assistant.id, toolUseId: toolUse.id, path: absolutePath, before, after, ts: new Date().toISOString() });
      },
      emitOutput: (text) => this.toolOutput(toolUse.id, text),
      searchWeb: (query, limit) => manager.searchWeb(session, query, limit, signal),
      browser: manager.browser,
      browserProfile: profileForFolder(projectFolderOf(session.meta)),
      // A site the user allowed once for this call (see authorize) counts as approved for this call only.
      approvedHost: null,
      hostApproved: (host) => host === ctx.approvedHost || hostApproved(session, host, manager.projects.get(projectFolderOf(session.meta)).allowedSites),
      sessionId: this.id,
      // grep and glob skip sign-in data and protected files, also when they search a parent folder.
      isHidden: (absolutePath) => Boolean(refusedPath(manager, session, absolutePath, { realFolders })),
      jobs: {
        add: (job) => {
          this.jobs.set(job.id, job);
          this.broadcastRuntime();
        },
        get: (jobId) => this.jobs.get(jobId),
        onExit: () => this.broadcastRuntime(),
      },
    };
    return ctx;
  }

  toolOutput(toolUseId, text) {
    const run = this.toolRuns.get(toolUseId);
    if (!run) return;
    run.output += text;
    if (run.output.length > 200000) run.output = run.output.slice(run.output.length - 200000);
    run.pendingOutput += text;
    if (!run.timer) run.timer = setTimeout(() => this.flushToolOutput(toolUseId), TOOL_OUTPUT_FLUSH_MS);
  }

  flushToolOutput(toolUseId) {
    const run = this.toolRuns.get(toolUseId);
    if (!run) return;
    clearTimeout(run.timer);
    run.timer = null;
    if (!run.pendingOutput) return;
    const text = run.pendingOutput;
    run.pendingOutput = '';
    this.hub.broadcast({ type: 'tool_output', sessionId: this.id, toolUseId, text });
  }

  /**
   * Pause until the user answers in the app (or stops the turn).
   * - Parallel subagents can ask at the same time. Their questions are shown one after another.
   */
  waitForUser(payload, signal) {
    const turn = this.userWaits.then(() => this.showWait(payload, signal));
    this.userWaits = turn.catch(() => {});
    return turn;
  }

  showWait(payload, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        if (this.waiting?.id === waiting.id) this.waiting = null;
        reject(abortError());
      };
      const waiting = {
        id: newId('w'),
        ...payload,
        resolve: (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
      };
      this.waiting = waiting;
      signal.addEventListener('abort', onAbort, { once: true });
      this.setStatus('waiting_user', { kind: payload.kind });
      this.hub.broadcast({ type: 'waiting', sessionId: this.id, waiting: publicWaiting(waiting) });
    });
  }
}

/**
 * Refuse to start a turn without the session folder: the agent's tools would otherwise
 * recreate a removed worktree as a plain folder.
 */
function checkSessionFolder(session) {
  const worktree = session.meta.worktree;
  if (worktree?.removed) throw new ToolInputError(`This session's worktree was removed, so the agent cannot work in it any more. Its branch ${worktree.branch} is still in the repository; start a new session to continue.`);
  if (!fs.existsSync(session.meta.cwd)) throw new ToolInputError(`The project folder ${session.meta.cwd} does not exist any more.`);
}

function publicWaiting(waiting) {
  const copy = { ...waiting };
  delete copy.resolve;
  return copy;
}

/** The runtime state of a session that has no runner: the shape of SessionRunner.summary(). */
function idleRuntime() {
  return { state: 'idle', status: null, waiting: null, queue: [], queuePaused: false, jobs: [] };
}
