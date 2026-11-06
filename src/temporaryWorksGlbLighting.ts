import { Cartesian3, type Model } from 'cesium';

/** Local presentation lighting: never changes the viewer's sun, exposure or other models. */
export function temporaryWorksGlbLightingOptions() {
  return {
    // Cesium's default SunLight intensity is 2.0. Keep directional shading with a modest lift.
    lightColor: new Cartesian3(2.4, 2.4, 2.4),
    // Brighten the model's own dynamic specular environment, including metal roofs.
    // Do not change gamma/saturation or multiply the material's base colour.
    environmentMapOptions: { brightness: 1.35 },
  };
}

export function applyTemporaryWorksGlbAmbientFill(model: Pick<Model, 'imageBasedLighting'>) {
  // Reuse the IBL created and owned by Model. Passing an external IBL to fromGltfAsync
  // transfers destruction responsibility to the application (Cesium engine 26.2.0).
  // The constant SH term supplies neutral fill in dark/shadowed facades; directional
  // sunlight and the dynamic specular map retain shape, roughness and metal reflections.
  // Cesium's default fallback constant is 0.35449; 0.5 is a moderate local lift.
  model.imageBasedLighting.sphericalHarmonicCoefficients = [
    new Cartesian3(0.5, 0.5, 0.5),
    ...Array.from({ length: 8 }, () => new Cartesian3()),
  ];
}
