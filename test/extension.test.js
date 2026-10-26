'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { git, listChanges } = require('../src/git');

const noop = () => ({ dispose() {} });

function mockVSCode(roots) {
  const handlers = new Map();
  const prompts = [];
  const providers = new Map();
  const diffCommands = [];
  const views = [];
  const syncCalls = [];
  const quickPicks = [];
  const errors = [];
  const warnings = [];
  const infos = [];
  const previews = [];
  const pullFailures = new Set();
  const checkouts = [];
  const trashed = [];
  let confirmDiscard = true;
  let onDiscardPrompt = null;
  const settings = { provider: 'copilot', autoClassify: false,
    maxDiffCharsPerFile: 3200, maxFilesPerBatch: 25, excludedFilePatterns: [] };
  let scmRegistrations = 0;
  class EventEmitter {
    constructor() { this.listeners = []; this.event = listener => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(fn => fn !== listener); } };
    }; }
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners = []; }
  }
  const repositories = roots.map((root, index) => ({
    rootUri: { scheme: 'file', fsPath: root },
    inputBox: { value: '' },
    ui: { selected: index === 0, onDidChange: noop },
    state: { HEAD: { name: 'test-branch', upstream: { remote: 'origin', name: 'test-branch' }, ahead: 2, behind: 1 },
      remotes: [{ name: 'origin', fetchUrl: 'file:///tmp/mock-remote', pushUrl: 'file:///tmp/mock-remote', isReadOnly: false }], onDidChange: noop },
    async fetch() { syncCalls.push({ root, op: 'fetch' }); this.state.HEAD.behind = 3; },
    async pull() { syncCalls.push({ root, op: 'pull' }); if (pullFailures.has(root)) throw new Error('pull rejected'); this.state.HEAD.behind = 0; },
    async push(...args) {
      syncCalls.push({ root, op: 'push', args });
      if (args[2] === true) this.state.HEAD.upstream = { remote: args[0], name: args[1] };
      this.state.HEAD.ahead = 0;
    },
    async status() { syncCalls.push({ root, op: 'status' }); },
    async getBranches(query) {
      assert.equal(query.remote, false);
      const output = await git(root, ['branch', '--format=%(refname:short)']);
      return output.trim().split('\n').filter(Boolean).map(name => ({ name }));
    },
    async checkout(name) {
      await git(root, ['checkout', name]);
      checkouts.push({ root, name });
      this.state.HEAD.name = name;
    },
    commit: async (message, options) => {
      assert.deepEqual(options, { all: false, amend: false });
      await git(root, ['commit', '-m', message]);
      repositories[index].inputBox.value = '';
      repositories[index].state.HEAD.commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
      if (repositories[index].state.HEAD.upstream) repositories[index].state.HEAD.ahead++; 
    }
  }));
  const api = { repositories, onDidOpenRepository: noop, onDidCloseRepository: noop };
  const vscode = {
    EventEmitter,
    ConfigurationTarget: { Global: 1 },
    Uri: {
      file(filename) { return { scheme: 'file', fsPath: filename, path: filename }; },
      from(record) { return record; },
      joinPath(base, ...segments) { return { fsPath: path.join(base.fsPath, ...segments),
        toString() { return `file://${this.fsPath}`; } }; }
    },
    CancellationTokenSource: class {
      constructor() {
        this.listeners = new Set();
        this.token = { isCancellationRequested: false, onCancellationRequested: cb => {
          this.listeners.add(cb);
          return { dispose: () => this.listeners.delete(cb) };
        } };
      }
      cancel() {
        if (this.token.isCancellationRequested) return;
        this.token.isCancellationRequested = true;
        for (const listener of this.listeners) listener();
      }
      dispose() { this.listeners.clear(); }
    },
    LanguageModelChatMessage: { User: input => input },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => api }) }) },
    lm: { async selectChatModels() {
      return [{ id: 'test-copilot', name: 'Test Copilot', maxInputTokens: 16000,
        async sendRequest(messages) {
          prompts.push(messages[0]);
          if (messages[0].includes('Write a Git commit message')) {
            return { text: (async function* () {
              yield JSON.stringify({ message: 'feat: Add the selected changes' });
            })() };
          }
          return { text: (async function* () {
            yield JSON.stringify({ assignments: [
              { path: 'api.js', group: 'feat: Export all fields', component: 'Export API', task: 'List exports' },
              { path: 'api.test.js', group: 'feat: Export all fields', component: 'Export API', task: 'Test export endpoint' },
              { path: 'other.js', group: 'fix: Another feature', component: 'Validation', task: 'Fix incorrect handling' },
              { path: 'second.js', group: 'chore: Other repo', component: 'Setup', task: 'Update settings' }
            ] });
          })() };
        } }];
    } },
    workspace: {
      textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback,
        async update(key, value) { settings[key] = value; } }),
      onDidChangeConfiguration: noop,
      fs: {
        stat: uri => fs.stat(uri.fsPath),
        async delete(uri, options) {
          assert.equal(options.useTrash, true, 'Untracked files must be sent to Trash');
          assert.equal(options.recursive, false);
          trashed.push({ path: uri.fsPath, contents: await fs.readFile(uri.fsPath, 'utf8') });
          await fs.unlink(uri.fsPath);
        }
      },
      async openTextDocument(options) { previews.push(options); return options; },
      registerTextDocumentContentProvider(scheme, provider) {
        providers.set(scheme, provider); return noop();
      }
    },
    scm: { createSourceControl() { scmRegistrations++; throw new Error('Duplicate SCM provider'); } },
    window: {
      createOutputChannel() { return { appendLine() {}, dispose() {} }; },
      registerWebviewViewProvider(id, provider, options) {
        const webview = {
          cspSource: 'vscode-webview://test',
          messages: [],
          asWebviewUri(uri) { return uri; },
          postMessage(message) { this.messages.push(message); return Promise.resolve(true); },
          onDidReceiveMessage(handler) { this.handler = handler; return noop(); }
        };
        const wrapper = { id, provider, options, webview, gui: { webview, onDidDispose: noop } };
        views.push(wrapper);
        return { dispose() { const index = views.indexOf(wrapper); if (index !== -1) views.splice(index, 1); } };
      },
      async showWarningMessage(message, options, button) {
        warnings.push(message);
        if (message.startsWith('Revert ')) {
          assert.equal(options.modal, true);
          if (onDiscardPrompt) await onDiscardPrompt();
          return confirmDiscard ? button : undefined;
        }
        return button;
      },
      async showErrorMessage(message) { errors.push(message); },
      async showInformationMessage(message) { infos.push(message); },
      async showTextDocument(doc) { previews.push({ opened: doc }); },
      async showQuickPick(items, options) { quickPicks.push(items); return options?.title?.startsWith('Switch branch:') ? items.at(-1) : items[0]; },
      async showInputBox(options) { return options.value || 'feat: Test'; }
    },
    commands: {
      registerCommand(name, handler) { handlers.set(name, handler); return noop(); },
      async executeCommand(name, ...args) { diffCommands.push({ name, args }); }
    }
  };
  return { vscode, handlers, prompts, settings, views, providers, repositories, diffCommands, syncCalls, quickPicks, errors, warnings, pullFailures, checkouts, trashed,
    setDiscardConfirmation(value) { confirmDiscard = value; },
    setDiscardPromptHook(value) { onDiscardPrompt = value; },
    previews, infos, get scmRegistrations() { return scmRegistrations; } };
}

async function prepareRepo(root, files, commit = false) {
  await fs.mkdir(root, { recursive: true });
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Test Author']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  for (const [name, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
  }
  if (commit) {
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'initial']);
  }
}

async function withFakeExtension(fn, { extraDirty = false, extraClean = false } = {}) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aifg-v05-'));
  const root = path.join(sandbox, 'frontend');
  const extra = path.join(sandbox, 'backend');
  const clean = path.join(sandbox, 'clean-repo');
  const originalLoad = Module._load;
  let context;
  try {
    await prepareRepo(root, {
      'api.js': 'export function list() { return []; }\n',
      'api.test.js': 'test("list", () => {});\n',
      'other.js': 'const fix = 1;\n',
      '.env.local': 'SENSITIVE_VALUE_DO_NOT_SEND=abc\n'
    });
    const roots = [root];
    if (extraDirty) {
      await prepareRepo(extra, { 'second.js': 'export const second = true;\n' });
      roots.push(extra);
    }
    if (extraClean) {
      await prepareRepo(clean, { 'README.md': 'committed\n' }, true);
      roots.push(clean);
    }
    const fake = mockVSCode(roots);
    for (const native of fake.repositories) {
      try { native.state.HEAD.commit = (await git(native.rootUri.fsPath, ['rev-parse', 'HEAD'])).trim(); }
      catch { /* Unborn branch (no commits). */ }
    }
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return fake.vscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const name of ['extension', 'controller', 'feature-view', 'view-model', 'providers']) {
      delete require.cache[require.resolve(`../src/${name}`)];
    }
    const { activate } = require('../src/extension');
    const state = new Map();
    context = {
      subscriptions: [],
      extensionUri: { fsPath: path.resolve(__dirname, '..') },
      workspaceState: {
        get: (key, fallback) => state.get(key) ?? fallback,
        update: async (key, value) => { state.set(key, value); }
      }
    };
    await activate(context);
    assert.equal(fake.views.length, 1);
    const view = fake.views[0];
    view.provider.resolveWebviewView(view.gui);
    await fake.handlers.get('aiFeatureGroups.classify')();
    await fn({ root, extra, clean, fake, view, state, get model() { return view.webview.messages.at(-1)?.model; } });
  } finally {
    for (const item of [...(context?.subscriptions || [])].reverse()) item.dispose();
    Module._load = originalLoad;
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

function repository(view, root) {
  const repos = view.webview.messages.at(-1).model.repositories;
  return repos.find(item => item.root === (root || repos[0]?.root));
}
function section(view, phase, root) {
  return repository(view, root).sections.find(section => section.phase === phase);
}
function getGroup(view, phase, name, root) {
  return section(view, phase, root).groups.find(group => group.name === name);
}
const node = (root, phase, kind, extra = {}) => ({ root, phase, kind, ...extra });

test('blue button state: Commit, then Publish Branch, Push or Sync Changes', async () => {
  const { primaryActionFor } = require('../src/view-model');
  const base = { staged: 0, upstream: null, ahead: null, behind: null, branch: 'SE-2385', hasCommit: true };
  assert.equal(primaryActionFor({ ...base, staged: 2 }), 'commit');
  assert.equal(primaryActionFor(base), 'publish');
  assert.equal(primaryActionFor({ ...base, hasCommit: false }), 'commit');
  assert.equal(primaryActionFor({ ...base, upstream: 'origin/SE-2385', ahead: 1, behind: 0 }), 'push');
  assert.equal(primaryActionFor({ ...base, upstream: 'origin/SE-2385', ahead: 1, behind: 2 }), 'sync');
  assert.equal(primaryActionFor({ ...base, upstream: 'origin/SE-2385', ahead: 0, behind: 0 }), 'commit');
});

test('after local commit, Publish Branch pushes and sets upstream (without affecting other repositories)', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    const frontend = fake.repositories[0];
    frontend.state.HEAD.upstream = undefined;
    frontend.state.HEAD.ahead = undefined;
    frontend.state.HEAD.behind = undefined;
    await view.provider.receive({ type: 'action', root, action: 'stage', node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(repository(view, root).primaryAction, 'commit');
    await view.provider.receive({ type: 'commit', root, message: 'feat: Export all fields' });
    assert.equal(repository(view, root).primaryAction, 'publish');
    assert.equal(repository(view, extra).root, extra);
    await view.provider.receive({ type: 'publish', root });
    assert.deepEqual(fake.syncCalls.filter(item => item.op === 'push'), [
      { root, op: 'push', args: ['origin', 'test-branch', true] }
    ]);
    assert.equal(frontend.state.HEAD.upstream.remote, 'origin');
    assert.equal(repository(view, root).upstream, 'origin/test-branch');
    assert.equal(fake.syncCalls.some(call => call.root === extra), false);
  }, { extraDirty: true });
});

test('after a commit with upstream, Push uses the actual tracked remote and remote branch', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    fake.repositories[0].state.HEAD.upstream = { remote: 'origin', name: 'different-remote-branch' };
    fake.repositories[0].state.HEAD.behind = 0;
    await view.provider.receive({ type: 'action', root, action: 'stage', node: node(root, 'work', 'file', { path: 'api.js' }) });
    await view.provider.receive({ type: 'commit', root, message: 'feat: Test' });
    assert.equal(repository(view, root).primaryAction, 'push');
    await view.provider.receive({ type: 'push', root });
    assert.equal(fake.syncCalls.filter(item => item.op === 'push').length, 1);
    assert.deepEqual(fake.syncCalls.find(item => item.op === 'push').args,
      ['origin', 'HEAD:refs/heads/different-remote-branch']);
  });
});

test('Publish Branch pushes to a real local bare remote with tracking upstream', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aifg-remote-'));
    try {
      await git(remoteRoot, ['init', '--bare', '-q']);
      await git(root, ['branch', '-M', 'test-branch']);
      await git(root, ['remote', 'add', 'origin', remoteRoot]);
      const native = fake.repositories[0];
      native.state.HEAD.upstream = undefined;
      native.state.HEAD.ahead = undefined;
      native.state.HEAD.behind = undefined;
      native.state.remotes = [{ name: 'origin', fetchUrl: remoteRoot, pushUrl: remoteRoot, isReadOnly: false }];
      native.push = async (remote, refspec, upstream) => {
        fake.syncCalls.push({ root, op: 'push', args: [remote, refspec, upstream] });
        await git(root, ['push', ...(upstream ? ['-u'] : []), remote, refspec]);
        native.state.HEAD.upstream = { remote, name: refspec };
      };
      await view.provider.receive({ type: 'action', root, action: 'stage', node: node(root, 'work', 'file', { path: 'api.js' }) });
      await view.provider.receive({ type: 'commit', root, message: 'feat: First commit' });
      assert.equal(repository(view, root).primaryAction, 'publish');
      await view.provider.receive({ type: 'publish', root });
      assert.equal((await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim(), 'origin/test-branch');
      assert.equal((await git(remoteRoot, ['rev-parse', 'refs/heads/test-branch'])).trim(),
        (await git(root, ['rev-parse', 'HEAD'])).trim());
      assert.equal(repository(view, root).upstream, 'origin/test-branch');
    } finally {
      await fs.rm(remoteRoot, { recursive: true, force: true });
    }
  });
});

test('Publish Branch requires local commit and a writable remote; selects between multiple remotes', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const native = fake.repositories[0];
    native.state.HEAD.upstream = undefined;
    // Cannot push an unborn branch even if the button is triggered externally.
    await view.provider.receive({ type: 'publish', root });
    assert.equal(fake.syncCalls.filter(item => item.op === 'push').length, 0);
    native.state.HEAD.commit = 'abcdef';
    native.state.remotes = [];
    await view.provider.receive({ type: 'publish', root });
    assert.equal(fake.syncCalls.filter(item => item.op === 'push').length, 0);
    assert.match(fake.warnings.at(-1), /No writable remote/);
    native.state.remotes = [
      { name: 'fork', isReadOnly: false },
      { name: 'origin', isReadOnly: false }
    ];
    await view.provider.receive({ type: 'publish', root });
    assert.equal(fake.quickPicks.length, 1);
    assert.equal(fake.syncCalls.filter(item => item.op === 'push').length, 1);
    assert.deepEqual(fake.syncCalls.filter(item => item.op === 'push')[0].args,
      ['fork', 'test-branch', true]);
  });
});

test('failed pull never pushes or affects other repositories', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    fake.pullFailures.add(root);
    await view.provider.receive({ type: 'sync', root });
    assert.deepEqual(fake.syncCalls.filter(item => item.root === root).map(item => item.op), ['pull']);
    assert.equal(fake.syncCalls.some(item => item.root === extra), false);
    assert.match(fake.errors.at(-1), /pull rejected/);
  }, { extraDirty: true });
});

test('one Webview with real Git input and zero duplicate SCM providers', async () => {
  await withFakeExtension(async ({ fake, view, root }) => {
    assert.equal(fake.scmRegistrations, 0);
    assert.equal(view.id, 'aiFeatureGroups.view');
    assert.equal(view.options.webviewOptions.retainContextWhenHidden, true);
    assert.match(view.webview.html, /Content-Security-Policy/);
    assert.match(view.webview.html, /id="repositories"/);
    assert.doesNotMatch(view.webview.html, /<select/);
    assert.match(view.webview.html, /webview\.js/);
    assert.equal(view.webview.options.enableScripts, true);
    const model = view.webview.messages.at(-1).model;
    assert.equal(model.repositories[0].root, root);
    assert.equal(model.repositories[0].branch, 'test-branch');
    assert.equal(model.repositories[0].sections[0].label, 'Staged Changes');
    assert.equal(model.repositories[0].sections[1].label, 'Changes');
    assert.equal(model.repositories[0].ahead, 2);
    assert.equal(model.repositories[0].behind, 1);
    assert.equal(getGroup(view, 'work', 'feat: Export all fields').files.length, 2);
    assert.equal(fake.prompts.some(text => text.includes('SENSITIVE_VALUE_DO_NOT_SEND')), false);
  });
});

test('file stage/unstage and diffs use Git index, not virtual paths', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const file = node(root, 'work', 'file', { path: 'api.js' });
    await view.provider.receive({ type: 'action', root, action: 'stage', node: file });
    assert.equal((await listChanges(root)).find(c => c.path === 'api.js').staged, true);
    const staged = node(root, 'index', 'file', { path: 'api.js' });
    await view.provider.receive({ type: 'action', root, action: 'diff', node: staged });
    const call = fake.diffCommands.find(command => command.name === 'vscode.diff');
    assert.equal(call.args[0].scheme, 'aifg-head');
    assert.equal(call.args[1].scheme, 'aifg-index');
    assert.equal(await fake.providers.get('aifg-index').provideTextDocumentContent(call.args[1]),
      'export function list() { return []; }\n');
    await view.provider.receive({ type: 'action', root, action: 'unstage', node: staged });
    assert.equal((await listChanges(root)).find(c => c.path === 'api.js').staged, false);
  });
});

test('Revert action on one untracked file moves it to Trash and leaves other files untouched', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(fake.trashed.length, 1);
    assert.equal(fake.trashed[0].path, path.join(root, 'api.js'));
    await assert.rejects(fs.stat(path.join(root, 'api.js')), { code: 'ENOENT' });
    const pending = await listChanges(root);
    assert.equal(pending.some(change => change.path === 'other.js' && change.unstaged), true);
    assert.equal(pending.some(change => change.staged), false);
    assert.equal(fake.warnings.some(warning => warning.includes('Revert unstaged changes in api.js?')), true);
  });
});

test('Revert restores the working file from the index and does not unstage it', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    const stagedContent = await fs.readFile(path.join(root, 'api.js'), 'utf8');
    await fs.writeFile(path.join(root, 'api.js'), 'modified after staging\n');
    await view.provider.controller.refresh();
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(await fs.readFile(path.join(root, 'api.js'), 'utf8'), stagedContent);
    const state = (await listChanges(root)).find(change => change.path === 'api.js');
    assert.equal(state.staged, true);
    assert.equal(state.unstaged, false);
    assert.equal(fake.trashed.length, 0);
    // Revert is never exposed on the Staged Changes section.
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'index', 'file', { path: 'api.js' }) });
    assert.equal((await listChanges(root)).find(c => c.path === 'api.js').staged, true);
  });
});

test('Revert on Changes section is repository-scoped and preserves staged files', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    const stagedContent = await fs.readFile(path.join(root, 'api.js'), 'utf8');
    await fs.writeFile(path.join(root, 'api.js'), 'unstaged modification\n');
    await view.provider.controller.refresh();
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'work', 'section') });
    assert.equal(await fs.readFile(path.join(root, 'api.js'), 'utf8'), stagedContent);
    const changes = await listChanges(root);
    assert.deepEqual(changes.map(c => c.path), ['api.js']);
    assert.equal(changes[0].staged, true);
    assert.equal(changes[0].unstaged, false);
    assert.equal(fake.trashed.length, 3);
    assert.equal((await listChanges(extra)).some(change => change.path === 'second.js'), true);
    assert.equal(fake.warnings.some(msg => msg.includes('Revert all 4 unstaged file(s) in frontend?')), true);
  }, { extraDirty: true });
});

test('Revert requires confirmation and rejects a file changed while the dialog was open', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    fake.setDiscardConfirmation(false);
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(fake.trashed.length, 0);
    fake.setDiscardConfirmation(true);
    fake.setDiscardPromptHook(async () => fs.writeFile(path.join(root, 'api.js'), 'updated in another editor\n'));
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(await fs.readFile(path.join(root, 'api.js'), 'utf8'), 'updated in another editor\n');
    assert.equal(fake.trashed.length, 0);
    assert.equal(fake.warnings.some(msg => msg.includes('Git changes have updated')), true);
  });
});

test('Revert refuses to discard a file with unsaved VS Code editor changes', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    fake.vscode.workspace.textDocuments.push({ isDirty: true,
      uri: fake.vscode.Uri.file(path.join(root, 'api.js')) });
    await view.provider.receive({ type: 'action', root, action: 'discard',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(fake.trashed.length, 0);
    assert.equal(await fs.readFile(path.join(root, 'api.js'), 'utf8'), 'export function list() { return []; }\n');
    assert.equal(fake.warnings.some(message => message.includes('unsaved editor changes')), true);
  });
});

test('Revert ignores malicious Webview paths, unsupported phases and groups', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    for (const payload of [
      node(root, 'work', 'file', { path: '../../etc/passwd' }),
      node(root, 'work', 'file', { path: '.git/config' }),
      node(root, 'index', 'file', { path: 'api.js' }),
      node(root, 'work', 'feature', { name: 'feat: Export all fields' })
    ]) {
      await view.provider.receive({ type: 'action', root, action: 'discard', node: payload });
    }
    assert.equal(fake.trashed.length, 0);
    assert.equal((await listChanges(root)).some(change => change.path === 'api.js'), true);
  });
});

test('feature staging is isolated to that feature', async () => {
  await withFakeExtension(async ({ root, view }) => {
    await view.provider.receive({ type: 'action', root: root, action: 'stage',
      node: node(root, 'work', 'feature', { name: 'feat: Export all fields' }) });
    const changes = await listChanges(root);
    assert.equal(changes.find(c => c.path === 'api.js').staged, true);
    assert.equal(changes.find(c => c.path === 'api.test.js').staged, true);
    assert.equal(changes.find(c => c.path === 'other.js').unstaged, true);
    await view.provider.receive({ type: 'action', root: root, action: 'unstage',
      node: node(root, 'index', 'feature', { name: 'feat: Export all fields' }) });
    assert.equal((await listChanges(root)).filter(c => c.staged).length, 0);
  });
});

test('native Git input box sync, standard commit only includes staged files, clears input', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'setMessage', root, value: 'feat: Commit index only' });
    assert.equal(fake.repositories[0].inputBox.value, 'feat: Commit index only');
    await view.provider.receive({ type: 'action', root: root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    await view.provider.receive({ type: 'commit', root, message: 'feat: Commit index only' });
    assert.equal((await git(root, ['log', '-1', '--format=%s'])).trim(), 'feat: Commit index only');
    assert.equal((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).trim(), 'api.js');
    assert.equal((await listChanges(root)).find(c => c.path === 'other.js').unstaged, true);
    assert.equal(fake.repositories[0].inputBox.value, '');
  });
});

test('uncommitted message remains if only unstaged files are present', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'setMessage', root, value: 'feat: Needs stage' });
    await view.provider.receive({ type: 'commit', root, message: 'feat: Needs stage' });
    assert.equal(fake.repositories[0].inputBox.value, 'feat: Needs stage');
    await assert.rejects(git(root, ['rev-parse', 'HEAD']));
  });
});

test('multi-repo view simultaneously exposes independent commit forms, sections and sync counters', async () => {
  await withFakeExtension(async ({ root, extra, clean, fake, view }) => {
    const a = view.webview.messages.at(-1).model;
    assert.equal(a.repositories.length, 3);
    assert.equal(fake.views.length, 1);
    assert.equal(fake.scmRegistrations, 0);
    assert.ok(a.repositories.some(repo => repo.root === root));
    assert.ok(a.repositories.some(repo => repo.root === extra));
    assert.ok(a.repositories.some(repo => repo.root === clean));
    assert.equal(repository(view, clean).dirty, 0);
    assert.equal(repository(view, extra).sections[0].phase, 'index');
    await view.provider.receive({ type: 'setMessage', root, value: 'feat: frontend' });
    await view.provider.receive({ type: 'setMessage', root: extra, value: 'feat: backend' });
    assert.equal(fake.repositories[0].inputBox.value, 'feat: frontend');
    assert.equal(fake.repositories[1].inputBox.value, 'feat: backend');
    // There is no dropdown or selected repository state at all.
    await view.provider.receive({ type: 'selectRepo', root: extra });
    assert.equal(repository(view, root).root, root);
    assert.equal(repository(view, extra).root, extra);
  }, { extraDirty: true, extraClean: true });
});

test('staging and commits target only their repository in a multi-repo window', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    await view.provider.receive({ type: 'action', root: extra, action: 'stage',
      node: node(extra, 'work', 'file', { path: 'second.js' }) });
    assert.equal((await listChanges(extra))[0].staged, true);
    assert.equal((await listChanges(root)).filter(c => c.staged).length, 0);
    await view.provider.receive({ type: 'commit', root: extra, message: 'chore: Backend change' });
    assert.equal((await git(extra, ['log', '-1', '--format=%s'])).trim(), 'chore: Backend change');
    await assert.rejects(git(root, ['rev-parse', 'HEAD']));
    assert.equal(fake.repositories[0].inputBox.value, '');
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    await view.provider.receive({ type: 'commit', root, message: 'feat: Frontend change' });
    assert.equal((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).trim(), 'api.js');
    assert.equal((await git(extra, ['log', '-1', '--format=%s'])).trim(), 'chore: Backend change');
  }, { extraDirty: true });
});

test('untrusted webview cannot stage unexpected paths or wrong-phase entries', async () => {
  await withFakeExtension(async ({ root, view }) => {
    for (const payload of [
      node(root, 'work', 'file', { path: '../../etc/passwd' }),
      node(root, 'work', 'file', { path: '.git/config' }),
      node(root, 'index', 'file', { path: 'api.js' }),
      node(root, 'work', 'feature', { name: 'feat: malicious invented group' })
    ]) {
      await view.provider.receive({ type: 'action', root, action: 'stage', node: payload });
    }
    assert.equal((await listChanges(root)).filter(c => c.staged).length, 0);
    await view.provider.receive({ type: 'setMessage', root: '/nonexistent', value: 'injected' });
    await view.provider.receive({ type: 'action', root: '/nonexistent', action: 'stage', node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(repository(view, root).root, root);
  });
});

test('v1 ignores the legacy commitFeature Webview action; commits use the index only', async () => {
  await withFakeExtension(async ({ root, view }) => {
    await view.provider.receive({ type: 'action', root: root, action: 'stage',
      node: node(root, 'work', 'feature', { name: 'fix: Another feature' }) });
    await view.provider.receive({ type: 'action', root: root, action: 'commitFeature',
      node: node(root, 'work', 'feature', { name: 'feat: Export all fields' }) });
    await assert.rejects(git(root, ['rev-parse', 'HEAD']));
    assert.equal((await listChanges(root)).find(c => c.path === 'other.js').staged, true);
    await view.provider.receive({ type: 'commit', root, message: 'fix: Stage only selected files' });
    assert.equal((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).trim(), 'other.js');
  });
});

test('use feature name fills the real input box', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'action', root: root, action: 'useMessage',
      node: node(root, 'work', 'feature', { name: 'feat: Export all fields' }) });
    assert.equal(fake.repositories[0].inputBox.value, 'feat: Export all fields');
    assert.equal(repository(view, root).message, 'feat: Export all fields');
  });
});

test('diff works for a file with distinct index and working-tree content', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'action', root: root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    await fs.writeFile(path.join(root, 'api.js'), 'changed working-tree contents\n');
    await fake.handlers.get('aiFeatureGroups.refresh')();
    const dual = (await listChanges(root)).find(c => c.path === 'api.js');
    assert.equal(dual.staged, true);
    assert.equal(dual.unstaged, true);
    assert.equal(getGroup(view, 'work', 'feat: Export all fields').files.some(f => f.path === 'api.js'), true);
    assert.equal(getGroup(view, 'index', 'feat: Export all fields').files.some(f => f.path === 'api.js'), true);
    await view.provider.receive({ type: 'action', root: root, action: 'diff',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    const call = fake.diffCommands.filter(c => c.name === 'vscode.diff').at(-1);
    assert.equal(call.args[0].scheme, 'aifg-index');
    assert.equal(call.args[1].scheme, 'file');
  });
});


test('AI commit message uses only staged changes and never unstaged or secret filenames', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    await fs.writeFile(path.join(root, 'api.js'), 'SECRET_UNSTAGED_CONTENT_DO_NOT_SEND\n');
    await view.provider.receive({ type: 'generateMessage', root, originalMessage: '' });
    const prompt = fake.prompts.find(text => text.includes('Write a Git commit message'));
    assert.ok(prompt);
    assert.match(prompt, /api\.js/);
    assert.doesNotMatch(prompt, /SECRET_UNSTAGED_CONTENT_DO_NOT_SEND/);
    assert.doesNotMatch(prompt, /SENSITIVE_VALUE_DO_NOT_SEND/);
    assert.doesNotMatch(prompt, /other\.js/);
    assert.equal(fake.repositories[0].inputBox.value, ''); // UI must approve first
    const proposal = view.webview.messages.find(msg => msg.type === 'generatedMessage');
    assert.equal(proposal.root, root);
    assert.equal(proposal.message, 'feat: Add the selected changes');
    assert.equal(proposal.originalMessage, '');
  });
});

test('generating before classification prompts authorization but does not opt in to auto-classification', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    // Classification is already authorized in the test setup: now reset it.
    const controller = view.provider.controller;
    controller.provider = undefined;
    controller.providerName = undefined;
    controller.autoAuthorized = false;
    controller.providerConsents.clear();
    controller.authorizedRoots.clear();
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    await view.provider.receive({ type: 'generateMessage', root, originalMessage: 'existing message' });
    assert.equal(controller.providerName, 'copilot');
    assert.equal(controller.autoAuthorized, false);
    assert.equal(fake.prompts.filter(text => text.includes('Write a Git commit message')).length, 1);
    assert.ok(fake.warnings.some(message => message.includes('Git diffs')));
  });
});

test('generate message with no staged files does not call the AI or overwrite the draft', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await view.provider.receive({ type: 'setMessage', root, value: 'Existing draft' });
    await view.provider.receive({ type: 'generateMessage', root, originalMessage: 'Existing draft' });
    assert.ok(fake.errors.some(message => message.includes('Stage changes')));
    assert.equal(fake.prompts.filter(text => text.includes('Write a Git commit message')).length, 0);
    assert.equal(fake.repositories[0].inputBox.value, 'Existing draft');
  });
});

test('generation is scoped to the selected repository in a multi-repository window', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    await view.provider.receive({ type: 'action', root: extra, action: 'stage',
      node: node(extra, 'work', 'file', { path: 'second.js' }) });
    await view.provider.receive({ type: 'generateMessage', root: extra, originalMessage: '' });
    const prompt = fake.prompts.find(text => text.includes('Write a Git commit message'));
    assert.match(prompt, /second\.js/);
    assert.doesNotMatch(prompt, /api\.js/);
    const result = view.webview.messages.find(msg => msg.type === 'generatedMessage');
    assert.equal(result.root, extra);
    assert.equal(fake.repositories[0].inputBox.value, '');
  }, { extraDirty: true });
});

test('clicking the branch switches only the selected repo using its native Git API', async () => {
  await withFakeExtension(async ({ root, extra, clean, fake, view }) => {
    await git(clean, ['branch', 'release-test']);
    fake.repositories[2].state.HEAD.name = (await git(clean, ['branch', '--show-current'])).trim();
    const previous = fake.repositories[0].state.HEAD.name;
    await view.provider.receive({ type: 'switchBranch', root: clean });
    // Mock QuickPick chooses the first local branch sorted alphabetically.
    assert.deepEqual(fake.checkouts, [{ root: clean, name: 'release-test' }]);
    assert.equal(fake.repositories[0].state.HEAD.name, previous);
    assert.equal(fake.repositories[2].state.HEAD.name, 'release-test');
    assert.equal(repository(view, clean).branch, 'release-test');
    assert.ok(fake.quickPicks.at(-1).some(b => b.name === 'release-test'));
  }, { extraDirty: true, extraClean: true });
});


test('provider consent describes local redaction without claiming complete privacy', async () => {
  await withFakeExtension(async ({ fake }) => {
    assert.ok(fake.warnings.some(message =>
      message.includes('redacted locally') && message.includes('NOT a guarantee') &&
      message.includes('personal information may still be transmitted')));
  });
});


test('staging a level-three task only stages matching files, and level-two component stages the rest', async () => {
  await withFakeExtension(async ({ root, view }) => {
    const feature = section(view, 'work').groups.find(item => item.name === 'feat: Export all fields');
    assert.equal(feature.components.length, 1);
    assert.deepEqual(feature.components[0].tasks.map(task => task.name), ['List exports', 'Test export endpoint']);
    await view.provider.receive({ type: 'action', root, action: 'stage', node: {
      kind: 'task', root, phase: 'work', group: 'feat: Export all fields', component: 'Export API', name: 'List exports'
    } });
    assert.equal(section(view, 'index').count, 1);
    assert.equal(section(view, 'work').groups.find(item => item.name === 'feat: Export all fields').files.length, 1);
    await view.provider.receive({ type: 'action', root, action: 'stage', node: {
      kind: 'component', root, phase: 'work', group: 'feat: Export all fields', name: 'Export API'
    } });
    assert.equal(section(view, 'index').count, 2);
    assert.equal(section(view, 'work').groups.find(item => item.name === 'fix: Another feature').files.length, 1);
  });
});

test('Classify Changes is incremental; Reclassify All explicitly pays for unchanged diffs', async () => {
  await withFakeExtension(async ({ fake }) => {
    const initiallySent = fake.prompts.filter(prompt => prompt.includes('UNCOMMITTED Git patches')).length;
    assert.ok(initiallySent > 0);
    await fake.handlers.get('aiFeatureGroups.classify')();
    assert.equal(fake.prompts.filter(prompt => prompt.includes('UNCOMMITTED Git patches')).length, initiallySent);
    await fake.handlers.get('aiFeatureGroups.reclassifyAll')();
    assert.ok(fake.prompts.filter(prompt => prompt.includes('UNCOMMITTED Git patches')).length > initiallySent);
  });
});


test('classification is explicit per repository in multi-root windows', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    const controller = view.provider.controller;
    // The command picker selects exactly one (sorted) repository, never all.
    const initialRoot = [...controller.authorizedRoots][0];
    const otherRoot = initialRoot === root ? extra : root;
    assert.equal(controller.authorizedRoots.size, 1);
    const firstPrompts = fake.prompts.filter(text => text.includes('LEVEL 1:'));
    assert.equal(firstPrompts.length, 1);
    assert.match(firstPrompts[0], initialRoot === root ? /api\.js/ : /second\.js/);
    assert.doesNotMatch(firstPrompts[0], initialRoot === root ? /second\.js/ : /api\.js/);
    // An automatic call targeting an unauthorized repository is a no-op.
    await controller.classifyDirty(false, otherRoot);
    assert.equal(fake.prompts.filter(text => text.includes('LEVEL 1:')).length, 1);
    // A repository-scoped button authorizes only that repository.
    await view.provider.receive({ type: 'classify', root: otherRoot });
    assert.ok(controller.authorizedRoots.has(otherRoot));
    const classificationPrompts = fake.prompts.filter(text => text.includes('LEVEL 1:'));
    assert.equal(classificationPrompts.length, 2);
    assert.match(classificationPrompts[1], otherRoot === root ? /api\.js/ : /second\.js/);
    assert.doesNotMatch(classificationPrompts[1], otherRoot === root ? /second\.js/ : /api\.js/);
    assert.ok(fake.warnings.some(message => message.includes(otherRoot === root ? 'frontend' : 'backend')));
  }, { extraDirty: true });
});

test('detail setting is reflected in ViewModel without classifying or changing Webview state', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const initialCalls = fake.prompts.length;
    assert.equal(view.webview.messages.at(-1).model.detailLevel, 1);
    fake.settings.detailLevel = 3;
    view.provider.publish();
    const model = view.webview.messages.at(-1).model;
    assert.equal(model.detailLevel, 3);
    assert.equal(model.repositories[0].root, root);
    assert.equal(fake.prompts.length, initialCalls);
    assert.equal(view.webview.messages.at(-1).type, 'update');
  });
});

test('reclassify all is scoped to the chosen repository, without resending another repository', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    const initialRoot = [...view.provider.controller.authorizedRoots][0];
    const target = initialRoot === root ? extra : root;
    const before = fake.prompts.filter(text => text.includes('LEVEL 1:')).length;
    await view.provider.receive({ type: 'classify', root: target });
    await view.provider.controller.reclassifyAll(target);
    const prompts = fake.prompts.filter(text => text.includes('LEVEL 1:'));
    assert.equal(prompts.length, before + 2);
    assert.match(prompts.at(-1), target === root ? /api\.js/ : /second\.js/);
    assert.doesNotMatch(prompts.at(-1), target === root ? /second\.js/ : /api\.js/);
  }, { extraDirty: true });
});

test('sensitive values in otherwise normal Git diffs are redacted before classification and commit generation', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const secret = `AKIA${'B'.repeat(16)}`;
    await fs.writeFile(path.join(root, 'api.js'), `export const secret = '${secret}';\n`);
    await view.provider.controller.reclassifyAll(root);
    const prompts = fake.prompts.filter(text => text.includes('LEVEL 1:'));
    assert.ok(prompts.length >= 2);
    assert.doesNotMatch(prompts.at(-1), new RegExp(secret));
    assert.match(prompts.at(-1), /REDACTED POTENTIAL SECRET/);
    // Commit message uses the index and must be redacted independently.
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    await view.provider.receive({ type: 'generateMessage', root, originalMessage: '' });
    const stagedPrompt = fake.prompts.find(text => text.includes('Write a Git commit message'));
    assert.ok(stagedPrompt);
    assert.doesNotMatch(stagedPrompt, new RegExp(secret));
    assert.match(stagedPrompt, /REDACTED POTENTIAL SECRET/);
  });
});

test('classification results are discarded when the working tree changes during AI inference', async () => {
  await withFakeExtension(async ({ root, view }) => {
    const controller = view.provider.controller;
    const key = `${root}\0api.js`;
    const before = { ...controller.records.get(key) };
    controller.provider.classify = async () => {
      await fs.writeFile(path.join(root, 'api.js'), 'export const changedWhileModelRuns = true;\n');
      return JSON.stringify({ assignments: [{ path: 'api.js', group: 'fix: Stale AI result',
        component: 'Incorrect', task: 'Stale' }] });
    };
    await controller.reclassifyAll(root);
    assert.deepEqual(controller.records.get(key), before);
  });
});

test('classifier enforces the per-repository file cap, leaving other files untouched', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    fake.settings.maxFilesPerClassification = 1;
    const before = fake.prompts.filter(text => text.includes('LEVEL 1:')).length;
    await view.provider.controller.reclassifyAll(root);
    const prompts = fake.prompts.filter(text => text.includes('LEVEL 1:'));
    assert.equal(prompts.length, before + 1);
    const payload = JSON.parse(prompts.at(-1).split('Files and partial diffs:\n').at(-1));
    assert.equal(payload.length, 1);
  });
});

test('manual cancel stops a long classification and prevents automatic retry in that repository', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const controller = view.provider.controller;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    controller.provider.classify = async () => { began(); return new Promise(() => {}); };
    const running = controller.classifyDirty(true, root);
    await started;
    assert.equal(controller.classifyingRoot, root);
    controller.cancelClassification(root);
    await running;
    assert.equal(controller.classifyingRoot, undefined);
    assert.equal(controller.authorizedRoots.has(root), false);
    assert.equal(fake.errors.length, 0);
  });
});

test('local payload preview performs no model request and excludes known secret paths', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const count = fake.prompts.length;
    await view.provider.controller.previewPayload(root);
    assert.equal(fake.prompts.length, count);
    const doc = fake.previews.find(entry => entry.content);
    assert.ok(doc);
    assert.match(doc.content, /LOCAL PREVIEW ONLY/);
    assert.doesNotMatch(doc.content, /SENSITIVE_VALUE_DO_NOT_SEND/);
    assert.match(doc.content, /api\.js/);
  });
});

test('stale Git status is rejected before staging, rather than staging a mismatched file', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    // The Webview still shows an unstaged api.js, but external Git has staged it.
    await git(root, ['add', '--', 'api.js']);
    const before = await listChanges(root);
    assert.equal(before.find(change => change.path === 'api.js').staged, true);
    await view.provider.receive({ type: 'action', root, action: 'stage',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.ok(fake.warnings.some(message => message.includes('updated')));
    const after = await listChanges(root);
    assert.deepEqual(after, before);
  });
});


test('Open File opens the working-tree file in a pinned normal editor, not a diff', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    const before = await listChanges(root);
    await view.provider.receive({ type: 'action', root, action: 'openFile',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    const opens = fake.diffCommands.filter(call => call.name === 'vscode.open');
    assert.equal(opens.length, 1);
    assert.equal(opens[0].args[0].fsPath, path.join(root, 'api.js'));
    assert.deepEqual(opens[0].args[1], { preview: false });
    assert.equal(fake.diffCommands.some(call => call.name === 'vscode.diff'), false);
    assert.deepEqual(await listChanges(root), before, 'Opening a file must not alter Git status');
    // Clicking the filename continues to show a diff, unaffected by Open File.
    await view.provider.receive({ type: 'action', root, action: 'diff',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.ok(fake.diffCommands.some(call => call.name === 'vscode.diff'));
  });
});

test('Open File on staged files still opens the editable worktree, scoped to the correct repository', async () => {
  await withFakeExtension(async ({ root, extra, fake, view }) => {
    await git(root, ['add', '--', 'api.js']);
    await view.provider.controller.refresh();
    await view.provider.receive({ type: 'action', root, action: 'openFile',
      node: node(root, 'index', 'file', { path: 'api.js' }) });
    await view.provider.receive({ type: 'action', root: extra, action: 'openFile',
      node: node(extra, 'work', 'file', { path: 'second.js' }) });
    const opens = fake.diffCommands.filter(call => call.name === 'vscode.open');
    assert.deepEqual(opens.map(call => call.args[0].fsPath), [path.join(root, 'api.js'), path.join(extra, 'second.js')]);
    assert.ok(opens.every(call => call.args[0].scheme === 'file' && call.args[1].preview === false));
    assert.equal(fake.diffCommands.some(call => call.name === 'vscode.diff'), false);
    const tracked = (await listChanges(root)).find(change => change.path === 'api.js');
    assert.equal(tracked.staged, true, 'Opening staged file must not unstage it');
    assert.equal(fake.scmRegistrations, 0, 'No duplicate Source Control providers');
  }, { extraDirty: true });
});

test('Open File ignores fabricated paths and nonfile nodes sent from the Webview', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    for (const forged of [
      node(root, 'work', 'file', { path: '../private.txt' }),
      node(root, 'work', 'file', { path: '/etc/hosts' }),
      node('/not/open/repo', 'work', 'file', { path: 'api.js' }),
      node(root, 'work', 'section')
    ]) {
      await view.provider.receive({ type: 'action', root: forged.root, action: 'openFile', node: forged });
    }
    assert.equal(fake.diffCommands.filter(call => call.name === 'vscode.open').length, 0);
    assert.equal(fake.errors.length, 0);
  });
});

test('Open File on a deleted file does not create an editor for a nonexistent path', async () => {
  await withFakeExtension(async ({ root, fake, view }) => {
    await git(root, ['add', '--', 'api.js']);
    await git(root, ['commit', '-qm', 'track file']);
    await fs.rm(path.join(root, 'api.js'));
    await view.provider.controller.refresh();
    const deleted = (await listChanges(root)).find(change => change.path === 'api.js');
    assert.equal(deleted.deleted, true);
    await view.provider.receive({ type: 'action', root, action: 'openFile',
      node: node(root, 'work', 'file', { path: 'api.js' }) });
    assert.equal(fake.diffCommands.filter(call => call.name === 'vscode.open').length, 0);
    assert.match(fake.infos.at(-1), /no longer exists in the working tree/);
  });
});
