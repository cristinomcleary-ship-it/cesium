import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let temporary, ManagementStudio, ManagementWorkspace;
before(async () => {
  temporary = await mkdtemp(`${process.cwd()}/.function-center-management-`);
  await build({ stdin: { contents: 'export { ManagementStudio } from "./src/managementStudio.ts"; export { ManagementWorkspace } from "./src/managementWorkspace.ts";', resolveDir: process.cwd(), loader: 'ts' },
    outfile: `${temporary}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  ({ ManagementStudio, ManagementWorkspace } = await import(pathToFileURL(`${temporary}/fixture.mjs`).href));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function studioFixture({ blocked = false, dirty = false } = {}) {
  const calls = [], nodes = new Map();
  const owner = Object.assign(Object.create(ManagementStudio.prototype), {
    navigationRevision: 0, module: 'overview', view: 'management', tabs: {}, scrolls: new Map(),
    projectId: 'safety:project', selection: { kind: 'resources', id: 'machine-a' },
    root: { dataset: {} }, options: { onBeforeNavigate: () => !blocked, onViewMode: () => true },
    fieldOperations: { close() {} }, planImporter: { close() {} }, canChangeFieldContext: () => true,
    draft: dirty ? { values: { name: 'new' }, initial: '{"name":"old"}', files: new Map(), busy: false } : undefined,
    ref(selector) { if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', scrollTop: 21 }); return nodes.get(selector); },
    tab() { return this.tabs[this.module] || 'project'; }, render() { calls.push('render'); }, loadMetrics() { calls.push('metrics'); },
    focusDialog() {}, invalidateAccess() { calls.push('invalidate'); }, refresh() { calls.push('refresh'); },
  });
  return { owner, calls, nodes };
}

test('business center validates routes and preserves selected object identity', () => {
  const f = studioFixture();
  const originalDocument = globalThis.document;
  globalThis.document = { body: { classList: { remove() {} } } };
  try {
    assert.equal(f.owner.openBusinessModule('unknown'), false);
    assert.equal(f.owner.openBusinessModule('plan', 'missing'), false);
    assert.deepEqual(f.calls, []);
    assert.equal(f.owner.openBusinessModule('plan', 'tasks'), true);
    assert.equal(f.owner.module, 'plan');
    assert.equal(f.owner.tabs.plan, 'tasks');
    assert.deepEqual(f.owner.selection, { kind: 'resources', id: 'machine-a' });
  } finally { globalThis.document = originalDocument; }
});

test('host and unsaved-form guards retain the current page when a shortcut cannot leave', () => {
  for (const options of [{ blocked: true }, { dirty: true }]) {
    const f = studioFixture(options);
    assert.equal(f.owner.openBusinessModule('plan', 'tasks'), false);
    assert.equal(f.owner.module, 'overview');
    assert.deepEqual(f.calls, []);
    if (options.dirty) assert.equal(typeof f.owner.pendingLeave, 'function');
  }
});

test('project selection is guarded and a deferred switch retains its chosen project', () => {
  for (const options of [{ blocked: true }, { dirty: true }]) {
    const f = studioFixture(options);
    const select = { value: 'project-b', dataset: {}, matches: selector => selector.split(',').includes('[data-mg-project]') };
    f.owner.change(select);
    assert.equal(select.value, 'safety:project');
    assert.equal(f.owner.projectId, 'safety:project');
    assert.deepEqual(f.calls, []);
    if (options.dirty) {
      f.owner.draft = undefined;
      f.owner.pendingLeave();
      assert.equal(f.owner.projectId, 'project-b');
      assert.deepEqual(f.calls, ['invalidate', 'refresh']);
    }
  }
});

test('direct business shortcuts disable the automatic initial scene and keep one workspace', async () => {
  const calls = [];
  const owner = Object.assign(Object.create(ManagementWorkspace.prototype), {
    disposed: false, active: false, defaultScenePending: true,
    async open(defaultScene) { calls.push(['open', defaultScene]); this.active = true; },
    ui: { getNavigationRevision: () => 0, openBusinessModule(module, tab) { calls.push(['route', module, tab]); return true; } },
  });
  assert.equal(await owner.openBusinessModule('resources', 'equipment'), true);
  assert.equal(owner.defaultScenePending, false);
  assert.deepEqual(calls, [['open', false], ['route', 'resources', 'equipment']]);
  calls.length = 0;
  await owner.openBusinessModule('documents', 'files');
  assert.deepEqual(calls, [['route', 'documents', 'files']]);
});

test('expired business requests neither open a workspace nor replace a newer route after loading', async () => {
  const calls = [];
  let current = false, finishOpen;
  const owner = Object.assign(Object.create(ManagementWorkspace.prototype), {
    disposed: false, active: false, defaultScenePending: true,
    async open() { calls.push('open'); this.active = true; await new Promise(resolve => { finishOpen = resolve; }); },
    ui: { getNavigationRevision: () => 0, openBusinessModule() { calls.push('route'); return true; } },
  });
  assert.equal(await owner.openBusinessModule('plan', 'tasks', () => current), false);
  assert.deepEqual(calls, []);
  current = true;
  const result = owner.openBusinessModule('plan', 'tasks', () => current);
  current = false;
  finishOpen();
  assert.equal(await result, false);
  assert.deepEqual(calls, ['open']);
});

test('a user business choice made while the shared workspace opens wins over the older shortcut', async () => {
  const f = studioFixture(), originalDocument = globalThis.document;
  let finishOpen;
  globalThis.document = { body: { classList: { remove() {} } } };
  const owner = Object.assign(Object.create(ManagementWorkspace.prototype), {
    disposed: false, active: false, defaultScenePending: true, ui: f.owner,
    async open() { this.active = true; await new Promise(resolve => { finishOpen = resolve; }); },
  });
  try {
    const older = owner.openBusinessModule('plan', 'tasks');
    assert.equal(f.owner.openBusinessModule('documents', 'files'), true);
    finishOpen();
    assert.equal(await older, false);
    assert.equal(f.owner.module, 'documents');
    assert.equal(f.owner.tabs.documents, 'files');
    assert.equal(f.owner.tabs.plan, undefined);
  } finally { globalThis.document = originalDocument; }
});

test('mode sync does not invalidate pending navigation but an explicit mode choice does', () => {
  const f = studioFixture(), originalDocument = globalThis.document;
  globalThis.document = { body: { classList: { toggle() {} } } };
  try {
    const before = f.owner.getNavigationRevision();
    f.owner.setViewMode('scene', false);
    assert.equal(f.owner.getNavigationRevision(), before);
    f.owner.setViewMode('management');
    assert.equal(f.owner.getNavigationRevision(), before + 1);
  } finally { globalThis.document = originalDocument; }
});

test('center exits run the existing permission and draft checks before revealing navigation', () => {
  for (const blocked of [true, false]) {
    const calls = [];
    const owner = Object.assign(Object.create(ManagementWorkspace.prototype), {
      data: { projectId: 'safety:project' }, session: { permissions: ['files', 'models', 'media'] },
      workbench: { onOpenFunctionCenter: id => calls.push(['center', id]) },
      guardNavigation: () => !blocked,
      safety: { spatial: { requestClose: callback => callback() } },
      close() { calls.push(['close']); }, message() {},
    });
    owner.openFunctionCenter('construction');
    assert.deepEqual(calls, blocked ? [] : [['close'], ['center', 'construction']]);
    calls.length = 0;
    owner.session.permissions = ['files'];
    owner.openFunctionCenter('data');
    assert.deepEqual(calls, []);
  }
});

test('engineering draft guard stops management navigation before touching scene editors', () => {
  const owner = Object.assign(Object.create(ManagementWorkspace.prototype), {
    workbench: { canLeaveWorkbench: () => false },
    ui: { canChangeFieldContext() { throw new Error('should not reach scene guard'); } },
  });
  assert.equal(owner.guardNavigation(), false);
});
