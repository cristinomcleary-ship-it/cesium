import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { getTemporaryWorksGlbFootprints, getTemporaryWorksGlbModelMatrix, getTemporaryWorksGlbScale,
  uniformTemporaryWorksGlbDimensions, validateTemporaryWorksGlbResource,
  type TemporaryWorksGlbPlacement, type TemporaryWorksGlbResource } from './temporaryWorksGlb.ts';

const asset: TemporaryWorksGlbResource = {id:'camp',name:'测试底面',url:'models/test.glb',upAxis:'Y',
  bounds:{min:[100,7,200],max:[120,12,210]},anchor:[110,7,205],dimensions:{length:20,width:10,height:5},
  footprints:[{outer:[[100,200],[120,200],[120,210],[100,210]],holes:[[[108,203],[112,203],[112,207],[108,207]]]}]};
const placement: TemporaryWorksGlbPlacement = {longitude:121.5,latitude:31.2,height:38,headingDeg:0,
  scaleMode:'uniform',dimensions:{length:40,width:20,height:10}};
const near = (a:number,b:number,tolerance=1e-7) => assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const local = (p:Cartesian3) => Matrix4.multiplyByPoint(Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(placement.longitude,placement.latitude,placement.height)),new Matrix4()),p,new Cartesian3());

test('bottom anchor with nonzero source origin lands exactly at requested WGS84 elevation',()=>{
  const matrix=getTemporaryWorksGlbModelMatrix(asset,placement);
  const actual=Matrix4.multiplyByPoint(matrix,Cartesian3.fromArray(asset.anchor),new Cartesian3());
  near(Cartesian3.distance(actual,Cartesian3.fromDegrees(placement.longitude,placement.latitude,placement.height)),0);
});
test('Y up becomes vertical and source +Z becomes south with no implicit second axis correction',()=>{
  const matrix=getTemporaryWorksGlbModelMatrix(asset,placement);
  const top=local(Matrix4.multiplyByPoint(matrix,new Cartesian3(110,12,205),new Cartesian3()));
  near(top.x,0);near(top.y,0);near(top.z,10);
  const south=local(Matrix4.multiplyByPoint(matrix,new Cartesian3(110,7,210),new Cartesian3()));
  near(south.y,-10);near(south.z,0);
});
test('counterclockwise rotation sends the length axis east to north',()=>{
  const matrix=getTemporaryWorksGlbModelMatrix(asset,{...placement,headingDeg:90});
  const p=local(Matrix4.multiplyByPoint(matrix,new Cartesian3(120,7,205),new Cartesian3()));
  near(p.x,0);near(p.y,20);near(p.z,0);
});
test('advanced independent dimensions scale all axes around bottom anchor',()=>{
  const p={...placement,scaleMode:'xyz' as const,dimensions:{length:60,width:10,height:20}};
  assert.deepEqual(getTemporaryWorksGlbScale(asset,p),{x:3,y:1,z:4});
  const point=local(Matrix4.multiplyByPoint(getTemporaryWorksGlbModelMatrix(asset,p),new Cartesian3(120,12,210),new Cartesian3()));
  near(point.x,30);near(point.y,-5);near(point.z,20);
});
test('Z up input preserves vertical axis and works with elevated nonzero anchor',()=>{
  const zAsset={...asset,upAxis:'Z' as const,bounds:{min:[100,200,7] as [number,number,number],max:[120,210,12] as [number,number,number]},anchor:[110,205,7] as [number,number,number]};
  const top=local(Matrix4.multiplyByPoint(getTemporaryWorksGlbModelMatrix(zAsset,placement),new Cartesian3(110,205,12),new Cartesian3()));
  near(top.z,10);near(top.x,0);near(top.y,0);
});
test('footprint and holes follow the same matrix as the model geometry',()=>{
  const matrix=getTemporaryWorksGlbModelMatrix(asset,placement),polygons=getTemporaryWorksGlbFootprints(asset,placement);
  assert.equal(polygons.length,1);assert.equal(polygons[0].holes.length,1);
  const expected=Cartographic.fromCartesian(Matrix4.multiplyByPoint(matrix,new Cartesian3(100,7,200),new Cartesian3()));
  near(polygons[0].outer[0].longitude,CesiumMath.toDegrees(expected.longitude),1e-10);
  near(polygons[0].outer[0].latitude,CesiumMath.toDegrees(expected.latitude),1e-10);
});
test('uniform mode rejects distorted target dimensions',()=>{
  assert.throws(()=>getTemporaryWorksGlbScale(asset,{...placement,dimensions:{length:40,width:10,height:5}}),/等比例/);
});
test('any selected dimension can drive proportional scaling',()=>{
  assert.deepEqual(uniformTemporaryWorksGlbDimensions(asset,'height',15),{length:60,width:30,height:15});
  assert.deepEqual(uniformTemporaryWorksGlbDimensions(asset,'width',5),{length:10,width:5,height:2.5});
});
test('missing verified footprint is rejected instead of silently using bounding box',()=>{
  assert.throws(()=>validateTemporaryWorksGlbResource({...asset,footprints:[]}),/底面/);
});
test('nonfinite/zero scales and invalid geographical coordinates are rejected',()=>{
  for(const bad of [{longitude:181},{latitude:91},{height:NaN},{headingDeg:Infinity},{dimensions:{length:0,width:1,height:1}}])
    assert.throws(()=>getTemporaryWorksGlbModelMatrix(asset,{...placement,...bad}));
});
test('serialized placement restores identical world matrix and clipping polygons',()=>{
  const recovered=JSON.parse(JSON.stringify(placement));
  assert.deepEqual(Matrix4.toArray(getTemporaryWorksGlbModelMatrix(asset,recovered)),Matrix4.toArray(getTemporaryWorksGlbModelMatrix(asset,placement)));
  assert.deepEqual(getTemporaryWorksGlbFootprints(asset,recovered),getTemporaryWorksGlbFootprints(asset,placement));
});
test('dimensions use validated asset geometry rather than assuming source values are metres without hierarchy transforms',()=>{
  // The audited dimensions already include source node metre conversion. Raw accessor bounds are deliberately not read here.
  assert.deepEqual(getTemporaryWorksGlbScale(asset,placement),{x:2,y:2,z:2});
  assert.throws(()=>validateTemporaryWorksGlbResource({...asset,bounds:{min:[0,0,0],max:[0,1,1]}}),/尺寸/);
});
