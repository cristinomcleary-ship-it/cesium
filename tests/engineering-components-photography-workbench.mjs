// Actual main.ts, original immutable sample models, synthetic photography and
// an isolated project store. No production records or media are copied.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { createServer, loadConfigFromFile, preview } from 'vite';
import { Cartesian3, Matrix4, Transforms } from 'cesium';

const out = resolve(process.env.ENGINEERING_PHOTOGRAPHY_WORKBENCH_OUT || 'output/engineering-photography-workbench');
const productionBuild = process.env.ENGINEERING_PHOTOGRAPHY_PRODUCTION === '1';
const fullLine = process.env.ENGINEERING_PHOTOGRAPHY_FULL_LINE === '1';
await mkdir(out, { recursive: true });
const data = await mkdtemp(join(out, 'synthetic-data-'));
for (const key of ['CESIUM_DATA_DIR','CESIUM_MANAGEMENT_DATA_DIR','CESIUM_SAFETY_DATA_DIR']) process.env[key] = data;
process.env.CESIUM_VITE_CACHE_DIR = resolve('.vite/engineering-photography-workbench');
if (!process.env.CESIUM_ENGINEERING_ASSETS_DIR) throw Error('Original package directory required');
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const origin = 'http://127.0.0.1:5302', frame = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121,31,100)));
const records = ['A001','TN021'].map((unit,i)=>({version:1,id:`synthetic-${unit}`,name:unit,kind:'Model',visible:true,createdAt:'2026-11-20T00:00:00Z',updatedAt:'2026-11-20T00:00:00Z',
  files:{source:{name:unit+'.glb',url:`/__engineering-components/structure-library/${i?'tunnel':'bridge'}/${unit}/model.glb`}},settings:{matrix:frame,scale:1}}));
records.push({version:1,id:'synthetic-photo',name:'隔离验收摄影',kind:'3D Tiles',visible:true,createdAt:'2026-11-20T00:00:00Z',updatedAt:'2026-11-20T00:00:00Z',files:{},settings:{url:origin+'/__synthetic_photo/tileset.json'}});
if(fullLine)records.push({...records[0],id:'synthetic-full',name:'全线原件',visible:false,files:{source:{name:'Jiashan.glb',url:'/__engineering-components/models/Jiashan.glb'}}});
const p = new Float32Array([-400,25,60, 80,25,60, 80,25,-930, -400,25,-930]), indices = new Uint16Array([0,1,2,0,2,3]);
const bin = Buffer.concat([Buffer.from(p.buffer),Buffer.from(indices.buffer)]);
const gltf = {asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
  materials:[{pbrMetallicRoughness:{baseColorFactor:[.05,.8,.1,1]},doubleSided:true,extensions:{KHR_materials_unlit:{}}}],buffers:[{byteLength:bin.length}],
  bufferViews:[{buffer:0,byteLength:p.byteLength},{buffer:0,byteOffset:p.byteLength,byteLength:indices.byteLength}],
  accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-400,25,-930],max:[80,25,60]},{bufferView:1,componentType:5123,count:6,type:'SCALAR'}]};
let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20),bh=Buffer.alloc(8);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(bin.length);bh.writeUInt32LE(0x004e4942,4);
const photo = Buffer.concat([header,json,bh,bin]);
const tileset={asset:{version:'1.1',gltfUpAxis:'Y'},geometricError:500,root:{transform:frame,boundingVolume:{box:[-160,435,25,240,0,0,0,495,0,0,0,1]},geometricError:0,refine:'ADD',content:{uri:'surface.glb'}}};
const sourceFiles=['src/main.ts','src/engineeringComponents/controller.ts','src/engineeringComponents/panel.ts','src/engineeringComponents/photographyController.ts','src/engineeringComponents/projectionPose.ts','src/engineeringComponents/footprints.ts','src/engineeringComponents/photography.ts','src/engineeringComponents/preciseClipping.ts','src/engineeringComponents/preciseGeometry.ts','src/temporaryWorksClipping.ts','src/ownedClippingPolygons.ts','server/cesiumOwnedClippingShader.ts', 'tests/engineering-components-photography-workbench.mjs'];
const hashes=async()=>Promise.all(sourceFiles.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
const report={startedAt:new Date().toISOString(),passed:false,productionDataUsed:false,productionBuild,fullLine,checks:[],errors:[],failedRequests:[],consoleErrors:[],consoleWarnings:[]};
let server,browser,page;
// Production omits DEV globals. Read the existing controller through CDP, as the
// historical production road runner reads Viewer; never modify the built bundle.
async function attachProductionProbe(){
  if(!productionBuild)return;
  await page.locator('#openEngineeringComponents').waitFor();
  const cdp=await page.context().newCDPSession(page),group='engineering-photography-production-probe';
  try{
    const {result:fn}=await cdp.send('Runtime.evaluate',{expression:'Function.prototype',objectGroup:group});
    const {objects:constructors}=await cdp.send('Runtime.queryObjects',{prototypeObjectId:fn.objectId,objectGroup:group});
    const {result:prototype}=await cdp.send('Runtime.callFunctionOn',{objectId:constructors.objectId,objectGroup:group,functionDeclaration:`function(){for(const fn of this){const p=Object.getOwnPropertyDescriptor(fn,'prototype')?.value;if(p&&['activeInstanceId','photographyStats','isPicking'].every(k=>Object.getOwnPropertyDescriptor(p,k)?.get)&&typeof p.detachInstance==='function')return p;}}`});
    assert(prototype.objectId,'Production engineering controller prototype missing');
    const {objects}=await cdp.send('Runtime.queryObjects',{prototypeObjectId:prototype.objectId,objectGroup:group});
    const {result,exceptionDetails}=await cdp.send('Runtime.callFunctionOn',{objectId:objects.objectId,returnByValue:true,functionDeclaration:`function(){const c=this.find(c=>!c.disposed&&c.options?.viewer?.container===document.getElementById('cesiumContainer'));if(!c)throw Error('Live production controller missing');window.__engineeringComponents=c;window.__managementWorkspace={viewer:c.options.viewer};return true;}`});
    assert(!exceptionDetails,exceptionDetails?.exception?.description);assert.equal(result.value,true);
  }finally{await cdp.send('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});await cdp.detach();}
}
async function check(name,fn){console.log('RUN',name);const item={name};report.checks.push(item);try{item.evidence=await fn();item.glError=await page.evaluate(()=>window.__managementWorkspace.viewer.scene.context._gl.getError());assert.equal(item.glError,0,'WebGL draw failed');item.passed=true;console.log('PASS',name);}catch(error){item.passed=false;throw error;}}
async function ready(){await page.waitForFunction(()=>{const c=window.__engineeringComponents;return c?.photographyStats&&!c.photographyStats.busy;},undefined,{timeout:180000});}
async function sample(x=0,y=0){await ready();return page.evaluate(async([x,y])=>{
  const c=window.__engineeringComponents,v=window.__managementWorkspace.viewer,m=c.instance.model,M=m.modelMatrix.constructor,C=m.boundingSphere.center.constructor;
  const frame=window.__photoTestFrame??=M.clone(c.instance.model.modelMatrix);
  const point=M.multiplyByPoint(frame,new C(x,y,25),new C());
  for(let i=0;i<5;i++)await new Promise(resolve=>{const stop=v.scene.postRender.addEventListener(()=>{stop();resolve();});v.scene.requestRender();});
  const pos=v.scene.cartesianToCanvasCoordinates(point),pick=v.scene.pick(pos,1,1),context=v.scene.context;
  const px=context.readPixels({x:Math.floor(pos.x*v.scene.drawingBufferWidth/v.canvas.clientWidth),y:Math.floor((v.canvas.clientHeight-pos.y)*v.scene.drawingBufferHeight/v.canvas.clientHeight),width:1,height:1});
  return {photo:!!pick?.primitive?.root,pixel:[...px],status:c.photographyStats,message:document.querySelector('[data-ec="photography-status"]').textContent,visible:c.instance.model.show};
},[x,y]);}
const absent=r=>{assert.equal(r.photo,false,JSON.stringify(r));assert.equal(r.pixel[1]>150&&r.pixel[1]>r.pixel[0]*1.8&&r.pixel[1]>r.pixel[2]*1.8,false,JSON.stringify(r));};
const present=r=>{assert.equal(r.photo,true,JSON.stringify(r));assert.ok(r.pixel[1]>150&&r.pixel[1]>r.pixel[0]*1.8&&r.pixel[1]>r.pixel[2]*1.8,JSON.stringify(r));};
async function focus(x=0,y=0){await page.evaluate(([x,y])=>{
  const c=window.__engineeringComponents,v=window.__managementWorkspace.viewer,m=c.instance.model,M=m.modelMatrix.constructor,C=m.boundingSphere.center.constructor;
  const frame=m.modelMatrix; window.__photoTestFrame=M.clone(frame);
  v.scene.globe.show=false;v.scene.skyAtmosphere.show=false;v.scene.skyBox.show=false;
  v.camera.setView({destination:M.multiplyByPoint(frame,new C(x,y,120),new C()),orientation:{direction:C.normalize(M.multiplyByPointAsVector(frame,new C(0,0,-1),new C()),new C()),up:C.normalize(M.multiplyByPointAsVector(frame,new C(0,1,0),new C()),new C())}});v.camera.frustum.near=.1;v.scene.requestRender();
},[x,y]);await page.waitForFunction(()=>{const v=window.__managementWorkspace.viewer;for(let i=0;i<v.scene.primitives.length;i++){const p=v.scene.primitives.get(i);if(p.root)return p.root.contentReady;}return false;},undefined,{timeout:90000});}
try{
  report.sourceHashes=await hashes();
  const viteEnv='/@fs/'+(await realpath(resolve(dirname(require.resolve('vite/package.json')),'dist/client/env.mjs'))).replaceAll('\\','/');
  const dependencyPrefix='/@fs/'+dirname(dirname(require.resolve('cesium/package.json'))).replaceAll('\\','/')+'/';
  const localPrefix='/@fs/'+resolve('node_modules').replaceAll('\\','/')+'/';
  const loaded=await loadConfigFromFile({command:'serve',mode:'development'},resolve('vite.config.ts'),undefined,undefined,undefined,'runner');
  const fixture={name:'photography-workbench-isolation',enforce:'pre',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    if(req.url?.split('?')[0]===viteEnv){res.setHeader('Content-Type','text/javascript');res.end((await server.transformRequest(req.url)).code);return;}
    if(req.url?.startsWith(dependencyPrefix))req.url=localPrefix+req.url.slice(dependencyPrefix.length);
    if(req.url==='/__synthetic_photo/tileset.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(tileset));return;}
    if(req.url==='/__synthetic_photo/surface.glb'){res.setHeader('Content-Type','model/gltf-binary');res.end(photo);return;}next();
  });}};
  fixture.configurePreviewServer=fixture.configureServer;
  if(productionBuild){
    report.buildIndexSha256=createHash('sha256').update(await readFile('dist/index.html')).digest('hex');
    server=await preview({...loaded.config,configFile:false,plugins:[fixture,...loaded.config.plugins],preview:{host:'127.0.0.1',port:5302,strictPort:true}});
  }else{
    server=await createServer({...loaded.config,configFile:false,plugins:[fixture,...loaded.config.plugins],server:{host:'127.0.0.1',port:5302,strictPort:true,hmr:false,watch:null}});await server.listen();
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox','--disable-gpu-sandbox','--enable-webgl','--ignore-gpu-blocklist']});
  page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(45000);
  page.on('pageerror',e=>report.errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());if(m.type()==='warning')report.consoleWarnings.push(m.text());});page.on('response',r=>{if(r.status()>=400)report.failedRequests.push({url:r.url(),status:r.status()});});
  await page.route('**/__library/records',route=>route.request().method()==='GET'?route.fulfill({json:{records,problems:[],deletedVideoIds:[]}}):route.continue());
  await page.goto(origin,{waitUntil:'domcontentloaded'});await attachProductionProbe();await page.waitForFunction(()=>window.__engineeringComponents?.options.getContext());
  await page.waitForFunction(count=>{const v=window.__managementWorkspace.viewer;let models=0,photo=0;for(let i=0;i<v.scene.primitives.length;i++){const p=v.scene.primitives.get(i);if(p.id?.engineeringModelId?.startsWith('synthetic-')&&p.ready)models++;if(p.root)photo++;}return models===count&&photo===1;},fullLine?3:2,{timeout:180000});
  await page.locator('#openEngineeringComponents').click();await page.locator('[data-ec="instance"]').selectOption('synthetic-A001');await page.locator('[data-ec-action="connect"]').click();await page.waitForFunction(()=>window.__engineeringComponents.activeInstanceId==='synthetic-A001');await focus();
  report.gpu=await page.evaluate(()=>{const gl=window.__managementWorkspace.viewer.scene.context._gl,e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);});assert.doesNotMatch(report.gpu,/swiftshader|software|llvmpipe/i);
  await check('actual workbench selection applies one component to actual photography',async()=>{
    present(await sample());await page.locator('[data-ec="photography-target"]').selectOption('synthetic-photo');await page.locator('[data-ec="search"]').fill('A001_cap_01');
    await page.locator('[data-component-id="A001_cap_01"] [data-ec-state="occlusionEnabled"]').check();const r=await sample();absent(r);assert.equal(r.status.clipping.state,'active');return r;
  });
  await check('component V and whole model visibility preserve photography O; closing panel preserves clipping',async()=>{
    await page.locator('[data-component-id="A001_cap_01"] [data-ec-state="visible"]').uncheck();absent(await sample());await page.evaluate(()=>{window.__engineeringComponents.instance.model.show=false;});absent(await sample());
    await page.locator('[data-ec-action="close"]').click();absent(await sample());await page.locator('#openEngineeringComponents').click();await page.evaluate(()=>{window.__engineeringComponents.instance.model.show=true;});return sample();
  });
  await check('master toggle and O toggle restore native photography',async()=>{
    await page.locator('[data-ec="photography-enabled"]').uncheck();present(await sample());await page.locator('[data-ec="photography-enabled"]').check();absent(await sample());
    await page.locator('[data-component-id="A001_cap_01"] [data-ec-state="occlusionEnabled"]').uncheck();present(await sample());return sample();
  });
  await check('group and all controls reach same real photography contribution',async()=>{
    await page.locator('[data-ec="search"]').fill('');await page.locator('[data-component-id="BR-LOW"] [data-ec-action="expand"]').click();await page.locator('[data-component-id="A001"] [data-ec-action="expand"]').click();await page.locator('[data-component-id="A001.cap"] [data-ec-state="occlusionEnabled"]').check();absent(await sample());
    await page.locator('[data-ec="all-occlusion"]').check();const r=await sample();absent(r);assert.equal(r.status.componentCount,6);return r;
  });
  await check('page refresh restores photography association and all component O',async()=>{
    await page.reload({waitUntil:'domcontentloaded'});await attachProductionProbe();await page.waitForFunction(()=>window.__engineeringComponents?.activeInstanceId==='synthetic-A001',undefined,{timeout:180000});await focus();const r=await sample();absent(r);assert.equal(r.status.targetId,'synthetic-photo');return r;
  });
  await check('actual controller detects model movement and retires the old footprint',async()=>{
    await page.evaluate(()=>{const c=window.__engineeringComponents,m=c.instance.model,M=m.modelMatrix.constructor,C=m.boundingSphere.center.constructor;m.modelMatrix=M.multiply(m.modelMatrix,M.fromTranslation(new C(12,0,0)),new M());window.__managementWorkspace.viewer.scene.requestRender();});
    await page.waitForFunction(()=>window.__engineeringComponents.photographyStats.busy);const old=await sample(),moved=await sample(12,0);present(old);absent(moved);return {old,moved};
  });
  await check('switching sample releases A001 clipping and applies TN021 through main host',async()=>{
    await page.locator('#openEngineeringComponents').click();await page.locator('[data-ec-action="disconnect"]').click();await page.locator('[data-ec="instance"]').selectOption('synthetic-TN021');await page.locator('[data-ec-action="connect"]').click();await page.waitForFunction(()=>window.__engineeringComponents.activeInstanceId==='synthetic-TN021');await focus(-265.270682344,803.740794852);
    await page.locator('[data-ec="photography-target"]').selectOption('synthetic-photo');await page.locator('[data-ec="all-visible"]').uncheck();await page.locator('[data-ec="all-occlusion"]').check();const r=await sample(-265.270682344,803.740794852);absent(r);assert.equal(r.status.componentCount,199);return r;
  });
  await page.screenshot({path:join(out,'TN021-main-workbench-photography.png')});
  await check('disconnect removes engineering clipping from loaded photograph',async()=>{await page.locator('[data-ec-action="disconnect"]').click();return page.evaluate(()=>{const v=window.__managementWorkspace.viewer;for(let i=0;i<v.scene.primitives.length;i++){const p=v.scene.primitives.get(i);if(p.root){if(p.clippingPolygons?.length)throw Error('Engineering polygons remained after disconnect');return {polygons:p.clippingPolygons?.length??0};}}throw Error('Photograph missing');});});
  if(fullLine){
    await check('full original GLB binds all physical components and cuts photography while model stays hidden',async()=>{
      await page.locator('[data-ec="instance"]').selectOption('synthetic-full');await page.locator('[data-ec-action="connect"]').click();await page.waitForFunction(()=>window.__engineeringComponents.activeInstanceId==='synthetic-full',undefined,{timeout:180000});await focus();
      await page.locator('[data-ec="photography-target"]').selectOption('synthetic-photo');await page.locator('[data-ec="all-occlusion"]').check();const r=await sample();absent(r);assert.equal(r.visible,false);assert.equal(r.status.componentCount,25258);assert.equal(r.status.clipping.state,'active');return r;
    });
    await check('full-line master off restores photography at A001 and TN021 then releases its scope',async()=>{
      await focus(-265.270682344,803.740794852);absent(await sample(-265.270682344,803.740794852));await page.locator('[data-ec="photography-enabled"]').uncheck();present(await sample(-265.270682344,803.740794852));await focus();present(await sample());await page.locator('[data-ec-action="disconnect"]').click();return {fullLineRestored:true};
    });
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.consoleWarnings.filter(value=>/GL_INVALID|Error compiling|CONTEXT_LOST/i.test(value)),[]);assert.deepEqual(report.failedRequests,[]);report.sourceHashesAfter=await hashes();assert.deepEqual(report.sourceHashesAfter,report.sourceHashes);report.passed=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);}finally{report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();if(server?.close)await server.close();else if(server?.httpServer)await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,out}));}
