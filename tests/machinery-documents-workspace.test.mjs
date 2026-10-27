import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Cartesian2, Entity } from 'cesium';

// Run the real workspace selection and permission methods without constructing a WebGL scene.
let temporary, ManagementWorkspace;
before(async () => {
  temporary = await mkdtemp(`${process.cwd()}/.machinery-documents-workspace-`);
  await build({ stdin: { contents: 'export { ManagementWorkspace } from "./src/managementWorkspace.ts";', resolveDir: process.cwd(), loader: 'ts' },
    outfile: `${temporary}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  ({ ManagementWorkspace } = await import(pathToFileURL(`${temporary}/fixture.mjs`).href));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function fixture({ active = false, permissions = ['models', 'files', 'resource'], pickId = 'machinery:machine-a' } = {}) {
  const calls = [], messages = [], resource = { id: 'machine-a', name: '吊机 A', kind: 'equipment', projectId: 'safety:project', revision: 1, status: 'active' };
  const owner = Object.assign(Object.create(ManagementWorkspace.prototype), {
    disposed: false, active, mode: active ? 'scene' : 'management', anchorEntities: new Map(),
    workbench: {}, data: { projectId: 'safety:project', revision: 1, collections: { resources: [resource], railSafety: [], tasks: [], issues: [], allocations: [] } },
    session: { userId: 'owner', permissions },
    viewer: { scene: { pick() { calls.push(['pick']); return { id: new Entity({ id: pickId }) }; } } },
    ui: { canChangeFieldContext: () => true, setExternalSelection: value => calls.push(['selection', value]), setScenePanel: value => calls.push(['panel', value]) },
    machinery: { hasDraft: false, isPicking: false, isBusy: false, close: () => { calls.push(['close-machinery']); return true; }, open: () => calls.push(['open-machinery']), getDisplayVisibility: () => true },
    railSafety: { hasDraft: false, isPicking: false, isBusy: false, close: () => { calls.push(['close-rail']); return true; }, open: () => calls.push(['open-rail']),
      setPresentation: value => calls.push(['presentation', value]), openMachineDocuments: id => { calls.push(['documents', id]); return true; } },
    safety: { spatial: { debugStats: () => ({ dirty: false, visible: false }) }, optimization: { close() {} }, managementPause() {}, managementSetProjectionPreview() {} },
    videoDiagnostics: { close() {} }, endMeasurement() {}, endAnchorPick() {}, syncMachinery() {}, changeMode() { return true; },
    queueFieldUpdate() { calls.push(['field-update']); }, message(value) { messages.push(value); },
  });
  return { owner, calls, messages, resource, opens: () => calls.filter(([name]) => name === 'documents') };
}

test('clicking the actual machinery entity opens its documents in both workbench and field scene without moving the camera', () => {
  for (const active of [false, true]) {
    const f = fixture({ active });
    f.owner.selectSceneObject(new Cartesian2(4, 5));
    assert.deepEqual(f.opens(), [['documents', 'machine-a']]);
    assert.equal(f.owner.selectedMachineryId, 'machine-a');
    assert.deepEqual(f.owner.selectedFieldObject, { kind: 'resources', id: 'machine-a' });
    if (active) assert.ok(f.calls.some(([name, panel]) => name === 'panel' && panel === 'object'), 'field editor is revealed in its existing dock');
    else assert.ok(f.calls.some(([name, presentation]) => name === 'presentation' && presentation === 'workbench'));
  }
});

test('a repeat click cannot replace a dirty mechanical draft or busy document operation', () => {
  for (const active of [false, true]) for (const [panel, property] of [['machinery', 'hasDraft'], ['machinery', 'isBusy'], ['railSafety', 'hasDraft'], ['railSafety', 'isBusy']]) {
    const f = fixture({ active }); f.owner.selectedMachineryId = 'machine-a'; f.owner[panel][property] = true;
    assert.equal(f.owner.openMachineryDocuments('machine-a'), false);
    assert.equal(f.opens().length, 0);
    assert.equal(f.owner.selectedMachineryId, 'machine-a');
    assert.ok(f.messages.length, 'the blocked operation explains the pending edit');
  }
});

test('drawing and placement tools, hidden machines and non-machine objects do not open documents', () => {
  for (const apply of [owner => { owner.workbench.canSelectSceneObject = () => false; }, owner => { owner.machinery.isPicking = true; },
    owner => { owner.railSafety.isPicking = true; }, owner => { owner.measurement = {}; }, owner => { owner.anchorPicking = {}; },
    owner => { owner.safety.spatial.debugStats = () => ({ visible: true }); }]) {
    const f = fixture(); apply(f.owner); f.owner.selectSceneObject(new Cartesian2());
    assert.equal(f.calls.some(([name]) => name === 'pick'), false, 'busy tools avoid an extra GPU pick entirely');
    assert.equal(f.opens().length, 0);
  }
  const hidden = fixture(); hidden.owner.machinery.getDisplayVisibility = () => false; hidden.owner.selectSceneObject(new Cartesian2()); assert.equal(hidden.opens().length, 0);
  const ordinary = fixture({ pickId: 'ordinary-model' }); ordinary.owner.selectSceneObject(new Cartesian2()); assert.equal(ordinary.opens().length, 0);
});

test('machine documents require files and model permissions and an active resource in the current project', () => {
  for (const permissions of [[], ['files'], ['models']]) {
    const f = fixture({ active: true, permissions }); assert.equal(f.owner.openMachineryDocuments('machine-a'), false); assert.equal(f.opens().length, 0);
    if (permissions.includes('models')) assert.equal(f.owner.selectedMachineryId, 'machine-a', 'normal model selection still works without file access');
  }
  for (const apply of [f => { f.resource.status = 'deleted'; }, f => { f.resource.deletedAt = '2026-10-27'; },
    f => { f.resource.projectId = 'other'; }, f => { f.owner.data.projectId = 'other'; }, f => { f.owner.active = true; f.owner.mode = 'management'; }]) {
    const f = fixture(); apply(f); assert.equal(f.owner.openMachineryDocuments('machine-a'), false); assert.equal(f.opens().length, 0);
  }
});

test('a workbench tool refusing suspension leaves the existing selection and reports its reason', () => {
  const f = fixture(); f.owner.selectedMachineryId = 'original';
  f.owner.railSafety.openMachineDocuments = () => { throw new Error('请先完成当前标绘'); };
  assert.equal(f.owner.openMachineryDocuments('machine-a'), false);
  assert.equal(f.owner.selectedMachineryId, 'original'); assert.match(f.messages[0], /标绘/);
});

test('document capabilities match backend role permissions and are revoked on project change', () => {
  for (const editRole of ['resource', 'field', 'document', 'inspect']) {
    const f = fixture({ permissions: ['models', 'files', editRole] });
    let context; f.owner.railSafety.setContext = value => { context = value; }; f.owner.machinery.setContext = () => {};
    f.owner.safety.setManagementResourceAccess = () => {};
    ManagementWorkspace.prototype.syncMachinery.call(f.owner);
    assert.equal(context.canViewDocuments, true); assert.equal(context.canEditDocuments, true);
    f.owner.session.permissions = ['models', 'files']; ManagementWorkspace.prototype.syncMachinery.call(f.owner);
    assert.equal(context.canViewDocuments, true); assert.equal(context.canEditDocuments, false);
    f.owner.session.permissions = ['models', editRole]; ManagementWorkspace.prototype.syncMachinery.call(f.owner);
    assert.equal(context.canViewDocuments, false); assert.equal(context.canEditDocuments, false);
    f.owner.session.permissions = ['models', 'files', editRole]; f.owner.data.projectId = 'other'; ManagementWorkspace.prototype.syncMachinery.call(f.owner);
    assert.equal(context.canViewDocuments, false); assert.equal(context.canEditDocuments, false);
  }
});
