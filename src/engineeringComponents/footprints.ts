// The engine entry is Worker-safe; the cesium umbrella also imports DOM widgets.
import { Cartesian3, Cartographic, Matrix4, Quaternion, Transforms } from '@cesium/engine';
import { ShapeUtils, Vector2 } from 'three';
// clipper-lib ships the original Boost/JSBN license notices in its distribution.
// Its fixed integer predicates avoid floating sweep-line failures on coincident GLB faces.
// @ts-expect-error The upstream package does not publish TypeScript declarations.
import ClipperLib from 'clipper-lib';
import type { TemporaryWorksFootprint } from '../temporaryWorksClipping';

export type EngineeringFootprintBinding = Readonly<{ componentId: string; nodeIndices: readonly number[] }>;
export type EngineeringRuntimeNodeTransform = Readonly<{ nodeIndex: number; matrix: readonly number[] }>;
export type EngineeringFootprintResult = {
  footprints: TemporaryWorksFootprint[]; componentCount: number; triangleCount: number;
  boundaryPoints: number; polygons: number; topologyChecks: number; milliseconds: number;
  rawBoundaryPoints: number; rawPolygons: number; rawHoles: number;
  rawAreaSquareMeters: number; compiledAreaSquareMeters: number;
  quantizationGridMeters: number; maxQuantizationErrorMeters: number;
  maxInputQuantizationErrorMeters: number; maxIntersectionQuantizationErrorMeters: number;
  quantizationPasses: number; quantizationDisplacementBudgetMeters: number;
};
type Point = [number, number];
type Polygon = Point[][];
type IntPoint = { X: number; Y: number };
type IntPath = IntPoint[];
type Quantization = { intersection: number };
type PolyNode = { Contour(): IntPath; Childs(): PolyNode[]; IsHole(): boolean };
type Node = { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[];
  scale?: number[]; skin?: number; weights?: number[]; extras?: { componentId?: string } };
type Accessor = { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string; sparse?: unknown; normalized?: boolean };
type Primitive = { mode?: number; attributes: { POSITION: number }; indices?: number; targets?: unknown; extensions?: unknown };
type Gltf = { asset: { version: string }; scene?: number; scenes: { nodes: number[] }[]; nodes: Node[];
  meshes: { primitives: Primitive[]; weights?: number[] }[]; buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors: Accessor[]; extensionsRequired?: string[]; animations?: unknown[] };
type DecodedPrimitive = { positions: Float64Array; indices: Uint32Array };
const GRID = 1e-8, SCALE = 1 / GRID, MAX_BYTES = 512 * 1024 * 1024;
const MAX_TRIANGLES = 3_000_000, MAX_COORDINATE = 100_000, TIME_LIMIT_MS = 120_000;
const fail = (message: string): never => { throw new Error(`工程精确轮廓：${message}`); };
function matrix(value: readonly number[], label: string): Matrix4 {
  if (value.length !== 16 || !value.every(Number.isFinite) || value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1)
    return fail(`${label} 不是有效仿射矩阵`);
  return Matrix4.fromArray([...value]);
}
function index(value: unknown, length: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) return fail(`${label} 索引越界`);
  return value as number;
}
function area(ring: readonly Point[]): number {
  if (ring.length < 3) return 0;
  const origin = ring[0]; let result = 0;
  for (let i = 1; i < ring.length - 1; i++) result += (ring[i][0] - origin[0]) * (ring[i + 1][1] - origin[1]) - (ring[i][1] - origin[1]) * (ring[i + 1][0] - origin[0]);
  return result / 2;
}
export function orientationOfIntegerTriangle(path: readonly IntPoint[]): number {
  const [a, b, c] = path;
  const x1 = b.X - a.X, y1 = b.Y - a.Y, x2 = c.X - a.X, y2 = c.Y - a.Y;
  const left = x1 * y2, right = y1 * x2, determinant = left - right;
  if (Math.abs(determinant) > Number.EPSILON * 16 * (Math.abs(left) + Math.abs(right))) return Math.sign(determinant);
  // Integer coordinates can exceed double's exact product range. In the
  // near-collinear case an exact sign prevents dropping a real thin triangle.
  const exact = BigInt(x1) * BigInt(y2) - BigInt(y1) * BigInt(x2);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}
function measuredIntegerOperation<T>(statistics: Quantization, action: () => T): T {
  const round = ClipperLib.Clipper.Round;
  // Clipper invokes this only synchronously. Restore its original predicate in
  // finally so test contexts and subsequent operations do not share mutable hooks.
  ClipperLib.Clipper.Round = (value: number) => {
    const result = round(value);
    statistics.intersection = Math.max(statistics.intersection, Math.abs(result - value) / SCALE);
    return result;
  };
  try { return action(); } finally { ClipperLib.Clipper.Round = round; }
}
function union(paths: IntPath[], statistics: Quantization): IntPath[] {
  if (paths.length < 2) return paths;
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const result: IntPath[] = [];
  if (!measuredIntegerOperation(statistics, () => clipper.Execute(ClipperLib.ClipType.ctUnion, result, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero))) fail('整数轮廓并集失败，未应用不完整结果');
  return result;
}
function polygonTree(paths: IntPath[], statistics: Quantization): Polygon[] {
  if (!paths.length) return [];
  const clipper = new ClipperLib.Clipper(); clipper.StrictlySimple = true;
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree() as PolyNode;
  if (!measuredIntegerOperation(statistics, () => clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero))) fail('最终整数轮廓并集失败');
  const polygons: Polygon[] = [];
  const ring = (path: IntPath): Point[] => path.map(p => [p.X / SCALE, p.Y / SCALE]);
  function visit(node: PolyNode) {
    if (node.Contour().length && !node.IsHole()) polygons.push([ring(node.Contour()), ...node.Childs().filter(child => child.IsHole()).map(child => ring(child.Contour()))]);
    for (const child of node.Childs()) visit(child);
  }
  visit(tree); return polygons;
}

/** Immutable source parsing and all expensive geometry operations run in the dedicated Worker. */
export class EngineeringFootprintGeometry {
  private readonly gltf: Gltf;
  private readonly binary: DataView;
  private readonly transforms = new Map<number, Matrix4>();
  private readonly bindings = new Map<string, readonly number[]>();
  private readonly meshes = new Map<number, DecodedPrimitive[]>();
  constructor(bytes: ArrayBuffer, bindings: readonly EngineeringFootprintBinding[], runtime?: readonly EngineeringRuntimeNodeTransform[]) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 28 || bytes.byteLength > MAX_BYTES) fail('GLB 字节长度不合法');
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) fail('GLB 头或总长度不合法');
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 || 28 + jsonLength > bytes.byteLength) fail('GLB JSON 区不合法');
    this.gltf = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, 20, jsonLength))) as Gltf;
    const gltf = this.gltf, binaryLength = view.getUint32(20 + jsonLength, true);
    if (view.getUint32(24 + jsonLength, true) !== 0x004e4942 || 28 + jsonLength + binaryLength !== bytes.byteLength) fail('GLB BIN 区不合法');
    if (gltf.asset?.version !== '2.0' || !Array.isArray(gltf.nodes) || gltf.nodes.length > 200_000 || !Array.isArray(gltf.meshes) || !Array.isArray(gltf.scenes) || !Array.isArray(gltf.accessors) || !Array.isArray(gltf.bufferViews)) fail('GLB schema 不合法');
    if (gltf.buffers?.length !== 1 || gltf.buffers[0].uri || gltf.buffers[0].byteLength > binaryLength || gltf.extensionsRequired?.length || gltf.animations?.length) fail('外部缓冲、必需扩展或动画暂不支持，未近似源模型');
    this.binary = new DataView(bytes, 28 + jsonLength, gltf.buffers[0].byteLength);
    const scene = gltf.scenes[index(gltf.scene ?? 0, gltf.scenes.length, '场景')];
    const active = new Set<number>();
    const walk = (nodeIndex: number, parent: Matrix4, depth: number) => {
      index(nodeIndex, gltf.nodes.length, '节点');
      if (depth > 256 || active.has(nodeIndex) || this.transforms.has(nodeIndex)) fail('节点树循环、重复父级或过深');
      active.add(nodeIndex); const node = gltf.nodes[nodeIndex];
      if (node.skin !== undefined || node.weights || (node.matrix && (node.translation || node.rotation || node.scale))) fail('节点蒙皮、变形或冲突变换不支持');
      const vector = (values: number[] | undefined, fallback: number[], label: string) => {
        const result = values ?? fallback;
        if (result.length !== fallback.length || !result.every(Number.isFinite)) fail(`节点 ${label} 无效`);
        return result;
      };
      const local = node.matrix ? matrix(node.matrix, '节点') : Matrix4.fromTranslationQuaternionRotationScale(
        Cartesian3.fromArray(vector(node.translation, [0, 0, 0], 'translation')),
        Quaternion.unpack(vector(node.rotation, [0, 0, 0, 1], 'rotation')),
        Cartesian3.fromArray(vector(node.scale, [1, 1, 1], 'scale')));
      const transform = Matrix4.multiply(parent, local, new Matrix4()); this.transforms.set(nodeIndex, transform);
      for (const child of node.children ?? []) walk(child, transform, depth + 1);
      active.delete(nodeIndex);
    };
    if (!Array.isArray(scene.nodes)) fail('场景根节点无效');
    for (const root of scene.nodes) walk(root, Matrix4.IDENTITY, 0);
    const occupied = new Set<number>();
    if (!Array.isArray(bindings) || bindings.length > 100_000) fail('构件绑定数量无效');
    for (const binding of bindings) {
      if (!binding.componentId || this.bindings.has(binding.componentId) || !binding.nodeIndices.length) fail('构件绑定重复或为空');
      for (const n of binding.nodeIndices) {
        const node = gltf.nodes[index(n, gltf.nodes.length, '绑定节点')];
        if (occupied.has(n) || !this.transforms.has(n) || node.mesh === undefined || node.children?.length || node.extras?.componentId !== binding.componentId) fail(`构件 ${binding.componentId} 必须绑定唯一物理 mesh 叶节点`);
        occupied.add(n); index(node.mesh, gltf.meshes.length, 'mesh');
        for (const primitive of gltf.meshes[node.mesh!].primitives) if ((primitive.mode ?? 4) !== 4 || primitive.targets || primitive.extensions) fail(`构件 ${binding.componentId} 不是可验证的静态三角形网格`);
      }
      this.bindings.set(binding.componentId, [...binding.nodeIndices]);
    }
    if (runtime) {
      const seen = new Set<number>();
      for (const entry of runtime) {
        if (seen.has(entry.nodeIndex)) fail('运行节点矩阵重复'); seen.add(entry.nodeIndex);
        const parsed = this.transforms.get(entry.nodeIndex), actual = matrix(entry.matrix, '运行节点');
        if (!parsed || Matrix4.toArray(parsed).some((v, i) => Math.abs(v - actual[i]) > 1e-10 * Math.max(1, Math.abs(v), Math.abs(actual[i])))) fail(`运行节点 ${entry.nodeIndex} 与 GLB 累积矩阵不一致`);
      }
      for (const n of occupied) if (!seen.has(n)) fail(`运行节点 ${n} 缺少矩阵核对`);
    }
  }

  private accessor(accessorIndex: number, position: boolean): Float64Array | Uint32Array {
    const gltf = this.gltf, a = gltf.accessors[index(accessorIndex, gltf.accessors.length, 'accessor')];
    const width = position ? 3 : 1, size = a.componentType === 5121 ? 1 : a.componentType === 5123 ? 2 : 4;
    if (a.type !== (position ? 'VEC3' : 'SCALAR') || (position ? a.componentType !== 5126 : ![5121, 5123, 5125].includes(a.componentType)) || a.sparse || a.normalized || !Number.isSafeInteger(a.count) || a.count < 1 || a.count > MAX_TRIANGLES * 3) fail('POSITION/indices accessor 类型或数量不支持');
    const v = gltf.bufferViews[index(a.bufferView, gltf.bufferViews.length, 'bufferView')];
    const offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = v.byteStride ?? width * size;
    if (v.buffer !== 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(stride) || stride < width * size || stride % size || (a.byteOffset ?? 0) + (a.count - 1) * stride + width * size > v.byteLength || (v.byteOffset ?? 0) + v.byteLength > this.binary.byteLength) fail('accessor 字节范围越界');
    const result = position ? new Float64Array(a.count * width) : new Uint32Array(a.count);
    for (let i = 0; i < a.count; i++) for (let j = 0; j < width; j++) {
      const p = offset + i * stride + j * size;
      const value = position ? this.binary.getFloat32(p, true) : size === 1 ? this.binary.getUint8(p) : size === 2 ? this.binary.getUint16(p, true) : this.binary.getUint32(p, true);
      if (!Number.isFinite(value)) fail('网格包含非有限坐标'); result[i * width + j] = value;
    }
    return result;
  }
  private primitives(meshIndex: number): DecodedPrimitive[] {
    let result = this.meshes.get(meshIndex); if (result) return result;
    const mesh = this.gltf.meshes[meshIndex]; if (mesh.weights) fail('mesh morph weights 不支持');
    result = mesh.primitives.map(p => {
      const positions = this.accessor(p.attributes.POSITION, true) as Float64Array;
      const indices = p.indices === undefined ? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) : this.accessor(p.indices, false) as Uint32Array;
      if (indices.length % 3 || indices.some(i => i >= positions.length / 3)) fail('网格三角形索引越界');
      return { positions, indices };
    });
    this.meshes.set(meshIndex, result); return result;
  }

  async project(worldFromGltf: readonly number[], componentIds: readonly string[], onProgress?: (message: string) => void): Promise<EngineeringFootprintResult> {
    const start = performance.now(), world = matrix(worldFromGltf, '实例');
    const origin = Matrix4.getTranslation(world, new Cartesian3());
    if (Cartesian3.magnitude(origin) < 6_000_000 || Cartesian3.magnitude(origin) > 10_000_000) fail('实例必须位于已定位的地球场景');
    const frame = Transforms.eastNorthUpToFixedFrame(origin), inverse = Matrix4.inverseTransformation(frame, new Matrix4());
    const projectedRoot = Matrix4.multiply(inverse, world, new Matrix4()), earth = Matrix4.multiplyByPoint(inverse, Cartesian3.ZERO, new Cartesian3());
    const ids = [...new Set(componentIds)]; if (ids.length !== componentIds.length) fail('启用构件重复');
    for (const id of ids) if (!this.bindings.has(id)) fail(`未知物理构件 ${id}`);
    const all: IntPath[][] = [], quantization = { intersection: 0 };
    let triangleCount = 0, maxInputQuantizationErrorMeters = 0, quantizationPasses = ids.length ? 3 : 0;
    const quantize = (value: number): number => {
      if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) fail('投影范围超过 100 km，请检查实例矩阵');
      const integer = Math.round(value * SCALE);
      maxInputQuantizationErrorMeters = Math.max(maxInputQuantizationErrorMeters, Math.abs(integer / SCALE - value)); return integer;
    };
    const check = () => { if (performance.now() - start > TIME_LIMIT_MS) fail('精确计算超过 120 秒预算，原有效遮挡保留'); };
    for (let ci = 0; ci < ids.length; ci++) {
      const paths: IntPath[] = [];
      for (const n of this.bindings.get(ids[ci])!) {
        const m = Matrix4.toArray(Matrix4.multiply(projectedRoot, this.transforms.get(n)!, new Matrix4()));
        // Remove only machine-roundoff residuals in the affine linear portion.
        for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
          const v = m[k], nearest = Math.round(v); if (Math.abs(v - nearest) <= Number.EPSILON * 64) m[k] = nearest;
        }
        for (const primitive of this.primitives(this.gltf.nodes[n].mesh!)) {
          const { positions, indices } = primitive; triangleCount += indices.length / 3;
          if (triangleCount > MAX_TRIANGLES) fail('原始三角形数量超过 300 万预算');
          const xy = new Float64Array(positions.length / 3 * 2);
          for (let j = 0; j < positions.length; j += 3) {
            const x = m[0] * positions[j] + m[4] * positions[j + 1] + m[8] * positions[j + 2] + m[12];
            const y = m[1] * positions[j] + m[5] * positions[j + 1] + m[9] * positions[j + 2] + m[13];
            const z = m[2] * positions[j] + m[6] * positions[j + 1] + m[10] * positions[j + 2] + m[14];
            // Central projection preserves exactly the geocentric directions used by Cesium clipping.
            const denominator = z - earth.z;
            if (!Number.isFinite(denominator) || denominator <= 1 || -earth.z / denominator <= 0) fail('三角形与投影平面平行或位于地心反向');
            xy[j / 3 * 2] = quantize(x - z * (x - earth.x) / denominator);
            xy[j / 3 * 2 + 1] = quantize(y - z * (y - earth.y) / denominator);
          }
          for (let j = 0; j < indices.length; j += 3) {
            const path = [indices[j], indices[j + 1], indices[j + 2]].map(i => ({ X: xy[i * 2], Y: xy[i * 2 + 1] }));
            const signed = orientationOfIntegerTriangle(path); if (signed === 0) continue;
            if (signed < 0) path.reverse(); paths.push(path);
          }
        }
      }
      all.push(union(paths, quantization)); check();
      if (ci % 128 === 0 || ci + 1 === ids.length) { onProgress?.(`正在计算精确轮廓 ${ci + 1}/${ids.length}`); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    let level = all;
    while (level.length > 32) {
      const next: IntPath[][] = [];
      for (let i = 0; i < level.length; i += 32) { next.push(union(level.slice(i, i + 32).flat(), quantization)); check(); await new Promise(resolve => setTimeout(resolve, 0)); }
      level = next; quantizationPasses++;
    }
    onProgress?.('正在保留孔洞并核验最终轮廓');
    const polygons = polygonTree(level.flat(), quantization); check();
    let rawBoundaryPoints = 0, rawHoles = 0, rawAreaSquareMeters = 0, compiledAreaSquareMeters = 0;
    const rings: Point[][] = [];
    for (const polygon of polygons) {
      rawBoundaryPoints += polygon.reduce((n, ring) => n + ring.length, 0); rawHoles += polygon.length - 1;
      const expected = Math.abs(area(polygon[0])) - polygon.slice(1).reduce((n, r) => n + Math.abs(area(r)), 0);
      if (!(expected > 0)) fail('最终轮廓面积或孔洞关系无效'); rawAreaSquareMeters += expected;
      if (polygon.length === 1 && polygon[0].length <= 256) { rings.push(polygon[0]); compiledAreaSquareMeters += expected; continue; }
      const points = polygon.flat(), faces = ShapeUtils.triangulateShape(polygon[0].map(p => new Vector2(...p)), polygon.slice(1).map(r => r.map(p => new Vector2(...p))));
      let computed = 0;
      for (const face of faces) { const ring = face.map(i => points[i]); const a = Math.abs(area(ring)); if (!(a > 0)) fail('孔洞三角剖分产生退化三角形'); computed += a; rings.push(ring); }
      if (Math.abs(computed - expected) > Math.max(1e-9, expected * 1e-10)) fail('孔洞三角剖分面积不守恒，原有效遮挡保留');
      compiledAreaSquareMeters += computed;
    }
    const footprints = rings.map(outer => ({ outer: outer.map(([x, y]) => {
      const point = Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, 0), new Cartesian3()), geo = Cartographic.fromCartesian(point);
      return { longitude: geo.longitude * 180 / Math.PI, latitude: geo.latitude * 180 / Math.PI, height: geo.height };
    }) }));
    return { footprints, componentCount: ids.length, triangleCount, boundaryPoints: rings.reduce((n, r) => n + r.length, 0), polygons: rings.length,
      topologyChecks: rings.reduce((n, r) => n + r.length ** 2, 0), milliseconds: performance.now() - start,
      rawBoundaryPoints, rawPolygons: polygons.length, rawHoles, rawAreaSquareMeters, compiledAreaSquareMeters,
      quantizationGridMeters: GRID, maxQuantizationErrorMeters: Math.max(maxInputQuantizationErrorMeters, quantization.intersection),
      maxInputQuantizationErrorMeters, maxIntersectionQuantizationErrorMeters: quantization.intersection,
      quantizationPasses, quantizationDisplacementBudgetMeters: quantizationPasses * Math.SQRT2 * GRID / 2 };
  }
}
