'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { buildViewModel, resolveActionNode, findGitRepository } = require('./view-model');
const git = require('./git');
const { digest } = require('./classifier');
const { stagedContext, makeCommitPrompt, parseCommitMessage } = require('./commit-message');

const VIEW_ID = 'aiFeatureGroups.view';

class FeatureWebview {
  constructor(context, controller, onAction) {
    this.context = context;
    this.controller = controller;
    this.onAction = onAction;
    this.version = 0;
    this.disposed = false;
    this.syncing = new Set();
    this.fetching = new Set();
    this.pushing = new Set();
    this.publishing = new Set();
    this.committing = new Set();
    this.generating = new Set();
    this.switching = new Set();
    this.subscription = controller.onDidChange(() => this.publish());
    this.registration = vscode.window.registerWebviewViewProvider(VIEW_ID, this, {
      webviewOptions: { retainContextWhenHidden: true }
    });
  }

  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    const fileUri = name => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const styleUri = fileUri('webview.css');
    const scriptUri = fileUri('webview.js');
    webview.html = `<!doctype html><html lang="en"><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
      <link rel="stylesheet" href="${styleUri}">
      <title>Changes by Feature</title>
    </head><body>
      <div id="app">
        <p id="status" role="status" aria-live="polite"></p>
        <div id="repositories" aria-label="Git repositories and changes"></div>
        <div id="context-menu" class="context-menu" role="menu" hidden></div>
      </div>
      <script src="${scriptUri}"></script>
    </body></html>`;
    this.viewSubscriptions = [
      webview.onDidReceiveMessage(message => {
        void this.receive(message).catch(error => this.controller.report(error, 'Source Control action'));
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        this.viewSubscriptions?.forEach(disposable => disposable.dispose());
        this.viewSubscriptions = undefined;
      })
    ];
    this.publish();
  }

  publish() {
    if (this.disposed || !this.view) return;
    const model = buildViewModel(this.controller, { syncing: this.syncing, fetching: this.fetching,
      pushing: this.pushing, publishing: this.publishing, committing: this.committing,
      generating: this.generating, switching: this.switching });
    void this.view.webview.postMessage({ type: 'update', version: ++this.version, model });
  }

  validRoot(root) {
    return typeof root === 'string' && this.controller.repositories.some(repo => repo.root === root);
  }

  networkBusy(root) {
    return this.syncing.has(root) || this.fetching.has(root) || this.pushing.has(root) || this.publishing.has(root);
  }

  async commit(root, message) {
    if (!this.validRoot(root) || this.committing.has(root) || this.networkBusy(root)) return;
    if (typeof message !== 'string' || !message.trim() || message.length > 25_000) {
      void vscode.window.showWarningMessage('Enter a commit message.');
      return;
    }
    this.committing.add(root);
    this.publish();
    let success = false;
    try {
      const changes = await git.listChanges(root);
      if (changes.some(change => change.conflicted)) {
        void vscode.window.showWarningMessage('Resolve merge conflicts before committing.');
      } else if (!changes.some(change => change.staged)) {
        void vscode.window.showWarningMessage('Stage changes with + before committing.');
      } else {
        const native = findGitRepository(this.controller, root);
        if (native?.inputBox) native.inputBox.value = message;
        // The public Git API respects hooks/signing/Git settings and uses only
        // staged content. Never commit with --all or a workspace-wide command.
        if (typeof native?.commit === 'function') await native.commit(message, { all: false, amend: false });
        else await git.commitStaged(root, message);
        if (native?.inputBox && native.inputBox.value === message) native.inputBox.value = '';
        await native?.status?.();
        await this.controller.refresh();
        success = true;
      }
    } catch (error) { this.controller.report(error, `Committing ${path.basename(root)}`); }
    finally {
      this.committing.delete(root);
      // Explicit acknowledgement only resets the matching repository's input.
      void this.view?.webview.postMessage({ type: 'commitResult', root, success });
      this.publish();
    }
  }

  async fetch(root) {
    if (!this.validRoot(root) || this.networkBusy(root) || this.committing.has(root)) return;
    const native = findGitRepository(this.controller, root);
    if (typeof native?.fetch !== 'function') {
      void vscode.window.showWarningMessage('Git Fetch is unavailable for this repository.');
      return;
    }
    this.fetching.add(root);
    this.publish();
    try {
      await native.fetch();
      await native.status?.();
      await this.controller.refresh();
    } catch (error) { this.controller.report(error, `Fetching ${path.basename(root)}`); }
    finally {
      this.fetching.delete(root);
      this.publish();
    }
  }

  async sync(root) {
    if (!this.validRoot(root) || this.networkBusy(root) || this.committing.has(root)) return;
    const native = findGitRepository(this.controller, root);
    const head = native?.state?.HEAD;
    if (!head?.upstream) {
      void vscode.window.showWarningMessage(
        `No tracking upstream for ${path.basename(root)}. Use Publish Branch first.`);
      return;
    }
    if (typeof native.pull !== 'function' || typeof native.push !== 'function') {
      void vscode.window.showWarningMessage('Git Sync is unavailable for this repository.');
      return;
    }
    // Respect the user's standard VS Code Git setting. Confirm before a push;
    // sync does NOT act on any other repository in the workspace.
    const confirm = vscode.workspace.getConfiguration('git', native.rootUri).get('confirmSync', true);
    if (confirm) {
      const accepted = await vscode.window.showWarningMessage(
        `Sync ${path.basename(root)} (${head.name || 'HEAD'}) with ${head.upstream.remote}/${head.upstream.name}? ` +
          'This pulls remote commits and then pushes your local commits.',
        { modal: true }, 'Sync Changes');
      if (accepted !== 'Sync Changes') return;
    }
    if (this.networkBusy(root) || this.committing.has(root)) return;
    this.syncing.add(root);
    this.publish();
    try {
      await native.pull();
      // Only push after pull succeeds (which may fail because of conflicts).
      const upstream = native.state.HEAD?.upstream;
      if (!upstream || upstream.remote === '.') throw new Error('No remote upstream after pull.');
      await native.push(upstream.remote, `HEAD:refs/heads/${upstream.name}`);
      await native.status?.();
      await this.controller.refresh();
    } catch (error) { this.controller.report(error, `Syncing ${path.basename(root)}`); }
    finally {
      this.syncing.delete(root);
      this.publish();
    }
  }

  async push(root) {
    if (!this.validRoot(root) || this.networkBusy(root) || this.committing.has(root)) return;
    const native = findGitRepository(this.controller, root);
    const head = native?.state?.HEAD;
    if (!head?.upstream || head.upstream.remote === '.') {
      return this.publishBranch(root);
    }
    if (typeof native.push !== 'function') {
      void vscode.window.showWarningMessage('Git Push is unavailable for this repository.');
      return;
    }
    this.pushing.add(root);
    this.publish();
    try {
      // Explicit destination: only the selected repo, current HEAD and its
      // configured upstream. Never force-push or target an unrelated branch.
      await native.push(head.upstream.remote, `HEAD:refs/heads/${head.upstream.name}`);
      await native.status?.();
      await this.controller.refresh();
    } catch (error) { this.controller.report(error, `Pushing ${path.basename(root)}`); }
    finally { this.pushing.delete(root); this.publish(); }
  }

  async publishBranch(root) {
    if (!this.validRoot(root) || this.networkBusy(root) || this.committing.has(root)) return;
    const native = findGitRepository(this.controller, root);
    const head = native?.state?.HEAD;
    // Publishing an unborn or detached branch is not valid Git. The UI must
    // not offer Publish Branch until the first successful local commit.
    if (!head?.name || !head.commit || head.type === 2) {
      void vscode.window.showWarningMessage('Create a commit on a named branch before publishing.');
      return;
    }
    if (head.upstream?.remote && head.upstream.remote !== '.') return this.push(root);
    if (typeof native.push !== 'function') {
      void vscode.window.showWarningMessage('Git Publish is unavailable for this repository.');
      return;
    }
    const remotes = (native.state.remotes || []).filter(remote =>
      remote?.name && !remote.isReadOnly && (remote.pushUrl || remote.fetchUrl || !('pushUrl' in remote)));
    if (remotes.length === 0) {
      void vscode.window.showWarningMessage(`No writable remote found in ${path.basename(root)}. Add a Git remote before publishing.`);
      return;
    }
    let remote;
    if (remotes.length === 1) {
      remote = remotes[0].name;
    } else {
      // Never guess between origin, upstream, forks, etc. in a multi-remote repo.
      const picked = await vscode.window.showQuickPick(remotes.map(item => ({
        label: item.name, description: item.pushUrl || item.fetchUrl || '', name: item.name
      })), { title: `Publish ${head.name}`, placeHolder: 'Select the remote to publish this branch to' });
      if (!picked) return;
      remote = picked.name;
    }
    // Revalidate after any asynchronous remote picker: the active branch can
    // change while the dialog is open, and another operation may have started.
    if (this.networkBusy(root) || this.committing.has(root) || native.state.HEAD?.name !== head.name ||
        native.state.HEAD?.upstream?.remote || !native.state.remotes.some(item => item.name === remote)) return;
    this.publishing.add(root);
    this.publish();
    try {
      // -u is handled by the native Git API, establishing the upstream.
      await native.push(remote, head.name, true);
      await native.status?.();
      await this.controller.refresh();
    } catch (error) { this.controller.report(error, `Publishing ${path.basename(root)}/${head.name}`); }
    finally { this.publishing.delete(root); this.publish(); }
  }

  /** Only the selected repository's staged diff is sent to the configured model. */
  async generateCommitMessage(root, originalMessage) {
    if (!this.validRoot(root) || this.generating.has(root) || this.committing.has(root) ||
        this.networkBusy(root) || this.switching.has(root)) return;
    if (typeof originalMessage !== 'string' || originalMessage.length > 25_000) return;
    this.generating.add(root);
    this.publish();
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      if (!await this.controller.ensureProviderAuthorized(root)) return;
      // Authorization might show a modal while the repository is changing.
      if (!this.validRoot(root) || this.networkBusy(root) || this.committing.has(root) || this.switching.has(root)) return;
      const branch = findGitRepository(this.controller, root)?.state?.HEAD?.name;
      const settings = this.controller.config();
      const patterns = settings.get('excludedFilePatterns', []);
      const maxChars = settings.get('maxDiffCharsPerFile', 3200);
      const before = await stagedContext(root, await git.listChanges(root), patterns, maxChars);
      const signature = digest(JSON.stringify(before));
      const response = await this.controller.provider.generateCommitMessage(makeCommitPrompt(before), tokenSource.token);
      const message = parseCommitMessage(response);
      if (!this.validRoot(root) || findGitRepository(this.controller, root)?.state?.HEAD?.name !== branch) {
        throw new Error('The branch changed during generation. Run Generate Commit Message again.');
      }
      const after = await stagedContext(root, await git.listChanges(root), patterns, maxChars);
      if (digest(JSON.stringify(after)) !== signature) {
        throw new Error('Staged changes changed during generation. Run Generate Commit Message again.');
      }
      // Never modify the native input here. The Webview verifies the field was
      // not edited while the model was running before applying the suggestion.
      void this.view?.webview.postMessage({ type: 'generatedMessage', root, originalMessage, message });
    } catch (error) {
      this.controller.report(error, `Generating commit message for ${path.basename(root)}`);
    } finally {
      tokenSource.dispose();
      this.generating.delete(root);
      this.publish();
    }
  }

  async switchBranch(root) {
    if (!this.validRoot(root) || this.networkBusy(root) || this.committing.has(root) ||
        this.generating.has(root) || this.switching.has(root)) return;
    const native = findGitRepository(this.controller, root);
    if (typeof native?.getBranches !== 'function' || typeof native?.checkout !== 'function') {
      void vscode.window.showWarningMessage('Branch switching is unavailable for this repository.');
      return;
    }
    this.switching.add(root);
    this.publish();
    try {
      const current = native.state.HEAD?.name;
      const branches = await native.getBranches({ remote: false });
      const names = [...new Set(branches.map(branch => branch.name).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      if (!names.length) {
        void vscode.window.showInformationMessage(`No local branches available in ${path.basename(root)}.`);
        return;
      }
      const chosen = await vscode.window.showQuickPick(names.map(name => ({
        label: name === current ? `$(check) ${name}` : `$(git-branch) ${name}`,
        description: name === current ? 'Current branch' : '', name
      })), { title: `Switch branch: ${path.basename(root)}`, placeHolder: 'Select a local branch' });
      if (!chosen || chosen.name === current) return;
      if (!this.validRoot(root) || native.state.HEAD?.name !== current) return;
      await native.checkout(chosen.name);
      await native.status?.();
      await this.controller.refresh();
    } catch (error) {
      this.controller.report(error, `Switching branch in ${path.basename(root)}`);
    } finally {
      this.switching.delete(root);
      this.publish();
    }
  }

  async receive(message) {
    if (this.disposed || !message || typeof message !== 'object') return;
    const { type, root } = message;
    if (type === 'ready') return this.publish();
    // All messages are repository-scoped; the Webview never selects a single
    // active repo. This is important for multi-root VS Code windows.
    if (!this.validRoot(root)) return;
    if (type === 'setMessage') {
      const native = findGitRepository(this.controller, root);
      if (native?.inputBox && typeof message.value === 'string' && message.value.length <= 25_000) {
        native.inputBox.value = message.value;
      }
      return;
    }
    if (type === 'commit') return this.commit(root, message.message);
    if (type === 'generateMessage') return this.generateCommitMessage(root, message.originalMessage);
    if (type === 'switchBranch') return this.switchBranch(root);
    if (type === 'classify') return this.controller.authorizeAndClassify(root);
    if (type === 'cancelClassification') return this.controller.cancelClassification(root);
    if (type === 'fetch') return this.fetch(root);
    if (type === 'sync') return this.sync(root);
    if (type === 'push') return this.push(root);
    if (type === 'publish') return this.publishBranch(root);
    if (type === 'action') {
      const allowed = new Set(['stage', 'unstage', 'diff', 'move', 'moveComponent', 'moveTask', 'reset', 'useMessage']);
      if (!allowed.has(message.action)) return;
      const node = resolveActionNode(this.controller, message.node);
      if (!node || node.root !== root) return;
      if (message.action === 'stage' && node.phase !== 'work') return;
      if (message.action === 'unstage' && node.phase !== 'index') return;
      if (['diff', 'move', 'moveComponent', 'moveTask', 'reset'].includes(message.action) && node.kind !== 'file') return;
      if (message.action === 'useMessage' && node.kind !== 'feature') return;
      if (message.action === 'useMessage') {
        const native = findGitRepository(this.controller, root);
        if (native?.inputBox) native.inputBox.value = node.name;
        void this.view?.webview.postMessage({ type: 'inputUpdated', root, value: node.name });
        return this.publish();
      }
      await this.onAction(message.action, node);
      return this.publish();
    }
  }

  dispose() {
    this.disposed = true;
    this.subscription.dispose();
    this.registration.dispose();
    this.viewSubscriptions?.forEach(disposable => disposable.dispose());
  }
}

module.exports = { FeatureWebview, VIEW_ID };
