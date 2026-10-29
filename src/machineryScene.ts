import {
  Cartesian2, Cartesian3, Cartographic, ConstantPositionProperty, ConstantProperty,
  CustomDataSource, EllipsoidTerrainProvider, Entity, HeadingPitchRange, HeadingPitchRoll,
  HeightReference, Math as CesiumMath, ModelGraphics, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Transforms, type Viewer, type CustomShader, BoundingSphere,
} from 'cesium';
import { loadMachineryAsset, resolveMachineryParameters, type LoadedMachineryAsset } from './machinery/index';
import { createMachineryRuntimeGlb, createMachineryRuntimeShader, updateMachineryRuntimeShader } from './machinery/runtimeGeometry';
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
  /** Identifies the verified imported surface without changing station coordinates. */
  modelKind?: 'photogrammetry' | 'model';
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
  /** Display smoothing only. Assessment and stored values always use the exact target. */
  transitionMilliseconds?: number;
  now?: () => number;
  scheduleFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};
type SavedRecord = { id: string; name: string; state: MachineryState };
type RenderedModel = { entity: Entity; url: string; geometryKey: string; asset: LoadedMachineryAsset; shader: CustomShader;
  displayedState: MachineryState; targetState: MachineryState };
type Draft = { recordId: string; state: MachineryState; asset?: LoadedMachineryAsset };
type LoadTask = { generation: number; key: string; promise: Promise<void> };
type Transition = { elapsed: number; lastFrame?: number; from: MachineryState; to: MachineryState };

/** A defensive reader for older resources without machinery metadata. */
export function readMachineryState(value: unknown): MachineryState | undefined {
  try { return validateMachineryMetadata(value); } catch { return; }
}

function geometryKey(state: MachineryState): string {
  return JSON.stringify([state.assetId, state.assetVersion, state.proportional,
    Object.entries(state.parameters).sort(([a], [b]) => a.localeCompare(b))]);
}

const wrapAngle = (angle: number) => ((angle % 360) + 360) % 360;
const interpolateAngle = (from: number, to: number, amount: number) => wrapAngle(from + (((to - from + 540) % 360) - 180) * amount);
/** Interpolates only the visual pose; it never feeds back into telemetry or risk calculations. */
export function interpolateMachineryDisplayState(from: MachineryState, to: MachineryState, amount: number): MachineryState {
  if (amount >= 1) return structuredClone(to);
  const t = Math.max(0, amount), mix = (a: number, b: number) => a + (b - a) * t;
  return { ...to, parameters: Object.fromEntries(Object.entries(to.parameters).map(([key, value]) => [key,
    key === 'boom_rotation_deg' ? interpolateAngle(from.parameters[key], value, t) : mix(from.parameters[key], value)])),
  placement: { longitude: ((interpolateAngle(from.placement.longitude, to.placement.longitude, t) + 180) % 360) - 180,
    latitude: mix(from.placement.latitude, to.placement.latitude), height: mix(from.placement.height, to.placement.height),
    heading: interpolateAngle(from.placement.heading, to.placement.heading, t) } };
}

/** Uses the existing viewer and a persistent GPU mesh. Visual geometry stays in
 * metres; the shader cancels the public model scale used for finite culling bounds. */
export class MachineryScene {
  private readonly source = new CustomDataSource('施工机械');
  private readonly ready: Promise<void>;
  private readonly assets = new Map<MachineryState['assetId'], Promise<LoadedMachineryAsset>>();
  private readonly assetAbort = new AbortController();
  private readonly saved = new Map<string, SavedRecord>();
  /** Volatile sensor poses; never persisted into the equipment resource. */
  private readonly liveStates = new Map<string, MachineryState>();
  private readonly rendered = new Map<string, RenderedModel>();
  private readonly tasks = new Map<string, LoadTask>();
  private readonly generations = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly transitions = new Map<string, Transition>();
  private animationFrame?: number;
  private readonly now: () => number;
  private readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly transitionMilliseconds: number;
  private readonly visibilityChanged = () => { if (typeof document !== 'undefined' && document.hidden) this.finishTransitions(); };
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
    this.now = options.now ?? (() => performance.now());
    this.scheduleFrame = options.scheduleFrame ?? (typeof requestAnimationFrame === 'function' ? callback => requestAnimationFrame(callback) : undefined);
    this.cancelFrame = options.cancelFrame ?? (handle => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle); });
    this.transitionMilliseconds = Math.max(0, Math.min(1000, options.transitionMilliseconds ?? 350));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityChanged);
    this.ready = Promise.resolve(viewer.dataSources.add(this.source)).then(() => {
      if (this.disposed && !viewer.isDestroyed()) viewer.dataSources.remove(this.source, true);
    });
  }

  setContext(context: MachinerySceneContext): void {
    if (this.disposed) return;
    const changed = context.projectId !== this.projectId || context.canView !== this.canView || context.active !== this.enabled;
    if (changed) {
      this.finishTransitions();
      this.cancelPick(); this.draft = undefined; this.liveStates.clear();
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
    for (const [id, live] of this.liveStates) {
      const saved = this.saved.get(id)?.state;
      if (!saved || live.assetId !== saved.assetId || live.assetVersion !== saved.assetVersion) this.liveStates.delete(id);
    }
    this.reconcile();
  }

  /** Replace the current project's authorized sensor poses. Draft > live > saved.
   * Detached, validated states prevent later packet mutation from changing a staged render. */
  setLiveStates(states: ReadonlyMap<string, MachineryState>): void {
    if (this.disposed) return;
    const next = new Map<string, MachineryState>();
    if (this.enabled && this.canView) for (const [id, value] of states) {
      const saved = this.saved.get(id)?.state, state = readMachineryState(value);
      if (saved && state && state.assetId === saved.assetId && state.assetVersion === saved.assetVersion) next.set(id, state);
    }
    if (next.size === this.liveStates.size && [...next].every(([id, state]) => JSON.stringify(state) === JSON.stringify(this.liveStates.get(id)))) return;
    const changed = [...new Set([...next.keys(), ...this.liveStates.keys()])].filter(id => id !== this.draft?.recordId
      && JSON.stringify(next.get(id) ?? this.saved.get(id)?.state) !== JSON.stringify(this.stateFor(id)));
    this.liveStates.clear();
    for (const [id, state] of next) this.liveStates.set(id, state);
    for (const id of changed) this.restore(id);
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
    const state = this.stateFor(recordId);
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
      this.finishTransitions();
      this.liveStates.clear();
      this.cancelPick(); this.clearPreview();
      for (const id of this.tasks.keys()) this.invalidate(id);
    } else this.reconcile();
    this.requestRender();
  }

  getError(recordId: string): string | undefined { return this.errors.get(recordId); }

  /** Stable inspection seam: the immutable GLB is not a snapshot of a sensor packet. */
  getRenderState(recordId: string) {
    const entry = this.rendered.get(recordId);
    return entry ? { runtime: 'persistent-parameter-shader' as const, geometryKey: entry.geometryKey,
      targetState: structuredClone(entry.targetState), displayedState: structuredClone(entry.displayedState),
      interpolating: this.transitions.has(recordId), modelUrl: entry.url } : undefined;
  }

  async flyTo(recordId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || this.disposed || !this.enabled || !this.canView) return false;
    try { await this.tasks.get(recordId)?.promise; } catch { return false; }
    const entry = this.rendered.get(recordId);
    if (signal?.aborted || !entry || !entry.entity.show || this.disposed || !this.enabled || !this.canView) return false;
    const state = this.stateFor(recordId);
    const height = state?.parameters.overall_height_m ?? state?.parameters.total_height_m ?? 1;
    // A lowered boom can be much longer than the model is tall. Include its
    // length and outrigger spans so locating it does not crop a horizontal pose.
    // Leave room for the platform header and editing panels.
    const extent = Math.max(height, state?.parameters.boom_length_m ?? 0,
      state?.parameters.outrigger_lateral_m ?? 0, state?.parameters.outrigger_longitudinal_m ?? 0);
    const range = Math.max(4, extent * 4);
    let cancelFlight: (() => void) | undefined;
    try {
      // Runtime model.scale encloses GPU deformation, so its conservative culling
      // sphere is deliberately larger than the useful camera framing sphere.
      return await new Promise<boolean>(resolve => {
        const finish = (success: boolean) => resolve(success && !signal?.aborted);
        cancelFlight = () => { if (!this.viewer.isDestroyed()) this.viewer.camera?.cancelFlight?.(); finish(false); };
        signal?.addEventListener('abort', cancelFlight, { once: true });
        if (signal?.aborted) { finish(false); return; }
        if (this.viewer.camera?.flyToBoundingSphere && state) {
          const p = state.placement;
          this.viewer.camera.flyToBoundingSphere(new BoundingSphere(
            Cartesian3.fromDegrees(p.longitude, p.latitude, p.height + height / 2), Math.max(1, extent / 2)),
          { duration: 0.8, offset: new HeadingPitchRange(0, -0.45, range), complete: () => finish(true), cancel: () => finish(false) });
        } else void this.viewer.flyTo(entry.entity, { duration: 0.8, offset: new HeadingPitchRange(0, -0.45, range) }).then(finish, () => finish(false));
      });
    } catch { return false; }
    finally { if (cancelFlight) signal?.removeEventListener('abort', cancelFlight); }
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
    this.finishTransitions();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.draft = undefined; this.saved.clear(); this.liveStates.clear(); this.displayVisibility.clear(); this.removeAll(); this.assets.clear();
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
    const record = this.saved.get(recordId);
    if (record && this.enabled && this.canView) this.renderSaved(record);
    else this.remove(recordId);
  }

  private stateFor(recordId: string): MachineryState | undefined {
    return this.draft?.recordId === recordId ? this.draft.state : this.liveStates.get(recordId) ?? this.saved.get(recordId)?.state;
  }

  private renderSaved(record: SavedRecord): void { void this.render(record.id, this.liveStates.get(record.id) ?? record.state).catch(() => {}); }

  private render(recordId: string, state: MachineryState, suppliedAsset?: LoadedMachineryAsset): Promise<void> {
    const key = `${state.assetId}:${state.assetVersion}`, current = this.rendered.get(recordId);
    if (!this.isDisplayed(recordId, state)) {
      this.invalidate(recordId);
      if (current && this.transitions.has(recordId)) this.applyDisplayState(recordId, current, current.targetState);
      this.transitions.delete(recordId); this.syncAnimation();
      if (current) current.entity.show = false;
      this.errors.delete(recordId);
      this.requestRender(); return Promise.resolve();
    }
    if (current?.asset.id === state.assetId && current.asset.version === state.assetVersion) {
      this.invalidate(recordId);
      try { this.setTarget(recordId, current, state); }
      catch (error) {
        const message = error instanceof Error ? error.message : '机械实时姿态无效';
        this.errors.set(recordId, message); this.options.onError?.(recordId, message); return Promise.reject(error);
      }
      this.errors.delete(recordId);
      this.requestRender(); return Promise.resolve();
    }
    // A new asset has a different parameter schema. An old animation must never
    // drive its shader after the asynchronous load attaches the replacement.
    this.transitions.delete(recordId); this.syncAnimation();
    const existing = this.tasks.get(recordId);
    if (existing?.key === key) return existing.promise;
    const generation = this.invalidate(recordId);
    const isCurrent = () => !this.disposed && this.enabled && this.canView && this.generations.get(recordId) === generation;
    const task = (async () => {
      let stagedUrl: string | undefined, stagedShader: CustomShader | undefined;
      try {
        const asset = suppliedAsset ?? await this.loadAsset(state.assetId);
        await this.ready;
        if (!isCurrent()) return;
        if (asset.id !== state.assetId || asset.version !== state.assetVersion) {
          throw new Error('机械模型资产类型或版本不匹配，请重新加载模型');
        }
        const buffer = createMachineryRuntimeGlb(asset);
        if (!isCurrent()) return;
        stagedUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
        // Read the current placement after await: moving a pending preview must not restore stale coordinates.
        const desired = this.stateFor(recordId);
        if (!isCurrent() || !desired || `${desired.assetId}:${desired.assetVersion}` !== key || !this.isDisplayed(recordId, desired)) return;
        resolveMachineryParameters(asset, desired.parameters, {}, { proportional: desired.proportional });
        const previous = this.rendered.get(recordId);
        const entity = previous?.entity ?? this.source.entities.add(new Entity({
          id: `machinery:${recordId}`, name: this.saved.get(recordId)?.name || recordId,
        }));
        stagedShader = createMachineryRuntimeShader(asset);
        entity.model = new ModelGraphics({ uri: stagedUrl, scale: 1, minimumPixelSize: 0, customShader: stagedShader,
          heightReference: HeightReference.NONE, runAnimations: false });
        const rendered: RenderedModel = { entity, url: stagedUrl, geometryKey: geometryKey(desired), asset, shader: stagedShader,
          displayedState: structuredClone(desired), targetState: structuredClone(desired) };
        this.applyDisplayState(recordId, rendered, desired);
        this.rendered.set(recordId, rendered);
        stagedUrl = undefined; stagedShader = undefined;
        if (previous) { previous.shader.destroy(); URL.revokeObjectURL(previous.url); }
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
        stagedShader?.destroy();
        if (this.tasks.get(recordId)?.generation === generation) this.tasks.delete(recordId);
      }
    })();
    this.tasks.set(recordId, { generation, key, promise: task });
    return task;
  }

  private setTarget(recordId: string, entry: RenderedModel, state: MachineryState): void {
    if (geometryKey(state) !== entry.geometryKey) resolveMachineryParameters(entry.asset, state.parameters, {}, { proportional: state.proportional });
    if (JSON.stringify(state) === JSON.stringify(entry.targetState)) {
      if (!this.transitions.has(recordId) && JSON.stringify(state) !== JSON.stringify(entry.displayedState)) this.applyDisplayState(recordId, entry, state);
      entry.entity.show = this.isDisplayed(recordId, state); return;
    }
    entry.geometryKey = geometryKey(state); entry.targetState = structuredClone(state);
    const smooth = entry.entity.show && !!this.scheduleFrame && this.transitionMilliseconds > 0 && this.liveStates.has(recordId)
      && this.draft?.recordId !== recordId && !(typeof document !== 'undefined' && document.hidden);
    if (smooth) this.transitions.set(recordId, { elapsed: 0, from: structuredClone(entry.displayedState), to: structuredClone(state) });
    else { this.transitions.delete(recordId); this.applyDisplayState(recordId, entry, state); }
    this.syncAnimation();
  }

  private applyDisplayState(recordId: string, entry: RenderedModel, state: MachineryState): void {
    entry.displayedState = structuredClone(state);
    const scale = updateMachineryRuntimeShader(entry.shader, entry.asset, state.parameters);
    const scaleProperty = entry.entity.model!.scale;
    if (scaleProperty instanceof ConstantProperty) scaleProperty.setValue(scale);
    else entry.entity.model!.scale = new ConstantProperty(scale);
    this.place(recordId, entry.entity, state);
  }

  private sampleTransition(recordId: string, now: number): void {
    const transition = this.transitions.get(recordId), entry = this.rendered.get(recordId);
    if (!transition || !entry) return;
    // Start when a frame can actually display the pose. Synchronous assessment
    // work after a sensor packet must not consume the whole visual transition.
    // Cap a slow frame to half the duration so at least one intermediate pose is
    // shown; assessment still uses the exact target immediately.
    if (transition.lastFrame !== undefined) {
      transition.elapsed += Math.min(this.transitionMilliseconds / 2, Math.max(0, now - transition.lastFrame));
    }
    transition.lastFrame = now;
    const amount = Math.min(1, transition.elapsed / this.transitionMilliseconds);
    this.applyDisplayState(recordId, entry, interpolateMachineryDisplayState(transition.from, transition.to, amount));
    if (amount === 1) this.transitions.delete(recordId);
  }

  private syncAnimation(): void {
    if (!this.transitions.size || this.disposed || !this.enabled || !this.canView) {
      if (this.animationFrame !== undefined) this.cancelFrame(this.animationFrame);
      this.animationFrame = undefined; return;
    }
    if (this.animationFrame !== undefined || !this.scheduleFrame) return;
    this.animationFrame = this.scheduleFrame(() => {
      this.animationFrame = undefined;
      if (this.disposed || !this.enabled || !this.canView) return;
      for (const id of this.transitions.keys()) this.sampleTransition(id, this.now());
      this.requestRender(); this.syncAnimation();
    });
  }

  private finishTransitions(): void {
    for (const [id] of this.transitions) {
      const entry = this.rendered.get(id);
      if (entry) this.applyDisplayState(id, entry, entry.targetState);
    }
    this.transitions.clear(); this.syncAnimation();
  }

  private place(recordId: string, entity: Entity, state: MachineryState): void {
    const p = state.placement;
    const position = Cartesian3.fromDegrees(p.longitude, p.latitude, p.height);
    if (entity.position instanceof ConstantPositionProperty) entity.position.setValue(position);
    else entity.position = new ConstantPositionProperty(position);
    // Cesium glTF2 correction is Y_UP_TO_Z_UP * Z_UP_TO_X_UP: source +X -> ENU north,
    // +Y -> up, +Z -> east. Positive HPR heading rotates clockwise around local up.
    // The exporter already subtracts the source ground anchor. Apply no second axis/scale correction.
    const orientation = Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(CesiumMath.toRadians(p.heading), 0, 0));
    if (entity.orientation instanceof ConstantProperty) entity.orientation.setValue(orientation);
    else entity.orientation = new ConstantProperty(orientation);
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
    this.transitions.delete(id); this.syncAnimation();
    const entry = this.rendered.get(id);
    if (entry) { this.source.entities.remove(entry.entity); entry.shader.destroy(); URL.revokeObjectURL(entry.url); this.rendered.delete(id); }
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
