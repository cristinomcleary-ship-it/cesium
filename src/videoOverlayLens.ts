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

// Output pixels follow the original distorted video. Sample the ideal geometry
// render through the inverse lens map; video itself remains untouched beneath it.
export const OVERLAY_LENS_SHADER = `
uniform sampler2D colorTexture;
uniform vec4 cameraK;
uniform vec2 imageSize;
uniform vec4 opticalBounds;
uniform vec3 radialLens;
uniform vec2 tangentLens;
uniform float overlayOpacity;
uniform float oitMode;
uniform sampler2D oitOpaque;
uniform sampler2D oitAccumulation;
uniform sampler2D oitRevealage;
in vec2 v_textureCoordinates;
vec2 distort(vec2 p) {
  float r2=dot(p,p), r4=r2*r2;
  float r=1.0+radialLens.x*r2+radialLens.y*r4+radialLens.z*r4*r2;
  float p1=tangentLens.x, p2=tangentLens.y;
  return p*r+vec2(2.0*p1*p.x*p.y+p2*(r2+2.0*p.x*p.x), p1*(r2+2.0*p.y*p.y)+2.0*p2*p.x*p.y);
}
void main() {
  vec2 pixel=vec2(v_textureCoordinates.x,1.0-v_textureCoordinates.y)*imageSize-vec2(0.5);
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
    p-=vec2(d*err.x-b*err.y,a*err.y-b*err.x)/det;
  }
  vec2 uv=vec2((p.x-opticalBounds.x)/(opticalBounds.y-opticalBounds.x),
    1.0-(p.y-opticalBounds.z)/(opticalBounds.w-opticalBounds.z));
  if(!valid || length(distort(p)-target)>0.00001 || any(lessThan(uv,vec2(0.0))) || any(greaterThan(uv,vec2(1.0)))) {
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
