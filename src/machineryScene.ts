import {
  Cartesian2, Cartesian3, Cartographic, ConstantPositionProperty, ConstantProperty,
  CustomDataSource, EllipsoidTerrainProvider, Entity, HeadingPitchRange, HeadingPitchRoll,
  HeightReference, Math as CesiumMath, ModelGraphics, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Transforms, type Viewer,
} from 'cesium';
import { createMachineryGlb, loadMachineryAsset, type LoadedMachineryAsset } from './machinery/index';
import type { MachineryMetadata } from './machineryTypes';
import { validateMachineryMetadata } from './machineryValidation';

/** Heading rotates the source +X reference direction: 0° north, 90° east. */
export type MachineryState = MachineryMetadata;
export type MachineryResource = {
  id: string; name: string; revision: number; projectId: string;
  machinery?: unknown; kind?: unknown; category?: unknown;
};
export type MachineryPlacementPick = {
  longitude: number; latitude: number; height: number;
  source: 'model' | 'terrain' | 'ellipsoid';
};
export type MachinerySceneContext = {
  projectId: string;
  records: ReadonlyArray<{ id: string; name?: string; machinery?: unknown; projectId?: string }>;
  canView: boolean;
  active: boolean;
};
export type MachinerySceneOptions = {
  /** Host-owned verified model-surface picker; return undefined to use terrain/ellipsoid. */
  pickPosition?: (position: Cartesian2) => MachineryPlacementPick | undefined;
  /** Current asset/geometry load failure; stale requests never report an error. */
  onError?: (recordId: string, message: string) => void;
};
type SavedRecord = { id: string; name: string; state: MachineryState };
type RenderedModel = { entity: Entity; url: string; geometryKey: string };
type Draft = { recordId: string; state: MachineryState; asset?: LoadedMachineryAsset };
type LoadTask = { generation: number; key: string; promise: Promise<void> };

/** A defensive reader for older resources without machinery metadata. */
export function readMachineryState(value: unknown): MachineryState | undefined {
  try { return validateMachineryMetadata(value); } catch { return; }
}

function geometryKey(state: MachineryState): string {
  return JSON.stringify([state.assetId, state.assetVersion, state.proportional,
    Object.entries(state.parameters).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Uses the existing viewer; model vertices and entity scale are always in metres. */
export class MachineryScene {
  private readonly source = new CustomDataSource('施工机械');
  private readonly ready: Promise<void>;
  private readonly assets = new Map<MachineryState['assetId'], Promise<LoadedMachineryAsset>>();
  private readonly assetAbort = new AbortController();
  private readonly saved = new Map<string, SavedRecord>();
  private readonly rendered = new Map<string, RenderedModel>();
  private readonly tasks = new Map<string, LoadTask>();
  private readonly generations = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  /** Presentation-only overrides; never written into resource machinery metadata. */
  private readonly displayVisibility = new Map<string, boolean>();
  private draft?: Draft;
  private projectId = '';
  private canView = true;
  private enabled = true;
  private disposed = false;
  private pickHandler?: ScreenSpaceEventHandler;
  private pickEvents?: AbortController;
  private pickCancel?: () => void;
  private previousCursor?: string;

  constructor(private readonly viewer: Viewer, private readonly options: MachinerySceneOptions = {}) {
    this.ready = Promise.resolve(viewer.dataSources.add(this.source)).then(() => {
      if (this.disposed && !viewer.isDestroyed()) viewer.dataSources.remove(this.source, true);
    });
  }

  setContext(context: MachinerySceneContext): void {
    if (this.disposed) return;
    const changed = context.projectId !== this.projectId || context.canView !== this.canView || context.active !== this.enabled;
    if (changed) {
      this.cancelPick(); this.draft = undefined;
      // Invalidate all staged models before publishing the new project or permission.
      for (const id of this.tasks.keys()) this.invalidate(id);
    }
    if (context.projectId !== this.projectId) { this.displayVisibility.clear(); this.removeAll(); }
    this.projectId = context.projectId; this.canView = context.canView; this.enabled = context.active;
    this.source.show = this.canView && this.enabled;
    this.sync(context.records.filter(record => !record.projectId || record.projectId === context.projectId));
  }

  sync(records: MachinerySceneContext['records']): void {
    if (this.disposed) return;
    this.saved.clear();
    for (const record of records) {
      if (!record.id || (this.projectId && record.projectId && record.projectId !== this.projectId)) continue;
      const state = readMachineryState(record.machinery);
      if (state) this.saved.set(record.id, { id: record.id, name: record.name || record.id, state });
    }
    this.reconcile();
  }

  /** Replace temporary display choices. Explicit true also reveals saved visible=false models. */
  setDisplayVisibility(overrides: Record<string, boolean>): void {
    if (this.disposed) return;
    const next = new Map(Object.entries(overrides).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
    if (next.size === this.displayVisibility.size && [...next].every(([id, visible]) => this.displayVisibility.get(id) === visible)) return;
    this.displayVisibility.clear();
    for (const [id, visible] of next) this.displayVisibility.set(id, visible);
    this.reconcile();
  }

  getDisplayVisibility(recordId: string): boolean {
    const state = this.draft?.recordId === recordId ? this.draft.state : this.saved.get(recordId)?.state;
    return state ? this.isDisplayed(recordId, state) : false;
  }

  private isDisplayed(recordId: string, state: MachineryState): boolean {
    return this.displayVisibility.get(recordId) ?? state.visible;
  }

  async preview(recordId: string, value: MachineryState, asset?: LoadedMachineryAsset): Promise<void> {
    if (this.disposed || !this.canView || !this.enabled) return;
    const state = readMachineryState(value);
    if (!recordId || !state) throw new Error('机械参数或放置坐标无效');
    const previousId = this.draft?.recordId;
    this.draft = { recordId, state, asset };
    if (previousId && previousId !== recordId) this.restore(previousId);
    await this.render(recordId, state, asset);
  }

  clearPreview(): void {
    if (this.disposed || !this.draft) return;
    const id = this.draft.recordId; this.draft = undefined;
    this.restore(id);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled; this.source.show = enabled && this.canView;
    if (!enabled) {
      this.cancelPick(); this.clearPreview();
      for (const id of this.tasks.keys()) this.invalidate(id);
    } else this.reconcile();
    this.requestRender();
  }

  getError(recordId: string): string | undefined { return this.errors.get(recordId); }

  async flyTo(recordId: string): Promise<boolean> {
    if (this.disposed || !this.enabled || !this.canView) return false;
    try { await this.tasks.get(recordId)?.promise; } catch { return false; }
    const entry = this.rendered.get(recordId);
    if (!entry || !entry.entity.show || this.disposed || !this.enabled || !this.canView) return false;
    const state = this.draft?.recordId === recordId ? this.draft.state : this.saved.get(recordId)?.state;
    const height = state?.parameters.overall_height_m ?? state?.parameters.total_height_m ?? 1;
    // A lowered boom can be much longer than the model is tall. Include its
    // length and outrigger spans so locating it does not crop a horizontal pose.
    // Leave room for the platform header and editing panels.
    const extent = Math.max(height, state?.parameters.boom_length_m ?? 0,
      state?.parameters.outrigger_lateral_m ?? 0, state?.parameters.outrigger_longitudinal_m ?? 0);
    const range = Math.max(4, extent * 4);
    try { return await this.viewer.flyTo(entry.entity, { duration: 0.8, offset: new HeadingPitchRange(0, -0.45, range) }); }
    catch { return false; }
  }

  /** Try a host-verified model surface, then terrain/ellipsoid without overlay depth. */
  beginPick(onPick: (placement: MachineryPlacementPick) => void, onCancel?: () => void): () => void {
    this.cancelPick();
    if (this.disposed || !this.enabled || !this.canView) return () => {};
    const handler = new ScreenSpaceEventHandler(this.viewer.canvas);
    const events = new AbortController();
    this.pickHandler = handler; this.pickEvents = events; this.pickCancel = onCancel;
    this.previousCursor = this.viewer.canvas.style.cursor;
    this.viewer.canvas.style.cursor = 'crosshair';
    let down: Cartesian2 | undefined;
    let moved = false;
    handler.setInputAction((event: { position: Cartesian2 }) => {
      down = Cartesian2.clone(event.position); moved = false;
    }, ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (down && Cartesian2.distance(down, event.endPosition) > 6) moved = true;
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((event: { position: Cartesian2 }) => {
      if (moved || (down && Cartesian2.distance(down, event.position) > 6)) { down = undefined; return; }
      down = undefined;
      const placement = this.pickGround(event.position);
      if (!placement || this.pickHandler !== handler) return;
      this.finishPick(false); onPick(placement);
    }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => this.cancelPick(), ScreenSpaceEventType.RIGHT_CLICK);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.pickHandler === handler) { event.preventDefault(); this.cancelPick(); }
    }, { signal: events.signal });
    window.addEventListener('blur', () => this.cancelPick(), { signal: events.signal });
    return () => { if (this.pickHandler === handler) this.cancelPick(); };
  }

  cancelPick(): void { this.finishPick(true); }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancelPick(); this.assetAbort.abort();
    this.draft = undefined; this.saved.clear(); this.displayVisibility.clear(); this.removeAll(); this.assets.clear();
    if (!this.viewer.isDestroyed()) this.viewer.dataSources.remove(this.source, true);
  }

  private reconcile(): void {
    const wanted = new Set(this.saved.keys());
    if (this.draft) wanted.add(this.draft.recordId);
    for (const id of new Set([...this.rendered.keys(), ...this.tasks.keys()])) if (!wanted.has(id)) this.remove(id);
    if (!this.enabled || !this.canView) { this.requestRender(); return; }
    for (const record of this.saved.values()) if (record.id !== this.draft?.recordId) this.renderSaved(record);
    if (this.draft) void this.render(this.draft.recordId, this.draft.state, this.draft.asset).catch(() => {});
    this.requestRender();
  }

  private restore(recordId: string): void {
    this.invalidate(recordId);
    const record = this.saved.get(recordId);
    if (record && this.enabled && this.canView) this.renderSaved(record);
    else this.remove(recordId);
  }

  private renderSaved(record: SavedRecord): void { void this.render(record.id, record.state).catch(() => {}); }

  private render(recordId: string, state: MachineryState, suppliedAsset?: LoadedMachineryAsset): Promise<void> {
    const key = geometryKey(state), current = this.rendered.get(recordId);
    if (!this.isDisplayed(recordId, state)) {
      this.invalidate(recordId);
      if (current) current.entity.show = false;
      this.errors.delete(recordId);
      this.requestRender(); return Promise.resolve();
    }
    if (current?.geometryKey === key) {
      this.invalidate(recordId); this.place(recordId, current.entity, state);
      this.errors.delete(recordId);
      this.requestRender(); return Promise.resolve();
    }
    const existing = this.tasks.get(recordId);
    if (existing?.key === key) return existing.promise;
    const generation = this.invalidate(recordId);
    const isCurrent = () => !this.disposed && this.enabled && this.canView && this.generations.get(recordId) === generation;
    const task = (async () => {
      let stagedUrl: string | undefined;
      try {
        const asset = suppliedAsset ?? await this.loadAsset(state.assetId);
        await this.ready;
        if (!isCurrent()) return;
        if (asset.id !== state.assetId || asset.version !== state.assetVersion) {
          throw new Error('机械模型资产类型或版本不匹配，请重新加载模型');
        }
        const buffer = createMachineryGlb(asset, state.parameters, { proportional: state.proportional });
        if (!isCurrent()) return;
        stagedUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
        // Read the current placement after await: moving a pending preview must not restore stale coordinates.
        const desired = this.draft?.recordId === recordId ? this.draft.state : this.saved.get(recordId)?.state;
        if (!isCurrent() || !desired || geometryKey(desired) !== key || !this.isDisplayed(recordId, desired)) return;
        const previous = this.rendered.get(recordId);
        const entity = previous?.entity ?? this.source.entities.add(new Entity({
          id: `machinery:${recordId}`, name: this.saved.get(recordId)?.name || recordId,
        }));
        entity.model = new ModelGraphics({ uri: stagedUrl, scale: 1, minimumPixelSize: 0,
          heightReference: HeightReference.NONE, runAnimations: false });
        this.place(recordId, entity, desired);
        this.rendered.set(recordId, { entity, url: stagedUrl, geometryKey: key });
        stagedUrl = undefined;
        if (previous) URL.revokeObjectURL(previous.url);
        this.errors.delete(recordId); this.requestRender();
      } catch (error) {
        if (isCurrent()) {
          const message = error instanceof Error ? error.message : '机械模型加载失败';
          this.errors.set(recordId, message);
          try { this.options.onError?.(recordId, message); } catch { /* Keep the original model failure. */ }
          throw error;
        }
      } finally {
        if (stagedUrl) URL.revokeObjectURL(stagedUrl);
        if (this.tasks.get(recordId)?.generation === generation) this.tasks.delete(recordId);
      }
    })();
    this.tasks.set(recordId, { generation, key, promise: task });
    return task;
  }

  private place(recordId: string, entity: Entity, state: MachineryState): void {
    const p = state.placement;
    const position = Cartesian3.fromDegrees(p.longitude, p.latitude, p.height);
    entity.position = new ConstantPositionProperty(position);
    // Cesium glTF2 correction is Y_UP_TO_Z_UP * Z_UP_TO_X_UP: source +X -> ENU north,
    // +Y -> up, +Z -> east. Positive HPR heading rotates clockwise around local up.
    // The exporter already subtracts the source ground anchor. Apply no second axis/scale correction.
    entity.orientation = new ConstantProperty(Transforms.headingPitchRollQuaternion(position,
      new HeadingPitchRoll(CesiumMath.toRadians(p.heading), 0, 0)));
    entity.show = this.isDisplayed(recordId, state);
  }

  private loadAsset(id: MachineryState['assetId']): Promise<LoadedMachineryAsset> {
    const cached = this.assets.get(id);
    if (cached) return cached;
    const promise: Promise<LoadedMachineryAsset> = loadMachineryAsset(id, { signal: this.assetAbort.signal });
    this.assets.set(id, promise);
    void promise.catch(() => { if (this.assets.get(id) === promise) this.assets.delete(id); });
    return promise;
  }

  private invalidate(id: string): number {
    const next = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, next); this.tasks.delete(id); return next;
  }

  private remove(id: string): void {
    this.invalidate(id);
    const entry = this.rendered.get(id);
    if (entry) { this.source.entities.remove(entry.entity); URL.revokeObjectURL(entry.url); this.rendered.delete(id); }
    this.errors.delete(id);
  }

  private removeAll(): void {
    for (const id of new Set([...this.rendered.keys(), ...this.tasks.keys()])) this.remove(id);
    this.source.entities.removeAll(); this.requestRender();
  }

  private requestRender(): void { if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender(); }

  private finishPick(cancelled: boolean): void {
    const handler = this.pickHandler, callback = this.pickCancel;
    this.pickHandler = undefined; this.pickCancel = undefined;
    this.pickEvents?.abort(); this.pickEvents = undefined;
    if (handler && !handler.isDestroyed()) handler.destroy();
    if (this.previousCursor !== undefined) {
      if (this.viewer.canvas.style.cursor === 'crosshair') this.viewer.canvas.style.cursor = this.previousCursor;
      this.previousCursor = undefined;
    }
    if (cancelled && handler) callback?.();
  }

  private pickGround(screen: Cartesian2): MachineryPlacementPick | undefined {
    if (this.disposed || !this.enabled || !this.canView) return;
    try {
      const model = this.options.pickPosition?.(screen);
      if (model && [model.longitude, model.latitude, model.height].every(Number.isFinite)
        && Math.abs(model.longitude) <= 180 && Math.abs(model.latitude) <= 90
        && ['model', 'terrain', 'ellipsoid'].includes(model.source)) return { ...model };
    } catch { /* A missing model depth result still permits an explicitly labelled ground pick. */ }
    const { scene, camera } = this.viewer;
    const ellipsoid = scene.globe?.ellipsoid;
    let world: Cartesian3 | undefined;
    let source: MachineryPlacementPick['source'] = 'ellipsoid';
    const ray = camera.getPickRay(screen);
    if (ray && scene.globe?.show) {
      world = scene.globe.pick(ray, scene);
      if (world && !(scene.terrainProvider instanceof EllipsoidTerrainProvider)) source = 'terrain';
    }
    if (!world) world = camera.pickEllipsoid(screen, ellipsoid);
    if (!world || ![world.x, world.y, world.z].every(Number.isFinite)) return;
    const cartographic = Cartographic.fromCartesian(world, ellipsoid);
    if (!cartographic || ![cartographic.longitude, cartographic.latitude, cartographic.height].every(Number.isFinite)) return;
    return { longitude: CesiumMath.toDegrees(cartographic.longitude), latitude: CesiumMath.toDegrees(cartographic.latitude),
      height: cartographic.height, source };
  }
}
