import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync,writeFileSync,readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { createServer } from "node:http";
import { createManagementStore,ManagementError,type ManagementStoreOptions } from "./managementStore.ts";
import { modelRegistryFixture,spatialV3Fixture } from "../src/safetySpatial.testFixtures.ts";
import type { ManagementCommandType,ManagementSnapshot } from "../src/managementTypes.ts";

function fixture(extra:Partial<ManagementStoreOptions>={}){
 const dir=mkdtempSync(join(tmpdir(),"cesium-management-"));let time="2026-10-08T01:00:00.000Z",sequence=0;
 const sentinel=join(dir,"safety-spatial.json");writeFileSync(sentinel,JSON.stringify({version:1,revision:1,objects:[{id:"area-a",kind:"construction-area",projectId:"safety:project"},{id:"area-b",kind:"construction-area",projectId:"safety:project"},{id:"risk-a",kind:"risk-point",projectId:"safety:project",geometry:{type:"Point",position:{longitude:120,latitude:30,height:100}},modelVersion:"original"}]}));const original=readFileSync(sentinel,"utf8");
 let store=createManagementStore({dataDir:dir,now:()=>time,resolveLibraryEvidence:async(_p,recordId)=>recordId==="known-file"?{name:"CPU fixture report",url:"/__library/files/known-file/document/test.pdf",size:10}:undefined,...extra});
 const snapshot=()=>store.load("safety:project",store.localActor());
 const command=async(type:ManagementCommandType,payload:Record<string,unknown>={},id?:string)=>{const current=id?Object.values(snapshot().collections).flat().find(v=>v.id===id):undefined;return store.command({projectId:"safety:project",type,payload,id,expectedRevision:current?.revision,idempotencyKey:`test-${++sequence}`},store.localActor());};
 const record=(state:ManagementSnapshot,id:string)=>{const value=Object.values(state.collections).flat().find(v=>v.id===id);assert.ok(value,id);return value;};
 const task=async(id="task-a",fields:Record<string,unknown>={})=>{await command("task.create",{name:id,ownerId:"local-owner",planStart:"2026-10-05",planEnd:"2026-10-10",targetQuantity:100,unit:"m3",...fields},id);await command("task.publish",{},id);return id;};
 const progress=async(id:string,quantity=10)=>{await command("progress.create",{taskId:"task-a",quantity,unit:"m3",businessDate:"2026-10-07",shift:"day",crew:"crew-a",measurementKey:id},id);await command("progress.submit",{},id);await command("progress.confirm",{},id);};
 return {dir,command,snapshot,record,task,progress,get store(){return store;},setTime:(value:string)=>{time=value;},time:()=>time,reopen:()=>{store.close();store=createManagementStore({dataDir:dir,now:()=>time});},close:()=>{assert.equal(readFileSync(sentinel,"utf8"),original,"original spatial metadata unchanged");store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+"cesium-management-"));rmSync(dir,{recursive:true,force:true});}};
}
async function rejects(promise:Promise<unknown>,code:string){await assert.rejects(promise,e=>e instanceof ManagementError&&e.code===code);}

test("persistent task identity, spatial many-to-many de-duplication, safe hierarchy and optimistic concurrency",async()=>{
 const f=fixture();try{
  await f.command("wbs.create",{name:"package"},"wbs-a");await f.task("task-a",{wbsId:"wbs-a",areaIds:["area-a","area-b","area-a"]});
  assert.deepEqual(f.record(f.snapshot(),"task-a").areaIds,["area-a","area-b"]);
  const metrics=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time(),{areaIds:["area-a","area-b"]});assert.equal(metrics.taskProgress.length,1);
  await f.command("task.update",{name:"renamed",reason:"coordination"},"task-a");assert.deepEqual(f.record(f.snapshot(),"task-a").areaIds,["area-a","area-b"]);
  await rejects(f.store.command({projectId:"safety:project",type:"task.update",id:"task-a",expectedRevision:1,idempotencyKey:"stale-request",payload:{name:"stale",reason:"stale"}},f.store.localActor()),"REVISION_CONFLICT");
  await f.command("wbs.create",{name:"child",parentId:"wbs-a"},"wbs-b");await rejects(f.command("wbs.update",{name:"parent",parentId:"wbs-b"},"wbs-a"),"WBS_CYCLE");
  f.reopen();assert.equal(f.record(f.snapshot(),"task-a").name,"renamed");assert.equal(f.snapshot().collections.tasks.length,1);
 }finally{f.close();}
});

test("immutable approved baseline and dependency/date conflicts roll back without partial versions",async()=>{
 const f=fixture();try{await f.task();await f.command("baseline.create",{name:"approved",taskIds:["task-a"]},"baseline");await f.command("baseline.approve",{},"baseline");const original=structuredClone(f.record(f.snapshot(),"baseline"));await f.command("task.update",{planEnd:"2026-10-12",reason:"approved adjustment"},"task-a");assert.deepEqual(f.record(f.snapshot(),"baseline"),original);
 await f.task("task-b",{planStart:"2026-10-13",planEnd:"2026-10-14",predecessorIds:["task-a"]});await rejects(f.command("task.update",{predecessorIds:["task-b"],reason:"invalid cycle"},"task-a"),"DEPENDENCY_DATE_CONFLICT");
 await rejects(f.command("task.update",{planStart:"2026-99-01",reason:"bad date"},"task-a"),"INVALID_DATE");assert.equal(f.record(f.snapshot(),"task-a").planStart,"2026-10-05");
 }finally{f.close();}
});

test("ProgressEntry retries, duplicate detection and pending revision retain exactly one confirmed value",async()=>{
 const f=fixture();try{await f.task();const payload={taskId:"task-a",quantity:20,unit:"m3",businessDate:"2026-10-07",shift:"day",crew:"crew-a",measurementKey:"part-a"};const m={projectId:"safety:project",type:"progress.create" as const,id:"entry",idempotencyKey:"persistent-retry",payload};await f.store.command(m,f.store.localActor());await f.store.command(m,f.store.localActor());assert.equal(f.snapshot().collections.progress.length,1);await rejects(f.store.command({...m,payload:{...payload,quantity:21}},f.store.localActor()),"IDEMPOTENCY_CONFLICT");
 await rejects(f.command("progress.create",payload,"duplicate"),"DUPLICATE_PROGRESS");await f.command("progress.submit",{},"entry");await f.command("progress.confirm",{},"entry");const oldF=f.time();f.setTime("2026-10-09T01:00:00.000Z");await f.command("progress.revise",{...payload,quantity:15,reason:"survey correction"},"entry");
 assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-09",f.time()).taskProgress[0].quantity,20);await f.command("progress.submit",{},"entry");await f.command("progress.return",{reason:"needs clarification"},"entry");assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-09",f.time()).taskProgress[0].quantity,20);await f.command("progress.submit",{},"entry");await f.command("progress.confirm",{},"entry");assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-09",f.time()).taskProgress[0].quantity,15);assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-09",oldF).taskProgress[0].quantity,20);
 await f.command("progress.revoke",{reason:"void invalid survey"},"entry");assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-09",f.time()).taskProgress[0].quantity,0,"revocation cannot resurrect an older replaced revision");
 }finally{f.close();}
});

test("completion beyond target is rejected and execution-only daily logs create no quantities",async()=>{
 const f=fixture();try{await f.task();await f.command("dailyLog.create",{taskId:"task-a",businessDate:"2026-10-08",description:"access preparation",progressEntryIds:[]},"log");assert.equal(f.snapshot().collections.progress.length,0);await f.progress("entry-a",80);await f.command("progress.create",{taskId:"task-a",quantity:30,unit:"m3",businessDate:"2026-10-08",shift:"day",crew:"crew",measurementKey:"b"},"entry-b");await f.command("progress.submit",{},"entry-b");await rejects(f.command("progress.confirm",{},"entry-b"),"TARGET_EXCEEDED");assert.equal(f.record(f.snapshot(),"entry-b").status,"submitted");
 }finally{f.close();}
});

test("weekly commitment keeps original denominator and does not aggregate mixed units without a baseline",async()=>{
 const f=fixture();try{await f.task();await f.progress("e",30);await f.command("commitment.create",{taskId:"task-a",weekStart:"2026-10-05",originalDueDate:"2026-10-09",targetQuantity:20,unit:"m3",basis:"incremental",criterion:"confirmed 20 this week"},"weekly");await f.command("commitment.publish",{},"weekly");await f.command("commitment.change",{action:"cancel",reason:"coordination"},"weekly");const metrics=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time());assert.equal(metrics.metrics.find(v=>v.id==="weekly-commitment")!.denominator,1);assert.equal(metrics.metrics.find(v=>v.id==="confirmed-progress")!.value,null);assert.equal(f.record(f.snapshot(),"weekly").originalDueDate,"2026-10-09");
 }finally{f.close();}
});

test("check copy drops signatures, failed checks are complete but not ready and review rounds remain",async()=>{
 const f=fixture();try{await f.task();await f.command("check.create",{name:"precheck",taskId:"task-a",businessDate:"2026-10-08",items:[{id:"item",name:"approved",required:true}]},"check");await f.command("check.record",{items:[{id:"item",result:"fail",evidenceIds:[]}]},"check");await f.command("check.confirm",{},"check");assert.equal(f.record(f.snapshot(),"check").satisfied,false);assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time()).metrics.find(v=>v.id==="precheck-completion")!.value,100);
 await f.command("check.copy",{sourceId:"check",businessDate:"2026-10-09"},"copy");assert.equal(f.record(f.snapshot(),"copy").confirmedAt,undefined);assert.equal((f.record(f.snapshot(),"copy").items as {result:string}[])[0].result,"pending");
 await f.command("issue.create",{name:"quality defect",kind:"quality",taskId:"task-a",checkId:"check"},"issue");await f.command("issue.assign",{ownerId:"local-owner",dueDate:"2026-10-09"},"issue");for(const passed of [false,true]){await f.command("issue.submit",{description:"rectified",evidenceIds:[]},"issue");await f.command("issue.review",{passed,reason:passed?"verified":"rework"},"issue");}assert.equal((f.record(f.snapshot(),"issue").rounds as unknown[]).length,2);assert.equal(f.record(f.snapshot(),"issue").status,"closed");
 }finally{f.close();}
});

test("two safety events retain distinct original point snapshots when source point changes",async()=>{
 const f=fixture();try{await f.command("issue.create",{name:"first",kind:"safety",riskPointId:"risk-a"},"event-1");await f.command("issue.create",{name:"second",kind:"safety",riskPointId:"risk-a"},"event-2");const a=f.record(f.snapshot(),"event-1");assert.deepEqual(a.positionSnapshot,f.record(f.snapshot(),"event-2").positionSnapshot);assert.notEqual(a.id,f.record(f.snapshot(),"event-2").id);await rejects(f.command("issue.create",{name:"fake",kind:"safety",positionSnapshot:{x:1}},"invalid"),"UNVERIFIED_POSITION");
 }finally{f.close();}
});

test("inspection file registration is not a completion and missing files cannot count as evidence",async()=>{
 const f=fixture();try{await f.task();await f.command("inspection.create",{name:"run",taskId:"task-a",ownerId:"local-owner",dueDate:"2026-10-08"},"run");await rejects(f.command("inspection.confirm",{},"run"),"INVALID_STATE");await f.command("inspection.record",{result:"observed",evidenceIds:[]},"run");await rejects(f.command("inspection.confirm",{},"run"),"EVIDENCE_REQUIRED");await rejects(f.command("inspection.record",{result:"observed",evidenceIds:["missing"]},"run"),"RECORD_NOT_FOUND");await f.command("evidence.register",{recordId:"known-file",fileKey:"document"},"evidence");await f.command("inspection.record",{result:"observed",evidenceIds:["evidence"]},"run");await f.command("inspection.confirm",{},"run");assert.equal(f.record(f.snapshot(),"run").status,"confirmed");
 }finally{f.close();}
});

test("materials require separate receipt, acceptance and evidence-backed valid test; equipment conflicts identify tasks",async()=>{
 const f=fixture();try{await f.task();await f.command("batch.create",{name:"concrete",batchNumber:"cpu-1",unit:"m3"},"batch");await f.command("batch.receive",{quantity:50,businessDate:"2026-10-08"},"batch");await f.command("need.create",{name:"material",taskId:"task-a",kind:"material",quantity:10,unit:"m3",dueDate:"2026-10-09"},"need");await rejects(f.command("need.confirm",{batchId:"batch",basis:"delivered"},"need"),"BATCH_NOT_ACCEPTED");await f.command("batch.accept",{passed:true,basis:"receipt check"},"batch");await rejects(f.command("need.confirm",{batchId:"batch",basis:"accepted"},"need"),"TEST_NOT_VALID");
 await f.command("evidence.register",{recordId:"known-file",fileKey:"document"},"report");await f.command("test.create",{name:"strength",batchId:"batch",businessDate:"2026-10-08",result:"pass",evidenceIds:["report"]},"test");await f.command("test.confirm",{result:"pass",evidenceIds:["report"]},"test");await f.command("need.confirm",{batchId:"batch",basis:"qualified"},"need");assert.equal(f.record(f.snapshot(),"need").status,"confirmed");
 await f.command("resource.create",{name:"crane",kind:"equipment"},"crane");await f.command("allocation.create",{resourceId:"crane",taskId:"task-a",startsAt:"2026-10-08T00:00:00Z",endsAt:"2026-10-08T03:00:00Z"},"slot");await rejects(f.command("allocation.create",{resourceId:"crane",taskId:"task-a",startsAt:"2026-10-08T02:00:00Z",endsAt:"2026-10-08T04:00:00Z"},"conflict"),"RESOURCE_CONFLICT");
 }finally{f.close();}
});

test("file upload references remain stable across version publication, unlinks and formal technical answers",async()=>{
 const f=fixture();try{await f.task();await f.command("evidence.register",{recordId:"known-file",fileKey:"document"},"file");await f.command("document.create",{name:"drawing",category:"drawing",taskIds:["task-a"]},"doc");await f.command("document.version",{documentId:"doc",evidenceId:"file",revisionNote:"first"},"v1");await f.command("document.publish",{basis:"approved"},"v1");await f.command("link.create",{taskId:"task-a",targetKind:"documentVersions",targetId:"v1"},"link");await f.command("document.version",{documentId:"doc",evidenceId:"file",revisionNote:"new"},"v2");assert.equal(f.record(f.snapshot(),"doc").effectiveVersionId,"v1");await f.command("document.publish",{basis:"approved revision"},"v2");assert.equal(f.record(f.snapshot(),"v1").status,"superseded");assert.equal(f.record(f.snapshot(),"link").targetId,"v1");await f.command("link.remove",{},"link");assert.equal(f.snapshot().collections.evidence.length,1);
 await f.command("technical.create",{name:"query",taskId:"task-a",ownerId:"local-owner",dueDate:"2026-10-09"},"query");await f.command("technical.comment",{text:"discussion"},"query");assert.equal(f.record(f.snapshot(),"query").status,"open");await f.command("technical.answer",{answer:"formal draft"},"query");await f.command("technical.publish",{},"query");assert.equal(f.record(f.snapshot(),"task-a").planVersion,1);
 }finally{f.close();}
});

test("D/F snapshots use historical revisions, timezone-normalized F and immutable report sources",async()=>{
 const f=fixture();try{await f.task();await f.progress("e",10);const F=f.time();await f.command("report.freeze",{name:"original",D:"2026-10-08",F},"report");const report=structuredClone(f.record(f.snapshot(),"report"));f.setTime("2026-10-09T01:00:00.000Z");await f.command("progress.revise",{quantity:15,unit:"m3",businessDate:"2026-10-07",shift:"day",crew:"crew-a",measurementKey:"e",reason:"correction"},"e");await f.command("progress.submit",{},"e");await f.command("progress.confirm",{},"e");assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-08","2026-10-08T09:00:00+08:00").taskProgress[0].quantity,10);assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time()).taskProgress[0].quantity,15);assert.deepEqual(f.record(f.snapshot(),"report"),report);assert.ok((report.sourceRevisions as unknown[]).length>0);f.reopen();assert.deepEqual(f.record(f.snapshot(),"report"),report);
 }finally{f.close();}
});

test("server sessions deny forged roles, missing cookies after bootstrap and direct resource escapes",async()=>{
 const f=fixture(),server=createServer((req,res)=>{void f.store.accessMiddleware(req,res,()=>{void f.store.middleware(req,res,()=>{res.end("protected source");});});});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;let cookie="";
 const send=async(path:string,method="GET",payload?:unknown,withCookie=true)=>fetch(base+path,{method,headers:{"content-type":"application/json","x-cesium-library":"1",...(cookie&&withCookie?{cookie}:{}),"x-role":"owner"},body:payload===undefined?undefined:JSON.stringify(payload)});
 try{let response=await send("/__management/commands","POST",{projectId:"safety:project",type:"member.save",idempotencyKey:"bootstrap",payload:{username:"owner",displayName:"Owner",password:"Cpu-Test-Secret-123",roles:["owner"]}});assert.equal(response.status,200);cookie=response.headers.get("set-cookie")!.split(";")[0];response=await send("/__management/commands","POST",{projectId:"safety:project",type:"member.save",idempotencyKey:"add-viewer",payload:{username:"reader",displayName:"Reader",password:"Cpu-Reader-Secret-123",roles:["viewer"],resourceAccess:{models:false,files:false,media:false}}});assert.equal(response.status,200);
 response=await send("/__management/commands","POST",{projectId:"safety:project",type:"member.save",expectedRevision:1,idempotencyKey:"credential-takeover",payload:{username:"reader",displayName:"Reader",password:"Taken-Over-Secret-123",roles:["viewer"]}});assert.equal(response.status,403,"project member admin cannot seize another global account credential");
 response=await send("/__management/session","POST",{username:"reader",password:"Cpu-Reader-Secret-123"});assert.equal(response.status,200);cookie=response.headers.get("set-cookie")!.split(";")[0];response=await send("/__management/commands","POST",{projectId:"safety:project",type:"task.create",idempotencyKey:"forged",payload:{name:"forged",role:"owner"}});assert.equal(response.status,403);
 for(const path of ["/__local_tiles/files/model/tile.b3dm","/__library/files/model/tiles/child.glb","/__library/files/cad/preview/a.png","/project-data/management.sqlite","/@fs/F:/cc/model.glb"]){response=await send(path);assert.equal(response.status,403,path);}
 response=await send("/__local_tiles/files/model/tile.b3dm","GET",undefined,false);assert.equal(response.status,401);response=await send("/__management/state?projectId=safety:project","GET",undefined,false);assert.equal(response.status,401);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});


test("unknown or cross-project spatial callbacks never authorize a task association",async()=>{
 for(const source of [null,{id:"bad",projectId:"other-project",kind:"construction-area"}]){
  const f=fixture({resolveSpatialReference:async()=>source});try{await rejects(f.task("t",{areaIds:["bad"]}),"SPATIAL_NOT_FOUND");assert.equal(f.snapshot().collections.tasks.length,0);}finally{f.close();}
 }
});

test("a passing recheck releases readiness but cannot rewrite the first acceptance result",async()=>{
 const f=fixture();try{await f.task();await f.command("check.create",{name:"acceptance",purpose:"acceptance",taskId:"task-a",businessDate:"2026-10-07",inspectionObjectId:"pier-1",items:[{id:"a",name:"dimension",required:true}]},"first");await f.command("check.record",{items:[{id:"a",result:"fail"}]},"first");await f.command("check.confirm",{},"first");await rejects(f.command("task.start",{},"task-a"),"CHECK_NOT_PASSED");await f.command("check.copy",{sourceId:"first",businessDate:"2026-10-08"},"recheck");await f.command("check.record",{items:[{id:"a",result:"pass"}]},"recheck");await f.command("check.confirm",{},"recheck");await f.command("task.start",{},"task-a");const metrics=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time());assert.equal(metrics.metrics.find(v=>v.id==="first-quality-pass")!.value,0);assert.equal(metrics.metrics.find(v=>v.id==="precheck-completion")!.denominator,0,"acceptance does not count as a preconstruction check");
 }finally{f.close();}
});

test("new failed material test invalidates previously confirmed task readiness in the same transaction",async()=>{
 const f=fixture();try{await f.task();await f.command("evidence.register",{recordId:"known-file",fileKey:"document"},"report");await f.command("batch.create",{name:"batch",batchNumber:"1",unit:"m3"},"batch");await f.command("batch.receive",{quantity:30,businessDate:"2026-10-08"},"batch");await f.command("batch.accept",{passed:true,basis:"accepted"},"batch");await f.command("need.create",{name:"need",taskId:"task-a",kind:"material",quantity:10,unit:"m3",dueDate:"2026-10-09"},"need");
 for(const result of ["pass","fail"]){const id=`test-${result}`;await f.command("test.create",{name:id,batchId:"batch",businessDate:"2026-10-08",result,evidenceIds:["report"]},id);await f.command("test.confirm",{result,evidenceIds:["report"]},id);if(result==="pass")await f.command("need.confirm",{batchId:"batch",basis:"qualified"},"need");}
 assert.equal(f.record(f.snapshot(),"need").status,"unconfirmed");assert.equal(f.record(f.snapshot(),"batch").availableQuantity,0);assert.equal(f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time()).metrics.find(v=>v.id==="resource-readiness")!.value,0);await rejects(f.command("task.start",{},"task-a"),"TASK_NOT_READY");
 }finally{f.close();}
});


test("independent document anchors preserve geometry, enforce model versions and link an existing file without risk records",async()=>{
 const model=modelRegistryFixture(),f=fixture({modelRegistry:[model]});try{const point=spatialV3Fixture("risk-point");assert.equal(point.geometry.type,"Point");if(point.geometry.type!=="Point")return;const anchor=point.source.vertices[0].anchor!;
 await f.command("anchor.create",{name:"drawing location",purpose:"document",anchor,position:point.geometry.position},"anchor");assert.deepEqual(f.record(f.snapshot(),"anchor").anchor,anchor);assert.equal(f.snapshot().collections.issues.length,0);
 await f.command("evidence.register",{recordId:"known-file",fileKey:"document"},"file");await f.command("link.create",{anchorId:"anchor",targetKind:"evidence",targetId:"file"},"anchor-link");assert.equal(f.record(f.snapshot(),"anchor-link").anchorId,"anchor");
 await rejects(f.command("anchor.update",{name:"changed",purpose:"document",anchor:{...anchor,model:{...anchor.model,assetVersion:"stale"}},position:point.geometry.position},"anchor"),"MODEL_VERSION_CONFLICT");
 await rejects(f.command("anchor.update",{name:"changed",purpose:"document",anchor,position:{...point.geometry.position,height:point.geometry.position.height+50}},"anchor"),"ANCHOR_COORDINATE_MISMATCH");assert.deepEqual(f.record(f.snapshot(),"anchor").anchor,anchor);
 }finally{f.close();}
});


test("spatial references freeze ledger revision and geometry hashes without numbering or rewriting historical geometry", async () => {
 const f=fixture();try{
  await f.task("bound-task",{areaIds:["risk-a"]});
  const initial=f.record(f.snapshot(),"bound-task"),references=initial.spatialReferences as Array<Record<string,unknown>>;
  assert.equal(references[0].revision,null);assert.equal(references[0].revisionStatus,"historical-unnumbered");
  assert.equal(references[0].ledgerVersion,1);assert.equal(references[0].ledgerRevision,1);assert.match(String(references[0].geometrySha256),/^[a-f0-9]{64}$/);
  await f.command("issue.create",{name:"observed",kind:"safety",riskPointId:"risk-a"},"captured-issue");
  const captured=f.record(f.snapshot(),"captured-issue").positionSnapshot as {reference:Record<string,unknown>};
  assert.deepEqual(captured.reference,references[0]);
  const cutoff=f.time();f.setTime("2026-10-09T01:00:00.000Z");
  await f.command("report.freeze",{name:"fixed source",D:"2026-10-08",F:cutoff},"frozen-source");
  const frozen=f.record(f.snapshot(),"frozen-source");assert.deepEqual(frozen.spatialReferences,references);
  assert.deepEqual((frozen.sourceRevisions as Array<{id:string;data:Record<string,unknown>}>).find(v=>v.id==="bound-task")!.data.spatialReferences,references);
  f.reopen();assert.deepEqual(f.record(f.snapshot(),"frozen-source").spatialReferences,references);
 }finally{f.close();}
});
