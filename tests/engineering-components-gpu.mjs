import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root=resolve('.'), output=resolve(process.env.ENGINEERING_GPU_OUT||'output/engineering-components-gpu');
await mkdir(output,{recursive:true});
const require=createRequire(import.meta.url), cesium=dirname(require.resolve('cesium/package.json'));
const playwright=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href):await import('playwright');
function glb() {
  const positions = new Float32Array([-4,10,-4, 4,10,-4, 4,10,4, -4,10,4, -8,0,-8, 8,0,-8, 8,0,8, -8,0,8]);
  const indices=new Uint16Array([0,1,2,0,2,3]);
  const binary=Buffer.concat([Buffer.from(positions.buffer),Buffer.from(indices.buffer)]);
  const doc={asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],scene:0,scenes:[{nodes:[0,1]}],
    nodes:[{name:'front',mesh:0,extras:{componentId:'front'}},{name:'rear',mesh:1,extras:{componentId:'rear'}}],
    meshes:[{name:'front',primitives:[{attributes:{POSITION:0},indices:2,material:0}]},{name:'rear',primitives:[{attributes:{POSITION:1},indices:2,material:1}]}],
    materials:[[1,0,0,1],[0,1,0,1]].map(baseColorFactor=>({pbrMetallicRoughness:{baseColorFactor},doubleSided:true,extensions:{KHR_materials_unlit:{}}})),
    buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:48},{buffer:0,byteOffset:48,byteLength:48},{buffer:0,byteOffset:96,byteLength:12}],
    accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-4,10,-4],max:[4,10,4]},
      {bufferView:1,componentType:5126,count:4,type:'VEC3',min:[-8,0,-8],max:[8,0,8]},{bufferView:2,componentType:5123,count:6,type:'SCALAR'}]};
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,json,bh,binary]);
}
const source=glb(), sourceHash=createHash('sha256').update(source).digest('hex');
const report={startedAt:new Date().toISOString(),sourceHash,passed:false,checks:[],pageErrors:[],consoleErrors:[],expectedShaderFailureLogs:[]};
let expectingShaderFailure=false;
const realAssets=new Map();
if(process.env.ENGINEERING_REAL_ASSETS){for(const [unit,kind]of [['A001','bridge'],['TN021','tunnel']]){
  const path=resolve(process.env.ENGINEERING_REAL_ASSETS,'structure-library',kind,unit,'model.glb'),bytes=await readFile(path);
  realAssets.set(unit,{path,bytes,hash:createHash('sha256').update(bytes).digest('hex')});
}}
let realMeta;
if(process.env.ENGINEERING_FULL_LINE==='1'){
  if(!process.env.ENGINEERING_REAL_ASSETS)throw Error('Full-line acceptance requires ENGINEERING_REAL_ASSETS');
  const path=resolve(process.env.ENGINEERING_REAL_ASSETS,'models/Jiashan.glb'),bytes=await readFile(path);realAssets.set('FULL',{path,bytes,hash:createHash('sha256').update(bytes).digest('hex')});
  const catalog=JSON.parse(await readFile(resolve(process.env.ENGINEERING_REAL_ASSETS,'components.json'),'utf8'));realMeta={referenceIds:catalog.referenceGeometry.map(item=>item.id)};
}
let server,browser,page;
try {
  server=await createServer({configFile:false,root,cacheDir:resolve(root,'.vite/engineering-gpu'),server:{host:'127.0.0.1',port:5298,strictPort:true,fs:{allow:[root,resolve(cesium,'../..')]}},
    plugins:[{name:'engineering-gpu-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      try {const pathname=new URL(req.url,'http://fixture').pathname;
        if(pathname==='/__engineering_test/model.glb'){res.setHeader('Content-Type','model/gltf-binary');res.end(source);return;}
        if(pathname==='/__engineering_real/meta.json'&&realMeta){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(realMeta));return;}
        const real=realAssets.get(pathname.match(/^\/__engineering_real\/(A001|TN021|FULL)\.glb$/)?.[1]);
        if(real){res.setHeader('Content-Type','model/gltf-binary');res.end(real.bytes);return;}
        if(pathname.startsWith('/__engineering_cesium/')){const path=resolve(cesium,'Build/Cesium',decodeURIComponent(pathname.slice('/__engineering_cesium/'.length)));if(!path.startsWith(resolve(cesium,'Build/Cesium')+String.fromCharCode(92))&&!path.startsWith(resolve(cesium,'Build/Cesium')+'/'))throw Error('Invalid asset path');res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.json')?'application/json':'application/octet-stream');res.end(await readFile(path));return;}
        next();}catch(error){res.statusCode=500;res.end(String(error));}
    });}}]});console.log('Starting fixture server');await server.listen();console.log('Launching GPU browser');
  browser=await playwright.chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox','--disable-gpu-sandbox','--enable-webgl','--ignore-gpu-blocklist']});
  page=await browser.newPage({viewport:{width:640,height:480},deviceScaleFactor:1});
  page.on('pageerror',error=>report.pageErrors.push(String(error)));page.on('console',msg=>{if(msg.type()==='error')(expectingShaderFailure&&msg.text().includes('unavailable_engineering_test_symbol')?report.expectedShaderFailureLogs:report.consoleErrors).push(msg.text());});
  await page.goto('http://127.0.0.1:5298/tools/fixtures/engineering-components-gpu.html');
  await page.waitForFunction(()=>window.engineeringFixture,{timeout:60000});
  report.gpu=await page.evaluate(()=>window.engineeringFixture.gpu());
  if(process.env.ENGINEERING_REQUIRE_HARDWARE==='1')assert.doesNotMatch(report.gpu.renderer,/swiftshader|llvmpipe|software/i);
  async function check(name,fn){console.log('RUN',name);const item={name};report.checks.push(item);try{item.evidence=await fn();item.passed=true;console.log('PASS',name);}catch(error){item.passed=false;item.error=String(error);throw error;}}
  const state=(v,o,e=true)=>page.evaluate(([v,o,e])=>window.engineeringFixture.state(v,o,e),[v,o,e]);
  const orange=p=>p[0]>200&&p[1]>70&&p[1]<170&&p[2]<40;
  let baseline;
  await check('visible front retains original self-depth when independent occlusion is off',async()=>{
    baseline=await state(true,false,false);assert.equal(baseline.pick,'front');assert.ok(baseline.center[0]>180&&baseline.center[1]<50);return baseline;});
  await check('all four visibility / independent-depth combinations',async()=>{
    const rows=[];report.truthTable=rows;for(const [v,o]of [[true,true],[true,false],[false,true],[false,false]]){
      const r=await state(v,o);rows.push({visible:v,occlusion:o,...r});assert.equal(r.stats.error,undefined);assert.deepEqual(r.errors,[]);
      assert.equal(r.pick,v?'front':'rear');assert.equal(orange(r.independentCenter),!o);
      assert.equal(orange(r.center),!o);assert.equal(r.depth<1,o);assert.ok(orange(r.independentEdge));
      if(v&&o)assert.ok(r.center[0]>180&&r.center[1]<50);if(!v&&o)assert.ok(r.center[1]>180&&r.center[0]<50);
      if(v)assert.ok(Math.hypot(...r.position.map((p,i)=>p-baseline.position[i]))<1e-5,'Independent depth must not change pickPosition');
    }return rows;});
  await check('detection plane in front/behind obeys real independent depth',async()=>{
    await state(false,true);const ahead=await page.evaluate(()=>window.engineeringFixture.planeHeight(15));assert.ok(orange(ahead.independentCenter));
    const behind=await page.evaluate(()=>window.engineeringFixture.planeHeight(5));assert.ok(!orange(behind.independentCenter));return {ahead,behind};});
  await check('node selection highlights only the selected front component',async()=>{
    await state(true,true,false);const selected=await page.evaluate(()=>window.engineeringFixture.selection('front'));
    assert.ok(selected.center[1]>baseline.center[1]+50&&selected.center[2]>baseline.center[2]+50);assert.ok(selected.edge[1]>180&&selected.edge[0]<50);
    const restored=await page.evaluate(()=>window.engineeringFixture.selection());assert.deepEqual(restored.center,baseline.center);return {selected,restored};});
  await check('nested scene-effect suspension preserves latest desired state',async()=>{await state(false,true);const result=await page.evaluate(()=>window.engineeringFixture.suspend());assert.deepEqual(result.suspended.shows,[true,true]);assert.deepEqual(result.stillSuspended.shows,[true,true]);assert.deepEqual(result.resumed.shows,[false,true]);assert.ok(result.resumed.depth<1);return result;});
  await check('command collection is independent of primitive order',async()=>{const before=await state(false,true);const after=await page.evaluate(()=>window.engineeringFixture.reverseOrder());assert.deepEqual(after.independentCenter,before.independentCenter);assert.equal(after.depth,before.depth);return after;});
  await check('native-resolution buffer resizes without stale data',async()=>{await page.setViewportSize({width:800,height:600});const result=await page.evaluate(()=>window.engineeringFixture.resize());assert.equal(result.stats.width,800);assert.equal(result.stats.height,600);assert.ok(result.depth<1);return result;});
  await check('native clipping is respected in both scene and independent depth, then restored',async()=>{
    await state(true,true);const clipped=await page.evaluate(()=>window.engineeringFixture.clipping(true));assert.equal(clipped.pick,undefined);assert.equal(clipped.depth,1);assert.ok(orange(clipped.independentCenter));assert.equal(clipped.stats.error,undefined);
    const restored=await page.evaluate(()=>window.engineeringFixture.clipping(false));assert.equal(restored.pick,'front');assert.ok(restored.depth<1);assert.equal(restored.stats.error,undefined);return {clipped,restored};});
  await check('map presentation opacity does not suppress independent physical depth',async()=>{
    const transparent=await page.evaluate(()=>window.engineeringFixture.opacity(0));assert.equal(transparent.pick,undefined);assert.ok(transparent.depth<1);assert.ok(!orange(transparent.independentCenter));
    const restored=await page.evaluate(()=>window.engineeringFixture.opacity(1));assert.equal(restored.pick,'front');assert.deepEqual(restored.errors,[]);return {transparent,restored};});
  await check('static depth reuse invalidates on camera, projection, matrix, scale and custom shaders',async()=>{
    await state(false,true);const changes=[];
    for(const kind of ['unchanged','camera','frustum','matrix','matrix-restore','scale','scale-restore','shader','shader-restore']){
      const change=await page.evaluate(kind=>window.engineeringFixture.cacheChange(kind),kind);changes.push({kind,...change});assert.deepEqual(change.result.errors,[]);assert.equal(change.result.stats.error,undefined);
      if(kind==='unchanged')assert.ok(change.history.every(row=>row.depthReused));else assert.equal(change.history[0].depthReused,false,kind+' must redraw the changed frame');
      if(kind==='shader')assert.ok(change.history.every(row=>!row.depthReused));else assert.ok(change.history.at(-1).depthReused,kind+' must settle to validated static reuse');
      if(['matrix','shader'].includes(kind))assert.equal(change.result.depth,1);else assert.ok(change.result.depth<1);
      assert.equal(orange(change.result.independentCenter),['matrix','scale','shader'].includes(kind));
    }return changes;
  });
  await check('real WebGL shader failure can be disabled, corrected and manually retried',async()=>{
    expectingShaderFailure=true;let value;
    try{value=await page.evaluate(()=>window.engineeringFixture.failureRetry());}finally{expectingShaderFailure=false;}
    assert.match(value.failed.error,/compile|shader/i);assert.equal(value.disabled.error,value.failed.error);
    assert.equal(value.failedFrame.independentCenter[3],0);assert.equal(value.failedFrame.depth,1);
    assert.ok(value.failedFrame.center[1]>180&&value.failedFrame.center[0]<50,'Native rear surface must remain rendered during the failed independent pass');
    assert.equal(value.beforeFirstRetryFrame.error,undefined);assert.equal(value.recovered.stats.error,undefined);
    assert.ok(value.recovered.depth<1);assert.ok(!orange(value.recovered.independentCenter));assert.deepEqual(value.recovered.errors,[]);
    assert.ok(report.expectedShaderFailureLogs.some(log=>log.includes('ENGINEERING_INTENTIONAL_SHADER_FAILURE')));return value;
  });
  await page.screenshot({path:join(output,'hidden-component-independent-occlusion.png')});
  await check('dispose restores original node visibility without render errors',async()=>{const result=await page.evaluate(()=>window.engineeringFixture.dispose());assert.deepEqual(result.shows,[true,true]);assert.deepEqual(result.errors,[]);return result;});
  if(!realAssets.size)report.realModels={status:'not-run',reason:'ENGINEERING_REAL_ASSETS was not supplied; no real model acceptance is claimed.'};
  for(const [unit,asset]of realAssets){await check(`${unit} real GLB node picking, four states and all-component independent depth`,async()=>{
    await page.goto(`http://127.0.0.1:5298/tools/fixtures/engineering-components-real.html?unit=${unit}`);
    await page.waitForFunction(()=>window.engineeringRealFixture,{timeout:60000});
    const rows=[];report[unit]=rows;
    for(const [visible,occlusion]of [[true,true],[true,false],[false,true],[false,false]]){
      const value=await page.evaluate(([v,o])=>window.engineeringRealFixture.state(v,o),[visible,occlusion]);rows.push({visible,occlusion,...value});
      assert.equal(value.sourceHash,asset.hash);assert.equal(value.count,unit==='A001'?6:unit==='TN021'?199:25327);assert.deepEqual(value.errors,[]);assert.equal(value.stats.error,undefined);
      assert.equal(value.pick,visible?value.chosen:undefined);assert.equal(orange(value.independent),!occlusion);assert.equal(value.depth<1,occlusion);
      assert.deepEqual(value.modelMatrix,value.modelMatrixBefore);
    }
    const all=await page.evaluate(()=>window.engineeringRealFixture.all(true));assert.ok(all.stats.candidates>=all.physicalCount);assert.ok(all.stats.commands>0);assert.ok(all.depth<1);
    const none=await page.evaluate(()=>window.engineeringRealFixture.all(false));assert.equal(none.stats.commands,0);assert.equal(none.depth,1);assert.ok(orange(none.independent));
    let fullLine;
    if(unit==='FULL'){
      const remote=[];for(const id of ['A030_cap_01','TN021_tunnel_roof_01','A001_cap_01']){const sample=await page.evaluate(id=>window.engineeringRealFixture.focus(id),id);assert.equal(sample.pick,id);assert.ok(sample.depth<1);const depthAll=await page.evaluate(()=>window.engineeringRealFixture.all(true));assert.ok(depthAll.stats.culled>0);assert.ok(depthAll.stats.commands>0);remote.push({sample,depthAll});}
      const visible=await page.evaluate(()=>window.engineeringRealFixture.wholeLine(true,true));assert.equal(visible.physicalCount,25258);assert.ok(visible.stats.commands>=25258);assert.equal(visible.stats.error,undefined);
      const hidden=await page.evaluate(()=>window.engineeringRealFixture.wholeLine(false,true));assert.ok(hidden.stats.commands>=25258);assert.equal(hidden.stats.error,undefined);
      const disabled=await page.evaluate(()=>window.engineeringRealFixture.wholeLine(false,false));assert.equal(disabled.stats.commands,0);assert.equal(disabled.stats.error,undefined);
      fullLine={remote,visible,hidden,disabled};report.fullLine=fullLine;
      await page.evaluate(()=>window.engineeringRealFixture.focus('A001_cap_01'));
    }
    await page.evaluate(()=>window.engineeringRealFixture.selection());await page.screenshot({path:join(output,`${unit}-node-selection.png`)});
    if(unit==='FULL'){
      report.performanceComparison=await page.evaluate(()=>window.engineeringRealFixture.performanceComparison());
      assert.deepEqual(report.performanceComparison.errors,[]);assert.ok(report.performanceComparison.restored);
      assert.deepEqual(report.performanceComparison.modelMatrix,report.performanceComparison.modelMatrixBefore);
      for(const run of report.performanceComparison.runs.filter(run=>run.mode==='enabled')){assert.ok(run.stats.depthReused);assert.equal(run.stats.depthDraws,0);assert.ok(run.stats.commands>=25258);}
    }
    const disposed=await page.evaluate(()=>window.engineeringRealFixture.dispose());assert.ok(disposed.restored);assert.deepEqual(disposed.errors,[]);
    const hashAfter=createHash('sha256').update(await readFile(asset.path)).digest('hex');assert.equal(hashAfter,asset.hash);
    return {rows,all,none,fullLine,disposed,hashBefore:asset.hash,hashAfter};
  });}
  assert.equal(createHash('sha256').update(source).digest('hex'),sourceHash);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);report.passed=true;
}catch(error){report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close();}
