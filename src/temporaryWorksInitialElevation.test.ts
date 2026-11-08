import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_INITIAL_ELEVATION_SAMPLES, polygonInitialElevationCandidates, roadInitialElevationCandidates,
  sampleTemporaryWorksInitialElevation, type InitialElevationFootprint,
} from './temporaryWorksInitialElevation.ts';

type XY = { x: number; y: number };
const rectangle = (x: number, y: number, width: number, height: number): XY[] => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
// Independent ray crossing for the expected simple fixtures (all expected samples are interior).
function inside(point: XY, ring: readonly XY[]) {
  let hits = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) hits++;
  }
  return hits % 2 === 1;
}
const geoCandidates = (count = 9) => Array.from({ length: count }, (_, i) => ({ longitude: 121 + i * .00001, latitude: 31, station: i * 10 }));

test('rectangular pads use their center first and a deterministic bounded interior set', () => {
  const footprint = { outer: rectangle(0, 0, 100, 80) }, snapshot = structuredClone(footprint);
  const points = polygonInitialElevationCandidates([footprint]);
  assert.deepEqual(points[0], { x: 50, y: 40 });
  assert.equal(points.length, MAX_INITIAL_ELEVATION_SAMPLES);
  assert.ok(points.every(p => p.x > 0 && p.x < 100 && p.y > 0 && p.y < 80));
  assert.deepEqual(points, polygonInitialElevationCandidates([footprint]));
  assert.deepEqual(footprint, snapshot);
});

test('concave outlines, courtyard holes and disconnected footprints never sample their empty bbox areas', () => {
  const concave = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 100 }, { x: 0, y: 100 }];
  const footprints: InitialElevationFootprint[] = [
    { outer: concave },
    { outer: rectangle(200, 0, 100, 100), holes: [rectangle(220, 20, 60, 60)] },
    { outer: rectangle(-100, -100, 10, 10) },
  ];
  const points = polygonInitialElevationCandidates(footprints);
  assert.ok(points.length <= 9);
  for (const point of points) assert.ok(footprints.some(polygon => inside(point, polygon.outer) && !polygon.holes?.some(hole => inside(point, hole))));
  assert.ok(points.some(point => inside(point, concave)));
  assert.ok(points.some(point => point.x > 200));
  assert.ok(points.some(point => point.x < 0));
  assert.ok(!points.some(point => point.x === 50 && point.y === 50));
  assert.ok(!points.some(point => point.x === 250 && point.y === 50));
});

test('thin polygons and reversed/closed rings still yield interior positions, with no sampling budget growth', () => {
  const outer = rectangle(0, 0, 100, .001).reverse(), closed = [...outer, outer[0]];
  const points = polygonInitialElevationCandidates([{ outer: closed }]);
  assert.ok(points.length > 0 && points.length <= 9);
  assert.ok(points.every(p => p.x > 0 && p.x < 100 && p.y > 0 && p.y < .001));
  const dense = Array.from({ length: 256 }, (_, i) => ({ x: Math.cos(i * Math.PI / 128) * 100, y: Math.sin(i * Math.PI / 128) * 100 }));
  assert.equal(polygonInitialElevationCandidates([{ outer: dense }]).length, 9);
});

test('rotated multi-hole footprints retain strict hole avoidance across local offsets and orientations', () => {
  for (const angle of [0, .37, 1.6, 3.8]) {
    const transform = (p: XY): XY => ({ x: 18_000 + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: -3_000 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const footprint = { outer: rectangle(0, 0, 100, 80).map(transform), holes: [
      rectangle(5, 5, 35, 60).map(transform), rectangle(55, 20, 35, 55).reverse().map(transform),
    ] };
    const samples = polygonInitialElevationCandidates([footprint]);
    assert.ok(samples.length > 0 && samples.length <= 9);
    for (const point of samples) {
      assert.ok(inside(point, footprint.outer));
      assert.ok(!footprint.holes.some(hole => inside(point, hole)));
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
});

test('invalid/degenerate and over-budget areas fail explicitly instead of producing an arbitrary point', () => {
  assert.throws(() => polygonInitialElevationCandidates([]), /范围为空/);
  assert.throws(() => polygonInitialElevationCandidates([{ outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }]), /三个/);
  assert.throws(() => polygonInitialElevationCandidates([{ outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: NaN, y: 1 }] }]), /无效坐标/);
  assert.throws(() => polygonInitialElevationCandidates([{ outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }]), /内部取高点/);
  assert.throws(() => polygonInitialElevationCandidates([{ outer: Array.from({ length: 20_001 }, () => ({ x: 0, y: 0 })) }]), /边界过于复杂/);
});

test('road candidates follow the axis and measured arc factors, including reversed routes', () => {
  const axis = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], factors = [2, 1];
  const points = roadInitialElevationCandidates(axis, factors);
  assert.equal(points.length, 9);
  assert.deepEqual(points[0], { x: 75, y: 0, station: 150 });
  assert.deepEqual(points[1], { x: 0, y: 0, station: 0 });
  assert.deepEqual(points[2], { x: 100, y: 100, station: 300 });
  assert.ok(points.every(p => p.y === 0 && p.x >= 0 && p.x <= 100 || p.x === 100 && p.y >= 0 && p.y <= 100));
  const reversed = roadInitialElevationCandidates([...axis].reverse(), [...factors].reverse());
  assert.deepEqual(reversed[0], points[0]);
  assert.deepEqual(reversed[1], { x: 100, y: 100, station: 0 });
  assert.deepEqual(reversed[2], { x: 0, y: 0, station: 300 });
  assert.deepEqual(roadInitialElevationCandidates([axis[0], ...axis], [1, ...factors]), points);
  assert.throws(() => roadInitialElevationCandidates(axis, [1]), /不匹配/);
  assert.throws(() => roadInitialElevationCandidates([{ x: 0, y: 0 }, { x: 0, y: 0 }]), /两个不同/);
});

test('a valid first point uses one photography sample, retaining metadata and valid zero/negative heights', async () => {
  for (const height of [0, -3.5, 46.2]) {
    const candidates = geoCandidates(), before = structuredClone(candidates), requests: typeof candidates[] = [];
    const result = await sampleTemporaryWorksInitialElevation(candidates, async points => { requests.push(points); return [height]; });
    assert.equal(requests.length, 1); assert.equal(requests[0].length, 1);
    assert.deepEqual(result, { ...candidates[0], height, sampleCount: 1, candidateIndex: 0 });
    assert.deepEqual(candidates, before);
  }
});

test('fallback is one fixed small batch and returns the first valid value rather than a minimum or average', async () => {
  const candidates = geoCandidates(30), requests: typeof candidates[] = [];
  const result = await sampleTemporaryWorksInitialElevation(candidates, async points => {
    requests.push(points);
    return requests.length === 1 ? [NaN] : [null, undefined, 27, -99, 100, null, Infinity, null];
  });
  assert.deepEqual(requests.map(points => points.length), [1, 8]);
  assert.deepEqual(result, { ...candidates[3], height: 27, sampleCount: 9, candidateIndex: 3 });
  assert.equal(requests.flat().length, 9);
});

test('missing/invalid heights never synthesize zero and incomplete sampling results request manual fallback', async () => {
  let calls = 0;
  await assert.rejects(sampleTemporaryWorksInitialElevation(geoCandidates(), async points => {
    calls++; return points.map((_, i) => [null, undefined, NaN, Infinity][i % 4]);
  }), /未读取到有效倾斜摄影高程.*手动输入标高/);
  assert.equal(calls, 2);
  await assert.rejects(sampleTemporaryWorksInitialElevation(geoCandidates(), async () => []), /结果不完整.*手动输入标高/);
  await assert.rejects(sampleTemporaryWorksInitialElevation([], async () => []), /没有可用取高点/);
  await assert.rejects(sampleTemporaryWorksInitialElevation([{ longitude: NaN, latitude: 31 }], async () => [123]), /无效经纬度/);
});

test('cancellation and stale-job guards run before and after awaiting the sampler', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  let calls = 0;
  await assert.rejects(sampleTemporaryWorksInitialElevation(geoCandidates(), async () => { calls++; return [100]; }, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const pending = new AbortController();
  await assert.rejects(sampleTemporaryWorksInitialElevation(geoCandidates(), async () => { calls++; pending.abort(); return [100]; }, { signal: pending.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  let current = true;
  await assert.rejects(sampleTemporaryWorksInitialElevation(geoCandidates(), async () => { calls++; current = false; return [null]; },
    { checkCurrent: () => { if (!current) throw new Error('方案已改变'); } }), /方案已改变/);
  assert.equal(calls, 2);
});
