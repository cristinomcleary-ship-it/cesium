// Read-only C5 input inventory. Outputs only to a NEW explicit report directory.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {validateCheckpointPackage} from './validate-platform-ar-checkpoints.mjs';
const require=createRequire(import.meta.url),{inspectRecovery}=require('./inspect-video-ar-recovery.cjs');
const exec=promisify(execFile), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
async function fingerprint(p){const before=await fs.stat(p);const h=crypto.createHash('sha256');for await(const b of createReadStream(p))h.update(b);const after=await fs.stat(p);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Input changed during hashing: '+p);return {path:p,bytes:after.size,sha256:h.digest('hex')};}
async function walk(dir){const result=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Refuse ambiguous model symlink: '+p);if(entry.isDirectory())result.push(...await walk(p));else if(entry.isFile())result.push(p);}return result.sort();}
const slot=(record,dir,key)=>path.join(dir,record.id,key,record.files[key].name);
async function main(){
  if(process.argv.length!==3)throw Error('Usage: node tools/inspect-platform-ar-inputs.mjs NEW_OUTPUT_DIRECTORY');
  const out=path.resolve(process.argv[2]);
  if(!out.startsWith(path.join(root,'output')+path.sep))throw Error('Report must be in a new directory below workspace/output.');
  await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);
  const data=path.join(root,'project-data'),records=path.join(data,'records');
  const recovery=await inspectRecovery({dataDir:data});
  await fs.writeFile(path.join(out,'persisted-inspection.json'),JSON.stringify(recovery,null,2));
  const videoRecord=await read(recovery.bindings.activeRecord.path), trajectory=await read(recovery.bindings.trajectory.path);
  const model=recovery.models.find(m=>m.visible)||recovery.models[0];if(!model)throw Error('No actual model available.');
  const modelRecord=await read(recovery.bindings['modelRecord:'+model.id].path),modelDir=path.dirname(recovery.bindings['modelEntry:'+model.id].path);
  const modelFiles=await walk(modelDir),manifest=[];
  for(let i=0;i<modelFiles.length;i++){const f=await fingerprint(modelFiles[i]);manifest.push({path:path.relative(modelDir,f.path).split(path.sep).join('/'),bytes:f.bytes,sha256:f.sha256});if(i%3000===0)console.log('Model files hashed',i,'/',modelFiles.length);}
  const manifestBytes=JSON.stringify(manifest),geometrySha256=digest(manifestBytes);
  await fs.writeFile(path.join(out,'model-files.sha256.json'),manifestBytes+'\n');
  const ffprobe=path.join(root,'video_ar_backend/tools/FFmpeg/bin/ffprobe.exe');
  const probeArgs=['-v','error','-select_streams','v:0','-show_streams','-show_format','-show_packets','-show_entries','stream=codec_name,width,height,avg_frame_rate,time_base,duration,nb_frames,has_b_frames:format=duration,size:packet=pts,pts_time','-of','json',recovery.bindings.activeVideo.path];
  const probe=JSON.parse((await exec(ffprobe,probeArgs,{maxBuffer:16*1024*1024,windowsHide:true})).stdout);
  await fs.writeFile(path.join(out,'original-video-probe.json'),JSON.stringify(probe,null,2));
  const stream=probe.streams[0],frameIndex=probe.packets.map((p,i)=>({frameId:'pts:'+p.pts,packetOrder:i,pts:p.pts,timeBase:stream.time_base,timeSeconds:Number(p.pts_time)}));
  // Use rational PTS, never the rounded decimal emitted by ffprobe.
  const [num,den]=stream.time_base.split('/').map(Number);frameIndex.forEach(f=>f.timeSeconds=f.pts*num/den);
  const reviewFrames=[10.01,30,60,90,114].map(requestedSeconds=>({...frameIndex.reduce((a,b)=>Math.abs(b.timeSeconds-requestedSeconds)<Math.abs(a.timeSeconds-requestedSeconds)?b:a),requestedSeconds}));
  const profilePath=path.join(root,'output/ar-v2-quality/media/camera_profiles.json');
  let profileBinding=null,profile=null;try{profileBinding=await fingerprint(profilePath);const doc=await read(profilePath);profile=doc.profiles.find(p=>p.id===doc.active_profile_id)||doc.profiles[0];}catch{}
  const inputLock={schema:'platform-ar-input-lock/v1',classification:'actual-project-inputs',createdAt:new Date().toISOString(),
    identity:{videoSha256:recovery.bindings.activeVideo.sha256,trajectorySha256:recovery.bindings.trajectory.sha256,geometrySha256,modelTransformSha256:digest(JSON.stringify(modelRecord.settings?.matrix??null)),cameraProfileSha256:profileBinding?.sha256??null},
    records:{videoId:videoRecord.id,modelId:modelRecord.id},video:{width:stream.width,height:stream.height,durationSeconds:Number(stream.duration||probe.format.duration),codec:stream.codec_name,frameRate:stream.avg_frame_rate,timeBase:stream.time_base},
    calibration:{sha256:null,version:profile?.calibration_version??null,status:profile?.status??'missing',evidence:null},
    coordinates:{horizontalCrs:'EPSG:4978',units:'m',verticalDatum:'unknown',status:'unverified',evidence:null},
    cameraProfile:{binding:profileBinding,status:profile?.status??'missing',source:'Historical V2 derived profile; file identity verified now, independent camera calibration not supplied.'},
    frameIdentity:'Exact source-video packet PTS. This inventory does not decode images or assert packet order is a decoded frame index.',frameIndex,reviewFrames};
  const recordInventory=[];
  for(const dir of await fs.readdir(records,{withFileTypes:true})){if(!dir.isDirectory())continue;const filename=path.join(records,dir.name,'record.json');let r;try{r=await read(filename);}catch{continue;}if(r.kind==='Drone Video')recordInventory.push({id:r.id,name:r.name,calibrationSessions:Array.isArray(r.settings?.video?.calibrationSessions)?r.settings.video.calibrationSessions.length:null,record:await fingerprint(filename)});}
  const sourceDir=path.resolve(modelRecord.settings.localPath),sourceFiles=await walk(path.resolve(sourceDir,'../../..'));
  const sourceProjectCandidates=sourceFiles.filter(p=>/\.(ccm|ccmx|3mx|3mxb|obj|fbx|ply|las|laz)$/i.test(p));
  const sourceMetadata=sourceFiles.filter(p=>path.basename(p).toLowerCase()==='metadata.xml');
  let resolved=null;try{resolved=await read(path.join(root,'output/ar-v2-quality/resolved-config.json'));}catch{}
  const inventory={schema:'platform-ar-input-inventory/v1',createdAt:new Date().toISOString(),classification:'read-only-actual-project-inventory',bindings:recovery.bindings,activeVideoId:videoRecord.id,modelId:modelRecord.id,
    modelTree:{directory:modelDir,fileCount:manifest.length,bytes:manifest.reduce((n,f)=>n+f.bytes,0),manifestSha256:geometrySha256,algorithm:'SHA256 of UTF8 JSON array of sorted relative path, bytes, per-file SHA256; no trailing newline',transform:modelRecord.settings.matrix},
    media:{...inputLock.video,packetCount:frameIndex.length,recordInventory},trajectory:{sourceCrs:trajectory.source_crs,sampleCount:trajectory.trajectory_points?.length,firstTimeMs:trajectory.trajectory_points?.at(0)?.video_time_ms,lastTimeMs:trajectory.trajectory_points?.at(-1)?.video_time_ms,timeline:trajectory.flight_info?.timeline,cameraModel:trajectory.flight_info?.camera_model,bodyAttitudeStatus:trajectory.flight_info?.body_attitude_status,heightClaim:trajectory.flight_info?.altitude_reference,derivedGroundHeight:trajectory.flight_info?.ground_altitude_m,heightVerification:'No evidence that abs_alt or derived ground altitude is an ellipsoid height. No correction applied.'},
    sourceProduction:{directory:sourceDir,searchedRoot:path.resolve(sourceDir,'../../..'),sourceProjectCandidates,metadata:await Promise.all(sourceMetadata.map(fingerprint)),assessment:'Production tiles exist. No editable source project/reconstruction mesh verified by presence of production tiles alone; mesh repair service not established.'},
    derivedV2:{profileBinding,calibrationStatus:profile?.status??null,configuredCheckpointsPath:resolved?.validation?.checkpoints_path??null,classification:'Historical derived artifacts, no new registration acceptance'},
    gaps:[...(!recordInventory.some(r=>r.calibrationSessions>0)?['No saved fit/checkpoint sessions in current video records.']:['Saved sessions exist and require independent provenance review.']),...(!resolved?.validation?.checkpoints_path?['No configured independent V2 checkpoint file.']:['A configured checkpoint file exists and must be validated against this lock.']),...(profile?.status!=='verified'?['Camera intrinsics are estimated; lens distortion and body/mount calibration are not independently supplied.']:[]),'Verified vertical datum and survey conversion are missing.','Production 3D Tiles are available; verified editable source project and source mesh repair service are not established.'],
    reviewFrames,originalDataModified:false,accuracy:{rmsPx1920:null,p95Px1920:null,maxPx1920:null,positionMeters:null,heightMeters:null,validCoverage:null,longestLostSeconds:null}};
  await fs.writeFile(path.join(out,'input-lock.json'),JSON.stringify(inputLock,null,2));
  await fs.writeFile(path.join(out,'input-inventory.json'),JSON.stringify(inventory,null,2));
  await fs.writeFile(path.join(out,'checkpoint-validation.json'),JSON.stringify(validateCheckpointPackage(null,inputLock),null,2));
  console.log(JSON.stringify({out,activeVideoId:videoRecord.id,modelId:modelRecord.id,modelFiles:manifest.length,video:inputLock.video,reviewFrames,status:'NOT_EVALUATED',gaps:inventory.gaps},null,2));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
