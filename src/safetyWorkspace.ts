import type { ManagementSceneContext, ManagementSceneHost } from "./managementSceneTypes";
import { SafetyVideoRoam, type SafetyVideoRoamState } from "./safetyVideoRoam";
import { SafetyModelOptimization } from "./safetyModelOptimization";
import { Cartographic, Cesium3DTileset, Math as CesiumMath, Matrix4, type Viewer } from "cesium";
import { SafetySpatialEditor } from "./safetySpatialEditor";
import { mergeSpatialDataset, spatialReplayTimeAt } from "./safetySpatialData";
import type { SpatialSnapshot, ModelRegistryEntry } from "./safetySpatialTypes";
import { SafetySpatialRepository } from "./safetySpatialRepository";
import { SafetyEventRepository, type SafetyEventAdapter } from "./safetyEventRepository";
import { EMPTY_EVENT_SNAPSHOT, type SafetyEventSnapshot } from "./safetyEventTypes";
import { mergeSafetyEvents } from "./safetyEventData";
import { LocalSafetyDataAdapter } from "./safetyData";
import { SafetyDashboard } from "./safetyDashboardV3";
import { SafetySceneEffects } from "./safetySceneEffects";
import { SafetyStore, deriveSafetyView } from "./safetyStore";
import type { SafetyDataAdapter, SafetyDataset, SafetyDevice, SafetyMedia, SafetySelection, SafetyState, SafetyPage } from "./safetyTypes";
import type { ImportRecord } from "./types";
import "./safetyWorkspace.css";

export type SafetyWorkspaceOptions = {
  viewer: Viewer; host: HTMLElement; ready: () => Promise<unknown>;
  getImports: () => readonly ImportRecord[];
  setLayerVisible: (id: string, visible: boolean) => void;
  setVideoPanelActive: (active: boolean) => void;
  getPlaybackSource: () => { generation: number; name: string; url: string; recordId: string };
  syncVideoPlayback: () => void;
  prepareOpen: () => () => void;
  restoreWorkbench: () => void;
  openVideoSettings: () => void;
  adapter?: SafetyDataAdapter; eventAdapter?: SafetyEventAdapter;
  loadVideoSource?: (recordId: string) => Promise<void>;
  clearVideoSource?: () => void;
};

/** Shared navigation/data clock. The existing Viewer, video decoder and library remain the owners of their resources. */
export class SafetyWorkspace {
  private managementHost?: ManagementSceneHost;
  private managementSceneVisible = true;
  readonly dashboard: SafetyDashboard;
  readonly effects: SafetySceneEffects;
  readonly spatial: SafetySpatialEditor;
  readonly optimization: SafetyModelOptimization;
  private videoRoam?: SafetyVideoRoam;
  private roamBindingKey = "";
  private managementMediaRevoked = false;
  private readonly managementHiddenResources = new Map<object, boolean>();
  private roamState?: SafetyVideoRoamState;
  private optimizationEntryMode?: SafetyState["mode"];
  private baseDataset?: SafetyDataset;
  private reloading = false;
  private modelRegistry: ModelRegistryEntry[] = [];
  private eventSnapshot: SafetyEventSnapshot = structuredClone(EMPTY_EVENT_SNAPSHOT);
  private readonly eventRepository: SafetyEventAdapter;
  private eventServiceError = "";
  private mediaLoading = false;
  private mediaRequestGeneration = 0;
  private mediaSourceTask: Promise<void> = Promise.resolve();
  private inspectionMode: "live" | "replay" = "replay";
  private readonly pageSelections = new Map<SafetyPage, SafetySelection>();
  private store?: SafetyStore;
  private readonly adapter: SafetyDataAdapter;
  private readonly events = new AbortController();
  private loading?: AbortController;
  private unsubscribe?: () => void;
  private removeClock?: () => void;
  private restoreInteractions?: () => void;
  private active = false;
  private disposed = false;
  private startedAt = 0;
  private lastTick = 0;
  private lastStateTick = 0;
  private replayTime = 0;
  private observedStoreTime = NaN;
  private lastCruise = 0;
  private cruiseIndex = 0;
  private video?: HTMLVideoElement;
  private videoOrigin?: { parent: Node; next: ChildNode | null; hidden: boolean; controls: boolean };
  private readonly tags = new Map<object, PropertyDescriptor | undefined>();
  private selectedMedia?: string;
  private explicitlySelectedMedia?: string;
  private boundSourceKey = "";
  private readonly validReplayTracks = new WeakMap<SafetyDevice, boolean>();
  private readonly mediaDialog = document.createElement("dialog");
  private readonly pageWasHidden = () => { if (this.active && document.hidden) this.pause(); };

  constructor(private readonly options: SafetyWorkspaceOptions) {
    this.adapter = options.adapter ?? new LocalSafetyDataAdapter();
    this.eventRepository = options.eventAdapter ?? new SafetyEventRepository();
    this.dashboard = new SafetyDashboard(options.host, {
      onSelect: selection => this.select(selection), onPatch: patch => this.patch(patch),
      onHome: () => this.spatial.requestClose(() => this.returnOverview()),
      onExit: () => { this.spatial.requestClose(() => this.close()); }, onEarth: () => { this.beforeManualNavigation(); this.store?.patch({ cruise: false }); this.effects.earth(); },
      onMedia: (media, selection) => this.openMedia(media, selection), onRefresh: () => void this.reload(),
      onLayerToggle: (id, visible) => { options.setLayerVisible(id, visible); this.layersChanged(); },
      onVideoSettings: () => { this.close(); options.openVideoSettings(); },
      onModelOptimization: () => { this.spatial.requestClose(() => { this.beforeManualNavigation(); this.pause(); this.optimizationEntryMode = this.store?.state.mode; this.optimization.open(this.store?.state.mode === 'inspection'); }); },
      onTextScaleChange: large => this.effects?.setLargeText(large),
      onVideoRoamChange: enabled => this.videoRoam?.setEnabled(enabled),
      onAuthoring: () => { this.spatial.requestClose(() => { this.optimization.close(); this.beforeManualNavigation(); this.applyPageChange("overview"); this.dashboard.setPage("overview"); this.spatial.show(); }); },
      onPageChange: page => this.changePage(page),
      onInspectionModeChange: mode => { this.inspectionMode = mode; this.pause(); this.updateVideoStatus(); },
      onHandleEvent: (id, text) => this.handleEvent(id, text),
      onEventFilter: (status, query) => this.store?.patch({ eventStatus: status, eventQuery: query }),
      onSpatialLayers: patch => { this.spatial.setLayers(patch); this.effects.setSpatialLayers(patch); },
      onMediaSeekSeconds: seconds => this.seekMediaSeconds(seconds),
      onPlaybackRateChange: rate => { if (this.video && [0.5, 1, 1.5, 2].includes(rate)) this.video.playbackRate = rate; },
    });
    this.effects = new SafetySceneEffects(options.viewer, selection => this.select(this.managementHost ? { ...selection, fly: false } : selection), { getImports: options.getImports,
      getPresentationModels: () => this.runtimeModels(),
      onPresentationState: status => this.dashboard.setPresentationStatus(status),
      getStageRect: () => this.sceneStageRect(false),
      getOverviewStageRect: () => this.sceneStageRect(true)
    });
    this.spatial = new SafetySpatialEditor({ viewer: options.viewer, host: options.host,
      onSnapshot: snapshot => this.applySpatialSnapshot(snapshot),
      suspendOverlays: () => this.effects.suspendOverlaysForPicking(),
      onSelect: (id, options) => { this.select({ nodeId: `spatial:${id}`, fly: options?.fly ?? true }); },
      onDrawing: drawing => { this.effects.setPickingEnabled(!drawing); this.effects.setAuthoring(drawing); if (drawing) { this.pause(); this.beforeManualNavigation(); this.store?.patch({ cruise: false }); } this.publishManagementContext(); },
      onVisibility: visible => { this.dashboard.setAuthoring(visible); this.publishManagementContext(); },
      getModelRegistry: () => this.runtimeModels(),
      getContext: () => {
        if (!this.store) return;
        const seconds = this.hasBoundVideo() ? this.video?.currentTime : undefined;
        const time = seconds === undefined ? undefined : spatialReplayTimeAt(this.replayDevice()?.track || [], seconds);
        return { dataset: this.store.dataset, state: { ...this.store.state, time: time ?? this.store.state.time },
          ...(time === undefined ? {} : { mediaId: this.selectedMedia, mediaSeconds: seconds }) };
      },
    });
    this.optimization = new SafetyModelOptimization({ host: options.host, getModels: () => this.modelRegistry,
      onVisibility: visible => {
        this.dashboard.setModelOptimizationVisible(visible);
        this.effects.setPickingEnabled(!visible);
        if (!visible && this.optimizationEntryMode !== undefined) {
          const mode = this.optimizationEntryMode; this.optimizationEntryMode = undefined;
          this.store?.patch({ mode });
        }
      },
      onCompare: original => { this.beforeManualNavigation(); this.store?.patch({ mode: original ? "inspection" : "presentation" }); },
    });
    this.dashboard.setVisible(false);
    this.mediaDialog.className = "safety-media-dialog";
    document.body.append(this.mediaDialog);
    this.mediaDialog.addEventListener("click", event => { if (event.target === this.mediaDialog) this.mediaDialog.close(); }, { signal: this.events.signal });
    document.addEventListener("visibilitychange", this.pageWasHidden, { signal: this.events.signal });
    window.addEventListener("beforeunload", () => this.dispose(), { once: true, signal: this.events.signal });
    const video = document.querySelector<HTMLVideoElement>("#videoArSourceVideo");
    if (video) {
      this.video = video;
      this.videoRoam = new SafetyVideoRoam({ viewer: options.viewer, video,
        onState: state => this.acceptVideoRoamState(state),
        canTakeCamera: () => this.active && this.store?.state.page === "inspection" && this.inspectionMode === "replay" && !this.optimization.isOpen && !this.spatial.debugStats().drawing && this.managementSceneVisible,
        beforeTakeCamera: () => { this.effects.cancelPendingHome(); options.viewer.camera.cancelFlight(); this.store?.patch({ cruise: false }); },
      });
      for (const event of ["play", "pause", "ended", "loadedmetadata", "durationchange", "seeked", "error", "timeupdate"]) video.addEventListener(event, () => {
        if (!this.active) return;
        if (event === "error") this.dashboard.setVideoStatus("原片暂不能解码，可在视频 AR 设置中检查媒体格式。");
        else {
          const mapped = event === "seeked" && this.hasBoundVideo() ? this.mapReplayTime(video.currentTime, "mediaSeconds") : undefined;
          this.store?.patch({ playing: this.hasBoundVideo() && !video.paused && !video.ended, ...(mapped === undefined ? {} : { time: mapped }) });
          this.updateVideoStatus();
        }
      }, { signal: this.events.signal });
    }
  }

  /** New management UI shares this original scene/video/editor ownership. */
  attachManagementHost(host?: ManagementSceneHost): void {
    this.managementHost = host;
    if (this.videoOrigin && this.video) (host?.videoHost ?? this.dashboard.videoHost).append(this.video);
    this.publishManagementContext();
  }
  getManagementContext(): ManagementSceneContext {
    const d = this.spatial.debugStats(), available = this.hasBoundVideo();
    return { mode: this.effects.getDisplayMode(), spatialObjects: this.spatial.getSnapshot().objects.filter(o => !o.deletedAt),
      media: this.store?.dataset.media ?? [], sourceAssets: this.store?.dataset.media ?? [],
      models: this.modelRegistry.map(m => ({ id: m.assetId, name: this.options.getImports().find(r => r.id === m.assetId)?.name ?? m.assetId, version: m.assetVersion })),
      layers: this.options.getImports().map(r => ({ id: r.id, name: r.name, kind: r.kind, visible: r.visible })),
      selectedSpatialId: this.store?.view.selected.spatialObjectId,
      videoState: { selectedId: this.selectedMedia, available, playing: available && !this.video!.paused,
        currentTime: this.video?.currentTime ?? 0, duration: Number.isFinite(this.video?.duration) ? this.video!.duration : 0,
        rate: this.video?.playbackRate ?? 1, roam: this.roamState, error: this.video?.error?.message },
      toolState: { visible: d.visible, drawing: d.drawing, stage: d.stage ?? "choose", canUndo: d.canUndo, canRedo: d.canRedo, draftVertices: d.draftVertices } };
  }
  private publishManagementContext(): void { if (this.managementHost && this.spatial) this.managementHost.onContext(this.getManagementContext()); }
  setManagementSceneVisible(visible: boolean): void {
    this.managementSceneVisible = visible;
    if (!visible) { this.pause(); this.beforeManualNavigation(); this.effects.cancelPendingHome(); this.options.viewer.camera.cancelFlight(); }
    this.options.viewer.useDefaultRenderLoop = visible;
    if (visible) { this.options.viewer.resize(); this.options.viewer.scene.requestRender(); }
    this.publishManagementContext();
  }
  managementSelectSpatial(id?: string, highlightIds: string[] = []): void {
    if (id && this.store?.dataset.nodes.some(n => n.spatialObjectId === id)) this.select({ nodeId: `spatial:${id}`, fly: false });
    else if (this.store) this.store.patch({ selectedId: this.store.dataset.projectId, selectedAlertId: undefined });
    this.spatial.setManagementSelection(highlightIds.length ? highlightIds : id ? [id] : []);
  }
  managementLocateSpatial(id: string): boolean {
    const node = this.store?.dataset.nodes.find(n => n.spatialObjectId === id);
    if (!node || node.sceneAvailable === false || node.navigationDisabledReason) return false;
    this.beforeManualNavigation(); this.effects.cancelPendingHome(); this.effects.focus(node, 1.2); return true;
  }
  managementHome(): void { this.returnOverview(); }
  managementMode(mode: "presentation" | "inspection"): void { this.patch({ mode }); }
  managementPause(): void { this.pause(); this.beforeManualNavigation(); this.effects.cancelPendingHome(); this.options.viewer.camera.cancelFlight(); this.store?.patch({ cruise: false }); }
  managementOpenEditor(kind?: "construction-area" | "railway" | "risk-point", id?: string): void {
    this.spatial.requestClose(() => { this.optimization.close(); this.pause(); this.beforeManualNavigation(); this.store?.patch({ cruise: false });
      if (id) this.spatial.editDefinition(id); else if (kind) this.spatial.beginDefinition(kind); else this.spatial.showDefinitionTypes();
    });
  }
  managementQuality(): void { this.spatial.requestClose(() => { this.pause(); this.beforeManualNavigation(); this.optimizationEntryMode = this.store?.state.mode; this.optimization.open(this.store?.state.mode === "inspection"); }); }
  managementLayer(id: string, visible: boolean): void { this.options.setLayerVisible(id, visible); this.layersChanged(); this.publishManagementContext(); }
  async managementPlayMedia(id: string): Promise<void> {
    const media = this.store?.dataset.media.find(m => m.id === id || m.sourceRecordId === id);
    if (!media || media.kind !== "video") throw new Error("录像来源暂不可用");
    this.applyPageChange("inspection"); await this.openMedia(media); this.publishManagementContext();
  }
  managementMediaControl(action: "play" | "pause" | "seek" | "rate" | "follow", value?: number | boolean): void {
    if (action === "play") this.patch({ playing: true });
    else if (action === "pause") this.pause();
    else if (action === "seek") this.seekMediaSeconds(Number(value));
    else if (action === "rate" && this.video && [.5,1,1.5,2].includes(Number(value))) this.video.playbackRate = Number(value);
    else if (action === "follow") this.videoRoam?.setEnabled(Boolean(value));
    this.publishManagementContext();
  }
  getManagementModels() { return this.runtimeModels(); }
  getManagementModelVersions() { return this.modelRegistry.map(({assetId,assetVersion,coordinateTransformVersion})=>({assetId,assetVersion,coordinateTransformVersion})); }
  getManagementViewer(): Viewer { return this.options.viewer; }
  getManagementVideo(): HTMLVideoElement | undefined { return this.video; }
  setManagementResourceAccess(access: {models:boolean;files:boolean;media:boolean}): void {
    const resources=new Set<object>();
    for(const item of this.options.getImports()){
      const resource=item.resource as object & {show?:boolean};resources.add(resource);
      const allowed=(item.kind==='CAD'||item.kind==='GIS')?access.files:access.models;
      if(!allowed&&typeof resource.show==='boolean'){if(!this.managementHiddenResources.has(resource))this.managementHiddenResources.set(resource,resource.show);resource.show=false;}
      else if(allowed&&this.managementHiddenResources.has(resource)){resource.show=this.managementHiddenResources.get(resource)!&&item.visible;this.managementHiddenResources.delete(resource);}
    }
    for(const resource of this.managementHiddenResources.keys())if(!resources.has(resource))this.managementHiddenResources.delete(resource);
  }
  setManagementMediaAccess(allowed: boolean): void {
    if(this.managementMediaRevoked === !allowed)return;
    this.managementMediaRevoked = !allowed;
    if(allowed)return;
    this.mediaRequestGeneration++;this.mediaLoading=false;this.selectedMedia=undefined;this.explicitlySelectedMedia=undefined;this.boundSourceKey='';
    this.pause();this.unbindVideoRoam();this.options.clearVideoSource?.();
    if(this.video){this.video.removeAttribute('src');this.video.load();}
  }

  get isOpen(): boolean { return this.active; }

  async open(): Promise<void> {
    if (this.disposed || this.active) return;
    this.active = true;
    // Re-entry always starts at overview before any stale inspection state can bind.
    this.store?.patch({ page: "overview", playing: false });
    this.restoreInteractions = this.options.prepareOpen();
    document.body.classList.add("safety-workspace-open");
    this.dashboard.setVisible(true);
    this.options.viewer.resize();
    this.options.setVideoPanelActive(false);
    this.mountVideo();
    this.spatial.setActive(true);
    this.startedAt = this.lastTick = performance.now(); this.lastCruise = 0;
    this.removeClock = this.options.viewer.clock.onTick.addEventListener(() => this.tick());
    await this.options.ready();
    if (!this.active || this.disposed) return;
    if (this.store && this.boundSourceKey === this.playbackSourceKey()) {
      this.effects.setActive(true);
      this.renderState();
    } else await this.reload();
    if (!this.active || this.disposed) return;
    this.layersChanged();
    this.updateVideoStatus();
    if (this.store) this.returnOverview();
  }

  close(): void {
    if (!this.active) return;
    // Block synchronous pause/store subscribers from rebinding during teardown.
    this.options.viewer.useDefaultRenderLoop = true; this.managementSceneVisible = true;
    this.active = false; this.mediaRequestGeneration++; this.mediaLoading = false;
    this.loading?.abort();
    this.pause();
    this.optimization.close(); this.unbindVideoRoam();
    this.store?.patch({ cruise: false });
    this.removeClock?.(); this.removeClock = undefined;
    this.effects.setActive(false);
    this.dashboard.setVisible(false);
    this.spatial.setActive(false);
    this.unmountVideo();
    this.restoreTags();
    this.mediaDialog.close();
    document.body.classList.remove("safety-workspace-open");
    this.options.viewer.resize();
    this.restoreInteractions?.(); this.restoreInteractions = undefined;
    this.options.restoreWorkbench();
    this.options.viewer.scene.requestRender();
  }

  async reload(preserveSelection = false): Promise<void> {
    if (this.disposed) return;
    this.loading?.abort();
    this.reloading = true;
    this.unbindVideoRoam();
    const controller = this.loading = new AbortController();
    this.dashboard.setLoading("正在读取工程资料与巡检数据…");
    try {
      const [loadedDataset, models, events] = await Promise.all([
        this.adapter.load(controller.signal),
        new SafetySpatialRepository().loadModels().catch(() => [] as ModelRegistryEntry[]),
        this.eventRepository.load().catch(error => { this.eventServiceError = error instanceof Error ? error.message : "事件服务暂不可用"; return undefined; }),
      ]);
      if (controller.signal.aborted || this.disposed) return;
      this.modelRegistry = models;
      if (events) { this.eventSnapshot = events; this.eventServiceError = ""; }
      this.dashboard.setEventError(this.eventServiceError);
      const baseDataset = this.withProjectModelPosition(loadedDataset);
      if (controller.signal.aborted || this.disposed) return;
      this.baseDataset = baseDataset;
      let spatial = this.spatial.getSnapshot();
      try { spatial = await this.spatial.load(); } catch (error) { this.baseDataset = { ...this.baseDataset, missingData: [...this.baseDataset.missingData, `空间对象读取失败：${error instanceof Error ? error.message : "未知错误"}`] }; }
      const dataset = mergeSafetyEvents(mergeSpatialDataset(this.baseDataset, spatial), this.eventSnapshot);
      if (controller.signal.aborted || this.disposed) return;
      this.pause();
      this.effects.setDataset(dataset);
      if (this.store) this.store.setDataset(dataset, preserveSelection);
      else {
        this.store = new SafetyStore(dataset);
        this.unsubscribe = this.store.subscribe(() => this.renderState());
      }
      this.effects.setActive(this.active);
      const source = this.options.getPlaybackSource();
      const media = dataset.media.find(m => m.kind === "video" && m.provenance === "real" && m.sourceRecordId === source.recordId && m.name === source.name);
      this.selectedMedia = media?.id;
      if (this.explicitlySelectedMedia !== this.selectedMedia) this.explicitlySelectedMedia = undefined;
      this.boundSourceKey = media?.sourceRecordId === source.recordId && media?.name === source.name && source.url ? this.playbackSourceKey() : "";
      this.dashboard.setMediaSources(dataset.media.filter(m => m.kind === "video").map(m => ({ ...m, mode: "replay" as const })));
      this.dashboard.setLoading("");
      this.layersChanged();
      this.renderState();
      this.updateVideoStatus();
      if (this.active && !preserveSelection && !this.managementHost) this.effects.focus(this.store.view.selected);
    } catch (error) {
      if (!controller.signal.aborted) this.dashboard.setError(error instanceof Error ? error.message : "巡检数据读取失败");
    } finally {
      if (this.loading === controller) { this.reloading = false; this.updateVideoStatus(); }
    }
  }

  private renderState(): void {
    if (!this.store || this.disposed) return;
    this.dashboard.update(this.store.dataset, this.store.state, this.store.view);
    this.effects.update(this.store.state, this.store.view);
    this.spatial.update(this.store.view);
    this.updateVideoStatus();
  }

  private select(selection: SafetySelection): void {
    if (!this.active || !this.store) return;
    if (!this.managementHost || selection.fly === true) { this.optimization.close(); this.beforeManualNavigation(); this.pause(); }
    const target = this.store.dataset.nodes.find(n => n.id === selection.nodeId);
    const page: SafetyPage = this.managementHost ? this.store.state.page || "overview" : selection.alertId || target?.eventId ? "events" : target && !target.spatialObjectId && (target.kind === "pier" || target.kind === "component") ? "components" : this.store.state.page || "overview";
    this.dashboard.setPage(page);
    this.store.patch({ page, cruise: false, engineeringAnnotations: false });
    this.store.select(selection);
    if ((!this.managementHost ? selection.fly !== false : selection.fly === true) && !this.store.view.selected.navigationDisabledReason && this.store.view.selected.sceneAvailable !== false) this.effects.focus(this.store.view.selected);
    if (this.managementHost && target?.spatialObjectId) this.managementHost.onSpatialSelected(target.spatialObjectId);
    const alert = this.store.view.alerts.find(a => a.id === selection.alertId);
    if (alert) {
      this.pause(); this.store.patch({ time: alert.timestamp });
      const video = this.store.view.media.find(m => m.kind === "video" && alert.mediaIds.includes(m.id));
      if (video && alert.mediaSeconds !== undefined) { this.selectedMedia = video.id; this.seekVideo(alert.timestamp); }
    }
    this.updateVideoStatus();
  }

  private patch(patch: Partial<SafetyState>): void {
    if (!this.store) return;
    if (patch.mode !== undefined) this.effects.cancelPendingHome();
    if (patch.cruise) this.beforeManualNavigation();
    if (patch.reducedMotion !== undefined) this.videoRoam?.setReducedMotion(patch.reducedMotion);
    // A business filter never seeks the original recording. Only an explicit time does.
    const seeks = patch.time !== undefined;
    if (seeks) this.pause();
    this.store.patch(seeks ? { ...patch, playing: false } : patch);
    if (seeks) this.seekVideo(this.store.state.time);
    if (patch.playing === false) this.pause();
    if (patch.playing === true && this.inspectionMode !== "live") {
      if (this.hasBoundVideo()) {
        // Sparse telemetry may finish before the video; its extent cannot restart the media.
        if (this.video!.ended || (Number.isFinite(this.video!.duration) && this.video!.currentTime >= this.video!.duration)) this.video!.currentTime = 0;
      } else if (!this.selectedMedia && this.store.state.time >= this.store.state.timeRange[1] - 100) {
        this.store.patch({ time: this.store.state.timeRange[0] });
      }
      if (this.hasBoundVideo()) void this.video!.play().catch(() => {
        this.store?.patch({ playing: false }); this.dashboard.setVideoStatus("浏览器未开始播放，请再次点击时间轴播放按钮。");
      });
    }
    if (patch.cruise) this.lastCruise = -10;
  }

  private pause(): void { this.video?.pause(); if (this.store?.state.playing) this.store.patch({ playing: false }); }

  private replayDevice(): SafetyDevice | undefined {
    return this.store?.dataset.devices.find(d => d.mediaId === this.selectedMedia && d.track.length);
  }

  private playbackSourceKey(): string {
    const source = this.options.getPlaybackSource();
    return JSON.stringify([source.recordId, source.generation, source.url]);
  }

  private hasReplayTrack(): boolean {
    const device = this.replayDevice();
    if (device && !this.validReplayTracks.has(device)) this.validReplayTracks.set(device, device.track.every((p, i, points) =>
      Number.isFinite(p.time) && Number.isFinite(p.mediaSeconds) && (i === 0 || (p.time > points[i - 1].time && p.mediaSeconds > points[i - 1].mediaSeconds))));
    return !!(device && this.validReplayTracks.get(device));
  }

  private hasBoundVideo(): boolean {
    const media = this.store?.dataset.media.find(m => m.id === this.selectedMedia), source = this.options.getPlaybackSource();
    const associated = this.store?.view.media.some(m => m.id === this.selectedMedia);
    return !!((associated || this.explicitlySelectedMedia === this.selectedMedia) && this.boundSourceKey && this.boundSourceKey === this.playbackSourceKey() && media?.provenance === "real"
      && media.sourceRecordId === source.recordId && media.name === source.name
      && !!source.url && this.video?.currentSrc === source.url && this.video.readyState >= 1);
  }

  /** An untracked video's elapsed seconds never become a scene timestamp or a measured flight position. */
  private seekMediaSeconds(seconds: number): void {
    if (!this.hasBoundVideo() || !Number.isFinite(seconds) || !Number.isFinite(this.video!.duration)) return;
    this.pause();
    this.video!.currentTime = Math.max(0, Math.min(this.video!.duration, seconds));
    const mapped = this.mapReplayTime(this.video!.currentTime, "mediaSeconds");
    if (mapped !== undefined) this.store?.patch({ time: mapped });
    this.updateVideoStatus();
  }

  /** Time interpolation is independent of position: a telemetry gap may still contain valid video frames. */
  private mapReplayTime(value: number, from: "time" | "mediaSeconds"): number | undefined {
    const track = this.replayDevice()?.track;
    if (!track?.length || !this.hasReplayTrack()) return;
    const to = from === "time" ? "mediaSeconds" : "time";
    if (value < track[0][from] || value > track.at(-1)![from]) return;
    if (value === track[0][from]) return track[0][to];
    if (value === track.at(-1)![from]) return track.at(-1)![to];
    let low = 1; let high = track.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (track[middle][from] < value) low = middle + 1; else high = middle; }
    const a = track[low - 1], b = track[low];
    return a[to] + (b[to] - a[to]) * (value - a[from]) / Math.max(.000001, b[from] - a[from]);
  }

  private seekVideo(time: number): void {
    if (!this.hasBoundVideo()) return;
    const seconds = this.mapReplayTime(time, "time");
    if (seconds !== undefined && Math.abs(this.video!.currentTime - seconds) > .01) this.video!.currentTime = Math.max(0, Math.min(this.video!.duration, seconds));
  }

  private tick(): void {
    if (!this.active || !this.store || this.disposed) return;
    const now = performance.now(), elapsed = (now - this.startedAt) / 1000, delta = Math.max(0, Math.min(250, now - this.lastTick));
    this.lastTick = now;
    if (this.observedStoreTime !== this.store.state.time) this.replayTime = this.store.state.time;
    let time = this.replayTime;
    const bound = this.hasBoundVideo(), synchronized = bound && this.hasReplayTrack();
    if (synchronized && !this.video!.paused) time = this.mapReplayTime(this.video!.currentTime, "mediaSeconds") ?? time;
    else if (!bound && !this.selectedMedia && this.store.state.playing) time += delta;
    // Media time drives telemetry, never the reverse. Keep uncovered video frames playing.
    if (!bound) {
      if (time >= this.store.state.timeRange[1]) { this.pause(); time = this.store.state.timeRange[1]; this.seekVideo(time); }
      if (time < this.store.state.timeRange[0]) { time = this.store.state.timeRange[0]; this.seekVideo(time); }
    }
    this.replayTime = time;
    if (now - this.lastStateTick >= 100) {
      this.lastStateTick = now;
      if (Math.abs(time - this.store.state.time) > 8) this.store.patch({ time });
      else this.updateVideoStatus();
    }
    this.observedStoreTime = this.store.state.time;
    this.effects.tick(elapsed, time);
    if (!document.hidden && this.store.state.cruise && !this.store.state.animationPaused && elapsed - this.lastCruise >= 9) {
      const overview = deriveSafetyView(this.store.dataset, { ...this.store.state, selectedId: this.store.dataset.projectId });
      const stops = overview.nodes.filter(n => n.kind === "section" || n.kind === "pier").slice(0, 24);
      const stop = stops[this.cruiseIndex++ % stops.length];
      if (stop) { this.store.select({ nodeId: stop.id }); this.effects.focus(stop, 2); }
      this.lastCruise = elapsed;
    }
  }

  private mountVideo(): void {
    const video = this.video;
    if (!video?.parentNode || this.videoOrigin) return;
    this.videoOrigin = { parent: video.parentNode, next: video.nextSibling, hidden: video.hidden, controls: video.controls };
    (this.managementHost?.videoHost ?? this.dashboard.videoHost).append(video);
    video.hidden = false; video.controls = false;
    video.classList.add("safety-reused-video");
  }

  private unmountVideo(): void {
    const video = this.video, origin = this.videoOrigin;
    if (!video || !origin) return;
    this.options.syncVideoPlayback();
    origin.parent.insertBefore(video, origin.next?.parentNode === origin.parent ? origin.next : null);
    video.hidden = origin.hidden; video.controls = origin.controls;
    video.classList.remove("safety-reused-video"); this.videoOrigin = undefined;
  }

  private updateVideoStatus(): void {
    if (!this.store) return;
    this.syncVideoRoamBinding();
    const media = this.store.dataset.media.find(m => m.id === this.selectedMedia);
    const available = this.inspectionMode === "replay" && !this.mediaLoading && this.hasBoundVideo();
    if (this.video && this.videoOrigin) this.video.hidden = !available;
    const associated = this.store.view.media.some(m => m.id === this.selectedMedia);
    const relation = this.store.view.selected.kind !== "project" && !associated ? "项目来源 · 未与当前对象关联" : media?.relation === "object" ? "对象关联视频" : "项目视频";
    this.dashboard.setVideoStatus(this.mediaLoading ? "正在加载原片…" : available ? `${relation} · ${this.hasReplayTrack() ? "遥测时间已关联" : "未关联航迹，按视频进度播放"}` : this.inspectionMode === "live" ? "暂无可用实时画面" : "暂无可用画面");
    this.dashboard.setMediaState({ selectedId: this.selectedMedia, mode: this.inspectionMode, canPlay: available, playing: available && !this.video!.paused,
      currentTimeSeconds: available ? this.video!.currentTime : undefined, durationSeconds: available && Number.isFinite(this.video!.duration) ? this.video!.duration : undefined,
      rate: this.video?.playbackRate || 1, hasTrack: this.hasReplayTrack(),
      error: this.video?.error ? "画面暂不可用，请重试或切换来源" : undefined });
    this.publishManagementContext();
  }

  private async openMedia(media: SafetyMedia, selection?: SafetySelection): Promise<void> {
    if (!this.active || this.disposed || this.managementMediaRevoked || media.kind !== "video") return;
    const generation = ++this.mediaRequestGeneration;
    const current = () => this.active && !this.disposed && generation === this.mediaRequestGeneration;
    const retained = selection || (this.store ? { nodeId: this.store.state.selectedId, alertId: this.store.state.selectedAlertId } : undefined);
    this.mediaLoading = true;
    this.pause(); this.unbindVideoRoam(); this.inspectionMode = "replay"; this.updateVideoStatus();
    // The shared library loader is not abortable. Serialize it so an older restore cannot
    // overwrite a newer source; obsolete queued requests never start a restore.
    const task = this.mediaSourceTask.catch(() => undefined).then(async () => {
      if (!current()) return;
      if (media.sourceRecordId && (media.sourceRecordId !== this.options.getPlaybackSource().recordId || !this.options.getPlaybackSource().url)) {
        if (!this.options.loadVideoSource) throw new Error("当前来源暂不可用，请在原工作台选择已有视频");
        await this.options.loadVideoSource(media.sourceRecordId);
        if (!current()) {if(this.managementMediaRevoked)this.options.clearVideoSource?.();return;}
        await this.reload(true);
      }
    });
    this.mediaSourceTask = task;
    try {
      await task;
      if (!current()) return;
      this.selectedMedia = media.id; this.explicitlySelectedMedia = media.id;
      const source = this.options.getPlaybackSource();
      this.boundSourceKey = media.sourceRecordId === source.recordId && media.name === source.name && source.url ? this.playbackSourceKey() : "";
      if (retained && this.store?.dataset.nodes.some(n => n.id === retained.nodeId)) this.store.patch({ selectedId: retained.nodeId, selectedAlertId: retained.alertId });
    } finally {
      if (current()) { this.mediaLoading = false; this.updateVideoStatus(); }
    }
  }

  private beforeManualNavigation(): void { this.videoRoam?.beforeManualNavigation(); }

  private acceptVideoRoamState(state: SafetyVideoRoamState): void {
    // A same-URL media reload invalidates the host even if the library generation stayed equal.
    if (state.state === "unbound" || state.state === "source-changed" || state.state === "destroyed") this.roamBindingKey = "";
    this.roamState = state; this.dashboard.setVideoRoamState(state); this.updateInspectionContext();
  }

  private unbindVideoRoam(): void {
    this.roamBindingKey = "";
    if (this.videoRoam?.getState().state !== "unbound") this.videoRoam?.unbind();
    this.effects?.setInspectionContext(undefined);
  }

  private syncVideoRoamBinding(): void {
    if (!this.active || this.reloading || this.store?.state.page !== "inspection" || this.inspectionMode !== "replay" || this.mediaLoading || !this.hasBoundVideo()) { this.unbindVideoRoam(); return; }
    const source = this.options.getPlaybackSource(), media = this.store.dataset.media.find(m => m.id === this.selectedMedia);
    if (!media || !source.url || this.video?.currentSrc !== source.url) { this.unbindVideoRoam(); return; }
    const key = JSON.stringify([media.id, source.recordId, source.generation, source.url]);
    if (this.roamBindingKey !== key) {
      this.roamBindingKey = key;
      void this.videoRoam?.bind({ mediaId: media.id, sourceRecordId: source.recordId, sourceUrl: source.url, generation: source.generation, mediaName: source.name, reducedMotion: !!this.store.state.reducedMotion });
    }
    this.updateInspectionContext();
  }

  private updateInspectionContext(): void {
    const valid = this.active && this.store?.state.page === "inspection" && this.inspectionMode === "replay" && this.roamState?.available && this.selectedMedia;
    // The roam runtime owns the converted display geometry as well as its camera.
    // Raw device.track remains business evidence and must not render at an unconverted height/time.
    this.videoRoam?.setLayerVisibility(!!valid && !!this.store?.state.layers.track, !!valid && !!this.store?.state.layers.markers);
    this.effects?.setInspectionContext(undefined);
  }

  private sceneStageRect(overview: boolean) {
    const c = this.options.viewer.canvas.getBoundingClientRect();
    const external = this.managementHost?.getStageRect();
    if (external) return { left: external.left - c.left, top: external.top - c.top, width: external.width, height: external.height };
    if (!overview) {
      const r = this.options.host.querySelector(".safety-scene-hud")?.getBoundingClientRect();
      if (r) return { left: r.left - c.left, top: r.top - c.top + 52, width: r.width, height: Math.max(180, r.height - 52) };
    }
    const compact = c.width <= 1550, side = Math.max(compact ? 268 : 270, Math.min(compact ? 305 : 414, c.width * .198));
    const top = (compact ? 76 : 90) + 64;
    return { left: side + 30, top, width: Math.max(300, c.width - 2 * (side + 30)), height: Math.max(240, c.height - top - 102) };
  }

  private runtimeModels(): Array<ModelRegistryEntry & { tileset: Cesium3DTileset }> {
    return this.modelRegistry.flatMap(entry => {
      const record = this.options.getImports().find(r => r.id === entry.assetId && r.kind === "3D Tiles" && r.visible);
      const tileset = record?.resource;
      if (!(tileset instanceof Cesium3DTileset) || tileset.isDestroyed() || !tileset.show) return [];
      if (!Matrix4.equalsEpsilon(tileset.modelMatrix, Matrix4.fromArray(entry.matrix), 1e-8)) return [];
      return [{ ...entry, tileset }];
    });
  }

  private withProjectModelPosition(dataset: SafetyDataset): SafetyDataset {
    const project = dataset.nodes.find(n => n.id === dataset.projectId);
    if (!project || project.sceneAvailable !== false) return dataset;
    const model = this.options.getImports().find(r => r.kind === "3D Tiles" && r.visible)?.resource as Cesium3DTileset | undefined;
    if (!model || model.isDestroyed()) return dataset;
    const center = Cartographic.fromCartesian(model.boundingSphere.center);
    const node = { ...project, sceneAvailable: true, position: { longitude: CesiumMath.toDegrees(center.longitude), latitude: CesiumMath.toDegrees(center.latitude), height: center.height }, radius: model.boundingSphere.radius };
    return { ...dataset, nodes: dataset.nodes.map(n => n.id === project.id ? node : n) };
  }

  private returnOverview(): void {
    if (!this.store) return;
    this.optimization.close(); this.beforeManualNavigation();
    this.pageSelections.delete("overview");
    this.dashboard.setPage("overview");
    this.store.patch({ page: "overview", mode: "presentation", selectedId: this.store.dataset.projectId, selectedAlertId: undefined, cruise: false });
    this.unbindVideoRoam(); this.pause();
    this.effects.focus(this.store.view.selected);
  }

  private changePage(page: SafetyPage): boolean {
    if (!this.store) return true;
    return this.spatial.requestClose(() => { this.optimization.close(); this.beforeManualNavigation(); if (page === "overview") this.returnOverview(); else { this.applyPageChange(page); this.dashboard.setPage(page); } });
  }

  private applyPageChange(page: SafetyPage): void {
    if (!this.store) return;
    const oldPage = this.store.state.page || "overview";
    this.pageSelections.set(oldPage, { nodeId: this.store.state.selectedId, alertId: this.store.state.selectedAlertId, fly: false });
    this.pause();
    const previous = this.pageSelections.get(page);
    this.store.patch({ page, eventStatus: "all", eventQuery: "", selectedId: previous?.nodeId || this.store.dataset.projectId, selectedAlertId: previous?.alertId });
    this.updateVideoStatus();
  }

  private async handleEvent(id: string, text: string): Promise<void> {
    const eventId = this.store?.dataset.alerts.find(a => a.id === id)?.eventId || id;
    try { this.eventSnapshot = await this.eventRepository.complete(eventId, { description: text }, this.eventSnapshot.revision); }
    catch (error) { try { this.eventSnapshot = await this.eventRepository.load(); } catch { /* Keep last confirmed state. */ } throw error; }
    this.applySpatialSnapshot(this.spatial.getSnapshot());
    this.store?.patch({ eventStatus: "all", selectedId: `safety-event:${eventId}`, selectedAlertId: `event:${eventId}` });
  }

  layersChanged(): void {
    if (this.disposed) return;
    const records = this.options.getImports();
    this.dashboard.setLayers(records.map(({ id, name, kind, visible }) => ({ id, name, kind, visible })));
    this.restoreTags();
    if (!this.active) return;
    for (const record of records) {
      const tag = (object: unknown) => {
        if (!object || typeof object !== "object" || !Object.isExtensible(object)) return;
        if (!this.tags.has(object)) this.tags.set(object, Object.getOwnPropertyDescriptor(object, "safetySourceRecordId"));
        Object.defineProperty(object, "safetySourceRecordId", { configurable: true, writable: true, value: record.id });
      };
      tag(record.resource);
      if (record.kind === "CAD") {
        const source = record.resource as { length?: number; get?: (i: number) => unknown; entities?: { values: object[] } };
        if (source.get && typeof source.length === "number") for (let i = 0; i < source.length; i++) tag(source.get(i));
        source.entities?.values.forEach(tag);
      }
    }
  }

  private applySpatialSnapshot(snapshot: SpatialSnapshot): void {
    if (!this.baseDataset || !this.store || this.reloading || this.disposed) return;
    this.pause();
    const dataset = mergeSafetyEvents(mergeSpatialDataset(this.baseDataset, snapshot), this.eventSnapshot);
    this.effects.setDataset(dataset); this.store.setDataset(dataset, true); this.renderState();
  }

  debugStats(): Record<string, unknown> {
    return { active: this.active, clockListeners: Number(!!this.removeClock), viewerCount: document.querySelectorAll("#cesiumContainer canvas").length,
      videoElements: document.querySelectorAll("video").length, spatial: this.spatial.debugStats(), videoRoam: this.videoRoam?.debugStats(), optimization: this.optimization.debugStats(), models: this.modelRegistry.map(({assetId,assetVersion,coordinateTransformVersion})=>({assetId,assetVersion,coordinateTransformVersion})), events: { revision: this.eventSnapshot.revision, count: this.eventSnapshot.events.length, error: this.eventServiceError }, effects: this.effects.debugStats(), ui: this.dashboard.debugStats(),
      data: this.store ? { nodes: this.store.dataset.nodes.length, alerts: this.store.view.alerts.map(a => a.id), nodeIds: this.store.view.nodes.map(n => n.id),
        selectedId: this.store.state.selectedId, state: this.store.state, metrics: this.store.view.metrics, sources: this.store.dataset.sourceNotes, missing: this.store.dataset.missingData } : null };
  }

  private restoreTags(): void {
    for (const [object, previous] of this.tags) {
      try { if (previous) Object.defineProperty(object, "safetySourceRecordId", previous); else Reflect.deleteProperty(object, "safetySourceRecordId"); } catch { /* Resource may already have been destroyed by its owner. */ }
    }
    this.tags.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.close(); this.disposed = true; this.loading?.abort(); this.events.abort(); this.unsubscribe?.();
    this.videoRoam?.dispose(); this.optimization.dispose(); this.store?.dispose(); this.spatial.dispose(); this.effects.dispose(); this.dashboard.dispose(); this.mediaDialog.remove();
    this.restoreTags();
  }
}
