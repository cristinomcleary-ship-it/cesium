import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  BoundingSphere, BoxGeometry, Cartesian3, Color, ColorGeometryInstanceAttribute, ConstantPositionProperty, ConstantProperty, CustomDataSource,
  GeometryInstance, Matrix3, Matrix4, Model, PerInstanceColorAppearance, Primitive, Transforms, Viewer,
} from 'cesium';
import { VideoModelOverlay, videoModelOverlayPanelHtml, type SavedVideoOverlaySettings } from '../../src/videoModelOverlay';
import { parseCcCameraXml } from '../../src/ccCameraTrack';
import type { ImportRecord } from '../../src/types';
import type { LibraryRecord } from '../../src/projectLibrary';

// Entire scene and video are synthetic. No project files or user coordinates are embedded here.
document.getElementById('panel')!.innerHTML = videoModelOverlayPanelHtml;
const viewer = new Viewer('viewer', {
  baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false,
  navigationHelpButton: false, infoBox: false, selectionIndicator: false,
  contextOptions: { webgl: { alpha: true, preserveDrawingBuffer: true } },
  showRenderLoopErrors: false, useBrowserRecommendedResolution: false,
});
viewer.resolutionScale = 1;
viewer.scene.backgroundColor = Color.fromCssColorString('#24364c');
viewer.scene.globe.baseColor = Color.fromCssColorString('#1d2935');
viewer.camera.setView({ destination: Cartesian3.fromDegrees(120.002, 30.002, 900), orientation: { heading: .3, pitch: -.9, roll: 0 } });
const origin = Cartesian3.fromDegrees(120, 30, 0);
const frame = Transforms.eastNorthUpToFixedFrame(origin);
const world = (east: number, north: number, up: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(east, north, up), new Cartesian3());
const referenceTransform = (east: number, north: number, up: number) => Matrix4.fromTranslation(Matrix4.multiplyByPointAsVector(frame, new Cartesian3(east, north, up), new Cartesian3()));
const referenceMatrix = referenceTransform(3, -2, 15);
const objectCenter = world(4, 116, 12);
const objectFrame = Transforms.eastNorthUpToFixedFrame(objectCenter);
const sourceCenter = new Cartesian3(100, -50, 30), sourceScale = 2.5;
const scaledSourceCenter = Cartesian3.multiplyByScalar(sourceCenter, sourceScale, new Cartesian3());
const originalMatrix = Matrix4.multiply(objectFrame, Matrix4.fromTranslation(Cartesian3.negate(scaledSourceCenter, new Cartesian3())), new Matrix4());
const axisCorrection = Matrix4.multiply(
  Matrix4.fromRotationTranslation(Matrix3.fromArray([1, 0, 0, 0, 0, 1, 0, -1, 0])),
  Matrix4.fromRotationTranslation(Matrix3.fromArray([0, 0, -1, 0, 1, 0, 1, 0, 0])), new Matrix4());
const inverseAxis = Matrix4.inverseTransformation(axisCorrection, new Matrix4());
const modelCorners = Array.from({ length: 8 }, (_, mask) => new Cartesian3(mask & 1 ? 12 : -12, mask & 2 ? 10 : -10, mask & 4 ? 12 : -12));
const sourceVertices = modelCorners.map(point => Matrix4.multiplyByPointAsVector(inverseAxis, Cartesian3.divideByScalar(point, sourceScale, new Cartesian3()), new Cartesian3()));
const vertexBuffer = new Float32Array(sourceVertices.flatMap(point => [point.x, point.y, point.z]));
const indices = new Uint16Array([0,2,1,1,2,3,4,5,6,5,7,6,0,4,2,2,4,6,1,3,5,3,7,5,0,1,4,1,5,4,2,6,3,3,6,7]);
const binary = new Uint8Array(vertexBuffer.byteLength + indices.byteLength);
binary.set(new Uint8Array(vertexBuffer.buffer)); binary.set(new Uint8Array(indices.buffer), vertexBuffer.byteLength);
const nodeTranslation = Matrix4.multiplyByPointAsVector(inverseAxis, sourceCenter, new Cartesian3());
const gltf = {
  asset: { version: '2.0', generator: 'synthetic-cc-video-overlay-regression' }, scene: 0,
  scenes: [{ nodes: [0] }], nodes: [{ children: [1] }, { mesh: 0, translation: [nodeTranslation.x, nodeTranslation.y, nodeTranslation.z] }],
  buffers: [{ byteLength: binary.byteLength }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertexBuffer.byteLength, target: 34962 }, { buffer: 0, byteOffset: vertexBuffer.byteLength, byteLength: indices.byteLength, target: 34963 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0,1,2].map(axis => Math.min(...sourceVertices.map(point => [point.x, point.y, point.z][axis]))), max: [0,1,2].map(axis => Math.max(...sourceVertices.map(point => [point.x, point.y, point.z][axis]))) }, { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  extensionsUsed: ['KHR_materials_unlit'], materials: [{ extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: [1, .45, .14, 1] } }],
};
const json = new TextEncoder().encode(JSON.stringify(gltf)), jsonLength = Math.ceil(json.length / 4) * 4;
const glb = new Uint8Array(12 + 8 + jsonLength + 8 + binary.length), glbView = new DataView(glb.buffer);
glbView.setUint32(0, 0x46546c67, true); glbView.setUint32(4, 2, true); glbView.setUint32(8, glb.length, true);
glbView.setUint32(12, jsonLength, true); glbView.setUint32(16, 0x4e4f534a, true); glb.fill(32, 20, 20 + jsonLength); glb.set(json, 20);
glbView.setUint32(20 + jsonLength, binary.length, true); glbView.setUint32(24 + jsonLength, 0x004e4942, true); glb.set(binary, 28 + jsonLength);
const modelUrl = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
const box = await Model.fromGltfAsync({ url: modelUrl, modelMatrix: Matrix4.clone(originalMatrix), scale: sourceScale, minimumPixelSize: 0 });
viewer.scene.primitives.add(box);
await new Promise<void>((resolve, reject) => {
  const timeout = window.setTimeout(() => { remove(); reject(new Error('Synthetic GLB did not become ready')); }, 20000);
  const remove = viewer.scene.postRender.addEventListener(() => { if (box.ready) { remove(); clearTimeout(timeout); resolve(); } });
  viewer.scene.requestRender();
});
URL.revokeObjectURL(modelUrl);
const cad = new CustomDataSource('Synthetic CAD');
await viewer.dataSources.add(cad);
const originalCadLine = [world(-35, 90, 4), world(35, 90, 4), world(35, 145, 4), world(-35, 145, 4), world(-35, 90, 4)];
const cadLine = cad.entities.add({ polyline: { positions: originalCadLine, width: 5, material: Color.CYAN, clampToGround: false } });
const cornerWorld = modelCorners.map(point => Matrix4.multiplyByPoint(objectFrame, point, new Cartesian3()));
let displayedCorners = cornerWorld.map(point => Cartesian3.clone(point));
const cornerEntities = cornerWorld.map(point => cad.entities.add({ position: point, point: { color: Color.MAGENTA, pixelSize: 5, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
const hiddenGis = new CustomDataSource('Hidden synthetic GIS'); hiddenGis.show = false;
await viewer.dataSources.add(hiddenGis);
const extra = viewer.scene.primitives.add(new Primitive({
  geometryInstances: new GeometryInstance({ geometry: BoxGeometry.fromDimensions({ dimensions: new Cartesian3(3, 3, 3), vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT }), attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE) } }),
  modelMatrix: Transforms.eastNorthUpToFixedFrame(world(1000, 0, 0)), asynchronous: false,
  appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
}));
const imports: ImportRecord[] = [
  { id: 'synthetic-model', name: '合成工程模型', kind: 'Model', resource: box, visible: true, boundingSphere: new BoundingSphere(objectCenter, 30) },
  { id: 'synthetic-cad', name: '合成 CAD 边线', kind: 'CAD', representation: 'dataSource', resource: cad, visible: true, boundingSphere: new BoundingSphere(world(0, 118, 4), 50) },
  { id: 'synthetic-gis', name: '预先隐藏的 GIS', kind: 'GIS', resource: hiddenGis, visible: false },
];
// A reference needs saved world positioning, not downloaded photogrammetry geometry.
// The unrelated root transform is deliberately huge: it must never affect an ECEF camera.
const referenceResource = {
  show: true, modelMatrix: Matrix4.clone(referenceMatrix), boundingSphere: new BoundingSphere(world(0, 120, 0), 200),
  root: { transform: Matrix4.fromTranslation(new Cartesian3(900000, -700000, 500000)) },
};
imports.push({ id: 'synthetic-reference', name: '合成空三成果参照', kind: '3D Tiles', resource: referenceResource, visible: true, boundingSphere: referenceResource.boundingSphere });
const makeRecord = (id: string, kind: LibraryRecord['kind'], matrix: Matrix4): LibraryRecord => ({
  version: 1, id, name: id, kind, visible: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  files: { data: { name: 'synthetic-private-file.glb', url: '/synthetic-private-original-content-must-not-appear' } }, settings: { matrix: Matrix4.toArray(matrix) },
});
const records = new Map<string, LibraryRecord>([
  ['synthetic-reference', makeRecord('synthetic-reference', '3D Tiles', referenceMatrix)],
  ['synthetic-model', makeRecord('synthetic-model', 'Model', originalMatrix)],
]);
const messages: Array<{ message: string; error: boolean }> = [], renderErrors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => renderErrors.push(String(error?.stack || error)));
const overlay = new VideoModelOverlay(viewer, {
  getImports: () => imports, getRecord: id => records.get(id),
  notify: (message, error = false) => messages.push({ message, error }),
});
type Saved = { name: string; files: Record<string, File>; settings: SavedVideoOverlaySettings; id: string };
let saved: Saved | undefined, saveCount = 0;
overlay.onSave = async (snapshot, existingId) => {
  saveCount += 1;
  saved = { name: snapshot.name, files: { ...snapshot.files }, settings: structuredClone(snapshot.settings), id: existingId ?? 'synthetic-saved-video' };
  return saved.id;
};
const xyz = (point: Cartesian3) => [point.x, point.y, point.z];
const initial = {
  position: xyz(viewer.camera.positionWC), direction: xyz(viewer.camera.directionWC), up: xyz(viewer.camera.upWC),
  background: Color.clone(viewer.scene.backgroundColor), globe: viewer.scene.globe.show,
  fog: viewer.scene.fog.enabled, inputs: viewer.scene.screenSpaceCameraController.enableInputs,
  modelMatrix: Matrix4.toArray(box.modelMatrix), modelShow: box.show, cadShow: cad.show, extraShow: extra.show, gisShow: hiddenGis.show,
};
function snapshot() {
  const video = document.querySelector<HTMLVideoElement>('.cc-video-backdrop video');
  const frustum = viewer.camera.frustum;
  const projection = Matrix4.toArray(frustum.projectionMatrix), near = frustum.near;
  return { ready: true, active: overlay.active,
    position: xyz(viewer.camera.positionWC), direction: xyz(viewer.camera.directionWC), up: xyz(viewer.camera.upWC),
    background: Color.clone(viewer.scene.backgroundColor), globe: viewer.scene.globe.show,
    fog: viewer.scene.fog.enabled, inputs: viewer.scene.screenSpaceCameraController.enableInputs,
    frustum: { left: (projection[8] - 1) * near / projection[0], right: (projection[8] + 1) * near / projection[0],
      top: (projection[9] + 1) * near / projection[5], bottom: (projection[9] - 1) * near / projection[5], near },
    modelMatrix: Matrix4.toArray(box.modelMatrix), modelShow: box.show, cadShow: cad.show, extraShow: extra.show, gisShow: hiddenGis.show,
    modelDelta: xyz(Matrix4.multiplyByPoint(Matrix4.inverseTransformation(objectFrame, new Matrix4()), Matrix4.multiplyByPoint(box.modelMatrix, scaledSourceCenter, new Cartesian3()), new Cartesian3())),
    modelType: box.constructor.name, modelScale: box.scale, minimumPixelSize: box.minimumPixelSize,
    cadFirst: xyz(cadLine.polyline!.positions!.getValue(viewer.clock.currentTime)[0]),
    cadCorners: cornerEntities.map(entity => xyz(entity.position!.getValue(viewer.clock.currentTime)!)),
    referenceMatrix: Matrix4.toArray(referenceResource.modelMatrix), referenceSavedMatrix: [...records.get('synthetic-reference')!.settings.matrix!], referenceShow: referenceResource.show,
    referenceSelection: (document.getElementById('ccSceneReference') as HTMLSelectElement).value,
    info: document.getElementById('ccOverlayInfo')!.textContent, referenceInfo: document.getElementById('ccReferenceInfo')!.textContent,
    mediaTime: video?.currentTime ?? null, paused: video?.paused ?? null, videoSeeking: video?.seeking ?? null, videoReadyState: video?.readyState ?? null,
    saveCount, saved: saved ? structuredClone(saved.settings) : null,
    badge: document.querySelector('.cc-video-status')?.textContent ?? '', messages: [...messages], renderErrors: [...renderErrors],
  };
}
function pixelStats() {
  try { viewer.render(); }
  catch (error) { const detail = error instanceof Error ? error.stack || error.message : String((error as { stack?: string; message?: string })?.stack || (error as { message?: string })?.message || error); renderErrors.push(detail); throw new Error(detail); }
  const canvas = viewer.canvas, gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) throw new Error('No live WebGL context');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let orange = 0, cyan = 0, transparent = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (a < 5) transparent++;
    if (a > 30 && r > 80 && r > g * 1.4 && r > b * 1.6) orange++;
    if (a > 30 && g > 70 && b > 70 && g > r * 1.4 && b > r * 1.4) cyan++;
  }
  return { orange, cyan, transparent, total: pixels.length / 4, width: canvas.width, height: canvas.height, glError: gl.getError() };
}
function modelPixelAlignment() {
  viewer.render();
  const canvas = viewer.canvas, gl = canvas.getContext('webgl2')!;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const points = displayedCorners.map(point => {
    const eye = Matrix4.multiplyByPoint(viewer.camera.viewMatrix, point, new Cartesian3());
    const x = (500 * eye.x / -eye.z + 320) / 640 * canvas.width;
    const y = (500 * -eye.y / -eye.z + 180) / 360 * canvas.height;
    let orange = false, magenta = false;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const px = Math.round(x) + dx, py = canvas.height - 1 - (Math.round(y) + dy);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      const index = (py * canvas.width + px) * 4, r = pixels[index], g = pixels[index + 1], b = pixels[index + 2], a = pixels[index + 3];
      if (a > 30 && r > 80 && r > g * 1.4 && r > b * 1.6) orange = true;
      if (a > 30 && r > 70 && b > 70 && r > g * 1.4 && b > g * 1.4) magenta = true;
    }
    return { x, y, orange, magenta };
  });
  return { points, allMatch: points.every(point => point.orange && point.magenta), modelScale: box.scale, minimumPixelSize: box.minimumPixelSize };
}
const harness = {
  snapshot, initial, pixelStats, modelPixelAlignment,
  expected(time: number) {
    const clamped = Math.max(0, Math.min(4, time));
    const index = Math.min(1, Math.floor(clamped / 2)), amount = (clamped - index * 2) / 2;
    const start = Cartesian3.fromDegrees(120 + index * .0001, 30, 120), end = Cartesian3.fromDegrees(120 + (index + 1) * .0001, 30, 120);
    const raw = Cartesian3.lerp(start, end, amount, new Cartesian3());
    const selected = (document.getElementById('ccSceneReference') as HTMLSelectElement).value;
    return xyz(selected ? Matrix4.multiplyByPoint(Matrix4.fromArray(records.get(selected)!.settings.matrix!), raw, new Cartesian3()) : raw);
  },
  moveToReferenceFrame() {
    overlay.clear();
    box.modelMatrix = Matrix4.multiply(referenceMatrix, originalMatrix, new Matrix4());
    records.get('synthetic-model')!.settings.matrix = Matrix4.toArray(box.modelMatrix);
    cadLine.polyline!.positions = new ConstantProperty(originalCadLine.map(point => Matrix4.multiplyByPoint(referenceMatrix, point, new Cartesian3())));
    displayedCorners = cornerWorld.map(point => Matrix4.multiplyByPoint(referenceMatrix, point, new Cartesian3()));
    cornerEntities.forEach((entity, index) => { entity.position = new ConstantPositionProperty(displayedCorners[index]); });
    imports[0].boundingSphere = new BoundingSphere(Matrix4.multiplyByPoint(referenceMatrix, objectCenter, new Cartesian3()), 30);
    imports[1].boundingSphere = new BoundingSphere(Matrix4.multiplyByPoint(referenceMatrix, world(0, 118, 4), new Cartesian3()), 50);
    overlay.refreshResources(); viewer.scene.requestRender();
    return snapshot();
  },
  changeSavedReference(east: number, north: number, up: number) {
    const changed = referenceTransform(east, north, up);
    records.get('synthetic-reference')!.settings.matrix = Matrix4.toArray(changed);
    referenceResource.modelMatrix = Matrix4.clone(changed);
    return snapshot();
  },
  diagnostics() { return overlay.createDiagnostics(); },
  async restoreSaved() { if (!saved) throw new Error('No saved scheme'); await overlay.restoreReplay(saved.files, structuredClone(saved.settings), saved.id); },
  parseXml(xml: string) { const data = parseCcCameraXml(xml); return { photos: data.photos.length, groups: data.photogroups.length, width: data.photogroups[0].intrinsics.width, height: data.photogroups[0].intrinsics.height, warnings: data.warnings }; },
};
(window as unknown as { __ccOverlayHarness: typeof harness }).__ccOverlayHarness = harness;
viewer.scene.requestRender();
