import { ShapeUtils, Vector2 } from 'three';

/** All coordinates share one local, metre-based frame. z is the original surface,
 * not a height sampled by this module. The horizontal design plane is explicit. */
export type SurfaceEditLocalPoint = { x: number; y: number; z: number };
export type SurfaceEditGeometryInput = {
  mode: 'excavation' | 'flatten';
  outer: readonly SurfaceEditLocalPoint[];
  holes?: readonly (readonly SurfaceEditLocalPoint[])[];
  targetElevation: number;
  textureScaleMeters?: number;
};
export type SurfaceEditGeometryLimits = {
  boundaryPoints: number;
  holes: number;
  topologyChecks: number;
  vertices: number;
  triangles: number;
  extent: number;
  heightDifference: number;
  memoryBytes: number;
};

/** Conservative prototype ceilings, not a claim about the user's GPU or data.
 * Callers can request stricter preview budgets; increasing these ceilings needs
 * explicit source changes and representative-device validation. */
export const SURFACE_EDIT_GEOMETRY_LIMITS: Readonly<SurfaceEditGeometryLimits> = Object.freeze({
  boundaryPoints: 512,
  holes: 16,
  topologyChecks: 1_100_000,
  vertices: 6_144,
  triangles: 3_072,
  extent: 10_000,
  heightDifference: 1_000,
  memoryBytes: 2 * 1024 * 1024,
});

export type SurfaceEditGeometryEstimate = {
  boundaryPoints: number;
  holes: number;
  topologyChecks: number;
  vertices: number;
  triangles: number;
  memoryBytes: number;
};
export type SurfaceEditMesh = {
  positions: Float64Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
};
export type SurfaceEditGeometryResult = {
  surface: SurfaceEditMesh;
  walls: SurfaceEditMesh;
  area: number;
  perimeter: number;
  boundaryPoints: number;
  sampleCount: 0;
  algorithmVersion: 1;
  estimate: SurfaceEditGeometryEstimate;
};

const EPSILON = 1e-7;
const MIN_AREA = 0.01;
const integerKeys = new Set<keyof SurfaceEditGeometryLimits>([
  'boundaryPoints', 'holes', 'topologyChecks', 'vertices', 'triangles', 'memoryBytes',
]);

function limitsFor(overrides: Partial<SurfaceEditGeometryLimits>): SurfaceEditGeometryLimits {
  const result = { ...SURFACE_EDIT_GEOMETRY_LIMITS };
  for (const key of Object.keys(overrides) as (keyof SurfaceEditGeometryLimits)[]) {
    if (!(key in SURFACE_EDIT_GEOMETRY_LIMITS)) throw new Error('地表生成预算包含未知项目。');
    const value = overrides[key];
    if (!Number.isFinite(value) || value! < (key === 'holes' ? 0 : 1)
      || (integerKeys.has(key) && !Number.isSafeInteger(value))
      || value! > SURFACE_EDIT_GEOMETRY_LIMITS[key])
      throw new Error(`地表生成预算 ${key} 无效或超过硬上限。`);
    result[key] = value!;
  }
  return result;
}

function boundedCount(input: SurfaceEditGeometryInput, limits: SurfaceEditGeometryLimits) {
  if (input?.mode !== 'excavation' && input?.mode !== 'flatten') throw new Error('地表编辑类型无效。');
  if (!Array.isArray(input.outer) || !Array.isArray(input.holes ?? [])) throw new Error('缺少有效地表边界。');
  const holes = input.holes ?? [];
  if (holes.length > limits.holes) throw new Error(`保留区数量超过 ${limits.holes} 个上限，请分区处理。`);
  // Check lengths before flattening, cloning, triangulating or allocating buffers.
  // Closed-ring duplicate endpoints count towards the budget deliberately.
  let count = input.outer.length;
  if (count > limits.boundaryPoints) throw new Error(`边界点数超过 ${limits.boundaryPoints} 点上限，请分区处理。`);
  for (const hole of holes) {
    if (!Array.isArray(hole)) throw new Error('保留区边界无效。');
    count += hole.length;
    if (count > limits.boundaryPoints) throw new Error(`边界累计点数超过 ${limits.boundaryPoints} 点上限，请分区处理。`);
  }
  if (input.outer.length < 3 || holes.some(hole => hole.length < 3)) throw new Error('每个边界至少需要三个不同点。');
  return { count, holeCount: holes.length };
}

/** An upper bound checked before any geometry work. Work includes a bounded
 * quadratic allowance for topology/triangulation, not just final GPU buffers.
 * A crossing of the target plane may split each side edge into two triangles. */
function estimateFromCount(count: number, holes: number, limits: SurfaceEditGeometryLimits): SurfaceEditGeometryEstimate {
  const topologyChecks = 4 * count * count + 2 * holes * count;
  const surfaceTriangles = count + 2 * holes - 2;
  const wallVertices = 6 * count;
  const wallTriangles = 2 * count;
  const vertices = count + wallVertices;
  const triangles = surfaceTriangles + wallTriangles;
  // Float64 xyz + Float32 normal/uv + Uint32 indices; factor four also budgets
  // bounded JS staging arrays, ring copies and triangulator scratch storage.
  const memoryBytes = 4 * (vertices * (3 * 8 + 3 * 4 + 2 * 4) + triangles * 3 * 4 + count * 128);
  if (topologyChecks > limits.topologyChecks) throw new Error('边界拓扑计算超过预算，请减少细碎边界或分区处理。');
  if (vertices > limits.vertices || triangles > limits.triangles) throw new Error('预计地表网格规模超过预算，请分区处理。');
  if (memoryBytes > limits.memoryBytes) throw new Error('预计地表生成内存超过预算，请分区处理。');
  return { boundaryPoints: count, holes, topologyChecks, vertices, triangles, memoryBytes };
}

export function estimateSurfaceEditGeometry(
  input: SurfaceEditGeometryInput,
  overrides: Partial<SurfaceEditGeometryLimits> = {},
): SurfaceEditGeometryEstimate {
  const limits = limitsFor(overrides), { count, holeCount } = boundedCount(input, limits);
  return estimateFromCount(count, holeCount, limits);
}

const cross = (a: SurfaceEditLocalPoint, b: SurfaceEditLocalPoint, c: SurfaceEditLocalPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const length = (a: SurfaceEditLocalPoint, b: SurfaceEditLocalPoint) => Math.hypot(b.x - a.x, b.y - a.y);
function signedArea(points: readonly SurfaceEditLocalPoint[]) {
  let result = 0;
  for (let i = 1; i < points.length - 1; i++) result += cross(points[0], points[i], points[i + 1]);
  return result / 2;
}
function onSegment(a: SurfaceEditLocalPoint, b: SurfaceEditLocalPoint, p: SurfaceEditLocalPoint) {
  return Math.abs(cross(a, b, p)) <= EPSILON * Math.max(1, length(a, b))
    && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
    && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}
function intersects(a: SurfaceEditLocalPoint, b: SurfaceEditLocalPoint, c: SurfaceEditLocalPoint, d: SurfaceEditLocalPoint) {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - EPSILON || Math.max(c.x, d.x) < Math.min(a.x, b.x) - EPSILON
    || Math.max(a.y, b.y) < Math.min(c.y, d.y) - EPSILON || Math.max(c.y, d.y) < Math.min(a.y, b.y) - EPSILON) return false;
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function contains(ring: readonly SurfaceEditLocalPoint[], p: SurfaceEditLocalPoint) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(a, b, p)) return false;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function ringsIntersect(a: readonly SurfaceEditLocalPoint[], b: readonly SurfaceEditLocalPoint[]) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++)
    if (intersects(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}
function normaliseRing(points: readonly SurfaceEditLocalPoint[], isHole: boolean) {
  const ring = points.map(p => {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) throw new Error('地表边界包含无效坐标或高程；不能用零高程替代。');
    if (Math.abs(p.x) > 10_000_000 || Math.abs(p.y) > 10_000_000 || Math.abs(p.z) > 100_000)
      throw new Error('地表边界超出局部米制坐标范围，请核对坐标基准。');
    return { x: p.x, y: p.y, z: p.z };
  });
  if (ring.length > 1 && ring[0].x === ring.at(-1)!.x && ring[0].y === ring.at(-1)!.y) {
    if (ring[0].z !== ring.at(-1)!.z) throw new Error('闭合边界的同一顶点高程不一致。');
    ring.pop();
  }
  if (ring.length < 3) throw new Error('每个边界至少需要三个不同点。');
  const unique = new Set<string>();
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], key = `${p.x}/${p.y}`;
    if (unique.has(key)) throw new Error('地表边界含重复顶点。');
    unique.add(key);
    if (length(p, ring[(i + 1) % ring.length]) <= EPSILON) throw new Error('地表边界包含过短或退化边。');
  }
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
    if (intersects(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length]))
      throw new Error('地表边界自相交，无法生成。');
  }
  // Adjacent backtracking edges overlap but are deliberately absent above.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
    if (Math.abs(cross(a, b, c)) <= EPSILON * Math.max(1, length(a, b), length(b, c))
      && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0)
      throw new Error('地表边界存在折返重叠边。');
  }
  const area = signedArea(ring);
  if (Math.abs(area) < MIN_AREA) throw new Error('地表边界面积过小或退化。');
  if ((area > 0) === isHole) ring.reverse();
  return ring;
}

function emptyMesh(): SurfaceEditMesh {
  return { positions: new Float64Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) };
}

/** Builds an exact horizontal face and original-boundary-to-face walls.
 * No interior grid and no photography queries are needed. Run in a Worker for
 * interactive use; the caller owns cancellation and atomic scene submission. */
export function buildSurfaceEditGeometry(
  input: SurfaceEditGeometryInput,
  overrides: Partial<SurfaceEditGeometryLimits> = {},
): SurfaceEditGeometryResult {
  const limits = limitsFor(overrides), { count, holeCount } = boundedCount(input, limits);
  const estimate = estimateFromCount(count, holeCount, limits);
  const target = input.targetElevation, scale = input.textureScaleMeters ?? 4;
  if (!Number.isFinite(target) || Math.abs(target) > 100_000) throw new Error('目标标高无效。');
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 10_000) throw new Error('纹理尺寸须在 0.01 至 10000 米之间。');
  const outer = normaliseRing(input.outer, false), holes = (input.holes ?? []).map(h => normaliseRing(h, true));
  const rings = [outer, ...holes], points = rings.flat();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    if (Math.abs(p.z - target) > limits.heightDifference) throw new Error('设计面与边界高差超过支持范围，请核对高程。');
    if (input.mode === 'excavation' && p.z <= target + EPSILON) throw new Error('开挖坑底须低于全部外边界及保留区边界，请降低坑底标高。');
  }
  if (maxX - minX > limits.extent || maxY - minY > limits.extent) throw new Error('地表范围超过局部建模上限，请分区处理。');
  for (let i = 0; i < holes.length; i++) {
    if (!contains(outer, holes[i][0]) || ringsIntersect(outer, holes[i]))
      throw new Error('保留区必须严格位于外边界内，不能接触或越界。');
    for (let j = 0; j < i; j++) if (ringsIntersect(holes[i], holes[j]) || contains(holes[i], holes[j][0]) || contains(holes[j], holes[i][0]))
      throw new Error('保留区不能重叠、接触或相互包含。');
  }
  const area = Math.abs(signedArea(outer)) - holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
  if (area < MIN_AREA) throw new Error('扣除保留区后的地表面积过小。');
  const vectors = rings.map(ring => ring.map(p => new Vector2(p.x, p.y)));
  const faces = ShapeUtils.triangulateShape(vectors[0], vectors.slice(1));
  if (!faces.length || faces.length > estimate.triangles) throw new Error('地表三角化失败或超出网格预算。');
  let triangulatedArea = 0;
  for (const face of faces) {
    if (face.length !== 3 || face.some(i => !Number.isSafeInteger(i) || i < 0 || i >= points.length)) throw new Error('地表三角化生成了无效索引。');
    const signed = cross(points[face[0]], points[face[1]], points[face[2]]) / 2;
    if (Math.abs(signed) < 1e-12) throw new Error('地表三角化生成了退化面。');
    if (signed < 0) [face[1], face[2]] = [face[2], face[1]];
    triangulatedArea += Math.abs(signed);
  }
  if (Math.abs(triangulatedArea - area) > Math.max(1e-6, area * 1e-7)) throw new Error('地表三角化未通过面积复核，原场景保持不变。');
  const surface: SurfaceEditMesh = {
    positions: new Float64Array(points.length * 3), normals: new Float32Array(points.length * 3),
    uvs: new Float32Array(points.length * 2), indices: new Uint32Array(faces.length * 3),
  };
  points.forEach((p, i) => {
    surface.positions.set([p.x, p.y, target], i * 3);
    surface.normals.set([0, 0, 1], i * 3);
    surface.uvs.set([(p.x - minX) / scale, (p.y - minY) / scale], i * 2);
  });
  faces.forEach((f, i) => surface.indices.set(f, i * 3));

  const wallPositions: number[] = [], wallNormals: number[] = [], wallUvs: number[] = [], wallIndices: number[] = [];
  let perimeter = 0;
  function triangle(a: SurfaceEditLocalPoint, b: SurfaceEditLocalPoint, c: SurfaceEditLocalPoint,
    uv: readonly [number, number][], nx: number, ny: number) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const actualX = aby * acz - abz * acy, actualY = abz * acx - abx * acz;
    if (Math.hypot(actualX, actualY) <= 1e-12) return;
    const verts = [a, b, c], coords = [...uv];
    if (actualX * nx + actualY * ny < 0) {
      [verts[1], verts[2]] = [verts[2], verts[1]];
      [coords[1], coords[2]] = [coords[2], coords[1]];
    }
    const start = wallPositions.length / 3;
    if (points.length + start + 3 > estimate.vertices || faces.length + wallIndices.length / 3 + 1 > estimate.triangles)
      throw new Error('实际地表网格超过预估预算，已停止生成。');
    verts.forEach((p, i) => { wallPositions.push(p.x, p.y, p.z); wallNormals.push(nx, ny, 0); wallUvs.push(...coords[i]); });
    wallIndices.push(start, start + 1, start + 2);
  }
  for (const ring of rings) {
    let along = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], distance = length(a, b);
      const da = a.z - target, db = b.z - target;
      const segments: [SurfaceEditLocalPoint, SurfaceEditLocalPoint, number, number][] = [];
      if (da * db < 0) {
        const t = da / (da - db), m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: target };
        segments.push([a, m, along, along + distance * t], [m, b, along + distance * t, along + distance]);
      } else segments.push([a, b, along, along + distance]);
      for (const [u, v, startU, endU] of segments) {
        const meanDelta = ((u.z - target) + (v.z - target)) / 2;
        if (Math.abs(meanDelta) <= EPSILON) continue;
        // Every normalised ring has the edited domain on its left. Cut walls
        // face that domain; fill walls face outwards. Holes follow the same rule.
        const side = meanDelta > 0 ? 1 : -1, nx = -(b.y - a.y) / distance * side, ny = (b.x - a.x) / distance * side;
        const lowU = { x: u.x, y: u.y, z: target }, lowV = { x: v.x, y: v.y, z: target };
        const uu = startU / scale, vv = endU / scale, uh = (u.z - target) / scale, vh = (v.z - target) / scale;
        triangle(u, v, lowV, [[uu, uh], [vv, vh], [vv, 0]], nx, ny);
        triangle(u, lowV, lowU, [[uu, uh], [vv, 0], [uu, 0]], nx, ny);
      }
      along += distance;
    }
    perimeter += along;
  }
  const walls = wallPositions.length ? {
    positions: new Float64Array(wallPositions), normals: new Float32Array(wallNormals),
    uvs: new Float32Array(wallUvs), indices: new Uint32Array(wallIndices),
  } : emptyMesh();
  return { surface, walls, area, perimeter, boundaryPoints: points.length, sampleCount: 0, algorithmVersion: 1, estimate };
}
