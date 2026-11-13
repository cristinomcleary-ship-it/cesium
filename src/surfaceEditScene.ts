import {
  BoundingSphere, Cartesian2, ClippingPolygonCollection, Color, ComponentDatatype,
  Geometry, GeometryAttribute, GeometryAttributes, GeometryInstance, HeadingPitchRange,
  Material, MaterialAppearance, Matrix4, Primitive, PrimitiveType,
  type Cesium3DTileset, type ClippingPolygon, type Globe, type Viewer,
} from 'cesium';
import { getTemporaryWorksClippingManager } from './temporaryWorksGlbScene';
import { buildTemporaryWorksClipPolygons, type TemporaryWorksClippingScope, type TemporaryWorksFootprint } from './temporaryWorksClipping';
import type { SurfaceEditGeometryResult, SurfaceEditMesh } from './surfaceEditGeometry';
import { SURFACE_EDIT_LIMITS, type SurfaceEditPlan } from './surfaceEditTypes';

export type SurfaceEditSceneStatus = {
  state: 'loading' | 'ready' | 'hidden' | 'suspended' | 'blocked' | 'error';
  message: string;
};
export type SurfaceEditHandle = {
  readonly status: SurfaceEditSceneStatus;
  readonly enabled: boolean;
  readonly primitives: readonly Primitive[];
  readonly bounds: BoundingSphere;
  setEnabled(value: boolean): SurfaceEditSceneStatus;
  setBottomVisible(value: boolean): void;
  zoom(): void;
  destroy(): void;
};
export type SurfaceEditPreparedMesh = {
  readonly primitives: readonly Primitive[];
  readonly bounds: BoundingSphere;
  setVisible(visible: boolean, bottomVisible: boolean): void;
  destroy(): void;
};
export type SurfaceEditSceneOptions = {
  onStatus?: (id: string, status: SurfaceEditSceneStatus) => void;
  /** Dependency boundary used by lifecycle tests without claiming GPU validation. */
  prepareMesh?: (viewer: Viewer, plan: SurfaceEditPlan, geometry: SurfaceEditGeometryResult,
    matrix: Matrix4, signal?: AbortSignal) => Promise<SurfaceEditPreparedMesh>;
};
type Node = {
  plan: SurfaceEditPlan; tileset: Cesium3DTileset; mesh: SurfaceEditPreparedMesh;
  footprint: TemporaryWorksFootprint; terrainPolygons: ClippingPolygon[];
  requested: boolean; bottomVisible: boolean; disposed: boolean;
  status: SurfaceEditSceneStatus; previous?: Node; clipVisible?: boolean; shown?: boolean; shownBottom?: boolean; transformStale?: boolean;
};
const ownedGlobeCollections = new WeakSet<ClippingPolygonCollection>();
const retainedGlobeCollections = new WeakMap<Globe, ClippingPolygonCollection>();

/** Legacy underground tools must not disable a live collection owned by this module. */
export function isSurfaceEditGlobeClipping(value: unknown): boolean {
  return !!value && typeof value === 'object' && ownedGlobeCollections.has(value as ClippingPolygonCollection);
}

/** Cesium 1.144 only notices a change in the *number* of polygon positions.
 * Keep the Globe collection alive (older terrain LODs may borrow it), mutate a
 * nonempty set in place, and invalidate this version-locked counter after edits.
 * This adapter is exclusively for a collection owned by SurfaceEditScene. */
export function updateOwnedSurfaceGlobePolygons(collection: ClippingPolygonCollection,
  polygons: readonly ClippingPolygon[]) {
  if (!ownedGlobeCollections.has(collection) || collection.isDestroyed()) throw new Error('地形裁剪所有权已变化。');
  if (!polygons.length) { collection.enabled = false; return; }
  const previous = Array.from({ length: collection.length }, (_, i) => collection.get(i));
  for (const polygon of polygons) collection.add(polygon);
  for (const polygon of previous) collection.remove(polygon);
  // No public dirty notification exists in the locked engine 26.2 / Cesium 1.144.
  (collection as unknown as { _totalPositions: number })._totalPositions = -1;
  collection.enabled = true;
  collection.inverse = false;
}

class SurfaceTerrainClipping {
  private collection?: ClippingPolygonCollection;
  private polygons: readonly ClippingPolygon[] = [];
  constructor(private readonly viewer: Viewer) {
    const globe = viewer.scene.globe;
    const retained = globe && retainedGlobeCollections.get(globe);
    if (retained && globe.clippingPolygons === retained && !retained.isDestroyed()) this.collection = retained;
  }
  unavailable(): string | undefined {
    const globe = this.viewer.scene.globe;
    if (!globe) return;
    if (globe.clippingPlanes?.enabled) return '底层地形正在剖切，请先关闭该剖切再启用地表编辑。';
    const current = globe.clippingPolygons;
    if (current && current !== this.collection) return '底层地形正被其他裁剪功能使用，原效果保持不变。';
    if (this.collection?.isDestroyed()) return '地形裁剪资源已释放，请重新加载地表编辑方案。';
    if (this.collection && current !== this.collection) return '地形裁剪所有权已变化，请重新加载地表编辑方案。';
    return;
  }
  update(polygons: readonly ClippingPolygon[]) {
    const globe = this.viewer.scene.globe;
    if (!globe) return;
    if (!polygons.length) {
      if (globe.clippingPolygons === this.collection && this.collection && !this.collection.isDestroyed()) this.collection.enabled = false;
      this.polygons = [];
      return;
    }
    const reason = this.unavailable(); if (reason) throw new Error(reason);
    if (!this.collection) {
      const collection = new ClippingPolygonCollection({ polygons: [...polygons], enabled: true, inverse: false, quality: 2 });
      try { globe.clippingPolygons = collection; }
      catch (error) { if (!collection.isDestroyed()) collection.destroy(); throw error; }
      this.collection = collection;
      ownedGlobeCollections.add(collection); retainedGlobeCollections.set(globe, collection);
    } else if (this.polygons.length !== polygons.length || polygons.some((p, i) => p !== this.polygons[i])) {
      updateOwnedSurfaceGlobePolygons(this.collection, polygons);
    } else this.collection.enabled = true;
    this.polygons = polygons;
  }
  dispose() {
    // Globe owns the collection and releases it on Viewer disposal. Retaining a
    // disabled nonempty collection avoids leaving borrowed terrain references to
    // a destroyed GPU resource; a later SurfaceEditScene may safely adopt it.
    this.update([]);
  }
}

function abortError() { return new DOMException('地表生成已取消。', 'AbortError'); }
function assertSignal(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
function clippingMessage(message: string): string {
  return message === '关联摄影模型正被其他裁剪功能使用，请关闭该功能后重试'
    ? '关联摄影被其他裁剪功能占用；请先关闭该功能。若仍提示占用，请重新加载摄影后重试，原裁剪资源不会被替换。'
    : message;
}
function transformMatches(node: Node): boolean {
  const saved = node.plan.targetTransform;
  if (saved.length !== 16 && saved.length !== 32) return false;
  for (let i = 0; i < 16; i++) if (saved[i] !== node.tileset.modelMatrix[i]) return false;
  if (saved.length === 32) {
    const root = node.tileset.root?.transform;
    if (!root) return false;
    for (let i = 0; i < 16; i++) if (saved[i + 16] !== root[i]) return false;
  }
  return true;
}

/** Checked before Cesium allocates vertex buffers, even for imported worker output. */
export function surfaceEditMeshGeometry(mesh: SurfaceEditMesh): Geometry | undefined {
  const n = mesh.positions.length / 3;
  if (!Number.isInteger(n) || n > 6144 || mesh.indices.length > 3072 * 3
    || mesh.normals.length !== n * 3 || mesh.uvs.length !== n * 2 || mesh.indices.length % 3)
    throw new Error('地表网格规模或属性长度无效。');
  if (!n || !mesh.indices.length) return;
  for (const values of [mesh.positions, mesh.normals, mesh.uvs]) for (const value of values)
    if (!Number.isFinite(value)) throw new Error('地表网格包含无效坐标或纹理坐标。');
  for (const index of mesh.indices) if (index >= n) throw new Error('地表网格索引越界。');
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: mesh.positions });
  attributes.normal = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: mesh.normals });
  attributes.st = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: mesh.uvs });
  return new Geometry({ attributes, indices: mesh.indices, primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(mesh.positions) });
}

function soilTexture(kind: 'soil' | 'sand' | 'gravel', wall: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法创建土体纹理。');
  const pixels = context.createImageData(128, 128);
  const base = kind === 'sand' ? [174, 148, 106] : kind === 'gravel' ? [133, 130, 119] : [143, 108, 75];
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const seed = Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263);
    const noise = (((seed ^ (seed >>> 13)) >>> 0) % 31) - 15;
    const band = wall ? Math.sin(y * Math.PI / 16) * 5 : 0;
    const i = (y * 128 + x) * 4;
    for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = base[channel] + noise + band;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0); return canvas;
}
async function imageTexture(uri: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (!/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(uri) || uri.length > SURFACE_EDIT_LIMITS.imageBytes * 1.38)
    throw new Error('土体贴图仅支持限额内的 PNG、JPEG 或 WebP 图片。');
  assertSignal(signal);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const stop = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', cancel); clearTimeout(timer); };
    const cancel = () => { stop(); image.src = ''; reject(abortError()); };
    const timer = setTimeout(() => { stop(); image.src = ''; reject(new Error('土体贴图解码超时。')); }, 10_000);
    image.onload = () => { stop(); resolve(); };
    image.onerror = () => { stop(); reject(new Error('土体贴图无法解码。')); };
    signal?.addEventListener('abort', cancel, { once: true }); image.src = uri;
  });
  assertSignal(signal);
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > SURFACE_EDIT_LIMITS.imageDimension || image.naturalHeight > SURFACE_EDIT_LIMITS.imageDimension)
    throw new Error('土体贴图尺寸超过 2048 像素上限。');
  return image;
}

function appearance(material: Material, warmup: boolean) {
  return new MaterialAppearance({ material, translucent: false, closed: false, faceForward: true,
    renderState: { depthTest: { enabled: true }, depthMask: !warmup, cull: { enabled: false },
      colorMask: { red: !warmup, green: !warmup, blue: !warmup, alpha: !warmup } } });
}
async function prepareSurfaceMesh(viewer: Viewer, plan: SurfaceEditPlan, result: SurfaceEditGeometryResult,
  matrix: Matrix4, signal?: AbortSignal): Promise<SurfaceEditPreparedMesh> {
  const parts: Array<{ primitive: Primitive; material: Material; surface: boolean; normal: MaterialAppearance }> = [];
  const bounds = new BoundingSphere(); let haveBounds = false, disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    for (const { primitive, material } of parts) {
      if (!viewer.isDestroyed() && viewer.scene.primitives.contains(primitive)) viewer.scene.primitives.remove(primitive);
      if (!primitive.isDestroyed()) primitive.destroy();
      if (!material.isDestroyed()) material.destroy();
    }
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  };
  try {
    for (const [mesh, surface] of [[result.surface, true], [result.walls, false]] as const) {
      assertSignal(signal);
      const geometry = surfaceEditMeshGeometry(mesh); if (!geometry) continue;
      const kind = surface ? plan.texture.ground : plan.texture.wall;
      const uri = surface ? plan.texture.groundImage : plan.texture.wallImage;
      const image = uri ? await imageTexture(uri, signal) : soilTexture(kind, !surface);
      assertSignal(signal);
      const material = Material.fromType('Image', { image, repeat: new Cartesian2(1, 1), color: Color.WHITE });
      const primitive = new Primitive({ geometryInstances: new GeometryInstance({ geometry, modelMatrix: Matrix4.clone(matrix), id: { surfaceEditId: plan.id } }),
        appearance: appearance(material, true), asynchronous: false, allowPicking: false, compressVertices: false });
      const part = { primitive, material, surface, normal: appearance(material, false) }; parts.push(part);
      const sphere = BoundingSphere.transform(geometry.boundingSphere!, matrix);
      if (haveBounds) BoundingSphere.union(bounds, sphere, bounds); else { BoundingSphere.clone(sphere, bounds); haveBounds = true; }
      viewer.scene.primitives.add(primitive);
    }
    if (!parts.length) throw new Error('地表网格为空。');
    await new Promise<void>((resolve, reject) => {
      let frames = 0, stopRender = () => {}, stopError = () => {};
      const stop = () => { stopRender(); stopError(); signal?.removeEventListener('abort', cancel); clearTimeout(timer); };
      const cancel = () => { stop(); reject(abortError()); };
      const timer = setTimeout(() => { stop(); reject(new Error('地表显示准备超时，原摄影保持不变。')); }, 15_000);
      stopRender = viewer.scene.postRender.addEventListener(() => {
        if (viewer.isDestroyed()) { stop(); reject(new Error('场景已关闭。')); return; }
        // One additional complete render lets loaded image textures and shader
        // programs initialize while color and depth writes remain disabled.
        if (parts.every(({ primitive }) => primitive.ready)) frames++; else frames = 0;
        if (frames >= 2) { stop(); resolve(); } else viewer.scene.requestRender();
      });
      stopError = viewer.scene.renderError.addEventListener((_scene, error) => { stop(); reject(error); });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else viewer.scene.requestRender();
    });
    assertSignal(signal);
    for (const part of parts) { part.primitive.show = false; part.primitive.appearance = part.normal; }
    return { primitives: parts.map(p => p.primitive), bounds,
      setVisible(visible, bottomVisible) { if (disposed) return; for (const p of parts) p.primitive.show = visible && (!p.surface || bottomVisible); },
      destroy: dispose };
  } catch (error) { dispose(); throw error; }
}

/** Owns only newly created surfaces and its contributor scope. All positional
 * changes and visibility are reversible; source models, shaders and data remain
 * unchanged. Plan IDs identify replacement transactions, not GPU resources. */
export class SurfaceEditScene {
  private readonly manager;
  private readonly scope: TemporaryWorksClippingScope;
  private readonly terrain: SurfaceTerrainClipping;
  private readonly nodes = new Set<Node>();
  private readonly owners = new Map<string, Node>();
  private readonly pending = new Set<AbortController>();
  private stopWatching: () => void;
  private stopped = false;
  private suspendedState = false;
  constructor(private readonly viewer: Viewer, private readonly options: SurfaceEditSceneOptions = {}) {
    this.manager = getTemporaryWorksClippingManager(viewer);
    this.scope = this.manager.createScope('surface-edit', { limits: { contributors: 32, boundaryPoints: 4096, polygons: 1024, topologyChecks: 1_000_000 } });
    this.terrain = new SurfaceTerrainClipping(viewer);
    this.stopWatching = viewer.scene.postUpdate.addEventListener(() => this.synchronize());
  }
  get suspended() { return this.suspendedState; }
  getPrimitives(): readonly Primitive[] { return [...this.nodes].flatMap(node => [...node.mesh.primitives]); }
  async prepare(plan: SurfaceEditPlan, geometry: SurfaceEditGeometryResult, modelMatrix: Matrix4,
    tileset: Cesium3DTileset, signal?: AbortSignal): Promise<SurfaceEditHandle> {
    if (this.stopped) throw new Error('地表编辑场景已关闭。');
    assertSignal(signal);
    if (tileset.isDestroyed()) throw new Error('关联摄影模型已卸载。');
    if (!ClippingPolygonCollection.isSupported(this.viewer.scene)) throw new Error('当前浏览器不支持地表裁剪。');
    const boundaryPoints = plan.boundary.length + plan.holes.reduce((count, ring) => count + ring.length, 0);
    if (plan.holes.length > SURFACE_EDIT_LIMITS.holes || boundaryPoints > SURFACE_EDIT_LIMITS.boundaryPoints)
      throw new Error('地表边界超过显示预算，请先分区。');
    const copied = structuredClone(plan), footprint = { outer: copied.boundary, holes: copied.holes };
    const terrainPolygons = buildTemporaryWorksClipPolygons([footprint], tileset.ellipsoid);
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true }); this.pending.add(controller);
    let mesh: SurfaceEditPreparedMesh;
    try {
      mesh = await (this.options.prepareMesh ?? prepareSurfaceMesh)(this.viewer, copied, geometry, modelMatrix, controller.signal);
      if (this.stopped || controller.signal.aborted || signal?.aborted) { mesh.destroy(); throw abortError(); }
    } finally { signal?.removeEventListener('abort', cancel); this.pending.delete(controller); }
    const node: Node = { plan: copied, tileset, mesh, footprint, terrainPolygons, requested: false,
      bottomVisible: copied.bottomVisible, disposed: false, status: { state: 'hidden', message: '地表效果已准备，尚未启用。' } };
    this.nodes.add(node);
    return { get status() { return { ...node.status }; }, get enabled() { return node.requested; },
      get primitives() { return node.mesh.primitives; }, get bounds() { return node.mesh.bounds; },
      setEnabled: value => this.setEnabled(node, value),
      setBottomVisible: value => { node.bottomVisible = value; this.synchronize(); },
      zoom: () => { if (!node.disposed && !this.viewer.isDestroyed()) this.viewer.camera.flyToBoundingSphere(node.mesh.bounds,
        { offset: new HeadingPitchRange(0, -0.8, Math.max(20, node.mesh.bounds.radius * 3)) }); },
      destroy: () => this.remove(node) };
  }
  private report(node: Node, status: SurfaceEditSceneStatus) {
    if (node.status.state === status.state && node.status.message === status.message) return;
    node.status = status;
    // A replacement candidate and its rollback handle intentionally share a
    // saved ID. Only the current owner may publish that record's visible state.
    if (this.owners.has(node.plan.id) && this.owners.get(node.plan.id) !== node) return;
    try { this.options.onStatus?.(node.plan.id, { ...status }); } catch { /* Observers cannot alter clipping ownership. */ }
  }
  private display(node: Node, visible: boolean) {
    if (node.shown === visible && node.shownBottom === node.bottomVisible) return;
    node.shown = visible; node.shownBottom = node.bottomVisible;
    node.mesh.setVisible(visible, node.bottomVisible);
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }
  private register(node: Node) {
    return this.scope.upsert({ id: node.plan.id, tileset: node.tileset, footprints: [node.footprint], visible: true, enabled: true });
  }
  private setEnabled(node: Node, value: boolean): SurfaceEditSceneStatus {
    if (node.disposed || this.stopped) return { state: 'error', message: '地表方案已释放。' };
    if (!value) {
      node.requested = false;
      if (this.owners.get(node.plan.id) === node) { this.scope.remove(node.plan.id); this.owners.delete(node.plan.id); }
      this.display(node, false); this.report(node, { state: 'hidden', message: '地表效果已关闭，原摄影已恢复。' });
      this.synchronize(); return { ...node.status };
    }
    if (this.owners.get(node.plan.id) === node) { node.requested = true; this.synchronize(); return { ...node.status }; }
    const previous = this.owners.get(node.plan.id);
    try {
      if (node.tileset.isDestroyed() || !node.tileset.show) throw new Error('关联摄影模型未显示，请先显示该模型。');
      node.transformStale ||= !transformMatches(node);
      if (node.transformStale) throw new Error('摄影位置已变化，请重新生成地表方案。');
      const unavailable = node.plan.clipTerrain && this.terrain.unavailable(); if (unavailable) throw new Error(unavailable);
      const status = this.register(node);
      if (status.state !== 'active') throw new Error(clippingMessage(status.message));
      node.clipVisible = true; node.requested = true; node.previous = previous;
      this.owners.set(node.plan.id, node);
      this.synchronize();
      if (!this.suspendedState && node.status.state !== 'ready') throw new Error(node.status.message);
      if (previous && previous !== node) {
        this.display(previous, false);
        this.report(previous, { state: 'hidden', message: '已由同一方案的新效果替换。' });
      }
    } catch (error) {
      node.requested = false; this.display(node, false); node.previous = undefined;
      let message = error instanceof Error ? error.message : String(error);
      if (previous && !previous.disposed) {
        this.owners.set(node.plan.id, previous);
        try { this.register(previous); previous.clipVisible = true; }
        catch (restoreError) { this.scope.remove(node.plan.id); previous.clipVisible = false; this.display(previous, false);
          message += `；旧裁剪恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`; }
      } else { this.owners.delete(node.plan.id); this.scope.remove(node.plan.id); }
      this.synchronize(); this.report(node, { state: 'blocked', message });
    }
    return { ...node.status };
  }
  setSuspended(value: boolean) {
    if (this.stopped || this.suspendedState === value) return;
    this.suspendedState = value; this.synchronize();
  }
  private synchronize() {
    if (this.stopped || this.viewer.isDestroyed()) return;
    // An unused feature must not rescan legacy temporary-work clipping every frame.
    if (!this.owners.size) { this.terrain.update([]); return; }
    const terrainUnavailable = this.terrain.unavailable();
    const live: Node[] = [];
    for (const node of this.owners.values()) {
      let reason: SurfaceEditSceneStatus | undefined;
      if (this.suspendedState) reason = { state: 'suspended', message: '地表效果暂时暂停，退出当前模式后恢复。' };
      else if (node.tileset.isDestroyed() || !node.tileset.show) reason = { state: 'blocked', message: '关联摄影模型未显示或已卸载，地表效果已暂停。' };
      else if (node.transformStale ||= !transformMatches(node)) reason = { state: 'blocked', message: '摄影位置已变化，请重新生成地表方案。' };
      else if (node.plan.clipTerrain && terrainUnavailable) reason = { state: 'blocked', message: terrainUnavailable };
      const visible = !reason && node.requested;
      if (node.clipVisible !== visible) { this.scope.setVisible(node.plan.id, visible); node.clipVisible = visible; }
      if (reason) { this.display(node, false); this.report(node, reason); }
      else live.push(node);
    }
    this.manager.synchronize();
    const ready: Node[] = [];
    for (const node of live) {
      const status = this.scope.getStatus(node.plan.id);
      if (status?.state === 'active') ready.push(node);
      else { this.display(node, false); this.report(node, { state: 'blocked', message: status ? clippingMessage(status.message) : '地表裁剪状态缺失。' }); }
    }
    try {
      this.terrain.update(ready.filter(node => node.plan.clipTerrain).flatMap(node => node.terrainPolygons));
      for (const node of ready) { this.display(node, true); this.report(node, { state: 'ready', message: '地表效果已启用。' }); }
    } catch (error) {
      for (const node of ready) {
        if (node.plan.clipTerrain) { this.scope.setVisible(node.plan.id, false); node.clipVisible = false; this.display(node, false);
          this.report(node, { state: 'blocked', message: error instanceof Error ? error.message : String(error) }); }
        else { this.display(node, true); this.report(node, { state: 'ready', message: '地表效果已启用。' }); }
      }
      this.terrain.update([]);
    }
  }
  private remove(node: Node) {
    if (node.disposed) return;
    node.disposed = true; this.nodes.delete(node);
    if (this.owners.get(node.plan.id) === node) {
      this.scope.remove(node.plan.id); this.owners.delete(node.plan.id);
      const previous = node.previous;
      if (!this.stopped && previous && !previous.disposed && previous.requested) {
        try { this.register(previous); previous.clipVisible = true; this.owners.set(previous.plan.id, previous); }
        catch (error) { previous.requested = false; this.report(previous, { state: 'blocked', message: `旧方案恢复失败：${error instanceof Error ? error.message : String(error)}` }); }
      }
    }
    node.mesh.destroy(); this.synchronize();
  }
  destroy() {
    if (this.stopped) return;
    this.stopped = true; this.stopWatching();
    for (const pending of this.pending) pending.abort(); this.pending.clear();
    this.scope.dispose(); this.terrain.dispose();
    this.owners.clear(); for (const node of [...this.nodes]) this.remove(node);
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }
}
