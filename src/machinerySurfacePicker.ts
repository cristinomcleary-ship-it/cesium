import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, type Viewer } from 'cesium';
import type { MachineryPlacementPick } from './machineryScene';

type VisibleObject = { show: boolean; isDestroyed?: boolean | (() => boolean) };
type Collection = { length: number; get(index: number): unknown };
export type MachinerySurface = {
  /** Project-visible imported 3D Tiles are the photogrammetry ground priority. */
  kind: 'photogrammetry' | 'model';
  resource: VisibleObject;
  visible: boolean;
};
const isCollection = (item: unknown): item is Collection => !!item && typeof (item as Collection).length === 'number' && typeof (item as Collection).get === 'function';
const hasVisibility = (item: unknown): item is VisibleObject => !!item && typeof (item as VisibleObject).show === 'boolean';
const isDestroyed = (item: VisibleObject) => typeof item.isDestroyed === 'function' ? item.isDestroyed() : item.isDestroyed === true;
function identifies(hit: unknown, resource: VisibleObject): boolean {
  if (!hit || typeof hit !== 'object') return false;
  const picked = hit as { primitive?: unknown; tileset?: unknown; content?: { tileset?: unknown } };
  const primitive = picked.primitive as { tileset?: unknown } | undefined;
  return picked.primitive === resource || picked.tileset === resource || picked.content?.tileset === resource || primitive?.tileset === resource;
}

/**
 * Mechanical station picking only: a fresh photogrammetry-only depth pass first,
 * then an imported engineering model pass. The caller owns terrain/ellipsoid fallback.
 * In particular, a crane, risk envelope, CAD fill or BIM overlay cannot mask the
 * photogrammetry surface and silently supply its own higher elevation.
 */
export function pickMachinerySurface(viewer: Viewer, screen: Cartesian2, surfaces: readonly MachinerySurface[]): MachineryPlacementPick | undefined {
  const scene = viewer.scene;
  if (!scene.pickPositionSupported || ![screen.x, screen.y].every(Number.isFinite)
    || screen.x < 0 || screen.y < 0 || screen.x >= viewer.canvas.clientWidth || screen.y >= viewer.canvas.clientHeight) return;
  const candidates = surfaces.filter(item => item.visible && item.resource.show && !isDestroyed(item.resource));
  for (const kind of ['photogrammetry', 'model'] as const) {
    const targets = candidates.filter(item => item.kind === kind);
    if (!targets.length) continue;
    const allowed = new Set(targets.map(item => item.resource));
    const restores: Array<() => void> = [];
    const visited = new Set<unknown>();
    const hide = (item: VisibleObject) => {
      const shown = item.show;
      if (!shown) return;
      item.show = false;
      restores.push(() => { if (!isDestroyed(item)) item.show = shown; });
    };
    const isolate = (item: unknown): boolean => {
      if (allowed.has(item as VisibleObject)) return true;
      if (visited.has(item)) return false;
      visited.add(item);
      let permittedChild = false;
      if (isCollection(item)) for (let index = 0; index < item.length; index++) permittedChild = isolate(item.get(index)) || permittedChild;
      if (!permittedChild && hasVisibility(item)) hide(item);
      return permittedChild;
    };
    const translucentDepth = scene.pickTranslucentDepth;
    try {
      scene.pickTranslucentDepth = false;
      hide(viewer.entities);
      for (let index = 0; index < viewer.dataSources.length; index++) hide(viewer.dataSources.get(index));
      if (scene.globe) hide(scene.globe);
      isolate(scene.primitives); isolate(scene.groundPrimitives);
      viewer.render();
      const picked = scene.pick(screen, 1, 1);
      const target = targets.find(item => identifies(picked, item.resource));
      if (!target) continue;
      // Keep feature identity and depth on the same exact imported asset.
      if (targets.length > 1) {
        for (const item of targets) if (item !== target) hide(item.resource);
        viewer.render();
      }
      if (!identifies(scene.pick(screen, 1, 1), target.resource)) continue;
      const world = scene.pickPosition(screen) as Cartesian3 | undefined;
      if (!world || ![world.x, world.y, world.z].every(Number.isFinite)) continue;
      const projected = scene.cartesianToCanvasCoordinates(world);
      if (!projected || Cartesian2.distance(screen, projected) > 1.5) continue;
      const location = Cartographic.fromCartesian(world);
      if (!location || ![location.longitude, location.latitude, location.height].every(Number.isFinite)) continue;
      return { longitude: CesiumMath.toDegrees(location.longitude), latitude: CesiumMath.toDegrees(location.latitude), height: location.height,
        source: 'model', modelKind: kind };
    } catch {
      // One missing/not-ready model depth pass must not prevent labelled fallback.
    } finally {
      for (let index = restores.length - 1; index >= 0; index--) restores[index]();
      scene.pickTranslucentDepth = translucentDepth;
      scene.requestRender();
    }
  }
  return undefined;
}


type PlacementPicker = (screen: Cartesian2) => MachineryPlacementPick | undefined;
/** Both UI entry points share mechanical surface priority; old host fallbacks remain scoped. */
export function pickPreferredMachineryPlacement(screen: Cartesian2, options: {
  active: boolean; preferred?: PlacementPicker; workbench?: PlacementPicker; management?: PlacementPicker;
}): MachineryPlacementPick | undefined {
  const preferred = options.preferred?.(screen);
  if (preferred) return preferred;
  return options.active ? options.management?.(screen) : options.workbench?.(screen);
}
