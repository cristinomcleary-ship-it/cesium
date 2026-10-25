import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CAD_IMPORT_WORKER_MIN_BYTES, createCadImportFromDwgInWorker, readCadImportInWorker, type CadWorkerMessage, type CadWorkerRequest } from './cadImportWorkerClient.ts';
import { parseCadImportText, readCadImport, type CadImportPackage } from './cadImport.ts';

const drawing = (version: 1 | 2 = 2): CadImportPackage => ({ format: 'cesium-cad-import', version,
  source: { name: 'synthetic.dwg', format: 'DWG', generatedAt: '' },
  statistics: { sourceEntities: 1, displayEntities: 1, skippedEntities: 0, unknownEntities: 0, layers: ['test'] },
  entities: [{ type: 'POLYLINE', sourceType: 'LINE', layer: 'test', vertices: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }], warnings: [] });
const fileFor = (value = drawing(), large = false) => new File([JSON.stringify(value), large ? ' '.repeat(CAD_IMPORT_WORKER_MIN_BYTES) : ''], 'synthetic.cadimport');

type FakeWorker = {
  onmessage: ((event: { data: CadWorkerMessage }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(request: CadWorkerRequest): void;
  terminate(): void;
};
function workerFixture(t: TestContext, failure?: 'construct' | 'post') {
  let created = 0, terminated = 0;
  const sent: CadWorkerRequest[] = [];
  const worker: FakeWorker = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage(request) { if (failure === 'post') throw new Error('clone failed'); sent.push(request); },
    terminate() { terminated++; } };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true,
    value: class { constructor() { created++; if (failure === 'construct') throw new Error('worker unavailable'); return worker; } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); else Reflect.deleteProperty(globalThis, 'Worker'); });
  return { worker, sent, get created() { return created; }, get terminated() { return terminated; } };
}

test('large saved CAD is sent as a File without reading or copying bytes on the main thread', async t => {
  const f = workerFixture(t), file = fileFor(drawing(), true), progress: string[] = [];
  let reads = 0;
  Object.defineProperty(file, 'text', { value: () => { reads++; throw new Error('main-thread read'); } });
  Object.defineProperty(file, 'arrayBuffer', { value: () => { reads++; throw new Error('main-thread buffer'); } });
  const promise = readCadImportInWorker(file, message => progress.push(message));
  assert.equal(f.created, 1); assert.equal(f.sent[0].type, 'read'); assert.equal(f.sent[0].file, file);
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['file', 'type']);
  f.worker.onmessage!({ data: { type: 'progress', message: 'parsing' } });
  f.worker.onmessage!({ data: { type: 'result', operation: 'read', value: drawing() } });
  assert.deepEqual(await promise, drawing()); assert.deepEqual(progress, ['parsing']); assert.equal(reads, 0);
  assert.equal(f.terminated, 1); assert.equal(f.worker.onmessage, null);
});

test('small version 1 and 2 files use the original reader without worker startup', async t => {
  const f = workerFixture(t);
  for (const version of [1, 2] as const) assert.deepEqual(await readCadImportInWorker(fileFor(drawing(version))), drawing(version));
  assert.equal(f.created, 0);
});

test('CPU environments without Worker retain complete large-file format reading', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Reflect.deleteProperty(globalThis, 'Worker');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); });
  assert.deepEqual(await readCadImportInWorker(fileFor(drawing(), true)), drawing());
});

test('aborting before dispatch starts neither a worker nor file reading', async t => {
  const f = workerFixture(t), controller = new AbortController(); controller.abort();
  const file = fileFor(drawing(), true);
  Object.defineProperty(file, 'text', { value: () => { throw new Error('must not read'); } });
  await assert.rejects(readCadImportInWorker(file, undefined, controller.signal), { name: 'AbortError' });
  await assert.rejects(createCadImportFromDwgInWorker(file, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(f.created, 0);
});

test('cancelling from progress rejects immediately and terminates the in-flight parser', async t => {
  const f = workerFixture(t), controller = new AbortController();
  const promise = readCadImportInWorker(fileFor(drawing(), true), () => controller.abort(), controller.signal);
  const rejected = assert.rejects(promise, { name: 'AbortError' });
  f.worker.onmessage!({ data: { type: 'progress', message: 'parsing' } });
  await rejected;
  assert.equal(f.terminated, 1); assert.equal(f.worker.onmessage, null); assert.equal(f.worker.onerror, null); assert.equal(f.worker.onmessageerror, null);
});

for (const event of ['error', 'messageerror', 'parser'] as const) test(`${event} failure rejects and releases the worker`, async t => {
  const f = workerFixture(t), promise = readCadImportInWorker(fileFor(drawing(), true));
  const rejected = assert.rejects(promise, /failure|无法读取|格式/);
  if (event === 'error') f.worker.onerror!({ message: 'worker failure' });
  else if (event === 'messageerror') f.worker.onmessageerror!();
  else f.worker.onmessage!({ data: { type: 'error', message: '不支持的 .cadimport 格式或版本', stack: 'parser stack' } });
  await rejected; assert.equal(f.terminated, 1);
});

for (const failure of ['construct', 'post'] as const) test(`${failure} failure does not retry expensive parsing on the UI thread`, async t => {
  const f = workerFixture(t, failure), file = fileFor(drawing(), true);
  let reads = 0; Object.defineProperty(file, 'text', { value: () => { reads++; return Promise.resolve(JSON.stringify(drawing())); } });
  await assert.rejects(readCadImportInWorker(file), /worker unavailable|clone failed/);
  assert.equal(reads, 0); assert.equal(f.terminated, failure === 'post' ? 1 : 0);
});

test('a failing progress observer and a mismatched result cannot strand the parser', async t => {
  const f = workerFixture(t), first = readCadImportInWorker(fileFor(drawing(), true), () => { throw new Error('observer failed'); });
  const rejected = assert.rejects(first, /observer failed/);
  f.worker.onmessage!({ data: { type: 'progress', message: 'parsing' } }); await rejected;
  assert.equal(f.terminated, 1);
  const second = readCadImportInWorker(fileFor(drawing(), true)), wrong = assert.rejects(second, /不完整/);
  f.worker.onmessage!({ data: { type: 'result', operation: 'dwg', value: drawing(), cadImportData: new ArrayBuffer(0) } });
  await wrong; assert.equal(f.terminated, 2);
});

test('DWG retains the parsed drawing and generated download file while terminating its WASM worker', async t => {
  const f = workerFixture(t), file = new File(['dwg'], 'synthetic.dwg');
  const promise = createCadImportFromDwgInWorker(file);
  assert.equal(f.sent[0].type, 'dwg'); assert.equal(f.sent[0].file, file);
  const serialized = JSON.stringify(drawing()), cadImportData = new TextEncoder().encode(serialized).buffer;
  f.worker.onmessage!({ data: { type: 'result', operation: 'dwg', value: drawing(), cadImportData } });
  const result = await promise;
  assert.deepEqual(result.value, drawing()); assert.equal(await result.blob.text(), serialized);
  assert.equal(result.blob.type, 'application/vnd.cesium.cadimport+json'); assert.equal(f.terminated, 1);
});

test('fallback cancellation settles before slow file I/O and prevents its later parsing', async t => {
  const f = workerFixture(t), controller = new AbortController();
  let release!: (value: string) => void;
  const file = new File([], 'slow.cadimport');
  Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { release = resolve; }) });
  const promise = readCadImportInWorker(file, undefined, controller.signal);
  const rejected = assert.rejects(promise, { name: 'AbortError' }); controller.abort(); await rejected;
  release('not valid JSON'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.created, 0);
  await assert.rejects(readCadImport(fileFor(), controller.signal), { name: 'AbortError' });
});

test('worker and fallback share the existing CAD format and geometry checks', () => {
  for (const version of [1, 2] as const) assert.deepEqual(parseCadImportText(JSON.stringify(drawing(version))), drawing(version));
  assert.throws(() => parseCadImportText('not JSON'), /不是有效/);
  for (const value of [null, {}, { ...drawing(), version: 3 }]) assert.throws(() => parseCadImportText(JSON.stringify(value)), /格式或版本/);
  assert.throws(() => parseCadImportText(JSON.stringify({ ...drawing(), entities: [{ type: 'POLYLINE' }] })), /几何数据不完整/);
});
