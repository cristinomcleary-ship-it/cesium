import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  Axis, Cartesian2, Cartesian3, Cartographic, Cesium3DTileset, Color, HeadingPitchRange,
  Math as CesiumMath, Matrix4, Model, SceneTransforms, Transforms, Viewer,
} from 'cesium';
import { buildSurfaceEditGeometry } from '../../src/surfaceEditGeometry';
import { SurfaceEditScene, type SurfaceEditHandle } from '../../src/surfaceEditScene';
import type { SurfaceEditPlan } from '../../src/surfaceEditTypes';
import { getTemporaryWorksClippingManager } from '../../src/temporaryWorksGlbScene';

// Entirely synthetic 3D Tiles/GLB data. No user project, SDK, credentials or remote
// imagery is loaded, and no product persistence routes are called by this fixture.
const viewer = new Viewer('viewer', { baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false, navigationHelpButton: false,
  infoBox: false, selectionIndicator: false, showRenderLoopErrors: false,
  contextOptions: { webgl: { preserveDrawingBuffer: true, alpha: true } } });
viewer.scene.globe.baseColor = Color.fromCssColorString('#57554e');
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.enableLighting = false;
viewer.scene.globe.showGroundAtmosphere = false;
viewer.scene.highDynamicRange = false;
viewer.scene.postProcessStages.fxaa.enabled = false;
if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
if (viewer.scene.sun) viewer.scene.sun.show = false;
if (viewer.scene.moon) viewer.scene.moon.show = false;
const errors: string[] = [], urls: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => errors.push(String(error.stack || error)));
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 0));
const world = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
const geo = (point: Cartesian3) => { const p = Cartographic.fromCartesian(point); return { longitude: CesiumMath.toDegrees(p.longitude), latitude: CesiumMath.toDegrees(p.latitude), height: p.height }; };
const blobUrl = (blob: Blob) => { const url = URL.createObjectURL(blob); urls.push(url); return url; };
const jsonUrl = (data: unknown) => blobUrl(new Blob([JSON.stringify(data)], { type: 'application/json' }));
const faces = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7];
function cube(x: number, y: number, bottom: number, top: number, radius: number) {
  return Array.from({ length: 8 }, (_, mask) => [x + (mask & 1 ? radius : -radius), y + (mask & 2 ? radius : -radius), mask & 4 ? top : bottom]);
}
function glb(parts: { points: number[][]; indices: number[]; color: number[] }[]) {
  const chunks: Uint8Array[] = [], views: object[] = [], accessors: object[] = [], primitives: object[] = [];
  let offset = 0;
  const append = (values: Float32Array | Uint16Array, target: number) => {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4); padded.set(bytes);
    const i = views.length; views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(padded); offset += padded.length; return i;
  };
  for (const part of parts) {
    const position = append(new Float32Array(part.points.flat()), 34962), index = append(new Uint16Array(part.indices), 34963), accessor = accessors.length;
    accessors.push({ bufferView: position, componentType: 5126, count: part.points.length, type: 'VEC3',
      min: [0, 1, 2].map(i => Math.min(...part.points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...part.points.map(p => p[i]))) });
    accessors.push({ bufferView: index, componentType: 5123, count: part.indices.length, type: 'SCALAR' });
    primitives.push({ attributes: { POSITION: accessor }, indices: accessor + 1, material: primitives.length });
  }
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives }],
    buffers: [{ byteLength: offset }], bufferViews: views, accessors, extensionsUsed: ['KHR_materials_unlit'],
    materials: parts.map(p => ({ doubleSided: true, extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: p.color } })) };
  const encoded = new TextEncoder().encode(JSON.stringify(json)), jsonLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + offset), data = new DataView(bytes.buffer);
  data.setUint32(0, 0x46546c67, true); data.setUint32(4, 2, true); data.setUint32(8, bytes.length, true);
  data.setUint32(12, jsonLength, true); data.setUint32(16, 0x4e4f534a, true); bytes.fill(32, 20, 20 + jsonLength); bytes.set(encoded, 20);
  data.setUint32(20 + jsonLength, offset, true); data.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return blobUrl(new Blob([bytes], { type: 'model/gltf-binary' }));
}
const renderFrames = (count = 4) => new Promise<void>((resolve, reject) => {
  let frames = 0; const timer = setTimeout(() => { stop(); reject(new Error('Synthetic scene frame timeout: ' + errors.join('\n'))); }, 20_000);
  const stop = viewer.scene.postRender.addEventListener(() => { if (++frames >= count) { clearTimeout(timer); stop(); resolve(); } });
  viewer.scene.requestRender();
});
const waitUntil = async (test: () => boolean) => { const started = performance.now(); while (!test()) {
  if (performance.now() - started > 45_000) throw new Error('Synthetic geometry did not become ready'); await renderFrames(1);
} };
let tiles: Cesium3DTileset, engineering: Model, renderer: SurfaceEditScene;
const handles = new Map<string, SurfaceEditHandle>(), plans = new Map<string, SurfaceEditPlan>();
const camera = async (x = 0, distance = 170, pitch = -0.9) => {
  viewer.camera.lookAt(world(x, 0, 0), new HeadingPitchRange(0.2, pitch, distance));
  viewer.camera.lookAtTransform(Matrix4.IDENTITY); await renderFrames();
};
function pixel(x: number, y: number, z: number) {
  const screen = SceneTransforms.worldToWindowCoordinates(viewer.scene, world(x, y, z));
  if (!screen) throw new Error('Probe is outside the screen');
  const canvas = document.createElement('canvas'); canvas.width = viewer.canvas.width; canvas.height = viewer.canvas.height;
  const context = canvas.getContext('2d')!; context.drawImage(viewer.canvas, 0, 0);
  const px = Math.round(screen.x * viewer.canvas.width / viewer.canvas.clientWidth), py = Math.round(screen.y * viewer.canvas.height / viewer.canvas.clientHeight);
  const color = [...context.getImageData(px, py, 1, 1).data];
  const pick = viewer.scene.pick(new Cartesian2(screen.x, screen.y));
  return { color, pickedEngineering: pick?.primitive === engineering, screen: [screen.x, screen.y] };
}
const state = () => ({
  photographyClips: tiles.clippingPolygons?.length ?? 0,
  terrainClips: viewer.scene.globe.clippingPolygons?.length ?? 0,
  terrainEnabled: viewer.scene.globe.clippingPolygons?.enabled ?? false,
  engineeringClipped: !!engineering.clippingPolygons || !!engineering.clippingPlanes,
  engineeringMatrix: Matrix4.toArray(engineering.modelMatrix), engineeringShow: engineering.show,
  primitiveCount: viewer.scene.primitives.length, surfacePrimitiveCount: renderer.getPrimitives().length,
  states: Object.fromEntries([...handles].map(([id, handle]) => [id, handle.status])), errors: [...errors],
});
async function create(kind: 'excavation' | 'flatten', id: string, x = 0) {
  const target = kind === 'excavation' ? -15 : 5, center = world(x, 0, target);
  const modelMatrix = Transforms.eastNorthUpToFixedFrame(center), inverse = Matrix4.inverseTransformation(modelMatrix, new Matrix4());
  const points = [[x - 30, -30, 5], [x + 30, -30, 5], [x + 30, 30, 5], [x - 30, 30, 5]];
  const boundary = points.map(([a, b, c]) => geo(world(a, b, c)));
  const plan: SurfaceEditPlan = { version: 1, id, name: id, kind, targetId: 'synthetic-photography', targetTransform: Matrix4.toArray(tiles.modelMatrix),
    boundary, holes: [], targetHeight: geo(center).height, clipTerrain: true, bottomVisible: true,
    texture: { ground: kind === 'flatten' ? 'sand' : 'soil', wall: 'soil', scaleMeters: 3 }, enabled: true, createdAt: '', updatedAt: '' };
  const local = boundary.map(p => Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(p.longitude, p.latitude, p.height), new Cartesian3()));
  const geometry = buildSurfaceEditGeometry({ mode: kind, outer: local, targetElevation: 0, textureScaleMeters: 3 });
  const previous = handles.get(id), terrain = viewer.scene.globe.clippingPolygons;
  const handle = await renderer.prepare(plan, geometry, modelMatrix, tiles);
  const status = handle.setEnabled(true);
  if (status.state !== 'ready') { handle.destroy(); throw new Error(status.message); }
  handles.set(id, handle); plans.set(id, plan); previous?.destroy();
  await renderFrames(6);
  return { ...state(), retainedTerrainObject: !terrain || terrain === viewer.scene.globe.clippingPolygons, geometricSamples: geometry.sampleCount };
}
const api = {
  ready: false, failure: '', state, camera, pixel,
  async create(kind: 'excavation' | 'flatten', id: string, x: number) { return create(kind, id, x); },
  async enabled(id: string, value: boolean) { const handle = handles.get(id); if (!handle) throw new Error('Unknown fixture plan'); handle.setEnabled(value); await renderFrames(); return state(); },
  async remove(id: string) { handles.get(id)?.destroy(); handles.delete(id); plans.delete(id); await renderFrames(); return state(); },
  async suspend(value: boolean) { renderer.setSuspended(value); await renderFrames(); return state(); },
  async legacy(value: boolean) {
    const manager = getTemporaryWorksClippingManager(viewer);
    if (value) manager.upsert({ id: 'synthetic-building', tileset: tiles, footprints: [{ outer: [[-110, -20, 5], [-70, -20, 5], [-70, 20, 5], [-110, 20, 5]].map(([x, y, z]) => geo(world(x, y, z))) }] });
    else manager.remove('synthetic-building');
    await renderFrames(); return state();
  },
  async abort() {
    const before = state(), plan = { ...plans.values().next().value!, id: 'cancelled' };
    const controller = new AbortController(), matrix = Transforms.eastNorthUpToFixedFrame(world(0, 0, -15));
    const geometry = buildSurfaceEditGeometry({ mode: 'excavation', targetElevation: 0, outer: [
      { x: -15, y: -15, z: 20 }, { x: 15, y: -15, z: 20 }, { x: 15, y: 15, z: 20 }, { x: -15, y: 15, z: 20 }] });
    const promise = renderer.prepare(plan, geometry, matrix, tiles, controller.signal); controller.abort();
    let failure = ''; try { const handle = await promise; handle.destroy(); } catch (error) { failure = (error as Error).name; }
    await renderFrames(); return { before, after: state(), failure };
  },
  gpu() {
    const gl = viewer.canvas.getContext('webgl2')!, extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: !!gl, renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) };
  },
  errors: () => [...errors],
  destroy() { renderer?.destroy(); getTemporaryWorksClippingManager(viewer).dispose(); viewer.destroy(); for (const url of urls) URL.revokeObjectURL(url); },
};
Object.assign(window, { __surfaceEditFixture: api });
void (async () => {
  const photo = glb([
    { points: [[-160, -160, 5], [160, -160, 5], [160, 160, 5], [-160, 160, 5]], indices: [0, 1, 2, 0, 2, 3], color: [.08, .7, .8, 1] },
    { points: cube(70, 0, 5, 25, 15), indices: faces, color: [.1, .65, .15, 1] },
  ]);
  const bounds = { box: [0, 0, 15, 170, 0, 0, 0, 170, 0, 0, 0, 20] };
  tiles = await Cesium3DTileset.fromUrl(jsonUrl({ asset: { version: '1.1' }, geometricError: 25, root: {
    boundingVolume: bounds, transform: Matrix4.toArray(frame), geometricError: 10, refine: 'REPLACE', content: { uri: photo },
    children: [{ boundingVolume: bounds, geometricError: 0, content: { uri: photo } }],
  } }), { modelUpAxis: Axis.Z, modelForwardAxis: Axis.X, maximumScreenSpaceError: 16, cullRequestsWhileMoving: false });
  viewer.scene.primitives.add(tiles);
  const structure = glb([{ points: cube(0, 0, -10, -2, 5), indices: faces, color: [1, .01, .75, 1] }]);
  engineering = await Model.fromGltfAsync({ url: structure, modelMatrix: Matrix4.clone(frame), upAxis: Axis.Z, forwardAxis: Axis.X });
  viewer.scene.primitives.add(engineering); renderer = new SurfaceEditScene(viewer);
  await camera(); await waitUntil(() => engineering.ready && tiles.tilesLoaded); await renderFrames(6);
  api.ready = true;
})().catch(error => { api.failure = String(error.stack || error); errors.push(api.failure); });
