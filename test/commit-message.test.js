'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { git, listChanges, getStagedDiff } = require('../src/git');
const { stagedContext, makeCommitPrompt, parseCommitMessage } = require('../src/commit-message');

test('commit messages require strict JSON and validated nonempty text', () => {
  assert.equal(parseCommitMessage('{"message":"fix: Correct package navigation"}'), 'fix: Correct package navigation');
  assert.equal(parseCommitMessage('```json\n{"message":"feat: Add export\n\nWith tests"}\n```'.replace('export\n\n', 'export\\n\\n')),
    'feat: Add export\n\nWith tests');
  assert.throws(() => parseCommitMessage('I changed code'), /JSON/);
  assert.throws(() => parseCommitMessage('{"message":""}'), /invalid/);
  assert.throws(() => parseCommitMessage('{"message":"'+'a'.repeat(5001)+'"}'), /overly long/);
});

test('commit context contains only staged snapshot, not later working-tree changes or excluded credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aifg-message-test-'));
  try {
    await git(root, ['init', '-q']);
    await git(root, ['config','user.name','Test']);
    await git(root, ['config','user.email','test@example.com']);
    await fs.writeFile(path.join(root, 'app.js'), 'const state = 1;\n');
    await fs.writeFile(path.join(root, 'other.js'), 'NOT_STAGED_DO_NOT_SEND\n');
    await fs.writeFile(path.join(root, '.env.local'), 'PASSWORD_DO_NOT_SEND\n');
    await git(root, ['add', '--', 'app.js', '.env.local']);
    await fs.writeFile(path.join(root, 'app.js'), 'SECRET_WORKING_TREE_DO_NOT_SEND\n');
    const changes = await listChanges(root);
    const data = await stagedContext(root, changes, [], 1600);
    assert.equal(data.stagedCount, 2);
    assert.equal(data.files.length, 1);
    const prompt = makeCommitPrompt(data);
    assert.match(prompt, /app\.js/);
    assert.doesNotMatch(prompt, /PASSWORD_DO_NOT_SEND/);
    assert.doesNotMatch(prompt, /SECRET_WORKING_TREE_DO_NOT_SEND/);
    assert.doesNotMatch(prompt, /NOT_STAGED_DO_NOT_SEND/);
    const diff = await getStagedDiff(root, changes.find(c => c.path === 'app.js'), 1600);
    assert.match(diff.text, /const state = 1/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
