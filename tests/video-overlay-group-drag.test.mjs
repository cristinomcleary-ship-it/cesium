import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Cartesian3, Matrix4, Transforms } from 'cesium';

// Exercise the shipped controller gesture and resource transform without a DOM,
// video decoder or WebGL. Browser acceptance covers the real pointer surface.
const workspace = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(workspace, '.video-overlay-group-drag-'));
let VideoModelOverlay, videoOverlayAdjustmentMatrix;
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { videoOverlayAdjustmentMatrix } from "./src/videoOverlayResources.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: join(directory, 'fixture.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  ({ VideoModelOverlay, videoOverlayAdjustmentMatrix } = await import(pathToFileURL(join(directory, 'fixture.mjs')).href));
} finally { await rm(directory, { recursive: true, force: true }); }

const origin = Cartesian3.fromDegrees(120, 30, 25);
const frame = Transforms.eastNorthUpToFixedFrame(origin);
const axis = value => Matrix4.multiplyByPointAsVector(frame, value, new Cartesian3());
const east = axis(Cartesian3.UNIT_X), north = axis(Cartesian3.UNIT_Y), up = axis(Cartesian3.UNIT_Z);
const anchor = Matrix4.multiplyByPoint(frame, new Cartesian3(-500, 100, 25), new Cartesian3());
const groupAdjustment = { anchor: [anchor.x, anchor.y, anchor.z], values: { east: 10, north: -3, up: 2, heading: 90, tiltEast: 30, tiltNorth: -20 } };
const adjustments = { model: { east: 4, north: -6, up: 2, heading: 19, tiltEast: 7, tiltNorth: -4 } };

function fixture(mode) {
  const base = structuredClone({ adjustments, groupAdjustment });
  let applied = 0, prevented = 0;
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    restoreScene() {}, adjustments: structuredClone(adjustments), groupAdjustment: structuredClone(groupAdjustment),
    options: { getImports: () => [{ id: 'model', kind: 'Model', resource: {} }] },
    dragging: { x: 100, y: 100, base, group: false, groupAffectsTarget: true, right: east, up: north, meters: .5, origin, mode },
    targetIds: () => ['model'], applyAdjustments: () => { applied++; }, syncAdjustmentInputs() {}, fail(error) { throw error; },
  });
  const event = { clientX: 120, clientY: 88, preventDefault() { prevented++; } };
  return { owner, base, event, counts: () => ({ applied, prevented }) };
}

function transformedPoint(value, source) {
  const individual = videoOverlayAdjustmentMatrix(origin, value);
  const group = videoOverlayAdjustmentMatrix(anchor, groupAdjustment.values);
  return Matrix4.multiplyByPoint(Matrix4.multiply(group, individual, new Matrix4()), source, new Cartesian3());
}

for (const mode of ['horizontal', 'vertical']) {
  test(`individual ${mode} screen drag compensates group heading and both tilts without mutating the undo snapshot`, () => {
    const { owner, base, event, counts } = fixture(mode);
    const before = structuredClone(base);
    const expected = mode === 'horizontal'
      ? Cartesian3.add(Cartesian3.multiplyByScalar(east, 10, new Cartesian3()), Cartesian3.multiplyByScalar(north, 6, new Cartesian3()), new Cartesian3())
      : Cartesian3.multiplyByScalar(up, 6, new Cartesian3());
    owner.moveDrag(event);
    const committed = structuredClone(owner.adjustments);
    // Check the actual G * L result at two vertices, not just slider values.
    for (const point of [origin, Matrix4.multiplyByPoint(frame, new Cartesian3(25, -9, 8), new Cartesian3())]) {
      const displacement = Cartesian3.subtract(transformedPoint(committed.model, point), transformedPoint(before.adjustments.model, point), new Cartesian3());
      assert.ok(Cartesian3.distance(displacement, expected) < 1e-6, `${mode} drag moves ${displacement}, expected ${expected}`);
    }
    for (const key of ['heading', 'tiltEast', 'tiltNorth']) assert.equal(committed.model[key], before.adjustments.model[key]);
    assert.deepEqual(base, before, 'drag must preserve the snapshot used by undo');
    assert.deepEqual(owner.groupAdjustment, before.groupAdjustment, 'individual drag does not edit the shared correction');
    owner.moveDrag(event);
    assert.deepEqual(owner.adjustments, committed, 'repeated pointer position is an absolute gesture, not an accumulated translation');
    assert.deepEqual(base, before);
    assert.deepEqual(counts(), { applied: 2, prevented: 2 });
  });
}

test('whole-group drag uses its fixed anchor without reading an unready first model bounding sphere', () => {
  const resource = {};
  Object.defineProperty(resource, 'boundingSphere', { get() { throw new Error('The model is not ready.'); } });
  let captured;
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    restoreScene() {}, spatialEditor: { editing: false }, video: { pause() {} }, lastFrameTime: 0,
    adjustments: {}, undo: [], redo: [], groupAdjustment: undefined,
    options: { getImports: () => [{ id: 'unready', kind: 'Model', resource }] },
    track: { sample: () => ({}), intrinsics: { fx: 500, width: 640 } },
    viewer: { camera: { positionWC: Cartesian3.add(origin, up, new Cartesian3()), rightWC: east, upWC: north },
      canvas: { clientWidth: 640, setPointerCapture(id) { captured = id; } } },
    el: id => ({ value: id === 'ccDragMode' ? 'horizontal' : '*' }), targetIds: () => ['unready'],
    groupAnchor: () => [anchor.x, anchor.y, anchor.z], fail(error) { throw error; },
  });
  assert.doesNotThrow(() => owner.startDrag({ clientX: 100, clientY: 100, button: 0, pointerId: 7, preventDefault() {} }));
  assert.equal(captured, 7); assert.equal(owner.dragging.group, true);
  assert.deepEqual(owner.groupAdjustment.anchor, [anchor.x, anchor.y, anchor.z]);
  assert.ok(Cartesian3.equals(owner.dragging.origin, anchor));
  assert.equal(owner.undo.length, 1); assert.equal(owner.undo[0].groupAdjustment, undefined);
});
