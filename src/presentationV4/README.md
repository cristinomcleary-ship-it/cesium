# V4 presentation integration

The three runtime JavaScript modules were supplied in
`Cesium_Platform_Design_v4/runtime/`. They operate on the application's existing
Cesium 1.144.0 Viewer and the verified, already loaded project photogrammetry.
They load no demo asset and create no business geometry.

`../safetyScenePresentation.ts` is the host adapter. It validates the registered
asset and effective transform, calls `installPresentation`, routes manual theme
changes without moving the camera, and restores original materials and the full
model for authoring. CAD annotation visibility keeps its existing restoration
logic. Runtime `allowMaterialReplacement` is never enabled by this adapter;
existing material or clipping owners produce a reported conflict.

`projectDisplayConfiguration.ts` is the separate display extent and camera
calibration. Its ECEF boundary and sampled upper-edge heights are not spatial
ledger records. Neither clipping nor the independent sidewalls/bottom changes
the tileset transform or a saved user point.

Adaptations to the supplied runtime:

- `homeOnInstall: false` allows model-layer reinstalls to keep the current camera.
  Formal entry and the home button explicitly call the calibrated `home` method.
- `home.rangeMeters` supports a measured camera distance with the existing
  heading/pitch/padding contract.
- `externalClock` and `setEffectsTime` use the existing application's single
  decoration clock; no second `postUpdate` listener or animation loop is added.
- The ellipsoid is passed to `ClippingPolygon`, as required by the locked Cesium
  API. Owned clipping is disabled before detachment/destruction.
- Owned objects and detailed geometry/status evidence are available to the host
  for exclusion from sampling and for verification.

`../safetyPresentationRuntime.test.ts` checks ownership refusal, original-state
restoration, camera/coordinate preservation, and repeated resource cleanup with
the installed Cesium classes. These CPU checks do not establish that the actual
project mesh is visible; project screenshots and rotation recordings are the
separate required visual evidence.


Actual-project compatibility findings:

- The installed Cesium model vertex stage computes `v_positionWC` with `czm_model`.
  Polygon clipping consumes those world positions and spherical coordinates;
  this path expects ECEF, not B3DM local coordinates. No inverse model transform
  or change to the engineering transform is introduced here.
- Early project captures showed incomplete interior texture before mesh/texture
  loading had stabilized. Later steady project renders showed the complete
  interior with native clipping. Those earlier frames do not establish an engine
  clipping defect or a vertex-count cause; there is no shader-clipping fallback.
  Final visual verification must wait for loaded, stable textured project meshes.
- `displayEnvelope.clippingPositions` now supplies the compact planar ring to
  native clipping, while `positions` retains all sampled heights for sidewalls,
  bottom and edge geometry. Both rings must be simple, and bidirectional plan
  deviation must stay within one metre. This tolerance only checks display
  configuration consistency and is not an engineering or safety criterion.
- `home.target` offsets only the overview camera's look-at point. It is validated
  as finite ECEF and does not move the envelope, model or saved user geometry.
