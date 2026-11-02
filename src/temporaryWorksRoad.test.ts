import assert from "node:assert/strict";
import test from "node:test";
import { roadLength, roadStartDatum, solvePlanningRoad, validateRoadGrades, type RoadParameters } from "./temporaryWorksRoad.ts";
import type { PlanXY } from "./temporaryWorksGeometry.ts";

const xy = (x: number, y: number): PlanXY => ({x,y});
const near = (actual: number, expected: number, tol=1e-7) => assert.ok(Math.abs(actual-expected)<tol,`${actual} != ${expected}`);
const route = [xy(0,0),xy(20,0)];
const design: RoadParameters = { width:4, hardeningDepth:.5, treatmentDepth:.5, slopeRatio:1,
  grades:[{start:0,end:20,gradePct:0}] };
const zero = { reference:route[0], referenceHeight:100, finishedOffset:0 };
const flat = async (points: readonly PlanXY[]) => points.map(()=>100);

test("directed road start is zero and signed grade changes carry its pavement level through a bend", async () => {
  const line = [xy(0,0),xy(10,0),xy(10,10)];
  const grades = [{start:0,end:10,gradePct:2},{start:10,end:20,gradePct:-1}];
  const ground = (p: PlanXY) => 100 + 0.1*p.y;
  const sample = async (points: readonly PlanXY[]) => points.map(ground);
  const forward = await solvePlanningRoad(line,{...design,grades},
    roadStartDatum(line[0],ground(line[0]),0.35),2,sample);
  const reverse = [...line].reverse();
  // Ground at the other end is 1 m higher. Re-enter that endpoint's relative design
  // level to retain the physical alignment on reversal (100.45 - 101.00 = -0.55).
  const backward = await solvePlanningRoad(reverse,{...design,grades:[{start:0,end:10,gradePct:1},{start:10,end:20,gradePct:-2}]},
    roadStartDatum(reverse[0],ground(reverse[0]),-0.55),2,sample);
  for (const [result,expected] of [[forward,[100.35,100.55,100.45]], [backward,[100.45,100.55,100.35]]] as const) {
    assert.equal(result.referenceStation,0);
    for (const [i,s] of [0,10,20].entries()) {
      const vertex = result.vertices.find(v => Math.abs(v.roadStation-s)<1e-8 && Math.abs(v.roadOffset)<1e-8);
      assert.ok(vertex); near(vertex.surfaceHeight,expected[i]);
    }
  }
  near(forward.cutVolume,backward.cutVolume);
  near(forward.fillVolume,backward.fillVolume);
});

test("invalid numerical height and datum for the opposite direction are rejected", async () => {
  assert.throws(()=>roadStartDatum(route[0],Infinity,0));
  assert.equal(roadStartDatum(route[0],0,-.1).referenceHeight,0);
  const obsolete = roadStartDatum(route[0],100,0);
  await assert.rejects(solvePlanningRoad([...route].reverse(),design,obsolete,2,async()=>assert.fail('unexpected sampling')),/当前方向.*起点/);
});

test("structural trapezoid has three exact width breaks and is distinct from cut to full formation", async () => {
  const r = await solvePlanningRoad(route,design,zero,3,flat);
  near(r.length,20); near(r.planArea,120); near(r.coveredArea,120); near(r.pavementArea,80); near(r.slopeArea,40);
  near(r.hardeningBottomWidth,5); near(r.formationWidth,6);
  near(r.cutVolume,120); near(r.fillVolume,0); near(r.hardeningVolume,45); near(r.treatmentVolume,55);
  for (const [offset,top,base] of [[0,100,99.5],[2,100,99.5],[2.5,99.5,99.5],[3,99,99]]) {
    const v = r.vertices.find(v=>Math.abs(v.roadOffset-offset)<1e-8 && v.roadStation===0);
    assert.ok(v); near(v.surfaceHeight,top); near(v.baseHeight,base); near(v.formationHeight,99);
  }
  assert(r.triangles.every(t=>t.every(i=>r.vertices[i].roadPart===r.vertices[t[0]].roadPart)));
  for (const part of ["core","slope"]) {
    const entries = r.vertices.filter(p=>p.roadPart===part).map(p=>[p.x,p.y].join("/"));
    assert.equal(new Set(entries).size,entries.length);
  }
});

test("piecewise vertical alignment anchors at projected reference chainage and separates cut/fill through two grade breaks", async () => {
  const grades = [{start:0,end:6.7,gradePct:10},{start:6.7,end:13.5,gradePct:-10},{start:13.5,end:20,gradePct:0}];
  const p = {...design,grades};
  // Core formation crosses the horizontal ground as the first grade rises through station 3.
  const datum = {...zero,reference:xy(3,1),finishedOffset:1};
  const r = await solvePlanningRoad(route,p,datum,4,flat);
  near(r.referenceStation,3);
  const f = (s:number)=>s<6.7 ? (s-3)*.1 : s<13.5 ? .37-(s-6.7)*.1 : -.31;
  for(const v of r.vertices) near(v.formationHeight,100+f(v.roadStation),2e-9);
  for(const s of [6.7,13.5]) assert(r.vertices.some(v=>Math.abs(v.roadStation-s)<1e-8 && Math.abs(v.roadOffset)<1e-8));
  near(r.fillVolume,6*(.5*3.7*.37+.5*3.7*.37));
  near(r.cutVolume,6*(.5*3*.3+.5*3.1*.31+6.5*.31));
  const reverse = await solvePlanningRoad([...route].reverse(),{...p,grades:[...grades].reverse().map(g=>({start:20-g.end,end:20-g.start,gradePct:-g.gradePct}))},datum,4,flat);
  near(reverse.referenceStation,17); near(reverse.cutVolume,r.cutVolume); near(reverse.fillVolume,r.fillVolume);
  for (const v of reverse.vertices) near(v.formationHeight,100+f(20-v.roadStation));
});

test("arc/chord station factors drive physical length, reference station and grade terminal", async () => {
  const line = [xy(0,0),xy(3,0),xy(3,0),xy(3,4)];
  near(roadLength(line,[1,1,1.25]),8);
  const r = await solvePlanningRoad(line,{...design,width:.5,slopeRatio:0,stationFactors:[1,1,1.25],grades:[
    {start:0,end:4.01,gradePct:10},{start:4.01,end:8,gradePct:0}]}, {...zero,reference:xy(3,2)},2,flat);
  near(r.referenceStation,5.5); near(r.length,8);
  const start = r.vertices.find(p=>p.roadStation===0 && Math.abs(p.roadOffset)<1e-9); assert.ok(start);
  near(start.surfaceHeight,99.599);
  const split = r.vertices.find(p=>Math.abs(p.roadStation-4.01)<1e-10 && Math.abs(p.roadOffset)<1e-10);
  assert.ok(split); near(split.y,1.01/1.25);
  assert.throws(()=>roadLength(line,[1,2]),/不匹配/);
  assert.throws(()=>roadLength([xy(1,2),xy(1,2)]),/端点/);
});

test("vertical and zero-thickness cases conserve true layer volumes, use only surveyed triangles", async () => {
  const r = await solvePlanningRoad(route,{...design,slopeRatio:0},zero,2,flat);
  near(r.planArea,80); near(r.hardeningVolume,40); near(r.treatmentVolume,40); near(r.slopeArea,0);
  const partial=await solvePlanningRoad(route,{...design,hardeningDepth:0},zero,2,async ps=>ps.map(p=>p.x<=10 && p.y<=2 ? 100 : null));
  assert(partial.excludedArea>40); assert(partial.coveredArea>35); near(partial.hardeningVolume,0);
  near(partial.cutVolume,partial.coveredArea*.5);
  assert(partial.vertices.every(p=>p.x<=10 && p.y<=2));
  const empty=await solvePlanningRoad(route,design,zero,4,async ps=>ps.map(()=>null));
  near(empty.excludedArea,120); assert.equal(empty.triangles.length,0); assert.equal(empty.vertices.length,0);
});

test("range validation closes rounding to the actual route, rejects gaps, overlaps and false end stations", () => {
  const s=(start:number,end:number,gradePct=0)=>({start,end,gradePct});
  assert.deepEqual(validateRoadGrades([s(0,1.235),s(1.2349,3.568)],3.5676),[s(0,1.235),s(1.235,3.5676)]);
  for (const grades of [[s(0,2)], [s(0,1),s(1.1,3)], [s(0,2),s(1,3)], [s(0,3),s(3,3)], [s(0,3,NaN)], []]) {
    assert.throws(()=>validateRoadGrades(grades,3));
  }
  assert.throws(()=>roadLength([xy(0,0),xy(1,0),xy(0,0)]),/开放/);
});

test("grade break beside mitered bend does not fold the outer structural strip", async () => {
  const line = [xy(0,0),xy(10,0),xy(10,10)];
  const r = await solvePlanningRoad(line,{...design,grades:[{start:0,end:9.9,gradePct:2},{start:9.9,end:20,gradePct:-1}]},zero,2,flat);
  near(r.planArea,120); near(r.coveredArea,120); near(r.pavementArea,80);
  assert(r.vertices.some(v=>Math.abs(v.roadStation-9.9)<1e-9));
  for(const v of r.vertices) near(v.formationHeight,99+(v.roadStation<=9.9?v.roadStation*.02:.198-(v.roadStation-9.9)*.01));
});

test("an off-axis datum in a bend anchors the actual face across a grade break; outside falls back to measured chainage", async () => {
  const line = [xy(0,0),xy(10,0),xy(10,10)];
  const options = {...design,grades:[{start:0,end:9.3,gradePct:5},{start:9.3,end:20,gradePct:-10}]};
  const reference = xy(9,1.1);
  const r = await solvePlanningRoad(line,options,{...zero,reference},2,flat);
  // Nearest centerline segment projects to 11.1 m. The mitered face at this XY interpolates 10.1 m.
  near(r.referenceStation,10.1);
  const cross = (a:PlanXY,b:PlanXY,c:PlanXY) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  let located = false;
  for (const t of r.triangles) {
    const [a,b,c] = t.map(i=>r.vertices[i]); if (a.roadPart!=="core") continue;
    const det=cross(a,b,c), u=cross(reference,b,c)/det, v=cross(reference,c,a)/det, w=1-u-v;
    if (Math.min(u,v,w)<-1e-9) continue;
    near(u*a.surfaceHeight+v*b.surfaceHeight+w*c.surfaceHeight,100);
    located=true;
  }
  assert.ok(located);
  const external = await solvePlanningRoad(line,{...design,stationFactors:[1,1.25],
    grades:[{start:0,end:22.5,gradePct:5}]},{...zero,reference:xy(19,5)},2,flat);
  near(external.referenceStation,10+5*1.25);
});
