import {
  ArcType,
  BlendOption,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  ClassificationType,
  Color,
  ColorGeometryInstanceAttribute,
  DistanceDisplayCondition,
  GeometryInstance,
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  HeightReference,
  LabelCollection,
  LabelStyle,
  Matrix4,
  NearFarScalar,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolylineColorAppearance,
  PolylineGeometry,
  Primitive,
  PrimitiveCollection,
  type Scene,
  Transforms,
} from "cesium";
import proj4 from "proj4";
import { cadLineWidth, createCadPolylineAppearance } from "./cadDisplayStyle.ts";
import { cadSpatialBatchKey, CadSpatialBatcher } from "./cadSpatialBatcher.ts";
import { createCadGeometryScheduler } from "./cadGeometryScheduler.ts";
import type { CadImportEntity, CadImportPackage, CadPoint } from "./cadImport";
import { createGaussKrugerToWgs84Converter } from "./coordinateUtils.ts";
import type { CadCoordinateOptions, CadDisplayMode } from "./types";

type PositionConverter = (point: CadPoint) => Cartesian3;

export type CadPrimitiveFeatureId = {
  id: string;
  name: string;
  layer: string;
  sourceType: string;
  type: CadImportEntity["type"];
  entityIndex: number;
  /** Render fragments retain one logical feature and use distinct Cesium pick/attribute IDs. */
  featureId?: string;
  renderPart?: number;
};

/** Lightweight collision data retained after GPU geometry instances are released. */
export type CadPolylineFeature = {
  layer: string;
  name: string;
  sourceType: string;
  positions: Cartesian3[];
  entity: CadPrimitiveFeatureId;
};

export type CadPrimitiveCollection = PrimitiveCollection & {
  readonly cadName: string;
  readonly cadPolylineFeatures: CadPolylineFeature[];
  /** Actual face vertices remain available for local editing pivots after GPU upload. */
  readonly cadFacePositions: Cartesian3[][];
  readonly cadFeatureCount: number;
};

export type CadPrimitiveLoadOptions = {
  displayMode?: CadDisplayMode;
  /** Number of source entities handled before yielding to the browser. */
  batchSize?: number;
  /** Geometry instances compiled by one Cesium primitive. */
  primitiveBatchSize?: number;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
  /** Required by Cesium when labels clamp to terrain / 3D Tiles. */
  scene?: Scene;
  /** Lets the caller attach the empty collection early so batches can compile and release CPU geometry while loading continues. */
  beforePopulate?: (collection: PrimitiveCollection) => void | Promise<void>;
  /** AR compiles its temporary copy without displaying it over the normal map. */
  showWhileLoading?: boolean;
  /** Freeze a draped layer to sampled world positions before building absolute geometry.
   * Called in source batches; it must return one finite position for every input.
   */
  transformPositions?: (positions: Cartesian3[]) => Promise<Cartesian3[]>;
  /** Maximum world-space interval between samples along lines / face boundaries. */
  surfaceSampleSpacing?: number;
};

export type CadPrimitiveLoadResult = {
  collection: CadPrimitiveCollection;
  boundingSphere?: BoundingSphere;
  featureCount: number;
  skippedCount: number;
  cadPolylineFeatures: CadPolylineFeature[];
};

const DEFAULT_COLOR = Color.fromCssColorString("#32d6ff");
const FACE_ALPHA = 0.18;

/** Pinned Cesium worker packing: about 400 B/source point for absolute lines,
 * and 2656 B/source segment for ground lines, in addition to created geometry.
 * Keep each packed result in the low MiB range, even for one long source feature.
 */
export const CAD_PRIMITIVE_VERTEX_BUDGET = Object.freeze({ absolute: 8192, ground: 1024 });

function entityColor(entity: CadImportEntity): Color {
  return entity.color ? Color.fromCssColorString(entity.color) ?? DEFAULT_COLOR : DEFAULT_COLOR;
}

function isFinitePosition(position: Cartesian3 | undefined): position is Cartesian3 {
  return !!position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
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
  const frame = Transforms.eastNorthUpToFixedFrame(origin);
  const radians = options.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return ({ x, y, z = 0 }) => {
    const localX = x - options.referenceX;
    const localY = y - options.referenceY;
    const east = (localX * cos - localY * sin) * options.scale;
    const north = (localX * sin + localY * cos) * options.scale;
    return Matrix4.multiplyByPoint(frame, new Cartesian3(east, north, z * options.scale), new Cartesian3());
  };
}

/** Reject the whole run if one point is invalid; never bridge across corrupt CAD vertices. */
function convertPoints(points: CadPoint[], convert: PositionConverter): Cartesian3[] {
  const result: Cartesian3[] = [];
  for (const point of points) {
    let position: Cartesian3;
    try {
      position = convert(point);
    } catch {
      return [];
    }
    if (!isFinitePosition(position)) return [];
    const previous = result[result.length - 1];
    if (!previous || !Cartesian3.equalsEpsilon(previous, position, 1e-12, 1e-4)) result.push(position);
  }
  return result;
}

function closeLine(positions: Cartesian3[], closed: boolean): Cartesian3[] {
  if (!closed || positions.length < 3 || Cartesian3.equalsEpsilon(positions[0], positions[positions.length - 1], 1e-12, 1e-4)) return positions;
  return [...positions, Cartesian3.clone(positions[0])];
}

/** Preserve the rendered path between sparse CAD vertices when freezing a surface. */
function densifyPositions(positions: Cartesian3[], spacing: number): Cartesian3[] {
  if (positions.length < 2) return positions;
  const result = [positions[0]];
  for (let index = 1; index < positions.length; index++) {
    const from = positions[index - 1], to = positions[index];
    const segments = Math.max(1, Math.ceil(Cartesian3.distance(from, to) / spacing));
    if (result.length + segments > 250_000) throw new Error("CAD 单条线过长，表面高程采样超过 250000 点，请拆分图纸后再融合");
    for (let step = 1; step < segments; step++) result.push(Cartesian3.lerp(from, to, step / segments, new Cartesian3()));
    result.push(to);
  }
  return result;
}

function validFace(positions: Cartesian3[]): boolean {
  if (positions.length < 3) return false;
  const origin = positions[0];
  for (let index = 1; index < positions.length - 1; index += 1) {
    const left = Cartesian3.subtract(positions[index], origin, new Cartesian3());
    const right = Cartesian3.subtract(positions[index + 1], origin, new Cartesian3());
    if (Cartesian3.magnitudeSquared(Cartesian3.cross(left, right, new Cartesian3())) > 1e-8) return true;
  }
  return false;
}

function featureIdentity(entity: CadImportEntity, entityIndex: number): CadPrimitiveFeatureId {
  const layer = entity.layer || "未分层";
  return {
    id: `cad-${entityIndex}`,
    name: `${layer} · ${entity.sourceType}`,
    layer,
    sourceType: entity.sourceType,
    type: entity.type,
    entityIndex,
  };
}

function cleanCadText(value: string): string {
  return value
    .replace(/\\P/gi, "\n")
    .replace(/\\~/g, " ")
    .replace(/%%d/gi, "°")
    .replace(/%%p/gi, "±")
    .replace(/%%c/gi, "Ø")
    .replace(/\\[Ss]([^;\\]+)[#^]([^;\\]+);/g, "$1/$2")
    .replace(/\\[AaCcFfHhLlOoQqTtWw][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .trim();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
}

/**
 * Converts a CAD package to batched low-level Cesium primitives.
 *
 * Unlike one-Entity-per-object rendering, this keeps one visualizer out of the
 * hot path and releases GeometryInstances after Cesium uploads each batch.
 */
export async function loadCadPrimitiveCollection(
  value: CadImportPackage,
  coordinateOptions: CadCoordinateOptions,
  options: CadPrimitiveLoadOptions = {},
): Promise<CadPrimitiveLoadResult> {
  abortIfRequested(options.signal);
  if (!value.entities.length) throw new Error("导入文件中没有可显示的 CAD 几何");

  const displayMode = options.displayMode ?? "absolute";
  if (displayMode !== "absolute" && !options.scene) {
    throw new Error("贴地或依附模型加载 CAD 时需要传入 viewer.scene，以便文字正确贴附");
  }
  if (options.transformPositions && displayMode !== "absolute") throw new Error("表面高程采样后的 CAD 必须以绝对高程显示");
  const surfaceSpacing = options.surfaceSampleSpacing;
  if (surfaceSpacing !== undefined && (!Number.isFinite(surfaceSpacing) || surfaceSpacing <= 0)) throw new Error("CAD 表面采样间距必须为正数");
  const sourceBatchSize = Math.max(100, Math.floor(options.batchSize ?? 500));
  const primitiveBatchSize = Math.max(50, Math.floor(options.primitiveBatchSize ?? 600));
  const vertexBudget = displayMode === "absolute" ? CAD_PRIMITIVE_VERTEX_BUDGET.absolute : CAD_PRIMITIVE_VERTEX_BUDGET.ground;
  const classificationType = displayMode === "model" ? ClassificationType.CESIUM_3D_TILE : ClassificationType.TERRAIN;
  const convert = createConverter(coordinateOptions);
  const collection = new PrimitiveCollection({ destroyPrimitives: true });
  const scheduler = createCadGeometryScheduler({ scene: options.scene, collection, signal: options.signal,
    enabled: Boolean(options.scene && options.beforePopulate), showWhileLoading: options.showWhileLoading ?? true });
  try {
    if (options.beforePopulate) {
      await options.beforePopulate(collection);
    }
    const cadPolylineFeatures: CadPolylineFeature[] = [];
    const cadFacePositions: Cartesian3[][] = [];
    let minimum: Cartesian3 | undefined;
    let maximum: Cartesian3 | undefined;
    let featureCount = 0;
    let skippedCount = 0;

    let labels: LabelCollection | undefined;

    const heightReference = displayMode === "terrain"
      ? HeightReference.CLAMP_TO_TERRAIN
      : displayMode === "model"
        ? HeightReference.CLAMP_TO_3D_TILE
        : HeightReference.NONE;

    const labelCollection = () => labels ?? (labels = collection.add(new LabelCollection({
      scene: options.scene,
      blendOption: BlendOption.OPAQUE_AND_TRANSLUCENT,
    })));

    const include = (position: Cartesian3) => {
      if (!minimum || !maximum) {
        minimum = Cartesian3.clone(position);
        maximum = Cartesian3.clone(position);
        return;
      }
      Cartesian3.minimumByComponent(minimum, position, minimum);
      Cartesian3.maximumByComponent(maximum, position, maximum);
    };

    const lineBatches = new CadSpatialBatcher<GeometryInstance>({ maxBatchSize: primitiveBatchSize,
      maxBatchVertices: vertexBudget, maxBufferedVertices: vertexBudget * 4, emit: lineInstances => {
      if (displayMode === "absolute") {
        scheduler.add(new Primitive({
          geometryInstances: lineInstances,
          appearance: createCadPolylineAppearance(),
          asynchronous: true,
          releaseGeometryInstances: true,
          vertexCacheOptimize: true,
          compressVertices: true,
          allowPicking: true,
        }));
      } else {
        scheduler.add(new GroundPolylinePrimitive({
          geometryInstances: lineInstances,
          appearance: new PolylineColorAppearance({ translucent: false }),
          asynchronous: true,
          releaseGeometryInstances: true,
          classificationType,
          allowPicking: true,
        }));
      }
    } });

    const faceVertexCounts = new WeakMap<GeometryInstance, number>();
    const faceBatches = new CadSpatialBatcher<GeometryInstance>({
      maxBatchSize: Math.max(50, Math.floor(primitiveBatchSize / 2)),
      maxBatchVertices: vertexBudget, maxBufferedVertices: vertexBudget * 4,
      allowOversizedItem: true,
      emit: instances => {
        // Preserve indivisible polygon boundaries. An oversized face compiles
        // alone, without the allocations from another CAD batch in flight.
        const exclusive = instances.reduce((sum, instance) => sum + (faceVertexCounts.get(instance) ?? 0), 0) > vertexBudget;
        if (displayMode === "absolute") {
          scheduler.add(new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
            asynchronous: true,
            releaseGeometryInstances: true,
            vertexCacheOptimize: true,
            compressVertices: true,
            allowPicking: true,
          }), { exclusive });
          return;
        }
        // Ground/classification primitives require a uniform color on every
        // supported GPU, so different CAD colors are deliberately split here.
        scheduler.add(new GroundPrimitive({
          geometryInstances: instances,
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
          asynchronous: true,
          releaseGeometryInstances: true,
          vertexCacheOptimize: true,
          compressVertices: true,
          classificationType,
          allowPicking: true,
        }), { exclusive });
      },
    });

    const batchKey = (positions: Cartesian3[], partition?: string) =>
      cadSpatialBatchKey(BoundingSphere.fromPoints(positions).center, partition);

    const addLine = async (positions: Cartesian3[], width: number, color: Color, id: CadPrimitiveFeatureId) => {
      for (let start = 0, part = 0; start < positions.length - 1; part++) {
        abortIfRequested(options.signal);
        const end = Math.min(positions.length, start + vertexBudget);
        const fragment = positions.length <= vertexBudget ? positions : positions.slice(start, end);
        const renderId = positions.length <= vertexBudget ? id : { ...id, id: `${id.id}:render:${part}`, featureId: id.id, renderPart: part };
        const geometry = displayMode === "absolute"
          ? new PolylineGeometry({ positions: fragment, width, arcType: ArcType.NONE, vertexFormat: PolylineColorAppearance.VERTEX_FORMAT })
          : new GroundPolylineGeometry({ positions: fragment, width, granularity: 0, arcType: ArcType.GEODESIC });
        lineBatches.add(batchKey(fragment), new GeometryInstance({
          geometry, id: renderId,
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
        }), fragment.length);
        await scheduler.waitForCapacity();
        if (end === positions.length) break;
        // Two shared segments retain an interior join with both neighbours. They
        // are opaque with the same style/feature; no source segment is lost or bent.
        start = end - 3;
      }
    };

    const addFace = (positions: Cartesian3[], color: Color, id: CadPrimitiveFeatureId) => {
      const geometry = PolygonGeometry.fromPositions({
        positions,
        perPositionHeight: displayMode === "absolute",
        vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
      });
      const faceColor = color.withAlpha(FACE_ALPHA);
      const instance = new GeometryInstance({
        geometry,
        id,
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(faceColor) },
      });
      const partition = displayMode === "absolute" ? "" : faceColor.toCssHexString();
      faceVertexCounts.set(instance, positions.length);
      faceBatches.add(batchKey(positions, partition), instance, positions.length, partition);
    };

    let sampledBatch: Cartesian3[][] = [];
    let sampledStart = 0, sampledEnd = 0;
    let pendingSamplePoints: Cartesian3[] | undefined;
    for (let index = 0; index < value.entities.length; index += 1) {
      abortIfRequested(options.signal);
      if (options.transformPositions && index >= sampledEnd) {
        const batch: Cartesian3[][] = [];
        let pointCount = 0;
        sampledStart = sampledEnd = index;
        while (sampledEnd < value.entities.length && batch.length < sourceBatchSize) {
          abortIfRequested(options.signal);
          const entity = value.entities[sampledEnd];
          let points = pendingSamplePoints;
          pendingSamplePoints = undefined;
          if (!points) {
            points = entity.type === "POINT" ? [] : convertPoints(entity.vertices, convert);
            if (surfaceSpacing && (entity.type === "POLYLINE" || entity.type === "3DFACE")) {
              points = closeLine(points, entity.type === "3DFACE" || Boolean(entity.closed));
              points = densifyPositions(points, surfaceSpacing);
            }
          }
          if (batch.length && pointCount + points.length > CAD_PRIMITIVE_VERTEX_BUDGET.absolute) {
            pendingSamplePoints = points;
            break;
          }
          batch.push(points); pointCount += points.length; sampledEnd++;
          // A single long feature keeps its topology and is sampled alone. It is
          // subsequently split only for line rendering; faces retain their boundary.
          if (pointCount >= CAD_PRIMITIVE_VERTEX_BUDGET.absolute) break;
        }
        const flattened = batch.flat();
        const transformed = flattened.length ? await options.transformPositions(flattened) : [];
        abortIfRequested(options.signal);
        if (transformed.length !== flattened.length || transformed.some(point => !isFinitePosition(point))) {
          throw new Error("CAD 表面高程采样不完整，不能用图纸原始高程代替缺失结果");
        }
        let offset = 0;
        sampledBatch = batch.map(points => { const result = transformed.slice(offset, offset + points.length); offset += points.length; return result; });
      }
      const entity = value.entities[index];
      const id = featureIdentity(entity, index);
      const color = entityColor(entity);
      const width = cadLineWidth(entity);
      const converted = options.transformPositions ? sampledBatch[index - sampledStart] : convertPoints(entity.vertices, convert);

      if (entity.type === "POLYLINE") {
        const positions = closeLine(converted, Boolean(entity.closed));
        if (positions.length < 2) skippedCount += 1;
        else {
          positions.forEach(include);
          await addLine(positions, width, color, id);
          cadPolylineFeatures.push({ layer: id.layer, name: id.name, sourceType: id.sourceType, positions, entity: id });
          featureCount += 1;
        }
      } else if (entity.type === "3DFACE") {
        if (!validFace(converted)) skippedCount += 1;
        else {
          converted.forEach(include);
          addFace(converted, color, id);
          cadFacePositions.push(converted);
          if (entity.sourceType === "3DFACE") {
            await addLine(closeLine(converted, true), Math.max(1, Math.min(width, 2)), color, id);
          }
          featureCount += 1;
        }
      } else if (entity.type === "TEXT") {
        const position = converted[0];
        const text = cleanCadText(entity.text ?? "");
        if (!position || !text) skippedCount += 1;
        else {
          labelCollection().add({
            id,
            position,
            text,
            font: `${Math.max(13, Math.min(28, Math.round((entity.textHeight || 2.5) * 4)))}px sans-serif`,
            fillColor: color,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cartesian2(0, -8),
            scaleByDistance: new NearFarScalar(100, 1, 500_000, 0.2),
            distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000),
            heightReference,
            disableDepthTestDistance: displayMode === "absolute" ? 0 : Number.POSITIVE_INFINITY,
          });
          include(position);
          featureCount += 1;
        }
      } else if (entity.type !== "POINT") {
        // POINT is retained in the import package but intentionally has no
        // display object. Unknown entities must never become fallback dots.
        skippedCount += 1;
      }

      await scheduler.waitForCapacity();
      const completed = index + 1;
      if (completed % sourceBatchSize === 0) {
        options.onProgress?.(completed, value.entities.length);
        await nextFrame();
      }
    }

    lineBatches.flush();
    faceBatches.flush();
    await scheduler.finish();
    abortIfRequested(options.signal);
    options.onProgress?.(value.entities.length, value.entities.length);

    if (!featureCount && !value.entities.every((entity) => entity.type === "POINT")) {
      throw new Error("CAD 已解析，但没有生成可显示对象");
    }

    Object.defineProperties(collection, {
      cadName: { value: value.source.name, enumerable: true },
      cadPolylineFeatures: { value: cadPolylineFeatures, enumerable: false },
      cadFacePositions: { value: cadFacePositions, enumerable: false },
      cadFeatureCount: { value: featureCount, enumerable: true },
    });

    return {
      collection: collection as CadPrimitiveCollection,
      boundingSphere: minimum && maximum ? BoundingSphere.fromCornerPoints(minimum, maximum) : undefined,
      featureCount,
      skippedCount,
      cadPolylineFeatures,
    };
  } catch (error) {
    scheduler.dispose(error);
    // Unregister before destroying so the scene cannot update an orphan after
    // cancellation, a rejected sample, or a failed worker batch.
    try {
      const root = options.scene?.primitives;
      if (root && !root.isDestroyed() && root.contains(collection)) root.remove(collection);
    } finally {
      if (!collection.isDestroyed()) collection.destroy();
    }
    throw error;
  }
}

/** Short alias for callers migrating from the Entity-based loader. */
export const loadCadImportPrimitives = loadCadPrimitiveCollection;
