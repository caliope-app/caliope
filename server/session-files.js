// What a session changed on disk, and a Markdown export of a session.
import fsp from 'node:fs/promises';
import { diffTexts } from '../shared/diff.js';
import { decodeText } from './tools/text-files.js';
import { looksBinary } from './tools/files.js';
import { displayPath, pathKey } from './tools/paths.js';

/**
 * Files changed by the agent in this session: the state before its first edit against the file now.
 * - Changes made later by the user or by commands show up too, because the comparison is with disk.
 */
export async function sessionChanges(session, store) {
  const byPath = new Map();
  for (const checkpoint of session.data.checkpoints) {
    const key = pathKey(checkpoint.path);
    if (!byPath.has(key)) byPath.set(key, { path: checkpoint.path, before: checkpoint.before });
  }
  const changes = [];
  for (const entry of byPath.values()) {
    let current = null;
    try {
      current = await fsp.readFile(entry.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let before = null;
    if (entry.before) {
      try {
        before = await store.readBlob(session.meta.id, entry.before);
      } catch {
        before = null;
      }
    }
    let status = 'modified';
    if (!before && current) status = 'created';
    else if (before && !current) status = 'deleted';
    else if (!before && !current) continue;
    if (before && current && before.equals(current)) status = 'unchanged';
    const shownPath = displayPath(session.meta.cwd, entry.path);
    if ((before && looksBinary(before)) || (current && looksBinary(current))) {
      changes.push({ path: entry.path, shownPath, status, binary: true, added: 0, removed: 0, hunks: [] });
      continue;
    }
    const diff = diffTexts(before ? decodeText(before).text : '', current ? decodeText(current).text : '', { context: 3, maxLines: 1500 });
    changes.push({ path: entry.path, shownPath, status, binary: false, ...diff });
  }
  changes.sort((a, b) => a.shownPath.localeCompare(b.shownPath));
  return changes;
}

/** The conversation as Markdown: prompts, answers, tool calls (results folded), and events. */
export function sessionToMarkdown(session) {
  const { meta, data } = session;
  const credits = (meta.usage.nanoAiu / 1e9).toFixed(2);
  const lines = [
    `# ${meta.title}`,
    '',
    `- Folder: \`${meta.cwd}\``,
    `- Created: ${meta.createdAt}`,
    `- Model: ${meta.model || 'default'}${meta.effort ? ` (${meta.effort})` : ''}`,
    `- Spent: ${credits} AI credits over ${meta.usage.requests} requests`,
    '',
  ];
  const toolNames = new Map();
  for (const message of data.messages) {
    if (message.role === 'event') {
      lines.push(`*${message.ts.slice(0, 16).replace('T', ' ')} · ${message.text || message.kind}*`, '');
      continue;
    }
    if (message.role === 'user') {
      if (message.kind === 'compact_summary') {
        lines.push('## Conversation summary (compacted)', '', message.summary || '', '');
        continue;
      }
      const visible = message.content.filter((block) => block.type === 'text' && !block.hidden).map((block) => block.text).join('\n\n');
      if (visible) lines.push('## You', '', visible, '');
      for (const block of message.content) {
        if (block.type === 'image') lines.push('*(image attached)*', '');
        if (block.type !== 'tool_result') continue;
        const text = typeof block.content === 'string' ? block.content : block.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const name = toolNames.get(block.tool_use_id) || 'tool';
        lines.push(`<details><summary>${name} result${block.is_error ? ' (error)' : ''}</summary>`, '', '```', text.slice(0, 4000), '```', '', '</details>', '');
      }
      continue;
    }
    lines.push(`## Assistant${message.model ? ` (${message.model})` : ''}`, '');
    for (const block of message.content) {
      if (block.type === 'text') lines.push(block.text, '');
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        lines.push(`**${block.name}** \`${JSON.stringify(block.input).slice(0, 300)}\``, '');
      }
    }
  }
  const markdown = lines.join('\n');
  return markdown;
}
