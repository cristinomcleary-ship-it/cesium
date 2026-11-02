import {
  ArcType, BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, HeadingPitchRange, LabelStyle, PolylineDashMaterialProperty,
  VerticalOrigin, type Cesium3DTileset, type Entity, type Viewer,
} from "cesium";
import {createPlanCoordinateFrame, createRoadCoordinateFrame, type PlanningCadCoordinates, type PlanningCadFeature,
  type PlanningCadUnit, type PlanningGeo, type PlanningPoint} from "./temporaryWorksCad";
import {withPlanningSurface, type PlanningKind} from "./temporaryWorksScene";

type Control = {cad: PlanningPoint; geo: PlanningGeo};

/** A rigid registration fixes A exactly and fits the direction A→B. Survey distances,
 * CAD chainage and design widths keep their entered units even when B has a residual. */
export function fitPlanningControls(first: Control, second: Control, unit: PlanningCadUnit,
  axisOrder: PlanningCadCoordinates["axisOrder"]) {
  const frame = createRoadCoordinateFrame({mode:"local",unit,axisOrder,referenceX:first.cad.x,referenceY:first.cad.y,
    longitude:first.geo.longitude,latitude:first.geo.latitude,rotation:0},first.cad);
  const raw = frame.cadToLocal(second.cad), site = frame.geoToLocal(second.geo);
  const drawingDistance = Math.hypot(raw.x,raw.y), modelDistance = Math.hypot(site.x,site.y);
  if (Math.min(drawingDistance, modelDistance) < 0.01)
    throw new Error("两个控制点的位置过近，请在图纸和摄影模型上各选择两个可区分的对应点。");
  const rotation = Math.atan2(raw.x*site.y-raw.y*site.x, raw.x*site.x+raw.y*site.y)*180/Math.PI;
  return {rotation, drawingDistance, modelDistance, residual:Math.abs(modelDistance-drawingDistance)};
}

export type PlanningCadPreviewInput = {
  kind: PlanningKind; feature: PlanningCadFeature; buildings?: readonly PlanningCadFeature[];
  coordinates: PlanningCadCoordinates; width?: number; reversed?: boolean;
};
type TraceRole = "axis" | "width" | "boundary" | "building";
type SurveyNode = {xy: PlanningPoint; geo: PlanningGeo; station:number; sample?:number};
type Trace = {role:TraceRole; nodes:SurveyNode[]};

const distance = (a:PlanningPoint,b:PlanningPoint) => Math.hypot(b.x-a.x,b.y-a.y);
const lerp = (a:PlanningPoint,b:PlanningPoint,t:number) => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});

/** Retain the complete drawing planimetry. Only the preview heights are interpolated
 * between survey locations; the earthwork solver makes its own independent survey. */
export function preparePlanningCadPreview(input: PlanningCadPreviewInput) {
  const {feature, kind} = input;
  if (feature.points.length < 2) throw new Error("所选 CAD 图元没有可预览的有效线段。");
  const frame = (kind === "road" ? createRoadCoordinateFrame : createPlanCoordinateFrame)(input.coordinates,feature.points[0]);
  const samples:PlanningGeo[] = [], ids = new Map<string,number>(), traces:Trace[] = [];
  function survey(xy:PlanningPoint) {
    const key=xy.x.toFixed(7)+"/"+xy.y.toFixed(7);
    let id=ids.get(key);
    if (id===undefined) {id=samples.length; samples.push(frame.localToGeo(xy)); ids.set(key,id);}
    return id;
  }
  function trace(role:TraceRole, points:PlanningPoint[], closed=false) {
    const line = closed ? [...points,points[0]] : points;
    const nodes:SurveyNode[] = [];
    let length=0;
    for(let i=1;i<line.length;i++) length+=distance(line[i-1],line[i]);
    if(length<=1e-7) return;
    // Keep the photographic preview responsive even if a long survey drawing has
    // thousands of CAD vertices. Corners remain in the visual trace at their exact XY.
    const step=Math.max(6,length/400);
    const surveyCorners=line.length<=96;
    const node=(p:PlanningPoint,station:number,measured:boolean) => {
      const sample=measured ? survey(p) : undefined;
      nodes.push({xy:p,geo:sample===undefined?frame.localToGeo(p):samples[sample],station,sample});
    };
    node(line[0],0,true);
    let station=0, next=step;
    for(let i=1;i<line.length;i++) {
      const a=line[i-1], b=line[i], len=distance(a,b);
      if(len<=1e-7) continue;
      const end=station+len;
      while(next<end-1e-7) {
        node(lerp(a,b,(next-station)/len),next,true);
        next+=step;
      }
      const measured = surveyCorners || Math.abs(end-next)<1e-7 || i===line.length-1;
      if(Math.abs(end-next)<1e-7)next+=step;
      node(b,end,measured);
      station=end;
    }
    // The last valid point may precede one or more coincident CAD vertices.
    if(nodes.at(-1)!.sample===undefined) nodes.at(-1)!.sample=survey(line.at(-1)!);
    traces.push({role,nodes});
  }
  const line=feature.points.map(frame.cadToLocal);
  if (kind==="road") {
    if(input.reversed)line.reverse();
    trace("axis",line);
    const width=input.width;
    if(width!==undefined && Number.isFinite(width) && width>0) {
      const total=line.slice(1).reduce((sum,p,i)=>sum+distance(line[i],p),0);
      const count=Math.max(1,Math.min(40,Math.ceil(total/35)));
      let at=0, tick=0;
      for(let i=1;i<line.length && tick<=count;i++) {
        const a=line[i-1], b=line[i], len=distance(a,b);
        if(len<=1e-7)continue;
        const dx=(b.y-a.y)/len*width/2, dy=-(b.x-a.x)/len*width/2;
        while(tick<=count && total*tick/count<=at+len+1e-7) {
          const c=lerp(a,b,Math.max(0,Math.min(1,(total*tick/count-at)/len)));
          // Width ticks avoid invented edges at acute bends or overlaid return legs.
          trace("width",[{x:c.x-dx,y:c.y-dy},c,{x:c.x+dx,y:c.y+dy}]);
          tick++;
        }
        at+=len;
      }
    }
  } else {
    if(!feature.closed)throw new Error("场地预览需要闭合的 CAD 边界。");
    trace("boundary",line,true);
    for(const b of input.buildings??[]) if(b.closed)trace("building",b.points.map(frame.cadToLocal),true);
  }
  // Bisect only surveyed hit/miss transitions. Use the actual CAD path between
  // the two probes, including any unsurveyed bend vertices.
  function addRoadBoundaryProbes(heights: readonly (number | null)[]) {
    if (kind !== "road") return;
    const limit = samples.length + 256;
    for (const trace of traces) {
      const nodes = trace.nodes, insertBefore = new Map<number, SurveyNode>();
      let previous = 0;
      for (let i = 1; i < nodes.length && samples.length < limit; i++) {
        const end = nodes[i];
        if (end.sample === undefined) continue;
        const left = previous, start = nodes[left];
        previous = i;
        if (end.station - start.station < 0.5 ||
            Number.isFinite(heights[start.sample!]) === Number.isFinite(heights[end.sample])) continue;
        const mid = (start.station + end.station) / 2;
        let right = left + 1;
        while (nodes[right].station < mid) right++;
        const before = nodes[right-1], after = nodes[right];
        const closest = mid - before.station < after.station - mid ? before : after;
        if (Math.abs(closest.station-mid) < 1e-7) {
          closest.sample = survey(closest.xy);
        } else {
          const t = (mid - before.station) / (after.station - before.station);
          const xy = lerp(before.xy, after.xy, t), sample = survey(xy);
          insertBefore.set(right, {xy, station:mid, geo:samples[sample], sample});
        }
      }
      if (insertBefore.size) {
        trace.nodes = [];
        for (const [i, node] of nodes.entries()) {
          const probe = insertBefore.get(i);
          if (probe) trace.nodes.push(probe);
          trace.nodes.push(node);
        }
      }
    }
  }
  return {samples,traces,addRoadBoundaryProbes};
}

type ElevatedPoint = PlanningGeo & {height:number};
type PreviewLine = {role:TraceRole; missing:boolean; points:ElevatedPoint[]};

// Display height only. Between surveyed neighbours the dashed plan trace follows
// their interpolated height. Beyond either neighbour it continues at its last
// surveyed height. For an entirely unmeasured axis, use the model's display height.
function axisDisplayHeights(nodes:readonly SurveyNode[], heights:readonly (number|null|undefined)[], fallback:number) {
  const display = new Float64Array(nodes.length);
  let last = -1, lastHeight = fallback;
  for (const [i,node] of nodes.entries()) {
    const h = node.sample === undefined ? undefined : heights[node.sample];
    if (typeof h !== "number" || !Number.isFinite(h)) continue;
    if (last < 0) display.fill(h,0,i+1);
    else {
      const span = node.station - nodes[last].station;
      for (let k=last+1; k<i; k++) {
        display[k] = lastHeight + (h-lastHeight)*(nodes[k].station-nodes[last].station)/span;
      }
      display[i] = h;
    }
    last = i;
    lastHeight = h;
  }
  display.fill(lastHeight,last+1);
  return display;
}

/** Split measured spans at every miss. The optional display reference reveals
 * the complementary, unmeasured CAD axis in the drawing overlay only. */
export function sampledPlanningCadLines(traces:readonly Trace[], heights:readonly (number|null|undefined)[], displayReference?:number) {
  const lines:PreviewLine[] = [];
  for (const {nodes,role} of traces) {
    const display = role==="axis" && displayReference!==undefined
      ? axisDisplayHeights(nodes,heights,displayReference) : undefined;
    let start = 0, run:PreviewLine|undefined;
    for (let end=1; end<nodes.length; end++) {
      const j = nodes[end].sample;
      if (j===undefined) continue;
      const h0 = heights[nodes[start].sample!], h1 = heights[j];
      const covered = typeof h0==="number" && Number.isFinite(h0) && typeof h1==="number" && Number.isFinite(h1);
      if (covered || display) {
        if (!run || run.missing!==!covered) {
          run = {role,missing:!covered,points:[]};
          lines.push(run);
        }
        const span = nodes[end].station-nodes[start].station;
        for (let k=run.points.length ? start+1 : start; k<=end; k++) {
          const height = covered ? h0+(h1-h0)*(nodes[k].station-nodes[start].station)/span : display![k];
          run.points.push({...nodes[k].geo,height});
        }
      } else run = undefined;
      start = end;
    }
  }
  return lines;
}

export async function renderPlanningCadPreview(viewer:Viewer, tileset:Cesium3DTileset, input:PlanningCadPreviewInput, signal:AbortSignal) {
  signal.throwIfAborted();
  const {traces,samples,addRoadBoundaryProbes}=preparePlanningCadPreview(input);
  const heights=await withPlanningSurface(viewer,tileset,{signal},async sample=>{
    const values=await sample(samples);
    for(let level=0;input.kind==="road" && level<2;level++){
      signal.throwIfAborted();
      const previous=samples.length;
      addRoadBoundaryProbes(values);
      if(samples.length>previous)values.push(...await sample(samples.slice(previous)));
    }
    return values;
  });
  signal.throwIfAborted();
  if(viewer.isDestroyed() || tileset.isDestroyed())throw new Error("当前摄影模型已移除，请重新预览。");
  const ellipsoid=viewer.scene.ellipsoid;
  const modelDisplayHeight=Cartographic.fromCartesian(tileset.boundingSphere.center,ellipsoid)?.height ?? 0;
  const lines=sampledPlanningCadLines(traces,heights,input.kind==="road" ? modelDisplayHeight : undefined);
  const axisLines=lines.filter(line=>line.role==="axis");
  const missingAxisLineCount=axisLines.filter(line=>line.missing).length;
  const colors:Record<TraceRole,string>={axis:"#00f0e1",width:"#fff08c",boundary:"#00f0e1",building:"#ffad55"};
  const missingColor=Color.fromCssColorString("#ff9e32");
  const missingMaterial=new PolylineDashMaterialProperty({color:missingColor,dashLength:16});
  const entities:Entity[]=[];
  const coveredCount=heights.filter(Number.isFinite).length;
  const fitPositions:Cartesian3[]=input.kind==="road" ? [] : samples.map((p,i)=>
    Cartesian3.fromDegrees(p.longitude,p.latitude,heights[i]??modelDisplayHeight,ellipsoid));
  let alive=true;
  const destroy=()=>{
    if(!alive)return;
    alive=false; signal.removeEventListener("abort",destroy);
    if(viewer.isDestroyed())return;
    for(const e of entities)viewer.entities.remove(e);
    viewer.scene.requestRender();
  };
  viewer.entities.suspendEvents();
  try {
    for (const {role,points,missing} of lines) {
      const positions=points.map(p=>Cartesian3.fromDegrees(p.longitude,p.latitude,p.height+0.18,ellipsoid));
      if (input.kind==="road") for (const position of positions) fitPositions.push(position);
      const material=missing ? missingMaterial : Color.fromCssColorString(colors[role]);
      const name=role==="axis" ? (missing ? "临建定位预览 · 中心线（未测高，仅线位）" : "临建定位预览 · 中心线（已测高）") : "临建定位预览";
      entities.push(viewer.entities.add({name,polyline:{positions,arcType:ArcType.NONE,width:role==="width"?2:3,
        material,depthFailMaterial:role==="axis"?material:undefined}}));
    }
    if (axisLines.length) {
      const axis=traces.find(t=>t.role==="axis")!;
      const ends=[
        {label:"起点", node:axis.nodes[0], display:axisLines[0].points[0], color:"#68ecac"},
        {label:"终点", node:axis.nodes.at(-1)!, display:axisLines.at(-1)!.points.at(-1)!, color:"#ffb95c"},
      ];
      for (const {label,node,display,color} of ends) {
        const measured=Number.isFinite(heights[node.sample!]);
        entities.push(viewer.entities.add({name:"临建定位预览 · "+label,
          position:Cartesian3.fromDegrees(display.longitude,display.latitude,display.height+0.25,ellipsoid),
          point:{pixelSize:7,color:measured?Color.fromCssColorString(color):missingColor,outlineColor:Color.BLACK,
            outlineWidth:1,disableDepthTestDistance:Number.POSITIVE_INFINITY},
          label:{text:measured?label:label+"（未测高）",font:"13px sans-serif",style:LabelStyle.FILL_AND_OUTLINE,outlineWidth:2,
            verticalOrigin:VerticalOrigin.BOTTOM,pixelOffset:new Cartesian2(0,-9),disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      }
    }
    signal.addEventListener("abort",destroy,{once:true});
  } catch(e){ destroy(); throw e; }
  finally {viewer.entities.resumeEvents();}
  viewer.scene.requestRender();
  const sphere=BoundingSphere.fromPoints(fitPositions);
  return {destroy,sampleCount:samples.length,coveredCount,lineCount:lines.length,
    missingAxisLineCount,coveredAxisLineCount:axisLines.length-missingAxisLineCount,
    zoom() {if(alive && !viewer.isDestroyed())viewer.camera.flyToBoundingSphere(sphere,{offset:new HeadingPitchRange(0,-0.9,Math.max(25,sphere.radius*3.1))});}};
}
