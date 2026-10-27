import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  ClippingPlane,
  ClippingPlaneCollection,
  ClippingPolygon,
  ClippingPolygonCollection,
  Color,
  CustomDataSource,
  Math as CesiumMath,
  Matrix4,
  Model,
  PolygonHierarchy,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  type Entity,
  type Viewer,
} from "cesium";
import type { ImportRecord } from "./types";
import type { CadPolylineFeature } from "./cadPrimitiveLoader";
import { recoverDestroyedClippingReferences } from "./destroyedClippingRecovery";

export const subsurfacePanelHtml = `
  <div id="subsurfacePanel" class="subsurface-panel hidden">
    <div class="subsurface-title"><div><strong>地下工程</strong><small>地下空间 · 管线预警 · 隐蔽档案</small></div><button id="closeSubsurfacePanel" title="关闭">×</button></div>
    <div class="subsurface-tabs">
      <button class="active" data-subtab="view">地下查看</button>
      <button data-subtab="collision">碰撞预警</button>
      <button data-subtab="archive">隐蔽档案</button>
    </div>

    <section class="subsurface-section active" data-subpanel="view">
      <div class="switch-row"><span><strong>地面透明</strong><small>透视地表下方的管线和构筑物</small></span><input id="groundTransparent" type="checkbox" /></div>
      <label>地面不透明度 <output id="groundAlphaValue">35%</output><input id="groundAlpha" type="range" min="0.05" max="1" step="0.05" value="0.35" /></label>
      <div class="switch-row"><span><strong>地下模式</strong><small>允许相机穿过地面进入地下</small></span><input id="undergroundMode" type="checkbox" /></div>
      <div class="inline-fields"><label>下潜深度（米）<input id="undergroundDepth" type="number" min="1" step="1" value="8" /></label><button id="diveUnderground">下潜到选定位置</button></div>
      <div class="tool-divider"></div>
      <div class="switch-row"><span><strong>剖面查看</strong><small>同时剖切地球、倾斜摄影和普通模型</small></span><input id="sectionEnabled" type="checkbox" /></div>
      <label>剖面方向<select id="sectionDirection"><option value="northSouth">南北向剖面</option><option value="eastWest">东西向剖面</option><option value="horizontal">水平剖面</option></select></label>
      <label>剖面偏移（米） <output id="sectionOffsetValue">0m</output><input id="sectionOffset" type="range" min="-500" max="500" step="1" value="0" /></label>
      <label class="check-line"><input id="sectionInvert" type="checkbox" /> 反转保留方向</label>
      <button id="pickSectionPoint" class="panel-action">在地图上选择剖面位置</button>
      <div id="sectionPointStatus" class="panel-status">尚未选择剖面位置</div>
    </section>

    <section class="subsurface-section" data-subpanel="collision">
      <p class="panel-copy">在地图上逐点绘制开挖边界，右键完成。系统检查已显示的 CAD/GIS 管线与开挖范围是否相交。</p>
      <label>开挖形式<select id="excavationMode"><option value="slope">放坡开挖</option><option value="vertical">垂直开挖</option></select></label>
      <div class="inline-fields"><label>开挖深度（米）<input id="excavationDepth" type="number" min="0.1" step="0.1" value="5" /></label><label>坡比（1:m）<input id="excavationSlope" type="number" min="0" step="0.05" value="0.5" /></label></div>
      <div class="inline-fields"><label>安全距离（米）<input id="collisionClearance" type="number" min="0" step="0.1" value="1" /></label><label class="check-line model-cut-check"><input id="clipExcavationSurface" type="checkbox" /> 从模型/地表裁出开挖口</label></div>
      <label>管线识别范围<select id="pipelineScope"><option value="smart">自动识别管线图层</option><option value="all">全部 CAD/GIS 线条</option></select></label>
      <label class="check-line"><input id="warnUnknownHeight" type="checkbox" checked /> 缺少可靠高程时仍按平面相交预警</label>
      <div class="button-pair"><button id="drawExcavation" class="panel-action">绘制开挖范围</button><button id="clearExcavation">清除</button></div>
      <button id="runCollisionCheck" class="primary compact-primary">开始碰撞检查</button>
      <div id="collisionSummary" class="panel-status">尚未绘制开挖范围</div>
      <div id="excavationVolume" class="volume-result hidden"></div>
      <div id="collisionResults" class="collision-results"></div>
    </section>

    <section class="subsurface-section" data-subpanel="archive">
      <input id="hiddenWorkId" type="hidden" />
      <label>隐蔽工程名称<input id="hiddenWorkName" type="text" placeholder="例如：A区雨水管沟" /></label>
      <label>施工部位/编号<input id="hiddenWorkLocation" type="text" placeholder="例如：K1+200～K1+260" /></label>
      <div class="coordinate-fields"><label>经度<input id="hiddenWorkLon" type="number" step="any" /></label><label>纬度<input id="hiddenWorkLat" type="number" step="any" /></label><label>高程（米）<input id="hiddenWorkAlt" type="number" step="any" value="0" /></label></div>
      <button id="pickHiddenWorkPoint" class="panel-action">在地图上选择归档坐标</button>
      <label>施工说明<textarea id="hiddenWorkNotes" rows="3" placeholder="施工内容、验收情况、材料规格等"></textarea></label>
      <div class="photo-input-grid">
        <label class="photo-button"><strong>施工前照片</strong><small id="beforePhotoStatus">未选择</small><input id="beforePhotos" type="file" accept="image/*" multiple hidden /></label>
        <label class="photo-button"><strong>施工后照片</strong><small id="afterPhotoStatus">未选择</small><input id="afterPhotos" type="file" accept="image/*" multiple hidden /></label>
      </div>
      <div class="button-pair"><button id="saveHiddenWork" class="primary compact-primary">保存档案</button><button id="cancelHiddenWorkEdit" class="hidden">取消编辑</button></div>
      <div class="archive-heading"><strong>已归档记录</strong><button id="exportHiddenWorks">导出全部</button></div>
      <div id="hiddenWorkList" class="hidden-work-list"><div class="panel-status">正在读取本地档案…</div></div>
    </section>
  </div>`;

type InteractionMode = "section" | "excavation" | "archive" | null;
type PhotoRecord = { id: string; name: string; type: string; dataUrl: string; createdAt: string };
type HiddenWorkRecord = {
  id: string;
  name: string;
  location: string;
  longitude: number;
  latitude: number;
  altitude: number;
  notes: string;
  beforePhotos: PhotoRecord[];
  afterPhotos: PhotoRecord[];
  createdAt: string;
  updatedAt: string;
};
export type HiddenWorkArchiveOverviewItem = {
  id: string;
  name: string;
  location: string;
  longitude: number;
  latitude: number;
  altitude: number;
  beforePhotoCount: number;
  afterPhotoCount: number;
  createdAt: string;
  updatedAt: string;
};
export type HiddenWorkArchiveOverviewSnapshot = {
  total: number;
  beforePhotoCount: number;
  afterPhotoCount: number;
  items: readonly HiddenWorkArchiveOverviewItem[];
};
export type HiddenWorkArchiveOverviewListener = (snapshot: HiddenWorkArchiveOverviewSnapshot) => void;
type CollisionHit = { layer: string; entity: string; kind: "空间碰撞" | "平面相交"; position: Cartesian3; heightDifference: number };

const DB_NAME = "cesium-digital-twin";
const DB_STORE = "hidden-works";
const PIPELINE_KEYWORDS = /管|pipe|pipeline|给水|排水|雨水|污水|燃气|热力|电力|电缆|通信|弱电|强电|water|sewer|gas|cable/i;

function element<T extends HTMLElement = HTMLElement>(selector: string) {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`界面元素不存在：${selector}`);
  return result;
}

function numberValue(selector: string, fallback = 0) {
  const result = Number(element<HTMLInputElement>(selector).value);
  return Number.isFinite(result) ? result : fallback;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]!));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function openArchiveDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地档案数据库"));
  });
}

async function listArchiveRecords() {
  const database = await openArchiveDatabase();
  return new Promise<HiddenWorkRecord[]>((resolve, reject) => {
    const request = database.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve((request.result as HiddenWorkRecord[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    request.onerror = () => reject(request.error);
  }).finally(() => database.close());
}

async function putArchiveRecord(record: HiddenWorkRecord) {
  const database = await openArchiveDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地档案保存失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地档案保存被中止"));
  }).finally(() => database.close());
}

async function deleteArchiveRecord(id: string) {
  const database = await openArchiveDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地档案删除失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地档案删除被中止"));
  }).finally(() => database.close());
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取照片 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function pointInPolygon(point: Cartesian2, polygon: Cartesian2[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const left = polygon[i]; const right = polygon[j];
    const crosses = (left.y > point.y) !== (right.y > point.y)
      && point.x < ((right.x - left.x) * (point.y - left.y)) / ((right.y - left.y) || Number.EPSILON) + left.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentIntersection(a: Cartesian3, b: Cartesian3, c: Cartesian2, d: Cartesian2): { ratio: number; point: Cartesian2 } | null {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(denominator) < 1e-9) return null;
  const ratio = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
  const edgeRatio = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
  if (ratio < 0 || ratio > 1 || edgeRatio < 0 || edgeRatio > 1) return null;
  return { ratio, point: new Cartesian2(a.x + ratio * (b.x - a.x), a.y + ratio * (b.y - a.y)) };
}

function polygonSignedArea(points: Cartesian2[]) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]; const next = points[(index + 1) % points.length];
    twiceArea += point.x * next.y - next.x * point.y;
  }
  return twiceArea / 2;
}

function lineIntersection(pointA: Cartesian2, directionA: Cartesian2, pointB: Cartesian2, directionB: Cartesian2) {
  const denominator = directionA.x * directionB.y - directionA.y * directionB.x;
  if (Math.abs(denominator) < 1e-8) return null;
  const deltaX = pointB.x - pointA.x; const deltaY = pointB.y - pointA.y;
  const ratio = (deltaX * directionB.y - deltaY * directionB.x) / denominator;
  return new Cartesian2(pointA.x + directionA.x * ratio, pointA.y + directionA.y * ratio);
}

/** Creates a constant-distance inward offset for ordinary convex/simple excavation polygons. */
function insetPolygon(points: Cartesian2[], distance: number) {
  if (distance <= 0) return points.map((point) => Cartesian2.clone(point));
  const orientation = polygonSignedArea(points) >= 0 ? 1 : -1;
  const result: Cartesian2[] = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const previousLength = Math.hypot(current.x - previous.x, current.y - previous.y) || 1;
    const nextLength = Math.hypot(next.x - current.x, next.y - current.y) || 1;
    const previousDirection = new Cartesian2((current.x - previous.x) / previousLength, (current.y - previous.y) / previousLength);
    const nextDirection = new Cartesian2((next.x - current.x) / nextLength, (next.y - current.y) / nextLength);
    const previousNormal = orientation > 0 ? new Cartesian2(-previousDirection.y, previousDirection.x) : new Cartesian2(previousDirection.y, -previousDirection.x);
    const nextNormal = orientation > 0 ? new Cartesian2(-nextDirection.y, nextDirection.x) : new Cartesian2(nextDirection.y, -nextDirection.x);
    const previousOffset = new Cartesian2(current.x + previousNormal.x * distance, current.y + previousNormal.y * distance);
    const nextOffset = new Cartesian2(current.x + nextNormal.x * distance, current.y + nextNormal.y * distance);
    const intersection = lineIntersection(previousOffset, previousDirection, nextOffset, nextDirection);
    if (!intersection || Cartesian2.distance(intersection, current) > Math.max(distance * 8, 20)) {
      const average = Cartesian2.add(previousNormal, nextNormal, new Cartesian2());
      const length = Cartesian2.magnitude(average) || 1;
      result.push(new Cartesian2(current.x + (average.x / length) * distance, current.y + (average.y / length) * distance));
    } else result.push(intersection);
  }
  return result;
}

export class SubsurfaceTools {
  private readonly overlay = new CustomDataSource("地下工程工具");
  private readonly handler: ScreenSpaceEventHandler;
  private interactionMode: InteractionMode = null;
  private interactionSuspensionDepth = 0;
  private sectionAnchor: Cartesian3 | null = null;
  private excavationPoints: Cartesian3[] = [];
  private excavationPointSources: string[] = [];
  private excavationFinished = false;
  private records: HiddenWorkRecord[] = [];
  private archiveMutationPending = false;
  private readonly archiveOverviewListeners = new Set<HiddenWorkArchiveOverviewListener>();
  private clippingTargets = new Map<object, ClippingPlaneCollection>();
  private excavationClipTargets = new Map<object, ClippingPolygonCollection>();
  private clippingFailedTiles?: WeakSet<object>;
  private originalCollision: boolean;
  private originalDepthTest: boolean;

  constructor(
    private readonly viewer: Viewer,
    private readonly imports: () => ImportRecord[],
    private readonly notify: (message: string, error?: boolean) => void,
  ) {
    this.originalCollision = viewer.scene.screenSpaceCameraController.enableCollisionDetection;
    this.originalDepthTest = viewer.scene.globe.depthTestAgainstTerrain;
    // Keep Cesium's opaque-depth default for camera navigation. Translucent
    // depth requires an extra render/readback and belongs only to an explicit pick.
    void viewer.dataSources.add(this.overlay);
    this.disableGlobePolygonClipping();
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.bindInterface();
    this.bindMapInteraction();
    void this.reloadArchives();
  }

  /** Returns archive metadata only; photo data URLs never leave this module. */
  getArchiveOverviewSnapshot(): HiddenWorkArchiveOverviewSnapshot {
    const items = this.records.slice(0, 100).map((record): HiddenWorkArchiveOverviewItem => Object.freeze({
      id: record.id,
      name: record.name,
      location: record.location,
      longitude: record.longitude,
      latitude: record.latitude,
      altitude: record.altitude,
      beforePhotoCount: record.beforePhotos.length,
      afterPhotoCount: record.afterPhotos.length,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
    return Object.freeze({
      total: this.records.length,
      beforePhotoCount: this.records.reduce((sum, record) => sum + record.beforePhotos.length, 0),
      afterPhotoCount: this.records.reduce((sum, record) => sum + record.afterPhotos.length, 0),
      items: Object.freeze(items),
    });
  }

  subscribeArchiveOverview(listener: HiddenWorkArchiveOverviewListener) {
    this.archiveOverviewListeners.add(listener);
    return () => { this.archiveOverviewListeners.delete(listener); };
  }

  private notifyArchiveOverview() {
    if (!this.archiveOverviewListeners.size) return;
    const snapshot = this.getArchiveOverviewSnapshot();
    for (const listener of this.archiveOverviewListeners) {
      try { listener(snapshot); } catch { /* Data-center observers cannot break archive operations. */ }
    }
  }

  private disableGlobePolygonClipping() {
    const globe = this.viewer.scene.globe as typeof this.viewer.scene.globe & {
      clippingPolygons?: ClippingPolygonCollection;
      _clippingPolygons?: ClippingPolygonCollection;
    };
    const collection = globe.clippingPolygons ?? globe._clippingPolygons;
    if (!collection) return;
    if (collection.isDestroyed()) globe._clippingPolygons = undefined;
    else collection.enabled = false;
    this.excavationClipTargets.delete(globe);
  }

  refreshClipping() {
    if (element<HTMLInputElement>("#sectionEnabled").checked && this.sectionAnchor) this.applySectionClipping(); else this.clearSectionClipping();
    if (this.excavationFinished && element<HTMLInputElement>("#clipExcavationSurface").checked) this.applyExcavationClipping(); else this.clearExcavationClipping();
  }

  detachImport(item: ImportRecord) {
    const target = item.resource as object;
    // The primitive owns and destroys its clipping collections. Remove our
    // references before the primitive itself is destroyed; never reattach an
    // older collection because Cesium destroys it when ownership changes.
    this.clippingTargets.delete(target);
    this.excavationClipTargets.delete(target);
  }

  cancelActiveInteraction() {
    this.interactionMode = null;
  }

  /** Pauses map picking while preserving the user's unfinished operation. */
  suspendInteractions() {
    this.interactionSuspensionDepth += 1;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.interactionSuspensionDepth = Math.max(0, this.interactionSuspensionDepth - 1);
    };
  }

  /**
   * Render-error recovery must not call Cesium's public clipping setters with
   * an already-destroyed collection: those setters try to destroy the old
   * value again. Only stale private owner slots are cleared after Cesium has
   * already stopped. Preserve healthy clipping and the user's settings; rebuild
   * our affected owners from the existing section/excavation configuration.
   */
  recoverFromDestroyedResources() {
    let detached = 0;
    let failedClippingTiles = 0;
    const failedTiles = this.clippingFailedTiles ??= new WeakSet<object>();
    const sectionRestores = new Set<object>();
    const excavationRestores = new Set<object>();

    const repair = (
      targets: Map<object, ClippingPlaneCollection | ClippingPolygonCollection>,
      publicKey: "clippingPlanes" | "clippingPolygons",
      privateKey: "_clippingPlanes" | "_clippingPolygons",
      restores: Set<object>,
    ) => {
      for (const [target, collection] of targets) {
        const candidate = target as Record<string, unknown> & { isDestroyed?: () => boolean };
        if (candidate.isDestroyed?.()) {
          targets.delete(target);
          detached += 1;
          continue;
        }
        if (collection.isDestroyed()) {
          if (candidate[publicKey] === collection || candidate[privateKey] === collection) {
            candidate[privateKey] = undefined;
            restores.add(target);
            // A directly imported Model may already have commands whose
            // uniforms captured the deleted clipping texture.
            (target as { resetDrawCommands?: () => void }).resetDrawCommands?.();
          }
          targets.delete(target);
          detached += 1;
        }
      }
    };

    repair(this.clippingTargets, "clippingPlanes", "_clippingPlanes", sectionRestores);
    repair(this.excavationClipTargets, "clippingPolygons", "_clippingPolygons", excavationRestores);

    const imports = this.imports();
    const candidates: object[] = [this.viewer.scene.globe];
    for (const item of imports) if (item.kind === "Model" || item.kind === "3D Tiles") candidates.push(item.resource as object);
    for (const target of candidates) {
      const candidate = target as Record<string, unknown> & { isDestroyed?: () => boolean };
      if (candidate.isDestroyed?.()) continue;
      const root = (target as Cesium3DTileset).root;
      const pending = root ? [root] : [];
      const tiles: typeof pending = [];
      const visited = new Set<object>();
      let repaired = 0;
      while (pending.length) {
        const tile = pending.pop()!;
        const state = tile as typeof tile & { isDestroyed?(): boolean; contentFailed?: boolean };
        if (visited.has(tile) || state.isDestroyed?.()) continue;
        visited.add(tile);
        tiles.push(tile);
        const content = tile.content;
        const contentRepairs = content ? recoverDestroyedClippingReferences(content) : 0;
        repaired += contentRepairs;
        // Cesium3DTile.update marks a thrown content update FAILED. Clearing
        // clipping cannot make that tile available again; a later successful
        // frame can otherwise hide a missing tile. Do not reset private state
        // or revive unrelated download/parse failures without causal evidence.
        if (contentRepairs && state.contentFailed) failedTiles.add(tile);
        if (failedTiles.has(tile)) {
          if (state.contentFailed) failedClippingTiles += 1;
          else failedTiles.delete(tile);
        }
        pending.push(...(tile.children ?? []));
      }
      repaired += recoverDestroyedClippingReferences(target);
      detached += repaired;
      if (repaired || sectionRestores.has(target) || excavationRestores.has(target)) {
        // Cesium compares clipping state by plane/polygon count, not owner
        // identity. Rebinding an equal-sized replacement therefore needs an
        // explicit content refresh after its old borrowed references were cut.
        for (const tile of tiles) {
          const state = tile as typeof tile & { clippingPlanesDirty: boolean; clippingPolygonsDirty: boolean };
          state.clippingPlanesDirty = true;
          state.clippingPolygonsDirty = true;
        }
      }
    }
    // First clear borrowed tile-model references, then replace only owners that
    // belonged to this tool. A live replacement supplied elsewhere is untouched.
    if (sectionRestores.size && element<HTMLInputElement>("#sectionEnabled").checked && this.sectionAnchor) {
      const worldFrame = Transforms.eastNorthUpToFixedFrame(this.sectionAnchor);
      const globe = this.viewer.scene.globe;
      if (sectionRestores.has(globe)) this.updateSectionCollection(globe, worldFrame);
      for (const item of imports) {
        if (item.kind !== "Model" && item.kind !== "3D Tiles") continue;
        const target = item.resource as Model | Cesium3DTileset;
        if (sectionRestores.has(target)) this.updateSectionCollection(target, this.targetClipMatrix(item, worldFrame));
      }
    }
    if (excavationRestores.size && element<HTMLInputElement>("#clipExcavationSurface").checked && this.excavationFinished && this.excavationPoints.length >= 3) {
      for (const item of imports) {
        if (item.kind !== "Model" && item.kind !== "3D Tiles") continue;
        const target = item.resource as Model | Cesium3DTileset;
        if (excavationRestores.has(target)) this.updateExcavationCollection(target);
      }
    }
    if (failedClippingTiles) {
      throw new Error(`已清理失效裁剪引用，但 ${failedClippingTiles} 个倾斜摄影瓦片仍处于失败状态，已停止自动恢复；请保留原始错误详情并重新加载对应资源。`);
    }
    this.viewer.scene.requestRender();
    return detached;
  }

  private bindInterface() {
    element("#openSubsurfacePanel").addEventListener("click", () => element("#subsurfacePanel").classList.toggle("hidden"));
    element("#closeSubsurfacePanel").addEventListener("click", () => element("#subsurfacePanel").classList.add("hidden"));
    document.querySelectorAll<HTMLButtonElement>("[data-subtab]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-subtab]").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll("[data-subpanel]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      element(`[data-subpanel="${button.dataset.subtab}"]`).classList.add("active");
    }));

    element("#groundTransparent").addEventListener("change", () => this.applyGroundMode());
    element("#groundAlpha").addEventListener("input", () => this.applyGroundMode());
    element("#undergroundMode").addEventListener("change", () => this.applyGroundMode());
    element("#diveUnderground").addEventListener("click", () => this.diveUnderground());
    element("#sectionEnabled").addEventListener("change", () => this.refreshClipping());
    ["#sectionDirection", "#sectionInvert"].forEach((selector) => element(selector).addEventListener("change", () => this.refreshClipping()));
    element("#sectionOffset").addEventListener("input", () => {
      element<HTMLOutputElement>("#sectionOffsetValue").value = `${numberValue("#sectionOffset")}m`;
      this.refreshClipping();
    });
    element("#pickSectionPoint").addEventListener("click", () => this.beginInteraction("section", "单击地图选择剖面经过的位置"));

    element("#drawExcavation").addEventListener("click", () => this.startExcavationDrawing());
    element("#clearExcavation").addEventListener("click", () => this.clearExcavation());
    element("#runCollisionCheck").addEventListener("click", () => this.runCollisionCheck());
    ["#excavationMode", "#excavationDepth", "#excavationSlope"].forEach((selector) => {
      element(selector).addEventListener("input", () => { if (this.excavationFinished) this.updateExcavationGraphic(true); });
      element(selector).addEventListener("change", () => { if (this.excavationFinished) this.updateExcavationGraphic(true); });
    });
    element("#clipExcavationSurface").addEventListener("change", () => {
      if (element<HTMLInputElement>("#clipExcavationSurface").checked) this.applyExcavationClipping(); else this.clearExcavationClipping();
    });

    element("#pickHiddenWorkPoint").addEventListener("click", () => this.beginInteraction("archive", "单击地图选择隐蔽工程坐标"));
    element<HTMLInputElement>("#beforePhotos").addEventListener("change", () => this.updatePhotoInputStatus("#beforePhotos", "#beforePhotoStatus"));
    element<HTMLInputElement>("#afterPhotos").addEventListener("change", () => this.updatePhotoInputStatus("#afterPhotos", "#afterPhotoStatus"));
    element("#saveHiddenWork").addEventListener("click", () => void this.saveArchive());
    element("#cancelHiddenWorkEdit").addEventListener("click", () => this.resetArchiveForm());
    element("#exportHiddenWorks").addEventListener("click", () => this.exportArchives());
    element("#hiddenWorkList").addEventListener("click", (event) => void this.handleArchiveAction(event));
  }

  private bindMapInteraction() {
    this.handler.setInputAction((movement: { position: Cartesian2 }) => {
      if (this.interactionSuspensionDepth > 0) return;
      if (!this.interactionMode) return;
      const picked = this.pickSurfacePosition(movement.position);
      if (!picked) return this.notify("当前位置无法取得地面或模型坐标，请换一个位置", true);
      const position = picked.position;
      if (this.interactionMode === "section") {
        this.sectionAnchor = Cartesian3.clone(position);
        const cartographic = Cartographic.fromCartesian(position);
        element("#sectionPointStatus").textContent = `剖面位置：${CesiumMath.toDegrees(cartographic.longitude).toFixed(6)}, ${CesiumMath.toDegrees(cartographic.latitude).toFixed(6)}，高程 ${cartographic.height.toFixed(2)}m · ${picked.source}`;
        element<HTMLInputElement>("#sectionEnabled").checked = true;
        this.interactionMode = null;
        this.updateSectionGuide();
        this.applySectionClipping();
        this.notify("剖面位置已确定，可拖动偏移量查看内部结构");
      } else if (this.interactionMode === "archive") {
        const cartographic = Cartographic.fromCartesian(position);
        element<HTMLInputElement>("#hiddenWorkLon").value = CesiumMath.toDegrees(cartographic.longitude).toFixed(8);
        element<HTMLInputElement>("#hiddenWorkLat").value = CesiumMath.toDegrees(cartographic.latitude).toFixed(8);
        element<HTMLInputElement>("#hiddenWorkAlt").value = cartographic.height.toFixed(3);
        this.interactionMode = null;
        this.notify(`隐蔽工程坐标已从${picked.source}获取`);
      } else {
        this.excavationPoints.push(Cartesian3.clone(position));
        this.excavationPointSources.push(picked.source);
        this.updateExcavationGraphic(false);
        const modelPoints = this.excavationPointSources.filter((source) => source === "倾斜摄影/模型表面").length;
        element("#collisionSummary").textContent = `已选择 ${this.excavationPoints.length} 个边界点（模型面 ${modelPoints} 个）；继续单击，右键完成`;
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction(() => {
      if (this.interactionSuspensionDepth > 0) return;
      if (this.interactionMode !== "excavation") return;
      if (this.excavationPoints.length < 3) return this.notify("开挖范围至少需要 3 个点", true);
      this.interactionMode = null;
      this.excavationFinished = true;
      this.updateExcavationGraphic(true);
      if (element<HTMLInputElement>("#clipExcavationSurface").checked) this.applyExcavationClipping();
      this.notify("开挖范围绘制完成，可以开始碰撞检查");
    }, ScreenSpaceEventType.RIGHT_CLICK);
  }

  private beginInteraction(mode: Exclude<InteractionMode, null>, message: string) {
    this.interactionMode = mode;
    this.notify(message);
  }

  private pickSurfacePosition(screenPosition: Cartesian2): { position: Cartesian3; source: string } | undefined {
    const scene = this.viewer.scene;
    const object = scene.pick(screenPosition) as { primitive?: unknown; content?: unknown; id?: unknown } | undefined;
    if (scene.pickPositionSupported) {
      const previousTranslucentDepth = scene.pickTranslucentDepth;
      try {
        // Underground tools may intentionally pick transparent surfaces. Do not
        // leave this expensive mode enabled for later camera drag/zoom events.
        scene.pickTranslucentDepth = true;
        const picked = scene.pickPosition(screenPosition);
        if (picked && Cartesian3.magnitude(picked) > 1) {
          const modelSurface = Boolean(object && (object.primitive instanceof Model || object.primitive instanceof Cesium3DTileset || object.content));
          return { position: picked, source: modelSurface ? "倾斜摄影/模型表面" : "场景表面" };
        }
      } finally {
        scene.pickTranslucentDepth = previousTranslucentDepth;
      }
    }
    const ray = this.viewer.camera.getPickRay(screenPosition);
    const globePosition = ray ? scene.globe.pick(ray, scene) : undefined;
    if (globePosition) return { position: globePosition, source: "地形表面" };
    const ellipsoidPosition = this.viewer.camera.pickEllipsoid(screenPosition, scene.globe.ellipsoid);
    return ellipsoidPosition ? { position: ellipsoidPosition, source: "椭球表面" } : undefined;
  }

  private applyGroundMode() {
    const translucent = element<HTMLInputElement>("#groundTransparent").checked;
    const underground = element<HTMLInputElement>("#undergroundMode").checked;
    const alpha = Math.max(0.05, Math.min(1, numberValue("#groundAlpha", 0.35)));
    const globe = this.viewer.scene.globe;
    element<HTMLOutputElement>("#groundAlphaValue").value = `${Math.round(alpha * 100)}%`;
    globe.translucency.enabled = translucent || underground;
    globe.translucency.frontFaceAlpha = translucent || underground ? alpha : 1;
    globe.translucency.backFaceAlpha = translucent || underground ? Math.min(1, alpha + 0.2) : 1;
    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = underground ? false : this.originalCollision;
    globe.depthTestAgainstTerrain = underground ? false : this.originalDepthTest;
    if (underground && !translucent) {
      element<HTMLInputElement>("#groundTransparent").checked = true;
    }
    this.viewer.scene.requestRender();
  }

  private diveUnderground() {
    if (!this.sectionAnchor) {
      const center = new Cartesian2(this.viewer.scene.canvas.clientWidth / 2, this.viewer.scene.canvas.clientHeight / 2);
      const picked = this.pickSurfacePosition(center)?.position;
      if (!picked) return this.notify("请先选择剖面位置，或把画面中心对准需要下潜的位置", true);
      this.sectionAnchor = Cartesian3.clone(picked);
      this.updateSectionGuide();
    }
    element<HTMLInputElement>("#undergroundMode").checked = true;
    this.applyGroundMode();
    const cartographic = Cartographic.fromCartesian(this.sectionAnchor);
    const destination = Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, cartographic.height - Math.max(1, numberValue("#undergroundDepth", 8)));
    this.viewer.camera.flyTo({ destination, orientation: { heading: this.viewer.camera.heading, pitch: 0, roll: 0 }, duration: 1.2 });
  }

  private sectionNormal() {
    const direction = element<HTMLSelectElement>("#sectionDirection").value;
    const normal = direction === "eastWest" ? Cartesian3.UNIT_Y : direction === "horizontal" ? Cartesian3.UNIT_Z : Cartesian3.UNIT_X;
    return element<HTMLInputElement>("#sectionInvert").checked ? Cartesian3.negate(normal, new Cartesian3()) : Cartesian3.clone(normal);
  }

  private createClippingCollection(modelMatrix: Matrix4) {
    return new ClippingPlaneCollection({
      planes: [new ClippingPlane(this.sectionNormal(), -numberValue("#sectionOffset"))],
      modelMatrix,
      edgeColor: Color.fromCssColorString("#42e4ff"),
      edgeWidth: 1.5,
    });
  }

  private targetClipMatrix(item: ImportRecord, worldFrame: Matrix4) {
    let origin: Matrix4;
    if (item.kind === "Model") {
      origin = (item.resource as Model).modelMatrix;
    } else {
      const tileset = item.resource as Cesium3DTileset;
      const rootTransform = tileset.root.transform;
      origin = Matrix4.equals(rootTransform, Matrix4.IDENTITY)
        ? Transforms.eastNorthUpToFixedFrame(tileset.boundingSphere.center)
        : Matrix4.multiply(tileset.modelMatrix, rootTransform, new Matrix4());
    }
    const inverse = Matrix4.inverse(origin, new Matrix4());
    return Matrix4.multiply(inverse, worldFrame, new Matrix4());
  }

  private clearSectionClipping() {
    for (const collection of this.clippingTargets.values()) {
      if (!collection.isDestroyed()) collection.enabled = false;
    }
    this.viewer.scene.requestRender();
  }

  private applySectionClipping() {
    if (!element<HTMLInputElement>("#sectionEnabled").checked || !this.sectionAnchor) {
      return this.clearSectionClipping();
    }
    const worldFrame = Transforms.eastNorthUpToFixedFrame(this.sectionAnchor);
    const globe = this.viewer.scene.globe as typeof this.viewer.scene.globe & { clippingPlanes: ClippingPlaneCollection | undefined };
    this.updateSectionCollection(globe, worldFrame);
    for (const item of this.imports()) {
      if (item.kind !== "3D Tiles" && item.kind !== "Model") continue;
      const target = item.resource as (Cesium3DTileset | Model) & { clippingPlanes: ClippingPlaneCollection | undefined };
      this.updateSectionCollection(target, this.targetClipMatrix(item, worldFrame));
    }
    this.updateSectionGuide();
    this.viewer.scene.requestRender();
  }

  private updateSectionCollection(target: object & { clippingPlanes: ClippingPlaneCollection | undefined }, modelMatrix: Matrix4) {
    let collection = this.clippingTargets.get(target);
    if (!collection || collection.isDestroyed() || target.clippingPlanes !== collection) {
      collection = this.createClippingCollection(modelMatrix);
      target.clippingPlanes = collection;
      this.clippingTargets.set(target, collection);
      return;
    }
    collection.enabled = true;
    collection.modelMatrix = Matrix4.clone(modelMatrix, collection.modelMatrix);
    collection.edgeColor = Color.fromCssColorString("#42e4ff");
    collection.edgeWidth = 1.5;
    const plane = collection.get(0);
    if (plane) {
      plane.normal = this.sectionNormal();
      plane.distance = -numberValue("#sectionOffset");
    } else {
      collection.add(new ClippingPlane(this.sectionNormal(), -numberValue("#sectionOffset")));
    }
  }

  private updateSectionGuide() {
    this.overlay.entities.removeById("subsurface-section-anchor");
    this.overlay.entities.removeById("subsurface-section-line");
    if (!this.sectionAnchor) return;
    const frame = Transforms.eastNorthUpToFixedFrame(this.sectionAnchor);
    const direction = element<HTMLSelectElement>("#sectionDirection").value;
    const axis = direction === "northSouth" ? Cartesian3.UNIT_Y : Cartesian3.UNIT_X;
    const left = Matrix4.multiplyByPoint(frame, Cartesian3.multiplyByScalar(axis, -300, new Cartesian3()), new Cartesian3());
    const right = Matrix4.multiplyByPoint(frame, Cartesian3.multiplyByScalar(axis, 300, new Cartesian3()), new Cartesian3());
    this.overlay.entities.add({ id: "subsurface-section-anchor", position: this.sectionAnchor, point: { pixelSize: 10, color: Color.CYAN, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }, label: { text: "剖面位置", fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 2, pixelOffset: new Cartesian2(0, -20), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    if (direction !== "horizontal") this.overlay.entities.add({ id: "subsurface-section-line", polyline: { positions: [left, right], width: 3, material: Color.CYAN, clampToGround: true } });
  }

  private startExcavationDrawing() {
    this.clearExcavation();
    this.interactionMode = "excavation";
    element("#collisionSummary").textContent = "请在地图上逐点单击，右键完成开挖边界";
    this.notify("开始绘制开挖范围：左键加点，右键完成");
  }

  private clearExcavation() {
    this.interactionMode = null;
    this.excavationPoints = [];
    this.excavationPointSources = [];
    this.excavationFinished = false;
    this.clearExcavationClipping();
    this.overlay.entities.values.filter((entity) => entity.id.startsWith("excavation-")).forEach((entity) => this.overlay.entities.remove(entity));
    this.overlay.entities.values.filter((entity) => entity.id.startsWith("collision-")).forEach((entity) => this.overlay.entities.remove(entity));
    element("#collisionSummary").textContent = "尚未绘制开挖范围";
    element("#excavationVolume").classList.add("hidden");
    element("#excavationVolume").innerHTML = "";
    element("#collisionResults").innerHTML = "";
  }

  private updateExcavationGraphic(closed: boolean) {
    this.overlay.entities.values.filter((entity) => entity.id.startsWith("excavation-visual-")).forEach((entity) => this.overlay.entities.remove(entity));
    if (this.excavationPoints.length >= 2) this.overlay.entities.add({ id: "excavation-visual-outline", polyline: { positions: closed ? [...this.excavationPoints, this.excavationPoints[0]] : this.excavationPoints, width: 3, material: Color.fromCssColorString("#ffb020") } });
    if (!closed || this.excavationPoints.length < 3) return;

    const frame = Transforms.eastNorthUpToFixedFrame(this.excavationPoints[0]);
    const inverse = Matrix4.inverse(frame, new Matrix4());
    const topLocal = this.excavationPoints.map((position) => Matrix4.multiplyByPoint(inverse, position, new Cartesian3()));
    const top2d = topLocal.map((position) => new Cartesian2(position.x, position.y));
    const topArea = Math.abs(polygonSignedArea(top2d));
    if (topArea < 0.01) {
      element("#collisionSummary").textContent = "开挖范围面积过小，请重新绘制";
      return;
    }
    const depth = Math.max(0.1, numberValue("#excavationDepth", 5));
    const slopeMode = element<HTMLSelectElement>("#excavationMode").value === "slope";
    const slopeRatio = slopeMode ? Math.max(0, numberValue("#excavationSlope", 0.5)) : 0;
    const insetDistance = depth * slopeRatio;
    let bottom2d = insetPolygon(top2d, insetDistance);
    let bottomArea = Math.abs(polygonSignedArea(bottom2d));
    if (!Number.isFinite(bottomArea) || bottomArea < 0.01 || bottomArea > topArea * 1.05) {
      const centroid = top2d.reduce((sum, point) => Cartesian2.add(sum, point, sum), new Cartesian2());
      Cartesian2.divideByScalar(centroid, top2d.length, centroid);
      const meanRadius = top2d.reduce((sum, point) => sum + Cartesian2.distance(point, centroid), 0) / top2d.length;
      const scale = Math.max(0.05, 1 - insetDistance / Math.max(meanRadius, insetDistance));
      bottom2d = top2d.map((point) => new Cartesian2(centroid.x + (point.x - centroid.x) * scale, centroid.y + (point.y - centroid.y) * scale));
      bottomArea = Math.abs(polygonSignedArea(bottom2d));
    }
    const surfaceElevation = topLocal.reduce((sum, point) => sum + point.z, 0) / topLocal.length;
    const bottomElevation = surfaceElevation - depth;
    const bottomWorld = bottom2d.map((point) => Matrix4.multiplyByPoint(frame, new Cartesian3(point.x, point.y, bottomElevation), new Cartesian3()));
    const volume = slopeMode ? (depth / 3) * (topArea + bottomArea + Math.sqrt(topArea * bottomArea)) : topArea * depth;

    this.overlay.entities.add({ id: "excavation-visual-top", polygon: { hierarchy: new PolygonHierarchy(this.excavationPoints), material: Color.fromCssColorString("#ffb020").withAlpha(0.12), perPositionHeight: true } });
    this.overlay.entities.add({ id: "excavation-visual-bottom", polygon: { hierarchy: new PolygonHierarchy(bottomWorld), material: Color.fromCssColorString("#d85b35").withAlpha(0.38), perPositionHeight: true, outline: true, outlineColor: Color.fromCssColorString("#ff7a4f") } });
    for (let index = 0; index < this.excavationPoints.length; index++) {
      const next = (index + 1) % this.excavationPoints.length;
      this.overlay.entities.add({ id: `excavation-visual-slope-${index}`, polygon: { hierarchy: new PolygonHierarchy([this.excavationPoints[index], this.excavationPoints[next], bottomWorld[next], bottomWorld[index]]), material: Color.fromCssColorString("#c97842").withAlpha(0.5), perPositionHeight: true, outline: true, outlineColor: Color.fromCssColorString("#ffb068") } });
    }
    const modelPoints = this.excavationPointSources.filter((source) => source === "倾斜摄影/模型表面").length;
    element("#collisionSummary").textContent = `开挖范围已完成：${this.excavationPoints.length} 个边界点 · 模型面取点 ${modelPoints} 个`;
    const volumePanel = element("#excavationVolume");
    volumePanel.classList.remove("hidden");
    volumePanel.innerHTML = `<strong>预计挖方 ${volume.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} m³</strong><span>顶口面积 ${topArea.toFixed(2)}㎡ · 坑底面积 ${bottomArea.toFixed(2)}㎡</span><small>深度 ${depth.toFixed(2)}m${slopeMode ? ` · 坡比 1:${slopeRatio.toFixed(2)} · 放坡宽度 ${insetDistance.toFixed(2)}m` : " · 垂直开挖"}</small>`;
  }

  private clearExcavationClipping() {
    for (const collection of this.excavationClipTargets.values()) {
      if (!collection.isDestroyed()) collection.enabled = false;
    }
    this.viewer.scene.requestRender();
  }

  private applyExcavationClipping() {
    if (!this.excavationFinished || this.excavationPoints.length < 3 || !element<HTMLInputElement>("#clipExcavationSurface").checked) {
      this.clearExcavationClipping();
      return;
    }
    if (!ClippingPolygonCollection.isSupported(this.viewer.scene)) {
      element<HTMLInputElement>("#clipExcavationSurface").checked = false;
      this.clearExcavationClipping();
      return this.notify("当前显卡或浏览器不支持模型多边形开挖裁剪，仍可显示放坡开挖体和计算土方量", true);
    }
    // Terrain polygon clipping shares GPU distance textures with imagery LOD
    // updates and was the persistent destroy() failure path during zooming.
    // Keep the excavation visualization on terrain and clip only engineering
    // models / 3D Tiles, which are stable owners for this collection.
    this.disableGlobePolygonClipping();
    for (const item of this.imports()) {
      if (item.kind !== "3D Tiles" && item.kind !== "Model") continue;
      const target = item.resource as (Cesium3DTileset | Model) & { clippingPolygons: ClippingPolygonCollection | undefined };
      this.updateExcavationCollection(target);
    }
    this.viewer.scene.requestRender();
  }

  private updateExcavationCollection(target: object & { clippingPolygons: ClippingPolygonCollection | undefined }) {
    let collection = this.excavationClipTargets.get(target);
    if (!collection || collection.isDestroyed() || target.clippingPolygons !== collection) {
      collection = new ClippingPolygonCollection({
        polygons: [new ClippingPolygon({ positions: this.excavationPoints })],
        inverse: false,
        quality: 1.5,
      });
      target.clippingPolygons = collection;
      this.excavationClipTargets.set(target, collection);
      return;
    }
    collection.enabled = true;
    collection.inverse = false;
    collection.quality = 1.5;
    const polygon = collection.get(0);
    const unchanged = polygon
      && polygon.length === this.excavationPoints.length
      && polygon.positions.every((position, index) => Cartesian3.equals(position, this.excavationPoints[index]));
    if (unchanged) return;

    // Cesium <= 1.143 could leave terrain clipping GPU resources in a stale
    // state when removeAll() temporarily made this collection empty. Replace
    // the owned collection atomically instead of exposing an empty one.
    const replacement = new ClippingPolygonCollection({
      polygons: [new ClippingPolygon({ positions: this.excavationPoints })],
      inverse: false,
      quality: 1.5,
    });
    target.clippingPolygons = replacement;
    this.excavationClipTargets.set(target, replacement);
  }

  private polylineEntities() {
    const result: Array<{ layer: string; entityName: string; positions: Cartesian3[] }> = [];
    const smart = element<HTMLSelectElement>("#pipelineScope").value === "smart";
    for (const item of this.imports()) {
      if (!item.visible || (item.kind !== "CAD" && item.kind !== "GIS")) continue;
      const primitiveSource = item.resource as { cadPolylineFeatures?: CadPolylineFeature[] };
      for (const feature of primitiveSource.cadPolylineFeatures ?? []) {
        if (feature.positions.length < 2) continue;
        const identity = `${item.name} ${feature.layer} ${feature.name} ${feature.sourceType}`;
        if (smart && !PIPELINE_KEYWORDS.test(identity)) continue;
        result.push({ layer: item.name, entityName: feature.name || feature.entity.id, positions: feature.positions });
      }
      const source = item.resource as { entities?: { values: Entity[] } };
      for (const entity of source.entities?.values ?? []) {
        const positions = entity.polyline?.positions?.getValue(this.viewer.clock.currentTime) as Cartesian3[] | undefined;
        if (!positions || positions.length < 2) continue;
        const identity = `${item.name} ${entity.name ?? ""}`;
        if (smart && !PIPELINE_KEYWORDS.test(identity)) continue;
        result.push({ layer: item.name, entityName: entity.name ?? entity.id, positions });
      }
    }
    return result;
  }

  private runCollisionCheck() {
    if (this.excavationPoints.length < 3) return this.notify("请先绘制完整的开挖范围", true);
    const candidates = this.polylineEntities();
    if (!candidates.length) return this.notify(element<HTMLSelectElement>("#pipelineScope").value === "smart" ? "没有识别到管线图层；可把识别范围切换为“全部 CAD/GIS 线条”" : "当前没有可检查的 CAD/GIS 线数据", true);
    this.overlay.entities.values.filter((entity) => entity.id.startsWith("collision-")).forEach((entity) => this.overlay.entities.remove(entity));
    const anchor = this.excavationPoints[0];
    const frame = Transforms.eastNorthUpToFixedFrame(anchor);
    const inverse = Matrix4.inverse(frame, new Matrix4());
    const polygon3d = this.excavationPoints.map((position) => Matrix4.multiplyByPoint(inverse, position, new Cartesian3()));
    const polygon = polygon3d.map((position) => new Cartesian2(position.x, position.y));
    const surfaceElevation = polygon3d.reduce((sum, position) => sum + position.z, 0) / polygon3d.length;
    const depth = Math.max(0.1, numberValue("#excavationDepth", 5));
    const clearance = Math.max(0, numberValue("#collisionClearance", 1));
    const warnUnknown = element<HTMLInputElement>("#warnUnknownHeight").checked;
    const hits: CollisionHit[] = [];
    for (const candidate of candidates) {
      let candidateHit: CollisionHit | null = null;
      for (let index = 0; index < candidate.positions.length - 1 && !candidateHit; index++) {
        const worldA = candidate.positions[index]; const worldB = candidate.positions[index + 1];
        const a = Matrix4.multiplyByPoint(inverse, worldA, new Cartesian3());
        const b = Matrix4.multiplyByPoint(inverse, worldB, new Cartesian3());
        let ratio: number | null = pointInPolygon(new Cartesian2(a.x, a.y), polygon) ? 0 : pointInPolygon(new Cartesian2(b.x, b.y), polygon) ? 1 : null;
        if (ratio === null) {
          for (let edge = 0; edge < polygon.length; edge++) {
            const crossing = segmentIntersection(a, b, polygon[edge], polygon[(edge + 1) % polygon.length]);
            if (crossing) { ratio = crossing.ratio; break; }
          }
        }
        if (ratio === null) continue;
        const z = a.z + (b.z - a.z) * ratio;
        const relativeHeight = z - surfaceElevation;
        const spatialHit = relativeHeight <= clearance && relativeHeight >= -depth - clearance;
        if (!spatialHit && !warnUnknown) continue;
        const world = Cartesian3.lerp(worldA, worldB, ratio, new Cartesian3());
        candidateHit = { layer: candidate.layer, entity: candidate.entityName, kind: spatialHit ? "空间碰撞" : "平面相交", position: world, heightDifference: relativeHeight };
      }
      if (candidateHit) hits.push(candidateHit);
    }
    hits.forEach((hit, index) => this.overlay.entities.add({ id: `collision-${index}`, position: hit.position, point: { pixelSize: 13, color: hit.kind === "空间碰撞" ? Color.RED : Color.ORANGE, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }, label: { text: `⚠ ${hit.kind}`, font: "13px sans-serif", fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, pixelOffset: new Cartesian2(0, -24), disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    element("#collisionSummary").textContent = hits.length ? `发现 ${hits.length} 处风险：${hits.filter((hit) => hit.kind === "空间碰撞").length} 处空间碰撞，${hits.filter((hit) => hit.kind === "平面相交").length} 处高程待核` : `已检查 ${candidates.length} 条管线，未发现碰撞`;
    element("#collisionResults").innerHTML = hits.length ? hits.map((hit) => `<button data-hit-index="${hits.indexOf(hit)}"><strong>${escapeHtml(hit.kind)}</strong><span>${escapeHtml(hit.layer)} · ${escapeHtml(hit.entity)}</span><small>相对开挖面高差 ${hit.heightDifference.toFixed(2)}m</small></button>`).join("") : '<div class="collision-ok">✓ 未发现相交管线</div>';
    element("#collisionResults").querySelectorAll<HTMLButtonElement>("[data-hit-index]").forEach((button) => button.addEventListener("click", () => {
      const hit = hits[Number(button.dataset.hitIndex)];
      if (hit) this.viewer.camera.flyTo({ destination: Cartesian3.add(hit.position, new Cartesian3(0, 0, 80), new Cartesian3()), duration: 0.8 });
    }));
    this.notify(hits.length ? `碰撞检查完成：发现 ${hits.length} 处风险` : "碰撞检查完成：未发现风险", hits.length > 0);
  }

  private updatePhotoInputStatus(inputSelector: string, statusSelector: string) {
    const count = element<HTMLInputElement>(inputSelector).files?.length ?? 0;
    element(statusSelector).textContent = count ? `已选择 ${count} 张` : "未选择";
  }

  private async readPhotos(selector: string) {
    const files = [...(element<HTMLInputElement>(selector).files ?? [])];
    const result: PhotoRecord[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) throw new Error(`${file.name} 不是图片文件`);
      if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} 超过 15MB，请压缩后再归档`);
      result.push({ id: crypto.randomUUID(), name: file.name, type: file.type, dataUrl: await fileAsDataUrl(file), createdAt: new Date().toISOString() });
    }
    return result;
  }

  private async saveArchive() {
    if (this.archiveMutationPending) return this.notify("请等待当前档案保存或删除完成", true);
    this.archiveMutationPending = true;
    try {
      const name = element<HTMLInputElement>("#hiddenWorkName").value.trim();
      const longitude = numberValue("#hiddenWorkLon", Number.NaN);
      const latitude = numberValue("#hiddenWorkLat", Number.NaN);
      if (!name) throw new Error("请填写隐蔽工程名称");
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error("请在地图选择归档坐标，或填写有效经纬度");
      const editingId = element<HTMLInputElement>("#hiddenWorkId").value;
      const previous = this.records.find((record) => record.id === editingId);
      const now = new Date().toISOString();
      const record: HiddenWorkRecord = {
        id: previous?.id ?? crypto.randomUUID(),
        name,
        location: element<HTMLInputElement>("#hiddenWorkLocation").value.trim(),
        longitude,
        latitude,
        altitude: numberValue("#hiddenWorkAlt"),
        notes: element<HTMLTextAreaElement>("#hiddenWorkNotes").value.trim(),
        beforePhotos: [...(previous?.beforePhotos ?? []), ...(await this.readPhotos("#beforePhotos"))],
        afterPhotos: [...(previous?.afterPhotos ?? []), ...(await this.readPhotos("#afterPhotos"))],
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      if (!record.beforePhotos.length && !record.afterPhotos.length) throw new Error("请至少选择一张施工前或施工后照片");
      await putArchiveRecord(record);
      this.resetArchiveForm();
      await this.reloadArchives();
      this.notify(previous ? "隐蔽工程档案已更新" : "隐蔽工程档案已保存到本机");
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "隐蔽工程档案保存失败", true);
    } finally { this.archiveMutationPending = false; }
  }

  private resetArchiveForm() {
    ["#hiddenWorkId", "#hiddenWorkName", "#hiddenWorkLocation", "#hiddenWorkLon", "#hiddenWorkLat", "#hiddenWorkNotes"].forEach((selector) => { element<HTMLInputElement>(selector).value = ""; });
    element<HTMLInputElement>("#hiddenWorkAlt").value = "0";
    element<HTMLInputElement>("#beforePhotos").value = "";
    element<HTMLInputElement>("#afterPhotos").value = "";
    element("#beforePhotoStatus").textContent = "未选择";
    element("#afterPhotoStatus").textContent = "未选择";
    element("#saveHiddenWork").textContent = "保存档案";
    element("#cancelHiddenWorkEdit").classList.add("hidden");
  }

  private async reloadArchives() {
    try {
      this.records = await listArchiveRecords();
      this.renderArchiveMarkers();
      this.renderArchiveList();
      this.notifyArchiveOverview();
    } catch (error) {
      element("#hiddenWorkList").innerHTML = `<div class="panel-status error-text">${escapeHtml(error instanceof Error ? error.message : "本地档案读取失败")}</div>`;
    }
  }

  private renderArchiveMarkers() {
    this.overlay.entities.values.filter((entity) => entity.id.startsWith("hidden-work-")).forEach((entity) => this.overlay.entities.remove(entity));
    for (const record of this.records) {
      this.overlay.entities.add({ id: `hidden-work-${record.id}`, name: record.name, position: Cartesian3.fromDegrees(record.longitude, record.latitude, record.altitude), description: `<p>部位：${escapeHtml(record.location || "未填写")}</p><p>施工前照片：${record.beforePhotos.length} 张</p><p>施工后照片：${record.afterPhotos.length} 张</p><p>${escapeHtml(record.notes || "")}</p>`, point: { pixelSize: 11, color: record.afterPhotos.length ? Color.LIME : Color.YELLOW, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }, label: { text: record.name, font: "12px sans-serif", fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 2, pixelOffset: new Cartesian2(0, -20), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
  }

  private renderArchiveList() {
    element("#hiddenWorkList").innerHTML = this.records.length ? this.records.map((record) => {
      const photo = record.afterPhotos[0] ?? record.beforePhotos[0];
      return `<article class="archive-card" data-record-id="${record.id}">${photo ? `<img src="${photo.dataUrl}" alt="${escapeHtml(record.name)}" />` : '<div class="archive-photo-empty">无照片</div>'}<div class="archive-card-body"><strong>${escapeHtml(record.name)}</strong><span>${escapeHtml(record.location || "未填写部位")}</span><small>${record.longitude.toFixed(6)}, ${record.latitude.toFixed(6)} · 前 ${record.beforePhotos.length} / 后 ${record.afterPhotos.length}</small><small>更新于 ${formatDate(record.updatedAt)}</small><div><button data-archive-action="locate">定位</button><button data-archive-action="edit">补充资料</button><button data-archive-action="export">导出</button><button data-archive-action="delete" class="danger">删除</button></div></div></article>`;
    }).join("") : '<div class="panel-status">尚无隐蔽工程档案</div>';
  }

  private async handleArchiveAction(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-archive-action]");
    const card = button?.closest<HTMLElement>("[data-record-id]");
    const record = this.records.find((item) => item.id === card?.dataset.recordId);
    if (!button || !record) return;
    const action = button.dataset.archiveAction;
    if (action === "locate") {
      this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(record.longitude, record.latitude, record.altitude + 120), duration: 1 });
    } else if (action === "edit") {
      element<HTMLInputElement>("#hiddenWorkId").value = record.id;
      element<HTMLInputElement>("#hiddenWorkName").value = record.name;
      element<HTMLInputElement>("#hiddenWorkLocation").value = record.location;
      element<HTMLInputElement>("#hiddenWorkLon").value = String(record.longitude);
      element<HTMLInputElement>("#hiddenWorkLat").value = String(record.latitude);
      element<HTMLInputElement>("#hiddenWorkAlt").value = String(record.altitude);
      element<HTMLTextAreaElement>("#hiddenWorkNotes").value = record.notes;
      element("#beforePhotoStatus").textContent = `已有 ${record.beforePhotos.length} 张，可继续添加`;
      element("#afterPhotoStatus").textContent = `已有 ${record.afterPhotos.length} 张，可继续添加`;
      element("#saveHiddenWork").textContent = "更新档案";
      element("#cancelHiddenWorkEdit").classList.remove("hidden");
      element("#subsurfacePanel").scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "export") {
      this.downloadJson(`${record.name}-隐蔽工程档案.json`, record);
    } else if (action === "delete") {
      if (this.archiveMutationPending) return this.notify("请等待当前档案保存或删除完成", true);
      if (!window.confirm(`确认删除“${record.name}”及其本地照片档案吗？`)) return;
      this.archiveMutationPending = true;
      try {
        await deleteArchiveRecord(record.id);
        if (element<HTMLInputElement>("#hiddenWorkId").value === record.id) this.resetArchiveForm();
        await this.reloadArchives();
        this.notify("隐蔽工程档案已删除");
      } catch (error) {
        this.notify(error instanceof Error ? error.message : "隐蔽工程档案删除失败", true);
      } finally { this.archiveMutationPending = false; }
    }
  }

  private exportArchives() {
    if (!this.records.length) return this.notify("当前没有可导出的隐蔽工程档案", true);
    this.downloadJson(`隐蔽工程档案-${new Date().toISOString().slice(0, 10)}.json`, { version: 1, exportedAt: new Date().toISOString(), records: this.records });
  }

  private downloadJson(name: string, value: unknown) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name.replace(/[\\/:*?"<>|]/g, "_");
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
