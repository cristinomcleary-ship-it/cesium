import { Cartesian2, Cartesian3, Color, EllipsoidTerrainProvider, Matrix4, Model, Transforms, Viewer } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { EngineeringRenderAdapter } from '../../src/engineeringComponents/renderAdapter';
import { EngineeringOcclusionRenderer } from '../../src/engineeringComponents/occlusion';
import { readGlbJson } from '../../src/engineeringComponents/catalog';
import { renderFixtureFrames } from './render-fixture-frames';

(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/__engineering_cesium/';
const unit = new URL(location.href).searchParams.get('unit')!;
const startedAt=performance.now();
const viewer = new Viewer('scene', { animation:false,timeline:false,baseLayer:false,terrainProvider:new EllipsoidTerrainProvider(),geocoder:false,
  homeButton:false,sceneModePicker:false,baseLayerPicker:false,navigationHelpButton:false,fullscreenButton:false,selectionIndicator:false,infoBox:false,
  requestRenderMode:true,contextOptions:{webgl:{preserveDrawingBuffer:true,antialias:false}} });
viewer.scene.globe.show=false;viewer.scene.skyAtmosphere.show=false;viewer.scene.skyBox.show=false;viewer.scene.sun.show=false;viewer.scene.moon.show=false;
viewer.scene.backgroundColor=Color.fromBytes(12,18,24);viewer.scene.postProcessStages.fxaa.enabled=false;
const errors:string[]=[];viewer.scene.renderError.addEventListener((_scene,error)=>errors.push(String(error.stack||error)));
const url=`/__engineering_real/${encodeURIComponent(unit)}.glb`;
const bytes=await (await fetch(url)).arrayBuffer();
const sourceHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
const document=readGlbJson(bytes) as {nodes:{name?:string;mesh?:number;extras?:{componentId?:string}}[]};
const bindings=document.nodes.flatMap((node,index)=>node.mesh===undefined?[]:[{componentId:node.extras?.componentId??node.name!,nodeIndices:[index]}]);
const frame=Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121,31,0));
const model=await Model.fromGltfAsync({url,modelMatrix:frame,id:{engineeringModelId:unit},incrementallyLoadTextures:false});viewer.scene.primitives.add(model);
await new Promise<void>((resolve,reject)=>{const stop=viewer.scene.postRender.addEventListener(()=>{if(model.ready){clearTimeout(timer);stop();resolve();}else viewer.scene.requestRender();});
  const timer=setTimeout(()=>{stop();reject(Error('Real GLB ready timeout'));},45000);viewer.scene.requestRender();});
const loadedAt=performance.now(),timings:Record<string,number>={loadMilliseconds:loadedAt-startedAt};
const referenceIds=new Set<string>(unit==='FULL'?(await(await fetch('/__engineering_real/meta.json')).json()).referenceIds:[]);
for(const id of referenceIds)model.getNode(id).show=false;
const normal=Cartesian3.normalize(Matrix4.multiplyByPointAsVector(frame,new Cartesian3(0,.15,-1),new Cartesian3()),new Cartesian3());
const up=Cartesian3.normalize(Matrix4.multiplyByPointAsVector(frame,new Cartesian3(0,1,.15),new Cartesian3()),new Cartesian3());
const modelMatrixBefore=Matrix4.toArray(model.modelMatrix);
const frames=()=>renderFixtureFrames(viewer.scene,5,()=>errors);
const fullSphere=model.boundingSphere;
const cameraAt=(sphere:typeof fullSphere)=>{viewer.camera.setView({destination:Cartesian3.subtract(sphere.center,Cartesian3.multiplyByScalar(normal,Math.max(15,sphere.radius*3.5),new Cartesian3()),new Cartesian3()),orientation:{direction:normal,up}});viewer.camera.frustum.near=.5;};
cameraAt(fullSphere);await frames();
let measureStart=performance.now();await frames();timings.baselineFiveFramesMilliseconds=performance.now()-measureStart;
const adapter=new EngineeringRenderAdapter(viewer,model,bindings), renderer=new EngineeringOcclusionRenderer(viewer);renderer.add(adapter);
adapter.applyStates(bindings.map(binding=>({...binding,visible:!referenceIds.has(binding.componentId),occlusion:false})));
await frames();measureStart=performance.now();await frames();timings.adapterInactiveFiveFramesMilliseconds=performance.now()-measureStart;
let chosen=unit==='TN021'?'TN021_tunnel_roof_01':'A001_cap_01';
let windowPosition:Cartesian2|undefined,pickedWorld:Cartesian3|undefined;
const focus=async(id:string)=>{
  chosen=id;const sphere=adapter.getComponentBounds(chosen)!;cameraAt(sphere);renderer.setEnabled(false);adapter.setSelection([]);
  adapter.applyStates(bindings.map(binding=>({...binding,visible:binding.componentId===chosen,occlusion:binding.componentId===chosen})));await frames();
  windowPosition=undefined;pickedWorld=undefined;
  for(let radius=0;radius<200&&!windowPosition;radius+=20){for(let angle=0;angle<360&&!windowPosition;angle+=45){
    const p=new Cartesian2(viewer.canvas.clientWidth/2+radius*Math.cos(angle*Math.PI/180),viewer.canvas.clientHeight/2+radius*Math.sin(angle*Math.PI/180));
    if(adapter.componentIdFromPick(viewer.scene.pick(p))===chosen){windowPosition=p;pickedWorld=viewer.scene.pickPosition(p);}
  }}
  if(!windowPosition||!pickedWorld)throw Error(`Cannot pick real sample ${chosen}`);
  renderer.setDetectionPlane({center:Cartesian3.add(pickedWorld,Cartesian3.multiplyByScalar(normal,Math.max(2,sphere.radius),new Cartesian3()),new Cartesian3()),
    normal,width:Math.max(10,sphere.radius*6),height:Math.max(10,sphere.radius*6),color:new Color(1,.45,0,1)});
};
await focus(chosen);
const context=(viewer.scene as unknown as {context:{readPixels(options:object):Uint8Array}}).context;
const read=()=>{
  const x=Math.floor(windowPosition!.x*viewer.scene.drawingBufferWidth/viewer.canvas.clientWidth),y=Math.floor((viewer.canvas.clientHeight-windowPosition!.y)*viewer.scene.drawingBufferHeight/viewer.canvas.clientHeight);
  const main=[...context.readPixels({x,y,width:1,height:1})],pick=adapter.componentIdFromPick(viewer.scene.pick(windowPosition!));
  return {sourceHash,unit,chosen,count:bindings.length,physicalCount:bindings.length-referenceIds.size,timings:{...timings},stats:renderer.getStats(),pick,main,
    independent:renderer.readDetectionPixel(x,y),depth:renderer.readDepthPixel(x,y),modelMatrix:Matrix4.toArray(model.modelMatrix),modelMatrixBefore,errors:[...errors]};
};
const api={
  async state(visible:boolean,occlusion:boolean){adapter.setState(chosen,{visible,occlusion});renderer.setEnabled(true);await frames();return read();},
  async all(occlusion:boolean){const start=performance.now();adapter.applyStates(bindings.map(binding=>({...binding,visible:false,occlusion:occlusion&&!referenceIds.has(binding.componentId)})));timings.allStateApplyMilliseconds=performance.now()-start;renderer.setEnabled(true);await frames();return read();},
  async focus(id:string){await focus(id);renderer.setEnabled(true);await frames();return read();},
  async wholeLine(visible:boolean,occlusion:boolean){cameraAt(fullSphere);const start=performance.now();adapter.applyStates(bindings.map(binding=>({...binding,visible:visible&&!referenceIds.has(binding.componentId),occlusion:occlusion&&!referenceIds.has(binding.componentId)})));timings.wholeLineStateApplyMilliseconds=performance.now()-start;
    renderer.setDetectionPlane({center:Cartesian3.add(fullSphere.center,Cartesian3.multiplyByScalar(normal,fullSphere.radius*1.5,new Cartesian3()),new Cartesian3()),normal,width:fullSphere.radius*4,height:fullSphere.radius*4,color:new Color(1,.45,0,1)});
    renderer.setEnabled(true);await frames();const begin=performance.now();await frames();timings.wholeLineFiveFramesMilliseconds=performance.now()-begin;return {stats:renderer.getStats(),timings:{...timings},physicalCount:bindings.length-referenceIds.size,errors:[...errors]};},
  async selection(){adapter.applyStates(bindings.map(binding=>({...binding,visible:binding.componentId===chosen,occlusion:false})));renderer.setEnabled(false);adapter.setSelection([chosen]);await frames();return {count:bindings.length,errors:[...errors]};},
  async performanceComparison(){
    cameraAt(fullSphere);adapter.setSelection([]);adapter.applyStates(bindings.map(binding=>({...binding,visible:!referenceIds.has(binding.componentId),occlusion:!referenceIds.has(binding.componentId)})));
    renderer.setDetectionPlane({center:Cartesian3.add(fullSphere.center,Cartesian3.multiplyByScalar(normal,fullSphere.radius*1.5,new Cartesian3()),new Cartesian3()),normal,width:fullSphere.radius*4,height:fullSphere.radius*4,color:new Color(1,.45,0,1)});
    const runs:{mode:string;milliseconds:number;frames:number;stats:ReturnType<typeof renderer.getStats>}[]=[];
    for(const mode of ['disabled','enabled','disabled','enabled','disabled','enabled']){
      renderer.setEnabled(mode==='enabled');await frames();const started=performance.now();await renderFixtureFrames(viewer.scene,10,()=>errors);
      runs.push({mode,milliseconds:performance.now()-started,frames:10,stats:renderer.getStats()});
    }
    renderer.dispose();adapter.dispose();await frames();
    for(let i=0;i<3;i++){const started=performance.now();await renderFixtureFrames(viewer.scene,10,()=>errors);runs.push({mode:'native-after-dispose',milliseconds:performance.now()-started,frames:10,stats:renderer.getStats()});}
    return {runs,errors:[...errors],restored:bindings.every(binding=>model.getNode(binding.componentId).show===!referenceIds.has(binding.componentId)),modelMatrix:Matrix4.toArray(model.modelMatrix),modelMatrixBefore};
  },
  async dispose(){renderer.dispose();adapter.dispose();await frames();return {restored:bindings.every(binding=>model.getNode(binding.componentId).show===!referenceIds.has(binding.componentId)),errors:[...errors]};},
};
(window as unknown as {engineeringRealFixture:typeof api}).engineeringRealFixture=api;
