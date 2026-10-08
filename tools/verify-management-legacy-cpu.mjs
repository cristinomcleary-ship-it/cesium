import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,mkdir } from 'node:fs/promises';
import { resolve,join,sep } from 'node:path';
import { createManagementStore } from '../server/managementStore.ts';
import { createSafetySpatialStore } from '../server/safetySpatialStore.ts';
import { createSafetyEventStore } from '../server/safetyEventStore.ts';
import { modelRegistryFixture,spatialV3Fixture } from '../src/safetySpatial.testFixtures.ts';
import fs from 'node:fs';
const root=resolve('tmp/management-legacy-cpu');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'case-'));
const management=createManagementStore({dataDir:dir}),spatial=createSafetySpatialStore({dataDir:dir,modelRegistry:[modelRegistryFixture()]}),events=createSafetyEventStore({dataDir:dir});
const checks=[];let cookie='';
const server=createServer((req,res)=>void management.accessMiddleware(req,res,()=>void management.middleware(req,res,()=>void spatial.middleware(req,res,()=>void events.middleware(req,res,()=>{res.statusCode=404;res.end();})))));
await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
async function call(path,payload){const response=await fetch(base+path,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json','X-Cesium-Library':'1',...(cookie?{cookie}:{}),'X-Role':'owner'},body:payload?JSON.stringify(payload):undefined});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return {data,response};}
function check(name,value,expected){assert.deepEqual(value,expected,name);checks.push(name);}
try{
 const original=spatialV3Fixture('risk-point','owned-risk');original.createdBy='forged-client';original.updatedBy='forged-client';
 let result=await call('/__safety/spatial',{operation:'upsert',object:original,expectedRevision:0,mutationId:'first'});check('legacy spatial creation uses trusted local actor',result.data.objects[0].createdBy,'local-owner');
 const boot=await call('/__management/commands',{projectId:'safety:project',type:'member.save',idempotencyKey:'bootstrap',payload:{username:'owner',password:'CPU-only-owner-pass',displayName:'Test owner',roles:['owner']}});cookie=boot.response.headers.get('set-cookie').split(';')[0];const actor=boot.data.session.userId;
 result=await call('/__safety/spatial',{operation:'upsert',object:{...result.data.objects[0],name:'updated',createdBy:'forged-again',updatedBy:'forged-again'},expectedRevision:1,mutationId:'update'});check('updating preserves original creator',result.data.objects[0].createdBy,'local-owner');check('updating ignores forged updater',result.data.objects[0].updatedBy,actor);
 result=await call('/__safety/spatial',{operation:'delete',id:original.id,expectedRevision:2,mutationId:'delete'});check('delete records trusted actor',result.data.objects[0].deletedBy,actor);
 result=await call('/__safety/spatial',{operation:'restore',id:original.id,expectedRevision:3,mutationId:'restore'});check('restore preserves geometry',result.data.objects[0].geometry,original.geometry);check('restore records trusted actor',result.data.objects[0].updatedBy,actor);
 const geometryBytes=await readFile(spatial.path,'utf8');const event={id:'event',projectId:'safety:project',title:'CPU isolated manual event',severity:'medium',status:'pending',occurredAt:1791360000000,spatialObjectId:original.id,mediaIds:[],source:{kind:'manual-record'},createdAt:'2026-10-07T08:00:00Z',updatedAt:'2026-10-07T08:00:00Z'};
 await call('/__safety/events',{operation:'create',event,expectedRevision:0,mutationId:'event'});
 result=await call('/__safety/events',{operation:'complete',id:'event',result:{description:'handled',handledBy:'forged-handler'},expectedRevision:1,mutationId:'complete'});check('legacy event handling uses trusted actor',result.data.events[0].handling.handledBy,actor);check('event handling does not mutate spatial definitions',await readFile(spatial.path,'utf8'),geometryBytes);
 const repeated=await call('/__safety/events',{operation:'complete',id:'event',result:{description:'handled',handledBy:'forged-handler'},expectedRevision:1,mutationId:'complete'});check('actor-bound original event retry remains idempotent',repeated.data.revision,2);
 const report={checkedAt:new Date().toISOString(),scope:'isolated HTTP/CPU integration; no browser, GPU or formal project writes',checks,pass:checks.length,fail:0};fs.mkdirSync('output/platform-management',{recursive:true});fs.writeFileSync('output/platform-management/legacy-actor-integration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));management.close();assert.ok(resolve(dir).startsWith(root+sep));await rm(dir,{recursive:true,force:true});}
