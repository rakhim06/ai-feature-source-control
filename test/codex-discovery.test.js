'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { bundledRelativePath, fromIdeExtension, resolveCodexExecutable } = require('../src/codex-discovery');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aifg-codex-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'cli');
  const ide = path.join(root, 'ide');
  await fs.mkdir(cli, { recursive: true });
  await fs.mkdir(ide, { recursive: true });
  const bundled = path.join(ide, bundledRelativePath());
  await fs.mkdir(path.dirname(bundled), { recursive: true });
  return { root, cli, ide, bundled };
}

async function executable(file) {
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
  await fs.chmod(file, 0o755);
}

test('detects current platform and architecture without guessing binaries for other OSes', () => {
  assert.equal(bundledRelativePath('darwin', 'arm64'), path.join('bin', 'macos-aarch64', 'codex'));
  assert.equal(bundledRelativePath('darwin', 'x64'), path.join('bin', 'macos-x86_64', 'codex'));
  assert.equal(bundledRelativePath('linux', 'x64'), path.join('bin', 'linux-x86_64', 'codex'));
  assert.equal(bundledRelativePath('win32', 'x64'), path.join('bin', 'windows-x86_64', 'codex.exe'));
  assert.equal(bundledRelativePath('freebsd', 'arm64'), undefined);
});

test('uses official IDE extension bundled Codex when CLI is absent from PATH', async t => {
  const { ide, bundled } = await fixture(t);
  await executable(bundled);
  const result = await resolveCodexExecutable({ configured: 'auto', extension: { extensionPath: ide }, env: { PATH: '' } });
  assert.deepEqual(result, { executable: bundled, source: 'ide-extension' });
});

test('recognizes the previous default setting codex as automatic', async t => {
  const { ide, bundled } = await fixture(t);
  await executable(bundled);
  const result = await resolveCodexExecutable({ configured: 'codex', extension: { extensionPath: ide }, env: { PATH: '' } });
  assert.equal(result.executable, bundled);
});

test('prioritizes CLI in PATH over the bundled IDE binary', async t => {
  const { cli, ide, bundled } = await fixture(t);
  await executable(bundled);
  const binary = path.join(cli, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await executable(binary);
  const result = await resolveCodexExecutable({ configured: 'auto', extension: { extensionPath: ide }, env: { PATH: cli } });
  assert.deepEqual(result, { executable: binary, source: 'path' });
});

test('explicit executable setting overrides PATH and the official extension', async t => {
  const { root, cli, ide, bundled } = await fixture(t);
  const pathBinary = path.join(cli, 'codex');
  const explicit = path.join(root, 'custom-codex');
  await executable(bundled);
  await executable(pathBinary);
  await executable(explicit);
  const result = await resolveCodexExecutable({ configured: explicit, extension: { extensionPath: ide }, env: { PATH: cli } });
  assert.deepEqual(result, { executable: explicit, source: 'configured' });
});

test('a broken explicit path fails rather than silently switching AI clients', async t => {
  const { root, ide, bundled } = await fixture(t);
  await executable(bundled);
  await assert.rejects(resolveCodexExecutable({ configured: path.join(root, 'missing'), extension: { extensionPath: ide }, env: { PATH: '' } }), /Configured Codex executable/);
});

test('skips non-executable or directory candidates inside Codex IDE extension', async t => {
  const { ide, bundled } = await fixture(t);
  await fs.writeFile(bundled, '#!/bin/sh\n');
  await fs.chmod(bundled, 0o644);
  assert.equal(await fromIdeExtension({ extension: { extensionPath: ide } }), undefined);
});

test('does not search arbitrary folders and gives a helpful error when neither client exists', async () => {
  await assert.rejects(resolveCodexExecutable({ configured: 'auto', env: { PATH: '' } }), /Install Codex CLI or the official OpenAI Codex VS Code extension/);
});
