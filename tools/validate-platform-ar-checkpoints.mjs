// Offline C5 evidence gate. Never solves/tunes poses or writes project data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const identityKeys = ['videoSha256','trajectorySha256','geometrySha256','modelTransformSha256','cameraProfileSha256'];
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const finite = Number.isFinite;
const vector = (v,n) => Array.isArray(v) && v.length===n && v.every(finite);
const nonempty = v => typeof v==='string' && v.trim().length>0;
const instant = v => typeof v==='string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && finite(Date.parse(v));
function rational(value){
  if(typeof value!=='string'||!/^\d+\/\d+$/.test(value))return null;
  const [n,d]=value.split('/').map(Number);
  return Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&n>0&&d>0?n/d:null;
}
function sameFrame(a,b){return a&&b&&String(a.frameId)===String(b.frameId)&&a.pts===b.pts&&rational(a.timeBase)===rational(b.timeBase)&&Math.abs(a.timeSeconds-b.timeSeconds)<1e-7;}
const nullMetrics = () => ({rmsPx1920:null,p95Px1920:null,maxPx1920:null});

export function validateCheckpointPackage(document, expected){
  expected=expected??{};
  const problems=[], warnings=[], frames=[];
  const error=(code,detail)=>problems.push({code,detail});
  const actual=expected?.classification==='actual-project-inputs' && document?.classification==='actual-human-observations';
  if(expected?.schema!=='platform-ar-input-lock/v1')error('INPUT_LOCK_SCHEMA','An explicit input lock is required.');
  for(const key of identityKeys){
    if(!hash(expected?.identity?.[key]))error('INPUT_IDENTITY_MISSING',key);
    if(document && (!hash(document?.identity?.[key])||document.identity[key]!==expected?.identity?.[key]))error('IDENTITY_MISMATCH',key);
  }
  const video=expected?.video;
  if(!video||!finite(video.durationSeconds)||video.durationSeconds<=0||!Number.isSafeInteger(video.width)||video.width<1||!Number.isSafeInteger(video.height)||video.height<1)error('VIDEO_METADATA_MISSING','Dimensions and duration must come from the locked original video.');
  const coordinate=expected?.coordinates;
  if(coordinate?.horizontalCrs!=='EPSG:4978'||coordinate?.units!=='m'||coordinate?.status!=='verified'||!nonempty(coordinate?.verticalDatum)||['unknown','estimated'].includes(coordinate?.verticalDatum)||!nonempty(coordinate?.evidence))error('DATUM_UNVERIFIED','Require independently documented world ECEF/metres and vertical datum. EPSG:4978 alone does not verify source heights.');
  const calibration=expected?.calibration;
  if(!hash(calibration?.sha256)||!nonempty(calibration?.version)||calibration?.status!=='verified'||!nonempty(calibration?.evidence))error('CALIBRATION_UNVERIFIED','Freeze and document the camera, distortion, mounting and calibration version.');
  const index=Array.isArray(expected?.frameIndex)?expected.frameIndex:[];
  const frameMap=new Map();
  for(const frame of index){
    const tb=rational(frame?.timeBase);
    if(frame?.frameId===undefined||!Number.isSafeInteger(frame?.pts)||frame.pts<0||tb===null||!finite(frame.timeSeconds)||Math.abs(frame.pts*tb-frame.timeSeconds)>1e-7||frame.timeSeconds>(video?.durationSeconds??0)||frameMap.has(String(frame.frameId)))error('FRAME_INDEX_INVALID',String(frame?.frameId));
    else frameMap.set(String(frame.frameId),frame);
  }
  const rawReviews=expected?.reviewFrames, reviews=Array.isArray(rawReviews)?rawReviews:[];
  if(!Array.isArray(rawReviews)||reviews.length<5)error('REVIEW_FRAMES_MISSING','Declare at least five fixed review times covering this complete recording.');
  else for(const review of reviews)if(!sameFrame(review,frameMap.get(String(review?.frameId))))error('REVIEW_FRAME_MISMATCH',String(review?.frameId));
  if(reviews.length&&(new Set(reviews.map(f=>f?.frameId)).size!==reviews.length||Math.min(...reviews.map(f=>f?.timeSeconds))>video?.durationSeconds*.15||Math.max(...reviews.map(f=>f?.timeSeconds))<video?.durationSeconds*.9))error('REVIEW_COVERAGE_INCOMPLETE','Distinct fixed times must include the early and final recording portions.');
  if(!document){error('CHECKPOINTS_MISSING','No independent observations supplied.');return finish();}
  if(document.schema!=='platform-ar-checkpoints/v1')error('CHECKPOINT_SCHEMA','Unsupported checkpoint package.');
  if(document.calibrationSha256!==calibration?.sha256)error('CALIBRATION_MISMATCH','One unchanged calibration must serve every review time.');
  if(!instant(document.calibrationFrozenAt))error('CALIBRATION_FREEZE_MISSING','Record when tuning was frozen.');
  const rawUsed=document.calibrationUsedPointIds, rawTuned=document.tuningUsedPointIds;
  const used=Array.isArray(rawUsed)?rawUsed:[], tuned=Array.isArray(rawTuned)?rawTuned:[];
  if(!Array.isArray(rawUsed)||!used.length||used.some(x=>!nonempty(x))||new Set(used).size!==used.length)error('FIT_MANIFEST_MISSING','Explicit distinct physical point IDs used by the solver are required.');
  if(!Array.isArray(rawTuned)||tuned.some(x=>!nonempty(x))||new Set(tuned).size!==tuned.length)error('TUNING_MANIFEST_MISSING','Explicit IDs used for manual tuning are required, even an empty list.');
  const observations=Array.isArray(document.observations)?document.observations:[];
  if(!Array.isArray(document.observations))error('OBSERVATIONS_INVALID','Expected an observations array.');
  const fitting=new Set([...(used||[]),...(tuned||[])]);
  const fitPositions=[], seen=new Set(), byPhysical=new Map();
  for(const point of observations){
    if(point?.role==='fit')fitPositions.push(point.worldEcef);
    if(!nonempty(point?.id)||seen.has(point.id))error('DUPLICATE_OBSERVATION',String(point?.id));else seen.add(point.id);
    if(!nonempty(point?.physicalPointId))error('PHYSICAL_POINT_ID_MISSING',String(point?.id));
    if(!['fit','check'].includes(point?.role))error('POINT_ROLE_INVALID',String(point?.id));
    const roles=byPhysical.get(point?.physicalPointId)||new Set();roles.add(point?.role);byPhysical.set(point?.physicalPointId,roles);
    if(roles.size>1)error('FIT_CHECK_OVERLAP',String(point?.physicalPointId));
    if(point?.role==='check'&&fitting.has(point.physicalPointId))error('CHECK_USED_FOR_TUNING',point.physicalPointId);
    if(!vector(point?.worldEcef,3))error('WORLD_POINT_INVALID',String(point?.id));
    const observed=point?.observedPixels;
    if(!vector(observed,2)||observed[0]<0||observed[1]<0||observed[0]>=video?.width||observed[1]>=video?.height)error('OBSERVED_PIXEL_INVALID',String(point?.id));
    const source=point?.provenance;
    if(source?.method!=='manual-video-model-correspondence'||!nonempty(source?.observer)||!instant(source?.recordedAt)||!hash(source?.evidenceSha256))error('POINT_PROVENANCE_MISSING',String(point?.id));
    if(!sameFrame(point?.frame,frameMap.get(String(point?.frame?.frameId))))error('POINT_FRAME_MISMATCH',String(point?.id));
    if(!['ground','bridge','roof','facade'].includes(point?.surface))error('SURFACE_CLASS_MISSING',String(point?.id));
    if(point?.role==='check'){
      if(source?.usedForTuning!==false||source?.usedForFitting!==false)error('INDEPENDENCE_UNCONFIRMED',String(point?.id));
      if(instant(source?.recordedAt)&&instant(document.calibrationFrozenAt)&&Date.parse(source.recordedAt)<Date.parse(document.calibrationFrozenAt))error('CHECK_BEFORE_CALIBRATION_FREEZE',String(point?.id));
    }
  }
  for(const id of used||[])if(!observations.some(p=>p?.role==='fit'&&p.physicalPointId===id))error('FIT_MANIFEST_UNRESOLVED',id);
  // Changing an ID cannot make the same 3D landmark independent.
  for(const point of observations.filter(p=>p?.role==='check'))if(vector(point.worldEcef,3)&&fitPositions.some(v=>vector(v,3)&&Math.hypot(...v.map((x,i)=>x-point.worldEcef[i]))<0.001))error('FIT_CHECK_GEOMETRY_OVERLAP',point.id);
  if(new Set(observations.filter(p=>p?.role==='fit').map(p=>p.physicalPointId)).size<4)error('INSUFFICIENT_FIT_POINTS','At least four distinct fit landmarks are required; collect 8–12 for the actual project.');
  if(!actual)warnings.push('Synthetic or unclassified input: the tool cannot issue actual-project acceptance.');
  for(const frame of reviews||[]){
    const selected=observations.filter(p=>p?.role==='check'&&sameFrame(p.frame,frame));
    const reasons=[], ids=new Set(selected.map(p=>p.physicalPointId));
    if(ids.size<6||ids.size!==selected.length)reasons.push('need-six-distinct-independent-landmarks');
    for(const surface of ['ground','bridge','roof','facade'])if(!selected.some(p=>p.surface===surface))reasons.push('missing-'+surface);
    const coordinateKeys=new Set(selected.filter(p=>vector(p.worldEcef,3)).map(p=>p.worldEcef.map(x=>x.toFixed(4)).join(',')));
    if(coordinateKeys.size!==selected.length)reasons.push('duplicate-check-world-position');
    if(new Set(selected.map(p=>p.projection?.cameraSha256)).size!==1)reasons.push("inconsistent-camera-for-same-frame");
    const residuals=selected.map(point=>{
      const projection=point.projection;
      const binding=projection&&sameFrame(projection.frame,frame)&&identityKeys.every(key=>projection.identity?.[key]===expected.identity?.[key])&&projection.calibrationSha256===calibration?.sha256&&hash(projection.cameraSha256)&&projection.valid===true&&finite(projection.forwardDepthMeters)&&projection.forwardDepthMeters>0;
      const valid=binding&&vector(point.predictedPixels,2)&&vector(point.observedPixels,2);
      if(!valid)reasons.push('invalid-or-mismatched-projection:'+point.id);
      return {id:point.id,physicalPointId:point.physicalPointId,valid,errorPx1920:valid?Math.hypot(...point.predictedPixels.map((x,i)=>x-point.observedPixels[i]))*1920/(video?.width||NaN):null};
    });
    let metrics=nullMetrics();
    // Every invalid check remains in the denominator; never silently discard it.
    if(!problems.length&&!reasons.length){
      const errors=residuals.map(r=>r.errorPx1920).sort((a,b)=>a-b);
      metrics={rmsPx1920:Math.sqrt(errors.reduce((s,x)=>s+x*x,0)/errors.length),p95Px1920:errors[Math.ceil(errors.length*.95)-1],maxPx1920:errors.at(-1)};
    }
    const measured=metrics.rmsPx1920!==null;
    frames.push({frame,count:selected.length,distinctLandmarks:ids.size,invalidCount:residuals.filter(x=>!x.valid).length,reasons,residuals,metrics,pixelTargetPassed:measured?metrics.rmsPx1920<=3&&metrics.p95Px1920<=6&&metrics.maxPx1920<=10:null});
  }
  return finish();
  function finish(){
    const measured=frames.length>0&&frames.every(f=>f.pixelTargetPassed!==null)&&problems.length===0;
    const passed=measured&&frames.every(f=>f.pixelTargetPassed);
    return {schema:'platform-ar-checkpoint-validation/v1',status:!measured?'NOT_EVALUATED':passed?'PIXEL_TARGET_PASS':'PIXEL_TARGET_FAIL',actualProjectPixelTargetPassed:actual&&passed,problems,warnings,frames,
      overallMetrics:nullMetrics(),geographicPositionErrorMeters:null,heightErrorMeters:null,trueVisibleCoverage:null,longestLostSeconds:null,
      notes:['This gate checks declared evidence and residuals; it does not solve, tune, certify human independence, or replace a visual audit.','Per-frame metrics use original image pixel errors scaled uniformly to width 1920; P95 is nearest-rank.','A pixel target pass does not certify absolute geographic accuracy or full-frame visible-surface coverage.','Missing/invalid checks retain null aggregate metrics; independently measured coverage and loss intervals need separate ground truth.']};
  }
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length<1||args.length>2)throw Error('Usage: node tools/validate-platform-ar-checkpoints.mjs INPUT_LOCK.json [OBSERVATIONS.json]');
  const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
  const result=validateCheckpointPackage(args[1]?await read(args[1]):null,await read(args[0]));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.status==='PIXEL_TARGET_FAIL')process.exitCode=1;
  else if(result.status==='NOT_EVALUATED')process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
