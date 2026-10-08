import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const file='src/safetyWorkspace.ts', source=fs.readFileSync(file,'utf8');
const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='SafetyWorkspace');
const globals={SafetySpatialRepository:class {async loadModels(){return [];}},
  mergeSafetyEvents:d=>d,mergeSpatialDataset:d=>d,deriveSafetyView:()=>({nodes:[]})};
// Execute production method bodies. No Viewer/GPU result or validated real flight is inferred.
function method(name){const member=klass.members.find(n=>n.name?.getText(ast)===name);assert.ok(member,name);
 const js=ts.transpileModule('class Harness {'+member.getText(ast)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(globals),js+';return Harness.prototype.'+name)(...Object.values(globals));}
const names=['open','returnOverview','close','reload','patch','hasBoundVideo','seekMediaSeconds','tick','openMedia','beforeManualNavigation','acceptVideoRoamState','unbindVideoRoam','syncVideoRoamBinding','playbackSourceKey'];
const methods=Object.fromEntries(names.map(name=>[name,method(name)]));
const checks=[];const check=(name,fn)=>Promise.resolve().then(fn).then(()=>checks.push(name));
globalThis.document={hidden:false,body:{classList:{remove(){},add(){}}}};
function fixture(){
 const calls={bind:0,unbind:0,pause:0,seek:0,play:0,ticks:0};let runtime={state:'unbound',available:false};
 const source={recordId:'r0',generation:1,url:'blob:source-0',name:'recording.mp4'};
 const media={id:'video:r0',sourceRecordId:'r0',name:'recording.mp4',provenance:'real',kind:'video'};
 const self={...methods,active:true,disposed:false,reloading:false,mediaLoading:false,mediaRequestGeneration:0,mediaSourceTask:Promise.resolve(),
  pageSelections:new Map(),inspectionMode:'replay',selectedMedia:media.id,roamBindingKey:'',eventSnapshot:{events:[]},eventServiceError:'',
  video:{currentSrc:source.url,readyState:1,currentTime:115.67,duration:115.682233,paused:false,ended:false,playbackRate:1,
   pause(){calls.pause++;this.paused=true;},play(){calls.play++;this.paused=false;return Promise.resolve();}},
  options:{getPlaybackSource:()=>source,ready:async()=>{},prepareOpen:()=>()=>{},setVideoPanelActive(){},viewer:{resize(){},clock:{onTick:{addEventListener:()=>()=>{}}},scene:{requestRender(){}}},restoreWorkbench(){}},
  dashboard:{setPage(){},setVisible(){},setLoading(){},setEventError(){},setError(){},setMediaSources(){},setVideoRoamState(){},setVideoStatus(){}},
  effects:{setActive(){},setDataset(){},setInspectionContext(){},cancelPendingHome(){},focus(){},tick(){calls.ticks++;}},
  spatial:{getSnapshot:()=>({objects:[]}),load:async()=>({objects:[]}),setActive(){}},
  optimization:{close(){}},mediaDialog:{close(){}},mountVideo(){},unmountVideo(){},restoreTags(){},updateInspectionContext(){},layersChanged(){},
  pause(){this.video.pause();if(this.store.state.playing)this.store.patch({playing:false});},
  seekVideo(){calls.seek++;},mapReplayTime:()=>undefined,hasReplayTrack:()=>true,
  startedAt:performance.now(),lastTick:performance.now(),lastStateTick:0,replayTime:115649,observedStoreTime:115649,
  store:{dataset:{projectId:'project',nodes:[{id:'project'}],media:[media]},view:{media:[media],selected:{id:'project'}},
   state:{page:'inspection',time:115649,timeRange:[0,115649],playing:true,cruise:false,reducedMotion:false},
   patch(p){Object.assign(this.state,p);self.syncVideoRoamBinding();},setDataset(d){this.dataset=d;self.syncVideoRoamBinding();}},
  videoRoam:{getState:()=>runtime,unbind(){calls.unbind++;runtime={state:'unbound',available:false};self.acceptVideoRoamState(runtime);},
   bind(){calls.bind++;runtime={state:'ready',available:true};self.acceptVideoRoamState(runtime);return Promise.resolve();},
   beforeManualNavigation(){calls.manual=(calls.manual||0)+1;},setReducedMotion(){}}
 };
 self.boundSourceKey=self.playbackSourceKey();self.updateVideoStatus=()=>self.syncVideoRoamBinding();self.renderState=()=>self.updateVideoStatus();
 return {self,calls,source,media};
}
await check('closing sets inactive before synchronous pause/store subscribers; no remaining binding',()=>{
 const {self,calls}=fixture();self.syncVideoRoamBinding();assert.equal(calls.bind,1);self.close();assert.equal(calls.bind,1);assert.equal(self.active,false);assert.equal(self.videoRoam.getState().state,'unbound');assert.equal(self.roamBindingKey,'');
});
await check('reopening stale inspection state enters overview before source bind, retaining unseen follow preference',async()=>{
 const {self,calls}=fixture();self.active=false;await self.open();assert.equal(calls.bind,0);assert.equal(self.store.state.page,'overview');assert.equal(self.videoRoam.getState().state,'unbound');
});
await check('reload blocks old data/source bindings and binds once after the final dataset is ready',async()=>{
 const {self,calls}=fixture();self.syncVideoRoamBinding();const dataset=self.store.dataset;self.adapter={load:async()=>dataset};self.eventRepository={load:async()=>({events:[]})};self.withProjectModelPosition=d=>d;
 await self.reload(true);assert.equal(calls.bind,2);assert.equal(self.reloading,false);assert.equal(self.videoRoam.getState().state,'ready');
});
await check('same URL metadata reload can bind again after controller invalidation',()=>{
 const {self,calls}=fixture();self.syncVideoRoamBinding();self.acceptVideoRoamState({state:'source-changed',available:false});assert.equal(self.roamBindingKey,'');self.syncVideoRoamBinding();assert.equal(calls.bind,2);
});
await check('stale currentSrc cannot be treated as the current library source',()=>{
 const {self,calls}=fixture();self.video.currentSrc='blob:old';assert.equal(self.hasBoundVideo(),false);self.syncVideoRoamBinding();assert.equal(calls.bind,0);
});
await check('video tail beyond last telemetry sample stays playing; scene clock cannot seek it',()=>{
 const {self,calls}=fixture();self.tick();assert.equal(calls.pause,0);assert.equal(calls.seek,0);assert.equal(self.video.currentTime,115.67);assert.equal(calls.ticks,1);
});
await check('play at last telemetry time resumes video in place and restarts only at actual media end',()=>{
 const {self,calls}=fixture();self.patch({playing:true});assert.equal(self.video.currentTime,115.67);assert.equal(calls.seek,0);assert.equal(calls.play,1);
 self.video.ended=true;self.video.currentTime=self.video.duration;self.patch({playing:true});assert.equal(self.video.currentTime,0);assert.equal(calls.play,2);
});
await check('business timeRange filtering does not seek or pause the original recording',()=>{
 const {self,calls}=fixture();self.patch({timeRange:[1000,2000]});assert.equal(calls.pause,0);assert.equal(calls.seek,0);assert.equal(self.video.currentTime,115.67);
});
await check('media-seconds seek clamps to video duration and only maps scene time when telemetry exists',()=>{
 const {self,calls}=fixture();self.seekMediaSeconds(200);assert.equal(self.video.currentTime,self.video.duration);assert.equal(calls.pause,1);assert.equal(self.store.state.time,115649);
 self.mapReplayTime=seconds=>seconds*1000+100;self.seekMediaSeconds(12);assert.equal(self.video.currentTime,12);assert.equal(self.store.state.time,12100);
});
await check('manual camera request reaches pending roam binding; controller owns initial-home preference guard',()=>{
 const {self,calls}=fixture();self.beforeManualNavigation();assert.equal(calls.manual,1);assert.equal(self.videoRoam.getState().available,false);
});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
await check('serialized source restores cannot complete out of order; obsolete request cannot update selection',async()=>{
 const {self,source}=fixture(),a=deferred(),b=deferred(),started=[];self.reload=async()=>{};
 self.options.loadVideoSource=async id=>{started.push(id);await(id==='a'?a:b).promise;Object.assign(source,{recordId:id,url:'blob:'+id,name:id+'.mp4'});self.video.currentSrc=source.url;};
 const taskA=self.openMedia({id:'video:a',sourceRecordId:'a',name:'a.mp4',kind:'video'});await new Promise(r=>setImmediate(r));
 const taskB=self.openMedia({id:'video:b',sourceRecordId:'b',name:'b.mp4',kind:'video'});await new Promise(r=>setImmediate(r));assert.deepEqual(started,['a']);
 a.resolve();await taskA;await new Promise(r=>setImmediate(r));assert.deepEqual(started,['a','b']);assert.notEqual(self.selectedMedia,'video:a');
 b.resolve();await taskB;assert.equal(self.selectedMedia,'video:b');assert.equal(self.mediaLoading,false);assert.equal(source.recordId,'b');
});
await check('closing invalidates active and queued restore completions without rebinding',async()=>{
 const {self,source,calls}=fixture(),wait=deferred(),started=[];self.reload=async()=>{};
 self.options.loadVideoSource=async id=>{started.push(id);await wait.promise;source.recordId=id;};
 const a=self.openMedia({id:'video:a',sourceRecordId:'a',name:'a.mp4',kind:'video'});await new Promise(r=>setImmediate(r));
 const b=self.openMedia({id:'video:b',sourceRecordId:'b',name:'b.mp4',kind:'video'});self.close();wait.resolve();await Promise.all([a,b]);
 assert.deepEqual(started,['a']);assert.equal(self.selectedMedia,'video:r0');assert.equal(calls.bind,0);assert.equal(self.mediaLoading,false);
});
await check('a failed source restore does not poison the next requested source',async()=>{
 const {self,source}=fixture();self.reload=async()=>{};self.options.loadVideoSource=async id=>{if(id==='bad')throw Error('source unavailable');Object.assign(source,{recordId:id,url:'blob:'+id,name:id+'.mp4'});};
 await assert.rejects(self.openMedia({id:'video:bad',sourceRecordId:'bad',name:'bad.mp4',kind:'video'}),/source unavailable/);
 assert.equal(self.mediaLoading,false);await self.openMedia({id:'video:ok',sourceRecordId:'ok',name:'ok.mp4',kind:'video'});assert.equal(self.selectedMedia,'video:ok');
});
await check('only the verified runtime owns displayed flight geometry; layer flags and page gate it',()=>{
 const visibility=[],legacy=[];
 const self={active:true,inspectionMode:'replay',selectedMedia:'video:r0',roamState:{available:true},
  store:{state:{page:'inspection',layers:{track:true,markers:true}}},
  videoRoam:{setLayerVisibility:(...flags)=>visibility.push(flags)},
  effects:{setInspectionContext:context=>legacy.push(context)}};
 const update=method('updateInspectionContext');
 update.call(self);assert.deepEqual(visibility.at(-1),[true,true]);
 self.store.state.layers.track=false;update.call(self);assert.deepEqual(visibility.at(-1),[false,true]);
 self.roamState.available=false;update.call(self);assert.deepEqual(visibility.at(-1),[false,false]);
 self.roamState.available=true;self.store.state.page='overview';update.call(self);assert.deepEqual(visibility.at(-1),[false,false]);
 assert.equal(legacy.length,4);assert.ok(legacy.every(context=>context===undefined));
});
const report={checkedAt:new Date().toISOString(),scope:'CPU production-method execution with deterministic media/store stubs; not real GPU/video follow acceptance',sourceSha256:createHash('sha256').update(source).digest('hex'),checks,pass:checks.length,fail:0};
fs.mkdirSync('output/platform-v5',{recursive:true});fs.writeFileSync('output/platform-v5/workspace-integration-cpu.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
