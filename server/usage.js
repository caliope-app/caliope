// Spending: a ledger of every Copilot request this app makes, and the account's allowance.
//
// Cost comes from Copilot itself: each response carries `copilot_usage.total_nano_aiu`.
// 1,000,000,000 nano-AIU = 1 AI credit = US$0.01 (GitHub Copilot usage-based billing).
// When a response carries no cost, the request is counted as "unpriced" instead of free.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { writeFileAtomic } from './util.js';
import { userAgent } from './auth.js';

export const NANO_AIU_PER_CREDIT = 1e9;
const KEEP_DAYS = 400;

export class UsageLedger {
  constructor({ file, log }) {
    this.file = file;
    this.log = log;
    this.entries = [];
  }

  async init() {
    let text = '';
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
    let dropped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.ts >= cutoff) this.entries.push(entry);
        else dropped++;
      } catch {
        dropped++;
      }
    }
    if (dropped > 0) {
      await writeFileAtomic(this.file, this.entries.map((entry) => JSON.stringify(entry)).join('\n') + (this.entries.length ? '\n' : ''));
    }
  }

  /** Append one request. `nanoAiu` is null when Copilot reported no cost. */
  record(entry) {
    const line = {
      ts: new Date().toISOString(),
      sessionId: entry.sessionId || null,
      project: entry.project || null,
      model: entry.model,
      kind: entry.kind,
      input: entry.usage.input || 0,
      output: entry.usage.output || 0,
      cacheRead: entry.usage.cacheRead || 0,
      cacheWrite: entry.usage.cacheWrite || 0,
      nanoAiu: typeof entry.usage.nanoAiu === 'number' ? entry.usage.nanoAiu : null,
    };
    this.entries.push(line);
    fs.appendFile(this.file, `${JSON.stringify(line)}\n`, (error) => {
      if (error) this.log.warn('Could not append to the usage ledger.', error);
    });
    return line;
  }

  /** Nano-AIU spent in one project (its pathKey) this calendar month, in the PC's time zone. */
  projectSpendThisMonth(project) {
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let nanoAiu = 0;
    for (const entry of this.entries) {
      if (entry.project === project && entry.ts >= since && entry.nanoAiu !== null) nanoAiu += entry.nanoAiu;
    }
    return nanoAiu;
  }

  /**
   * What one request to each model cost on average in this ledger: { modelId: { requests, nanoPerRequest } }.
   * - Copilot's model list has no prices (its multipliers say 1× for every model), so this is what
   *   the model picker shows. Requests without a reported cost are left out.
   */
  averageCostByModel() {
    const totals = new Map();
    for (const entry of this.entries) {
      if (entry.nanoAiu === null) continue;
      const model = totals.get(entry.model) || { requests: 0, nanoAiu: 0 };
      model.requests++;
      model.nanoAiu += entry.nanoAiu;
      totals.set(entry.model, model);
    }
    const averages = Object.fromEntries([...totals].map(([model, { requests, nanoAiu }]) => [model, { requests, nanoPerRequest: Math.round(nanoAiu / requests) }]));
    return averages;
  }

  /**
   * Totals for a period, split by day, model, kind and session.
   * - `since` / `until` are ISO timestamps. Omit them for everything kept.
   */
  summary({ since = null, until = null } = {}) {
    const total = emptyTotals();
    const byDay = new Map();
    const byModel = new Map();
    const byKind = new Map();
    const bySession = new Map();
    for (const entry of this.entries) {
      if (since && entry.ts < since) continue;
      if (until && entry.ts >= until) continue;
      addEntry(total, entry);
      addEntry(getOrCreate(byDay, localDay(entry.ts)), entry);
      addEntry(getOrCreate(byModel, entry.model), entry);
      addEntry(getOrCreate(byKind, entry.kind), entry);
      if (entry.sessionId) addEntry(getOrCreate(bySession, entry.sessionId), entry);
    }
    const toList = (map, keyName) => [...map.entries()].map(([key, totals]) => ({ [keyName]: key, ...totals }));
    const summary = {
      total,
      byDay: toList(byDay, 'day').sort((a, b) => a.day.localeCompare(b.day)),
      byModel: toList(byModel, 'model').sort((a, b) => b.nanoAiu - a.nanoAiu),
      byKind: toList(byKind, 'kind').sort((a, b) => b.nanoAiu - a.nanoAiu),
      bySession: toList(bySession, 'sessionId').sort((a, b) => b.nanoAiu - a.nanoAiu),
    };
    return summary;
  }
}

/** Calendar day in the PC's time zone (the ledger stores UTC timestamps). */
function localDay(iso) {
  const date = new Date(iso);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return day;
}

function emptyTotals() {
  return { requests: 0, unpricedRequests: 0, nanoAiu: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function getOrCreate(map, key) {
  let totals = map.get(key);
  if (!totals) {
    totals = emptyTotals();
    map.set(key, totals);
  }
  return totals;
}

function addEntry(totals, entry) {
  totals.requests++;
  if (entry.nanoAiu === null) totals.unpricedRequests++;
  else totals.nanoAiu += entry.nanoAiu;
  totals.input += entry.input;
  totals.output += entry.output;
  totals.cacheRead += entry.cacheRead;
  totals.cacheWrite += entry.cacheWrite;
}

/** Add one request to a session's running totals (kept in the session's meta). */
export function addToSessionUsage(sessionUsage, model, usage) {
  sessionUsage.requests++;
  sessionUsage.input += usage.input || 0;
  sessionUsage.output += usage.output || 0;
  sessionUsage.cacheRead += usage.cacheRead || 0;
  sessionUsage.cacheWrite += usage.cacheWrite || 0;
  if (typeof usage.nanoAiu === 'number') sessionUsage.nanoAiu += usage.nanoAiu;
  else sessionUsage.unpricedRequests = (sessionUsage.unpricedRequests || 0) + 1;
  sessionUsage.byModel = sessionUsage.byModel || {};
  const perModel = sessionUsage.byModel[model] || { requests: 0, nanoAiu: 0, input: 0, output: 0 };
  perModel.requests++;
  perModel.input += usage.input || 0;
  perModel.output += usage.output || 0;
  if (typeof usage.nanoAiu === 'number') perModel.nanoAiu += usage.nanoAiu;
  sessionUsage.byModel[model] = perModel;
}

/**
 * Read the account's Copilot plan and allowance from GitHub.
 * - Undocumented endpoint used by GitHub's editor plugins. Fields are read defensively and
 *   anything missing is reported as null, never as zero.
 */
export async function fetchAllowance({ githubApi, githubToken }) {
  const response = await fetch(`${githubApi}/copilot_internal/user`, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': userAgent(),
      'X-GitHub-Api-Version': '2025-04-01',
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`GitHub did not return the Copilot allowance (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  const allowance = parseAllowance(body);
  return allowance;
}

export function parseAllowance(body) {
  const snapshot = body?.quota_snapshots?.premium_interactions || null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  let entitlement = null;
  let remaining = null;
  let used = null;
  if (snapshot) {
    entitlement = number(snapshot.entitlement);
    remaining = number(snapshot.quota_remaining) ?? number(snapshot.remaining);
    used = number(snapshot.credits_used);
    if (used === null && entitlement !== null && remaining !== null) used = Math.max(0, entitlement - remaining);
  }
  const allowance = {
    plan: body?.copilot_plan || null,
    sku: body?.access_type_sku || null,
    resetDate: body?.quota_reset_date_utc || body?.quota_reset_date || null,
    // True when amounts are AI credits (usage-based billing), false for premium requests (older billing).
    tokenBased: snapshot ? Boolean(snapshot.token_based_billing) : null,
    unlimited: snapshot ? Boolean(snapshot.unlimited) : null,
    hasQuota: snapshot ? snapshot.has_quota !== false : false,
    entitlement,
    remaining,
    used,
    percentRemaining: snapshot ? number(snapshot.percent_remaining) : null,
    overagePermitted: snapshot ? Boolean(snapshot.overage_permitted) : null,
    overageCount: snapshot ? number(snapshot.overage_count) : null,
    fetchedAt: new Date().toISOString(),
  };
  return allowance;
}
