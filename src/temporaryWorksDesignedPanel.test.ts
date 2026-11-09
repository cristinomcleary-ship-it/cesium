import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { TemporaryWorksSurfaceComposition } from './temporaryWorksSurfaceComposition.ts';

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { TemporaryWorksPanel } = await import('./temporaryWorksPanel.ts');

function roadPlan(id = 'road') {
  const vertices = [{ longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 },
    { longitude: 121.001, latitude: 31.001 }, { longitude: 121, latitude: 31.001 }].map(p => ({ ...p, surfaceHeight: 10, baseHeight: 9.8, formationHeight: 9.5 }));
  return { id, name: id, kind: 'road' as const, visible: true, createdAt: '2026-11-06T00:00:00Z', modelId: 'photography', modelName: 'scene', earthworkDisabled: true,
    inputs: { road: { surfaceMode: 'designed', grades: [], length: 100 }, width: 7 },
    surface: { version: 1, clippingEnabled: true, footprints: [{ outer: vertices }] },
    mesh: { vertices, triangles: [[0, 1, 2], [0, 2, 3]] }, metrics: { planArea: 100, coveredArea: 100, excludedArea: 0, cutVolume: 0, fillVolume: 0 } };
}
function handle() {
  return { show: true, xray: false, destroyed: 0, clipping: true, brightness: 100,
    destroy() { this.destroyed++; this.show = false; }, setClippingEnabled(value: boolean) { this.clipping = value; },
    setBrightness(value: number) { this.brightness = value; }, ready: Promise.resolve(), zoom() {} };
}
function panelFixture() {
  const writes: string[] = [], geometryBuilds: string[] = [], blockers = new Map<string, string[]>();
  const rendered = new Map<string, ReturnType<typeof roadPlan>>();
  const p = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    projectId: 'project-a', generation: 1, upgradeEnabled: true, disposed: false, busySave: false,
    records: new Map(), handles: new Map(), overrides: new Map(), pendingDelete: new Set(),
    surfaceReady: new Set(), surfaceStates: new Map(), surfaceDerived: new Map(), surfaceRevision: 0,
    lighting: { schemaVersion: 1, globalPercent: 100, overrides: {} },
    buttons() {}, list() {}, review() {}, updateFields() {}, status() {},
    restoreBrightnessControls() {}, refreshHardeningFacilities() {},
    el() { return { replaceChildren() {} }; },
    options: { viewer: { scene: { requestRender() {} } }, canEdit: () => true, onPlansChanged() {},
      store: { async put(_project: string, plan: ReturnType<typeof roadPlan>) { writes.push(`put:${plan.id}`); },
        async updateExisting(_project: string, id: string, update: (value: ReturnType<typeof roadPlan>) => ReturnType<typeof roadPlan>) { writes.push(`update:${id}`); return update(p.records.get(id)); },
        async remove(_project: string, id: string) { writes.push(`remove:${id}`); } } },
    failure(error: unknown) { throw error; },
  });
  const composition = new TemporaryWorksSurfaceComposition<ReturnType<typeof roadPlan>, string[]>({
    async build(entry, neighbours) { geometryBuilds.push(entry.id); return neighbours.map(n => n.id); },
    commit(entry, value) { blockers.set(entry.id, value); rendered.set(entry.id, entry.data); return { bounds: entry.bounds, data: entry.data }; },
    suspend(id) { blockers.delete(id); rendered.delete(id); },
  });
  p.composition = composition;
  const ground = roadPlan('ground');
  composition.upsert({ id: ground.id, kind: 'hardening', bounds: { minX: 121, minY: 31, maxX: 121.001, maxY: 31.001 }, priority: 0, visible: true, ready: false, data: ground });
  return { p, composition, writes, geometryBuilds, blockers };
}

test('disabled longitudinal grades neither read nor validate an invalid hidden draft', () => {
  const p = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    measuredLength: 123.4,
    input() { return { checked: false }; },
    gradeDraft() { assert.fail('inactive draft must not participate in validation'); },
  });
  assert.deepEqual(p.getDesignedGrades(), [{ start: 0, end: 123.4, gradePct: 0 }]);
});

test('enabling longitudinal grades validates the same draft before it can affect geometry', () => {
  const p = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    measuredLength: 100, input() { return { checked: true }; },
    gradeDraft() { return [{ start: '0', end: '40', gradePct: '1' }, { start: '50', end: '100', gradePct: '0' }]; },
  });
  assert.throws(() => p.getDesignedGrades(), /连续|重叠|留空/);
});

test('hiding and showing a saved road releases and restores its hardening occupancy without storage writes', async () => {
  const f = panelFixture(), plan = roadPlan(), mesh = handle();
  f.p.records.set(plan.id, plan); f.p.handles.set(plan.id, mesh); f.p.surfaceReady.add(plan.id);
  f.p.registerSurface(plan); await f.composition.whenIdle();
  assert.deepEqual(f.blockers.get('ground'), ['road']);
  f.p.setPlanVisible(plan.id, false); await f.composition.whenIdle();
  assert.equal(mesh.show, false); assert.deepEqual(f.blockers.get('ground'), []);
  assert.equal(plan.visible, true); assert.deepEqual(f.writes, []);
  f.p.setPlanVisible(plan.id, true); await f.composition.whenIdle();
  assert.equal(mesh.show, true); assert.deepEqual(f.blockers.get('ground'), ['road']);
  f.composition.destroy();
});

test('saving a prepared road removes the temporary occupancy owner and leaves one saved owner', async () => {
  const f = panelFixture(), draft = roadPlan('new-road'), mesh = handle();
  f.p.preview = { record: draft, handle: mesh, checkSource() {} };
  f.p.registerSurfacePreview(draft, mesh); await f.composition.whenIdle();
  assert.deepEqual(f.blockers.get('ground'), ['preview:new-road']);
  await f.p.save(); await f.composition.whenIdle();
  assert.equal(f.p.preview, undefined); assert.equal(f.p.previewSurfaceId, undefined);
  assert.deepEqual(f.blockers.get('ground'), ['new-road']);
  assert.equal(f.p.records.size, 1); assert.equal(f.p.handles.get(draft.id), mesh);
  assert.equal(mesh.destroyed, 0); assert.deepEqual(f.writes, ['put:new-road']);
  f.composition.destroy();
});

test('discarding an edited preview restores the original handle and its occupancy', async () => {
  const f = panelFixture(), old = roadPlan('saved'), oldMesh = handle(), previewMesh = handle();
  f.p.records.set(old.id, old); f.p.handles.set(old.id, oldMesh); f.p.surfaceReady.add(old.id);
  f.p.registerSurface(old); await f.composition.whenIdle(); oldMesh.show = false;
  f.p.preview = { record: { ...old, name: 'edit' }, replaceId: old.id, handle: previewMesh, checkSource() {} };
  f.p.registerSurfacePreview(f.p.preview.record, previewMesh, old.id); await f.composition.whenIdle();
  f.p.dropPreview(); await f.composition.whenIdle();
  assert.equal(previewMesh.destroyed, 1); assert.equal(oldMesh.destroyed, 0); assert.equal(oldMesh.show, true);
  assert.equal(f.p.records.get(old.id), old); assert.deepEqual(f.blockers.get('ground'), ['saved']);
  assert.deepEqual(f.writes, []); f.composition.destroy();
});

test('visibility changes during a replacement preview never restore a second original occupancy owner', async () => {
  const f = panelFixture(), original = roadPlan('saved-road'), oldMesh = handle(), previewMesh = handle();
  f.p.records.set(original.id, original); f.p.handles.set(original.id, oldMesh); f.p.surfaceReady.add(original.id);
  f.p.registerSurface(original); await f.composition.whenIdle(); oldMesh.show = false;
  f.p.preview = { record: { ...original, name: 'edited road' }, replaceId: original.id, handle: previewMesh, checkSource() {} };
  f.p.registerSurfacePreview(f.p.preview.record, previewMesh, original.id); await f.composition.whenIdle();
  f.p.setPlanVisible(original.id, true); await f.composition.whenIdle();
  assert.equal(oldMesh.show, false); assert.equal(previewMesh.show, true);
  assert.deepEqual(f.blockers.get('ground'), ['preview:saved-road']);
  f.p.setPlanVisible(original.id, false); await f.composition.whenIdle();
  assert.equal(oldMesh.show, false); assert.equal(previewMesh.show, false); assert.deepEqual(f.blockers.get('ground'), []);
  f.p.setPlanVisible(original.id, true); await f.composition.whenIdle();
  assert.equal(oldMesh.show, false); assert.equal(previewMesh.show, true);
  assert.deepEqual(f.blockers.get('ground'), ['preview:saved-road']);
  f.p.dropPreview(); await f.composition.whenIdle();
  assert.equal(previewMesh.destroyed, 1); assert.equal(oldMesh.destroyed, 0); assert.equal(oldMesh.show, true);
  assert.deepEqual(f.blockers.get('ground'), ['saved-road']); assert.deepEqual(f.writes, []);
  f.composition.destroy();
});

test('successful removal releases the road occupancy only after storage commits', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'window', descriptor) : Reflect.deleteProperty(globalThis, 'window'));
  const f = panelFixture(), plan = roadPlan(), mesh = handle();
  f.p.records.set(plan.id, plan); f.p.handles.set(plan.id, mesh); f.p.surfaceReady.add(plan.id);
  f.p.registerSurface(plan); await f.composition.whenIdle();
  let release!: () => void;
  f.p.options.store.remove = () => new Promise<void>(r => { release = r; });
  const removing = f.p.removePlan(plan.id);
  assert.equal(mesh.destroyed, 0); assert.deepEqual(f.blockers.get('ground'), ['road']);
  release(); assert.equal(await removing, true); await f.composition.whenIdle();
  assert.equal(mesh.destroyed, 1); assert.equal(f.p.surfaceReady.has(plan.id), false);
  assert.deepEqual(f.blockers.get('ground'), []); assert.equal(f.p.records.has(plan.id), false);
  f.composition.destroy();
});

test('storage rejection retains both the edited preview and its active occupancy', async () => {
  const f = panelFixture(), draft = roadPlan('new-road'), mesh = handle();
  let error: unknown;
  f.p.options.store.put = async () => { throw new Error('quota'); };
  f.p.failure = (value: unknown) => { error = value; };
  const preview = { record: draft, handle: mesh, checkSource() {} }; f.p.preview = preview;
  f.p.registerSurfacePreview(draft, mesh); await f.composition.whenIdle();
  await f.p.save(); await f.composition.whenIdle();
  assert.match(String(error), /quota/); assert.equal(f.p.preview, preview); assert.equal(mesh.destroyed, 0);
  assert.deepEqual(f.blockers.get('ground'), ['preview:new-road']); assert.equal(f.p.records.size, 0);
  f.composition.destroy();
});

test('turning off road clipping does not hide its mesh or remove its surface priority', async () => {
  const f = panelFixture(), plan = roadPlan(), mesh = handle(), other = handle();
  f.p.records.set(plan.id, plan); f.p.handles.set(plan.id, mesh); f.p.handles.set('other', other); f.p.surfaceReady.add(plan.id);
  f.p.registerSurface(plan); await f.composition.whenIdle();
  await f.p.changeSurfaceClipping(plan.id); await f.composition.whenIdle();
  assert.equal(mesh.show, true); assert.equal(mesh.clipping, false); assert.equal(other.clipping, true);
  assert.deepEqual(f.blockers.get('ground'), ['road']); assert.equal(f.p.records.get(plan.id).surface.clippingEnabled, false);
  f.composition.destroy();
});

test('brightness input preserves the current geometry preview and only applies display parameters', t => {
  class Input { id = 'tw-brightness'; type = 'range'; value = '160'; dataset = {}; }
  const originals = ['HTMLInputElement', 'HTMLTextAreaElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: Input });
  Object.defineProperty(globalThis, 'HTMLTextAreaElement', { configurable: true, value: class {} });
  t.after(() => originals.forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key)));
  const f = panelFixture(), mesh = handle(), draft = { record: roadPlan('glb-preview'), handle: mesh };
  f.p.preview = draft;
  f.p.value = (key: string) => key === 'brightness' ? '160' : '';
  f.p.cancel = () => assert.fail('brightness must not cancel modelling');
  f.p.dropPreview = () => assert.fail('brightness must not destroy a geometry preview');
  f.p.clearReview = () => assert.fail('brightness must not discard review state');
  f.p.edited({ target: new Input() });
  assert.equal(f.p.preview, draft); assert.equal(mesh.brightness, 160); assert.equal(mesh.destroyed, 0);
  assert.equal(f.p.lighting.globalPercent, 160); assert.deepEqual(f.writes, []);
  f.composition.destroy();
});

test('per-model brightness previews on the selected saved model without requiring a new GLB load', () => {
  const f = panelFixture(), model = handle(), untouched = handle();
  f.p.handles.set('selected', model); f.p.handles.set('other', untouched); f.p.glbEditing = 'selected';
  f.p.value = (key: string) => ({ 'object-brightness-mode': 'custom', 'object-brightness': '175' })[key as 'object-brightness-mode'] ?? '';
  f.p.updateBrightness(true, false);
  assert.equal(model.brightness, 175); assert.equal(untouched.brightness, 100);
  assert.equal(model.destroyed, 0); assert.deepEqual(f.writes, []);
  f.composition.destroy();
});

test('saving a model brightness preference leaves geometry, preview and plan storage untouched', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key: string) { return saved.get(key) ?? null; },
    setItem(key: string, value: string) { saved.set(key, value); },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  const f = panelFixture(), model = handle(), previewModel = handle();
  const plan = { ...roadPlan('selected'), glb: { resourceId: 'camp' } };
  const preview = { record: plan, handle: previewModel };
  f.p.records.set(plan.id, plan); f.p.handles.set(plan.id, model); f.p.preview = preview;
  f.p.glbEditing = plan.id; f.p.objectBrightnessDraft = 175;
  f.p.draw = () => assert.fail('brightness persistence cannot reload a GLB');
  f.p.dropPreview = () => assert.fail('brightness persistence cannot discard geometry');
  f.p.saveObjectBrightness();
  const key = 'cesium-temporary-works-lighting-v1:local-browser:project-a';
  assert.equal(JSON.parse(saved.get(key)!).overrides.selected, 175);
  assert.equal(f.p.lighting.overrides.selected, 175); assert.equal(f.p.records.get(plan.id), plan);
  assert.equal(f.p.preview, preview); assert.equal(model.destroyed, 0); assert.equal(previewModel.destroyed, 0);
  assert.deepEqual(f.writes, []);
  f.p.objectBrightnessDraft = undefined; f.p.saveObjectBrightness();
  assert.equal(Object.hasOwn(JSON.parse(saved.get(key)!).overrides, plan.id), false, 'inherit removes only the object override');
  assert.equal(f.p.lighting.globalPercent, 100); f.composition.destroy();
});

test('a failed brightness preference write preserves the saved baseline and the live edit draft', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem() { return null; }, setItem() { throw new Error('quota exceeded'); },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  const f = panelFixture(), model = handle(), previewModel = handle();
  const plan = { ...roadPlan('selected'), glb: { resourceId: 'camp' } }, baseline = { schemaVersion: 1, globalPercent: 100, overrides: { selected: 135 } };
  const preview = { record: plan, handle: previewModel };
  model.brightness = previewModel.brightness = 175;
  f.p.records.set(plan.id, plan); f.p.handles.set(plan.id, model); f.p.preview = preview;
  f.p.glbEditing = plan.id; f.p.objectBrightnessDraft = 175; f.p.lighting = baseline;
  assert.throws(() => f.p.saveObjectBrightness(), /quota exceeded/);
  assert.equal(f.p.lighting, baseline); assert.equal(f.p.lighting.overrides.selected, 135);
  assert.equal(f.p.objectBrightnessDraft, 175); assert.equal(f.p.preview, preview);
  assert.equal(model.brightness, 175); assert.equal(previewModel.brightness, 175);
  assert.equal(model.destroyed, 0); assert.equal(previewModel.destroyed, 0); assert.deepEqual(f.writes, []);
  f.composition.destroy();
});

test('a hardening clipping toggle preserves the currently expanded derived mesh instead of reseeding stale saved geometry', async () => {
  const f = panelFixture(), original = roadPlan('hardening-field');
  await f.composition.whenIdle();
  const currentVertices = original.mesh.vertices.map(p => ({ ...p, longitude: p.longitude + (p.longitude > 121 ? .001 : 0) }));
  const stored = { ...original, kind: 'hardening', hardening: { priority: 1, clippingEnabled: true, boundary: currentVertices, thickness: .2 } };
  const current = { ...stored, mesh: { ...stored.mesh, vertices: currentVertices }, surface: { ...stored.surface, footprints: [{ outer: currentVertices }] } };
  const mesh = handle();
  f.p.records.set(stored.id, stored); f.p.handles.set(stored.id, mesh); f.p.surfaceReady.add(stored.id); f.p.surfaceDerived.set(stored.id, current);
  f.p.composition.upsertReady({ id: stored.id, kind: 'hardening', priority: 1, visible: true, ready: true,
    bounds: { minX: 121, minY: 31, maxX: 121.002, maxY: 31.001 }, data: stored },
  { bounds: { minX: 121, minY: 31, maxX: 121.002, maxY: 31.001 }, data: current });
  await f.composition.whenIdle(); f.geometryBuilds.length = 0;
  await f.p.changeSurfaceClipping(stored.id); await f.composition.whenIdle();
  const actual = f.p.composition.getCoverage(stored.id);
  assert.equal(actual.data.mesh, current.mesh, 'current expanded geometry must survive a metadata-only toggle');
  assert.equal(actual.bounds.maxX, 121.002); assert.equal(actual.data.surface.clippingEnabled, false);
  assert.equal(f.p.surfaceDerived.get(stored.id).mesh, current.mesh);
  assert.equal(f.p.records.get(stored.id).mesh, stored.mesh, 'the metadata write must not rewrite old source/cached geometry');
  assert.deepEqual(f.geometryBuilds, []); assert.equal(mesh.destroyed, 0);
  f.composition.destroy();
});

test('confirmed close restores saved brightness without rebuilding the model', t => {
  const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm:()=>true}});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');});
  const f = panelFixture(), model = handle(); model.brightness = 175;
  f.p.handles.set('selected', model); f.p.glbEditing = 'selected'; f.p.objectBrightnessDraft = 175;
  f.p.lighting = { schemaVersion: 1, globalPercent: 100, overrides: { selected: 135 } };
  f.p.clearOverlay = () => {}; f.p.cancel = () => {}; f.p.clearReview = () => {};
  f.p.value = (key: string) => key === 'brightness' ? '100' : '';
  f.p.close();
  assert.equal(f.p.glbEditing, undefined); assert.equal(f.p.objectBrightnessDraft, undefined);
  assert.equal(model.brightness, 135); assert.equal(model.destroyed, 0);
  assert.deepEqual(f.writes, []); f.composition.destroy();
});

test('a dependency change during asynchronous save stores the source but cannot seed stale preview coverage', async () => {
  const f = panelFixture(), draft = roadPlan('new-road'), mesh = handle();
  let release!: () => void, valid = true, checks = 0;
  const rebuilt: string[] = [];
  f.p.options.store.put = () => new Promise<void>(r => { release = r; });
  f.p.restoreDrawing = (plan: ReturnType<typeof roadPlan>) => { rebuilt.push(plan.id); };
  f.p.preview = { record: draft, handle: mesh, checkSource() { checks++; if (!valid) throw new Error('neighbour changed'); } };
  f.p.registerSurfacePreview(draft, mesh); await f.composition.whenIdle();
  const save = f.p.save();
  assert.equal(checks, 1); assert.equal(mesh.destroyed, 0);
  valid = false; f.p.surfaceRevision++; release(); await save; await f.composition.whenIdle();
  assert.equal(checks, 2); assert.equal(mesh.destroyed, 1); assert.deepEqual(rebuilt, [draft.id]);
  assert.equal(f.p.preview, undefined); assert.equal(f.p.previewSurfaceId, undefined);
  assert.deepEqual(f.blockers.get('ground'), [], 'a stale prepared surface cannot remain a blocker while source is being rechecked');
  assert.equal(f.p.records.get(draft.id), draft); f.composition.destroy();
});
