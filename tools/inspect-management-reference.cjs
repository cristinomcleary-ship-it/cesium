// Reference-only interaction; never imports its fixture or demonstration data into the project.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs/promises'),path=require('node:path');
const out=path.resolve('output/platform-management/reference'),report={classification:'design-reference-only-synthetic-fixture',modules:[],videos:[],errors:[]};
(async()=>{await fs.mkdir(out,{recursive:true});const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try {const page=await browser.newPage({viewport:{width:1920,height:1080}});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/prototype/index.html');await page.locator('[data-module="overview"]').first().waitFor();
 for(const m of ['overview','plan','field','inspection','resources','documents']){await page.locator(`[data-module="${m}"]`).first().click();await page.waitForTimeout(160);report.modules.push({id:m,title:await page.locator('#workspace').innerText()});}
 await page.locator('[data-module="overview"]').first().click();await page.screenshot({path:path.join(out,'management-reference-opened.png')});
 await page.locator('[data-view="scene"]').first().click();await page.waitForTimeout(4000);report.referenceCanvas=await page.locator('#cesium-container canvas').count();await page.screenshot({path:path.join(out,'scene-reference-opened.png')});
 for(const [file,positions] of [['motion/platform-tour.mp4',[5,28.43,47,64]],['prototype/assets/patrol-demo.mp4',[0,9,16]]]){
  await page.goto('http://127.0.0.1:8765/'+file);await page.locator('video').waitFor();await page.locator('video').evaluate(async v=>{v.muted=true;await v.play()});await page.waitForTimeout(800);
  const video={file,metadata:await page.locator('video').evaluate(v=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight})),positions:[]};
  for(const t of positions){await page.locator('video').evaluate((v,t)=>{v.pause();v.currentTime=t},t);await page.waitForTimeout(300);video.positions.push(await page.locator('video').evaluate(v=>({time:v.currentTime,error:v.error?.message})));if(file.startsWith('motion'))await page.screenshot({path:path.join(out,`tour-${t}.png`)});}
  report.videos.push(video);
 }
 report.result=report.errors.length?'failed':'passed';
 }catch(e){report.result='failed';report.failure=String(e.stack||e);process.exitCode=1;}finally{await browser.close();await fs.writeFile(path.join(out,'interaction-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,modules:report.modules.map(m=>m.id),videos:report.videos,errors:report.errors,failure:report.failure},null,2));}})();
