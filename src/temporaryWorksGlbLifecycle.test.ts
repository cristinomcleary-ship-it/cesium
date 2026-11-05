import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection, ClippingPolygonCollection, Event, Model, type Viewer } from 'cesium';
import { renderTemporaryWorksGlb } from './temporaryWorksGlbScene.ts';
import type { TemporaryWorksGlbConfig, TemporaryWorksGlbResource } from './temporaryWorksGlb.ts';

const asset:TemporaryWorksGlbResource={id:'camp',name:'lifecycle fixture',url:'models/fixture.glb',upAxis:'Y',
  bounds:{min:[100,7,200],max:[120,12,210]},anchor:[110,7,205],dimensions:{length:20,width:10,height:5},
  footprints:[{outer:[[100,200],[120,200],[120,210],[100,210]]}]};
const config:TemporaryWorksGlbConfig={resourceId:'camp',clippingEnabled:true,
  placement:{longitude:121,latitude:31,height:12,headingDeg:0,scaleMode:'uniform',dimensions:asset.dimensions}};
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};
}
function modelStub(show=true,ready=true) {
  let destroyed=false;
  const value={show,ready,errorEvent:new Event(),isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;}};
  return value;
}

function fixture() {
  const originalLoader=Model.fromGltfAsync,originalFetch=globalThis.fetch;
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:'http://localhost/'}}});
  globalThis.fetch=async()=>new Response(JSON.stringify({schemaVersion:1,assets:[asset]}),{status:200});
  const active=new Set<Model>(),entities=new Set<unknown>(),postUpdate=new Event();
  const viewer={scene:{context:{webgl2:true},postUpdate,primitives:{
    add:(m:Model)=>{active.add(m);return m;},contains:(m:Model)=>active.has(m),
    remove:(m:Model)=>{if(!active.delete(m))return false;m.destroy();return true;},
  },requestRender:()=>{}},entities:{add:(e:unknown)=>{entities.add(e);return e;},remove:(e:unknown)=>entities.delete(e)},
  isDestroyed:()=>false} as unknown as Viewer;
  const tileset=new Cesium3DTileset({}),other=new Cesium3DTileset({});
  const handles:ReturnType<typeof renderTemporaryWorksGlb>[]=[];
  const render=(id='saved-plan',extra:Partial<TemporaryWorksGlbConfig>={})=>{
    const handle=renderTemporaryWorksGlb(viewer,{...config,...extra,id,tileset});handles.push(handle);return handle;
  };
  return {active,tileset,other,postUpdate,render,close:()=>{
    handles.forEach(h=>h.destroy());
    if(!tileset.isDestroyed())tileset.destroy();if(!other.isDestroyed())other.destroy();
    Model.fromGltfAsync=originalLoader;globalThis.fetch=originalFetch;
    if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');
  }};
}

test('hide while GLB bytes are loading takes effect when asynchronous Model creation completes',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>(),model=modelStub();
  try {
    Model.fromGltfAsync=async options=>{assert.equal(options.show,true);entered.resolve();return loading.promise;};
    const handle=f.render();await entered.promise;
    handle.show=false;loading.resolve(model as unknown as Model);await handle.ready;
    assert.equal(handle.show,false);assert.equal(model.show,false);assert.equal(handle.status.state,'hidden');
    assert.equal(f.tileset.clippingPolygons,undefined);assert.equal(f.active.size,1);
  } finally {f.close();}
});

test('show during a hidden GLB load is not lost to the initial show snapshot',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>(),model=modelStub(false);
  try {
    Model.fromGltfAsync=async options=>{assert.equal(options.show,false);entered.resolve();return loading.promise;};
    const handle=f.render();handle.show=false;await entered.promise;
    handle.show=true;loading.resolve(model as unknown as Model);await handle.ready;
    assert.equal(model.show,true);assert.equal(handle.status.state,'ready');assert.equal(f.tileset.clippingPolygons.length,1);
  } finally {f.close();}
});

test('deleting a plan while bytes are loading destroys the late Model without attaching a primitive or clipping',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>(),model=modelStub();
  try {
    Model.fromGltfAsync=async()=>{entered.resolve();return loading.promise;};
    const handle=f.render();await entered.promise;handle.destroy();loading.resolve(model as unknown as Model);await handle.ready;
    assert.equal(model.isDestroyed(),true);assert.equal(f.active.size,0);assert.equal(f.tileset.clippingPolygons,undefined);
  } finally {f.close();}
});

test('deleting during GPU readiness polling releases the model and settles the pending handle',async()=>{
  const f=fixture(),added=deferred<void>(),model=modelStub(true,false);
  try {
    Model.fromGltfAsync=async()=>{queueMicrotask(()=>added.resolve());return model as unknown as Model;};
    const handle=f.render();await added.promise;await Promise.resolve();handle.destroy();await handle.ready;
    assert.equal(model.isDestroyed(),true);assert.equal(f.active.size,0);assert.equal(f.tileset.clippingPolygons,undefined);
    assert.equal(model.errorEvent.numberOfListeners,0);
  } finally {f.close();}
});

test('overlapping edit handles with the same saved ID own distinct clipping regions',async()=>{
  const f=fixture();
  try {
    Model.fromGltfAsync=async()=>modelStub() as unknown as Model;
    const old=f.render('same-id');await old.ready;
    const replacement=f.render('same-id',{placement:{...config.placement,longitude:121.001}});await replacement.ready;
    assert.equal(f.tileset.clippingPolygons.length,2);
    old.destroy();assert.equal(f.tileset.clippingPolygons.length,1);assert.equal(replacement.status.state,'ready');
    replacement.show=false;assert.equal(f.tileset.clippingPolygons,undefined);
    replacement.show=true;assert.equal((f.tileset.clippingPolygons as ClippingPolygonCollection|undefined)?.length,1);
    replacement.destroy();assert.equal(f.tileset.clippingPolygons,undefined);assert.equal(f.active.size,0);
  } finally {f.close();}
});

test('changing a tileset while GLB loads attaches the final association and leaves the old layer untouched',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>();
  try {
    Model.fromGltfAsync=async()=>{entered.resolve();return loading.promise;};
    const handle=f.render();await entered.promise;handle.setTileset(f.other);
    loading.resolve(modelStub() as unknown as Model);await handle.ready;
    assert.equal(f.tileset.clippingPolygons,undefined);assert.equal(f.other.clippingPolygons.length,1);
    handle.destroy();assert.equal(f.other.clippingPolygons,undefined);
  } finally {f.close();}
});

test('a GLB load failure cannot leave an owned clipping region or a drawable orphan',async()=>{
  const f=fixture();
  try {
    Model.fromGltfAsync=async()=>{throw new Error('fixture decoder failure');};
    const handle=f.render();await assert.rejects(handle.ready,/fixture decoder failure/);
    assert.equal(handle.status.state,'error');assert.equal(f.active.size,0);assert.equal(f.tileset.clippingPolygons,undefined);
  } finally {f.close();}
});

test('foreign clipping added after ready updates handle status and is preserved when the plan is deleted',async()=>{
  const f=fixture(),planes=new ClippingPlaneCollection({planes:[new ClippingPlane(Cartesian3.UNIT_X,0)]});
  try {
    Model.fromGltfAsync=async()=>modelStub() as unknown as Model;
    const handle=f.render();await handle.ready;assert.equal(handle.status.state,'ready');
    f.tileset.clippingPlanes=planes;f.postUpdate.raiseEvent();
    assert.equal(handle.status.state,'blocked');assert.equal(f.tileset.clippingPolygons,undefined);
    handle.destroy();assert.equal(f.tileset.clippingPlanes,planes);assert.equal(planes.isDestroyed(),false);
    assert.equal(f.postUpdate.numberOfListeners,0);
  } finally {f.close();}
});

test('removing a foreign clipping owner restores the active plan and ready status without editing its saved state',async()=>{
  const f=fixture(),foreign=new ClippingPolygonCollection({polygons:[]});
  try {
    f.tileset.clippingPolygons=foreign;
    Model.fromGltfAsync=async()=>modelStub() as unknown as Model;
    const handle=f.render();await handle.ready;assert.equal(handle.status.state,'blocked');
    (f.tileset as unknown as {clippingPolygons:ClippingPolygonCollection|undefined}).clippingPolygons=undefined;
    f.postUpdate.raiseEvent();assert.equal(handle.status.state,'ready');assert.equal(f.tileset.clippingPolygons.length,1);
    handle.destroy();assert.equal(f.tileset.clippingPolygons,undefined);assert.equal(f.postUpdate.numberOfListeners,0);
  } finally {f.close();}
});
