import type { Model, Viewer } from 'cesium';
import type { EngineeringBinding } from './catalog';
import type { EngineeringComponentState } from './state';
import { EngineeringFootprintClient } from './footprintClient';
import { EngineeringPhotographyOcclusion, type EngineeringPhotographyTarget } from './photography';
import { engineeringRuntimeNodeTransforms, engineeringWorldFromGltf } from './projectionPose';

export type EngineeringNamedPhotographyTarget = EngineeringPhotographyTarget & { name: string };
type Options = {
  viewer: Viewer; model: Model; bytes: ArrayBuffer; bindings: readonly EngineeringBinding[];
  state: EngineeringComponentState; getTargets(): EngineeringNamedPhotographyTarget[]; canMutate(): boolean;
  onTargets(items: EngineeringNamedPhotographyTarget[], selected: string, enabled: boolean): void;
  onStatus(message: string, error?: boolean, busy?: boolean): void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Coordinates cancellable geometry jobs with the existing photograph owner.
 * Display flags and Model.show never enter the desired clipping selection. */
export class EngineeringPhotographyController {
  private client?: EngineeringFootprintClient;
  private clipping?: EngineeringPhotographyOcclusion;
  private targetId = '';
  private enabled = true;
  private suspended = false;
  private accessPaused = false;
  private disposed = false;
  private ids: string[] = [];
  private flagsKey = '';
  private targetsKey = '';
  private attemptedKey = '';
  private attemptedTarget?: EngineeringPhotographyTarget['tileset'];
  private appliedPose = '';
  private appliedTarget?: EngineeringPhotographyTarget['tileset'];
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private readonly storageKey: string;
  private reported?: { message: string; error: boolean; busy: boolean };

  constructor(private readonly options: Options) {
    this.storageKey = `${options.state.storageKey}:photography:v1`;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        if (raw.length > 4096) throw new Error('摄影关联记录过大');
        const value = JSON.parse(raw);
        if (value?.version !== 1 || typeof value.targetId !== 'string' || typeof value.enabled !== 'boolean'
          || Object.keys(value).some(key => !['version', 'targetId', 'enabled'].includes(key))) throw new Error('摄影关联记录无效');
        this.targetId = value.targetId; this.enabled = value.enabled;
      }
    } catch (error) { this.report(`旧摄影关联未恢复：${errorText(error)}`, true); }
    this.updateFlags();
  }

  get status() { return { targetId: this.targetId, enabled: this.enabled, busy: !!(this.request || this.timer), componentCount: this.ids.length, clipping: this.clipping?.status }; }

  select(targetId: string, enabled: boolean) {
    if (this.disposed || !this.options.canMutate()) return;
    if (targetId && !this.options.getTargets().some(target => target.id === targetId && !target.tileset.isDestroyed())) return;
    this.targetId = targetId; this.enabled = enabled;
    try { localStorage.setItem(this.storageKey, JSON.stringify({ version: 1, targetId, enabled })); }
    catch { this.report('摄影关联自动保存失败，本次选择仍然生效。', true); }
    this.retry();
  }

  updateFlags() {
    if (this.disposed) return;
    const ids = this.options.bindings.filter(binding => this.options.state.get(binding.componentId).occlusionEnabled).map(binding => binding.componentId);
    const key = JSON.stringify(ids);
    if (this.flagsKey !== key) { this.ids = ids; this.flagsKey = key; this.attemptedKey = ''; }
    this.check();
  }

  /** Invoked by the host's existing frame guard: only target identity and 16
   * placement values are inspected; GLB parsing and union run in the worker. */
  check() {
    if (this.disposed) return;
    const targets = this.options.getTargets().filter(value => !value.tileset.isDestroyed());
    const targetsKey = JSON.stringify([targets.map(value => [value.id, value.name]), this.targetId, this.enabled]);
    if (targetsKey !== this.targetsKey) { this.targetsKey = targetsKey; this.options.onTargets(targets, this.targetId, this.enabled); }
    if (!this.options.canMutate() || this.suspended) {
      this.accessPaused = true; this.abortPending(); this.clipping?.setSuspended(true);
      this.report(this.suspended ? '工程摄影遮挡暂时停用，退出当前模式后恢复。' : '当前访问权限不可用，工程摄影遮挡已暂停。');
      return;
    }
    // A permission gate can pause a completed contribution without changing its
    // pose/key. Force fresh validation on access restoration so that identical
    // keys cannot leave the valid contribution permanently suspended.
    if (this.accessPaused) { this.accessPaused = false; this.attemptedKey = ''; }
    const target = targets.find(value => value.id === this.targetId);
    if (!this.enabled || !target || !this.ids.length) {
      this.abortPending(); this.clear(); this.attemptedKey = '';
      this.report(!this.enabled ? '工程摄影遮挡已关闭。' : !this.targetId ? '请选择关联的倾斜摄影，再勾选构件遮挡。'
        : !target ? '关联摄影未加载或无访问权限，工程摄影遮挡已撤销。' : '关联摄影已就绪，当前没有勾选遮挡构件。');
      return;
    }
    let matrix: number[];
    try { matrix = engineeringWorldFromGltf(this.options.model); }
    catch (error) { this.abortPending(); this.clear(); this.report(errorText(error), true); return; }
    const pose = matrix.join(',');
    // Moving invalidates the old world footprint immediately. A target change
    // can retain an authorized old contribution until the new result commits;
    // a failed geometry job must not silently remove that previous result.
    if (this.appliedPose && (this.appliedPose !== pose || !targets.some(value => value.tileset === this.appliedTarget))) this.clear();
    const key = `${this.flagsKey}|${pose}|${target.id}`;
    if (key === this.attemptedKey && this.attemptedTarget === target.tileset) return;
    this.abortPending(); this.attemptedKey = key; this.attemptedTarget = target.tileset;
    const epoch = this.epoch, ids = [...this.ids];
    this.report(`准备计算 ${ids.length.toLocaleString()} 个构件的摄影遮挡轮廓…`, false, true);
    this.timer = setTimeout(() => { this.timer = undefined; void this.project(target, matrix, pose, ids, epoch); }, 120);
  }

  private async project(target: EngineeringNamedPhotographyTarget, matrix: number[], pose: string, ids: string[], epoch: number) {
    if (this.disposed || epoch !== this.epoch || !this.options.canMutate() || this.suspended) return;
    const request = new AbortController(); this.request = request;
    const current = () => !this.disposed && epoch === this.epoch && !request.signal.aborted && this.options.canMutate() && !this.suspended
      && this.options.getTargets().some(value => value.id === target.id && value.tileset === target.tileset && !value.tileset.isDestroyed())
      && engineeringWorldFromGltf(this.options.model).join(',') === pose;
    try {
      this.client ??= new EngineeringFootprintClient(this.options.bytes, this.options.bindings,
        engineeringRuntimeNodeTransforms(this.options.model, this.options.bindings));
      const result = await this.client.project(matrix, ids, request.signal, message => {
        if (epoch === this.epoch && !this.disposed) this.report(message, false, true);
      });
      if (!current()) return;
      this.clipping ??= new EngineeringPhotographyOcclusion(this.options.viewer, { onStatus: status => {
        if (!this.disposed && !this.request && !this.timer) this.report(status.message, status.state === 'blocked' || status.state === 'unsupported');
      } });
      this.clipping.setSuspended(false);
      this.clipping.apply(target, result.footprints);
      this.appliedPose = pose; this.appliedTarget = target.tileset;
      const status = this.clipping.status;
      this.report(`${status.message} ${result.componentCount.toLocaleString()} 个构件，${result.triangleCount.toLocaleString()} 个原始三角面。`, status.state === 'blocked' || status.state === 'unsupported');
    } catch (error) {
      if (!this.disposed && epoch === this.epoch && !request.signal.aborted) this.report(`摄影遮挡未更新：${errorText(error)}`, true);
    } finally { if (this.request === request) this.request = undefined; }
  }

  retry() { if (this.disposed) return; this.attemptedKey = ''; this.check(); }
  cancel() { if (this.disposed) return; this.abortPending(); this.report('轮廓计算已取消；同一位置已生效的遮挡保持原状。'); }
  private abortPending() { this.epoch++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.request?.abort(); this.request = undefined; }
  private clear() {
    if (!this.appliedPose && !this.appliedTarget) return;
    try { this.clipping?.clear(); }
    finally { this.appliedPose = ''; this.appliedTarget = undefined; }
  }
  private report(message: string, error = false, busy = false) {
    if (this.reported?.message === message && this.reported.error === error && this.reported.busy === busy) return;
    this.reported = { message, error, busy };
    try { this.options.onStatus(message, error, busy); }
    catch (failure) { console.warn('[Engineering photography] Interface status failed', failure); }
  }
  setSuspended(value: boolean) {
    if (this.disposed || value === this.suspended) return;
    this.abortPending();
    try { this.clipping?.setSuspended(value); }
    catch (error) {
      this.attemptedKey = ''; this.report(`工程摄影遮挡模式切换失败：${errorText(error)}`, true);
      throw error;
    }
    this.suspended = value;
    if (!value) this.retry();
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.abortPending(); this.client?.dispose(); this.clipping?.dispose(); }
}
