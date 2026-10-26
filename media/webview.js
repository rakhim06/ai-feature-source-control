/* global acquireVsCodeApi */
'use strict';

(() => {
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const repositories = $('repositories');
  const status = $('status');
  const contextMenu = $('context-menu');
  const saved = api.getState() || {};
  const collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
  const expandedRepos = new Map(Array.isArray(saved.expandedRepos) ? saved.expandedRepos : []);
  let detailLevel = 1; // Controlled exclusively by VS Code Settings.
  const cards = new Map();
  const commitBusy = new Set();
  const messageTimers = new Map();
  let model = null;
  let version = -1;

  const icons = {
    branch: '<circle cx="6" cy="3" r="2"/><circle cx="6" cy="17" r="2"/><circle cx="16" cy="6" r="2"/><path d="M6 5v10M16 8a8 8 0 0 1-8 8"/>',
    folder: '<path d="M2 5h7l2 2h9v12H2z"/>',
    file: '<path d="M5 2h8l5 5v15H5zM13 2v6h5"/>',
    repo: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    add: '<path d="M12 4v16M4 12h16"/>',
    // Open a working-tree file in a normal editor tab (not the Git diff).
    openFile: '<path d="M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M12 3v5h5"/><path d="M13 13l8-8m-5 0h5v5"/>',
    // Counterclockwise back-arrow, matching the native SCM Discard action.
    discard: '<path d="M3 11a9 9 0 1 1 2.4 6.2"/><path d="M3 4v7h7"/>',
    remove: '<path d="M4 12h16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    sync: '<path d="M4 7a8 8 0 0 1 14-2l2 2M20 17a8 8 0 0 1-14 2l-2-2"/><path d="M20 3v4h-4M4 21v-4h4"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    fetch: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3v5h-5"/>',
    push: '<path d="M12 20V4m0 0-5 5m5-5 5 5"/><path d="M4 16v4h16v-4"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    // Two sparkle glyphs, mirroring the double-star Git commit composer action.
    sparkles: '<path d="M9.5 2l1.9 5.6L17 9.5l-5.6 1.9-1.9 5.6-1.9-5.6L2 9.5l5.6-1.9z"/><path d="M18.5 14l1.1 3.4L23 18.5l-3.4 1.1-1.1 3.4-1.1-3.4-3.4-1.1 3.4-1.1z"/>',
    publish: '<path d="M6 18a4 4 0 0 1-1-7.9 7 7 0 0 1 13.8-.3A4 4 0 1 1 19 18"/><path d="M12 20V9m-4 4 4-4 4 4"/>'
  };
  // Only literal SVG templates are inserted as HTML. User and AI content
  // reaches the DOM exclusively through textContent and title attributes.
  function svg(name) {
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
    return span.firstElementChild;
  }
  function element(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = String(label);
    return node;
  }
  function send(type, data = {}) { api.postMessage({ type, ...data }); }
  function keyFor(node) { return [node.root, node.phase, node.kind, node.group || '', node.component || '', node.name || ''].join('\u0000'); }
  function persist() { api.setState({ collapsed: [...collapsed], expandedRepos: [...expandedRepos] }); }
  function defaultExpanded(repo) {
    // A clean, untracked branch still needs its Publish button after commit.
    return Boolean(repo.dirty || repo.ahead || repo.behind || repo.primaryAction === 'publish');
  }
  function toggle(key, root) {
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    persist();
    renderSections(root);
  }
  function action(name, node) { closeMenu(); send('action', { root: node.root, action: name, node }); }
  function actionButton(icon, tooltip, callback, className = 'action', ariaLabel = tooltip) {
    const button = element('button', className);
    button.type = 'button';
    button.title = tooltip;
    button.setAttribute('aria-label', ariaLabel);
    button.append(svg(icon));
    button.addEventListener('click', event => { event.stopPropagation(); callback(); });
    return button;
  }
  function rowWithActions(node, className, label, count, iconName, actions, opts = {}) {
    const row = element('div', `row ${className}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'treeitem');
    row.title = opts.title || label;
    const expandable = Boolean(opts.expandable);
    const key = keyFor(node);
    const closed = collapsed.has(key);
    if (expandable) {
      // Larger, explicit disclosure chevron. Unlike the old tiny glyph, this
      // is an independently focusable/clickable control with a 22px target.
      const disclosure = element('button', 'tree-chevron', closed ? '▸' : '▾');
      disclosure.type = 'button';
      disclosure.title = closed ? 'Expand' : 'Collapse';
      disclosure.setAttribute('aria-label', `${closed ? 'Expand' : 'Collapse'} ${label}`);
      disclosure.setAttribute('aria-expanded', String(!closed));
      disclosure.addEventListener('click', event => {
        event.stopPropagation();
        toggle(key, node.root);
      });
      row.append(disclosure);
      row.setAttribute('aria-expanded', String(!closed));
    } else {
      row.append(element('span', 'tree-chevron-spacer'));
    }
    if (iconName === 'status') row.append(element('span', `status-icon ${opts.status}`, opts.status));
    else row.append(svg(iconName));
    row.append(element('span', 'text', label));
    if (opts.detail) row.append(element('span', 'detail', opts.detail));
    if (count !== null && count !== undefined) row.append(element('span', 'count', count));
    const buttons = element('span', 'actions');
    for (const entry of actions) {
      const label = entry.action === 'stage' ? 'Stage' : entry.action === 'unstage' ? 'Unstage' : entry.label;
      buttons.append(actionButton(entry.icon, label, () => action(entry.action, node), 'action',
        entry.action === 'openFile' ? 'Open File' : entry.label));
    }
    if (opts.hasMore) buttons.append(actionButton('more', 'More', () => showMenuFor(node, row), 'action', 'More actions'));
    row.append(buttons);
    const activate = () => { if (expandable) toggle(key, node.root); else action('diff', node); };
    row.addEventListener('click', event => { if (!event.target.closest('button')) activate(); });
    row.addEventListener('keydown', event => {
      if (event.target !== row) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      else if (expandable && event.key === 'ArrowLeft' && !collapsed.has(key)) { event.preventDefault(); toggle(key, node.root); }
      else if (expandable && event.key === 'ArrowRight' && collapsed.has(key)) { event.preventDefault(); toggle(key, node.root); }
    });
    row.addEventListener('contextmenu', event => { event.preventDefault(); showMenuFor(node, row, event); });
    return { row, closed };
  }

  function showMenuFor(node, row, mouseEvent) {
    const options = [[node.phase === 'work' ? 'Stage' : 'Unstage', node.phase === 'work' ? 'stage' : 'unstage']];
    if (node.phase === 'work' && ['file', 'section'].includes(node.kind)) {
      options.unshift([node.kind === 'file' ? 'Revert File Changes' : 'Revert All Changes', 'discard']);
    }
    if (node.kind === 'file') options.push(['Open File', 'openFile'], ['Open Changes', 'diff'],
      ['Move to Feature...', 'move'], ['Move to Component...', 'moveComponent'],
      ['Move to Task...', 'moveTask'], ['Reset Classification', 'reset']);
    if (node.kind === 'feature') options.push(['Use Feature Name as Commit Message', 'useMessage']);
    contextMenu.replaceChildren();
    for (const [label, type] of options) {
      const button = element('button', '', label);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.addEventListener('click', () => action(type, node));
      contextMenu.append(button);
    }
    contextMenu.hidden = false;
    const rect = row.getBoundingClientRect();
    const x = mouseEvent ? mouseEvent.clientX : rect.left + 30;
    const y = mouseEvent ? mouseEvent.clientY : rect.bottom;
    contextMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - 185))}px`;
    contextMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - contextMenu.offsetHeight - 4))}px`;
    contextMenu.querySelector('button')?.focus();
  }
  function closeMenu() { contextMenu.hidden = true; }
  document.addEventListener('click', event => { if (!contextMenu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);

  function flushMessage(root) {
    clearTimeout(messageTimers.get(root));
    messageTimers.delete(root);
    const card = cards.get(root);
    if (card) send('setMessage', { root, value: card.messageBox.value });
  }
  function busy(repo) {
    return commitBusy.has(repo.root) || repo.committing || repo.syncing || repo.fetching || repo.pushing || repo.publishing || repo.switching;
  }
  function updateCommitButton(repo) {
    const card = cards.get(repo.root);
    if (!card) return;
    const choice = repo.primaryAction || 'commit';
    const actionName = { commit: 'Commit', publish: 'Publish Branch', push: 'Push', sync: 'Sync Changes' }[choice] || 'Commit';
    card.commitButton.replaceChildren(svg({
      commit: 'check', publish: 'publish', push: 'push', sync: 'sync'
    }[choice] || 'check'), document.createTextNode(actionName));
    card.commitButton.dataset.action = choice;
    // Keep the tooltip to a single word; the accessible label carries detail.
    card.commitButton.title = { commit: 'Commit', publish: 'Publish', push: 'Push', sync: 'Sync' }[choice] || 'Commit';
    card.commitButton.setAttribute('aria-label', choice === 'commit' ? 'Commit staged changes (Cmd/Ctrl + Enter)' :
      choice === 'publish' ? `Publish ${repo.branch} and set its upstream` :
      choice === 'push' ? `Push ${repo.branch}` : `Sync ${repo.branch}`);
    card.commitButton.disabled = busy(repo) || (choice === 'commit' && (!repo.staged || !card.messageBox.value.trim()));
  }
  function commit(root) {
    const card = cards.get(root);
    const repo = model?.repositories.find(item => item.root === root);
    if (!card || !repo || busy(repo) || !repo.staged || !card.messageBox.value.trim()) return;
    commitBusy.add(root);
    card.messageBox.disabled = true;
    updateCommitButton(repo);
    flushMessage(root);
    send('commit', { root, message: card.messageBox.value });
  }
  function primaryAction(root) {
    const repo = model?.repositories.find(item => item.root === root);
    if (!repo || busy(repo)) return;
    const choice = repo.primaryAction;
    if (choice === 'commit') return commit(root);
    if (['publish', 'push', 'sync'].includes(choice)) return send(choice, { root });
  }

  function resizeMessage(box) {
    box.style.height = 'auto';
    box.style.height = `${Math.max(28, Math.min(box.scrollHeight, 146))}px`;
    box.style.overflowY = box.scrollHeight > 146 ? 'auto' : 'hidden';
  }

  function createCard(root) {
    const card = element('section', 'repository');
    card.dataset.root = root;
    const header = element('header', 'repository-header');
    const toggleButton = element('button', 'repo-toggle');
    toggleButton.type = 'button';
    const twist = element('span', 'repo-chevron', '▾');
    const repoIcon = svg('repo');
    const title = element('span', 'repo-name');
    toggleButton.append(twist, repoIcon, title);
    toggleButton.addEventListener('click', () => {
      const repo = model?.repositories.find(item => item.root === root);
      if (!repo) return;
      const currentlyExpanded = expandedRepos.has(root) ? expandedRepos.get(root) : defaultExpanded(repo);
      expandedRepos.set(root, !currentlyExpanded);
      persist();
      updateCard(repo);
    });
    const branchButton = element('button', 'branch-button');
    branchButton.type = 'button';
    branchButton.append(svg('branch'));
    const branchName = element('span', 'branch-name');
    branchButton.append(branchName);
    branchButton.addEventListener('click', () => send('switchBranch', { root }));
    const syncButton = actionButton('sync', 'Sync', () => send('sync', { root }), 'action repo-action sync-action', 'Pull then push this branch');
    const syncCounts = element('span', 'sync-counts');
    const classifyButton = actionButton('sparkles', 'Classify', () => {
      const repo = model?.repositories.find(item => item.root === root);
      send(repo?.classifying ? 'cancelClassification' : 'classify', { root });
    },
      'action repo-action classify-action', 'Classify changes in this repository only');
    const fetchButton = actionButton('fetch', 'Fetch', () => send('fetch', { root }), 'action repo-action fetch-action', 'Fetch remote changes');
    header.append(toggleButton, branchButton, syncButton, classifyButton, fetchButton);

    const body = element('div', 'repository-body');
    const commitArea = element('div', 'commit-area');
    const inputWrap = element('div', 'commit-input-wrap');
    const messageBox = element('textarea', 'commit-message');
    messageBox.rows = 1;
    messageBox.spellcheck = true;
    messageBox.placeholder = 'Message (⌘ Enter to commit)';
    messageBox.setAttribute('aria-label', 'Commit message');
    messageBox.addEventListener('input', () => {
      resizeMessage(messageBox);
      const repo = model?.repositories.find(item => item.root === root);
      if (repo) updateCommitButton(repo);
      clearTimeout(messageTimers.get(root));
      messageTimers.set(root, setTimeout(() => flushMessage(root), 120));
    });
    messageBox.addEventListener('blur', () => flushMessage(root));
    messageBox.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(root); }
    });
    const generateButton = actionButton('sparkles', 'Generate', () => {
      flushMessage(root);
      send('generateMessage', { root, originalMessage: messageBox.value });
    }, 'action generate-message', 'Generate commit message with selected AI provider');
    inputWrap.append(messageBox, generateButton);
    requestAnimationFrame(() => resizeMessage(messageBox));
    const actions = element('div', 'commit-actions');
    const commitButton = element('button', 'primary', 'Commit');
    commitButton.type = 'button';
    commitButton.title = 'Commit';
    commitButton.addEventListener('click', () => primaryAction(root));
    actions.append(commitButton);
    commitArea.append(inputWrap, actions);
    const tree = element('div', 'sections');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Staged and unstaged changes by feature');
    body.append(commitArea, tree);
    card.append(header, body);
    const view = { card, body, twist, toggleButton, title, branchButton, branchName,
      fetchButton, syncButton, syncCounts, classifyButton, messageBox, generateButton, commitButton, tree };
    cards.set(root, view);
    return view;
  }

  function appendFile(wrapper, root, phase, file, depth) {
    const fileNode = { kind: 'file', root, phase, path: file.path };
    const { row: fileRow } = rowWithActions(fileNode, `file-row depth-${depth}`, file.name, null, 'status', [
      { icon: 'openFile', label: 'Open', action: 'openFile' },
      ...(phase === 'work' ? [{ icon: 'discard', label: 'Revert', action: 'discard' }] : []),
      { icon: phase === 'work' ? 'add' : 'remove', label: phase === 'work' ? 'Stage file' : 'Unstage file', action: phase === 'work' ? 'stage' : 'unstage' }
    ], { status: file.status, detail: file.directory, hasMore: true,
      title: `${file.path} (${phase === 'work' ? 'unstaged' : 'staged'})` });
    wrapper.append(fileRow);
  }

  function appendDetailRow(wrapper, node, label, level) {
    const phase = node.phase;
    const { row, closed } = rowWithActions(node, `${node.kind}-row`, label, null,
      'folder', [{ icon: phase === 'work' ? 'add' : 'remove',
        label: phase === 'work' ? `Stage ${node.kind}` : `Unstage ${node.kind}`,
        action: phase === 'work' ? 'stage' : 'unstage' }],
      { expandable: true, hasMore: true, title: `Level ${level}: ${label}` });
    wrapper.append(row);
    return !closed;
  }

  function renderSections(root) {
    const repo = model?.repositories.find(item => item.root === root);
    const card = cards.get(root);
    if (!repo || !card) return;
    card.tree.replaceChildren();
    // Staged Changes comes first; completely hide empty sections.
    for (const section of repo.sections) {
      if (!section.groups.length) continue;
      const phase = section.phase;
      const wrapper = element('section', 'section');
      const sectionNode = { kind: 'section', root, phase };
      const { row: sectionRow, closed } = rowWithActions(sectionNode, 'section-row', section.label, null,
        'folder', [...(phase === 'work' ? [{ icon: 'discard', label: 'Revert', action: 'discard' }] : []),
          { icon: phase === 'work' ? 'add' : 'remove',
          label: phase === 'work' ? 'Stage all changes' : 'Unstage all',
          action: phase === 'work' ? 'stage' : 'unstage' }],
        { expandable: true });
      wrapper.append(sectionRow);
      if (!closed) {
        for (const group of section.groups) {
          const featureNode = { kind: 'feature', root, phase, name: group.name };
          if (!appendDetailRow(wrapper, featureNode, group.name, 1)) continue;
          if (detailLevel === 1) {
            for (const file of group.files) appendFile(wrapper, root, phase, file, 1);
            continue;
          }
          // Avoid meaningless one-child hierarchy levels when the model was
          // uncertain. Manual/user-assigned meaningful components remain visible.
          if (group.components.length === 1 && group.components[0].name === 'General') {
            for (const file of group.files) appendFile(wrapper, root, phase, file, 1);
            continue;
          }
          for (const component of group.components) {
            const componentNode = { kind: 'component', root, phase, group: group.name, name: component.name };
            if (!appendDetailRow(wrapper, componentNode, component.name, 2)) continue;
            if (detailLevel === 2) {
              for (const file of component.files) appendFile(wrapper, root, phase, file, 2);
              continue;
            }
            if (component.tasks.length === 1 && component.tasks[0].name === 'Other changes') {
              for (const file of component.files) appendFile(wrapper, root, phase, file, 2);
              continue;
            }
            for (const task of component.tasks) {
              const taskNode = { kind: 'task', root, phase, group: group.name,
                component: component.name, name: task.name };
              if (!appendDetailRow(wrapper, taskNode, task.name, 3)) continue;
              for (const file of task.files) appendFile(wrapper, root, phase, file, 3);
            }
          }
        }
      }
      card.tree.append(wrapper);
    }
  }

  function updateCard(repo) {
    const card = cards.get(repo.root) || createCard(repo.root);
    card.title.textContent = repo.name;
    card.title.title = repo.root;
    const expanded = expandedRepos.has(repo.root) ? expandedRepos.get(repo.root) : defaultExpanded(repo);
    card.body.hidden = !expanded;
    card.twist.textContent = expanded ? '▾' : '▸';
    card.toggleButton.setAttribute('aria-expanded', String(expanded));
    card.toggleButton.title = expanded ? 'Collapse' : 'Expand';
    card.toggleButton.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${repo.name}`);
    card.branchName.textContent = repo.branch || 'No branch';
    card.branchButton.title = 'Branch';
    card.branchButton.setAttribute('aria-label', repo.upstream ?
      `Switch branch: ${repo.branch} (tracks ${repo.upstream})` :
      `Switch branch: ${repo.branch || 'No branch'}`);
    card.branchButton.disabled = busy(repo) || Boolean(repo.generating) || !repo.hasCommit;
    const working = busy(repo);
    card.fetchButton.disabled = working;
    card.classifyButton.disabled = !repo.classifying && !repo.dirty;
    card.classifyButton.classList.toggle('is-busy', Boolean(repo.classifying));
    card.classifyButton.title = repo.classifying ? 'Cancel' : 'Classify';
    card.classifyButton.setAttribute('aria-label', repo.classifying ? `Cancel classification of ${repo.name}` :
      `Classify changes in ${repo.name} with the selected AI`);
    card.classifyButton.replaceChildren(svg(repo.classifying ? 'stop' : 'sparkles'));
    card.fetchButton.classList.toggle('is-busy', Boolean(repo.fetching));
    card.syncButton.disabled = working || !repo.upstream;
    card.syncButton.classList.toggle('is-busy', Boolean(repo.syncing));
    card.syncCounts.replaceChildren();
    if (repo.upstream) {
      // Show "4 ↓  0 ↑" including zero values, with the number BEFORE each arrow.
      // Counts reflect the last fetched upstream, not necessarily the live remote.
      card.syncCounts.append(
        element('span', 'behind', `${repo.behind ?? '?'} ↓`),
        element('span', 'ahead', `${repo.ahead ?? '?'} ↑`)
      );
      card.syncButton.replaceChildren(card.syncCounts);
      card.syncButton.title = 'Sync';
      card.syncButton.setAttribute('aria-label',
        `Sync ${repo.name}: ${repo.behind ?? '?'} incoming, ${repo.ahead ?? '?'} outgoing`);
    } else {
      // No upstream means unknown ahead/behind, NOT zero.
      card.syncButton.replaceChildren(svg('sync'));
      card.syncButton.title = 'Sync';
      card.syncButton.setAttribute('aria-label', 'Publish branch to enable sync');
    }
    card.fetchButton.title = 'Fetch';
    card.fetchButton.setAttribute('aria-label', `Fetch ${repo.name} to refresh remote counts`);
    // Keep an actively edited textarea intact during Git refreshes and while
    // another repository is being committed or synchronized.
    if (document.activeElement !== card.messageBox && !messageTimers.has(repo.root) && !commitBusy.has(repo.root)) {
      card.messageBox.value = repo.message || '';
      resizeMessage(card.messageBox);
    }
    card.messageBox.disabled = commitBusy.has(repo.root) || Boolean(repo.committing);
    card.generateButton.disabled = working || Boolean(repo.generating) || !repo.staged;
    card.generateButton.classList.toggle('is-busy', Boolean(repo.generating));
    const provider = model?.aiProvider === 'codex' ? 'Codex' : 'GitHub Copilot';
    card.generateButton.title = 'Generate';
    card.generateButton.setAttribute('aria-label', repo.generating ? `Generating with ${provider}` :
      repo.staged ? `Generate commit message with ${provider} from staged changes` :
      'Stage files first to generate a commit message');
    updateCommitButton(repo);
    renderSections(repo.root);
  }

  function render(next) {
    if (!next) return;
    model = next;
    detailLevel = [1, 2, 3].includes(model.detailLevel) ? model.detailLevel : 1;
    const active = model.repositories.find(repo => repo.root === model.classifyingRoot);
    status.textContent = active ? `Classifying ${active.name}…` : '';
    if (model.repositories.length === 0) {
      repositories.replaceChildren(element('p', 'empty', 'No Git repositories found.'));
      cards.clear();
      return;
    }
    // Reuse each repository's DOM node so Git status events NEVER destroy a
    // focused commit textarea or mix messages between repositories.
    model.repositories.forEach((repo, index) => {
      const card = cards.get(repo.root) || createCard(repo.root);
      const atPosition = repositories.children[index];
      if (atPosition !== card.card) repositories.insertBefore(card.card, atPosition || null);
      updateCard(repo);
    });
    const activeRoots = new Set(model.repositories.map(repo => repo.root));
    for (const [root, card] of cards) {
      if (activeRoots.has(root)) continue;
      clearTimeout(messageTimers.get(root));
      messageTimers.delete(root);
      card.card.remove();
      cards.delete(root);
      commitBusy.delete(root);
    }
    // Removes the placeholder used when the Git API had no repositories.
    for (const child of [...repositories.children]) {
      if (!child.dataset.root) child.remove();
    }
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type === 'inputUpdated') {
      const card = cards.get(data.root);
      const repo = model?.repositories.find(item => item.root === data.root);
      if (card && repo && typeof data.value === 'string') {
        card.messageBox.value = data.value;
        resizeMessage(card.messageBox);
        updateCommitButton(repo);
      }
      return;
    }
    if (data?.type === 'generatedMessage') {
      const card = cards.get(data.root);
      const repo = model?.repositories.find(item => item.root === data.root);
      if (card && repo && typeof data.message === 'string') {
        // Preserve the user's edits if they typed while the AI was running.
        if (card.messageBox.value === data.originalMessage) {
          card.messageBox.value = data.message;
          card.messageBox.focus(); // Prevent stale Git view updates from replacing the suggestion.
          resizeMessage(card.messageBox);
          flushMessage(data.root);
          updateCommitButton(repo);
        } else {
          status.textContent = `Commit message for ${repo.name} was not replaced because you edited it during generation.`;
        }
      }
      return;
    }
    if (data?.type === 'commitResult') {
      const card = cards.get(data.root);
      commitBusy.delete(data.root);
      if (card) {
        if (data.success) { card.messageBox.value = ''; resizeMessage(card.messageBox); }
        card.messageBox.disabled = false;
      }
      if (model) render(model);
      return;
    }
    if (!data || data.type !== 'update' || typeof data.version !== 'number') return;
    if (data.version <= version) return;
    version = data.version;
    render(data.model);
  });
  send('ready');
})();
