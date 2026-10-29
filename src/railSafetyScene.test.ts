import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  Cartesian2, Cartesian3, Cartographic, ClassificationType, Color, HeightReference, JulianDate,
  Matrix3, Matrix4, ScreenSpaceEventType, Transforms,
  type CustomDataSource, type Entity, type ScreenSpaceEventHandler, type Viewer,
} from 'cesium';
import { RailSafetyScene, simplifyRailSafetyDisplayRing, type RailSafetySceneContext, type RailSafetySceneOptions } from './railSafetyScene.ts';
import { DEFAULT_RAIL_SAFETY_DISPLAY } from './railSafetyDisplay.ts';
import { projectWgs84ToLocal, unprojectLocalToWgs84 } from './railSafetyGeometry.ts';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS } from './machineryValidation.ts';
import type { RailSafetyDefinition, RailSafetyPosition, RailSafetyPositioningResult, RailSafetyRecord } from './railSafetyTypes.ts';

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
function fixture(options: RailSafetySceneOptions = {}) {
  const canvas = Object.assign(new EventTarget(), { disableRootEvents: true, onwheel: null, style: { cursor: '' } });
  let source!: CustomDataSource;
  const sources = new Map<string, CustomDataSource>();
  let picked: Entity | undefined;
  const viewer = { canvas, dataSources: {
    add(value: CustomDataSource) { if (value.name === '铁路旁施工管控') source = value; sources.set(value.name, value); return Promise.resolve(value); },
    remove(value: CustomDataSource) { value.entities.removeAll(); sources.delete(value.name); return true; },
  }, scene: { requestRender() {}, pick: () => ({ id: picked }) }, isDestroyed: () => false, flyTo: async () => true } as unknown as Viewer;
  const scene = new RailSafetyScene(viewer, options);
  return { scene, source: () => source, sources, clickEntity(id: string) {
    picked = source.entities.getById(id);
    const handler = (scene as unknown as { selectionHandler: ScreenSpaceEventHandler }).selectionHandler;
    const action = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as (event: { position: Cartesian2 }) => void;
    action({ position: new Cartesian2() });
  } };
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

test('independent surface and style changes preserve assessment geometry, results and the source records', async () => {
  let publications = 0;
  const f = fixture({ onResults: () => publications++ });
  const time = JulianDate.now();
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
    record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
    record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: ['crane'] }),
  ]);
  const original = structuredClone(saved);
  const entity = (id: string) => f.source().entities.getById(id)!;
  const guardId = 'rail-safety:guard:guard:area', envelopeId = 'rail-safety:machine:crane:envelope';
  try {
    f.scene.setContext(saved); await settled(f.scene);
    const before = f.scene.getSnapshot(), count = publications;
    const originalGuardEntity = entity(guardId), originalEnvelopeEntity = entity(envelopeId);
    const changedIds = new Set<string>();
    f.source().entities.collectionChanged.addEventListener((_collection, _added, _removed, changed) => changed.forEach(value => changedIds.add(value.id)));
    const polygonBefore = entity(envelopeId).polygon!.hierarchy!.getValue(time).positions.map((p: Cartesian3) => Cartographic.fromCartesian(p));
    assert.equal(entity(guardId).polygon!.perPositionHeight!.getValue(time), false);
    assert.equal(entity(guardId).polygon!.classificationType!.getValue(time), ClassificationType.BOTH);
    assert.equal(entity(guardId).polyline!.clampToGround!.getValue(time), true);

    const settings = structuredClone(DEFAULT_RAIL_SAFETY_DISPLAY);
    settings.guards = { surface: 'absolute', style: 'outline', opacity: 0.4, lineWidth: 6 };
    settings.envelopes = { ...settings.envelopes, surface: 'terrain', style: 'outline', opacity: 0, lineWidth: 4 };
    f.scene.setDisplay(settings);
    const after = f.scene.getSnapshot();
    assert.equal(entity(guardId), originalGuardEntity, 'Cesium visualizers must retain the same live entity');
    assert.equal(entity(envelopeId), originalEnvelopeEntity);
    assert.ok(changedIds.has(guardId) && changedIds.has(envelopeId), 'live visualizers receive changed notifications');
    assert.equal(after.generation, before.generation);
    assert.equal(after.signature, before.signature);
    assert.equal(after.pending, 0);
    assert.deepEqual(after.results, before.results);
    assert.equal(publications, count, 'display changes cannot publish a new assessment');
    assert.deepEqual(saved, original, 'saved coordinates and machinery data must remain untouched');
    assert.equal(entity(guardId).polygon!.perPositionHeight!.getValue(time), true);
    assert.equal(entity(guardId).polygon!.fill!.getValue(time), false);
    assert.equal(entity(guardId).polyline!.clampToGround!.getValue(time), false);
    assert.equal(entity(guardId).polyline!.width!.getValue(time), 6);
    assert.equal(entity(guardId).polyline!.material!.getType(time), 'PolylineOutline');
    const guardPoint = entity(guardId).polygon!.hierarchy!.getValue(time).positions[0];
    assert.ok(Math.abs(Cartographic.fromCartesian(guardPoint).height - (saved.records[2].definition as { polygon: RailSafetyPosition[] }).polygon[0].height - 0.06) < 1e-6);

    for (const id of [envelopeId, 'rail-safety:machine:crane:support']) {
      assert.equal(entity(id).polygon!.perPositionHeight!.getValue(time), false);
      assert.equal(entity(id).polygon!.classificationType!.getValue(time), ClassificationType.TERRAIN);
      assert.equal(entity(id).polyline!.classificationType!.getValue(time), ClassificationType.TERRAIN);
      assert.equal(entity(id).polyline!.clampToGround!.getValue(time), true);
    }
    assert.equal(entity('rail-safety:machine:crane:radius').polyline!.classificationType!.getValue(time), ClassificationType.TERRAIN);
    assert.equal(entity('rail-safety:machine:crane:farthest').point!.heightReference!.getValue(time), HeightReference.CLAMP_TO_TERRAIN);
    assert.equal(entity('rail-safety:machine:crane:farthest').label!.disableDepthTestDistance!.getValue(time), Number.POSITIVE_INFINITY);
    const polygonAfter = entity(envelopeId).polygon!.hierarchy!.getValue(time).positions.map((p: Cartesian3) => Cartographic.fromCartesian(p));
    assert.deepEqual(polygonAfter, polygonBefore, 'the envelope coordinates do not get recalculated or replaced');
    const intersection = entity(after.entityIds.find(id => id.includes(':intersection:'))!);
    assert.equal(intersection.polygon!.fill!.getValue(time), true, 'known risk remains visible in outline-only mode');
    const riskColor = intersection.polygon!.material!.getValue(time).color as Color;
    assert.ok(riskColor.red > 0.9 && riskColor.alpha >= 0.48);
    assert.ok(intersection.polygon!.zIndex!.getValue(time) > entity(guardId).polygon!.zIndex!.getValue(time));
    assert.equal(entity('rail-safety:limit:near:area').polygon!.perPositionHeight!.getValue(time), true, 'saved limit presentation remains unchanged');

    settings.guards.style = 'fill'; settings.guards.opacity = 0;
    f.scene.setDisplay(settings); f.scene.setSelected('guard', 'guard');
    assert.equal(entity(guardId).polygon!.material!.getValue(time).color.alpha, 0, 'selection cannot override a chosen zero opacity');
    settings.guards.opacity = 1; f.scene.setDisplay(settings);
    assert.equal(entity(guardId).polygon!.material!.getValue(time).color.alpha, 1);
    settings.envelopes.lineWidth = 1; f.scene.setDisplay(settings);
    assert.equal(entity(envelopeId).polyline!.material!.getType(time), 'Color', 'draped borders use a stable solid category color');
    assert.ok(entity(envelopeId).polyline!.material!.getValue(time).color.red > 0.9, 'a one-pixel line retains its category color');
    const snapshot = f.scene.getSnapshot(); snapshot.display.guards.opacity = 0.7;
    assert.equal(f.scene.getSnapshot().display.guards.opacity, 1, 'snapshot preferences are an independent copy');
  } finally { f.scene.dispose(); }
});

test('six range colours update live fills, outlines and wall labels without changing geometry, monitoring or screening', async () => {
  let publications = 0;
  const f = fixture({ onResults: () => publications++ }), time = JulianDate.now();
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
    record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
    record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: ['crane'],
      workArea: { polygon: square(origin, 5), deviceId: 'guard-device', staleAfterSeconds: 30 } }),
  ]), original = structuredClone(saved);
  const get = (id: string) => f.source().entities.getById(`rail-safety:${id}`)!;
  const hex = (color: Color) => color.withAlpha(1).toCssHexString();
  const geometry = () => f.source().entities.values.filter(entity => entity.polygon).map(entity => [entity.id,
    entity.polygon!.hierarchy!.getValue(time).positions.map((p: Cartesian3) => [p.x, p.y, p.z])]);
  try {
    f.scene.setContext(saved); await settled(f.scene);
    f.scene.setGuardPositionStates([{ guardId: 'guard', result: { state: 'outside', reason: '越界', isAlarm: true, source: 'measured', sample: {
      projectId: 'project', deviceId: 'guard-device', coordinateSystem: 'WGS84', position: unprojectLocalToWgs84({ x: 50, y: 0 }, origin),
      timestamp: '2026-10-14T00:00:00Z', accuracyMeters: 0.5, source: 'measured',
    } } }]);
    const settings = structuredClone(DEFAULT_RAIL_SAFETY_DISPLAY); settings.limits.representation = 'both';
    f.scene.setDisplay(settings);
    const before = f.scene.getSnapshot(), geometryBefore = geometry(), count = publications;
    const stationBefore = get('guard:guard:station').model!.silhouetteColor!.getValue(time);
    settings.colors = { responsibility: '#112233', workArea: '#abcdef', limit: '#345678', envelope: '#135724', risk: '#998877', support: '#765432' };
    f.scene.setDisplay(settings);
    const riskId = before.entityIds.find(id => id.includes(':intersection:'))!.slice('rail-safety:'.length);
    for (const [id, key] of [
      ['guard:guard:area', 'responsibility'], ['guard:guard:work-area', 'workArea'], ['limit:near:area', 'limit'],
      ['machine:crane:envelope', 'envelope'], [riskId, 'risk'], ['machine:crane:support', 'support'],
    ] as const) {
      assert.equal(hex(get(id).polygon!.material!.getValue(time).color), settings.colors[key], `${key} fill`);
      assert.equal(hex(get(id).polyline!.material!.getValue(time).color), settings.colors[key], `${key} outline`);
    }
    assert.equal(hex(get('limit:near:wall').wall!.material!.getValue(time).color), settings.colors.limit);
    assert.equal(hex(get('limit:near:wall').polyline!.material!.getValue(time).color), settings.colors.limit);
    assert.equal(hex(get('limit:near:name').label!.fillColor!.getValue(time)), settings.colors.limit);
    assert.equal(hex(get('machine:crane:farthest').point!.color!.getValue(time)), settings.colors.envelope);
    assert.equal(hex(get('machine:crane:radius').polyline!.material!.getValue(time).color), settings.colors.envelope);
    assert.equal(hex(get('guard:guard:position').point!.color!.getValue(time)), '#ff3c50', 'alarm position preserves its semantic red');
    assert.equal(hex(get('guard:guard:work-area:label').label!.fillColor!.getValue(time)), '#ff3c50', 'alarm text remains distinguishable from chosen area colour');
    assert.deepEqual(get('guard:guard:station').model!.silhouetteColor!.getValue(time), stationBefore, 'personnel model colour is independent');
    assert.deepEqual(geometry(), geometryBefore);
    const after = f.scene.getSnapshot();
    assert.equal(after.generation, before.generation); assert.equal(after.signature, before.signature); assert.equal(after.pending, 0);
    assert.deepEqual(after.results, before.results); assert.deepEqual(after.guardPositions, before.guardPositions);
    assert.equal(publications, count); assert.deepEqual(saved, original);
  } finally { f.scene.dispose(); }
});

test('personnel models preserve the recorded foot height, orient by compass heading and remain selectable in either representation', () => {
  const selections: unknown[] = [];
  const f = fixture({ onSelect: (...args) => selections.push(args) });
  const time = JulianDate.now(), id = 'rail-safety:guard:guard:station';
  const saved = context([record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: [] })]);
  const facing = (entity: Entity) => Matrix3.multiplyByVector(Matrix3.fromQuaternion(entity.orientation!.getValue(time)), Cartesian3.UNIT_X, new Cartesian3());
  try {
    f.scene.setContext({ ...saved, resources: [] });
    let station = f.source().entities.getById(id)!;
    const liveStation = station;
    assert.equal(station.model!.uri!.getValue(time), '/models/rail-safety/guard.gltf');
    assert.equal(station.model!.heightReference!.getValue(time), HeightReference.NONE);
    assert.ok(Math.abs(Cartographic.fromCartesian(station.position!.getValue(time)!).height - origin.height - 0.03) < 1e-6);
    const frame = Transforms.eastNorthUpToFixedFrame(station.position!.getValue(time)!);
    const north = Matrix4.multiplyByPointAsVector(frame, Cartesian3.UNIT_Y, new Cartesian3());
    assert.ok(Cartesian3.dot(facing(station), north) > 0.999999, 'heading zero faces geographic north');
    const settings = structuredClone(DEFAULT_RAIL_SAFETY_DISPLAY);
    settings.personnel.scale = 2; settings.personnel.heading = 90;
    f.scene.setDisplay(settings);
    station = f.source().entities.getById(id)!;
    assert.equal(station, liveStation);
    assert.equal(station.model!.scale!.getValue(time), 2);
    assert.equal(station.model!.minimumPixelSize!.getValue(time), 40);
    assert.equal(station.model!.maximumScale!.getValue(time), 16);
    const east = Matrix4.multiplyByPointAsVector(frame, Cartesian3.UNIT_X, new Cartesian3());
    assert.ok(Cartesian3.dot(facing(station), east) > 0.999999, 'heading 90 faces geographic east');
    const label = f.source().entities.getById(`${id}:label`)!;
    assert.equal(label.label!.disableDepthTestDistance!.getValue(time), Number.POSITIVE_INFINITY);
    assert.equal(label.label!.pixelOffset!.getValue(time).y, -40);
    f.clickEntity(id);
    assert.deepEqual(selections, [['guard', 'guard']]);

    settings.personnel.representation = 'point'; f.scene.setDisplay(settings);
    station = f.source().entities.getById(id)!;
    assert.equal(station, liveStation, 'model-to-point updates the same visualized entity');
    assert.equal(station.model, undefined);
    assert.ok(station.point && station.label);
    assert.equal(f.source().entities.getById(`${id}:label`), undefined);
    f.clickEntity(id);
    assert.deepEqual(selections, [['guard', 'guard'], ['guard', 'guard']]);
    f.scene.setLayers({ guards: false });
    assert.ok(!f.scene.getSnapshot().entityIds.some(id => id.startsWith('rail-safety:guard:')));
  } finally { f.scene.dispose(); }
});

test('slow font loading never delays personnel models or their readable fallback labels', () => {
  const f = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    fonts: { load: () => new Promise(() => {}) }, querySelector: () => ({ sheet: {} }),
  } });
  try {
    f.scene.setContext({ ...context([record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: [] })]), resources: [] });
    const station = f.source().entities.getById('rail-safety:guard:guard:station');
    const label = f.source().entities.getById('rail-safety:guard:guard:station:label');
    assert.ok(station?.model, 'the person exists before fonts resolve');
    assert.equal(label?.label?.text?.getValue(JulianDate.now()), 'guard');
    assert.doesNotMatch(label!.label!.font!.getValue(JulianDate.now()), /Noto Sans SC/, 'fallback glyphs use a different Cesium cache key');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    f.scene.dispose();
  }
});

test('dense convex display rings reduce shadow volumes within five centimetres without changing source geometry', () => {
  const ellipse = (x: number, y: number) => Array.from({ length: 360 }, (_, i) =>
    unprojectLocalToWgs84({ x: x * Math.cos(i * Math.PI / 180), y: y * Math.sin(i * Math.PI / 180) }, origin));
  const ring = ellipse(12, 10), original = structuredClone(ring);
  const reduced = simplifyRailSafetyDisplayRing(ring);
  assert.ok(reduced.length >= 3 && reduced.length < ring.length / 2);
  assert.deepEqual(ring, original, 'render optimization cannot edit the assessed ring');
  assert.ok(reduced.every(p => ring.includes(p)), 'retained vertices are original locations');
  const points = ring.map(p => projectWgs84ToLocal(p, ring[0]));
  const simplified = reduced.map(p => projectWgs84ToLocal(p, ring[0]));
  let maximumDeviation = 0;
  for (const p of points) {
    let nearest = Infinity;
    simplified.forEach((a, i) => {
      const b = simplified[(i + 1) % simplified.length], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      nearest = Math.min(nearest, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    });
    maximumDeviation = Math.max(maximumDeviation, nearest);
  }
  assert.ok(maximumDeviation <= 0.05 + 1e-8, `rendered boundary deviation ${maximumDeviation} m`);
  const narrow = ellipse(50, 0.005), small = ellipse(0.05, 0.04);
  assert.equal(simplifyRailSafetyDisplayRing(narrow), narrow, 'a narrow overlap must not collapse into a line');
  assert.equal(simplifyRailSafetyDisplayRing(small), small, 'tiny overlaps retain their full shape');
  const concave = ring.map((p, i) => i === 90 ? origin : p);
  assert.equal(simplifyRailSafetyDisplayRing(concave), concave, 'concave rings retain source topology');
});

test('fall demonstration transforms only its copy and cleans up on preview, selection and context changes', async () => {
  const f = fixture();
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
    record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
  ]), original = structuredClone(saved);
  try {
    f.scene.setContext(saved); await settled(f.scene);
    const baseline = f.scene.getSnapshot();
    assert.equal(await f.scene.startFallDemo('crane'), true);
    const demoSource = f.sources.get('机械倾覆运动演示（只读副本）')!;
    assert.equal(demoSource.entities.values.filter(e => e.model).length, 1);
    f.scene.setFallDemo({ angle: 45, direction: 180 });
    const display = structuredClone(DEFAULT_RAIL_SAFETY_DISPLAY); display.guards.opacity = 0.4;
    f.scene.setDisplay(display);
    assert.equal(f.scene.getSnapshot().fallDemo.angle, 45, 'ordinary scene rendering leaves the demo pose intact');
    assert.deepEqual(f.scene.getResults(), baseline.results);
    assert.equal(f.scene.getSnapshot().generation, baseline.generation);
    assert.equal(f.scene.getSnapshot().signature, baseline.signature);
    assert.deepEqual(saved, original);
    const preview = machinery(); preview.placement.heading = 30;
    f.scene.setMachineryPreview('crane', preview);
    assert.equal(f.scene.getSnapshot().fallDemo.active, false);
    assert.equal(f.sources.has(demoSource.name), false);
    await f.scene.startFallDemo('crane');
    f.scene.setSelected('limit', 'near'); assert.equal(f.scene.getSnapshot().fallDemo.active, false);
    await f.scene.startFallDemo('crane');
    f.scene.setContext({ ...saved, active: false }); assert.equal(f.scene.getSnapshot().fallDemo.active, false);
    assert.equal(f.sources.has(demoSource.name), false);
    f.scene.setContext(saved); await f.scene.startFallDemo('crane');
    f.scene.setContext({ ...saved, actorId: 'another-actor' }); assert.equal(f.scene.getSnapshot().fallDemo.active, false);
    await f.scene.startFallDemo('crane'); f.scene.dispose(); assert.equal(f.sources.size, 0);
  } finally { f.scene.dispose(); }
});

test('pending fall demonstration cannot revive after permission or project changes', async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (...args) => { await gate; return fileFetcher(...args); };
  try {
    f.scene.setContext(context([]));
    const pending = f.scene.startFallDemo('crane');
    assert.equal(f.scene.getSnapshot().fallDemo.loading, true);
    f.scene.setContext({ projectId: 'other', active: true, canView: false, records: [], resources: [] });
    release(); assert.equal(await pending, false);
    assert.equal(f.scene.getSnapshot().fallDemo.active, false);
    assert.equal(f.sources.has('机械倾覆运动演示（只读副本）'), false);
  } finally { release(); globalThis.fetch = fileFetcher; f.scene.dispose(); }
});

test('imported fall projects replay only a frozen copy and remain invalidated by current live pose changes', async () => {
  const f = fixture(), saved = context([]), snapshotState = machinery();
  snapshotState.placement.heading = 210;
  try {
    f.scene.setContext(saved);
    assert.equal(await f.scene.replayFallDemo({ resourceId: 'crane', resourceName: '工程快照', state: snapshotState }), true);
    assert.equal(f.scene.getFallDemoInput()!.state.placement.heading, 210);
    assert.equal(saved.resources[0].machinery && (saved.resources[0].machinery as MachineryMetadata).placement.heading, 0);
    f.scene.setContext(structuredClone(saved));
    assert.equal(f.scene.getSnapshot().fallDemo.active, true, 'an unchanged context does not replace the imported snapshot');
    const live = machinery(); live.placement.heading = 20;
    f.scene.setLiveStates(new Map([['crane', live]]));
    assert.equal(f.scene.getSnapshot().fallDemo.active, false, 'new live geometry stops old snapshot playback');
    assert.equal(f.scene.getFallDemoInput(), undefined);
    await assert.rejects(() => f.scene.replayFallDemo({ resourceId: 'unavailable', resourceName: 'Missing', state: snapshotState }), /不可用/);
  } finally { f.scene.dispose(); }
});

test('live poses update only affected machine envelopes and invalidate fall animation while keeping initialization intact', async () => {
  const f = fixture();
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
    record('config-2', { schemaVersion: 1, kind: 'machine', resourceId: 'crane-2', selectedLimitIds: ['near'] }),
    record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
  ]);
  saved.resources = [...saved.resources, { id: 'crane-2', name: '吊机 2', projectId: 'project', machinery: machinery() }];
  const original = structuredClone(saved);
  try {
    f.scene.setContext(saved); await settled(f.scene);
    const internals = f.scene as unknown as { envelopes: Map<string, unknown> };
    const secondEnvelope = internals.envelopes.get('crane-2');
    assert.equal(await f.scene.startFallDemo('crane'), true);
    const live = machinery(); live.placement.longitude = origin.longitude + 0.001;
    const other = machinery(); other.placement.heading = 90;
    f.scene.setLiveStates(new Map([['crane', live], ['foreign-resource', other]]));
    assert.equal(f.scene.getSnapshot().fallDemo.active, false, 'old animation stops before displaying a new pose');
    await settled(f.scene);
    assert.equal(internals.envelopes.get('crane-2'), secondEnvelope, 'unaffected envelope work is not reevaluated');
    assert.equal(f.scene.getResults().find(result => result.resourceId === 'crane')!.status, 'clear');
    assert.equal(f.scene.getResults().find(result => result.resourceId === 'crane')!.draft, true, 'live results cannot be reported against an older saved resource revision');
    assert.equal(f.scene.getResults().find(result => result.resourceId === 'crane-2')!.status, 'overlap');
    const generation = f.scene.getSnapshot().generation;
    f.scene.setLiveStates(new Map([['crane', structuredClone(live)]]));
    assert.equal(f.scene.getSnapshot().generation, generation, 'equal frames do not recalculate');
    assert.deepEqual(saved, original);
    assert.equal(await f.scene.startFallDemo('crane'), true);
    f.scene.setMachineryPreview('crane', machinery()); await settled(f.scene);
    assert.equal(f.scene.getSnapshot().fallDemo.active, false);
    assert.equal(f.scene.getResults().find(result => result.resourceId === 'crane')!.status, 'overlap', 'manual preview takes precedence');
    f.scene.setMachineryPreview('crane'); await settled(f.scene);
    assert.equal(f.scene.getResults().find(result => result.resourceId === 'crane')!.status, 'clear', 'closing preview returns to latest telemetry');
    f.scene.setContext({ ...saved, canView: false });
    f.scene.setLiveStates(new Map([['crane', live]]));
    f.scene.setContext(saved); await settled(f.scene);
    assert.equal(f.scene.getResults().find(result => result.resourceId === 'crane')!.status, 'overlap', 'permission reset cannot retain stale live poses');
  } finally { f.scene.dispose(); }
});

test('enabling an identical live pose marks preserved results transient without recomputing geometry', async () => {
  const f = fixture();
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
    record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
  ]);
  try {
    f.scene.setContext(saved); await settled(f.scene);
    const internals = f.scene as unknown as { envelopes: Map<string, unknown> };
    const envelope = internals.envelopes.get('crane');
    assert.equal(f.scene.getResults()[0].draft, false);
    f.scene.setLiveStates(new Map([['crane', machinery()]]));
    assert.equal(f.scene.hasLiveState('crane'), true);
    assert.equal(f.scene.getResults()[0].draft, true, 'even the first same-valued live frame is not a persisted risk snapshot');
    assert.equal(f.scene.getSnapshot().pending, 0);
    assert.equal(internals.envelopes.get('crane'), envelope);
    f.scene.setLiveStates(new Map());
    assert.equal(f.scene.hasLiveState('crane'), false);
    assert.equal(f.scene.getResults()[0].draft, false, 'removing the identical override restores the saved-result classification');
    assert.equal(internals.envelopes.get('crane'), envelope);
  } finally { f.scene.dispose(); }
});

test('saved work-area monitoring stays independent of station, responsibility area and incomplete drafts', async () => {
  const f = fixture(), time = JulianDate.now();
  const guard = record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: [],
    workArea: { polygon: square(origin, 5), deviceId: 'guard-device', staleAfterSeconds: 30 } });
  const saved = { ...context([guard]), resources: [] }, original = structuredClone(saved);
  const result: RailSafetyPositioningResult = { state: 'outside', reason: '越界', isAlarm: true, source: 'measured', sample: {
    projectId: 'project', deviceId: 'guard-device', coordinateSystem: 'WGS84', position: unprojectLocalToWgs84({ x: 50, y: 0 }, origin),
    timestamp: '2026-10-14T00:00:00Z', accuracyMeters: 0.5, source: 'measured',
  } };
  const get = (suffix: string) => f.source().entities.getById(`rail-safety:guard:guard:${suffix}`)!;
  try {
    f.scene.setContext(saved); f.scene.setGuardPositionStates([{ guardId: 'guard', result }]);
    const station = Cartesian3.clone(get('station').position!.getValue(time)!);
    assert.ok(get('area').polygon && get('work-area').polygon && get('position').point);
    assert.equal(get('area').polygon!.material!.getValue(time).color.withAlpha(1).toCssHexString(), '#39bfff');
    assert.equal(get('work-area').polygon!.material!.getValue(time).color.withAlpha(1).toCssHexString(), DEFAULT_RAIL_SAFETY_DISPLAY.colors.workArea);
    assert.equal(get('work-area:label').label!.fillColor!.getValue(time).toCssHexString(), '#ff3c50');
    assert.ok(Cartesian3.distance(get('position').position!.getValue(time)!, station) > 40);
    let changes = 0; const remove = f.source().entities.collectionChanged.addEventListener(() => { changes++; });
    f.scene.setGuardPositionStates([{ guardId: 'guard', result: { ...result, reason: '更新的说明' } }]);
    assert.equal(changes, 0, 'per-second prose changes do not rebuild scene geometry'); remove();
    assert.equal(f.scene.getSnapshot().guardPositions[0].result.reason, '更新的说明');
    assert.ok(guard.definition.kind === 'guard');
    f.scene.setDraft({ id: 'guard', name: '人员草稿', definition: { ...guard.definition,
      workArea: { ...guard.definition.workArea!, polygon: square(origin, 10) } } });
    await settled(f.scene);
    assert.ok(get('work-area:saved').polygon && get('work-area').polygon && get('position').point);
    assert.match(get('work-area:label').label!.text!.getValue(time), /草稿/);
    f.scene.setDraft({ id: 'guard', name: '人员草稿', definition: { ...guard.definition,
      workArea: { ...guard.definition.workArea!, polygon: square(origin, 10).slice(0, 2) } } });
    await settled(f.scene);
    assert.ok(get('work-area:saved').polygon && get('position').point, 'invalid work-area draft retains saved monitoring');
    assert.equal(get('work-area:saved').polygon!.material!.getValue(time).color.withAlpha(1).toCssHexString(), DEFAULT_RAIL_SAFETY_DISPLAY.colors.workArea);
    assert.equal(get('work-area:saved:label').label!.fillColor!.getValue(time).toCssHexString(), '#ff3c50');
    assert.equal(get('area'), undefined, 'the invalid responsibility draft retains its existing validation behavior');
    f.scene.setDraft(undefined);
    assert.ok(Cartesian3.equals(get('station').position!.getValue(time)!, station));
    const simulated = { ...result, source: 'simulated' as const, sample: { ...result.sample!, source: 'simulated' as const } };
    f.scene.setGuardPositionStates([{ guardId: 'guard', result: simulated }]);
    assert.match(get('position').label!.text!.getValue(time), /模拟定位/);
    assert.match(get('work-area:label').label!.text!.getValue(time), /模拟/);
    f.scene.setGuardPositionStates([{ guardId: 'guard', result: { ...result, state: 'uncertain', isAlarm: false } }]);
    assert.equal(get('work-area').polygon!.material!.getValue(time).color.withAlpha(1).toCssHexString(), DEFAULT_RAIL_SAFETY_DISPLAY.colors.workArea);
    assert.equal(get('work-area:label').label!.fillColor!.getValue(time).toCssHexString(), '#ffae39');
    assert.equal(get('position').point!.color!.getValue(time).toCssHexString(), '#ffae39');
    f.scene.setGuardPositionStates([{ guardId: 'guard', result: { ...result, state: 'stale', isAlarm: false } }]);
    assert.equal(get('position').point!.color!.getValue(time).toCssHexString(), Color.LIGHTGRAY.toCssHexString());
    f.scene.setGuardPositionStates([{ guardId: 'guard', result: { ...result, sample: { ...result.sample!, deviceId: 'other-device' } } }]);
    assert.equal(get('position'), undefined, 'a different bound device cannot populate this guard');
    f.scene.setGuardPositionStates([{ guardId: 'guard', result }]);
    const changed = structuredClone(saved); if (changed.records[0].definition.kind === 'guard') changed.records[0].definition.workArea!.staleAfterSeconds = 60;
    f.scene.setContext(changed); assert.equal(get('position'), undefined);
    f.scene.setGuardPositionStates([{ guardId: 'guard', result }]); assert.ok(get('position'), 'forced saved-boundary reevaluation restores an unchanged result');
    f.scene.setContext({ ...changed, canView: false }); assert.deepEqual(f.scene.getSnapshot().guardPositions, []);
    assert.deepEqual(saved, original, 'tracked or simulated coordinates never write the fixed station or polygons');
  } finally { f.scene.dispose(); }
});

test('cross-task limit drafts become individually unknown without suppressing a known overlap', async () => {
  const f = fixture();
  const saved = context([
    { ...record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['global', 'task'] }), taskId: 'A' },
    record('global', { schemaVersion: 1, kind: 'limit', polygon: square() }),
    { ...record('task', { schemaVersion: 1, kind: 'limit', polygon: square() }), taskId: 'A' },
  ]);
  try {
    f.scene.setContext(saved); await settled(f.scene);
    assert.deepEqual(f.scene.getResults()[0].limits.map(value => value.status), ['overlap', 'overlap']);
    f.scene.setDraft({ id: 'task', name: '另任务限界草稿', taskId: 'B', definition: saved.records[2].definition }); await settled(f.scene);
    assert.deepEqual(f.scene.getResults()[0].limits.map(value => value.status), ['overlap', 'unknown']);
    assert.equal(f.scene.getResults()[0].status, 'overlap');
    assert.match(f.scene.getResults()[0].limits[1].message!, /不同任务/);
    assert.ok(!f.scene.getSnapshot().entityIds.some(id => id.includes('intersection:task:')));
    f.scene.setDraft({ id: 'config', name: '另任务机械草稿', taskId: 'B', definition: saved.records[0].definition }); await settled(f.scene);
    assert.deepEqual(f.scene.getResults()[0].limits.map(value => value.status), ['overlap', 'unknown']);
    f.scene.setDraft(undefined); await settled(f.scene);
    assert.deepEqual(f.scene.getResults()[0].limits.map(value => value.status), ['overlap', 'overlap']);
  } finally { f.scene.dispose(); }
});

test('limit walls preserve sloped recorded bases and independently switch plane, wall, height and transparency', async () => {
  const selections: unknown[] = [], f = fixture({ onSelect: (...args) => { selections.push(args); } });
  const polygon = square().map((position, index) => ({ ...position, height: 118 + index * 1.5 }));
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['limit'] }),
    record('limit', { schemaVersion: 1, kind: 'limit', polygon }),
  ]), original = structuredClone(saved), time = JulianDate.now();
  const entity = (suffix: string) => f.source().entities.getById(`rail-safety:limit:limit:${suffix}`);
  try {
    f.scene.setContext(saved); await settled(f.scene);
    const baseline = f.scene.getSnapshot();
    assert.ok(entity('area')?.polygon); assert.equal(entity('wall'), undefined, 'legacy plane display remains the default');
    const settings = structuredClone(DEFAULT_RAIL_SAFETY_DISPLAY);
    settings.limits = { representation: 'both', wallHeight: 8, wallOpacity: 0.35 };
    f.scene.setDisplay(settings);
    const wallEntity = entity('wall')!, wall = wallEntity.wall!;
    assert.ok(entity('area')?.polygon && wall);
    const bottom = wall.minimumHeights!.getValue(time) as number[], top = wall.maximumHeights!.getValue(time) as number[];
    assert.deepEqual(bottom, [...polygon.map(p => p.height), polygon[0].height]);
    assert.deepEqual(top.map((height, i) => height - bottom[i]), [8, 8, 8, 8, 8]);
    const positions = wall.positions!.getValue(time) as Cartesian3[];
    assert.ok(Cartesian3.equals(positions[0], positions.at(-1)!));
    assert.ok(Cartesian3.distance(positions[0], Cartesian3.fromDegrees(polygon[0].longitude, polygon[0].latitude, polygon[0].height)) < 1e-6);
    assert.equal(wall.material!.getValue(time).color.alpha, 0.35);
    f.clickEntity(wallEntity.id); assert.deepEqual(selections, [['limit', 'limit']]);
    settings.limits.representation = 'wall'; settings.limits.wallOpacity = 0; f.scene.setDisplay(settings);
    assert.equal(entity('area'), undefined); assert.equal(entity('wall'), wallEntity, 'live wall entity keeps its identity');
    assert.equal(wallEntity.wall!.material!.getValue(time).color.alpha, 0, 'selection cannot override opacity zero');
    settings.limits.wallOpacity = 1; settings.limits.wallHeight = 100; f.scene.setDisplay(settings);
    assert.equal(wallEntity.wall!.material!.getValue(time).color.alpha, 1);
    assert.equal(wallEntity.wall!.maximumHeights!.getValue(time)[0], polygon[0].height + 100);
    // Selection changes the screening signature once; presentation changes below do not.
    const selectedBaseline = f.scene.getSnapshot();
    settings.limits.representation = 'plane'; f.scene.setDisplay(settings);
    assert.equal(entity('wall'), undefined); assert.ok(entity('area')?.polygon);
    assert.equal(f.scene.getSnapshot().generation, selectedBaseline.generation);
    assert.equal(f.scene.getSnapshot().signature, selectedBaseline.signature);
    assert.deepEqual(f.scene.getResults(), baseline.results);
    settings.limits.representation = 'both'; f.scene.setDisplay(settings); f.scene.setLayers({ limits: false });
    assert.equal(entity('wall'), undefined); assert.equal(entity('area'), undefined);
    assert.deepEqual(f.scene.getResults(), baseline.results);
    f.scene.setLayers({ limits: true }); assert.ok(entity('wall'));
    f.scene.setContext({ ...saved, active: false }); assert.equal(entity('wall'), undefined);
    f.scene.setContext(saved); await settled(f.scene); assert.ok(entity('wall'));
    f.scene.setContext({ ...saved, canView: false }); assert.equal(entity('wall'), undefined);
    assert.deepEqual(saved, original, 'wall heights and opacity never write polygon coordinates or business records');
  } finally { f.scene.dispose(); }
});

test('display catalogue separates personnel and two areas; visibility and labels apply to later entities without screening writes', async () => {
  const f = fixture(), guard = record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: ['crane'],
    workArea: { polygon: square(origin, 5), deviceId: 'device' } });
  const saved = context([guard, record('limit', { schemaVersion: 1, kind: 'limit', polygon: square() }),
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['limit'] })]);
  try {
    f.scene.setContext(saved);
    f.scene.setDisplayVisibility({ 'rail:responsibility:guard': false, 'rail:envelope:crane': false }, false);
    await settled(f.scene);
    const baseline = f.scene.getSnapshot(), entities = () => f.source().entities.values;
    assert.deepEqual(f.scene.getDisplayObjects().map(item => item.key), [
      'rail:personnel:guard', 'rail:responsibility:guard', 'rail:workArea:guard', 'rail:limit:limit', 'rail:envelope:crane',
    ]);
    assert.equal(entities().find(e => e.id === 'rail-safety:guard:guard:area'), undefined);
    assert.ok(entities().find(e => e.id === 'rail-safety:guard:guard:station')?.model);
    assert.ok(entities().find(e => e.id === 'rail-safety:guard:guard:work-area')?.polygon);
    assert.ok(!entities().some(e => e.id.startsWith('rail-safety:machine:')), 'late calculation honours the hidden envelope override');
    assert.ok(entities().every(e => !e.label));
    assert.equal(f.scene.getResults()[0].status, 'overlap', 'hidden limits and envelopes still participate in screening');
    f.scene.setObjectVisibility('personnel', 'guard', false);
    assert.equal(entities().find(e => e.id === 'rail-safety:guard:guard:station'), undefined);
    assert.ok(entities().find(e => e.id === 'rail-safety:guard:guard:work-area'));
    f.scene.setObjectVisibility('workArea', 'guard', false);
    assert.ok(!entities().some(e => e.id.includes(':work-area')));
    f.scene.setObjectVisibility('limit', 'limit', false);
    assert.ok(!entities().some(e => e.id.startsWith('rail-safety:limit:')));
    f.scene.setDisplayVisibility({}, true);
    assert.ok(entities().some(e => e.label)); assert.ok(entities().find(e => e.id === 'rail-safety:guard:guard:area'));
    assert.ok(entities().find(e => e.id === 'rail-safety:machine:crane:envelope'));
    assert.equal(f.scene.getSnapshot().generation, baseline.generation); assert.equal(f.scene.getSnapshot().signature, baseline.signature);
    assert.deepEqual(f.scene.getResults(), baseline.results);
    f.scene.setObjectVisibility('limit', 'limit', false); f.scene.setLabelsVisible(false);
    f.scene.setContext({ ...saved, actorId: 'other' }); await settled(f.scene);
    assert.ok(f.scene.getDisplayObjects().every(item => item.visible)); assert.equal(f.scene.getSnapshot().labelsVisible, true);
    f.scene.setContext({ ...saved, canView: false }); assert.deepEqual(f.scene.getDisplayObjects(), []);
  } finally { f.scene.dispose(); }
});

test('range effects keep geometry and screening fixed, animate all six categories and stop when hidden or inactive', async () => {
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
  const previousSchedule = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  const f = fixture(), time = JulianDate.now();
  const saved = context([
    record('config', { schemaVersion: 1, kind: 'machine', resourceId: 'crane', selectedLimitIds: ['near'] }),
    record('near', { schemaVersion: 1, kind: 'limit', polygon: square() }),
    record('guard', { schemaVersion: 1, kind: 'guard', station: origin, polygon: square(), resourceIds: ['crane'],
      workArea: { polygon: square(origin, 5), deviceId: 'guard-device', staleAfterSeconds: 30 } }),
  ]);
  const get = (id: string) => f.source().entities.getById(`rail-safety:${id}`)!;
  try {
    f.scene.setContext(saved); await settled(f.scene);
    const before = f.scene.getSnapshot();
    assert.equal(frames.size, 0, 'default static presentation schedules no frames');
    const settings = structuredClone(DEFAULT_RAIL_SAFETY_DISPLAY); settings.limits.representation = 'both';
    for (const effect of Object.values(settings.effects)) { effect.mode = 'flow'; effect.speed = 1.5; effect.intensity = 0.7; }
    f.scene.setDisplay(settings);
    const riskId = before.entityIds.find(id => id.includes(':intersection:'))!.slice('rail-safety:'.length);
    for (const id of ['guard:guard:area', 'guard:guard:work-area', 'limit:near:area', 'machine:crane:envelope', riskId, 'machine:crane:support']) {
      for (const material of [get(id).polygon!.material!, get(id).polyline!.material!]) {
        assert.match(material.getType(time)!, /RailSafetyRangeEffect/);
        assert.equal(material.getValue(time).mode, 2);
        assert.equal(material.getValue(time).intensity, 0.7);
        assert.equal(material.isConstant, true, 'GPU frame animation must not mark ground geometry dynamic');
      }
    }
    assert.equal(get('limit:near:wall').wall!.material!.getValue(time).mode, 2);
    assert.equal(get('limit:near:wall').polyline!.material!.getValue(time).mode, 2);
    assert.equal(frames.size, 1, 'one shared loop animates all visible ranges');
    const polygon = get('machine:crane:envelope').polygon!, hierarchy = polygon.hierarchy;
    for (let tick = 0; tick < 3; tick++) {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(tick * 16));
      assert.equal(get('machine:crane:envelope').polygon, polygon);
      assert.equal(get('machine:crane:envelope').polygon!.hierarchy, hierarchy);
      assert.equal(frames.size, 1);
    }
    assert.deepEqual(f.scene.getResults(), before.results);
    assert.equal(f.scene.getSnapshot().generation, before.generation);
    const hidden = Object.fromEntries(f.scene.getDisplayObjects().map(object => [object.key, false]));
    f.scene.setDisplayVisibility(hidden, true); assert.equal(frames.size, 0, 'hiding every range cancels its loop');
    f.scene.setDisplayVisibility({}, true); assert.equal(frames.size, 1);
    settings.effects.responsibility.mode = 'breathe'; settings.guards.opacity = 0;
    f.scene.setDisplay(settings);
    assert.equal(get('guard:guard:area').polygon!.material!.getValue(time).color.alpha, 0, 'an effect never raises zero fill opacity');
    for (const effect of Object.values(settings.effects)) effect.mode = 'static';
    f.scene.setDisplay(settings); assert.equal(frames.size, 0);
    settings.effects.limit.mode = 'breathe'; f.scene.setDisplay(settings); assert.equal(frames.size, 1);
    f.scene.setContext({ ...saved, active: false }); assert.equal(frames.size, 0);
    f.scene.setContext(saved); assert.equal(frames.size, 1);
    f.scene.dispose(); assert.equal(frames.size, 0);
  } finally {
    f.scene.dispose();
    globalThis.requestAnimationFrame = previousSchedule; globalThis.cancelAnimationFrame = previousCancel;
  }
});
