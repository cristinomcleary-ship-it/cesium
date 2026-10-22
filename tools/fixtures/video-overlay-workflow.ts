import 'cesium/Build/Cesium/Widgets/widgets.css';
import { BoundingSphere, Cartesian3, SceneTransforms, Cesium3DTileset, Cesium3DTileStyle, Color, CustomDataSource, CustomShader, CustomShaderMode, LightingModel, Matrix3, Matrix4, Model, Transforms, Viewer } from 'cesium';
import { VideoModelOverlay, videoModelOverlayPanelHtml, type SavedVideoOverlaySettings } from '../../src/videoModelOverlay';
import { VideoOverlayPlaybackCompositor } from '../../src/videoOverlayPlaybackCompositor';
import type { ImportRecord } from '../../src/types';
import type { LibraryRecord } from '../../src/projectLibrary';
import type { SpatialAnnotation } from '../../src/videoOverlaySpatialAnnotations';
import type { VideoOverlaySpatialBinding } from '../../src/videoOverlaySpatialBinding';

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
const cadTiltFixture = new URLSearchParams(location.search).get('cadTilt') === '1';
// Deterministic input probes: do not carry a prior mouse gesture's inertia into
// the next AR capture. Real drag and wheel events still use Cesium's controller.
if (cadTiltFixture) {
  const controls = viewer.scene.screenSpaceCameraController;
  controls.inertiaSpin = 0; controls.inertiaTranslate = 0; controls.inertiaZoom = 0;
}
const cadPoints = cadTiltFixture
  ? [[world(-20, 18, 20), world(20, 18, 20)], [world(0, 8, 20), world(0, 28, 20)]]
  : [0, 300].map(east => [world(east - 20, 18, 20), world(east + 20, 18, 20)]);
const cadLines = cadPoints.map(positions => cad.entities.add({ polyline: { positions, width: 3, material: Color.WHITE, clampToGround: false } }));
imports.push({ id: 'cad', name: 'CAD control lines', kind: 'CAD', representation: 'dataSource', resource: cad, visible: true, boundingSphere: new BoundingSphere(world(cadTiltFixture ? 0 : 150, 18, 20), cadTiltFixture ? 24 : 180) });
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
  video: HTMLVideoElement; presentation?: HTMLCanvasElement; compositor?: VideoOverlayPlaybackCompositor;
  pendingTime?: number; presentedTime?: number; lastFrameTime: number; buffering: boolean; wantedPlaying: boolean;
  resources?: { getOcclusionStatus(): { ready: boolean; [key: string]: unknown }; spatialFrame(id: string): Matrix4 | undefined }; frameHandle?: number; animationHandle?: number;
  cachedPreview?: { video: HTMLVideoElement; start: number; end: number }; editorCanvas?: HTMLCanvasElement;
  editRevision: number; annotations: unknown[]; effects: unknown[]; adjustments: SavedVideoOverlaySettings['adjustments'];
  spatialAnnotations: SpatialAnnotation[]; spatialBinding: VideoOverlaySpatialBinding;
  spatialEditor: { setValue(marks: SpatialAnnotation[]): void };
  dirty(): void; renderFrame(time: number): void;
  captureSnapshot(): { settings: SavedVideoOverlaySettings };
  cacheSignature(range: { start: number; end: number }): string;
};
const internal = overlay as unknown as Internal;
const video = internal.video, callbackHandles = new Set<number>();
let depthMode: 'actual' | 'pending' | 'alternate' = 'actual';
let originalDepth: (() => { ready: boolean; [key: string]: unknown }) | undefined;
let patchedResources: Internal['resources'];
function patchDepth() {
  if (!internal.resources || patchedResources === internal.resources) return;
  patchedResources = internal.resources; originalDepth = internal.resources.getOcclusionStatus.bind(internal.resources);
  internal.resources.getOcclusionStatus = () => {
    const status = originalDepth!();
    const frameNumber = (viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState.frameNumber;
    return depthMode === 'actual' ? status : { ...status, ready: depthMode === 'alternate' && frameNumber % 2 === 0, refining: true };
  };
}

let callbackCount = 0, callbacksAfterExit = 0, pauseCalls = 0, playCalls = 0;
const pause = video.pause.bind(video), play = video.play.bind(video);
video.pause = () => { if (overlay.active) pauseCalls++; pause(); };
video.play = () => { if (overlay.active) playCalls++; return play(); };
const request = video.requestVideoFrameCallback.bind(video), cancel = video.cancelVideoFrameCallback.bind(video);
video.requestVideoFrameCallback = callback => {
  const id = request((now, metadata) => {
    callbackHandles.delete(id); callbackCount++; if (!overlay.active) callbacksAfterExit++;
    callback(now, metadata);
  });
  callbackHandles.add(id); return id;
};
video.cancelVideoFrameCallback = id => { callbackHandles.delete(id); cancel(id); };
const xyz = (point: Cartesian3) => [point.x, point.y, point.z];
const longitude = new URLSearchParams(location.search).get('native') === '1' ? [120, 120, 120, 120, 120] : [120, 120.00006218, 120.00012436, 120.003109, 120.00317118];
function expectedPosition(time: number) {
  const index = Math.min(3, Math.max(0, Math.floor(time / 2))), amount = Math.max(0, Math.min(1, (time - index * 2) / 2));
  return Cartesian3.lerp(Cartesian3.fromDegrees(longitude[index], 30, 80), Cartesian3.fromDegrees(longitude[index + 1], 30, 80), amount, new Cartesian3());
}
function classify(data: Uint8ClampedArray | Uint8Array) {
  let orange = 0, cyan = 0, green = 0, yellow = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (r > 80 && r > 1.6 * g && g > 2 * b && a > 20) orange++;
    if (r < 80 && g > 150 && b > 150 && a > 20) cyan++;
    if (r < 100 && b < 100 && g > 100 && g > 1.8 * r && g > 1.8 * b && a > 20) green++;
    if (r > 150 && g > 150 && b < .8 * Math.min(r, g) && r / g > .7 && r / g < 1.3 && a > 20) yellow++;
  }
  return { orange, cyan, green, yellow };
}

// Metadata-only instrumentation: no readPixels, Canvas2D transfer or video copy
// occurs in the playback callback. Pixel assertions are explicit paused probes.
const pairs: Array<{ time: number; pendingTime?: number; cameraError: number; sourcePtsError: number; sourceTime?: number; sequence: number; buffered: boolean; depthReady: boolean }> = [];
let decodedCopies = 0, cpuVideoCopies = 0;
const capture = VideoOverlayPlaybackCompositor.prototype.captureSource;
const commit = VideoOverlayPlaybackCompositor.prototype.commit;
const dispose = VideoOverlayPlaybackCompositor.prototype.dispose;
const captured = new WeakMap<VideoOverlayPlaybackCompositor, { sequence: number; ptsError: number }>();
const released: Array<{ disposed: boolean; width: number; height: number }> = [];
VideoOverlayPlaybackCompositor.prototype.captureSource = function (image, time) {
  const result = capture.call(this, image, time);
  if (result && this === internal.compositor) captured.set(this, { sequence: ++decodedCopies,
    ptsError: image instanceof VideoFrame ? Math.abs(image.timestamp / 1e6 - time) : Math.abs(video.currentTime - time) });
  return result;
};
VideoOverlayPlaybackCompositor.prototype.commit = function (image, time, annotations) {
  const result = commit.call(this, image, time, annotations), metadata = captured.get(this);
  if (result && this === internal.compositor) {
    if (!metadata) throw new Error('GPU presentation has no captured source frame');
    pairs.push({ time, pendingTime: internal.pendingTime, sourceTime: this.sourceTime,
      cameraError: Cartesian3.distance(viewer.camera.positionWC, expectedPosition(time)), sourcePtsError: metadata.ptsError,
      sequence: metadata.sequence, buffered: internal.buffering, depthReady: !!internal.resources?.getOcclusionStatus().ready });
    if (pairs.length > 1000) pairs.shift();
  }
  return result;
};
VideoOverlayPlaybackCompositor.prototype.dispose = function () {
  dispose.call(this); released.push({ disposed: this.isDisposed, width: this.canvas.width, height: this.canvas.height });
};
const draw = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
  if (image === video || image === viewer.canvas || image instanceof VideoFrame) cpuVideoCopies++;
  Reflect.apply(draw, this, [image, ...args]);
} as typeof draw;
function presentationPixels(x = 0, y = 0, width = internal.presentation?.width ?? 0, height = internal.presentation?.height ?? 0) {
  const canvas = internal.presentation;
  if (!canvas?.width || !canvas.height) return null;
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) throw new Error('Presentation must use a GPU canvas');
  const data = new Uint8Array(width * height * 4);
  gl.readPixels(x, canvas.height - y - height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return data;
}
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
  const data = presentationPixels(); if (!data) return null;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i += 31) hash = Math.imul(hash ^ data[i], 16777619);
  return hash >>> 0;
}
function pixels() {
  const data = presentationPixels(); if (!data) return null;
  return { ...classify(data), glError: viewer.canvas.getContext('webgl2')!.getError() };
}
function renderer() {
  const statistics = (tiles as unknown as { _statistics: { numberOfTilesWithContentReady: number } })._statistics;
  return { resolutionScale: viewer.resolutionScale, useDefaultRenderLoop: viewer.useDefaultRenderLoop,
    requestRenderMode: viewer.scene.requestRenderMode, maximumRenderTimeChange: String(viewer.scene.maximumRenderTimeChange),
    shadows: viewer.shadows, highDynamicRange: viewer.scene.highDynamicRange,
    cameraInputs: viewer.scene.screenSpaceCameraController.enableInputs,
    width: viewer.canvas.width, height: viewer.canvas.height,
    loadedTiles: statistics.numberOfTilesWithContentReady, tileBytes: tiles.totalMemoryUsageInBytes };
}
function dimensions() {
  const cached = internal.cachedPreview?.video;
  const texture = (internal.compositor as unknown as { sourceTexture?: { width: number; height: number } } | undefined)?.sourceTexture;
  return { source: [video.videoWidth, video.videoHeight], gpuSource: texture ? [texture.width, texture.height] : [0, 0],
    presentation: [internal.presentation?.width ?? 0, internal.presentation?.height ?? 0],
    cached: cached ? [cached.videoWidth, cached.videoHeight] : null,
    cachedTime: cached ? cached.currentTime : null, cachedPaused: cached?.paused ?? null,
    cachedSrc: cached?.getAttribute('src') ?? null, cachedDom: document.querySelectorAll('.cc-cached-preview').length,
    editorDom: document.querySelectorAll('.cc-video-editor').length,
    spatialEditorDom: document.querySelectorAll('.cc-video-spatial-editor').length };
}
function cameraState() {
  const camera = viewer.camera, controls = viewer.scene.screenSpaceCameraController;
  const frustum = camera.frustum as unknown as Record<string, unknown>;
  return { height: camera.positionCartographic.height, position: xyz(camera.positionWC), direction: xyz(camera.directionWC), up: xyz(camera.upWC),
    transform: Matrix4.toArray(camera.transform), frustum: Object.fromEntries(['fov','aspectRatio','near','far','xOffset','yOffset'].map(key => [key,frustum[key]])),
    controls: Object.fromEntries(['enableInputs','enableTranslate','enableZoom','enableRotate','enableTilt','enableLook'].map(key => [key,(controls as unknown as Record<string,unknown>)[key]])) };
}
function mapPick() {
  viewer.scene.requestRender(); viewer.render();
  let picked = false;
  for (const model of models) {
    if (!model.show || !model.ready) continue;
    const point = SceneTransforms.worldToWindowCoordinates(viewer.scene, model.boundingSphere.center);
    if (point && viewer.scene.pick(point)?.primitive === model) { picked = true; break; }
  }
  return { picked, glError: viewer.canvas.getContext('webgl2')!.getError() };
}
function snapshot() {
  return { active: overlay.active, camera: cameraState(), modelStates: models.map((model, index) => ({ id: imports[index].id, show: model.show, ready: model.ready,
      color: model.color ? [model.color.red, model.color.green, model.color.blue, model.color.alpha] : null,
      commandsBuilt: (model as unknown as { _drawCommandsBuilt: boolean })._drawCommandsBuilt,
      shader: model.customShader ? { translucencyMode: model.customShader.translucencyMode,
        uniforms: Object.fromEntries(Object.entries(model.customShader.uniforms).map(([key, value]) => [key, value.value])) } : null })), renderer: renderer(), dimensions: dimensions(), editRevision: internal.editRevision, adjustments: structuredClone(internal.adjustments), annotations: structuredClone(internal.annotations), spatialAnnotations: structuredClone(internal.spatialAnnotations ?? []), effects: structuredClone(internal.effects), modelReady: models.every(model => model.ready), lifecycle: lifecycle(), geometry: geometry(),
    mediaTime: video.currentTime, mediaSrc: video.getAttribute('src'), paused: video.paused, seeking: video.seeking,
    presentedTime: internal.presentedTime ?? null, pendingTime: internal.pendingTime ?? null,
    buffering: internal.buffering, wantedPlaying: internal.wantedPlaying, status: internal.resources?.getOcclusionStatus() ?? null,
    hasResources: !!internal.resources, hasSourceFrame: !!internal.compositor && internal.compositor.sourceTime !== undefined, hasPresentation: !!internal.presentation,
    sourceShow: tiles.show, shaderRestored: tiles.customShader === originalShader, styleRestored: tiles.style === originalStyle,
    frameHandle: internal.frameHandle ?? null, animationHandle: internal.animationHandle ?? null,
    pendingCallbacks: callbackHandles.size, callbackCount, callbacksAfterExit, decodedCopies, pauseCalls, playCalls, cpuVideoCopies, released: [...released], pairs: pairs.slice(-30),
    compositor: internal.compositor ? { sourceTime: internal.compositor.sourceTime, presentedTime: internal.compositor.presentedTime, disposed: internal.compositor.isDisposed, lost: internal.compositor.isContextLost } : null, presentationDom: document.querySelectorAll('.cc-video-presentation').length,
    saveCount, initialUploads, settingsUpdates, savedIds: [...savedIds], saved: saved ? { name: saved.name, id: saved.id, settings: structuredClone(saved.settings) } : null,
    enterCount, exitCount, messages: [...messages], renderErrors: [...renderErrors] };
}
(window as unknown as { __workflow: unknown }).__workflow = {
  snapshot, pixels, lifecycle, geometry, presentationHash, mapPick,
  cacheSignature() { return internal.cacheSignature({start:0,end:1.2}); },
  moveMapModel(east: number) {
    const index = imports.findIndex(item => item.id === 'above-opaque'), model = models[index];
    const original = Matrix4.fromArray(records.get('above-opaque')!.settings.matrix as number[]);
    const translation = Matrix4.multiplyByPointAsVector(frame,new Cartesian3(east,0,0),new Cartesian3());
    model.modelMatrix = Matrix4.multiply(Matrix4.fromTranslation(translation),original,new Matrix4());
    viewer.scene.requestRender();
    return { recordMatrix: records.get('above-opaque')!.settings.matrix, modelMatrix: Matrix4.toArray(model.modelMatrix) };
  },
  restoreMapCamera() { viewer.camera.setView({ destination: world(0, 0, 200), orientation: { direction: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 0, -1), new Cartesian3()), up: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 1, 0), new Cartesian3()) } }); viewer.scene.requestRender(); },
  spatial: {
    fromWorld(targetId: string, point: { x: number; y: number; z: number }) {
      const frame = internal.resources?.spatialFrame(targetId);
      if (!frame) throw new Error('No current target frame');
      const local = Matrix4.multiplyByPoint(Matrix4.inverse(frame, new Matrix4()), world(point.x, point.y, point.z), new Cartesian3());
      return { x: local.x, y: local.y, z: local.z };
    },
    project(targetId: string, point: { x: number; y: number; z: number }) { return internal.spatialBinding.project(targetId, point); },
    pick(targetId: string, x: number, y: number) { return internal.spatialBinding.pick(targetId, x, y); },
    set(marks: SpatialAnnotation[]) { internal.spatialAnnotations = structuredClone(marks); internal.spatialEditor.setValue(marks); internal.dirty(); internal.renderFrame(internal.lastFrameTime); },
    counts() {
      const data = presentationPixels(); let magenta = 0;
      if (data) for (let i = 0; i < data.length; i += 4) if (data[i] > 190 && data[i + 1] < 70 && data[i + 2] > 190) magenta++;
      return { magenta };
    },
  },
  resetMediaStats() { pauseCalls = 0; playCalls = 0; cpuVideoCopies = 0; },
  sample(x: number, y: number) { const canvas = internal.presentation!; return [...presentationPixels(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1)!]; },
  setDepthMode(mode: typeof depthMode) { depthMode = mode; patchDepth(); viewer.scene.requestRender(); },
  async cachedBlob() { const response = await fetch(internal.cachedPreview!.video.src); return [...new Uint8Array(await response.arrayBuffer())]; },
  planeGltf: () => JSON.stringify(planeGltf),
  async restoreSaved(legacyTilt = false) {
    if (!saved) throw new Error('No saved workflow');
    const settings = structuredClone(saved.settings);
    if (legacyTilt) for (const adjustment of Object.values(settings.adjustments)) { delete adjustment.tiltEast; delete adjustment.tiltNorth; }
    await overlay.restoreReplay(saved.files, settings, saved.id);
  },
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
