import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { createManagementStore,ManagementError } from "../managementStore.ts";
import type { ManagementCommand,ManagementRecord,ManagementSnapshot } from "../../src/managementTypes.ts";

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"cesium-usage-")),sentinel=join(dir,"safety-spatial.json"),bytes='{"version":1,"revision":9,"objects":[]}';writeFileSync(sentinel,bytes);
 let now="2026-10-08T08:00:00.000Z",sequence=0,store=createManagementStore({dataDir:dir,libraryDataDir:dir,now:()=>now});
 const command=(type:ManagementCommand["type"],id:string,payload:Record<string,unknown>,expectedRevision?:number,key?:string)=>store.command({projectId:"safety:project",type,id,payload,expectedRevision,idempotencyKey:key||`usage-${++sequence}`},store.localActor());
 const snapshot=()=>store.load("safety:project",store.localActor());
 return{dir,command,snapshot,get store(){return store;},setTime:(value:string)=>{now=value;},reopen:()=>{store.close();store=createManagementStore({dataDir:dir,libraryDataDir:dir,now:()=>now});},close:()=>{store.close();assert.equal(readFileSync(sentinel,"utf8"),bytes,"original geometry ledger untouched");assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+"cesium-usage-"));rmSync(dir,{recursive:true,force:true});}};
}
const actual={taskId:"task",resourceId:"crew",quantity:7,unit:"人",businessDate:"2026-10-08",startAt:"2026-10-08T08:00:00+08:00",endAt:"2026-10-08T10:30:00+08:00",description:"现场核对实际到场人员及作业时段"};
const find=(state:ManagementSnapshot,id:string)=>Object.values(state.collections).flat().find(v=>v.id===id)!;
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,e=>e instanceof ManagementError&&e.code===code);

test("actual attendance is independent of planned allocation and readiness; confirmation is revisioned, idempotent and persistent",async()=>{
 const f=fixture();try{
  await f.command("task.create","task",{name:"Actual attendance task"});await f.command("resource.create","crew",{name:"Crew A",kind:"crew",quantity:20,unit:"人"});
  await f.command("allocation.create","allocation",{taskId:"task",resourceId:"crew",startsAt:"2026-10-08T01:00:00Z",endsAt:"2026-10-08T06:00:00Z"});
  await f.command("need.create","need",{name:"Planned crew",taskId:"task",resourceId:"crew",kind:"crew",quantity:15,unit:"人",dueDate:"2026-10-08"});
  const before=structuredClone(f.snapshot());assert.equal(before.collections.resourceUsage.length,0,"plans never synthesize actual use");
  const payload={...actual,allocationId:"allocation",status:"confirmed",recordedBy:"forged",confirmedAt:"2000-01-01T00:00:00Z"};
  await f.command("usage.create","usage",payload,undefined,"create-retry");await f.command("usage.create","usage",payload,undefined,"create-retry");
  let usage=find(f.snapshot(),"usage");assert.equal(f.snapshot().collections.resourceUsage.length,1);assert.deepEqual([usage.status,usage.revision,usage.quantity,usage.recordedBy,usage.confirmedAt],["recorded",1,7,"local-owner",undefined]);
  assert.equal(usage.startAt,"2026-10-08T00:00:00.000Z");assert.equal(usage.endAt,"2026-10-08T02:30:00.000Z");assert.equal(usage.resourceRevision,1);assert.equal(usage.allocationRevision,1);
  await rejects(f.command("usage.confirm","usage",{basis:"checked"},0),"REVISION_CONFLICT");
  f.setTime("2026-10-09T08:00:00.000Z");await f.command("usage.confirm","usage",{basis:"班组负责人逐项复核",quantity:999},1,"confirm-retry");await f.command("usage.confirm","usage",{basis:"班组负责人逐项复核",quantity:999},1,"confirm-retry");
  usage=find(f.snapshot(),"usage");assert.deepEqual([usage.status,usage.revision,usage.quantity,usage.confirmedBy],["confirmed",2,7,"local-owner"]);assert.equal(usage.confirmationBasis,"班组负责人逐项复核");
  await rejects(f.command("usage.confirm","usage",{basis:"double confirm"},2),"INVALID_STATE");
  for(const key of ["tasks","resources","resourceNeeds","allocations"] as const)assert.deepEqual(f.snapshot().collections[key],before.collections[key],key+" unchanged");
  await f.command("report.freeze","report",{name:"Before confirmation",D:"2026-10-08",F:"2026-10-08T08:00:00Z"});const report=find(f.snapshot(),"report");assert.equal((report.sourceRevisions as ManagementRecord[]).find(v=>v.id==="usage")?.revision,1,"historical F never imports later confirmation");
  assert.equal(f.snapshot().audit.filter(v=>v.recordId==="usage").length,2);f.reopen();assert.deepEqual(find(f.snapshot(),"usage"),usage);
 }finally{f.close();}
});

test("actual-use registration rejects false relationships, invalid times and missing evidence without partial writes",async()=>{
 const f=fixture();try{
  await f.command("task.create","task",{name:"Task"});await f.command("task.create","other",{name:"Other"});
  await f.command("resource.create","crew",{name:"Crew",kind:"crew"});await f.command("resource.create","crane",{name:"Crane",kind:"equipment"});await f.command("resource.create","material",{name:"Concrete",kind:"material"});
  await f.command("allocation.create","foreign",{taskId:"other",resourceId:"crew",startsAt:"2026-10-08T01:00:00Z",endsAt:"2026-10-08T02:00:00Z"});
  const cases:[Record<string,unknown>,string][]=[ [{allocationId:"foreign"},"ALLOCATION_MISMATCH"],[{resourceId:"material"},"RESOURCE_USAGE_KIND"],[{quantity:0},"INVALID_NUMBER"],[{endAt:actual.startAt},"DATE_CONFLICT"],[{endAt:"2026-10-09T01:00:00Z"},"ACTUAL_TIME_FUTURE"],[{startAt:"2026-10-08T01:00:00"},"INVALID_TIME"],[{evidenceIds:["missing"]},"RECORD_NOT_FOUND"],[{description:" "},"INVALID_FIELD"] ];
  const version=f.snapshot().revision;for(let i=0;i<cases.length;i++)await rejects(f.command("usage.create",`invalid-${i}`,{...actual,...cases[i][0]}),cases[i][1]);assert.equal(f.snapshot().revision,version);assert.equal(f.snapshot().collections.resourceUsage.length,0);
  await f.command("usage.create","equipment-use",{...actual,resourceId:"crane",quantity:1,unit:"台",description:"吊机已实际投入作业"});assert.equal(find(f.snapshot(),"equipment-use").kind,"equipment");
  await rejects(f.command("usage.confirm","equipment-use",{basis:"checked",evidenceIds:["missing"]},1),"RECORD_NOT_FOUND");assert.equal(find(f.snapshot(),"equipment-use").revision,1);
 }finally{f.close();}
});

test("real HTTP actual-use workflow uses resource roles, scoped tasks, uploaded evidence and immutable source data",async()=>{
 const f=fixture();const server=createServer((req,res)=>void f.store.accessMiddleware(req,res,()=>void f.store.middleware(req,res,()=>{res.statusCode=404;res.end();})));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;let cookie="",n=0;
 const request=async(url:string,payload?:unknown,method=payload?"POST":"GET")=>{const r=await fetch(base+url,{method,headers:{"content-type":"application/json","x-cesium-library":"1",...(cookie?{cookie}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});return{status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")};};
 const command=async(type:string,id:string|undefined,payload:Record<string,unknown>,revision?:number)=>request("/__management/commands",{projectId:"safety:project",type,id,payload,expectedRevision:revision,idempotencyKey:`http-use-${++n}`});
 try{
  for(const id of ["task","other"])assert.equal((await command("task.create",id,{name:id})).status,200);assert.equal((await command("resource.create","crew",{name:"Crew",kind:"crew"})).status,200);
  const boot=await command("member.save",undefined,{username:"owner",displayName:"Test owner",password:"Actual-Use-Test-Owner",roles:["owner"]});assert.equal(boot.status,200);cookie=boot.cookie!.split(";")[0];
  for(const roles of [["resource"],["worker"]])assert.equal((await command("member.save",undefined,{username:roles[0],displayName:roles[0],password:"Actual-Use-Test-Role",roles,taskIds:["task"]})).status,200);
  assert.equal((await command("need.create","scoped-crew-need",{name:"Authorized crew",taskId:"task",kind:"crew",resourceId:"crew",dueDate:"2026-10-10"})).status,200);
  const upload=await fetch(base+"/__management/uploads?name=attendance.txt&taskId=task",{method:"POST",headers:{"content-type":"text/plain","x-cesium-library":"1",cookie},body:"Actual-use isolated evidence"});assert.equal(upload.status,201);const evidence=await upload.json() as ManagementRecord;
  let login=await request("/__management/session",{username:"worker",password:"Actual-Use-Test-Role"});cookie=login.cookie!.split(";")[0];assert.equal((await command("usage.create","forbidden",actual)).status,403);
  login=await request("/__management/session",{username:"resource",password:"Actual-Use-Test-Role"});cookie=login.cookie!.split(";")[0];const denied=await command("usage.create","cross-task",{...actual,taskId:"other"});assert.equal(denied.status,403);assert.equal(denied.data.code,"TASK_FORBIDDEN");
  let reply=await command("usage.create","http-usage",{...actual,evidenceIds:[evidence.id]});assert.equal(reply.status,200,JSON.stringify(reply.data));let usage=find(reply.data,"http-usage");assert.equal(usage.status,"recorded");assert.equal(usage.recordedBy,reply.data.session.userId);
  const stale=await command("usage.confirm","http-usage",{basis:"bad version"},0);assert.equal(stale.status,409);assert.equal(stale.data.code,"REVISION_CONFLICT");
  reply=await command("usage.confirm","http-usage",{basis:"负责人核验实际到场"},1);assert.equal(reply.status,200,JSON.stringify(reply.data));usage=find(reply.data,"http-usage");assert.equal(usage.status,"confirmed");assert.deepEqual(usage.evidenceIds,[evidence.id]);assert.equal(usage.revision,2);
  assert.equal((await request("/__management/records/resourceUsage/http-usage")).data.confirmedBy,reply.data.session.userId);
  f.reopen();assert.deepEqual((await request("/__management/records/resourceUsage/http-usage")).data,usage,"actual SQLite close/reopen preserves confirmed record and active role session");
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});
