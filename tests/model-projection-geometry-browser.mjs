import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {Cartesian3,Matrix4,Transforms} from 'cesium';
import {cesiumOwnedClippingShaderPlugin} from '../server/cesiumOwnedClippingShader.ts';
import {syntheticContactModels,photographyGlb,boxTriangles,makeGlb} from './model-contact-fixtures.mjs';

const baselineRoot=resolve(process.env.ENGINEERING_BASELINE_SOURCE||'../engineering-components-photography-fix');
const root=resolve('.'),output=resolve(process.env.PROJECTION_BROWSER_OUT||'output/model-projection-browser');
await mkdir(output,{recursive:true});
const require=createRequire(import.meta.url),cesium=dirname(require.resolve('cesium/package.json'));
const playwright=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href):await import('playwright');
const models=syntheticContactModels(),meta={models:{}};
models.set('ring',makeGlb([
  boxTriangles([-4,-4,1],[-2,4,3]),boxTriangles([2,-4,1],[4,4,3]),
  boxTriangles([-2,-4,1],[2,-2,3]),boxTriangles([-2,2,1],[2,4,3]),
]));
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
const sourceFiles=[...(await readdir('src/modelContactOcclusion')).filter(n=>n.endsWith('.ts')).map(n=>'src/modelContactOcclusion/'+n),'src/engineeringComponents/footprints.ts','src/temporaryWorksClipping.ts','server/cesiumOwnedClippingShader.ts','tools/fixtures/model-projection-geometry.ts','tests/model-projection-geometry-browser.mjs'];
const hashes=()=>Promise.all(sourceFiles.map(async path=>({path,sha256:digest(await readFile(path))})));
let server,browser,page;
const green=p=>p.pixel[1]>150&&p.pixel[1]>p.pixel[0]*1.8&&p.pixel[1]>p.pixel[2]*1.8;
function expect(p,present,label){assert.equal(p.photographyPicked,present,label+' native photograph picking: '+JSON.stringify(p));assert.equal(green(p),present,label+' real photograph pixel: '+JSON.stringify(p));assert.deepEqual(p.errors,[]);}
const call=(name,...args)=>page.evaluate(([name,args])=>window.modelProjectionFixture[name](...args),[name,args]);
async function check(name,action){console.log('RUN',name);const row={name};report.checks.push(row);const start=performance.now();try{row.evidence=await action();row.glErrors=await call('glErrors');assert.deepEqual(row.glErrors,[]);row.passed=true;console.log('PASS',name);}catch(error){row.passed=false;row.error=String(error.stack||error);throw error;}finally{row.milliseconds=performance.now()-start;}}
async function open(name){
  await page.goto(`http://127.0.0.1:5314/tools/fixtures/model-projection-geometry.html?model=${name}`,{waitUntil:'domcontentloaded',timeout:120000});
  await page.waitForFunction(()=>window.modelProjectionFixture||window.__projectionInitializationErrors?.length,undefined,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>window.__projectionInitializationErrors),[],name+' initialization failed');
  const gpu=await call('gpu');assert.doesNotMatch(gpu.renderer,/swiftshader|software|llvmpipe/i);assert(gpu.renderer);report.gpu=gpu;
}
try{
  report.sourceHashes=await hashes();
  report.previousProjectionCommit=execFileSync('git',['-c','safe.directory='+baselineRoot,'-C',baselineRoot,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  assert.equal(report.previousProjectionCommit,'b296997e77591b899829cb48dd2fa41ac389b86c','Comparison must use the actual previous deployment');
  report.previousProjectionSourceSha256=digest(await readFile(resolve(baselineRoot,'src/engineeringComponents/footprints.ts')));
  const dependencyPrefix='/@fs/'+(await realpath('node_modules')).replaceAll('\\','/')+'/',localPrefix='/@fs/'+resolve('node_modules').replaceAll('\\','/')+'/';
  server=await createServer({configFile:false,root,cacheDir:resolve('.vite/model-contact'),optimizeDeps:{include:['cesium','@cesium/engine','three','clipper-lib']},
    server:{host:'127.0.0.1',port:5314,strictPort:true,hmr:false,fs:{allow:[root,baselineRoot,await realpath('node_modules'),resolve(cesium,'../..')]}},
    plugins:[cesiumOwnedClippingShaderPlugin(),{name:'model-contact-test',configureServer(server){server.middlewares.use(async(req,res,next)=>{try{
      if(req.url?.split('?')[0]===dependencyPrefix+'vite/dist/client/env.mjs'){const value=await server.transformRequest(req.url);res.setHeader('Content-Type','text/javascript');res.end(value.code);return;}
      if(req.url?.startsWith(dependencyPrefix))req.url=localPrefix+req.url.slice(dependencyPrefix.length);
      const pathname=new URL(req.url,'http://fixture').pathname;
      if(pathname==='/__projection_old_footprints'){res.setHeader('Content-Type','application/javascript');res.end('export {EngineeringFootprintGeometry} from '+JSON.stringify('/@fs/'+resolve(baselineRoot,'src/engineeringComponents/footprints.ts').replaceAll('\\','/'))+';');return;}
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
  await page.addInitScript(()=>{
    window.__projectionInitializationErrors=[];
    window.addEventListener('error',event=>window.__projectionInitializationErrors.push(String(event.error||event.message)));
    window.addEventListener('unhandledrejection',event=>window.__projectionInitializationErrors.push(String(event.reason)));
  });
  page.on('pageerror',e=>report.pageErrors.push(String(e)));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());if(m.type()==='warning')report.consoleWarnings.push(m.text());});page.on('response',r=>{if(r.status()>=400)report.failedRequests.push({url:r.url(),status:r.status()});});
  // These are fixed independent samples of the original synthetic triangle
  // meshes, not bounding-box expectations. Height does not limit this effect.
  const cases={
    bridge:[[[0,0,0],false,'ground under deck'],[[0,0,9],false,'inside deck'],[[0,0,12],false,'above deck'],[[6,0,9],true,'outside deck']],
    layers:[[[0,0,0],false,'below both'],[[0,0,5],false,'between decks'],[[0,0,12],false,'above both'],[[6,0,5],true,'outside layers']],
    cavity:[[[0,0,0],false,'inner cavity under roof projection'],[[0,0,10],false,'above cavity'],[[5,0,0],true,'outside shell']],
    open:[[[0,0,5],false,'original open plane'],[[0,0,-5],false,'below plane'],[[0,0,15],false,'above plane'],[[5,0,5],true,'outside plane']],
    concave:[[[-2,2,-5],false,'below L arm'],[[-2,2,10],false,'above L arm'],[[2,-2,2],false,'other L arm'],[[2,2,2],true,'real concavity']],
    crossing:[[[0,0,-10],false,'below crossed beams'],[[0,0,20],false,'above crossed beams'],[[3,3,5],true,'empty corner']],
    ring:[[[0,0,-20],true,'true hole below'],[[0,0,2],true,'true hole within walls'],[[0,0,20],true,'true hole above'],[[3,0,-20],false,'below wall'],[[3,0,20],false,'above wall'],[[5,0,2],true,'outside ring']],
  };
  for(const [name,rows]of Object.entries(cases)){
    await open(name);
    await check(name+': original photograph appears before projection',async()=>{
      const probes=[];for(const [point]of rows){const probe=await call('plane',point);expect(probe,true,'before projection');probes.push(probe);}return probes;
    });
    await check(name+': old projection effect crosses height and keeps exact exterior',async()=>{
      await call('enable',true);const probes=[];for(const [point,present,label]of rows){const probe=await call('plane',point);expect(probe,present,label);probes.push({label,probe});}return {info:await call('info'),probes};
    });
    await check(name+': off restores all sampled photography',async()=>{
      await call('enable',false);const probes=[];for(const [point]of rows){const probe=await call('plane',point);expect(probe,true,'projection removed');probes.push(probe);}return probes;
    });
  }
  await open('open');await call('enable',true);await call('plane',[0,0,-5]);
  await check('projection survives a 1km oblique camera and independent suspend leases',async()=>{
    const oblique=await call('cameraView',1000,Math.PI/4);expect(oblique,false,'oblique projection');
    expect(await call('underground',true),true,'target lease');expect(await call('underground',false),false,'target lease restored');
    expect(await call('globalSuspend',true),true,'global lease');expect(await call('globalSuspend',false),false,'global restored');return {oblique};
  });
  for(const [name,asset]of Object.entries(meta.models).filter(([,value])=>value.real)){
    await open(name);
    await check(name+': all original runtime triangles participate in height-independent GPU projection',async()=>{
      const info=await call('info');assert.equal(info.projection.triangleCount,info.sourceTriangles);
      if(name==='A001')assert.equal(info.sourceTriangles,1016);if(name==='TN021')assert.equal(info.sourceTriangles,7388);if(name==='FULL')assert.equal(info.sourceTriangles,805322);
      const ray=await call('sourceRay'),probes=[];
      for(const offset of [-50,0,50]){
        await call('enable',false);expect(await call('rayPlane',offset),true,'source ray before');
        await call('enable',true);const probe=await call('rayPlane',offset);expect(probe,false,'source ray offset '+offset);probes.push({offset,probe});
      }
      assert.equal(info.metadata.sha256,asset.sha256);
      const performance=name.startsWith('skp_')?await call('performanceComparison'):undefined;
      return {info,ray,probes,performance};
    });
    if(['A001','TN021','FULL'].includes(name))await check(name+': unchanged previous deployment and runtime adapter agree',async()=>{
      const comparison=await call('compareOld'),a=comparison.old,b=comparison.current;
      assert.equal(a.triangleCount,b.triangleCount);assert.equal(a.componentCount,b.componentCount);
      // Runtime node multiplication can change last-bit rounding. Use the
      // sum of both engines' declared spatial rounding budgets, never a pixel
      // percentage or an invented tolerance in square metres.
      const rounding=a.quantizationDisplacementBudgetMeters+b.quantizationDisplacementBudgetMeters;
      const perimeter=result=>result.footprints.reduce((sum,polygon)=>sum+[polygon.outer,...(polygon.holes||[])].reduce((n,ring)=>n+ring.reduce((s,p,i)=>{
        const q=ring[(i+1)%ring.length];return s+6378137*Math.PI/180*Math.hypot((p.longitude-q.longitude)*Math.cos(p.latitude*Math.PI/180),p.latitude-q.latitude);
      },0),0),0);
      const areaBudget=(perimeter(a)+perimeter(b))*rounding+Math.PI*rounding*rounding;
      assert(Math.abs(a.compiledAreaSquareMeters-b.compiledAreaSquareMeters)<=areaBudget,'Old/current area differs outside documented rounding budget');
      assert.equal(a.rawHoles,b.rawHoles,'Original projection holes preserved');
      const pixels=[];
      for(const offset of [-50,0,50]){await call('rayPlane',offset);const old=await call('useOld',true),current=await call('useOld',false);expect(old,false,'old source ray');expect(current,false,'new source ray');assert.deepEqual(current.pixel,old.pixel);pixels.push({offset,old,current});}
      if(name==='TN021')for(const [label,point]of [
        ['roof',[803.740794852,-.2313765,-265.270682344]],['bottom',[803.740794852,-8.1813765,-265.270682344]],
        ['left wall',[801.073865859,-4.1813765,-271.381066219]],['right wall',[806.018821076,-4.1813765,-258.117018109]],
        ['partition',[803.54522931,-4.1813765,-264.75203158]],['left chamber',[802.3095475845,-4.1813765,-268.0665488995]],
        ['right chamber',[804.782025193,-4.1813765,-261.4345248445]],['above',[803.740794852,3,-265.270682344]],['below',[803.740794852,-12,-265.270682344]],
      ]){
        await call('enable',false);expect(await call('plane',point,[0,1,0],5),true,'unmodified '+label);
        const old=await call('useOld',true),current=await call('useOld',false);
        expect(old,false,'previous deployed TN021 '+label);expect(current,false,'restored TN021 '+label);assert.deepEqual(current.pixel,old.pixel);pixels.push({label,point,old,current});
      }
      const summary=result=>Object.fromEntries(Object.entries(result).filter(([key])=>key!=='footprints'));
      return {old:summary(a),current:summary(b),areaBudget,rounding,pixels};
    });
    if(name==='FULL')await check('full-line original geometry capacity and rendering measurements',async()=>({info:await call('info'),performance:await call('performanceComparison')}));
    await check(name+': removing projection restores all original source-ray samples',async()=>{
      await call('enable',false);const probes=[];for(const offset of [-50,0,50]){const probe=await call('rayPlane',offset);expect(probe,true,'original restored');probes.push(probe);}return probes;
    });
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.consoleWarnings,[]);assert.deepEqual(report.failedRequests,[]);
  report.sourceHashesAfter=await hashes();assert.deepEqual(report.sourceHashesAfter,report.sourceHashes,'Sources changed during validation');
  assert.equal(digest(await readFile(resolve(baselineRoot,'src/engineeringComponents/footprints.ts'))),report.previousProjectionSourceSha256,'Previous projection oracle changed');
  for(const [name,file]of realPaths)assert.equal(digest(await readFile(file)),meta.models[name].sha256,'Original source changed');
  report.passed=true;
}catch(error){report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
finally{await browser?.close();await server?.close();report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output}));}
