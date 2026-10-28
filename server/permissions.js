// Permissions: whether a tool call may run, and the question to the user when it has to ask first.
import fs from 'node:fs';
import path from 'node:path';
import { changePreview } from './tools/fs-tools.js';
import { commandAllowed, suggestPrefix } from './tools/shell.js';
import { isBrowserReadAction } from './tools/browser.js';
import { resolvePath, displayPath, isInside } from './tools/paths.js';
import { protectedPattern } from './protected-files.js';
import { projectFolderOf } from './projects.js';
import { repositoryName } from './pull-requests.js';
import { truncateMiddle } from './util.js';

/**
 * Decide whether a tool call of `runner`'s session may run, asking the user when the mode requires it.
 * Modes: ask (approve changes), edits (file edits in the project run), auto (edits run, and a small model
 * decides per command whether to ask), plan (read only), full (everything runs).
 * - Reading is always allowed, except the files refusedPath names.
 * - Changes outside the project folder ask in every mode except full access.
 * - `agentLabel` names the subagent that asks, so the user knows who it is.
 * - Returns { allowed: true } or { allowed: false, message, stopTurn }.
 */
export async function authorize(runner, session, tool, toolUse, prepared, signal, ctx, agentLabel = null) {
  const manager = runner.manager;
  const mode = session.meta.mode;
  const allowed = { allowed: true };
  const ask = (request) => askPermission(runner, session, toolUse, agentLabel ? { ...request, agent: agentLabel } : request, signal);
  // File paths and plan mode for pull requests were checked before the tool's prepare step (refusedBeforePrepare).
  if (tool.kind === 'read') return allowed;
  if (tool.kind === 'browser') {
    // Looking is free. Opening a new site needs approval once per session. Acting on a page
    // (click, type, keys) needs an approved site (in Auto: the safety check), and always asks in plan mode.
    const action = toolUse.input.action;
    if (mode === 'full' || isBrowserReadAction(toolUse.input)) return allowed;
    const host = await tool.targetHost(toolUse.input, ctx);
    // The action only runs while the page is still on this site (see the browser tool's run).
    ctx.actingHost = host;
    const hostAllowed = !host || session.data.allowedHosts.includes(host) || manager.projects.get(projectFolderOf(session.meta)).allowedSites.includes(host);
    // Auto mode opens and clicks and types on pages of this PC, the app being built. Other sites need an
    // approved site or the safety check. Plan mode always asks.
    if (action === 'navigate' && (hostAllowed || (mode === 'auto' && isLocalHost(host)))) return allowed;
    if (action !== 'navigate' && mode !== 'plan' && (hostAllowed || (mode === 'auto' && isLocalHost(host)))) return allowed;
    // Name the element, so the prompt says what "[7]" is.
    const label = Number.isInteger(toolUse.input.ref) ? await tool.refLabel(toolUse.input, ctx) : null;
    const element = toolUse.input.ref ? `element [${toolUse.input.ref}]${label ? ` "${label}"` : ''}` : '';
    const detail = browserDetail(toolUse.input, element);
    const request = { request: 'browser', tool: tool.name, action, url: toolUse.input.url || null, host, detail, planMode: mode === 'plan' };
    // Auto mode, a page on another site: its address could carry data out, so the safety check reads every
    // address. Its verdict counts for this page only.
    if (mode === 'auto' && action === 'navigate') {
      const verdict = await manager.classifyCommand(session, { command: `Open ${toolUse.input.url} in the agent's own browser (load and read the page)`, cwd: '.', description: 'Open a web page', tool: { server: 'built-in', name: 'browser' } }, signal);
      if (verdict.decision === 'allow') return allowed;
      const permission = await ask({ ...request, reason: verdict.reason });
      if (permission.allowed) ctx.approvedHost = host;
      return permission;
    }
    // Auto mode, as in Claude Code: no site approvals. The safety check judges the first action on a site against
    // the user's request. When it fits, the agent acts on that site for the rest of the session.
    if (mode === 'auto' && host) {
      const verdict = await manager.classifyCommand(session, { command: `Act on ${host} in the agent's own browser, where the user may be signed in, for the rest of this session (clicks, typing, keys, scripts in the page). First action: ${detail}`, cwd: '.', description: 'Use this site for the user\'s request', tool: { server: 'built-in', name: 'browser' } }, signal);
      if (verdict.decision === 'allow') {
        session.data.allowedHosts.push(host);
        return allowed;
      }
      const permission = await ask({ ...request, reason: verdict.reason });
      if (permission.allowed) ctx.approvedHost = host;
      return permission;
    }
    const permission = await ask(request);
    // Allowed once: the agent may see this site's page after this action (not a site it redirects to).
    if (permission.allowed) ctx.approvedHost = host;
    return permission;
  }
  if (tool.kind === 'edit') {
    if (mode === 'plan') return { allowed: false, message: 'Plan mode is on, so files cannot be changed. Finish your research and call present_plan.' };
    // Judge the file the edit really changes: a short name (GIT~1 for .git) or a link spells it differently.
    const projectFolder = realPath(session.meta.cwd);
    const target = realPath(prepared.absolutePath);
    const inside = isInside(projectFolder, target);
    const steering = inside ? steeringFileWarning(path.relative(projectFolder, target)) : null;
    if (mode === 'full' || ((mode === 'edits' || mode === 'auto') && inside && !steering)) return allowed;
    const request = { request: 'edit', tool: tool.name, path: prepared.shownPath, outside: !inside, warning: steering, preview: changePreview(prepared) };
    // Auto mode, a file outside the project: the safety check decides, as for commands and in Claude Code. A file
    // that gives the agent tools or commands always asks.
    if (mode === 'auto' && !steering) {
      const change = truncateMiddle(JSON.stringify({ ...toolUse.input, path: target }, null, 2), 4000);
      const verdict = await manager.classifyCommand(session, { command: change, cwd: '.', description: 'Create or change a file outside the project folder', tool: { server: 'built-in', name: tool.name } }, signal);
      if (verdict.decision === 'allow') return allowed;
      return ask({ ...request, reason: verdict.reason });
    }
    return ask(request);
  }
  if (tool.kind === 'command') {
    const command = toolUse.input.command;
    const input = typeof toolUse.input.input === 'string' ? toolUse.input.input : null;
    const cwd = toolUse.input.cwd || '.';
    if (isInside(manager.config.dataDir, resolvePath(session.meta.cwd, cwd))) {
      return { allowed: false, message: 'Commands may not run in Caliope\'s own data folder, which holds the sign-in and the sessions.' };
    }
    const request = { request: 'command', tool: tool.name, command, description: toolUse.input.description || '', cwd, suggestedPrefix: suggestPrefix(command), input };
    if (mode === 'full') return allowed;
    // Plan mode only looks around: every command asks, so nothing changes without the user seeing it.
    if (mode === 'plan') return ask(request);
    // An allow rule names a program, not what it reads on standard input ("python -" runs any input).
    const projectRules = manager.projects.get(projectFolderOf(session.meta)).allowedCommands;
    const prefixes = [...manager.settings.get().allowedCommands, ...projectRules, ...session.data.allowRules];
    if (input === null && commandAllowed(command, prefixes)) return allowed;
    if (mode === 'auto') {
      const verdict = await manager.classifyCommand(session, { command, cwd, description: request.description, input, background: Boolean(toolUse.input.background) }, signal);
      if (verdict.decision === 'allow') return allowed;
      return ask({ ...request, reason: verdict.reason });
    }
    return ask(request);
  }
  if (tool.kind === 'pull_request') {
    // Publishing: always asks, except with full access.
    if (mode === 'full') return allowed;
    const { remote, branch, uncommitted } = prepared;
    const request = { request: 'pull_request', tool: tool.name, provider: remote.provider, repository: repositoryName(remote), branch, target: toolUse.input.target_branch || null, draft: Boolean(toolUse.input.draft), uncommitted, title: String(toolUse.input.title || ''), description: truncateMiddle(String(toolUse.input.description || ''), 4000) };
    return ask(request);
  }
  if (tool.kind === 'merge') {
    // Merging changes the target branch for everyone: it asks every time, also with full access.
    const { provider, repository, number, title, url, source, target, headSha, methods, method, warnings } = prepared;
    const permission = await ask({ request: 'merge', tool: tool.name, provider, repository, number, title, url, source, target, headSha, methods, method, deleteBranch: Boolean(toolUse.input.delete_branch), warnings });
    // The card lets the user pick the merge method and whether the branch is deleted.
    if (permission.allowed && methods.includes(permission.answer?.method)) prepared.method = permission.answer.method;
    if (permission.allowed && typeof permission.answer?.deleteBranch === 'boolean') prepared.deleteBranch = permission.answer.deleteBranch;
    return permission;
  }
  if (tool.kind === 'mcp') {
    // Tools the server marks read-only run without asking, also in plan mode.
    if (mode === 'full' || tool.readOnly) return allowed;
    if (mode === 'plan') return { allowed: false, message: `Plan mode is on, and ${tool.name} is not marked read-only by its MCP server, so it cannot run now. Finish your research and call present_plan.` };
    if (session.data.allowedMcpTools?.includes(tool.name)) return allowed;
    const request = { request: 'mcp', tool: tool.name, server: tool.server, toolName: tool.toolName, input: truncateMiddle(JSON.stringify(toolUse.input, null, 2), 4000) };
    // Auto mode: the same safety check as for commands decides whether this call needs the user.
    if (mode === 'auto') {
      const verdict = await manager.classifyCommand(session, { command: request.input, cwd: '.', description: String(tool.description || '').slice(0, 500), tool: { server: tool.server, name: tool.toolName } }, signal);
      if (verdict.decision === 'allow') return allowed;
      return ask({ ...request, reason: verdict.reason });
    }
    return ask(request);
  }
  if (tool.kind === 'web') {
    const host = tool.targetHost(toolUse.input);
    const approved = host && ((session.data.fetchHosts || []).includes(host) || session.data.allowedHosts.includes(host));
    if (mode === 'full' || approved) return allowed;
    const request = { request: 'web', tool: tool.name, url: toolUse.input.url || null, query: toolUse.input.query || null, host };
    // Auto mode: a search sends only its query. A fetched address could carry data out, so the safety check
    // reads every address on a site the user has not approved.
    if (mode === 'auto') {
      if (tool.name === 'web_search') return allowed;
      const verdict = await manager.classifyCommand(session, { command: `Fetch ${toolUse.input.url} (read the page as text)`, cwd: '.', description: 'Read a web page', tool: { server: 'built-in', name: tool.name } }, signal);
      if (verdict.decision === 'allow') return allowed;
      return ask({ ...request, reason: verdict.reason });
    }
    return ask(request);
  }
  return allowed;
}

/**
 * Ask the user about one tool call and apply "allow for this session" or "allow in this project".
 * - Returns { allowed: true } or { allowed: false, message, stopTurn }. A denial without feedback stops the turn.
 */
export async function askPermission(runner, session, toolUse, request, signal) {
  const manager = runner.manager;
  const answer = await runner.waitForUser({ kind: 'permission', toolUseId: toolUse.id, ...request }, signal);
  if (answer.decision === 'allow') return { allowed: true, answer };
  if (answer.decision === 'allow_project' && request.request === 'command') {
    const prefix = String(answer.prefix || request.suggestedPrefix || '').trim();
    if (prefix) {
      const folder = projectFolderOf(session.meta);
      const project = manager.projects.get(folder);
      await manager.projects.update(folder, { allowedCommands: [...project.allowedCommands, prefix] });
      manager.hub.broadcast({ type: 'projects' });
    }
    return { allowed: true };
  }
  // A site approved for the project: the agent's browser acts on it in every session there, as Claude Code
  // remembers approved sites.
  if (answer.decision === 'allow_project' && request.request === 'browser' && request.host) {
    const folder = projectFolderOf(session.meta);
    const project = manager.projects.get(folder);
    await manager.projects.update(folder, { allowedSites: [...project.allowedSites, request.host] });
    manager.hub.broadcast({ type: 'projects' });
    return { allowed: true };
  }
  if (answer.decision === 'allow_session') {
    if (request.request === 'edit') {
      await manager.changeMode(session, 'edits');
    } else if (request.request === 'command') {
      const prefix = String(answer.prefix || request.suggestedPrefix || '').trim();
      if (prefix && !session.data.allowRules.some((rule) => rule.toLowerCase() === prefix.toLowerCase())) session.data.allowRules.push(prefix);
    } else if (request.request === 'web' && request.host) {
      // Reading only: a site allowed for web_fetch does not let the browser act on it.
      session.data.fetchHosts = [...new Set([...(session.data.fetchHosts || []), request.host])];
    } else if (request.request === 'browser' && request.host && !session.data.allowedHosts.includes(request.host)) {
      session.data.allowedHosts.push(request.host);
    } else if (request.request === 'mcp') {
      // Sessions from before MCP have no list yet.
      session.data.allowedMcpTools = [...(session.data.allowedMcpTools || []), request.tool];
    }
    await manager.store.save(session.meta.id);
    return { allowed: true };
  }
  const feedback = String(answer.feedback || '').trim();
  if (feedback) return { allowed: false, message: `The user denied this action and said: ${feedback}` };
  return { allowed: false, message: 'The user denied this action.', stopTurn: true };
}

/**
 * Why the tool may not run at all, or null. Runs before the tool's prepare step, which already touches
 * things: opening a network path makes Windows contact that server, and the pull request tools ask git
 * for its sign-in (which can open a sign-in window) and read the repository's host.
 */
export function refusedBeforePrepare(manager, session, tool, input) {
  if (session.meta.mode === 'plan' && tool.kind === 'pull_request') return 'Plan mode is on, so no pull request can be opened. Finish your research and call present_plan.';
  if (session.meta.mode === 'plan' && tool.kind === 'merge') return 'Plan mode is on, so nothing can be merged. Finish your research and call present_plan.';
  if (tool.kind !== 'read' && tool.kind !== 'edit') return null;
  const target = resolvePath(session.meta.cwd, input.path || '.');
  const refusal = refusedPath(manager, session, target, { editing: tool.kind === 'edit' });
  return refusal;
}

/**
 * Why the agent may not read or change this file, or null.
 * - Checks the path as written, and then the real path Windows opens: a link, junction or short name
 *   (GIT~1) can lead to a protected file under another name.
 */
export function refusedPath(manager, session, absolutePath, { editing = false, realFolders = null } = {}) {
  const written = refusedSpelling(manager, session, absolutePath, { editing });
  if (written) return written;
  // grep and glob check every file they look at: resolve each folder once per tool call (`realFolders`).
  const real = realFolders ? realFileInFolder(realFolders, absolutePath) : realPath(absolutePath);
  const refusal = real === absolutePath ? null : refusedSpelling(manager, session, real, { editing });
  return refusal;
}

/** The real path of a file found by a search: a file that is itself a link (notes.txt → .env) is resolved in full. */
function realFileInFolder(realFolders, absolutePath) {
  let link = false;
  try {
    link = fs.lstatSync(absolutePath).isSymbolicLink();
  } catch {
    // A file that is gone is not read either.
  }
  const real = link ? realPath(absolutePath) : path.join(cachedRealPath(realFolders, path.dirname(absolutePath)), path.basename(absolutePath));
  return real;
}

const realSignInFolders = new Map();

function cachedRealPath(realFolders, folder) {
  if (!realFolders.has(folder)) realFolders.set(folder, realPath(folder));
  const real = realFolders.get(folder);
  return real;
}

/**
 * - Network and device paths outside the project, and file stream names.
 * - Caliope's data folder (its skills folder can be read) and the folders where GitHub's Copilot editor
 *   plugins keep their sign-in.
 * - Files that match the user's protected files (Settings → Permissions), such as .env.
 */
function refusedSpelling(manager, session, absolutePath, { editing }) {
  // Opening \\server\share\file makes Windows connect to that server and send the user's login hash, and
  // \\?\ or \\.\ paths slip past the folder checks below. Only a project that itself lives on a share uses them.
  if (/^[\\/]{2}/.test(absolutePath) && !isInside(session.meta.cwd, absolutePath)) return `${absolutePath} is a network or device path outside the project. Use a local path.`;
  // Windows reads "name::$DATA" as "name", which would slip past the checks here and in authorize.
  if (process.platform === 'win32' && absolutePath.slice(2).includes(':')) return `${displayPath(session.meta.cwd, absolutePath)} names a file stream. Use the plain file name.`;
  // Each folder also by its real path: a link's real path has long names, the setting may have a short one
  // (C:\Users\RUNNER~1).
  const spellings = (folder) => [folder, cachedRealPath(realSignInFolders, folder)];
  const dataDirs = spellings(manager.config.dataDir);
  const readableSkill = !editing && dataDirs.some((folder) => isInside(path.join(folder, 'skills'), absolutePath));
  const signInFolders = [...dataDirs, ...(manager.config.editorAuthDirs || []).flatMap(spellings)];
  if (!readableSkill && signInFolders.some((folder) => isInside(folder, absolutePath))) {
    return `${displayPath(session.meta.cwd, absolutePath)} holds sign-in or session data (Caliope's own or GitHub Copilot's), so the agent may not read or change it.`;
  }
  const pattern = protectedPattern(absolutePath, session.meta.cwd, manager.settings.get().protectedFiles);
  if (pattern) return `${displayPath(session.meta.cwd, absolutePath)} matches "${pattern}" in the user's protected files (Settings → Permissions), so you may not read or change it. If you need something from it, ask the user.`;
  return null;
}

/**
 * Why an edit to this file (relative to the project folder) always asks, or null: files that can run
 * programs or add tools (git's own folder, MCP servers, skills and commands). Instruction files such as
 * AGENTS.md are ordinary edits.
 */
export function steeringFileWarning(relativePath) {
  const joined = relativePath.replace(/\\/g, '/').toLowerCase();
  if (joined.split('/').includes('.git')) return 'This file is part of git\'s own data: its hooks and settings can run programs during ordinary git commands. Changes to it always need your approval.';
  const steers = joined.split('/').at(-1) === '.mcp.json' || /(^|\/)\.(claude|agents)\//.test(joined) || /(^|\/)\.github\/(prompts|skills)\//.test(joined);
  return steers ? 'This file gives the agent tools, skills or commands. Changes to it always need your approval.' : null;
}

/** True when the agent may see pages of `host` without asking: approved in this session or project, or allowed by the mode. */
export function hostApproved(session, host, projectSites = []) {
  const mode = session.meta.mode;
  const approved = !host || mode === 'full' || mode === 'auto' || session.data.allowedHosts.includes(host) || projectSites.includes(host);
  return approved;
}

/**
 * The real path Windows opens: the nearest existing folder or file resolved (short names, links), plus the rest.
 * - A link whose target does not exist yet resolves to that target: writing through it creates the target.
 */
function realPath(absolutePath, depth = 0) {
  const rest = [];
  let existing = absolutePath;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    let linkTarget = null;
    try {
      // A junction's target comes as \\?\C:\...
      linkTarget = fs.readlinkSync(existing).replace(/^\\\\\?\\/, '');
    } catch {
      // Not a link: a file or folder that does not exist yet.
    }
    // A chain of more than 20 links is a loop, which Windows refuses to open anyway.
    if (linkTarget !== null && depth < 20) {
      const target = realPath(path.join(path.resolve(path.dirname(existing), linkTarget), ...rest), depth + 1);
      return target;
    }
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    const real = path.join(fs.realpathSync.native(existing), ...rest);
    return real;
  } catch {
    return absolutePath;
  }
}

/**
 * What a browser action does, for the approval card and Auto mode's safety check.
 * - `element`: the clicked or typed-into element with its label ('element [7] "Delete"'), when known.
 */
function browserDetail(input, element = '') {
  const target = element || (Number.isInteger(input.ref) ? `element [${input.ref}]` : '');
  switch (input.action) {
    case 'type':
      return `Type "${String(input.text || '').slice(0, 200)}"${target ? ` into ${target}` : ''}`;
    case 'click':
      return `Click ${target || `at (${input.x}, ${input.y})`}`;
    case 'press':
      return `Press ${input.key}`;
    case 'navigate':
      return `Open ${input.url}`;
    case 'screenshot':
      return `Take a screenshot${input.copy ? ' and copy it to the clipboard' : ''}`;
    case 'javascript':
      return `Run JavaScript in the page:\n${String(input.script || '').slice(0, 1500)}`;
    case 'batch': {
      const steps = Array.isArray(input.steps) ? input.steps : [];
      const list = steps.map((step, index) => `${index + 1}. ${browserDetail(step || {})}`).join('\n');
      return `Run ${steps.length} steps:\n${list}`.slice(0, 3000);
    }
    default:
      return `Go ${input.action}`;
  }
}

/** True for a site on this PC, such as "http://localhost:3000" (see siteOf). */
function isLocalHost(site) {
  let host = '';
  try {
    host = new URL(site).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}
