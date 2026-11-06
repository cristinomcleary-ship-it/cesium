import { buildRoadMeshChunks, MAX_PLANNING_VERTICES, type PlanXY, type PlanningTriangle } from './temporaryWorksGeometry';
import { measureRoadAxis } from './temporaryWorksRoadAxis';
import { roadLength, validateRoadGrades, type RoadGradeRange } from './temporaryWorksRoadCalculation';
import { RoadRouteConflict } from './temporaryWorksRoadConflict';
import { unpackDesignedRoad, type DesignedRoadWorkerResponse } from './temporaryWorksDesignedRoadTransfer';

export const DESIGNED_ROAD_VERSION = 'manual-top-v1' as const;
export const DESIGNED_ROAD_MAX_VERTICES = 50_000;
export const DESIGNED_ROAD_MAX_TRIANGLES = 100_000;
/** Geometry detail only. It does not request or measure photography heights. */
export const DESIGNED_ROAD_MESH_SPACING = 16;

export type DesignedRoadParameters = {
  width: number;
  hardeningDepth: number;
  treatmentDepth: number;
  slopeRatio?: number;
  stationFactors?: readonly number[];
};
export type DesignedRoadAlignment = {
  /** User-confirmed road top height, in the scene's height datum. */
  startHeight: number;
  gradesEnabled: boolean;
  /** Retained draft. Disabled draft values never affect geometry or validation. */
  grades: readonly RoadGradeRange[];
};
export type DesignedRoadVertex = PlanXY & {
  roadStation: number;
  roadOffset: number;
  roadPart: 'core';
  surfaceHeight: number;
  baseHeight: number;
  formationHeight: number;
};
export type DesignedRoadFootprint = { outer: PlanXY[]; holes: PlanXY[][] };
export type DesignedRoadResult = {
  algorithmVersion: typeof DESIGNED_ROAD_VERSION;
  vertices: DesignedRoadVertex[];
  triangles: PlanningTriangle[];
  footprintsXY: DesignedRoadFootprint[];
  length: number;
  gradesEnabled: boolean;
  grades: RoadGradeRange[];
  gradeDraft: RoadGradeRange[];
  startHeight: number;
  endHeight: number;
  planArea: number;
  coveredArea: number;
  excludedArea: 0;
  pavementArea: number;
  coveredPavementArea: number;
  formationWidth: number;
  hardeningBottomWidth: number;
  hardeningVolume: number;
  treatmentVolume: number;
  sampleCount: 0;
  refinementLevels: 0;
  budgetLimited: false;
  meshSpacing: number;
  bendJoin?: 'round-union';
};
export type DesignedRoadOptions = { signal?: AbortSignal; meshSpacing?: number };

const cross = (a: PlanXY, b: PlanXY, c: PlanXY) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function designedRoadHeightAt(station: number, startHeight: number, grades: readonly RoadGradeRange[]) {
  let height = startHeight;
  for (const grade of grades) {
    if (station <= grade.start) break;
    height += (Math.min(station, grade.end)-grade.start)*grade.gradePct/100;
    if (station <= grade.end) break;
  }
  if (!Number.isFinite(height)) throw new Error('便道设计高程超出有效范围。');
  return height;
}

function alignmentLookup(startHeight:number,grades:readonly RoadGradeRange[]) {
  let height=startHeight;
  const starts=grades.map(g=>{
    const value=height;
    height+=(g.end-g.start)*g.gradePct/100;
    if(!Number.isFinite(height))throw new Error('便道设计高程超出有效范围。');
    return value;
  });
  return (station:number)=>{
    let lo=0,hi=grades.length-1;
    while(lo<hi){const mid=(lo+hi)>>>1;if(station<=grades[mid].end)hi=mid;else lo=mid+1;}
    const height=starts[lo]+(station-grades[lo].start)*grades[lo].gradePct/100;
    if(!Number.isFinite(height))throw new Error('便道设计高程超出有效范围。');
    return height;
  };
}

/** Reverse chainage without changing the physical vertical alignment. */
export function reverseDesignedRoadAlignment(length: number, alignment: DesignedRoadAlignment): DesignedRoadAlignment {
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(alignment.startHeight))
    throw new Error('反向前请确定有效便道全长和起点顶标高。');
  const active = alignment.gradesEnabled ? validateRoadGrades(alignment.grades, length) : [];
  const reverse = (g: RoadGradeRange) => ({start:length-g.end, end:length-g.start, gradePct:-g.gradePct});
  return {
    startHeight: alignment.gradesEnabled ? designedRoadHeightAt(length, alignment.startHeight, active) : alignment.startHeight,
    gradesEnabled: alignment.gradesEnabled,
    grades: [...(alignment.gradesEnabled ? active : alignment.grades)].reverse().map(reverse),
  };
}

function signedArea(ring: readonly PlanXY[]) {
  const origin=ring[0];
  return ring.reduce((sum,p,i)=>sum+cross(origin,p,ring[(i+1)%ring.length]),0)/2;
}
function inside(p:PlanXY,ring:readonly PlanXY[]) {
  let result=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i],b=ring[j];
    if ((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) result=!result;
  }
  return result;
}

/** Remove only collinear intermediate boundary vertices, never curved corners. */
function simplifyRing(input:PlanXY[]) {
  const result:PlanXY[]=[];
  for (let i=0;i<input.length;i++) {
    const a=input[(i+input.length-1)%input.length],b=input[i],c=input[(i+1)%input.length];
    const ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y);
    if (Math.abs(cross(a,b,c)) <= 1e-8*(ab+bc) && (b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)>=0) continue;
    result.push(b);
  }
  if (result.length<3) throw new Error('便道投影边界退化，请核对中心线与宽度。');
  return result;
}

/** Extract actual exposed edges from the conforming top mesh, preserving enclosed holes. */
export function designedRoadFootprints(vertices: readonly PlanXY[], triangles: readonly PlanningTriangle[]): DesignedRoadFootprint[] {
  if (!vertices.length || !triangles.length) throw new Error('便道没有可用的投影网格。');
  const origin=vertices[0];
  const keys=vertices.map(p=>`${Math.round((p.x-origin.x)*1e7)}/${Math.round((p.y-origin.y)*1e7)}`);
  const edges=new Map<string,{a:number;b:number;count:number}>();
  for (const face of triangles) {
    const ids=cross(vertices[face[0]],vertices[face[1]],vertices[face[2]])>0 ? face : [face[0],face[2],face[1]];
    for(let i=0;i<3;i++) {
      const a=ids[i],b=ids[(i+1)%3],ka=keys[a],kb=keys[b];
      if(ka===kb) continue;
      const key=ka<kb?`${ka}:${kb}`:`${kb}:${ka}`;
      const current=edges.get(key);
      if(current) {
        if (++current.count>2 || keys[current.a]===ka) throw new Error('便道投影存在重复或非流形面，请检查路线。');
      } else edges.set(key,{a,b,count:1});
    }
  }
  const boundary=[...edges.values()].filter(e=>e.count===1);
  const outgoing=new Map<string,number[]>();
  boundary.forEach((e,i)=>{const list=outgoing.get(keys[e.a]) ?? [];list.push(i);outgoing.set(keys[e.a],list);});
  const used=new Set<number>(),rings:PlanXY[][]=[];
  for(let start=0;start<boundary.length;start++) {
    if(used.has(start)) continue;
    const ring:PlanXY[]=[],first=keys[boundary[start].a];
    let at=start;
    for(let step=0;step<=boundary.length;step++) {
      if(used.has(at)) throw new Error('便道投影边界无法连续闭合，请核对重叠区域。');
      used.add(at);
      const edge=boundary[at],point=vertices[edge.a];ring.push({x:point.x,y:point.y});
      if(keys[edge.b]===first) break;
      const choices=(outgoing.get(keys[edge.b]) ?? []).filter(i=>!used.has(i));
      if(choices.length!==1) throw new Error('便道投影边界存在分叉或断口，请核对路线及宽度。');
      at=choices[0];
      if(step===boundary.length) throw new Error('便道投影边界未闭合。');
    }
    rings.push(simplifyRing(ring));
  }
  const result:DesignedRoadFootprint[]=rings.filter(r=>signedArea(r)>0).map(outer=>({outer,holes:[]}));
  for(const hole of rings.filter(r=>signedArea(r)<0)) {
    const parents=result.filter(p=>inside(hole[0],p.outer)).sort((a,b)=>signedArea(a.outer)-signedArea(b.outer));
    if(!parents.length) throw new Error('便道孔洞未能归属实际外边界。');
    parents[0].holes.push(hole);
  }
  if(!result.length) throw new Error('便道没有有效投影外边界。');
  return result;
}

/** No terrain sampler exists in this calculation path. Heights come only from the user alignment. */
export async function calculateDesignedRoad(input:readonly PlanXY[],parameters:DesignedRoadParameters,
  alignment:DesignedRoadAlignment,{signal,meshSpacing=DESIGNED_ROAD_MESH_SPACING}:DesignedRoadOptions={}):Promise<DesignedRoadResult> {
  signal?.throwIfAborted();
  if(input.length>MAX_PLANNING_VERTICES) throw new Error(`中心线超过 ${MAX_PLANNING_VERTICES} 个顶点，请简化或分区。`);
  const {width,hardeningDepth,treatmentDepth}=parameters;
  if(![width,hardeningDepth,treatmentDepth].every(Number.isFinite) || width<=0 || hardeningDepth<0 || treatmentDepth<0)
    throw new Error('便道宽度须为正数，硬化层及处理层厚度须为非负数。');
  if((parameters.slopeRatio ?? 0)!==0) throw new Error('设计便道当前采用竖直结构边侧，请将边坡水平比设为0。');
  if(!Number.isFinite(alignment.startHeight)) throw new Error('请明确填写起点路面顶设计标高。');
  if(!Number.isFinite(meshSpacing)||meshSpacing<1||meshSpacing>100) throw new Error('便道几何间距须为1～100米，不用于摄影取高。');
  const length=roadLength(input,parameters.stationFactors);
  const {points,stationFactors}=measureRoadAxis(input,parameters.stationFactors);
  const grades=alignment.gradesEnabled ? validateRoadGrades(alignment.grades,length) : [{start:0,end:length,gradePct:0}];
  const heightAt=alignmentLookup(alignment.startHeight,grades),endHeight=heightAt(length);
  const vertices:DesignedRoadVertex[]=[],triangles:PlanningTriangle[]=[],seams=new Map<string,number>();
  const totalDepth=hardeningDepth+treatmentDepth;
  let planArea=0,bendJoin:DesignedRoadResult['bendJoin'];
  const footprint={kind:'centerline' as const,points,width,stationFactors,stationBreaks:grades.slice(1).map(g=>g.start)};
  for(const part of buildRoadMeshChunks(footprint,meshSpacing,12000)) {
    signal?.throwIfAborted();
    const frame=part.roadFrame!;
    bendJoin ??= frame.bendJoin;
    for(const pair of frame.overlapStations ?? []) {
      if(Math.abs(heightAt(pair[0])-heightAt(pair[1]))>0.001)
        throw new RoadRouteConflict('levels',pair);
    }
    if(vertices.length+part.points.length>DESIGNED_ROAD_MAX_VERTICES || triangles.length+part.triangles.length>DESIGNED_ROAD_MAX_TRIANGLES)
      throw new Error(`便道显示网格超出预算（${DESIGNED_ROAD_MAX_VERTICES} 顶点 / ${DESIGNED_ROAD_MAX_TRIANGLES} 面），请检查图纸复杂度或分区；没有生成截断道路。`);
    const remap=new Uint32Array(part.points.length);
    for(let i=0;i<part.points.length;i++) {
      const p=part.points[i],c=frame.coordinates[i];
      let key:string|undefined;
      if(part.seamStations?.some(s=>Math.abs(s-c.station)<=1e-7)) {
        key=[p.x,p.y,c.station,c.offset,c.absoluteOffset??Math.abs(c.offset)].map(v=>Math.round(v*1e7)).join('/');
        const shared=seams.get(key);
        if(shared!==undefined) {remap[i]=shared;continue;}
      }
      const surfaceHeight=heightAt(c.station);
      const baseHeight=surfaceHeight-hardeningDepth,formationHeight=surfaceHeight-totalDepth;
      if(!Number.isFinite(baseHeight)||!Number.isFinite(formationHeight)) throw new Error('便道结构层底标高超出有效范围。');
      remap[i]=vertices.length;
      if(key)seams.set(key,vertices.length);
      vertices.push({...p,roadStation:c.station,roadOffset:c.offset,roadPart:'core',surfaceHeight,baseHeight,formationHeight});
    }
    for(const t of part.triangles) {
      const ids=t.map(i=>remap[i]) as PlanningTriangle;
      const area=cross(vertices[ids[0]],vertices[ids[1]],vertices[ids[2]])/2;
      if(Math.abs(area)<1e-12)continue;
      if(area<0)[ids[1],ids[2]]=[ids[2],ids[1]];
      triangles.push(ids);
    }
    planArea+=part.planArea;
    // This also allows cancellation in the CPU fallback without delaying worker-only execution.
    if(typeof document!=='undefined') await nextTask();
  }
  signal?.throwIfAborted();
  const footprintsXY=designedRoadFootprints(vertices,triangles);
  const outlineArea=footprintsXY.reduce((sum,p)=>sum+signedArea(p.outer)+p.holes.reduce((a,h)=>a+signedArea(h),0),0);
  if(Math.abs(planArea-outlineArea)>Math.max(1e-5,planArea*1e-8)) throw new Error('便道投影面积与结构网格不一致，未应用摄影遮挡。');
  return {algorithmVersion:DESIGNED_ROAD_VERSION,vertices,triangles,footprintsXY,length,gradesEnabled:alignment.gradesEnabled,
    grades,gradeDraft:alignment.grades.map(g=>({...g})),startHeight:alignment.startHeight,endHeight,planArea,coveredArea:planArea,
    excludedArea:0,pavementArea:planArea,coveredPavementArea:planArea,formationWidth:width,hardeningBottomWidth:width,
    hardeningVolume:planArea*hardeningDepth,treatmentVolume:planArea*treatmentDepth,
    sampleCount:0,refinementLevels:0,budgetLimited:false,meshSpacing,bendJoin};
}

export async function solveDesignedRoad(points:readonly PlanXY[],parameters:DesignedRoadParameters,
  alignment:DesignedRoadAlignment,options:DesignedRoadOptions={}):Promise<DesignedRoadResult> {
  const {signal}=options;
  signal?.throwIfAborted();
  const fallback=()=>{
    // A restricted browser must not replace an unavailable worker with a large blocking task.
    // Node's pure geometry tests do not have a UI thread and are unaffected by this browser guard.
    if(typeof document!=='undefined' && (points.length>64 || roadLength(points,parameters.stationFactors)>500))
      throw new Error('当前浏览器无法运行便道后台计算。为保持场景操作流畅，请启用 Worker 支持后生成此路线。');
    return calculateDesignedRoad(points,parameters,alignment,options);
  };
  if(typeof Worker==='undefined') return fallback();
  let worker:Worker;
  try { worker=new Worker(new URL('./temporaryWorksDesignedRoad.worker.ts',import.meta.url),{type:'module',name:'designed-road'}); }
  catch(error) {
    if(error instanceof DOMException && ['NotSupportedError','SecurityError'].includes(error.name))
      return fallback();
    throw error;
  }
  let abort:(()=>void)|undefined;
  try {
    const response=await new Promise<Extract<DesignedRoadWorkerResponse,{type:'result'}>>((resolve,reject)=>{
      abort=()=>reject(signal?.reason ?? new DOMException('已取消便道计算','AbortError'));
      signal?.addEventListener('abort',abort,{once:true});
      worker.onerror=event=>reject(new Error(event.message || '设计便道后台计算失败。'));
      worker.onmessageerror=()=>reject(new Error('设计便道结果传输失败。'));
      worker.onmessage=({data}:MessageEvent<DesignedRoadWorkerResponse>)=>{
        if(data.type==='result')resolve(data);
        else reject(data.conflict ? new RoadRouteConflict(data.conflict.kind,data.conflict.stations) : new Error(data.message));
      };
      worker.postMessage({points,parameters,alignment,meshSpacing:options.meshSpacing});
    });
    return await unpackDesignedRoad(response,signal);
  } finally {
    if(abort)signal?.removeEventListener('abort',abort);
    worker.terminate();
  }
}
