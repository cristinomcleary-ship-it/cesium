/** Event-driven local surface composition. This module owns no scene, store, or
 * business geometry: callers prepare a candidate, then synchronously commit it. */
export type SurfaceCompositionBounds = { minX: number; minY: number; maxX: number; maxY: number };
export type SurfaceCompositionEntry<T> = {
  id: string;
  kind: 'road' | 'facility' | 'hardening';
  bounds: SurfaceCompositionBounds;
  /** Smaller values win. A persistent ID breaks ties, never arrival/load order. */
  priority: number;
  /** A preview keeps its saved/source ID here, so a temporary handle ID cannot change priority. */
  orderKey?: string;
  visible: boolean;
  /** For road/facility, only a drawable, ready resource may occupy a surface. */
  ready: boolean;
  data: T;
};
export type SurfaceCompositionCoverage<T> = { bounds: SurfaceCompositionBounds; data: T };
export type SurfaceCompositionState = 'queued' | 'building' | 'ready' | 'covered' | 'hidden' | 'error';
export type SurfaceCompositionOptions<T, R> = {
  build(entry: SurfaceCompositionEntry<T>, blockers: readonly SurfaceCompositionEntry<T>[], signal: AbortSignal): Promise<R>;
  /** Synchronous: all asynchronous geometry and resource preparation belongs in build.
   * Return only the actual drawable coverage, or undefined for a fully covered object. */
  commit(entry: SurfaceCompositionEntry<T>, result: R): SurfaceCompositionCoverage<T> | undefined;
  /** Remove this hardening's display AND its own clipping contribution together. */
  suspend(id: string): void;
  discard?(result: R): void;
  onError?(id: string, error: unknown): void;
};

export function surfaceBoundsIntersect(a: SurfaceCompositionBounds, b: SurfaceCompositionBounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}
function checkBounds(bounds: SurfaceCompositionBounds): void {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) || bounds.minX > bounds.maxX || bounds.minY > bounds.maxY)
    throw new Error('场地范围无效，未更新硬化关联。');
}
function order<T>(a: SurfaceCompositionEntry<T>, b: SurfaceCompositionEntry<T>): number {
  const ak = a.orderKey ?? a.id, bk = b.orderKey ?? b.id;
  return a.priority - b.priority || (ak < bk ? -1 : ak > bk ? 1 : 0);
}
function precedes<T>(a: SurfaceCompositionEntry<T>, b: SurfaceCompositionEntry<T>): boolean {
  return a.id !== b.id && (a.kind !== 'hardening' || order(a, b) < 0);
}

export class TemporaryWorksSurfaceComposition<T, R> {
  private readonly entries = new Map<string, SurfaceCompositionEntry<T>>();
  private readonly coverage = new Map<string, SurfaceCompositionCoverage<T>>();
  private readonly versions = new Map<string, number>();
  private readonly queue = new Map<string, { version: number; preserve: boolean }>();
  private readonly states = new Map<string, SurfaceCompositionState>();
  private sorted: SurfaceCompositionEntry<T>[] | undefined;
  private running?: { id: string; controller: AbortController };
  private draining = false;
  private scheduled = false;
  private disposed = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly options: SurfaceCompositionOptions<T, R>) {}

  private report(id: string, error: unknown) {
    this.states.set(id, 'error');
    try { this.options.onError?.(id, error); } catch { /* Error reporting cannot block another module's operation. */ }
  }
  private suspend(id: string) {
    this.coverage.delete(id);
    try { this.options.suspend(id); } catch (error) { this.report(id, error); }
  }
  private candidates(bounds: SurfaceCompositionBounds) {
    this.sorted ??= [...this.entries.values()].sort((a, b) => a.bounds.minX - b.bounds.minX);
    const found: SurfaceCompositionEntry<T>[] = [];
    // A sorted bounds index eliminates candidates before any polygon boolean work.
    for (const entry of this.sorted) {
      if (entry.bounds.minX > bounds.maxX) break;
      if (surfaceBoundsIntersect(entry.bounds, bounds)) found.push(entry);
    }
    return found;
  }
  private invalidate(entry: SurfaceCompositionEntry<T>, preserve: boolean) {
    if (entry.kind !== 'hardening') return;
    const version = (this.versions.get(entry.id) ?? 0) + 1;
    this.versions.set(entry.id, version);
    if (this.running?.id === entry.id) this.running.controller.abort();
    const pending = this.queue.get(entry.id);
    preserve = (pending?.preserve ?? true) && preserve;
    if (!preserve) this.suspend(entry.id);
    if (!entry.visible) { this.queue.delete(entry.id); this.states.set(entry.id, 'hidden'); return; }
    this.queue.set(entry.id, { version, preserve });
    this.states.set(entry.id, 'queued');
  }
  private invalidateNeighbours(changed: SurfaceCompositionEntry<T>, bounds: SurfaceCompositionBounds) {
    for (const entry of this.candidates(bounds)) {
      if (entry.kind === 'hardening' && entry.visible && precedes(changed, entry)) this.invalidate(entry, false);
    }
  }
  private schedule() {
    if (this.disposed || this.scheduled || this.draining || !this.queue.size) { this.settleIdle(); return; }
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.drain(); });
  }

  upsert(entry: SurfaceCompositionEntry<T>, options: { preserveCurrent?: boolean } = {}): void {
    if (this.disposed) throw new Error('场地硬化协调器已关闭。');
    if (!entry.id || !Number.isFinite(entry.priority)) throw new Error('场地对象缺少稳定编号或优先顺序。');
    checkBounds(entry.bounds);
    const old = this.entries.get(entry.id), oldCoverage = this.coverage.get(entry.id);
    if (old && old.data === entry.data && old.kind === entry.kind && old.visible === entry.visible && old.ready === entry.ready && old.priority === entry.priority && old.orderKey === entry.orderKey &&
      old.bounds.minX === entry.bounds.minX && old.bounds.minY === entry.bounds.minY && old.bounds.maxX === entry.bounds.maxX && old.bounds.maxY === entry.bounds.maxY) return;
    const snapshot = { ...entry, bounds: { ...entry.bounds } };
    this.entries.set(entry.id, snapshot); this.sorted = undefined;
    this.invalidate(snapshot, options.preserveCurrent === true);
    if (old) this.invalidateNeighbours(old, old.bounds);
    if (oldCoverage) this.invalidateNeighbours(old ?? snapshot, oldCoverage.bounds);
    this.invalidateNeighbours(snapshot, snapshot.bounds);
    this.schedule();
  }

  /** Hand off a candidate that the caller has already built and made ready. Do not
   * schedule this entry again or destroy its prepared handle. Only lower-priority
   * neighbours need composition. Later dependencies use the normal invalidation
   * path; an externally edited preview should be cancelled by its owner first. */
  upsertReady(entry: SurfaceCompositionEntry<T>, actual: SurfaceCompositionCoverage<T> | undefined): void {
    if (this.disposed) throw new Error('场地硬化协调器已关闭。');
    if (!entry.id || !Number.isFinite(entry.priority)) throw new Error('场地对象缺少稳定编号或优先顺序。');
    checkBounds(entry.bounds); if (actual) checkBounds(actual.bounds);
    const old = this.entries.get(entry.id), oldCoverage = this.coverage.get(entry.id);
    const snapshot = { ...entry, bounds: { ...entry.bounds }, ready: true };
    this.entries.set(entry.id, snapshot); this.sorted = undefined;
    this.versions.set(entry.id, (this.versions.get(entry.id) ?? 0) + 1);
    this.queue.delete(entry.id);
    if (this.running?.id === entry.id) this.running.controller.abort();
    if (snapshot.visible && actual) this.coverage.set(entry.id, { ...actual, bounds: { ...actual.bounds } });
    else this.coverage.delete(entry.id);
    this.states.set(entry.id, !snapshot.visible ? 'hidden' : actual ? 'ready' : 'covered');
    if (old) this.invalidateNeighbours(old, old.bounds);
    if (oldCoverage) this.invalidateNeighbours(old ?? snapshot, oldCoverage.bounds);
    this.invalidateNeighbours(snapshot, snapshot.bounds);
    this.schedule();
  }

  /** Update non-geometric display metadata on both the source and its current
   * derived coverage. The transform must be immutable and preserve all geometry,
   * dimensions and placement. No owner is suspended and no neighbour is rebuilt.
   * A pending build commits with the latest entry, so callers can apply the latest
   * clipping preference to an already prepared candidate at the commit boundary. */
  updateMetadata(id: string, transform: (data: T) => T): boolean {
    const entry = this.entries.get(id);
    if (this.disposed || !entry) return false;
    const actual = this.coverage.get(id);
    const data = transform(entry.data), actualData = actual ? transform(actual.data) : undefined;
    this.entries.set(id, { ...entry, data }); this.sorted = undefined;
    if (actual) this.coverage.set(id, { ...actual, data: actualData! });
    return true;
  }

  remove(id: string): void {
    const old = this.entries.get(id);
    if (!old) return;
    const oldCoverage = this.coverage.get(id);
    this.entries.delete(id); this.sorted = undefined; this.queue.delete(id);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    if (this.running?.id === id) this.running.controller.abort();
    if (old.kind === 'hardening') this.suspend(id);
    this.states.delete(id);
    this.invalidateNeighbours(old, old.bounds);
    if (oldCoverage) this.invalidateNeighbours(old, oldCoverage.bounds);
    this.schedule();
  }

  refresh(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.disposed) return;
    this.invalidate(entry, false); this.schedule();
  }

  getState(id: string): SurfaceCompositionState | undefined { return this.states.get(id); }
  getCoverage(id: string): SurfaceCompositionCoverage<T> | undefined { return this.coverage.get(id); }

  private blockers(entry: SurfaceCompositionEntry<T>): SurfaceCompositionEntry<T>[] {
    const result: SurfaceCompositionEntry<T>[] = [];
    for (const candidate of this.candidates(entry.bounds)) {
      if (!candidate.visible || !precedes(candidate, entry)) continue;
      if (candidate.kind === 'hardening') {
        const actual = this.coverage.get(candidate.id);
        if (actual && surfaceBoundsIntersect(actual.bounds, entry.bounds)) result.push({ ...candidate, ...actual, ready: true });
      } else if (candidate.ready) result.push(candidate);
    }
    return result.sort((a, b) => Number(a.kind === 'hardening') - Number(b.kind === 'hardening') || order(a, b));
  }

  private async buildAbortable(entry: SurfaceCompositionEntry<T>, blockers: readonly SurfaceCompositionEntry<T>[], signal: AbortSignal): Promise<R> {
    // Stop scheduling promptly even when a loader ignores cancellation. Its late
    // resource is discarded, never committed back into a deleted/changed project.
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; reject(signal.reason ?? new DOMException('已取消场地更新', 'AbortError')); } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return this.options.build(entry, blockers, signal);
      }).then(result => {
        signal.removeEventListener('abort', abort);
        if (settled) { this.options.discard?.(result); return; }
        settled = true; resolve(result);
      }, error => {
        signal.removeEventListener('abort', abort);
        if (!settled) { settled = true; reject(error); }
      }).catch(error => { if (!this.disposed && this.entries.has(entry.id)) this.report(entry.id, error); });
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) { this.settleIdle(); return; }
    this.draining = true;
    try {
      while (this.queue.size && !this.disposed) {
        const next = [...this.queue.keys()].map(id => this.entries.get(id)).filter((e): e is SurfaceCompositionEntry<T> => !!e).sort(order)[0];
        if (!next) { this.queue.clear(); break; }
        const task = this.queue.get(next.id)!; this.queue.delete(next.id);
        if (!next.visible) continue;
        const controller = new AbortController();
        this.running = { id: next.id, controller };
        this.states.set(next.id, 'building');
        let result: R | undefined, built = false, committed = false, commitAttempted = false;
        try {
          result = await this.buildAbortable(next, this.blockers(next), controller.signal); built = true;
          if (this.disposed || controller.signal.aborted || this.versions.get(next.id) !== task.version) continue;
          commitAttempted = true;
          // Metadata may change without invalidating the expensive geometry job.
          const current = this.entries.get(next.id)!;
          const actual = this.options.commit(current, result);
          committed = true;
          if (actual) {
            checkBounds(actual.bounds);
            this.coverage.set(next.id, { ...actual, bounds: { ...actual.bounds } });
            this.states.set(next.id, 'ready');
          } else {
            this.coverage.delete(next.id); this.states.set(next.id, 'covered');
          }
          this.invalidateNeighbours(next, next.bounds);
        } catch (error) {
          if (!controller.signal.aborted && this.versions.get(next.id) === task.version && !this.disposed) {
            if (!task.preserve || commitAttempted) this.suspend(next.id);
            this.report(next.id, error);
            this.invalidateNeighbours(next, next.bounds);
          }
        } finally {
          if (built && !committed) {
            try { this.options.discard?.(result!); } catch (error) { this.report(next.id, error); }
          }
          if (this.running?.controller === controller) this.running = undefined;
        }
      }
    } finally { this.draining = false; this.settleIdle(); }
  }

  private settleIdle() {
    if (this.draining || this.scheduled || this.queue.size) return;
    this.idleResolvers.splice(0).forEach(resolve => resolve());
  }
  whenIdle(): Promise<void> {
    if (!this.draining && !this.scheduled && !this.queue.size) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  clear(): void {
    this.running?.controller.abort();
    const ids = [...this.entries.values()].filter(e => e.kind === 'hardening').map(e => e.id);
    this.entries.clear(); this.coverage.clear(); this.queue.clear(); this.versions.clear(); this.states.clear(); this.sorted = undefined;
    ids.forEach(id => this.suspend(id));
    this.settleIdle();
  }
  destroy(): void { if (this.disposed) return; this.disposed = true; this.clear(); }
}
