import { type Viewer } from "cesium";
import { SafetySpatialEditor } from "./safetySpatialEditor";
import { mergeSpatialDataset, spatialReplayTimeAt } from "./safetySpatialData";
import type { SpatialSnapshot } from "./safetySpatialTypes";
import { LocalSafetyDataAdapter } from "./safetyData";
import { SafetyDashboard } from "./safetyDashboard";
import { SafetySceneEffects } from "./safetySceneEffects";
import { SafetyStore, deriveSafetyView } from "./safetyStore";
import type { SafetyDataAdapter, SafetyDataset, SafetyDevice, SafetyMedia, SafetySelection, SafetyState } from "./safetyTypes";
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
  adapter?: SafetyDataAdapter;
};

/** Shared navigation/data clock. The existing Viewer, video decoder and library remain the owners of their resources. */
export class SafetyWorkspace {
  readonly dashboard: SafetyDashboard;
  readonly effects: SafetySceneEffects;
  readonly spatial: SafetySpatialEditor;
  private baseDataset?: SafetyDataset;
  private reloading = false;
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
  private boundSourceKey = "";
  private readonly validReplayTracks = new WeakMap<SafetyDevice, boolean>();
  private readonly mediaDialog = document.createElement("dialog");
  private readonly pageWasHidden = () => { if (this.active && document.hidden) this.pause(); };

  constructor(private readonly options: SafetyWorkspaceOptions) {
    this.adapter = options.adapter ?? new LocalSafetyDataAdapter();
    this.dashboard = new SafetyDashboard(options.host, {
      onSelect: selection => this.select(selection), onPatch: patch => this.patch(patch),
      onExit: () => this.close(), onEarth: () => { this.store?.patch({ cruise: false }); this.effects.earth(); },
      onMedia: media => this.openMedia(media), onRefresh: () => void this.reload(),
      onLayerToggle: (id, visible) => { options.setLayerVisible(id, visible); this.layersChanged(); },
      onVideoSettings: () => { this.close(); options.openVideoSettings(); },
      onAuthoring: () => this.spatial.show(),
    });
    this.effects = new SafetySceneEffects(options.viewer, selection => this.select(selection), { getImports: options.getImports,
      getStageRect: () => { const r = options.host.querySelector(".safety-scene-hud")?.getBoundingClientRect(); const c = options.viewer.canvas.getBoundingClientRect(); return r ? { left: r.left - c.left, top: r.top - c.top + 76, width: r.width, height: Math.max(180, r.height - 174) } : { left: 368, top: 180, width: Math.max(300, c.width - 736), height: Math.max(240, c.height - 380) }; }
    });
    this.spatial = new SafetySpatialEditor({ viewer: options.viewer, host: options.host,
      onSnapshot: snapshot => this.applySpatialSnapshot(snapshot),
      suspendOverlays: () => this.effects.suspendOverlaysForPicking(),
      onSelect: id => { const nodeId = `spatial:${id}`; const alert = this.store?.dataset.alerts.find(a => a.nodeId === nodeId); this.select({ nodeId, alertId: alert?.id }); },
      onDrawing: drawing => { this.effects.setPickingEnabled(!drawing); if (drawing) this.store?.patch({ cruise: false, mode: "inspection" }); },
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
      for (const event of ["play", "pause", "ended", "loadedmetadata", "error"]) video.addEventListener(event, () => {
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
    if (this.store) this.effects.focus(this.store.view.selected);
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

  async reload(): Promise<void> {
    if (this.disposed) return;
    this.loading?.abort();
    this.reloading = true;
    const controller = this.loading = new AbortController();
    this.dashboard.setLoading("正在读取工程资料与巡检数据…");
    try {
      const baseDataset = await this.adapter.load(controller.signal);
      if (controller.signal.aborted || this.disposed) return;
      this.baseDataset = baseDataset;
      let spatial = this.spatial.getSnapshot();
      try { spatial = await this.spatial.load(); } catch (error) { this.baseDataset = { ...this.baseDataset, missingData: [...this.baseDataset.missingData, `空间对象读取失败：${error instanceof Error ? error.message : "未知错误"}`] }; }
      const dataset = mergeSpatialDataset(this.baseDataset, spatial);
      if (controller.signal.aborted || this.disposed) return;
      this.pause();
      this.effects.setDataset(dataset);
      if (this.store) this.store.setDataset(dataset);
      else {
        this.store = new SafetyStore(dataset);
        this.unsubscribe = this.store.subscribe(() => this.renderState());
      }
      this.effects.setActive(this.active);
      this.selectedMedia = dataset.devices.find(d => d.mediaId)?.mediaId;
      const media = dataset.media.find(m => m.id === this.selectedMedia);
      const source = this.options.getPlaybackSource();
      this.boundSourceKey = media?.sourceRecordId === source.recordId && media?.name === source.name && source.url ? this.playbackSourceKey() : "";
      this.dashboard.setLoading("");
      this.layersChanged();
      this.renderState();
      this.updateVideoStatus();
      if (this.active) this.effects.focus(this.store.view.selected);
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
    if (!this.active || !this.store || this.store.dataset.nodes.find(n => n.id === selection.nodeId)?.navigationDisabledReason) return;
    this.pause();
    this.store.patch({ cruise: false, engineeringAnnotations: false });
    this.store.select(selection);
    if (selection.fly !== false) this.effects.focus(this.store.view.selected);
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
    if (patch.mode === "presentation" && this.spatial.isDrawing) patch = { ...patch, mode: "inspection" };
    const seeks = patch.time !== undefined || patch.timeRange !== undefined;
    if (seeks) this.pause();
    this.store.patch(seeks ? { ...patch, playing: false } : patch);
    if (seeks) this.seekVideo(this.store.state.time);
    if (patch.playing === false) this.pause();
    if (patch.playing === true) {
      if (this.store.state.time >= this.store.state.timeRange[1] - 100) {
        this.store.patch({ time: this.store.state.timeRange[0] }); this.seekVideo(this.store.state.time);
      }
      if (this.hasBoundVideo()) void this.video!.play().catch(() => {
        this.store?.patch({ playing: false }); this.dashboard.setVideoStatus("浏览器未开始播放，请点击视频内播放按钮。");
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

  private hasBoundVideo(): boolean {
    const media = this.store?.dataset.media.find(m => m.id === this.selectedMedia);
    const source = this.options.getPlaybackSource(), device = this.replayDevice();
    if (device && !this.validReplayTracks.has(device)) this.validReplayTracks.set(device, device.track.every((p, i, points) =>
      Number.isFinite(p.time) && Number.isFinite(p.mediaSeconds) && (i === 0 || (p.time > points[i - 1].time && p.mediaSeconds > points[i - 1].mediaSeconds))));
    return !!(this.store?.view.media.some(m => m.id === this.selectedMedia) && this.boundSourceKey && this.boundSourceKey === this.playbackSourceKey() && media?.provenance === "real"
      && media.sourceRecordId === source.recordId && media.name === source.name && device && this.validReplayTracks.get(device)
      && this.video?.currentSrc && this.video.readyState >= 1);
  }

  /** Time interpolation is independent of position: a telemetry gap may still contain valid video frames. */
  private mapReplayTime(value: number, from: "time" | "mediaSeconds"): number | undefined {
    const track = this.replayDevice()?.track;
    if (!track?.length) return;
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
    if (this.hasBoundVideo() && !this.video!.paused) time = this.mapReplayTime(this.video!.currentTime, "mediaSeconds") ?? time;
    else if (this.store.state.playing) time += delta;
    if (time >= this.store.state.timeRange[1]) { this.pause(); time = this.store.state.timeRange[1]; this.seekVideo(time); }
    if (time < this.store.state.timeRange[0]) { time = this.store.state.timeRange[0]; this.seekVideo(time); }
    this.replayTime = time;
    if (now - this.lastStateTick >= 100 && Math.abs(time - this.store.state.time) > 8) {
      this.lastStateTick = now; this.store.patch({ time });
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
    video.hidden = false; video.controls = true;
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
    const media = this.store.view.media.find(m => m.id === this.selectedMedia);
    if (this.video && this.videoOrigin) this.video.hidden = !this.hasBoundVideo();
    if (this.hasBoundVideo()) this.dashboard.setVideoStatus(`${media?.name ?? "项目原始视频"} · 共用原播放器 · 项目关联素材`);
    else this.dashboard.setVideoStatus("暂无可播放的关联原片；可查看构件资料或进入视频 AR 设置。");
  }

  private openMedia(media: SafetyMedia): void {
    if (media.kind === "video") { this.pause(); this.selectedMedia = media.id; this.updateVideoStatus(); this.dashboard.videoHost.scrollIntoView({ block: "nearest" }); return; }
    if (!/^(\/[^/]|https?:\/\/)/i.test(media.url)) return;
    if (media.kind === "photo") {
      this.mediaDialog.replaceChildren();
      const close = document.createElement("button"); close.textContent = "关闭照片"; close.onclick = () => this.mediaDialog.close();
      const caption = document.createElement("p"); caption.textContent = `${media.name} · ${media.note}`;
      const image = document.createElement("img"); image.src = media.url; image.alt = media.name;
      this.mediaDialog.append(close, image, caption); this.mediaDialog.showModal();
    } else {
      const link = document.createElement("a"); link.href = media.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.download = media.name; link.click();
    }
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
    const dataset = mergeSpatialDataset(this.baseDataset, snapshot);
    this.effects.setDataset(dataset); this.store.setDataset(dataset); this.renderState();
  }

  debugStats(): Record<string, unknown> {
    return { active: this.active, clockListeners: Number(!!this.removeClock), viewerCount: document.querySelectorAll("#cesiumContainer canvas").length,
      videoElements: document.querySelectorAll("video").length, spatial: this.spatial.debugStats(), effects: this.effects.debugStats(), ui: this.dashboard.debugStats(),
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
