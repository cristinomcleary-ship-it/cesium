import type { EngineeringCatalog, EngineeringScope } from './catalog.ts';

export type EngineeringFlags = Readonly<{ visible: boolean; occlusionEnabled: boolean }>;
export type EngineeringMixed = boolean | 'mixed';
export type EngineeringSummary = Readonly<{ count: number; visible: EngineeringMixed; occlusionEnabled: EngineeringMixed }>;
export type EngineeringStateContext = Readonly<{ projectId: string; actorId?: string | null; instanceId: string }>;
export type EngineeringStateChange = Readonly<{ componentIds: readonly string[]; selectionChanged: boolean; revision: number }>;
export type SerializedEngineeringState = Readonly<{
  schema: 'cesium/engineering-component-state/1'; assetFingerprint: string; orderFingerprint: string;
  projectId: string; actorId: string | null; instanceId: string; count: number; flags: string; selectedId: string | null;
}>;

const SCHEMA = 'cesium/engineering-component-state/1';
const invalid = (message: string): never => { throw new Error(`构件显示状态：${message}`); };
function contextId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f]/.test(value)) return invalid(`${label} 无效`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('必须是对象');
  return value as Record<string, unknown>;
}

/** Personal state only. Batch operations write leaves once; no parent override precedence. */
export class EngineeringComponentState {
  readonly catalog: EngineeringCatalog;
  readonly context: EngineeringStateContext;
  private readonly flags: Uint8Array;
  private readonly listeners = new Set<(change: EngineeringStateChange) => void>();
  private selection: string | null = null;
  private version = 0;

  constructor(catalog: EngineeringCatalog, context: EngineeringStateContext) {
    this.catalog = catalog;
    this.context = Object.freeze({ projectId: contextId(context.projectId, 'projectId'),
      actorId: context.actorId === null || context.actorId === undefined ? null : contextId(context.actorId, 'actorId'),
      instanceId: contextId(context.instanceId, 'instanceId') });
    this.flags = Uint8Array.from(catalog.items, item => Number(item.defaultVisible) | (Number(item.defaultOcclusion) << 1));
  }

  get selectedId(): string | null { return this.selection; }
  get revision(): number { return this.version; }
  get storageKey(): string { return `engineering-components:v1:${JSON.stringify([this.context.projectId, this.context.actorId, this.context.instanceId, this.catalog.fingerprint])}`; }
  private index(id: string): number { return this.catalog.itemIndexById.get(id) ?? invalid(`未知构件：${id}`); }
  get(id: string): EngineeringFlags { const flag = this.flags[this.index(id)]; return { visible: !!(flag & 1), occlusionEnabled: !!(flag & 2) }; }

  summary(scope: EngineeringScope): EngineeringSummary {
    return this.summaryIds(this.catalog.getMembers(scope));
  }

  summaryIds(componentIds: readonly string[]): EngineeringSummary {
    const ids = [...new Set(componentIds)]; let visible = 0, occluding = 0;
    for (const id of ids) { const flag = this.flags[this.index(id)]; visible += flag & 1; occluding += (flag & 2) >> 1; }
    const mixed = (count: number): EngineeringMixed => count === 0 ? false : count === ids.length ? true : 'mixed';
    return { count: ids.length, visible: mixed(visible), occlusionEnabled: mixed(occluding) };
  }

  apply(scope: EngineeringScope, patch: Partial<EngineeringFlags>): readonly string[] {
    return this.applyIds(this.catalog.getMembers(scope), patch);
  }

  /** Allows a view to intersect a classification group with its active unit, atomically. */
  applyIds(componentIds: readonly string[], patch: Partial<EngineeringFlags>): readonly string[] {
    const values = object(patch), keys = Object.keys(values);
    if (!keys.length || keys.some(key => key !== 'visible' && key !== 'occlusionEnabled') || keys.some(key => typeof values[key] !== 'boolean')) return invalid('修改必须包含 visible 和/或 occlusionEnabled 布尔值');
    const ids = [...new Set(componentIds)];
    for (const id of ids) this.index(id);
    if (patch.occlusionEnabled && ids.some(id => this.catalog.itemsById.get(id)!.kind === 'reference')) return invalid('参考线/点不能启用实体遮挡');
    const changed: string[] = [];
    for (const id of ids) {
      const index = this.index(id), previous = this.flags[index]; let next = previous;
      if (patch.visible !== undefined) next = patch.visible ? next | 1 : next & ~1;
      if (patch.occlusionEnabled !== undefined) next = patch.occlusionEnabled ? next | 2 : next & ~2;
      if (next !== previous) { this.flags[index] = next; changed.push(id); }
    }
    if (changed.length) this.emit(changed, false);
    return changed;
  }

  /** A hidden component may be selected from the tree without changing either flag. */
  select(id: string | null): boolean {
    if (id !== null) this.index(id);
    if (id === this.selection) return false;
    this.selection = id; this.emit([], true); return true;
  }

  subscribe(listener: (change: EngineeringStateChange) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private emit(ids: readonly string[], selectionChanged: boolean): void {
    this.version++;
    const event = Object.freeze({ componentIds: Object.freeze([...ids]), selectionChanged, revision: this.version });
    // A failed renderer observer must not prevent other views receiving committed state.
    for (const listener of [...this.listeners]) { try { listener(event); } catch (error) { console.error('[Engineering components] State observer failed', error); } }
  }

  /** Two bits per item, packed four items per byte; no item count truncation. */
  serialize(): SerializedEngineeringState {
    let flags = '';
    for (let start = 0; start < this.flags.length; start += 4) {
      let byte = 0; for (let bit = 0; bit < 4 && start + bit < this.flags.length; bit++) byte |= this.flags[start + bit] << (bit * 2);
      flags += byte.toString(16).padStart(2, '0');
    }
    return Object.freeze({ schema: SCHEMA, assetFingerprint: this.catalog.fingerprint, orderFingerprint: this.catalog.orderFingerprint,
      projectId: this.context.projectId, actorId: this.context.actorId ?? null, instanceId: this.context.instanceId,
      count: this.flags.length, flags, selectedId: this.selection });
  }

  /** Validate completely before mutating; wrong asset/account/instance state is never applied. */
  restore(raw: unknown): readonly string[] {
    const saved = object(typeof raw === 'string' ? JSON.parse(raw) : raw);
    const allowed = new Set(['schema', 'assetFingerprint', 'orderFingerprint', 'projectId', 'actorId', 'instanceId', 'count', 'flags', 'selectedId']);
    if (Object.keys(saved).some(key => !allowed.has(key))) return invalid('持久化状态含未知字段');
    if (saved.schema !== SCHEMA || saved.assetFingerprint !== this.catalog.fingerprint || saved.orderFingerprint !== this.catalog.orderFingerprint) return invalid('状态版本、资产指纹或编号顺序不匹配');
    if (saved.projectId !== this.context.projectId || saved.actorId !== (this.context.actorId ?? null) || saved.instanceId !== this.context.instanceId) return invalid('状态不属于当前项目、账号或模型实例');
    if (saved.count !== this.flags.length || typeof saved.flags !== 'string' || saved.flags.length !== Math.ceil(this.flags.length / 4) * 2 || !/^[0-9a-f]*$/.test(saved.flags)) return invalid('状态长度或编码不正确');
    const selected = saved.selectedId;
    if (selected !== null && typeof selected !== 'string') return invalid('选中编号无效');
    if (selected !== null) this.index(selected as string);
    const candidate = new Uint8Array(this.flags.length);
    for (let start = 0; start < candidate.length; start += 4) {
      const byte = Number.parseInt(saved.flags.slice(start / 2, start / 2 + 2), 16);
      for (let bit = 0; bit < 4; bit++) {
        const flag = (byte >> (bit * 2)) & 3, index = start + bit;
        if (index >= candidate.length) { if (flag) return invalid('编码末尾填充位不为零'); continue; }
        if ((flag & 2) && this.catalog.items[index].kind === 'reference') return invalid('持久化状态不能将参考几何设为实体遮挡源');
        candidate[index] = flag;
      }
    }
    const changed: string[] = [];
    for (let index = 0; index < candidate.length; index++) if (this.flags[index] !== candidate[index]) changed.push(this.catalog.items[index].id);
    const selectionChanged = this.selection !== selected;
    this.flags.set(candidate); this.selection = selected as string | null;
    if (changed.length || selectionChanged) this.emit(changed, selectionChanged);
    return changed;
  }
}
