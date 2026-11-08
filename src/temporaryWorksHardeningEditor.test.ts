import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import {
  hardeningGeoFromLocal, hardeningLocalFromGeo, hardeningRectangle, hardeningSlopeComponents,
  intersectHardeningDesignPlane, validateHardeningReference, HARDENING_DRAW_MAX_RADIUS,
} from './temporaryWorksHardeningEditorGeometry';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { TemporaryWorksHardeningEditor } = await import('./temporaryWorksHardeningEditor');

const reference = { longitude: 121, latitude: 31, height: 120 };
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(reference.longitude, reference.latitude, reference.height));
const ray = (origin: Cartesian3, direction: Cartesian3) => ({
  origin: Matrix4.multiplyByPoint(frame, origin, new Cartesian3()),
  direction: Matrix4.multiplyByPointAsVector(frame, Cartesian3.normalize(direction, new Cartesian3()), new Cartesian3()),
});
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('drawing intersects the user plane at a fixed anchor and is independent of photography heights', () => {
  const result = intersectHardeningDesignPlane(ray(new Cartesian3(10, 20, 500), new Cartesian3(0, 0, -1)), reference, 10, 5)!;
  near(result.x, 10); near(result.y, 20);
  const lowerCamera = intersectHardeningDesignPlane(ray(new Cartesian3(10, 20, 15), new Cartesian3(0, 0, -1)), reference, 10, 5)!;
  near(lowerCamera.x, result.x); near(lowerCamera.y, result.y);
});

test('sloped design plane uses the ray intersection rather than projecting screen corners onto terrain', () => {
  const result = intersectHardeningDesignPlane(ray(new Cartesian3(0, 0, 100), new Cartesian3(1, 0, -1)), reference, 10, 0)!;
  near(result.x, 100 / 1.1); near(result.y, 0);
});

test('parallel, backwards and out-of-range rays never silently pick tree tops instead', () => {
  assert.equal(intersectHardeningDesignPlane(ray(new Cartesian3(0, 0, 100), new Cartesian3(1, 0, 0)), reference), undefined);
  assert.equal(intersectHardeningDesignPlane(ray(new Cartesian3(0, 0, 100), new Cartesian3(0, 0, 1)), reference), undefined);
  assert.equal(intersectHardeningDesignPlane(ray(new Cartesian3(HARDENING_DRAW_MAX_RADIUS + 100, 0, 100), new Cartesian3(0, 0, -1)), reference), undefined);
});

test('the rectangle remains an ENU rectangle whichever diagonal is selected first', () => {
  const a = { x: -10, y: 4 }, b = { x: 20, y: -8 };
  const expected = [{ x: -10, y: -8 }, { x: 20, y: -8 }, { x: 20, y: 4 }, { x: -10, y: 4 }];
  assert.deepEqual(hardeningRectangle(a, b), expected);
  assert.deepEqual(hardeningRectangle(b, a), expected);
  assert.throws(() => hardeningRectangle(a, { ...a, y: 8 }), /长、宽/);
});

test('disabled slope ignores stale invalid draft controls', () => {
  assert.deepEqual(hardeningSlopeComponents(false, NaN, Infinity), { gradeEastPct: 0, gradeNorthPct: 0 });
  const east = hardeningSlopeComponents(true, 90, 2);
  near(east.gradeEastPct, 2); near(east.gradeNorthPct, 0);
  const negativeNorth = hardeningSlopeComponents(true, 0, -1);
  near(negativeNorth.gradeNorthPct, -1);
  assert.throws(() => hardeningSlopeComponents(true, NaN, 2), /有效.*坡向/);
});

test('geographic outline conversion is anchored and bounded, and missing design elevations are rejected', () => {
  const xy = { x: 80, y: -25 };
  const point = hardeningGeoFromLocal(xy, reference), restored = hardeningLocalFromGeo(point, reference);
  near(restored.x, xy.x, 1e-5); near(restored.y, xy.y, 1e-5);
  assert.throws(() => hardeningGeoFromLocal({ x: HARDENING_DRAW_MAX_RADIUS + 1, y: 0 }, reference), /过远/);
  assert.throws(() => validateHardeningReference({ ...reference, height: NaN }), /椭球高/);
  assert.throws(() => validateHardeningReference({ ...reference, latitude: 90 }), /极区/);
});

function editor(fields: Record<string, any> = {}) {
  const input: Record<string, { value: string; checked: boolean }> = {};
  for (const [key, value] of Object.entries({ longitude: '121', latitude: '31', height: '120', thickness: '0.2', name: '场地', direction: '90', grade: '2', facility: '', 'facility-height': '', 'facility-thickness': '' }))
    input[key] = { value, checked: false };
  for (const key of ['slope-enabled', 'clipping', 'accept-height', 'manual-elevation']) input[key] = { value: '', checked: ['clipping','manual-elevation'].includes(key) };
  const instance = Object.assign(Object.create(TemporaryWorksHardeningEditor.prototype), {
    boundary: [{ longitude: 121, latitude: 31 }, { longitude: 121.001, latitude: 31 }, { longitude: 121.001, latitude: 31.001 }],
    holes: [], facilityExclusions: [], drawing: undefined, invalidVertexFields: new Set(), invalidVertexValues: new Map(),
    field(key: string) { return input[key]; },
    cancelDrawing() { this.drawing = undefined; }, refresh() {}, refreshOutlines() {}, setStatus() {}, ...fields,
  });
  return { instance, input };
}

test('getValue preserves source outlines and returns an independent draft without terrain data', () => {
  const { instance, input } = editor();
  input.direction.value = ''; input.grade.value = 'invalid';
  const value = instance.getValue();
  assert.equal(value.gradeEastPct, 0); assert.equal(value.gradeNorthPct, 0);
  value.boundary[0].longitude = 0;
  assert.equal(instance.boundary[0].longitude, 121);
  assert.equal('sampleHeight' in value, false);
  input.height.value = '';
  assert.throws(() => instance.getValue(), /场地顶椭球高/);
});

test('restoring a saved outline does not silently reuse a previous height-conflict acknowledgement', () => {
  const { instance, input } = editor();
  const saved = instance.getValue(); saved.acceptedHeightDifference = true; saved.slopeEnabled = true;
  saved.gradeEastPct = -2; saved.gradeNorthPct = 1;
  saved.holes = [[{ longitude: 121.0001, latitude: 31.0001 }, { longitude: 121.0002, latitude: 31.0001 }, { longitude: 121.0002, latitude: 31.0002 }]];
  instance.setValue(saved);
  assert.equal(input['accept-height'].checked, false);
  const restored = instance.getValue();
  near(restored.gradeEastPct, -2); near(restored.gradeNorthPct, 1);
  assert.deepEqual(restored.holes, saved.holes);
  saved.holes[0][0].longitude = 0;
  assert.equal(instance.holes[0][0].longitude, 121.0001);
});

test('new outlines default to automatic elevation and saved outlines preserve their exact level', () => {
  const { instance, input } = editor();
  const saved = instance.getValue();
  delete saved.initialElevationMode;
  instance.setValue();
  assert.equal(input['manual-elevation'].checked, false);
  assert.equal(input.height.value, '');
  assert.equal(input.longitude.value, '');
  assert.equal(input.latitude.value, '');
  instance.setValue(saved);
  assert.equal(instance.getValue().initialElevationMode, 'manual');
  assert.equal(instance.getValue().reference.height, 120);
  instance.setValue({ ...saved, initialElevationMode: 'automatic' });
  assert.equal(instance.getValue().initialElevationMode, 'automatic');
});

test('automatic first click captures selected photography once, completes a rectangle, and needs no height input', () => {
  let picks = 0;
  const { instance, input } = editor({
    options: { getModel: () => ({ id: 'photo', name: '摄影' }), pickInitialReference: () => { picks++; return { ...reference }; },
      viewer: { camera: { getPickRay: () => ray(new Cartesian3(20, 10, 500), new Cartesian3(0, 0, -1)) } } },
  });
  input['manual-elevation'].checked = false;
  input.height.value = ''; input.longitude.value = ''; input.latitude.value = '';
  instance.drawing = instance.prepareDrawing('rectangle', 'outer');
  assert.equal(instance.drawing.reference, undefined);
  assert.equal(instance.pick({ x: 10, y: 10 }, false), undefined);
  assert.equal(picks, 0, 'hover cannot select the initial datum');
  instance.drawing.points.push(instance.pick({ x: 10, y: 10 }));
  assert.equal(picks, 1);
  assert.equal(input.height.value, '', 'cancel must remain able to keep the previous datum');
  const opposite = instance.pick({ x: 20, y: 20 });
  near(opposite.x, 20); near(opposite.y, 10);
  assert.equal(picks, 1, 'the initial plane controls the subsequent point');
  instance.drawing.points.push(opposite);
  instance.finishDrawing();
  const result = instance.getValue();
  assert.equal(result.initialElevationMode, 'automatic');
  assert.deepEqual(result.reference, reference);
  assert.equal(result.boundary.length, 4);
  const local = result.boundary.map((point: any) => hardeningLocalFromGeo(point, reference));
  near(Math.max(...local.map((point: any) => point.x)), 20, 1e-5);
  near(Math.max(...local.map((point: any) => point.y)), 10, 1e-5);
});

test('unavailable photography never fabricates a zero height or falls through to terrain', () => {
  const messages: string[] = [];
  const { instance, input } = editor({
    options: { getModel: () => ({ id: 'photo', name: '摄影' }), pickInitialReference: () => undefined,
      viewer: { camera: { getPickRay: () => { throw new Error('must not use another surface'); } } } },
    setStatus: (message: string) => messages.push(message),
  });
  input['manual-elevation'].checked = false;
  input.height.value = ''; input.longitude.value = ''; input.latitude.value = '';
  instance.drawing = instance.prepareDrawing('rectangle', 'outer');
  assert.equal(instance.pick({ x: 1, y: 1 }), undefined);
  assert.equal(instance.drawing.reference, undefined);assert.equal(input.height.value, '');
  assert.match(messages.at(-1)!, /未拾取到所选倾斜摄影/);
  instance.options.getModel = () => undefined;
  assert.throws(() => instance.prepareDrawing('rectangle', 'outer'), /选择已加载的倾斜摄影/);
});

test('cancelled or model-switched automatic drawing retains existing outline and reference', () => {
  let model = 'photo';
  const { instance } = editor({
    options: { getModel: () => ({ id: model, name: model }), pickInitialReference: () => ({ ...reference, height: 145 }) },
  });
  const saved = instance.getValue();
  instance.field('manual-elevation').checked = false;
  instance.drawing = instance.prepareDrawing('polygon', 'outer');
  instance.drawing.points.push(instance.pick({ x: 1, y: 1 }));
  instance.cancelDrawing();
  assert.deepEqual(instance.getValue().reference, saved.reference);
  assert.deepEqual(instance.getValue().boundary, saved.boundary);
  instance.drawing = instance.prepareDrawing('polygon', 'outer');
  model = 'different-photo';
  assert.throws(() => instance.pick({ x: 1, y: 1 }), /摄影已变化/);
  assert.equal(instance.drawing, undefined);
  assert.deepEqual(instance.getValue().reference, saved.reference);
});

test('resolved final datum updates outlines without changing mode or geometry, and rejects nonfinite data', () => {
  const { instance, input } = editor();
  input['manual-elevation'].checked = false;
  const outline = structuredClone(instance.boundary);
  instance.setResolvedReference({ ...reference, height: 133.125 });
  assert.equal(instance.getValue().initialElevationMode, 'automatic');
  assert.equal(instance.getValue().reference.height, 133.125);
  assert.deepEqual(instance.boundary, outline);
  assert.throws(() => instance.setResolvedReference({ ...reference, height: NaN }), /椭球高/);
  assert.equal(instance.getValue().reference.height, 133.125);
});

test('manual and restored drawing keeps its saved level and never requests photography sampling', () => {
  const { instance } = editor({ options: { pickInitialReference: () => { throw new Error('must preserve saved height'); } } });
  const drawing = instance.prepareDrawing('polygon', 'outer');
  assert.deepEqual(drawing.reference, reference);
  assert.equal(drawing.automaticReference, false);
});

test('an incomplete vertex edit cannot preview the older coordinate behind invalid form text', () => {
  const { instance } = editor({ invalidVertexFields: new Set(['outer:0:longitude']) });
  assert.throws(() => instance.getValue(), /尚未应用的边界点坐标/);
});

test('a facility footprint without explicitly confirmed floor elevation and thickness is not accepted', () => {
  const { instance } = editor();
  instance.facilityExclusions = [{ objectId: 'steel', boundary: [...instance.boundary] }];
  assert.throws(() => instance.getValue(), /地坪顶标高和正厚度尚未确认/);
  instance.facilityExclusions[0].floorHeight = 123;
  instance.facilityExclusions[0].floorThickness = 0;
  assert.throws(() => instance.getValue(), /地坪顶标高和正厚度尚未确认/);
});

test('restored facility floor values survive cloning and differ from the hardening reference height', () => {
  const { instance } = editor();
  const saved = instance.getValue();
  saved.facilityExclusions = [{ objectId: 'camp', resourceVersion: 'asset-v2', boundary: [...saved.boundary], floorHeight: 123.75, floorThickness: 0.35 }];
  instance.setValue(saved);
  const restored = instance.getValue();
  assert.equal(restored.reference.height, 120);
  assert.equal(restored.facilityExclusions[0].floorHeight, 123.75);
  assert.equal(restored.facilityExclusions[0].floorThickness, 0.35);
  saved.facilityExclusions[0].floorHeight = 0;
  assert.equal(instance.getValue().facilityExclusions[0].floorHeight, 123.75);
});

test('cancelDrawing releases the interaction session and only its own outline once', () => {
  let destroyCount = 0, finishCount = 0, removedCount = 0;
  const outline = {};
  const instance = Object.assign(Object.create(TemporaryWorksHardeningEditor.prototype), {
    drawing: { points: [{ x: 0, y: 0 }] }, disposed: false,
    handler: { isDestroyed: () => false, destroy() { destroyCount++; } },
    finishSession() { finishCount++; }, drawingOutline: outline,
    options: { viewer: { isDestroyed: () => false, entities: { remove(value: unknown) { assert.equal(value, outline); removedCount++; } }, scene: { requestRender() {} } } },
    refreshButtons() {},
  });
  instance.cancelDrawing(); instance.cancelDrawing();
  assert.equal(destroyCount, 1); assert.equal(finishCount, 1); assert.equal(removedCount, 1);
  assert.equal(instance.drawing, undefined); assert.equal(instance.handler, undefined);
});
