// Isolated GPU regression for model-aware video projection. Real project-data is untouched.
// PLAYWRIGHT_MODULE may point to the installed Playwright package.
const fs=require("node:fs/promises"),{existsSync}=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process"),assert=require("node:assert/strict");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const root=path.resolve(__dirname,".."),port=Number(process.env.VIDEO_AR_MODEL_TEST_PORT||5189),base="http://127.0.0.1:"+port;
const runRoot=path.join(root,"tmp","video-ar-model-browser-"+Date.now()),checks=[],errors=[],results={};
let server,browser,page,serverLog="";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fixture=String.raw`
import * as C from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { VideoArModelProjector } from "/src/videoArModelProjector.ts";
window.CESIUM_BASE_URL = "/cesiumStatic/";
const viewer = new C.Viewer("view", {animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,navigationHelpButton:false,sceneModePicker:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),contextOptions:{webgl:{preserveDrawingBuffer:true,antialias:false}}});
viewer.scene.globe.show=false;viewer.scene.skyBox.show=false;viewer.scene.skyAtmosphere.show=false;viewer.scene.sun.show=false;viewer.scene.moon.show=false;viewer.scene.backgroundColor=C.Color.BLACK;viewer.scene.postProcessStages.fxaa.enabled=false;viewer.scene.highDynamicRange=false;
const transform=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(120,30));
const world=(x,y,z)=>C.Matrix4.multiplyByPoint(transform,new C.Cartesian3(x,y,z),new C.Cartesian3());
const direction=(x,y,z)=>C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(transform,new C.Cartesian3(x,y,z),new C.Cartesian3()),new C.Cartesian3());
function box(x,y,z,dx,dy,dz) {
 const modelMatrix=C.Matrix4.multiplyByTranslation(transform,new C.Cartesian3(x,y,z),new C.Matrix4());
 return viewer.scene.primitives.add(new C.Primitive({geometryInstances:new C.GeometryInstance({geometry:C.BoxGeometry.fromDimensions({dimensions:new C.Cartesian3(dx,dy,dz),vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT}),modelMatrix,attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(new C.Color(.28,.28,.28,1))}}),appearance:new C.PerInstanceColorAppearance({flat:true,translucent:false,closed:true}),asynchronous:false,shadows:C.ShadowMode.ENABLED}));
}
const boxes=[box(0,0,10,20,16,20),box(0,25,12,50,2,24)];
const source=document.createElement("canvas");source.width=512;source.height=512;
const sourceContext=source.getContext("2d"),colors=["#ef2424","#26e63f","#3348ed","#ecc528"];
for(let y=0;y<8;y++)for(let x=0;x<8;x++){sourceContext.fillStyle=colors[(x+2*y)%4];sourceContext.fillRect(x*64,y*64,64,64);}
const texture=new C.Texture({context:viewer.scene.context,source,sampler:new C.Sampler({minificationFilter:C.TextureMinificationFilter.NEAREST,magnificationFilter:C.TextureMagnificationFilter.NEAREST})});
const sourceOrigin=world(0,-55,36),sourceDirection=direction(0,55,-26);
const right=C.Cartesian3.normalize(C.Cartesian3.cross(sourceDirection,direction(0,0,1),new C.Cartesian3()),new C.Cartesian3());
const sourceUp=C.Cartesian3.normalize(C.Cartesian3.cross(right,sourceDirection,new C.Cartesian3()),new C.Cartesian3());
const frame={origin:sourceOrigin,direction:sourceDirection,up:sourceUp,intrinsics:{width:512,height:512,fx:300,fy:300,cx:256,cy:256},opacity:1,maxDistance:250};
let activeFrame=frame;
const projector=new VideoArModelProjector(viewer,()=>texture);projector.setFrame(frame);projector.setEnabled(false);
const probes={roof:world(3,0,20),front:world(-3,-8.01,12),hiddenWall:world(0,23.99,7),exposedWall:world(20,23.99,9)};
function viewpoint(side=1){const eye=world(side===1?65:48,side===1?-38:-70,side===1?47:56),target=world(0,8,10),d=C.Cartesian3.normalize(C.Cartesian3.subtract(target,eye,new C.Cartesian3()),new C.Cartesian3());viewer.camera.setView({destination:eye,orientation:{direction:d,up:direction(0,0,1)}});}
viewpoint();
const readCanvas=document.createElement("canvas");
function image(){viewer.render();readCanvas.width=viewer.canvas.width;readCanvas.height=viewer.canvas.height;const ctx=readCanvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(viewer.canvas,0,0);return ctx;}
function pixels(){
 const context=image(),rgb={};
 for(const [name,position] of Object.entries(probes)){
  const p=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,position),x=Math.round(p.x*viewer.canvas.width/viewer.canvas.clientWidth),y=Math.round(p.y*viewer.canvas.height/viewer.canvas.clientHeight);
  if(x<1||y<1||x+1>=readCanvas.width||y+1>=readCanvas.height)throw Error("Probe outside viewport: "+name);
  const data=context.getImageData(x-1,y-1,3,3).data,channels=[[],[],[]];
  for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++)channels[c].push(data[i+c]);
  rgb[name]=channels.map(v=>v.sort((a,b)=>a-b)[4]);
 }
 const expected={};
 const sourceRight=C.Cartesian3.normalize(C.Cartesian3.cross(activeFrame.direction,activeFrame.up,new C.Cartesian3()),new C.Cartesian3());
 for(const [name,point] of Object.entries(probes)){
  const difference=C.Cartesian3.subtract(point,activeFrame.origin,new C.Cartesian3()),depth=C.Cartesian3.dot(difference,activeFrame.direction),k=activeFrame.intrinsics;
  const u=Math.floor(k.cx+k.fx*C.Cartesian3.dot(difference,sourceRight)/depth),v=Math.floor(k.cy-k.fy*C.Cartesian3.dot(difference,activeFrame.up)/depth);
  expected[name]=[...sourceContext.getImageData(u,v,1,1).data].slice(0,3);
 }
 return{rgb,expected,status:projector.status,ready:projector.ready,stages:viewer.scene.postProcessStages.length};
}
window.fixture={viewer,projector,source,texture,frame,pixels,viewpoint,
 adjust:kind=>{
  if(kind==="roll")activeFrame={...frame,up:C.Cartesian3.normalize(C.Cartesian3.add(C.Cartesian3.multiplyByScalar(frame.up,Math.cos(.4),new C.Cartesian3()),C.Cartesian3.multiplyByScalar(right,Math.sin(.4),new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3())};
  else if(kind==="intrinsics")activeFrame={...frame,intrinsics:{...frame.intrinsics,fx:410,fy:340,cx:270,cy:260}};
  else activeFrame=frame;
  projector.setFrame(activeFrame);
 },enable:value=>projector.setEnabled(value),empty:()=>boxes.forEach(box=>viewer.scene.primitives.remove(box)),destroy:()=>projector.destroy(),
 noDepth:()=>{Object.defineProperty(viewer.scene.context,"depthTexture",{configurable:true,get:()=>false});let p;try{p=new VideoArModelProjector(viewer,()=>texture);p.setFrame(frame);p.setEnabled(true);return{ready:p.ready,status:p.status};}finally{p?.destroy();delete viewer.scene.context.depthTexture;}},
 nonblack:()=>{const c=image(),d=c.getImageData(0,0,readCanvas.width,readCanvas.height).data;let colored=0;for(let i=0;i<d.length;i+=4)if(Math.max(d[i],d[i+1],d[i+2])-Math.min(d[i],d[i+1],d[i+2])>30)colored++;return colored;}
};window.fixtureReady=true;
`;
async function start(){
 await fs.mkdir(runRoot,{recursive:true});
 await fs.writeFile(path.join(runRoot,"fixture.html"),'<!doctype html><html><head><style>html,body,#view{margin:0;width:100%;height:100%;overflow:hidden}.cesium-widget,.cesium-widget canvas{width:100%;height:100%}.cesium-viewer-bottom,.cesium-viewer-toolbar,.cesium-viewer-fullscreenContainer{display:none}</style></head><body><div id="view"></div><script type="module">'+fixture+"</script></body></html>");
 server=spawn(process.execPath,[path.join(root,"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd:root,env:{...process.env,CESIUM_DATA_DIR:path.join(runRoot,"project-data")},windowsHide:true,stdio:["ignore","pipe","pipe"]});
 server.stdout.on("data",data=>serverLog+=data);server.stderr.on("data",data=>serverLog+=data);
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error("Test server exited: "+serverLog);try{if((await fetch(base+"/__library/records",{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}await sleep(150);}
 throw Error("Test server did not start: "+serverLog);
}
async function settle(){await page.evaluate(async()=>{for(let i=0;i<10;i++)await new Promise(requestAnimationFrame);});}
async function snapshot(name){await settle();const value=await page.evaluate(()=>window.fixture.pixels());await page.screenshot({path:path.join(runRoot,name+".png")});return value;}
const delta=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i]))),chroma=a=>Math.max(...a)-Math.min(...a);
(async()=>{
 await start();
 const executable=process.env.BROWSER_EXECUTABLE||"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
 browser=await chromium.launch({executablePath:existsSync(executable)?executable:undefined,headless:true,args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
 const context=await browser.newContext({viewport:{width:900,height:760}});
 await context.addInitScript(()=>{
  window.modelGpu={linked:0,draws:0,failures:[]};
  const sources=new WeakMap(),programs=new WeakSet();
  for(const proto of [window.WebGLRenderingContext?.prototype,window.WebGL2RenderingContext?.prototype]){
   if(!proto)continue;const ss=proto.shaderSource,cs=proto.compileShader,lp=proto.linkProgram;
   proto.shaderSource=function(shader,source){sources.set(shader,source);return ss.call(this,shader,source);};
   proto.compileShader=function(shader){const r=cs.call(this,shader);if(!this.getShaderParameter(shader,this.COMPILE_STATUS))window.modelGpu.failures.push(this.getShaderInfoLog(shader));return r;};
   proto.linkProgram=function(program){const r=lp.call(this,program);if(!this.getProgramParameter(program,this.LINK_STATUS))window.modelGpu.failures.push(this.getProgramInfoLog(program));const source=(this.getAttachedShaders(program)||[]).map(shader=>sources.get(shader)||"").join("\n");if(/videoArModel|u_videoTexture|u_projector|arVideoTexture/.test(source)){programs.add(program);window.modelGpu.linked++;}return r;};
   for(const name of ["drawElements","drawArrays","drawElementsInstanced","drawArraysInstanced"]){if(!proto[name])continue;const draw=proto[name];proto[name]=function(...args){if(programs.has(this.getParameter(this.CURRENT_PROGRAM)))window.modelGpu.draws++;return draw.apply(this,args);};}
  }
 });
 page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>{if(message.type()==="error"&&/WebGL|shader|rendering has stopped|compile|link program/i.test(message.text()))errors.push(message.text());});
 await page.goto(base+"/"+path.relative(root,path.join(runRoot,"fixture.html")).split(path.sep).join("/"),{waitUntil:"domcontentloaded"});
 await page.waitForFunction(()=>window.fixtureReady,{},{timeout:30000});
 results.baseline=await snapshot("01-disabled");
 await page.evaluate(()=>window.fixture.enable(true));
 results.enabled=await snapshot("02-model-projection");
 assert.ok(chroma(results.enabled.rgb.roof)>40,"Roof must receive colored source texture: "+JSON.stringify(results.enabled));
 assert.ok(chroma(results.enabled.rgb.front)>40,"Facade must receive colored source texture");
 assert.ok(chroma(results.enabled.rgb.exposedWall)>40,"Unoccluded rear wall must receive source texture");
 assert.ok(delta(results.enabled.rgb.hiddenWall,results.baseline.rgb.hiddenWall)<=12,"Source-camera occluded wall must not receive video: "+JSON.stringify(results));
 checks.push("Source colors reach roof and facade; source-camera occlusion excludes the hidden rear wall");
 await page.evaluate(()=>window.fixture.viewpoint(2));results.rotated=await snapshot("03-rotated-view");
 for(const name of ["roof","front"])assert.ok(delta(results.enabled.rgb[name],results.rotated.rgb[name])<=25,"Changing observer must keep the same world surface source color: "+name+" "+JSON.stringify(results.rotated));
 checks.push("Observer movement keeps video registered on the same 3D roof and wall points");
 for(const name of ["roof","front","exposedWall"])assert.ok(delta(results.enabled.rgb[name],results.enabled.expected[name])<=8,"Projected source pixel must equal independent pinhole correspondence: "+name);
 checks.push("Roof and wall pixels match an independent camera projection into the source checkerboard");
 for(const kind of ["roll","intrinsics"]){
  await page.evaluate(k=>{window.fixture.viewpoint(1);window.fixture.adjust(k);},kind);
  results[kind]=await snapshot("03-"+kind+"-only");
  for(const name of ["roof","front"])assert.ok(delta(results[kind].rgb[name],results[kind].expected[name])<=8,"Changing only "+kind+" must refresh image/depth camera coherently: "+name+" "+JSON.stringify(results[kind]));
 }
 checks.push("Roll-only and intrinsics-only updates preserve coherent source image and visibility depth");
 await page.evaluate(()=>window.fixture.adjust("normal"));
 await page.evaluate(()=>{window.fixture.viewpoint(1);window.fixture.enable(false);});results.disabled=await snapshot("04-disabled-again");
 for(const name of Object.keys(results.baseline.rgb))assert.ok(delta(results.disabled.rgb[name],results.baseline.rgb[name])<=12,"Disabling must restore original surface: "+name);
 checks.push("Disabling removes video without stale projected colors");
 await page.evaluate(()=>{window.fixture.enable(true);window.fixture.empty();});await settle();results.emptyColoredPixels=await page.evaluate(()=>window.fixture.nonblack());
 assert.equal(results.emptyColoredPixels,0,"Empty scene must not fall back to a colored plane");checks.push("No model geometry produces no projection plane or colored background");
 await page.evaluate(()=>window.fixture.destroy());await settle();results.destroyed=await page.evaluate(()=>({stages:window.fixture.viewer.scene.postProcessStages.length,colored:window.fixture.nonblack()}));
 assert.equal(results.destroyed.stages,0,"Destroy must release the post-process stage");assert.equal(results.destroyed.colored,0,"Destroy must leave no image");checks.push("Destroy releases the stage without residual video");
 results.noDepth=await page.evaluate(()=>window.fixture.noDepth());assert.equal(results.noDepth.ready,false,"Missing depth support must not become ready");checks.push("Missing depth support reports unavailable without plane fallback");
 results.gpu=await page.evaluate(()=>window.modelGpu);assert.ok(results.gpu.linked>0&&results.gpu.draws>0,"Projection shader must link and draw: "+JSON.stringify(results.gpu));assert.deepEqual(results.gpu.failures,[]);assert.deepEqual(errors,[]);
 checks.push("Actual WebGL shaders compile, link and draw without render errors");
 const report={result:"PASS",checks,results,errors,artifacts:runRoot};await fs.writeFile(path.join(runRoot,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(async error=>{
 console.error(error);
 if(page&&!page.isClosed()){await page.screenshot({path:path.join(runRoot,"failure.png")}).catch(()=>{});results.diagnostics=await page.evaluate(()=>({gpu:window.modelGpu,state:window.fixture?.pixels?.()})).catch(e=>({error:e.message}));}
 await fs.mkdir(runRoot,{recursive:true});const report={result:"FAIL",message:error.stack,checks,results,errors,artifacts:runRoot};await fs.writeFile(path.join(runRoot,"result.json"),JSON.stringify(report,null,2));console.error(JSON.stringify(report,null,2));process.exitCode=1;
}).finally(async()=>{
 await browser?.close();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once("exit",resolve));server.kill();await exited;}await fs.writeFile(path.join(runRoot,"server.log"),serverLog);
});
