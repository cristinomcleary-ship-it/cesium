import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({load(url, context, next) {
  if (url.endsWith('.css')) return {format:'module',shortCircuit:true,source:'export {};'};
  return next(url,context);
}});
const {TemporaryWorksPanel}=await import('./temporaryWorksPanel.ts');

function fixture(t: import('node:test').TestContext) {
  let approved=false, confirmations=0, reviewed=0;
  const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm(){confirmations++;return approved;}}});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');});
  const original={id:'facility',name:'驻地',visible:true,inputs:{},kind:'camp'};
  const saved={show:false,destroyed:0,destroy(){this.destroyed++;}};
  const draft={show:true,destroyed:0,destroy(){this.destroyed++;}};
  const statuses:string[]=[];
  const p=Object.assign(Object.create(TemporaryWorksPanel.prototype),{
    projectId:'project-a',generation:1,editAccess:true,active:true,busySave:false,disposed:false,
    records:new Map([[original.id,original]]),handles:new Map([[original.id,saved]]),overrides:new Map(),pendingDelete:new Set(),
    lighting:{schemaVersion:1,globalPercent:100,overrides:{}},glbLogoReadToken:0,
    preview:{record:{...original,name:'修改驻地'},replaceId:original.id,handle:draft,checkSource(){}},
    options:{canEdit:()=>true,viewer:{scene:{requestRender(){}}}},
    clearOverlay(){},clearReview(){},buttons(){},list(){},registerSurface(){},updateBrightness(){},
    review(){reviewed++;},el(){return {replaceChildren(){}};},status(message:string){statuses.push(message);},
    cancel(this:{analysis?:AbortController;hardeningEditor?:{cancelDrawing():void}}){this.analysis?.abort();this.analysis=undefined;this.hardeningEditor?.cancelDrawing();},
  });
  return {p,saved,draft,statuses,approve(){approved=true;},get confirmations(){return confirmations;},get reviewed(){return reviewed;}};
}

test('declining navigation preserves the preview, original visibility and running calculation',t=>{
  const f=fixture(t), job=new AbortController();f.p.analysis=job;
  const preview=f.p.preview;
  assert.equal(f.p.close(),false);
  assert.equal(f.p.active,true);assert.equal(f.p.preview,preview);
  assert.equal(f.draft.destroyed,0);assert.equal(f.saved.show,false);
  assert.equal(job.signal.aborted,false);assert.equal(f.confirmations,1);
});

test('confirmed navigation cancels work, removes only preview and restores saved geometry',t=>{
  const f=fixture(t),job=new AbortController();f.p.analysis=job;
  f.p.roadEditing='facility';f.p.hardeningEditing='facility';f.p.draftChanged=true;f.approve();
  assert.equal(f.p.close(),true);
  assert.equal(job.signal.aborted,true);assert.equal(f.draft.destroyed,1);assert.equal(f.saved.destroyed,0);
  assert.equal(f.saved.show,true);assert.equal(f.p.records.size,1);assert.equal(f.p.active,false);
  assert.equal(f.p.roadEditing,undefined);assert.equal(f.p.hardeningEditing,undefined);assert.equal(f.p.hasPendingChanges,false);
});

test('saving and deleting block departure without allowing a destructive confirmation',async t=>{
  const f=fixture(t);f.approve();f.p.busySave=true;
  assert.equal(f.p.close(),false);assert.equal(f.confirmations,0);assert.equal(f.draft.destroyed,0);
  await assert.rejects(f.p.removePlan('facility'),/正在保存/);
  f.p.busySave=false;f.p.pendingDelete.add('pending');
  assert.equal(f.p.close(),false);assert.equal(f.confirmations,0);
  assert.match(f.statuses[0],/保存或删除/);
});

test('same-project synchronization preserves dirty form and preview even with force',async t=>{
  const f=fixture(t),preview=f.p.preview;f.p.draftChanged=true;
  assert.equal(await f.p.setProject('project-a',{force:true}),true);
  assert.equal(f.p.preview,preview);assert.equal(f.p.draftChanged,true);assert.equal(f.confirmations,0);
});

test('denied project change cannot mutate the selected project or its edit permission',async t=>{
  const f=fixture(t);f.p.options.canEdit=()=>false;
  assert.equal(await f.p.setProject('project-b'),false);
  assert.equal(f.p.projectId,'project-a');assert.equal(f.p.editAccess,true);assert.equal(f.draft.destroyed,0);
});

test('permission revocation clears unsaved preview without asking to retain unauthorized editing',async t=>{
  const f=fixture(t);f.p.options.canEdit=()=>false;
  assert.equal(await f.p.setProject('project-a',{force:true}),true);
  assert.equal(f.p.preview,undefined);assert.equal(f.draft.destroyed,1);assert.equal(f.p.editAccess,false);
  assert.equal(f.confirmations,0);assert.equal(f.saved.destroyed,0);
});

test('forced project authority change clears old previews and handles without retaining their data',async t=>{
  const f=fixture(t);f.p.busySave=true;
  Object.assign(f.p,{
    surfaceReady:new Set(),surfaceStates:new Map(),surfaceDerived:new Map(),surfaceRevision:0,
    mountHardeningEditor(){},restoreBrightnessControls(){},updateGlbResource(){},refresh(){},updateFields(){},featurePreview(){},
    input(){return {checked:true};},
  });
  Object.assign(f.p.options,{root:{innerHTML:''},store:{async list(projectId:string){assert.equal(projectId,'project-b');return [];}}});
  assert.equal(await f.p.setProject('project-b',{force:true}),true);
  assert.equal(f.p.projectId,'project-b');assert.equal(f.p.records.size,0);assert.equal(f.p.handles.size,0);
  assert.equal(f.draft.destroyed,1);assert.equal(f.saved.destroyed,1);assert.equal(f.confirmations,0);
});

test('inspect and edit shortcuts cannot silently replace a different object draft',t=>{
  const f=fixture(t),preview=f.p.preview;
  assert.equal(f.p.inspectPlan('facility'),false);assert.equal(f.p.preview,preview);assert.equal(f.reviewed,0);
  assert.equal(f.p.editPlan('facility'),false);assert.equal(f.p.preview,preview);
  f.approve();assert.equal(f.p.inspectPlan('facility'),true);assert.equal(f.reviewed,1);assert.equal(f.draft.destroyed,1);
});

test('an unfinished hardening outline is guarded before it becomes a mesh preview',t=>{
  const f=fixture(t);f.p.preview=undefined;let drawing=true;
  f.p.hardeningEditor={get isDrawing(){return drawing;},cancelDrawing(){drawing=false;}};
  assert.equal(f.p.close(),false);assert.equal(drawing,true);
  f.approve();assert.equal(f.p.close(),true);assert.equal(drawing,false);
});

test('untouched saved editor can close without confirmation; edited form alone is protected',t=>{
  const f=fixture(t);f.p.preview=undefined;f.p.glbEditing='facility';
  assert.equal(f.p.requestLeave(),true);assert.equal(f.confirmations,0);
  f.p.draftChanged=true;assert.equal(f.p.requestLeave(),false);assert.equal(f.confirmations,1);
});
