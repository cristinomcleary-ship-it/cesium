import {
  BoundingSphere, Cartesian3, ConstantPositionProperty, ConstantProperty, GroundPolylinePrimitive,
  GroundPrimitive, HeightReference, LabelCollection, Matrix3, Matrix4, PolygonHierarchy,
  PrimitiveCollection, Transforms, type CustomDataSource, type JulianDate, type Viewer,
} from "cesium";
import { readCadImport } from "./cadImport.ts";
import { loadCadPrimitiveCollection } from "./cadPrimitiveLoader.ts";
import type { LibraryRecord } from "./projectLibrary.ts";
import type { ImportRecord } from "./types.ts";

/** Metres in the object's fixed local ENU frame; heading is clockwise degrees. */
export type VideoOverlayAdjustment = { east: number; north: number; up: number; heading: number };
export type VideoOverlayResourceItem = {
  id: string; name: string; kind: ImportRecord["kind"]; description: string;
  available: boolean; selected: boolean; error?: string;
};
export type VideoOverlayResourcesOptions = {
  viewer: Viewer;
  imports: () => readonly ImportRecord[];
  getRecord: (id: string) => LibraryRecord | undefined;
  signal?: AbortSignal;
};

type VisibleResource = { show: boolean; isDestroyed?: () => boolean };
type MatrixResource = VisibleResource & { modelMatrix: Matrix4; boundingSphere?: BoundingSphere };
type MatrixBinding = { resource: MatrixResource; original: Matrix4 };
type PositionBinding = { apply: (transform: Matrix4) => void; restore: () => void };
type Entry = {
  record: ImportRecord; original: VisibleResource;
  target: VisibleResource; center?: Cartesian3; matrices: MatrixBinding[];
  positions: PositionBinding[]; dataSource?: CustomDataSource; copy?: PrimitiveCollection;
  description: string; error?: string;
};

function alive(resource: VisibleResource): boolean {
  try { return !resource.isDestroyed?.(); } catch { return false; }
}
function finitePoint(point: Cartesian3 | undefined): point is Cartesian3 {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}
function validAnchor(point: Cartesian3 | undefined): point is Cartesian3 {
  return finitePoint(point) && Cartesian3.magnitude(point) > 1;
}
function noAdjustment(): VideoOverlayAdjustment { return { east: 0, north: 0, up: 0, heading: 0 }; }
function normalizedAdjustment(value: Partial<VideoOverlayAdjustment>): VideoOverlayAdjustment {
  const result = noAdjustment();
  for (const key of Object.keys(result) as Array<keyof VideoOverlayAdjustment>) {
    const number = value[key] ?? 0;
    if (!Number.isFinite(number)) throw new Error("AR 位置和旋转必须为有限数值");
    if (key !== "heading" && Math.abs(number) > 100_000) throw new Error("AR 位置微调不能超过 100000 米");
    result[key] = key === "heading" ? ((number + 180) % 360 + 360) % 360 - 180 : number;
  }
  return result;
}

/** Always derives from the saved anchor; repeated edits never compound a transform. */
export function videoOverlayAdjustmentMatrix(center: Cartesian3, value: VideoOverlayAdjustment): Matrix4 {
  if (!validAnchor(center)) throw new Error("对象没有有效的地理定位中心");
  const adjustment = normalizedAdjustment(value);
  const frame = Transforms.eastNorthUpToFixedFrame(center);
  const local = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationZ(-adjustment.heading * Math.PI / 180),
    new Cartesian3(adjustment.east, adjustment.north, adjustment.up),
  );
  return Matrix4.multiply(Matrix4.multiply(frame, local, new Matrix4()), Matrix4.inverseTransformation(frame, new Matrix4()), new Matrix4());
}

function eachPrimitive(root: unknown, visit: (resource: unknown) => void): void {
  if (root instanceof PrimitiveCollection) {
    for (let index = 0; index < root.length; index += 1) eachPrimitive(root.get(index), visit);
  } else visit(root);
}
function isGroundCad(resource: unknown): boolean {
  let ground = false;
  eachPrimitive(resource, child => {
    if (child instanceof GroundPrimitive || child instanceof GroundPolylinePrimitive) ground = true;
    if (child instanceof LabelCollection) {
      for (let index = 0; index < child.length; index += 1) {
        if (child.get(index).heightReference !== HeightReference.NONE) ground = true;
      }
    }
  });
  return ground;
}
function collectMatrices(resource: unknown): MatrixBinding[] {
  const bindings: MatrixBinding[] = [];
  eachPrimitive(resource, child => {
    const target = child as MatrixResource;
    if (!target?.modelMatrix) throw new Error("此 CAD 含不能独立变换的图元，请重新保存图纸后再加载 AR");
    bindings.push({ resource: target, original: Matrix4.clone(target.modelMatrix) });
  });
  if (!bindings.length) throw new Error("图层中没有可显示的工程几何");
  return bindings;
}
function cloneHierarchy(hierarchy: PolygonHierarchy): PolygonHierarchy {
  return new PolygonHierarchy(hierarchy.positions.map(point => Cartesian3.clone(point)), (hierarchy.holes ?? []).map(cloneHierarchy));
}
function moveHierarchy(hierarchy: PolygonHierarchy, transform: Matrix4): PolygonHierarchy {
  return new PolygonHierarchy(hierarchy.positions.map(point => Matrix4.multiplyByPoint(transform, point, new Cartesian3())), hierarchy.holes.map(hole => moveHierarchy(hole, transform)));
}
function hierarchyPoints(hierarchy: PolygonHierarchy, points: Cartesian3[]) {
  for (const point of hierarchy.positions) points.push(point);
  for (const hole of hierarchy.holes) hierarchyPoints(hole, points);
}
function dataSourceIsClamped(data: CustomDataSource, time: JulianDate): boolean {
  return data.entities.values.some(entity =>
    entity.polyline?.clampToGround?.getValue(time) === true
    || !!entity.polygon && entity.polygon.perPositionHeight?.getValue(time) !== true
    || !!entity.label && (entity.label.heightReference?.getValue(time) ?? HeightReference.NONE) !== HeightReference.NONE
    || !!entity.point && (entity.point.heightReference?.getValue(time) ?? HeightReference.NONE) !== HeightReference.NONE);
}

/** CAD entity properties already contain sampled heights; retain those exact vertices. */
function collectPositions(data: CustomDataSource, time: JulianDate): { bindings: PositionBinding[]; center?: Cartesian3 } {
  const bindings: PositionBinding[] = [], points: Cartesian3[] = [];
  for (const entity of data.entities.values) {
    const positionProperty = entity.position;
    const position = positionProperty?.getValue(time);
    if (finitePoint(position)) {
      const original = Cartesian3.clone(position);
      points.push(original);
      bindings.push({
        apply: transform => { entity.position = new ConstantPositionProperty(Matrix4.multiplyByPoint(transform, original, new Cartesian3())); },
        restore: () => { entity.position = positionProperty; },
      });
    }
    const line = entity.polyline;
    const lineProperty = line?.positions;
    const positions = lineProperty?.getValue(time) as Cartesian3[] | undefined;
    if (line && positions?.length) {
      if (!positions.every(finitePoint)) throw new Error("CAD 线含无效坐标");
      const original = positions.map(point => Cartesian3.clone(point));
      for (const point of original) points.push(point);
      bindings.push({
        apply: transform => { line.positions = new ConstantProperty(original.map(point => Matrix4.multiplyByPoint(transform, point, new Cartesian3()))); },
        restore: () => { line.positions = lineProperty; },
      });
    }
    const polygon = entity.polygon;
    const hierarchyProperty = polygon?.hierarchy;
    const hierarchy = hierarchyProperty?.getValue(time) as PolygonHierarchy | undefined;
    if (polygon && hierarchy?.positions?.length) {
      const original = cloneHierarchy(hierarchy);
      const polygonPoints: Cartesian3[] = [];
      hierarchyPoints(original, polygonPoints);
      if (!polygonPoints.every(finitePoint)) throw new Error("CAD 面含无效坐标");
      for (const point of polygonPoints) points.push(point);
      bindings.push({
        apply: transform => { polygon.hierarchy = new ConstantProperty(moveHierarchy(original, transform)); },
        restore: () => { polygon.hierarchy = hierarchyProperty; },
      });
    }
  }
  if (!bindings.length) throw new Error("CAD 中没有可显示的线、面或文字");
  return { bindings, center: points.length ? BoundingSphere.fromPoints(points).center : undefined };
}

/** Owns temporary resource state only. Camera, background and scene tools remain the caller's responsibility. */
export class VideoOverlayResources {
  private readonly entries = new Map<string, Entry>();
  private readonly visibilitySnapshots = new Map<VisibleResource, boolean>();
  private readonly controller = new AbortController();
  private readonly adjustments = new Map<string, VideoOverlayAdjustment>();
  private selected = new Set<string>();
  private visible = true;
  private restored = false;
  private removeAbortListener?: () => void;

  private constructor(private readonly options: VideoOverlayResourcesOptions) {}

  static async create(options: VideoOverlayResourcesOptions): Promise<VideoOverlayResources> {
    const session = new VideoOverlayResources(options);
    const abort = () => session.restore();
    options.signal?.addEventListener("abort", abort, { once: true });
    session.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    try {
      if (options.signal?.aborted) throw new DOMException("AR 加载已取消", "AbortError");
      // Snapshot all import layers, including GIS. Never change ImportRecord.visible or saved scene settings.
      for (const record of options.imports()) {
        const original = record.resource as VisibleResource;
        if (!original || !alive(original) || typeof original.show !== "boolean") continue;
        session.visibilitySnapshots.set(original, original.show);
        original.show = false;
        if (!["CAD", "Model", "3D Tiles"].includes(record.kind)) continue;
        session.entries.set(record.id, {
          record, original, target: original,
          matrices: [], positions: [], description: record.kind === "CAD" ? "使用图纸已定位坐标" : "使用工程对象已定位坐标",
        });
      }
      // Ground CAD must be rebuilt from source; all other resources reuse existing geometry.
      for (const entry of session.entries.values()) {
        session.throwIfCancelled();
        try { await session.prepare(entry); }
        catch (error) {
          session.throwIfCancelled();
          session.disposeCopy(entry);
          entry.error = error instanceof Error ? error.message : String(error);
        }
      }
      session.throwIfCancelled();
      options.viewer.scene.requestRender();
      return session;
    } catch (error) { session.restore(); throw error; }
  }

  private throwIfCancelled() {
    if (this.restored || this.controller.signal.aborted) throw new DOMException("AR 加载已取消", "AbortError");
  }

  private async prepare(entry: Entry) {
    const { record } = entry;
    if (record.kind === "Model" || record.kind === "3D Tiles") {
      const resource = entry.original as MatrixResource;
      if (!resource.modelMatrix) throw new Error("模型位置矩阵不可用");
      entry.matrices = [{ resource, original: Matrix4.clone(resource.modelMatrix) }];
      try { entry.center = resource.boundingSphere?.center ? Cartesian3.clone(resource.boundingSphere.center) : undefined; } catch { /* A model may still be compiling. */ }
      entry.center ??= record.boundingSphere?.center ? Cartesian3.clone(record.boundingSphere.center) : undefined;
      if (!validAnchor(entry.center)) entry.center = Matrix4.getTranslation(resource.modelMatrix, new Cartesian3());
    } else if (record.representation === "primitive") {
      const saved = this.options.getRecord(record.id);
      if (isGroundCad(entry.original) || saved?.settings.displayMode && saved.settings.displayMode !== "absolute") {
        await this.prepareAbsoluteCopy(entry, saved);
      } else {
        entry.matrices = collectMatrices(entry.original);
        entry.center = record.boundingSphere?.center ? Cartesian3.clone(record.boundingSphere.center) : undefined;
      }
    } else {
      const data = entry.original as CustomDataSource;
      if (!data.entities?.values) throw new Error("CAD 实体数据不可读取");
      if (dataSourceIsClamped(data, this.options.viewer.clock.currentTime)) {
        await this.prepareAbsoluteCopy(entry, this.options.getRecord(record.id));
      } else {
        const positions = collectPositions(data, this.options.viewer.clock.currentTime);
        entry.positions = positions.bindings;
        entry.center = positions.center;
        entry.dataSource = data;
        entry.description = "保留当前 CAD 顶点及已采样高程";
      }
    }
    if (!validAnchor(entry.center)) throw new Error("工程对象缺少有效的地理定位中心，请先完成定位");
    this.adjustments.set(record.id, noAdjustment());
  }

  private async prepareAbsoluteCopy(entry: Entry, saved: LibraryRecord | undefined) {
    const file = saved?.files.data;
    if (!file || !saved.settings.coordinates) throw new Error("贴附 CAD 需要已保存的 .cadimport 和坐标参数，请先在资料库保存图纸");
    const response = await fetch(file.url, { signal: this.controller.signal });
    if (!response.ok) throw new Error(`CAD 源文件读取失败（HTTP ${response.status}）`);
    const imported = await readCadImport(new File([await response.blob()], file.name));
    this.throwIfCancelled();
    const result = await loadCadPrimitiveCollection(imported, saved.settings.coordinates, {
      displayMode: "absolute", scene: this.options.viewer.scene, signal: this.controller.signal,
      batchSize: 2000, primitiveBatchSize: 1000,
      beforePopulate: collection => {
        if (this.restored || this.controller.signal.aborted) collection.destroy();
        this.throwIfCancelled();
        collection.show = false;
        entry.copy = collection;
        this.options.viewer.scene.primitives.add(collection);
      },
    });
    this.throwIfCancelled();
    entry.target = result.collection;
    entry.matrices = collectMatrices(result.collection);
    entry.center = result.boundingSphere?.center ? Cartesian3.clone(result.boundingSphere.center) : undefined;
    entry.description = "按图纸标高叠加，可用高程微调（原贴附图层保持不变）";
  }

  list(): VideoOverlayResourceItem[] {
    return [...this.entries.values()].map(entry => {
      const exists = this.options.imports().some(record => record.id === entry.record.id && record.resource === entry.original);
      const available = !this.restored && !entry.error && exists && alive(entry.original) && alive(entry.target);
      return { id: entry.record.id, name: entry.record.name, kind: entry.record.kind,
        description: entry.description, available, selected: this.selected.has(entry.record.id),
        ...(!available ? { error: entry.error ?? "工程图层已移除，请重新进入 AR" } : {}),
      };
    });
  }

  get(id: string): VideoOverlayResourceItem | undefined { return this.list().find(item => item.id === id); }

  setSelection(ids: readonly string[]): void {
    this.throwIfCancelled();
    const available = new Set(this.list().filter(item => item.available).map(item => item.id));
    this.selected = new Set(ids.filter(id => available.has(id)));
    this.updateVisibility();
  }

  /** Used while seeking / outside the CC time range without losing the user's selection. */
  setVisible(visible: boolean): void {
    this.throwIfCancelled();
    this.visible = visible;
    this.updateVisibility();
  }

  private updateVisibility() {
    // Newly loaded unrelated layers also stay out of the video and are restored on exit.
    for (const record of this.options.imports()) {
      const resource = record.resource as VisibleResource;
      if (!resource || !alive(resource) || typeof resource.show !== "boolean") continue;
      if (!this.visibilitySnapshots.has(resource)) this.visibilitySnapshots.set(resource, resource.show);
      resource.show = false;
    }
    const available = new Set(this.list().filter(item => item.available).map(item => item.id));
    for (const [id, entry] of this.entries) {
      if (alive(entry.target)) entry.target.show = this.visible && this.selected.has(id) && available.has(id);
    }
    this.options.viewer.scene.requestRender();
  }

  /** A patch of absolute per-object offsets, not incremental deltas. Omitted objects retain their offsets. */
  applyAdjustments(values: Record<string, Partial<VideoOverlayAdjustment>>): void {
    this.throwIfCancelled();
    const normalized = Object.entries(values).map(([id, value]) => [id, normalizedAdjustment({ ...this.adjustments.get(id), ...value })] as const);
    for (const [id, adjustment] of normalized) {
      const entry = this.entries.get(id);
      if (!entry || !this.get(id)?.available || !entry.center) continue;
      const transform = videoOverlayAdjustmentMatrix(entry.center, adjustment);
      for (const binding of entry.matrices) {
        if (alive(binding.resource)) binding.resource.modelMatrix = Matrix4.multiply(transform, binding.original, new Matrix4());
      }
      entry.dataSource?.entities.suspendEvents();
      try { for (const binding of entry.positions) binding.apply(transform); }
      finally { entry.dataSource?.entities.resumeEvents(); }
      this.adjustments.set(id, adjustment);
    }
    this.options.viewer.scene.requestRender();
  }

  getAdjustments(): Record<string, VideoOverlayAdjustment> {
    return Object.fromEntries([...this.adjustments].map(([id, value]) => [id, { ...value }]));
  }

  private disposeCopy(entry: Entry) {
    if (!entry.copy) return;
    const copy = entry.copy;
    entry.copy = undefined;
    try {
      if (!copy.isDestroyed() && !this.options.viewer.scene.primitives.remove(copy)) copy.destroy();
    } catch { /* The host may already have disposed the viewer. */ }
  }

  /** Idempotent, including cancellation during a ground-CAD rebuild. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.controller.abort();
    this.removeAbortListener?.();
    for (const entry of this.entries.values()) {
      if (alive(entry.original)) {
        for (const binding of entry.matrices) {
          if (alive(binding.resource)) binding.resource.modelMatrix = Matrix4.clone(binding.original);
        }
        entry.dataSource?.entities.suspendEvents();
        try { for (const binding of entry.positions) binding.restore(); }
        finally { entry.dataSource?.entities.resumeEvents(); }
      }
      this.disposeCopy(entry);
    }
    for (const [resource, show] of this.visibilitySnapshots) if (alive(resource)) resource.show = show;
    this.selected.clear();
    this.options.viewer.scene.requestRender();
  }
}
