// Run with PLAYWRIGHT_MODULE set to an installed Playwright package if necessary.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {existsSync}=require('node:fs'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),port=5188,base=`http://127.0.0.1:${port}`;
const out=path.join(root,'output','cad-display-regression'),errors=[],checks=[];
let server,browser,log='';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await fs.mkdir(out,{recursive:true});
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{
    cwd:root,env:{...process.env,CESIUM_DATA_DIR:path.join(root,'tmp',`cad-display-${Date.now()}`)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
  for(let i=0;i<120;i++){
    if(server.exitCode!==null)throw Error(log);
    try{if((await fetch(base+'/__library/records',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}
    if(i===119)throw Error('Vite startup timed out: '+log);await delay(250);
  }
  const executable=process.env.BROWSER_EXECUTABLE||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
  browser=await chromium.launch({executablePath:executable,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  for(const dpr of [1,2]){
    const context=await browser.newContext({viewport:{width:1000,height:760},deviceScaleFactor:dpr});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/tools/fixtures/cad-display.html');await page.waitForFunction(()=>window.cadTest,{},{timeout:90000});
    const load=async options=>{const result=await page.evaluate(o=>cadTest.load(o),options);await page.waitForFunction(()=>cadTest.ready(),{},{timeout:60000});return result;};
    const measure=async(range,mode='3d')=>{await page.evaluate(([r,m])=>cadTest.camera(r,m),[range,mode]);return page.evaluate(()=>cadTest.metrics());};
    await load({baseline:true});const before=await measure(80);await page.screenshot({path:path.join(out,`before-dpr${dpr}.png`)});
    await load({});
    for(const range of [35,80,250,800]){
      const metrics=await measure(range);checks.push({test:'zoom continuity',dpr,range,...metrics});
      assert.ok(metrics.total>=300&&metrics.coverage>=0.97,JSON.stringify(checks.at(-1)));
    }
    const after=await measure(80);checks.push({test:'coplanar comparison',dpr,before,after});
    await page.screenshot({path:path.join(out,`after-dpr${dpr}.png`)});
    const pick=await page.evaluate(()=>cadTest.pick());assert.equal(pick.id,'cad-0');assert.ok(pick.height!==null&&Math.abs(pick.height)<0.03,JSON.stringify(pick));checks.push({test:'pick ID and depth within 3 cm',dpr,...pick});
    await page.evaluate(()=>cadTest.hide(false));await page.evaluate(()=>cadTest.frames());assert.equal((await measure(80)).visible,0);
    await page.evaluate(()=>cadTest.hide(true));assert.ok((await measure(80)).coverage>=0.97);checks.push({test:'layer hide/show',dpr});
    await load({obstacle:true});const occlusion=await measure(80);assert.ok(occlusion.blocked>30&&occlusion.leaked===0&&occlusion.coverage>=0.97,JSON.stringify(occlusion));checks.push({test:'30 cm model occlusion',dpr,...occlusion});
    await page.screenshot({path:path.join(out,`occlusion-dpr${dpr}.png`)});
    await load({z:-0.264});const underground=await measure(80);assert.equal(underground.visible,0);checks.push({test:'negative CAD elevation stays underground',dpr,...underground});
    await load({});await page.evaluate(()=>cadTest.viewer.scene.logarithmicDepthBuffer=false);
    for(const mode of ['3d','2d','cv']){
      const metrics=await measure(80,mode);assert.ok(metrics.total>=300&&metrics.coverage>=0.97,JSON.stringify({mode,...metrics}));checks.push({test:'non-log depth',dpr,mode,...metrics});
    }
    await page.evaluate(()=>cadTest.camera(80,'3d'));await page.evaluate(()=>cadTest.viewer.scene.logarithmicDepthBuffer=true);
    const full=await load({full:true});assert.equal(full.features,3);assert.deepEqual(full.labels,['13-2']);assert.deepEqual(full.ids,['cad-0']);checks.push({test:'POINT hidden; circle, text, face retained',dpr,...full});
    const legacy=await page.evaluate(()=>cadTest.entityContract());assert.deepEqual(legacy,{entities:1,points:0,width:1.5});checks.push({test:'ordinary-model entity compatibility',dpr,...legacy});
    await load({mode:'terrain'});const ground=await measure(80);assert.ok(ground.coverage>=0.97,JSON.stringify(ground));checks.push({test:'native terrain draping',dpr,...ground});
    await context.close();console.log('CAD display checks passed at DPR',dpr);
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({result:'PASS',checks,pageErrors:errors},null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,artifacts:out}));
})().catch(async error=>{console.error(error);await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(error),checks,pageErrors:errors},null,2));process.exitCode=1;})
  .finally(async()=>{if(browser)await browser.close();if(server)server.kill();await fs.writeFile(path.join(out,'server.log'),log);});
