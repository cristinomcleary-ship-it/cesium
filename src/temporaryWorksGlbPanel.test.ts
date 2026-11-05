import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import { Matrix4 } from 'cesium';
registerHooks({load(url,context,next) {
  if (url.endsWith('.css')) return {format:'module',shortCircuit:true,source:'export {};'};
  return next(url,context);
}});
const {TemporaryWorksPanel} = await import('./temporaryWorksPanel.ts');

const glb = {resourceId:'camp',clippingEnabled:true,placement:{longitude:121,latitude:31,height:8,headingDeg:35,
  scaleMode:'uniform',dimensions:{length:40,width:20,height:10}},branding:{visible:true,text:'东方雄师 铁建劲旅',logoUrl:'data:image/png;base64,AA=='}};
const oldPlan = () => ({id:'saved-camp',name:'项目部',kind:'camp',visible:true,createdAt:'2026-11-05T00:00:00Z',glb:structuredClone(glb),inputs:{feature:{id:'source-cad'},road:undefined}});
const panel = (fields:object) => Object.assign(Object.create(TemporaryWorksPanel.prototype),{
  projectId:'project-a',generation:3,upgradeEnabled:true,disposed:false,busySave:false,overrides:new Map(),records:new Map(),handles:new Map(),
  buttons(){},list(){},review(){},updateFields(){},status(){},failure(error:Error){throw error;},...fields,
});

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
    glbEditing:old.id,preview:{replaceId:old.id,handle:{destroy(){discarded++;}}},
    dropPreview(this:{preview?:{handle:{destroy():void}}}){this.preview?.handle.destroy();this.preview=undefined;},
    options:{store:{async remove(){}}},
  });
  assert.equal(await p.removePlan(old.id),true);
  assert.equal(destroyed,1);assert.equal(discarded,1);assert.equal(p.preview,undefined);assert.equal(p.glbEditing,undefined);
});

function standalonePanel(resourceId='camp',clipping=false) {
  const values:Record<string,string>={model:'',name:'精确坐标模型','glb-lon':'121','glb-lat':'31','glb-elevation':'8',
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
