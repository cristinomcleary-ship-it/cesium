import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BoundingSphere, Cartesian2, Cartesian3, EntityCollection, KeyboardEventModifier, Matrix4, Ray, ScreenSpaceEventType, Transforms } from "cesium";

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
    isDestroyed: () => false, canvas, entities: new EntityCollection(),
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
  let transformChanges = 0;
  const editor = new ModelEditor(viewer, (_item, _mode, _editing, transformChanged) => { changed++; if (transformChanged) transformChanges++; });
  let editorPickCalls = 0;
  viewer.scene.pick = () => { editorPickCalls++; return undefined; };
  const dragStart = () => editor.handler.getInputAction(ScreenSpaceEventType.LEFT_DOWN)({ position: new Cartesian2(0, 0) });
  for (let index = 0; index < 25; index++) dragStart();
  assert.equal(editorPickCalls, 0, "ordinary map navigation with no models must not trigger GPU picking");
  const entity = { modelMatrix: sourceMatrix, boundingSphere: new BoundingSphere(before, 5), isDestroyed: () => false, silhouetteSize: 0 };
  editor.add("a", "test", entity);
  assert.equal(editor.isEditing, false, "loading/restoring a model never unlocks its position");
  for (let index = 0; index < 25; index++) dragStart();
  assert.equal(editorPickCalls, 0, "ordinary map navigation with loaded models also avoids GPU picking");
  assert.equal(editor.setTransform({ east: 10 }), false, "hidden numeric controls cannot change a non-edited model");
  assert.equal(editor.beginEditing("a"), true);
  assert.equal(editor.isEditing, true);
  assert.equal(transformChanges, 0, "starting editing does not invalidate an AR cache or write the resource");
  assert.equal(editor.setTransform({ east: 10, north: -20, up: 3, heading: 0.4 }), true);
  const centerAfter = Matrix4.multiplyByPoint(entity.modelMatrix, Cartesian3.ZERO, new Cartesian3());
  closePoint(centerAfter, Matrix4.multiplyByPoint(sourceMatrix, new Cartesian3(10, -20, 3), new Cartesian3()));
  assert.equal(editor.setTransform({ up: NaN }), false);
  close(editor.getSelected().up, 3);
  editor.handler.getInputAction(ScreenSpaceEventType.LEFT_UP)();
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false, "unowned mouse-up cannot unlock another tool");
  viewer.scene.pick = () => { editorPickCalls++; return { id: { engineeringModelId: "a" } }; };
  const localRay = (point) => new Ray(Matrix4.multiplyByPoint(sourceMatrix, point, new Cartesian3()), Matrix4.multiplyByPointAsVector(sourceMatrix, new Cartesian3(0, 0, -1), new Cartesian3()));
  // View rotated 90 degrees: moving screen-right means local north, not east.
  viewer.camera.getPickRay = (screen) => localRay(new Cartesian3(0, screen.x, 100));
  viewer.scene.screenSpaceCameraController.enableInputs = true;
  editor.select(null);
  dragStart();
  assert.equal(editorPickCalls, 0, "a normal map click cannot start an edit session");
  assert.equal(editor.getSelected(), null);
  editor.beginEditing("a");
  dragStart();
  assert.equal(editorPickCalls, 1, "an explicitly edited model needs only one pick per drag");
  assert.equal(editor.getSelected().id, "a");
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  editor.handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE)({ endPosition: new Cartesian2(5, 0) });
  close(editor.getSelected().east, 10); close(editor.getSelected().north, -15);
  window.dispatchEvent(new Event("mouseup"));
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
  viewer.scene.screenSpaceCameraController.enableInputs = false;
  editor.handler.getInputAction(ScreenSpaceEventType.LEFT_DOWN)({ position: new Cartesian2(0, 0) });
  const resume = editor.suspendInteractions();
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false, "pre-existing camera lock is preserved");
  assert.equal(editor.isEditing, false);
  resume(); resume();
  assert.equal(editor.isEditing, true);
  const changesBeforeRotateMode = transformChanges;
  editor.setMode("rotate");
  assert.equal(transformChanges, changesBeforeRotateMode, "changing tool mode does not mutate model data");
  assert.equal(viewer.entities.values.length, 3, "rotation exposes center, axis and horizontal circle");
  const pivot = editor.getRotationCenter();
  closePoint(pivot, Matrix4.multiplyByPoint(sourceMatrix, new Cartesian3(10, -15, 3), new Cartesian3()));
  closePoint(viewer.entities.values[0].position.getValue(), pivot);
  const guideIds = viewer.entities.values.map(e => e.id);
  const headingBeforeDrag = editor.getSelected().heading;
  dragStart();
  editor.handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE)({ endPosition: new Cartesian2(20, 0) });
  close(editor.getSelected().heading - headingBeforeDrag, -10 * Math.PI / 180);
  // Shift can start midway through an existing drag without a discontinuity.
  editor.handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE, KeyboardEventModifier.SHIFT)({ endPosition: new Cartesian2(40, 0) });
  close(editor.getSelected().heading - headingBeforeDrag, -11 * Math.PI / 180);
  editor.handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE)({ endPosition: new Cartesian2(60, 0) });
  close(editor.getSelected().heading - headingBeforeDrag, -21 * Math.PI / 180);
  editor.handler.getInputAction(ScreenSpaceEventType.LEFT_UP, KeyboardEventModifier.SHIFT)();
  assert.deepEqual(viewer.entities.values.map(e => e.id), guideIds, "heading-only rotation reuses guide entities");
  closePoint(editor.getRotationCenter(), pivot);
  closePoint(Matrix4.multiplyByPoint(entity.modelMatrix, Cartesian3.ZERO, new Cartesian3()), pivot);
  assert.equal(editor.rotateByDegrees(0.1), true);
  close(editor.getSelected().heading - headingBeforeDrag, -20.9 * Math.PI / 180);
  const suspendOne = editor.suspendInteractions();
  const suspendTwo = editor.suspendInteractions();
  assert.equal(viewer.entities.values.length, 0, "AR/other tools do not render rotation guides");
  assert.equal(entity.silhouetteSize, 0);
  assert.equal(editor.rotateByDegrees(1), false, "suspended editing blocks numerical adjustments too");
  suspendOne(); assert.equal(editor.isEditing, false);
  suspendTwo(); assert.equal(editor.isEditing, true);
  assert.equal(viewer.entities.values.length, 3);
  const staleResume = editor.suspendInteractions();
  editor.endEditing(); staleResume();
  assert.equal(editor.isEditing, false, "a stale resume cannot reactivate a finished edit");
  assert.equal(viewer.entities.values.length, 0);
  assert.equal(entity.silhouetteSize, 0);
  editor.beginEditing("a");
  assert.ok(changed > 2);
  assert.equal(editor.relocate("a", matrix, target), true);
  close(editor.getSelected().east, 0);
  editor.remove("a");
  assert.equal(editor.getSelected(), null);
  assert.equal(viewer.entities.values.length, 0);
  // A model's authored origin can be far from its geometric center (common in
  // imported SKP files). Guides must identify the latter editing pivot.
  const offCenterLocal = new Cartesian3(300, -120, 24);
  const offCenterWorld = Matrix4.multiplyByPoint(sourceMatrix, offCenterLocal, new Cartesian3());
  const offsetEntity = { modelMatrix: Matrix4.clone(sourceMatrix), boundingSphere: new BoundingSphere(offCenterWorld, 40), isDestroyed: () => false, silhouetteSize: 0 };
  editor.add("offset", "off-center SKP", offsetEntity);
  editor.beginEditing("offset");
  editor.setTransform({ east: 14, north: -3, up: 9, heading: Math.PI / 2 });
  const offsetPivot = editor.getRotationCenter();
  closePoint(Matrix4.multiplyByPoint(offsetEntity.modelMatrix, offCenterLocal, new Cartesian3()), offsetPivot);
  assert.ok(Cartesian3.distance(Matrix4.getTranslation(offsetEntity.modelMatrix, new Cartesian3()), offsetPivot) > 300,
    "the visible pivot is not incorrectly inferred from modelMatrix translation");
  closePoint(viewer.entities.values[0].position.getValue(), offsetPivot);
  const axis = viewer.entities.values[1].polyline.positions.getValue();
  const axisDirection = Cartesian3.normalize(Cartesian3.subtract(axis[1], axis[0], new Cartesian3()), new Cartesian3());
  const expectedAxis = Matrix4.multiplyByPointAsVector(Transforms.eastNorthUpToFixedFrame(offCenterWorld), Cartesian3.UNIT_Z, new Cartesian3());
  closePoint(axisDirection, expectedAxis);
  // Clicking a different loaded model cannot silently retarget the session.
  viewer.scene.pick = () => { editorPickCalls++; return { id: { engineeringModelId: "other" } }; };
  const offsetBefore = Matrix4.clone(offsetEntity.modelMatrix);
  dragStart(); editor.handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE)({ endPosition: new Cartesian2(100, 0) });
  assert.equal(editor.getSelected().id, "offset");
  assert.deepEqual(offsetEntity.modelMatrix, offsetBefore);
  editor.remove("offset");
  const picksBeforeEmptyNavigation = editorPickCalls;
  for (let index = 0; index < 25; index++) dragStart();
  assert.equal(editorPickCalls, picksBeforeEmptyNavigation, "removing the last model restores navigation without GPU picking");
  editor.destroy(); editor.destroy();
  assert.equal(canvas.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  console.log("PASS: GLB geometry anchoring; bounded streamed/Blob metadata; offset/scale/rotation; map click/sky/Escape/abort cleanup; explicit edit sessions and zero idle GPU picks; rotated-view dragging; numerical translation; real-pivot guides; Shift precision; nested suspension and stale resume; camera lock ownership and teardown.");
} finally { await rm(directory, { recursive: true, force: true }); }
