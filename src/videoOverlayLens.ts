import * as Cesium from 'cesium';
import { Cartesian2, Cartesian3, Cartesian4, PixelDatatype, PixelFormat, PostProcessStage, type Scene } from 'cesium';
import { undistortPixel, type CameraIntrinsics, type LensDistortion } from './videoArCamera';

/** Bounds in ideal optical right/down coordinates. Includes every sampled border ray. */
export function overlayLensBounds(k: CameraIntrinsics, lens: LensDistortion) {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= 32; i++) {
    const x = -.5 + k.width * i / 32, y = -.5 + k.height * i / 32;
    points.push(undistortPixel(k, x, -.5, lens), undistortPixel(k, x, k.height - .5, lens),
      undistortPixel(k, -.5, y, lens), undistortPixel(k, k.width - .5, y, lens));
  }
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  // Guard one render texel against edge sampling; no change to the underlying camera calibration.
  const dx = (right - left) / k.width, dy = (bottom - top) / k.height;
  return { left: left - dx, right: right + dx, top: top - dy, bottom: bottom + dy };
}

export function containVideoRect(width: number, height: number, videoWidth: number, videoHeight: number) {
  if (![width, height, videoWidth, videoHeight].every(v => Number.isFinite(v) && v > 0)) throw new Error('视频画幅无效');
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const w = videoWidth * scale, h = videoHeight * scale;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/** Cesium's OIT composite assumes an opaque map background when writing alpha.
 * Keep its weighted color/depth result, but recover source-over coverage when
 * rendering onto transparent AR. These pinned-version textures remain Cesium-owned.
 */
export function overlayTransparencyUniforms(scene: object) {
  type TextureMap = { u_opaque?: () => unknown; u_accumulation?: () => unknown; u_revealage?: () => unknown };
  const internals = scene as { _environmentState?: { useOIT?: boolean }; _context?: { defaultTexture?: unknown };
    _view?: { oit?: { _translucentMRTSupport?: boolean; _compositeCommand?: { uniformMap?: TextureMap } } } };
  const textures = () => internals._view?.oit?._compositeCommand?.uniformMap;
  const texture = (name: keyof TextureMap) => textures()?.[name]?.() ?? internals._context?.defaultTexture;
  return {
    oitMode: () => internals._environmentState?.useOIT && textures()?.u_opaque && textures()?.u_accumulation && textures()?.u_revealage
      ? internals._view?.oit?._translucentMRTSupport ? 1 : 2 : 0,
    oitOpaque: () => texture('u_opaque'), oitAccumulation: () => texture('u_accumulation'), oitRevealage: () => texture('u_revealage'),
  };
}

// A calibration is constant for the whole movie. The live render must not solve
// sixteen Newton steps for each of its millions of pixels on every video frame.
const LENS_UNIFORMS = `
uniform vec4 cameraK;
uniform vec2 imageSize;
uniform vec4 opticalBounds;
uniform vec3 radialLens;
uniform vec2 tangentLens;
`;
const LENS_INVERSE = `
vec2 distort(vec2 p) {
  float r2=dot(p,p), r4=r2*r2;
  float r=1.0+radialLens.x*r2+radialLens.y*r4+radialLens.z*r4*r2;
  float p1=tangentLens.x, p2=tangentLens.y;
  return p*r+vec2(2.0*p1*p.x*p.y+p2*(r2+2.0*p.x*p.x), p1*(r2+2.0*p.y*p.y)+2.0*p2*p.x*p.y);
}
vec2 lensCoordinates(vec2 outputUv) {
  vec2 pixel=vec2(outputUv.x,1.0-outputUv.y)*imageSize-vec2(0.5);
  vec2 target=(pixel-cameraK.zw)/cameraK.xy;
  vec2 p=target;
  bool valid=true;
  for(int i=0;i<16;i++) {
    float x=p.x,y=p.y,r2=dot(p,p),r4=r2*r2;
    float r=1.0+radialLens.x*r2+radialLens.y*r4+radialLens.z*r4*r2;
    float s=radialLens.x+2.0*radialLens.y*r2+3.0*radialLens.z*r4;
    float p1=tangentLens.x,p2=tangentLens.y;
    float a=r+2.0*x*x*s+2.0*p1*y+6.0*p2*x;
    float b=2.0*x*y*s+2.0*p1*x+2.0*p2*y;
    float d=r+2.0*y*y*s+6.0*p1*y+2.0*p2*x;
    float det=a*d-b*b;
    if(det<=0.000001) {valid=false;break;}
    vec2 err=distort(p)-target;
    // Float arithmetic stops improving below this tolerance. Preserve the final
    // 1e-5 validity check, and stop only well below a native sub-pixel residual.
    if(max(abs(err.x),abs(err.y))<=0.0000001) break;
    p-=vec2(d*err.x-b*err.y,a*err.y-b*err.x)/det;
  }
  if(!valid || length(distort(p)-target)>0.00001) return vec2(-1.0);
  return vec2((p.x-opticalBounds.x)/(opticalBounds.y-opticalBounds.x),
    1.0-(p.y-opticalBounds.z)/(opticalBounds.w-opticalBounds.z));
}
`;
const LENS_ANALYTIC = `
vec2 lensCoordinates(vec2 outputUv) {
  vec2 pixel=vec2(outputUv.x,1.0-outputUv.y)*imageSize-vec2(0.5);
  vec2 p=(pixel-cameraK.zw)/cameraK.xy;
  return vec2((p.x-opticalBounds.x)/(opticalBounds.y-opticalBounds.x),
    1.0-(p.y-opticalBounds.z)/(opticalBounds.w-opticalBounds.z));
}
`;
const LENS_COMPOSITE = `
uniform sampler2D colorTexture;
uniform float overlayOpacity;
uniform float oitMode;
uniform sampler2D oitOpaque;
uniform sampler2D oitAccumulation;
uniform sampler2D oitRevealage;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv=lensCoordinates(v_textureCoordinates);
  if(any(lessThan(uv,vec2(0.0))) || any(greaterThan(uv,vec2(1.0)))) {
    out_FragColor=vec4(0.0); return;
  }
  vec4 color=texture(colorTexture,uv);
  if (oitMode > 0.5) {
    float transmittance=oitMode < 1.5 ? texture(oitAccumulation,uv).a : texture(oitRevealage,uv).r;
    transmittance=clamp(transmittance,0.0,1.0);
    color.a=1.0-transmittance+transmittance*texture(oitOpaque,uv).a;
  }
  out_FragColor=color*overlayOpacity;
}`;

/** Compatibility shader for WebGL implementations without a float render target. */
export const OVERLAY_LENS_SHADER = LENS_UNIFORMS + LENS_INVERSE + LENS_COMPOSITE;
export const OVERLAY_LENS_ANALYTIC_SHADER = LENS_UNIFORMS + LENS_ANALYTIC + LENS_COMPOSITE;
export const OVERLAY_LENS_MAP_SHADER = LENS_UNIFORMS + LENS_INVERSE + `
in vec2 v_textureCoordinates;
uniform vec2 lensOutputSize;
void main() {
  vec2 pixel=vec2(floor(gl_FragCoord.x)*2.0, floor(gl_FragCoord.y));
  out_FragColor=vec4(lensCoordinates((pixel+vec2(0.5))/lensOutputSize),
    lensCoordinates((pixel+vec2(1.5,0.5))/lensOutputSize));
}
`;
export const OVERLAY_LENS_CACHED_SHADER = `
uniform sampler2D lensMap;
uniform vec2 lensOutputSize;
vec2 lensCoordinates(vec2 uv) {
  vec2 pixel=floor(uv*lensOutputSize);
  vec2 packedUv=vec2((floor(pixel.x/2.0)+0.5)/ceil(lensOutputSize.x/2.0), (pixel.y+0.5)/lensOutputSize.y);
  vec4 pair=texture(lensMap,packedUv);
  return mod(pixel.x,2.0)<1.0 ? pair.rg : pair.ba;
}
` + LENS_COMPOSITE;

// Isolate the renderer adapter to our pinned Cesium 1.144 / engine 26.2. Using
// Cesium's commands keeps its GL binding cache coherent; raw GL calls here would
// corrupt the following model/post-process draw.
type OwnedGlResource = { destroy(): unknown; isDestroyed(): boolean };
type LensTexture = OwnedGlResource & { width: number; height: number };
type LensCommand = { execute(context: LensContext): void; shaderProgram: OwnedGlResource };
type LensContext = {
  webgl2: boolean; colorBufferFloat: boolean; drawingBufferWidth: number; drawingBufferHeight: number;
  createViewportQuadCommand(shader: string, options: { uniformMap: Record<string, () => unknown>; framebuffer: OwnedGlResource; renderState: unknown }): LensCommand;
};
type LensRenderer = {
  Texture: new (options: { context: LensContext; width: number; height: number; pixelFormat: PixelFormat; pixelDatatype: PixelDatatype; sampler: unknown }) => LensTexture;
  Framebuffer: new (options: { context: LensContext; colorTextures: LensTexture[]; destroyAttachments: boolean }) => OwnedGlResource;
  Sampler: { NEAREST: unknown };
  RenderState: { fromCache(options: { viewport: { x: number; y: number; width: number; height: number } }): unknown };
};
type LensStageLifecycle = {
  update(context: LensContext, useLogDepth: boolean): void;
  destroy(): unknown;
};
export type VideoOverlayLensStageStats = { mode: 'analytic' | 'cached-float32' | 'adaptive'; builds: number; width: number; height: number; bytes: number; released: boolean };
const lensStatistics = new WeakMap<PostProcessStage, () => VideoOverlayLensStageStats>();
export function videoOverlayLensStageStats(stage: PostProcessStage): VideoOverlayLensStageStats | undefined { return lensStatistics.get(stage)?.(); }

/** Preserve all native pixels. A nonzero lens is solved once into a half-width RGBA32F
 * lookup (two exact float32 UV pairs per texel, 8 bytes/pixel), sampled with NEAREST so there is no quantisation or
 * interpolation drift. Resizes rebuild it; removing/disabling the stage frees it.
 * Zero-distortion video uses an exact analytic path with no lookup allocation.
 */
export function createVideoOverlayLensStage(
  scene: Scene, intrinsics: CameraIntrinsics, distortion: LensDistortion,
  uniforms: Record<string, unknown> = {}, name = `cc-video-lens-${crypto.randomUUID()}`,
): PostProcessStage {
  const k = { ...intrinsics }, d = { ...distortion }, bounds = overlayLensBounds(k, d);
  const context = (scene as unknown as { context: LensContext }).context;
  const zero = [d.k1, d.k2, d.k3, d.p1, d.p2].every(value => !value);
  const cached = !zero && !!context?.webgl2 && !!context.colorBufferFloat;
  const mode: VideoOverlayLensStageStats['mode'] = zero ? 'analytic' : cached ? 'cached-float32' : 'adaptive';
  const values: Record<string, unknown> = { cameraK: new Cartesian4(k.fx, k.fy, k.cx, k.cy), imageSize: new Cartesian2(k.width, k.height),
    opticalBounds: new Cartesian4(bounds.left, bounds.right, bounds.top, bounds.bottom), radialLens: new Cartesian3(d.k1 ?? 0, d.k2 ?? 0, d.k3 ?? 0), tangentLens: new Cartesian2(d.p1 ?? 0, d.p2 ?? 0), ...uniforms };
  let texture: LensTexture | undefined, framebuffer: OwnedGlResource | undefined, command: LensCommand | undefined, outputWidth = 0, outputHeight = 0, builds = 0, released = false;
  const release = () => {
    for (const resource of [command?.shaderProgram, framebuffer, texture]) if (resource && !resource.isDestroyed()) resource.destroy();
    command = undefined; framebuffer = undefined; texture = undefined; outputWidth = outputHeight = 0;
  };
  const ensure = (target: LensContext) => {
    const width = target.drawingBufferWidth, height = target.drawingBufferHeight;
    if (texture && outputWidth === width && outputHeight === height) return;
    release();
    const renderer = Cesium as unknown as LensRenderer;
    try {
      const lensOutputSize = new Cartesian2(width, height);
      texture = new renderer.Texture({ context: target, width: Math.ceil(width / 2), height, pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.FLOAT, sampler: renderer.Sampler.NEAREST });
      framebuffer = new renderer.Framebuffer({ context: target, colorTextures: [texture], destroyAttachments: false });
      command = target.createViewportQuadCommand(OVERLAY_LENS_MAP_SHADER, {
        uniformMap: Object.fromEntries(Object.entries({ ...values, lensOutputSize }).filter(([key]) => ['cameraK', 'imageSize', 'opticalBounds', 'radialLens', 'tangentLens', 'lensOutputSize'].includes(key)).map(([key, value]) => [key, () => value])),
        framebuffer, renderState: renderer.RenderState.fromCache({ viewport: { x: 0, y: 0, width: Math.ceil(width / 2), height } }),
      });
      command.execute(target); outputWidth = width; outputHeight = height; builds++;
      // Only the texture persists. These build-only objects are not part of the
      // playback loop and must not accumulate cached programs/framebuffers.
      command.shaderProgram.destroy(); command = undefined;
      framebuffer.destroy(); framebuffer = undefined;
    } catch (error) { release(); throw error; }
  };
  if (cached) { values.lensMap = () => texture; values.lensOutputSize = () => new Cartesian2(outputWidth, outputHeight); }
  const stage = new PostProcessStage({ name, fragmentShader: zero ? OVERLAY_LENS_ANALYTIC_SHADER : cached ? OVERLAY_LENS_CACHED_SHADER : OVERLAY_LENS_SHADER, uniforms: values });
  const lifecycle = stage as unknown as LensStageLifecycle, update = lifecycle.update, destroy = lifecycle.destroy;
  lifecycle.update = function (target, useLogDepth) {
    if (stage.enabled && cached) ensure(target); else if (!stage.enabled) release();
    update.call(stage, target, useLogDepth);
  };
  lifecycle.destroy = function () { release(); released = true; return destroy.call(stage); };
  lensStatistics.set(stage, () => ({ mode, builds, width: outputWidth, height: outputHeight, bytes: (texture?.width ?? 0) * (texture?.height ?? 0) * 16, released }));
  return stage;
}
