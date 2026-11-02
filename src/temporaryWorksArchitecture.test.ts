import assert from 'node:assert/strict';
import test from 'node:test';
import {facilityGeometry,type FacilitySurface,type XY} from './temporaryWorksArchitecture.ts';

function panel(x:number,y:number,w:number,h:number) {
  return [{x,y,z:1},{x:x+w,y,z:1},{x:x+w,y:y+h,z:1},{x,y:y+h,z:1}];
}
const footprint:XY[]=[[0,0],[32,0],[32,15],[0,15]];
const shape:FacilitySurface={outline:footprint,height:6.5,vertices:panel(0,0,32,15),triangles:[[0,1,2],[0,2,3]]};
test('modular camp facades have distinct glazing, entry, frame, pitched roof and continuous roof coverage',()=>{
  const display=facilityGeometry('camp',shape);
  for(const key of ['roof','wall','glass','trim','door','seam'])assert.ok(display.some(b=>b.finish===key),key);
  const roof=display.find(b=>b.finish==='roof')!;
  let area=0, min=Infinity,max=-Infinity;
  for(let i=0;i<roof.indices.length;i+=3){
    const pts=roof.indices.slice(i,i+3).map(k=>roof.positions.slice(k*3,k*3+3));
    const [a,b,c]=pts;
    area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
    for(const p of pts){min=Math.min(min,p[2]);max=Math.max(max,p[2]);}
  }
  assert.equal(area,480);assert.equal(max,7.5);assert.ok(max-min>.4);
  assert.ok(display.every(b=>b.uv.length*3===b.positions.length*2));
});
test('clipped workshop has no walls across survey cuts and keeps its roof and frames within coverage',()=>{
  // Y=5..9 is unmeasured, running across the centre of every portal frame.
  const vertices=[...panel(0,0,32,5),...panel(0,9,32,6)];
  const display=facilityGeometry('steel',{...shape,showCompanySign:false,vertices,triangles:[[0,1,2],[0,2,3],[4,5,6],[4,6,7]]});
  const frames=display.find(b=>b.finish==='frame')!;
  assert.ok(frames.indices.length>60);
  assert.ok(display.some(b=>b.finish==='cladding'));
  for(const b of display.filter(b=>['cladding','shutter','steelBand','panelRib','glass','skirting'].includes(b.finish)))
    for(let i=0;i<b.indices.length;i+=3) {
      const y=b.indices.slice(i,i+3).map(k=>b.positions[3*k+1]);
      assert.ok(![5,9].some(edge=>y.every(value=>Math.abs(edge-value)<1e-9)), 'invented wall along survey cut');
    }
  for(const b of display)for(let i=0;i<b.indices.length;i+=3){
    const vs=b.indices.slice(i,i+3).map(k=>b.positions.slice(k*3,k*3+3));
    assert.ok(vs.every(v=>v.every(Number.isFinite)));
    assert.ok(vs.every(v=>v[1]<=5+1e-9)||vs.every(v=>v[1]>=9-1e-9),'display spans the coverage gap');
    assert.ok(vs.every(v=>v[0]>=-1e-8&&v[0]<=32+1e-8&&v[1]>=-1e-8&&v[1]<=15+1e-8));
  }
});

test('steel cladding, closed roller gate and glazing tile every measured exterior wall from slab to eave',()=>{
  // The CAD gable includes a redundant vertex. The clipped face spans both
  // CAD segments; this must not introduce a missing wall or duplicate doors.
  const outline:XY[]=[[0,0],[32,0],[32,5],[32,15],[0,15]];
  for(const order of [outline,[...outline].reverse()]) {
    const display=facilityGeometry('steel',{...shape,outline:order,showCompanySign:false});
    for(const key of ['cladding','steelBand','skirting','shutter','glass','roof','frame']) {
      assert.ok(display.some(b=>b.finish===key), key);
    }
    const area=[0,0,0,0];
    const faces=[(p:number[])=>p[1],(p:number[])=>p[0]-32,(p:number[])=>p[1]-15,(p:number[])=>p[0]];
    for(const b of display)for(let i=0;i<b.indices.length;i+=3) {
      const points=b.indices.slice(i,i+3).map(k=>b.positions.slice(3*k,3*k+3));
      const side=faces.findIndex(delta=>points.every(p=>Math.abs(delta(p))<1e-7));
      if(side<0)continue;
      const [a,c,d]=points;
      const axis=(side%2===0)?0:1;
      area[side]+=Math.abs((c[axis]-a[axis])*(d[2]-a[2])-(d[axis]-a[axis])*(c[2]-a[2]))/2;
    }
    const eaveHeight=6.5-7.5*.115;
    const target=[32*eaveHeight,15*(6.5+eaveHeight)/2,32*eaveHeight,15*(6.5+eaveHeight)/2];
    area.forEach((value,i)=>assert.ok(Math.abs(value-target[i])<1e-6, `wall ${i}: ${value} vs ${target[i]}`));
  }
});
