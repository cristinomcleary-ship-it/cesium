import { Cartesian2, Cartesian3, Cartesian4, Color, Matrix4, PerspectiveFrustum, PostProcessStage, SceneMode, Transforms, type Viewer } from 'cesium';
import { createCcCameraTrack, parseCcCameraXml, type CcCameraDataset, type CcCameraTrack, type CcTrackOptions } from './ccCameraTrack';
import { VideoOverlayResources, type VideoOverlayAdjustment } from './videoOverlayResources';
import { containVideoRect, overlayLensBounds, OVERLAY_LENS_SHADER } from './videoOverlayLens';
import type { LibraryRecord } from './projectLibrary';
import type { ImportRecord } from './types';
import './videoModelOverlay.css';

export type SavedVideoOverlaySettings = {
  mode: 'cc-overlay'; version: 1; timing: CcTrackOptions; selectedIds: string[];
  adjustments: Record<string, VideoOverlayAdjustment>; opacity: number; currentTime: number;
  videoName: string; videoSize: number; width: number; height: number;
};
type Options = {
  getImports: () => readonly ImportRecord[]; getRecord: (id: string) => LibraryRecord | undefined;
  notify: (message: string, error?: boolean) => void; onEnter?: () => void; onExit?: () => void;
};
type Visible = { show: boolean; isDestroyed?: () => boolean };
const zero = (): VideoOverlayAdjustment => ({ east: 0, north: 0, up: 0, heading: 0 });
const v3 = (v: { x: number; y: number; z: number }) => new Cartesian3(v.x, v.y, v.z);
const clock = (v: number) => Number.isFinite(v) ? `${Math.floor(v / 60)}:${(v % 60).toFixed(2).padStart(5, '0')}` : '--:--';

export const videoModelOverlayPanelHtml = `
<section class="panel cc-overlay-panel" data-panel="videoar">
  <h2>视频 AR · 工程叠加</h2><p class="cc-hint">导入原视频与同源 CC 空三结果，将已定位的 CAD、工程模型叠加到实景视频。</p>
  <label>航拍视频<input id="ccVideoFile" type="file" accept="video/*,.mp4,.mov,.webm"></label>
  <label>CC 空三 XML<input id="ccXmlFile" type="file" accept=".xml"></label>
  <div id="ccOverlayInfo" role="status">选择视频与 CC 空三 XML，无需 SRT。</div>
  <details open><summary>抽帧时间与高度</summary>
    <div class="cc-fields"><label>首张照片时间（秒）<input id="ccFirstTime" type="number" min="0" step="0.001" value="0"></label><label>抽帧间隔（秒）<input id="ccInterval" type="number" min="0.001" step="any" placeholder="按实际抽帧设置"></label></div>
    <label>照片编号规则<select id="ccTimeMode"><option value="filename-number">按文件末尾编号关联（保留跳号）</option><option value="ordinal">XML 内照片按顺序等间隔</option></select></label>
    <label>每个间隔增加的编号<input id="ccFilenameStep" type="number" min="1" step="1" value="1"></label>
    <small>例如每隔 2 秒一张且编号为 0、60、120：间隔填 2，编号增量填 60。仅对等间隔抽帧适用。</small>
    <label>空三高程<select id="ccHeightReference"><option value="">请选择高度基准</option><option value="ellipsoid">已是 WGS84 椭球高</option><option value="offset-to-ellipsoid">按已知高差换算到椭球高</option></select></label>
    <label>加到 XML 高度的高差（米）<input id="ccHeightOffset" type="number" step="any" value="0"></label>
  </details>
  <div class="cc-actions"><button id="ccStart" class="primary" type="button">开始融合</button><button id="ccStop" type="button">返回地图</button></div>
  <h3>叠加对象</h3><div id="ccResources"><small>先在 CAD／工程模型中导入并定位对象。</small></div>
  <h3>位置微调</h3><label>调整范围<select id="ccTarget"><option value="*">勾选对象整体平移</option></select></label>
  <div class="cc-fields"><label>向东（米）<input id="ccEast" type="number" step="0.1" value="0"></label><label>向北（米）<input id="ccNorth" type="number" step="0.1" value="0"></label><label>升高（米）<input id="ccUp" type="number" step="0.1" value="0"></label><label>按钮步长（米）<input id="ccStep" type="number" min="0.001" step="any" value="0.1"></label></div>
  <div class="cc-nudges"><button data-cc-nudge="east:-1" type="button">向西</button><button data-cc-nudge="north:1" type="button">向北</button><button data-cc-nudge="up:1" type="button">升高</button><button data-cc-nudge="east:1" type="button">向东</button><button data-cc-nudge="north:-1" type="button">向南</button><button data-cc-nudge="up:-1" type="button">降低</button></div>
  <label>画面拖动<select id="ccDragMode"><option value="off">关闭</option><option value="horizontal">拖动平移所选对象</option><option value="vertical">拖动升降所选对象</option></select></label>
  <details><summary>单个对象方向微调</summary><label>顺时针旋转（度）<input id="ccHeading" type="number" step="0.1" value="0"></label><small>先在调整范围中选择一个对象。</small></details>
  <div class="cc-actions"><button id="ccUndo" type="button">撤销</button><button id="ccRedo" type="button">重做</button><button id="ccReset" type="button">恢复初始</button></div>
  <label>叠加透明度<input id="ccOpacity" type="range" min="0" max="1" step="0.01" value="0.8"></label>
  <small>位置微调对整段视频生效，保存在当前视频方案中。</small>
  <div class="cc-actions"><button id="ccSave" class="primary" type="button">保存融合方案</button></div><small id="ccSavedState">尚未保存</small>
</section>`;

export class VideoModelOverlay {
  onSave?: (snapshot: { name: string; files: Record<string, File>; settings: SavedVideoOverlaySettings }, existingId?: string) => Promise<string>;
  onSaved?: (recordId: string) => void;
  private video = document.createElement('video');
  private files: Record<string, File> = {};
  private savedId?: string;
  private dataset?: CcCameraDataset;
  private track?: CcCameraTrack;
  private timing?: CcTrackOptions;
  private resources?: VideoOverlayResources;
  private adjustments: Record<string, VideoOverlayAdjustment> = {};
  private selected = new Set<string>();
  private selectionInitialized = false;
  private groupValues = zero();
  private undo: Record<string, VideoOverlayAdjustment>[] = [];
  private redo: Record<string, VideoOverlayAdjustment>[] = [];
  private opacity = .8;
  private mediaUrl?: string;
  private videoFile?: File;
  private controller?: AbortController;
  private epoch = 0;
  private sessionGeneration = 0;
  private inputGeneration = 0;
  private editRevision = 0;
  private enterHooksActive = false;
  private mediaLoad?: { file: File; promise: Promise<void>; cancel: () => void };
  private restoreScene?: () => void;
  private backdrop?: HTMLDivElement;
  private controls?: HTMLDivElement;
  private badge?: HTMLDivElement;
  private frameHandle?: number;
  private animationHandle?: number;
  private lastFrameTime = 0;
  private seeking = false;
  private resize?: ResizeObserver;
  private disposers: (() => void)[] = [];
  private destroyed = false;
  private saving = false;
  private dragging?: { x: number; y: number; base: Record<string, VideoOverlayAdjustment>; right: Cartesian3; up: Cartesian3; meters: number; origin: Cartesian3; mode: string };
  private get container() { return this.viewer.container as HTMLElement; }
  get active() { return !!this.restoreScene; }

  constructor(private viewer: Viewer, private options: Options) {
    this.video.preload = 'auto'; this.video.muted = true; this.video.playsInline = true;
    this.bind('ccVideoFile', 'change', () => this.pickFile('video', this.el<HTMLInputElement>('ccVideoFile').files?.[0]));
    this.bind('ccXmlFile', 'change', () => this.pickFile('source', this.el<HTMLInputElement>('ccXmlFile').files?.[0]));
    this.bind('ccStart', 'click', () => { void this.enter().catch(e => this.fail(e)); });
    this.bind('ccStop', 'click', () => this.exit());
    this.bind('ccSave', 'click', () => { void this.save().catch(e => this.fail(e)); });
    this.bind('ccTarget', 'change', () => this.syncAdjustmentInputs());
    for (const id of ['ccFirstTime', 'ccInterval', 'ccTimeMode', 'ccFilenameStep', 'ccHeightReference', 'ccHeightOffset']) {
      this.bind(id, 'input', () => { ++this.inputGeneration; this.exit(); this.track = undefined; this.dirty(); });
    }
    for (const [id, key] of Object.entries({ ccEast: 'east', ccNorth: 'north', ccUp: 'up', ccHeading: 'heading' })) {
      this.bind(id, 'input', () => this.edit(key as keyof VideoOverlayAdjustment, this.number(id)));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cc-nudge]')) {
      const handler = () => { const [key, sign] = button.dataset.ccNudge!.split(':'); const id = { east: 'ccEast', north: 'ccNorth', up: 'ccUp' }[key]!;
        const step = this.number('ccStep'); if (!(step > 0)) return this.fail(new Error('步长必须大于 0'));
        this.el<HTMLInputElement>(id).value = String(this.number(id) + Number(sign) * step);
        this.edit(key as keyof VideoOverlayAdjustment, this.number(id)); };
      button.addEventListener('click', handler); this.disposers.push(() => button.removeEventListener('click', handler));
    }
    this.bind('ccUndo', 'click', () => this.history(false)); this.bind('ccRedo', 'click', () => this.history(true));
    this.bind('ccReset', 'click', () => { this.pushHistory(); for (const id of this.targetIds()) this.adjustments[id] = zero(); this.applyAdjustments(); this.syncAdjustmentInputs(); });
    this.bind('ccOpacity', 'input', () => { this.opacity = this.number('ccOpacity'); this.dirty(); this.viewer.scene.requestRender(); });
    this.bind('ccDragMode', 'change', () => { this.container.dataset.ccDrag = this.el<HTMLSelectElement>('ccDragMode').value; });
    this.listen(this.video, 'seeking', () => { this.seeking = true; this.resources?.setVisible(false); this.viewer.scene.requestRender(); });
    this.listen(this.video, 'seeked', () => { this.seeking = false; this.requestFrame(); if (!this.video.requestVideoFrameCallback) this.renderFrame(this.video.currentTime); });
    this.listen(this.video, 'play', () => { this.requestFrame(); this.updatePlayback(); });
    this.listen(this.video, 'pause', () => this.updatePlayback());
    this.listen(this.video, 'ended', () => this.updatePlayback());
    this.listen(this.video, 'error', () => { if (this.active) { this.exit(); this.fail(new Error('视频无法解码，请使用浏览器支持的 MP4/H.264 或 WebM')); } });
    this.listen(this.viewer.canvas, 'pointerdown', event => this.startDrag(event as PointerEvent));
    this.listen(this.viewer.canvas, 'pointermove', event => this.moveDrag(event as PointerEvent));
    this.listen(window, 'pointerup', () => { this.dragging = undefined; });
    this.listen(window, 'blur', () => { this.dragging = undefined; });
    this.listen(window, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape' && this.active) this.exit(); });
    this.refreshResources();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
  private listen(target: EventTarget, event: string, handler: EventListener) { target.addEventListener(event, handler); this.disposers.push(() => target.removeEventListener(event, handler)); }
  private bind(id: string, event: string, handler: () => void) { this.listen(this.el(id), event, handler); }
  private number(id: string) { const raw = this.el<HTMLInputElement>(id).value.trim(); return raw ? Number(raw) : NaN; }
  private fail(error: unknown) { if (error instanceof DOMException && error.name === 'AbortError') return; const message = error instanceof Error ? error.message : String(error); this.el('ccOverlayInfo').textContent = message; this.options.notify(message, true); }
  private dirty() { ++this.editRevision; this.el('ccSavedState').textContent = '有未保存的更改'; }
  private pickFile(slot: string, file?: File) {
    if (!file) return; ++this.sessionGeneration; ++this.inputGeneration; this.exit(); this.mediaLoad?.cancel(); this.files = { ...this.files, [slot]: file }; this.savedId = undefined; this.dataset = undefined; this.track = undefined;
    this.adjustments = {}; this.undo = []; this.redo = []; this.syncAdjustmentInputs(); this.dirty();
    this.el('ccOverlayInfo').textContent = Object.values(this.files).map(f => f.name).join(' · ');
  }
  private readTiming(): CcTrackOptions {
    const height = this.el<HTMLSelectElement>('ccHeightReference').value;
    if (height !== 'ellipsoid' && height !== 'offset-to-ellipsoid') throw new Error('请在“抽帧时间与高度”中选择空三高程基准');
    return { firstTimeSeconds: this.number('ccFirstTime'), intervalSeconds: this.number('ccInterval'), mode: this.el<HTMLSelectElement>('ccTimeMode').value as CcTrackOptions['mode'],
      filenameStep: this.number('ccFilenameStep'), heightReference: height, heightOffsetMeters: this.number('ccHeightOffset') };
  }
  private async loadMedia() {
    if (this.mediaLoad?.file === this.files.video) return this.mediaLoad.promise;
    if (this.videoFile === this.files.video && this.video.readyState >= 2) return;
    this.mediaLoad?.cancel(); this.seeking = false;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = URL.createObjectURL(this.files.video); this.videoFile = this.files.video;
    let cancel!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); this.video.removeEventListener('loadeddata', ok); this.video.removeEventListener('error', bad); };
      const ok = () => { clean(); resolve(); }, bad = () => { clean(); reject(new Error('视频无法读取，请使用浏览器支持的格式')); };
      const timer = window.setTimeout(() => { clean(); reject(new Error('视频读取超时，请重新选择原视频')); }, 20000);
      cancel = () => { clean(); reject(new DOMException('视频已切换', 'AbortError')); };
      this.video.addEventListener('loadeddata', ok); this.video.addEventListener('error', bad); this.video.src = this.mediaUrl!; this.video.load();
    });
    const load = { file: this.files.video, promise, cancel }; this.mediaLoad = load;
    try { await promise; } finally { if (this.mediaLoad === load) this.mediaLoad = undefined; }
  }
  private async prepare() {
    if (!this.files.video || !this.files.source) throw new Error('请选择原视频和同一视频的 CC 空三 XML');
    const generation = this.inputGeneration, timing = this.readTiming();
    const check = () => { if (generation !== this.inputGeneration || this.destroyed) throw new DOMException('融合输入已切换', 'AbortError'); };
    const dataset = this.dataset ?? parseCcCameraXml(await this.files.source.text()); check();
    const track = createCcCameraTrack(dataset, timing);
    if (Math.abs(track.intrinsics.skew) > 1e-8) throw new Error('当前叠加不支持非零相机 Skew，请使用无 skew 的 CC 相机标定');
    await this.loadMedia();
    check(); const k = track.intrinsics;
    if (Math.abs(this.video.videoWidth / this.video.videoHeight - k.width / k.height) > .001) throw new Error('视频与 CC 影像画幅比例不一致，请使用同源未裁切视频');
    if (!Number.isFinite(this.video.duration) || track.startTime > this.video.duration || track.endTime > this.video.duration + .1) throw new Error('空三时间超出视频，请检查首张时间、抽帧间隔和编号增量');
    this.dataset = dataset; this.timing = timing; this.track = track;
    this.el('ccOverlayInfo').textContent = `${dataset.photos.length} 张空三影像 · ${k.width} × ${k.height} · 覆盖 ${clock(track.startTime)}–${clock(track.endTime)}`;
  }
  async enter() {
    this.exit(); const epoch = ++this.epoch; this.el<HTMLButtonElement>('ccStart').disabled = true;
    try {
      await this.prepare(); if (epoch !== this.epoch || this.destroyed) return;
      if (this.viewer.scene.mode !== SceneMode.SCENE3D) throw new Error('请先切换到三维场景，再开始视频融合');
      this.enterHooksActive = true; this.options.onEnter?.();
      // Snapshot the normal map after other tools have relinquished the shared scene.
      this.captureScene();
      this.controller = new AbortController();
      const resources = await VideoOverlayResources.create({ viewer: this.viewer, imports: this.options.getImports, getRecord: this.options.getRecord, signal: this.controller.signal });
      if (epoch !== this.epoch || this.destroyed) { resources.restore(); return; }
      this.resources = resources;
      this.resources.applyAdjustments(this.adjustments); this.resources.setSelection([...this.selected]);
      this.mountStage(); this.installLens(); this.refreshResources();
      if (this.video.currentTime < this.track!.startTime || this.video.currentTime > this.track!.endTime) this.video.currentTime = this.track!.startTime;
      if (!this.video.seeking) this.renderFrame(this.video.currentTime);
      else this.resources?.setVisible(false);
      this.requestFrame();
      this.el('ccSavedState').textContent = this.savedId ? '已载入保存的融合方案' : '融合已开启，微调后可保存';
    } catch (error) { if (epoch === this.epoch) this.exit(); throw error; }
    finally { this.el<HTMLButtonElement>('ccStart').disabled = false; }
  }
  private captureScene() {
    const { scene, camera } = this.viewer;
    if (scene.mode !== SceneMode.SCENE3D) throw new Error('请先切换到三维场景，再开始视频融合');
    const cameraState = { position: Cartesian3.clone(camera.positionWC), direction: Cartesian3.clone(camera.directionWC), up: Cartesian3.clone(camera.upWC), frustum: camera.frustum.clone(), transform: Matrix4.clone(camera.transform) };
    const visibility: Array<[Visible, boolean]> = [];
    const remember = (item?: Visible) => { if (item && !visibility.some(([o]) => o === item)) { visibility.push([item, item.show]); item.show = false; } };
    const imported = new Set(this.options.getImports().map(r => r.resource));
    // Entity CAD renders inside DataSourceDisplay's shared collections, rather
    // than its public DataSource object. Keep those roots and hide individual
    // data sources/entities below. These fields are pinned to our Cesium version.
    const displayRoots = this.viewer.dataSourceDisplay as unknown as { _primitives?: Visible; _groundPrimitives?: Visible };
    for (let i = 0; i < scene.primitives.length; i++) { const p = scene.primitives.get(i); if (!imported.has(p) && p !== displayRoots._primitives) remember(p); }
    for (let i = 0; i < scene.groundPrimitives.length; i++) { const p = scene.groundPrimitives.get(i); if (p !== displayRoots._groundPrimitives) remember(p); }
    for (let i = 0; i < this.viewer.dataSources.length; i++) { const d = this.viewer.dataSources.get(i); if (!imported.has(d)) remember(d); }
    for (const e of this.viewer.entities.values) remember(e);
    remember(scene.globe); remember(scene.skyBox); remember(scene.skyAtmosphere); remember(scene.sun); remember(scene.moon);
    const background = Color.clone(scene.backgroundColor), fog = scene.fog.enabled, inputs = scene.screenSpaceCameraController.enableInputs;
    const tracked = this.viewer.trackedEntity, shadows = this.viewer.shadows, hdr = scene.highDynamicRange;
    const effects: Array<{ stage: { enabled: boolean }; enabled: boolean }> = [];
    const disable = (stage: { enabled: boolean }) => { effects.push({ stage, enabled: stage.enabled }); stage.enabled = false; };
    disable(scene.postProcessStages.fxaa); disable(scene.postProcessStages.bloom); disable(scene.postProcessStages.ambientOcclusion);
    for (let i = 0; i < scene.postProcessStages.length; i++) disable(scene.postProcessStages.get(i));
    this.viewer.trackedEntity = undefined; camera.cancelFlight(); camera.lookAtTransform(Matrix4.IDENTITY);
    scene.backgroundColor = Color.TRANSPARENT; scene.fog.enabled = false; this.viewer.shadows = false; scene.highDynamicRange = false;
    scene.screenSpaceCameraController.enableInputs = false;
    this.restoreScene = () => {
      for (const [object, show] of visibility) if (!object.isDestroyed?.()) object.show = show;
      for (const { stage, enabled } of effects) { try { stage.enabled = enabled; } catch { /* A deleted stage is not restored. */ } }
      scene.backgroundColor = background; scene.fog.enabled = fog; this.viewer.shadows = shadows; scene.highDynamicRange = hdr;
      scene.screenSpaceCameraController.enableInputs = inputs; camera.frustum = cameraState.frustum;
      camera.lookAtTransform(Matrix4.IDENTITY); camera.setView({ destination: cameraState.position, orientation: { direction: cameraState.direction, up: cameraState.up } });
      camera.lookAtTransform(cameraState.transform); this.viewer.trackedEntity = tracked;
    };
  }
  private lensStage?: PostProcessStage;
  private removeProjectionGuard?: () => void;
  private installLens() {
    const { intrinsics: k, distortion: d } = this.track!, bounds = overlayLensBounds(k, d), near = .1;
    const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top, aspectRatio = width / height;
    // SCENE3D requires PerspectiveFrustum. Its public near-plane offsets preserve
    // the calibrated principal point and its native fields support 3D Tiles LOD.
    const frustum = new PerspectiveFrustum({ near, far: 100000, aspectRatio,
      fov: 2 * Math.atan(Math.max(width, height) / 2),
      xOffset: (bounds.left + bounds.right) * near / 2,
      yOffset: -(bounds.top + bounds.bottom) * near / 2 });
    this.viewer.camera.frustum = frustum;
    // Widget resize writes the canvas aspect. The ideal lens render can have a
    // different aspect, so restore its calibration before each scene update.
    this.removeProjectionGuard = this.viewer.scene.preUpdate.addEventListener(() => { if (this.viewer.camera.frustum === frustum) frustum.aspectRatio = aspectRatio; });
    this.lensStage = new PostProcessStage({ name: `cc-video-overlay-${crypto.randomUUID()}`, fragmentShader: OVERLAY_LENS_SHADER,
      uniforms: { cameraK: new Cartesian4(k.fx, k.fy, k.cx, k.cy), imageSize: new Cartesian2(k.width, k.height),
        opticalBounds: new Cartesian4(bounds.left, bounds.right, bounds.top, bounds.bottom), radialLens: new Cartesian3(d.k1, d.k2, d.k3), tangentLens: new Cartesian2(d.p1, d.p2), overlayOpacity: () => this.opacity } });
    this.viewer.scene.postProcessStages.add(this.lensStage);
  }
  private originalContainerStyle = '';
  private mountStage() {
    const parent = this.viewer.container.parentElement!;
    this.originalContainerStyle = this.container.style.cssText;
    this.backdrop = document.createElement('div'); this.backdrop.className = 'cc-video-backdrop'; this.backdrop.append(this.video); parent.prepend(this.backdrop);
    parent.classList.add('cc-video-active');
    this.badge = document.createElement('div'); this.badge.className = 'cc-video-status'; parent.append(this.badge);
    this.controls = document.createElement('div'); this.controls.className = 'cc-video-controls';
    this.controls.innerHTML = '<button data-cc-play type="button">播放</button><button data-cc-back type="button">上一关键帧</button><button data-cc-next type="button">下一关键帧</button><input data-cc-seek aria-label="视频进度" type="range" min="0" step="0.001"><span class="cc-clock"></span><select data-cc-speed aria-label="倍速"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><button data-cc-full type="button">全屏</button><button data-cc-exit type="button">返回地图</button>';
    this.controls.querySelector('[data-cc-play]')!.addEventListener('click', () => { if (this.video.paused) void this.video.play().catch(e => this.fail(e)); else this.video.pause(); });
    const seek = this.controls.querySelector<HTMLInputElement>('[data-cc-seek]')!; seek.max = String(this.video.duration);
    seek.addEventListener('input', () => { this.video.currentTime = Number(seek.value); });
    const skip = (next: boolean) => { this.video.pause(); const times = this.track!.keyframes.map(k => k.time); this.video.currentTime = next ? times.find(t => t > this.video.currentTime + .001) ?? times.at(-1)! : [...times].reverse().find(t => t < this.video.currentTime - .001) ?? times[0]; };
    this.controls.querySelector('[data-cc-back]')!.addEventListener('click', () => skip(false));
    this.controls.querySelector('[data-cc-next]')!.addEventListener('click', () => skip(true));
    this.controls.querySelector<HTMLSelectElement>('[data-cc-speed]')!.addEventListener('change', event => { this.video.playbackRate = Number((event.target as HTMLSelectElement).value); });
    this.controls.querySelector('[data-cc-exit]')!.addEventListener('click', () => this.exit());
    this.controls.querySelector('[data-cc-full]')!.addEventListener('click', () => { void (document.fullscreenElement ? document.exitFullscreen() : parent.requestFullscreen()).catch(e => this.fail(e)); });
    parent.append(this.controls); this.resize = new ResizeObserver(() => this.layout()); this.resize.observe(parent); this.layout(); this.updatePlayback();
  }
  private layout() {
    if (!this.backdrop || !this.active) return;
    const parent = this.viewer.container.parentElement!, rect = containVideoRect(Math.max(1, parent.clientWidth), Math.max(1, parent.clientHeight - 64), this.video.videoWidth, this.video.videoHeight);
    for (const e of [this.video, this.container]) Object.assign(e.style, { position: 'absolute', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    this.viewer.resize(); this.viewer.scene.requestRender();
  }
  private requestFrame() {
    if (!this.active || this.frameHandle !== undefined || this.animationHandle !== undefined) return;
    if (this.video.requestVideoFrameCallback) this.frameHandle = this.video.requestVideoFrameCallback((_now, metadata) => { this.frameHandle = undefined; this.renderFrame(metadata.mediaTime); this.requestFrame(); });
    else this.animationHandle = requestAnimationFrame(() => { this.animationHandle = undefined; this.renderFrame(this.video.currentTime); if (!this.video.paused) this.requestFrame(); });
  }
  private renderFrame(time: number) {
    if (!this.active || !this.track || this.seeking) return;
    this.lastFrameTime = time; const sample = this.track.sample(time);
    this.resources?.setVisible(!!sample);
    if (sample) this.viewer.camera.setView({ destination: v3(sample.position), orientation: { direction: v3(sample.direction), up: v3(sample.up) } });
    if (this.badge) this.badge.textContent = sample ? `${sample.interpolation === 0 || sample.interpolation === 1 ? '空三关键帧' : '关键帧间估计'} · ${clock(time)} · 透视叠加` : '当前时间没有空三定位，已隐藏工程叠加';
    this.updatePlayback(); this.viewer.scene.requestRender();
  }
  private updatePlayback() {
    if (!this.controls) return;
    this.controls.querySelector('[data-cc-play]')!.textContent = this.video.paused ? '播放' : '暂停';
    this.controls.querySelector('.cc-clock')!.textContent = `${clock(this.video.currentTime)} / ${clock(this.video.duration)}`;
    this.controls.querySelector<HTMLInputElement>('[data-cc-seek]')!.value = String(this.video.currentTime);
  }
  refreshResources() {
    if (this.destroyed) return;
    const items = this.resources?.list() ?? this.options.getImports().filter(r => ['CAD', 'Model', '3D Tiles'].includes(r.kind)).map(r => ({ id: r.id, name: r.name, kind: r.kind, available: true, description: '', error: undefined }));
    if (!this.selectionInitialized && items.length) { for (const item of items) if (item.kind !== '3D Tiles') this.selected.add(item.id); this.selectionInitialized = true; }
    const list = this.el('ccResources'); list.replaceChildren();
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'cc-resource'; const label = document.createElement('label'), check = document.createElement('input');
      check.type = 'checkbox'; check.checked = this.selected.has(item.id); check.disabled = !item.available; check.dataset.ccResource = item.id;
      check.addEventListener('change', () => { if (check.checked) this.selected.add(item.id); else this.selected.delete(item.id); this.resources?.setSelection([...this.selected]); this.updateTargets(); this.dirty(); });
      label.append(check, document.createTextNode(`${item.name} · ${item.kind}`)); row.append(label);
      if (item.description || item.error) { const small = document.createElement('small'); small.textContent = item.error || item.description; row.append(small); } list.append(row);
    }
    if (!items.length) list.textContent = '请先导入并定位 CAD 或工程模型。';
    this.resources?.setSelection([...this.selected]);
    this.updateTargets();
  }
  private updateTargets() {
    const select = this.el<HTMLSelectElement>('ccTarget'), previous = select.value;
    select.replaceChildren(new Option('勾选对象整体平移', '*'));
    for (const item of this.options.getImports()) if (this.selected.has(item.id)) select.add(new Option(item.name, item.id));
    select.value = [...select.options].some(o => o.value === previous) ? previous : '*'; this.syncAdjustmentInputs();
  }
  private targetIds() { const target = this.el<HTMLSelectElement>('ccTarget').value; return target === '*' ? [...this.selected] : this.selected.has(target) ? [target] : []; }
  private syncAdjustmentInputs() {
    this.groupValues = zero(); const target = this.el<HTMLSelectElement>('ccTarget').value;
    const value = target === '*' ? this.groupValues : this.adjustments[target] ?? zero();
    for (const [id, key] of Object.entries({ ccEast: 'east', ccNorth: 'north', ccUp: 'up', ccHeading: 'heading' })) this.el<HTMLInputElement>(id).value = String(value[key as keyof VideoOverlayAdjustment]);
    this.el<HTMLInputElement>('ccHeading').disabled = target === '*';
  }
  private pushHistory() { this.undo.push(structuredClone(this.adjustments)); if (this.undo.length > 100) this.undo.shift(); this.redo = []; }
  private edit(key: keyof VideoOverlayAdjustment, value: number) {
    if (!Number.isFinite(value) || Math.abs(value) > 100000) return;
    const ids = this.targetIds(); if (!ids.length) return;
    this.pushHistory(); const all = this.el<HTMLSelectElement>('ccTarget').value === '*';
    const delta = value - this.groupValues[key];
    for (const id of ids) { const before = this.adjustments[id] ?? zero(); this.adjustments[id] = { ...before, [key]: all ? before[key] + delta : value }; }
    this.groupValues[key] = value; this.applyAdjustments();
  }
  private applyAdjustments() { try { const all = Object.fromEntries(this.options.getImports().map(item => [item.id, this.adjustments[item.id] ?? zero()])); this.resources?.applyAdjustments(all); this.viewer.scene.requestRender(); this.dirty(); } catch (e) { this.fail(e); } }
  private history(forward: boolean) {
    const from = forward ? this.redo : this.undo, to = forward ? this.undo : this.redo, value = from.pop(); if (!value) return;
    to.push(structuredClone(this.adjustments)); this.adjustments = value; this.applyAdjustments(); this.syncAdjustmentInputs();
  }
  private startDrag(event: PointerEvent) {
    const mode = this.el<HTMLSelectElement>('ccDragMode').value;
    if (!this.active || mode === 'off' || event.button !== 0 || !this.targetIds().length || !this.track?.sample(this.lastFrameTime)) return;
    this.video.pause(); this.pushHistory();
    const item = this.options.getImports().find(r => r.id === this.targetIds()[0]);
    const center = item?.boundingSphere?.center ?? (item?.resource as { boundingSphere?: { center: Cartesian3 } })?.boundingSphere?.center;
    if (!center) return this.fail(new Error('该对象没有可用的定位中心，请使用方向按钮或数值微调'));
    const distance = Math.max(1, Cartesian3.distance(this.viewer.camera.positionWC, center));
    this.dragging = { x: event.clientX, y: event.clientY, base: structuredClone(this.adjustments), right: Cartesian3.clone(this.viewer.camera.rightWC), up: Cartesian3.clone(this.viewer.camera.upWC),
      meters: distance / this.track!.intrinsics.fx * this.track!.intrinsics.width / this.viewer.canvas.clientWidth, origin: Cartesian3.clone(center), mode };
    this.viewer.canvas.setPointerCapture(event.pointerId); event.preventDefault();
  }
  private moveDrag(event: PointerEvent) {
    const d = this.dragging; if (!d || !this.active) return;
    // Screen drag is a bounded editing gesture. The committed result is a world ENU offset.
    const enu = Transforms.eastNorthUpToFixedFrame(d.origin);
    const east = Matrix4.multiplyByPointAsVector(enu, Cartesian3.UNIT_X, new Cartesian3()), north = Matrix4.multiplyByPointAsVector(enu, Cartesian3.UNIT_Y, new Cartesian3());
    const motion = Cartesian3.add(Cartesian3.multiplyByScalar(d.right, (event.clientX - d.x) * d.meters, new Cartesian3()), Cartesian3.multiplyByScalar(d.up, -(event.clientY - d.y) * d.meters, new Cartesian3()), new Cartesian3());
    for (const id of this.targetIds()) { const base = d.base[id] ?? zero(); this.adjustments[id] = { ...base, east: base.east + (d.mode === 'horizontal' ? Cartesian3.dot(motion, east) : 0), north: base.north + (d.mode === 'horizontal' ? Cartesian3.dot(motion, north) : 0), up: base.up + (d.mode === 'vertical' ? -(event.clientY - d.y) * d.meters : 0) }; }
    this.applyAdjustments(); this.syncAdjustmentInputs(); event.preventDefault();
  }
  async save() {
    if (this.saving) return; this.saving = true; this.el<HTMLButtonElement>('ccSave').disabled = true;
    const session = this.sessionGeneration;
    try {
      await this.prepare(); if (!this.onSave) throw new Error('项目保存服务尚未就绪');
      if (session !== this.sessionGeneration || this.destroyed) return;
      const revision = this.editRevision, files = { ...this.files };
      const settings: SavedVideoOverlaySettings = { mode: 'cc-overlay', version: 1, timing: this.timing!, selectedIds: [...this.selected], adjustments: structuredClone(this.adjustments), opacity: this.opacity,
        currentTime: this.video.currentTime, videoName: this.files.video.name, videoSize: this.files.video.size, width: this.video.videoWidth, height: this.video.videoHeight };
      const savedId = await this.onSave({ name: `${files.video.name} · CC 融合`, files, settings }, this.savedId);
      if (session !== this.sessionGeneration || this.destroyed) return;
      this.savedId = savedId;
      this.onSaved?.(savedId);
      this.el('ccSavedState').textContent = revision === this.editRevision ? '融合方案已保存' : '方案已保存，仍有新的更改未保存';
    } finally { this.saving = false; this.el<HTMLButtonElement>('ccSave').disabled = false; }
  }
  async restoreReplay(files: Record<string, File>, settings: SavedVideoOverlaySettings, recordId?: string) {
    this.clear();
    if (settings.mode !== 'cc-overlay' || settings.version !== 1 || !settings.timing) throw new Error('不支持的 CC 融合方案');
    if (!files.video || files.video.name !== settings.videoName || files.video.size !== settings.videoSize) throw new Error('保存的视频与融合方案不一致');
    this.files = { ...files }; this.savedId = recordId; this.adjustments = structuredClone(settings.adjustments ?? {}); this.selected = new Set(settings.selectedIds ?? []); this.selectionInitialized = true;
    const t = settings.timing;
    for (const [id, value] of Object.entries({ ccFirstTime: t.firstTimeSeconds, ccInterval: t.intervalSeconds, ccTimeMode: t.mode, ccFilenameStep: t.filenameStep ?? 1, ccHeightReference: t.heightReference, ccHeightOffset: t.heightOffsetMeters ?? 0 })) this.el<HTMLInputElement>(id).value = String(value);
    this.opacity = Math.min(1, Math.max(0, settings.opacity ?? .8)); this.el<HTMLInputElement>('ccOpacity').value = String(this.opacity);
    await this.prepare(); this.video.currentTime = Math.max(0, Math.min(this.video.duration, settings.currentTime || 0)); this.refreshResources(); this.el('ccSavedState').textContent = '已恢复，点击“开始融合”查看';
  }
  setPanelActive(active: boolean) { if (!active) this.exit(); else this.refreshResources(); }
  private exit() {
    ++this.epoch; this.controller?.abort(); this.controller = undefined; this.video.pause(); this.dragging = undefined; this.seeking = false;
    if (this.frameHandle !== undefined) this.video.cancelVideoFrameCallback?.(this.frameHandle); this.frameHandle = undefined;
    if (this.animationHandle !== undefined) cancelAnimationFrame(this.animationHandle); this.animationHandle = undefined;
    this.resize?.disconnect(); this.resize = undefined;
    this.removeProjectionGuard?.(); this.removeProjectionGuard = undefined;
    if (this.lensStage && !this.viewer.isDestroyed()) this.viewer.scene.postProcessStages.remove(this.lensStage); this.lensStage = undefined;
    this.resources?.restore(); this.resources = undefined;
    const restore = this.restoreScene; this.restoreScene = undefined;
    if (restore && !this.viewer.isDestroyed()) restore();
    if (this.backdrop) { this.video.remove(); this.backdrop.remove(); this.backdrop = undefined; this.container.style.cssText = this.originalContainerStyle; }
    this.controls?.remove(); this.controls = undefined; this.badge?.remove(); this.badge = undefined;
    this.viewer.container.parentElement?.classList.remove('cc-video-active'); delete this.container.dataset.ccDrag;
    const entered = this.enterHooksActive; this.enterHooksActive = false;
    if (entered) this.options.onExit?.();
    if (restore && !this.viewer.isDestroyed()) { this.viewer.resize(); this.viewer.scene.requestRender(); }
  }
  clear() {
    ++this.sessionGeneration; ++this.inputGeneration; this.mediaLoad?.cancel(); this.exit(); this.video.removeAttribute('src'); this.video.load(); if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = undefined; this.videoFile = undefined; this.files = {}; this.savedId = undefined; this.dataset = undefined; this.track = undefined;
    this.adjustments = {}; this.undo = []; this.redo = []; this.selected.clear(); this.selectionInitialized = false;
    this.el<HTMLInputElement>('ccVideoFile').value = ''; this.el<HTMLInputElement>('ccXmlFile').value = ''; this.refreshResources();
    this.el('ccOverlayInfo').textContent = '选择视频与 CC 空三 XML，无需 SRT。'; this.el('ccSavedState').textContent = '尚未保存';
  }
  destroy() { this.clear(); this.destroyed = true; for (const dispose of this.disposers.splice(0)) dispose(); }
}
