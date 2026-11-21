import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { ModelProjectionGeometryClient } from './projectionClient.ts';
import type { ContactMeshInput } from './types';

class RealWorker {
  static instances: RealWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string; preventDefault(): void }) => void;
  worker: NodeWorker; terminated = false;
  constructor(readonly url: URL) {
    const source = `import {parentPort} from 'node:worker_threads';
      globalThis.self={postMessage:(message,transfer)=>parentPort.postMessage(message,transfer)};
      await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));`;
    this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    RealWorker.instances.push(this);
  }
  postMessage(message: unknown, transfer: ArrayBuffer[]) { this.worker.postMessage(message, transfer); }
  terminate() { this.terminated = true; void this.worker.terminate(); }
}
const input = (): ContactMeshInput => ({
  worldFromLocal: Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0, 100))),
  primitives: [{ positions: new Float64Array([0, 0, 0, 4, 0, 0, 0, 4, 0]), indices: new Uint32Array([0, 1, 2]), groupId: 'unlabeled-import-node', nodeIndex: 0 }],
});
function setup(t: test.TestContext) {
  const previous = globalThis.Worker; globalThis.Worker = RealWorker as unknown as typeof Worker; RealWorker.instances = [];
  const client = new ModelProjectionGeometryClient();
  t.after(() => { client.dispose(); globalThis.Worker = previous; }); return client;
}
test('actual projection Worker returns source-triangle footprints and releases its resources without detaching source arrays', async t => {
  const client = setup(t), source = input(), progress: string[] = [];
  const result = await client.build(source, undefined, value => progress.push(value));
  assert.equal(result.kind, 'projection'); assert.equal(result.projection.triangleCount, 1);
  assert.equal(result.projection.rawAreaSquareMeters, 8); assert.equal(result.projection.footprints.length, 1);
  assert.match(RealWorker.instances[0].url.pathname, /projection\.worker\.ts$/); assert.equal(RealWorker.instances[0].terminated, true);
  assert.equal(source.primitives[0].positions.byteLength, 72); assert.equal(source.primitives[0].indices.byteLength, 12);
  assert.ok(progress.length > 0);
});
test('cancelling the real projection worker terminates computation and a subsequent job starts cleanly', async t => {
  const client = setup(t), signal = new AbortController(), pending = client.build(input(), signal.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' }); signal.abort(); await rejected;
  assert.equal(RealWorker.instances[0].terminated, true);
  const result = await client.build(input()); assert.equal(result.projection.triangleCount, 1);
  assert.equal(RealWorker.instances.length, 2); assert.equal(RealWorker.instances[1].terminated, true);
});
