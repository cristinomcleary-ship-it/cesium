// Read-only real-data sensitivity experiment. Does not establish registration accuracy.
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const runRoot = path.join(root, "output", "video-ar-first-pass-" + Date.now());
const port = 5193, base = "http://127.0.0.1:" + port;
const modelPath = path.join(root,"project-data/records/8bc58629-cf26-45de-986e-086479db11a0/record.json");
const videoPath = path.join(root,"project-data/records/04cc67b0-4208-4fb4-9706-d064a45cefaf/record.json");
const framePath = "output/video-ar-handoff-20261002/GPT_analysis/02_images/video_frames/frame_0010.01s.jpg";
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let server, browser;
const errors = [];
const hash = b => createHash("sha256").update(b).digest("hex");
(async()=>{try {
 await fs.mkdir(runRoot,{recursive:true});
 const modelBytes = await fs.readFile(modelPath), videoBytes = await fs.readFile(videoPath);
 const model = JSON.parse(modelBytes), video = JSON.parse(videoBytes);
 const sourcePath = path.join(root,"project-data/records",video.id,"source",video.files.source.name);
 const sourceBytes = await fs.readFile(sourcePath), trajectory = JSON.parse(sourceBytes);
 const point = trajectory.trajectory_points.reduce((a,b)=>Math.abs(b.video_time_ms-10010)<Math.abs(a.video_time_ms-10010)?b:a);
 const candidateDatum = point.position.altitude-point.position.relative_altitude;
 const fileUrl = p => "/@fs/"+p.replaceAll("\\","/");
 const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#view{margin:0;width:100%;height:100%;overflow:hidden}#note{position:absolute;z-index:5;top:10px;left:10px;background:#122333dd;color:white;padding:12px;font:16px sans-serif;pointer-events:none}</style></head><body><div id="view"></div><div id="note"></div><script type="module">
 import * as C from "cesium";import "cesium/Build/Cesium/Widgets/widgets.css";
 import {VideoArModelProjector} from "/src/videoArModelProjector.ts";
 import {resolveDjiHeight} from "/src/videoArHeight.ts";
 import {cameraDirectionToEnu} from "/src/videoArCamera.ts";
 const point=${JSON.stringify(point)},record=${JSON.stringify(model)};
 const viewer=new C.Viewer("view",{animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,navigationHelpButton:false,sceneModePicker:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),contextOptions:{webgl:{preserveDrawingBuffer:true,antialias:false}}});
 viewer.scene.globe.show=false;viewer.scene.skyBox.show=false;viewer.scene.skyAtmosphere.show=false;viewer.scene.sun.show=false;viewer.scene.moon.show=false;viewer.scene.backgroundColor=C.Color.BLACK;viewer.scene.postProcessStages.fxaa.enabled=false;viewer.scene.highDynamicRange=false;
 const tiles=await C.Cesium3DTileset.fromUrl(${JSON.stringify(fileUrl(path.join(root,"project-data/records",model.id,"tiles",model.files.tiles.name)))},{maximumScreenSpaceError:1,cacheBytes:256*1024*1024,maximumCacheOverflowBytes:128*1024*1024});
 tiles.modelMatrix=C.Matrix4.fromArray(record.settings.matrix);viewer.scene.primitives.add(tiles);
 const image=new Image();image.src=${JSON.stringify('/'+framePath)};await image.decode();
 const texture=new C.Texture({context:viewer.scene.context,source:image});
 const projector=new VideoArModelProjector(viewer,()=>texture);
 const position=point.position,baseOrigin=C.Cartesian3.fromDegrees(position.longitude,position.latitude,0),enu=C.Transforms.eastNorthUpToFixedFrame(baseOrigin);
 const world=v=>C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(enu,new C.Cartesian3(v.x,v.y,v.z),new C.Cartesian3()),new C.Cartesian3());
 const direction=world(cameraDirectionToEnu({x:0,y:0},point.gimbal_attitude)),top=world(cameraDirectionToEnu({x:0,y:-1},point.gimbal_attitude));
 const right=C.Cartesian3.normalize(C.Cartesian3.cross(direction,top,new C.Cartesian3()),new C.Cartesian3()),up=C.Cartesian3.normalize(C.Cartesian3.cross(right,direction,new C.Cartesian3()),new C.Cartesian3());
 const K=point.camera.estimated_intrinsics,intrinsics={width:3840,height:2160,fx:K.fx_px,fy:K.fy_px,cx:K.cx_px,cy:K.cy_px};
 const target=C.Cartesian3.add(C.Cartesian3.fromDegrees(position.longitude,position.latitude,position.relative_altitude),C.Cartesian3.multiplyByScalar(direction,160,new C.Cartesian3()),new C.Cartesian3());
 const eye=C.Matrix4.multiplyByPoint(enu,new C.Cartesian3(180,-160,210),new C.Cartesian3());viewer.camera.setView({destination:eye,orientation:{direction:C.Cartesian3.normalize(C.Cartesian3.subtract(target,eye,new C.Cartesian3()),new C.Cartesian3()),up:world({x:0,y:0,z:1})}});
 let resolved;
 window.actual={viewer,projector,tiles,point, setHeight:(datum,opacity=1)=>{resolved=resolveDjiHeight({mode:"estimated",sourceAltitude:position.altitude,relativeAltitude:position.relative_altitude,estimatedDatum:datum,estimatedDatumSource:"user-candidate",correctionMeters:0});const origin=C.Cartesian3.fromDegrees(position.longitude,position.latitude,resolved.ellipsoidHeight);projector.setFrame({origin,direction,up,intrinsics,opacity,maxDistance:2500});projector.setEnabled(true);document.querySelector('#note').textContent='10.010s | candidate datum '+datum.toFixed(3)+'m | camera h '+resolved.ellipsoidHeight.toFixed(3)+'m | UNVALIDATED';}, state:()=>({height:resolved,projector:projector.getDiagnosticState(),observer:{position:{...viewer.camera.positionWC},direction:{...viewer.camera.directionWC},up:{...viewer.camera.upWC}}})};
 window.actual.setHeight(0,0);window.ready=true;
 </script></body></html>`;
 await fs.writeFile(path.join(runRoot,"fixture.html"),fixture);
 server=spawn(process.execPath,[path.join(root,"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd:root,env:{...process.env,CESIUM_DATA_DIR:path.join(runRoot,"isolated-data")},windowsHide:true,stdio:"ignore"});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await sleep(100);}
 const executable=process.env.BROWSER_EXECUTABLE||["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
 browser=await chromium.launch({headless:true,executablePath:executable,args:["--disable-gpu-sandbox","--enable-unsafe-swiftshader"]});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on("pageerror",e=>errors.push(e.message));
 await page.goto(base+"/output/"+path.basename(runRoot)+"/fixture.html",{waitUntil:"domcontentloaded",timeout:90000});
 await page.waitForFunction(()=>window.ready,null,{timeout:120000});
 const cases=[];
 for(const [name,datum,opacity] of [["model_only",0,0],["datum_0m",0,1],["datum_source_minus_relative",candidateDatum,1]]) {
   await page.evaluate(({datum,opacity})=>actual.setHeight(datum,opacity),{datum,opacity});
   let ready=false;
   try{await page.waitForFunction(()=>actual.projector.ready,null,{timeout:60000});ready=true;}catch{}
   await sleep(2000);const state=await page.evaluate(()=>actual.state());
   await page.screenshot({path:path.join(runRoot,name+".png")});cases.push({name,ready,datum,opacity,...state});
 }
 const report={purpose:"same-frame height sensitivity only",acceptance:"unvalidated: no measured correspondences or holdout checkpoints",frameTimeMs:point.video_time_ms,point,sourceSha256:hash(sourceBytes),modelRecordSha256:hash(modelBytes),videoRecordSha256:hash(videoBytes),sourceImageSha256:hash(await fs.readFile(path.join(root,framePath))),modelRecordVisibility:model.visible,diagnosticSceneModelVisible:true,originalDataModified:false,frustumShown:false,candidateDatumExplanation:"abs_alt - rel_alt at selected frame, a hypothesis only; not a known ellipsoid datum",cases,errors};
 if(hash(await fs.readFile(modelPath))!==hash(modelBytes)||hash(await fs.readFile(videoPath))!==hash(videoBytes))throw Error("Original record changed during experiment");
 await fs.writeFile(path.join(runRoot,"height-comparison.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify({runRoot,cases:cases.map(c=>({name:c.name,ready:c.ready,height:c.height.ellipsoidHeight,status:c.projector.status})),errors}));
 if(errors.length||cases.some(c=>!c.ready))process.exitCode=1;
 }catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser?.close();server?.kill();}})();
