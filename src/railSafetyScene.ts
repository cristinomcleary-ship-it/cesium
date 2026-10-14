import {
  Cartesian2, Cartesian3, Cartographic, ClassificationType, Color, CustomDataSource, EllipsoidTerrainProvider,
  Entity, HeadingPitchRange, HeadingPitchRoll, HeightReference, LabelStyle, Math as CesiumMath,
  PolygonHierarchy, PolylineOutlineMaterialProperty, ScreenSpaceEventHandler, ScreenSpaceEventType,
  Transforms, VerticalOrigin, type Viewer,
} from 'cesium';
import { loadMachineryAsset, type LoadedMachineryAsset } from './machinery/index';
import { readMachineryState, type MachineryPlacementPick, type MachineryState } from './machineryScene';
import {
  intersectPolygons, pointInPolygon, projectWgs84ToLocal,
  polygonArea, unprojectLocalToWgs84, type Point2, type FallEnvelope,
} from './railSafetyGeometry';
import { RailSafetyComputation } from './railSafetyComputation';
import {
  RAIL_SAFETY_MAX_VERTICES, type RailSafetyDefinition, type RailSafetyMachine,
  type RailSafetyPosition, type RailSafetyRecord,
} from './railSafetyTypes';
import { validateRailSafetyDefinition, validateRailSafetyPolygon } from './railSafetyValidation';
import {
  DEFAULT_RAIL_SAFETY_DISPLAY, normalizeRailSafetyDisplay,
  type RailSafetyAreaDisplay, type RailSafetyDisplaySettings,
} from './railSafetyDisplay';

export type RailSafetyPick = MachineryPlacementPick;
export type RailSafetyPickProgress = {
  kind: 'point' | 'polygon'; points: RailSafetyPick[]; source?: RailSafetyPick['source']; message?: string;
};
export type RailSafetyMachineResult = {
  resourceId: string; resourceName: string; recordId?: string;
  status: 'unknown' | 'overlap' | 'touching' | 'clear'; label: string; message: string;
  draft: boolean; maxDistanceMeters?: number; nearestDistanceMeters?: number;
  supportSource?: string; warnings: string[];
  limits: Array<{ id: string; name: string; status: 'unknown' | 'overlap' | 'touching' | 'clear'; distanceMeters?: number; message?: string }>;
  guards: Array<{ id: string; name: string; containsStation: boolean; known: boolean; message?: string }>;
  signature: string;
};
type Resource = { id: string; name: string; projectId?: string; revision?: number; kind?: unknown; status?: string; machinery?: unknown };
export type RailSafetySceneContext = {
  projectId: string; records: readonly RailSafetyRecord[]; resources: readonly Resource[];
  active: boolean; canView: boolean; sessionKey?: string; actorId?: string;
};
export type RailSafetySceneOptions = {
  /** Host picker must exclude overlays and return a labelled surface source. */
  pickPosition?: (position: Cartesian2) => RailSafetyPick | undefined;
  onResults?: (results: RailSafetyMachineResult[]) => void;
  onPickProgress?: (progress: RailSafetyPickProgress) => void;
  onPickingChange?: (picking: boolean) => void;
  onSelect?: (kind: 'machine' | 'guard' | 'limit', id: string) => void;
};
type Draft = { id: string; name: string; definition: RailSafetyDefinition };
type Entry = Draft & { revision?: number; deleted?: boolean; definitionError?: string };
type Envelope = FallEnvelope;
type MachineVisual = { resourceId: string; envelope: Envelope; intersections: Array<{ limitId: string; polygons: Point2[][] }>; touchingLimitIds: string[] };
type Picking = {
  kind: 'point' | 'polygon'; points: RailSafetyPick[];
  pointCallback?: (point: RailSafetyPick) => void; polygonCallback?: (points: RailSafetyPick[]) => void;
};
const PREFIX = 'rail-safety:';
const BLUE = Color.fromCssColorString('#39bfff');
const PURPLE = Color.fromCssColorString('#c78bff');
const ORANGE = Color.fromCssColorString('#ffae39');
const RED = Color.fromCssColorString('#ff3c50');
const clone = <T>(value: T): T => structuredClone(value);
const signatureOf = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const positionValid = (p: RailSafetyPosition | undefined): p is RailSafetyPosition => !!p
  && [p.longitude, p.latitude, p.height].every(Number.isFinite)
  && Math.abs(p.longitude) <= 180 && Math.abs(p.latitude) <= 90;
const world = (p: RailSafetyPosition, lift = 0): Cartesian3 => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height + lift);
const errorText = (error: unknown) => error instanceof Error ? error.message : '空间参数无效';

/** Rendering only: dense convex rings create nearly coincident ground-classification volumes.
 * Ordered Douglas–Peucker retains source vertices within 5 cm in the local horizontal plane.
 * Concave/small rings and narrow intersections keep the complete ring; assessments never use this helper.
 */
export function simplifyRailSafetyDisplayRing(positions: RailSafetyPosition[]): RailSafetyPosition[] {
  if (positions.length <= 32) return positions;
  let points: Point2[];
  try { points = positions.map(p => projectWgs84ToLocal(p, positions[0])); }
  catch { return positions; }
  const area = polygonArea(points), sign = Math.sign(area);
  if (Math.abs(area) < 0.01 || points.some((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length];
    return sign * ((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) < -1e-8;
  })) return positions;
  const distanceSquared = (p: Point2, a: Point2, b: Point2) => {
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
  };
  let opposite = 1;
  for (let i = 2; i < points.length; i++) {
    if (distanceSquared(points[i], points[0], points[0]) > distanceSquared(points[opposite], points[0], points[0])) opposite = i;
  }
  const ring = [...points, points[0]], keep = new Set([0, opposite, points.length]);
  const pending: Array<[number, number]> = [[0, opposite], [opposite, points.length]];
  while (pending.length) {
    const [start, end] = pending.pop()!;
    let max = 0.05 ** 2, index = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = distanceSquared(ring[i], ring[start], ring[end]);
      if (distance > max) { max = distance; index = i; }
    }
    if (index >= 0) { keep.add(index); pending.push([start, index], [index, end]); }
  }
  const indexes = [...keep].filter(i => i < positions.length).sort((a, b) => a - b);
  const simplifiedArea = polygonArea(indexes.map(i => points[i]));
  // Convex source order prevents self-crossings; retain narrow risk pieces rather than collapsing their fill.
  if (indexes.length < 3 || simplifiedArea * area <= 0 || Math.abs(simplifiedArea / area) < 0.99) return positions;
  return indexes.map(i => positions[i]);
}

/** Shared-Viewer display and client-side screening. It never writes business events. */
export class RailSafetyScene {
  private readonly source = new CustomDataSource('铁路旁施工管控');
  private readonly assets = new Map<MachineryState['assetId'], Promise<LoadedMachineryAsset>>();
  private readonly abort = new AbortController();
  private readonly envelopes = new Map<string, { key: string; value: Envelope }>();
  private computation = new RailSafetyComputation();
  private readonly envelopeTasks = new Map<string, Promise<Envelope>>();
  private readonly fontTexts = new Set<string>();
  private readonly fontTasks = new Set<string>();
  private fontStylesheet?: Promise<void>;
  private readonly selectionHandler: ScreenSpaceEventHandler;
  private context: RailSafetySceneContext = { projectId: '', records: [], resources: [], active: false, canView: false };
  private draft?: Draft;
  private preview?: { id: string; state: MachineryState };
  private selected?: { kind: 'machine' | 'guard' | 'limit'; id: string };
  private entries: Entry[] = [];
  private visuals: MachineVisual[] = [];
  private results: RailSafetyMachineResult[] = [];
  private inputSignature = '';
  private signature = '';
  private generation = 0;
  private pending = 0;
  private computeTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private layers = { guards: true, limits: true, envelopes: true };
  private display = normalizeRailSafetyDisplay(DEFAULT_RAIL_SAFETY_DISPLAY);
  private pickHandler?: ScreenSpaceEventHandler;
  private pickAbort?: AbortController;
  private picking?: Picking;
  private previousCursor?: string;

  constructor(private readonly viewer: Viewer, private readonly options: RailSafetySceneOptions = {}) {
    void Promise.resolve(viewer.dataSources.add(this.source)).then(() => {
      if (this.disposed && !viewer.isDestroyed()) viewer.dataSources.remove(this.source, true);
    });
    this.source.show = false;
    this.selectionHandler = new ScreenSpaceEventHandler(viewer.canvas);
    this.selectionHandler.setInputAction((event: { position: Cartesian2 }) => {
      if (this.disposed || this.picking || !this.context.active || !this.context.canView) return;
      const picked = viewer.scene.pick(event.position) as { id?: Entity } | undefined;
      const id = picked?.id?.id;
      if (typeof id !== 'string') return;
      const entity = this.source.entities.getById(id);
      const metadata = entity && this.entitySelection.get(entity.id);
      if (metadata) { this.setSelected(metadata.kind, metadata.id); this.options.onSelect?.(metadata.kind, metadata.id); }
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  private readonly entitySelection = new Map<string, { kind: 'machine' | 'guard' | 'limit'; id: string }>();
  private readonly renderedEntityIds = new Set<string>();

  setContext(context: RailSafetySceneContext): void {
    if (this.disposed) return;
    const identityChanged = context.projectId !== this.context.projectId || context.sessionKey !== this.context.sessionKey
      || context.actorId !== this.context.actorId || context.canView !== this.context.canView;
    if (identityChanged || context.active !== this.context.active) {
      this.cancelPicking(); this.draft = undefined; this.preview = undefined;
      this.computation.dispose(); this.computation = new RailSafetyComputation(); this.envelopeTasks.clear();
      if (identityChanged) { this.selected = undefined; this.envelopes.clear(); }
    }
    this.context = { ...context,
      records: clone(context.records.filter(r => r.projectId === context.projectId)),
      resources: clone(context.resources.filter(r => !r.projectId || r.projectId === context.projectId)),
    };
    this.source.show = context.active && context.canView;
    this.reconcile();
  }

  setDraft(draft: Draft | undefined): void {
    if (this.disposed) return;
    this.draft = draft ? clone(draft) : undefined;
    this.reconcile(draft ? 100 : 0);
  }

  setMachineryPreview(id: string, state?: MachineryState): void {
    if (this.disposed) return;
    // A preview is valid only for an authorized resource already present in this context.
    if (!this.context.resources.some(r => r.id === id)) return;
    if (!state) { if (this.preview?.id === id) this.preview = undefined; }
    else this.preview = { id, state: clone(state) };
    this.reconcile(state ? 150 : 0);
  }

  setSelected(kind: 'machine' | 'guard' | 'limit', id: string): void {
    if (this.disposed) return;
    const entry = this.entries.find(e => e.id === id);
    if (kind === 'machine' && entry?.definition.kind === 'machine') id = entry.definition.resourceId;
    this.selected = { kind, id }; this.reconcile(); this.render();
  }

  /** Display-only switches never alter selected limits or any assessment result. */
  setLayers(layers: Partial<typeof this.layers>): void {
    this.layers = { ...this.layers, ...layers }; this.render();
  }

  /** Appearance never participates in assessment inputs, geometry caches or business records. */
  setDisplay(settings: RailSafetyDisplaySettings): void {
    if (this.disposed) return;
    const display = normalizeRailSafetyDisplay(settings);
    if (JSON.stringify(display) === JSON.stringify(this.display)) return;
    this.display = display; this.render();
  }

  getResults(): RailSafetyMachineResult[] { return clone(this.results); }

  getSnapshot() {
    return { projectId: this.context.projectId, active: this.context.active, canView: this.context.canView,
      picking: !!this.picking, generation: this.generation, signature: this.signature, pending: this.pending,
      results: this.getResults(), entityIds: this.source.entities.values.map(e => e.id), layers: { ...this.layers },
      display: clone(this.display) };
  }

  beginPickPoint(callback: (point: RailSafetyPick) => void): void {
    this.startPicking({ kind: 'point', points: [], pointCallback: callback });
  }

  beginPolygon(callback: (points: RailSafetyPick[]) => void): void {
    this.startPicking({ kind: 'polygon', points: [], polygonCallback: callback });
  }

  undoPoint(): void {
    if (this.picking?.kind !== 'polygon') return;
    this.picking.points.pop(); this.progress(); this.renderPicking();
  }

  finishPolygon(): void {
    if (this.picking?.kind !== 'polygon') return;
    const points = clone(this.picking.points);
    try { validateRailSafetyPolygon(points.map(({ longitude, latitude, height }) => ({ longitude, latitude, height }))); }
    catch (error) { this.progress(errorText(error)); return; }
    const callback = this.picking.polygonCallback;
    this.cancelPicking(); callback?.(points);
  }

  cancelPicking(): void {
    const wasPicking = !!this.picking;
    this.picking = undefined;
    this.pickAbort?.abort(); this.pickAbort = undefined;
    if (this.pickHandler && !this.pickHandler.isDestroyed()) this.pickHandler.destroy();
    this.pickHandler = undefined;
    if (this.previousCursor !== undefined && this.viewer.canvas.style.cursor === 'crosshair') this.viewer.canvas.style.cursor = this.previousCursor;
    this.previousCursor = undefined;
    this.renderPicking();
    if (wasPicking) this.options.onPickingChange?.(false);
  }

  async flyTo(id: string): Promise<boolean> {
    if (this.disposed || !this.context.active || !this.context.canView) return false;
    const entry = this.entries.find(e => e.id === id);
    const targetId = entry?.definition.kind === 'machine' ? entry.definition.resourceId : id;
    const entities = this.source.entities.values.filter(e => this.entitySelection.get(e.id)?.id === targetId && e.show);
    if (entities.length) {
      try { return await this.viewer.flyTo(entities, { duration: 0.7, offset: new HeadingPitchRange(0, -0.8, 0) }); }
      catch { return false; }
    }
    const state = this.stateFor(targetId);
    if (!state) return false;
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(state.placement.longitude, state.placement.latitude,
      state.placement.height + Math.max(60, state.parameters.boom_length_m ?? 0) * 2), duration: 0.7 });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.pending = 0; this.cancelPicking(); this.abort.abort();
    if (this.computeTimer !== undefined) clearTimeout(this.computeTimer);
    this.computation.dispose();
    this.assets.clear(); this.envelopes.clear(); this.envelopeTasks.clear(); this.results = []; this.visuals = []; this.entries = [];
    this.entitySelection.clear();
    if (!this.selectionHandler.isDestroyed()) this.selectionHandler.destroy();
    if (!this.viewer.isDestroyed()) this.viewer.dataSources.remove(this.source, true);
  }

  private reconcile(delay = 0): void {
    if (this.disposed) return;
    const input = JSON.stringify([this.context.projectId, this.context.sessionKey, this.context.actorId,
      this.context.active, this.context.canView, this.context.records, this.context.resources, this.draft, this.preview,
      this.selected?.kind === 'machine' ? this.selected.id : undefined]);
    if (input === this.inputSignature) return;
    if (this.computeTimer !== undefined) { clearTimeout(this.computeTimer); this.computeTimer = undefined; }
    this.inputSignature = input; this.signature = signatureOf(input);
    const generation = ++this.generation;
    this.visuals = []; this.pending = 0;
    if (!this.context.active || !this.context.canView) {
      this.entries = []; this.results = []; this.render(); this.publish(); return;
    }
    this.entries = this.context.records.filter(r => r.id !== this.draft?.id).map(r => ({
      id: r.id, name: r.name, definition: r.definition, revision: r.revision, deleted: r.status === 'deleted',
    }));
    if (this.draft) this.entries.push(this.draft);
    this.entries = this.entries.map(entry => {
      if (entry.deleted) return entry;
      try { return { ...entry, definition: validateRailSafetyDefinition(entry.definition) }; }
      catch (error) { return { ...entry, definitionError: errorText(error) }; }
    });
    // Unconfigured machines do not clutter the original workbench with new overlays.
    // A user explicitly selects a machine to preview its first safety configuration.
    const resources = this.context.resources.filter(r => r.status !== 'deleted' &&
      ((this.selected?.kind === 'machine' && this.selected.id === r.id)
        || this.entries.some(e => !e.deleted && e.definition.kind === 'machine' && e.definition.resourceId === r.id)));
    this.results = resources.map(resource => this.baseResult(resource));
    this.pending = resources.length;
    this.render(); this.publish();
    const evaluate = () => {
      this.computeTimer = undefined;
      if (this.disposed || generation !== this.generation) return;
      for (const resource of resources) void this.evaluate(resource, generation);
    };
    if (delay) this.computeTimer = setTimeout(evaluate, delay);
    else evaluate();
  }

  private baseResult(resource: Resource): RailSafetyMachineResult {
    const configs = this.entries.filter(e => !e.deleted && e.definition.kind === 'machine' && e.definition.resourceId === resource.id);
    const config = configs[0];
    return { resourceId: resource.id, resourceName: resource.name, recordId: config?.id,
      status: 'unknown', label: '待计算', message: '正在根据当前机械工况计算平面范围', draft: this.isDraft(resource.id),
      warnings: [], limits: [], guards: [], signature: this.signature };
  }

  private isDraft(resourceId: string): boolean {
    if (this.preview?.id === resourceId) return true;
    if (!this.draft) return false;
    if (this.draft.definition.kind === 'machine') return this.draft.definition.resourceId === resourceId;
    if (this.draft.definition.kind === 'guard') return this.draft.definition.resourceIds.includes(resourceId)
      || this.context.records.some(e => e.id === this.draft?.id && e.definition.kind === 'guard' && e.definition.resourceIds.includes(resourceId));
    return this.entries.some(e => !e.deleted && e.definition.kind === 'machine' && e.definition.resourceId === resourceId
      && e.definition.selectedLimitIds.includes(this.draft!.id));
  }

  private stateFor(resourceId: string): MachineryState | undefined {
    return readMachineryState(this.preview?.id === resourceId ? this.preview.state : this.context.resources.find(r => r.id === resourceId)?.machinery);
  }

  private async evaluate(resource: Resource, generation: number): Promise<void> {
    const result = this.baseResult(resource);
    const live = () => !this.disposed && generation === this.generation && this.context.canView && this.context.active;
    let visual: MachineVisual | undefined;
    try {
      const state = this.stateFor(resource.id);
      if (!state) throw new Error('机械模型、尺寸或站位不完整，无法判断');
      const configs = this.entries.filter(e => !e.deleted && e.definition.kind === 'machine' && e.definition.resourceId === resource.id);
      if (configs.length > 1) throw new Error('存在重复机械管控配置，请先核对配置');
      const entry = configs[0];
      if (entry?.definitionError) throw new Error(`机械管控草稿未完成：${entry.definitionError}`);
      const definition = entry?.definition as RailSafetyMachine | undefined;
      const asset = await this.loadAsset(state.assetId);
      if (!live()) return;
      if (asset.version !== state.assetVersion || asset.id !== state.assetId) throw new Error('机械模型版本不匹配，无法判断');
      const key = JSON.stringify([state.assetId, state.assetVersion, state.parameters, state.proportional, state.placement, definition?.support]);
      const cached = this.envelopes.get(resource.id);
      let envelope: Envelope;
      if (cached?.key === key) envelope = cached.value;
      else {
        // Queue cancellation is per resource. Never share a cancellable request
        // between two distinct machines which happen to have identical poses.
        const taskKey = JSON.stringify([resource.id, key]);
        let task = this.envelopeTasks.get(taskKey);
        if (!task) {
          task = this.computation.compute(asset, state, definition?.support, resource.id); this.envelopeTasks.set(taskKey, task);
          const complete = () => { if (this.envelopeTasks.get(taskKey) === task) this.envelopeTasks.delete(taskKey); };
          void task.then(complete, complete);
        }
        envelope = await task;
      }
      if (!live()) return;
      this.envelopes.set(resource.id, { key, value: envelope });
      if (envelope.status !== 'estimated') throw new Error(envelope.warnings.join('；') || '无法建立当前工况的倾覆影响范围');
      result.maxDistanceMeters = envelope.maxDistanceMeters;
      result.supportSource = envelope.supportSource;
      result.warnings = [...envelope.warnings, '仅进行平面几何筛查；不代表三维碰撞判定或施工安全批准'];
      visual = { resourceId: resource.id, envelope, intersections: [], touchingLimitIds: [] };
      for (const guard of this.entries.filter(e => !e.deleted && e.definition.kind === 'guard' && e.definition.resourceIds.includes(resource.id))) {
        if (guard.definition.kind !== 'guard') continue;
        if (guard.definitionError) result.guards.push({ id: guard.id, name: guard.name, containsStation: false, known: false, message: guard.definitionError });
        else {
          try {
            const polygon = guard.definition.polygon.map(p => projectWgs84ToLocal(p, envelope.origin));
            result.guards.push({ id: guard.id, name: guard.name, known: true,
              containsStation: pointInPolygon({ x: 0, y: 0 }, polygon) !== 'outside',
              message: '仅判断机械站位；不代表全部作业范围已有防护',
            });
          } catch (error) {
            result.guards.push({ id: guard.id, name: guard.name, containsStation: false, known: false, message: errorText(error) });
          }
        }
      }
      if (!definition?.selectedLimitIds.length) throw new Error('尚未选用铁路设备安全限界，无法判断侵限');
      for (const limitId of definition.selectedLimitIds) {
        const limit = this.entries.find(e => e.id === limitId);
        if (!limit || limit.deleted || limit.definition.kind !== 'limit' || limit.definitionError) {
          result.limits.push({ id: limitId, name: limit?.name ?? '不可用限界', status: 'unknown',
            message: limit?.definitionError ?? '限界已删除、无权查看或不存在，请重新核对选用范围' });
          continue;
        }
        try {
          const polygon = limit.definition.polygon.map(p => projectWgs84ToLocal(p, envelope.origin));
          const intersection = intersectPolygons(envelope.polygon, polygon);
          const status = intersection.relation === 'disjoint' ? 'clear' : intersection.relation;
          result.limits.push({ id: limit.id, name: limit.name, status, distanceMeters: intersection.distanceMeters });
          if (status === 'touching') visual.touchingLimitIds.push(limit.id);
          if (intersection.intersectionPolygons.length) visual.intersections.push({ limitId: limit.id, polygons: intersection.intersectionPolygons });
        } catch (error) {
          result.limits.push({ id: limit.id, name: limit.name, status: 'unknown', message: errorText(error) });
        }
      }
      const distances = result.limits.flatMap(l => l.distanceMeters === undefined ? [] : [l.distanceMeters]);
      if (distances.length) result.nearestDistanceMeters = Math.min(...distances);
      // An incomplete limit set must never be reported as clear. Known overlaps remain visible.
      const incomplete = result.limits.some(l => l.status === 'unknown');
      result.status = result.limits.some(l => l.status === 'overlap') ? 'overlap'
        : result.limits.some(l => l.status === 'touching') ? 'touching' : incomplete ? 'unknown' : 'clear';
      result.label = { overlap: '平面潜在侵限', touching: '接触限界边界', clear: '本次平面筛查未发现相交', unknown: '限界不完整，待核实' }[result.status];
      result.message = incomplete ? '部分所选限界不可用，当前筛查不完整；已有相交结果仍保留'
        : result.status === 'overlap' ? '倾覆几何外包与用户定义限界存在平面重叠'
        : result.status === 'touching' ? '倾覆几何外包接触用户定义限界边界'
        : '按当前参数与已选限界未发现平面相交；未判断高程方向及实际稳定性';
    } catch (error) {
      result.status = 'unknown'; result.label = '待核实／无法判定'; result.message = errorText(error);
    } finally {
      if (live()) {
        const index = this.results.findIndex(r => r.resourceId === resource.id);
        if (index >= 0) this.results[index] = result;
        if (visual) this.visuals.push(visual);
        this.pending = Math.max(0, this.pending - 1); this.render(); this.publish();
      }
    }
  }

  private loadAsset(id: MachineryState['assetId']): Promise<LoadedMachineryAsset> {
    let promise = this.assets.get(id);
    if (!promise) {
      promise = loadMachineryAsset(id, { signal: this.abort.signal }); this.assets.set(id, promise);
      void promise.catch(() => { if (this.assets.get(id) === promise) this.assets.delete(id); });
    }
    return promise;
  }

  private publish(): void { this.options.onResults?.(this.getResults()); }

  private add(entity: Entity.ConstructorOptions, kind: 'machine' | 'guard' | 'limit', id: string): void {
    const replacement = new Entity(entity);
    let added = this.source.entities.getById(replacement.id);
    if (added) {
      // Removing and re-adding the same ID inside suspendEvents hides the replacement
      // from Cesium visualizers. Keep Entity identity and raise its property changes instead.
      added.name = replacement.name;
      // Assign undefined too, so switching representation clears obsolete graphics.
      added.position = replacement.position; added.orientation = replacement.orientation;
      added.polygon = replacement.polygon; added.polyline = replacement.polyline;
      added.point = replacement.point; added.label = replacement.label; added.model = replacement.model;
    } else added = this.source.entities.add(replacement);
    this.renderedEntityIds.add(added.id);
    this.entitySelection.set(added.id, { kind, id });
  }

  private polygon(id: string, name: string, positions: RailSafetyPosition[], color: Color, kind: 'machine' | 'guard' | 'limit', owner: string,
    fill = 0.13, display?: RailSafetyAreaDisplay, emphasis = false): void {
    if (positions.length < 3 || !positions.every(positionValid)) return;
    const selected = this.selected?.kind === kind && this.selected.id === owner;
    const draped = !!display && display.surface !== 'absolute';
    const displayPositions = draped ? simplifyRailSafetyDisplayRing(positions) : positions;
    const points = displayPositions.map(p => world(p, draped ? 0 : 0.06));
    const alpha = !display && selected ? Math.min(0.5, fill + 0.10) : fill;
    this.add({ id, name, polygon: { hierarchy: new PolygonHierarchy(points), perPositionHeight: !draped,
      // Omitting height/extrusion allows Cesium GroundPrimitive to classify the loaded surface.
      classificationType: display?.surface === 'terrain' ? ClassificationType.TERRAIN : ClassificationType.BOTH,
      fill: emphasis || display?.style !== 'outline', material: color.withAlpha(alpha), outline: false,
      zIndex: emphasis ? 10 : kind === 'guard' ? 2 : 3 },
      polyline: this.areaLine([...points, points[0]], color, display, selected, emphasis),
    }, kind, owner);
  }

  private areaLine(positions: Cartesian3[], color: Color, display?: RailSafetyAreaDisplay, selected = false, emphasis = false) {
    const width = display ? Math.max(display.lineWidth, emphasis ? 4 : 0) + (selected ? 1.5 : 0) : selected ? 3 : 1.6;
    const draped = !!display && display.surface !== 'absolute';
    return { positions, width,
      // Solid category colors avoid the ground outline shader's sub-pixel striping on software WebGL.
      material: display && !draped ? new PolylineOutlineMaterialProperty({ color, outlineColor: Color.BLACK.withAlpha(0.85), outlineWidth: Math.min(1, width * 0.4) }) : color,
      clampToGround: draped,
      classificationType: display?.surface === 'terrain' ? ClassificationType.TERRAIN : ClassificationType.BOTH,
      zIndex: emphasis ? 20 : 12 };
  }

  private label(id: string, name: string, position: RailSafetyPosition, color: Color, kind: 'machine' | 'guard' | 'limit', owner: string,
    options: { point?: boolean; lift?: number; alwaysReadable?: boolean; pixelOffset?: number; surface?: RailSafetyAreaDisplay['surface'] } = {}): void {
    if (!positionValid(position)) return;
    const fontReady = this.ensureLabelFont(name);
    const heightReference = options.surface === 'model' ? HeightReference.CLAMP_TO_GROUND
      : options.surface === 'terrain' ? HeightReference.CLAMP_TO_TERRAIN : HeightReference.NONE;
    this.add({ id, name, position: world(position, options.lift ?? 0.16),
      point: options.point === false ? undefined : { pixelSize: 9, color, outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: 0, heightReference },
      // Render immediately with the system font; refreshing with a different font key avoids Cesium's cached fallback glyphs.
      label: { text: name, font: fontReady ? '13px "Noto Sans SC", "Microsoft YaHei", sans-serif' : '13px "Microsoft YaHei", sans-serif',
        fillColor: Color.WHITE, outlineColor: Color.BLACK,
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, options.pixelOffset ?? -12), showBackground: true, backgroundColor: Color.BLACK.withAlpha(0.65), heightReference,
        disableDepthTestDistance: options.alwaysReadable ? Number.POSITIVE_INFINITY : 0,
      },
    }, kind, owner);
  }

  private guardStation(id: string, name: string, station: RailSafetyPosition): void {
    if (!positionValid(station)) return;
    const entityId = `${PREFIX}guard:${id}:station`;
    const personnel = this.display.personnel;
    if (personnel.representation === 'point') {
      this.label(entityId, name, station, BLUE, 'guard', id, { alwaysReadable: true });
      return;
    }
    const position = world(station, 0.03);
    this.add({ id: entityId, name, position,
      // Cesium converts the asset's +Z forward / +Y up to +X forward / +Z up.
      // A -90 degree offset expresses the UI heading as clockwise from north.
      orientation: Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(CesiumMath.toRadians(personnel.heading - 90), 0, 0)),
      model: { uri: '/models/rail-safety/guard.gltf', scale: personnel.scale, minimumPixelSize: 40,
        maximumScale: 8 * personnel.scale, heightReference: HeightReference.NONE,
        silhouetteColor: BLUE, silhouetteSize: this.selected?.kind === 'guard' && this.selected.id === id ? 2 : 0 },
    }, 'guard', id);
    // Keep the recorded foot height. Clamping personnel to tiles can relocate a person beneath a bridge onto its deck.
    this.label(`${entityId}:label`, name, station, BLUE, 'guard', id,
      { point: false, lift: 1.8 * personnel.scale + 0.3, pixelOffset: -40, alwaysReadable: true });
  }

  /** Cesium caches glyph bitmaps: reload labels after the local CJK face becomes available. */
  private ensureLabelFont(text: string): boolean {
    if (typeof document === 'undefined' || !document.fonts || this.fontTexts.has(text)) return true;
    if (this.fontTasks.has(text)) return false;
    this.fontTasks.add(text);
    this.fontStylesheet ??= new Promise<void>(resolve => {
      let link = document.querySelector<HTMLLinkElement>('link[data-management-fonts]');
      if (link?.sheet) { resolve(); return; }
      if (!link) {
        link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/management/fonts/fonts.css';
        link.dataset.managementFonts = '';
        link.addEventListener('load', () => resolve(), { once: true });
        link.addEventListener('error', () => resolve(), { once: true });
        document.head.append(link);
      } else {
        link.addEventListener('load', () => resolve(), { once: true });
        link.addEventListener('error', () => resolve(), { once: true });
      }
    });
    void this.fontStylesheet.then(() => document.fonts.load('13px "Noto Sans SC"', text)).then(() => {
      this.fontTexts.add(text); this.fontTasks.delete(text);
      if (!this.disposed) this.render();
    }).catch(() => {
      this.fontTexts.add(text); this.fontTasks.delete(text);
      if (!this.disposed) this.render();
    });
    return false;
  }

  private render(): void {
    if (this.disposed) return;
    this.source.entities.suspendEvents();
    try {
      this.renderedEntityIds.clear(); this.entitySelection.clear();
      if (!this.context.canView || !this.context.active) return;
      for (const entry of this.entries) {
        if (entry.deleted || entry.definitionError) continue;
        const definition = entry.definition;
        if (definition.kind === 'guard' && this.layers.guards) {
          this.polygon(`${PREFIX}guard:${entry.id}:area`, `${entry.name}负责区域`, definition.polygon, BLUE, 'guard', entry.id,
            this.display.guards.opacity, this.display.guards);
          this.guardStation(entry.id, entry.name, definition.station);
        } else if (definition.kind === 'limit' && this.layers.limits) {
          this.polygon(`${PREFIX}limit:${entry.id}:area`, entry.name, definition.polygon, PURPLE, 'limit', entry.id, 0.16);
          this.label(`${PREFIX}limit:${entry.id}:name`, entry.name, definition.polygon[0], PURPLE, 'limit', entry.id);
        }
      }
      if (this.layers.envelopes) for (const visual of this.visuals) {
        const { resourceId, envelope } = visual;
        const display = this.display.envelopes;
        const convert = (points: Point2[]) => points.map(p => unprojectLocalToWgs84(p, envelope.origin));
        this.polygon(`${PREFIX}machine:${resourceId}:envelope`, '倾覆几何影响范围', convert(envelope.polygon), ORANGE, 'machine', resourceId,
          display.opacity, display);
        this.polygon(`${PREFIX}machine:${resourceId}:support`, '计算支承区域', convert(envelope.supportPolygon), Color.LIGHTGRAY, 'machine', resourceId,
          Math.min(0.12, display.opacity / 2), display);
        const farthest = envelope.landingPoints.reduce<Point2 | undefined>((best, p) => !best || Math.hypot(p.x, p.y) > Math.hypot(best.x, best.y) ? p : best, undefined);
        if (farthest) {
          const point = unprojectLocalToWgs84(farthest, envelope.origin);
          this.label(`${PREFIX}machine:${resourceId}:farthest`, `估计最远落点 ${envelope.maxDistanceMeters.toFixed(2)} m`, point, ORANGE, 'machine', resourceId,
            { surface: display.surface, alwaysReadable: true });
          const origin = { ...envelope.origin, height: envelope.origin.height ?? 0 };
          this.add({ id: `${PREFIX}machine:${resourceId}:radius`, name: '站位至最远几何落点',
            polyline: this.areaLine([world(origin, 0.08), world(point, 0.08)], ORANGE, display),
          }, 'machine', resourceId);
        }
        for (const hit of visual.intersections) hit.polygons.forEach((polygon, i) => this.polygon(
          `${PREFIX}machine:${resourceId}:intersection:${hit.limitId}:${i}`, '平面潜在侵限相交区', convert(polygon), RED, 'machine', resourceId,
          Math.max(0.48, display.opacity), display, true));
        for (const limitId of visual.touchingLimitIds) {
          const limit = this.entries.find(entry => entry.id === limitId);
          if (limit?.definition.kind !== 'limit' || limit.definitionError) continue;
          const positions = limit.definition.polygon.map(p => world(p, 0.1));
          this.add({ id: `${PREFIX}machine:${resourceId}:contact:${limitId}`, name: '发生接触的限界边线',
            polyline: this.areaLine([...positions, positions[0]], RED, display, false, true),
          }, 'machine', resourceId);
        }
      }
    } finally {
      for (const entity of [...this.source.entities.values]) {
        if (!entity.id.startsWith(`${PREFIX}drawing:`) && !this.renderedEntityIds.has(entity.id)) this.source.entities.remove(entity);
      }
      this.source.entities.resumeEvents(); this.renderPicking(); this.requestRender();
    }
  }

  private startPicking(picking: Picking): void {
    this.cancelPicking();
    if (this.disposed || !this.context.canView || !this.context.active) return;
    this.picking = picking;
    const handler = new ScreenSpaceEventHandler(this.viewer.canvas), abort = new AbortController();
    this.pickHandler = handler; this.pickAbort = abort;
    this.previousCursor = this.viewer.canvas.style.cursor; this.viewer.canvas.style.cursor = 'crosshair';
    let down: Cartesian2 | undefined, moved = false;
    handler.setInputAction((event: { position: Cartesian2 }) => { down = Cartesian2.clone(event.position); moved = false; }, ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (down && Cartesian2.distance(down, event.endPosition) > 6) moved = true;
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((event: { position: Cartesian2 }) => {
      if (moved || (down && Cartesian2.distance(down, event.position) > 6)) { down = undefined; return; }
      down = undefined;
      if (this.picking !== picking) return;
      const point = this.pickGround(event.position);
      if (!point) { this.progress('此处没有可用表面，请在模型或地面上重新点选'); return; }
      if (picking.kind === 'point') { const callback = picking.pointCallback; this.cancelPicking(); callback?.(point); return; }
      if (picking.points.length >= RAIL_SAFETY_MAX_VERTICES) { this.progress(`最多 ${RAIL_SAFETY_MAX_VERTICES} 个顶点，请完成绘制`); return; }
      picking.points.push(point); this.progress(); this.renderPicking();
    }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => this.cancelPicking(), ScreenSpaceEventType.RIGHT_CLICK);
    document.addEventListener('keydown', event => {
      if (this.pickHandler !== handler) return;
      if (event.key === 'Escape') { event.preventDefault(); this.cancelPicking(); }
      if ((event.key === 'Backspace' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'))
        && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); this.undoPoint(); }
    }, { signal: abort.signal });
    window.addEventListener('blur', () => this.cancelPicking(), { signal: abort.signal });
    this.options.onPickingChange?.(true); this.progress();
  }

  private progress(message?: string): void {
    if (!this.picking) return;
    const points = clone(this.picking.points);
    this.options.onPickProgress?.({ kind: this.picking.kind, points, source: points.at(-1)?.source, message });
  }

  private renderPicking(): void {
    if (this.disposed || this.viewer.isDestroyed()) return;
    for (const entity of [...this.source.entities.values]) if (entity.id.startsWith(`${PREFIX}drawing:`)) this.source.entities.remove(entity);
    const points = this.picking?.points ?? [];
    points.forEach((point, i) => this.source.entities.add({ id: `${PREFIX}drawing:${i}`, position: world(point, 0.1),
      point: { pixelSize: 8, color: Color.WHITE, outlineColor: BLUE, outlineWidth: 2 },
      label: { text: String(i + 1), pixelOffset: new Cartesian2(10, -10), font: '12px sans-serif' },
    }));
    if (points.length > 1) this.source.entities.add({ id: `${PREFIX}drawing:line`,
      polyline: { positions: points.map(p => world(p, 0.1)), width: 2, material: BLUE, clampToGround: false },
    });
    this.requestRender();
  }

  private pickGround(screen: Cartesian2): RailSafetyPick | undefined {
    if (!this.context.canView || !this.context.active) return;
    // Never use generic depth picking: it can return this module's own translucent regions.
    const previousShow = this.source.show;
    try {
      this.source.show = false;
      this.viewer.scene.requestRender();
      // The host's depth picker must see the hidden state in a fresh frame,
      // not the previous frame containing our station markers and support lines.
      this.viewer.render();
      const picked = this.options.pickPosition?.(screen);
      if (picked && positionValid(picked) && ['model', 'terrain', 'ellipsoid'].includes(picked.source)) return { ...picked };
    } catch { /* Ground fallback remains explicitly labelled and is not survey verification. */ }
    finally { this.source.show = previousShow; this.requestRender(); }
    const { scene, camera } = this.viewer;
    const ellipsoid = scene.globe?.ellipsoid;
    let point: Cartesian3 | undefined;
    let source: RailSafetyPick['source'] = 'ellipsoid';
    const ray = camera.getPickRay(screen);
    if (ray && scene.globe?.show) {
      point = scene.globe.pick(ray, scene);
      if (point && !(scene.terrainProvider instanceof EllipsoidTerrainProvider)) source = 'terrain';
    }
    if (!point) point = camera.pickEllipsoid(screen, ellipsoid);
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) return;
    const cartographic = Cartographic.fromCartesian(point, ellipsoid);
    if (!cartographic) return;
    const result = { longitude: CesiumMath.toDegrees(cartographic.longitude), latitude: CesiumMath.toDegrees(cartographic.latitude), height: cartographic.height, source };
    return positionValid(result) ? result : undefined;
  }

  private requestRender(): void { if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender(); }
}
