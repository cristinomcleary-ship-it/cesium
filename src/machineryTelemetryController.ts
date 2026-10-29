import { loadMachineryAsset, type LoadedMachineryAsset } from './machinery/index';
import type { MachineryMetadata } from './machineryTypes';
import {
  MachineryTelemetryState, defaultMachineryTelemetryConfig,
  sourceBoomToCanonical, sourceHeadingToCanonical,
} from './machineryTelemetry';

export type TelemetryConfig = ReturnType<typeof defaultMachineryTelemetryConfig>;
type TelemetryFrame = Parameters<MachineryTelemetryState['apply']>[0];
export type TelemetryContext = {
  projectId: string; actorId?: string; canView: boolean; canEdit: boolean; active: boolean;
  records: ReadonlyArray<{ id: string; state: MachineryMetadata }>;
};
type Runtime = { engine: MachineryTelemetryState; asset: LoadedMachineryAsset; saved: string };
type Stored = { enabled: boolean; config: TelemetryConfig };
type ControllerOptions = {
  onLiveStatesChange: (states: ReadonlyMap<string, MachineryMetadata>) => void;
  onStatusChange?: () => void;
  fetcher?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  loadAsset?: (id: MachineryMetadata['assetId']) => Promise<LoadedMachineryAsset>;
};
const clone = <T>(value: T): T => structuredClone(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Runtime owned by the project, not by the selected editor. No timers exist while disabled. */
export class MachineryTelemetryController {
  private context: TelemetryContext = { projectId: '', records: [], canView: false, canEdit: false, active: false };
  private readonly runtime = new Map<string, Runtime>();
  private readonly configurations = new Map<string, Stored>();
  private readonly initializing = new Set<string>();
  private readonly activationTokens = new Map<string, number>();
  private readonly simulations = new Map<string, { timer?: ReturnType<typeof setTimeout>; step: number; initial: MachineryMetadata }>();
  private timer?: ReturnType<typeof setTimeout>;
  private abort = new AbortController();
  private polling = false;
  private generation = 0;
  private cursor = 0;
  private streamId = '';
  private disposed = false;
  private connection = '未启用';
  private readonly fetcher: typeof fetch;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(private readonly options: ControllerOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    try { this.storage = options.storage ?? globalThis.localStorage; } catch { /* session remains usable */ }
  }
  private key(id: string) { return `cesium:machinery-telemetry:v1:${encodeURIComponent(this.context.actorId ?? '')}:${encodeURIComponent(this.context.projectId)}:${encodeURIComponent(id)}`; }
  private stored(id: string): Stored {
    let item = this.configurations.get(id);
    if (!item) {
      item = { enabled: false, config: defaultMachineryTelemetryConfig(this.context.projectId, id) };
      try {
        const value = JSON.parse(this.storage?.getItem(this.key(id)) ?? 'null') as Stored | null;
        if (value?.config?.schemaVersion === 1 && value.config.projectId === this.context.projectId && value.config.resourceId === id && Array.isArray(value.config.bindings)) item = value;
      } catch { /* corrupt storage cannot enable an unvalidated runtime */ }
      this.configurations.set(id, item);
    }
    return item;
  }
  getConfig(id: string) { return clone(this.stored(id).config); }
  isEnabled(id: string) { return this.runtime.has(id); }
  isSimulating(id: string) { return this.simulations.has(id); }
  getState(id: string) { return this.runtime.get(id)?.engine.state; }
  getFieldStatus(id: string) { return this.runtime.get(id)?.engine.fieldStatus(Date.now()) ?? []; }
  get status() { return this.connection; }
  get enabledCount() { return this.runtime.size; }
  isBound(id: string, target: string) { return this.isEnabled(id) && this.stored(id).config.bindings.some(binding => binding.enabled && binding.target === target); }
  private persist(id: string) {
    try { this.storage?.setItem(this.key(id), JSON.stringify(this.stored(id))); }
    catch { this.connection = '配置仅本次会话有效：浏览器存储不可用'; }
  }
  setContext(next: TelemetryContext) {
    if (this.disposed) return;
    const reset = next.projectId !== this.context.projectId || next.actorId !== this.context.actorId || next.canView !== this.context.canView || next.active !== this.context.active;
    if (reset) this.clearRuntime();
    this.context = next;
    if (!next.canView || !next.active || !next.projectId) return;
    const records = new Map(next.records.map(record => [record.id, record]));
    let changed = false;
    for (const [id, value] of this.runtime) {
      const record = records.get(id);
      if (!record || value.asset.id !== record.state.assetId) { this.stopSimulation(id); this.runtime.delete(id); changed = true; continue; }
      const fingerprint = JSON.stringify(record.state);
      if (fingerprint !== value.saved) {
        try { value.engine.setManualState(record.state); value.saved = fingerprint; }
        catch (error) {
          this.stopSimulation(id); this.runtime.delete(id); this.stored(id).enabled = false; this.persist(id);
          this.connection = `机械 ${id} 的初始参数与关联数据不兼容，已停用关联：` + message(error);
        }
        changed = true;
      }
    }
    if (!next.canEdit) for (const id of this.simulations.keys()) this.stopSimulation(id);
    for (const record of next.records) if (!this.runtime.has(record.id) && !this.initializing.has(record.id) && this.stored(record.id).enabled) {
      this.initializing.add(record.id);
      const generation = this.generation;
      void this.activate(record.id, this.stored(record.id).config, false).catch(error => {
        if (generation === this.generation) { this.stored(record.id).enabled = false; this.persist(record.id); this.connection = '关联未恢复：' + message(error); this.options.onStatusChange?.(); }
      }).finally(() => { if (generation === this.generation) this.initializing.delete(record.id); });
    }
    if (changed) this.publish();
    this.schedule();
  }
  async configure(id: string, config: TelemetryConfig) {
    if (!this.context.canEdit) throw new Error('当前账号没有机械编辑权限');
    if (!config.bindings.some(binding => binding.enabled)) throw new Error('请至少勾选一个关联参数');
    await this.activate(id, config, true);
  }
  private async activate(id: string, config: TelemetryConfig, persist: boolean) {
    const generation = this.generation;
    const token = (this.activationTokens.get(id) ?? 0) + 1; this.activationTokens.set(id, token);
    const record = this.context.records.find(item => item.id === id);
    if (!record || !this.context.canView || !this.context.active) throw new Error('请先保存机械的初始模型和位置');
    if (config.projectId !== this.context.projectId || config.resourceId !== id) throw new Error('配置的项目或机械 ID 不匹配');
    const existing = this.runtime.get(id);
    const asset = existing?.asset ?? await (this.options.loadAsset?.(record.state.assetId) ?? loadMachineryAsset(record.state.assetId));
    if (this.disposed || generation !== this.generation || this.activationTokens.get(id) !== token) return;
    const current = this.context.records.find(item => item.id === id);
    if (!current || current.state.assetId !== record.state.assetId || !this.context.canView || !this.context.active || (persist && !this.context.canEdit)) throw new Error('机械资源或编辑权限已变更，请重新选择');
    // Validate with a fresh engine before changing the active configuration.
    const validator = new MachineryTelemetryState(asset, existing?.engine.state ?? current.state, config);
    if (existing) existing.engine.setConfig(config);
    this.runtime.set(id, existing ?? { engine: validator, asset, saved: JSON.stringify(current.state) });
    this.configurations.set(id, { enabled: true, config: clone(config) });
    if (persist) this.persist(id);
    this.connection = '等待数据；已启用 ' + this.runtime.size + ' 台机械';
    this.publish(); this.schedule(0);
  }
  disable(id: string) {
    const state = this.getState(id);
    this.activationTokens.set(id, (this.activationTokens.get(id) ?? 0) + 1);
    this.stopSimulation(id);
    this.runtime.delete(id);
    this.stored(id).enabled = false; this.persist(id);
    if (!this.runtime.size) {
      this.abort.abort(); this.abort = new AbortController();
      if (this.timer) clearTimeout(this.timer); this.timer = undefined;
      this.connection = '已停用；保持最后值可保存为手工参数';
    }
    this.publish(); return state;
  }
  setManualState(id: string, state: MachineryMetadata) {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    try { runtime.engine.setManualState(state); this.publish(); return true; }
    catch (error) { this.connection = '手工参数未应用：' + message(error); this.options.onStatusChange?.(); return false; }
  }
  resetManualState(id: string) {
    const saved = this.context.records.find(record => record.id === id)?.state;
    if (saved) this.setManualState(id, saved);
  }
  private publish() {
    this.options.onLiveStatesChange(new Map([...this.runtime].map(([id, runtime]) => [id, runtime.engine.state])));
    this.options.onStatusChange?.();
  }
  private schedule(delay = 1000) {
    if (this.disposed || !this.runtime.size || this.timer || this.polling) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, delay);
  }
  private async poll() {
    if (this.polling || !this.runtime.size || this.disposed) return;
    this.polling = true;
    const generation = this.generation, lifecycle = this.abort.signal;
    const request = new AbortController();
    const cancel = () => request.abort(); lifecycle.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => request.abort(new Error('接口等待超过 5 秒')), 5000);
    const signal = request.signal;
    const query = new URLSearchParams({ projectId: this.context.projectId, after: String(this.cursor), streamId: this.streamId });
    try {
      const response = await this.fetcher('/__management/machinery-telemetry?' + query, { credentials: 'same-origin', signal });
      const data = await response.json();
      if (signal.aborted || generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        for (const id of this.runtime.keys()) { this.stored(id).enabled = false; this.persist(id); }
        this.clearRuntime(); this.connection = '访问权限已变更，已停止接收并清空实时状态'; this.options.onStatusChange?.(); return;
      }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.schemaVersion !== 1 || data.projectId !== this.context.projectId || !Array.isArray(data.frames) || !Number.isSafeInteger(data.cursor) || typeof data.streamId !== 'string') throw new Error('返回数据格式不正确');
      this.cursor = data.cursor; this.streamId = data.streamId;
      let changed = false, rejected = 0;
      const batches = new Map<string, TelemetryFrame[]>();
      for (const frame of data.frames as TelemetryFrame[]) {
        if (!this.runtime.has(frame.resourceId)) continue;
        const batch = batches.get(frame.resourceId) ?? []; batch.push(frame); batches.set(frame.resourceId, batch);
      }
      for (const [id, frames] of batches) {
        try { const result = this.runtime.get(id)!.engine.applyBatch(frames); changed ||= result.changed; if (!result.accepted) rejected++; }
        catch { rejected++; }
      }
      this.connection = `接口已连接 · ${this.runtime.size} 台机械` + (data.reset ? ' · 数据流已重置或存在历史缺口，已从可用数据恢复' : '') + (rejected ? ` · ${rejected} 组数据未接受，请查看参数状态` : '') + (data.externalConfigurationError?.message ? ' · 外部接入配置错误：' + String(data.externalConfigurationError.message) : '');
      if (changed) this.publish(); else this.options.onStatusChange?.();
    } catch (error) {
      if (!lifecycle.aborted && generation === this.generation) { this.connection = '连接中断：' + (signal.aborted ? '接口等待超过 5 秒' : message(error)) + '；保留最后有效姿态'; this.options.onStatusChange?.(); }
    } finally {
      clearTimeout(timeout); lifecycle.removeEventListener('abort', cancel);
      this.polling = false;
      this.schedule();
    }
  }
  sampleFrame(id: string) {
    const runtime = this.runtime.get(id);
    const state = runtime?.engine.state ?? this.context.records.find(record => record.id === id)?.state;
    if (!state) throw new Error('请先保存初始机械模型');
    const config = this.getConfig(id), sourceId = config.bindings.find(binding => binding.enabled)?.sourceId ?? 'browser-sim';
    return { schemaVersion: 1, projectId: this.context.projectId, resourceId: id, sourceId, timestamp: new Date().toISOString(), values: this.simulationValues(id, state, 0, sourceId), mode: 'simulated' };
  }
  private simulationValues(id: string, initial: MachineryMetadata, step: number, sourceId: string) {
    const runtime = this.runtime.get(id), config = this.getConfig(id), values: Record<string, number> = {};
    for (const binding of config.bindings) {
      if (!binding.enabled || binding.sourceId !== sourceId || !binding.scale) continue;
      let value = binding.target in initial.placement ? initial.placement[binding.target as keyof MachineryMetadata['placement']] : initial.parameters[binding.target];
      if (runtime && binding.target === 'boom_rotation_deg') value = sourceBoomToCanonical(runtime.asset, value, config.modelFrontAxisDeg);
      if (binding.target === 'heading') value = sourceHeadingToCanonical(value, config.modelFrontAxisDeg);
      const wave = Math.sin(step / 12);
      if (binding.target === 'longitude' || binding.target === 'latitude') value += wave * 0.000005;
      else if (binding.target === 'heading' || binding.target === 'boom_rotation_deg') value = ((value + step * 2) % 360 + 360) % 360;
      else if (binding.target === 'boom_elevation_deg') value = Math.max(10, Math.min(85, value + wave * 8));
      else if (binding.target !== 'height') value *= 1 + wave * 0.05;
      values[binding.sourceField] = (value - binding.offset) / binding.scale;
    }
    return values;
  }
  async sendFrame(value: unknown) {
    if (!this.context.canEdit || !this.context.active) throw new Error('当前状态不可发送测试数据');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请填写一帧 JSON 对象');
    const frame = value as Record<string, unknown>;
    if (frame.projectId !== this.context.projectId || typeof frame.resourceId !== 'string' || !this.context.records.some(record => record.id === frame.resourceId)) throw new Error('项目或机械 ID 不匹配');
    const generation = this.generation, lifecycle = this.abort.signal;
    const request = new AbortController();
    const cancel = () => request.abort(); lifecycle.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => request.abort(new Error('发送等待超过 5 秒')), 5000);
    const signal = request.signal;
    try {
      const response = await this.fetcher('/__management/machinery-telemetry', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json', 'x-cesium-library': '1' },
        body: JSON.stringify({ ...frame, mode: 'simulated' }),
      });
      const data = await response.json();
      if (signal.aborted || generation !== this.generation) return;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    } finally { clearTimeout(timeout); lifecycle.removeEventListener('abort', cancel); }
    // Rendering always consumes GET, including simulation: tests exercise the actual delivery path.
    this.connection = '模拟帧已发送，等待接口回传'; this.options.onStatusChange?.(); this.schedule(0);
  }
  startSimulation(id: string) {
    if (!this.runtime.has(id)) throw new Error('请先启用参数关联');
    if (!this.getConfig(id).bindings.some(binding => binding.enabled && binding.sourceId === 'browser-sim')) throw new Error('模拟器只发送 browser-sim 来源；请将测试参数来源设为 browser-sim');
    this.stopSimulation(id);
    const simulation = { step: 0, initial: this.runtime.get(id)!.engine.state, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.simulations.set(id, simulation);
    const generation = this.generation;
    const tick = async () => {
      if (generation !== this.generation || this.simulations.get(id) !== simulation) return;
      try {
        await this.sendFrame({ schemaVersion: 1, projectId: this.context.projectId, resourceId: id, sourceId: 'browser-sim', timestamp: new Date().toISOString(), values: this.simulationValues(id, simulation.initial, simulation.step++, 'browser-sim'), mode: 'simulated' });
      } catch (error) { if (generation === this.generation) { this.connection = '模拟发送失败：' + message(error); this.stopSimulation(id); this.options.onStatusChange?.(); } return; }
      if (generation === this.generation && this.simulations.get(id) === simulation) simulation.timer = setTimeout(() => { void tick(); }, 1000);
    };
    void tick(); this.options.onStatusChange?.();
  }
  stopSimulation(id: string) {
    const simulation = this.simulations.get(id);
    if (simulation?.timer) clearTimeout(simulation.timer);
    this.simulations.delete(id); this.options.onStatusChange?.();
  }
  private clearRuntime() {
    ++this.generation; this.abort.abort(); this.abort = new AbortController();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const id of this.simulations.keys()) this.stopSimulation(id);
    this.runtime.clear(); this.configurations.clear(); this.initializing.clear(); this.activationTokens.clear();
    this.cursor = 0; this.streamId = ''; this.connection = '未启用'; this.publish();
  }
  destroy() { if (this.disposed) return; this.clearRuntime(); this.disposed = true; }
}
