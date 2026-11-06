import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cesium3DTileset, ClippingPlane, ClippingPlaneCollection, ClippingPolygonCollection, CustomShader, CustomShaderTranslucencyMode, Event, ImageBasedLighting, LightingModel, Model, Primitive, ShadowMode, type MaterialAppearance, type Viewer } from 'cesium';
import { getTemporaryWorksRuntimeGlbUrl, renderTemporaryWorksGlb } from './temporaryWorksGlbScene.ts';
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
  let destroyed=false,destroyCalls=0;
  // Model creates and destroys this IBL when the caller does not supply one.
  // Cesium 1.144's declarations omit these runtime lifecycle methods; Model.destroy uses them.
  const imageBasedLighting=new ImageBasedLighting() as ImageBasedLighting & {destroy():void;isDestroyed():boolean};
  const value={show,ready,imageBasedLighting,errorEvent:new Event(),isDestroyed:()=>destroyed,
    get destroyCalls(){return destroyCalls;},destroy:()=>{destroyCalls++;imageBasedLighting.destroy();destroyed=true;}};
  return value;
}

function fixture(options:{destroyPrimitives?:boolean;failAdd?:boolean}={}) {
  const originalLoader=Model.fromGltfAsync,originalFetch=globalThis.fetch;
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:'http://localhost/'}}});
  globalThis.fetch=async()=>new Response(JSON.stringify({schemaVersion:1,assets:[asset,{...asset,id:'wall'}]}),{status:200});
  const active=new Set<Model>(),entities=new Set<unknown>(),postUpdate=new Event();
  let viewerDestroyed=false;
  const sceneLight=Object.freeze({color:Object.freeze({red:1,green:1,blue:1}),intensity:2});
  const viewer={scene:{light:sceneLight,context:{webgl2:true},postUpdate,primitives:{
    add:(m:Model)=>{if(options.failAdd)throw new Error('fixture attachment failure');active.add(m);return m;},contains:(m:Model)=>active.has(m),
    remove:(m:Model)=>{if(!active.delete(m))return false;if(options.destroyPrimitives!==false)m.destroy();return true;},
  },requestRender:()=>{}},entities:{add:(e:unknown)=>{entities.add(e);return e;},remove:(e:unknown)=>entities.delete(e)},
  isDestroyed:()=>viewerDestroyed} as unknown as Viewer;
  const tileset=new Cesium3DTileset({}),other=new Cesium3DTileset({});
  const handles:ReturnType<typeof renderTemporaryWorksGlb>[]=[];
  const render=(id='saved-plan',extra:Partial<TemporaryWorksGlbConfig> & {brightnessPercent?:number}={})=>{
    const handle=renderTemporaryWorksGlb(viewer,{...config,...extra,id,tileset});handles.push(handle);return handle;
  };
  return {active,tileset,other,postUpdate,render,viewer,sceneLight,setViewerDestroyed:()=>{viewerDestroyed=true;},close:()=>{
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
    assert.equal(model.imageBasedLighting.isDestroyed(),true);assert.equal(model.destroyCalls,1);
  } finally {f.close();}
});

test('deleting during GPU readiness polling releases the model and settles the pending handle',async()=>{
  const f=fixture(),added=deferred<void>(),model=modelStub(true,false);
  try {
    Model.fromGltfAsync=async()=>{queueMicrotask(()=>added.resolve());return model as unknown as Model;};
    const handle=f.render();await added.promise;await Promise.resolve();handle.destroy();await handle.ready;
    assert.equal(model.isDestroyed(),true);assert.equal(f.active.size,0);assert.equal(f.tileset.clippingPolygons,undefined);
    assert.equal(model.errorEvent.numberOfListeners,0);
    assert.equal(model.imageBasedLighting.isDestroyed(),true);assert.equal(model.destroyCalls,1);
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

test('temporary works retain PBR material channels with fixed local illumination and model-owned IBL',async()=>{
  const f=fixture(),models:ReturnType<typeof modelStub>[]=[],shaders:CustomShader[]=[];
  try {
    Model.fromGltfAsync=async options=>{
      assert.ok(options.lightColor);
      assert.equal(options.lightColor.x,options.lightColor.y);assert.equal(options.lightColor.y,options.lightColor.z);
      assert.equal(options.lightColor.x,0,'the model receives no scene sunlight');
      assert.equal(options.environmentMapOptions?.enabled,false,'no time-dependent environment capture');
      assert.equal(options.imageBasedLighting,undefined,'Cesium retains IBL ownership');
      assert.equal(options.color,undefined);assert.equal(options.colorBlendMode,undefined);
      assert.ok(options.customShader instanceof CustomShader);shaders.push(options.customShader);
      assert.equal(options.customShader.lightingModel,LightingModel.PBR,'retain legacy diffuse textures and alpha');
      assert.equal(options.customShader.translucencyMode,CustomShaderTranslucencyMode.INHERIT);
      assert.equal(options.shadows,ShadowMode.DISABLED,'solar shadow changes cannot darken the presentation model');
      const model=modelStub();models.push(model);return model as unknown as Model;
    };
    const first=f.render('first');await first.ready;
    const second=f.render('second');await second.ready;
    const a=models[0].imageBasedLighting,b=models[1].imageBasedLighting;
    assert.notEqual(a,b);assert.notEqual(shaders[0],shaders[1]);
    assert.equal(a.imageBasedLightingFactor.x,0);assert.equal(a.imageBasedLightingFactor.y,0);
    assert.equal(b.imageBasedLightingFactor.x,0);assert.equal(b.imageBasedLightingFactor.y,0);
    assert.equal(f.viewer.scene.light,f.sceneLight);assert.equal(f.sceneLight.intensity,2);
    first.destroy();first.destroy();assert.equal(a.isDestroyed(),true);assert.equal(models[0].destroyCalls,1);
    assert.equal(shaders[0].isDestroyed(),true);assert.equal(shaders[1].isDestroyed(),false);
    assert.equal(b.isDestroyed(),false);assert.equal(models[1].destroyCalls,0);
    second.destroy();assert.equal(b.isDestroyed(),true);assert.equal(models[1].destroyCalls,1);assert.equal(shaders[1].isDestroyed(),true);
  } finally {f.close();}
});

test('brightness before and after model readiness changes one uniform without loading or rebuilding clipping',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>();
  let shader:CustomShader|undefined,loads=0;
  try {
    Model.fromGltfAsync=async options=>{loads++;shader=options.customShader;entered.resolve();return loading.promise;};
    const handle=f.render('adjusted',{brightnessPercent:125});await entered.promise;
    assert.equal(shader!.uniforms.u_twBrightness.value,1.25);
    const source=shader!.fragmentShaderText;
    handle.setBrightness(150);assert.equal(handle.brightnessPercent,150);assert.equal(shader!.uniforms.u_twBrightness.value,1.5);
    loading.resolve(modelStub() as unknown as Model);await handle.ready;
    const clip=f.tileset.clippingPolygons;
    for(const percent of [100,200,50,75,160])handle.setBrightness(percent);
    assert.equal(loads,1);assert.equal(f.active.size,1);assert.equal(f.tileset.clippingPolygons,clip);
    assert.equal(shader!.fragmentShaderText,source);assert.equal(shader!.uniforms.u_twBrightness.value,1.6);
    assert.equal(f.viewer.scene.light,f.sceneLight);
    handle.destroy();assert.equal(shader!.isDestroyed(),true);
    assert.doesNotThrow(()=>handle.setBrightness(100));assert.equal(f.active.size,0);
  } finally {f.close();}
});

test('early deletion releases the application-owned lighting shader even before GLB loading resolves',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>();
  let shader:CustomShader|undefined;
  try {
    Model.fromGltfAsync=async options=>{shader=options.customShader;entered.resolve();return loading.promise;};
    const handle=f.render();await entered.promise;handle.destroy();
    assert.equal(shader!.isDestroyed(),true);
    const model=modelStub();loading.resolve(model as unknown as Model);await handle.ready;
    assert.equal(model.destroyCalls,1);assert.equal(f.active.size,0);assert.equal(f.tileset.clippingPolygons,undefined);
  } finally {f.close();}
});

test('multiple wall text planes share a safe material template, update uniforms without repainting and release resources',async()=>{
  const f=fixture(),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  let paints=0;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(name:string)=>{
    assert.equal(name,'canvas');
    return {width:0,height:0,getContext:()=>({fillRect(){paints++;},fillText(){paints++;}})};
  }}});
  try {
    Model.fromGltfAsync=async()=>modelStub() as unknown as Model;
    const first=f.render('wall-one',{resourceId:'wall',branding:{visible:true,text:'中铁二十四局'}});await first.ready;
    const second=f.render('wall-two',{resourceId:'wall',branding:{visible:true,text:'安全施工'},brightnessPercent:120});await second.ready;
    const planes=[...f.active].filter(p=>p instanceof Primitive) as unknown as Primitive[];
    assert.equal(planes.length,2);
    const a=(planes[0].appearance as MaterialAppearance).material,b=(planes[1].appearance as MaterialAppearance).material;
    assert.notEqual(a.uniforms.image,b.uniforms.image);
    const image=a.uniforms.image,source=a.shaderSource,paintCount=paints;
    first.setBrightness(170);assert.equal(a.uniforms.brightness,1.7);assert.equal(b.uniforms.brightness,1.2);
    assert.equal(a.uniforms.image,image);assert.equal(a.shaderSource,source);assert.equal(paints,paintCount);
    first.show=false;assert.equal(planes[0].show,false);assert.equal(planes[1].show,true);
    first.destroy();assert.equal(planes[0].isDestroyed(),true);assert.equal(a.isDestroyed(),true);
    assert.equal(b.isDestroyed(),false);second.destroy();assert.equal(b.isDestroyed(),true);assert.equal(f.active.size,0);
  } finally {
    f.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');
  }
});

test('collections that do not destroy removed primitives cannot leak model-owned lighting',async()=>{
  const f=fixture({destroyPrimitives:false}),model=modelStub();
  try {
    Model.fromGltfAsync=async()=>model as unknown as Model;
    const handle=f.render();await handle.ready;handle.destroy();handle.destroy();
    assert.equal(f.active.size,0);assert.equal(model.imageBasedLighting.isDestroyed(),true);assert.equal(model.destroyCalls,1);
  } finally {f.close();}
});

test('a failed scene attachment releases the model and its lighting',async()=>{
  const f=fixture({failAdd:true}),model=modelStub();
  try {
    Model.fromGltfAsync=async()=>model as unknown as Model;
    const handle=f.render();await assert.rejects(handle.ready,/fixture attachment failure/);
    assert.equal(model.imageBasedLighting.isDestroyed(),true);assert.equal(model.destroyCalls,1);assert.equal(f.active.size,0);
  } finally {f.close();}
});

test('late model completion after viewer teardown releases the owned IBL',async()=>{
  const f=fixture(),entered=deferred<void>(),loading=deferred<Model>(),model=modelStub();
  try {
    Model.fromGltfAsync=async()=>{entered.resolve();return loading.promise;};
    const handle=f.render();await entered.promise;f.setViewerDestroyed();loading.resolve(model as unknown as Model);await handle.ready;
    handle.destroy();assert.equal(model.imageBasedLighting.isDestroyed(),true);assert.equal(model.destroyCalls,1);assert.equal(f.active.size,0);
  } finally {f.close();}
});

test('private runtime GLB URLs carry the current model content hash under nested deployments',()=>{
  const sha256='A7'.repeat(32),page='http://localhost:4173/cesium/editor';
  const url=getTemporaryWorksRuntimeGlbUrl({...asset,url:'models/temporary-works/camp.glb?download=1#view',sha256},'/cesium/',page);
  const parsed=new URL(url);
  assert.equal(parsed.pathname,'/cesium/models/temporary-works/camp.glb');assert.equal(parsed.searchParams.get('v'),sha256.toLowerCase());
  assert.equal(parsed.searchParams.get('download'),'1');assert.equal(parsed.hash,'#view');
  const changed=getTemporaryWorksRuntimeGlbUrl({...asset,url:'models/temporary-works/camp.glb',sha256:'b'.repeat(64)},'/cesium/',page);
  assert.notEqual(new URL(changed).searchParams.get('v'),parsed.searchParams.get('v'));
});

test('hash cache busting leaves external URLs, sibling paths and incomplete manifests intact',()=>{
  const sha256='c'.repeat(64),page='https://viewer.example/cesium/';
  for(const url of ['https://private.example/models/temporary-works/camp.glb?signature=x%20y&v=external',
    '/models/temporary-works/camp.glb','models/temporary-works-other/camp.glb','models/fixture.glb','data:model/gltf-binary;base64,YQ==']) {
    assert.equal(getTemporaryWorksRuntimeGlbUrl({...asset,url,sha256},'/cesium/',page),new URL(url,page).href);
  }
  for(const hash of [undefined,'unverified','a'.repeat(63),42]) {
    const url='models/temporary-works/camp.glb';
    assert.equal(getTemporaryWorksRuntimeGlbUrl({...asset,url,sha256:hash,sourceSha256:sha256},'/cesium/',page),new URL(url,page).href);
  }
});
