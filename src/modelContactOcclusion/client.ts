import type { ContactGeometry, ContactMeshInput } from './types';

type Pending = { id: number; resolve(result: ContactGeometry): void; reject(error: Error): void;
  onProgress?: (message: string) => void; cleanup(): void };
const aborted = (message: string) => new DOMException(message, 'AbortError');

/** Every request owns its Worker and transfer buffers. Cancellation terminates
 * computation, and neither input arrays nor Cesium buffers are ever detached. */
export class ModelContactGeometryClient {
  private worker?: Worker;
  private pending?: Pending;
  private sequence = 0;
  private disposed = false;
  private readonly timeoutMs: number;
  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('模型相交计算时间预算无效。');
  }
  private stop(error?: Error, result?: ContactGeometry): void {
    const worker = this.worker, pending = this.pending; this.worker = undefined; this.pending = undefined;
    worker?.terminate(); pending?.cleanup();
    if (error) pending?.reject(error); else if (result) pending?.resolve(result);
  }
  build(input: ContactMeshInput, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<ContactGeometry> {
    if (this.disposed) return Promise.reject(new Error('模型相交客户端已释放。'));
    if (signal?.aborted) return Promise.reject(aborted('模型相交计算已取消。'));
    if (this.pending) this.stop(aborted('模型相交计算已被新任务替代。'));
    if (typeof Worker === 'undefined') return Promise.reject(new Error('当前环境不支持模型相交 Worker。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => { if (this.pending?.id === id) this.stop(aborted('模型相交计算已取消。')); };
      const timeout = setTimeout(() => { if (this.pending?.id === id) this.stop(new Error('模型相交 Worker 超过时间预算。')); }, this.timeoutMs);
      this.pending = { id, resolve, reject, onProgress, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (input.worldFromLocal.length !== 16 || input.worldFromLocal.some(value => !Number.isFinite(value))) throw new Error('模型相交定位矩阵无效。');
        if (input.primitives.length > 200_000) throw new Error('模型相交图元超过传输预算。');
        let bytes = 0;
        for (const primitive of input.primitives) {
          if (!(primitive.positions instanceof Float64Array) || !(primitive.indices instanceof Uint32Array)) throw new Error('模型相交输入数组类型无效。');
          bytes += primitive.positions.byteLength + primitive.indices.byteLength;
          if (bytes > 512 * 1024 * 1024) throw new Error('模型相交数组超过传输内存预算。');
        }
        const transfer: ArrayBuffer[] = [];
        const snapshot: ContactMeshInput = { worldFromLocal: [...input.worldFromLocal], primitives: input.primitives.map(p => {
          const positions = p.positions.slice(), indices = p.indices.slice();
          transfer.push(positions.buffer, indices.buffer);
          return { positions, indices, groupId: p.groupId, nodeIndex: p.nodeIndex };
        }) };
        const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' }); this.worker = worker;
        worker.onmessage = event => {
          if (this.worker !== worker || this.pending?.id !== id || event.data?.id !== id) return;
          const data = event.data;
          try {
            if (data.kind === 'progress') this.pending.onProgress?.(String(data.message));
            else if (data.kind === 'error') this.stop(new Error(String(data.message)));
            else if (data.kind === 'result') this.stop(undefined, data.result);
          } catch (error) { if (this.worker === worker && this.pending?.id === id) this.stop(error instanceof Error ? error : new Error(String(error))); }
        };
        worker.onerror = event => { event.preventDefault(); if (this.worker === worker) this.stop(new Error(`模型相交 Worker 失败：${event.message}`)); };
        worker.onmessageerror = () => { if (this.worker === worker) this.stop(new Error('模型相交 Worker 结果解码失败。')); };
        worker.postMessage({ kind: 'build', id, input: snapshot }, transfer);
      } catch (error) { if (this.pending?.id === id) this.stop(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.stop(aborted('模型相交客户端已释放。')); } }
}
