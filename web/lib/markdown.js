// Markdown rendering for model output.
// Model output is untrusted: raw HTML is shown as text, links are limited to http(s)/mailto, and
// remote images are not loaded. The page's Content-Security-Policy blocks inline scripts as well.
import { escapeHtml } from './dom.js';
import { highlight, normalizeLanguage } from './highlight.js';

const { Marked } = window.marked;

function safeUrl(href) {
  try {
    const url = new URL(href, 'http://invalid.local/');
    if (url.origin === 'http://invalid.local') return null;
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const markdown = new Marked({ gfm: true, breaks: false });
markdown.use({
  renderer: {
    html(token) {
      return escapeHtml(token.text ?? token.raw ?? '');
    },
    link(token) {
      const inner = this.parser.parseInline(token.tokens);
      const href = safeUrl(token.href);
      if (!href) return inner;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image(token) {
      const href = safeUrl(token.href);
      const label = escapeHtml(token.text || 'image');
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">[image: ${label}]</a>` : `[image: ${label}]`;
    },
    code(token) {
      const language = (token.lang || '').split(/\s+/)[0];
      const known = normalizeLanguage(language);
      const body = highlight(token.text, language);
      const label = escapeHtml(language || 'text');
      return `<div class="code-block" data-lang="${label}"><div class="code-head"><span>${label}</span><button class="code-copy" type="button" data-copy-code>Copy</button></div><pre class="${known ? `lang-${known}` : ''}"><code>${body}</code></pre></div>`;
    },
    table(token) {
      const header = token.header.map((cell) => `<th${align(cell.align)}>${this.parser.parseInline(cell.tokens)}</th>`).join('');
      const rows = token.rows.map((row) => `<tr>${row.map((cell) => `<td${align(cell.align)}>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`).join('');
      return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

function align(value) {
  return value ? ` style="text-align:${value}"` : '';
}

export function renderMarkdown(text) {
  try {
    return markdown.parse(String(text ?? ''));
  } catch (error) {
    console.error('Markdown failed', error);
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

/** Copy buttons in rendered code blocks (one listener for the whole app). */
export function installCodeCopy(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-code]');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('code')?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1500);
  });
}
