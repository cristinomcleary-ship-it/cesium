import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailSafetyFallProjectionClient } from './railSafetyFallProjectionClient.ts';
import type { PreparedRailSafetyFallProjection } from './railSafetyFallProjection';

const prepared = {} as PreparedRailSafetyFallProjection;
function fixture(throwType?: 'prepare' | 'project') {
  const sent: { type: string; id: number }[] = [];
  const worker = { onmessage: undefined as undefined | ((event: { data: unknown }) => void), onerror: undefined,
    onmessageerror: undefined, terminated: false,
    postMessage(message: { type: string; id: number }) { if (message.type === throwType) throw new Error('clone failed'); sent.push(message); },
    terminate() { worker.terminated = true; } };
  return { worker, sent, createWorker: () => worker as unknown as Worker };
}

test('projection worker receives the mesh once, matches replies and rejects pending work on disposal', async () => {
  const f = fixture(), client = createRailSafetyFallProjectionClient(prepared, { createWorker: f.createWorker });
  const result = { angle: 25, direction: 90 };
  const first = client.compute(90, 25);
  f.worker.onmessage!({ data: { id: 999, result: {} } });
  f.worker.onmessage!({ data: { id: f.sent[1].id, result } });
  assert.deepEqual(await first, result); assert.equal(f.sent.filter(message => message.type === 'prepare').length, 1);
  const second = client.compute(180, 40), rejected = assert.rejects(second, /已停止/);
  client.dispose(); await rejected; assert.equal(f.worker.terminated, true);
  await assert.rejects(client.compute(0, 0), /已停止/);
});

test('a stalled worker has a finite deadline and is terminated', async () => {
  const f = fixture(), client = createRailSafetyFallProjectionClient(prepared, { createWorker: f.createWorker, timeoutMs: 10 });
  await assert.rejects(client.compute(0, 20), /超时/); assert.equal(f.worker.terminated, true);
  await assert.rejects(client.compute(0, 0), /已停止/); client.dispose();
});

test('prepare and project message failures release the worker instead of leaving a pending calculation', async () => {
  const prepareFailure = fixture('prepare');
  assert.throws(() => createRailSafetyFallProjectionClient(prepared, { createWorker: prepareFailure.createWorker }), /clone failed/);
  assert.equal(prepareFailure.worker.terminated, true);
  const projectFailure = fixture('project'), client = createRailSafetyFallProjectionClient(prepared, { createWorker: projectFailure.createWorker });
  await assert.rejects(client.compute(0, 0), /无法发送/); assert.equal(projectFailure.worker.terminated, true); client.dispose();
});
