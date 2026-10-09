/** Current-view rendering evidence only. This never modifies model transforms or data. */
export type ModelQualityPhase = "first-screen-loading" | "first-screen-usable" | "detail-loading" | "target-ready" | "partial-failure" | "not-visible" | "out-of-view";
export type ModelQualityState = {
  modelId: string; name: string; phase: ModelQualityPhase; label: string;
  quality: string; targetScreenSpaceError: number; appliedScreenSpaceError: number;
  /** Version-checked optional Cesium diagnostic; null means unavailable. */
  memoryAdjustedScreenSpaceError: number | null;
  pendingRequests: number; processingTiles: number; visibleTiles: number;
  firstScreenUsable: boolean; currentViewReady: boolean; viewRevision: number;
  firstUsableAfterMs: number | null; currentViewReadyAfterMs: number | null;
  failedTileCount: number; failures: Array<{ url: string; message: string }>;
  limitation: string; updatedAtMs: number;
};
type EventSource<T extends unknown[] = []> = { addEventListener(callback: (...args: T) => void): () => void };
export type QualityTileset = {
  show: boolean; tilesLoaded: boolean; maximumScreenSpaceError: number;
  memoryAdjustedScreenSpaceError?: number;
  isDestroyed(): boolean;
  loadProgress: EventSource<[number, number]>; initialTilesLoaded: EventSource; allTilesLoaded: EventSource;
  tileVisible: EventSource<[unknown]>; tileFailed: EventSource<[{ url?: string; message?: string }]>;
};
type QualityTrackerOptions = {
  modelId: string; name: string; tileset: QualityTileset;
  scene: { preRender: EventSource; postRender: EventSource };
  camera: { changed: EventSource<[number]>; moveStart: EventSource; moveEnd: EventSource };
  quality: string; targetScreenSpaceError: number; initialCoarse?: boolean;
  onInitialReady?: () => void; onChange?: (state: ModelQualityState) => void; now?: () => number;
};
const labels: Record<ModelQualityPhase, string> = {
  "first-screen-loading": "首屏加载中", "first-screen-usable": "首屏可用 · 正在细化",
  "detail-loading": "细节加载中", "target-ready": "当前视角目标质量就绪",
  "partial-failure": "部分瓦片失败", "not-visible": "图层已隐藏", "out-of-view": "当前视角未见工程网格",
};
const limitation = "状态只说明当前可见网格的瓦片加载；源网格细节、源纹理分辨率和视频 AR 纹理清晰度需分别检查，未完成工程精度验收。";

/** A single listener group per imported tileset; no timers or animation loops. */
export class ModelQualityTracker {
  private removers: Array<() => void> = [];
  private disposed = false;
  private visibleThisFrame = 0;
  private frameViewRevision = -1;
  private frameScreenSpaceError = Infinity;
  private rendered = false;
  private moving = false;
  private initialCoarse: boolean;
  private initialHandled = false;
  private readonly now: () => number;
  private readonly startedAt: number;
  private viewStartedAt: number;
  private state: ModelQualityState;
  private signature = "";
  constructor(private readonly options: QualityTrackerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.viewStartedAt = this.now(); this.initialCoarse = !!options.initialCoarse;
    this.state = { modelId: options.modelId, name: options.name, phase: "first-screen-loading", label: labels["first-screen-loading"],
      quality: options.quality, targetScreenSpaceError: options.targetScreenSpaceError, appliedScreenSpaceError: options.tileset.maximumScreenSpaceError,
      memoryAdjustedScreenSpaceError: null, pendingRequests: 0, processingTiles: 0, visibleTiles: 0,
      firstScreenUsable: false, currentViewReady: false, viewRevision: 0, firstUsableAfterMs: null, currentViewReadyAfterMs: null,
      failedTileCount: 0, failures: [], limitation, updatedAtMs: this.startedAt };
    const t = options.tileset;
    this.removers.push(
      options.scene.preRender.addEventListener(() => { this.visibleThisFrame = 0; this.frameViewRevision = this.state.viewRevision; this.frameScreenSpaceError = t.maximumScreenSpaceError; }),
      t.tileVisible.addEventListener(() => { this.visibleThisFrame += 1; }),
      options.scene.postRender.addEventListener(() => this.afterRender()),
      t.loadProgress.addEventListener((pending, processing) => {
        this.state.pendingRequests = pending; this.state.processingTiles = processing;
        if (pending || processing) this.state.currentViewReady = false;
        this.publish();
      }),
      t.initialTilesLoaded.addEventListener(() => {
        if (this.initialHandled) return; this.initialHandled = true;
        if (this.initialCoarse) { this.initialCoarse = false; options.onInitialReady?.(); this.invalidateView(); }
      }),
      // allTilesLoaded also occurs for a view with no geometry. Only postRender + tileVisible can mark ready.
      t.allTilesLoaded.addEventListener(() => { if (!t.tilesLoaded) this.state.currentViewReady = false; }),
      t.tileFailed.addEventListener(failure => {
        this.state.failedTileCount += 1;
        const entry = { url: String(failure.url ?? ""), message: String(failure.message ?? "瓦片读取失败") };
        if (this.state.failures.length < 20 && !this.state.failures.some(f => f.url === entry.url && f.message === entry.message)) this.state.failures.push(entry);
        this.state.currentViewReady = false; this.publish();
      }),
      options.camera.moveStart.addEventListener(() => { this.moving = true; this.invalidateView(); }),
      options.camera.changed.addEventListener(() => this.invalidateView()),
      options.camera.moveEnd.addEventListener(() => { this.moving = false; this.invalidateView(); }),
    );
    this.publish();
  }
  /** Call after explicit preset changes; source geometry and coordinates stay untouched. */
  setTarget(quality: string, targetScreenSpaceError: number): void {
    if (!Number.isFinite(targetScreenSpaceError) || targetScreenSpaceError <= 0) throw new Error("Invalid target screen-space error");
    this.state.quality = quality; this.state.targetScreenSpaceError = targetScreenSpaceError;
    this.initialCoarse = false; this.invalidateView();
  }
  invalidateView(): void {
    if (this.disposed) return;
    this.state.viewRevision += 1; this.viewStartedAt = this.now();
    this.state.currentViewReady = false; this.state.currentViewReadyAfterMs = null;
    this.state.visibleTiles = 0; this.rendered = false; this.publish();
  }
  private afterRender(): void {
    if (this.disposed) return;
    const t = this.options.tileset;
    if (t.isDestroyed()) { this.dispose(); return; }
    this.rendered = true; this.state.visibleTiles = this.visibleThisFrame;
    this.state.appliedScreenSpaceError = t.maximumScreenSpaceError;
    this.state.memoryAdjustedScreenSpaceError = typeof t.memoryAdjustedScreenSpaceError === "number" && Number.isFinite(t.memoryAdjustedScreenSpaceError)
      ? t.memoryAdjustedScreenSpaceError : null;
    if (t.show && this.visibleThisFrame > 0 && !this.state.firstScreenUsable) {
      this.state.firstScreenUsable = true; this.state.firstUsableAfterMs = this.now() - this.startedAt;
    }
    const actualSse = Math.max(t.maximumScreenSpaceError, this.state.memoryAdjustedScreenSpaceError ?? t.maximumScreenSpaceError);
    this.state.currentViewReady = t.show && this.visibleThisFrame > 0 && !this.initialCoarse && !this.moving && t.tilesLoaded
      && this.state.pendingRequests === 0 && this.state.processingTiles === 0 && this.state.failedTileCount === 0
      && this.frameViewRevision === this.state.viewRevision && this.frameScreenSpaceError <= this.state.targetScreenSpaceError + 1e-6
      && actualSse <= this.state.targetScreenSpaceError + 1e-6;
    if (this.state.currentViewReady && this.state.currentViewReadyAfterMs === null) this.state.currentViewReadyAfterMs = this.now() - this.viewStartedAt;
    if (!this.state.currentViewReady) this.state.currentViewReadyAfterMs = null;
    this.publish();
  }
  private publish(): void {
    if (this.disposed) return;
    const t = this.options.tileset;
    if (t.isDestroyed()) { this.dispose(); return; }
    const phase: ModelQualityPhase = !t.show ? "not-visible" : this.state.failedTileCount ? "partial-failure"
      : this.state.currentViewReady ? "target-ready"
      : !this.state.firstScreenUsable ? "first-screen-loading"
      : this.initialCoarse ? "first-screen-usable"
      : this.rendered && this.state.visibleTiles === 0 && !this.state.pendingRequests && !this.state.processingTiles ? "out-of-view" : "detail-loading";
    this.state.phase = phase; this.state.label = labels[phase];
    const signature = JSON.stringify({ ...this.state, updatedAtMs: 0 });
    if (signature !== this.signature) { this.signature = signature; this.state.updatedAtMs = this.now(); this.options.onChange?.(this.getState()); }
  }
  getState(): ModelQualityState { return structuredClone(this.state); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const remove of this.removers.splice(0)) remove(); }
}
