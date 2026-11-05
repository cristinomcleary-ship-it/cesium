import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
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
    dropPreview(){this.preview.handle.destroy();this.preview=undefined;},
    options:{store:{async remove(){}}},
  });
  assert.equal(await p.removePlan(old.id),true);
  assert.equal(destroyed,1);assert.equal(discarded,1);assert.equal(p.preview,undefined);assert.equal(p.glbEditing,undefined);
});
