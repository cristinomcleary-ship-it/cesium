import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  ClassificationType,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  CustomDataSource,
  Entity,
  HeightReference,
  HorizontalOrigin,
  ImageMaterialProperty,
  LabelStyle,
  Math as CesiumMath,
  PolygonHierarchy,
  PolylineArrowMaterialProperty,
  PolylineDashMaterialProperty,
  PolylineGlowMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  Viewer,
} from "cesium";
import "./markupTools.css";

export type MarkupKind = "point" | "text" | "label" | "polyline" | "polygon" | "rectangle" | "circle" | "facade" | "volume";
export type MarkupOverviewItem = Readonly<{
  id: string;
  name: string;
  kind: MarkupKind;
  visible: boolean;
  updatedAt: string;
}>;
export type MarkupOverviewSnapshot = Readonly<{
  total: number;
  visible: number;
  hidden: number;
  byKind: Readonly<Record<MarkupKind, number>>;
  items: ReadonlyArray<MarkupOverviewItem>;
}>;
export type MarkupOverviewListener = (snapshot: MarkupOverviewSnapshot) => void;
export type MarkupDisplayItem = { id: string; name: string; kind: MarkupKind; visible: boolean; defaultVisible: boolean };
type HeightMode = "picked" | "surface";
type LineEffect = "solid" | "flowDash" | "pulseGlow" | "arrow";
type StoredPosition = { longitude: number; latitude: number; height: number };
type MarkupStyle = { color: string; opacity: number; lineWidth: number; pointSize: number; fontSize: number; lineEffect: LineEffect; effectSpeed: number; verticalHeight: number };
type MarkupRecord = {
  id: string;
  kind: MarkupKind;
  name: string;
  note: string;
  visible: boolean;
  heightMode: HeightMode;
  positions: StoredPosition[];
  radius?: number;
  textureId?: string;
  textureName?: string;
  style: MarkupStyle;
  createdAt: string;
  updatedAt: string;
};
type PendingTexture = { id: string; name: string; blob: Blob; url: string };
type StoredTexture = { id: string; name: string; blob: Blob; updatedAt: string };

type MarkupToolsOptions = { prepareForDrawing?: () => void | (() => void) };

const STORAGE_KEY = "cesium-global-markups-v1";
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_STORED_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 2_000;
const MAX_POSITIONS_PER_RECORD = 5_000;
const MAX_TOTAL_POSITIONS = 30_000;
const MAX_VOLUME_POSITIONS = 500;
const MAX_DYNAMIC_LINES = 300;
const MAX_HISTORY_STEPS = 30;
const MAX_HISTORY_MEMORY_BYTES = 8 * 1024 * 1024;
const MIN_SAFE_HEIGHT = -100_000;
const MAX_SAFE_HEIGHT = 1_000_000;
const MAX_SAFE_RADIUS = 20_000_000;
const MIN_VERTICAL_HEIGHT = 0.1;
const MAX_VERTICAL_HEIGHT = 100_000;
const MAX_TEXTURE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TEXTURE_DIMENSION = 4_096;
const RECOVERY_STORAGE_KEY = `${STORAGE_KEY}-recovery`;
const TEXTURE_DATABASE_NAME = "cesium-markup-textures-v1";
const TEXTURE_STORE_NAME = "textures";
const KIND_LABELS: Record<MarkupKind, string> = {
  point: "点标记",
  text: "文字标注",
  label: "标签",
  polyline: "折线",
  polygon: "多边形",
  rectangle: "矩形",
  circle: "圆形",
  facade: "立面",
  volume: "体",
};
const KIND_ICONS: Record<MarkupKind, string> = { point: "●", text: "T", label: "▰", polyline: "⌁", polygon: "⬟", rectangle: "□", circle: "○", facade: "▥", volume: "⬢" };
const KIND_MIN_POINTS: Record<MarkupKind, number> = { point: 1, text: 1, label: 1, polyline: 2, polygon: 3, rectangle: 2, circle: 2, facade: 2, volume: 3 };
const DEFAULT_STYLE: MarkupStyle = { color: "#32d5f2", opacity: 0.55, lineWidth: 4, pointSize: 12, fontSize: 15, lineEffect: "solid", effectSpeed: 1, verticalHeight: 10 };

export const markupPanelHtml = `
  <section class="panel markup-panel" data-panel="markup">
    <div class="markup-heading">
      <div><strong>场景标绘</strong><small>POINT · LINE · SURFACE · VOLUME</small></div>
      <span>独立自动保存</span>
    </div>
    <p class="markup-copy">在地表、倾斜摄影或三维模型上绘制标签、动态线、面、贴图立面和三维体。标绘与工程图层分开保存和清理。</p>

    <div class="markup-summary">
      <div><span id="markupPointCount">0</span><small>点 / 标签</small></div>
      <div><span id="markupLineCount">0</span><small>线 / 立面</small></div>
      <div><span id="markupAreaCount">0</span><small>面 / 体</small></div>
    </div>

    <div class="markup-section-title"><strong>创建标绘</strong><span>Alt+1 / 2 / 3</span></div>
    <div class="markup-tool-grid">
      <button data-markup-draw="point"><b>●</b><span>点</span></button>
      <button data-markup-draw="text"><b>T</b><span>文字</span></button>
      <button data-markup-draw="label"><b>▰</b><span>标签</span></button>
      <button data-markup-draw="polyline"><b>⌁</b><span>折线</span></button>
      <button data-markup-draw="polygon"><b>⬟</b><span>多边形</span></button>
      <button data-markup-draw="rectangle"><b>□</b><span>矩形</span></button>
      <button data-markup-draw="circle"><b>○</b><span>圆</span></button>
      <button data-markup-draw="facade"><b>▥</b><span>立面</span></button>
      <button data-markup-draw="volume"><b>⬢</b><span>体</span></button>
    </div>

    <div class="markup-draw-state">
      <div><strong id="markupDrawState">选择一种标绘类型开始</strong><small id="markupDrawHint">点选已有标绘可编辑属性</small></div>
      <div class="markup-draw-actions">
        <button id="markupUndoVertex" disabled>撤销节点</button>
        <button id="markupFinishDrawing" disabled>完成</button>
        <button id="markupCancelDrawing" disabled>取消</button>
      </div>
    </div>

    <details class="markup-properties" open>
      <summary>属性与样式</summary>
      <label>名称<input id="markupName" maxlength="80" placeholder="未填写时自动命名" /></label>
      <label>备注<textarea id="markupNote" rows="3" maxlength="600" placeholder="可记录设计说明、问题或整改意见"></textarea></label>
      <div class="field-grid markup-style-grid">
        <label>颜色<input id="markupColor" type="color" value="#32d5f2" /></label>
        <label>贴合方式<select id="markupHeightMode"><option value="picked">保持模型/点选高程</option><option value="surface">贴合地表与模型</option></select></label>
        <label>透明度 <output id="markupOpacityValue">55%</output><input id="markupOpacity" type="range" min="0.05" max="1" step="0.05" value="0.55" /></label>
        <label>线宽（像素）<input id="markupLineWidth" type="number" min="1" max="20" step="1" value="4" /></label>
        <label>点大小（像素）<input id="markupPointSize" type="number" min="4" max="60" step="1" value="12" /></label>
        <label>文字大小（像素）<input id="markupFontSize" type="number" min="10" max="48" step="1" value="15" /></label>
        <label id="markupLineEffectField" class="markup-conditional hidden">线条效果<select id="markupLineEffect"><option value="solid">静态实线</option><option value="flowDash">流动虚线</option><option value="pulseGlow">呼吸发光</option><option value="arrow">方向箭头</option></select></label>
        <label id="markupEffectSpeedField" class="markup-conditional hidden">动画速度 <output id="markupEffectSpeedValue">1.0×</output><input id="markupEffectSpeed" type="range" min="0.2" max="3" step="0.1" value="1" /></label>
        <label id="markupVerticalHeightField" class="markup-conditional hidden">立面/体高度（米）<input id="markupVerticalHeight" type="number" min="0.1" max="100000" step="0.1" value="10" /></label>
      </div>
      <div id="markupTextureFields" class="markup-texture-field markup-conditional hidden">
        <span>立面贴图</span>
        <div><label>选择图片<input id="markupTextureFile" type="file" accept="image/png,image/jpeg,image/webp" hidden /></label><button id="markupClearTexture" type="button">移除贴图</button></div>
        <small id="markupTextureStatus">未选择贴图，将使用当前颜色</small>
      </div>
      <div class="markup-property-actions">
        <button id="markupApplyProperties" class="accent">应用到选中对象</button>
        <button id="markupRedrawSelected">重新绘制</button>
      </div>
    </details>

    <div class="markup-section-title"><strong>标绘对象</strong><span id="markupListCount">0 个</span></div>
    <div id="markupList" class="markup-empty">尚未创建标绘</div>

    <div class="markup-history-actions">
      <button id="markupUndo" disabled>↶ 撤销</button>
      <button id="markupRedo" disabled>↷ 重做</button>
    </div>
    <div class="markup-file-actions">
      <button id="markupExport">导出 GeoJSON</button>
      <label>导入标绘<input id="markupImportFile" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden /></label>
      <button id="markupClearAll" class="danger">清空标绘</button>
    </div>
    <div id="markupStatus" class="markup-status">标绘独立保存在本机浏览器中。</div>
  </section>`;

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`缺少标绘界面元素：${selector}`);
  return found;
}

function isMarkupKind(value: unknown): value is MarkupKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(KIND_LABELS, value);
}

function isLineEffect(value: unknown): value is LineEffect {
  return value === "solid" || value === "flowDash" || value === "pulseGlow" || value === "arrow";
}

function utf8ByteSize(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function historyMemorySize(value: string) {
  return value.length * 2;
}

function openTextureDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in globalThis)) return reject(new Error("当前浏览器不支持立面贴图持久化"));
    const request = indexedDB.open(TEXTURE_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TEXTURE_STORE_NAME)) database.createObjectStore(TEXTURE_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开立面贴图库"));
    request.onblocked = () => reject(new Error("立面贴图库正在被其他页面占用"));
  });
}

async function saveTextureBlob(texture: PendingTexture) {
  const database = await openTextureDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(TEXTURE_STORE_NAME, "readwrite");
      transaction.objectStore(TEXTURE_STORE_NAME).put({ id: texture.id, name: texture.name, blob: texture.blob, updatedAt: new Date().toISOString() } satisfies StoredTexture);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("立面贴图保存失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("立面贴图保存被中止"));
    });
  } finally { database.close(); }
}

async function loadTextureBlob(id: string) {
  const database = await openTextureDatabase();
  try {
    return await new Promise<StoredTexture | null>((resolve, reject) => {
      const transaction = database.transaction(TEXTURE_STORE_NAME, "readonly");
      const request = transaction.objectStore(TEXTURE_STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as StoredTexture | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("立面贴图读取失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("立面贴图读取被中止"));
    });
  } finally { database.close(); }
}

async function pruneTextureBlobs(keepIds: ReadonlySet<string>, shouldContinue: () => boolean) {
  const database = await openTextureDatabase();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const transaction = database.transaction(TEXTURE_STORE_NAME, "readonly");
      const request = transaction.objectStore(TEXTURE_STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("立面贴图索引读取失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("立面贴图索引读取被中止"));
    });
    if (!shouldContinue()) return;
    const removable = keys.filter((key): key is string => typeof key === "string" && !keepIds.has(key));
    if (!removable.length) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(TEXTURE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(TEXTURE_STORE_NAME);
      removable.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("立面贴图清理失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("立面贴图清理被中止"));
    });
  } finally { database.close(); }
}

function finite(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

function toStoredPosition(cartesian: Cartesian3): StoredPosition {
  const cartographic = Cartographic.fromCartesian(cartesian);
  return {
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    height: Number.isFinite(cartographic.height) ? cartographic.height : 0,
  };
}

function toCartesian(position: StoredPosition) {
  return Cartesian3.fromDegrees(position.longitude, position.latitude, position.height);
}

function safeStyle(value: unknown): MarkupStyle {
  const source = value && typeof value === "object" ? value as Partial<MarkupStyle> : {};
  const color = typeof source.color === "string" && /^#[0-9a-f]{6}$/i.test(source.color) ? source.color : DEFAULT_STYLE.color;
  return {
    color,
    opacity: clamp(finite(source.opacity, DEFAULT_STYLE.opacity), 0.05, 1),
    lineWidth: clamp(finite(source.lineWidth, DEFAULT_STYLE.lineWidth), 1, 20),
    pointSize: clamp(finite(source.pointSize, DEFAULT_STYLE.pointSize), 4, 60),
    fontSize: clamp(finite(source.fontSize, DEFAULT_STYLE.fontSize), 10, 48),
    lineEffect: isLineEffect(source.lineEffect) ? source.lineEffect : DEFAULT_STYLE.lineEffect,
    effectSpeed: clamp(finite(source.effectSpeed, DEFAULT_STYLE.effectSpeed), 0.2, 3),
    verticalHeight: clamp(finite(source.verticalHeight, DEFAULT_STYLE.verticalHeight), MIN_VERTICAL_HEIGHT, MAX_VERTICAL_HEIGHT),
  };
}

function safePosition(value: unknown): StoredPosition | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<StoredPosition>;
  const longitude = source.longitude;
  const latitude = source.latitude;
  const height = source.height ?? 0;
  if (typeof longitude !== "number" || typeof latitude !== "number" || typeof height !== "number") return null;
  if (![longitude, latitude, height].every(Number.isFinite) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 || height < MIN_SAFE_HEIGHT || height > MAX_SAFE_HEIGHT) return null;
  return { longitude, latitude, height };
}

function safeRecord(value: unknown): MarkupRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<MarkupRecord>;
  if (!isMarkupKind(source.kind)) return null;
  const positions = Array.isArray(source.positions) ? source.positions.map(safePosition).filter((item): item is StoredPosition => item !== null) : [];
  if (positions.length < KIND_MIN_POINTS[source.kind] || positions.length > MAX_POSITIONS_PER_RECORD) return null;
  const now = new Date().toISOString();
  let radius: number | undefined;
  if (source.kind === "circle") {
    const fallbackRadius = Cartesian3.distance(toCartesian(positions[0]), toCartesian(positions[1]));
    radius = typeof source.radius === "number" ? source.radius : fallbackRadius;
    if (!Number.isFinite(radius) || radius <= 0.01 || radius > MAX_SAFE_RADIUS) return null;
  }
  return {
    id: typeof source.id === "string" && /^[a-z0-9_-]{1,100}$/i.test(source.id) ? source.id : crypto.randomUUID(),
    kind: source.kind,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 80) : KIND_LABELS[source.kind],
    note: typeof source.note === "string" ? source.note.slice(0, 600) : "",
    visible: source.visible !== false,
    heightMode: source.kind === "facade" || source.kind === "volume" ? "picked" : source.heightMode === "surface" ? "surface" : "picked",
    positions,
    radius,
    textureId: source.kind === "facade" && typeof source.textureId === "string" && /^[a-z0-9_-]{1,100}$/i.test(source.textureId) ? source.textureId : undefined,
    textureName: source.kind === "facade" && typeof source.textureName === "string" ? source.textureName.slice(0, 160) : undefined,
    style: safeStyle(source.style),
    createdAt: typeof source.createdAt === "string" ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : now,
  };
}

function validateRecordGeometry(record: MarkupRecord) {
  if (record.positions.length < KIND_MIN_POINTS[record.kind] || record.positions.length > MAX_POSITIONS_PER_RECORD) {
    throw new Error(`${KIND_LABELS[record.kind]}的节点数量不符合要求`);
  }
  for (const position of record.positions) {
    if (!safePosition(position)) throw new Error(`${record.name}包含超出安全范围的坐标或高程`);
    const cartesian = toCartesian(position);
    if (![cartesian.x, cartesian.y, cartesian.z].every(Number.isFinite)) throw new Error(`${record.name}无法转换为有效三维坐标`);
  }
  const unique = new Set(record.positions.map((position) => `${position.longitude.toFixed(10)},${position.latitude.toFixed(10)},${position.height.toFixed(4)}`));
  if ((["polyline", "facade"].includes(record.kind) && unique.size < 2) || (["polygon", "volume"].includes(record.kind) && unique.size < 3)) {
    throw new Error(`${record.name}存在重合节点，无法形成有效几何`);
  }
  if (record.kind === "facade" && record.positions.length !== 2) throw new Error(`${record.name}必须由两个立面底边点组成`);
  if (record.kind === "volume" && record.positions.length > MAX_VOLUME_POSITIONS) throw new Error(`体标绘不能超过 ${MAX_VOLUME_POSITIONS} 个底面节点`);
  if ((record.kind === "facade" || record.kind === "volume") && (record.style.verticalHeight < MIN_VERTICAL_HEIGHT || record.style.verticalHeight > MAX_VERTICAL_HEIGHT)) {
    throw new Error(`${record.name}的高度超出安全范围`);
  }
  if (record.kind === "rectangle") {
    const [first, second] = record.positions;
    if (Math.abs(first.longitude - second.longitude) < 1e-12 || Math.abs(first.latitude - second.latitude) < 1e-12) {
      throw new Error(`${record.name}的长或宽为零`);
    }
  }
  if (record.kind === "circle" && (!Number.isFinite(record.radius) || (record.radius ?? 0) <= 0.01 || (record.radius ?? 0) > MAX_SAFE_RADIUS)) {
    throw new Error(`${record.name}的半径无效`);
  }
}

function circlePositions(center: StoredPosition, radius: number, segments = 64) {
  const earthRadius = 6378137;
  const angularDistance = Math.max(0.01, radius) / earthRadius;
  const latitude1 = CesiumMath.toRadians(center.latitude);
  const longitude1 = CesiumMath.toRadians(center.longitude);
  const result: StoredPosition[] = [];
  for (let index = 0; index < segments; index += 1) {
    const bearing = (index / segments) * Math.PI * 2;
    const latitude2 = Math.asin(Math.sin(latitude1) * Math.cos(angularDistance) + Math.cos(latitude1) * Math.sin(angularDistance) * Math.cos(bearing));
    const longitude2 = longitude1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude1), Math.cos(angularDistance) - Math.sin(latitude1) * Math.sin(latitude2));
    result.push({ longitude: CesiumMath.toDegrees(longitude2), latitude: CesiumMath.toDegrees(latitude2), height: center.height });
  }
  return result;
}

function rectanglePositions(first: StoredPosition, second: StoredPosition) {
  const west = Math.min(first.longitude, second.longitude);
  const east = Math.max(first.longitude, second.longitude);
  const south = Math.min(first.latitude, second.latitude);
  const north = Math.max(first.latitude, second.latitude);
  const height = (first.height + second.height) / 2;
  return [
    { longitude: west, latitude: south, height },
    { longitude: east, latitude: south, height },
    { longitude: east, latitude: north, height },
    { longitude: west, latitude: north, height },
  ];
}

function displayPositions(record: MarkupRecord) {
  if (record.kind === "rectangle") return rectanglePositions(record.positions[0], record.positions[1]);
  if (record.kind === "circle") return circlePositions(record.positions[0], record.radius ?? 1);
  return record.positions;
}

function centerPosition(positions: StoredPosition[]) {
  const total = positions.reduce((sum, position) => ({ longitude: sum.longitude + position.longitude, latitude: sum.latitude + position.latitude, height: sum.height + position.height }), { longitude: 0, latitude: 0, height: 0 });
  const count = Math.max(1, positions.length);
  return { longitude: total.longitude / count, latitude: total.latitude / count, height: total.height / count };
}

export class MarkupTools {
  private readonly dataSource = new CustomDataSource("全局标绘");
  private dataSourceAddPromise: Promise<CustomDataSource> | null = null;
  private handler: ScreenSpaceEventHandler | null = null;
  private readonly abortController = new AbortController();
  private removeSelectedListener: (() => void) | null = null;
  private records: MarkupRecord[] = [];
  private recoveryPayload: string | null = null;
  private recoveryOmittedCount = 0;
  private recoveryBackupDownloaded = false;
  private selectedId: string | null = null;
  private drawingKind: MarkupKind | null = null;
  private drawingSession = 0;
  private redrawId: string | null = null;
  private drawingPoints: Cartesian3[] = [];
  private hoverPoint: Cartesian3 | null = null;
  private draftEntity: Entity | null = null;
  private draftVertices: Entity[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pendingTexture: PendingTexture | null = null;
  private readonly textureUrls = new Map<string, string>();
  private readonly textureLoads = new Set<string>();
  private readonly missingTextureIds = new Set<string>();
  private readonly textureSavePromises = new Map<string, Promise<void>>();
  private readonly textureSaveErrors = new Map<string, string>();
  private textureSelectionPromise: Promise<void> | null = null;
  private textureSelectionVersion = 0;
  private textureReferenceVersion = 0;
  private textureGcTimer: number | null = null;
  private dynamicLinesRendered = 0;
  private resumeExternalInteractions: (() => void) | null = null;
  private readonly overviewListeners = new Set<MarkupOverviewListener>();
  private readonly displayVisibility = new Map<string, boolean>();
  private displayLabelsVisible = true;
  private disposed = false;

  constructor(private readonly viewer: Viewer, private readonly toast: (message: string, error?: boolean) => void, private readonly options: MarkupToolsOptions = {}) {
    this.validateInterface();
    try {
      this.records = this.loadRecords();
      this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
      this.bindInputs();
      this.removeSelectedListener = viewer.selectedEntityChanged.addEventListener((selected) => {
        // Cesium's default selection handler still runs while our drawing handler is
        // active. Ignore those transient picks so drawing across an existing markup
        // cannot overwrite the form values prepared for the new object.
        if (this.drawingKind) return;
        if (selected && this.records.some((record) => record.id === selected.id)) this.selectRecord(selected.id, false);
      });
      this.rebuildEntities();
      this.render();
      if (this.recoveryPayload) {
        const message = `检测到 ${this.recoveryOmittedCount} 条旧版或异常标绘，已安全载入可用部分；首次修改前会自动下载原始备份`;
        element("#markupStatus").textContent = message;
        this.toast(message, true);
      }
      this.dataSourceAddPromise = viewer.dataSources.add(this.dataSource);
      void this.dataSourceAddPromise.then(() => {
        if (this.disposed && !viewer.isDestroyed() && viewer.dataSources.contains(this.dataSource)) viewer.dataSources.remove(this.dataSource, true);
      }).catch((error) => console.error("[Markup] Unable to add the markup data source", error));
      this.scheduleTextureGarbageCollection();
    } catch (error) {
      this.disposed = true;
      this.abortController.abort();
      this.removeSelectedListener?.();
      this.removeSelectedListener = null;
      if (this.handler && !this.handler.isDestroyed()) this.handler.destroy();
      this.handler = null;
      if (!viewer.isDestroyed() && viewer.dataSources.contains(this.dataSource)) viewer.dataSources.remove(this.dataSource, true);
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelInteraction(false, true);
    this.abortController.abort();
    this.removeSelectedListener?.();
    this.removeSelectedListener = null;
    if (this.handler && !this.handler.isDestroyed()) this.handler.destroy();
    this.handler = null;
    const urls = new Set(this.textureUrls.values());
    if (this.pendingTexture) urls.add(this.pendingTexture.url);
    urls.forEach((url) => URL.revokeObjectURL(url));
    this.textureUrls.clear();
    this.textureLoads.clear();
    this.missingTextureIds.clear();
    this.textureSavePromises.clear();
    this.textureSaveErrors.clear();
    this.textureSelectionVersion += 1;
    this.textureSelectionPromise = null;
    if (this.textureGcTimer !== null) window.clearTimeout(this.textureGcTimer);
    this.textureGcTimer = null;
    this.pendingTexture = null;
    this.overviewListeners.clear();
    this.displayVisibility.clear();
    if (!this.viewer.isDestroyed()) this.viewer.dataSources.remove(this.dataSource, true);
  }

  getOverviewSnapshot(): MarkupOverviewSnapshot {
    const byKind: Record<MarkupKind, number> = {
      point: 0,
      text: 0,
      label: 0,
      polyline: 0,
      polygon: 0,
      rectangle: 0,
      circle: 0,
      facade: 0,
      volume: 0,
    };
    let visible = 0;
    for (const record of this.records) {
      byKind[record.kind] += 1;
      if (this.isDisplayed(record)) visible += 1;
    }
    const items = this.records.slice(0, 100).map((record) => Object.freeze({
      id: record.id,
      name: record.name,
      kind: record.kind,
      visible: this.isDisplayed(record),
      updatedAt: record.updatedAt,
    }));
    return Object.freeze({
      total: this.records.length,
      visible,
      hidden: this.records.length - visible,
      byKind: Object.freeze(byKind),
      items: Object.freeze(items),
    });
  }

  /** Complete display inventory, independent of the compact 100-item overview. */
  getDisplayItems(): MarkupDisplayItem[] {
    return this.records.map(record => ({ id: record.id, name: record.name, kind: record.kind,
      visible: this.isDisplayed(record), defaultVisible: record.visible }));
  }

  /** One displayed object only; retains the normal undo history and persistence rollback. */
  getDisplayObjectRemoval(id: string): { remove: () => void; detail: string } | undefined {
    const record = this.records.find(item => item.id === id);
    if (!record || this.disposed || this.viewer.isDestroyed()) return;
    const snapshot = JSON.stringify(record);
    return { detail: '删除该标绘，可在标绘工具中撤销', remove: () => {
      const current = this.records.find(item => item.id === id);
      if (!current || JSON.stringify(current) !== snapshot) throw new Error('该标绘已更新或删除，请刷新后重试。');
      this.removeDisplayObject(id);
    } };
  }

  removeDisplayObject(id: string): void {
    if (this.disposed || this.viewer.isDestroyed()) throw new Error('标绘工作台已关闭。');
    if (this.drawingKind || this.redrawId) throw new Error('请先完成或取消当前标绘，再删除对象。');
    if (!this.records.some(item => item.id === id)) throw new Error('该标绘已经删除。');
    const wasSelected = this.selectedId === id;
    if (!this.mutate(() => { this.records = this.records.filter(item => item.id !== id); })) throw new Error('标绘删除失败，原数据已保留。');
    this.displayVisibility.delete(id);
    if (wasSelected) {
      this.selectedId = null;
      if (this.viewer.selectedEntity?.id === id) this.viewer.selectedEntity = undefined;
    }
    this.render();
  }

  /** Replace temporary display preferences without mutating records, history or persistence. */
  setDisplayVisibility(overrides: Record<string, boolean>, labelsVisible = true): void {
    if (this.disposed || this.viewer.isDestroyed()) return;
    const next = new Map(Object.entries(overrides).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    if (labelsVisible === this.displayLabelsVisible && next.size === this.displayVisibility.size
      && [...next].every(([id, visible]) => this.displayVisibility.get(id) === visible)) return;
    this.displayVisibility.clear();
    for (const [id, visible] of next) this.displayVisibility.set(id, visible);
    this.displayLabelsVisible = labelsVisible;
    for (const record of this.records) {
      const entity = this.dataSource.entities.getById(record.id), visible = this.isDisplayed(record);
      if (entity) {
        entity.show = visible;
        if (entity.label) entity.label.show = new ConstantProperty(visible && (record.kind === "text" || this.displayLabelsVisible));
      }
      if (visible && record.kind === "facade" && record.textureId && !this.textureUrls.has(record.textureId)) void this.hydrateTexture(record);
    }
    this.render();
    this.viewer.scene.requestRender();
  }

  private isDisplayed(record: MarkupRecord): boolean {
    return this.displayVisibility.get(record.id) ?? record.visible;
  }

  subscribeOverview(listener: MarkupOverviewListener): () => void {
    if (this.disposed) return () => undefined;
    this.overviewListeners.add(listener);
    this.notifyOverviewListener(listener, this.getOverviewSnapshot());
    return () => { this.overviewListeners.delete(listener); };
  }

  private notifyOverviewListener(listener: MarkupOverviewListener, snapshot: MarkupOverviewSnapshot) {
    try { listener(snapshot); }
    catch (error) { console.error("[Markup] Overview listener failed", error); }
  }

  private notifyOverviewListeners() {
    if (this.disposed || !this.overviewListeners.size) return;
    const snapshot = this.getOverviewSnapshot();
    for (const listener of [...this.overviewListeners]) this.notifyOverviewListener(listener, snapshot);
  }

  private validateInterface() {
    const selectors = [
      "#markupUndoVertex", "#markupFinishDrawing", "#markupCancelDrawing", "#markupApplyProperties", "#markupRedrawSelected",
      "#markupUndo", "#markupRedo", "#markupExport", "#markupImportFile", "#markupClearAll", "#markupOpacity",
      "#markupName", "#markupNote", "#markupColor", "#markupHeightMode", "#markupLineWidth", "#markupPointSize",
      "#markupFontSize", "#markupList", "#markupListCount", "#markupPointCount", "#markupLineCount", "#markupAreaCount",
      "#markupStatus", "#markupDrawState", "#markupDrawHint", "#markupOpacityValue", "#markupLineEffect", "#markupEffectSpeed",
      "#markupEffectSpeedValue", "#markupVerticalHeight", "#markupTextureFile", "#markupClearTexture", "#markupTextureStatus",
      "#markupLineEffectField", "#markupEffectSpeedField", "#markupVerticalHeightField", "#markupTextureFields",
    ];
    selectors.forEach((selector) => element(selector));
    if (document.querySelectorAll("[data-markup-draw]").length !== Object.keys(KIND_LABELS).length) {
      throw new Error("标绘工具按钮不完整");
    }
  }

  cancelInteraction(updateUi = true, releaseExternalInteractions = false) {
    this.drawingSession += 1;
    this.drawingKind = null;
    this.redrawId = null;
    this.drawingPoints = [];
    this.hoverPoint = null;
    if (this.draftEntity && this.viewer.entities.contains(this.draftEntity)) this.viewer.entities.remove(this.draftEntity);
    this.draftEntity = null;
    for (const vertex of this.draftVertices) if (this.viewer.entities.contains(vertex)) this.viewer.entities.remove(vertex);
    this.draftVertices = [];
    this.viewer.canvas.style.cursor = "";
    if (releaseExternalInteractions) this.releaseExternalSession();
    if (updateUi) this.updateDrawingUi();
  }

  suspendInteractions() {
    this.cancelInteraction(true, true);
    return () => undefined;
  }

  private bindInputs() {
    const signal = this.abortController.signal;
    const handler = this.handler;
    if (!handler) throw new Error("标绘场景交互未初始化");
    document.querySelectorAll<HTMLButtonElement>("[data-markup-draw]").forEach((button) => button.addEventListener("click", () => {
      const kind = button.dataset.markupDraw;
      if (isMarkupKind(kind)) this.startDrawing(kind);
    }, { signal }));
    element("#markupUndoVertex").addEventListener("click", () => this.undoVertex(), { signal });
    element("#markupFinishDrawing").addEventListener("click", () => void this.finishDrawing(), { signal });
    element("#markupCancelDrawing").addEventListener("click", () => this.cancelInteraction(), { signal });
    element("#markupApplyProperties").addEventListener("click", () => void this.applySelectedProperties(), { signal });
    element("#markupRedrawSelected").addEventListener("click", () => this.redrawSelected(), { signal });
    element("#markupUndo").addEventListener("click", () => this.undo(), { signal });
    element("#markupRedo").addEventListener("click", () => this.redo(), { signal });
    element("#markupExport").addEventListener("click", () => this.exportGeoJson(), { signal });
    element("#markupImportFile").addEventListener("change", (event) => void this.importGeoJson((event.currentTarget as HTMLInputElement).files?.[0]), { signal });
    element("#markupClearAll").addEventListener("click", () => this.clearAll(), { signal });
    element<HTMLInputElement>("#markupOpacity").addEventListener("input", () => this.updateOpacityOutput(), { signal });
    element<HTMLInputElement>("#markupEffectSpeed").addEventListener("input", () => this.updateEffectSpeedOutput(), { signal });
    element<HTMLInputElement>("#markupTextureFile").addEventListener("change", (event) => this.queueFacadeTexture((event.currentTarget as HTMLInputElement).files?.[0]), { signal });
    element("#markupClearTexture").addEventListener("click", () => this.clearFacadeTexture(), { signal });
    document.querySelector("#openMarkupWorkspace")?.addEventListener("click", () => document.querySelector<HTMLButtonElement>('.tab[data-tab="markup"]')?.click(), { signal });
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => tab.addEventListener("click", (event) => {
      if (tab.dataset.tab === "markup") {
        if (!this.activateExternalSession()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      this.cancelInteraction(true, true);
    }, { signal }));
    window.addEventListener("keydown", (event) => this.handleKeyDown(event), { signal });

    handler.setInputAction((movement: { position: Cartesian2 }) => this.handleLeftClick(movement.position), ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((movement: { endPosition: Cartesian2 }) => this.handleMouseMove(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(() => void this.finishDrawing(), ScreenSpaceEventType.RIGHT_CLICK);
  }

  private isActive() {
    return document.querySelector<HTMLButtonElement>('.tab[data-tab="markup"]')?.classList.contains("active") === true;
  }

  private startDrawing(kind: MarkupKind, redrawId: string | null = null) {
    if (!this.isActive()) {
      document.querySelector<HTMLButtonElement>('.tab[data-tab="markup"]')?.click();
      if (!this.isActive()) return;
    }
    this.cancelInteraction(false);
    if (!redrawId) {
      this.selectedId = null;
      element<HTMLInputElement>("#markupName").value = "";
      element<HTMLTextAreaElement>("#markupNote").value = "";
      const selectedId = this.viewer.selectedEntity?.id;
      if (selectedId && this.records.some((record) => record.id === selectedId)) this.viewer.selectedEntity = undefined;
    }
    if (!this.activateExternalSession()) return;
    this.drawingKind = kind;
    this.redrawId = redrawId;
    if (kind === "facade" || kind === "volume") element<HTMLSelectElement>("#markupHeightMode").value = "picked";
    this.viewer.canvas.style.cursor = "crosshair";
    if (kind !== "point" && kind !== "text" && kind !== "label") {
      const style = this.readStyleForm();
      const color = Color.fromCssColorString(style.color).withAlpha(Math.max(0.7, style.opacity));
      this.draftEntity = this.viewer.entities.add({
        id: `markup-draft-${crypto.randomUUID()}`,
        polyline: {
          positions: new CallbackProperty(() => this.previewCartesians(), false),
          width: Math.max(2, style.lineWidth),
          material: color,
          depthFailMaterial: color.withAlpha(0.45),
        },
      });
    }
    this.render();
  }

  private activateExternalSession() {
    if (this.resumeExternalInteractions) return true;
    try {
      this.resumeExternalInteractions = this.options.prepareForDrawing?.() ?? (() => undefined);
      return true;
    }
    catch (error) {
      this.resumeExternalInteractions = null;
      console.warn("[Markup] Unable to stop another scene interaction", error);
      this.toast("其他场景工具暂时无法安全暂停，已取消进入标绘，原有功能不受影响", true);
      return false;
    }
  }

  private releaseExternalSession() {
    const resume = this.resumeExternalInteractions;
    this.resumeExternalInteractions = null;
    try { resume?.(); }
    catch (error) { console.warn("[Markup] Unable to restore a suspended scene interaction", error); }
  }

  private previewCartesians() {
    if (!this.drawingKind) return [];
    const points = [...this.drawingPoints];
    if (this.hoverPoint) points.push(this.hoverPoint);
    if ((this.drawingKind === "rectangle" || this.drawingKind === "circle") && points.length >= 2) {
      const first = toStoredPosition(points[0]);
      const second = toStoredPosition(points.at(-1)!);
      const stored = this.drawingKind === "rectangle" ? rectanglePositions(first, second) : circlePositions(first, Cartesian3.distance(points[0], points.at(-1)!), 48);
      return [...stored, stored[0]].map(toCartesian);
    }
    if ((this.drawingKind === "polygon" || this.drawingKind === "volume") && points.length >= 2) points.push(points[0]);
    return points;
  }

  private handleLeftClick(screenPosition: Cartesian2) {
    if (!this.isActive()) return;
    if (!this.drawingKind) {
      const picked = this.viewer.scene.pick(screenPosition) as { id?: Entity | string } | undefined;
      const id = typeof picked?.id === "string" ? picked.id : picked?.id?.id;
      if (id && this.records.some((record) => record.id === id)) this.selectRecord(id);
      return;
    }
    const world = this.pickWorldPosition(screenPosition);
    if (!world) return this.toast("该位置未拾取到倾斜摄影、三维模型或地表，请重试", true);
    if (this.drawingKind === "volume" && this.drawingPoints.length >= MAX_VOLUME_POSITIONS) return this.toast(`体标绘最多允许 ${MAX_VOLUME_POSITIONS} 个底面节点`, true);
    this.drawingPoints.push(Cartesian3.clone(world));
    this.addDraftVertex(world);
    if (this.drawingKind === "point" || this.drawingKind === "text" || this.drawingKind === "label") void this.finishDrawing();
    else if ((this.drawingKind === "rectangle" || this.drawingKind === "circle" || this.drawingKind === "facade") && this.drawingPoints.length === 2) void this.finishDrawing();
    else this.updateDrawingUi();
  }

  private handleMouseMove(screenPosition: Cartesian2) {
    if (!this.isActive() || !this.drawingKind || this.drawingKind === "point" || this.drawingKind === "text" || this.drawingKind === "label") return;
    this.hoverPoint = this.pickWorldPosition(screenPosition) ?? null;
  }

  private pickWorldPosition(screenPosition: Cartesian2) {
    const scene = this.viewer.scene;
    try {
      const pickedObject = scene.pick(screenPosition);
      if (pickedObject && scene.pickPositionSupported) {
        const position = scene.pickPosition(screenPosition);
        if (position && [position.x, position.y, position.z].every(Number.isFinite)) return position;
      }
    } catch {
      // A tile may be replaced between color and depth picking; globe picking is the safe fallback.
    }
    const ray = this.viewer.camera.getPickRay(screenPosition);
    const globePosition = ray ? scene.globe.pick(ray, scene) : undefined;
    return globePosition ?? this.viewer.camera.pickEllipsoid(screenPosition, scene.globe.ellipsoid);
  }

  private addDraftVertex(position: Cartesian3) {
    this.draftVertices.push(this.viewer.entities.add({
      id: `markup-draft-vertex-${crypto.randomUUID()}`,
      position: Cartesian3.clone(position),
      point: { pixelSize: 8, color: Color.WHITE, outlineColor: Color.fromCssColorString(this.readStyleForm().color), outlineWidth: 2, disableDepthTestDistance: 2000 },
    }));
  }

  private undoVertex() {
    if (!this.drawingKind || !this.drawingPoints.length) return;
    this.drawingPoints.pop();
    const vertex = this.draftVertices.pop();
    if (vertex && this.viewer.entities.contains(vertex)) this.viewer.entities.remove(vertex);
    this.updateDrawingUi();
  }

  private async finishDrawing() {
    if (!this.drawingKind) return;
    const kind = this.drawingKind;
    if (this.drawingPoints.length < KIND_MIN_POINTS[kind]) {
      this.toast(`${KIND_LABELS[kind]}至少需要 ${KIND_MIN_POINTS[kind]} 个点`, true);
      return;
    }
    const positions = this.drawingPoints.map(toStoredPosition);
    const radius = kind === "circle" ? Cartesian3.distance(this.drawingPoints[0], this.drawingPoints[1]) : undefined;
    const redrawId = this.redrawId;
    const drawingSession = this.drawingSession;
    const preparedName = element<HTMLInputElement>("#markupName").value.trim();
    const preparedNote = element<HTMLTextAreaElement>("#markupNote").value.trim();
    const preparedHeightMode: HeightMode = kind === "facade" || kind === "volume" ? "picked" : element<HTMLSelectElement>("#markupHeightMode").value === "surface" ? "surface" : "picked";
    const preparedStyle = this.readStyleForm();
    if (kind === "facade" && !redrawId && this.textureSelectionPromise) {
      element("#markupStatus").textContent = "正在读取立面贴图，完成后自动创建";
      await this.waitForTextureSelection();
      if (this.disposed || drawingSession !== this.drawingSession || this.drawingKind !== kind || this.redrawId !== redrawId) return;
    }
    const pendingTexture = kind === "facade" && !redrawId ? this.pendingTexture : null;
    if (pendingTexture) {
      element("#markupStatus").textContent = "正在安全保存立面贴图，完成后自动创建";
      try { await this.ensureTextureSaved(pendingTexture); }
      catch (error) {
        this.toast(error instanceof Error ? `立面贴图保存失败：${error.message}` : "立面贴图保存失败，请重新选择", true);
        this.updateDrawingUi();
        return;
      }
      if (this.disposed || drawingSession !== this.drawingSession || this.drawingKind !== kind || this.redrawId !== redrawId || this.pendingTexture?.id !== pendingTexture.id) return;
    }
    const now = new Date().toISOString();
    let selectedId = redrawId;
    const changed = this.mutate(() => {
      if (redrawId) {
        const current = this.records.find((record) => record.id === redrawId);
        if (current) {
          current.positions = positions;
          current.radius = radius;
          current.updatedAt = now;
          return;
        }
      }
      const id = crypto.randomUUID();
      selectedId = id;
      this.records.push({
        id,
        kind,
        name: preparedName || `${KIND_LABELS[kind]} ${this.records.filter((record) => record.kind === kind).length + 1}`,
        note: preparedNote,
        visible: true,
        heightMode: preparedHeightMode,
        positions,
        radius,
        textureId: pendingTexture?.id,
        textureName: pendingTexture?.name,
        style: preparedStyle,
        createdAt: now,
        updatedAt: now,
      });
    });
    if (!changed) return;
    if (pendingTexture) this.consumePendingTexture(pendingTexture);
    this.cancelInteraction(false);
    if (selectedId) this.selectRecord(selectedId, false);
    this.updateDrawingUi();
    this.toast(redrawId ? "标绘几何已更新" : `${KIND_LABELS[kind]}已创建`);
  }

  private async applySelectedProperties() {
    const record = this.records.find((item) => item.id === this.selectedId);
    if (!record) return this.toast("请先在标绘对象列表或三维场景中选择一个对象", true);
    const recordId = record.id;
    const preparedName = element<HTMLInputElement>("#markupName").value.trim() || record.name;
    const preparedNote = element<HTMLTextAreaElement>("#markupNote").value.trim();
    const preparedHeightMode: HeightMode = record.kind === "facade" || record.kind === "volume" ? "picked" : element<HTMLSelectElement>("#markupHeightMode").value === "surface" ? "surface" : "picked";
    const preparedStyle = this.readStyleForm();
    if (record.kind === "facade" && this.textureSelectionPromise) {
      await this.waitForTextureSelection();
      if (this.disposed || this.selectedId !== recordId) return;
    }
    const pendingTexture = record.kind === "facade" ? this.pendingTexture : null;
    if (pendingTexture) {
      try { await this.ensureTextureSaved(pendingTexture); }
      catch (error) {
        this.toast(error instanceof Error ? `立面贴图保存失败：${error.message}` : "立面贴图保存失败，请重新选择", true);
        return;
      }
      if (this.disposed || this.selectedId !== recordId || this.pendingTexture?.id !== pendingTexture.id) return;
    }
    const currentRecord = this.records.find((item) => item.id === recordId);
    if (!currentRecord) return;
    const changed = this.mutate(() => {
      currentRecord.name = preparedName;
      currentRecord.note = preparedNote;
      currentRecord.heightMode = preparedHeightMode;
      currentRecord.style = preparedStyle;
      if (pendingTexture) {
        currentRecord.textureId = pendingTexture.id;
        currentRecord.textureName = pendingTexture.name;
      }
      currentRecord.updatedAt = new Date().toISOString();
    });
    if (!changed) return;
    if (pendingTexture) this.consumePendingTexture(pendingTexture);
    this.selectRecord(currentRecord.id, false);
    this.toast("标绘属性和样式已更新");
  }

  private redrawSelected() {
    const record = this.records.find((item) => item.id === this.selectedId);
    if (!record) return this.toast("请先选择需要重新绘制的对象", true);
    this.startDrawing(record.kind, record.id);
  }

  private readStyleForm(): MarkupStyle {
    return safeStyle({
      color: element<HTMLInputElement>("#markupColor").value,
      opacity: element<HTMLInputElement>("#markupOpacity").valueAsNumber,
      lineWidth: element<HTMLInputElement>("#markupLineWidth").valueAsNumber,
      pointSize: element<HTMLInputElement>("#markupPointSize").valueAsNumber,
      fontSize: element<HTMLInputElement>("#markupFontSize").valueAsNumber,
      lineEffect: element<HTMLSelectElement>("#markupLineEffect").value,
      effectSpeed: element<HTMLInputElement>("#markupEffectSpeed").valueAsNumber,
      verticalHeight: element<HTMLInputElement>("#markupVerticalHeight").valueAsNumber,
    });
  }

  private fillForm(record: MarkupRecord) {
    element<HTMLInputElement>("#markupName").value = record.name;
    element<HTMLTextAreaElement>("#markupNote").value = record.note;
    element<HTMLInputElement>("#markupColor").value = record.style.color;
    element<HTMLInputElement>("#markupOpacity").value = String(record.style.opacity);
    element<HTMLInputElement>("#markupLineWidth").value = String(record.style.lineWidth);
    element<HTMLInputElement>("#markupPointSize").value = String(record.style.pointSize);
    element<HTMLInputElement>("#markupFontSize").value = String(record.style.fontSize);
    element<HTMLSelectElement>("#markupLineEffect").value = record.style.lineEffect;
    element<HTMLInputElement>("#markupEffectSpeed").value = String(record.style.effectSpeed);
    element<HTMLInputElement>("#markupVerticalHeight").value = String(record.style.verticalHeight);
    element<HTMLSelectElement>("#markupHeightMode").value = record.heightMode;
    this.updateOpacityOutput();
    this.updateEffectSpeedOutput();
    this.syncConditionalFields(record.kind);
    this.updateTextureStatus(record);
  }

  private createPolylineMaterial(record: MarkupRecord, color: Color) {
    const base = color.withAlpha(Math.max(0.2, record.style.opacity));
    if (record.style.lineEffect === "flowDash" || record.style.lineEffect === "pulseGlow") {
      if (this.dynamicLinesRendered >= MAX_DYNAMIC_LINES) return base;
      this.dynamicLinesRendered += 1;
    }
    if (record.style.lineEffect === "flowDash") {
      const pattern = 0xf0f0;
      const startedAt = performance.now();
      return new PolylineDashMaterialProperty({
        color: base,
        gapColor: Color.TRANSPARENT,
        dashLength: 24,
        dashPattern: new CallbackProperty(() => {
          const shift = Math.floor(((performance.now() - startedAt) / 140) * record.style.effectSpeed) % 16;
          return shift === 0 ? pattern : ((pattern << shift) | (pattern >>> (16 - shift))) & 0xffff;
        }, false),
      });
    }
    if (record.style.lineEffect === "pulseGlow") {
      const startedAt = performance.now();
      return new PolylineGlowMaterialProperty({
        color: new CallbackProperty((_time, result) => {
          const output = result instanceof Color ? result : new Color();
          Color.clone(base, output);
          const phase = (performance.now() - startedAt) * 0.003 * record.style.effectSpeed;
          output.alpha = clamp(record.style.opacity * (0.55 + Math.sin(phase) * 0.35), 0.12, 1);
          return output;
        }, false),
        glowPower: new CallbackProperty(() => {
          const phase = (performance.now() - startedAt) * 0.003 * record.style.effectSpeed;
          return 0.16 + (Math.sin(phase) + 1) * 0.12;
        }, false),
        taperPower: 1,
      });
    }
    if (record.style.lineEffect === "arrow") return new PolylineArrowMaterialProperty(base);
    return base;
  }

  private createFacadeMaterial(record: MarkupRecord, color: Color) {
    const image = record.textureId ? this.textureUrls.get(record.textureId) : undefined;
    if (!image) return new ColorMaterialProperty(color.withAlpha(record.style.opacity));
    return new ImageMaterialProperty({ image, repeat: new Cartesian2(1, 1), color: Color.WHITE.withAlpha(record.style.opacity), transparent: true });
  }

  private referencedTextureIds() {
    const ids = new Set<string>();
    const addRecords = (records: unknown) => {
      if (!Array.isArray(records)) return;
      for (const value of records) {
        if (!value || typeof value !== "object") continue;
        const textureId = (value as Partial<MarkupRecord>).textureId;
        if (typeof textureId === "string") ids.add(textureId);
      }
    };
    addRecords(this.records);
    for (const snapshot of [...this.undoStack, ...this.redoStack]) {
      try { addRecords(JSON.parse(snapshot)); }
      catch { /* Invalid history is handled by the existing restore guard. */ }
    }
    if (this.recoveryPayload) {
      try { addRecords((JSON.parse(this.recoveryPayload) as { items?: unknown }).items); }
      catch { /* The raw recovery payload remains downloadable even when malformed. */ }
    }
    if (this.pendingTexture) ids.add(this.pendingTexture.id);
    for (const id of this.textureSavePromises.keys()) ids.add(id);
    return ids;
  }

  private scheduleTextureGarbageCollection() {
    if (this.disposed) return;
    this.textureReferenceVersion += 1;
    const version = this.textureReferenceVersion;
    if (this.textureGcTimer !== null) window.clearTimeout(this.textureGcTimer);
    this.textureGcTimer = window.setTimeout(() => {
      this.textureGcTimer = null;
      if (this.disposed || version !== this.textureReferenceVersion) return;
      const keepIds = this.referencedTextureIds();
      for (const [id, url] of this.textureUrls) {
        if (keepIds.has(id)) continue;
        URL.revokeObjectURL(url);
        this.textureUrls.delete(id);
      }
      for (const id of this.missingTextureIds) if (!keepIds.has(id)) this.missingTextureIds.delete(id);
      for (const id of this.textureSaveErrors.keys()) if (!keepIds.has(id)) this.textureSaveErrors.delete(id);
      void pruneTextureBlobs(keepIds, () => !this.disposed && version === this.textureReferenceVersion).catch((error) => {
        if (!this.disposed) console.warn("[Markup] Unable to prune unused facade textures", error);
      });
    }, 600);
  }

  private beginTextureSave(texture: PendingTexture) {
    const promise = saveTextureBlob(texture);
    this.textureSavePromises.set(texture.id, promise);
    this.textureSaveErrors.delete(texture.id);
    void promise.then(() => {
      if (this.textureSavePromises.get(texture.id) === promise) this.textureSavePromises.delete(texture.id);
      this.textureSaveErrors.delete(texture.id);
      if (this.disposed) return;
      this.updateTextureStatus(this.records.find((record) => record.id === this.selectedId));
      this.scheduleTextureGarbageCollection();
    }, (error) => {
      if (this.textureSavePromises.get(texture.id) === promise) this.textureSavePromises.delete(texture.id);
      if (this.disposed) return;
      this.textureSaveErrors.set(texture.id, error instanceof Error ? error.message : "贴图保存失败");
      this.updateTextureStatus(this.records.find((record) => record.id === this.selectedId));
      this.scheduleTextureGarbageCollection();
    });
  }

  private async ensureTextureSaved(texture: PendingTexture) {
    const promise = this.textureSavePromises.get(texture.id);
    if (promise) await promise;
    const message = this.textureSaveErrors.get(texture.id);
    if (message) throw new Error(message);
  }

  private async hydrateTexture(record: MarkupRecord) {
    const textureId = record.textureId;
    if (!textureId || this.textureUrls.has(textureId) || this.textureLoads.has(textureId) || this.missingTextureIds.has(textureId)) return;
    this.textureLoads.add(textureId);
    try {
      const stored = await loadTextureBlob(textureId);
      if (!stored) {
        this.missingTextureIds.add(textureId);
        const selected = this.records.find((item) => item.id === this.selectedId);
        if (selected?.textureId === textureId) this.updateTextureStatus(selected);
        return;
      }
      const url = URL.createObjectURL(stored.blob);
      if (this.disposed || this.viewer.isDestroyed()) { URL.revokeObjectURL(url); return; }
      this.textureUrls.set(textureId, url);
      this.missingTextureIds.delete(textureId);
      for (const candidate of this.records.filter((item) => item.kind === "facade" && item.textureId === textureId)) {
        const entity = this.dataSource.entities.getById(candidate.id);
        if (entity?.wall) entity.wall.material = this.createFacadeMaterial(candidate, Color.fromCssColorString(candidate.style.color));
      }
      this.viewer.scene.requestRender();
      const selected = this.records.find((item) => item.id === this.selectedId);
      if (selected?.textureId === textureId) this.updateTextureStatus(selected);
    } catch (error) {
      this.missingTextureIds.add(textureId);
      console.warn("[Markup] Unable to restore facade texture", error);
      const selected = this.records.find((item) => item.id === this.selectedId);
      if (selected?.textureId === textureId) this.updateTextureStatus(selected);
    } finally { this.textureLoads.delete(textureId); }
  }

  private queueFacadeTexture(file?: File) {
    if (!file) return;
    const version = ++this.textureSelectionVersion;
    const promise = this.chooseFacadeTexture(file, version);
    this.textureSelectionPromise = promise;
    this.updateTextureStatus(this.records.find((record) => record.id === this.selectedId));
    void promise.then(() => {
      if (version === this.textureSelectionVersion && this.textureSelectionPromise === promise) this.textureSelectionPromise = null;
      this.updateTextureStatus(this.records.find((record) => record.id === this.selectedId));
    });
  }

  private async waitForTextureSelection() {
    while (this.textureSelectionPromise) {
      const promise = this.textureSelectionPromise;
      await promise;
      if (this.textureSelectionPromise === promise) this.textureSelectionPromise = null;
    }
  }

  private async chooseFacadeTexture(file: File, version: number) {
    const input = element<HTMLInputElement>("#markupTextureFile");
    try {
      if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error("立面贴图仅支持 PNG、JPEG 或 WebP 图片");
      if (!file.size || file.size > MAX_TEXTURE_FILE_BYTES) throw new Error("立面贴图不能超过 4MB");
      if ("createImageBitmap" in globalThis) {
        const bitmap = await createImageBitmap(file);
        try {
          if (bitmap.width > MAX_TEXTURE_DIMENSION || bitmap.height > MAX_TEXTURE_DIMENSION) throw new Error(`立面贴图最长边不能超过 ${MAX_TEXTURE_DIMENSION} 像素`);
        } finally { bitmap.close(); }
      }
      if (this.disposed || version !== this.textureSelectionVersion) return;
      if (this.pendingTexture) {
        this.textureUrls.delete(this.pendingTexture.id);
        URL.revokeObjectURL(this.pendingTexture.url);
        this.textureSaveErrors.delete(this.pendingTexture.id);
      }
      const pending = { id: crypto.randomUUID(), name: file.name.slice(0, 160), blob: file, url: URL.createObjectURL(file) } satisfies PendingTexture;
      this.pendingTexture = pending;
      this.textureUrls.set(pending.id, pending.url);
      this.missingTextureIds.delete(pending.id);
      this.beginTextureSave(pending);
      this.scheduleTextureGarbageCollection();
      this.updateTextureStatus(this.records.find((record) => record.id === this.selectedId));
      this.toast(`已选择立面贴图：${pending.name}，正在安全保存`);
    } catch (error) {
      if (!this.disposed && version === this.textureSelectionVersion) this.toast(error instanceof Error ? error.message : "立面贴图读取失败", true);
    } finally { input.value = ""; }
  }

  private consumePendingTexture(texture: PendingTexture) {
    if (this.pendingTexture?.id !== texture.id) return;
    this.pendingTexture = null;
    this.scheduleTextureGarbageCollection();
  }

  private clearFacadeTexture() {
    this.textureSelectionVersion += 1;
    this.textureSelectionPromise = null;
    if (this.pendingTexture) {
      this.textureUrls.delete(this.pendingTexture.id);
      URL.revokeObjectURL(this.pendingTexture.url);
      this.textureSaveErrors.delete(this.pendingTexture.id);
      this.pendingTexture = null;
      this.scheduleTextureGarbageCollection();
    }
    const record = this.records.find((item) => item.id === this.selectedId && item.kind === "facade");
    if (record?.textureId) {
      const changed = this.mutate(() => {
        record.textureId = undefined;
        record.textureName = undefined;
        record.updatedAt = new Date().toISOString();
      });
      if (changed) this.toast("已移除选中立面的贴图，原始图片保留用于撤销恢复");
    }
    this.updateTextureStatus(record);
  }

  private updateTextureStatus(record?: MarkupRecord) {
    const status = element("#markupTextureStatus");
    if (this.textureSelectionPromise) status.textContent = "正在读取并检查贴图…";
    else if (this.pendingTexture && this.textureSaveErrors.has(this.pendingTexture.id)) status.textContent = `贴图保存失败：${this.pendingTexture.name}，请重新选择`;
    else if (this.pendingTexture && this.textureSavePromises.has(this.pendingTexture.id)) status.textContent = `正在安全保存：${this.pendingTexture.name}`;
    else if (this.pendingTexture) status.textContent = `待应用：${this.pendingTexture.name}`;
    else if (record?.kind === "facade" && record.textureName) status.textContent = this.missingTextureIds.has(record.textureId ?? "")
      ? `贴图未找到：${record.textureName}，请重新选择`
      : this.textureUrls.has(record.textureId ?? "")
        ? `当前贴图：${record.textureName}`
        : this.isDisplayed(record)
          ? `当前贴图：${record.textureName}（正在从本机恢复）`
          : `当前贴图：${record.textureName}（显示立面时加载）`;
    else status.textContent = "未选择贴图，将使用当前颜色";
    element<HTMLButtonElement>("#markupClearTexture").disabled = !this.textureSelectionPromise && !this.pendingTexture && !(record?.kind === "facade" && record.textureId);
  }

  private syncConditionalFields(kind: MarkupKind | null) {
    const line = kind === "polyline";
    const solid = kind === "facade" || kind === "volume";
    element("#markupLineEffectField").classList.toggle("hidden", !line);
    element("#markupEffectSpeedField").classList.toggle("hidden", !line);
    element("#markupVerticalHeightField").classList.toggle("hidden", !solid);
    element("#markupTextureFields").classList.toggle("hidden", kind !== "facade");
    const heightMode = element<HTMLSelectElement>("#markupHeightMode");
    heightMode.disabled = solid;
    if (solid) heightMode.value = "picked";
  }

  private selectRecord(id: string, updateViewer = true) {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    this.selectedId = id;
    this.fillForm(record);
    if (updateViewer) this.viewer.selectedEntity = this.dataSource.entities.getById(id);
    this.render();
  }

  private rebuildEntities() {
    this.dataSource.entities.removeAll();
    this.dynamicLinesRendered = 0;
    for (const record of this.records) this.addEntity(record);
    if (this.selectedId) {
      const selected = this.dataSource.entities.getById(this.selectedId);
      if (selected) this.viewer.selectedEntity = selected;
    }
    this.viewer.scene.requestRender();
  }

  private addEntity(record: MarkupRecord) {
    const visible = this.isDisplayed(record);
    const stored = displayPositions(record);
    const positions = stored.map(toCartesian);
    const center = toCartesian(centerPosition(stored));
    const color = Color.fromCssColorString(record.style.color);
    const fill = color.withAlpha(record.style.opacity);
    const surface = record.heightMode === "surface";
    const label = {
      // Text annotations are their own content, rather than an attached nameplate.
      show: visible && (record.kind === "text" || this.displayLabelsVisible),
      text: record.name,
      font: `600 ${Math.round(record.style.fontSize)}px Microsoft YaHei, sans-serif`,
      fillColor: Color.WHITE,
      outlineColor: color.darken(0.45, new Color()),
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: Color.BLACK.withAlpha(0.62),
      backgroundPadding: new Cartesian2(8, 5),
      pixelOffset: new Cartesian2(0, -14),
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.BOTTOM,
      disableDepthTestDistance: 2500,
    };
    const description = `<div style="font-family:Microsoft YaHei,sans-serif"><h3>${escapeHtml(record.name)}</h3><p>${escapeHtml(record.note || "暂无备注")}</p><p>类型：${KIND_LABELS[record.kind]}</p></div>`;
    if (record.kind === "point") {
      this.dataSource.entities.add({ id: record.id, name: record.name, show: visible, position: positions[0], description, point: { pixelSize: record.style.pointSize, color: color.withAlpha(record.style.opacity), outlineColor: Color.WHITE, outlineWidth: 2, heightReference: surface ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE, disableDepthTestDistance: 2500 }, label });
      return;
    }
    if (record.kind === "text") {
      this.dataSource.entities.add({ id: record.id, name: record.name, show: visible, position: positions[0], description, label: { ...label, fillColor: color.withAlpha(Math.max(0.2, record.style.opacity)), pixelOffset: Cartesian2.ZERO, verticalOrigin: VerticalOrigin.CENTER, heightReference: surface ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE } });
      return;
    }
    if (record.kind === "label") {
      const text = record.note ? `${record.name}\n${record.note.slice(0, 120)}` : record.name;
      this.dataSource.entities.add({
        id: record.id,
        name: record.name,
        show: visible,
        position: positions[0],
        description,
        point: { pixelSize: Math.max(7, record.style.pointSize * 0.75), color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: surface ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE, disableDepthTestDistance: 2500 },
        label: { ...label, text, fillColor: Color.WHITE, backgroundColor: color.withAlpha(Math.max(0.55, record.style.opacity)), pixelOffset: new Cartesian2(0, -30), heightReference: surface ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE },
      });
      return;
    }
    if (record.kind === "polyline") {
      this.dataSource.entities.add({ id: record.id, name: record.name, show: visible, position: center, description, polyline: { positions, width: record.style.lineWidth, material: this.createPolylineMaterial(record, color), depthFailMaterial: color.withAlpha(0.4), clampToGround: surface }, label });
      return;
    }
    if (record.kind === "facade") {
      if (visible && record.textureId && !this.textureUrls.has(record.textureId)) void this.hydrateTexture(record);
      const height = record.style.verticalHeight;
      const minimumHeights = stored.map((position) => position.height);
      const maximumHeights = stored.map((position) => position.height + height);
      const top = stored.map((position) => ({ ...position, height: position.height + height }));
      const outline = [stored[0], stored[1], top[1], top[0], stored[0]].map(toCartesian);
      const labelPosition = centerPosition(top);
      this.dataSource.entities.add({
        id: record.id,
        name: record.name,
        show: visible,
        position: toCartesian(labelPosition),
        description,
        wall: { positions, minimumHeights, maximumHeights, material: this.createFacadeMaterial(record, color), outline: false },
        polyline: { positions: outline, width: Math.max(1, record.style.lineWidth), material: color.withAlpha(Math.max(0.65, record.style.opacity)) },
        label,
      });
      return;
    }
    if (record.kind === "volume") {
      const baseHeight = stored.reduce((sum, position) => sum + position.height, 0) / stored.length;
      const topHeight = baseHeight + record.style.verticalHeight;
      const footprint = stored.map((position) => toCartesian({ ...position, height: baseHeight }));
      const topOutline = [...stored, stored[0]].map((position) => toCartesian({ ...position, height: topHeight }));
      const labelPosition = centerPosition(stored);
      labelPosition.height = topHeight;
      this.dataSource.entities.add({
        id: record.id,
        name: record.name,
        show: visible,
        position: toCartesian(labelPosition),
        description,
        polygon: { hierarchy: new PolygonHierarchy(footprint), height: baseHeight, extrudedHeight: topHeight, heightReference: HeightReference.NONE, extrudedHeightReference: HeightReference.NONE, perPositionHeight: false, material: fill, outline: true, outlineColor: color, closeTop: true, closeBottom: true },
        polyline: { positions: topOutline, width: Math.max(1, record.style.lineWidth), material: color.withAlpha(Math.max(0.65, record.style.opacity)) },
        label,
      });
      return;
    }
    const closed = [...positions, positions[0]];
    this.dataSource.entities.add({
      id: record.id,
      name: record.name,
      show: visible,
      position: center,
      description,
      polygon: { hierarchy: new PolygonHierarchy(positions), material: fill, outline: !surface, outlineColor: color, perPositionHeight: !surface, heightReference: surface ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE, classificationType: ClassificationType.BOTH },
      polyline: { positions: closed, width: record.style.lineWidth, material: color.withAlpha(Math.max(0.55, record.style.opacity)), clampToGround: surface },
      label,
    });
  }

  private render() {
    const root = element("#markupList");
    element("#markupListCount").textContent = `${this.records.length} 个`;
    element("#markupPointCount").textContent = String(this.records.filter((record) => record.kind === "point" || record.kind === "text" || record.kind === "label").length);
    element("#markupLineCount").textContent = String(this.records.filter((record) => record.kind === "polyline" || record.kind === "facade").length);
    element("#markupAreaCount").textContent = String(this.records.filter((record) => ["polygon", "rectangle", "circle", "volume"].includes(record.kind)).length);
    const sceneCount = document.querySelector<HTMLElement>("#sceneMarkupCount");
    const sceneOverview = document.querySelector<HTMLElement>("#sceneMarkupOverview");
    if (sceneCount) sceneCount.textContent = String(this.records.length);
    if (sceneOverview) {
      const visible = this.records.filter((record) => this.isDisplayed(record)).length;
      sceneOverview.textContent = this.records.length ? `${visible} 个显示 · ${this.records.length - visible} 个隐藏` : "尚未创建";
    }
    if (!this.records.length) {
      root.className = "markup-empty";
      root.textContent = "尚未创建标绘";
    } else {
      root.className = "markup-list";
      root.innerHTML = this.records.map((record) => `
        <div class="markup-row${record.id === this.selectedId ? " active" : ""}${this.isDisplayed(record) ? "" : " hidden-object"}" data-markup-id="${record.id}">
          <span class="markup-kind">${KIND_ICONS[record.kind]}</span>
          <button class="markup-info" data-action="select"><strong>${escapeHtml(record.name)}</strong><small>${KIND_LABELS[record.kind]}</small></button>
          <button data-action="visibility" title="${this.isDisplayed(record) ? "隐藏" : "显示"}">${this.isDisplayed(record) ? "◉" : "○"}</button>
          <button data-action="fly" title="定位" ${this.isDisplayed(record) ? "" : "disabled"}>◎</button>
          <button data-action="remove" title="删除">×</button>
        </div>`).join("");
      root.querySelectorAll<HTMLElement>(".markup-row").forEach((row) => {
        const id = row.dataset.markupId!;
        row.querySelector('[data-action="select"]')?.addEventListener("click", () => this.selectRecord(id));
        row.querySelector('[data-action="visibility"]')?.addEventListener("click", () => this.toggleVisibility(id));
        row.querySelector('[data-action="fly"]')?.addEventListener("click", () => this.flyTo(id));
        row.querySelector('[data-action="remove"]')?.addEventListener("click", () => this.removeRecord(id));
      });
    }
    element<HTMLButtonElement>("#markupUndo").disabled = !this.undoStack.length;
    element<HTMLButtonElement>("#markupRedo").disabled = !this.redoStack.length;
    element<HTMLButtonElement>("#markupRedrawSelected").disabled = !this.selectedId;
    element<HTMLButtonElement>("#markupApplyProperties").disabled = !this.selectedId;
    if (!this.drawingKind) element("#markupStatus").textContent = this.selectedId ? `已选择：${this.records.find((record) => record.id === this.selectedId)?.name ?? "标绘"}` : `共 ${this.records.length} 个标绘，数据已保存到本机。`;
    this.updateDrawingUi();
    this.notifyOverviewListeners();
  }

  private updateDrawingUi() {
    const state = document.querySelector<HTMLElement>("#markupDrawState");
    const hint = document.querySelector<HTMLElement>("#markupDrawHint");
    if (!state || !hint) return;
    document.querySelectorAll<HTMLButtonElement>("[data-markup-draw]").forEach((button) => button.classList.toggle("active", button.dataset.markupDraw === this.drawingKind));
    const drawing = this.drawingKind !== null;
    element<HTMLButtonElement>("#markupUndoVertex").disabled = !drawing || !this.drawingPoints.length;
    element<HTMLButtonElement>("#markupFinishDrawing").disabled = !drawing || this.drawingPoints.length < (this.drawingKind ? KIND_MIN_POINTS[this.drawingKind] : 1);
    element<HTMLButtonElement>("#markupCancelDrawing").disabled = !drawing;
    const selectedRecord = this.records.find((record) => record.id === this.selectedId);
    this.syncConditionalFields(this.drawingKind ?? selectedRecord?.kind ?? null);
    this.updateTextureStatus(selectedRecord);
    if (!this.drawingKind) {
      state.textContent = "选择一种标绘类型开始";
      hint.textContent = "点选已有标绘可编辑属性";
      return;
    }
    state.textContent = `${this.redrawId ? "重新绘制" : "正在绘制"}${KIND_LABELS[this.drawingKind]} · 已选 ${this.drawingPoints.length} 点`;
    hint.textContent = this.drawingKind === "point" || this.drawingKind === "text" || this.drawingKind === "label"
      ? "在场景中单击放置"
      : this.drawingKind === "rectangle" || this.drawingKind === "circle"
        ? "依次点选两个控制点"
        : this.drawingKind === "facade"
          ? "依次点选立面底边两端；高度和贴图在属性区设置"
          : this.drawingKind === "volume"
            ? "左键绘制体的底面，右键或 Enter 完成"
            : "左键添加节点，右键或 Enter 完成，Esc 取消";
    element("#markupStatus").textContent = hint.textContent;
  }

  private updateOpacityOutput() {
    const value = element<HTMLInputElement>("#markupOpacity").valueAsNumber;
    element<HTMLOutputElement>("#markupOpacityValue").value = `${Math.round(value * 100)}%`;
  }

  private updateEffectSpeedOutput() {
    const value = element<HTMLInputElement>("#markupEffectSpeed").valueAsNumber;
    element<HTMLOutputElement>("#markupEffectSpeedValue").value = `${value.toFixed(1)}×`;
  }

  private toggleVisibility(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    this.mutate(() => { record.visible = !record.visible; record.updatedAt = new Date().toISOString(); });
  }

  private flyTo(id: string) {
    const record = this.records.find((item) => item.id === id);
    const entity = this.dataSource.entities.getById(id);
    if (!record || !entity || !this.isDisplayed(record) || this.disposed || this.viewer.isDestroyed()) return;
    this.selectRecord(id, false);
    void Promise.resolve(this.viewer.flyTo(entity, { duration: 1.2 })).catch((error) => {
      if (!this.disposed) console.warn("[Markup] Unable to fly to markup", error);
    });
  }

  private removeRecord(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (!record || !window.confirm(`确定删除标绘“${record.name}”吗？`)) return;
    const wasSelected = this.selectedId === id;
    if (!this.mutate(() => { this.records = this.records.filter((item) => item.id !== id); })) return;
    if (wasSelected) {
      this.selectedId = null;
      if (this.viewer.selectedEntity?.id === id) this.viewer.selectedEntity = undefined;
    }
    this.render();
  }

  private clearAll() {
    if (!this.records.length || !window.confirm("确定清空全部标绘吗？工程图层不会受到影响。")) return;
    const selectedEntityWasMarkup = Boolean(this.viewer.selectedEntity && this.records.some((record) => record.id === this.viewer.selectedEntity?.id));
    if (!this.mutate(() => { this.records = []; })) return;
    this.selectedId = null;
    if (selectedEntityWasMarkup) this.viewer.selectedEntity = undefined;
    this.render();
    this.toast("全部标绘已清空，工程图层未改变");
  }

  private mutate(change: () => void) {
    if (this.disposed || this.viewer.isDestroyed()) return false;
    this.downloadRecoveryBackup();
    const before = JSON.stringify(this.records);
    try {
      change();
      const { snapshot: after, payload } = this.serializeRecords(this.records);
      if (before === after) return true;
      this.rebuildEntities();
      this.persistPayload(payload);
      this.undoStack.push(before);
      this.redoStack = [];
      this.trimHistory();
      this.render();
      return true;
    } catch (error) {
      this.records = JSON.parse(before) as MarkupRecord[];
      try { this.rebuildEntities(); }
      catch (restoreError) { console.error("[Markup] Unable to restore the previous scene state", restoreError); }
      this.render();
      this.toast(error instanceof Error ? error.message : "标绘更新失败，已恢复原数据", true);
      return false;
    }
  }

  private undo() {
    if (this.drawingKind) return this.undoVertex();
    const snapshot = this.undoStack.at(-1);
    if (!snapshot) return;
    const current = JSON.stringify(this.records);
    if (!this.restoreSnapshot(snapshot)) return;
    this.undoStack.pop();
    this.redoStack.push(current);
    this.trimHistory();
    this.render();
  }

  private redo() {
    if (this.drawingKind) return;
    const snapshot = this.redoStack.at(-1);
    if (!snapshot) return;
    const current = JSON.stringify(this.records);
    if (!this.restoreSnapshot(snapshot)) return;
    this.redoStack.pop();
    this.undoStack.push(current);
    this.trimHistory();
    this.render();
  }

  private restoreSnapshot(snapshot: string) {
    const previous = JSON.stringify(this.records);
    const selectedEntityId = this.viewer.selectedEntity?.id;
    const selectedEntityWasMarkup = Boolean(selectedEntityId && this.records.some((record) => record.id === selectedEntityId));
    try {
      const parsed = JSON.parse(snapshot) as unknown;
      if (!Array.isArray(parsed)) throw new Error("撤销记录已损坏");
      const restored = parsed.map(safeRecord);
      if (restored.some((record) => record === null)) throw new Error("撤销记录包含无效对象");
      const records = restored as MarkupRecord[];
      const ids = new Set(records.map((record) => record.id));
      if (ids.size !== records.length) throw new Error("撤销记录包含重复对象");
      const { payload } = this.serializeRecords(records);
      this.records = records;
      if (this.selectedId && !this.records.some((record) => record.id === this.selectedId)) this.selectedId = null;
      if (selectedEntityWasMarkup && selectedEntityId && !this.records.some((record) => record.id === selectedEntityId)) this.viewer.selectedEntity = undefined;
      this.rebuildEntities();
      this.persistPayload(payload);
      return true;
    } catch (error) {
      this.records = JSON.parse(previous) as MarkupRecord[];
      try { this.rebuildEntities(); }
      catch (restoreError) { console.error("[Markup] Unable to recover after a history error", restoreError); }
      this.toast(error instanceof Error ? error.message : "撤销或重做失败，已保留当前数据", true);
      return false;
    }
  }

  private serializeRecords(records: MarkupRecord[]) {
    if (records.length > MAX_RECORDS) throw new Error(`标绘对象不能超过 ${MAX_RECORDS} 个`);
    const ids = new Set<string>();
    let totalPositions = 0;
    for (const record of records) {
      if (ids.has(record.id)) throw new Error("标绘对象编号重复");
      ids.add(record.id);
      validateRecordGeometry(record);
      totalPositions += record.positions.length;
    }
    if (totalPositions > MAX_TOTAL_POSITIONS) throw new Error(`标绘节点总数不能超过 ${MAX_TOTAL_POSITIONS} 个`);
    const snapshot = JSON.stringify(records);
    const payload = `{"version":1,"items":${snapshot}}`;
    if (utf8ByteSize(payload) > MAX_STORED_BYTES) throw new Error("标绘数据超过本机安全保存容量，请分批导入或先导出后清理");
    return { snapshot, payload };
  }

  private persistPayload(payload: string) {
    try { localStorage.setItem(STORAGE_KEY, payload); }
    catch (error) {
      console.warn("[Markup] Unable to persist markups", error);
      throw new Error("浏览器本地存储空间不足，标绘未保存并已恢复原数据");
    }
  }

  private downloadRecoveryBackup() {
    if (!this.recoveryPayload || this.recoveryBackupDownloaded) return;
    const blob = new Blob([this.recoveryPayload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `标绘原始数据备份_${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    this.recoveryBackupDownloaded = true;
  }

  private preserveRecoveryPayload(raw: string, adjusted: number) {
    this.recoveryPayload = raw;
    this.recoveryOmittedCount = Math.max(1, adjusted);
    try {
      if (!localStorage.getItem(RECOVERY_STORAGE_KEY)) localStorage.setItem(RECOVERY_STORAGE_KEY, raw);
    } catch {
      try { sessionStorage.setItem(RECOVERY_STORAGE_KEY, raw); } catch { /* The in-memory copy is still downloaded before the first edit. */ }
    }
  }

  private trimHistory() {
    while (this.undoStack.length > MAX_HISTORY_STEPS) this.undoStack.shift();
    while (this.redoStack.length > MAX_HISTORY_STEPS) this.redoStack.shift();
    const totalBytes = () => [...this.undoStack, ...this.redoStack].reduce((sum, snapshot) => sum + historyMemorySize(snapshot), 0);
    while (totalBytes() > MAX_HISTORY_MEMORY_BYTES) {
      if (this.undoStack.length > 1) this.undoStack.shift();
      else if (this.redoStack.length) this.redoStack.shift();
      else if (this.undoStack.length) this.undoStack.shift();
      else break;
    }
    this.scheduleTextureGarbageCollection();
  }

  private loadRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(raw || "null") as { version?: unknown; items?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.items)) return [];
      if (parsed.version !== 1) {
        if (raw) this.preserveRecoveryPayload(raw, parsed.items.length);
        return [];
      }
      const records: MarkupRecord[] = [];
      const ids = new Set<string>();
      let totalPositions = 0;
      let adjusted = Math.max(0, parsed.items.length - MAX_RECORDS);
      const candidates = parsed.items.slice(0, MAX_RECORDS);
      for (let index = 0; index < candidates.length; index += 1) {
        const value = candidates[index];
        const record = safeRecord(value);
        if (!record) { adjusted += 1; continue; }
        try { validateRecordGeometry(record); }
        catch { adjusted += 1; continue; }
        if (ids.has(record.id)) { record.id = crypto.randomUUID(); adjusted += 1; }
        if (totalPositions + record.positions.length > MAX_TOTAL_POSITIONS) {
          adjusted += candidates.length - index;
          break;
        }
        ids.add(record.id);
        totalPositions += record.positions.length;
        records.push(record);
      }
      while (records.length) {
        try { this.serializeRecords(records); break; }
        catch { records.pop(); adjusted += 1; }
      }
      if (adjusted > 0 && raw) this.preserveRecoveryPayload(raw, adjusted);
      return records;
    } catch (error) {
      console.warn("[Markup] Ignored invalid local markup data", error);
      return [];
    }
  }

  private exportGeoJson() {
    if (!this.records.length) return this.toast("当前没有可导出的标绘", true);
    const features = this.records.map((record) => {
      const positions = displayPositions(record);
      let geometry: Record<string, unknown>;
      if (record.kind === "point" || record.kind === "text" || record.kind === "label") geometry = { type: "Point", coordinates: [positions[0].longitude, positions[0].latitude, positions[0].height] };
      else if (record.kind === "polyline" || record.kind === "facade") geometry = { type: "LineString", coordinates: positions.map((position) => [position.longitude, position.latitude, position.height]) };
      else {
        const ring = [...positions, positions[0]];
        geometry = { type: "Polygon", coordinates: [ring.map((position) => [position.longitude, position.latitude, position.height])] };
      }
      return { type: "Feature", id: record.id, properties: { name: record.name, note: record.note, markupKind: record.kind, visible: record.visible, heightMode: record.heightMode, style: record.style, radius: record.radius, textureId: record.textureId, textureName: record.textureName, sourcePositions: record.positions }, geometry };
    });
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", name: "Cesium 场景标绘", features }, null, 2)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `场景标绘_${new Date().toISOString().slice(0, 10)}.geojson`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.toast(`已导出 ${this.records.length} 个标绘${this.records.some((record) => record.kind === "facade" && record.textureId) ? "；立面贴图仍保存在本机，GeoJSON 仅记录贴图名称" : ""}`);
  }

  private async importGeoJson(file?: File) {
    const input = element<HTMLInputElement>("#markupImportFile");
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error("标绘文件不能超过 5MB");
      const parsed = JSON.parse((await file.text()).replace(/^\uFEFF/, "")) as { type?: unknown; features?: unknown };
      if (this.disposed || this.viewer.isDestroyed()) return;
      if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) throw new Error("请选择有效的 GeoJSON FeatureCollection 文件");
      if (parsed.features.length > MAX_RECORDS) throw new Error(`单次导入不能超过 ${MAX_RECORDS} 个标绘对象`);
      const imported: MarkupRecord[] = [];
      let ignored = 0;
      for (const featureValue of parsed.features) {
        if (!featureValue || typeof featureValue !== "object") { ignored += 1; continue; }
        const feature = featureValue as { geometry?: unknown; properties?: unknown };
        if (!feature.geometry || typeof feature.geometry !== "object") { ignored += 1; continue; }
        const geometry = feature.geometry as { type?: unknown; coordinates?: unknown };
        const properties = feature.properties && typeof feature.properties === "object" ? feature.properties as Record<string, unknown> : {};
        let kind: MarkupKind | null = null;
        if (geometry.type === "Point") kind = properties.markupKind === "text" ? "text" : properties.markupKind === "label" ? "label" : "point";
        else if (geometry.type === "LineString") kind = properties.markupKind === "facade" ? "facade" : "polyline";
        else if (geometry.type === "Polygon") kind = isMarkupKind(properties.markupKind) && ["polygon", "rectangle", "circle", "volume"].includes(properties.markupKind) ? properties.markupKind : "polygon";
        if (!kind) { ignored += 1; continue; }

        let positions: StoredPosition[] = [];
        if (Array.isArray(properties.sourcePositions) && properties.sourcePositions.length <= MAX_POSITIONS_PER_RECORD) {
          const sourcePositions = properties.sourcePositions.map(safePosition);
          if (sourcePositions.length >= KIND_MIN_POINTS[kind] && sourcePositions.every((position) => position !== null)) {
            positions = sourcePositions as StoredPosition[];
          }
        }

        if (geometry.type === "Point") {
          if (!positions.length && Array.isArray(geometry.coordinates)) {
            const point = safePosition({ longitude: geometry.coordinates[0], latitude: geometry.coordinates[1], height: geometry.coordinates[2] ?? 0 });
            if (point) positions = [point];
          }
        } else if (geometry.type === "LineString") {
          if (!positions.length && Array.isArray(geometry.coordinates)) {
            if (geometry.coordinates.length > MAX_POSITIONS_PER_RECORD) throw new Error(`单个标绘不能超过 ${MAX_POSITIONS_PER_RECORD} 个节点`);
            const parsedPositions = geometry.coordinates.map((coordinate) => Array.isArray(coordinate) ? safePosition({ longitude: coordinate[0], latitude: coordinate[1], height: coordinate[2] ?? 0 }) : null);
            if (parsedPositions.some((position) => position === null)) { ignored += 1; continue; }
            positions = parsedPositions as StoredPosition[];
          }
        } else if (geometry.type === "Polygon") {
          if (!positions.length && Array.isArray(geometry.coordinates) && Array.isArray(geometry.coordinates[0])) {
            const ring = geometry.coordinates[0] as unknown[];
            if (ring.length > MAX_POSITIONS_PER_RECORD + 1) throw new Error(`单个标绘不能超过 ${MAX_POSITIONS_PER_RECORD} 个节点`);
            const parsedPositions = ring.map((coordinate) => Array.isArray(coordinate) ? safePosition({ longitude: coordinate[0], latitude: coordinate[1], height: coordinate[2] ?? 0 }) : null);
            if (parsedPositions.some((position) => position === null)) { ignored += 1; continue; }
            positions = parsedPositions as StoredPosition[];
            if (positions.length > 1 && JSON.stringify(positions[0]) === JSON.stringify(positions.at(-1))) positions.pop();
            if (kind === "rectangle" || kind === "circle") kind = "polygon";
          }
        }
        const now = new Date().toISOString();
        const candidate = safeRecord({
          id: crypto.randomUUID(), kind, positions, radius: properties.radius, textureId: properties.textureId, textureName: properties.textureName, name: typeof properties.name === "string" ? properties.name : `${KIND_LABELS[kind]} ${imported.length + 1}`,
          note: typeof properties.note === "string" ? properties.note : "", visible: properties.visible !== false, heightMode: properties.heightMode === "surface" ? "surface" : "picked", style: properties.style, createdAt: now, updatedAt: now,
        });
        if (candidate) {
          try { validateRecordGeometry(candidate); imported.push(candidate); }
          catch { ignored += 1; }
        } else ignored += 1;
      }
      if (!imported.length) throw new Error("文件中没有可导入的标绘对象");
      if (!this.mutate(() => this.records.push(...imported))) return;
      this.toast(`已导入 ${imported.length} 个标绘${ignored ? `，忽略 ${ignored} 个无效要素` : ""}`);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : "标绘导入失败", true);
    } finally { input.value = ""; }
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (!this.isActive()) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.matches("input,textarea,select") || target.isContentEditable)) return;
    if (event.altKey && ["1", "2", "3"].includes(event.key)) {
      event.preventDefault();
      this.startDrawing(event.key === "1" ? "point" : event.key === "2" ? "polyline" : "polygon");
      return;
    }
    if (event.key === "Escape" && this.drawingKind) { event.preventDefault(); this.cancelInteraction(); return; }
    if (event.key === "Enter" && this.drawingKind) { event.preventDefault(); void this.finishDrawing(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); this.undo(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); this.redo(); }
  }
}

