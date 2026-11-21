/** A lease spans runtime decoding AND the Worker. Waiting tasks retain metadata
 * only; they must not read/copy model buffers until this promise resolves. */
export const MAX_PENDING_CONTACT_WORK = 8;
type Waiter = { resolve(release: () => void): void; reject(error: Error): void; signal?: AbortSignal; onAbort(): void };
const cancelled = () => new DOMException('模型三维计算排队已取消。', 'AbortError');

export class ContactWorkQueue {
  private active = false;
  private readonly waiting: Waiter[] = [];
  constructor(private readonly maxPending = MAX_PENDING_CONTACT_WORK) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 0) throw new Error('模型三维计算队列预算无效。');
  }
  get status(): Readonly<{ active: number; pending: number }> { return { active: this.active ? 1 : 0, pending: this.waiting.length }; }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active && this.waiting.length >= this.maxPending) return Promise.reject(new Error(`模型三维计算队列已达到 ${this.maxPending} 个等待任务预算；未开始读取几何，请稍后重试。`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1); signal?.removeEventListener('abort', waiter.onAbort); reject(cancelled());
      } };
      if (!this.active) this.grant(waiter);
      else { this.waiting.push(waiter); signal?.addEventListener('abort', waiter.onAbort, { once: true }); }
    });
  }

  private grant(waiter: Waiter): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    this.active = true; let released = false;
    // Aborting an active signal must not grant the next task until the holder's
    // finally block has actually stopped its reader/Worker and released arrays.
    waiter.resolve(() => {
      if (released) return;
      released = true; this.active = false;
      while (this.waiting.length) {
        const next = this.waiting.shift()!;
        if (next.signal?.aborted) { next.signal.removeEventListener('abort', next.onAbort); next.reject(cancelled()); continue; }
        this.grant(next); break;
      }
    });
  }
}

const contactWorkQueue = new ContactWorkQueue();
export const acquireContactWorkLease = (signal?: AbortSignal): Promise<() => void> => contactWorkQueue.acquire(signal);

