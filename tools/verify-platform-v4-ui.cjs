const {chromium}=require('C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('fs'),path=require('path');
// Isolated DOM regression only: no Viewer, project-library writes or production business objects.
// Actual G01–G12 model acceptance is performed separately against the project workspace.
(async()=>{
 const out=path.resolve('output/platform-v4-ui');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-gpu']});
 const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/__library/**',route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort());await page.route('**/__safety/**',route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort());
 const base=process.env.VISUAL_URL||'http://127.0.0.1:5197';
 await page.addInitScript(()=>localStorage.setItem('cesium-safety-display-preferences-v3',JSON.stringify({mode:'inspection',reduced:true,largeText:false})));
 await page.goto(base+'/tools/fixtures/platform-v4-ui.html');await page.waitForFunction(()=>!!window.uiTest);await page.waitForTimeout(150);
 const assert=(condition,name)=>{checks.push({name,pass:!!condition});if(!condition)throw Error(name)};
 assert(await page.evaluate(()=>uiTest.store.state.mode==='presentation'),'legacy reality preference cannot override formal overview');
 assert(await page.evaluate(()=>uiTest.store.state.reducedMotion===true),'retains only reduced animation and text preferences');
 assert(await page.locator('.v3-empty-callout').count()===0,'no large empty-project card masks the central model');
 await page.evaluate(()=>uiTest.dashboard.setPresentationStatus({ok:true,mode:'showcase'}));
 await page.locator('.v3-toolbar [data-action="mode"][data-mode="inspection"]').click();
 assert(await page.locator('.v3-toolbar [data-mode="presentation"]').getAttribute('aria-pressed')==='true','requested mode does not prematurely claim runtime success');
 await page.evaluate(()=>uiTest.dashboard.setPresentationStatus({ok:false,mode:'reality',message:'展示暂不可用，可继续查看实景'}));
 await page.locator('.v3-toolbar [data-action="mode"][data-mode="presentation"]').click();
 assert(await page.locator('.v3-toolbar [data-mode="inspection"]').getAttribute('aria-pressed')==='true','failed showcase retains actual reality selection');
 assert(await page.locator('[data-ref="presentationStatus"]').isVisible(),'runtime failure has a short visible recovery status');
 assert(await page.evaluate(()=>!uiTest.events.some(e=>e[0]==='home'||e[0]==='select')),'theme buttons never navigate or home the camera');
 await page.locator('.v3-toolbar [data-action="home"]').click();
 assert(await page.evaluate(()=>uiTest.events.filter(e=>e[0]==='home').length===1&&uiTest.store.state.mode==='presentation'&&uiTest.store.state.selectedId==='project'),'home uses one explicit dedicated callback and resets showcase');
 await page.locator('[data-action="settings"]').click();
 await page.locator('[data-action="preference-motion"]').check();
 const pausedBefore=await page.evaluate(()=>uiTest.store.state.animationPaused);
 await page.locator('[data-action="popover-close"]').last().click();
 await page.locator('[data-action="motion-toggle"]').click();
 assert(await page.evaluate(before=>uiTest.store.state.reducedMotion===true&&uiTest.store.state.animationPaused!==before,pausedBefore),'pause/resume cannot bypass reduced-motion preference');
 assert(await page.evaluate(()=>uiTest.events.filter(e=>e[0]==='home').length===1),'closing display settings does not call home');
 for(const viewport of [{width:1920,height:1080},{width:2048,height:1017},{width:1366,height:768}]){await page.setViewportSize(viewport);await page.waitForTimeout(60);await page.screenshot({path:path.join(out,`overview-${viewport.width}.png`)});assert(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),`no horizontal overflow ${viewport.width}`);if(viewport.width===1366){await page.locator('[data-action="sidebar-toggle"][data-side="left"]').click();await page.screenshot({path:path.join(out,'overview-1366-left.png')});assert(await page.locator('.v3-left').isVisible(),'collapsed panel can open');}}
 await page.setViewportSize({width:1920,height:1080});
 await page.locator('[data-action="tab"][data-tab="events"]').first().click();await page.locator('[data-action="alert"]').filter({visible:true}).first().click();await page.locator('[data-action="handle-start"]').click();await page.locator('[data-action="handle-text"]').fill('隔离验收：说明应在失败后保留');await page.locator('[data-action="handle-save"]').click();await page.waitForFunction(()=>document.querySelector('[data-ref="handleStatus"]').textContent.includes('保存失败'));assert(await page.locator('[data-action="handle-text"]').inputValue()==='隔离验收：说明应在失败后保留','failed-save draft preserved');await page.screenshot({path:path.join(out,'event-save-failure.png')});
 await page.evaluate(()=>window.uiTest.setRejectSave(false));await page.locator('[data-action="handle-save"]').click();await page.waitForFunction(()=>window.uiTest.store.dataset.alerts[0].status==='closed');assert(await page.locator('[data-action="handle-text"]').inputValue()==='','confirmed save clears draft');
 await page.evaluate(()=>window.uiTest.dashboard.setEventError('expected'));assert((await page.locator('[data-ref="alerts"]').innerText()).includes('事件记录暂未载入'),'event-load failure distinct from empty');await page.evaluate(()=>window.uiTest.dashboard.setEventError());
 await page.locator('[data-action="tab"][data-tab="components"]').click();await page.locator('[data-action="pier"]').click();for(const kind of ['cap','column','footing','pile']){await page.locator(`[data-action="component"][data-component="${kind}"]`).click();assert((await page.locator('[data-ref="detail"]').innerText()).includes('尚未绑定 BIM'),'unbound category accessible '+kind)}
 await page.screenshot({path:path.join(out,'component.png')});await page.locator('[data-action="media"]').filter({visible:true}).first().click();assert(await page.locator('.safety-drawing-viewer').isVisible(),'real image dialog opens');await page.locator('[data-drawing="zoom-in"]').click();await page.screenshot({path:path.join(out,'drawing.png')});await page.locator('[data-drawing="close"]').click();assert(await page.evaluate(()=>window.uiTest.store.state.selectedId==='pile'),'drawing close preserves selection');
 await page.locator('[data-action="layers"]').click();await page.locator('[data-action="spatial-layer"][data-layer="riskPoints"]').uncheck();assert(await page.evaluate(()=>window.uiTest.events.some(e=>e[0]==='spatial'&&e[1].riskPoints===false)),'spatial layer callback');await page.locator('[data-action="popover-close"]').last().click();
 await page.evaluate(()=>window.uiTest.setAllowNav(false));await page.locator('[data-action="tab"][data-tab="overview"]').first().click();assert(await page.evaluate(()=>window.uiTest.dashboard.debugStats().page==='components'),'dirty navigation veto respected');await page.evaluate(()=>window.uiTest.setAllowNav(true));
 await page.locator('[data-action="tab"][data-tab="inspection"]').first().click();await page.screenshot({path:path.join(out,'inspection.png')});assert(await page.locator('[data-action="time"]').count()===1,'one shared timeline');
 await page.evaluate(()=>{const u=window.uiTest;u.dashboard.setMediaSources([{id:'clock-source',name:'隔离视频源',url:'/not-loaded-test.mp4',kind:'video',provenance:'real',relation:'project',note:'isolated',mode:'replay'}]);u.dashboard.setMediaState({selectedId:'clock-source',mode:'replay',canPlay:true,updatedAt:Date.now()});window.retainedSource=document.querySelector('[data-ref="mediaSources"] button');window.retainedVideoHost=u.dashboard.videoHost;for(let i=0;i<25;i++)u.dashboard.setMediaState({selectedId:'clock-source',mode:'replay',canPlay:true,updatedAt:Date.now()+i*100});});
 assert(await page.evaluate(()=>window.retainedSource.isConnected&&window.retainedSource===document.querySelector('[data-ref="mediaSources"] button')),'video ticks preserve source-list DOM');
 assert(await page.evaluate(()=>window.retainedVideoHost===window.uiTest.dashboard.videoHost),'stable videoHost');
 await page.evaluate(()=>{for(let i=0;i<5;i++){window.uiTest.dashboard.setVisible(false);window.uiTest.dashboard.setVisible(true)}});
 assert(await page.evaluate(()=>window.uiTest.dashboard.debugStats().chartCount===2&&document.querySelectorAll('[data-ref="trend"] canvas').length===1),'reopening retains exactly two charts');
 assert(errors.length===0,'no uncaught UI errors');
 fs.writeFileSync(path.join(out,'dom-report.json'),JSON.stringify({scope:'isolated UI, no 3D model claims',checks,errors,base},null,2));await browser.close();console.log(JSON.stringify({checks:checks.length,pass:true,out}));
})().catch(e=>{console.error(e);process.exit(1)});
