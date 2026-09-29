import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  CustomDataSource,
  DistanceDisplayCondition,
  Entity,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  PolygonHierarchy,
  PolylineArrowMaterialProperty,
  PolylineGlowMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Viewer,
} from "cesium";
import "./sandTableFacilities.css";

export type SandTableFacilityKind = "fence" | "hardscape" | "vehicleRoute" | "temporaryBuilding";

export type SandTableFacilityOverviewItem = Readonly<{
  id: string;
  name: string;
  kind: SandTableFacilityKind;
  visible: boolean;
  updatedAt: string;
}>;

export type SandTableFacilityOverviewSnapshot = Readonly<{
  total: number;
  visible: number;
  hidden: number;
  animationEnabled: boolean;
  facilitiesVisible: boolean;
  byKind: Readonly<Record<SandTableFacilityKind, number>>;
  items: ReadonlyArray<SandTableFacilityOverviewItem>;
}>;

export type SandTableFacilitiesOptions = {
  root?: ParentNode;
  projectId?: string;
  storageKey?: string;
  beginInteractionSession?: () => void | (() => void);
  stopCameraMotion?: () => void;
  toast?: (message: string, error?: boolean) => void;
};

type StoredPosition = { longitude: number; latitude: number; height: number };
type FacilityStyle = { color: string; opacity: number; lineWidth: number };
type FenceProperties = { height: number; closed: boolean };
type HardscapeProperties = { thickness: number; material: string };
type VehicleRouteProperties = { speed: number; loop: boolean; dynamic: boolean };
type TemporaryBuildingProperties = { height: number; use: string };

type FacilityRecordBase = {
  id: string;
  projectId: string;
  name: string;
  visible: boolean;
  positions: StoredPosition[];
  style: FacilityStyle;
  createdAt: string;
  updatedAt: string;
};

type FenceRecord = FacilityRecordBase & { kind: "fence"; properties: FenceProperties };
type HardscapeRecord = FacilityRecordBase & { kind: "hardscape"; properties: HardscapeProperties };
type VehicleRouteRecord = FacilityRecordBase & { kind: "vehicleRoute"; properties: VehicleRouteProperties };
type TemporaryBuildingRecord = FacilityRecordBase & { kind: "temporaryBuilding"; properties: TemporaryBuildingProperties };
type FacilityRecord = FenceRecord | HardscapeRecord | VehicleRouteRecord | TemporaryBuildingRecord;

type StoredState = {
  version: 1;
  projectId: string;
  settings: { animationEnabled: boolean; facilitiesVisible: boolean };
  items: FacilityRecord[];
};

type RouteMetric = {
  points: Cartesian3[];
  cumulative: number[];
  totalLength: number;
};

const STORAGE_VERSION = 1;
const DEFAULT_STORAGE_KEY = "cesium-electronic-sand-table-facilities-v1";
const DEFAULT_PROJECT_ID = "default-project";
const MAX_RECORDS = 500;
const MAX_POINTS_PER_RECORD = 500;
const MAX_TOTAL_POINTS = 20_000;
const MAX_DYNAMIC_ROUTES = 20;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const ANIMATION_INTERVAL_MS = 1000 / 15;
const HOVER_PICK_INTERVAL_MS = 1000 / 30;
const MIN_HEIGHT = -100_000;
const MAX_HEIGHT = 1_000_000;
const DRAFT_PREFIX = "sand-facility-draft-";

const KIND_LABELS: Record<SandTableFacilityKind, string> = {
  fence: "电子围栏",
  hardscape: "场地硬化",
  vehicleRoute: "车辆路径",
  temporaryBuilding: "临时建筑",
};

const KIND_MIN_POINTS: Record<SandTableFacilityKind, number> = {
  fence: 2,
  hardscape: 3,
  vehicleRoute: 2,
  temporaryBuilding: 3,
};

const KIND_DEFAULT_COLORS: Record<SandTableFacilityKind, string> = {
  fence: "#ffb347",
  hardscape: "#a9b2ba",
  vehicleRoute: "#31d9f3",
  temporaryBuilding: "#d39a66",
};

export const sandTableFacilitiesHtml = `
  <div class="sand-table-section sand-facility-module">
    <div class="sand-table-section-heading sand-facility-heading">
      <strong>施工场布</strong><span id="sandFacilityCount">0 个设施</span>
    </div>
    <p class="sand-facility-copy">在地形、倾斜摄影或三维模型上设置围栏、硬化区域、车辆动态路径和临时建筑。</p>

    <div class="sand-facility-toolbar" role="group" aria-label="施工场布绘制工具">
      <button type="button" data-sand-facility-draw="fence"><b>⌁</b><span>电子围栏</span></button>
      <button type="button" data-sand-facility-draw="hardscape"><b>▰</b><span>场地硬化</span></button>
      <button type="button" data-sand-facility-draw="vehicleRoute"><b>➜</b><span>车辆路径</span></button>
      <button type="button" data-sand-facility-draw="temporaryBuilding"><b>▥</b><span>临时建筑</span></button>
    </div>

    <div class="sand-facility-form">
      <div class="sand-facility-form-grid">
        <label>名称<input id="sandFacilityName" type="text" maxlength="80" placeholder="未填写时自动命名" /></label>
        <label>颜色<input id="sandFacilityColor" type="color" value="#ffb347" /></label>
        <label>透明度<output id="sandFacilityOpacityValue">72%</output><input id="sandFacilityOpacity" type="range" min="0.1" max="1" step="0.05" value="0.72" /></label>
        <label>线宽（像素）<input id="sandFacilityLineWidth" type="number" min="1" max="16" step="1" value="4" /></label>
      </div>

      <div class="sand-facility-kind-fields" data-sand-facility-fields="fence">
        <label>围栏高度（米）<input id="sandFacilityFenceHeight" type="number" min="0.5" max="20" step="0.1" value="2" /></label>
        <label class="sand-facility-check"><input id="sandFacilityFenceClosed" type="checkbox" checked /> 首尾闭合</label>
      </div>
      <div class="sand-facility-kind-fields is-hidden" data-sand-facility-fields="hardscape">
        <label>硬化厚度（米）<input id="sandFacilityHardscapeThickness" type="number" min="0.02" max="2" step="0.01" value="0.2" /></label>
        <label>材料<select id="sandFacilityHardscapeMaterial"><option value="混凝土">混凝土</option><option value="沥青">沥青</option><option value="钢板">钢板</option><option value="碎石">碎石</option></select></label>
      </div>
      <div class="sand-facility-kind-fields is-hidden" data-sand-facility-fields="vehicleRoute">
        <label>车辆速度（米/秒）<input id="sandFacilityRouteSpeed" type="number" min="0.2" max="60" step="0.1" value="5" /></label>
        <label class="sand-facility-check"><input id="sandFacilityRouteLoop" type="checkbox" checked /> 循环行驶</label>
        <label class="sand-facility-check"><input id="sandFacilityRouteDynamic" type="checkbox" checked /> 动态显示车辆</label>
      </div>
      <div class="sand-facility-kind-fields is-hidden" data-sand-facility-fields="temporaryBuilding">
        <label>建筑高度（米）<input id="sandFacilityBuildingHeight" type="number" min="0.5" max="100" step="0.1" value="4" /></label>
        <label>用途<input id="sandFacilityBuildingUse" type="text" maxlength="60" value="临时用房" /></label>
      </div>
    </div>

    <div class="sand-facility-draw-state">
      <div><strong id="sandFacilityDrawState">请选择一种场布类型开始绘制</strong><small id="sandFacilityDrawHint">左键选点，右键或“完成绘制”结束</small></div>
      <div class="sand-facility-draw-actions">
        <button id="sandFacilityUndoPoint" type="button" disabled>撤点</button>
        <button id="sandFacilityFinish" type="button" disabled>完成绘制</button>
        <button id="sandFacilityCancel" type="button" disabled>取消</button>
      </div>
    </div>

    <div class="sand-facility-switches">
      <label><input id="sandFacilityVisible" type="checkbox" checked /> 显示场布</label>
      <label><input id="sandFacilityAnimation" type="checkbox" checked /> 车辆动态效果</label>
    </div>

    <div id="sandFacilityList" class="sand-facility-list"><p>尚未创建场布设施</p></div>
    <p id="sandFacilityStatus" class="sand-facility-status" aria-live="polite">场布设施独立保存在本机浏览器中。</p>
  </div>
`;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : fallback;
}

function cleanText(value: unknown, maximum: number, fallback = "") {
  if (typeof value !== "string") return fallback;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
  return result || fallback;
}

function cleanId(value: unknown) {
  const id = cleanText(value, 128);
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : "";
}

function safeColor(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function safeDate(value: unknown, fallback: string) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) return fallback;
  return value.slice(0, 40);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function isFacilityKind(value: unknown): value is SandTableFacilityKind {
  return value === "fence" || value === "hardscape" || value === "vehicleRoute" || value === "temporaryBuilding";
}

function toStoredPosition(position: Cartesian3): StoredPosition {
  const cartographic = Cartographic.fromCartesian(position);
  return {
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    height: Number.isFinite(cartographic.height) ? cartographic.height : 0,
  };
}

function safePosition(value: unknown): StoredPosition | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<StoredPosition>;
  if (
    typeof source.longitude !== "number"
    || typeof source.latitude !== "number"
    || typeof source.height !== "number"
    || ![source.longitude, source.latitude, source.height].every(Number.isFinite)
    || source.longitude < -180
    || source.longitude > 180
    || source.latitude < -90
    || source.latitude > 90
    || source.height < MIN_HEIGHT
    || source.height > MAX_HEIGHT
  ) return null;
  return { longitude: source.longitude, latitude: source.latitude, height: source.height };
}

function toCartesian(position: StoredPosition, heightOffset = 0) {
  return Cartesian3.fromDegrees(position.longitude, position.latitude, position.height + heightOffset);
}

function uniquePointCount(positions: StoredPosition[]) {
  return new Set(positions.map((position) => `${position.longitude.toFixed(10)}:${position.latitude.toFixed(10)}:${position.height.toFixed(3)}`)).size;
}

function safeStyle(value: unknown, kind: SandTableFacilityKind): FacilityStyle {
  const source = value && typeof value === "object" ? value as Partial<FacilityStyle> : {};
  return {
    color: safeColor(source.color, KIND_DEFAULT_COLORS[kind]),
    opacity: finiteNumber(source.opacity, 0.72, 0.1, 1),
    lineWidth: finiteNumber(source.lineWidth, 4, 1, 16),
  };
}

function safeProperties(kind: SandTableFacilityKind, value: unknown): FacilityRecord["properties"] {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (kind === "fence") return {
    height: finiteNumber(source.height, 2, 0.5, 20),
    closed: source.closed !== false,
  } satisfies FenceProperties;
  if (kind === "hardscape") return {
    thickness: finiteNumber(source.thickness, 0.2, 0.02, 2),
    material: cleanText(source.material, 30, "混凝土"),
  } satisfies HardscapeProperties;
  if (kind === "vehicleRoute") return {
    speed: finiteNumber(source.speed, 5, 0.2, 60),
    loop: source.loop !== false,
    dynamic: source.dynamic !== false,
  } satisfies VehicleRouteProperties;
  return {
    height: finiteNumber(source.height, 4, 0.5, 100),
    use: cleanText(source.use, 60, "临时用房"),
  } satisfies TemporaryBuildingProperties;
}

function safeRecord(value: unknown, projectId: string): FacilityRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<FacilityRecord>;
  if (!isFacilityKind(source.kind)) return null;
  const id = cleanId(source.id);
  if (!id) return null;
  const positions = Array.isArray(source.positions)
    ? source.positions.slice(0, MAX_POINTS_PER_RECORD).map(safePosition).filter((item): item is StoredPosition => item !== null)
    : [];
  if (positions.length < KIND_MIN_POINTS[source.kind] || uniquePointCount(positions) < KIND_MIN_POINTS[source.kind]) return null;
  const now = new Date().toISOString();
  const base: FacilityRecordBase = {
    id,
    projectId,
    name: cleanText(source.name, 80, KIND_LABELS[source.kind]),
    visible: source.visible !== false,
    positions,
    style: safeStyle(source.style, source.kind),
    createdAt: safeDate(source.createdAt, now),
    updatedAt: safeDate(source.updatedAt, now),
  };
  const properties = safeProperties(source.kind, source.properties);
  if (source.kind === "fence") return { ...base, kind: source.kind, properties: properties as FenceProperties };
  if (source.kind === "hardscape") return { ...base, kind: source.kind, properties: properties as HardscapeProperties };
  if (source.kind === "vehicleRoute") return { ...base, kind: source.kind, properties: properties as VehicleRouteProperties };
  return { ...base, kind: source.kind, properties: properties as TemporaryBuildingProperties };
}

function centerPosition(positions: StoredPosition[], heightOffset = 0) {
  const sum = positions.reduce((result, position) => ({
    longitude: result.longitude + position.longitude,
    latitude: result.latitude + position.latitude,
    height: result.height + position.height,
  }), { longitude: 0, latitude: 0, height: 0 });
  const count = Math.max(1, positions.length);
  return Cartesian3.fromDegrees(sum.longitude / count, sum.latitude / count, sum.height / count + heightOffset);
}

function buildRouteMetric(positions: StoredPosition[]): RouteMetric {
  const points = positions.map((position) => toCartesian(position, 0.18));
  const cumulative = [0];
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    totalLength += Cartesian3.distance(points[index - 1], points[index]);
    cumulative.push(totalLength);
  }
  return { points, cumulative, totalLength };
}

function routePosition(metric: RouteMetric, distance: number) {
  if (!metric.points.length) return undefined;
  if (metric.points.length === 1 || metric.totalLength <= 0.001) return Cartesian3.clone(metric.points[0]);
  const target = clamp(distance, 0, metric.totalLength);
  let high = metric.cumulative.length - 1;
  let low = 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (metric.cumulative[middle] < target) low = middle + 1;
    else high = middle;
  }
  const endIndex = low;
  const startIndex = Math.max(0, endIndex - 1);
  const startDistance = metric.cumulative[startIndex];
  const segmentLength = Math.max(0.001, metric.cumulative[endIndex] - startDistance);
  return Cartesian3.lerp(metric.points[startIndex], metric.points[endIndex], (target - startDistance) / segmentLength, new Cartesian3());
}

export class SandTableFacilities {
  private readonly viewer: Viewer;
  private readonly options: SandTableFacilitiesOptions;
  private readonly root: ParentNode;
  private readonly projectId: string;
  private readonly storageKey: string;
  private readonly dataSource = new CustomDataSource("电子沙盘施工场布");
  private readonly abortController = new AbortController();
  private readonly overviewListeners = new Set<(snapshot: SandTableFacilityOverviewSnapshot) => void>();
  private readonly routeMetrics = new Map<string, RouteMetric>();
  private records: FacilityRecord[] = [];
  private drawingKind: SandTableFacilityKind | null = null;
  private drawingPoints: Cartesian3[] = [];
  private hoverPoint: Cartesian3 | null = null;
  private draftEntity: Entity | null = null;
  private draftVertices: Entity[] = [];
  private handler: ScreenSpaceEventHandler | null = null;
  private restoreInteractionSession: (() => void) | null = null;
  private hoverPickTimer: number | null = null;
  private pendingHoverScreenPosition: Cartesian2 | null = null;
  private animationTimer: number | null = null;
  private animationEpoch = 0;
  private pendingPersistTimer: number | null = null;
  private pendingPersistPayload = "";
  private animationEnabled = true;
  private facilitiesVisible = true;
  private active = false;
  private disposed = false;

  constructor(viewer: Viewer, options: SandTableFacilitiesOptions = {}) {
    this.viewer = viewer;
    this.options = options;
    this.root = options.root ?? document;
    this.projectId = cleanText(options.projectId, 100, DEFAULT_PROJECT_ID);
    this.storageKey = cleanText(options.storageKey, 160, DEFAULT_STORAGE_KEY);
    this.validateInterface();
    this.loadState();
    this.dataSource.show = false;
    for (const record of this.records) this.addOrReplaceEntity(record);
    this.bindUi();
    this.syncSettingsUi();
    this.selectKind("fence", false);
    this.renderList();
    this.updateDrawingUi();
    void this.viewer.dataSources.add(this.dataSource).then(() => {
      if (this.disposed) this.removeOwnDataSource();
      else this.viewer.scene.requestRender();
    }).catch((error) => this.reportError("施工场布数据源初始化失败", error));
  }

  activate() {
    if (this.disposed || this.active) return;
    this.active = true;
    this.dataSource.show = this.facilitiesVisible;
    this.syncSettingsUi();
    this.startAnimationScheduler();
    this.viewer.scene.requestRender();
  }

  deactivate() {
    if (this.disposed) return;
    if (!this.active && !this.drawingKind && this.animationTimer === null) return;
    this.active = false;
    this.cancelDrawing();
    this.stopAnimationScheduler();
    this.dataSource.show = false;
    this.viewer.scene.requestRender();
  }

  dispose() {
    if (this.disposed) return;
    this.deactivate();
    this.flushPersist();
    this.disposed = true;
    this.abortController.abort();
    this.overviewListeners.clear();
    this.routeMetrics.clear();
    this.dataSource.entities.removeAll();
    this.removeOwnDataSource();
  }

  getOverviewSnapshot(): SandTableFacilityOverviewSnapshot {
    const byKind: Record<SandTableFacilityKind, number> = { fence: 0, hardscape: 0, vehicleRoute: 0, temporaryBuilding: 0 };
    let visible = 0;
    for (const record of this.records) {
      byKind[record.kind] += 1;
      if (record.visible) visible += 1;
    }
    return Object.freeze({
      total: this.records.length,
      visible,
      hidden: this.records.length - visible,
      animationEnabled: this.animationEnabled,
      facilitiesVisible: this.facilitiesVisible,
      byKind: Object.freeze(byKind),
      items: Object.freeze(this.records.slice(0, 200).map((record) => Object.freeze({
        id: record.id,
        name: record.name,
        kind: record.kind,
        visible: record.visible,
        updatedAt: record.updatedAt,
      }))),
    });
  }

  subscribeOverview(listener: (snapshot: SandTableFacilityOverviewSnapshot) => void) {
    if (this.disposed) return () => undefined;
    this.overviewListeners.add(listener);
    try { listener(this.getOverviewSnapshot()); } catch (error) { console.warn("[Sand facilities] Overview listener failed", error); }
    return () => { this.overviewListeners.delete(listener); };
  }

  suspendInteractions() {
    this.cancelDrawing();
    return () => undefined;
  }

  private validateInterface() {
    const ids = [
      "sandFacilityCount", "sandFacilityName", "sandFacilityColor", "sandFacilityOpacity", "sandFacilityOpacityValue",
      "sandFacilityLineWidth", "sandFacilityFenceHeight", "sandFacilityFenceClosed", "sandFacilityHardscapeThickness",
      "sandFacilityHardscapeMaterial", "sandFacilityRouteSpeed", "sandFacilityRouteLoop", "sandFacilityRouteDynamic",
      "sandFacilityBuildingHeight", "sandFacilityBuildingUse", "sandFacilityDrawState", "sandFacilityDrawHint",
      "sandFacilityUndoPoint", "sandFacilityFinish", "sandFacilityCancel", "sandFacilityVisible", "sandFacilityAnimation",
      "sandFacilityList", "sandFacilityStatus",
    ];
    for (const id of ids) if (!this.node(id)) throw new Error(`缺少施工场布界面元素：#${id}`);
    if (this.root.querySelectorAll("[data-sand-facility-draw]").length !== 4) throw new Error("施工场布绘制工具不完整");
  }

  private bindUi() {
    const signal = this.abortController.signal;
    this.root.querySelectorAll<HTMLButtonElement>("[data-sand-facility-draw]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.dataset.sandFacilityDraw;
        if (isFacilityKind(kind)) this.startDrawing(kind);
      }, { signal });
    });
    this.requiredNode<HTMLButtonElement>("sandFacilityUndoPoint").addEventListener("click", () => this.undoPoint(), { signal });
    this.requiredNode<HTMLButtonElement>("sandFacilityFinish").addEventListener("click", () => this.finishDrawing(), { signal });
    this.requiredNode<HTMLButtonElement>("sandFacilityCancel").addEventListener("click", () => this.cancelDrawing(), { signal });
    this.requiredNode<HTMLInputElement>("sandFacilityOpacity").addEventListener("input", () => this.updateOpacityOutput(), { signal });
    this.requiredNode<HTMLInputElement>("sandFacilityVisible").addEventListener("change", (event) => {
      this.facilitiesVisible = (event.currentTarget as HTMLInputElement).checked;
      if (!this.facilitiesVisible) this.cancelDrawing();
      this.dataSource.show = this.active && this.facilitiesVisible;
      this.schedulePersist();
      this.restartAnimationScheduler();
      this.notifyOverview();
      this.viewer.scene.requestRender();
    }, { signal });
    this.requiredNode<HTMLInputElement>("sandFacilityAnimation").addEventListener("change", (event) => {
      this.animationEnabled = (event.currentTarget as HTMLInputElement).checked;
      this.animationEpoch = performance.now();
      this.schedulePersist();
      this.restartAnimationScheduler();
      this.notifyOverview();
      this.viewer.scene.requestRender();
    }, { signal });
    this.requiredNode<HTMLElement>("sandFacilityList").addEventListener("click", (event) => this.handleListClick(event), { signal });
    document.addEventListener("visibilitychange", () => this.restartAnimationScheduler(), { signal });
    document.addEventListener("keydown", (event) => {
      if (!this.active || !this.drawingKind) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input,textarea,select") || target?.isContentEditable) return;
      if (event.key === "Escape") { event.preventDefault(); this.cancelDrawing(); }
      else if (event.key === "Enter") { event.preventDefault(); this.finishDrawing(); }
    }, { signal });
  }

  private startDrawing(kind: SandTableFacilityKind) {
    if (this.disposed) return;
    if (!this.active) {
      this.notify("请先进入电子沙盘，再创建施工场布。", true);
      return;
    }
    this.cancelDrawing(false);
    this.selectKind(kind);
    if (!this.facilitiesVisible) {
      this.facilitiesVisible = true;
      this.dataSource.show = true;
      this.requiredNode<HTMLInputElement>("sandFacilityVisible").checked = true;
      this.schedulePersist();
    }
    try {
      this.options.stopCameraMotion?.();
      const restore = this.options.beginInteractionSession?.();
      this.restoreInteractionSession = typeof restore === "function" ? restore : () => undefined;
      this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
      this.handler.setInputAction((movement: { position: Cartesian2 }) => this.handleLeftClick(movement.position), ScreenSpaceEventType.LEFT_CLICK);
      this.handler.setInputAction((movement: { endPosition: Cartesian2 }) => this.handleMouseMove(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
      this.handler.setInputAction(() => this.finishDrawing(), ScreenSpaceEventType.RIGHT_CLICK);
      this.drawingKind = kind;
      this.viewer.canvas.style.cursor = "crosshair";
      this.draftEntity = this.dataSource.entities.add({
        id: `${DRAFT_PREFIX}${crypto.randomUUID()}`,
        polyline: {
          positions: new CallbackProperty(() => this.previewPositions(), false),
          width: Math.max(2, this.readStyle(kind).lineWidth),
          material: Color.fromCssColorString(this.readStyle(kind).color).withAlpha(0.9),
          depthFailMaterial: Color.WHITE.withAlpha(0.5),
        },
      });
      this.updateDrawingUi();
      this.setStatus(`正在绘制${KIND_LABELS[kind]}，请在模型或地表上选点。`);
      this.viewer.scene.requestRender();
    } catch (error) {
      this.cancelDrawing();
      this.reportError("无法安全启动场布绘制", error);
    }
  }

  private handleLeftClick(screenPosition: Cartesian2) {
    if (!this.active || !this.drawingKind) return;
    const point = this.pickWorldPosition(screenPosition);
    if (!point) {
      this.notify("该位置未拾取到倾斜摄影、三维模型或地表，请调整视角后重试。", true);
      return;
    }
    if (this.drawingPoints.length >= MAX_POINTS_PER_RECORD) {
      this.notify(`单个设施最多允许 ${MAX_POINTS_PER_RECORD} 个点。`, true);
      return;
    }
    this.drawingPoints.push(Cartesian3.clone(point));
    this.draftVertices.push(this.dataSource.entities.add({
      id: `${DRAFT_PREFIX}point-${crypto.randomUUID()}`,
      position: Cartesian3.clone(point),
      point: { pixelSize: 8, color: Color.WHITE, outlineColor: Color.fromCssColorString(this.readStyle(this.drawingKind).color), outlineWidth: 2, disableDepthTestDistance: 2500 },
    }));
    this.updateDrawingUi();
    this.viewer.scene.requestRender();
  }

  private handleMouseMove(screenPosition: Cartesian2) {
    if (!this.active || !this.drawingKind) return;
    this.pendingHoverScreenPosition = Cartesian2.clone(screenPosition, this.pendingHoverScreenPosition ?? new Cartesian2());
    if (this.hoverPickTimer !== null) return;
    this.hoverPickTimer = window.setTimeout(() => {
      this.hoverPickTimer = null;
      const pending = this.pendingHoverScreenPosition;
      this.pendingHoverScreenPosition = null;
      if (!pending || !this.active || !this.drawingKind) return;
      this.hoverPoint = this.pickWorldPosition(pending);
      this.viewer.scene.requestRender();
    }, HOVER_PICK_INTERVAL_MS);
  }

  private pickWorldPosition(screenPosition: Cartesian2) {
    const scene = this.viewer.scene;
    try {
      const picked = scene.pick(screenPosition);
      if (picked && scene.pickPositionSupported) {
        const position = scene.pickPosition(screenPosition);
        if (position && [position.x, position.y, position.z].every(Number.isFinite)) return Cartesian3.clone(position);
      }
    } catch {
      // A photogrammetry tile can be replaced between the color and depth passes.
    }
    try {
      const ray = this.viewer.camera.getPickRay(screenPosition);
      const globePosition = ray ? scene.globe.pick(ray, scene) : undefined;
      if (globePosition && [globePosition.x, globePosition.y, globePosition.z].every(Number.isFinite)) return Cartesian3.clone(globePosition);
      const ellipsoidPosition = this.viewer.camera.pickEllipsoid(screenPosition, scene.globe.ellipsoid);
      return ellipsoidPosition && [ellipsoidPosition.x, ellipsoidPosition.y, ellipsoidPosition.z].every(Number.isFinite)
        ? Cartesian3.clone(ellipsoidPosition)
        : null;
    } catch {
      return null;
    }
  }

  private previewPositions() {
    if (!this.drawingKind) return [];
    const points = this.drawingPoints.map((point) => Cartesian3.clone(point));
    if (this.hoverPoint && points.length < MAX_POINTS_PER_RECORD) points.push(Cartesian3.clone(this.hoverPoint));
    if ((this.drawingKind === "hardscape" || this.drawingKind === "temporaryBuilding" || (this.drawingKind === "fence" && this.requiredNode<HTMLInputElement>("sandFacilityFenceClosed").checked)) && points.length > 2) {
      points.push(Cartesian3.clone(points[0]));
    }
    return points;
  }

  private undoPoint() {
    if (!this.drawingKind || !this.drawingPoints.length) return;
    this.drawingPoints.pop();
    const vertex = this.draftVertices.pop();
    if (vertex) this.dataSource.entities.remove(vertex);
    this.updateDrawingUi();
    this.viewer.scene.requestRender();
  }

  private finishDrawing() {
    const kind = this.drawingKind;
    if (!kind) return;
    if (this.drawingPoints.length < KIND_MIN_POINTS[kind]) {
      this.notify(`${KIND_LABELS[kind]}至少需要 ${KIND_MIN_POINTS[kind]} 个点。`, true);
      return;
    }
    if (this.records.length >= MAX_RECORDS) {
      this.notify(`施工场布最多允许 ${MAX_RECORDS} 个设施。`, true);
      return;
    }
    const currentPointCount = this.records.reduce((sum, record) => sum + record.positions.length, 0);
    if (currentPointCount + this.drawingPoints.length > MAX_TOTAL_POINTS) {
      this.notify(`施工场布节点总数不能超过 ${MAX_TOTAL_POINTS} 个。`, true);
      return;
    }
    const positions = this.drawingPoints.map(toStoredPosition);
    if (uniquePointCount(positions) < KIND_MIN_POINTS[kind]) {
      this.notify("选点存在重合，无法构成有效设施。", true);
      return;
    }
    const now = new Date().toISOString();
    const base: FacilityRecordBase = {
      id: crypto.randomUUID(),
      projectId: this.projectId,
      name: cleanText(this.requiredNode<HTMLInputElement>("sandFacilityName").value, 80, `${KIND_LABELS[kind]} ${this.records.filter((record) => record.kind === kind).length + 1}`),
      visible: true,
      positions,
      style: this.readStyle(kind),
      createdAt: now,
      updatedAt: now,
    };
    let record: FacilityRecord;
    if (kind === "fence") record = { ...base, kind, properties: {
      height: this.readNumber("sandFacilityFenceHeight", 2, 0.5, 20),
      closed: this.requiredNode<HTMLInputElement>("sandFacilityFenceClosed").checked,
    } };
    else if (kind === "hardscape") record = { ...base, kind, properties: {
      thickness: this.readNumber("sandFacilityHardscapeThickness", 0.2, 0.02, 2),
      material: cleanText(this.requiredNode<HTMLSelectElement>("sandFacilityHardscapeMaterial").value, 30, "混凝土"),
    } };
    else if (kind === "vehicleRoute") {
      let dynamic = this.requiredNode<HTMLInputElement>("sandFacilityRouteDynamic").checked;
      const dynamicCount = this.records.filter((item) => item.kind === "vehicleRoute" && item.properties.dynamic).length;
      if (dynamic && dynamicCount >= MAX_DYNAMIC_ROUTES) {
        dynamic = false;
        this.notify(`动态车辆路径最多 ${MAX_DYNAMIC_ROUTES} 条，本路径已按静态路径创建。`, true);
      }
      record = { ...base, kind, properties: {
        speed: this.readNumber("sandFacilityRouteSpeed", 5, 0.2, 60),
        loop: this.requiredNode<HTMLInputElement>("sandFacilityRouteLoop").checked,
        dynamic,
      } };
    } else record = { ...base, kind, properties: {
      height: this.readNumber("sandFacilityBuildingHeight", 4, 0.5, 100),
      use: cleanText(this.requiredNode<HTMLInputElement>("sandFacilityBuildingUse").value, 60, "临时用房"),
    } };
    const candidate = safeRecord(record, this.projectId);
    if (!candidate) {
      this.notify("场布参数或几何无效，未创建设施。", true);
      return;
    }
    try {
      this.assertStorageCapacity([...this.records, candidate]);
      this.records.push(candidate);
      this.addOrReplaceEntity(candidate);
      this.schedulePersist();
      this.cancelDrawing();
      this.requiredNode<HTMLInputElement>("sandFacilityName").value = "";
      this.renderList();
      this.restartAnimationScheduler();
      this.notifyOverview();
      this.setStatus(`${candidate.name}已创建并保存。`);
      this.viewer.scene.requestRender();
    } catch (error) {
      this.reportError("场布数据超过安全保存容量", error);
    }
  }

  private cancelDrawing(updateUi = true) {
    this.drawingKind = null;
    this.drawingPoints = [];
    this.hoverPoint = null;
    this.pendingHoverScreenPosition = null;
    if (this.hoverPickTimer !== null) window.clearTimeout(this.hoverPickTimer);
    this.hoverPickTimer = null;
    if (this.handler && !this.handler.isDestroyed()) this.handler.destroy();
    this.handler = null;
    if (this.draftEntity) this.dataSource.entities.remove(this.draftEntity);
    this.draftEntity = null;
    for (const vertex of this.draftVertices) this.dataSource.entities.remove(vertex);
    this.draftVertices = [];
    this.viewer.canvas.style.cursor = "";
    const restore = this.restoreInteractionSession;
    this.restoreInteractionSession = null;
    try { restore?.(); } catch (error) { console.warn("[Sand facilities] Unable to restore another interaction", error); }
    if (updateUi) this.updateDrawingUi();
    this.viewer.scene.requestRender();
  }

  private selectKind(kind: SandTableFacilityKind, updateStatus = true) {
    this.root.querySelectorAll<HTMLButtonElement>("[data-sand-facility-draw]").forEach((button) => button.classList.toggle("active", button.dataset.sandFacilityDraw === kind));
    this.root.querySelectorAll<HTMLElement>("[data-sand-facility-fields]").forEach((fields) => fields.classList.toggle("is-hidden", fields.dataset.sandFacilityFields !== kind));
    const color = this.requiredNode<HTMLInputElement>("sandFacilityColor");
    if (!this.drawingKind) color.value = KIND_DEFAULT_COLORS[kind];
    if (updateStatus) this.setStatus(`已选择${KIND_LABELS[kind]}，请在场景中依次选点。`);
  }

  private updateDrawingUi() {
    const drawing = this.drawingKind !== null;
    this.requiredNode<HTMLButtonElement>("sandFacilityUndoPoint").disabled = !drawing || this.drawingPoints.length === 0;
    this.requiredNode<HTMLButtonElement>("sandFacilityFinish").disabled = !drawing || this.drawingPoints.length < (this.drawingKind ? KIND_MIN_POINTS[this.drawingKind] : 1);
    this.requiredNode<HTMLButtonElement>("sandFacilityCancel").disabled = !drawing;
    this.requiredNode<HTMLElement>("sandFacilityDrawState").textContent = drawing
      ? `正在绘制${KIND_LABELS[this.drawingKind!]} · 已选 ${this.drawingPoints.length} 点`
      : "请选择一种场布类型开始绘制";
    this.requiredNode<HTMLElement>("sandFacilityDrawHint").textContent = drawing
      ? "左键选点，右键、Enter 或“完成绘制”结束；Esc 取消"
      : "点位优先拾取倾斜摄影与三维模型，失败时回退到地表";
  }

  private addOrReplaceEntity(record: FacilityRecord) {
    this.dataSource.entities.removeById(record.id);
    this.routeMetrics.delete(record.id);
    const color = Color.fromCssColorString(record.style.color);
    const label = {
      text: record.name,
      font: '600 13px "Microsoft YaHei", sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK.withAlpha(0.85),
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: Color.BLACK.withAlpha(0.58),
      backgroundPadding: new Cartesian2(7, 4),
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -16),
      distanceDisplayCondition: new DistanceDisplayCondition(0, 200_000),
      disableDepthTestDistance: 2_500,
    };
    if (record.kind === "fence") {
      const stored = record.properties.closed ? [...record.positions, record.positions[0]] : record.positions;
      const positions = stored.map((position) => toCartesian(position));
      const minimumHeights = stored.map((position) => position.height + 0.03);
      const maximumHeights = stored.map((position) => position.height + record.properties.height);
      const topPositions = stored.map((position) => toCartesian(position, record.properties.height));
      this.dataSource.entities.add({
        id: record.id,
        name: record.name,
        show: record.visible,
        position: centerPosition(record.positions, record.properties.height),
        wall: { positions, minimumHeights, maximumHeights, material: color.withAlpha(record.style.opacity), outline: false },
        polyline: { positions: topPositions, width: record.style.lineWidth, material: color.withAlpha(Math.max(0.72, record.style.opacity)), depthFailMaterial: color.withAlpha(0.35) },
        label,
      });
      return;
    }
    if (record.kind === "hardscape") {
      const thickness = record.properties.thickness;
      const top = record.positions.map((position) => toCartesian(position, thickness));
      const closedTop = [...top, top[0]];
      const closedStored = [...record.positions, record.positions[0]];
      const base = closedStored.map((position) => toCartesian(position, 0.005));
      this.dataSource.entities.add({
        id: record.id,
        name: `${record.name} · ${record.properties.material}`,
        show: record.visible,
        position: centerPosition(record.positions, thickness),
        polygon: { hierarchy: new PolygonHierarchy(top), perPositionHeight: true, material: color.withAlpha(record.style.opacity), outline: false },
        wall: {
          positions: base,
          minimumHeights: closedStored.map((position) => position.height + 0.005),
          maximumHeights: closedStored.map((position) => position.height + thickness),
          material: color.withAlpha(Math.max(0.4, record.style.opacity * 0.8)),
        },
        polyline: { positions: closedTop, width: record.style.lineWidth, material: color.withAlpha(0.95), depthFailMaterial: color.withAlpha(0.35) },
        label,
      });
      return;
    }
    if (record.kind === "vehicleRoute") {
      const metric = buildRouteMetric(record.positions);
      this.routeMetrics.set(record.id, metric);
      const startPosition = metric.points[0] ?? toCartesian(record.positions[0], 0.18);
      this.dataSource.entities.add({
        id: record.id,
        name: record.name,
        show: record.visible,
        position: new ConstantPositionProperty(startPosition),
        polyline: {
          positions: metric.points,
          width: record.style.lineWidth,
          material: record.properties.dynamic
            ? new PolylineGlowMaterialProperty({ color: color.withAlpha(record.style.opacity), glowPower: 0.18, taperPower: 1 })
            : new PolylineArrowMaterialProperty(color.withAlpha(record.style.opacity)),
          depthFailMaterial: color.withAlpha(0.35),
        },
        point: { pixelSize: record.properties.dynamic ? 12 : 8, color, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: 3000 },
        label,
      });
      return;
    }
    const height = record.properties.height;
    const closedStored = [...record.positions, record.positions[0]];
    const base = closedStored.map((position) => toCartesian(position, 0.03));
    const roof = record.positions.map((position) => toCartesian(position, height));
    const roofOutline = [...roof, roof[0]];
    this.dataSource.entities.add({
      id: record.id,
      name: `${record.name} · ${record.properties.use}`,
      show: record.visible,
      position: centerPosition(record.positions, height),
      wall: {
        positions: base,
        minimumHeights: closedStored.map((position) => position.height + 0.03),
        maximumHeights: closedStored.map((position) => position.height + height),
        material: color.withAlpha(record.style.opacity),
      },
      polygon: { hierarchy: new PolygonHierarchy(roof), perPositionHeight: true, material: color.withAlpha(Math.min(1, record.style.opacity + 0.12)), outline: false },
      polyline: { positions: roofOutline, width: record.style.lineWidth, material: color.withAlpha(0.95), depthFailMaterial: color.withAlpha(0.3) },
      label,
    });
  }

  private startAnimationScheduler() {
    if (!this.shouldAnimate() || this.animationTimer !== null) return;
    if (!this.animationEpoch) this.animationEpoch = performance.now();
    const tick = () => {
      this.animationTimer = null;
      if (!this.shouldAnimate()) return;
      const elapsedSeconds = Math.max(0, performance.now() - this.animationEpoch) / 1000;
      let needsMoreTicks = false;
      for (const record of this.records) {
        if (record.kind !== "vehicleRoute" || !record.visible || !record.properties.dynamic) continue;
        const metric = this.routeMetrics.get(record.id);
        const entity = this.dataSource.entities.getById(record.id);
        if (!metric || !entity || metric.totalLength <= 0.001) continue;
        const travelled = elapsedSeconds * record.properties.speed;
        const distance = record.properties.loop ? travelled % metric.totalLength : Math.min(metric.totalLength, travelled);
        const nextPosition = routePosition(metric, distance);
        if (nextPosition) {
          const property = entity.position;
          if (property instanceof ConstantPositionProperty) property.setValue(nextPosition);
          else entity.position = new ConstantPositionProperty(nextPosition);
        }
        if (record.properties.loop || travelled < metric.totalLength) needsMoreTicks = true;
      }
      this.viewer.scene.requestRender();
      if (needsMoreTicks && this.shouldAnimate()) this.animationTimer = window.setTimeout(tick, ANIMATION_INTERVAL_MS);
    };
    this.animationTimer = window.setTimeout(tick, 0);
  }

  private stopAnimationScheduler() {
    if (this.animationTimer !== null) window.clearTimeout(this.animationTimer);
    this.animationTimer = null;
    this.animationEpoch = 0;
  }

  private restartAnimationScheduler() {
    this.stopAnimationScheduler();
    this.startAnimationScheduler();
  }

  private shouldAnimate() {
    return !this.disposed
      && !this.viewer.isDestroyed()
      && this.active
      && this.facilitiesVisible
      && this.animationEnabled
      && !document.hidden
      && this.records.some((record) => record.kind === "vehicleRoute" && record.visible && record.properties.dynamic);
  }

  private handleListClick(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-sand-facility-action]");
    if (!button) return;
    const id = button.dataset.sandFacilityId ?? "";
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    const action = button.dataset.sandFacilityAction;
    if (action === "visibility") {
      record.visible = !record.visible;
      record.updatedAt = new Date().toISOString();
      const entity = this.dataSource.entities.getById(record.id);
      if (entity) entity.show = record.visible;
      this.schedulePersist();
      this.renderList();
      this.restartAnimationScheduler();
      this.notifyOverview();
      this.viewer.scene.requestRender();
      return;
    }
    if (action === "locate") {
      const entity = this.dataSource.entities.getById(record.id);
      if (!entity || !record.visible) return;
      try { this.options.stopCameraMotion?.(); } catch { /* Locating can continue without a custom stop hook. */ }
      void Promise.resolve(this.viewer.flyTo(entity, { duration: 1.1 })).catch((error) => this.reportError("无法定位场布设施", error));
      return;
    }
    if (action === "delete" && window.confirm(`确定删除“${record.name}”吗？`)) {
      this.records = this.records.filter((item) => item.id !== record.id);
      this.dataSource.entities.removeById(record.id);
      this.routeMetrics.delete(record.id);
      this.schedulePersist();
      this.renderList();
      this.restartAnimationScheduler();
      this.notifyOverview();
      this.setStatus(`${record.name}已删除。`);
      this.viewer.scene.requestRender();
    }
  }

  private renderList() {
    const list = this.requiredNode<HTMLElement>("sandFacilityList");
    this.requiredNode<HTMLElement>("sandFacilityCount").textContent = `${this.records.length} 个设施`;
    if (!this.records.length) {
      list.className = "sand-facility-list";
      list.innerHTML = "<p>尚未创建场布设施</p>";
      return;
    }
    list.className = "sand-facility-list has-items";
    list.innerHTML = this.records.map((record) => `
      <div class="sand-facility-row${record.visible ? "" : " is-hidden-object"}" data-sand-facility-id="${record.id}">
        <i style="--facility-color:${record.style.color}"></i>
        <span><strong>${escapeHtml(record.name)}</strong><small>${KIND_LABELS[record.kind]} · ${record.positions.length} 点</small></span>
        <button type="button" data-sand-facility-action="visibility" data-sand-facility-id="${record.id}" title="${record.visible ? "隐藏" : "显示"}">${record.visible ? "◉" : "○"}</button>
        <button type="button" data-sand-facility-action="locate" data-sand-facility-id="${record.id}" title="定位" ${record.visible ? "" : "disabled"}>⌖</button>
        <button type="button" data-sand-facility-action="delete" data-sand-facility-id="${record.id}" title="删除">×</button>
      </div>`).join("");
  }

  private readStyle(kind: SandTableFacilityKind): FacilityStyle {
    return {
      color: safeColor(this.requiredNode<HTMLInputElement>("sandFacilityColor").value, KIND_DEFAULT_COLORS[kind]),
      opacity: this.readNumber("sandFacilityOpacity", 0.72, 0.1, 1),
      lineWidth: this.readNumber("sandFacilityLineWidth", 4, 1, 16),
    };
  }

  private readNumber(id: string, fallback: number, minimum: number, maximum: number) {
    const input = this.requiredNode<HTMLInputElement>(id);
    const safe = finiteNumber(input.valueAsNumber, fallback, minimum, maximum);
    input.value = String(safe);
    return safe;
  }

  private updateOpacityOutput() {
    this.requiredNode<HTMLOutputElement>("sandFacilityOpacityValue").value = `${Math.round(this.readNumber("sandFacilityOpacity", 0.72, 0.1, 1) * 100)}%`;
  }

  private syncSettingsUi() {
    this.requiredNode<HTMLInputElement>("sandFacilityVisible").checked = this.facilitiesVisible;
    this.requiredNode<HTMLInputElement>("sandFacilityAnimation").checked = this.animationEnabled;
    this.updateOpacityOutput();
  }

  private loadState() {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw || new TextEncoder().encode(raw).byteLength > MAX_STORAGE_BYTES) return;
      const parsed = JSON.parse(raw) as Partial<StoredState> | null;
      if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.items)) return;
      const sourceProjectId = cleanText(parsed.projectId, 100, this.projectId);
      if (sourceProjectId !== this.projectId) return;
      this.animationEnabled = parsed.settings?.animationEnabled !== false;
      this.facilitiesVisible = parsed.settings?.facilitiesVisible !== false;
      const ids = new Set<string>();
      let totalPoints = 0;
      let dynamicRoutes = 0;
      for (const value of parsed.items.slice(0, MAX_RECORDS)) {
        const record = safeRecord(value, this.projectId);
        if (!record || ids.has(record.id) || totalPoints + record.positions.length > MAX_TOTAL_POINTS) continue;
        if (record.kind === "vehicleRoute" && record.properties.dynamic) {
          if (dynamicRoutes >= MAX_DYNAMIC_ROUTES) record.properties.dynamic = false;
          else dynamicRoutes += 1;
        }
        ids.add(record.id);
        totalPoints += record.positions.length;
        this.records.push(record);
      }
    } catch (error) {
      console.warn("[Sand facilities] Unable to load saved state", error);
      this.records = [];
    }
  }

  private assertStorageCapacity(records: FacilityRecord[]) {
    if (records.length > MAX_RECORDS) throw new Error(`设施数量不能超过 ${MAX_RECORDS} 个`);
    const totalPoints = records.reduce((sum, record) => sum + record.positions.length, 0);
    if (records.some((record) => record.positions.length > MAX_POINTS_PER_RECORD)) throw new Error(`单个设施不能超过 ${MAX_POINTS_PER_RECORD} 个点`);
    if (totalPoints > MAX_TOTAL_POINTS) throw new Error(`节点总数不能超过 ${MAX_TOTAL_POINTS} 个`);
    const dynamicRoutes = records.filter((record) => record.kind === "vehicleRoute" && record.properties.dynamic).length;
    if (dynamicRoutes > MAX_DYNAMIC_ROUTES) throw new Error(`动态车辆路径不能超过 ${MAX_DYNAMIC_ROUTES} 条`);
    const payload = this.serializeState(records);
    if (new TextEncoder().encode(payload).byteLength > MAX_STORAGE_BYTES) throw new Error("场布数据已超过 2 MB 本机安全保存容量");
  }

  private serializeState(records = this.records) {
    return JSON.stringify({
      version: STORAGE_VERSION,
      projectId: this.projectId,
      settings: { animationEnabled: this.animationEnabled, facilitiesVisible: this.facilitiesVisible },
      items: records,
    } satisfies StoredState);
  }

  private schedulePersist() {
    try {
      this.assertStorageCapacity(this.records);
      this.pendingPersistPayload = this.serializeState();
    } catch (error) {
      this.reportError("施工场布未保存", error);
      return;
    }
    if (this.pendingPersistTimer !== null) window.clearTimeout(this.pendingPersistTimer);
    this.pendingPersistTimer = window.setTimeout(() => this.flushPersist(), 220);
  }

  private flushPersist() {
    if (this.pendingPersistTimer !== null) window.clearTimeout(this.pendingPersistTimer);
    this.pendingPersistTimer = null;
    if (!this.pendingPersistPayload) return;
    const payload = this.pendingPersistPayload;
    this.pendingPersistPayload = "";
    try { globalThis.localStorage?.setItem(this.storageKey, payload); }
    catch (error) { this.reportError("浏览器本机存储空间不足，施工场布仅保留在当前页面", error); }
  }

  private notifyOverview() {
    if (this.disposed || !this.overviewListeners.size) return;
    const snapshot = this.getOverviewSnapshot();
    for (const listener of [...this.overviewListeners]) {
      try { listener(snapshot); } catch (error) { console.warn("[Sand facilities] Overview listener failed", error); }
    }
  }

  private removeOwnDataSource() {
    try {
      if (!this.viewer.isDestroyed() && this.viewer.dataSources.contains(this.dataSource)) this.viewer.dataSources.remove(this.dataSource, false);
    } catch (error) { console.warn("[Sand facilities] Unable to remove data source", error); }
  }

  private setStatus(message: string, error = false) {
    const status = this.requiredNode<HTMLElement>("sandFacilityStatus");
    status.textContent = cleanText(message, 180, error ? "操作失败" : "施工场布已更新");
    status.classList.toggle("error", error);
  }

  private notify(message: string, error = false) {
    this.setStatus(message, error);
    try { this.options.toast?.(message, error); } catch { /* A host notification must not break the module. */ }
  }

  private reportError(context: string, error: unknown) {
    const message = error instanceof Error ? `${context}：${error.message}` : context;
    console.warn(`[Sand facilities] ${context}`, error);
    this.notify(message, true);
  }

  private node<T extends Element = HTMLElement>(id: string) {
    return this.root.querySelector<T>(`#${id}`);
  }

  private requiredNode<T extends Element = HTMLElement>(id: string) {
    const node = this.node<T>(id);
    if (!node) throw new Error(`缺少施工场布界面元素：#${id}`);
    return node;
  }
}
