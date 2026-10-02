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
    modelProjectionFrame: { tag: "new camera" }, textureWidth: 64, textureHeight: 36, sourceAspectRatio: 64 / 36,
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
console.log("PASS: 5 CPU state regressions (paused cancel, bitmap commit/failure, pending/source identity, no-RVFC media time, real upload ordering)");
