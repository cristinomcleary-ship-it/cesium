import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSurfaceEditGeometry, type SurfaceEditGeometryInput } from './surfaceEditGeometry';
import {
  estimateBoundarySampling, refineSurfaceEditBoundary, runSurfaceEditGeometry,
  SURFACE_EDIT_SAMPLING_LIMITS, type SurfaceEditJobProgress,
} from './surfaceEditJobs';
import type { SurfaceEditPoint } from './surfaceEditTypes';

const degreePerMeter = 180 / (Math.PI * 6_378_137);
const point = (x: number, y: number, height = 2): SurfaceEditPoint => ({ longitude: x * degreePerMeter, latitude: y * degreePerMeter, height });
const ring = (size = 10) => [point(0, 0), point(size, 0), point(size, size), point(0, size)];
const geometryInput = (): SurfaceEditGeometryInput => ({ mode: 'excavation', outer: [
  { x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: 5 }, { x: 10, y: 10, z: 5 }, { x: 0, y: 10, z: 5 },
], targetElevation: 0 });
const key = (p: SurfaceEditPoint) => `${p.longitude}/${p.latitude}`;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('sampling estimate includes fresh endpoints and every leaf midpoint before any scene request', () => {
  const estimate = estimateBoundarySampling([ring()]);
  assert.equal(estimate.inputPoints, 4);
  assert.equal(estimate.minimumOutputPoints, 4);
  assert.equal(estimate.minimumSamplePoints, 8);
  assert.ok(estimate.perimeterMeters > 39.99 && estimate.perimeterMeters < 40.01);
  const long = estimateBoundarySampling([ring(75)]);
  assert.equal(long.minimumOutputPoints, 16);
  assert.equal(long.minimumSamplePoints, 32);
});

test('huge edges, excessive rings and raw point totals stop before requesting photography', async () => {
  let requests = 0;
  const sample = async (p: SurfaceEditPoint[]) => { requests++; return p.map(() => 2); };
  await assert.rejects(refineSurfaceEditBoundary([ring(10_000)], sample), /细化层数|预算/);
  await assert.rejects(refineSurfaceEditBoundary([ring(1000), [point(100, 100), point(110, 100), point(110, 110), point(100, 110)]], sample), /预算/);
  await assert.rejects(refineSurfaceEditBoundary(new Array(18), sample), /保留区/);
  const large = new Array(513);
  Object.defineProperty(large, 0, { get() { throw new Error('must not read coordinate'); } });
  assert.throws(() => estimateBoundarySampling([large]), /点数/);
  await assert.rejects(refineSurfaceEditBoundary([large], sample), /点数/);
  assert.equal(requests, 0);
});

test('small planar boundary refreshes original heights without inventing interior samples', async () => {
  const source = [ring().map(p => ({ ...p, height: 99 }))], snapshot = structuredClone(source);
  const requested: SurfaceEditPoint[][] = [], events: SurfaceEditJobProgress[] = [];
  const result = await refineSurfaceEditBoundary(source, async points => {
    requested.push(structuredClone(points)); return points.map(() => 7);
  }, undefined, p => events.push(p));
  assert.equal(requested.length, 2);
  assert.equal(requested.flat().length, 8);
  assert.equal(result[0].length, 4);
  assert.deepEqual(result[0].map(key), source[0].map(key));
  assert.ok(result[0].every(p => p.height === 7));
  assert.deepEqual(source, snapshot);
  assert.equal(events.at(-1)?.sampleCount, 8);
  assert.equal(events.at(-1)?.boundaryPoints, 4);
  assert.ok(requested.flat().every(p => p.longitude === 0 || Math.abs(p.longitude - 10 * degreePerMeter) < 1e-12
    || p.latitude === 0 || Math.abs(p.latitude - 10 * degreePerMeter) < 1e-12), 'only perimeter points are sampled');
});

test('long flat boundaries refine only necessary edges with serial batches of at most 16', async () => {
  let active = 0, maximumActive = 0, sampled = 0, batchMaximum = 0;
  const source = [ring(75)], originals = new Set(source[0].map(key));
  const result = await refineSurfaceEditBoundary(source, async points => {
    active++; maximumActive = Math.max(maximumActive, active); sampled += points.length; batchMaximum = Math.max(batchMaximum, points.length);
    await pause(); active--; return points.map(() => 5);
  });
  assert.equal(maximumActive, 1); assert.ok(batchMaximum <= 16);
  assert.equal(sampled, 32); assert.equal(result[0].length, 16);
  assert.ok(sampled <= SURFACE_EDIT_SAMPLING_LIMITS.samplePoints);
  for (const original of originals) assert.ok(result[0].some(p => key(p) === original));
  for (let i = 0; i < result[0].length; i++) {
    const a = result[0][i], b = result[0][(i + 1) % result[0].length];
    assert.ok(Math.hypot(a.longitude - b.longitude, a.latitude - b.latitude) / degreePerMeter < 20.01);
  }
});

test('measured height curvature adds required midpoints and leaves protected rings separate', async () => {
  const outer = ring(), hole = [point(3, 3), point(6, 3), point(6, 6), point(3, 6)];
  const source = [outer, hole];
  const result = await refineSurfaceEditBoundary(source, async points => points.map(p => {
    const x = p.longitude / degreePerMeter;
    return 10 + Math.sin(x / 10 * Math.PI) * 2;
  }));
  assert.equal(result.length, 2);
  assert.ok(result[0].length > outer.length);
  for (let r = 0; r < source.length; r++) for (const p of source[r]) assert.ok(result[r].some(q => key(q) === key(p)));
  assert.ok(result[0].some(p => Math.abs(p.longitude / degreePerMeter - 5) < 1e-6 && Math.abs(p.height - 12) < 1e-6));
});

test('unmet height tolerance fails at the depth or sample budget instead of returning a coarse boundary', async () => {
  const source = [ring()], originals = new Set(source[0].map(key));
  let sampled = 0;
  const sample = async (points: SurfaceEditPoint[]) => { sampled += points.length; return points.map(p => originals.has(key(p)) ? 1 : 10); };
  await assert.rejects(refineSurfaceEditBoundary(source, sample, undefined, undefined, { maxDepth: 0 }), /最大细化层数/);
  assert.equal(sampled, 8);
  sampled = 0;
  await assert.rejects(refineSurfaceEditBoundary(source, sample, undefined, undefined, { samplePoints: 8 }), /预算/);
  assert.equal(sampled, 8);
});

test('missing or nonfinite original endpoint sampling rejects without a zero-height fallback', async () => {
  for (const values of [[1, 2, 3], [1, NaN, 3, 4], [1, Infinity, 3, 4], [1, 1e100, 3, 4]]) {
    let requests = 0;
    await assert.rejects(refineSurfaceEditBoundary([ring()], async () => { requests++; return values; }), /缺失|无效/);
    assert.equal(requests, 1);
  }
});

test('an already cancelled operation neither loads photography nor emits progress', async () => {
  const control = new AbortController(); control.abort();
  let calls = 0;
  await assert.rejects(refineSurfaceEditBoundary([ring()], async () => { calls++; return []; }, control.signal, () => { calls++; }), { name: 'AbortError' });
  await assert.rejects(runSurfaceEditGeometry(geometryInput(), control.signal, () => { calls++; }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cancellation rejects an in-flight noncooperative sampler and ignores late values', async () => {
  const control = new AbortController(), events: SurfaceEditJobProgress[] = [];
  let receivedSignal: AbortSignal | undefined, finish: ((value: number[]) => void) | undefined, requests = 0;
  const pending = refineSurfaceEditBoundary([ring()], (points, signal) => {
    assert.equal(points.length, 4); requests++; receivedSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  }, control.signal, p => events.push(p));
  await pause(); assert.ok(finish);
  control.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(receivedSignal?.aborted, true);
  finish!([3, 3, 3, 3]);
  await pause(); await pause();
  assert.equal(requests, 1); assert.equal(events.length, 0);
});

test('whole sampling deadline aborts requests and rejects even if a sampler never settles', async () => {
  let receivedSignal: AbortSignal | undefined, calls = 0;
  await assert.rejects(refineSurfaceEditBoundary([ring()], (_points, signal) => {
    calls++; receivedSignal = signal; return new Promise(() => undefined);
  }, undefined, undefined, { timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.equal(calls, 1); assert.equal(receivedSignal?.aborted, true);
});

test('sampling budget options may only tighten the hard ceilings', async () => {
  let calls = 0;
  const sample = async (points: SurfaceEditPoint[]) => { calls++; return points.map(() => 2); };
  for (const limits of [{ samplePoints: 513 }, { batchSize: 17 }, { maxDepth: 7 }, { timeoutMs: 30_001 }, { maxEdgeMeters: 21 }, { maxHeightError: 1 }, { batchSize: 0 }])
    await assert.rejects(refineSurfaceEditBoundary([ring()], sample, undefined, undefined, limits), /预算/);
  assert.equal(calls, 0);
});

type WorkerMock = {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(input: unknown): void;
  terminate(): void;
};
test('geometry Worker receives the bounded input and is terminated exactly once on completion', async context => {
  let terminated = 0, active: WorkerMock | undefined;
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() { active = this; }
    postMessage(value: { input: SurfaceEditGeometryInput }) {
      const result = buildSurfaceEditGeometry(value.input);
      setTimeout(() => this.onmessage?.({ data: { type: 'complete', result } } as MessageEvent), 0);
    }
    terminate() { terminated++; }
  }
  const prior = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
  context.after(() => { Object.defineProperty(globalThis, 'Worker', { value: prior, configurable: true, writable: true }); });
  const events: SurfaceEditJobProgress[] = [], result = await runSurfaceEditGeometry(geometryInput(), undefined, p => events.push(p));
  assert.equal(result.area, 100); assert.equal(terminated, 1);
  assert.equal(active?.onmessage, null); assert.equal(events.at(-1)?.completed, 1);
});

test('geometry cancellation terminates Worker immediately and its captured late handler cannot resolve the job', async context => {
  let terminated = 0, active: WorkerMock | undefined;
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() { active = this; }
    postMessage() {}
    terminate() { terminated++; }
  }
  const prior = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
  context.after(() => { Object.defineProperty(globalThis, 'Worker', { value: prior, configurable: true, writable: true }); });
  const control = new AbortController(), events: SurfaceEditJobProgress[] = [];
  const pending = runSurfaceEditGeometry(geometryInput(), control.signal, p => events.push(p));
  await pause(); const late = active!.onmessage;
  control.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(terminated, 1);
  late?.({ data: { type: 'complete', result: buildSurfaceEditGeometry(geometryInput()) } } as MessageEvent);
  assert.equal(terminated, 1); assert.equal(events.filter(p => p.completed === 1).length, 0);
});

test('geometry Worker deadline terminates a nonresponding task; runtime error does not trigger synchronous fallback', async context => {
  let terminated = 0, fail = false;
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage() { if (fail) setTimeout(() => this.onerror?.({ message: 'worker-test-error' } as ErrorEvent), 0); }
    terminate() { terminated++; }
  }
  const prior = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
  context.after(() => { Object.defineProperty(globalThis, 'Worker', { value: prior, configurable: true, writable: true }); });
  await assert.rejects(runSurfaceEditGeometry(geometryInput(), undefined, undefined, { timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.equal(terminated, 1);
  fail = true;
  await assert.rejects(runSurfaceEditGeometry(geometryInput()), /worker-test-error/);
  assert.equal(terminated, 2);
});

test('without Worker only bounded small geometry runs, after yielding to the next task', async context => {
  const prior = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { value: undefined, configurable: true, writable: true });
  context.after(() => { Object.defineProperty(globalThis, 'Worker', { value: prior, configurable: true, writable: true }); });
  let yielded = false;
  setTimeout(() => { yielded = true; }, 0);
  const result = await runSurfaceEditGeometry(geometryInput());
  assert.equal(result.area, 100); assert.equal(yielded, true);
  const outer = Array.from({ length: 65 }, (_, i) => ({ x: Math.cos(i * Math.PI * 2 / 65) * 20, y: Math.sin(i * Math.PI * 2 / 65) * 20, z: 5 }));
  await assert.rejects(runSurfaceEditGeometry({ ...geometryInput(), outer }), /Worker/);
  await assert.rejects(runSurfaceEditGeometry(geometryInput(), undefined, undefined, { fallbackPointLimit: 65 }), /预算/);
});
