import assert from "node:assert/strict";
import test from "node:test";
import type { PlanXY } from "./temporaryWorksGeometry.ts";
import { roadStartDatum, solvePlanningRoad, type RoadParameters } from "./temporaryWorksRoad.ts";
import { packRoad, unpackRoad } from "./temporaryWorksRoadTransfer.ts";

const axis = [{x:0,y:0},{x:40,y:0}];
const design:RoadParameters = {
  width:4, hardeningDepth:.2, treatmentDepth:.3, slopeRatio:0,
  grades:[{start:0,end:12,gradePct:5},{start:12,end:24,gradePct:-2},{start:24,end:40,gradePct:3}],
};
const rise = (s:number) => .05*Math.min(12,s) - .02*Math.max(0,Math.min(s,24)-12) + .03*Math.max(0,s-24);
const near = (value:number, expected:number, tolerance=1e-8) =>
  assert.ok(Math.abs(value-expected) <= tolerance, `${value} differs from ${expected}`);

test("a direct zero-height K0 hit takes priority; a missing tail supplies no faces, material, or earthwork", async () => {
  const result = await solvePlanningRoad(axis,design,roadStartDatum(axis[0],0,.5),1,async (points,batch)=>{
    assert.notEqual(batch.phase,"datum");
    return points.map(p=>p.x<=24 ? 0 : null);
  });
  assert.equal(result.referenceSource,"start");
  assert.deepEqual(result.referencePoint,axis[0]);
  near(result.referenceHeight,0); near(result.referenceDistance,0); near(result.referenceStation,0);
  near(result.planArea,160); near(result.coveredArea,96); near(result.excludedArea,64);
  near(result.hardeningVolume,96*.2); near(result.treatmentVolume,96*.3);
  near(result.cutVolume,0);
  near(result.fillVolume,4*(12*.6/2 + 12*(.6+.36)/2));
  for (const v of result.vertices) {
    assert.ok(v.x<=24); near(v.roadStation,v.x); near(v.surfaceHeight,.5+rise(v.x));
  }
});

test("a K0 hole borrows an actual nearby height for the vertical datum only", async () => {
  const model = ({x,y}:PlanXY) => Math.hypot(x,y) >= .4 ? 100+2*x-y : null;
  const result = await solvePlanningRoad(axis,design,roadStartDatum(axis[0],NaN,.35),1,async ps=>ps.map(model));
  assert.equal(result.referenceSource,"nearby"); near(result.referenceStation,0);
  near(result.referenceDistance,Math.hypot(result.referencePoint.x,result.referencePoint.y));
  assert.ok(result.referenceDistance>=.4 && result.referenceDistance<=.5+1e-10);
  near(result.referenceHeight,model(result.referencePoint)!);
  assert.ok(result.excludedArea>0);
  assert.ok(result.triangles.length>0);
  for (const v of result.vertices) {
    assert.notEqual(model(v),null);
    near(v.groundHeight,model(v)!);
    near(v.surfaceHeight,result.referenceHeight+.35+rise(v.roadStation));
  }
});

test("entry from outside keeps original stations and design grades across a second coverage gap", async () => {
  const model = ({x}:PlanXY) => (x>=12 && x<=18) || (x>=24 && x<=32) ? 90+x/2 : null;
  const result = await solvePlanningRoad(axis,design,roadStartDatum(axis[0],null,.3),1,async ps=>ps.map(model));
  assert.equal(result.referenceSource,"entry"); near(result.length,40);
  near(result.referenceStation,12); near(result.referenceDistance,12);
  near(result.referencePoint.x,12); near(result.referencePoint.y,0); near(result.referenceHeight,96);
  assert.ok(result.coveredArea>50 && result.coveredArea<=56+1e-8);
  near(result.excludedArea,160-result.coveredArea);
  for (const v of result.vertices) {
    assert.notEqual(model(v),null); near(v.groundHeight,model(v)!); near(v.roadStation,v.x);
    near(v.surfaceHeight,96.3+rise(v.x)-rise(12));
  }
  assert.ok(result.vertices.some(p=>p.x>30));
  for (const triangle of result.triangles) {
    const xs=triangle.map(i=>result.vertices[i].x);
    assert.ok(xs.every(x=>x<=18) || xs.every(x=>x>=24));
  }
  const wire=structuredClone(packRoad(result));
  assert.deepEqual(await unpackRoad(wire),result);
});

test("reversing a line selects the first covered section in the new direction", async () => {
  const reversed = [...axis].reverse();
  const result = await solvePlanningRoad(reversed,design,roadStartDatum(reversed[0],undefined,-.1),1,
    async ps=>ps.map(p=>p.x>=16 && p.x<=28 ? 100+p.x/10 : null));
  assert.equal(result.referenceSource,"entry");
  near(result.referenceStation,12); near(result.referencePoint.x,28);
  near(result.referenceHeight,102.8); near(result.referenceDistance,12);
  for (const v of result.vertices) {
    near(v.roadStation,40-v.x);
    near(v.surfaceHeight,102.7+rise(v.roadStation)-rise(12));
  }
});

test("a road without a covered section fails with an actionable coverage message", async () => {
  await assert.rejects(
    solvePlanningRoad(axis,design,roadStartDatum(axis[0],null,.5),1,async ps=>ps.map(()=>null)),
    /覆盖|模型.*有效|有效.*模型/,
  );
});
