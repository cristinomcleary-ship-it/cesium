const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const port = 5187;
const base = "http://127.0.0.1:" + port;
const runRoot = path.join(root, "tmp", "persistence-browser-" + Date.now());
const dataRoot = path.join(runRoot, "project-data");
let server, browser, page;
let log = "";
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  server = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root, env: { ...process.env, CESIUM_DATA_DIR: dataRoot }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", b => log += b); server.stderr.on("data", b => log += b);
  for (let i=0;i<160;i++) {
    if (server.exitCode !== null) throw new Error("Server exited: " + log);
    try { if ((await fetch(base + "/__library/records", {signal:AbortSignal.timeout(1500)})).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error("Server did not start: " + log);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once("exit", resolve));
  server.kill(); await exited; server = null;
}
async function listing() { return (await (await fetch(base + "/__library/records")).json()).records; }
async function waitRecords(n) {
  for (let i=0;i<160;i++) { if ((await listing()).length === n) return; await sleep(250); }
  throw new Error("Wrong record count: " + JSON.stringify(await listing()) + " UI:" + await page.locator("#libraryStatus").textContent() + " toast:" + await page.locator("#toast").textContent());
}
async function open(context) {
  page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", dialog => dialog.accept());
  const mapImage=await fs.readFile(path.join(runRoot,"fixture.jpg"));
  await page.route("**/__basemap/**", route => route.fulfill({status:200,contentType:"image/jpeg",body:mapImage}));
  await page.goto(base, { waitUntil:"domcontentloaded",timeout:120000 });
  await page.waitForFunction(() => document.querySelector("#libraryStatus")?.textContent?.includes("已保存到本机"), null, { timeout:120000 });
  await page.evaluate(() => {
    window.testToasts=[];
    new MutationObserver(()=>window.testToasts.push(document.querySelector("#toast").textContent)).observe(document.querySelector("#toast"),{childList:true,subtree:true});
  });
}
async function fixtureGlb() {
  const gltf=JSON.parse(await fs.readFile(path.join(root,"tools/fixtures/ar-projector/triangle.gltf"),"utf8"));
  const binary=Buffer.from(gltf.buffers[0].uri.split(",")[1],"base64");
  delete gltf.buffers[0].uri;
  let json=Buffer.from(JSON.stringify(gltf));
  json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);
  const bin=Buffer.concat([binary,Buffer.alloc((4-binary.length%4)%4)]);
  const out=Buffer.alloc(12+8+json.length+8+bin.length);
  out.writeUInt32LE(0x46546c67,0); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(json.length,12); out.writeUInt32LE(0x4e4f534a,16); json.copy(out,20);
  const p=20+json.length; out.writeUInt32LE(bin.length,p); out.writeUInt32LE(0x004e4942,p+4); bin.copy(out,p+8);
  await fs.writeFile(path.join(runRoot,"fixture.glb"),out);
}
(async () => {
  await fs.mkdir(runRoot,{recursive:true});
  await fs.cp(path.join(root,"tools/fixtures/ar-projector"),path.join(runRoot,"tiles-original"),{recursive:true});
  const cad={format:"cesium-cad-import",version:2,source:{name:"持久化验证图纸.dwg",format:"DWG",generatedAt:new Date().toISOString()},statistics:{sourceEntities:1,displayEntities:1,skippedEntities:0,unknownEntities:0,layers:["test"]},entities:[{type:"POLYLINE",sourceType:"LINE",layer:"test",vertices:[{x:0,y:0,z:3},{x:60,y:40,z:3}]}],warnings:[]};
  await fs.writeFile(path.join(runRoot,"fixture.cadimport"),JSON.stringify(cad));
  await fs.writeFile(path.join(runRoot,"fixture.geojson"),JSON.stringify({type:"FeatureCollection",features:[{type:"Feature",properties:{name:"测试点"},geometry:{type:"Point",coordinates:[120,30,5]}}]}));
  await fixtureGlb();
  await fs.copyFile(path.join(root,"node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg"),path.join(runRoot,"fixture.jpg"));
  await fs.writeFile(path.join(runRoot,"trajectory_test.json"),JSON.stringify({trajectory_points:[0,1].map(i=>({
    timestamp_ms:1790700000000+i*1000,coordinates:{longitude:120+i*0.00001,latitude:30,altitude:100},
    gimbal_attitude:{yaw:0,pitch:-90,roll:0}
  }))}));
  await start();
  const executable=process.env.BROWSER_EXECUTABLE || ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
  browser=await chromium.launch({executablePath:executable,headless:true,args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
  const context=await browser.newContext({viewport:{width:1500,height:960}});
  await open(context);
  await page.locator("#cadFile").setInputFiles(path.join(runRoot,"fixture.cadimport"));
  await page.locator("#anchorLon").fill("120"); await page.locator("#anchorLat").fill("30");
  console.log("Browser ready; testing imports");
  await page.locator("#loadCad").click(); await waitRecords(1);
  await page.waitForSelector('#layers .layer-row[data-visible="true"]');
  await page.locator('[data-tab="tiles"]').click();
  await page.locator("#ccFolderPath").fill(path.join(runRoot,"tiles-original"));
  await page.locator("#loadCcFolder").click(); await waitRecords(2);
  await page.waitForFunction(() => document.querySelectorAll("#layers .layer-row").length === 2);
  await page.locator('[data-tab="gis"]').click();
  await page.locator("#gisFile").setInputFiles(path.join(runRoot,"fixture.geojson"));
  let dropCommitResponse = true;
  await page.route("**/__library/records/*", async route => {
    if (dropCommitResponse && route.request().method() === "PUT") {
      dropCommitResponse=false;
      await route.fetch(); // persist successfully, then simulate a lost acknowledgement
      await route.abort("failed");
    } else await route.continue();
  });
  await page.locator("#loadGis").click(); await waitRecords(3);
  await page.waitForFunction(() => document.querySelector("#libraryStatus").textContent.includes("尚未保存"));
  await page.locator(".saved-library summary").click();
  await page.getByRole("button",{name:"重试保存",exact:true}).click();
  await page.waitForFunction(() => !document.querySelector("#libraryStatus").textContent.includes("尚未保存"));
  assert.equal((await listing()).length,3);
  await page.locator(".saved-library summary").click();
  await page.waitForFunction(() => document.querySelectorAll("#layers .layer-row").length === 3);
  await page.locator('[data-tab="models"]').click();
  await page.locator("#modelFile").setInputFiles(path.join(runRoot,"fixture.glb"));
  await page.locator("#modelLon").fill("120"); await page.locator("#modelLat").fill("30"); await page.locator("#modelHeight").fill("5");
  await page.locator("#loadModel").click(); await waitRecords(4);
  await page.waitForFunction(() => document.querySelectorAll("#layers .layer-row").length === 4);
  await page.locator("#basemap").selectOption("local");
  await page.locator("#localBasemapFile").setInputFiles(path.join(runRoot,"fixture.jpg"));
  await page.locator("#localWest").fill("119.99"); await page.locator("#localSouth").fill("29.99");
  await page.locator("#localEast").fill("120.01"); await page.locator("#localNorth").fill("30.01");
  await page.locator("#applyLocalBasemap").click(); await waitRecords(5);
  await page.locator('[data-tab="videoar"]').click();
  await page.locator("#videoArTrajectoryFile").setInputFiles(path.join(runRoot,"trajectory_test.json"));
  await page.locator("#videoArLoad").click(); await waitRecords(6);
  await page.waitForFunction(() => document.querySelector("#videoArStatus").textContent.includes("已保存"));
  const records=await listing(); const cadId=records.find(r=>r.kind==="CAD").id; const gisId=records.find(r=>r.kind==="GIS").id;
  await page.locator('#layers [data-id="'+cadId+'"] .visibility').click();
  for(let i=0;i<80;i++){if(!(await listing()).find(r=>r.id===cadId).visible)break;await sleep(100);}
  assert.equal((await listing()).find(r=>r.id===cadId).visible,false);
  await fs.rename(path.join(runRoot,"tiles-original"),path.join(runRoot,"tiles-moved"));
  await page.screenshot({path:path.join(runRoot,"before-restart.png")});
  console.log("Six imports saved (including imagery/replay); restarting service and browser context");
  await page.close(); await stop(); await start();
  const fresh=await browser.newContext({viewport:{width:1500,height:960}}); // no cookies/localStorage
  await open(fresh);
  assert.equal(await page.locator("#layers .layer-row").count(),4);
  assert.equal(await page.locator('#layers [data-id="'+cadId+'"]').getAttribute("data-visible"),"false");
  assert.equal(await page.locator("#savedLibrary .saved-record").count(),6);
  assert.equal(await page.locator("#basemap").inputValue(),"local");
  await page.locator('[data-tab="videoar"]').click();
  assert.notEqual(await page.locator("#videoArFrame").textContent(),"0 / 0");
  assert.equal((await listing()).length,6);
  console.log("Restart restored files, visibility, imagery and video trajectory");
  const gisFailurePattern="**/__library/files/*/source/fixture.geojson";
  await page.route(gisFailurePattern,route=>route.fulfill({status:503,body:"temporary error"}));
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(() => document.querySelector("#libraryStatus")?.textContent?.includes("已保存到本机"));
  assert.equal(await page.locator("#layers .layer-row").count(),3);
  assert.equal((await listing()).length,6);
  await page.unroute(gisFailurePattern);
  await page.locator(".saved-library summary").click();
  await page.locator('[data-saved-id="'+gisId+'"]').getByRole("button",{name:"重试",exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll("#layers .layer-row").length===4);
  await page.locator(".saved-library summary").click();
  assert.equal((await listing()).find(r=>r.kind==="3D Tiles").settings.tiles.heightOffset,0);
  assert.equal(await page.locator(".saved-record small").allTextContents().then(values=>values.some(v=>/缺少|失败|无法|尚未/.test(v))),false);
  await page.locator('#layers [data-id="'+gisId+'"] .remove').click();
  await waitRecords(5);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(() => document.querySelector("#libraryStatus")?.textContent?.includes("已保存到本机"));
  assert.equal(await page.locator("#layers .layer-row").count(),3);
  assert.equal(await page.locator('#layers [data-id="'+gisId+'"]').count(),0);
  await page.locator(".saved-library summary").click();
  await page.screenshot({path:path.join(runRoot,"restored.jpg"),quality:65});
  assert.deepEqual(errors,[]);
  await page.locator("#clearAll").click(); await waitRecords(0);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(() => document.querySelector("#libraryStatus")?.textContent?.includes("已保存到本机"));
  assert.equal(await page.locator("#layers .layer-row").count(),0);
  const report={result:"PASS",checks:["CAD/source bytes saved","local tiles copied","GIS saved","GLB saved","new browser context + full server restart restores four layers","source directory move does not break tiles","visibility restored","explicit deletion persists","clear all persists","ambiguous save acknowledgement recovers without duplicate","temporary restore failure retains record and retries","local imagery and video trajectory restore"],artifacts:runRoot,pageErrors:errors};
  await fs.writeFile(path.join(runRoot,"result.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(async error => {
  console.error(error);
  if(page) { try { await page.screenshot({path:path.join(runRoot,"failure.png")}); console.error("UI:",await page.locator("#libraryStatus").textContent(),"TOAST:",await page.locator("#toast").textContent()); }catch{} }
  if(page) console.error("TOAST HISTORY",await page.evaluate(()=>window.testToasts).catch(()=>[]));
  console.error("PAGE ERRORS",errors); process.exitCode=1;
}).finally(async () => {
  if(browser) await browser.close();
  await stop();
  await fs.writeFile(path.join(runRoot,"server.log"),log);
});
