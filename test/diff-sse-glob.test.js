import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffTexts, splitLines, buildHunks } from '../shared/diff.js';
import { createSseParser } from '../server/sse-parser.js';
import { createGlobMatcher, globToRegExp } from '../server/tools/glob.js';

function applyOps(oldLines, newLines, ops) {
  const result = [];
  for (const op of ops) {
    if (op.type === 'equal') {
      assert.equal(oldLines[op.a], newLines[op.b]);
      result.push(oldLines[op.a]);
    } else if (op.type === 'insert') result.push(newLines[op.b]);
  }
  return result;
}

test('diffLines reconstructs the new text for random edits', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round++) {
    const oldLines = Array.from({ length: Math.floor(random() * 30) }, () => `line ${Math.floor(random() * 8)}`);
    const newLines = oldLines.filter(() => random() > 0.2).flatMap((line) => (random() > 0.85 ? [line, `added ${Math.floor(random() * 5)}`] : [line]));
    const ops = diffLines(oldLines, newLines);
    assert.deepEqual(applyOps(oldLines, newLines, ops), newLines);
    const deleted = ops.filter((op) => op.type === 'delete').length;
    const equal = ops.filter((op) => op.type === 'equal').length;
    assert.equal(deleted + equal, oldLines.length);
  }
});

test('diffTexts reports stats and hunks with line numbers', () => {
  const diff = diffTexts('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);
  const kinds = diff.hunks[0].lines.map((line) => `${line.kind}${line.text}`);
  assert.deepEqual(kinds, [' a', '-b', '+B', ' c', ' d', '+e']);
  const { oldStart, oldLines, newStart, newLines } = diff.hunks[0];
  assert.deepEqual([oldStart, oldLines, newStart, newLines], [1, 4, 1, 5]);
});

test('splitLines handles CRLF and the trailing newline', () => {
  assert.deepEqual(splitLines('x\r\ny\r\n'), ['x', 'y']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('only'), ['only']);
});

test('buildHunks merges nearby changes and keeps far ones apart', () => {
  const oldLines = Array.from({ length: 40 }, (_, i) => `l${i}`);
  const newLines = [...oldLines];
  newLines[2] = 'changed';
  newLines[35] = 'changed too';
  const hunks = buildHunks(diffLines(oldLines, newLines), oldLines, newLines, 3);
  assert.equal(hunks.length, 2);
});

test('SSE parser handles events split at every position and all line endings', () => {
  const stream = 'event: a\ndata: {"x":1}\n\n: comment\r\ndata: line1\r\ndata: line2\r\n\r\nevent: b\rdata: [DONE]\r\r';
  for (let cut = 0; cut <= stream.length; cut++) {
    const events = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push(stream.slice(0, cut));
    parser.push(stream.slice(cut));
    parser.end();
    assert.deepEqual(events, [
      { event: 'a', data: '{"x":1}' },
      { event: 'message', data: 'line1\nline2' },
      { event: 'b', data: '[DONE]' },
    ]);
  }
});

test('glob patterns', () => {
  assert.ok(createGlobMatcher('*.js')('src/deep/app.js'));
  assert.ok(createGlobMatcher('src/**/*.ts')('src/a/b/c.ts'));
  assert.ok(createGlobMatcher('src/**/*.ts')('src/c.ts'));
  assert.ok(!createGlobMatcher('src/*.ts')('src/a/c.ts'));
  assert.ok(createGlobMatcher('*.{js,ts}')('x.ts'));
  assert.ok(createGlobMatcher('test_?.py')('test_1.py'));
  assert.ok(!createGlobMatcher('[!a]*.md')('a.md'));
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});
