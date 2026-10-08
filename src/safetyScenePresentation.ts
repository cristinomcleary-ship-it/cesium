import * as Cesium from "cesium";
import {
  BoundingSphere, Cartesian2, Cartesian3, Cartographic, ConstantProperty,
  LabelCollection, PrimitiveCollection, SceneMode, SceneTransforms,
  type Entity, type Property, type Viewer,
} from "cesium";
import { modelTransformMatches, type RegisteredPhotogrammetry } from "./safetyModelSurfacePicker";
import { installPresentation } from "./presentationV4/install-presentation.js";
import { resolveProjectDisplayConfiguration } from "./presentationV4/projectDisplayConfiguration";
import type { ProjectDisplayConfiguration, PresentationController, PresentationStatus } from "./presentationV4/types";
import type { ImportRecord } from "./types";
import type { SafetyDataset, SafetyState, SafetyView } from "./safetyTypes";

export type SafetyStageRect = { left: number; top: number; width: number; height: number };
export type SafetyPresentationOptions = {
  getImports?: () => readonly ImportRecord[];
  getStageRect?: () => SafetyStageRect;
  getOverviewStageRect?: () => SafetyStageRect;
  getPresentationModels?: () => readonly RegisteredPhotogrammetry[];
  onPresentationStatus?: (messages: string[]) => void;
  onPresentationState?: (status: PresentationStatus) => void;
};
type LabelState = { labels: LabelCollection; show: boolean; individual: Array<{ show: boolean; id: unknown }> };

/** Adapts V5 presentation to the application's existing Viewer and shared clock. */
export class SafetyScenePresentation {
  private controller?: PresentationController;
  private configuration?: ProjectDisplayConfiguration;
  private configurationKey = "";
  private installedModels: Cesium.Cesium3DTileset[] = [];
  private pendingKey = "";
  private pendingGeneration?: number;
  private failedKey = "";
  private generation = 0;
  private pendingHome?: number;
  private state?: SafetyState;
  private view?: SafetyView;
  private dataset?: SafetyDataset;
  private active = false;
  private authoring = false;
  private disposed = false;
  private lastSync = -Infinity;
  private messages: string[] = [];
  private latestStatus: PresentationStatus = { ok: false, state: "waiting-for-project-model", mode: "reality" };
  private focusPosition?: Cartesian3;
  private focusEnabled = false;
  private focusAdded = false;
  private focusGeometryBuilds = 0;
  private effectIds = new Set<string>();
  private worldEffects = new Map<string, { kind: "route" | "selection"; positions: Cartesian3[]; color: string; key: string }>();
  private lastPaused?: boolean;
  private lastReduced?: boolean;
  private readonly labels = new Map<LabelCollection, LabelState>();
  private readonly entityLabels = new Map<Entity, Property | undefined>();
  private readonly cadGeometry = new Map<{ show: boolean; isDestroyed?: (() => boolean) | boolean }, boolean>();
  private readonly cadEntityShows = new Map<Entity, boolean>();

  constructor(private readonly viewer: Viewer, private readonly options: SafetyPresentationOptions,
    _excludedObjects: () => Entity[]) {}

  private models(): RegisteredPhotogrammetry[] {
    return (this.options.getPresentationModels?.() ?? []).filter(model => model.kind === "photogrammetry"
      && model.capabilitySource === "project-verified" && !!model.assetVersion && !!model.coordinateTransformVersion
      && !model.tileset.isDestroyed() && model.tileset.show && modelTransformMatches(model));
  }

  private stageRect(): SafetyStageRect {
    return this.options.getStageRect?.() ?? { left: 0, top: 0,
      width: this.viewer.canvas.clientWidth, height: this.viewer.canvas.clientHeight };
  }

  private report(status: PresentationStatus): void {
    this.latestStatus = status;
    const messages = status.ok ? [] : [status.message ?? "真实模型展示尚未就绪，请保留实景查看。"];
    if (messages.join("|") !== this.messages.join("|")) {
      this.messages = messages; this.options.onPresentationStatus?.([...messages]);
    }
    this.options.onPresentationState?.({ ...status, authoring: this.authoring });
  }

  update(dataset: SafetyDataset, state: SafetyState, view: SafetyView, active: boolean): void {
    if (this.disposed) return;
    if (this.state && (this.state.mode !== state.mode
      || (this.state.selectedId !== state.selectedId && state.selectedId !== dataset.projectId))) this.cancelHome();
    this.dataset = dataset; this.state = state; this.view = view; this.active = active;
    if (!active) { this.restore(); return; }
    this.syncAnnotations(); this.syncInstallation(); this.applyMode();
  }

  private syncInstallation(): void {
    if (!this.dataset || !this.active || this.authoring || this.disposed) return;
    const models = this.models();
    if (!models.length) {
      this.invalidateUnavailableInstallation();
      this.report({ ok: false, state: "waiting-for-project-model", mode: "reality", message: "正在等待已核验项目倾斜摄影。" });
      return;
    }
    // This is a separately calibrated DISPLAY extent, never an area derived from user geometry.
    const configuration = resolveProjectDisplayConfiguration(models, this.dataset, this.options.getOverviewStageRect?.() ?? this.stageRect(), this.viewer);
    if (!configuration) {
      this.invalidateUnavailableInstallation();
      this.report({ ok: false, state: "waiting-for-display-calibration", mode: "reality", message: "项目展示范围和表面高程尚未校准，保留实景查看。" });
      return;
    }
    const key = this.installationKey(models, configuration);
    if (this.controller && this.configurationKey === key && this.installedModels.length === models.length
      && this.installedModels.every((tileset, i) => tileset === models[i].tileset)) { this.configuration = configuration; return; }
    if (this.pendingKey || this.failedKey === key) return;
    this.releaseController();
    this.configuration = configuration;
    const generation = ++this.generation;
    this.pendingKey = key; this.pendingGeneration = generation;
    // Snapshot scalar identities: the registry may mutate a model entry in place.
    const identity = models.map(m => ({ tileset: m.tileset, assetId: m.assetId,
      assetVersion: m.assetVersion, coordinateTransformVersion: m.coordinateTransformVersion }));
    const projectId = this.dataset.projectId;
    const matchingModels = (): RegisteredPhotogrammetry[] | undefined => {
      const current = this.models();
      return this.dataset?.projectId === projectId && current.length === identity.length
        && current.every((m, i) => m.tileset === identity[i].tileset && m.assetId === identity[i].assetId
          && m.assetVersion === identity[i].assetVersion && m.coordinateTransformVersion === identity[i].coordinateTransformVersion)
        ? current : undefined;
    };
    const settlePending = (): void => {
      if (this.pendingGeneration === generation) { this.pendingKey = ""; this.pendingGeneration = undefined; }
    };
    void installPresentation({
      Cesium, viewer: this.viewer,
      tilesets: models.map(model => ({ id: model.assetId, tileset: model.tileset, contentType: "model" as const })),
      displayEnvelope: configuration.displayEnvelope, palette: configuration.palette, home: { ...configuration.home, duration: 0 }, homeOnInstall: false,
      effects: { externalClock: true, paused: true, reducedMotion: false },
      onStatus: status => { if (generation === this.generation && !this.disposed && this.active && matchingModels()) this.report(status); },
    }).then(result => {
      settlePending();
      const current = generation === this.generation && !this.disposed && this.active ? matchingModels() : undefined;
      const currentConfiguration = current && this.dataset
        ? resolveProjectDisplayConfiguration(current, this.dataset, this.options.getOverviewStageRect?.() ?? this.stageRect(), this.viewer) : undefined;
      if (!current || !currentConfiguration || this.installationKey(current, currentConfiguration) !== key) {
        result.controller?.destroy();
        if (generation === this.generation) { this.cancelHome(); this.releaseController(); }
        if (this.active && !this.disposed) this.syncInstallation();
        return;
      }
      if (!result.ok || !result.controller) { this.configuration = undefined; this.failedKey = key; this.report(result.status); return; }
      this.configuration = currentConfiguration;
      this.controller = result.controller; this.configurationKey = key; this.failedKey = "";
      this.installedModels = models.map(model => model.tileset);
      this.applyMode(); this.rebuildFocus();
      for (const id of this.worldEffects.keys()) this.rebuildWorldEffect(id);
      if (this.pendingHome !== undefined) { const duration = this.pendingHome; this.pendingHome = undefined; this.home(duration); }
      this.viewer.scene.requestRender();
    }).catch(error => {
      settlePending();
      if (generation !== this.generation || this.disposed) { if (this.active && !this.disposed) this.syncInstallation(); return; } this.failedKey = key;
      this.report({ ok: false, state: "error", mode: "reality", message: `项目展示接入失败：${error instanceof Error ? error.message : String(error)}` });
    });
  }

  private installationKey(models: readonly RegisteredPhotogrammetry[], configuration: ProjectDisplayConfiguration): string {
    return JSON.stringify({ models: models.map(m => [m.assetId, m.assetVersion, m.coordinateTransformVersion]),
      envelope: configuration.displayEnvelope, palette: configuration.palette });
  }

  private invalidateUnavailableInstallation(): void {
    if (this.controller || this.pendingKey || this.configuration) {
      this.cancelHome(); this.releaseController();
    }
    // Keep pendingKey until its Promise settles: that runtime still owns this Viewer
    // during initialization and must be destroyed before a replacement can install.
    this.failedKey = "";
  }

  private applyMode(): void {
    if (!this.controller) return;
    const next = this.active && !this.authoring && this.state?.mode === "presentation" ? "showcase" : "reality";
    const status = this.controller.getStatus();
    if (status.engineStatus?.mode !== next || !status.ok) this.report(this.controller.setMode(next));
    for (const id of this.effectIds) this.controller.setEffectVisible(id,
      next === "showcase" && !!this.state?.layers.effects && (id !== "selected-pulse" || this.focusEnabled));
  }

  /** Only this explicit operation restores the independently calibrated overview camera. */
  home(duration = 1.6): boolean {
    if (!this.active || this.disposed || this.authoring) return false;
    if (!this.controller || !this.configuration) { this.failedKey = ""; this.pendingHome = duration; this.syncInstallation(); return false; }
    const status = this.controller.home({ ...this.configuration.home, duration });
    this.report(status); return status.ok;
  }

  /** A later theme/object action supersedes an overview waiting for asynchronous model setup. */
  cancelHome(): void { this.pendingHome = undefined; }

  setAuthoring(active: boolean): void {
    if (this.authoring === active) return;
    this.authoring = active;
    if (active) this.cancelHome(); // Starting a task supersedes an unfinished entry camera request.
    // The same owner releases both material and clipping, hides its base/effects and never moves the camera.
    this.applyMode();
    if (!active) this.syncInstallation();
    this.viewer.scene.requestRender();
  }

  setFocus(position: Cartesian3, enabled: boolean): void {
    this.focusEnabled = enabled;
    if (!this.focusPosition || Cartesian3.distanceSquared(this.focusPosition, position) > 0.04) {
      this.focusPosition = Cartesian3.clone(position); this.rebuildFocus();
    }
    this.controller?.setEffectVisible("selected-pulse", enabled && this.active && !this.authoring
      && this.state?.mode === "presentation" && !!this.state.layers.effects);
  }

  private rebuildFocus(): void {
    if (!this.controller || !this.focusPosition || Cartesian3.magnitude(this.focusPosition) < 1e6) return;
    if (this.focusAdded) this.controller.removeEffect("selected-pulse");
    this.controller.addPulseRing({ id: "selected-pulse", anchor: this.focusPosition, radiusMeters: 16, color: "#FFB957", opacity: 0.45 });
    this.focusAdded = true; this.effectIds.add("selected-pulse"); this.focusGeometryBuilds++;
    this.applyMode();
  }

  /** Existing real tracks/selection may opt into the supplied world-space material module. */
  setWorldRoute(id: string, positions: Cartesian3[]): void { this.setWorldEffect(id, "route", positions, "#43D9FF"); }

  setWorldSelection(id: string, positions: Cartesian3[], color = "#43D9FF"): void {
    this.setWorldEffect(id, "selection", positions, color);
  }

  private setWorldEffect(id: string, kind: "route" | "selection", positions: Cartesian3[], color: string): void {
    const key = JSON.stringify([kind, color, positions]);
    if (this.worldEffects.get(id)?.key === key) return;
    this.worldEffects.set(id, { kind, positions: positions.map(p => Cartesian3.clone(p)), color, key });
    this.rebuildWorldEffect(id);
  }

  private rebuildWorldEffect(id: string): void {
    const value = this.worldEffects.get(id);
    if (!this.controller || !value) return;
    if (this.effectIds.has(id)) this.controller.removeEffect(id);
    if (value.kind === "route") this.controller.addFlowRoute({ id, positions: value.positions, widthPx: 2, color: value.color });
    else this.controller.addSelectionOutline({ id, positions: value.positions, color: value.color, widthPx: 3 });
    this.effectIds.add(id); this.applyMode();
  }

  removeWorldEffect(id: string): void { this.controller?.removeEffect(id); this.effectIds.delete(id); this.worldEffects.delete(id); }

  private syncAnnotations(): void {
    const current = new Set<object>();
    for (const record of this.options.getImports?.() ?? []) {
      if (record.kind !== "CAD") continue;
      const collection = record.resource as PrimitiveCollection & { entities?: { values: Entity[] } };
      if (collection instanceof PrimitiveCollection && !collection.isDestroyed()) for (let i = 0; i < collection.length; i++) {
        const child = collection.get(i);
        if (!(child instanceof LabelCollection)) {
          if (child && typeof child.show === "boolean" && !(typeof child.isDestroyed === "function" ? child.isDestroyed() : child.isDestroyed === true)) {
            current.add(child); if (!this.cadGeometry.has(child)) this.cadGeometry.set(child, child.show);
            child.show = false;
          }
          continue;
        }
        if (child.isDestroyed()) continue;
        current.add(child);
        let saved = this.labels.get(child);
        if (!saved) {
          saved = { labels: child, show: child.show, individual: Array.from({ length: child.length }, (_, j) => ({ show: child.get(j).show, id: child.get(j).id })) };
          this.labels.set(child, saved);
        }
        child.show = !!this.state?.engineeringAnnotations && saved.show;
        if (child.show) for (let j = 0; j < child.length; j++) {
          const id = child.get(j).id as { entityIndex?: number } | undefined;
          child.get(j).show = !!saved.individual[j]?.show && record.id === this.view?.selected.sourceRecordId
            && id?.entityIndex === this.view?.selected.sourceEntityIndex;
        }
      }
      for (const entity of collection.entities?.values ?? []) {
        current.add(entity); if (!this.cadEntityShows.has(entity)) this.cadEntityShows.set(entity, entity.show);
        const selected = !!this.state?.engineeringAnnotations && record.id === this.view?.selected.sourceRecordId && Number(entity.id.match(/-(\d+)$/)?.[1]) === this.view?.selected.sourceEntityIndex;
        entity.show = !!this.cadEntityShows.get(entity) && selected;
      }
      for (const entity of collection.entities?.values ?? []) if (entity.label) {
        current.add(entity);
        if (!this.entityLabels.has(entity)) this.entityLabels.set(entity, entity.label.show);
        const index = Number(entity.id.match(/-(\d+)$/)?.[1]);
        entity.label.show = new ConstantProperty(!!this.state?.engineeringAnnotations && record.id === this.view?.selected.sourceRecordId && index === this.view?.selected.sourceEntityIndex);
      }
    }
    for (const [primitive, show] of this.cadGeometry) if (!current.has(primitive)) { if (!(typeof primitive.isDestroyed === "function" ? primitive.isDestroyed() : primitive.isDestroyed === true)) primitive.show = show; this.cadGeometry.delete(primitive); }
    for (const [entity, show] of this.cadEntityShows) if (!current.has(entity)) { entity.show = show; this.cadEntityShows.delete(entity); }
    for (const [labels, state] of this.labels) if (!current.has(labels)) { this.restoreLabels(state); this.labels.delete(labels); }
    for (const [entity, show] of this.entityLabels) if (!current.has(entity)) { if (entity.label) entity.label.show = show; this.entityLabels.delete(entity); }
  }

  private restoreLabels(state: LabelState): void {
    if (state.labels.isDestroyed()) return;
    state.labels.show = state.show;
    for (let i = 0; i < Math.min(state.labels.length, state.individual.length); i++) state.labels.get(i).show = state.individual[i].show;
  }


  samplingExclusions(): object[] { return this.controller?.samplingExclusions() ?? []; }

  isSurfaceReady(): boolean {
    const models = this.models().filter(m => m.tileset.show);
    return models.length > 0 && models.every(m => m.tileset.tilesLoaded);
  }

  readOpaqueDepthPosition(screen: Cartesian2): Cartesian3 | undefined {
    const scene = this.viewer.scene;
    if (!scene.pickPositionSupported) return;
    const previous = scene.pickTranslucentDepth; scene.pickTranslucentDepth = false;
    try { return scene.pickPosition(screen); }
    finally { scene.pickTranslucentDepth = previous; }
  }

  /** Display labels only: opaque depth must belong to a verified model, never our skirt or an overlay. */
  displaySurfaceHeight(location: Cartographic): number | undefined {
    const scene = this.viewer.scene;
    if (scene.mode !== SceneMode.SCENE3D || !scene.pickPositionSupported || !this.isSurfaceReady()) return;
    const models = this.models();
    let height = location.height;
    let found = false;
    for (let i = 0; i < 4; i++) {
      const world = Cartesian3.fromRadians(location.longitude, location.latitude, height);
      const screen = SceneTransforms.worldToWindowCoordinates(scene, world);
      if (!screen || screen.x < 1 || screen.y < 1 || screen.x >= this.viewer.canvas.clientWidth - 1 || screen.y >= this.viewer.canvas.clientHeight - 1) break;
      const hit = scene.pick(screen, 1, 1) as { primitive?: unknown; tileset?: unknown; content?: { tileset?: unknown } } | undefined;
      if (!hit || !models.some(m => hit.primitive === m.tileset || hit.tileset === m.tileset || hit.content?.tileset === m.tileset)) break;
      const depthPosition = this.readOpaqueDepthPosition(screen);
      if (!depthPosition) break;
      const next = Cartographic.fromCartesian(depthPosition).height;
      if (!Number.isFinite(next)) break;
      found = true;
      if (Math.abs(next - height) < 0.2) { height = next; break; }
      height = next;
    }
    return found ? height : undefined;
  }

  private releaseController(): void {
    this.generation++;
    if (this.controller) this.controller.destroy();
    this.controller = undefined; this.configuration = undefined; this.configurationKey = ""; this.installedModels = [];
    this.focusAdded = false; this.effectIds.clear(); this.lastPaused = this.lastReduced = undefined;
  }

  restore(): void {
    this.active = false; this.pendingHome = undefined; this.releaseController(); this.failedKey = "";
    for (const state of this.labels.values()) this.restoreLabels(state);
    this.labels.clear();
    for (const [entity, show] of this.entityLabels) if (entity.label) entity.label.show = show;
    this.entityLabels.clear();
    for (const [primitive, show] of this.cadGeometry) if (!(typeof primitive.isDestroyed === "function" ? primitive.isDestroyed() : primitive.isDestroyed === true)) primitive.show = show;
    this.cadGeometry.clear();
    for (const [entity, show] of this.cadEntityShows) entity.show = show;
    this.cadEntityShows.clear();
  }

  tick(elapsed: number, decorativeTime = 0, animated = false, reducedMotion = false): void {
    if (!this.active || this.disposed) return;
    if (elapsed - this.lastSync > 0.7) {
      this.lastSync = elapsed; this.syncAnnotations(); this.syncInstallation();
    }
    if (!this.controller) return;
    const paused = !animated || this.authoring || document.hidden;
    if (paused !== this.lastPaused) {
      if (paused) this.controller.pauseEffects(); else this.controller.resumeEffects();
      this.lastPaused = paused;
    }
    if (reducedMotion !== this.lastReduced) { this.controller.setReducedMotion(reducedMotion); this.lastReduced = reducedMotion; }
    if (!paused && !reducedMotion) this.controller.setEffectsTime(decorativeTime);
  }

  frame(): { center: Cartesian3; radius: number; heading: number; pitch: number; range: number } | undefined {
    if (!this.configuration || !this.controller || this.controller.getStatus().engineStatus?.mode !== "showcase") return;
    const sphere = BoundingSphere.fromPoints(this.configuration.displayEnvelope.positions);
    const camera = this.configuration.home;
    return { center: camera.target ? new Cartesian3(camera.target.x, camera.target.y, camera.target.z) : sphere.center, radius: sphere.radius,
      heading: Cesium.Math.toRadians(camera.headingDegrees ?? 325), pitch: Cesium.Math.toRadians(camera.pitchDegrees ?? -38),
      range: camera.rangeMeters ?? sphere.radius * (camera.rangeMultiplier ?? 3) };
  }

  getDisplayMode(): 'presentation' | 'inspection' | undefined {
    const status = this.controller?.getStatus();
    if (!status?.ok) return undefined;
    return status.engineStatus?.mode === 'showcase' ? 'presentation' : status.engineStatus?.mode === 'reality' ? 'inspection' : undefined;
  }

  debugStats(): Record<string, unknown> {
    const evidence = this.controller?.getEvidence();
    const engine = evidence?.scene as Record<string, unknown> | undefined;
    const records = (engine?.tilesets ?? []) as Array<{ shaderAttached?: boolean; clippingAttached?: boolean }>;
    const effects = evidence?.effects as Record<string, unknown> | undefined;
    return { authoring: this.authoring, cadGeometryHidden: this.cadGeometry.size, active: this.active,
      styled: engine?.mode === "showcase", shaderCount: records.filter(r => r.shaderAttached).length,
      ownedClipCount: records.filter(r => r.clippingAttached).length, clippingMethod: "ClippingPolygonCollection.inverse",
      basePrimitives: engine?.presentationEntityCount ?? 0, focusGeometryBuilds: this.focusGeometryBuilds,
      dynamicGeometryPerFrame: false, focusPulseVisible: this.focusEnabled && engine?.mode === "showcase" && !this.authoring,
      baseArcVisible: false, cadLabelCollections: this.labels.size, cadEntityLabels: this.entityLabels.size,
      messages: [...this.messages], status: this.latestStatus, installationPending: !!this.pendingKey, pendingHome: this.pendingHome ?? null,
      stage: this.configuration ? { key: this.configuration.displayEnvelope.id, displayOnly: true,
        heightSource: this.configuration.displayEnvelope.heightSource,
        baseDepthMeters: this.configuration.displayEnvelope.baseDepthMeters,
        boundaryVertexCount: this.configuration.displayEnvelope.positions.length,
        headingDegrees: this.configuration.home.headingDegrees, pitchDegrees: this.configuration.home.pitchDegrees } : null,
      v4: evidence, effects, externalClock: true };
  }

  dispose(): void { if (this.disposed) return; this.restore(); this.disposed = true; }
}
