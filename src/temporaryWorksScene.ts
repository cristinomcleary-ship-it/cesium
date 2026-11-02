import { buildStandardSiteLayout, standardSiteBuildings } from './temporaryWorksSiteLayout';
import { buildStandardSiteDecor } from './temporaryWorksSiteDecor';
import { buildCampYard } from './temporaryWorksYard';
import { facilityGeometry, finishes, type XY as PlanPair } from './temporaryWorksArchitecture';
import { finishVertexShader, finishFragmentShader } from './temporaryWorksFinishes';
import { planningSampleMayHit } from './temporaryWorksSurfaceBounds';
import { formatRoadStation } from './temporaryWorksRoadConflict';
export { formatRoadStation } from './temporaryWorksRoadConflict';
import {
  BoundingSphere, Cartesian2, Cartesian3, Cartographic, Cesium3DTileset, Color,
  ColorGeometryInstanceAttribute, ComponentDatatype, DepthFunction, Geometry, GeometryAttribute, GeometryAttributes,
  GeometryInstance, HeadingPitchRange, Math as CesiumMath, Matrix4, PerInstanceColorAppearance,
  Primitive, PrimitiveType, Scene, Transforms, Viewer, DistanceDisplayCondition, LabelStyle, VerticalOrigin, type Entity,
} from 'cesium';
import { ShapeUtils, Vector2 } from 'three';
import { pickMachinerySurface } from './machinerySurfacePicker';
import { cleanPlanningBoundary } from './temporaryWorksGeometry';

export type PlanningLocation = { longitude: number; latitude: number };
export type PlanningVertex = PlanningLocation & {
  surfaceHeight: number; baseHeight: number;
  supportHeight?: number; formationHeight?: number; roadPart?: 'core' | 'slope'; roadOffset?: number; roadStation?: number;
};
export type PlanningStandardSite = { boundary:readonly PlanningLocation[] };
export type StandardPlacementInfo = PlanningLocation & {scale:number; rotationDeg:number; roles:string[]; cars:number};
export type PlanningRoadView = { width: number; length: number };
export type PlanningStructure = { footprint: readonly PlanningLocation[]; height: number };
export type PlanningKind = 'road' | 'camp' | 'steel';
type SamplingOptions = { signal?: AbortSignal; onProgress?: (done: number, total: number) => void };

const validLocation = (p: PlanningLocation) => Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180
  && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90;

export function pickPlanningReference(viewer: Viewer, tileset: Cesium3DTileset, screen: Cartesian2): PlanningLocation | undefined {
  const hit = pickMachinerySurface(viewer, screen, [{ kind: 'photogrammetry', resource: tileset, visible: true }]);
  if (hit) return { longitude: hit.longitude, latitude: hit.latitude };
}

function abortError() { return new DOMException('已取消临建规划取样', 'AbortError'); }

/** A separate, short-lived globe-free scene keeps terrain/overlays out of both depth and feature passes.
 * The source Resource retains its auth/proxy, and the same model matrix retains the project placement.
 * Only this scene is rendered/pumped while querying. The user's camera, layers and display are untouched.
 */
export async function withPlanningSurface<T>(
  viewer: Viewer, tileset: Cesium3DTileset, options: Pick<SamplingOptions, 'signal'>,
  run: (sample: (points: readonly PlanningLocation[], onProgress?: SamplingOptions['onProgress']) => Promise<Array<number | null>>, surfaceSignal:AbortSignal) => Promise<T>,
): Promise<T> {
  const checkSource = () => {
    if (options.signal?.aborted) throw abortError();
    if (viewer.isDestroyed() || tileset.isDestroyed() || !tileset.show || !viewer.scene.primitives.contains(tileset))
      throw new Error('选定的倾斜摄影已卸载或隐藏，请重新选择。');
  };
  checkSource();
  const originalMatrix = Matrix4.clone(tileset.modelMatrix);
  const rootTransform = Matrix4.clone(tileset.root.transform);
  // Cesium and its ResourceCache have realm-wide GPU objects. A separate realm
  // prevents a second context from reusing WebGL resources owned by the viewer.
  const host = document.createElement('iframe');
  host.tabIndex = -1;
  host.title = '临建摄影取样';
  host.style.cssText = 'position:fixed;left:-100px;top:0;width:32px;height:32px;pointer-events:none;overflow:hidden';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  const child = host.contentWindow as (Window & { Cesium?: typeof import('cesium'); CESIUM_BASE_URL?: string }) | null;
  if (!child) { host.remove(); throw new Error('无法创建临建取样环境。'); }
  const canvas = child.document.createElement('canvas');
  canvas.width = canvas.height = 32;
  child.document.body.append(canvas);

  let scene: Scene | undefined;
  let copy: Cesium3DTileset | undefined;
  let frame = 0, deadline = 0, closed = false;
  let fail!: (error: Error) => void;
  const session = new AbortController();
  const failure = new Promise<never>((_, reject) => { fail = reject; });
  const abort = () => fail(abortError());
  const lostContext = () => fail(new Error('显卡上下文中断，请重试取样。'));
  const armDeadline = () => {
    window.clearTimeout(deadline);
    deadline = window.setTimeout(() => fail(new Error('模型瓦片取样超时，请检查数据源后重试。')), 90000);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  canvas.addEventListener('webglcontextlost', lostContext);
  try {
    armDeadline();
    child.CESIUM_BASE_URL = new URL(CESIUM_BASE_URL + '/', window.location.href).href;
    const engine = await Promise.race([new Promise<typeof import('cesium')>((resolve, reject) => {
      const script = child.document.createElement('script');
      script.onload = () => child.Cesium ? resolve(child.Cesium) : reject(new Error('取样引擎加载失败。'));
      script.onerror = () => reject(new Error('无法加载临建取样引擎，请检查部署文件。'));
      // Vite emits this pinned runtime as a local fingerprinted asset in production.
      script.src = new URL('../node_modules/cesium/Build/Cesium/Cesium.js', import.meta.url).href;
      child.document.head.append(script);
    }), failure]);
    scene = new engine.Scene({
      canvas, ellipsoid: engine.Ellipsoid.clone(viewer.scene.ellipsoid), scene3DOnly: true,
      orderIndependentTranslucency: false, msaaSamples: 1, contextOptions: { webgl: { antialias: false } }
    });
    scene.rethrowRenderErrors = true;
    if (!scene.sampleHeightSupported) throw new Error('当前显卡缺少深度纹理支持，无法采样实景模型。');
    // No regular-view tiles are needed. The most-detailed ray pass drives tile requests at the CAD coordinates.
    const center = engine.Cartographic.fromCartesian(tileset.boundingSphere.center);
    scene.camera.setView({
      destination: engine.Cartesian3.fromRadians(center.longitude, center.latitude, 20000),
      orientation: { heading: 0, pitch: Math.PI / 2, roll: 0 }
    });
    armDeadline();
    copy = await Promise.race([engine.Cesium3DTileset.fromUrl(tileset.resource, {
      modelMatrix: engine.Matrix4.clone(originalMatrix), ellipsoid: engine.Ellipsoid.clone(tileset.ellipsoid), enableCollision: false, cacheBytes: 96 * 1024 * 1024,
      maximumCacheOverflowBytes: 64 * 1024 * 1024,
    }).then(value => {
      if (closed) { value.destroy(); throw abortError(); }
      return value;
    }), failure]);
    window.clearTimeout(deadline);
    copy.root.transform = engine.Matrix4.clone(rootTransform);
    scene.primitives.add(copy);
    copy.tileFailed.addEventListener(() => fail(new Error('选定倾斜摄影存在读取失败的瓦片。请检查模型文件后重算。')));
    const pump = () => {
      try {
        checkSource();
        if (!Matrix4.equals(originalMatrix, tileset.modelMatrix) || !Matrix4.equals(rootTransform, tileset.root.transform))
          throw new Error('模型位置在取样期间发生变化，请重新计算。');
        scene!.render();
        frame = requestAnimationFrame(pump);
      } catch (error) { fail(error instanceof Error ? error : new Error('模型取样渲染失败。')); }
    };
    pump();
    const analysisScene = scene;
    const mayHit = planningSampleMayHit(scene.ellipsoid, copy.boundingSphere);
    const sample = async (points: readonly PlanningLocation[], onProgress?: SamplingOptions['onProgress']) => {
      if (closed) throw abortError();
      checkSource();
      if (!points.every(validLocation)) throw new Error('规划坐标必须是有效的经纬度。');
      const heights: Array<number | null> = new Array(points.length).fill(null);
      for (let start = 0; start < points.length; start += 32) {
        checkSource();
        const end = Math.min(start + 32, points.length);
        const batch = [], indices: number[] = [];
        for (let i = start; i < end; i++) {
          const p = engine.Cartographic.fromDegrees(points[i].longitude, points[i].latitude);
          if (mayHit(p)) { batch.push(p); indices.push(i); }
        }
        if (batch.length) {
          armDeadline();
          const result = await Promise.race([analysisScene.sampleHeightMostDetailed(batch, [], 0.02), failure]);
          window.clearTimeout(deadline);
          if (result.length !== batch.length) throw new Error('模型取样结果不完整，请重试。');
          for (let i = 0; i < result.length; i++) {
            const z = result[i]?.height;
            if (z === undefined) continue;
            if (!Number.isFinite(z)) throw new Error('模型返回无效高程，请核对瓦片后重试。');
            heights[indices[i]] = z;
          }
        }
        onProgress?.(end, points.length);
      }
      return heights;
    };
    return await Promise.race([run(sample,session.signal), failure]);
  } finally {
    closed = true;
    session.abort();
    cancelAnimationFrame(frame);
    window.clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
    canvas.removeEventListener('webglcontextlost', lostContext);
    // Scene.destroy frees Cesium's resources, but the browser otherwise retains
    // a WebGL context until GC. Repeated solves must not evict the main viewer.
    const releaseContext = scene && canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    try {
      if (scene && !scene.isDestroyed()) scene.destroy();
      if (copy && !copy.isDestroyed()) copy.destroy();
    } finally {
      releaseContext?.loseContext();
      host.remove();
    }
  }
}

export function samplePlanningSurface(
  viewer: Viewer, tileset: Cesium3DTileset, points: readonly PlanningLocation[], options: SamplingOptions = {},
): Promise<Array<number | null>> {
  return withPlanningSurface(viewer, tileset, options, sample => sample(points, options.onProgress));
}

type Triangle = [number, number, number];
type Mesh = { vertices: PlanningVertex[]; triangles: Triangle[] };
function compactMesh(vertices: readonly PlanningVertex[], triangles: readonly (readonly number[])[]) {
  const remap = new Map<number, number>(), used: PlanningVertex[] = [];
  const indices = triangles.map(triangle => {
    if (triangle.length !== 3 || new Set(triangle).size !== 3) throw new Error('无效的临建三角面。');
    return triangle.map(index => {
      if (!Number.isInteger(index) || index < 0 || index >= vertices.length) throw new Error('临建网格索引越界。');
      const v = vertices[index];
      if (!validLocation(v) || !Number.isFinite(v.surfaceHeight) || !Number.isFinite(v.baseHeight) || v.surfaceHeight < v.baseHeight)
        throw new Error('临建网格坐标或高程无效。');
      let to = remap.get(index);
      if (to === undefined) { to = used.length; used.push(v); remap.set(index, to); }
      return to;
    }) as Triangle;
  });
  return { vertices: used, triangles: indices, remap };
}

// Intersect each triangulated building-outline ear with the already covered hardstand triangles.
// Work in nearby metric coordinates for stable clipping, retaining the hardstand's interpolated elevation.
type LocalVertex = { x: number; y: number; h: number };
type XY = { x: number; y: number };
const cross = (a: XY, b: XY, p: XY) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
function clipEdge(poly: LocalVertex[], a: XY, b: XY): LocalVertex[] {
  const out: LocalVertex[] = [];
  if (!poly.length) return out;
  let prev = poly[poly.length - 1], dp = cross(a, b, prev);
  for (const cur of poly) {
    const dc = cross(a, b, cur);
    if ((dp >= 0) !== (dc >= 0)) {
      const t = dp / (dp - dc);
      out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y), h: prev.h + t * (cur.h - prev.h) });
    }
    if (dc >= 0) out.push(cur);
    prev = cur; dp = dc;
  }
  return out;
}

export function buildPlanningStructureMesh(
  kind: PlanningKind, vertices: readonly PlanningVertex[], triangles: readonly (readonly number[])[], structure: PlanningStructure,
): Mesh {
  if (kind === 'road' || !Number.isFinite(structure.height) || structure.height <= 0 || structure.height > 300)
    throw new Error('房屋或棚顶高度必须大于 0 且不超过 300 米。');
  const { footprint } = structure;
  if (footprint.length < 3 || footprint.length > 5000 || !footprint.every(validLocation)) throw new Error('请选择有效的独立建筑闭合轮廓。');
  const origin = footprint[0], yScale = 111319.49, xScale = yScale * Math.cos(CesiumMath.toRadians(origin.latitude));
  if (xScale < 1) throw new Error('此建筑轮廓距极点过近。');
  const wrapDegrees = (degrees: number) => CesiumMath.toDegrees(CesiumMath.negativePiToPi(CesiumMath.toRadians(degrees)));
  const toLocal = (p: PlanningLocation) => new Vector2(
    wrapDegrees(p.longitude - origin.longitude) * xScale,
    (p.latitude - origin.latitude) * yScale,
  );
  const outline = cleanPlanningBoundary(footprint.map(toLocal)).map(p => new Vector2(p.x, p.y));
  const ears = ShapeUtils.triangulateShape(outline, []);
  if (!ears.length) throw new Error('建筑轮廓无法三角化，请检查闭合线。');
  const input: LocalVertex[] = vertices.map(v => {
    const { x, y } = toLocal(v);
    return { x, y, h: v.surfaceHeight };
  });
  const cells = triangles.map(t => {
    const pts = t.map(i => input[i]);
    return {
      pts, minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
      minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y))
    };
  });
  const out: Mesh = { vertices: [], triangles: [] }, keys = new Map<string, number>();
  let maxHeight = -Infinity;
  const add = (v: LocalVertex) => {
    const key = Math.round(v.x * 1e5) + ',' + Math.round(v.y * 1e5);
    const existing = keys.get(key);
    if (existing !== undefined) return existing;
    const index = out.vertices.length;
    out.vertices.push({
      longitude: wrapDegrees(origin.longitude + v.x / xScale),
      latitude: origin.latitude + v.y / yScale, surfaceHeight: v.h, baseHeight: v.h, supportHeight:v.h
    });
    keys.set(key, index);
    maxHeight = Math.max(maxHeight, v.h);
    return index;
  };
  if (ears.length * cells.length > 30_000_000) throw new Error('建筑轮廓过于复杂，请简化该轮廓或调大采样间距。');
  for (const ear of ears) {
    const [a, b, c] = ear.map(i => outline[i]);
    const edges = cross(a, b, c) > 0 ? [a, b, c] : [a, c, b];
    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x), minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
    for (const cell of cells) {
      if (cell.minX > maxX || cell.maxX < minX || cell.minY > maxY || cell.maxY < minY) continue;
      let polygon = cell.pts;
      for (let k = 0; k < 3 && polygon.length; k++) polygon = clipEdge(polygon, edges[k], edges[(k + 1) % 3]);
      for (let i = 1; i + 1 < polygon.length; i++) {
        if (Math.abs(cross(polygon[0], polygon[i], polygon[i + 1])) < 1e-8) continue;
        const tri: Triangle = [add(polygon[0]), add(polygon[i]), add(polygon[i + 1])];
        if (new Set(tri).size === 3) out.triangles.push(tri);
      }
    }
  }
  if (!out.triangles.length) return out;
  // A level roof with the specified minimum clearance above the highest covered slab point.
  const roof = maxHeight + structure.height;
  for (const v of out.vertices) {
    v.surfaceHeight = roof;
    if (kind === 'steel') v.baseHeight = roof - Math.min(0.18, structure.height / 10);
  }
  return out;
}

function makeGeometry(values: Float64Array, indices: number[], sphere: BoundingSphere, surface:Float32Array) {
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values });
  Object.assign(attributes,{twSurface:new GeometryAttribute({componentDatatype:ComponentDatatype.FLOAT,componentsPerAttribute:3,values:surface})});
  return new Geometry({
    attributes, indices: values.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    primitiveType: PrimitiveType.TRIANGLES, boundingSphere: sphere
  });
}

export function planningBoundary(triangles: readonly (readonly number[])[]): Array<[number, number]> {
  const edges = new Map<string, [number, number]>();
  for (const t of triangles) for (let j = 0; j < 3; j++) {
    const a = t[j], b = t[(j + 1) % 3], key = Math.min(a, b) + ',' + Math.max(a, b);
    if (edges.has(key)) edges.delete(key);
    else edges.set(key, [a, b]);
  }
  return [...edges.values()];
}

// High-frequency detail lives in the fragment shader, so photographic density does not add road vertices.
function surfaceCoordinates(vertices:readonly PlanningVertex[],layers:number,finish:number,center:PlanningLocation) {
  const uv=new Float32Array(vertices.length*layers*3);
  const east=111319.49*Math.cos(CesiumMath.toRadians(center.latitude));
  for(let i=0;i<vertices.length;i++) {
    const p=vertices[i], x=p.roadStation??(p.longitude-center.longitude)*east, y=p.roadOffset??(p.latitude-center.latitude)*111319.49;
    for(let z=0;z<layers;z++) {
      const j=(z*vertices.length+i)*3;
      uv[j]=x;uv[j+1]=y;uv[j+2]=finish;
    }
  }
  return uv;
}

function meshInstances(mesh: Mesh, top: string, side: string) {
  const { vertices, triangles } = mesh, n = vertices.length;
  const values = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    const v = vertices[i];
    const top = Cartesian3.fromDegrees(v.longitude, v.latitude, v.surfaceHeight);
    const base = Cartesian3.fromDegrees(v.longitude, v.latitude, v.baseHeight);
    values.set([top.x, top.y, top.z], i * 3);
    values.set([base.x, base.y, base.z], (i + n) * 3);
  }
  const sphere = BoundingSphere.fromVertices(values), shell: number[] = [];
  for (const [a, b, c] of triangles) shell.push(c + n, b + n, a + n);
  for (const [a, b] of planningBoundary(triangles)) shell.push(a, b + n, b, a, a + n, b + n);
  const instance = (indices: number[], color: string, finish:number) => new GeometryInstance({
    geometry: makeGeometry(values, indices, sphere, surfaceCoordinates(vertices,2,finish,vertices[0])),
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color)) }
  });
  return { sphere, instances: [instance(triangles.flat(), top,2), instance(shell, side,4)] };
}

type RoadEdge = {a:number; b:number; face:number};

function* roadBoundarySteps(vertices:readonly PlanningVertex[], triangles:readonly (readonly number[])[]) {
  const pending = new Map<string,RoadEdge>(), physical = new Map<string,number>();
  const canonical = new Uint32Array(vertices.length);
  function id(i:number) {
    if (canonical[i]) return canonical[i];
    const v = vertices[i];
    if (!v || !Number.isFinite(v.formationHeight) || !Number.isFinite(v.baseHeight) || !Number.isFinite(v.surfaceHeight))
      throw new Error('便道网格索引或分层高程无效。');
    const key = [v.longitude,v.latitude,v.surfaceHeight.toFixed(7),v.baseHeight.toFixed(7),v.formationHeight!.toFixed(7)].join('/');
    const found = physical.get(key) ?? i+1;
    physical.set(key,found);
    return canonical[i] = found;
  }
  for (let face=0;face<triangles.length;face++) {
    const t=triangles[face];
    for (let j=0;j<3;j++) {
      const a=t[j], b=t[(j+1)%3], ia=id(a), ib=id(b);
      const key=ia<ib ? ia+'/'+ib : ib+'/'+ia;
      if (!pending.delete(key)) pending.set(key,{a,b,face});
    }
    if ((face+1)%2048===0) yield;
  }
  return [...pending.values()];
}
function roadBoundary(vertices:readonly PlanningVertex[], triangles:readonly (readonly number[])[]) {
  const steps=roadBoundarySteps(vertices,triangles);
  for (;;) { const step=steps.next(); if (step.done) return step.value; }
}

// The road is one layered trapezoid. Its side faces follow the calculated
// breaklines at the pavement shoulder, hardening base edge and treatment toe.
function roadMeshInstances(mesh: Mesh, road: PlanningRoadView, exposed?: [number, number][]) {
  const { vertices, triangles } = mesh, n = vertices.length;
  const positions = new Float64Array(n * 9);
  const endVertices: Array<{ vertex: PlanningVertex; atStart: boolean }> = [];
  let hasStart = false, hasEnd = false;
  for (const [i, v] of vertices.entries()) {
    if ((v.roadPart !== 'core' && v.roadPart !== 'slope') || !Number.isFinite(v.roadStation)
      || !Number.isFinite(v.roadOffset) || !Number.isFinite(v.formationHeight) || v.formationHeight! > v.baseHeight + 1e-7)
      throw new Error('便道网格缺少分层高程或里程，请重新计算。');
    for (const [layer, height] of [v.surfaceHeight, v.baseHeight, v.formationHeight!].entries()) {
      const cart = Cartesian3.fromDegrees(v.longitude, v.latitude, height);
      positions.set([cart.x, cart.y, cart.z], (layer * n + i) * 3);
    }
    // A cropped road need not contain either CAD endpoint. Only mark the
    // original centerline vertex when it belongs to a retained triangle.
    if (v.roadPart === 'core' && Math.abs(v.roadOffset!) < 1e-5) {
      if (!hasStart && Math.abs(v.roadStation!) < 1e-5) {
        endVertices.push({vertex:v, atStart:true}); hasStart = true;
      } else if (!hasEnd && Math.abs(v.roadStation! - road.length) < 1e-5) {
        endVertices.push({vertex:v, atStart:false}); hasEnd = true;
      }
    }
  }
  const sphere = BoundingSphere.fromVertices(positions);
  const pavement: number[] = [], upperSlopes: number[] = [], lowerSlopes: number[] = [];
  const upperWalls: number[] = [], lowerWalls: number[] = [], bottom: number[] = [];
  // A whole outer arc can share one chainage/radius pair. Weld actual positions
  // with identical layer levels; a butt-end step in an overlap stays exposed.
  for (const t of triangles) {
    const onPavement = t.every(i => Math.abs(vertices[i].roadOffset!) <= road.width / 2 + 1e-7);
    const hasHardening = t.some(i => vertices[i].surfaceHeight > vertices[i].baseHeight + 1e-7);
    const face = onPavement ? pavement : hasHardening ? upperSlopes : lowerSlopes;
    face.push(t[0], t[1], t[2]);
    if (t.some(i => vertices[i].surfaceHeight > vertices[i].formationHeight! + 1e-7))
      bottom.push(t[2] + 2*n, t[1] + 2*n, t[0] + 2*n);
  }
  for (const [i, j] of exposed ?? roadBoundary(vertices, triangles).map(e => [e.a, e.b])) {
    const p = vertices[i], q = vertices[j];
    if (p.surfaceHeight > p.baseHeight + 1e-7 || q.surfaceHeight > q.baseHeight + 1e-7)
      upperWalls.push(i, j + n, j, i, i + n, j + n);
    if (p.baseHeight > p.formationHeight! + 1e-7 || q.baseHeight > q.formationHeight! + 1e-7)
      lowerWalls.push(i + n, j + 2*n, j + n, i + n, i + 2*n, j + 2*n);
  }
  const instances: GeometryInstance[] = [], overlayFaces: GeometryInstance[] = [];
  function add(indices: number[], color: string, finish:number, topFace = false) {
    if (!indices.length) return;
    const item = new GeometryInstance({
      geometry: makeGeometry(positions, indices, sphere, surfaceCoordinates(vertices,3,finish,vertices[0])),
      attributes: {color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color))},
    });
    instances.push(item);
    if (topFace) overlayFaces.push(item);
  }
  add(pavement, '#b7b4aa', 1,true);
  add(upperSlopes, '#9b9689', 3,true);
  add(lowerSlopes, '#9e856b', 4,true);
  add(upperWalls, '#8e897e',3);
  add(lowerWalls, '#9a7a59',4);
  add(bottom, '#745e4b',4);
  return {sphere, instances, overlayFaces, endVertices};
}

function roadStationLabel(viewer: Viewer, vertex: PlanningVertex, atStart: boolean, length: number) {
  const color = Color.fromCssColorString(atStart ? '#47e2a1' : '#ffd080');
  const distanceDisplayCondition = new DistanceDisplayCondition(0, Math.max(2000, length * 8));
  return viewer.entities.add({
    position: Cartesian3.fromDegrees(vertex.longitude, vertex.latitude, vertex.surfaceHeight),
    point: { pixelSize: 8, color, outlineWidth: 2, outlineColor: Color.BLACK,
      disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition },
    label: { text: (atStart ? '起点 ' : '终点 ') + formatRoadStation(atStart ? 0 : length),
      font: 'bold 13px sans-serif', style: LabelStyle.FILL_AND_OUTLINE, fillColor: color,
      outlineColor: Color.BLACK, outlineWidth: 3, showBackground: true,
      backgroundColor: Color.fromCssColorString('#142433').withAlpha(0.86),
      verticalOrigin: atStart ? VerticalOrigin.BOTTOM : VerticalOrigin.TOP,
      pixelOffset: new Cartesian2(0, atStart ? -8 : 8), disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition },
  });
}

/** Use the same metre-space compound as the standalone reference. The design pad
 * supplies its horizontal fit and floor heights while the plan retains its real cut/fill mesh. */
function standardSiteInstances(kind:'camp'|'steel', base:Mesh, site:PlanningStandardSite, yard:boolean) {
  const origin=base.vertices[0];
  const enu=Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(origin.longitude,origin.latitude));
  const inverse=Matrix4.inverseTransformation(enu,new Matrix4());
  const local=(p:PlanningLocation)=>Matrix4.multiplyByPoint(inverse,Cartesian3.fromDegrees(p.longitude,p.latitude),new Cartesian3());
  const geo=(x:number,y:number)=>Cartographic.fromCartesian(Matrix4.multiplyByPoint(enu,new Cartesian3(x,y,0),new Cartesian3()));
  const boundary=site.boundary.map(p=>{const {x,y}=local(p); return [x,y] as PlanPair;});
  const vertices=base.vertices.map(p=>{const {x,y}=local(p); return {x,y,z:p.surfaceHeight};});
  const fit=buildStandardSiteLayout(kind,boundary,vertices,base.triangles);
  const center=geo(...fit.center);
  const floor=fit.altitude(...fit.center);
  const instances:GeometryInstance[]=[];
  const roofs:GeometryInstance[]=[];
  let bounds:BoundingSphere|undefined;
  function add(role:string, material:string, color:string, positions:readonly number[], indices:number[],
    onSurface:boolean, tex?:readonly number[]) {
    const ecef=new Float64Array(positions.length), uv=new Float32Array(positions.length);
    for (let i=0; i<positions.length; i+=3) {
      const [x,y]=fit.toLocal(positions[i],positions[i+1]);
      const p=geo(x,y);
      const ground=onSurface ? fit.altitude(x,y) : floor;
      const xyz=Cartesian3.fromRadians(p.longitude,p.latitude,ground+positions[i+2]*fit.scale);
      ecef[i]=xyz.x; ecef[i+1]=xyz.y; ecef[i+2]=xyz.z;
      if(tex) {
        uv[i]=tex[2*i/3]; uv[i+1]=tex[2*i/3+1]; uv[i+2]=material==='roof' ? 5 : 0;
      }
    }
    const sphere=BoundingSphere.fromVertices(ecef);
    bounds=bounds ? BoundingSphere.union(bounds,sphere,bounds) : BoundingSphere.clone(sphere);
    const instance = new GeometryInstance({id:`tw-standard/${kind}/${role}/${material}`,
      geometry:makeGeometry(ecef,indices,sphere,uv),
      attributes:{color:ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color))}});
    instances.push(instance);
    if (material==='roof') roofs.push(instance);
  }
  for (const b of standardSiteBuildings[kind]) {
    const outline:PlanPair[]=[
      [b.x-b.length/2,b.y-b.width/2], [b.x+b.length/2,b.y-b.width/2],
      [b.x+b.length/2,b.y+b.width/2], [b.x-b.length/2,b.y+b.width/2],
    ];
    const supports=outline.map(([x,y])=>({x,y,z:(fit.altitude(...fit.toLocal(x,y))-floor)/fit.scale}));
    // Build in the compound's own axes so that the signed facade still faces the
    // entrance after the site turns. Roofs stay level above the graded supports.
    for (const part of facilityGeometry(kind,{outline,vertices:supports,triangles:[[0,1,2],[0,2,3]],
      height:b.height,showCompanySign:b.showCompanySign})) {
      add(b.role,part.finish,finishes[part.finish],part.positions,part.indices,false,part.uv);
    }
  }
  for (const part of buildStandardSiteDecor(kind,yard)) {
    add(part.role,part.color,part.color,part.positions,part.indices,true);
  }
  const roles=standardSiteBuildings[kind].map(b=>b.role);
  const angle=Math.atan2(fit.axis[1],fit.axis[0]);
  const info:StandardPlacementInfo={longitude:CesiumMath.toDegrees(center.longitude),latitude:CesiumMath.toDegrees(center.latitude),
    scale:fit.scale,rotationDeg:CesiumMath.toDegrees(angle),
    roles,cars:kind==='camp' && yard ? 3 : 0};
  return {instances,roofs,bounds:bounds!,info,angle};
}

function renderMeshPart(viewer:Viewer, kind:PlanningKind, base:Mesh, structures?:PlanningStructure | PlanningStructure[],
  road?:PlanningRoadView, exposed?:[number,number][], showEndLabels=true, campYard=false, site?:PlanningStandardSite) {
  if (!base.triangles.length) throw new Error('没有可显示的有效硬化面。');
  const colors = { road: ['#b7b4aa', '#8e897e'], camp: ['#b8b4aa', '#8d8778'], steel: ['#aaa9a1', '#89877f'] }[kind];
  const roadBody = kind === 'road' && road ? roadMeshInstances(base, road, exposed) : undefined;
  const slab = roadBody ?? meshInstances(base, colors[0], colors[1]);
  const overlayFaces = roadBody?.overlayFaces ?? [slab.instances[0]];
  let sphere = slab.sphere;
  const standard = site && kind!=='road' ? standardSiteInstances(kind,base,site,campYard) : undefined;
  if (standard) {
    for (const instance of standard.instances) slab.instances.push(instance);
    overlayFaces.push(...standard.roofs);
    sphere=BoundingSphere.union(sphere,standard.bounds);
  }
  const outlines = !standard && structures ? Array.isArray(structures) ? structures : [structures] : [];
  // A campus has one office nameplate. Choose the largest sign that actually fits
  // on a surveyed original facade, including when some buildings are clipped away.
  let campSignArea = 0;
  let addCampSign: (() => void) | undefined;
  const structureBuilt = standard ? standard.info.roles.map(()=>true) : outlines.map(outline => {
    const building = buildPlanningStructureMesh(kind, base.vertices, base.triangles, outline);
    if (!building.triangles.length) return false;
    const origin=outline.footprint[0], latScale=111319.49, lonScale=latScale*Math.cos(CesiumMath.toRadians(origin.latitude));
    const toXY=(p:PlanningLocation):PlanPair=>[
      CesiumMath.toDegrees(CesiumMath.negativePiToPi(CesiumMath.toRadians(p.longitude-origin.longitude)))*lonScale,
      (p.latitude-origin.latitude)*latScale];
    const shapes=facilityGeometry(kind==='steel'?'steel':'camp',{
      outline:outline.footprint.map(toXY),height:outline.height,triangles:building.triangles,
      vertices:building.vertices.map(v=>{const [x,y]=toXY(v);return {x,y,z:v.supportHeight!};}),
    });
    function drawPart(part: (typeof shapes)[number]) {
      const ecef=new Float64Array(part.positions.length),uv=new Float32Array(part.positions.length);
      const code=part.finish==='roof'?5:0;
      for(let i=0;i<ecef.length;i+=3) {
        const p=Cartesian3.fromDegrees(origin.longitude+part.positions[i]/lonScale,origin.latitude+part.positions[i+1]/latScale,part.positions[i+2]);
        ecef[i]=p.x;ecef[i+1]=p.y;ecef[i+2]=p.z;
        uv[i]=part.uv[i/3*2];uv[i+1]=part.uv[i/3*2+1];uv[i+2]=code;
      }
      const bound=BoundingSphere.fromVertices(ecef);
      const instance=new GeometryInstance({geometry:makeGeometry(ecef,part.indices,bound,uv),
        attributes:{color:ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(finishes[part.finish]))}});
      slab.instances.push(instance);
      if(part.finish==='roof')overlayFaces.push(instance);
      sphere=BoundingSphere.union(sphere,bound);
    }
    if (kind === 'camp') {
      const signParts = shapes.filter(part => part.finish.startsWith('sign'));
      const face = signParts.find(part => part.finish === 'signFace')?.positions;
      if (face) {
        const area = Math.hypot(face[3]-face[0], face[4]-face[1]) * (face[11]-face[2]);
        if (area > campSignArea) {
          campSignArea = area;
          addCampSign = () => signParts.forEach(drawPart);
        }
      }
      shapes.filter(part => !part.finish.startsWith('sign')).forEach(drawPart);
    } else shapes.forEach(drawPart);
    return true;
  });
  addCampSign?.();
  const builtStructureCount = structureBuilt.filter(Boolean).length;
  let yard = {flag:false, spaces:0};
  if (standard && kind==='camp' && campYard) yard={flag:true,spaces:5};
  if (!standard && kind==='camp' && campYard) {
    const origin=base.vertices[0], north=111319.49, east=north*Math.cos(CesiumMath.toRadians(origin.latitude));
    const xy=(p:PlanningLocation):PlanPair=>[
      CesiumMath.toDegrees(CesiumMath.negativePiToPi(CesiumMath.toRadians(p.longitude-origin.longitude)))*east,
      (p.latitude-origin.latitude)*north,
    ];
    const layout=buildCampYard(base.vertices.map(v=>{const [x,y]=xy(v);return {x,y,z:v.surfaceHeight};}),
      base.triangles,outlines.map(s=>s.footprint.map(xy)));
    yard={flag:layout.flag,spaces:layout.spaces};
    for (const part of layout.batches) {
      const ecef=new Float64Array(part.positions.length);
      for(let i=0;i<part.positions.length;i+=3) {
        const p=Cartesian3.fromDegrees(origin.longitude+part.positions[i]/east,origin.latitude+part.positions[i+1]/north,part.positions[i+2]);
        ecef[i]=p.x;ecef[i+1]=p.y;ecef[i+2]=p.z;
      }
      const bound=BoundingSphere.fromVertices(ecef);
      slab.instances.push(new GeometryInstance({geometry:makeGeometry(ecef,part.indices,bound,new Float32Array(ecef.length)),
        attributes:{color:ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(part.color))}}));
      sphere=BoundingSphere.union(sphere,bound);
    }
  }
  // Depth-tested mode shows true occlusion; the planning overlay also reveals hardening in cut areas.
  // Draw only roof/top surfaces in the overlay, otherwise the floor underside can paint over the design.
  // The cutaway of a site must not paint an opaque slab over its own offices,
  // gate, lettering or parking. Keep depth-tested facility solids in front and
  // use a faint overlay only for surveyed surfaces that are actually occluded.
  const facilityCutaway = kind!=='road' && (builtStructureCount>0 || yard.flag || yard.spaces>0);
  const xrayFaces = facilityCutaway ? overlayFaces.map(face=>{
    const [r,g,b]=face.attributes.color.value;
    return new GeometryInstance({geometry:face.geometry,attributes:{
      color:ColorGeometryInstanceAttribute.fromColor(Color.fromBytes(r,g,b,48))}});
  }) : overlayFaces;
  const appearance = (overlay: boolean) => new PerInstanceColorAppearance({
    flat: true, closed: false, translucent: overlay, vertexShaderSource:finishVertexShader, fragmentShaderSource:finishFragmentShader,
    renderState: { depthTest: { enabled: !overlay || facilityCutaway,
      func:overlay && facilityCutaway ? DepthFunction.GREATER : DepthFunction.LESS_OR_EQUAL },
      depthMask: !overlay, cull: { enabled: false } }
  });
  const solid = new Primitive({ geometryInstances: slab.instances, appearance: appearance(false), asynchronous: false, allowPicking: false, compressVertices:false });
  const overlay = new Primitive({
    geometryInstances: xrayFaces, appearance: appearance(true),
    asynchronous: false, allowPicking: false, compressVertices:false
  });
  let visible = true, xray = true, destroyed = false;
  const collection = viewer.scene.primitives;
  const labels: Entity[] = [];
  try {
    collection.add(solid); collection.add(overlay);
    if (road && roadBody && showEndLabels) for (const {vertex, atStart} of roadBody.endVertices) {
      labels.push(roadStationLabel(viewer, vertex, atStart, road.length));
    }
  } catch (error) {
    for (const label of labels) viewer.entities.remove(label);
    collection.remove(solid); collection.remove(overlay);
    if (!solid.isDestroyed()) solid.destroy();
    if (!overlay.isDestroyed()) overlay.destroy();
    throw error;
  }
  const refresh = () => {
    if (destroyed) return;
    solid.show = visible;
    overlay.show = visible && xray;
    for (const label of labels) label.show = visible;
    viewer.scene.requestRender();
  };
  refresh();
  return {
    yard, standardPlacement:standard?.info, bounds: sphere, endpoints: roadBody?.endVertices ?? [], ready: Promise.resolve(), hasStructure: builtStructureCount > 0, builtStructureCount, structureBuilt,
    get show() { return visible; },
    set show(value: boolean) { visible = value; refresh(); },
    get xray() { return xray; },
    set xray(value: boolean) { xray = value; refresh(); },
    zoom() {
      const target=standard?.bounds ?? sphere;
      if (!destroyed) viewer.camera.flyToBoundingSphere(target, {
        offset:standard ? new HeadingPitchRange(-standard.angle-.38,-.50,Math.max(15,target.radius*3.1))
          : new HeadingPitchRange(0,-.85,Math.max(15,target.radius*3.1)),
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (!viewer.isDestroyed()) {
        for (const label of labels) viewer.entities.remove(label);
        collection.remove(overlay);
        collection.remove(solid);
        viewer.scene.requestRender();
      }
    },
  };
}

/** Keep the synchronous lifecycle API so cancellation, saved-plan visibility and removal also work mid-upload. */
export function renderPlanningMesh(viewer: Viewer, kind: PlanningKind, vertices: readonly PlanningVertex[],
  triangles: readonly (readonly number[])[], structures?: PlanningStructure | PlanningStructure[], road?: PlanningRoadView, campYard=false, site?:PlanningStandardSite) {
  if (!road || kind !== 'road' || structures || triangles.length <= 8192)
    return renderMeshPart(viewer, kind, compactMesh(vertices, triangles), structures, road, undefined, true, campYard, site);

  const parts: ReturnType<typeof renderMeshPart>[] = [];
  const labels: Entity[] = [];
  const bounds = new BoundingSphere();
  let visible = true, xray = true, destroyed = false, finished = false, zoomRequested = false;

  function zoom() {
    if (destroyed || viewer.isDestroyed()) return;
    if (!finished) { zoomRequested = true; return; }
    viewer.camera.flyToBoundingSphere(bounds, {
      offset: new HeadingPitchRange(0, -0.85, Math.max(15, bounds.radius * 3.1)),
    });
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const part of parts) part.destroy();
    if (!viewer.isDestroyed()) for (const label of labels) viewer.entities.remove(label);
  }
  const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  function nextRenderFrame() {
    if (typeof requestAnimationFrame !== 'function' || document.visibilityState !== 'visible') return nextTask();
    return new Promise<void>(resolve => {
      const frame = requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
      // A newly backgrounded tab may stop receiving animation frames.
      const timeout = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 100);
    });
  }
  const ready = (async () => {
    await nextTask();
    const steps = roadBoundarySteps(vertices, triangles);
    let step: IteratorResult<void, RoadEdge[]>;
    do {
      if (destroyed || viewer.isDestroyed()) return;
      step = steps.next();
      if (!step.done) await nextTask();
    } while (!step.done);

    // Only real global boundaries gain walls. Chunk cuts and duplicated shoulder vertices are internal seams.
    const chunkSize = 4096;
    const walls = new Map<number, RoadEdge[]>();
    for (const edge of step.value) {
      const chunk = Math.floor(edge.face / chunkSize);
      if (!walls.has(chunk)) walls.set(chunk, []);
      walls.get(chunk)!.push(edge);
    }
    const marked = new Set<boolean>();
    for (let start = 0; start < triangles.length; start += chunkSize) {
      if (destroyed || viewer.isDestroyed()) return;
      const mesh = compactMesh(vertices, triangles.slice(start, start + chunkSize));
      const exposed: [number, number][] = (walls.get(start / chunkSize) ?? [])
        .map(({a, b}) => [mesh.remap.get(a)!, mesh.remap.get(b)!]);
      const part = renderMeshPart(viewer, kind, mesh, undefined, road, exposed, false);
      if (!parts.length) BoundingSphere.clone(part.bounds, bounds);
      else BoundingSphere.union(bounds, part.bounds, bounds);
      parts.push(part);
      part.show = visible;
      part.xray = xray;
      for (const { vertex, atStart } of part.endpoints) {
        if (marked.has(atStart)) continue;
        const label = roadStationLabel(viewer, vertex, atStart, road.length);
        label.show = visible;
        marked.add(atStart);
        labels.push(label);
      }
      await nextRenderFrame();
    }
    finished = true;
    if (zoomRequested) zoom();
  })().catch(error => { destroy(); throw error; });

  return {
    yard: {flag:false, spaces:0}, standardPlacement:undefined, bounds, ready, hasStructure: false, builtStructureCount: 0, structureBuilt: [] as boolean[],
    get show() { return visible; },
    set show(value: boolean) {
      visible = value;
      for (const part of parts) part.show = value;
      for (const label of labels) label.show = value;
    },
    get xray() { return xray; },
    set xray(value: boolean) {
      xray = value;
      for (const part of parts) part.xray = value;
    },
    zoom, destroy,
  };
}
