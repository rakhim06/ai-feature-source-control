'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const git = require('./git');
const { Controller } = require('./controller');
const { FeatureWebview } = require('./feature-view');
const { cleanGroup, FALLBACK_GROUP, EXCLUDED_GROUP } = require('./classifier');

let controller;
let featureView;

async function activate(context) {
  const output = vscode.window.createOutputChannel('AI Feature Groups');
  controller = new Controller(context, output);

  // Render Git's actual HEAD, index and working tree: no virtual repositories.
  const documents = new Map();
  const registerSnapshot = mode => vscode.workspace.registerTextDocumentContentProvider(`aifg-${mode}`, {
    provideTextDocumentContent(uri) {
      const entry = documents.get(uri.query);
      if (!entry) return '';
      if (mode === 'head') return git.readHeadVersion(entry.root, entry.originalPath);
      if (mode === 'index') return git.readIndexVersion(entry.root, entry.path);
      return '';
    }
  });
  const documentProviders = [registerSnapshot('head'), registerSnapshot('index'), registerSnapshot('empty')];
  const discarding = new Set();

  const invokeGit = async (root, changes, operation) => {
    if (!root || !changes?.length) return;
    const relevant = changes.filter(change => operation === 'stage' ? change.unstaged : change.staged);
    if (!relevant.length) return;
    try {
      // A stale Webview row must never stage or unstage paths whose status has
      // changed in the meantime. Revalidate ALL selected paths atomically.
      const now = await git.listChanges(root);
      if (relevant.some(old => !now.some(current => current.path === old.path &&
          (operation === 'stage' ? current.unstaged : current.staged) && current.xy === old.xy))) {
        await controller.refresh();
        void vscode.window.showWarningMessage('Git changes have updated. Review the files and retry staging.');
        return;
      }
      if (operation === 'stage') {
        if (relevant.some(change => change.conflicted)) {
          const answer = await vscode.window.showWarningMessage(
            'Staging unresolved conflicts marks them resolved. Continue?',
            { modal: true }, 'Stage files');
          if (answer !== 'Stage files') return;
        }
        await git.stage(root, relevant);
      } else {
        await git.unstage(root, relevant);
      }
      await controller.refresh();
    } catch (error) { controller.report(error, `Git ${operation}`); }
  };

  const fileAction = async (operation, clickedNode) => {
    if (clickedNode?.kind !== 'file') return;
    await invokeGit(clickedNode.root, [clickedNode.change], operation);
  };

  const selectFeature = async phase => {
    const items = [];
    for (const repo of controller.repositories) {
      for (const group of [...new Set(repo.changes
        .filter(change => phase === 'work' ? change.unstaged : change.staged)
        .map(change => controller.nameFor(repo.root, change)))]) {
        const members = repo.changes.filter(change => (phase === 'work' ? change.unstaged : change.staged) &&
          controller.nameFor(repo.root, change) === group);
        items.push({
          label: group,
          description: `${path.basename(repo.root)} · ${members.length} files`,
          detail: repo.root,
          node: { kind: 'feature', root: repo.root, phase, name: group, changes: members }
        });
      }
    }
    return (await vscode.window.showQuickPick(items, { placeHolder: 'Select a feature' }))?.node;
  };

  const featureAction = async (operation, selected) => {
    const target = ['feature', 'component', 'task'].includes(selected?.kind) ? selected :
      await selectFeature(operation === 'stage' ? 'work' : 'index');
    if (target) await invokeGit(target.root, target.changes, operation);
  };

  const sectionAction = async (operation, selected) => {
    if (selected?.kind !== 'section' || selected.phase !== (operation === 'stage' ? 'work' : 'index')) return;
    await invokeGit(selected.root, selected.changes, operation);
  };

  const discardChanges = async selected => {
    if (!selected || selected.phase !== 'work' || !['file', 'section'].includes(selected.kind)) return;
    const { root } = selected;
    if (!controller.repositories.some(repo => repo.root === root) || discarding.has(root)) return;
    const changes = selected.kind === 'file' ? [selected.change] : selected.changes;
    if (!changes?.length || changes.some(change => !change?.unstaged)) return;
    const findDirtyEditor = () => (vscode.workspace.textDocuments || []).find(document =>
      document.isDirty && document.uri?.scheme === 'file' &&
      changes.some(change => document.uri.fsPath === path.resolve(root, change.path)));
    discarding.add(root);
    try {
      if (findDirtyEditor()) {
        void vscode.window.showWarningMessage('Save or close unsaved editor changes before reverting Git files.');
        return;
      }
      const entireSection = selected.kind === 'section';
      const snapshot = await git.discardSnapshot(root, changes, entireSection);
      const untracked = changes.filter(change => change.untracked).length;
      const target = entireSection ? `all ${changes.length} unstaged file(s) in ${path.basename(root)}` :
        `unstaged changes in ${changes[0].path}`;
      const detail = [
        'Tracked files will be restored from the Git index; any staged changes will be kept.',
        untracked ? `${untracked} untracked file(s) will be moved to Trash.` : '',
        'Discarded tracked edits cannot be recovered through Git.'
      ].filter(Boolean).join('\n');
      const answer = await vscode.window.showWarningMessage(`Revert ${target}?`,
        { modal: true, detail }, entireSection ? 'Revert All' : 'Revert');
      if (answer !== (entireSection ? 'Revert All' : 'Revert')) return;

      if (findDirtyEditor()) {
        void vscode.window.showWarningMessage('An editor now has unsaved changes. Save or close it before reverting.');
        return;
      }

      // Compare both the working file metadata and index before doing anything
      // destructive. The user might have edited/staged while the dialog was open.
      if (snapshot !== await git.discardSnapshot(root, changes, entireSection)) {
        void vscode.window.showWarningMessage('Git changes have updated. Review the files and retry reverting.');
        return;
      }
      await git.discardUnstaged(root, changes, filename =>
        vscode.workspace.fs.delete(vscode.Uri.file(filename), { useTrash: true, recursive: false }));
    } catch (error) {
      controller.report(error, `Reverting changes in ${path.basename(root)}`);
    } finally {
      discarding.delete(root);
      // Also refresh after partial failures or cancelled stale requests.
      await controller.refresh();
    }
  };

  const moveFile = async node => {
    if (!node || node.kind !== 'file') return;
    if (controller.nameFor(node.root, node.change) === EXCLUDED_GROUP) {
      void vscode.window.showInformationMessage('This file is excluded from AI classification.');
      return;
    }
    const repo = controller.repositories.find(repo => repo.root === node.root);
    if (!repo) return;
    const groups = [...new Set(repo.changes.map(change => controller.nameFor(node.root, change)))];
    const choice = await vscode.window.showQuickPick([
      { label: '$(add) New feature...', value: 'new' },
      ...groups.filter(name => ![EXCLUDED_GROUP, FALLBACK_GROUP].includes(name)).map(name => ({ label: name, value: name })),
      { label: FALLBACK_GROUP, value: FALLBACK_GROUP }
    ], { placeHolder: `Assign ${node.change.path} to a feature` });
    if (!choice) return;
    let name = choice.value;
    if (name === 'new') {
      name = await vscode.window.showInputBox({
        title: 'New feature', placeHolder: 'feat: Export all fields',
        validateInput: value => cleanGroup(value) === FALLBACK_GROUP ?
          'Start with feat:, fix:, refactor:, chore:, docs:, test:, perf:, build:, ci:, style: or revert:.' : undefined
      });
      if (name === undefined) return;
    }
    try { await controller.moveFile(node.root, node.change, name); }
    catch (error) { controller.report(error, 'Moving file to feature'); }
  };

  const moveDetail = async (node, field) => {
    if (node?.kind !== 'file') return;
    const current = controller.detailFor(node.root, node.change);
    if (current.group === EXCLUDED_GROUP) {
      void vscode.window.showInformationMessage('This file is excluded from AI classification.');
      return;
    }
    const repository = controller.repositories.find(repo => repo.root === node.root);
    if (!repository) return;
    const choices = [...new Set(repository.changes
      .map(change => controller.detailFor(node.root, change))
      .filter(detail => detail.group === current.group && (field === 'component' || detail.component === current.component))
      .map(detail => detail[field]))].sort((a, b) => a.localeCompare(b));
    const chosen = await vscode.window.showQuickPick([
      { label: `$(add) New ${field}...`, value: '' },
      ...choices.map(name => ({ label: name, value: name }))
    ], { placeHolder: `Assign ${node.change.path} to a ${field} in ${current.group}` });
    if (!chosen) return;
    const value = chosen.value || await vscode.window.showInputBox({
      title: `New ${field}`, placeHolder: field === 'component' ? 'Background processing' : 'Retry failed exports',
      validateInput: text => !text?.trim() ? 'Enter a description' : undefined
    });
    if (!value) return;
    try { await controller.moveDetail(node.root, node.change, field, value); }
    catch (error) { controller.report(error, `Moving file to ${field}`); }
  };

  const openFile = async node => {
    if (node?.kind !== 'file' || !node.change || !['work', 'index'].includes(node.phase)) return;
    const { root, change } = node;
    if (!controller.repositories.some(repository => repository.root === root)) return;
    // The Webview action is resolved against the live Git status. Also guard
    // programmatic command calls from opening arbitrary paths outside the repo.
    const filename = change.path;
    if (typeof filename !== 'string' || !filename || path.isAbsolute(filename) || filename.includes('\0')) return;
    const absolute = path.resolve(root, filename);
    const relative = path.relative(path.resolve(root), absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const uri = vscode.Uri.file(absolute);
    try {
      // Open the actual working-tree file, including when the row is staged.
      // A pinned editor tab is distinct from the default click-to-diff action.
      await vscode.workspace.fs.stat(uri);
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    } catch (error) {
      if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
        void vscode.window.showInformationMessage(
          `${filename} no longer exists in the working tree. Open its diff to see the previous version.`);
      } else {
        controller.report(error, `Opening ${filename}`);
      }
    }
  };

  const openDiff = async node => {
    if (!node || node.kind !== 'file') return;
    const { root, change, phase } = node;
    const id = randomUUID();
    if (documents.size > 300) documents.clear();
    documents.set(id, { root, path: change.path, originalPath: change.originalPath || change.path });
    const label = path.basename(change.path);
    const snapshot = mode => vscode.Uri.from({ scheme: `aifg-${mode}`, path: `/${label}`, query: id });
    let left, right;
    if (phase === 'index') {
      left = snapshot('head');
      right = snapshot('index');
    } else {
      left = snapshot('index');
      const file = vscode.Uri.file(path.join(root, change.path));
      try { await vscode.workspace.fs.stat(file); right = file; }
      catch { right = snapshot('empty'); }
    }
    await vscode.commands.executeCommand('vscode.diff', left, right,
      `${change.path} (${phase === 'index' ? 'HEAD ↔ staged' : 'staged ↔ working tree'})`,
      { preview: true });
  };

  const handleViewAction = async (action, node) => {
    if (action === 'discard') return discardChanges(node);
    if (action === 'stage' || action === 'unstage') {
      const operation = action === 'stage' ? 'stage' : 'unstage';
      if (node.kind === 'file') return fileAction(operation, node);
      if (['feature', 'component', 'task'].includes(node.kind)) return featureAction(operation, node);
      if (node.kind === 'section') return sectionAction(operation, node);
    }
    if (action === 'diff') return openDiff(node);
    if (action === 'openFile') return openFile(node);
    if (action === 'move') return moveFile(node);
    if (action === 'moveComponent') return moveDetail(node, 'component');
    if (action === 'moveTask') return moveDetail(node, 'task');
    if (action === 'reset') return controller.resetFile(node.root, node.change);

  };

  const commands = [
    vscode.commands.registerCommand('aiFeatureGroups.classify', () => controller.authorizeAndClassify()),
    vscode.commands.registerCommand('aiFeatureGroups.reclassifyAll', () => controller.reclassifyAll()),
    vscode.commands.registerCommand('aiFeatureGroups.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('aiFeatureGroups.previewPayload', () => controller.previewPayload()),
    vscode.commands.registerCommand('aiFeatureGroups.cancelClassification', () => controller.cancelClassification(controller.classifyingRoot)),
    vscode.commands.registerCommand('aiFeatureGroups.chooseProvider', () => controller.chooseProvider()),
    vscode.commands.registerCommand('aiFeatureGroups.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'aiFeatureGroups')),
    vscode.commands.registerCommand('aiFeatureGroups.stageFile', node => fileAction('stage', node)),
    vscode.commands.registerCommand('aiFeatureGroups.unstageFile', node => fileAction('unstage', node)),
    vscode.commands.registerCommand('aiFeatureGroups.stageFeature', node => featureAction('stage', node)),
    vscode.commands.registerCommand('aiFeatureGroups.unstageFeature', node => featureAction('unstage', node)),
    vscode.commands.registerCommand('aiFeatureGroups.stageSection', node => sectionAction('stage', node)),
    vscode.commands.registerCommand('aiFeatureGroups.unstageSection', node => sectionAction('unstage', node)),
    vscode.commands.registerCommand('aiFeatureGroups.discardFile', node => discardChanges(node)),
    vscode.commands.registerCommand('aiFeatureGroups.discardSection', node => discardChanges(node)),

    vscode.commands.registerCommand('aiFeatureGroups.moveToFeature', moveFile),
    vscode.commands.registerCommand('aiFeatureGroups.resetClassification', async node => {
      if (node?.kind === 'file') await controller.resetFile(node.root, node.change);
    }),
    vscode.commands.registerCommand('aiFeatureGroups.openDiff', openDiff),
    vscode.commands.registerCommand('aiFeatureGroups.openFile', openFile)
  ];

  context.subscriptions.push(output, ...documentProviders, ...commands, controller);
  try {
    await controller.start();
    featureView = new FeatureWebview(context, controller, handleViewAction);
    context.subscriptions.push(featureView);
  } catch (error) {
    output.appendLine(String(error.stack || error));
    void vscode.window.showErrorMessage(`AI Feature Groups: Git initialization failed: ${error.message}`);
  }
}

function deactivate() { featureView = undefined; controller = undefined; }
module.exports = { activate, deactivate };
