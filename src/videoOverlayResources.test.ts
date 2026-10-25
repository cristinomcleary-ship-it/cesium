import assert from "node:assert/strict";
import test from "node:test";
import {
  Appearance, BoundingSphere, Cartesian3, Color, CustomDataSource, CustomShader,
  CustomShaderTranslucencyMode, EllipsoidTerrainProvider, Cartographic, Event, GroundPolylinePrimitive, JulianDate, Matrix3, Matrix4,
  PolygonHierarchy, PolylineColorAppearance, Primitive, PrimitiveCollection,
  Transforms, UniformType, type Viewer,
} from "cesium";
import { findVideoOverlayGroupCenter, validateVideoOverlayAdjustment, validateVideoOverlayGroupAdjustment, videoOverlayAdjustmentMatrix, VideoOverlayResources, type VideoOverlayGroupAdjustment } from "./videoOverlayResources.ts";
import type { CadImportPackage } from "./cadImport.ts";
import type { LibraryRecord } from "./projectLibrary.ts";
import type { ImportRecord } from "./types.ts";
import { loadCadPrimitiveCollection } from "./cadPrimitiveLoader.ts";
import { getCadGeometrySchedulerStats } from "./cadGeometryScheduler.ts";

const center = Cartesian3.fromDegrees(120, 30, 25);
const base = Transforms.eastNorthUpToFixedFrame(center);
function viewer(primitives = new PrimitiveCollection(), autoCompile = true, onCompile?: (primitive: Primitive) => void): Viewer {
  const postRender = new Event();
  let queued = false;
  const installed = new WeakSet<object>();
  const installCompiler = (resource: unknown) => {
    if (!resource || typeof resource !== 'object' || installed.has(resource)) return;
    installed.add(resource);
    if (resource instanceof PrimitiveCollection) {
      const add = resource.add;
      resource.add = (primitive, index) => {
        // Install the CPU leaf before the scheduler captures and wraps update.
        installCompiler(primitive);
        return add.call(resource, primitive, index);
      };
      for (let index = 0; index < resource.length; index++) installCompiler(resource.get(index));
    } else if (resource instanceof Primitive) {
      (resource as unknown as { update(): void }).update = () => {
        onCompile?.(resource);
        (resource as unknown as { _ready: boolean })._ready = true;
      };
    } else if (resource instanceof GroundPolylinePrimitive) {
      // The already-loaded ground source has no GPU context in this unit test.
      (resource as unknown as { update(): void }).update = () => {};
    }
  };
  if (autoCompile) installCompiler(primitives);
  return { terrainProvider: new EllipsoidTerrainProvider(), clock: { currentTime: JulianDate.now() }, scene: { primitives, postRender, requestRender() {
    if (!autoCompile || queued || !postRender.numberOfListeners) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // Real collection updates exercise hidden compilation and queue permits.
      (primitives as unknown as { update(frameState: object): void }).update({});
      postRender.raiseEvent();
    });
  } } } as unknown as Viewer;
}
function model(id: string, show = true) {
  const resource = { show, modelMatrix: Matrix4.clone(base), boundingSphere: new BoundingSphere(center, 20), isDestroyed: () => false };
  return { record: { id, name: id, kind: "Model", visible: show, resource } as ImportRecord, resource };
}
function localDisplacement(actual: Cartesian3, anchor = center): Cartesian3 {
  return Matrix4.multiplyByPoint(Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(anchor), new Matrix4()), actual, new Cartesian3());
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`); }
function closePoint(actual: Cartesian3, expected: Cartesian3) {
  assert.ok(Cartesian3.distance(actual, expected) < 1e-6, `${actual} differs from ${expected}`);
}

test('old saved offsets and zero tilts retain the exact legacy heading matrix', () => {
  for (const heading of [-143.7, -90, 0, 63.24, 180, 720]) {
    const old = { east: 11, north: -7, up: 4, heading };
    const normalizedHeading = ((heading + 180) % 360 + 360) % 360 - 180;
    const local = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(-normalizedHeading * Math.PI / 180), new Cartesian3(11, -7, 4));
    const expected = Matrix4.multiply(Matrix4.multiply(base, local, new Matrix4()), Matrix4.inverseTransformation(base, new Matrix4()), new Matrix4());
    assert.ok(Matrix4.equals(videoOverlayAdjustmentMatrix(center, old), expected));
    assert.ok(Matrix4.equals(videoOverlayAdjustmentMatrix(center, { ...old, tiltEast: 0, tiltNorth: 0 }), expected));
    assert.deepEqual(validateVideoOverlayAdjustment(old), { ...old, heading: normalizedHeading, tiltEast: 0, tiltNorth: 0 });
  }
});

test('fixed ENU tilts raise the named side, follow heading, and keep the pivot at its requested translation', () => {
  const point = (x: number, y: number) => Matrix4.multiplyByPoint(base, new Cartesian3(x, y, 0), new Cartesian3());
  const zero = { east: 0, north: 0, up: 0, heading: 0 };
  const east = videoOverlayAdjustmentMatrix(center, { ...zero, tiltEast: 30 });
  closePoint(localDisplacement(Matrix4.multiplyByPoint(east, point(10, 0), new Cartesian3())), new Cartesian3(Math.sqrt(75), 0, 5));
  const north = videoOverlayAdjustmentMatrix(center, { ...zero, tiltNorth: 30 });
  closePoint(localDisplacement(Matrix4.multiplyByPoint(north, point(0, 10), new Cartesian3())), new Cartesian3(0, Math.sqrt(75), 5));
  const composed = videoOverlayAdjustmentMatrix(center, { east: 2, north: 3, up: 4, heading: 90, tiltEast: 60, tiltNorth: 30 });
  // Heading first sends east toward south; north tilt sends it downward; east tilt then changes x/z.
  closePoint(localDisplacement(Matrix4.multiplyByPoint(composed, point(10, 0), new Cartesian3())), new Cartesian3(2 + Math.sqrt(18.75), 3 - Math.sqrt(75), 1.5));
  closePoint(localDisplacement(Matrix4.multiplyByPoint(composed, center, new Cartesian3())), new Cartesian3(2, 3, 4));
  for (const tilt of [-90, 90]) assert.doesNotThrow(() => validateVideoOverlayAdjustment({ ...zero, tiltEast: tilt, tiltNorth: tilt }));
});

test('invalid tilt patches reject atomically and valid angle-only edits never accumulate', async () => {
  const first = model('a'), second = model('b');
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record, second.record], getRecord: () => undefined });
  try {
    for (const key of ['tiltEast', 'tiltNorth'] as const) {
      for (const invalid of [90.001, -90.001, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => session.applyAdjustments({ a: { east: 2 }, b: { [key]: invalid } }), /倾角|有限数值/);
        assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
        assert.ok(Matrix4.equals(second.resource.modelMatrix, base));
        assert.equal(session.getAdjustments().a.east, 0);
      }
    }
    session.applyAdjustments({ a: { tiltEast: 12, tiltNorth: -8 } });
    const once = Matrix4.clone(first.resource.modelMatrix);
    for (let index = 0; index < 20; index++) session.applyAdjustments({ a: { tiltEast: 12, tiltNorth: -8 } });
    assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
    session.applyAdjustments({ a: { tiltEast: 20 } });
    assert.ok(!Matrix4.equals(first.resource.modelMatrix, once), 'tilt-only edits must invalidate the current matrix');
    assert.equal(session.getAdjustments().a.tiltNorth, -8, 'partial edits preserve the other tilt');
    session.applyAdjustments({ a: { tiltEast: 12 } });
    assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
    const saved = JSON.parse(JSON.stringify(session.getAdjustments()));
    assert.equal(saved.a.tiltEast, 12); assert.equal(saved.a.tiltNorth, -8);
    session.applyAdjustments({ a: { tiltEast: 0, tiltNorth: 0 } });
    assert.ok(Matrix4.equals(first.resource.modelMatrix, base), 'zero restores the exact original matrix');
    session.applyAdjustments(saved);
    assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
  } finally { session.restore(); }
  assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
});

test('one fixed group tilt moves distant engineering objects rigidly, preserves individual edits and leaves survey tiles fixed', async () => {
  const first = model('a'), second = model('b'), survey = model('survey');
  const farCenter = Matrix4.multiplyByPoint(base, new Cartesian3(1_200, 800, 40), new Cartesian3());
  const farBase = Transforms.eastNorthUpToFixedFrame(farCenter);
  second.resource.modelMatrix = Matrix4.clone(farBase);
  second.resource.boundingSphere = new BoundingSphere(farCenter, 20);
  survey.record.kind = '3D Tiles';
  survey.resource.boundingSphere = new BoundingSphere(Cartesian3.fromDegrees(121, 32), 100_000);
  const imports = [first.record, second.record, survey.record];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  const zero = { east: 0, north: 0, up: 0, heading: 0, tiltEast: 0, tiltNorth: 0 };
  const pivot = session.getGroupCenter()!;
  const group: VideoOverlayGroupAdjustment = { anchor: [pivot.x, pivot.y, pivot.z], values: { ...zero, tiltEast: 12, tiltNorth: -7, up: 3 } };
  try {
    closePoint(pivot, BoundingSphere.fromPoints([center, farCenter]).center);
    session.setSelection(['a']);
    session.applyAdjustments({ a: { east: 5, heading: 13, tiltNorth: 2 }, b: { north: 7 } });
    const individualFirst = Matrix4.clone(first.resource.modelMatrix), individualSecond = Matrix4.clone(second.resource.modelMatrix);
    const firstPoint = Matrix4.getTranslation(individualFirst, new Cartesian3());
    const secondPoint = Matrix4.getTranslation(individualSecond, new Cartesian3());
    const individualValues = session.getAdjustments();
    session.applyAdjustments({}, group);
    const transform = videoOverlayAdjustmentMatrix(pivot, group.values);
    assert.ok(Matrix4.equalsEpsilon(first.resource.modelMatrix, Matrix4.multiply(transform, individualFirst, new Matrix4()), 1e-8));
    assert.ok(Matrix4.equalsEpsilon(second.resource.modelMatrix, Matrix4.multiply(transform, individualSecond, new Matrix4()), 1e-8), 'hidden objects share the same correction');
    close(Cartesian3.distance(Matrix4.getTranslation(first.resource.modelMatrix, new Cartesian3()), Matrix4.getTranslation(second.resource.modelMatrix, new Cartesian3())), Cartesian3.distance(firstPoint, secondPoint));
    assert.deepEqual(session.getAdjustments(), individualValues, 'group edits never overwrite individual offsets');
    assert.ok(Matrix4.equals(survey.resource.modelMatrix, base), 'survey camera reference remains at its original map matrix');
    closePoint(session.getGroupCenter()!, pivot);
    session.setSelection(['b']);
    closePoint(session.getGroupCenter()!, pivot);
    const once = Matrix4.clone(first.resource.modelMatrix);
    for (let index = 0; index < 10; index++) session.applyAdjustments({}, group);
    assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
    session.applyAdjustments({}, { ...group, values: { ...group.values, tiltEast: 14 } });
    assert.ok(!Matrix4.equals(first.resource.modelMatrix, once), 'group-only edits must update every engineering object');
    session.applyAdjustments({}, group);
    assert.ok(Matrix4.equals(first.resource.modelMatrix, once), 'undo restores the same fixed-pivot result');
    const saved = JSON.parse(JSON.stringify({ individual: session.getAdjustments(), group }));
    session.applyAdjustments({}, { ...group, values: zero });
    assert.ok(Matrix4.equals(first.resource.modelMatrix, individualFirst));
    assert.ok(Matrix4.equals(second.resource.modelMatrix, individualSecond));
    session.applyAdjustments(saved.individual, saved.group);
    assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
    session.applyAdjustments({ a: zero, b: zero });
    assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
    assert.ok(Matrix4.equals(second.resource.modelMatrix, farBase));
    session.applyAdjustments(saved.individual, saved.group);
  } finally { session.restore(); }
  assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
  assert.ok(Matrix4.equals(second.resource.modelMatrix, farBase));
  assert.ok(Matrix4.equals(survey.resource.modelMatrix, base));
});

test('invalid group anchors and angles reject the full edit without changing session geometry', async () => {
  const first = model('a');
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  const group: VideoOverlayGroupAdjustment = { anchor: [center.x, center.y, center.z], values: { east: 0, north: 0, up: 0, heading: 0, tiltEast: 5 } };
  try {
    session.applyAdjustments({}, group);
    const original = Matrix4.clone(first.resource.modelMatrix);
    for (const invalid of [
      { ...group, anchor: [0, 0, 0] }, { ...group, anchor: [center.x, Number.NaN, center.z] },
      { ...group, anchor: [center.x, center.y] }, { ...group, values: { ...group.values, tiltEast: 91 } },
    ]) {
      assert.throws(() => session.applyAdjustments({ a: { east: 20 } }, invalid as VideoOverlayGroupAdjustment), /地理中心|倾角/);
      assert.ok(Matrix4.equals(first.resource.modelMatrix, original));
      assert.equal(session.getAdjustments().a.east, 0);
    }
    const normalized = validateVideoOverlayGroupAdjustment(group);
    normalized.anchor[0] = 0; normalized.values.tiltEast = 90;
    assert.equal(group.anchor[0], center.x); assert.equal(group.values.tiltEast, 5);
    session.applyAdjustments({}, group);
    assert.ok(Matrix4.equals(first.resource.modelMatrix, original));
  } finally { session.restore(); }
});

test('disjoint CAD layouts cannot put a new group pivot inside Earth or launch nearby geometry kilometres away', async () => {
  const nearby = [center, Matrix4.multiplyByPoint(base, new Cartesian3(20, 0, 0), new Cartesian3())];
  const remote = [Cartesian3.fromDegrees(50, 10, 25), Cartesian3.fromDegrees(50.001, 10, 25)];
  const positionsBefore = [...nearby, ...remote].map(point => Cartesian3.clone(point));
  const bounds = BoundingSphere.fromPoints([...nearby, ...remote]);
  const leaf = { show: true, modelMatrix: Matrix4.clone(Matrix4.IDENTITY), isDestroyed: () => false, destroy() {} };
  const root = Object.assign(new PrimitiveCollection(), { cadPolylineFeatures: [{ positions: nearby }, { positions: remote }] });
  root.add(leaf);
  const record: ImportRecord = { id: 'cad', name: 'disjoint-layouts', kind: 'CAD', representation: 'primitive', resource: root, visible: true, boundingSphere: bounds };
  const camera = Matrix4.multiplyByPoint(base, new Cartesian3(0, 0, 100), new Cartesian3());
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [record], getRecord: () => undefined });
  const values = { east: 0, north: 0, up: 0, heading: 0, tiltEast: .1, tiltNorth: 0 };
  try {
    assert.ok(bounds.radius > 1_000_000);
    assert.ok(Cartographic.fromCartesian(bounds.center).height < -100_000);
    const bad = videoOverlayAdjustmentMatrix(bounds.center, values);
    assert.ok(Cartesian3.distance(Matrix4.multiplyByPoint(bad, nearby[1], new Cartesian3()), nearby[1]) > 1000);
    const pivot = session.getGroupCenter(camera)!;
    closePoint(pivot, center);
    assert.ok(Matrix4.equals(leaf.modelMatrix, Matrix4.IDENTITY), 'choosing a pivot never edits geometry');
    session.setSelection([]); closePoint(session.getGroupCenter(camera)!, pivot);
    session.setSelection(['cad']); closePoint(session.getGroupCenter(camera)!, pivot);
    const group: VideoOverlayGroupAdjustment = { anchor: [pivot.x, pivot.y, pivot.z], values };
    session.applyAdjustments({}, group);
    const once = Matrix4.clone(leaf.modelMatrix);
    assert.ok(Cartesian3.distance(Matrix4.multiplyByPoint(once, nearby[1], new Cartesian3()), nearby[1]) < .1);
    const saved = JSON.parse(JSON.stringify(group));
    session.applyAdjustments({}, { ...group, values: { ...values, tiltEast: .2 } });
    session.applyAdjustments({}, saved);
    assert.ok(Matrix4.equals(leaf.modelMatrix, once), 'saved/undo state keeps the exact local pivot');
    session.applyAdjustments({});
    assert.ok(Matrix4.equals(leaf.modelMatrix, Matrix4.IDENTITY));
    session.applyAdjustments({}, saved);
    assert.ok(Matrix4.equals(leaf.modelMatrix, once), 'reapplying saved correction never recalculates its anchor');
    assert.deepEqual([...nearby, ...remote], positionsBefore, 'remote geometry is retained without filtering or rewriting');
  } finally { session.restore(); root.destroy(); }
});

test('new CAD group pivots use actual current matrices or entity heights, and never use unprepared ground bounds', async () => {
  const camera = Matrix4.multiplyByPoint(base, new Cartesian3(0, 0, 100), new Cartesian3());
  const data = new CustomDataSource('sampled');
  const line = data.entities.add({ polyline: { positions: [center, Matrix4.multiplyByPoint(base, new Cartesian3(20, 0, 0), new Cartesian3())], clampToGround: false } });
  const record: ImportRecord = { id: 'entity', name: 'sampled', kind: 'CAD', representation: 'dataSource', resource: data, visible: true };
  const view = viewer(), session = await VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined });
  try {
    session.applyAdjustments({ entity: { east: 3, up: 5 } });
    closePoint(session.getGroupCenter(camera)!, line.polyline!.positions!.getValue(view.clock.currentTime)[0]);
  } finally { session.restore(); }
  const original = videoOverlayAdjustmentMatrix(center, { east: 3, north: 0, up: 5, heading: 0 });
  const root = Object.assign(new PrimitiveCollection(), { cadPolylineFeatures: [{ positions: [center] }] });
  root.add({ modelMatrix: original, show: true, destroy() {} });
  try {
    const primitiveRecord: ImportRecord = { ...record, resource: root, representation: 'primitive' };
    closePoint(findVideoOverlayGroupCenter([primitiveRecord], camera, view.clock.currentTime)!, Matrix4.multiplyByPoint(original, center, new Cartesian3()));
    const ground = new PrimitiveCollection(); ground.add(groundSource());
    try {
      assert.equal(findVideoOverlayGroupCenter([{ ...primitiveRecord, resource: ground, boundingSphere: new BoundingSphere(center, 20) }], camera, view.clock.currentTime), undefined);
    } finally { ground.destroy(); }
  } finally { root.destroy(); }
});

test('face-only primitive CAD retains actual pivot candidates independently of polyline collision data', async () => {
  const value: CadImportPackage = { format: 'cesium-cad-import', version: 2,
    source: { name: 'faces.dwg', format: 'DWG', generatedAt: '' }, warnings: [],
    statistics: { sourceEntities: 1, displayEntities: 1, skippedEntities: 0, unknownEntities: 0, layers: ['0'] },
    entities: [{ type: '3DFACE', sourceType: 'SOLID', layer: '0', vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }] }],
  };
  const result = await loadCadPrimitiveCollection(value, { mode: 'local', longitude: 120, latitude: 30, altitude: 25, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 });
  try {
    assert.equal(result.cadPolylineFeatures.length, 0);
    assert.equal(result.collection.cadFacePositions.length, 1);
    const reference = Matrix4.multiplyByPoint(base, new Cartesian3(0, 0, 100), new Cartesian3());
    const record: ImportRecord = { id: 'face', name: 'face', kind: 'CAD', representation: 'primitive', resource: result.collection, visible: true, boundingSphere: result.boundingSphere };
    closePoint(findVideoOverlayGroupCenter([record], reference, JulianDate.now())!, center);
  } finally { result.collection.destroy(); }
});

function primitivePivot(points: Cartesian3[], reference: Cartesian3, matrix?: Matrix4): Cartesian3 | undefined {
  const resource = Object.assign(new PrimitiveCollection({ destroyPrimitives: false }), { cadPolylineFeatures: [{ positions: points }] });
  if (matrix) resource.add({ modelMatrix: matrix, show: true });
  const record: ImportRecord = { id: 'synthetic', name: 'synthetic', kind: 'CAD', representation: 'primitive', resource, visible: true };
  try { return findVideoOverlayGroupCenter([record], reference, JulianDate.now()); }
  finally { resource.destroy(); }
}

// Reference the Cesium operations used before the allocation-free scan. These
// tests exercise numerical edge cases without changing accepted CAD geometry.
function legacyPrimitivePivot(points: Cartesian3[], reference: Cartesian3, matrix?: Matrix4): Cartesian3 | undefined {
  let nearest: Cartesian3 | undefined, distance = Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z) || !(Cartesian3.magnitude(point) > 1)) continue;
    const world = matrix ? Matrix4.multiplyByPoint(matrix, point, new Cartesian3()) : point;
    const next = Cartesian3.distanceSquared(reference, world);
    if (Number.isFinite(next) && next < distance) { distance = next; nearest = Cartesian3.clone(world); }
  }
  return nearest;
}

test('group pivot scalar transforms exactly match Cesium for identity, affine and non-affine matrices', () => {
  const matrix = Matrix4.fromRowMajorArray([1.25, -.5, .75, 20, .25, 2, -.125, -10, -.75, .125, 3, 7, 2, 4, 6, 8]);
  const negativeZeroIdentity = Matrix4.fromRowMajorArray([1, -0, -0, -0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const points = [new Cartesian3(10, 20, 30), new Cartesian3(-0, 2, 3), new Cartesian3(25, -13, 42)];
  const reference = new Cartesian3(12, 19, 33);
  for (const transform of [undefined, Matrix4.IDENTITY, Matrix4.clone(Matrix4.IDENTITY), negativeZeroIdentity,
    Matrix4.fromTranslation(new Cartesian3(5, 6, 7)), matrix]) {
    assert.deepEqual(primitivePivot(points, reference, transform), legacyPrimitivePivot(points, reference, transform));
    // Check each zero component even when it would not be the nearest candidate.
    for (const point of [new Cartesian3(-0, 2, 3), new Cartesian3(2, -0, 3), new Cartesian3(2, 3, -0)]) {
      assert.deepEqual(primitivePivot([point], reference, transform), legacyPrimitivePivot([point], reference, transform));
    }
  }
  assert.deepEqual(points[1], new Cartesian3(-0, 2, 3), 'the scan never changes input coordinates');
});

test('group pivot scan preserves invalid-source rejection, magnitude rounding and finite-distance rules', () => {
  const nearUnit = new Cartesian3(1, Math.sqrt(Number.EPSILON), 0);
  assert.equal(Cartesian3.magnitude(nearUnit), 1, 'fixture exercises the rounded magnitude boundary');
  const points = [Cartesian3.ZERO, new Cartesian3(NaN, 2, 3), new Cartesian3(Infinity, 2, 3), nearUnit, new Cartesian3(3, 4, 5)];
  const reference = new Cartesian3(2, 0, 0);
  assert.deepEqual(primitivePivot(points, reference), points[4]);
  assert.deepEqual(primitivePivot(points, reference, Matrix4.IDENTITY), legacyPrimitivePivot(points, reference, Matrix4.IDENTITY));
  assert.equal(primitivePivot(points.slice(0, 4), reference, Matrix4.fromTranslation(new Cartesian3(100, 200, 300))), undefined);
  assert.equal(primitivePivot([points[4]], new Cartesian3(NaN, 2, 3)), undefined);
  const hugeReference = new Cartesian3(1e200, 0, 0);
  const hugePoints = [new Cartesian3(-1e200, 0, 0), new Cartesian3(1e200, 2, 0)];
  assert.deepEqual(primitivePivot(hugePoints, hugeReference, Matrix4.IDENTITY), hugePoints[1], 'finite points may have overflowing magnitudes, but their distance must be finite');
  assert.equal(primitivePivot([hugePoints[0]], hugeReference), undefined);
  const origin = primitivePivot([new Cartesian3(2, 3, 4)], reference, Matrix4.fromTranslation(new Cartesian3(-2, -3, -4)));
  assert.deepEqual(origin, Cartesian3.ZERO, 'source validity is checked before its transform');
});

test('group pivot nearest ties keep the first candidate and return an independent point', () => {
  const first = new Cartesian3(10, -2, 3), second = new Cartesian3(10, 2, 3), reference = new Cartesian3(10, 0, 3);
  for (const matrix of [undefined, Matrix4.IDENTITY]) {
    const result = primitivePivot([first, second], reference, matrix)!;
    assert.deepEqual(result, first);
    assert.notEqual(result, first);
    result.y = 123;
    assert.equal(first.y, -2);
  }
});

test('large synthetic CAD pivot scan retains the same exact winner with and without a matrix', () => {
  const points = Array.from({ length: 240_000 }, (_, index) => new Cartesian3(-2_800_000 + index % 10_000, 4_700_000 + index * 7 % 10_000, 3_250_000 + index % 20));
  const reference = new Cartesian3(-2_799_500, 4_700_500, 3_250_100);
  for (const matrix of [undefined, Matrix4.IDENTITY, Matrix4.fromTranslation(new Cartesian3(5, 6, 7))]) {
    assert.deepEqual(primitivePivot(points, reference, matrix), legacyPrimitivePivot(points, reference, matrix));
  }
  assert.deepEqual(points[0], new Cartesian3(-2_800_000, 4_700_000, 3_250_000));
});

test('group and individual corrections share the entity CAD picking and annotation frame and zero restores original properties', async () => {
  const data = new CustomDataSource('group');
  const points = [-300, 300].map(x => Matrix4.multiplyByPoint(base, new Cartesian3(x, x / 2, 0), new Cartesian3()));
  const line = data.entities.add({ polyline: { positions: points, clampToGround: false } });
  const label = data.entities.add({ position: center, label: { text: 'group' } });
  const lineProperty = line.polyline!.positions!, labelProperty = label.position!;
  const record: ImportRecord = { id: 'cad', name: 'cad', kind: 'CAD', representation: 'dataSource', resource: data, visible: true };
  const view = viewer(), session = await VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined });
  const pivot = session.getGroupCenter()!;
  const group: VideoOverlayGroupAdjustment = { anchor: [pivot.x, pivot.y, pivot.z], values: { east: 1, north: 2, up: 3, heading: 4, tiltEast: 8, tiltNorth: -6 } };
  try {
    session.setSelection(['cad']);
    const inverse = Matrix4.inverse(session.spatialFrame('cad')!, new Matrix4());
    const locals = points.map(point => Matrix4.multiplyByPoint(inverse, point, new Cartesian3()));
    const labelLocal = Matrix4.multiplyByPoint(inverse, center, new Cartesian3());
    session.applyAdjustments({ cad: { east: 3, tiltEast: 2 } }, group);
    const frame = session.spatialFrame('cad')!;
    const picked = session.spatialPickedLines('cad', { id: line })[0];
    locals.forEach((point, index) => closePoint(Matrix4.multiplyByPoint(frame, point, new Cartesian3()), picked[index]));
    closePoint(Matrix4.multiplyByPoint(frame, labelLocal, new Cartesian3()), label.position!.getValue(view.clock.currentTime)!);
    const once = line.polyline!.positions;
    session.applyAdjustments({}, group);
    assert.equal(line.polyline!.positions, once, 'unchanged group state does not allocate fresh entity properties');
    session.applyAdjustments({}, { ...group, values: { ...group.values, tiltEast: 10 } });
    assert.notEqual(line.polyline!.positions, once, 'changed group state updates entities even with unchanged individual offsets');
    session.applyAdjustments({ cad: { east: 0, tiltEast: 0 } });
    assert.equal(line.polyline!.positions, lineProperty); assert.equal(label.position, labelProperty);
    session.applyAdjustments({}, group);
  } finally { session.restore(); }
  assert.equal(line.polyline!.positions, lineProperty); assert.equal(label.position, labelProperty);
});

test('tilted entity CAD lines and saved annotation coordinates share the same transform and restore exactly', async () => {
  const data = new CustomDataSource('tilted');
  const at = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(base, new Cartesian3(x, y, z), new Cartesian3());
  const line = data.entities.add({ polyline: { positions: [at(-10, 0, -2), at(10, 0, 2)], clampToGround: false } });
  const label = data.entities.add({ position: at(0, 5, 0), label: { text: 'label' } });
  const polygon = data.entities.add({ polygon: { hierarchy: [at(0, 0, 0), at(4, 0, 1), at(0, 3, 2)], perPositionHeight: true } });
  const view = viewer(), time = view.clock.currentTime;
  const originalLine = line.polyline!.positions!, originalLabel = label.position!, originalPolygon = polygon.polygon!.hierarchy!;
  const record: ImportRecord = { id: 'cad', name: 'cad', kind: 'CAD', representation: 'dataSource', resource: data, visible: true };
  const session = await VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined });
  try {
    session.setSelection(['cad']);
    const beforeFrame = session.spatialFrame('cad')!;
    const inverse = Matrix4.inverse(beforeFrame, new Matrix4());
    const source = (originalLine.getValue(time) as Cartesian3[]).map(value => Cartesian3.clone(value));
    const annotation = source.map(value => Matrix4.multiplyByPoint(inverse, value, new Cartesian3()));
    const labelLocal = Matrix4.multiplyByPoint(inverse, originalLabel.getValue(time)!, new Cartesian3());
    const polygonLocal = (originalPolygon.getValue(time) as PolygonHierarchy).positions.map(value => Matrix4.multiplyByPoint(inverse, value, new Cartesian3()));
    session.applyAdjustments({ cad: { east: 3, north: -2, up: 1, heading: 19, tiltEast: 8, tiltNorth: -6 } });
    const afterFrame = session.spatialFrame('cad')!;
    const picked = session.spatialPickedLines('cad', { id: line })[0];
    annotation.forEach((local, index) => closePoint(Matrix4.multiplyByPoint(afterFrame, local, new Cartesian3()), picked[index]));
    closePoint(Matrix4.multiplyByPoint(afterFrame, labelLocal, new Cartesian3()), label.position!.getValue(time)!);
    polygonLocal.forEach((local, index) => closePoint(Matrix4.multiplyByPoint(afterFrame, local, new Cartesian3()), (polygon.polygon!.hierarchy!.getValue(time) as PolygonHierarchy).positions[index]));
    assert.ok(Cartesian3.distance(picked[0], source[0]) > 1, 'the geometry itself must move');
    const currentProperty = line.polyline!.positions;
    session.applyAdjustments({ cad: { tiltEast: 8, tiltNorth: -6 } });
    assert.equal(line.polyline!.positions, currentProperty, 'repeated angles do not rebuild CAD properties');
  } finally { session.restore(); }
  assert.equal(line.polyline!.positions, originalLine); assert.equal(label.position, originalLabel); assert.equal(polygon.polygon!.hierarchy, originalPolygon);
});

test('primitive CAD line picking and bound annotations follow both tilts with an existing source matrix', async () => {
  const original = videoOverlayAdjustmentMatrix(center, { east: 2, north: 4, up: 3, heading: 17 });
  const movedCenter = Matrix4.multiplyByPoint(original, center, new Cartesian3());
  const positions = [-10, 10].map(x => Matrix4.multiplyByPoint(base, new Cartesian3(x, 0, 1), new Cartesian3()));
  const feature = { id: 'line' };
  const leaf = { show: true, modelMatrix: Matrix4.clone(original), isDestroyed: () => false, destroy() {} };
  const root = Object.assign(new PrimitiveCollection(), { cadPolylineFeatures: [{ entity: feature, positions }] });
  root.add(leaf);
  const record: ImportRecord = { id: 'cad', name: 'cad', kind: 'CAD', representation: 'primitive', resource: root, visible: true, boundingSphere: new BoundingSphere(movedCenter, 20) };
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [record], getRecord: () => undefined });
  try {
    session.setSelection(['cad']);
    const inverse = Matrix4.inverse(session.spatialFrame('cad')!, new Matrix4());
    const picked = { id: feature, primitive: leaf };
    const locals = session.spatialPickedLines('cad', picked)[0].map(point => Matrix4.multiplyByPoint(inverse, point, new Cartesian3()));
    session.applyAdjustments({ cad: { tiltEast: -12, tiltNorth: 7 } });
    const tilted = session.spatialPickedLines('cad', picked)[0], frame = session.spatialFrame('cad')!;
    locals.forEach((local, index) => closePoint(Matrix4.multiplyByPoint(frame, local, new Cartesian3()), tilted[index]));
    closePoint(Matrix4.multiplyByPoint(leaf.modelMatrix, center, new Cartesian3()), movedCenter);
    session.applyAdjustments({ cad: { tiltEast: 0, tiltNorth: 0 } });
    assert.ok(Matrix4.equals(leaf.modelMatrix, original));
  } finally { session.restore(); root.destroy(); }
  assert.ok(Matrix4.equals(leaf.modelMatrix, original));
});

test("ENU edits are absolute, are video-local, and selection restores all imported layer visibility", async () => {
  const first = model("a"), second = model("b", false);
  const gis = { show: true };
  const imports = [first.record, second.record, { id: "gis", name: "gis", kind: "GIS", visible: true, resource: gis } as ImportRecord];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  assert.equal(gis.show, false);
  session.setSelection(["a", "b"]);
  assert.equal(first.resource.show, true);
  assert.equal(second.resource.show, true);
  assert.equal(second.record.visible, false);
  session.applyAdjustments({ a: { east: 10, north: 4, up: 3 } });
  const once = Matrix4.clone(first.resource.modelMatrix);
  session.applyAdjustments({ a: { east: 10, north: 4, up: 3 } });
  assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
  const position = localDisplacement(Matrix4.getTranslation(once, new Cartesian3()));
  close(position.x, 10); close(position.y, 4); close(position.z, 3);
  session.setVisible(false);
  assert.equal(first.resource.show, false);
  assert.equal(session.get("a")?.selected, true);
  session.setVisible(true);
  assert.equal(first.resource.show, true);
  const saved = session.getAdjustments();
  saved.a.east = 999;
  assert.equal(session.getAdjustments().a.east, 10);
  session.restore(); session.restore();
  assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
  assert.equal(first.resource.show, true);
  assert.equal(second.resource.show, false);
  assert.equal(gis.show, true);
  const restored = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  restored.applyAdjustments({ a: { east: 10, north: 4, up: 3 } });
  assert.ok(Matrix4.equals(first.resource.modelMatrix, once));
  restored.restore();
});

test("CAD entity lines, polygons including holes, and text retain sampled heights and restore original properties", async () => {
  const data = new CustomDataSource("sampled");
  const at = (east: number, north: number, up: number) => Matrix4.multiplyByPoint(base, new Cartesian3(east, north, up), new Cartesian3());
  const line = data.entities.add({ polyline: { positions: [at(0, 0, 12), at(10, 0, 15)], clampToGround: false } });
  const polygon = data.entities.add({ polygon: {
    hierarchy: new PolygonHierarchy([at(0, 0, 12), at(20, 0, 12), at(0, 20, 12)], [new PolygonHierarchy([at(2, 2, 12), at(3, 2, 12), at(2, 3, 12)])]),
    perPositionHeight: true,
  } });
  const label = data.entities.add({ position: at(3, 3, 17), label: { text: "sampled" } });
  const lineProperty = line.polyline!.positions, hierarchyProperty = polygon.polygon!.hierarchy, labelProperty = label.position;
  const imports = [{ id: "cad", name: "sampled", kind: "CAD", representation: "dataSource", visible: true, resource: data } as ImportRecord];
  const view = viewer();
  const time = view.clock.currentTime;
  const originalLine = lineProperty!.getValue(time) as Cartesian3[];
  const session = await VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
  assert.match(session.get("cad")!.description, /已采样/);
  session.applyAdjustments({ cad: { up: 5 } });
  const once = line.polyline!.positions!.getValue(time) as Cartesian3[];
  const adjustedLineProperty = line.polyline!.positions;
  assert.ok(Math.abs(Cartesian3.distance(once[0], originalLine[0]) - 5) < 1e-6);
  const hierarchy = polygon.polygon!.hierarchy!.getValue(time) as PolygonHierarchy;
  assert.equal(hierarchy.holes.length, 1);
  assert.ok(Cartesian3.distance(hierarchy.holes[0].positions[0], hierarchyProperty!.getValue(time).holes[0].positions[0]) > 4.99);
  session.applyAdjustments({ cad: { up: 5 } });
  assert.equal(line.polyline!.positions, adjustedLineProperty, 'repeating an offset must not replace every CAD property');
  assert.deepEqual(line.polyline!.positions!.getValue(time), once);
  session.restore();
  assert.equal(line.polyline!.positions, lineProperty);
  assert.equal(polygon.polygon!.hierarchy, hierarchyProperty);
  assert.equal(label.position, labelProperty);
});

test("recursive primitive CAD transforms leaves about the object's fixed center", async () => {
  const nested = new PrimitiveCollection(), root = new PrimitiveCollection();
  const leaf = { show: true, modelMatrix: Matrix4.clone(Matrix4.IDENTITY), isDestroyed: () => false, destroy() {} };
  nested.add(leaf); root.add(nested);
  const record: ImportRecord = { id: "cad", name: "cad", kind: "CAD", representation: "primitive", visible: true, resource: root, boundingSphere: new BoundingSphere(center, 30) };
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [record], getRecord: () => undefined });
  session.applyAdjustments({ cad: { heading: 90, east: 2 } });
  const eastPoint = Matrix4.multiplyByPoint(base, new Cartesian3(10, 0, 0), new Cartesian3());
  const moved = localDisplacement(Matrix4.multiplyByPoint(leaf.modelMatrix, eastPoint, new Cartesian3()));
  close(moved.x, 2); close(moved.y, -10); close(moved.z, 0);
  session.restore();
  assert.ok(Matrix4.equals(leaf.modelMatrix, Matrix4.IDENTITY));
  root.destroy();
});

const drawing: CadImportPackage = {
  format: "cesium-cad-import", version: 2,
  source: { name: "ground.dwg", format: "DWG", generatedAt: "2026-10-18T00:00:00Z" },
  statistics: { sourceEntities: 1, displayEntities: 1, skippedEntities: 0, unknownEntities: 0, layers: ["0"] },
  entities: [{ type: "POLYLINE", sourceType: "LINE", layer: "0", vertices: [{ x: 0, y: 0, z: 12 }, { x: 10, y: 0, z: 12 }] }], warnings: [],
};
function savedCad(): LibraryRecord {
  return { version: 1, id: "cad", name: "ground", kind: "CAD", visible: true, createdAt: "", updatedAt: "",
    files: { data: { name: "ground.cadimport", url: "/saved/ground.cadimport" } },
    settings: { displayMode: "terrain", coordinates: { mode: "local", longitude: 120, latitude: 30, altitude: 25, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 } },
  };
}

// No WebGL context is needed to test replacement of an already-loaded ground primitive.
function groundSource(): GroundPolylinePrimitive {
  return Object.assign(Object.create(GroundPolylinePrimitive.prototype), { show: true, isDestroyed: () => false, destroy() {} });
}

test("ground CAD freezes map surface height instead of restoring source Z, and destroys copy on exit", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(drawing), { status: 200 });
  const root = new PrimitiveCollection(), original = new PrimitiveCollection();
  original.add(groundSource()); root.add(original);
  const record: ImportRecord = { id: "cad", name: "ground", kind: "CAD", representation: "primitive", resource: original, visible: true };
  const compilationVisibility: boolean[] = [];
  const view = viewer(root, true, primitive => compilationVisibility.push(primitive.show));
  try {
    const session = await VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: savedCad });
    assert.equal(session.get("cad")!.available, true);
    assert.ok(compilationVisibility.length > 0, 'the hidden copy compiles through its update wrapper');
    assert.ok(compilationVisibility.every(show => !show), 'compiling the AR copy never draws it');
    assert.deepEqual(getCadGeometrySchedulerStats(view.scene), { active: 0, queued: 0, pending: 0, maxActive: 1 });
    assert.match(session.get("cad")!.description, /保留地图贴附表面高程/);
    assert.equal(root.length, 2);
    session.setSelection(["cad"]);
    assert.equal(original.show, false);
    const copy = root.get(1) as PrimitiveCollection;
    assert.equal(copy.show, true);
    const features = (copy as unknown as { cadPolylineFeatures: { positions: Cartesian3[] }[] }).cadPolylineFeatures;
    assert.ok(features[0].positions.length >= 3, 'Surface copy samples long segments between endpoints');
    for (const point of features[0].positions) close(Cartographic.fromCartesian(point).height, 0);
    const pivot = session.getGroupCenter(center)!;
    assert.ok(features[0].positions.some(point => Cartesian3.equalsEpsilon(point, pivot, 1e-12, 1e-6)));
    close(Cartographic.fromCartesian(pivot).height, 0);
    const sourceFrame = session.spatialFrame('cad')!;
    const originalPoint = Matrix4.getTranslation(sourceFrame, new Cartesian3());
    session.applyAdjustments({ cad: { up: 7, tiltEast: 9, tiltNorth: -4 } });
    assert.ok(!Matrix4.equals(copy.get(0).modelMatrix, Matrix4.IDENTITY));
    closePoint(Matrix4.getTranslation(session.spatialFrame('cad')!, new Cartesian3()),
      Matrix4.multiplyByPoint(copy.get(0).modelMatrix, originalPoint, new Cartesian3()));
    assert.equal(session.getAdjustments().cad.tiltEast, 9);
    assert.equal(session.getAdjustments().cad.tiltNorth, -4);
    session.restore();
    assert.equal(root.length, 1);
    assert.equal(original.show, true);
    assert.equal(copy.isDestroyed(), true);
  } finally { globalThis.fetch = fetchBefore; root.destroy(); }
});

test("cancel during ground source fetch restores every layer, including non-CAD resources", async () => {
  const fetchBefore = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    queueMicrotask(() => controller.abort());
  });
  const root = new PrimitiveCollection(), original = new PrimitiveCollection();
  original.add(groundSource()); root.add(original);
  const gis = { show: true };
  const imports: ImportRecord[] = [
    { id: "cad", name: "ground", kind: "CAD", representation: "primitive", resource: original, visible: true },
    { id: "gis", name: "gis", kind: "GIS", resource: gis, visible: true },
  ];
  try {
    await assert.rejects(VideoOverlayResources.create({ viewer: viewer(root), imports: () => imports, getRecord: savedCad, signal: controller.signal }), { name: "AbortError" });
    assert.equal(original.show, true);
    assert.equal(gis.show, true);
    assert.equal(root.length, 1);
  } finally { globalThis.fetch = fetchBefore; root.destroy(); }
});

test("invalid offsets fail before touching any valid object", async () => {
  const first = model("a"), second = model("b");
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record, second.record], getRecord: () => undefined });
  assert.throws(() => session.applyAdjustments({ a: { east: 1 }, b: { up: Number.NaN } }), /有限数值/);
  assert.ok(Matrix4.equals(first.resource.modelMatrix, base));
  session.restore();
});


test("restored CAD waits for the geometry worker before snapshotting and applying offsets", async () => {
  const root = new PrimitiveCollection(), nested = new PrimitiveCollection({ show: false });
  const leaf = new Primitive(), originallyHidden = new Primitive({ show: false });
  (originallyHidden as unknown as { _ready: boolean })._ready = true;
  nested.add(leaf); nested.add(originallyHidden); root.add(nested);
  const sceneRoot = new PrimitiveCollection(); sceneRoot.add(root);
  const record: ImportRecord = { id: "cad", name: "restored", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
  const view = viewer(sceneRoot, false);
  let resolved = false;
  const creating = VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined }).then(value => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false, "ready library records alone do not mean GPU geometry has compiled");
  assert.equal(root.show, true); assert.equal(nested.show, true);
  assert.equal(leaf.show, false); assert.equal(originallyHidden.show, false, "compilation cannot expose CAD");
  // Match Cesium's asynchronous combine callback, which writes its captured matrix.
  leaf.modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
  (leaf as unknown as { _ready: boolean })._ready = true;
  view.scene.postRender.raiseEvent(view.scene, view.clock.currentTime);
  const session = await creating;
  assert.equal(root.show, false); assert.equal(nested.show, false);
  assert.equal(leaf.show, true); assert.equal(originallyHidden.show, false);
  session.setSelection(["cad"]); session.applyAdjustments({ cad: { east: 3, north: -2, up: 29 } });
  const moved = localDisplacement(Matrix4.multiplyByPoint(leaf.modelMatrix, center, new Cartesian3()));
  close(moved.x, 3); close(moved.y, -2); close(moved.z, 29);
  assert.equal(view.scene.postRender.numberOfListeners, 0);
  session.restore();
  assert.equal(root.show, true); assert.equal(nested.show, false); assert.equal(leaf.show, true);
  assert.ok(Matrix4.equals(leaf.modelMatrix, Matrix4.IDENTITY));
  sceneRoot.destroy();
});

test("cancelling CAD compilation restores the user's layer and removes readiness listeners", async () => {
  const root = new PrimitiveCollection(), leaf = new Primitive(); root.add(leaf);
  const controller = new AbortController(), view = viewer(new PrimitiveCollection(), false);
  const record: ImportRecord = { id: "cad", name: "pending", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
  const creating = VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined, signal: controller.signal });
  controller.abort();
  await assert.rejects(creating, { name: "AbortError" });
  assert.equal(root.show, true); assert.equal(leaf.show, true);
  assert.equal(view.scene.postRender.numberOfListeners, 0);
  root.destroy();
});

test("CAD removed or denied during compilation stays unavailable and hidden", async () => {
  for (const destroy of [false, true]) {
    const root = new PrimitiveCollection(), leaf = new Primitive(); root.add(leaf);
    const view = viewer(new PrimitiveCollection(), false);
    const record: ImportRecord = { id: "cad", name: "pending", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
    let imports = [record];
    const creating = VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
    if (destroy) root.destroy(); else imports = [];
    view.scene.postRender.raiseEvent(view.scene, view.clock.currentTime);
    const session = await creating;
    assert.equal(session.get("cad")?.available, false);
    session.setSelection(["cad"]);
    if (!destroy) assert.equal(root.show, false);
    assert.equal(view.scene.postRender.numberOfListeners, 0);
    session.restore();
    if (!destroy) root.destroy();
  }
});


test("CAD compilation timeout is bounded and restores temporary visibility", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const root = new PrimitiveCollection(), leaf = new Primitive(); root.add(leaf);
  const view = viewer(new PrimitiveCollection(), false);
  const record: ImportRecord = { id: "cad", name: "pending", kind: "CAD", representation: "primitive", resource: root, visible: true, boundingSphere: new BoundingSphere(center, 20) };
  const creating = VideoOverlayResources.create({ viewer: view, imports: () => [record], getRecord: () => undefined });
  context.mock.timers.tick(60_000);
  const session = await creating;
  assert.equal(session.get("cad")?.available, false);
  assert.match(session.get("cad")?.error ?? "", /准备超时/);
  assert.equal(root.show, false); assert.equal(leaf.show, true);
  assert.equal(view.scene.postRender.numberOfListeners, 0);
  session.restore(); assert.equal(root.show, true);
  root.destroy();
});

test('resource lookup stays linear and unchanged frames never rewrite visibility or zero transforms', async () => {
  const models = Array.from({ length: 80 }, (_, index) => model(`model-${index}`));
  const imports = models.map(item => item.record);
  let reads = 0, shows = 0, matrices = 0, renders = 0;
  for (const { resource } of models) {
    let show = resource.show, matrix = resource.modelMatrix;
    Object.defineProperty(resource, 'show', { get: () => show, set: value => { shows++; show = value; }, configurable: true });
    Object.defineProperty(resource, 'modelMatrix', { get: () => matrix, set: value => { matrices++; matrix = value; }, configurable: true });
  }
  const view = viewer(); view.scene.requestRender = () => { renders++; };
  const session = await VideoOverlayResources.create({ viewer: view, imports: () => { reads++; return imports; }, getRecord: () => undefined });
  session.setSelection(imports.map(item => item.id));
  reads = shows = matrices = renders = 0;
  assert.equal(session.list().length, imports.length); assert.equal(reads, 1);
  assert.equal(session.get('model-40')?.available, true); assert.equal(reads, 2);
  reads = 0;
  for (let frame = 0; frame < 30; frame++) session.setVisible(true);
  assert.equal(reads, 30, 'one import snapshot per frame, independent of layer count');
  assert.equal(shows, 0); assert.equal(renders, 0);
  reads = 0;
  session.applyAdjustments(Object.fromEntries(imports.map(item => [item.id, { east: 0, north: 0, up: 0, heading: 0 }])));
  assert.equal(reads, 1); assert.equal(matrices, 0); assert.equal(renders, 0);
  session.restore();
  assert.equal(shows, 0); assert.equal(matrices, 0, 'untouched map matrices need no restoration setter');
});

test('unchanged entity CAD playback emits no per-entity visibility changes and still applies revocation', async () => {
  const data = new CustomDataSource('entity-cad');
  let events = 0;
  for (let index = 0; index < 40; index++) {
    const entity = data.entities.add({ polyline: { positions: [center, Cartesian3.add(center, new Cartesian3(index + 1, 2, 3), new Cartesian3())], clampToGround: false } });
    entity.definitionChanged.addEventListener((_entity, property) => { if (property === 'isShowing') events++; });
  }
  let imports = [{ id: 'cad', name: 'entity-cad', kind: 'CAD', representation: 'dataSource', resource: data, visible: true } as ImportRecord];
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => imports, getRecord: () => undefined });
  session.setSelection(['cad']); events = 0;
  for (let frame = 0; frame < 30; frame++) session.setVisible(true);
  assert.equal(events, 0, 'selected CAD must not be hidden and re-shown each video frame');
  imports = []; session.setVisible(true);
  assert.equal(data.show, false); assert.equal(events, data.entities.values.length);
  session.restore();
});

test('model effects preserve material alpha and original shader, reuse one translucent shader and never compound', async () => {
  const first = model('model');
  const original = new CustomShader({
    uniforms: { u_original: { type: UniformType.FLOAT, value: .6 } },
    fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.alpha *= u_original; }',
  });
  const resource = Object.assign(first.resource, { customShader: original, color: Color.RED.withAlpha(.7), ready: true, _drawCommandsBuilt: true });
  const originalColor = resource.color;
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  session.setSelection(['model']);
  session.setTimelineOpacity({ model: { opacity: 1, visible: true } });
  assert.equal(resource.customShader, original, 'old plans need no shader replacement');
  session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
  const owned = resource.customShader;
  assert.notEqual(owned, original);
  assert.equal(owned.translucencyMode, CustomShaderTranslucencyMode.TRANSLUCENT);
  assert.equal(owned.uniforms.u_original, original.uniforms.u_original);
  assert.match(owned.fragmentShaderText, /arOriginalFragmentMain\(fsInput, material\)/);
  assert.match(owned.fragmentShaderText, /material.alpha \*= u_arPresentationOpacity/);
  assert.equal(owned.uniforms.u_arPresentationOpacity.value, .5);
  for (let frame = 0; frame < 20; frame++) session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
  assert.equal(resource.customShader, owned); assert.equal(owned.uniforms.u_arPresentationOpacity.value, .5);
  assert.equal(resource.color, originalColor); assert.equal(resource.color.alpha, .7);
  session.setTimelineOpacity({ model: { opacity: 0, visible: false } });
  assert.equal(resource.show, false); assert.equal(session.get('model')?.selected, true);
  session.setTimelineOpacity({ model: { opacity: 1, visible: true } });
  assert.equal(resource.show, true); assert.equal(resource.customShader, owned);
  assert.equal(owned.uniforms.u_arPresentationOpacity.value, 1);
  session.restore();
  assert.equal(resource.customShader, original); assert.equal(resource.color, originalColor);
  assert.equal(owned.isDestroyed(), true); assert.equal(original.isDestroyed(), false);
  original.destroy();
});

test('AR opacity exit never restores a shader destroyed by its original owner', async () => {
  for (const kind of ['Model', '3D Tiles'] as const) for (const replaced of [false, true]) {
    const first = model('model'); first.record.kind = kind;
    const original = new CustomShader({ fragmentShaderText: 'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { material.alpha *= 0.7; }' });
    const resource = Object.assign(first.resource, { customShader: original as CustomShader | undefined, color: Color.RED.withAlpha(.7) });
    const matrix = Matrix4.clone(resource.modelMatrix), color = resource.color;
    const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
    session.setSelection(['model']); session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
    const owned = resource.customShader!;
    original.destroy();
    const external = replaced ? new CustomShader({}) : undefined;
    if (external) resource.customShader = external;
    assert.doesNotThrow(() => { session.restore(); session.restore(); });
    assert.equal(resource.customShader, external, 'only a live external owner may remain; a destroyed previous shader cannot be restored');
    assert.equal(original.isDestroyed(), true); assert.equal(owned.isDestroyed(), true);
    assert.equal(resource.color, color); assert.equal(resource.color.alpha, .7);
    assert.ok(Matrix4.equals(resource.modelMatrix, matrix)); assert.equal(resource.show, true);
    assert.equal(first.record.visible, true, 'saved layer visibility is unchanged');
    if (external) { assert.equal(external.isDestroyed(), false); external.destroy(); }
  }
});

test('model command rebuild readiness gates fused output while alpha-hidden or unselected objects do not block', async () => {
  const first = model('model');
  const resource = Object.assign(first.resource, { ready: false, _drawCommandsBuilt: false });
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  assert.equal(session.isPresentationReady(), true);
  session.setSelection(['model']); assert.equal(session.isPresentationReady(), false);
  resource.ready = true; assert.equal(session.isPresentationReady(), false);
  resource._drawCommandsBuilt = true; assert.equal(session.isPresentationReady(), true);
  resource._drawCommandsBuilt = false;
  session.setTimelineOpacity({ model: { opacity: 0, visible: false } });
  assert.equal(session.isPresentationReady(), true);
  session.setTimelineOpacity({ model: { opacity: .2, visible: true } });
  assert.equal(session.isPresentationReady(), false);
  resource._drawCommandsBuilt = true; assert.equal(session.isPresentationReady(), true);
  session.restore(); assert.equal(session.isPresentationReady(), false);
});

test('primitive CAD fading retains original depth shader, uses one numeric uniform and restores appearance', async () => {
  const appearance = new PolylineColorAppearance({
    translucent: false,
    fragmentShaderSource: 'in vec4 v_color; void main() { out_FragColor = v_color; czm_writeLogDepth(); }',
  });
  const primitive = new Primitive({ appearance });
  const collection = new PrimitiveCollection(); collection.add(primitive);
  const record: ImportRecord = { id: 'cad', name: 'cad', kind: 'CAD', representation: 'primitive', resource: collection, visible: true, boundingSphere: new BoundingSphere(center, 10) };
  const session = await VideoOverlayResources.create({ viewer: viewer(collection), imports: () => [record], getRecord: () => undefined });
  session.setSelection(['cad']); session.setTimelineOpacity({ cad: { opacity: .5, visible: true } });
  const owned = primitive.appearance;
  assert.ok(owned instanceof Appearance); assert.notEqual(owned, appearance);
  assert.equal(owned.isTranslucent(), true);
  assert.match(owned.fragmentShaderSource, /czm_writeLogDepth/);
  assert.match(owned.fragmentShaderSource, /out_FragColor.a \*= arPresentationOpacity\(\)/);
  assert.equal(owned.material.uniforms.arOpacity, .5);
  for (let frame = 0; frame < 5; frame++) session.setTimelineOpacity({ cad: { opacity: .3, visible: true } });
  assert.equal(primitive.appearance, owned); assert.equal(owned.material.uniforms.arOpacity, .3);
  session.restore();
  assert.equal(primitive.appearance, appearance); assert.equal(owned.material.isDestroyed(), true);
  collection.destroy();
});

test('entity CAD fading reads original color properties at every time without multiplying prior output', async () => {
  const data = new CustomDataSource('colored');
  const line = data.entities.add({ polyline: { positions: [center, Cartesian3.add(center, new Cartesian3(1, 2, 3), new Cartesian3())], material: Color.RED.withAlpha(.6), clampToGround: false } });
  const opaque = data.entities.add({ polyline: { positions: [center, Cartesian3.add(center, new Cartesian3(2, 3, 4), new Cartesian3())], material: Color.WHITE, clampToGround: false } });
  const label = data.entities.add({ position: center, label: { text: 'CAD', fillColor: Color.BLUE.withAlpha(.8) } });
  const originalMaterial = line.polyline!.material, originalFill = label.label!.fillColor;
  const imports: ImportRecord[] = [{ id: 'cad', name: 'cad', kind: 'CAD', representation: 'dataSource', resource: data, visible: true }];
  const view = viewer(), session = await VideoOverlayResources.create({ viewer: view, imports: () => imports, getRecord: () => undefined });
  session.setSelection(['cad']); session.setTimelineOpacity({ cad: { opacity: .5, visible: true } });
  const ownedMaterial = line.polyline!.material, ownedFill = label.label!.fillColor;
  for (let frame = 0; frame < 10; frame++) {
    session.setTimelineOpacity({ cad: { opacity: .5, visible: true } });
    close(line.polyline!.material!.getValue(view.clock.currentTime).color.alpha, .3);
    close(label.label!.fillColor!.getValue(view.clock.currentTime).alpha, .4);
  }
  session.setTimelineOpacity({});
  close(line.polyline!.material!.getValue(view.clock.currentTime).color.alpha, .6);
  const alpha = opaque.polyline!.material!.getValue(view.clock.currentTime).color.alpha as number;
  assert.ok(alpha < 1, 'CPU material batching retains its fixed translucent pass');
  assert.equal(Math.fround(alpha), 1, 'GPU float precision retains exact full opacity');
  assert.equal(line.polyline!.material, ownedMaterial); assert.equal(label.label!.fillColor, ownedFill);
  session.restore();
  assert.equal(line.polyline!.material, originalMaterial); assert.equal(label.label!.fillColor, originalFill);
});

test('an external shader owner wins over restore and even a failing restore setter releases the owned shader', async () => {
  const first = model('model');
  const resource = first.resource as typeof first.resource & { customShader?: CustomShader };
  const session = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [first.record], getRecord: () => undefined });
  session.setSelection(['model']); session.setTimelineOpacity({ model: { opacity: .5, visible: true } });
  const owned = resource.customShader!;
  const external = new CustomShader({}); resource.customShader = external;
  session.restore(); assert.equal(resource.customShader, external); assert.equal(owned.isDestroyed(), true);
  external.destroy();
  const second = model('second');
  const target = second.resource as typeof second.resource & { customShader?: CustomShader };
  const another = await VideoOverlayResources.create({ viewer: viewer(), imports: () => [second.record], getRecord: () => undefined });
  another.setTimelineOpacity({ second: { opacity: .5, visible: true } });
  const shader = target.customShader!;
  Object.defineProperty(target, 'customShader', { get: () => shader, set() { throw new Error('host already disposed'); }, configurable: true });
  assert.doesNotThrow(() => another.restore()); assert.equal(shader.isDestroyed(), true);
  assert.deepEqual(another.list(), []); assert.deepEqual(another.getAdjustments(), {});
});

test('a non-owning host still destroys temporary absolute CAD copies on exit', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(drawing), { status: 200 });
  const root = new PrimitiveCollection({ destroyPrimitives: false }), original = new PrimitiveCollection();
  original.add(groundSource()); root.add(original);
  const record: ImportRecord = { id: 'cad', name: 'ground', kind: 'CAD', representation: 'primitive', resource: original, visible: true };
  try {
    const session = await VideoOverlayResources.create({ viewer: viewer(root), imports: () => [record], getRecord: savedCad });
    const copy = root.get(1) as PrimitiveCollection;
    session.restore();
    assert.equal(root.length, 1); assert.equal(copy.isDestroyed(), true);
  } finally { globalThis.fetch = fetchBefore; root.destroy(); original.destroy(); }
});
