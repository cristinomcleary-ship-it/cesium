import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlanningMesh } from './temporaryWorksGeometry.ts';

test('dense gently curved CAD follows its original section faces at the requested spacing', () => {
  const spacing = 2, width = 6;
  const points = Array.from({length:401}, (_, i) => ({x:560000 + i/2, y:3700000 + 3*Math.sin(i/30)}));
  const length = points.slice(1).reduce((sum,p,i) => sum + Math.hypot(p.x-points[i].x,p.y-points[i].y),0);
  const mesh = buildPlanningMesh({kind:'centerline',points,width,sectionOffsets:[-2.5,-2,2,2.5],stationBreaks:[50.125,135.15]},spacing);
  assert.equal(mesh.roadFrame!.bendJoin, undefined);
  assert.ok(mesh.points.length < 8000, 'unnecessary grid slivers around closely spaced CAD vertices');
  let area = 0;
  for (const t of mesh.triangles) {
    const [a,b,c] = t.map(i => mesh.points[i]);
    for (const [p,q] of [[a,b],[b,c],[c,a]]) assert.ok(Math.hypot(p.x-q.x,p.y-q.y) <= spacing + 1e-7);
    const signed = ((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;
    assert.ok(signed > 0);
    area += signed;
    for (const s of [50.125,135.15]) {
      const stations = t.map(i=>mesh.roadFrame!.coordinates[i].station);
      assert.ok(Math.min(...stations) >= s-1e-7 || Math.max(...stations) <= s+1e-7);
    }
  }
  assert.ok(Math.abs(mesh.planArea - length*width) < 1e-5);
  assert.ok(Math.abs(area-mesh.planArea) < 1e-5);
});

test('a distant return bend keeps its area and last chainage under projected-grid rotations and translations', async () => {
  const {solvePlanningRoad,roadLength} = await import('./temporaryWorksRoad.ts');
  const line = [{x:-1165,y:0},{x:-15,y:0}, ...Array.from({length:19}, (_,i) => ({
    x:2*Math.sin(i*Math.PI/18), y:2*(1-Math.cos(i*Math.PI/18)),
  })), {x:-15,y:4}];
  // The two 15 m return legs are 4 m apart, so their combined formation is 10 m across.
  const ideal = 1150*6 + 15*10 + Math.PI*25/2;
  let firstArea: number | undefined;
  for (const [angle, east, north] of [[0,0,0],[.345,0,0],[.345,564327.41,3769814.66],[.4,564327.41,3769814.66]]) {
    const points = line.map(p => ({x:east+p.x*Math.cos(angle)-p.y*Math.sin(angle), y:north+p.x*Math.sin(angle)+p.y*Math.cos(angle)}));
    const length = roadLength(points);
    const result = await solvePlanningRoad(points, {width:4, hardeningDepth:.4, treatmentDepth:.6, slopeRatio:1,
      grades:[{start:0,end:length,gradePct:0}]}, {reference:points[0],referenceHeight:100,finishedOffset:0},
    5, async batch => batch.map(()=>100));
    assert.ok(Math.abs(result.planArea-ideal)<.15, `projected-grid area ${result.planArea} vs ${ideal}`);
    firstArea ??= result.planArea;
    assert.ok(Math.abs(result.planArea-firstArea)<.01);
    assert.ok(result.vertices.some(p => Math.abs(p.roadStation-length)<1e-6 && Math.abs(p.roadOffset)<1e-6));
    assert.ok(Math.abs(result.coveredArea-result.planArea)<1e-4);
  }
});

test('a 4.5 km CAD with over 9000 real curve vertices retains its route and sampling density', async () => {
  const {solvePlanningRoad,roadLength} = await import('./temporaryWorksRoad.ts');
  const points = Array.from({length:9001}, (_,i) => ({x:i/2,y:2*Math.sin(i/60)}));
  const length = roadLength(points);
  let sampled = 0;
  const r = await solvePlanningRoad(points, {width:6,hardeningDepth:.2,treatmentDepth:.3,slopeRatio:1,
    grades:[{start:0,end:length,gradePct:0}]}, {reference:points[0],referenceHeight:100,finishedOffset:0}, 2,
  async batch=>{ assert.ok(batch.length<=512); sampled+=batch.length; return batch.map(()=>100); });
  assert.equal(sampled,r.sampleCount);
  assert.ok(Math.abs(r.planArea-length*7)<1e-5);
  assert.ok(Math.abs(r.pavementArea-length*6)<1e-5);
  assert.ok(Math.abs(r.cutVolume-r.coveredArea*.5)<1e-5);
  assert.ok(r.vertices.some(v=>Math.abs(v.roadStation-length)<1e-6 && Math.abs(v.roadOffset)<1e-6));
});
