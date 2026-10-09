import type { CameraIntrinsics } from './videoArCamera.ts';

export type VideoTextureQuality = 'economy' | 'clear' | 'inspection';
export type TextureDimensions = Readonly<{width:number;height:number}>;
export type TextureQualityPlan = Readonly<{
  mode:VideoTextureQuality; source:TextureDimensions|null; planned:TextureDimensions|null;
  limits:Readonly<{maximumTextureSize:number|null;transitionBudgetBytes:number}>;
  downshiftReasons:readonly string[]; estimatedTransitionBytes:number|null;
  pixelConvention:'image-boundary-normalized-UV';
}>;
export const TEXTURE_TRANSITION_BUDGET_BYTES=64*1024*1024;
export function isTextureQuality(value:unknown):value is VideoTextureQuality{return value==='economy'||value==='clear'||value==='inspection';}
/** Limits account for old+new RGBA textures during an atomic replacement; no upscaling. */
export function planVideoTexture(mode:VideoTextureQuality,width:number,height:number,paused:boolean,maximumTextureSize:number|null,budgetBytes=TEXTURE_TRANSITION_BUDGET_BYTES):TextureQualityPlan{
  if(!isTextureQuality(mode))throw new Error('未知视频画质档');
  const source=Number.isInteger(width)&&width>0&&Number.isInteger(height)&&height>0?{width,height}:null;
  const gpuLimit=maximumTextureSize!==null&&Number.isFinite(maximumTextureSize)&&maximumTextureSize>=1?Math.floor(maximumTextureSize):null;
  const budget=Number.isFinite(budgetBytes)&&budgetBytes>=8?Math.floor(budgetBytes):TEXTURE_TRANSITION_BUDGET_BYTES;
  const reasons:string[]=[];
  if(!source)return{mode,source:null,planned:null,limits:{maximumTextureSize:gpuLimit,transitionBudgetBytes:budget},downshiftReasons:[],estimatedTransitionBytes:null,pixelConvention:'image-boundary-normalized-UV'};
  const native=mode==='inspection'&&paused;
  if(mode==='inspection'&&!paused)reasons.push('暂停精查仅在暂停时使用原始分辨率；播放采用清晰档');
  let edge=native?Math.max(width,height):mode==='economy'?1024:1920;
  if(gpuLimit===null){edge=Math.min(edge,1024);reasons.push('无法核验GPU纹理上限，保守限制长边1024');}
  else if(edge>gpuLimit){edge=gpuLimit;reasons.push('受GPU最大纹理尺寸限制');}
  let scale=Math.min(1,edge/Math.max(width,height));
  const memoryScale=Math.sqrt(budget/(width*height*8));
  if(memoryScale<scale){scale=memoryScale;reasons.push('受纹理原子替换64MiB默认预算或配置预算限制');}
  const planned={width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
  if(!native&&Math.max(width,height)<edge)reasons.push('原始素材分辨率低于所选画质；不放大伪造细节');
  return{mode,source,planned,limits:{maximumTextureSize:gpuLimit,transitionBudgetBytes:budget},downshiftReasons:reasons,estimatedTransitionBytes:planned.width*planned.height*8,pixelConvention:'image-boundary-normalized-UV'};
}
/** Existing shader uses (fx*x+cx)/width, with boundaries 0..width (no new half-pixel offset). */
export function scaleTextureIntrinsics(k:CameraIntrinsics,width:number,height:number):CameraIntrinsics{
  if(![k.width,k.height,width,height].every(v=>Number.isFinite(v)&&v>0))throw new Error('相机或纹理画幅无效');
  const x=width/k.width,y=height/k.height;
  return{width,height,fx:k.fx*x,fy:k.fy*y,cx:k.cx*x,cy:k.cy*y};
}
