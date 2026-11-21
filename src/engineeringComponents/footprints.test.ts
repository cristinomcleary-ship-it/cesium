import assert from 'node:assert/strict';
import test from 'node:test';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { EngineeringFootprintGeometry, orientationOfIntegerTriangle } from './footprints.ts';

type Vertex = [number, number, number];
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0, 100));
const world = Matrix4.toArray(frame), inverse = Matrix4.inverseTransformation(frame, new Matrix4());
const binding = [{ componentId: 'part', nodeIndices: [0] }];
test('near-collinear integer triangles retain their exact nonzero orientation beyond double product precision', () => {
  const a = { X: 0, Y: 0 }, b = { X: 1_000_000_000_000, Y: 1_000_000_000_001 }, c = { X: 1_000_000_000_001, Y: 1_000_000_000_002 };
  assert.equal(b.X * c.Y - b.Y * c.X, 0, 'fixture exercises actual double cancellation');
  assert.equal(orientationOfIntegerTriangle([a, b, c]), -1);
  assert.equal(orientationOfIntegerTriangle([a, c, b]), 1);
  assert.equal(orientationOfIntegerTriangle([a, b, { X: b.X * 2, Y: b.Y * 2 }]), 0);
});
function glb(vertices: Vertex[], triangles: number[], change?: (gltf: any) => void): ArrayBuffer {
  const positions = new Float32Array(vertices.flat()), indices = new Uint32Array(triangles);
  const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [1] }],
    nodes: [{ mesh: 0, extras: { componentId: 'part' } }, { children: [0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: positions.byteLength + indices.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    accessors: [{ bufferView: 0, count: vertices.length, componentType: 5126, type: 'VEC3' }, { bufferView: 1, count: triangles.length, componentType: 5125, type: 'SCALAR' }] };
  change?.(json);
  const text = new TextEncoder().encode(JSON.stringify(json)), jsonLength = (text.length + 3) & ~3;
  const bytes = new ArrayBuffer(28 + jsonLength + positions.byteLength + indices.byteLength), data = new DataView(bytes);
  data.setUint32(0, 0x46546c67, true); data.setUint32(4, 2, true); data.setUint32(8, bytes.byteLength, true);
  data.setUint32(12, jsonLength, true); data.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, jsonLength).fill(32); new Uint8Array(bytes, 20, text.length).set(text);
  data.setUint32(20 + jsonLength, positions.byteLength + indices.byteLength, true); data.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(bytes, 28 + jsonLength, positions.byteLength).set(new Uint8Array(positions.buffer));
  new Uint8Array(bytes, 28 + jsonLength + positions.byteLength, indices.byteLength).set(new Uint8Array(indices.buffer));
  return bytes;
}
function rectangles(boxes: number[][], change?: (gltf: any) => void) {
  const vertices: Vertex[] = [], triangles: number[] = [];
  for (const [x0, y0, x1, y1, z = 0] of boxes) {
    const start = vertices.length;
    vertices.push([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
    triangles.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  return glb(vertices, triangles, change);
}
function local(geo: { longitude: number; latitude: number; height?: number }) {
  return Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(geo.longitude, geo.latitude, geo.height), new Cartesian3());
}
function inside(point: [number, number], ring: readonly { longitude: number; latitude: number; height?: number }[]): boolean {
  const points = ring.map(local); let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > point[1]) !== (b.y > point[1]) && point[0] < (b.x - a.x) * (point[1] - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

test('exact concave union retains the notch and counts every original overlapping triangle', async () => {
  const source = rectangles([[0, 0, 4, 1], [0, 0, 1, 4], [0, 0, 1, 1]]), before = new Uint8Array(source).slice();
  const result = await new EngineeringFootprintGeometry(source, binding).project(world, ['part']);
  assert.equal(result.triangleCount, 6); assert.equal(result.componentCount, 1); assert.equal(result.rawAreaSquareMeters, 7);
  assert.ok(result.footprints.some(f => inside([3, .5], f.outer)));
  assert.ok(result.footprints.some(f => inside([.5, 3], f.outer)));
  assert.ok(result.footprints.every(f => !inside([2, 2], f.outer)), 'concavity must not become a convex hull');
  assert.deepEqual(new Uint8Array(source), before);
});

test('a courtyard is preserved through integer union and exact worker triangulation', async () => {
  const source = rectangles([[0, 0, 4, 1], [0, 3, 4, 4], [0, 1, 1, 3], [3, 1, 4, 3]]);
  const result = await new EngineeringFootprintGeometry(source, binding).project(world, ['part']);
  assert.equal(result.rawHoles, 1); assert.equal(result.rawAreaSquareMeters, 12);
  assert.equal(result.compiledAreaSquareMeters, 12);
  assert.ok(result.footprints.every(f => !inside([2, 2], f.outer)), 'the hole remains open');
  assert.ok(result.footprints.some(f => inside([.5, 2], f.outer)));
  assert.equal(result.boundaryPoints, result.footprints.reduce((n, f) => n + f.outer.length, 0));
});

test('micrometer strips, narrow holes and concave corners survive the fixed 10 nm grid', async () => {
  const thin = await new EngineeringFootprintGeometry(rectangles([[0, 0, .000001, 4]]), binding).project(world, ['part']);
  assert.ok(Math.abs(thin.rawAreaSquareMeters - .000004) < 1e-12);
  assert.ok(thin.footprints.some(f => inside([.0000005, 2], f.outer)));
  const gap = .000001;
  const source = rectangles([[-1, -1, 1, -gap], [-1, gap, 1, 1], [-1, -gap, -gap, gap], [gap, -gap, 1, gap]]);
  const courtyard = await new EngineeringFootprintGeometry(source, binding).project(world, ['part']);
  assert.equal(courtyard.rawHoles, 1);
  assert.ok(courtyard.footprints.every(f => !inside([0, 0], f.outer)));
  assert.equal(thin.quantizationGridMeters, 1e-8); assert.ok(thin.maxQuantizationErrorMeters <= 5e-9);
});

test('source node hierarchy and actual runtime matrices must agree before geometry is projected', async () => {
  const bytes = rectangles([[0, 0, 2, 1]], json => { json.nodes[1].translation = [10, 20, 0]; json.nodes[0].translation = [2, 3, 0]; });
  const expected = Matrix4.toArray(Matrix4.fromTranslation(new Cartesian3(12, 23, 0)));
  const parser = new EngineeringFootprintGeometry(bytes, binding, [{ nodeIndex: 0, matrix: expected }]);
  const result = await parser.project(world, ['part']);
  assert.ok(result.footprints.some(f => inside([13, 23.5], f.outer)));
  assert.throws(() => new EngineeringFootprintGeometry(bytes, binding, [{ nodeIndex: 0, matrix: Matrix4.toArray(Matrix4.IDENTITY) }]), /累积矩阵不一致/);
  assert.throws(() => new EngineeringFootprintGeometry(bytes, binding, []), /缺少矩阵/);
});

test('central projection preserves each elevated vertex geocentric direction including physical instance scaling', async () => {
  const source = rectangles([[0, 0, 4, 2, 200]]);
  const scaled = Matrix4.multiplyByUniformScale(frame, 2, new Matrix4());
  const result = await new EngineeringFootprintGeometry(source, binding).project(Matrix4.toArray(scaled), ['part']);
  const sourceDirections = [[0, 0], [4, 0], [4, 2], [0, 2]].map(([x, y]) => Cartesian3.normalize(Matrix4.multiplyByPoint(scaled, new Cartesian3(x, y, 200), new Cartesian3()), new Cartesian3()));
  const resultDirections = result.footprints.flatMap(f => f.outer).map(geo => Cartesian3.normalize(Cartesian3.fromDegrees(geo.longitude, geo.latitude, geo.height), new Cartesian3()));
  for (const direction of sourceDirections) assert.ok(resultDirections.some(other => Cartesian3.distance(direction, other) < 2e-15));
  assert.ok(result.rawAreaSquareMeters < 32 && result.rawAreaSquareMeters > 31.99);
});

test('rejects reference lines, mismatched mesh parents, unsupported geometry and unlocated instances', async () => {
  assert.throws(() => new EngineeringFootprintGeometry(rectangles([[0, 0, 1, 1]], j => { j.meshes[0].primitives[0].mode = 3; }), binding), /三角形/);
  assert.throws(() => new EngineeringFootprintGeometry(rectangles([[0, 0, 1, 1]]), [{ componentId: 'wrong', nodeIndices: [0] }]), /物理 mesh 叶节点/);
  assert.throws(() => new EngineeringFootprintGeometry(rectangles([[0, 0, 1, 1]]), [{ componentId: 'part', nodeIndices: [1] }]), /物理 mesh 叶节点/);
  assert.throws(() => new EngineeringFootprintGeometry(rectangles([[0, 0, 1, 1]], j => { j.nodes[0].skin = 0; }), binding), /蒙皮/);
  const parser = new EngineeringFootprintGeometry(rectangles([[0, 0, 1, 1]]), binding);
  await assert.rejects(parser.project(Matrix4.toArray(Matrix4.IDENTITY), ['part']), /地球场景/);
  await assert.rejects(parser.project(world, ['unknown']), /未知物理构件/);
  await assert.rejects(parser.project(world, ['part', 'part']), /重复/);
});

test('empty selection is a complete empty result and malformed buffers fail without partial coverage', async () => {
  const source = rectangles([[0, 0, 1, 1]]), parser = new EngineeringFootprintGeometry(source, binding);
  const empty = await parser.project(world, []);
  assert.equal(empty.componentCount, 0); assert.equal(empty.triangleCount, 0); assert.deepEqual(empty.footprints, []);
  const truncated = source.slice(0, source.byteLength - 4);
  assert.throws(() => new EngineeringFootprintGeometry(truncated, binding), /总长度/);
  const bad = glb([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 9]);
  await assert.rejects(new EngineeringFootprintGeometry(bad, binding).project(world, ['part']), /索引越界/);
});
