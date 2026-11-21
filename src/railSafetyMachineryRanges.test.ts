import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadMachineryAsset } from './machinery/assets.ts';
import { computeMachineryGeometry, defaultMachineryParameters, resolveMachineryParameters } from './machinery/engine.ts';
import { assessMachineryConstruction, computeMachineryWorkRange, transformAttachedRange, type RailSafetyLimitAssessment, type RailSafetyWorkRange } from './railSafetyMachineryRanges.ts';
import { pointInPolygon, projectWgs84ToLocal, unprojectLocalToWgs84 } from './railSafetyGeometry.ts';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes.ts';
import { MACHINERY_PARAMETER_DEFAULTS } from './machineryValidation.ts';
import type { RailSafetyConstructionClass, RailSafetyDeclaredConstructionClass, RailSafetyMachine } from './railSafetyTypes.ts';

const origin = { longitude: 121, latitude: 31, height: 120 };
const ring = (xmin: number, ymin: number, xmax: number, ymax: number) => [[xmin,ymin],[xmax,ymin],[xmax,ymax],[xmin,ymax]].map(([x,y]) => unprojectLocalToWgs84({x,y},origin));
const state = (constructionClass: RailSafetyDeclaredConstructionClass = 'C'): MachineryMetadata => ({schemaVersion:1, assetId:'crane',assetVersion:MACHINERY_ASSET_VERSION,
  proportional:false,parameters:{...MACHINERY_PARAMETER_DEFAULTS.crane},placement:{...origin,heading:0},visible:true,constructionClass});
const configuration = (): RailSafetyMachine => ({schemaVersion:1,kind:'machine',resourceId:'crane',selectedLimitIds:['limit']});
const workRange: RailSafetyWorkRange = {origin,polygon:[{x:-2,y:-2},{x:2,y:-2},{x:2,y:2},{x:-2,y:2}],source:'user-defined',heightMeters:2};
const assess = (limits: RailSafetyLimitAssessment[], constructionClass: RailSafetyDeclaredConstructionClass = 'C') => assessMachineryConstruction({state:state(constructionClass), definition:{...configuration(),selectedLimitIds:limits.map((_,i)=>`limit-${i}`)},limits,workRange});
const touch = (limitType:'equipment'|'line', fall:boolean, work:boolean):RailSafetyLimitAssessment => ({name:'限界',limitType,status:fall?'touching':'clear',workStatus:work?'touching':'clear'});

test('classification uses A > window > B > C and preserves every observed type', () => {
  assert.equal(assess([touch('equipment',false,false)]).classification,'C');
  assert.equal(assess([touch('equipment',true,false)]).classification,'B');
  assert.equal(assess([touch('equipment',true,true)]).classification,'A');
  assert.equal(assess([touch('line',true,true)]).classification,'A');
  assert.equal(assess([touch('line',true,false)]).classification,'window');
  assert.equal(assess([touch('line',false,true)]).classification,'A');
  const simultaneous=assess([touch('equipment',true,true),touch('line',true,false)]);
  assert.equal(simultaneous.classification,'A');
  assert.deepEqual(simultaneous.classifications,['A','window','B']);
  assert.deepEqual(assess([touch('equipment',false,false)]).classifications,['C']);
});

test('all twenty declared and observed class combinations follow the escalation matrix', () => {
  const observed=['A','window','B','C'] as const;
  const fixtures=[touch('equipment',false,true),touch('line',true,false),touch('equipment',true,false),touch('equipment',false,false)];
  const expected:Record<RailSafetyDeclaredConstructionClass,readonly RailSafetyConstructionClass[]>={
    A:[],window:['A'],B:['A','window'],C:['A','window','B'],'B+window':['A'],
  };
  for (const declared of ['A','window','B','C','B+window'] as const) for(let index=0;index<observed.length;index++) {
    const result=assess([fixtures[index]],declared), actual=observed[index];
    assert.equal(result.classification,actual,declared+' observes '+actual);
    assert.deepEqual(result.classifications,[actual]);
    assert.deepEqual(result.alarms.map(alarm=>alarm.classification),expected[declared].includes(actual)?[actual]:[],declared+' -> '+actual);
  }
});

test('simultaneous A and window contacts produce separate alarms and combined declarations suppress only permitted levels', () => {
  for (const declared of ['A','window','B','C','B+window'] as const) {
    const result=assess([touch('line',true,true)],declared);
    assert.equal(result.classification,'A');
    assert.deepEqual(result.classifications,['A','window']);
    const expected={A:[],window:['A'],B:['A','window'],C:['A','window'],'B+window':['A']}[declared];
    assert.deepEqual(result.alarms.map(alarm=>alarm.classification),expected);
    for(const alarm of result.alarms) {
      assert.equal(alarm.kind,'classification');
      assert.match(alarm.message,alarm.classification==='A'?/工作范围触及/:/倾覆范围触及铁路线路/);
    }
  }
});

test('same-class limit contacts are grouped without dropping any distinct cause', () => {
  const result=assess([
    {...touch('equipment',true,true),name:'设备甲'},
    {...touch('equipment',false,true),name:'设备乙'},
    {...touch('line',true,false),name:'线路甲'},
    {...touch('line',true,false),name:'线路乙'},
    {...touch('line',true,false),name:'线路甲'},
  ],'C');
  assert.deepEqual(result.alarms.map(alarm=>alarm.classification),['A','window','B']);
  assert.match(result.alarms[0].message,/设备甲.*设备乙/);
  assert.match(result.alarms[1].message,/线路甲.*线路乙/);
  assert.equal(result.alarms[1].message.match(/线路甲/g)?.length,1);
});

test('missing boundaries cannot become C or suppress known independent alarms', () => {
  const unavailable:RailSafetyLimitAssessment={name:'缺失限界',status:'unknown',workStatus:'unknown'};
  const missing=assess([unavailable]);
  assert.equal(missing.classification,'unknown');
  assert.deepEqual(missing.classifications,[]);
  const partial=assess([unavailable,touch('line',true,true)],'B');
  assert.equal(partial.classification,'A');
  assert.equal(partial.classificationComplete,false);
  assert.deepEqual(partial.classifications,['A','window']);
  assert.deepEqual(partial.alarms.map(alarm=>alarm.classification),['A','window']);
  const partialFall=assess([{name:'线路',limitType:'line',status:'overlap',workStatus:'unknown'}],'B');
  assert.deepEqual(partialFall.alarms.map(alarm=>alarm.classification),['window']);
  const partialWork=assess([{name:'线路',limitType:'line',status:'unknown',workStatus:'overlap'}],'B+window');
  assert.deepEqual(partialWork.alarms.map(alarm=>alarm.classification),['A']);
  assert.equal(assess([]).classification,'unknown');
  assert.equal(assess([{name:'旧设备限界',status:'overlap',workStatus:'clear'}]).classification,'B');
});

test('activity and fixed construction-zone alarms survive missing limits and include boundary semantics', () => {
  const def={...configuration(),selectedLimitIds:[],activityPolygon:ring(0,-10,10,10),constructionZones:[{id:'window',name:'线路封锁区',classification:'window' as const,polygon:ring(2,-1,8,1)}]};
  const result=assessMachineryConstruction({state:state('B'),definition:def,limits:[],workRange});
  assert.equal(result.classification,'unknown');
  assert.equal(result.activityStatus,'inside','station on boundary is permitted');
  assert.equal(result.alarms.length,1);
  assert.equal(result.alarms[0].kind,'zone','work range touching zone boundary alarms');
  assert.equal(result.alarms[0].classification,'window');
  const moved=state('B'); moved.placement={...unprojectLocalToWgs84({x:-0.1,y:0},origin),heading:0};
  const outside=assessMachineryConstruction({state:moved,definition:def,limits:[]});
  assert.equal(outside.activityStatus,'outside');
  assert.equal(outside.alarms[0].kind,'activity');
  assert.equal(outside.alarms[0].classification,undefined);
});

test('all twenty declaration and fixed-zone combinations use the same permission matrix', () => {
  const expected:Record<RailSafetyDeclaredConstructionClass,readonly RailSafetyConstructionClass[]>={
    A:[],window:['A'],B:['A','window'],C:['A','window','B'],'B+window':['A'],
  };
  for (const declared of ['A','window','B','C','B+window'] as const) for(const classification of ['A','window','B','C'] as const) {
    const result=assessMachineryConstruction({
      state:state(declared),
      definition:{...configuration(),constructionZones:[{id:classification,name:classification,classification,polygon:ring(-1,-1,1,1)}]},
      limits:[],workRange,
    });
    assert.deepEqual(result.alarms.map(alarm=>alarm.classification),expected[declared].includes(classification)?[classification]:[],declared+' -> zone '+classification);
    for(const alarm of result.alarms) assert.equal(alarm.kind,'zone');
  }
});

test('simultaneous zones are split by type and grouped within the same type', () => {
  const zones=[['A','A区甲'],['window','天窗区'],['A','A区乙'],['B','B区']] as const;
  const result=assessMachineryConstruction({
    state:state('C'),definition:{...configuration(),constructionZones:zones.map(([classification,name],index)=>({id:String(index),name,classification,polygon:ring(-1,-1,1,1)}))},
    limits:[],workRange,
  });
  assert.deepEqual(result.alarms.map(alarm=>alarm.classification),['A','window','B']);
  assert.match(result.alarms[0].message,/A区甲.*A区乙/);
  assert.ok(result.alarms.every(alarm=>alarm.kind==='zone'));
  const combination=assessMachineryConstruction({
    state:state('B+window'),definition:{...configuration(),constructionZones:zones.map(([classification,name],index)=>({id:String(index),name,classification,polygon:ring(-1,-1,1,1)}))},
    limits:[],workRange,
  });
  assert.deepEqual(combination.alarms.map(alarm=>alarm.classification),['A']);
  assert.match(combination.alarms[0].message,/申报B类施工＋天窗点施工/);
});

test('missing declarations retain observed classifications without inventing permitted work', () => {
  const undeclared=state();delete undeclared.constructionClass;
  const result=assessMachineryConstruction({state:undeclared,definition:configuration(),limits:[touch('line',true,true)],workRange});
  assert.deepEqual(result.classifications,['A','window']);
  assert.equal(result.declaredClass,undefined);
  assert.deepEqual(result.alarms,[]);
});

test('attached surveyed polygons follow translation and clockwise heading, preserving relative elevation', () => {
  const anchor={...origin,heading:10}, polygon=ring(1,2,3,4).map(p=>({...p,height:125}));
  const placement={...unprojectLocalToWgs84({x:50,y:-20},origin),height:150,heading:100};
  const moved=transformAttachedRange({anchor,polygon},placement);
  for(let i=0;i<polygon.length;i++) {
    const before=projectWgs84ToLocal(polygon[i],anchor),after=projectWgs84ToLocal(moved[i],placement);
    assert.ok(Math.abs(after.x-before.y)<0.0001);assert.ok(Math.abs(after.y+before.x)<0.0001);assert.equal(moved[i].height,155);
  }
  assert.deepEqual(polygon.map(p=>p.height),[125,125,125,125]);
});

const fetcher:typeof fetch=async input=>new Response(new Uint8Array(await readFile(new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url))));
const assetPromise=loadMachineryAsset('crane',{baseUrl:new URL('../public/machinery/',import.meta.url).href,fetcher});

test('crane work disk uses the measured scaled bearing and covers every posed vertex', async () => {
  const asset=await assetPromise, parameters=resolveMachineryParameters(asset,defaultMachineryParameters(asset),{overall_scale:2,boom_rotation_deg:137,boom_elevation_deg:35});
  const metadata={...state(),parameters,placement:{...origin,heading:73}}, range=computeMachineryWorkRange(asset,metadata),mesh=computeMachineryGeometry(asset,parameters);
  const angle=73*Math.PI/180;
  for(const index of new Set(mesh.indices)) {
    const x=mesh.positions[index*3],z=mesh.positions[index*3+2];
    assert.notEqual(pointInPolygon({x:x*Math.sin(angle)+z*Math.cos(angle),y:x*Math.cos(angle)-z*Math.sin(angle)},range.polygon),'outside');
  }
  assert.equal(range.source,'model-rotation');assert.ok(range.radiusMeters!>0);assert.equal(range.heightMeters,mesh.bounds.max[1]);
  const {pivot_m}=asset.config.type==='crane'?asset.config.rotation:{pivot_m:[0,0,0]};
  const anchor=asset.config.reference_dimensions.anchor_m,pivotX=(pivot_m[0]-anchor[0])*parameters.overall_scale,pivotZ=(pivot_m[2]-anchor[2])*parameters.overall_scale;
  for(let degree=0;degree<360;degree++) {
    const a=degree*Math.PI/180,x=pivotX+range.radiusMeters!*Math.cos(a),z=pivotZ+range.radiusMeters!*Math.sin(a);
    assert.notEqual(pointInPolygon({x:x*Math.sin(angle)+z*Math.cos(angle),y:x*Math.cos(angle)-z*Math.sin(angle)},range.polygon),'outside');
  }
});

test('automatic range responds to extension/elevation/scale; full rotation does not change its radius', async () => {
  const asset=await assetPromise, defaults=defaultMachineryParameters(asset);
  const range=(patch:Record<string,number>)=>computeMachineryWorkRange(asset,{...state(),parameters:resolveMachineryParameters(asset,defaults,patch,{proportional:false})});
  const base=range({}),extended=range({boom_length_m:defaults.boom_length_m*2}),lower=range({boom_elevation_deg:30}),scaled=range({overall_scale:2}),slewed=range({boom_rotation_deg:263});
  assert.ok(extended.radiusMeters!>base.radiusMeters!);assert.ok(lower.radiusMeters!>base.radiusMeters!);
  assert.ok(Math.abs(scaled.radiusMeters!-base.radiusMeters!*2)<1e-8);assert.ok(Math.abs(slewed.radiusMeters!-base.radiusMeters!)<1e-8);
});

test('activity alarms remain active beyond 20 km and ignore elevation for horizontal membership', () => {
  const definition={...configuration(),activityPolygon:ring(-10,-10,10,10)};
  const far=state();far.placement={...origin,longitude:122,heading:0};
  const outside=assessMachineryConstruction({state:far,definition,limits:[]});
  assert.equal(outside.activityStatus,'outside');assert.equal(outside.alarms[0].kind,'activity');
  const elevated=state();elevated.placement.height=origin.height+25000;
  assert.equal(assessMachineryConstruction({state:elevated,definition,limits:[]}).activityStatus,'inside');
});

test('activity bounds cross the date line correctly and unsupported coordinates stay unknown', () => {
  const at={longitude:179.9999,latitude:31,height:0};
  const polygon=[[-100,-100],[100,-100],[100,100],[-100,100]].map(([x,y])=>unprojectLocalToWgs84({x,y},at));
  const definition={...configuration(),activityPolygon:polygon};
  const nearby=state();nearby.placement={...unprojectLocalToWgs84({x:40,y:0},at),heading:0};
  assert.ok(nearby.placement.longitude<0);
  assert.equal(assessMachineryConstruction({state:nearby,definition,limits:[]}).activityStatus,'inside');
  nearby.placement.longitude=-179;
  assert.equal(assessMachineryConstruction({state:nearby,definition,limits:[]}).activityStatus,'outside');
  nearby.placement.latitude=89.95;
  assert.equal(assessMachineryConstruction({state:nearby,definition,limits:[]}).activityStatus,'unknown');
  nearby.placement.latitude=NaN;
  assert.equal(assessMachineryConstruction({state:nearby,definition,limits:[]}).activityStatus,'unknown');
});
