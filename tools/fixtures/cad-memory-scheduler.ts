import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  Cartesian3, Color, CustomDataSource, GeometryInstance, Matrix4, Model, Primitive,
  PrimitiveCollection, Transforms, Viewer,
} from 'cesium';
import { CAD_PRIMITIVE_VERTEX_BUDGET, loadCadPrimitiveCollection, type CadPrimitiveCollection } from '../../src/cadPrimitiveLoader';
import { getCadGeometrySchedulerStats } from '../../src/cadGeometryScheduler';
import type { CadImportEntity, CadImportPackage } from '../../src/cadImport';
import type { CadCoordinateOptions } from '../../src/types';

// This page deliberately exposes only ordinary controls and a rendered report.
// All geometry is synthetic; no private window automation hooks or project I/O.
const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const root = element('fixture'), button = element<HTMLButtonElement>('run'), status = element<HTMLOutputElement>('status');
const progress = element<HTMLProgressElement>('progress'), results = element<HTMLOListElement>('results');
const reportNode = element('report'), metrics = element('metrics');
const rendererErrors: string[] = [];
const pageErrors: string[] = [];
const owned = new Set<PrimitiveCollection>();
let running = false;
let viewer: Viewer;
let referenceModel: Model;
let referenceLayer: CustomDataSource;
let maxActive = 0, samples = 0;
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(120, 30, 20));
const coordinates: CadCoordinateOptions = { mode: 'local', longitude: 120, latitude: 30, altitude: 20,
  referenceX: 0, referenceY: 0, rotation: 0, scale: 1 };
const world = (x: number, y: number, z = 0) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
const readable = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
window.addEventListener('error', event => pageErrors.push(event.message));
window.addEventListener('unhandledrejection', event => pageErrors.push(readable(event.reason)));

type Check = { name: string; passed: boolean; details?: unknown };
let checks: Check[] = [];
function record(name: string, passed: boolean, details?: unknown) {
  checks.push({ name, passed, details });
  const item = document.createElement('li'); item.dataset.result = passed ? 'pass' : 'fail';
  item.textContent = `${passed ? '通过' : '失败'} · ${name}`; results.append(item);
  reportNode.textContent = JSON.stringify({ state: root.dataset.state, checks, rendererErrors, pageErrors }, null, 2);
  if (!passed) throw new Error(name);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function until(predicate: () => boolean, description: string, limit = 90_000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > limit) throw new Error(`${description} 超时（${limit / 1000} 秒）`);
    if (rendererErrors.length || pageErrors.length) throw new Error(`${description} 期间出现渲染或页面异常`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
function nextFrames(count = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('等待实际渲染帧超时')); }, 20_000);
    const remove = viewer.scene.postRender.addEventListener(() => {
      if (--count === 0) { clearTimeout(timer); remove(); resolve(); }
    });
    viewer.scene.requestRender();
  });
}
function source(longPoints = CAD_PRIMITIVE_VERTEX_BUDGET.absolute * 2 + 257, shortLines = 320, color = '#00ffff'): CadImportPackage {
  const entities: CadImportEntity[] = [{ type: 'POLYLINE', sourceType: 'LWPOLYLINE', layer: '长折线', color, lineweightMm: .6,
    vertices: Array.from({ length: longPoints }, (_, i) => ({ x: -130 + 260 * i / (longPoints - 1), y: 42 * Math.sin(i / 85), z: 1 })) }];
  for (let i = 0; i < shortLines; i++) {
    const x = -125 + (i % 20) * 13, y = -95 + Math.floor(i / 20) * 12;
    entities.push({ type: 'POLYLINE', sourceType: 'LINE', layer: '短线', color, lineweightMm: .4,
      vertices: [{ x, y, z: 2 }, { x: x + 7, y: y + 3, z: 2 }] });
  }
  return { format: 'cesium-cad-import', version: 2, source: { name: 'synthetic-memory-check.dwg', format: 'DWG', generatedAt: '2026-01-01T00:00:00Z' },
    statistics: { sourceEntities: entities.length, displayEntities: entities.length, skippedEntities: 0, unknownEntities: 0, layers: ['长折线', '短线'] }, entities, warnings: [] };
}
function primitives(collection: PrimitiveCollection): Primitive[] {
  return Array.from({ length: collection.length }, (_, i) => collection.get(i)).filter(value => value instanceof Primitive);
}
function featuresMatch(collection: CadPrimitiveCollection, drawing: CadImportPackage): boolean {
  return collection.cadPolylineFeatures.length === drawing.entities.length && collection.cadPolylineFeatures.every((feature, index) => {
    const entity = drawing.entities[index];
    return feature.entity.entityIndex === index && feature.layer === entity.layer && feature.positions.length === entity.vertices.length
      && feature.positions.every((position, i) => Cartesian3.equalsEpsilon(position, world(entity.vertices[i].x, entity.vertices[i].y, entity.vertices[i].z ?? 0), 0, 1e-7));
  });
}
function observeBatches(collection: PrimitiveCollection, output: number[]) {
  return collection.primitiveAdded.addEventListener(child => {
    if (!(child instanceof Primitive)) return;
    const groups = Array.isArray(child.geometryInstances) ? child.geometryInstances : [child.geometryInstances];
    const vertices = groups.reduce((total: number, instance: GeometryInstance) =>
      total + ((instance.geometry as unknown as { _positions?: Cartesian3[] })._positions?.length ?? 0), 0);
    output.push(vertices);
  });
}
const imageProbe = document.createElement('canvas'); imageProbe.width = 256; imageProbe.height = 192;
const imageContext = imageProbe.getContext('2d', { willReadFrequently: true })!;
function coloredPixels(): { cyan: number; magenta: number } {
  imageContext.drawImage(viewer.canvas, 0, 0, imageProbe.width, imageProbe.height);
  const rgba = imageContext.getImageData(0, 0, imageProbe.width, imageProbe.height).data;
  let cyan = 0, magenta = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] < 110 && rgba[i + 1] > 160 && rgba[i + 2] > 160) cyan++;
    if (rgba[i] > 170 && rgba[i + 1] < 110 && rgba[i + 2] > 170) magenta++;
  }
  return { cyan, magenta };
}
function referenceSnapshot() {
  return JSON.stringify({ matrix: Matrix4.toArray(referenceModel.modelMatrix), scale: referenceModel.scale, show: referenceModel.show,
    color: referenceModel.color, layerShow: referenceLayer.show, entities: referenceLayer.entities.values.map(entity => ({ id: entity.id, show: entity.show })) });
}
function referencePresent() { return viewer.scene.primitives.contains(referenceModel) && viewer.dataSources.contains(referenceLayer) && !referenceModel.isDestroyed(); }
function clearOwned() {
  for (const collection of owned) if (!collection.isDestroyed()) {
    if (viewer.scene.primitives.contains(collection)) viewer.scene.primitives.remove(collection);
    else collection.destroy();
  }
  owned.clear();
}
async function addReferenceModel(): Promise<Model> {
  const positions = new Float32Array([-8,-8,-8, 8,-8,-8, -8,8,-8, 8,8,-8, -8,-8,8, 8,-8,8, -8,8,8, 8,8,8]);
  const indices = new Uint16Array([0,2,1,1,2,3,4,5,6,5,7,6,0,4,2,2,4,6,1,3,5,3,7,5,0,1,4,1,5,4,2,6,3,3,6,7]);
  const binary = new Uint8Array(positions.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer)); binary.set(new Uint8Array(indices.buffer), positions.byteLength);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...binary))}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-8,-8,-8], max: [8,8,8] }, { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }],
    extensionsUsed: ['KHR_materials_unlit'], materials: [{ doubleSided: true, extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: [1,.45,.05,1] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' }));
  try {
    const model = await Model.fromGltfAsync({ url, modelMatrix: Matrix4.multiply(frame, Matrix4.fromTranslation(new Cartesian3(-150, 110, 12)), new Matrix4()) });
    viewer.scene.primitives.add(model); await until(() => model.ready, '参考模型就绪'); return model;
  } finally { URL.revokeObjectURL(url); }
}

async function run() {
  if (running) return;
  running = true; button.disabled = true; root.dataset.state = 'running'; checks = []; results.replaceChildren();
  rendererErrors.length = 0; pageErrors.length = 0; maxActive = 0; samples = 0; progress.value = 0;
  clearOwned();
  const queue = () => getCadGeometrySchedulerStats(viewer.scene);
  const sample = () => { const state = queue(); maxActive = Math.max(maxActive, state.active); samples++;
    metrics.textContent = `当前编译批次：${state.active}\n排队批次：${state.queued}\n本轮最大并发：${maxActive}\n状态采样：${samples}\n渲染异常：${rendererErrors.length}`; };
  const removeSample = viewer.scene.postRender.addEventListener(sample);
  const interval = setInterval(sample, 20);
  let removeHiddenProbe: (() => void) | undefined;
  try {
    const baseline = referenceSnapshot();
    const drawing = source(), original = JSON.stringify(drawing), batchVertices: number[] = [];
    status.textContent = '1/4 正在分批编译长折线与多批短线…';
    const loaded = await loadCadPrimitiveCollection(drawing, coordinates, { scene: viewer.scene, displayMode: 'absolute', primitiveBatchSize: 50, batchSize: 100,
      beforePopulate(collection) { owned.add(collection); viewer.scene.primitives.add(collection); observeBatches(collection, batchVertices); },
      onProgress(done, total) { progress.value = done / total; } });
    record('源 CAD 与完整逻辑折线均未改写', JSON.stringify(drawing) === original && featuresMatch(loaded.collection, drawing),
      { sourceFeatures: drawing.entities.length, logicalFeatures: loaded.cadPolylineFeatures.length, longLinePoints: drawing.entities[0].vertices.length });
    const actualPrimitives = primitives(loaded.collection);
    record('所有分批图元真实 ready，且每批顶点受限', actualPrimitives.length > 3 && actualPrimitives.every(primitive => primitive.ready)
      && batchVertices.length === actualPrimitives.length && batchVertices.every(vertices => vertices > 0 && vertices <= CAD_PRIMITIVE_VERTEX_BUDGET.absolute),
      { primitives: actualPrimitives.length, batchVertices, budget: CAD_PRIMITIVE_VERTEX_BUDGET.absolute });
    await nextFrames();
    const visiblePixels = coloredPixels();
    record('合成 CAD 实际进入画面', visiblePixels.cyan > 10, visiblePixels);

    status.textContent = '2/4 编译隐藏 AR 副本，并逐帧检查是否误显示…';
    const hiddenSource = source(undefined, 180, '#ff00ff');
    const hiddenBefore = JSON.stringify(hiddenSource);
    let hiddenCollection: PrimitiveCollection | undefined, hiddenFrames = 0, maxMagenta = 0, visibleOutsideUpdate = false;
    removeHiddenProbe = viewer.scene.postRender.addEventListener(() => {
      if (!hiddenCollection || hiddenCollection.isDestroyed()) return;
      hiddenFrames++; maxMagenta = Math.max(maxMagenta, coloredPixels().magenta);
      if (hiddenCollection.show) visibleOutsideUpdate = true;
    });
    const hidden = await loadCadPrimitiveCollection(hiddenSource, coordinates, { scene: viewer.scene, displayMode: 'absolute', primitiveBatchSize: 50,
      showWhileLoading: false, beforePopulate(collection) { hiddenCollection = collection; collection.show = false; owned.add(collection); viewer.scene.primitives.add(collection); } });
    await nextFrames(); removeHiddenProbe(); removeHiddenProbe = undefined;
    record('隐藏 AR 副本编译完成且不向画面提交颜色', primitives(hidden.collection).every(primitive => primitive.ready)
      && !hidden.collection.show && !visibleOutsideUpdate && maxMagenta === 0 && hiddenFrames > 0,
      { readyPrimitives: primitives(hidden.collection).length, hiddenFrames, maxMagenta, visibleOutsideUpdate });
    record('隐藏副本保留完整逻辑线及源文件', featuresMatch(hidden.collection, hiddenSource) && JSON.stringify(hiddenSource) === hiddenBefore);

    status.textContent = '3/4 取消正在编译的新图层，核对已有模型和 CAD…';
    const existingCad = loaded.collection, existingPrimitives = primitives(existingCad);
    const controller = new AbortController(); let cancelledCollection: PrimitiveCollection | undefined, activeFrames = 0;
    const removeCancel = viewer.scene.postRender.addEventListener(() => {
      if (cancelledCollection && !cancelledCollection.isDestroyed() && queue().active > 0 && ++activeFrames >= 2) controller.abort();
    });
    let cancelled = false;
    try {
      await loadCadPrimitiveCollection(source(CAD_PRIMITIVE_VERTEX_BUDGET.absolute * 8 + 333, 600), coordinates,
        { scene: viewer.scene, signal: controller.signal, displayMode: 'absolute', primitiveBatchSize: 50,
          beforePopulate(collection) { cancelledCollection = collection; owned.add(collection); viewer.scene.primitives.add(collection); } });
    } catch (error) { if (error instanceof Error && error.name === 'AbortError') cancelled = true; else throw error; }
    finally { removeCancel(); }
    await until(() => queue().pending === 0, '取消后的在途 Worker 结清');
    record('取消只移除本次未完成加载，既有参考模型和图层保持不变', cancelled && activeFrames >= 2
      && !!cancelledCollection?.isDestroyed() && !viewer.scene.primitives.contains(cancelledCollection!)
      && referencePresent() && referenceSnapshot() === baseline && viewer.scene.primitives.contains(existingCad)
      && existingPrimitives.every(primitive => !primitive.isDestroyed() && primitive.ready) && featuresMatch(existingCad, drawing),
      { cancelled, activeFrames, existingCadPrimitives: existingPrimitives.length });

    status.textContent = '4/4 检查并发上限、队列收尾与场景继续渲染…';
    await nextFrames(5); sample();
    record('共享场景的活动编译批次不超过 2', maxActive > 0 && maxActive <= 2 && queue().maxActive <= 2, { maxActive, schedulerMaxActive: queue().maxActive, samples });
    record('全部导入已结算、编译队列清空且场景继续渲染', queue().pending === 0 && queue().queued === 0 && queue().active === 0
      && actualPrimitives.every(primitive => primitive.ready) && primitives(hidden.collection).every(primitive => primitive.ready), queue());
    record('未出现渲染异常或页面异常', rendererErrors.length === 0 && pageErrors.length === 0, { rendererErrors, pageErrors });
    root.dataset.state = 'passed'; status.textContent = `验证通过：${checks.length} 项检查完成。`;
  } catch (error) {
    root.dataset.state = 'failed'; status.textContent = `验证失败：${error instanceof Error ? error.message : String(error)}`;
    const item = document.createElement('li'); item.dataset.result = 'fail'; item.textContent = status.textContent; results.append(item);
    checks.push({ name: '未完成的验证阶段', passed: false, details: readable(error) });
  } finally {
    removeHiddenProbe?.(); removeSample(); clearInterval(interval);
    reportNode.textContent = JSON.stringify({ state: root.dataset.state, checks, maxActive, samples, queue: queue(), rendererErrors, pageErrors }, null, 2);
    running = false; button.disabled = false; button.textContent = '重新运行验证';
  }
}

async function initialize() {
  viewer = new Viewer('viewer', { baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false, navigationHelpButton: false,
    infoBox: false, selectionIndicator: false, showRenderLoopErrors: false, useBrowserRecommendedResolution: false,
    contextOptions: { webgl: { preserveDrawingBuffer: true } } });
  viewer.resolutionScale = 1;
  viewer.scene.globe.show = false; viewer.scene.skyBox!.show = false; viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.sun!.show = false; viewer.scene.moon!.show = false; viewer.scene.backgroundColor = Color.fromCssColorString('#0a1520');
  viewer.scene.renderError.addEventListener((_scene, error) => rendererErrors.push(readable(error)));
  viewer.camera.setView({ destination: world(0, 0, 440), orientation: {
    direction: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 0, -1), new Cartesian3()),
    up: Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 1, 0), new Cartesian3()) } });
  referenceLayer = new CustomDataSource('既有参考图层'); await viewer.dataSources.add(referenceLayer);
  referenceLayer.entities.add({ id: 'reference-yellow-line', polyline: { positions: [world(-165, -115, 1), world(165, -115, 1)], width: 5, material: Color.YELLOW } });
  referenceModel = await addReferenceModel();
  root.dataset.state = 'ready'; status.textContent = '场景就绪。点击“运行验证”开始。'; button.disabled = false;
  button.addEventListener('click', () => { void run(); });
}
void initialize().catch(error => { root.dataset.state = 'failed'; status.textContent = `初始化失败：${readable(error)}`; reportNode.textContent = readable(error); });
