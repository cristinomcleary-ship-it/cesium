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
const tileUri = (name: string) => new URL(`/__occlusion-fixture__/${name}.gltf`, location.href).href;
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
let authorized = true;
const messages: Array<{ message: string; error: boolean }> = [], renderErrors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => renderErrors.push(String(error.stack || error)));
const overlay = new VideoModelOverlay(viewer, { getImports: () => imports.filter(item => authorized || item.id !== 'ground'),
  getRecord: id => id === 'ground' && !authorized ? undefined : records.get(id), notify: (message, error = false) => messages.push({ message, error }) });
let saved: { files: Record<string, File>; settings: SavedVideoOverlaySettings } | undefined;
overlay.onSave = async snapshot => { saved = { files: { ...snapshot.files }, settings: structuredClone(snapshot.settings) }; return 'saved-occlusion'; };
const xyz = (p: Cartesian3) => [p.x, p.y, p.z];
const matrices = () => models.map(model => Matrix4.toArray(model.modelMatrix));
const cadPositions = () => cadLines.map(line => line.polyline!.positions!.getValue(viewer.clock.currentTime).map(xyz));
const baseline = { matrices: matrices(), cad: cadPositions(), tilesMatrix: Matrix4.toArray(tiles.modelMatrix) };
function snapshot() { return { active: overlay.active, matrices: matrices(), cad: cadPositions(), tilesMatrix: Matrix4.toArray(tiles.modelMatrix),
  sourceShow: tiles.show, contentReady: !!regionA.content?.ready, detailReady: !!detailA.content?.ready, remoteReady: !!regionB.content?.ready,
  detailFailed: detailA.contentFailed, failedTileUrls: [...failedTileUrls],
  selectedContents: ((tiles as unknown as { _selectedTiles: Array<{ content?: { url?: string } }> })._selectedTiles ?? []).map(tile => tile.content?.url),
  mediaTime: document.querySelector<HTMLVideoElement>('.cc-video-backdrop video')?.currentTime,
  cameraPosition: xyz(viewer.camera.positionWC), tilesLoaded: tiles.tilesLoaded, shaderRestored: tiles.customShader === originalShader, styleRestored: tiles.style === originalStyle,
  cameraLocal: xyz(Matrix4.multiplyByPoint(Matrix4.inverseTransformation(frame, new Matrix4()), viewer.camera.positionWC, new Cartesian3())),
  saved: saved ? structuredClone(saved.settings) : null, messages: [...messages], renderErrors: [...renderErrors], info: document.getElementById('ccOcclusionInfo')?.textContent,
  badge: document.querySelector('.cc-video-status')?.textContent, modelReady: models.every(model => model.ready) }; }
function pixels(render = true) {
  if (render) viewer.render();
  const gl = viewer.canvas.getContext('webgl2')!, data = new Uint8Array(viewer.canvas.width * viewer.canvas.height * 4);
  gl.readPixels(0, 0, viewer.canvas.width, viewer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  let orange = 0, cyan = 0, green = 0, yellow = 0, magenta = 0, white = 0, transparent = 0, dirtyTransparent = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = data.subarray(i, i + 4);
    if (r > 60 && r > 1.6 * g && g > 2 * b && a > 20) orange++;
    if (r < 30 && g > 60 && b > 60 && a > 20) cyan++;
    if (r < 30 && g > 60 && b < 30 && a > 20) green++;
    if (r > 60 && g > 60 && b < 30 && r / g > .7 && r / g < 1.3 && a > 20) yellow++;
    if (r > 60 && g < 30 && b > 60 && a > 20) magenta++;
    if (r > 180 && g > 180 && b > 180 && a > 180) white++;
    if (a === 0) { transparent++; if (r || g || b) dirtyTransparent++; }
  }
  return { orange, cyan, green, yellow, magenta, white, transparent, dirtyTransparent, total: data.length / 4, glError: gl.getError() };
}
function capturePlaybackFrames(count: number) {
  return new Promise((resolve, reject) => {
    const samples: unknown[] = [], video = document.querySelector<HTMLVideoElement>('.cc-video-backdrop video')!;
    const timer = window.setTimeout(() => { remove(); video.pause(); reject(new Error('No rendered playback frames')); }, 15000);
    const remove = viewer.scene.postRender.addEventListener(() => {
      // Inspect the actual completed frame; do not repair it with an extra render.
      const p = pixels(false), s = snapshot();
      samples.push({ time: s.mediaTime, position: s.cameraPosition, local: s.cameraLocal, tilesLoaded: s.tilesLoaded, selected: s.selectedContents, pixels: p });
      if (samples.length === count) { remove(); clearTimeout(timer); video.pause(); resolve(samples); }
    });
  });
}
(window as unknown as { __occlusion: unknown }).__occlusion = { snapshot, pixels, baseline, planeGltf: () => JSON.stringify(planeGltf),
  capturePlaybackFrames,
  async restoreSaved() { if (!saved) throw new Error('No saved scheme'); await overlay.restoreReplay(saved.files, structuredClone(saved.settings), 'saved-occlusion'); },
  revoke() { authorized = false; overlay.refreshResources(); }, restoreAuthorization() { authorized = true; overlay.refreshResources(); },
  diagnostics: () => overlay.createDiagnostics() };
