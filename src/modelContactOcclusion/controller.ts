import { SceneMode, type Cesium3DTileset, type Model, type Viewer } from 'cesium';
import { getTemporaryWorksClippingManager } from '../temporaryWorksGlbScene';
import { createEngineeringModelBindings, parseEngineeringCatalog, type EngineeringBinding } from '../engineeringComponents/catalog';
import { EngineeringComponentState } from '../engineeringComponents/state';
import { readRuntimeModelGeometry, runtimeModelWorldFromLocal } from './runtimeGeometry';
import { ModelContactGeometryClient } from './client';
import { acquireContactWorkLease } from './workQueue';
import type { ContactGeometry, ContactMeshInput, ContactVolume } from './types';
import { MODEL_PROJECTION_TARGET_LIMIT } from './types';
import type { ModelProjectionGeometry } from './projection';
import type { TemporaryWorksFootprint } from '../temporaryWorksClipping';
type EffectGeometry = ContactGeometry | ModelProjectionGeometry;
type EffectInput = { id: string; tileset: Cesium3DTileset; enabled?: boolean; visible?: boolean } &
  ({ volume: ContactVolume } | { footprints: readonly TemporaryWorksFootprint[] });
const isProjection = (geometry: EffectGeometry): geometry is ModelProjectionGeometry => 'kind' in geometry && geometry.kind === 'projection';
const contribution = (id: string, tileset: Cesium3DTileset, geometry: EffectGeometry, world: number[]): EffectInput =>
  isProjection(geometry) ? { id, tileset, footprints: geometry.projection.footprints, visible: true, enabled: true }
    : { id, tileset, volume: { geometry, worldFromLocal: world }, visible: true, enabled: true };

export type ModelContactInstance = { id: string; name: string; model: Model; url: string };
export type ModelContactTarget = { id: string; name: string; tileset: Cesium3DTileset };
export type ModelContactContext = { projectId: string; actorId?: string | null };
export type ModelContactStatus = {
  enabled: boolean; targetId: string; busy: boolean; state: string; message: string; error: boolean;
  partial: boolean; mode: 'none' | 'solid' | 'surface' | 'mixed' | 'projection'; componentCount: number;
  triangles: number; solidEntities: number; surfaceEntities: number;
};
type ContactScope = {
  upsert(input: EffectInput): void;
  remove(id: string): void; clear(): void; dispose(): void; setEnabled(value: boolean): void;
  getStatus(id: string): { state: string; message: string } | undefined;
};
type Saved = { version: 1; url: string; identity: string; enabled: boolean; targetId: string; selectedNodes?: number[]; physicalNodes?: number[] };
type Identity = { sha256: string; gltf?: unknown };
type Client = Pick<ModelContactGeometryClient<EffectGeometry>, 'build' | 'dispose'>;
type Dependencies = {
  createScope(id: string): ContactScope;
  read(model: Model, options: { signal: AbortSignal; allowedNodeIndices?: readonly number[]; onProgress(message: string): void }): Promise<ContactMeshInput & { readStats?: { ignoredNonSurfacePrimitives?: number; rootScaleAffectsGeometry?: boolean } }>;
  world(model: Model): number[];
  client(): Client;
  acquireWork(signal: AbortSignal): Promise<() => void>;
  identify(instance: ModelContactInstance, signal: AbortSignal): Promise<Identity>;
  resolveComponents?(identity: Identity, instance: ModelContactInstance, context: ModelContactContext, signal: AbortSignal): Promise<{ bindings: readonly EngineeringBinding[]; state: EngineeringComponentState } | undefined>;
};
type Options = {
  /** Contact remains the historical test/API default; the application opts into projection. */
  effect?: 'contact' | 'projection';
  viewer: Viewer; getContext(): ModelContactContext | null; getInstances(): ModelContactInstance[]; getTargets(): ModelContactTarget[];
  onChanged?(): void; toast?(message: string, error?: boolean): void; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** CPU tests replace only resource/worker/GPU boundaries. */
  dependencies?: Partial<Dependencies>;
};
type Entry = {
  instance: ModelContactInstance; context: ModelContactContext; key: string; identity: string; expectedIdentity: string;
  enabled: boolean; targetId: string; selectedNodes?: number[]; physicalNodes?: number[];
  bindings?: readonly EngineeringBinding[]; componentState?: EngineeringComponentState; unsubscribe?: () => void;
  scope?: ContactScope; client?: Client; geometry?: EffectGeometry; request?: AbortController; generation: number;
  attempted: boolean; pose: string; appliedTargets: Map<string, Cesium3DTileset>; status: ModelContactStatus;
  selectedCount: number; hasSaved: boolean; explicitChoice: boolean;
  identityData?: Identity; metadataResolved: boolean;
  phase?: 'identity' | 'geometry'; projectionPose?: string;
  geometryScale?: string; rootScaleAffectsGeometry?: boolean; ignoredPrimitives?: number;
  appliedGeometry?: EffectGeometry; appliedWorld?: number[]; failedApplyKey?: string; failedApplyMessage?: string;
};
const contextKey = (value: ModelContactContext | null) => value ? JSON.stringify([value.projectId, value.actorId ?? null]) : '';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const inactive = (): ModelContactStatus => ({ enabled: false, targetId: 'all', busy: false, state: 'disabled', message: '模型遮挡已关闭。', error: false, partial: false, mode: 'none', componentCount: 0, triangles: 0, solidEntities: 0, surfaceEntities: 0 });
const same = (a: readonly number[] | undefined, b: readonly number[] | undefined) => a === b || !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]);
const nodes = (bindings: readonly EngineeringBinding[]) => [...new Set(bindings.flatMap(binding => [...binding.nodeIndices]))].sort((a, b) => a - b);
const validNodes = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 200_000 && value.every(number => Number.isSafeInteger(number) && number >= 0);

async function readControlled(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || !/^\/(?:__library|__models|__engineering-components)\//.test(target.pathname)) throw new Error('模型必须来自当前项目受控资料接口。');
  const response = await fetch(target, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`读取模型身份失败（${response.status}）。`);
  const limit = 1024 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('模型身份校验超过 1GB 读取预算。');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > limit) throw new Error('模型身份校验超过 1GB 读取预算。');
  return bytes;
}
async function identify(instance: ModelContactInstance, signal: AbortSignal): Promise<Identity> {
  const bytes = await readControlled(instance.url, signal);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const view = new DataView(bytes); let gltf: unknown;
  if (bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2
    && view.getUint32(8, true) === bytes.byteLength && view.getUint32(16, true) === 0x4e4f534a && view.getUint32(12, true) <= bytes.byteLength - 20)
    gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true))));
  return { sha256, gltf };
}
async function resolveComponents(identity: Identity, instance: ModelContactInstance, context: ModelContactContext, signal: AbortSignal) {
  if (!identity.gltf) return;
  const response = await fetch('/__engineering-components/manifest', { signal, cache: 'no-store' });
  if (!response.ok) return;
  const manifest = await response.json();
  if (!manifest.available) return;
  const unit = manifest.units?.find((value: { sha256: string }) => value.sha256 === identity.sha256);
  if (manifest.fullModel?.sha256 !== identity.sha256 && !unit) return;
  const verified = async (file: { url: string; sha256: string }) => {
    const bytes = await readControlled(file.url, signal);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== file.sha256) throw new Error('构件目录与模型资源身份不一致。');
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const [raw, index] = await Promise.all([verified(manifest.catalog), verified(manifest.index)]);
  const catalog = parseEngineeringCatalog(raw, { assetFingerprint: manifest.fingerprint, structureIndex: index });
  const bindings = createEngineeringModelBindings(catalog, identity.gltf, unit ? { unitId: unit.id } : {}).bindings
    .filter(binding => catalog.itemsById.get(binding.componentId)?.kind !== 'reference');
  const state = new EngineeringComponentState(catalog, { ...context, instanceId: instance.id });
  const saved = localStorage.getItem(state.storageKey);
  if (saved) state.restore(saved);
  else state.applyIds(bindings.map(binding => binding.componentId), { occlusionEnabled: true });
  return { bindings, state };
}

/** One contact owner per scene model, independent of the currently open component tree.
 * Never changes Model.show, node.show, source geometry or project-library records. */
export class ModelContactOcclusionController {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly dependencies: Dependencies;
  private currentContext = '';
  private disposed = false;
  private suspensions = 0;
  private readonly objectIds = new WeakMap<object, number>();
  private nextObjectId = 0;
  private readonly stopWatching: () => void;
  constructor(private readonly options: Options) {
    this.dependencies = {
      createScope: id => options.effect === 'projection'
        ? getTemporaryWorksClippingManager(options.viewer).createModelProjectionScope(id)
        : getTemporaryWorksClippingManager(options.viewer).createContactScope(id),
      read: readRuntimeModelGeometry, world: runtimeModelWorldFromLocal,
      client: () => new ModelContactGeometryClient<EffectGeometry>({ effect: options.effect }), acquireWork: acquireContactWorkLease, identify, resolveComponents, ...options.dependencies,
    };
    this.stopWatching = options.viewer.scene.preUpdate.addEventListener(() => this.synchronize());
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() {
    for (const listener of [...this.listeners]) { try { listener(); } catch (error) { console.warn('[Model contact] Status view failed', error); } }
    try { this.options.onChanged?.(); } catch (error) { console.warn('[Model contact] Directory refresh failed', error); }
  }
  getState(id: string): ModelContactStatus { return { ...(this.entries.get(id)?.status ?? inactive()) }; }
  getTargets() { return this.options.getContext() ? this.options.getTargets().filter(target => !target.tileset.isDestroyed()) : []; }
  synchronize() {
    if (this.disposed) return;
    const context = this.options.getContext(), key = contextKey(context);
    if (key !== this.currentContext) { for (const entry of this.entries.values()) this.release(entry); this.entries.clear(); this.currentContext = key; }
    if (!context) return;
    const instances = this.options.getInstances().filter(instance => !instance.model.isDestroyed());
    for (const [id, entry] of this.entries) if (!instances.some(instance => instance.id === id && instance.model === entry.instance.model && instance.url === entry.instance.url)) { this.release(entry); this.entries.delete(id); }
    for (const instance of instances) {
      let entry = this.entries.get(instance.id);
      if (!entry) {
        const storageKey = `model-contact:v1:${JSON.stringify([context.projectId, context.actorId ?? null, instance.id])}`;
        entry = { instance, context, key: storageKey, identity: '', expectedIdentity: '', enabled: false, targetId: 'all', generation: 0,
          attempted: false, pose: '', appliedTargets: new Map(), status: inactive(), selectedCount: 0, hasSaved: false, explicitChoice: false, metadataResolved: false };
        try {
          const pointer = this.storage()?.getItem(storageKey);
          if (pointer) {
            const link = JSON.parse(pointer);
            if (link.url === instance.url && /^[a-f0-9]{64}$/.test(link.identity)) {
              const raw = this.storage()?.getItem(`${storageKey}:${link.identity}`);
              if (raw && raw.length < 5_000_000) {
                const saved = JSON.parse(raw) as Saved;
                if (saved.version === 1 && saved.url === instance.url && saved.identity === link.identity && typeof saved.enabled === 'boolean' && typeof saved.targetId === 'string') {
                  entry.expectedIdentity = saved.identity; entry.enabled = saved.enabled; entry.targetId = saved.targetId || 'all'; entry.hasSaved = true;
                  if (validNodes(saved.selectedNodes) && validNodes(saved.physicalNodes)) { entry.selectedNodes = saved.selectedNodes; entry.physicalNodes = saved.physicalNodes; }
                }
              }
            }
          }
        } catch { /* Invalid personal preferences never become scene effects. */ }
        this.entries.set(instance.id, entry);
      } else entry.instance = instance;
      this.check(entry);
    }
  }
  private storage() { return this.options.storage ?? globalThis.localStorage; }
  private save(entry: Entry) {
    const identity = entry.identity || entry.expectedIdentity;
    if (!identity) return;
    const saved: Saved = { version: 1, url: entry.instance.url, identity, enabled: entry.enabled, targetId: entry.targetId,
      ...(entry.selectedNodes ? { selectedNodes: entry.selectedNodes, physicalNodes: entry.physicalNodes } : {}) };
    try {
      this.storage()?.setItem(`${entry.key}:${identity}`, JSON.stringify(saved));
      this.storage()?.setItem(entry.key, JSON.stringify({ url: entry.instance.url, identity }));
      entry.hasSaved = true;
      if (entry.componentState) this.storage()?.setItem(entry.componentState.storageKey, JSON.stringify(entry.componentState.serialize()));
    } catch (error) { this.options.toast?.(`模型遮挡偏好未保存：${message(error)}`, true); }
  }
  toggle(id: string) { this.synchronize(); this.setEnabled(id, !this.entries.get(id)?.enabled); }
  setEnabled(id: string, enabled: boolean) {
    if (this.disposed || this.suspensions || !this.options.getContext()) return;
    this.synchronize(); const entry = this.entries.get(id); if (!entry) return;
    entry.enabled = enabled; entry.attempted = false; entry.explicitChoice = true; entry.failedApplyKey = undefined;
    if (!enabled) { this.abort(entry); this.withdraw(entry); }
    this.save(entry); this.check(entry);
  }
  setTarget(id: string, targetId: string) {
    if (this.disposed || this.suspensions || !this.options.getContext()) return;
    this.synchronize(); const entry = this.entries.get(id); if (!entry) return;
    if (targetId && targetId !== 'all' && !this.getTargets().some(target => target.id === targetId)) return;
    entry.targetId = targetId || 'all'; this.save(entry); this.check(entry);
  }
  select(id: string, targetId: string, enabled: boolean) { this.setTarget(id, targetId); this.setEnabled(id, enabled); }
  retry(id: string) { const entry = this.entries.get(id); if (entry) { entry.attempted = false; entry.failedApplyKey = undefined; entry.pose = ''; this.check(entry); } }
  cancel(id: string) { const entry = this.entries.get(id); if (entry) { this.abort(entry); entry.attempted = true; this.report(entry, 'cancelled', '计算已取消；已有模型遮挡保持原状。'); } }
  bindComponentSelection(id: string, bindings: readonly EngineeringBinding[], state: EngineeringComponentState, resourceIdentity?: string): () => void {
    this.synchronize(); const entry = this.entries.get(id);
    if (!entry || state.context.instanceId !== id || contextKey(state.context) !== this.currentContext) throw new Error('构件选择与当前模型或项目不一致。');
    if (resourceIdentity && entry.identity && resourceIdentity !== entry.identity) throw new Error('构件选择对应另一份模型资源。');
    if (resourceIdentity && entry.expectedIdentity && resourceIdentity !== entry.expectedIdentity) {
      entry.enabled = false; entry.selectedNodes = entry.physicalNodes = undefined; entry.geometry = undefined;
      this.abort(entry); this.withdraw(entry);
    }
    if (resourceIdentity) { entry.identity = resourceIdentity; entry.expectedIdentity = resourceIdentity; entry.metadataResolved = true; }
    if (!entry.hasSaved && !entry.explicitChoice) {
      try {
        const raw = this.storage()?.getItem(`${state.storageKey}:photography:v1`);
        const legacy = raw && JSON.parse(raw);
        if (legacy?.version === 1 && typeof legacy.targetId === 'string' && legacy.targetId && typeof legacy.enabled === 'boolean') {
          entry.targetId = legacy.targetId; entry.enabled = legacy.enabled;
        }
      } catch { /* An invalid old preference cannot enable an effect. */ }
    }
    this.installSelection(entry, bindings, state); this.save(entry); this.check(entry);
    // Closing/switching the tree releases only its UI. This service retains the
    // same selection owner until that model is unloaded or its context changes.
    return () => {};
  }
  private installSelection(entry: Entry, bindings: readonly EngineeringBinding[], state: EngineeringComponentState) {
    entry.unsubscribe?.(); entry.bindings = bindings.filter(binding => state.catalog.itemsById.get(binding.componentId)?.kind !== 'reference'); entry.componentState = state;
    const update = () => {
      const active = entry.bindings!.filter(binding => state.get(binding.componentId).occlusionEnabled);
      entry.selectedCount = active.length;
      const physical = nodes(entry.bindings!), selected = nodes(active);
      if (!same(selected, entry.selectedNodes) || !same(physical, entry.physicalNodes)) {
        entry.selectedNodes = selected; entry.physicalNodes = physical; entry.geometry = undefined; entry.attempted = false; this.abort(entry);
        this.save(entry);
      }
      this.check(entry);
    };
    entry.unsubscribe = state.subscribe(update); update();
  }
  private current(entry: Entry) { return !this.disposed && this.entries.get(entry.instance.id) === entry && this.currentContext === contextKey(this.options.getContext()) && !entry.instance.model.isDestroyed()
    && this.options.getInstances().some(instance => instance.id === entry.instance.id && instance.model === entry.instance.model && instance.url === entry.instance.url); }
  private stable3D() { return this.options.viewer.scene.mode === SceneMode.SCENE3D && this.options.viewer.scene.morphTime === 1; }
  private check(entry: Entry) {
    if (!this.current(entry)) return;
    if (this.suspensions) { this.abort(entry); entry.scope?.setEnabled(false); this.report(entry, 'paused', '当前模式暂时停用模型遮挡，退出后恢复。'); return; }
    if (!entry.enabled) { this.report(entry, 'disabled', '模型遮挡已关闭。'); return; }
    if (!this.stable3D()) {
      this.abort(entry); entry.attempted = false; entry.failedApplyKey = undefined; this.withdraw(entry);
      this.report(entry, 'paused', '模型遮挡仅在稳定三维视图生效；切回三维后恢复，已保存开关保持。'); return;
    }
    if (!entry.instance.model.ready) { this.report(entry, 'waiting', '正在等待模型加载完成。'); return; }
    let world: number[], pose: string;
    try {
      world = this.dependencies.world(entry.instance.model); pose = world.join(',');
      if (this.options.effect === 'projection') {
        // A world-space projection cannot be reused at a new position. Abort
        // pending work and withdraw the old location before scheduling a new job.
        if (entry.projectionPose && entry.projectionPose !== pose) {
          this.abort(entry); entry.geometry = undefined; entry.attempted = false; entry.failedApplyKey = undefined; this.withdraw(entry);
        }
        entry.projectionPose = pose;
      }
      // An old selection may stay committed while its replacement is computed,
      // but never at a position the model has already left (including cancellation).
      if (!entry.geometry && entry.pose && entry.pose !== pose) this.withdraw(entry);
      const scale = `${entry.instance.model.scale}:${entry.instance.model.maximumScale ?? ''}`;
      if (entry.geometry && entry.rootScaleAffectsGeometry && entry.geometryScale !== scale) {
        this.abort(entry); entry.geometry = undefined; entry.attempted = false; this.withdraw(entry);
      }
    } catch (error) {
      this.abort(entry); this.withdraw(entry); this.report(entry, 'error', `模型遮挡已撤销：${message(error)}`, true); return;
    }
    if (entry.selectedNodes?.length === 0) { this.abort(entry); this.withdraw(entry); this.report(entry, 'empty', '当前没有启用遮挡的构件。'); return; }
    const authorized = this.getTargets(), targets = authorized.filter(target => entry.targetId === 'all' || target.id === entry.targetId);
    // A target that lost access is released immediately. An authorized previous
    // choice remains until its replacement is successfully prepared and adopted.
    if ([...entry.appliedTargets].some(([id, tileset]) => !authorized.some(target => target.id === id && target.tileset === tileset))) this.withdraw(entry);
    if (!targets.length) {
      if (entry.request && entry.phase === 'geometry') { this.abort(entry); entry.attempted = false; }
      // Persist a verified model choice even when photography has not loaded yet.
      // Identity/catalog reads may finish, but no mesh read or worker starts here.
      if (!entry.identity || !entry.metadataResolved) {
        if (!entry.request && !entry.attempted) void this.prepare(entry);
        if (entry.request || entry.status.error) return;
      }
      this.report(entry, 'waiting', '等待已加载且有权限的倾斜摄影。'); return;
    }
    if (this.options.effect === 'projection' && targets.length > MODEL_PROJECTION_TARGET_LIMIT) {
      this.abort(entry); entry.attempted = false;
      this.report(entry, 'error', `模型投影关联摄影超过 ${MODEL_PROJECTION_TARGET_LIMIT} 份预算；原有效遮挡保持，请选择单份关联摄影。`, true); return;
    }
    if (!entry.geometry) {
      if (!entry.request && !entry.attempted) void this.prepare(entry);
      return;
    }
    if (isProjection(entry.geometry) && !entry.geometry.projection.footprints.length) {
      this.withdraw(entry); this.report(entry, 'empty', '选中原三角面的投影面积为零，当前没有摄影裁剪范围。'); return;
    }
    const objectId = (value: object) => { let id = this.objectIds.get(value); if (!id) { id = ++this.nextObjectId; this.objectIds.set(value, id); } return id; };
    const applyKey = JSON.stringify([objectId(entry.geometry), pose, entry.targetId, targets.map(target => [target.id, objectId(target.tileset)])]);
    if (entry.failedApplyKey === applyKey) { this.report(entry, 'error', entry.failedApplyMessage ?? '模型遮挡更新失败，请重试。', true); return; }
    const previousTargets = new Map(entry.appliedTargets), previousGeometry = entry.appliedGeometry, previousWorld = entry.appliedWorld;
    const changedTargets = new Set<string>();
    try {
      entry.scope ??= this.dependencies.createScope(`model-contact:${crypto.randomUUID()}`);
      entry.scope.setEnabled(true);
      for (const target of targets) if (pose !== entry.pose || entry.geometry !== entry.appliedGeometry || entry.appliedTargets.get(target.id) !== target.tileset) {
        entry.scope.upsert(contribution(target.id, target.tileset, entry.geometry, world));
        changedTargets.add(target.id);
      }
      for (const [id] of previousTargets) if (!targets.some(target => target.id === id)) { entry.scope.remove(id); changedTargets.add(id); }
      entry.appliedTargets = new Map(targets.map(target => [target.id, target.tileset]));
      entry.pose = pose;
      entry.appliedGeometry = entry.geometry; entry.appliedWorld = world; entry.failedApplyKey = undefined;
      const statuses = targets.map(target => entry.scope!.getStatus(target.id));
      const blocked = statuses.find(status => status?.state !== 'active');
      if (statuses.some(status => !status)) this.report(entry, 'waiting', '模型遮挡等待裁剪服务确认生效。');
      else if (blocked) this.report(entry, blocked.state, blocked.message, ['error', 'unsupported'].includes(blocked.state));
      else {
        if (isProjection(entry.geometry)) {
          this.report(entry, 'active', `模型投影遮挡已生效：${targets.length} 份摄影，${entry.geometry.projection.triangleCount.toLocaleString()} 个原始三角面；沿投影范围裁剪，保留二维孔洞。${entry.ignoredPrimitives ? ` ${entry.ignoredPrimitives} 个线/点图元不产生面投影。` : ''}`);
        } else {
          const stats = entry.geometry.stats, mode = stats.surfaceEntities ? stats.solidEntities ? '实体与表面混合' : '表面接触' : '实体体积';
          this.report(entry, 'active', `${mode}遮挡已生效：${targets.length} 份摄影，${stats.sourceTriangles.toLocaleString()} 个原始三角面。${entry.ignoredPrimitives ? ` ${entry.ignoredPrimitives} 个线/点图元不作为实体。` : ''}`);
        }
      }
    } catch (error) {
      // The manager rolls back each failed upsert. Undo any earlier successful
      // target changes in this batch without throwing away its retained owner.
      let rollbackError: unknown;
      try {
        for (const id of changedTargets) if (!previousTargets.has(id)) entry.scope?.remove(id);
        if (previousGeometry && previousWorld) for (const [id, tileset] of previousTargets) {
          if (changedTargets.has(id) && authorized.some(target => target.id === id && target.tileset === tileset))
            entry.scope?.upsert(contribution(id, tileset, previousGeometry, previousWorld));
        }
      } catch (failure) { rollbackError = failure; }
      entry.appliedTargets = previousTargets; entry.appliedGeometry = previousGeometry; entry.appliedWorld = previousWorld;
      entry.pose = previousWorld?.join(',') ?? '';
      // Keeping an old volume at a new model location would clip unrelated
      // photography. Pause that retained owner until an explicit successful retry.
      if (rollbackError || entry.pose !== pose) { try { entry.scope?.setEnabled(false); } catch { this.withdraw(entry); } }
      entry.failedApplyKey = applyKey;
      entry.failedApplyMessage = `模型遮挡未更新：${message(error)}${rollbackError ? `；原贡献已暂停：${message(rollbackError)}` : '；原贡献保留，可手动重试。'}`;
      this.report(entry, 'error', entry.failedApplyMessage, true);
    }
  }
  private async prepare(entry: Entry) {
    const request = new AbortController(), epoch = ++entry.generation; entry.request = request; entry.attempted = true;
    let releaseWork: (() => void) | undefined;
    entry.phase = 'identity';
    const current = () => this.current(entry) && entry.generation === epoch && !request.signal.aborted && entry.enabled && !this.suspensions && this.stable3D();
    const progress = (value: string) => { if (current()) this.report(entry, 'preparing', value, false, true); };
    try {
      progress(this.options.effect === 'projection' ? '正在核对模型资源与原三角投影…' : '正在核对模型资源与三维接触几何…');
      if (!entry.identity) {
        const identity = await this.dependencies.identify(entry.instance, request.signal); if (!current()) return;
        entry.identityData = identity;
        if (entry.expectedIdentity && entry.expectedIdentity !== identity.sha256) {
          entry.enabled = false; entry.selectedNodes = entry.physicalNodes = undefined;
          entry.expectedIdentity = ''; entry.identity = identity.sha256; this.save(entry);
          this.report(entry, 'error', '模型文件已变化，原遮挡选择未套用；请重新启用。', true); return;
        }
        entry.identity = identity.sha256;
      }
      if (!entry.metadataResolved) {
        if (!entry.componentState && this.dependencies.resolveComponents) {
          const selection = await this.dependencies.resolveComponents(entry.identityData ?? { sha256: entry.identity }, entry.instance, entry.context, request.signal); if (!current()) return;
          if (selection) {
            // Install without aborting the identity job that established this state.
            entry.bindings = selection.bindings; entry.componentState = selection.state;
            entry.physicalNodes = nodes(selection.bindings);
            const active = selection.bindings.filter(binding => selection.state.get(binding.componentId).occlusionEnabled);
            entry.selectedCount = active.length; entry.selectedNodes = nodes(active);
            entry.unsubscribe = selection.state.subscribe(() => this.installSelection(entry, selection.bindings, selection.state));
          }
        }
        entry.metadataResolved = true; entry.identityData = undefined;
        this.save(entry);
      }
      if (entry.selectedNodes?.length === 0) { entry.request = undefined; this.check(entry); return; }
      if (!this.getTargets().some(target => entry.targetId === 'all' || target.id === entry.targetId)) {
        entry.request = undefined; entry.attempted = false; this.check(entry); return;
      }
      entry.phase = 'geometry';
      progress(this.options.effect === 'projection' ? '等待模型投影计算队列…' : '等待模型三维计算队列…');
      releaseWork = await this.dependencies.acquireWork(request.signal);
      if (!current()) return;
      const input = await this.dependencies.read(entry.instance.model, { signal: request.signal, allowedNodeIndices: entry.selectedNodes, onProgress: progress });
      if (!current()) return;
      entry.geometryScale = `${entry.instance.model.scale}:${entry.instance.model.maximumScale ?? ''}`;
      entry.rootScaleAffectsGeometry = input.readStats?.rootScaleAffectsGeometry;
      entry.ignoredPrimitives = input.readStats?.ignoredNonSurfacePrimitives;
      entry.client ??= this.dependencies.client();
      const geometry = await entry.client.build(input, request.signal, progress); if (!current()) return;
      if (this.options.effect === 'projection' && this.dependencies.world(entry.instance.model).join(',') !== input.worldFromLocal.join(',')) {
        entry.attempted = false; entry.geometry = undefined; this.withdraw(entry); return;
      }
      entry.geometry = geometry; entry.pose = ''; entry.request = undefined; this.check(entry);
    } catch (error) {
      if (current()) {
        if ((error as Error)?.name === 'AbortError') { entry.attempted = false; this.report(entry, 'waiting', '模型位置已变化，重新准备遮挡几何。'); }
        else this.report(entry, 'error', `模型遮挡未更新：${message(error)}`, true);
      }
    } finally { releaseWork?.(); if (entry.request === request) entry.request = undefined; }
  }
  private report(entry: Entry, state: string, text: string, error = false, busy = false) {
    const projection = entry.geometry && isProjection(entry.geometry) ? entry.geometry.projection : undefined;
    const stats = entry.geometry && !isProjection(entry.geometry) ? entry.geometry.stats : undefined;
    const next: ModelContactStatus = { enabled: entry.enabled, targetId: entry.targetId, busy, state, message: text, error,
      partial: !!entry.physicalNodes?.length && !!entry.selectedNodes?.length && entry.selectedNodes.length < entry.physicalNodes.length,
      componentCount: entry.selectedCount,
      triangles: projection?.triangleCount ?? stats?.sourceTriangles ?? 0, solidEntities: stats?.solidEntities ?? 0, surfaceEntities: stats?.surfaceEntities ?? 0,
      mode: projection ? 'projection' : !stats ? 'none' : stats.surfaceEntities ? stats.solidEntities ? 'mixed' : 'surface' : 'solid' };
    if (JSON.stringify(entry.status) !== JSON.stringify(next)) { entry.status = next; this.notify(); }
  }
  private abort(entry: Entry) { entry.generation++; entry.request?.abort(); entry.request = undefined; }
  private withdraw(entry: Entry) {
    const scope = entry.scope; entry.scope = undefined;
    entry.appliedTargets.clear(); entry.appliedGeometry = undefined; entry.appliedWorld = undefined; entry.pose = '';
    try { scope?.dispose(); }
    catch (error) {
      try { this.options.toast?.(`模型遮挡资源释放异常：${message(error)}`, true); }
      catch { /* Notification failure cannot revive a revoked owner. */ }
    }
  }
  private release(entry: Entry) {
    const failures: unknown[] = [];
    for (const cleanup of [() => this.abort(entry), () => entry.unsubscribe?.(), () => entry.client?.dispose(), () => this.withdraw(entry)]) {
      try { cleanup(); } catch (error) { failures.push(error); }
    }
    // A failed resource destructor cannot leave another model's unauthorized
    // scope alive or interrupt durable deletion/context teardown.
    if (failures.length) {
      try { this.options.toast?.(`模型遮挡资源释放异常：${failures.map(message).join('；')}`, true); }
      catch { /* Notification failure cannot interrupt authoritative cleanup. */ }
    }
  }
  detachInstance(id: string, options: { deleted?: boolean } = {}) {
    const entry = this.entries.get(id); if (!entry) return;
    this.release(entry); this.entries.delete(id);
    if (options.deleted) { try { this.storage()?.removeItem(entry.key); if (entry.identity) this.storage()?.removeItem(`${entry.key}:${entry.identity}`); } catch { /* Scene release remains authoritative. */ } }
  }
  prepareDeletion(id: string): () => void {
    const entry = this.entries.get(id), storage = this.storage();
    return () => {
      if (!entry) return;
      if (this.entries.get(id) === entry) this.detachInstance(id);
      try { storage?.removeItem(entry.key); if (entry.identity) storage?.removeItem(`${entry.key}:${entry.identity}`); } catch { /* A durable deletion must still finish. */ }
    };
  }
  suspendExternalSceneEffects(): () => void {
    this.suspensions++;
    try { for (const entry of this.entries.values()) { this.abort(entry); entry.attempted = false; entry.scope?.setEnabled(false); this.report(entry, 'paused', '当前模式暂时停用模型遮挡，退出后恢复。'); } }
    catch (error) { this.suspensions--; for (const entry of this.entries.values()) this.check(entry); throw error; }
    let released = false;
    return () => { if (released || this.disposed) return; released = true; this.suspensions = Math.max(0, this.suspensions - 1); this.synchronize(); };
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.stopWatching(); for (const entry of this.entries.values()) this.release(entry); this.entries.clear(); this.listeners.clear(); }
}
