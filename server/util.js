import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Time-sortable id: base36 timestamp followed by random hex. */
export function newId(prefix = '') {
  const time = Date.now().toString(36).padStart(9, '0');
  const random = crypto.randomBytes(5).toString('hex');
  const id = `${prefix}${time}${random}`;
  return id;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export async function readJson(file, fallback) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  const value = JSON.parse(text.replace(/^﻿/, ''));
  return value;
}

/**
 * Write a file through a temporary file and a rename, so readers never see half a file.
 * - Windows can briefly lock the target (antivirus, indexer). The rename is retried a few times.
 */
export async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temporaryFile, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(temporaryFile, file);
      return;
    } catch (error) {
      if (attempt < 8 && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await sleep(25 * (attempt + 1));
        continue;
      }
      await fsp.rm(temporaryFile, { force: true });
      throw error;
    }
  }
}

export function writeJsonAtomic(file, value, { pretty = true } = {}) {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return writeFileAtomic(file, text);
}

export function sha256(data) {
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  return digest;
}

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/** Keep the start and the end of a long text; the end usually holds the errors. */
export function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;
  const headLength = Math.floor(maxChars / 3);
  const tailLength = maxChars - headLength;
  const omitted = text.length - headLength - tailLength;
  const shortened = `${text.slice(0, headLength)}\n\n… [${omitted} characters omitted] …\n\n${text.slice(text.length - tailLength)}`;
  return shortened;
}

export function truncateEnd(text, maxChars, note = '') {
  if (text.length <= maxChars) return text;
  const shortened = `${text.slice(0, maxChars)}\n… [truncated${note ? `: ${note}` : ''}]`;
  return shortened;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * The site the user approves for web_fetch and the agent's browser: scheme, host and port
 * ("http://localhost:3000"), so approving one local app does not approve another port.
 * - Null for anything that is not an http(s) URL (about:blank).
 */
export function siteOf(url) {
  try {
    const parsed = new URL(url);
    const site = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    return site;
  } catch {
    return null;
  }
}

/** Run async work for each item with at most `limit` running at once. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, lane);
  await Promise.all(lanes);
  return results;
}

/** Serialize async jobs per key, so two saves of the same file never overlap. */
export class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, job) {
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(job);
    const tail = current.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return current;
  }

  async drain() {
    await Promise.all([...this.tails.values()]);
  }
}

export function createLogger(logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(logsDir, `server-${day}.log`);
  pruneOldLogs(logsDir);
  function write(level, parts) {
    const message = parts
      .map((part) => (part instanceof Error ? part.stack || part.message : typeof part === 'string' ? part : safeJson(part)))
      .join(' ');
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      // Logging must never break the app.
    }
    if (process.env.CALIOPE_LOG_STDOUT === '1') process.stdout.write(line);
  }
  return {
    file,
    info: (...parts) => write('INFO ', parts),
    warn: (...parts) => write('WARN ', parts),
    error: (...parts) => write('ERROR', parts),
  };
}

function pruneOldLogs(logsDir) {
  try {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(logsDir)) {
      const file = path.join(logsDir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {
    // Old logs are only a convenience.
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} min ${seconds} s`;
}
