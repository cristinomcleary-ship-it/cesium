/** CPU-only lifecycle regression using transpiled production classes, no browser/GPU/data writes.
 * Run: node tools/verify-platform-projection-lifecycle.cjs
 * Optional output directory: CESIUM_PROJECTION_LIFECYCLE_OUT.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const out = path.resolve(process.env.CESIUM_PROJECTION_LIFECYCLE_OUT || path.join(root, "output/platform-revision-20261009/C"));
function element() {
  return { classList: {add(){},remove(){},toggle(){}}, style:{}, dataset:{}, hidden:false,
    addEventListener(){}, append(){}, setAttribute(){}, remove(){}, close(){}, querySelector(){return null;} };
}
class InertModule {
  constructor(options) { this.options=options;this.isOpen=false; }
  setVisible(){} setLayers(){} setActive(){} setPickingEnabled(){} setAuthoring(){} cancelPendingHome(){} setManagementSelection(){} setManagementTopic(){}
  setExternalSelection(){} setViewMode(){} updateSceneContext(){} setManagementEvents(){} setInspectionContext(){} getDisplayMode(){return "inspection";} dispose(){}
  open(){this.isOpen=true;} close(){this.isOpen=false;} debugStats(){return {};}
}
class SpatialModule extends InertModule {
  state={visible:false,drawing:false};
  constructor(options){super(options);}
  requestClose(next){this.state.visible=false;this.state.drawing=false;next?.();return true;}
  beginDefinition(){this.state.visible=true;this.state.drawing=true;this.options.onDrawing(true);}
  editDefinition(){this.beginDefinition();} showDefinitionTypes(){this.state.visible=true;}
  debugStats(){return {...this.state};} getSnapshot(){return {objects:[]};}
}
class InputHandler { setInputAction(){} removeInputAction(){} destroy(){this.destroyed=true;} }
class ManagementUi extends InertModule { constructor(host, options){super(options);this.videoHost=element();} }
class DiagnosticsUi extends InertModule { constructor(options){super(options);} }
const documentStub={body:element(),createElement:element,querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};
const modules={
  SafetySpatialEditor:SpatialModule,SafetySceneEffects:InertModule,SafetyModelOptimization:InertModule,SafetyDashboard:InertModule,
  LocalSafetyDataAdapter:InertModule,SafetyEventRepository:InertModule,EMPTY_EVENT_SNAPSHOT:{events:[],revision:0},
  ManagementStudio:ManagementUi,VideoDiagnostics:DiagnosticsUi,ScreenSpaceEventHandler:InputHandler,ScreenSpaceEventType:{LEFT_CLICK:0},
};
const sourceHashes={};
function load(relative, exportName){
  const source=fs.readFileSync(path.join(root,relative),"utf8");sourceHashes[relative]=crypto.createHash("sha256").update(source).digest("hex");
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const scope={exports:{},require:()=>modules,console,AbortController,structuredClone,performance,crypto:globalThis.crypto,
    document:documentStub,window:{addEventListener(){},clearTimeout(){},location:{search:""}},setTimeout:()=>1,clearTimeout(){}};
  vm.runInNewContext(js,scope,{filename:relative+".cpu.js"});return scope.exports[exportName];
}
const Safety=load("src/safetyWorkspace.ts","SafetyWorkspace");
const Management=load("src/managementWorkspace.ts","ManagementWorkspace");
function fixture(){
  let preview=false;const calls=[];
  const viewer={canvas:element(),scene:{requestRender(){},canvas:element()},camera:{cancelFlight(){}},
    entities:{remove(){},add(v){return v;}},screenSpaceEventHandler:new InputHandler(),resize(){},useDefaultRenderLoop:true};
  const app=new Safety({viewer,host:element(),getImports:()=>[],getPlaybackSource:()=>({url:"blob:fixture",recordId:"fixture-record",name:"fixture.mp4",generation:1}),
    setModelProjectionPreview(value){preview=value;calls.push(value);},setVideoPanelActive(){},restoreWorkbench(){},syncVideoPlayback(){},
    invalidateVideoProjection(reason){calls.push(reason);},getModelQualityStates:()=>[]});
  // Isolate lifecycle from network/media validation (tested separately); no synthetic pixels are claimed.
  app.active=true;app.managementSceneVisible=true;app.hasBoundVideo=()=>true;
  app.video={paused:true,currentTime:0,duration:100,playbackRate:1,pause(){this.paused=true;},removeAttribute(){},load(){}};
  const management=new Management(app,element());
  management.session={userId:"owner",permissions:["media","models","files"]};management.active=true;
  management.refreshAnchors=()=>{};management.updateContext=()=>{};
  return {app,management,calls,get preview(){return preview;}};
}
const results=[];
async function run(name,fn){await fn();results.push({name,pass:true});console.log("PASS: "+name);}
(async()=>{try {
  await run("drawing and model optimization reject preview startup",()=>{
    const f=fixture();f.app.spatial.state.visible=true;assert.throws(()=>f.app.managementSetProjectionPreview(true),/绘制或模型优化/);assert.equal(f.preview,false);
    f.app.spatial.state.visible=false;f.app.optimization.isOpen=true;assert.throws(()=>f.app.managementSetProjectionPreview(true),/绘制或模型优化/);assert.equal(f.preview,false);
    // Disable remains possible even when an interaction has taken ownership.
    f.app.managementSetProjectionPreview(false);assert.equal(f.preview,false);
  });
  await run("editor entry and direct production onDrawing callback stop an existing preview",()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);f.app.managementOpenEditor("risk-point");
    assert.equal(f.preview,false);assert.equal(f.app.spatial.state.drawing,true);
    const g=fixture();g.app.managementSetProjectionPreview(true);g.app.spatial.options.onDrawing(true);assert.equal(g.preview,false);
  });
  await run("model quality entry stops preview before inspection",()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);f.app.managementQuality();assert.equal(f.preview,false);assert.equal(f.app.optimization.isOpen,true);
  });
  await run("measurement and document anchor entry stop preview and block re-enable",()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);f.management.beginMeasurement();assert.equal(f.preview,false);assert.ok(f.management.measurement);
    assert.throws(()=>f.management.videoDiagnostics.options.preview(true),/测量或资料取点/);assert.equal(f.preview,false);
    const g=fixture();g.app.managementSetProjectionPreview(true);g.management.beginAnchorPick("document");assert.equal(g.preview,false);assert.ok(g.management.anchorPicking);
    assert.throws(()=>g.management.videoDiagnostics.options.preview(true),/测量或资料取点/);
  });
  await run("scene hiding and project changes stop preview",()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);f.app.setManagementSceneVisible(false);assert.equal(f.preview,false);assert.equal(f.app.options.viewer.useDefaultRenderLoop,false);
    assert.throws(()=>f.app.managementSetProjectionPreview(true),/三维场景/);
    const g=fixture();g.app.managementSetProjectionPreview(true);g.app.managementInvalidateProjection("project-change");assert.equal(g.preview,false);assert.ok(g.calls.includes("project-change"));
  });
  await run("workspace close clears preview and disallows subsequent enable",()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);f.app.close();assert.equal(f.preview,false);assert.equal(f.app.active,false);
    assert.throws(()=>f.app.managementSetProjectionPreview(true),/三维场景/);
  });
  await run("account and permission changes clear preview; diagnostics callback enforces both grants",()=>{
    for(const next of [null,{userId:"other",permissions:["media","models","files"]},{userId:"owner",permissions:["media"]},{userId:"owner",permissions:["models"]}]){
      const f=fixture();f.app.managementSetProjectionPreview(true);f.management.sessionChanged(next);assert.equal(f.preview,false);
      if(!next||!next.permissions.includes("models")||!next.permissions.includes("media")) assert.throws(()=>f.management.videoDiagnostics.options.preview(true),/权限/);
    }
  });
  await run("unbound or media-revoked source cannot start preview",()=>{
    const f=fixture();f.app.hasBoundVideo=()=>false;assert.throws(()=>f.app.managementSetProjectionPreview(true),/真实录像/);assert.equal(f.preview,false);
    const g=fixture();g.app.managementMediaRevoked=true;assert.throws(()=>g.app.managementSetProjectionPreview(true),/真实录像/);assert.equal(g.preview,false);
  });
  await run("changing recordings stops preview before the asynchronous library restore",async()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);f.app.updateVideoStatus=()=>{};f.app.reload=async()=>{};
    let restored=false;f.app.options.loadVideoSource=async()=>{assert.equal(f.preview,false);restored=true;};
    await f.app.openMedia({id:"video:new-record",sourceRecordId:"new-record",name:"new.mp4",kind:"video"});
    assert.equal(restored,true);assert.equal(f.preview,false);assert.equal(f.app.selectedMedia,"video:new-record");
  });
  await run("player-close end-fusion action clears preview through the production dispatcher",async()=>{
    const f=fixture();f.app.managementSetProjectionPreview(true);await f.management.sceneAction("end-fusion");assert.equal(f.preview,false);
  });
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,"projection-lifecycle.json"),JSON.stringify({status:"passed",passed:results.length,
    generatedAt:new Date().toISOString(),classification:"CPU lifecycle regression of transpiled production methods; inert renderer and media/DOM dependencies; not GPU or actual footage evidence",
    formalDataRead:false,formalDataWritten:false,sourceHashes,
    before:{classification:"read-only CPU probe captured before the fix during this development session; not reconstructed from B (which has no preview API)",
      observations:[{sequence:"preview(true) -> managementOpenEditor('risk-point')",previewStillActiveAfterStartDrawing:true,drawing:true},
        {sequence:"drawing=true -> preview(true)",previewCanBeEnabledWhileDrawing:true}],record:"Parent/subagent tool transcript, 2026-10-09. No preserved pre-fix source artifact."},
    results,limitations:["No GPU, picking pixel, video frame, rendering quality or engineering accuracy claim.","Media binding itself is stubbed true except dedicated rejection cases; actual same-source/PTS guards have separate tests.","The recorded before observation is not re-executed by this script."]},null,2));
  console.log(`PASS: ${results.length} CPU lifecycle groups; report ${path.join(out,"projection-lifecycle.json")}`);
}catch(error){
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,"projection-lifecycle.json"),JSON.stringify({status:"failed",generatedAt:new Date().toISOString(),sourceHashes,results,error:String(error),classification:"CPU-only production-method lifecycle regression"},null,2));
  console.error(error);process.exitCode=1;
}})();
