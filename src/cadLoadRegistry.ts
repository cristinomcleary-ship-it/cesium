/** Loading CAD belongs to the display directory, but is not a ready AR/model resource. */
export type PendingCadLoad = {
  readonly id: string;
  name: string;
  visible: boolean;
  status: string;
  resource?: { show: boolean; isDestroyed?: () => boolean };
  readonly signal: AbortSignal;
  /** Resolves after the owner has finished cancellation/cleanup, including pending saves. */
  readonly settled: Promise<void>;
};

export class CadLoadRegistry {
  private readonly loads = new Map<string, CadLoadTransaction>();
  constructor(private readonly changed: () => void = () => {}) {}
  values(): PendingCadLoad[] { return [...this.loads.values()]; }
  get(id: string): CadLoadTransaction | undefined { return this.loads.get(id); }
  begin(id: string, name: string, visible = true, controller = new AbortController()): CadLoadTransaction {
    if (this.loads.has(id)) throw new Error('此 CAD 正在加载，请等待或取消后重试');
    const load = new CadLoadTransaction(id, name, visible, controller, this.changed, () => {
      if (this.loads.get(id) === load) this.loads.delete(id);
    });
    this.loads.set(id, load); this.changed(); return load;
  }
  cancelAll(): void { for (const load of this.loads.values()) load.cancel(); }
}

export class CadLoadTransaction implements PendingCadLoad {
  status = '正在读取 CAD…';
  resource?: PendingCadLoad['resource'];
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;
  private cleanup?: () => void;
  private closed = false;
  constructor(readonly id: string, public name: string, public visible: boolean,
    private readonly controller: AbortController, private readonly changed: () => void, private readonly unregister: () => void) {
    this.signal = controller.signal;
    this.settled = new Promise(resolve => { this.resolveSettled = resolve; });
  }
  check(): void { if (this.signal.aborted || this.closed) throw new DOMException('CAD 加载已取消', 'AbortError'); }
  progress(status: string): void { if (!this.closed && !this.signal.aborted && this.status !== status) { this.status = status; this.changed(); } }
  attach(resource: NonNullable<PendingCadLoad['resource']>, cleanup: () => void): void {
    this.check(); this.resource = resource; this.cleanup = cleanup;
    resource.show = this.visible; this.changed();
  }
  cancel(): void {
    if (this.closed || this.signal.aborted) return;
    this.status = '正在取消加载…'; this.controller.abort();
    // Hide immediately; the loader owns destruction after its current update exits.
    if (this.resource && !this.resource.isDestroyed?.()) this.resource.show = false;
    this.changed();
  }
  /** Publish the ready resource synchronously before releasing this ID. */
  commit(publish: () => void): void {
    this.check(); publish(); this.cleanup = undefined; this.finish();
  }
  fail(): void {
    if (this.closed) return;
    try { this.cleanup?.(); } finally { this.cleanup = undefined; this.finish(); }
  }
  private finish(): void {
    this.closed = true; this.unregister(); this.resolveSettled(); this.changed();
  }
}
