import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import { createProjectLibrary } from "../projectLibrary.ts";

test("real library metadata and bytes respect independently granted models, files and media",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"cesium-library-permission-")),sources=new Map<string,string>();
 for(const [id,kind] of [["model","3D Tiles"],["imagery","Imagery"],["cad","CAD"],["gis","GIS"],["video","Drone Video"],["scheme","Drone Video"]]){
  const settings=id==="scheme"?{video:{mode:"cc-overlay",version:1,schemeName:"Saved CC scheme",selectedIds:["model","cad"],sceneReference:{recordId:"model",matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},occlusion:{enabled:true,sourceId:"model"},adjustments:{cad:{east:0,north:0,up:29,heading:0}}}}:{};
  const folder=join(dir,"records",id);mkdirSync(join(folder,"data"),{recursive:true});const file=join(folder,"record.json"),value=JSON.stringify({version:1,id,kind,name:`private ${id}`,visible:false,createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z",files:{data:{name:"secret.txt",url:`/__library/files/${id}/data/secret.txt`}},settings});writeFileSync(file,value);sources.set(file,value);writeFileSync(join(folder,"data/secret.txt"),`private ${id} bytes`);
 }
 mkdirSync(join(dir,"records","corrupt"));writeFileSync(join(dir,"records/corrupt/record.json"),"broken private index");
 const view=JSON.stringify({position:[1,2,3],direction:[0,0,-1],up:[0,1,0],basemap:"none",activeVideoId:"video",activeImageryId:"imagery"});writeFileSync(join(dir,"view.json"),view);sources.set(join(dir,"view.json"),view);
 const store=createManagementStore({dataDir:dir,libraryDataDir:dir}),library=createProjectLibrary(dir,{storageRoot:dir});
 const server=createServer((req,res)=>void store.accessMiddleware(req,res,()=>void store.middleware(req,res,()=>void library.middleware(req,res,()=>{res.statusCode=404;res.end();}))));await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;let cookie="",sequence=0;
 const request=async(path:string,payload?:unknown,method=payload?"POST":"GET")=>{const r=await fetch(base+path,{method,headers:{"Content-Type":"application/json","X-Cesium-Library":"1",cookie},body:payload?JSON.stringify(payload):undefined});const text=await r.text();let data:unknown;try{data=JSON.parse(text);}catch{data=text;}return{status:r.status,data:data as Record<string,unknown>,cookie:r.headers.get("set-cookie")};};
 const command=(type:string,payload:Record<string,unknown>)=>request("/__management/commands",{projectId:"safety:project",type,idempotencyKey:`permission-${++sequence}`,payload});
 try{
  const initial=await request("/__library/records");assert.equal(initial.status,200);assert.equal((initial.data.records as unknown[]).length,6);
  const boot=await command("member.save",{username:"owner",displayName:"Owner",password:"Permission-Fixture-Only",roles:["owner"]});assert.equal(boot.status,200);cookie=boot.cookie!.split(";")[0];
  for(const name of ["models","files","media","none"]){const created=await command("member.save",{username:name,displayName:name,password:"Permission-Fixture-Only",roles:["viewer"],resourceAccess:{models:name==="models",files:name==="files",media:name==="media"}});assert.equal(created.status,200);}
  const expectations:Record<string,string[]>={models:["imagery","model"],files:["cad","gis"],media:["scheme","video"],none:[]};
  for(const [name,allowed] of Object.entries(expectations)){
   const login=await request("/__management/session",{username:name,password:"Permission-Fixture-Only"});assert.equal(login.status,200);cookie=login.cookie!.split(";")[0];
   assert.equal((await request("/__library/records/scheme/pos",{},"POST")).status,403,"POS attachment writes require admin even when this account may read media");
   const listing=await request("/__library/records");assert.equal(listing.status,200);assert.deepEqual((listing.data.records as {id:string}[]).map(r=>r.id).sort(),allowed);assert.deepEqual(listing.data.problems,[]);
   if(name==="models"){assert.equal((listing.data.view as Record<string,unknown>).activeVideoId,undefined);assert.equal((listing.data.view as Record<string,unknown>).activeImageryId,"imagery");}else assert.equal(listing.data.view,undefined);
   for(const id of ["model","imagery","cad","gis","video","scheme"]){const expected=allowed.includes(id)?200:403;const record=await request(`/__library/records/${id}`);assert.equal(record.status,expected,`${name} metadata ${id}`);if(expected===403)assert.equal(JSON.stringify(record.data).includes(`private ${id}`),false);assert.equal((await request(`/__library/files/${id}/data/secret.txt`)).status,expected,`${name} file ${id}`);}
   if(name==="media"){
    const scheme=await request("/__library/records/scheme");assert.equal(scheme.status,200);
    const settings=scheme.data.settings as {video:{selectedIds:string[];occlusion:{sourceId:string}}};
    for(const dependency of new Set([...settings.video.selectedIds,settings.video.occlusion.sourceId]))assert.equal((await request(`/__library/records/${dependency}`)).status,403,"a saved fusion reference never grants access to its engineering resource");
    assert.equal((await request("/__library/records/scheme",{settings:{video:{mode:"cc-overlay",selectedIds:[]}}},"PATCH")).status,403,"read-only media access cannot erase or auto-save a fusion plan");
    assert.equal((await request("/__library/records/scheme-copy",{version:1,id:"scheme-copy",kind:"Drone Video",name:"copy",visible:true,files:{},settings:{video:{mode:"cc-overlay"}}},"PUT")).status,403,"creating a named copy retains the library write permission requirement");
   }
  }
  cookie="";assert.equal((await request("/__library/records/scheme/pos",{},"POST")).status,401,"anonymous sessions cannot append POS attachments");assert.equal((await request("/__library/records")).status,401);assert.equal((await request("/__library/records/model")).status,401);
  for(const[file,value]of sources)assert.equal(readFileSync(file,"utf8"),value,"read filtering never rewrites original records/view");
 }finally{await new Promise<void>(done=>server.close(()=>done()));store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+"cesium-library-permission-"));rmSync(dir,{recursive:true,force:true});}
});
