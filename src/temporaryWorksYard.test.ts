import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildCampYard} from './temporaryWorksYard';
import {renderPlanningMesh, type PlanningVertex} from './temporaryWorksScene';
import type {Viewer} from 'cesium';
import type {XY} from './temporaryWorksArchitecture';

const height=(x:number,y:number)=>50+.035*x-.018*y;
const ring=(x:number,y:number,w:number,h:number):XY[]=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
function grid(nx:number,ny:number,skip=(_x:number,_y:number)=>false,step=1) {
  const vertices=Array.from({length:(nx+1)*(ny+1)},(_,i)=>{
    const x=(i%(nx+1))*step,y=Math.floor(i/(nx+1))*step;
    return {x,y,z:height(x,y)};
  });
  const triangles:number[][]=[];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    if(skip(i,j))continue;
    const a=j*(nx+1)+i;
    triangles.push([a,a+1,a+nx+2],[a,a+nx+2,a+nx+1]);
  }
  return {vertices,triangles};
}

test('camp flag platform and parking occupy surveyed clear space, away from buildings and an interior hole',()=>{
  const floor=grid(42,28,(x,y)=>x>=20&&x<24&&y>=11&&y<15);
  const offices=[ring(1,17,30,10),ring(32,1,9,26)];
  const original=JSON.stringify(floor);
  const r=buildCampYard(floor.vertices,floor.triangles,offices);
  assert.ok(r.flag);assert.equal(r.spaces,5);assert.ok(r.batches.length>6);
  const inHole=(x:number,y:number)=>x>20&&x<24&&y>11&&y<15;
  for(const b of r.batches) {
    for(const t of b.indices) {
      const [x,y,z]=b.positions.slice(3*t,3*t+3);
      assert.ok([x,y,z].every(Number.isFinite));
      assert.ok(x>=0&&x<=42&&y>=0&&y<=28&&!inHole(x,y));
      for(const [a,,c] of offices)assert.ok(x<=a[0] || y<=a[1] || x>=c[0] || y>=c[1]);
      assert.ok(z>=height(x,y)-1e-7);
    }
    // An edge with supported endpoints could nevertheless cross a small survey hole.
    for(let i=0;i<b.indices.length;i+=3) for(let j=0;j<3;j++) {
      const a=b.indices[i+j]*3,c=b.indices[i+(j+1)%3]*3;
      for(let k=0;k<=20;k++)assert.ok(!inHole((b.positions[a]*k+b.positions[c]*(20-k))/20,(b.positions[a+1]*k+b.positions[c+1]*(20-k))/20));
    }
  }
  const painted=r.batches.find(b=>b.color==='#f2eed5')!;
  for(let i=0;i<painted.positions.length;i+=3){
    const [x,y,z]=painted.positions.slice(i,i+3);assert.ok(Math.abs(z-height(x,y)-.035)<1e-7);
  }
  assert.equal(JSON.stringify(floor),original);
});

test('a collection of unconnected narrow islands or building-occupied space receives no invented facilities',()=>{
  const split=grid(23,12,(i)=>i%4===2);
  const none=buildCampYard(split.vertices,split.triangles,[]);
  assert.deepEqual(none,{flag:false,spaces:0,batches:[]});
  const yard=grid(20,20);
  assert.deepEqual(buildCampYard(yard.vertices,yard.triangles,[ring(-1,-1,22,22)]),none);
  const small=grid(8,5);
  const only=buildCampYard(small.vertices,small.triangles,[]);
  assert.equal(only.flag,true);assert.equal(only.spaces,0);
});

test('a thin parking strip cannot bridge a covered island gap through its maneuvering aisle',()=>{
  const split=grid(14,11,(_,j)=>j===7);
  const r=buildCampYard(split.vertices,split.triangles,[]);
  // 7 m covered widths permit rotated parking only; its entire 10.2 m aisle-and-bay must then run along x.
  const paint=r.batches.find(b=>b.color==='#f2eed5');
  if(paint) {
    const xs=paint.positions.filter((_,i)=>i%3===0),ys=paint.positions.filter((_,i)=>i%3===1);
    assert.ok(Math.abs(Math.max(...xs)-Math.min(...xs)-5.2)<.001);
    assert.ok(Math.max(...ys)<7 || Math.min(...ys)>8);
  }
});

test('opted-in project yard shares display/cleanup, and saved plans without the option retain their previous appearance',()=>{
  const m=grid(40,25);
  const verts:PlanningVertex[]=m.vertices.map(v=>({longitude:117+v.x/92300,latitude:32+v.y/111319.49,surfaceHeight:v.z,baseHeight:v.z-.4}));
  const cache=new Set<{show:boolean}>();
  const viewer={isDestroyed:()=>false,scene:{primitives:{add:(p:{show:boolean})=>cache.add(p),remove:(p:{show:boolean})=>cache.delete(p)},requestRender(){}}} as unknown as Viewer;
  const old=renderPlanningMesh(viewer,'camp',verts,m.triangles);
  assert.deepEqual(old.yard,{flag:false,spaces:0});old.destroy();
  const h=renderPlanningMesh(viewer,'camp',verts,m.triangles,undefined,undefined,true);
  assert.deepEqual(h.yard,{flag:true,spaces:5});h.show=false;
  for(const p of cache)assert.equal(p.show,false);
  h.destroy();assert.equal(cache.size,0);
});
