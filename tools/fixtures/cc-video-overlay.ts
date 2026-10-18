import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  BoundingSphere, BoxGeometry, Cartesian3, Color, ColorGeometryInstanceAttribute, CustomDataSource,
  GeometryInstance, Matrix4, PerInstanceColorAppearance, Primitive, Transforms, Viewer,
} from 'cesium';
import { VideoModelOverlay, videoModelOverlayPanelHtml, type SavedVideoOverlaySettings } from '../../src/videoModelOverlay';
import { parseCcCameraXml } from '../../src/ccCameraTrack';
import type { ImportRecord } from '../../src/types';

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
const objectCenter = world(4, 116, 12);
const originalMatrix = Transforms.eastNorthUpToFixedFrame(objectCenter);
const box = viewer.scene.primitives.add(new Primitive({
  geometryInstances: new GeometryInstance({
    geometry: BoxGeometry.fromDimensions({ dimensions: new Cartesian3(24, 20, 24), vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT }),
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString('#ff7324')) },
  }),
  modelMatrix: Matrix4.clone(originalMatrix), asynchronous: false,
  appearance: new PerInstanceColorAppearance({ flat: true, translucent: false, closed: true }),
}));
const cad = new CustomDataSource('Synthetic CAD');
await viewer.dataSources.add(cad);
const cadLine = cad.entities.add({ polyline: { positions: [world(-35, 90, 4), world(35, 90, 4), world(35, 145, 4), world(-35, 145, 4), world(-35, 90, 4)], width: 5, material: Color.CYAN, clampToGround: false } });
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
const messages: Array<{ message: string; error: boolean }> = [], renderErrors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => renderErrors.push(String(error?.stack || error)));
const overlay = new VideoModelOverlay(viewer, {
  getImports: () => imports, getRecord: () => undefined,
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
    modelDelta: xyz(Matrix4.multiplyByPoint(Matrix4.inverseTransformation(originalMatrix, new Matrix4()), Matrix4.getTranslation(box.modelMatrix, new Cartesian3()), new Cartesian3())),
    cadFirst: xyz(cadLine.polyline!.positions!.getValue(viewer.clock.currentTime)[0]),
    mediaTime: video?.currentTime ?? null, paused: video?.paused ?? null, saveCount, saved: saved ? structuredClone(saved.settings) : null,
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
const harness = {
  snapshot, initial, pixelStats,
  expected(time: number) {
    const clamped = Math.max(0, Math.min(4, time));
    const index = Math.min(1, Math.floor(clamped / 2)), amount = (clamped - index * 2) / 2;
    const start = Cartesian3.fromDegrees(120 + index * .0001, 30, 120), end = Cartesian3.fromDegrees(120 + (index + 1) * .0001, 30, 120);
    return xyz(Cartesian3.lerp(start, end, amount, new Cartesian3()));
  },
  async restoreSaved() { if (!saved) throw new Error('No saved scheme'); await overlay.restoreReplay(saved.files, structuredClone(saved.settings), saved.id); },
  parseXml(xml: string) { const data = parseCcCameraXml(xml); return { photos: data.photos.length, groups: data.photogroups.length, width: data.photogroups[0].intrinsics.width, height: data.photogroups[0].intrinsics.height, warnings: data.warnings }; },
};
(window as unknown as { __ccOverlayHarness: typeof harness }).__ccOverlayHarness = harness;
viewer.scene.requestRender();
