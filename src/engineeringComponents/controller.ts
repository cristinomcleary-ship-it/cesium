import { BoundingSphere, Cartesian3, HeadingPitchRange, ScreenSpaceEventHandler, ScreenSpaceEventType, type Cartesian2, type Model, type Viewer } from 'cesium';
import { parseEngineeringCatalog, createEngineeringModelBindings, type EngineeringCatalog, type EngineeringScope } from './catalog';
import { EngineeringComponentState, type EngineeringFlags, type EngineeringSummary } from './state';
import { EngineeringRenderAdapter } from './renderAdapter';
import { EngineeringOcclusionRenderer } from './occlusion';
import { EngineeringComponentPanel, type EngineeringTreeRow } from './panel';
import { EngineeringPhotographyController, type EngineeringNamedPhotographyTarget } from './photographyController';

export type EngineeringInstance = { id: string; name: string; model: Model; url: string; visible: boolean };
export type EngineeringContext = { projectId: string; actorId?: string | null };
type AssetFile = { url: string; sha256: string; bytes: number };
type Manifest = { available: boolean; message?: string; fingerprint: string; catalog: AssetFile; fullModel: AssetFile; index: AssetFile; units: { id: string; count: number; sha256: string; modelUrl: string; structureUrl: string }[] };
type Options = {
  viewer: Viewer; getInstances(): EngineeringInstance[]; getContext(): EngineeringContext | null;
  getPhotographyTargets?(): EngineeringNamedPhotographyTarget[];
  canPick(): boolean; beginInteractionSession(): () => void; toast(message: string, error?: boolean): void;
};
const textError = (error: unknown) => error instanceof Error ? error.message : String(error);
const contextKey = (context: EngineeringContext | null) => context ? JSON.stringify([context.projectId, context.actorId ?? null]) : null;
const abort = () => new DOMException('工程构件加载已取消', 'AbortError');
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

async function controlledBytes(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin || !/^\/(?:__engineering-components|__library|__models)\//.test(url.pathname)) throw new Error('构件资源必须来自本机受控模型接口');
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`读取构件资源失败（${response.status}）`);
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_SOURCE_BYTES) throw new Error('构件资源超过本轮读取预算');
  if (!response.body) throw new Error('构件资源响应为空');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) { await reader.cancel(); throw new Error('构件资源超过本轮读取预算'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}
export async function verifiedEngineeringBytes(file: AssetFile, signal: AbortSignal): Promise<ArrayBuffer> {
  const bytes = await controlledBytes(file.url, signal);
  if (file.bytes > 0 && bytes.byteLength !== file.bytes) throw new Error('构件资源长度与交付清单不一致');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error('模型或构件索引已变化，与交付版本不匹配');
  return bytes;
}

/** Adds component ownership beside an already positioned model; never duplicates its geometry. */
export class EngineeringComponentsController {
  readonly panel: EngineeringComponentPanel;
  private catalog?: EngineeringCatalog;
  private state?: EngineeringComponentState;
  private adapter?: EngineeringRenderAdapter;
  private renderer?: EngineeringOcclusionRenderer;
  private photography?: EngineeringPhotographyController;
  private instance?: EngineeringInstance;
  private ids = new Set<string>();
  private reviewScope: EngineeringScope = { kind: 'all' };
  private selectedScope?: EngineeringScope;
  private expanded = new Set<string>();
  private search = '';
  private loading?: AbortController;
  private generation = 0;
  private currentContext: string | null = null;
  private automaticAttempt?: string;
  private unsubscribe?: () => void;
  private handler?: ScreenSpaceEventHandler;
  private releaseInteraction?: () => void;
  private suspensions = 0;
  private detection = false;
  private detectionOffset = 0;
  private detectionAnchor?: { center: Cartesian3; normal: Cartesian3; width: number; height: number };
  private lastRenderError?: string;
  private disposed = false;
  private stopWatching: () => void;

  constructor(private options: Options) {
    this.panel = new EngineeringComponentPanel({
      close: () => this.close(), connect: id => { void this.connect(id); }, disconnect: () => this.detach(true),
      scope: id => this.setScope(id), select: (id, group) => this.select(id, group), expand: id => { this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id); this.refresh(); },
      setState: (id, group, key, value) => this.setState(id, group, { [key]: value }),
      search: value => { this.search = value.trim().toLocaleLowerCase(); this.refresh(); }, locate: () => this.locate(), pick: enabled => this.setPicking(enabled),
      detection: (enabled, offset) => this.setDetection(enabled, offset), alignDetection: () => this.alignDetection(),
      photography: (targetId, enabled) => this.photography?.select(targetId, enabled),
      retryPhotography: () => this.photography?.retry(), cancelPhotography: () => this.photography?.cancel(),
      exportState: () => this.exportState(), importState: file => { void this.importState(file); },
    });
    this.stopWatching = options.viewer.scene.preUpdate.addEventListener(() => {
      if (!this.instance) return;
      if (this.instance.model.isDestroyed()) { this.detach(false); return; }
      // Constant-time guard; camera frames do not rebuild the tree or touch saved state.
      const permitted = this.currentContext !== null && this.currentContext === contextKey(options.getContext());
      this.adapter?.setExternalEnabled(permitted && this.instance.model.show && !this.suspensions);
      if (!permitted) { this.synchronize(); return; }
      this.photography?.check();
      const error = this.renderer?.getStats().error;
      if (error && (this.detection || error !== this.lastRenderError)) { this.lastRenderError = error; this.setDetection(false, this.detectionOffset); this.panel.setStatus(`遮挡检测失败：${error}`, true); }
    });
  }
  get activeInstanceId() { return this.instance?.id; }
  get isPicking() { return !!this.handler; }
  get snapshot() { return this.state?.serialize(); }
  get renderStats() { return this.renderer?.getStats(); }
  get photographyStats() { return this.photography?.status; }

  open() { this.synchronize(); this.panel.open(); }
  close() { this.cancelLoading(); this.setPicking(false); this.setDetection(false, this.detectionOffset); this.panel.close(); }
  private cancelLoading() { this.generation++; this.loading?.abort(); this.loading = undefined; this.panel.setBusy(false); }
  private canMutate() { return !this.disposed && !this.suspensions && this.currentContext !== null && this.currentContext === contextKey(this.options.getContext()); }
  synchronize() {
    if (this.disposed) return;
    const next = contextKey(this.options.getContext());
    if (next !== this.currentContext) { this.detach(false); this.currentContext = next; this.automaticAttempt = undefined; }
    const instances = next ? this.options.getInstances() : [];
    this.panel.setInstances(instances, this.instance?.id);
    if (!next) { this.panel.setStatus('当前项目或账号尚无工程模型访问权限。'); return; }
    if (this.instance && !instances.some(value => value.id === this.instance!.id && value.model === this.instance!.model)) this.detach(false);
    if (!this.instance && !this.loading && this.automaticAttempt !== next) {
      let id: string | null = null;
      try { id = localStorage.getItem(this.bindingKey()); } catch { /* Manual binding remains usable. */ }
      if (id && instances.some(value => value.id === id && value.model.ready)) { this.automaticAttempt = next; void this.connect(id); }
    }
  }
  private bindingKey() { return `engineering-component-binding:v1:${this.currentContext}`; }
  async connect(id: string) {
    if (this.disposed || this.suspensions) return;
    const context = this.options.getContext(), instance = this.options.getInstances().find(value => value.id === id);
    if (!context || !instance || instance.model.isDestroyed() || !instance.model.ready) { this.panel.setStatus('请先加载并定位交付 GLB，等待模型就绪后接入。', true); return; }
    this.detach(false);
    this.currentContext = contextKey(context);
    const epoch = ++this.generation, request = new AbortController(); this.loading = request;
    const check = () => { if (request.signal.aborted || epoch !== this.generation || !this.canMutate() || instance.model.isDestroyed() || !this.options.getInstances().some(value => value.id === id && value.model === instance.model)) throw abort(); };
    this.panel.setBusy(true); this.panel.setStatus('正在核对模型版本与构件对应关系…');
    let pendingAdapter: EngineeringRenderAdapter | undefined, pendingRenderer: EngineeringOcclusionRenderer | undefined, published = false;
    try {
      const response = await fetch('/__engineering-components/manifest', { signal: request.signal, cache: 'no-store' });
      const manifest = await response.json() as Manifest;
      if (!response.ok || !manifest.available) throw new Error(manifest.message ?? '工程构件资源尚未配置或当前账号不能访问。');
      check();
      // Only accept the actual selected model bytes. Matching names alone never establishes identity.
      const glbBytes = await controlledBytes(instance.url, request.signal);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', glbBytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      const unit = hash === manifest.fullModel.sha256 ? undefined : manifest.units.find(value => value.sha256 === hash);
      if (hash !== manifest.fullModel.sha256 && !unit) throw new Error('所选模型不是这份交付包的全线或单元 GLB；没有建立构件绑定。');
      const [catalogBytes, indexBytes] = await Promise.all([verifiedEngineeringBytes(manifest.catalog, request.signal), verifiedEngineeringBytes(manifest.index, request.signal)]);
      check();
      const catalog = parseEngineeringCatalog(JSON.parse(new TextDecoder().decode(catalogBytes)), { assetFingerprint: manifest.fingerprint, structureIndex: JSON.parse(new TextDecoder().decode(indexBytes)) });
      const header = new DataView(glbBytes);
      if (glbBytes.byteLength < 28 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== glbBytes.byteLength || header.getUint32(16, true) !== 0x4e4f534a || header.getUint32(12, true) > glbBytes.byteLength - 20) throw new Error('模型不是完整的 GLB 2.0');
      const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(glbBytes, 20, header.getUint32(12, true))));
      const mappings = createEngineeringModelBindings(catalog, gltf, unit ? { unitId: unit.id } : {});
      check();
      const state = new EngineeringComponentState(catalog, { ...context, instanceId: id });
      let restoreWarning = '';
      try { const saved = localStorage.getItem(state.storageKey); if (saved) state.restore(saved); }
      catch (error) { restoreWarning = `；旧显示状态未应用：${textError(error)}`; }
      pendingAdapter = new EngineeringRenderAdapter(this.options.viewer, instance.model, mappings.bindings);
      pendingRenderer = new EngineeringOcclusionRenderer(this.options.viewer); pendingRenderer.add(pendingAdapter); pendingRenderer.setEnabled(false);
      check();
      this.catalog = catalog; this.state = state; this.instance = instance; this.adapter = pendingAdapter; this.renderer = pendingRenderer;
      published = true;
      pendingAdapter = undefined; pendingRenderer = undefined;
      this.ids = new Set(mappings.bindings.map(value => value.componentId));
      this.reviewScope = unit ? { kind: 'unit', id: unit.id } : { kind: 'all' };
      this.expanded = new Set(catalog.rootGroupIds); this.search = ''; this.lastRenderError = undefined;
      const units = [...catalog.unitMembers.keys()].filter(key => catalog.getMembers({ kind: 'unit', id: key }).some(value => this.ids.has(value))).map(key => ({ id: key, name: key === 'A001' ? 'A001# 墩 · 样板' : key === 'TN021' ? 'TN021 隧道 · 样板' : key }));
      this.panel.setBound(true, units); this.panel.setScope(unit?.id ?? 'all');
      this.photography = new EngineeringPhotographyController({
        viewer: this.options.viewer, model: instance.model, bytes: glbBytes,
        bindings: mappings.bindings.filter(binding => catalog.itemsById.get(binding.componentId)?.kind !== 'reference'), state,
        getTargets: () => this.options.getPhotographyTargets?.() ?? [], canMutate: () => this.canMutate(),
        onTargets: (items, selected, enabled) => this.panel.setPhotographyTargets(items, selected, enabled),
        onStatus: (message, error, busy) => this.panel.setPhotographyStatus(message, error, busy),
      });
      this.applyRenderState([...this.ids]);
      if (state.selectedId && this.ids.has(state.selectedId)) this.select(state.selectedId, false);
      this.unsubscribe = state.subscribe(change => { this.applyRenderState(change.componentIds); this.photography?.updateFlags(); if (change.selectionChanged) this.adapter?.setSelection(state.selectedId ? [state.selectedId] : []); this.save(); this.refresh(); });
      try { localStorage.setItem(this.bindingKey(), id); } catch { restoreWarning += '；浏览器未允许保存接入状态'; }
      this.refresh(); this.panel.setStatus(`已核验接入 ${mappings.bindings.length.toLocaleString()} 个对象，源模型结构保持原样${restoreWarning}`);
    } catch (error) {
      pendingRenderer?.dispose(); pendingAdapter?.dispose();
      if (epoch === this.generation) {
        if (published) this.detach(false);
        if ((error as Error)?.name !== 'AbortError') this.panel.setStatus(textError(error), true);
      }
    }
    finally { if (this.loading === request) { this.loading = undefined; this.panel.setBusy(false); } }
  }

  private members(scope = this.reviewScope): string[] { return this.catalog ? this.catalog.getMembers(scope).filter(id => this.ids.has(id)) : []; }
  private inView() { return new Set(this.members()); }
  private applyRenderState(ids: readonly string[]) {
    if (!this.state || !this.adapter) return;
    const inView = this.reviewScope.kind === 'all' ? this.ids : this.inView();
    this.adapter.applyStates(ids.filter(id => this.ids.has(id)).map(id => { const flags = this.state!.get(id); return { componentId: id, visible: flags.visible && (inView.has(id) || this.reviewScope.kind === 'all'), occlusion: flags.occlusionEnabled && inView.has(id) }; }));
  }
  private setScope(id: string) {
    if (!this.catalog || !this.state || !this.canMutate()) return;
    if (id !== 'all' && !this.catalog.unitMembers.has(id)) return;
    this.reviewScope = id === 'all' ? { kind: 'all' } : { kind: 'unit', id };
    this.selectedScope = undefined; this.state.select(null); this.applyRenderState([...this.ids]);
    if (id !== 'all') for (const component of this.members()) for (const ancestor of this.catalog.getAncestors(component)) this.expanded.add(ancestor);
    this.panel.setScope(id); this.refresh(); this.locate(); if (this.detection) this.alignDetection();
  }
  private setState(id: string | null, group: boolean, patch: Partial<EngineeringFlags>) {
    if (!this.state || !this.canMutate()) return;
    const scope: EngineeringScope = id === null ? this.reviewScope : { kind: group ? 'group' : 'component', id };
    const members = this.members(scope), view = this.inView();
    const targets = members.filter(member => (this.reviewScope.kind === 'all' || view.has(member)) && (patch.occlusionEnabled === undefined || this.catalog?.itemsById.get(member)?.kind !== 'reference'));
    try { this.state.applyIds(targets, patch); } catch (error) { this.options.toast(textError(error), true); }
  }
  private select(id: string, group: boolean) {
    if (!this.catalog || !this.state || !this.canMutate()) return;
    this.selectedScope = { kind: group ? 'group' : 'component', id };
    if (group) this.state.select(null);
    else { this.state.select(id); for (const ancestor of this.catalog.getAncestors(id)) this.expanded.add(ancestor); this.adapter?.setSelection([id]); }
    this.refresh(); if (!group) this.panel.reveal(id);
  }
  private summary(ids: readonly string[]): EngineeringSummary {
    let visible = 0, occlusion = 0;
    for (const id of ids) { const state = this.state!.get(id); visible += Number(state.visible); occlusion += Number(state.occlusionEnabled); }
    const mixed = (value: number) => value === 0 ? false : value === ids.length ? true : 'mixed';
    return { count: ids.length, visible: mixed(visible), occlusionEnabled: mixed(occlusion) };
  }
  private refresh() {
    const catalog = this.catalog, state = this.state; if (!catalog || !state) return;
    const members = this.members(), included = new Set(members), rows: EngineeringTreeRow[] = [];
    if (this.reviewScope.kind === 'all') for (const item of catalog.references) if (this.ids.has(item.id)) included.add(item.id);
    const groupMembers = new Map<string, string[]>();
    for (const group of catalog.groups) groupMembers.set(group.id, catalog.getMembers({ kind: 'group', id: group.id }).filter(id => included.has(id)));
    const visit = (id: string, depth: number) => {
      const group = catalog.groupsById.get(id);
      if (group) {
        const ids = groupMembers.get(id)!; if (!ids.length) return;
        if (this.search) { for (const child of catalog.childrenByGroup.get(id) ?? []) visit(child, depth); return; }
        rows.push({ id, name: group.name, depth, group: true, expanded: this.expanded.has(id), selected: this.selectedScope?.kind === 'group' && this.selectedScope.id === id, reference: ids.every(member => catalog.itemsById.get(member)?.kind === 'reference'), ...this.summary(ids) });
        if (this.expanded.has(id)) for (const child of catalog.childrenByGroup.get(id) ?? []) visit(child, depth + 1);
      } else {
        const item = catalog.itemsById.get(id); if (!item || !included.has(id)) return;
        if (this.search && ![item.id, item.name, item.typeName, item.unitId ?? ''].join(' ').toLocaleLowerCase().includes(this.search)) return;
        rows.push({ id, name: item.name, depth: this.search ? 0 : depth, group: false, expanded: false, selected: state.selectedId === id, count: 1, ...state.get(id), reference: item.kind === 'reference' });
      }
    };
    for (const root of catalog.rootGroupIds) visit(root, 0);
    this.panel.setRows(rows, this.summary(members), this.reviewScope.kind === 'all' ? '全线' : this.reviewScope.id);
    const selected = state.selectedId && catalog.itemsById.get(state.selectedId);
    this.panel.setSelection(selected ? `${selected.name} · ${selected.id}\n${selected.typeName}${selected.unitId ? ' · 单元 ' + selected.unitId : ''}${selected.designStatus ? '\n' + selected.designStatus : ''}` : this.selectedScope?.kind === 'group' ? `${catalog.groupsById.get(this.selectedScope.id)?.name} · 分组` : '未选择构件');
  }
  private save() {
    if (!this.state) return;
    try { localStorage.setItem(this.state.storageKey, JSON.stringify(this.state.serialize())); this.panel.setSaved('显示状态已保存到本机浏览器'); }
    catch { this.panel.setSaved('自动保存失败，请导出状态'); }
  }
  private bounds(): BoundingSphere | undefined {
    if (!this.adapter) return;
    let result: BoundingSphere | undefined;
    const inView = this.inView();
    for (const id of this.members(this.selectedScope ?? this.reviewScope)) {
      if (this.reviewScope.kind !== 'all' && !inView.has(id)) continue;
      const next = this.adapter.getComponentBounds(id); if (next) result = result ? BoundingSphere.union(result, next, result) : BoundingSphere.clone(next);
    }
    return result;
  }
  private locate() { if (!this.canMutate()) return; const sphere = this.bounds(); if (sphere) this.options.viewer.camera.flyToBoundingSphere(sphere, { duration: 0.7, offset: new HeadingPitchRange(this.options.viewer.camera.heading, -0.45, Math.max(8, sphere.radius * 3.5)) }); }
  private setPicking(enabled: boolean) {
    if (this.handler) { this.handler.destroy(); this.handler = undefined; }
    this.releaseInteraction?.(); this.releaseInteraction = undefined; this.panel.setPick(false);
    if (!enabled || !this.adapter || !this.canMutate()) return;
    try {
      if (!this.options.canPick()) throw new Error('请先结束当前绘制、放置或编辑，再选择构件。');
      this.releaseInteraction = this.options.beginInteractionSession();
      this.handler = new ScreenSpaceEventHandler(this.options.viewer.scene.canvas);
      this.handler.setInputAction((event: { position: Cartesian2 }) => {
        if (!this.options.canPick() || !this.canMutate() || !this.instance?.model.show) return;
        const id = this.adapter?.componentIdFromPick(this.options.viewer.scene.pick(event.position));
        if (id && this.state?.get(id).visible && this.inView().has(id)) this.select(id, false);
      }, ScreenSpaceEventType.LEFT_CLICK);
      this.panel.setPick(true);
    } catch (error) { this.releaseInteraction?.(); this.releaseInteraction = undefined; this.options.toast(textError(error), true); }
  }
  private alignDetection() {
    if (!this.canMutate()) return;
    const sphere = this.bounds(); if (!sphere) return;
    this.detectionAnchor = { center: Cartesian3.clone(sphere.center), normal: Cartesian3.clone(this.options.viewer.camera.directionWC), width: Math.max(4, sphere.radius * 2.5), height: Math.max(4, sphere.radius * 2.5) };
    this.setDetection(this.detection, this.detectionOffset);
  }
  private setDetection(enabled: boolean, offset: number) {
    if (enabled && !this.canMutate()) { this.panel.setDetection(this.detection); return; }
    this.detection = enabled; this.detectionOffset = Number.isFinite(offset) ? Math.max(-200, Math.min(200, offset)) : 0;
    if (enabled && !this.detectionAnchor) { this.alignDetection(); return; }
    if (this.detectionAnchor && this.renderer) {
      const anchor = this.detectionAnchor, center = Cartesian3.add(anchor.center, Cartesian3.multiplyByScalar(anchor.normal, this.detectionOffset, new Cartesian3()), new Cartesian3());
      this.renderer.setDetectionPlane({ ...anchor, center });
    }
    this.renderer?.setEnabled(enabled && !this.suspensions); this.panel.setDetection(enabled);
    if (enabled && this.lastRenderError) { this.lastRenderError = undefined; this.panel.setStatus('已重新开启独立遮挡检测。'); }
  }
  suspendExternalSceneEffects(): () => void {
    this.suspensions++; this.cancelLoading(); this.setPicking(false);
    const adapter = this.adapter, renderer = this.renderer, photography = this.photography;
    const releases: (() => void)[] = [];
    const restore = () => {
      const errors: unknown[] = [];
      for (const release of releases.splice(0).reverse()) { try { release(); } catch (error) { errors.push(error); } }
      this.suspensions = Math.max(0, this.suspensions - 1);
      if (this.adapter === adapter) {
        try { this.adapter?.setExternalEnabled(!this.suspensions); } catch (error) { errors.push(error); }
        try { photography?.setSuspended(!!this.suspensions); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, '工程构件场景恢复失败。');
    };
    try {
      photography?.setSuspended(true);
      if (adapter) releases.push(adapter.suspend());
      if (renderer) releases.push(renderer.suspend());
    } catch (error) {
      try { restore(); } catch (restoreError) { throw new AggregateError([error, restoreError], '工程构件场景暂停及恢复失败。'); }
      throw error;
    }
    let restored = false;
    return () => { if (restored) return; restored = true; restore(); };
  }
  detachInstance(id: string) { if (this.instance?.id === id) this.detach(false); }
  private detach(forget: boolean) {
    this.cancelLoading(); this.setPicking(false); this.unsubscribe?.(); this.unsubscribe = undefined;
    this.photography?.dispose(); this.photography = undefined;
    this.renderer?.dispose(); this.renderer = undefined; this.adapter?.dispose(); this.adapter = undefined;
    this.instance = undefined; this.catalog = undefined; this.state = undefined; this.ids.clear(); this.detectionAnchor = undefined; this.detection = false; this.selectedScope = undefined;
    this.panel.setBound(false); this.panel.setDetection(false); this.panel.setStatus('选择已加载的重构模型，核验后接入构件。');
    this.panel.setPhotographyTargets([], '', true); this.panel.setPhotographyStatus('接入工程模型后，选择关联倾斜摄影。');
    if (forget && this.currentContext) { try { localStorage.removeItem(this.bindingKey()); } catch { /* Current binding is still released. */ } this.automaticAttempt = this.currentContext; }
  }
  private exportState() {
    if (!this.state) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.state.serialize(), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = '工程构件显示与遮挡状态.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async importState(file: File) { try { if (file.size > 1_000_000) throw new Error('状态文件过大'); const target = this.state; const raw = await file.text(); if (!target || target !== this.state || !this.canMutate()) return; target.restore(raw); this.save(); this.refresh(); } catch (error) { this.options.toast(textError(error), true); } }
  dispose() { if (this.disposed) return; this.disposed = true; this.detach(false); this.stopWatching(); this.panel.destroy(); }
}
