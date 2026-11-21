import type { ContactBounds, ContactBuildOptions, ContactGeometry, ContactGeometryStats, ContactMeshInput, ContactPoint, ContactPointResult } from './types';

type Triangle = { p: number[]; vertices: number[]; bounds: ContactBounds; group: string; degenerate: boolean };
type Tree = { bounds: ContactBounds; ids?: number[]; left?: Tree; right?: Tree };
type Shell = { ids: number[]; bounds: ContactBounds; tree: Tree; group: string; solid: boolean; volume: number; parent: number; depth: number };
type Entity = { ids: number[]; bounds: ContactBounds; solid: boolean };
const MAX_TRIANGLES = 3_000_000, MAX_CHECKS = 50_000_000, MAX_MS = 120_000;
const emptyBounds = (): ContactBounds => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
const fail = (message: string): never => { throw new Error(`三维模型接触：${message}`); };
const union = (a: ContactBounds, b: ContactBounds): ContactBounds => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
const overlap = (a: ContactBounds, b: ContactBounds, e = 0) => a[0] <= b[3] + e && a[3] + e >= b[0] && a[1] <= b[4] + e && a[4] + e >= b[1] && a[2] <= b[5] + e && a[5] + e >= b[2];
const boundsContain = (a: ContactBounds, b: ContactBounds) => a[0] <= b[0] && a[1] <= b[1] && a[2] <= b[2] && a[3] >= b[3] && a[4] >= b[4] && a[5] >= b[5];
const pointBounds = (p: readonly number[], b: ArrayLike<number>, e: number) => p[0] >= b[0] - e && p[0] <= b[3] + e && p[1] >= b[1] - e && p[1] <= b[4] + e && p[2] >= b[2] - e && p[2] <= b[5] + e;
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm2 = (a: readonly number[]) => dot(a, a);

function segmentDistance2(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const d = sub(b, a), t = Math.min(1, Math.max(0, dot(sub(p, a), d) / (norm2(d) || 1)));
  return norm2([p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]]);
}
/** Distance to the original triangle, including exact degenerate segment/point cases. */
export function contactTriangleDistanceSquared(p: readonly number[], t: ArrayLike<number>): number {
  const a = [t[0], t[1], t[2]], b = [t[3], t[4], t[5]], c = [t[6], t[7], t[8]], ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac), n2 = norm2(n), ap = sub(p, a);
  const edge = Math.min(segmentDistance2(p, a, b), segmentDistance2(p, b, c), segmentDistance2(p, c, a));
  if (n2 === 0) return edge;
  const h = dot(ap, n) / n2, q = [p[0] - h * n[0], p[1] - h * n[1], p[2] - h * n[2]];
  if (dot(cross(ab, sub(q, a)), n) >= 0 && dot(cross(sub(c, b), sub(q, b)), n) >= 0 && dot(cross(sub(a, c), sub(q, c)), n) >= 0) return dot(ap, n) ** 2 / n2;
  return edge;
}

/** +X ray with a half-open projected triangle rule: shared diagonals/vertices
 * contribute once, independent of face orientation. No random ray jitter. */
function rayHit(p: readonly number[], t: ArrayLike<number>, epsilon = 0): boolean {
  let a = [t[0], t[1], t[2]], b = [t[3], t[4], t[5]], c = [t[6], t[7], t[8]];
  const area = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  if (area === 0) return false;
  if (area < 0) [b, c] = [c, b];
  const edge = (u: number[], v: number[]) => (v[1] - u[1]) * (p[2] - u[2]) - (v[2] - u[2]) * (p[1] - u[1]);
  const own = (u: number[], v: number[], value: number) => value > 0 || (value === 0 && (v[2] > u[2] || (v[2] === u[2] && v[1] < u[1])));
  const ea = edge(b, c), eb = edge(c, a), ec = edge(a, b);
  if (!own(b, c, ea) || !own(c, a, eb) || !own(a, b, ec)) return false;
  return (ea * a[0] + eb * b[0] + ec * c[0]) / Math.abs(area) > p[0] + epsilon;
}

function makeTree(ids: number[], getBounds: (id: number) => ContactBounds, leafSize = 8): Tree {
  const bounds = ids.reduce((b, id) => union(b, getBounds(id)), emptyBounds());
  if (ids.length <= leafSize) return { bounds, ids };
  const spans = [bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]], axis = spans.indexOf(Math.max(...spans));
  ids.sort((a, b) => (getBounds(a)[axis] + getBounds(a)[axis + 3]) - (getBounds(b)[axis] + getBounds(b)[axis + 3]) || a - b);
  const middle = Math.floor(ids.length / 2);
  return { bounds, left: makeTree(ids.slice(0, middle), getBounds, leafSize), right: makeTree(ids.slice(middle), getBounds, leafSize) };
}
function shellInside(p: readonly number[], shell: Shell, triangles: Triangle[]): boolean {
  let count = 0;
  const visit = (node: Tree) => {
    const b = node.bounds;
    if (p[1] < b[1] || p[1] > b[4] || p[2] < b[2] || p[2] > b[5] || p[0] > b[3]) return;
    if (node.ids) { for (const id of node.ids) if (rayHit(p, triangles[id].p)) count++; }
    else { visit(node.left!); visit(node.right!); }
  };
  visit(shell.tree); return count % 2 === 1;
}

/** Proper surface intersection. Shared vertices and shared edges alone are
 * allowed. Coplanar pairs are tested by positive-area polygon overlap. */
function trianglesCross(a: Triangle, b: Triangle, epsilon: number): boolean {
  if (!overlap(a.bounds, b.bounds, epsilon)) return false;
  const ap = [a.p.slice(0, 3), a.p.slice(3, 6), a.p.slice(6, 9)], bp = [b.p.slice(0, 3), b.p.slice(3, 6), b.p.slice(6, 9)];
  const na = cross(sub(ap[1], ap[0]), sub(ap[2], ap[0])), nb = cross(sub(bp[1], bp[0]), sub(bp[2], bp[0]));
  const nla = Math.sqrt(norm2(na)), nlb = Math.sqrt(norm2(nb));
  if (!nla || !nlb) return false;
  const da = bp.map(p => dot(sub(p, ap[0]), na) / nla), db = ap.map(p => dot(sub(p, bp[0]), nb) / nlb);
  if (da.every(d => d > epsilon) || da.every(d => d < -epsilon) || db.every(d => d > epsilon) || db.every(d => d < -epsilon)) return false;
  if (da.every(d => Math.abs(d) <= epsilon) && db.every(d => Math.abs(d) <= epsilon)) {
    const axis = na.map(Math.abs).indexOf(Math.max(...na.map(Math.abs))), axes = [0, 1, 2].filter(k => k !== axis);
    const project = (p: number[]) => [p[axes[0]], p[axes[1]]];
    let polygon = ap.map(project), clip = bp.map(project);
    const orient = (x: number[], y: number[], z: number[]) => (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0]);
    if (orient(clip[0], clip[1], clip[2]) < 0) clip = [clip[0], clip[2], clip[1]];
    for (let i = 0; i < 3 && polygon.length; i++) {
      const u = clip[i], v = clip[(i + 1) % 3], next: number[][] = [];
      for (let j = 0; j < polygon.length; j++) {
        const p = polygon[j], q = polygon[(j + 1) % polygon.length], dp = orient(u, v, p), dq = orient(u, v, q);
        if (dp >= 0) next.push(p);
        if ((dp < 0) !== (dq < 0)) { const f = dp / (dp - dq); next.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]); }
      }
      polygon = next;
    }
    let area = 0;
    for (let i = 1; i + 1 < polygon.length; i++) area += Math.abs(orient(polygon[0], polygon[i], polygon[i + 1]));
    return area > epsilon * Math.max(1, nla, nlb);
  }
  // Two noncoplanar planes sharing an exact mesh edge intersect only on that
  // edge. Testing its endpoints numerically can manufacture a tiny interior
  // crossing on a warped quad; the topological fact is exact, not a tolerance.
  if (a.vertices.filter(v => b.vertices.includes(v)).length >= 2) return false;
  // Intersect each triangle with the other plane, then intersect the two
  // resulting intervals on the planes' common line. Exact shared vertices
  // have exactly zero distance; do not manufacture hits through cancellation.
  // This also catches an edge lying in the other plane beyond a shared vertex.
  const direction = cross(na, nb), axis = direction.map(Math.abs).indexOf(Math.max(...direction.map(Math.abs)));
  const interval = (points: number[][], distances: number[], ownVertices: number[], otherVertices: number[]) => {
    const ds = distances.map((d, i) => otherVertices.includes(ownVertices[i]) || Math.abs(d) <= epsilon ? 0 : d), values: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (ds[i] === 0) values.push(points[i][axis]);
      if (ds[i] * ds[j] < 0) { const f = ds[i] / (ds[i] - ds[j]); values.push(points[i][axis] + f * (points[j][axis] - points[i][axis])); }
    }
    return values.length ? [Math.min(...values), Math.max(...values)] : undefined;
  };
  const ia = interval(ap, db, a.vertices, b.vertices), ib = interval(bp, da, b.vertices, a.vertices);
  if (!ia || !ib) return false;
  const low = Math.max(ia[0], ib[0]), high = Math.min(ia[1], ib[1]);
  if (high < low - epsilon) return false;
  if (high - low > epsilon) return true;
  return !a.vertices.some((v, i) => b.vertices.includes(v) && Math.abs(ap[i][axis] - (low + high) / 2) <= epsilon);
}

export function buildContactGeometry(input: ContactMeshInput, options: ContactBuildOptions = {}): ContactGeometry {
  const started = performance.now();
  const stats: ContactGeometryStats = { sourceTriangles: 0, sourcePrimitives: input.primitives.length, sourceGroups: 0, shells: 0, solidEntities: 0, surfaceEntities: 0, cavityShells: 0,
    openShells: 0, nonManifoldShells: 0, inconsistentShells: 0, duplicateTriangles: 0, degenerateTriangles: 0, selfIntersectingShells: 0, ambiguousShells: 0,
    packedTriangles: 0, bvhNodes: 0, maxDepth: 0, topologyChecks: 0, milliseconds: 0, warnings: [] };
  const check = () => {
    if (options.shouldAbort?.()) throw new DOMException('三维接触计算已取消', 'AbortError');
    if (performance.now() - started > MAX_MS) fail('超过 120 秒计算预算；未提交不完整结果');
    if (stats.topologyChecks > MAX_CHECKS) fail('超过 5000 万拓扑检查预算；未将未核验网格冒充实体');
  };
  if (input.worldFromLocal.length !== 16 || input.worldFromLocal.some(v => !Number.isFinite(v))) fail('模型矩阵无效');
  if (!input.primitives.length) fail('没有可计算的三角网格');
  const bounds = emptyBounds();
  for (const primitive of input.primitives) {
    if (!primitive.positions.length || primitive.positions.length % 3 || !primitive.indices.length || primitive.indices.length % 3 || !primitive.groupId) fail('顶点/索引/来源不完整');
    stats.sourceTriangles += primitive.indices.length / 3;
    if (stats.sourceTriangles > MAX_TRIANGLES) fail('超过 300 万原始三角面预算，未截断模型');
    for (const i of primitive.indices) {
      if (i >= primitive.positions.length / 3) fail('三角形索引越界');
      for (let k = 0; k < 3; k++) { const v = primitive.positions[i * 3 + k]; if (!Number.isFinite(v)) fail('顶点含非有限数值'); bounds[k] = Math.min(bounds[k], v); bounds[k + 3] = Math.max(bounds[k + 3], v); }
    }
    check();
  }
  const origin: ContactPoint = [(bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2];
  const triangles: Triangle[] = [], groups = new Map<string, number[]>(), vertices = new Map<string, number>();
  let maxCoordinate = 0, packingError = 0;
  for (const primitive of input.primitives) {
    const ids = groups.get(primitive.groupId) ?? []; groups.set(primitive.groupId, ids);
    for (let i = 0; i < primitive.indices.length; i += 3) {
      const p: number[] = [], vertexIds: number[] = [], box = emptyBounds();
      for (let j = 0; j < 3; j++) {
        const offset = primitive.indices[i + j] * 3, values = [primitive.positions[offset], primitive.positions[offset + 1], primitive.positions[offset + 2]];
        // Exact equality joins material seams for topology only. No epsilon weld.
        const key = values.join(',');
        if (!vertices.has(key)) vertices.set(key, vertices.size);
        vertexIds.push(vertices.get(key)!);
        for (let k = 0; k < 3; k++) {
          const value = values[k] - origin[k]; p.push(value); box[k] = Math.min(box[k], value); box[k + 3] = Math.max(box[k + 3], value);
          maxCoordinate = Math.max(maxCoordinate, Math.abs(value)); packingError = Math.max(packingError, Math.abs(value - Math.fround(value)));
        }
      }
      const degenerate = norm2(cross(sub(p.slice(3, 6), p.slice(0, 3)), sub(p.slice(6, 9), p.slice(0, 3)))) === 0;
      if (degenerate) stats.degenerateTriangles++;
      ids.push(triangles.length); triangles.push({ p, vertices: vertexIds, bounds: box, group: primitive.groupId, degenerate });
    }
    check();
  }
  if (maxCoordinate > 1_000_000) fail('局部模型跨度超过已核验的浮点范围，未扩大接触阈值');
  stats.sourceGroups = groups.size;
  // Importers may split one closed body into separate nodes, not only material
  // primitives. Join source groups only along an exact, uniquely matched open
  // boundary edge. Already closed bodies remain separate union terms; a triple
  // seam is ambiguous and is never resolved by choosing one of its matches.
  const boundary = new Map<string, string[]>(), groupParents = new Map([...groups.keys()].map(group => [group, group]));
  const groupRoot = (group: string): string => { let root = group; while (groupParents.get(root) !== root) { groupParents.set(root, groupParents.get(groupParents.get(root)!)!); root = groupParents.get(root)!; } return root; };
  for (const [group, ids] of groups) {
    const counts = new Map<string, number>();
    for (const id of ids) for (let k = 0; k < 3; k++) {
      const a = triangles[id].vertices[k], b = triangles[id].vertices[(k + 1) % 3], edge = a < b ? `${a},${b}` : `${b},${a}`;
      counts.set(edge, (counts.get(edge) ?? 0) + 1);
    }
    for (const [edge, count] of counts) if (count === 1) { const sources = boundary.get(edge) ?? []; sources.push(group); boundary.set(edge, sources); }
    check();
  }
  for (const sources of boundary.values()) if (sources.length === 2) groupParents.set(groupRoot(sources[0]), groupRoot(sources[1]));
  const joinedGroups = new Map<string, number[]>();
  for (const [group, ids] of groups) {
    const root = groupRoot(group), joined = joinedGroups.get(root) ?? [];
    for (const id of ids) joined.push(id);
    joinedGroups.set(root, joined);
  }
  const cpuEpsilon = Math.max(1, maxCoordinate) * Number.EPSILON * 128;
  // Bound from actual float packing plus local arithmetic roundoff, never a
  // user-configured thickness or an extrusion of the source geometry.
  const numericalTolerance = 2 * packingError + Math.max(1, maxCoordinate) * 2 ** -22;
  const shells: Shell[] = [];
  options.onProgress?.(`核验 ${stats.sourceTriangles.toLocaleString()} 个原三角面的三维拓扑…`);
  for (const [group, ids] of joinedGroups) {
    const parents = new Map(ids.map(id => [id, id])), edges = new Map<string, { id: number; sign: number }[]>(), faces = new Set<string>();
    const find = (id: number): number => { let p = id; while (parents.get(p) !== p) { parents.set(p, parents.get(parents.get(p)!)!); p = parents.get(p)!; } return p; };
    for (const id of ids) {
      const v = triangles[id].vertices, face = [...v].sort((a, b) => a - b).join(',');
      if (faces.has(face)) stats.duplicateTriangles++; else faces.add(face);
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
        let edge = edges.get(key); if (!edge) { edge = []; edges.set(key, edge); }
        if (edge.length) parents.set(find(id), find(edge[0].id)); edge.push({ id, sign: a < b ? 1 : -1 });
      }
    }
    const parts = new Map<number, number[]>();
    for (const id of ids) { const root = find(id), part = parts.get(root) ?? []; part.push(id); parts.set(root, part); }
    const faults = new Map<number, { open: boolean; manifold: boolean; orientation: boolean }>();
    for (const edge of edges.values()) {
      const root = find(edge[0].id), fault = faults.get(root) ?? { open: false, manifold: false, orientation: false };
      fault.open ||= edge.length === 1; fault.manifold ||= edge.length > 2;
      fault.orientation ||= edge.length === 2 && edge[0].sign === edge[1].sign; faults.set(root, fault);
    }
    for (const [root, part] of parts) {
      const f = faults.get(root)!, tree = makeTree([...part], id => triangles[id].bounds);
      if (f.open) stats.openShells++; if (f.manifold) stats.nonManifoldShells++; if (f.orientation) stats.inconsistentShells++;
      const anchor = triangles[part[0]].p.slice(0, 3);
      let volume = 0;
      for (const id of part) { const p = triangles[id].p; volume += dot(sub(p.slice(0, 3), anchor), cross(sub(p.slice(3, 6), anchor), sub(p.slice(6, 9), anchor))) / 6; }
      const solid = !f.open && !f.manifold && !f.orientation && volume !== 0 && !part.some(id => triangles[id].degenerate);
      shells.push({ ids: part, bounds: tree.bounds, tree, group, solid, volume, parent: -1, depth: 0 });
    }
    check();
  }
  stats.shells = shells.length;
  const crossTrees = (a: Tree, b: Tree, same: boolean): boolean => {
    if (!overlap(a.bounds, b.bounds, cpuEpsilon)) return false;
    if (a.ids && b.ids) {
      for (const ai of a.ids) for (const bi of b.ids) {
        if (ai === bi || (same && a === b && ai >= bi)) continue;
        if (++stats.topologyChecks % 8192 === 0) check();
        if (trianglesCross(triangles[ai], triangles[bi], cpuEpsilon)) return true;
      }
      return false;
    }
    if (a === b) return crossTrees(a.left!, a.left!, true) || crossTrees(a.left!, a.right!, true) || crossTrees(a.right!, a.right!, true);
    if (!a.ids) return crossTrees(a.left!, b, same) || crossTrees(a.right!, b, same);
    return crossTrees(a, b.left!, same) || crossTrees(a, b.right!, same);
  };
  for (const shell of shells) {
    if (shell.solid && crossTrees(shell.tree, shell.tree, true)) { shell.solid = false; stats.selfIntersectingShells++; }
    check();
  }
  // A group can contain many independent bodies. Only opposite-orientation
  // nested boundaries form a cavity. Crossing bodies remain separate OR terms.
  const groupShells = new Map<string, number[]>();
  shells.forEach((s, i) => { if (s.solid) { const ids = groupShells.get(s.group) ?? []; ids.push(i); groupShells.set(s.group, ids); } });
  for (const ids of groupShells.values()) {
    if (ids.length < 2) continue;
    const tree = makeTree([...ids], id => shells[id].bounds, 8);
    for (const id of ids) {
      const shell = shells[id]; let parentVolume = Infinity;
      const visit = (n: Tree) => {
        if (!boundsContain(n.bounds, shell.bounds)) return;
        if (!n.ids) { visit(n.left!); visit(n.right!); return; }
        for (const candidate of n.ids) {
          if (candidate === id) continue;
          const outer = shells[candidate], magnitude = Math.abs(outer.volume);
          if (!(magnitude > Math.abs(shell.volume) && magnitude < parentVolume) || !boundsContain(outer.bounds, shell.bounds)) continue;
          if (++stats.topologyChecks % 8192 === 0) check();
          if (!shellInside(triangles[shell.ids[0]].p.slice(0, 3), outer, triangles)) continue;
          if (crossTrees(outer.tree, shell.tree, false)) continue;
          shell.parent = candidate; parentVolume = magnitude;
        }
      };
      visit(tree); check();
    }
  }
  const entities: Entity[] = [], entityOf = new Map<number, number>();
  const ordered = shells.map((_, i) => i).sort((a, b) => Math.abs(shells[b].volume) - Math.abs(shells[a].volume));
  for (const id of ordered) {
    const shell = shells[id], parent = shell.parent >= 0 ? shells[shell.parent] : undefined;
    if (shell.solid && parent && Math.sign(shell.volume) !== Math.sign(parent.volume)) {
      shell.depth = parent.depth + 1;
      if (shell.depth % 2 === 1) {
        const owner = entityOf.get(shell.parent)!;
        entities[owner].ids.push(...shell.ids); entityOf.set(id, owner); stats.cavityShells++; continue;
      }
    } else if (parent) shell.depth = parent.depth;
    entityOf.set(id, entities.length); entities.push({ ids: [...shell.ids], bounds: shell.bounds, solid: shell.solid });
    if (shell.solid) stats.solidEntities++; else stats.surfaceEntities++;
  }
  if (stats.surfaceEntities) stats.warnings.push(`${stats.surfaceEntities.toLocaleString()} 个非实体分量仅按原始表面接触处理；未补面、封口或推断内部。`);
  if (stats.cavityShells) stats.warnings.push(`保留 ${stats.cavityShells.toLocaleString()} 个反向内壳空腔。`);
  options.onProgress?.(`建立 ${entities.length.toLocaleString()} 个实体/表面分量的三维 BVH…`);
  const packedNodes: number[] = [], packedTriangles: number[] = [], exactTriangles: number[] = [], entityRecords = new Float32Array(entities.length * 4);
  const outward = (value: number, lower: boolean) => {
    const result = Math.fround(value); if (lower ? result <= value : result >= value) return result;
    const f = new Float32Array([result]), bits = new Uint32Array(f.buffer);
    if (result === 0) bits[0] = lower ? 0x80000001 : 1; else bits[0] += (result > 0) === lower ? -1 : 1;
    return f[0];
  };
  const pack = (tree: Tree, kind: 1 | 2, depth: number): number => {
    const index = packedNodes.length / 12, b = tree.bounds; stats.maxDepth = Math.max(stats.maxDepth, depth);
    packedNodes.push(outward(b[0], true), outward(b[1], true), outward(b[2], true), 0, outward(b[3], false), outward(b[4], false), outward(b[5], false), 0, 0, 0, 0, 0);
    if (tree.ids) {
      packedNodes[index * 12 + 7] = tree.ids.length; packedNodes[index * 12 + 9] = kind;
      if (kind === 1) {
        // Entity leaves have exactly one source entity; no extra lookup texture.
        packedNodes[index * 12 + 8] = tree.ids[0];
      } else {
        packedNodes[index * 12 + 8] = packedTriangles.length / 12;
        for (const id of tree.ids) {
          const p = triangles[id].p; packedTriangles.push(p[0], p[1], p[2], 0, p[3], p[4], p[5], 0, p[6], p[7], p[8], 0); exactTriangles.push(...p);
        }
      }
    } else { pack(tree.left!, kind, depth + 1); pack(tree.right!, kind, depth + 1); }
    packedNodes[index * 12 + 3] = packedNodes.length / 12; return index;
  };
  pack(makeTree(entities.map((_, i) => i), id => entities[id].bounds, 1), 1, 1);
  const entityTreeEnd = packedNodes.length / 12;
  entities.forEach((entity, i) => {
    entityRecords[i * 4] = pack(makeTree([...entity.ids], id => triangles[id].bounds), 2, 1);
    entityRecords[i * 4 + 1] = packedNodes.length / 12; entityRecords[i * 4 + 2] = entity.solid ? 1 : 0;
    if (i % 256 === 0) check();
  });
  stats.packedTriangles = packedTriangles.length / 12; stats.bvhNodes = packedNodes.length / 12;
  if (stats.packedTriangles !== stats.sourceTriangles) fail('原三角面计数不守恒；未提交几何');
  if (stats.bvhNodes >= 2 ** 24 || stats.packedTriangles >= 2 ** 24) fail('GPU 整数索引超过精确表示范围');
  stats.milliseconds = performance.now() - started; check();
  return { origin, bounds: bounds.map((v, k) => v - origin[k % 3]) as ContactBounds, nodes: Float32Array.from(packedNodes), triangles: Float32Array.from(packedTriangles),
    entities: entityRecords, trianglePositions: Float64Array.from(exactTriangles), entityTreeEnd, numericalTolerance, stats };
}

/** CPU query uses original double-precision triangles, independently of packed
 * GPU triangle positions. Point is in the caller's unshifted root-model frame. */
export function classifyContactPoint(geometry: ContactGeometry, localPoint: ContactPoint): ContactPointResult {
  if (localPoint.some(v => !Number.isFinite(v))) throw new Error('接触查询坐标无效');
  const p = localPoint.map((v, k) => v - geometry.origin[k]), e = geometry.numericalTolerance, nodes = geometry.nodes;
  const nodeBounds = (i: number): ContactBounds => [nodes[i * 12], nodes[i * 12 + 1], nodes[i * 12 + 2], nodes[i * 12 + 4], nodes[i * 12 + 5], nodes[i * 12 + 6]];
  let top = 0;
  while (top < geometry.entityTreeEnd) {
    const offset = top * 12, escape = nodes[offset + 3];
    if (!pointBounds(p, nodeBounds(top), e)) { top = escape; continue; }
    if (nodes[offset + 7] === 0) { top++; continue; }
    const entityIndex = nodes[offset + 8], meta = entityIndex * 4, solid = geometry.entities[meta + 2] === 1, end = geometry.entities[meta + 1];
    let node = geometry.entities[meta], crossings = 0;
    while (node < end) {
      const o = node * 12, b = nodeBounds(node), contact = pointBounds(p, b, e), ray = solid && p[0] <= b[3] && p[1] >= b[1] && p[1] <= b[4] && p[2] >= b[2] && p[2] <= b[5];
      if (!contact && !ray) { node = nodes[o + 3]; continue; }
      const count = nodes[o + 7]; if (count === 0) { node++; continue; }
      for (let j = 0; j < count; j++) {
        const start = (nodes[o + 8] + j) * 9, triangle = geometry.trianglePositions.subarray(start, start + 9);
        if (contact && contactTriangleDistanceSquared(p, triangle) <= e ** 2) return { clipped: true, mode: 'surface', entityIndex };
        if (ray && rayHit(p, triangle)) crossings++;
      }
      node = nodes[o + 3];
    }
    if (solid && crossings % 2 === 1) return { clipped: true, mode: 'solid', entityIndex };
    top = escape;
  }
  return { clipped: false, mode: 'none' };
}
