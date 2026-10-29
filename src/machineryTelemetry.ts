import { resolveMachineryParameters } from './machinery/engine';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { validateMachineryMetadata } from './machineryValidation';

/** Wire values are metres and degrees after binding scale/offset conversion. */
export type MachineryTelemetryFrame = {
  schemaVersion: 1; projectId: string; resourceId: string; sourceId: string;
  timestamp: string; mode: 'measured' | 'simulated'; values: Record<string, number>;
};
export type MachineryTelemetryBinding = {
  target: string; enabled: boolean; sourceId: string; sourceField: string; scale: number; offset: number;
};
export type MachineryTelemetryConfig = {
  schemaVersion: 1; projectId: string; resourceId: string; bindings: MachineryTelemetryBinding[];
  staleAfterMs: number; maxAgeMs: number; futureToleranceMs: number;
  /** Clockwise source-local angle from +X towards +Z to the machine's front.
   * Current crane source cab is on +X. Other assets retain their source reference
   * until a physical front is calibrated; this value is a model adapter, not sensor bias. */
  modelFrontAxisDeg: number;
};
export type MachineryTelemetryFieldStatus = {
  target: string; sourceId: string; sourceField: string; status: 'waiting' | 'fresh' | 'stale';
  ageMs: number | null; value: number; mode?: MachineryTelemetryFrame['mode']; lastError?: string;
};
export type MachineryTelemetryResult = {
  accepted: boolean; changed: boolean; state: MachineryMetadata;
  updatedFields: string[]; rejectedFields: string[]; message: string;
};
const placementFields = new Set(['longitude', 'latitude', 'height', 'heading']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function wrapMachineryAngle(value: number): number {
  if (!finite(value)) throw new RangeError('角度必须是有限数值');
  return ((value % 360) + 360) % 360;
}
function sourceBoomYaw(asset: LoadedMachineryAsset): number {
  if (asset.config.type !== 'crane') throw new RangeError('此机械不支持吊臂相对回转');
  const [x, , z] = asset.config.boom.axis;
  return Math.atan2(z, x) * 180 / Math.PI;
}
/** User zero: boom points directly away from the front, both on chassis longitudinal axis. */
export function canonicalBoomToSource(asset: LoadedMachineryAsset, angle: number, modelFrontAxisDeg = 0): number {
  return wrapMachineryAngle(modelFrontAxisDeg + 180 + angle - sourceBoomYaw(asset));
}
export function sourceBoomToCanonical(asset: LoadedMachineryAsset, angle: number, modelFrontAxisDeg = 0): number {
  return wrapMachineryAngle(angle + sourceBoomYaw(asset) - modelFrontAxisDeg - 180);
}
/** Physical front geographic bearing is clockwise from north. Stored heading remains source +X. */
export function canonicalHeadingToSource(angle: number, modelFrontAxisDeg = 0): number {
  return wrapMachineryAngle(angle - modelFrontAxisDeg);
}
export function sourceHeadingToCanonical(angle: number, modelFrontAxisDeg = 0): number {
  return wrapMachineryAngle(angle + modelFrontAxisDeg);
}
export function defaultMachineryTelemetryConfig(projectId: string, resourceId: string): MachineryTelemetryConfig {
  return { schemaVersion: 1, projectId, resourceId, bindings: [], staleAfterMs: 5000,
    maxAgeMs: 60_000, futureToleranceMs: 5000, modelFrontAxisDeg: 0 };
}
export function machineryTelemetryFields(asset: LoadedMachineryAsset): { key: string; label: string; unit: string }[] {
  const fields = [
    { key: 'longitude', label: '经度（WGS84）', unit: '°' },
    { key: 'latitude', label: '纬度（WGS84）', unit: '°' },
    { key: 'height', label: '站位椭球高', unit: 'm' },
    { key: 'heading', label: '整机方位角', unit: '°' },
  ];
  // Scale and body height drive other dimensions. A crane's total height is derived
  // from its pose and cannot be independently controlled together with its boom.
  const allowed = asset.id === 'crane'
    ? ['boom_length_m', 'boom_elevation_deg', 'boom_rotation_deg', 'outrigger_lateral_m', 'outrigger_longitudinal_m']
    : asset.id === 'pile' ? ['total_height_m'] : ['overall_height_m'];
  for (const key of allowed) {
    const definition = asset.config.parameters.find(p => p.key === key);
    if (definition) fields.push({ key, label: definition.label, unit: definition.unit });
  }
  return fields;
}
function checkedConfig(asset: LoadedMachineryAsset, config: MachineryTelemetryConfig): MachineryTelemetryConfig {
  if (!config || config.schemaVersion !== 1 || typeof config.projectId !== 'string' || !config.projectId
    || typeof config.resourceId !== 'string' || !config.resourceId || !Array.isArray(config.bindings)) throw new Error('机械传感器关联配置无效');
  if (![config.staleAfterMs, config.maxAgeMs, config.futureToleranceMs, config.modelFrontAxisDeg].every(finite)
    || config.staleAfterMs <= 0 || config.maxAgeMs < config.staleAfterMs || config.futureToleranceMs < 0) throw new Error('传感器超时或角度校准配置无效');
  const allowed = new Set(machineryTelemetryFields(asset).map(f => f.key)), used = new Set<string>();
  for (const b of config.bindings) {
    if (!b || !allowed.has(b.target) || used.has(b.target) || typeof b.enabled !== 'boolean'
      || typeof b.sourceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(b.sourceId)
      || typeof b.sourceField !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(b.sourceField)
      || ['__proto__', 'constructor', 'prototype'].includes(b.sourceField)
      || !finite(b.scale) || b.scale === 0 || !finite(b.offset)) throw new Error('传感器字段绑定无效或重复');
    used.add(b.target);
  }
  return structuredClone(config);
}
type Clock = { timestamp: number; mode: MachineryTelemetryFrame['mode'] };
/** One resource, one authoritative resolved pose; consumers share the returned snapshot.
 * Sensor traffic does not mutate saved business metadata or the caller's source arrays. */
export class MachineryTelemetryState {
  private current: MachineryMetadata;
  private config: MachineryTelemetryConfig;
  private readonly clocks = new Map<string, Clock>();
  private readonly errors = new Map<string, string>();
  private readonly sourceModes = new Map<string, MachineryTelemetryFrame['mode']>();
  constructor(private readonly asset: LoadedMachineryAsset, initialState: MachineryMetadata, config: MachineryTelemetryConfig) {
    this.current = validateMachineryMetadata(initialState);
    if (asset.id !== this.current.assetId) throw new Error('机械资产与初始参数不一致');
    this.config = checkedConfig(asset, config);
    // Verify geometry too, before the first incoming packet.
    resolveMachineryParameters(asset, this.current.parameters, {}, { proportional: false });
  }
  get state(): MachineryMetadata { return structuredClone(this.current); }
  get settings(): MachineryTelemetryConfig { return structuredClone(this.config); }
  setConfig(config: MachineryTelemetryConfig): void {
    const next = checkedConfig(this.asset, config);
    if (next.projectId !== this.config.projectId || next.resourceId !== this.config.resourceId) throw new Error('不得切换运行实例所属项目或机械');
    for (const old of this.config.bindings) {
      const current = next.bindings.find(b => b.target === old.target);
      if (JSON.stringify(old) !== JSON.stringify(current) || next.modelFrontAxisDeg !== this.config.modelFrontAxisDeg) {
        this.clocks.delete(old.target); this.errors.delete(old.target);
      }
    }
    this.config = next;
    // Disabling a binding keeps its last numeric value, now editable manually.
    const activeSources = new Set(next.bindings.filter(b => b.enabled).map(b => b.sourceId));
    for (const source of this.sourceModes.keys()) if (!activeSources.has(source)) this.sourceModes.delete(source);
  }
  /** Update manual inputs while retaining currently bound channels, including waiting ones. */
  setManualState(state: MachineryMetadata): void {
    const next = validateMachineryMetadata(state);
    if (next.assetId !== this.current.assetId) throw new Error('更换机械类型时须新建传感器运行实例');
    const retained: Record<string, number> = {};
    for (const b of this.config.bindings.filter(b => b.enabled)) {
      if (placementFields.has(b.target)) next.placement[b.target as keyof typeof next.placement] = this.current.placement[b.target as keyof typeof next.placement];
      else retained[b.target] = this.current.parameters[b.target];
    }
    next.parameters = resolveMachineryParameters(this.asset, next.parameters, retained, { proportional: false });
    this.current = validateMachineryMetadata(next);
  }
  value(target: string): number {
    if (target === 'heading') return sourceHeadingToCanonical(this.current.placement.heading, this.config.modelFrontAxisDeg);
    if (target === 'boom_rotation_deg') return sourceBoomToCanonical(this.asset, this.current.parameters[target], this.config.modelFrontAxisDeg);
    return placementFields.has(target) ? this.current.placement[target as keyof MachineryMetadata['placement']] : this.current.parameters[target];
  }
  fieldStatus(now = Date.now()): MachineryTelemetryFieldStatus[] {
    return this.config.bindings.filter(b => b.enabled).map(b => {
      const clock = this.clocks.get(b.target), ageMs = clock ? Math.max(0, now - clock.timestamp) : null;
      return { target: b.target, sourceId: b.sourceId, sourceField: b.sourceField,
        status: !clock ? 'waiting' : ageMs! > this.config.staleAfterMs ? 'stale' : 'fresh',
        ageMs, value: this.value(b.target), mode: clock?.mode, lastError: this.errors.get(b.target) };
    });
  }
  /** Coalesce a transport poll by source channel, retaining each channel's acquisition
   * time. Partial packets therefore cannot erase another channel. Intermediate poses
   * are intentionally skipped; model geometry is resolved once per source, not per
   * packet. Invalid latest geometry keeps the previous complete valid pose. */
  applyBatch(frames: readonly MachineryTelemetryFrame[], now = Date.now()): MachineryTelemetryResult {
    const groups = new Map<string, { frame: MachineryTelemetryFrame; clocks: Map<string, number> }>();
    const rejected = new Set<string>(), messages: string[] = [];
    for (const frame of frames) {
      if (!frame || frame.projectId !== this.config.projectId || frame.resourceId !== this.config.resourceId) continue;
      const bindings = this.config.bindings.filter(b => b.enabled && b.sourceId === frame.sourceId);
      if (!bindings.length) continue;
      const timestamp = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : NaN;
      // Let the normal gate produce its precise error; no geometry is reached for
      // these malformed/expired frames.
      if (frame.schemaVersion !== 1 || !finite(timestamp)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(frame.timestamp)
        || new Date(timestamp).toISOString().slice(0, 19) !== frame.timestamp.slice(0, 19)
        || timestamp < now - this.config.maxAgeMs || timestamp > now + this.config.futureToleranceMs
        || !['measured', 'simulated'].includes(frame.mode)
        || !frame.values || typeof frame.values !== 'object' || Array.isArray(frame.values)
        || Object.values(frame.values).some(value => !finite(value))) {
        const failure = this.apply(frame, now); failure.rejectedFields.forEach(f => rejected.add(f)); messages.push(failure.message); continue;
      }
      const key = `${frame.sourceId}:${frame.mode}`;
      let group = groups.get(key);
      for (const b of bindings) {
        if (!Object.hasOwn(frame.values, b.sourceField)) continue;
        const previous = this.clocks.get(b.target)?.timestamp ?? -Infinity;
        if (timestamp <= previous) {
          rejected.add(b.target); this.errors.set(b.target, '重复或乱序数据已忽略'); continue;
        }
        if (!group) {
          group = { frame: { ...frame, values: {} }, clocks: new Map() }; groups.set(key, group);
        }
        if (timestamp <= (group.clocks.get(b.sourceField) ?? -Infinity)) continue;
        group.frame.values[b.sourceField] = frame.values[b.sourceField];
        group.clocks.set(b.sourceField, timestamp);
        if (timestamp > Date.parse(group.frame.timestamp)) group.frame.timestamp = frame.timestamp;
      }
    }
    let accepted = false, changed = false;
    const updated = new Set<string>();
    for (const group of groups.values()) {
      const result = this.applyFrame(group.frame, now, group.clocks);
      accepted ||= result.accepted; changed ||= result.changed;
      result.rejectedFields.forEach(f => rejected.add(f)); messages.push(result.message);
      for (const target of result.updatedFields) {
        updated.add(target); rejected.delete(target);
      }
    }
    return { accepted, changed, state: this.state, updatedFields: [...updated], rejectedFields: [...rejected],
      message: messages.at(-1) ?? '没有可应用的关联数据，保持当前姿态' };
  }
  apply(frame: MachineryTelemetryFrame, now = Date.now()): MachineryTelemetryResult {
    return this.applyFrame(frame, now);
  }
  private applyFrame(frame: MachineryTelemetryFrame, now: number, sourceTimes?: ReadonlyMap<string, number>): MachineryTelemetryResult {
    const result = (accepted: boolean, updatedFields: string[], rejectedFields: string[], message: string, changed = false): MachineryTelemetryResult =>
      ({ accepted, changed, state: this.state, updatedFields, rejectedFields, message });
    if (!frame || frame.schemaVersion !== 1 || frame.projectId !== this.config.projectId || frame.resourceId !== this.config.resourceId)
      return result(false, [], [], '项目或机械编号不匹配');
    const bindings = this.config.bindings.filter(b => b.enabled && b.sourceId === frame.sourceId);
    if (!bindings.length) return result(false, [], [], '此来源未关联参数');
    const reject = (message: string, fields = bindings.map(b => b.target)) => {
      for (const field of fields) this.errors.set(field, message);
      return result(false, [], fields, message);
    };
    if (!finite(now) || typeof frame.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(frame.timestamp)) return reject('采集时间必须是 UTC ISO 时间');
    const timestamp = Date.parse(frame.timestamp);
    if (!finite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== frame.timestamp.slice(0, 19)) return reject('采集时间无效');
    if (timestamp < now - this.config.maxAgeMs) return reject('采集数据过旧');
    if (timestamp > now + this.config.futureToleranceMs) return reject('采集时间超前，请校准设备时钟');
    if (frame.mode !== 'measured' && frame.mode !== 'simulated') return reject('数据模式无效');
    const previousMode = this.sourceModes.get(frame.sourceId);
    if (previousMode && previousMode !== frame.mode) return reject('同一来源不能混用模拟和实测数据，请使用不同来源编号');
    if (!frame.values || typeof frame.values !== 'object' || Array.isArray(frame.values)
      || Object.entries(frame.values).some(([, value]) => !finite(value))) return reject('数据字段必须是有限数值，不能是空值或字符串');
    const next = this.state, patch: Record<string, number> = {}, updated: string[] = [], rejected: string[] = [];
    for (const binding of bindings) {
      if (!Object.hasOwn(frame.values, binding.sourceField)) continue;
      const fieldTime = sourceTimes?.get(binding.sourceField) ?? timestamp;
      const previous = this.clocks.get(binding.target);
      if (previous && fieldTime <= previous.timestamp) {
        this.errors.set(binding.target, '重复或乱序数据已忽略'); rejected.push(binding.target); continue;
      }
      let value = frame.values[binding.sourceField] * binding.scale + binding.offset;
      if (!finite(value)) return reject('单位换算结果不是有限数值');
      if (binding.target === 'heading') value = canonicalHeadingToSource(value, this.config.modelFrontAxisDeg);
      if (binding.target === 'boom_rotation_deg') value = canonicalBoomToSource(this.asset, value, this.config.modelFrontAxisDeg);
      if (placementFields.has(binding.target)) next.placement[binding.target as keyof typeof next.placement] = value;
      else patch[binding.target] = value;
      updated.push(binding.target);
    }
    if (!updated.length) return result(false, [], rejected, rejected.length ? '重复或乱序数据已忽略' : '报文不含已关联字段，保持当前姿态');
    try {
      if (Object.keys(patch).length) next.parameters = resolveMachineryParameters(this.asset, next.parameters, patch, { proportional: false });
      const resolved = validateMachineryMetadata(next);
      const changed = JSON.stringify(resolved) !== JSON.stringify(this.current);
      this.current = resolved;
      for (const field of updated) {
        const binding = bindings.find(b => b.target === field)!;
        this.clocks.set(field, { timestamp: sourceTimes?.get(binding.sourceField) ?? timestamp, mode: frame.mode }); this.errors.delete(field);
      }
      this.sourceModes.set(frame.sourceId, frame.mode);
      return result(true, updated, rejected, `已更新 ${updated.length} 个关联参数`, changed);
    } catch (error) {
      return reject(`整帧未应用：${error instanceof Error ? error.message : String(error)}`, updated);
    }
  }
}
