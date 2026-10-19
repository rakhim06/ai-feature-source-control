'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FALLBACK_GROUP, EXCLUDED_GROUP } = require('./classifier');

const VIEW_ID = 'aiFeatureGroups.view';
const COLLAPSE = vscode.TreeItemCollapsibleState;

/**
 * A single view inside Source Control, backed by the EXISTING Git provider.
 * Unlike createSourceControl(), this does not register a second SCM repository.
 */
class FeatureTree {
  constructor(controller) {
    this.controller = controller;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.subscription = controller.onDidChange(() => this.changed.fire());
    this.view = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
      canSelectMany: true
    });
  }

  dirtyRepositories() {
    return this.controller.repositories.filter(repo => repo.changes.length);
  }

  featureNames(root, changes) {
    const names = [...new Set(changes.map(change => this.controller.nameFor(root, change)))];
    const rank = name => name === EXCLUDED_GROUP ? 2 : name === FALLBACK_GROUP ? 1 : 0;
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  phaseChanges(repo, phase) {
    return repo.changes.filter(change => phase === 'work' ? change.unstaged : change.staged);
  }

  getChildren(node) {
    const repositories = this.dirtyRepositories();
    if (!node) {
      if (!repositories.length) return [{ kind: 'empty' }];
      // Avoid an unnecessary repo level for a single dirty repository.
      if (repositories.length === 1) return this.sections(repositories[0]);
      return repositories.map(repo => ({ kind: 'repo', root: repo.root, branch: repo.branch }));
    }
    if (node.kind === 'repo') {
      const repo = repositories.find(repo => repo.root === node.root);
      return repo ? this.sections(repo) : [];
    }
    if (node.kind === 'section') {
      const repo = repositories.find(repo => repo.root === node.root);
      if (!repo) return [];
      const changes = this.phaseChanges(repo, node.phase);
      return this.featureNames(node.root, changes).map(name => ({
        kind: 'feature', root: node.root, phase: node.phase, name,
        changes: changes.filter(change => this.controller.nameFor(node.root, change) === name)
      }));
    }
    if (node.kind === 'feature') {
      return node.changes.map(change => ({ kind: 'file', root: node.root, phase: node.phase, change }));
    }
    return [];
  }

  sections(repo) {
    return ['work', 'index'].map(phase => ({
      kind: 'section', root: repo.root, phase, changes: this.phaseChanges(repo, phase)
    })).filter(section => section.changes.length);
  }

  getTreeItem(node) {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('No uncommitted Git changes', COLLAPSE.None);
      item.iconPath = new vscode.ThemeIcon('check');
      return item;
    }
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(path.basename(node.root), COLLAPSE.Expanded);
      item.id = `aifg:repo:${node.root}`;
      item.contextValue = 'aifgRepo';
      item.description = node.branch || '';
      item.tooltip = `${node.root}\nBranch: ${node.branch || '(unknown)'}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      return item;
    }
    if (node.kind === 'section') {
      const label = node.phase === 'work' ? 'Changes' : 'Staged Changes';
      const item = new vscode.TreeItem(`${label} (${node.changes.length})`, COLLAPSE.Expanded);
      item.id = `aifg:section:${node.root}:${node.phase}`;
      item.contextValue = node.phase === 'work' ? 'aifgWorkSection' : 'aifgIndexSection';
      item.iconPath = new vscode.ThemeIcon(node.phase === 'work' ? 'diff' : 'checklist');
      return item;
    }
    if (node.kind === 'feature') {
      const item = new vscode.TreeItem(node.name, COLLAPSE.Expanded);
      const hash = createHash('sha256').update(node.name).digest('hex').slice(0, 12);
      item.id = `aifg:feature:${node.root}:${node.phase}:${hash}`;
      item.contextValue = node.phase === 'work' ? 'aifgWorkFeature' : 'aifgIndexFeature';
      item.description = String(node.changes.length);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = `${node.name}\n${path.basename(node.root)}\n${node.changes.length} files`;
      return item;
    }
    if (node.kind === 'file') {
      const change = node.change;
      const item = new vscode.TreeItem(path.basename(change.path), COLLAPSE.None);
      item.id = `aifg:file:${node.root}:${node.phase}:${change.path}`;
      item.contextValue = node.phase === 'work' ? 'aifgWorkFile' : 'aifgIndexFile';
      // The label is the basename. Keep subfolder and status visible beside it.
      const directory = path.posix.dirname(change.path.replace(/\\/g, '/'));
      const status = change.untracked ? 'U' : change.deleted ? 'D' : change.xy.includes('A') ? 'A' :
        change.xy.includes('R') ? 'R' : 'M';
      item.description = `${status}${directory === '.' ? '' : `  ${directory}`}`;
      item.tooltip = `${change.path}\n${node.phase === 'work' ? 'Unstaged (Index → Working Tree)' : 'Staged (HEAD → Index)'}\n${node.root}`;
      item.iconPath = new vscode.ThemeIcon(change.untracked || status === 'A' ? 'diff-added' :
        change.deleted ? 'diff-removed' : status === 'R' ? 'diff-renamed' : 'diff-modified');
      item.command = { command: 'aiFeatureGroups.openDiff', title: 'Open Git Diff', arguments: [node] };
      return item;
    }
    throw new Error(`Unknown feature tree node: ${node.kind}`);
  }

  /** Commands use real repository roots/files, never virtual display paths. */
  selectedFiles(clickedNode, phase) {
    if (!clickedNode || clickedNode.kind !== 'file') return [];
    const selection = this.view.selection;
    const nodes = selection?.includes(clickedNode) ? selection : [clickedNode];
    return nodes.filter(node => node.kind === 'file' && (!phase || node.phase === phase));
  }

  async selectFeature(phase = 'work') {
    const items = [];
    for (const repo of this.dirtyRepositories()) {
      const changes = this.phaseChanges(repo, phase);
      for (const name of this.featureNames(repo.root, changes)) {
        const matches = changes.filter(change => this.controller.nameFor(repo.root, change) === name);
        items.push({
          label: name,
          description: `${path.basename(repo.root)} · ${matches.length} file(s)`,
          detail: repo.root,
          value: { kind: 'feature', root: repo.root, name, phase, changes: matches }
        });
      }
    }
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Select a feature' });
    return choice?.value;
  }

  dispose() {
    this.subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}

module.exports = { FeatureTree, VIEW_ID };
