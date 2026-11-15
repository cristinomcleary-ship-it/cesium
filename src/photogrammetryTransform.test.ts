import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import {
  createPhotogrammetryTransform, getPhotogrammetryPivot, movePhotogrammetryByPoints,
  photogrammetryMatrix, resetPhotogrammetryTransform, setPhotogrammetryPivot, validatePhotogrammetryTransform,
} from './photogrammetryTransform.ts';

function fixture() {
  const center = Cartesian3.fromDegrees(120.783333, 30.875, 35);
  const frame = Transforms.eastNorthUpToFixedFrame(center);
  const original = Matrix4.multiplyTransformation(frame, Matrix4.fromScale(new Cartesian3(2, 3, 4)), new Matrix4());
  const state = createPhotogrammetryTransform(original, center);
  const world = (east: number, north: number, up: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(east, north, up), new Cartesian3());
  return { center, frame, original, state, world };
}
function near(a: number, b: number, tolerance = 2e-8) { assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`); }
function nearPoint(a: Cartesian3, b: Cartesian3) { near(a.x, b.x); near(a.y, b.y); near(a.z, b.z); }

test('old records open at their exact non-identity matrix and preserve source scale', () => {
  const f = fixture(), before = Matrix4.toArray(f.original);
  assert.deepEqual(Matrix4.toArray(photogrammetryMatrix(f.state)), before);
  assert.deepEqual(f.state.originalMatrix, before);
  assert.deepEqual(f.state.origin, [f.center.x, f.center.y, f.center.z]);
  const changed = { ...f.state, east: 10, north: 20, up: 30, heading: 90 };
  // Source (4,2,3) is (8,6,12) metres in fixed ENU after its original scale;
  // +90 degrees makes (-6,8,12), then the requested translation is applied.
  nearPoint(Matrix4.multiplyByPoint(photogrammetryMatrix(changed), new Cartesian3(4, 2, 3), new Cartesian3()), f.world(4, 28, 42));
  assert.deepEqual(Matrix4.toArray(f.original), before);
  assert.deepEqual(f.state.originalMatrix, before);
});

test('existing affine translation, reflection and shear survive rotation around an arbitrary centre', () => {
  const f = fixture();
  const local = Matrix4.fromArray([2, 0, 0, 0, 1, 3, 0, 0, 0, 0, -4, 0, 5, 7, 9, 1]);
  const original = Matrix4.multiplyTransformation(f.frame, local, new Matrix4());
  const base = createPhotogrammetryTransform(original, f.center);
  const state = { ...setPhotogrammetryPivot(base, f.world(3, -2, 0)), east: 10, north: 20, up: 30, heading: 90 };
  // Local source (4,2,3) becomes (15,13,-3), rotating about (3,-2,0)
  // gives (-12,10,-3); its displayed translated position is (-2,30,27).
  nearPoint(Matrix4.multiplyByPoint(photogrammetryMatrix(state), new Cartesian3(4, 2, 3), new Cartesian3()), f.world(-2, 30, 27));
  assert.deepEqual(Matrix4.toArray(photogrammetryMatrix(resetPhotogrammetryTransform(state))), Matrix4.toArray(original));
});

test('rotation pivot is displayed after translation and remains fixed while heading changes', () => {
  const f = fixture(), state = { ...f.state, east: 10, north: 20, up: 5, heading: 60 };
  const chosen = f.world(20, 40, 10);
  const pivotState = setPhotogrammetryPivot(state, chosen);
  nearPoint(getPhotogrammetryPivot(pivotState), chosen);
  nearPoint(Cartesian3.fromArray(pivotState.pivot), f.world(10, 20, 5));
  const sourceAtPivot = Matrix4.multiplyByPoint(Matrix4.inverse(f.original, new Matrix4()), Cartesian3.fromArray(pivotState.pivot), new Cartesian3());
  for (const heading of [-180, -35, 0, 60, 125, 360, 450]) {
    nearPoint(Matrix4.multiplyByPoint(photogrammetryMatrix({ ...pivotState, heading }), sourceAtPivot, new Cartesian3()), chosen);
  }
  assert.deepEqual(state.pivot, f.state.pivot, 'setting a pivot never mutates the existing session');
});

test('map start and end add fixed east/north displacement without changing elevation or using rotated axes', () => {
  const f = fixture(), state = { ...f.state, east: 3, north: 7, up: 11, heading: 80 };
  const moved = movePhotogrammetryByPoints(state, f.world(100, 200, 50), f.world(125, 190, 550));
  near(moved.east, 28); near(moved.north, -3); assert.equal(moved.up, 11); assert.equal(moved.heading, 80);
  assert.deepEqual(moved.origin, state.origin); assert.deepEqual(moved.originalMatrix, state.originalMatrix);
  const reversed = movePhotogrammetryByPoints(moved, f.world(125, 190, 550), f.world(100, 200, 50));
  near(reversed.east, 3); near(reversed.north, 7); assert.equal(reversed.up, 11);
  assert.equal(state.east, 3); assert.equal(state.north, 7);
});

test('saved metadata restores its fixed baseline and pivot only when it matches the authoritative matrix', () => {
  const f = fixture();
  const edited = { ...setPhotogrammetryPivot(f.state, f.world(50, 70, 20)), east: 125.25, north: -9, up: 2.5, heading: 34.2 };
  const current = photogrammetryMatrix(edited), before = Matrix4.toArray(current);
  const saved = JSON.parse(JSON.stringify(edited));
  const restored = createPhotogrammetryTransform(current, f.world(200, 200, 200), saved);
  assert.deepEqual(restored, edited);
  assert.deepEqual(validatePhotogrammetryTransform(saved, current), edited);
  restored.originalMatrix[0] += 1; restored.origin[0] += 1; restored.pivot[0] += 1;
  assert.deepEqual(saved, edited, 'restoration clones all persistent arrays');
  assert.deepEqual(Matrix4.toArray(current), before);
});

test('mismatched or malformed optional metadata safely rebases to the current pose without moving old data', () => {
  const f = fixture(), edited = { ...f.state, east: 20, heading: 35 };
  const changed = Matrix4.toArray(photogrammetryMatrix(edited));
  changed[12] += .001; // A later external edit must not be overwritten by stale metadata.
  const current = Matrix4.fromArray(changed);
  const before = Matrix4.toArray(current), center = f.world(22, 1, 4);
  const bad = [undefined, null, [], {}, { ...edited, version: 2 }, { ...edited, east: NaN },
    { ...edited, originalMatrix: [] }, { ...edited, origin: [0, 0, 0] }, { ...edited, pivot: [0, Infinity, 0] }, edited];
  for (const saved of bad) {
    const recovered = createPhotogrammetryTransform(current, center, saved);
    assert.deepEqual(recovered.originalMatrix, before);
    assert.deepEqual(Matrix4.toArray(photogrammetryMatrix(recovered)), before);
    assert.deepEqual(recovered.origin, [center.x, center.y, center.z]);
    assert.equal(recovered.east, 0); assert.equal(recovered.heading, 0);
  }
  assert.throws(() => validatePhotogrammetryTransform(edited, current), /不一致/);
  assert.deepEqual(Matrix4.toArray(current), before);
});

test('repeated previews have no accumulated drift and reset retains the exact original matrix', () => {
  const f = fixture(), baseline = structuredClone(f.state);
  const edited = { ...setPhotogrammetryPivot(f.state, f.world(37, -11, 8)), east: 71.25, north: -62.5, up: 3, heading: 271.3 };
  const expected = Matrix4.toArray(photogrammetryMatrix(edited));
  for (let n = 0; n < 200; n++) assert.deepEqual(Matrix4.toArray(photogrammetryMatrix(edited)), expected);
  const reset = resetPhotogrammetryTransform(edited);
  assert.deepEqual(reset, baseline);
  assert.deepEqual(Matrix4.toArray(photogrammetryMatrix(reset)), Matrix4.toArray(f.original));
  assert.deepEqual(Matrix4.toArray(photogrammetryMatrix({ ...baseline, heading: 360 })), Matrix4.toArray(f.original));
  assert.deepEqual(f.state, baseline, 'an edit-session cancellation can still use its untouched opening snapshot');
});

test('invalid current matrices and non-finite picks fail before changing a state or scene', () => {
  const f = fixture();
  for (const matrix of [Matrix4.ZERO, Matrix4.fromArray([1, 0, 0, .1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])]) {
    assert.throws(() => createPhotogrammetryTransform(matrix, f.center), /矩阵无效/);
  }
  assert.throws(() => createPhotogrammetryTransform(f.original, Cartesian3.ZERO), /参数无效/);
  assert.throws(() => createPhotogrammetryTransform(f.original, new Cartesian3(1e200, 0, 0)), /参数无效/);
  assert.throws(() => photogrammetryMatrix({ ...f.state, up: Infinity }), /参数无效/);
  assert.throws(() => setPhotogrammetryPivot(f.state, new Cartesian3(NaN, 0, 0)), /参数无效/);
  assert.throws(() => movePhotogrammetryByPoints(f.state, f.center, new Cartesian3(0, Infinity, 0)), /参数无效/);
  assert.deepEqual(Matrix4.toArray(photogrammetryMatrix(f.state)), Matrix4.toArray(f.original));
});
