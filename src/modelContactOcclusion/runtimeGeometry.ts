import * as Cesium from 'cesium';
import { HeightReference, Matrix4, PrimitiveType, type Model } from 'cesium';
import type { ContactMeshInput, ContactPrimitiveInput } from './types';

type NumericArray = ArrayLike<number>;
type Attribute = { semantic?: string; type: string; count: number; componentDatatype: number;
  typedArray?: NumericArray; buffer?: { sizeInBytes: number }; byteOffset?: number; byteStride?: number };
type Indices = { count: number; typedArray?: NumericArray; buffer?: { sizeInBytes: number } };
type Primitive = { attributes: Attribute[]; indices?: Indices; primitiveType: number; morphTargets?: unknown[] };
type RuntimeNode = {
  node: { index: number; skin?: unknown; instances?: { attributes: Attribute[]; transformInWorldSpace?: boolean } };
  children: readonly number[]; computedTransform: Matrix4; runtimePrimitives: { primitive: Primitive }[];
  userAnimated?: boolean; runtimeSkin?: unknown; morphWeights?: number[];
  transformsTypedArray?: NumericArray; instancingTransformsBuffer?: { sizeInBytes: number };
};
type RuntimeGraph = { components: { transform: Matrix4 }; axisCorrectionMatrix: Matrix4;
  _runtimeNodes: (RuntimeNode | undefined)[] };
type RuntimeModel = Model & { _sceneGraph?: RuntimeGraph; hasVerticalExaggeration?: boolean };
type Reader = {
  readAttributeAsTypedArray(attribute: Attribute): NumericArray;
  readIndicesAsTypedArray(indices: Indices): NumericArray;
  computeInstanceTransforms(node: RuntimeNode, computed: Matrix4, nodeTransform: Matrix4, model: Matrix4): Matrix4[];
};

/** Hard failure budgets: neither geometry nor selected nodes are truncated. */
type ReadLimits = { maxTriangles: number; maxBytes: number; maxPrimitives: number; maxNodes: number; maxInstances: number; timeoutMs: number };
export const RUNTIME_CONTACT_READ_LIMITS: Readonly<ReadLimits> = Object.freeze({
  maxTriangles: 3_000_000, maxBytes: 512 * 1024 * 1024,
  maxPrimitives: 200_000, maxNodes: 200_000, maxInstances: 200_000, timeoutMs: 120_000,
});
export type RuntimeContactReadOptions = {
  signal?: AbortSignal; allowedNodeIndices?: ReadonlySet<number> | readonly number[];
  excludeNodeIndices?: ReadonlySet<number> | readonly number[];
  onProgress?: (message: string) => void;
  limits?: Partial<ReadLimits>;
};
export type RuntimeContactReadStats = {
  ignoredNonSurfacePrimitives: number; sourcePrimitives: number; sourceNodes: number;
  triangles: number; bytes: number; rootScaleAffectsGeometry: boolean;
};
export type RuntimeContactMeshInput = ContactMeshInput & { readStats: RuntimeContactReadStats };
const abort = (message: string) => new DOMException(message, 'AbortError');

function validateMatrix(matrix: Matrix4, label: string): void {
  const values = Matrix4.toArray(matrix);
  if (values.some(value => !Number.isFinite(value)) || values[3] !== 0 || values[7] !== 0 || values[11] !== 0 || values[15] !== 1) {
    throw new Error(`${label}不是有效的仿射变换。`);
  }
  const d = values[0] * (values[5] * values[10] - values[6] * values[9])
    - values[4] * (values[1] * values[10] - values[2] * values[9])
    + values[8] * (values[1] * values[6] - values[2] * values[5]);
  if (!Number.isFinite(d) || d === 0) throw new Error(`${label}不可逆，不能计算模型遮挡。`);
}

function readyGraph(model: Model): RuntimeGraph {
  const graph = (model as RuntimeModel)._sceneGraph;
  if (!model.ready || model.isDestroyed() || !graph?.components?.transform || !graph.axisCorrectionMatrix || !Array.isArray(graph._runtimeNodes)) {
    throw new Error('模型运行时几何尚未就绪或已卸载。');
  }
  if (model.minimumPixelSize !== 0 || model.activeAnimations.length) throw new Error('模型遮挡暂不支持动画或屏幕最小尺寸模型。');
  if (model.heightReference !== undefined && model.heightReference !== HeightReference.NONE) throw new Error('模型遮挡暂不支持地形贴附形变。');
  if ((model as RuntimeModel).hasVerticalExaggeration) throw new Error('模型遮挡暂不支持垂直夸张形变。');
  if (model.customShader?.vertexShaderText?.trim()) throw new Error('模型遮挡暂不支持自定义顶点形变。');
  return graph;
}

/** Rebuild from public placement, including while hidden (Cesium skips hidden updates).
 * Order is locked to Cesium 1.144.0 ModelSceneGraph.computeModelMatrix. */
export function runtimeModelWorldFromLocal(model: Model): number[] {
  const graph = readyGraph(model);
  const scale = Math.min(model.scale, model.maximumScale ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('模型比例无效，模型遮挡未更新。');
  validateMatrix(model.modelMatrix, '模型定位'); validateMatrix(graph.components.transform, '模型根变换');
  validateMatrix(graph.axisCorrectionMatrix, '模型坐标轴变换');
  const result = Matrix4.multiplyTransformation(model.modelMatrix, graph.components.transform, new Matrix4());
  Matrix4.multiplyTransformation(result, graph.axisCorrectionMatrix, result);
  Matrix4.multiplyByUniformScale(result, scale, result); validateMatrix(result, '模型世界变换');
  return Matrix4.toArray(result);
}

function selectedNodes(nodes: RuntimeGraph['_runtimeNodes'], options: RuntimeContactReadOptions): number[] {
  const expand = (indices: Iterable<number>) => {
    const result = new Set<number>(), pending = [...indices];
    while (pending.length) {
      const index = pending.pop()!;
      if (!Number.isInteger(index) || index < 0 || !nodes[index]) throw new Error(`模型节点索引无效：${index}`);
      if (result.has(index)) continue;
      result.add(index); pending.push(...nodes[index]!.children);
    }
    return result;
  };
  const allowed = options.allowedNodeIndices ? expand(options.allowedNodeIndices) : new Set(nodes.flatMap((n, i) => n ? [i] : []));
  const excluded = options.excludeNodeIndices ? expand(options.excludeNodeIndices) : new Set<number>();
  return [...allowed].filter(i => !excluded.has(i)).sort((a, b) => a - b);
}

function assertStaticNode(node: RuntimeNode): void {
  if (node.userAnimated || node.runtimeSkin != null || node.node.skin != null || node.morphWeights?.length
      || node.runtimePrimitives.some(p => p.primitive.morphTargets?.length)) {
    throw new Error(`节点 ${node.node.index} 含骨骼、变形目标或动态节点变换，模型遮挡尚不支持。`);
  }
}

/** Uses the pinned SDK decoder for CPU/GPU, interleaved, normalized and quantized
 * attributes. Only owned copies leave this adapter; Cesium's buffers stay intact.
 * Node visibility and model visibility deliberately do not filter the geometry. */
export async function readRuntimeModelGeometry(model: Model, options: RuntimeContactReadOptions = {}): Promise<RuntimeContactMeshInput> {
  if (options.signal?.aborted) throw abort('模型几何读取已取消。');
  const sdk = Cesium as unknown as { VERSION?: string; ModelReader?: Reader }, reader = sdk.ModelReader;
  if (sdk.VERSION !== '1.144.0' || !reader?.readAttributeAsTypedArray || !reader.readIndicesAsTypedArray || !reader.computeInstanceTransforms) {
    throw new Error('Cesium 运行时几何读取版本不匹配；未使用包围盒替代。');
  }
  const limits = { ...RUNTIME_CONTACT_READ_LIMITS, ...options.limits };
  if (Object.values(limits).some(v => !Number.isFinite(v) || v <= 0)) throw new Error('模型几何读取预算无效。');
  const graph = readyGraph(model), worldFromLocal = runtimeModelWorldFromLocal(model);
  if (graph._runtimeNodes.length > limits.maxNodes) throw new Error('模型节点超过读取预算。');
  const selected = selectedNodes(graph._runtimeNodes, options);
  const snapshots = selected.map(index => {
    const node = graph._runtimeNodes[index]!; assertStaticNode(node); validateMatrix(node.computedTransform, `节点 ${index}`);
    return { index, node, transform: Matrix4.clone(node.computedTransform) };
  });
  const start = performance.now(); let lastYield = start, vertexWork = 0, visitedPrimitives = 0;
  const readStats: RuntimeContactReadStats = { ignoredNonSurfacePrimitives: 0, sourcePrimitives: 0, sourceNodes: 0, triangles: 0, bytes: 0,
    rootScaleAffectsGeometry: snapshots.some(s => !!s.node.node.instances?.transformInWorldSpace) };
  const primitives: ContactPrimitiveInput[] = [];
  const check = () => {
    if (options.signal?.aborted) throw abort('模型几何读取已取消。');
    if (model.isDestroyed() || (model as RuntimeModel)._sceneGraph !== graph) throw abort('模型已卸载或替换，几何读取已取消。');
    const current = runtimeModelWorldFromLocal(model);
    if (current.some((v, i) => v !== worldFromLocal[i])) throw abort('模型定位变化，旧几何读取已取消。');
    if (performance.now() - start > limits.timeoutMs) throw new Error('模型几何读取超过时间预算。');
  };
  const yieldIfNeeded = async (force = false) => {
    if (force || vertexWork >= 32768 || performance.now() - lastYield >= 8) {
      check(); options.onProgress?.(`读取模型实际三角面：${readStats.triangles.toLocaleString()}，节点 ${readStats.sourceNodes}/${selected.length}`);
      await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); lastYield = performance.now(); vertexWork = 0;
    }
  };
  const checkBytes = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || readStats.bytes + bytes > limits.maxBytes) throw new Error('模型几何超过内存读取预算。');
  };
  const axisScale = Matrix4.multiplyByUniformScale(graph.axisCorrectionMatrix, Math.min(model.scale, model.maximumScale ?? Infinity), new Matrix4());
  const inverseAxisScale = Matrix4.inverse(axisScale, new Matrix4());
  await yieldIfNeeded(true);
  for (const snapshot of snapshots) {
    const { node, index, transform } = snapshot; assertStaticNode(node);
    if (!Matrix4.equals(node.computedTransform, transform)) throw abort('模型节点变换变化，旧几何读取已取消。');
    const instances = node.node.instances;
    const instanceCount = instances ? instances.attributes[0]?.count : 1;
    if (!Number.isSafeInteger(instanceCount) || instanceCount! < 0 || instanceCount! > limits.maxInstances) throw new Error(`节点 ${index} 实例数量无效或超过读取预算。`);
    for (const attribute of instances?.attributes ?? []) if (attribute.count !== instanceCount) throw new Error('实例属性数量不一致。');
    if (instances) {
      for (const attribute of instances.attributes) checkBytes(attribute.buffer?.sizeInBytes ?? attribute.count * 16);
      checkBytes(node.instancingTransformsBuffer?.sizeInBytes ?? instanceCount! * 12 * 8);
    }
    // In this SDK a translation-only node may retain projected 2D triples here.
    // Ignore that cache and decode its original 3D attributes instead.
    const sourceNode = node.transformsTypedArray && node.transformsTypedArray.length !== instanceCount! * 12
      ? { ...node, transformsTypedArray: undefined } : node;
    let instanceMatrices = instanceCount === 0 ? [] : reader.computeInstanceTransforms(sourceNode, transform,
      instances?.transformInWorldSpace ? Matrix4.multiplyTransformation(graph.axisCorrectionMatrix, transform, new Matrix4()) : transform,
      instances?.transformInWorldSpace ? inverseAxisScale : Matrix4.IDENTITY);
    if (instances && !node.instancingTransformsBuffer && !sourceNode.transformsTypedArray
        && !instances.attributes.some(a => ['TRANSLATION', 'ROTATION', 'SCALE'].includes(a.semantic ?? ''))) {
      // Feature-ID-only instances have identity placement, one physical copy each.
      const identityPlacement = instances.transformInWorldSpace
        ? Matrix4.multiplyTransformation(inverseAxisScale, Matrix4.multiplyTransformation(graph.axisCorrectionMatrix, transform, new Matrix4()), new Matrix4()) : transform;
      instanceMatrices = Array.from({ length: instanceCount! }, () => Matrix4.clone(identityPlacement));
    }
    if (instanceMatrices.length !== instanceCount) throw new Error('实例变换数量与实际绘制不一致。');
    instanceMatrices.forEach(m => validateMatrix(m, `节点 ${index} 实例`));
    for (const runtimePrimitive of node.runtimePrimitives) {
      if (++visitedPrimitives > limits.maxPrimitives) throw new Error('模型图元超过读取预算。');
      const primitive = runtimePrimitive.primitive, mode = primitive.primitiveType;
      if ([PrimitiveType.POINTS, PrimitiveType.LINES, PrimitiveType.LINE_LOOP, PrimitiveType.LINE_STRIP].includes(mode)) {
        readStats.ignoredNonSurfacePrimitives++; await yieldIfNeeded(); continue;
      }
      if (![PrimitiveType.TRIANGLES, PrimitiveType.TRIANGLE_STRIP, PrimitiveType.TRIANGLE_FAN].includes(mode)) throw new Error(`不支持的实际模型拓扑：${mode}`);
      const attribute = primitive.attributes.find(a => a.semantic === 'POSITION');
      if (!attribute || attribute.type !== 'VEC3' || !Number.isSafeInteger(attribute.count) || attribute.count < 0) throw new Error('模型 POSITION 属性无效。');
      const indexCount = primitive.indices ? primitive.indices.count : attribute.count;
      if (!Number.isSafeInteger(indexCount) || indexCount < 0 || (mode === PrimitiveType.TRIANGLES && indexCount % 3 !== 0)) throw new Error('模型三角索引数量无效。');
      const triangleCount = mode === PrimitiveType.TRIANGLES ? indexCount / 3 : Math.max(0, indexCount - 2);
      if (!triangleCount || !instanceCount) { readStats.sourcePrimitives++; await yieldIfNeeded(); continue; }
      if (readStats.triangles + triangleCount * instanceCount! > limits.maxTriangles) throw new Error('模型三角面超过读取预算。');
      if (primitives.length + instanceCount! > limits.maxPrimitives) throw new Error('模型图元超过读取预算。');
      const outputBytes = (attribute.count * 3 * 8 + triangleCount * 3 * 4) * instanceCount!;
      checkBytes(outputBytes); checkBytes(attribute.buffer?.sizeInBytes ?? attribute.count * 24);
      checkBytes(primitive.indices?.buffer?.sizeInBytes ?? indexCount * 4);
      const positions = reader.readAttributeAsTypedArray(attribute);
      if (positions.length !== attribute.count * 3) throw new Error('模型 POSITION 解码长度不一致。');
      const sourceIndices = primitive.indices ? reader.readIndicesAsTypedArray(primitive.indices) : undefined;
      if (sourceIndices && sourceIndices.length !== indexCount) throw new Error('模型索引解码长度不一致。');
      const indices = new Uint32Array(triangleCount * 3);
      const valueAt = (i: number) => {
        const value = sourceIndices ? sourceIndices[i] : i;
        if (!Number.isInteger(value) || value < 0 || value >= attribute.count) throw new Error('模型三角索引超出顶点范围。');
        return value;
      };
      // SDK 1.144.0's strip/fan helper calls TypedArray.constructor without new.
      // Expand the same exact winding here, after the pinned raw-index decoder.
      for (let t = 0; t < triangleCount; t++) {
        const a = mode === PrimitiveType.TRIANGLES ? t * 3 : mode === PrimitiveType.TRIANGLE_FAN ? 0 : t;
        const b = mode === PrimitiveType.TRIANGLES ? a + 1 : t + (mode === PrimitiveType.TRIANGLE_STRIP && t % 2 ? 2 : 1);
        const c = mode === PrimitiveType.TRIANGLES ? a + 2 : t + (mode === PrimitiveType.TRIANGLE_STRIP && t % 2 ? 1 : 2);
        indices[t * 3] = valueAt(a); indices[t * 3 + 1] = valueAt(b); indices[t * 3 + 2] = valueAt(c);
        if ((t & 32767) === 32767) { vertexWork += 32768; await yieldIfNeeded(); }
      }
      for (let instance = 0; instance < instanceMatrices.length; instance++) {
        const matrix = instanceMatrices[instance], transformed = new Float64Array(positions.length);
        for (let p = 0; p < positions.length; p += 3) {
          const x = positions[p], y = positions[p + 1], z = positions[p + 2];
          const tx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
          const ty = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
          const tz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
          if (![tx, ty, tz].every(Number.isFinite)) throw new Error('模型实际顶点含无效坐标。');
          transformed[p] = tx; transformed[p + 1] = ty; transformed[p + 2] = tz;
          if ((p / 3 & 32767) === 32767) { vertexWork += 32768; await yieldIfNeeded(); }
        }
        primitives.push({ positions: transformed, indices: indices.slice(), groupId: `node:${index}:instance:${instance}`, nodeIndex: index });
      }
      readStats.bytes += outputBytes; readStats.triangles += triangleCount * instanceCount!; readStats.sourcePrimitives++;
      vertexWork += attribute.count; await yieldIfNeeded();
    }
    readStats.sourceNodes++; await yieldIfNeeded();
  }
  check();
  for (const snapshot of snapshots) {
    assertStaticNode(snapshot.node);
    if (graph._runtimeNodes[snapshot.index] !== snapshot.node || !Matrix4.equals(snapshot.node.computedTransform, snapshot.transform)) throw abort('模型节点变换变化，旧几何读取已取消。');
  }
  return { primitives, worldFromLocal, readStats };
}
