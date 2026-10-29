import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { validateMachineryMetadata } from './machineryValidation';
import { sourceBoomToCanonical, sourceHeadingToCanonical, type MachineryTelemetryFieldStatus } from './machineryTelemetry';

export type MachineryPoseSource = 'manual' | 'measured' | 'simulated';
export type MachineryPoseProvenance = {
  source: MachineryPoseSource; sourceId?: string; sourceField?: string; sampleTimestamp?: string | null;
};
export type MachineryPoseSnapshot = {
  projectId: string; resourceId: string; resourceName: string; asset: LoadedMachineryAsset;
  /** User-facing identifier captured with this observation; legacy records may lack it. */
  equipmentCode?: string;
  /** The existing source-coordinate model state; conversion happens exactly once here. */
  state: MachineryMetadata; modelFrontAxisDeg?: number;
  provenance?: Readonly<Record<string, MachineryPoseProvenance>>;
};
export type MachineryPoseChange = {
  field: string; label: string; unit: string; previous: number | boolean | null; value: number | boolean;
  source: MachineryPoseSource | 'mixed'; samples: MachineryPoseProvenance[]; description: string;
  derivedFrom?: string[];
};
export type MachineryPoseEntry = {
  sequence: number; kind: 'initial' | 'change'; projectId: string; resourceId: string;
  resourceName: string; assetId: MachineryMetadata['assetId']; recordedAt: string; localTime: string;
  equipmentCode?: string;
  timeZone: string; modelFrontAxisDeg: number; changes: MachineryPoseChange[]; description: string;
};
export type MachineryPoseArchive = {
  schemaVersion: 1; type: 'machinery-pose-history';
  angleConvention: 'heading-north-clockwise;boom-away-from-front-zero-clockwise';
  entries: MachineryPoseEntry[];
};
export type MachineryPoseRecorderOptions = {
  maxEntries?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
  /** Use a distinct account/project key. A recorder never changes this key itself. */
  storageKey?: string;
  now?: () => number;
  timeZone?: string;
};
export type MachineryPoseHistoryFilter = {
  resourceId?: string;
  /** Inclusive UTC/offset-qualified instants. Blank bounds include all available history. */
  from?: string; to?: string;
};
type Field = { value: number | boolean; label: string; unit: string };
type HistoryIndex = { schemaVersion: 2; type: 'machinery-pose-history-index'; generation: string; blockSize: 50; count: number; lastSequence: number };
const BLOCK_SIZE = 50, MAX_HISTORY_ENTRIES = 10000, MAX_BLOCK_BYTES = 1024 * 1024;
const newGeneration = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clone = <T>(value: T): T => structuredClone(value);
const sourceLabels = { manual: '人工', measured: '实测', simulated: '模拟', mixed: '混合' };
const assetLabels = { crane: '吊机', pile: '桩机', excavator: '挖机' };
const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const archive = (entries: MachineryPoseEntry[]): MachineryPoseArchive => ({ schemaVersion: 1, type: 'machinery-pose-history',
  angleConvention: 'heading-north-clockwise;boom-away-from-front-zero-clockwise', entries });
function validEntry(value: unknown, expectedSequence: number): value is MachineryPoseEntry {
  const entry = value as MachineryPoseEntry;
  return !!entry && entry.sequence === expectedSequence && ['initial', 'change'].includes(entry.kind)
    && typeof entry.projectId === 'string' && typeof entry.resourceId === 'string' && typeof entry.resourceName === 'string'
    && (entry.equipmentCode === undefined || typeof entry.equipmentCode === 'string')
    && typeof entry.localTime === 'string' && typeof entry.timeZone === 'string' && typeof entry.description === 'string'
    && ['crane', 'pile', 'excavator'].includes(entry.assetId) && finite(entry.modelFrontAxisDeg) && finite(Date.parse(entry.recordedAt))
    && Array.isArray(entry.changes) && entry.changes.length > 0 && entry.changes.length <= 64
    && entry.changes.every(change => !!change && typeof change.field === 'string' && typeof change.label === 'string' && typeof change.unit === 'string'
      && (finite(change.value) || typeof change.value === 'boolean') && (change.previous === null || finite(change.previous) || typeof change.previous === 'boolean')
      && ['manual', 'measured', 'simulated', 'mixed'].includes(change.source) && typeof change.description === 'string'
      && Array.isArray(change.samples) && change.samples.length <= 64
      && change.samples.every(sample => !!sample && ['manual', 'measured', 'simulated'].includes(sample.source)
        && (sample.sampleTimestamp == null || finite(Date.parse(sample.sampleTimestamp)))));
}
function utc(value: number): string {
  if (!finite(value)) throw new Error('浏览器记录时间无效');
  return new Date(value).toISOString();
}
function localTime(value: number, timeZone: string): string {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (timeFormatters.size >= 16) timeFormatters.clear();
    timeFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(value);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
/** datetime-local inputs here always mean Beijing time, independently of browser settings. */
export function machineryPoseBeijingTime(value: string, endOfSecond = false): string | undefined {
  if (!value.trim()) return;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? value + ':00' : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) throw new Error('请输入有效的北京时间');
  const timestamp = Date.parse(normalized + '+08:00');
  if (!finite(timestamp) || localTime(timestamp, 'Asia/Shanghai').replace(' ', 'T') !== normalized) throw new Error('请输入有效的北京时间');
  return utc(timestamp + (endOfSecond ? 999 : 0));
}
function historyPredicate(filter: MachineryPoseHistoryFilter): (entry: MachineryPoseEntry) => boolean {
  const boundary = (value: string | undefined): number | undefined => {
    if (!value) return;
    const time = Date.parse(value);
    if (!finite(time) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('筛选时间必须包含时区');
    return time;
  };
  const from = boundary(filter.from), to = boundary(filter.to), resourceId = filter.resourceId;
  if (from !== undefined && to !== undefined && from > to) throw new Error('开始时间不能晚于结束时间');
  return entry => (!resourceId || entry.resourceId === resourceId)
    && (from === undefined || Date.parse(entry.recordedAt) >= from)
    && (to === undefined || Date.parse(entry.recordedAt) <= to);
}
function beijingTime(value: string): string {
  const time = Date.parse(value);
  return `${localTime(time, 'Asia/Shanghai')}.${String(new Date(time).getUTCMilliseconds()).padStart(3, '0')}`;
}
export function machineryPoseProcessDescription(entry: MachineryPoseEntry): string {
  return `${beijingTime(entry.recordedAt)} ${entry.equipmentCode ? entry.equipmentCode + ' ' : ''}${entry.resourceName}：${entry.kind === 'initial' ? '开始记录，初始姿态；' : ''}${entry.changes.map(change => change.description).join('；')}`;
}
function shown(value: number | boolean, unit: string): string {
  if (typeof value === 'boolean') return value ? '显示' : '隐藏';
  // Descriptions are readable; JSON/CSV retain the original numeric precision.
  return `${Number(value.toFixed(unit === '°' ? 9 : 6))}${unit === 'm' ? ' m' : unit}`;
}
function describe(field: string, data: Field, previous: number | boolean | null): string {
  if (field === 'visible') return `模型${shown(data.value, '')}`;
  if (field === 'boom_length_m' && typeof previous === 'number' && typeof data.value === 'number') return `吊臂${data.value > previous ? '伸长' : '缩短'}至${shown(data.value, data.unit)}`;
  if (field === 'boom_elevation_deg') return `吊臂仰角${previous === null ? '为' : '调整至'}${shown(data.value, data.unit)}`;
  if (field === 'boom_rotation_deg') return `吊臂相对回转角${previous === null ? '为' : '转至'}${shown(data.value, data.unit)}`;
  if (field === 'heading') return `整机方位角${previous === null ? '为' : '转至'}${shown(data.value, data.unit)}`;
  return `${data.label}${previous === null ? '为' : '调整至'}${shown(data.value, data.unit)}`;
}
function poseFields(input: MachineryPoseSnapshot): Record<string, Field> {
  const state = validateMachineryMetadata(input.state), front = input.modelFrontAxisDeg ?? 0;
  if (state.assetId !== input.asset.id || !input.projectId || !input.resourceId || !finite(front)) throw new Error('机械姿态记录上下文无效');
  const fields: Record<string, Field> = {
    longitude: { value: state.placement.longitude, label: '经度', unit: '°' },
    latitude: { value: state.placement.latitude, label: '纬度', unit: '°' },
    height: { value: state.placement.height, label: '站位椭球高', unit: 'm' },
    heading: { value: sourceHeadingToCanonical(state.placement.heading, front), label: '整机方位角', unit: '°' },
  };
  for (const definition of input.asset.config.parameters) {
    let value = state.parameters[definition.key];
    if (definition.key === 'boom_rotation_deg') value = sourceBoomToCanonical(input.asset, value, front);
    fields[definition.key] = { value, label: definition.label, unit: definition.unit };
  }
  fields.visible = { value: state.visible, label: '模型显示', unit: '' };
  return fields;
}
function equivalent(field: string, a: number | boolean, b: number | boolean): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  const epsilon = field === 'longitude' || field === 'latitude' ? 1e-9 : 1e-6;
  const delta = Math.abs(a - b);
  return (field === 'heading' || field === 'boom_rotation_deg' ? Math.min(delta, 360 - delta) : delta) <= epsilon;
}
function provenance(value?: MachineryPoseProvenance): MachineryPoseProvenance {
  if (!value) return { source: 'manual', sampleTimestamp: null };
  if (!['manual', 'measured', 'simulated'].includes(value.source)) throw new Error('姿态记录来源无效');
  const result = clone(value);
  if (result.source === 'manual') result.sampleTimestamp = null;
  else if (result.sampleTimestamp != null) {
    const timestamp = Date.parse(result.sampleTimestamp);
    if (!finite(timestamp) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result.sampleTimestamp)
      || new Date(timestamp).toISOString().slice(0, 19) !== result.sampleTimestamp.slice(0, 19)) throw new Error('采样时间必须是实际 UTC ISO 时间');
    result.sampleTimestamp = new Date(timestamp).toISOString();
  } else result.sampleTimestamp = null;
  return result;
}
/** Never infer an acquisition timestamp by subtracting a rounded display age. */
export function poseProvenanceFromTelemetry(statuses: readonly MachineryTelemetryFieldStatus[]): Record<string, MachineryPoseProvenance> {
  return Object.fromEntries(statuses.filter(status => !!status.mode && !!status.sampleTimestamp).map(status => [status.target,
    { source: status.mode!, sourceId: status.sourceId, sourceField: status.sourceField, sampleTimestamp: status.sampleTimestamp }]));
}
/** CSV fields are quoted and formula-like text neutralised, including leading whitespace. */
export function machineryPoseCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (typeof value !== 'number' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** Explicit recording of resolved target poses. It never records fall-demo transforms,
 * overwrites a resource record, evicts old rows or resumes automatically after reload. */
export class MachineryPoseRecorder {
  private entries: MachineryPoseEntry[] = [];
  private previous?: Record<string, Field>;
  private activeScope?: { projectId: string; resourceId: string; resourceName: string; equipmentCode?: string };
  private readonly maximum: number;
  private readonly now: () => number;
  readonly timeZone: string;
  private readonly storage?: MachineryPoseRecorderOptions['storage'];
  private readonly storageKey?: string;
  private listeners = new Set<() => void>();
  /** Counts consume only appended entries; live UI refreshes never rescan accumulated history. */
  private filterCounts = new Map<string, { matches: (entry: MachineryPoseEntry) => boolean; scanned: number; count: number }>();
  private warning = '';
  private storageBlocked = false;
  private storageGeneration = newGeneration();
  private legacyNeedsMigration = false;
  constructor(options: MachineryPoseRecorderOptions = {}) {
    this.maximum = options.maxEntries ?? 10000;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > MAX_HISTORY_ENTRIES) throw new Error('记录条数上限须为 1 至 10000');
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? 'Asia/Shanghai';
    localTime(this.now(), this.timeZone);
    this.storageKey = options.storageKey;
    if (this.storageKey) {
      try { this.storage = options.storage ?? globalThis.localStorage; }
      catch { this.warning = '浏览器存储不可用，记录只保留在本次页面内，请及时导出。'; }
    }
    if (this.storage && this.storageKey) {
      try {
        const raw = this.storage.getItem(this.storageKey);
        if (raw) {
          if (raw.length > MAX_BLOCK_BYTES * 20) throw new Error('历史记录超出可读取范围');
          const parsed = JSON.parse(raw) as MachineryPoseArchive | HistoryIndex;
          if (parsed.schemaVersion === 1 && parsed.type === 'machinery-pose-history') {
            if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_HISTORY_ENTRIES
              || parsed.entries.some((entry, i) => !validEntry(entry, i + 1))) throw new Error('历史记录格式无效');
            this.entries = clone(parsed.entries); this.legacyNeedsMigration = true;
          } else if (parsed.schemaVersion === 2 && parsed.type === 'machinery-pose-history-index') {
            if (!/^[a-zA-Z0-9-]{1,80}$/.test(parsed.generation) || parsed.blockSize !== BLOCK_SIZE
              || !Number.isSafeInteger(parsed.count) || parsed.count < 0 || parsed.count > MAX_HISTORY_ENTRIES
              || parsed.lastSequence !== parsed.count) throw new Error('历史记录索引无效');
            this.storageGeneration = parsed.generation;
            const restored: MachineryPoseEntry[] = [];
            for (let block = 0; block < Math.ceil(parsed.count / BLOCK_SIZE); block++) {
              const text = this.storage.getItem(this.blockKey(block));
              if (!text || text.length > MAX_BLOCK_BYTES) throw new Error('历史记录分块缺失或过大');
              const rows = JSON.parse(text) as MachineryPoseEntry[];
              const expected = Math.min(BLOCK_SIZE, parsed.count - block * BLOCK_SIZE);
              if (!Array.isArray(rows) || rows.length < expected || rows.length > BLOCK_SIZE
                || rows.some((entry, i) => !validEntry(entry, block * BLOCK_SIZE + i + 1))) throw new Error('历史记录分块无效');
              restored.push(...rows);
            }
            if (parsed.count > 0 && parsed.count % BLOCK_SIZE === 0 && parsed.count < MAX_HISTORY_ENTRIES) {
              const nextBlock = this.storage.getItem(this.blockKey(parsed.count / BLOCK_SIZE));
              if (nextBlock) {
                if (nextBlock.length > MAX_BLOCK_BYTES) throw new Error('末尾记录分块过大');
                const rows = JSON.parse(nextBlock) as MachineryPoseEntry[];
                if (!Array.isArray(rows) || !rows.length || rows.length > BLOCK_SIZE
                  || rows.some((entry, i) => !validEntry(entry, parsed.count + i + 1))) throw new Error('末尾记录分块无效');
                restored.push(...rows);
              }
            }
            // A previous block write may have succeeded just before its tiny index
            // write failed. Recover complete trailing rows instead of dropping them.
            if (restored.length !== parsed.count) this.warning = '已恢复末尾尚未写入索引的记录；记录保持停止，已有记录可导出。';
            this.entries = restored;
          } else throw new Error('历史记录格式无效');
        }
      } catch {
        this.warning = '已保存记录无法读取，原数据仍保留；为避免覆盖，已禁止开始。请先检查浏览器存储或显式清空。'; this.storageBlocked = true;
      }
    }
  }
  private blockKey(block: number, generation = this.storageGeneration): string { return `${this.storageKey}:block:${generation}:${block}`; }
  private index(): HistoryIndex { return { schemaVersion: 2, type: 'machinery-pose-history-index', generation: this.storageGeneration,
    blockSize: BLOCK_SIZE, count: this.entries.length, lastSequence: this.entries.at(-1)?.sequence ?? 0 }; }
  get isRecording() { return !!this.activeScope; }
  get count() { return this.entries.length; }
  get maxEntries() { return this.maximum; }
  get activeResource() { return this.activeScope ? clone(this.activeScope) : undefined; }
  get status() { return this.warning || (this.isRecording ? `正在记录 ${this.activeScope!.resourceName} 的姿态变化` : '记录已停止；已有记录保留至显式清空'); }
  get isPersisted() { return !!this.storage && !this.storageBlocked; }
  get hasStorageFailure() { return this.storageBlocked; }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() { this.listeners.forEach(listener => listener()); }
  snapshot(): MachineryPoseArchive { return archive(clone(this.entries)); }
  countMatching(filter: MachineryPoseHistoryFilter = {}): number {
    if (!filter.resourceId && !filter.from && !filter.to) return this.entries.length;
    const key = JSON.stringify([filter.resourceId ?? '', filter.from ?? '', filter.to ?? '']);
    let cached = this.filterCounts.get(key);
    if (!cached) {
      cached = { matches: historyPredicate(filter), scanned: 0, count: 0 };
      if (this.filterCounts.size >= 16) this.filterCounts.clear();
      this.filterCounts.set(key, cached);
    }
    while (cached.scanned < this.entries.length) cached.count += Number(cached.matches(this.entries[cached.scanned++]));
    return cached.count;
  }
  recent(limit = 5): MachineryPoseEntry[] { return clone(this.entries.slice(-Math.max(0, limit))); }
  start(input: MachineryPoseSnapshot): boolean {
    if (this.storageBlocked) { this.notify(); return false; }
    if (this.entries.length >= this.maximum) { this.warning = `已达到 ${this.maximum} 条上限，记录已停止；请先导出，再显式清空后重新开始。`; this.notify(); return false; }
    const fields = poseFields(input);
    const previousScope = this.activeScope, previousFields = this.previous;
    this.activeScope = { projectId: input.projectId, resourceId: input.resourceId, resourceName: input.resourceName, equipmentCode: input.equipmentCode };
    this.previous = undefined; this.warning = '';
    try { return this.append(input, fields, 'initial'); }
    catch (error) { this.activeScope = previousScope; this.previous = previousFields; throw error; }
  }
  observe(input: MachineryPoseSnapshot): boolean {
    if (!this.activeScope || input.projectId !== this.activeScope.projectId || input.resourceId !== this.activeScope.resourceId) return false;
    return this.append(input, poseFields(input), 'change');
  }
  private append(input: MachineryPoseSnapshot, fields: Record<string, Field>, kind: MachineryPoseEntry['kind']): boolean {
    const keys = Object.keys(fields).filter(key => !this.previous?.[key] || !equivalent(key, fields[key].value, this.previous[key].value));
    if (!keys.length) return false;
    if (this.entries.length >= this.maximum) {
      this.activeScope = undefined; this.previous = undefined;
      this.warning = `已达到 ${this.maximum} 条上限，记录已停止；本次变化未录入，已有记录完整保留，请导出后显式清空。`; this.notify(); return false;
    }
    const recorded = this.now(), recordedAt = utc(recorded), displayTime = localTime(recorded, this.timeZone);
    const changes: MachineryPoseChange[] = keys.map(key => {
      let samples = [provenance(input.provenance?.[key])];
      // Derived measurements inherit actual changing input samples. They are never
      // presented as a separate physical height/scale sensor measurement.
      const derived = (input.asset.id === 'crane' && key === 'overall_height_m')
        || (input.asset.id === 'excavator' && ['body_height_m', 'overall_scale'].includes(key));
      const dependencies = input.asset.id === 'crane' ? ['boom_length_m', 'boom_elevation_deg', 'overall_scale', 'body_height_m'] : ['overall_height_m'];
      const derivedFrom = derived && !input.provenance?.[key] ? keys.filter(field => dependencies.includes(field)) : [];
      if (derivedFrom.length) samples = derivedFrom.map(field => provenance(input.provenance?.[field]));
      samples = [...new Map(samples.map(sample => [JSON.stringify(sample), sample])).values()];
      const sources = new Set(samples.map(sample => sample.source));
      const previous = this.previous?.[key]?.value ?? null;
      return { field: key, label: fields[key].label, unit: fields[key].unit, previous, value: fields[key].value,
        source: sources.size === 1 ? samples[0].source : 'mixed', samples: clone(samples), description: describe(key, fields[key], previous),
        ...(derivedFrom.length ? { derivedFrom } : {}) };
    });
    const entry: MachineryPoseEntry = { sequence: (this.entries.at(-1)?.sequence ?? 0) + 1, kind,
      projectId: input.projectId, resourceId: input.resourceId, resourceName: input.resourceName,
      ...(input.equipmentCode?.trim() ? { equipmentCode: input.equipmentCode.trim() } : {}),
      assetId: input.state.assetId, recordedAt, localTime: displayTime, timeZone: this.timeZone,
      modelFrontAxisDeg: input.modelFrontAxisDeg ?? 0, changes,
      description: `${displayTime} ${input.resourceName}：${changes.map(change => change.description).join('；')}` };
    this.entries.push(entry); this.previous = clone(fields);
    this.persist();
    if (this.entries.length >= this.maximum) {
      this.activeScope = undefined;
      if (!this.warning) this.warning = `已达到 ${this.maximum} 条上限，记录已停止；已有记录完整保留，请导出后显式清空。`;
    }
    this.notify(); return true;
  }
  private persist(): void {
    if (!this.storage || !this.storageKey) return;
    try {
      // Only the latest <=50 entries and a small index are encoded on ordinary
      // appends. Historical blocks are immutable until an explicit clear.
      const lastBlock = Math.floor((this.entries.length - 1) / BLOCK_SIZE);
      const firstBlock = this.legacyNeedsMigration ? 0 : lastBlock;
      for (let block = Math.max(0, firstBlock); block <= lastBlock; block++) {
        const text = JSON.stringify(this.entries.slice(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE));
        if (text.length > MAX_BLOCK_BYTES) throw new Error('姿态记录分块超出容量');
        this.storage.setItem(this.blockKey(block), text);
      }
      this.storage.setItem(this.storageKey, JSON.stringify(this.index()));
      this.legacyNeedsMigration = false;
    }
    catch {
      this.activeScope = undefined; this.storageBlocked = true;
      this.warning = '浏览器存储写入失败，记录已自动停止；全部记录仍在本页面内，请立即导出。关闭或刷新可能丢失尚未保存的记录。';
    }
  }
  stop(): void { this.activeScope = undefined; this.previous = undefined; this.notify(); }
  /** The only deletion operation. The caller must expose this as an explicit user action. */
  clear(): void {
    const previousGeneration = this.storageGeneration, blocks = Math.ceil(this.entries.length / BLOCK_SIZE);
    this.activeScope = undefined; this.previous = undefined; this.entries = []; this.warning = ''; this.storageBlocked = false;
    this.filterCounts.clear();
    this.storageGeneration = newGeneration(); this.legacyNeedsMigration = false;
    this.persist();
    if (!this.storageBlocked) {
      // The new empty index is durable before obsolete blocks are removed. Injected
      // storage without removeItem still clears logically through generation isolation.
      for (let block = 0; block < blocks; block++) {
        try { this.storage?.removeItem?.(this.blockKey(block, previousGeneration)); } catch { /* obsolete keys cannot become active again */ }
      }
    } else this.warning = '浏览器中的旧记录未能清空；刷新后可能恢复旧记录。请检查存储后重试清空。';
    this.notify();
  }
  exportJson(): string { return JSON.stringify(this.snapshot(), null, 2); }
  /** Human-readable process table; existing archives are never relabelled with today's identifier. */
  exportProcessCsv(filter: MachineryPoseHistoryFilter = {}): string {
    const entries = this.entries.filter(historyPredicate(filter));
    if (!entries.length) throw new Error('所选机械和时间范围内没有已记录的姿态数据');
    const rows: unknown[][] = [['记录序号', '记录类型', '记录时间（北京时间）', '机械识别号', '机械名称', '机械种类',
      '变化参数', '变化前', '变化后', '单位', '数据来源', '采样时间（北京时间）', '来源ID', '来源字段', '推算输入字段',
      '变化过程说明', '项目ID', '系统资源ID', '记录时间UTC', '采样时间UTC', '参数字段']];
    const timestamps = new Map<string, string>();
    const displayTime = (timestamp: string): string => {
      if (!timestamps.has(timestamp)) timestamps.set(timestamp, beijingTime(timestamp));
      return timestamps.get(timestamp)!;
    };
    for (const entry of entries) for (const change of entry.changes) {
      const time = displayTime(entry.recordedAt), initial = entry.kind === 'initial';
      rows.push([entry.sequence, initial ? '初始姿态' : '姿态变化', time, entry.equipmentCode || '未记录', entry.resourceName, assetLabels[entry.assetId],
        change.label, change.previous === null ? '未记录' : change.previous, change.value, change.unit, sourceLabels[change.source] + (change.derivedFrom?.length ? '（推算）' : ''),
        change.samples.map(sample => sample.sampleTimestamp ? displayTime(sample.sampleTimestamp) : '').join(' | '),
        change.samples.map(sample => sample.sourceId ?? '').join(' | '), change.samples.map(sample => sample.sourceField ?? '').join(' | '),
        change.derivedFrom?.join(' | ') ?? '', `${time} ${entry.equipmentCode ? entry.equipmentCode + ' ' : ''}${entry.resourceName}：${initial ? '开始记录，初始姿态；' : ''}${change.description}`,
        entry.projectId, entry.resourceId, entry.recordedAt, change.samples.map(sample => sample.sampleTimestamp ?? '').join(' | '), change.field]);
    }
    return '\uFEFF' + rows.map(row => row.map(machineryPoseCsvCell).join(',')).join('\r\n') + '\r\n';
  }
  exportCsv(): string {
    const rows: unknown[][] = [['序号', '记录类型', '记录时间UTC', '本地时间', '时区', '项目ID', '机械ID', '机械名称', '模型类型',
      '字段', '参数名称', '单位', '原值', '新值', '来源', '采样时间UTC', '来源ID', '来源字段', '推算输入字段', '描述']];
    for (const entry of this.entries) for (const change of entry.changes) {
      rows.push([entry.sequence, entry.kind === 'initial' ? '初始快照' : '姿态变化', entry.recordedAt, entry.localTime, entry.timeZone,
        entry.projectId, entry.resourceId, entry.resourceName, entry.assetId, change.field, change.label, change.unit,
        change.previous, change.value, sourceLabels[change.source], change.samples.map(s => s.sampleTimestamp ?? '').join(' | '),
        change.samples.map(s => s.sourceId ?? '').join(' | '), change.samples.map(s => s.sourceField ?? '').join(' | '), change.derivedFrom?.join(' | ') ?? '',
        `${entry.localTime} ${entry.resourceName}：${change.description}`]);
    }
    return '\uFEFF' + rows.map(row => row.map(machineryPoseCsvCell).join(',')).join('\r\n') + '\r\n';
  }
}
