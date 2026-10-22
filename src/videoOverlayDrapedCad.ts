import {
  Cartesian3, Cartographic, Ellipsoid, EllipsoidTerrainProvider, PrimitiveCollection,
  sampleTerrainMostDetailed, type Viewer,
} from 'cesium';
import type { ImportRecord } from './types.ts';

type Visible = { show: boolean; isDestroyed?: () => boolean };
const valid = (value: Cartesian3 | undefined): value is Cartesian3 => !!value
  && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);

/** Cesium does not expose cancellation for its GPU / terrain queries. Stop
 * owning map visibility immediately, and consume any eventual query result.
 */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean, value: unknown) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      if (failed) reject(value); else resolve(value as T);
    };
    const abort = () => finish(true, signal.reason ?? new DOMException('CAD 高程采样已取消', 'AbortError'));
    pending.then(value => finish(false, value), error => finish(true, error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Freeze the same receiving surface used by the map, before AR hides that surface.
 * A missing sample is an error: restoring source Z would change a flat draped CAD
 * into a sloping drawing when entering AR. The original layer is never edited.
 */
export function createCadSurfaceSampler(
  viewer: Viewer,
  mode: 'terrain' | 'model',
  imports: readonly ImportRecord[],
  signal?: AbortSignal,
): (positions: Cartesian3[]) => Promise<Cartesian3[]> {
  return async positions => {
    signal?.throwIfAborted();
    if (!positions.length) return [];
    if (positions.some(point => !valid(point))) throw new Error('CAD 表面高程采样坐标无效');
    const scene = viewer.scene;
    const ellipsoid = scene.ellipsoid ?? Ellipsoid.WGS84;
    if (mode === 'terrain') {
      const provider = viewer.terrainProvider;
      if (!provider) throw new Error('贴地 CAD 缺少地形服务，无法保持地图高程');
      const cartographics = positions.map(point => Cartographic.fromCartesian(point, ellipsoid));
      if (provider instanceof EllipsoidTerrainProvider) {
        for (const point of cartographics) point.height = 0;
      } else {
        if (!provider.availability) throw new Error('当前地形不提供高程采样覆盖信息，无法冻结贴地 CAD；请使用支持采样的地形或重新导入为绝对高程');
        // Do not issue a separate terrain request for each source entity.
        for (let index = 0; index < cartographics.length; index += 2000) {
          signal?.throwIfAborted();
          await abortable(sampleTerrainMostDetailed(provider, cartographics.slice(index, index + 2000), true), signal);
        }
      }
      signal?.throwIfAborted();
      const exaggeration = scene.verticalExaggeration ?? 1;
      const relativeHeight = scene.verticalExaggerationRelativeHeight ?? 0;
      return cartographics.map(point => {
        if (!Number.isFinite(point.height)) throw new Error('贴地 CAD 部分位置没有可用地形高程，已停止融合准备');
        point.height = (point.height - relativeHeight) * exaggeration + relativeHeight;
        return ellipsoid.cartographicToCartesian(point);
      });
    }

    if (!scene.clampToHeightSupported) throw new Error('当前设备不支持 CAD 模型表面高程采样，无法保持贴附形态');
    // The primitive CAD loader classifies onto 3D Tiles when they are present.
    // Ordinary GLB is the compatibility path used only when there are no tiles.
    const tiles = imports.filter(item => item.kind === '3D Tiles');
    const receivingImports = tiles.length ? tiles : imports.filter(item => item.kind === 'Model');
    const receivers = new Set(receivingImports.map(item => item.resource as Visible));
    if (![...receivers].some(item => item.show !== false && !item.isDestroyed?.())) {
      throw new Error('依附模型的 CAD 需要已显示的模型或倾斜摄影作为高程参照');
    }
    const visibility = new Map<Visible, boolean>();
    const excluded: object[] = [];
    const hide = (item: Visible | undefined) => {
      if (!item || item.isDestroyed?.() || visibility.has(item)) return;
      visibility.set(item, item.show); item.show = false; excluded.push(item);
    };
    const visit = (item: Visible) => {
      if (receivers.has(item)) return;
      if (item instanceof PrimitiveCollection) {
        // Keep a parent collection open if it contains a receiving model.
        for (let index = 0; index < item.length; index++) visit(item.get(index));
      } else hide(item);
    };
    try {
      // Restrict the sample to the receiving models, including for ordinary GLB.
      // In particular, never let the CAD copy or globe satisfy a missing model hit.
      hide(scene.globe);
      for (let index = 0; index < scene.primitives.length; index++) visit(scene.primitives.get(index));
      for (let index = 0; index < (scene.groundPrimitives?.length ?? 0); index++) visit(scene.groundPrimitives.get(index));
      for (let index = 0; index < (viewer.dataSources?.length ?? 0); index++) {
        const data = viewer.dataSources.get(index);
        if (!receivers.has(data)) {
          hide(data);
          for (const entity of data.entities.values) excluded.push(entity);
        }
      }
      for (const entity of viewer.entities?.values ?? []) hide(entity);
      const sampled: Cartesian3[] = [];
      for (let index = 0; index < positions.length; index += 200) {
        signal?.throwIfAborted();
        const chunk = positions.slice(index, index + 200).map(point => Cartesian3.clone(point));
        const result = await abortable(scene.clampToHeightMostDetailed(chunk, excluded, 0.1), signal);
        signal?.throwIfAborted();
        if (result.length !== chunk.length || result.some(point => !valid(point))) {
          throw new Error('CAD 部分位置没有可用模型表面高程，已停止融合准备；请核对模型覆盖范围与 CAD 定位');
        }
        sampled.push(...result.map(point => Cartesian3.clone(point!)));
      }
      return sampled;
    } finally {
      // Also restore on cancellation and missing samples; the map remains usable.
      for (const [item, show] of visibility) if (!item.isDestroyed?.()) item.show = show;
      scene.requestRender();
    }
  };
}
