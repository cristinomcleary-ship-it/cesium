import type { EngineeringFootprintBinding, EngineeringFootprintResult, EngineeringRuntimeNodeTransform } from './footprints';
export type { EngineeringFootprintResult, EngineeringRuntimeNodeTransform } from './footprints';

type Pending = { id: number; resolve(value: EngineeringFootprintResult): void; reject(error: Error): void;
  progress?: (message: string) => void; cleanup(): void };
/** Cancellations terminate the actual geometry work. No large main-thread fallback exists. */
export class EngineeringFootprintClient {
  private worker?: Worker;
  private ready?: Promise<void>;
  private rejectReady?: (error: Error) => void;
  private pending?: Pending;
  private sequence = 0;
  private disposed = false;
  private readonly bytes: ArrayBuffer;
  private readonly bindings: readonly EngineeringFootprintBinding[];
  private readonly runtime?: readonly EngineeringRuntimeNodeTransform[];
  constructor(bytes: ArrayBuffer, bindings: readonly EngineeringFootprintBinding[], runtimeNodeTransforms?: readonly EngineeringRuntimeNodeTransform[]) {
    this.bytes = bytes.slice(0);
    this.bindings = bindings.map(b => ({ componentId: b.componentId, nodeIndices: [...b.nodeIndices] }));
    this.runtime = runtimeNodeTransforms?.map(n => ({ nodeIndex: n.nodeIndex, matrix: [...n.matrix] }));
  }
  private stop(error: Error): void {
    this.worker?.terminate(); this.worker = undefined;
    this.rejectReady?.(error); this.rejectReady = undefined; this.ready = undefined;
    const current = this.pending; this.pending = undefined; current?.cleanup(); current?.reject(error);
  }
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (typeof Worker === 'undefined') return Promise.reject(new Error('当前环境不支持精确轮廓 Worker，原有效遮挡已保留'));
    const worker = new Worker(new URL('./footprints.worker.ts', import.meta.url), { type: 'module' }); this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      worker.onmessage = event => {
        if (worker !== this.worker) return;
        const data = event.data;
        if (data.kind === 'ready') { this.rejectReady = undefined; resolve(); return; }
        if (data.kind === 'error') { this.stop(new Error(data.message)); return; }
        const current = this.pending;
        if (!current || data.id !== current.id) return;
        if (data.kind === 'progress') current.progress?.(data.message);
        if (data.kind === 'result') { this.pending = undefined; current.cleanup(); current.resolve(data.result); }
      };
      worker.onerror = event => { event.preventDefault(); this.stop(new Error(`精确轮廓 Worker 失败：${event.message}`)); };
      const bytes = this.bytes.slice(0);
      worker.postMessage({ kind: 'init', bytes, bindings: this.bindings, runtime: this.runtime }, [bytes]);
    });
    return this.ready;
  }
  project(worldFromGltf: readonly number[], componentIds: readonly string[], signal?: AbortSignal, onProgress?: (message: string) => void): Promise<EngineeringFootprintResult> {
    if (this.disposed) return Promise.reject(new Error('精确轮廓客户端已释放'));
    if (signal?.aborted) return Promise.reject(new DOMException('精确轮廓计算已取消', 'AbortError'));
    if (this.pending) this.stop(new DOMException('精确轮廓计算已被新任务替代', 'AbortError'));
    const id = ++this.sequence, world = [...worldFromGltf], ids = [...componentIds];
    return new Promise((resolve, reject) => {
      const abort = () => this.stop(new DOMException('精确轮廓计算已取消', 'AbortError'));
      const timeout = setTimeout(() => this.stop(new Error('精确轮廓 Worker 超过 120 秒预算，原有效遮挡保留')), 120_000);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending = { id, resolve, reject, progress: onProgress, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } };
      void Promise.resolve().then(async () => {
        if (this.pending?.id !== id || this.disposed) return;
        await this.start();
        if (this.pending?.id === id && !this.disposed) this.worker!.postMessage({ kind: 'project', id, world, componentIds: ids });
      }).catch(error => { if (this.pending?.id === id) this.stop(error instanceof Error ? error : new Error(String(error))); });
    });
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.stop(new DOMException('精确轮廓客户端已释放', 'AbortError')); } }
}
