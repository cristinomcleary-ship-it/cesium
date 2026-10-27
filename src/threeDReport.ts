import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  LabelStyle,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Viewer,
} from "cesium";
import "./threeDReport.css";
import {
  ReportComposer,
  normalizeReportOverlayElements,
  reportComposerPanelHtml,
  reportComposerPresentationHtml,
  reportComposerWorkspaceHtml,
  type ReportElementAction,
  type ReportOverlayElement,
} from "./reportComposer";

export type ReportLayerSnapshot = {
  basemap?: string;
  layers: Array<{ id: string; name: string; kind: string; visible: boolean }>;
};

export type ThreeDReportLayerAdapter = {
  capture: () => ReportLayerSnapshot;
  apply: (snapshot: ReportLayerSnapshot) => void | Promise<void>;
  prepareForPicking?: () => void;
  beginSession?: () => (() => void);
};

type ReportCamera = {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
};

type ReportAnnotation = {
  id: string;
  title: string;
  note: string;
  longitude: number;
  latitude: number;
  height: number;
};

type ReportMedia = {
  type: "none" | "image" | "video" | "link";
  source: string;
  name: string;
};

type ReportSlide = {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  layout: "left" | "right" | "bottom" | "minimal";
  theme: "dark" | "light" | "blue";
  transitionSeconds: number;
  staySeconds: number;
  camera: ReportCamera | null;
  layers: ReportLayerSnapshot | null;
  annotations: ReportAnnotation[];
  media: ReportMedia;
  transition: "fly" | "fade" | "cut";
  showCard: boolean;
  elements: ReportOverlayElement[];
};

type ReportDocument = {
  version: 1 | 2;
  title: string;
  slides: ReportSlide[];
  updatedAt: string;
};

export type ThreeDReportOverviewPage = Readonly<{
  id: string;
  index: number;
  title: string;
  hasScene: boolean;
  annotationCount: number;
}>;
export type ThreeDReportOverviewSnapshot = Readonly<{
  title: string;
  slides: number;
  scenes: number;
  annotations: number;
  pages: ReadonlyArray<ThreeDReportOverviewPage>;
}>;
export type ThreeDReportOverviewListener = (snapshot: ThreeDReportOverviewSnapshot) => void;

const STORAGE_KEY = "cesium-three-d-report-v2";
const LEGACY_STORAGE_KEY = "cesium-three-d-report-v1";

export const threeDReportPanelHtml = `
  <section class="panel report-panel" data-panel="report">
    <div class="report-heading">
      <div><strong>3维汇报</strong><small>INTERACTIVE 3D PRESENTATION</small></div>
      <span id="reportSaveState">本机自动保存</span>
    </div>
    <p class="report-copy">像制作 PPT 一样组织三维场景。每一页可绑定当前镜头、图层显隐、文字、图片、视频和空间标注。</p>
    <label>汇报名称<input id="reportDocumentTitle" type="text" maxlength="80" placeholder="例如：项目建设进展汇报" /></label>

    <div class="report-summary">
      <div><span id="reportSlideCount">0</span><small>汇报页</small></div>
      <div><span id="reportSceneCount">0</span><small>已绑定场景</small></div>
      <div><span id="reportAnnotationCount">0</span><small>空间标注</small></div>
    </div>

    <div class="report-section-title"><strong>汇报页</strong><button id="reportAddSlide">＋ 新建一页</button></div>
    <div id="reportSlideList" class="report-slide-list"></div>
    <div id="reportSlideToolbar" class="report-slide-toolbar hidden">
      <button id="reportMoveSlideUp" title="上移">↑</button>
      <button id="reportMoveSlideDown" title="下移">↓</button>
      <button id="reportDuplicateSlide">复制</button>
      <button id="reportDeleteSlide" class="danger">删除</button>
    </div>

    <div id="reportSlideEditor" class="report-slide-editor hidden">
      <div class="report-section-title editor-title"><strong>页面内容</strong><span id="reportEditingPage"></span></div>
      <label>页面标题<input id="reportSlideTitle" type="text" maxlength="100" /></label>
      <label>副标题<input id="reportSlideSubtitle" type="text" maxlength="140" /></label>
      <label>讲解内容<textarea id="reportSlideBody" rows="4" maxlength="2000" placeholder="输入本页需要讲解的重点……"></textarea></label>
      <div class="field-grid">
        <label>版式<select id="reportSlideLayout"><option value="left">左侧说明</option><option value="right">右侧说明</option><option value="bottom">底部横幅</option><option value="minimal">简洁标题</option></select></label>
        <label>主题<select id="reportSlideTheme"><option value="dark">深色工程</option><option value="blue">科技蓝</option><option value="light">明亮简洁</option></select></label>
        <label>页面转场<select id="reportTransitionType"><option value="fly">镜头飞行</option><option value="fade">淡入淡出</option><option value="cut">直接切换</option></select></label>
        <label>镜头过渡（秒）<input id="reportTransitionSeconds" type="number" min="0" max="30" step="0.5" /></label>
        <label>自动停留（秒）<input id="reportStaySeconds" type="number" min="1" max="300" step="1" /></label>
      </div>
      <label class="report-card-visibility"><input id="reportShowCard" type="checkbox" /> 显示传统标题说明卡片</label>

      <div class="report-section-title"><strong>三维场景</strong><span id="reportSceneState">尚未绑定</span></div>
      <div class="report-scene-actions">
        <button id="reportCaptureScene" class="accent">记录当前镜头和图层</button>
        <button id="reportLocateScene">定位到本页</button>
      </div>
      <p class="hint">记录时会保存当前相机位置、方向、底图和“已加载内容”的显隐状态，不复制或修改原始数据。</p>

      ${reportComposerPanelHtml}

      <div class="report-section-title"><strong>媒体内容</strong><span>可选</span></div>
      <label>内容类型<select id="reportMediaType"><option value="none">无媒体</option><option value="image">图片</option><option value="video">视频</option><option value="link">外部链接</option></select></label>
      <div id="reportImageFields" class="hidden">
        <label class="report-file-button">选择本地图片<input id="reportImageFile" type="file" accept="image/png,image/jpeg,image/webp" hidden /></label>
        <div id="reportImageName" class="report-media-name">尚未选择图片</div>
      </div>
      <div id="reportUrlFields" class="hidden">
        <label><span id="reportUrlLabel">视频地址</span><input id="reportMediaUrl" type="url" placeholder="https://..." /></label>
        <label id="reportVideoFileLabel" class="report-file-button">或选择本地视频（仅本次打开有效）<input id="reportVideoFile" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" hidden /></label>
        <div id="reportVideoName" class="report-media-name"></div>
      </div>
      <button id="reportClearMedia" class="report-quiet-button hidden">清除本页媒体</button>

      <div class="report-section-title"><strong>空间标注</strong><span id="reportAnnotationState">0 个</span></div>
      <div class="field-grid report-annotation-fields">
        <label>标注名称<input id="reportAnnotationTitle" type="text" maxlength="60" placeholder="例如：主入口" /></label>
        <label>说明<input id="reportAnnotationNote" type="text" maxlength="160" placeholder="可选" /></label>
      </div>
      <button id="reportPickAnnotation" class="report-pick-button">在模型或地图上点选标注位置</button>
      <div id="reportAnnotationList" class="report-annotation-list"></div>
    </div>

    <div class="report-presentation-actions">
      <button id="reportPresentCurrent">从当前页演示</button>
      <button id="reportPresentAll" class="accent">▶ 自动演示全部</button>
    </div>
    <div class="report-file-actions">
      <button id="reportExport">导出汇报文件</button>
      <label>导入汇报文件<input id="reportImportFile" type="file" accept="application/json,.json,.3dreport" hidden /></label>
    </div>
    <div id="reportStatus" class="report-status">汇报内容仅保存在本机浏览器，可随时导出备份。</div>
  </section>`;

export const threeDReportStageHtml = `
  ${reportComposerWorkspaceHtml}
  <div id="threeDReportStage" class="report-stage" aria-hidden="true">
    <div class="report-stage-progress"><span id="reportStageDocument"></span><b id="reportStagePage"></b></div>
    <article id="reportStageCard" class="report-stage-card layout-left theme-dark">
      <div class="report-stage-kicker" id="reportStageSubtitle"></div>
      <h1 id="reportStageTitle"></h1>
      <p id="reportStageBody"></p>
      <div id="reportStageMedia" class="report-stage-media hidden">
        <img id="reportStageImage" class="hidden" alt="汇报页面图片" />
        <video id="reportStageVideo" class="hidden" controls playsinline></video>
        <a id="reportStageLink" class="hidden" target="_blank" rel="noopener noreferrer">打开相关资料 ↗</a>
      </div>
    </article>
    ${reportComposerPresentationHtml}
    <div id="reportLaserPointer" class="report-laser-pointer"></div>
    <div class="report-stage-controls">
      <button id="reportStagePrevious" title="上一页">←</button>
      <button id="reportStageAuto">自动播放</button>
      <button id="reportStageLaser">激光笔</button>
      <button id="reportStageNext" title="下一页">→</button>
      <button id="reportStageExit" class="exit">退出并恢复场景</button>
    </div>
  </div>`;

function byId<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`3维汇报控件缺失：${id}`);
  return target as T;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function finite(value: unknown, fallback: number, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

function emptyDocument(): ReportDocument {
  return { version: 2, title: "项目三维汇报", slides: [], updatedAt: new Date().toISOString() };
}

function normalizeCamera(value: unknown): ReportCamera | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ReportCamera>;
  const longitude = Number(source.longitude);
  const latitude = Number(source.latitude);
  const height = Number(source.height);
  if (![longitude, latitude, height].every(Number.isFinite)
    || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
    || height < -100_000 || height > 1_000_000_000) return null;
  return {
    longitude,
    latitude,
    height,
    heading: finite(source.heading, 0),
    pitch: finite(source.pitch, -45),
    roll: finite(source.roll, 0),
  };
}

function normalizeLayerSnapshot(value: unknown): ReportLayerSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ReportLayerSnapshot>;
  if (!Array.isArray(source.layers)) return null;
  return {
    basemap: typeof source.basemap === "string" ? source.basemap : undefined,
    layers: source.layers.slice(0, 5_000).filter((layer): layer is ReportLayerSnapshot["layers"][number] => Boolean(
      layer && typeof layer.id === "string" && typeof layer.name === "string" && typeof layer.kind === "string" && typeof layer.visible === "boolean",
    )).map((layer) => ({ id: layer.id.slice(0, 200), name: layer.name.slice(0, 300), kind: layer.kind.slice(0, 100), visible: layer.visible })),
  };
}

function normalizeDocument(value: unknown): ReportDocument {
  if (!value || typeof value !== "object") throw new Error("不是有效的三维汇报文件");
  const source = value as Partial<ReportDocument>;
  const sourceVersion = Number(source.version ?? 1);
  if (Number.isFinite(sourceVersion) && sourceVersion > 2) throw new Error("该汇报文件由更高版本创建，请升级系统后再导入");
  if (!Array.isArray(source.slides)) throw new Error("汇报文件中缺少页面数据");
  const layouts = new Set<ReportSlide["layout"]>(["left", "right", "bottom", "minimal"]);
  const themes = new Set<ReportSlide["theme"]>(["dark", "light", "blue"]);
  const transitions = new Set<ReportSlide["transition"]>(["fly", "fade", "cut"]);
  const mediaTypes = new Set<ReportMedia["type"]>(["none", "image", "video", "link"]);
  const usedSlideIds = new Set<string>();
  const usedElementIds = new Set<string>();
  const slides = source.slides.slice(0, 200).map((raw, index): ReportSlide => {
    const slide = (raw && typeof raw === "object" ? raw : {}) as Partial<ReportSlide>;
    const usedAnnotationIds = new Set<string>();
    const annotations = Array.isArray(slide.annotations) ? slide.annotations.slice(0, 500).flatMap((rawAnnotation) => {
      if (!rawAnnotation || typeof rawAnnotation !== "object") return [];
      const annotation = rawAnnotation as Partial<ReportAnnotation>;
      const longitude = Number(annotation.longitude);
      const latitude = Number(annotation.latitude);
      const height = Number(annotation.height);
      if (![longitude, latitude, height].every(Number.isFinite)
        || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
        || height < -100_000 || height > 1_000_000_000) return [];
      const requestedId = typeof annotation.id === "string" && annotation.id ? annotation.id.slice(0, 200) : crypto.randomUUID();
      const id = usedAnnotationIds.has(requestedId) ? crypto.randomUUID() : requestedId;
      usedAnnotationIds.add(id);
      return [{
        id,
        title: typeof annotation.title === "string" ? annotation.title.slice(0, 60) : "空间标注",
        note: typeof annotation.note === "string" ? annotation.note.slice(0, 160) : "",
        longitude,
        latitude,
        height,
      }];
    }) : [];
    const media = slide.media && typeof slide.media === "object" ? slide.media as Partial<ReportMedia> : {};
    const requestedSlideId = typeof slide.id === "string" && slide.id ? slide.id.slice(0, 200) : crypto.randomUUID();
    const slideId = usedSlideIds.has(requestedSlideId) ? crypto.randomUUID() : requestedSlideId;
    usedSlideIds.add(slideId);
    const elements = normalizeReportOverlayElements(slide.elements).map((element) => {
      if (usedElementIds.has(element.id)) element.id = crypto.randomUUID();
      usedElementIds.add(element.id);
      return element;
    });
    return {
      id: slideId,
      title: typeof slide.title === "string" ? slide.title.slice(0, 100) : `汇报页 ${index + 1}`,
      subtitle: typeof slide.subtitle === "string" ? slide.subtitle.slice(0, 140) : "",
      body: typeof slide.body === "string" ? slide.body.slice(0, 2000) : "",
      layout: layouts.has(slide.layout as ReportSlide["layout"]) ? slide.layout as ReportSlide["layout"] : "left",
      theme: themes.has(slide.theme as ReportSlide["theme"]) ? slide.theme as ReportSlide["theme"] : "dark",
      transitionSeconds: finite(slide.transitionSeconds, 2, 0, 30),
      staySeconds: finite(slide.staySeconds, 6, 1, 300),
      transition: transitions.has(slide.transition as ReportSlide["transition"]) ? slide.transition as ReportSlide["transition"] : "fly",
      showCard: typeof slide.showCard === "boolean" ? slide.showCard : true,
      elements,
      camera: normalizeCamera(slide.camera),
      layers: normalizeLayerSnapshot(slide.layers),
      annotations,
      media: {
        type: mediaTypes.has(media.type as ReportMedia["type"]) ? media.type as ReportMedia["type"] : "none",
        source: typeof media.source === "string" ? media.source.slice(0, 4_000_000) : "",
        name: typeof media.name === "string" ? media.name.slice(0, 200) : "",
      },
    };
  });
  return {
    version: 2,
    title: typeof source.title === "string" && source.title.trim() ? source.title.slice(0, 80) : "项目三维汇报",
    slides,
    updatedAt: new Date().toISOString(),
  };
}

async function imageFileToDataUrl(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("请选择 PNG、JPG 或 WebP 图片");
  if (file.size > 30 * 1024 * 1024) throw new Error("图片超过 30MB，请先压缩后再导入");
  const bitmap = await createImageBitmap(file);
  try {
    const maximumDimension = 1440;
    const scale = Math.min(1, maximumDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理该图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let result = canvas.toDataURL("image/jpeg", 0.82);
    if (result.length > 1_200_000) result = canvas.toDataURL("image/jpeg", 0.64);
    if (result.length > 2_000_000) throw new Error("图片压缩后仍然过大，请选择尺寸更小的图片");
    return result;
  } finally {
    bitmap.close();
  }
}

export class ThreeDReport {
  private document = emptyDocument();
  private selectedSlideId: string | null = null;
  private readonly markers = new CustomDataSource("3维汇报空间标注");
  private pickHandler: ScreenSpaceEventHandler | null = null;
  private restorePickingSession: (() => void) | null = null;
  private presenting = false;
  private currentPresentationIndex = 0;
  private autoPlaying = false;
  private autoTimer: number | undefined;
  private transitionToken = 0;
  private laserEnabled = false;
  private prePresentationCamera: ReportCamera | null = null;
  private prePresentationLayers: ReportLayerSnapshot | null = null;
  private restorePresentationSession: (() => void) | null = null;
  private readonly localVideoUrls = new Map<string, string>();
  private readonly composer: ReportComposer;
  private readonly lifecycle = new AbortController();
  private persistTimer: number | undefined;
  private activeStorageKey = STORAGE_KEY;
  private readonly overviewListeners = new Set<ThreeDReportOverviewListener>();

  constructor(
    private readonly viewer: Viewer,
    private readonly toast: (message: string, error?: boolean) => void,
    private readonly layerAdapter: ThreeDReportLayerAdapter,
  ) {
    this.loadLocalDocument();
    void this.viewer.dataSources.add(this.markers);
    this.composer = new ReportComposer({
      getSlide: () => this.selectedSlide(),
      getPages: () => this.document.slides.map((slide) => ({ id: slide.id, title: slide.title || "未命名页面" })),
      getLayers: () => this.layerAdapter.capture().layers,
      loadImage: imageFileToDataUrl,
      changed: () => {
        this.persist();
        const slide = this.selectedSlide();
        if (slide) byId<HTMLInputElement>("reportShowCard").checked = slide.showCard;
        if (this.presenting) this.renderStage();
      },
      removeElement: id => this.removeOverlayElement(id),
      executeAction: (action) => { void this.executeElementAction(action); },
      toast: this.toast,
      beginInteractionSession: () => this.layerAdapter.beginSession?.() ?? (() => undefined),
    });
    this.bindControls();
    this.renderAll();
    this.setMarkerVisibility(false);
  }

  dispose() {
    this.stopAutoPlay();
    this.cancelPicking();
    this.transitionToken += 1;
    this.lifecycle.abort();
    this.composer.dispose();
    this.flushPersist();
    try { this.restorePresentationSession?.(); } catch (error) { console.warn("[3D report] Unable to restore an interrupted session", error); }
    this.restorePresentationSession = null;
    for (const url of this.localVideoUrls.values()) URL.revokeObjectURL(url);
    this.localVideoUrls.clear();
    this.overviewListeners.clear();
    document.body.classList.remove("report-presentation-mode");
    if (!this.viewer.isDestroyed() && this.viewer.dataSources.contains(this.markers)) this.viewer.dataSources.remove(this.markers, true);
  }

  getOverviewSnapshot(): ThreeDReportOverviewSnapshot {
    const scenes = this.document.slides.filter((slide) => slide.camera !== null).length;
    const annotations = this.document.slides.reduce((total, slide) => total + slide.annotations.length, 0);
    const pages = this.document.slides.slice(0, 100).map((slide, index) => Object.freeze({
      id: slide.id,
      index: index + 1,
      title: slide.title,
      hasScene: slide.camera !== null,
      annotationCount: slide.annotations.length,
    }));
    return Object.freeze({
      title: this.document.title,
      slides: this.document.slides.length,
      scenes,
      annotations,
      pages: Object.freeze(pages),
    });
  }

  subscribeOverview(listener: ThreeDReportOverviewListener): () => void {
    if (this.lifecycle.signal.aborted) return () => undefined;
    this.overviewListeners.add(listener);
    this.notifyOverviewListener(listener, this.getOverviewSnapshot());
    return () => { this.overviewListeners.delete(listener); };
  }

  private notifyOverviewListener(listener: ThreeDReportOverviewListener, snapshot: ThreeDReportOverviewSnapshot) {
    try { listener(snapshot); }
    catch (error) { console.error("[3D report] Overview listener failed", error); }
  }

  private notifyOverviewListeners() {
    if (this.lifecycle.signal.aborted || !this.overviewListeners.size) return;
    const snapshot = this.getOverviewSnapshot();
    for (const listener of [...this.overviewListeners]) this.notifyOverviewListener(listener, snapshot);
  }

  private bindControls() {
    byId<HTMLInputElement>("reportDocumentTitle").addEventListener("input", (event) => {
      this.document.title = (event.currentTarget as HTMLInputElement).value.slice(0, 80);
      this.persist();
      this.renderSummary();
      if (this.presenting) this.renderStage();
      this.notifyOverviewListeners();
    });
    byId<HTMLButtonElement>("reportAddSlide").addEventListener("click", () => this.addSlide());
    byId<HTMLButtonElement>("reportDuplicateSlide").addEventListener("click", () => this.duplicateSelected());
    byId<HTMLButtonElement>("reportDeleteSlide").addEventListener("click", () => this.deleteSelected());
    byId<HTMLButtonElement>("reportMoveSlideUp").addEventListener("click", () => this.moveSelected(-1));
    byId<HTMLButtonElement>("reportMoveSlideDown").addEventListener("click", () => this.moveSelected(1));
    this.bindSlideText("reportSlideTitle", "title", 100, true);
    this.bindSlideText("reportSlideSubtitle", "subtitle", 140);
    this.bindSlideText("reportSlideBody", "body", 2000);
    byId<HTMLSelectElement>("reportSlideLayout").addEventListener("change", (event) => this.updateSlide((slide) => {
      slide.layout = (event.currentTarget as HTMLSelectElement).value as ReportSlide["layout"];
    }));
    byId<HTMLSelectElement>("reportSlideTheme").addEventListener("change", (event) => this.updateSlide((slide) => {
      slide.theme = (event.currentTarget as HTMLSelectElement).value as ReportSlide["theme"];
    }));
    byId<HTMLSelectElement>("reportTransitionType").addEventListener("change", (event) => this.updateSlide((slide) => {
      const value = (event.currentTarget as HTMLSelectElement).value as ReportSlide["transition"];
      if (["fly", "fade", "cut"].includes(value)) slide.transition = value;
    }));
    byId<HTMLInputElement>("reportTransitionSeconds").addEventListener("change", (event) => this.updateSlide((slide) => {
      slide.transitionSeconds = finite((event.currentTarget as HTMLInputElement).value, 2, 0, 30);
    }, true));
    byId<HTMLInputElement>("reportStaySeconds").addEventListener("change", (event) => this.updateSlide((slide) => {
      slide.staySeconds = finite((event.currentTarget as HTMLInputElement).value, 6, 1, 300);
    }, true));
    byId<HTMLInputElement>("reportShowCard").addEventListener("change", (event) => this.updateSlide((slide) => {
      slide.showCard = (event.currentTarget as HTMLInputElement).checked;
    }));
    byId<HTMLButtonElement>("reportCaptureScene").addEventListener("click", () => this.captureSelectedScene());
    byId<HTMLButtonElement>("reportLocateScene").addEventListener("click", () => void this.locateSelectedScene());
    byId<HTMLSelectElement>("reportMediaType").addEventListener("change", (event) => this.updateSlide((slide) => {
      const type = (event.currentTarget as HTMLSelectElement).value as ReportMedia["type"];
      slide.media.type = type;
      if (type !== "video") this.releaseLocalVideo(slide.id);
      if (type === "none") slide.media = { type: "none", source: "", name: "" };
    }, true));
    byId<HTMLInputElement>("reportMediaUrl").addEventListener("input", (event) => this.updateSlide((slide) => {
      slide.media.source = (event.currentTarget as HTMLInputElement).value.trim();
      slide.media.name = "";
      this.releaseLocalVideo(slide.id);
    }));
    byId<HTMLInputElement>("reportImageFile").addEventListener("change", (event) => void this.loadImage((event.currentTarget as HTMLInputElement).files?.[0]));
    byId<HTMLInputElement>("reportVideoFile").addEventListener("change", (event) => this.loadLocalVideo((event.currentTarget as HTMLInputElement).files?.[0]));
    byId<HTMLButtonElement>("reportClearMedia").addEventListener("click", () => this.clearMedia());
    byId<HTMLButtonElement>("reportPickAnnotation").addEventListener("click", () => this.beginAnnotationPick());
    byId<HTMLButtonElement>("reportPresentCurrent").addEventListener("click", () => this.startPresentation(false));
    byId<HTMLButtonElement>("reportPresentAll").addEventListener("click", () => this.startPresentation(true, 0));
    byId<HTMLButtonElement>("reportExport").addEventListener("click", () => this.exportDocument());
    byId<HTMLInputElement>("reportImportFile").addEventListener("change", (event) => void this.importDocument((event.currentTarget as HTMLInputElement).files?.[0]));
    byId<HTMLButtonElement>("reportStagePrevious").addEventListener("click", () => void this.showPresentationSlide(this.currentPresentationIndex - 1));
    byId<HTMLButtonElement>("reportStageNext").addEventListener("click", () => void this.showPresentationSlide(this.currentPresentationIndex + 1));
    byId<HTMLButtonElement>("reportStageAuto").addEventListener("click", () => this.toggleAutoPlay());
    byId<HTMLButtonElement>("reportStageLaser").addEventListener("click", () => this.toggleLaser());
    byId<HTMLButtonElement>("reportStageExit").addEventListener("click", () => void this.exitPresentation());
    document.addEventListener("keydown", (event) => this.handleKeydown(event), { signal: this.lifecycle.signal });
    const viewport = byId<HTMLElement>("threeDReportStage").parentElement;
    viewport?.addEventListener("pointermove", (event) => this.moveLaser(event), { signal: this.lifecycle.signal });
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => tab.addEventListener("click", () => {
      if (!this.presenting) this.setMarkerVisibility(tab.dataset.tab === "report");
      if (tab.dataset.tab !== "report") this.cancelPicking();
      this.composer.setReportTabActive(tab.dataset.tab === "report");
    }, { signal: this.lifecycle.signal }));
  }

  private bindSlideText(id: string, field: "title" | "subtitle" | "body", limit: number, refreshList = false) {
    byId<HTMLInputElement | HTMLTextAreaElement>(id).addEventListener("input", (event) => this.updateSlide((slide) => {
      slide[field] = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value.slice(0, limit);
    }, false, refreshList));
  }

  private updateSlide(mutator: (slide: ReportSlide) => void, refreshEditor = false, refreshList = false) {
    const slide = this.selectedSlide();
    if (!slide) return;
    mutator(slide);
    this.persist();
    if (refreshList) this.renderSlideList();
    if (refreshEditor) this.renderEditor();
    else {
      this.updateMediaControls(slide);
      if (this.presenting) this.renderStage();
    }
    this.renderSummary();
    this.notifyOverviewListeners();
  }

  private loadLocalDocument() {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    let restored = false;
    if (current) {
      try {
        this.document = normalizeDocument(JSON.parse(current));
        restored = true;
      } catch (error) {
        console.warn("[3D report] Current report record is invalid; trying the legacy record", error);
      }
    }
    if (!restored && legacy) {
      try {
        this.document = normalizeDocument(JSON.parse(legacy));
        restored = true;
        // Keep saving in-place when no v2 record exists, avoiding a second large
        // localStorage copy that could discard a valid image-heavy legacy report.
        this.activeStorageKey = current ? STORAGE_KEY : LEGACY_STORAGE_KEY;
      } catch (error) {
        console.warn("[3D report] Unable to restore the legacy report record", error);
      }
    }
    if (!restored) this.document = emptyDocument();
    this.selectedSlideId = this.document.slides[0]?.id ?? null;
  }

  private persist() {
    this.document.updatedAt = new Date().toISOString();
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    const state = document.getElementById("reportSaveState");
    if (state) state.textContent = "正在保存…";
    this.persistTimer = window.setTimeout(() => this.flushPersist(), 180);
  }

  private flushPersist() {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    try {
      localStorage.setItem(this.activeStorageKey, JSON.stringify(this.document));
      const state = document.getElementById("reportSaveState");
      if (state) state.textContent = "已自动保存";
    } catch (error) {
      console.warn("[3D report] Local storage quota exceeded", error);
      const state = document.getElementById("reportSaveState");
      if (state) state.textContent = "本机空间不足，请导出备份";
    }
  }

  private commitDeletion(next: ReportDocument): boolean {
    const committed = { ...next, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(this.activeStorageKey, JSON.stringify(committed)); }
    catch (error) {
      const state = document.getElementById("reportSaveState");
      if (state) state.textContent = "删除未保存，原数据已保留";
      this.toast(error instanceof Error ? `删除未保存，原数据已保留：${error.message}` : "删除未保存，原数据已保留", true);
      return false;
    }
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.document = committed;
    const state = document.getElementById("reportSaveState");
    if (state) state.textContent = "已自动保存";
    return true;
  }

  private addSlide() {
    const slide: ReportSlide = {
      id: crypto.randomUUID(),
      title: `汇报页 ${this.document.slides.length + 1}`,
      subtitle: "",
      body: "",
      layout: "left",
      theme: "dark",
      transition: "fly",
      transitionSeconds: 2,
      staySeconds: 6,
      showCard: true,
      elements: [],
      camera: this.captureCamera(),
      layers: this.layerAdapter.capture(),
      annotations: [],
      media: { type: "none", source: "", name: "" },
    };
    this.document.slides.push(slide);
    this.selectedSlideId = slide.id;
    this.persist();
    this.renderAll();
    this.toast("已新建汇报页，并记录当前三维场景");
  }

  private duplicateSelected() {
    const selected = this.selectedSlide();
    if (!selected) return;
    const copy = structuredClone(selected);
    copy.id = crypto.randomUUID();
    copy.title = `${selected.title}（副本）`.slice(0, 100);
    copy.annotations.forEach((annotation) => { annotation.id = crypto.randomUUID(); });
    copy.elements.forEach((element, elementIndex) => {
      const sourceElement = selected.elements[elementIndex];
      const previousId = element.id;
      element.id = crypto.randomUUID();
      this.composer.copyTransientVideoSource(sourceElement?.id ?? previousId, element.id);
    });
    const selectedVideo = this.localVideoUrls.get(selected.id);
    if (selectedVideo) this.localVideoUrls.set(copy.id, selectedVideo);
    const index = this.document.slides.indexOf(selected);
    this.document.slides.splice(index + 1, 0, copy);
    this.selectedSlideId = copy.id;
    this.persist();
    this.renderAll();
  }

  private deleteSelected() {
    const selected = this.selectedSlide();
    if (!selected || !window.confirm(`确定删除“${selected.title}”吗？`)) return;
    const index = this.document.slides.indexOf(selected);
    if (!this.commitDeletion({ ...this.document, slides: this.document.slides.filter(slide => slide !== selected) })) return;
    this.releaseLocalVideo(selected.id);
    this.composer.releaseTransientMediaForElements(selected.elements);
    this.selectedSlideId = this.document.slides[Math.min(index, this.document.slides.length - 1)]?.id ?? null;
    this.renderAll();
  }

  private moveSelected(offset: number) {
    const selected = this.selectedSlide();
    if (!selected) return;
    const from = this.document.slides.indexOf(selected);
    const to = Math.max(0, Math.min(this.document.slides.length - 1, from + offset));
    if (from === to) return;
    this.document.slides.splice(from, 1);
    this.document.slides.splice(to, 0, selected);
    this.persist();
    this.renderAll();
  }

  private captureCamera(): ReportCamera {
    const cartographic = Cartographic.fromCartesian(this.viewer.camera.positionWC);
    return {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      height: cartographic.height,
      heading: CesiumMath.toDegrees(this.viewer.camera.heading),
      pitch: CesiumMath.toDegrees(this.viewer.camera.pitch),
      roll: CesiumMath.toDegrees(this.viewer.camera.roll),
    };
  }

  private captureSelectedScene() {
    const slide = this.selectedSlide();
    if (!slide) return;
    slide.camera = this.captureCamera();
    slide.layers = this.layerAdapter.capture();
    this.persist();
    this.renderAll();
    this.toast(`已记录本页镜头和 ${slide.layers.layers.length} 个图层状态`);
  }

  private async locateSelectedScene() {
    const slide = this.selectedSlide();
    if (!slide?.camera) return this.toast("本页尚未绑定三维场景", true);
    try {
      await this.applySlideScene(slide, true);
      this.renderMarkers(slide);
    } catch (error) {
      console.error("[3D report] Unable to locate slide scene", error);
      this.toast("本页场景定位失败，已有工程图层不会被移除", true);
    }
  }

  private async applySlideScene(slide: ReportSlide, animate: boolean) {
    if (slide.layers) await this.layerAdapter.apply(slide.layers);
    if (!slide.camera) return;
    const camera = slide.camera;
    this.viewer.camera.cancelFlight();
    if (!animate || camera.height > 50_000_000) {
      this.viewer.camera.setView({
        destination: Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
        orientation: {
          heading: CesiumMath.toRadians(camera.heading),
          pitch: CesiumMath.toRadians(camera.pitch),
          roll: CesiumMath.toRadians(camera.roll),
        },
      });
      this.viewer.scene.requestRender();
      return;
    }
    await new Promise<void>((resolve) => {
      this.viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
        orientation: {
          heading: CesiumMath.toRadians(camera.heading),
          pitch: CesiumMath.toRadians(camera.pitch),
          roll: CesiumMath.toRadians(camera.roll),
        },
        duration: slide.transitionSeconds,
        complete: resolve,
        cancel: resolve,
      });
    });
  }

  private async loadImage(file: File | undefined) {
    const slide = this.selectedSlide();
    if (!file || !slide) return;
    try {
      this.setStatus("正在压缩图片并保存到汇报文件……");
      slide.media = { type: "image", source: await imageFileToDataUrl(file), name: file.name };
      this.persist();
      this.renderEditor();
      this.toast("图片已加入当前汇报页");
      this.setStatus("图片已压缩并保存在本机汇报中。");
    } catch (error) {
      this.toast(error instanceof Error ? error.message : "图片读取失败", true);
      this.setStatus("图片读取失败，请尝试尺寸更小的 JPG 或 PNG。", true);
    } finally {
      byId<HTMLInputElement>("reportImageFile").value = "";
    }
  }

  private loadLocalVideo(file: File | undefined) {
    const slide = this.selectedSlide();
    if (!file || !slide) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) return this.toast("请选择视频文件", true);
    this.releaseLocalVideo(slide.id);
    const url = URL.createObjectURL(file);
    this.localVideoUrls.set(slide.id, url);
    slide.media = { type: "video", source: "", name: file.name };
    this.persist();
    this.renderEditor();
    this.toast("本地视频已加入；导出汇报时不会复制视频文件");
    this.setStatus("本地视频仅在本次打开期间有效；长期使用请填写可访问的视频地址。");
    byId<HTMLInputElement>("reportVideoFile").value = "";
  }

  private clearMedia() {
    const slide = this.selectedSlide();
    if (!slide) return;
    const nextSlide: ReportSlide = { ...slide, media: { type: "none", source: "", name: "" } };
    if (!this.commitDeletion({ ...this.document, slides: this.document.slides.map(item => item === slide ? nextSlide : item) })) return;
    this.releaseLocalVideo(slide.id);
    this.renderEditor();
  }

  private releaseLocalVideo(slideId: string) {
    const url = this.localVideoUrls.get(slideId);
    if (!url) return;
    this.localVideoUrls.delete(slideId);
    if (![...this.localVideoUrls.values()].includes(url)) URL.revokeObjectURL(url);
  }

  private beginAnnotationPick() {
    const slide = this.selectedSlide();
    if (!slide) return this.toast("请先新建或选择汇报页", true);
    if (this.pickHandler) {
      this.cancelPicking();
      return;
    }
    this.composer.exitEditing();
    try { this.restorePickingSession = this.layerAdapter.beginSession?.() ?? null; }
    catch (error) {
      console.error("[3D report] Unable to suspend scene tools for annotation picking", error);
      this.toast("无法开始标注选点，请先结束正在进行的模型或地下编辑", true);
      return;
    }
    const button = byId<HTMLButtonElement>("reportPickAnnotation");
    button.classList.add("active");
    button.textContent = "请在倾斜摄影、模型或地面上单击（再次点击取消）";
    this.setStatus("标注选点中：可直接点选倾斜摄影模型表面。按 Esc 取消。 ");
    this.pickHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.pickHandler.setInputAction((movement: { position: Cartesian2 }) => {
      const position = this.pickWorldPosition(movement.position);
      if (!position) {
        this.toast("没有拾取到模型或地面，请换一个位置", true);
        return;
      }
      const cartographic = Cartographic.fromCartesian(position);
      const title = byId<HTMLInputElement>("reportAnnotationTitle").value.trim() || `标注 ${slide.annotations.length + 1}`;
      slide.annotations.push({
        id: crypto.randomUUID(),
        title: title.slice(0, 60),
        note: byId<HTMLInputElement>("reportAnnotationNote").value.trim().slice(0, 160),
        longitude: CesiumMath.toDegrees(cartographic.longitude),
        latitude: CesiumMath.toDegrees(cartographic.latitude),
        height: cartographic.height,
      });
      this.persist();
      this.cancelPicking();
      this.renderAll();
      this.toast("空间标注已加入当前汇报页");
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  private pickWorldPosition(windowPosition: Cartesian2) {
    const scene = this.viewer.scene;
    if (scene.pickPositionSupported) {
      try {
        const picked = scene.pickPosition(windowPosition);
        if (picked && [picked.x, picked.y, picked.z].every(Number.isFinite)) return Cartesian3.clone(picked);
      } catch (error) {
        console.warn("[3D report] Model surface picking failed, falling back to the globe", error);
      }
    }
    const ray = this.viewer.camera.getPickRay(windowPosition);
    return ray ? scene.globe.pick(ray, scene) : undefined;
  }

  private cancelPicking() {
    if (this.pickHandler && !this.pickHandler.isDestroyed()) this.pickHandler.destroy();
    this.pickHandler = null;
    const restore = this.restorePickingSession;
    this.restorePickingSession = null;
    try { restore?.(); } catch (error) { console.warn("[3D report] Unable to restore scene tools after annotation picking", error); }
    const button = document.getElementById("reportPickAnnotation");
    if (button) {
      button.classList.remove("active");
      button.textContent = "在模型或地图上点选标注位置";
    }
  }

  private removeAnnotation(id: string) {
    const slide = this.selectedSlide();
    if (!slide) return;
    const nextSlide = { ...slide, annotations: slide.annotations.filter((annotation) => annotation.id !== id) };
    if (!this.commitDeletion({ ...this.document, slides: this.document.slides.map(item => item === slide ? nextSlide : item) })) return;
    this.renderAll();
  }

  private removeOverlayElement(id: string): boolean {
    const slide = this.selectedSlide();
    if (!slide || !slide.elements.some(element => element.id === id)) return false;
    const nextSlide = { ...slide, elements: slide.elements.filter(element => element.id !== id) };
    if (!this.commitDeletion({ ...this.document, slides: this.document.slides.map(item => item === slide ? nextSlide : item) })) return false;
    if (this.presenting) this.renderStage();
    return true;
  }

  private locateAnnotation(id: string) {
    const annotation = this.selectedSlide()?.annotations.find((candidate) => candidate.id === id);
    if (!annotation) return;
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(annotation.longitude, annotation.latitude, annotation.height + 80),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(-55), roll: 0 },
      duration: 1.2,
    });
  }

  private renderMarkers(slide: ReportSlide | null) {
    this.markers.entities.removeAll();
    if (!slide) return;
    slide.annotations.forEach((annotation, index) => {
      this.markers.entities.add({
        id: `three-d-report-${slide.id}-${annotation.id}`,
        position: Cartesian3.fromDegrees(annotation.longitude, annotation.latitude, annotation.height),
        point: {
          pixelSize: 12,
          color: Color.fromCssColorString("#ffcf4a"),
          outlineColor: Color.WHITE,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${index + 1}. ${annotation.title}`,
          font: '600 14px "Microsoft YaHei", sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString("#07131f"),
          outlineWidth: 4,
          style: LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Color.fromCssColorString("#07131f").withAlpha(0.86),
          pixelOffset: new Cartesian2(0, -24),
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
    this.viewer.scene.requestRender();
  }

  private setMarkerVisibility(visible: boolean) {
    this.markers.show = visible;
    if (visible) this.renderMarkers(this.presenting ? this.document.slides[this.currentPresentationIndex] ?? null : this.selectedSlide());
    this.viewer.scene.requestRender();
  }

  private startPresentation(auto: boolean, forcedIndex?: number) {
    if (!this.document.slides.length) return this.toast("请先新建至少一页汇报内容", true);
    this.cancelPicking();
    this.composer.exitEditing();
    const selectedIndex = this.document.slides.findIndex((slide) => slide.id === this.selectedSlideId);
    this.currentPresentationIndex = forcedIndex ?? Math.max(0, selectedIndex);
    if (!this.presenting) {
      try { this.restorePresentationSession = this.layerAdapter.beginSession?.() ?? null; }
      catch (error) {
        console.error("[3D report] Unable to suspend another scene interaction", error);
        this.restorePresentationSession = null;
        this.toast("当前场景工具无法安全暂停，已取消放映", true);
        return;
      }
      try {
        this.prePresentationCamera = this.captureCamera();
        this.prePresentationLayers = this.layerAdapter.capture();
      }
      catch (error) {
        console.error("[3D report] Unable to capture the pre-presentation layer state", error);
        this.prePresentationLayers = null;
        this.prePresentationCamera = null;
        const restore = this.restorePresentationSession;
        this.restorePresentationSession = null;
        try { restore?.(); } catch (restoreError) { console.warn("[3D report] Unable to resume scene tools after a failed start", restoreError); }
        this.toast("无法完整记录当前图层状态，已取消放映以保护现有场景", true);
        return;
      }
    }
    this.presenting = true;
    this.autoPlaying = auto;
    document.body.classList.add("report-presentation-mode");
    const stage = byId<HTMLElement>("threeDReportStage");
    stage.classList.add("active");
    stage.setAttribute("aria-hidden", "false");
    this.setMarkerVisibility(true);
    this.updatePresentationControls();
    requestAnimationFrame(() => this.viewer.resize());
    void this.showPresentationSlide(this.currentPresentationIndex, false);
  }

  private async showPresentationSlide(index: number, animate = true) {
    if (!this.presenting || !this.document.slides.length) return;
    this.stopAutoTimerOnly();
    this.currentPresentationIndex = Math.max(0, Math.min(this.document.slides.length - 1, index));
    const slide = this.document.slides[this.currentPresentationIndex];
    this.selectedSlideId = slide.id;
    const token = ++this.transitionToken;
    const transition = animate ? slide.transition : "cut";
    const stage = byId<HTMLElement>("threeDReportStage");
    try {
      if (transition === "fade") {
        stage.classList.add("transitioning");
        await new Promise<void>((resolve) => window.setTimeout(resolve, 170));
        if (!this.presenting || token !== this.transitionToken) return;
      }
      if (transition === "fly") {
        this.renderStage();
        this.renderMarkers(slide);
        this.renderSlideList();
        await this.applySlideScene(slide, true);
      } else {
        await this.applySlideScene(slide, false);
        if (!this.presenting || token !== this.transitionToken) return;
        this.renderStage();
        this.renderMarkers(slide);
        this.renderSlideList();
      }
    } catch (error) {
      console.error("[3D report] Unable to apply a presentation slide", error);
      if (!this.presenting || token !== this.transitionToken) return;
      this.toast(`第 ${this.currentPresentationIndex + 1} 页的部分场景状态无法恢复，已保留可用内容`, true);
      this.renderStage();
      this.renderMarkers(slide);
      this.renderSlideList();
    } finally {
      if (token === this.transitionToken) requestAnimationFrame(() => stage.classList.remove("transitioning"));
    }
    if (!this.presenting || token !== this.transitionToken) return;
    if (this.autoPlaying) this.scheduleNext(slide.staySeconds);
  }

  private scheduleNext(seconds: number) {
    this.stopAutoTimerOnly();
    if (!this.autoPlaying) return;
    if (this.currentPresentationIndex >= this.document.slides.length - 1) {
      this.autoPlaying = false;
      this.updatePresentationControls();
      return;
    }
    this.autoTimer = window.setTimeout(() => void this.showPresentationSlide(this.currentPresentationIndex + 1), seconds * 1000);
  }

  private toggleAutoPlay() {
    if (!this.presenting) return;
    this.autoPlaying = !this.autoPlaying;
    this.updatePresentationControls();
    if (this.autoPlaying) {
      if (this.currentPresentationIndex >= this.document.slides.length - 1) void this.showPresentationSlide(0);
      else this.scheduleNext(this.document.slides[this.currentPresentationIndex].staySeconds);
    } else this.stopAutoTimerOnly();
  }

  private stopAutoTimerOnly() {
    if (this.autoTimer !== undefined) window.clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
  }

  private stopAutoPlay() {
    this.autoPlaying = false;
    this.stopAutoTimerOnly();
  }

  private async exitPresentation() {
    if (!this.presenting) return;
    this.presenting = false;
    this.stopAutoPlay();
    this.transitionToken += 1;
    this.viewer.camera.cancelFlight();
    this.toggleLaser(false);
    const stage = byId<HTMLElement>("threeDReportStage");
    stage.classList.remove("active", "transitioning");
    stage.setAttribute("aria-hidden", "true");
    byId<HTMLVideoElement>("reportStageVideo").pause();
    this.composer.renderPresentation([]);
    document.body.classList.remove("report-presentation-mode");
    let restoreFailed = false;
    try {
      if (this.prePresentationLayers) await this.layerAdapter.apply(this.prePresentationLayers);
    } catch (error) {
      restoreFailed = true;
      console.error("[3D report] Unable to restore pre-presentation layers", error);
    } finally {
      try {
        if (this.prePresentationCamera) {
          const camera = this.prePresentationCamera;
          this.viewer.camera.setView({
            destination: Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
            orientation: {
              heading: CesiumMath.toRadians(camera.heading),
              pitch: CesiumMath.toRadians(camera.pitch),
              roll: CesiumMath.toRadians(camera.roll),
            },
          });
        }
      } catch (error) {
        restoreFailed = true;
        console.error("[3D report] Unable to restore the pre-presentation camera", error);
      }
      this.prePresentationCamera = null;
      this.prePresentationLayers = null;
      const restoreSession = this.restorePresentationSession;
      this.restorePresentationSession = null;
      try { restoreSession?.(); } catch (error) {
        restoreFailed = true;
        console.error("[3D report] Unable to resume a suspended interaction", error);
      }
      const reportTabActive = document.querySelector<HTMLButtonElement>('.tab[data-tab="report"]')?.classList.contains("active") === true;
      this.composer.setReportTabActive(reportTabActive);
      this.setMarkerVisibility(reportTabActive);
      requestAnimationFrame(() => this.viewer.resize());
    }
    if (restoreFailed) this.toast("汇报已退出；个别已卸载资源无法恢复，其余场景状态已保留", true);
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.pickHandler) {
      this.cancelPicking();
      this.setStatus("已取消空间标注选点。");
      return;
    }
    if (!this.presenting) return;
    if (event.key === "Escape") void this.exitPresentation();
    else if ((event.target as HTMLElement | null)?.closest?.("input,textarea,select,button,a,video,audio,[contenteditable='true']")) return;
    else if (event.key === "ArrowRight" || event.key === "PageDown") void this.showPresentationSlide(this.currentPresentationIndex + 1);
    else if (event.key === "ArrowLeft" || event.key === "PageUp") void this.showPresentationSlide(this.currentPresentationIndex - 1);
    else if (event.key === " ") {
      event.preventDefault();
      this.toggleAutoPlay();
    }
  }

  private toggleLaser(force?: boolean) {
    this.laserEnabled = force ?? !this.laserEnabled;
    byId<HTMLButtonElement>("reportStageLaser").classList.toggle("active", this.laserEnabled);
    byId<HTMLElement>("reportLaserPointer").classList.toggle("active", this.laserEnabled && this.presenting);
  }

  private moveLaser(event: PointerEvent) {
    if (!this.presenting || !this.laserEnabled) return;
    const stage = byId<HTMLElement>("threeDReportStage");
    const bounds = stage.getBoundingClientRect();
    const pointer = byId<HTMLElement>("reportLaserPointer");
    pointer.style.left = `${event.clientX - bounds.left}px`;
    pointer.style.top = `${event.clientY - bounds.top}px`;
  }

  private exportDocument() {
    const exportValue = structuredClone(this.document);
    const blob = new Blob([JSON.stringify(exportValue, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(this.document.title || "三维汇报").replace(/[\\/:*?"<>|]+/g, "_")}.3dreport.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast("三维汇报文件已导出");
  }

  private async importDocument(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 24 * 1024 * 1024) throw new Error("汇报文件超过 24MB，请先压缩其中的图片");
      const next = normalizeDocument(JSON.parse(await file.text()));
      if (this.document.slides.length && !window.confirm("导入会替换当前三维汇报，是否继续？")) return;
      for (const url of this.localVideoUrls.values()) URL.revokeObjectURL(url);
      this.localVideoUrls.clear();
      this.composer.clearTransientMedia();
      this.document = next;
      this.selectedSlideId = next.slides[0]?.id ?? null;
      this.persist();
      this.renderAll();
      this.toast(`已导入 ${next.slides.length} 页三维汇报`);
      this.setStatus("汇报文件导入完成；请确保对应工程图层已加载。 ");
    } catch (error) {
      this.toast(error instanceof Error ? error.message : "汇报文件解析失败", true);
      this.setStatus("汇报文件解析失败，请检查文件内容。", true);
    } finally {
      byId<HTMLInputElement>("reportImportFile").value = "";
    }
  }

  private selectedSlide() {
    return this.document.slides.find((slide) => slide.id === this.selectedSlideId) ?? null;
  }

  private selectSlide(id: string) {
    this.selectedSlideId = id;
    this.cancelPicking();
    this.renderAll();
  }

  private renderAll() {
    byId<HTMLInputElement>("reportDocumentTitle").value = this.document.title;
    this.renderSummary();
    this.renderSlideList();
    this.renderEditor();
    const reportTabActive = document.querySelector<HTMLButtonElement>('.tab[data-tab="report"]')?.classList.contains("active") === true;
    this.composer.setReportTabActive(reportTabActive);
    this.composer.refresh();
    if (!this.presenting) this.setMarkerVisibility(reportTabActive);
    this.notifyOverviewListeners();
  }

  private renderSummary() {
    byId<HTMLElement>("reportSlideCount").textContent = String(this.document.slides.length);
    byId<HTMLElement>("reportSceneCount").textContent = String(this.document.slides.filter((slide) => slide.camera).length);
    byId<HTMLElement>("reportAnnotationCount").textContent = String(this.document.slides.reduce((total, slide) => total + slide.annotations.length, 0));
  }

  private renderSlideList() {
    const root = byId<HTMLElement>("reportSlideList");
    if (!this.document.slides.length) {
      root.innerHTML = '<div class="report-empty">还没有汇报页<br /><small>点击“新建一页”记录当前三维场景</small></div>';
      return;
    }
    root.innerHTML = this.document.slides.map((slide, index) => `
      <button class="report-slide-row${slide.id === this.selectedSlideId ? " active" : ""}" data-report-slide-id="${escapeHtml(slide.id)}">
        <span>${String(index + 1).padStart(2, "0")}</span>
        <div><strong>${escapeHtml(slide.title || `汇报页 ${index + 1}`)}</strong><small>${slide.camera ? "已绑定三维场景" : "未绑定场景"} · ${slide.annotations.length} 个标注</small></div>
        <i>${slide.media.type === "image" ? "图" : slide.media.type === "video" ? "视" : slide.media.type === "link" ? "链" : "3D"}</i>
      </button>`).join("");
    root.querySelectorAll<HTMLButtonElement>("[data-report-slide-id]").forEach((button) => button.addEventListener("click", () => this.selectSlide(button.dataset.reportSlideId!)));
  }

  private renderEditor() {
    const slide = this.selectedSlide();
    byId<HTMLElement>("reportSlideEditor").classList.toggle("hidden", !slide);
    byId<HTMLElement>("reportSlideToolbar").classList.toggle("hidden", !slide);
    byId<HTMLButtonElement>("reportPresentCurrent").disabled = !slide;
    byId<HTMLButtonElement>("reportPresentAll").disabled = !this.document.slides.length;
    if (!slide) {
      this.renderMarkers(null);
      return;
    }
    const index = this.document.slides.indexOf(slide);
    byId<HTMLElement>("reportEditingPage").textContent = `第 ${index + 1} / ${this.document.slides.length} 页`;
    byId<HTMLInputElement>("reportSlideTitle").value = slide.title;
    byId<HTMLInputElement>("reportSlideSubtitle").value = slide.subtitle;
    byId<HTMLTextAreaElement>("reportSlideBody").value = slide.body;
    byId<HTMLSelectElement>("reportSlideLayout").value = slide.layout;
    byId<HTMLSelectElement>("reportSlideTheme").value = slide.theme;
    byId<HTMLSelectElement>("reportTransitionType").value = slide.transition;
    byId<HTMLInputElement>("reportTransitionSeconds").value = String(slide.transitionSeconds);
    byId<HTMLInputElement>("reportStaySeconds").value = String(slide.staySeconds);
    byId<HTMLInputElement>("reportShowCard").checked = slide.showCard;
    byId<HTMLElement>("reportSceneState").textContent = slide.camera ? `${slide.layers?.layers.length ?? 0} 个图层 · 已记录镜头` : "尚未绑定";
    byId<HTMLElement>("reportAnnotationState").textContent = `${slide.annotations.length} 个`;
    byId<HTMLSelectElement>("reportMediaType").value = slide.media.type;
    byId<HTMLInputElement>("reportMediaUrl").value = slide.media.source;
    this.updateMediaControls(slide);
    this.renderAnnotationList(slide);
    this.renderMarkers(slide);
    byId<HTMLButtonElement>("reportMoveSlideUp").disabled = index <= 0;
    byId<HTMLButtonElement>("reportMoveSlideDown").disabled = index >= this.document.slides.length - 1;
  }

  private updateMediaControls(slide: ReportSlide) {
    const imageMode = slide.media.type === "image";
    const urlMode = slide.media.type === "video" || slide.media.type === "link";
    byId<HTMLElement>("reportImageFields").classList.toggle("hidden", !imageMode);
    byId<HTMLElement>("reportUrlFields").classList.toggle("hidden", !urlMode);
    byId<HTMLElement>("reportVideoFileLabel").classList.toggle("hidden", slide.media.type !== "video");
    byId<HTMLElement>("reportUrlLabel").textContent = slide.media.type === "link" ? "资料链接" : "在线视频地址";
    byId<HTMLInputElement>("reportMediaUrl").placeholder = slide.media.type === "link" ? "https://example.com/report" : "https://example.com/video.mp4";
    byId<HTMLElement>("reportImageName").textContent = imageMode && slide.media.name ? slide.media.name : "尚未选择图片";
    byId<HTMLElement>("reportVideoName").textContent = this.localVideoUrls.has(slide.id) ? `${slide.media.name}（本次打开有效）` : slide.media.name;
    byId<HTMLButtonElement>("reportClearMedia").classList.toggle("hidden", slide.media.type === "none");
  }

  private renderAnnotationList(slide: ReportSlide) {
    const root = byId<HTMLElement>("reportAnnotationList");
    if (!slide.annotations.length) {
      root.innerHTML = '<div class="report-empty compact">本页尚无空间标注</div>';
      return;
    }
    root.innerHTML = slide.annotations.map((annotation, index) => `
      <div class="report-annotation-row" data-report-annotation-id="${escapeHtml(annotation.id)}">
        <span>${index + 1}</span><div><strong>${escapeHtml(annotation.title)}</strong><small>${escapeHtml(annotation.note || `${annotation.longitude.toFixed(6)}, ${annotation.latitude.toFixed(6)}`)}</small></div>
        <button class="locate" title="定位">◎</button><button class="remove" title="删除">×</button>
      </div>`).join("");
    root.querySelectorAll<HTMLElement>("[data-report-annotation-id]").forEach((row) => {
      const id = row.dataset.reportAnnotationId!;
      row.querySelector(".locate")?.addEventListener("click", () => this.locateAnnotation(id));
      row.querySelector(".remove")?.addEventListener("click", () => this.removeAnnotation(id));
    });
  }

  private renderStage() {
    if (!this.presenting) return;
    const slide = this.document.slides[this.currentPresentationIndex];
    if (!slide) return;
    byId<HTMLElement>("reportStageDocument").textContent = this.document.title;
    byId<HTMLElement>("reportStagePage").textContent = `${this.currentPresentationIndex + 1} / ${this.document.slides.length}`;
    byId<HTMLElement>("reportStageTitle").textContent = slide.title;
    byId<HTMLElement>("reportStageSubtitle").textContent = slide.subtitle;
    byId<HTMLElement>("reportStageSubtitle").classList.toggle("hidden", !slide.subtitle);
    byId<HTMLElement>("reportStageBody").textContent = slide.body;
    byId<HTMLElement>("reportStageBody").classList.toggle("hidden", !slide.body || slide.layout === "minimal");
    const card = byId<HTMLElement>("reportStageCard");
    card.className = `report-stage-card layout-${slide.layout} theme-${slide.theme}`;
    card.classList.toggle("hidden", !slide.showCard);
    const image = byId<HTMLImageElement>("reportStageImage");
    const video = byId<HTMLVideoElement>("reportStageVideo");
    const link = byId<HTMLAnchorElement>("reportStageLink");
    image.classList.add("hidden");
    video.classList.add("hidden");
    link.classList.add("hidden");
    video.pause();
    video.removeAttribute("src");
    const mediaRoot = byId<HTMLElement>("reportStageMedia");
    let mediaVisible = false;
    if (slide.media.type === "image" && slide.media.source) {
      image.src = slide.media.source;
      image.classList.remove("hidden");
      mediaVisible = true;
    } else if (slide.media.type === "video") {
      const source = this.localVideoUrls.get(slide.id) || slide.media.source;
      if (source) {
        video.src = source;
        video.classList.remove("hidden");
        mediaVisible = true;
      }
    } else if (slide.media.type === "link" && this.safeExternalUrl(slide.media.source)) {
      link.href = slide.media.source;
      link.classList.remove("hidden");
      mediaVisible = true;
    }
    mediaRoot.classList.toggle("hidden", !mediaVisible || slide.layout === "minimal");
    this.composer.renderPresentation(slide.elements);
    this.updatePresentationControls();
  }

  private async executeElementAction(action: ReportElementAction) {
    if (!this.presenting || action.type === "none") return;
    try {
      if (action.type === "openUrl") {
        if (!this.safeExternalUrl(action.url)) return this.toast("按钮中的网页地址无效", true);
        window.open(action.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (action.type === "gotoPage" || action.type === "flyToPage") {
        const index = this.document.slides.findIndex((slide) => slide.id === action.target);
        if (index < 0) return this.toast("按钮目标页面已不存在", true);
        this.stopAutoPlay();
        await this.showPresentationSlide(index, action.type === "flyToPage");
        this.updatePresentationControls();
        return;
      }
      if (action.type === "toggleLayer") {
        const snapshot = this.layerAdapter.capture();
        let target = snapshot.layers.find((layer) => layer.id === action.target);
        if (!target && action.targetName) {
          let fallback: unknown;
          try { fallback = JSON.parse(action.targetName); } catch { fallback = action.targetName.split("\u0000"); }
          if (Array.isArray(fallback) && fallback.length >= 2) {
            const [kind, name] = fallback.map(String);
            target = snapshot.layers.find((layer) => layer.kind === kind && layer.name === name);
          }
        }
        if (!target) return this.toast("按钮目标图层当前未加载", true);
        target.visible = !target.visible;
        await this.layerAdapter.apply(snapshot);
        this.toast(`${target.name} 已${target.visible ? "显示" : "隐藏"}`);
      }
    } catch (error) {
      console.error("[3D report] Component action failed", error);
      this.toast("汇报按钮动作执行失败，工程数据未被删除", true);
    }
  }

  private safeExternalUrl(source: string) {
    try {
      const protocol = new URL(source, location.href).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch { return false; }
  }

  private updatePresentationControls() {
    byId<HTMLButtonElement>("reportStagePrevious").disabled = this.currentPresentationIndex <= 0;
    byId<HTMLButtonElement>("reportStageNext").disabled = this.currentPresentationIndex >= this.document.slides.length - 1;
    const auto = byId<HTMLButtonElement>("reportStageAuto");
    auto.classList.toggle("active", this.autoPlaying);
    auto.textContent = this.autoPlaying ? "暂停自动播放" : "自动播放";
  }

  private setStatus(message: string, error = false) {
    const target = byId<HTMLElement>("reportStatus");
    target.textContent = message;
    target.classList.toggle("error", error);
  }
}
