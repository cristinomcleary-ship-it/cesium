import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanXY } from './temporaryWorksGeometry.ts';
import { solveDrapedRoad, type DrapedRoadResult } from './temporaryWorksDrapedRoad.ts';
import type { RoadSampler } from './temporaryWorksRoadCalculation.ts';

const section = { width: 4, hardeningDepth: 0.2, treatmentDepth: 0.4 };
const route = (length: number): PlanXY[] => [{ x: 0, y: 0 }, { x: length, y: 0 }];
const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

function survey(height: (point: PlanXY) => number | null) {
  const counts = new Map<number, number>();
  let total = 0, calls = 0, previousCompleted = 0;
  const sample: RoadSampler = async (points, batch) => {
    assert.ok(points.length > 0 && points.length <= 512, `unbounded ray request: ${points.length}`);
    assert.ok(batch.completed >= previousCompleted, 'whole-route progress must not reset at a partition');
    previousCompleted = batch.completed;
    counts.set(batch.chunk, (counts.get(batch.chunk) ?? 0) + points.length);
    total += points.length;
    calls++;
    return points.map(height);
  };
  return { sample, counts, get total() { return total; }, get calls() { return calls; } };
}

/** Coordinate incidence also finds unwelded T-junctions: they create internal
 * singly-used edges and increase the perimeter of a fully covered rectangle. */
function checkFullRectangle(result: DrapedRoadResult, length: number, ground: (point: PlanXY) => number) {
  const pointKey = (p: PlanXY) => `${Math.round(p.x * 1e7)}/${Math.round(p.y * 1e7)}`;
  const edges = new Map<string, { count: number; length: number }>();
  const triangleKeys = new Set<string>();
  let area = 0;
  for (const vertex of result.vertices) {
    near(vertex.formationHeight, ground(vertex));
    near(vertex.groundHeight, ground(vertex));
    near(vertex.baseHeight - vertex.formationHeight, section.treatmentDepth);
    near(vertex.surfaceHeight - vertex.baseHeight, section.hardeningDepth);
  }
  for (const face of result.triangles) {
    const points = face.map(i => result.vertices[i]);
    const [a, b, c] = points;
    const twice = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    assert.ok(twice > 0, 'degenerate or inverted road face');
    area += twice / 2;
    const key = points.map(pointKey).sort().join('|');
    assert.ok(!triangleKeys.has(key), 'a partition duplicated a face');
    triangleKeys.add(key);
    for (let i = 0; i < 3; i++) {
      const p = points[i], q = points[(i + 1) % 3];
      const pair = [pointKey(p), pointKey(q)].sort().join('|');
      const edge = edges.get(pair);
      if (edge) edge.count++;
      else edges.set(pair, { count: 1, length: Math.hypot(p.x - q.x, p.y - q.y) });
    }
  }
  let perimeter = 0;
  for (const edge of edges.values()) {
    assert.ok(edge.count === 1 || edge.count === 2, 'overlapping partition faces');
    if (edge.count === 1) perimeter += edge.length;
  }
  near(area, length * section.width);
  near(result.coveredArea, area);
  near(result.excludedArea, 0);
  near(perimeter, 2 * (length + section.width), 2e-5);
}

test('a long road streams more than its working budget without resetting progress or coarsening spacing', { timeout: 30000 }, async () => {
  const length = 1200, budget = 20000, points = route(length), saved = JSON.stringify(points);
  const ground = (p: PlanXY) => 10 + 0.002 * p.x + 0.03 * p.y;
  const s = survey(ground);
  const result = await solveDrapedRoad(points, { ...section, maxSamples: budget, maxRefinementLevels: 1 }, 1, s.sample);
  assert.ok(result.sampleCount > budget, 'fixture must cross the former whole-route budget');
  assert.ok(result.samplePartitions > 1);
  assert.ok(result.peakWorkingSamples <= budget);
  assert.ok([...s.counts.values()].every(count => count <= budget));
  assert.equal(result.sampleCount, s.total);
  assert.equal(result.samplingBatches, s.calls);
  assert.equal(result.budgetLimited, false);
  near(result.sampleSpacing, 1);
  near(result.length, length);
  near(result.hardeningVolume, length * section.width * section.hardeningDepth);
  near(result.treatmentVolume, length * section.width * section.treatmentDepth);
  assert.equal(JSON.stringify(points), saved);
  checkFullRectangle(result, length, ground);
});

test('the default 500000-point regression completes a synthetic ten-kilometre route in bounded partitions', { timeout: 60000 }, async context => {
  // The unchanged pre-fix solver throws while allocating the full-route probes,
  // after only 93,975 actual ray samples for precisely this flat/sloping route.
  const length = 10000, ground = (p: PlanXY) => 10 + 0.0002 * p.x;
  const s = survey(ground);
  const result = await solveDrapedRoad(route(length), section, 1, s.sample);
  assert.ok(s.total > 500000, `fixture did not cross 500k samples: ${s.total}`);
  assert.equal(result.sampleCount, s.total);
  assert.ok(result.samplePartitions > 1);
  assert.ok(result.peakWorkingSamples <= 500000);
  assert.ok([...s.counts.values()].every(count => count <= 500000));
  near(result.length, length);
  near(result.planArea, length * section.width);
  near(result.coveredArea, result.planArea);
  near(result.excludedArea, 0);
  assert.ok(result.vertices.some(p => Math.abs(p.x - length) < 1e-7 && Math.abs(p.roadStation - length) < 1e-7));
  for (const p of result.vertices) near(p.formationHeight, ground(p));
  context.diagnostic(JSON.stringify({ length, sampleCount: result.sampleCount, samplePartitions: result.samplePartitions, peakWorkingSamples: result.peakWorkingSamples, vertices: result.vertices.length, coveredArea: result.coveredArea }));
});

test('different refinement on either side of a partition has no artificial wall, crack or duplicate coverage', { timeout: 30000 }, async () => {
  const length = 600, points = route(length), budget = 50000, levels = 2;
  // Observe the first initial-survey boundary in a flat pilot, without assuming
  // or duplicating the solver's partition capacity formula.
  let seam = -Infinity;
  await solveDrapedRoad(points, { ...section, maxSamples: budget, maxRefinementLevels: levels }, 1, async (ps, batch) => {
    if (batch.chunk === 1 && batch.phase === 'initial') for (const p of ps) seam = Math.max(seam, p.x);
    return ps.map(() => 10);
  });
  assert.ok(seam > 0 && seam < length);
  // A convex surface has mid-probes below its chords, so all adequately refined
  // faces can pass without inventing a height offset or bridging a protrusion.
  const ground = (p: PlanXY) => 10 + 0.0002 * Math.max(0, p.x - seam) ** 2;
  const result = await solveDrapedRoad(points, { ...section, maxSamples: budget, maxRefinementLevels: levels, surfaceTolerance: 0.00001 }, 1, survey(ground).sample);
  assert.ok(result.refinementLevels > 0);
  assert.ok(result.samplePartitions > 1);
  assert.ok(result.peakWorkingSamples <= budget);
  checkFullRectangle(result, length, ground);
});

test('partitioning preserves source arc factors and station breaks in both CAD directions', { timeout: 30000 }, async () => {
  const points = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }], factors = [1, 1.25];
  const length = 675, breaks = [330.01, 637.11];
  const params = { ...section, maxSamples: 10000, maxRefinementLevels: 1 };
  const forward = await solveDrapedRoad(points, { ...params, stationFactors: factors, stationBreaks: breaks }, 1, survey(() => 100).sample);
  const reverse = await solveDrapedRoad([...points].reverse(), { ...params, stationFactors: [...factors].reverse(), stationBreaks: breaks.map(s => length - s) }, 1, survey(() => 100).sample);
  near(forward.length, length); near(reverse.length, length);
  near(forward.planArea, 2400); near(reverse.planArea, 2400);
  near(forward.coveredArea, reverse.coveredArea);
  for (const station of breaks) {
    assert.ok(forward.vertices.some(v => Math.abs(v.roadStation - station) < 1e-7));
    assert.ok(reverse.vertices.some(v => Math.abs(v.roadStation - (length - station)) < 1e-7));
  }
  for (const vertex of forward.vertices) near(vertex.roadStation, vertex.x <= 300 ? vertex.x : 300 + (vertex.x - 300) * 1.25);
  for (const vertex of reverse.vertices) near(vertex.roadStation, length - (vertex.x <= 300 ? vertex.x : 300 + (vertex.x - 300) * 1.25));
});

test('partitioned gaps remain excluded and never receive neighbouring measured elevations', { timeout: 30000 }, async () => {
  const ground = (p: PlanXY) => p.x > 90 && p.x < 110 || p.x > 500 ? null : 20 + 0.01 * p.y;
  const result = await solveDrapedRoad(route(600), { ...section, maxSamples: 20000, maxRefinementLevels: 1 }, 1, survey(ground).sample);
  assert.ok(result.samplePartitions > 1);
  assert.ok(result.missingTriangles > 0);
  assert.ok(result.coveredArea > 0 && result.excludedArea >= 480);
  near(result.planArea, result.coveredArea + result.excludedArea);
  for (const p of result.vertices) { assert.notEqual(ground(p), null); near(p.formationHeight, ground(p)!); }
  for (const face of result.triangles) {
    const points = face.map(i => result.vertices[i]);
    assert.ok(points.every(p => p.x <= 90) || points.every(p => p.x >= 110 && p.x <= 500), 'face bridges a missing interval');
  }
});

test('cancelling a later partition stops sampling without returning a partial successful road', { timeout: 30000 }, async () => {
  const controller = new AbortController();
  let cancelledAt = 0, calls = 0;
  await assert.rejects(solveDrapedRoad(route(600), { ...section, maxSamples: 10000, maxRefinementLevels: 1 }, 1, async (points, batch) => {
    assert.ok(!controller.signal.aborted, 'sampler called after cancellation');
    calls++;
    if (batch.chunk >= 2) { cancelledAt = calls; controller.abort(); }
    return points.map(() => 10);
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(cancelledAt > 0, 'fixture must cancel after advancing to a later partition');
  assert.equal(calls, cancelledAt);
});

test('an excessive final mesh is explicitly rejected instead of returning a truncated successful route', { timeout: 30000 }, async () => {
  await assert.rejects(solveDrapedRoad(route(400), { ...section, maxOutputVertices: 1000 }, 1, survey(() => 10).sample), /输出|顶点|最终网格/);
});


test('a long overlapping hairpin retains its complete rounded union without counting the shared strip twice', { timeout: 30000 }, async context => {
  const leg = 350, radius = 2, chords = 36, halfStep = Math.PI / (2 * chords);
  const arc = Array.from({ length: chords + 1 }, (_, i) => ({
    x: leg + radius * Math.sin(2 * halfStep * i),
    y: radius * (1 - Math.cos(2 * halfStep * i)),
  }));
  const points = [{ x: 0, y: 0 }, ...arc, { x: 0, y: 2 * radius }];
  const stationFactors = [1, ...Array(chords).fill(halfStep / Math.sin(halfStep)), 1];
  const ground = (p: PlanXY) => 10 + 0.001 * p.x + 0.002 * p.y;
  const s = survey(ground);
  const result = await solveDrapedRoad(points, { ...section, width: 6, stationFactors }, 1, s.sample);
  assert.equal(result.bendJoin, 'round-union');
  near(result.length, 2 * leg + Math.PI * radius);
  // The two six-metre strips overlap by two metres: their union is ten metres
  // wide plus the outer radius-five semicircle, with flat caps at the open end.
  near(result.planArea, leg * 10 + 25 * Math.PI / 2, 0.04);
  near(result.coveredArea, result.planArea);
  near(result.excludedArea, 0);
  assert.equal(result.sampleCount, s.total);
  assert.ok(result.peakWorkingSamples <= 500000);
  assert.equal(result.budgetLimited, false);
  let area = 0;
  const keys = new Set<string>();
  for (const face of result.triangles) {
    const points = face.map(i => result.vertices[i]);
    const [a, b, c] = points;
    const twice = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    assert.ok(twice > 0);
    area += twice / 2;
    const key = points.map(p => `${Math.round(p.x * 1e7)}/${Math.round(p.y * 1e7)}`).sort().join('|');
    assert.ok(!keys.has(key), 'overlapping legs duplicated a face');
    keys.add(key);
  }
  near(area, result.planArea);
  for (const p of result.vertices) near(p.formationHeight, ground(p));
  context.diagnostic(JSON.stringify({ sampleCount: result.sampleCount, samplePartitions: result.samplePartitions, peakWorkingSamples: result.peakWorkingSamples, planArea: result.planArea }));
});


test('a synthetic 300-metre route with two-millimetre ripples exceeds 500k cumulative samples within the local budget', { timeout: 60000 }, async context => {
  const length = 300;
  const ground = (p: PlanXY) => 30 + 0.001 * p.x + 0.002 * Math.sin(p.x * 7) * Math.sin((p.y + 0.13) * 6);
  const s = survey(ground);
  // The entered four-metre spacing is constrained to the existing one-metre
  // carriageway maximum; mild synthetic noise still triggers probe refinement.
  const result = await solveDrapedRoad(route(length), section, 4, s.sample);
  assert.ok(result.sampleCount > 500000, `fixture did not cross 500k samples: ${result.sampleCount}`);
  assert.equal(result.sampleCount, s.total);
  assert.equal(result.samplingBatches, s.calls);
  assert.ok(result.samplePartitions > 1);
  assert.ok(result.peakWorkingSamples <= 500000);
  assert.ok([...s.counts.values()].every(count => count <= 500000));
  assert.equal(result.budgetLimited, false);
  assert.ok(result.refinementLevels > 0);
  assert.ok(result.unresolvedTriangles > 0, 'unresolved surface protrusions must remain explicitly excluded');
  assert.ok(result.coveredArea > 0 && result.excludedArea > 0);
  near(result.planArea, length * section.width);
  near(result.coveredArea + result.excludedArea, result.planArea);
  near(result.sampleSpacing, 1);
  near(result.length, length);
  for (const p of result.vertices) near(p.formationHeight, ground(p));
  for (const face of result.triangles) {
    const points = face.map(i => result.vertices[i]);
    for (const weights of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
      const q = {
        x: points.reduce((sum, p, i) => sum + p.x * weights[i], 0),
        y: points.reduce((sum, p, i) => sum + p.y * weights[i], 0),
      };
      const bottom = points.reduce((sum, p, i) => sum + p.formationHeight * weights[i], 0);
      assert.ok(bottom + 1e-5 >= ground(q), 'a retained face crosses a measured terrain protrusion');
    }
  }
  context.diagnostic(JSON.stringify({ sampleCount: result.sampleCount, samplePartitions: result.samplePartitions, peakWorkingSamples: result.peakWorkingSamples, coveredArea: result.coveredArea, excludedArea: result.excludedArea, unresolvedTriangles: result.unresolvedTriangles }));
});
