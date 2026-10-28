import fsp from 'node:fs/promises';
import { readJson, writeJsonAtomic, isPlainObject } from './util.js';
import { detectExtraPath, bundledRuntime } from './config.js';
import { DEFAULT_PROTECTED_FILES } from './protected-files.js';
import { validateMcpServers } from './mcp.js';
import { validateProxyUrl } from './proxy.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODES = ['ask', 'edits', 'auto', 'plan', 'full'];

export const DEFAULT_SETTINGS = {
  // Models: null means "pick automatically from the Copilot model list".
  planModel: null,
  planEffort: 'high',
  buildModel: null,
  buildEffort: 'medium',
  titleModel: null,
  // Permissions and modes. Auto, as developers use Claude Code: edits apply and a safety check judges commands.
  defaultMode: 'auto',
  allowedCommands: [],
  // Files the agent may not open: secrets such as .env files and private keys (see protected-files.js).
  protectedFiles: DEFAULT_PROTECTED_FILES,
  browserTools: true,
  useClaudeSkills: true,
  // Subagents: the main agent can hand tasks to other models (run_agent). null model = the session's model.
  subagents: true,
  subagentModel: null,
  subagentEffort: 'medium',
  // MCP servers for every project, by name (see mcp.js). Projects can add their own in .mcp.json.
  mcpServers: {},
  // Commands.
  shell: 'powershell',
  extraPath: null,
  commandTimeoutSec: 120,
  // Instructions added to every new session.
  globalInstructions: '',
  instructionFiles: [],
  // Model requests.
  thinkingDisplay: 'summarized',
  maxOutputTokens: 64000,
  // Share of the model's context window at which the conversation is compacted. Each compaction restarts the
  // prompt cache. A larger context makes every request dearer. Short sessions favor later, long ones earlier.
  autoCompactPercent: 90,
  // The model and effort for the summaries Caliope writes (models without native compaction, /compact). With null, the session's own.
  compactModel: null,
  compactEffort: null,
  apiBase: '',
  // A company proxy (see proxy.js): '' uses HTTPS_PROXY from the environment, if any. noProxy: hosts that skip it.
  proxy: '',
  noProxy: '',
  // US dollars say more than AI credits (1 credit is $0.01).
  costUnit: 'usd',
  // Interface. Browser: where the app window and clicked links open, and which browser the agent drives.
  browser: 'chrome',
  theme: 'system',
  notifications: true,
  // Look up the latest release when the app starts (one anonymous request to GitHub).
  checkUpdates: true,
  // Install a newer release found at startup without asking. Off: a release only installs when the user clicks Update.
  autoUpdate: false,
  recentFolders: [],
};

const VALIDATORS = {
  planModel: nullableString,
  planEffort: oneOf(EFFORTS),
  buildModel: nullableString,
  buildEffort: oneOf(EFFORTS),
  titleModel: nullableString,
  defaultMode: oneOf(MODES),
  allowedCommands: stringList(200),
  protectedFiles: stringList(200),
  browserTools: boolean,
  useClaudeSkills: boolean,
  subagents: boolean,
  subagentModel: nullableString,
  subagentEffort: oneOf(EFFORTS),
  mcpServers,
  shell: oneOf(['powershell', 'cmd']),
  extraPath: nullableStringList,
  commandTimeoutSec: integerBetween(5, 600),
  globalInstructions: stringMax(50000),
  instructionFiles: stringList(50),
  thinkingDisplay: oneOf(['summarized', 'omitted']),
  maxOutputTokens: integerBetween(1024, 128000),
  autoCompactPercent: integerBetween(50, 95),
  compactModel: nullableString,
  compactEffort: (value) => (value === null || value === '' ? ok(null) : oneOf(EFFORTS)(value)),
  apiBase: urlOrEmpty,
  proxy: proxyAddress,
  noProxy: stringMax(2000),
  costUnit: oneOf(['credits', 'usd']),
  browser: oneOf(['chrome', 'edge', 'system']),
  theme: oneOf(['system', 'light', 'dark']),
  notifications: boolean,
  checkUpdates: boolean,
  autoUpdate: boolean,
  recentFolders: stringList(20),
};

export class SettingsStore {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.values = { ...DEFAULT_SETTINGS };
    this.listeners = new Set();
  }

  async load() {
    let stored;
    try {
      stored = await readJson(this.file, {});
    } catch (error) {
      // A damaged settings file should not stop the app. Keep a copy and start from defaults.
      this.log?.warn('Settings file could not be read; using defaults.', error);
      await fsp.copyFile(this.file, `${this.file}.damaged`).catch(() => {});
      stored = {};
    }
    const values = { ...DEFAULT_SETTINGS };
    for (const [key, value] of Object.entries(isPlainObject(stored) ? stored : {})) {
      if (!(key in VALIDATORS)) continue;
      const result = VALIDATORS[key](value);
      if (result.ok) values[key] = result.value;
    }
    this.values = values;
  }

  get() {
    return structuredClone(this.values);
  }

  /**
   * PATH folders added to agent commands: the explicit list, or the folders found at startup.
   * - The zip's own Node.js, npm and npx stay first either way, so the Azure DevOps MCP server keeps working.
   */
  effectiveExtraPath() {
    this.detectedExtraPath ??= detectExtraPath();
    const folders = this.values.extraPath ? [...new Set([...bundledRuntime(), ...this.values.extraPath])] : this.detectedExtraPath;
    return folders;
  }

  /**
   * Apply a partial update.
   * - Unknown keys and invalid values are rejected with a message naming the setting.
   */
  async update(patch) {
    if (!isPlainObject(patch)) throw new SettingsError('Settings update must be an object.');
    const next = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in VALIDATORS)) throw new SettingsError(`Unknown setting "${key}".`);
      const result = VALIDATORS[key](value);
      if (!result.ok) throw new SettingsError(`Invalid value for "${key}": ${result.reason}`);
      next[key] = result.value;
    }
    this.values = next;
    await writeJsonAtomic(this.file, this.values);
    for (const listener of this.listeners) listener(this.get());
    return this.get();
  }

  async rememberFolder(folder) {
    const recent = [folder, ...this.values.recentFolders.filter((item) => item.toLowerCase() !== folder.toLowerCase())].slice(0, 12);
    await this.update({ recentFolders: recent });
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class SettingsError extends Error {}

function ok(value) {
  return { ok: true, value };
}

function fail(reason) {
  return { ok: false, reason };
}

function nullableString(value) {
  if (value === null || value === '') return ok(null);
  return typeof value === 'string' && value.length < 200 ? ok(value) : fail('expected a model id or null');
}

function oneOf(options) {
  return (value) => (options.includes(value) ? ok(value) : fail(`expected one of ${options.join(', ')}`));
}

function boolean(value) {
  return typeof value === 'boolean' ? ok(value) : fail('expected true or false');
}

function integerBetween(min, max) {
  return (value) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? ok(number) : fail(`expected a whole number from ${min} to ${max}`);
  };
}

function stringMax(max) {
  return (value) => (typeof value === 'string' && value.length <= max ? ok(value) : fail(`expected text up to ${max} characters`));
}

function stringList(maxItems) {
  return (value) => {
    if (!Array.isArray(value) || value.length > maxItems) return fail(`expected a list of up to ${maxItems} items`);
    if (value.some((item) => typeof item !== 'string')) return fail('expected text items');
    const items = value.map((item) => item.trim()).filter(Boolean);
    return ok(items);
  };
}

function nullableStringList(value) {
  if (value === null) return ok(null);
  return stringList(30)(value);
}

function mcpServers(value) {
  try {
    return ok(validateMcpServers(value));
  } catch (error) {
    return fail(error.message);
  }
}

function proxyAddress(value) {
  try {
    return ok(validateProxyUrl(value));
  } catch (error) {
    return fail(error.message);
  }
}

function urlOrEmpty(value) {
  if (value === '' || value === null) return ok('');
  if (typeof value !== 'string') return fail('expected a URL');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return fail('expected an https URL');
    return ok(value.replace(/\/+$/, ''));
  } catch {
    return fail('expected a URL');
  }
}
