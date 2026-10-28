// Spending page: Copilot allowance, what this app spent (by day, session, model, purpose).
import { h, clear, formatCost, formatCredits, formatTokens, relativeTime, onNextFrame } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on, modelLabel } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { toastError } from './dialogs.js';

const PERIODS = [
  ['month', 'This month'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['all', 'All time'],
];
const KIND_LABELS = { chat: 'Agent turns', title: 'Session titles', compact: 'Compaction', approval: 'Auto-mode safety checks', subagent: 'Subagents', search: 'Web searches' };
const MAX_DAYS = 92;

export function mountUsage(container) {
  const subscriptions = [];
  let period = 'month';
  let summary = null;
  let showTable = false;
  let resizeObserver = null;

  const content = h('div');
  const page = h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('h1', {}, 'Spending'), h('p', { class: 'lead' }, 'Costs come from Copilot itself: every response reports what it cost. 1 AI credit = US$0.01.'), content));
  container.append(h('div', { class: 'view' }, page));
  const tooltip = h('div', { class: 'chart-tooltip', hidden: true });
  document.body.append(tooltip);

  async function load() {
    try {
      summary = await api.get(`/api/usage?period=${period}`);
      render();
    } catch (error) {
      toastError(error);
    }
  }

  function unit() {
    return state.settings?.costUnit || 'usd';
  }

  function render() {
    clear(content);
    resizeObserver?.disconnect();
    content.append(allowanceCard());
    const periods = h('div', { class: 'segmented' }, PERIODS.map(([id, label]) => h('button', { class: period === id ? 'active' : '', onClick: () => { period = id; load(); } }, label)));
    content.append(h('div', { class: 'row', style: { margin: '26px 0 12px' } }, h('h2', { style: { margin: 0 }, class: 'grow' }, 'Spent in Caliope'), periods));
    if (!summary) {
      content.append(h('div', { class: 'faint' }, 'Loading…'));
      return;
    }
    const total = summary.total;
    content.append(
      h(
        'div',
        { class: 'grid-2' },
        statTile(formatCost(total.nanoAiu, unit(), { unpriced: total.unpricedRequests }), unit() === 'usd' ? formatCost(total.nanoAiu, 'credits') : formatCost(total.nanoAiu, 'usd'), `Spent · ${total.requests} requests`),
        statTile(formatTokens(total.input + total.cacheRead + total.cacheWrite), `${formatTokens(total.cacheRead)} read from cache`, 'Input tokens'),
        statTile(formatTokens(total.output), 'including thinking', 'Output tokens'),
      ),
    );
    if (total.unpricedRequests > 0) {
      content.append(h('div', { class: 'callout warn', style: { marginTop: '10px' } }, h('span', { html: icon('info', 15) }), `${total.unpricedRequests} request(s) came back without a cost from Copilot. They are counted but not priced, so the real total is at least what is shown.`));
    }
    content.append(dailyCard());
    content.append(h('h2', {}, 'By session'), sessionsTable(), h('div', { class: 'grid-2', style: { marginTop: '16px' } }, h('div', {}, h('h2', { style: { marginTop: 0 } }, 'By model'), modelsTable()), h('div', {}, h('h2', { style: { marginTop: 0 } }, 'By purpose'), kindsTable())));
  }

  function statTile(value, secondary, label) {
    return h('div', { class: 'card stat' }, h('span', { class: 'value' }, value), h('span', { class: 'label' }, label), secondary ? h('span', { class: 'faint', style: { fontSize: '12px' } }, secondary) : null);
  }

  function allowanceCard() {
    const { allowance, error } = state.allowance || {};
    const card = h('div', { class: 'card' });
    const refresh = h('button', {
      class: 'btn small',
      onClick: async () => {
        refresh.disabled = true;
        try {
          state.allowance = await api.get('/api/allowance?refresh=1');
          render();
        } catch (refreshError) {
          toastError(refreshError);
        } finally {
          refresh.disabled = false;
        }
      },
    }, h('span', { html: icon('refresh-cw', 13) }), 'Refresh');
    card.append(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { html: icon('wallet', 18) }), h('strong', { class: 'grow' }, 'Your Copilot allowance'), allowance?.fetchedAt ? h('span', { class: 'faint', style: { fontSize: '12px' } }, `checked ${relativeTime(allowance.fetchedAt)}`) : null, refresh));
    if (!state.auth?.signedIn) {
      card.append(h('div', { class: 'faint' }, 'Sign in to see your allowance.'));
      return card;
    }
    if (!allowance) {
      card.append(h('div', { class: 'muted' }, error || 'Not loaded yet.'));
      return card;
    }
    const planLine = [allowance.plan ? `Plan: ${allowance.plan}` : null, allowance.sku ? allowance.sku.replace(/_/g, ' ') : null].filter(Boolean).join(' · ');
    if (allowance.unlimited) {
      card.append(h('div', { class: 'stat' }, h('span', { class: 'value' }, 'Unlimited'), h('span', { class: 'label' }, planLine)));
      return card;
    }
    if (!allowance.hasQuota || !allowance.entitlement) {
      card.append(h('div', { class: 'muted' }, 'GitHub reports no allowance for premium models on this plan.'), h('div', { class: 'faint', style: { fontSize: '12px' } }, planLine));
      return card;
    }
    const credits = allowance.tokenBased !== false;
    const used = allowance.used ?? Math.max(0, allowance.entitlement - (allowance.remaining ?? 0));
    const percentUsed = Math.min(100, Math.max(0, (used / allowance.entitlement) * 100));
    const amount = (value) => (credits ? formatCredits(value, unit()) : `${Math.round(value).toLocaleString()} requests`);
    const meterClass = percentUsed >= 100 ? 'meter over' : percentUsed >= 80 ? 'meter warn' : 'meter';
    card.append(
      h(
        'div',
        { class: 'grid-2' },
        h('div', { class: 'stat' }, h('span', { class: 'value' }, amount(allowance.remaining ?? allowance.entitlement - used)), h('span', { class: 'label' }, 'left this period')),
        h('div', { class: 'stat' }, h('span', { class: 'value' }, amount(used)), h('span', { class: 'label' }, `used of ${amount(allowance.entitlement)}`)),
      ),
      h('div', { class: meterClass, style: { height: '8px', margin: '12px 0 6px' }, role: 'meter', 'aria-valuenow': String(Math.round(percentUsed)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Allowance used' }, h('div', { style: { width: `${percentUsed}%` } })),
      h(
        'div',
        { class: 'row faint', style: { fontSize: '12.5px', flexWrap: 'wrap' } },
        h('span', {}, `${Math.round(percentUsed)}% used`),
        allowance.resetDate ? h('span', {}, `· resets ${new Date(allowance.resetDate).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`) : null,
        planLine ? h('span', {}, `· ${planLine}`) : null,
        allowance.overagePermitted ? h('span', {}, `· extra use beyond the allowance is allowed${allowance.overageCount ? ` (${allowance.overageCount} so far)` : ''}`) : null,
      ),
      h('div', { class: 'faint', style: { fontSize: '12px', marginTop: '6px' } }, 'This is your whole Copilot account, including VS Code, github.com and other tools. The section below is only what this app spent.'),
    );
    return card;
  }

  function dailyDays() {
    const byDay = new Map(summary.byDay.map((entry) => [entry.day, entry]));
    const end = new Date();
    let start;
    if (summary.since) start = new Date(summary.since);
    else start = summary.byDay.length ? new Date(`${summary.byDay[0].day}T00:00:00`) : new Date();
    const days = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const entry = byDay.get(key);
      days.push({ day: key, nanoAiu: entry?.nanoAiu || 0, requests: entry?.requests || 0, unpriced: entry?.unpricedRequests || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return days.slice(-MAX_DAYS);
  }

  function dailyCard() {
    const card = h('div', { class: 'card', style: { marginTop: '12px' } });
    const toggle = h('button', { class: 'btn ghost small', onClick: () => { showTable = !showTable; render(); } }, h('span', { html: icon(showTable ? 'chart-column' : 'layers', 14) }), showTable ? 'Show chart' : 'Show table');
    card.append(h('div', { class: 'row', style: { marginBottom: '6px' } }, h('strong', { class: 'grow' }, `Spent per day (${unit() === 'usd' ? 'US$' : 'AI credits'})`), toggle));
    const days = dailyDays();
    if (days.length === 0 || days.every((day) => day.requests === 0)) {
      card.append(h('div', { class: 'faint' }, 'No requests in this period.'));
      return card;
    }
    if (showTable) {
      card.append(
        h(
          'table',
          { class: 'data-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Spent'))),
          h('tbody', {}, days.filter((day) => day.requests > 0).reverse().map((day) => h('tr', {}, h('td', {}, formatDay(day.day, true)), h('td', { class: 'num' }, String(day.requests)), h('td', { class: 'num' }, formatCost(day.nanoAiu, unit(), { unpriced: day.unpriced }))))),
        ),
      );
      return card;
    }
    const chartHost = h('div');
    card.append(chartHost);
    onNextFrame(() => drawChart(chartHost, days));
    resizeObserver = new ResizeObserver(() => drawChart(chartHost, days));
    resizeObserver.observe(chartHost);
    return card;
  }

  /**
   * One series of bars: rounded data end at the top, square at the baseline, 2 px gaps,
   * recessive grid, and a hover target the full height of each day.
   */
  function drawChart(host, days) {
    const width = Math.max(320, host.clientWidth);
    const height = 180;
    const margin = { top: 10, right: 8, bottom: 22, left: 44 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const toValue = (nano) => (unit() === 'usd' ? nano / 1e11 : nano / 1e9);
    const values = days.map((day) => toValue(day.nanoAiu));
    const max = niceMax(Math.max(...values, unit() === 'usd' ? 0.01 : 1));
    const slot = plotWidth / days.length;
    const gap = 2;
    const barWidth = Math.max(1, slot - gap);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Spent per day, highest ${max} ${unit() === 'usd' ? 'dollars' : 'credits'}`);
    const add = (tag, attributes, text) => {
      const element = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
      if (text !== undefined) element.textContent = text;
      svg.append(element);
      return element;
    };
    // niceMax gives 1, 2, 2.5 or 5 times a power of ten: 4 steps for 2, otherwise 5, so each step is 1, 2 or 5
    // times a power of ten and its label needs no rounding.
    const fraction = max / 10 ** Math.floor(Math.log10(max));
    const steps = Math.abs(fraction - 2) < 1e-9 ? 4 : 5;
    const stepSize = max / steps;
    const decimals = stepSize >= 1 ? 0 : Math.max(unit() === 'usd' ? 2 : 1, -Math.floor(Math.log10(stepSize) + 1e-9));
    for (let step = 0; step <= steps; step++) {
      const value = stepSize * step;
      const y = margin.top + plotHeight - (value / max) * plotHeight;
      add('line', { class: 'axis', x1: margin.left, x2: width - margin.right, y1: y, y2: y, 'stroke-width': step === 0 ? 1 : 0.5, 'stroke-dasharray': step === 0 ? '' : '2 3' });
      add('text', { x: margin.left - 6, y: y + 3, 'text-anchor': 'end' }, unit() === 'usd' ? `$${value.toFixed(decimals)}` : value.toFixed(decimals));
    }
    const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotWidth / 56)));
    days.forEach((day, index) => {
      const x = margin.left + index * slot + gap / 2;
      const value = values[index];
      const barHeight = value > 0 ? Math.max(2, (value / max) * plotHeight) : 0;
      const y = margin.top + plotHeight - barHeight;
      if (barHeight > 0) {
        const radius = Math.min(4, barWidth / 2, barHeight);
        add('path', { class: 'bar', d: `M${x},${y + barHeight} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + barWidth - radius} Q${x + barWidth},${y} ${x + barWidth},${y + radius} V${y + barHeight} Z` });
      }
      const hit = add('rect', { x: margin.left + index * slot, y: margin.top, width: slot, height: plotHeight, fill: 'transparent' });
      hit.addEventListener('mousemove', (event) => {
        tooltip.hidden = false;
        tooltip.textContent = `${formatDay(day.day, true)}: ${formatCost(day.nanoAiu, unit(), { unpriced: day.unpriced })} · ${day.requests} request${day.requests === 1 ? '' : 's'}`;
        tooltip.style.left = `${event.clientX + 12}px`;
        tooltip.style.top = `${event.clientY - 30}px`;
      });
      hit.addEventListener('mouseleave', () => {
        tooltip.hidden = true;
      });
      if (index % labelEvery === 0) add('text', { x: margin.left + index * slot + slot / 2, y: height - 6, 'text-anchor': 'middle' }, formatDay(day.day));
    });
    clear(host).append(svg);
  }

  function sessionsTable() {
    const sessions = summary.bySession;
    if (sessions.length === 0) return h('div', { class: 'faint' }, 'No sessions in this period.');
    const table = h(
      'div',
      { class: 'card', style: { padding: '4px 8px' } },
      h(
        'table',
        { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Session'), h('th', {}, 'Folder'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Tokens in / out'), h('th', { class: 'num' }, 'Spent'))),
        h(
          'tbody',
          {},
          sessions.map((row) =>
            h(
              'tr',
              { class: row.exists ? 'clickable' : '', title: row.exists ? 'Open session' : 'This session was deleted', onClick: () => row.exists && actions.openSession(row.sessionId) },
              h('td', { class: row.exists ? '' : 'faint' }, row.title),
              h('td', { class: 'faint ellipsis', style: { maxWidth: '220px' }, title: row.cwd || '' }, row.cwd ? row.cwd.split(/[\\/]/).pop() : ''),
              h('td', { class: 'num' }, String(row.requests)),
              h('td', { class: 'num' }, `${formatTokens(row.input + row.cacheRead + row.cacheWrite)} / ${formatTokens(row.output)}`),
              h('td', { class: 'num' }, formatCost(row.nanoAiu, unit(), { unpriced: row.unpricedRequests })),
            ),
          ),
        ),
      ),
    );
    return table;
  }

  function modelsTable() {
    return simpleTable(summary.byModel.map((row) => [modelLabel(row.model), row.requests, formatCost(row.nanoAiu, unit(), { unpriced: row.unpricedRequests })]), 'Model');
  }

  function kindsTable() {
    return simpleTable(summary.byKind.map((row) => [KIND_LABELS[row.kind] || row.kind, row.requests, formatCost(row.nanoAiu, unit(), { unpriced: row.unpricedRequests })]), 'Purpose');
  }

  function simpleTable(entries, label) {
    if (entries.length === 0) return h('div', { class: 'faint' }, 'Nothing in this period.');
    const header = h('thead', {}, h('tr', {}, h('th', {}, label), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Spent')));
    const body = h('tbody', {}, entries.map(([name, requests, cost]) => h('tr', {}, h('td', {}, name), h('td', { class: 'num' }, String(requests)), h('td', { class: 'num' }, cost))));
    const table = h('div', { class: 'card', style: { padding: '4px 8px' } }, h('table', { class: 'data-table' }, header, body));
    return table;
  }

  subscriptions.push(on('allowance', render), on('settings', render), on('usage', load));
  load();
  if (state.auth?.signedIn) api.get('/api/allowance').then((allowance) => { state.allowance = allowance; render(); }).catch(() => {});

  return {
    destroy() {
      for (const unsubscribe of subscriptions) unsubscribe();
      resizeObserver?.disconnect();
      tooltip.remove();
      container.firstChild?.remove();
    },
  };
}

function niceMax(value) {
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

function formatDay(day, long = false) {
  const date = new Date(`${day}T00:00:00`);
  return date.toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
}
