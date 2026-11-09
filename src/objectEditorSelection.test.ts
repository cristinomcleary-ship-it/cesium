import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { CustomDataSource } from 'cesium';
import { FoundationPitMonitoring } from './foundationPitMonitoring.ts';

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', shortCircuit: true, source: 'export {};' } : next(url, context);
} });
const { MarkupTools } = await import('./markupTools.ts');

function controls() {
  const section = { tagName: 'DETAILS', open: false, parentElement: null };
  const fields = new Map<string, { value: string; checked: boolean; parentElement: typeof section; focused: boolean; focus(): void; scrollIntoView(): void }>();
  const field = (id: string) => {
    if (!fields.has(id)) fields.set(id, { value: '', checked: false, parentElement: section, focused: false, focus() { this.focused = true; }, scrollIntoView() {} });
    return fields.get(id)!;
  };
  return { field, section };
}

function pitFixture() {
  const c = controls(), source = new CustomDataSource('pit-selection');
  source.entities.add({ id: 'foundation-pit-anchor-pit-a' });
  source.entities.add({ id: 'foundation-pit-anchor-pit-b' });
  source.entities.add({ id: 'foundation-pit-point-point-b' });
  source.entities.add({ id: 'foundation-pit-support-monitor-support-b' });
  const state = { version: 3,
    pits: [{ id: 'pit-a', name: '同名基坑', visible: true, supportDepths: [] }, { id: 'pit-b', name: '同名基坑', visible: false, supportDepths: [] }],
    points: [{ id: 'point-b', name: '位移点', pitId: 'pit-b', placement: 'enclosure', speedThreshold: 5, cumulativeThreshold: 10, records: [] }],
    supportMonitors: [{ id: 'support-b', name: '轴力点', pitId: 'pit-b', records: [] }],
  };
  const messages: string[] = [];
  const monitoring = Object.assign(Object.create(FoundationPitMonitoring.prototype), {
    state, dataSource: source, viewer: { selectedEntity: undefined }, displayAllowed: true, displayDisposed: false, pickMode: null,
    input: c.field, element: c.field, toast: (message: string) => messages.push(message),
    loadPitIntoForm(pit: { id: string; name: string }) { c.field('#pitActivePit').value = pit.id; c.field('#pitName').value = pit.name; },
    renderSupportTargetOptions() {}, renderCustomSupportList() {}, renderPitManagementList() {},
    syncRecordPointFields() {}, renderTrend() {},
    render() { throw new Error('Selection and failed persistence must not rebuild the scene'); },
  }) as FoundationPitMonitoring;
  return { ...c, monitoring, state, source, messages };
}

test('pit directory selects exact saved identities and the matching monitoring editor without saving or moving the camera', () => {
  const f = pitFixture(), before = structuredClone(f.state);
  f.monitoring.selectDisplayObject('pit:model:pit-b');
  assert.equal(f.field('#pitActivePit').value, 'pit-b', 'same names must not select the first pit');
  assert.equal(f.section.open, true);
  assert.equal(f.field('#pitName').focused, true);
  f.monitoring.selectDisplayObject('pit:point:point-b');
  assert.equal(f.field('#pitRecordPoint').value, 'point-b');
  assert.equal(f.field('#pitTrendPoint').value, 'point-b');
  assert.equal(f.field('#pitPointName').value, '', 'saved point must not become a new point draft');
  assert.equal((f.monitoring as unknown as { viewer: { selectedEntity: { id: string } } }).viewer.selectedEntity.id, 'foundation-pit-point-point-b');
  f.monitoring.selectDisplayObject('pit:support:support-b');
  assert.equal(f.field('#pitSupportRecordMonitor').value, 'support-b');
  assert.deepEqual(f.state, before);
});

test('pit selection refuses removed objects, revoked access and unfinished picking without touching the editor', () => {
  const f = pitFixture();
  f.field('#pitName').value = '未保存输入';
  assert.throws(() => f.monitoring.selectDisplayObject('pit:point:missing'), /已删除/);
  Object.assign(f.monitoring, { pickMode: 'support' });
  assert.throws(() => f.monitoring.selectDisplayObject('pit:model:pit-b'), /结束当前基坑取点/);
  Object.assign(f.monitoring, { pickMode: null, displayAllowed: false });
  assert.throws(() => f.monitoring.selectDisplayObject('pit:model:pit-b'), /无法访问/);
  assert.equal(f.field('#pitName').value, '未保存输入');
});

test('markup selection uses the existing object and reveals the editor; drawing and pending textures stay intact', () => {
  const c = controls(), source = new CustomDataSource('markup-selection');
  source.entities.add({ id: 'markup-a' }); source.entities.add({ id: 'markup-b' });
  const records = [{ id: 'markup-a', name: '同名标绘' }, { id: 'markup-b', name: '同名标绘' }];
  const instance = Object.assign(Object.create(MarkupTools.prototype), {
    records, dataSource: source, viewer: { isDestroyed: () => false, selectedEntity: undefined }, disposed: false,
    drawingKind: null, redrawId: null, pendingTexture: null, textureSelectionPromise: null,
    fillForm(record: { name: string }) { c.field('#markupName').value = record.name; }, render() {},
  }) as InstanceType<typeof MarkupTools>;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: c.field } });
  try {
    instance.selectDisplayObject('markup-b');
    assert.equal((instance as unknown as { selectedId: string }).selectedId, 'markup-b');
    assert.equal(c.section.open, true);
    assert.equal(c.field('#markupName').focused, true);
    assert.equal((instance as unknown as { viewer: { selectedEntity: { id: string } } }).viewer.selectedEntity.id, 'markup-b');
    c.field('#markupName').value = '未完成绘制';
    Object.assign(instance, { drawingKind: 'polygon' });
    assert.throws(() => instance.selectDisplayObject('markup-a'), /完成或取消/);
    Object.assign(instance, { drawingKind: null, pendingTexture: { id: 'texture-a' } });
    assert.throws(() => instance.selectDisplayObject('markup-a'), /贴图编辑/);
    Object.assign(instance, { pendingTexture: null });
    assert.throws(() => instance.selectDisplayObject('missing'), /已删除/);
    assert.equal(c.field('#markupName').value, '未完成绘制');
    assert.equal(records.length, 2);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('a failed monitoring reading write preserves saved data and input, then a retry writes exactly one record', () => {
  const f = pitFixture();
  f.field('#pitRecordPoint').value = 'point-b';
  f.field('#pitRecordTime').value = '2026-11-09T12:00';
  f.field('#pitRecordX').value = '1'; f.field('#pitRecordY').value = '2'; f.field('#pitRecordZ').value = '3';
  f.field('#pitRecordNote').value = '现场原始记录';
  const original = structuredClone(f.state);
  let fail = true, writes = 0, renders = 0;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem() { if (fail) throw new Error('QuotaExceededError'); writes++; } } });
  Object.assign(f.monitoring, { metrics: () => ({ status: 'normal', reasons: [] }), render() { renders++; } });
  const internal = f.monitoring as unknown as { addRecord(): void; state: typeof f.state };
  try {
    internal.addRecord();
    assert.deepEqual(internal.state, original);
    assert.equal(f.field('#pitRecordNote').value, '现场原始记录');
    assert.equal(f.field('#pitRecordTime').value, '2026-11-09T12:00');
    assert.equal(renders, 0); assert.equal(writes, 0);
    assert.equal(f.messages.length, 1); assert.match(f.messages[0], /保存失败/);
    fail = false;
    internal.addRecord();
    assert.equal(internal.state.points[0].records.length, 1);
    assert.equal(writes, 1); assert.equal(renders, 1);
    assert.equal(f.field('#pitRecordNote').value, '');
    assert.match(f.messages.at(-1)!, /日报已保存/);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('CSV storage failure rolls back imported rows and never reports an import success', async () => {
  const f = pitFixture(), original = structuredClone(f.state);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem() { throw new Error('QuotaExceededError'); } } });
  const internal = f.monitoring as unknown as { importCsv(file: File): Promise<void>; state: typeof f.state };
  try {
    const file = new File(['监测点编号,监测时间,X,Y,Z\npoint-b,2026-11-09T12:00:00+08:00,2,3,4'], 'readings.csv');
    await internal.importCsv(file);
    assert.deepEqual(internal.state, original);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0], /保存失败/);
    assert.doesNotMatch(f.messages[0], /导入完成/);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
