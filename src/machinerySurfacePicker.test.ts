import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cartesian2, Cartesian3, type Viewer } from 'cesium';
import { pickMachinerySurface, pickPreferredMachineryPlacement, type MachinerySurface } from './machinerySurfacePicker';
const screen = new Cartesian2(20, 30);
function fixture() {
  const photo = { show: true, height: 120, hits: true, isDestroyed: () => false };
  const bim = { show: true, height: 170, hits: true, isDestroyed: () => false };
  const overlay = { show: true }, groundOverlay = { show: true };
  const hidden = { show: false }, entities = { show: true }, source = { show: true };
  const globe = { show: true };
  const collection = (items: unknown[]) => ({ show: true, length: items.length, get: (i: number) => items[i] });
  const nested = collection([photo, bim, hidden]);
  let renders = 0, refreshed = false, throwRender = false, projected = screen;
  const scene = {
    pickPositionSupported: true, pickTranslucentDepth: true, globe,
    primitives: collection([nested, overlay]), groundPrimitives: collection([groundOverlay]),
    pick: (_pixel: Cartesian2, width: number, height: number) => {
      assert.equal(width, 1); assert.equal(height, 1); assert.equal(refreshed, true);
      assert.equal(entities.show, false); assert.equal(source.show, false); assert.equal(overlay.show, false); assert.equal(globe.show, false);
      const hit = [bim, photo].find(item => item.show && item.hits);
      return hit ? { primitive: hit } : undefined;
    },
    pickPosition: () => {
      const hit = [bim, photo].find(item => item.show && item.hits);
      return hit ? Cartesian3.fromDegrees(121, 31, hit.height) : undefined;
    },
    cartesianToCanvasCoordinates: () => projected,
    requestRender: () => {},
  };
  const viewer = { scene, entities, dataSources: collection([source]), canvas: { clientWidth: 100, clientHeight: 100 },
    render: () => { renders++; refreshed = true; if (throwRender) throw new Error('WebGL lost'); } } as unknown as Viewer;
  const surfaces: MachinerySurface[] = [{ kind: 'photogrammetry', resource: photo, visible: true }, { kind: 'model', resource: bim, visible: true }];
  return { viewer, scene, surfaces, photo, bim, hidden, overlay, groundOverlay, nested, source, entities, globe,
    get renders() { return renders; }, failRender: () => { throwRender = true; }, wrongProjection: () => { projected = new Cartesian2(80, 80); } };
}
function restored(f: ReturnType<typeof fixture>) {
  for (const item of [f.photo, f.bim, f.overlay, f.groundOverlay, f.nested, f.source, f.entities, f.globe]) assert.equal(item.show, true);
  assert.equal(f.hidden.show, false); assert.equal(f.scene.pickTranslucentDepth, true);
}
test('photogrammetry is picked below a higher BIM overlay with a fresh isolated depth frame', () => {
  const f = fixture(), hit = pickMachinerySurface(f.viewer, screen, f.surfaces);
  assert.equal(hit?.source, 'model'); assert.equal(hit?.modelKind, 'photogrammetry');
  assert.ok(Math.abs(hit!.height - 120) < 1e-6); assert.equal(f.renders, 1); restored(f);
});
test('missing photogrammetry pixel falls back to the imported model, not overlay depth', () => {
  const f = fixture(); f.photo.hits = false;
  const hit = pickMachinerySurface(f.viewer, screen, f.surfaces);
  assert.equal(hit?.modelKind, 'model'); assert.ok(Math.abs(hit!.height - 170) < 1e-6); assert.equal(f.renders, 2); restored(f);
});
test('hidden photogrammetry is never temporarily made visible for picking', () => {
  const f = fixture(); f.photo.show = false;
  const hit = pickMachinerySurface(f.viewer, screen, f.surfaces);
  assert.equal(hit?.modelKind, 'model'); assert.equal(f.photo.show, false); assert.equal(f.bim.show, true);
});
test('unusable depth and rendering failures restore every display flag and permit labelled ground fallback', () => {
  for (const failure of ['render', 'projection'] as const) {
    const f = fixture(); if (failure === 'render') f.failRender(); else f.wrongProjection();
    assert.equal(pickMachinerySurface(f.viewer, screen, f.surfaces), undefined); restored(f);
  }
});
test('no hit, unsupported depth and off-canvas clicks cannot produce a false model height', () => {
  const f = fixture(); f.photo.hits = false; f.bim.hits = false;
  assert.equal(pickMachinerySurface(f.viewer, screen, f.surfaces), undefined); restored(f);
  f.scene.pickPositionSupported = false;
  const renders = f.renders;
  assert.equal(pickMachinerySurface(f.viewer, screen, f.surfaces), undefined);
  assert.equal(f.renders, renders);
  f.scene.pickPositionSupported = true;
  assert.equal(pickMachinerySurface(f.viewer, new Cartesian2(-1, 30), f.surfaces), undefined); assert.equal(f.renders, renders);
});


test('workbench and management machinery entries both use the same preferred surface before legacy pickers', () => {
  const preferred = { longitude: 121, latitude: 31, height: 58, source: 'model' as const, modelKind: 'photogrammetry' as const };
  for (const active of [false, true]) {
    const calls: string[] = [];
    assert.equal(pickPreferredMachineryPlacement(screen, { active,
      preferred: () => { calls.push('preferred'); return preferred; },
      workbench: () => { calls.push('workbench'); return undefined; },
      management: () => { calls.push('management'); return undefined; },
    }), preferred);
    assert.deepEqual(calls, ['preferred']);
  }
});
test('missed mechanical surface retains each entry point fallback and allows final ground fallback', () => {
  for (const active of [false, true]) {
    const calls: string[] = [];
    const result = pickPreferredMachineryPlacement(screen, { active,
      preferred: () => { calls.push('preferred'); return undefined; },
      workbench: () => { calls.push('workbench'); return undefined; },
      management: () => { calls.push('management'); return undefined; },
    });
    assert.equal(result, undefined); assert.deepEqual(calls, ['preferred', active ? 'management' : 'workbench']);
  }
});
