// Existing V5 route, read-only captures before integrating the management redesign.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'output/platform-management/baseline');
const report = { scope: 'Actual existing V5 baseline has four modules, not six; all business writes blocked.', screenshots: [], errors: [], startedAt: new Date().toISOString() };
async function hashes() {
  const result = {};
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir,e.name); if (e.isDirectory()) await walk(p); else if (e.isFile() && e.name.endsWith('.json')) result[path.relative(root,p)] = crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex'); } }
  await walk(path.join(root,'project-data')); return result;
}
let browser;
(async()=>{ await fs.mkdir(out,{recursive:true});
  try { report.beforeHashes=await hashes(); browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=d3d11']});
    const page=await browser.newPage({viewport:{width:1920,height:1080}}); page.on('pageerror',e=>report.errors.push(e.message));
    await page.route('**/*',r=>['GET','HEAD','OPTIONS'].includes(r.request().method())?r.continue():r.abort());
    await page.goto('http://127.0.0.1:5173/?screen=safety',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>{const w=window.__safetyWorkspace;return w?.store && w.runtimeModels().length && w.runtimeModels().every(m=>m.tileset.tilesLoaded)&&!w.options.viewer.camera._currentFlight},null,{timeout:180000});
    for(const [width,height] of [[1920,1080],[1366,768]]) { await page.setViewportSize({width,height});
      for(const tab of ['overview','inspection','events','components']) { await page.locator(`.v3-header [data-tab="${tab}"]`).click();await page.waitForTimeout(800);const file=`${tab}-${width}x${height}.png`;await page.screenshot({path:path.join(out,file)});report.screenshots.push(file); }
    }
    report.stats=await page.evaluate(()=>window.__safetyWorkspace.debugStats());report.afterHashes=await hashes();
    report.businessFilesUnchanged=JSON.stringify(report.beforeHashes)===JSON.stringify(report.afterHashes);report.result=report.errors.length===0&&report.businessFilesUnchanged?'passed':'failed';
  }catch(e){report.result='failed';report.failure=String(e.stack||e);process.exitCode=1;}
  finally{await browser?.close();report.completedAt=new Date().toISOString();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,screenshots:report.screenshots,errors:report.errors,failure:report.failure},null,2));}
})();
