import 'cesium/Build/Cesium/Widgets/widgets.css';
import { BoundingSphere, Cartesian3, Cartographic, Cesium3DTileset, GroundPolylinePrimitive, Matrix3, Matrix4, Transforms, Viewer } from 'cesium';
import { loadCadPrimitiveCollection, type CadPrimitiveCollection } from '../../src/cadPrimitiveLoader';
import { VideoOverlayResources } from '../../src/videoOverlayResources';
import type { CadImportPackage } from '../../src/cadImport';
import type { ImportRecord, CadCoordinateOptions } from '../../src/types';
import type { LibraryRecord } from '../../src/projectLibrary';

// A real GPU terrain/model sampling fixture, independent of the Entity-only
// video workflow fixture. No user files or external asset services are used.
const viewer = new Viewer('viewer', { baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false, navigationHelpButton: false,
  infoBox: false, selectionIndicator: false, contextOptions: { webgl: { alpha: true, preserveDrawingBuffer: true } },
  showRenderLoopErrors: false });
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(120, 30, 0));
const inverse = Matrix4.inverseTransformation(frame, new Matrix4());
const world = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
const local = (point: Cartesian3) => Matrix4.multiplyByPoint(inverse, point, new Cartesian3());
const direction = Matrix4.multiplyByPointAsVector(frame, Cartesian3.normalize(new Cartesian3(0, 1, -2), new Cartesian3()), new Cartesian3());
const up = Matrix4.multiplyByPointAsVector(frame, Cartesian3.normalize(new Cartesian3(0, 2, 1), new Cartesian3()), new Cartesian3());
viewer.camera.setView({ destination: world(0, -180, 450), orientation: { direction, up } });
const errors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => errors.push(String(error.stack || error)));
const renderFrames = (count = 3) => new Promise<void>(resolve => {
  let frames = 0; const remove = viewer.scene.postRender.addEventListener(() => { if (++frames >= count) { remove(); resolve(); } });
  viewer.scene.requestRender();
});
const wait = async (ready: () => boolean) => { const start = performance.now(); while (!ready()) { if (performance.now() - start > 45000) throw new Error('Surface fixture geometry timed out'); await renderFrames(1); } };
const coordinates: CadCoordinateOptions = { mode: 'local', longitude: 120, latitude: 30, altitude: 0, referenceX: 0, referenceY: 0, rotation: 0, scale: 1 };
const drawing: CadImportPackage = { format: 'cesium-cad-import', version: 2,
  source: { name: 'synthetic-sloping-source.dwg', format: 'DWG', generatedAt: '2026-10-22T00:00:00Z' },
  statistics: { sourceEntities: 1, displayEntities: 1, skippedEntities: 0, unknownEntities: 0, layers: ['surface'] },
  entities: [{ type: 'POLYLINE', sourceType: 'LINE', layer: 'surface', color: '#ffffff', lineweightMm: 0.5,
    vertices: [{ x: -50, y: 0, z: 0 }, { x: 50, y: 0, z: 20 }] }], warnings: [] };
const urls: string[] = [];
const jsonUrl = (value: unknown, type = 'application/json') => { const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type })); urls.push(url); return url; };
const drawingUrl = jsonUrl(drawing);
function planeGltf() {
  // Cesium's glTF axis conversion matches the main video workflow fixture.
  const axis = Matrix4.multiply(Matrix4.fromRotationTranslation(Matrix3.fromArray([1, 0, 0, 0, 0, 1, 0, -1, 0])),
    Matrix4.fromRotationTranslation(Matrix3.fromArray([0, 0, -1, 0, 1, 0, 1, 0, 0])), new Matrix4());
  const inverseAxis = Matrix4.inverseTransformation(axis, new Matrix4());
  const points = [[-150, -150, 100], [150, -150, 100], [150, 150, 100], [-150, 150, 100]]
    .map(point => Matrix4.multiplyByPointAsVector(inverseAxis, Cartesian3.fromArray(point), new Cartesian3()));
  const vertices = new Float32Array(points.flatMap(p => [p.x, p.y, p.z])), indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const binary = new Uint8Array(vertices.byteLength + indices.byteLength); binary.set(new Uint8Array(vertices.buffer)); binary.set(new Uint8Array(indices.buffer), vertices.byteLength);
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...binary))}`, byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.byteLength, target: 34962 }, { buffer: 0, byteOffset: vertices.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 1, 2].map(i => Math.min(...points.map(p => [p.x, p.y, p.z][i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => [p.x, p.y, p.z][i]))) }, { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }],
    extensionsUsed: ['KHR_materials_unlit'], materials: [{ doubleSided: true, extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: [.1, .3, .6, 1] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }] };
}
let imports: ImportRecord[] = [], session: VideoOverlayResources | undefined, source: CadPrimitiveCollection | undefined, tiles: Cesium3DTileset | undefined;
const records = new Map<string, LibraryRecord>();
function dispose() {
  session?.restore(); session = undefined;
  if (source && !source.isDestroyed()) viewer.scene.primitives.remove(source); source = undefined;
  if (tiles && !tiles.isDestroyed()) viewer.scene.primitives.remove(tiles); tiles = undefined;
  imports = []; records.clear(); viewer.scene.globe.show = true;
}
function copy(): CadPrimitiveCollection | undefined {
  for (let i = 0; i < viewer.scene.primitives.length; i++) {
    const item = viewer.scene.primitives.get(i) as CadPrimitiveCollection;
    if (item !== source && item.cadPolylineFeatures) return item;
  }
}
function geometry() {
  const target = copy();
  if (!target) return [];
  const matrix = target.get(0).modelMatrix as Matrix4;
  return target.cadPolylineFeatures.flatMap(feature => feature.positions.map(point => {
    const transformed = Matrix4.multiplyByPoint(matrix, point, new Cartesian3()), p = local(transformed);
    return { local: [p.x, p.y, p.z], height: Cartographic.fromCartesian(transformed).height };
  }));
}
const api = {
  ready: true,
  async setup(mode: 'terrain' | 'model', missing = false) {
    dispose();
    if (mode === 'model') {
      const gltfUrl = jsonUrl(planeGltf(), 'model/gltf+json');
      tiles = await Cesium3DTileset.fromUrl(jsonUrl({ asset: { version: '1.1' }, geometricError: 0, root: {
        boundingVolume: { box: [0, 0, 100, 155, 0, 0, 0, 155, 0, 0, 0, 1] }, geometricError: 0, transform: Matrix4.toArray(frame), content: { uri: gltfUrl } } }), { maximumScreenSpaceError: 16 });
      viewer.scene.primitives.add(tiles);
      imports.push({ id: 'surface', name: 'GPU horizontal surface', kind: '3D Tiles', resource: tiles, visible: true, boundingSphere: new BoundingSphere(world(0, 0, 100), 220) });
      await wait(() => !!tiles?.tilesLoaded); await renderFrames(3);
      // Keep an actual loaded model but move its coverage away from the CAD.
      // The sampler must reject this gap instead of returning the globe/source Z.
      if (missing) { tiles.modelMatrix = Matrix4.fromTranslation(Cartesian3.subtract(world(500, 0, 0), world(0, 0, 0), new Cartesian3())); await renderFrames(2); }
    }
    const result = await loadCadPrimitiveCollection(drawing, coordinates, { displayMode: mode, scene: viewer.scene,
      beforePopulate: collection => { viewer.scene.primitives.add(collection); } });
    source = result.collection;
    imports.push({ id: 'cad', name: 'Slope in source, draped in map', kind: 'CAD', representation: 'primitive', resource: source, visible: true, boundingSphere: result.boundingSphere });
    records.set('cad', { version: 1, id: 'cad', name: 'Slope in source', kind: 'CAD', visible: true, createdAt: '', updatedAt: '',
      files: { data: { name: 'synthetic.cadimport', url: drawingUrl } }, settings: { coordinates, displayMode: mode } });
    await wait(() => source!.get(0).ready); await renderFrames(3);
    return { groundPrimitive: source.get(0) instanceof GroundPolylinePrimitive, source: source.cadPolylineFeatures[0].positions.map(point => local(point).z),
      primitiveCount: viewer.scene.primitives.length, sourceShow: source.show, surfaceShow: tiles?.show ?? null, globeShow: viewer.scene.globe.show,
      clampSupported: viewer.scene.clampToHeightSupported, camera: [viewer.camera.positionWC.x, viewer.camera.positionWC.y, viewer.camera.positionWC.z] };
  },
  async enter() {
    session = await VideoOverlayResources.create({ viewer, imports: () => imports, getRecord: id => records.get(id) });
    session.setSelection(['cad']); await renderFrames(3);
    return { item: session.get('cad'), geometry: geometry(), sourceShow: source?.show, globeShow: viewer.scene.globe.show, copyCount: copy() ? 1 : 0 };
  },
  async tilt(east: number, north: number) {
    session!.applyAdjustments({ cad: { east: 0, north: 0, up: 0, heading: 0, tiltEast: east, tiltNorth: north } });
    await renderFrames(3); return geometry();
  },
  async restore() {
    const oldCopy = copy(); session!.restore(); session = undefined; await renderFrames(2);
    return { copyDestroyed: oldCopy?.isDestroyed() ?? true, copyCount: copy() ? 1 : 0, sourceShow: source?.show, surfaceShow: tiles?.show ?? null,
      globeShow: viewer.scene.globe.show, primitiveCount: viewer.scene.primitives.length, camera: [viewer.camera.positionWC.x, viewer.camera.positionWC.y, viewer.camera.positionWC.z],
      inputs: viewer.scene.screenSpaceCameraController.enableInputs, source: source?.cadPolylineFeatures[0].positions.map(point => local(point).z), errors };
  },
  errors: () => errors,
  destroy() { dispose(); for (const url of urls) URL.revokeObjectURL(url); viewer.destroy(); },
};
Object.assign(window, { __surface: api });
