import {
  buildSurfaceEditGeometry, estimateSurfaceEditGeometry,
  type SurfaceEditGeometryInput, type SurfaceEditGeometryResult,
} from './surfaceEditGeometry';
import { SURFACE_EDIT_LIMITS, type SurfaceEditPoint } from './surfaceEditTypes';
import type { SurfaceEditWorkerResponse } from './surfaceEdit.worker';

export type SurfaceEditJobProgress = {
  stage: 'sampling' | 'geometry';
  completed: number;
  total: number;
  message: string;
  sampleCount?: number;
  boundaryPoints?: number;
};
export type SurfaceEditProgressListener = (progress: SurfaceEditJobProgress) => void;
export type SurfaceEditSamplingLimits = {
  outputPoints: number;
  samplePoints: number;
  batchSize: number;
  maxDepth: number;
  maxEdgeMeters: number;
  maxHeightError: number;
  timeoutMs: number;
};
export const SURFACE_EDIT_SAMPLING_LIMITS: Readonly<SurfaceEditSamplingLimits> = Object.freeze({
  outputPoints: SURFACE_EDIT_LIMITS.boundaryPoints,
  samplePoints: 512,
  batchSize: 16,
  maxDepth: 6,
  maxEdgeMeters: 20,
  maxHeightError: 0.25,
  timeoutMs: SURFACE_EDIT_LIMITS.taskTimeoutMs,
});
export type SurfaceEditSamplingEstimate = {
  inputPoints: number;
  minimumOutputPoints: number;
  minimumSamplePoints: number;
  perimeterMeters: number;
};
export type SurfaceEditGeometryJobOptions = { timeoutMs?: number; fallbackPointLimit?: number };

const RADIUS = 6_378_137;
const rad = (degrees: number) => degrees * Math.PI / 180;
const degree = (radians: number) => radians * 180 / Math.PI;

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('地表生成已取消。', 'AbortError');
}
function cancellation() { return new DOMException('地表生成已取消。', 'AbortError'); }
function timeoutError() { const error = new Error('地表生成超时，原场景保持不变；请缩小范围或分区处理。'); error.name = 'TimeoutError'; return error; }
function progress(listener: SurfaceEditProgressListener | undefined, value: SurfaceEditJobProgress) {
  try { listener?.(value); } catch { /* A progress observer cannot break or restart geometry work. */ }
}
function nextTask(signal: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason ?? cancellation()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 0);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Deadline rejects even if an in-flight sampler never settles. The local
 * signal is also aborted so cooperative requests/Workers stop doing work. */
function withDeadline<T>(parent: AbortSignal | undefined, timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent?.aborted) return Promise.reject(parent.reason ?? cancellation());
  const controller = new AbortController();
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const stop = (reason: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectDeadline(reason);
  };
  const onAbort = () => stop(parent?.reason ?? cancellation());
  const timer = setTimeout(() => stop(timeoutError()), timeoutMs);
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) onAbort();
  return Promise.race([Promise.resolve().then(() => { aborted(controller.signal); return work(controller.signal); }), deadline])
    .finally(() => { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); });
}

function stricterNumber(value: number | undefined, ceiling: number, label: string, integer = false, zero = false) {
  const result = value ?? ceiling;
  if (!Number.isFinite(result) || result < (zero ? 0 : Number.MIN_VALUE) || result > ceiling || (integer && !Number.isSafeInteger(result)))
    throw new Error(`${label}无效或超过硬上限。`);
  return result;
}

export async function runSurfaceEditGeometry(input: SurfaceEditGeometryInput, signal?: AbortSignal,
  onProgress?: SurfaceEditProgressListener, options: SurfaceEditGeometryJobOptions = {}): Promise<SurfaceEditGeometryResult> {
  if (signal?.aborted) throw signal.reason ?? cancellation();
  const estimate = estimateSurfaceEditGeometry(input);
  const timeoutMs = stricterNumber(options.timeoutMs, SURFACE_EDIT_LIMITS.workerTimeoutMs, '地表建网超时预算');
  const fallbackPointLimit = stricterNumber(options.fallbackPointLimit, 64, '无 Worker 回退点数预算', true, true);
  return withDeadline(signal, timeoutMs, async localSignal => {
    const started = performance.now();
    aborted(localSignal);
    progress(onProgress, { stage: 'geometry', completed: 0, total: 1, message: '正在生成坑底与土体接边…', boundaryPoints: estimate.boundaryPoints });
    let worker: Worker | undefined;
    try {
      if (typeof Worker !== 'undefined') worker = new Worker(new URL('./surfaceEdit.worker.ts', import.meta.url), { type: 'module', name: 'surface-edit' });
    } catch { /* Only bounded small jobs may fall back when Worker creation is unavailable. */ }
    let result: SurfaceEditGeometryResult;
    if (!worker) {
      if (estimate.boundaryPoints > fallbackPointLimit) throw new Error('当前浏览器无法启动后台建网；请缩小到 64 点以内或使用支持 Worker 的浏览器。');
      await nextTask(localSignal);
      aborted(localSignal);
      result = buildSurfaceEditGeometry(input);
      aborted(localSignal);
      if (performance.now() - started > timeoutMs) throw timeoutError();
    } else {
      const active = worker;
      result = await new Promise<SurfaceEditGeometryResult>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown, value?: SurfaceEditGeometryResult) => {
          if (settled) return;
          settled = true;
          localSignal.removeEventListener('abort', onAbort);
          active.onmessage = null; active.onerror = null; active.onmessageerror = null;
          active.terminate();
          if (error !== undefined) reject(error); else resolve(value!);
        };
        const onAbort = () => finish(localSignal.reason ?? cancellation());
        localSignal.addEventListener('abort', onAbort, { once: true });
        active.onmessage = (event: MessageEvent<SurfaceEditWorkerResponse>) => {
          if (settled) return;
          if (localSignal.aborted) return onAbort();
          const value = event.data;
          if (value?.type === 'error') finish(new Error(value.message));
          else if (value?.type === 'complete' && value.result?.surface?.positions instanceof Float64Array
            && value.result?.walls?.positions instanceof Float64Array) finish(undefined, value.result);
          else finish(new Error('后台地表建网返回了无效结果。'));
        };
        active.onerror = (event: ErrorEvent) => finish(new Error(event.message || '后台地表建网失败。'));
        active.onmessageerror = () => finish(new Error('后台地表网格传输失败。'));
        if (localSignal.aborted) onAbort();
        else {
          try { active.postMessage({ input }); } catch (error) { finish(error); }
        }
      });
    }
    aborted(localSignal);
    progress(onProgress, { stage: 'geometry', completed: 1, total: 1, message: '地表网格已生成。', boundaryPoints: result.boundaryPoints });
    return result;
  });
}

function samplingLimits(overrides: Partial<SurfaceEditSamplingLimits>): SurfaceEditSamplingLimits {
  const result = { ...SURFACE_EDIT_SAMPLING_LIMITS };
  for (const key of Object.keys(overrides) as (keyof SurfaceEditSamplingLimits)[]) {
    if (!(key in SURFACE_EDIT_SAMPLING_LIMITS)) throw new Error('边界采样预算包含未知项目。');
    const integer = key === 'outputPoints' || key === 'samplePoints' || key === 'batchSize' || key === 'maxDepth';
    result[key] = stricterNumber(overrides[key], SURFACE_EDIT_SAMPLING_LIMITS[key], `边界采样预算 ${key}`, integer, key === 'maxDepth');
  }
  return result;
}
function rawPointCount(rings: readonly (readonly SurfaceEditPoint[])[], limits: SurfaceEditSamplingLimits) {
  if (!Array.isArray(rings) || !rings.length) throw new Error('缺少地表边界。');
  if (rings.length > SURFACE_EDIT_LIMITS.holes + 1) throw new Error('地表保留区数量超过上限。');
  let count = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) throw new Error('每个地表边界至少需要三个点。');
    count += ring.length;
    if (count > limits.outputPoints || count > limits.samplePoints) throw new Error('边界输入点数超过采样预算，请分区处理。');
  }
}
function samePosition(a: SurfaceEditPoint, b: SurfaceEditPoint) { return a.longitude === b.longitude && a.latitude === b.latitude; }
function prepareRings(rings: readonly (readonly SurfaceEditPoint[])[], limits: SurfaceEditSamplingLimits) {
  rawPointCount(rings, limits);
  return rings.map(ring => {
    const copy = ring.map(p => {
      if (!p || ![p.longitude, p.latitude, p.height].every(Number.isFinite)
        || Math.abs(p.longitude) > 180 || Math.abs(p.latitude) >= 89)
        throw new Error('边界经纬度或高程无效，不能进行采样。');
      return { ...p };
    });
    if (copy.length > 1 && samePosition(copy[0], copy.at(-1)!)) copy.pop();
    if (copy.length < 3) throw new Error('每个地表边界至少需要三个不同点。');
    const keys = new Set<string>();
    for (let i = 0; i < copy.length; i++) {
      const p = copy[i], key = `${p.longitude}/${p.latitude}`;
      if (keys.has(key)) throw new Error('地表边界包含重复点。');
      keys.add(key);
      if (geographicDistance(p, copy[(i + 1) % copy.length]) < 0.001) throw new Error('地表边界存在过短边，请核对取点。');
    }
    return copy;
  });
}
/** Two-dimensional great-circle length; height never increases sampling density. */
function geographicDistance(a: SurfaceEditPoint, b: SurfaceEditPoint) {
  const latA = rad(a.latitude), latB = rad(b.latitude), dlat = latB - latA, dlon = rad(b.longitude - a.longitude);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dlon / 2) ** 2;
  return 2 * RADIUS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
/** Unit-vector midpoint follows the shortest geographic edge, including ±180°. */
function midpoint(a: SurfaceEditPoint, b: SurfaceEditPoint): SurfaceEditPoint {
  const lonA = rad(a.longitude), latA = rad(a.latitude), lonB = rad(b.longitude), latB = rad(b.latitude);
  const x = Math.cos(latA) * Math.cos(lonA) + Math.cos(latB) * Math.cos(lonB);
  const y = Math.cos(latA) * Math.sin(lonA) + Math.cos(latB) * Math.sin(lonB);
  const z = Math.sin(latA) + Math.sin(latB);
  if (Math.hypot(x, y, z) < 1e-12) throw new Error('地表边界跨度无效，请分区处理。');
  return { longitude: degree(Math.atan2(y, x)), latitude: degree(Math.atan2(z, Math.hypot(x, y))), height: (a.height + b.height) / 2 };
}
function estimatePrepared(rings: readonly (readonly SurfaceEditPoint[])[], limits: SurfaceEditSamplingLimits): SurfaceEditSamplingEstimate {
  let inputPoints = 0, minimumOutputPoints = 0, perimeterMeters = 0;
  for (const ring of rings) {
    inputPoints += ring.length;
    for (let i = 0; i < ring.length; i++) {
      const distance = geographicDistance(ring[i], ring[(i + 1) % ring.length]);
      perimeterMeters += distance;
      const depth = Math.max(0, Math.ceil(Math.log2(distance / limits.maxEdgeMeters)));
      if (depth > limits.maxDepth) throw new Error('边界过长，所需细化层数超过上限；请缩小范围或分区处理。');
      minimumOutputPoints += 2 ** depth;
      // Endpoints plus every internal and leaf midpoint of each binary edge tree.
      if (minimumOutputPoints > limits.outputPoints || minimumOutputPoints * 2 > limits.samplePoints)
        throw new Error('预计边界采样点数超过总预算，请缩小范围或分区处理。');
    }
  }
  return { inputPoints, minimumOutputPoints, minimumSamplePoints: minimumOutputPoints * 2, perimeterMeters };
}

/** Can run before entering any Cesium sampling context or loading photography.
 * This is a minimum: real height variation may require further bounded refinement. */
export function estimateBoundarySampling(rings: readonly (readonly SurfaceEditPoint[])[],
  overrides: Partial<SurfaceEditSamplingLimits> = {}): SurfaceEditSamplingEstimate {
  const limits = samplingLimits(overrides);
  return estimatePrepared(prepareRings(rings, limits), limits);
}

type EdgeNode = { a: SurfaceEditPoint; b: SurfaceEditPoint; depth: number; left?: EdgeNode; right?: EdgeNode };

export async function refineSurfaceEditBoundary(
  inputRings: readonly (readonly SurfaceEditPoint[])[],
  sample: (points: SurfaceEditPoint[], signal: AbortSignal) => Promise<number[]>,
  signal?: AbortSignal,
  onProgress?: SurfaceEditProgressListener,
  overrides: Partial<SurfaceEditSamplingLimits> = {},
): Promise<SurfaceEditPoint[][]> {
  if (signal?.aborted) throw signal.reason ?? cancellation();
  const limits = samplingLimits(overrides), rings = prepareRings(inputRings, limits);
  const estimate = estimatePrepared(rings, limits);
  if (typeof sample !== 'function') throw new Error('缺少摄影高程采样器。');
  return withDeadline(signal, limits.timeoutMs, async localSignal => {
    let sampleCount = 0, outputCount = estimate.inputPoints;
    async function fetchHeights(points: SurfaceEditPoint[]) {
      aborted(localSignal);
      if (points.length > limits.batchSize || sampleCount + points.length > limits.samplePoints)
        throw new Error('边界高程采样达到总预算，无法满足当前精度；请缩小范围或分区处理。');
      sampleCount += points.length;
      const values = await sample(points.map(p => ({ ...p })), localSignal);
      aborted(localSignal);
      if (!Array.isArray(values) || values.length !== points.length || values.some(h => !Number.isFinite(h) || Math.abs(h) > 100_000))
        throw new Error('摄影边界高程采样缺失或无效，原场景保持不变。');
      points.forEach((point, index) => { point.height = values[index]; });
      progress(onProgress, { stage: 'sampling', completed: sampleCount, total: limits.samplePoints,
        sampleCount, boundaryPoints: outputCount, message: `已采样 ${sampleCount} 点，边界 ${outputCount} 点（总预算 ${limits.samplePoints} 点）` });
      await nextTask(localSignal);
    }
    // Refresh every original endpoint; rectangular tools may have synthesised
    // corners, and old pick heights are not assumed to still match photography.
    const originals = rings.flat();
    for (let i = 0; i < originals.length; i += limits.batchSize) await fetchHeights(originals.slice(i, i + limits.batchSize));
    const roots = rings.map(ring => ring.map((a, i): EdgeNode => ({ a, b: ring[(i + 1) % ring.length], depth: 0 })));
    let frontier = roots.flat();
    while (frontier.length) {
      aborted(localSignal);
      // Even the current frontier must all be checked. Fail before scheduling a
      // partial layer that is already known to exceed the remaining budget.
      if (sampleCount + frontier.length > limits.samplePoints) throw new Error('边界细化所需采样超过总预算，无法保证接边精度；请分区处理。');
      const next: EdgeNode[] = [];
      for (let start = 0; start < frontier.length; start += limits.batchSize) {
        const edges = frontier.slice(start, start + limits.batchSize), midpoints = edges.map(edge => midpoint(edge.a, edge.b));
        await fetchHeights(midpoints);
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i], middle = midpoints[i];
          const distance = geographicDistance(edge.a, edge.b), error = Math.abs(middle.height - (edge.a.height + edge.b.height) / 2);
          if (distance <= limits.maxEdgeMeters && error <= limits.maxHeightError) continue;
          if (edge.depth >= limits.maxDepth) throw new Error('边界已达最大细化层数，仍不能满足接边精度；请分区或使用已确认地面标高。');
          if (outputCount + 1 > limits.outputPoints) throw new Error('细化后边界点数超过上限，无法保证接边精度；请分区处理。');
          outputCount++;
          edge.left = { a: edge.a, b: middle, depth: edge.depth + 1 };
          edge.right = { a: middle, b: edge.b, depth: edge.depth + 1 };
          next.push(edge.left, edge.right);
          if (sampleCount + (frontier.length - start - edges.length) + next.length > limits.samplePoints)
            throw new Error('边界精度要求超过剩余采样预算，请缩小范围或分区处理。');
        }
      }
      frontier = next;
    }
    aborted(localSignal);
    const output = roots.map(ring => {
      const points: SurfaceEditPoint[] = [];
      const collect = (edge: EdgeNode) => {
        if (edge.left && edge.right) { collect(edge.left); collect(edge.right); }
        else points.push({ ...edge.a });
      };
      ring.forEach(collect);
      return points;
    });
    if (output.reduce((sum, ring) => sum + ring.length, 0) !== outputCount) throw new Error('边界细化计数不一致，未提交结果。');
    progress(onProgress, { stage: 'sampling', completed: sampleCount, total: sampleCount, sampleCount,
      boundaryPoints: outputCount, message: `边界采样完成：${sampleCount} 个采样点，${outputCount} 个边界点。` });
    return output;
  });
}
