import type { GroundPolylinePrimitive, GroundPrimitive, Primitive, PrimitiveCollection, Scene } from 'cesium';

type CadPrimitive = Primitive | GroundPrimitive | GroundPolylinePrimitive;
type RuntimePrimitive = {
  ready: boolean; show: boolean; isDestroyed(): boolean;
  update(...args: unknown[]): void;
  _primitive?: RuntimePrimitive; _state?: number; _error?: unknown;
  _createGeometryResults?: unknown; _geometries?: unknown; geometryInstances?: unknown;
};
type RuntimeCollection = PrimitiveCollection & { update(...args: unknown[]): void };
type Waiter = { capacity: boolean; resolve(): void; reject(error: Error): void };
type Job = {
  owner: CadGeometryScheduler; primitive: RuntimePrimitive;
  started: boolean; cancelled: boolean; exclusive: boolean; captured: RuntimePrimitive[];
  restore(): void;
};

const MAX_ACTIVE = 2;
const MAX_PENDING = 4;
const queues = new WeakMap<Scene, SceneQueue>();

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  const detail = value as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
  const error = new Error(typeof detail?.message === 'string' ? detail.message : String(value));
  if (typeof detail?.name === 'string') error.name = detail.name;
  if (typeof detail?.stack === 'string') error.stack = detail.stack;
  return error;
}

function aborted(): Error { return new DOMException('CAD 加载已取消', 'AbortError'); }
function chain(primitive: RuntimePrimitive): RuntimePrimitive[] {
  const result: RuntimePrimitive[] = [];
  for (let current: RuntimePrimitive | undefined = primitive; current && !result.includes(current); current = current._primitive) result.push(current);
  return result;
}

// Version-scoped read adapter for Cesium 1.144 / engine 26.2. Failed primitives
// can have ready=true, and GroundPrimitive has two nested primitive owners.
// FAILED without _error is Cesium's existing empty/degenerate geometry outcome.
function compilationError(values: RuntimePrimitive[]): Error | undefined {
  for (const value of values) {
    if (value._error !== undefined) return asError(value._error);
  }
  return undefined;
}
function workerBusy(values: RuntimePrimitive[]): boolean {
  return values.some(value => value._state === 1 || value._state === 3);
}

function replaceUpdate(target: { update(...args: unknown[]): void }, replacement: (...args: unknown[]) => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, 'update');
  target.update = replacement;
  return () => {
    if (target.update !== replacement) return; // Do not revive a destroyed object or overwrite another owner.
    if (descriptor) Object.defineProperty(target, 'update', descriptor);
    else Reflect.deleteProperty(target, 'update');
  };
}

class SceneQueue {
  private jobs: Job[] = [];
  private readonly capacityWaiters = new Set<CadGeometryScheduler>();
  private removeRender?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private maximumActive = 0;
  constructor(private readonly scene: Scene) {}
  get activeCount(): number { return this.jobs.filter(job => job.started).length; }
  get pendingCount(): number { return this.jobs.length; }
  snapshot() { return { active: this.activeCount, queued: this.jobs.filter(job => !job.started).length, pending: this.jobs.length, maxActive: this.maximumActive }; }
  watchCapacity(owner: CadGeometryScheduler): void { this.capacityWaiters.add(owner); }
  unwatchCapacity(owner: CadGeometryScheduler): void { this.capacityWaiters.delete(owner); }

  add(job: Job): void { this.jobs.push(job); this.start(); }
  acquire(job: Job): boolean {
    if (job.cancelled) return false;
    if (job.started) return true;
    if (this.jobs.some(candidate => candidate.started && candidate.exclusive)) return false;
    if (job.exclusive && this.activeCount !== 0) return false;
    if (this.activeCount >= MAX_ACTIVE || this.jobs.find(candidate => !candidate.started && !candidate.cancelled) !== job) return false;
    job.started = true;
    this.maximumActive = Math.max(this.maximumActive, this.activeCount);
    return true;
  }
  cancel(job: Job): void {
    job.cancelled = true;
    job.captured = [...new Set([...job.captured, ...chain(job.primitive)])];
    // Leave the cancelled guard installed until destruction; otherwise later
    // children in the current collection.update could start new worker tasks.
    // Destroying a Primitive does not cancel its submitted worker promises.
    // Keep its permit until those exact captured owners leave worker states.
    if (!job.started || !workerBusy(job.captured)) this.remove(job);
  }
  complete(job: Job): void { this.remove(job); job.restore(); job.owner.completed(job); }
  private remove(job: Job): void {
    const index = this.jobs.indexOf(job);
    if (index >= 0) {
      this.jobs.splice(index, 1);
      for (const owner of this.capacityWaiters) owner.capacityChanged();
    }
  }
  private start(): void {
    this.removeRender ??= this.scene.postRender.addEventListener(this.tick);
    this.arm();
    this.scene.requestRender();
  }
  private arm(): void {
    if (this.timer === undefined && this.jobs.length) this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, 40);
  }
  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.removeRender?.(); this.removeRender = undefined;
  }
  private tick = (): void => {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const owner of new Set(this.jobs.filter(job => !job.cancelled).map(job => job.owner))) owner.check();
      for (const job of [...this.jobs]) {
        if (job.cancelled) {
          if (!workerBusy(job.captured)) {
            // A completed worker may have attached arrays after destroy(). Only
            // release data from these cancelled, destroyed owners.
            for (const value of job.captured) if (value.isDestroyed()) {
              value._createGeometryResults = undefined; value._geometries = undefined; value.geometryInstances = undefined;
            }
            this.remove(job);
          }
          continue;
        }
        if (!job.started) continue;
        job.captured = chain(job.primitive);
        const error = compilationError(job.captured);
        if (error) job.owner.fail(error);
        else if (job.primitive.isDestroyed()) job.owner.fail(new Error('CAD 图元已移除，加载未完成'));
        else if (job.primitive.ready) this.complete(job);
      }
      if (this.jobs.length) {
        if (this.jobs.some(job => !job.cancelled)) this.scene.requestRender();
        this.arm();
      } else this.stop();
    } catch (error) {
      // A scene removed between checks must reject this import, not throw from
      // our postRender callback and stop unrelated scene content.
      for (const owner of new Set(this.jobs.filter(job => !job.cancelled).map(job => job.owner))) owner.fail(asError(error));
    } finally {
      this.ticking = false;
      if (this.jobs.length) this.arm(); else this.stop();
    }
  };
}

export type CadGeometrySchedulerOptions = {
  scene?: Scene;
  collection: PrimitiveCollection;
  signal?: AbortSignal;
  /** True only when beforePopulate attaches this new collection to scene.primitives. */
  enabled?: boolean;
  /** Compile a hidden AR copy without drawing its geometry or labels. */
  showWhileLoading?: boolean;
  /** A deliberately paused viewer does not consume the compilation timeout. */
  isRenderActive?: () => boolean;
  /** Maximum active-render time without a completed batch. */
  timeoutMs?: number;
};
export type CadGeometryScheduleOptions = {
  /** Preserve one indivisible large face while preventing concurrent geometry allocations. */
  exclusive?: boolean;
};

export class CadGeometryScheduler {
  readonly enabled: boolean;
  private readonly queue?: SceneQueue;
  private readonly collection: RuntimeCollection;
  private readonly jobs = new Set<Job>();
  private readonly waiters = new Set<Waiter>();
  private error?: Error;
  private finished = false;
  private lastProgress = Date.now();
  private pausedAt?: number;
  private restoreCollection?: () => void;
  private removeAbort?: () => void;
  constructor(private readonly options: CadGeometrySchedulerOptions) {
    this.collection = options.collection as RuntimeCollection;
    const scene = options.scene;
    this.enabled = Boolean(options.enabled && typeof scene?.postRender?.addEventListener === 'function'
      && typeof scene?.requestRender === 'function' && typeof scene?.primitives?.contains === 'function');
    if (this.enabled && scene) {
      this.queue = queues.get(scene);
      if (!this.queue) { this.queue = new SceneQueue(scene); queues.set(scene, this.queue); }
      const original = this.collection.update;
      this.restoreCollection = replaceUpdate(this.collection, (...args) => {
        if (this.error || this.collection.isDestroyed()) return;
        if (options.showWhileLoading !== false && this.collection.show) { original.apply(this.collection, args); return; }
        const wasShown = this.collection.show;
        const visibility: Array<[RuntimePrimitive, boolean]> = [];
        try {
          // Hidden Primitive leaves still compile; hidden collections do not.
          // Preserve external show values outside this one update, including AR.
          this.collection.show = true;
          for (let i = 0; i < this.collection.length; i++) {
            const child = this.collection.get(i) as RuntimePrimitive;
            visibility.push([child, child.show]); child.show = false;
          }
          original.apply(this.collection, args);
        } finally {
          if (!this.collection.isDestroyed()) this.collection.show = wasShown;
          for (const [child, show] of visibility) if (!child.isDestroyed()) child.show = show;
        }
      });
    }
    const abort = () => this.fail(aborted());
    options.signal?.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => options.signal?.removeEventListener('abort', abort);
  }
  get pendingCount(): number { return this.jobs.size; }
  /** Shared scene count; includes cancelled workers until their task settles. */
  get activeCount(): number { return this.queue?.activeCount ?? 0; }

  add<T extends CadPrimitive>(primitive: T, options: CadGeometryScheduleOptions = {}): T {
    this.check(); this.throwIfFailed();
    if (this.finished) throw new Error('CAD 加载队列已经完成');
    const added = this.collection.add(primitive);
    if (!this.enabled) return added;
    const runtime = primitive as unknown as RuntimePrimitive;
    const error = compilationError(chain(runtime));
    if (error) { this.fail(error); this.throwIfFailed(); }
    if (runtime.ready) return added;
    const original = runtime.update;
    const job: Job = { owner: this, primitive: runtime, started: false, cancelled: false, exclusive: options.exclusive ?? false, captured: [], restore() {} };
    job.restore = replaceUpdate(runtime, (...args) => {
      if (this.error || job.cancelled) return;
      this.check();
      if (this.error || !this.queue!.acquire(job)) return;
      try {
        original.apply(runtime, args);
        job.captured = chain(runtime);
        const error = compilationError(job.captured);
        if (error) this.fail(error);
        else if (runtime.ready) this.queue!.complete(job);
      } catch (error) { job.captured = chain(runtime); this.fail(asError(error)); }
    });
    this.jobs.add(job);
    if (this.jobs.size === 1) this.recordProgress();
    try { this.queue!.add(job); }
    catch (error) { this.fail(asError(error)); this.throwIfFailed(); }
    return added;
  }

  async waitForCapacity(): Promise<void> {
    this.check(); this.throwIfFailed();
    if (!this.enabled || this.queue!.pendingCount < MAX_PENDING) return;
    await this.wait(true);
  }
  async finish(): Promise<void> {
    this.check(); this.throwIfFailed();
    if (this.finished) return;
    if (this.enabled && this.jobs.size) await this.wait(false);
    this.check(); this.throwIfFailed();
    this.finished = true;
    this.restoreCollection?.(); this.restoreCollection = undefined;
    this.removeAbort?.(); this.removeAbort = undefined;
  }
  /** Cancel only this new import. A successfully finished collection is retained. */
  dispose(error?: unknown): void { if (!this.finished) this.fail(error === undefined ? aborted() : asError(error)); }

  check(): void {
    if (this.error || this.finished) return;
    if (this.options.signal?.aborted) { this.fail(aborted()); return; }
    if (this.collection.isDestroyed()) { this.fail(new Error('CAD 图层已移除，加载未完成')); return; }
    try {
      const scene = this.options.scene;
      if (this.enabled && (scene?.isDestroyed?.() || !scene!.primitives.contains(this.collection))) { this.fail(new Error('CAD 图层已从场景移除，加载未完成')); return; }
      const now = Date.now();
      if (this.options.isRenderActive?.() === false) {
        // requestRender() cannot advance primitives while the host has stopped
        // the viewer loop. Keep the batch and its permits until scene re-entry.
        this.pausedAt ??= now;
        return;
      }
      if (this.pausedAt !== undefined) {
        this.lastProgress += Math.max(0, now - this.pausedAt);
        this.pausedAt = undefined;
      }
      if (this.jobs.size && now - this.lastProgress > (this.options.timeoutMs ?? 60_000)) this.fail(new Error('CAD 几何生成等待超时，已停止本次加载；现有图层保持不变'));
    } catch (error) { this.fail(asError(error)); return; }
  }
  private recordProgress(): void {
    const now = Date.now();
    this.lastProgress = now;
    if (this.pausedAt !== undefined) this.pausedAt = now;
  }
  completed(job: Job): void { this.jobs.delete(job); this.recordProgress(); this.notify(); }
  capacityChanged(): void { this.notify(); }
  fail(error: Error): void {
    if (this.error || this.finished) return;
    this.error = error;
    for (const job of this.jobs) this.queue?.cancel(job);
    this.jobs.clear();
    this.removeAbort?.(); this.removeAbort = undefined;
    this.notify();
    // Do not mutate Cesium's collection while it is iterating this frame.
    queueMicrotask(() => {
      if (this.collection.isDestroyed()) return;
      const scene = this.options.scene;
      if (!scene?.isDestroyed?.() && scene?.primitives && !scene.primitives.isDestroyed()
        && scene.primitives.contains(this.collection)) scene.primitives.remove(this.collection);
      if (!this.collection.isDestroyed()) this.collection.destroy();
      this.restoreCollection?.(); this.restoreCollection = undefined;
    });
  }
  private throwIfFailed(): void { if (this.error) throw this.error; }
  private wait(capacity: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.add({ capacity, resolve, reject });
      if (capacity) this.queue?.watchCapacity(this);
      this.notify();
    });
  }
  private notify(): void {
    for (const waiter of this.waiters) {
      if (this.error) { this.waiters.delete(waiter); waiter.reject(this.error); }
      else if (waiter.capacity ? this.queue!.pendingCount < MAX_PENDING : !this.jobs.size) { this.waiters.delete(waiter); waiter.resolve(); }
    }
    if (![...this.waiters].some(waiter => waiter.capacity)) this.queue?.unwatchCapacity(this);
  }
}

export function createCadGeometryScheduler(options: CadGeometrySchedulerOptions): CadGeometryScheduler {
  return new CadGeometryScheduler(options);
}

/** Read-only QA/diagnostic counters; cancelled worker tasks retain active permits. */
export function getCadGeometrySchedulerStats(scene: Scene) {
  return queues.get(scene)?.snapshot() ?? { active: 0, queued: 0, pending: 0, maxActive: 0 };
}
