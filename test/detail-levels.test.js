'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makePrompt, parseDetailedAssignments, applyDiffBudget, cleanDetail,
  FALLBACK_COMPONENT, FALLBACK_TASK
} = require('../src/classifier');
const { sectionFor, resolveActionNode } = require('../src/view-model');

const root = '/workspace/hywater-portal-frontend';
const patches = [
  { path: 'src/export/api.ts', group: 'feat: Asynchronous data exports', component: 'Export API', task: 'Start export requests' },
  { path: 'src/export/validator.ts', group: 'feat: Asynchronous data exports', component: 'Export API', task: 'Validate requests' },
  { path: 'src/jobs/worker.ts', group: 'feat: Asynchronous data exports', component: 'Background processing', task: 'Run export jobs' },
  { path: 'src/jobs/worker.test.ts', group: 'feat: Asynchronous data exports', component: 'Background processing', task: 'Run export jobs' },
  { path: 'src/bugfix.ts', group: 'fix: Season validation', component: 'Validation', task: 'Reject invalid dates' }
];
const repo = { root, changes: patches.map(change => ({
  path: change.path, staged: false, unstaged: true, xy: ' M', untracked: false
})) };
const controller = {
  repositories: [repo],
  detailFor(_, change) { return patches.find(record => record.path === change.path); },
  nameFor(_, change) { return patches.find(record => record.path === change.path).group; }
};

test('a single AI response provides semantic feature/component/task for each file', () => {
  const prompt = makePrompt([{
    path: 'src/export/api.ts', status: ' M', diff: '+ startExportRequest()'
  }], ['feat: Asynchronous data exports'], [patches[2]]);
  assert.match(prompt, /LEVEL 1:/);
  assert.match(prompt, /LEVEL 2:/);
  assert.match(prompt, /LEVEL 3:/);
  assert.match(prompt, /UNTRUSTED DATA/);
  assert.match(prompt, /Background processing/);
  const parsed = parseDetailedAssignments(JSON.stringify({ assignments: [
    patches[0], patches[1], { ...patches[2], task: '' },
    { path: '../../.env', group: 'feat: Fake', component: 'Secrets', task: 'Leak' }
  ] }), patches.map(item => item.path));
  assert.equal(parsed.size, 3);
  assert.deepEqual(parsed.get(patches[0].path), {
    group: patches[0].group, component: 'Export API', task: 'Start export requests'
  });
  assert.equal(parsed.get(patches[2].path).task, FALLBACK_TASK);
  assert.equal(cleanDetail('\n ', FALLBACK_COMPONENT), FALLBACK_COMPONENT);
});

test('one global diff budget limits 50 files while retaining every file in classification', () => {
  const large = Array.from({ length: 50 }, (_, index) => ({
    path: `src/${index}.ts`, diff: 'A'.repeat(3200), status: ' M', hash: String(index)
  }));
  const output = applyDiffBudget(large, 40000);
  assert.equal(output.length, 50);
  assert.ok(output.reduce((sum, item) => sum + item.diff.length, 0) <= 40000);
  assert.ok(output.every(item => item.diff.includes('TRUNCATED')));
  assert.deepEqual(large[0].diff, 'A'.repeat(3200), 'source diff remains unchanged for cache hashing');
});

test('nested model groups files by semantic responsibility rather than path or extension', () => {
  const section = sectionFor(controller, repo, 'work');
  assert.equal(section.count, 5);
  const exportGroup = section.groups.find(group => group.name === 'feat: Asynchronous data exports');
  assert.equal(exportGroup.files.length, 4);
  assert.deepEqual(exportGroup.components.map(item => item.name), ['Background processing', 'Export API']);
  const background = exportGroup.components[0];
  assert.deepEqual(background.tasks.map(item => item.name), ['Run export jobs']);
  assert.deepEqual(background.tasks[0].files.map(item => item.path), [
    'src/jobs/worker.ts', 'src/jobs/worker.test.ts'
  ]);
});

test('scoped component/task actions cannot accidentally stage another feature or repository', () => {
  const component = resolveActionNode(controller, {
    kind: 'component', root, phase: 'work', group: 'feat: Asynchronous data exports', name: 'Export API'
  });
  assert.deepEqual(component.changes.map(item => item.path), [
    'src/export/api.ts', 'src/export/validator.ts'
  ]);
  const task = resolveActionNode(controller, {
    kind: 'task', root, phase: 'work', group: 'feat: Asynchronous data exports', component: 'Background processing',
    name: 'Run export jobs'
  });
  assert.equal(task.changes.length, 2);
  assert.equal(resolveActionNode(controller, {
    kind: 'task', root, phase: 'work', group: 'fix: Season validation',
    component: 'Background processing', name: 'Run export jobs'
  }), null);
  assert.equal(resolveActionNode(controller, {
    kind: 'component', root: '/workspace/another-repo', phase: 'work',
    group: 'feat: Asynchronous data exports', name: 'Export API'
  }), null);
});
