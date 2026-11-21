import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {Cartesian3,Matrix4,Transforms} from 'cesium';
import {cesiumOwnedClippingShaderPlugin} from '../server/cesiumOwnedClippingShader.ts';
import {syntheticContactModels,photographyGlb} from './model-contact-fixtures.mjs';

const root=resolve('.'),output=resolve(process.env.CONTACT_BROWSER_OUT||'output/model-contact-browser');
await mkdir(output,{recursive:true});
const require=createRequire(import.meta.url),cesium=dirname(require.resolve('cesium/package.json'));
const playwright=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href):await import('playwright');
const models=syntheticContactModels(),meta={models:{}};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [name,bytes] of models)meta.models[name]={real:false,sha256:digest(bytes)};
const realPaths=new Map();
if(process.env.ENGINEERING_REAL_ASSETS){
  const assets=resolve(process.env.ENGINEERING_REAL_ASSETS),catalog=JSON.parse(await readFile(resolve(assets,'components.json'),'utf8'));
  const references=new Set(catalog.referenceGeometry.map(item=>item.id));
  for(const [name,file]of [['A001','structure-library/bridge/A001/model.glb'],['TN021','structure-library/tunnel/TN021/model.glb'],['FULL','models/Jiashan.glb']]){
    const path=resolve(assets,file),bytes=await readFile(path),doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
    const excludedNodes=doc.nodes.flatMap((node,i)=>references.has(node.extras?.componentId??node.name)?[i]:[]);
    models.set(name,bytes);realPaths.set(name,path);meta.models[name]={real:true,sha256:digest(bytes),excludedNodes,source:'Original read-only Jiashan model'};
  }
}
// Optional already-converted engineering resources. URLs are supplied locally;
// original SKP and project metadata are never uploaded or copied into this test.
for(const [name,url]of Object.entries(JSON.parse(process.env.CONTACT_MODEL_URLS||'{}'))){
  assert.match(name,/^[A-Za-z0-9_-]+$/);const parsed=new URL(url);assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname));assert.equal(parsed.protocol,'http:');
  const response=await fetch(parsed);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<=512*1024*1024);
  models.set(name,bytes);meta.models[name]={real:true,sha256:digest(bytes),source:'Read-only existing converted model; original file name and path omitted'};
}
const photo=photographyGlb(),frame=Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121,31,0)));
const tileset={asset:{version:'1.1',gltfUpAxis:'Y'},geometricError:500,root:{transform:frame,boundingVolume:{box:[0,0,0,20,0,0,0,20,0,0,0,.01]},geometricError:0,refine:'ADD',content:{uri:'surface.glb'}}};
const report={startedAt:new Date().toISOString(),passed:false,checks:[],pageErrors:[],consoleErrors:[],consoleWarnings:[],failedRequests:[],assets:meta.models,productionDataWritten:false};
const sourceFiles=[...(await readdir('src/modelContactOcclusion')).filter(n=>n.endsWith('.ts')).map(n=>'src/modelContactOcclusion/'+n),'src/temporaryWorksClipping.ts','server/cesiumOwnedClippingShader.ts','tools/fixtures/model-contact-occlusion.ts'];
const hashes=()=>Promise.all(sourceFiles.map(async path=>({path,sha256:digest(await readFile(path))})));
let server,browser,page;
const green=p=>p.pixel[1]>150&&p.pixel[1]>p.pixel[0]*1.8&&p.pixel[1]>p.pixel[2]*1.8;
function expect(p,present,label){assert.equal(p.photographyPicked,present,label+' native photograph picking: '+JSON.stringify(p));assert.equal(green(p),present,label+' real photograph pixel: '+JSON.stringify(p));assert.deepEqual(p.errors,[]);}
const call=(name,...args)=>page.evaluate(([name,args])=>window.modelContactFixture[name](...args),[name,args]);
async function check(name,action){console.log('RUN',name);const row={name};report.checks.push(row);const start=performance.now();try{row.evidence=await action();row.glErrors=await call('glErrors');assert.deepEqual(row.glErrors,[]);row.passed=true;console.log('PASS',name);}catch(error){row.passed=false;row.error=String(error.stack||error);throw error;}finally{row.milliseconds=performance.now()-start;}}
async function open(name){await page.goto(`http://127.0.0.1:5304/tools/fixtures/model-contact-occlusion.html?model=${name}`);await page.waitForFunction(()=>window.modelContactFixture,undefined,{timeout:240000});const gpu=await call('gpu');assert.doesNotMatch(gpu.renderer,/swiftshader|software|llvmpipe/i);assert(gpu.renderer);report.gpu=gpu;}
try{
  report.sourceHashes=await hashes();
  const dependencyPrefix='/@fs/'+(await realpath('node_modules')).replaceAll('\\','/')+'/',localPrefix='/@fs/'+resolve('node_modules').replaceAll('\\','/')+'/';
  server=await createServer({configFile:false,root,cacheDir:resolve('.vite/model-contact'),optimizeDeps:{include:['cesium','@cesium/engine','three','clipper-lib']},
    server:{host:'127.0.0.1',port:5304,strictPort:true,hmr:false,fs:{allow:[root,await realpath('node_modules'),resolve(cesium,'../..')]}},
    plugins:[cesiumOwnedClippingShaderPlugin(),{name:'model-contact-test',configureServer(server){server.middlewares.use(async(req,res,next)=>{try{
      if(req.url?.split('?')[0]===dependencyPrefix+'vite/dist/client/env.mjs'){const value=await server.transformRequest(req.url);res.setHeader('Content-Type','text/javascript');res.end(value.code);return;}
      if(req.url?.startsWith(dependencyPrefix))req.url=localPrefix+req.url.slice(dependencyPrefix.length);
      const pathname=new URL(req.url,'http://fixture').pathname;
      if(pathname==='/__contact/meta.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(meta));return;}
      const model=pathname.match(/^\/__contact\/model\/([A-Za-z0-9_-]+)\.glb$/)?.[1];
      if(model&&models.has(model)){res.setHeader('Content-Type','model/gltf-binary');res.end(models.get(model));return;}
      if(pathname==='/__contact/photo/tileset.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(tileset));return;}
      if(pathname==='/__contact/photo/surface.glb'){res.setHeader('Content-Type','model/gltf-binary');res.end(photo);return;}
      if(pathname.startsWith('/__contact_cesium/')){const base=resolve(cesium,'Build/Cesium'),file=resolve(base,decodeURIComponent(pathname.slice('/__contact_cesium/'.length)));assert(file.startsWith(base+'\\')||file.startsWith(base+'/'));res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':'application/octet-stream');res.end(await readFile(file));return;}
      next();
    }catch(error){res.statusCode=500;res.end(String(error));}});}}]});
  await server.listen();browser=await playwright.chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox','--disable-gpu-sandbox','--enable-webgl','--ignore-gpu-blocklist']});
  page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1});
  page.on('pageerror',e=>report.pageErrors.push(String(e)));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());if(m.type()==='warning')report.consoleWarnings.push(m.text());});page.on('response',r=>{if(r.status()>=400)report.failedRequests.push({url:r.url(),status:r.status()});});
  const cases={bridge:[[[0,0,0],true,'ground below viaduct'],[[0,0,9],false,'inside deck'],[[0,0,12],true,'above deck'],[[6,0,9],true,'beside deck'],[[-2.5,0,0],false,'inside pier']],
    layers:[[[0,0,0],true,'below both'],[[0,0,1.5],false,'inside lower'],[[0,0,5],true,'gap between decks'],[[0,0,9],false,'inside upper'],[[0,0,12],true,'above both']],
    overlap:[[[0,0,4],false,'overlap remains solid'],[[0,0,2],false,'first alone'],[[0,0,7],false,'second alone'],[[0,0,9],true,'above overlap']],
    cavity:[[[0,0,0],true,'enclosed inner cavity'],[[3,0,0],false,'side wall'],[[0,0,3],false,'roof wall'],[[5,0,0],true,'outside shell']],
    open:[[[0,0,5],false,'actual coplanar surface contact'],[[0,0,4.5],true,'below zero-thickness surface'],[[0,0,5.5],true,'above zero-thickness surface'],[[5,0,5],true,'outside source surface']],
    sloped:[[[3,0,6.5],false,'inside inclined beam'],[[3,0,4],true,'inside bounds below real inclined surface'],[[-3,0,6],true,'inside bounds above real inclined surface'],[[0,0,5],false,'inclined center']],
    concave:[[[-2,2,2],false,'vertical L arm'],[[2,-2,2],false,'horizontal L arm'],[[2,2,2],true,'concavity remains despite bounding box and hull'],[[-2,2,0],true,'below L arm'],[[-2,2,4],true,'above L arm']],
    crossing:[[[0,0,5],false,'intersecting beams union'],[[3,0,5],false,'first beam'],[[0,3,5],false,'second beam'],[[3,3,5],true,'empty corner between crossing beams'],[[0,0,0],true,'under crossing beams']]};
  if(process.env.CONTACT_ONLY_REAL!=='1')for(const [name,rows]of Object.entries(cases)){
    await open(name);
    await check(name+': photography is present before enabling',async()=>{const info=await call('info');const probes=[];for(const [p]of rows){const probe=await call('plane',p);expect(probe,true,name+' baseline');probes.push(probe);}return {info,probes};});
    await call('enable',true);
    await check(name+': only original 3D solid or surface contact is removed',async()=>{const probes=[];for(const [p,present,label]of rows){const probe=await call('plane',p);expect(probe,present,label);probes.push({label,probe});}return {info:await call('info'),probes};});
    await check(name+': disabling restores every original photography sample',async()=>{await call('enable',false);const probes=[];for(const [p]of rows){const probe=await call('plane',p);expect(probe,true,'restored');probes.push(probe);}return probes;});
  }
  if(process.env.CONTACT_ONLY_REAL!=='1'){
    await open('open');await call('enable',true);
    await check('open surface contact remains exact at distant oblique camera views',async()=>{
      const results=[];
      for(const z of [5,4.99,5.01]){await call('plane',[0,0,z]);const probe=await call('cameraView',1000,Math.PI/4);expect(probe,z!==5,'oblique 1km surface '+z);results.push({z,probe});}
      return results;
    });
    await open('bridge');await call('enable',true);
    await check('hidden-model movement and scale invalidate the old physical volume',async()=>{await call('plane',[0,0,9]);expect(await call('pose',12,0,0),true,'old location restored');expect(await call('plane',[0,0,9]),false,'new location clipped');await call('pose',0,0,0);await call('plane',[0,0,9]);expect(await call('pose',0,0,0,.5),true,'old upper height restored');expect(await call('plane',[0,0,9]),false,'scaled volume clipped');await call('pose',0,0,0,1);return await call('info');});
    await check('node selection changes the same physical volume without display coupling',async()=>{await call('select',[0]);expect(await call('plane',[-2.5,0,0]),true,'pier excluded');expect(await call('plane',[0,0,9]),false,'deck retained');await call('select',[1]);expect(await call('plane',[-2.5,0,0]),false,'pier included');expect(await call('plane',[0,0,9]),true,'deck excluded');await call('select',[0,1]);return await call('info');});
    await check('legacy clipping and underground/global suspension coexist with the 3D contribution',async()=>{expect(await call('plane',[0,0,0]),true,'ground retained before legacy');expect(await call('legacy',true),false,'legacy ground');expect(await call('underground',true),true,'underground lease');expect(await call('underground',false),false,'lease released');expect(await call('globalSuspend',true),true,'global suspension');expect(await call('globalSuspend',false),false,'global restored');await call('enable',false);expect(await call('sample'),false,'legacy survives engineering clear');await call('legacy',false);expect(await call('sample'),true,'legacy removed');return await call('info');});
  }
  for(const [name,asset]of Object.entries(meta.models).filter(([,m])=>m.real)){
    await open(name);
    await check(name+': original decoded geometry applies real 3D surface contact on GPU',async()=>{
      const info=await call('info'),contact=await call('sourceContact');assert.equal(info.stats.sourceTriangles,info.sourceTriangles);assert.equal(info.stats.packedTriangles,info.sourceTriangles);
      if(name==='A001')assert.equal(info.sourceTriangles,1016);if(name==='TN021')assert.equal(info.sourceTriangles,7388);if(name==='FULL')assert.equal(info.sourceTriangles,805322);
      expect(await call('plane',contact.point,contact.normal,1),true,'original surface before');await call('enable',true);expect(await call('sample'),false,'original triangle contact');
      const distance=Math.hypot(info.bounds[3]-info.bounds[0],info.bounds[4]-info.bounds[1],info.bounds[5]-info.bounds[2])+100;
      const far=contact.point.map((v,i)=>v+contact.normal[i]*distance);expect(await call('plane',far,contact.normal,1),true,'same projection beyond model extent');
      await call('plane',contact.point,contact.normal,1);await call('enable',false);expect(await call('sample'),true,'original contact restored');return {info,contact,assetHash:asset.sha256};
    });
    if(name==='A001')await check('A001: original cap, pier and pile solids clip with upper and lower photography preserved',async()=>{
      const rows=[[[0,.615,0],false,'cap'],[[0,4.615,0],false,'pier'],[[-.734632854,-30.285,1.607891343],false,'pile'],
        [[0,104.615,0],true,'above pier'],[[0,-95.385,0],true,'below pier projection'],[[-.734632854,-130.285,1.607891343],true,'below pile']];
      for(const [p,,label]of rows)expect(await call('plane',p,[0,1,0],1),true,label+' baseline');
      await call('enable',true);const probes=[];
      for(const [p,present,label]of rows){const probe=await call('plane',p,[0,1,0],1);expect(probe,present,label);probes.push({label,probe});}
      await call('enable',false);for(const [p,,label]of rows)expect(await call('plane',p,[0,1,0],1),true,label+' restored');return probes;
    });
    if(name==='TN021')await check('TN021: original tunnel walls clip while both inner chambers and vertical exterior survive',async()=>{
      const rows=[
        [[803.740794852,-0.2313765,-265.270682344],false,'roof slab'],
        [[803.740794852,-8.1813765,-265.270682344],false,'bottom slab'],
        [[801.073865859,-4.1813765,-271.381066219],false,'left wall'],
        [[806.018821076,-4.1813765,-258.117018109],false,'right wall'],
        [[803.54522931,-4.1813765,-264.75203158],false,'middle wall'],
        [[802.3095475845,-4.1813765,-268.0665488995],true,'left chamber'],
        [[804.782025193,-4.1813765,-261.4345248445],true,'right chamber'],
        [[803.740794852,3,-265.270682344],true,'above tunnel'],
        [[803.740794852,-12,-265.270682344],true,'below tunnel']];
      for(const [p,,label]of rows)expect(await call('plane',p,[0,1,0],1),true,label+' baseline');
      await call('enable',true);const probes=[];
      for(const [p,present,label]of rows){const probe=await call('plane',p,[0,1,0],1);expect(probe,present,label);probes.push({label,probe});}
      await call('enable',false);for(const [p,,label]of rows)expect(await call('plane',p,[0,1,0],1),true,label+' restored');
      return {probes,info:await call('info')};
    });
    if(name==='FULL')await check('FULL: complete contribution repeated allocation and same-camera frame observations',async()=>{
      const contact=await call('sourceContact');await call('plane',contact.point,contact.normal,1);return call('performanceComparison');
    });
    await page.screenshot({path:resolve(output,name+'-contact-restored.png')});
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.failedRequests,[]);assert.deepEqual(report.consoleWarnings.filter(x=>/GL_INVALID_|Error compiling|CONTEXT_LOST/i.test(x)),[]);
  report.sourceHashesAfter=await hashes();assert.deepEqual(report.sourceHashesAfter,report.sourceHashes);
  for(const [name,path]of realPaths)assert.equal(digest(await readFile(path)),meta.models[name].sha256,'source asset unchanged');
  report.passed=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);await page?.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await server?.close();console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output}));}
