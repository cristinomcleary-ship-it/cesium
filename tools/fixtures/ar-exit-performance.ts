import 'cesium/Build/Cesium/Widgets/widgets.css';
import { BoundingSphere, Cartesian3, Matrix3, Matrix4, Model, Transforms, Viewer } from 'cesium';
import { VideoModelOverlay, videoModelOverlayPanelHtml } from '../../src/videoModelOverlay';
import type { ImportRecord } from '../../src/types';
import type { LibraryRecord } from '../../src/projectLibrary';

// Synthetic, local geometry only. No user models or recordings enter this test.
document.getElementById('panel')!.innerHTML = videoModelOverlayPanelHtml;
const viewer = new Viewer('viewer', { baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false, navigationHelpButton: false,
  infoBox: false, selectionIndicator: false, contextOptions: { webgl: { alpha: true } },
  showRenderLoopErrors: false, useBrowserRecommendedResolution: false });
viewer.resolutionScale = 1; viewer.scene.globe.show = false;
viewer.scene.postProcessStages.fxaa.enabled = false;
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(120, 30, 0));
const world = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
viewer.camera.setView({ destination: world(0, 0, 200), orientation: {
  direction: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 0, -1), new Cartesian3()),
  up: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 1, 0), new Cartesian3()) } });
const axis = Matrix4.multiply(Matrix4.fromRotationTranslation(Matrix3.fromArray([1, 0, 0, 0, 0, 1, 0, -1, 0])),
  Matrix4.fromRotationTranslation(Matrix3.fromArray([0, 0, -1, 0, 1, 0, 1, 0, 0])), new Matrix4());
const inverseAxis = Matrix4.inverseTransformation(axis, new Matrix4());
const points: number[][] = [], faces: number[] = [], n = 24;
for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
  const point = Matrix4.multiplyByPointAsVector(inverseAxis, new Cartesian3(x / n * 7 - 3.5, y / n * 7 - 3.5, Math.sin(x * .7) * Math.cos(y * .7)), new Cartesian3());
  points.push([point.x, point.y, point.z]);
}
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const a = y * (n + 1) + x; faces.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
}
const positions = new Float32Array(points.flat()), indices = new Uint16Array(faces);
const binary = new Uint8Array(positions.byteLength + indices.byteLength);
binary.set(new Uint8Array(positions.buffer)); binary.set(new Uint8Array(indices.buffer), positions.byteLength);
const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  buffers: [{ uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...binary))}`, byteLength: binary.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: points.length, type: 'VEC3', min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) },
    { bufferView: 1, componentType: 5123, count: faces.length, type: 'SCALAR' }],
  extensionsUsed: ['KHR_materials_unlit'], materials: [{ doubleSided: true, extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: [.2, .8, .7, 1] } }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }] };
const url = URL.createObjectURL(new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' }));
const imports: ImportRecord[] = [], models: Model[] = [], records = new Map<string, LibraryRecord>();
const count = Math.min(100, Math.max(1, Number(new URLSearchParams(location.search).get('models') ?? 28)));
for (let index = 0; index < count; index++) {
  const x = (index % 7 - 3) * 8, y = (Math.floor(index / 7) - 1.5) * 8;
  const matrix = Matrix4.multiply(frame, Matrix4.fromTranslation(new Cartesian3(x, y, 30)), new Matrix4());
  const model = await Model.fromGltfAsync({ url, modelMatrix: matrix, minimumPixelSize: 0 });
  viewer.scene.primitives.add(model); models.push(model); const id = `stress-${index}`;
  imports.push({ id, name: id, kind: 'Model', resource: model, visible: true, boundingSphere: new BoundingSphere(world(x, y, 30), 7) });
  records.set(id, { version: 1, id, name: id, kind: 'Model', visible: true, createdAt: '', updatedAt: '', files: {}, settings: { matrix: Matrix4.toArray(matrix) } });
}
const errors: string[] = [], messages: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => errors.push(String(error.stack || error)));
const overlay = new VideoModelOverlay(viewer, { getImports: () => imports, getRecord: id => records.get(id), notify: message => messages.push(message) });
overlay.onSave = async () => 'performance-synthetic';
const internal = overlay as unknown as { presentedTime?: number; buffering: boolean; compositor?: { sourceTime?: number; presentedTime?: number } };
const gl = viewer.canvas.getContext('webgl2')!;
function state() {
  const host = viewer.scene as unknown as { _defaultView: { sceneFramebuffer: any } };
  const stages = viewer.scene.postProcessStages as unknown as any;
  const framebuffer = host._defaultView.sceneFramebuffer;
  const size = (manager: any) => { const texture = manager?.getColorTexture?.(); return texture ? [texture.width, texture.height] : null; };
  return { active: overlay.active, ready: models.every(model => model.ready), presentedTime: internal.presentedTime ?? null,
    sourcePTS: internal.compositor?.sourceTime ?? null, committedPTS: internal.compositor?.presentedTime ?? null,
    modelCount: count, triangles: count * faces.length / 3,
    renderer: { width: viewer.canvas.width, height: viewer.canvas.height, resolutionScale: viewer.resolutionScale,
      useDefaultRenderLoop: viewer.useDefaultRenderLoop, requestRenderMode: viewer.scene.requestRenderMode,
      fxaa: viewer.scene.postProcessStages.fxaa.enabled },
    sceneColorSize: size(framebuffer?._colorFramebuffer), sceneIdSize: size(framebuffer?._idFramebuffer),
    cachedFramebuffers: stages._textureCache?._framebuffers?.map((entry: any) => size(entry.buffer)) ?? [],
    glError: gl.getError(), glAllocations: (window as any).__glStats.snapshot(), errors: [...errors], messages: [...messages] };
}
(window as any).__exitPerformance = { viewer, overlay, state,
  async frames(count = 10) {
    const previousLoop = viewer.useDefaultRenderLoop; viewer.useDefaultRenderLoop = false;
    const data: number[] = [], before = (window as any).__glStats.snapshot();
    try {
      for (let i = 0; i < 3; i++) { viewer.scene.requestRender(); viewer.render(); }
      for (let i = 0; i < count; i++) {
        const start = performance.now(); viewer.camera.moveRight(i % 2 ? -.1 : .1); viewer.scene.requestRender(); viewer.render();
        gl.finish(); data.push(performance.now() - start); await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { data, averageMs: data.reduce((a, b) => a + b, 0) / data.length, before, after: (window as any).__glStats.snapshot() };
    } finally { viewer.useDefaultRenderLoop = previousLoop; }
  },
  pick() {
    viewer.scene.requestRender(); viewer.render(); let picked = false;
    for (const model of models) {
      const point = viewer.scene.cartesianToCanvasCoordinates(model.boundingSphere.center);
      if (point && viewer.scene.pick(point)) { picked = true; break; }
    }
    return { picked, glError: gl.getError() };
  },
};
