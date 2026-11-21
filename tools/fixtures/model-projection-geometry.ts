import { Axis, Cartesian2, Cartesian3, Cartographic, Cesium3DTileset, Color, EllipsoidTerrainProvider, Math as CesiumMath, Matrix3, Matrix4, Model, Transforms, Viewer } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { readRuntimeModelGeometry, runtimeModelWorldFromLocal } from '../../src/modelContactOcclusion/runtimeGeometry';
import { ModelProjectionGeometryClient } from '../../src/modelContactOcclusion/projectionClient';
import { engineeringRuntimeNodeTransforms, engineeringWorldFromGltf } from '../../src/engineeringComponents/projectionPose';
import { ENGINEERING_PHOTOGRAPHY_LIMITS } from '../../src/engineeringComponents/photography';
import type { ContactMeshInput } from '../../src/modelContactOcclusion/types';
import { getTemporaryWorksClippingManager } from '../../src/temporaryWorksGlbScene';
import { renderFixtureFrames } from './render-fixture-frames';
(window as unknown as {CESIUM_BASE_URL:string}).CESIUM_BASE_URL='/__contact_cesium/';
const name=new URL(location.href).searchParams.get('model')||'bridge';
const viewer=new Viewer('scene',{animation:false,timeline:false,baseLayer:false,terrainProvider:new EllipsoidTerrainProvider(),geocoder:false,
  homeButton:false,sceneModePicker:false,baseLayerPicker:false,navigationHelpButton:false,fullscreenButton:false,selectionIndicator:false,infoBox:false,
  requestRenderMode:true,contextOptions:{webgl:{preserveDrawingBuffer:true,antialias:false}}});
viewer.scene.globe.show=false;viewer.scene.skyAtmosphere.show=false;viewer.scene.skyBox.show=false;viewer.scene.sun.show=false;viewer.scene.moon.show=false;
viewer.scene.backgroundColor=Color.fromBytes(12,18,100);viewer.scene.postProcessStages.fxaa.enabled=false;
const errors:string[]=[];viewer.scene.renderError.addEventListener((_scene,error)=>errors.push(String(error.stack||error)));
const frame=Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121,31,0)),inverseFrame=Matrix4.inverse(frame,new Matrix4());
const metadata=await(await fetch('/__contact/meta.json')).json();
const real=metadata.models[name]?.real===true;
const model=await Model.fromGltfAsync({url:`/__contact/model/${name}.glb`,modelMatrix:frame,minimumPixelSize:0,
  ...(real?{}:{upAxis:Axis.Z,forwardAxis:Axis.X}),incrementallyLoadTextures:false,id:{engineeringModelId:name}});
viewer.scene.primitives.add(model);
const tileset=await Cesium3DTileset.fromUrl('/__contact/photo/tileset.json');viewer.scene.primitives.add(tileset);
const frames=()=>renderFixtureFrames(viewer.scene,6,()=>errors);
viewer.camera.setView({destination:Matrix4.multiplyByPoint(frame,new Cartesian3(0,0,40),new Cartesian3()),
  orientation:{direction:Matrix4.multiplyByPointAsVector(frame,new Cartesian3(0,0,-1),new Cartesian3()),up:Matrix4.multiplyByPointAsVector(frame,new Cartesian3(0,1,0),new Cartesian3())}});
viewer.camera.frustum.near=.01;
for(let i=0;i<120&&(!model.ready||!tileset.root.contentReady);i++)await frames();
if(!model.ready||!tileset.root.contentReady)throw Error('Contact fixture model or photography not ready');
model.show=false;
const client=new ModelProjectionGeometryClient(),manager=getTemporaryWorksClippingManager(viewer),scope=manager.createModelProjectionScope('projection-fixture');
let input:ContactMeshInput,geometry:Awaited<ReturnType<ModelProjectionGeometryClient['build']>>,volume:{worldFromLocal:readonly number[]};
let enabled=false,planeWorld=Matrix4.clone(frame),releaseLease:(()=>void)|undefined,releaseAll:(()=>void)|undefined;
const oldScope=manager.createScope('old-projection-fixture',{limits:ENGINEERING_PHOTOGRAPHY_LIMITS,minimumAreaSquareMeters:0,precise:true});
let oldProjection: typeof geometry.projection | undefined;
const excluded=new Set<number>(metadata.models[name]?.excludedNodes??[]);
const timing:{readMs?:number;buildMs?:number}={};
async function build(allowed?:number[]){
  const a=performance.now();input=await readRuntimeModelGeometry(model,{excludeNodeIndices:excluded,allowedNodeIndices:allowed?new Set(allowed):undefined});timing.readMs=performance.now()-a;
  const b=performance.now();geometry=await client.build(input);timing.buildMs=performance.now()-b;
  volume={worldFromLocal:runtimeModelWorldFromLocal(model)};
  if(enabled)scope.upsert({id:'model',tileset,footprints:geometry.projection.footprints});
}
await build();
const context=(viewer.scene as unknown as {context:{readPixels(options:object):Uint8Array;_gl:WebGL2RenderingContext}}).context;
const glErrors=()=>{const found:number[]=[];for(let i=0;i<16;i++){const code=context._gl.getError();if(!code)break;found.push(code);}return found;};
function vec(p:Cartesian3):number[]{return [p.x,p.y,p.z];}
function sample(){
  const world=Matrix4.getTranslation(planeWorld,new Cartesian3()),screen=viewer.scene.cartesianToCanvasCoordinates(world,new Cartesian2());
  if(!screen)throw Error('Probe has no screen position');
  const x=Math.floor(screen.x*viewer.scene.drawingBufferWidth/viewer.canvas.clientWidth),y=Math.floor((viewer.canvas.clientHeight-screen.y)*viewer.scene.drawingBufferHeight/viewer.canvas.clientHeight);
  const pick=viewer.scene.pick(screen,1,1) as {primitive?:unknown}|undefined;
  return {pixel:[...context.readPixels({x,y,width:1,height:1})],photographyPicked:pick?.primitive===tileset,screen:[screen.x,screen.y],world:vec(world),errors:[...errors]};
}
async function plane(local:number[],normal:number[]=[0,0,1],range=12){
  const n=Cartesian3.normalize(Cartesian3.fromArray(normal),new Cartesian3());
  const seed=Math.abs(n.z)<.9?Cartesian3.UNIT_Z:Cartesian3.UNIT_Y;
  const u=Cartesian3.normalize(Cartesian3.cross(seed,n,new Cartesian3()),new Cartesian3()),v=Cartesian3.cross(n,u,new Cartesian3());
  const rotation=new Matrix3();Matrix3.setColumn(rotation,0,u,rotation);Matrix3.setColumn(rotation,1,v,rotation);Matrix3.setColumn(rotation,2,n,rotation);
  const localFrame=Matrix4.fromRotationTranslation(rotation,Cartesian3.fromArray(local));
  planeWorld=Matrix4.multiply(Matrix4.fromArray([...volume.worldFromLocal]),localFrame,new Matrix4());
  tileset.modelMatrix=Matrix4.multiply(planeWorld,inverseFrame,new Matrix4());
  const center=Matrix4.getTranslation(planeWorld,new Cartesian3()),direction=Cartesian3.normalize(Matrix4.multiplyByPointAsVector(planeWorld,new Cartesian3(0,0,-1),new Cartesian3()),new Cartesian3());
  viewer.camera.setView({destination:Cartesian3.subtract(center,Cartesian3.multiplyByScalar(direction,range,new Cartesian3()),new Cartesian3()),
    orientation:{direction,up:Cartesian3.normalize(Matrix4.multiplyByPointAsVector(planeWorld,Cartesian3.UNIT_Y,new Cartesian3()),new Cartesian3())}});
  await frames();return sample();
}
function sourceContact(){
  for(const primitive of input.primitives)for(let i=0;i<primitive.indices.length;i+=3){
    const a=Cartesian3.fromArray(primitive.positions,primitive.indices[i]*3),b=Cartesian3.fromArray(primitive.positions,primitive.indices[i+1]*3),c=Cartesian3.fromArray(primitive.positions,primitive.indices[i+2]*3);
    const n=Cartesian3.cross(Cartesian3.subtract(b,a,new Cartesian3()),Cartesian3.subtract(c,a,new Cartesian3()),new Cartesian3());
    if(Cartesian3.magnitude(n)<.01)continue;
    return {point:vec(Cartesian3.divideByScalar(Cartesian3.add(Cartesian3.add(a,b,new Cartesian3()),c,new Cartesian3()),3,new Cartesian3())),normal:vec(Cartesian3.normalize(n,n)),nodeIndex:primitive.nodeIndex};
  }
  throw Error('No nondegenerate source triangle');
}
async function compareOld(){
  if(!['A001','TN021','FULL'].includes(name))throw Error('Old parser comparison requires original engineering package');
  const bytes=await(await fetch(`/__contact/model/${name}.glb`)).arrayBuffer();
  const view=new DataView(bytes),doc=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,view.getUint32(12,true))));
  const bindings=doc.nodes.flatMap((node:{mesh?:number;extras?:{componentId?:string};name?:string},index:number)=>
    node.mesh!==undefined&&!excluded.has(index)?[{componentId:node.extras?.componentId??node.name,nodeIndices:[index]}]:[]);
  // The endpoint exports the actual previous deployment's unchanged module.
  // It is an independent oracle, not the current shared kernel under test.
  const oldModuleUrl='/__projection_old_footprints';
  const old=await import(/* @vite-ignore */oldModuleUrl);
  const started=performance.now();
  oldProjection=await new old.EngineeringFootprintGeometry(bytes,bindings,engineeringRuntimeNodeTransforms(model,bindings))
    .project(engineeringWorldFromGltf(model),bindings.map((binding:{componentId:string})=>binding.componentId));
  const current=geometry.projection;
  return {old:oldProjection,current,oldComparisonMs:performance.now()-started,
    note:'Old parser runs only in this comparison page; timing is not a matched worker performance measurement.'};
}
function sourceRay(){
  const world=Matrix4.fromArray([...volume.worldFromLocal]);
  for(const primitive of input.primitives)for(let i=0;i<primitive.indices.length;i+=3){
    const triangle=[0,1,2].map(k=>Matrix4.multiplyByPoint(world,Cartesian3.fromArray(primitive.positions,primitive.indices[i+k]*3),new Cartesian3()));
    const center=Cartesian3.divideByScalar(Cartesian3.add(Cartesian3.add(triangle[0],triangle[1],new Cartesian3()),triangle[2],new Cartesian3()),3,new Cartesian3());
    const radial=Cartesian3.normalize(center,new Cartesian3());
    const area=Cartesian3.cross(Cartesian3.subtract(triangle[1],triangle[0],new Cartesian3()),Cartesian3.subtract(triangle[2],triangle[0],new Cartesian3()),new Cartesian3());
    if(Math.abs(Cartesian3.dot(area,radial))>.05)return {center:vec(center),radial:vec(radial),projectedDoubleArea:Math.abs(Cartesian3.dot(area,radial)),nodeIndex:primitive.nodeIndex};
  }
  throw Error('No source triangle with a nonzero geographic footprint');
}
async function rayPlane(offset:number){
  const ray=sourceRay(),center=Cartesian3.fromArray(ray.center),radial=Cartesian3.fromArray(ray.radial);
  const world=Cartesian3.add(center,Cartesian3.multiplyByScalar(radial,offset,new Cartesian3()),new Cartesian3());
  const inverse=Matrix4.inverse(Matrix4.fromArray([...volume.worldFromLocal]),new Matrix4());
  return plane(vec(Matrix4.multiplyByPoint(inverse,world,new Cartesian3())),vec(Matrix4.multiplyByPointAsVector(inverse,radial,new Cartesian3())),5);
}
const api={
  gpu(){const gl=context._gl,e=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'',maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};},glErrors,plane,sample,sourceContact,
  compareOld,sourceRay,rayPlane,
  async useOld(value:boolean){
    scope.clear();oldScope.clear();enabled=false;
    if(value){if(!oldProjection)throw Error('Old projection not prepared');oldScope.upsert({id:'old',tileset,footprints:oldProjection.footprints});}
    else{enabled=true;scope.upsert({id:'model',tileset,footprints:geometry.projection.footprints});}
    await frames();return sample();
  },
  async cameraView(range:number,tilt:number){
    const center=Matrix4.getTranslation(planeWorld,new Cartesian3());
    const direction=Cartesian3.normalize(Matrix4.multiplyByPointAsVector(planeWorld,new Cartesian3(0,Math.sin(tilt),-Math.cos(tilt)),new Cartesian3()),new Cartesian3());
    const up=Cartesian3.normalize(Matrix4.multiplyByPointAsVector(planeWorld,new Cartesian3(0,Math.cos(tilt),Math.sin(tilt)),new Cartesian3()),new Cartesian3());
    viewer.camera.setView({destination:Cartesian3.subtract(center,Cartesian3.multiplyByScalar(direction,range,new Cartesian3()),new Cartesian3()),orientation:{direction,up}});
    await frames();return sample();
  },
  async performanceComparison(){
    const measure=async()=>{const start=performance.now();await renderFixtureFrames(viewer.scene,30,()=>errors);return performance.now()-start;};
    const original=enabled,rows=[];
    for(let i=0;i<3;i++){
      await api.enable(false);const disabledMs=await measure();
      const start=performance.now();await api.enable(true);const applyAndSixFramesMs=performance.now()-start;
      const enabledMs=await measure();rows.push({disabledMs,enabledMs,applyAndSixFramesMs,frames:30});
    }
    const previousVersionRows=[];
    if(oldProjection)for(let i=0;i<3;i++){
      await api.useOld(true);const previousMs=await measure();
      await api.useOld(false);const restoredMs=await measure();
      previousVersionRows.push({previousMs,restoredMs,frames:30});
    }
    await api.enable(original);return {rows,previousVersionRows,show:model.show,gpu:api.gpu(),note:'Same camera and source; frame windows include scheduling and are not GPU-only timing.'};
  },
  info(){return {name,projection:geometry.projection,timing,
    sourceTriangles:input.primitives.reduce((n,p)=>n+p.indices.length/3,0),worldFromLocal:volume.worldFromLocal,metadata:metadata.models[name],show:model.show,errors:[...errors],status:scope.getStatus('model')};},
  async enable(value:boolean){oldScope.clear();enabled=value;if(value)scope.upsert({id:'model',tileset,footprints:geometry.projection.footprints});else scope.clear();await frames();return sample();},
  async visible(value:boolean){model.show=value;await frames();return {show:model.show,status:scope.getStatus('model')};},
  async pose(x:number,y:number,z:number,scale=1){model.modelMatrix=Matrix4.multiplyByTranslation(frame,new Cartesian3(x,y,z),new Matrix4());model.scale=scale;
    await build();await frames();return sample();},
  async select(nodes:number[]){await build(nodes);await frames();return api.info();},
  async suspend(value:boolean){scope.setEnabled(!value);await frames();return sample();},
  async underground(value:boolean){if(value)releaseLease??=manager.suspendTarget(tileset,api);else{releaseLease?.();releaseLease=undefined;}await frames();return sample();},
  async globalSuspend(value:boolean){if(value)releaseAll??=manager.suspend(api);else{releaseAll?.();releaseAll=undefined;}await frames();return sample();},
  async legacy(value:boolean){if(value){const positions=[[-2,-2],[2,-2],[2,2],[-2,2]].map(([x,y])=>{const c=Cartographic.fromCartesian(Matrix4.multiplyByPoint(frame,new Cartesian3(x,y,0),new Cartesian3()));return {longitude:CesiumMath.toDegrees(c.longitude),latitude:CesiumMath.toDegrees(c.latitude),height:c.height};});manager.upsert({id:'legacy',tileset,footprints:[{outer:positions}]});}else manager.remove('legacy');await frames();return sample();},
  async dispose(){releaseLease?.();releaseAll?.();oldScope.dispose();scope.dispose();manager.remove('legacy');client.dispose();await frames();return sample();},
};
(window as unknown as {modelProjectionFixture:typeof api}).modelProjectionFixture=api;
