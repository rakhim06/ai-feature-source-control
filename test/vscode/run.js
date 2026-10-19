'use strict';

/** Optional real VS Code extension-host integration test (requires network to download VS Code). */
const { runTests } = require('@vscode/test-electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}
function fixture(root, name) {
  const folder = path.join(root, name);
  require('node:fs').mkdirSync(folder);
  git(folder, 'init', '-q');
  git(folder, 'config', 'user.name', 'Extension E2E');
  git(folder, 'config', 'user.email', 'e2e@example.invalid');
  writeFileSync(path.join(folder, 'hello.txt'), 'initial\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'chore: initial');
  writeFileSync(path.join(folder, 'hello.txt'), `modified by ${name}\n`);
  return folder;
}

(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aifg-vscode-e2e-'));
  try {
    const alpha = fixture(root, 'frontend');
    const beta = fixture(root, 'backend');
    const workspace = path.join(root, 'aifg.code-workspace');
    writeFileSync(workspace, JSON.stringify({
      folders: [{ path: alpha }, { path: beta }],
      settings: { 'git.autofetch': false, 'aiFeatureGroups.autoClassify': false }
    }));
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, '--skip-welcome', '--disable-workspace-trust'],
      extensionTestsEnv: { AIFG_E2E_REPO_ONE: alpha, AIFG_E2E_REPO_TWO: beta }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`VS Code integration test failed: ${error.message}\n`);
  process.exitCode = 1;
});
