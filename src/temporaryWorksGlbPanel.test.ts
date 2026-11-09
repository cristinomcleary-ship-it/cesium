import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import { Matrix4 } from 'cesium';
import { sampleTemporaryWorksInitialElevation } from './temporaryWorksInitialElevation.ts';
import { translateTemporaryWorksPlan } from './temporaryWorksPosition.ts';
registerHooks({load(url,context,next) {
  if (url.endsWith('.css')) return {format:'module',shortCircuit:true,source:'export {};'};
  return next(url,context);
}});
const {TemporaryWorksPanel} = await import('./temporaryWorksPanel.ts');

const glb = {resourceId:'camp',clippingEnabled:true,placement:{longitude:121,latitude:31,height:8,headingDeg:35,
  scaleMode:'uniform',dimensions:{length:40,width:20,height:10}},branding:{visible:true,text:'东方雄师 铁建劲旅',logoUrl:'data:image/png;base64,AA=='}};
const oldPlan = () => ({id:'saved-camp',name:'项目部',kind:'camp',visible:true,createdAt:'2026-11-05T00:00:00Z',glb:structuredClone(glb),inputs:{feature:{id:'source-cad'},road:undefined}});
// These focused lifecycle fixtures bypass the DOM constructor, so initialise the
// same project-scoped state that production field initializers normally create.
const panel = (fields:object) => {
  const options=(fields as {options?:object}).options;
  const selects=new Map<string,{value:string}>();
  return Object.assign(Object.create(TemporaryWorksPanel.prototype),{
  projectId:'project-a',generation:3,upgradeEnabled:true,disposed:false,busySave:false,overrides:new Map(),records:new Map(),handles:new Map(),
  lighting:{schemaVersion:1,globalPercent:100,overrides:{}},surfaceReady:new Set(),surfaceDerived:new Map(),surfaceStates:new Map(),surfaceRevision:0,
  readInitialElevation(this:{readGlbSurface(model:unknown,points:{longitude:number;latitude:number}[],job:AbortController):Promise<(number|null)[]>},model:unknown,candidates:{longitude:number;latitude:number}[],job:AbortController,checkCurrent:()=>void){
    return sampleTemporaryWorksInitialElevation(candidates,points=>this.readGlbSurface(model,points,job),{signal:job.signal,checkCurrent});
  },
  select(key:string){if(!selects.has(key))selects.set(key,{value:'manual'});return selects.get(key)!;},
  buttons(){},list(){},review(){},updateFields(){},status(){},failure(error:Error){throw error;},...fields,
  options:{getTilesets:()=>[],viewer:{scene:{requestRender(){}}},...options},
  });
};

test('editing a real model preserves the saved model and clipping until its replacement is committed',async()=>{
  const old=oldPlan(), draft={...structuredClone(old),id:'preview-camp',name:'项目部调整',glb:{...glb,placement:{...glb.placement,height:12}}};
  let destroyed=0,release!:()=>void,notified=0;
  const oldHandle={show:true,destroy(){destroyed++;}},newHandle={show:true,destroy(){assert.fail('new preview must survive committed edit');}};
  const p=panel({records:new Map([[old.id,old]]),handles:new Map([[old.id,oldHandle]]),glbEditing:old.id,
    preview:{record:draft,handle:newHandle,replaceId:old.id,checkSource(){}},
    options:{onPlansChanged(){notified++;},store:{async updateExisting(project:string,id:string,update:(saved:typeof old)=>typeof old){
      assert.equal(project,'project-a');assert.equal(id,old.id);await new Promise<void>(r=>{release=r;});return update(old);
    },put(){assert.fail('editing must not create a duplicate plan');}}},
  });
  const save=p.save();
  assert.equal(destroyed,0);assert.equal(p.records.get(old.id),old);
  release();await save;
  assert.equal(destroyed,1);assert.equal(notified,1);assert.equal(p.records.size,1);
  assert.equal(p.handles.get(old.id),newHandle);assert.equal(p.preview,undefined);assert.equal(p.glbEditing,undefined);
  assert.equal(p.records.get(old.id).id,old.id);assert.equal(p.records.get(old.id).createdAt,old.createdAt);
  assert.equal(p.records.get(old.id).glb.placement.height,12);
  assert.equal(p.select('elevation-mode').value,'automatic');
});

test('storage failure leaves an edited model preview available and keeps the original plan and clipping alive',async()=>{
  const old=oldPlan(),draft={...structuredClone(old),id:'preview'};
  let error:Error|undefined;
  const original={destroy(){assert.fail('original scene must survive failed save');}};
  const preview={record:draft,replaceId:old.id,handle:{destroy(){assert.fail('preview must remain retryable');}},checkSource(){}};
  const p=panel({records:new Map([[old.id,old]]),handles:new Map([[old.id,original]]),preview,
    options:{store:{async updateExisting(){throw new Error('quota exceeded');}}},failure(e:Error){error=e;},
  });
  await p.save();
  assert.match(error!.message,/quota/);assert.equal(p.records.get(old.id),old);assert.equal(p.handles.get(old.id),original);
  assert.equal(p.preview,preview);assert.equal(p.busySave,false);
});

test('temporary scene visibility and the global pause never write persistent plan visibility',async()=>{
  const old=oldPlan(),writes:boolean[]=[];
  const handle={show:false};
  const p=panel({upgradeEnabled:false,records:new Map([[old.id,old]]),handles:new Map([[old.id,handle]]),
    options:{store:{async updateExisting(_project:string,_id:string,update:(saved:typeof old)=>typeof old){const saved=update(old);writes.push(saved.visible);return saved;}}},
  });
  p.setPlanVisible(old.id,true);p.setPlanVisible(old.id,true);
  assert.deepEqual(writes,[]);assert.equal(handle.show,false);
  p.setPlanVisible(old.id,false);await Promise.resolve();
  assert.equal(p.records.get(old.id).visible,true);assert.equal(handle.show,false);assert.deepEqual(writes,[]);
  p.setPlanVisible(old.id,true);await Promise.resolve();
  assert.equal(p.records.get(old.id).visible,true);assert.equal(handle.show,false);assert.deepEqual(writes,[]);
  await p.changePlanVisibility(old.id,false);
  assert.equal(p.records.get(old.id).visible,false);assert.equal(handle.show,false);
  await p.changePlanVisibility(old.id,true);
  assert.equal(p.records.get(old.id).visible,true);assert.equal(handle.show,false);assert.deepEqual(writes,[false,true]);
});

test('a saved GLB configuration survives structured cloning with target dimensions, bottom anchor and independent branding intact',()=>{
  const original=oldPlan(),restored=structuredClone(original);
  assert.deepEqual(restored.glb,glb);
  restored.glb.placement.height=999;
  assert.equal(original.glb.placement.height,8);
  const p=panel({records:new Map([[original.id,original]])});
  assert.equal(p.getDisplayItems()[0].typeName,'项目驻地');
  original.glb.resourceId='wall';
  assert.equal(p.getDisplayItems()[0].typeName,'独立宣传墙');
});

test('editing a hidden plan preserves both stored visibility and the active scene visibility override',async()=>{
  const old={...oldPlan(),visible:false},draft={...structuredClone(old),visible:true},handle={show:true};
  const p=panel({records:new Map([[old.id,old]]),handles:new Map([[old.id,{destroy(){}}]]),overrides:new Map([[old.id,false]]),
    preview:{record:draft,handle,replaceId:old.id,checkSource(){}},
    options:{store:{async updateExisting(_project:string,_id:string,update:(saved:typeof old)=>typeof old){return update(old);}}},
  });
  await p.save();
  assert.equal(p.records.get(old.id).visible,false);assert.equal(handle.show,false);assert.equal(p.overrides.get(old.id),false);
});

test('deleting the edited original also retires its unsaved model preview and clipping',async t=>{
  Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm:()=>true}});
  t.after(()=>{Reflect.deleteProperty(globalThis,'window');});
  const old=oldPlan();let destroyed=0,discarded=0;
  const p=panel({records:new Map([[old.id,old]]),handles:new Map([[old.id,{destroy(){destroyed++;}}]]),pendingDelete:new Set(),
    glbEditing:old.id,preview:{record:structuredClone(old),replaceId:old.id,handle:{destroy(){discarded++;}}},
    dropPreview(this:{preview?:{handle:{destroy():void}}}){this.preview?.handle.destroy();this.preview=undefined;},
    options:{store:{async remove(){}}},
  });
  assert.equal(await p.removePlan(old.id),true);
  assert.equal(destroyed,1);assert.equal(discarded,1);assert.equal(p.preview,undefined);assert.equal(p.glbEditing,undefined);
});

function standalonePanel(resourceId='camp',clipping=false) {
  const values:Record<string,string>={model:'',name:'精确坐标模型','elevation-mode':'manual','glb-lon':'121','glb-lat':'31','glb-elevation':'8',
    'glb-heading':'35','glb-scale-mode':'uniform','glb-length':'20','glb-width':'10','glb-height':'5','glb-brand-text':'施工安全'};
  const resource={id:resourceId,name:resourceId,url:'models/local.glb',upAxis:'Y',
    bounds:{min:[0,0,0],max:[20,5,10]},anchor:[10,0,5],dimensions:{length:20,width:10,height:5},
    footprints:[{outer:[[0,0],[20,0],[20,10],[0,10]]}]};
  const p=panel({manifest:{schemaVersion:1,assets:[resource]},
    options:{getTilesets:()=>[],canEdit:()=>true},value:(key:string)=>values[key] ?? '',
    resourceId:()=>resourceId,resource:()=>resource,feature:()=>undefined,
    input:(key:string)=>({checked:key==='glb-clipping' ? clipping : false}),
    cancel(){},dropPreview(){},clearReview(){},clearOverlay(){},
    draw:()=>({ready:Promise.resolve(),zoom(){},destroy(){}}),
  });
  return p;
}

test('manual GLB placement without clipping does not require a photogrammetry layer and keeps exact dimensions and coordinates',async()=>{
  const p=standalonePanel();
  await p.runGlb();
  const plan=p.preview.record;
  assert.equal(plan.modelId,'');assert.equal(plan.glb.clippingEnabled,false);
  assert.deepEqual(plan.inputs.modelMatrix,Matrix4.toArray(Matrix4.IDENTITY));
  assert.deepEqual(plan.glb.placement,{longitude:121,latitude:31,height:8,headingDeg:35,scaleMode:'uniform',dimensions:{length:20,width:10,height:5}});
  p.preview.checkSource();
  p.generation++;
  assert.throws(()=>p.preview.checkSource(),/项目或权限/);
});

test('independent publicity wall ignores clipping and can be previewed without a photogrammetry layer',async()=>{
  const p=standalonePanel('wall',true);
  await p.runGlb();
  assert.equal(p.preview.record.glb.resourceId,'wall');assert.equal(p.preview.record.glb.clippingEnabled,false);
});

test('building clipping still requires a selected photogrammetry layer',async()=>{
  const p=standalonePanel('steel',true);
  await assert.rejects(p.runGlb(),/启用摄影遮挡/);
  assert.equal(p.preview,undefined);
});

test('new legacy facility generation cannot invoke the retired earthwork path',async()=>{
  const p=panel({options:{canEdit:()=>true},isGlb:()=>false,kind:()=> 'camp'});
  await assert.rejects(p.run(),/历史设施和土方数据仍可查看/);
});

test('a delayed logo read invalidates a preview created with the previous image',async t=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'FileReader');
  let finish!:()=>void,discarded=0;
  class Reader {
    result='data:image/png;base64,NEW';
    onload?:()=>void;
    readAsDataURL(){finish=()=>this.onload?.();}
  }
  Object.defineProperty(globalThis,'FileReader',{configurable:true,value:Reader});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'FileReader',descriptor);else Reflect.deleteProperty(globalThis,'FileReader');});
  const brand={checked:false};
  const p=panel({glbLogoReadToken:0,glbLogo:'data:image/png;base64,OLD',
    input:(key:string)=>key==='glb-logo' ? {files:[{type:'image/png',size:128}]} : brand,
    cancel(){},dropPreview(this:{preview?:unknown}){if(this.preview)discarded++;this.preview=undefined;},
  });
  const read=p.readGlbLogo();
  p.preview={record:{glb:{branding:{logoUrl:p.glbLogo}}}};
  finish();await read;
  assert.equal(discarded,1);assert.equal(p.preview,undefined);
  assert.equal(p.glbLogo,'data:image/png;base64,NEW');assert.equal(brand.checked,true);
});

function autoFitPanel(withPhotography=false) {
  const p=standalonePanel();
  const values:Record<string,{value:string;checked:boolean;disabled:boolean;textContent:string}>={};
  const field=(key:string)=>values[key]??=( {value:'',checked:false,disabled:false,textContent:''} );
  for (const [key,value] of Object.entries({brightness:'100','elevation-mode':withPhotography?'automatic':'manual','glb-placement-mode':'cad-auto','glb-lon':'121','glb-lat':'31','glb-elevation':'8','glb-heading':'0',
    'glb-scale-mode':'uniform','glb-length':'20','glb-width':'10','glb-height':'5',model:withPhotography?'photo':'',name:'CAD camp'})) field(key).value=value;
  const feature={id:'camp-outline',layer:'驻地轮廓',sourceType:'LWPOLYLINE',closed:true,points:[{x:0,y:0},{x:40,y:0},{x:40,y:20},{x:0,y:20}]};
  const model={id:'photo',name:'现场摄影',tileset:{modelMatrix:Matrix4.clone(Matrix4.IDENTITY),root:{transform:Matrix4.clone(Matrix4.IDENTITY)}}};
  Object.assign(p,{input:field,select:field,el:field,value:(key:string)=>field(key).value,
    feature:()=>feature,coordinates:()=>({mode:'local',referenceX:0,referenceY:0,longitude:121,latitude:31,rotation:23,unit:'m',axisOrder:'eastNorth'}),
    options:{...p.options,getTilesets:()=>withPhotography?[model]:[],canEdit:()=>true},
    readGlbSurface:async(_model:unknown,points:unknown[])=>points.map((_,i)=>10+i/100),
  });
  return {p,field,feature};
}

test('CAD fit with manual elevation preserves the entered height without claiming photography sampling',async()=>{
  const {p,field}=autoFitPanel();
  await p.runGlb();
  const plan=p.preview.record;
  assert.equal(plan.glb.placementMode,'cad-auto');
  assert.ok(Math.abs(plan.glb.placement.dimensions.length-39.9)<0.001);
  assert.ok(Math.abs(plan.glb.placement.dimensions.width-19.9)<0.001);
  assert.equal(plan.glb.placement.dimensions.height,5);
  assert.ok(Math.abs(plan.glb.placement.headingDeg-23)<0.01);
  assert.equal(plan.glb.placement.height,8);
  assert.equal(plan.glb.autoFit.surface.status,'unavailable');
  assert.match(field('glb-fit-status').textContent,/高度使用当前填写或保存值/);
  assert.match(field('glb-fit-status').textContent,/原高度保留/);
  assert.equal(plan.inputs.feature.id,'camp-outline');
});

test('automatic surface placement uses one interior photography point and saves its initial-height audit',async()=>{
  const {p}=autoFitPanel(true);
  const calls:number[]=[];
  p.readGlbSurface=async(model:{id:string},points:unknown[])=>{assert.equal(model.id,'photo');calls.push(points.length);return points.map(()=>12);};
  await p.runGlb();
  const plan=p.preview.record,surface=plan.glb.autoFit.surface;
  assert.deepEqual(calls,[1]);
  assert.equal(surface.sampleCount,1);assert.equal(surface.validCount,1);
  assert.equal(surface.status,'sampled');assert.equal(plan.glb.placement.height,surface.maximum);
  assert.equal(plan.inputs.sampleCount,1);assert.equal(plan.modelId,'photo');
  const restored=structuredClone(plan);
  assert.deepEqual(restored.glb.autoFit,plan.glb.autoFit);
  p.records.set(plan.id,restored);p.editGlbPlan(plan.id);
  assert.equal(p.value('glb-placement-mode'),'cad-auto');
  assert.deepEqual(p.glbAutoFit,restored.glb.autoFit);
});

test('manual horizontal GLB placement can initialize its height automatically without changing its position or dimensions',async()=>{
  const {p,field}=autoFitPanel(true);
  p.feature=()=>undefined;field('glb-placement-mode').value='manual';field('glb-elevation').value='';
  const calls:number[]=[];
  p.readGlbSurface=async(_model:unknown,points:unknown[])=>{calls.push(points.length);return points.map(()=>7.25);};
  await p.runGlb();
  const plan=p.preview.record;
  assert.deepEqual(calls,[1]);assert.equal(plan.glb.placementMode,'manual');assert.equal(plan.glb.placement.height,7.25);
  assert.equal(plan.glb.placement.longitude,121);assert.equal(plan.glb.placement.latitude,31);
  assert.deepEqual(plan.glb.placement.dimensions,{length:20,width:10,height:5});
  assert.equal(plan.inputs.sampleCount,1);
});

test('reopening a saved raised GLB keeps the saved height without sampling photography again',async t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm:()=>true}});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');});
  const {p,field}=autoFitPanel(true);
  p.feature=()=>undefined;field('glb-placement-mode').value='manual';field('glb-elevation').value='';
  p.readGlbSurface=async(_model:unknown,points:unknown[])=>points.map(()=>12);
  await p.runGlb();
  const moved=translateTemporaryWorksPlan(p.preview.record,{east:0,north:0,up:3});
  p.records.set(moved.id,moved);p.editGlbPlan(moved.id);
  assert.equal(field('elevation-mode').value,'manual');
  p.readInitialElevation=async()=>{assert.fail('saved elevation must not be reinitialized');};
  await p.runGlb();
  assert.equal(p.preview.record.glb.placement.height,15);assert.equal(p.preview.replaceId,moved.id);
  assert.equal(p.records.get(moved.id),moved);
});

test('explicit height edits keep CAD plane fitting and select manual height without resampling',async t=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'HTMLInputElement');
  class Input {id='tw-glb-elevation';type='number';dataset={};}
  Object.defineProperty(globalThis,'HTMLInputElement',{configurable:true,value:Input});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'HTMLInputElement',descriptor);else Reflect.deleteProperty(globalThis,'HTMLInputElement');});
  const {p,field}=autoFitPanel(true);
  await p.runGlb();
  field('glb-elevation').value='42.123';
  p.edited({target:new Input()});
  assert.equal(field('elevation-mode').value,'manual');
  assert.equal(field('glb-placement-mode').value,'cad-auto');
  p.readGlbSurface=async()=>{assert.fail('manual override must not sample again');};
  await p.runGlb();
  assert.equal(p.preview.record.glb.placement.height,42.123);
  assert.equal(p.preview.record.glb.placementMode,'cad-auto');
  assert.equal(p.preview.record.glb.autoFit.surface.status,'unavailable');
  assert.equal(p.preview.record.inputs.sampleCount,0);
});

test('insufficient or cancelled photography cannot create an automatic placement preview',async()=>{
  const {p,field}=autoFitPanel(true);
  p.readGlbSurface=async(_model:unknown,points:unknown[])=>points.map(()=>null);
  await assert.rejects(p.runGlb(),/未读取到有效倾斜摄影高程/);
  assert.equal(p.preview,undefined);assert.equal(field('glb-elevation').value,'8');
  p.readGlbSurface=async()=>{p.analysis.abort();return [10,11,12];};
  await p.runGlb();
  assert.equal(p.preview,undefined);assert.equal(field('glb-elevation').value,'8');
});

test('restoring an older plan leaves its exact placement in manual mode',()=>{
  const {p,field}=autoFitPanel();
  const old={...oldPlan(),modelId:''};
  p.records.set(old.id,old);p.editGlbPlan(old.id);
  assert.equal(field('glb-placement-mode').value,'manual');
  assert.equal(field('glb-heading').value,'35');assert.equal(field('glb-length').value,'40');
});

test('disconnected building footprints need only one valid initial datum instead of full surface coverage',async()=>{
  const {p}=autoFitPanel(true);
  p.resource().footprints=[{outer:[[0,0],[9,0],[9,10],[0,10]]},{outer:[[11,0],[20,0],[20,10],[11,10]]}];
  const calls:number[]=[];
  p.readGlbSurface=async(_model:unknown,points:unknown[])=>{calls.push(points.length);return points.map(()=>12);};
  await p.runGlb();
  assert.deepEqual(calls,[1]);assert.equal(p.preview.record.glb.placement.height,12);
});

for (const action of ['glb-cancel-edit','glb-clear-logo']) test(`${action} cancels a delayed GLB ready callback before it can restore the retired preview`,async()=>{
  const {p}=autoFitPanel();
  await p.runGlb();
  const old=p.preview.record;
  p.records.set(old.id,old);p.glbEditing=old.id;p.preview=undefined;
  let finish!:()=>void,entered!:()=>void,destroyed=0;
  const loaded=new Promise<void>(resolve=>{entered=resolve;});
  p.cancel=function(this:{analysis?:AbortController}){this.analysis?.abort();this.analysis=undefined;};
  p.draw=()=>{entered();return {ready:new Promise<void>(resolve=>{finish=resolve;}),destroy(){destroyed++;},zoom(){assert.fail('cancelled preview must not zoom');}};};
  const running=p.runGlb();await loaded;
  const button={disabled:false,id:'tw-'+action,dataset:{},hasAttribute:()=>false};
  p.click({target:{closest:()=>button}});
  finish();await running;
  assert.equal(p.preview,undefined);assert.ok(destroyed>=1);assert.equal(p.records.get(old.id),old);
  if(action==='glb-cancel-edit') assert.equal(p.glbEditing,undefined);
  if(action==='glb-clear-logo') assert.equal(p.glbLogo,undefined);
});
