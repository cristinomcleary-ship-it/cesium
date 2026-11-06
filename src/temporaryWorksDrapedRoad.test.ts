import assert from 'node:assert/strict';
import test from 'node:test';
import { solveDrapedRoad, type DrapedRoadResult } from './temporaryWorksDrapedRoad.ts';
import type { PlanXY } from './temporaryWorksGeometry.ts';

const xy=(x:number,y:number):PlanXY=>({x,y});
const section={width:4,hardeningDepth:.2,treatmentDepth:.4};
const line=[xy(0,0),xy(10,0)];
const near=(a:number,b:number,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
const cross=(a:PlanXY,b:PlanXY,c:PlanXY)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);

function noOverlaps(r:DrapedRoadResult) {
  const faces=r.triangles.map(t=>t.map(i=>r.vertices[i]));
  function separated(p:PlanXY[],q:PlanXY[]) {
    return p.some((a,i)=>{
      const b=p[(i+1)%3],sign=cross(a,b,p[(i+2)%3]);
      return sign>0?q.every(c=>cross(a,b,c)<=1e-8):q.every(c=>cross(a,b,c)>=-1e-8);
    });
  }
  let area=0;
  for(let i=0;i<faces.length;i++) {
    const p=faces[i];area+=Math.abs(cross(p[0],p[1],p[2]))/2;
    for(let j=i+1;j<faces.length;j++) assert.ok(separated(p,faces[j])||separated(faces[j],p),'positive-area overlapping triangles');
  }
  near(area,r.coveredArea);
}

test('draped road uses exact measured bottom and two positive structural layers on both longitudinal and transverse slopes',async()=>{
  const ground=(p:PlanXY)=>30+.03*p.x+.07*p.y;
  const r=await solveDrapedRoad(line,section,2,async ps=>ps.map(ground));
  near(r.length,10);near(r.coveredArea,40);near(r.excludedArea,0);
  near(r.hardeningVolume,8);near(r.treatmentVolume,16);
  near(r.sampleSpacing,1);assert.equal(r.surfaceMode,'draped');
  assert.ok(!('cutVolume' in r));assert.ok(!('fillVolume' in r));
  assert.ok(r.vertices.some(v=>v.roadOffset>1.9));assert.ok(r.vertices.some(v=>v.roadOffset< -1.9));
  for(const v of r.vertices) {
    near(v.formationHeight,ground(v));near(v.groundHeight,ground(v));
    near(v.baseHeight-v.formationHeight,.4);near(v.surfaceHeight-v.baseHeight,.2);
    near(v.roadStation,v.x);assert.equal(v.roadPart,'core');
  }
  noOverlaps(r);
});

test('right-angle bend is a continuous non-overlapping sampled layer and preserves CAD endpoint chainage',async()=>{
  const r=await solveDrapedRoad([xy(0,0),xy(8,0),xy(8,8)],section,1,async ps=>ps.map(p=>50+.01*p.x));
  near(r.length,16);near(r.planArea,64);near(r.coveredArea,64);noOverlaps(r);
  assert.ok(r.vertices.some(v=>Math.abs(v.roadStation-8)<1e-8));
  assert.ok(r.vertices.some(v=>Math.abs(v.roadStation-16)<1e-8&&Math.abs(v.roadOffset)<1e-8));
  const uses=new Map<string,number>();
  for(const t of r.triangles) for(let i=0;i<3;i++) {
    const ids=[t[i],t[(i+1)%3]].sort((a,b)=>a-b).join('/');uses.set(ids,(uses.get(ids)??0)+1);
  }
  assert.ok([...uses.values()].every(n=>n===1||n===2));
});

test('acute 155-degree bend uses the existing rounded union without spikes or duplicate road coverage',async()=>{
  const angle=155*Math.PI/180;
  const r=await solveDrapedRoad([xy(-10,0),xy(0,0),xy(10*Math.cos(angle),10*Math.sin(angle))],
    {...section,width:2},1,async ps=>ps.map(()=>5));
  assert.equal(r.bendJoin,'round-union');near(r.coveredArea,r.planArea);noOverlaps(r);
  assert.ok(r.vertices.every(v=>v.x<=1+1e-7));
});

test('missing start, tail and interior photogrammetry holes never receive invented elevations',async()=>{
  const ground=(p:PlanXY)=>p.x>=2&&p.x<=8&&!(p.x>4.2&&p.x<5.6)?10+.02*p.y:null;
  const r=await solveDrapedRoad(line,section,1,async ps=>ps.map(ground));
  assert.ok(r.excludedArea>0);assert.ok(r.coveredArea>0);assert.ok(r.missingTriangles>0);
  for(const v of r.vertices) {assert.notEqual(ground(v),null);near(v.formationHeight,ground(v)!);}
  for(const t of r.triangles) {
    const p=t.map(i=>r.vertices[i]);
    const centroid={x:p.reduce((s,v)=>s+v.x,0)/3,y:p.reduce((s,v)=>s+v.y,0)/3};
    assert.notEqual(ground(centroid),null);
    assert.ok(p.every(v=>v.x<=4.2)||p.every(v=>v.x>=5.6));
  }
  near(r.coveredArea+r.excludedArea,r.planArea);
});

test('an interior probe detects a small hole even where all original face vertices had measurements',async()=>{
  const full=await solveDrapedRoad(line,section,1,async ps=>ps.map(()=>0));
  const t=full.triangles[Math.floor(full.triangles.length/2)].map(i=>full.vertices[i]);
  const centre={x:t.reduce((s,p)=>s+p.x,0)/3,y:t.reduce((s,p)=>s+p.y,0)/3};
  const r=await solveDrapedRoad(line,section,1,async ps=>ps.map(p=>Math.hypot(p.x-centre.x,p.y-centre.y)<.05?null:0));
  assert.ok(r.coveredArea<full.coveredArea);assert.ok(r.missingTriangles>0);
});

test('vertical photogrammetry step is an explicit gap instead of a bridge through the cliff',async()=>{
  const ground=(p:PlanXY)=>p.x<5.2?0:3;
  const r=await solveDrapedRoad(line,section,1,async ps=>ps.map(ground));
  assert.ok(r.steepTriangles>0);assert.ok(r.excludedArea>0);
  assert.ok(r.vertices.some(v=>v.formationHeight===0));assert.ok(r.vertices.some(v=>v.formationHeight===3));
  for(const face of r.triangles) {
    const heights=face.map(i=>r.vertices[i].formationHeight);
    assert.equal(new Set(heights).size,1,'face must not span the discontinuity');
  }
});

test('detected ground protrusions are refined or excluded; no sampled height offset is used to conceal penetration',async()=>{
  const ground=(p:PlanXY)=>.15*Math.max(0,1-Math.abs(p.x-5.2)/.3);
  const r=await solveDrapedRoad(line,section,1,async ps=>ps.map(ground));
  assert.ok(r.refinementLevels>0);assert.ok(r.unresolvedTriangles>0);
  for(const v of r.vertices) near(v.formationHeight,ground(v));
  for(const face of r.triangles) {
    const p=face.map(i=>r.vertices[i]);
    for(const weights of [[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5]]) {
      const q={x:p.reduce((s,v,i)=>s+v.x*weights[i],0),y:p.reduce((s,v,i)=>s+v.y*weights[i],0)};
      const bottom=p.reduce((s,v,i)=>s+v.formationHeight*weights[i],0);
      assert.ok(bottom+1e-5>=ground(q),'sampled terrain protrudes through bottom');
    }
  }
});

test('CAD arc factors, segment breaks and reverse direction keep full original mileage independently of missing surface',async()=>{
  const points=[xy(0,0),xy(3,0),xy(3,4)],factors=[1,1.25];
  const params={...section,width:.5,stationFactors:factors,stationBreaks:[4.01]};
  const r=await solveDrapedRoad(points,params,1,async ps=>ps.map(p=>p.y<1?null:0));
  near(r.length,8);assert.ok(r.vertices.some(v=>Math.abs(v.roadStation-4.01)<1e-7));
  const back=await solveDrapedRoad([...points].reverse(),{...params,stationFactors:[...factors].reverse(),stationBreaks:[3.99]},1,async ps=>ps.map(()=>0));
  near(back.length,8);assert.ok(back.vertices.some(v=>Math.abs(v.roadStation-3.99)<1e-7));
});

test('zero thickness is retained without negative volumes and a fully missing model returns an explicit empty result',async()=>{
  const zero=await solveDrapedRoad(line,{...section,hardeningDepth:0,treatmentDepth:0},1,async ps=>ps.map(()=>0));
  near(zero.hardeningVolume,0);near(zero.treatmentVolume,0);
  assert.ok(zero.vertices.every(v=>v.formationHeight===v.surfaceHeight&&v.baseHeight===v.surfaceHeight));
  const empty=await solveDrapedRoad(line,section,1,async ps=>ps.map(()=>null));
  assert.equal(empty.vertices.length,0);assert.equal(empty.triangles.length,0);near(empty.excludedArea,40);
});

test('invalid, incomplete, unbounded or cancelled surveys fail with actionable errors',async()=>{
  await assert.rejects(solveDrapedRoad(line,{...section,width:-1},1,async()=>[]),/路宽/);
  await assert.rejects(solveDrapedRoad(line,section,1,async()=>[]),/数量/);
  await assert.rejects(solveDrapedRoad(line,section,1,async ps=>ps.map(()=>Infinity)),/无效高程/);
  await assert.rejects(solveDrapedRoad(line,{...section,maxSamples:20},1,async ps=>ps.map(()=>0)),/超过/);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(solveDrapedRoad(line,section,1,async()=>assert.fail('must not sample'),{signal:aborted.signal}),{name:'AbortError'});
  const mid=new AbortController();
  await assert.rejects(solveDrapedRoad(line,section,1,async ps=>{mid.abort();return ps.map(()=>0);},{signal:mid.signal}),{name:'AbortError'});
});
