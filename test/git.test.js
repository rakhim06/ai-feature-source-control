'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  git, parsePorcelain, listChanges, getDiff,
  stage, unstage, commitStaged, shouldExclude
} = require('../src/git');

async function withRepo(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-feature-git-test-'));
  try {
    await git(dir, ['init', '-q']);
    await git(dir, ['config', 'user.name', 'Test Author']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('parses NUL-delimited porcelain, including filenames with spaces and renames', () => {
  const input = ' M src/has spaces.ts\0?? docs/new file.txt\0R  src/new-name.ts\0src/old-name.ts\0';
  const result = parsePorcelain(input);
  const moved = result.find(c => c.path === 'src/new-name.ts');
  assert.equal(moved.originalPath, 'src/old-name.ts');
  assert.equal(moved.staged, true);
  assert.equal(result.find(c => c.path === 'docs/new file.txt').untracked, true);
  assert.equal(result.find(c => c.path === 'src/has spaces.ts').unstaged, true);
});

test('excludes common credentials and user-supplied glob patterns', () => {
  for (const file of ['config/.env.prod', 'secrets.tfvars', 'cert.pem', 'ssl/key.p12',
    '.npmrc', 'deploy/credentials.json', 'keys/id_ed25519', 'private.key']) {
    assert.equal(shouldExclude(file), true, file);
  }
  assert.equal(shouldExclude('src/view.ts'), false);
  assert.equal(shouldExclude('src/view.generated.ts', ['**/*.generated.ts']), true);
  assert.equal(shouldExclude('src/view.ts', ['**/*.generated.ts']), false);
});

test('reads staged and unstaged changes and displays diffs', async () => {
  await withRepo(async root => {
    await fs.writeFile(path.join(root, 'app.js'), 'const x = 1;\n');
    await stage(root, [{ path: 'app.js' }]);
    await git(root, ['commit', '-qm', 'initial']);
    await fs.writeFile(path.join(root, 'app.js'), 'const x = 2;\n');
    await fs.writeFile(path.join(root, 'new file.ts'), 'export const hello = 1;\n');
    const changes = await listChanges(root);
    assert.equal(changes.length, 2);
    assert.equal(changes.find(c => c.path === 'app.js').unstaged, true);
    const changed = await getDiff(root, changes.find(c => c.path === 'app.js'), 3000);
    assert.match(changed.text, /\+const x = 2/);
    const newFile = await getDiff(root, changes.find(c => c.path === 'new file.ts'), 3000);
    assert.match(newFile.text, /export const hello/);
  });
});

test('stage and unstage a newly-added file before first commit', async () => {
  await withRepo(async root => {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    await stage(root, [{ path: 'a.txt' }]);
    let [change] = await listChanges(root);
    assert.equal(change.staged, true);
    await unstage(root, [change]);
    [change] = await listChanges(root);
    assert.equal(change.untracked, true);
  });
});

test('standard commit includes only explicitly staged whole files', async () => {
  await withRepo(async root => {
    for (const filename of ['api.js', 'unrelated.js']) {
      await fs.writeFile(path.join(root, filename), 'original\n');
    }
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-qm', 'initial']);
    await fs.writeFile(path.join(root, 'api.js'), 'feature\n');
    await fs.writeFile(path.join(root, 'unrelated.js'), 'other work\n');
    await stage(root, [{ path: 'api.js' }]);
    await commitStaged(root, 'feat: One feature');
    const names = (await git(root, ['show', '--format=', '--name-only', 'HEAD'])).trim().split('\n');
    assert.deepEqual(names, ['api.js']);
    const [remaining] = await listChanges(root);
    assert.equal(remaining.path, 'unrelated.js');
    assert.equal(remaining.staged, false);
  });
});

test('staged and unstaged versions are distinct, and commit only includes index', async () => {
  const { readHeadVersion, readIndexVersion, commitStaged, currentBranch } = require('../src/git');
  await withRepo(async root => {
    const filename = path.join(root, 'dual.ts');
    await fs.writeFile(filename, 'HEAD\n');
    await git(root, ['add', 'dual.ts']);
    await git(root, ['commit', '-qm', 'initial']);
    await fs.writeFile(filename, 'INDEX\n');
    await git(root, ['add', 'dual.ts']);
    await fs.writeFile(filename, 'WORKTREE\n');
    const [change] = await listChanges(root);
    assert.equal(change.staged, true);
    assert.equal(change.unstaged, true);
    assert.equal(await readHeadVersion(root, 'dual.ts'), 'HEAD\n');
    assert.equal(await readIndexVersion(root, 'dual.ts'), 'INDEX\n');
    assert.match(await currentBranch(root), /main|master/);
    await commitStaged(root, 'feat: Commit index only');
    assert.equal(await readHeadVersion(root, 'dual.ts'), 'INDEX\n');
    assert.equal(await fs.readFile(filename, 'utf8'), 'WORKTREE\n');
    const [remaining] = await listChanges(root);
    assert.equal(remaining.staged, false);
    assert.equal(remaining.unstaged, true);
    await assert.rejects(commitStaged(root, 'feat: Empty index'), /No staged changes/);
  });
});
