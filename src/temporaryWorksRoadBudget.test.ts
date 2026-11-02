import assert from "node:assert/strict";
import test from "node:test";
import type { PlanXY } from "./temporaryWorksGeometry.ts";
import { solvePlanningRoad, type RoadGradeRange, type RoadResult } from "./temporaryWorksRoad.ts";
import { RoadRouteConflict } from "./temporaryWorksRoadConflict.ts";

const section = {width:4, hardeningDepth:0.5, treatmentDepth:0.5, slopeRatio:1};
const near = (value:number, expected:number, tolerance:number) =>
  assert.ok(Math.abs(value-expected) <= tolerance, `${value} differs from ${expected} by more than ${tolerance}`);

/** Alternate tangent left/right R=1 m quarter curves. Source chainage uses CAD arc length,
 * while displayed circles contain the requested number of equal-angle chords. */
function alignment(turns:number, chords:number, straight:number) {
  let x=0, y=0, heading=0;
  const points:PlanXY[]=[{x,y}], stationFactors:number[]=[];
  const add = (factor:number) => { points.push({x,y}); stationFactors.push(factor); };
  for (let i=0; i<=turns; i++) {
    x+=straight*Math.cos(heading); y+=straight*Math.sin(heading); add(1);
    if (i===turns) break;
    const sign=i%2 ? -1 : 1, cx=x-sign*Math.sin(heading), cy=y+sign*Math.cos(heading);
    const step=sign*Math.PI/(2*chords), factor=(step/2)/Math.sin(step/2);
    for (let j=1; j<=chords; j++) {
      const angle=heading+j*step;
      x=cx+sign*Math.sin(angle); y=cy-sign*Math.cos(angle); add(factor);
    }
    heading+=sign*Math.PI/2;
  }
  return {points,stationFactors,length:(turns+1)*straight+turns*Math.PI/2};
}

function survey(read: (p:PlanXY)=>number|null = ()=>100) {
  const counts:number[]=[];
  return {counts, sample:async (points:readonly PlanXY[]) => {
    assert.ok(points.length<=512,`a single submission requested ${points.length} surface points`);
    counts.push(points.length);
    return points.map(read);
  }};
}

function checkMesh(r:RoadResult, spacing:number) {
  let area=0, maxEdge=0;
  for (const t of r.triangles) {
    const [a,b,c]=t.map(i=>r.vertices[i]);
    const twice=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    assert.ok(twice>0 && Number.isFinite(twice));
    area+=twice/2;
    maxEdge=Math.max(maxEdge, Math.hypot(a.x-b.x,a.y-b.y),Math.hypot(b.x-c.x,b.y-c.y),Math.hypot(c.x-a.x,c.y-a.y));
  }
  near(area,r.coveredArea,1e-5);
  near(r.coveredArea+r.excludedArea,r.planArea,1e-5);
  assert.ok(maxEdge<=spacing+1e-6,`spacing ${spacing} was silently coarsened to ${maxEdge}`);
}

/** Separate analytic oracle for the union rather than width times chainage. Each wide corner
 * adds a quarter disk of radius (1+h) and loses the overlap of two tangent rectangles. */
function unionArea(turns:number, straight:number, halfWidth:number) {
  return 2*halfWidth*(turns+1)*straight + turns*(Math.PI/4*(1+halfWidth)**2 - (halfWidth-1)**2);
}

// Each geometry below was run unchanged against 73a741b; every one hit
// “弯道网格超过采样预算，请简化密集图线或分段计算” before terrain sampling.
for (const [name,turns,chords,straight,spacing] of [
  ["8 successive tight turns",8,12,20,3],
  ["dense CAD curves",4,45,20,2],
  ["kilometre-long road with 12 bends",12,9,80,4],
] as const) {
  test(`budget regression: ${name} solves at the entered spacing with disjoint occupied area`, {timeout:30000}, async () => {
    const {points,stationFactors,length}=alignment(turns,chords,straight), s=survey();
    const r=await solvePlanningRoad(points,{...section,stationFactors,grades:[{start:0,end:length,gradePct:0}]},
      {reference:points[0],referenceHeight:100,finishedOffset:0},spacing,s.sample);
    const tolerance=0.04*turns; // angular tessellation of the CAD circle and its rounded outside
    near(r.planArea,unionArea(turns,straight,3),tolerance);
    near(r.pavementArea,unionArea(turns,straight,2),tolerance);
    near(r.length,length,1e-7);
    near(r.cutVolume,r.planArea,1e-5); near(r.fillVolume,0,1e-8); near(r.excludedArea,0,1e-6);
    assert.ok(s.counts.length>1);
    assert.ok(s.counts.reduce((total,n)=>total+n,0)<=100_000,"the modest field fixture exceeded 100k actual ray requests");
    checkMesh(r,spacing);
  });
}

test("batched dense curves keep grade breaks and reverse direction with partial surveyed coverage", {timeout:30000}, async () => {
  const {points,stationFactors,length}=alignment(4,45,20);
  const height=(p:PlanXY)=>p.x<60 && !(p.x>25 && p.x<30 && p.y>18) ? 100 : null;
  const grades:RoadGradeRange[]=[{start:0,end:40,gradePct:3},{start:40,end:60,gradePct:-2},{start:60,end:length,gradePct:.5}];
  const datum={reference:points[0],referenceHeight:100,finishedOffset:0};
  const fwd=await solvePlanningRoad(points,{...section,stationFactors,grades},datum,2,survey(height).sample);
  const rev=await solvePlanningRoad([...points].reverse(),{...section,stationFactors:[...stationFactors].reverse(),
    grades:[...grades].reverse().map(g=>({start:length-g.end,end:length-g.start,gradePct:-g.gradePct}))},datum,2,survey(height).sample);
  assert.ok(fwd.excludedArea>15 && fwd.coveredArea>300);
  assert.ok(fwd.cutVolume>10 && fwd.fillVolume>1);
  for (const v of fwd.vertices) assert.equal(height(v),100,"missing data must not become covered geometry");
  near(fwd.planArea,rev.planArea,1e-5); near(fwd.coveredArea,rev.coveredArea,0.02);
  near(fwd.cutVolume,rev.cutVolume,0.02); near(fwd.fillVolume,rev.fillVolume,0.02);
  for (const station of [40,60]) {
    const match=fwd.vertices.find(v=>Math.abs(v.roadStation-station)<1e-6 && Math.abs(v.roadOffset)<1e-6);
    assert.ok(match,`missing CAD grade break ${station}`);
    near(match.surfaceHeight,station===40?101.2:100.8,1e-6);
  }
  checkMesh(fwd,2); checkMesh(rev,2);
});

test("a 2 km route at 1 m spacing keeps a continuous road across the old 12000-point limit", {timeout:30000}, async () => {
  const points=[{x:0,y:0},{x:2000,y:0}], spacing=1, s=survey();
  const grades=[{start:0,end:1000,gradePct:.2},{start:1000,end:2000,gradePct:-.2}];
  const r=await solvePlanningRoad(points,{...section,grades},
    {reference:{x:1800,y:15},referenceHeight:100,finishedOffset:.4},spacing,s.sample);
  near(r.referenceStation,1800,1e-6);
  assert.ok(r.sampleCount>12000 && r.sampleCount<=100_000);
  near(r.planArea,12000,1e-5); near(r.pavementArea,8000,1e-5);
  // At stations 0, 500, 1000, 1500 and 2000, cut depths are +1, 0, −1, 0 and +1 m.
  near(r.cutVolume,3000,1e-5); near(r.fillVolume,3000,1e-5);
  checkMesh(r,spacing);

  // A shared edge must have two incident faces, even where section bands duplicate vertices
  // to shade the pavement and slope separately. A crack would add a spurious internal wall.
  const key=(p:PlanXY)=>`${Math.round(p.x*1e7)}:${Math.round(p.y*1e7)}`;
  const edges=new Map<string,{count:number,length:number}>();
  for (const tri of r.triangles) for(let i=0;i<3;i++) {
    const a=r.vertices[tri[i]], b=r.vertices[tri[(i+1)%3]];
    const ka=key(a), kb=key(b), edge=ka<kb?ka+"/"+kb:kb+"/"+ka;
    const seen=edges.get(edge);
    if (seen) seen.count++; else edges.set(edge,{count:1,length:Math.hypot(a.x-b.x,a.y-b.y)});
  }
  let perimeter=0;
  for (const {count,length} of edges.values()) {
    assert.ok(count===1 || count===2,"overlapping faces along a mesh edge");
    if (count===1) perimeter+=length;
  }
  near(perimeter,2*(2000+6),1e-5);
});

test("a long hairpin with overlapping arms is integrated once and detects an incompatible return grade", {timeout:30000}, async () => {
  // The two 350 m arms are only 4 m apart. No transverse cut along either arm
  // can separate it from the other without cutting their common 2 m wide base.
  const leg=350, radius=2, chords=36, halfStep=Math.PI/(2*chords);
  const arc=Array.from({length:chords+1}, (_,i)=>({
    x:leg+radius*Math.sin(2*halfStep*i), y:radius*(1-Math.cos(2*halfStep*i)),
  }));
  const points=[{x:0,y:0},...arc,{x:0,y:4}];
  const length=2*leg+Math.PI*radius, stationFactors=[1,...Array(chords).fill(halfStep/Math.sin(halfStep)),1];
  const run=(gradePct:number)=>solvePlanningRoad(points,{...section,stationFactors,grades:[{start:0,end:length,gradePct}]},
    {reference:points[0],referenceHeight:100,finishedOffset:0},1,survey().sample);
  const flat=await run(0);
  // Union is a single rectangle plus the half disk beyond the tangent point.
  near(flat.planArea,leg*10+25*Math.PI/2,.04); near(flat.pavementArea,leg*8+8*Math.PI,.04);
  near(flat.cutVolume,flat.planArea,1e-5); near(flat.fillVolume,0,1e-8);
  checkMesh(flat,1);
  await assert.rejects(run(1), e=>e instanceof RoadRouteConflict && e.kind==="levels" && e.stations[1]-e.stations[0]>20);
});
