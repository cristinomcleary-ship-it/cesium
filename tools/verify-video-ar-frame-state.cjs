// CPU-only state regression: execute real Fusion methods with an inert renderer.
// This verifies transaction ordering, not WebGL pixels or geographic accuracy.
// Run: node --experimental-strip-types tools/verify-video-ar-frame-state.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { textureFrameIdentity } = require("../src/videoArTextureFrame.ts");
const root = path.resolve(__dirname, "..");
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, "src/videoArFusion.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText.replaceAll("import.meta.url", JSON.stringify(require("node:url").pathToFileURL(path.join(root, "src/videoArFusion.ts")).href));
const context = { exports: {}, console, HTMLVideoElement: class {}, window: { clearTimeout() {} },
  require(name) {
    if (name === "cesium") return require("cesium");
    if (name === "./videoArTextureQuality") return require("../src/videoArTextureQuality.ts");
    if (name === "./videoArPerformance") return require("../src/videoArPerformance.ts");
    if (name === "./videoArTextureFrame") return require("../src/videoArTextureFrame.ts");
    if (name === "./videoArCameraFrame") return require("../src/videoArCameraFrame.ts");
    // Unused browser/UI dependencies are inert; the tested methods below run
    // unchanged from current Fusion source, not copied into this test.
    return {};
  },
};
vm.runInNewContext(compiled, context, { filename: "videoArFusion.cpu-state.js" });
const Fusion = context.exports.VideoArFusion;
function fixture(kind = "video") {
  const app = Object.create(Fusion.prototype);
  const identity = textureFrameIdentity(1, kind, kind === "video" ? "video" : "frame:a.jpg", 10010);
  const camera = { allowProjection: true, videoTimeMs: 10010,
    positionEcef: { x: 1, y: 2, z: 3 }, attitude: { yaw: 1, pitch: -30, roll: 0 }, longitude: 120, latitude: 30, sourceAltitude: 100 };
  let enabled = true, appliedFrame = { tag: "old camera" };
  Object.assign(app, { panelActive: true, controlPointPicking: false, points: [{}], liveOnline: false,
    modelProjectionAllowed: true, stableTextureUpload: true, projectionVisible: true,
    committedModelCamera: camera, effectiveCamera: camera,
    activeTextureFrame: identity, committedModelTextureFrame: identity, uploadedTextureFrame: identity,
    modelProjectionFrame: appliedFrame, textureNeedsRefresh: false, lastVideoTextureTime: 10.01,
    modelProjector: { setFrame(frame) { appliedFrame = frame; }, setEnabled(value) { enabled = value; } },
    viewer: { scene: { requestRender() {} } }, element() { return { checked: false }; }, updateTelemetry() {},
  });
  return { app, identity, camera, enabled: () => enabled, appliedFrame: () => appliedFrame };
}
// The public picker callbacks use this exact cancel -> visibility sequence.
{
  const f = fixture();
  f.app.controlPointPicking = true;
  f.app.cancelPendingProjectionUpdates();
  f.app.applyVisibility();
  assert.equal(f.enabled(), false);
  f.app.controlPointPicking = false;
  f.app.applyVisibility();
  assert.equal(f.enabled(), true, "paused cancel restores the existing committed pair without a new decoded frame");
  assert.equal(f.app.lastVideoTextureTime, 10.01);
  assert.equal(f.app.uploadedTextureFrame, f.identity);
  assert.equal(f.app.textureNeedsRefresh, true);
}
{
  const f = fixture("bitmap"), oldFrame = f.appliedFrame();
  const nextIdentity = textureFrameIdentity(1, "bitmap", "frame:b.jpg", 10043.367);
  const nextCamera = { ...f.camera, videoTimeMs: nextIdentity.mediaTimeMs };
  f.app.activeTextureFrame = nextIdentity;
  f.app.effectiveCamera = nextCamera;
  f.app.modelProjectionFrame = { tag: "new camera" };
  f.app.commitModelCamera();
  assert.equal(f.appliedFrame(), oldFrame, "a new decoded bitmap pose cannot reuse the prior GPU image");
  assert.equal(f.app.committedModelCamera, f.camera);
  f.app.applyVisibility();
  assert.equal(f.enabled(), true, "the previous coherent pair may remain visible while uploading");
  f.app.stableTextureUpload = false;
  f.app.commitModelCamera();
  f.app.applyVisibility();
  assert.equal(f.appliedFrame(), oldFrame);
  assert.equal(f.enabled(), false, "failed upload does not leave an enabled mismatched projector");
  f.app.uploadedTextureFrame = nextIdentity;
  f.app.stableTextureUpload = true;
  f.app.commitModelCamera();
  f.app.applyVisibility();
  assert.equal(f.app.committedModelCamera, nextCamera);
  assert.equal(f.enabled(), true);
}
{
  const f = fixture("bitmap");
  f.app.pendingTextureFrame = textureFrameIdentity(1, "bitmap", "frame:pending.jpg", 11000);
  f.app.pendingTextureUpload = true;
  f.app.cancelPendingProjectionUpdates();
  assert.equal(f.app.pendingTextureFrame, undefined);
  assert.equal(f.app.uploadedTextureFrame, f.identity, "canceling staged pixels never relabels the resident GPU image");
  f.app.activeTextureFrame = textureFrameIdentity(2, "bitmap", "frame:a.jpg", 10010);
  const prior = f.appliedFrame();
  f.app.commitModelCamera();
  assert.equal(f.appliedFrame(), prior, "same-time frame from another source session cannot be committed");
}
{
  const f = fixture();
  f.app.videoObjectUrl = "blob:video";
  f.app.loadGeneration = 1;
  f.app.decodedVideoTime = Number.NaN;
  f.app.video = { currentTime: 10.01 };
  f.app.playbackMs = 9510;
  assert.equal(f.app.currentTextureFrame().mediaTimeMs, 10010, "Fusion fallback uses actual element time despite an offset trajectory slider");
}
// Execute the actual upload method, including its failure branch, without GL.
{
  const f = fixture("bitmap"), oldFrame = f.appliedFrame();
  const next = textureFrameIdentity(1, "bitmap", "frame:b.jpg", 10043.367);
  let rejectCopy = true, copies = 0;
  const gpuTexture = { copyFrom() {
    copies += 1;
    assert.equal(f.appliedFrame(), oldFrame, "new camera must remain uncommitted while pixels are being uploaded");
    if (rejectCopy) throw new Error("deliberate upload failure");
  } };
  Object.assign(f.app, {
    loadGeneration: 1, activeTextureFrame: next, effectiveCamera: { ...f.camera, videoTimeMs: next.mediaTimeMs },
    modelProjectionFrame: { tag: "new camera", intrinsics: { width:64, height:36, fx:50, fy:50, cx:32, cy:18 } }, textureWidth: 64, textureHeight: 36, sourceAspectRatio: 64 / 36,
    textureCanvas: { getContext() { return { drawImage() {} }; } },
    readyMaterialTexture() { return gpuTexture; }, textureTransactionPending() { return false; },
    updateTexturePreview() {}, markStaticFrameTextureFailure() {}, textureUploadWarningShown: true,
    element() { return { checked: false, dataset: {}, classList: { add() {} } }; },
  });
  const bitmap = { width: 64, height: 36 };
  f.app.drawTexture(bitmap, false, next);
  assert.equal(f.appliedFrame(), oldFrame);
  assert.equal(f.app.uploadedTextureFrame, f.identity);
  assert.equal(f.enabled(), false);
  rejectCopy = false;
  f.app.drawTexture(bitmap, false, next);
  assert.equal(copies, 2);
  assert.equal(f.app.uploadedTextureFrame, next);
  assert.equal(f.app.committedModelCamera, f.app.effectiveCamera);
  assert.equal(f.enabled(), true);
}
// Actual public diagnostics must distinguish planned resolution from allocated/current pixels.
{
  const f=fixture();Object.assign(f.app,{maximumTextureSize:16384,mediaSourceWidth:3840,mediaSourceHeight:2160,textureWidth:1920,textureHeight:1080,textureCanvas:{},videoObjectUrl:null,
    readyMaterialTexture(){return {width:1920,height:1080};},element(){return {value:"clear"};}});
  assert.equal(f.app.getTextureQuality().currentFrameUploaded,true);
  f.app.activeTextureFrame=textureFrameIdentity(1,"video","video",11000);
  assert.equal(f.app.getTextureQuality().currentFrameUploaded,false,"old GPU pixels cannot be called the current decoded frame");
  f.app.readyMaterialTexture=()=>undefined;
  assert.equal(f.app.getTextureQuality().gpuAllocated,null,"a quality plan never proves GPU allocation");
  assert.deepEqual({...f.app.getTextureQuality().planned},{width:1920,height:1080});
}
// Run the real projector depth guard without a synthetic renderer: stale depth
// revisions, scene frames and an empty caster pass cannot become ready.
{
  const projectorSource=ts.transpileModule(fs.readFileSync(path.join(root,"src/videoArModelProjector.ts"),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const scope={exports:{},require(name){if(name==="cesium")return require("cesium");if(name==="./videoArCamera")return require("../src/videoArCamera.ts");return {};}};
  vm.runInNewContext(projectorSource,scope);const p=Object.create(scope.exports.VideoArModelProjector.prototype);
  Object.assign(p,{viewer:{scene:{frameState:{frameNumber:12}}},sourceCoverageReady:true,sourceCastCount:2,lastSourceFrame:12,cameraRevision:3,sourceDepthCameraRevision:3});
  assert.equal(p.hasCurrentSourceDepth(),true);p.sourceDepthCameraRevision=2;assert.equal(p.hasCurrentSourceDepth(),false);p.sourceDepthCameraRevision=3;p.lastSourceFrame=11;assert.equal(p.hasCurrentSourceDepth(),false);p.lastSourceFrame=12;p.invalidateDepth();assert.equal(p.sourceCastCount,0);assert.equal(p.hasCurrentSourceDepth(),false);assert.equal(p.cameraRevision,4);
}
// Main-workspace preview is an explicit, reversible session overlay. Runtime
// diagnostics and persistent replay controls must not accidentally share it.
{
  context.HTMLInputElement=class {};
  const terrain=Object.assign(new context.HTMLInputElement(),{id:"videoArTerrain",type:"checkbox",checked:false});
  const surface={id:"videoArSurfaceMode",type:"select-one",value:"plane"},fps={id:"videoArFps",type:"select-one",value:"12"},quality={id:"videoArTextureQuality",type:"select-one",value:"clear"};
  const controls=[terrain,surface,fps,quality];context.document={querySelectorAll(){return controls;}};
  const f=fixture();let active=false;Object.assign(f.app,{videoObjectUrl:"blob:test",element(selector){return controls.find(c=>"#"+c.id===selector);},setPanelActive(value){active=value;},refreshCurrentGeometry(){}});
  f.app.setModelPreviewActive(true);assert.equal(active,true);assert.equal(surface.value,"model");assert.equal(terrain.checked,true);assert.equal(fps.value,"24");
  quality.value="economy";fps.value="18";
  assert.equal(f.app.replayControls().videoArFps,"18");
  assert.equal(f.app.replayControls(true).videoArFps,"12");assert.equal(f.app.replayControls(true).videoArSurfaceMode,"plane");assert.equal(f.app.replayControls(true).videoArTerrain,false);assert.equal(f.app.replayControls(true).videoArTextureQuality,"economy");
  f.app.setModelPreviewActive(true);assert.equal(fps.value,"18","idempotent activation preserves selected session FPS");
  f.app.setModelPreviewActive(false);assert.equal(active,false);assert.equal(fps.value,"12");assert.equal(surface.value,"plane");assert.equal(terrain.checked,false);assert.equal(quality.value,"economy");
  f.app.videoObjectUrl=null;assert.throws(()=>f.app.setModelPreviewActive(true),/真实录像/);
}
// Diagnostic evidence exports never mutate playback and reject staged or stale pixels.
{
  const f=fixture();let captures=0;
  Object.assign(f.app,{maximumTextureSize:16384,mediaSourceWidth:3840,mediaSourceHeight:2160,textureWidth:1920,textureHeight:1080,
    textureCanvas:{toDataURL(mime){assert.equal(mime,"image/png");captures++;return "data:image/png;base64,CPU_ONLY_TEST";}},
    videoObjectUrl:"blob:test",video:{paused:true,seeking:false},readyMaterialTexture(){return {width:1920,height:1080};},element(){return {value:"clear"};}});
  const evidence=f.app.captureTextureEvidence();assert.equal(evidence.note,"actual uploaded CPU canvas, not GPU framebuffer readback");
  assert.deepEqual({...evidence.frameIdentity},{...f.identity});assert.equal(captures,1);
  f.app.video.paused=false;assert.equal(f.app.captureTextureEvidence(),null);f.app.video.paused=true;
  for(const flag of ["textureNeedsRefresh","awaitingDecodedTexture","pendingTextureUpload"]){f.app[flag]=true;assert.equal(f.app.captureTextureEvidence(),null,flag);f.app[flag]=false;}
  f.app.video.seeking=true;assert.equal(f.app.captureTextureEvidence(),null);f.app.video.seeking=false;
  f.app.pendingTextureFrame=f.identity;assert.equal(f.app.captureTextureEvidence(),null);f.app.pendingTextureFrame=undefined;
  f.app.projectionCandidate={};assert.equal(f.app.captureTextureEvidence(),null);f.app.projectionCandidate=undefined;
  f.app.activeTextureFrame=textureFrameIdentity(1,"video","video",11000);assert.equal(f.app.captureTextureEvidence(),null);
  assert.equal(captures,1,"rejected evidence must not read a potentially staged canvas");
}
console.log("PASS: 9 CPU state regressions (8 transaction/preview groups plus guarded paused texture evidence)");
