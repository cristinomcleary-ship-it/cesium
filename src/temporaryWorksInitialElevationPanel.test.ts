import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Cartesian3, Matrix4 } from 'cesium';
import { designedRoadHeightAt } from './temporaryWorksDesignedRoad.ts';
import { translateTemporaryWorksPlan } from './temporaryWorksPosition.ts';
import { sampleTemporaryWorksInitialElevation } from './temporaryWorksInitialElevation.ts';
import type { TemporaryWorksPlan } from './temporaryWorksPanel.ts';

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { TemporaryWorksPanel } = await import('./temporaryWorksPanel.ts');

type Geo = { longitude: number; latitude: number };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function roadFixture() {
  const fields = new Map<string, { value: string; checked: boolean; disabled: boolean; textContent: string; replaceChildren(): void }>();
  const field = (key: string) => {
    if (!fields.has(key)) fields.set(key, { value: '', checked: false, disabled: false, textContent: '', replaceChildren() {} });
    return fields.get(key)!;
  };
  for (const [key, value] of Object.entries({ model: 'photo', name: '自动取高便道', width: '4', thickness: '.2', treatment: '.3', 'elevation-mode': 'automatic' }))
    field(key).value = value;
  field('confirmed').checked = true; field('road-clipping').checked = true;
  const feature = { id: 'axis', layer: 'road', sourceType: 'POLYLINE', closed: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  const model = { id: 'photo', name: '合成摄影', tileset: { modelMatrix: Matrix4.clone(Matrix4.IDENTITY), root: { transform: Matrix4.clone(Matrix4.IDENTITY) } } };
  const errors: unknown[] = [], samples: Geo[][] = [], built: Array<{ show: boolean; destroyed: number }> = [];
  const grades = [{ start: 0, end: 100, gradePct: 0 }];
  const p = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    projectId: 'project-a', generation: 1, disposed: false, busySave: false, upgradeEnabled: true,
    records: new Map(), handles: new Map(), overrides: new Map(), surfaceReady: new Set(), surfaceStates: new Map(), surfaceDerived: new Map(), surfaceRevision: 0,
    cadFile: new File([], 'fixture.dxf'), measuredLength: 100, reversed: false,
    options: { viewer: { scene: { requestRender() {} } }, canEdit: () => true, getTilesets: () => [model] },
    field, input: field, select: field, el: field, value: (key: string) => field(key).value,
    feature: () => feature,
    coordinates: () => ({ mode: 'local', referenceX: 0, referenceY: 0, longitude: 121, latitude: 31, rotation: 0, unit: 'm', axisOrder: 'eastNorth' }),
    gradeDraft: () => grades.map(g => ({ start: String(g.start), end: String(g.end), gradePct: String(g.gradePct) })),
    getDesignedGrades: () => field('road-grades-enabled').checked ? grades : [{ start: 0, end: 100, gradePct: 0 }],
    cancel(this: { analysis?: AbortController }) { this.analysis?.abort(); this.analysis = undefined; },
    clearReview() {}, buttons() {}, status() {}, review() {}, registerSurfacePreview() {},
    failure(error: unknown) { errors.push(error); },
    readGlbSurface: async (_model: unknown, points: Geo[]) => { samples.push(points.map(point => ({ ...point }))); return points.map(() => 12); },
    draw() { const handle = { show: true, destroyed: 0, ready: Promise.resolve(), zoom() {}, destroy() { this.destroyed++; this.show = false; } }; built.push(handle); return handle; },
  });
  p.readInitialElevation = (current: unknown, candidates: Geo[], job: AbortController, checkCurrent: () => void) =>
    sampleTemporaryWorksInitialElevation(candidates, points => p.readGlbSurface(current, points, job), { signal: job.signal, checkCurrent });
  return { p, field, feature, model, errors, samples, grades, built };
}

test('a new level road obtains its initial elevation from one photography point without a manual height', async () => {
  const f = roadFixture();
  assert.equal(f.field('road-elevation').value, '');
  await f.p.runDesignedRoad();
  assert.deepEqual(f.errors, []); assert.ok(f.p.preview);
  assert.deepEqual(f.samples.map(call => call.length), [1]);
  const plan = f.p.preview.record as TemporaryWorksPlan;
  assert.equal(plan.inputs.road!.startHeight, 12); assert.equal(plan.inputs.road!.endHeight, 12);
  assert.ok(plan.mesh.vertices.every(vertex => Math.abs(vertex.surfaceHeight - 12) < 1e-10));
  assert.ok(plan.mesh.vertices.every(vertex => Math.abs(vertex.surfaceHeight - vertex.baseHeight - .2) < 1e-10));
  assert.ok(plan.mesh.vertices.every(vertex => Math.abs(vertex.baseHeight - vertex.formationHeight - .3) < 1e-10));
});

test('a graded road anchors its sampled middle station and derives the start height from the active grades', async () => {
  const f = roadFixture(); f.field('road-grades-enabled').checked = true;
  f.grades.splice(0, 1, { start: 0, end: 40, gradePct: 2 }, { start: 40, end: 100, gradePct: -1 });
  await f.p.runDesignedRoad();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.samples.map(call => call.length), [1]);
  const road = (f.p.preview.record as TemporaryWorksPlan).inputs.road!;
  assert.ok(Math.abs(road.startHeight! - 11.3) < 1e-9);
  assert.ok(Math.abs(designedRoadHeightAt(50, road.startHeight!, road.grades) - 12) < 1e-9);
  assert.ok(Math.abs(road.endHeight! - 11.5) < 1e-9);
});

test('initial road sampling falls back within a fixed candidate budget and never substitutes zero for missing coverage', async () => {
  const f = roadFixture(); let calls = 0;
  f.p.readGlbSurface = async (_model: unknown, points: Geo[]) => {
    f.samples.push(points); calls++; return points.map(() => null);
  };
  await f.p.runDesignedRoad();
  assert.equal(f.p.preview, undefined); assert.equal(f.built.length, 0); assert.equal(f.errors.length, 1);
  assert.ok(calls <= 2); assert.ok(f.samples.flat().length <= 9); assert.equal(f.field('road-elevation').value, '');
});

test('a saved position-adjusted road retains its elevation on regeneration without another sample', async () => {
  const f = roadFixture(); await f.p.runDesignedRoad();
  assert.deepEqual(f.errors, []);
  const moved = translateTemporaryWorksPlan(f.p.preview.record, { east: 0, north: 0, up: 3 });
  delete moved.inputs.road!.gradeDraft;
  f.p.records.set(moved.id, moved);
  Object.assign(f.p, { refresh() {}, rebuildFeatures() {}, restoreCoordinates() {}, featurePreview() {}, updateFields() {}, gradeStatus() {}, crossSection() {},
    setGrades(next: typeof f.grades) { f.grades.splice(0, f.grades.length, ...next); } });
  f.p.editDesignedRoad(moved.id); f.field('confirmed').checked = true;
  f.p.readGlbSurface = async () => { assert.fail('saved position elevation must survive editing'); };
  await f.p.runDesignedRoad();
  assert.deepEqual(f.errors, []); assert.equal(f.p.preview.record.inputs.road.startHeight, 15);
  assert.equal(f.p.preview.replaceId, moved.id); assert.equal(f.p.records.get(moved.id), moved);
});

test('changing projects while the initial height is pending cannot create a road preview', async () => {
  const f = roadFixture(), entered = deferred<void>(), response = deferred<(number | null)[]>();
  f.p.readGlbSurface = async () => { entered.resolve(); return response.promise; };
  const running = f.p.runDesignedRoad(); await entered.promise;
  f.p.cancel(); f.p.generation++; f.p.projectId = 'project-b'; response.resolve([12]); await running;
  assert.equal(f.p.preview, undefined); assert.equal(f.built.length, 0); assert.deepEqual(f.errors, []);
});

test('a changed photography transform invalidates a pending initial-height sample', async () => {
  const f = roadFixture(), entered = deferred<void>(), response = deferred<(number | null)[]>();
  f.p.readGlbSurface = async () => { entered.resolve(); return response.promise; };
  const running = f.p.runDesignedRoad(); await entered.promise;
  f.model.tileset.modelMatrix = Matrix4.fromTranslation(new Cartesian3(100, 0, 0)); response.resolve([12]); await running;
  assert.equal(f.p.preview, undefined); assert.equal(f.built.length, 0); assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /变化|定位|摄影/);
});

test('reversing a new graded road before sampling needs no height and preserves the grade profile', () => {
  const f = roadFixture(); f.field('road-grades-enabled').checked = true;
  f.grades.splice(0, 1, { start: 0, end: 40, gradePct: 2 }, { start: 40, end: 100, gradePct: -1 });
  Object.assign(f.p, { roadFeature: f.feature, clearOverlay() {}, featurePreview() {}, gradeEdited() {},
    setGrades(next: typeof f.grades) { f.grades.splice(0, f.grades.length, ...next); } });
  assert.doesNotThrow(() => f.p.reverseRoute());
  assert.equal(f.p.reversed, true); assert.equal(f.field('road-elevation').value, '');
  assert.deepEqual(f.grades, [{ start: 0, end: 60, gradePct: 1 }, { start: 60, end: 100, gradePct: -2 }]);
});

test('reversing a road with an established height keeps its physical endpoint elevations', () => {
  const f = roadFixture(); f.field('road-grades-enabled').checked = true; f.field('road-elevation').value = '12'; f.field('elevation-mode').value = 'manual';
  f.grades.splice(0, 1, { start: 0, end: 40, gradePct: 2 }, { start: 40, end: 100, gradePct: -1 });
  Object.assign(f.p, { roadFeature: f.feature, clearOverlay() {}, featurePreview() {}, gradeEdited() {},
    setGrades(next: typeof f.grades) { f.grades.splice(0, f.grades.length, ...next); } });
  f.p.reverseRoute();
  assert.equal(Number(f.field('road-elevation').value), 12.2);
  assert.ok(Math.abs(designedRoadHeightAt(100, 12.2, f.grades) - 12) < 1e-9);
});
