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
};

/** Shared navigation/data clock. The existing Viewer, video decoder and library remain the owners of their resources. */
export class SafetyWorkspace {
  readonly dashboard: SafetyDashboard;
  readonly effects: SafetySceneEffects;
  readonly spatial: SafetySpatialEditor;
  private baseDataset?: SafetyDataset;
  private reloading = false;
  private modelRegistry: ModelRegistryEntry[] = [];
  private eventSnapshot: SafetyEventSnapshot = structuredClone(EMPTY_EVENT_SNAPSHOT);
  private readonly eventRepository: SafetyEventAdapter;
  private eventServiceError = "";
  private mediaLoading = false;
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
      onExit: () => { this.spatial.requestClose(() => this.close()); }, onEarth: () => { this.store?.patch({ cruise: false }); this.effects.earth(); },
      onMedia: (media, selection) => this.openMedia(media, selection), onRefresh: () => void this.reload(),
      onLayerToggle: (id, visible) => { options.setLayerVisible(id, visible); this.layersChanged(); },
      onVideoSettings: () => { this.close(); options.openVideoSettings(); },
      onAuthoring: () => { this.spatial.requestClose(() => { this.applyPageChange("overview"); this.dashboard.setPage("overview"); this.spatial.show(); }); },
      onPageChange: page => this.changePage(page),
      onInspectionModeChange: mode => { this.inspectionMode = mode; this.pause(); this.updateVideoStatus(); },
      onHandleEvent: (id, text) => this.handleEvent(id, text),
      onEventFilter: (status, query) => this.store?.patch({ eventStatus: status, eventQuery: query }),
      onSpatialLayers: patch => { this.spatial.setLayers(patch); this.effects.setSpatialLayers(patch); },
      onMediaSeekSeconds: seconds => this.seekMediaSeconds(seconds),
      onPlaybackRateChange: rate => { if (this.video && [0.5, 1, 1.5, 2].includes(rate)) this.video.playbackRate = rate; },
    });
    this.effects = new SafetySceneEffects(options.viewer, selection => this.select(selection), { getImports: options.getImports,
      getPresentationModels: () => this.runtimeModels(),
      onPresentationState: status => this.dashboard.setPresentationStatus(status),
      getStageRect: () => { const r = options.host.querySelector(".safety-scene-hud")?.getBoundingClientRect(); const c = options.viewer.canvas.getBoundingClientRect(); return r ? { left: r.left - c.left, top: r.top - c.top + 46, width: r.width, height: Math.max(180, r.height - 100) } : { left: 368, top: 160, width: Math.max(300, c.width - 736), height: Math.max(240, c.height - 300) }; }
    });
    this.spatial = new SafetySpatialEditor({ viewer: options.viewer, host: options.host,
      onSnapshot: snapshot => this.applySpatialSnapshot(snapshot),
      suspendOverlays: () => this.effects.suspendOverlaysForPicking(),
      onSelect: (id, options) => { this.select({ nodeId: `spatial:${id}`, fly: options?.fly ?? true }); },
      onDrawing: drawing => { this.effects.setPickingEnabled(!drawing); this.effects.setAuthoring(drawing); if (drawing) this.store?.patch({ cruise: false }); },
      onVisibility: visible => this.dashboard.setAuthoring(visible),
      getModelRegistry: () => this.runtimeModels(),
      getContext: () => {
        if (!this.store) return;
        const seconds = this.hasBoundVideo() ? this.video?.currentTime : undefined;
        const time = seconds === undefined ? undefined : spatialReplayTimeAt(this.replayDevice()?.track || [], seconds);
        return { dataset: this.store.dataset, state: { ...this.store.state, time: time ?? this.store.state.time },
          ...(time === undefined ? {} : { mediaId: this.selectedMedia, mediaSeconds: seconds }) };
      },
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
      for (const event of ["play", "pause", "ended", "loadedmetadata", "durationchange", "seeked", "error"]) video.addEventListener(event, () => {
        if (!this.active) return;
        if (event === "error") this.dashboard.setVideoStatus("原片暂不能解码，可在视频 AR 设置中检查媒体格式。");
        else {
          this.store?.patch({ playing: this.hasBoundVideo() && !video.paused && !video.ended });
          this.updateVideoStatus();
        }
      }, { signal: this.events.signal });
    }
  }

  get isOpen(): boolean { return this.active; }

  async open(): Promise<void> {
    if (this.disposed || this.active) return;
    this.active = true;
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
    this.pause();
    this.store?.patch({ cruise: false });
    this.active = false;
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
    const controller = this.loading = new AbortController();
    this.dashboard.setLoading("正在读取工程资料与巡检数据…");
    try {
      const [loadedDataset, models, events] = await Promise.all([
        this.adapter.load(controller.signal),
        new SafetySpatialRepository().loadModels().catch(() => [] as ModelRegistryEntry[]),
        this.eventRepository.load().catch(error => { this.eventServiceError = error instanceof Error ? error.message : "事件服务暂不可用"; return undefined; }),
      ]);
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
      if (this.active && !preserveSelection) this.effects.focus(this.store.view.selected);
    } catch (error) {
      if (!controller.signal.aborted) this.dashboard.setError(error instanceof Error ? error.message : "巡检数据读取失败");
    } finally { if (this.loading === controller) this.reloading = false; }
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
    this.pause();
    const target = this.store.dataset.nodes.find(n => n.id === selection.nodeId);
    const page: SafetyPage = selection.alertId || target?.eventId ? "events" : target && !target.spatialObjectId && (target.kind === "pier" || target.kind === "component") ? "components" : this.store.state.page || "overview";
    this.dashboard.setPage(page);
    this.store.patch({ page, cruise: false, engineeringAnnotations: false });
    this.store.select(selection);
    if (selection.fly !== false && !this.store.view.selected.navigationDisabledReason && this.store.view.selected.sceneAvailable !== false) this.effects.focus(this.store.view.selected);
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
    const seeks = patch.time !== undefined || patch.timeRange !== undefined;
    if (seeks) this.pause();
    this.store.patch(seeks ? { ...patch, playing: false } : patch);
    if (seeks) this.seekVideo(this.store.state.time);
    if (patch.playing === false) this.pause();
    if (patch.playing === true && this.inspectionMode !== "live") {
      if (this.hasReplayTrack() && this.store.state.time >= this.store.state.timeRange[1] - 100) {
        this.store.patch({ time: this.store.state.timeRange[0] }); this.seekVideo(this.store.state.time);
      } else if (this.hasBoundVideo() && !this.hasReplayTrack() && (this.video!.ended || this.video!.currentTime >= this.video!.duration - .05)) {
        this.video!.currentTime = 0;
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
      && this.video?.currentSrc && this.video.readyState >= 1);
  }

  /** An untracked video's elapsed seconds never become a scene timestamp or a measured flight position. */
  private seekMediaSeconds(seconds: number): void {
    if (!this.hasBoundVideo() || this.hasReplayTrack() || !Number.isFinite(seconds) || !Number.isFinite(this.video!.duration)) return;
    this.pause();
    this.video!.currentTime = Math.max(0, Math.min(this.video!.duration, seconds));
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
    if (!bound || synchronized) {
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
    this.dashboard.videoHost.append(video);
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
    const media = this.store.dataset.media.find(m => m.id === this.selectedMedia);
    const available = this.inspectionMode === "replay" && !this.mediaLoading && this.hasBoundVideo();
    if (this.video && this.videoOrigin) this.video.hidden = !available;
    const associated = this.store.view.media.some(m => m.id === this.selectedMedia);
    const relation = this.store.view.selected.kind !== "project" && !associated ? "项目来源 · 未与当前对象关联" : media?.relation === "object" ? "对象关联视频" : "项目视频";
    this.dashboard.setVideoStatus(this.mediaLoading ? "正在加载原片…" : available ? `${relation} · ${this.hasReplayTrack() ? "已关联真实航迹" : "未关联航迹，按视频进度播放"}` : this.inspectionMode === "live" ? "暂无可用实时画面" : "暂无可用画面");
    this.dashboard.setMediaState({ selectedId: this.selectedMedia, mode: this.inspectionMode, canPlay: available, playing: available && !this.video!.paused,
      currentTimeSeconds: available ? this.video!.currentTime : undefined, durationSeconds: available && Number.isFinite(this.video!.duration) ? this.video!.duration : undefined,
      rate: this.video?.playbackRate || 1, hasTrack: this.hasReplayTrack(),
      error: this.video?.error ? "画面暂不可用，请重试或切换来源" : undefined });
  }

  private async openMedia(media: SafetyMedia, selection?: SafetySelection): Promise<void> {
    if (media.kind !== "video") return; // Drawing/photo viewer is owned by the V3 dashboard.
    this.pause(); this.inspectionMode = "replay";
    const retained = selection || (this.store ? { nodeId: this.store.state.selectedId, alertId: this.store.state.selectedAlertId } : undefined);
    if (media.sourceRecordId && media.sourceRecordId !== this.options.getPlaybackSource().recordId) {
      if (!this.options.loadVideoSource) throw new Error("当前来源暂不可用，请在原工作台选择已有视频");
      this.mediaLoading = true; this.updateVideoStatus();
      try { await this.options.loadVideoSource(media.sourceRecordId); await this.reload(true); }
      finally { this.mediaLoading = false; this.updateVideoStatus(); }
    }
    this.selectedMedia = media.id; this.explicitlySelectedMedia = media.id;
    const source = this.options.getPlaybackSource();
    this.boundSourceKey = media.sourceRecordId === source.recordId && media.name === source.name && source.url ? this.playbackSourceKey() : "";
    if (retained && this.store?.dataset.nodes.some(n => n.id === retained.nodeId)) this.store.patch({ selectedId: retained.nodeId, selectedAlertId: retained.alertId });
    this.updateVideoStatus();
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
    this.pause();
    this.pageSelections.delete("overview");
    this.dashboard.setPage("overview");
    this.store.patch({ page: "overview", mode: "presentation", selectedId: this.store.dataset.projectId, selectedAlertId: undefined, cruise: false });
    this.effects.focus(this.store.view.selected);
  }

  private changePage(page: SafetyPage): boolean {
    if (!this.store) return true;
    return this.spatial.requestClose(() => { if (page === "overview") this.returnOverview(); else { this.applyPageChange(page); this.dashboard.setPage(page); } });
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
      videoElements: document.querySelectorAll("video").length, spatial: this.spatial.debugStats(), models: this.modelRegistry.map(({assetId,assetVersion,coordinateTransformVersion})=>({assetId,assetVersion,coordinateTransformVersion})), events: { revision: this.eventSnapshot.revision, count: this.eventSnapshot.events.length, error: this.eventServiceError }, effects: this.effects.debugStats(), ui: this.dashboard.debugStats(),
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
    this.store?.dispose(); this.spatial.dispose(); this.effects.dispose(); this.dashboard.dispose(); this.mediaDialog.remove();
    this.restoreTags();
  }
}
