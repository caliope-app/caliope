// web_fetch: read a public web page or document as plain text.
import { ToolInputError } from './fs-tools.js';
import { truncateEnd, siteOf } from '../util.js';
import { userAgent } from '../auth.js';
import { looksBinary } from './files.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHARS = 60000;

export const webFetchTool = {
  name: 'web_fetch',
  kind: 'web',
  description:
    'Fetch a web page or text document over http(s) and return it as plain text (HTML is converted to text). ' +
    'Use it for documentation, changelogs and API references. It cannot sign in or run JavaScript.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The http or https URL.' } },
    required: ['url'],
  },
  targetHost(input) {
    return siteOf(input.url);
  },
  async run(input, ctx) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      throw new ToolInputError(`"${input.url}" is not a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolInputError('Only http and https URLs can be fetched.');
    const timeout = AbortSignal.timeout(20000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    let response;
    // Redirects are followed within the approved site only (scheme, host and port). Another needs its own approval.
    for (let hops = 0; ; hops++) {
      try {
        response = await fetch(url, { signal, redirect: 'manual', headers: { 'User-Agent': userAgent(), Accept: 'text/html,text/plain,application/json,*/*;q=0.5' } });
      } catch (error) {
        throw new ToolInputError(`Could not fetch ${url.href}: ${error.cause?.code || error.message}`);
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;
      const next = new URL(location, url);
      await response.body?.cancel().catch(() => {});
      if (hops >= 5) throw new ToolInputError(`${input.url} redirects too many times.`);
      // http://host to https://host on the default ports is the same site. Another port is another service.
      const upgrade = url.protocol === 'http:' && next.protocol === 'https:' && next.hostname === url.hostname && url.port === '' && next.port === '';
      if (siteOf(next.href) !== url.origin && !upgrade) {
        return { content: `${url.href} redirects to ${next.href}, on another site. Fetch that address to continue; it may need the user's approval.`, meta: { url: url.href, status: response.status, redirect: next.href } };
      }
      url = next;
    }
    const contentType = response.headers.get('content-type') || '';
    const bytes = await readLimited(response, MAX_BYTES);
    let text = new TextDecoder('utf-8').decode(bytes);
    // Servers often send text files, such as an API spec in YAML, as application/octet-stream: judge those by their bytes.
    const textAsBytes = /octet-stream/i.test(contentType) && !looksBinary(bytes);
    if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text);
    else if (!/text|json|xml|javascript|yaml|csv|markdown/i.test(contentType) && contentType && !textAsBytes) {
      throw new ToolInputError(`${url.href} returned ${contentType}, which is not text.`);
    }
    const status = response.ok ? '' : `HTTP ${response.status} ${response.statusText}\n`;
    const content = `${status}${truncateEnd(text.trim(), MAX_CHARS, 'page is longer')}`;
    return { content, isError: !response.ok, meta: { url: response.url || url.href, status: response.status, contentType } };
  },
};

// web_search: OpenAI's web search through Copilot (ctx.searchWeb), else DuckDuckGo's HTML results page,
// which needs no account or key.
const SEARCH_URL = 'https://html.duckduckgo.com/html/';
// The approval and "allow for this session" cover searching itself, not one site.
export const WEB_SEARCH_SITE = 'web search';

export const webSearchTool = {
  name: 'web_search',
  kind: 'web',
  description:
    'Search the web and get the top results: title, address and what the page says. Use it to find documentation, ' +
    'release notes, error messages or answers when you do not know the address, then read the pages with web_fetch. ' +
    'Put versions, product names or a quoted error in the query; add site:example.com to search one site.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search terms.' },
      max_results: { type: 'integer', description: 'How many results to return, 1 to 10. Default 8.' },
    },
    required: ['query'],
  },
  targetHost() {
    return WEB_SEARCH_SITE;
  },
  async run(input, ctx) {
    const query = String(input.query || '').trim();
    if (!query) throw new ToolInputError('The query is empty.');
    const limit = Math.min(10, Math.max(1, Number.isInteger(input.max_results) ? input.max_results : 8));
    let copilotResults = null;
    let copilotError = null;
    try {
      copilotResults = ctx.searchWeb ? await ctx.searchWeb(query, limit) : null;
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      copilotError = error.message;
    }
    if (copilotResults) {
      const content = `Results for "${query}":\n\n${copilotResults}`;
      return { content, meta: { query, via: 'copilot' } };
    }
    const result = await searchDuckDuckGo(query, limit, ctx.signal);
    result.meta.copilotError = copilotError;
    return result;
  },
};

async function searchDuckDuckGo(query, limit, abortSignal) {
  const timeout = AbortSignal.timeout(20000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, { signal, headers: { 'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${userAgent()}`, Accept: 'text/html' } });
  } catch (error) {
    throw new ToolInputError(`The web search could not reach DuckDuckGo: ${error.cause?.code || error.message}`);
  }
  if (!response.ok) throw new ToolInputError(`DuckDuckGo answered HTTP ${response.status}; try again in a moment or fetch a known address with web_fetch.`);
  const results = parseSearchResults(await response.text()).slice(0, limit);
  const lines = results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`);
  const content = lines.length ? `Results for "${query}":\n\n${lines.join('\n\n')}` : `No results for "${query}". Try other words.`;
  return { content, meta: { query, via: 'duckduckgo', count: results.length } };
}

/** The organic results of a DuckDuckGo HTML page: [{ title, url, snippet }]; ads are left out. */
export function parseSearchResults(html) {
  const results = [];
  for (const block of html.split(/<div class="result results_links/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const href = link[1].replace(/&amp;/g, '&');
    // Links go through DuckDuckGo's redirect, with the address in `uddg`.
    const target = /[?&]uddg=([^&]+)/.exec(href);
    let url = target ? decodeURIComponent(target[1]) : href.startsWith('//') ? `https:${href}` : href;
    if (!/^https?:\/\//.test(url)) continue;
    url = url.trim();
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: htmlToText(link[2]).replace(/\s+/g, ' ').trim(), url, snippet: snippet ? htmlToText(snippet[1]).replace(/\s+/g, ' ').trim() : '' });
  }
  return results;
}

async function readLimited(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) break;
  }
  const bytes = Buffer.concat(chunks).subarray(0, maxBytes);
  return bytes;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»' };

/** Rough HTML to text: drops scripts and styles, keeps line structure, decodes entities. */
export function htmlToText(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|section|article|header|footer|tr|h[1-6]|pre|blockquote|table|ul|ol|dl|dt|dd)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (match, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
  const cleaned = text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return cleaned;
}
