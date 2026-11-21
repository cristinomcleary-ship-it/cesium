import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { buildModelProjection } from './projection.ts';
import { EngineeringFootprintGeometry } from '../engineeringComponents/footprints.ts';
import type { ContactMeshInput } from './types';

const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0, 100));
const world = Matrix4.toArray(frame), inverse = Matrix4.inverseTransformation(frame, new Matrix4());
function mesh(boxes: number[][]): ContactMeshInput {
  return { worldFromLocal: [...world], primitives: boxes.map(([x, y, X, Y, z = 0], nodeIndex) => ({
    positions: new Float64Array([x, y, z, X, y, z, X, Y, z, x, Y, z]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]), groupId: `node:${nodeIndex}:instance:0`, nodeIndex,
  })) };
}
function covers(result: Awaited<ReturnType<typeof buildModelProjection>>, point: [number, number]) {
  return result.projection.footprints.some(footprint => {
    const ring = footprint.outer.map(p => Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(p.longitude, p.latitude, p.height), new Cartesian3()));
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > point[1]) !== (b.y > point[1]) && point[0] < (b.x - a.x) * (point[1] - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  });
}

test('runtime projection retains original concavities and every overlapping or reversed source triangle', async () => {
  const input = mesh([[0, 0, 4, 1], [0, 0, 1, 4], [0, 0, 1, 1]]);
  input.primitives[2].indices.reverse();
  const original = structuredClone(input), result = await buildModelProjection(input);
  assert.equal(result.kind, 'projection'); assert.equal(result.projection.triangleCount, 6);
  assert.equal(result.projection.rawAreaSquareMeters, 7);
  assert.equal(covers(result, [3, .5]), true); assert.equal(covers(result, [.5, 3]), true);
  assert.equal(covers(result, [2, 2]), false, 'no convex-hull or bounding-box substitute');
  assert.deepEqual(input, original, 'no source arrays or transforms are rewritten');
});

test('a true two-dimensional courtyard survives while an overhead original face covers a three-dimensional cavity', async () => {
  const ring = [[0, 0, 4, 1], [0, 3, 4, 4], [0, 1, 1, 3], [3, 1, 4, 3]];
  const courtyard = await buildModelProjection(mesh(ring));
  assert.equal(courtyard.projection.rawHoles, 1); assert.equal(courtyard.projection.rawAreaSquareMeters, 12);
  assert.equal(courtyard.projection.compiledAreaSquareMeters, 12); assert.equal(covers(courtyard, [2, 2]), false);
  const covered = await buildModelProjection(mesh([...ring, [0, 0, 4, 4, 12]]));
  assert.equal(covered.projection.rawHoles, 0); assert.equal(covered.projection.triangleCount, 10);
  assert.equal(covers(covered, [2, 2]), true, 'roof projection restores the previous height-independent effect');
});

test('runtime and original GLB input use identical source-triangle projection, boundaries and quantization', async () => {
  const input = mesh([[-4, -2, 4, 2, 200]]), primitive = input.primitives[0];
  const positions = Float32Array.from(primitive.positions), indices = primitive.indices;
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { componentId: 'part' } }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: positions.byteLength + indices.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    accessors: [{ bufferView: 0, count: 4, componentType: 5126, type: 'VEC3' }, { bufferView: 1, count: 6, componentType: 5125, type: 'SCALAR' }] };
  const json = Buffer.from(JSON.stringify(doc)), length = (json.length + 3) & ~3;
  const bytes = Buffer.alloc(28 + length + positions.byteLength + indices.byteLength);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(32, 20, 20 + length); json.copy(bytes, 20);
  bytes.writeUInt32LE(positions.byteLength + indices.byteLength, 20 + length); bytes.writeUInt32LE(0x004e4942, 24 + length);
  Buffer.from(positions.buffer).copy(bytes, 28 + length); Buffer.from(indices.buffer).copy(bytes, 28 + length + positions.byteLength);
  const reference = await new EngineeringFootprintGeometry(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), [{ componentId: 'part', nodeIndices: [0] }]).project(world, ['part']);
  const actual = (await buildModelProjection(input)).projection;
  const { milliseconds: ignored1, ...expected } = reference, { milliseconds: ignored2, ...observed } = actual;
  assert.deepEqual(observed, expected); assert.equal(actual.quantizationGridMeters, 1e-8);
  assert.ok(actual.rawAreaSquareMeters < 32 && actual.rawAreaSquareMeters > 31.99, 'central projection is not a parallel XY drop');
});

test('physical root pose and scale change projection without mutating or filling source geometry', async () => {
  const input = mesh([[0, 0, 4, 2]]), original = await buildModelProjection(input);
  input.worldFromLocal = Matrix4.toArray(Matrix4.multiplyByUniformScale(Matrix4.multiplyByTranslation(frame, new Cartesian3(10, 20, 0), new Matrix4()), 2, new Matrix4()));
  const moved = await buildModelProjection(input);
  assert.equal(covers(original, [1, 1]), true); assert.equal(covers(moved, [1, 1]), false);
  assert.equal(covers(moved, [11, 21]), true); assert.ok(Math.abs(moved.projection.rawAreaSquareMeters - 32) < .001);
  assert.notDeepEqual(moved.worldFromLocal, original.worldFromLocal);
});

test('zero area retains source counts; invalid input and cancellation cannot publish partial footprints', async () => {
  const input = mesh([[0, 0, 0, 2]]), empty = await buildModelProjection(input);
  assert.equal(empty.projection.triangleCount, 2); assert.deepEqual(empty.projection.footprints, []);
  input.primitives[0].indices[0] = 9; await assert.rejects(buildModelProjection(input), /索引无效/);
  await assert.rejects(buildModelProjection(mesh([[0, 0, 1, 1]]), { shouldAbort: () => true }), { name: 'AbortError' });
  const unlocated = mesh([[0, 0, 1, 1]]); unlocated.worldFromLocal = Matrix4.toArray(Matrix4.IDENTITY);
  await assert.rejects(buildModelProjection(unlocated), /已定位/);
});

test('large single-node batches preserve signed courtyard holes, all source faces and the longest rounding depth', async () => {
  const source = mesh([[0, 0, 4, 1], [0, 3, 4, 4], [0, 1, 1, 3], [3, 1, 4, 3]]);
  const positions = new Float64Array(source.primitives.flatMap(p => [...p.positions]));
  const cycle = source.primitives.flatMap((p, index) => [...p.indices].map(i => i + index * 4));
  const repeats = 4096, indices = new Uint32Array(cycle.length * repeats);
  for (let i = 0; i < repeats; i++) indices.set(cycle, i * cycle.length);
  source.primitives = [{ positions, indices, groupId: 'single-imported-node', nodeIndex: 0 }];
  const progress: string[] = [], result = await buildModelProjection(source, { onProgress: value => progress.push(value) });
  assert.equal(result.projection.triangleCount, 8 * repeats);
  assert.equal(result.projection.rawHoles, 1); assert.equal(result.projection.rawAreaSquareMeters, 12);
  assert.equal(result.projection.compiledAreaSquareMeters, 12); assert.equal(covers(result, [2, 2]), false);
  assert.equal(covers(result, [.5, 2]), true); assert.equal(result.projection.quantizationGridMeters, 1e-8);
  // 16 first-stage batches -> 2 merge batches -> one final component union,
  // plus initial input quantization and final PolyTree = five serial stages.
  assert.equal(result.projection.quantizationPasses, 5);
  assert.equal(result.projection.quantizationDisplacementBudgetMeters, 5 * Math.SQRT2 * 1e-8 / 2);
  assert.ok(progress.some(value => value.includes('分批')));
});

test('large-node projection can cancel between exact batches without returning a partial outline', async () => {
  const source = mesh([[0, 0, 4, 4]]), p = source.primitives[0];
  p.indices = Uint32Array.from(Array.from({ length: 4096 }, () => [0, 1, 2, 0, 2, 3]).flat());
  let cancel = false;
  await assert.rejects(buildModelProjection(source, {
    shouldAbort: () => cancel, onProgress: value => { if (value.includes('分批')) cancel = true; },
  }), { name: 'AbortError' });
  assert.equal(p.indices.length, 4096 * 6);
});

test('giant single-node spatial ordering preserves multiple courtyards and concavity independently of original face order', async () => {
  const source = mesh([[0, 0, 4, 1], [0, 3, 4, 4], [0, 1, 1, 3], [3, 1, 4, 3], [4, 0, 6, 1],
    [10, 0, 14, 1], [10, 3, 14, 4], [10, 1, 11, 3], [13, 1, 14, 3]]);
  const positions = new Float64Array(source.primitives.flatMap(p => [...p.positions]));
  const cycle = source.primitives.flatMap((p, index) => [...p.indices].map(i => i + index * 4));
  const repeats = 8192, indices = new Uint32Array(cycle.length * repeats);
  for (let i = 0; i < repeats; i++) indices.set(cycle, i * cycle.length);
  source.primitives = [{ positions, indices, groupId: 'whole-route-node', nodeIndex: 0 }];
  const initial = indices.slice(), forward = await buildModelProjection(source);
  assert.deepEqual(indices, initial, 'spatial sorting must not reorder source indices');
  source.primitives[0].indices = indices.slice().reverse();
  const reverse = await buildModelProjection(source);
  for (const result of [forward, reverse]) {
    assert.equal(result.projection.triangleCount, 18 * repeats);
    assert.equal(result.projection.rawHoles, 2); assert.equal(result.projection.rawAreaSquareMeters, 26);
    assert.equal(result.projection.compiledAreaSquareMeters, 26);
    assert.equal(covers(result, [2, 2]), false, 'courtyard');
    assert.equal(covers(result, [12, 2]), false, 'second courtyard');
    assert.equal(covers(result, [10.5, 2]), true, 'second courtyard original wall projection');
    assert.equal(covers(result, [5, 2]), false, 'concavity');
    assert.equal(covers(result, [5, .5]), true, 'original projecting arm');
    assert.equal(result.projection.quantizationGridMeters, 1e-8);
    assert.equal(result.projection.quantizationPasses, 6);
  }
  const { milliseconds: elapsedForward, ...a } = forward.projection;
  const { milliseconds: elapsedReverse, ...b } = reverse.projection;
  assert.deepEqual(a, b, 'same original geometry gives the same full result from reversed input order');
});
