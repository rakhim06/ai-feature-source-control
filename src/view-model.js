'use strict';

const path = require('node:path');
const { FALLBACK_GROUP, EXCLUDED_GROUP } = require('./classifier');

function groupRank(name) {
  return name === EXCLUDED_GROUP ? 2 : name === FALLBACK_GROUP ? 1 : 0;
}

function statusFor(change, phase) {
  if (change.conflicted) return '!';
  if (phase === 'work' && change.untracked) return 'U';
  const code = phase === 'index' ? change.xy[0] : change.xy[1];
  return ['M', 'A', 'D', 'R', 'C', 'U'].includes(code) ? code : 'M';
}

function sectionFor(controller, repository, phase) {
  const changes = repository.changes.filter(change => phase === 'work' ? change.unstaged : change.staged);
  const groups = new Map();
  for (const change of changes) {
    const { group, component, task } = controller.detailFor(repository.root, change);
    if (!groups.has(group)) groups.set(group, { files: [], components: new Map() });
    const entry = groups.get(group);
    const normalized = change.path.replace(/\\/g, '/');
    const directory = path.posix.dirname(normalized);
    const file = {
      path: change.path,
      name: path.posix.basename(normalized),
      directory: directory === '.' ? '' : directory,
      status: statusFor(change, phase),
      conflicted: change.conflicted
    };
    entry.files.push(file);
    if (!entry.components.has(component)) entry.components.set(component, { files: [], tasks: new Map() });
    const componentEntry = entry.components.get(component);
    componentEntry.files.push(file);
    if (!componentEntry.tasks.has(task)) componentEntry.tasks.set(task, []);
    componentEntry.tasks.get(task).push(file);
  }
  return {
    phase,
    label: phase === 'work' ? 'Changes' : 'Staged Changes',
    count: changes.length,
    groups: [...groups].sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
      .map(([name, entry]) => ({
        name, count: entry.files.length, files: entry.files,
        components: [...entry.components].sort(([a], [b]) => a.localeCompare(b))
          .map(([componentName, componentEntry]) => ({
            name: componentName, count: componentEntry.files.length, files: componentEntry.files,
            tasks: [...componentEntry.tasks].sort(([a], [b]) => a.localeCompare(b))
              .map(([taskName, taskFiles]) => ({ name: taskName, count: taskFiles.length, files: taskFiles }))
          }))
      }))
  };
}

function findGitRepository(controller, root) {
  return controller.api?.repositories?.find(repo => repo.rootUri.scheme === 'file' && repo.rootUri.fsPath === root);
}

/** Match Git's primary action after a commit, without losing the staging UI.
 * A branch cannot be published before its first commit. An upstream must be
 * present to push or sync. Incoming commits take precedence over outgoing ones.
 */
function primaryActionFor({ staged, upstream, ahead, behind, branch, hasCommit }) {
  if (staged > 0) return 'commit';
  if (branch && hasCommit && !upstream) return 'publish';
  if (upstream && behind > 0) return 'sync';
  if (upstream && ahead > 0) return 'push';
  return 'commit';
}

/** One native Git repo is rendered as one independent, expandable commit panel. */
function repositoryViewModel(controller, repository, inProgress) {
  const native = findGitRepository(controller, repository.root);
  const head = native?.state?.HEAD;
  // The Git extension's ahead/behind counters are relative to the last fetched
  // upstream. Never make network calls while rendering or invent remote counts.
  const upstream = head?.upstream?.remote && head.upstream.remote !== '.' ? head.upstream : undefined;
  const branch = repository.branch || head?.name || '';
  const publishableBranch = Boolean(head?.name) && head.type !== 2 ? head.name : '';
  const hasCommit = Boolean(head?.commit);
  const ahead = upstream && Number.isInteger(head.ahead) ? Math.max(0, head.ahead) : null;
  const behind = upstream && Number.isInteger(head.behind) ? Math.max(0, head.behind) : null;
  const sections = [sectionFor(controller, repository, 'index'), sectionFor(controller, repository, 'work')];
  return {
    root: repository.root,
    name: path.basename(repository.root),
    branch,
    hasCommit,
    primaryAction: primaryActionFor({ staged: sections[0].count, upstream, ahead, behind, branch: publishableBranch, hasCommit }),
    message: native?.inputBox?.value || '',
    dirty: repository.changes.length,
    staged: sections[0].count,
    ahead,
    behind,
    upstream: upstream ? `${upstream.remote}/${upstream.name}` : null,
    syncing: Boolean(inProgress?.syncing?.has(repository.root)),
    fetching: Boolean(inProgress?.fetching?.has(repository.root)),
    pushing: Boolean(inProgress?.pushing?.has(repository.root)),
    publishing: Boolean(inProgress?.publishing?.has(repository.root)),
    committing: Boolean(inProgress?.committing?.has(repository.root)),
    generating: Boolean(inProgress?.generating?.has(repository.root)),
    switching: Boolean(inProgress?.switching?.has(repository.root)),
    classifying: controller.classifyingRoot === repository.root,
    sections
  };
}

function buildViewModel(controller, inProgress = {}) {
  return {
    classifying: Boolean(controller.classifying),
    aiProvider: controller.config().get('provider', 'copilot'),
    detailLevel: controller.config().get('detailLevel', 1),
    classifyingRoot: controller.classifyingRoot,
    // Do not filter clean repositories: they can still have outgoing commits.
    // Each repo has its own commit text, sync controls and staged files.
    repositories: controller.repositories.map(repo => repositoryViewModel(controller, repo, inProgress))
  };
}

/** Never trust paths, feature names or repository names supplied by a Webview. */
function resolveActionNode(controller, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { root, phase, kind } = payload;
  if (typeof root !== 'string' || !['work', 'index'].includes(phase)) return null;
  const repo = controller.repositories.find(item => item.root === root);
  if (!repo) return null;
  const changes = repo.changes.filter(change => phase === 'work' ? change.unstaged : change.staged);
  if (kind === 'section') return { kind, root, phase, changes };
  if (kind === 'feature' && typeof payload.name === 'string') {
    const members = changes.filter(change => controller.nameFor(root, change) === payload.name);
    return members.length ? { kind, root, phase, name: payload.name, changes: members } : null;
  }
  if (kind === 'component' && typeof payload.name === 'string' && typeof payload.group === 'string') {
    const members = changes.filter(change => {
      const detail = controller.detailFor(root, change);
      return detail.group === payload.group && detail.component === payload.name;
    });
    return members.length ? { kind, root, phase, name: payload.name, group: payload.group, changes: members } : null;
  }
  if (kind === 'task' && typeof payload.name === 'string' && typeof payload.group === 'string' &&
      typeof payload.component === 'string') {
    const members = changes.filter(change => {
      const detail = controller.detailFor(root, change);
      return detail.group === payload.group && detail.component === payload.component && detail.task === payload.name;
    });
    return members.length ? { kind, root, phase, name: payload.name, group: payload.group,
      component: payload.component, changes: members } : null;
  }
  if (kind === 'file' && typeof payload.path === 'string') {
    const change = changes.find(item => item.path === payload.path);
    return change ? { kind, root, phase, change } : null;
  }
  return null;
}

module.exports = { buildViewModel, resolveActionNode, findGitRepository, statusFor, sectionFor, primaryActionFor };
