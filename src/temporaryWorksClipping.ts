import { markOwnedFragmentClipping } from './ownedClippingPolygons';
import { releaseBorrowedClippingPolygons } from './borrowedClippingPolygons';
import { PreciseClippingPolygonCollection } from './engineeringComponents/preciseClipping';
import { ContactClippingPolygonCollection } from './modelContactOcclusion/clipping';
import type { ContactVolume } from './modelContactOcclusion/types';
import {
  Cartesian3, ClippingPolygon, ClippingPolygonCollection, Ellipsoid,
  type Cesium3DTileset, type Viewer,
} from 'cesium';
import { ShapeUtils, Vector2 } from 'three';

export type TemporaryWorksClipPoint = { longitude: number; latitude: number; height?: number };
export type TemporaryWorksFootprint = {
  outer: readonly TemporaryWorksClipPoint[];
  /** Courtyards/voids remain visible. They are decomposed, never passed as nested Cesium rings. */
  holes?: readonly (readonly TemporaryWorksClipPoint[])[];
};
export type TemporaryWorksClipInput = {
  id: string;
  tileset: Cesium3DTileset;
  footprints: readonly TemporaryWorksFootprint[];
  visible?: boolean;
  enabled?: boolean;
};
export type TemporaryWorksClipState = 'active' | 'hidden' | 'disabled' | 'blocked' | 'unsupported';
export type TemporaryWorksClipStatus = { state: TemporaryWorksClipState; message: string; polygons: number };
/** A three-dimensional source never enters the legacy footprint union. */
export type ModelContactClipInput = {
  id: string; tileset: Cesium3DTileset; volume: ContactVolume; visible?: boolean; enabled?: boolean;
};
export type ModelContactClippingScope = {
  upsert(input: ModelContactClipInput): TemporaryWorksClipStatus;
  getStatus(id: string): TemporaryWorksClipStatus | undefined;
  setEnabled(enabled: boolean): void;
  remove(id: string): void; clear(): void; dispose(): void;
};
export type ClippingScopeUsage = { contributors: number; boundaryPoints: number; polygons: number; topologyChecks: number };
export type ClippingScopeLimits = Readonly<ClippingScopeUsage>;
export type ClippingValidationPolicy = Readonly<{ minimumAreaSquareMeters?: number }>;
/** Conservative workload stops for new contributors, not a measured GPU capacity or
 * sampling budget. Legacy temporary-work records retain their existing limits. */
export const DEFAULT_SCOPED_CLIPPING_LIMITS: ClippingScopeLimits = Object.freeze({
  contributors: 128, boundaryPoints: 4096, polygons: 1024, topologyChecks: 1_000_000,
});
export type TemporaryWorksClippingScope = {
  upsert(input: TemporaryWorksClipInput): TemporaryWorksClipStatus;
  getStatus(id: string): TemporaryWorksClipStatus | undefined;
  setVisible(id: string, visible: boolean): TemporaryWorksClipStatus | undefined;
  setPlanEnabled(id: string, enabled: boolean): TemporaryWorksClipStatus | undefined;
  setEnabled(enabled: boolean): void;
  remove(id: string): void;
  clear(): void;
  dispose(): void;
  /** All registered contributions count, including hidden/disabled ones. */
  getUsage(): ClippingScopeUsage;
};
type Scope = {
  entries: Map<string, Entry>; enabled: boolean; disposed: boolean; limits: ClippingScopeLimits;
  precise: boolean;
};
type Entry = TemporaryWorksClipInput & {
  polygons: ClippingPolygon[]; status: TemporaryWorksClipStatus;
  scope?: Scope; usage?: ClippingScopeUsage;
  volume?: ContactVolume;
};
type Attachment = { collection: ClippingPolygonCollection; polygons: ClippingPolygon[]; precise: boolean; volumes: ContactVolume[] };
const status = (state: TemporaryWorksClipState, message: string, polygons = 0): TemporaryWorksClipStatus => ({ state, message, polygons });
const emptyUsage = (): ClippingScopeUsage => ({ contributors: 0, boundaryPoints: 0, polygons: 0, topologyChecks: 0 });
const usageKeys = ['contributors', 'boundaryPoints', 'polygons', 'topologyChecks'] as const;
const usageLabels: Record<keyof ClippingScopeUsage, string> = {
  contributors: '方案数量', boundaryPoints: '边界点数', polygons: '裁剪多边形数', topologyChecks: '拓扑校验工作量',
};

/** Linear, allocation-light upper bound before topology checks or triangulation.
 * Repeated closing points conservatively count towards the budget. */
export function estimateClippingScopeContribution(footprints: readonly TemporaryWorksFootprint[]): ClippingScopeUsage {
  const usage = { ...emptyUsage(), contributors: 1 };
  for (const footprint of footprints) {
    let count = footprint.outer.length;
    for (const hole of footprint.holes ?? []) count += hole.length;
    const holes = footprint.holes?.length ?? 0;
    usage.boundaryPoints += count;
    usage.polygons += holes ? Math.max(0, count + 2 * holes - 2) : 1;
    // Includes same-ring intersection, cross-ring intersection and containment work.
    usage.topologyChecks += count * count;
  }
  return usage;
}
function sumScopeUsage(scope: Scope, replacementId?: string, replacement?: ClippingScopeUsage): ClippingScopeUsage {
  const usage = replacement ? { ...replacement } : emptyUsage();
  for (const [id, entry] of scope.entries) {
    if (id === replacementId) continue;
    for (const key of usageKeys) usage[key] += entry.usage![key];
  }
  return usage;
}
function checkScopeBudget(usage: ClippingScopeUsage, limits: ClippingScopeLimits): void {
  for (const key of usageKeys) if (!Number.isSafeInteger(usage[key]) || usage[key] > limits[key])
    throw new Error(`地表编辑${usageLabels[key]}超过上限（${usage[key]}/${limits[key]}），已保留原方案；请缩小范围或减少边界细碎点。`);
}

function ring(points: readonly TemporaryWorksClipPoint[]): TemporaryWorksClipPoint[] {
  const result = points.map(p => ({ longitude: p.longitude, latitude: p.latitude, height: p.height ?? 0 }));
  if (result.some(p => !Number.isFinite(p.longitude) || Math.abs(p.longitude) > 180 || !Number.isFinite(p.latitude) || Math.abs(p.latitude) > 90 || !Number.isFinite(p.height)))
    throw new Error('建筑底面包含无效经纬度，摄影遮挡未更新。');
  if (result.length > 1 && result[0].longitude === result.at(-1)!.longitude && result[0].latitude === result.at(-1)!.latitude) result.pop();
  if (result.length < 3) throw new Error('建筑底面至少需要三个不同的顶点。');
  if (new Set(result.map(p => `${p.longitude},${p.latitude}`)).size !== result.length)
    throw new Error('建筑底面包含重复顶点，请核对轮廓。');
  return result;
}

const cross = (a: Vector2, b: Vector2, c: Vector2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const EPSILON = 1e-8;
function onSegment(a: Vector2, b: Vector2, p: Vector2): boolean {
  return Math.abs(cross(a, b, p)) <= EPSILON && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
    && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}
function intersects(a: Vector2, b: Vector2, c: Vector2, d: Vector2): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function inside(p: Vector2, points: readonly Vector2[]): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
function ringsIntersect(a: readonly Vector2[], b: readonly Vector2[]): boolean {
  return a.some((p, i) => b.some((q, j) => intersects(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}
function minimumArea(policy: ClippingValidationPolicy): number {
  const value = policy.minimumAreaSquareMeters ?? 0.0001;
  if (!Number.isFinite(value) || value < 0) throw new Error('裁剪最小面积必须是有限的非负数。');
  return value;
}
function validateSimple(points: readonly Vector2[], minimumAreaSquareMeters: number): void {
  const area = Math.abs(ShapeUtils.area([...points]));
  if (!Number.isFinite(area) || area <= 0 || area < minimumAreaSquareMeters) throw new Error('建筑底面面积过小或轮廓退化，无法裁剪。');
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
    if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length]))
      throw new Error('建筑底面轮廓自相交，摄影遮挡未更新。');
  }
}

/** Input is world geographic coordinates, including already-applied building scale/heading/anchor.
 * Cesium clips in geocentric angular coordinates; tileset.modelMatrix must NOT be applied here.
 * ClippingPolygon has no hole API. Triangulating polygon-minus-holes preserves its voids.
 */
export function buildTemporaryWorksClipPolygons(
  footprints: readonly TemporaryWorksFootprint[], ellipsoid = Ellipsoid.WGS84,
  policy: ClippingValidationPolicy = {},
): ClippingPolygon[] {
  const minimumAreaSquareMeters = minimumArea(policy);
  if (!footprints.length) throw new Error('缺少经过核验的建筑底面轮廓，无法启用摄影遮挡。');
  const polygons: ClippingPolygon[] = [];
  for (const footprint of footprints) {
    const outer = ring(footprint.outer), holes = (footprint.holes ?? []).map(ring);
    const all = [outer, ...holes], longitude = outer[0].longitude, latitude = outer[0].latitude;
    // Local metric projection is used only for topology checks/triangulation, never as clipping positions.
    const factor = Math.cos(latitude * Math.PI / 180);
    const planar = all.map(points => points.map(p => {
      const dx = p.longitude - longitude, dy = p.latitude - latitude;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(factor) < 0.01)
        throw new Error('临建底面跨度或极区坐标超出局部裁剪范围，请核对模型单位与定位。');
      return new Vector2(dx * 111319.49079327358 * factor, dy * 111319.49079327358);
    }));
    planar.forEach(points => validateSimple(points, minimumAreaSquareMeters));
    for (let i = 1; i < planar.length; i++) {
      if (!inside(planar[i][0], planar[0]) || ringsIntersect(planar[0], planar[i]))
        throw new Error('建筑底面孔洞必须完全位于外轮廓内且不能接触外边界。');
      for (let j = 1; j < i; j++) if (ringsIntersect(planar[i], planar[j]) || inside(planar[i][0], planar[j]) || inside(planar[j][0], planar[i]))
        throw new Error('建筑底面孔洞不能交叠或相互包含。');
    }
    const world = (points: readonly TemporaryWorksClipPoint[]) => points.map(p => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height ?? 0, ellipsoid));
    if (!holes.length) polygons.push(new ClippingPolygon({ positions: world(outer), ellipsoid }));
    else {
      const points = all.flat(), faces = ShapeUtils.triangulateShape(planar[0], planar.slice(1));
      const expectedArea = Math.abs(ShapeUtils.area(planar[0])) - planar.slice(1).reduce((sum, h) => sum + Math.abs(ShapeUtils.area(h)), 0);
      const flat = planar.flat(), actualArea = faces.reduce((sum, [a, b, c]) => sum + Math.abs(cross(flat[a], flat[b], flat[c])) / 2, 0);
      if (!faces.length || Math.abs(actualArea - expectedArea) > Math.max(1e-5, expectedArea * 1e-7))
        throw new Error('建筑底面孔洞剖分未通过面积复核，摄影遮挡未更新。');
      for (const face of faces) polygons.push(new ClippingPolygon({ positions: world(face.map(i => points[i])), ellipsoid }));
    }
  }
  return polygons;
}

/** Owns only collections that this instance attaches. Existing clipping, custom shaders, styles,
 * root transforms, globe and all other tilesets are untouched. A foreign owner is reported, never replaced.
 * Register again with a newly loaded tileset when restoring saved plans after a page/project reload.
 */
export class TemporaryWorksClippingManager {
  private readonly entries = new Map<string, Entry>();
  private readonly scopes = new Map<string, Scope>();
  private readonly attachments = new Map<Cesium3DTileset, Attachment>();
  private readonly blockedRebuilds = new Map<Cesium3DTileset, string>();
  private readonly targetSuspensions = new Map<Cesium3DTileset, Map<object, number>>();
  private readonly suspensions = new Map<object, number>();
  private suspensionEpoch = 0;
  private stopWatching: (() => void) | undefined;
  private enabled = true;
  private disposed = false;
  private readonly viewer: Viewer;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  /** Suspend every known map contributor for AR without changing persisted or
   * user-requested visibility. Unknown clipping owners remain untouched. */
  suspend(owner: object): () => void {
    if (this.disposed) throw new Error('临建摄影遮挡管理器已关闭。');
    const epoch = this.suspensionEpoch;
    this.suspensions.set(owner, (this.suspensions.get(owner) ?? 0) + 1);
    const decrement = () => {
      const count = (this.suspensions.get(owner) ?? 1) - 1;
      if (count) this.suspensions.set(owner, count); else this.suspensions.delete(owner);
    };
    try { this.synchronize(); }
    catch (error) {
      decrement();
      try { this.synchronize(); }
      catch (restoreError) { throw new AggregateError([error, restoreError], '裁剪暂停及恢复均失败，请保留错误详情。', { cause: error }); }
      throw error;
    }
    let released = false;
    return () => { if (released) return; released = true; if (epoch !== this.suspensionEpoch) return; decrement(); this.synchronize(); };
  }

  /** Legacy underground cuts retain their original Cesium polygon semantics
   * (including inputs outside the newer footprint compiler's local bounds).
   * A target lease temporarily withdraws managed contributions without changing
   * their desired switches. Releasing it reconstructs current contributions;
   * it never reattaches a collection destroyed by Cesium or replaces a foreign owner.
   * Separate section/excavation owners may nest on the same photography target. */
  suspendTarget(tileset: Cesium3DTileset, owner: object): () => void {
    if (this.disposed) throw new Error('临建摄影遮挡管理器已关闭。');
    const epoch = this.suspensionEpoch;
    let owners = this.targetSuspensions.get(tileset);
    if (!owners) { owners = new Map(); this.targetSuspensions.set(tileset, owners); }
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    try { this.synchronize(); }
    catch (error) {
      const count = owners.get(owner)! - 1;
      if (count) owners.set(owner, count); else owners.delete(owner);
      if (!owners.size) this.targetSuspensions.delete(tileset);
      try { this.synchronize(); }
      catch (restoreError) { throw new AggregateError([error, restoreError], '裁剪交接及恢复均失败，请保留错误详情。', { cause: error }); }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      if (epoch !== this.suspensionEpoch) return;
      const count = (owners!.get(owner) ?? 1) - 1;
      if (count) owners!.set(owner, count); else owners!.delete(owner);
      if (!owners!.size && this.targetSuspensions.get(tileset) === owners) this.targetSuspensions.delete(tileset);
      this.synchronize();
    };
  }

  /** Model geometry shares the same owner and leases as legacy clipping, but
   * has no two-dimensional footprint that could erase an entire height column. */
  createContactScope(id: string): ModelContactClippingScope {
    if (!id.trim() || this.scopes.has(id)) throw new Error('模型接触遮挡来源为空或已被占用。');
    const scope: Scope = { entries: new Map(), enabled: true, disposed: false,
      limits: DEFAULT_SCOPED_CLIPPING_LIMITS, precise: true };
    this.scopes.set(id, scope);
    const getStatus = (key: string) => {
      const value = scope.entries.get(key)?.status;
      return value && { ...value };
    };
    const clear = () => {
      if (scope.disposed || !scope.entries.size) return;
      const previous = new Map(scope.entries);
      this.changeDesired(() => scope.entries.clear(), () => { scope.entries = previous; }, true);
      this.releaseIdleWatcher();
    };
    return {
      upsert: input => {
        if (scope.disposed || !input.id.trim()) throw new Error('模型接触遮挡来源已释放或缺少编号。');
        const matrix = input.volume?.worldFromLocal;
        if (!matrix || matrix.length !== 16 || !matrix.every(Number.isFinite)
          || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1
          || !input.volume.geometry || input.volume.geometry.stats.sourceTriangles < 1)
          throw new Error('模型接触遮挡缺少有效三维几何或定位。');
        const previous = scope.entries.get(input.id);
        // Freeze the placement snapshot. Geometry is an immutable worker result;
        // a subsequent model pose must submit a new contribution.
        const volume: ContactVolume = Object.freeze({ geometry: input.volume.geometry,
          worldFromLocal: Object.freeze([...matrix]) });
        this.changeDesired(() => {
          scope.entries.set(input.id, { ...input, volume, footprints: [], polygons: [], scope,
            usage: { ...emptyUsage(), contributors: 1 }, status: status('disabled', '三维接触遮挡待更新') });
          this.watch();
        }, () => { if (previous) scope.entries.set(input.id, previous); else scope.entries.delete(input.id); }, true, [input.tileset]);
        return getStatus(input.id)!;
      },
      getStatus,
      setEnabled: enabled => {
        if (scope.disposed || scope.enabled === enabled) return;
        const previous = scope.enabled;
        this.changeDesired(() => { scope.enabled = enabled; }, () => { scope.enabled = previous; }, true);
      },
      remove: key => {
        if (scope.disposed) return;
        const previous = scope.entries.get(key); if (!previous) return;
        this.changeDesired(() => { scope.entries.delete(key); }, () => { scope.entries.set(key, previous); }, true);
        this.releaseIdleWatcher();
      },
      clear,
      dispose: () => {
        if (scope.disposed) return;
        const targets = new Set([...scope.entries.values()].map(entry => entry.tileset));
        try { clear(); }
        catch {
          // Revoking an owner is authoritative. Unlike an ordinary edit, it must
          // not restore a deleted/unauthorized model when the remaining GPU
          // collection cannot be allocated. Withdraw the affected owned object,
          // keep other owners' desired entries, and require an explicit retry.
          scope.entries.clear(); scope.disposed = true; this.scopes.delete(id);
          const errors: unknown[] = [];
          for (const target of targets) {
            const reason = '模型来源已撤销，其余裁剪重建失败，尚未生效；请手动重试。';
            this.blockedRebuilds.set(target, reason);
            const attached = this.attachments.get(target);
            if (attached) {
              try { this.detach(target, attached); }
              catch (error) { errors.push(error); }
            }
            for (const entry of [...this.entries.values(), ...[...this.scopes.values()].flatMap(value => [...value.entries.values()])])
              if (entry.tileset === target) entry.status = status('blocked', reason);
          }
          this.releaseIdleWatcher();
          if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
          if (errors.length) throw new AggregateError(errors, '模型来源已撤销，但部分自有裁剪资源释放失败。');
          return;
        }
        scope.disposed = true; this.scopes.delete(id); this.releaseIdleWatcher();
      },
    };
  }

  /** New modules share the owned Cesium collection without acquiring the legacy
   * temporary-work switch/lifecycle. A scope name has one live owner at a time. */
  createScope(id: string, options: { limits?: Partial<ClippingScopeLimits>; precise?: boolean } & ClippingValidationPolicy = {}): TemporaryWorksClippingScope {
    if (!id.trim()) throw new Error('裁剪来源缺少编号。');
    if (this.scopes.has(id)) throw new Error(`裁剪来源 ${id} 已由其他对象持有。`);
    const limits = Object.freeze({ ...DEFAULT_SCOPED_CLIPPING_LIMITS, ...options.limits });
    for (const key of usageKeys) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1)
      throw new Error(`裁剪工作量 ${key} 上限必须是正整数。`);
    // Existing callers keep the historical minimum. Engineering may preserve
    // source-derived, nonzero thin triangles without changing legacy validation.
    const validation = Object.freeze({ minimumAreaSquareMeters: minimumArea(options) });
    const scope: Scope = { entries: new Map(), enabled: true, disposed: false, limits, precise: options.precise === true };
    this.scopes.set(id, scope);
    const getStatus = (planId: string) => {
      const current = scope.entries.get(planId)?.status;
      return current && { ...current };
    };
    const clear = () => {
      if (scope.disposed) return;
      scope.entries.clear();
      try { this.synchronize(); } finally { this.releaseIdleWatcher(); }
    };
    return {
      upsert: input => {
        if (scope.disposed) throw new Error('裁剪来源已关闭。');
        if (!input.id.trim()) throw new Error('摄影遮挡缺少方案编号。');
        const usage = estimateClippingScopeContribution(input.footprints);
        checkScopeBudget(sumScopeUsage(scope, input.id, usage), limits);
        // Both the estimate and actual result are checked before changing any live entry.
        const polygons = buildTemporaryWorksClipPolygons(input.footprints, input.tileset.ellipsoid ?? Ellipsoid.WGS84, validation);
        usage.polygons = polygons.length;
        checkScopeBudget(sumScopeUsage(scope, input.id, usage), limits);
        const previous = scope.entries.get(input.id);
        this.changeDesired(() => {
          scope.entries.set(input.id, { ...input, polygons, scope, usage, status: status('disabled', '摄影遮挡待更新') });
          this.watch();
        }, () => { if (previous) scope.entries.set(input.id, previous); else scope.entries.delete(input.id); }, scope.precise, [input.tileset]);
        return getStatus(input.id)!;
      },
      getStatus,
      setVisible: (planId, visible) => {
        const entry = scope.entries.get(planId);
        if (entry) {
          const previous = entry.visible;
          this.changeDesired(() => { entry.visible = visible; }, () => { entry.visible = previous; }, scope.precise);
        }
        return getStatus(planId);
      },
      setPlanEnabled: (planId, enabled) => {
        const entry = scope.entries.get(planId);
        if (entry) {
          const previous = entry.enabled;
          this.changeDesired(() => { entry.enabled = enabled; }, () => { entry.enabled = previous; }, scope.precise);
        }
        return getStatus(planId);
      },
      setEnabled: enabled => {
        if (scope.disposed) return;
        const previous = scope.enabled;
        this.changeDesired(() => { scope.enabled = enabled; }, () => { scope.enabled = previous; }, scope.precise);
      },
      remove: planId => {
        if (scope.entries.delete(planId)) this.synchronize();
        this.releaseIdleWatcher();
      },
      clear,
      dispose: () => {
        if (scope.disposed) return;
        scope.disposed = true; scope.entries.clear(); this.scopes.delete(id);
        try { this.synchronize(); } finally { this.releaseIdleWatcher(); }
      },
      getUsage: () => sumScopeUsage(scope),
    };
  }

  private watch(): void {
    this.stopWatching ??= this.viewer.scene.postUpdate?.addEventListener(() => this.synchronize());
  }

  private releaseIdleWatcher(): void {
    if (!this.entries.size && ![...this.scopes.values()].some(scope => scope.entries.size)) {
      this.stopWatching?.(); this.stopWatching = undefined;
    }
  }

  /** Precise collections add a combined geometry/GPU preparation step. A failed
   * proposal must not remain desired and retry on every scene frame. The old
   * non-precise callers keep their historical mutation/synchronization path. */
  private changeDesired(change: () => void, restore: () => void, precise = false, retryTargets: readonly Cesium3DTileset[] = []): void {
    const blockedBefore = new Map(this.blockedRebuilds);
    for (const target of retryTargets) this.blockedRebuilds.delete(target);
    const guarded = precise || [...this.scopes.values()].some(scope => scope.precise && scope.entries.size > 0)
      || [...this.attachments.values()].some(attachment => attachment.precise);
    if (!guarded) { change(); this.synchronize(); return; }
    try { change(); this.synchronize(); }
    catch (error) {
      restore();
      this.blockedRebuilds.clear();
      for (const [target, reason] of blockedBefore) this.blockedRebuilds.set(target, reason);
      try { this.synchronize(); }
      catch (restoreError) { throw new AggregateError([error, restoreError], '精确裁剪更新及恢复均失败，请保留错误详情。', { cause: error }); }
      finally { this.releaseIdleWatcher(); }
      throw error;
    }
  }

  private preparePrecise(polygons: ClippingPolygon[], volumes: ContactVolume[] = []): ClippingPolygonCollection {
    const collection = markOwnedFragmentClipping(volumes.length
      ? new ContactClippingPolygonCollection(polygons, volumes)
      : new PreciseClippingPolygonCollection(polygons));
    try {
      const context = (this.viewer.scene as unknown as { context: { _gl?: object } }).context;
      if (context._gl) collection.prepare(context);
      return collection;
    }
    catch (error) {
      try { collection.destroy(); }
      catch (destroyError) { throw new AggregateError([error, destroyError], '精确裁剪准备及资源清理均失败。', { cause: error }); }
      throw error;
    }
  }

  upsert(input: TemporaryWorksClipInput): TemporaryWorksClipStatus {
    if (this.disposed) throw new Error('临建摄影遮挡管理器已关闭。');
    if (!input.id.trim()) throw new Error('临建摄影遮挡缺少方案编号。');
    // Validate completely before changing the existing record/collection.
    const polygons = buildTemporaryWorksClipPolygons(input.footprints, input.tileset.ellipsoid ?? Ellipsoid.WGS84);
    const previous = this.entries.get(input.id);
    this.changeDesired(() => {
      this.entries.set(input.id, { ...input, polygons, status: status('disabled', '摄影遮挡待更新') });
      this.watch();
    }, () => { if (previous) this.entries.set(input.id, previous); else this.entries.delete(input.id); }, false, [input.tileset]);
    return this.getStatus(input.id)!;
  }

  getStatus(id: string): TemporaryWorksClipStatus | undefined {
    const current = this.entries.get(id)?.status;
    return current && { ...current };
  }

  setVisible(id: string, visible: boolean): TemporaryWorksClipStatus | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      const previous = entry.visible;
      this.changeDesired(() => { entry.visible = visible; }, () => { entry.visible = previous; });
    }
    return this.getStatus(id);
  }

  setPlanEnabled(id: string, enabled: boolean): TemporaryWorksClipStatus | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      const previous = entry.enabled;
      this.changeDesired(() => { entry.enabled = enabled; }, () => { entry.enabled = previous; });
    }
    return this.getStatus(id);
  }

  setEnabled(enabled: boolean): void {
    const previous = this.enabled;
    this.changeDesired(() => { this.enabled = enabled; }, () => { this.enabled = previous; });
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.synchronize();
    this.releaseIdleWatcher();
  }

  clear(): void {
    this.entries.clear();
    try { this.synchronize(); } finally { this.releaseIdleWatcher(); }
  }

  /** May also be called explicitly after layer updates, before requesting a frame. */
  synchronize(): void {
    const groups = new Map<Cesium3DTileset, Entry[]>();
    const add = (entry: Entry) => {
      const group = groups.get(entry.tileset) ?? [];
      group.push(entry); groups.set(entry.tileset, group);
    };
    for (const entry of this.entries.values()) add(entry);
    for (const scope of this.scopes.values()) for (const entry of scope.entries.values()) add(entry);
    for (const target of this.blockedRebuilds.keys()) if (!groups.has(target)) this.blockedRebuilds.delete(target);
    let changed = false;
    for (const [tileset, attached] of this.attachments) {
      if (tileset.isDestroyed() || tileset.clippingPolygons !== attached.collection || attached.collection.isDestroyed()) {
        // Foreign replacement normally already destroys our previous collection through Cesium's setter.
        // If a host detached it without using the setter, release only our abandoned object.
        if (!tileset.isDestroyed() && releaseBorrowedClippingPolygons(tileset, attached.collection) > 0) changed = true;
        if (!attached.collection.isDestroyed()) attached.collection.destroy();
        this.attachments.delete(tileset);
      }
    }
    // Prepare every changed precise target before releasing any current target.
    // This also preserves the old target when migration fails on the new one.
    const prepared = new Map<Cesium3DTileset, ClippingPolygonCollection>();
    try {
      for (const [tileset, entries] of groups) {
        const active = entries.filter(e => (e.scope?.enabled ?? this.enabled) && e.enabled !== false && e.visible !== false);
        if (!active.some(e => e.scope?.precise)) continue;
        const attached = this.attachments.get(tileset);
        if (tileset.isDestroyed() || this.blockedRebuilds.has(tileset) || this.suspensions.size || this.targetSuspensions.has(tileset)
          || (tileset.clippingPlanes && tileset.clippingPlanes.enabled !== false)
          || (tileset.clippingPolygons && tileset.clippingPolygons !== attached?.collection)
          || !ClippingPolygonCollection.isSupported(this.viewer.scene)) continue;
        const polygons = active.flatMap(e => e.polygons);
        const volumes = active.flatMap(e => e.volume ? [e.volume] : []);
        if (!attached || !attached.precise || attached.polygons.length !== polygons.length || attached.polygons.some((p, i) => p !== polygons[i])
          || attached.volumes.length !== volumes.length || attached.volumes.some((v, i) => v !== volumes[i]))
          prepared.set(tileset, this.preparePrecise(polygons, volumes));
      }
    for (const tileset of new Set([...groups.keys(), ...this.attachments.keys()])) {
      const entries = groups.get(tileset) ?? [], active = entries.filter(e => (e.scope?.enabled ?? this.enabled) && e.enabled !== false && e.visible !== false);
      for (const e of entries) {
        if (e.visible === false) e.status = status('hidden', e.scope ? '方案已隐藏，对应摄影遮挡已撤销' : '临建已隐藏，对应摄影遮挡已撤销');
        else if (!(e.scope?.enabled ?? this.enabled) || e.enabled === false) e.status = status('disabled', '摄影遮挡已关闭');
      }
      let blocked: TemporaryWorksClipStatus | undefined;
      const attached = this.attachments.get(tileset);
      if (tileset.isDestroyed()) blocked = status('blocked', '关联摄影模型已卸载，请重新关联');
      else if (this.blockedRebuilds.has(tileset)) blocked = status('blocked', this.blockedRebuilds.get(tileset)!);
      else if (this.suspensions.size) blocked = status('blocked', '当前模式暂时停用地图摄影裁剪，退出后自动恢复');
      else if (this.targetSuspensions.has(tileset)) blocked = status('blocked', '地下工程正在使用该摄影，关闭其剖切或开挖后自动恢复');
      else if ((tileset.clippingPlanes && tileset.clippingPlanes.enabled !== false) || (tileset.clippingPolygons && tileset.clippingPolygons !== attached?.collection))
        blocked = status('blocked', '关联摄影模型正被其他裁剪功能使用，请关闭该功能后重试');
      else if (!ClippingPolygonCollection.isSupported(this.viewer.scene)) blocked = status('unsupported', '当前浏览器或显卡不支持 WebGL 2 多边形裁剪');
      if (!active.length || blocked) {
        if (attached) { this.detach(tileset, attached); changed = true; }
        if (blocked) active.forEach(e => { e.status = { ...blocked! }; });
        continue;
      }
      const polygons = active.flatMap(e => e.polygons);
      const volumes = active.flatMap(e => e.volume ? [e.volume] : []);
      const precise = active.some(e => e.scope?.precise);
      if (!attached || attached.precise !== precise || attached.polygons.length !== polygons.length || attached.polygons.some((p, i) => p !== polygons[i])
        || attached.volumes.length !== volumes.length || attached.volumes.some((v, i) => v !== volumes[i])) {
        const collection = precise ? prepared.get(tileset) ?? this.preparePrecise(polygons, volumes)
          : markOwnedFragmentClipping(new ClippingPolygonCollection({ polygons, inverse: false, enabled: true, quality: 2 }));
        // Setter destroys only our old owned collection. Never expose an empty owned collection mid-frame.
        if (attached) releaseBorrowedClippingPolygons(tileset, attached.collection);
        tileset.clippingPolygons = collection;
        this.attachments.set(tileset, { collection, polygons, precise, volumes });
        prepared.delete(tileset);
        changed = true;
      } else if (!attached.collection.enabled || attached.collection.inverse) {
        // An external mutation of our collection is not silently corrected or allowed to clip outside the buildings.
        this.detach(tileset, attached);
        active.forEach(e => { e.enabled = false; e.status = status('blocked', e.scope ? '裁剪配置被外部修改，已撤销，请重新启用' : '临建裁剪配置被外部修改，已撤销，请重新启用'); });
        changed = true;
        continue;
      }
      active.forEach(e => { e.status = status('active', e.volume ? '已按模型三维实体与原表面接触遮挡摄影'
        : e.scope ? '已按方案范围遮挡关联摄影' : '已按建筑底面遮挡关联摄影', e.polygons.length); });
    }
    if (changed && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    } finally {
      for (const collection of prepared.values()) if (!collection.isDestroyed()) collection.destroy();
    }
  }

  private detach(tileset: Cesium3DTileset, attached: Attachment): void {
    if (!tileset.isDestroyed() && tileset.clippingPolygons === attached.collection && !attached.collection.isDestroyed()) {
      releaseBorrowedClippingPolygons(tileset, attached.collection);
      attached.collection.enabled = false;
      // Undefined is supported by Cesium's runtime setter; upstream d.ts marks the property non-optional.
      (tileset as unknown as { clippingPolygons: ClippingPolygonCollection | undefined }).clippingPolygons = undefined;
    } else if (!attached.collection.isDestroyed()) attached.collection.destroy();
    this.attachments.delete(tileset);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.suspensionEpoch++; this.suspensions.clear(); this.targetSuspensions.clear();
    // Legacy manager disposal still leaves independent scopes alive. Invalidate
    // only its leases; late releases cannot alter a later owner's state.
    try { this.synchronize(); } finally { this.releaseIdleWatcher(); }
  }
}
