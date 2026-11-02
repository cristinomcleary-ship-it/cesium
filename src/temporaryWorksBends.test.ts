import assert from "node:assert/strict";
import test from "node:test";
import { roadLength, solvePlanningRoad, type RoadGradeRange, type RoadResult } from "./temporaryWorksRoad.ts";
import type { PlanXY } from "./temporaryWorksGeometry.ts";
import { RoadRouteConflict } from "./temporaryWorksRoadConflict.ts";

const xy = (x: number, y: number): PlanXY => ({ x, y });
const section = { width: 4, hardeningDepth: 0.5, treatmentDepth: 0.5, slopeRatio: 1 };
const survey = async (points: readonly PlanXY[]) => points.map(() => 100);
const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);
const near = (actual: number, expected: number, delta = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= delta, `expected ${expected} ± ${delta}; got ${actual}`);

function run(line: PlanXY[], grades?: RoadGradeRange[], factors?: number[], reference = line[0], sample = survey) {
  return solvePlanningRoad(line, {
    ...section, stationFactors: factors, grades: grades ?? [{ start: 0, end: roadLength(line, factors), gradePct: 0 }],
  }, { reference, referenceHeight: 100, finishedOffset: 0 }, 2.5, sample);
}

function arc(radius: number, sweep: number, pieces: number) {
  return Array.from({length: pieces + 1}, (_, i) => {
    const angle = i * sweep / pieces;
    return xy(radius * Math.sin(angle), radius * (1 - Math.cos(angle)));
  });
}

/** Independent separating-axis test on actual emitted faces. Checking area totals alone can hide folds and holes of equal area. */
function assertNoDoubleCount(r: RoadResult) {
  const faces = r.triangles.map(t => {
    const p = t.map(i => r.vertices[i]);
    return { p, minX:Math.min(...p.map(v=>v.x)), maxX:Math.max(...p.map(v=>v.x)),
      minY:Math.min(...p.map(v=>v.y)), maxY:Math.max(...p.map(v=>v.y)) };
  }).sort((a,b) => a.minX-b.minX);
  const tolerance = 1e-8;
  function separates(p: PlanXY[], q: PlanXY[]) {
    for (let i=0; i<3; i++) {
      const a=p[i], b=p[(i+1)%3], len=Math.hypot(b.x-a.x,b.y-a.y);
      const signs=q.map(c => cross(a,b,c)/len);
      const opposite=cross(a,b,p[(i+2)%3]);
      if (opposite > 0 ? Math.max(...signs) <= tolerance : Math.min(...signs) >= -tolerance) return true;
    }
    return false;
  }
  let sum = 0;
  for (let i=0; i<faces.length; i++) {
    const f=faces[i], area=Math.abs(cross(f.p[0],f.p[1],f.p[2]))/2;
    assert.ok(area>0 && Number.isFinite(area));
    sum+=area;
    for (let j=i+1; j<faces.length && faces[j].minX < f.maxX-tolerance; j++) {
      const g=faces[j];
      if (g.minY >= f.maxY-tolerance || f.minY >= g.maxY-tolerance) continue;
      assert.ok(separates(f.p,g.p) || separates(g.p,f.p),
        `faces have positive-area overlap at ${f.p[0].x}, ${f.p[0].y}`);
    }
  }
  near(sum,r.coveredArea,1e-6);
}

function surfaceAt(r: RoadResult, point: PlanXY) {
  const matches: number[] = [];
  for (const t of r.triangles) {
    const [a,b,c] = t.map(i=>r.vertices[i]);
    const det=cross(a,b,c), u=cross(point,b,c)/det, v=cross(point,c,a)/det, w=1-u-v;
    if (Math.min(u,v,w) >= -1e-8) matches.push(u*a.surfaceHeight + v*b.surfaceHeight + w*c.surfaceHeight);
  }
  return matches;
}

function requireSurface(r:RoadResult,point:PlanXY) {
  const matches=surfaceAt(r,point);
  assert.ok(matches.length,`missing survey-supported surface at ${point.x}, ${point.y}`);
  return matches;
}

test("short CAD subdivisions on both sides of a 90° corner keep the sparse alignment and intersecting inner offsets are not counted twice", async () => {
  const sparse = [xy(0,0),xy(10,0),xy(10,10)];
  const dense = [xy(0,0),xy(9,0),xy(10,0),xy(10,1),xy(10,10)];
  const grades = [{start:0,end:9.7,gradePct:2},{start:9.7,end:20,gradePct:-1}];
  const control = await run(sparse,grades);
  const r = await run(dense,grades);
  near(r.length,20); near(r.planArea,120); near(r.coveredArea,120); near(r.pavementArea,80);
  near(r.hardeningVolume,45); near(r.treatmentVolume,55);
  near(r.cutVolume,control.cutVolume,1e-6); near(r.fillVolume,control.fillVolume,1e-6);
  for(const h of requireSurface(r,xy(9.7,0))) near(h,100.194,1e-6);
  assertNoDoubleCount(r);
});

test("formation wider than the tangent quarter-circle radius uses the occupied footprint and excludes unsurveyed ground", async () => {
  // Tangents 20 m and 19 m, R=1. The inner tangent rectangles overlap by (h−R)^2.
  // The quarter disk east/south of their ends has radius R+h. Flat end caps add no area.
  const line=[xy(0,0),...arc(1, Math.PI/2,18).map(p=>xy(20+p.x,p.y)),xy(21,20)];
  const exact = (half: number) => 2*half*39 - (half-1)**2 + Math.PI*(half+1)**2/4;
  const r=await run(line);
  near(r.planArea,exact(3),0.1); near(r.pavementArea,exact(2),0.1);
  near(r.cutVolume,r.coveredArea); near(r.fillVolume,0); near(r.coveredArea,r.planArea,1e-6);
  assertNoDoubleCount(r);
  const clipped=await run(line,undefined,undefined,line[0],async points=>points.map(p=>p.x<=10 ? 100 : NaN));
  assert.ok(clipped.coveredArea>50 && clipped.coveredArea<=60.000001);
  near(clipped.coveredArea+clipped.excludedArea,r.planArea,1e-6);
  assert.ok(clipped.vertices.every(v=>v.x<=10+1e-8)); assertNoDoubleCount(clipped);
});

test("tight consecutive opposite turns preserve model widths, arc chainage, grade change and reverse-direction quantities", async () => {
  const radius=2, pieces=12, curve=arc(radius,Math.PI/2,pieces);
  const line=[xy(-12,0),...curve,...[...curve].reverse().slice(1).map(p=>xy(4-p.x,4-p.y)),xy(16,4)];
  const chordFactor=(Math.PI/(4*pieces))/Math.sin(Math.PI/(4*pieces));
  const factors=[1,...Array<number>(2*pieces).fill(chordFactor),1];
  const length=24+2*Math.PI, breakpoint=12+Math.PI;
  const grades=[{start:0,end:breakpoint,gradePct:2},{start:breakpoint,end:length,gradePct:-1}];
  const r=await run(line,grades,factors);
  const back=await run([...line].reverse(),[...grades].reverse().map(g=>({start:length-g.end,end:length-g.start,gradePct:-g.gradePct})),[...factors].reverse(),line[0]);
  near(r.length,length); near(r.formationWidth,6); near(r.hardeningBottomWidth,5);
  // Independent vertical-slice union of all tangent rectangles and 0.5-degree exterior sectors.
  // The small tolerance allows a coarser chord tolerance for the rendered outside edge.
  near(r.planArea,181.30959,0.12); near(r.pavementArea,121.10639,0.12);
  near(back.planArea,r.planArea,1e-5); near(back.cutVolume,r.cutVolume,0.02);
  for(const h of requireSurface(r,xy(2,2))) near(h,100+breakpoint*0.02,0.003);
  for(const h of requireSurface(back,xy(2,2))) near(h,100+breakpoint*0.02,0.003);
  assertNoDoubleCount(r); assertNoDoubleCount(back);
});

test("a tight semicircular return covers the overlap of two parallel legs once", async () => {
  const line=[xy(-12,0),...arc(2,Math.PI,36),xy(-12,4)];
  // The 12 m-long straight part has 10 m total union width (6+6−2).
  // Beyond the tangency line the formation is a half disk of radius 2+3.
  const r=await run(line);
  near(r.planArea,120 + Math.PI*25/2,0.12);
  near(r.pavementArea,96 + Math.PI*16/2,0.12);
  near(r.coveredArea,r.planArea,1e-6); near(r.cutVolume,r.coveredArea);
  assertNoDoubleCount(r);
});

test("a sharp 155 degree deflection with distinct legs has a finite rounded outside instead of a miter spike", async () => {
  const turn=155*Math.PI/180, leg=30, h=3;
  const line=[xy(-leg,0),xy(0,0),xy(leg*Math.cos(turn),leg*Math.sin(turn))];
  const r=await run(line);
  // Two long tangent rectangles lose the inner overlapping wedge and gain the exterior circular sector.
  near(r.planArea,2*leg*2*h - h*h*Math.tan(turn/2) + h*h*turn/2,0.12);
  assert.ok(Math.max(...r.vertices.map(v=>v.x))<=h+1e-7); // the miter tip would lie several widths ahead
  assertNoDoubleCount(r);
});

test("a genuinely self-crossing graded alignment reports where its separate branches conflict", async () => {
  const line=[xy(0,0),xy(15,15),xy(0,15),xy(15,0)];
  await assert.rejects(run(line,[{start:0,end:roadLength(line),gradePct:10}]), error => {
    assert.ok(error instanceof RoadRouteConflict);
    assert.equal(error.kind,"crossing");
    const diagonal=15*Math.SQRT2;
    near(error.stations[0],diagonal/2); near(error.stations[1],15+1.5*diagonal);
    assert.match(error.message,/K0\+010\.607.*K0\+046\.820/);
    return true;
  });
});

test("two remote graded legs cannot silently share one ground footprint at different elevations", async () => {
  const line=[xy(-60,0),...arc(2,Math.PI,18),xy(-60,4)];
  const length=roadLength(line);
  // The second profile is level at both ends of the common reach. Its 15 cm
  // intermediate hump is still incompatible with its level return lane.
  const profiles = [[{start:0,end:length,gradePct:5}], [
    {start:0,end:40,gradePct:0},{start:40,end:43,gradePct:5},
    {start:43,end:46,gradePct:-5},{start:46,end:length,gradePct:0},
  ]];
  for (const grades of profiles) await assert.rejects(run(line,grades), error => {
    assert.ok(error instanceof RoadRouteConflict); assert.equal(error.kind,"levels");
    assert.ok(error.stations[1] - error.stations[0] > section.width);
    assert.ok(error.stations[0] >= 0 && error.stations[1] <= length);
    return true;
  });
});

test("a flat hooked return retains the interior hole and its staggered butt ends at every design width", async () => {
  const line=[xy(5,0),xy(30,0),xy(30,30),xy(0,30),xy(0,4),xy(20,4)];
  const length=roadLength(line);
  const r=await solvePlanningRoad(line,{...section,grades:[{start:0,end:length,gradePct:0}]},
    {reference:line[0],referenceHeight:100,finishedOffset:0},4,survey);
  // Four right-angle exterior sectors replace four miter corners. Two parallel arms
  // overlap for 15 m, by 2 m at formation depth and by zero at pavement level.
  const ideal=(h:number)=>2*h*length-4*h*h*(1-Math.PI/4)-15*Math.max(0,2*h-4);
  near(r.planArea,ideal(3),0.12); near(r.pavementArea,ideal(2),0.12);
  assert.equal(surfaceAt(r,xy(15,15)).length,0,"the enclosed ground must remain untouched");
  for(const h of requireSurface(r,xy(5.625,1.25))) near(h,100,0.01);
  for(const h of requireSurface(r,xy(20.6,2.7))) near(h,99.3,0.01);
  assertNoDoubleCount(r);
});
