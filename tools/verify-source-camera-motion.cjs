// CPU regression of actual projector methods with native Cesium Camera objects.
// No Viewer/WebGL, tiles downloaded, or formal project data written.
// Run: node --experimental-strip-types tools/verify-source-camera-motion.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const Cesium = require('cesium');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.CESIUM_SOURCE_CAMERA_OUT || path.join(root, 'output/platform-revision-20261009/C/source-camera-motion'));
const sourcePath = path.join(root, 'src/videoArModelProjector.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function compile(text) {
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require(name) {
    if (name === 'cesium') return Cesium;
    if (name === './videoArCamera') return require('../src/videoArCamera.ts');
    return {};
  } };
  vm.runInNewContext(compiled, context, { filename: 'actual-videoArModelProjector.cpu.js' });
  return context.exports.VideoArModelProjector;
}
const Projector = compile(source);
function camera() {
  return new Cesium.Camera({ drawingBufferWidth: 100, drawingBufferHeight: 100, mapProjection: new Cesium.GeographicProjection() });
}
function fixture(Type = Projector) {
  const sourceCamera = camera(), observerCamera = camera();
  const native = sourceCamera._updateCameraChanged;
  let sourceCalls = 0, observerCalls = 0;
  sourceCamera._updateCameraChanged = function () { sourceCalls++; return native.call(this); };
  const observerNative = observerCamera._updateCameraChanged;
  observerCamera._updateCameraChanged = function () { observerCalls++; return observerNative.call(this); };
  const targets = [];
  const state = { frameNumber: 1, camera: observerCamera, cullingVolume: { observer: true }, commandList: [], passes: { render: true }, shadowMaps: [], mode: Cesium.SceneMode.SCENE3D };
  const p = Object.create(Type.prototype);
  Object.assign(p, {
    viewer: { scene: { camera: observerCamera, frameState: state, primitives: { get length() { return targets.length; }, get(index) { return targets[index]; } } } },
    sourceCamera, sourceFrustum: sourceCamera.frustum, sourceCommands: [], sourceTileCount: 0, sourceCastCount: 0,
    sourceCoverageReady: false, sourceError: '', lastSourceFrame: -1, lastSourceCameraMotionFrame: -1,
    cameraRevision: 1, sourceDepthCameraRevision: -1, enabled: false, destroyed: false,
    context: { depthTexture: true }, getVideoTexture() { return undefined; }, stage: { enabled: false, ready: false },
    shadow: { _outOfView: false, _usesDepthTexture: true, size: 2048, _primitiveRenderState: { polygonOffset: { enabled: false, factor: 0, units: 0 } }, normalOffset: false, softShadows: false, maximumDistance: 2000 },
    originalPolygonOffset: { enabled: true, factor: 1.1, units: 4 }, nearFar: { x: 0.5, y: 2000 }, diagnosticMode: 'off',
  });
  return { p, state, targets, sourceCamera, observerCamera, sourceCalls: () => sourceCalls, observerCalls: () => observerCalls };
}
function settledTarget(update) {
  return { show: true, shadows: Cesium.ShadowMode.CAST_ONLY, isCesium3DTileset: true, _requestedTiles: [], _statistics: { numberOfPendingRequests: 0, numberOfTilesProcessing: 0 }, updateForPass: update || (() => {}) };
}
const report = { schema: 'source-camera-motion-cpu/v1', classification: 'CPU regression using actual production methods and native Cesium Camera; no GPU or performance acceptance', source: { path: sourcePath, sha256: digest(source), cesium: Cesium.VERSION }, tests: [], passed: false };
async function test(name, body) {
  const evidence = await body();
  report.tests.push({ name, passed: true, evidence: evidence || null });
  console.log('PASS', name);
}
async function main() {
  await test('Historical B implementation reproduces missing native bookkeeping', () => {
    const revision = '8c6cdbc9cc8e0e6c07a46b9463479a16fd930f9b';
    const oldSource = execFileSync('git', ['show', revision + ':src/videoArModelProjector.ts'], { cwd: root, encoding: 'utf8', windowsHide: true });
    const f = fixture(compile(oldSource));
    f.p.updateSourceTiles(f.state);
    f.sourceCamera.position.x += 1;
    f.state.frameNumber++; f.p.updateSourceTiles(f.state);
    f.state.frameNumber++; f.p.updateSourceTiles(f.state);
    assert.equal(f.sourceCalls(), 0);
    assert.equal(f.sourceCamera.timeSinceMoved, 0);
    assert.equal(f.observerCalls(), 0);
    return { revision, nativeCallsAcrossThreeTraversals: f.sourceCalls(), timeSinceMoved: f.sourceCamera.timeSinceMoved, limitation: 'Proves bookkeeping omission; does not establish it as the cause of GPU loading delays.' };
  });
  await test('Every stationary and moving traversal updates native source motion before tiles', async () => {
    const f = fixture();
    const originalObserverPosition = Cesium.Cartesian3.clone(f.observerCamera.position);
    const observerTime = f.observerCamera.timeSinceMoved;
    let traversals = 0;
    f.targets.push(settledTarget((state, pass) => {
      traversals++;
      assert.equal(f.sourceCalls(), traversals, 'native update precedes each tileset pass');
      assert.equal(pass.camera, f.sourceCamera);
      assert.equal(state.camera, f.observerCamera);
    }));
    f.p.updateSourceTiles(f.state);
    f.sourceCamera.position.x += 1;
    f.state.frameNumber++; f.p.updateSourceTiles(f.state);
    assert.ok(Math.abs(f.sourceCamera.positionWCDeltaMagnitude - 1) < 1e-9);
    assert.equal(f.sourceCamera.timeSinceMoved, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    f.state.frameNumber++; f.p.updateSourceTiles(f.state);
    assert.equal(f.sourceCamera.positionWCDeltaMagnitude, 0);
    assert.ok(f.sourceCamera.timeSinceMoved > 0, 'native clock advances while stationary');
    const stationaryTime = f.sourceCamera.timeSinceMoved;
    f.state.frameNumber++; f.p.updateSourceTiles(f.state);
    assert.ok(f.sourceCamera.timeSinceMoved >= stationaryTime);
    assert.equal(f.sourceCalls(), 4);
    assert.equal(f.observerCalls(), 0);
    assert.equal(f.observerCamera.timeSinceMoved, observerTime);
    assert.ok(Cesium.Cartesian3.equals(f.observerCamera.position, originalObserverPosition));
    const diagnostics = f.p.getDiagnosticState();
    assert.equal(diagnostics.depth.sourceCameraMotion.nativeBookkeepingAvailable, true);
    assert.equal(diagnostics.depth.sourceCameraMotion.lastUpdatedFrameNumber, 4);
    assert.equal(diagnostics.depth.sourceCameraMotion.positionDeltaMeters, 0);
    assert.equal(diagnostics.depth.sourceCameraMotion.timeSinceMovedSeconds, f.sourceCamera.timeSinceMoved);
    assert.equal(f.sourceCalls(), 4, 'reading diagnostics does not advance motion');
    return { calls: f.sourceCalls(), observerCalls: f.observerCalls(), nativeStationarySeconds: stationaryTime, diagnostic: diagnostics.depth.sourceCameraMotion };
  });
  await test('Unsupported native API safely retains conservative requests/processing behavior', () => {
    const f = fixture(), target = settledTarget();
    f.sourceCamera._updateCameraChanged = undefined;
    f.targets.push(target);
    target._requestedTiles = [{}]; f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, false);
    target._requestedTiles = []; target._statistics.numberOfTilesProcessing = 1;
    f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, false);
    target._statistics.numberOfTilesProcessing = 0; f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, true);
    assert.equal(f.sourceCalls(), 0); assert.equal(f.observerCalls(), 0);
    const motion = f.p.getDiagnosticState().depth.sourceCameraMotion;
    assert.equal(motion.nativeBookkeepingAvailable, false);
    assert.equal(motion.lastUpdatedFrameNumber, null);
    assert.equal(motion.timeSinceMovedSeconds, null);
    assert.equal(motion.positionDeltaMeters, null);
    return motion;
  });
  await test('Native errors propagate and do not leave coverage marked ready', () => {
    const f = fixture(); let visits = 0;
    f.targets.push(settledTarget(() => { visits++; }));
    f.sourceCamera._updateCameraChanged = () => { throw new Error('native bookkeeping failure'); };
    f.p.sourceCoverageReady = true;
    assert.throws(() => f.p.updateSourceTiles(f.state), /native bookkeeping failure/);
    assert.equal(f.p.sourceCoverageReady, false); assert.equal(visits, 0);
    assert.equal(f.p.lastSourceCameraMotionFrame, -1);
    return { errorSwallowed: false, tilesVisitedAfterFailure: visits };
  });
  await test('Native API never bypasses unsettled or unavailable source requests', () => {
    const f = fixture(), target = settledTarget(); f.targets.push(target);
    for (const [requested, pending, processing] of [[1,0,0],[0,1,0],[0,0,1]]) {
      target._requestedTiles = Array(requested).fill({});
      target._statistics = { numberOfPendingRequests: pending, numberOfTilesProcessing: processing };
      f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, false);
    }
    target._requestedTiles = undefined; f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, false);
    target._requestedTiles = []; target._statistics = undefined;
    f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, false);
    target._statistics = { numberOfPendingRequests: 0, numberOfTilesProcessing: 0 };
    f.p.updateSourceTiles(f.state); assert.equal(f.p.sourceCoverageReady, true);
    assert.equal(f.sourceCalls(), 6);
    return { pendingRequestedProcessingAndUnavailableAllBlocked: true, nativeCalls: f.sourceCalls() };
  });
  await test('Current-frame, camera-revision and invalidated-depth guards remain enforced', () => {
    const f = fixture(); f.p.updateSourceTiles(f.state);
    Object.assign(f.p, { sourceCoverageReady: true, sourceCastCount: 2, lastSourceFrame: 1, cameraRevision: 3, sourceDepthCameraRevision: 3 });
    assert.equal(f.p.hasCurrentSourceDepth(), true);
    f.p.sourceDepthCameraRevision = 2; assert.equal(f.p.hasCurrentSourceDepth(), false);
    f.p.sourceDepthCameraRevision = 3; f.state.frameNumber = 2; assert.equal(f.p.hasCurrentSourceDepth(), false);
    f.state.frameNumber = 1; f.p.sourceCastCount = 0; assert.equal(f.p.hasCurrentSourceDepth(), false);
    f.p.sourceCastCount = 2; f.p.invalidateDepth(); assert.equal(f.p.hasCurrentSourceDepth(), false);
    assert.equal(f.p.cameraRevision, 4); assert.equal(f.p.sourceCastCount, 0); assert.equal(f.p.sourceCoverageReady, false);
    const settings = f.p.getDiagnosticState().settings;
    assert.equal(settings.depthToleranceMeters, 0.35);
    assert.equal(settings.texelCenterExtrapolationCapMeters, 2);
    return { staleFrameRejected: true, staleCameraRejected: true, missingCasterRejected: true, invalidationRejected: true, depthToleranceMeters: settings.depthToleranceMeters };
  });
  report.passed = true;
}
main().catch(error => { report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1; }).finally(() => {
  report.completedAt = new Date().toISOString();
  report.limitations = ['No GPU pixels, real-model loading latency, full-video registration accuracy or performance improvement is accepted by this CPU test.', 'Optional private Camera._updateCameraChanged was checked against Cesium 1.144.0 / engine 26.2; upgrades require compatibility and GPU verification.', 'The observed real-model skipLevelOfDetail=false and deferredUnloaded=0 mean the bookkeeping omission is not established as the cause of the previous 13-second loading interval.'];
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'report.log'), [report.classification, ...report.tests.map(test => 'PASS ' + test.name), ...(report.error ? [report.error] : []), JSON.stringify({ passed: report.passed, tests: report.tests.length, completedAt: report.completedAt })].join('\n') + '\n');
  console.log(JSON.stringify({ passed: report.passed, tests: report.tests.length, output }));
});
