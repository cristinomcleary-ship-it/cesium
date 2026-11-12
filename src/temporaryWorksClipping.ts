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
export type ClippingScopeUsage = { contributors: number; boundaryPoints: number; polygons: number; topologyChecks: number };
export type ClippingScopeLimits = Readonly<ClippingScopeUsage>;
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
};
type Entry = TemporaryWorksClipInput & {
  polygons: ClippingPolygon[]; status: TemporaryWorksClipStatus;
  scope?: Scope; usage?: ClippingScopeUsage;
};
type Attachment = { collection: ClippingPolygonCollection; polygons: ClippingPolygon[] };
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
function validateSimple(points: readonly Vector2[]): void {
  if (Math.abs(ShapeUtils.area([...points])) < 0.0001) throw new Error('建筑底面面积过小或轮廓退化，无法裁剪。');
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
): ClippingPolygon[] {
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
    planar.forEach(validateSimple);
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
  private stopWatching: (() => void) | undefined;
  private enabled = true;
  private disposed = false;
  private readonly viewer: Viewer;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  /** New modules share the owned Cesium collection without acquiring the legacy
   * temporary-work switch/lifecycle. A scope name has one live owner at a time. */
  createScope(id: string, options: { limits?: Partial<ClippingScopeLimits> } = {}): TemporaryWorksClippingScope {
    if (!id.trim()) throw new Error('裁剪来源缺少编号。');
    if (this.scopes.has(id)) throw new Error(`裁剪来源 ${id} 已由其他对象持有。`);
    const limits = Object.freeze({ ...DEFAULT_SCOPED_CLIPPING_LIMITS, ...options.limits });
    for (const key of usageKeys) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1)
      throw new Error(`裁剪工作量 ${key} 上限必须是正整数。`);
    const scope: Scope = { entries: new Map(), enabled: true, disposed: false, limits };
    this.scopes.set(id, scope);
    const getStatus = (planId: string) => {
      const current = scope.entries.get(planId)?.status;
      return current && { ...current };
    };
    const clear = () => {
      if (scope.disposed) return;
      scope.entries.clear(); this.synchronize(); this.releaseIdleWatcher();
    };
    return {
      upsert: input => {
        if (scope.disposed) throw new Error('裁剪来源已关闭。');
        if (!input.id.trim()) throw new Error('摄影遮挡缺少方案编号。');
        const usage = estimateClippingScopeContribution(input.footprints);
        checkScopeBudget(sumScopeUsage(scope, input.id, usage), limits);
        // Both the estimate and actual result are checked before changing any live entry.
        const polygons = buildTemporaryWorksClipPolygons(input.footprints, input.tileset.ellipsoid ?? Ellipsoid.WGS84);
        usage.polygons = polygons.length;
        checkScopeBudget(sumScopeUsage(scope, input.id, usage), limits);
        scope.entries.set(input.id, { ...input, polygons, scope, usage, status: status('disabled', '摄影遮挡待更新') });
        this.watch(); this.synchronize(); return getStatus(input.id)!;
      },
      getStatus,
      setVisible: (planId, visible) => {
        const entry = scope.entries.get(planId);
        if (entry) { entry.visible = visible; this.synchronize(); }
        return getStatus(planId);
      },
      setPlanEnabled: (planId, enabled) => {
        const entry = scope.entries.get(planId);
        if (entry) { entry.enabled = enabled; this.synchronize(); }
        return getStatus(planId);
      },
      setEnabled: enabled => {
        if (scope.disposed) return;
        scope.enabled = enabled; this.synchronize();
      },
      remove: planId => {
        if (scope.entries.delete(planId)) this.synchronize();
        this.releaseIdleWatcher();
      },
      clear,
      dispose: () => {
        if (scope.disposed) return;
        clear(); scope.disposed = true; this.scopes.delete(id);
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

  upsert(input: TemporaryWorksClipInput): TemporaryWorksClipStatus {
    if (this.disposed) throw new Error('临建摄影遮挡管理器已关闭。');
    if (!input.id.trim()) throw new Error('临建摄影遮挡缺少方案编号。');
    // Validate completely before changing the existing record/collection.
    const polygons = buildTemporaryWorksClipPolygons(input.footprints, input.tileset.ellipsoid ?? Ellipsoid.WGS84);
    this.entries.set(input.id, { ...input, polygons, status: status('disabled', '摄影遮挡待更新') });
    this.watch();
    this.synchronize();
    return this.getStatus(input.id)!;
  }

  getStatus(id: string): TemporaryWorksClipStatus | undefined {
    const current = this.entries.get(id)?.status;
    return current && { ...current };
  }

  setVisible(id: string, visible: boolean): TemporaryWorksClipStatus | undefined {
    const entry = this.entries.get(id);
    if (entry) { entry.visible = visible; this.synchronize(); }
    return this.getStatus(id);
  }

  setPlanEnabled(id: string, enabled: boolean): TemporaryWorksClipStatus | undefined {
    const entry = this.entries.get(id);
    if (entry) { entry.enabled = enabled; this.synchronize(); }
    return this.getStatus(id);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.synchronize();
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.synchronize();
    this.releaseIdleWatcher();
  }

  clear(): void {
    this.entries.clear();
    this.synchronize();
    this.releaseIdleWatcher();
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
    let changed = false;
    for (const [tileset, attached] of this.attachments) {
      if (tileset.isDestroyed() || tileset.clippingPolygons !== attached.collection || attached.collection.isDestroyed()) {
        // Foreign replacement normally already destroys our previous collection through Cesium's setter.
        // If a host detached it without using the setter, release only our abandoned object.
        if (!attached.collection.isDestroyed()) attached.collection.destroy();
        this.attachments.delete(tileset);
      }
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
      else if ((tileset.clippingPlanes && tileset.clippingPlanes.enabled !== false) || (tileset.clippingPolygons && tileset.clippingPolygons !== attached?.collection))
        blocked = status('blocked', '关联摄影模型正被其他裁剪功能使用，请关闭该功能后重试');
      else if (!ClippingPolygonCollection.isSupported(this.viewer.scene)) blocked = status('unsupported', '当前浏览器或显卡不支持 WebGL 2 多边形裁剪');
      if (!active.length || blocked) {
        if (attached) { this.detach(tileset, attached); changed = true; }
        if (blocked) active.forEach(e => { e.status = { ...blocked! }; });
        continue;
      }
      const polygons = active.flatMap(e => e.polygons);
      if (!attached || attached.polygons.length !== polygons.length || attached.polygons.some((p, i) => p !== polygons[i])) {
        const collection = new ClippingPolygonCollection({ polygons, inverse: false, enabled: true, quality: 2 });
        // Setter destroys only our old owned collection. Never expose an empty owned collection mid-frame.
        tileset.clippingPolygons = collection;
        this.attachments.set(tileset, { collection, polygons });
        changed = true;
      } else if (!attached.collection.enabled || attached.collection.inverse) {
        // An external mutation of our collection is not silently corrected or allowed to clip outside the buildings.
        this.detach(tileset, attached);
        active.forEach(e => { e.enabled = false; e.status = status('blocked', e.scope ? '裁剪配置被外部修改，已撤销，请重新启用' : '临建裁剪配置被外部修改，已撤销，请重新启用'); });
        changed = true;
        continue;
      }
      active.forEach(e => { e.status = status('active', e.scope ? '已按方案范围遮挡关联摄影' : '已按建筑底面遮挡关联摄影', e.polygons.length); });
    }
    if (changed && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  private detach(tileset: Cesium3DTileset, attached: Attachment): void {
    if (!tileset.isDestroyed() && tileset.clippingPolygons === attached.collection && !attached.collection.isDestroyed()) {
      attached.collection.enabled = false;
      // Undefined is supported by Cesium's runtime setter; upstream d.ts marks the property non-optional.
      (tileset as unknown as { clippingPolygons: ClippingPolygonCollection | undefined }).clippingPolygons = undefined;
    } else if (!attached.collection.isDestroyed()) attached.collection.destroy();
    this.attachments.delete(tileset);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }
}
