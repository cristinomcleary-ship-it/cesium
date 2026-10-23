import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSpatialAnnotation, drawSpatialAnnotations, spatialAnnotationOpacity,
  validateSpatialAnnotation, validateSpatialAnnotations, type SpatialAnnotation, type SpatialPoint,
} from './videoOverlaySpatialAnnotations.ts';

type Call = { method: string; args: unknown[]; alpha: number; dashOffset: number };
function canvasSpy() {
  const calls: Call[] = [], states: Record<string, unknown>[] = [];
  const properties = ['globalAlpha', 'globalCompositeOperation', 'strokeStyle', 'fillStyle', 'lineWidth', 'lineCap', 'lineJoin', 'font', 'textBaseline', 'textAlign', 'lineDashOffset'];
  const target: Record<string, unknown> = {
    globalAlpha: .8, globalCompositeOperation: 'multiply', lineWidth: 7, font: '12px serif', lineDashOffset: 0,
    save() { states.push(Object.fromEntries(properties.map(key => [key, target[key]]))); },
    restore() { Object.assign(target, states.pop()); },
    measureText(text: string) { return { width: Array.from(text).length * Number(String(target.font).match(/([\d.]+)px/)?.[1] ?? 12) * .6 }; },
  };
  for (const method of ['beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'arc', 'strokeRect', 'fillRect', 'fillText', 'setLineDash']) {
    target[method] = (...args: unknown[]) => calls.push({ method, args, alpha: Number(target.globalAlpha), dashOffset: Number(target.lineDashOffset) });
  }
  return { context: target as unknown as CanvasRenderingContext2D, calls, states, target };
}
const local = (x: number, y: number, z = 1): SpatialPoint => ({ x, y, z });
const projection = (_: string, point: SpatialPoint) => ({ x: point.x, y: point.y, depth: point.z });
const options = { width: 1920, height: 1080, mediaTime: 2, project: projection };
const mark = (kind: 'label' | 'route' | 'area', overrides: Partial<SpatialAnnotation> = {}) => createSpatialAnnotation(kind, {
  targetId: 'bridge-4', targetName: '4号墩', points: kind === 'label' ? [local(.4, .5)] : kind === 'route' ? [local(.2, .3), local(.7, .8)] : [local(.2, .3), local(.7, .3), local(.6, .8)],
  fadeIn: 0, fadeOut: 0, ...overrides,
});

test('local anchors survive independent save/restore and invalid data cannot enter composition', () => {
  const source = mark('label');
  const saved = validateSpatialAnnotations(JSON.parse(JSON.stringify([source])));
  assert.deepEqual(saved, [source]); assert.notEqual(saved[0].points, source.points); assert.notEqual(saved[0].points[0], source.points[0]);
  for (const change of [
    { points: [] }, { points: [local(NaN, 1)] }, { points: [local(1, 2, Infinity)] }, { points: [local(1e10, 2)] },
    { targetId: '' }, { kind: 'html' }, { color: 'url(https://example.invalid)' }, { visible: 1 }, { flow: null },
    { start: -1 }, { end: 0 }, { fadeIn: -1 }, { offsetX: Infinity }, { fillOpacity: 1.1 }, { fontSize: 0 },
  ]) assert.throws(() => validateSpatialAnnotation({ ...source, ...change }));
  assert.throws(() => validateSpatialAnnotations([source, source])); assert.throws(() => validateSpatialAnnotations(null));
  assert.throws(() => mark('route', { points: [local(0, 0), local(0, 0)] }));
  assert.throws(() => mark('area', { points: [local(0, 0), local(0, 0), local(1, 0)] }));
  assert.throws(() => mark('area', { points: [local(0, 0), local(1, 1), local(2, 2)] }), /同一直线/);
  assert.throws(() => mark('route', { points: Array.from({ length: 257 }, (_, x) => local(x, 0)) }));
  assert.deepEqual(validateSpatialAnnotations(undefined), []);
  assert.equal(mark('label', { start: 20 }).end, 25);
});

test('spatial fade intervals are seekable and inclusive/exclusive without moving the anchor', () => {
  const source = mark('label', { start: 10, end: 10.2, fadeIn: 1, fadeOut: 1 });
  assert.equal(spatialAnnotationOpacity(source, 10), 0);
  assert.ok(Math.abs(spatialAnnotationOpacity(source, 10.05) - .5) < 1e-10);
  assert.equal(spatialAnnotationOpacity(source, 10.2), 0);
  assert.equal(spatialAnnotationOpacity({ ...source, visible: false }, 10.1), 0);
  assert.equal(spatialAnnotationOpacity(source, NaN), 0);
  const first = canvasSpy(), second = canvasSpy();
  drawSpatialAnnotations(first.context, [source], { ...options, mediaTime: 10.05 });
  drawSpatialAnnotations(second.context, [source], { ...options, mediaTime: 10.1 });
  assert.deepEqual(first.calls.find(call => call.method === 'arc')?.args, second.calls.find(call => call.method === 'arc')?.args);
});

test('camera or target movement reprojections move the leader endpoint while local data stays unchanged', () => {
  const source = mark('label'), original = structuredClone(source);
  const frameA = canvasSpy(), frameB = canvasSpy();
  drawSpatialAnnotations(frameA.context, [source], options);
  drawSpatialAnnotations(frameB.context, [source], { ...options, project: (_, point) => ({ x: point.x + .1, y: point.y - .2, depth: 10 }) });
  const a = frameA.calls.find(call => call.method === 'arc')!.args;
  const b = frameB.calls.find(call => call.method === 'arc')!.args;
  assert.equal(Number(b[0]) - Number(a[0]), 192); assert.equal(Number(b[1]) - Number(a[1]), -216);
  assert.deepEqual(source, original);
  assert.equal(drawSpatialAnnotations(canvasSpy().context, [source], { ...options, targetVisible: () => false }), 0);
});

test('missing/behind-camera points never bridge route gaps or invent a closed area', () => {
  const points = [local(.1, .2), local(.3, .3), local(.4, .4, -1), local(.7, .7), local(.9, .8)];
  const spy = canvasSpy(), line = mark('route', { points, text: '', flow: false });
  assert.equal(drawSpatialAnnotations(spy.context, [line], options), 1);
  // Each visible segment has one line stroke; arrowheads only fill.
  assert.equal(spy.calls.filter(call => call.method === 'stroke').length, 2);
  assert.equal(drawSpatialAnnotations(canvasSpy().context, [mark('area', { points: points.slice(0, 3) })], options), 0);
  assert.equal(drawSpatialAnnotations(canvasSpy().context, [mark('label', { points: [local(.5, .5, -1)] })], options), 0);
  assert.equal(drawSpatialAnnotations(canvasSpy().context, [mark('label', { points: [local(1.1, .5)] })], options), 0);
  assert.equal(drawSpatialAnnotations(canvasSpy().context, [line], { ...options, project: () => undefined }), 0);
});

test('lines and regions clip crossing screen edges instead of disappearing or adding a false border', () => {
  const line = canvasSpy();
  assert.equal(drawSpatialAnnotations(line.context, [mark('route', { points: [local(-2, .5), local(3, .5)], text: '', flow: false })], options), 1);
  assert.deepEqual(line.calls.find(call => call.method === 'moveTo')!.args, [0, 540]);
  assert.deepEqual(line.calls.find(call => call.method === 'lineTo')!.args, [1920, 540]);
  const area = canvasSpy();
  assert.equal(drawSpatialAnnotations(area.context, [mark('area', { points: [local(-1, -1), local(2, -1), local(2, 2), local(-1, 2)], text: '' })], options), 1);
  assert.ok(area.calls.some(call => call.method === 'fill'));
  assert.equal(area.calls.filter(call => call.method === 'stroke').length, 0, 'viewport clipping must not invent region edges');
});

test('flow arrows depend only on video time and yield identical results after seeking', () => {
  const source = mark('route', { text: '', flow: true });
  const draw = (time: number) => { const spy = canvasSpy(); drawSpatialAnnotations(spy.context, [source], { ...options, mediaTime: time }); return spy.calls; };
  const earlier = draw(1.2); draw(4.5); draw(.1);
  assert.deepEqual(draw(1.2), earlier); assert.notDeepEqual(draw(1.3), earlier);
});

test('labels stay in video bounds and avoid colliding deterministically with earlier labels', () => {
  const source = mark('label', { offsetX: 4000, offsetY: -4000, text: '施工区域\n安全🚧巡检' });
  const spy = canvasSpy(); drawSpatialAnnotations(spy.context, [source, { ...source, id: 'second' }], options);
  const cards = spy.calls.filter(call => call.method === 'strokeRect').map(call => call.args.map(Number));
  assert.equal(cards.length, 2); assert.notDeepEqual(cards[0], cards[1]);
  for (const [x, y, width, height] of cards) assert.ok(x >= 0 && y >= 0 && x + width <= 1920 && y + height <= 1080);
  const again = canvasSpy(); drawSpatialAnnotations(again.context, [source, { ...source, id: 'second' }], options);
  assert.deepEqual(again.calls, spy.calls);
});

test('native resolution styles and anchors scale together without leaking canvas state', () => {
  const source = mark('label'), low = canvasSpy(), high = canvasSpy();
  drawSpatialAnnotations(low.context, [source], { ...options, width: 960, height: 540 });
  drawSpatialAnnotations(high.context, [source], { ...options, width: 3840, height: 2160 });
  const lo = low.calls.find(call => call.method === 'strokeRect')!, hi = high.calls.find(call => call.method === 'strokeRect')!;
  lo.args.forEach((value, index) => assert.equal(Number(hi.args[index]), Number(value) * 4));
  assert.equal(high.context.globalAlpha, .8); assert.equal(high.context.globalCompositeOperation, 'multiply'); assert.equal(high.context.lineWidth, 7); assert.equal(high.states.length, 0);
  high.target.fillText = () => { throw new Error('lost canvas'); };
  assert.throws(() => drawSpatialAnnotations(high.context, [source], options), /lost canvas/);
  assert.equal(high.states.length, 0); assert.equal(high.context.globalCompositeOperation, 'multiply');
});
