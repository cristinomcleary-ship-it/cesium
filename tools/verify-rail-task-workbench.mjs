/**
 * Chromium/WebGL acceptance for task-linked rail safety and mechanical risk issues.
 * An isolated database, two tasks, three equipment resources (one lacks a model),
 * and a synthetic local surface are used. No personnel locator is configured.
 *
 * PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
 * BROWSER_LAUNCH_OPTIONS=/path/to/launch_options.mjs \
 * node tools/verify-rail-task-workbench.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { Cartesian3, Transforms } from 'cesium';

const output=resolve(process.env.RAIL_TASK_VERIFY_OUT||'output/rail-task-workbench');
const port=Number(process.env.RAIL_TASK_VERIFY_PORT||5198);
assert(Number.isInteger(port)&&port>0&&port<=65535,'RAIL_TASK_VERIFY_PORT must be a valid nonzero TCP port');
await mkdir(output,{recursive:true});await mkdir('tmp',{recursive:true});
const dataDir=await mkdtemp(resolve('tmp/rail-task-workbench-'));
for(const key of ['CESIUM_DATA_DIR','CESIUM_MANAGEMENT_DATA_DIR','CESIUM_SAFETY_DATA_DIR'])process.env[key]=dataDir;
delete process.env.CESIUM_POSITIONING_CONFIG_FILE;
const projectId='safety:project',taskA='rail-task-A',taskB='rail-task-B';
const machineA='rail-machine-A',machineB='rail-machine-B',unconfigured='rail-machine-unconfigured',limitId='rail-limit';
const accountPassword='Isolated-Rail-Task-'+randomUUID();
const site={longitude:116.391,latitude:39.907,height:12};
const report={classification:'actual-browser-task-workbench-and-mechanical-risk-lifecycle',startedAt:new Date().toISOString(),dataDir,productionDataReadOrModified:false,personnelPositioning:{configured:false,samplesSubmitted:0,requests:[]},fixture:{synthetic:true,tasks:2,equipment:3,models:2,unconfiguredEquipment:1,limitations:['Synthetic horizontal surface and saved geometric screening, not a surveyed site or physical accident validation','Software WebGL renderer when supplied launch options use SwiftShader']},checks:[],screenshots:[],pageErrors:[],consoleErrors:[],commands:[]};
let server,browser,context,page,origin,activeCheck,ownerId,issueId,baseline;
const rp=()=>page.locator('.rail-safety-panel');
const action=name=>rp().locator(`[data-action="${name}"]`);
const ops=()=>rp().locator('[data-role="operations"]');
function local(east,north,height=12){return{longitude:site.longitude+east/(111319.49079327358*Math.cos(site.latitude*Math.PI/180)),latitude:site.latitude+north/111319.49079327358,height};}
function polygon(x0,y0,x1,y1){return[local(x0,y0),local(x1,y0),local(x1,y1),local(x0,y1)];}
const points=new Float32Array([-60,12,60,60,12,60,60,12,-60,-60,12,-60]);
const indices=new Uint16Array([0,2,1,0,3,2]);
const bytes=Buffer.concat([Buffer.from(points.buffer),Buffer.from(indices.buffer)]);
const fixtureGltf={asset:{version:'2.0',generator:'Synthetic task-workbench acceptance plane'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.55,.58,.62,1],metallicFactor:0,roughnessFactor:1},extensions:{KHR_materials_unlit:{}}}],extensionsUsed:['KHR_materials_unlit'],accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-60,12,-60],max:[60,12,60]},{bufferView:1,componentType:5123,count:6,type:'SCALAR',min:[0],max:[3]}],bufferViews:[{buffer:0,byteOffset:0,byteLength:points.byteLength,target:34962},{buffer:0,byteOffset:points.byteLength,byteLength:indices.byteLength,target:34963}],buffers:[{byteLength:bytes.length,uri:'data:application/octet-stream;base64,'+bytes.toString('base64')}]};
const fixtureTiles={asset:{version:'1.1'},geometricError:100,root:{transform:Array.from(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(site.longitude,site.latitude,0))),boundingVolume:{box:[0,0,12,60,0,0,0,60,0,0,0,.1]},geometricError:0,refine:'ADD',content:{uri:'plane.gltf'}}};
async function check(id,run){activeCheck={id,status:'running'};report.checks.push(activeCheck);console.log('RUN',id);activeCheck.evidence=await run();activeCheck.status='passed';console.log('PASS',id);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));}
async function ready(){await page.waitForFunction(()=>window.__managementWorkspace?.ui?.getSnapshot()?.projectId,undefined,{timeout:60000});}
async function snapshot(){return page.evaluate(()=>window.__managementWorkspace.ui.getSnapshot());}
async function sceneSnapshot(){return page.evaluate(()=>window.__managementWorkspace.railSafety.scene.getSnapshot());}
async function rendered(){await page.evaluate(()=>new Promise((done,reject)=>{const scene=window.__managementWorkspace.viewer.scene;const timer=setTimeout(()=>{remove();reject(new Error('Cesium postRender timed out'));},15000);const remove=scene.postRender.addEventListener(()=>{clearTimeout(timer);remove();done();});scene.requestRender();}));}
async function settled(){await page.waitForFunction(()=>{const p=window.__managementWorkspace?.railSafety;return p&&!p.isBusy&&p.scene.getSnapshot().pending===0;},undefined,{timeout:90000});await rendered();}
async function screenshot(name,failure=false){if(!failure){if(await rp().isVisible())await settled();const drawer=page.locator('[data-mg-drawer] .drawer');if(await drawer.isVisible())await drawer.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished));});await page.evaluate(()=>document.fonts.ready);if(await rp().isVisible())await rp().locator('.rs-scroll').evaluate(el=>{el.scrollTop=0;});}const path=resolve(output,name+'.png');await page.screenshot({path,timeout:60000});report.screenshots.push(path);return path;}
async function command(type,payload={},extra={}){const response=await context.request.post(origin+'/__management/commands',{headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},data:{projectId,type,payload,idempotencyKey:randomUUID(),...extra}});assert.equal(response.status(),200,`${type}: ${await response.text()}`);return response.json();}
async function state(){const response=await context.request.get(origin+'/__management/state?projectId='+encodeURIComponent(projectId));assert.equal(response.status(),200,await response.text());return response.json();}
async function issue(){return(await state()).collections.issues.find(r=>r.id===issueId);}
async function fixtures(){
 await command('member.save',{username:'rail-workbench-owner',displayName:'隔离工作台验收管理员',password:accountPassword,roles:['owner']});
 assert.equal((await context.request.delete(origin+'/__management/session',{headers:{'X-Cesium-Library':'1'}})).status(),200);
 const login=await context.request.post(origin+'/__management/session',{headers:{'X-Cesium-Library':'1'},data:{username:'rail-workbench-owner',password:accountPassword}});assert.equal(login.status(),200,await login.text());
 ownerId=(await state()).session.userId;
 await command('task.create',{name:'A · 邻线吊装作业',ownerId,planStart:'2026-10-14',planEnd:'2026-10-15'},{id:taskA});
 await command('task.create',{name:'B · 机械准备作业',ownerId,planStart:'2026-10-14',planEnd:'2026-10-15'},{id:taskB});
 for(const [id,name,east]of [[machineA,'A任务吊机 · 潜在相交',7],[machineB,'B任务吊机 · 未相交',-25],[unconfigured,'A任务待配置机械',null]]){
  await command('resource.create',{name,kind:'equipment',quantity:1,unit:'台'},{id});
  if(east===null)continue;
  const manifest=JSON.parse(await readFile('public/machinery/crane/manifest.json','utf8'));
  await command('machinery.save',{machinery:{schemaVersion:1,assetId:'crane',assetVersion:manifest.version,proportional:true,parameters:Object.fromEntries(manifest.config.parameters.map(p=>[p.key,p.unit==='°'?p.original:p.original*3])),placement:{...local(east,0),heading:0},visible:true}},{id,expectedRevision:1});
 }
 await command('allocation.create',{name:'待配置机械归入A作业',resourceId:unconfigured,taskId:taskA,startsAt:'2026-10-14T00:00:00.000Z',endsAt:'2026-10-15T00:00:00.000Z'},{id:'rail-task-allocation'});
 await command('railSafety.save',{name:'铁路设备安全限界',definition:{schemaVersion:1,kind:'limit',polygon:polygon(13,-25,17,25)}},{id:limitId,expectedRevision:0});
 for(const[id,taskId]of[[machineA,taskA],[machineB,taskB]])await command('railSafety.save',{name:id===machineA?'A吊机管控':'B吊机管控',taskId,definition:{schemaVersion:1,kind:'machine',resourceId:id,selectedLimitIds:[limitId],inspectionStatus:'unknown'}},{id:'config-'+id,expectedRevision:0});
}
async function addSurface(){await page.locator('.tab[data-tab="tiles"]').click();await page.locator('#tilesUrl').fill(origin+'/__rail-task-fixture/tileset.json');await page.locator('#loadTiles').click();await page.waitForFunction(()=>window.__managementWorkspace.safety.options.getImports().some(x=>x.name==='tileset.json'));}
async function frame(){await page.evaluate(async site=>{const C=await import('/__rail-task-fixture/cesium.ts');const v=window.__managementWorkspace.viewer;v.camera.lookAt(C.Cartesian3.fromDegrees(site.longitude,site.latitude,site.height),new C.HeadingPitchRange(-.15,-.9,145));v.camera.lookAtTransform(C.Matrix4.IDENTITY);v.camera.moveRight(22);v.scene.requestRender();},site);await settled();}
async function openPanel(){await page.locator('.tab[data-tab="rail-safety"]').click();await rp().waitFor({state:'visible'});await settled();}
async function workbench(view='tasks'){await openPanel();await action('workspace-'+view).click();await ops().waitFor({state:'visible'});await settled();}
async function unchangedScene(){assert.deepEqual((await sceneSnapshot()).results,baseline.results);const s=await snapshot();for(const key of ['railSafety','resources','allocations','tasks'])assert.deepEqual(s.collections[key],baseline.collections[key],key+' changed during filtering');}
async function counts(){return ops().locator('[data-role="task-scope-summary"]').evaluate(el=>Object.fromEntries([...el.querySelectorAll('[data-count]')].map(n=>[n.dataset.count,Number(n.textContent)])));}
async function chooseTask(id){await ops().locator('[data-role="task-filter"]').selectOption(id);await settled();}
async function visibleMachines(){return ops().locator('article[data-resource-id]').evaluateAll(items=>items.map(el=>el.dataset.resourceId).sort());}
async function issueUiCommand(type,fields,expectedStatus){
 await page.locator(`[data-mg-drawer] [data-mg-command="${type}"]`).click();
 for(const[key,value]of Object.entries(fields)){const input=page.locator(`[data-mg-form] [data-mg-field="${key}"]`);if(await input.evaluate(el=>el.tagName==='SELECT'))await input.selectOption(String(value));else await input.fill(String(value));}
 const responsePromise=page.waitForResponse(r=>{if(!r.url().endsWith('/__management/commands'))return false;try{return r.request().postDataJSON()?.type===type;}catch{return false;}});
 await page.locator('[data-mg-drawer] [data-mg-action="form-save"]').click();const response=await responsePromise;assert.equal(response.status(),200,await response.text());
 await page.waitForFunction(({issueId,expectedStatus})=>window.__managementWorkspace.ui.getSnapshot().collections.issues.find(r=>r.id===issueId)?.status===expectedStatus,{issueId,expectedStatus});
 assert.equal((await issue()).status,expectedStatus);
}
async function backToRail(){
 const close=page.locator('[data-mg-drawer] [data-mg-action="drawer-close"]');if(await close.isVisible())await close.click();
 const original=page.locator('.tab[data-tab="rail-safety"]');
 if(await original.isVisible())await original.click();else{await page.locator('#mg-header [data-mg-action="mode-scene"]').click();await page.locator('#mg-scene-tools [data-mg-action="rail-safety"]').click();}
 await rp().waitFor({state:'visible'});await settled();
}
async function runCases(){
 await check('task-counts-include-unconfigured-equipment-and-filter-only-the-list',async()=>{
  await workbench('tasks');const all=await counts();assert.equal(all.resources,3);assert.equal(all.configured,2);assert.equal(all.missing,1);assert.equal(await ops().locator('article[data-task-id]').count(),2);assert.deepEqual(await visibleMachines(),[machineA,machineB,unconfigured].sort());
  await chooseTask(taskA);const a=await counts();assert.equal(a.resources,2);assert.equal(a.configured,1);assert.equal(a.missing,1);assert.deepEqual(await visibleMachines(),[machineA,unconfigured].sort());await unchangedScene();
  await chooseTask(taskB);const b=await counts();assert.equal(b.resources,1);assert.equal(b.configured,1);assert.equal(b.missing,0);assert.deepEqual(await visibleMachines(),[machineB]);await unchangedScene();
  await chooseTask('');await screenshot('01-task-overview-three-equipment');
  const bounds=await rp().boundingBox();assert(bounds.x>=900&&bounds.width<=460,'Task workbench must remain in the right dock');assert(bounds.y>=0&&bounds.y+bounds.height<=769);
  assert.equal(await rp().evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'Right panel has horizontal overflow');
  return{all,taskA:a,taskB:b,unconfiguredResource:unconfigured,filterChangesSceneResults:false,filterChangesSavedRecords:false,viewport:{width:1366,height:768},panelBounds:bounds};
 });
 await check('saved-overlap-registers-one-risk-and-opens-existing-issue',async()=>{
  await chooseTask(taskA);const button=ops().locator(`[data-action="report-risk"][data-resource-id="${machineA}"][data-limit-id="${limitId}"]`);assert(await button.isEnabled());
  const responsePromise=page.waitForResponse(r=>{if(!r.url().endsWith('/__management/commands'))return false;try{return r.request().postDataJSON()?.type==='railSafety.reportRisk';}catch{return false;}});
  await button.click();const response=await responsePromise;assert.equal(response.status(),200,await response.text());await settled();
  const rows=(await state()).collections.issues;assert.equal(rows.length,1);issueId=rows[0].id;assert.equal(rows[0].kind,'safety');assert.equal(rows[0].taskId,taskA);assert.equal(rows[0].status,'pending-verification');assert.equal(rows[0].railSafetyRisk.resourceId,machineA);assert.equal(rows[0].railSafetyRisk.limitId,limitId);assert.equal(rows[0].railSafetyRisk.serverRecomputed,false);assert.equal(rows[0].railSafetyRisk.physicalPrediction,false);assert.equal(rows[0].railSafetyRisk.resourceRevision,2);assert.equal(rows[0].railSafetyRisk.machineConfigRevision,1);assert.equal(rows[0].railSafetyRisk.limitRevision,1);
  await action('workspace-issues').click();const row=ops().locator(`article[data-issue-id="${issueId}"]`);await row.waitFor({state:'visible'});await screenshot('02-registered-risk-history');
  const commandCount=report.commands.length;
  await action('workspace-tasks').click();await chooseTask(taskA);assert.equal(await ops().locator(`[data-action="report-risk"][data-resource-id="${machineA}"][data-limit-id="${limitId}"]`).count(),0);
  const existing=ops().locator(`[data-action="open-risk-issue"][data-issue-id="${issueId}"]`);assert.equal(await existing.count(),1);await existing.click();
  await page.waitForFunction(issueId=>{const s=window.__managementWorkspace.ui.getSelection();return s?.kind==='issues'&&s.id===issueId;},issueId);
  await page.locator('[data-mg-drawer] [data-mg-command="issue.assign"]').waitFor({state:'visible'});assert.equal(report.commands.length,commandCount);assert.equal((await state()).collections.issues.length,1);
  return{issueId,status:rows[0].status,taskId:rows[0].taskId,issueCount:1,reopenCreatesNewIssue:false,sourceFields:Object.keys(rows[0]).filter(k=>/rail|risk|source|discovery/i.test(k))};
 });
 await check('existing-issue-ui-completes-assign-rectify-review-and-retains-source',async()=>{
  const original=await issue();
  await issueUiCommand('issue.assign',{ownerId,dueDate:'2026-10-15',reason:'隔离验收：核对几何潜在相交并指派整改'},'pending-rectification');
  await issueUiCommand('issue.start',{reason:'隔离验收：开始办理'},'rectifying');
  await issueUiCommand('issue.submit',{description:'隔离流程验收记录；未声称现场已整改，场景机械位置保持原样。'},'pending-review');
  await issueUiCommand('issue.review',{passed:'true',reason:'仅确认隔离验收流程闭环；不代表真实工地安全审核。'},'closed');
  const closed=await issue();assert.equal(closed.rounds.length,1);assert.equal(closed.rounds[0].passed,true);assert(closed.closedAt);assert.equal(closed.taskId,original.taskId);
  for(const key of Object.keys(original).filter(k=>/rail|risk|discovery/i.test(k)))assert.deepEqual(closed[key],original[key],key+' source snapshot changed during issue workflow');
  assert.match(await page.locator('[data-mg-drawer]').innerText(),/复核通过/);await screenshot('03-existing-issue-workflow-closed');
  return{issueId,status:closed.status,rounds:closed.rounds.length,closedAt:closed.closedAt,operations:['issue.assign','issue.start','issue.submit','issue.review'],frozenSourceUnchanged:true,sceneRemediationClaimed:false};
 });
 await check('closed-history-survives-reload-and-current-overlap-remains-visible',async()=>{
  await backToRail();await action('workspace-issues').click();await ops().locator('[data-role="issue-filter"]').selectOption('all');await settled();const history=ops().locator(`article[data-issue-id="${issueId}"]`);await history.waitFor({state:'visible'});assert.match(await history.innerText(),/已关闭|关闭/);
  await page.reload({waitUntil:'domcontentloaded'});await ready();await openPanel();await action('workspace-issues').click();await ops().locator('[data-role="issue-filter"]').selectOption('all');await settled();
  const row=ops().locator(`article[data-issue-id="${issueId}"]`);await row.waitFor({state:'visible'});assert.match(await row.innerText(),/已关闭|关闭/);assert.equal((await issue()).status,'closed');
  await action('workspace-tasks').click();await chooseTask(taskA);assert.equal((await sceneSnapshot()).results.find(r=>r.resourceId===machineA)?.status,'overlap');assert.equal((await counts())['open-issues'],0);assert(await ops().locator(`[data-action="report-risk"][data-resource-id="${machineA}"][data-limit-id="${limitId}"]`).isEnabled());
  await action('workspace-issues').click();await screenshot('04-persisted-closed-history');
  assert.deepEqual(report.personnelPositioning.requests,[]);return{issueId,persistedStatus:'closed',currentGeometricResult:'overlap',openIssueCount:0,allowsExplicitNewEpisode:true,personnelPositioningRequests:0,pageErrors:report.pageErrors,consoleErrors:report.consoleErrors};
 });
}

try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const options=process.env.BROWSER_LAUNCH_OPTIONS?(await import(pathToFileURL(resolve(process.env.BROWSER_LAUNCH_OPTIONS)).href)).default:{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined};
 server=await createServer({server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:null},plugins:[{name:'isolated-rail-task-fixture',configResolved(config){config.server.watch=null;},resolveId(id){if(id==='/__rail-task-fixture/cesium.ts')return'\0rail-task-fixture-cesium';},load(id){if(id==='\0rail-task-fixture-cesium')return'export * from "cesium";';},configureServer(s){s.middlewares.use((req,res,next)=>{let value;if(req.url==='/__rail-task-fixture/tileset.json')value=fixtureTiles;else if(req.url==='/__rail-task-fixture/plane.gltf')value=fixtureGltf;else return next();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});}}]});
 await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;report.origin=origin;console.log('Isolated task-workbench acceptance server:',origin);
 browser=await chromium.launch(options);report.browserVersion=browser.version();context=await browser.newContext({viewport:{width:1366,height:768}});
 await context.route('**/__basemap/**',r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')}));
 page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.pageErrors.push({check:activeCheck?.id,message:e.message}));page.on('console',e=>{if(e.type()==='error')report.consoleErrors.push({check:activeCheck?.id,message:e.text().slice(0,700),url:e.location().url});});page.on('request',r=>{if(r.url().includes('/__management/positioning'))report.personnelPositioning.requests.push({method:r.method(),url:r.url()});if(r.url().endsWith('/__management/commands')){try{const d=r.postDataJSON();report.commands.push({type:d.type,id:d.id});}catch{}}});
 await fixtures();await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await ready();await page.locator('#basemap').selectOption('none');await addSurface();await openPanel();await frame();
 const scene=await sceneSnapshot();assert.equal(scene.results.find(r=>r.resourceId===machineA)?.status,'overlap');assert.equal(scene.results.find(r=>r.resourceId===machineB)?.status,'clear');baseline={results:scene.results,collections:(await snapshot()).collections};
 await runCases();assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.personnelPositioning.requests,[]);report.result='passed';
}catch(error){report.result='failed';report.failure=String(error.stack||error);if(activeCheck?.status==='running'){activeCheck.status='failed';activeCheck.error=report.failure;}process.exitCode=1;console.error(error);if(page){await screenshot('failure',true).catch(e=>{report.failureScreenshotError=String(e);});report.failureVisibleText=(await page.locator('body').innerText({timeout:5000}).catch(()=>'' )).slice(-10000);}}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await server?.close();await rm(dataDir,{recursive:true,force:true});}
