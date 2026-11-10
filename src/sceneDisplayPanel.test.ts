import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { SceneDisplayStore } from './sceneDisplayStore.ts';
import type { SceneDisplayItem } from './sceneDisplayPanel.ts';

// Exercise directory lifecycle independently of browser layout; the browser
// acceptance covers rendered controls. Production CSS needs no CPU-test loader.
registerHooks({ load(url, context, next) {
  if (url.endsWith('/sceneDisplayPanel.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { SceneDisplayPanel } = await import('./sceneDisplayPanel.ts');
function fixture() {
  const values = new Map<string, string>(), search = { value: '' };
  const store = new SceneDisplayStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  let renders = 0, applies = 0;
  // Skip DOM construction while invoking the actual setContext/remove/apply
  // methods and preference store, including asynchronous host updates.
  const panel = Object.assign(Object.create(SceneDisplayPanel.prototype), {
    store, items: [], itemsById: new Map(), selected: new Set(), query: '', editor: undefined, message: '', error: false,
    applying: false, disposed: false, directorySignature: '', appliedSignature: '', contextRevision: 0, removing: new Set(),
    options: { onApply: () => { applies++; }, confirmRemoval: () => true },
    find: () => search, render: () => { renders++; }, renderList: () => undefined, renderStatus: () => undefined,
  });
  return { panel, store, renders: () => renders, applies: () => applies };
}
const item = (overrides: Partial<SceneDisplayItem> = {}): SceneDisplayItem => ({ id: 'machine:one', name: '吊机', category: '施工机械', visible: true, ...overrides });

test('unchanged directory refreshes update callbacks without rerendering or applying visibility again', () => {
  const f = fixture(); let edited = '';
  f.panel.setContext('project', 'actor', [item({ edit: () => { edited = 'old'; } })]);
  const renders = f.renders(), applies = f.applies();
  for (let i = 0; i < 30; i++) f.panel.setContext('project', 'actor', [item({ edit: () => { edited = 'current'; } })]);
  assert.equal(f.renders(), renders); assert.equal(f.applies(), applies);
  f.panel.items[0].edit(); assert.equal(edited, 'current', 'a stable row still uses the newest authorization-aware action');
  f.panel.setContext('project', 'actor', [item({ name: '已改名', edit: () => undefined })]);
  assert.equal(f.renders(), renders + 1); assert.equal(f.applies(), applies, 'a name update does not redraw scene visibility');
  f.panel.reapply(); assert.equal(f.applies(), applies + 1, 'hosts retain an explicit renderer-rebuild hook');
});

test('removing only a model cannot delete the resource row supplied by the removal snapshot', async () => {
  const f = fixture();
  f.panel.setContext('project', 'actor', [item({ removalPreservesResource: true, remove: async () => {
    f.panel.setContext('project', 'actor', [item({ visibilityAvailable: false, detail: '尚未布置' })]);
  } })]);
  f.panel.setVisibility(['machine:one'], false);
  const group = f.store.createGroup('施工布置', ['machine:one']);
  await f.panel.removeItem('machine:one');
  assert.equal(f.panel.items.length, 1); assert.equal(f.panel.items[0].visibilityAvailable, false);
  assert.equal(f.store.getOverrides()['machine:one'], false);
  assert.deepEqual(f.store.getGroups()[0].members, ['machine:one']); assert.equal(f.store.groupState(group.id), 'empty');
  f.panel.setContext('project', 'actor', [item()]);
  assert.equal(f.store.isVisible('machine:one'), false, 'reconfigured model restores its existing hidden preference');
});

test('a completed removal from an earlier project cannot mutate the current directory', async () => {
  const f = fixture(); let finish!: () => void;
  f.panel.setContext('project-a', 'actor', [item({ removalPreservesResource: true, remove: () => new Promise<void>(resolve => { finish = resolve; }) })]);
  const removing = f.panel.removeItem('machine:one');
  f.panel.setContext('project-b', 'actor', [item({ name: '其他工程吊机' })]);
  finish(); await removing;
  assert.equal(f.panel.items[0].name, '其他工程吊机'); assert.equal(f.store.isVisible('machine:one'), true);
});

test('cancelling a facility removal from the planner retains its model row, hidden preference and groups; retry removes the same id', async () => {
  const f = fixture();
  const id = 'temporary-works:camp', steel = 'temporary-works:steel';
  let approved = false, removes = 0;
  f.panel.setContext('p','me',[
    item({id,name:'项目驻地',category:'临建规划',remove:async()=>{removes++;return approved;}}),
    item({id:steel,name:'钢筋场',category:'临建规划'}),
  ]);
  f.store.setVisibility([id], false);
  const group = f.store.createGroup('施工设施',[id,steel]);
  await f.panel.removeItem(id);
  assert.equal(removes,1);
  assert.deepEqual(f.panel.items.map((i:SceneDisplayItem)=>i.id),[id,steel]);
  assert.equal(f.store.getOverrides()[id],false);
  assert.deepEqual(f.store.getGroups()[0].members,[id,steel]);
  assert.match(f.panel.message,/已取消/);
  approved = true;
  await f.panel.removeItem(id);
  assert.equal(removes,2);
  assert.deepEqual(f.panel.items.map((i:SceneDisplayItem)=>i.id),[steel]);
  assert.equal(Object.hasOwn(f.store.getOverrides(),id),false);
  assert.deepEqual(f.store.getGroups()[0],{...group,members:[steel]});
});

test('unloading a scene instance preserves its saved preferences and memberships for reloading', async () => {
  const f = fixture(); const id = 'layer:cad'; let calls = 0;
  const layer = item({ id, name: '施工图', removalKind: 'unload', remove: () => { calls++; } });
  f.panel.setContext('project', 'actor', [layer]);
  f.panel.setVisibility([id], false);
  const group = f.store.createGroup('图纸', [id]);
  await f.panel.removeItem(id);
  assert.equal(calls, 1); assert.equal(f.panel.items.length, 0);
  assert.equal(f.store.getOverrides()[id], false); assert.deepEqual(f.store.getGroups(), [group]);
  f.panel.setContext('project', 'actor', [layer]);
  assert.equal(f.store.isVisible(id), false); assert.deepEqual(f.store.getGroups(), [group]);
  assert.match(f.panel.message, /移出本次场景/);
});

test('declining destructive removal never invokes the host or changes the directory', async () => {
  const f = fixture(); let calls = 0, message = '';
  f.panel.options.confirmRemoval = (value: string) => { message = value; return false; };
  f.panel.setContext('project', 'actor', [item({ removalDescription: '删除台账与三维对象，历史记录保留', remove: () => { calls++; } })]);
  await f.panel.removeItem('machine:one');
  assert.equal(calls, 0); assert.equal(f.panel.items.length, 1);
  assert.match(message, /删除台账与三维对象/); assert.match(f.panel.message, /已取消删除/);
});

test('a professional owner confirmation is reused without a duplicate confirmation', async () => {
  const f = fixture(); let confirmations = 0, removals = 0;
  f.panel.options.confirmRemoval = () => { confirmations++; return true; };
  f.panel.setContext('project', 'actor', [item({ removalConfirmedByHost: true, remove: () => { removals++; return false; } })]);
  await f.panel.removeItem('machine:one');
  assert.equal(confirmations, 0); assert.equal(removals, 1); assert.equal(f.panel.items.length, 1);
});

test('external persisted deletion clears only the deleted member and survives reloading preferences', () => {
  const f = fixture(), id = 'layer:model', other = 'layer:cad';
  const rows = [item({ id }), item({ id: other })];
  f.panel.setContext('project', 'actor', rows);
  f.panel.setVisibility([id, other], false);
  f.store.createGroup('资料', [id, other]);
  const completed = f.panel.prepareItemDeletion(id);
  assert.equal(f.panel.items.length, 2, 'preparing a delete does not remove anything');
  completed();
  assert.deepEqual(f.panel.items.map((row: SceneDisplayItem) => row.id), [other]);
  assert.deepEqual(f.store.getOverrides(), { [other]: false });
  assert.deepEqual(f.store.getGroups()[0].members, [other]);
  f.panel.setContext('different', 'actor', []);
  f.panel.setContext('project', 'actor', [rows[1]]);
  assert.deepEqual(f.store.getOverrides(), { [other]: false });
  assert.deepEqual(f.store.getGroups()[0].members, [other], 'no deleted member remains as temporarily unavailable');
});

for (const next of [{ project: 'another-project', actor: 'actor' }, { project: 'project', actor: 'another-actor' }]) {
  test(`external deletion captures its initial scope across ${next.project}/${next.actor}`, () => {
    const f = fixture(), id = 'layer:model';
    f.panel.setContext('project', 'actor', [item({ id })]);
    f.panel.setVisibility([id], false); f.store.createGroup('原分组', [id]);
    const completed = f.panel.prepareItemDeletion(id);
    f.panel.setContext(next.project, next.actor, [item({ id, name: '当前项目资料' })]);
    f.panel.setVisibility([id], false); const group = f.store.createGroup('当前分组', [id]);
    const renders = f.renders(), applies = f.applies();
    completed();
    assert.equal(f.panel.items[0].name, '当前项目资料');
    assert.deepEqual(f.store.getOverrides(), { [id]: false }); assert.deepEqual(f.store.getGroups(), [group]);
    assert.equal(f.renders(), renders); assert.equal(f.applies(), applies);
    f.panel.setContext('project', 'actor', []);
    assert.deepEqual(f.store.getOverrides(), {}); assert.deepEqual(f.store.getGroups()[0].members, []);
  });
}
