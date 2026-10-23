import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  CustomDataSource,
  ClassificationType,
  DistanceDisplayCondition,
  HeightReference,
  JulianDate,
  LabelStyle,
  Matrix4,
  NearFarScalar,
  PolygonHierarchy,
  PrimitiveCollection,
  Scene,
  Transforms,
} from "cesium";
import proj4 from "proj4";
import { cadLineWidth } from "./cadDisplayStyle.ts";
import type { CadImportEntity, CadImportPackage, CadPoint } from "./cadImport";
import { createGaussKrugerToWgs84Converter } from "./coordinateUtils.ts";
import type { CadCoordinateOptions, CadDisplayMode, ImportRecord } from "./types";

type PositionConverter = (point: CadPoint) => Cartesian3;

const CAD_COLOR = Color.fromCssColorString("#32d6ff");

function entityColor(entity: CadImportEntity): Color {
  return entity.color ? Color.fromCssColorString(entity.color) ?? CAD_COLOR : CAD_COLOR;
}

function isFinitePosition(position: Cartesian3 | undefined): position is Cartesian3 {
  return !!position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

function safelyConvert(point: CadPoint | undefined, convert: PositionConverter): Cartesian3 | undefined {
  if (!point) return undefined;
  try {
    const position = convert(point);
    return isFinitePosition(position) ? position : undefined;
  } catch {
    return undefined;
  }
}

function safelyConvertAll(points: CadPoint[], convert: PositionConverter): Cartesian3[] {
  const converted = points.map((value) => safelyConvert(value, convert));
  // Never remove a bad middle point and reconnect both sides of the gap.
  return converted.every(isFinitePosition) ? converted : [];
}

function createConverter(options: CadCoordinateOptions): PositionConverter {
  if (options.mode === "gaussKruger") {
    const toWgs84 = createGaussKrugerToWgs84Converter(options);
    return ({ x, y, z = 0 }) => {
      const [longitude, latitude] = toWgs84(x, y);
      return Cartesian3.fromDegrees(longitude, latitude, z + options.heightOffset);
    };
  }

  if (options.mode === "crs") {
    const source = options.sourceCrs.trim() || "EPSG:4326";
    return ({ x, y, z = 0 }) => {
      let longitude = x;
      let latitude = y;
      if (source.toUpperCase() !== "EPSG:4326" && source.toUpperCase() !== "WGS84") {
        [longitude, latitude] = proj4(source, "EPSG:4326", [x, y]);
      }
      return Cartesian3.fromDegrees(longitude, latitude, z + options.heightOffset);
    };
  }

  const origin = Cartesian3.fromDegrees(options.longitude, options.latitude, options.altitude);
  const enu = Transforms.eastNorthUpToFixedFrame(origin);
  const radians = (options.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return ({ x, y, z = 0 }) => {
    const localX = x - options.referenceX;
    const localY = y - options.referenceY;
    const east = (localX * cos - localY * sin) * options.scale;
    const north = (localX * sin + localY * cos) * options.scale;
    return Matrix4.multiplyByPoint(enu, new Cartesian3(east, north, z * options.scale), new Cartesian3());
  };
}

function addEntity(dataSource: CustomDataSource, entity: CadImportEntity, convert: PositionConverter, index: number, displayMode: CadDisplayMode) {
  const points = entity.vertices;
  const color = entityColor(entity);
  const width = cadLineWidth(entity);
  const name = `${entity.layer || "未分层"} · ${entity.sourceType}`;
  const id = `${entity.type}-${index}`;

  if (entity.type === "POLYLINE" && points.length > 1) {
    const linePoints = entity.closed ? [...points, points[0]] : points;
    const positions = safelyConvertAll(linePoints, convert);
    if (positions.length < 2) return;
    dataSource.entities.add({
      id,
      name,
      description: `<p>图层：${entity.layer || "未分层"}</p><p>类型：${entity.sourceType}</p>`,
      polyline: {
        positions,
        width,
        material: color,
        clampToGround: displayMode !== "absolute",
        classificationType: displayMode === "model" ? ClassificationType.CESIUM_3D_TILE : ClassificationType.TERRAIN,
        zIndex: displayMode === "absolute" ? undefined : 10,
      },
    });
    return;
  }

  if (entity.type === "3DFACE" && points.length >= 3) {
    const positions = safelyConvertAll(points, convert);
    if (positions.length < 3) return;
    dataSource.entities.add({
      id,
      name,
      polygon: {
        hierarchy: positions,
        material: color.withAlpha(0.18),
        outline: entity.sourceType === "3DFACE",
        outlineColor: color,
        perPositionHeight: displayMode === "absolute",
        // A polygon with an explicit height reference creates a
        // TerrainOffsetProperty. Large DWGs frequently contain very thin or
        // repeated 3DFACEs whose computed center is undefined/NaN, which can
        // stop Cesium's entire render loop. Leaving both values undefined
        // selects Cesium's native GroundPrimitive/classification path.
        height: undefined,
        heightReference: displayMode === "absolute" ? HeightReference.NONE : undefined,
        classificationType: displayMode === "model" ? ClassificationType.CESIUM_3D_TILE : ClassificationType.TERRAIN,
      },
    });
    return;
  }

  if (entity.type === "TEXT" && points[0]) {
    const position = safelyConvert(points[0], convert);
    if (!position) return;
    dataSource.entities.add({
      id,
      name,
      position,
      label: {
        text: entity.text || "",
        font: `${Math.max(13, Math.min(28, (entity.textHeight || 2.5) * 4))}px sans-serif`,
        fillColor: color,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -8),
        scaleByDistance: new NearFarScalar(100, 1, 500_000, 0.2),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000),
        heightReference: displayMode === "absolute" ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: displayMode === "absolute" ? 0 : Number.POSITIVE_INFINITY,
      },
    });
    return;
  }

  // POINT remains in the source package without a display object. Likewise,
  // unknown entities or invalid line/face geometry must not become dots.
}

export async function loadCadImport(
  value: CadImportPackage,
  options: CadCoordinateOptions,
  displayMode: CadDisplayMode = "absolute",
  onProgress?: (completed: number, total: number) => void,
  beforePopulate?: (dataSource: CustomDataSource) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<CustomDataSource> {
  if (!value.entities.length) throw new Error("导入文件中没有可显示的 CAD 几何");
  const dataSource = new CustomDataSource(value.source.name);
  const convert = createConverter(options);
  await beforePopulate?.(dataSource);
  const batchSize = 500;
  for (let offset = 0; offset < value.entities.length; offset += batchSize) {
    if (signal?.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
    dataSource.entities.suspendEvents();
    try {
      const end = Math.min(offset + batchSize, value.entities.length);
      for (let index = offset; index < end; index += 1) {
        addEntity(dataSource, value.entities[index], convert, index, displayMode);
      }
    } finally {
      dataSource.entities.resumeEvents();
    }
    const completed = Math.min(offset + batchSize, value.entities.length);
    onProgress?.(completed, value.entities.length);
    // When the data source is already attached, let Cesium consume this batch
    // before enqueueing the next one. This avoids a single 40k-entity update.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  onProgress?.(value.entities.length, value.entities.length);
  if (!dataSource.entities.values.length && !value.entities.every((entity) => entity.type === "POINT")) {
    throw new Error("CAD 已解析，但没有生成可显示对象");
  }
  return dataSource;
}

/** Computes a stable camera target without asking Cesium to clone pending ground geometry bounds. */
export function getCadBoundingSphere(dataSource: CustomDataSource): BoundingSphere | undefined {
  const time = JulianDate.now();
  let minimum: Cartesian3 | undefined;
  let maximum: Cartesian3 | undefined;
  const include = (position: Cartesian3 | undefined) => {
    if (!isFinitePosition(position)) return;
    if (!minimum || !maximum) {
      minimum = Cartesian3.clone(position);
      maximum = Cartesian3.clone(position);
      return;
    }
    Cartesian3.minimumByComponent(minimum, position, minimum);
    Cartesian3.maximumByComponent(maximum, position, maximum);
  };
  for (const entity of dataSource.entities.values) {
    const position = entity.position?.getValue(time);
    include(position);

    const linePositions = entity.polyline?.positions?.getValue(time);
    if (linePositions) linePositions.forEach(include);

    const hierarchy = entity.polygon?.hierarchy?.getValue(time);
    if (hierarchy?.positions) hierarchy.positions.forEach(include);
  }
  return minimum && maximum ? BoundingSphere.fromCornerPoints(minimum, maximum) : undefined;
}

/** After explicit GLB surface sampling, keep the sampled absolute heights. */
export function useSampledCadHeights(dataSource: CustomDataSource) {
  for (const entity of dataSource.entities.values) {
    if (entity.polyline) {
      entity.polyline.clampToGround = new ConstantProperty(false);
      entity.polyline.classificationType = undefined;
    }
    if (entity.polygon) {
      entity.polygon.perPositionHeight = new ConstantProperty(true);
      entity.polygon.height = undefined;
      entity.polygon.heightReference = new ConstantProperty(HeightReference.NONE);
      entity.polygon.classificationType = undefined;
    }
    if (entity.label) entity.label.heightReference = new ConstantProperty(HeightReference.NONE);
    if (entity.point) entity.point.heightReference = new ConstantProperty(HeightReference.NONE);
  }
}

type ClampBinding = { source: Cartesian3[]; apply: (positions: Cartesian3[]) => void };
export type CadClampResult = { clamped: number; skipped: number };
export type CadHeightSamplingOptions = { batchSize?: number; signal?: AbortSignal };
export type CadSceneSamplingOptions = CadHeightSamplingOptions & { objectsToExclude?: object[]; modelsOnly?: boolean };
type CadHeightSampler = (positions: Cartesian3[]) => Promise<(Cartesian3 | undefined)[]>;

function checkSamplingCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
}

async function awaitCadSample(promise: ReturnType<CadHeightSampler>, signal?: AbortSignal) {
  if (!signal) return promise;
  return new Promise<Awaited<ReturnType<CadHeightSampler>>>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(new DOMException("CAD 加载已取消", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Samples every vertex in bounded batches, and writes nothing unless every sample succeeds. */
export async function sampleCadHeights(dataSource: CustomDataSource, sample: CadHeightSampler, options: CadHeightSamplingOptions = {}): Promise<CadClampResult> {
  const { signal } = options;
  checkSamplingCancelled(signal);
  const batchSize = Math.min(200, Math.max(1, Math.floor(options.batchSize ?? 200)));
  if (!Number.isFinite(batchSize)) throw new Error("CAD 高程采样批量大小无效");
  const time = dataSource.clock?.currentTime;
  const bindings: ClampBinding[] = [];
  for (const entity of dataSource.entities.values) {
    const position = entity.position?.getValue(time);
    if (position) {
      bindings.push({ source: [position], apply: ([clamped]) => { if (clamped) entity.position = new ConstantPositionProperty(clamped); } });
    }
    const linePositions = entity.polyline?.positions?.getValue(time);
    if (linePositions?.length) {
      bindings.push({ source: linePositions, apply: (clamped) => { entity.polyline!.positions = new ConstantProperty(clamped); } });
    }
    const hierarchy = entity.polygon?.hierarchy?.getValue(time);
    if (hierarchy?.positions?.length) {
      const source: Cartesian3[] = [];
      const collect = (ring: PolygonHierarchy) => {
        for (const position of ring.positions) source.push(position);
        for (const hole of ring.holes ?? []) collect(hole);
      };
      collect(hierarchy);
      bindings.push({ source, apply: (clamped) => {
        let offset = 0;
        const rebuild = (ring: PolygonHierarchy): PolygonHierarchy => {
          const positions = clamped.slice(offset, offset + ring.positions.length);
          offset += ring.positions.length;
          return new PolygonHierarchy(positions, (ring.holes ?? []).map(rebuild));
        };
        entity.polygon!.hierarchy = new ConstantProperty(rebuild(hierarchy));
      } });
    }
  }

  let clampedCount = 0;
  const sampled: Cartesian3[][] = [];
  for (const binding of bindings) {
    const output: Cartesian3[] = [];
    for (let offset = 0; offset < binding.source.length; offset += batchSize) {
      checkSamplingCancelled(signal);
      const sourceChunk = binding.source.slice(offset, offset + batchSize).map((position) => Cartesian3.clone(position));
      const clampedChunk = await awaitCadSample(sample(sourceChunk), signal);
      checkSamplingCancelled(signal);
      if (clampedChunk.length !== sourceChunk.length || sourceChunk.some((_, index) => !isFinitePosition(clampedChunk[index]))) {
        throw new Error("CAD 存在未能依附到表面的顶点，已停止加载；请检查模型覆盖范围和定位后重试");
      }
      for (const position of clampedChunk) output.push(Cartesian3.clone(position!));
      clampedCount += clampedChunk.length;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    sampled.push(output);
  }
  checkSamplingCancelled(signal);
  bindings.forEach((binding, index) => binding.apply(sampled[index]));
  return { clamped: clampedCount, skipped: 0 };
}

/** Writes complete sampled scene heights back to CAD geometry, including ordinary GLB models. */
export async function clampCadToScene(dataSource: CustomDataSource, scene: Scene, options: CadSceneSamplingOptions = {}): Promise<CadClampResult> {
  checkSamplingCancelled(options.signal);
  if (!scene.clampToHeightSupported) throw new Error("当前浏览器不支持模型表面高程采样，无法完成 CAD 依附");
  // The newly attached CAD must never become its own sampling surface.
  const excluded = [...(options.objectsToExclude ?? []), ...dataSource.entities.values];
  // Globe depth is not always a pickable object, so objectsToExclude alone cannot
  // prevent a model coverage gap from silently falling back to terrain height.
  const globe = options.modelsOnly === false ? undefined : scene.globe;
  const globeShow = globe?.show;
  try {
    if (globe) globe.show = false;
    return await sampleCadHeights(dataSource, positions => scene.clampToHeightMostDetailed(positions, excluded, 0.5), options);
  } finally {
    if (globe && !globe.isDestroyed?.()) globe.show = globeShow!;
    scene.requestRender?.();
  }
}

/** Exclusion must contain leaf primitives / entities, not only their public collection. */
export function getCadModelSamplingExclusions(imports: readonly ImportRecord[]): object[] {
  const excluded = new Set<object>();
  const include = (value: unknown) => {
    if (!value || typeof value !== "object" || excluded.has(value)) return;
    excluded.add(value);
    if (value instanceof PrimitiveCollection) {
      for (let index = 0; index < value.length; index++) include(value.get(index));
    }
    const entities = (value as { entities?: { values?: unknown[] } }).entities?.values;
    if (Array.isArray(entities)) for (const entity of entities) include(entity);
  };
  for (const record of imports) {
    if (record.kind !== "Model" && record.kind !== "3D Tiles") include(record.resource);
  }
  return [...excluded];
}
