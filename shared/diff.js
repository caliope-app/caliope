// Line diff (Myers) shared by the server and the browser.
// Ops: { type: 'equal' | 'delete' | 'insert', a?: index in old lines, b?: index in new lines }

export function splitLines(text) {
  if (text === null || text === undefined || text === '') return [];
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Diff two arrays of lines.
 * - Trims the common prefix and suffix first, which keeps typical edits fast.
 * - When the middle section needs more than `maxEdits` edits, it is reported as a full replace.
 */
export function diffLines(oldLines, newLines, { maxEdits = 2000 } = {}) {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'equal', a: i, b: i });
  const middleOps = myers(oldLines, newLines, start, oldEnd, start, newEnd, maxEdits);
  for (const op of middleOps) ops.push(op);
  for (let i = 0; i < oldLines.length - oldEnd; i++) ops.push({ type: 'equal', a: oldEnd + i, b: newEnd + i });
  return ops;
}

function myers(oldLines, newLines, oldStart, oldEnd, newStart, newEnd, maxEdits) {
  const n = oldEnd - oldStart;
  const m = newEnd - newStart;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n + m > 200000) return replaceAll(oldStart, n, newStart, m);

  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[offset + 1] = 0;
  // trace[d] holds v (for diagonals -(d+1)..d+1) as it was before step d.
  const trace = [];
  const limit = Math.min(max, maxEdits);

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[oldStart + x] === newLines[newStart + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, oldStart, newStart);
    }
  }
  return replaceAll(oldStart, n, newStart, m);
}

function backtrack(trace, n, m, oldStart, newStart) {
  const reversedOps = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d];
    const read = (k) => snapshot[k + d + 1];
    const k = x - y;
    let previousK;
    if (k === -d || (k !== d && read(k - 1) < read(k + 1))) previousK = k + 1;
    else previousK = k - 1;
    const previousX = read(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversedOps.push({ type: 'equal', a: oldStart + x - 1, b: newStart + y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === previousX) reversedOps.push({ type: 'insert', b: newStart + previousY });
      else reversedOps.push({ type: 'delete', a: oldStart + previousX });
    }
    x = previousX;
    y = previousY;
  }
  reversedOps.reverse();
  return reversedOps;
}

function replaceAll(oldStart, n, newStart, m) {
  const ops = [];
  for (let i = 0; i < n; i++) ops.push({ type: 'delete', a: oldStart + i });
  for (let j = 0; j < m; j++) ops.push({ type: 'insert', b: newStart + j });
  return ops;
}

export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'insert') added++;
    else if (op.type === 'delete') removed++;
  }
  return { added, removed };
}

/**
 * Group diff ops into hunks with `context` unchanged lines around each change.
 * - Each hunk line is { kind: ' ' | '-' | '+', text, oldNo, newNo } with 1-based line numbers.
 */
export function buildHunks(ops, oldLines, newLines, context = 3) {
  const changeIndexes = [];
  ops.forEach((op, index) => {
    if (op.type !== 'equal') changeIndexes.push(index);
  });
  if (changeIndexes.length === 0) return [];

  const ranges = [];
  for (const index of changeIndexes) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  const hunks = [];
  for (const range of ranges) {
    const lines = [];
    let oldNo = null;
    let newNo = null;
    let oldCount = 0;
    let newCount = 0;
    for (let i = range.from; i <= range.to; i++) {
      const op = ops[i];
      if (op.type === 'equal') {
        lines.push({ kind: ' ', text: oldLines[op.a], oldNo: op.a + 1, newNo: op.b + 1 });
        if (oldNo === null) oldNo = op.a + 1;
        if (newNo === null) newNo = op.b + 1;
        oldCount++;
        newCount++;
      } else if (op.type === 'delete') {
        lines.push({ kind: '-', text: oldLines[op.a], oldNo: op.a + 1, newNo: null });
        if (oldNo === null) oldNo = op.a + 1;
        oldCount++;
      } else {
        lines.push({ kind: '+', text: newLines[op.b], oldNo: null, newNo: op.b + 1 });
        if (newNo === null) newNo = op.b + 1;
        newCount++;
      }
    }
    hunks.push({
      oldStart: oldNo ?? firstOldLineAfter(ops, range.from),
      oldLines: oldCount,
      newStart: newNo ?? firstNewLineAfter(ops, range.from),
      newLines: newCount,
      lines,
    });
  }
  return hunks;
}

function firstOldLineAfter(ops, index) {
  for (let i = index; i < ops.length; i++) if (ops[i].a !== undefined) return ops[i].a + 1;
  return 0;
}

function firstNewLineAfter(ops, index) {
  for (let i = index; i < ops.length; i++) if (ops[i].b !== undefined) return ops[i].b + 1;
  return 0;
}

/**
 * Diff two texts into hunks plus line stats.
 * - `maxLines` caps the number of hunk lines kept, so huge rewrites stay cheap to store and render.
 */
export function diffTexts(oldText, newText, { context = 3, maxLines = 600 } = {}) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines, newLines);
  const stats = diffStats(ops);
  const hunks = buildHunks(ops, oldLines, newLines, context);
  let kept = 0;
  let truncated = false;
  const keptHunks = [];
  for (const hunk of hunks) {
    if (kept + hunk.lines.length > maxLines) {
      truncated = true;
      break;
    }
    kept += hunk.lines.length;
    keptHunks.push(hunk);
  }
  return { added: stats.added, removed: stats.removed, hunks: keptHunks, truncated };
}
