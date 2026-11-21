import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEngineeringCatalog } from './catalog.ts';
import { EngineeringComponentState } from './state.ts';

// Exercise the actual coordinator and actual component state. Only worker,
// renderer and Cesium pose boundaries are replaced; jobs intentionally ignore
// cancellation so stale-result protection is independently tested.
const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'output/engineering-photography-cpu'); mkdirSync(output, { recursive: true });
const compiled = join(mkdtempSync(join(output, 'coordinator-')), 'controller.mjs');
const boundary = `
export const jobs=[],clients=[],clippings=[];
export function reset(){jobs.length=clients.length=clippings.length=0;}
export class EngineeringFootprintClient {
 constructor(bytes,bindings,nodes){this.bytes=bytes;this.bindings=bindings;this.nodes=nodes;clients.push(this);}
 project(matrix,ids,signal,progress){return new Promise((resolve,reject)=>jobs.push({matrix:[...matrix],ids:[...ids],signal,progress,resolve,reject}));}
 dispose(){this.disposed=true;}
}
export class EngineeringPhotographyOcclusion {
 constructor(viewer,options){this.options=options;this.applies=[];this.clearCount=0;this.suspended=false;this.status={state:'disabled',message:'disabled',polygons:0};clippings.push(this);}
 apply(target,footprints){this.applies.push({target,footprints});this.status={state:this.suspended?'suspended':'active',message:'applied',polygons:footprints.length};}
 clear(){this.clearCount++;this.status={state:'disabled',message:'disabled',polygons:0};}
 setSuspended(value){this.suspended=value;if(this.applies.length)this.status={state:value?'suspended':'active',message:value?'suspended':'active',polygons:value?0:1};}
 dispose(){this.disposed=true;}
}
export function engineeringWorldFromGltf(model){if(model.invalidPose||model.destroyed)throw new Error('invalid-model-pose');return [...model.pose];}
export function engineeringRuntimeNodeTransforms(model,bindings){return bindings.map(value=>({nodeIndex:value.nodeIndices[0],matrix:[...model.pose]}));}
`;
const bundled = await build({ stdin: { contents: `export {EngineeringPhotographyController} from './src/engineeringComponents/photographyController.ts';export * from 'photography-test-boundary';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', plugins: [{ name: 'photography-coordinator-boundaries', setup(builder) {
    builder.onResolve({ filter: /^photography-test-boundary$|^\.\/(footprintClient|photography|projectionPose)$/ }, () => ({ path: 'boundary', namespace: 'boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: boundary, loader: 'js' }));
  } }] });
writeFileSync(compiled, bundled.outputFiles[0].text);
const code = await import(pathToFileURL(compiled).href);
const catalog = parseEngineeringCatalog({ schema: 'jiashan/component-library/2.0', modelRevision: 'test', geometryFile: 'full.glb', units: 'm',
  groups: [{ id: 'ROOT', name: 'root', parentId: null }], referenceGeometry: [],
  components: ['C0', 'C1', 'C2'].map(id => ({ id, name: id, parentId: 'ROOT', unitId: null,
    type: 'wall', typeName: 'wall', visible: true, occlusion: false, geometryRef: { file: 'full.glb', node: id, mesh: id } })),
}, { assetFingerprint: 'a'.repeat(64) });
const tick = () => new Promise<void>(yes => setImmediate(yes));
const footprint = [{ outer: [{ longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 }, { longitude: 121, latitude: 31.001 }] }];
function fixture(storage = new Map<string, string>(), identity = { projectId: 'P', actorId: 'A', instanceId: 'M' }) {
  code.reset();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const timers = new Map<number, () => void>(); let timerId = 0;
  replace('setTimeout', (callback: () => void) => { timers.set(++timerId, callback); return timerId; });
  replace('clearTimeout', (id: number) => { timers.delete(id); });
  replace('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const state = new EngineeringComponentState(catalog, identity);
  const a = { destroyed: false, isDestroyed() { return this.destroyed; } }, b = { destroyed: false, isDestroyed() { return this.destroyed; } };
  const env = { allowed: true, model: { show: true, destroyed: false, invalidPose: false,
    pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  targets: [{ id: 'a', name: 'photography A', tileset: a }, { id: 'b', name: 'photography B', tileset: b }] };
  const statuses: { message: string; error: boolean; busy: boolean }[] = [], targetStates: unknown[] = [];
  const controller = new code.EngineeringPhotographyController({ viewer: {}, model: env.model, bytes: new ArrayBuffer(1),
    bindings: ['C0', 'C1', 'C2'].map((componentId, index) => ({ componentId, nodeIndices: [index] })), state,
    getTargets: () => env.targets, canMutate: () => env.allowed,
    onStatus: (message: string, error = false, busy = false) => statuses.push({ message, error, busy }),
    onTargets: (...args: unknown[]) => targetStates.push(args) });
  const start = async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await tick(); };
  const enable = async (ids = ['C0']) => { state.applyIds(ids, { occlusionEnabled: true }); controller.updateFlags(); controller.select('a', true); await start(); };
  const complete = async (index = code.jobs.length - 1) => { const job = code.jobs[index]; job.resolve({ footprints: footprint, componentCount: job.ids.length, triangleCount: job.ids.length * 12 }); await tick(); };
  return { env, a, b, state, controller, statuses, targetStates, storage, timers, start, enable, complete,
    cleanup() { controller.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}

test('coordinator gates delayed jobs by cancellation and never applies a late worker result', async () => {
  const f = fixture(); try {
    await f.enable(); assert.equal(code.jobs.length, 1); f.controller.cancel();
    assert.equal(code.jobs[0].signal.aborted, true); await f.complete(); assert.equal(code.clippings.length, 0);
    f.controller.check(); await f.start(); assert.equal(code.jobs.length, 1, 'cancel does not restart on the next camera frame');
    f.controller.retry(); await f.start(); assert.equal(code.jobs.length, 2); await f.complete();
    assert.equal(code.clippings[0].applies.length, 1);
  } finally { f.cleanup(); }
});

test('new occlusion selection supersedes an old in-flight result while visible-only changes do not calculate again', async () => {
  const f = fixture(); try {
    await f.enable(['C0']);
    f.state.applyIds(['C1'], { occlusionEnabled: true }); f.controller.updateFlags(); await f.start();
    assert.equal(code.jobs.length, 2); assert.equal(code.jobs[0].signal.aborted, true);
    await f.complete(0); assert.equal(code.clippings.length, 0); await f.complete(1);
    assert.deepEqual(code.jobs[1].ids, ['C0', 'C1']);
    f.state.applyIds(['C0', 'C1'], { visible: false }); f.controller.updateFlags(); f.env.model.show = false;
    f.controller.check(); await f.start(); assert.equal(code.jobs.length, 2); assert.equal(code.clippings[0].applies.length, 1);
    f.state.apply({ kind: 'all' }, { occlusionEnabled: true }); f.controller.updateFlags(); await f.start();
    assert.deepEqual(code.jobs[2].ids, ['C0', 'C1', 'C2']); await f.complete();
    assert.equal(code.clippings[0].applies.length, 2);
  } finally { f.cleanup(); }
});

test('permission loss blocks a late result even before another scene frame checks the coordinator', async () => {
  const f = fixture(); try {
    await f.enable(); f.env.allowed = false; await f.complete();
    assert.equal(code.clippings.length, 0); f.controller.check();
    assert.equal(f.controller.status.busy, false);
  } finally { f.cleanup(); }
});

test('permission suspension resumes the existing desired clipping without requiring a manual retry', async () => {
  const f = fixture(); try {
    await f.enable(); await f.complete(); f.env.allowed = false; f.controller.check();
    assert.equal(code.clippings[0].suspended, true);
    f.env.allowed = true; f.controller.check(); await f.start();
    if (code.jobs.length > 1) await f.complete();
    assert.equal(code.clippings[0].suspended, false);
    assert.equal(f.controller.status.clipping.state, 'active');
  } finally { f.cleanup(); }
});

test('unloaded or replaced photography blocks late writes and applies only a freshly resolved object', async () => {
  const f = fixture(); try {
    await f.enable(); f.a.destroyed = true; await f.complete(); assert.equal(code.clippings.length, 0);
    const replacement = { destroyed: false, isDestroyed() { return this.destroyed; } };
    f.env.targets = [{ id: 'a', name: 'photography A', tileset: replacement }];
    f.controller.check(); await f.start(); assert.equal(code.jobs.length, 2); await f.complete();
    assert.equal(code.clippings[0].applies[0].target.tileset, replacement);
  } finally { f.cleanup(); }
});

test('moving a hidden model clears stale placement before calculating and late pose results cannot apply', async () => {
  const f = fixture(); try {
    await f.enable(); await f.complete(); const clipping = code.clippings[0];
    f.env.model.show = false; f.env.model.pose[12] = 100; f.controller.check();
    assert.equal(clipping.clearCount, 1); await f.start();
    f.env.model.pose[12] = 200; await f.complete(); assert.equal(clipping.applies.length, 1);
    f.controller.check(); await f.start(); await f.complete();
    assert.equal(code.jobs.at(-1).matrix[12], 200); assert.equal(clipping.applies.length, 2);
  } finally { f.cleanup(); }
});

test('worker failure preserves same-position clipping and explicit retry can recover', async () => {
  const f = fixture(); try {
    await f.enable(); await f.complete(); const clipping = code.clippings[0];
    f.state.applyIds(['C1'], { occlusionEnabled: true }); f.controller.updateFlags(); await f.start();
    code.jobs.at(-1).reject(new Error('union-failure')); await tick();
    assert.equal(clipping.clearCount, 0); assert.equal(clipping.applies.length, 1); assert.equal(f.statuses.at(-1)?.error, true);
    f.controller.retry(); await f.start(); await f.complete(); assert.equal(clipping.applies.length, 2);
  } finally { f.cleanup(); }
});

test('failed target migration preserves the authorized previous photography until a new result commits', async () => {
  const f = fixture(); try {
    await f.enable(); await f.complete(); const clipping = code.clippings[0];
    f.controller.select('b', true); await f.start();
    assert.equal(clipping.clearCount, 0); assert.equal(clipping.applies.at(-1).target.tileset, f.a);
    code.jobs.at(-1).reject(new Error('new-target-union-failure')); await tick();
    assert.equal(clipping.clearCount, 0); assert.equal(clipping.applies.at(-1).target.tileset, f.a);
    f.controller.retry(); await f.start(); await f.complete();
    assert.equal(clipping.applies.at(-1).target.tileset, f.b); assert.equal(clipping.applies.length, 2);
  } finally { f.cleanup(); }
});

test('an old target that loses authorization is cleared immediately while its replacement is pending', async () => {
  const f = fixture(); try {
    await f.enable(); await f.complete(); const clipping = code.clippings[0];
    f.controller.select('b', true); f.env.targets = f.env.targets.filter(value => value.id === 'b');
    f.controller.check(); assert.equal(clipping.clearCount, 1); await f.start(); await f.complete();
    assert.equal(clipping.applies.at(-1).target.tileset, f.b);
  } finally { f.cleanup(); }
});

test('zero occluders, disabling and clearing target withdraw only the engineering contribution', async () => {
  const f = fixture(); try {
    await f.enable(); await f.complete(); const clipping = code.clippings[0];
    f.state.apply({ kind: 'all' }, { occlusionEnabled: false }); f.controller.updateFlags();
    assert.equal(clipping.status.state, 'disabled'); assert.equal(f.controller.status.busy, false);
    f.state.applyIds(['C0'], { occlusionEnabled: true }); f.controller.updateFlags(); await f.start(); await f.complete();
    f.controller.select('a', false); assert.equal(clipping.status.state, 'disabled');
    f.controller.select('', true); assert.equal(f.controller.status.targetId, ''); assert.equal(f.controller.status.busy, false);
  } finally { f.cleanup(); }
});

test('repeated host suspension is idempotent; resume calculates the latest state and disposal rejects late results', async () => {
  const f = fixture(); try {
    await f.enable(); f.controller.setSuspended(true); f.controller.setSuspended(true);
    f.state.applyIds(['C1'], { occlusionEnabled: true }); f.controller.updateFlags(); await f.complete();
    assert.equal(code.clippings.length, 0); f.controller.setSuspended(false); await f.start();
    assert.deepEqual(code.jobs.at(-1).ids, ['C0', 'C1']);
    f.controller.dispose(); await f.complete(); assert.equal(code.clippings.length, 0); assert.equal(code.clients[0].disposed, true);
    f.controller.retry(); await f.start(); assert.equal(code.jobs.length, 2);
  } finally { f.cleanup(); }
});

test('idle scene frames do not repeatedly clear rendering or publish identical interface status', async () => {
  const f = fixture(); try {
    const initial = f.statuses.length;
    for (let i = 0; i < 20; i++) f.controller.check();
    assert.equal(f.statuses.length, initial); assert.equal(code.jobs.length, 0);
    await f.enable(); await f.complete(); f.controller.select('a', false);
    const clipping = code.clippings[0], clears = clipping.clearCount, statuses = f.statuses.length;
    for (let i = 0; i < 20; i++) f.controller.check();
    assert.equal(clipping.clearCount, clears); assert.equal(f.statuses.length, statuses);
  } finally { f.cleanup(); }
});

test('photography association storage is isolated by project, actor and model instance', async () => {
  const storage = new Map<string, string>();
  const a = fixture(storage); try { a.controller.select('b', false); } finally { a.cleanup(); }
  for (const identity of [{ projectId: 'Q', actorId: 'A', instanceId: 'M' }, { projectId: 'P', actorId: 'B', instanceId: 'M' }, { projectId: 'P', actorId: 'A', instanceId: 'N' }]) {
    const f = fixture(storage, identity); try { assert.equal(f.controller.status.targetId, ''); assert.equal(f.controller.status.enabled, true); } finally { f.cleanup(); }
  }
  const restored = fixture(storage); try { assert.equal(restored.controller.status.targetId, 'b'); assert.equal(restored.controller.status.enabled, false); } finally { restored.cleanup(); }
});
