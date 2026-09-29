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
  Scene,
  Transforms,
} from "cesium";
import proj4 from "proj4";
import type { CadImportEntity, CadImportPackage, CadPoint } from "./cadImport";
import { createGaussKrugerToWgs84Converter } from "./coordinateUtils";
import type { CadCoordinateOptions, CadDisplayMode } from "./types";

type PositionConverter = (point: CadPoint) => Cartesian3;

const CAD_COLOR = Color.fromCssColorString("#32d6ff");

function entityColor(entity: CadImportEntity): Color {
  return entity.color ? Color.fromCssColorString(entity.color) ?? CAD_COLOR : CAD_COLOR;
}

function entityWidth(entity: CadImportEntity): number {
  return Math.max(1, Math.min(10, (entity.lineweightMm ?? 0.25) * 5));
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
  const width = entityWidth(entity);
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

  if (points[0]) {
    const position = safelyConvert(points[0], convert);
    if (!position) return;
    dataSource.entities.add({
      id,
      name,
      position,
      point: {
        pixelSize: Math.max(5, width + 4),
        color,
        outlineColor: Color.WHITE,
        outlineWidth: 1,
        heightReference: displayMode === "absolute" ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: displayMode === "absolute" ? 0 : Number.POSITIVE_INFINITY,
      },
    });
  }
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
  if (!dataSource.entities.values.length) throw new Error("CAD 已解析，但没有生成可显示对象");
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

/** Writes sampled scene heights back to CAD geometry, including ordinary GLB models. */
export async function clampCadToScene(dataSource: CustomDataSource, scene: Scene, maximumPoints = 2000, signal?: AbortSignal): Promise<CadClampResult> {
  if (!scene.clampToHeightSupported) return { clamped: 0, skipped: 0 };
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
      bindings.push({ source: hierarchy.positions, apply: (clamped) => { entity.polygon!.hierarchy = new ConstantProperty(new PolygonHierarchy(clamped)); } });
    }
  }

  let clampedCount = 0;
  let sampledCount = 0;
  let skippedCount = 0;
  for (const binding of bindings) {
    if (signal?.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
    if (sampledCount + binding.source.length > maximumPoints) {
      skippedCount += binding.source.length;
      continue;
    }
    const output: Cartesian3[] = [];
    for (let offset = 0; offset < binding.source.length; offset += 200) {
      if (signal?.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
      const sourceChunk = binding.source.slice(offset, offset + 200).map((position) => Cartesian3.clone(position));
      const clampedChunk = await scene.clampToHeightMostDetailed(sourceChunk, [], 0.5);
      clampedChunk.forEach((position, index) => {
        output.push(position ?? sourceChunk[index]);
        if (position) clampedCount += 1;
      });
      sampledCount += sourceChunk.length;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    binding.apply(output);
  }
  return { clamped: clampedCount, skipped: skippedCount };
}
