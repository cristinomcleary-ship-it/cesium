import { buildRoadMeshChunks, type PlanXY, type PlanningTriangle } from './temporaryWorksGeometry';
import { measureRoadAxis } from './temporaryWorksRoadAxis';
import type { RoadSampleBatch, RoadSampler, RoadVertex } from './temporaryWorksRoadCalculation';

export type DrapedRoadParameters = {
  width: number;
  hardeningDepth: number;
  treatmentDepth: number;
  stationFactors?: readonly number[];
  stationBreaks?: readonly number[];
  /** Maximum sampled rise/run; steeper faces are left as explicit gaps. Default 1 (45°). */
  maxSlope?: number;
  /** Allowed sampled gap below the interpolated bottom, in metres. Never raises sampled vertices. */
  surfaceTolerance?: number;
  maxRefinementLevels?: number;
  /** Maximum temporary survey points in one geometric partition, not a whole-route limit. */
  maxSamples?: number;
  /** Bounds the retained display mesh independently from temporary survey probes. */
  maxOutputVertices?: number;
};

type Coordinate = { station: number; offset: number; absoluteOffset?: number };
type SurveyPoint = PlanXY & { coordinate: Coordinate; height?: number | null };
type FaceCheck = { face: PlanningTriangle; mids: PlanningTriangle; missing: boolean; steep: boolean; unresolved: boolean; deviation: number };
const NUMERIC_HEIGHT_EPSILON = 1e-5;
const pointKey = (p: PlanXY) => `${Math.round(p.x * 1e7)}/${Math.round(p.y * 1e7)}`;
const areaOf = (a: PlanXY, b: PlanXY, c: PlanXY) => Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;
const edgeKey = (a: number,b: number) => a < b ? `${a}/${b}` : `${b}/${a}`;

/** A measurement-only road surface. Legacy grade/cut-fill solvers remain unchanged.
 *
 * The bottom vertices are the selected photogrammetry measurements, never a design
 * datum or a neighbouring substitute. Centreline and transverse mesh rows retain
 * the original CAD chainage and bend union. Mid-edge and interior probes test every
 * retained face; holes, cliffs and unresolved surface breaks are excluded. Finite
 * sampling cannot certify unsampled sub-grid features, so the returned audit keeps
 * both spacing and the observed deviation. No cut/fill quantity is computed.
 */
export async function solveDrapedRoad(
  input: readonly PlanXY[], parameters: DrapedRoadParameters, spacing: number,
  sample: RoadSampler, { signal }: { signal?: AbortSignal } = {},
) {
  signal?.throwIfAborted();
  const { width, hardeningDepth, treatmentDepth } = parameters;
  const maxSlope = parameters.maxSlope ?? 1;
  const surfaceTolerance = parameters.surfaceTolerance ?? 0.02;
  const maxLevels = parameters.maxRefinementLevels ?? 3;
  const maxSamples = parameters.maxSamples ?? 500_000;
  const maxOutputVertices = parameters.maxOutputVertices ?? 1_000_000;
  if (![width,hardeningDepth,treatmentDepth,spacing,maxSlope,surfaceTolerance].every(Number.isFinite)
    || width <= 0 || hardeningDepth < 0 || treatmentDepth < 0 || spacing <= 0 || maxSlope <= 0 || surfaceTolerance < 0)
    throw new Error('贴地便道路宽和采样间距须大于零，结构厚度和表面误差须非负，最大坡率须大于零。');
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 0 || maxLevels > 6
    || !Number.isSafeInteger(maxSamples) || maxSamples < 20 || maxSamples > 2_000_000)
    throw new Error('贴地便道加密层数或采样点数上限无效。');
  if (!Number.isSafeInteger(maxOutputVertices) || maxOutputVertices < 3 || maxOutputVertices > 2_000_000)
    throw new Error('贴地便道最终展示网格点数上限无效。');
  const { points: axis, stationFactors, length } = measureRoadAxis(input, parameters.stationFactors);
  if (Math.hypot(axis[0].x-axis.at(-1)!.x,axis[0].y-axis.at(-1)!.y) <= 1e-7)
    throw new Error('请选择具有不同起终点的开放便道中心线。');
  const breaks = parameters.stationBreaks ?? [];
  if (breaks.some(s => !Number.isFinite(s) || s < 0 || s > length)) throw new Error('分段里程须位于完整中心线范围内。');
  // A coarsely entered spacing must not skip a whole carriageway cross-section.
  const sampleSpacing = Math.min(spacing,1,width/2);
  // Reserve space for midpoint/interior probes through all requested refinement levels.
  // The existing geometry generator only cuts where the complete road union separates;
  // hairpin overlaps remain one region and still receive a local capacity check below.
  const baseCapacity = Math.max(32, Math.min(12_000, Math.floor(maxSamples / (6 * 4 ** maxLevels))));
  const vertices: RoadVertex[] = [], faces: PlanningTriangle[] = [];
  let planArea = 0, sampleCount = 0, samplingBatches = 0, samplePartitions = 0, peakWorkingSamples = 0;
  let coveredArea = 0, missingTriangles = 0, steepTriangles = 0, unresolvedTriangles = 0, maxObservedDeviation = 0;
  let refinementLevels = 0, bendJoin: 'round-union' | undefined;
  // Only the preceding artificial cross-section survives between partitions. These
  // are actual sampled heights (including misses), never interpolated seam heights.
  let previousSeamHeights = new Map<string, number | null>();
  let previousSeamVertices = new Map<string, number>();
  const pause = async () => {
    if (typeof document !== 'undefined') await new Promise<void>(resolve => setTimeout(resolve, 0));
    signal?.throwIfAborted();
  };
  for (const section of buildRoadMeshChunks({kind:'centerline',points:axis,width,
    sectionOffsets:[0],stationFactors,stationBreaks:breaks},sampleSpacing,baseCapacity)) {
    signal?.throwIfAborted();
    samplePartitions++;
    const points: SurveyPoint[] = [], lookup = new Map<string,number>();
    const local = section.roadFrame!;
    bendJoin ??= local.bendJoin;
    let startStation = Infinity, endStation = -Infinity;
    for (const coordinate of local.coordinates) {
      startStation = Math.min(startStation, coordinate.station);
      endStation = Math.max(endStation, coordinate.station);
    }
    const seams = section.seamStations ?? [];
    const atStation = (station: number, target: number) => Math.abs(station - target) <= 1e-7;
    const hasStartSeam = seams.some(s => atStation(s, startStation));
    const hasEndSeam = seams.some(s => atStation(s, endStation));
    const onStart = (p: SurveyPoint) => hasStartSeam && atStation(p.coordinate.station, startStation);
    const onEnd = (p: SurveyPoint) => hasEndSeam && atStation(p.coordinate.station, endStation);
    const nextSeamHeights = new Map<string,number|null>(), nextSeamVertices = new Map<string,number>();
    const capacityError = () => new Error(`贴地便道第 ${samplePartitions} 个自动分区（桩号 ${startStation.toFixed(3)}～${endStation.toFixed(3)} m）的临时采样超过 ${maxSamples} 点；该局部区域无法在当前预算内完成。请核对图纸单位、路宽和采样间距，或缩小此处相连范围后重试。`);
    function add(point: PlanXY, coordinate: Coordinate) {
      const key = pointKey(point), known = lookup.get(key);
      if (known !== undefined) return known;
      if (points.length >= maxSamples) throw capacityError();
      const p: SurveyPoint = {...point,coordinate};
      if (onStart(p) && previousSeamHeights.has(key)) p.height = previousSeamHeights.get(key)!;
      const index = points.length;
      lookup.set(key,index); points.push(p);
      peakWorkingSamples = Math.max(peakWorkingSamples, points.length);
      return index;
    }
    async function survey(indices: readonly number[], phase: RoadSampleBatch['phase']) {
      const missing = indices.filter(i => points[i].height === undefined);
      for (let start=0;start<missing.length;start+=512) {
        signal?.throwIfAborted();
        const ids=missing.slice(start,start+512);
        const values=await sample(ids.map(i => ({x:points[i].x,y:points[i].y})),{
          phase,chunk:samplePartitions,completed:sampleCount,offset:start,total:missing.length,
        });
        signal?.throwIfAborted();
        if (values.length!==ids.length) throw new Error('便道模型采样返回数量不符，请重新生成。');
        for (let i=0;i<ids.length;i++) {
          const height=values[i], p=points[ids[i]];
          if (height == null || Number.isNaN(height)) p.height=null;
          else if (Number.isFinite(height)) p.height=height;
          else throw new Error('摄影模型返回无效高程，请核对瓦片后重试。');
          if (onEnd(p)) nextSeamHeights.set(pointKey(p),p.height);
        }
        sampleCount+=ids.length;
        samplingBatches++;
        await pause();
      }
    }
    const initial = section.points.map((p,i)=>add(p,local.coordinates[i]));
    let triangles = section.triangles.map(t=>t.map(i=>initial[i]) as PlanningTriangle);
    planArea += section.planArea;
    await survey(Array.from({length:points.length},(_,i)=>i),'initial');
    await pause();
    function average(ids: readonly number[]) {
      const ps=ids.map(i=>points[i]);
      return add({x:ps.reduce((s,p)=>s+p.x,0)/ps.length,y:ps.reduce((s,p)=>s+p.y,0)/ps.length},{
        station:ps.reduce((s,p)=>s+p.coordinate.station,0)/ps.length,
        offset:ps.reduce((s,p)=>s+p.coordinate.offset,0)/ps.length,
        absoluteOffset:ps.reduce((s,p)=>s+(p.coordinate.absoluteOffset??Math.abs(p.coordinate.offset)),0)/ps.length,
      });
    }
    const finite = (i:number) => Number.isFinite(points[i].height);
    function tooSteep(ids: readonly number[]) {
      for (let i=0;i<ids.length;i++) for (let j=i+1;j<ids.length;j++) {
        const a=points[ids[i]],b=points[ids[j]],d=Math.hypot(a.x-b.x,a.y-b.y);
        if (d>1e-7 && Math.abs(a.height!-b.height!)/d > maxSlope+1e-9) return true;
      }
      return false;
    }
    let levels=0, checks:FaceCheck[]=[];
    for (;;) {
      const probes: {face:PlanningTriangle;mids:PlanningTriangle;center:number}[]=[];
      const before=points.length;
      for (const [i,face] of triangles.entries()) {
        const [a,b,c]=face;
        probes.push({face,mids:[average([a,b]),average([b,c]),average([c,a])],center:average(face)});
        if (i && i%4096===0) await pause();
      }
      await survey(Array.from({length:points.length-before},(_,i)=>before+i),'refine');
      checks=[];
      for (const [i,{face,mids,center}] of probes.entries()) {
        const all=[...face,...mids,center];
        const missing=!all.every(finite);
        const steep=!missing && tooSteep(all);
        let deviation=0, penetration=0;
        if (!missing) {
          const z=face.map(i=>points[i].height!);
          const errors=[...mids.map((id,i)=>points[id].height!-(z[i]+z[(i+1)%3])/2),
            points[center].height!-(z[0]+z[1]+z[2])/3];
          deviation=Math.max(...errors.map(Math.abs));
          penetration=Math.max(...errors);
        }
        // No measured protrusion is concealed by a raised or interpolated bottom.
        const unresolved=!missing && (deviation>surfaceTolerance+NUMERIC_HEIGHT_EPSILON || penetration>NUMERIC_HEIGHT_EPSILON);
        checks.push({face,mids,missing,steep,unresolved,deviation});
        if (i && i%4096===0) await pause();
      }
      if (levels>=maxLevels) break;
      const edges=new Map<string,number>();
      for (const check of checks) {
        // Both sides start with the same seam edges (joinRoadSeam) and always
        // subdivide them to the same requested depth, even if only one surface
        // needs refinement. This prevents cracks/T-junctions and interior walls.
        check.face.forEach((id,i)=>{
          const next=check.face[(i+1)%3];
          if (seams.some(s=>atStation(points[id].coordinate.station,s) && atStation(points[next].coordinate.station,s)))
            edges.set(edgeKey(id,next),check.mids[i]);
        });
        if (!(check.missing||check.steep||check.unresolved)) continue;
        // All-missing interiors remain gaps; extra rays cannot invent a surface.
        if (check.face.every(i=>!finite(i)) && check.mids.every(i=>!finite(i))) continue;
        check.face.forEach((id,i)=>edges.set(edgeKey(id,check.face[(i+1)%3]),check.mids[i]));
      }
      if (!edges.size) break;
      const refined:PlanningTriangle[]=[];
      for (const [j,t] of triangles.entries()) {
        if (j && j%4096===0) await pause();
        const mids=t.map((id,i)=>edges.get(edgeKey(id,t[(i+1)%3])));
        const count=mids.filter(m=>m!==undefined).length;
        if (!count) {refined.push(t);continue;}
        if (count===3) {
          const [a,b,c]=t,[ab,bc,ca]=mids as number[];
          refined.push([a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]);
        } else {
          const i=count===1?mids.findIndex(m=>m!==undefined):(mids.findIndex(m=>m===undefined)+1)%3;
          const a=t[i],b=t[(i+1)%3],c=t[(i+2)%3],ab=mids[i]!;
          if (count===1) refined.push([a,ab,c],[ab,b,c]);
          else {const bc=mids[(i+1)%3]!;refined.push([b,bc,ab],[a,ab,c],[ab,bc,c]);}
        }
      }
      triangles=refined; levels++;
      await pause();
    }
    refinementLevels = Math.max(refinementLevels, levels);
    const remap=new Map<number,number>();
    const vertex=(i:number)=>{
      const known=remap.get(i);if(known!==undefined)return known;
      const p=points[i],height=p.height!,c=p.coordinate,key=pointKey(p);
      const previous = onStart(p) ? previousSeamVertices.get(key) : undefined;
      if (previous !== undefined) {remap.set(i,previous);return previous;}
      if (vertices.length >= maxOutputVertices)
        throw new Error(`贴地便道最终展示网格超过 ${maxOutputVertices} 个顶点；自动分区采样已启用，但完整展示网格仍过大。请核对采样间距或将结果分为独立便道方案。`);
      const index=vertices.length,radial=c.absoluteOffset??Math.abs(c.offset);
      vertices.push({x:p.x,y:p.y,roadStation:c.station,roadOffset:c.offset<0?-radial:radial,roadPart:'core',
        groundHeight:height,formationHeight:height,baseHeight:height+treatmentDepth,surfaceHeight:height+treatmentDepth+hardeningDepth});
      remap.set(i,index);
      if (onEnd(p)) nextSeamVertices.set(key,index);
      return index;
    };
    for (const [i,check] of checks.entries()) {
      if (i && i%4096===0) await pause();
      if (check.missing) {missingTriangles++;continue;}
      if (check.steep) {steepTriangles++;continue;}
      if (check.unresolved) {unresolvedTriangles++;continue;}
      faces.push(check.face.map(vertex) as PlanningTriangle);
      coveredArea+=areaOf(points[check.face[0]],points[check.face[1]],points[check.face[2]]);
      maxObservedDeviation=Math.max(maxObservedDeviation,check.deviation);
    }
    previousSeamHeights = nextSeamHeights;
    previousSeamVertices = nextSeamVertices;
    // points, lookup, checks and all discarded probes now belong only to this
    // completed partition and can be reclaimed before the next one is sampled.
    await pause();
  }
  if (!samplePartitions || !(planArea>0)) throw new Error('无法生成便道的连续范围。');
  return {
    surfaceMode:'draped' as const, vertices,triangles:faces,length,width,bendJoin,
    planArea,coveredArea,excludedArea:Math.max(0,planArea-coveredArea),pavementArea:planArea,coveredPavementArea:coveredArea,
    slopeArea:0,hardeningBottomWidth:width,formationWidth:width,
    hardeningVolume:coveredArea*hardeningDepth,treatmentVolume:coveredArea*treatmentDepth,
    sampleCount,sampleSpacing,refinementLevels,budgetLimited:false,samplingBatches,samplePartitions,peakWorkingSamples,
    missingTriangles,steepTriangles,unresolvedTriangles,maxObservedDeviation,surfaceTolerance,maxSlope,
  };
}

export type DrapedRoadResult = Awaited<ReturnType<typeof solveDrapedRoad>>;
