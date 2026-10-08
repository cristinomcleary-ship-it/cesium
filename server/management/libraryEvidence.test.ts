import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { createLibraryEvidenceResolver } from "./libraryEvidence.ts";
import { createManagementStore } from "../managementStore.ts";
async function fixture() {
 const parent=resolve("tmp/management-evidence-tests");await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,"case-")),recordDir=join(dir,"records","video-source");
 await mkdir(join(recordDir,"video"),{recursive:true});const name="原始录像.mp4",bytes=Buffer.from("isolated original video bytes"),url="/__library/files/video-source/video/"+encodeURIComponent(name);
 await writeFile(join(recordDir,"video",name),bytes);const record={version:1,id:"video-source",kind:"Drone Video",name:"isolated",files:{video:{name,url}}};const recordPath=join(recordDir,"record.json");await writeFile(recordPath,JSON.stringify(record));
 return {dir,recordDir,record,recordPath,bytes,url,name,resolver:createLibraryEvidenceResolver(dir,"safety:project"),close:async()=>{assert.ok(resolve(dir).startsWith(parent+sep));await rm(dir,{recursive:true,force:true});}};
}
test("default real manifest adapter resolves encoded names and completes uploaded screenshot registration without modifying source",async()=>{
 const f=await fixture(),store=createManagementStore({dataDir:f.dir,libraryDataDir:f.dir});const server=createServer((req,res)=>void store.middleware(req,res,()=>{res.statusCode=404;res.end();}));await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  const metadata=await readFile(f.recordPath,"utf8");assert.deepEqual(await f.resolver("safety:project","video-source","video"),{name:f.name,url:f.url,size:f.bytes.length,requiredPermission:"media"});
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2r8AAAAASUVORK5CYII=","base64");
  const upload=await fetch(base+"/__management/upload?name=frame.png",{method:"POST",headers:{"Content-Type":"image/png","X-Cesium-Library":"1"},body:png});assert.equal(upload.status,201);const file=await upload.json();
  const capture=await fetch(base+"/__management/commands",{method:"POST",headers:{"Content-Type":"application/json","X-Cesium-Library":"1"},body:JSON.stringify({projectId:"safety:project",type:"evidence.register",id:"capture",idempotencyKey:"capture",payload:{fileId:file.id,sourceRecordId:"video-source",mediaId:"video:video-source",mediaSeconds:3.2}})});assert.equal(capture.status,200,JSON.stringify(await capture.clone().json()));const result=await capture.json(),saved=result.collections.evidence.find((e:{id:string})=>e.id==="capture");assert.equal(saved.mediaSeconds,3.2);assert.equal(saved.sourceRecordId,"video-source");assert.equal(saved.sha256,file.sha256);assert.equal(saved.size,png.length);
  assert.equal(await readFile(f.recordPath,"utf8"),metadata);assert.deepEqual(await readFile(join(f.recordDir,"video",f.name)),f.bytes);
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));store.close();await f.close();}
});
test("manifest adapter rejects unknown slot, foreign project, tombstone, traversal, mismatched identity and absent bytes",async()=>{
 const f=await fixture();try{
  assert.equal(await f.resolver("another-project","video-source","video"),undefined);assert.equal(await f.resolver("safety:project","video-source","../video"),undefined);assert.equal(await f.resolver("safety:project","video-source","missing"),undefined);
  for(const changed of [{...f.record,id:"other"},{...f.record,kind:"CAD"},{...f.record,files:{video:{name:f.name,url:"/__library/files/video-source/video/%2e%2e/record.json"}}},{...f.record,files:{video:{name:f.name,url:"/__library/files/other/video/data.mp4"}}},{...f.record,files:{video:{name:f.name,url:"/__library/files/video-source/video/missing.mp4"}}}]){await writeFile(f.recordPath,JSON.stringify(changed));assert.equal(await f.resolver("safety:project","video-source","video"),undefined);}
  await writeFile(f.recordPath,JSON.stringify(f.record));await mkdir(join(f.dir,"deleted"));await writeFile(join(f.dir,"deleted","video-source.json"),"{}");assert.equal(await f.resolver("safety:project","video-source","video"),undefined);
 }finally{await f.close();}
});
test("manifest adapter rejects a slot junction leaving the committed record directory",async()=>{
 const f=await fixture();try{
  const external=join(f.dir,"unregistered-files");await mkdir(external);await writeFile(join(external,"secret.mp4"),"isolated secret");await symlink(external,join(f.recordDir,"escaped"),process.platform==="win32"?"junction":"dir");await writeFile(f.recordPath,JSON.stringify({...f.record,files:{escaped:{name:"secret.mp4",url:"/__library/files/video-source/escaped/secret.mp4"}}}));assert.equal(await f.resolver("safety:project","video-source","escaped"),undefined);
 }finally{await f.close();}
});
