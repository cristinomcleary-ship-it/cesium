import { computeMachineryFallEnvelope, type FallEnvelope, type FallSupportRectangle } from './railSafetyGeometry';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';

export type RailSafetyWorkerRequest = {
  type: 'compute'; requestId: number; assetKey: string;
  /** Included once per immutable asset version; structured clone, never transferred. */
  asset?: LoadedMachineryAsset; metadata: MachineryMetadata; support?: FallSupportRectangle;
};
export type RailSafetyWorkerResponse =
  | { type: 'result'; requestId: number; envelope: FallEnvelope }
  | { type: 'error'; requestId: number; message: string };
type Pending = {
  resolve: (value: FallEnvelope) => void; reject: (error: Error) => void;
  request: RailSafetyWorkerRequest; asset: LoadedMachineryAsset;
  resourceId?: string; timeout?: ReturnType<typeof setTimeout>;
};

/** Owns one dedicated computation thread. Scene generations decide whether a result is still
 * current; request IDs keep simultaneous machines/poses separate even if replies arrive late.
 * This service deliberately does not transfer caller-owned model buffers, which the renderer
 * and asset cache continue using. Browser failures remain visible instead of blocking the UI
 * with an expensive synchronous fallback. */
export class RailSafetyComputation {
  private worker?: Worker;
  private sequence = 0;
  private disposed = false;
  private failure?: Error;
  private readonly sentAssets = new Set<string>();
  private readonly pending = new Map<number, Pending>();
  private queue: number[] = [];
  private activeRequest?: number;

  compute(asset: LoadedMachineryAsset, metadata: MachineryMetadata, support?: FallSupportRectangle, resourceId?: string): Promise<FallEnvelope> {
    if (this.disposed) return Promise.reject(new Error('倾覆几何计算已取消：计算服务已关闭'));
    if (this.failure) return Promise.reject(this.failure);
    if (typeof Worker === 'undefined') {
      // Isolated Node tests have no browser Worker. No browser/main-thread fallback is allowed.
      const node = typeof process !== 'undefined' && typeof process.versions?.node === 'string';
      if (!node) return Promise.reject(new Error('浏览器不支持独立计算线程，无法计算倾覆落点外包'));
      return Promise.resolve().then(() => {
        if (this.disposed) throw new Error('倾覆几何计算已取消：计算服务已关闭');
        return computeMachineryFallEnvelope(asset, metadata, support);
      });
    }
    try { this.getWorker(); }
    catch (error) {
      const failure = new Error(`无法启动倾覆几何计算线程：${error instanceof Error ? error.message : String(error)}`);
      this.fail(failure); return Promise.reject(failure);
    }
    const requestId = ++this.sequence, assetKey = `${asset.id}@${asset.version}`;
    return new Promise<FallEnvelope>((resolve, reject) => {
      try {
        const request: RailSafetyWorkerRequest = { type: 'compute', requestId, assetKey, metadata: structuredClone(metadata), support: support ? { ...support } : undefined };
        // Keep only the most recent waiting pose for this machine. Do not cancel other
        // machines sharing the same model asset, or interrupt the currently running job.
        if (resourceId) {
          this.queue = this.queue.filter(id => {
            const old = this.pending.get(id);
            if (old?.resourceId !== resourceId) return true;
            this.pending.delete(id); old.reject(new Error('倾覆几何计算已取消：已被此机械的新参数替代')); return false;
          });
        }
        this.pending.set(requestId, { resolve, reject, request, asset, resourceId });
        this.queue.push(requestId); this.dispatch();
      } catch (error) {
        reject(new Error(`无法准备倾覆几何参数：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error('倾覆几何计算已取消：计算服务已关闭'));
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./railSafetyWorker.ts', import.meta.url), { type: 'module', name: 'rail-safety-geometry' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<RailSafetyWorkerResponse>) => {
      const message = event.data;
      if (!message || !Number.isSafeInteger(message.requestId) || (message.type !== 'result' && message.type !== 'error')) {
        this.fail(new Error('倾覆几何计算线程返回了无效响应')); return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout); this.pending.delete(message.requestId);
      if (this.activeRequest === message.requestId) this.activeRequest = undefined;
      if (message.type === 'error') pending.reject(new Error(message.message || '倾覆几何计算失败'));
      else pending.resolve(message.envelope);
      this.dispatch();
    };
    worker.onerror = event => {
      event.preventDefault();
      this.fail(new Error(`倾覆几何计算线程异常：${event.message || '线程无法继续运行'}`));
    };
    worker.onmessageerror = () => this.fail(new Error('倾覆几何计算线程消息无法读取'));
    return worker;
  }

  private dispatch(): void {
    if (this.disposed || this.failure || this.activeRequest !== undefined || !this.worker) return;
    const requestId = this.queue.shift();
    if (requestId === undefined) return;
    const pending = this.pending.get(requestId);
    if (!pending) { this.dispatch(); return; }
    this.activeRequest = requestId;
    pending.timeout = setTimeout(() => this.fail(new Error('倾覆几何计算线程响应超时，请刷新页面后重试')), 30_000);
    if (!this.sentAssets.has(pending.request.assetKey)) pending.request.asset = pending.asset;
    try {
      // Deliberately omit a transfer list: source geometry remains attached on the main thread.
      this.worker.postMessage(pending.request); this.sentAssets.add(pending.request.assetKey);
    } catch (error) {
      this.fail(new Error(`无法发送倾覆几何参数：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = undefined;
    }
    this.sentAssets.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear(); this.queue = []; this.activeRequest = undefined;
  }
}
