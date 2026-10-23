import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Exercise the actual production deletion methods without constructing the WebGL/DOM workspaces.
const directory = await mkdtemp(`${process.cwd()}/.business-delete-test-`);
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
try {
  await build({ stdin: { contents: 'export { ManagementWorkspace } from "./src/managementWorkspace.ts"; export { MarkupTools } from "./src/markupTools.ts"; export { FoundationPitMonitoring } from "./src/foundationPitMonitoring.ts"; export { MACHINERY_PARAMETER_DEFAULTS } from "./src/machineryValidation.ts";', resolveDir: process.cwd(), loader: 'ts' },
    outfile: `${directory}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { ManagementWorkspace, MarkupTools, FoundationPitMonitoring, MACHINERY_PARAMETER_DEFAULTS } = await import(pathToFileURL(`${directory}/fixture.mjs`).href);
  const storage = new Map();
  let failStorage = false;
  globalThis.localStorage = { setItem(key, value) { if (failStorage) throw new Error('quota'); storage.set(key, value); }, getItem: key => storage.get(key) ?? null };
  const machinery = { schemaVersion: 1, assetId: 'crane', assetVersion: '2026-10-13-v1', proportional: true, parameters: MACHINERY_PARAMETER_DEFAULTS.crane, placement: { longitude: 121, latitude: 31, height: 0, heading: 0 }, visible: true };
  const record = (id, extra = {}) => ({ id, name: id, projectId: 'safety:project', revision: 2, status: 'active', ...extra });
  function workspace() {
    const calls = [];
    const data = { projectId: 'safety:project', collections: { resources: [record('machine', { kind: 'equipment', machinery, qualificationEvidenceIds: ['certificate'] })], railSafety: [record('limit', { definition: { kind: 'limit', polygon: [] } }), record('guard', { taskId: 'task', definition: { kind: 'guard', station: {}, polygon: [{ longitude: 1 }], resourceIds: ['machine'], workArea: { polygon: [], deviceId: 'tracker' } } })] } };
    const owner = Object.assign(Object.create(ManagementWorkspace.prototype), { data, session: { userId: 'owner', permissions: ['models', 'resource'] }, disposed: false, machineryContextGeneration: 1,
      machineryMutationCount: 0, events: new AbortController(), workbench: {}, machinery: {}, railSafety: { getDisplayObjects: () => [{ id: 'machine', kind: 'envelope' }, { id: 'guard', kind: 'personnel' }] }, safety: { spatial: { debugStats: () => ({ dirty: false }) } },
      ui: { canChangeFieldContext: () => true, acceptExternalSnapshot(value) { owner.data = value; }, invalidateAccess() { owner.session = null; } }, queueFieldUpdate() {}, message() {} });
    globalThis.fetch = async (_url, options) => {
      const command = JSON.parse(options.body); calls.push(command);
      const next = structuredClone(owner.data);
      if (command.type === 'machinery.remove') delete next.collections.resources.find(item => item.id === command.id).machinery;
      else if (command.type === 'railSafety.remove') next.collections.railSafety.find(item => item.id === command.id).status = 'deleted';
      else next.collections.railSafety.find(item => item.id === command.id).definition = command.payload.definition;
      return new Response(JSON.stringify(next), { status: 200 });
    };
    return { owner, calls, data };
  }
  {
    const { owner, calls } = workspace();
    assert.equal(owner.getDisplayObjectRemoval('personnel', 'guard'), undefined);
    assert.equal(owner.getDisplayObjectRemoval('responsibility', 'guard'), undefined);
    assert.equal(owner.getDisplayObjectRemoval('envelope', 'machine'), undefined);
    const remove = owner.getDisplayObjectRemoval('machine', 'machine');
    assert.ok(remove);
    await remove.remove();
    assert.equal(calls[0].type, 'machinery.remove'); assert.equal(calls[0].expectedRevision, 2);
    assert.equal(owner.getWorkbenchMachineryState().records.length, 0, 'unbound model leaves the display directory');
    assert.deepEqual(owner.getWorkbenchDisplayObjects(), [{ id: 'guard', kind: 'personnel' }], 'derived envelope row leaves with its model');
    assert.deepEqual(owner.data.collections.resources[0].qualificationEvidenceIds, ['certificate'], 'resource business data survives');
    assert.equal(owner.data.collections.railSafety.length, 2, 'no cascade into rail definitions');
  }
  {
    const { owner, calls, data } = workspace();
    const guardBefore = structuredClone(data.collections.railSafety[1]);
    await owner.getDisplayObjectRemoval('workArea', 'guard').remove();
    assert.equal(calls[0].type, 'railSafety.save'); assert.equal(calls[0].payload.taskId, 'task');
    const expected = structuredClone(guardBefore.definition); delete expected.workArea;
    assert.deepEqual(owner.data.collections.railSafety[1].definition, expected, 'remove only optional work area, preserving personnel and responsibility');
    assert.equal(owner.getDisplayObjectRemoval('workArea', 'guard'), undefined);
    await owner.getDisplayObjectRemoval('limit', 'limit').remove();
    assert.equal(calls[1].type, 'railSafety.remove');
  }
  for (const mutate of [owner => { owner.data.projectId = 'different-project'; }, owner => { owner.session.userId = 'different-actor'; }, owner => { owner.session.permissions = ['models']; }, owner => { owner.data.collections.resources[0].revision++; }, owner => { owner.machinery.hasDraft = true; }]) {
    const { owner, calls } = workspace(); const removal = owner.getDisplayObjectRemoval('machine', 'machine');
    owner.machinery.open = () => {}; mutate(owner);
    await assert.rejects(removal.remove()); assert.equal(calls.length, 0, 'stale scope, revisions and unsaved drafts prevent requests');
  }
  {
    const { owner } = workspace();
    globalThis.fetch = async () => new Response(JSON.stringify({ error: '服务端修订冲突', code: 'CONFLICT' }), { status: 409 });
    await assert.rejects(owner.getDisplayObjectRemoval('limit', 'limit').remove(), /服务端修订冲突/);
    assert.equal(owner.data.collections.railSafety[0].status, 'active', 'failed backend deletion keeps current state');
  }
  function markup() {
    const point = id => ({ id, name: id, kind: 'point', note: '', visible: true, heightMode: 'picked', positions: [{ longitude: 121, latitude: 31, height: 0 }], style: { color: '#fff', opacity: 1, lineWidth: 1, pointSize: 10, fontSize: 12, lineEffect: 'solid', effectSpeed: 1, verticalHeight: 2 }, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' });
    return Object.assign(Object.create(MarkupTools.prototype), { records: [point('one'), point('two')], disposed: false, selectedId: 'one', viewer: { isDestroyed: () => false, selectedEntity: { id: 'one' } }, drawingKind: null, redrawId: null, undoStack: [], redoStack: [], displayVisibility: new Map([['one', false]]), render() {}, rebuildEntities() {}, downloadRecoveryBackup() {}, scheduleTextureGarbageCollection() {}, toast() {} });
  }
  {
    const owner = markup(); const before = structuredClone(owner.records);
    owner.getDisplayObjectRemoval('one').remove();
    assert.deepEqual(owner.records, [before[1]]); assert.equal(owner.selectedId, null); assert.equal(owner.viewer.selectedEntity, undefined);
    assert.deepEqual(JSON.parse(owner.undoStack[0]), before, 'quick deletion is undoable');
    assert.equal(owner.displayVisibility.has('one'), false);
    assert.deepEqual(JSON.parse([...storage.values()].find(value => value.includes('"items"'))).items, [before[1]]);
  }
  {
    const owner = markup(); const before = structuredClone(owner.records); failStorage = true;
    assert.throws(() => owner.getDisplayObjectRemoval('one').remove(), /删除失败/);
    failStorage = false; assert.deepEqual(owner.records, before); assert.equal(owner.undoStack.length, 0); assert.equal(owner.selectedId, 'one');
    const removal = owner.getDisplayObjectRemoval('one'); owner.records[0].name = 'updated'; assert.throws(removal.remove, /已更新/);
  }
  function pit() {
    const state = { version: 3, pits: [{ id: 'pit' }], points: [{ id: 'one', records: [] }, { id: 'two', records: [{ x: 1 }] }], supportMonitors: [{ id: 'support', records: [] }] };
    return Object.assign(Object.create(FoundationPitMonitoring.prototype), { state, displayScope: 'project/owner', displayAllowed: true, displayDisposed: false, displayOverrides: {}, pickMode: null, render() {} });
  }
  {
    const owner = pit(); const other = structuredClone(owner.state.points[1]);
    for (const id of ['pit:model:pit', 'pit:marker:pit', 'pit:point:two']) assert.equal(owner.getDisplayObjectRemoval(id), undefined, 'no cascading or historical deletion in quick controls');
    owner.getDisplayObjectRemoval('pit:point:one').remove();
    assert.deepEqual(owner.state.points, [other]); assert.equal(owner.state.pits.length, 1);
    owner.getDisplayObjectRemoval('pit:support:support').remove(); assert.equal(owner.state.supportMonitors.length, 0);
  }
  {
    const owner = pit(); const before = structuredClone(owner.state); const removal = owner.getDisplayObjectRemoval('pit:point:one');
    failStorage = true; assert.throws(removal.remove, /原数据已保留/); failStorage = false; assert.deepEqual(owner.state, before);
    owner.state.points[0].records.push({ x: 2 }); assert.throws(removal.remove, /已更新/); assert.equal(owner.state.points.length, 2);
    const supportRemoval = owner.getDisplayObjectRemoval('pit:support:support'); owner.displayScope = 'different'; assert.throws(supportRemoval.remove, /已变化/);
  }
  console.log('PASS business display removal: scoped revisions and permissions, backend errors, precise machinery/work-area removal, markup undo and persistence rollback, monitoring history protection.');
} finally {
  globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage;
  await rm(directory, { recursive: true, force: true });
}
