import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningMesh, calculatePlanningEarthwork, refinePlanningCoverage, type PlanningMesh, type PlanningDesign, type PlanXY } from "./temporaryWorksGeometry.ts";

const xy = (x: number, y: number): PlanXY => ({ x, y });
const base: PlanningDesign = { reference: xy(0, 0), referenceHeight: 100, finishedOffset: 1, surfaceToTreatment: 0.4, treatmentDepth: 0.6 };
const close = (actual: number, expected: number, tol = 1e-8) => assert.ok(Math.abs(actual - expected) < tol, `${actual} should equal ${expected}`);
const square = [xy(0, 0), xy(10, 0), xy(10, 10), xy(0, 10)];
const triangle: PlanningMesh = { points: [xy(0, 0), xy(6, 0), xy(0, 1)], triangles: [[0, 1, 2]], spacing: 10, planArea: 3 };

test("concave footprint preserves translated survey area, spacing, winding and exact constant excavation", () => {
  const origin = xy(38500000, 3400000);
  const line = [xy(0, 0), xy(12, 0), xy(12, 4), xy(3, 4), xy(3, 9), xy(0, 9), xy(0, 0)].map(p => xy(p.x + origin.x, p.y + origin.y));
  const mesh = buildPlanningMesh({ kind: "boundary", points: line.reverse() }, 2);
  const r = calculatePlanningEarthwork(mesh, mesh.points.map(() => 103), { ...base, reference: origin });
  close(mesh.planArea, 63);
  close(r.coveredArea, 63, 2e-7);
  close(r.cutVolume, 189, 1e-6); close(r.fillVolume, 0);
  for (const triangle of mesh.triangles) {
    const [a, b, c] = triangle.map(i => mesh.points[i]);
    assert.ok((b.x - a.x) * (c.y - a.y) > (b.y - a.y) * (c.x - a.x));
    for (const [u, v] of [[a, b], [b, c], [c, a]]) assert.ok(Math.hypot(u.x - v.x, u.y - v.y) <= 2.000001);
    const center = xy((a.x + b.x + c.x) / 3 - origin.x, (a.y + b.y + c.y) / 3 - origin.y);
    assert.ok(center.x <= 3 || center.y <= 4, "nothing fills the re-entrant corner");
  }
});

test("cut and fill are split at the linear zero contour, including a sign change at a corner", () => {
  // Area=3. Positive patch with depths [1,-1,-1] occupies one quarter with mean 1/3.
  for (const [depths, cut, fill] of [
    [[1, -1, -1], 0.25, 1.25], [[-1, 1, 1], 1.25, 0.25], [[-1, 0, 1], 0.5, 0.5],
    [[-2, -1, 0], 0, 3], [[0, 0, 0], 0, 0], [[1, 1, 1], 3, 0],
  ] as const) {
    const r = calculatePlanningEarthwork(triangle, depths.map(h => 100 + h), base);
    close(r.cutVolume, cut); close(r.fillVolume, fill); close(r.excludedArea, 0);
  }
});

test("partial coverage, interior gaps and missing/invalid scene returns never become zero-height ground", () => {
  const mesh = buildPlanningMesh({ kind: "boundary", points: square }, 2);
  const ground = mesh.points.map(p => p.x <= 6 && (p.x < 2 || p.x > 4 || p.y < 2 || p.y > 4) ? 102 : null);
  const r = calculatePlanningEarthwork(mesh, ground, base);
  assert.ok(r.coveredArea > 30 && r.coveredArea < 60);
  close(r.coveredArea + r.excludedArea, 100); close(r.cutVolume, r.coveredArea * 2); close(r.fillVolume, 0);
  assert.ok(r.triangles.every(t => t.every(i => ground[i] !== null)));
  for (const invalid of [null, undefined, Number.NaN, Infinity]) {
    const empty = calculatePlanningEarthwork(triangle, [0, 0, invalid], base);
    close(empty.coveredArea, 0); close(empty.excludedArea, 3); close(empty.cutVolume + empty.fillVolume, 0);
    assert.equal(empty.triangles.length, 0);
  }
});

test("signed site slopes and additional treatment depth use the chosen XY origin and separate surfaces", () => {
  const d = { ...base, reference: xy(2, 3), gradeEastPct: 2, gradeNorthPct: -1, treatmentDepth: 0 };
  const r = calculatePlanningEarthwork(triangle, [102, 102, 102], d);
  for (const [i, p] of triangle.points.entries()) {
    const top = 101 + (p.x - 2) * .02 - (p.y - 3) * .01;
    close(r.finishedHeights[i], top); close(r.treatmentTopHeights[i], top - .4); close(r.formationHeights[i], top - .4);
  }
});

test("straight road is clipped to specified width and uses actual longitudinal and crowned section", () => {
  const centerline = [xy(0, 0), xy(24, 0)], mesh = buildPlanningMesh({ kind: "centerline", points: centerline, width: 6 }, 5);
  const d = { ...base, centerline, longitudinalPct: 4, crossfallPct: 2, reference: xy(6, -2) };
  const r = calculatePlanningEarthwork(mesh, mesh.points.map(() => 104), d);
  close(r.coveredArea, 144);
  const expectedLevel = (p: PlanXY) => 101 + (p.x - 6) * .04 - (Math.abs(p.y) - 2) * .02;
  mesh.points.forEach((p, i) => close(r.finishedHeights[i], expectedLevel(p)));
  close(r.cutVolume, (104 - (100 + (12 - 6) * .04 - (1.5 - 2) * .02)) * 144);
});

test("asymmetric CAD transverse profile follows signed offsets and preserves intermediate breaklines around road bends", () => {
  const line = [xy(0, 0), xy(20, 0), xy(20, 15)];
  const profile = [{ offset: -3, rise: -0.2 }, { offset: -1.5, rise: -0.05 }, { offset: 0, rise: 0 }, { offset: 3, rise: -0.3 }];
  const mesh = buildPlanningMesh({ points: line, kind: "centerline", width: 6, sectionOffsets: profile.map(p => p.offset) }, 5);
  const r = calculatePlanningEarthwork(mesh, mesh.points.map(() => 101), { ...base, reference: xy(0, 0), sectionProfile: profile, longitudinalPct: 1 });
  close(mesh.planArea, 210); close(r.coveredArea, mesh.planArea);
  for (const [p, expected] of [
    [xy(0, 1.5), 100.95], [xy(0, -3), 100.7], [xy(23, 15), 101.05], [xy(18.5, 15), 101.30], [xy(20, 15), 101.35],
  ] as const) {
    const id = mesh.points.findIndex(v => Math.hypot(v.x - p.x, v.y - p.y) < 1e-8);
    assert.ok(id >= 0); close(r.finishedHeights[id], expected);
  }
  assert.throws(() => calculatePlanningEarthwork(mesh, mesh.points.map(() => 101), { ...base, sectionProfile: profile.slice(1) }), /断面宽度/);
});

test("true crossings/retraces are rejected and a near-return with distinct legs is supported", () => {
  assert.throws(() => buildPlanningMesh({ kind: "boundary", points: [square[0], square[2], square[1], square[3]] }, 2), /自交|重叠/);
  const hook=buildPlanningMesh({ kind: "centerline", points: [xy(0,0), xy(10,0), xy(1,.1)], width: 4 }, 2);
  assert.ok(hook.planArea > 40 && hook.planArea < 60);
  assert.throws(() => buildPlanningMesh({kind:"centerline",points:[xy(0,0),xy(10,0),xy(1,0)],width:4},2), /同一路径重叠/);
  assert.throws(() => buildPlanningMesh({kind:"centerline",points:[xy(0,0),xy(4,4),xy(0,4),xy(4,0)],width:2},2), /中心线.*相交/);
  assert.throws(() => buildPlanningMesh({ kind: "boundary", points: square }, .001, 100), /采样点/);
  assert.throws(() => buildPlanningMesh({ kind: "boundary", points: square }, 0), /间距/);
  assert.throws(() => buildPlanningMesh({ kind: "centerline", points: square.slice(0, 2), width: NaN }, 2), /宽度/);
  assert.throws(() => calculatePlanningEarthwork(triangle, [3, 3], base), /不匹配/);
  assert.throws(() => calculatePlanningEarthwork(triangle, [3, 3, 3], { ...base, treatmentDepth: -1 }), /厚度/);
});

test("boundary refinement adds two batched surveys and converges toward the measured coverage edge without extrapolating", async () => {
  const mesh = buildPlanningMesh({ kind: "centerline", points: [xy(0,0),xy(20,0)], width: 6 }, 6);
  const surface = (p: PlanXY) => p.x <= 12 ? 103 : null, ground = mesh.points.map(surface), original = structuredClone(mesh);
  const coarse = calculatePlanningEarthwork(mesh, ground, base);
  let calls = 0;
  const fine = await refinePlanningCoverage(mesh, ground, async points => { calls++; return points.map(surface); });
  assert.equal(calls, 2); assert.equal(fine.levels, 2); assert.equal(fine.budgetLimited, false);
  assert.deepEqual(mesh, original); assert.equal(fine.mesh.roadFrame!.coordinates.length, fine.mesh.points.length);
  const r = calculatePlanningEarthwork(fine.mesh, fine.ground, base);
  assert.ok(r.coveredArea > coarse.coveredArea && r.coveredArea <= 12 * 6);
  close(r.cutVolume, r.coveredArea * 3);
  const full = calculatePlanningEarthwork(fine.mesh, fine.ground.map(() => 103), base);
  close(full.coveredArea, 120); close(full.cutVolume, 360);
  // At a constrained budget a complete previous level is returned, unaffected by face iteration order.
  const limited = await refinePlanningCoverage(mesh, ground, async () => assert.fail(), 2, mesh.points.length);
  assert.equal(limited.levels, 0); assert.equal(limited.budgetLimited, true); assert.deepEqual(limited.mesh, mesh);
  for (const stable of [null, 102]) {
    const unchanged = await refinePlanningCoverage(mesh, ground.map(() => stable), async () => assert.fail());
    assert.equal(unchanged.levels, 0); assert.equal(unchanged.budgetLimited, false);
  }
});

test("a kilometre-long access road at 5 m spacing fits the field sampling budget", () => {
  const mesh = buildPlanningMesh({ kind: "centerline", points: [xy(0,0),xy(1000,0)], width: 6 }, 5);
  assert.ok(mesh.points.length < 4000);
  const r = calculatePlanningEarthwork(mesh, mesh.points.map(() => 102), base);
  close(r.coveredArea, 6000); close(r.cutVolume, 12000);
});
