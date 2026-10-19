import { Cartesian3, Color, Matrix4, PerspectiveFrustum, SceneMode, Transforms, type PostProcessStage, type Viewer } from 'cesium';
import { createCcCameraTrack, parseCcCameraXml, type CcCameraDataset, type CcCameraTrack, type CcTrackOptions } from './ccCameraTrack';
import { VideoOverlayResources, type VideoOverlayAdjustment } from './videoOverlayResources';
import { containVideoRect, overlayLensBounds, overlayTransparencyUniforms, createVideoOverlayLensStage } from './videoOverlayLens';
import { transformCcCameraSample, validateCcSceneTransform } from './ccSceneRegistration';
import { createCcCameraRegistrationMatrix, defaultCcCameraRegistration, validateCcCameraRegistration, type CcCameraRegistration, type CcCameraRegistrationAnchor } from './ccCameraRegistration';
import { assertVideoOverlayOccluder, validateVideoOverlayOcclusion, type SavedVideoOverlayOcclusion } from './videoOverlayOcclusion';
import type { LibraryRecord } from './projectLibrary';
import type { ImportRecord } from './types';
import { extractVideoFrames, parseVideoFrameManifest, pickVideoFrameDirectory, verifyVideoFrameSource, type VideoFrameManifest } from './videoFrameExtraction';
import { downloadVideoOverlayExport, planVideoOverlayExport, type VideoOverlayExportResolution } from './videoOverlayExport';
import { exportVideoOverlayOffline } from './videoOverlayOfflineExport';
import { parseVideoPosCsv } from './videoFramePos';
import { VideoOverlayAutosave } from './videoOverlayAutosave';
import { drawVideoOverlayAnnotations, videoOverlayAnnotationState, validateVideoOverlayAnnotation, type VideoOverlayAnnotation } from './videoOverlayAnnotations';
import { evaluateVideoOverlayEffects, validateVideoOverlayEffects, type SavedVideoOverlayEffect } from './videoOverlayEffects';
import { VideoOverlayPresentationEditor } from './videoOverlayPresentationEditor';
import { VideoOverlayPlaybackCompositor } from './videoOverlayPlaybackCompositor';
import { captureVideoOverlayRenderTargets } from './videoOverlayRenderTargets';
import './videoModelOverlay.css';

export const VIDEO_OVERLAY_BUILD = '2026.10.19-R3';

export type SavedVideoOverlaySettings = {
  schemeName?: string;
  mode: 'cc-overlay'; version: 1; timing: CcTrackOptions; selectedIds: string[];
  adjustments: Record<string, VideoOverlayAdjustment>; opacity: number; currentTime: number;
  videoName: string; videoSize: number; width: number; height: number;
  sceneReference?: { recordId: string; matrix: number[] };
  cameraRegistration?: CcCameraRegistration & { anchor?: CcCameraRegistrationAnchor };
  occlusion?: SavedVideoOverlayOcclusion;
  posTiming?: { frameRate: number; firstTime: number };
  annotations?: VideoOverlayAnnotation[];
  effects?: SavedVideoOverlayEffect[];
};
type SaveProgress = { phase: 'uploading' | 'committing'; loaded: number; total: number };
type OverlaySnapshot = { name: string; files: Record<string, File>; settings: SavedVideoOverlaySettings };
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
  <h2>视频 AR · 工程叠加</h2><small data-cc-build>版本 ${VIDEO_OVERLAY_BUILD}</small><button id="ccExit" class="cc-exit" type="button">退出 AR 融合（释放资源）</button><p class="cc-hint">导入原视频与同源 CC 空三结果，将已定位的 CAD、工程模型叠加到实景视频。</p>
  <details open><summary>融合方案</summary><label>方案名称<input id="ccSchemeName" maxlength="120" placeholder="按视频名称自动命名"></label><label>已保存方案<select id="ccSchemeList"><option value="">请选择融合方案</option></select></label><div class="cc-actions"><button id="ccSchemeOpen" type="button">打开</button><button id="ccSchemeCopy" type="button">另存副本</button><button id="ccSchemeRefresh" type="button">刷新</button><button id="ccSchemeDelete" type="button">删除方案</button></div><small>开始融合后自动保存；首次视频上传完成后，方案才可在下次打开。</small></details>
  <label>航拍视频<input id="ccVideoFile" type="file" accept="video/*,.mp4,.mov,.webm"></label>
  <details><summary>从视频抽帧 → CC 空三</summary><div class="cc-fields"><label>开始（秒）<input id="ccExtractStart" type="number" min="0" step="0.001" value="0"></label><label>结束（秒，空白为片尾）<input id="ccExtractEnd" type="number" min="0" step="0.001"></label></div><label>抽帧方式<select id="ccExtractMode"><option value="interval">按间隔</option><option value="count">按数量均匀分布</option></select></label><div class="cc-fields"><label>间隔（秒）<input id="ccExtractInterval" type="number" min="0.001" step="any" value="1"></label><label>数量<input id="ccExtractCount" type="number" min="2" max="5000" value="60"></label></div><div class="cc-actions"><button id="ccExtract" type="button">抽帧到文件夹</button><button id="ccExtractZip" type="button">抽帧为 ZIP</button><button id="ccExtractCancel" type="button" disabled>取消</button></div><small id="ccExtractStatus">默认每秒一张，原始分辨率。同时输出照片、时间清单和 POS 表。导入真实 POS 后生成 All_Pos.csv；未提供定位数据则生成待填模板。</small></details>
  <details open><summary>抽帧 POS 定位数据</summary><label>原始 POS CSV<input id="ccPosFile" type="file" accept=".csv,text/csv"></label><div class="cc-fields"><label>POS 编号帧率（fps）<input id="ccPosFrameRate" type="number" min="0.001" step="any" value="30"></label><label>首条 POS 时间（秒）<input id="ccPosFirstTime" type="number" min="0" step="any" value="0"></label></div><small>支持 name,coordinate_system,x,y,z,yaw,pitch,roll；有 time_seconds 列时优先按该时间。否则按照片名末尾帧号与实际帧率对应视频，保留跳号。请核对原 POS 的坐标与高程基准。</small></details>
  <label>抽帧时间清单（平台抽帧自动关联）<input id="ccManifestFile" type="file" accept=".json"></label>
  <label>CC 空三 XML<input id="ccXmlFile" type="file" accept=".xml"></label>
  <div id="ccOverlayInfo" role="status">选择视频与 CC 空三 XML，无需 SRT。</div>
  <details open><summary>抽帧时间与高度</summary>
    <div class="cc-fields"><label>首张照片时间（秒）<input id="ccFirstTime" type="number" min="0" step="0.001" value="0"></label><label>抽帧间隔（秒）<input id="ccInterval" type="number" min="0.001" step="any" placeholder="按实际抽帧设置"></label></div>
    <label>照片编号规则<select id="ccTimeMode"><option value="photo-times">按平台抽帧清单的实际帧时间</option><option value="filename-number" selected>按文件末尾编号关联（保留跳号）</option><option value="ordinal">XML 内照片按顺序等间隔</option></select></label>
    <label>每个间隔增加的编号<input id="ccFilenameStep" type="number" min="1" step="1" value="1"></label>
    <small>例如每隔 2 秒一张且编号为 0、60、120：间隔填 2，编号增量填 60。仅对等间隔抽帧适用。</small>
    <label><input id="ccSmooth" type="checkbox">连续轨迹插值（保留空三关键帧）</label><small>减轻关键帧间速度突变；开启后请核验转弯与加速片段。</small>
    <label>空三高程<select id="ccHeightReference"><option value="ellipsoid">使用 CC XML 原始高程（默认）</option><option value="offset-to-ellipsoid">按已核实的高差手动改正</option></select></label>
    <label>加到 XML 高度的高差（米）<input id="ccHeightOffset" type="number" step="any" value="0" disabled></label>
    <small>CC 默认使用参考椭球高。已有手动高差会保留；仅在已核实原数据高程基准时使用，不能靠移动模型补偿相机高度误差。</small>
  </details>
  <details><summary>视频与三维场景的坐标关联</summary>
    <label>本次空三对应的倾斜摄影<select id="ccSceneReference"><option value="">使用 XML 原始地理坐标</option></select></label>
    <small>仅关联与本次空三使用同一成果基准的倾斜摄影，将其已保存的整体位置校正同步给视频相机。工程模型和 CAD 的原定位保持不变。</small>
    <small>相机更新会影响所有叠加对象的画面位置，请勿关联其他航次或仅位置相近的成果。</small>
    <button id="ccReferenceUpdate" type="button">重新读取成果定位</button><small id="ccReferenceInfo">未关联倾斜摄影成果。</small>
    <small>XML 高程基准换算与成果位置校正是两项独立设置，同一高差不要重复填写。</small>
  </details>
  <details open><summary>视频相机校正</summary>
    <label><input id="ccCameraEnabled" type="checkbox">启用整段相机轨迹校正</label>
    <small>先只显示倾斜摄影，对照视频中的建筑和道路校正公共偏差。以首个空三相机为固定基准，整段轨迹一起平移、旋转。</small>
    <div class="cc-fields"><label>相机东移（米）<input id="ccCameraEast" type="number" min="-100000" max="100000" step="0.1" value="0"></label><label>相机北移（米）<input id="ccCameraNorth" type="number" min="-100000" max="100000" step="0.1" value="0"></label><label>相机升高（米）<input id="ccCameraUp" type="number" min="-100000" max="100000" step="0.1" value="0"></label><label>航向顺时针（度）<input id="ccCameraHeading" type="number" min="-180" max="180" step="0.01" value="0"></label><label>俯仰抬头（度）<input id="ccCameraPitch" type="number" min="-180" max="180" step="0.01" value="0"></label><label>横滚右倾（度）<input id="ccCameraRoll" type="number" min="-180" max="180" step="0.01" value="0"></label></div>
    <small>数值确认后更新暂停画面；取消勾选可对比校正前后。旋转也会改变后续相机的位置，请检查首、中、尾及转向片段。</small>
    <button id="ccCameraReset" type="button">重置相机校正</button><small id="ccCameraInfo">未启用相机校正。</small>
    <small>相机校正随录像保存，已有 CAD／模型微调会保留。更改空三高程或成果关联后请重新核验；需要新的首帧基准时，先重置相机校正。</small>
  </details>
  <details open><summary>地表与建筑遮挡</summary>
    <label><input id="ccOcclusionEnabled" type="checkbox">启用实景遮挡，隐藏地下及被遮住的构件</label>
    <label>遮挡参照<select id="ccOcclusionSource"><option value="">请选择已加载的倾斜摄影</option></select></label>
    <button id="ccOcclusionUseReference" type="button">使用相机关联的倾斜摄影</button>
    <small>选择同一现场、已与视频对齐的网格倾斜摄影。它只提供遮挡深度，原视频仍然可见；无需在“叠加对象”中显示这份成果。</small>
    <small>遮挡取决于成果的覆盖与完整程度。已有地表会在细节加载时继续遮挡；当前视角数据未齐时保留上一幅完整融合画面，准备好后再更新。更改参照后请重新开始融合。</small>
    <small id="ccOcclusionInfo">未启用实景遮挡，视频本身不含深度。</small>
  </details>
  <small>按原视频分辨率合成，不自动降低清晰度。实时编辑遇到数据加载会等待完整画面；展示时可先生成连续预览，再按固定帧率播放。</small>
  <div class="cc-actions"><button id="ccBuildPreview" type="button">生成原分辨率连续预览</button><button id="ccClearPreview" type="button">返回实时编辑</button></div><small id="ccPreviewStatus">连续预览使用下方导出区间和帧率，包含标注与展示效果；修改方案后需重新生成。</small>
  <div class="cc-actions"><button id="ccStart" class="primary" type="button">开始融合</button><button id="ccStop" type="button">退出 AR 融合</button></div>
  <h3>叠加对象</h3><div id="ccResources"><small>先在 CAD／工程模型中导入并定位对象。</small></div>
  <h3>叠加对象位置微调</h3><label>调整范围<select id="ccTarget"><option value="*">勾选对象整体平移</option></select></label>
  <div class="cc-fields"><label>向东（米）<input id="ccEast" type="number" step="0.1" value="0"></label><label>向北（米）<input id="ccNorth" type="number" step="0.1" value="0"></label><label>升高（米）<input id="ccUp" type="number" step="0.1" value="0"></label><label>按钮步长（米）<input id="ccStep" type="number" min="0.001" step="any" value="0.1"></label></div>
  <div class="cc-nudges"><button data-cc-nudge="east:-1" type="button">向西</button><button data-cc-nudge="north:1" type="button">向北</button><button data-cc-nudge="up:1" type="button">升高</button><button data-cc-nudge="east:1" type="button">向东</button><button data-cc-nudge="north:-1" type="button">向南</button><button data-cc-nudge="up:-1" type="button">降低</button></div>
  <label>画面拖动<select id="ccDragMode"><option value="off">关闭</option><option value="horizontal">拖动平移所选对象</option><option value="vertical">拖动升降所选对象</option></select></label>
  <details><summary>单个对象方向微调</summary><label>顺时针旋转（度）<input id="ccHeading" type="number" step="0.1" value="0"></label><small>先在调整范围中选择一个对象。</small></details>
  <div class="cc-actions"><button id="ccUndo" type="button">撤销</button><button id="ccRedo" type="button">重做</button><button id="ccReset" type="button">重置对象微调</button></div>
  <label>叠加透明度<input id="ccOpacity" type="range" min="0" max="1" step="0.01" value="0.8"></label>
  <small>位置微调对整段视频生效，保存在当前视频方案中。</small>
  <div id="ccPresentationEditor"></div>
  <div class="cc-actions"><button id="ccSave" class="primary" type="button">保存融合方案</button></div><small id="ccSavedState">尚未保存</small>
  <details><summary>导出融合视频</summary><small id="ccExportRange">载入视频与空三后显示实际可导出范围。</small><label>帧率<select id="ccExportFrameRate"><option value="25">25 fps</option><option value="30" selected>30 fps</option><option value="60">60 fps</option></select></label><label><input id="ccExportAudio" type="checkbox" checked>保留原视频音轨（支持时）</label><div class="cc-fields"><label>开始（秒，空白为首个定位）<input id="ccExportStart" type="number" min="0" step="0.001"></label><label>结束（秒，空白为末个定位）<input id="ccExportEnd" type="number" min="0" step="0.001"></label></div><label>分辨率<select id="ccExportResolution"><option value="source" selected>原视频分辨率（最高 4K）</option><option value="1080p">1080p（手动选择）</option><option value="720p">720p（手动选择）</option></select></label><div class="cc-actions"><button id="ccExport" type="button">导出融合视频</button><button id="ccExportCancel" type="button" disabled>取消</button></div><small id="ccExportStatus">逐帧生成连续 WebM 视频；渲染较慢时增加导出用时，不压缩或跳过时间。支持 25/30/60 fps，最高 4K，一次最多 30 分钟、512 MiB。音轨处理限原视频 128 MiB、10 分钟以内，完成后显示音轨状态。</small></details>
  <div class="cc-actions"><button id="ccDiagnostics" type="button">导出配准诊断</button></div><small>导出相机、时间对应和图层定位参数，不包含视频或模型文件。</small>
</section>`;

export class VideoModelOverlay {
  onSave?: (snapshot: OverlaySnapshot, existingId?: string, reportProgress?: (progress: SaveProgress) => void) => Promise<string>;
  onSaved?: (recordId: string) => void;
  private video = document.createElement('video');
  private files: Record<string, File> = {};
  private savedId?: string;
  private dataset?: CcCameraDataset;
  private track?: CcCameraTrack;
  private timing?: CcTrackOptions;
  private sceneReference?: SavedVideoOverlaySettings['sceneReference'];
  private cameraRegistration = defaultCcCameraRegistration();
  private cameraAnchor?: CcCameraRegistrationAnchor;
  private cameraCorrection: readonly number[] = Matrix4.toArray(Matrix4.IDENTITY);
  private occlusion = validateVideoOverlayOcclusion();
  private removeOcclusionStatus?: () => void;
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
  private persistedRevision = -1;
  private enterHooksActive = false;
  private mediaLoad?: { file: File; promise: Promise<void>; cancel: () => void };
  private restoreScene?: () => void;
  private backdrop?: HTMLDivElement;
  private controls?: HTMLDivElement;
  private badge?: HTMLDivElement;
  private frameHandle?: number;
  private frameGeneration = 0;
  private seekTarget?: number;
  private seekWaitTimer?: number;
  private animationHandle?: number;
  private lastFrameTime = 0;
  private seeking = false;
  private resize?: ResizeObserver;
  private disposers: (() => void)[] = [];
  private destroyed = false;
  private autosaveTimer?: number;
  private metadata?: { width: number; height: number; duration: number };
  private resumeTime = 0;
  private manifest?: VideoFrameManifest;
  private manifestImportGeneration = 0;
  private extraction?: AbortController;
  private exportPlan?: ReturnType<typeof planVideoOverlayExport>;
  private exportAbort?: AbortController;
  private lastPresentationKey = '';
  private occlusionStatusAt = 0;
  private lastProgressAt = 0;
  private annotations: VideoOverlayAnnotation[] = [];
  private effects: SavedVideoOverlayEffect[] = [];
  private presentationEditor: VideoOverlayPresentationEditor;
  private editorCanvas?: HTMLCanvasElement;
  private removePresentationGuard?: () => void;
  private renderReady = false;
  private lensFrame?: { number: number; time: number; ready: boolean };
  private cameraKey = '';
  private cachedPreview?: { video: HTMLVideoElement; url: string; start: number; end: number; revision: number };
  private resumeRenderLoop?: boolean;
  private sampleVisible?: boolean;
  private presentation?: HTMLCanvasElement;
  private compositor?: VideoOverlayPlaybackCompositor;
  private annotationFrame?: HTMLCanvasElement;
  private annotationKey = '';
  private releaseRenderTargets?: () => void;
  private sourceTime?: number;
  private sourceTarget?: number;
  private pendingTime?: number;
  private presentedTime?: number;
  private seekFrameTime?: number;
  private buffering = false;
  private wantedPlaying = false;
  private autoSaveReady = false;
  private accessInvalid = false;
  private readonly autosave = new VideoOverlayAutosave<OverlaySnapshot>({
    save: async job => {
      if (!this.onSave) throw new Error('项目保存服务尚未就绪');
      return this.onSave(job.snapshot, job.existingId, progress => {
        if (job.session !== String(this.sessionGeneration) || this.destroyed) return;
        this.el('ccSavedState').textContent = progress.phase === 'uploading' ? `正在后台保存视频 ${progress.total ? Math.round(progress.loaded / progress.total * 100) : 0}%` : '正在保存融合方案…';
      });
    },
    onSaved: result => {
      if (result.session !== String(this.sessionGeneration) || this.destroyed) return;
      this.savedId = result.id; this.persistedRevision = Math.max(this.persistedRevision, result.revision); this.onSaved?.(result.id);
      this.el('ccSavedState').textContent = result.revision === this.editRevision ? '融合方案已自动保存' : '正在保存新的更改…';
    },
    onError: (error, job) => {
      if (job.session !== String(this.sessionGeneration) || this.destroyed) return;
      this.el('ccSavedState').textContent = `保存失败，草稿仍在当前页面：${error instanceof Error ? error.message : error}。点击保存重试。`;
    },
  });
  private dragging?: { x: number; y: number; base: Record<string, VideoOverlayAdjustment>; right: Cartesian3; up: Cartesian3; meters: number; origin: Cartesian3; mode: string };
  private get container() { return this.viewer.container as HTMLElement; }
  get active() { return !!this.restoreScene; }

  constructor(private viewer: Viewer, private options: Options) {
    this.video.preload = 'auto'; this.video.muted = true; this.video.playsInline = true;
    this.bind('ccVideoFile', 'change', () => this.pickFile('video', this.el<HTMLInputElement>('ccVideoFile').files?.[0]));
    this.bind('ccXmlFile', 'change', () => this.pickFile('source', this.el<HTMLInputElement>('ccXmlFile').files?.[0]));
    this.bind('ccStart', 'click', () => { void this.enter().catch(e => this.fail(e)); });
    this.bind('ccStop', 'click', () => this.leave());
    this.bind('ccExit', 'click', () => { this.leave(); this.options.notify('已退出 AR 融合，视频解码和融合渲染已释放'); });
    this.bind('ccPosFile', 'change', () => {
      const file = this.el<HTMLInputElement>('ccPosFile').files?.[0];
      if (file) {
        // Version the attachment name so a failed commit cannot replace the POS
        // bytes still referenced by the previously saved scheme.
        this.files.pos = new File([file], `${crypto.randomUUID().slice(0, 8)}_${file.name}`, { type: file.type || 'text/csv', lastModified: file.lastModified });
        this.dirty(); this.el('ccExtractStatus').textContent = `已选择 ${file.name}，请核对 POS 帧率和首条时间后抽帧。`;
      }
    });
    for (const id of ['ccPosFrameRate', 'ccPosFirstTime']) this.bind(id, 'change', () => this.dirty());
    this.presentationEditor = new VideoOverlayPresentationEditor({ root: this.el('ccPresentationEditor'), getTime: () => this.lastFrameTime,
      getDuration: () => this.metadata?.duration ?? 60, onChange: (annotations, effects) => {
        this.annotations = annotations; this.effects = effects; this.dirty(); this.lastPresentationKey = ''; this.renderFrame(this.lastFrameTime);
      } });
    this.bind('ccBuildPreview', 'click', () => { void this.exportVideo(true).catch(e => this.fail(e)); });
    this.bind('ccClearPreview', 'click', () => this.clearCachedPreview());
    this.bind('ccSave', 'click', () => { void this.save().catch(e => this.fail(e)); });
    this.bind('ccSchemeName', 'input', () => this.dirty());
    this.bind('ccManifestFile', 'change', () => { const file = this.el<HTMLInputElement>('ccManifestFile').files?.[0]; if (file) void this.importManifest(file).catch(e => this.fail(e)); });
    this.bind('ccExtract', 'click', () => { void this.extractFrames(true).catch(e => this.fail(e)); });
    this.bind('ccExtractZip', 'click', () => { void this.extractFrames(false).catch(e => this.fail(e)); });
    this.bind('ccExtractCancel', 'click', () => this.extraction?.abort());
    this.bind('ccExport', 'click', () => { void this.exportVideo().catch(e => this.fail(e)); });
    this.bind('ccExportCancel', 'click', () => this.exportAbort?.abort());
    this.listen(window, 'beforeunload', event => { if (this.autosave.hasPending || this.autosaveTimer !== undefined || this.autoSaveReady && this.editRevision > this.persistedRevision) { event.preventDefault(); (event as BeforeUnloadEvent).returnValue = ''; } });
    this.bind('ccTarget', 'change', () => this.syncAdjustmentInputs());
    this.bind('ccSceneReference', 'change', () => this.changeSceneReference());
    this.bind('ccReferenceUpdate', 'click', () => this.changeSceneReference());
    this.bind('ccOcclusionEnabled', 'change', () => this.changeOcclusion());
    this.bind('ccOcclusionSource', 'change', () => this.changeOcclusion());
    this.bind('ccOcclusionUseReference', 'click', () => {
      if (!this.sceneReference) return;
      this.el<HTMLSelectElement>('ccOcclusionSource').value = this.sceneReference.recordId;
      this.el<HTMLInputElement>('ccOcclusionEnabled').checked = true; this.changeOcclusion();
    });
    for (const id of ['ccCameraEnabled', 'ccCameraEast', 'ccCameraNorth', 'ccCameraUp', 'ccCameraHeading', 'ccCameraPitch', 'ccCameraRoll']) {
      this.bind(id, 'change', () => this.editCameraRegistration());
    }
    this.bind('ccCameraReset', 'click', () => {
      this.cameraRegistration = defaultCcCameraRegistration(); this.cameraAnchor = undefined;
      this.prepareCameraRegistration(); this.syncCameraInputs(); this.dirty(); this.renderFrame(this.lastFrameTime);
    });
    this.bind('ccDiagnostics', 'click', () => { void this.exportDiagnostics().catch(e => this.fail(e)); });
    for (const id of ['ccFirstTime', 'ccInterval', 'ccTimeMode', 'ccFilenameStep', 'ccHeightReference', 'ccHeightOffset', 'ccSmooth']) {
      this.bind(id, 'input', () => { ++this.inputGeneration; this.exit(); this.track = undefined; this.syncHeightInputs(); this.dirty(); });
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
    this.listen(this.video, 'seeking', () => {
      // Controlled seeks register before assigning currentTime. Do not erase a
      // decoded frame that arrived before this queued media event.
      if (this.seekTarget === undefined || Math.abs(this.seekTarget - this.video.currentTime) > 1e-6) this.beginSeek(this.video.currentTime);
      this.seeking = true;
    });
    this.listen(this.video, 'seeked', () => {
      if (this.video.seeking) return;
      this.seeking = false;
      const decodedTime = this.seekFrameTime; this.seekFrameTime = undefined;
      if (this.captureDecodedFrame()) { /* A paused seek need not trigger rVFC. */ }
      else if (decodedTime !== undefined) { this.seekTarget = undefined; clearTimeout(this.seekWaitTimer); this.renderFrame(decodedTime); }
      else if (!this.video.requestVideoFrameCallback) this.captureDecodedFrame(this.video.currentTime);
      this.requestFrame();
    });
    this.listen(this.video, 'play', () => { this.wantedPlaying = true; this.requestFrame(); this.updatePlayback(); });
    this.listen(this.video, 'pause', () => { if (!this.buffering) this.wantedPlaying = false; this.updatePlayback(); });
    this.listen(this.video, 'ended', () => { this.wantedPlaying = false; this.updatePlayback(); });
    this.listen(this.video, 'error', () => { if (this.active) { this.exit(); this.fail(new Error('视频无法解码，请使用浏览器支持的 MP4/H.264 或 WebM')); } });
    this.listen(this.viewer.canvas, 'pointerdown', event => this.startDrag(event as PointerEvent));
    this.listen(this.viewer.canvas, 'pointermove', event => this.moveDrag(event as PointerEvent));
    this.listen(window, 'pointerup', () => { this.dragging = undefined; });
    this.listen(window, 'blur', () => { this.dragging = undefined; });
    this.listen(this.viewer.canvas, 'webglcontextlost', () => { if (this.active) { this.leave(); this.fail(new Error('显卡渲染上下文已丢失，请恢复后重新进入融合')); } });
    this.listen(window, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape' && this.active) this.leave(); });
    this.refreshResources();
    this.listen(document, 'visibilitychange', () => { if (document.hidden && this.active && !this.exportAbort) { this.wantedPlaying = false; this.video.pause(); } });
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
  private listen(target: EventTarget, event: string, handler: EventListener) { target.addEventListener(event, handler); this.disposers.push(() => target.removeEventListener(event, handler)); }
  private bind(id: string, event: string, handler: () => void) { this.listen(this.el(id), event, handler); }
  private number(id: string) { const raw = this.el<HTMLInputElement>(id).value.trim(); return raw ? Number(raw) : NaN; }
  private fail(error: unknown) { if (error instanceof DOMException && error.name === 'AbortError') return; const message = error instanceof Error ? error.message : String(error); this.el('ccOverlayInfo').textContent = message; this.options.notify(message, true); }
  private dirty() {
    this.clearCachedPreview(); ++this.editRevision; this.el('ccSavedState').textContent = '有未保存的更改';
    clearTimeout(this.autosaveTimer);
    if (this.autoSaveReady) this.autosaveTimer = window.setTimeout(() => { void this.queueSave().catch(() => {}); }, 800);
  }
  private pickFile(slot: string, file?: File) {
    if (!file) return; this.leave(); this.autoSaveReady = false; this.accessInvalid = false; ++this.sessionGeneration; ++this.inputGeneration; this.exit(); this.mediaLoad?.cancel(); this.files = { ...this.files, [slot]: file }; this.savedId = undefined; this.dataset = undefined; this.track = undefined;
    if (slot === 'video') { this.annotations = []; this.effects = []; this.presentationEditor.setValue([], []); this.manifest = undefined; delete this.files.manifest; delete this.files.pos; this.el<HTMLInputElement>('ccPosFile').value = ''; this.resumeTime = 0; this.metadata = undefined; }
    this.el<HTMLInputElement>('ccSchemeName').value = `${this.files.video?.name ?? '视频'} · CC 融合`;
    this.sceneReference = undefined; this.refreshSceneReferences();
    this.cameraRegistration = defaultCcCameraRegistration(); this.cameraAnchor = undefined; this.cameraCorrection = Matrix4.toArray(Matrix4.IDENTITY); this.syncCameraInputs();
    this.occlusion = validateVideoOverlayOcclusion(); this.refreshOcclusionSources();
    this.adjustments = {}; this.undo = []; this.redo = []; this.syncAdjustmentInputs(); this.dirty();
    this.refreshResources();
    this.el('ccOverlayInfo').textContent = Object.values(this.files).map(f => f.name).join(' · ');
  }
  private readTiming(): CcTrackOptions {
    const height = this.el<HTMLSelectElement>('ccHeightReference').value;
    if (height !== 'ellipsoid' && height !== 'offset-to-ellipsoid') throw new Error('请在“抽帧时间与高度”中选择空三高程基准');
    return { firstTimeSeconds: this.el<HTMLSelectElement>('ccTimeMode').value === 'photo-times' ? 0 : this.number('ccFirstTime'), intervalSeconds: this.el<HTMLSelectElement>('ccTimeMode').value === 'photo-times' ? 1 : this.number('ccInterval'), mode: this.el<HTMLSelectElement>('ccTimeMode').value as CcTrackOptions['mode'],
      photoTimes: this.manifest?.frames.map(frame => ({ filename: frame.filename, timeSeconds: frame.mediaTime })), smoothing: this.el<HTMLInputElement>('ccSmooth').checked ? 'cubic' : 'none',
      filenameStep: this.number('ccFilenameStep'), heightReference: height, heightOffsetMeters: height === 'ellipsoid' ? 0 : this.number('ccHeightOffset') };
  }
  private syncHeightInputs() { this.el<HTMLInputElement>('ccHeightOffset').disabled = this.el<HTMLSelectElement>('ccHeightReference').value === 'ellipsoid'; }
  private syncCameraInputs() {
    this.el<HTMLInputElement>('ccCameraEnabled').checked = this.cameraRegistration.enabled;
    for (const [id, key] of Object.entries({ ccCameraEast: 'east', ccCameraNorth: 'north', ccCameraUp: 'up', ccCameraHeading: 'heading', ccCameraPitch: 'pitch', ccCameraRoll: 'roll' }) as [string, Exclude<keyof CcCameraRegistration, 'enabled'>][]) {
      this.el<HTMLInputElement>(id).value = String(this.cameraRegistration[key]);
    }
    this.el('ccCameraInfo').textContent = this.cameraRegistration.enabled
      ? (this.cameraAnchor ? '已启用；使用方案中固定的首帧基准，作用于所有叠加图层。' : '已启用；载入有效视频与空三后建立首帧基准。')
      : '未启用相机校正；已填写数值保留，可重新勾选对比。';
  }
  private prepareCameraRegistration() {
    if (!this.cameraAnchor && this.track) {
      const raw = this.track.sample(this.track.startTime);
      if (!raw) throw new Error('无法建立相机校正的首帧基准');
      const first = this.sceneReference ? transformCcCameraSample(raw, this.sceneReference.matrix) : raw;
      // Freeze this basis across seeks, re-entry, and changes to timing/reference.
      // A saved correction must never acquire a new pivot silently.
      this.cameraAnchor = structuredClone({ position: first.position, orientation: first.orientation });
    }
    this.cameraCorrection = this.cameraAnchor ? createCcCameraRegistrationMatrix(this.cameraAnchor, this.cameraRegistration) : Matrix4.toArray(Matrix4.IDENTITY);
  }
  private editCameraRegistration() {
    try {
      const next = validateCcCameraRegistration({ enabled: this.el<HTMLInputElement>('ccCameraEnabled').checked,
        east: this.number('ccCameraEast'), north: this.number('ccCameraNorth'), up: this.number('ccCameraUp'),
        heading: this.number('ccCameraHeading'), pitch: this.number('ccCameraPitch'), roll: this.number('ccCameraRoll') });
      const matrix = this.cameraAnchor ? createCcCameraRegistrationMatrix(this.cameraAnchor, next) : Matrix4.toArray(Matrix4.IDENTITY);
      this.cameraRegistration = next; this.cameraCorrection = matrix; this.dirty();
      // Re-evaluate the original sample; never apply a correction to the live camera.
      this.renderFrame(this.lastFrameTime);
    } catch (error) { this.fail(error); }
    this.syncCameraInputs();
  }
  private sourceMatrix(recordId: string): number[] {
    const item = this.options.getImports().find(item => item.id === recordId && item.kind === '3D Tiles');
    const record = item && this.options.getRecord(recordId);
    if (!item || !record || record.kind !== '3D Tiles') throw new Error('关联的倾斜摄影尚未加载或不可用，请加载对应成果，或选择 XML 原始坐标');
    // This is only the application's saved world-space correction. The tileset
    // root transform already participates in its geographic coordinates and must
    // never be applied again to an XML camera that is already in ECEF.
    return [...validateCcSceneTransform(record.settings.matrix ?? Matrix4.toArray(Matrix4.IDENTITY))];
  }
  private isOcclusionSource(id: string) { return this.occlusion.enabled && this.occlusion.sourceId === id; }
  private checkOcclusionAdjustment(settings = this.occlusion, values = this.adjustments) {
    if (!settings.enabled) return;
    const value = values[settings.sourceId];
    if (value && ((['east', 'north', 'up'] as const).some(key => Math.abs(value[key]) > 1e-9)
      || Math.abs(value.heading % 360) > 1e-9)) {
      throw new Error('遮挡参照需使用地图原定位；请先关闭遮挡并恢复这份倾斜摄影的对象微调，再启用遮挡');
    }
  }
  private checkOcclusionSource(settings = this.occlusion) {
    if (!settings.enabled) return;
    const item = this.options.getImports().find(item => item.id === settings.sourceId && item.kind === '3D Tiles');
    if (!item || this.options.getRecord(item.id)?.kind !== '3D Tiles') throw new Error('遮挡参照尚未加载或不可用，请加载对应倾斜摄影或关闭实景遮挡');
    assertVideoOverlayOccluder(item.resource);
    this.checkOcclusionAdjustment(settings);
  }
  private changeOcclusion() {
    try {
      const next = validateVideoOverlayOcclusion({ enabled: this.el<HTMLInputElement>('ccOcclusionEnabled').checked, sourceId: this.el<HTMLSelectElement>('ccOcclusionSource').value });
      ++this.inputGeneration; this.exit(); this.checkOcclusionSource(next);
      this.occlusion = next; this.dirty();
    } catch (error) { this.fail(error); }
    this.refreshResources();
  }
  private refreshOcclusionSources() {
    const select = this.el<HTMLSelectElement>('ccOcclusionSource'), selectedId = this.occlusion.sourceId;
    select.replaceChildren();
    const add = (label: string, value: string) => { const option = document.createElement('option'); option.textContent = label; option.value = value; select.append(option); };
    add('请选择已加载的倾斜摄影', '');
    const eligible = this.options.getImports().filter(item => item.kind === '3D Tiles' && this.options.getRecord(item.id)?.kind === '3D Tiles');
    for (const item of eligible) add(item.name, item.id);
    if (selectedId && !eligible.some(item => item.id === selectedId)) add('已选遮挡参照尚未加载或不可用', selectedId);
    select.value = selectedId;
    this.el<HTMLInputElement>('ccOcclusionEnabled').checked = this.occlusion.enabled;
    this.el<HTMLButtonElement>('ccOcclusionUseReference').disabled = !this.sceneReference;
    this.updateOcclusionStatus();
  }
  private updateOcclusionStatus() {
    const now = performance.now(); if (this.active && now - this.occlusionStatusAt < 250) return; this.occlusionStatusAt = now;
    let info = '未启用实景遮挡，视频本身不含深度。';
    if (this.occlusion.enabled) {
      try {
        this.checkOcclusionSource();
        const status = this.resources?.getOcclusionStatus();
        info = !this.active ? '已选择遮挡参照；点击“开始融合”应用。'
          : status?.error ? `遮挡不可用，仅显示原视频：${status.error}`
          : status?.ready ? status.warning ? '部分细节加载失败，正在使用已加载地表保持遮挡。'
            : status.refining ? '实景遮挡已生效，正在补充细节；工程叠加保持显示。'
            : '实景遮挡已生效；地表和建筑遮住后方构件，参照纹理不显示。'
          : status?.warning ? '部分瓦片加载失败；保留上一幅完整融合画面，等待当前视角遮挡。'
          : '当前视角遮挡正在加载；保留上一幅完整融合画面，准备好后继续。';
      } catch (error) { info = error instanceof Error ? error.message : String(error); }
    }
    const element = this.el('ccOcclusionInfo'); if (element.textContent !== info) element.textContent = info;
  }
  private checkSceneReference() {
    const reference = this.sceneReference; if (!reference) return;
    validateCcSceneTransform(reference.matrix);
    const current = this.sourceMatrix(reference.recordId);
    if (current.some((value, index) => Math.abs(value - reference.matrix[index]) > (index >= 12 ? 1e-6 : 1e-9))) {
      throw new Error('关联成果的已保存定位已更改，请点击“重新读取成果定位”后再开始融合');
    }
  }
  private changeSceneReference() {
    const recordId = this.el<HTMLSelectElement>('ccSceneReference').value;
    try {
      ++this.inputGeneration; this.exit();
      this.sceneReference = recordId ? { recordId, matrix: this.sourceMatrix(recordId) } : undefined;
      this.dirty();
    } catch (error) { this.fail(error); }
    this.refreshSceneReferences(); this.refreshOcclusionSources();
  }
  private refreshSceneReferences() {
    const select = this.el<HTMLSelectElement>('ccSceneReference'), selectedId = this.sceneReference?.recordId ?? '';
    select.replaceChildren();
    const add = (label: string, value: string) => { const option = document.createElement('option'); option.textContent = label; option.value = value; select.append(option); };
    add('使用 XML 原始地理坐标', '');
    const eligible = this.options.getImports().filter(item => item.kind === '3D Tiles' && this.options.getRecord(item.id)?.kind === '3D Tiles');
    for (const item of eligible) add(item.name, item.id);
    if (selectedId && !eligible.some(item => item.id === selectedId)) add('已关联成果尚未加载或不可用', selectedId);
    select.value = selectedId;
    this.el<HTMLButtonElement>('ccReferenceUpdate').disabled = !selectedId;
    let info = '未关联成果，视频相机使用 XML 原始地理坐标。';
    if (this.sceneReference) {
      try {
        this.checkSceneReference();
        const identity = Matrix4.toArray(Matrix4.IDENTITY);
        info = this.sceneReference.matrix.every((value, index) => Math.abs(value - identity[index]) < 1e-9)
          ? '该成果没有整体位置校正；关联后相机位置不变。'
          : '已关联成果的整体位置校正，仅同步视频相机，不移动 CAD 或工程模型。';
      } catch (error) { info = error instanceof Error ? error.message : String(error); }
    }
    this.el('ccReferenceInfo').textContent = info;
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
    try { await promise; if (this.resumeTime > 0 && this.resumeTime < this.video.duration) this.seekVideo(this.resumeTime); } finally { if (this.mediaLoad === load) this.mediaLoad = undefined; }
  }
  private async prepare(validateReference = true) {
    if (!this.files.video || !this.files.source) throw new Error('请选择原视频和同一视频的 CC 空三 XML');
    const generation = this.inputGeneration, timing = this.readTiming(); if (validateReference) { this.checkSceneReference(); this.checkOcclusionSource(); }
    const check = () => { if (generation !== this.inputGeneration || this.destroyed) throw new DOMException('融合输入已切换', 'AbortError'); };
    const dataset = this.dataset ?? parseCcCameraXml(await this.files.source.text()); check();
    const track = createCcCameraTrack(dataset, timing);
    if (Math.abs(track.intrinsics.skew) > 1e-8) throw new Error('当前叠加不支持非零相机 Skew，请使用无 skew 的 CC 相机标定');
    await this.loadMedia();
    check(); if (validateReference) { this.checkSceneReference(); this.checkOcclusionSource(); } const k = track.intrinsics;
    if (Math.abs(this.video.videoWidth / this.video.videoHeight - k.width / k.height) > .001) throw new Error('视频与 CC 影像画幅比例不一致，请使用同源未裁切视频');
    if (!Number.isFinite(this.video.duration) || track.startTime > this.video.duration || track.endTime > this.video.duration + .1) throw new Error('空三时间超出视频，请检查首张时间、抽帧间隔和编号增量');
    this.dataset = dataset; this.timing = timing; this.track = track; this.metadata = { width: this.video.videoWidth, height: this.video.videoHeight, duration: this.video.duration };
    this.prepareCameraRegistration(); this.syncCameraInputs();
    this.el('ccOverlayInfo').textContent = `${dataset.photos.length} 张空三影像 · ${k.width} × ${k.height} · 覆盖 ${clock(track.startTime)}–${clock(track.endTime)}`;
    this.el('ccExportRange').textContent = `可导出范围：${track.startTime.toFixed(3)}–${Math.min(track.endTime, this.video.duration).toFixed(3)} 秒；开始、结束留空可导出完整定位范围。`;
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
      this.resources.applyAdjustments(this.adjustments); this.resources.setOcclusion(this.occlusion.enabled ? this.occlusion.sourceId : undefined); this.resources.setSelection([...this.selected]);
      this.mountStage(); this.installLens(); this.refreshResources();
      this.removePresentationGuard = this.viewer.scene.preRender.addEventListener(() => {
        this.renderReady = this.resources?.isPresentationReady(true) ?? false;
      });
      this.removeOcclusionStatus = this.viewer.scene.postRender.addEventListener(() => { this.commitPresentation(); this.updateOcclusionStatus(); });
      if (this.video.currentTime < this.track!.startTime || this.video.currentTime > this.track!.endTime) this.seekVideo(this.track!.startTime);
      if (!this.video.seeking) this.captureDecodedFrame(this.video.currentTime);
      else this.resources?.setVisible(false);
      this.requestFrame();
      this.autoSaveReady = true; void this.queueSave().catch(() => {});
    } catch (error) { if (epoch === this.epoch) this.exit(); throw error; }
    finally { this.el<HTMLButtonElement>('ccStart').disabled = false; }
  }
  private captureScene() {
    const { scene, camera } = this.viewer;
    this.releaseRenderTargets = captureVideoOverlayRenderTargets(scene);
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
    const requestRenderMode = scene.requestRenderMode, maximumRenderTimeChange = scene.maximumRenderTimeChange, resolutionScale = this.viewer.resolutionScale;

    const effects: Array<{ stage: { enabled: boolean }; enabled: boolean }> = [];
    const disable = (stage: { enabled: boolean }) => { effects.push({ stage, enabled: stage.enabled }); stage.enabled = false; };
    disable(scene.postProcessStages.fxaa); disable(scene.postProcessStages.bloom); disable(scene.postProcessStages.ambientOcclusion);
    for (let i = 0; i < scene.postProcessStages.length; i++) disable(scene.postProcessStages.get(i));
    this.viewer.trackedEntity = undefined; camera.cancelFlight(); camera.lookAtTransform(Matrix4.IDENTITY);
    scene.backgroundColor = Color.TRANSPARENT; scene.fog.enabled = false; this.viewer.shadows = false; scene.highDynamicRange = false;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.requestRenderMode = true; scene.maximumRenderTimeChange = Infinity;
    this.restoreScene = () => {
      const reset = (action: () => void) => { try { action(); } catch { /* Other scene owners must still be restored. */ } };
      for (const [object, show] of visibility) reset(() => { if (!object.isDestroyed?.()) object.show = show; });
      for (const { stage, enabled } of effects) reset(() => { stage.enabled = enabled; });
      for (const action of [
        () => { scene.backgroundColor = background; }, () => { scene.fog.enabled = fog; }, () => { this.viewer.shadows = shadows; },
        () => { scene.highDynamicRange = hdr; }, () => { scene.requestRenderMode = requestRenderMode; },
        () => { scene.maximumRenderTimeChange = maximumRenderTimeChange; }, () => { this.viewer.resolutionScale = resolutionScale; },
        () => { scene.screenSpaceCameraController.enableInputs = inputs; }, () => { camera.frustum = cameraState.frustum; },
        () => { camera.lookAtTransform(Matrix4.IDENTITY); camera.setView({ destination: cameraState.position, orientation: { direction: cameraState.direction, up: cameraState.up } }); },
        () => { camera.lookAtTransform(cameraState.transform); }, () => { this.viewer.trackedEntity = tracked; },
      ]) reset(action);

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
    this.lensStage = createVideoOverlayLensStage(this.viewer.scene, k, d, {
      ...overlayTransparencyUniforms(this.viewer.scene),
      overlayOpacity: () => {
        const ready = !this.occlusion.enabled || !!this.resources?.getOcclusionStatus().ready;
        this.lensFrame = { number: this.sceneFrameNumber(), time: this.pendingTime ?? -1, ready };
        return this.opacity * (ready ? 1 : 0);
      },
    }, `cc-video-overlay-${crypto.randomUUID()}`);
    this.viewer.scene.postProcessStages.add(this.lensStage);
  }
  private originalContainerStyle = '';
  private mountStage() {
    const parent = this.viewer.container.parentElement!;
    this.originalContainerStyle = this.container.style.cssText;
    this.backdrop = document.createElement('div'); this.backdrop.className = 'cc-video-backdrop'; this.backdrop.append(this.video); this.compositor = new VideoOverlayPlaybackCompositor(this.video.videoWidth, this.video.videoHeight, { allowSourceScaling: true, allowOverlayRounding: true, onContextLost: () => { if (this.active) { this.leave(); this.fail(new Error('融合画面 GPU 上下文已丢失，请重新进入 AR')); } } }); this.presentation = this.compositor.canvas; this.presentation.className = 'cc-video-presentation'; this.backdrop.append(this.presentation); parent.prepend(this.backdrop);
    this.editorCanvas = document.createElement('canvas'); this.editorCanvas.className = 'cc-video-editor'; parent.append(this.editorCanvas); this.presentationEditor.mount(this.editorCanvas);
    parent.classList.add('cc-video-active');
    this.badge = document.createElement('div'); this.badge.className = 'cc-video-status'; parent.append(this.badge);
    this.controls = document.createElement('div'); this.controls.className = 'cc-video-controls';
    this.controls.innerHTML = '<button data-cc-play type="button">播放</button><button data-cc-back type="button">上一关键帧</button><button data-cc-next type="button">下一关键帧</button><input data-cc-seek aria-label="视频进度" type="range" min="0" step="0.001"><span class="cc-clock"></span><select data-cc-speed aria-label="倍速"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><button data-cc-full type="button">全屏</button><button data-cc-exit type="button">退出 AR · 释放资源</button>';
    this.controls.querySelector('[data-cc-play]')!.addEventListener('click', () => {
      if (this.cachedPreview) { this.playCachedPreview(); return; }
      if (this.wantedPlaying) { this.wantedPlaying = false; this.video.pause(); } else { this.wantedPlaying = true; void this.video.play().catch(e => this.fail(e)); } this.updatePlayback();
    });
    const seek = this.controls.querySelector<HTMLInputElement>('[data-cc-seek]')!; seek.max = String(this.video.duration);
    seek.addEventListener('input', () => { if (this.cachedPreview) { this.cachedPreview.video.currentTime = Math.max(0, Math.min(this.cachedPreview.end - this.cachedPreview.start, Number(seek.value) - this.cachedPreview.start)); this.updatePlayback(); return; } this.wantedPlaying = false; this.video.pause(); this.seekVideo(Number(seek.value)); });
    const skip = (next: boolean) => { this.clearCachedPreview(); this.wantedPlaying = false; this.video.pause(); const times = this.track!.keyframes.map(k => k.time); this.seekVideo(next ? times.find(t => t > this.video.currentTime + .001) ?? times.at(-1)! : [...times].reverse().find(t => t < this.video.currentTime - .001) ?? times[0]); };
    this.controls.querySelector('[data-cc-back]')!.addEventListener('click', () => skip(false));
    this.controls.querySelector('[data-cc-next]')!.addEventListener('click', () => skip(true));
    this.controls.querySelector<HTMLSelectElement>('[data-cc-speed]')!.addEventListener('change', event => { this.video.playbackRate = Number((event.target as HTMLSelectElement).value); if (this.cachedPreview) this.cachedPreview.video.playbackRate = this.video.playbackRate; });
    this.controls.querySelector('[data-cc-exit]')!.addEventListener('click', () => this.leave());
    this.controls.querySelector('[data-cc-full]')!.addEventListener('click', () => { void (document.fullscreenElement ? document.exitFullscreen() : parent.requestFullscreen()).catch(e => this.fail(e)); });
    parent.append(this.controls); this.resize = new ResizeObserver(() => this.layout()); this.resize.observe(parent); this.layout(); this.updatePlayback();
  }
  private layout() {
    if (!this.backdrop || !this.active) return;
    const parent = this.viewer.container.parentElement!, rect = containVideoRect(Math.max(1, parent.clientWidth), Math.max(1, parent.clientHeight - 64), this.video.videoWidth, this.video.videoHeight);
    for (const e of [this.video, this.container, this.presentation!, this.editorCanvas!, ...(this.cachedPreview ? [this.cachedPreview.video] : [])]) Object.assign(e.style, { position: 'absolute', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    this.viewer.resolutionScale = 1; this.viewer.resize();
    const targetWidth = this.exportPlan?.width ?? this.video.videoWidth, targetHeight = this.exportPlan?.height ?? this.video.videoHeight;
    this.viewer.resolutionScale = Math.max((targetWidth + 0.001) / Math.max(1, this.viewer.canvas.width), (targetHeight + 0.001) / Math.max(1, this.viewer.canvas.height)); this.viewer.resize();
    this.compositor?.resize(targetWidth, targetHeight);
    this.compositor?.setOverlayRoundingPixels(Math.ceil(Math.max(targetWidth / Math.max(1, this.viewer.canvas.clientWidth), targetHeight / Math.max(1, this.viewer.canvas.clientHeight))) + 1);
    if (this.editorCanvas) { this.editorCanvas.width = this.video.videoWidth; this.editorCanvas.height = this.video.videoHeight; }
    this.viewer.scene.requestRender();
  }
  private beginSeek(time: number) {
    ++this.frameGeneration;
    if (this.frameHandle !== undefined) this.video.cancelVideoFrameCallback?.(this.frameHandle); this.frameHandle = undefined;
    if (this.animationHandle !== undefined) cancelAnimationFrame(this.animationHandle); this.animationHandle = undefined;
    this.seekTarget = time; this.seeking = true; this.seekFrameTime = undefined; this.pendingTime = undefined;
    clearTimeout(this.seekWaitTimer);
    if (this.active) this.seekWaitTimer = window.setTimeout(() => {
      if (this.active && this.seekTarget !== undefined && this.badge) this.badge.textContent = '浏览器尚未提交定位后的画面，请点击播放；若仍无响应，请使用新版 Chrome 或 Edge。';
    }, 8000);
    this.resources?.setVisible(false); this.sampleVisible = false; this.viewer.scene.requestRender(); this.requestFrame();
  }
  private seekVideo(time: number) {
    // Chromium need not submit a new video frame when seeking to the already
    // decoded paused image. Reuse its actual timestamp instead of waiting forever.
    if (!this.seeking && !this.video.seeking && this.video.paused && this.sourceTime !== undefined && this.sourceTarget === time && this.video.currentTime === time) {
      this.pendingTime = undefined; this.captureDecodedFrame(this.sourceTime); return;
    }
    this.beginSeek(time);
    this.video.currentTime = time;
  }
  private requestFrame() {
    if (!this.active || this.frameHandle !== undefined || this.animationHandle !== undefined) return;
    const epoch = this.epoch, frameGeneration = this.frameGeneration;
    if (this.video.requestVideoFrameCallback) this.frameHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      if (epoch !== this.epoch || frameGeneration !== this.frameGeneration || !this.active) return;
      this.frameHandle = undefined;
      this.captureDecodedFrame(metadata.mediaTime);
      this.requestFrame();
    });
    else this.animationHandle = requestAnimationFrame(() => {
      if (epoch !== this.epoch || frameGeneration !== this.frameGeneration || !this.active) return;
      this.animationHandle = undefined; this.captureDecodedFrame(this.video.currentTime); if (!this.video.paused) this.requestFrame();
    });
  }
  private captureDecodedFrame(time?: number): boolean {
    if (!this.active || !this.compositor || this.video.readyState < 2 || this.video.seeking || this.cachedPreview && !this.exportAbort) return false;
    // One immutable in-flight pair. Let the native decoder keep its cadence;
    // once the renderer finishes, the next callback captures the newest PTS.
    // Repeated pause/play here used to restart decoding on every LOD wait.
    if (this.pendingTime !== undefined && this.presentedTime !== this.pendingTime && !this.seeking) return false;
    let frame: VideoFrame | undefined;
    try {
      // WebCodecs copies the playback frame's real PTS when timestamp is omitted.
      // Snapshot pixels and time together, even when a delayed rVFC describes an
      // older frame, or a paused seek submits no new compositor callback.
      if (typeof VideoFrame !== 'undefined') {
        try { frame = new VideoFrame(this.video); time = frame.timestamp / 1e6; } catch { /* Use rVFC metadata on browsers without this constructor path. */ }
      }
      if (time === undefined) return false;
      if (!this.compositor.captureSource(frame ?? this.video, time)) return false;
      this.sourceTime = time; this.sourceTarget = this.video.currentTime;
      if (this.seeking) { this.seekFrameTime = time; return true; }
      this.seekTarget = undefined; clearTimeout(this.seekWaitTimer); this.renderFrame(time);
      return true;
    } finally { frame?.close(); }
  }
  private commitPresentation() {
    if (!this.active || !this.presentation || !this.compositor || this.pendingTime === undefined || this.seeking || this.video.seeking) return;
    const status = this.resources?.getOcclusionStatus();
    const hasSample = !!this.track?.sample(this.pendingTime);
    const stamped = this.lensFrame?.number === this.sceneFrameNumber() && this.lensFrame?.time === this.pendingTime && this.lensFrame.ready;
    if (hasSample && (!stamped || !this.renderReady || !this.resources?.isPresentationReady())) {
      this.buffering = true;
      if (this.badge) this.badge.textContent = status?.error || '正在准备当前帧的完整模型与遮挡，保留上一幅融合画面…';
      this.viewer.scene.requestRender(); this.updatePlayback(); return;
    }
    const presentationKey = `${this.pendingTime}/${this.editRevision}/${!!status?.ready}/${this.presentation.width}/${this.presentation.height}`;
    // Paused videos and hidden tools must not repeatedly copy multi-megapixel frames.
    if (this.lastPresentationKey === presentationKey && !this.buffering && !status?.refining && this.resources?.isPresentationReady()) return;
    const width = this.presentation.width, height = this.presentation.height;
    let annotations: HTMLCanvasElement | undefined;
    if (this.annotations.some(mark => videoOverlayAnnotationState(mark, this.pendingTime!).visible)) {
      this.annotationFrame ??= document.createElement('canvas'); annotations = this.annotationFrame;
      const key = `${this.pendingTime}/${this.editRevision}/${width}/${height}`;
      if (this.annotationKey !== key) {
        if (annotations.width !== width || annotations.height !== height) { annotations.width = width; annotations.height = height; }
        const context = annotations.getContext('2d')!; context.clearRect(0, 0, width, height);
        drawVideoOverlayAnnotations(context, this.annotations, { width, height, mediaTime: this.pendingTime }); this.annotationKey = key;
      }
    }
    if (!this.compositor.commit(this.viewer.canvas, this.pendingTime, annotations)) return;
    this.lastPresentationKey = presentationKey;
    this.presentedTime = this.pendingTime;
    if (this.buffering) {
      this.buffering = false;
      if (this.badge) this.badge.textContent = `融合画面 · ${clock(this.presentedTime)}`;
      if (this.wantedPlaying && this.video.paused && !this.exportAbort) void this.video.play().catch(e => this.fail(e));
    }
    this.updatePlayback();
  }
  private sceneFrameNumber() { return (this.viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState.frameNumber; }
  private installCachedPreview(blob: Blob, start: number, end: number) {
    const video = document.createElement('video'), url = URL.createObjectURL(blob);
    video.className = 'cc-cached-preview'; video.playsInline = true; video.preload = 'auto'; video.src = url;
    const revision = this.editRevision; this.cachedPreview = { video, url, start, end, revision };
    this.video.pause(); this.wantedPlaying = false;
    if (this.frameHandle !== undefined) this.video.cancelVideoFrameCallback?.(this.frameHandle); this.frameHandle = undefined;
    if (this.animationHandle !== undefined) cancelAnimationFrame(this.animationHandle); this.animationHandle = undefined;
    // The baked movie no longer needs a Cesium render loop or source decoder.
    this.resumeRenderLoop = this.viewer.useDefaultRenderLoop; this.viewer.useDefaultRenderLoop = false;
    this.backdrop!.append(video); if (this.presentation) this.presentation.style.visibility = 'hidden';
    for (const event of ['timeupdate', 'play', 'pause', 'ended', 'seeked']) video.addEventListener(event, () => this.updatePlayback());
    video.addEventListener('error', () => { this.clearCachedPreview(); this.fail(new Error('连续预览无法解码，请使用新版 Chrome/Edge')); }, { once: true });
    this.layout(); this.el('ccPreviewStatus').textContent = '连续预览已生成，点击播放；修改标注、效果或配准后自动返回实时编辑。';
  }
  private playCachedPreview() {
    const cache = this.cachedPreview; if (!cache) return;
    if (!cache.video.paused) cache.video.pause(); else { if (cache.video.ended) cache.video.currentTime = 0; void cache.video.play().catch(e => this.fail(e)); }
    this.updatePlayback();
  }
  private clearCachedPreview(render = true) {
    const cache = this.cachedPreview; if (!cache) return;
    const time = cache.start + cache.video.currentTime; this.cachedPreview = undefined;
    cache.video.pause(); cache.video.removeAttribute('src'); cache.video.load(); cache.video.remove(); URL.revokeObjectURL(cache.url);
    if (!this.viewer.isDestroyed() && this.resumeRenderLoop !== undefined) this.viewer.useDefaultRenderLoop = this.resumeRenderLoop;
    this.resumeRenderLoop = undefined;
    if (this.presentation) this.presentation.style.visibility = '';
    this.el('ccPreviewStatus').textContent = '实时编辑 · 原视频分辨率。可重新生成连续预览。';
    if (render && this.active) { this.wantedPlaying = false; this.video.pause(); this.seekVideo(time); this.layout(); }
  }
  private downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async importManifest(file: File) {
    if (!this.files.video) throw new Error('请先选择原视频');
    const generation = this.inputGeneration, importGeneration = ++this.manifestImportGeneration, video = this.files.video;
    const manifest = parseVideoFrameManifest(await file.text()); await verifyVideoFrameSource(manifest, video);
    if (generation !== this.inputGeneration || importGeneration !== this.manifestImportGeneration || this.files.video !== video) return;
    this.leave(); this.autoSaveReady = false; this.savedId = undefined; ++this.sessionGeneration; this.exit(); ++this.inputGeneration; this.manifest = manifest; this.files.manifest = file; this.track = undefined;
    this.el<HTMLSelectElement>('ccTimeMode').value = 'photo-times'; this.el<HTMLInputElement>('ccFirstTime').value = '0'; this.el<HTMLInputElement>('ccInterval').value = '1';
    this.dirty(); this.el('ccExtractStatus').textContent = `已关联 ${manifest.frames.length} 张照片的实际视频帧时间。导入对应 CC XML 后即可融合。`;
  }
  private async extractFrames(toDirectory: boolean) {
    if (!this.files.video) throw new Error('请先选择要抽帧的原视频');
    if (this.extraction) return;
    if (this.active) this.leave();
    const file = this.files.video, generation = this.inputGeneration;
    const controller = new AbortController(); this.extraction = controller;
    this.el<HTMLButtonElement>('ccExtract').disabled = true; this.el<HTMLButtonElement>('ccExtractZip').disabled = true; this.el<HTMLButtonElement>('ccExtractCancel').disabled = false;
    try {
      const directory = toDirectory ? await pickVideoFrameDirectory() : undefined;
      const end = this.el<HTMLInputElement>('ccExtractEnd').value.trim();
      const pos = this.files.pos ? parseVideoPosCsv(await this.files.pos.text(), { frameRate: this.number('ccPosFrameRate'), firstTime: this.number('ccPosFirstTime') }) : undefined;
      const result = await extractVideoFrames(file, { start: this.number('ccExtractStart'), ...(end ? { end: Number(end) } : {}),
        pos,
        ...(this.el<HTMLSelectElement>('ccExtractMode').value === 'count' ? { count: this.number('ccExtractCount') } : { intervalSeconds: this.number('ccExtractInterval') }),
        signal: controller.signal, onProgress: progress => { this.el('ccExtractStatus').textContent = `已抽取 ${progress.completed} / ${progress.total} 张 · ${clock(progress.time)}`; },
      }, directory);
      if (controller.signal.aborted || generation !== this.inputGeneration) return;
      if (result.output.kind === 'zip') this.downloadBlob(result.output.blob, result.output.name);
      const manifestFile = new File([JSON.stringify(result.manifest, null, 2)], 'video-frame-manifest.json', { type: 'application/json' });
      // Import after releasing the extraction owner; exit() must not cancel completed work.
      this.extraction = undefined; await this.importManifest(manifestFile);
      this.el('ccExtractStatus').textContent = `已输出 ${result.manifest.frames.length} 张照片、时间清单和 ${pos ? 'All_Pos.csv 真实定位表' : 'All_Pos_template.csv 待填定位模板（未提供真实 POS）'}。在 CC 中保持照片文件名一致。`;
    } catch (error) {
      if (controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError') this.el('ccExtractStatus').textContent = '抽帧已取消';
      else throw error;
    } finally {
      if (this.extraction === controller) this.extraction = undefined;
      this.el<HTMLButtonElement>('ccExtract').disabled = false; this.el<HTMLButtonElement>('ccExtractZip').disabled = false; this.el<HTMLButtonElement>('ccExtractCancel').disabled = true;
    }
  }
  private waitForPresentedStart(time: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let remove = () => {};
      const cleanup = () => { clearTimeout(timer); remove(); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new DOMException('导出已取消', 'AbortError')); };
      const timer = window.setTimeout(() => { cleanup(); reject(new Error(`导出 ${time.toFixed(3)} 秒的模型或遮挡未就绪，未跳过该帧。请检查倾斜摄影覆盖或缩短导出范围`)); }, 45000);
      remove = this.viewer.scene.postRender.addEventListener(() => {
        const error = this.resources?.getOcclusionStatus().error;
        if (error) { cleanup(); reject(new Error(error)); return; }
        if (this.video.seeking || this.seeking || this.buffering || this.presentedTime === undefined) return;
        if (this.sourceTarget === undefined || Math.abs(this.sourceTarget - time) > 1e-5 || this.presentedTime !== this.pendingTime) return;
        cleanup(); resolve();
      });
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  private async exportVideo(preview = false) {
    if (this.exportAbort) return;
    this.clearCachedPreview();
    if (!this.active) await this.enter();
    if (!this.active || !this.track) return;
    const epoch = this.epoch, originalTime = this.presentedTime ?? this.video.currentTime, wasPlaying = this.wantedPlaying, originalRate = this.video.playbackRate, originalResolutionScale = this.viewer.resolutionScale;
    const start = this.el<HTMLInputElement>('ccExportStart').value.trim(), end = this.el<HTMLInputElement>('ccExportEnd').value.trim();
    const range = { start: start ? Number(start) : this.track.startTime, end: end ? Number(end) : Math.min(this.track.endTime, this.video.duration) };
    if (range.start < this.track.startTime || range.end > this.track.endTime + .001) throw new Error(`可导出 ${this.track.startTime.toFixed(3)}–${this.track.endTime.toFixed(3)} 秒；请修改区间，或清空开始和结束自动选择`);
    const exportOptions = { video: this.video, overlayCanvas: this.viewer.canvas, range, frameRate: this.number('ccExportFrameRate'),
      resolution: preview ? 'source' as const : this.el<HTMLSelectElement>('ccExportResolution').value as VideoOverlayExportResolution, includeAudio: this.el<HTMLInputElement>('ccExportAudio').checked };
    this.exportPlan = planVideoOverlayExport(exportOptions);
    const abort = new AbortController(); this.exportAbort = abort;
    this.presentationEditor.unmount();
    this.el<HTMLButtonElement>('ccExport').disabled = true; this.el<HTMLButtonElement>('ccExportCancel').disabled = false;
    const disabled: Array<[HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement, boolean]> = [];
    // A recording represents one immutable scheme. Do not mix camera edits or seeks into it.
    for (const item of [...this.el('ccResources').closest('section')!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,button,textarea'), ...this.controls!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,button,textarea')]) {
      if (item.id === 'ccExportCancel' || item.id === 'ccStop' || item.id === 'ccExit' || item.hasAttribute('data-cc-exit')) continue;
      disabled.push([item, item.disabled]); item.disabled = true;
    }
    try {
      this.wantedPlaying = false; this.video.pause(); this.video.playbackRate = 1;
      this.layout();
      const result = await exportVideoOverlayOffline({ ...exportOptions, sourceFile: this.files.video, fileName: `${this.files.video.name} · AR融合`, signal: abort.signal,
        getFrame: async (time, signal) => {
          if (!this.active || this.epoch !== epoch) throw new DOMException('融合已退出', 'AbortError');
          this.presentedTime = undefined; this.lastPresentationKey = '';
          // HTML media seeks can truncate across time-base conversions. Move
          // 0.1 ms inside the desired frame so 1/30 s cannot select its predecessor. Encoded PTS is
          // still the exact fixed-rate timeline; the camera uses actual source PTS.
          const seekTime = Math.min(range.end - 1e-7, time + 0.0001);
          const ready = this.waitForPresentedStart(seekTime, signal); this.seekVideo(seekTime); await ready;
          return this.presentation!;
        },
        onProgress: progress => {
          const now = performance.now(); if (progress.phase === 'frames' && now - this.lastProgressAt < 150 && progress.completed < progress.total) return; this.lastProgressAt = now;
          this.el('ccExportStatus').textContent = progress.phase === 'frames' ? `逐帧导出 ${progress.completed}/${progress.total} · ${Math.round(progress.fraction * 100)}% · ${(progress.bytes / 1024 / 1024).toFixed(1)} MiB` : progress.phase === 'audio' ? '画面已完整编码，正在处理原视频音轨…' : '正在完成连续视频文件…';
        },
      });
      if (preview) this.installCachedPreview(result.blob, range.start, range.end); else downloadVideoOverlayExport(result);
      this.el(preview ? 'ccPreviewStatus' : 'ccExportStatus').textContent = `${preview ? '连续预览已生成' : '已导出'} ${result.frames} 帧 · ${this.exportPlan.frameRate} fps · ${result.width}×${result.height} · WebM · ${result.silent ? '无音轨（源视频无音轨、超出音频处理上限或不支持解码）' : '含原视频音轨'}。`;
    } catch (error) {
      const cancelled = abort.signal.aborted || error instanceof DOMException && error.name === 'AbortError';
      abort.abort();
      if (cancelled) this.el('ccExportStatus').textContent = '导出已取消'; else throw error;
    } finally {
      abort.abort();
      if (this.active && this.epoch === epoch && !this.viewer.isDestroyed()) { this.viewer.resolutionScale = originalResolutionScale; this.viewer.resize(); }
      this.exportPlan = undefined; if (this.active && this.epoch === epoch) this.layout(); if (this.exportAbort === abort) this.exportAbort = undefined;
      for (const [item, value] of disabled) item.disabled = value;
      this.el<HTMLButtonElement>('ccExport').disabled = false; this.el<HTMLButtonElement>('ccExportCancel').disabled = true;
      if (this.active && this.epoch === epoch && this.editorCanvas) this.presentationEditor.mount(this.editorCanvas);
      if (this.active && this.epoch === epoch && !this.cachedPreview) {
        this.wantedPlaying = false; this.video.pause(); this.buffering = false; this.video.playbackRate = originalRate; this.seekVideo(originalTime);
        if (wasPlaying) { this.wantedPlaying = true; void this.video.play().catch(e => this.fail(e)); }
      }
    }
  }
  private renderFrame(time: number) {
    if (!this.active || !this.track || this.seeking) return;
    if (this.sceneReference) { try { this.checkSceneReference(); } catch (error) { this.accessInvalid = true; this.exit(); this.fail(error); return; } }
    if (this.occlusion.enabled) { try { this.checkOcclusionSource(); } catch (error) { this.accessInvalid = true; this.exit(); this.fail(error); return; } }
    this.lastFrameTime = time; this.pendingTime = time; const rawSample = this.track.sample(time);
    const registered = rawSample && (this.sceneReference ? transformCcCameraSample(rawSample, this.sceneReference.matrix) : rawSample);
    const sample = registered && (this.cameraRegistration.enabled ? transformCcCameraSample(registered, this.cameraCorrection) : registered);
    if (this.sampleVisible !== !!sample) { this.resources?.setVisible(!!sample); this.sampleVisible = !!sample; }
    this.resources?.setTimelineOpacity(evaluateVideoOverlayEffects(this.effects, time, [...this.selected], { occluderId: this.occlusion.enabled ? this.occlusion.sourceId : undefined }));
    const cameraKey = sample ? JSON.stringify([sample.position, sample.direction, sample.up]) : '';
    if (sample && cameraKey !== this.cameraKey) { this.viewer.camera.setView({ destination: v3(sample.position), orientation: { direction: v3(sample.direction), up: v3(sample.up) } }); this.cameraKey = cameraKey; }
    if (this.badge) this.badge.textContent = sample ? `${sample.interpolation === 0 || sample.interpolation === 1 ? '空三关键帧' : '关键帧间估计'} · ${clock(time)} · 透视叠加` : '当前时间没有空三定位，已隐藏工程叠加';
    this.updatePlayback(); this.viewer.scene.requestRender();
  }
  private updatePlayback() {
    if (!this.controls) return;
    if (this.cachedPreview) { const cached = this.cachedPreview; this.presentedTime = cached.start + cached.video.currentTime; this.lastFrameTime = this.presentedTime; this.wantedPlaying = !cached.video.paused; }
    this.controls.querySelector('[data-cc-play]')!.textContent = this.wantedPlaying ? '暂停' : '播放';
    this.controls.querySelector('.cc-clock')!.textContent = `${clock(this.presentedTime ?? this.video.currentTime)} / ${clock(this.video.duration)}`;
    this.controls.querySelector<HTMLInputElement>('[data-cc-seek]')!.value = String(this.cachedPreview ? this.presentedTime : this.video.currentTime);
  }
  refreshResources() {
    if (this.destroyed) return;
    const imports = this.options.getImports(), allowedIds = new Set(imports.map(item => item.id));
    this.accessInvalid = [...this.selected].some(id => !allowedIds.has(id));
    if (this.active && (this.sceneReference || this.occlusion.enabled)) {
      try { this.checkSceneReference(); this.checkOcclusionSource(); }
      catch (error) { this.accessInvalid = true; this.exit(); this.fail(error); return; }
    }
    this.refreshSceneReferences(); this.refreshOcclusionSources();
    const items = this.resources?.list().filter(item => allowedIds.has(item.id)) ?? imports.filter(r => ['CAD', 'Model', '3D Tiles'].includes(r.kind)).map(r => ({ id: r.id, name: r.name, kind: r.kind, available: true, description: '', error: undefined }));
    if ([...this.selected].some(id => !allowedIds.has(id))) this.accessInvalid = true;
    if (!this.selectionInitialized && items.length) { for (const item of items) if (item.kind !== '3D Tiles') this.selected.add(item.id); this.selectionInitialized = true; }
    const list = this.el('ccResources'); list.replaceChildren();
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'cc-resource'; const label = document.createElement('label'), check = document.createElement('input');
      const occluder = this.isOcclusionSource(item.id);
      check.type = 'checkbox'; check.checked = !occluder && this.selected.has(item.id); check.disabled = !item.available || occluder; check.dataset.ccResource = item.id;
      check.addEventListener('change', () => { if (check.checked) this.selected.add(item.id); else this.selected.delete(item.id); this.resources?.setSelection([...this.selected]); this.updateTargets(); this.dirty(); });
      label.append(check, document.createTextNode(`${item.name} · ${occluder ? '遮挡参照（仅深度）' : item.kind}`)); row.append(label);
      if (item.description || item.error) { const small = document.createElement('small'); small.textContent = item.error || item.description; row.append(small); } list.append(row);
    }
    if (!items.length) list.textContent = '请先导入并定位 CAD 或工程模型。';
    this.resources?.setSelection([...this.selected]);
    this.updateTargets();
  }
  private updateTargets() {
    const select = this.el<HTMLSelectElement>('ccTarget'), previous = select.value;
    select.replaceChildren(new Option('勾选对象整体平移', '*'));
    for (const item of this.options.getImports()) if (this.selected.has(item.id) && !this.isOcclusionSource(item.id)) select.add(new Option(item.name, item.id));
    this.presentationEditor.setTargets(this.options.getImports().filter(item => this.selected.has(item.id) && !this.isOcclusionSource(item.id)).map(item => ({ id: item.id, name: item.name })));
    select.value = [...select.options].some(o => o.value === previous) ? previous : '*'; this.syncAdjustmentInputs();
  }
  private targetIds() { const target = this.el<HTMLSelectElement>('ccTarget').value; return (target === '*' ? [...this.selected] : this.selected.has(target) ? [target] : []).filter(id => !this.isOcclusionSource(id)); }
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
    const from = forward ? this.redo : this.undo, to = forward ? this.undo : this.redo, value = from.at(-1); if (!value) return;
    try { this.checkOcclusionAdjustment(this.occlusion, value); } catch (error) { this.fail(error); return; }
    from.pop();
    to.push(structuredClone(this.adjustments)); this.adjustments = value; this.applyAdjustments(); this.syncAdjustmentInputs();
  }
  private startDrag(event: PointerEvent) {
    const mode = this.el<HTMLSelectElement>('ccDragMode').value;
    if (this.exportAbort || !this.active || mode === 'off' || event.button !== 0 || !this.targetIds().length || !this.track?.sample(this.lastFrameTime)) return;
    this.wantedPlaying = false; this.video.pause(); this.pushHistory();
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
  private captureSnapshot(): OverlaySnapshot {
    if (!this.metadata || !this.dataset || !this.files.video || !this.files.source) throw new Error('请先完成融合，再保存方案');
    // Revalidate edited timing from cached calibration/metadata without reviving
    // the decoder or renderer while another module is active.
    if (!this.track) {
      const timing = this.readTiming(), track = createCcCameraTrack(this.dataset, timing);
      if (track.startTime > this.metadata.duration || track.endTime > this.metadata.duration + .1) throw new Error('空三时间超出视频，请检查抽帧时间设置');
      this.timing = timing; this.track = track;
    }
    if (!this.timing) throw new Error('缺少已验证的抽帧时间');
    if (this.accessInvalid) throw new Error('方案引用的资源已不可用，请恢复访问后保存；原方案未修改');
    const name = this.el<HTMLInputElement>('ccSchemeName').value.trim() || `${this.files.video.name} · CC 融合`;
    return { name, files: { ...this.files }, settings: {
      schemeName: name, mode: 'cc-overlay', version: 1, timing: structuredClone(this.timing), selectedIds: [...this.selected],
      adjustments: structuredClone(this.adjustments), opacity: this.opacity, currentTime: this.active ? this.presentedTime ?? this.lastFrameTime : this.resumeTime,
      videoName: this.files.video.name, videoSize: this.files.video.size, width: this.metadata.width, height: this.metadata.height,
      annotations: structuredClone(this.annotations), effects: structuredClone(this.effects),
      posTiming: { frameRate: this.number('ccPosFrameRate'), firstTime: this.number('ccPosFirstTime') },
      ...(this.sceneReference ? { sceneReference: structuredClone(this.sceneReference) } : {}),
      cameraRegistration: structuredClone({ ...this.cameraRegistration, anchor: this.cameraAnchor }), occlusion: { ...this.occlusion },
    } };
  }
  private async queueSave() {
    clearTimeout(this.autosaveTimer); this.autosaveTimer = undefined;
    if (!this.autoSaveReady || this.accessInvalid || !this.onSave) return;
    let snapshot: OverlaySnapshot;
    try { snapshot = this.captureSnapshot(); }
    catch (error) { this.el('ccSavedState').textContent = `更改尚未保存：${error instanceof Error ? error.message : error}`; throw error; }
    await this.autosave.submit({ session: String(this.sessionGeneration), revision: this.editRevision, snapshot, existingId: this.savedId });
  }
  async save() {
    if (!this.metadata) await this.prepare(); else if (!this.track) this.captureSnapshot();
    if (!this.onSave) throw new Error('项目保存服务尚未就绪');
    if (this.accessInvalid) throw new Error('方案引用的资源已不可用，请恢复访问后保存');
    this.autoSaveReady = true; ++this.editRevision;
    const submitted = this.queueSave().catch(() => {});
    await this.autosave.retry(String(this.sessionGeneration)); await submitted;
  }
  async flushPendingSave() { if (this.autoSaveReady && (this.autosaveTimer !== undefined || this.editRevision > this.persistedRevision)) await this.queueSave(); await this.autosave.flush(); }
  private leave() {
    if (this.autoSaveReady && (this.active || this.autosaveTimer !== undefined || this.editRevision > this.persistedRevision)) { if (this.active) ++this.editRevision; void this.queueSave().catch(() => {}); }
    this.exit();
  }
  async restoreReplay(files: Record<string, File>, settings: SavedVideoOverlaySettings, recordId?: string) {
    this.leave(); this.clear();
    const restoreGeneration = this.inputGeneration;
    const checkRestore = () => { if (restoreGeneration !== this.inputGeneration || this.destroyed) throw new DOMException('融合方案已切换', 'AbortError'); };
    if (settings.mode !== 'cc-overlay' || settings.version !== 1 || !settings.timing) throw new Error('不支持的 CC 融合方案');
    if (!files.video || files.video.name !== settings.videoName || files.video.size !== settings.videoSize) throw new Error('保存的视频与融合方案不一致');
    this.files = { ...files }; this.savedId = recordId; this.adjustments = structuredClone(settings.adjustments ?? {}); this.selected = new Set(settings.selectedIds ?? []); this.selectionInitialized = true;
    this.occlusion = validateVideoOverlayOcclusion(settings.occlusion);
    this.annotations = (settings.annotations ?? []).map(validateVideoOverlayAnnotation); this.effects = validateVideoOverlayEffects(settings.effects); this.presentationEditor.setValue(this.annotations, this.effects);
    if (settings.sceneReference) {
      if (!settings.sceneReference.recordId || typeof settings.sceneReference.recordId !== 'string') throw new Error('保存的相机坐标关联无效');
      this.sceneReference = { recordId: settings.sceneReference.recordId, matrix: [...validateCcSceneTransform(settings.sceneReference.matrix)] };
    }
    this.cameraRegistration = validateCcCameraRegistration(settings.cameraRegistration);
    if (settings.cameraRegistration?.anchor) {
      this.cameraCorrection = createCcCameraRegistrationMatrix(settings.cameraRegistration.anchor, this.cameraRegistration);
      this.cameraAnchor = structuredClone(settings.cameraRegistration.anchor);
    } else if (this.cameraRegistration.enabled) throw new Error('保存的相机校正缺少首帧基准，请重置相机校正后重新保存');
    this.syncCameraInputs();
    this.refreshSceneReferences(); this.refreshOcclusionSources();
    this.el<HTMLInputElement>('ccPosFrameRate').value = String(settings.posTiming?.frameRate ?? 30); this.el<HTMLInputElement>('ccPosFirstTime').value = String(settings.posTiming?.firstTime ?? 0);
    this.el<HTMLInputElement>('ccSchemeName').value = settings.schemeName || `${files.video.name} · CC 融合`;
    if (files.manifest) { const manifest = parseVideoFrameManifest(await files.manifest.text()); checkRestore(); await verifyVideoFrameSource(manifest, files.video); checkRestore(); this.manifest = manifest; }
    const t = settings.timing;
    if (t.mode === 'photo-times' && !this.manifest) throw new Error('方案缺少平台抽帧清单，请重新导入');
    this.el<HTMLInputElement>('ccSmooth').checked = t.smoothing === 'cubic';
    for (const [id, value] of Object.entries({ ccFirstTime: t.firstTimeSeconds, ccInterval: t.intervalSeconds, ccTimeMode: t.mode, ccFilenameStep: t.filenameStep ?? 1, ccHeightReference: t.heightReference, ccHeightOffset: t.heightOffsetMeters ?? 0 })) this.el<HTMLInputElement>(id).value = String(value);
    this.syncHeightInputs();
    this.opacity = Math.min(1, Math.max(0, settings.opacity ?? .8)); this.el<HTMLInputElement>('ccOpacity').value = String(this.opacity);
    this.resumeTime = settings.currentTime || 0; await this.prepare(); checkRestore(); this.autoSaveReady = true; this.persistedRevision = this.editRevision; this.seekVideo(Math.max(0, Math.min(this.video.duration, settings.currentTime || 0))); this.refreshResources(); this.el('ccSavedState').textContent = '已恢复，点击“开始融合”查看';
  }
  setPanelActive(active: boolean) { if (!active) this.leave(); else this.refreshResources(); }
  async createDiagnostics() {
    await this.prepare(false);
    const time = this.active ? this.lastFrameTime : this.video.currentTime;
    let referenceError: string | null = null;
    try { this.checkSceneReference(); } catch (error) { referenceError = error instanceof Error ? error.message : String(error); }
    let occlusionError: string | null = null;
    try { this.checkOcclusionSource(); } catch (error) { occlusionError = error instanceof Error ? error.message : String(error); }
    const raw = this.track!.sample(time), rendered = raw && !referenceError ? (this.sceneReference ? transformCcCameraSample(raw, this.sceneReference.matrix) : raw) : null;
    const corrected = rendered && (this.cameraRegistration.enabled ? transformCcCameraSample(rendered, this.cameraCorrection) : rendered);
    return {
      format: 'cesium-cc-registration-diagnostic', version: 1, runtimeBuild: VIDEO_OVERLAY_BUILD, createdAt: new Date().toISOString(),
      video: { name: this.files.video.name, width: this.video.videoWidth, height: this.video.videoHeight, duration: this.video.duration,
        currentTime: this.video.currentTime, renderedTime: this.active ? time : null, seeking: this.video.seeking },
      xml: { name: this.files.source.name, photos: this.dataset!.photos.length, referenceSystems: this.dataset!.photogroups.map(group => group.referenceSystem),
        intrinsics: this.track!.intrinsics, distortion: this.track!.distortion, startTime: this.track!.startTime, endTime: this.track!.endTime },
      timing: this.timing, sceneReference: this.sceneReference ?? null, referenceError, rawCamera: raw, registeredCamera: rendered,
      cameraRegistration: { ...this.cameraRegistration, anchor: this.cameraAnchor ?? null, matrix: [...this.cameraCorrection] }, correctedCamera: corrected,
      occlusion: { ...this.occlusion, status: this.resources?.getOcclusionStatus() ?? null, error: occlusionError },
      liveCamera: this.active ? { position: this.viewer.camera.positionWC, direction: this.viewer.camera.directionWC, up: this.viewer.camera.upWC,
        projection: Matrix4.toArray(this.viewer.camera.frustum.projectionMatrix) } : null,
      viewport: { width: this.viewer.canvas.clientWidth, height: this.viewer.canvas.clientHeight, pixelWidth: this.viewer.canvas.width, pixelHeight: this.viewer.canvas.height },
      resources: this.options.getImports().filter(item => this.selected.has(item.id) || item.kind === '3D Tiles').map(item => {
        const resource = item.resource as unknown as { modelMatrix?: Matrix4; scale?: number; minimumPixelSize?: number; boundingSphere?: { center: Cartesian3; radius: number } };
        const record = this.options.getRecord(item.id); let sphere: { center: Cartesian3; radius: number } | undefined = item.boundingSphere;
        try { sphere ??= resource.boundingSphere; } catch { /* A not-yet-ready model has no evaluated sphere. */ }
        return { id: item.id, name: item.name, kind: item.kind, selected: this.selected.has(item.id), occluder: this.isOcclusionSource(item.id),
          savedMatrix: record?.settings.matrix ?? null, displayedMatrix: resource.modelMatrix ? Matrix4.toArray(resource.modelMatrix) : null,
          scale: resource.scale ?? null, minimumPixelSize: resource.minimumPixelSize ?? null,
          bounds: sphere ? { center: sphere.center, radius: sphere.radius } : null, adjustment: this.adjustments[item.id] ?? zero() };
      }),
      notes: ['诊断不含视频、影像或模型文件。', '场景中的对齐不等于空三和视频已配准；应核对同源成果、时间与高程。'],
    };
  }
  private async exportDiagnostics() {
    const diagnostic = await this.createDiagnostics();
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'cc-registration-diagnostic.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private exit() {
    const release = (action: () => void) => { try { action(); } catch (error) { console.warn('[CC AR] Cleanup continued after host error', error); } };
    release(() => this.clearCachedPreview(false)); release(() => this.presentationEditor.unmount());
    if (this.editorCanvas) { this.editorCanvas.width = 0; this.editorCanvas.height = 0; this.editorCanvas.remove(); this.editorCanvas = undefined; }
    ++this.epoch; ++this.frameGeneration; this.sampleVisible = undefined; const restore = this.restoreScene; this.restoreScene = undefined;
    release(() => this.exportAbort?.abort()); release(() => this.extraction?.abort()); this.wantedPlaying = false; this.buffering = false;
    if (this.video.readyState >= 1) this.resumeTime = this.presentedTime ?? this.video.currentTime;
    release(() => this.video.pause()); this.dragging = undefined; this.seeking = false; this.seekFrameTime = undefined; this.seekTarget = undefined;
    clearTimeout(this.seekWaitTimer); this.seekWaitTimer = undefined;
    if (this.frameHandle !== undefined) { const handle = this.frameHandle; release(() => this.video.cancelVideoFrameCallback?.(handle)); } this.frameHandle = undefined;
    if (this.animationHandle !== undefined) cancelAnimationFrame(this.animationHandle); this.animationHandle = undefined;
    release(() => this.resize?.disconnect()); this.resize = undefined;
    release(() => this.removePresentationGuard?.()); this.removePresentationGuard = undefined; this.lensFrame = undefined; this.renderReady = false; this.cameraKey = '';
    release(() => this.removeProjectionGuard?.()); this.removeProjectionGuard = undefined;
    release(() => this.removeOcclusionStatus?.()); this.removeOcclusionStatus = undefined;
    release(() => { if (this.lensStage && !this.viewer.isDestroyed()) this.viewer.scene.postProcessStages.remove(this.lensStage); }); this.lensStage = undefined;
    release(() => this.controller?.abort()); this.controller = undefined; release(() => this.resources?.restore()); this.resources = undefined;
    release(() => { if (restore && !this.viewer.isDestroyed()) restore(); });
    if (this.backdrop) { this.video.remove(); this.backdrop.remove(); this.backdrop = undefined; this.container.style.cssText = this.originalContainerStyle; }
    if (this.presentation) { this.presentation.width = 0; this.presentation.height = 0; this.presentation.remove(); } this.presentation = undefined;
    release(() => this.compositor?.dispose()); this.compositor = undefined;
    if (this.annotationFrame) { this.annotationFrame.width = 0; this.annotationFrame.height = 0; } this.annotationFrame = undefined; this.annotationKey = '';
    this.sourceTime = undefined; this.sourceTarget = undefined; this.pendingTime = undefined; this.presentedTime = undefined; this.lastPresentationKey = '';
    this.controls?.remove(); this.controls = undefined; this.badge?.remove(); this.badge = undefined;
    this.viewer.container.parentElement?.classList.remove('cc-video-active'); delete this.container.dataset.ccDrag;
    release(() => this.mediaLoad?.cancel()); release(() => this.video.removeAttribute('src')); release(() => this.video.load());
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl); this.mediaUrl = undefined; this.videoFile = undefined;
    const entered = this.enterHooksActive; this.enterHooksActive = false;
    release(() => { if (entered) this.options.onExit?.(); });
    release(() => { if (restore && !this.viewer.isDestroyed()) { this.viewer.resize(); this.viewer.scene.requestRender(); } });
    release(() => this.releaseRenderTargets?.()); this.releaseRenderTargets = undefined;
  }
  clear() {
    clearTimeout(this.autosaveTimer); this.autoSaveReady = false; this.accessInvalid = false; this.resumeTime = 0; this.metadata = undefined; this.manifest = undefined;
    ++this.sessionGeneration; ++this.inputGeneration; this.mediaLoad?.cancel(); this.exit(); this.video.removeAttribute('src'); this.video.load(); if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.resumeTime = 0; this.mediaUrl = undefined; this.videoFile = undefined; this.files = {}; this.savedId = undefined; this.dataset = undefined; this.track = undefined;
    this.sceneReference = undefined;
    this.occlusion = validateVideoOverlayOcclusion();
    this.cameraRegistration = defaultCcCameraRegistration(); this.cameraAnchor = undefined; this.cameraCorrection = Matrix4.toArray(Matrix4.IDENTITY); this.syncCameraInputs();
    this.annotations = []; this.effects = []; this.presentationEditor.setValue([], []);
    this.adjustments = {}; this.undo = []; this.redo = []; this.selected.clear(); this.selectionInitialized = false;
    this.el<HTMLInputElement>('ccVideoFile').value = ''; this.el<HTMLInputElement>('ccXmlFile').value = ''; this.refreshResources();
    this.el<HTMLInputElement>('ccPosFile').value = ''; this.el<HTMLInputElement>('ccManifestFile').value = '';
    this.el('ccOverlayInfo').textContent = '选择视频与 CC 空三 XML，无需 SRT。'; this.el('ccSavedState').textContent = '尚未保存';
  }
  destroy() { this.clear(); this.presentationEditor.destroy(); this.destroyed = true; for (const dispose of this.disposers.splice(0)) dispose(); }
}
