import assert from "node:assert/strict";
import test from "node:test";
import { buildRaySurfaceGrid } from "./videoArSurface.ts";

test("independent rays preserve interior relief even with identical four boundary heights", () => {
  const grid = buildRaySurfaceGrid(8, 8, 0, (u,v) => {
    const height=20*Math.sin(Math.PI*u)*Math.sin(Math.PI*v), depth=100-height;
    return { position:{x:(u-.5)*depth,y:(v-.5)*depth,z:height},depth };
  });
  assert.ok(Math.max(...grid.positions.map(p=>p.z))>19);
  for(let i=0;i<grid.positions.length;i++) {
    const p=grid.positions[i],depth=100-p.z;
    assert.ok(Math.abs(p.x/depth+.5-grid.textureCoordinates[i*2])<1e-7);
    assert.ok(Math.abs(p.y/depth+.5-grid.textureCoordinates[i*2+1])<1e-7);
  }
});

test("missing surface intersections create holes without bridging invalid pixels", () => {
  const grid=buildRaySurfaceGrid(8,8,0,(u,v)=>Math.abs(u-.5)<.13&&Math.abs(v-.5)<.15?undefined:
    {position:{x:u*100,y:v*100,z:0},depth:100});
  assert.ok(grid.missingSamples>0); assert.ok(grid.rejectedTriangles>0);
  for (const i of grid.indices) assert.ok(grid.positions[i]);
  for (const p of grid.positions) assert.ok(!(Math.abs(p.x/100-.5)<.13&&Math.abs(p.y/100-.5)<.15));
});

test("depth discontinuities cannot create stretched triangles across a foreground edge", () => {
  const grid=buildRaySurfaceGrid(8,8,0,(u,v)=>{const depth=u<.5?20:100;return {position:{x:u*depth,y:v*depth,z:depth},depth};});
  assert.ok(grid.rejectedTriangles>0);
  for(let i=0;i<grid.indices.length;i+=3) {
    const depths=Array.from(grid.indices.slice(i,i+3),j=>grid.positions[j].z);
    assert.equal(Math.min(...depths),Math.max(...depths));
  }
});

test("camera depth weights reproduce the pinhole UV at spatial triangle interiors", () => {
  const grid=buildRaySurfaceGrid(1,1,.2,(u,v)=>{const depth=100/(1+.5*u+.4*v);
    return {position:{x:u*depth,y:v*depth,z:depth},depth};});
  const ids=Array.from(grid.indices.slice(0,3)),lambda=[.2,.3,.5];
  const world={x:0,y:0,z:0};let numeratorU=0,numeratorV=0,q=0;
  ids.forEach((id,i)=>{const p=grid.positions[id],w=grid.textureWeights[id]*lambda[i];
    world.x+=p.x*lambda[i];world.y+=p.y*lambda[i];world.z+=p.z*lambda[i];
    numeratorU+=grid.textureCoordinates[id*2]*w;numeratorV+=grid.textureCoordinates[id*2+1]*w;q+=w;});
  assert.ok(Math.abs(numeratorU/q-world.x/world.z)<1e-7);
  assert.ok(Math.abs(numeratorV/q-world.y/world.z)<1e-7);
});

test("invalid or behind-camera samples are rejected and grid allocation is bounded", () => {
  const grid=buildRaySurfaceGrid(2,2,0,()=>({position:{x:NaN,y:0,z:0},depth:-1}));
  assert.equal(grid.indices.length,0);assert.equal(grid.positions.length,0);assert.equal(grid.missingSamples,9);
  assert.throws(()=>buildRaySurfaceGrid(100000,2,0,()=>undefined));
});
