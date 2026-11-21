import { Cartesian3, Matrix4, Transforms } from '@cesium/engine';

export type PreciseClippingGeometry = {
  worldToLocal: Matrix4; earth: Cartesian3; nodes: Float32Array; vertices: Float32Array;
  nodeCount: number; vertexCount: number; rootBounds: [number, number, number, number]; maxDepth: number;
};
type Bounds = [number, number, number, number];
type Leaf = { bounds: Bounds; vertexStart: number; vertexCount: number };
const MAX_VERTICES = 65_536, MAX_POLYGONS = 32_768;
const fail = (message: string): never => { throw new Error(`工程精确裁剪 BVH：${message}`); };
const float = new Float32Array(1), bits = new Uint32Array(float.buffer);

/** Round a bound outwards, so float texture packing never rejects a covered point. */
function outward(value: number, lower: boolean): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) fail('投影坐标不能存入有限浮点纹理');
  if (lower ? rounded <= value : rounded >= value) return rounded;
  float[0] = rounded;
  if (rounded === 0) { bits[0] = lower ? 0x80000001 : 1; return float[0]; }
  bits[0] += (rounded > 0) === lower ? -1 : 1;
  return float[0];
}
function combine(a: Bounds, b: Bounds): Bounds {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Builds an acceleration structure over the original polygon rings. Bounding
 * rectangles only reject queries; leaf winding always uses every source vertex.
 * Inputs are already the exact polygon-minus-holes decomposition from the Worker. */
export function buildPreciseClippingGeometry(polygons: readonly (readonly Cartesian3[])[]): PreciseClippingGeometry {
  if (!polygons.length || polygons.length > MAX_POLYGONS) fail(`多边形数量须为 1–${MAX_POLYGONS}`);
  const vertexCount = polygons.reduce((n, ring) => n + ring.length, 0);
  if (vertexCount > MAX_VERTICES || polygons.some(ring => ring.length < 3)) fail(`原始边界数量无效或超过 ${MAX_VERTICES} 点预算`);
  const sums = [0, 0, 0], corrections = [0, 0, 0];
  for (const ring of polygons) for (const p of ring) {
    for (const [axis, value] of [p.x, p.y, p.z].entries()) {
      if (!Number.isFinite(value)) fail('输入包含非有限世界坐标');
      const adjusted = value - corrections[axis], next = sums[axis] + adjusted;
      corrections[axis] = (next - sums[axis]) - adjusted; sums[axis] = next;
    }
  }
  const origin = new Cartesian3(sums[0] / vertexCount, sums[1] / vertexCount, sums[2] / vertexCount);
  if (Cartesian3.magnitude(origin) < 1_000_000) fail('平均原点过近地心或跨越反向半球');
  const worldToLocal = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(origin), new Matrix4());
  const earth = Matrix4.multiplyByPoint(worldToLocal, Cartesian3.ZERO, new Cartesian3());
  if (!(earth.z < -1)) fail('局部切平面方向无效');
  const vertices = new Float32Array(vertexCount * 4), leaves: Leaf[] = [];
  let position = 0;
  for (const ring of polygons) {
    const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity], vertexStart = position;
    for (const world of ring) {
      const p = Matrix4.multiplyByPoint(worldToLocal, world, new Cartesian3()), denominator = p.z - earth.z;
      if (!Number.isFinite(denominator) || denominator <= Math.max(1, Math.abs(earth.z) * 1e-12)) fail('顶点射线与平面平行或位于地心反向');
      const x = p.x - p.z * (p.x - earth.x) / denominator, y = p.y - p.z * (p.y - earth.y) / denominator;
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail('中心投影产生非有限坐标');
      vertices[position * 4] = x; vertices[position * 4 + 1] = y;
      if (!Number.isFinite(vertices[position * 4]) || !Number.isFinite(vertices[position * 4 + 1])) fail('投影范围超过浮点纹理容量');
      bounds[0] = Math.min(bounds[0], outward(x, true)); bounds[1] = Math.min(bounds[1], outward(y, true));
      bounds[2] = Math.max(bounds[2], outward(x, false)); bounds[3] = Math.max(bounds[3], outward(y, false));
      position++;
    }
    leaves.push({ bounds, vertexStart, vertexCount: ring.length });
  }
  const data: number[] = []; let maxDepth = 0;
  const build = (items: Leaf[], depth: number): number => {
    const current = data.length / 8, bounds = items.reduce((box, item) => combine(box, item.bounds), items[0].bounds);
    data.push(...bounds, 0, 0, 0, 0); maxDepth = Math.max(maxDepth, depth);
    if (items.length === 1) {
      data[current * 8 + 5] = items[0].vertexStart; data[current * 8 + 6] = items[0].vertexCount;
    } else {
      const centroids: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const item of items) {
        const x = (item.bounds[0] + item.bounds[2]) / 2, y = (item.bounds[1] + item.bounds[3]) / 2;
        centroids[0] = Math.min(centroids[0], x); centroids[1] = Math.min(centroids[1], y);
        centroids[2] = Math.max(centroids[2], x); centroids[3] = Math.max(centroids[3], y);
      }
      const axis = centroids[2] - centroids[0] >= centroids[3] - centroids[1] ? 0 : 1;
      items.sort((a, b) => (a.bounds[axis] + a.bounds[axis + 2]) - (b.bounds[axis] + b.bounds[axis + 2]) || a.vertexStart - b.vertexStart);
      const middle = Math.floor(items.length / 2); build(items.slice(0, middle), depth + 1); build(items.slice(middle), depth + 1);
    }
    data[current * 8 + 4] = data.length / 8; return current;
  };
  build(leaves, 1);
  return { worldToLocal, earth, nodes: Float32Array.from(data), vertices, nodeCount: data.length / 8, vertexCount,
    rootBounds: [data[0], data[1], data[2], data[3]], maxDepth };
}
