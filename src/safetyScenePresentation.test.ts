import test from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { SafetyScenePresentation } from "./safetyScenePresentation.ts";
import envelope from "./presentationV4/production2-display-envelope.json";
import type { RegisteredPhotogrammetry } from "./safetyModelSurfacePicker.ts";
import type { SafetyDataset, SafetyState, SafetyView } from "./safetyTypes.ts";

// CPU lifecycle checks of the actual adapter/runtime, with only Viewer/WebGL mocked.
// The deferred datasource attachment makes layer/version changes happen while install awaits.
// These are not evidence of visual acceptance of the real engineering mesh.
function makeModel(): RegisteredPhotogrammetry {
  let clipping: Cesium.ClippingPolygonCollection | undefined;
  const matrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  const tileset = {
    modelMatrix: matrix, show: true, tilesLoaded: true,
    customShader: undefined as Cesium.CustomShader | undefined,
    style: undefined as Cesium.Cesium3DTileStyle | undefined, clippingPlanes: undefined,
    get clippingPolygons() { return clipping; },
    set clippingPolygons(value: Cesium.ClippingPolygonCollection | undefined) {
      if (clipping !== value) clipping?.destroy(); clipping = value;
    },
    isDestroyed: () => false,
  } as unknown as Cesium.Cesium3DTileset;
  return { tileset, assetId: envelope.assetId, assetVersion: envelope.assetVersion,
    coordinateTransformVersion: envelope.coordinateTransformVersion, projectId: "cpu-project",
    name: "CPU lifecycle model", url: "", kind: "photogrammetry", capabilitySource: "project-verified",
    matrix: Cesium.Matrix4.toArray(matrix), coordinateOffsets: { longitude: 0, latitude: 0, height: 0 } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function fixture(blockAttachment = true) {
  const model = makeModel();
  const registry = { models: [model] };
  const canvas = { clientWidth: 1920, clientHeight: 1080 };
  const scene = {
    mode: Cesium.SceneMode.SCENE3D, context: { webgl2: true }, canvas,
    globe: { show: true, ellipsoid: Cesium.Ellipsoid.WGS84 },
    skyBox: { show: true }, skyAtmosphere: { show: true }, sun: { show: true }, moon: { show: true },
    fog: { enabled: true }, backgroundColor: Cesium.Color.BLACK,
    postRender: new Cesium.Event(), renderError: new Cesium.Event(), postUpdate: new Cesium.Event(),
    primitives: new Cesium.PrimitiveCollection(), requestRender() {}, isDestroyed: () => false,
  };
  const dataSources = new Cesium.DataSourceCollection();
  const add = dataSources.add.bind(dataSources);
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  dataSources.add = dataSource => blockAttachment ? gate.then(() => add(dataSource)) : add(dataSource);
  const flights: unknown[] = [];
  const viewer = { scene, canvas, dataSources, isDestroyed: () => false,
    camera: { frustum: { fovy: Math.PI / 3 }, flyToBoundingSphere: (...args: unknown[]) => flights.push(args) } };
  const dataset = { projectId: "cpu-project" } as SafetyDataset;
  const state = { selectedId: dataset.projectId, mode: "presentation", layers: { effects: true } } as SafetyState;
  const view = { selected: { id: dataset.projectId } } as SafetyView;
  const presentation = new SafetyScenePresentation(viewer as unknown as Cesium.Viewer,
    { getPresentationModels: () => registry.models }, () => []);
  const update = () => presentation.update(dataset, state, view, true);
  const release = () => { blockAttachment = false; unblock(); };
  const status = () => presentation.debugStats().status as { state: string; mode?: string };
  const clean = () => {
    presentation.dispose();
    assert.equal(dataSources.length, 0); assert.equal(scene.primitives.length, 0);
    assert.equal(scene.postRender.numberOfListeners, 0); assert.equal(scene.renderError.numberOfListeners, 0);
    assert.equal(scene.postUpdate.numberOfListeners, 0); assert.equal(scene.globe.show, true);
  };
  return { model, registry, viewer, scene, dataSources, flights, presentation, update, release, status, clean };
}

test("adapter invalidates a hidden model's pending install and reopens it without replaying old home", async () => {
  const f = fixture();
  try {
    f.update(); f.presentation.home(0); await settle();
    assert.equal(f.presentation.debugStats().installationPending, true);
    f.model.tileset.show = false; f.update();
    assert.equal(f.presentation.debugStats().pendingHome, null);
    assert.equal(f.presentation.debugStats().stage, null);
    assert.equal(f.status().state, "waiting-for-project-model");
    // Reopening before the previous install finishes must wait for its owner to release.
    f.model.tileset.show = true; f.update();
    f.release(); await settle();
    assert.equal(f.presentation.debugStats().styled, true);
    assert.equal(f.presentation.debugStats().installationPending, false);
    assert.equal(f.dataSources.length, 1); assert.equal(f.scene.primitives.length, 1);
    assert.equal(f.scene.postRender.numberOfListeners, 1); assert.equal(f.flights.length, 0);
    assert.equal(f.presentation.home(0), true); assert.equal(f.flights.length, 1);
  } finally { f.release(); await settle(); f.clean(); }
});

test("adapter rejects stale completion even before an update observes visibility, removal, version or instance changes", async t => {
  for (const change of ["visibility", "removal", "asset-version", "transform-version", "instance"] as const) {
    await t.test(change, async () => {
      const f = fixture();
      try {
        f.update(); f.presentation.home(0); await settle();
        if (change === "visibility") f.model.tileset.show = false;
        if (change === "removal") f.registry.models = [];
        if (change === "asset-version") f.model.assetVersion = "unregistered-revision";
        if (change === "transform-version") f.model.coordinateTransformVersion = "unregistered-transform";
        if (change === "instance") f.registry.models = [makeModel()];
        // No update/tick: the completion itself must re-read the registry and visibility.
        f.release(); await settle();
        assert.equal(f.model.tileset.customShader, undefined);
        assert.equal(f.model.tileset.clippingPolygons, undefined);
        assert.equal(f.presentation.debugStats().pendingHome, null);
        assert.equal(f.flights.length, 0);
        if (change === "instance") {
          assert.equal(f.presentation.debugStats().styled, true);
          assert.ok(f.registry.models[0].tileset.customShader);
          assert.equal(f.dataSources.length, 1);
        } else {
          assert.equal(f.dataSources.length, 0); assert.equal(f.scene.primitives.length, 0);
          assert.equal(f.scene.globe.show, true); assert.equal(f.status().mode, "reality");
          assert.equal(f.presentation.debugStats().stage, null);
        }
      } finally { f.release(); await settle(); f.clean(); }
    });
  }
});

test("adapter releases old material, clipping, base and framing when replacement lacks display calibration", async () => {
  const f = fixture(false);
  try {
    f.update(); await settle();
    assert.equal(f.presentation.debugStats().styled, true);
    const oldShader = f.model.tileset.customShader!;
    const oldClip = f.model.tileset.clippingPolygons!;
    const replacement = makeModel(); replacement.assetVersion = "unregistered-revision";
    f.registry.models = [replacement]; f.update();
    assert.equal(f.model.tileset.customShader, undefined); assert.equal(f.model.tileset.clippingPolygons, undefined);
    assert.equal(oldShader.isDestroyed(), true); assert.equal(oldClip.isDestroyed(), true);
    assert.equal(replacement.tileset.customShader, undefined); assert.equal(replacement.tileset.clippingPolygons, undefined);
    assert.equal(f.dataSources.length, 0); assert.equal(f.scene.primitives.length, 0);
    assert.equal(f.scene.globe.show, true); assert.equal(f.presentation.frame(), undefined);
    assert.equal(f.presentation.debugStats().stage, null);
    assert.equal(f.status().state, "waiting-for-display-calibration"); assert.equal(f.status().mode, "reality");
    f.registry.models = [f.model]; f.update(); await settle();
    assert.equal(f.presentation.debugStats().styled, true); assert.equal(f.flights.length, 0);
  } finally { f.clean(); }
});

test("adapter still executes a valid initial overview once, while a later cancelHome supersedes it", async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    try {
      f.update(); f.presentation.home(0); await settle();
      if (cancel) f.presentation.cancelHome();
      f.release(); await settle();
      assert.equal(f.presentation.debugStats().styled, true);
      assert.equal(f.flights.length, cancel ? 0 : 1);
      assert.equal(f.presentation.debugStats().pendingHome, null);
    } finally { f.release(); await settle(); f.clean(); }
  }
});
