import assert from 'node:assert/strict';
import test from 'node:test';
import { bindHardeningFacilities, getSurfacePlanFootprints, hardeningValueForCurrentFacilities, prepareHardeningParameters,
  surfacePlanBounds, surfaceResourceVersion, toWorldHardeningResult, type HardeningSavedConfig } from './temporaryWorksSurfacePlans.ts';
import { calculateHardening } from './temporaryWorksHardening.ts';
import { hardeningGeoFromLocal, hardeningLocalFromGeo, type HardeningReference } from './temporaryWorksHardeningEditorGeometry.ts';
import type { TemporaryWorksPlan } from './temporaryWorksPanel.ts';
import type { TemporaryWorksGlbManifest, TemporaryWorksGlbPlacement, TemporaryWorksGlbResource } from './temporaryWorksGlb.ts';
import type { HardeningEditorValue } from './temporaryWorksHardeningEditor.ts';

const reference:HardeningReference={longitude:120,latitude:30,height:100};
const geo=(x:number,y:number)=>hardeningGeoFromLocal({x,y},reference);
const rectangle=(x:number,y:number,w:number,h:number)=>[geo(x,y),geo(x+w,y),geo(x+w,y+h),geo(x,y+h)];
const close=(a:number,b:number,eps=1e-5)=>assert.ok(Math.abs(a-b)<eps,`${a} ≠ ${b}`);
const value=(overrides:Partial<HardeningEditorValue>={}):HardeningEditorValue=>({name:'synthetic hardening',reference:{...reference},boundary:rectangle(-50,-50,100,100),
  holes:[],thickness:.3,slopeEnabled:false,gradeEastPct:0,gradeNorthPct:0,clippingEnabled:true,acceptedHeightDifference:false,facilityExclusions:[],...overrides});
const source=(overrides:Partial<HardeningSavedConfig>={}):TemporaryWorksPlan=>({id:'pad',name:'pad',kind:'hardening',visible:true,createdAt:'2026-01-01',modelId:'photo',modelName:'synthetic',
  inputs:{},mesh:{vertices:[],triangles:[]},metrics:{},hardening:{...value(),version:1,priority:1,...overrides}} as unknown as TemporaryWorksPlan);
function road(id='road',height=101,withSurface=true):TemporaryWorksPlan {
  const outline=rectangle(-40,-3.5,80,7),vertices=outline.map(p=>({...p,surfaceHeight:height,baseHeight:height-.3,formationHeight:height-.5}));
  return {id,name:id,kind:'road',visible:true,createdAt:'2026-01-01',modelId:'photo',modelName:'synthetic',inputs:{},
    mesh:{vertices,triangles:[[0,1,2],[0,2,3]]},metrics:{},...(withSurface?{surface:{version:1,footprints:[{outer:outline}],clippingEnabled:true}}:{})} as TemporaryWorksPlan;
}
const asset:TemporaryWorksGlbResource={id:'camp',name:'synthetic camp',url:'/synthetic.glb',upAxis:'Z',sha256:'a'.repeat(64),
  bounds:{min:[-10,-10,0],max:[10,10,10]},anchor:[0,0,0],dimensions:{length:20,width:20,height:10},footprints:[{outer:[[-10,-10],[10,-10],[10,10],[-10,10]]}]};
const manifest:TemporaryWorksGlbManifest={schemaVersion:1,assets:[asset]};
const placement:TemporaryWorksGlbPlacement={...reference,headingDeg:0,scaleMode:'xyz',dimensions:{length:20,width:20,height:10}};
function facility(p:TemporaryWorksGlbPlacement=placement):TemporaryWorksPlan {
  return {id:'camp',name:'camp',kind:'camp',visible:true,createdAt:'2026-01-01',modelId:'photo',modelName:'synthetic',inputs:{},mesh:{vertices:[],triangles:[]},metrics:{},
    glb:{resourceId:'camp',placement:p,clippingEnabled:true}} as unknown as TemporaryWorksPlan;
}
const exclusion=()=>({objectId:'camp',resourceVersion:'a'.repeat(64),boundary:rectangle(-5,-5,10,10),floorHeight:100.5,floorThickness:.2});

test('source bounds and actual derived coverage bounds remain distinct',()=>{
  const p=source();
  const full=surfacePlanBounds(p)!;
  const actual={...p,hardening:undefined,surface:{version:1 as const,footprints:[{outer:rectangle(0,0,10,10)}],clippingEnabled:true}};
  const part=surfacePlanBounds(actual)!;
  assert.ok(part.minX>full.minX&&part.maxX<full.maxX&&part.maxY<full.maxY);
  assert.equal(getSurfacePlanFootprints(actual),actual.surface.footprints);
});

test('legacy road actual outline is cached without mutating original mesh or using its bbox',()=>{
  const p=road('legacy',100,false),snapshot=structuredClone(p.mesh);
  const first=getSurfacePlanFootprints(p)!,second=getSurfacePlanFootprints({...p,visible:false})!;
  assert.equal(first,second);assert.equal(first.length,1);assert.equal(first[0].outer.length,4);
  assert.deepEqual(p.mesh,snapshot);
  for(const point of first[0].outer)assert.ok(p.mesh.vertices.some(v=>v.longitude===point.longitude&&v.latitude===point.latitude));
});

test('GLB bounds are only candidate boxes; resource footprints are not accepted as verified floors',()=>{
  const f=facility(),b=surfacePlanBounds(f,manifest)!;
  assert.ok(b.minX<reference.longitude&&b.maxX>reference.longitude);
  assert.equal(getSurfacePlanFootprints(f),undefined);
  const prepared=prepareHardeningParameters(source(),[f],manifest);
  assert.deepEqual(prepared.unknownFacilities,['camp']);assert.equal(prepared.parameters.blockers!.length,0);
});

test('distant GLB does not require a floor confirmation, and inactive objects are caller filtered',()=>{
  const distant=facility({...placement,longitude:121});
  assert.deepEqual(prepareHardeningParameters(source(),[distant],manifest).unknownFacilities,[]);
  // Composition supplies actual visibility overrides; saved false must not remove an active blocker here.
  const p=road();p.visible=false;
  assert.equal(prepareHardeningParameters(source(),[p],manifest).parameters.blockers!.length,1);
});

test('confirmed facility floors use only user-drawn area and explicitly entered floor levels',()=>{
  const input=value({facilityExclusions:[exclusion()]}),f=facility();
  const bindings=bindHardeningFacilities(input,[f],manifest);
  assert.equal(bindings.camp.floorHeight,100.5);assert.equal(bindings.camp.floorThickness,.2);
  const prepared=prepareHardeningParameters(source({...input,facilityBindings:bindings}),[f],manifest);
  assert.deepEqual(prepared.unknownFacilities,[]);
  const b=prepared.parameters.blockers![0];assert.equal(b.plane!.height,100.5);assert.equal(b.thickness,.2);
  const x=b.footprints[0].outer.map(p=>p.x);close(Math.max(...x)-Math.min(...x),10);
});

test('floor exclusions follow translation/heading/XYZ scale and remain bound to content hash',()=>{
  const input=value({facilityExclusions:[exclusion()]}),f=facility();
  const bindings=bindHardeningFacilities(input,[f],manifest);
  const saved=source({...input,facilityBindings:bindings});
  const moved=facility({...placement,...geo(20,0),height:102,headingDeg:90,dimensions:{length:40,width:10,height:20}});
  const prepared=prepareHardeningParameters(saved,[moved],manifest),blocker=prepared.parameters.blockers![0];
  assert.deepEqual(prepared.unknownFacilities,[]);close(blocker.plane!.height,103);close(blocker.thickness!,.4);
  const xs=blocker.footprints[0].outer.map(p=>p.x),ys=blocker.footprints[0].outer.map(p=>p.y);
  close(Math.max(...xs)-Math.min(...xs),5,1e-3);close(Math.max(...ys)-Math.min(...ys),20,1e-3);close((Math.max(...xs)+Math.min(...xs))/2,20,1e-3);
  const changed={schemaVersion:1 as const,assets:[{...asset,sha256:'b'.repeat(64)}]};
  assert.deepEqual(prepareHardeningParameters(saved,[moved],changed).unknownFacilities,['camp']);
});

test('editing transformed exclusions produces current world coordinates before a fresh bind',()=>{
  const input=value({facilityExclusions:[exclusion()]}),f=facility(),bindings=bindHardeningFacilities(input,[f],manifest);
  const saved=source({...input,facilityBindings:bindings}),moved=facility({...placement,...geo(25,0),height:103});
  const editor=hardeningValueForCurrentFacilities(saved,[moved],manifest);
  assert.equal(editor.acceptedHeightDifference,false);
  const p=hardeningLocalFromGeo(editor.facilityExclusions[0].boundary[0],reference);close(p.x,20,1e-3);
  assert.equal(editor.facilityExclusions[0].floorHeight,103.5);
  const rebound=source({...editor,facilityBindings:bindHardeningFacilities(editor,[moved],manifest)});
  const before=prepareHardeningParameters(saved,[moved],manifest),after=prepareHardeningParameters(rebound,[moved],manifest);
  close(before.parameters.blockers![0].footprints[0].outer[0].x,after.parameters.blockers![0].footprints[0].outer[0].x,1e-4);
  const stale=hardeningValueForCurrentFacilities(saved,[moved],{schemaVersion:1,assets:[{...asset,sha256:'b'.repeat(64)}]});
  awaitableThrows(()=>bindHardeningFacilities(stale,[moved],{schemaVersion:1,assets:[{...asset,sha256:'b'.repeat(64)}]}),/重新绘制/);
});
function awaitableThrows(fn:()=>unknown,pattern:RegExp){assert.throws(fn,pattern);}

test('missing floor datum or resource version is never inferred from model bounds',()=>{
  const input=value({facilityExclusions:[{objectId:'camp',boundary:rectangle(-5,-5,10,10)} as ReturnType<typeof exclusion>]}),f=facility();
  assert.throws(()=>bindHardeningFacilities(input,[f],manifest),/地坪顶标高和厚度/);
  assert.deepEqual(bindHardeningFacilities(input,[f],undefined),{});
  assert.throws(()=>surfaceResourceVersion({...asset,sha256:undefined,sourceSha256:undefined}),/内容哈希/);
  assert.throws(()=>surfaceResourceVersion({...asset,sha256:undefined,sourceSha256:'a'.repeat(64)}),/内容哈希/);
});

test('height acceptance survives restore but invalidates on occupant or source geometry change',()=>{
  const p=source({acceptedHeightDifference:true}),r=road();
  const initial=prepareHardeningParameters(p,[r],manifest,false);
  assert.deepEqual(initial.parameters.acceptedHeightDifferences,[]);
  const explicit=prepareHardeningParameters(p,[r],manifest,true);
  assert.deepEqual(explicit.parameters.acceptedHeightDifferences,['road']);
  const saved=source({acceptedHeightDifference:true,acceptedDependencies:explicit.dependencyFingerprints});
  const restored=prepareHardeningParameters(structuredClone(saved),[structuredClone(r)],manifest,false);
  assert.deepEqual(restored.parameters.acceptedHeightDifferences,['road']);
  const raised=road('road',102);
  assert.deepEqual(prepareHardeningParameters(saved,[raised],manifest).parameters.acceptedHeightDifferences,[]);
  const changedSource=source({reference:{...reference,height:99},acceptedHeightDifference:true,acceptedDependencies:explicit.dependencyFingerprints});
  assert.deepEqual(prepareHardeningParameters(changedSource,[r],manifest).parameters.acceptedHeightDifferences,[]);
  const revoked=source({acceptedHeightDifference:false,acceptedDependencies:explicit.dependencyFingerprints});
  assert.deepEqual(prepareHardeningParameters(revoked,[r],manifest).parameters.acceptedHeightDifferences,[]);
});

test('derived higher-priority hardening works without a saved hardening field',()=>{
  const p={...road('surface',100),kind:'hardening' as const};
  const prepared=prepareHardeningParameters(source(),[p]);
  assert.equal(prepared.parameters.blockers![0].kind,'hardening');
  assert.equal(prepared.parameters.blockers![0].surface!.vertices[0].formationHeight,99.5);
});

test('world conversion preserves design heights, thickness, holes and exact clip/mesh positions',()=>{
  const prepared=prepareHardeningParameters(source({holes:[rectangle(-5,-5,10,10)]}),[]);
  const result=calculateHardening(prepared.parameters),world=toWorldHardeningResult(result,reference);
  assert.equal(world.footprints.length,1);assert.equal(world.footprints[0].holes!.length,1);
  for(const v of world.mesh.vertices){assert.equal(v.surfaceHeight,100);assert.equal(v.baseHeight,99.7);assert.equal(v.formationHeight,99.7);}
  for(const p of world.footprints.flatMap(f=>[...f.outer,...(f.holes??[]).flat()]))assert.ok(world.mesh.vertices.some(v=>p.longitude===v.longitude&&p.latitude===v.latitude&&p.height===v.surfaceHeight));
  assert.ok(world.sideEdges.length>=8);
});

test('fully covered hardening produces no mask or redundant mesh on world conversion',()=>{
  const prepared=prepareHardeningParameters(source({boundary:rectangle(-10,-2,20,4)}),[road('road',100)]);
  const world=toWorldHardeningResult(calculateHardening(prepared.parameters),reference);
  assert.deepEqual(world.mesh,{vertices:[],triangles:[]});assert.deepEqual(world.footprints,[]);assert.deepEqual(world.sideEdges,[]);
});
