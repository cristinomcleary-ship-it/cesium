import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import type { ManagementCommand,ManagementMetrics } from "../../src/managementTypes.ts";
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"cesium-dashboard-metrics-"));let time="2026-10-08T08:00:00.000Z",sequence=0;const store=createManagementStore({dataDir:dir,libraryDataDir:dir,now:()=>time});
 const command=async(type:ManagementCommand["type"],id:string,payload:Record<string,unknown>)=>{const state=store.load("safety:project",store.localActor()),current=Object.values(state.collections).flat().find(v=>v.id===id);return store.command({projectId:"safety:project",type,id,payload,expectedRevision:current?.revision,idempotencyKey:`metric-${++sequence}`},store.localActor());};
 return {store,command,time:()=>time,setTime:(v:string)=>{time=v;},close:()=>{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+"cesium-dashboard-metrics-"));rmSync(dir,{recursive:true,force:true});}};
}
const cards=(metrics:ManagementMetrics)=>Object.fromEntries(metrics.dashboard.map(m=>[m.id,{value:m.value,ids:m.detailIds}]));

test("homepage four cards preserve ten formulas and use exact historical F with deduplicated drilldowns",async()=>{
 const f=fixture();try{
  for(const key of ["late","future","draft"]){await f.command("task.create",key,{name:key,ownerId:"local-owner",planStart:"2026-10-05",planEnd:key==="future"?"2026-10-10":"2026-10-07",targetQuantity:10,unit:"m",weight:1});if(key!=="draft")await f.command("task.publish",key,{});}
  await f.command("resource.create","crew",{name:"Crew",kind:"crew"});
  for(const [id,taskId,dueDate,required]of [["near1","late","2026-10-08",true],["near2","late","2026-10-09",true],["far","future","2026-10-16",true],["optional","future","2026-10-09",false]] as const)await f.command("need.create",id,{name:id,taskId,kind:"crew",resourceId:"crew",dueDate,required});
  await f.command("action.create","task-action",{name:"Coordinate access",taskId:"late",ownerId:"local-owner",dueDate:"2026-10-09"});await f.command("action.create","project-action",{name:"Unscoped coordination",ownerId:"local-owner",dueDate:"2026-10-09"});
  const F=f.time(),old=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",F);
  assert.equal(old.metrics.length,10);assert.deepEqual(old.dashboard.map(m=>m.id),["confirmed-progress","delayed-tasks","unready-resource-tasks","pending-coordination"]);assert.deepEqual({...old.dashboard[0],detailRecords:undefined},{...old.metrics.find(m=>m.id==="confirmed-progress"),detailRecords:undefined});
  assert.deepEqual(cards(old),{"confirmed-progress":{value:null,ids:["late","future"]},"delayed-tasks":{value:1,ids:["late"]},"unready-resource-tasks":{value:1,ids:["late"]},"pending-coordination":{value:2,ids:["task-action","project-action"]}});
  f.setTime("2026-10-09T08:00:00.000Z");for(const id of ["near1","near2"])await f.command("need.confirm",id,{basis:"verified arrived"});await f.command("action.complete","task-action",{result:"access coordinated"});await f.command("task.request-completion","late",{});await f.command("task.confirm-completion","late",{});
  const historical=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",F);assert.deepEqual(cards(historical),cards(old),"late confirmations must not contaminate the original F");
  assert.equal(historical.dashboard.find(m=>m.id==="pending-coordination")!.detailRecords!.find(r=>r.record.id==="task-action")!.record.status,"open","historical drilldown retains the original open state after current completion");assert.equal(historical.dashboard.find(m=>m.id==="delayed-tasks")!.detailRecords![0].record.status,"published");
  const current=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",f.time());assert.deepEqual(current.dashboard.slice(1).map(m=>m.value),[0,0,1]);
  for(const metric of current.dashboard.slice(1))assert.equal(metric.value,metric.detailIds.length,"count equals exact drilldown cardinality");
  const filtered=f.store.metrics("safety:project",f.store.localActor(),"2026-10-08",F,{taskIds:["future"]});assert.deepEqual(filtered.dashboard.slice(1).map(m=>m.value),[0,0,0],"task filters must not include unrelated or project-wide actions");
 }finally{f.close();}
});

test("actual HTTP dashboard metrics apply authenticated task scope and selected filters to the same IDs",async()=>{
 const f=fixture();const server=createServer((req,res)=>void f.store.accessMiddleware(req,res,()=>void f.store.middleware(req,res,()=>{res.statusCode=404;res.end();})));await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;let cookie="",n=0;
 const request=async(path:string,payload?:unknown)=>{const r=await fetch(base+path,{method:payload?"POST":"GET",headers:{"Content-Type":"application/json","X-Cesium-Library":"1",cookie},body:payload?JSON.stringify(payload):undefined});return{status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")};};
 const command=(type:string,payload:Record<string,unknown>)=>request("/__management/commands",{projectId:"safety:project",type,payload,idempotencyKey:`http-dashboard-${++n}`});
 try{
  for(const key of ["allowed","private"]){await f.command("task.create",key,{name:key,ownerId:"local-owner",planStart:"2026-10-05",planEnd:"2026-10-07"});await f.command("task.publish",key,{});await f.command("action.create",`action-${key}`,{name:key,taskId:key,ownerId:"local-owner",dueDate:"2026-10-09"});}
  let r=await command("member.save",{username:"owner",displayName:"Owner",password:"Dashboard-Only-Password",roles:["owner"]});assert.equal(r.status,200);cookie=r.cookie!.split(";")[0];r=await command("member.save",{username:"scoped",displayName:"Scoped",password:"Dashboard-Only-Password",roles:["viewer"],taskIds:["allowed"]});assert.equal(r.status,200);
  r=await request("/__management/session",{username:"scoped",password:"Dashboard-Only-Password"});cookie=r.cookie!.split(";")[0];
  const query="/__management/metrics?D=2026-10-08&F=2026-10-08T08%3A00%3A00Z";r=await request(query);assert.equal(r.status,200);const metrics=r.data as ManagementMetrics;
  assert.deepEqual(metrics.dashboard.find(m=>m.id==="delayed-tasks")!.detailIds,["allowed"]);assert.deepEqual(metrics.dashboard.find(m=>m.id==="pending-coordination")!.detailIds,["action-allowed"]);assert.equal(JSON.stringify(metrics).includes("private"),false);
  r=await request(query+"&taskId=private");assert.equal(r.status,200);assert.deepEqual((r.data as ManagementMetrics).dashboard.slice(1).map(m=>m.value),[0,0,0]);
  assert.equal((await request("/__management/records/actions/action-private")).status,403);
 }finally{await new Promise<void>(done=>server.close(()=>done()));f.close();}
});
