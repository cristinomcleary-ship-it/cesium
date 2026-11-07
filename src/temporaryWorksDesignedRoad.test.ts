import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDesignedRoad, solveDesignedRoad, reverseDesignedRoadAlignment, designedRoadFootprints, designedRoadHeightAt } from './temporaryWorksDesignedRoad.ts';
import { packDesignedRoad, unpackDesignedRoad } from './temporaryWorksDesignedRoadTransfer.ts';
import { RoadRouteConflict } from './temporaryWorksRoadConflict.ts';
import type { PlanXY } from './temporaryWorksGeometry.ts';

const straight=[{x:0,y:0},{x:100,y:0}];
const section={width:7,hardeningDepth:.3,treatmentDepth:.2};
const flat={startHeight:100,gradesEnabled:false,grades:[]};
const close=(actual:number,expected:number,tolerance=1e-7)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} ≠ ${expected}`);
const ringArea=(r:readonly PlanXY[])=>Math.abs(r.reduce((s,p,i)=>s+p.x*r[(i+1)%r.length].y-r[(i+1)%r.length].x*p.y,0))/2;

test('manual road uses top datum and downward layers without a terrain sample or invented ground height',async()=>{
  const r=await solveDesignedRoad(straight,section,flat);
  close(r.planArea,700);close(r.endHeight,100);
  assert.equal(r.sampleCount,0);assert.equal(r.excludedArea,0);
  assert.ok(r.vertices.length<100);
  for(const p of r.vertices){close(p.surfaceHeight,100);close(p.baseHeight,99.7);close(p.formationHeight,99.5);assert.equal('groundHeight' in p,false);}
  assert.equal(r.footprintsXY.length,1);assert.equal(r.footprintsXY[0].outer.length,4);assert.equal(r.footprintsXY[0].holes.length,0);
  close(ringArea(r.footprintsXY[0].outer),700);
  close(r.hardeningVolume,210);close(r.treatmentVolume,140);
});

test('disabled malformed grade draft never validates or affects the active horizontal road',async()=>{
  const grades=[{start:77,end:1,gradePct:NaN}];
  const r=await calculateDesignedRoad(straight,section,{...flat,grades});
  assert.deepEqual(r.grades,[{start:0,end:100,gradePct:0}]);
  assert.deepEqual(r.gradeDraft,grades);assert.equal(r.endHeight,100);
  await assert.rejects(calculateDesignedRoad(straight,section,{...flat,gradesEnabled:true,grades}),/纵坡|里程/);
});

test('positive/negative/zero grades are continuous and every break is retained',async()=>{
  const grades=[{start:0,end:23,gradePct:2},{start:23,end:47,gradePct:-1},{start:47,end:100,gradePct:0}];
  const r=await calculateDesignedRoad(straight,section,{...flat,gradesEnabled:true,grades});
  close(r.endHeight,100.22);
  for(const s of [0,23,47,100]) {
    const match=r.vertices.filter(v=>Math.abs(v.roadStation-s)<1e-8);
    assert.ok(match.length>=3);
    for(const v of match)close(v.surfaceHeight,designedRoadHeightAt(s,100,grades));
  }
  for(const tri of r.triangles) {
    const stations=tri.map(i=>r.vertices[i].roadStation);
    for(const s of [23,47]) assert.ok(!(Math.min(...stations)<s-1e-8&&Math.max(...stations)>s+1e-8),'a face crosses a grade break');
  }
});

test('enabled grades reject gaps/overlaps and incomplete total chainage',async()=>{
  for(const grades of [[],[{start:1,end:100,gradePct:0}],[{start:0,end:90,gradePct:0}],
    [{start:0,end:40,gradePct:0},{start:39,end:100,gradePct:0}]])
    await assert.rejects(calculateDesignedRoad(straight,section,{...flat,gradesEnabled:true,grades}));
});

test('reversing alignment preserves physical heights and measured CAD arc length',async()=>{
  const points=[{x:0,y:0},{x:30,y:0},{x:70,y:0}],stationFactors=[1.1,1.2],length=81;
  const alignment={startHeight:123,gradesEnabled:true,grades:[{start:0,end:33,gradePct:2},{start:33,end:length,gradePct:-1}]};
  const fwd=await calculateDesignedRoad(points,{...section,stationFactors},alignment);
  const reverse=reverseDesignedRoadAlignment(length,alignment);
  const rev=await calculateDesignedRoad([...points].reverse(),{...section,stationFactors:[...stationFactors].reverse()},reverse);
  close(fwd.length,length);close(rev.length,length);close(reverse.startHeight,fwd.endHeight);close(rev.endHeight,alignment.startHeight);
  for(const v of rev.vertices)close(v.surfaceHeight,designedRoadHeightAt(length-v.roadStation,alignment.startHeight,alignment.grades));
  close(fwd.planArea,rev.planArea);
});

test('flat reverse preserves height and keeps inactive draft separate',()=>{
  const r=reverseDesignedRoadAlignment(100,{...flat,grades:[{start:0,end:40,gradePct:2},{start:40,end:100,gradePct:-1}]});
  assert.equal(r.startHeight,100);assert.equal(r.gradesEnabled,false);
  assert.deepEqual(r.grades,[{start:0,end:60,gradePct:1},{start:60,end:100,gradePct:-2}]);
});

test('bent CAD route footprint follows the true corridor rather than its bounding box',async()=>{
  const r=await calculateDesignedRoad([{x:0,y:0},{x:100,y:0},{x:100,y:100}],section,flat);
  close(r.planArea,1400);assert.equal(r.footprintsXY.length,1);
  assert.ok(r.footprintsXY[0].outer.length>4);
  close(ringArea(r.footprintsXY[0].outer),r.planArea);
  assert.ok(r.planArea<100*100);
});

test('tight hairpin preserves union area and rejects conflicting overlapped elevations',async()=>{
  const points=[{x:0,y:0},{x:100,y:0},{x:101,y:2},{x:0,y:4}];
  const flatRoad=await calculateDesignedRoad(points,section,flat);
  assert.equal(flatRoad.bendJoin,'round-union');assert.ok(flatRoad.planArea<flatRoad.length*7);
  const alignment={startHeight:100,gradesEnabled:true,grades:[{start:0,end:flatRoad.length,gradePct:2}]};
  await assert.rejects(calculateDesignedRoad(points,section,alignment),(e:unknown)=>e instanceof RoadRouteConflict&&e.kind==='levels');
});

test('topology extraction preserves an internal hole and omits internal mesh diagonals',()=>{
  const vertices=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10},{x:3,y:3},{x:7,y:3},{x:7,y:7},{x:3,y:7}];
  const r=designedRoadFootprints(vertices,[[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]);
  assert.equal(r.length,1);assert.equal(r[0].outer.length,4);assert.equal(r[0].holes.length,1);
  close(ringArea(r[0].outer)-ringArea(r[0].holes[0]),84);
});

test('a 200-point kilometre-scale route stays small without photography-dependent refinement',async()=>{
  const points=Array.from({length:200},(_,i)=>({x:1165.6165883894*i/199,y:2*Math.sin(i/15)}));
  const r=await calculateDesignedRoad(points,section,flat);
  assert.ok(r.length>1165&&r.length<1167);
  assert.ok(r.vertices.length<50_000);assert.ok(r.triangles.length<100_000);assert.equal(r.sampleCount,0);
  assert.equal(r.footprintsXY.length,1);
  assert.ok(r.footprintsXY[0].outer.length<1000);
});

test('multi-chunk 10km straight route has one four-corner clipping footprint without internal seams',async()=>{
  const r=await calculateDesignedRoad([{x:0,y:0},{x:10000,y:0}],section,flat);
  close(r.planArea,70000,1e-5);assert.equal(r.footprintsXY.length,1);assert.equal(r.footprintsXY[0].outer.length,4);
  assert.ok(r.vertices.length<5000);assert.equal(r.sampleCount,0);
});

test('invalid datum, slope sides and self-crossing CAD fail without a partial road',async()=>{
  await assert.rejects(calculateDesignedRoad(straight,section,{...flat,startHeight:NaN}),/顶设计标高/);
  await assert.rejects(calculateDesignedRoad(straight,{...section,slopeRatio:1},flat),/水平比/);
  await assert.rejects(calculateDesignedRoad(straight,{...section,width:0},flat));
  await assert.rejects(calculateDesignedRoad([{x:0,y:0},{x:20,y:20},{x:0,y:20},{x:20,y:0}],section,flat),RoadRouteConflict);
});

test('worker buffer roundtrip preserves layers, grade draft and actual footprint rings',async()=>{
  const r=await calculateDesignedRoad(straight,section,{...flat,gradesEnabled:true,grades:[{start:0,end:100,gradePct:1}]});
  const packed=packDesignedRoad(r);
  assert.ok(packed.vertices instanceof Float64Array);assert.ok(packed.triangles instanceof Uint32Array);
  assert.deepEqual(await unpackDesignedRoad(packed),r);
});

test('pre-aborted solver and result decoding reject before accepting a new road',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(solveDesignedRoad(straight,section,flat,{signal:controller.signal}),{name:'AbortError'});
  const r=await calculateDesignedRoad(straight,section,flat);
  await assert.rejects(unpackDesignedRoad(packDesignedRoad(r),controller.signal),{name:'AbortError'});
});

test('worker cancellation terminates immediately and late results cannot accept a cancelled road',async context=>{
  let terminated=0,sent=0,worker:PendingWorker|undefined;
  class PendingWorker {
    onmessage?: (event:{data:unknown})=>void;
    constructor(){worker=this;}
    postMessage(){sent++;}
    terminate(){terminated++;}
  }
  const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:PendingWorker});
  context.after(()=>{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');});
  const controller=new AbortController();
  const pending=solveDesignedRoad(straight,section,flat,{signal:controller.signal});
  assert.equal(sent,1);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(terminated,1);
  const late=packDesignedRoad(await calculateDesignedRoad(straight,section,flat));
  worker?.onmessage?.({data:late});
  assert.equal(terminated,1);
});

test('worker errors preserve typed conflict stations and clean up the worker',async context=>{
  let terminated=0;
  class ConflictWorker {
    onmessage?: (event:{data:unknown})=>void;
    postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:'error',message:'conflict',conflict:{kind:'levels',stations:[25,180]}}}));}
    terminate(){terminated++;}
  }
  const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:ConflictWorker});
  context.after(()=>{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');});
  await assert.rejects(solveDesignedRoad(straight,section,flat),(error:unknown)=>{
    assert.ok(error instanceof RoadRouteConflict);assert.equal(error.kind,'levels');assert.deepEqual(error.stations,[25,180]);return true;
  });
  assert.equal(terminated,1);
});

test('restricted browser fallback refuses a large route instead of blocking the viewer',async context=>{
  const oldWorker=Object.getOwnPropertyDescriptor(globalThis,'Worker'),oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:undefined});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{}});
  context.after(()=>{
    if(oldWorker)Object.defineProperty(globalThis,'Worker',oldWorker);else Reflect.deleteProperty(globalThis,'Worker');
    if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else Reflect.deleteProperty(globalThis,'document');
  });
  await assert.rejects(solveDesignedRoad([{x:0,y:0},{x:1000,y:0}],section,flat),/后台计算/);
  const short=await solveDesignedRoad(straight,section,flat);
  assert.equal(short.sampleCount,0);
});

// A valid conforming mesh can contain strips much thinner than a display pixel.
// Coordinate rounding must not weld their distinct vertices or discard faces.
test('footprints preserve exact topology across sub-micrometre valid strips',()=>{
  const xs=[0,1,1+2e-8,10];
  const vertices=xs.flatMap(x=>[{x,y:0},{x,y:1}]);
  const triangles:[number,number,number][]=[];
  for(let i=0;i<xs.length-1;i++) {
    const a=i*2,b=a+2;
    triangles.push([a,b,b+1],[a,b+1,a+1]);
  }
  const snapshot=structuredClone({vertices,triangles});
  const footprints=designedRoadFootprints(vertices,triangles);
  assert.equal(footprints.length,1);assert.equal(footprints[0].outer.length,4);
  close(ringArea(footprints[0].outer),10);assert.equal(footprints[0].holes.length,0);
  const preserved=designedRoadFootprints(vertices,triangles,true);
  assert.equal(preserved[0].outer.length,8);close(ringArea(preserved[0].outer),10);
  assert.deepEqual({vertices,triangles},snapshot);
});

test('exact footprint keys still reject repeated faces and non-manifold edges',()=>{
  const vertices=[{x:0,y:0},{x:1,y:0},{x:0,y:1}];
  assert.throws(()=>designedRoadFootprints(vertices,[[0,1,2],[0,1,2]]),/重复|非流形/);
});
