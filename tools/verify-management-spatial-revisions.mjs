import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createManagementStore} from '../server/managementStore.ts';
import {createSafetySpatialStore} from '../server/safetySpatialStore.ts';
import {spatialFixture,spatialV3Fixture,modelRegistryFixture} from '../src/safetySpatial.testFixtures.ts';
import {spatialPositionToEcef} from '../src/safetySpatialValidation.ts';
const parent=resolve('tmp/management-spatial-revision-http');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'case-'));
let now='2026-10-08T01:00:00.000Z',sequence=0,requests=0;
const original=spatialFixture('railway','historical'),untouched=spatialV3Fixture('construction-area','untouched');
const initial=JSON.stringify({version:1,revision:10,updatedAt:original.updatedAt,objects:[original,untouched],mutations:[]});
await writeFile(join(dir,'safety-spatial.json'),initial);
const management=createManagementStore({dataDir:dir,now:()=>now}),spatial=createSafetySpatialStore({dataDir:dir,modelRegistry:[modelRegistryFixture()]});
const server=createServer((req,res)=>void management.accessMiddleware(req,res,()=>void management.middleware(req,res,()=>void spatial.middleware(req,res,()=>{res.statusCode=404;res.end();}))));
await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`,checks=[];
function check(name,actual,expected){assert.deepEqual(actual,expected,name);checks.push(name);}
async function call(path,body,status=200){requests++;const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
async function command(type,id,payload={},revision){const value=await call('/__management/commands',{projectId:'safety:project',type,id,payload,expectedRevision:revision,idempotencyKey:`command-${++sequence}`});return Object.values(value.collections).flat().find(r=>r.id===id);}
const hash=value=>createHash('sha256').update(value).digest('hex');
try{
 let s=await call('/__safety/spatial');check('Reading preserves historical missing object revision',Object.hasOwn(s.objects[0],'revision'),false);check('Reading does not migrate original JSON bytes',await readFile(spatial.path,'utf8'),initial);
 let task=await command('task.create','bound-task',{name:'Bound task',areaIds:['historical']});const oldReference=task.spatialReferences[0];
 check('Historical reference explicitly records unnumbered object', [oldReference.revision,oldReference.revisionStatus],[null,'historical-unnumbered']);
 check('Historical reference binds actual spatial ledger', [oldReference.ledgerVersion,oldReference.ledgerRevision],[1,10]);check('Historical geometry has SHA-256',/^[a-f0-9]{64}$/.test(oldReference.geometrySha256),true);
 const first={operation:'upsert',object:{...spatialV3Fixture('risk-point','risk'),revision:'client-forged'},expectedRevision:10,mutationId:'create-risk'};
 s=await call('/__safety/spatial',first);check('First saved object revision comes from server',s.objects[2].revision,1);check('Unrelated historical object has no assigned number',s.objects[1],untouched);
 const event=await command('issue.create','event-before',{name:'Before movement',kind:'safety',riskPointId:'risk'}),before=event.positionSnapshot;
 check('Event freezes object and ledger revision',[before.reference.revision,before.reference.ledgerRevision],[1,11]);
 const cutoff=now;now='2026-10-09T01:00:00.000Z';
 const moved=structuredClone(s.objects[2]);moved.geometry.position.longitude+=0.00001;moved.source.vertices[0].anchor.position={space:'ecef-meters',...spatialPositionToEcef(moved.geometry.position)};moved.revision=999999;
 s=await call('/__safety/spatial',{operation:'upsert',object:moved,expectedRevision:11,mutationId:'move-risk'});check('Movement increments exactly one revision, ignoring supplied number',s.objects[2].revision,2);
 const after=await command('issue.create','event-after',{name:'After movement',kind:'safety',riskPointId:'risk'});check('New event uses new geometry binding',after.positionSnapshot.reference.revision,2);check('Changed geometry changes SHA-256',after.positionSnapshot.reference.geometrySha256!==before.reference.geometrySha256,true);
 check('Prior event keeps original snapshot',(await call('/__management/records/issues/event-before')).positionSnapshot,before);
 s=await call('/__safety/spatial',{operation:'upsert',object:{...original,name:'Renamed historical',revision:800},expectedRevision:12,mutationId:'rename-old'});check('First real edit of historical record starts at one',s.objects[0].revision,1);check('Historical edit retains exact source provenance',s.objects[0].source,original.source);
 task=await command('task.update','bound-task',{name:'Bound task updated'},task.revision);check('Updated task source captures current ledger/object revisions',[task.spatialReferences[0].revision,task.spatialReferences[0].ledgerRevision],[1,13]);
 const report=await command('report.freeze','historical-report',{name:'Historical source bindings',D:'2026-10-08',F:cutoff});
 check('Report F retains old unnumbered task source',report.spatialReferences.find(r=>r.id==='historical'),oldReference);
 check('Report F retains original risk geometry',report.spatialReferences.find(r=>r.id==='risk'),before.reference);
 check('Report F excludes later event',report.sourceRevisions.some(r=>r.id==='event-after'),false);
 const bytes=await readFile(spatial.path,'utf8');await call('/__safety/spatial',{operation:'delete',id:'risk',expectedRevision:11,mutationId:'stale'},409);check('Conflict does not write or advance revisions',await readFile(spatial.path,'utf8'),bytes);
 s=await call('/__safety/spatial',{operation:'delete',id:'risk',expectedRevision:13,mutationId:'delete'});check('Explicit delete advances once',s.objects[2].revision,3);
 const restore={operation:'restore',id:'risk',expectedRevision:14,mutationId:'restore'};s=await call('/__safety/spatial',restore);check('Explicit restore advances once',s.objects[2].revision,4);check('Restore preserves moved geometry',s.objects[2].geometry,moved.geometry);
 const again=await call('/__safety/spatial',restore);check('Restore retry is revision-idempotent',[again.revision,again.objects[2].revision],[15,4]);
 const retry=await call('/__safety/spatial',{...first,object:{...first.object,revision:-1000}});check('Client revision is not part of the authoritative retry signature',retry.revision,15);
 check('Persisted reopen retains all object numbers',(await createSafetySpatialStore({dataDir:dir}).load()).objects.map(o=>o.revision??null),[1,null,4]);
 const files=['src/safetySpatialTypes.ts','src/safetySpatialValidation.ts','server/safetySpatialStore.ts','server/managementStore.ts'];const hashes={};for(const f of files)hashes[f]=hash(await readFile(f));
 const result={checkedAt:new Date().toISOString(),classification:'actual-http-isolated-spatial-revision-compatibility',formalDataReadOrModified:false,browserOrGpuUsed:false,requests,checks,pass:checks.length,fail:0,sourceHashes:hashes};await mkdir('output/platform-management',{recursive:true});await writeFile('output/platform-management/spatial-revision-http.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));management.close();assert.ok(resolve(dir).startsWith(parent+sep));await rm(dir,{recursive:true,force:true});}
