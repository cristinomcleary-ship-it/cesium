import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlanCoordinateFrame,createRoadCoordinateFrame,type PlanningCadFeature,type PlanningCadCoordinates} from './temporaryWorksCad.ts';
import {fitPlanningControls,preparePlanningCadPreview,sampledPlanningCadLines} from './temporaryWorksPlacement.ts';

const A={x:523417.65432,y:3357890.01234};
const geo={longitude:120.04621,latitude:30.34215};
const local={mode:'local',unit:'m',axisOrder:'eastNorth',referenceX:A.x,referenceY:A.y,...geo,rotation:0} as const;
const feature=(points:typeof A[], closed=false):PlanningCadFeature=>({id:'check', layer:'survey', sourceType:'LWPOLYLINE',points,closed});
const p=(x:number,y:number)=>({x:A.x+x,y:A.y+y});
const near=(a:number,b:number,delta=1e-6)=>assert.ok(Math.abs(a-b)<=delta,`${a} differs from ${b}`);

test('two control points recover rotation, unit and axis order without scaling design chainage',()=>{
  for(const unit of ['m','cm','mm'] as const) for(const axisOrder of ['eastNorth','northEast'] as const) {
    const factor={m:1,cm:.01,mm:.001}[unit];
    const options={...local,unit,axisOrder,rotation:37.8};
    const frame=createRoadCoordinateFrame(options,A);
    const B=p(1600/factor,1200/factor), P=p(399.9/factor,-450/factor);
    const fit=fitPlanningControls({geo,cad:A},{geo:frame.localToGeo(frame.cadToLocal(B)),cad:B},unit,axisOrder);
    near(fit.rotation,37.8,1e-6);near(fit.drawingDistance,2000,1e-6);near(fit.residual,0,2e-6);
    const fitted=createRoadCoordinateFrame({...options,rotation:fit.rotation},A);
    const result=fitted.localToGeo(fitted.cadToLocal(P)), expected=frame.localToGeo(frame.cadToLocal(P));
    near(result.latitude,expected.latitude,1e-10);near(result.longitude,expected.longitude,1e-10);
    const C=p(1584/factor,1188/factor);
    const mismatch=fitPlanningControls({geo,cad:A},{geo:frame.localToGeo(frame.cadToLocal(B)),cad:C},unit,axisOrder);
    near(mismatch.residual,20,1e-5);near(mismatch.drawingDistance,1980,1e-6);
  }
  assert.throws(()=>fitPlanningControls({geo,cad:A},{geo,cad:p(30,0)},'m','eastNorth'),/过近/);
});

test('preview retains actual CAD corners and uses the same coordinates and directed ends as the calculation',()=>{
  const path=feature([A,p(8,0),p(8,2),p(14,2),p(18,6),p(29,6)]);
  for(const cfg of [local,{mode:'gaussKruger',unit:'m',axisOrder:'eastNorth',centralMeridian:117,hasZonePrefix:false,zoneNumber:0}] as const) {
    const frame=createRoadCoordinateFrame(cfg,A);
    const d=preparePlanningCadPreview({kind:'road',feature:path,coordinates:cfg,width:6,reversed:true});
    const axis=d.traces.find(t=>t.role==='axis')!;
    for(const point of path.points) {
      const expected=frame.localToGeo(frame.cadToLocal(point));
      assert.ok(axis.nodes.some(n=>Math.abs(n.geo.longitude-expected.longitude)<1e-12 && Math.abs(n.geo.latitude-expected.latitude)<1e-12));
    }
    assert.deepEqual(axis.nodes[0].geo,frame.localToGeo(frame.cadToLocal(path.points.at(-1)!)));
    const last=d.traces.filter(t=>t.role==='width').at(-1)!;
    const left=frame.geoToLocal(last.nodes[0].geo),right=frame.geoToLocal(last.nodes.at(-1)!.geo);
    near(Math.hypot(left.x-right.x,left.y-right.y),6,1e-5);
  }
});

test('site boundary and selected building preview close independently in the hardstand coordinate frame',()=>{
  const yard=feature([A,p(24,0),p(23,26),p(0,23)],true);
  const house=feature([p(10,10),p(16,10),p(16,18),p(10,18)],true);
  const cfg:PlanningCadCoordinates={...local,rotation:-52.3};
  const d=preparePlanningCadPreview({kind:'steel',feature:yard,buildings:[house],coordinates:cfg});
  assert.deepEqual(d.traces.map(t=>t.role),['boundary','building']);
  const frame=createPlanCoordinateFrame(cfg,A);
  for(const [i,f] of [yard,house].entries()) {
    const nodes=d.traces[i].nodes;assert.deepEqual(nodes[0].geo,nodes.at(-1)!.geo);
    for(const p of f.points) assert.ok(nodes.some(n=>n.geo.longitude===frame.localToGeo(frame.cadToLocal(p)).longitude));
  }
});

test('a gap in the selected photogrammetry splits the trace even when another model covers the gap',()=>{
  const d=preparePlanningCadPreview({kind:'road',feature:feature([A,p(30,0)]),coordinates:local});
  const heights=d.samples.map((_,i)=>i===2?null:8+i);
  const lines=sampledPlanningCadLines(d.traces,heights);
  assert.equal(lines.length,2);
  assert.deepEqual(lines[0].points.map(p=>p.height),[8,9]);
  assert.deepEqual(lines[1].points.map(p=>p.height),[11,12,13]);
  assert.deepEqual(sampledPlanningCadLines(d.traces,d.samples.map(()=>null)),[]);
});

test('partial road preview refines covered ends and leaves an internal gap open',()=>{
  const d=preparePlanningCadPreview({kind:'road',feature:feature([A,p(36,0)]),coordinates:local});
  const frame=createRoadCoordinateFrame(local,A);
  const covers=(x:number)=>(x>=4.4 && x<=15.1) || (x>=22.4 && x<=28.6);
  const heights:(number|null)[]=[];
  function measureNew() {
    for(const point of d.samples.slice(heights.length)){
      const x=frame.geoToLocal(point).x;
      heights.push(covers(x)?0:null);
    }
  }
  measureNew();
  for(let level=0;level<2;level++){d.addRoadBoundaryProbes(heights);measureNew();}
  const runs=sampledPlanningCadLines(d.traces,heights);
  assert.equal(runs.length,2);
  const spans=runs.map(run=>run.points.map(v=>frame.geoToLocal(v).x));
  near(spans[0][0],4.5,1e-4);
  near(spans[0].at(-1)!,15,1e-4);
  near(spans[1][0],22.5,1e-4);
  near(spans[1].at(-1)!,28.5,1e-4);
  assert.ok(runs.every(line=>line.points.every(point=>point.height===0)));
});

test('the full road drawing includes both external ends and a hole, with no duplicate covered or missing spans',()=>{
  const d=preparePlanningCadPreview({kind:'road',feature:feature([A,p(48,0)]),coordinates:local});
  const heights=[null,0,0,null,null,8,8,null,null];
  assert.equal(heights.length,d.samples.length);
  const runs=sampledPlanningCadLines(d.traces,heights,100);
  assert.deepEqual(runs.map(r=>r.missing),[true,false,true,false,true]);
  assert.deepEqual(runs.map(r=>r.points.map(p=>p.height)),[[0,0],[0,0],[0,8/3,16/3,8],[8,8],[8,8,8]]);
  for(let i=1;i<runs.length;i++)assert.deepEqual(runs[i-1].points.at(-1),runs[i].points[0]);
  const axis=runs.flatMap((run,i)=>run.points.slice(i?1:0).map(({longitude,latitude})=>({longitude,latitude})));
  assert.deepEqual(axis,d.traces[0].nodes.map(node=>node.geo));
  assert.deepEqual(heights,[null,0,0,null,null,8,8,null,null]);
});

test('a wholly external road remains visible through every original bend and all covered roads have only solid spans',()=>{
  const path=feature([A,p(10,5),p(15,30),p(25,-8),p(40,0)]);
  const d=preparePlanningCadPreview({kind:'road',feature:path,coordinates:local,width:6,reversed:true});
  const lines=sampledPlanningCadLines(d.traces,d.samples.map(()=>null),72);
  assert.deepEqual(lines.map(l=>[l.role,l.missing]),[['axis',true]]);
  assert.deepEqual(lines[0].points,d.traces[0].nodes.map(n=>({...n.geo,height:72})));
  const covered=sampledPlanningCadLines(d.traces,d.samples.map(()=>0),72);
  assert.ok(covered.length>1 && covered.every(l=>!l.missing && l.points.every(p=>p.height===0)));
  assert.deepEqual(covered[0].points,d.traces[0].nodes.map(n=>({...n.geo,height:0})));
});

test('site drawings never add external outlines or width marks at a display height',()=>{
  const yard=feature([A,p(20,0),p(20,20),p(0,20)],true);
  const d=preparePlanningCadPreview({kind:'camp',feature:yard,buildings:[yard],coordinates:local});
  assert.deepEqual(sampledPlanningCadLines(d.traces,d.samples.map(()=>null),84),[]);
  const partial=d.samples.map((_,i)=>i===0?null:1);
  assert.deepEqual(sampledPlanningCadLines(d.traces,partial,84),sampledPlanningCadLines(d.traces,partial));
});
