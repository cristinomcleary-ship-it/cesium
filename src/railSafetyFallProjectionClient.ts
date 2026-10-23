import { computeRailSafetyFallProjection, type PreparedRailSafetyFallProjection } from './railSafetyFallProjection';

export type RailSafetyFallProjectionResult = ReturnType<typeof computeRailSafetyFallProjection>;
export interface RailSafetyFallProjectionClient {
  compute(direction: number, angle: number): Promise<RailSafetyFallProjectionResult>;
  dispose(): void;
}

/** Keeps the indexed mesh in one worker; per-frame messages contain only two angles. */
export function createRailSafetyFallProjectionClient(
  prepared: PreparedRailSafetyFallProjection,
  options: { createWorker?: () => Worker; timeoutMs?: number } = {},
): RailSafetyFallProjectionClient {
  // CPU test environments have no canvas/Worker. Browsers never rasterize a large mesh on the UI thread.
  if (typeof window === 'undefined' && !options.createWorker) {
    let disposed = false;
    return { compute: async (direction, angle) => {
      if (disposed) throw new Error('机械投影已停止');
      return computeRailSafetyFallProjection(prepared, direction, angle);
    }, dispose() { disposed = true; } };
  }
  if (typeof Worker === 'undefined' && !options.createWorker) throw new Error('当前浏览器不支持后台机械投影，请更换支持 Web Worker 的浏览器');
  const worker = options.createWorker?.() ?? new Worker(new URL('./railSafetyFallProjectionWorker.ts', import.meta.url), { type: 'module', name: 'rail-safety-fall-projection' });
  let next = 0, disposed = false;
  const pending = new Map<number, { resolve: (value: RailSafetyFallProjectionResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const rejectAll = (message: string) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    pending.clear();
  };
  const fail = (message: string) => { disposed = true; rejectAll(message); worker.terminate(); };
  worker.onmessage = event => {
    const message = event.data, request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  };
  worker.onerror = event => fail(event.message || '机械投影后台计算失败');
  worker.onmessageerror = () => fail('机械投影后台数据无法读取');
  try { worker.postMessage({ type: 'prepare', prepared }); }
  catch (error) { fail('机械投影后台初始化失败'); throw error; }
  return {
    compute(direction, angle) {
      if (disposed) return Promise.reject(new Error('机械投影已停止'));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => fail('机械投影计算超时，请停止演示后重新打开'), options.timeoutMs ?? 15_000);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ type: 'project', id, direction, angle }); }
        catch { fail('机械投影后台任务无法发送'); }
      });
    },
    dispose() { if (!disposed) fail('机械投影已停止'); },
  };
}
