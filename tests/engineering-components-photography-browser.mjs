// Real GPU, real immutable sample GLBs, and an independently generated 3D Tiles
// photography surface. This deliberately tests native photography pixels, not
// the old engineering diagnostic framebuffer. Production data is never loaded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { cesiumOwnedClippingShaderPlugin } from '../server/cesiumOwnedClippingShader.ts';

const root = resolve('.'), output = resolve(process.env.ENGINEERING_PHOTOGRAPHY_OUT || 'output/engineering-components-photography');
const baselineRoot = resolve(process.env.ENGINEERING_BASELINE_SOURCE || root);
const assets = process.env.ENGINEERING_REAL_ASSETS || process.env.CESIUM_ENGINEERING_ASSETS_DIR;
if (!assets) throw Error('Set ENGINEERING_REAL_ASSETS to the original read-only Jiashan_Rebuilt_v2.0 package');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url), cesium = dirname(require.resolve('cesium/package.json'));
const playwright = process.env.PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import('playwright');
const catalog = JSON.parse(await readFile(resolve(assets, 'components.json'), 'utf8'));
const referenceIds = catalog.referenceGeometry.map(item => item.id), references = new Set(referenceIds);
const real = new Map();
for (const [unit, kind] of [['A001','bridge'],['TN021','tunnel'], ...(process.env.ENGINEERING_FULL_LINE === '1' ? [['FULL','']] : [])]) {
  const path = resolve(assets, unit === 'FULL' ? 'models/Jiashan.glb' : `structure-library/${kind}/${unit}/model.glb`), bytes = await readFile(path);
  const doc = JSON.parse(bytes.subarray(20, 20+bytes.readUInt32LE(12)));
  const nodes = doc.nodes.filter(node => node.mesh !== undefined && !references.has(node.extras?.componentId ?? node.name));
  const triangleCount = nodes.reduce((sum,node) => sum + doc.meshes[node.mesh].primitives.reduce((sum,p) => sum + doc.accessors[p.indices].count/3, 0), 0);
  real.set(unit, { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), componentCount: nodes.length, triangleCount });
}
const frame = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121,31,0)));
function photography(unit) {
  const [x,y,r] = unit === 'FULL' ? [-150,450,1200] : unit === 'A001' ? [0,0,30] : [-265.270682344,803.740794852,110];
  const positions = new Float32Array([x-r,20,-(y-r), x+r,20,-(y-r), x+r,20,-(y+r), x-r,20,-(y+r)]), indices = new Uint16Array([0,1,2,0,2,3]);
  const binary = Buffer.concat([Buffer.from(positions.buffer),Buffer.from(indices.buffer)]);
  const doc = { asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[0.05,0.8,0.1,1]},doubleSided:true,extensions:{KHR_materials_unlit:{}}}],
    buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteLength:positions.byteLength},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[x-r,20,-y-r],max:[x+r,20,-y+r]},{bufferView:1,componentType:5123,count:6,type:'SCALAR'}] };
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
  return { glb:Buffer.concat([header,json,bh,binary]), tileset:{asset:{version:'1.1',gltfUpAxis:'Y'},geometricError:500,root:{transform:frame,boundingVolume:{box:[x,y,20,r,0,0,0,r,0,0,0,1]},geometricError:0,refine:'ADD',content:{uri:'surface.glb'}}} };
}
const photos = new Map(['A001','TN021','FULL'].map(unit=>[unit,photography(unit)]));
const report = { startedAt:new Date().toISOString(),passed:false,checks:[],pageErrors:[],consoleErrors:[],consoleWarnings:[],failedRequests:[],sourceAssets:[...real].map(([unit,a])=>({unit,sha256:a.sha256,componentCount:a.componentCount,triangleCount:a.triangleCount})),productionDataUsed:false };
report.syntheticScene={longitude:121,latitude:31,ellipsoidHeight:0,photographyENUHeight:20,modelForwardAxis:'Cesium default Z',photography:'Generated unlit GLB in a real Cesium3DTileset; original engineering GLBs are read-only.'};
report.scope=process.env.ENGINEERING_ONLY_FULL==='1'?'Full-line GPU capacity only; sample checks are not executed in this report.':'A001 and TN021 native photography clipping; optional full-line capacity.';
const sourceFiles = ['src/engineeringComponents/footprintClient.ts','src/engineeringComponents/footprints.worker.ts','src/engineeringComponents/footprints.ts','src/engineeringComponents/photography.ts',
  'src/engineeringComponents/preciseClipping.ts','src/engineeringComponents/preciseGeometry.ts','src/ownedClippingPolygons.ts',
  'src/temporaryWorksClipping.ts','server/cesiumOwnedClippingShader.ts','tests/engineering-components-photography-browser.mjs','tools/fixtures/engineering-components-photography.ts'];
const sourceHashes = async () => Promise.all(sourceFiles.map(async path => ({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
let server,browser,page;
const green = probe => probe.pixel[1]>150 && probe.pixel[1]>probe.pixel[0]*1.8 && probe.pixel[1]>probe.pixel[2]*1.8;
const photoPresent = (probe,label) => { assert.equal(probe.photographyPicked,true,label+' photography must be picked '+JSON.stringify(probe));assert.ok(green(probe),label+' photography pixel must remain green '+JSON.stringify(probe)); };
const photoAbsent = (probe,label) => { assert.equal(probe.photographyPicked,false,label+' photography must be removed from native picking '+JSON.stringify(probe));assert.equal(green(probe),false,label+' photography pixel must disappear '+JSON.stringify(probe)); };
const call = async (method,...args) => { const result=await page.evaluate(([method,args])=>window.engineeringPhotographyFixture[method](...args),[method,args]);report.lastCall={method,result};return result; };
async function check(name, fn) { console.log('RUN',name);const item={name};report.checks.push(item);const start=performance.now();try{item.evidence=await fn();item.gpuErrors=await page.evaluate(()=>window.engineeringPhotographyFixture.glErrors());assert.deepEqual(item.gpuErrors,[],'Native WebGL must report NO_ERROR');item.passed=true;console.log('PASS',name);}catch(error){item.passed=false;item.error=String(error.stack||error);throw error;}finally{item.milliseconds=performance.now()-start;} }
try {
  report.sourceHashes = await sourceHashes();
  if(process.env.ENGINEERING_BASELINE_SOURCE){report.baselineSourceFiles=await Promise.all(['src/temporaryWorksClipping.ts','server/cesiumOwnedClippingShader.ts'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(baselineRoot,path))).digest('hex')})));}
  const dependencyPrefix='/@fs/'+(await realpath('node_modules')).replaceAll('\\','/')+'/';
  const localPrefix='/@fs/'+resolve('node_modules').replaceAll('\\','/')+'/';
  server=await createServer({configFile:false,root,cacheDir:resolve('.vite/engineering-photography'),optimizeDeps:{include:['cesium','@cesium/engine','three','clipper-lib']},server:{host:'127.0.0.1',port:5301,strictPort:true,hmr:false,fs:{allow:[root,resolve(baselineRoot,'src'),resolve(cesium,'../..')]}},
    plugins:[cesiumOwnedClippingShaderPlugin(),{name:'engineering-photography-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      try {
        if(req.url?.split('?')[0]===dependencyPrefix+'vite/dist/client/env.mjs'){const value=await server.transformRequest(req.url);res.setHeader('Content-Type','text/javascript');res.end(value.code);return;}
        if(req.url?.startsWith(dependencyPrefix))req.url=localPrefix+req.url.slice(dependencyPrefix.length);
        const pathname=new URL(req.url,'http://fixture').pathname;
        if(pathname==='/__engineering_old_manager'){res.setHeader('Content-Type','application/javascript');res.end('export {TemporaryWorksClippingManager} from '+JSON.stringify('/@fs/'+resolve(baselineRoot,'src/temporaryWorksClipping.ts').replaceAll('\\','/'))+';');return;}
        if(pathname==='/__engineering_real/meta.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({referenceIds}));return;}
        const original=real.get(pathname.match(/^\/__engineering_real\/(A001|TN021|FULL)\.glb$/)?.[1]);
        if(original){res.setHeader('Content-Type','model/gltf-binary');res.end(original.bytes);return;}
        const photoPath=pathname.match(/^\/__engineering_photo\/(A001|TN021|FULL)\/(tileset\.json|surface\.glb)$/);
        if(photoPath){const photo=photos.get(photoPath[1]),json=photoPath[2]==='tileset.json';res.setHeader('Content-Type',json?'application/json':'model/gltf-binary');res.end(json?JSON.stringify(photo.tileset):photo.glb);return;}
        if(pathname.startsWith('/__engineering_cesium/')){const base=resolve(cesium,'Build/Cesium'),path=resolve(base,decodeURIComponent(pathname.slice('/__engineering_cesium/'.length)));if(!path.startsWith(base+'\\')&&!path.startsWith(base+'/'))throw Error('Invalid Cesium asset path');res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.json')?'application/json':'application/octet-stream');res.end(await readFile(path));return;}
        next();
      }catch(error){res.statusCode=500;res.end(String(error));}
    });}}]});
  await server.listen();
  browser=await playwright.chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox','--disable-gpu-sandbox','--enable-webgl','--ignore-gpu-blocklist']});
  page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1});
  await page.addInitScript(() => { window.__photographyWorkerErrors=[];const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.addEventListener('error',event=>window.__photographyWorkerErrors.push({message:event.message,filename:event.filename,line:event.lineno,column:event.colno,stack:event.error?.stack}));}}; });
  page.on('pageerror',error=>report.pageErrors.push(String(error)));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());if(message.type()==='warning')report.consoleWarnings.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)report.failedRequests.push({url:response.url(),status:response.status()});});
  for(const unit of process.env.ENGINEERING_ONLY_FULL==='1'?[]:['A001','TN021']) {
    await page.goto(`http://127.0.0.1:5301/tools/fixtures/engineering-components-photography.html?unit=${unit}`);
    await page.waitForFunction(()=>window.engineeringPhotographyFixture,undefined,{timeout:120000});
    const gpu=await call('gpu');assert.doesNotMatch(gpu.renderer,/swiftshader|software|llvmpipe/i);report.gpu=gpu;
    await check(`${unit}: photography covers the real engineering model before clipping`,async()=>{const r=await call('state',false,false);report.initial=r;photoPresent(r.center,'center');photoPresent(r.outside,'AABB corner');assert.equal(r.sourceHash,real.get(unit).sha256);return r;});
    if(process.env.ENGINEERING_DIAG_LEGACY==='1')report.legacyDiagnostic=await call('legacyDiagnostics');
    if(process.env.ENGINEERING_BASELINE_SOURCE)report.baselineLegacy=await call('baselineLegacy');
    await check(`${unit}: all four V/O combinations alter real photography independently`,async()=>{const rows=[];for(const [visible,occlusion]of [[true,true],[false,true],[true,false],[false,false]]){const r=await call('state',visible,occlusion);(occlusion?photoAbsent:photoPresent)(r.center,'center');photoPresent(r.outside,'outside exact mesh footprint');assert.deepEqual(r.errors,[]);assert.deepEqual(r.modelMatrix,r.initialMatrix);rows.push({visible,occlusion,...r});}return rows;});
    await check(`${unit}: camera and photography transform preserve geographic clipping`,async()=>{await call('state',false,true);const angled=await call('camera',-.8);photoAbsent(angled.center,'oblique center');photoPresent(angled.outside,'oblique outside');const transformed=await call('photographyTransform',.4,3,2);photoAbsent(transformed.center,'transformed photo center');photoPresent(transformed.outside,'transformed photo outside');await call('photographyTransform',0,0,0);const restored=await call('camera',-Math.PI/2);return {angled,transformed,restored};});
    await check(`${unit}: independent 2 m legacy footprint remains accurate while engineering clipping is active`,async()=>{
      const before=await call('smallLegacy',false);photoPresent(before.smallLegacy,'2 m legacy before enable');
      const active=await call('smallLegacy',true);photoAbsent(active.smallLegacy,'2 m legacy under precise engineering');photoAbsent(active.center,'engineering retained');
      const removed=await call('smallLegacy',false);photoPresent(removed.smallLegacy,'2 m legacy removed independently');photoAbsent(removed.center,'engineering retained after independent legacy removal');return {before,active,removed};
    });
    if(unit==='A001')await check('A001: original 1 m pile clips photography while hidden and preserves its curved footprint exterior',async()=>{
      const p=[1.607891343,-.734632854];await call('select',['A001_pile_01']);await call('hideModel',true);
      const inside=[];for(const [x,y]of [[0,0],[.25,0],[-.25,0],[0,.25],[0,-.25]]){const r=await call('probe',[p[0]+x,p[1]+y]);photoAbsent(r,'inside real 1 m circular pile');inside.push(r);}
      // Independently ray-projecting all 124 source indexed triangles to the
      // z=20 photography plane proves these four ±.49 corners are outside by
      // at least .05345 m while still inside the source 1 m square. The ±.45
      // lower corners were actually inside the 60 m deep pile's central-ray
      // silhouette; a horizontal circle would be an incorrect test oracle.
      const outside=[];for(const [x,y]of [[.49,.49],[-.49,.49],[.49,-.49],[-.49,-.49],[.7,0],[0,.7]]){const r=await call('probe',[p[0]+x,p[1]+y]);photoPresent(r,'outside exact curved projection, including AABB corners');outside.push(r);}
      await call('photographyTransform',.4,3,2);const transformed=await call('probe',p);photoAbsent(transformed,'1 m pile after photography transform');
      await call('camera',-.8);const oblique=await call('probe',p);photoAbsent(oblique,'1 m pile from oblique camera');
      await call('photographyTransform',0,0,0);await call('camera',-Math.PI/2);await call('clear');const restored=await call('probe',p);photoPresent(restored,'1 m pile withdrawal restores original photography');
      await call('hideModel',false);await call('select',['A001_cap_01']);return {inside,outside,transformed,oblique,restored};
    });
    await check(`${unit}: legacy building and road clipping coexist and survive engineering clear`,async()=>{await call('state',false,true);const both=await call('legacy',true);const cleared=await call('clear');report.compatibilityProbe={both,cleared};photoAbsent(both.center,'engineering');photoAbsent(both.legacy,'legacy building');photoAbsent(both.road,'road');photoPresent(cleared.center,'cleared engineering');photoAbsent(cleared.legacy,'retained legacy');photoAbsent(cleared.road,'retained road');return {both,cleared};});
    await check(`${unit}: hidden entire model retains selected photography clipping`,async()=>{await call('state',false,true);const r=await call('hideModel',true);photoAbsent(r.center,'hidden model');photoAbsent(r.legacy,'legacy');assert.equal(r.modelShow,false);await call('hideModel',false);return r;});
    await check(`${unit}: suspension withdraws only engineering and restores latest contribution`,async()=>{const suspended=await call('suspend',true);photoPresent(suspended.center,'suspended engineering');photoAbsent(suspended.legacy,'legacy');photoAbsent(suspended.road,'road');const resumed=await call('suspend',false);photoAbsent(resumed.center,'resumed engineering');return {suspended,resumed};});
    await check(`${unit}: underground target lease restores all contributors safely`,async()=>{const suspended=await call('underground',true);photoPresent(suspended.center,'underground engineering');photoPresent(suspended.legacy,'underground legacy');photoPresent(suspended.road,'underground road');const resumed=await call('underground',false);photoAbsent(resumed.center,'restored engineering');photoAbsent(resumed.legacy,'restored legacy');photoAbsent(resumed.road,'restored road');return {suspended,resumed};});
    await check(`${unit}: 2D and Columbus transitions return to 3D with clipping and legacy contributors intact`,async()=>{
      const rows=[];for(const [mode,value]of [['2D',2],['CV',1]]){const transitioned=await call('sceneMode',mode);assert.equal(transitioned.mode,value);assert.deepEqual(transitioned.errors,[]);
        const restored=await call('sceneMode','3D');assert.equal(restored.mode,3);photoAbsent(restored.center,'3D engineering restored');photoAbsent(restored.legacy,'3D legacy retained');photoAbsent(restored.road,'3D road retained');photoPresent(restored.outside,'3D outside preserved');rows.push({transitioned,restored});}return rows;
    });
    await check(`${unit}: hidden-model displacement restores old photography and clips new geometry position`,async()=>{await call('legacy',false);await call('hideModel',true);const distance=unit==='A001'?7:35;const moved=await call('move',0,distance);photoPresent(moved.center,'old footprint');photoAbsent(moved.moved,'new footprint');assert.equal(moved.modelShow,false);const restored=await call('move',0,0);photoAbsent(restored.center,'restored position');await call('hideModel',false);return {moved,restored};});
    if(unit==='A001')await check('A001: heading and physical scale transform the original footprint',async()=>{
      // Independent source-triangle projection gives this point .49282 m
      // outside initially and .27890 m inside after heading +pi/4.
      const before=await call('probe',[-1,2.5]);photoPresent(before,'outside original rotated-square cap');
      await call('transform',Math.PI/4,1);const rotated=await call('probe',[-1,2.5]);photoAbsent(rotated,'inside rotated cap');
      await call('transform',0,.4);const scaled=await call('probe',[0,1.5]);photoPresent(scaled,'outside scaled cap');
      const restored=await call('transform',0,1);photoAbsent(await call('probe',[0,1.5]),'restored full-scale cap');return {before,rotated,scaled,restored};
    });
    await check(`${unit}: every component contributes its original indexed geometry`,async()=>{const r=await call('all');assert.equal(r.projection.componentCount,real.get(unit).componentCount);assert.equal(r.projection.triangleCount,real.get(unit).triangleCount);photoAbsent(r.center,'all components');photoPresent(r.outside,'all geometry preserves outside');return r;});
    await page.screenshot({path:resolve(output,`${unit}-photography-clipped.png`)});
    await check(`${unit}: dispose restores original photography and node visibility`,async()=>{const r=await call('dispose');photoPresent(r.center,'disposed center');photoPresent(r.outside,'disposed outside');assert.equal(r.polygons,0);assert.equal(r.restoredNodes,true);assert.deepEqual(r.errors,[]);return r;});
  }
  if(real.has('FULL'))await check('full line: complete original 25,258-component geometry projects without truncation',async()=>{
    await page.goto('http://127.0.0.1:5301/tools/fixtures/engineering-components-photography.html?unit=FULL');await page.waitForFunction(()=>window.engineeringPhotographyFixture,undefined,{timeout:120000});
    const gpu=await call('gpu');assert.doesNotMatch(gpu.renderer,/swiftshader|software|llvmpipe/i);assert.ok(gpu.renderer,'Actual GPU renderer must be reported');report.gpu=gpu;
    const r=await call('projectAll');assert.equal(r.componentCount,real.get('FULL').componentCount);assert.equal(r.triangleCount,real.get('FULL').triangleCount);assert.equal(r.sourceHash,real.get('FULL').sha256);assert.deepEqual(r.errors,[]);assert.equal(r.status.state,'active');
    for(const sample of ['a001','tn021']){photoPresent(r.before[sample],sample+' before full-line clipping');photoAbsent(r.after[sample],sample+' with full-line clipping');photoPresent(r.cleared[sample],sample+' after full-line clear');}return r;
  });
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.failedRequests,[]);
  assert.deepEqual(report.consoleWarnings.filter(message=>/GL_INVALID_|Error compiling|CONTEXT_LOST/i.test(message)),[],'GPU draw/compile failures must not be treated as successful clipping');
  report.sourceHashesAfter=await sourceHashes();assert.deepEqual(report.sourceHashesAfter,report.sourceHashes);report.passed=true;
}catch(error){report.error=String(error.stack||error);report.workerErrors=await page?.evaluate(()=>window.__photographyWorkerErrors).catch(()=>[]);report.gpuDiagnostic=await page?.evaluate(()=>window.engineeringPhotographyFixture?.debug?.()).catch(error=>({error:String(error)}));await page?.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});process.exitCode=1;console.error(report.error,JSON.stringify(report.workerErrors));}finally{
  report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();await server?.close();console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output}));
}
