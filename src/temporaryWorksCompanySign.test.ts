import assert from 'node:assert/strict';
import test from 'node:test';
import { Color, ColorGeometryInstanceAttribute, type GeometryInstance, type Viewer } from 'cesium';
import { facilityGeometry, finishes, type XY, type FacilitySurface } from './temporaryWorksArchitecture';
import { COMPANY_NAME } from './temporaryWorksCompanySign';
import { titlePoints, titleTriangles, titleWidth } from './temporaryWorksCompanyArtwork';
import { renderPlanningMesh } from './temporaryWorksScene';

const quad = (west:number, east:number, south=0, north=14):XY[] => [[west,south],[east,south],[east,north],[west,north]];
function floor(outline:XY[], patches:XY[][] = [outline]):FacilitySurface {
  return {outline,height:6.5, vertices:patches.flat().map(([x,y])=>({x,y,z:0})),
    triangles:patches.flatMap((_,j)=>[[4*j,4*j+1,4*j+2],[4*j,4*j+2,4*j+3]])};
}

test('the offline corporate inscription has twelve distinct non-empty glyphs and faces the street in both CAD windings',()=>{
  assert.equal(COMPANY_NAME,'中铁二十四局集团有限公司');
  assert.equal([...COMPANY_NAME].length,12);
  const ink = new Set<number>();
  for (let j=0;j<titleTriangles.length;j+=3) {
    const [a,b,c] = titleTriangles.slice(j,j+3).map(i=>titlePoints.slice(2*i,2*i+2));
    assert.ok((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0,'degenerate or inverted glyph');
    ink.add(Math.floor((a[0]+b[0]+c[0])/3/1020));
  }
  assert.equal(ink.size,12);
  const shape=floor(quad(0,30));
  for (const outline of [shape.outline, [...shape.outline].reverse()]) {
    const parts=facilityGeometry('steel',{...shape,outline});
    const face=parts.find(p=>p.finish==='signFace')!, letters=parts.find(p=>p.finish==='signLetter')!;
    assert.equal(letters.indices.length,titleTriangles.length);
    assert.equal(letters.positions.length,3*titlePoints.length/2);
    const [x,y,bottom,right,, ,,,top] = face.positions;
    assert.ok(right-x>26 && y<0 && bottom>3 && top<6.5);
    for (let k=0;k<letters.positions.length;k+=3) {
      assert.ok(letters.positions[k]>x && letters.positions[k]<right);
      assert.ok(letters.positions[k+1]<y && y-letters.positions[k+1]<.03);
      assert.ok(letters.positions[k+2]>bottom && letters.positions[k+2]<top);
    }
    const indexA=titlePoints.findIndex((n,i)=>i%2===0 && n===0)/2;
    const indexB=titlePoints.findIndex((n,i)=>i%2===0 && n===titleWidth)/2;
    assert.ok(letters.positions[3*indexB]>letters.positions[3*indexA], 'first character must be on the left');
  }
});

test('company signs only span continuous measured original facades, including segmented CAD and coverage holes',()=>{
  const shape=floor([[0,0],[6,0],[14,0],[30,0],[30,14],[0,14]], [quad(0,12),quad(18,30)]);
  const parts=facilityGeometry('camp',shape);
  const sign=parts.find(p=>p.finish==='signFace')!;
  assert.ok(sign);
  // The long elevation has a 6 m unsupported break. A shorter end wall or a single
  // measured 12 m run can carry the plaque; the cut across the courtyard cannot.
  const points=Array.from({length:4},(_,i)=>sign.positions.slice(3*i,3*i+3));
  assert.ok(points.every(v=>v[0]<=12+.2) || points.every(v=>v[0]>=18-.2));
  assert.ok(points.every(v=>v[0]<=0 || v[0]>=30 || v[1]<=0 || v[1]>=14));
  for(const surface of [floor(quad(0,40,-5,20),[quad(3,8,0,8)]),{...shape,showCompanySign:false}]) {
    assert.ok(!facilityGeometry('camp',surface).some(p=>p.finish.startsWith('sign')));
  }
});

test('multiple surveyed office buildings yield exactly one primary nameplate; workshops each retain their own',()=>{
  const items = new Set<{geometryInstances:GeometryInstance[]}>();
  const viewer={isDestroyed:()=>false,scene:{primitives:{add:(p:{geometryInstances:GeometryInstance[]})=>items.add(p),
    remove:(p:{geometryInstances:GeometryInstance[]})=>items.delete(p)},requestRender:()=>{}}} as unknown as Viewer;
  const geo=([x,y]:XY)=>({longitude:118+x*1e-5, latitude:31+y*1e-5});
  const vertices=quad(0,90,0,60).map(p=>({...geo(p),surfaceHeight:0,baseHeight:-.3}));
  const buildings=[quad(2,11,4,10),quad(26,70,18,30)].map(r=>({footprint:r.map(geo),height:6}));
  const color=ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(finishes.signLetter)).value.toString();
  for(const kind of ['camp','steel'] as const) {
    const record=renderPlanningMesh(viewer,kind,vertices,[[0,1,2],[0,2,3]],buildings);
    const solid=Array.from(items)[0];
    const marks=solid.geometryInstances.filter(v=>v.attributes.color.value.toString()===color);
    assert.equal(marks.length,kind==='camp'?1:2);
    assert.ok(marks.every(s=>s.geometry.indices!.length===titleTriangles.length));
    record.destroy();
    assert.equal(items.size,0);
  }
});
