import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineeringFootprintClient } from './footprintClient.ts';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: any }) => void;
  onerror?: (event: { message: string; preventDefault(): void }) => void;
  terminated = false; messages: any[] = [];
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: any) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  send(data: any) { this.onmessage?.({ data }); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const setup = (t: test.TestContext) => {
  FakeWorker.instances = []; t.mock.method(globalThis, 'setTimeout', globalThis.setTimeout);
  const previous = globalThis.Worker; globalThis.Worker = FakeWorker as unknown as typeof Worker;
  t.after(() => { globalThis.Worker = previous; });
  return new EngineeringFootprintClient(new ArrayBuffer(32), [{ componentId: 'part', nodeIndices: [0] }]);
};
const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 6378237, 0, 0, 1];

test('abort terminates the actual worker before init and a later request receives a fresh worker', async t => {
  const client = setup(t), abort = new AbortController();
  const first = client.project(world, ['part'], abort.signal); const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush(); const old = FakeWorker.instances[0]; abort.abort(); await rejected; assert.equal(old.terminated, true);
  const second = client.project(world, ['part']); await flush(); const worker = FakeWorker.instances[1];
  worker.send({ kind: 'ready' }); await flush(); const request = worker.messages.find(m => m.kind === 'project');
  old.send({ kind: 'result', id: request.id, result: 'stale' });
  worker.send({ kind: 'result', id: request.id, result: { componentCount: 1 } });
  assert.deepEqual(await second, { componentCount: 1 }); client.dispose(); assert.equal(worker.terminated, true);
});

test('replacement terminates computation and does not accept stale results or mutated request inputs', async t => {
  const client = setup(t), input = [...world], ids = ['part'];
  const first = client.project(input, ids), rejected = assert.rejects(first, { name: 'AbortError' });
  await flush(); const old = FakeWorker.instances[0]; old.send({ kind: 'ready' }); await flush();
  const second = client.project(input, ids); input[12] = 0; ids[0] = 'changed'; await rejected; await flush();
  assert.equal(old.terminated, true); const worker = FakeWorker.instances[1]; worker.send({ kind: 'ready' }); await flush();
  const request = worker.messages.find(m => m.kind === 'project'); assert.equal(request.world[12], world[12]); assert.deepEqual(request.componentIds, ['part']);
  worker.send({ kind: 'result', id: request.id, result: { componentCount: 1 } }); await second; client.dispose();
});

test('worker startup exceptions and geometry errors clean pending tasks; unsupported environments never fall back', async t => {
  const client = setup(t);
  globalThis.Worker = class { constructor() { throw new Error('CSP denied'); } } as unknown as typeof Worker;
  await assert.rejects(client.project(world, ['part']), /CSP denied/);
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const pending = client.project(world, ['part']); await flush(); const worker = FakeWorker.instances[0];
  worker.send({ kind: 'error', message: 'source mismatch' }); await assert.rejects(pending, /source mismatch/); assert.equal(worker.terminated, true);
  globalThis.Worker = undefined as unknown as typeof Worker;
  await assert.rejects(client.project(world, ['part']), /不支持.*Worker/); client.dispose();
  await assert.rejects(client.project(world, ['part']), /已释放/);
});
