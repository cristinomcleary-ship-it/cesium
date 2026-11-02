import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
}});
const {TemporaryWorksPanel} = await import('./temporaryWorksPanel.ts');

test('facility CRUD commits storage before scene removal; a denied, cancelled or failed removal leaves every representation intact', async t => {
  let authorized = false, approved = false, fail = true, removals = 0, destructions = 0, notifications = 0;
  const confirm = t.mock.fn(()=>approved);
  Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm}});
  t.after(()=>{ Reflect.deleteProperty(globalThis,'window'); });
  const plan = {id:'camp',name:'项目驻地',kind:'camp',visible:true};
  const mesh = {show:true,destroy:()=>{destructions++;}};
  const panel = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    projectId:'A', records:new Map([[plan.id,plan]]), handles:new Map([[plan.id,mesh]]),
    pendingDelete:new Set(), overrides:new Map(), disposed:false, inspecting:undefined,
    options: {canEdit:()=>authorized,onPlansChanged:()=>{notifications++;},store:{
      async remove(project:string,id:string) { assert.equal(project,'A');assert.equal(id,'camp');removals++;if(fail) throw new Error('存储忙'); }
    }}, list:()=>{},status:()=>{},
  });
  panel.setPlanVisible('camp',false);
  assert.equal(mesh.show,false);
  await assert.rejects(panel.removePlan('camp'),/权限/);
  assert.equal(confirm.mock.callCount(),0);
  authorized=true;
  assert.equal(await panel.removePlan('camp'),false);
  assert.equal(removals,0);
  approved=true;
  await assert.rejects(panel.removePlan('camp'),/存储忙/);
  assert.equal(removals,1);assert.equal(destructions,0);
  assert.equal(panel.pendingDelete.size,0);
  assert.equal(panel.records.get('camp'),plan);
  assert.equal(panel.handles.get('camp'),mesh);
  assert.equal(panel.overrides.get('camp'),false);
  fail=false;
  assert.equal(await panel.removePlan('camp'),true);
  assert.equal(removals,2);assert.equal(destructions,1);assert.equal(notifications,1);
  assert.equal(panel.records.size,0);assert.equal(panel.handles.size,0);assert.equal(panel.overrides.size,0);
});

test('a delayed deletion cannot tear down a new project with the same plan id',async t=>{
  Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm:()=>true}});
  t.after(()=>{Reflect.deleteProperty(globalThis,'window');});
  let finish!:()=>void, removals=0;
  const record={id:'same',name:'工程一驻地',visible:true};
  const mesh={destroy:()=>assert.fail('must not destroy another project mesh')};
  const panel=Object.assign(Object.create(TemporaryWorksPanel.prototype),{
    projectId:'first',records:new Map([['same',record]]),handles:new Map([['same',mesh]]),pendingDelete:new Set(),overrides:new Map(),
    options:{store:{remove:()=>{removals++;return new Promise<void>(resolve=>{finish=resolve;});}}},list:()=>{},status:()=>{},
  });
  const removing=panel.removePlan('same');
  assert.equal(await panel.removePlan('same'),false);
  panel.projectId='second';
  const other={...record,name:'工程二驻地'};
  panel.records.set('same',other);
  finish();await removing;
  assert.equal(removals,1);assert.equal(panel.pendingDelete.size,0);assert.equal(panel.records.get('same'),other);
});
