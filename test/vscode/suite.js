'use strict';

/** Runs inside the real VS Code Extension Host, not in a stubbed vscode module. */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

async function waitFor(predicate, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('VS Code Git repositories were not initialized before deadline.');
}

async function run() {
  const ext = vscode.extensions.getExtension('local-dev.ai-feature-source-control');
  assert.ok(ext, 'development extension is available');
  await ext.activate();
  assert.equal(ext.isActive, true);
  const apiExt = vscode.extensions.getExtension('vscode.git');
  assert.ok(apiExt);
  const api = (await apiExt.activate()).getAPI(1);
  const expected = [process.env.AIFG_E2E_REPO_ONE, process.env.AIFG_E2E_REPO_TWO].map(path.resolve);
  const found = await waitFor(() => {
    const roots = api.repositories.map(repo => path.resolve(repo.rootUri.fsPath));
    return expected.every(root => roots.includes(root)) ? roots : null;
  });
  assert.equal(expected.filter(root => found.includes(root)).length, 2);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['aiFeatureGroups.refresh', 'aiFeatureGroups.classify',
    'aiFeatureGroups.previewPayload', 'aiFeatureGroups.cancelClassification']) {
    assert.ok(commands.includes(name), `extension command ${name} is registered`);
  }
  await vscode.commands.executeCommand('aiFeatureGroups.refresh');
  for (const root of expected) {
    const repo = api.repositories.find(item => path.resolve(item.rootUri.fsPath) === root);
    assert.ok(repo);
    assert.ok(repo.state.workingTreeChanges.length >= 1, `Git status available for ${root}`);
  }
  // No AI consent is given in this integration test; it must not invoke Codex or Copilot.
  // The native vscode.git provider remains active. No duplicate providers are created.
}

module.exports = { run };
