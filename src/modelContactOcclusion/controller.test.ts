import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SceneMode } from 'cesium';
import { parseEngineeringCatalog } from '../engineeringComponents/catalog.ts';
import { EngineeringComponentState } from '../engineeringComponents/state.ts';

const root = resolve(import.meta.dirname, '../..'), output = join(root, 'output/model-contact-tests');
mkdirSync(output, { recursive: true });
const file = join(mkdtempSync(join(output, 'controller-')), 'controller.mjs');
const bundle = await build({ entryPoints: [join(root, 'src/modelContactOcclusion/controller.ts')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', plugins: [{ name: 'contact-boundaries', setup(builder) {
  builder.onResolve({ filter: /^(?:\.\.\/temporaryWorksGlbScene|\.\/runtimeGeometry|\.\/client)$/ }, () => ({ path: 'boundary', namespace: 'boundary' }));
  builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ loader: 'js', contents: `export function getTemporaryWorksClippingManager(){throw Error('GPU boundary was not injected');}export function readRuntimeModelGeometry(){throw Error('runtime boundary was not injected');}export function runtimeModelWorldFromLocal(){throw Error('pose boundary was not injected');}export class ModelContactGeometryClient {}` }));
} }] });
writeFileSync(file, bundle.outputFiles[0].text);
const { ModelContactOcclusionController } = await import(pathToFileURL(file).href);
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const identity = 'a'.repeat(64);
const geometry = () => ({ stats: { sourceTriangles: 12, solidEntities: 1, surfaceEntities: 0 }, marker: Math.random() });
function state(instanceId = 'A') {
  const catalog = parseEngineeringCatalog({ schema: 'jiashan/component-library/2.0', modelRevision: 'fixture', geometryFile: 'full.glb', units: 'm',
    groups: [{ id: 'root', name: '根', parentId: null }, { id: 'group', name: '组', parentId: 'root' }],
    components: ['one', 'two'].map(id => ({ id, name: id, parentId: 'group', unitId: null, type: 'wall', typeName: '墙', visible: true, occlusion: false, geometryRef: { file: 'full.glb', node: id, mesh: id } })),
    referenceGeometry: [{ id: 'reference', name: '参考', parentId: 'root', mode: 'line', visible: false, occlusion: false }] }, { assetFingerprint: identity });
  return new EngineeringComponentState(catalog, { projectId: 'P', actorId: 'U', instanceId });
}
const bindings = [{ componentId: 'one', nodeIndices: [1] }, { componentId: 'two', nodeIndices: [2] }, { componentId: 'reference', nodeIndices: [3] }];
function fixture(storage = new Map<string, string>(), initialIdentity = identity, noTargets = false, effect: 'contact' | 'projection' = 'contact') {
  const scopes: any[] = [], callbacks = new Set<() => void>(), reads: any[] = [], jobs: any[] = [];
  const model = () => ({ ready: true, show: true, destroyed: false, pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1], isDestroyed() { return this.destroyed; } });
  const source = ['A', 'B'].map(id => ({ id, name: `${id}.skp`, model: model(), url: `/__library/files/${id}/data/model.glb` }));
  const targets = ['photo-one', 'photo-two'].map(id => ({ id, name: id, tileset: { isDestroyed: () => false } }));
  const scene = { mode: SceneMode.SCENE3D, morphTime: 1, preUpdate: { addEventListener(fn: () => void) { callbacks.add(fn); return () => callbacks.delete(fn); } } };
  const env: any = { context: { projectId: 'P', actorId: 'U' }, instances: [...source], targets: noTargets ? [] : [...targets], identity: initialIdentity, build: async () => geometry(), identify: undefined, resolved: undefined, changed: 0, scene };
  const controller = new ModelContactOcclusionController({ effect, viewer: { scene },
    getContext: () => env.context, getInstances: () => env.instances, getTargets: () => env.targets, onChanged: () => env.changed++,
    storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    dependencies: {
      identify: async (...args: any[]) => env.identify ? env.identify(...args) : { sha256: env.identity },
      resolveComponents: async (...args: any[]) => env.resolve ? env.resolve(...args) : env.resolved,
      read: async (source: any, options: any) => { reads.push(options); return { primitives: [], worldFromLocal: [...source.pose] }; },
      world: (value: any) => [...value.pose],
      client: () => ({ build: async (input: unknown, signal: AbortSignal) => { jobs.push({ input, signal }); return env.build(input); }, dispose() {} }),
      createScope: () => {
        const scope = { values: new Map(), enabled: true, calls: 0, disposed: false, fail: false,
          upsert(value: any) { this.calls++; if (this.fail || env.failedTarget === value.id) throw new Error('injected GPU failure'); this.values.set(value.id, value); },
          remove(id: string) { this.values.delete(id); }, clear() { this.values.clear(); }, dispose() { this.disposed = true; this.values.clear(); },
          setEnabled(value: boolean) { this.enabled = value; }, getStatus(id: string) { return this.values.has(id) && !env.missingStatus ? { state: env.blocked ?? 'active', message: env.blocked ?? 'active' } : undefined; } };
        scopes.push(scope); return scope;
      },
    } });
  if (effect === 'projection') env.build = async (input: any) => projected(input.worldFromLocal);
  controller.synchronize();
  return { env, source, targets, storage, scopes, reads, jobs, controller, callbacks, cleanup: () => controller.dispose() };
}

test('two model rows own independent contact scopes; hidden models and all authorized photographs remain supported', async () => {
  const f = fixture(); try {
    f.controller.toggle('A'); f.controller.toggle('B'); await settle();
    assert.equal(f.scopes.length, 2); assert.equal(f.scopes[0].values.size, 2); assert.equal(f.scopes[1].values.size, 2);
    f.source[0].model.show = false; f.controller.synchronize(); assert.equal(f.controller.getState('A').state, 'active');
    const before = f.scopes.map(scope => scope.calls), readCount = f.reads.length;
    for (let i = 0; i < 30; i++) f.controller.synchronize();
    assert.deepEqual(f.scopes.map(scope => scope.calls), before, 'unchanged frames never rebuild GPU volumes');
    f.source[0].model.pose[12] = 200; f.controller.synchronize();
    assert.equal(f.scopes[0].values.get('photo-one').volume.worldFromLocal[12], 200);
    assert.equal(f.reads.length, readCount, 'public placement changes reuse exact root-local geometry');
    f.controller.toggle('A'); assert.equal(f.scopes[0].values.size, 0); assert.equal(f.scopes[1].values.size, 2);
  } finally { f.cleanup(); }
});

test('component/group/all O shares one model scope, excludes references, ignores V and survives switching the tree', async () => {
  const f = fixture(); try {
    const a = state(), b = state('B'); a.apply({ kind: 'group', id: 'group' }, { occlusionEnabled: true }); b.apply({ kind: 'component', id: 'two' }, { occlusionEnabled: true });
    const release = f.controller.bindComponentSelection('A', bindings, a, identity);
    f.controller.setEnabled('A', true); await settle(); assert.deepEqual(f.reads[0].allowedNodeIndices, [1, 2]);
    const before = f.reads.length; a.apply({ kind: 'all' }, { visible: false }); await settle(); assert.equal(f.reads.length, before);
    release(); f.controller.bindComponentSelection('B', bindings, b, identity); f.controller.setEnabled('B', true); await settle();
    a.apply({ kind: 'component', id: 'one' }, { occlusionEnabled: false }); await settle();
    assert.deepEqual(f.reads.at(-1).allowedNodeIndices, [2]); assert.equal(f.controller.getState('A').partial, true);
    assert.equal(f.scopes.length, 2, 'tree switch cannot replace A with a full-model third contribution');
    a.applyIds(['one', 'two'], { occlusionEnabled: false }); assert.equal(f.scopes[0].values.size, 0); assert.equal(f.scopes[1].values.size, 2);
    f.controller.setEnabled('A', false); f.controller.setEnabled('A', true); assert.equal(f.controller.getState('A').state, 'empty');
  } finally { f.cleanup(); }
});

test('disable and cancellation reject late worker publication without affecting another model', async () => {
  const f = fixture(), pending = deferred<any>(); try {
    f.env.build = () => pending.promise; f.controller.toggle('A'); await settle(); assert.equal(f.controller.getState('A').busy, true);
    f.controller.toggle('A'); assert.equal(f.jobs[0].signal.aborted, true); pending.resolve(geometry()); await settle();
    assert.equal(f.scopes.length, 0); assert.equal(f.controller.getState('A').enabled, false);
    f.env.build = async () => geometry(); f.controller.toggle('B'); await settle();
    f.controller.retry('A'); await settle(); assert.equal(f.scopes.length, 1); assert.equal(f.controller.getState('B').state, 'active');
  } finally { f.cleanup(); }
});

test('project/access changes and removed instance identities reject stale jobs and dispose only owned scopes', async () => {
  const f = fixture(), pending = deferred<any>(); try {
    f.env.build = () => pending.promise; f.controller.toggle('A'); await settle();
    f.env.context = null; f.controller.synchronize(); pending.resolve(geometry()); await settle(); assert.equal(f.scopes.length, 0);
    f.env.context = { projectId: 'Q', actorId: 'U' }; f.env.build = async () => geometry(); f.controller.synchronize();
    assert.equal(f.controller.getState('A').enabled, false); f.controller.toggle('A'); await settle();
    f.env.instances = [f.source[1]]; f.controller.synchronize(); assert.equal(f.scopes[0].disposed, true);
  } finally { f.cleanup(); }
});

test('saved O selection survives browser recreation after resource identity verification; changed bytes are rejected', async () => {
  const storage = new Map<string, string>(), first = fixture(storage); const a = state(); a.applyIds(['two'], { occlusionEnabled: true });
  first.controller.bindComponentSelection('A', bindings, a, identity); first.controller.toggle('A'); await settle(); first.cleanup();
  const restored = fixture(storage); try { await settle(); assert.deepEqual(restored.reads[0].allowedNodeIndices, [2]); assert.equal(restored.controller.getState('A').state, 'active'); } finally { restored.cleanup(); }
  const changed = fixture(storage, 'b'.repeat(64)); try { await settle();
    assert.equal(changed.controller.getState('A').state, 'error'); assert.equal(changed.controller.getState('A').enabled, false); assert.equal(changed.scopes.length, 0);
  } finally { changed.cleanup(); }
});

test('AR leases pause all contact effects, nested releases restore current desired state, and removed targets do not return', async () => {
  const f = fixture(); try {
    f.controller.toggle('A'); await settle(); const one = f.controller.suspendExternalSceneEffects(), two = f.controller.suspendExternalSceneEffects();
    assert.equal(f.scopes[0].enabled, false); f.env.targets = [f.targets[1]]; one(); assert.equal(f.scopes[0].enabled, false);
    two(); assert.equal(f.scopes[0].disposed, true); assert.equal(f.scopes[0].values.size, 0);
    assert.equal(f.scopes.at(-1).enabled, true); assert.deepEqual([...f.scopes.at(-1).values.keys()], ['photo-two']);
    f.controller.setTarget('A', 'photo-two'); assert.equal(f.controller.getState('A').targetId, 'photo-two');
    f.env.targets = []; f.controller.synchronize(); assert.equal(f.scopes[0].values.size, 0); assert.equal(f.controller.getState('A').state, 'waiting');
  } finally { f.cleanup(); }
});

test('mixed solid/surface classification is reported honestly and blocked native mode never claims active', async () => {
  const f = fixture(); try {
    f.env.build = async () => ({ stats: { sourceTriangles: 7, solidEntities: 1, surfaceEntities: 2 } });
    f.controller.toggle('A'); await settle(); assert.equal(f.controller.getState('A').mode, 'mixed'); assert.match(f.controller.getState('A').message, /实体与表面混合/);
    f.env.blocked = 'suspended'; f.controller.synchronize(); assert.equal(f.controller.getState('A').state, 'suspended');
    f.env.blocked = undefined; f.controller.synchronize(); assert.equal(f.controller.getState('A').state, 'active');
  } finally { f.cleanup(); }
});

test('durable deletion forgets its captured scope; temporary unload preserves preference and cannot delete another project', async () => {
  const f = fixture(); try {
    f.controller.toggle('A'); await settle(); const originalKeys = [...f.storage.keys()].filter(key => key.startsWith('model-contact:'));
    f.controller.detachInstance('A'); assert.equal(originalKeys.every(key => f.storage.has(key)), true);
    f.controller.synchronize(); await settle(); const finish = f.controller.prepareDeletion('A');
    f.env.context = { projectId: 'Q', actorId: 'U' }; f.controller.synchronize(); f.controller.toggle('A'); await settle();
    const otherKeys = [...f.storage.keys()].filter(key => key.includes('"Q"')); finish();
    assert.equal(originalKeys.every(key => !f.storage.has(key)), true); assert.equal(otherKeys.every(key => f.storage.has(key)), true);
    assert.equal(f.controller.getState('A').state, 'active');
  } finally { f.cleanup(); }
});

test('moving during a cancelled O rebuild clears the old-position effect and unchanged frames do not scan component flags', async () => {
  const f = fixture(), a = state(), pending = deferred<any>(); try {
    a.applyIds(['one', 'two'], { occlusionEnabled: true });
    f.controller.bindComponentSelection('A', bindings, a, identity); f.controller.toggle('A'); await settle();
    let reads = 0; const get = a.get.bind(a); a.get = id => { reads++; return get(id); };
    for (let i = 0; i < 30; i++) f.controller.synchronize(); assert.equal(reads, 0, 'stable frames use cached component counts');
    const saved = [...f.storage]; a.applyIds(['one'], { visible: false });
    assert.deepEqual([...f.storage], saved, 'V-only changes do not rewrite potentially large contact selection preferences');
    f.env.build = () => pending.promise; a.applyIds(['one'], { occlusionEnabled: false }); await settle();
    assert.equal(f.scopes[0].values.size, 2, 'same-position valid effect survives while replacement is pending');
    f.controller.cancel('A'); f.source[0].model.pose[12] += 20; f.controller.synchronize();
    assert.equal(f.scopes[0].values.size, 0, 'a cancelled rebuild cannot leave an effect behind at the old position');
    pending.resolve(geometry()); await settle(); assert.equal(f.scopes[0].values.size, 0);
  } finally { f.cleanup(); }
});

test('a previous explicit photography target and enabled state migrate once into the same model owner', async () => {
  const storage = new Map<string, string>(), a = state(); a.applyIds(['one'], { occlusionEnabled: true });
  storage.set(`${a.storageKey}:photography:v1`, JSON.stringify({ version: 1, targetId: 'photo-two', enabled: true }));
  const f = fixture(storage); try {
    f.controller.bindComponentSelection('A', bindings, a, identity); await settle();
    assert.equal(f.controller.getState('A').enabled, true); assert.equal(f.controller.getState('A').targetId, 'photo-two');
    assert.deepEqual([...f.scopes[0].values.keys()], ['photo-two']);
    f.controller.setEnabled('A', false); f.controller.bindComponentSelection('A', bindings, a, identity);
    assert.equal(f.controller.getState('A').enabled, false, 'rebinding cannot revive old enabled state');
  } finally { f.cleanup(); }
});

test('GPU replacement failure retains the previous target, latches retries, and never treats missing status as active', async () => {
  const f = fixture(); try {
    f.controller.setTarget('A', 'photo-one'); f.controller.setEnabled('A', true); await settle();
    const old = f.scopes[0].values.get('photo-one'); f.env.failedTarget = 'photo-two';
    f.controller.setTarget('A', 'photo-two');
    assert.equal(f.scopes[0].values.get('photo-one'), old, 'failed new target cannot remove the authorized original');
    assert.equal(f.scopes[0].enabled, true); assert.equal(f.controller.getState('A').state, 'error');
    const calls = f.scopes[0].calls; for (let i = 0; i < 40; i++) f.controller.synchronize(); assert.equal(f.scopes[0].calls, calls, 'same failure is not retried per frame');
    f.env.failedTarget = undefined; f.controller.retry('A'); assert.deepEqual([...f.scopes[0].values.keys()], ['photo-two']);
    f.env.missingStatus = true; f.controller.synchronize(); assert.equal(f.controller.getState('A').state, 'waiting');
    f.env.missingStatus = false; f.controller.synchronize(); assert.equal(f.controller.getState('A').state, 'active');
    f.scopes[0].fail = true; f.source[0].model.pose[12] += 10; f.controller.synchronize();
    assert.equal(f.scopes[0].enabled, false, 'a retained old-position volume is paused after failed movement');
    assert.equal(f.scopes[0].values.size, 1); const failedCalls = f.scopes[0].calls;
    f.controller.synchronize(); assert.equal(f.scopes[0].calls, failedCalls);
  } finally { f.cleanup(); }
});

test('a failed catalog lookup retries component resolution instead of falling back to a full-model selection', async () => {
  const f = fixture(), a = state(); a.applyIds(['two'], { occlusionEnabled: true }); let attempts = 0;
  try {
    f.env.resolve = async () => { if (++attempts === 1) throw new Error('catalog temporarily unavailable'); return { bindings: bindings.slice(0, 2), state: a }; };
    f.controller.toggle('A'); await settle(); assert.equal(f.controller.getState('A').state, 'error'); assert.equal(f.reads.length, 0);
    f.controller.retry('A'); await settle(); assert.equal(attempts, 2); assert.deepEqual(f.reads[0].allowedNodeIndices, [2]);
    assert.equal(f.controller.getState('A').state, 'active');
  } finally { f.cleanup(); }
});

test('enabling before photography loads persists verified intent without mesh/worker allocation and resumes after refresh', async () => {
  const storage = new Map<string, string>(), first = fixture(storage, identity, true);
  first.controller.toggle('A'); await settle();
  assert.equal(first.controller.getState('A').enabled, true); assert.equal(first.controller.getState('A').state, 'waiting');
  assert.equal(first.reads.length, 0); assert.equal(first.jobs.length, 0); assert.equal(first.scopes.length, 0); first.cleanup();
  const restored = fixture(storage, identity, true); try {
    await settle(); assert.equal(restored.controller.getState('A').enabled, true); assert.equal(restored.reads.length, 0);
    restored.env.targets = restored.targets; restored.controller.synchronize(); await settle();
    assert.equal(restored.controller.getState('A').state, 'active'); assert.equal(restored.jobs.length, 1);
  } finally { restored.cleanup(); }
  const closing = fixture(storage); closing.controller.setEnabled('A', false); await settle(); closing.cleanup();
  const disabled = fixture(storage); try { await settle(); assert.equal(disabled.controller.getState('A').enabled, false); assert.equal(disabled.jobs.length, 0, 'off during identity revalidation remains off after refresh'); } finally { disabled.cleanup(); }
});

test('model readers and workers share one cancellable lease and queued cancellation never allocates a mesh snapshot', async () => {
  const f = fixture(), pending = deferred<any>(); try {
    f.env.build = () => pending.promise;
    f.controller.toggle('A'); f.controller.toggle('B'); await settle();
    assert.equal(f.reads.length, 1); assert.equal(f.jobs.length, 1); assert.match(f.controller.getState('B').message, /计算队列/);
    f.controller.toggle('B'); await settle(); assert.equal(f.reads.length, 1);
    f.controller.toggle('A'); await settle(); assert.equal(f.jobs[0].signal.aborted, true);
    f.controller.toggle('B'); await settle(); assert.equal(f.reads.length, 1, 'aborted active work retains its lease until the worker has actually stopped');
    f.env.build = async () => geometry(); pending.resolve(geometry()); await settle();
    assert.equal(f.reads.length, 2); assert.equal(f.controller.getState('B').state, 'active'); assert.equal(f.controller.getState('A').enabled, false);
  } finally { pending.resolve(geometry()); await settle(); f.cleanup(); }
});

test('one failing owner destructor cannot interrupt permission cleanup of other models or durable preferences', async () => {
  const f = fixture(); try {
    f.controller.toggle('A'); f.controller.toggle('B'); await settle();assert.equal(f.scopes.length, 2);
    const firstDispose=f.scopes[0].dispose.bind(f.scopes[0]);f.scopes[0].dispose=()=>{firstDispose();throw Error('injected owner destructor failure');};
    const finish=f.controller.prepareDeletion('A');f.env.context=null;
    assert.doesNotThrow(()=>f.controller.synchronize());assert(f.scopes.every(scope=>scope.disposed));assert(f.scopes.every(scope=>scope.values.size===0));
    assert.doesNotThrow(finish);assert.equal([...f.storage.keys()].some(key=>key.includes('"A"')&&key.startsWith('model-contact:')),false);
    f.controller.synchronize();assert.equal(f.controller.getState('A').enabled,false);assert.equal(f.controller.getState('B').enabled,false);
  } finally { f.cleanup(); }
});

test('user off and lost photography access use authoritative disposal instead of rollback-capable removal', async () => {
  const f=fixture();try{
    f.controller.toggle('A');f.controller.toggle('B');await settle();
    const a=f.scopes[0],b=f.scopes[1];
    a.clear=a.remove=()=>{throw Error('ordinary edits would restore revoked geometry');};
    assert.doesNotThrow(()=>f.controller.setEnabled('A',false));assert.equal(a.disposed,true);assert.equal(a.values.size,0);assert.equal(b.values.size,2);
    b.clear=b.remove=()=>{throw Error('ordinary target removal would restore revoked geometry');};
    f.env.targets=[f.targets[1]];assert.doesNotThrow(()=>f.controller.synchronize());
    assert.equal(b.disposed,true);assert.equal(b.values.size,0);assert.deepEqual([...f.scopes.at(-1).values.keys()],['photo-two']);
    assert.equal(f.controller.getState('B').state,'active');assert.equal(f.controller.getState('A').enabled,false);
  }finally{f.cleanup();}
});

test('2D, Columbus and morphing revoke only model contact while desired states and completed geometry survive stable 3D return', async () => {
  const f=fixture();try{
    f.controller.toggle('A');f.controller.toggle('B');await settle();
    const geometries=f.scopes.map(scope=>scope.values.get('photo-one').volume.geometry),reads=f.reads.length,jobs=f.jobs.length,saved=[...f.storage];
    for(const [mode,morphTime] of [[SceneMode.SCENE2D,0],[SceneMode.COLUMBUS_VIEW,0],[SceneMode.MORPHING,.5],[SceneMode.SCENE3D,.999]]){
      Object.assign(f.env.scene,{mode,morphTime});f.controller.synchronize();
      assert(f.scopes.every(scope=>scope.disposed&&scope.values.size===0));
      for(const id of ['A','B']){assert.equal(f.controller.getState(id).state,'paused');assert.equal(f.controller.getState(id).enabled,true);}
      assert.deepEqual([...f.storage],saved);assert.equal(f.reads.length,reads);assert.equal(f.jobs.length,jobs);
    }
    f.source[0].model.show=false;f.source[0].model.pose[12]+=20;
    Object.assign(f.env.scene,{mode:SceneMode.SCENE3D,morphTime:1});f.controller.synchronize();await settle();
    const active=f.scopes.filter(scope=>!scope.disposed);assert.equal(active.length,2);
    active.forEach((scope,index)=>assert.equal(scope.values.get('photo-one').volume.geometry,geometries[index]));
    assert.equal(active[0].values.get('photo-one').volume.worldFromLocal[12],30);assert.equal(f.source[0].model.show,false);
    assert.equal(f.reads.length,reads);assert.equal(f.jobs.length,jobs);assert.equal(f.controller.getState('A').state,'active');
  }finally{f.cleanup();}
});

test('morphing cancels queued and active geometry work and late results cannot attach outside 3D', async () => {
  const f=fixture(),pending=deferred<any>();try{
    f.env.scene.mode=SceneMode.SCENE2D;f.env.scene.morphTime=0;
    f.controller.toggle('A');await settle();assert.equal(f.reads.length,0);assert.equal(f.jobs.length,0);assert.equal(f.controller.getState('A').state,'paused');
    f.env.build=()=>pending.promise;Object.assign(f.env.scene,{mode:SceneMode.SCENE3D,morphTime:1});f.controller.synchronize();f.controller.toggle('B');await settle();
    assert.equal(f.jobs.length,1);assert.equal(f.reads.length,1);
    Object.assign(f.env.scene,{mode:SceneMode.MORPHING,morphTime:.5});f.controller.synchronize();
    assert.equal(f.jobs[0].signal.aborted,true);pending.resolve(geometry());await settle();assert.equal(f.scopes.length,0);assert.equal(f.reads.length,1);
    f.env.build=async()=>geometry();Object.assign(f.env.scene,{mode:SceneMode.SCENE3D,morphTime:1});f.controller.synchronize();await settle();
    assert.equal(f.reads.length,3);assert.equal(f.scopes.length,2);assert.equal(f.controller.getState('A').state,'active');assert.equal(f.controller.getState('B').state,'active');
  }finally{pending.resolve(geometry());await settle();f.cleanup();}
});

function projected(world: number[]) { return { kind: 'projection', worldFromLocal: [...world], projection: {
  triangleCount: 12, footprints: [{ outer: [{ longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 }, { longitude: 121, latitude: 31.001 }] }],
} }; }

test('projection strategy retains model owners, all photography targets and hidden/component controls without submitting volumes', async () => {
  const f=fixture(undefined,undefined,false,'projection');try{const a=state();a.apply({kind:'all'},{occlusionEnabled:true});f.controller.bindComponentSelection('A',bindings,a);
    f.controller.toggle('A');f.controller.toggle('B');await settle();assert.equal(f.scopes.length,2);assert(f.scopes.every(s=>s.values.size===2));
    assert.equal(f.controller.getState('A').mode,'projection');assert.match(f.controller.getState('A').message,/投影遮挡/);
    assert(f.scopes.every(s=>[...s.values.values()].every((v:any)=>v.footprints.length===1&&!('volume' in v))));
    const reads=f.reads.length;f.source[0].model.show=false;a.apply({kind:'all'},{visible:false});f.controller.synchronize();await settle();assert.equal(f.reads.length,reads);
    a.applyIds(['one'],{occlusionEnabled:false});await settle();assert.deepEqual(f.reads.at(-1).allowedNodeIndices,[2]);assert.equal(f.controller.getState('A').partial,true);
    f.controller.setEnabled('A',false);assert.equal(f.scopes[0].disposed,true);assert.equal(f.scopes[1].values.size,2);
  }finally{f.cleanup();}
});

test('projection movement withdraws the old position immediately, aborts stale work and recomputes exactly once at the final pose', async()=>{
  const f=fixture(undefined,undefined,false,'projection');try{f.controller.toggle('A');await settle();const first=f.scopes[0],pending=deferred<any>();
    f.env.build=()=>pending.promise;f.source[0].model.pose[12]+=5;f.controller.synchronize();assert.equal(first.disposed,true);assert.equal(first.values.size,0);await settle();
    const stale=f.jobs.at(-1);f.source[0].model.pose[12]+=7;f.controller.synchronize();assert.equal(stale.signal.aborted,true);
    f.env.build=async(input:any)=>projected(input.worldFromLocal);pending.resolve(projected(stale.input.worldFromLocal));await settle();f.controller.synchronize();await settle();
    assert.equal(f.controller.getState('A').state,'active');assert.equal(f.jobs.length,3);assert.equal(f.scopes.at(-1).values.size,2);
    for(let i=0;i<20;i++)f.controller.synchronize();assert.equal(f.jobs.length,3);
  }finally{f.cleanup();}
});

test('projection completion compares actual current placement even before the next scene callback',async()=>{
  const f=fixture(undefined,undefined,false,'projection');try{const pending=deferred<any>();f.env.build=()=>pending.promise;f.controller.toggle('A');await settle();
    const old=f.jobs[0].input.worldFromLocal;f.source[0].model.pose[12]+=1;pending.resolve(projected(old));await settle();assert.equal(f.scopes.length,0);
    f.env.build=async(input:any)=>projected(input.worldFromLocal);f.controller.synchronize();await settle();assert.equal(f.controller.getState('A').state,'active');assert.equal(f.jobs.length,2);
  }finally{f.cleanup();}
});

test('same-pose projection selection failures retain the previous authorized footprint, but cancellation followed by movement revokes it',async()=>{
  const f=fixture(undefined,undefined,false,'projection');try{const a=state();a.apply({kind:'all'},{occlusionEnabled:true});f.controller.bindComponentSelection('A',bindings,a);f.controller.toggle('A');await settle();
    const scope=f.scopes[0],before=scope.values.get('photo-one');f.env.build=async()=>{throw Error('projection budget');};a.applyIds(['one'],{occlusionEnabled:false});await settle();
    assert.equal(scope.values.get('photo-one'),before);assert.equal(f.controller.getState('A').state,'error');
    const pending=deferred<any>();f.env.build=()=>pending.promise;f.controller.retry('A');await settle();f.controller.cancel('A');assert.equal(scope.values.get('photo-one'),before);
    f.source[0].model.pose[12]+=5;f.controller.synchronize();assert.equal(scope.disposed,true);assert.equal(scope.values.size,0);
    f.controller.setEnabled('A',false);pending.resolve(projected(f.source[0].model.pose));await settle();assert(f.scopes.every(s=>s.values.size===0));
  }finally{f.cleanup();}
});

test('projection multi-target update rolls back successful earlier targets and keeps retries explicit',async()=>{
  const f=fixture(undefined,undefined,false,'projection');try{f.controller.select('A','photo-one',true);await settle();const scope=f.scopes[0],before=scope.values.get('photo-one');
    f.env.failedTarget='photo-two';f.controller.setTarget('A','all');assert.equal(f.controller.getState('A').state,'error');assert.equal(scope.values.get('photo-one'),before);assert.equal(scope.values.size,1);
    const calls=scope.calls;for(let i=0;i<20;i++)f.controller.synchronize();assert.equal(scope.calls,calls);
    f.env.failedTarget=undefined;f.controller.retry('A');assert.equal(scope.values.size,2);assert.equal(f.controller.getState('A').state,'active');
  }finally{f.cleanup();}
});

test('projection saved preferences and 3D roundtrip retain selection and completed geometry without another Worker',async()=>{
  const storage=new Map<string,string>(),f=fixture(storage,undefined,false,'projection');f.controller.toggle('A');await settle();f.cleanup();
  const r=fixture(storage,undefined,false,'projection');try{await settle();assert.equal(r.controller.getState('A').enabled,true);assert.equal(r.controller.getState('A').mode,'projection');
    const count=r.jobs.length,footprints=r.scopes[0].values.get('photo-one').footprints;r.env.scene.mode=SceneMode.SCENE2D;r.controller.synchronize();assert.equal(r.scopes[0].disposed,true);
    r.env.scene.mode=SceneMode.SCENE3D;r.controller.synchronize();await settle();assert.equal(r.jobs.length,count);assert.equal(r.scopes.at(-1).values.get('photo-one').footprints,footprints);
  }finally{r.cleanup();}
});

test('projection target capacity is checked before reading geometry or applying partial target updates',async()=>{
  const f=fixture(undefined,undefined,false,'projection');try{f.env.targets=Array.from({length:33},(_,i)=>({id:'target-'+i,name:'target-'+i,tileset:{isDestroyed:()=>false}}));
    f.controller.toggle('A');await settle();assert.match(f.controller.getState('A').message,/32 份预算/);assert.equal(f.reads.length,0);assert.equal(f.jobs.length,0);assert.equal(f.scopes.length,0);
    f.controller.setTarget('A','target-0');await settle();assert.equal(f.controller.getState('A').state,'active');assert.equal(f.scopes[0].values.size,1);
  }finally{f.cleanup();}
});
