import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import type { ManagementCommandType } from "../../src/managementTypes.ts";
const projectId = "safety:project";
async function fixture(removeOwnedFile?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "file-lifecycle-"));
  let store: ReturnType<typeof createManagementStore>, server: Server, base = "", sequence = 0;
  async function start() { store = createManagementStore({ dataDir: root, libraryDataDir: root, removeOwnedFile }); server = createServer((req,res) => void store.accessMiddleware(req,res,() => void store.middleware(req,res,() => {res.statusCode=404;res.end();}))); await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`; }
  async function stop() { server.closeAllConnections(); await new Promise<void>(done=>server.close(()=>done()));store.close(); }
  async function request(path:string,method="GET",data?:unknown,cookie="") { const response=await fetch(base+path,{method,headers:{"X-Cesium-Library":"1","Content-Type":"application/json",cookie},body:data===undefined?undefined:JSON.stringify(data)}); return {status:response.status,data:await response.json() as any, cookie:response.headers.get("set-cookie")?.split(";")[0]}; }
  const command=(type:ManagementCommandType,payload:Record<string,unknown>,key?:string,revision?:number)=>request("/__management/commands","POST",{type,projectId,payload,id:key,expectedRevision:revision,idempotencyKey:`command-${++sequence}`});
  async function upload(category?:string,refs?:unknown){const query=new URLSearchParams({projectId,name:"机械资料.pdf"});if(category)query.set("machineryDocumentCategory",category);if(refs!==undefined)query.set("objectRefs",JSON.stringify(refs));const response=await fetch(base+"/__management/upload?"+query,{method:"POST",headers:{"X-Cesium-Library":"1","Content-Type":"application/pdf"},body:"isolated PDF content"});return {status:response.status,data:await response.json() as any};}
  const remove=(id:string,revision=1,cookie="")=>request(`/__management/files/${id}?projectId=${projectId}`,"DELETE",{expectedRevision:revision},cookie);
  await start();return {root,request,command,upload,remove,async restart(){await stop();await start();},async close(){await stop();rmSync(root,{recursive:true,force:true});}};
}

test("four machinery document categories persist, filter by machine, delete bytes and do not reappear after restart",async()=>{
 const f=await fixture();try{
  assert.equal((await f.command("resource.create",{name:"吊机A",kind:"equipment"},"a")).status,200);
  assert.equal((await f.command("resource.create",{name:"吊机B",kind:"equipment"},"b")).status,200);
  const records=[];for(const category of ["performance","certificate","inspection","submission"]){const result=await f.upload(category,[{kind:"resources",id:"a"}]);assert.equal(result.status,201);assert.equal(result.data.machineryDocumentCategory,category);records.push(result.data);}
  const other=await f.upload("certificate",[{kind:"resources",id:"b"}]);assert.equal(other.status,201);
  await f.restart();const listing=await f.request(`/__management/machinery/a/documents?projectId=${projectId}`);assert.equal(listing.status,200);assert.deepEqual(listing.data.records.map((r:any)=>r.id),records.map(r=>r.id));
  assert.equal((await f.remove(records[0].id,0)).status,409);assert.equal(existsSync(join(f.root,"management-files",records[0].id)),true);
  const removed=await f.remove(records[0].id);assert.equal(removed.status,200);assert.equal(existsSync(join(f.root,"management-files",records[0].id)),false);assert.equal(existsSync(join(f.root,"management-files",other.data.id)),true);
  await f.restart();assert.equal((await f.request(`/__management/machinery/a/documents?projectId=${projectId}`)).data.records.length,3);
  assert.equal((await f.request(records[0].url)).data.code,"EVIDENCE_UNAVAILABLE");assert.equal((await f.remove(records[0].id)).status,200);
 }finally{await f.close();}
});

test("invalid categories or cross-object upload bindings cannot write managed bytes",async()=>{
 const f=await fixture();try{
  await f.command("resource.create",{name:"吊机",kind:"equipment"},"a");
  for(const [category,refs] of [["unknown",[{kind:"resources",id:"a"}]],["performance",[]],["certificate",[{kind:"resources",id:"missing"}]],["inspection",[{kind:"resources",id:"a"},{kind:"resources",id:"a"}]]] as const){assert.notEqual((await f.upload(category,refs)).status,201);}
  assert.equal(existsSync(join(f.root,"management-files")),false);
 }finally{await f.close();}
});

test("referenced documents are protected and deletion racing a new reference has a consistent outcome",async()=>{
 const f=await fixture();try{
  const file=(await f.upload()).data;assert.equal((await f.command("document.create",{name:"检测报告",category:"报告"},"doc")).status,200);
  assert.equal((await f.command("document.version",{documentId:"doc",evidenceId:file.id,revisionNote:"初版"},"version")).status,200);
  const rejected=await f.remove(file.id);assert.equal(rejected.status,409);assert.equal(rejected.data.code,"FILE_IN_USE");assert.equal(readFileSync(join(f.root,"management-files",file.id),"utf8"),"isolated PDF content");
  const racing=(await f.upload()).data;const [deleted,linked]=await Promise.all([f.remove(racing.id),f.command("document.version",{documentId:"doc",evidenceId:racing.id,revisionNote:"并发引用"},"racing-version")]);
  assert.ok(deleted.status===200&&linked.status!==200||deleted.status===409&&linked.status===200);
  assert.equal(existsSync(join(f.root,"management-files",racing.id)),linked.status===200);
 }finally{await f.close();}
});

test("physical cleanup failures are explicit, stay unavailable, and recover after restarting",async()=>{
 let blocked=true;const f=await fixture(path=>{if(blocked)throw new Error("EBUSY");unlinkSync(path);});try{
  const file=(await f.upload()).data,result=await f.remove(file.id);assert.equal(result.status,503);assert.equal(result.data.code,"FILE_DELETE_PENDING");assert.equal(result.data.details.deleted,true);assert.equal(existsSync(join(f.root,"management-files",file.id)),true);
  assert.equal((await f.request(file.url)).data.code,"EVIDENCE_UNAVAILABLE");
  blocked=false;await f.restart();assert.equal(existsSync(join(f.root,"management-files",file.id)),false);assert.equal((await f.remove(file.id)).status,200);
 }finally{await f.close();}
});

test("view-only accounts cannot delete uploaded files",async()=>{
 const f=await fixture();try{
  const file=(await f.upload()).data,password="Isolated-Test-Password-2026";
  assert.equal((await f.command("member.save",{username:"owner",displayName:"owner",password,roles:["owner"]})).status,200);
  const owner=await f.request("/__management/session","POST",{username:"owner",password,projectId});assert.ok(owner.cookie);
  assert.equal((await f.request("/__management/commands","POST",{type:"member.save",projectId,idempotencyKey:"viewer",payload:{username:"viewer",displayName:"viewer",password,roles:["viewer"]}},owner.cookie)).status,200);
  const viewer=await f.request("/__management/session","POST",{username:"viewer",password,projectId});assert.ok(viewer.cookie);
  assert.equal((await f.remove(file.id,1,viewer.cookie)).status,403);assert.equal(existsSync(join(f.root,"management-files",file.id)),true);
 }finally{await f.close();}
});


test("pending machinery deletions remain scoped and retryable after reopening while successful cleanup removes the pending entry", async () => {
 let blocked = true;
 const f = await fixture(path => { if (blocked) throw new Error("EBUSY"); unlinkSync(path); });
 try {
  await f.command("resource.create", { name: "吊机A", kind: "equipment" }, "pending-a");
  await f.command("resource.create", { name: "吊机B", kind: "equipment" }, "pending-b");
  const a = (await f.upload("certificate", [{ kind: "resources", id: "pending-a" }])).data;
  const b = (await f.upload("inspection", [{ kind: "resources", id: "pending-b" }])).data;
  assert.equal((await f.remove(a.id)).status, 503); assert.equal((await f.remove(b.id)).status, 503);
  await f.restart(); // The simulated file lock remains, including during startup recovery.
  const listing = await f.request(`/__management/machinery/pending-a/documents?projectId=${projectId}`);
  assert.equal(listing.status, 200); assert.deepEqual(listing.data.records, []);
  assert.deepEqual(listing.data.pendingDeletions.map((record: any) => record.id), [a.id]);
  assert.equal(listing.data.pendingDeletions[0].url, undefined); assert.equal(listing.data.pendingDeletions[0].storageName, undefined);
  assert.equal((await f.request(a.url)).data.code, "EVIDENCE_UNAVAILABLE");
  blocked = false;
  assert.equal((await f.remove(a.id)).status, 200);
  const refreshed = await f.request(`/__management/machinery/pending-a/documents?projectId=${projectId}`);
  assert.deepEqual(refreshed.data.pendingDeletions, []); assert.deepEqual(refreshed.data.records, []);
  assert.equal(existsSync(join(f.root, "management-files", a.id)), false);
  assert.equal(existsSync(join(f.root, "management-files", b.id)), true);
 } finally { await f.close(); }
});


test("URL-encoded equipment UUIDs load ready and pending documents without bypassing permissions or path validation", async () => {
 const machineId = "equipment:0c023d34-fdfa-4928-9fa5-49d1fe360146";
 const route = `/__management/machinery/${encodeURIComponent(machineId)}/documents?projectId=${projectId}`;
 const f = await fixture(() => { throw new Error("EBUSY"); });
 try {
  assert.equal((await f.command("resource.create", { name: "标准UI机械", kind: "equipment" }, machineId)).status, 200);
  const file = await f.upload("performance", [{ kind: "resources", id: machineId }]); assert.equal(file.status, 201);
  const ready = await f.request(route); assert.equal(ready.status, 200); assert.deepEqual(ready.data.records.map((record: any) => record.id), [file.data.id]);
  assert.equal((await f.remove(file.data.id)).status, 503); await f.restart();
  const pending = await f.request(route); assert.equal(pending.status, 200); assert.deepEqual(pending.data.records, []); assert.deepEqual(pending.data.pendingDeletions.map((record: any) => record.id), [file.data.id]);
  for (const segment of ["%E0%A4%A", "equipment%2Fsecret", "equipment%253Asecret"]) {
   const invalid = await f.request(`/__management/machinery/${segment}/documents?projectId=${projectId}`); assert.equal(invalid.status, 400); assert.equal(invalid.data.code, "INVALID_ID");
  }
  const password = "Encoded-Machinery-Password-2026";
  assert.equal((await f.command("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] })).status, 200);
  const owner = await f.request("/__management/session", "POST", { username: "owner", password, projectId }); assert.ok(owner.cookie);
  assert.equal((await f.request("/__management/commands", "POST", { type: "member.save", projectId, idempotencyKey: "no-files", payload: { username: "restricted", displayName: "Restricted", password, roles: ["viewer"], resourceAccess: { models: true, files: false, media: false } } }, owner.cookie)).status, 200);
  const restricted = await f.request("/__management/session", "POST", { username: "restricted", password, projectId }); assert.ok(restricted.cookie);
  assert.equal((await f.request(route, "GET", undefined, restricted.cookie)).status, 403);
  assert.equal((await f.request(route, "GET", undefined, owner.cookie)).data.pendingDeletions.length, 1);
 } finally { await f.close(); }
});


test("ordinary attachment cleanup survives locked restart with only authorized retry metadata in snapshots", async () => {
 let blocked = true;
 const f = await fixture(path => { if (blocked) throw new Error("EBUSY"); unlinkSync(path); });
 try {
  for (const key of ["A", "B"]) {
   assert.equal((await f.command("resource.create", { name: key, kind: "equipment" }, `equipment:${key}`)).status, 200);
   assert.equal((await f.command("task.create", { name: key, resourceIds: [`equipment:${key}`] }, key)).status, 200);
  }
  const a = (await f.upload(undefined, [{ kind: "resources", id: "equipment:A" }])).data;
  const b = (await f.upload(undefined, [{ kind: "resources", id: "equipment:B" }])).data;
  assert.equal((await f.remove(a.id)).status, 503); assert.equal((await f.remove(b.id)).status, 503);
  await f.restart();
  const snapshot = await f.request(`/__management/snapshot?projectId=${projectId}`);
  assert.equal(snapshot.status, 200); assert.deepEqual(snapshot.data.collections.evidence, []);
  assert.deepEqual(snapshot.data.pendingFileDeletions.map((record: any) => record.id).sort(), [a.id, b.id].sort());
  for (const record of snapshot.data.pendingFileDeletions) assert.deepEqual(Object.keys(record).sort(), ["id", "name", "projectId", "revision"]);
  const password = "Pending-Snapshot-Password-2026";
  assert.equal((await f.command("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] })).status, 200);
  const owner = await f.request("/__management/session", "POST", { username: "owner", password, projectId }); assert.ok(owner.cookie);
  for (const [username, fields, expected] of [
   ["viewer", { roles: ["viewer"] }, 0],
   ["nofiles", { roles: ["document"], resourceAccess: { models: true, files: false, media: false } }, 0],
   ["scoped", { roles: ["resource"], taskIds: ["A"] }, 1],
  ] as const) {
   assert.equal((await f.request("/__management/commands", "POST", { type: "member.save", projectId, idempotencyKey: username, payload: { username, displayName: username, password, ...fields } }, owner.cookie)).status, 200);
   const session = await f.request("/__management/session", "POST", { username, password, projectId }); assert.ok(session.cookie);
   const state = await f.request(`/__management/snapshot?projectId=${projectId}`, "GET", undefined, session.cookie);
   assert.equal(state.status, 200); assert.equal(state.data.pendingFileDeletions.length, expected);
   if (username === "scoped") {
    assert.equal(state.data.pendingFileDeletions[0].id, a.id);
    assert.equal((await f.remove(b.id, 1, session.cookie)).status, 403);
    blocked = false;
    const retry = await f.remove(a.id, 1, session.cookie); assert.equal(retry.status, 200); assert.deepEqual(retry.data.snapshot.pendingFileDeletions, []);
   }
  }
  assert.equal(existsSync(join(f.root, "management-files", a.id)), false); assert.equal(existsSync(join(f.root, "management-files", b.id)), true);
 } finally { await f.close(); }
});
