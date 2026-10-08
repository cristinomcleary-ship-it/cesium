import test from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { installPresentation } from "./presentationV4/install-presentation.js";
import type { DisplayEnvelope } from "./presentationV4/types.ts";

// CPU-only ownership/lifecycle tests. This fixture is never loaded by the application,
// and none of these assertions is used as evidence of project-mesh visual acceptance.
function fixture() {
  const modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  let clipping: Cesium.ClippingPolygonCollection | undefined;
  const tileset = {
    modelMatrix, customShader: undefined as Cesium.CustomShader | undefined,
    style: undefined as Cesium.Cesium3DTileStyle | undefined, clippingPlanes: undefined,
    get clippingPolygons() { return clipping; },
    set clippingPolygons(value: Cesium.ClippingPolygonCollection | undefined) {
      if (clipping !== value) clipping?.destroy(); clipping = value;
    },
    isDestroyed: () => false,
  };
  const scene = {
    mode: Cesium.SceneMode.SCENE3D, context: { webgl2: true },
    globe: { show: true, ellipsoid: Cesium.Ellipsoid.WGS84 },
    skyBox: { show: true }, skyAtmosphere: { show: true }, sun: { show: true }, moon: { show: true },
    fog: { enabled: true }, backgroundColor: Cesium.Color.BLACK,
    canvas: { clientWidth: 1920, clientHeight: 1080 },
    postRender: new Cesium.Event(), renderError: new Cesium.Event(), postUpdate: new Cesium.Event(),
    primitives: new Cesium.PrimitiveCollection(), requestRender() {}, isDestroyed: () => false,
  };
  const flights: unknown[] = [];
  const viewer = { scene, dataSources: new Cesium.DataSourceCollection(), isDestroyed: () => false,
    camera: { frustum: { fovy: Math.PI / 3 }, flyToBoundingSphere: (...args: unknown[]) => flights.push(args) } };
  const envelope: DisplayEnvelope = { id: "cpu-test-display-only", heightSource: "dataset", baseDepthMeters: 35,
    positions: [[120, 30, 24], [120.002, 30, 27], [120.002, 30.002, 30], [120, 30.002, 25]]
      .map(([x, y, z]) => Cesium.Cartesian3.fromDegrees(x, y, z)) };
  const inputs = { Cesium, viewer: viewer as unknown as Cesium.Viewer,
    tilesets: [{ id: "cpu-model", tileset: tileset as unknown as Cesium.Cesium3DTileset, contentType: "model" as const }],
    displayEnvelope: envelope, homeOnInstall: false, home: { rangeMeters: 900, duration: 0 },
    effects: { externalClock: true } };
  return { tileset, scene, viewer, flights, envelope, inputs };
}

test("V4 rejects existing material/clip ownership without overwriting or replacing it", async () => {
  for (const owner of ["customShader", "style", "clippingPolygons"] as const) {
    const f = fixture();
    const original = owner === "customShader" ? new Cesium.CustomShader({})
      : owner === "style" ? new Cesium.Cesium3DTileStyle({ color: "color('white')" })
      : new Cesium.ClippingPolygonCollection();
    Object.assign(f.tileset, { [owner]: original });
    const result = await installPresentation(f.inputs);
    assert.equal(result.ok, false); assert.equal(result.status.code, "OWNERSHIP_OR_READINESS");
    assert.equal(f.tileset[owner], original); assert.equal(f.viewer.dataSources.length, 0);
    if ("destroy" in original) original.destroy();
  }
});

test("V4 mode switches keep camera and source coordinates while restoring actual owners", async () => {
  const f = fixture();
  const geometry = JSON.stringify(f.envelope.positions);
  const matrix = Cesium.Matrix4.clone(f.tileset.modelMatrix);
  const result = await installPresentation(f.inputs);
  assert.equal(result.ok, true);
  const controller = result.controller!;
  assert.equal(f.flights.length, 0, "reinstall cannot silently move the camera");
  assert.equal(f.tileset.clippingPolygons?.inverse, true);
  assert.equal(f.viewer.dataSources.length, 1);
  assert.equal(f.scene.postUpdate.numberOfListeners, 0, "shared host clock owns decoration time");
  const firstShader = f.tileset.customShader!;
  const firstClip = f.tileset.clippingPolygons!;
  assert.equal(controller.setMode("reality").ok, true);
  assert.equal(f.tileset.customShader, undefined); assert.equal(f.tileset.clippingPolygons, undefined);
  assert.equal(firstShader.isDestroyed(), true); assert.equal(firstClip.isDestroyed(), true);
  assert.equal(f.scene.globe.show, true); assert.equal(f.flights.length, 0);
  assert.equal(controller.setMode("showcase").ok, true);
  assert.equal(f.scene.globe.show, false); assert.equal(f.flights.length, 0);
  assert.equal(controller.home({ duration: 0 }).ok, true); assert.equal(f.flights.length, 1);
  assert.equal(Cesium.Matrix4.equals(matrix, f.tileset.modelMatrix), true);
  assert.equal(JSON.stringify(f.envelope.positions), geometry);
  controller.destroy();
  assert.equal(f.scene.globe.show, true); assert.equal(f.viewer.dataSources.length, 0);
  assert.equal(f.scene.primitives.length, 0); assert.equal(f.scene.postRender.numberOfListeners, 0);
  assert.equal(f.scene.renderError.numberOfListeners, 0);
});

test("V4 repeated installation and teardown reuse exactly one owner and clean all listeners", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    const first = await installPresentation(f.inputs);
    const repeat = await installPresentation(f.inputs);
    assert.equal(first.ok, true); assert.equal(repeat.reused, true);
    assert.equal(first.controller, repeat.controller);
    assert.equal(f.viewer.dataSources.length, 1); assert.equal(f.scene.primitives.length, 1);
    assert.equal(f.scene.postRender.numberOfListeners, 1); assert.equal(f.scene.renderError.numberOfListeners, 1);
    assert.equal(f.scene.postUpdate.numberOfListeners, 0);
    first.controller!.destroy();
    assert.equal(f.viewer.dataSources.length, 0); assert.equal(f.scene.primitives.length, 0);
    assert.equal(f.scene.postRender.numberOfListeners, 0); assert.equal(f.scene.renderError.numberOfListeners, 0);
  }
});

test("V4 detects external material drift and preserves the other owner's new state", async () => {
  const f = fixture(); const result = await installPresentation(f.inputs);
  assert.equal(result.ok, true);
  const external = new Cesium.CustomShader({}); f.tileset.customShader = external;
  assert.equal(result.controller!.getStatus().ok, false);
  result.controller!.destroy();
  assert.equal(f.tileset.customShader, external); assert.equal(external.isDestroyed(), false);
  assert.equal(f.viewer.dataSources.length, 0); assert.equal(f.scene.postRender.numberOfListeners, 0);
  external.destroy();
});


test("V4 separates sampled skirt heights from equivalent clipping corners and rejects a different footprint", async () => {
  const f = fixture();
  const corners = f.envelope.positions.map(p => Cesium.Cartesian3.clone(p));
  f.envelope.positions = corners.flatMap((a, i) => Array.from({ length: 12 }, (_, j) =>
    Cesium.Cartesian3.lerp(a, corners[(i + 1) % corners.length], j / 12, new Cesium.Cartesian3())));
  f.envelope.clippingPositions = corners;
  const result = await installPresentation(f.inputs);
  assert.equal(result.ok, true);
  assert.equal(f.tileset.clippingPolygons!.get(0).length, 4);
  const evidence = result.controller!.getEvidence().scene as { sampledBoundaryVertexCount: number; clippingVertexCount: number };
  assert.equal(evidence.sampledBoundaryVertexCount, 48); assert.equal(evidence.clippingVertexCount, 4);
  result.controller!.destroy();
  f.envelope.clippingPositions = corners.map(p => Cesium.Cartesian3.add(p, new Cesium.Cartesian3(30, 0, 0), new Cesium.Cartesian3()));
  const mismatch = await installPresentation(f.inputs);
  assert.equal(mismatch.ok, false); assert.equal(mismatch.status.code, "CLIPPING_ENVELOPE_MISMATCH");
  assert.equal(f.tileset.customShader, undefined); assert.equal(f.viewer.dataSources.length, 0);
});

test("V4 overview target only changes camera framing and rejects invalid world targets", async () => {
  const f = fixture(); const result = await installPresentation(f.inputs);
  assert.equal(result.ok, true);
  const before = JSON.stringify(f.envelope);
  const target = Cesium.Cartesian3.fromDegrees(120.001, 30.001, 40);
  assert.equal(result.controller!.home({ target, duration: 0 }).ok, true);
  const last = f.flights.at(-1) as [Cesium.BoundingSphere, unknown];
  assert.equal(Cesium.Cartesian3.equals(last[0].center, target), true);
  assert.equal(JSON.stringify(f.envelope), before);
  assert.equal(result.controller!.home({ target: { x: NaN, y: 0, z: 0 } }).ok, false);
  assert.equal(f.flights.length, 1);
  result.controller!.destroy();
});


test("V5 grading inherits source lighting and creates five bounded edge/base entities", async () => {
  const f = fixture();
  const result = await installPresentation({ ...f.inputs, palette: { saturation: 0.72, blueGrayMix: 0.24,
    outlineWidth: 1.6, outlineGlowWidth: 3.8, outlineGlowOpacity: 0.14 } });
  assert.equal(result.ok, true);
  assert.equal(f.tileset.customShader!.lightingModel, undefined, "each asset keeps its PBR/UNLIT lighting");
  assert.equal(f.tileset.customShader!.uniforms.u_saturation.value, 0.72);
  const entities = f.viewer.dataSources.get(0).entities.values;
  assert.equal(entities.length, 5);
  const bySuffix = (suffix: string) => entities.find(e => e.id.endsWith(":" + suffix))!;
  assert.equal(bySuffix("top-edge").polyline!.width!.getValue(), 1.6);
  assert.equal(bySuffix("top-halo").polyline!.width!.getValue(), 3.8);
  const halo = bySuffix("top-halo").polyline!.material!.getValue(Cesium.JulianDate.now());
  assert.equal(halo.color.alpha, 0.14);
  assert.equal(bySuffix("top-edge").polyline!.material!.getType(Cesium.JulianDate.now()), "Color");
  const evidence = result.controller!.getEvidence().scene as { lightingModel: string; materialColorStrategy: string };
  assert.equal(evidence.lightingModel, "inherited");
  assert.equal(evidence.materialColorStrategy, "source-texture-with-blue-gray-grade");
  result.controller!.destroy();
  assert.equal(f.viewer.dataSources.length, 0); assert.equal(f.tileset.customShader, undefined);
});

test("V5 palette is part of installation ownership and invalid grading allocates no resources", async () => {
  const f = fixture(), palette = { blueGrayMix: 0.24 };
  const first = await installPresentation({ ...f.inputs, palette });
  const originalShader = f.tileset.customShader;
  assert.equal(first.ok, true);
  const conflict = await installPresentation({ ...f.inputs, palette: { blueGrayMix: 0.30 } });
  assert.equal(conflict.ok, false); assert.equal(conflict.status.code, "INSTALLATION_EXISTS");
  assert.equal(f.tileset.customShader, originalShader);
  first.controller!.destroy();
  const invalid = await installPresentation({ ...f.inputs, palette: { blueGrayMix: 1 } });
  assert.equal(invalid.ok, false); assert.equal(invalid.status.code, "INVALID_PALETTE");
  assert.equal(f.viewer.dataSources.length, 0); assert.equal(f.scene.primitives.length, 0);
  assert.equal(f.tileset.customShader, undefined);
});
