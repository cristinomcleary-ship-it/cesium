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
    store, items: [], selected: new Set(), query: '', editor: undefined, message: '', error: false,
    applying: false, disposed: false, directorySignature: '', appliedSignature: '', contextRevision: 0, removing: new Set(),
    options: { onApply: () => { applies++; } },
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
