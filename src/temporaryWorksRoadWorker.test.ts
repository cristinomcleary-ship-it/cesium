import assert from 'node:assert/strict';
import { test } from 'node:test';
import { solvePlanningRoad } from './temporaryWorksRoad';
import { RoadRouteConflict } from './temporaryWorksRoadConflict';
import { packRoad, unpackRoad } from './temporaryWorksRoadTransfer';

const axis=[{x:0,y:0},{x:400,y:0}], design={width:4,slopeRatio:1,hardeningDepth:.25,treatmentDepth:.75,
  grades:[{start:0,end:400,gradePct:.5}]};
const datum={reference:axis[0],referenceHeight:100,finishedOffset:.2};

test('sample errors or user cancellation discard all earlier batches; binary transfer preserves road part, index, chainage and elevations',async()=>{
  let calls=0;
  await assert.rejects(solvePlanningRoad(axis,design,datum,1,async ps=>{
    if (++calls===2) return [100];
    return ps.map(()=>100);
  }),/数量不符/);
  assert.equal(calls,2);
  const abort=new AbortController(); calls=0;
  await assert.rejects(solvePlanningRoad(axis,design,datum,1,async ps=>{
    if (++calls===2) abort.abort();
    return ps.map(()=>100);
  },{signal:abort.signal}),{name:'AbortError'});
  assert.equal(calls,2);
  let done=0;
  const result=await solvePlanningRoad(axis,design,datum,2,async (ps,stage)=>{
    assert.ok(ps.length<=512);
    assert.equal(stage.completed,done);
    assert.ok(stage.offset+ps.length<=stage.total && stage.chunk>=1);
    done+=ps.length;
    return ps.map(p=>p.x<=390 ? 100.671 : null);
  });
  assert.equal(done,result.sampleCount);
  const packed=packRoad(result);
  const moved=structuredClone(packed,{transfer:[packed.vertices.buffer,packed.triangles.buffer]});
  assert.equal(packed.vertices.byteLength,0);
  assert.deepEqual(await unpackRoad(moved),result);
});

test('worker reports both true-conflict stations as a typed error and is terminated after rejection',async context=>{
  let terminated=0;
  class ConflictWorker {
    onmessage?: (event:{data:unknown})=>void;
    postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:'error', message:'conflict',
      conflict:{kind:'levels', stations:[23.12,361.75]}}}));}
    terminate(){terminated++;}
  }
  const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:ConflictWorker});
  context.after(()=>{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');});
  await assert.rejects(solvePlanningRoad(axis,design,datum,2,async()=>assert.fail()),(e)=>{
    assert.ok(e instanceof RoadRouteConflict); assert.equal(e.kind,'levels');
    assert.deepEqual(e.stations,[23.12,361.75]); return true;
  });
  assert.ok(terminated>=1);
});
