import { DepthFunction, PolylineColorAppearance } from "cesium";
import type { CadImportEntity } from "./cadImport";

/** Keep CAD hairlines legible at fractional zoom and device pixel ratios. */
export function cadLineWidth(entity: CadImportEntity): number {
  const weight = Number.isFinite(entity.lineweightMm) ? entity.lineweightMm! : 0.25;
  return Math.max(1.5, Math.min(10, weight * 5));
}

/**
 * A five-millimetre eye-depth tolerance resolves coplanar surface flicker.
 * It affects rasterization only: source vertices, bounds and collision geometry
 * keep their original coordinates. Depth testing still hides lines behind models
 * or below terrain. Depth-buffer picking shares this small display tolerance;
 * analytic CAD coordinates do not. A fixed log-depth offset would grow with distance.
 */
export function createCadPolylineAppearance(): PolylineColorAppearance {
  return new PolylineColorAppearance({
    translucent: false,
    renderState: { depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL } },
    fragmentShaderSource: `
in vec4 v_color;
void main() {
    out_FragColor = czm_gammaCorrect(v_color);
#ifdef LOG_DEPTH
    czm_writeLogDepth(max(1.0, v_depthFromNearPlusOne - 0.005));
#elif (__VERSION__ == 300 || defined(GL_EXT_frag_depth))
    vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord);
    eye /= eye.w;
    eye.z = min(-czm_currentFrustum.x, eye.z + 0.005);
    vec4 clip = czm_projection * eye;
    gl_FragDepth = clamp(0.5 * (clip.z / clip.w + 1.0), 0.0, 1.0);
#endif
}`,
  });
}
