import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanCoordinateFrame, planningCadDrawing, readPlanningCad, sectionProfile, type PlanningCadCoordinates } from './temporaryWorksCad.ts';
import { parsePlanningDxf } from './temporaryWorksDxf.ts';
import type { CadImportEntity } from './cadImport.ts';

const pairs = (...parts: (string | number)[]) => parts.join('\r\n') + '\r\n';
const wrapDxf = (content: string) => pairs(0, 'SECTION', 2, 'ENTITIES') + content + pairs(0, 'ENDSEC', 0, 'EOF');
const line = (ax: number, ay: number, bx: number, by: number, layer = '用地'): CadImportEntity =>
  ({ type: 'POLYLINE', sourceType: 'LINE', vertices: [{ x: ax, y: ay }, { x: bx, y: by }], layer });
const near = (a: number, b: number, delta = 1e-5) => assert.ok(Math.abs(a - b) < delta, `${a} differs from ${b}`);

test('text DXF reads the declared closed boundary, smooths bulges and rejects paper-space entities', async () => {
  const lw = pairs(0, 'LWPOLYLINE', 8, '钢筋厂', 90, 3, 70, 1, 10, 0, 20, 0, 42, 0.5, 10, 8, 20, 0, 10, 4, 20, 5);
  const paper = pairs(0, 'LINE', 67, 1, 8, '图框', 10, 1, 20, 1, 11, 2, 21, 1);
  const d = await readPlanningCad(new File([wrapDxf(lw + paper)], '布局.DXF'));
  assert.equal(d.features.length, 1); assert.equal(d.features[0].layer, '钢筋厂'); assert.equal(d.features[0].closed, true);
  assert.ok(d.features[0].points.length > 3); assert.ok(d.features[0].points.some(p => p.y < 0));
});

test('text DXF handles legacy vertex records, unsupported block warnings and frozen layers', () => {
  const tables = pairs(0, 'SECTION', 2, 'TABLES', 0, 'LAYER', 2, '隐藏', 70, 1, 0, 'ENDSEC');
  const seg = pairs(0, 'POLYLINE', 8, '中心线', 70, 0, 0, 'VERTEX', 10, 0, 20, 2,
    0, 'VERTEX', 10, 8, 20, 3, 0, 'SEQEND', 0, 'LINE', 8, '隐藏', 10, 0, 20, 2, 11, 8, 21, 3, 0, 'INSERT', 2, 'BLOCK1');
  const parsed = parsePlanningDxf(tables + wrapDxf(seg));
  assert.equal(parsed.entities.length, 1); assert.equal(parsed.entities[0].closed, false);
  assert.deepEqual(parsed.entities[0].vertices.map(({x,y}) => [x,y]), [[0,2],[8,3]]);
  assert.match(parsed.warnings.join(''), /INSERT/);
});

test('the drawing reader refuses truncated, corrupt and binary DXF, unsupported files and aborted imports', async () => {
  const empty = pairs(0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 90, 2, 10, 1, 20, 2, 10, 4);
  assert.throws(() => parsePlanningDxf(empty), /完整/);
  await assert.rejects(readPlanningCad(new File([empty + pairs(0, 'ENDSEC', 0, 'EOF')], '错误.dxf')), /无效|可用几何/);
  await assert.rejects(readPlanningCad(new File(['AutoCAD Binary DXF\r\n'], '错误.dxf')), /二进制/);
  await assert.rejects(readPlanningCad(new File([''], '错误.pdf')), /DWG/);
  await assert.rejects(readPlanningCad(new File([''], '错误.dwg'), AbortSignal.abort()), { name: 'AbortError' });
});

test('separate LINEs form one loop, retain individual lines, and never bridge branches, layers or gaps', () => {
  const a = line(0,0,2,0), b = line(2,0,2,2), c = line(0,2,2,2), d = line(0,0,0,2);
  const drawing = planningCadDrawing([a,b,c,d]);
  assert.equal(drawing.features.length,5); assert.equal(drawing.features[0].closed,true);
  assert.deepEqual(drawing.features[0].points,[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}]);
  assert.equal(planningCadDrawing([a,b,c,d,line(0,0,-1,-1)]).features.length,5);
  assert.equal(planningCadDrawing([a,line(2,0,2,2,'other')]).features.length,2);
  assert.equal(planningCadDrawing([a,line(2.000001,0,2,2)]).features.length,2);
  assert.deepEqual(planningCadDrawing([a,b]).features[0].points, [{x:0,y:0},{x:2,y:0},{x:2,y:2}]);
});

test('section horizontal unit and interpolation retain the real asymmetrical shape when CAD vertices run backwards', () => {
  const feature = planningCadDrawing([{ type:'POLYLINE',sourceType:'POLYLINE',layer:'面层',closed:false,
    vertices:[{x:12000,y:1810},{x:6000,y:2050},{x:2000,y:1850}] }]).features[0];
  const profile = sectionProfile(feature,'mm');
  near(profile.width,10);
  assert.deepEqual(profile.points.map(p => p.offset),[-5,-1,5]);
  near(profile.points[0].rise,-.16); near(profile.points[1].rise,.04); near(profile.points[2].rise,-.2);
  assert.throws(() => sectionProfile({...feature,closed:true},'m'), /未闭合/);
  assert.throws(() => sectionProfile({...feature,points:[{x:0,y:2},{x:0,y:0},{x:2,y:0}]},'m'), /竖边/);
});

test('local control point handles millimetres, surveying XY order, positive CCW rotation and independent reference', () => {
  const opt: PlanningCadCoordinates = {mode:'local',referenceX:13000,referenceY:14000,longitude:121,latitude:31,rotation:90,
    unit:'mm',axisOrder:'northEast'};
  const ref = {x:13000,y:14000};
  const frame = createPlanCoordinateFrame(opt,ref), p = frame.cadToLocal({x:ref.x+2000,y:ref.y+3000});
  near(frame.origin.longitude,121); near(frame.origin.latitude,31); near(p.x,-2); near(p.y,3);
  const newFrame = createPlanCoordinateFrame(opt,{x:ref.x+2000,y:ref.y+3000});
  const geo = frame.localToGeo(p);
  near(geo.longitude,newFrame.origin.longitude,1e-9); near(geo.latitude,newFrame.origin.latitude,1e-9);
  const back = frame.geoToLocal(geo); near(back.x,p.x); near(back.y,p.y);
});

test('CGCS2000 checks million-prefix, units and axes at the 120° central meridian; geographic drawings retain degrees', () => {
  const base: PlanningCadCoordinates = {mode:'gaussKruger',centralMeridian:120,zoneNumber:40,axisOrder:'northEast',hasZonePrefix:true,unit:'cm'};
  const frame = createPlanCoordinateFrame(base, {x:0,y:4050000000});
  near(frame.origin.longitude,120,1e-10); near(frame.origin.latitude,0,1e-10);
  near(frame.cadToLocal({x:1000,y:4050000000}).y,10);
  assert.throws(()=>createPlanCoordinateFrame({...base,zoneNumber:39},{x:0,y:4050000000}), /带号前缀/);
  const geo=createPlanCoordinateFrame({mode:'geographic',axisOrder:'northEast'},{x:31,y:121});
  assert.deepEqual(geo.origin,{longitude:121,latitude:31}); assert.ok(geo.cadToLocal({x:31,y:121.001}).x>90);
  assert.throws(()=>createPlanCoordinateFrame({mode:'geographic',axisOrder:'eastNorth'},{x:31,y:121}),/经纬度/);
});

test('saved platform CADIMPORT can be reused without a second coordinate or unit conversion', async () => {
  const pkg = {format:'cesium-cad-import',version:2,entities:[line(801,4090,801,4105,'便道轴线')],warnings:[]};
  const d = await readPlanningCad(new File([JSON.stringify(pkg)],'便道.cadimport'));
  assert.deepEqual(d.features[0].points,[{x:801,y:4090},{x:801,y:4105}]);
  assert.equal(d.features[0].layer,'便道轴线');
});

test('never measures a DWG/CADIMPORT SPLINE control polygon, even when displayed as a closed polyline', async () => {
  const spline = {type:'POLYLINE', sourceType:'SPLINE', layer:'边界', closed:true, vertices:[{x:0,y:0},{x:100,y:300},{x:0,y:100}]};
  const file = (entities: unknown[]) => new File([JSON.stringify({format:'cesium-cad-import',version:2,entities})], '规划.cadimport');
  const mixed = await readPlanningCad(file([spline,line(0,0,10,5)]));
  assert.deepEqual(mixed.features.map(f => f.sourceType), ['LINE']);
  assert.match(mixed.warnings[0], /1 条 SPLINE.*转换为普通多段线/);
  await assert.rejects(readPlanningCad(file([spline])), /SPLINE.*转换为普通多段线/);
  await assert.rejects(readPlanningCad(new File([wrapDxf(pairs(0,'SPLINE',8,'边界',70,1))], '规划.dxf')), /SPLINE.*转换为普通多段线/);
});

test('road axes preserve circular and straight lengths from a mixed-bulge DXF including reversed drawing curvature', async () => {
  for (const bulge of [1, -1]) {
    const lw = pairs(0,'LWPOLYLINE',8,'轴线',90,3,10,0,20,0,42,bulge,10,200,20,0,10,200,20,100);
    const d = await readPlanningCad(new File([wrapDxf(lw)],'带弧中线.dxf'));
    const f = d.features[0];
    assert.equal(f.stationFactors?.length, f.points.length - 1);
    const length = f.stationFactors!.reduce((v,k,i) => v + k*Math.hypot(f.points[i+1].x - f.points[i].x, f.points[i+1].y - f.points[i].y), 0);
    near(length,100*Math.PI + 100,1e-8);
    assert.equal(f.stationFactors!.at(-1),1);
  }
});

test('previously flattened or invalid CADIMPORT curve lengths fall back to the known polyline', async () => {
  const curve = {type:'POLYLINE', sourceType:'ARC', layer:'A', vertices:[{x:0,y:0},{x:1,y:1},{x:2,y:1}]};
  for (const attrs of [{}, {stationFactors:[1,10]}, {stationFactors:[1.0002]}]) {
    const file = new File([JSON.stringify({format:'cesium-cad-import',version:2,entities:[{...curve,...attrs}]})],'旧线.cadimport');
    const [f] = (await readPlanningCad(file)).features;
    assert.equal(f.stationFactors,undefined);
    assert.deepEqual(f.points,curve.vertices);
  }
});

test('separate tangent, arc and polyline form a selectable route with analytical chainage in either CAD direction', async () => {
  const arc = pairs(0,'ARC',8,'轴',10,0,20,0,40,100,50,0,51,180);
  const poly = pairs(0,'LWPOLYLINE',8,'轴',90,3,10,100,20,0,10,100,20,-40,10,120,20,-40);
  for (const reversed of [false,true]) {
    const tangent = pairs(0,'LINE',8,'轴',10,-100,20,reversed ? 0 : 50,11,-100,21,reversed ? 50 : 0);
    const {features} = await readPlanningCad(new File([wrapDxf(tangent + arc + poly)],'复合轴线.dxf'));
    const [axis] = features;
    assert.equal(features.length,4); assert.equal(axis.sourceType,'组合中心线'); assert.equal(axis.closed,false);
    assert.deepEqual(axis.points[0], reversed ? {x:120,y:-40} : {x:-100,y:50});
    assert.deepEqual(axis.points.at(-1), reversed ? {x:-100,y:50} : {x:120,y:-40});
    assert.equal(axis.stationFactors?.length,axis.points.length-1);
    const length = axis.stationFactors!.reduce((v,k,i) => v+k*Math.hypot(axis.points[i+1].x-axis.points[i].x,axis.points[i+1].y-axis.points[i].y),0);
    near(length,110+100*Math.PI,1e-9);
    assert.equal(axis.stationFactors?.[0],1); assert.equal(axis.stationFactors?.at(-1),1);
  }
});

test('mixed routes refuse genuine gaps, crossing layers, branches and mixed loops; existing closed LINE parcels remain', () => {
  const arc: CadImportEntity = { type:'POLYLINE', sourceType:'ARC', layer:'A',
    vertices:[{x:0,y:1e-14},{x:1,y:1},{x:2,y:1e-14}] };
  const L = (ax:number,ay:number,bx:number,by:number) => line(ax,ay,bx,by,'A');
  const isMixed = (entities:CadImportEntity[]) => planningCadDrawing(entities).features.some(f=>f.sourceType==='组合中心线');
  assert.equal(isMixed([L(-1,0,0,1e-10), arc]),false);
  assert.equal(isMixed([L(-1,0,0,1e-14), {...arc,layer:'B'}]),false);
  assert.equal(isMixed([L(-1,0,0,1e-14), L(0,1e-14,0,-3), arc]),false);
  assert.equal(isMixed([L(0,1e-14,2,1e-14), arc]),false);
  const square = [L(0,0,3,0),L(3,0,3,3),L(3,3,0,3),L(0,3,0,0)];
  const mixed = planningCadDrawing([...square, {...arc, vertices:[{x:3,y:3},{x:4,y:3},{x:5,y:4}]}]).features;
  assert.equal(mixed.filter(f=>f.closed && f.sourceType==='LINE 组合').length,1);
  assert.equal(mixed.filter(f=>f.sourceType==='组合中心线').length,0);
});
