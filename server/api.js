// REST routes for the app window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route, HttpError } from './http.js';
import { APP_VERSION } from './config.js';
import { AuthError } from './auth.js';
import { SettingsError, EFFORTS, MODES } from './settings.js';
import { ToolInputError } from './tools/fs-tools.js';
import { listProjectFiles, gitBranch, gitRoot, projectRoot } from './tools/files.js';
import { discoverSkills, publicSkill } from './skills.js';
import { sessionChanges, sessionToMarkdown } from './session-files.js';
import { pickFolder, revealInExplorer, openWithDefaultApp, openUrl, runPowerShell, agentBrowser, remoteDebuggingBlocked } from './windows.js';
import { isInside, pathKey } from './tools/paths.js';
import { promptContent } from './conversation.js';
import { usableModels } from './models.js';
import { REVIEW_PROMPT, INIT_PROMPT, COMMIT_PROMPT, PULL_REQUEST_PROMPT, PROJECT_INSTRUCTION_FILES } from './prompts.js';
import { gitChanges, removeWorktree } from './git.js';
import { discoverCommands } from './commands.js';
import { isAbortError, sleep } from './util.js';
import { validateHooks } from './hooks.js';
import { profileForFolder } from './tools/browser.js';
import { projectFolderOf } from './projects.js';
import { currentProxy, windowsProxy } from './proxy.js';
import { validateSchedules } from './schedules.js';
import { listPullRequests } from './pull-requests.js';

export function createRoutes({ config, settings, store, client, auth, agents, ledger, log, projects, updates, scheduler }) {
  const fileListCache = new Map();

  async function requireSession(id) {
    const session = await store.get(id);
    if (!session) throw new HttpError(404, 'Session not found.');
    return session;
  }

  function sessionPayload(session) {
    const runner = agents.runners.get(session.meta.id);
    const payload = {
      meta: session.meta,
      messages: session.data.messages,
      todos: session.data.todos,
      plan: session.data.plan,
      allowRules: session.data.allowRules,
      allowedHosts: session.data.allowedHosts,
      fetchHosts: session.data.fetchHosts || [],
      toolNames: session.data.toolNames,
      skills: session.data.skills ? session.data.skills.map(publicSkill) : null,
      changedFiles: new Set(session.data.checkpoints.map((checkpoint) => checkpoint.path.toLowerCase())).size,
      runtime: runner ? runner.detail() : { ...agents.runtime(session.meta.id), live: null, toolRuns: {} },
    };
    return payload;
  }

  function modelsPayload() {
    return {
      models: client.models,
      fetchedAt: client.modelsFetchedAt,
      error: client.modelsError,
      defaults: { plan: agents.defaultModelId('plan'), build: agents.defaultModelId('build'), title: agents.defaultModelId('title') },
      costs: ledger.averageCostByModel(),
    };
  }

  /** Map errors from the agent and tools to HTTP statuses the app shows to the user. */
  async function guard(work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(error.status || 401, error.message);
      if (error instanceof SettingsError || error instanceof ToolInputError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  /** The sessions that work in `worktree` (a session and its forks). */
  function worktreeUsers(worktree) {
    const users = store.allMetas().filter((meta) => meta.worktree && !meta.worktree.removed && meta.worktree.folder === worktree.folder);
    return users;
  }

  function validFolder(folder) {
    const resolved = path.resolve(String(folder || '').trim().replace(/^"|"$/g, ''));
    if (!folder || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new HttpError(400, `Folder not found: ${folder}`);
    return resolved;
  }

  /** After any sign-in (token or device code): keep the verified models and tell the windows. */
  auth.onSignedIn = async (models) => {
    try {
      await client.setModels(models);
    } catch (error) {
      log.warn('Could not cache the model list after sign-in.', error);
    }
    agents.hub.broadcast({ type: 'models', ...modelsPayload() });
    agents.hub.broadcast({ type: 'auth', auth: auth.status() });
    agents.refreshAllowance({ force: true }).catch(() => {});
  };

  return [
    route('GET', '/api/state', async () => ({
      version: APP_VERSION,
      platform: process.platform,
      user: os.userInfo().username,
      home: os.homedir(),
      dataDir: config.dataDir,
      auth: auth.status(),
      settings: settings.get(),
      extraPathDetected: settings.effectiveExtraPath(),
      efforts: EFFORTS,
      ...modelsPayload(),
      sessions: store.allMetas(),
      runtimes: Object.fromEntries([...agents.runners.entries()].map(([id, runner]) => [id, runner.summary()])),
      allowance: agents.allowanceState(),
      update: updates.status,
      saveErrors: Object.fromEntries(store.saveErrors),
    })),

    // Sessions
    route('POST', '/api/sessions', async ({ body }) =>
      guard(async () => {
        const cwd = validFolder(body.cwd);
        if (body.mode && !MODES.includes(body.mode)) throw new HttpError(400, 'Unknown mode.');
        const trust = typeof body.trust === 'boolean' ? body.trust : undefined;
        const session = await agents.createSession({ cwd, mode: body.mode, worktree: Boolean(body.worktree), trust });
        return sessionPayload(session);
      }),
    ),
    route('GET', '/api/sessions/:id', async ({ params }) => {
      const session = await requireSession(params.id);
      return sessionPayload(session);
    }),
    route('PATCH', '/api/sessions/:id', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        if (typeof body.title === 'string' && body.title.trim()) {
          session.meta.title = body.title.trim().slice(0, 120);
          session.meta.titleSource = 'user';
        }
        if (typeof body.pinned === 'boolean') session.meta.pinned = body.pinned;
        if (typeof body.archived === 'boolean') session.meta.archived = body.archived;
        if (typeof body.unread === 'boolean') session.meta.unread = body.unread;
        if (body.mode !== undefined) {
          if (!MODES.includes(body.mode)) throw new HttpError(400, 'Unknown mode.');
          if (body.mode !== session.meta.mode) await agents.changeMode(session, body.mode);
        }
        if (body.model !== undefined || body.effort !== undefined) {
          if (body.effort !== undefined && body.effort !== null && !EFFORTS.includes(body.effort)) throw new HttpError(400, 'Unknown effort level.');
          await agents.changeModel(session, body.model || null, body.effort);
        }
        await store.save(session.meta.id);
        agents.broadcastMeta(session);
        return { meta: session.meta };
      }),
    ),
    route('DELETE', '/api/sessions/:id', async ({ params }) => {
      const session = await requireSession(params.id);
      const runner = agents.runners.get(params.id);
      runner?.stop();
      runner?.stopJobs();
      // Let a stopped turn finish writing first, or it would recreate the session's folder after removal.
      for (let waited = 0; runner?.state === 'running' && waited < 5000; waited += 100) await sleep(100);
      agents.runners.delete(params.id);
      agents.browser?.closeTab(params.id).catch(() => {});
      // The session's own worktree goes with it, unless a fork still uses it or it has uncommitted work
      // (git refuses that without force). The branch always stays.
      const worktree = session.meta.worktree;
      let keptWorktree = null;
      if (worktree && !worktree.removed) {
        if (worktreeUsers(worktree).length > 1) keptWorktree = worktree.folder;
        else await removeWorktree(worktree, settings.effectiveExtraPath()).catch(() => (keptWorktree = worktree.folder));
      }
      await store.remove(session.meta.id);
      // Its reminders and loops end with it.
      const folder = projectFolderOf(session.meta);
      const schedules = projects.get(folder).schedules;
      if (schedules.some((task) => task.sessionId === params.id)) {
        await projects.update(folder, { schedules: schedules.filter((task) => task.sessionId !== params.id) });
        agents.hub.broadcast({ type: 'projects' });
      }
      agents.hub.broadcast({ type: 'session_deleted', sessionId: params.id });
      return { ok: true, keptWorktree };
    }),
    route('POST', '/api/sessions/:id/messages', async ({ params, body }) =>
      guard(async () => {
        await requireSession(params.id);
        const text = String(body.text || '');
        const images = (Array.isArray(body.images) ? body.images.slice(0, 10) : []).filter((image) => image && typeof image.mediaType === 'string' && typeof image.data === 'string');
        if (!text.trim() && images.length === 0) throw new HttpError(400, 'The message is empty.');
        // While the agent works: queued by default. `interrupt` ("Send now") stops the turn and sends this message.
        const result = await agents.runner(params.id).submit({ text, images }, { interrupt: Boolean(body.interrupt) });
        return result;
      }),
    ),
    route('POST', '/api/sessions/:id/queue/resume', async ({ params }) => {
      const session = await requireSession(params.id);
      agents.runner(params.id).resumeQueue(session);
      return { ok: true };
    }),
    route('DELETE', '/api/sessions/:id/queue', async ({ params }) => {
      const cleared = agents.runners.get(params.id)?.clearQueue() || 0;
      return { cleared };
    }),
    route('DELETE', '/api/sessions/:id/queue/:index', async ({ params, query }) => {
      const removed = agents.runners.get(params.id)?.unqueue(Number(params.index), query.get('text'));
      if (!removed) throw new HttpError(409, 'That message was already sent.');
      return { removed };
    }),
    route('POST', '/api/sessions/:id/queue/:index/send', async ({ params, query }) =>
      guard(async () => {
        const sent = await agents.runners.get(params.id)?.sendNow(Number(params.index), query.get('text'));
        if (!sent) throw new HttpError(409, 'That message was already sent.');
        return sent;
      }),
    ),
    route('POST', '/api/sessions/:id/command', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        const runner = agents.runner(params.id);
        if (body.command === 'review') {
          if (session.meta.mode !== 'plan') await agents.changeMode(session, 'plan');
          return runner.submit({ text: REVIEW_PROMPT });
        }
        if (body.command === 'init') return runner.submit({ text: INIT_PROMPT });
        if (body.command === 'commit') {
          if (session.meta.mode === 'plan') throw new HttpError(400, 'Plan mode cannot commit. Switch to another mode first.');
          return runner.submit({ text: COMMIT_PROMPT });
        }
        if (body.command === 'pr') {
          if (session.meta.mode === 'plan') throw new HttpError(400, 'Plan mode cannot open a pull request. Switch to another mode first.');
          return runner.submit({ text: PULL_REQUEST_PROMPT });
        }
        throw new HttpError(400, 'Unknown command.');
      }),
    ),
    route('POST', '/api/sessions/:id/stop', async ({ params }) => ({ stopped: agents.runners.get(params.id)?.stop() || false })),
    route('POST', '/api/sessions/:id/remember', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        const result = await agents.remember(projectFolderOf(session.meta), body.note);
        if (result.isError) throw new HttpError(400, result.content);
        return { ok: true, message: result.content };
      }),
    ),
    route('POST', '/api/sessions/:id/jobs/:job/stop', async ({ params }) => {
      agents.runners.get(params.id)?.stopJobs(params.job);
      return { ok: true };
    }),
    route('POST', '/api/sessions/:id/retry', async ({ params }) =>
      guard(async () => {
        await requireSession(params.id);
        await agents.runner(params.id).retry();
        return { ok: true };
      }),
    ),
    route('POST', '/api/sessions/:id/respond', async ({ params, body }) => {
      const runner = agents.runners.get(params.id);
      if (!runner || !runner.respond(body.waitId, body)) throw new HttpError(409, 'That request is no longer waiting for an answer.');
      return { ok: true };
    }),
    route('GET', '/api/sessions/:id/rewind', async ({ params, query }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        return agents.rewindPreview(session, query.get('messageId'));
      }),
    ),
    route('POST', '/api/sessions/:id/rewind', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        return agents.rewind(session, body.messageId, { restoreCode: Boolean(body.restoreCode), force: Boolean(body.force) });
      }),
    ),
    route('POST', '/api/sessions/:id/fork', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        let endIndex = session.data.messages.length;
        let prompt = null;
        if (body.messageId) {
          endIndex = session.data.messages.findIndex((message) => message.id === body.messageId);
          if (endIndex === -1) throw new HttpError(404, 'Message not found.');
          const target = session.data.messages[endIndex];
          if (target.role === 'user' && target.kind === 'prompt') prompt = promptContent(target);
          else endIndex += 1;
        }
        const runner = agents.runners.get(params.id);
        if (runner?.state === 'running' && endIndex >= session.data.messages.length) throw new HttpError(409, 'Stop the running turn before forking the whole session.');
        const fork = await store.fork(session.meta.id, endIndex);
        agents.broadcastMeta(fork);
        return { session: sessionPayload(fork), prompt };
      }),
    ),
    route('POST', '/api/sessions/:id/compact', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        const runner = agents.runner(params.id);
        if (runner.state === 'running') throw new HttpError(409, 'Wait for the current turn to finish, or stop it, before compacting.');
        runner.state = 'running';
        runner.abortController = new AbortController();
        runner.setStatus('compacting');
        let stopped = false;
        try {
          await agents.compact(session, { instructions: String(body.instructions || ''), reason: 'Compacted on request.', signal: runner.abortController.signal });
        } catch (error) {
          // Esc, or "interrupt and send", stops the compaction. That is not a failure.
          if (!isAbortError(error) && !runner.abortController.signal.aborted) throw error;
          stopped = true;
        } finally {
          runner.state = 'idle';
          runner.abortController = null;
          runner.setStatus(null);
          // The message that interrupted the compaction, or one sent while it ran, starts a turn now.
          runner.startNext(session);
        }
        return { ok: !stopped, stopped };
      }),
    ),
    route('GET', '/api/sessions/:id/changes', async ({ params }) => {
      const session = await requireSession(params.id);
      const changes = await sessionChanges(session, store);
      return { changes };
    }),
    route('GET', '/api/sessions/:id/git', async ({ params }) => {
      const session = await requireSession(params.id);
      if (!fs.existsSync(session.meta.cwd)) return { repo: false, reason: 'The session folder does not exist any more.' };
      // git status can run programs that a downloaded repository's own git settings name (filters).
      if (!agents.projectTrusted(session.meta)) return { repo: false, reason: 'Trust this folder on its project page to see its git changes.' };
      const changes = await gitChanges(session.meta.cwd, settings.effectiveExtraPath());
      return changes;
    }),
    route('POST', '/api/sessions/:id/worktree/remove', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        const worktree = session.meta.worktree;
        if (!worktree || worktree.removed) throw new HttpError(400, 'This session has no worktree to remove.');
        // Forks of the session work in the same worktree, so they lose it too.
        const users = worktreeUsers(worktree);
        if (users.some((meta) => agents.runners.get(meta.id)?.state === 'running')) throw new HttpError(409, 'Stop the running turn before removing the worktree.');
        try {
          await removeWorktree(worktree, settings.effectiveExtraPath(), { force: Boolean(body.force) });
        } catch (error) {
          const dirty = /modified or untracked|contains modified/i.test(error.message);
          throw new HttpError(dirty ? 409 : 400, dirty ? 'The worktree has uncommitted changes.' : `git could not remove the worktree: ${error.message}`);
        }
        for (const meta of users) {
          meta.worktree.removed = true;
          await store.saveMeta(meta.id);
          agents.broadcastMeta({ meta });
        }
        return { meta: session.meta, sessions: users.length };
      }),
    ),
    route('GET', '/api/sessions/:id/export', async ({ params, response }) => {
      const session = await requireSession(params.id);
      const markdown = sessionToMarkdown(session);
      const name = `${session.meta.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'session'}.md`;
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      response.end(markdown);
    }),
    route('GET', '/api/sessions/:id/system-prompt', async ({ params }) => {
      const session = await requireSession(params.id);
      return { systemPrompt: session.data.systemPrompt, toolNames: session.data.toolNames };
    }),
    route('POST', '/api/sessions/:id/title', async ({ params }) => {
      const session = await requireSession(params.id);
      session.meta.titleSource = 'prompt';
      await agents.generateTitle(session);
      return { meta: session.meta };
    }),
    route('GET', '/api/sessions/:id/branch', async ({ params }) => {
      const session = await requireSession(params.id);
      const branch = await gitBranch(session.meta.cwd, settings.effectiveExtraPath());
      return { branch };
    }),

    // Search and files
    route('GET', '/api/search', async ({ query }) => {
      const results = await store.search(query.get('q') || '');
      return { results };
    }),
    route('GET', '/api/files', async ({ query }) => {
      const session = await requireSession(query.get('sessionId') || '');
      const cwd = session.meta.cwd;
      let cached = fileListCache.get(cwd);
      if (!cached || Date.now() - cached.at > 30000) {
        cached = { at: Date.now(), files: (await listProjectFiles(cwd, { extraPath: settings.effectiveExtraPath() })).files };
        fileListCache.set(cwd, cached);
      }
      return { files: rankFiles(cached.files, query.get('q') || '') };
    }),
    route('POST', '/api/pick-folder', async ({ body }) => {
      const picked = await pickFolder(body.initial || '');
      return { path: picked };
    }),
    route('POST', '/api/open', async ({ body }) => {
      const target = path.resolve(String(body.path || ''));
      if (!fs.existsSync(target)) throw new HttpError(404, 'That path does not exist.');
      if (body.reveal) revealInExplorer(target);
      else if (fs.statSync(target).isDirectory()) openWithDefaultApp(target);
      // Opening a file would run it if it is a program or script. Only folders open directly.
      else throw new HttpError(400, 'Only folders can be opened directly; use reveal for files.');
      return { ok: true };
    }),
    route('GET', '/api/folders', async ({ query }) => listFolders(query.get('path'), settings.get().recentFolders)),
    route('POST', '/api/open-url', async ({ body }) => {
      let url;
      try {
        url = new URL(String(body.url || ''));
      } catch {
        throw new HttpError(400, 'That is not a web address.');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Only http and https links open from the app.');
      if (!config.noBrowser) openUrl(url.href, settings.get().browser);
      return { ok: true };
    }),

    // Settings, models, usage
    route('GET', '/api/settings', async () => ({ settings: settings.get(), extraPathDetected: settings.effectiveExtraPath() })),
    route('PUT', '/api/settings', async ({ body }) =>
      guard(async () => {
        const updated = await settings.update(body || {});
        agents.hub.broadcast({ type: 'settings', settings: updated });
        return { settings: updated };
      }),
    ),
    // The proxy in use, and the one Windows uses, as a hint for Settings → Network.
    route('GET', '/api/proxy', async () => {
      const proxy = { ...currentProxy(), windows: await windowsProxy() };
      return proxy;
    }),
    // Start one MCP server from Settings and list its tools (Settings → MCP servers → Check).
    route('POST', '/api/mcp/check', async ({ body }) => {
      const server = settings.get().mcpServers[body?.name];
      if (!server) throw new HttpError(404, 'There is no MCP server with that name in Settings.');
      const { tools, errors } = await agents.mcp.toolsFor({ servers: { [body.name]: server }, cwd: os.homedir(), extraPath: settings.effectiveExtraPath() });
      return { tools: tools.map(({ tool, readOnly }) => ({ tool, readOnly })), errors };
    }),
    route('GET', '/api/models', async ({ query }) =>
      guard(async () => {
        if (query.get('refresh') === '1') {
          await client.refreshModels();
          agents.hub.broadcast({ type: 'models', ...modelsPayload() });
        }
        return modelsPayload();
      }),
    ),
    route('POST', '/api/models/:id/enable', async ({ params }) =>
      guard(async () => {
        await client.enableModel(decodeURIComponent(params.id));
        await client.refreshModels();
        agents.hub.broadcast({ type: 'models', ...modelsPayload() });
        return modelsPayload();
      }),
    ),
    route('GET', '/api/usage', async ({ query }) => {
      const period = query.get('period') || 'month';
      const now = new Date();
      let since = null;
      if (period === 'month') since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      else if (period === '7d') since = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
      else if (period === '30d') since = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
      const summary = ledger.summary({ since });
      const sessions = summary.bySession.map((entry) => {
        const meta = store.getMeta(entry.sessionId);
        return { ...entry, title: meta ? meta.title : 'Deleted session', cwd: meta?.cwd || null, exists: Boolean(meta) };
      });
      return { period, since, ...summary, bySession: sessions, allowance: agents.allowanceState() };
    }),
    route('GET', '/api/allowance', async ({ query }) => agents.refreshAllowance({ force: query.get('refresh') === '1' })),

    // Sign-in
    route('POST', '/api/auth/token', async ({ body }) =>
      guard(async () => {
        const status = await auth.signInWithToken(body.token, verifyAccess, { remember: body.remember !== false });
        return status;
      }),
    ),
    route('POST', '/api/auth/device/start', async ({ body }) =>
      guard(async () => {
        // The window copies the code first and then opens GitHub's page through /api/open-url:
        // once that browser has focus, the app window can no longer write to the clipboard.
        const status = await auth.startDeviceFlow(verifyAccess, { remember: body.remember !== false });
        return status;
      }),
    ),

    // Projects, skills and per-model instructions
    route('GET', '/api/projects', async () => {
      const saved = projects.saved();
      return { projects: saved };
    }),
    // Open pull requests of the Caliope projects, each repository once. Only trusted folders: reading git's
    // sign-in runs the credential helper a repository's own git settings name.
    route('GET', '/api/pull-requests', async () => {
      const extraPath = settings.effectiveExtraPath();
      const endpoints = { githubApi: config.githubApi, azureDevOpsUrl: config.azureDevOpsUrl };
      const saved = projects.saved();
      const trusted = saved.filter((project) => project.trusted === true && fs.existsSync(project.folder));
      const listed = await Promise.all(
        trusted.map(async (project) => {
          try {
            const repository = await listPullRequests({ cwd: project.folder, extraPath, endpoints });
            return repository ? { ...repository, folder: project.folder, name: project.name } : null;
          } catch (error) {
            return { folder: project.folder, name: project.name, error: error.message, pullRequests: [] };
          }
        }),
      );
      const seen = new Set();
      const repositories = listed.filter(Boolean).filter((repository) => {
        const key = repository.repository ? `${repository.provider}:${repository.repository.toLowerCase()}` : repository.folder;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // Projects left out: not trusted, or their folder is gone.
      const hidden = saved.length - trusted.length;
      return { repositories, hidden };
    }),
    route('POST', '/api/projects', async ({ body }) =>
      guard(async () => {
        const raw = String(body.folder || '').trim().replace(/^"|"$/g, '');
        if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, 'Give the full path of the project folder, for example C:\\Users\\you\\Projects\\my-app.');
        const folder = path.resolve(raw);
        if (isInside(folder, config.dataDir) || isInside(config.dataDir, folder)) throw new HttpError(400, 'Choose a folder outside Caliope\'s own data folder.');
        if (!fs.existsSync(folder)) {
          if (!body.create) throw new HttpError(400, `Folder not found: ${folder}`);
          fs.mkdirSync(folder, { recursive: true });
        } else if (!fs.statSync(folder).isDirectory()) {
          throw new HttpError(400, `${folder} is a file, not a folder.`);
        }
        const project = await projects.update(folder, { name: body.name || path.basename(folder) });
        await settings.rememberFolder(folder);
        agents.hub.broadcast({ type: 'projects' });
        return { project };
      }),
    ),
    route('GET', '/api/project', async ({ query }) => {
      const folder = validFolder(query.get('folder'));
      const project = projects.get(folder);
      const extraPath = settings.effectiveExtraPath();
      const root = await projectRoot(folder, extraPath);
      const branch = await gitBranch(folder, extraPath);
      const skills = await discoverSkills({ projectRoot: project.trusted === true ? root : null, dataDir: config.dataDir, settings: settings.get() });
      const instructionFiles = [...PROJECT_INSTRUCTION_FILES, path.join('.github', 'copilot-instructions.md')].filter((name) => fs.existsSync(path.join(root, name)));
      const projectFiles = await agents.projectFilesIn(folder);
      const spentThisMonth = ledger.projectSpendThisMonth(pathKey(folder));
      return { project, root, branch, skills: skills.map(publicSkill), instructionFiles, projectFiles, spentThisMonth };
    }),
    route('PUT', '/api/project', async ({ body }) => {
      const folder = validFolder(body.folder);
      const allowedCommands = Array.isArray(body.allowedCommands) ? body.allowedCommands.map(String) : undefined;
      const allowedSites = Array.isArray(body.allowedSites) ? body.allowedSites.map(String) : undefined;
      const trusted = typeof body.trusted === 'boolean' ? body.trusted : undefined;
      const memory = typeof body.memory === 'string' ? body.memory : undefined;
      let hooks;
      if (body.hooks !== undefined) {
        try {
          hooks = validateHooks(body.hooks);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }
      const creditLimit = body.creditLimit === undefined ? undefined : Number(body.creditLimit);
      if (creditLimit !== undefined && !(creditLimit >= 0)) throw new HttpError(400, 'The monthly limit is a number of AI credits, 0 for no limit.');
      let schedules;
      if (body.schedules !== undefined) {
        try {
          schedules = validateSchedules(body.schedules, projects.get(folder).schedules);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }
      const project = await projects.update(folder, { name: body.name, instructions: body.instructions, allowedCommands, allowedSites, trusted, memory, hooks, creditLimit, schedules });
      agents.hub.broadcast({ type: 'projects' });
      return { project };
    }),
    // Run a scheduled task now (project page), outside its times.
    route('POST', '/api/project/schedules/run', async ({ body }) =>
      guard(async () => {
        const folder = validFolder(body.folder);
        const session = await scheduler.run(folder, String(body.id || ''));
        return { sessionId: session.meta.id };
      }),
    ),
    route('GET', '/api/skills', async ({ query }) => {
      const folder = query.get('folder');
      const trusted = !folder || projects.get(folder).trusted === true;
      const root = folder && trusted && fs.existsSync(folder) ? await projectRoot(folder, settings.effectiveExtraPath()) : null;
      const skills = await discoverSkills({ projectRoot: root, dataDir: config.dataDir, settings: settings.get() });
      return { skills: skills.map(publicSkill), skillsFolder: path.join(config.dataDir, 'skills') };
    }),
    // The agent's browser: one profile per project folder.
    route('GET', '/api/browser', async () => {
      // Which browser the agent drives, and whether policy forced the other one.
      const driver = agentBrowser(settings.get().browser);
      return { browser: driver.name, blocked: ['chrome', 'edge'].filter((name) => remoteDebuggingBlocked(name)) };
    }),
    route('POST', '/api/project/browser/open', async ({ body }) =>
      guard(async () => {
        const folder = validFolder(body.folder);
        await agents.browser.openWindow(profileForFolder(folder));
        return { ok: true };
      }),
    ),
    route('POST', '/api/project/browser/clear', async ({ body }) =>
      guard(async () => {
        const folder = validFolder(body.folder);
        await agents.browser.clearProfile(profileForFolder(folder));
        return { ok: true };
      }),
    ),
    // The session's Browser panel: live frames of its tab, and the user's own clicks, keys and navigation.
    route('GET', '/api/sessions/:id/browser/stream', async ({ params, query, request, response }) => {
      await requireSession(params.id);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write('retry: 2000\n\n');
      const send = (event) => {
        // A slow window skips frames instead of piling them up. Page changes always go through.
        if (event.type === 'frame' && response.writableLength > 2 * 1024 * 1024) return;
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const stop = agents.browser.watch(params.id, send, { width: query.get('width'), height: query.get('height') });
      request.on('close', stop);
    }),
    route('POST', '/api/sessions/:id/browser/input', async ({ params, body }) =>
      guard(async () => {
        await requireSession(params.id);
        await agents.browser.dispatchInput(params.id, body.events);
        return { ok: true };
      }),
    ),
    route('POST', '/api/sessions/:id/browser/navigate', async ({ params, body }) =>
      guard(async () => {
        const session = await requireSession(params.id);
        await agents.browser.navigateSession(params.id, profileForFolder(projectFolderOf(session.meta)), { url: body.url, action: body.action });
        return { ok: true };
      }),
    ),
    route('POST', '/api/sessions/:id/browser/window', async ({ params, body }) =>
      guard(async () => {
        await requireSession(params.id);
        await agents.browser.showWindow(params.id, body.visible === true);
        return { ok: true };
      }),
    ),
    route('GET', '/api/commands', async ({ query }) => {
      const folder = query.get('folder');
      const trusted = !folder || projects.get(folder).trusted === true;
      const root = folder && trusted && fs.existsSync(folder) ? await projectRoot(folder, settings.effectiveExtraPath()) : null;
      const commands = await discoverCommands(root);
      return { commands: commands.map(({ name, description, source }) => ({ name, description, source })) };
    }),
    route('GET', '/api/git', async ({ query }) => {
      const folder = validFolder(query.get('folder'));
      const extraPath = settings.effectiveExtraPath();
      const root = await gitRoot(folder, extraPath);
      const branch = root ? await gitBranch(folder, extraPath) : null;
      return { root, branch };
    }),
    route('POST', '/api/auth/device/cancel', async () => {
      auth.cancelDeviceFlow();
      return auth.status();
    }),
    route('POST', '/api/auth/logout', async () => {
      agents.stopAll();
      await auth.signOut();
      client.models = [];
      agents.allowance = null;
      agents.hub.broadcast({ type: 'models', ...modelsPayload() });
      return auth.status();
    }),

    // Updates
    route('POST', '/api/update/check', async () => updates.check()),
    route('POST', '/api/update/install', async () => {
      if (!updates.installed) throw new HttpError(400, `This copy of Caliope was unzipped by hand. Download the new version from ${updates.status.downloadUrl} and unzip it to a new folder.`);
      updates.install();
      return { ok: true };
    }),

    // Windows integration
    route('POST', '/api/shortcut', async () => {
      const desktop = path.join(os.homedir(), 'Desktop');
      // Installed with install.ps1, the folder above this version has a launcher that survives updates.
      const installedLauncher = path.join(config.appRoot, '..', 'Caliope.cmd');
      const installed = fs.existsSync(installedLauncher);
      const launcher = installed ? installedLauncher : path.join(config.appRoot, 'Caliope.cmd');
      const icon = installed ? path.join(config.appRoot, '..', 'Caliope.ico') : path.join(config.appRoot, 'assets', 'Caliope.ico');
      const script = [
        '$values = [Console]::In.ReadToEnd() -split "`n"',
        '$shell = New-Object -ComObject WScript.Shell',
        '$desktop = [Environment]::GetFolderPath("Desktop")',
        '$shortcut = $shell.CreateShortcut((Join-Path $desktop "Caliope.lnk"))',
        '$shortcut.TargetPath = $values[0].Trim()',
        '$shortcut.WorkingDirectory = $values[1].Trim()',
        'if (Test-Path -LiteralPath $values[2].Trim()) { $shortcut.IconLocation = $values[2].Trim() }',
        '$shortcut.WindowStyle = 7',
        "$shortcut.Description = 'Caliope: desktop app for GitHub Copilot'",
        '$shortcut.Save()',
        '[Console]::Out.Write((Join-Path $desktop "Caliope.lnk"))',
      ].join('\n');
      const created = await runPowerShell(script, { input: [launcher, path.dirname(launcher), icon].join('\n') });
      return { path: created.trim() || path.join(desktop, 'Caliope.lnk') };
    }),
  ];

  /** Sign-in check: the token must list usable chat models. Returns the list so it isn't fetched twice. */
  async function verifyAccess(access) {
    let models;
    try {
      models = await client.fetchModels(access);
    } catch (error) {
      // 403: the account has no Copilot seat, or its organization does not allow this app.
      if (error.status === 403) throw new AuthError(`Copilot refused this GitHub account (${error.message}). Sign in with the GitHub account that has your Copilot plan. If it does, your organization may have to allow Caliope.`, 403);
      throw error;
    }
    if (usableModels(models).length === 0) {
      throw new AuthError('Copilot accepted the sign-in but offers no chat models to this account. Check that your Copilot plan is active.', 403);
    }
    return models;
  }

}

/** Rank paths for @-mention suggestions: name matches first, then path matches, then loose matches. */
function rankFiles(files, query) {
  const needle = query.toLowerCase().replace(/\\/g, '/');
  if (!needle) return files.slice(0, 30);
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    let score = 0;
    if (name.startsWith(needle)) score = 100;
    else if (name.includes(needle)) score = 80;
    else if (lower.includes(needle)) score = 60;
    else if (isSubsequence(needle, lower)) score = 20;
    if (score > 0) scored.push({ file, score: score - Math.min(19, file.length / 20) });
  }
  scored.sort((a, b) => b.score - a.score);
  const suggestions = scored.slice(0, 30).map((item) => item.file);
  return suggestions;
}

function isSubsequence(needle, haystack) {
  let position = 0;
  for (const character of needle) {
    position = haystack.indexOf(character, position);
    if (position === -1) return false;
    position++;
  }
  return true;
}

/** Folder browser data: drives and recent folders at the top level, otherwise the subfolders of `target`. */
function listFolders(target, recentFolders) {
  if (!target) {
    const drives = [];
    for (let code = 67; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(drive)) drives.push(drive);
    }
    return { path: null, parent: null, folders: [], drives, home: os.homedir(), recent: recentFolders.filter((folder) => fs.existsSync(folder)) };
  }
  const resolved = path.resolve(target);
  let entries = [];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    throw new HttpError(400, `Cannot open ${resolved}: ${error.code || error.message}`);
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(resolved) === resolved ? null : path.dirname(resolved);
  return { path: resolved, parent, folders };
}
