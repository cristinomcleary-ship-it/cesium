import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateHardening, hardeningHeightAt, HARDENING_LIMITS, packHardening, solveHardening,
  type HardeningBlocker, type HardeningFootprint, type HardeningParameters, type HardeningPlane,
  type HardeningResult, type HardeningSurfaceVertex } from './temporaryWorksHardening';

const plane:HardeningPlane={reference:{x:0,y:0},height:100};
const rectangle=(x:number,y:number,width:number,height=width):HardeningFootprint=>({outer:[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}]});
const parameters=(patch:Partial<HardeningParameters>={}):HardeningParameters=>({footprints:[rectangle(0,0,10)],plane,thickness:.3,...patch});
const blocker=(id:string,footprint:HardeningFootprint,patch:Partial<HardeningBlocker>={}):HardeningBlocker=>({id,footprints:[footprint],plane,thickness:.3,...patch});
const near=(a:number,b:number,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
function topology(result:HardeningResult) {
  let area=0;
  const faces=new Set<string>();
  for(const [a,b,c] of result.triangles) {
    const [u,v,w]=[a,b,c].map(i=>result.vertices[i]);
    const twice=(v.x-u.x)*(w.y-u.y)-(v.y-u.y)*(w.x-u.x);
    assert.ok(twice>0,'faces must be nondegenerate and consistently oriented');area+=twice/2;
    const key=[u,v,w].map(p=>`${p.x}/${p.y}`).sort().join('|');
    assert.ok(!faces.has(key),'no duplicate surface faces');faces.add(key);
  }
  near(area,result.visibleArea);
  for(const edge of result.sideEdges) {
    assert.ok(edge.a.surfaceHeight>=edge.a.baseHeight && edge.b.surfaceHeight>=edge.b.baseHeight);
  }
}

test('horizontal hardening has a required top datum and a downward slab, independent of selected area',()=>{
  for(const size of [10,1000]) {
    const result=calculateHardening(parameters({footprints:[rectangle(0,0,size)]}));
    near(result.visibleArea,size*size);assert.equal(result.vertices.length,4);assert.equal(result.triangles.length,2);
    assert.equal(result.sampleCount,0);assert.equal(result.canSave,true);
    for(const p of result.vertices) {near(p.surfaceHeight,100);near(p.baseHeight,99.7);near(p.formationHeight,99.7);}
    topology(result);
  }
  assert.throws(()=>calculateHardening(parameters({plane:{...plane,height:NaN}})),/顶标高/);
  assert.throws(()=>calculateHardening(parameters({thickness:0})),/厚度/);
});

test('slope uses its persisted reference, not the changing footprint centroid',()=>{
  const grade:HardeningPlane={reference:{x:4,y:-2},height:101,gradeEastPct:2,gradeNorthPct:-1};
  const first=calculateHardening(parameters({plane:grade})),second=calculateHardening(parameters({plane:grade,footprints:[rectangle(0,0,20)]}));
  for(const result of [first,second]) for(const p of result.vertices) near(p.surfaceHeight,101+(p.x-4)*.02-(p.y+2)*.01);
  near(first.vertices.find(p=>p.x===0&&p.y===0)!.surfaceHeight,second.vertices.find(p=>p.x===0&&p.y===0)!.surfaceHeight);
});

test('concave perimeter and permanent holes survive triangulation and a crossing road',()=>{
  const outer=[{x:0,y:0},{x:20,y:0},{x:20,y:20},{x:10,y:20},{x:10,y:10},{x:0,y:10}];
  const hole=rectangle(12,12,4).outer;
  const input=parameters({footprints:[{outer,holes:[hole]}],blockers:[blocker('road',rectangle(2,-2,3,20))]});
  const snapshot=structuredClone(input),result=calculateHardening(input);
  near(result.sourceArea,284);near(result.visibleArea,254);near(result.excludedArea,30);
  assert.ok(result.footprints.some(f=>f.holes?.length===1));
  assert.deepEqual(input,snapshot,'source boundaries and holes must not be overwritten by derived difference');topology(result);
});

test('contained occupancy creates a hole; completely occupied hardening remains an empty derived result',()=>{
  const result=calculateHardening(parameters({blockers:[blocker('facility',rectangle(2,2,6))]}));
  near(result.visibleArea,64);assert.equal(result.footprints.length,1);assert.equal(result.footprints[0].holes?.length,1);topology(result);
  const hidden=calculateHardening(parameters({blockers:[blocker('facility',rectangle(-1,-1,12))]}));
  assert.equal(hidden.visibleArea,0);assert.deepEqual(hidden.vertices,[]);assert.deepEqual(hidden.triangles,[]);
  assert.deepEqual(hidden.footprints,[]);assert.deepEqual(hidden.sideEdges,[]);assert.equal(hidden.canSave,true);
});

test('three-way overlap is subtracted once and is independent of occupant arrival order',()=>{
  const blockers=[blocker('road',rectangle(0,0,6,10)),blocker('camp',rectangle(4,0,4,10)),blocker('older-hardening',rectangle(7,5,3,5))];
  const first=calculateHardening(parameters({blockers})),second=calculateHardening(parameters({blockers:[...blockers].reverse()}));
  near(first.visibleArea,10);near(first.excludedArea,90);near(second.visibleArea,first.visibleArea);
  assert.deepEqual(first.footprints,second.footprints);topology(first);topology(second);
});

test('hidden or unready occupants release coverage; a visible occupant still excludes even without photography clipping',()=>{
  const full=blocker('road',rectangle(-1,-1,12));
  assert.equal(calculateHardening(parameters({blockers:[full]})).visibleArea,0);
  assert.equal(calculateHardening(parameters({blockers:[{...full,visible:false}]})).visibleArea,100);
  assert.equal(calculateHardening(parameters({blockers:[{...full,ready:false}]})).visibleArea,100);
  // Clipping is deliberately absent from occupancy inputs: turning it off must not cause duplicate concrete.
  assert.equal(calculateHardening(parameters({blockers:[{...full,visible:true,ready:true}]})).visibleArea,0);
});

test('different plane levels require an explicit acknowledgement and remain reported after acknowledgement',()=>{
  const raised=blocker('road',rectangle(2,2,4),{plane:{...plane,height:100.2}});
  const unresolved=calculateHardening(parameters({blockers:[raised]}));
  assert.equal(unresolved.canSave,false);near(unresolved.conflicts[0].maxDifference!,.2);
  const accepted=calculateHardening(parameters({blockers:[raised],acceptedHeightDifferences:['road']}));
  assert.equal(accepted.canSave,true);assert.equal(accepted.conflicts.length,1);assert.equal(accepted.conflicts[0].accepted,true);
  assert.equal(raised.plane!.height,100.2,'the existing road height is never changed');
});

test('unknown levels cannot be accepted through the ordinary high-difference checkbox',()=>{
  const unknown=blocker('camp',rectangle(2,2,4),{plane:undefined,thickness:undefined});
  const result=calculateHardening(parameters({blockers:[unknown],acceptedHeightDifferences:['camp']}));
  assert.equal(result.canSave,false);assert.equal(result.conflicts[0].kind,'unknown-height');assert.equal(result.conflicts[0].accepted,false);
});

test('footprint-only occupancy excludes buildings without asserting a floor level or removing slab side walls',()=>{
  const occupied:HardeningBlocker={id:'camp',kind:'facility',footprints:[rectangle(2,2,4)],footprintOnly:true};
  const result=calculateHardening(parameters({blockers:[occupied]}));
  near(result.visibleArea,84);assert.equal(result.canSave,true);assert.deepEqual(result.conflicts,[]);
  assert.equal(result.sideEdges.length,8,'unknown building structure cannot erase concrete slab side walls');
  for(const edge of result.sideEdges){near(edge.a.surfaceHeight,100);near(edge.a.baseHeight,99.7);}
  topology(result);
  const adjacent={...occupied,footprints:[rectangle(10,0,10)]};
  assert.equal(calculateHardening(parameters({blockers:[adjacent]})).sideEdges.length,4);
});

test('a sloped occupant is checked across its overlap, not at a matching centre level',()=>{
  const result=calculateHardening(parameters({blockers:[blocker('road',rectangle(0,0,10),{plane:{reference:{x:5,y:5},height:100,gradeEastPct:2}})]}));
  assert.equal(result.canSave,false);near(result.conflicts[0].maxDifference!,.1);
});

function raisedCentre():HardeningBlocker {
  const vertices:HardeningSurfaceVertex[]=[{x:2,y:2,surfaceHeight:100},{x:8,y:2,surfaceHeight:100},
    {x:8,y:8,surfaceHeight:100},{x:2,y:8,surfaceHeight:100},{x:5,y:5,surfaceHeight:101}];
  return blocker('road',rectangle(2,2,6),{plane:undefined,surface:{vertices,triangles:[[0,1,4],[1,2,4],[2,3,4],[3,0,4]]}});
}
test('piecewise road interior grade breaks are checked even when all perimeter levels agree',()=>{
  const result=calculateHardening(parameters({blockers:[raisedCentre()]}));
  assert.equal(result.canSave,false);near(result.conflicts[0].maxDifference!,1);
});

test('missing design surface coverage is reported as unknown rather than inventing a level',()=>{
  const road=raisedCentre();road.surface={...road.surface!,triangles:[[0,1,4]]};
  const result=calculateHardening(parameters({blockers:[road]}));
  assert.equal(result.canSave,false);assert.equal(result.conflicts[0].kind,'unknown-height');
});

test('boundary-only contact catches a piecewise height peak on the shared edge',()=>{
  const road=blocker('road',rectangle(10,0,5,10),{plane:undefined,surface:{vertices:[
    {x:10,y:0,surfaceHeight:100},{x:15,y:0,surfaceHeight:100},{x:10,y:5,surfaceHeight:101},
    {x:15,y:5,surfaceHeight:101},{x:10,y:10,surfaceHeight:100},{x:15,y:10,surfaceHeight:100}],
    triangles:[[0,1,2],[1,3,2],[2,3,4],[3,5,4]]}});
  const result=calculateHardening(parameters({blockers:[road]}));
  near(result.visibleArea,100);assert.equal(result.canSave,false);near(result.conflicts[0].maxDifference!,1);
  assert.ok(result.sideEdges.some(e=>e.a.x===10&&e.b.x===10&&e.a.y<=5&&e.b.y>=5),'nonoverlapping vertical intervals must remain visible');
});

test('coplanar adjacent hardening removes only shared side-wall coverage',()=>{
  const equal=calculateHardening(parameters({blockers:[blocker('old',rectangle(10,0,10))]}));
  near(equal.visibleArea,100);assert.equal(equal.sideEdges.length,3);topology(equal);
  const thinner=calculateHardening(parameters({blockers:[blocker('old',rectangle(10,0,10),{thickness:.2})]}));
  const shared=thinner.sideEdges.filter(e=>e.a.x===10&&e.b.x===10);
  assert.equal(shared.length,1);near(shared[0].a.surfaceHeight,99.8);near(shared[0].a.baseHeight,99.7);
  const unknown=calculateHardening(parameters({blockers:[blocker('floor',rectangle(10,0,10),{thickness:undefined})]}));
  assert.equal(unknown.sideEdges.length,4,'unknown GLB thickness must not be guessed from the building height');
});

test('two adjoining pieces of side-wall coverage do not leave duplicate vertical intervals',()=>{
  const blockers=[blocker('a',rectangle(10,0,5,5)),blocker('b',rectangle(10,5,5,5))];
  const result=calculateHardening(parameters({blockers}));
  assert.equal(result.sideEdges.filter(e=>e.a.x===10&&e.b.x===10).length,0);topology(result);
});

test('a long road with a mid-route summit removes wall intervals by actual grade triangles',()=>{
  const vertices:HardeningSurfaceVertex[]=[];
  for(const [x,z] of [[0,100],[50,110],[100,100]]) for(const y of [0,5])
    vertices.push({x,y,surfaceHeight:z,formationHeight:z-.2});
  const road=blocker('road',rectangle(0,0,100,5),{plane:undefined,thickness:undefined,
    surface:{vertices,triangles:[[0,2,1],[1,2,3],[2,4,3],[3,4,5]]}});
  const result=calculateHardening(parameters({footprints:[rectangle(0,5,100,5)],plane:{...plane,height:100.2},
    blockers:[road],acceptedHeightDifferences:['road']}));
  const walls=result.sideEdges.filter(e=>Math.abs(e.a.y-5)<1e-7&&Math.abs(e.b.y-5)<1e-7);
  const at=(x:number)=>walls.filter(e=>x>=Math.min(e.a.x,e.b.x)-1e-7&&x<=Math.max(e.a.x,e.b.x)+1e-7).map(e=>{
    const t=(x-e.a.x)/(e.b.x-e.a.x);
    return [e.a.baseHeight+t*(e.b.baseHeight-e.a.baseHeight),e.a.surfaceHeight+t*(e.b.surfaceHeight-e.a.surfaceHeight)];
  });
  assert.ok(at(50).some(([low,high])=>Math.abs(low-99.9)<1e-7&&Math.abs(high-100.2)<1e-7),
    'the summit is above the slab: the entire local wall must remain');
  assert.ok(at(0).every(([low])=>low>=100-1e-7),'only the road/slab shared lower wall interval is removed at the endpoint');
});

test('many rectangle overlaps agree with an independent cell-area oracle and preserve topology',()=>{
  let seed=12345;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let iteration=0;iteration<25;iteration++) {
    const boxes=Array.from({length:8},()=>({x:Math.floor(random()*14)-2,y:Math.floor(random()*14)-2,w:1+Math.floor(random()*6),h:1+Math.floor(random()*6)}));
    let expected=0;
    for(let x=0;x<10;x++) for(let y=0;y<10;y++)
      if(!boxes.some(b=>x+.5>b.x&&x+.5<b.x+b.w&&y+.5>b.y&&y+.5<b.y+b.h)) expected++;
    const result=calculateHardening(parameters({blockers:boxes.map((b,i)=>blocker(String(i),rectangle(b.x,b.y,b.w,b.h)))}));
    near(result.visibleArea,expected);topology(result);
  }
});

test('invalid rings, holes and budget overruns fail without changing their inputs',()=>{
  assert.throws(()=>calculateHardening(parameters({footprints:[{outer:[{x:0,y:0},{x:10,y:10},{x:0,y:10},{x:10,y:0}]}]})),/自交|重叠/);
  assert.throws(()=>calculateHardening(parameters({footprints:[{...rectangle(0,0,10),holes:[rectangle(9,9,3).outer]}]})),/保留区/);
  assert.throws(()=>calculateHardening(parameters({footprints:[{...rectangle(0,0,10),holes:[rectangle(2,2,5).outer,rectangle(3,3,1).outer]}]})),/保留区/);
  assert.throws(()=>calculateHardening(parameters({footprints:[rectangle(0,0,HARDENING_LIMITS.extent+1)]})),/分区/);
  assert.throws(()=>calculateHardening(parameters({footprints:[{outer:Array.from({length:HARDENING_LIMITS.sourcePoints+1},(_,i)=>({x:i,y:0}))}]})),/复杂/);
  assert.throws(()=>calculateHardening(parameters({blockers:[blocker('duplicate',rectangle(0,0,1)),blocker('duplicate',rectangle(2,2,1))]})),/标识重复/);
});

test('disjoint unknown facilities do not require acceptance or exclude unrelated ground',()=>{
  const result=calculateHardening(parameters({blockers:[blocker('unknown',rectangle(100,100,2),{plane:undefined})]}));
  assert.equal(result.canSave,true);assert.deepEqual(result.conflicts,[]);near(result.visibleArea,100);
});

test('binary transport preserves holes, side-wall intervals and exact levels without a photography sampler',async()=>{
  const input=parameters({footprints:[{...rectangle(0,0,20),holes:[rectangle(5,5,5).outer]}],plane:{...plane,gradeEastPct:1}});
  const result=calculateHardening(input),packed=packHardening(result),moved=structuredClone(packed,{transfer:[packed.vertices.buffer,packed.triangles.buffer]});
  assert.equal(packed.vertices.byteLength,0);assert.equal(moved.vertices.length,result.vertices.length*5);
  for(let i=0;i<result.vertices.length;i++) near(moved.vertices[i*5+2],hardeningHeightAt(input.plane,result.vertices[i]));
  assert.deepEqual(await solveHardening(input),result);
});

test('pre-cancelled and in-flight worker jobs terminate without returning partial surfaces',async context=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(solveHardening(parameters(),{signal:controller.signal}),{name:'AbortError'});
  let terminated=0;
  class PendingWorker {onmessage?:unknown;postMessage(){} terminate(){terminated++;}}
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:PendingWorker});
  context.after(()=>{if(previous)Object.defineProperty(globalThis,'Worker',previous);else Reflect.deleteProperty(globalThis,'Worker');});
  const pending=new AbortController(),job=solveHardening(parameters(),{signal:pending.signal});
  pending.abort();await assert.rejects(job,{name:'AbortError'});assert.equal(terminated,1);
});

test('worker calculation errors release the worker and preserve the supplied source plan',async context=>{
  let terminated=0;
  class FailedWorker {
    onmessage?: (event:{data:unknown})=>void;
    postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:'error',message:'synthetic boolean failure'}}));}
    terminate(){terminated++;}
  }
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:FailedWorker});
  context.after(()=>{if(previous)Object.defineProperty(globalThis,'Worker',previous);else Reflect.deleteProperty(globalThis,'Worker');});
  const input=parameters(),before=structuredClone(input);
  await assert.rejects(solveHardening(input),/synthetic boolean failure/);assert.equal(terminated,1);assert.deepEqual(input,before);
});
