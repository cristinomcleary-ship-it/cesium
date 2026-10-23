import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { CustomDataSource, JulianDate, type Viewer } from 'cesium';

// Presentation styles have no behavior in this actual-entity CPU contract check.
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', shortCircuit: true, source: 'export default {};' } : nextLoad(url, context);
} });
const { MarkupTools } = await import('./markupTools.ts');

type FixtureRecord = {
  id: string; name: string; kind: 'point' | 'text'; note: string; visible: boolean; updatedAt: string; createdAt: string;
  heightMode: 'picked'; positions: Array<{ longitude: number; latitude: number; height: number }>;
  style: { color: string; opacity: number; fontSize: number; pointSize: number };
};
const record = (id: string, visible = true, kind: 'point' | 'text' = 'point'): FixtureRecord => ({
  id, name: id, kind, note: '', visible, updatedAt: '2026-10-14T00:00:00Z', createdAt: '2026-10-14T00:00:00Z',
  heightMode: 'picked', positions: [{ longitude: 121, latitude: 31, height: 5 }],
  style: { color: '#32d5f2', opacity: 0.8, fontSize: 15, pointSize: 12 },
});
function fixture(records: FixtureRecord[]) {
  const source = new CustomDataSource('display-test');
  const viewer = { isDestroyed: () => false, scene: { requestRender() {} } } as unknown as Viewer;
  // Bypass only UI construction; all tested inventory, display and entity rendering methods are real.
  const tools = Object.assign(Object.create(MarkupTools.prototype), {
    viewer, dataSource: source, records, displayVisibility: new Map<string, boolean>(), displayLabelsVisible: true,
    textureUrls: new Map(), disposed: false, selectedId: null, render() {},
    mutate() { throw new Error('Display operations must not call mutate'); },
    persistPayload() { throw new Error('Display operations must not write saved records'); },
  }) as InstanceType<typeof MarkupTools>;
  const internal = tools as unknown as { rebuildEntities(): void };
  internal.rebuildEntities();
  return { tools, source, internal };
}

test('markup inventory is complete and temporary visibility preserves records and timestamps', () => {
  const records = Array.from({ length: 125 }, (_, i) => record(`item:${i}`, i !== 124));
  const before = structuredClone(records), f = fixture(records);
  assert.equal(f.tools.getOverviewSnapshot().items.length, 100);
  assert.equal(f.tools.getDisplayItems().length, 125, 'unified controls include objects beyond the compact overview limit');
  const overrides = { 'item:0': false, 'item:124': true };
  f.tools.setDisplayVisibility(overrides);
  overrides['item:124'] = false;
  assert.equal(f.source.entities.getById('item:0')!.show, false);
  assert.equal(f.source.entities.getById('item:0')!.label!.show!.getValue(JulianDate.now()), false, 'hidden parent hides its nameplate too');
  assert.equal(f.source.entities.getById('item:124')!.show, true, 'saved hidden objects can be displayed temporarily');
  const last = f.tools.getDisplayItems().at(-1)!;
  assert.equal(last.visible, true); assert.equal(last.defaultVisible, false);
  last.name = 'caller mutation'; assert.equal(f.tools.getDisplayItems().at(-1)!.name, 'item:124');
  f.internal.rebuildEntities();
  assert.equal(f.source.entities.getById('item:0')!.show, false, 'later entity rebuilds obey overrides');
  assert.equal(f.source.entities.getById('item:124')!.show, true);
  f.tools.setDisplayVisibility({});
  assert.equal(f.source.entities.getById('item:0')!.show, true);
  assert.equal(f.source.entities.getById('item:124')!.show, false);
  assert.deepEqual(records, before, 'visibility preferences do not modify visible, updatedAt, geometry or names');
});

test('global nameplate hiding preserves text annotation content and always follows parent visibility', () => {
  const f = fixture([record('point'), record('text', true, 'text')]), now = JulianDate.now();
  f.tools.setDisplayVisibility({}, false);
  assert.equal(f.source.entities.getById('point')!.label!.show!.getValue(now), false);
  assert.equal(f.source.entities.getById('point')!.show, true);
  assert.equal(f.source.entities.getById('text')!.label!.show!.getValue(now), true, 'a text annotation is content, not an attached nameplate');
  f.internal.rebuildEntities();
  assert.equal(f.source.entities.getById('point')!.label!.show!.getValue(now), false);
  assert.equal(f.source.entities.getById('text')!.label!.show!.getValue(now), true);
  f.tools.setDisplayVisibility({ text: false }, false);
  assert.equal(f.source.entities.getById('text')!.show, false);
  assert.equal(f.source.entities.getById('text')!.label!.show!.getValue(now), false);
  f.tools.setDisplayVisibility({});
  assert.equal(f.source.entities.getById('point')!.label!.show!.getValue(now), true);
});
