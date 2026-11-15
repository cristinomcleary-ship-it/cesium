import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Exercise the production library with controlled network/GPU boundaries. The
// bundle remains in memory; no browser, credentials, or stored project is used.
let SceneLibrary;
const originals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, __libraryRace: globalThis.__libraryRace };
const owners = [];
before(async () => {
  const modules = {
    cesium: `export class Cartesian3 { static clone(v){return {...v}} static equals(a,b){return JSON.stringify(a)===JSON.stringify(b)} }
      export class UrlTemplateImageryProvider{constructor(v){Object.assign(this,v)}}
      export const Cesium3DTileset={fromUrl:(...a)=>globalThis.__libraryRace.tiles(...a)};
      export const Model={fromGltfAsync:(...a)=>globalThis.__libraryRace.model(...a)};
      export const Matrix4={IDENTITY:[],clone:v=>v,fromArray:v=>v};
      export const Color={fromCssColorString:()=>({withAlpha:()=>({})})};
      export const GeoJsonDataSource={load:(...a)=>globalThis.__libraryRace.gis(...a)};
      export const CzmlDataSource=GeoJsonDataSource,KmlDataSource=GeoJsonDataSource;
      export const IonResource={fromAssetId:async id=>String(id)};`,
    './cadImportWorkerClient': 'export const readCadImportInWorker=()=>{};',
    './cadPrimitiveLoader': 'export const loadCadPrimitiveCollection=()=>{};',
    './dxfLoader': 'export const clampCadToScene=()=>{},getCadBoundingSphere=()=>{},getCadModelSamplingExclusions=()=>{},loadCadImport=()=>{},useSampledCadHeights=()=>{};',
    './localImagery': 'export const loadLocalImagery=(...a)=>globalThis.__libraryRace.imagery(...a);',
    './modelAppearance': 'export const applyModelAppearance=()=>{};',
  };
  const result = await build({ entryPoints: ['src/sceneLibrary.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'library-runtime-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(modules, args.path) ? { path: args.path, namespace: 'race' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'race' }, args => ({ contents: modules[args.path] }));
    } }] });
  ({ SceneLibrary } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')));
});
afterEach(() => {
  for (const owner of owners.splice(0)) { clearTimeout(owner.cameraTimer); clearTimeout(owner.updateTimer); }
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key); else globalThis[key] = value;
  }
});
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function drain() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); }
function resource(name) {
  return { name, show: true, destroyed: 0, isDestroyed() { return this.destroyed > 0; }, destroy() { this.destroyed++; } };
}
function image(name) { return { name, disposed: 0, dispose() { this.disposed++; } }; }
function fixture() {
  const state = { context: 'A/actor-A', allowed: true, imports: [], children: new Set(), images: [], videoEvents: [],
    videoSource: '', videoGeneration: 0, attachedVisibility: [], requests: [], serverRecords: new Map(), fileGates: new Map(), ready: async () => {}, addData: async () => {} };
  const control = { tiles: async () => resource('tiles'), model: async () => resource('model'), gis: async () => resource('GIS'),
    imagery: async file => image(file.name), video: async () => {} };
  globalThis.__libraryRace = control;
  globalThis.window = { addEventListener() {}, setTimeout, clearTimeout, confirm: () => true };
  globalThis.document = { querySelector: () => null };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url), method = options.method ?? 'GET'; state.requests.push({ path, method });
    if (path === '/__library/records') return Response.json({ records: [...state.serverRecords.values()], problems: [] });
    if (path.startsWith('/__library/records/')) {
      const id = decodeURIComponent(path.slice('/__library/records/'.length));
      if (method === 'DELETE') { state.serverRecords.delete(id); return Response.json({ ok: true }); }
      const record = state.serverRecords.get(id);
      return record ? Response.json(record) : Response.json({ error: 'deleted' }, { status: 404 });
    }
    const gate = state.fileGates.get(path); if (gate) await gate.promise;
    return new Response(path.endsWith('.json') ? '{}' : 'saved bytes');
  };
  const remove = value => { if (!state.children.delete(value)) return false; value.destroy?.(); return true; };
  const camera = { positionWC: {}, directionWC: {}, upWC: {}, moveStart: { addEventListener() {} }, moveEnd: { addEventListener() {} } };
  const library = new SceneLibrary({
    viewer: { camera, scene: { requestRender() {}, primitives: { add(value) { state.children.add(value); state.attachedVisibility.push(value.show); return value; }, remove } },
      dataSources: { async add(value) { state.children.add(value); state.attachedVisibility.push(value.show); await state.addData(); return value; }, remove } },
    cadLoads: { get() {} }, getContextKey: () => state.context, canReadRecord: () => state.allowed,
    getImports: () => state.imports,
    addImport(name, kind, value, id, metadata) { state.imports.push({ id, name, kind, resource: value, ...metadata }); return id; },
    removeImport(item) { remove(item.resource); state.imports.splice(state.imports.indexOf(item), 1); },
    modelEditor: { add() {} }, waitForModelReady: (...args) => state.ready(...args), cacheGisBoundingSphere: async () => {},
    replaceImagery: value => state.images.push(value.name), getBasemap: () => 'street', layersChanged() {}, notify() {},
    async restoreVideo(files, settings, id, checkCurrent) {
      const generation = ++state.videoGeneration;
      state.videoEvents.push(id ?? 'copy'); state.videoSource = id ?? 'copy';
      try { await control.video(files, settings, id); checkCurrent?.(); }
      catch (error) { if (generation === state.videoGeneration) { state.videoEvents.push('clear'); state.videoSource = ''; } throw error; }
    },
    clearVideo() { state.videoEvents.push('clear'); state.videoSource = ''; },
  });
  library.render = () => {}; library.starting = false; owners.push(library);
  const add = (id, kind, settings = {}, files = {}) => {
    const record = { version: 1, id, name: id, kind, settings, files, visible: true, createdAt: '2026-11-15', updatedAt: '2026-11-15' };
    library.records.set(id, record); state.serverRecords.set(id, record); return record;
  };
  return { library, state, control, add };
}

test('the newest imagery choice wins and a late older candidate is disposed', async () => {
  const f = fixture(), gate = deferred(), old = image('slow A');
  f.add('A', 'Imagery', { bounds: {} }, { source: { name: 'A.png', url: '/A.png' } });
  f.add('B', 'Imagery', { imageryUrl: '/B/{z}/{x}/{y}' });
  f.control.imagery = () => gate.promise;
  const a = f.library.restore('A'); await drain(); await f.library.restore('B');
  gate.resolve(old); await a;
  assert.deepEqual(f.state.images, ['B']); assert.equal(f.library.activeImageryRecordId, 'B');
  assert.equal(old.disposed, 1); assert.equal(f.library.records.has('A'), true);
});

test('imagery denied after decoding is disposed without replacing the current image', async () => {
  const f = fixture(), gate = deferred(), candidate = image('A');
  f.state.images.push('previous'); f.library.activeImageryId = 'previous';
  f.add('A', 'Imagery', { bounds: {} }, { source: { name: 'A.png', url: '/A.png' } }); f.control.imagery = () => gate.promise;
  const pending = f.library.restore('A'); await drain(); f.state.allowed = false; gate.resolve(candidate); await pending;
  assert.deepEqual(f.state.images, ['previous']); assert.equal(f.library.activeImageryRecordId, 'previous'); assert.equal(candidate.disposed, 1);
});

test('a later CC scheme open supersedes a slow ordinary library video restore', async () => {
  const f = fixture(), gate = deferred(); f.state.fileGates.set('/A.mp4', gate);
  f.add('A', 'Drone Video', { video: {} }, { video: { name: 'A.mp4', url: '/A.mp4' } });
  f.add('B', 'Drone Video', { video: { mode: 'cc-overlay', selectedIds: [] } });
  const a = f.library.restore('A'); await drain(); await f.library.openVideoOverlayScheme('B'); gate.resolve(); await a;
  assert.deepEqual(f.state.videoEvents, ['B']); assert.equal(f.state.videoSource, 'B'); assert.equal(f.library.activeVideoRecordId, 'B');
});

test('shared decoder activation is serialized and a stale activation cannot outlive the latest one', async () => {
  const f = fixture(), gate = deferred(); f.add('A', 'Drone Video', { video: {} }); f.add('B', 'Drone Video', { video: {} });
  f.control.video = async (_files, _settings, id) => { if (id === 'A') await gate.promise; };
  const a = f.library.restore('A'); await drain(); assert.deepEqual(f.state.videoEvents, ['A']);
  const b = f.library.restore('B'); await drain(); assert.deepEqual(f.state.videoEvents, ['A']);
  gate.resolve(); await Promise.all([a, b]);
  assert.deepEqual(f.state.videoEvents, ['A', 'clear', 'B']); assert.equal(f.state.videoSource, 'B'); assert.equal(f.library.activeVideoRecordId, 'B');
});

test('an access change during decoder activation clears the obsolete video and its active ID', async () => {
  const f = fixture(), gate = deferred(); f.add('A', 'Drone Video', { video: {} }); f.control.video = () => gate.promise;
  const pending = f.library.restore('A'); await drain(); f.state.allowed = false; gate.resolve(); await pending;
  assert.deepEqual(f.state.videoEvents, ['A', 'clear']); assert.equal(f.library.activeVideoRecordId, ''); assert.equal(f.state.videoSource, '');
});

test('a late library activation never clears a newer external video owner', async () => {
  const f = fixture(), gate = deferred(); f.add('A', 'Drone Video', { video: {} }); f.control.video = () => gate.promise;
  const pending = f.library.restore('A'); await drain();
  f.state.context = 'B/actor-B'; ++f.state.videoGeneration; f.state.videoSource = 'manual'; f.library.markVideo('manual');
  gate.resolve(); await pending;
  assert.deepEqual(f.state.videoEvents, ['A']); assert.equal(f.state.videoSource, 'manual'); assert.equal(f.library.activeVideoRecordId, 'manual');
});

test('marking a newly imported image invalidates an older pending library restore', async () => {
  const f = fixture(), gate = deferred(), candidate = image('old');
  f.add('A', 'Imagery', { bounds: {} }, { source: { name: 'A.png', url: '/A.png' } }); f.control.imagery = () => gate.promise;
  const pending = f.library.restore('A'); await drain(); f.state.images.push('manual'); f.library.markImagery('manual');
  gate.resolve(candidate); await pending;
  assert.deepEqual(f.state.images, ['manual']); assert.equal(candidate.disposed, 1); assert.equal(f.library.activeImageryRecordId, 'manual');
});

test('a catalogue-deleted CC scheme cannot activate after its file finishes reading', async () => {
  const f = fixture(), gate = deferred(); f.state.fileGates.set('/A.mp4', gate);
  f.add('A', 'Drone Video', { video: { mode: 'cc-overlay', selectedIds: [] } }, { video: { name: 'A.mp4', url: '/A.mp4' } });
  const pending = f.library.restore('A'); await drain(); f.state.serverRecords.delete('A');
  await f.library.refreshVideoOverlaySchemes(); gate.resolve(); await pending;
  assert.deepEqual(f.state.videoEvents, []); assert.equal(f.library.records.has('A'), false);
});

test('tiles created after access is revoked are destroyed before they enter the scene', async () => {
  const f = fixture(), gate = deferred(), candidate = resource('tiles'); f.add('T', '3D Tiles', { url: '/tiles.json' }); f.control.tiles = () => gate.promise;
  const pending = f.library.restore('T'); f.state.allowed = false; gate.resolve(candidate); await pending;
  assert.equal(candidate.destroyed, 1); assert.equal(f.state.children.size, 0); assert.equal(f.state.imports.length, 0);
  assert.equal(f.library.records.has('T'), true);
});

test('a staged GLB is hidden and cannot commit into another project, but its saved record remains retryable', async () => {
  const f = fixture(), gate = deferred(), old = resource('model A'); f.add('M', 'Model', {}, { data: { url: '/M.glb' } });
  f.control.model = async () => old; f.state.ready = () => gate.promise;
  const pending = f.library.restore('M'); await drain();
  assert.equal(old.show, false); assert.deepEqual(f.state.attachedVisibility, [false]);
  f.state.context = 'B/actor-B'; gate.resolve(); await pending;
  assert.equal(old.destroyed, 1); assert.equal(f.state.imports.length, 0); assert.equal(f.state.children.size, 0);
  const next = resource('model B'); f.control.model = async () => next; f.state.ready = async () => {};
  await f.library.restore('M'); assert.equal(f.state.imports[0].resource, next); assert.equal(next.show, true);
});

test('a GIS datasource attached asynchronously is hidden and removed if access changes before publication', async () => {
  const f = fixture(), gate = deferred(), candidate = resource('GIS');
  f.add('G', 'GIS', {}, { source: { name: 'G.geojson', url: '/G.json' } });
  f.control.gis = async () => candidate; f.state.addData = () => gate.promise;
  const pending = f.library.restore('G'); await drain(); assert.equal(candidate.show, false);
  f.state.allowed = false; gate.resolve(); await pending;
  assert.equal(candidate.destroyed, 1); assert.equal(f.state.imports.length, 0); assert.equal(f.state.children.size, 0);
});

test('a rejected GIS candidate is destroyed even when it was never attached', async () => {
  const f = fixture(), gate = deferred(), candidate = resource('GIS');
  f.add('G', 'GIS', {}, { source: { name: 'G.geojson', url: '/G.json' } }); f.control.gis = () => gate.promise;
  const pending = f.library.restore('G'); await drain(); f.state.allowed = false; gate.resolve(candidate); await pending;
  assert.equal(candidate.destroyed, 1); assert.deepEqual(f.state.attachedVisibility, []); assert.equal(f.state.imports.length, 0);
});

test('an old readable-record request cannot put another actor\'s response into the catalogue', async () => {
  const f = fixture(), gate = deferred(); f.add('M', 'Model');
  const fetch = globalThis.fetch; globalThis.fetch = async (...args) => { await gate.promise; return fetch(...args); };
  const read = f.library.readableRecord('M'), rejection = assert.rejects(read, /项目或账号/);
  f.library.records.delete('M'); f.state.context = 'B/actor-B'; gate.resolve(); await rejection;
  assert.equal(f.library.records.has('M'), false);
});
