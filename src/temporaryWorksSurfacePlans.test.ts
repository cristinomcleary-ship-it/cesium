import assert from 'node:assert/strict';
import test from 'node:test';
import { bindHardeningFacilities, getSurfacePlanFootprints, hardeningValueForCurrentFacilities, prepareHardeningParameters,
  surfacePlanBounds, surfaceResourceVersion, toWorldHardeningResult, type HardeningSavedConfig } from './temporaryWorksSurfacePlans.ts';
import { calculateHardening } from './temporaryWorksHardening.ts';
import { calculateDesignedRoad } from './temporaryWorksDesignedRoad.ts';
import { createRoadCoordinateFrame } from './temporaryWorksCad.ts';
import polygonClipping from 'polygon-clipping';
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

test('GLB automatically excludes its real footprint without inventing floor levels from its bounds',()=>{
  const f=facility(),b=surfacePlanBounds(f,manifest)!;
  assert.ok(b.minX<reference.longitude&&b.maxX>reference.longitude);
  assert.equal(getSurfacePlanFootprints(f),undefined);
  const prepared=prepareHardeningParameters(source(),[f],manifest);
  assert.deepEqual(prepared.unknownFacilities,[]);assert.equal(prepared.parameters.blockers!.length,1);
  const blocker=prepared.parameters.blockers![0];
  assert.equal(blocker.footprintOnly,true);assert.equal(blocker.plane,undefined);assert.equal(blocker.thickness,undefined);
  const result=calculateHardening(prepared.parameters);
  assert.equal(result.canSave,true);assert.deepEqual(result.conflicts,[]);close(result.excludedArea,400,.03);
  assert.deepEqual(prepareHardeningParameters(source(),[f]).unknownFacilities,['camp']);
});

test('distant GLB does not require a floor confirmation, and inactive objects are caller filtered',()=>{
  const distant=facility({...placement,longitude:121});
  assert.deepEqual(prepareHardeningParameters(source(),[distant],manifest).unknownFacilities,[]);
  // Composition supplies actual visibility overrides; saved false must not remove an active blocker here.
  const p=road();p.visible=false;
  assert.equal(prepareHardeningParameters(source(),[p],manifest).parameters.blockers!.length,1);
});

test('optional confirmed floors retain exact levels while automatic building occupancy still applies',()=>{
  const input=value({facilityExclusions:[exclusion()]}),f=facility();
  const bindings=bindHardeningFacilities(input,[f],manifest);
  assert.equal(bindings.camp.floorHeight,100.5);assert.equal(bindings.camp.floorThickness,.2);
  const prepared=prepareHardeningParameters(source({...input,facilityBindings:bindings}),[f],manifest);
  assert.deepEqual(prepared.unknownFacilities,[]);
  const b=prepared.parameters.blockers![0];assert.equal(b.plane!.height,100.5);assert.equal(b.thickness,.2);
  const x=b.footprints[0].outer.map(p=>p.x);close(Math.max(...x)-Math.min(...x),10);
  assert.equal(prepared.parameters.blockers!.length,2);
  assert.equal(prepared.parameters.blockers![1].footprintOnly,true);
  const result=calculateHardening(prepared.parameters);
  close(result.excludedArea,400,.03);assert.equal(result.conflicts.length,1);
  assert.equal(result.conflicts[0].id,'camp');close(result.conflicts[0].maxDifference!,.5);
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
  const rebound=prepareHardeningParameters(saved,[moved],changed);
  assert.deepEqual(rebound.unknownFacilities,[]);
  assert.equal(rebound.parameters.blockers!.length,1);
  assert.equal(rebound.parameters.blockers![0].footprintOnly,true,'stale manual floor must not replace current automatic occupancy');
});

test('automatic occupancy preserves courtyard holes and follows translation, heading and independent scales',()=>{
  const courtyard={...asset,bounds:{min:[-50,-50,0] as [number,number,number],max:[50,50,10] as [number,number,number]},
    footprints:[{outer:[[-10,-10],[10,-10],[10,10],[-10,10]] as [number,number][],
      holes:[[[-5,-5],[5,-5],[5,5],[-5,5]] as [number,number][]]}]};
  const assets:TemporaryWorksGlbManifest={schemaVersion:1,assets:[courtyard]};
  const f=facility({...placement,...geo(10,5),headingDeg:90,dimensions:{length:40,width:10,height:30}});
  const snapshot=structuredClone(f),prepared=prepareHardeningParameters(source(),[f],assets);
  const occupant=prepared.parameters.blockers![0];
  assert.equal(occupant.footprints[0].holes!.length,1);
  const xs=occupant.footprints[0].outer.map(p=>p.x),ys=occupant.footprints[0].outer.map(p=>p.y);
  close(Math.max(...xs)-Math.min(...xs),10,.001);close(Math.max(...ys)-Math.min(...ys),40,.002);
  close((Math.max(...xs)+Math.min(...xs))/2,10,.001);close((Math.max(...ys)+Math.min(...ys))/2,5,.001);
  const result=calculateHardening(prepared.parameters);
  close(result.excludedArea,300,.02);close(result.visibleArea,9700,.02);
  assert.equal(result.canSave,true);assert.deepEqual(result.conflicts,[]);
  assert.equal(result.footprints.length,2,'courtyard remains a separate hardening island');
  assert.deepEqual(f,snapshot,'automatic exclusions must not modify the facility');
});

test('automatic GLB occupancy and crossing road subtract their union once and recover after removal',()=>{
  const p=source(),f=facility(),r=road('road',100);
  const result=calculateHardening(prepareHardeningParameters(p,[f,r],manifest).parameters);
  close(result.excludedArea,400+560-140,.03);assert.equal(result.canSave,true);
  const onlyRoad=calculateHardening(prepareHardeningParameters(p,[r],manifest).parameters);
  close(onlyRoad.excludedArea,560,1e-4);
  const empty=calculateHardening(prepareHardeningParameters(p,[],manifest).parameters);
  close(empty.excludedArea,0);
  const distant=facility({...placement,...geo(150,0)});
  close(calculateHardening(prepareHardeningParameters(p,[distant,r],manifest).parameters).excludedArea,560,1e-4);
});

test('automatic footprint occupancy needs neither a floor confirmation nor a content hash',()=>{
  const assets:TemporaryWorksGlbManifest={schemaVersion:1,assets:[{...asset,sha256:undefined}]};
  const prepared=prepareHardeningParameters(source(),[facility({...placement,height:250})],assets);
  assert.deepEqual(prepared.unknownFacilities,[]);
  assert.equal(prepared.parameters.blockers![0].plane,undefined);
  assert.equal(calculateHardening(prepared.parameters).canSave,true);
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

async function capturedDesignedRoadOverlap() {
  // Public synthetic GPU fixture, replayed through the same CAD and saved-world-coordinate path.
  const centerline=[{x:-65,y:-35},{x:-15,y:-35},{x:20,y:-10},{x:65,y:-10}];
  const frame=createRoadCoordinateFrame({mode:'local',unit:'m',axisOrder:'eastNorth',referenceX:0,referenceY:0,longitude:121,latitude:31,rotation:0},centerline[0]);
  const result=await calculateDesignedRoad(centerline.map(frame.cadToLocal),{width:7,hardeningDepth:.3,treatmentDepth:.2},
    {startHeight:2,gradesEnabled:false,grades:[]});
  const saved=JSON.parse(JSON.stringify({...road('designed',2),
    inputs:{road:{surfaceMode:'designed',algorithmVersion:result.algorithmVersion}},
    mesh:{vertices:result.vertices.map(({x,y,...heights})=>({...frame.localToGeo({x,y}),...heights})),triangles:result.triangles},
    surface:{version:1,clippingEnabled:true,footprints:result.footprintsXY.map(f=>({outer:f.outer.map(frame.localToGeo),holes:f.holes.map(r=>r.map(frame.localToGeo))}))},
  })) as TemporaryWorksPlan;
  const pad=source({reference:{longitude:121,latitude:31,height:2},boundary:[
    {longitude:120.9992802483931,latitude:30.999420684409838},
    {longitude:121.00028635193338,latitude:30.999420686098038},
    {longitude:121.0002863554452,latitude:31.000595919110577},
    {longitude:120.99928023956605,latitude:31.000595917422295},
  ]});
  return {saved,pad};
}

test('saved designed road and clicked hardening overlap use actual mesh coverage without rounded seams',async()=>{
  const {saved,pad}=await capturedDesignedRoadOverlap(),before=structuredClone([saved,pad]);
  const prepared=prepareHardeningParameters(pad,[saved]),input=prepared.parameters;
  const result=calculateHardening(input);
  assert.equal(result.canSave,true);assert.deepEqual(result.conflicts,[]);
  assert.deepEqual([saved,pad],before,'composition cannot rewrite saved road or hardening source');
  const occupant=input.blockers![0],mesh=occupant.surface!;
  assert.ok(occupant.footprints[0].outer.length>saved.surface!.footprints[0].outer.length,
    'reprojection retains the actual intermediate mesh boundary vertices');
  for(const p of occupant.footprints[0].outer)
    assert.ok(mesh.vertices.some(v=>v.x===p.x&&v.y===p.y),'every occupied boundary vertex comes from the actual drawable mesh');
  const subject=input.footprints.map(f=>[f.outer.map(p=>[p.x,p.y] as [number,number])]);
  const area=(geometry:number[][][][])=>geometry.reduce((sum,polygon)=>sum+polygon.reduce((s,ring,i)=>
    s+(i?-1:1)*Math.abs(ring.reduce((a,p,j)=>{const q=ring[(j+1)%ring.length];return a+p[0]*q[1]-p[1]*q[0];},0))/2,0),0);
  // The conforming road triangles have disjoint interiors: sum their individual intersections,
  // independently of the composed boundary, to measure the true occupied area.
  const occupied=mesh.triangles.reduce((sum,t)=>sum+area(polygonClipping.intersection(subject,
    [[t.map(i=>[mesh.vertices[i].x,mesh.vertices[i].y] as [number,number])]])),0);
  close(result.excludedArea,occupied,1e-6);close(result.visibleArea+occupied,result.sourceArea,1e-6);
  const repeated=calculateHardening(prepareHardeningParameters(structuredClone(pad),[structuredClone(saved)]).parameters);
  close(repeated.visibleArea,result.visibleArea,1e-7);

  const raised=structuredClone(input);
  raised.blockers![0].surface!.vertices.forEach(p=>{p.surfaceHeight+=.2;});
  const high=calculateHardening(raised);
  assert.equal(high.canSave,false);assert.equal(high.conflicts[0].kind,'height');close(high.conflicts[0].maxDifference!,.2,1e-7);
  const missing=structuredClone(input);
  const triangles=missing.blockers![0].surface!.triangles;
  missing.blockers![0].surface!.triangles=triangles.filter((_,i)=>i!==Math.floor(triangles.length/2));
  missing.acceptedHeightDifferences=[occupant.id];
  const incomplete=calculateHardening(missing);
  assert.equal(incomplete.canSave,false);assert.equal(incomplete.conflicts[0].kind,'unknown-height');
});
