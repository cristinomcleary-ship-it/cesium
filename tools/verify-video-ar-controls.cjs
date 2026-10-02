// Isolated actual-DOM regression for the paired video/scene control-point editor.
// Real roof picking is checked separately from deterministic injected UI matches.
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const runRoot = path.join(root, "tmp", "video-ar-controls-" + Date.now());
const port = 5190, base = "http://127.0.0.1:" + port;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
const pendingRequests = new Set();
let server, browser, page, log = "";
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#152330;color:#ecf5fb;font:14px sans-serif}#host{position:absolute;left:0;top:0;width:470px;padding:10px;box-sizing:border-box;z-index:2}#map{position:absolute;left:490px;right:0;top:0;bottom:0}button{font:inherit}
</style></head><body><div id="host"></div><div id="map"></div><script type="module">
import * as C from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {VideoArControlPointPicker} from "/src/videoArControlPointPicker.ts";
const viewer=new C.Viewer("map",{baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,selectionIndicator:false,infoBox:false});
viewer.scene.globe.baseColor=C.Color.fromCssColorString("#293e47");viewer.scene.globe.depthTestAgainstTerrain=true;
const origin=C.Cartesian3.fromDegrees(116,40,100), localToWorld=C.Transforms.eastNorthUpToFixedFrame(origin), worldToLocal=C.Matrix4.inverseTransformation(localToWorld,new C.Matrix4());
const world=p=>C.Matrix4.multiplyByPoint(localToWorld,new C.Cartesian3(p.x,p.y,p.z),new C.Cartesian3());
const coordinates=new Float32Array([-40,5,-90,40,5,-90,40,85,-90,-40,85,-90,-40,5,-80,40,5,-80,40,85,-80,-40,85,-80]);
const indices=new Uint16Array([4,5,6,4,6,7,0,2,1,0,3,2,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]);
const bytes=new Uint8Array(coordinates.byteLength+indices.byteLength);bytes.set(new Uint8Array(coordinates.buffer));bytes.set(new Uint8Array(indices.buffer),coordinates.byteLength);
let binary="";for(const b of bytes)binary+=String.fromCharCode(b);
const gltf={asset:{version:"2.0"},extensionsUsed:["KHR_materials_unlit"],buffers:[{uri:"data:application/octet-stream;base64,"+btoa(binary),byteLength:bytes.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:coordinates.byteLength,target:34962},{buffer:0,byteOffset:coordinates.byteLength,byteLength:indices.byteLength,target:34963}],accessors:[{bufferView:0,componentType:5126,count:8,type:"VEC3",min:[-40,5,-90],max:[40,85,-80]},{bufferView:1,componentType:5123,count:indices.length,type:"SCALAR"}],materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.85,.45,.15,1]},extensions:{KHR_materials_unlit:{}}}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0};
const model=await C.Model.fromGltfAsync({url:URL.createObjectURL(new Blob([JSON.stringify(gltf)],{type:"model/gltf+json"})),modelMatrix:localToWorld,upAxis:C.Axis.Z,forwardAxis:C.Axis.X});
viewer.scene.primitives.add(model);viewer.camera.lookAt(world({x:0,y:45,z:-80}),new C.HeadingPitchRange(0,-Math.PI/2,160));viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
const image=document.createElement("canvas");image.width=640;image.height=360;const ctx=image.getContext("2d");ctx.fillStyle="#dde4e8";ctx.fillRect(0,0,640,360);for(let x=0;x<640;x+=40){ctx.strokeStyle="#bccbd1";ctx.strokeRect(x,0,40,360);}for(let y=0;y<360;y+=40)ctx.strokeRect(0,y,640,40);
const frame={image,width:640,height:360,origin,attitude:{yaw:13,pitch:-58,roll:1},intrinsics:{width:640,height:360,fx:500,fy:500,cx:320,cy:180},frameTime:1.5,sourceKey:"source-a"};
const state={frame,starts:0,ends:0,applied:[],records:[],recordMode:"normal",recordRelease:null,hidden:false,realPick:null,fallbackCalls:0,inject:null,depthFail:false};
const editor=new VideoArControlPointPicker(viewer,document.querySelector("#host"),{getFrame:()=>frame,onStart:()=>{state.starts++;state.hidden=true;},onEnd:()=>{state.ends++;state.hidden=false;},onApply:r=>state.applied.push(r),onRecord:async r=>{state.records.push(r);if(state.recordMode==="fail")throw Error("simulated disk failure");if(state.recordMode==="pending")await new Promise(resolve=>state.recordRelease=resolve);}});
const nativePick=viewer.scene.pick.bind(viewer.scene),nativePosition=viewer.scene.pickPosition.bind(viewer.scene),nativeGlobe=viewer.scene.globe.pick.bind(viewer.scene.globe);
state.enableInjected=()=>{viewer.scene.pick=()=>({primitive:model});viewer.scene.pickPosition=()=>state.depthFail?undefined:world(state.inject);viewer.scene.globe.pick=(...args)=>{if(/pickScene|videoArControlPointPicker/.test(new Error().stack||""))state.fallbackCalls++;return nativeGlobe(...args);};};
state.restoreNative=()=>{viewer.scene.pick=nativePick;viewer.scene.pickPosition=nativePosition;viewer.scene.globe.pick=nativeGlobe;};
state.aimRoof=()=>{viewer.camera.lookAt(model.boundingSphere.center,new C.HeadingPitchRange(0,-Math.PI/2,160));viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);}; state.readRealPick=()=>{const p=new C.Cartesian2(viewer.scene.canvas.clientWidth/2,viewer.scene.canvas.clientHeight/2);const picked=nativePick(p),position=nativePosition(p);state.realPick={hasModel:picked?.primitive===model,pickedKind:picked?.primitive?.constructor?.name,ready:model.ready,local:position?C.Matrix4.multiplyByPoint(worldToLocal,position,new C.Cartesian3()):null};return state.realPick;};
const yaw=10*Math.PI/180,pitch=-60*Math.PI/180,f=[Math.sin(yaw)*Math.cos(pitch),Math.cos(yaw)*Math.cos(pitch),Math.sin(pitch)],r=[Math.cos(yaw),-Math.sin(yaw),0],d=[Math.sin(yaw)*Math.sin(pitch),Math.cos(yaw)*Math.sin(pitch),-Math.cos(pitch)];
state.controls=[[-20,25],[0,25],[20,25],[-20,65],[0,65],[20,65]].map(([x,y])=>{const p={x,y,z:-80},delta=[x-6,y+4,-83],dot=a=>a.reduce((s,v,i)=>s+v*delta[i],0);return{world:p,pixelX:320+500*dot(r)/dot(f),pixelY:180+500*dot(d)/dot(f)};});
for(const p of state.controls){ctx.fillStyle="#153143";ctx.beginPath();ctx.arc(p.pixelX,p.pixelY,5,0,Math.PI*2);ctx.fill();}
window.fixture={state,editor,viewer,model};window.ready=true;
</script></body></html>`;
async function begin(){await fs.mkdir(runRoot,{recursive:true});await fs.writeFile(path.join(runRoot,"fixture.html"),fixture);server=spawn(process.execPath,[path.join(root,"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd:root,env:{...process.env,CESIUM_DATA_DIR:path.join(runRoot,"project-data")},windowsHide:true,stdio:["ignore","pipe","pipe"]});server.stdout.on("data",x=>log+=x);server.stderr.on("data",x=>log+=x);for(let i=0;i<100;i++){try{if((await fetch(base+"/__library/records")).ok)return;}catch{}await sleep(100);}throw Error("Server startup failed:"+log);}
async function clickVideo(pixelX=320,pixelY=180){const b=await page.locator(".vacp-image-scroll canvas").boundingBox();await page.mouse.click(b.x+pixelX/640*b.width,b.y+pixelY/360*b.height);}
async function clickMap(){const b=await page.locator("#map canvas").first().boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await sleep(80);}
async function start(){await page.locator('[data-action="start"]').click();await page.waitForFunction(()=>!document.querySelector(".vacp-body").hidden);}
(async()=>{try{
 await begin();
 const executable=process.env.BROWSER_EXECUTABLE||["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
 browser=await chromium.launch({headless:true,executablePath:executable,args:["--disable-gpu-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
 page=await browser.newPage({viewport:{width:1400,height:950}});page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>pendingRequests.add(r.url()));page.on("requestfinished",r=>pendingRequests.delete(r.url()));page.on("requestfailed",r=>pendingRequests.delete(r.url()));
 await page.goto(base+"/tmp/"+path.basename(runRoot)+"/fixture.html",{waitUntil:"domcontentloaded",timeout:90000});await page.waitForFunction(()=>window.ready,{},{timeout:30000});await page.waitForFunction(()=>fixture.model.ready);await page.evaluate(()=>fixture.state.aimRoof());await sleep(1200);
 await start();assert.equal(await page.evaluate(()=>fixture.state.hidden),true);await clickVideo();await clickMap();
 const real=await page.evaluate(()=>fixture.state.readRealPick());assert.ok(real.hasModel,"Real Cesium pick must hit the synthetic model: "+JSON.stringify(real));assert.ok(Math.abs(real.local.z+80)<.5,"Real roof depth must be near roof height: "+JSON.stringify(real));
 assert.match(await page.locator('[data-role="count"]').textContent(),/1/);checks.push("Actual Cesium model roof pickPosition matched a real rendered roof; no injected pick in this check");
 await page.locator('[data-action="undo"]').click();assert.match(await page.locator('[data-role="count"]').textContent(),/0/);await page.locator('[data-action="cancel"]').click();
 assert.equal(await page.locator(".vacp-body").isVisible(),false);assert.equal(await page.evaluate(()=>fixture.state.hidden),false);checks.push("Real DOM start/image/map/undo/cancel restores visibility and hides snapshot");
 await page.evaluate(()=>fixture.state.enableInjected());await start();const controls=await page.evaluate(()=>fixture.state.controls);
 for(const point of controls){await clickVideo(point.pixelX,point.pixelY);await page.evaluate(p=>fixture.state.inject=p,point.world);await clickMap();}
 assert.match(await page.locator('[data-role="count"]').textContent(),/6/);await page.screenshot({path:path.join(runRoot,"paired-controls.png"),fullPage:true});await page.locator('[data-action="solve"]').click();await page.waitForFunction(()=>fixture.state.applied.length===1);
 const solved=await page.evaluate(()=>fixture.state.applied[0]);assert.ok(solved.rmsePx<1,"UI click mapping must retain subpixel fit: "+solved.rmsePx);assert.ok(Math.abs(solved.positionDeltaENU.x-6)<1);assert.ok(Math.abs(solved.positionDeltaENU.y+4)<1);assert.ok(Math.abs(solved.positionDeltaENU.z-3)<1);assert.equal(solved.points.length,6);checks.push("Injected deterministic roof coordinates + actual DOM clicks recover synthetic GPS/height/attitude bias from six image matches");
 await start();await clickVideo();await page.evaluate(()=>fixture.state.depthFail=true);const before=await page.evaluate(()=>fixture.state.fallbackCalls);await clickMap();assert.match(await page.locator(".vacp-status").textContent(),/深度/);assert.equal(await page.evaluate(()=>fixture.state.fallbackCalls),before);assert.match(await page.locator('[data-role="count"]').textContent(),/0/);await page.locator('[data-action="cancel"]').click();await page.evaluate(()=>fixture.state.depthFail=false);checks.push("Injected model depth failure cannot fall back to ground");
 await start();await page.evaluate(()=>fixture.state.frame.sourceKey="source-b");await clickVideo();assert.equal(await page.locator(".vacp-body").isVisible(),false);assert.match(await page.locator(".vacp-status").textContent(),/已改变/);checks.push("Source switch with unchanged PTS cancels frozen pairing");
 await start();await page.evaluate(()=>fixture.state.frame.frameTime+=.1);await clickVideo();assert.equal(await page.locator(".vacp-body").isVisible(),false);checks.push("PTS change rejects stale frozen frame");
 // Holdout points are measurable without being used as optimization constraints.
 await start();
 for(const point of controls.slice(0,3)){await clickVideo(point.pixelX,point.pixelY);await page.evaluate(p=>fixture.state.inject=p,point.world);await clickMap();}
 await page.locator('[data-role="point-role"]').selectOption("check");
 await clickVideo(controls[0].pixelX+20,controls[0].pixelY);await page.evaluate(p=>fixture.state.inject=p,controls[0].world);await clickMap();
 assert.equal(await page.locator('[data-action="solve"]').isDisabled(),true,"3 fit + 1 check cannot satisfy minimum fit count");
 await page.locator('[data-role="point-role"]').selectOption("fit");
 for(const point of controls.slice(3)){await clickVideo(point.pixelX,point.pixelY);await page.evaluate(p=>fixture.state.inject=p,point.world);await clickMap();}
 const applyCount=await page.evaluate(()=>fixture.state.applied.length);
 await page.locator('[data-action="record"]').click();await page.waitForFunction(()=>fixture.state.records.at(-1)?.status==="recorded-not-solved");
 assert.equal(await page.evaluate(()=>fixture.state.applied.length),applyCount);assert.equal(await page.evaluate(()=>fixture.editor.getLastSession().points.length),7);
 await page.locator('[data-action="solve"]').click();await page.waitForFunction(n=>fixture.state.applied.length===n+1,applyCount);
 const heldOut=await page.evaluate(()=>fixture.state.applied.at(-1).session);
 assert.ok(heldOut.summary.after.fit.rmsePx<1);assert.ok(heldOut.summary.after.check.rmsePx>18);assert.equal(heldOut.summary.after.fit.count,6);assert.equal(heldOut.summary.after.check.count,1);
 assert.equal(await page.locator('[data-action="export-record"]').isVisible(),true);checks.push("3 fit plus 1 check cannot solve; 6 fit plus a deliberately wrong holdout keep accurate fit and report bad independent residuals; record-only does not apply");
 const fill=async()=>{for(const point of controls){await clickVideo(point.pixelX,point.pixelY);await page.evaluate(p=>fixture.state.inject=p,point.world);await clickMap();}};
 await start();await fill();await page.evaluate(()=>fixture.state.recordMode="fail");await page.locator('[data-action="solve"]').click();
 await page.waitForFunction(()=>document.querySelector('.vacp-status').textContent.includes('simulated disk failure'));
 assert.equal(await page.evaluate(()=>fixture.state.applied.length),applyCount+1);assert.equal(await page.evaluate(()=>fixture.editor.getLastSession().points.length),6);
 const downloadWait=page.waitForEvent("download");await page.locator('[data-action="export-record"]').click();const download=await downloadWait;
 await download.saveAs(path.join(runRoot,"failed-save-record.json"));const failedRecord=JSON.parse(await fs.readFile(path.join(runRoot,"failed-save-record.json"),"utf8"));assert.equal(failedRecord.points.length,6);
 await page.locator('[data-action="cancel"]').click();checks.push("Persistence rejection never applies calibration and the complete record remains downloadable");
 await page.evaluate(()=>{fixture.state.recordMode="pending";fixture.state.recordRelease=null;});await start();await fill();await page.locator('[data-action="solve"]').click();
 await page.waitForFunction(()=>typeof fixture.state.recordRelease==="function");await page.evaluate(()=>{fixture.state.frame.frameTime+=.1;fixture.state.recordRelease();});
 await page.waitForFunction(()=>document.querySelector('.vacp-body').hidden);assert.equal(await page.evaluate(()=>fixture.state.applied.length),applyCount+1);
 checks.push("Changing PTS while durable recording is pending prevents a stale calibration from applying");
 const lifecycle=await page.evaluate(()=>({starts:fixture.state.starts,ends:fixture.state.ends,hidden:fixture.state.hidden}));assert.equal(lifecycle.starts,lifecycle.ends);assert.equal(lifecycle.hidden,false);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(runRoot,"controls.png"),fullPage:true});
 const result={status:"PASS",checks,realRoofPick:real,solved,lifecycle,pageErrors:errors,runRoot};await fs.writeFile(path.join(runRoot,"result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){await fs.writeFile(path.join(runRoot,"result.json"),JSON.stringify({status:"FAIL",message:error.stack,checks,pageErrors:errors,pendingRequests:[...pendingRequests],runRoot},null,2)).catch(()=>{});if(page)await page.screenshot({path:path.join(runRoot,"failure.png"),fullPage:true}).catch(()=>{});console.error(error.stack);process.exitCode=1;}finally{await browser?.close();server?.kill();await fs.writeFile(path.join(runRoot,"server.log"),log).catch(()=>{});}})();
