import assert from 'node:assert/strict';
import test, { before, after, afterEach } from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const original = { window: globalThis.window, localStorage: globalThis.localStorage, indexedDB: globalThis.indexedDB, document: globalThis.document };
let directory, FoundationPitMonitoring, SubsurfaceTools, putArchiveRecord, deleteArchiveRecord, ThreeDReport, ReportComposer, ElectronicSandTable;
before(async () => {
  await mkdir('tmp', { recursive: true });
  directory = await mkdtemp(join(resolve('tmp'), 'local-deletion-'));
  await build({ stdin: { contents: 'export { FoundationPitMonitoring } from "./src/foundationPitMonitoring.ts"; export { SubsurfaceTools, putArchiveRecord, deleteArchiveRecord } from "./src/subsurfaceTools.ts"; export { ThreeDReport } from "./src/threeDReport.ts"; export { ReportComposer } from "./src/reportComposer.ts"; export { ElectronicSandTable } from "./src/electronicSandTable.ts";', resolveDir: process.cwd(), loader: 'ts' }, outfile: join(directory, 'fixture.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' }, plugins: [{ name: 'private-storage-test-exports', setup(builder) {
    builder.onLoad({ filter: /\/subsurfaceTools\.ts$/ }, async args => ({ contents: await readFile(args.path, 'utf8') + '\nexport { putArchiveRecord, deleteArchiveRecord };', loader: 'ts', resolveDir: resolve('src') }));
  } }] });
  ({ FoundationPitMonitoring, SubsurfaceTools, putArchiveRecord, deleteArchiveRecord, ThreeDReport, ReportComposer, ElectronicSandTable } = await import(pathToFileURL(join(directory, 'fixture.mjs')).href));
});
afterEach(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) Reflect.deleteProperty(globalThis, key); else globalThis[key] = value; } });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function pitFixture() {
  const state = { version: 3,
    pits: [{ id: 'pit-a', name: 'A', customSupports: [{ id: 'custom-a', name: '斜撑' }, { id: 'custom-b', name: '保留支撑' }] }, { id: 'pit-b', name: 'B', customSupports: [] }],
    points: [{ id: 'point-a', name: '监测点', pitId: 'pit-a', records: [{ value: 1 }] }, { id: 'point-b', pitId: 'pit-b', records: [{ value: 2 }] }],
    supportMonitors: [{ id: 'monitor-a', name: '轴力', pitId: 'pit-a', targetType: 'custom', targetId: 'custom-a', records: [{ value: 3 }] }, { id: 'monitor-b', pitId: 'pit-a', targetType: 'custom', targetId: 'custom-b', records: [{ value: 4 }] }, { id: 'monitor-c', pitId: 'pit-b', records: [] }],
  };
  const messages = [], rendered = [], forms = [], storage = new Map(); let fail = false;
  globalThis.window = { confirm: () => true };
  globalThis.localStorage = { setItem(key, value) { if (fail) throw new Error('quota'); storage.set(key, value); } };
  const owner = Object.assign(Object.create(FoundationPitMonitoring.prototype), { state, activePit() { return this.state.pits[0]; }, render(id) { rendered.push(id); }, loadPitIntoForm(pit) { forms.push(pit); }, beginNewPit() { forms.push(null); }, toast(message, error) { messages.push({ message, error }); } });
  return { owner, state, messages, rendered, forms, storage, fail(value) { fail = value; } };
}
function click(dataset) { return { target: { closest: () => ({ dataset }) } }; }
const deletions = {
  pit: f => f.owner.deleteActivePit(),
  customSupport: f => f.owner.handleCustomSupportAction(click({ customSupportAction: 'delete', supportId: 'custom-a' })),
  supportMonitor: f => f.owner.handleSupportMonitorAction(click({ supportMonitorAction: 'delete', monitorId: 'monitor-a' })),
  point: f => f.owner.handleListAction(click({ pitAction: 'delete', pointId: 'point-a' })),
};
for (const [kind, invoke] of Object.entries(deletions)) {
  test(`${kind} deletion retains all displayed and stored records on persistence failure, then commits exact cascade on retry`, () => {
    const f = pitFixture(), before = structuredClone(f.state); f.fail(true); invoke(f);
    assert.deepEqual(f.owner.state, before); assert.equal(f.owner.state, f.state, 'failure retains original object identities and editing references');
    assert.deepEqual(f.rendered, []); assert.deepEqual(f.forms, []); assert.equal(f.storage.size, 0);
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0].error, true); assert.match(f.messages[0].message, /原数据已保留/);
    f.fail(false); invoke(f);
    const after = f.owner.state;
    assert.deepEqual(JSON.parse([...f.storage.values()][0]), after, 'fresh page state matches the scene after delete');
    assert.deepEqual(after.pits.find(pit => pit.id === 'pit-b'), before.pits[1]);
    assert.deepEqual(after.points.find(point => point.id === 'point-b'), before.points[1]);
    assert.deepEqual(after.supportMonitors.find(monitor => monitor.id === 'monitor-c'), before.supportMonitors[2]);
    if (kind === 'pit') { assert.deepEqual(after.pits.map(x => x.id), ['pit-b']); assert.deepEqual(after.points.map(x => x.id), ['point-b']); assert.deepEqual(after.supportMonitors.map(x => x.id), ['monitor-c']); }
    if (kind === 'customSupport') { assert.deepEqual(after.pits[0].customSupports.map(x => x.id), ['custom-b']); assert.deepEqual(after.supportMonitors.map(x => x.id), ['monitor-b', 'monitor-c']); assert.deepEqual(after.points, before.points); assert.equal(f.forms[0], after.pits[0]); }
    if (kind === 'supportMonitor') { assert.deepEqual(after.supportMonitors.map(x => x.id), ['monitor-b', 'monitor-c']); assert.deepEqual(after.pits, before.pits); assert.deepEqual(after.points, before.points); }
    if (kind === 'point') { assert.deepEqual(after.points.map(x => x.id), ['point-b']); assert.deepEqual(after.pits, before.pits); assert.deepEqual(after.supportMonitors, before.supportMonitors); }
    assert.equal(f.rendered.length, 1); assert.match(f.messages.at(-1).message, /已删除/);
  });
}
function archiveDatabase() {
  let transaction, request, closed = 0;
  const database = { close() { closed++; }, transaction() { transaction = { error: null, objectStore() { return { put() { request = {}; return request; }, delete() { request = {}; return request; } }; } }; return transaction; } };
  globalThis.indexedDB = { open() { const opening = { result: database }; queueMicrotask(() => opening.onsuccess?.()); return opening; } };
  return { get transaction() { return transaction; }, get request() { return request; }, get closed() { return closed; } };
}
for (const operation of ['put', 'delete']) {
  test(`archive ${operation} waits for transaction commit and rejects a late abort after request success`, async () => {
    for (const abort of [true, false]) {
      const db = archiveDatabase(); let finished = false;
      const promise = (operation === 'put' ? putArchiveRecord({ id: 'archive', beforePhotos: [{ dataUrl: 'data:image/png;base64,AA' }] }) : deleteArchiveRecord('archive')).then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      db.request.onsuccess?.(); await Promise.resolve(); assert.equal(finished, false); assert.equal(db.closed, 0);
      if (abort) { db.transaction.error = new Error('transaction aborted'); db.transaction.onabort(); await assert.rejects(promise, /transaction aborted/); }
      else { db.transaction.oncomplete(); await promise; assert.equal(finished, true); }
      assert.equal(db.closed, 1);
    }
  });
}
test('archive deletion resets the matching edit form only after commit and blocks a concurrent save that could restore photos', async () => {
  const db = archiveDatabase(), messages = [], edit = { value: 'archive-a' }; let reset = 0, reload = 0;
  globalThis.window = { confirm: () => true };
  globalThis.document = { querySelector(selector) { assert.equal(selector, '#hiddenWorkId'); return edit; } };
  const owner = Object.assign(Object.create(SubsurfaceTools.prototype), { archiveMutationPending: false, records: [{ id: 'archive-a', name: '档案A' }], resetArchiveForm() { reset++; edit.value = ''; }, async reloadArchives() { reload++; }, notify(message, error) { messages.push({ message, error }); } });
  const button = { dataset: { archiveAction: 'delete' }, closest: () => ({ dataset: { recordId: 'archive-a' } }) };
  const pending = owner.handleArchiveAction({ target: { closest: () => button } });
  await new Promise(resolve => setImmediate(resolve));
  await owner.saveArchive(); assert.match(messages[0].message, /请等待/); assert.equal(reset, 0); assert.equal(reload, 0);
  db.transaction.oncomplete(); await pending;
  assert.equal(reset, 1); assert.equal(reload, 1); assert.equal(owner.archiveMutationPending, false); assert.equal(edit.value, ''); assert.match(messages.at(-1).message, /已删除/);
});
test('archive transaction abort retains the current edit form and reports failure without announcing deletion', async () => {
  const db = archiveDatabase(), messages = []; let touched = false;
  globalThis.window = { confirm: () => true };
  const owner = Object.assign(Object.create(SubsurfaceTools.prototype), { archiveMutationPending: false, records: [{ id: 'archive-a', name: '档案A' }], resetArchiveForm() { touched = true; }, async reloadArchives() { touched = true; }, notify(message, error) { messages.push({ message, error }); } });
  const pending = owner.handleArchiveAction({ target: { closest: () => ({ dataset: { archiveAction: 'delete' }, closest: () => ({ dataset: { recordId: 'archive-a' } }) }) } });
  await new Promise(resolve => setImmediate(resolve)); db.transaction.error = new Error('disk error'); db.transaction.onabort(); await pending;
  assert.equal(touched, false); assert.equal(owner.archiveMutationPending, false); assert.deepEqual(messages, [{ message: 'disk error', error: true }]);
});

function reportFixture() {
  const slides = ['one', 'two'].map(id => ({ id, title: id, annotations: [{ id: `${id}-annotation` }], media: { type: 'image', source: `data:image/png;base64,${id}`, name: id }, elements: [{ id: `${id}-image`, type: 'image', source: `data:image/png;base64,${id}` }, { id: `${id}-video`, type: 'video' }] }));
  const saved = new Map(), messages = [], released = [], rendered = [], cancelled = [], saveLabel = { textContent: '' }; let fail = false;
  globalThis.window = { confirm: () => true, clearTimeout(id) { cancelled.push(id); }, setTimeout: () => 84 };
  globalThis.document = { getElementById: () => saveLabel };
  globalThis.localStorage = { setItem(key, value) { if (fail) throw new Error('quota'); saved.set(key, value); } };
  const owner = Object.assign(Object.create(ThreeDReport.prototype), { document: { version: 2, title: '工程汇报', updatedAt: 'before', slides }, selectedSlideId: 'one', activeStorageKey: 'report-test', persistTimer: 42, presenting: false,
    toast(message, error) { messages.push({ message, error }); }, releaseLocalVideo(id) { released.push(id); }, composer: { releaseTransientMediaForElements(elements) { released.push(...elements.map(x => x.id)); } }, renderAll() { rendered.push('all'); }, renderEditor() { rendered.push('editor'); } });
  return { owner, slides, saved, messages, released, rendered, cancelled, saveLabel, fail(value) { fail = value; } };
}
for (const operation of ['page', 'annotation', 'media']) {
  test(`report ${operation} deletion commits embedded media and data before changing the page and keeps prior draft on failure`, () => {
    const f = reportFixture(), before = structuredClone(f.owner.document);
    const remove = () => operation === 'page' ? f.owner.deleteSelected() : operation === 'annotation' ? f.owner.removeAnnotation('one-annotation') : f.owner.clearMedia();
    f.fail(true); remove();
    assert.deepEqual(f.owner.document, before); assert.equal(f.owner.selectedSlideId, 'one'); assert.equal(f.owner.persistTimer, 42);
    assert.deepEqual(f.cancelled, []); assert.deepEqual(f.released, []); assert.deepEqual(f.rendered, []); assert.equal(f.saved.size, 0);
    assert.equal(f.messages[0].error, true); assert.match(f.saveLabel.textContent, /原数据已保留/);
    f.fail(false); remove();
    const after = f.owner.document;
    assert.deepEqual(JSON.parse(f.saved.get('report-test')), after, 'opening a fresh page cannot restore deleted embedded images or annotations');
    assert.deepEqual(after.slides.find(x => x.id === 'two'), before.slides[1]); assert.equal(f.owner.persistTimer, undefined); assert.deepEqual(f.cancelled, [42]);
    if (operation === 'page') { assert.deepEqual(after.slides.map(x => x.id), ['two']); assert.equal(f.owner.selectedSlideId, 'two'); assert.deepEqual(f.released, ['one', 'one-image', 'one-video']); }
    if (operation === 'annotation') { assert.deepEqual(after.slides[0].annotations, []); assert.deepEqual(after.slides[0].media, before.slides[0].media); assert.deepEqual(f.released, []); }
    if (operation === 'media') { assert.deepEqual(after.slides[0].media, { type: 'none', source: '', name: '' }); assert.deepEqual(f.released, ['one']); }
  });
}
test('report canvas element deletion uses the same durable commit before releasing its video URL or selection', () => {
  const f = reportFixture(), before = structuredClone(f.owner.document), released = []; let refreshed = 0;
  const composer = Object.assign(Object.create(ReportComposer.prototype), { selectedElementId: 'one-image', host: { getSlide: () => f.owner.selectedSlide(), removeElement: id => f.owner.removeOverlayElement(id), changed() { throw new Error('deletion must not use delayed persistence'); } }, releaseTransientVideo(id) { released.push(id); }, refresh() { refreshed++; } });
  f.fail(true); composer.deleteSelected();
  assert.deepEqual(f.owner.document, before); assert.equal(composer.selectedElementId, 'one-image'); assert.deepEqual(released, []); assert.equal(refreshed, 0);
  f.fail(false); composer.deleteSelected();
  assert.deepEqual(f.owner.document.slides[0].elements.map(x => x.id), ['one-video']); assert.equal(composer.selectedElementId, 'one-video'); assert.deepEqual(released, ['one-image']); assert.equal(refreshed, 1);
  assert.deepEqual(JSON.parse(f.saved.get('report-test')), f.owner.document);
});
test('ordinary report edits still use deferred persistence', () => {
  const f = reportFixture(); f.owner.persist();
  assert.equal(f.owner.persistTimer, 84); assert.equal(f.saved.size, 0); assert.equal(f.saveLabel.textContent, '正在保存…');
});
test('sand-table viewpoint deletion retains tour and UI state when storage fails and commits before successful scene changes', () => {
  const viewpoints = [{ id: 'one', name: '第一视点' }, { id: 'two', name: '第二视点' }], saved = new Map(), statuses = [], actions = []; let fail = true;
  globalThis.localStorage = { setItem(key, value) { if (fail) throw new Error('quota'); saved.set(key, value); actions.push('persist'); } };
  const owner = Object.assign(Object.create(ElectronicSandTable.prototype), { disposed: false, viewpoints, storageKey: 'viewpoints', tourIndex: 1,
    setStatus(message) { statuses.push(message); }, logIsolatedError() {}, stopTour() { actions.push('stop'); }, renderViewpoints() { actions.push('render'); }, renderTourState() { actions.push('tour'); }, notifyOverview() { actions.push('notify'); } });
  owner.deleteViewpoint('one'); assert.equal(owner.viewpoints, viewpoints); assert.equal(owner.tourIndex, 1); assert.deepEqual(actions, []); assert.match(statuses.at(-1), /原视点已保留/);
  fail = false; owner.deleteViewpoint('one'); assert.deepEqual(owner.viewpoints, [viewpoints[1]]); assert.equal(owner.tourIndex, 0); assert.equal(actions[0], 'persist'); assert.deepEqual(JSON.parse(saved.get('viewpoints')), owner.viewpoints);
  actions.length = 0; owner.deleteViewpoint('two'); assert.deepEqual(owner.viewpoints, []); assert.deepEqual(actions, ['persist', 'stop', 'render', 'tour', 'notify']); assert.deepEqual(JSON.parse(saved.get('viewpoints')), []);
});
