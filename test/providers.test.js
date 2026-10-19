'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('Codex CLI adapter requests the correct schema for commit messages and classifications', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aifg-provider-test-'));
  const executable = path.join(tmp, 'fake-codex');
  const originalLoad = Module._load;
  try {
    await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('fs');
const args=process.argv.slice(2);
fs.writeFileSync(require('path').join(__dirname,'args.json'),JSON.stringify(args));
const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
const output=args[args.indexOf('--output-last-message')+1];
let input=''; process.stdin.on('data',d => input += d);
process.stdin.on('end',()=>fs.writeFileSync(output,JSON.stringify(schema.properties.message
  ? {message:'fix: Correct staged logic'}
  : {assignments:[{path:'foo.js',group:'fix: Correct staged logic'}]})));
`);
    await fs.chmod(executable, 0o755);
    const fakeVscode = { workspace: { getConfiguration: () => ({ get: (key, fallback) => ({ codexExecutablePath: executable, codexModel: 'gpt-6-luna', codexReasoningEffort: 'low' })[key] ?? fallback }) } };
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return fakeVscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/providers')];
    const { CodexCliProvider } = require('../src/providers');
    const provider = new CodexCliProvider();
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const commit = await provider.generateCommitMessage('Write a Git commit message', token);
    assert.deepEqual(JSON.parse(commit), { message: 'fix: Correct staged logic' });
    const args = JSON.parse(await fs.readFile(path.join(tmp, 'args.json'), 'utf8'));
    assert.deepEqual(args.slice(0, 2), ['exec', '-C']);
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-6-luna']);
    assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort="low"']);
    const classification = await provider.classify('Classify changes', token);
    assert.equal(JSON.parse(classification).assignments[0].path, 'foo.js');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/providers')];
    await fs.rm(tmp, { recursive: true, force: true });
  }
});


test('Codex CLI uses validated model and reasoning effort settings', () => {
  // Values are separate arguments to spawn, not shell-interpolated.
  const originalLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return {};
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/providers')];
    const { codexModelArguments } = require('../src/providers');
    assert.deepEqual(codexModelArguments({ model: 'gpt-6-luna', reasoningEffort: 'low' }),
      ['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"']);
    assert.deepEqual(codexModelArguments({ model: '', reasoningEffort: 'default' }), []);
    assert.throws(() => codexModelArguments({ model: '--bad', reasoningEffort: 'low' }), /Invalid Codex model ID/);
    assert.throws(() => codexModelArguments({ model: 'gpt-6-luna', reasoningEffort: ';bad' }), /Invalid aiFeatureGroups/);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/providers')];
  }
});

test('Copilot provider uses an exact configured Language Model API ID', async () => {
  const originalLoad = Module._load;
  const requests = [];
  const available = [{ id: 'fast-model', name: 'Fast' }, { id: 'deep-model', name: 'Deep' }];
  const fake = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'copilotModelId' ? 'deep-model' : fallback }) },
    lm: { selectChatModels: async selector => { requests.push(selector); return available; } },
    window: { showQuickPick: async () => { throw new Error('Model picker should not appear'); } }
  };
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return fake;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/providers')];
    const { CopilotProvider } = require('../src/providers');
    const provider = new CopilotProvider();
    await provider.authorize();
    assert.equal(provider.model.id, 'deep-model');
    assert.deepEqual(requests, [{ vendor: 'copilot' }]);
    fake.workspace.getConfiguration = () => ({ get: () => 'removed-model' });
    await assert.rejects(() => new CopilotProvider().authorize(), /unavailable.*Available IDs/);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/providers')];
  }
});

test('Codex errors classify failure without exposing stdin/diff echoed to stderr', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aifg-provider-safe-error-'));
  const executable = path.join(tmp, 'fake-codex');
  const originalLoad = Module._load;
  try {
    await fs.writeFile(executable, `#!/usr/bin/env node
let prompt=''; process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
  process.stderr.write('Full prompt: ' + prompt + '\\nError: model not found\\n');
  process.exitCode = 1;
});
`);
    await fs.chmod(executable, 0o755);
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: (key, fallback) => ({
        codexExecutablePath: executable, codexModel: 'unavailable', codexReasoningEffort: 'low'
      })[key] ?? fallback }) } };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/providers')];
    const { CodexCliProvider } = require('../src/providers');
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    await assert.rejects(
      new CodexCliProvider().classify('SENSITIVE_DIFF_PYTHON_PAYLOAD_NEVER_SHOW', token),
      error => {
        assert.match(error.message, /model unavailable/);
        assert.doesNotMatch(error.message, /SENSITIVE_DIFF_PYTHON_PAYLOAD_NEVER_SHOW/);
        assert.doesNotMatch(error.message, /Full prompt/);
        return true;
      }
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/providers')];
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Copilot exceptions are converted to safe error categories', async () => {
  const originalLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return { LanguageModelChatMessage: { User: value => value } };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/providers')];
    const { CopilotProvider } = require('../src/providers');
    const provider = new CopilotProvider();
    provider.model = { sendRequest: async () => { throw new Error('429 SENSITIVE_DIFF_SHOULD_NOT_BE_INCLUDED'); } };
    const token = { isCancellationRequested: false };
    await assert.rejects(provider.request('test', token), error => {
      assert.match(error.message, /rate or usage limit/);
      assert.doesNotMatch(error.message, /SENSITIVE_DIFF/);
      return true;
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/providers')];
  }
});
