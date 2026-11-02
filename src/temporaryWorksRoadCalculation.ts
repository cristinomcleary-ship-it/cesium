import {
  buildRoadMeshChunks, projectRoad, roadReferenceInside, refinePlanningCoverage, signedVolumes, type PlanXY, type PlanningMesh, type PlanningTriangle,
} from "./temporaryWorksGeometry";
import { measureRoadAxis } from "./temporaryWorksRoadAxis";
import { RoadRouteConflict } from "./temporaryWorksRoadConflict";

export type RoadGradeRange = { start: number; end: number; gradePct: number };
export type RoadParameters = {
  width: number;
  hardeningDepth: number;
  treatmentDepth: number;
  /** Horizontal spread for one vertical metre; zero creates vertical structural edges. */
  slopeRatio: number;
  grades: readonly RoadGradeRange[];
  /** Optional arc/chord ratios, in the same order as the directed CAD segments. */
  stationFactors?: readonly number[];
};
export type RoadDatum = { reference: PlanXY; finishedOffset: number } & (
  { mode: 'road-start'; referenceHeight: number | null } | { mode?: undefined; referenceHeight: number }
);
export type RoadReferenceSource = 'start' | 'nearby' | 'entry' | 'specified';
type RoadReference = { referenceSource: RoadReferenceSource; referencePoint: PlanXY; referenceHeight: number; referenceStation: number };

/** If the directed CAD start misses, resolve its datum inside the same selected-model survey. */
export function roadStartDatum(start: PlanXY, sampledHeight: number | null | undefined, finishedOffset: number): RoadDatum {
  if (sampledHeight != null && !Number.isNaN(sampledHeight) && !Number.isFinite(sampledHeight))
    throw new Error('模型返回无效高程，请核对瓦片后重试。');
  if (!Number.isFinite(finishedOffset)) throw new Error('请输入便道顶相对标高（米）。');
  return { mode:'road-start', reference:start, referenceHeight:Number.isFinite(sampledHeight) ? sampledHeight! : null, finishedOffset };
}
type RoadPart = "core" | "slope";
export type RoadVertex = PlanXY & {
  roadStation: number; roadOffset: number; roadPart: RoadPart;
  surfaceHeight: number; baseHeight: number; formationHeight: number; groundHeight: number;
};

export function roadLength(input: readonly PlanXY[], stationFactors?: readonly number[]) {
  const {points, length} = measureRoadAxis(input, stationFactors);
  const first = points[0], last = points[points.length-1];
  if (Math.hypot(last.x-first.x, last.y-first.y) <= 1e-7) throw new Error("请选择具有不同起终点的开放便道中心线");
  return length;
}

export function validateRoadGrades(grades: readonly RoadGradeRange[], length: number): RoadGradeRange[] {
  if (!Number.isFinite(length) || length <= 0) throw new Error("请先读取有效中心线长度");
  if (!grades.length) throw new Error("请填写覆盖全长的里程纵坡段，平坡段填写 0%");
  // Accept millimetre-rounded values from the mileage editor, and use the actual end station.
  const tolerance = 0.001 + Math.max(1,length) * Number.EPSILON * 4;
  let next = 0;
  return grades.map((entry,i) => {
    if (!entry || ![entry.start,entry.end,entry.gradePct].every(Number.isFinite))
      throw new Error(`第 ${i+1} 段起止里程和纵坡必须是有效数值`);
    if (Math.abs(entry.start-next) > tolerance)
      throw new Error(i ? `第 ${i+1} 段与上一段里程不连续，不能留空或重叠` : "首段须从 0 m 开始");
    const final = i === grades.length-1;
    if (final && Math.abs(entry.end-length) > tolerance) throw new Error("末段终点里程须等于完整中心线长度");
    const end = final ? length : entry.end;
    if (!(entry.end > entry.start) || !(end > next) || end > length || !final && end === length)
      throw new Error(`第 ${i+1} 段起止里程须沿选定方向递增且位于中心线范围内`);
    const range = { start: next, end, gradePct: entry.gradePct };
    next = end;
    return range;
  });
}

/** Continuous vertical alignment. Prefix elevations make repeated station lookups logarithmic. */
function makeVerticalAlignment(grades: readonly RoadGradeRange[]) {
  let rise = 0;
  const origins = grades.map(g => {
    const start = rise;
    rise += (g.end-g.start) * g.gradePct / 100;
    if (!Number.isFinite(rise)) throw new Error("分段纵坡累计高差超出范围");
    return start;
  });
  return (s: number) => {
    let lo = 0, hi = grades.length-1;
    while (lo < hi) {
      const mid = (lo+hi) >>> 1;
      if (s <= grades[mid].end) hi=mid; else lo=mid+1;
    }
    return origins[lo] + (s-grades[lo].start) * grades[lo].gradePct / 100;
  };
}

export type RoadSampleBatch = { phase: "initial" | "refine" | "datum"; chunk:number; completed:number; offset:number; total:number };
export type RoadSampler = (points: readonly PlanXY[], batch: RoadSampleBatch) => Promise<readonly (number | null | undefined)[]>;

/** The sampler can target Cesium in a separate realm. Bound every request and validate completeness before integrating. */
async function sampleBatches(points: readonly PlanXY[], phase: RoadSampleBatch["phase"], sample: RoadSampler, chunk:number, completed:number, signal?: AbortSignal) {
  const result: (number | null)[] = [];
  for (let offset = 0; offset < points.length; offset += 512) {
    signal?.throwIfAborted();
    const batch = points.slice(offset, offset + 512);
    const values = await sample(batch, { phase, chunk, completed:completed+offset, offset, total:points.length });
    signal?.throwIfAborted();
    if (values.length !== batch.length) throw new Error("便道模型采样返回数量不符，请重新计算。");
    for (const value of values) {
      // Older sampler adapters use NaN to represent a ray that missed the model.
      if (value == null || Number.isNaN(value)) result.push(null);
      else if (Number.isFinite(value)) result.push(value);
      else throw new Error("模型返回无效高程，请核对瓦片后重试。");
    }
  }
  return result;
}

// Probe only for a vertical reference. These off-axis measurements never enter the road mesh or quantities.
async function nearbyRoadStart(start: PlanXY, width: number, sample: RoadSampler, signal?: AbortSignal): Promise<RoadReference | undefined> {
  const limit = Math.min(10,width/2);
  const probes:PlanXY[] = [];
  for (const radius of [...[0.25,0.5,1,2,4,8].filter(r => r < limit), limit]) {
    for (let direction=0; direction<16; direction++) {
      const angle = direction*Math.PI/8;
      probes.push({x:start.x+radius*Math.cos(angle), y:start.y+radius*Math.sin(angle)});
    }
  }
  const heights = await sampleBatches(probes,'datum',sample,0,0,signal);
  const nearest = heights.findIndex(h => h !== null);
  if (nearest < 0) return undefined;
  return {referenceSource:'nearby', referencePoint:probes[nearest], referenceHeight:heights[nearest]!, referenceStation:0};
}

/** Pick an actual measurement on the first drawable pavement triangle, with ties closest to the centreline. */
function roadEntryReference(mesh: PlanningMesh, ground: readonly (number | null | undefined)[], halfWidth: number): RoadReference {
  const coordinates = mesh.roadFrame!.coordinates;
  let best = -1, bestStation = Infinity, bestOffset = Infinity;
  for (const face of mesh.triangles) {
    if (face.some(i => !Number.isFinite(ground[i]))) continue;
    // Shoulder breaklines bound every pavement triangle.
    if (face.some(i => (coordinates[i].absoluteOffset ?? Math.abs(coordinates[i].offset)) > halfWidth+1e-7)) continue;
    for (const i of face) {
      const {station, offset, absoluteOffset} = coordinates[i], lateral = absoluteOffset ?? Math.abs(offset);
      if (station < bestStation || (station === bestStation && lateral < bestOffset)) {
        best=i; bestStation=station; bestOffset=lateral;
      }
    }
  }
  if (best < 0) throw new Error('便道在所选倾斜摄影模型上没有形成有效路面网格。请核对中心线定位、模型覆盖和采样间距。');
  return {referenceSource:'entry', referencePoint:mesh.points[best], referenceHeight:ground[best]!, referenceStation:bestStation};
}

/** Compute the designed structure and the independently measured cut/fill to its treatment base.
 * The sloping material boundary is fixed by the section dimensions; it is not a temporary excavation slope.
 */
export async function calculateRoad(
  input: readonly PlanXY[], parameters: RoadParameters, datum: RoadDatum, spacing: number,
  sample: RoadSampler, signal?: AbortSignal,
) {
  const { width, hardeningDepth, treatmentDepth, slopeRatio } = parameters;
  if (![width,hardeningDepth,treatmentDepth,slopeRatio].every(Number.isFinite) ||
      width <= 0 || hardeningDepth < 0 || treatmentDepth < 0 || slopeRatio < 0)
    throw new Error("路面宽度须大于零，硬化深度、地基处理深度和边坡水平比须为非负数");
  if (![datum.reference?.x,datum.reference?.y,datum.finishedOffset].every(Number.isFinite) ||
      !(datum.mode==='road-start' && datum.referenceHeight===null) && !Number.isFinite(datum.referenceHeight))
    throw new Error("便道相对标高的基准点或高程无效");
  const { points, stationFactors, length } = measureRoadAxis(input, parameters.stationFactors);
  const grades = validateRoadGrades(parameters.grades, length);
  const rise = makeVerticalAlignment(grades);
  const half = width/2, hardeningHalf = half + slopeRatio*hardeningDepth;
  const totalDepth = hardeningDepth+treatmentDepth, formationWidth = width + 2*slopeRatio*totalDepth;
  const footprint = { kind:"centerline" as const, points, width:formationWidth,
    sectionOffsets:[-hardeningHalf,-half,half,hardeningHalf], stationBreaks:grades.slice(1).map(g=>g.start), stationFactors };
  const frame:NonNullable<PlanningMesh["roadFrame"]> = {centerline:points, coordinates:[], faces:[]};
  const mesh:PlanningMesh = {points:[], roadFrame:frame, triangles:[], spacing, planArea:0};
  const ground:(number|null)[]=[], seams=new Map<string,number>();
  if (datum.mode==='road-start' && (datum.reference.x!==points[0].x || datum.reference.y!==points[0].y))
    throw new Error('高程校准点须为当前方向的便道起点 K0+000.000，请重新取样。');
  let reference:RoadReference|undefined;
  if (datum.mode==='road-start') {
    reference = datum.referenceHeight===null ? await nearbyRoadStart(points[0],width,sample,signal)
      : {referenceSource:'start', referencePoint:points[0], referenceHeight:datum.referenceHeight, referenceStation:0};
  }
  let insideStation:number|undefined, chunk=0;
  for (const section of buildRoadMeshChunks(footprint,spacing)) {
    signal?.throwIfAborted();
    chunk++;
    const local=section.roadFrame!;
    if (local.bendJoin) frame.bendJoin=local.bendJoin;
    for (const pair of local.overlapStations ?? []) {
      if (Math.abs(rise(pair[0])-rise(pair[1]))>0.001) throw new RoadRouteConflict("levels",pair);
    }
    // In a bend the reference follows the triangulated station field. An external
    // datum uses a single projection onto the complete directed CAD axis.
    if (datum.mode!=='road-start') insideStation ??= roadReferenceInside(datum.reference,section,local)?.station;
    const remap=new Uint32Array(section.points.length), start=mesh.points.length;
    for (let i=0;i<section.points.length;i++) {
      const c=local.coordinates[i], p=section.points[i];
      // Weld only common section caps. Offset/chainage distinguish the separate
      // surface charts at a real step in the overlapping footprint of a hairpin.
      if (section.seamStations?.some(s=>Math.abs(s-c.station)<=1e-7)) {
        const key=[p.x,p.y,c.station,c.offset,c.absoluteOffset??Math.abs(c.offset)].map(v=>Math.round(v*1e7)).join('/');
        const shared=seams.get(key);
        if (shared!==undefined) {remap[i]=shared; continue;}
        seams.set(key,mesh.points.length);
      }
      remap[i]=mesh.points.length;
      mesh.points.push(p); frame.coordinates.push(c);
    }
    for (const [a,b,c] of section.triangles) mesh.triangles.push([remap[a],remap[b],remap[c]]);
    mesh.planArea+=section.planArea;
    const levels=await sampleBatches(mesh.points.slice(start), "initial", sample, chunk, start, signal);
    for (const z of levels) ground.push(z);
  }
  if (!chunk) throw new Error("无法生成便道的连续设计范围。");
  let completed=ground.length;
  // Refine the combined adjacency. A mixed hit/miss triangle can split a shared
  // edge on the other side of a construction chunk, including covered neighbors.
  const mixed=ground.some(z=>z===null) && ground.some(z=>z!==null);
  const refined=mixed ? await refinePlanningCoverage(mesh,ground,async extra=>{
    const values=await sampleBatches(extra,"refine",sample,chunk,completed,signal);
    completed+=values.length;
    return values;
  },2,Infinity) : {mesh,ground,levels:0,budgetLimited:false};
  signal?.throwIfAborted();
  reference ??= datum.mode==='road-start' ? roadEntryReference(refined.mesh,refined.ground,half)
    : {referenceSource:'specified', referencePoint:datum.reference, referenceHeight:datum.referenceHeight,
       referenceStation:insideStation??projectRoad(datum.reference,points,stationFactors).station};
  const startHeight=reference.referenceHeight+datum.finishedOffset-rise(reference.referenceStation);
  const referenceDistance=Math.hypot(reference.referencePoint.x-points[0].x,reference.referencePoint.y-points[0].y);
  const { points: xy, roadFrame } = refined.mesh;
  const vertices: RoadVertex[] = [], triangles: PlanningTriangle[] = [];
  const partIndices = { core: new Map<number,number>(), slope: new Map<number,number>() };
  const coordinates = roadFrame!.coordinates;
  let coveredArea = 0, pavementArea = 0, coveredPavementArea = 0, cutVolume = 0, fillVolume = 0;
  let hardeningVolume = 0, treatmentVolume = 0;

  function vertex(i: number, roadPart: RoadPart) {
    const indices = partIndices[roadPart], known = indices.get(i);
    if (known !== undefined) return known;
    const c = coordinates[i], height = startHeight+rise(c.station);
    const formationHeight = height-totalDepth;
    const radial = c.absoluteOffset ?? Math.abs(c.offset);
    const outside = Math.max(0,radial-half);
    const drop = slopeRatio > 0 ? Math.min(totalDepth,outside/slopeRatio) : 0;
    const surfaceHeight = height-drop, baseHeight = Math.min(height-hardeningDepth, surfaceHeight);
    if (![surfaceHeight,baseHeight,formationHeight].every(Number.isFinite)) throw new Error("便道设计高程超出范围");
    const out = vertices.length;
    vertices.push({ ...xy[i], roadStation:c.station, roadOffset:c.offset < 0 ? -radial : radial, roadPart,
      surfaceHeight, baseHeight, formationHeight, groundHeight:refined.ground[i]! });
    indices.set(i,out);
    return out;
  }
  let facesProcessed=0;
  const runsOnPage=typeof document!=="undefined";
  for (const t of refined.mesh.triangles) {
    if (runsOnPage && ++facesProcessed%4096===0) {
      await new Promise<void>(resume=>setTimeout(resume,0));
      signal?.throwIfAborted();
    }
    const [a,b,c] = t.map(i=>xy[i]);
    const area = Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;
    // Seeded shoulder and layer breaklines ensure no triangle straddles two section bands.
    const absoluteOffset = t.reduce((sum,i)=>sum+(coordinates[i].absoluteOffset ?? Math.abs(coordinates[i].offset)),0)/3;
    const part: RoadPart = absoluteOffset <= half ? "core" : "slope";
    if (part === "core") pavementArea += area;
    if (t.some(i=>!Number.isFinite(refined.ground[i]))) continue;
    const face: PlanningTriangle = [vertex(t[0],part),vertex(t[1],part),vertex(t[2],part)];
    triangles.push(face);
    coveredArea += area;
    if (part === "core") coveredPavementArea += area;
    const v = face.map(i=>vertices[i]);
    const [cut,fill] = signedVolumes(area, v.map(p=>p.groundHeight-p.formationHeight));
    cutVolume += cut; fillVolume += fill;
    hardeningVolume += area/3 * v.reduce((sum,p)=>sum+p.surfaceHeight-p.baseHeight,0);
    treatmentVolume += area/3 * v.reduce((sum,p)=>sum+p.baseHeight-p.formationHeight,0);
  }
  return { vertices, triangles, length, ...reference, referenceDistance, bendJoin:frame.bendJoin, pavementArea, coveredPavementArea, slopeArea:coveredArea-coveredPavementArea,
    hardeningBottomWidth:2*hardeningHalf, formationWidth, hardeningVolume, treatmentVolume,
    planArea:mesh.planArea, coveredArea, excludedArea:Math.max(0,mesh.planArea-coveredArea), cutVolume, fillVolume,
    sampleCount:xy.length, refinementLevels:refined.levels, budgetLimited:refined.budgetLimited };
}

export type RoadResult = Awaited<ReturnType<typeof calculateRoad>>;
