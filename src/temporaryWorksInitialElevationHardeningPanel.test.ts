import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Matrix4 } from 'cesium';
import { hardeningGeoFromLocal, hardeningLocalFromGeo, type HardeningReference } from './temporaryWorksHardeningEditorGeometry.ts';
import { translateTemporaryWorksPlan } from './temporaryWorksPosition.ts';
import type { HardeningEditorValue } from './temporaryWorksHardeningEditor.ts';
import type { TemporaryWorksPlan } from './temporaryWorksPanel.ts';
import type { TemporaryWorksSurfaceOptions } from './temporaryWorksSurfaceScene.ts';
import type { InitialElevationSample } from './temporaryWorksInitialElevation.ts';

// The real panel and hardening solver run below. Only the GPU renderer is replaced;
// its input remains available for checking the exact generated design surface.
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  if (url.endsWith('/temporaryWorksSurfaceScene.ts')) return { format: 'module', shortCircuit: true,
    source: 'export function renderTemporaryWorksSurface(viewer, options) { return viewer.renderHardeningForTest(options); }' };
  return next(url, context);
} });
const { TemporaryWorksPanel } = await import('./temporaryWorksPanel.ts');
const { TemporaryWorksHardeningEditor } = await import('./temporaryWorksHardeningEditor.ts');

type Geo = { longitude: number; latitude: number };
const reference: HardeningReference = { longitude: 121, latitude: 31, height: 90 };
const near = (a: number, b: number, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
function value(patch: Partial<HardeningEditorValue> = {}): HardeningEditorValue {
  return { name: '自动取高硬化场地', reference: { ...reference }, initialElevationMode: 'automatic',
    boundary: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }].map(p => hardeningGeoFromLocal(p, reference)),
    holes: [], thickness: .25, slopeEnabled: false, gradeEastPct: 0, gradeNorthPct: 0,
    clippingEnabled: true, acceptedHeightDifference: false, facilityExclusions: [], ...patch };
}
function fixture() {
  const fields = new Map<string, { value: string; checked: boolean; replaceChildren(): void }>();
  const field = (key: string) => {
    if (!fields.has(key)) fields.set(key, { value: '', checked: false, replaceChildren() {} });
    return fields.get(key)!;
  };
  field('model').value = 'photo';
  const model = { id: 'photo', name: '合成摄影', tileset: { show: true, isDestroyed: () => false,
    modelMatrix: Matrix4.clone(Matrix4.IDENTITY), root: { transform: Matrix4.clone(Matrix4.IDENTITY) } } };
  const errors: unknown[] = [], samples: { model: unknown; candidates: Geo[]; result: InitialElevationSample }[] = [];
  const rendered: TemporaryWorksSurfaceOptions[] = [], saved: TemporaryWorksPlan[] = [], resolved: HardeningReference[] = [];
  const editorValues: Partial<HardeningEditorValue>[] = [];
  const hardeningEditor = Object.assign(Object.create(TemporaryWorksHardeningEditor.prototype), {
    invalidVertexFields: new Set(), invalidVertexValues: new Map(), disposed: false,
    cancelDrawing(this: { drawing?: unknown }) { this.drawing = undefined; }, refresh() {}, refreshOutlines() {}, setStatus() {},
    field: (key: string) => field(`editor:${key}`),
    setResolvedReference(next: HardeningReference) {
      resolved.push({ ...next }); TemporaryWorksHardeningEditor.prototype.setResolvedReference.call(this, next);
    },
    setValue(next: Partial<HardeningEditorValue>) {
      editorValues.push(structuredClone(next)); TemporaryWorksHardeningEditor.prototype.setValue.call(this, next);
    },
  });
  const p = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    projectId: 'project-a', generation: 1, disposed: false, busySave: false, upgradeEnabled: true,
    surfaceRevision: 0, records: new Map(), handles: new Map(), overrides: new Map(), surfaceReady: new Set(),
    surfaceStates: new Map(), surfaceDerived: new Map(),
    options: { canEdit: () => true, getTilesets: () => [model],
      viewer: { scene: { requestRender() {} }, renderHardeningForTest(options: TemporaryWorksSurfaceOptions) {
        rendered.push(options);
        return { show: true, destroyed: 0, ready: Promise.resolve(), zoom() {}, destroy() { this.destroyed++; this.show = false; } };
      } },
      store: { async put(_project: string, plan: TemporaryWorksPlan) { saved.push(structuredClone(plan)); },
        async updateExisting(_project: string, id: string, update: (plan: TemporaryWorksPlan) => TemporaryWorksPlan) {
          const plan = update(p.records.get(id)); saved.push(structuredClone(plan)); return plan;
        } },
    },
    value: (key: string) => field(key).value, input: field, select: field, el: field,
    cancel(this: { analysis?: AbortController }) { this.analysis?.abort(); this.analysis = undefined; },
    dropPreview(this: { preview?: { handle: { destroy(): void } } }) { this.preview?.handle.destroy(); this.preview = undefined; },
    buttons() {}, clearReview() {}, review() {}, status() {}, list() {}, refresh() {}, updateFields() {},
    registerSurfacePreview() {}, registerSurface() {}, refreshHardeningFacilities() {},
    failure(error: unknown) { errors.push(error); },
    hardeningEditor,
    async readInitialElevation(selected: unknown, candidates: Geo[], job: AbortController, checkCurrent: () => void) {
      job.signal.throwIfAborted(); checkCurrent();
      const result = { ...candidates[0], height: 12, sampleCount: 1, candidateIndex: 0 };
      samples.push({ model: selected, candidates: candidates.map(point => ({ ...point })), result });
      return result;
    },
  });
  return { p, field, model, errors, samples, rendered, saved, resolved, editorValues };
}

test('new automatic hardening samples the selected photography once and builds at that height', async () => {
  const f = fixture(), draft = value(), before = structuredClone(draft);
  await f.p.runHardening(draft);
  assert.deepEqual(f.errors, []); assert.ok(f.p.preview); assert.equal(f.samples.length, 1);
  assert.equal(f.samples[0].model, f.model);
  assert.ok(f.samples[0].candidates.length > 0 && f.samples[0].candidates.length <= 9);
  for (const candidate of f.samples[0].candidates) {
    const local = hardeningLocalFromGeo(candidate, reference);
    assert.ok(local.x > 0 && local.x < 40 && local.y > 0 && local.y < 20, 'sampling candidates must be inside the selected range');
  }
  const plan = f.p.preview.record as TemporaryWorksPlan;
  assert.equal(plan.hardening!.reference.height, 12); assert.equal(plan.inputs.reference.height, 12);
  assert.equal(plan.inputs.design.referenceHeight, 12);
  assert.equal(plan.initialElevation!.height, 12); assert.equal(plan.initialElevation!.sampleCount, 1);
  assert.equal(plan.inputs.sampleCount, 1);
  assert.equal(f.rendered.length, 1); assert.ok(f.rendered[0].vertices.length > 0);
  for (const vertex of f.rendered[0].vertices) {
    near(vertex.surfaceHeight, 12); near(vertex.baseHeight, 11.75);
  }
  assert.deepEqual(draft, before, 'sampling cannot mutate the submitted editor value');
  assert.deepEqual(f.resolved.at(-1), { ...reference, height: 12 });
});

test('automatic hardening persists its height and reopening uses manual elevation to preserve a later position offset', async () => {
  const f = fixture();
  await f.p.runHardening(value()); await f.p.save();
  assert.deepEqual(f.errors, []); assert.equal(f.saved.length, 1);
  const saved = f.saved[0]; assert.equal(saved.hardening!.reference.height, 12);
  const moved = translateTemporaryWorksPlan(saved, { east: 0, north: 0, up: 3 });
  f.p.records.set(moved.id, moved); f.p.editHardeningPlan(moved.id);
  const edit = f.p.hardeningEditor.getValue() as HardeningEditorValue;
  assert.equal(edit.initialElevationMode, 'manual'); assert.equal(edit.reference!.height, 15);
  f.p.readInitialElevation = async () => { assert.fail('saved adjusted hardening must not resample photography'); };
  await f.p.runHardening(edit as HardeningEditorValue);
  assert.deepEqual(f.errors, []); assert.equal(f.p.preview.replaceId, moved.id);
  assert.equal(f.p.preview.record.hardening.reference.height, 15);
  assert.ok(f.p.preview.record.mesh.vertices.every((vertex: { surfaceHeight: number }) => Math.abs(vertex.surfaceHeight - 15) < 1e-9));
  assert.equal(f.p.records.get(moved.id), moved, 'preview must not overwrite the saved source');
});

test('manual hardening works without photography sampling and keeps its explicit design height', async () => {
  const f = fixture(), draft = value({ initialElevationMode: 'manual' });
  f.p.readInitialElevation = async () => { assert.fail('manual initial elevation cannot invoke the sampler'); };
  await f.p.runHardening(draft);
  assert.deepEqual(f.errors, []); assert.ok(f.p.preview);
  assert.equal(f.p.preview.record.hardening.reference.height, 90);
  assert.ok(f.rendered[0].vertices.every(vertex => Math.abs(vertex.surfaceHeight - 90) < 1e-9));
});

test('missing photography height cannot publish provisional or zero-height hardening', async () => {
  const f = fixture(), draft = value(), before = structuredClone(draft);
  f.p.readInitialElevation = async () => { throw new Error('所选范围内未读取到有效倾斜摄影高程'); };
  await f.p.runHardening(draft);
  assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /未读取到有效倾斜摄影高程/);
  assert.equal(f.p.preview, undefined); assert.deepEqual(f.rendered, []); assert.deepEqual(f.resolved, []);
  assert.deepEqual(draft, before); assert.equal(f.p.analysis, undefined);
});

test('sloped automatic hardening anchors the sampled interior point while preserving its reference coordinates', async () => {
  const f = fixture(), draft = value({ slopeEnabled: true, gradeEastPct: 2, gradeNorthPct: -1 });
  await f.p.runHardening(draft);
  assert.deepEqual(f.errors, []); assert.equal(f.samples.length, 1);
  const plan = f.p.preview.record as TemporaryWorksPlan, config = plan.hardening!, sample = f.samples[0].result;
  assert.equal(config.reference.longitude, reference.longitude); assert.equal(config.reference.latitude, reference.latitude);
  const local = hardeningLocalFromGeo(sample, config.reference);
  near(config.reference.height + local.x * .02 - local.y * .01, sample.height, 1e-5);
  assert.notEqual(config.reference.height, sample.height, 'sampled point is away from the slope reference');
  for (const vertex of plan.mesh.vertices) {
    const point = hardeningLocalFromGeo(vertex, config.reference);
    near(vertex.surfaceHeight, config.reference.height + point.x * .02 - point.y * .01, 1e-5);
    near(vertex.surfaceHeight - vertex.baseHeight, .25);
  }
});

test('changing projects while automatic hardening elevation is pending cannot create a late preview', async () => {
  const f = fixture();
  let entered!: () => void, release!: (sample: InitialElevationSample) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<InitialElevationSample>(resolve => { release = resolve; });
  f.p.readInitialElevation = async () => { entered(); return response; };
  const running = f.p.runHardening(value()); await started;
  f.p.cancel(); f.p.generation++; f.p.projectId = 'project-b';
  release({ ...reference, height: 12, sampleCount: 1, candidateIndex: 0 }); await running;
  assert.equal(f.p.preview, undefined); assert.deepEqual(f.rendered, []); assert.deepEqual(f.resolved, []); assert.deepEqual(f.errors, []);
});
