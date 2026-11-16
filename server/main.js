// Caliope server entry point.
//   node server/main.js --open        start (or reuse) the server and open the app window
//   node server/main.js --background  start (or reuse) the server without a window (the Startup entry)
//   node server/main.js --stay        keep running without a window (for development)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, APP_NAME, APP_VERSION, RELEASE_PUBLIC_KEY } from './config.js';
import { createLogger, readJson, writeJsonAtomic, sleep } from './util.js';
import { SettingsStore } from './settings.js';
import { AuthManager } from './auth.js';
import { CopilotClient } from './copilot.js';
import { SessionStore } from './store.js';
import { UsageLedger } from './usage.js';
import { EventHub } from './hub.js';
import { AgentManager } from './agent.js';
import { createRoutes } from './api.js';
import { createAppServer } from './http.js';
import { openAppWindow, isProcessAlive, showErrorBox, removeDownloadMarks, setStartAtSignIn } from './windows.js';
import { AgentBrowser } from './tools/browser.js';
import { ProjectStore } from './projects.js';
import { McpHub } from './mcp.js';
import { UpdateChecker } from './updates.js';
import { applyProxy } from './proxy.js';
import { Scheduler } from './schedules.js';

const IDLE_SHUTDOWN_MS = 45000;

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) {
    await showError(`${APP_NAME} needs Node.js 22.15 or newer; this is ${process.versions.node}.`);
    process.exit(1);
  }
  if (process.argv.includes('--detach')) {
    // Started by Caliope.cmd: run the server as a background process without a console window.
    const args = [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((argument) => argument !== '--detach')];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }

  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const log = createLogger(config.logsDir);
  process.on('unhandledRejection', (error) => log.error('Unhandled rejection.', error));
  process.on('uncaughtException', (error) => log.error('Uncaught exception.', error));
  // Once, after the zip was unzipped by hand. A mark that stays only brings Windows' warning back.
  try {
    removeDownloadMarks(config.appRoot);
  } catch (error) {
    log.warn('Could not remove the "from the internet" mark from Caliope\'s files.', error.message);
  }

  const serverFile = path.join(config.dataDir, 'server.json');
  const settings = new SettingsStore(path.join(config.dataDir, 'settings.json'), log);
  await settings.load();
  // The proxy applies before the first request. Caliope's own address on 127.0.0.1 stays direct.
  // Returns true when it changed.
  let appliedProxy = null;
  const useProxy = ({ proxy, noProxy }) => {
    if (appliedProxy === `${proxy}|${noProxy}`) return false;
    appliedProxy = `${proxy}|${noProxy}`;
    const applied = applyProxy({ proxy, noProxy });
    if (applied.source) log.info(`Requests go through the proxy ${applied.url} (from ${applied.source}).`);
    return true;
  };
  useProxy(settings.get());
  // Two starts at once (a double-click) must not both become servers: they would overwrite each other's sessions.
  let lock = await lockDataDir(config.dataDir);
  let running = await findRunningInstance(serverFile);
  const openWindowOn = async (instance) => {
    const token = await requestLaunchToken(instance.port, instance.secret);
    openAppWindow(`http://127.0.0.1:${instance.port}/auth?token=${token}`, settings.get().browser, path.join(config.dataDir, 'app-window'));
  };
  let openedOnBusy = false;
  for (;;) {
    if (!lock) {
      // Another start holds the data folder: wait until its server answers.
      for (let waited = 0; !running && waited < 20000; waited += 250) {
        await sleep(250);
        running = await findRunningInstance(serverFile);
      }
      if (!running) throw new Error(`Another ${APP_NAME} is starting with the same data folder and did not answer. Wait a moment and start ${APP_NAME} again.`);
    }
    if (!running || running.version === APP_VERSION) break;
    // Another version runs, because an update was installed meanwhile. It stops for this one, unless a turn, a
    // question or a background command still runs there: then the window opens on it, and this start waits.
    if (await stopRunningInstance(running)) {
      log.info(`Stopped ${APP_NAME} ${running.version} on port ${running.port} to start ${APP_VERSION}.`);
      running = null;
      // Its hold on the data folder ends with its process.
      for (let waited = 0; !lock && waited < 15000; waited += 250) {
        lock = await lockDataDir(config.dataDir);
        if (!lock) await sleep(250);
      }
      // Still held: another start that waited as well took over. The loop then uses its server.
      if (!lock) running = await findRunningInstance(serverFile);
      continue;
    }
    if (config.open && !openedOnBusy) {
      log.info(`${APP_NAME} ${running.version} on port ${running.port} is busy; ${APP_VERSION} starts once it is done.`);
      await openWindowOn(running);
      openedOnBusy = true;
    }
    await sleep(5000);
    // The other version may have been closed meanwhile.
    lock = await lockDataDir(config.dataDir);
    running = await findRunningInstance(serverFile);
  }
  if (running) {
    // This start waited for the busy other version and opened a window on it. Another start that waited too became
    // the server of this version, and that one opens the window.
    if (openedOnBusy) return;
    log.info(`Server already running on port ${running.port}; opening a window.`);
    if (config.open) await openWindowOn(running);
    return;
  }

  // The launch secret lives as long as this server: a server.json left behind after a crash then holds a
  // dead secret, so whatever answers on that port later cannot use it.
  const secret = crypto.randomBytes(32).toString('hex');
  const hub = new EventHub();
  const auth = new AuthManager({
    file: path.join(config.dataDir, 'auth.json'),
    config,
    settings,
    log,
    onChange: () => hub.broadcast({ type: 'auth', auth: auth.status() }),
  });
  await auth.load();
  const client = new CopilotClient({ auth, log, cacheFile: path.join(config.dataDir, 'models.json') });
  await client.loadCachedModels();
  const store = new SessionStore({ sessionsDir: config.sessionsDir, log, onSaveErrors: (errors) => hub.broadcast({ type: 'save_errors', errors }) });
  await store.init();
  const ledger = new UsageLedger({ file: path.join(config.dataDir, 'usage.jsonl'), log });
  await ledger.init();
  const projects = new ProjectStore(path.join(config.dataDir, 'projects.json'), log);
  await projects.load();
  fs.mkdirSync(path.join(config.dataDir, 'skills'), { recursive: true });
  const browser = new AgentBrowser({ dataDir: config.dataDir, getChoice: () => settings.get().browser, log, headless: config.browserHeadless });
  // OAuth sign-ins of HTTP MCP servers live next to the settings, encrypted, never in settings.json.
  const mcp = new McpHub({ log, signInFile: path.join(config.dataDir, 'mcp-auth.json'), plainSecrets: config.plainSecrets });
  // MCP servers keep the proxy they started with: after a change they stop, and start again when needed.
  // A server removed from Settings, or given another address, is signed out: its tokens leave mcp-auth.json.
  let mcpServers = settings.get().mcpServers;
  settings.onChange((values) => {
    if (useProxy(values)) mcp.closeAll();
    const addresses = new Set(Object.values(values.mcpServers).map((server) => server.url));
    for (const server of Object.values(mcpServers)) {
      if (server.url && !addresses.has(server.url)) mcp.signIns.remove(server.url).catch((error) => log.warn(`Could not remove the MCP sign-in for ${server.url}.`, error.message));
    }
    mcpServers = values.mcpServers;
  });
  const agents = new AgentManager({ config, settings, store, client, auth, hub, log, ledger, browser, mcp, projects });
  // install.ps1 puts a launcher next to the version folders. A copy unzipped by hand has none.
  const installRoot = path.resolve(config.appRoot, '..');
  const installed = fs.existsSync(path.join(installRoot, 'Caliope.cmd'));
  const updates = new UpdateChecker({ releasesUrl: config.releasesUrl, currentVersion: APP_VERSION, installed, root: installRoot, publicKey: RELEASE_PUBLIC_KEY, isBusy: () => agents.isBusy(), hub, log });
  // "Keep running for scheduled tasks" starts Caliope at sign-in, through the launcher that survives updates.
  // With the setting on, every start writes the entry again, so it follows a write that failed and starts this copy's
  // launcher. A start never removes it: a start with another data folder (CALIOPE_DATA_DIR, the tests) has the
  // setting off and would remove the user's entry. Turning the setting off removes it, and so does the uninstall.
  // A failure only goes to the log: the setting itself is saved.
  const launcher = path.join(installed ? installRoot : config.appRoot, 'Caliope.cmd');
  let keepRunning = settings.get().keepRunning;
  const updateStartupEntry = () => {
    try {
      setStartAtSignIn(keepRunning, launcher);
    } catch (error) {
      log.warn(`Could not ${keepRunning ? 'add' : 'remove'} the Startup entry that starts ${APP_NAME} at sign-in.`, error.message);
    }
  };
  if (keepRunning) updateStartupEntry();
  settings.onChange((values) => {
    if (values.keepRunning === keepRunning) return;
    keepRunning = values.keepRunning;
    updateStartupEntry();
  });
  const scheduler = new Scheduler({ agents, projects, hub, log });
  const routes = createRoutes({ config, settings, store, client, auth, agents, ledger, log, projects, updates, scheduler });
  const app = createAppServer({ config, secret, routes, hub, log, isBusy: () => agents.isBusy(), onShutdown: (reason) => shutdown(reason === 'update' ? `a newer version of ${APP_NAME} started` : 'asked to stop', reason) });
  const port = await app.listen(config.port);
  // From here config.port is the port in use: the agent's browser and web_fetch may not open it (see authorize).
  config.port = port;
  await writeJsonAtomic(serverFile, { pid: process.pid, port, secret, version: APP_VERSION, startedAt: new Date().toISOString() });
  log.info(`${APP_NAME} ${APP_VERSION} listening on http://127.0.0.1:${port} (data: ${config.dataDir}).`);
  if (process.env.CALIOPE_PRINT_URL === '1') process.stdout.write(`URL http://127.0.0.1:${port}/auth?token=${app.createLaunchToken()}\n`);

  if (auth.status().signedIn) {
    client
      .refreshModels()
      .then(() => hub.broadcast({ type: 'models', models: client.models, fetchedAt: client.modelsFetchedAt, error: null }))
      .catch((error) => log.warn('Model list refresh at startup failed.', error.message));
    agents.refreshAllowance({ force: true }).catch(() => {});
  }

  // At the start and every 6 hours while Caliope runs, so a copy that stays open hears of a new version too.
  let installedInBackground = null;
  const checkForUpdates = async () => {
    if (!settings.get().checkUpdates) return;
    const status = await updates.check();
    // A copy unzipped by hand can't update itself. The new version only installs and runs from the next start:
    // switching now would close the window the user works in.
    if (settings.get().autoUpdate && status.available && status.installed && status.latest !== installedInBackground) {
      installedInBackground = status.latest;
      log.info(`Installing ${APP_NAME} ${status.latest} for the next start (Install updates automatically is on).`);
      updates
        .install({ start: false })
        .then(() => {
          // "Keep running for scheduled tasks" never closes this version, so the next start would be the next
          // sign-in. The new version starts without a window instead, once nothing runs here and no window is open.
          if (settings.get().keepRunning) updates.startWhenIdle({ background: true });
        })
        .catch((error) => {
          // The next check tries again.
          installedInBackground = null;
          log.warn('The automatic update failed.', error.message);
        });
    }
  };
  checkForUpdates();
  const updateTimer = setInterval(checkForUpdates, 6 * 3600 * 1000);
  scheduler.start();

  const heartbeat = setInterval(() => hub.heartbeat(), 15000);
  let stopping = false;
  /** Stop the server. `windowNotice` ('update' or 'stopped') tells open windows why, so they don't wait to reconnect. */
  async function shutdown(reason, windowNotice = null) {
    if (stopping) return;
    stopping = true;
    log.info(`Shutting down: ${reason}.`);
    if (windowNotice) hub.broadcast({ type: 'shutdown', notice: windowNotice });
    clearInterval(heartbeat);
    clearInterval(updateTimer);
    scheduler.stop();
    agents.stopAll({ jobs: true });
    const deadline = Date.now() + 5000;
    while ([...agents.runners.values()].some((runner) => runner.state === 'running') && Date.now() < deadline) await sleep(100);
    await store.flush();
    // The last usage lines, also those of the turns stopped just now.
    await ledger.flush();
    await browser.shutdown().catch(() => {});
    mcp.closeAll();
    try {
      const current = await readJson(serverFile, null);
      if (current?.pid === process.pid) fs.rmSync(serverFile, { force: true });
    } catch {
      // Best effort.
    }
    app.server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('interrupt'));
  process.on('SIGTERM', () => shutdown('terminate'));

  if (!config.stay) {
    // Close when no window has been connected for a while, no turn is working or waiting for the user,
    // and no background command runs. "Keep running for scheduled tasks" keeps Caliope running for the next task.
    setInterval(() => {
      if (hub.clientCount === 0 && !agents.isBusy() && !settings.get().keepRunning && Date.now() - hub.lastClientAt > IDLE_SHUTDOWN_MS) shutdown('no window open');
    }, 5000);
  }

  const openWindow = () => openAppWindow(`http://127.0.0.1:${port}/auth?token=${app.createLaunchToken()}`, settings.get().browser, path.join(config.dataDir, 'app-window'));
  if (!config.noBrowser) {
    // A question while no window is open, such as an approval for a scheduled task in Ask mode, opens the app
    // window: only an open window shows it and its notification. Once per question.
    const shownQuestions = new Set();
    setInterval(() => {
      const unseen = [...agents.runners.values()].map((runner) => runner.waiting?.id).filter((id) => id && !shownQuestions.has(id));
      for (const id of unseen) shownQuestions.add(id);
      if (unseen.length > 0 && hub.clientCount === 0) openWindow();
    }, 5000);
  }

  if (config.open) {
    const browser = openWindow();
    log.info(`Opened the app window with ${browser}.`);
  }
}

/**
 * Hold the data folder for this process: a named pipe that only one process can listen on, and that
 * Windows releases when the process ends, also after a crash.
 * - Returns the pipe server, or null when another process holds it.
 */
async function lockDataDir(dataDir) {
  if (process.platform !== 'win32') return {};
  const name = `\\\\.\\pipe\\caliope-${crypto.createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24)}`;
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(name, resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
  // Holding the pipe must not keep the process alive by itself.
  server.unref();
  return server;
}

async function findRunningInstance(serverFile) {
  const info = await readJson(serverFile, null).catch(() => null);
  if (!info?.pid || !info?.port || !info?.secret || !isProcessAlive(info.pid)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return body.app === APP_NAME ? info : null;
  } catch {
    return null;
  }
}

/**
 * Ask a running other version to stop (it finishes saving first), and wait until its process is gone.
 * - Returns false when it is busy and keeps running (HTTP 409; versions up to 1.0.4 stop anyway). Ask again later.
 * - Throws when it keeps running after it agreed to stop: two servers must never share the sessions and settings.
 */
async function stopRunningInstance(running) {
  const response = await fetch(`http://127.0.0.1:${running.port}/shutdown`, { method: 'POST', headers: { 'X-Caliope-Secret': running.secret, 'X-Caliope-Reason': 'update' }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (response?.status === 409) return false;
  for (let waited = 0; isProcessAlive(running.pid) && waited < 15000; waited += 250) await sleep(250);
  if (isProcessAlive(running.pid)) {
    throw new Error(`${APP_NAME} ${running.version} is still running and did not stop for the new version. Close it from the Task Manager (node.exe, process ${running.pid}) and start ${APP_NAME} again.`);
  }
  return true;
}

/** A one-time link token from the running server; its launch secret travels in a header, never in the link. */
async function requestLaunchToken(port, secret) {
  const response = await fetch(`http://127.0.0.1:${port}/launch`, { method: 'POST', headers: { 'X-Caliope-Secret': secret }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`The running ${APP_NAME} did not open a new window (HTTP ${response.status}). Close it from the Task Manager (node.exe) and start ${APP_NAME} again.`);
  const { token } = await response.json();
  return token;
}

/** The server runs without a console window, so startup errors go to a message box. */
async function showError(message) {
  try {
    process.stderr.write(`${message}\n`);
    if (process.platform !== 'win32') return;
    await showErrorBox(message);
  } catch {
    // Nothing else to try.
  }
}

main().catch(async (error) => {
  const config = loadConfig();
  const detail = error?.stack || String(error);
  try {
    fs.mkdirSync(config.logsDir, { recursive: true });
    fs.appendFileSync(path.join(config.logsDir, 'startup-errors.log'), `${new Date().toISOString()} ${detail}\n`);
  } catch {
    // Nothing else to try.
  }
  await showError(`${APP_NAME} could not start:\n\n${error?.message || error}\n\nDetails are in ${path.join(config.logsDir, 'startup-errors.log')}.`);
  process.exit(1);
});
