import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4 } from 'cesium';
import { designedRoadFootprints } from './temporaryWorksDesignedRoad';
import { getTemporaryWorksGlbModelMatrix, type TemporaryWorksGlbManifest, type TemporaryWorksGlbPlacement, type TemporaryWorksGlbResource } from './temporaryWorksGlb';
import { HARDENING_LIMITS, type HardeningBlocker, type HardeningParameters, type HardeningResult } from './temporaryWorksHardening';
import { hardeningGeoFromLocal, hardeningLocalFromGeo, type HardeningGeoPoint, type HardeningReference } from './temporaryWorksHardeningEditorGeometry';
import { surfaceBoundsIntersect, type SurfaceCompositionBounds } from './temporaryWorksSurfaceComposition';
import type { HardeningEditorValue, HardeningFacilityExclusion } from './temporaryWorksHardeningEditor';
import type { TemporaryWorksPlan } from './temporaryWorksPanel';
import type { TemporaryWorksFootprint } from './temporaryWorksClipping';
import type { PlanningVertex } from './temporaryWorksScene';
import type { TemporaryWorksSurfaceSide } from './temporaryWorksSurfaceScene';

export type HardeningFacilityBinding = {
  placement: TemporaryWorksGlbPlacement;
  resourceVersion: string;
  /** Explicitly confirmed floor height, not the roof height or model bounding box. */
  floorHeight: number;
  floorThickness: number;
};
export type HardeningSavedConfig = HardeningEditorValue & {
  version: 1;
  priority: number;
  facilityBindings?: Record<string, HardeningFacilityBinding>;
  acceptedDependencies?: Record<string, string>;
};
type SurfacePlan = Omit<TemporaryWorksPlan, 'hardening'> & { hardening?: HardeningSavedConfig };

function geoBounds(points:readonly HardeningGeoPoint[]):SurfaceCompositionBounds|undefined {
  if(!points.length)return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of points) {
    if(!Number.isFinite(p.longitude)||!Number.isFinite(p.latitude))throw new Error('地面范围包含无效经纬度。');
    minX=Math.min(minX,p.longitude);minY=Math.min(minY,p.latitude);maxX=Math.max(maxX,p.longitude);maxY=Math.max(maxY,p.latitude);
  }
  return {minX,minY,maxX,maxY};
}
const assetFor=(plan:SurfacePlan,manifest?:TemporaryWorksGlbManifest)=>manifest?.assets.find(a=>a.id===plan.glb?.resourceId);
const copyPlacement=(p:TemporaryWorksGlbPlacement):TemporaryWorksGlbPlacement=>({...p,dimensions:{...p.dimensions}});
const allFootprintPoints=(footprints:readonly TemporaryWorksFootprint[])=>footprints.flatMap(f=>[...f.outer,...(f.holes??[]).flat()]);

/** Bounds are only candidate filters. They are never converted into a clipping or floor polygon. */
export function surfacePlanBounds(plan:SurfacePlan,manifest?:TemporaryWorksGlbManifest):SurfaceCompositionBounds|undefined {
  if(plan.hardening)return geoBounds(plan.hardening.boundary);
  if(plan.surface)return geoBounds(allFootprintPoints(plan.surface.footprints));
  if(plan.glb) {
    const asset=assetFor(plan,manifest);
    if(!asset)return;
    const matrix=getTemporaryWorksGlbModelMatrix(asset,plan.glb.placement),corners:HardeningGeoPoint[]=[];
    for(const x of [asset.bounds.min[0],asset.bounds.max[0]])for(const y of [asset.bounds.min[1],asset.bounds.max[1]])for(const z of [asset.bounds.min[2],asset.bounds.max[2]]) {
      const world=Matrix4.multiplyByPoint(matrix,new Cartesian3(x,y,z),new Cartesian3());
      const p=Cartographic.fromCartesian(world);
      corners.push({longitude:CesiumMath.toDegrees(p.longitude),latitude:CesiumMath.toDegrees(p.latitude)});
    }
    return geoBounds(corners);
  }
  return geoBounds(plan.mesh.vertices);
}

const legacyFootprints=new WeakMap<object,TemporaryWorksFootprint[]>();

/** Legacy geometry is read once; no sampler or mutating mesh migration is involved. */
export function getSurfacePlanFootprints(plan:SurfacePlan):TemporaryWorksFootprint[]|undefined {
  if(plan.surface)return plan.surface.footprints;
  if(plan.glb)return undefined;
  if(!plan.mesh.vertices.length||!plan.mesh.triangles.length)return [];
  const cached=legacyFootprints.get(plan.mesh);
  if(cached)return cached;
  if(plan.mesh.vertices.length>HARDENING_LIMITS.outputPoints || plan.mesh.triangles.length>HARDENING_LIMITS.surfaceTriangles)
    throw new Error('相邻历史地面网格过大，暂不能安全提取硬化避让范围；原方案保持不变。');
  const first=plan.mesh.vertices[0],reference={longitude:first.longitude,latitude:first.latitude,height:0};
  const local=plan.mesh.vertices.map(p=>hardeningLocalFromGeo(p,reference));
  const originals=new Map(local.map((p,i)=>[`${p.x}/${p.y}`,plan.mesh.vertices[i]]));
  const convert=(p:{x:number;y:number})=>{
    const original=originals.get(`${p.x}/${p.y}`);
    if(!original)throw new Error('历史地面边界不能对应原坐标，请核对保存网格。');
    return {longitude:original.longitude,latitude:original.latitude,height:original.surfaceHeight};
  };
  const footprints=designedRoadFootprints(local,plan.mesh.triangles).map(f=>({outer:f.outer.map(convert),holes:f.holes.map(h=>h.map(convert))}));
  legacyFootprints.set(plan.mesh,footprints);
  return footprints;
}

/** A content hash is required to keep a confirmed floor outline tied to one actual model version. */
export function surfaceResourceVersion(asset:TemporaryWorksGlbResource):string {
  // A source hash can stay unchanged after runtime geometry/material processing.
  // Only the deployed GLB content hash can identify the floor outline being confirmed.
  const value=asset.sha256;
  if(typeof value==='string'&&/^[a-f\d]{64}$/i.test(value))return value.toLowerCase();
  throw new Error('临建资源缺少有效内容哈希，无法确认随设施地坪范围。');
}

function transformedFacilityBoundary(exclusion:HardeningFacilityExclusion,binding:HardeningFacilityBinding,current:TemporaryWorksGlbPlacement) {
  const old=binding.placement,a=CesiumMath.toRadians(old.headingDeg),b=CesiumMath.toRadians(current.headingDeg);
  const ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b);
  if(![old.dimensions.length,old.dimensions.width,current.dimensions.length,current.dimensions.width].every(v=>Number.isFinite(v)&&v>0))
    throw new Error('设施缩放尺寸无效，随设施地坪须重新确认。');
  return exclusion.boundary.map(p=>{
    const local=hardeningLocalFromGeo(p,old);
    const x=(local.x*ca+local.y*sa)*current.dimensions.length/old.dimensions.length;
    const y=(-local.x*sa+local.y*ca)*current.dimensions.width/old.dimensions.width;
    return hardeningGeoFromLocal({x:x*cb-y*sb,y:x*sb+y*cb},current);
  });
}

function transformedFacilityLevels(binding:HardeningFacilityBinding,current:TemporaryWorksGlbPlacement) {
  const ratio=current.dimensions.height/binding.placement.dimensions.height;
  return {floorHeight:current.height+(binding.floorHeight-binding.placement.height)*ratio,floorThickness:binding.floorThickness*ratio};
}

/** Use only for a fresh user-confirmed editor value, whose exclusion coordinates are current world coordinates. */
export function bindHardeningFacilities(value:HardeningEditorValue,plans:readonly SurfacePlan[],manifest?:TemporaryWorksGlbManifest):Record<string,HardeningFacilityBinding> {
  const bindings:Record<string,HardeningFacilityBinding>={};
  for(const exclusion of value.facilityExclusions) {
    const plan=plans.find(p=>p.id===exclusion.objectId);
    if(!plan?.glb)continue;
    const asset=assetFor(plan,manifest);
    // The preparation result reports this as unknown; it must not guess a floor while a manifest loads.
    if(!asset)continue;
    const resourceVersion=surfaceResourceVersion(asset);
    if(exclusion.resourceVersion && exclusion.resourceVersion!==resourceVersion)
      throw new Error(`设施“${plan.name}”资源已改变，请重新绘制地坪避让区。`);
    const {floorHeight,floorThickness}=exclusion as HardeningFacilityExclusion & {floorHeight?:number;floorThickness?:number};
    if(!Number.isFinite(floorHeight)||!Number.isFinite(floorThickness)||floorThickness!<=0)
      throw new Error(`请明确确认设施“${plan.name}”的地坪顶标高和厚度。`);
    const prior=bindings[plan.id];
    if(prior&&(prior.floorHeight!==floorHeight||prior.floorThickness!==floorThickness))
      throw new Error(`设施“${plan.name}”的多个避让区地坪标高或厚度不一致，请分设设施后确认。`);
    bindings[plan.id]={placement:copyPlacement(plan.glb.placement),resourceVersion,floorHeight:floorHeight!,floorThickness:floorThickness!};
  }
  return bindings;
}

/** Refresh editor coordinates before rebinding. A changed asset remains stale until the user redraws it. */
export function hardeningValueForCurrentFacilities(plan:SurfacePlan,plans:readonly SurfacePlan[],manifest?:TemporaryWorksGlbManifest):HardeningEditorValue {
  const config=plan.hardening;
  if(!config)throw new Error('该方案不是场地硬化。');
  const exclusions=config.facilityExclusions.map(exclusion=>{
    const facility=plans.find(p=>p.id===exclusion.objectId),binding=config.facilityBindings?.[exclusion.objectId];
    if(!facility?.glb || !binding)return {...exclusion,boundary:exclusion.boundary.map(p=>({...p}))};
    const asset=assetFor(facility,manifest);
    let version:string|undefined;
    try{if(asset)version=surfaceResourceVersion(asset);}catch{/* Remains stale, never rebind guessed model geometry. */}
    if(version!==binding.resourceVersion)return {...exclusion,resourceVersion:binding.resourceVersion,boundary:exclusion.boundary.map(p=>({...p}))};
    return {...exclusion,resourceVersion:version,...transformedFacilityLevels(binding,facility.glb.placement),boundary:transformedFacilityBoundary(exclusion,binding,facility.glb.placement)};
  });
  return {name:config.name,reference:{...config.reference},boundary:config.boundary.map(p=>({...p})),holes:config.holes.map(r=>r.map(p=>({...p}))),
    thickness:config.thickness,slopeEnabled:config.slopeEnabled,gradeEastPct:config.gradeEastPct,gradeNorthPct:config.gradeNorthPct,
    clippingEnabled:config.clippingEnabled,acceptedHeightDifference:false,facilityExclusions:exclusions};
}

/** Stable non-security fingerprint. Numeric mesh data is streamed once per immutable mesh object. */
function fingerprintState() {
  let a=0x811c9dc5,b=0x9e3779b9;
  const mix=(n:number)=>{a=Math.imul(a^(n>>>0),0x01000193);b=Math.imul(b^((n>>>0)+(a>>>0)),0x85ebca6b);};
  const bytes=new DataView(new ArrayBuffer(8));
  return {
    text(value:string){for(let i=0;i<value.length;i++)mix(value.charCodeAt(i));mix(0xffffffff);},
    number(value:number|undefined){bytes.setFloat64(0,value??NaN,true);mix(bytes.getUint32(0,true));mix(bytes.getUint32(4,true));},
    digest(){return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');},
  };
}
function canonical(value:unknown):string {
  if(value===undefined)return 'null';
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
const meshFingerprints=new WeakMap<object,string>();
function meshFingerprint(mesh:SurfacePlan['mesh']) {
  const cached=meshFingerprints.get(mesh);if(cached)return cached;
  if(mesh.vertices.length>HARDENING_LIMITS.outputPoints || mesh.triangles.length>HARDENING_LIMITS.surfaceTriangles)
    throw new Error('相邻地面网格超出硬化接界核对预算，请先分区。');
  const hash=fingerprintState();hash.number(mesh.vertices.length);hash.number(mesh.triangles.length);
  for(const p of mesh.vertices)for(const n of [p.longitude,p.latitude,p.surfaceHeight,p.baseHeight,p.formationHeight])hash.number(n);
  for(const face of mesh.triangles)for(const i of face)hash.number(i);
  const result=hash.digest();meshFingerprints.set(mesh,result);return result;
}
const sourceFingerprints=new WeakMap<object,string>();
function sourceFingerprint(plan:SurfacePlan) {
  const cached=sourceFingerprints.get(plan);if(cached)return cached;
  const c=plan.hardening!,hash=fingerprintState();
  hash.text(canonical({version:c.version,reference:c.reference,boundary:c.boundary,holes:c.holes,thickness:c.thickness,
    slopeEnabled:c.slopeEnabled,gradeEastPct:c.slopeEnabled?c.gradeEastPct:0,gradeNorthPct:c.slopeEnabled?c.gradeNorthPct:0,
    facilityExclusions:c.facilityExclusions,facilityBindings:c.facilityBindings}));
  const result=hash.digest();sourceFingerprints.set(plan,result);return result;
}
const planFingerprints=new WeakMap<object,Map<string,string>>();
function blockerFingerprint(plan:SurfacePlan,resourceVersion='') {
  const cached=planFingerprints.get(plan)?.get(resourceVersion);if(cached)return cached;
  const hash=fingerprintState();hash.text(plan.id);hash.text(plan.kind);hash.text(resourceVersion);
  if(plan.glb)hash.text(canonical({resourceId:plan.glb.resourceId,placement:plan.glb.placement}));
  else {hash.text(meshFingerprint(plan.mesh));hash.text(canonical(plan.surface?.footprints));}
  const result=hash.digest(),values=planFingerprints.get(plan)??new Map();values.set(resourceVersion,result);planFingerprints.set(plan,values);return result;
}

export function prepareHardeningParameters(source:SurfacePlan,plans:readonly SurfacePlan[],manifest?:TemporaryWorksGlbManifest,acceptCurrent=false) {
  const config=source.hardening;
  if(!config)throw new Error('缺少场地硬化设计参数。');
  const reference=config.reference,local=(p:HardeningGeoPoint)=>hardeningLocalFromGeo(p,reference);
  const sourceBounds=surfacePlanBounds(source),sourceVersion=sourceFingerprint(source);
  const blockers:HardeningBlocker[]=[],dependencyFingerprints:Record<string,string>={},unknownFacilities:string[]=[];
  const acceptedHeightDifferences:string[]=[];
  const accept=(plan:SurfacePlan,version='')=>{
    const hash=fingerprintState();hash.text(sourceVersion);hash.text(blockerFingerprint(plan,version));
    const fingerprint=hash.digest();dependencyFingerprints[plan.id]=fingerprint;
    if(config.acceptedHeightDifference && (acceptCurrent || config.acceptedDependencies?.[plan.id]===fingerprint))acceptedHeightDifferences.push(plan.id);
  };
  for(const plan of plans) {
    // Composition already supplies active, ready occupants including temporary visibility overrides.
    if(plan.id===source.id)continue;
    const candidate=surfacePlanBounds(plan,manifest);
    if(sourceBounds&&candidate&&!surfaceBoundsIntersect(sourceBounds,candidate))continue;
    if(plan.glb) {
      if(plan.glb.resourceId==='wall')continue;
      const asset=assetFor(plan,manifest),binding=config.facilityBindings?.[plan.id];
      const exclusions=config.facilityExclusions.filter(e=>e.objectId===plan.id);
      let version:string|undefined;
      try{if(asset)version=surfaceResourceVersion(asset);}catch{/* User confirmation is required without an authoritative version. */}
      if(!binding||!exclusions.length||!version||binding.resourceVersion!==version) {unknownFacilities.push(plan.id);continue;}
      const placement=plan.glb.placement;
      const {floorHeight,floorThickness}=transformedFacilityLevels(binding,placement);
      if(!Number.isFinite(floorHeight)||!Number.isFinite(floorThickness)||floorThickness<=0){unknownFacilities.push(plan.id);continue;}
      blockers.push({id:plan.id,name:plan.name,kind:'facility',footprints:exclusions.map(exclusion=>({outer:transformedFacilityBoundary(exclusion,binding,placement).map(local)})),
        plane:{reference:local(placement),height:floorHeight},thickness:floorThickness,visible:true,ready:true});
      accept(plan,version);
      continue;
    }
    const footprints=getSurfacePlanFootprints(plan);
    if(!footprints?.length)continue;
    if(plan.mesh.vertices.length>HARDENING_LIMITS.outputPoints||plan.mesh.triangles.length>HARDENING_LIMITS.surfaceTriangles)
      throw new Error(`“${plan.name}”网格超出硬化接界预算，请分区核对；原方案保持不变。`);
    blockers.push({id:plan.id,name:plan.name,kind:plan.kind==='road'?'road':'hardening',
      footprints:footprints.map(f=>({outer:f.outer.map(local),holes:(f.holes??[]).map(h=>h.map(local))})),
      surface:{vertices:plan.mesh.vertices.map(p=>({...local(p),surfaceHeight:p.surfaceHeight,formationHeight:p.formationHeight})),triangles:plan.mesh.triangles},
      thickness:plan.hardening?.thickness,visible:true,ready:true});
    accept(plan);
  }
  const parameters:HardeningParameters={footprints:[{outer:config.boundary.map(local),holes:config.holes.map(r=>r.map(local))}],
    plane:{reference:{x:0,y:0},height:reference.height,gradeEastPct:config.slopeEnabled?config.gradeEastPct:0,gradeNorthPct:config.slopeEnabled?config.gradeNorthPct:0},
    thickness:config.thickness,blockers,acceptedHeightDifferences};
  return {parameters,dependencyFingerprints,unknownFacilities};
}

export function toWorldHardeningResult(result:HardeningResult,reference:HardeningReference) {
  const positions=new Map<string,PlanningVertex & {formationHeight:number}>();
  const convert=(p:{x:number;y:number;surfaceHeight:number;baseHeight:number;formationHeight?:number}):PlanningVertex & {formationHeight:number}=>({
    ...hardeningGeoFromLocal(p,reference),surfaceHeight:p.surfaceHeight,baseHeight:p.baseHeight,formationHeight:p.formationHeight??p.baseHeight,
  });
  const vertices=result.vertices.map(p=>{const v=convert(p);positions.set(`${p.x}/${p.y}`,v);return v;});
  const convertBoundary=(p:{x:number;y:number})=>{
    const v=positions.get(`${p.x}/${p.y}`);
    if(!v)throw new Error('硬化轮廓缺少对应设计面高程，未应用本次结果。');
    return {longitude:v.longitude,latitude:v.latitude,height:v.surfaceHeight};
  };
  const footprints:TemporaryWorksFootprint[]=result.footprints.map(f=>({outer:f.outer.map(convertBoundary),holes:(f.holes??[]).map(h=>h.map(convertBoundary))}));
  const sideEdges:TemporaryWorksSurfaceSide[]=result.sideEdges.map(e=>({a:convert(e.a),b:convert(e.b)}));
  return {mesh:{vertices,triangles:result.triangles},footprints,sideEdges};
}
