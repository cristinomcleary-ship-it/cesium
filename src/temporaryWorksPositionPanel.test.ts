import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { TemporaryWorksSurfaceComposition } from './temporaryWorksSurfaceComposition.ts';
import type { TemporaryWorksPlan } from './temporaryWorksPanel.ts';

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { TemporaryWorksPanel } = await import('./temporaryWorksPanel.ts');

function savedRoad(id = 'saved-road'): TemporaryWorksPlan {
  const vertices = [{ longitude: 121, latitude: 31 }, { longitude: 121.0001, latitude: 31 },
    { longitude: 121.0001, latitude: 31.0001 }, { longitude: 121, latitude: 31.0001 }]
    .map(p => ({ ...p, surfaceHeight: 10, baseHeight: 9.8, formationHeight: 9.5 }));
  return {
    id, name: '便道位置调整', kind: 'road', visible: true, createdAt: '2026-11-06T00:00:00Z',
    modelId: 'photography', modelName: '合成地面', earthworkDisabled: true,
    inputs: {
      cadName: 'fixture.dxf', modelMatrix: [], modelRootTransform: [],
      feature: { id: 'axis', layer: 'road', sourceType: 'POLYLINE', closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      coordinates: { mode: 'local', longitude: 121, latitude: 31, referenceX: 0, referenceY: 0, rotation: 0, unit: 'm', axisOrder: 'eastNorth' },
      reference: { longitude: 121, latitude: 31, height: 10 }, referenceInput: { mode: 'geo', first: 121, second: 31 },
      design: { reference: { x: 0, y: 0 }, referenceHeight: 10, finishedOffset: 0, surfaceToTreatment: .2, treatmentDepth: .3 },
      width: 7, road: { surfaceMode: 'designed', startHeight: 10, endHeight: 10, grades: [{ start: 0, end: 10, gradePct: 0 }],
        length: 10, reversed: false, slopeHeight: 1, slopeWidth: 0, referenceStation: 0, hardeningBottomWidth: 7,
        formationWidth: 7, pavementArea: 70, coveredPavementArea: 70 },
      spacing: 1, sampleCount: 0, refinementLevels: 0, budgetLimited: false,
    },
    surface: { version: 1, clippingEnabled: true, footprints: [{ outer: vertices }] },
    mesh: { vertices, triangles: [[0, 1, 2], [0, 2, 3]] },
    metrics: { planArea: 70, coveredArea: 70, excludedArea: 0, cutVolume: 0, fillVolume: 0 },
  };
}

function meshHandle() {
  return { show: true, xray: false, destroyed: 0, ready: Promise.resolve(),
    destroy() { this.destroyed++; this.show = false; }, zoom() {}, setClippingEnabled() {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const original = savedRoad(), oldHandle = meshHandle();
  const persisted = new Map([[original.id, structuredClone(original)]]), writes: string[] = [], errors: unknown[] = [];
  const coverage = new Map<string, string[]>(), built: ReturnType<typeof meshHandle>[] = [];
  const fields = new Map<string, { value: string; hidden: boolean; textContent: string; disabled: boolean; replaceChildren(): void; scrollIntoView(): void }>();
  const field = (key: string) => {
    if (!fields.has(key)) fields.set(key, { value: key.includes('step') ? '1' : '0', hidden: false, textContent: '', disabled: false, replaceChildren() {}, scrollIntoView() {} });
    return fields.get(key)!;
  };
  const p = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    projectId: 'project-a', generation: 1, upgradeEnabled: true, disposed: false, busySave: false,
    records: new Map([[original.id, original]]), handles: new Map([[original.id, oldHandle]]), overrides: new Map(), pendingDelete: new Set(),
    surfaceReady: new Set([original.id]), surfaceStates: new Map(), surfaceDerived: new Map(), surfaceRevision: 0,
    lighting: { schemaVersion: 1, globalPercent: 100, overrides: {} },
    buttons() {}, list() {}, review() {}, updateFields() {}, positionControls() {}, status() {}, clearReview() {}, clearOverlay() {}, refreshHardeningFacilities() {},
    restoreBrightnessControls() {}, el: field, input: field, value: (key: string) => field(key).value,
    cancel(this: { analysis?: AbortController }) { this.analysis?.abort(); this.analysis = undefined; },
    failure(error: unknown) { errors.push(error); },
    options: { viewer: { scene: { requestRender() {} }, camera: { heading: 0 } }, getTilesets: () => [], canEdit: () => true, onPlansChanged() {},
      store: {
        async put(_project: string, plan: TemporaryWorksPlan) { writes.push(`put:${plan.id}`); persisted.set(plan.id, structuredClone(plan)); },
        async updateExisting(_project: string, id: string, update: (value: TemporaryWorksPlan) => TemporaryWorksPlan) {
          writes.push(`update:${id}`); const value = persisted.get(id); if (!value) throw new Error('record deleted');
          const next = update(structuredClone(value)); persisted.set(id, structuredClone(next)); return next;
        },
      },
    },
  });
  const composition = new TemporaryWorksSurfaceComposition<TemporaryWorksPlan, string[]>({
    async build(_entry, neighbours) { return neighbours.map(n => n.id); },
    commit(entry, result) { coverage.set(entry.id, result); return { bounds: entry.bounds, data: entry.data }; },
    suspend(id) { coverage.delete(id); },
  });
  p.composition = composition;
  const ground = savedRoad('ground');
  composition.upsert({ id: ground.id, kind: 'hardening', bounds: { minX: 120.999, minY: 30.999, maxX: 121.001, maxY: 31.001 },
    priority: 0, visible: true, ready: true, data: ground });
  p.registerSurface(original);
  p.buildPositionCandidate = async (plan: TemporaryWorksPlan) => {
    const handle = meshHandle(); built.push(handle); return { plan, handle, canSave: true };
  };
  return { p, original, oldHandle, persisted, writes, errors, coverage, composition, built, field };
}

function installPositionPreview(f: ReturnType<typeof fixture>) {
  const handle = meshHandle(), draft = structuredClone(f.original);
  draft.mesh.vertices = draft.mesh.vertices.map(p => ({ ...p, surfaceHeight: p.surfaceHeight + 1, baseHeight: p.baseHeight + 1,
    formationHeight: p.formationHeight + 1 }));
  f.p.positionEditing = { id: f.original.id, source: f.original, offset: { east: 0, north: 0, up: 1 } };
  f.p.preview = { record: draft, replaceId: f.original.id, handle, checkSource() {} };
  f.oldHandle.show = false;
  f.p.registerSurfacePreview(draft, handle, f.original.id);
  return { handle, draft, preview: f.p.preview, position: f.p.positionEditing };
}

test('position cancel restores original geometry and hardening occupancy without writing storage', async () => {
  const f = fixture(); await f.composition.whenIdle();
  const draft = installPositionPreview(f); await f.composition.whenIdle();
  assert.deepEqual(f.coverage.get('ground'), ['preview:saved-road']);
  f.p.dropPreview(); await f.composition.whenIdle();
  assert.equal(f.p.positionEditing, undefined); assert.equal(f.p.preview, undefined);
  assert.equal(draft.handle.destroyed, 1); assert.equal(f.oldHandle.destroyed, 0); assert.equal(f.oldHandle.show, true);
  assert.equal(f.p.records.get(f.original.id), f.original); assert.deepEqual(f.persisted.get(f.original.id), f.original);
  assert.deepEqual(f.coverage.get('ground'), ['saved-road']); assert.deepEqual(f.writes, []);
  f.composition.destroy();
});

test('failed position save retains its draft, offsets and preview occupancy for retry', async () => {
  const f = fixture(); await f.composition.whenIdle();
  const draft = installPositionPreview(f); await f.composition.whenIdle();
  f.p.options.store.updateExisting = async () => { throw new Error('quota exceeded'); };
  await f.p.save(); await f.composition.whenIdle();
  assert.match(String(f.errors[0]), /quota exceeded/);
  assert.equal(f.p.positionEditing, draft.position); assert.equal(f.p.preview, draft.preview); assert.equal(f.p.busySave, false);
  assert.equal(draft.handle.destroyed, 0); assert.equal(f.oldHandle.destroyed, 0);
  assert.equal(f.p.records.get(f.original.id), f.original); assert.deepEqual(f.persisted.get(f.original.id), f.original);
  assert.deepEqual(f.coverage.get('ground'), ['preview:saved-road']); f.composition.destroy();
});

test('successful position save replaces only its original record and preserves saved identity and visibility', async () => {
  const f = fixture(); await f.composition.whenIdle();
  const draft = installPositionPreview(f); await f.composition.whenIdle();
  f.persisted.set(f.original.id, { ...f.persisted.get(f.original.id)!, visible: false });
  await f.p.save(); await f.composition.whenIdle();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, ['update:saved-road']); assert.equal(f.persisted.size, 1);
  const saved = f.persisted.get(f.original.id)!;
  assert.equal(saved.id, f.original.id); assert.equal(saved.createdAt, f.original.createdAt); assert.equal(saved.visible, false);
  assert.equal(saved.mesh.vertices[0].surfaceHeight, 11); assert.equal(f.p.records.get(saved.id).mesh.vertices[0].surfaceHeight, 11);
  assert.equal(f.oldHandle.destroyed, 1); assert.equal(draft.handle.destroyed, 0); assert.equal(draft.handle.show, false);
  assert.equal(f.p.positionEditing, undefined); assert.equal(f.p.preview, undefined); assert.equal(f.p.previewSurfaceId, undefined);
  assert.deepEqual(f.coverage.get('ground'), []); f.composition.destroy();
});

test('position save rejects changed persisted geometry instead of overwriting concurrent editing', async () => {
  const f = fixture(); await f.composition.whenIdle();
  const draft = installPositionPreview(f); await f.composition.whenIdle();
  const concurrent = structuredClone(f.original); concurrent.inputs.road!.startHeight = 99;
  f.persisted.set(concurrent.id, concurrent);
  await f.p.save();
  assert.equal(f.errors.length, 1); assert.deepEqual(f.persisted.get(concurrent.id), concurrent);
  assert.equal(f.p.preview, draft.preview); assert.equal(f.p.positionEditing, draft.position);
  assert.equal(f.oldHandle.destroyed, 0); assert.equal(draft.handle.destroyed, 0); f.composition.destroy();
});

test('a delayed position save cannot replace geometry in a newly selected project', async () => {
  const f = fixture(); await f.composition.whenIdle();
  const draft = installPositionPreview(f); await f.composition.whenIdle();
  const waiting = deferred<void>();
  f.p.options.store.updateExisting = async (_project: string, id: string, update: (value: TemporaryWorksPlan) => TemporaryWorksPlan) => {
    await waiting.promise; return update(f.persisted.get(id)!);
  };
  const saving = f.p.save();
  f.p.cancel(false); f.p.dropPreview(); f.p.generation++; f.p.projectId = 'project-b';
  const nextProject = savedRoad(), nextHandle = meshHandle();
  f.p.records = new Map([[nextProject.id, nextProject]]); f.p.handles = new Map([[nextProject.id, nextHandle]]);
  waiting.resolve(); await saving;
  assert.equal(f.p.records.get(nextProject.id), nextProject); assert.equal(f.p.handles.get(nextProject.id), nextHandle);
  assert.equal(nextHandle.destroyed, 0); assert.equal(draft.handle.destroyed, 1); f.composition.destroy();
});

test('position preview translates from the saved baseline and refreshes neighbour occupancy before explicit save', async () => {
  const f = fixture(); await f.composition.whenIdle(); f.p.startPositionAdjustment(f.original.id);
  await f.p.previewPosition({ east: 2, north: 3, up: 1 }); await f.composition.whenIdle();
  const first = f.p.preview;
  assert.deepEqual(f.errors, []); assert.equal(f.oldHandle.show, false); assert.equal(first.handle.show, true);
  assert.equal(first.record.mesh.vertices[0].surfaceHeight, 11); assert.equal(f.original.mesh.vertices[0].surfaceHeight, 10);
  assert.equal(f.p.records.get(f.original.id), f.original); assert.deepEqual(f.writes, []);
  assert.deepEqual(f.coverage.get('ground'), ['preview:saved-road']);
  await f.p.previewPosition({ east: 4, north: 3, up: 2 }); await f.composition.whenIdle();
  assert.equal(first.handle.destroyed, 1); assert.equal(f.p.preview.record.mesh.vertices[0].surfaceHeight, 12, 'total offsets must not accumulate twice');
  assert.deepEqual(f.p.positionEditing.offset, { east: 4, north: 3, up: 2 });
  await f.p.save(); await f.composition.whenIdle();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.writes, ['update:saved-road']);
  assert.deepEqual(f.coverage.get('ground'), ['saved-road']); assert.equal(f.persisted.get(f.original.id)!.mesh.vertices[0].surfaceHeight, 12);
  f.composition.destroy();
});

test('a failed position candidate retains the last successful geometry and cumulative offsets', async () => {
  const f = fixture(); await f.composition.whenIdle(); f.p.startPositionAdjustment(f.original.id);
  await f.p.previewPosition({ east: 1, north: 0, up: 1 }); await f.composition.whenIdle();
  const previous = f.p.preview;
  f.p.buildPositionCandidate = async () => { throw new Error('rendering unavailable'); };
  await f.p.previewPosition({ east: 100, north: 0, up: 20 }); await f.composition.whenIdle();
  assert.match(String(f.errors[0]), /rendering unavailable/); assert.equal(f.p.preview, previous);
  assert.deepEqual(f.p.positionEditing.offset, { east: 1, north: 0, up: 1 });
  assert.equal(previous.handle.destroyed, 0); assert.equal(previous.handle.show, true); assert.equal(f.p.analysis, undefined);
  assert.deepEqual(f.coverage.get('ground'), ['preview:saved-road']); assert.deepEqual(f.writes, []); f.composition.destroy();
});

test('a late position candidate is discarded after switching projects without touching the new scene', async () => {
  const f = fixture(); await f.composition.whenIdle(); f.p.startPositionAdjustment(f.original.id);
  const entered = deferred<void>(), finish = deferred<void>(), lateHandle = meshHandle();
  f.p.buildPositionCandidate = async (plan: TemporaryWorksPlan) => {
    entered.resolve(); await finish.promise; return { plan, handle: lateHandle, canSave: true };
  };
  const moving = f.p.previewPosition({ east: 5, north: 0, up: 0 }); await entered.promise;
  f.p.cancel(false); f.p.dropPreview(); f.p.generation++; f.p.projectId = 'project-b';
  const nextProject = savedRoad(), nextHandle = meshHandle();
  f.p.records = new Map([[nextProject.id, nextProject]]); f.p.handles = new Map([[nextProject.id, nextHandle]]);
  finish.resolve(); await moving;
  assert.equal(lateHandle.destroyed, 1); assert.equal(f.p.preview, undefined); assert.equal(f.p.positionEditing, undefined);
  assert.equal(f.p.records.get(nextProject.id), nextProject); assert.equal(f.p.handles.get(nextProject.id), nextHandle);
  assert.equal(nextHandle.destroyed, 0); assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []); f.composition.destroy();
});

test('a neighbour change while preparing a position candidate cannot publish stale coverage', async () => {
  const f = fixture(); await f.composition.whenIdle(); f.p.startPositionAdjustment(f.original.id);
  const entered = deferred<void>(), finish = deferred<void>(), lateHandle = meshHandle();
  f.p.buildPositionCandidate = async (plan: TemporaryWorksPlan) => {
    entered.resolve(); await finish.promise; return { plan, handle: lateHandle, canSave: true };
  };
  const moving = f.p.previewPosition({ east: 5, north: 0, up: 0 }); await entered.promise;
  f.p.surfaceRevision++; finish.resolve(); await moving; await f.composition.whenIdle();
  assert.equal(lateHandle.destroyed, 1); assert.equal(f.p.preview, undefined); assert.equal(f.oldHandle.show, true);
  assert.match(String(f.errors[0]), /相邻设施|变化/); assert.deepEqual(f.coverage.get('ground'), ['saved-road']);
  assert.deepEqual(f.p.positionEditing.offset, { east: 0, north: 0, up: 0 }); assert.deepEqual(f.writes, []); f.composition.destroy();
});

test('direction controls support camera-relative movement, north-oriented movement and independent height steps', async () => {
  const f = fixture(); await f.composition.whenIdle(); f.p.startPositionAdjustment(f.original.id);
  f.field('position-step').value = '2'; f.field('position-height-step').value = '.25';
  f.field('position-axis').value = 'view'; f.p.options.viewer.camera.heading = Math.PI / 2;
  await f.p.nudgePosition('forward'); await f.composition.whenIdle();
  assert.ok(Math.abs(f.p.positionEditing.offset.east - 2) < 1e-9); assert.ok(Math.abs(f.p.positionEditing.offset.north) < 1e-9);
  f.field('position-axis').value = 'north'; await f.p.nudgePosition('left'); await f.composition.whenIdle();
  assert.ok(Math.abs(f.p.positionEditing.offset.east) < 1e-9);
  await f.p.nudgePosition('up'); await f.composition.whenIdle();
  assert.equal(f.p.positionEditing.offset.up, .25); assert.equal(f.p.preview.record.mesh.vertices[0].surfaceHeight, 10.25);
  const old = f.p.preview; f.field('position-step').value = '0'; await f.p.nudgePosition('right');
  assert.equal(f.p.preview, old); assert.match(String(f.errors[0]), /步长/); assert.deepEqual(f.writes, []); f.composition.destroy();
});
