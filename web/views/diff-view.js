// Renders diff hunks ({ oldStart, newStart, lines: [{ kind, text, oldNo, newNo }] }) as a table.
import { h } from '../lib/dom.js';

export function renderDiff(diff, { emptyText = 'No changes.' } = {}) {
  const container = h('div', { class: 'diff' });
  if (!diff || !diff.hunks || diff.hunks.length === 0) {
    container.append(h('div', { class: 'diff-note' }, emptyText));
    return container;
  }
  const table = h('table');
  for (const hunk of diff.hunks) {
    table.append(h('tr', { class: 'hunk' }, h('td', { colspan: '3' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)));
    for (const line of hunk.lines) {
      const kind = line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'ctx';
      table.append(
        h(
          'tr',
          { class: kind },
          h('td', { class: 'no' }, line.oldNo ?? ''),
          h('td', { class: 'no' }, line.newNo ?? ''),
          h('td', { class: 'code' }, `${line.kind === ' ' ? ' ' : line.kind} ${line.text}`),
        ),
      );
    }
  }
  container.append(table);
  if (diff.truncated) container.append(h('div', { class: 'diff-note' }, 'The diff is too long to show completely.'));
  return container;
}

export function diffStat(added, removed) {
  return h('span', { class: 'diffstat' }, h('span', { class: 'add' }, `+${added}`), ' ', h('span', { class: 'del' }, `−${removed}`));
}
