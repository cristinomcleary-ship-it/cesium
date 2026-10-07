import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, Matrix4, type Cesium3DTileset, type Viewer } from "cesium";
import type { ModelRegistryEntry, ModelSurfaceAnchor } from "./safetySpatialTypes.ts";
import type { SafetyPosition } from "./safetyTypes.ts";

export type RegisteredPhotogrammetry = ModelRegistryEntry & {
  tileset: Cesium3DTileset;
  /** The verified effective transform, including the import's coordinate offsets. */
  effectiveMatrix?: readonly number[];
};
export type SurfacePickFailure = "unsupported" | "no-model-hit" | "model-loading" | "overlay-hit" | "invalid-depth" | "model-version-unavailable";
export type SurfacePickResult = { ok: true; position: SafetyPosition; anchor: ModelSurfaceAnchor }
  | { ok: false; reason: SurfacePickFailure };

type Visibility = { show: boolean; isDestroyed?: boolean | (() => boolean) };
type Collection = { length: number; get(index: number): unknown };
const collection = (item: unknown): item is Collection => !!item && typeof (item as Collection).length === "number" && typeof (item as Collection).get === "function";
const visibility = (item: unknown): item is Visibility => !!item && typeof (item as Visibility).show === "boolean";
const finiteCartesian = (p?: Cartesian3): p is Cartesian3 => !!p && [p.x, p.y, p.z].every(Number.isFinite);

export function modelTransformMatches(model: RegisteredPhotogrammetry): boolean {
  const expected = model.effectiveMatrix ?? model.matrix;
  return expected.length === 16 && expected.every(Number.isFinite)
    && Matrix4.equalsEpsilon(model.tileset.modelMatrix, Matrix4.fromArray([...expected]), 1e-8);
}

function modelHit(hit: unknown, models: readonly RegisteredPhotogrammetry[]): RegisteredPhotogrammetry | undefined {
  if (!hit || typeof hit !== "object") return;
  // These are public pick/feature associations. A matching id string alone is not evidence.
  const item = hit as { primitive?: unknown; tileset?: unknown; content?: { tileset?: unknown } };
  return models.find(m => item.primitive === m.tileset || item.tileset === m.tileset || item.content?.tileset === m.tileset);
}

/**
 * Read a fresh opaque depth buffer containing only approved photogrammetry.
 * No ray/terrain/ellipsoid fallback is allowed. Temporary public visibility flags
 * are restored even if rendering fails; saved records and model matrices are never mutated.
 */
export function strictModelSurfacePick(
  viewer: Viewer, screen: Cartesian2, registry: readonly RegisteredPhotogrammetry[],
  suspendOverlays: () => () => void = () => () => {}, projectId?: string,
): SurfacePickResult {
  const scene = viewer.scene;
  if (!scene.pickPositionSupported) return { ok: false, reason: "unsupported" };
  if (![screen.x, screen.y].every(Number.isFinite) || screen.x < 0 || screen.y < 0
    || screen.x >= viewer.canvas.clientWidth || screen.y >= viewer.canvas.clientHeight) return { ok: false, reason: "no-model-hit" };
  const candidates = registry.filter(m => m.kind === "photogrammetry" && (!projectId || m.projectId === projectId)
    && !!m.assetId && !!m.assetVersion && !!m.coordinateTransformVersion && !m.tileset.isDestroyed() && m.tileset.show);
  const models = candidates.filter(modelTransformMatches);
  if (!models.length) return { ok: false, reason: candidates.length ? "model-version-unavailable" : "no-model-hit" };
  const allowed = new Set(models.map(m => m.tileset));
  const restores: Array<() => void> = [];
  const visited = new Set<unknown>();
  const hide = (object: Visibility) => {
    const old = object.show;
    if (!old) return;
    object.show = false;
    restores.push(() => {
      const destroyed = typeof object.isDestroyed === "function" ? object.isDestroyed() : object.isDestroyed === true;
      if (!destroyed) object.show = old;
    });
  };
  const isolate = (object: unknown): boolean => {
    if (allowed.has(object as Cesium3DTileset)) return true;
    if (visited.has(object)) return false;
    visited.add(object);
    let hasAllowed = false;
    if (collection(object)) for (let i = 0; i < object.length; i++) hasAllowed = isolate(object.get(i)) || hasAllowed;
    if (!hasAllowed && visibility(object)) hide(object);
    return hasAllowed;
  };
  const translucentDepth = scene.pickTranslucentDepth;
  let restoreOverlays: (() => void) | undefined;
  try {
    restoreOverlays = suspendOverlays();
    scene.pickTranslucentDepth = false;
    hide(viewer.entities);
    for (let i = 0; i < viewer.dataSources.length; i++) hide(viewer.dataSources.get(i));
    if (scene.globe) hide(scene.globe);
    isolate(scene.primitives); isolate(scene.groundPrimitives);
    // Public render is intentional: existing saved fills/handles cannot contaminate the depth.
    viewer.render();
    const first = modelHit(scene.pick(screen, 1, 1), models);
    if (!first) return { ok: false, reason: models.some(m => !m.tileset.tilesLoaded) ? "model-loading" : "no-model-hit" };
    // With several approved assets, also isolate the exact front-most asset. This
    // prevents a depth hit on a different asset from being assigned the first id.
    if (models.length > 1) {
      for (const model of models) if (model !== first) hide(model.tileset);
      viewer.render();
    }
    if (modelHit(scene.pick(screen, 1, 1), [first]) !== first) return { ok: false, reason: "overlay-hit" };
    const world = scene.pickPosition(screen);
    if (!finiteCartesian(world)) return { ok: false, reason: "invalid-depth" };
    const projected = scene.cartesianToCanvasCoordinates(world);
    if (!projected || Cartesian2.distance(projected, screen) > 1.5) return { ok: false, reason: "invalid-depth" };
    if (!modelTransformMatches(first)) return { ok: false, reason: "model-version-unavailable" };
    const geographic = Cartographic.fromCartesian(world);
    if (!geographic || ![geographic.longitude, geographic.latitude, geographic.height].every(Number.isFinite)) return { ok: false, reason: "invalid-depth" };
    return { ok: true,
      position: { longitude: CesiumMath.toDegrees(geographic.longitude), latitude: CesiumMath.toDegrees(geographic.latitude), height: geographic.height },
      anchor: { position: { space: "ecef-meters", x: world.x, y: world.y, z: world.z },
        model: { assetId: first.assetId, assetVersion: first.assetVersion, coordinateTransformVersion: first.coordinateTransformVersion },
        provenance: "verified-project-photogrammetry-surface", pickedAt: new Date().toISOString() },
    };
  } catch {
    return { ok: false, reason: "invalid-depth" };
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]();
    scene.pickTranslucentDepth = translucentDepth;
    restoreOverlays?.();
    scene.requestRender();
  }
}
