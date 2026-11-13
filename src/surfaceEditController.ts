import {
  Cartesian2, Cartesian3, Color, CustomDataSource, Matrix4,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms,
  type Cesium3DTileset, type Viewer,
} from 'cesium';
import polygonClipping from 'polygon-clipping';
import { pickMachinerySurface } from './machinerySurfacePicker';
import { withPlanningSurface } from './temporaryWorksScene';
import { SurfaceEditPanel } from './surfaceEditPanel';
import { SurfaceEditScene, type SurfaceEditHandle } from './surfaceEditScene';
import { SurfaceEditStore, validateSurfaceEditPlans } from './surfaceEditStore';
import { estimateSurfaceEditGeometry, type SurfaceEditGeometryInput } from './surfaceEditGeometry';
import { refineSurfaceEditBoundary, runSurfaceEditGeometry, estimateBoundarySampling } from './surfaceEditJobs';
import { SURFACE_EDIT_LIMITS, type SurfaceEditDraft, type SurfaceEditPlan, type SurfaceEditPoint } from './surfaceEditTypes';

export type SurfaceEditTarget = { id: string; name: string; tileset: Cesium3DTileset };
type Options = {
  viewer: Viewer;
  root: HTMLElement;
  getTargets(): SurfaceEditTarget[];
  getContext(): string | null;
  canEdit(): boolean;
  beginInteractionSession(): () => void;
  onChanged?(): void;
  onVisibilityChange?(id: string, visible: boolean): void;
  toast(message: string, error?: boolean): void;
};
const abortError = () => new DOMException('地表编辑任务已取消', 'AbortError');
const clone = <T>(value: T): T => structuredClone(value);
function targetTransform(target: Cesium3DTileset): number[] {
  return [...Matrix4.toArray(target.modelMatrix), ...Matrix4.toArray(target.root.transform)];
}
function sameTransform(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}
function localGeometry(plan: SurfaceEditPlan) {
  const anchor = plan.boundary[0];
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, plan.targetHeight));
  const inverse = Matrix4.inverse(frame, new Matrix4());
  const local = (p: SurfaceEditPoint) => {
    const v = Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(p.longitude, p.latitude, p.height), new Cartesian3());
    return { x: v.x, y: v.y, z: v.z };
  };
  const input: SurfaceEditGeometryInput = { mode: plan.kind, outer: plan.boundary.map(local), holes: plan.holes.map(r => r.map(local)),
    targetElevation: 0, textureScaleMeters: plan.texture.scaleMeters };
  estimateSurfaceEditGeometry(input);
  return { frame, input };
}
function footprint(plan: SurfaceEditPlan): polygonClipping.Polygon {
  return [plan.boundary, ...plan.holes].map(r => r.map(p => [p.longitude, p.latitude] as polygonClipping.Pair));
}
/** First release rejects intersecting active plans rather than covering an excavation
 * with a flattening floor. Adjacent boundaries and preserved islands remain allowed. */
export function assertSurfaceEditNoOverlap(plan: SurfaceEditPlan, others: readonly SurfaceEditPlan[]) {
  if (!plan.enabled) return;
  for (const other of others) {
    if (other.id === plan.id || !other.enabled) continue;
    if (polygonClipping.intersection(footprint(plan), footprint(other)).length)
      throw new Error(`与“${other.name}”的启用范围重叠，请调整边界或先关闭该方案。`);
  }
}

/** Owns only the new feature. Old import records, storage and editing handlers are untouched. */
export class SurfaceEditController {
  private readonly scene: SurfaceEditScene;
  private readonly panel: SurfaceEditPanel;
  private readonly store = new SurfaceEditStore();
  private readonly drawing = new CustomDataSource('surface-edit-drawing');
  private plans: SurfaceEditPlan[] = [];
  private readonly handles = new Map<string, SurfaceEditHandle>();
  private readonly states = new Map<string, string>();
  private readonly attempts = new Map<string, Cesium3DTileset>();
  private context: string | null = null;
  private editable = false;
  private storageHealthy = true;
  private revision = 0;
  private task: AbortController | undefined;
  private mutation = false;
  private restoring = false;
  private restoreRequested = false;
  private workEpoch = 0;
  private disposed = false;
  private suspensions = 0;
  private editingId: string | undefined;
  private boundary: SurfaceEditPoint[] = [];
  private holes: SurfaceEditPoint[][] = [];
  private drawHandler: ScreenSpaceEventHandler | undefined;
  private drawCleanup: (() => void) | undefined;
  private drawKey: ((event: KeyboardEvent) => void) | undefined;
  private readonly overrides = new Map<string, boolean>();

  constructor(private readonly options: Options) {
    this.scene = new SurfaceEditScene(options.viewer, { onStatus: () => this.renderList() });
    void options.viewer.dataSources.add(this.drawing);
    this.panel = new SurfaceEditPanel({
      root: options.root, getTargets: () => options.getTargets().map(({ id, name }) => ({ id, name })),
      canEdit: () => this.canMutate(),
      onDraw: mode => this.startDrawing(mode), onClearBoundary: () => this.clearBoundary(),
      onGenerate: draft => this.generate(draft), onCancel: () => this.cancel(),
      onToggle: (id, enabled) => this.setEnabled(id, enabled), onDelete: id => this.removePlan(id),
      onLocate: id => this.locatePlan(id), onEdit: id => this.editPlan(id), onNew: () => this.newPlan(),
      onClose: () => this.close(), onDraftChanged: () => this.cancel(),
    });
    this.panel.setEditable(false);
    this.panel.setStatus('请先选择具有查看权限的项目。');
  }

  private canMutate() { return !!this.context && this.options.getContext() === this.context && this.editable && this.storageHealthy && this.options.canEdit() && !this.disposed; }
  private assertEditable() { if (!this.canMutate()) throw new Error('当前项目不可编辑，或保存记录需要先修复。'); }
  private report(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') { this.panel.setStatus('任务已取消，原场景保持不变。'); return; }
    const message = error instanceof Error ? error.message : String(error);
    this.panel.setStatus(message, true); this.options.toast(message, true);
  }
  private renderList() {
    if (!this.panel || this.disposed) return;
    this.panel.setPlans(this.plans.map(p => ({ id: p.id, name: p.name, kind: p.kind, enabled: p.enabled,
      status: this.states.get(p.id) ?? this.handles.get(p.id)?.status.message ?? '等待关联摄影图层' })));
  }
  private changed() { this.renderList(); this.options.onChanged?.(); }

  setContext(context: string | null, editable: boolean) {
    if (this.disposed) return;
    if (context === this.context) {
      if (this.editable && !editable) this.cancel();
      this.editable = editable; this.panel.setEditable(this.canMutate()); this.refreshTargets(); return;
    }
    this.revision++; this.cancel(); this.context = context; this.editable = editable; this.storageHealthy = true;
    this.handles.forEach(h => h.destroy()); this.handles.clear(); this.attempts.clear(); this.states.clear(); this.overrides.clear();
    this.plans = []; this.editingId = undefined; this.boundary = []; this.holes = []; this.drawing.entities.removeAll();
    this.panel.fill(); this.panel.setBoundary(0, 0);
    if (context) {
      try { this.plans = this.store.load(context); }
      catch (error) { this.storageHealthy = false; this.report(error); }
    } else this.panel.setStatus('当前项目没有地表编辑查看权限。');
    this.panel.setEditable(this.canMutate()); this.changed(); this.refreshTargets();
  }
  refreshTargets() {
    if (this.disposed) return;
    this.panel.refreshTargets();
    this.restoreRequested = true;
    void this.restoreAvailable();
  }
  private async restoreAvailable() {
    if (this.restoring || this.task || this.mutation || !this.context || !this.storageHealthy || this.disposed || this.suspensions) return;
    this.restoring = true;
    this.restoreRequested = false;
    const revision = this.revision;
    const epoch = this.workEpoch;
    let attempted = false;
    try {
      for (const plan of this.plans) {
        if (revision !== this.revision || epoch !== this.workEpoch || this.task || this.disposed || this.suspensions || this.options.getContext() !== this.context) break;
        const target = this.options.getTargets().find(t => t.id === plan.targetId);
        if (!target || !plan.enabled || this.overrides.get(plan.id) === false) continue;
        if (this.handles.has(plan.id) && this.attempts.get(plan.id) === target.tileset) continue;
        if (this.attempts.get(plan.id) === target.tileset) continue;
        attempted = true;
        this.attempts.set(plan.id, target.tileset);
        const controller = new AbortController(); this.task = controller;
        let handle: SurfaceEditHandle | undefined;
        try {
          if (!sameTransform(plan.targetTransform, targetTransform(target.tileset))) throw new Error('摄影位置已改变，请编辑并重新生成。');
          assertSurfaceEditNoOverlap(plan, this.plans);
          const { frame, input } = localGeometry(plan);
          const result = await runSurfaceEditGeometry(input, controller.signal);
          handle = await this.scene.prepare(plan, result, frame, target.tileset, controller.signal);
          if (controller.signal.aborted || revision !== this.revision || epoch !== this.workEpoch || !this.context || this.options.getContext() !== this.context || this.suspensions
            || !this.plans.find(p => p.id === plan.id)?.enabled || this.overrides.get(plan.id) === false) throw abortError();
          if (this.options.getTargets().find(t => t.id === plan.targetId)?.tileset !== target.tileset
            || !sameTransform(plan.targetTransform, targetTransform(target.tileset))) throw new Error('关联摄影或其位置已变化，请重新生成。');
          const state = handle.setEnabled(true);
          if (state.state === 'blocked' || state.state === 'error') throw new Error(state.message);
          this.handles.get(plan.id)?.destroy(); this.handles.set(plan.id, handle); handle = undefined;
          this.states.delete(plan.id);
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError' && this.attempts.get(plan.id) === target.tileset)
            this.attempts.delete(plan.id);
          if (revision === this.revision && !(error instanceof DOMException && error.name === 'AbortError'))
            this.states.set(plan.id, error instanceof Error ? error.message : String(error));
        } finally { handle?.destroy(); if (this.task === controller) this.task = undefined; }
      }
    } finally {
      this.restoring = false;
      if (attempted) this.changed();
      if (!this.disposed && (revision !== this.revision || this.restoreRequested)) void this.restoreAvailable();
    }
  }

  open() { this.setContext(this.options.getContext(), this.options.canEdit()); this.options.root.classList.remove('hidden'); this.refreshTargets(); }
  close() { this.cancel(); this.options.root.classList.add('hidden'); }
  cancel() {
    this.workEpoch++; this.restoreRequested = false;
    this.task?.abort(); this.task = undefined; this.endDrawing();
    this.panel?.setBusy(null);
  }
  /** Releases use current state, not snapshots of old objects or old projects. */
  suspendExternalSceneEffects(): () => void {
    this.cancel(); this.suspensions++; this.scene.setSuspended(true);
    let released = false;
    return () => {
      if (released) return; released = true; this.suspensions = Math.max(0, this.suspensions - 1);
      if (this.disposed) return;
      this.scene.setSuspended(this.suspensions > 0);
      if (!this.suspensions) this.refreshTargets();
    };
  }
  private newPlan() { this.cancel(); this.editingId = undefined; this.clearBoundary(); this.panel.fill(); }
  editPlan(id: string) {
    const plan = this.plans.find(p => p.id === id); if (!plan) return;
    this.cancel(); this.editingId = id; this.boundary = clone(plan.boundary); this.holes = clone(plan.holes);
    this.panel.fill(plan); this.panel.setBoundary(this.boundary.length + this.holes.flat().length, this.holes.length);
    this.open();
  }
  private clearBoundary() {
    this.cancel(); this.boundary = []; this.holes = []; this.drawing.entities.removeAll(); this.panel.setBoundary(0, 0);
  }
  private endDrawing() {
    this.drawHandler?.destroy(); this.drawHandler = undefined;
    if (this.drawKey) document.removeEventListener('keydown', this.drawKey); this.drawKey = undefined;
    const cleanup = this.drawCleanup; this.drawCleanup = undefined; cleanup?.();
    this.drawing.entities.removeAll();
  }
  private startDrawing(mode: 'polygon' | 'rectangle' | 'hole') {
    try {
      this.assertEditable(); this.cancel();
      const target = this.options.getTargets().find(t => t.id === this.panel.getSelectedTargetId());
      if (!target) throw new Error('请先加载并选择倾斜摄影图层。');
      if (mode === 'hole' && this.boundary.length < 3) throw new Error('请先绘制外边界，再绘制内部保留区。');
      if (mode === 'hole' && this.holes.length >= SURFACE_EDIT_LIMITS.holes) throw new Error('保留区数量已达上限。');
      const revision = this.revision, matrix = targetTransform(target.tileset);
      const resume = this.options.beginInteractionSession();
      let release: (() => void) | undefined;
      try { release = this.suspendExternalSceneEffects(); } catch (error) { resume(); throw error; }
      this.drawCleanup = () => { try { release?.(); } finally { resume(); } };
      const points: SurfaceEditPoint[] = [];
      const finish = () => {
        this.assertEditable();
        if (revision !== this.revision || target.tileset.isDestroyed() || this.options.getTargets().find(t => t.id === target.id)?.tileset !== target.tileset
          || !sameTransform(matrix, targetTransform(target.tileset))) throw new Error('项目或摄影位置已变化，请重新绘制。');
        if (points.length < (mode === 'rectangle' ? 2 : 3)) throw new Error('边界点不足，请继续取点。');
        let ring = points;
        if (mode === 'rectangle') {
          const [a, b] = points;
          if (Math.abs(a.longitude - b.longitude) < 1e-9 || Math.abs(a.latitude - b.latitude) < 1e-9) throw new Error('矩形宽度或长度过小，请重新绘制。');
          ring = [a, { longitude: b.longitude, latitude: a.latitude, height: (a.height + b.height) / 2 }, b,
            { longitude: a.longitude, latitude: b.latitude, height: (a.height + b.height) / 2 }];
        }
        if (mode === 'hole') this.holes.push(clone(ring)); else { this.boundary = clone(ring); this.holes = []; }
        this.endDrawing();
        this.panel.setBoundary(this.boundary.length + this.holes.flat().length, this.holes.length, '范围已绘制，可调整标高后生成。');
      };
      this.drawHandler = new ScreenSpaceEventHandler(this.options.viewer.canvas);
      this.drawHandler.setInputAction(({ position }: { position: Cartesian2 }) => {
        try {
          this.assertEditable();
          if (revision !== this.revision || target.tileset.isDestroyed() || !sameTransform(matrix, targetTransform(target.tileset))) throw new Error('项目或摄影位置已变化，请重新绘制。');
          const count = points.length + (mode === 'hole' ? this.boundary.length + this.holes.flat().length : 0);
          if (count >= SURFACE_EDIT_LIMITS.drawPoints) throw new Error('绘制点数已达上限，请减少细碎点或分区。');
          const hit = pickMachinerySurface(this.options.viewer, position, [{ kind: 'photogrammetry', resource: target.tileset, visible: true }]);
          if (!hit) throw new Error('此处未取到选定摄影表面，请等待模型加载并在其表面取点。');
          const point = { longitude: hit.longitude, latitude: hit.latitude, height: hit.height };
          points.push(point);
          this.drawing.entities.add({ position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
            point: { color: Color.ORANGE, pixelSize: 7, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
          this.panel.setStatus(`已取 ${points.length} 点；${mode === 'rectangle' ? '再取对角点完成矩形' : '右键完成，Esc 取消'}。`);
          if (mode === 'rectangle' && points.length === 2) finish();
        } catch (error) { this.report(error); }
      }, ScreenSpaceEventType.LEFT_CLICK);
      this.drawHandler.setInputAction(() => { try { finish(); } catch (error) { this.report(error); } }, ScreenSpaceEventType.RIGHT_CLICK);
      this.drawKey = event => { if (event.key === 'Escape') { event.preventDefault(); this.cancel(); this.panel.setStatus('已取消绘制，原范围保留。'); } };
      document.addEventListener('keydown', this.drawKey);
      this.panel.setStatus('请在选定摄影上取点，右键完成，Esc 取消。');
    } catch (error) { this.endDrawing(); this.report(error); }
  }

  private async generate(draft: SurfaceEditDraft) {
    if (this.mutation) return;
    let candidate: SurfaceEditHandle | undefined;
    const controller = new AbortController();
    const revision = this.revision, context = this.context;
    try {
      this.assertEditable(); this.cancel();
      if (this.suspensions) throw new Error('请先退出视频 AR 或其他占用场景的操作，再生成地表。');
      if (this.boundary.length < 3) throw new Error('请先绘制开挖或压平范围。');
      const target = this.options.getTargets().find(t => t.id === draft.targetId);
      if (!target) throw new Error('选定摄影已隐藏或卸载。');
      const matrix = targetTransform(target.tileset);
      this.mutation = true; this.task = controller;
      const deadline = setTimeout(() => controller.abort(new Error('生成超时，请缩小范围或使用已知边界标高。')), SURFACE_EDIT_LIMITS.taskTimeoutMs);
      try {
        const before = this.plans.find(p => p.id === this.editingId), now = new Date().toISOString();
        let rings = clone([this.boundary, ...this.holes]);
        const progress = (event: { message: string }) => {
          if (!controller.signal.aborted && revision === this.revision && this.task === controller && this.options.getContext() === context)
            this.panel.setBusy(event.message);
        };
        const others = this.plans.filter(p => p.id !== before?.id);
        if (others.length >= SURFACE_EDIT_LIMITS.plans) throw new Error('已达地表方案数量上限，请先删除不需要的方案。');
        const remaining = Math.min(SURFACE_EDIT_LIMITS.boundaryPoints,
          SURFACE_EDIT_LIMITS.totalBoundaryPoints - others.reduce((sum, p) => sum + p.boundary.length + p.holes.reduce((n, r) => n + r.length, 0), 0));
        if (remaining < rings.reduce((sum, r) => sum + r.length, 0)) throw new Error('项目累计边界点数将超限，请减少范围点或删除不需要的方案。');
        const provisional: SurfaceEditPlan = { version: 1, id: before?.id ?? crypto.randomUUID(), name: draft.name.trim(), kind: draft.kind,
          targetId: draft.targetId, targetTransform: matrix, boundary: rings[0], holes: rings.slice(1), targetHeight: draft.targetHeight,
          clipTerrain: draft.clipTerrain, bottomVisible: draft.bottomVisible, texture: clone(draft.texture), enabled: true,
          createdAt: before?.createdAt ?? now, updatedAt: now };
        validateSurfaceEditPlans([...others, provisional]); assertSurfaceEditNoOverlap(provisional, others);
        if (draft.boundarySource === 'manual') rings = rings.map(r => r.map(p => ({ ...p, height: draft.boundaryHeight })));
        if (draft.boundarySource === 'sampled') {
          estimateBoundarySampling(rings, { outputPoints: remaining });
          this.panel.setBusy('准备边界高程取样…');
          rings = await withPlanningSurface(this.options.viewer, target.tileset, { signal: controller.signal },
            (sample, surfaceSignal) => refineSurfaceEditBoundary(rings, async (points, signal) => {
              if (signal.aborted || controller.signal.aborted || surfaceSignal.aborted) throw abortError();
              const values = await sample(points);
              if (signal.aborted || controller.signal.aborted || surfaceSignal.aborted) throw abortError();
              if (values.some(v => v === null || !Number.isFinite(v))) throw new Error('边界部分位置没有有效摄影高程，请调整边界或输入已知标高。');
              return values as number[];
            }, AbortSignal.any([controller.signal, surfaceSignal]), progress, { outputPoints: remaining }));
        }
        const plan: SurfaceEditPlan = { ...provisional, boundary: rings[0], holes: rings.slice(1) };
        const next = [...this.plans.filter(p => p.id !== plan.id), plan];
        validateSurfaceEditPlans(next); assertSurfaceEditNoOverlap(plan, this.plans);
        const { frame, input } = localGeometry(plan);
        this.panel.setBusy('检查预算并生成土体表面…');
        const result = await runSurfaceEditGeometry(input, controller.signal, progress);
        this.panel.setBusy('准备三维显示…');
        candidate = await this.scene.prepare(plan, result, frame, target.tileset, controller.signal);
        this.assertEditable();
        if (controller.signal.aborted || revision !== this.revision || context !== this.context) throw abortError();
        if (this.options.getTargets().find(t => t.id === plan.targetId)?.tileset !== target.tileset) throw new Error('摄影可见性或访问权限已变化，请重新选择。');
        if (!sameTransform(matrix, targetTransform(target.tileset))) throw new Error('摄影位置在生成期间变化，请重新生成。');
        const status = candidate.setEnabled(true);
        if (status.state === 'blocked' || status.state === 'error') throw new Error(status.message);
        this.store.save(context!, next);
        this.handles.get(plan.id)?.destroy(); this.handles.set(plan.id, candidate); candidate = undefined;
        this.plans = next; this.states.delete(plan.id); this.attempts.set(plan.id, target.tileset); this.overrides.delete(plan.id);
        this.editingId = plan.id; this.boundary = clone(plan.boundary); this.holes = clone(plan.holes);
        this.options.onVisibilityChange?.(plan.id, true);
        this.panel.setBoundary(result.boundaryPoints, plan.holes.length);
        this.panel.setStatus(`已保存：边界 ${result.boundaryPoints} 点，面积 ${result.area.toFixed(1)} ㎡。`);
        this.changed();
      } finally { clearTimeout(deadline); }
    } catch (error) { if (revision === this.revision) this.report(controller.signal.aborted ? controller.signal.reason ?? error : error); }
    finally {
      candidate?.destroy(); if (this.task === controller) this.task = undefined;
      this.mutation = false; if (revision === this.revision) this.panel.setBusy(null);
      if (!this.disposed && (revision !== this.revision || this.restoreRequested)) this.refreshTargets();
    }
  }

  async setEnabled(id: string, enabled: boolean) {
    try {
      this.assertEditable(); this.cancel();
      const plan = this.plans.find(p => p.id === id); if (!plan) return;
      const nextPlan = { ...plan, enabled, updatedAt: new Date().toISOString() };
      assertSurfaceEditNoOverlap(nextPlan, this.plans);
      const next = this.plans.map(p => p.id === id ? nextPlan : p);
      this.store.save(this.context!, next); this.plans = next; this.overrides.delete(id); this.states.delete(id);
      this.handles.get(id)?.setEnabled(enabled); if (enabled && !this.handles.has(id)) this.attempts.delete(id);
      this.options.onVisibilityChange?.(id, enabled);
      this.changed(); this.refreshTargets();
    } catch (error) { this.report(error); }
  }
  async removePlan(id: string): Promise<boolean> {
    try {
      this.assertEditable(); this.cancel(); const next = this.plans.filter(p => p.id !== id);
      this.store.save(this.context!, next); this.plans = next;
      this.handles.get(id)?.destroy(); this.handles.delete(id); this.states.delete(id); this.attempts.delete(id); this.overrides.delete(id);
      if (this.editingId === id) this.newPlan(); this.changed(); return true;
    } catch (error) { this.report(error); return false; }
  }
  locatePlan(id: string) { this.handles.get(id)?.zoom(); }
  getDisplayItems() { return this.plans.map(p => ({ id: p.id, name: p.name, visible: p.enabled, typeName: p.kind === 'excavation' ? '地表开挖' : '局部压平' })); }
  setPlanVisible(id: string, visible: boolean) {
    if (this.overrides.get(id) === visible) return;
    this.overrides.set(id, visible);
    const plan = this.plans.find(p => p.id === id);
    this.handles.get(id)?.setEnabled(visible && !!plan?.enabled);
    if (visible && !this.handles.has(id)) { this.attempts.delete(id); this.refreshTargets(); }
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true; this.revision++; this.cancel(); this.handles.forEach(h => h.destroy()); this.handles.clear(); this.scene.destroy();
    this.panel.destroy(); if (!this.options.viewer.isDestroyed()) this.options.viewer.dataSources.remove(this.drawing, true);
  }
}
