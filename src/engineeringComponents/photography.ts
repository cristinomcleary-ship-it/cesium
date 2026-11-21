import type { Cesium3DTileset, Viewer } from 'cesium';
import { getTemporaryWorksClippingManager } from '../temporaryWorksGlbScene';
import {
  buildTemporaryWorksClipPolygons, estimateClippingScopeContribution,
  type ClippingScopeLimits, type ClippingScopeUsage, type TemporaryWorksClipInput,
  type TemporaryWorksClipStatus, type TemporaryWorksClippingScope, type TemporaryWorksFootprint,
} from '../temporaryWorksClipping';

/** Engineering-only stops; the shared manager's legacy/surface limits stay unchanged.
 * The complete source-package footprint measurement and real GPU acceptance must
 * remain below these stops. The verified full line uses 25,254 boundary points,
 * 8,418 polygons and 75,762 topology checks. More fragmented selections can
 * exceed it; rejection preserves the previous result instead of truncating. */
export const ENGINEERING_PHOTOGRAPHY_LIMITS: ClippingScopeLimits = Object.freeze({
  contributors: 1, boundaryPoints: 65_536, polygons: 32_768, topologyChecks: 1_000_000,
});

export type EngineeringPhotographyTarget = { id: string; tileset: Cesium3DTileset };
export type EngineeringPhotographyStatus = { state: string; message: string; polygons: number };
type Options = { onStatus?: (status: EngineeringPhotographyStatus) => void };
const contributionId = 'active-engineering-model';
const inactive = (): EngineeringPhotographyStatus => ({ state: 'disabled', message: '工程摄影遮挡未启用。', polygons: 0 });

function checkBudget(usage: ClippingScopeUsage) {
  for (const key of Object.keys(ENGINEERING_PHOTOGRAPHY_LIMITS) as (keyof ClippingScopeLimits)[]) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] > ENGINEERING_PHOTOGRAPHY_LIMITS[key]) {
      throw new Error(`工程摄影遮挡工作量 ${key} 超过上限（${usage[key]}/${ENGINEERING_PHOTOGRAPHY_LIMITS[key]}），原有效遮挡已保留。`);
    }
  }
}

function copyFootprints(input: readonly TemporaryWorksFootprint[]): readonly TemporaryWorksFootprint[] {
  const ring = (points: TemporaryWorksFootprint['outer']) => Object.freeze(points.map(point => Object.freeze({
    longitude: point.longitude, latitude: point.latitude, height: point.height,
  })));
  return Object.freeze(input.map(value => Object.freeze({ outer: ring(value.outer),
    holes: value.holes ? Object.freeze(value.holes.map(ring)) : undefined })));
}

/** Owns one independent contribution beside temporary works and surface editing.
 * Component visibility and Model.show are deliberately absent: the host supplies
 * the exact union of enabled occluders, including hidden engineering components.
 * A valid update blocked by another scene mode remains pending and resumes when
 * the shared manager releases that mode. Its status never reports it as active. */
export class EngineeringPhotographyOcclusion {
  private readonly scope: TemporaryWorksClippingScope;
  private current?: TemporaryWorksClipInput;
  private targetId?: string;
  private suspended = false;
  private disposed = false;
  private stopWatching?: () => void;
  private lastStatus: EngineeringPhotographyStatus = inactive();

  constructor(private readonly viewer: Viewer, private readonly options: Options = {}) {
    this.scope = getTemporaryWorksClippingManager(viewer).createScope(`engineering-components:${crypto.randomUUID()}`,
      { limits: ENGINEERING_PHOTOGRAPHY_LIMITS, minimumAreaSquareMeters: 0, precise: true });
  }

  get status(): EngineeringPhotographyStatus { return { ...this.lastStatus }; }
  getUsage(): ClippingScopeUsage { return this.scope.getUsage(); }

  apply(target: EngineeringPhotographyTarget, footprints: readonly TemporaryWorksFootprint[]): void {
    this.assertAlive();
    if (!target.id.trim() || target.tileset.isDestroyed()) throw new Error('关联倾斜摄影无效或已卸载，原有效遮挡已保留。');
    checkBudget(estimateClippingScopeContribution(footprints));
    const stable = copyFootprints(footprints);
    // Validate before the mutating upsert. The manager compiles again when it
    // adopts its entry; keeping that boundary avoids altering any shared owner.
    const polygons = buildTemporaryWorksClipPolygons(stable, target.tileset.ellipsoid, { minimumAreaSquareMeters: 0 });
    checkBudget({ ...estimateClippingScopeContribution(stable), polygons: polygons.length });
    const previous = this.current, previousId = this.targetId;
    const next: TemporaryWorksClipInput = { id: contributionId, tileset: target.tileset,
      footprints: stable, visible: true, enabled: true };
    try {
      this.scope.upsert(next);
      this.current = next; this.targetId = target.id;
    } catch (error) {
      // synchronize() can throw after an entry changed (e.g. a Cesium setter or
      // requestRender failure). Restore desired input, never assign a foreign
      // tileset collection. The shared manager owns all attachment decisions.
      try {
        if (previous) this.scope.upsert(previous); else this.scope.remove(contributionId);
        this.current = previous; this.targetId = previousId;
      } catch (restoreError) {
        this.current = previous; this.targetId = previousId;
        this.reflectStatus();
        throw new AggregateError([error, restoreError], '工程摄影遮挡更新及恢复均失败，请保留错误详情。', { cause: error });
      }
      this.reflectStatus();
      throw error;
    }
    // Register after the manager's own watcher so each reported state reflects
    // the same frame's AR/section/foreign-owner checks. No extra per-frame scan.
    this.stopWatching ??= this.viewer.scene.postUpdate.addEventListener(() => this.reflectStatus());
    this.reflectStatus();
  }

  clear(): void {
    if (this.disposed) return;
    try { this.scope.clear(); }
    finally {
      this.current = undefined; this.targetId = undefined;
      this.stopWatching?.(); this.stopWatching = undefined; this.publish(inactive());
    }
  }

  setSuspended(value: boolean): void {
    if (this.disposed || this.suspended === value) return;
    const previous = this.suspended;
    try { this.scope.setEnabled(!value); this.suspended = value; }
    catch (error) {
      try { this.scope.setEnabled(!previous); }
      catch (restoreError) { throw new AggregateError([error, restoreError], '工程摄影遮挡暂停及恢复均失败。', { cause: error }); }
      throw error;
    }
    this.reflectStatus();
  }

  private reflectStatus(): void {
    if (this.disposed) return;
    if (!this.current) { this.publish(inactive()); return; }
    const actual: TemporaryWorksClipStatus | undefined = this.scope.getStatus(contributionId);
    if (!actual) { this.publish({ state: 'blocked', message: '工程摄影遮挡贡献已失效，请重新应用。', polygons: 0 }); return; }
    if (this.suspended) {
      this.publish({ state: 'suspended', message: '工程摄影遮挡暂时停用，退出当前模式后恢复。', polygons: 0 }); return;
    }
    this.publish(actual.state === 'active'
      ? { ...actual, message: `已按工程构件真实投影遮挡关联摄影（${this.targetId}）。` }
      : actual);
  }

  private publish(value: EngineeringPhotographyStatus): void {
    if (this.lastStatus.state === value.state && this.lastStatus.message === value.message && this.lastStatus.polygons === value.polygons) return;
    this.lastStatus = { ...value };
    // A view callback must never turn a completed render transaction into a
    // geometry failure or prevent later manager observers from running.
    try { this.options.onStatus?.({ ...value }); }
    catch (error) { console.warn('[Engineering photography] Status observer failed', error); }
  }

  private assertAlive(): void {
    if (this.disposed || this.viewer.isDestroyed()) throw new Error('工程摄影遮挡已关闭。');
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopWatching?.(); this.stopWatching = undefined;
    try { this.scope.dispose(); }
    finally {
      this.current = undefined; this.targetId = undefined; this.disposed = true;
      this.publish({ state: 'disposed', message: '工程摄影遮挡已释放。', polygons: 0 });
    }
  }
}
