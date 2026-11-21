import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cesium3DTileset, Event, type ClippingPolygonCollection, type Viewer } from 'cesium';
import { TemporaryWorksClippingManager, type TemporaryWorksFootprint } from './temporaryWorksClipping.ts';

// Run the real shared manager, compiler and Cesium ownership setter. The only
// replacement is the precise collection's constructor/GPU preparation boundary.
const root = resolve(import.meta.dirname, '..'), output = join(root, 'output/engineering-photography-cpu');
mkdirSync(output, { recursive: true });
const compiled = join(mkdtempSync(join(output, 'precise-transactions-')), 'manager.mjs');
const boundary = `
import {ClippingPolygonCollection} from 'cesium';
export const control={failConstructor:false,failPrepare:false,failPrepareAt:0,constructors:0,prepares:0,created:[],destroyed:[]};
export function reset(){Object.assign(control,{failConstructor:false,failPrepare:false,failPrepareAt:0,constructors:0,prepares:0,created:[],destroyed:[]});}
export class PreciseClippingPolygonCollection extends ClippingPolygonCollection {
 constructor(polygons){control.constructors++;if(control.failConstructor)throw new Error('injected-precise-constructor');super({polygons,inverse:false,enabled:true});control.created.push(this);}
 prepare(context){control.prepares++;if(control.failPrepare||control.prepares===control.failPrepareAt)throw new Error('injected-precise-prepare');this.context=context;}
 destroy(){control.destroyed.push(this);return super.destroy();}
}
`;
const bundle = await build({ stdin: { contents: `export {TemporaryWorksClippingManager} from './src/temporaryWorksClipping.ts';export {control,reset} from 'precise-transaction-boundary';`, resolveDir: root },
  platform: 'node', target: 'node24', format: 'esm', bundle: true, write: false, packages: 'external', plugins: [{ name: 'precise-transaction-boundary', setup(builder) {
    builder.onResolve({ filter: /^precise-transaction-boundary$|^\.\/engineeringComponents\/preciseClipping$/ }, () => ({ path: 'boundary', namespace: 'boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: boundary, loader: 'js', resolveDir: root }));
  } }] });
writeFileSync(compiled, bundle.outputFiles[0].text); const code = await import(pathToFileURL(compiled).href);
const footprints = (x = 121): TemporaryWorksFootprint[] => [{ outer: [
  { longitude: x, latitude: 31 }, { longitude: x + .001, latitude: 31 },
  { longitude: x + .001, latitude: 31.001 }, { longitude: x, latitude: 31.001 },
] }];
function fixture(real = false) {
  code.reset(); const event = new Event(), scene = { context: real ? { webgl2: true } : { webgl2: true, _gl: {} }, postUpdate: event, requestRender() {} };
  const manager: TemporaryWorksClippingManager = new (real ? TemporaryWorksClippingManager : code.TemporaryWorksClippingManager)({ scene, isDestroyed: () => false } as unknown as Viewer);
  const a = new Cesium3DTileset({}), b = new Cesium3DTileset({});
  const engineering = manager.createScope('engineering', { precise: true }), other = manager.createScope('ordinary');
  const input = (id: string, x = 121, tileset = a) => ({ id, tileset, footprints: footprints(x) });
  const seed = () => { manager.upsert(input('legacy')); other.upsert(input('ordinary', 121.002)); engineering.upsert(input('engineering', 121.004)); };
  return { manager, a, b, engineering, other, event, input, seed, close() {
    code.control.failConstructor = code.control.failPrepare = false; code.control.failPrepareAt = 0;
    engineering.dispose(); other.dispose(); manager.dispose(); a.destroy(); b.destroy();
  } };
}

test('failed new or replacement legacy/scoped proposals retain exact live collections, prior records and no frame retries', () => {
  for (const failure of ['constructor', 'prepare']) for (const owner of ['legacy', 'ordinary', 'engineering']) for (const replace of [false, true]) {
    const f = fixture(); try {
      f.seed(); const api = owner === 'legacy' ? f.manager : owner === 'ordinary' ? f.other : f.engineering;
      const id = replace ? owner : 'new-record', before = f.a.clippingPolygons, status = api.getStatus(id), usage = f.engineering.getUsage();
      code.control[failure === 'constructor' ? 'failConstructor' : 'failPrepare'] = true;
      assert.throws(() => api.upsert(f.input(id, 121.006)), /injected-precise-/);
      assert.equal(f.a.clippingPolygons, before); assert.equal(before.isDestroyed(), false);
      assert.deepEqual(api.getStatus(id), status); assert.deepEqual(f.engineering.getUsage(), usage);
      assert.equal(f.manager.getStatus('legacy')?.state, 'active'); assert.equal(f.other.getStatus('ordinary')?.state, 'active');
      const attempts = code.control.constructors;
      for (let frame = 0; frame < 3; frame++) f.event.raiseEvent();
      assert.equal(code.control.constructors, attempts, 'rejected desired input cannot retry on every frame');
      if (failure === 'prepare') assert.equal(code.control.created.at(-1).isDestroyed(), true, 'failed prepared candidate is released');
    } finally { f.close(); }
  }
});

test('first precise failure removes its desired record and idle watcher while leaving unrelated legacy owners intact', () => {
  for (const legacy of [false, true]) {
    const f = fixture(); try {
      if (legacy) f.manager.upsert(f.input('legacy'));
      const before = f.a.clippingPolygons; code.control.failPrepare = true;
      assert.throws(() => f.engineering.upsert(f.input('engineering')), /injected-precise-prepare/);
      assert.equal(f.a.clippingPolygons, before); assert.equal(f.engineering.getStatus('engineering'), undefined);
      assert.equal(f.engineering.getUsage().contributors, 0); assert.equal(f.event.numberOfListeners, legacy ? 1 : 0);
      const attempts = code.control.constructors; f.event.raiseEvent(); assert.equal(code.control.constructors, attempts);
      if (legacy) assert.equal(f.manager.getStatus('legacy')?.state, 'active');
    } finally { f.close(); }
  }
});

test('hidden and disabled contributions stay withdrawn after failed per-plan or total reactivation', () => {
  for (const owner of ['legacy', 'ordinary', 'engineering']) for (const mode of ['visible', 'plan', 'total']) {
    const f = fixture(); try {
      f.seed(); const api = owner === 'legacy' ? f.manager : owner === 'ordinary' ? f.other : f.engineering;
      const toggle = (enabled: boolean) => mode === 'visible' ? api.setVisible(owner, enabled)
        : mode === 'plan' ? api.setPlanEnabled(owner, enabled) : api.setEnabled(enabled);
      toggle(false); const before = f.a.clippingPolygons, status = api.getStatus(owner);
      code.control.failPrepare = true; assert.throws(() => toggle(true), /injected-precise-prepare/);
      assert.equal(f.a.clippingPolygons, before); assert.equal(before.isDestroyed(), false); assert.deepEqual(api.getStatus(owner), status);
      const attempts = code.control.constructors; f.event.raiseEvent(); assert.equal(code.control.constructors, attempts);
      code.control.failPrepare = false; toggle(true); assert.equal(api.getStatus(owner)?.state, 'active');
    } finally { f.close(); }
  }
});

test('all changed precise targets prepare before any attachment is replaced, including target migration and global enable', () => {
  const f = fixture(); try {
    f.seed(); const before = f.a.clippingPolygons;
    code.control.failPrepare = true;
    assert.throws(() => f.engineering.upsert(f.input('engineering', 122, f.b)), /injected-precise-prepare/);
    assert.equal(f.a.clippingPolygons, before); assert.equal(before.isDestroyed(), false); assert.equal(f.b.clippingPolygons, undefined);
    assert.equal(f.engineering.getStatus('engineering')?.state, 'active');
    code.control.failPrepare = false;
    f.engineering.upsert(f.input('engineering-b', 122, f.b)); f.manager.upsert(f.input('legacy-b', 122.002, f.b));
    f.manager.setEnabled(false); const a = f.a.clippingPolygons, b = f.b.clippingPolygons as ClippingPolygonCollection;
    const created = code.control.created.length; code.control.failPrepareAt = code.control.prepares + 2;
    assert.throws(() => f.manager.setEnabled(true), /injected-precise-prepare/);
    assert.equal(f.a.clippingPolygons, a); assert.equal(f.b.clippingPolygons, b);
    assert.equal(a.isDestroyed(), false); assert.equal(b.isDestroyed(), false);
    assert.equal(code.control.created.length, created + 2);
    assert(code.control.created.slice(created).every((value: { isDestroyed(): boolean }) => value.isDestroyed()), 'both rejected candidates are destroyed');
    assert.equal(f.manager.getStatus('legacy')?.state, 'disabled'); assert.equal(f.manager.getStatus('legacy-b')?.state, 'disabled');
    const attempts = code.control.constructors; f.event.raiseEvent(); assert.equal(code.control.constructors, attempts);
  } finally { f.close(); }
});

test('actual combined precise vertex budget rejection rolls legacy additions back without shrinking or truncating either owner', () => {
  const f = fixture(true); try {
    f.engineering.upsert(f.input('engineering'));
    const before = f.a.clippingPolygons;
    // Each valid independent four-point ring is below the historical compiler
    // limit. Their combined precise GPU vertex count exceeds the 65,536 budget.
    const tooMany = Array.from({ length: 16_384 }, () => footprints(121.003)[0]);
    assert.throws(() => f.manager.upsert({ id: 'large-legacy', tileset: f.a, footprints: tooMany }), /65.?536.*预算/);
    assert.equal(f.manager.getStatus('large-legacy'), undefined); assert.equal(f.a.clippingPolygons, before);
    assert.equal(before.isDestroyed(), false); assert.equal(f.engineering.getStatus('engineering')?.state, 'active');
    f.event.raiseEvent(); assert.equal(f.a.clippingPolygons, before);
  } finally { f.close(); }
});

test('without a precise contribution the historical legacy and ordinary scope path never constructs or prepares precision resources', () => {
  const f = fixture(); try {
    code.control.failConstructor = code.control.failPrepare = true;
    f.manager.upsert(f.input('legacy')); f.other.upsert(f.input('ordinary', 121.002));
    f.manager.setVisible('legacy', false); f.manager.setVisible('legacy', true);
    f.other.setPlanEnabled('ordinary', false); f.other.setPlanEnabled('ordinary', true);
    f.manager.setEnabled(false); f.manager.setEnabled(true); f.event.raiseEvent();
    assert.equal(f.a.clippingPolygons.length, 2); assert.equal(code.control.constructors, 0); assert.equal(code.control.prepares, 0);
  } finally { f.close(); }
});
