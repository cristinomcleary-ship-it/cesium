import assert from 'node:assert/strict';
import test from 'node:test';
import { glbGroundSamplePoints, summarizeGlbGroundSamples } from './temporaryWorksGlbGrounding';

test('ground samples cover each footprint edge and interior rather than just its anchor',()=>{
  const points=glbGroundSamplePoints([[{x:0,y:0},{x:30,y:0},{x:30,y:10},{x:0,y:10}]]);
  assert.ok(points.length>=33);
  for(const corner of [{x:0,y:0},{x:30,y:0},{x:30,y:10},{x:0,y:10}]) assert.ok(points.some(p=>p.x===corner.x&&p.y===corner.y));
  assert.ok(points.some(p=>p.x===15&&p.y===5));
  assert.ok(points.every(p=>p.x>=0&&p.x<=30&&p.y>=0&&p.y<=10));
});

test('interior samples do not bridge a concave notch',()=>{
  const ring=[{x:0,y:0},{x:30,y:0},{x:30,y:10},{x:10,y:10},{x:10,y:30},{x:0,y:30}];
  const points=glbGroundSamplePoints([ring]);
  assert.ok(points.every(p=>p.x<=10||p.y<=10));
});

test('surface audit retains missing samples and uses a conservative maximum for a rigid base',()=>{
  assert.deepEqual(summarizeGlbGroundSamples([10,11,12,13,null]),{status:'sampled',sampleCount:5,validCount:4,minimum:10,maximum:13});
  assert.throws(()=>summarizeGlbGroundSamples([10,11,12,null,NaN]),/有效 3\/5/);
  assert.throws(()=>summarizeGlbGroundSamples([10,11]),/有效 2\/2/);
  assert.throws(()=>summarizeGlbGroundSamples([null,Infinity,NaN]),/有效 0\/3/);
});
