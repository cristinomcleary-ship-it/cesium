import assert from 'node:assert/strict';
import test from 'node:test';
import { Cartesian3, ComponentDatatype, HeightReference, Matrix3, Matrix4, PrimitiveType, type Model } from 'cesium';
import { readRuntimeModelGeometry, runtimeModelWorldFromLocal } from './runtimeGeometry.ts';

const matrix = (x = 0, y = 0, z = 0) => Matrix4.fromTranslation(new Cartesian3(x, y, z));
const position = (values = [0, 0, 0, 1, 0, 0, 0, 1, 0]) => ({
  semantic: 'POSITION', type: 'VEC3', componentDatatype: ComponentDatatype.FLOAT, count: values.length / 3,
  typedArray: new Float32Array(values), byteOffset: 0,
});
const primitive = (attribute: any = position(), mode = PrimitiveType.TRIANGLES, indices?: number[]) => ({
  attributes: [attribute], primitiveType: mode,
  indices: indices ? { typedArray: new Uint32Array(indices), count: indices.length } : undefined,
});
const node = (index: number, primitives = [primitive()], transform = matrix(), children: number[] = []) => ({
  node: { index }, computedTransform: transform, children, runtimePrimitives: primitives.map(p => ({ primitive: p })), show: false,
});
function fixture(nodes: any[] = [node(0)]) {
  return {
    ready: true, isDestroyed: () => false, show: false, modelMatrix: matrix(100, 200, 300), scale: 1,
    maximumScale: undefined, minimumPixelSize: 0, activeAnimations: { length: 0 }, heightReference: HeightReference.NONE,
    _sceneGraph: { components: { transform: matrix() }, axisCorrectionMatrix: matrix(), _runtimeNodes: nodes },
  } as unknown as Model;
}

test('reads all runtime material primitives while hidden, preserves source arrays, and uses current public root placement', async () => {
  const source = position(), model = fixture([node(0, [primitive(source), primitive(position([0, 0, 1, 1, 0, 1, 0, 1, 1]))], matrix(3, 4, 5))]);
  model.scale = 2; model.maximumScale = 1.5;
  const data = await readRuntimeModelGeometry(model);
  assert.equal(data.primitives.length, 2); assert.equal(data.primitives[0].groupId, data.primitives[1].groupId);
  assert.deepEqual([...data.primitives[0].positions], [3, 4, 5, 4, 4, 5, 3, 5, 5]);
  assert.deepEqual([...source.typedArray], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(data.worldFromLocal[0], 1.5); assert.equal(data.worldFromLocal[12], 100);
  model.modelMatrix = matrix(999, 2, 3);
  assert.equal(runtimeModelWorldFromLocal(model)[12], 999);
  structuredClone(data.primitives[0], { transfer: [data.primitives[0].positions.buffer, data.primitives[0].indices.buffer] });
  assert.equal(source.typedArray.byteLength, 36);
  assert.deepEqual(data.readStats, { sourceNodes: 1, sourcePrimitives: 2, triangles: 2, bytes: 168, ignoredNonSurfacePrimitives: 0, rootScaleAffectsGeometry: false });
});

test('selection includes descendants; explicit excluded subtrees remove references without names or visibility heuristics', async () => {
  const nodes = [node(0, [], matrix(), [1, 2]), node(1, [primitive()], matrix(), [3]), node(2), node(3)];
  const input = await readRuntimeModelGeometry(fixture(nodes), { allowedNodeIndices: [0], excludeNodeIndices: new Set([1]) });
  assert.deepEqual(input.primitives.map(p => p.nodeIndex), [2]);
  assert.equal(input.readStats.sourceNodes, 2);
  assert.deepEqual((await readRuntimeModelGeometry(fixture(nodes), { allowedNodeIndices: [] })).primitives, []);
  await assert.rejects(readRuntimeModelGeometry(fixture(nodes), { allowedNodeIndices: [99] }), /索引无效/);
});

test('nonindexed, strip and fan draw modes preserve exact source winding', async () => {
  const square = position([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const input = await readRuntimeModelGeometry(fixture([node(0, [
    primitive(), primitive(square, PrimitiveType.TRIANGLE_STRIP, [0, 1, 2, 3]), primitive(square, PrimitiveType.TRIANGLE_FAN),
  ])]));
  assert.deepEqual(input.primitives.map(p => [...p.indices]), [[0, 1, 2], [0, 1, 2, 1, 3, 2], [0, 1, 2, 0, 2, 3]]);
});

test('pinned ModelReader decodes actual interleaved GPU attributes and quantized positions', async () => {
  const bytes = new Float32Array([9, 1, 2, 3, 9, 4, 5, 6, 9, 7, 8, 9]);
  const gpu = { ...position(), typedArray: undefined, byteOffset: 4, byteStride: 16,
    buffer: { sizeInBytes: bytes.byteLength, getBufferData(target: Uint8Array) { target.set(new Uint8Array(bytes.buffer)); } } };
  const quantized = { ...position(), typedArray: new Uint16Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    quantization: { componentDatatype: ComponentDatatype.UNSIGNED_SHORT, quantizedVolumeStepSize: new Cartesian3(0.5, 0.5, 0.5), quantizedVolumeOffset: new Cartesian3(10, 20, 30) } };
  const input = await readRuntimeModelGeometry(fixture([node(0, [primitive(gpu), primitive(quantized)])]));
  assert.deepEqual([...input.primitives[0].positions], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...input.primitives[1].positions], [10, 20, 30, 11, 20, 30, 10, 21, 30]);
});

test('instanced material groups follow node×instance transforms and separate instance identities', async () => {
  const instanced: any = node(0, [primitive(), primitive()], matrix(5, 0, 0));
  instanced.node.instances = { attributes: [{ semantic: 'TRANSLATION', type: 'VEC3', componentDatatype: ComponentDatatype.FLOAT,
    count: 2, typedArray: new Float32Array([10, 0, 0, 20, 0, 0]) }] };
  // Cesium stores projected 2D triples in this slot for translation-only nodes.
  instanced.transformsTypedArray = new Float32Array([700, 800, 900, 800, 900, 1000]);
  const data = await readRuntimeModelGeometry(fixture([instanced]));
  assert.deepEqual(data.primitives.map(p => p.positions[0]), [15, 25, 15, 25]);
  assert.deepEqual(data.primitives.map(p => p.groupId), ['node:0:instance:0', 'node:0:instance:1', 'node:0:instance:0', 'node:0:instance:1']);
});

test('packed GPU instances and legacy world-space instances retain actual transform order under root scale', async () => {
  const instanced: any = node(0, [primitive()], matrix(5, 0, 0));
  instanced.node.instances = { transformInWorldSpace: true, attributes: [{ semantic: 'TRANSLATION', type: 'VEC3', componentDatatype: ComponentDatatype.FLOAT, count: 1 }] };
  instanced.instancingTransformsBuffer = { sizeInBytes: 48,
    getBufferData(target: Float32Array) { target.set([1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30]); } };
  const model = fixture([instanced]); model.scale = 2;
  const input = await readRuntimeModelGeometry(model);
  assert.equal(input.readStats.rootScaleAffectsGeometry, true);
  assert.deepEqual([...input.primitives[0].positions].slice(0, 3), [7.5, 10, 15]);
  const actual = Matrix4.multiplyByPoint(Matrix4.fromArray([...input.worldFromLocal]), Cartesian3.fromArray([...input.primitives[0].positions]), new Cartesian3());
  assert.deepEqual(actual, new Cartesian3(115, 220, 330));
});

test('legal lines and points are reported and ignored as nonsurfaces', async () => {
  const input = await readRuntimeModelGeometry(fixture([node(0, [primitive(), ...[0, 1, 2, 3].map(mode => primitive(position(), mode))])]));
  assert.equal(input.primitives.length, 1); assert.equal(input.readStats.ignoredNonSurfacePrimitives, 4);
});

test('invalid positions, indices, matrices and decoded lengths fail explicitly', async () => {
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0, [primitive(position([NaN, 0, 0, 1, 0, 0, 0, 1, 0]))])])), /无效坐标/);
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0, [primitive(position(), PrimitiveType.TRIANGLES, [0, 1, 9])])])), /超出顶点/);
  const malformed = position(); malformed.count = 6;
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0, [primitive(malformed)])])), /长度不一致/);
  const model = fixture(); model.modelMatrix = Matrix4.multiplyByScale(matrix(), new Cartesian3(0, 1, 1), new Matrix4());
  await assert.rejects(readRuntimeModelGeometry(model), /不可逆/);
});

test('deformation is explicit and cannot become a successful static approximation', async () => {
  const edits: ((m: any) => void)[] = [
    m => m.activeAnimations.length = 1, m => m.minimumPixelSize = 10,
    m => m.heightReference = HeightReference.CLAMP_TO_GROUND, m => m.hasVerticalExaggeration = true,
    m => m.customShader = { vertexShaderText: 'void vertexMain() {}' },
    m => m._sceneGraph._runtimeNodes[0].userAnimated = true,
    m => m._sceneGraph._runtimeNodes[0].runtimeSkin = {},
    m => m._sceneGraph._runtimeNodes[0].runtimePrimitives[0].primitive.morphTargets = [{}],
  ];
  for (const edit of edits) { const model = fixture(); edit(model); await assert.rejects(readRuntimeModelGeometry(model), /不支持/); }
  const fragmentOnly: any = fixture(); fragmentOnly.customShader = { fragmentShaderText: 'void fragmentMain() {}' };
  assert.equal((await readRuntimeModelGeometry(fragmentOnly)).primitives.length, 1);
});

test('cancellation, root movement and graph replacement invalidate asynchronous reads', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(readRuntimeModelGeometry(fixture(), { signal: cancelled.signal }), { name: 'AbortError' });
  const signal = new AbortController();
  await assert.rejects(readRuntimeModelGeometry(fixture(), { signal: signal.signal, onProgress: () => signal.abort() }), { name: 'AbortError' });
  const model = fixture();
  await assert.rejects(readRuntimeModelGeometry(model, { onProgress: () => model.modelMatrix = matrix(1, 2, 3) }), { name: 'AbortError' });
  const replaced: any = fixture();
  await assert.rejects(readRuntimeModelGeometry(replaced, { onProgress: () => replaced._sceneGraph = {} }), { name: 'AbortError' });
});

test('runtime node change across a yield invalidates the snapshot', async () => {
  const actualNode = node(0), model = fixture([actualNode]);
  await assert.rejects(readRuntimeModelGeometry(model, { onProgress: () => actualNode.computedTransform = matrix(2, 0, 0) }), { name: 'AbortError' });
});

test('hard budgets reject rather than truncate source geometry', async () => {
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0, [primitive(), primitive()])]), { limits: { maxTriangles: 1 } }), /三角面超过/);
  await assert.rejects(readRuntimeModelGeometry(fixture(), { limits: { maxBytes: 1 } }), /内存/);
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0), node(1)]), { limits: { maxNodes: 1 } }), /节点超过/);
});

test('node, component-root and axis transforms stay in their original noncommutative order', async () => {
  const transformed: any = fixture([node(0, [primitive()], matrix(2, 0, 0))]);
  transformed.scale = 3; transformed._sceneGraph.components.transform = matrix(4, 0, 0);
  transformed._sceneGraph.axisCorrectionMatrix = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(Math.PI / 2));
  transformed._sceneGraph.computedModelMatrix = matrix(-99999, -99999, -99999);
  const actual = await readRuntimeModelGeometry(transformed);
  const world = Matrix4.multiplyByPoint(Matrix4.fromArray([...actual.worldFromLocal]), new Cartesian3(2, 0, 0), new Cartesian3());
  assert.ok(Math.abs(world.x - 104) < 1e-10); assert.ok(Math.abs(world.y - 206) < 1e-10); assert.equal(world.z, 300);
});

test('GPU index readback and normalized integers use the source accessors', async () => {
  const attribute = { ...position(), componentDatatype: ComponentDatatype.UNSIGNED_SHORT, normalized: true,
    typedArray: new Uint16Array([0, 0, 0, 65535, 0, 0, 0, 65535, 0]) };
  const item: any = primitive(attribute);
  item.indices = { count: 3, indexDatatype: ComponentDatatype.UNSIGNED_SHORT, buffer: {
    sizeInBytes: 6, getBufferData(target: Uint16Array) { target.set([2, 1, 0]); },
  } };
  const actual = await readRuntimeModelGeometry(fixture([node(0, [item])]));
  assert.deepEqual([...actual.primitives[0].positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...actual.primitives[0].indices], [2, 1, 0]);
});

test('abort can interrupt vertex processing after an initial yield without returning partial geometry', async () => {
  const signal = new AbortController(); let callbacks = 0;
  const large = position(); large.count = 65538; large.typedArray = new Float32Array(large.count * 3);
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0, [primitive(large)])]), {
    signal: signal.signal, onProgress: () => { if (++callbacks === 2) signal.abort(); },
  }), { name: 'AbortError' });
  assert.equal(callbacks, 2); assert.equal(large.typedArray.byteLength, 65538 * 12);
});

test('zero draw counts create no surface and line-only source still obeys primitive budgets', async () => {
  const actual = await readRuntimeModelGeometry(fixture([node(0, [primitive(position([])), primitive(position([0, 0, 0, 1, 0, 0]), PrimitiveType.TRIANGLE_STRIP)])]));
  assert.equal(actual.primitives.length, 0); assert.equal(actual.readStats.triangles, 0);
  await assert.rejects(readRuntimeModelGeometry(fixture([node(0, [primitive(position(), PrimitiveType.LINES), primitive(position(), PrimitiveType.POINTS)])]), {
    limits: { maxPrimitives: 1 },
  }), /图元超过/);
});
