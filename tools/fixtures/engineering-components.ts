import { BoundingSphere, Cartesian2, Cartesian3, Color, HeadingPitchRange, Model, SceneTransforms, Transforms, Viewer } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { EngineeringComponentsController, type EngineeringContext, type EngineeringInstance } from '../../src/engineeringComponents/controller';

(window as Window & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = '/__engineering_browser_cesium/';
const viewer = new Viewer('viewer', { baseLayer: false, globe: false, skyBox: false, skyAtmosphere: false,
  animation: false, timeline: false, baseLayerPicker: false, navigationHelpButton: false, geocoder: false,
  homeButton: false, fullscreenButton: false, sceneModePicker: false, infoBox: false, selectionIndicator: false,
  scene3DOnly: true, requestRenderMode: false, contextOptions: { webgl: { antialias: true, preserveDrawingBuffer: true } } });
viewer.scene.backgroundColor = Color.fromCssColorString('#142332');
viewer.scene.highDynamicRange = false;
const status = document.querySelector<HTMLElement>('#fixtureStatus')!;
const events: unknown[] = [], errors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => { errors.push(String(error?.stack ?? error)); });
const session = await (await fetch('/__management/session')).json();
let context: EngineeringContext | null = { projectId: 'safety:project', actorId: session.userId };
let instance: EngineeringInstance | undefined;
let gltf: any, rawCatalog: any, originalMatrix = '', originalNodes = new Map<number, { show: boolean; transform: string }>();
let currentIds = new Map<string, number>(), allIds: string[] = [], referenceIds = new Set<string>();
let loading = false;
const controller = new EngineeringComponentsController({ viewer, getInstances: () => instance ? [instance] : [], getContext: () => context,
  canPick: () => true, beginInteractionSession: () => { events.push('pick-start'); return () => { events.push('pick-end'); }; },
  toast: (message, error) => { events.push({ message, error }); } });
controller.open();
const frames = (count = 3) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { stop(); reject(new Error('Fixture render timed out: ' + errors.join('\n'))); }, 20000);
  let remaining = count; const stop = viewer.scene.postRender.addEventListener(() => { if (--remaining <= 0) { stop(); clearTimeout(timer); resolve(); } else viewer.scene.requestRender(); });
  viewer.scene.requestRender();
});
const runtimeNodes = () => (instance?.model as any)?._sceneGraph?._runtimeNodes ?? [];
function bounds(id?: string) {
  if (!instance) throw new Error('No model');
  if (!id) return BoundingSphere.clone(instance.model.boundingSphere);
  const node = runtimeNodes()[currentIds.get(id)!]; let result: BoundingSphere | undefined;
  for (const primitive of node?.runtimePrimitives ?? []) {
    const sphere = primitive.drawCommand?.command.boundingVolume;
    if (sphere) result = result ? BoundingSphere.union(result, sphere, result) : BoundingSphere.clone(sphere);
  }
  if (!result) throw new Error('No runtime bounds: ' + id); return result;
}
async function focus(id?: string) {
  const sphere = bounds(id);
  viewer.camera.flyToBoundingSphere(sphere, { duration: 0, offset: new HeadingPitchRange(0.4, -0.55, Math.max(8, sphere.radius * 3.2)) });
  await frames();
}
async function load(unitId: string) {
  if (loading) throw new Error('Fixture load already running'); loading = true; status.textContent = '载入 ' + unitId;
  try {
    if (instance) { controller.detachInstance(instance.id); viewer.scene.primitives.remove(instance.model); instance = undefined; }
    const manifestResponse = await fetch('/__engineering-components/manifest');
    const manifest = await manifestResponse.json(); if (!manifestResponse.ok || !manifest.available) throw new Error('Asset manifest unavailable');
    const entry = unitId === 'full' ? { modelUrl: manifest.fullModel.url } : manifest.units.find((entry: any) => entry.id === unitId);
    if (!entry) throw new Error('Unknown sample ' + unitId);
    const [bytes, catalog] = await Promise.all([fetch(entry.modelUrl).then(r => r.arrayBuffer()), rawCatalog ? Promise.resolve(rawCatalog) : fetch(manifest.catalog.url).then(r => r.json())]);
    rawCatalog = catalog; allIds = [...catalog.components, ...catalog.referenceGeometry].map((entry: any) => entry.id);
    referenceIds = new Set(catalog.referenceGeometry.map((entry: any) => entry.id));
    gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, new DataView(bytes).getUint32(12, true))));
    currentIds = new Map(gltf.nodes.flatMap((node: any, index: number) => node.mesh === undefined ? [] : [[node.extras.componentId, index]]));
    const model = await Model.fromGltfAsync({ url: entry.modelUrl, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 100)),
      allowPicking: true, incrementallyLoadTextures: false, minimumPixelSize: 0 });
    viewer.scene.primitives.add(model);
    instance = { id: `fixture-${unitId}`, name: unitId === 'full' ? '嘉善全线 · 原始 GLB' : `${unitId} · 原始 GLB`, model, url: entry.modelUrl, visible: true };
    while (!model.ready) await frames(1);
    await frames(4);
    originalMatrix = JSON.stringify(Array.from(model.modelMatrix));
    originalNodes = new Map([...currentIds.values()].map(index => { const node = runtimeNodes()[index]; return [index, { show: node.show, transform: JSON.stringify(node.transform) }]; }));
    await focus(); controller.synchronize();
    history.replaceState(null, '', location.pathname + '?model=' + encodeURIComponent(unitId));
    status.textContent = `${unitId} · ${currentIds.size} 节点已就绪`; return stats();
  } finally { loading = false; }
}
function flags(id: string) {
  const saved = controller.snapshot; if (!saved) return null;
  const index = allIds.indexOf(id); if (index < 0) throw new Error('Unknown fixture id ' + id);
  const byte = Number.parseInt(saved.flags.slice(Math.floor(index / 4) * 2, Math.floor(index / 4) * 2 + 2), 16), value = (byte >> (index % 4 * 2)) & 3;
  return { visible: !!(value & 1), occlusionEnabled: !!(value & 2) };
}
function stats() {
  const nodes = runtimeNodes(); let visiblePhysical = 0, visibleReferences = 0, changedShows = 0, changedTransforms = 0;
  for (const [id, index] of currentIds) {
    const node = nodes[index]; if (!node) continue; if (node.show) { if (referenceIds.has(id)) visibleReferences++; else visiblePhysical++; }
    const initial = originalNodes.get(index); if (initial?.show !== node.show) changedShows++;
    if (initial?.transform !== JSON.stringify(node.transform)) changedTransforms++;
  }
  const gl = (viewer.scene as any).context._gl, info = gl.getExtension('WEBGL_debug_renderer_info');
  return { ready: !!instance?.model.ready, loading, instanceId: instance?.id, activeInstanceId: controller.activeInstanceId,
    physical: [...currentIds.keys()].filter(id => !referenceIds.has(id)).length, references: [...currentIds.keys()].filter(id => referenceIds.has(id)).length,
    visiblePhysical, visibleReferences, changedShows, changedTransforms,
    matrixUnchanged: !instance || originalMatrix === JSON.stringify(Array.from(instance.model.modelMatrix)),
    selected: controller.snapshot?.selectedId, render: controller.renderStats, errors: [...errors], events: [...events],
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    stages: viewer.scene.postProcessStages.length, primitives: viewer.scene.primitives.length };
}
function pickPoint(id: string) {
  const sphere = bounds(id), center = SceneTransforms.worldToWindowCoordinates(viewer.scene, sphere.center);
  if (!center) throw new Error('Component is off screen');
  const right = Cartesian3.add(sphere.center, Cartesian3.multiplyByScalar(viewer.camera.rightWC, sphere.radius, new Cartesian3()), new Cartesian3());
  const edge = SceneTransforms.worldToWindowCoordinates(viewer.scene, right)!;
  const radius = Math.max(6, Math.abs(edge.x - center.x));
  for (const dy of [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6]) for (const dx of [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6]) {
    const point = new Cartesian2(center.x + dx * radius, center.y + dy * radius);
    const result = viewer.scene.pick(point), index = result?.detail?.node?._id;
    if (result?.primitive === instance?.model && index === currentIds.get(id)) return { x: point.x, y: point.y, id, nodeIndex: index, actualPick: true };
  }
  throw new Error('No actual pick hit for ' + id);
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fixture-load]')) button.onclick = () => { void load(button.dataset.fixtureLoad!).catch(error => { errors.push(String(error)); status.textContent = String(error); }); };
(window as any).engineeringFixture = { viewer, controller, load, focus, frames, stats, flags, pickPoint,
  get snapshot() { return controller.snapshot; }, get currentIds() { return [...currentIds.keys()]; },
  setContext(value: EngineeringContext | null) { context = value; controller.synchronize(); },
  getContext() { return context; }, nodeShow(id: string) { return runtimeNodes()[currentIds.get(id)!]?.show; },
  suspend() { return controller.suspendExternalSceneEffects(); } };
try { await load(new URLSearchParams(location.search).get('model') ?? 'A001'); (window as any).engineeringFixture.ready = true; }
catch (error) { errors.push(String(error)); status.textContent = String(error); (window as any).engineeringFixture.failure = String(error); }
