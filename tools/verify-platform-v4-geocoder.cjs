const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs/promises'), path=require('node:path'), assert=require('node:assert/strict');
const base=process.env.VISUAL_URL||'http://127.0.0.1:5201', out=path.resolve('output/platform-v4-ui');
(async()=>{
 await fs.mkdir(out,{recursive:true});
 const source=await fs.readFile('src/main.ts','utf8'), expression=source.match(/geocoder:\s*([^\r\n]+),/)?.[1];
 assert.ok(expression,'Production geocoder option must be present');
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-gpu']});
 const page=await browser.newPage({viewport:{width:1920,height:1080}}),network=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(base).origin){network.push(route.request().url());return route.abort()}return route.continue()});
 try {
  await page.goto(base+'/tools/fixtures/platform-v4-ui.html');await page.waitForFunction(()=>!!window.uiTest);
  const services=await page.evaluate(async expression=>(await import('/tools/fixtures/platform-v4-geocoder.ts')).verifyGeocoderOption(expression),expression);
  assert.equal(services.localWarning,false);assert.deepEqual(services.localServices,[true]);assert.equal(services.configuredUsesIon,true);assert.equal(services.positiveControlWarning,true);assert.equal(services.unsupportedPlaceIsEmpty,true);
  assert.ok(Math.abs(services.coordinate.longitude-114.25)<1e-8&&Math.abs(services.coordinate.latitude-30.5)<1e-8&&Math.abs(services.coordinate.height-125)<1e-6);
  const layouts=[];
  for(const size of [{width:1920,height:1080},{width:2048,height:1017},{width:1366,height:768}]){
   await page.setViewportSize(size);await page.waitForTimeout(150);
   for(const expanded of size.width===1366?[false,true,"authoring"]:[false,"authoring"]){
    if(expanded===true)await page.locator('[data-action=sidebar-toggle][data-side=left]').click();
    if(expanded==='authoring')await page.evaluate(()=>{uiTest.dashboard.setAuthoring(true);const drawer=document.createElement('aside');drawer.className='safety-spatial-editor';drawer.id='isolated-layout-drawer';drawer.style.height='100%';drawer.textContent='隔离布局校验';document.body.append(drawer)});
    layouts.push(await page.evaluate(({size,expanded})=>{const credit=document.querySelector('.cesium-viewer-bottom');const boxes=[...credit.querySelectorAll('a,img')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});const overlaps=[];for(const target of boxes){const r=target.getBoundingClientRect();for(const panel of document.querySelectorAll('.v3-sidebar,.v3-toolbar,.v3-footer-note,.v3-workbench,.safety-spatial-editor')){const p=panel.getBoundingClientRect();if(p.width>0&&p.height>0&&r.left<p.right&&r.right>p.left&&r.top<p.bottom&&r.bottom>p.top)overlaps.push({target:target.tagName,panel:panel.className});}}return{size,expanded,visibleElements:boxes.length,overlaps,bounds:credit.getBoundingClientRect().toJSON(),creditDisplay:getComputedStyle(credit).display}}, {size,expanded}));
    await page.screenshot({path:path.join(out,`attribution-${size.width}${expanded==='authoring'?'-authoring':expanded?'-left-open':''}.png`)});
    if(expanded==='authoring')await page.evaluate(()=>{uiTest.dashboard.setAuthoring(false);document.getElementById('isolated-layout-drawer').remove()});
   }
  }
  await page.locator('.cesium-credit-expand-link').click();
  assert.equal(await page.locator('.cesium-credit-lightbox-overlay').isVisible(),true);
  assert.match(await page.locator('.cesium-credit-lightbox').innerText(),/Isolated attribution layout verification/);
  await page.locator('.cesium-credit-lightbox-close').click();
  assert.equal(await page.locator('.cesium-credit-lightbox-overlay').isVisible(),false);
  const report={attributionLinkOperable:true,scope:'Actual installed Cesium GeocoderViewModel/CartographicGeocoderService/CreditDisplay; no Viewer or project rendering',services,layouts,network,errors};
  await fs.writeFile(path.join(out,'geocoder-attribution-report.json'),JSON.stringify(report,null,2));
  assert.ok(layouts.every(layout=>layout.visibleElements>=3&&layout.overlaps.length===0),'Visible Cesium logo and attribution link must avoid task panels');assert.equal(network.length,0,'No online service contacted');assert.equal(errors.length,0);
  console.log(JSON.stringify(report,null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
