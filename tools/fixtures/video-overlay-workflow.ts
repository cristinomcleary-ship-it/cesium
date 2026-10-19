import 'cesium/Build/Cesium/Widgets/widgets.css';
import { BoundingSphere, Cartesian3, Cesium3DTileset, Cesium3DTileStyle, Color, CustomDataSource, CustomShader, CustomShaderMode, LightingModel, Matrix3, Matrix4, Model, Transforms, Viewer } from 'cesium';
import { VideoModelOverlay, videoModelOverlayPanelHtml, type SavedVideoOverlaySettings } from '../../src/videoModelOverlay';
import type { ImportRecord } from '../../src/types';
import type { LibraryRecord } from '../../src/projectLibrary';

// Synthetic geometry only. The requested plane URI is fulfilled by Playwright,
// allowing an actual pending 3D Tiles content request to test fail-closed loading.
document.getElementById('panel')!.innerHTML = videoModelOverlayPanelHtml;
const viewer = new Viewer('viewer', { baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false, navigationHelpButton: false,
  infoBox: false, selectionIndicator: false, contextOptions: { webgl: { alpha: true, preserveDrawingBuffer: true } },
  showRenderLoopErrors: false, useBrowserRecommendedResolution: false });
viewer.resolutionScale = 1;
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(120, 30, 0));
const world = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
viewer.camera.setView({ destination: world(0, 0, 200), orientation: {
  direction: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 0, -1), new Cartesian3()),
  up: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 1, 0), new Cartesian3()) } });
const axis = Matrix4.multiply(Matrix4.fromRotationTranslation(Matrix3.fromArray([1, 0, 0, 0, 0, 1, 0, -1, 0])),
  Matrix4.fromRotationTranslation(Matrix3.fromArray([0, 0, -1, 0, 1, 0, 1, 0, 0])), new Matrix4());
const inverseAxis = Matrix4.inverseTransformation(axis, new Matrix4());
function mesh(points: number[][], indices: number[], color: number[], mask = false) {
  const vertices = points.map(point => Matrix4.multiplyByPointAsVector(inverseAxis, Cartesian3.fromArray(point), new Cartesian3()));
  const positions = new Float32Array(vertices.flatMap(p => [p.x, p.y, p.z])), faces = new Uint16Array(indices);
  const binary = new Uint8Array(positions.byteLength + faces.byteLength);
  binary.set(new Uint8Array(positions.buffer)); binary.set(new Uint8Array(faces.buffer), positions.byteLength);
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...binary))}`, byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }, { buffer: 0, byteOffset: positions.byteLength, byteLength: faces.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length, type: 'VEC3',
      min: [0, 1, 2].map(i => Math.min(...vertices.map(p => [p.x, p.y, p.z][i]))), max: [0, 1, 2].map(i => Math.max(...vertices.map(p => [p.x, p.y, p.z][i]))) },
    { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }],
    extensionsUsed: ['KHR_materials_unlit'], materials: [{ alphaMode: mask ? 'MASK' : color[3] < 1 ? 'BLEND' : 'OPAQUE', alphaCutoff: .5,
      doubleSided: true, extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: color } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }] };
}
const planeGltf = mesh([[-50, -50, 0], [50, -50, 0], [50, 50, 0], [-50, 50, 0]], [0, 1, 2, 0, 2, 3], [1, 0, 1, 1], true);
const tileUri = (name: string) => new URL(`/__workflow-fixture__/${name}.gltf`, location.href).href;
const bounds = { box: [0, 0, 0, 55, 0, 0, 0, 55, 0, 0, 0, 1] };
// A true REPLACE hierarchy: a coarse A surface can cover a missing detail tile.
// B has no loaded ancestor surface, so jumping there must remain fail-closed.
const tilesJson = { asset: { version: '1.1' }, geometricError: 1000, root: {
  boundingVolume: { box: [150, 0, 0, 210, 0, 0, 0, 55, 0, 0, 0, 1] }, transform: Matrix4.toArray(frame), geometricError: 100,
  refine: 'REPLACE', children: [
    { boundingVolume: bounds, geometricError: 4, refine: 'REPLACE', content: { uri: tileUri('parent') },
      children: [{ boundingVolume: bounds, geometricError: 0, content: { uri: tileUri('detail') } }] },
    { boundingVolume: bounds, transform: Matrix4.toArray(Matrix4.fromTranslation(new Cartesian3(300, 0, 0))), geometricError: 0, content: { uri: tileUri('remote') } },
  ] } };
const tiles = await Cesium3DTileset.fromUrl(URL.createObjectURL(new Blob([JSON.stringify(tilesJson)], { type: 'application/json' })), {
  maximumScreenSpaceError: 20, skipLevelOfDetail: false, cullRequestsWhileMoving: false, foveatedScreenSpaceError: false, progressiveResolutionHeightFraction: 0,
});
// Traversal sorts child arrays by camera distance; keep identities, not indices.
const regionA = tiles.root.children[0], detailA = regionA.children[0], regionB = tiles.root.children[1];
const failedTileUrls: string[] = [];
tiles.tileFailed.addEventListener(failure => failedTileUrls.push(failure.url));
tiles.show = false;
const originalStyle = new Cesium3DTileStyle({ color: "color('white')" });
const originalShader = new CustomShader({ mode: CustomShaderMode.MODIFY_MATERIAL, lightingModel: LightingModel.UNLIT,
  fragmentShaderText: 'void fragmentMain(FragmentInput fsInput,inout czm_modelMaterial material){material.diffuse=vec3(1.0,0.0,1.0);}' });
tiles.style = originalStyle; tiles.customShader = originalShader; viewer.scene.primitives.add(tiles);
const modelDefinitions = [
  { id: 'buried-opaque', x: -12, y: -12, z: -16, color: [1, .25, .02, 1] },
  { id: 'above-opaque', x: 12, y: -12, z: 16, color: [0, 1, 1, 1] },
  { id: 'buried-translucent', x: -12, y: 12, z: -16, color: [0, 1, 0, .55] },
  { id: 'above-translucent', x: 12, y: 12, z: 16, color: [1, 1, 0, .55] },
];
const cube = Array.from({ length: 8 }, (_, mask) => [mask & 1 ? 5 : -5, mask & 2 ? 5 : -5, mask & 4 ? 5 : -5]);
const faces = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7];
const models: Model[] = [], imports: ImportRecord[] = [], records = new Map<string, LibraryRecord>();
const record = (id: string, kind: LibraryRecord['kind'], matrix: Matrix4): LibraryRecord => ({ version: 1, id, name: id, kind, visible: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', files: {}, settings: { matrix: Matrix4.toArray(matrix) } });
for (const item of [0, 300].flatMap(east => modelDefinitions.map(item => ({ ...item, id: `${east ? 'remote-' : ''}${item.id}`, x: item.x + east })))) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(mesh(cube, faces, item.color))], { type: 'model/gltf+json' }));
  const matrix = Matrix4.multiply(frame, Matrix4.fromTranslation(new Cartesian3(item.x, item.y, item.z)), new Matrix4());
  const model = await Model.fromGltfAsync({ url, modelMatrix: matrix, minimumPixelSize: 0 });
  viewer.scene.primitives.add(model); models.push(model);
  imports.push({ id: item.id, name: item.id, kind: 'Model', resource: model, visible: true, boundingSphere: new BoundingSphere(world(item.x, item.y, item.z), 10) });
  records.set(item.id, record(item.id, 'Model', matrix));
}
const cad = new CustomDataSource('CAD control line'); await viewer.dataSources.add(cad);
const cadLines = [0, 300].map(east => cad.entities.add({ polyline: { positions: [world(east - 20, 18, 20), world(east + 20, 18, 20)], width: 3, material: Color.WHITE, clampToGround: false } }));
imports.push({ id: 'cad', name: 'CAD control lines', kind: 'CAD', representation: 'dataSource', resource: cad, visible: true, boundingSphere: new BoundingSphere(world(150, 18, 20), 180) });
imports.push({ id: 'ground', name: 'Synthetic photogrammetry ground', kind: '3D Tiles', resource: tiles, visible: false, boundingSphere: tiles.boundingSphere });
records.set('ground', record('ground', '3D Tiles', Matrix4.IDENTITY));

// Instrument actual browser decoding and canvas copies without changing their
// scheduling. The independent camera oracle uses the XML fixture's positions.
const messages: Array<{ message: string; error: boolean }> = [], renderErrors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => renderErrors.push(String(error.stack || error)));
let enterCount = 0, exitCount = 0;
const overlay = new VideoModelOverlay(viewer, { getImports: () => imports, getRecord: id => records.get(id),
  notify: (message, error = false) => messages.push({ message, error }),
  onEnter: () => { enterCount++; }, onExit: () => { exitCount++; } });
type Internal = {
  video: HTMLVideoElement; presentation?: HTMLCanvasElement; sourceFrame?: HTMLCanvasElement;
  pendingTime?: number; presentedTime?: number; lastFrameTime: number; buffering: boolean; wantedPlaying: boolean;
  resources?: { getOcclusionStatus(): unknown }; frameHandle?: number; animationHandle?: number;
  captureSnapshot(): { settings: SavedVideoOverlaySettings };
};
const internal = overlay as unknown as Internal;
const video = internal.video, callbackHandles = new Set<number>();
let callbackCount = 0, callbacksAfterExit = 0, callbackTime: number | undefined;
const request = video.requestVideoFrameCallback.bind(video), cancel = video.cancelVideoFrameCallback.bind(video);
video.requestVideoFrameCallback = callback => {
  const id = request((now, metadata) => {
    callbackHandles.delete(id); callbackCount++; if (!overlay.active) callbacksAfterExit++;
    callbackTime = metadata.mediaTime;
    try { callback(now, metadata); } finally { callbackTime = undefined; }
  });
  callbackHandles.add(id); return id;
};
video.cancelVideoFrameCallback = id => { callbackHandles.delete(id); cancel(id); };
const xyz = (point: Cartesian3) => [point.x, point.y, point.z];
const longitude = [120, 120.00006218, 120.00012436, 120.003109, 120.00317118];
function expectedPosition(time: number) {
  const index = Math.min(3, Math.max(0, Math.floor(time / 2))), amount = Math.max(0, Math.min(1, (time - index * 2) / 2));
  return Cartesian3.lerp(Cartesian3.fromDegrees(longitude[index], 30, 80), Cartesian3.fromDegrees(longitude[index + 1], 30, 80), amount, new Cartesian3());
}
type FrameCopy = { time: number; rgb: number[]; sequence: number };
const frameCopies = new WeakMap<HTMLCanvasElement, FrameCopy>();
const pairs: Array<{ time: number; pendingTime?: number; cameraError: number; rgbError: number; sequence: number; buffered: boolean }> = [];
let decodedCopies = 0;
const draw = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, image: CanvasImageSource, ...args: number[]) {
  Reflect.apply(draw, this, [image, ...args]);
  const isFrame = typeof VideoFrame !== 'undefined' && image instanceof VideoFrame;
  if (image === video || isFrame) {
    frameCopies.set(this.canvas, { time: isFrame ? image.timestamp / 1e6 : callbackTime ?? video.currentTime,
      rgb: [...this.getImageData(8, 8, 1, 1).data].slice(0, 3), sequence: ++decodedCopies });
  } else if (image instanceof HTMLCanvasElement && frameCopies.has(image)) {
    frameCopies.set(this.canvas, frameCopies.get(image)!);
  }
  if (image === viewer.canvas && this.canvas.classList.contains('cc-video-presentation')) {
    const copy = frameCopies.get(this.canvas);
    if (!copy) throw new Error('Presentation has no decoded video frame');
    const rgb = [...this.getImageData(8, 8, 1, 1).data].slice(0, 3);
    pairs.push({ time: copy.time, pendingTime: internal.pendingTime,
      cameraError: Cartesian3.distance(viewer.camera.positionWC, expectedPosition(copy.time)),
      rgbError: Math.max(...rgb.map((value, index) => Math.abs(value - copy.rgb[index]))),
      sequence: copy.sequence, buffered: internal.buffering });
    if (pairs.length > 400) pairs.shift();
  }
} as typeof draw;
let saved: { name: string; files: Record<string, File>; settings: SavedVideoOverlaySettings; id: string } | undefined;
let saveCount = 0, initialUploads = 0, settingsUpdates = 0;
const savedIds: string[] = [];
overlay.onSave = async (snapshot, existingId) => {
  saveCount++; if (existingId) settingsUpdates++; else initialUploads++;
  await new Promise(resolve => setTimeout(resolve, 80));
  saved = { name: snapshot.name, files: { ...snapshot.files }, settings: structuredClone(snapshot.settings), id: existingId ?? 'workflow-saved' };
  return saved.id;
};
overlay.onSaved = id => { savedIds.push(id); };
function lifecycle() {
  return { preUpdate: viewer.scene.preUpdate.numberOfListeners, preRender: viewer.scene.preRender.numberOfListeners,
    postRender: viewer.scene.postRender.numberOfListeners, tileLoad: tiles.tileLoad.numberOfListeners,
    tileVisible: tiles.tileVisible.numberOfListeners, tileFailed: tiles.tileFailed.numberOfListeners,
    primitives: viewer.scene.primitives.length, postProcesses: viewer.scene.postProcessStages.length };
}
function geometry() {
  return { matrices: models.map(model => Matrix4.toArray(model.modelMatrix)),
    cad: cadLines.map(line => line.polyline!.positions!.getValue(viewer.clock.currentTime).map(xyz)), tilesMatrix: Matrix4.toArray(tiles.modelMatrix) };
}
function presentationHash() {
  const canvas = internal.presentation;
  if (!canvas?.width || !canvas.height) return null;
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i += 31) hash = Math.imul(hash ^ data[i], 16777619);
  return hash >>> 0;
}
function pixels() {
  const gl = viewer.canvas.getContext('webgl2')!, data = new Uint8Array(viewer.canvas.width * viewer.canvas.height * 4);
  gl.readPixels(0, 0, viewer.canvas.width, viewer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  let orange = 0, cyan = 0, green = 0, yellow = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (r > 60 && r > 1.6 * g && g > 2 * b && a > 20) orange++;
    if (r < 30 && g > 60 && b > 60 && a > 20) cyan++;
    if (r < 30 && g > 60 && b < 30 && a > 20) green++;
    if (r > 60 && g > 60 && b < 30 && r / g > .7 && r / g < 1.3 && a > 20) yellow++;
  }
  return { orange, cyan, green, yellow, glError: gl.getError() };
}
function snapshot() {
  return { active: overlay.active, modelReady: models.every(model => model.ready), lifecycle: lifecycle(), geometry: geometry(),
    mediaTime: video.currentTime, mediaSrc: video.getAttribute('src'), paused: video.paused, seeking: video.seeking,
    presentedTime: internal.presentedTime ?? null, pendingTime: internal.pendingTime ?? null,
    buffering: internal.buffering, wantedPlaying: internal.wantedPlaying, status: internal.resources?.getOcclusionStatus() ?? null,
    hasResources: !!internal.resources, hasSourceFrame: !!internal.sourceFrame, hasPresentation: !!internal.presentation,
    sourceShow: tiles.show, shaderRestored: tiles.customShader === originalShader, styleRestored: tiles.style === originalStyle,
    frameHandle: internal.frameHandle ?? null, animationHandle: internal.animationHandle ?? null,
    pendingCallbacks: callbackHandles.size, callbackCount, callbacksAfterExit, decodedCopies, pairs: pairs.slice(-30),
    presentationHash: presentationHash(), presentationDom: document.querySelectorAll('.cc-video-presentation').length,
    saveCount, initialUploads, settingsUpdates, savedIds: [...savedIds], saved: saved ? { name: saved.name, id: saved.id, settings: structuredClone(saved.settings) } : null,
    enterCount, exitCount, messages: [...messages], renderErrors: [...renderErrors] };
}
(window as unknown as { __workflow: unknown }).__workflow = {
  snapshot, pixels, lifecycle, geometry, planeGltf: () => JSON.stringify(planeGltf),
  async restoreSaved() { if (!saved) throw new Error('No saved workflow'); await overlay.restoreReplay(saved.files, structuredClone(saved.settings), saved.id); },
  waitOutsideFrames(count: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error('Map render loop stopped after AR exit')); }, 10000);
      let seen = 0;
      const remove = viewer.scene.postRender.addEventListener(() => {
        if (++seen >= count) { remove(); clearTimeout(timer); resolve(); } else viewer.scene.requestRender();
      });
      viewer.scene.requestRender();
    });
  },
};
