/** Actual HTTP integration: trusted management actor into existing spatial/event middleware.
 * Isolated temporary data; fixtures verify identity/provenance contracts, not real GPU picking.
 * node --experimental-transform-types --import ./tools/test-module-loader.mjs tools/verify-management-legacy-actor.mjs
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createManagementStore} from '../server/managementStore.ts';
import {createSafetySpatialStore} from '../server/safetySpatialStore.ts';
import {createSafetyEventStore} from '../server/safetyEventStore.ts';
import {spatialV3Fixture,modelRegistryFixture} from '../src/safetySpatial.testFixtures.ts';
const root=process.cwd(),output=path.join(root,'output/platform-management');
await mkdir(output,{recursive:true}); await mkdir(path.join(root,'tmp'),{recursive:true});
const directory=await mkdtemp(path.join(root,'tmp/management-legacy-actor-'));
const report={schemaVersion:1,classification:'actual-http-isolated-legacy-middleware-actor',startedAt:new Date().toISOString(),isolatedDataDirectory:directory,formalDataReadOrModified:false,browserOrGpuUsed:false,checks:[],requests:[],sourceHashes:{},exclusions:['Uses isolated validated model-anchor fixtures, not an actual user pick or rendered model.','Actual production Vite order and UI permission lifecycle require separate runtime verification.']};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of ['tools/verify-management-legacy-actor.mjs','server/managementStore.ts','server/management/actorContext.ts','server/safetySpatialStore.ts','server/safetyEventStore.ts','src/safetySpatialValidation.ts','src/safetyEventValidation.ts'])report.sourceHashes[file]=sha(await readFile(path.join(root,file)));
let server,store;const cookie={};let origin;
function check(name,actual,expected,gates=['A01','A18']){const passed=JSON.stringify(actual)===JSON.stringify(expected);report.checks.push({name,gates,passed,actual,expected});return passed;}
async function http(url,body,role='owner',headers={}){const response=await fetch(origin+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Cesium-Library':'1',...(cookie[role]?{Cookie:cookie[role]}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const set=response.headers.get('set-cookie');if(set&&role)cookie[role]=set.split(';')[0];const data=await response.json();report.requests.push({seq:report.requests.length+1,method:body===undefined?'GET':'POST',path:url,session:role||'anonymous',status:response.status,code:data.code});return{status:response.status,data};}
async function command(type,payload,role='owner'){const r=await http('/__management/commands',{type,projectId:'safety:project',payload,idempotencyKey:randomUUID()},role);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
const recordEvent=id=>({id,projectId:'safety:project',title:'Isolated legacy actor observation',severity:'medium',status:'pending',occurredAt:Date.now(),mediaIds:[],source:{kind:'manual-record'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
try{
 store=await createManagementStore({dataDir:directory,projectId:'safety:project'});
 const spatial=createSafetySpatialStore({dataDir:directory,modelRegistry:[modelRegistryFixture()]});
 const events=createSafetyEventStore({dataDir:directory});
 server=createServer((req,res)=>void store.accessMiddleware(req,res,()=>void store.middleware(req,res,()=>void spatial.middleware(req,res,()=>void events.middleware(req,res,()=>{res.statusCode=404;res.setHeader('Content-Type','application/json');res.end('{"error":"not found"}');})))));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 const ownerPassword='owner-'+randomUUID();let state=await command('member.save',{username:'owner-legacy',displayName:'Legacy owner',password:ownerPassword,roles:['owner'],resourceAccess:{models:true,files:true,media:true}});
 const ownerId=state.session.userId;
 const workerPassword='worker-'+randomUUID();state=await command('member.save',{username:'worker-legacy',displayName:'Legacy worker',password:workerPassword,roles:['worker'],resourceAccess:{models:true,files:true,media:true}});
 const workerId=state.members.find(m=>m.username==='worker-legacy').id;
 assert.equal((await http('/__management/session',{username:'worker-legacy',password:workerPassword,projectId:'safety:project'},'worker')).status,200);
 const viewerPassword='viewer-'+randomUUID();state=await command('member.save',{username:'viewer-legacy',displayName:'Legacy viewer',password:viewerPassword,roles:['viewer'],resourceAccess:{models:true,files:true,media:true}});
 assert.equal((await http('/__management/session',{username:'viewer-legacy',password:viewerPassword,projectId:'safety:project'},'viewer')).status,200);
 check('Actual owner and worker identities differ',ownerId===workerId,false);
 const spoofHeaders={'X-User':ownerId,'X-Actor-Id':ownerId,'X-Management-Actor':JSON.stringify({id:ownerId,roles:['owner']}),'X-Role':'owner'};
 const object=spatialV3Fixture('risk-point','isolated-actor-risk');object.createdBy=ownerId;object.updatedBy=ownerId;
 const create={operation:'upsert',object,expectedRevision:0,mutationId:randomUUID(),actor:{id:ownerId,roles:['owner']}};
 const saved=await http('/__safety/spatial',create,'worker',spoofHeaders);
 assert.equal(saved.status,200,JSON.stringify(saved.data));
 check('Spatial create ignores forged payload creator and header actor',[saved.data.objects[0].createdBy,saved.data.objects[0].updatedBy],[workerId,workerId]);
 check('Unchanged coordinates survive actor attribution',saved.data.objects[0].geometry,object.geometry,['A01','A02']);
 check('Same actor retry returns existing spatial revision',(await http('/__safety/spatial',create,'worker',spoofHeaders)).data.revision,1);
 const crossActor=await http('/__safety/spatial',create,'owner',spoofHeaders);
 check('Spatial receipt signature rejects same mutation replay by another authenticated actor',[crossActor.status,crossActor.data.code],[409,'MUTATION_ID_REUSED']);
 const original=sha(await readFile(spatial.path));
 const viewer=await http('/__safety/spatial',{...create,mutationId:randomUUID(),expectedRevision:1},'viewer',spoofHeaders);
 check('Viewer cannot obtain field writes with forged owner headers',viewer.status,403);
 const anonymous=await http('/__safety/spatial',{...create,mutationId:randomUUID(),expectedRevision:1},null,spoofHeaders);
 check('Anonymous owner header does not enter legacy spatial middleware',anonymous.status,401);
 check('Denied mutations leave spatial bytes unchanged',sha(await readFile(spatial.path)),original);
 const renamed=structuredClone(saved.data.objects[0]);renamed.name='Owner changed display name';renamed.createdBy=ownerId;renamed.updatedBy=workerId;
 const update=await http('/__safety/spatial',{operation:'upsert',object:renamed,expectedRevision:1,mutationId:randomUUID()},'owner');assert.equal(update.status,200);
 check('Edit preserves original creator and uses current updater',[update.data.objects[0].createdBy,update.data.objects[0].updatedBy],[workerId,ownerId]);
 const deleted=await http('/__safety/spatial',{operation:'delete',id:object.id,expectedRevision:2,mutationId:randomUUID(),deletedBy:workerId},'owner');assert.equal(deleted.status,200);
 check('Delete attribution comes from trusted request actor',[deleted.data.objects[0].deletedBy,deleted.data.objects[0].updatedBy],[ownerId,ownerId]);
 const restored=await http('/__safety/spatial',{operation:'restore',id:object.id,expectedRevision:3,mutationId:randomUUID(),updatedBy:ownerId},'worker');assert.equal(restored.status,200);
 check('Restore uses actual restorer and clears deletion',[restored.data.objects[0].createdBy,restored.data.objects[0].updatedBy,!!restored.data.objects[0].deletedAt],[workerId,workerId,false]);
 const event={...recordEvent('isolated-legacy-event'),createdBy:ownerId};
 const eventCreate={operation:'create',event,expectedRevision:0,mutationId:randomUUID(),actorId:ownerId};
 const eventSaved=await http('/__safety/events',eventCreate,'worker',spoofHeaders);assert.equal(eventSaved.status,200,JSON.stringify(eventSaved.data));
 check('Legacy event create cannot forge another creator',eventSaved.data.events[0].createdBy,workerId);
 const eventReplay=await http('/__safety/events',eventCreate,'owner');
 check('Event create receipt signature also binds authenticated actor',[eventReplay.status,eventReplay.data.code],[409,'MUTATION_ID_REUSED']);
 const complete={operation:'complete',id:event.id,expectedRevision:1,mutationId:randomUUID(),result:{description:'Actual worker result',handledBy:ownerId}};
 const completed=await http('/__safety/events',complete,'worker',spoofHeaders);assert.equal(completed.status,200);
 check('Handling result overwrites forged handledBy with actual worker',completed.data.events[0].handling.handledBy,workerId);
 check('Same worker can safely retry completed-event receipt',(await http('/__safety/events',complete,'worker')).data.revision,2);
 const eventReceipt=await http('/__safety/events',complete,'owner');
 check('Handling receipt cannot be replayed under another actor',[eventReceipt.status,eventReceipt.data.code],[409,'MUTATION_ID_REUSED']);
 const oldBytes=sha(await readFile(events.path));
 check('Unauthenticated event POST rejects forged trusted actor',(await http('/__safety/events',{...eventCreate,mutationId:randomUUID()},null,spoofHeaders)).status,401);
 check('Read-only event POST rejects forged trusted actor',(await http('/__safety/events',{...eventCreate,mutationId:randomUUID()},'viewer',spoofHeaders)).status,403);
 check('Denied event operations leave file bytes unchanged',sha(await readFile(events.path)),oldBytes);
 const spatialReceipt=JSON.parse(await readFile(spatial.path,'utf8')).mutations.find(m=>m.id===create.mutationId);
 const eventReceiptSaved=JSON.parse(await readFile(events.path,'utf8')).mutations.find(m=>m.id===complete.mutationId);
 check('Both actual stored receipts are SHA-256 signatures',[spatialReceipt?.signature,eventReceiptSaved?.signature].every(x=>/^[a-f0-9]{64}$/.test(x)),true);
 report.identities={ownerId,workerId};report.evidence={spatialFinal:await spatial.load(),eventFinal:await events.load(),spatialSha256:sha(await readFile(spatial.path)),eventSha256:sha(await readFile(events.path))};
 report.passed=report.checks.every(c=>c.passed);
}catch(error){report.error=String(error.stack||error);report.passed=false;}
finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store?.close();report.completedAt=new Date().toISOString();report.summary={checks:report.checks.length,passed:report.checks.filter(c=>c.passed).length,failed:report.checks.filter(c=>!c.passed).length,httpRequests:report.requests.length};await writeFile(path.join(output,'legacy-actor-acceptance.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({overallPassed:report.passed,...report.summary,error:report.error,report:path.join(output,'legacy-actor-acceptance.json')},null,2));process.exitCode=report.passed?0:1;}
