import {
  Appearance, BlendOption, BoundingSphere, CallbackProperty, Cartesian3, Cesium3DTileset, Color,
  ColorMaterialProperty, ConstantPositionProperty, ConstantProperty, CustomShader,
  CustomShaderTranslucencyMode, GroundPolylinePrimitive, GroundPrimitive, HeightReference,
  LabelCollection, Material, Matrix3, Matrix4, PolygonHierarchy, Primitive,
  PrimitiveCollection, Transforms, UniformType,
  type CustomDataSource, type JulianDate, type Property, type Viewer,
} from "cesium";
import { readCadImport } from "./cadImport.ts";
import { loadCadPrimitiveCollection } from "./cadPrimitiveLoader.ts";
import type { LibraryRecord } from "./projectLibrary.ts";
import type { ImportRecord } from "./types.ts";
import { assertVideoOverlayOccluder, VideoOverlayOcclusion, VideoOverlayTileCoverage, type VideoOverlayOcclusionStatus } from './videoOverlayOcclusion.ts';
import type { VideoOverlayEffectState } from './videoOverlayEffects.ts';

/** Metres in the object's fixed local ENU frame; heading is clockwise degrees. */
export type VideoOverlayAdjustment = { east: number; north: number; up: number; heading: number };
export type VideoOverlayResourceItem = {
  id: string; name: string; kind: ImportRecord["kind"]; description: string;
  available: boolean; selected: boolean; occluder?: boolean; error?: string;
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
type OpacityBinding = { apply: (opacity: number) => void; restore: () => void };
type Entry = {
  record: ImportRecord; original: VisibleResource;
  target: VisibleResource; center?: Cartesian3; matrices: MatrixBinding[];
  positions: PositionBinding[]; dataSource?: CustomDataSource; copy?: PrimitiveCollection;
  opacityBindings?: OpacityBinding[];
  description: string; error?: string; transformed?: boolean;
};

/** One shader owner per AR session; uniforms multiply the original fragment alpha. */
function modelOpacityBinding(target: VisibleResource): OpacityBinding {
  const resource = target as VisibleResource & { customShader?: CustomShader };
  const original = resource.customShader;
  let uniform = 'u_arPresentationOpacity', name = 'arOriginalFragmentMain';
  const source = original?.fragmentShaderText ?? '';
  while (original?.uniforms[uniform] || source.includes(uniform)) uniform += '_';
  while (source.includes(name)) name += '_';
  const fragment = source.replace(/\bfragmentMain\s*\(/g, `${name}(`);
  const shader = new CustomShader({
    mode: original?.mode,
    lightingModel: original?.lightingModel,
    // Fixed for the whole effect track: crossing alpha 1 never rebuilds the pass.
    translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT,
    uniforms: { ...original?.uniforms, [uniform]: { type: UniformType.FLOAT, value: 1 } },
    varyings: original?.varyings,
    vertexShaderText: original?.vertexShaderText,
    fragmentShaderText: `${fragment}\nvoid fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      ${source.trim() ? `${name}(fsInput, material);` : ''}
      material.alpha *= ${uniform};
    }`,
  });
  resource.customShader = shader;
  return {
    apply: opacity => { if (alive(resource) && resource.customShader === shader) shader.setUniform(uniform, opacity); },
    restore: () => {
      try { if (alive(resource) && resource.customShader === shader) resource.customShader = original; }
      finally { if (!shader.isDestroyed()) shader.destroy(); }
    },
  };
}

/** CAD shaders retain per-instance colors, original line depth tolerance and vertices. */
function primitiveOpacityBinding(resource: Primitive): OpacityBinding {
  const original = resource.appearance;
  const source = original.getFragmentShaderSource();
  let main = 'arOriginalMain', getter = 'arPresentationOpacity';
  while (source.includes(main)) main += '_';
  while (source.includes(getter)) getter += '_';
  // A numeric Material uniform lets Cesium manage the uniform map without touching
  // geometry-instance colors or rewriting thousands of per-feature byte arrays.
  const material = new Material({
    fabric: { uniforms: { arOpacity: 1 }, source: `float ${getter}() { return arOpacity; }` },
    translucent: true,
  });
  const appearance = new Appearance({
    material, translucent: true, closed: original.closed,
    vertexShaderSource: original.vertexShaderSource,
    fragmentShaderSource: `${source.replace(/\bmain\s*\(/g, `${main}(`)}\nvoid main() {
      ${main}(); out_FragColor.a *= ${getter}();
    }`,
    renderState: original.renderState,
  });
  resource.appearance = appearance;
  return {
    apply: opacity => { if (alive(resource) && resource.appearance === appearance) material.uniforms.arOpacity = opacity; },
    restore: () => {
      try { if (alive(resource) && resource.appearance === appearance) resource.appearance = original; }
      finally { if (!material.isDestroyed()) material.destroy(); }
    },
  };
}

function labelOpacityBindings(collection: LabelCollection): OpacityBinding[] {
  const bindings: OpacityBinding[] = [];
  const blend = collection.blendOption;
  collection.blendOption = BlendOption.TRANSLUCENT;
  bindings.push({ apply() {}, restore: () => { if (alive(collection)) collection.blendOption = blend; } });
  for (let index = 0; index < collection.length; index++) {
    const label = collection.get(index);
    for (const key of ['fillColor', 'outlineColor', 'backgroundColor'] as const) {
      const original = label[key], baseline = Color.clone(original);
      bindings.push({
        apply: opacity => { if (alive(collection)) label[key] = baseline.withAlpha(baseline.alpha * opacity); },
        // Label color setters copy into an internal Color, so the getter's
        // original reference may already have been mutated by later setters.
        restore: () => { if (alive(collection)) label[key] = baseline; },
      });
    }
  }
  return bindings;
}

/** Entity properties are wrapped once; the source property remains authoritative. */
function entityOpacityBindings(data: CustomDataSource, currentTime: JulianDate): OpacityBinding[] {
  const bindings: OpacityBinding[] = [];
  let opacity = 1;
  bindings.push({ apply: value => { opacity = value; }, restore() {} });
  // CPU material batching tests alpha < 1. The sub-float32 difference rounds to
  // exactly 1 on the GPU, retaining full opacity while keeping the same pass.
  const stableAlpha = (alpha: number) => Math.min(1 - Number.EPSILON, alpha * opacity);
  const color = (original: Property | undefined) => new CallbackProperty((time, result: Color | undefined) => {
    const baseline = original?.getValue(time) as Color | undefined ?? Color.WHITE;
    return Color.fromAlpha(baseline, stableAlpha(baseline.alpha), result);
  }, false);
  for (const entity of data.entities.values) {
    for (const graphic of [entity.polyline, entity.polygon]) {
      if (!graphic) continue;
      const original = graphic.material;
      // Imported CAD uses Color materials; preserve any non-CAD extension material.
      if (original && original.getType(currentTime) !== 'Color') continue;
      const property = new CallbackProperty((time, result: Color | undefined) => {
        const value = original?.getValue(time) as { color?: Color } | undefined;
        const baseline = value?.color ?? Color.WHITE;
        return Color.fromAlpha(baseline, stableAlpha(baseline.alpha), result);
      }, false);
      const material = new ColorMaterialProperty(property);
      graphic.material = material;
      bindings.push({ apply() {}, restore: () => { if (graphic.material === material) graphic.material = original; } });
    }
    for (const graphic of [entity.label, entity.point, entity.billboard]) {
      if (!graphic) continue;
      const object = graphic as unknown as Record<string, Property | undefined>;
      const keys = graphic === entity.label ? ['fillColor', 'outlineColor', 'backgroundColor']
        : graphic === entity.point ? ['color', 'outlineColor'] : ['color'];
      for (const key of keys) {
        const original = object[key], property = color(original);
        object[key] = property;
        bindings.push({ apply() {}, restore: () => { if (object[key] === property) object[key] = original; } });
      }
    }
  }
  return bindings;
}

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
function sameAdjustment(a: VideoOverlayAdjustment | undefined, b: VideoOverlayAdjustment): boolean {
  return !!a && a.east === b.east && a.north === b.north && a.up === b.up && a.heading === b.heading;
}
function setShow(resource: VisibleResource, show: boolean): boolean {
  if (!alive(resource) || resource.show === show) return false;
  resource.show = show; return true;
}
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
  private readonly opacityStates = new Map<string, VideoOverlayEffectState>();
  private readonly tileCoverage = new Map<string, VideoOverlayTileCoverage>();
  private readonly touchedTiles = new Set<Cesium3DTileset>();
  private occlusion?: VideoOverlayOcclusion;
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
    const current = this.importIndex();
    return [...this.entries.values()].map(entry => this.item(entry, current));
  }

  private importIndex(imports = this.options.imports()): Map<string, ImportRecord> {
    return new Map(imports.map(record => [record.id, record]));
  }
  private available(entry: Entry, current: ReadonlyMap<string, ImportRecord>): boolean {
    const record = current.get(entry.record.id);
    return !this.restored && !entry.error && record?.kind === entry.record.kind
      && record.resource === entry.original && alive(entry.original) && alive(entry.target);
  }
  private item(entry: Entry, current: ReadonlyMap<string, ImportRecord>): VideoOverlayResourceItem {
    const available = this.available(entry, current);
    return { id: entry.record.id, name: entry.record.name, kind: entry.record.kind,
      description: entry.description, available, selected: this.selected.has(entry.record.id),
      ...(this.occlusion?.sourceId === entry.record.id ? { occluder: true } : {}),
      ...(!available ? { error: entry.error ?? "工程图层已移除，请重新进入 AR" } : {}),
    };
  }
  get(id: string): VideoOverlayResourceItem | undefined {
    const entry = this.entries.get(id);
    return entry ? this.item(entry, this.importIndex()) : undefined;
  }

  /** A separate depth role; it does not edit texture selection or persisted positioning. */
  setOcclusion(sourceId?: string): void {
    this.throwIfCancelled();
    if (sourceId === this.occlusion?.sourceId) return;
    if (sourceId) {
      const entry = this.entries.get(sourceId);
      if (!entry || entry.record.kind !== '3D Tiles' || !this.get(sourceId)?.available) {
        throw new Error('地表遮挡源尚未加载或不可用，请选择已授权的倾斜摄影');
      }
      // A depth source owns a different opaque shader and must never inherit an
      // engineering-model presentation multiplier from its previous role.
      this.restoreOpacity(entry);
      this.opacityStates.delete(sourceId);
      this.tileCoverage.get(sourceId)?.restore(); this.tileCoverage.delete(sourceId);
      assertVideoOverlayOccluder(entry.original);
      if (Object.values(this.adjustments.get(sourceId) ?? noAdjustment()).some(value => value !== 0)) {
        throw new Error('此遮挡源已有独立 AR 位置微调，请先明确重置该对象微调或选择其他遮挡源');
      }
      this.occlusion?.restore(); this.occlusion = undefined;
      this.occlusion = new VideoOverlayOcclusion(sourceId, entry.original, this.options.viewer.scene);
    } else {
      this.occlusion?.restore(); this.occlusion = undefined;
    }
    this.prepareSelectedTileCoverage();
    this.updateVisibility(undefined, true);
  }

  getOcclusionStatus(): VideoOverlayOcclusionStatus {
    return this.occlusionStatus();
  }
  private occlusionStatus(current?: ReadonlyMap<string, ImportRecord>): VideoOverlayOcclusionStatus {
    if (!this.occlusion) return { enabled: false, ready: true };
    const { sourceId, source } = this.occlusion;
    const entry = this.entries.get(sourceId);
    const record = (current ?? this.importIndex()).get(sourceId);
    const allowed = !this.restored && !!entry && record?.kind === '3D Tiles' && record.resource === source;
    if (!allowed || !alive(source)) {
      this.occlusion.restore();
      setShow(source, false);
      return { enabled: true, sourceId, ready: false, error: '地表遮挡源已移除或不可用，请重新选择已授权的倾斜摄影' };
    }
    return this.occlusion.getStatus();
  }

  setSelection(ids: readonly string[]): void {
    this.throwIfCancelled();
    const imports = this.options.imports(), current = this.importIndex(imports);
    this.selected = new Set(ids.filter(id => {
      const entry = this.entries.get(id); return !!entry && this.available(entry, current);
    }));
    this.prepareSelectedTileCoverage();
    this.updateVisibility(imports);
  }

  private prepareSelectedTileCoverage() {
    for (const [id, coverage] of this.tileCoverage) {
      if (!this.selected.has(id) || id === this.occlusion?.sourceId) {
        coverage.restore(); this.tileCoverage.delete(id);
      }
    }
    for (const id of this.selected) {
      const entry = this.entries.get(id)!;
      if (entry.record.kind === '3D Tiles' && entry.original instanceof Cesium3DTileset) {
        if (id === this.occlusion?.sourceId) {
          // The depth role trims its own route cache when that role exits.
          this.touchedTiles.delete(entry.original);
          continue;
        }
        this.touchedTiles.add(entry.original);
        if (id !== this.occlusion?.sourceId && !this.tileCoverage.has(id)) {
          this.tileCoverage.set(id, new VideoOverlayTileCoverage(entry.original, this.options.viewer.scene, false));
        }
      }
    }
  }

  /** Pure timeline outputs are absolute multipliers. Missing IDs restore alpha 1.
   * Bind each material only on its first real fade; all subsequent frames update
   * uniforms/properties rather than replacing shaders or reselecting the object.
   */
  setTimelineOpacity(states: Readonly<Record<string, VideoOverlayEffectState>>): void {
    this.throwIfCancelled();
    const normalized = new Map<string, VideoOverlayEffectState>();
    for (const [id, value] of Object.entries(states)) {
      if (!value || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1
        || typeof value.visible !== 'boolean') throw new Error('模型展示透明度必须在 0 到 1 之间');
      normalized.set(id, { opacity: value.opacity, visible: value.visible && value.opacity > 0 });
    }
    const imports = this.options.imports(), current = this.importIndex(imports);
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (id === this.occlusion?.sourceId || !this.available(entry, current)) continue;
      const next = normalized.get(id) ?? { opacity: 1, visible: true };
      const previous = this.opacityStates.get(id) ?? { opacity: 1, visible: true };
      if (next.opacity === previous.opacity && next.visible === previous.visible) continue;
      if (next.opacity !== 1 && !entry.opacityBindings) this.prepareOpacity(entry);
      for (const binding of entry.opacityBindings ?? []) binding.apply(next.opacity);
      this.opacityStates.set(id, next); changed = true;
    }
    if (changed) this.updateVisibility(imports, true);
  }

  private prepareOpacity(entry: Entry) {
    const bindings: OpacityBinding[] = [];
    entry.opacityBindings = bindings;
    try {
      if (entry.record.kind === 'Model' || entry.record.kind === '3D Tiles') {
        bindings.push(modelOpacityBinding(entry.target));
      } else if (entry.dataSource) {
        bindings.push(...entityOpacityBindings(entry.dataSource, this.options.viewer.clock.currentTime));
      } else {
        eachPrimitive(entry.target, child => {
          if (child instanceof LabelCollection) bindings.push(...labelOpacityBindings(child));
          else if (child instanceof Primitive && child.appearance) bindings.push(primitiveOpacityBinding(child));
        });
      }
    } catch (error) { this.restoreOpacity(entry); throw error; }
  }

  private restoreOpacity(entry: Entry) {
    for (const binding of entry.opacityBindings ?? []) {
      try { binding.restore(); } catch { /* Continue releasing other original materials. */ }
    }
    entry.opacityBindings = undefined;
  }

  /** Both preRender and postRender use this guard before committing a fused frame.
   * Model.ready alone stays true while a replaced shader rebuilds draw commands.
   */
  isPresentationReady(beforeRender = false): boolean {
    if (this.restored || !this.visible) return !this.restored;
    const current = this.importIndex();
    for (const id of this.selected) {
      if (id === this.occlusion?.sourceId) continue;
      const entry = this.entries.get(id);
      if (!entry || !this.available(entry, current) || this.opacityStates.get(id)?.visible === false) continue;
      if (entry.record.kind === '3D Tiles' && this.tileCoverage.has(id)) {
        // preRender resets coverage before traversal; only postRender can test
        // this frame's selected tiles. Treating its empty pre-pass as a failure
        // would prevent the renderer from ever committing a Tiles frame.
        if (!beforeRender && !this.tileCoverage.get(id)!.isReady()) return false;
        continue;
      }
      let ready = true;
      eachPrimitive(entry.target, child => {
        const resource = child as { ready?: boolean; _drawCommandsBuilt?: boolean };
        if (resource?.ready === false || resource?._drawCommandsBuilt === false) ready = false;
      });
      if (!ready) return false;
    }
    return true;
  }

  /** Used while seeking / outside the CC time range without losing the user's selection. */
  setVisible(visible: boolean): void {
    this.throwIfCancelled();
    this.visible = visible;
    this.updateVisibility();
  }

  private updateVisibility(imports = this.options.imports(), forceRender = false) {
    // Newly loaded unrelated layers also stay out of the video and are restored on exit.
    // Compute final visibility before writing. Toggling an entity CAD off/on
    // would walk every entity twice and invalidate its display on every frame.
    const desired = new Map<VisibleResource, boolean>();
    for (const record of imports) {
      const resource = record.resource as VisibleResource;
      if (!resource || !alive(resource) || typeof resource.show !== "boolean") continue;
      if (!this.visibilitySnapshots.has(resource)) this.visibilitySnapshots.set(resource, resource.show);
      desired.set(resource, false);
    }
    const current = this.importIndex(imports), occlusion = this.occlusionStatus(current);
    for (const [id, entry] of this.entries) {
      desired.set(entry.target, this.visible && this.available(entry, current)
        && (id === occlusion.sourceId ? !occlusion.error : this.selected.has(id) && this.opacityStates.get(id)?.visible !== false));
    }
    let changed = false;
    for (const [resource, show] of desired) changed = setShow(resource, show) || changed;
    if (changed || forceRender) this.options.viewer.scene.requestRender();
  }

  /** A patch of absolute per-object offsets, not incremental deltas. Omitted objects retain their offsets. */
  applyAdjustments(values: Record<string, Partial<VideoOverlayAdjustment>>): void {
    this.throwIfCancelled();
    const normalized = Object.entries(values).map(([id, value]) => [id, normalizedAdjustment({ ...this.adjustments.get(id), ...value })] as const);
    for (const [id, adjustment] of normalized) {
      if (id === this.occlusion?.sourceId && Object.values(adjustment).some(value => value !== 0)) {
        throw new Error('地表遮挡源使用原地图定位，不能同时进行对象位置微调');
      }
    }
    const current = this.importIndex();
    let changed = false;
    for (const [id, adjustment] of normalized) {
      const entry = this.entries.get(id);
      if (!entry || !this.available(entry, current) || !entry.center
        || sameAdjustment(this.adjustments.get(id), adjustment)) continue;
      // A source's exact map matrix is also its depth reference. Never replace
      // it with the numerically approximate ENU * inverse(ENU) for a zero edit.
      if (id === this.occlusion?.sourceId) continue;
      const unchanged = Object.values(adjustment).every(value => value === 0);
      const transform = unchanged ? Matrix4.IDENTITY : videoOverlayAdjustmentMatrix(entry.center, adjustment);
      entry.transformed = true;
      for (const binding of entry.matrices) {
        const next = unchanged ? binding.original : Matrix4.multiply(transform, binding.original, new Matrix4());
        if (alive(binding.resource) && !Matrix4.equals(binding.resource.modelMatrix, next)) {
          binding.resource.modelMatrix = Matrix4.clone(next);
        }
      }
      entry.dataSource?.entities.suspendEvents();
      try { for (const binding of entry.positions) { if (unchanged) binding.restore(); else binding.apply(transform); } }
      finally { entry.dataSource?.entities.resumeEvents(); }
      entry.transformed = !unchanged;
      this.adjustments.set(id, adjustment);
      changed = true;
    }
    if (changed) this.options.viewer.scene.requestRender();
  }

  getAdjustments(): Record<string, VideoOverlayAdjustment> {
    return Object.fromEntries([...this.adjustments].map(([id, value]) => [id, { ...value }]));
  }

  private disposeCopy(entry: Entry) {
    if (!entry.copy) return;
    const copy = entry.copy;
    entry.copy = undefined;
    try {
      if (!copy.isDestroyed()) this.options.viewer.scene.primitives.remove(copy);
    } catch { /* The host may already have disposed the viewer. */ }
    finally {
      // A non-owning root (or a failing host removal) must not retain AR buffers.
      try { if (!copy.isDestroyed()) copy.destroy(); } catch { /* Already disposed by a host. */ }
    }
  }

  /** Idempotent, including cancellation during a ground-CAD rebuild. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try { this.controller.abort(); } catch { /* Continue independent releases. */ }
    try { this.removeAbortListener?.(); } catch { /* Continue independent releases. */ }
    this.removeAbortListener = undefined;
    try { this.occlusion?.restore(); } catch { /* Continue independent releases. */ }
    this.occlusion = undefined;
    for (const coverage of this.tileCoverage.values()) {
      try { coverage.restore(); } catch { /* Another owner must still be released. */ }
    }
    this.tileCoverage.clear();
    for (const entry of this.entries.values()) {
      this.restoreOpacity(entry);
      if (entry.transformed && !entry.copy && alive(entry.original)) {
        for (const binding of entry.matrices) {
          try {
            if (alive(binding.resource) && !Matrix4.equals(binding.resource.modelMatrix, binding.original)) {
              binding.resource.modelMatrix = Matrix4.clone(binding.original);
            }
          } catch { /* A removed resource must not retain other AR owners. */ }
        }
        try { entry.dataSource?.entities.suspendEvents(); } catch { /* Continue property restore. */ }
        for (const binding of entry.positions) {
          try { binding.restore(); } catch { /* Restore the remaining entity properties. */ }
        }
        try { entry.dataSource?.entities.resumeEvents(); } catch { /* Continue disposal. */ }
      }
      this.disposeCopy(entry);
    }
    for (const [resource, show] of this.visibilitySnapshots) {
      try { setShow(resource, show); } catch { /* Other map layers still need restoration. */ }
    }
    for (const source of this.touchedTiles) {
      try { if (!source.isDestroyed()) source.trimLoadedTiles(); } catch { /* A host disposal may already be underway. */ }
    }
    this.touchedTiles.clear();
    this.selected.clear();
    this.opacityStates.clear(); this.adjustments.clear();
    this.visibilitySnapshots.clear(); this.entries.clear();
    try { this.options.viewer.scene.requestRender(); } catch { /* Viewer may already be destroyed. */ }
  }
}
