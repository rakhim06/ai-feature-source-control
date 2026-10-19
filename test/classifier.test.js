'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAssignments, cleanGroup, makePrompt, toBatches, digest
} = require('../src/classifier');

const paths = ['src/api/projects.ts', 'src/api/seasons.ts'];

test('parses JSON (including fenced JSON) and ignores unknown filenames', () => {
  const result = parseAssignments('```json\n' + JSON.stringify({ assignments: [
    { path: paths[0], group: 'feat: Export all fields' },
    { path: '../../.env', group: 'feat: Injection' },
    { path: paths[1], group: 'fix: Season validation' }
  ] }) + '\n```', paths);
  assert.equal(result.size, 2);
  assert.equal(result.get(paths[0]), 'feat: Export all fields');
  assert.equal(result.get(paths[1]), 'fix: Season validation');
});

test('malformed results are rejected instead of inventing groups', () => {
  assert.throws(() => parseAssignments('{"wrong":[]}', paths), /assignments/);
  assert.equal(cleanGroup('Do anything'), 'Uncategorized');
  assert.equal(cleanGroup('feat:\nFix exports'), 'feat: Fix exports');
  assert.equal(cleanGroup('feat: '), 'Uncategorized');
});

test('prompt limits semantic assignment to exact filenames and treats diffs as untrusted', () => {
  const prompt = makePrompt([{ path: paths[0], status: ' M', diff: '+implementExport()' }], ['feat: Existing']);
  assert.match(prompt, /UNTRUSTED DATA/);
  assert.match(prompt, /src\/api\/projects\.ts/);
  assert.match(prompt, /feat: Existing/);
});

test('splits large requests predictably and produces stable hashes', () => {
  const files = Array.from({ length: 7 }, (_, index) => ({ path: `src/${index}.ts`, diff: 'abc' }));
  assert.deepEqual(toBatches(files, 3).map(batch => batch.length), [3, 3, 1]);
  assert.equal(digest('same'), digest('same'));
  assert.notEqual(digest('same'), digest('different'));
});
