export type VideoOverlaySaveRequest<T> = Readonly<{
  session: string; revision: number; snapshot: T; existingId?: string;
}>;
export type VideoOverlaySaveResult = Readonly<{ session: string; revision: number; id: string }>;
export type VideoOverlayAutosaveOptions<T> = Readonly<{
  save: (request: VideoOverlaySaveRequest<T>) => Promise<string>;
  onSaved?: (result: VideoOverlaySaveResult) => void;
  onError?: (error: unknown, request: VideoOverlaySaveRequest<T>) => void;
}>;

type Waiter = { revision: number; resolve: (result: VideoOverlaySaveResult) => void; reject: (error: unknown) => void };
type Session<T> = {
  id?: string; latestRevision: number; saved?: VideoOverlaySaveResult;
  pending?: VideoOverlaySaveRequest<T>; error?: unknown; failed: boolean;
  waiters: Waiter[];
};

/** Serial persistence independent of the active AR screen.
 * The caller supplies an immutable snapshot (clone settings, retain immutable
 * File references) and a stable session token. Callbacks carry that token so an
 * old session's completion cannot be mistaken for the current screen's save.
 * Snapshot/file references are released after successful persistence.
 */
export class VideoOverlayAutosave<T> {
  private readonly sessions = new Map<string, Session<T>>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private worker?: Promise<void>;
  private readonly options: VideoOverlayAutosaveOptions<T>;

  constructor(options: VideoOverlayAutosaveOptions<T>) { this.options = options; }

  /** Includes failed unsaved work; suitable for a beforeunload warning. */
  get hasPending(): boolean {
    return !!this.worker || [...this.sessions.values()].some(session => !!session.pending);
  }

  /** Pending revisions coalesce. Their promises resolve with the actual latest
   * saved revision, never with an older in-flight revision. A failed save rejects
   * outstanding submit promises, retains the newest snapshot and pauses that
   * session until retry(). Other sessions continue normally.
   */
  submit(request: VideoOverlaySaveRequest<T>): Promise<VideoOverlaySaveResult> {
    if (!request || typeof request.session !== 'string' || !request.session.trim()
      || !Number.isSafeInteger(request.revision) || request.revision < 0
      || request.existingId !== undefined && (typeof request.existingId !== 'string' || !request.existingId.trim())) {
      return Promise.reject(new Error('自动保存的会话、版本或方案 ID 无效'));
    }
    let state = this.sessions.get(request.session);
    if (!state) {
      state = { id: request.existingId, latestRevision: -1, failed: false, waiters: [] };
      this.sessions.set(request.session, state);
    } else if (request.existingId !== undefined && state.id !== undefined && request.existingId !== state.id) {
      return Promise.reject(new Error('同一自动保存会话不能切换方案 ID'));
    }
    // The first request fixes the target. A later completion is the only other
    // source of an ID; a different session can never supply it.
    if (state.id === undefined && request.existingId !== undefined) {
      if (state.latestRevision >= 0) return Promise.reject(new Error('正在新建的自动保存会话不能更换目标方案'));
      state.id = request.existingId;
    }
    if (request.revision > state.latestRevision) {
      state.latestRevision = request.revision;
      state.pending = Object.freeze({ ...request });
    }
    if (state.failed) return Promise.reject(state.error);
    if (state.saved && state.saved.revision >= state.latestRevision) return Promise.resolve(state.saved);
    const promise = new Promise<VideoOverlaySaveResult>((resolve, reject) => state!.waiters.push({ revision: request.revision, resolve, reject }));
    if (state.pending) this.enqueue(request.session);
    this.start();
    return promise;
  }

  /** Drain runnable work, then report retained failures. An optional session
   * scopes the failure report; it does not cancel work from other sessions.
   */
  async flush(session?: string): Promise<void> {
    while (this.worker) await this.worker;
    const failed = [...this.sessions.entries()].filter(([key, state]) => state.failed && (session === undefined || key === session));
    if (failed.length) throw new AggregateError(failed.map(([, state]) => state.error), '仍有融合方案未保存，请重试');
  }

  /** Explicit retry only; no timers, backoff loop or implicit retry on editing. */
  retry(session?: string): Promise<void> {
    for (const [key, state] of this.sessions) {
      if ((session === undefined || key === session) && state.failed && state.pending) {
        state.failed = false; state.error = undefined; this.enqueue(key);
      }
    }
    this.start();
    return this.flush(session);
  }

  private enqueue(session: string) {
    if (this.queued.has(session)) return;
    this.queued.add(session); this.queue.push(session);
  }

  private start() {
    if (this.worker || !this.queue.length) return;
    this.worker = Promise.resolve().then(() => this.run()).finally(() => {
      this.worker = undefined;
      if (this.queue.length) this.start();
    });
  }

  private async run() {
    while (this.queue.length) {
      const session = this.queue.shift()!;
      this.queued.delete(session);
      const state = this.sessions.get(session)!;
      if (!state.pending || state.failed) continue;
      const pending = state.pending;
      state.pending = undefined;
      const request = Object.freeze({ ...pending, existingId: state.id });
      try {
        const id = await this.options.save(request);
        if (typeof id !== 'string' || !id.trim()) throw new Error('保存未返回有效的方案 ID');
        if (state.id !== undefined && id !== state.id) throw new Error('保存返回的方案 ID 与当前会话不一致');
        state.id = id;
        const result = Object.freeze({ session, revision: request.revision, id });
        state.saved = result;
        const waiters = state.waiters;
        state.waiters = waiters.filter(waiter => waiter.revision > request.revision);
        for (const waiter of waiters) if (waiter.revision <= request.revision) waiter.resolve(result);
        // Observers must not convert a committed upload into a failed retry or
        // retain its potentially large immutable file snapshot.
        try { void Promise.resolve(this.options.onSaved?.(result)).catch(() => {}); } catch { /* observer only */ }
      } catch (error) {
        state.pending ??= pending;
        state.error = error; state.failed = true;
        for (const waiter of state.waiters.splice(0)) waiter.reject(error);
        try { void Promise.resolve(this.options.onError?.(error, request)).catch(() => {}); } catch { /* observer only */ }
      }
    }
  }
}
