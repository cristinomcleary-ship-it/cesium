import {
  Cartesian2, Cartesian3, CustomShader, CustomShaderMode, CustomShaderTranslucencyMode,
  LightingModel, Matrix4, ShadowMode, Transforms, UniformType, type Model,
} from 'cesium';

export const TEMPORARY_WORKS_BRIGHTNESS_MIN = 50;
export const TEMPORARY_WORKS_BRIGHTNESS_MAX = 200;
export const TEMPORARY_WORKS_BRIGHTNESS_DEFAULT = 100;

export function clampTemporaryWorksBrightness(value: number): number {
  if (!Number.isFinite(value)) throw new Error('临建模型亮度须为有效数值。');
  return Math.min(TEMPORARY_WORKS_BRIGHTNESS_MAX, Math.max(TEMPORARY_WORKS_BRIGHTNESS_MIN, value));
}

// Keep PBR enabled: Cesium's material stage then resolves BOTH metallic/roughness
// and KHR_materials_pbrSpecularGlossiness, including diffuse textures and alpha.
// An UNLIT override would bypass the latter workflow and lose the steel shed's
// real diffuse colour. This stage changes illumination, never vertex positions,
// material alpha, texture coordinates, or the material's normal map.
const PRESENTATION_FRAGMENT = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 diffuse = material.diffuse;
    vec3 reflected = material.specular;
    vec3 colour = diffuse * 0.85 + reflected * 0.65;
    #ifdef HAS_NORMALS
        vec3 normal = normalize(material.normalEC);
        vec3 view = normalize(-fsInput.attributes.positionEC);
        vec3 key = normalize(czm_viewRotation * u_twKeyDirectionWC);
        vec3 fill = normalize(czm_viewRotation * u_twFillDirectionWC);
        // Avoid singular highlights in imported perfectly polished materials.
        // The source material and its textures remain unchanged.
        material.roughness = max(material.roughness, 0.08);
        colour += czm_pbrLighting(view, normal, key, material) * 0.9;
        colour += diffuse * (0.25 / czm_pi) * max(dot(normal, fill), 0.0);
    #endif
    colour *= mix(0.65, 1.0, clamp(material.occlusion, 0.0, 1.0));
    material.emissive = (colour + material.emissive) * u_twBrightness;
    // Cesium retains its single tone-mapping / linear-to-sRGB conversion.
    material.diffuse = vec3(0.0);
    material.specular = vec3(0.0);
    material.occlusion = 0.0;
    #ifdef USE_CLEARCOAT
        material.clearcoatFactor = 0.0;
    #endif
}
`;

/** Local presentation lighting: never changes the viewer's sun, exposure or other models. */
export function temporaryWorksGlbLightingOptions() {
  return {
    lightColor: new Cartesian3(0, 0, 0),
    environmentMapOptions: { enabled: false },
    // Time-dependent received shadows would otherwise dim the locally lit model.
    shadows: ShadowMode.DISABLED,
  };
}

export function applyTemporaryWorksGlbAmbientFill(model: Pick<Model, 'imageBasedLighting'>) {
  // Keep ownership with Model; the shader supplies a fixed neutral environment.
  model.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(0, 0);
}

/** A single shader per model; sliders update one float without rebuilding a shader or GLB. */
export function createTemporaryWorksGlbLighting(
  placement: {longitude: number; latitude: number; height: number},
  initialPercent = TEMPORARY_WORKS_BRIGHTNESS_DEFAULT,
) {
  let brightnessPercent = clampTemporaryWorksBrightness(initialPercent), destroyed = false;
  const frame = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(placement.longitude, placement.latitude, placement.height),
  );
  const direction = (x: number, y: number, z: number) => Cartesian3.normalize(
    Matrix4.multiplyByPointAsVector(frame, new Cartesian3(x, y, z), new Cartesian3()), new Cartesian3(),
  );
  const shader = new CustomShader({
    mode: CustomShaderMode.MODIFY_MATERIAL,
    lightingModel: LightingModel.PBR,
    translucencyMode: CustomShaderTranslucencyMode.INHERIT,
    uniforms: {
      u_twBrightness: { type: UniformType.FLOAT, value: brightnessPercent / 100 },
      u_twKeyDirectionWC: { type: UniformType.VEC3, value: direction(0.45, -0.55, 0.8) },
      u_twFillDirectionWC: { type: UniformType.VEC3, value: direction(-0.6, 0.25, 0.6) },
    },
    fragmentShaderText: PRESENTATION_FRAGMENT,
  });
  return {
    shader,
    get brightnessPercent() { return brightnessPercent; },
    setBrightness(percent: number) {
      if (destroyed) return false;
      const next = clampTemporaryWorksBrightness(percent);
      if (next === brightnessPercent) return false;
      brightnessPercent = next;
      shader.setUniform('u_twBrightness', next / 100);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // CustomShader is application-owned even when attached to a Cesium Model.
      if (!shader.isDestroyed()) shader.destroy();
    },
  };
}
