import test from "node:test";
import assert from "node:assert/strict";
import { solvePlanningRoad, roadLength } from "./temporaryWorksRoad";
import { checkRoadAxis, compactRoadTangents } from "./temporaryWorksRoadAxis";
import { RoadRouteConflict } from "./temporaryWorksRoadConflict";
const p=(x:number,y:number)=>({x,y});
const near = (a:number,b:number,tolerance=1e-7) => assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

test("crossing and touching centerline legs locate both directed CAD stations", () => {
  const line = [p(0,0),p(16,16),p(0,16),p(16,0)];
  const run=()=>checkRoadAxis(line,[1.2,1,1.1]);
  assert.throws(run,e=>{
    assert.ok(e instanceof RoadRouteConflict); assert.equal(e.kind,"crossing");
    near(e.stations[0],8*Math.SQRT2*1.2); near(e.stations[1],16*Math.SQRT2*1.2+16+8*Math.SQRT2*1.1);
    return true;
  });
  assert.throws(()=>checkRoadAxis([p(0,0),p(10,0),p(8,5),p(5,0),p(7,-5)],[1,1,1,1]),e=>e instanceof RoadRouteConflict && e.kind==="crossing");
});

test("true retraces locate the middle of the overlap instead of confusing an ordinary sharp turn with a return", () => {
  assert.throws(()=>checkRoadAxis([p(0,0),p(10,0),p(4,0)],[1,1]),e=>{
    assert.ok(e instanceof RoadRouteConflict); assert.equal(e.kind,"retrace"); near(e.stations[0],7); near(e.stations[1],13);
    return true;
  });
  checkRoadAxis([p(2,1),p(10,2),p(2,1.000001)],[1,1]);
  checkRoadAxis([p(0,0),p(10,0),p(10,4),p(0,4)],[1,1,1]);
});

test("extra CAD vertices along a straight tangent preserve the two widths, grade and clearance around a 90 degree corner", async () => {
  const line = [p(0,0),p(9,0),p(10,0),p(10,1),p(10,10)];
  const simple = [p(0,0),p(10,0),p(10,10)];
  assert.deepEqual(compactRoadTangents(line,[1,1,1,1]).points,simple);
  const nonuniform=compactRoadTangents(line,[1,1.25,1,1]);
  assert.equal(nonuniform.points.length,4);
  near(roadLength(nonuniform.points,nonuniform.stationFactors),20.25);
  const spec={width:4,hardeningDepth:.5,treatmentDepth:.5,slopeRatio:1,grades:[{start:0,end:9.75,gradePct:2},{start:9.75,end:20,gradePct:-3}]};
  const datum={reference:p(9,.9),referenceHeight:100,finishedOffset:.1};
  const solve=(points:typeof line) => solvePlanningRoad(points,spec,datum,2, async ps=>ps.map(()=>100));
  const a=await solve(line), b=await solve(simple);
  near(a.cutVolume,b.cutVolume); near(a.fillVolume,b.fillVolume); near(a.referenceStation,b.referenceStation);
  near(a.planArea,120); near(a.pavementArea,80);
  assert.deepEqual(a.vertices,b.vertices);
});
