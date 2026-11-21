import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run the actual controller and catalog/state. Inject only GPU, panel and Cesium
// boundary implementations, so asynchronous lifecycle behavior is executable in Node.
const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'output/engineering-catalog'); mkdirSync(output, { recursive: true });
const compiled = join(mkdtempSync(join(output, 'controller-test-')), 'controller.mjs');
const boundary = `
export const adapters=[],renderers=[],panels=[],photographies=[];
export let failApply=false;
export function reset(){adapters.length=renderers.length=panels.length=photographies.length=0;failApply=false;}
export function failNextApply(){failApply=true;}
export class EngineeringComponentPanel{
 constructor(actions){this.actions=actions;this.status='';this.rows=[];this.bound=false;panels.push(this);}
 open(){this.isOpen=true;}close(){this.isOpen=false;}destroy(){this.destroyed=true;}
 setInstances(items,selected){this.instances=items;this.instanceId=selected;}setBusy(value){this.busy=value;}
 setBound(value,units){this.bound=value;this.units=units;}setStatus(value,error){this.status=value;this.error=error;}
 setScope(value){this.scope=value;}setSelection(value){this.selection=value;}setPick(value){this.pick=value;}
 setDetection(value){this.detection=value;}setSaved(value){this.saved=value;}reveal(id){this.revealed=id;}
 setRows(rows,summary,label){this.rows=rows;this.summary=summary;this.label=label;}
 setPhotographyTargets(items,selected,enabled){this.photographyTargets=items;this.photographyTarget=selected;this.photographyEnabled=enabled;}
 setPhotographyStatus(message,error,busy){this.photographyStatus=message;this.photographyError=error;this.photographyBusy=busy;}
}
export class EngineeringPhotographyController{constructor(options){this.options=options;this.suspended=false;photographies.push(this);}check(){}updateFlags(){}select(){}retry(){}cancel(){}setSuspended(value){this.suspended=value;}dispose(){this.disposed=true;}}
export class EngineeringRenderAdapter{
 constructor(viewer,model,bindings){this.model=model;this.states=new Map();this.suspensions=0;this.original=new Map(model.shows);this.active=true;
 for(const binding of bindings)this.states.set(binding.componentId,{visible:true,occlusion:true});adapters.push(this);}
 applyStates(entries){if(failApply){failApply=false;throw new Error('injected state publication failure');}if(this.disposed)throw new Error('disposed adapter');
 for(const entry of entries){this.states.set(entry.componentId,entry);if(!this.suspensions)this.model.shows.set(entry.componentId,entry.visible);}}
 setSelection(ids){for(const id of ids)if(!this.states.has(id))throw new Error('unknown component selection');this.selection=[...ids];}
 setExternalEnabled(value){this.active=value;}getComponentBounds(){return this.bounds;}
 componentIdFromPick(pick){return pick?.id;}
 suspend(){this.suspensions++;for(const [id,value] of this.original)this.model.shows.set(id,value);let released=false;return()=>{if(released||this.disposed)return;released=true;this.suspensions--;if(!this.suspensions)for(const [id,value]of this.states)this.model.shows.set(id,value.visible);};}
 dispose(){if(this.disposed)return;this.disposed=true;for(const [id,value]of this.original)this.model.shows.set(id,value);}
}
export class EngineeringOcclusionRenderer{
 constructor(){renderers.push(this);this.suspensions=0;this.stats={};this.enableCalls=[];this.planes=[];}add(adapter){this.adapter=adapter;}
 setEnabled(value){if(value&&!this.enabled)this.stats.error=undefined;this.enabled=value;this.enableCalls.push(value);}
 setDetectionPlane(value){this.plane=value;this.planes.push(value);}getStats(){return this.stats;}dispose(){this.disposed=true;}
 suspend(){this.suspensions++;let released=false;return()=>{if(released||this.disposed)return;released=true;this.suspensions--;};}
}
export {Cartesian3,BoundingSphere,HeadingPitchRange} from 'engineering-test-math';
export const ScreenSpaceEventType={LEFT_CLICK:1};
export class ScreenSpaceEventHandler{constructor(){this.events=new Map();}setInputAction(callback,type){this.events.set(type,callback);}destroy(){this.destroyed=true;}}
`;
const bundle = await build({ stdin: { contents: `export {EngineeringComponentsController} from './src/engineeringComponents/controller.ts';export * from 'engineering-test-boundary';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', plugins: [{ name: 'engineering-lifecycle-boundaries', setup(builder) {
    builder.onResolve({ filter: /^engineering-test-math$/ }, () => ({ path: 'cesium', external: true }));
    builder.onResolve({ filter: /^(cesium|engineering-test-boundary)$|^\.\/(panel|renderAdapter|occlusion|photographyController)$/ }, () => ({ path: 'boundary', namespace: 'boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: boundary, loader: 'js' }));
  } }] });
writeFileSync(compiled, bundle.outputFiles[0].text);
const code = await import(pathToFileURL(compiled).href);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function glb(ids: string[]) {
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [ids.length] }],
    nodes: [...ids.map((id, mesh) => ({ name: id, mesh, extras: { componentId: id } })), { name: 'root', children: ids.map((_, index) => index) }],
    meshes: ids.map(id => ({ name: id, primitives: [{ attributes: { POSITION: 0 } }] })) });
  const bytes = new Uint8Array(20 + Math.ceil(json.length / 4) * 4), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, bytes.byteLength - 20, true); view.setUint32(16, 0x4e4f534a, true); bytes.fill(32, 20); bytes.set(new TextEncoder().encode(json), 20); return bytes;
}
function environment(unitOnly = false, modelContact?: unknown) {
  code.reset();
  const components = ['C0', 'C1', 'C2'].map((id, index) => ({ id, name: id, parentId: index === 1 ? 'TRACK' : 'ROOT', unitId: index < 2 ? 'T' : null,
    type: 'wall', typeName: '墙', visible: true, occlusion: false, geometryRef: { file: 'full.glb', node: id, mesh: id } }));
  const source = { schema: 'jiashan/component-library/2.0', modelRevision: 'test', geometryFile: 'full.glb', units: 'm', components,
    groups: [{ id: 'ROOT', name: '工程', parentId: null }, { id: 'TRACK', name: '轨道', parentId: 'ROOT' }, { id: 'REF', name: '参考', parentId: null }],
    referenceGeometry: [{ id: 'ref', name: '参考', parentId: 'REF', mode: 'line', visible: false, occlusion: false }] };
  const full = glb(['C0', 'C1', 'C2', 'ref']), unit = glb(['C0', 'C1']);
  const catalog = new TextEncoder().encode(JSON.stringify(source)), index = new TextEncoder().encode(JSON.stringify({ T: { path: 'structure-library/tunnel/T', count: 2, sha256: digest(unit) } }));
  const asset = (url: string, bytes: Uint8Array) => ({ url, sha256: digest(bytes), bytes: bytes.byteLength });
  const manifest = { available: true, fingerprint: digest(catalog), catalog: asset('/__engineering-components/components.json', catalog),
    index: asset('/__engineering-components/structure-library/index.json', index), fullModel: asset('/__engineering-components/full.glb', full),
    units: [{ id: 'T', count: 2, sha256: digest(unit), modelUrl: '/__engineering-components/T.glb', structureUrl: '/__engineering-components/T.json' }] };
  const storage = new Map<string, string>(), callbacks = new Set<() => void>(), errors: string[] = [], cameraFlights: unknown[] = [];
  const model = { show: true, ready: true, destroyed: false, isDestroyed() { return this.destroyed; }, shows: new Map((unitOnly ? ['C0', 'C1'] : ['C0', 'C1', 'C2', 'ref']).map(id => [id, true])) };
  const env = { context: { projectId: 'P', actorId: 'A' } as { projectId: string; actorId: string } | null, model, storage, callbacks, errors, cameraFlights,
    instances: [{ id: 'M', name: 'model', model, url: '/__library/files/model.glb', visible: true }],
    manifestHook: undefined as undefined | (() => Promise<Response>), manifestResponse: () => Response.json(manifest), releases: 0,
    viewer: { scene: { preUpdate: { addEventListener(callback: () => void) { callbacks.add(callback); return () => callbacks.delete(callback); } }, canvas: {}, pick: () => undefined }, camera: { heading: 0,
      directionWC: new code.Cartesian3(0, 0, -1), flyToBoundingSphere(sphere: unknown, options: unknown) { cameraFlights.push({ sphere, options }); } } } };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  replace('location', { origin: 'http://localhost', href: 'http://localhost/' });
  replace('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  replace('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/manifest')) return env.manifestHook ? env.manifestHook() : env.manifestResponse();
    const bytes = url.pathname === '/__library/files/model.glb' ? unitOnly ? unit : full : url.pathname.endsWith('/components.json') ? catalog : url.pathname.endsWith('/index.json') ? index : undefined;
    if (!bytes) throw new Error(`Unexpected fixture request: ${url.pathname}`);
    return new Response(bytes as unknown as BodyInit, { headers: { 'content-length': String(bytes.byteLength) } });
  });
  const controller = new code.EngineeringComponentsController({ viewer: env.viewer, getInstances: () => env.instances, getContext: () => env.context, modelContact,
    canPick: () => true, beginInteractionSession: () => () => { env.releases++; }, toast: (message: string) => errors.push(message) });
  return { ...env, env, controller, panel: controller.panel, cleanup() { controller.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}
const tick = () => new Promise<void>(resolveTick => setImmediate(resolveTick));

test('production contact bridge shares row state and retains its owner when the component tree disconnects', async () => {
  const listeners = new Set<() => void>(), selections: unknown[] = []; let selectedState: any, released = 0;
  const status = { targetId: 'all', enabled: true, busy: false, state: 'active', message: '真实三维接触', error: false, componentCount: 0 };
  const contact = { bindComponentSelection(_id: string, mappings: unknown, state: unknown) { selectedState = state; selections.push(mappings); return () => {}; },
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); released++; }; },
    getState() { return status; }, getTargets() { return [{ id: 'photo', name: '摄影' }]; },
    select(_id: string, targetId: string, enabled: boolean) { status.targetId = targetId; status.enabled = enabled; for (const listener of listeners) listener(); },
    retry() {}, cancel() {} };
  const f = environment(false, contact); try {
    await f.controller.connect('M'); assert.equal(code.photographies.length, 0, 'product bridge never starts the old 2D projection pipeline');
    assert.equal(selections.length, 1); f.panel.actions.setState('C0', false, 'occlusionEnabled', true);
    assert.equal(selectedState.get('C0').occlusionEnabled, true);
    f.panel.actions.photography('photo', false); assert.equal(f.panel.photographyEnabled, false);
    f.panel.actions.disconnect(); assert.equal(released, 1); assert.equal(selectedState.get('C0').occlusionEnabled, true);
    assert.equal(status.enabled, false, 'tree teardown does not clear or overwrite the model owner');
  } finally { f.cleanup(); }
});

test('real controller persists independent flags and scopes a sample without changing other saved components', async () => {
  const f = environment(); try {
    await f.controller.connect('M'); assert.equal(f.controller.activeInstanceId, 'M');
    f.panel.actions.setState('C0', false, 'visible', false); f.panel.actions.setState('C0', false, 'occlusionEnabled', true);
    assert.equal(f.model.shows.get('C0'), false); const saved = f.controller.snapshot;
    f.panel.actions.scope('T'); assert.equal(f.model.shows.get('C2'), false);
    f.panel.actions.setState(null, true, 'visible', false); const beforeAll = f.controller.snapshot;
    f.panel.actions.scope('all'); assert.equal(f.model.shows.get('C2'), true);
    assert.equal(f.controller.snapshot.flags, beforeAll.flags); assert.equal(code.adapters[0].states.get('C0').occlusion, true);
    assert.ok([...f.storage.values()].some(value => value.includes(saved.assetFingerprint)));
    f.panel.actions.disconnect(); assert.equal(f.model.shows.get('C0'), true);
    await f.controller.connect('M'); assert.equal(f.model.shows.get('C0'), false); assert.equal(code.adapters.at(-1).states.get('C0').occlusion, true);
  } finally { f.cleanup(); }
});

test('permission removal and model removal dispose effects and preserve saved state', async () => {
  const f = environment(); try {
    await f.controller.connect('M'); f.panel.actions.setState('C0', false, 'visible', false);
    const persisted = [...f.storage]; f.env.context = null;
    for (const callback of [...f.callbacks]) callback();
    assert.equal(f.controller.activeInstanceId, undefined); assert.equal(f.model.shows.get('C0'), true);
    assert.ok(code.adapters.every((value: { disposed: boolean }) => value.disposed)); assert.deepEqual([...f.storage], persisted);
    f.env.context = { projectId: 'P', actorId: 'A' }; await f.controller.connect('M'); f.controller.detachInstance('M');
    assert.equal(f.controller.activeInstanceId, undefined); assert.ok(code.renderers.every((value: { disposed: boolean }) => value.disposed));
  } finally { f.cleanup(); }
});

test('nested AR suspensions restore original node visibility and resume saved choices only after the last release', async () => {
  const f = environment(); try {
    await f.controller.connect('M'); f.panel.actions.setState('C0', false, 'visible', false);
    const first = f.controller.suspendExternalSceneEffects(), second = f.controller.suspendExternalSceneEffects();
    assert.equal(f.model.shows.get('C0'), true); first(); first(); assert.equal(f.model.shows.get('C0'), true);
    second(); assert.equal(f.model.shows.get('C0'), false);
    const release = f.controller.suspendExternalSceneEffects(); f.controller.detachInstance('M'); release();
    assert.equal(f.model.shows.get('C0'), true);
  } finally { f.cleanup(); }
});

for (const cleanupAction of ['off', 'close']) test(`AR suspension blocks camera/detection changes while ${cleanupAction} still clears active effects`, async () => {
  const f = environment(); try {
    await f.controller.connect('M'); f.controller.open();
    const adapter = code.adapters[0], renderer = code.renderers[0];
    adapter.bounds = new code.BoundingSphere(new code.Cartesian3(10, 20, 30), 5);
    f.panel.actions.locate(); assert.equal(f.cameraFlights.length, 1, 'the camera action works before suspension');
    f.panel.actions.detection(true, 3);
    assert.equal(renderer.enabled, true); assert.equal(f.panel.detection, true);
    assert.deepEqual(renderer.plane.center, new code.Cartesian3(10, 20, 27));
    const plane = renderer.plane, planeCount = renderer.planes.length, calls = renderer.enableCalls.length;
    const release = f.controller.suspendExternalSceneEffects();
    adapter.bounds = new code.BoundingSphere(new code.Cartesian3(100, 200, 300), 20);
    f.viewer.camera.directionWC = new code.Cartesian3(1, 0, 0);
    f.panel.actions.locate(); f.panel.actions.alignDetection(); f.panel.actions.detection(true, 42);
    assert.equal(f.cameraFlights.length, 1, 'the suspended module must not move the AR camera');
    assert.equal(renderer.plane, plane); assert.equal(renderer.planes.length, planeCount);
    assert.equal(renderer.enableCalls.length, calls, 'attempted enable cannot change renderer intent during the lease');
    if (cleanupAction === 'off') f.panel.actions.detection(false, 3); else f.panel.actions.close();
    assert.equal(renderer.enabled, false); assert.equal(f.panel.detection, false);
    if (cleanupAction === 'close') assert.equal(f.panel.isOpen, false);
    const clearedCalls = renderer.enableCalls.length;
    f.panel.actions.detection(true, 99); assert.equal(renderer.enableCalls.length, clearedCalls);
    assert.equal(f.panel.detection, false, 'suspended UI cannot reactivate a cleared detector');
    release(); assert.equal(renderer.enabled, false, 'releasing AR must not undo an explicit off or close');
    f.panel.actions.locate(); assert.equal(f.cameraFlights.length, 2, 'camera interaction resumes after the last lease');
  } finally { f.cleanup(); }
});

test('a renderer failure disables real detector intent until an explicit retry and handles a second failure', async () => {
  const f = environment(); try {
    await f.controller.connect('M');
    const renderer = code.renderers[0];
    code.adapters[0].bounds = new code.BoundingSphere(new code.Cartesian3(10, 20, 30), 5);
    f.panel.actions.setState('C0', false, 'occlusionEnabled', true);
    f.panel.actions.detection(true, 2); assert.equal(renderer.enabled, true);
    const saved = f.controller.snapshot, persisted = [...f.storage];
    renderer.stats.error = 'injected depth shader failure';
    const frame = () => { for (const callback of [...f.callbacks]) callback(); };
    frame();
    assert.equal(renderer.enabled, false); assert.equal(f.panel.detection, false);
    assert.match(f.panel.status, /injected depth shader failure/); assert.equal(f.panel.error, true);
    const calls = renderer.enableCalls.length;
    frame(); frame(); assert.equal(renderer.enabled, false); assert.equal(renderer.enableCalls.length, calls);
    assert.deepEqual(f.controller.snapshot, saved); assert.deepEqual([...f.storage], persisted);
    f.panel.actions.detection(true, 2);
    assert.equal(renderer.enabled, true); assert.equal(f.panel.detection, true);
    frame(); assert.equal(renderer.enabled, true, 'an acknowledged old error cannot cancel the explicit retry before it renders');
    renderer.stats.error = 'injected depth shader failure'; frame();
    assert.equal(renderer.enabled, false); assert.equal(f.panel.detection, false, 'a fresh failure with identical text still disables detection');
  } finally { f.cleanup(); }
});

test('closing a pending connection prevents late attachment', async () => {
  const f = environment(), gate = deferred<Response>(); try {
    f.env.manifestHook = () => gate.promise;
    const connecting = f.controller.connect('M'); f.controller.close(); gate.resolve(f.env.manifestResponse()); await connecting;
    assert.equal(f.controller.activeInstanceId, undefined); assert.equal(code.adapters.length, 0);
  } finally { f.cleanup(); }
});

test('an AR lease acquired while loading prevents new unsuspended effects from entering that lease', async () => {
  const f = environment(), gate = deferred<Response>(); try {
    f.env.manifestHook = () => gate.promise;
    const connecting = f.controller.connect('M'), release = f.controller.suspendExternalSceneEffects();
    gate.resolve(f.env.manifestResponse()); await connecting;
    assert.equal(f.controller.activeInstanceId, undefined); assert.equal(code.adapters.length, 0);
    release();
  } finally { f.cleanup(); }
});

test('failed scene suspension restores prior owners and does not leak a permission lock; nested leases still resume only once', async () => {
  for (const boundary of ['photography', 'adapter', 'depth']) {
    const f = environment(); try {
      await f.controller.connect('M');
      const photography = code.photographies[0], adapter = code.adapters[0], depth = code.renderers[0];
      const owner = boundary === 'photography' ? photography : boundary === 'adapter' ? adapter : depth;
      const key = boundary === 'photography' ? 'setSuspended' : 'suspend', original = owner[key];
      owner[key] = function(value: boolean) {
        if (boundary !== 'photography' || value) throw new Error(`injected-${boundary}-suspension`);
        return original.call(this, value);
      };
      assert.throws(() => f.controller.suspendExternalSceneEffects(), new RegExp(`injected-${boundary}-suspension`));
      owner[key] = original;
      assert.equal(photography.suspended, false); assert.equal(adapter.suspensions, 0); assert.equal(depth.suspensions, 0);
      f.panel.actions.setState('C0', false, 'visible', false); assert.equal(f.model.shows.get('C0'), false, 'failed lease must not leave the controller read-only');
      const outer = f.controller.suspendExternalSceneEffects(), inner = f.controller.suspendExternalSceneEffects();
      outer(); outer(); assert.equal(photography.suspended, true); assert.equal(adapter.suspensions, 1); assert.equal(depth.suspensions, 1);
      inner(); assert.equal(photography.suspended, false); assert.equal(adapter.suspensions, 0); assert.equal(depth.suspensions, 0);
      assert.equal(f.model.shows.get('C0'), false);
    } finally { f.cleanup(); }
  }
});

test('an error while publishing verified state rolls back the entire attachment', async () => {
  const f = environment(); try {
    code.failNextApply(); await f.controller.connect('M');
    assert.equal(f.controller.activeInstanceId, undefined);
    assert.ok(code.adapters.every((value: { disposed: boolean }) => value.disposed));
    assert.ok(code.renderers.every((value: { disposed: boolean }) => value.disposed));
  } finally { f.cleanup(); }
});

test('an obsolete request failure cannot replace the status of a later successful connection', async () => {
  const f = environment(), gate = deferred<Response>(); try {
    f.env.manifestHook = () => gate.promise; const first = f.controller.connect('M');
    f.env.manifestHook = undefined; await f.controller.connect('M'); const status = f.panel.status;
    gate.reject(new Error('old request failed')); await first;
    assert.equal(f.controller.activeInstanceId, 'M'); assert.equal(f.panel.status, status);
  } finally { f.cleanup(); }
});

test('reference group cannot enable physical occlusion or throw out of the UI event boundary', async () => {
  const f = environment(); try {
    await f.controller.connect('M'); const before = f.controller.snapshot;
    assert.doesNotThrow(() => f.panel.actions.setState('REF', true, 'occlusionEnabled', true));
    assert.deepEqual(f.controller.snapshot, before); assert.equal(code.adapters[0].states.get('ref').occlusion, false);
  } finally { f.cleanup(); }
});

test('a delayed state file cannot commit after account access has changed', async () => {
  const f = environment(), file = deferred<string>(); try {
    await f.controller.connect('M'); const before = f.controller.snapshot;
    const imported = { ...before, flags: '54', selectedId: 'C0' };
    f.panel.actions.importState({ size: 200, text: () => file.promise }); f.env.context = null;
    file.resolve(JSON.stringify(imported)); await tick();
    assert.deepEqual(f.controller.snapshot, before); assert.equal(f.model.shows.get('C0'), true);
  } finally { f.cleanup(); }
});

test('disposal invalidates in-flight fetches and unregisters scene callbacks', async () => {
  const f = environment(), gate = deferred<Response>(); try {
    f.env.manifestHook = () => gate.promise; const connecting = f.controller.connect('M');
    f.controller.dispose(); gate.resolve(f.env.manifestResponse()); await connecting;
    assert.equal(f.controller.activeInstanceId, undefined); assert.equal(f.callbacks.size, 0); assert.equal(f.panel.destroyed, true);
  } finally { f.cleanup(); }
});
