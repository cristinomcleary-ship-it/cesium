// Read-only P2 before/after evidence on the real CC tiles and original 10.010 s frame.
// These image-space reason counts are NOT model coverage or registration accuracy.
const fs=require("node:fs/promises"),{existsSync}=require("node:fs"),path=require("node:path");
const {spawn,execFileSync}=require("node:child_process"),{createHash}=require("node:crypto");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const root=path.resolve(__dirname,".."),port=Number(process.env.VIDEO_AR_REAL_DEPTH_PORT||5194),base="http://127.0.0.1:"+port;
const outputRoot=path.join(root,"output","video-ar-execution-20261002","depth"),runRoot=path.join(outputRoot,"run-"+Date.now());
const modelId="8bc58629-cf26-45de-986e-086479db11a0",videoId="04cc67b0-4208-4fb4-9706-d064a45cefaf";
const modelRecordPath=path.join(root,"project-data","records",modelId,"record.json"),videoRecordPath=path.join(root,"project-data","records",videoId,"record.json");
const framePath=path.join(root,"output/video-ar-handoff-20261002/GPT_analysis/02_images/video_frames/frame_0010.01s.jpg");
const legacyRevision="2ce8fc4",shaderPath=path.join(root,"src/videoArModelProjector.ts");
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>createHash("sha256").update(b).digest("hex");
let server,browser,page,serverLog="",report;const errors=[];
const url=p=>"/"+path.relative(root,p).split(path.sep).join("/");
(async()=>{try{
 await fs.mkdir(runRoot,{recursive:true});
 const modelBytes=await fs.readFile(modelRecordPath),videoBytes=await fs.readFile(videoRecordPath),model=JSON.parse(modelBytes),video=JSON.parse(videoBytes);
 const trajectoryPath=path.join(root,"project-data/records",videoId,"source",video.files.source.name),trajectoryBytes=await fs.readFile(trajectoryPath),trajectory=JSON.parse(trajectoryBytes);
 const point=trajectory.trajectory_points.reduce((a,b)=>Math.abs(b.video_time_ms-10010)<Math.abs(a.video_time_ms-10010)?b:a);
 if(Math.abs(point.video_time_ms-10010)>0.01)throw Error("Expected exact 10.010 s source pose");
 const imageBytes=await fs.readFile(framePath),currentCode=await fs.readFile(shaderPath);
 const legacyCode=execFileSync("git",["show",legacyRevision+":src/videoArModelProjector.ts"],{cwd:root,encoding:"utf8",windowsHide:true,maxBuffer:1024*1024});
 await fs.writeFile(path.join(runRoot,"legacy-projector.ts"),legacyCode.replace('from "./videoArCamera"','from "/src/videoArCamera.ts"'));
 const tilesetPath=path.join(root,"project-data/records",modelId,"tiles",model.files.tiles.name),tilesetBytes=await fs.readFile(tilesetPath);
 report={purpose:"P2 shader/depth before-after evidence with the same unvalidated real camera and image",acceptance:"not-validated",legacyRevision,
  input:{modelId,videoId,frameTimeMs:point.video_time_ms,point,framePath,frameSha256:hash(imageBytes),trajectoryPath,trajectorySha256:hash(trajectoryBytes),modelRecordSha256:hash(modelBytes),videoRecordSha256:hash(videoBytes),tilesetSha256:hash(tilesetBytes),currentProjectorSha256:hash(currentCode),legacyProjectorSha256:hash(legacyCode)},
  controlledCamera:{ellipsoidHeight:99.117,heightStatus:"unverified test candidate only; not measured takeoff/ellipsoid datum",intrinsics:{width:3840,height:2160,fx:2560,fy:2560,cx:1920,cy:1080},gimbal:{yaw:-30,pitch:-30,roll:0},sourceFrame:"original full-resolution extracted JPEG; no HEVC playback is tested"},
  model:{maximumScreenSpaceError:1,originalRecordVisible:model.visible,fixtureVisible:true,matrix:model.settings.matrix,lodLimitation:"Same tileset, SSE, source camera, observer, canvas and settled requests; streaming is allowed and selected geometry is not formally frozen. Equal command counts do not prove identical triangles or geometry accuracy."},
  missingGroundTruth:{realOcclusionAccuracy:null,trueVisibleModelCoverage:null,independentCheckpointAccuracy:null,reason:"No independently labelled visible/occluded surfaces or verified real checkpoints in this experiment."},
  cases:[],errors,originalDataModified:false};
 const fixture=`<!doctype html><html><head><meta charset="utf-8"><style>html,body,#view{margin:0;width:100%;height:100%;overflow:hidden}.cesium-viewer-bottom,.cesium-viewer-toolbar{display:none}</style></head><body><div id="view"></div><script type="module">
 import * as C from "cesium";import "cesium/Build/Cesium/Widgets/widgets.css";
 import {VideoArModelProjector as CurrentProjector} from "/src/videoArModelProjector.ts";
 import {VideoArModelProjector as LegacyProjector} from ${JSON.stringify(url(path.join(runRoot,"legacy-projector.ts")))};
 import {cameraDirectionToEnu} from "/src/videoArCamera.ts";
 window.CESIUM_BASE_URL="/cesiumStatic/";
 const point=${JSON.stringify(point)},record=${JSON.stringify(model)};
 const viewer=new C.Viewer("view",{animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,navigationHelpButton:false,sceneModePicker:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),contextOptions:{webgl:{preserveDrawingBuffer:true,antialias:false}}});
 viewer.scene.globe.show=false;viewer.scene.skyBox.show=false;viewer.scene.skyAtmosphere.show=false;viewer.scene.sun.show=false;viewer.scene.moon.show=false;viewer.scene.backgroundColor=C.Color.BLACK;viewer.scene.postProcessStages.fxaa.enabled=false;viewer.scene.highDynamicRange=false;
 viewer.scene.screenSpaceCameraController.enableInputs=false;
 const tiles=await C.Cesium3DTileset.fromUrl(${JSON.stringify("/@fs/"+tilesetPath.replaceAll("\\","/"))},{maximumScreenSpaceError:1,cacheBytes:512*1024*1024,maximumCacheOverflowBytes:256*1024*1024});
 tiles.modelMatrix=C.Matrix4.fromArray(record.settings.matrix);viewer.scene.primitives.add(tiles);tiles.show=true;
 const image=new Image();image.src=${JSON.stringify(url(framePath))};await image.decode();
 if(image.width!==3840||image.height!==2160)throw Error("Original-frame dimensions do not match fixed K");
 const texture=new C.Texture({context:viewer.scene.context,source:image});
 const current=new CurrentProjector(viewer,()=>texture),legacy=new LegacyProjector(viewer,()=>texture);
 const p=point.position,origin=C.Cartesian3.fromDegrees(p.longitude,p.latitude,99.117),baseOrigin=C.Cartesian3.fromDegrees(p.longitude,p.latitude,0),enu=C.Transforms.eastNorthUpToFixedFrame(baseOrigin);
 const world=v=>C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(enu,new C.Cartesian3(v.x,v.y,v.z),new C.Cartesian3()),new C.Cartesian3());
 const attitude={yaw:-30,pitch:-30,roll:0};
 const direction=world(cameraDirectionToEnu({x:0,y:0},attitude)),top=world(cameraDirectionToEnu({x:0,y:-1},attitude));
 const right=C.Cartesian3.normalize(C.Cartesian3.cross(direction,top,new C.Cartesian3()),new C.Cartesian3()),up=C.Cartesian3.normalize(C.Cartesian3.cross(right,direction,new C.Cartesian3()),new C.Cartesian3());
 const intrinsics={width:3840,height:2160,fx:2560,fy:2560,cx:1920,cy:1080},frame={origin,direction,up,intrinsics,opacity:1,maxDistance:2500};
 legacy.setFrame(frame);current.setFrame(frame);legacy.setEnabled(false);current.setEnabled(false);
 const target=C.Cartesian3.add(C.Cartesian3.fromDegrees(p.longitude,p.latitude,p.relative_altitude),C.Cartesian3.multiplyByScalar(direction,160,new C.Cartesian3()),new C.Cartesian3());
 const eye=C.Matrix4.multiplyByPoint(enu,new C.Cartesian3(180,-160,210),new C.Cartesian3());viewer.camera.setView({destination:eye,orientation:{direction:C.Cartesian3.normalize(C.Cartesian3.subtract(target,eye,new C.Cartesian3()),new C.Cartesian3()),up:world({x:0,y:0,z:1})}});
 let selected="model-only";
 const vector=v=>({x:v.x,y:v.y,z:v.z});
 const readCanvas=document.createElement("canvas");
 window.actual={viewer,tiles,current,legacy,
  select:(version,mode="off")=>{legacy.setEnabled(false);current.setEnabled(false);selected=version;if(version==="legacy")legacy.setEnabled(true);if(version==="current"){current.setDiagnosticMode(mode);current.setEnabled(true);}viewer.scene.requestRender();},
  settled:()=>tiles.tilesLoaded&&((selected==="legacy"&&legacy.ready)||(selected==="current"&&current.ready)||selected==="model-only"),
  state:()=>({selected,projector:selected==="legacy"?legacy.getDiagnosticState():current.getDiagnosticState(),model:{show:tiles.show,tilesLoaded:tiles.tilesLoaded,maximumScreenSpaceError:tiles.maximumScreenSpaceError,selectedTiles:tiles._selectedTiles?.length??null,requested:tiles._requestedTiles?.length??null},observer:{position:vector(viewer.camera.positionWC),direction:vector(viewer.camera.directionWC),up:vector(viewer.camera.upWC)},canvas:{width:viewer.canvas.width,height:viewer.canvas.height},frame:{origin:vector(origin),direction:vector(direction),up:vector(up),intrinsics}}),
  reasonCounts:()=>{
   if(selected!=="current"||current.getDiagnosticState().diagnostic.mode!=="rejection-reason")throw Error("Reason counts require actual rejection shader output");
   viewer.render();readCanvas.width=viewer.canvas.width;readCanvas.height=viewer.canvas.height;const ctx=readCanvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(viewer.canvas,0,0);const data=ctx.getImageData(0,0,readCanvas.width,readCanvas.height).data;
   const colors={accepted:[0,255,0],sourcePassNotReady:[128,128,128],noObserverSurface:[0,0,128],outsideSourceFrustum:[255,128,0],noSourceDepth:[255,0,255],firstSurfaceRejected:[255,0,0],videoUvOutside:[0,255,255]},counts=Object.fromEntries(Object.keys(colors).map(k=>[k,0]));counts.unclassified=0;
   for(let i=0;i<data.length;i+=4){const key=Object.keys(colors).find(k=>colors[k].every((v,c)=>Math.abs(v-data[i+c])<=3));counts[key??"unclassified"]++;}
   return{counts,totalPixels:readCanvas.width*readCanvas.height,meaning:"Actual current-view shader reason-mask pixels, including sky/background. NOT true surface area, eligible visible-model coverage, or independently established occlusion accuracy."};
  }
 };window.ready=true;
 </script></body></html>`;
 await fs.writeFile(path.join(runRoot,"fixture.html"),fixture);
 // This evidence server must not reload while independent agents edit source.
 const configPath=path.join(runRoot,"vite-evidence.config.mjs");
 await fs.writeFile(configPath,`import config from ${JSON.stringify(path.join(root,"vite.config.ts").replaceAll("\\","/"))};export default {...config,server:{...config.server,hmr:false,watch:null}};`);
 server=spawn(process.execPath,[path.join(root,"node_modules/vite/bin/vite.js"),"--config",configPath,"--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd:root,env:{...process.env,CESIUM_DATA_DIR:path.join(runRoot,"isolated-data")},windowsHide:true,stdio:["ignore","pipe","pipe"]});
 server.stdout.on("data",d=>serverLog+=d);server.stderr.on("data",d=>serverLog+=d);
 let started=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error("Isolated server exited: "+serverLog);try{if((await fetch(base,{signal:AbortSignal.timeout(1000)})).ok){started=true;break;}}catch{}await sleep(150);}if(!started)throw Error("Isolated server did not start");
 const executable=process.env.BROWSER_EXECUTABLE||"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
 browser=await chromium.launch({headless:true,executablePath:existsSync(executable)?executable:undefined,args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
 page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&/WebGL|shader|rendering has stopped/i.test(m.text()))errors.push(m.text());});
 await page.goto(base+url(path.join(runRoot,"fixture.html")),{waitUntil:"domcontentloaded",timeout:90000});await page.waitForFunction(()=>window.ready,null,{timeout:120000});
 const cases=[["00-model-only","model-only","off"],["01-before-p2","legacy","off"],["02-after-p2","current","off"],...["source-depth","observer-depth","depth-difference","rejection-reason","extrapolation-mask"].map((m,i)=>["0"+(i+3)+"-"+m,"current",m])];
 for(const [name,version,mode] of cases){
  await page.evaluate(({version,mode})=>actual.select(version,mode),{version,mode});
  await page.waitForFunction(()=>actual.settled(),null,{timeout:120000});
  // Observe continued settled state, not only a single zero request counter.
  await sleep(1000);await page.waitForFunction(()=>actual.settled(),null,{timeout:120000});
  await page.evaluate(()=>actual.viewer.render());const state=await page.evaluate(()=>actual.state());
  const reasonCounts=mode==="rejection-reason"?await page.evaluate(()=>actual.reasonCounts()):undefined;
  await page.screenshot({path:path.join(runRoot,name+".png")});
  report.cases.push({name,version,mode,screenshot:name+".png",...state,...(reasonCounts?{reasonCounts}:{})});
 }
 const cameraKeys=report.cases.map(c=>JSON.stringify({observer:c.observer,frame:c.frame,canvas:c.canvas}));if(new Set(cameraKeys).size!==1)throw Error("Comparison camera, image geometry or viewport changed");
 report.cameraAndViewportIdentical=true;
 const beforeCamera=report.cases.find(c=>c.version==="legacy").projector.camera,afterCamera=report.cases.find(c=>c.version==="current").projector.camera;
 if(JSON.stringify(beforeCamera)!==JSON.stringify(afterCamera))throw Error("Actual applied old/new projector camera uniforms differ");
 report.appliedProjectorCameraIdentical=true;
 for(const [name,p,expected] of [["model record",modelRecordPath,hash(modelBytes)],["video record",videoRecordPath,hash(videoBytes)],["trajectory",trajectoryPath,hash(trajectoryBytes)],["source image",framePath,hash(imageBytes)],["root tileset",tilesetPath,hash(tilesetBytes)]])if(hash(await fs.readFile(p))!==expected)throw Error("Original material changed: "+name);
 report.originalDataReadOnlyVerified="Record JSONs, trajectory, source JPEG and root tileset hashes unchanged; child tiles served read-only and not rewritten.";
 report.result=errors.length?"FAIL":"PASS";
 await fs.writeFile(path.join(runRoot,"depth-comparison.json"),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(outputRoot,"latest.json"),JSON.stringify({runRoot,report:path.join(runRoot,"depth-comparison.json"),result:report.result},null,2));
 await fs.writeFile(path.join(runRoot,"preview.html"),'<!doctype html><meta charset="utf-8"><title>真实素材深度修复对照</title><style>body{background:#111;color:#eee;font:16px sans-serif;margin:24px}section{margin-bottom:24px}img{max-width:100%}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}</style><h1>真实素材深度修复对照 · 10.010 秒</h1><p>前后采用同一固定相机输入、视频帧和观察视角。99.117 米只是未核定试验高度。本页尚不证明真实配准或遮挡精度。屏幕像素计数不是有效覆盖率；SSE 和请求数一致也不证明三角网完全一致。</p><p>拒绝掩膜：绿为接受；灰为通道未就绪；深蓝为无观察表面；橙为源视锥外；紫为无源深度；红为首表面深度不符；青为视频 UV 越界。深度差红为正、蓝为负、绿为零，±2 米显示范围，遮挡阈值仍为 ±0.35 米。</p><p><a href="depth-comparison.json">下载原始相机、加载状态和掩膜计数</a></p><div class="pair">'+report.cases.filter(c=>c.name==="01-before-p2"||c.name==="02-after-p2").map(c=>'<section><h2>'+c.name+'</h2><img src="'+c.screenshot+'"></section>').join('')+'</div>'+report.cases.filter(c=>c.name!=="01-before-p2"&&c.name!=="02-after-p2").map(c=>'<section><h2>'+c.name+'</h2><img src="'+c.screenshot+'"></section>').join(''));
 console.log(JSON.stringify({result:report.result,runRoot,cases:report.cases.map(c=>({name:c.name,ready:c.projector.ready,castCommands:c.projector.depth.castCommandCount,reasonCounts:c.reasonCounts})),errors},null,2));
 if(errors.length)process.exitCode=1;
}catch(error){console.error(error.stack);process.exitCode=1;if(report){report.result="FAIL";report.failure=error.stack;await fs.writeFile(path.join(runRoot,"depth-comparison.json"),JSON.stringify(report,null,2));}if(page)await page.screenshot({path:path.join(runRoot,"failure.png")}).catch(()=>{});
}finally{await browser?.close();if(server&&server.exitCode===null){const stopped=new Promise(r=>server.once("exit",r));server.kill();await stopped;}await fs.mkdir(runRoot,{recursive:true});await fs.writeFile(path.join(runRoot,"server.log"),serverLog);}})();
