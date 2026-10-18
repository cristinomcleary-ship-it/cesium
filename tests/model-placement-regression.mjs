import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BoundingSphere, Cartesian2, Cartesian3, Matrix4, Ray, ScreenSpaceEventType, Transforms } from "cesium";

const directory = await mkdtemp(path.join(process.cwd(), ".model-placement-regression-"));
try {
  await build({ entryPoints: ["src/modelPlacement.ts", "src/modelEditor.ts"], outdir: directory, bundle: true, platform: "node", format: "esm", packages: "external", outExtension: { ".js": ".mjs" } });
  const placement = await import(pathToFileURL(path.join(directory, "modelPlacement.mjs")));
  const { ModelEditor } = await import(pathToFileURL(path.join(directory, "modelEditor.mjs")));
  const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
  const closePoint = (a, b) => { close(a.x, b.x); close(a.y, b.y); close(a.z, b.z); };
  const glb = (json) => {
    const text = new TextEncoder().encode(JSON.stringify(json));
    const length = Math.ceil(text.length / 4) * 4;
    const data = new ArrayBuffer(20 + length);
    const view = new DataView(data);
    for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, data.byteLength], [12, length], [16, 0x4e4f534a]]) view.setUint32(offset, value, true);
    new Uint8Array(data, 20).fill(32);
    new Uint8Array(data, 20, text.length).set(text);
    return data;
  };
  const fixture = {
    scenes: [{ nodes: [0] }], nodes: [{ translation: [10000, 20, 30000], children: [1] }, { mesh: 0, scale: [2, 3, 4] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ min: [-2, 0, -4], max: [2, 10, 4] }],
  };
  const bounds = placement.readGlbPlacementBounds(glb(fixture));
  assert.ok(bounds);
  // Cesium's default correction maps glTF (x,y,z) to local (z,x,y).
  closePoint(bounds.minimum, new Cartesian3(29984, 9996, 20));
  closePoint(bounds.maximum, new Cartesian3(30016, 10004, 50));
  assert.equal(placement.readGlbPlacementBounds(new ArrayBuffer(5)), null);
  assert.equal(placement.readGlbPlacementBounds(glb({ ...fixture, nodes: [{ children: [0] }] })), null, "cycles are rejected");
  assert.equal(placement.readGlbPlacementBounds(glb({ ...fixture, accessors: [{}] })), null, "partial bounds never silently re-anchor geometry");
  const binary = glb(fixture);
  const nativeBounds = await placement.fetchGlbPlacementBounds(new Blob([binary]));
  closePoint(nativeBounds.minimum, bounds.minimum);
  const originalFetch = globalThis.fetch;
  let streamCancelled = false;
  let streamReads = 0;
  const prefixBytes = new Uint8Array(binary.slice(0));
  new DataView(prefixBytes.buffer).setUint32(8, 1_000_000_000, true);
  const chunks = [prefixBytes.slice(0, 7), prefixBytes.slice(7, 23), prefixBytes.slice(23), new Uint8Array(64)];
  globalThis.fetch = async () => ({ ok: true, body: { getReader: () => ({
    read: async () => { streamReads++; return { done: false, value: chunks.shift() }; },
    cancel: async () => { streamCancelled = true; }, releaseLock() {},
  }) } });
  try {
    const streamed = await placement.fetchGlbPlacementBounds("/__models/test.glb");
    closePoint(streamed.minimum, bounds.minimum);
    assert.equal(streamReads, 3, "only the JSON prefix is consumed, not the declared 1 GB binary payload");
    assert.equal(streamCancelled, true, "remaining mesh/texture response is cancelled");
  } finally { globalThis.fetch = originalFetch; }
  const metadataAbort = new AbortController(); metadataAbort.abort();
  await assert.rejects(placement.fetchGlbPlacementBounds(new Blob([binary]), { signal: metadataAbort.signal }), { name: "AbortError" });
  const before = Cartesian3.fromDegrees(121.4, 31.2, 200);
  const target = Cartesian3.fromDegrees(121.45, 31.23, 5);
  const sourceMatrix = Transforms.eastNorthUpToFixedFrame(before);
  const model = { modelMatrix: sourceMatrix, scale: 2, boundingSphere: new BoundingSphere(Matrix4.multiplyByPoint(sourceMatrix, new Cartesian3(60000, 20000, 70), new Cartesian3()), 100) };
  const matrix = placement.createAnchoredModelMatrix(model, target, Math.PI / 3, bounds);
  closePoint(Matrix4.multiplyByPoint(matrix, new Cartesian3(60000, 20000, 40), new Cartesian3()), target);
  const fallback = placement.createAnchoredModelMatrix(model, target);
  closePoint(Matrix4.multiplyByPoint(fallback, new Cartesian3(60000, 20000, 70), new Cartesian3()), target);
  assert.throws(() => placement.createAnchoredModelMatrix(model, Cartesian3.ZERO), /位置无效/);

  class Surface extends EventTarget {
    style = { cursor: "grab" };
    clientWidth = 1000;
    clientHeight = 800;
    disableRootEvents = true;
    listenerCount = 0;
    addEventListener(...args) { this.listenerCount++; super.addEventListener(...args); }
    removeEventListener(...args) { this.listenerCount--; super.removeEventListener(...args); }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
  }
  globalThis.window = new Surface();
  globalThis.document = new Surface();
  const canvas = new Surface();
  let pickPosition = target;
  const viewer = {
    isDestroyed: () => false, canvas,
    scene: { canvas, pickPositionSupported: true, pickPosition: () => pickPosition, globe: { pick: () => undefined }, screenSpaceCameraController: { enableInputs: false }, requestRender() {}, pick: () => undefined },
    camera: { getPickRay: () => undefined, pickEllipsoid: () => undefined, positionCartographic: { longitude: 2, latitude: 0.5, height: 100 } },
  };
  const mouse = (type, x = 10, y = 10) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0 });
    canvas.dispatchEvent(event);
  };
  const abort = new AbortController();
  const cancelled = placement.beginPickPlacement(viewer, { signal: abort.signal });
  assert.equal(canvas.style.cursor, "crosshair");
  abort.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(canvas.style.cursor, "grab");
  assert.equal(canvas.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  let invalidPicks = 0;
  const pending = placement.beginPickPlacement(viewer, { onInvalidPick: () => invalidPicks++ });
  pickPosition = undefined;
  mouse("mousedown"); mouse("mouseup");
  assert.equal(invalidPicks, 1, "sky click keeps the placement operation active");
  pickPosition = target;
  mouse("mousedown"); mouse("mouseup");
  closePoint(await pending, target);
  assert.equal(canvas.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  const escaped = placement.beginPickPlacement(viewer);
  const esc = new Event("keydown", { cancelable: true }); Object.assign(esc, { key: "Escape" }); window.dispatchEvent(esc);
  await assert.rejects(escaped, { name: "AbortError" });
  assert.equal(canvas.listenerCount, 0);

  let changed = 0;
  const editor = new ModelEditor(viewer, () => changed++);
  const entity = { modelMatrix: sourceMatrix, boundingSphere: new BoundingSphere(before, 5), isDestroyed: () => false, silhouetteSize: 0 };
  editor.add("a", "test", entity);
  assert.equal(editor.setTransform({ east: 10, north: -20, up: 3, heading: 0.4 }), true);
  const centerAfter = Matrix4.multiplyByPoint(entity.modelMatrix, Cartesian3.ZERO, new Cartesian3());
  closePoint(centerAfter, Matrix4.multiplyByPoint(sourceMatrix, new Cartesian3(10, -20, 3), new Cartesian3()));
  assert.equal(editor.setTransform({ up: NaN }), false);
  close(editor.getSelected().up, 3);
  editor.handler.getInputAction(ScreenSpaceEventType.LEFT_UP)();
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false, "unowned mouse-up cannot unlock another tool");
  viewer.scene.pick = () => ({ id: { engineeringModelId: "a" } });
  const localRay = (point) => new Ray(Matrix4.multiplyByPoint(sourceMatrix, point, new Cartesian3()), Matrix4.multiplyByPointAsVector(sourceMatrix, new Cartesian3(0, 0, -1), new Cartesian3()));
  // View rotated 90 degrees: moving screen-right means local north, not east.
  viewer.camera.getPickRay = (screen) => localRay(new Cartesian3(0, screen.x, 100));
  viewer.scene.screenSpaceCameraController.enableInputs = true;
  editor.handler.getInputAction(ScreenSpaceEventType.LEFT_DOWN)({ position: new Cartesian2(0, 0) });
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  editor.handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE)({ endPosition: new Cartesian2(5, 0) });
  close(editor.getSelected().east, 10); close(editor.getSelected().north, -15);
  window.dispatchEvent(new Event("mouseup"));
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
  viewer.scene.screenSpaceCameraController.enableInputs = false;
  editor.handler.getInputAction(ScreenSpaceEventType.LEFT_DOWN)({ position: new Cartesian2(0, 0) });
  const resume = editor.suspendInteractions();
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false, "pre-existing camera lock is preserved");
  resume(); resume();
  assert.ok(changed > 2);
  assert.equal(editor.relocate("a", matrix, target), true);
  close(editor.getSelected().east, 0);
  editor.remove("a");
  assert.equal(editor.getSelected(), null);
  editor.destroy(); editor.destroy();
  assert.equal(canvas.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  console.log("PASS: GLB geometry anchoring; bounded streamed/Blob metadata; offset/scale/rotation; map click/sky/Escape/abort cleanup; numeric translation; rotated-view dragging; camera lock ownership and teardown.");
} finally { await rm(directory, { recursive: true, force: true }); }
