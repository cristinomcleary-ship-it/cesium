import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker as NodeWorker } from 'node:worker_threads';
import { ModelContactGeometryClient } from './client.ts';
import type { ContactGeometry, ContactMeshInput } from './types';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: any }) => void;
  onerror?: (event: { message: string; preventDefault(): void }) => void;
  onmessageerror?: () => void;
  terminated = false; messages: any[] = [];
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: any, transfer: Transferable[]) { this.messages.push(structuredClone(message, { transfer })); }
  terminate() { this.terminated = true; }
  send(data: any) { this.onmessage?.({ data }); }
}
const input = (): ContactMeshInput => ({ worldFromLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1],
  primitives: [{ positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), groupId: 'node:0:instance:0', nodeIndex: 0 }] });
const result = { nodes: new Float32Array([1]), triangles: new Float32Array([2]), entities: new Float32Array([3]), trianglePositions: new Float64Array([4]) } as ContactGeometry;
function setup(t: test.TestContext, options?: { timeoutMs: number }) {
  FakeWorker.instances = [];
  const previous = globalThis.Worker; globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const client = new ModelContactGeometryClient(options);
  t.after(() => { client.dispose(); globalThis.Worker = previous; }); return client;
}

test('transfers owned snapshots and preserves original buffers while releasing successful Workers', async t => {
  const client = setup(t), source = input(), progress: string[] = [];
  const pending = client.build(source, undefined, message => progress.push(message));
  const worker = FakeWorker.instances[0], request = worker.messages[0];
  source.primitives[0].positions[0] = 99; (source.worldFromLocal as number[])[12] = 999;
  assert.equal(request.input.primitives[0].positions[0], 0); assert.equal(request.input.worldFromLocal[12], 100);
  assert.equal(source.primitives[0].positions.byteLength, 72); assert.equal(source.primitives[0].indices.byteLength, 12);
  worker.send({ kind: 'progress', id: request.id, message: 'topology' });
  worker.send({ kind: 'result', id: request.id, result });
  assert.equal(await pending, result); assert.deepEqual(progress, ['topology']); assert.equal(worker.terminated, true);
});

test('cancellation and replacement terminate computation and reject late results', async t => {
  const client = setup(t), abort = new AbortController();
  const first = client.build(input(), abort.signal), rejected = assert.rejects(first, { name: 'AbortError' });
  const old = FakeWorker.instances[0]; abort.abort(); await rejected; assert.equal(old.terminated, true);
  const second = client.build(input()), secondRejected = assert.rejects(second, { name: 'AbortError' });
  const superseded = FakeWorker.instances[1]; const third = client.build(input()); await secondRejected;
  const worker = FakeWorker.instances[2], id = worker.messages[0].id;
  old.send({ kind: 'result', id, result: 'stale' }); superseded.send({ kind: 'result', id, result: 'stale' });
  worker.send({ kind: 'result', id: id - 1, result: 'stale' });
  worker.send({ kind: 'result', id, result }); assert.equal(await third, result);
  assert.equal(superseded.terminated, true);
});

test('errors and disposal clean pending Workers; no unavailable-worker main-thread fallback', async t => {
  const client = setup(t); let pending = client.build(input()), worker = FakeWorker.instances[0];
  worker.send({ kind: 'error', id: worker.messages[0].id, message: 'topology budget' });
  await assert.rejects(pending, /topology budget/); assert.equal(worker.terminated, true);
  pending = client.build(input()); worker = FakeWorker.instances[1]; worker.onmessageerror?.();
  await assert.rejects(pending, /解码失败/); assert.equal(worker.terminated, true);
  pending = client.build(input()); worker = FakeWorker.instances[2]; worker.onerror?.({ message: 'CSP', preventDefault() {} });
  await assert.rejects(pending, /CSP/);
  globalThis.Worker = undefined as unknown as typeof Worker; await assert.rejects(client.build(input()), /不支持.*Worker/);
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  pending = client.build(input()); const disposed = assert.rejects(pending, { name: 'AbortError' }); client.dispose(); await disposed;
  await assert.rejects(client.build(input()), /已释放/);
});

test('startup, clone, progress-handler and timeout failures release the active request', async t => {
  const client = setup(t, { timeoutMs: 10 });
  globalThis.Worker = class { constructor() { throw new Error('startup'); } } as unknown as typeof Worker;
  await assert.rejects(client.build(input()), /startup/); globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const invalid = input(); invalid.primitives[0].indices = [0, 1, 2] as unknown as Uint32Array;
  await assert.rejects(client.build(invalid), /类型无效/);
  let pending = client.build(input(), undefined, () => { throw new Error('progress'); });
  let worker = FakeWorker.instances.at(-1)!; worker.send({ kind: 'progress', id: worker.messages[0].id, message: 'x' });
  await assert.rejects(pending, /progress/); assert.equal(worker.terminated, true);
  pending = client.build(input()); worker = FakeWorker.instances.at(-1)!;
  await assert.rejects(pending, /时间预算/); assert.equal(worker.terminated, true);
  const controller = new AbortController(); controller.abort(); await assert.rejects(client.build(input(), controller.signal), { name: 'AbortError' });
});

test('actual module Worker builds topology and transfers its result without detaching caller geometry', async t => {
  const client = setup(t);
  class RealWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string; preventDefault(): void }) => void;
    onmessageerror?: () => void;
    worker: NodeWorker;
    constructor(url: URL) {
      const source = `import {parentPort} from 'node:worker_threads';
        globalThis.self={postMessage:(message,transfer)=>parentPort.postMessage(message,transfer)};
        await import(${JSON.stringify(url.href)});
        parentPort.on('message',data=>self.onmessage({data}));`;
      this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
      this.worker.on('message', data => this.onmessage?.({ data }));
      this.worker.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
      this.worker.on('messageerror', () => this.onmessageerror?.());
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.worker.postMessage(message, transfer); }
    terminate() { void this.worker.terminate(); }
  }
  globalThis.Worker = RealWorker as unknown as typeof Worker;
  const source = input();
  source.primitives[0].positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  source.primitives[0].indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const built = await client.build(source);
  assert.equal(built.stats.sourceTriangles, 4); assert.equal(built.stats.solidEntities, 1);
  assert.ok(built.nodes.length > 0); assert.ok(built.trianglePositions instanceof Float64Array);
  assert.equal(source.primitives[0].positions.byteLength, 96); assert.equal(source.primitives[0].indices.byteLength, 48);
});
