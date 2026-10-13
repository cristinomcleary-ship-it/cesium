import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { CustomDataSource, Viewer } from 'cesium';
import { RailSafetyScene, type RailSafetySceneContext } from './railSafetyScene.ts';
import { unprojectLocalToWgs84 } from './railSafetyGeometry.ts';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS } from './machineryValidation.ts';
import type { RailSafetyDefinition, RailSafetyPosition, RailSafetyRecord } from './railSafetyTypes.ts';

const originalFetch = globalThis.fetch;
const fileFetcher: typeof fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://fixture.local');
  const bytes = await readFile(new URL(`../public/${url.pathname.slice(1)}`, import.meta.url));
  return new Response(new Uint8Array(bytes));
};
test.before(() => { globalThis.fetch = fileFetcher; });
test.after(() => { globalThis.fetch = originalFetch; });

const origin = { longitude: 121, latitude: 31, height: 120 };
const distantOrigin = { longitude: 122, latitude: 31, height: 120 };
function square(at = origin, size = 20): RailSafetyPosition[] {
  return [[-size, -size], [size, -size], [size, size], [-size, size]].map(([x, y]) => unprojectLocalToWgs84({ x, y }, at));
}
function record(id: string, definition: RailSafetyDefinition): RailSafetyRecord {
  return { id, projectId: 'project', revision: 1, name: id, status: 'active', createdAt: '2026-10-13', updatedAt: '2026-10-13', createdBy: 'actor', definition };
}
function machinery(): MachineryMetadata {
  return { schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION, proportional: false,
    parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane }, placement: { ...origin, heading: 0 }, visible: true };
}
function context(records: RailSafetyRecord[]): RailSafetySceneContext {
  return { projectId: 'project', sessionKey: 'session', actorId: 'actor', active: true, canView: true, records,
    resources: [{ id: 'crane', name: '吊机', projectId: 'project', machinery: machinery() }] };
}
function fixture() {
  const canvas = Object.assign(new EventTarget(), { disableRootEvents: true, onwheel: null, style: { cursor: '' } });
  let source!: CustomDataSource;
  const viewer = { canvas, dataSources: {
    add(value: CustomDataSource) { source = value; return Promise.resolve(value); },
    remove(value: CustomDataSource) { value.entities.removeAll(); return true; },
  }, scene: { requestRender() {} }, isDestroyed: () => false, flyTo: async () => true } as unknown as Viewer;
  const scene = new RailSafetyScene(viewer);
  return { scene, source: () => source };
}
async function settled(scene: RailSafetyScene) {
  for (let i = 0; i < 1000; i++) {
    if (scene.getSnapshot().pending === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('scene calculation did not settle');
}

test('unconfigured machines stay unobtrusive until selected, then show an envelope without a false clear result', async () => {
  const f = fixture();
  try {
    f.scene.setContext(context([])); await settled(f.scene);
    assert.deepEqual(f.scene.getResults(), []);
    assert.deepEqual(f.scene.getSnapshot().entityIds, []);
    f.scene.setSelected('machine', 'crane'); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'unknown');
    assert.match(f.scene.getResults()[0].message, /尚未选用/);
    assert.ok(f.scene.getSnapshot().entityIds.includes('rail-safety:machine:crane:envelope'));
  } finally { f.scene.dispose(); }
});

test('an invalid distant responsibility area or limit cannot suppress a known nearby overlap', async () => {
  const f = fixture();
  try {
    const saved = context([
      record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near', 'far'] }),
      record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
      record('far', { schemaVersion: 1, kind: 'limit', polygon: square(distantOrigin) }),
      record('guard', { schemaVersion: 1, kind: 'guard', station: distantOrigin, polygon: square(distantOrigin), resourceIds: ['crane'] }),
    ]);
    f.scene.setContext(saved); await settled(f.scene);
    const result = f.scene.getResults()[0];
    assert.equal(result.status, 'overlap');
    assert.deepEqual(result.limits.map(l => l.status), ['overlap', 'unknown']);
    assert.equal(result.guards[0].known, false);
    assert.match(result.message, /不完整/);
    assert.ok(f.scene.getSnapshot().entityIds.some(id => id.includes('intersection:near')));
    const generation = f.scene.getSnapshot().generation;
    f.scene.setContext(structuredClone(saved));
    assert.equal(f.scene.getSnapshot().generation, generation, 'identical data never recomputes');
    f.scene.setLayers({ limits: false });
    assert.equal(f.scene.getResults()[0].status, 'overlap', 'hiding boundaries cannot suppress their calculation');
    assert.equal(f.scene.getSnapshot().generation, generation);
    assert.ok(!f.scene.getSnapshot().entityIds.some(id => id.startsWith('rail-safety:limit:')));
  } finally { f.scene.dispose(); }
});

test('deleted, missing and incomplete draft boundaries remain unknown; cancelling restores the saved result', async () => {
  const f = fixture();
  try {
    const limit = record('near', { schemaVersion: 1, kind: 'limit', polygon: square() });
    const saved = context([record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }), limit]);
    f.scene.setContext(saved); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'overlap');
    f.scene.setDraft({ id: 'near', name: '未完成区域', definition: { schemaVersion: 1, kind: 'limit', polygon: square().slice(0, 2) } });
    await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'unknown');
    assert.equal(f.scene.getResults()[0].draft, true);
    assert.ok(!f.scene.getSnapshot().entityIds.includes('rail-safety:limit:near:area'), 'invalid draft removes stale saved geometry');
    f.scene.setDraft(undefined); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'overlap');
    assert.equal(f.scene.getResults()[0].draft, false);
    f.scene.setContext({ ...saved, records: saved.records.map(r => r.id === 'near' ? { ...r, status: 'deleted' as const } : r) });
    await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'unknown');
    assert.equal(f.scene.getResults()[0].limits[0].status, 'unknown');
    f.scene.setContext({ ...saved, records: saved.records.filter(r => r.id !== 'near') }); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'unknown');
  } finally { f.scene.dispose(); }
});

test('whole-machine draft movement updates the assessment and cancellation restores the saved station even when the model is hidden', async () => {
  const f = fixture();
  try {
    const saved = context([
      record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
      record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
    ]);
    f.scene.setContext(saved); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'overlap');
    const state = machinery();
    state.placement = { ...unprojectLocalToWgs84({ x: 200, y: 0 }, origin), heading: 95 };
    state.visible = false;
    f.scene.setMachineryPreview('crane', state); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'clear');
    assert.equal(f.scene.getResults()[0].draft, true);
    assert.ok(f.scene.getResults()[0].nearestDistanceMeters! > 100);
    f.scene.setMachineryPreview('crane', undefined); await settled(f.scene);
    assert.equal(f.scene.getResults()[0].status, 'overlap');
    assert.equal(f.scene.getResults()[0].draft, false);
    assert.deepEqual(saved.resources[0].machinery, machinery(), 'drafts cannot mutate resource data');
  } finally { f.scene.dispose(); }
});

test('pending asset loads cannot publish geometry after permission is revoked or project changes', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (...args) => { await gate; return fileFetcher(...args); };
  try {
    f.scene.setContext(context([record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: [] })]));
    assert.ok(f.scene.getSnapshot().pending > 0);
    f.scene.setContext({ projectId: 'another-project', active: true, canView: false, sessionKey: 'another-session', records: [], resources: [] });
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(f.scene.getResults(), []);
    assert.deepEqual(f.scene.getSnapshot().entityIds, []);
    assert.equal(f.scene.getSnapshot().pending, 0);
  } finally { release(); globalThis.fetch = fileFetcher; f.scene.dispose(); }
});
