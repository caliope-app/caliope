// File tools: read_file, list_dir, glob, grep, edit_file, write_file, notebook_edit.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { resolvePath, displayPath, pathKey } from './paths.js';
import { listProjectFiles, looksBinary } from './files.js';
import { createGlobMatcher } from './glob.js';
import { decodeText, encodeText, usesCrlf, toCrlf, countOccurrences, replaceLiteral } from './text-files.js';
import { diffTexts } from '../../shared/diff.js';
import { mapLimit, stripAnsi, KeyedQueue } from '../util.js';
import { renderPdfPages } from '../windows.js';

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GREP_FILE_BYTES = 4 * 1024 * 1024;
const MATCH_LINES = new vm.Script('(() => { const expression = new RegExp(pattern, flags); const hits = []; for (let i = 0; i < lines.length; i++) if (expression.test(lines[i])) hits.push(i); return hits; })()');

export class ToolInputError extends Error {}

export const readFileTool = {
  name: 'read_file',
  kind: 'read',
  description:
    'Read a file. Returns the content with line numbers (`12\\tcode`); the numbers are not part of the file. ' +
    'Reads up to 2000 lines from `offset` (1-based); pass `offset` and `limit` to read more of a long file. ' +
    'Images (png, jpg, gif, webp) are returned as images; PDFs as one image per page (use `pages` for long ones); ' +
    'Jupyter notebooks (.ipynb) as cells with their outputs. You must read a file before you edit or overwrite it.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the project folder.' },
      offset: { type: 'integer', description: 'First line to read, 1-based. Default 1.' },
      limit: { type: 'integer', description: 'Number of lines to read. Default 2000.' },
      pages: { type: 'string', description: 'For a PDF: the pages to read, such as "3" or "1-5". Default: the first 10. At most 20 per read.' },
    },
    required: ['path'],
  },
  async run(input, ctx) {
    const absolutePath = resolvePath(ctx.cwd, input.path);
    const shownPath = displayPath(ctx.cwd, absolutePath);
    const stat = await statOrThrow(absolutePath, shownPath);
    if (stat.isDirectory()) throw new ToolInputError(`${shownPath} is a folder. Use list_dir to see what it contains.`);
    const extension = path.extname(absolutePath).toLowerCase();
    if (extension === '.pdf') return readPdf(absolutePath, shownPath, input.pages);
    if (extension === '.ipynb') return readNotebook(absolutePath, shownPath, stat, ctx);
    if (IMAGE_TYPES[extension]) {
      if (stat.size > MAX_IMAGE_BYTES) throw new ToolInputError(`${shownPath} is ${formatBytes(stat.size)}; images over 5 MB are not sent to the model.`);
      const data = (await fsp.readFile(absolutePath)).toString('base64');
      ctx.recordRead(absolutePath, stat);
      return {
        content: [
          { type: 'image', mediaType: IMAGE_TYPES[extension], data },
          { type: 'text', text: `Image ${shownPath} (${formatBytes(stat.size)}).` },
        ],
        meta: { path: shownPath, image: true },
      };
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new ToolInputError(`${shownPath} is ${formatBytes(stat.size)}, too large to read. Use grep to find the part you need.`);
    }
    const buffer = await fsp.readFile(absolutePath);
    if (looksBinary(buffer) && !(buffer[0] === 0xff && buffer[1] === 0xfe)) {
      throw new ToolInputError(`${shownPath} is a binary file (${formatBytes(stat.size)}).`);
    }
    const { text, encoding } = decodeText(buffer);
    ctx.recordRead(absolutePath, stat);
    if (text.length === 0) return { content: `${shownPath} is empty.`, meta: { path: shownPath, totalLines: 0 } };
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const offset = Math.max(1, Number.isInteger(input.offset) ? input.offset : 1);
    const limit = Math.max(1, Number.isInteger(input.limit) ? input.limit : DEFAULT_READ_LINES);
    if (offset > lines.length) {
      throw new ToolInputError(`${shownPath} has ${lines.length} lines; offset ${offset} is past the end.`);
    }
    const end = Math.min(lines.length, offset - 1 + limit);
    const numbered = [];
    for (let i = offset - 1; i < end; i++) {
      let line = lines[i];
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${line.length} characters]`;
      // Unpadded numbers: padding costs about a token per line on every read.
      numbered.push(`${i + 1}\t${line}`);
    }
    const notes = [];
    if (end < lines.length) notes.push(`(Showing lines ${offset}-${end} of ${lines.length}. Use offset ${end + 1} to read further.)`);
    if (encoding === 'latin1') notes.push('(This file is not UTF-8; it was read as Windows-1252/Latin-1.)');
    const content = [numbered.join('\n'), ...notes].join('\n');
    return { content, meta: { path: shownPath, startLine: offset, endLine: end, totalLines: lines.length } };
  },
};

const DEFAULT_PDF_PAGES = 10;
const MAX_PDF_PAGES = 20;

/** A PDF as one image per page, rendered by Windows; `pages` is "3" or "1-5". */
async function readPdf(absolutePath, shownPath, pages) {
  let first = 1;
  let last = DEFAULT_PDF_PAGES;
  if (pages !== undefined && pages !== null && String(pages).trim()) {
    const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(pages));
    if (!range) throw new ToolInputError('pages must be a page number or a range such as "1-5".');
    first = Number(range[1]);
    last = Number(range[2] || range[1]);
    if (first < 1 || last < first) throw new ToolInputError('pages must start at 1 or later and end at or after its start.');
    if (last - first + 1 > MAX_PDF_PAGES) throw new ToolInputError(`Read at most ${MAX_PDF_PAGES} pages at a time.`);
  }
  let rendered;
  try {
    rendered = await renderPdfPages(absolutePath, { first, last });
  } catch (error) {
    throw new ToolInputError(`Windows could not open ${shownPath} as a PDF (damaged or password-protected?): ${error.message}`);
  }
  if (first > rendered.pageCount) throw new ToolInputError(`${shownPath} has ${rendered.pageCount} pages.`);
  const shownLast = first + rendered.pages.length - 1;
  const more = shownLast < rendered.pageCount ? ` Read more with pages, for example "${shownLast + 1}-${Math.min(rendered.pageCount, shownLast + DEFAULT_PDF_PAGES)}".` : '';
  const content = [{ type: 'text', text: `PDF ${shownPath}: pages ${first}-${shownLast} of ${rendered.pageCount}, one image per page.${more}` }];
  rendered.pages.forEach((data, index) => content.push({ type: 'text', text: `Page ${first + index}:` }, { type: 'image', mediaType: 'image/jpeg', data }));
  return { content, meta: { path: shownPath, pdf: true, firstPage: first, lastPage: shownLast, pageCount: rendered.pageCount } };
}

const MAX_NOTEBOOK_OUTPUT_CHARS = 3000;
const MAX_NOTEBOOK_IMAGES = 6;

/** A Jupyter notebook as its cells (id, index, type) with their outputs; images in outputs come along as images. */
async function readNotebook(absolutePath, shownPath, stat, ctx) {
  if (stat.size > MAX_READ_BYTES) throw new ToolInputError(`${shownPath} is ${formatBytes(stat.size)}, too large to read. Use grep to find the part you need.`);
  let notebook;
  try {
    notebook = JSON.parse(decodeText(await fsp.readFile(absolutePath)).text);
  } catch (error) {
    throw new ToolInputError(`${shownPath} is not a valid notebook (${error.message}).`);
  }
  ctx.recordRead(absolutePath, stat);
  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
  const language = notebook.metadata?.kernelspec?.language || notebook.metadata?.language_info?.name || 'unknown';
  const parts = [`Notebook ${shownPath}: ${cells.length} cells, ${language}. Change cells with notebook_edit (by id or index).`];
  const images = [];
  cells.forEach((cell, index) => {
    const id = cell.id ? ` id="${cell.id}"` : '';
    const count = cell.cell_type === 'code' && cell.execution_count ? ` execution_count=${cell.execution_count}` : '';
    parts.push(`<cell index=${index}${id} type=${cell.cell_type}${count}>\n${joinSource(cell.source)}\n</cell>`);
    for (const output of cell.outputs || []) {
      const text = notebookOutputText(output);
      if (text) parts.push(`<output type=${output.output_type}>\n${text.length > MAX_NOTEBOOK_OUTPUT_CHARS ? `${text.slice(0, MAX_NOTEBOOK_OUTPUT_CHARS)}… [output truncated, ${text.length} characters]` : text}\n</output>`);
      const png = output.data?.['image/png'];
      if (png && images.length < MAX_NOTEBOOK_IMAGES) images.push({ index, data: joinSource(png).replace(/\s+/g, '') });
    }
  });
  const text = parts.join('\n');
  if (images.length === 0) return { content: text, meta: { path: shownPath, notebook: true, cells: cells.length } };
  const content = [{ type: 'text', text }];
  for (const image of images) content.push({ type: 'text', text: `Image output of cell ${image.index}:` }, { type: 'image', mediaType: 'image/png', data: image.data });
  return { content, meta: { path: shownPath, notebook: true, cells: cells.length } };
}

/** Notebook sources and outputs are a string or a list of lines. */
function joinSource(source) {
  const text = Array.isArray(source) ? source.join('') : String(source ?? '');
  return text;
}

function notebookOutputText(output) {
  if (output.output_type === 'stream') return stripAnsi(joinSource(output.text));
  if (output.output_type === 'error') return stripAnsi(`${output.ename}: ${output.evalue}\n${(output.traceback || []).join('\n')}`);
  const plain = output.data?.['text/plain'];
  return plain ? joinSource(plain) : '';
}

export const listDirTool = {
  name: 'list_dir',
  kind: 'read',
  description: 'List the files and folders directly inside a folder, with file sizes. Folders end with "/".',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Folder path; defaults to the project folder.' } },
    required: [],
  },
  async run(input, ctx) {
    const absolutePath = resolvePath(ctx.cwd, input.path || '.');
    const shownPath = displayPath(ctx.cwd, absolutePath);
    const stat = await statOrThrow(absolutePath, shownPath);
    if (!stat.isDirectory()) throw new ToolInputError(`${shownPath} is a file, not a folder.`);
    const entries = await fsp.readdir(absolutePath, { withFileTypes: true });
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const shown = entries.slice(0, 1000);
    const lines = await mapLimit(shown, 32, async (entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      try {
        const entryStat = await fsp.stat(path.join(absolutePath, entry.name));
        return `${entry.name}  (${formatBytes(entryStat.size)})`;
      } catch {
        return entry.name;
      }
    });
    if (entries.length > shown.length) lines.push(`… and ${entries.length - shown.length} more entries`);
    const content = lines.length ? `${shownPath}:\n${lines.join('\n')}` : `${shownPath} is empty.`;
    return { content, meta: { path: shownPath, count: entries.length } };
  },
};

export const globTool = {
  name: 'glob',
  kind: 'read',
  description:
    'Find files by name pattern, like "**/*.py" or "src/**/test_*.js". A pattern without "/" matches file names in any folder. ' +
    'Respects .gitignore in git repositories. Returns up to 200 paths, most recently changed first.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Folder to search; defaults to the project folder.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const base = resolvePath(ctx.cwd, input.path || '.');
    const shownBase = displayPath(ctx.cwd, base);
    const stat = await statOrThrow(base, shownBase);
    if (!stat.isDirectory()) throw new ToolInputError(`${shownBase} is not a folder.`);
    const { files, truncated } = await listProjectFiles(base, { extraPath: ctx.extraPath, signal: ctx.signal });
    const matches = createGlobMatcher(input.pattern);
    const matched = files.filter((relative) => matches(relative) && !ctx.isHidden?.(path.join(base, relative)));
    const withTimes = await mapLimit(matched.slice(0, 5000), 32, async (relative) => {
      const absolutePath = path.join(base, relative);
      try {
        const fileStat = await fsp.stat(absolutePath);
        return { absolutePath, mtimeMs: fileStat.mtimeMs };
      } catch {
        return null;
      }
    });
    const existing = withTimes.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = existing.slice(0, 200).map((item) => displayPath(ctx.cwd, item.absolutePath));
    const notes = [];
    if (existing.length > shown.length) notes.push(`(${existing.length} matches; showing the 200 most recently changed. Narrow the pattern to see others.)`);
    if (truncated) notes.push('(The folder has more than 100,000 files; only the first 100,000 were searched.)');
    const content = shown.length ? [...shown, ...notes].join('\n') : `No files match "${input.pattern}" in ${shownBase}.`;
    return { content, meta: { count: existing.length } };
  },
};

/**
 * A grep pattern as JavaScript RegExp source and flags.
 * - Models write ripgrep patterns: a leading (?i), (?s), (?m) or a mix such as (?is) becomes flags.
 *   JavaScript has no such prefix. Only i matters when matching line by line.
 */
export function grepExpression(pattern, ignoreCase = false) {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  const expression = { source: inline ? pattern.slice(inline[0].length) : pattern, flags: ignoreCase || inline?.[1].includes('i') ? 'i' : '' };
  return expression;
}

export const grepTool = {
  name: 'grep',
  kind: 'read',
  description:
    'Search file contents with a regular expression, line by line. Respects .gitignore in git repositories and skips binary files. ' +
    'output_mode "content" (default) returns matching lines as path:line:text; "files" returns file paths; "count" returns match counts per file. ' +
    'Use `glob` to limit the files searched, for example "*.ts" or "src/**/*.py".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (JavaScript syntax; a leading (?i) works like ignore_case).' },
      path: { type: 'string', description: 'File or folder to search; defaults to the project folder.' },
      glob: { type: 'string', description: 'Only search files matching this glob.' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      output_mode: { type: 'string', enum: ['content', 'files', 'files_with_matches', 'count'], description: 'Result format. Default "content".' },
      context_lines: { type: 'integer', description: 'Lines of context around each match in content mode. Default 0, max 10.' },
      max_results: { type: 'integer', description: 'Maximum matches (content mode) or files to return. Default 200.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    // `-i` is Claude Code's name for ignore_case. Claude models sometimes send it.
    const { source, flags } = grepExpression(input.pattern, input.ignore_case || input['-i']);
    try {
      new RegExp(source, flags);
    } catch (error) {
      throw new ToolInputError(`Invalid regular expression: ${error.message}`);
    }
    // The pattern comes from the model. Run it with a time limit so a runaway pattern cannot freeze the app.
    const matcher = vm.createContext({ pattern: source, flags, lines: [] });
    const base = resolvePath(ctx.cwd, input.path || '.');
    const shownBase = displayPath(ctx.cwd, base);
    const stat = await statOrThrow(base, shownBase);
    let candidates;
    let truncatedListing = false;
    if (stat.isFile()) {
      candidates = [base];
    } else {
      const listing = await listProjectFiles(base, { extraPath: ctx.extraPath, signal: ctx.signal });
      truncatedListing = listing.truncated;
      const matchesGlob = input.glob ? createGlobMatcher(input.glob) : () => true;
      candidates = listing.files
        .filter(matchesGlob)
        .map((relative) => path.join(base, relative))
        .filter((absolutePath) => !ctx.isHidden?.(absolutePath));
    }
    // "files_with_matches" is ripgrep's and Claude Code's name for "files".
    const mode = input.output_mode === 'files_with_matches' ? 'files' : ['content', 'files', 'count'].includes(input.output_mode) ? input.output_mode : 'content';
    const context = Math.min(10, Math.max(0, Number.isInteger(input.context_lines) ? input.context_lines : 0));
    const maxResults = Math.min(2000, Math.max(1, Number.isInteger(input.max_results) ? input.max_results : 200));

    const perFile = await mapLimit(candidates, 16, async (absolutePath) => {
      if (ctx.signal?.aborted) return null;
      let buffer;
      try {
        const fileStat = await fsp.stat(absolutePath);
        if (!fileStat.isFile() || fileStat.size > MAX_GREP_FILE_BYTES) return null;
        buffer = await fsp.readFile(absolutePath);
      } catch {
        return null;
      }
      if (looksBinary(buffer)) return null;
      const lines = decodeText(buffer).text.split(/\r?\n/);
      matcher.lines = lines;
      let hits;
      try {
        hits = MATCH_LINES.runInContext(matcher, { timeout: 3000 });
      } catch (error) {
        if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
          throw new ToolInputError(`The regular expression took more than 3 seconds on ${displayPath(ctx.cwd, absolutePath)}. Use a simpler pattern (avoid nested repeats like (a+)+).`);
        }
        throw error;
      }
      return hits.length ? { absolutePath, lines, hits: [...hits] } : null;
    });
    const results = perFile.filter(Boolean);
    const totalMatches = results.reduce((sum, result) => sum + result.hits.length, 0);
    if (results.length === 0) {
      return { content: `No matches for /${input.pattern}/ in ${shownBase}.`, meta: { matches: 0, files: 0 } };
    }

    const output = [];
    let shownCount = 0;
    if (mode === 'files') {
      for (const result of results.slice(0, maxResults)) output.push(displayPath(ctx.cwd, result.absolutePath));
      shownCount = Math.min(results.length, maxResults);
      if (results.length > maxResults) output.push(`(${results.length} files match; showing ${maxResults}.)`);
    } else if (mode === 'count') {
      for (const result of results.slice(0, maxResults)) output.push(`${displayPath(ctx.cwd, result.absolutePath)}:${result.hits.length}`);
      shownCount = Math.min(results.length, maxResults);
      if (results.length > maxResults) output.push(`(${results.length} files match; showing ${maxResults}.)`);
    } else {
      outer: for (const result of results) {
        const shownPath = displayPath(ctx.cwd, result.absolutePath);
        const printed = new Set();
        let lastPrinted = -2;
        for (const hit of result.hits) {
          if (shownCount >= maxResults) break outer;
          const from = Math.max(0, hit - context);
          const to = Math.min(result.lines.length - 1, hit + context);
          if (context > 0 && lastPrinted >= 0 && from > lastPrinted + 1) output.push('--');
          for (let i = from; i <= to; i++) {
            if (printed.has(i)) continue;
            printed.add(i);
            const separator = i === hit || result.hits.includes(i) ? ':' : '-';
            output.push(`${shownPath}${separator}${i + 1}${separator}${clip(result.lines[i], 300)}`);
            lastPrinted = i;
          }
          shownCount++;
        }
      }
      if (totalMatches > shownCount) output.push(`(${totalMatches} matches in ${results.length} files; showing the first ${shownCount}. Narrow the search or raise max_results.)`);
    }
    if (truncatedListing) output.push('(The folder has more than 100,000 files; only the first 100,000 were searched.)');
    return { content: output.join('\n'), meta: { matches: totalMatches, files: results.length } };
  },
};

/**
 * Work out an edit without writing it, so the user can review the diff first.
 * - Returns the file's bytes before and after. `commitFileChange` writes them.
 */
async function prepareEdit(input, ctx) {
  const absolutePath = resolvePath(ctx.cwd, input.path);
  const shownPath = displayPath(ctx.cwd, absolutePath);
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
    throw new ToolInputError('old_string and new_string must both be text.');
  }
  if (input.old_string === '') throw new ToolInputError('old_string is empty. To create or replace a whole file, use write_file.');
  if (input.old_string === input.new_string) throw new ToolInputError('old_string and new_string are the same; nothing would change.');
  const stat = await statOrThrow(absolutePath, shownPath);
  if (stat.isDirectory()) throw new ToolInputError(`${shownPath} is a folder.`);
  assertReadAndUnchanged(ctx, absolutePath, shownPath, stat);
  const beforeBuffer = await fsp.readFile(absolutePath);
  const { text, encoding } = decodeText(beforeBuffer);

  let search = input.old_string;
  let replacement = input.new_string;
  let count = countOccurrences(text, search);
  if (count === 0 && text.includes('\r\n') && search.includes('\n')) {
    // The model sees lines without their CR. Match the file's CRLF line endings.
    const crlfSearch = toCrlf(search);
    const crlfCount = countOccurrences(text, crlfSearch);
    if (crlfCount > 0) {
      search = crlfSearch;
      replacement = toCrlf(replacement);
      count = crlfCount;
    }
  }
  if (count === 0) {
    throw new ToolInputError(`old_string was not found in ${shownPath}. Copy it exactly from read_file output (without line numbers), including indentation.`);
  }
  if (count > 1 && !input.replace_all) {
    throw new ToolInputError(`old_string occurs ${count} times in ${shownPath}. Add surrounding lines to make it unique, or set replace_all to true.`);
  }
  if (!search.includes('\n') && usesCrlf(text) && replacement.includes('\n')) replacement = toCrlf(replacement);
  const afterText = replaceLiteral(text, search, replacement, Boolean(input.replace_all));
  const afterBuffer = encodeText(afterText, encoding);
  const prepared = { absolutePath, shownPath, beforeBuffer, afterBuffer, beforeText: text, afterText, created: false, replacements: input.replace_all ? count : 1, mtimeMs: stat.mtimeMs };
  return prepared;
}

async function prepareWrite(input, ctx) {
  const absolutePath = resolvePath(ctx.cwd, input.path);
  const shownPath = displayPath(ctx.cwd, absolutePath);
  if (typeof input.content !== 'string') throw new ToolInputError('content must be text.');
  let stat = null;
  try {
    stat = await fsp.stat(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isDirectory()) throw new ToolInputError(`${shownPath} is a folder.`);
  let beforeBuffer = null;
  let beforeText = '';
  let afterText = input.content;
  let encoding = 'utf8';
  if (stat) {
    assertReadAndUnchanged(ctx, absolutePath, shownPath, stat);
    beforeBuffer = await fsp.readFile(absolutePath);
    const decoded = decodeText(beforeBuffer);
    beforeText = decoded.text;
    encoding = decoded.encoding;
    // Keep the file's line endings so the change does not touch every line.
    if (usesCrlf(beforeText) && !afterText.includes('\r\n')) afterText = toCrlf(afterText);
  }
  const afterBuffer = encodeText(afterText, encoding);
  const prepared = { absolutePath, shownPath, beforeBuffer, afterBuffer, beforeText, afterText, created: !stat, mtimeMs: stat?.mtimeMs ?? null };
  return prepared;
}

function assertReadAndUnchanged(ctx, absolutePath, shownPath, stat) {
  const record = ctx.readFiles[pathKey(absolutePath)];
  if (!record) {
    throw new ToolInputError(`Read ${shownPath} with read_file before changing it.`);
  }
  if (Math.abs(record.mtimeMs - stat.mtimeMs) > 1 || record.size !== stat.size) {
    throw new ToolInputError(`${shownPath} changed on disk since you last read it (by the user or a command). Read it again before changing it.`);
  }
}

/** Preview shown in the approval prompt and stored with the tool result. */
export function changePreview(prepared) {
  const diff = diffTexts(prepared.beforeText, prepared.afterText, { context: 3, maxLines: 400 });
  const preview = { path: prepared.shownPath, absolutePath: prepared.absolutePath, created: prepared.created, ...diff };
  return preview;
}

// Changes in progress per file: two sessions or subagents must not both pass the check below and overwrite each other.
const fileWrites = new KeyedQueue();

/**
 * Write a prepared change, record a checkpoint for rewind, and mark the file as read.
 * - Refuses when the file changed between the preview and the write.
 * - Changes to one file run one at a time.
 */
async function commitFileChange(prepared, ctx) {
  await fileWrites.run(pathKey(prepared.absolutePath), () => writeFileChange(prepared, ctx));
}

async function writeFileChange(prepared, ctx) {
  let currentMtime = null;
  try {
    currentMtime = (await fsp.stat(prepared.absolutePath)).mtimeMs;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (currentMtime !== prepared.mtimeMs) {
    throw new ToolInputError(`${prepared.shownPath} changed on disk while waiting for approval. Read it again.`);
  }
  await fsp.mkdir(path.dirname(prepared.absolutePath), { recursive: true });
  await ctx.checkpoint(prepared.absolutePath, prepared.beforeBuffer, prepared.afterBuffer);
  await fsp.writeFile(prepared.absolutePath, prepared.afterBuffer);
  const stat = await fsp.stat(prepared.absolutePath);
  ctx.recordRead(prepared.absolutePath, stat);
}

export const editFileTool = {
  name: 'edit_file',
  kind: 'edit',
  description:
    'Replace exact text in a file. old_string must match the file exactly (copy it from read_file output without the line-number prefix) ' +
    'and must be unique unless replace_all is true. Include enough surrounding lines to make it unique. ' +
    'Read the file first. Prefer this over write_file for changes to existing files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to change.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  prepare: prepareEdit,
  async run(input, ctx, prepared) {
    const change = prepared || (await prepareEdit(input, ctx));
    await commitFileChange(change, ctx);
    const preview = changePreview(change);
    const snippet = changedSnippet(change.afterText, preview);
    const content = `Edited ${change.shownPath}: ${change.replacements} replacement${change.replacements === 1 ? '' : 's'} (+${preview.added} -${preview.removed} lines).${snippet ? `\n${snippet}` : ''}`;
    return { content, meta: preview };
  },
};

export const writeFileTool = {
  name: 'write_file',
  kind: 'edit',
  description:
    'Create a file, or replace the whole content of an existing file (read it first). Creates missing parent folders. ' +
    'For changes to part of an existing file, use edit_file instead.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to write.' },
      content: { type: 'string', description: 'The complete file content.' },
    },
    required: ['path', 'content'],
  },
  prepare: prepareWrite,
  async run(input, ctx, prepared) {
    const change = prepared || (await prepareWrite(input, ctx));
    await commitFileChange(change, ctx);
    const preview = changePreview(change);
    const lineCount = change.afterText ? change.afterText.split(/\r?\n/).length - (change.afterText.endsWith('\n') ? 1 : 0) : 0;
    const content = change.created
      ? `Created ${change.shownPath} (${lineCount} lines).`
      : `Overwrote ${change.shownPath} (${lineCount} lines; +${preview.added} -${preview.removed}).`;
    return { content, meta: preview };
  },
};

export const notebookEditTool = {
  name: 'notebook_edit',
  kind: 'edit',
  description:
    'Change one cell of a Jupyter notebook (.ipynb): replace its source, insert a new cell after it, or delete it. ' +
    'Read the notebook with read_file first; it shows each cell\'s index and id. Replacing a code cell clears its old outputs.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The notebook file.' },
      cell_id: { type: 'string', description: 'The cell\'s id, as read_file shows it.' },
      cell_index: { type: 'integer', description: 'The cell\'s index (0-based), for notebooks without cell ids.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default replace. insert adds a new cell after the given cell, or at the top when none is given.' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'The cell type: required for insert; for replace it changes the type.' },
      new_source: { type: 'string', description: 'The cell\'s new source, for replace and insert.' },
    },
    required: ['path'],
  },
  prepare: prepareNotebookEdit,
  async run(input, ctx, prepared) {
    const change = prepared || (await prepareNotebookEdit(input, ctx));
    await commitFileChange(change, ctx);
    const preview = changePreview(change);
    const content = `${change.summary} in ${change.shownPath}; the notebook now has ${change.cellCount} cells.`;
    return { content, meta: preview };
  },
};

/** Work out a notebook cell change without writing it: the whole file before and after, for the diff and rewind. */
async function prepareNotebookEdit(input, ctx) {
  const absolutePath = resolvePath(ctx.cwd, input.path);
  const shownPath = displayPath(ctx.cwd, absolutePath);
  if (path.extname(absolutePath).toLowerCase() !== '.ipynb') throw new ToolInputError(`${shownPath} is not a Jupyter notebook (.ipynb); use edit_file.`);
  const stat = await statOrThrow(absolutePath, shownPath);
  assertReadAndUnchanged(ctx, absolutePath, shownPath, stat);
  const beforeBuffer = await fsp.readFile(absolutePath);
  const { text, encoding } = decodeText(beforeBuffer);
  let notebook;
  try {
    notebook = JSON.parse(text);
  } catch (error) {
    throw new ToolInputError(`${shownPath} is not a valid notebook (${error.message}).`);
  }
  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
  const mode = input.edit_mode || 'replace';
  const given = Boolean(input.cell_id) || Number.isInteger(input.cell_index);
  const index = input.cell_id ? cells.findIndex((cell) => cell.id === input.cell_id) : Number.isInteger(input.cell_index) ? input.cell_index : -1;
  if (given && (index < 0 || index >= cells.length)) throw new ToolInputError(`${shownPath} has no cell ${input.cell_id ? `with id "${input.cell_id}"` : `at index ${input.cell_index}`}. Read the notebook again to see its cells.`);
  if (mode !== 'insert' && !given) throw new ToolInputError('Give cell_id or cell_index for the cell to change.');
  if (mode !== 'delete' && typeof input.new_source !== 'string') throw new ToolInputError('new_source is required to replace or insert a cell.');
  // Notebook format 4.5 and later gives every cell an id. Older notebooks have none.
  const withIds = cells.some((cell) => cell.id) || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);
  let summary;
  if (mode === 'delete') {
    cells.splice(index, 1);
    summary = `Deleted cell ${index}`;
  } else if (mode === 'insert') {
    if (!['code', 'markdown'].includes(input.cell_type)) throw new ToolInputError('cell_type (code or markdown) is required to insert a cell.');
    const cell = newNotebookCell(input.cell_type, input.new_source, withIds);
    cells.splice(given ? index + 1 : 0, 0, cell);
    summary = `Inserted a ${input.cell_type} cell at index ${given ? index + 1 : 0}${cell.id ? ` (id "${cell.id}")` : ''}`;
  } else {
    const cell = cells[index];
    const type = input.cell_type || cell.cell_type;
    // Rebuild the cell so a type change gets the right fields, and old outputs no longer describe the new code.
    const replaced = { ...newNotebookCell(type, input.new_source, false), ...(cell.id ? { id: cell.id } : {}), metadata: cell.metadata || {} };
    cells[index] = Object.fromEntries(Object.entries(replaced).sort(([a], [b]) => a.localeCompare(b)));
    summary = `Replaced cell ${index}`;
  }
  notebook.cells = cells;
  // Jupyter writes one-space indentation and a final line break. Keep what the file uses.
  const indent = /^\{\r?\n( +)"/.exec(text)?.[1].length ?? 1;
  let afterText = `${JSON.stringify(notebook, null, indent)}${text.endsWith('\n') ? '\n' : ''}`;
  if (usesCrlf(text)) afterText = toCrlf(afterText);
  const afterBuffer = encodeText(afterText, encoding);
  const prepared = { absolutePath, shownPath, beforeBuffer, afterBuffer, beforeText: text, afterText, created: false, mtimeMs: stat.mtimeMs, summary, cellCount: cells.length };
  return prepared;
}

/** A new notebook cell with its fields in Jupyter's (alphabetical) order. */
function newNotebookCell(type, source, withId) {
  const lines = source ? source.split(/(?<=\n)/) : [];
  const id = withId ? crypto.randomBytes(4).toString('hex') : null;
  const cell = type === 'code'
    ? { cell_type: 'code', execution_count: null, ...(id ? { id } : {}), metadata: {}, outputs: [], source: lines }
    : { cell_type: 'markdown', ...(id ? { id } : {}), metadata: {}, source: lines };
  return cell;
}

/** A few numbered lines around the first change, so the model can check its edit. */
function changedSnippet(afterText, preview) {
  const hunk = preview.hunks[0];
  if (!hunk) return '';
  const lines = afterText.split(/\r?\n/);
  const from = Math.max(1, hunk.newStart - 1);
  const to = Math.min(lines.length, hunk.newStart + Math.max(hunk.newLines, 1));
  if (to - from > 40) return '';
  const numbered = [];
  for (let lineNumber = from; lineNumber <= to; lineNumber++) {
    numbered.push(`${lineNumber}\t${clip(lines[lineNumber - 1] ?? '', 300)}`);
  }
  return numbered.join('\n');
}

async function statOrThrow(absolutePath, shownPath) {
  try {
    const stat = await fsp.stat(absolutePath);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') throw new ToolInputError(`${shownPath} does not exist.`);
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new ToolInputError(`No permission to read ${shownPath}.`);
    throw error;
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
