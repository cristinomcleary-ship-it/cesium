import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCheckpointPackage,identityKeys} from './validate-platform-ar-checkpoints.mjs';

// Synthetic coordinates exercise the acceptance gate only, never engineering accuracy.
function fixture(){
  const identity=Object.fromEntries(identityKeys.map((k,i)=>[k,String(i+1).repeat(64)]));
  const frameIndex=[10.01,30,60,90,114].map((timeSeconds,i)=>({frameId:i,pts:Math.round(timeSeconds*30000),timeBase:'1/30000',timeSeconds}));
  const calibration={sha256:'6'.repeat(64),version:'fixture-v1',status:'verified',evidence:'Synthetic controlled-test calibration'};
  const expected={schema:'platform-ar-input-lock/v1',classification:'synthetic-test-fixture',identity,video:{width:3840,height:2160,durationSeconds:115.68},calibration,
    coordinates:{horizontalCrs:'EPSG:4978',units:'m',verticalDatum:'ellipsoid',status:'verified',evidence:'Synthetic-test definition'},frameIndex,reviewFrames:frameIndex};
  const make=(role,i,frame)=>({id:`${role}-${i}-${frame.frameId}`,physicalPointId:`${role}-${i}`,role,surface:['ground','bridge','roof','facade'][i%4],worldEcef:[1000+(role==='fit'?100:0)+i,2000,3000],observedPixels:[100+i*100,200],predictedPixels:[102+i*100,200],frame,
    provenance:{method:'manual-video-model-correspondence',observer:'Synthetic fixture generator',recordedAt:'2026-10-09T01:00:00Z',evidenceSha256:'7'.repeat(64),usedForFitting:role==='fit',usedForTuning:false},
    projection:{identity,frame,calibrationSha256:calibration.sha256,cameraSha256:'8'.repeat(64),valid:true,forwardDepthMeters:30}});
  const observations=[...Array.from({length:8},(_,i)=>make('fit',i,frameIndex[0])),...frameIndex.flatMap(frame=>Array.from({length:6},(_,i)=>make('check',i,frame)))];
  const document={schema:'platform-ar-checkpoints/v1',classification:'synthetic-test-fixture',identity,calibrationSha256:calibration.sha256,calibrationFrozenAt:'2026-10-09T00:00:00Z',calibrationUsedPointIds:observations.filter(p=>p.role==='fit').map(p=>p.physicalPointId),tuningUsedPointIds:[],observations};
  return {expected,document};
}
function run(mutator){const f=fixture();mutator?.(f);return validateCheckpointPackage(f.document,f.expected);}
function has(result,code){assert.ok(result.problems.some(p=>p.code===code),JSON.stringify(result.problems));assert.equal(result.actualProjectPixelTargetPassed,false);}
test('complete synthetic fixture measures 1920-width residuals but cannot claim actual-project acceptance',()=>{
  const r=run();assert.equal(r.status,'PIXEL_TARGET_PASS');assert.equal(r.actualProjectPixelTargetPassed,false);assert.equal(r.frames.length,5);assert.equal(r.frames[0].metrics.rmsPx1920,1);assert.equal(r.heightErrorMeters,null);assert.equal(r.trueVisibleCoverage,null);
});
test('missing real observations produce null metrics',()=>{const f=fixture();const r=validateCheckpointPackage(null,f.expected);has(r,'CHECKPOINTS_MISSING');assert.equal(r.status,'NOT_EVALUATED');assert.equal(r.overallMetrics.rmsPx1920,null);});
test('stale source identities cannot produce metrics',()=>{const r=run(f=>f.document.identity={...f.document.identity,videoSha256:'a'.repeat(64)});has(r,'IDENTITY_MISMATCH');assert.equal(r.frames[0].metrics.rmsPx1920,null);});
test('a renamed fit landmark cannot masquerade as an independent check',()=>{const r=run(f=>f.document.observations.find(p=>p.role==='check').worldEcef=[...f.document.observations[0].worldEcef]);has(r,'FIT_CHECK_GEOMETRY_OVERLAP');});
test('tuning and solver manifests exclude held-out physical IDs across all frames',()=>{
  has(run(f=>f.document.tuningUsedPointIds=['check-0']),'CHECK_USED_FOR_TUNING');
  has(run(f=>f.document.calibrationUsedPointIds.push('check-0')),'CHECK_USED_FOR_TUNING');
  has(run(f=>f.document.observations.find(p=>p.role==='check').physicalPointId='fit-0'),'FIT_CHECK_OVERLAP');
});
test('at least six distinct checks with ground, bridge, roof and facade are required at each review frame',()=>{
  const r=run(f=>f.document.observations=f.document.observations.filter(p=>p.id!=='check-5-0'));assert.equal(r.status,'NOT_EVALUATED');assert.equal(r.frames[0].metrics.rmsPx1920,null);
  const coverage=run(f=>f.document.observations.filter(p=>p.role==='check').forEach(p=>p.surface='ground'));assert.ok(coverage.frames.every(f=>f.reasons.includes('missing-facade')));
});
test('PTS, time base and frame identity are all checked',()=>{
  has(run(f=>f.document.observations[0].frame={...f.document.observations[0].frame,pts:9}),'POINT_FRAME_MISMATCH');
  has(run(f=>f.expected.frameIndex[0].timeBase='0/1'),'FRAME_INDEX_INVALID');
});
test('unverified datum and calibration keep all precision metrics null',()=>{
  has(run(f=>f.expected.coordinates.status='estimated'),'DATUM_UNVERIFIED');
  has(run(f=>f.expected.calibration.status='estimated'),'CALIBRATION_UNVERIFIED');
});
test('check observations collected before tuning freeze are not accepted',()=>has(run(f=>f.document.calibrationFrozenAt='2026-10-09T02:00:00Z'),'CHECK_BEFORE_CALIBRATION_FREEZE'));
test('invalid, behind-camera or old-frame predictions stay in denominator and invalidate that frame',()=>{
  for(const mutate of[p=>p.projection.valid=false,p=>p.projection.forwardDepthMeters=-1,p=>p.predictedPixels=null,p=>p.projection.frame={...p.frame,pts:33}]){
    const r=run(f=>mutate(f.document.observations.find(p=>p.role==='check')));assert.equal(r.frames[0].count,6);assert.equal(r.frames[0].invalidCount,1);assert.equal(r.frames[0].metrics.rmsPx1920,null);
  }
});
test('one frozen calibration for all frames and one same-frame camera',()=>{
  has(run(f=>f.document.calibrationSha256='0'.repeat(64)),'CALIBRATION_MISMATCH');
  const r=run(f=>f.document.observations.find(p=>p.role==='check').projection.cameraSha256='9'.repeat(64));assert.ok(r.frames[0].reasons.includes('inconsistent-camera-for-same-frame'));assert.equal(r.status,'NOT_EVALUATED');
});
test('a badly aligned check is never removed to make a passing result',()=>{
  const r=run(f=>f.document.observations.find(p=>p.role==='check').predictedPixels[0]+=200);assert.equal(r.status,'PIXEL_TARGET_FAIL');assert.equal(r.frames[0].count,6);assert.ok(r.frames[0].metrics.maxPx1920>100);
});
test('malformed manifests do not throw or accidentally accept',()=>{
  assert.doesNotThrow(()=>validateCheckpointPackage({},{}));
  has(run(f=>f.document.calibrationUsedPointIds=1),'FIT_MANIFEST_MISSING');
  has(run(f=>f.document.tuningUsedPointIds='no'),'TUNING_MANIFEST_MISSING');
});

test('partial or repeated review times cannot certify a full recording',()=>{
 has(run(f=>f.expected.reviewFrames=f.expected.reviewFrames.slice(0,2)),'REVIEW_FRAMES_MISSING');
 has(run(f=>f.expected.reviewFrames=Array(5).fill(f.expected.frameIndex[2])),'REVIEW_COVERAGE_INCOMPLETE');
});
