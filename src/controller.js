'use strict';

const vscode = require('vscode');
const git = require('./git');
const { sanitizeDiff } = require('./privacy');
const { isCancellation, AIRequestError } = require('./ai-errors');
const { CopilotProvider, CodexCliProvider } = require('./providers');
const {
  FALLBACK_GROUP, EXCLUDED_GROUP, FALLBACK_COMPONENT, FALLBACK_TASK, cleanGroup, cleanDetail, digest,
  makePrompt, parseDetailedAssignments, toBatches, applyDiffBudget
} = require('./classifier');

const CACHE_KEY = 'aiFeatureGroups.classifications.v1';

function pathlessName(root) { return root.split(/[\\/]/).pop(); }
function recordKey(root, file) { return `${root}\0${file}`; }
function explain(error) { return error instanceof Error ? error.message : String(error); }

class Controller {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.api = undefined;
    this.repositories = [];
    this.repoSubscriptions = [];
    this.coreSubscriptions = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.records = new Map(Object.entries(context.workspaceState.get(CACHE_KEY, {})));
    this.autoAuthorized = false;
    // Authorization and auto-classification are repository-scoped. Activating
    // one repo must never silently send diffs from other open repositories.
    this.authorizedRoots = new Set();
    this.providerConsents = new Set();
    this.classifyingRoot = undefined;
    this.classificationToken = undefined;
    this.providerName = undefined;
    this.provider = undefined;
    this.refreshTimer = undefined;
    this.classifyTimer = undefined;
    this.classifying = false;
    this.refreshTask = undefined;
    this.refreshPending = false;
    this.classificationPending = new Map();
    this.cancelRequestedRoots = new Set();
    this.isDisposed = false;
  }

  config() { return vscode.workspace.getConfiguration('aiFeatureGroups'); }

  async start() {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The built-in Git extension is unavailable.');
    const exports = await extension.activate();
    if (!exports || typeof exports.getAPI !== 'function') throw new Error('Git extension API is unavailable.');
    this.api = exports.getAPI(1);
    this.coreSubscriptions.push(this.api.onDidOpenRepository(() => this.syncRepositories()));
    this.coreSubscriptions.push(this.api.onDidCloseRepository(() => this.syncRepositories()));
    this.coreSubscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      const modelChanged = ['provider', 'copilotModelId', 'codexModel', 'codexReasoningEffort']
        .some(key => event.affectsConfiguration(`aiFeatureGroups.${key}`));
      if (modelChanged) {
        if (this.classifyingRoot) this.cancelRequestedRoots.add(this.classifyingRoot);
        this.classificationToken?.cancel();
        this.autoAuthorized = false;
        this.authorizedRoots.clear();
        this.providerConsents.clear();
        this.provider = undefined;
        this.providerName = undefined;
        this.classificationPending.clear();
      }
      if (event.affectsConfiguration('aiFeatureGroups.detailLevel')) this.changed.fire();
      else if (event.affectsConfiguration('aiFeatureGroups')) this.scheduleRefresh();
    }));
    this.syncRepositories();
  }

  syncRepositories() {
    this.repoSubscriptions.forEach(d => d.dispose());
    this.repoSubscriptions = [];
    if (!this.api) return;
    for (const repository of this.api.repositories) {
      this.repoSubscriptions.push(repository.state.onDidChange(() => this.scheduleRefresh()));
    }
    this.scheduleRefresh(0);
  }

  scheduleRefresh(delay = 350) {
    if (this.isDisposed) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.isDisposed) return;
      void this.refresh().catch(error => this.report(error, 'Refreshing Git changes'));
    }, delay);
  }

  scheduleClassification() {
    if (this.isDisposed) return;
    if (!this.autoAuthorized || !this.config().get('autoClassify', true) || !this.authorizedRoots.size) return;
    clearTimeout(this.classifyTimer);
    this.classifyTimer = setTimeout(() => {
      // A repo must be explicitly classified at least once in this session
      // before its diffs may be transmitted automatically.
      for (const root of this.authorizedRoots) {
        if (this.repositories.some(repo => repo.root === root)) {
          void this.classifyDirty(false, root).catch(error => this.report(error, 'Automatic classification'));
        }
      }
    }, Math.max(1500, Math.min(60000, this.config().get('autoClassifyDelayMs', 5000))));
  }

  async refresh() {
    if (this.isDisposed) return;
    // Never resolve a manual refresh with an older in-flight snapshot. A Git
    // operation can finish while a refresh was already underway.
    if (this.refreshTask) {
      try { await this.refreshTask; } catch { /* Retry with a new snapshot. */ }
      return this.refresh();
    }
    const task = this.doRefresh();
    this.refreshTask = task;
    try { return await task; }
    finally { if (this.refreshTask === task) this.refreshTask = undefined; }
  }

  async doRefresh() {
      if (!this.api || this.isDisposed) return;
      const sources = this.api.repositories.filter(repo => repo.rootUri.scheme === 'file');
      const snapshots = await Promise.all(sources.map(async repository => ({
        root: repository.rootUri.fsPath,
        changes: await git.listChanges(repository.rootUri.fsPath),
        branch: repository.state.HEAD?.name || await git.currentBranch(repository.rootUri.fsPath)
      })));
      if (this.isDisposed) return;
      this.repositories = snapshots.sort((a, b) => a.root.localeCompare(b.root));
      const active = new Set(snapshots.flatMap(({ root, changes }) => changes.map(c => recordKey(root, c.path))));
      const roots = snapshots.map(s => `${s.root}\0`);
      let changedCache = false;
      for (const key of this.records.keys()) {
        if (roots.some(prefix => key.startsWith(prefix)) && !active.has(key)) {
          this.records.delete(key);
          changedCache = true;
        }
      }
      if (changedCache) await this.save();
      this.changed.fire();
      this.scheduleClassification();
  }

  detailFor(root, change) {
    const record = this.records.get(recordKey(root, change.path));
    if (git.shouldExclude(change.path, this.config().get('excludedFilePatterns', []))) {
      return { group: EXCLUDED_GROUP, component: FALLBACK_COMPONENT, task: FALLBACK_TASK };
    }
    return {
      group: record?.group || FALLBACK_GROUP,
      component: record?.component || FALLBACK_COMPONENT,
      task: record?.task || FALLBACK_TASK
    };
  }

  nameFor(root, change) {
    const patterns = this.config().get('excludedFilePatterns', []);
    if (git.shouldExclude(change.path, patterns)) return EXCLUDED_GROUP;
    const record = this.records.get(recordKey(root, change.path));
    return record?.group || FALLBACK_GROUP;
  }

  /** Consent to transmitting diffs is per-repository and always user-initiated. */
  async ensureProviderAuthorized(root) {
    if (!this.repositories.some(repo => repo.root === root)) return false;
    const name = this.config().get('provider', 'copilot');
    if (this.provider && this.providerName === name && this.providerConsents.has(root)) return true;
    const answer = await vscode.window.showWarningMessage(
      `AI Feature Groups will send selected Git diffs from ${pathlessName(root)} to ${name === 'codex' ? 'Codex CLI' : 'GitHub Copilot'}. ` +
      'Known sensitive filenames are excluded and common credential patterns in diffs are redacted locally. ' +
      'This is NOT a guarantee: other secrets or personal information may still be transmitted. Continue?',
      { modal: true }, 'Analyze diffs'
    );
    if (answer !== 'Analyze diffs') return false;
    if (!this.provider || this.providerName !== name) {
      const nextProvider = name === 'codex' ? new CodexCliProvider() : new CopilotProvider();
      await nextProvider.authorize();
      this.providerName = name;
      this.provider = nextProvider;
    }
    this.providerConsents.add(root);
    return true;
  }

  async pickRepository(root) {
    if (root !== undefined) {
      return this.repositories.some(repo => repo.root === root && repo.changes.length) ? root : undefined;
    }
    const repos = this.repositories.filter(repo => repo.changes.length);
    if (!repos.length) {
      void vscode.window.showInformationMessage('No Git changes to classify.');
      return undefined;
    }
    if (repos.length === 1) return repos[0].root;
    const chosen = await vscode.window.showQuickPick(repos.map(repo => ({
      label: pathlessName(repo.root),
      description: `${repo.changes.length} changed files`,
      detail: repo.root,
      root: repo.root
    })), { title: 'Classify one repository', placeHolder: 'Select the repository whose diffs may be sent to AI' });
    return chosen?.root;
  }

  async authorizeAndClassify(root) {
    try {
      await this.refresh();
      const selectedRoot = await this.pickRepository(root);
      if (!selectedRoot || !await this.ensureProviderAuthorized(selectedRoot)) return;
      this.autoAuthorized = true;
      this.authorizedRoots.add(selectedRoot);
      await this.classifyDirty(false, selectedRoot);
    } catch (error) {
      this.report(error, 'Selecting AI provider');
    }
  }

  async reclassifyAll(root) {
    try {
      await this.refresh();
      const selectedRoot = await this.pickRepository(root);
      if (!selectedRoot || !await this.ensureProviderAuthorized(selectedRoot)) return;
      this.autoAuthorized = true;
      this.authorizedRoots.add(selectedRoot);
      await this.classifyDirty(true, selectedRoot);
    } catch (error) {
      this.report(error, 'Reclassifying repository changes');
    }
  }

  async classifyDirty(force, root) {
    if (!this.autoAuthorized || !this.provider || !this.authorizedRoots.has(root)) return;
    if (this.classifying) {
      this.classificationPending.set(root, force || this.classificationPending.get(root) || false);
      return;
    }
    this.classifying = true;
    this.classifyingRoot = root;
    this.changed.fire();
    try {
      const patterns = this.config().get('excludedFilePatterns', []);
      const maxChars = this.config().get('maxDiffCharsPerFile', 3200);
      const maxFiles = this.config().get('maxFilesPerBatch', 25);
      const totalBudget = this.config().get('maxTotalDiffCharsPerClassification', 60000);
      const maxClassificationFiles = this.config().get('maxFilesPerClassification', 80);
      const repositories = [];
      for (const { root: repoRoot, changes } of this.repositories.filter(repo => repo.root === root)) {
        const root = repoRoot;
        const dirty = [];
        const knownGroups = new Set(changes.map(c => this.nameFor(root, c)));
        const hierarchy = new Map();
        for (const change of changes) {
          if (this.cancelRequestedRoots.has(root) || !this.authorizedRoots.has(root))
            throw new AIRequestError('AI classification cancelled.', 'AI_CANCELLED');
          const known = this.detailFor(root, change);
          hierarchy.set(JSON.stringify(known), known);
          if (git.shouldExclude(change.path, patterns)) continue;
          const key = recordKey(root, change.path);
          const cached = this.records.get(key);
          // Preserve manual assignments, but refine legacy pinned records that
          // predate component/task metadata.
          if (cached?.pinned && typeof cached.component === 'string' && typeof cached.task === 'string') continue;
          const { text, reason, contentHash } = await git.getDiff(root, change, maxChars);
          if (reason) {
            this.records.set(key, { group: EXCLUDED_GROUP, component: FALLBACK_COMPONENT,
              task: FALLBACK_TASK, hash: reason, pinned: false });
            continue;
          }
          const hash = digest(contentHash || text || `${change.xy} ${change.path}`);
          // Records from previous extension versions need one reclassification
          // to populate component/task. Changing the DISPLAY level never calls AI.
          const hasDetails = typeof cached?.component === 'string' && typeof cached?.task === 'string';
          if (!force && cached?.hash === hash && hasDetails) continue;
          const screened = sanitizeDiff(text);
          if (screened.reason || !screened.text) {
            this.records.set(key, { group: EXCLUDED_GROUP, component: FALLBACK_COMPONENT,
              task: FALLBACK_TASK, hash: screened.reason || 'no-safe-diff', pinned: false });
            continue;
          }
          dirty.push({ path: change.path, status: change.xy, diff: screened.text, hash,
            fixedGroup: cached?.pinned ? cached.group : undefined });
        }
        repositories.push({ root, branchAtStart: await git.currentBranch(root), changes, dirty, knownGroups, hierarchy });
      }
      // Strictly one repository per user request. The diff-character budget
      // is per-repository, never consumed or pooled with other repositories.
      for (const repo of repositories) {
        if (!repo.dirty.length) continue;
        // Hard cap limits both the file metadata and number of paid requests.
        // Remaining changed files are still visible in the tree, but retain
        // their cached grouping or fall back to Uncategorized.
        const selected = repo.dirty.slice(0, maxClassificationFiles);
        if (selected.length < repo.dirty.length) {
          this.output.appendLine(`AI budget: ${repo.dirty.length - selected.length} changed files deferred in ${pathlessName(repo.root)} (maxFilesPerClassification=${maxClassificationFiles}).`);
        }
        const items = applyDiffBudget(selected, totalBudget);
        for (const batch of toBatches(items, maxFiles)) {
          if (this.cancelRequestedRoots.has(root) || !this.authorizedRoots.has(root))
            throw new AIRequestError('AI classification cancelled.', 'AI_CANCELLED');
          const prompt = makePrompt(batch, [...repo.knownGroups], [...repo.hierarchy.values()]);
          this.output.appendLine(`AI classification: ${batch.length} files, approximately ${Math.ceil(prompt.length / 4)} input tokens (rough estimate), ${pathlessName(repo.root)}.`);
          const tokenSource = new vscode.CancellationTokenSource();
          this.classificationToken = tokenSource;
          let output;
          const timeoutMs = this.config().get('aiRequestTimeoutMs', 120000);
          let timedOut = false;
          let cancelListener;
          let rejectCancel;
          const cancelPromise = new Promise((_, reject) => { rejectCancel = reject; });
          cancelListener = tokenSource.token.onCancellationRequested(() => rejectCancel(new AIRequestError(
            timedOut ? 'AI classification timed out.' : 'AI classification cancelled.',
            timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED')));
          const timeout = setTimeout(() => { timedOut = true; tokenSource.cancel(); }, timeoutMs);
          try {
            output = await Promise.race([
              this.provider.classify(prompt, tokenSource.token),
              cancelPromise
            ]);
            if (this.cancelRequestedRoots.has(root) || !this.authorizedRoots.has(root))
            throw new AIRequestError('AI classification cancelled.', 'AI_CANCELLED');
          } finally {
            clearTimeout(timeout);
            cancelListener.dispose();
            if (this.classificationToken === tokenSource) this.classificationToken = undefined;
            tokenSource.dispose();
          }
          const assignments = parseDetailedAssignments(output, batch.map(f => f.path));
          // The tree and its index can change while an AI request is in flight.
          // Recheck branch, file status, and the ORIGINAL raw diff fingerprint
          // before applying any result. Never apply stale AI labels.
          if (!this.repositories.some(r => r.root === repo.root) ||
              await git.currentBranch(repo.root) !== repo.branchAtStart) continue;
          const liveChanges = await git.listChanges(repo.root);
          for (const item of batch) {
            const live = liveChanges.find(change => change.path === item.path);
            if (!live || live.xy !== item.status) continue;
            const fresh = await git.getDiff(repo.root, live, maxChars);
            if (fresh.reason || digest(fresh.contentHash || fresh.text || `${live.xy} ${live.path}`) !== item.hash) continue;
            const key = recordKey(repo.root, item.path);
            const current = this.records.get(key);
            if (current?.pinned && typeof current.component === 'string' && typeof current.task === 'string') continue;
            const detail = assignments.get(item.path) || {
              group: FALLBACK_GROUP, component: FALLBACK_COMPONENT, task: FALLBACK_TASK
            };
            const effective = current?.pinned ? { ...detail, group: current.group } : detail;
            this.records.set(key, { ...effective, hash: item.hash, pinned: Boolean(current?.pinned) });
            repo.knownGroups.add(effective.group);
            repo.hierarchy.set(JSON.stringify(effective), effective);
          }
          await this.save();
          this.changed.fire();
        }
      }
    } catch (error) {
      // Disable automatic retries ONLY for the failing repository, not every
      // repository open in the same VS Code window.
      this.authorizedRoots.delete(root);
      this.autoAuthorized = this.authorizedRoots.size > 0;
      this.classificationPending.delete(root);
      if (!isCancellation(error)) this.report(error, `Classifying changes with ${this.providerName || 'AI'}`);
    } finally {
      this.classifying = false;
      this.cancelRequestedRoots.delete(root);
      this.classifyingRoot = undefined;
      this.classificationToken = undefined;
      this.changed.fire();
      if (this.autoAuthorized && this.classificationPending.size) {
        const [nextRoot, nextForce] = this.classificationPending.entries().next().value;
        this.classificationPending.delete(nextRoot);
        // A deferred task avoids recursive invocation during cleanup.
        setImmediate(() => {
          if (!this.isDisposed) void this.classifyDirty(nextForce, nextRoot);
        });
      }
    }
  }

  /** Inspect locally what a full reclassification could send. No provider or permission required. */
  async previewPayload(root) {
    await this.refresh();
    const selectedRoot = await this.pickRepository(root);
    if (!selectedRoot) return;
    const repo = this.repositories.find(item => item.root === selectedRoot);
    if (!repo) return;
    const patterns = this.config().get('excludedFilePatterns', []);
    const perFile = this.config().get('maxDiffCharsPerFile', 3200);
    const limit = this.config().get('maxFilesPerClassification', 80);
    const budget = this.config().get('maxTotalDiffCharsPerClassification', 60000);
    const safe = [];
    let omitted = 0;
    for (const change of repo.changes) {
      if (git.shouldExclude(change.path, patterns)) { omitted++; continue; }
      if (safe.length >= limit) { omitted++; continue; }
      const result = await git.getDiff(selectedRoot, change, perFile);
      const screened = sanitizeDiff(result.text);
      if (result.reason || screened.reason || !screened.text) { omitted++; continue; }
      safe.push({ path: change.path, status: change.xy, diff: screened.text });
    }
    const batches = toBatches(applyDiffBudget(safe, budget), this.config().get('maxFilesPerBatch', 25));
    const header = [
      'LOCAL PREVIEW ONLY — nothing below has been sent to any model.',
      'Illustrates a FULL reclassification; an incremental run typically sends fewer files.',
      `Repository: ${pathlessName(selectedRoot)}. Included: ${safe.length}. Omitted: ${omitted}.`,
      'Names/paths are excluded and common credential patterns are redacted, but this is NOT a guarantee.',
      'Preview data can still contain private information. Review before explicitly classifying.'
    ].join('\n');
    const content = [header, ...batches.map((batch, index) =>
      `\n--- AI prompt ${index + 1}/${batches.length} ---\n${makePrompt(batch, [], [])}`)].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
  }

  cancelClassification(root) {
    if (this.classifyingRoot !== root) return;
    this.classificationPending.delete(root);
    this.cancelRequestedRoots.add(root);
    this.authorizedRoots.delete(root); // A new explicit click is required to retry.
    this.autoAuthorized = this.authorizedRoots.size > 0;
    this.classificationToken?.cancel();
  }

  async chooseProvider() {
    const selected = await vscode.window.showQuickPick([
      { label: 'GitHub Copilot', description: 'VS Code Language Model API', value: 'copilot' },
      { label: 'OpenAI Codex', description: 'Authenticated local Codex CLI', value: 'codex' }
    ], { placeHolder: 'Choose an AI provider' });
    if (selected) {
      await this.config().update('provider', selected.value, vscode.ConfigurationTarget.Global);
      this.autoAuthorized = false;
      this.authorizedRoots.clear();
      this.providerConsents.clear();
      this.classificationPending.clear();
      this.provider = undefined;
      await vscode.window.showInformationMessage(`AI provider set to ${selected.label}. Classify a repository to authorize.`);
    }
  }

  async save() {
    await this.context.workspaceState.update(CACHE_KEY, Object.fromEntries(this.records));
  }

  async moveFile(root, change, name) {
    const group = cleanGroup(name);
    if (group === FALLBACK_GROUP && name !== FALLBACK_GROUP) {
      throw new Error('Feature names must start with feat:, fix:, refactor:, docs:, test:, chore:, perf:, build:, ci:, style: or revert:.');
    }
    const previous = this.detailFor(root, change);
    this.records.set(recordKey(root, change.path), { group,
      component: previous.group === group ? previous.component : FALLBACK_COMPONENT,
      task: previous.group === group ? previous.task : FALLBACK_TASK,
      pinned: true, hash: '' });
    await this.save();
    this.changed.fire();
  }

  async moveDetail(root, change, field, value) {
    if (!['component', 'task'].includes(field)) throw new Error('Invalid detail level');
    if (git.shouldExclude(change.path, this.config().get('excludedFilePatterns', []))) {
      throw new Error('Excluded files cannot be assigned to an AI grouping.');
    }
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a non-empty detail name');
    const previous = this.detailFor(root, change);
    const name = cleanDetail(value, field === 'component' ? FALLBACK_COMPONENT : FALLBACK_TASK,
      field === 'component' ? 48 : 60);
    const next = field === 'component' ? { ...previous, component: name,
      task: previous.component === name ? previous.task : FALLBACK_TASK } : { ...previous, task: name };
    this.records.set(recordKey(root, change.path), { ...next, pinned: true, hash: '' });
    await this.save();
    this.changed.fire();
  }

  async resetFile(root, change) {
    this.records.delete(recordKey(root, change.path));
    await this.save();
    this.changed.fire();
    if (this.autoAuthorized && this.authorizedRoots.has(root)) this.scheduleClassification();
  }

  getGroup(root, group) {
    const repo = this.repositories.find(r => r.root === root);
    return repo ? repo.changes.filter(c => this.nameFor(root, c) === group) : [];
  }

  get groupsCount() {
    return this.repositories.reduce((count, repo) => count + repo.changes.length, 0);
  }

  report(error, action) {
    if (this.isDisposed) return;
    this.output.appendLine(`${new Date().toISOString()} ${action}: ${explain(error)}`);
    void vscode.window.showErrorMessage(`AI Feature Groups: ${action} failed: ${explain(error)}`);
  }

  dispose() {
    this.isDisposed = true;
    this.cancelRequestedRoots.add(this.classifyingRoot);
    this.classificationToken?.cancel();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.classifyTimer);
    for (const d of [...this.coreSubscriptions, ...this.repoSubscriptions]) d.dispose();
    this.changed.dispose();
  }
}

module.exports = { Controller, recordKey };
