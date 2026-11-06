import {
  BoundingSphere, Cartesian3, Color, ColorGeometryInstanceAttribute, ComponentDatatype,
  Geometry, GeometryAttribute, GeometryAttributes, GeometryInstance, HeadingPitchRange,
  PerInstanceColorAppearance, Primitive, PrimitiveType,
  type Cesium3DTileset, type Viewer,
} from 'cesium';
import { finishFragmentShader, finishVertexShader } from './temporaryWorksFinishes';
import { getTemporaryWorksClippingManager } from './temporaryWorksGlbScene';
import { planningBoundary, renderPlanningMesh, type PlanningLocation, type PlanningRoadView, type PlanningVertex } from './temporaryWorksScene';
import type { TemporaryWorksClippingManager, TemporaryWorksFootprint } from './temporaryWorksClipping';

export type TemporaryWorksSurfaceSide = { a: PlanningVertex; b: PlanningVertex };
export type TemporaryWorksSurfaceStatus = {
  state: 'loading' | 'ready' | 'hidden' | 'disabled' | 'waiting' | 'blocked' | 'covered' | 'error';
  message: string;
};
export type TemporaryWorksSurfaceOptions = {
  id: string;
  kind: 'road' | 'hardening';
  vertices: readonly PlanningVertex[];
  triangles: readonly (readonly number[])[];
  footprints: readonly TemporaryWorksFootprint[];
  /** Already deduplicated walls. An explicit empty array means no side walls. */
  sideEdges?: readonly TemporaryWorksSurfaceSide[];
  road?: PlanningRoadView;
  tileset?: Cesium3DTileset;
  clippingEnabled?: boolean;
  onStatus?: (status: TemporaryWorksSurfaceStatus) => void;
};

/** These protect the synchronous Cesium clipping adapter, separately from the
 * worker's surface-mesh budget. They are workload limits, not accuracy settings. */
export const DESIGNED_SURFACE_CLIPPING_LIMITS = Object.freeze({ boundaryPoints: 8192, polygons: 2048, topologyChecks: 2_000_000 });
export function checkDesignedSurfaceClippingBudget(footprints: readonly TemporaryWorksFootprint[]) {
  let boundaryPoints = 0, polygons = 0, topologyChecks = 0;
  for (const footprint of footprints) {
    const rings = [footprint.outer, ...(footprint.holes ?? [])];
    const count = rings.reduce((sum, ring) => sum + ring.length, 0);
    boundaryPoints += count;
    // Existing validation tests each ring and each pair of rings for intersection.
    // Count that quadratic work before handing any oversized polygon to the page.
    topologyChecks += Math.max(0, count * (count - 3) / 2);
    polygons += rings.length === 1 ? 1 : Math.max(0, count + 2 * (rings.length - 1) - 2);
    if (boundaryPoints > DESIGNED_SURFACE_CLIPPING_LIMITS.boundaryPoints || polygons > DESIGNED_SURFACE_CLIPPING_LIMITS.polygons || topologyChecks > DESIGNED_SURFACE_CLIPPING_LIMITS.topologyChecks)
      throw new Error('设计地面的摄影遮挡轮廓过于复杂，已保留摄影并暂停本方案遮挡。请减少边界细碎点、孔洞或重叠碎片后分区处理；其他方案保持不变。');
  }
  return { boundaryPoints, polygons, topologyChecks };
}

type MeshHandle = ReturnType<typeof renderPlanningMesh>;
type SurfaceMesh = Pick<MeshHandle, 'ready' | 'show' | 'xray' | 'bounds' | 'zoom' | 'destroy' | 'yard' |
  'standardPlacement' | 'hasStructure' | 'builtStructureCount' | 'structureBuilt'>;

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Prepare a batch of concrete faces. Side heights are explicit so a neighbour may own
 * only part of a shared vertical wall. Texture detail never introduces geometry. */
export function buildHardeningSurfaceBatch(vertices: readonly PlanningVertex[],
  triangles: readonly (readonly number[])[], sideEdges: readonly TemporaryWorksSurfaceSide[] = [], textureOrigin?: PlanningLocation) {
  if (!vertices.length && !sideEdges.length) return { instances: [] as GeometryInstance[], bounds: new BoundingSphere() };
  const origin = textureOrigin ?? vertices[0] ?? sideEdges[0].a;
  const east = 111319.49079327358 * Math.cos(origin.latitude * Math.PI / 180);
  const instances: GeometryInstance[] = [];
  let bounds: BoundingSphere | undefined;
  function make(points: readonly (PlanningVertex & { renderHeight: number })[], indices: number[], finish: number, color: string) {
    if (!indices.length) return;
    const positions = new Float64Array(points.length * 3), uv = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (![p.longitude, p.latitude, p.renderHeight].every(Number.isFinite) || Math.abs(p.longitude) > 180 || Math.abs(p.latitude) > 90)
        throw new Error('硬化面包含无效位置或标高，原场景保持不变。');
      const point = Cartesian3.fromDegrees(p.longitude, p.latitude, p.renderHeight);
      positions.set([point.x, point.y, point.z], i * 3);
      uv.set([(p.longitude - origin.longitude) * east, (p.latitude - origin.latitude) * 111319.49079327358, finish], i * 3);
    }
    if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= points.length)) throw new Error('硬化网格索引无效。');
    const sphere = BoundingSphere.fromVertices(positions);
    bounds = bounds ? BoundingSphere.union(bounds, sphere, bounds) : sphere;
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions });
    Object.assign(attributes, { twSurface: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: uv }) });
    instances.push(new GeometryInstance({
      geometry: new Geometry({ attributes, indices: points.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), primitiveType: PrimitiveType.TRIANGLES, boundingSphere: sphere }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color)) },
    }));
  }
  make(vertices.map(p => ({ ...p, renderHeight: p.surfaceHeight })), triangles.flatMap(t => [...t]), 2, '#c4c6c5');
  make(vertices.map(p => ({ ...p, renderHeight: p.baseHeight })), triangles.flatMap(t => [t[2], t[1], t[0]]), 4, '#9b9e9d');
  const wallPoints: Array<PlanningVertex & { renderHeight: number }> = [], wallIndices: number[] = [];
  for (const { a, b } of sideEdges) {
    if (a.baseHeight > a.surfaceHeight || b.baseHeight > b.surfaceHeight) throw new Error('硬化侧边的底标高不能高于顶标高。');
    if (a.baseHeight === a.surfaceHeight && b.baseHeight === b.surfaceHeight) continue;
    const i = wallPoints.length;
    wallPoints.push({ ...a, renderHeight: a.surfaceHeight }, { ...b, renderHeight: b.surfaceHeight },
      { ...a, renderHeight: a.baseHeight }, { ...b, renderHeight: b.baseHeight });
    wallIndices.push(i, i + 3, i + 1, i, i + 2, i + 3);
  }
  make(wallPoints, wallIndices, 4, '#9b9e9d');
  return { instances, bounds: bounds ?? new BoundingSphere() };
}

function renderHardeningMesh(viewer: Viewer, options: TemporaryWorksSurfaceOptions): SurfaceMesh {
  const collection = viewer.scene.primitives, parts: Primitive[] = [], bounds = new BoundingSphere();
  let destroyed = false, visible = true, finished = false, zoomRequested = false, hasBounds = false;
  // A design surface always depth-tests. The historical x-ray toggle must not bypass
  // surface ownership or paint a second concrete plane over neighbouring facilities.
  let xray = false;
  const requestRender = () => { if (!viewer.isDestroyed()) viewer.scene.requestRender(); };
  const zoom = () => {
    if (destroyed || viewer.isDestroyed()) return;
    if (!finished) { zoomRequested = true; return; }
    if (hasBounds) viewer.camera.flyToBoundingSphere(bounds, { offset: new HeadingPitchRange(0, -.85, Math.max(15, bounds.radius * 3.1)) });
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const part of parts) {
      if (!viewer.isDestroyed() && collection.contains(part)) collection.remove(part);
      if (!part.isDestroyed()) part.destroy();
    }
    parts.length = 0;
    requestRender();
  };
  const ready = (async () => {
    await nextTask();
    if (destroyed || viewer.isDestroyed()) return;
    const addBatch = (vertices: readonly PlanningVertex[], triangles: readonly (readonly number[])[], sides: readonly TemporaryWorksSurfaceSide[]) => {
      const batch = buildHardeningSurfaceBatch(vertices, triangles, sides, options.vertices[0] ?? options.sideEdges?.[0]?.a);
      if (!batch.instances.length) return;
      if (hasBounds) BoundingSphere.union(bounds, batch.bounds, bounds);
      else { BoundingSphere.clone(batch.bounds, bounds); hasBounds = true; }
      const part = new Primitive({ geometryInstances: batch.instances, asynchronous: false, allowPicking: false, compressVertices: false,
        appearance: new PerInstanceColorAppearance({ flat: true, closed: false, translucent: false,
          vertexShaderSource: finishVertexShader, fragmentShaderSource: finishFragmentShader,
          renderState: { depthTest: { enabled: true }, depthMask: true, cull: { enabled: false } } }) });
      part.show = visible;
      try { collection.add(part); parts.push(part); }
      catch (error) { if (!part.isDestroyed()) part.destroy(); throw error; }
      requestRender();
    };
    for (let offset = 0; offset < options.triangles.length; offset += 4096) {
      if (destroyed || viewer.isDestroyed()) return;
      const index = new Map<number, number>(), vertices: PlanningVertex[] = [];
      const triangles = options.triangles.slice(offset, offset + 4096).map(face => face.map(old => {
        if (!Number.isInteger(old) || old < 0 || old >= options.vertices.length) throw new Error('硬化网格索引无效。');
        let i = index.get(old);
        if (i === undefined) { i = vertices.length; index.set(old, i); vertices.push(options.vertices[old]); }
        return i;
      }));
      addBatch(vertices, triangles, []);
      await nextTask();
    }
    const sides = options.sideEdges ?? planningBoundary(options.triangles).map(([a, b]) => ({ a: options.vertices[a], b: options.vertices[b] }));
    for (let offset = 0; offset < sides.length; offset += 4096) {
      if (destroyed || viewer.isDestroyed()) return;
      addBatch([], [], sides.slice(offset, offset + 4096));
      await nextTask();
    }
    finished = true;
    if (zoomRequested) zoom();
  })().catch(error => { destroy(); throw error; });
  return { bounds, ready, yard: { flag: false, spaces: 0 }, standardPlacement: undefined,
    hasStructure: false, builtStructureCount: 0, structureBuilt: [],
    get show() { return visible; }, set show(value: boolean) { visible = value; parts.forEach(p => { p.show = value; }); requestRender(); },
    get xray() { return xray; }, set xray(_value: boolean) { xray = false; }, zoom, destroy };
}

/** The same owner manager serves GLBs, roads and hardening. Keeping this adapter
 * independent of the renderer makes async resource/clip pairing directly testable. */
export function attachTemporaryWorksSurfaceClipping(viewer: Viewer, mesh: SurfaceMesh,
  options: TemporaryWorksSurfaceOptions, manager: TemporaryWorksClippingManager = getTemporaryWorksClippingManager(viewer)) {
  const clippingId = `tw-surface:${options.id}:${crypto.randomUUID()}`;
  let tileset = options.tileset, clippingEnabled = options.clippingEnabled !== false;
  let visible = mesh.show, destroyed = false, prepared = false, registered: Cesium3DTileset | undefined;
  let stopWatching: (() => void) | undefined;
  let status: TemporaryWorksSurfaceStatus = { state: 'loading', message: '正在准备设计地面…' };
  const hasSurface = options.triangles.length > 0;
  const requestRender = () => { if (!viewer.isDestroyed()) viewer.scene.requestRender(); };
  const setStatus = (next: TemporaryWorksSurfaceStatus) => {
    if (destroyed || status.state === next.state && status.message === next.message) return;
    status = next; options.onStatus?.({ ...next });
  };
  function detach() {
    manager.remove(clippingId); registered = undefined;
    stopWatching?.(); stopWatching = undefined;
  }
  function reflectStatus() {
    if (destroyed || !prepared || !visible || !clippingEnabled) return;
    const current = manager.getStatus(clippingId);
    if (!current) return;
    setStatus(current.state === 'active' ? { state: 'ready', message: '设计地面与摄影遮挡已启用。' }
      : { state: 'blocked', message: current.message });
  }
  function synchronize() {
    if (destroyed || !prepared || viewer.isDestroyed()) return;
    if (!visible) { detach(); setStatus({ state: 'hidden', message: '设计地面已隐藏，对应遮挡已撤销。' }); return; }
    if (!hasSurface) { detach(); setStatus({ state: 'covered', message: '硬化范围当前被其他有效设施覆盖。' }); return; }
    if (!clippingEnabled) { detach(); setStatus({ state: 'disabled', message: '地面继续显示，摄影遮挡已关闭。' }); return; }
    if (!tileset || tileset.isDestroyed()) { detach(); setStatus({ state: 'waiting', message: '等待关联原倾斜摄影图层。' }); return; }
    if (registered !== tileset) {
      try {
        checkDesignedSurfaceClippingBudget(options.footprints);
        manager.upsert({ id: clippingId, tileset, footprints: options.footprints, visible: true, enabled: true });
        registered = tileset;
      } catch (error) {
        detach(); setStatus({ state: 'blocked', message: error instanceof Error ? error.message : String(error) }); return;
      }
    }
    reflectStatus();
    // This reads owner state; it never rebuilds geometry or clipping each frame.
    stopWatching ??= viewer.scene.postUpdate?.addEventListener(reflectStatus);
  }
  const destroy = () => {
    if (destroyed) return;
    destroyed = true; detach(); mesh.destroy(); requestRender();
  };
  const ready = mesh.ready.then(() => {
    if (destroyed) return;
    if (viewer.isDestroyed()) { destroy(); return; }
    prepared = true; mesh.show = visible; synchronize(); requestRender();
  }).catch(error => {
    setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    destroy(); throw error;
  });
  return {
    ready, bounds: mesh.bounds, yard: mesh.yard, standardPlacement: mesh.standardPlacement,
    hasStructure: mesh.hasStructure, builtStructureCount: mesh.builtStructureCount, structureBuilt: mesh.structureBuilt,
    get show() { return visible; },
    set show(value: boolean) { if (destroyed || visible === value) return; visible = value; mesh.show = value; synchronize(); requestRender(); },
    get xray() { return mesh.xray; }, set xray(value: boolean) { mesh.xray = value; },
    get status() { return { ...status }; },
    get clippingEnabled() { return clippingEnabled; },
    setClippingEnabled(value: boolean) { if (destroyed || clippingEnabled === value) return; clippingEnabled = value; synchronize(); requestRender(); },
    setTileset(value?: Cesium3DTileset) { if (destroyed || tileset === value) return; tileset = value; synchronize(); requestRender(); },
    zoom: () => mesh.zoom(), destroy,
  };
}

export function renderTemporaryWorksSurface(viewer: Viewer, options: TemporaryWorksSurfaceOptions) {
  const mesh = options.kind === 'road' && options.triangles.length
    ? renderPlanningMesh(viewer, 'road', options.vertices, options.triangles, undefined, options.road)
    : renderHardeningMesh(viewer, options);
  mesh.xray = false;
  return attachTemporaryWorksSurfaceClipping(viewer, mesh, options);
}
