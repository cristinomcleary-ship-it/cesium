import * as Cesium from "cesium";
import { createVideoRoam, type VideoRoamController, type VideoRoamRuntimeStatus } from "./presentationV5/video-roam.js";
import { adaptSafetyVideoRoam, loadSafetyVideoRoamSource, type SafetyVideoRoamData } from "./safetyVideoRoamData.ts";

export type SafetyVideoRoamState = {
  available: boolean; enabled: boolean; active: boolean; state: string; label: string; message: string;
  missing: string[]; mode: "path" | "camera"; userWantsFollow: boolean;
  mediaTime?: number; telemetryTimeMs?: number;
};
export type SafetyVideoRoamBinding = {
  mediaId: string; sourceRecordId: string; sourceUrl: string; generation: number; mediaName: string; reducedMotion: boolean;
};
export type SafetyVideoRoamOptions = {
  viewer: Cesium.Viewer; video: HTMLVideoElement; onState: (state: SafetyVideoRoamState) => void;
  canTakeCamera: () => boolean; beforeTakeCamera?: () => void;
  onPreferenceChange?: (enabled: boolean) => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  loadSource?: typeof loadSafetyVideoRoamSource;
};
const PREFERENCE_KEY = "cesium-safety-video-roam-v5";

/** Host lifecycle/policy around the supplied V5 runtime. The actual HTML video's
 * media clock is the sole camera clock; this class never starts a Cesium clock. */
export class SafetyVideoRoam {
  private binding?: SafetyVideoRoamBinding;
  private key = "";
  private controller?: VideoRoamController;
  private runtime?: VideoRoamRuntimeStatus;
  private source?: Awaited<ReturnType<typeof loadSafetyVideoRoamSource>>;
  private data?: SafetyVideoRoamData;
  private loading?: AbortController;
  private events?: AbortController;
  private loadPromise?: Promise<void>;
  private preference?: boolean;
  private reducedMotion = false;
  private trackVisible = true;
  private markerVisible = true;
  private explicitlyEnabled = false;
  private suppressPreference = false;
  private detaching = false;
  private disposed = false;
  private storage?: Pick<Storage, "getItem" | "setItem">;
  private message = "选择录像后核验同录像航迹。";
  private state = "unbound";

  constructor(private readonly options: SafetyVideoRoamOptions) {
    try { this.storage = options.storage ?? globalThis.localStorage; } catch { /* Preferences are optional in restricted storage contexts. */ }
    try { const saved = this.storage?.getItem(PREFERENCE_KEY); if (saved === "true" || saved === "false") this.preference = saved === "true"; } catch { /* Preserve session preference. */ }

  }

  private attachMediaEvents(): void {
    this.events = new AbortController();
    const listen = (type: string, handler: () => void) => this.options.video.addEventListener(type, handler, { signal: this.events!.signal });
    listen("loadedmetadata", () => this.tryCreate());
    listen("play", () => this.startIfWanted());
    // Source unload invalidates ALL old media listeners before a replacement binds.
    listen("emptied", () => this.sourceInvalidated());
    listen("loadstart", () => this.sourceInvalidated());
  }

  bind(input: SafetyVideoRoamBinding): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const key = JSON.stringify([input.mediaId, input.sourceRecordId, input.sourceUrl, input.generation, input.mediaName]);
    this.setReducedMotion(input.reducedMotion);
    if (key === this.key) return this.loadPromise ?? Promise.resolve();
    this.detach(); this.binding = { ...input }; this.key = key; this.attachMediaEvents();
    this.state = "loading"; this.message = "正在核验录像来源、媒体时间与高程基准…"; this.publish();
    const abort = this.loading = new AbortController();
    this.loadPromise = (this.options.loadSource ?? loadSafetyVideoRoamSource)(input.sourceRecordId, abort.signal).then(source => {
      if (abort.signal.aborted || this.disposed || this.key !== key) return;
      this.source = source; this.tryCreate();
    }).catch(error => {
      if (abort.signal.aborted || this.disposed || this.key !== key) return;
      this.state = "unavailable"; this.message = error instanceof Error ? error.message : "航迹资料读取失败，视频仍可独立播放。"; this.publish();
    });
    return this.loadPromise;
  }

  private boundSourceMatches(): boolean {
    const video = this.options.video, source = video.currentSrc || video.src;
    return !!this.binding?.sourceUrl && source === this.binding.sourceUrl && this.binding.mediaId === `video:${this.binding.sourceRecordId}`;
  }

  private tryCreate(): void {
    if (this.disposed || !this.binding || !this.source || this.controller) return;
    const video = this.options.video;
    if (!this.boundSourceMatches()) {
      this.state = "unavailable"; this.message = "当前播放器源与选定录像不一致，不能沿用旧航迹。"; this.publish(); return;
    }
    if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) {
      this.state = "waiting-metadata"; this.message = "等待原片元数据，以核验录像时长与尺寸。"; this.publish(); return;
    }
    this.data = adaptSafetyVideoRoam(this.source.record, this.source.raw, { name: this.binding.mediaName,
      sizeBytes: this.source.sizeBytes, width: video.videoWidth, height: video.videoHeight, durationSeconds: video.duration }, this.binding.mediaId);
    if (!this.data.available || !this.data.track) {
      this.state = "unavailable"; this.message = this.data.audit.missing.join("；"); this.publish(); return;
    }
    const created = createVideoRoam({ Cesium, viewer: this.options.viewer, videoElement: video, videoId: this.binding.mediaId,
      track: this.data.track, followMode: "path", maxGapSeconds: this.data.maxGapSeconds, maxSegmentMeters: this.data.maxSegmentMeters,
      showTrack: true, showMarker: true, onStatus: status => this.acceptRuntime(status) });
    if (!created.ok) { this.state = "unavailable"; this.message = created.status.message; this.publish(); return; }
    this.controller = created.controller;
    this.controller.setVisibility({ track: this.trackVisible, marker: this.markerVisible });
    this.state = "ready"; this.message = this.reducedMotion ? "减少动态已开启；可手动选择航迹跟随。"
      : this.preference === false ? "已退出跟随；可点击视频漫游重新跟随。" : "播放录像后自动沿航迹跟随，拖动模型退出。";
    this.publish(); if (!video.paused && !video.ended) this.startIfWanted();
  }

  private acceptRuntime(status: VideoRoamRuntimeStatus): void {
    if (this.detaching) return;
    this.runtime = status; this.state = status.state; this.message = status.message;
    if (!this.suppressPreference && (status.code || status.state === "user-interrupted")) {
      this.explicitlyEnabled = false; this.remember(false);
    }
    this.publish();
  }

  private remember(value: boolean): void {
    if (this.preference === value) return;
    this.preference = value;
    try { this.storage?.setItem(PREFERENCE_KEY, String(value)); } catch { /* Session still remembers free view. */ }
    this.options.onPreferenceChange?.(value);
  }

  private startIfWanted(): void {
    if (this.disposed || !this.controller || this.controller.getState().enabled || this.preference === false
      || (this.reducedMotion && !this.explicitlyEnabled) || !this.boundSourceMatches()) return;
    this.takeCamera();
  }

  private takeCamera(): void {
    if (!this.controller || !this.boundSourceMatches()) return;
    if (!this.options.canTakeCamera()) {
      this.remember(false); this.explicitlyEnabled = false; this.controller.stop();
      this.state = "camera-busy"; this.message = "当前场景操作占用相机，结束后可手动开启视频漫游。"; this.publish(); return;
    }
    this.options.beforeTakeCamera?.();
    this.controller.start();
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    if (!enabled) { this.beforeManualNavigation(); return; }
    if (!this.controller || !this.data?.available) { this.publish(); return; }
    this.explicitlyEnabled = true; this.remember(true); this.takeCamera();
  }

  /** Camera, track and marker use the runtime's same verified ECEF samples. */
  setLayerVisibility(track: boolean, marker: boolean): void {
    if (this.disposed || this.trackVisible === track && this.markerVisible === marker) return;
    this.trackVisible = track; this.markerVisible = marker;
    this.controller?.setVisibility({ track, marker });
  }

  setReducedMotion(reduced: boolean): void {
    if (this.disposed || this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    if (reduced && !this.explicitlyEnabled && this.controller?.getState().enabled) {
      this.suppressPreference = true;
      try { this.controller.stop(); } finally { this.suppressPreference = false; }
      this.message = "减少动态已开启；可手动选择航迹跟随。";
    }
    this.publish();
  }

  /** Call before home/focus/authoring/cruise; preserves current camera and video playback. */
  beforeManualNavigation(): void {
    // Initial overview/route setup must not turn an unseen roam into an explicit opt-out.
    if (this.disposed || !this.binding) return;
    this.explicitlyEnabled = false; this.remember(false); this.controller?.stop();
    if (this.controller) { this.state = "user-interrupted"; this.message = "已退出跟随，可自由观察；点击视频漫游重新跟随。"; }
    this.publish();
  }

  private sourceInvalidated(): void {
    if (!this.binding || this.disposed) return;
    this.remember(false); this.detach(); this.state = "source-changed";
    this.message = "录像源已改变，需重新核验对应航迹；视频可独立播放。"; this.publish();
  }

  private detach(): void {
    this.loading?.abort(); this.loading = undefined; this.loadPromise = undefined;
    this.events?.abort(); this.events = undefined;
    this.detaching = true;
    try { this.controller?.destroy(); } finally { this.detaching = false; }
    this.controller = undefined; this.runtime = undefined; this.source = undefined; this.data = undefined;
    this.binding = undefined; this.key = ""; this.explicitlyEnabled = false;
  }

  unbind(): void {
    this.detach(); this.state = "unbound"; this.message = "选择录像后核验同录像航迹。"; this.publish();
  }

  getState(): SafetyVideoRoamState {
    const runtime = this.runtime, mediaTime = runtime?.mediaTime;
    return { available: !!this.controller && !!this.data?.available && this.boundSourceMatches(),
      enabled: !!runtime?.enabled, active: !!runtime?.active, state: this.state,
      label: this.data?.available ? "航迹跟随 · 无相机姿态" : "未关联同录像航迹", message: this.message,
      missing: [...(this.data?.audit.missing || [])], mode: "path", userWantsFollow: this.preference ?? !this.reducedMotion,
      ...(typeof mediaTime === "number" ? { mediaTime } : {}),
      ...(typeof mediaTime === "number" && this.data?.audit.telemetryEpochAtMediaZeroMs !== undefined
        ? { telemetryTimeMs: this.data.audit.telemetryEpochAtMediaZeroMs + mediaTime * 1000 } : {}) };
  }

  debugStats(): Record<string, unknown> {
    return { ...this.getState(), disposed: this.disposed, bindingKey: this.key, audit: this.data?.audit,
      runtime: this.controller?.getState(), createdViewerCount: 0, businessGeometryWrites: 0,
      hostListenerCount: this.events ? 4 : 0, controlsOpticalCalibration: false };
  }

  private publish(): void { if (!this.detaching) this.options.onState(this.getState()); }

  dispose(): void {
    if (this.disposed) return;
    this.detach(); this.disposed = true; this.state = "destroyed";
    this.message = "视频漫游已解绑。"; this.publish();
  }
}
