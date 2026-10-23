export type VideoOverlayTaskSettlement = {
  label: string;
  status: 'fulfilled' | 'aborted' | 'rejected';
  error?: string;
};

export type VideoOverlayCleanupSettlement = {
  label: string;
  status: 'completed' | 'incomplete' | 'failed';
  detail?: unknown;
  error?: string;
};

export type VideoOverlayLifecycleReport = {
  ok: boolean;
  tasks: VideoOverlayTaskSettlement[];
  cleanups: VideoOverlayCleanupSettlement[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One AR computation session, separate from the lifetime of the main Viewer.
 * Register work with run() before it can access session resources. Work must
 * observe signal and release its own transient allocations in finally blocks.
 * abort() stops new work immediately; settled() is the barrier before shared
 * scene state can be reused. close() also runs registered releases, once only.
 * No timeout pretends an uncooperative task has stopped touching its resources.
 */
export class VideoOverlayLifecycle {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly taskResults: VideoOverlayTaskSettlement[] = [];
  private readonly cleanups: Array<{ label: string; release: () => unknown | Promise<unknown> }> = [];
  private closePromise?: Promise<VideoOverlayLifecycleReport>;

  get signal(): AbortSignal { return this.controller.signal; }
  get pendingCount(): number { return this.pending.size; }

  run<T>(label: string, work: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    // Defer execution until registration is complete, including synchronous
    // callbacks which initiate exit or throw before returning a Promise.
    const task = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return work(this.signal);
    });
    const settled = task.then(
      () => { this.taskResults.push({ label, status: 'fulfilled' }); },
      error => {
        const aborted = error === this.signal.reason || (error instanceof Error && error.name === 'AbortError');
        this.taskResults.push({ label, status: aborted ? 'aborted' : 'rejected', error: errorMessage(error) });
      },
    ).then(() => { this.pending.delete(settled); });
    this.pending.add(settled);
    return task;
  }

  addCleanup(label: string, release: () => unknown | Promise<unknown>): void {
    if (this.signal.aborted) throw new Error('Cannot register AR cleanup after session cancellation');
    this.cleanups.push({ label, release });
  }

  abort(): void {
    if (!this.signal.aborted) this.controller.abort(new DOMException('AR session ended', 'AbortError'));
  }

  /** Call abort() first when using this as the barrier before a new session. */
  async settled(): Promise<VideoOverlayTaskSettlement[]> {
    while (this.pending.size) await Promise.all([...this.pending]);
    return this.taskResults.map(result => ({ ...result }));
  }

  close(): Promise<VideoOverlayLifecycleReport> {
    if (this.closePromise) return this.closePromise;
    // Publish the promise before abort listeners can re-enter close().
    this.closePromise = Promise.resolve().then(() => this.finish());
    this.abort();
    return this.closePromise;
  }

  private async finish(): Promise<VideoOverlayLifecycleReport> {
    const tasks = await this.settled();
    const cleanups: VideoOverlayCleanupSettlement[] = [];
    for (const { label, release } of this.cleanups.splice(0).reverse()) {
      try {
        const detail = await release();
        // Renderer adapters may intentionally skip unsupported/replaced owners.
        // A fulfilled callback is not sufficient evidence of complete release.
        const incomplete = !!detail && typeof detail === 'object' && 'skipped' in detail && detail.skipped === true;
        cleanups.push({ label, status: incomplete ? 'incomplete' : 'completed', ...(detail === undefined ? {} : { detail }) });
      } catch (error) {
        cleanups.push({ label, status: 'failed', error: errorMessage(error) });
      }
    }
    return { ok: tasks.every(task => task.status !== 'rejected') && cleanups.every(cleanup => cleanup.status === 'completed'), tasks, cleanups };
  }
}
