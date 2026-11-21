import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cesium3DTileset, ClippingPolygonCollection, Event, type Viewer } from 'cesium';
import type { TemporaryWorksClippingManager } from './temporaryWorksClipping';
const root = resolve(import.meta.dirname, '..'), output = join(root, 'output/projection-transaction-tests');
mkdirSync(output, { recursive: true });
const compiled = join(mkdtempSync(join(output, 'manager-')), 'manager.mjs');
const boundary = `import {ClippingPolygonCollection} from 'cesium';
export const control={fail:false,attempts:0,destroyed:0};
export class PreciseClippingPolygonCollection extends ClippingPolygonCollection {
 constructor(polygons){super({polygons});control.attempts++;}
 prepare(){if(control.fail)throw Error('projection-gpu-allocation-failed');}
 destroy(){control.destroyed++;return super.destroy();}
}`;
const bundled = await build({ stdin: { contents: `export {TemporaryWorksClippingManager} from './src/temporaryWorksClipping.ts';export {control} from 'projection-test-boundary';`, resolveDir: root },
  platform: 'node', target: 'node24', format: 'esm', bundle: true, write: false, packages: 'external', plugins: [{ name: 'projection-boundary', setup(b) {
    b.onResolve({ filter: /^projection-test-boundary$|^\.\/engineeringComponents\/preciseClipping$/ }, () => ({ path: 'boundary', namespace: 'projection' }));
    b.onLoad({ filter: /.*/, namespace: 'projection' }, () => ({ contents: boundary, loader: 'js', resolveDir: root }));
  } }] });
writeFileSync(compiled, bundled.outputFiles[0].text); const code = await import(pathToFileURL(compiled).href);
const footprints = () => [{ outer: [{ longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 }, { longitude: 121, latitude: 31.001 }] }];
function fixture() {
  Object.assign(code.control, { fail: false, attempts: 0, destroyed: 0 }); const event = new Event();
  const viewer = { scene: { context: { webgl2: true, _gl: {} }, postUpdate: event, requestRender() {} }, isDestroyed: () => false } as unknown as Viewer;
  const manager: TemporaryWorksClippingManager = new code.TemporaryWorksClippingManager(viewer), a = new Cesium3DTileset({}), b = new Cesium3DTileset({});
  const first = manager.createModelProjectionScope('first'), second = manager.createModelProjectionScope('second');
  const put = (scope = first, tileset = a, id = 'model') => scope.upsert({ id, tileset, footprints: footprints() });
  const legacy = () => manager.upsert({ id: 'legacy', tileset: a, footprints: footprints() });
  return { manager, a, b, first, second, event, put, legacy, close() { code.control.fail = false; first.dispose(); second.dispose(); manager.clear(); manager.dispose(); a.destroy(); b.destroy(); } };
}
test('model projections share the previous precise collection with legacy contributors and allow independent photographs', () => {
  const f = fixture(); try {
    f.legacy(); f.put(); f.put(f.first, f.b, 'photo-two'); f.put(f.second);
    assert.equal(f.a.clippingPolygons.length, 3); assert.equal(f.b.clippingPolygons.length, 1);
    assert.equal(f.first.getStatus('photo-two')?.state, 'active'); assert.equal(f.second.getStatus('model')?.state, 'active');
    f.first.dispose(); assert.equal(f.a.clippingPolygons.length, 2); assert.equal(f.b.clippingPolygons, undefined);
    f.second.dispose(); assert.equal(f.a.clippingPolygons.length, 1); assert.equal(f.manager.getStatus('legacy')?.state, 'active');
  } finally { f.close(); }
});
test('failed projection attachment and target migration retain previous collections and do not retry per frame', () => {
  const f = fixture(); try {
    f.legacy(); const legacy = f.a.clippingPolygons; code.control.fail = true;
    assert.throws(() => f.put(), /projection-gpu/); assert.equal(f.a.clippingPolygons, legacy); assert.equal(f.first.getStatus('model'), undefined);
    code.control.fail = false; f.put(); const before = f.a.clippingPolygons; code.control.fail = true;
    assert.throws(() => f.put(f.first, f.b), /projection-gpu/); assert.equal(f.a.clippingPolygons, before); assert.equal(f.b.clippingPolygons, undefined);
    const attempts = code.control.attempts; f.event.raiseEvent(); f.event.raiseEvent(); assert.equal(code.control.attempts, attempts);
  } finally { f.close(); }
});
test('revoked projection owner cannot revive after remaining GPU allocation fails; legacy remains desired until explicit recovery', () => {
  const f = fixture(); try {
    f.legacy(); f.put(); f.put(f.second); const before = f.a.clippingPolygons; code.control.fail = true;
    f.first.dispose(); assert.equal(f.first.getStatus('model'), undefined); assert.equal(f.a.clippingPolygons, undefined); assert.equal(before.isDestroyed(), true);
    assert.equal(f.second.getStatus('model')?.state, 'blocked'); assert.equal(f.manager.getStatus('legacy')?.state, 'blocked');
    const attempts = code.control.attempts; for (let i = 0; i < 20; i++) f.event.raiseEvent(); assert.equal(code.control.attempts, attempts);
    code.control.fail = false; f.event.raiseEvent(); assert.equal(f.a.clippingPolygons, undefined);
    f.put(f.second); assert.equal((f.a.clippingPolygons as ClippingPolygonCollection).length, 2); assert.equal(f.manager.getStatus('legacy')?.state, 'active');
    assert.throws(() => f.put(), /已释放/);
  } finally { f.close(); }
});
test('projection footprint validation keeps thin source features, owns immutable snapshots and rejects oversized replacements', () => {
  const f = fixture(); try {
    const source = [{ outer: [{ longitude: 121, latitude: 31 }, { longitude: 121 + 1e-9, latitude: 31 }, { longitude: 121, latitude: 31 + 1e-8 }] }];
    f.first.upsert({ id: 'model', tileset: f.a, footprints: source }); const before = f.a.clippingPolygons;
    source[0].outer[0].longitude = 0;
    const stored = (f.manager as any).scopes.get('first').entries.get('model').footprints;
    assert.equal(stored[0].outer[0].longitude, 121); assert.equal(Object.isFrozen(stored[0].outer[0]), true);
    const huge = [{ outer: Array.from({ length: 65_537 }, (_, i) => ({ longitude: 121 + i * 1e-9, latitude: 31 })) }];
    assert.throws(() => f.first.upsert({ id: 'model', tileset: f.a, footprints: huge }), /超过上限/);
    assert.equal(f.a.clippingPolygons, before); assert.equal(f.first.getStatus('model')?.state, 'active');
  } finally { f.close(); }
});
test('multi-target projection budget accepts 32 targets and rejects the next without changing any prior owner', () => {
  const f = fixture(); const targets = Array.from({ length: 33 }, () => new Cesium3DTileset({}));
  try {
    for (let i = 0; i < 32; i++) f.put(f.first, targets[i], `target-${i}`);
    assert.throws(() => f.put(f.first, targets[32], 'target-32'), /32 份预算/);
    assert.equal(targets[32].clippingPolygons, undefined); assert.equal(f.first.getStatus('target-31')?.state, 'active');
    f.put(f.first, targets[0], 'target-0'); assert.equal(f.first.getStatus('target-0')?.state, 'active');
  } finally { f.close(); for (const target of targets) target.destroy(); }
});
test('projection and legacy leases restore independently and foreign clipping ownership is never overwritten', () => {
  const f = fixture(); try {
    f.put(); f.legacy(); const target = f.manager.suspendTarget(f.a, {}), all = f.manager.suspend({});
    assert.equal(f.a.clippingPolygons, undefined); target(); assert.equal(f.a.clippingPolygons, undefined); all(); assert.equal((f.a.clippingPolygons as ClippingPolygonCollection).length, 2);
    const foreign = new ClippingPolygonCollection({ polygons: [] }); f.a.clippingPolygons = foreign;
    f.event.raiseEvent(); assert.equal(f.first.getStatus('model')?.state, 'blocked'); f.first.dispose(); assert.equal(f.a.clippingPolygons, foreign);
    assert.equal(foreign.isDestroyed(), false);
  } finally { f.close(); }
});
