import { CallbackProperty, Cartesian2, Cartesian3, Color, ConstantProperty, ColorMaterialProperty, CustomDataSource, Entity, PolygonHierarchy, ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from "cesium";
import { SafetySpatialError, SafetySpatialRepository } from "./safetySpatialRepository";
import { EMPTY_SPATIAL_SNAPSHOT, type SpatialKind, type SpatialObject, type SpatialRiskLevel, type SpatialSnapshot } from "./safetySpatialTypes";
import type { SafetyDataset, SafetyPosition, SafetyState, SafetyView } from "./safetyTypes";
import { nextSpatialName, validateDraftShape } from "./safetyDraftGeometry";
import { modelTransformMatches, strictModelSurfacePick, type RegisteredPhotogrammetry, type SurfacePickResult } from "./safetyModelSurfacePicker";
import { createSpatialDisplayEntity, SPATIAL_BOUNDARY_WIDTH } from "./safetySpatialDisplayGeometry";
import "./safetySpatialEditor.css";

type VertexSource = SpatialObject["source"]["vertices"][number];
type Fields = { name: string; description: string; responsiblePerson: string; lineName: string; riskType: string; level: SpatialRiskLevel; areaId: string; linkedMediaIds: string[] };
type GeometryState = { positions: SafetyPosition[]; sources: VertexSource[]; geometryLocked: boolean };
type Draft = GeometryState & { id: string; kind: SpatialKind; fields: Fields; original?: SpatialObject; stage: "draw" | "name"; initial: string; history: GeometryState[]; future?: GeometryState[] };
export type SpatialLayerVisibility = { constructionAreas?: boolean; railwayAreas?: boolean; riskPoints?: boolean };
export type SpatialEditorOptions = {
  viewer: Viewer; host: HTMLElement;
  onSnapshot: (snapshot: SpatialSnapshot) => void; onSelect: (id: string, options?: { fly?: boolean }) => void;
  onDrawing: (drawing: boolean) => void; onVisibility?: (visible: boolean) => void;
  suspendOverlays: () => () => void; getModelRegistry?: () => readonly RegisteredPhotogrammetry[];
  getContext: () => { dataset: SafetyDataset; state: SafetyState; mediaSeconds?: number; mediaId?: string; actorId?: string } | undefined;
};
const names: Record<SpatialKind, string> = { "construction-area": "施工区域", railway: "铁路范围", "risk-point": "风险点" };
const levels: Record<SpatialRiskLevel, string> = { unassessed: "待评估", low: "一般", medium: "较高", high: "重大" };
const colors: Record<SpatialKind, string> = { "construction-area": "#43D9FF", railway: "#FFB957", "risk-point": "#FFB957" };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const cart = (p: SafetyPosition) => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height);
const positionsOf = (o: SpatialObject) => o.geometry.type === "Point" ? [o.geometry.position] : o.geometry.positions;
const signature = (d: Draft) => JSON.stringify({ positions: d.positions, sources: d.sources, fields: d.fields, geometryLocked: d.geometryLocked });
const button = (label: string, action: string, primary = false, extra = "") => '<button type="button" class="' + (primary ? "spatial-primary" : "spatial-secondary") + '" data-spatial="' + action + '" ' + extra + '>' + label + '</button>';
const icon = (kind: SpatialKind) => '<svg class="spatial-icon" viewBox="0 0 24 24" aria-hidden="true">' + (kind === "risk-point" ? '<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>' : kind === "railway" ? '<rect x="6" y="3" width="12" height="15" rx="3"/><path d="M6 10h12M10 3v7m4-7v7M8 21l2-3m4 0 2 3"/>' : '<path d="m5 4 14 2 1 12-12 3-5-9 2-8Z"/><circle cx="5" cy="4" r="1.5"/>') + '</svg>';

export class SafetySpatialEditor {
  private readonly repository = new SafetySpatialRepository();
  private snapshot: SpatialSnapshot = structuredClone(EMPTY_SPATIAL_SNAPSHOT);
  private readonly source = new CustomDataSource("人工空间对象");
  private readonly drafts = new CustomDataSource("空间标绘草稿");
  private readonly handler: ScreenSpaceEventHandler;
  private readonly panel = document.createElement("aside");
  private readonly handles = document.createElement("div");
  private readonly hint = document.createElement("div");
  private readonly discard = document.createElement("div");
  private readonly preview = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly previewLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  private readonly events = new AbortController();
  private readonly removePostRender: () => void;
  private active = false; private disposed = false; private saving = false; private drawing = false;
  private draft?: Draft; private selectedId?: string; private detailId?: string; private recentDeleted = false; private menuId?: string;
  private baseRevision = 0; private loadGeneration = 0;
  private managementSelection?: Set<string>;
  private managementTopic?: { colors: Record<string, string>; visibleIds?: Set<string> };
  private entities = new Map<string, Entity>(); private filterIds?: Set<string>;
  private layers: Required<SpatialLayerVisibility> = { constructionAreas: true, railwayAreas: true, riskPoints: true };
  private pendingLeave?: () => void; private down?: Cartesian2; private moved = false; private hover?: Cartesian2;
  private selectedVertex?: number; private badEdges: number[] = []; private draftPositions: Cartesian3[] = []; private edgePositions: Cartesian3[] = [];
  private handlePoints: Array<{ element: HTMLButtonElement; position: Cartesian3 }> = [];
  private drag?: { index: number; pointerId: number; target: HTMLElement; before: GeometryState; inputs: boolean; lastPick: number; moved: boolean; start: Cartesian2 };

  constructor(private readonly options: SpatialEditorOptions) {
    this.source.show = this.drafts.show = false;
    void options.viewer.dataSources.add(this.source); void options.viewer.dataSources.add(this.drafts);
    this.panel.className = "safety-spatial-editor"; this.panel.hidden = true; this.panel.setAttribute("aria-label", "区域配置");
    this.panel.innerHTML = '<header class="spatial-header"><h2>区域配置</h2><button type="button" class="spatial-icon-button" data-spatial="close" aria-label="关闭区域配置">×</button></header><div class="spatial-body" data-spatial-ref="body"></div><div class="spatial-message" data-spatial-ref="message" role="status" hidden></div>';
    this.handles.className = "spatial-handles"; this.handles.hidden = true;
    this.hint.className = "spatial-scene-hint"; this.hint.hidden = true;
    this.discard.className = "spatial-discard"; this.discard.hidden = true;
    this.discard.innerHTML = '<section role="alertdialog" aria-modal="true" aria-labelledby="spatial-discard-title"><h2 id="spatial-discard-title">放弃本次修改？</h2><p>本次绘制和调整尚未保存。</p><div class="spatial-button-row">' + button("继续编辑", "keep-editing", true) + button("放弃修改", "discard") + '</div></section>';
    this.preview.classList.add("spatial-draft-preview"); this.preview.setAttribute("hidden", ""); this.preview.append(this.previewLine);
    options.host.append(this.panel, this.handles, this.hint, this.preview, this.discard);
    this.panel.addEventListener("click", e => this.action(e), { signal: this.events.signal }); this.discard.addEventListener("click", e => this.action(e), { signal: this.events.signal });
    this.panel.addEventListener("input", e => this.changeField(e), { signal: this.events.signal }); this.panel.addEventListener("change", e => this.changeField(e), { signal: this.events.signal });
    this.handles.addEventListener("pointerdown", e => this.handleDown(e), { signal: this.events.signal }); this.handles.addEventListener("pointermove", e => this.handleMove(e), { signal: this.events.signal });
    this.handles.addEventListener("pointerup", e => this.handleUp(e), { signal: this.events.signal }); this.handles.addEventListener("pointercancel", () => this.cancelDrag(), { signal: this.events.signal });
    window.addEventListener("blur", () => this.cancelDrag(), { signal: this.events.signal }); document.addEventListener("keydown", e => this.keydown(e), { signal: this.events.signal });
    this.handler = new ScreenSpaceEventHandler(options.viewer.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => { this.down = Cartesian2.clone(e.position); this.moved = false; }, ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      if (this.down && Cartesian2.distance(this.down, e.endPosition) > 6) this.moved = true;
      if (this.draft?.stage === "draw") { this.hover = Cartesian2.clone(e.endPosition); this.positionHandles(); }
    }, ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction((e: { position: Cartesian2 }) => { if (!this.moved && (!this.down || Cartesian2.distance(this.down, e.position) <= 6)) this.click(e.position); this.down = undefined; }, ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction(() => { if (this.draft?.stage === "draw") this.finish(); }, ScreenSpaceEventType.RIGHT_CLICK);
    this.removePostRender = options.viewer.scene.postRender.addEventListener(() => this.positionHandles());
  }
  private ref(name: string): HTMLElement { return this.panel.querySelector('[data-spatial-ref="' + name + '"]')!; }
  private message(text: string, error = false, undoId?: string): void {
    const node = this.ref("message"); node.hidden = !text; node.classList.toggle("is-error", error);
    node.innerHTML = esc(text) + (undoId ? ' <button type="button" class="spatial-text" data-spatial="restore-deleted" data-id="' + esc(undoId) + '">撤销</button>' : "");
  }
  private action(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-spatial]"); if (!target || target.disabled || this.saving) return;
    const action = target.dataset.spatial!, id = target.dataset.id;
    if (action === "keep-editing") { this.pendingLeave = undefined; this.discard.hidden = true; this.panel.inert = false; return; }
    if (action === "discard") { const next = this.pendingLeave; this.pendingLeave = undefined; this.discard.hidden = true; this.panel.inert = false; next?.(); return; }
    if (action === "close") this.requestClose();

    else if (action === "new-area" || action === "new-railway" || action === "new-risk") this.guard(() => this.begin(action === "new-area" ? "construction-area" : action === "new-railway" ? "railway" : "risk-point"));
    else if (action === "cancel") this.guard(() => { const original = this.draft?.original?.id; this.cancelDraft(); this.detailId = original; this.message(""); this.render(); });
    else if (action === "undo") this.undo(); else if (action === "redo") this.redo(); else if (action === "finish") this.finish(); else if (action === "save") void this.save();
    else if (action === "redraw" || action === "reposition") this.redraw(); else if (action === "delete-vertex") this.deleteVertex();
    else if (action === "level" && this.draft && target.dataset.level) { this.draft.fields.level = target.dataset.level as SpatialRiskLevel; this.render(); }
    else if (action === "choose") this.guard(() => { this.cancelDraft(); this.detailId = undefined; this.recentDeleted = false; this.message(""); this.render(); });
    else if (action === "recent") { this.recentDeleted = !this.recentDeleted; this.menuId = undefined; this.render(); }
    else if (action === "reload") void this.load(true).catch(() => {});
    else if (id && action === "select") this.guard(() => this.selectObject(id));
    else if (id && action === "edit") this.guard(() => { const object = this.savedObject(id); if (object) this.begin(object.kind, object); });
    else if (id && action === "more") { this.menuId = this.menuId === id ? undefined : id; this.render(); }
    else if (id && action === "delete") void this.remove(id); else if (id && action === "restore-deleted") void this.restore(id);
  }
  private changeField(event: Event): void {
    if (!this.draft || this.saving) return;
    const field = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, key = field.dataset.spatialField as keyof Fields | undefined;
    if (!key) return;
    if (key === "linkedMediaIds") this.draft.fields.linkedMediaIds = field.value ? [field.value] : [];
    else if (key !== "level") this.draft.fields[key] = field.value;
    field.removeAttribute("aria-invalid");
  }
  private keydown(event: KeyboardEvent): void {
    if (!this.active || this.panel.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!this.discard.hidden) { this.pendingLeave = undefined; this.discard.hidden = true; this.panel.inert = false; }
      else if (this.draft) this.guard(() => { this.cancelDraft(); this.detailId = undefined; this.message(""); this.render(); });
      else this.requestClose();
    } else if (!(event.target as HTMLElement)?.closest("input,textarea,select")) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) this.redo(); else this.undo(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); this.redo(); }
      if (event.key === "Delete" && this.draft?.stage === "name") { event.preventDefault(); this.deleteVertex(); }
    }
  }
  private guard(next: () => void): boolean {
    if (this.saving) { this.message("正在保存，请稍候"); return false; }
    if (this.draft && signature(this.draft) !== this.draft.initial) {
      if (!this.pendingLeave) { this.pendingLeave = next; this.discard.hidden = false; this.panel.inert = true; this.discard.querySelector<HTMLButtonElement>("button")?.focus(); }
      return false;
    }
    next(); return true;
  }
  requestClose(afterClose?: () => void): boolean { return this.guard(() => { this.forceHide(); afterClose?.(); }); }
  hide(): boolean { return this.requestClose(); }
  private forceHide(): void {
    this.cancelDraft(); this.pendingLeave = undefined; this.discard.hidden = true; this.panel.inert = false;
    const wasVisible = !this.panel.hidden; this.panel.hidden = true; if (wasVisible) this.options.onVisibility?.(false);
  }
  setActive(active: boolean): void { this.active = active; this.source.show = active; this.drafts.show = active; if (!active) this.forceHide(); else this.applyVisibility(); }
  show(objectId?: string): void {
    if (!this.active || this.disposed) return;
    if (!this.panel.hidden) { if (objectId) this.guard(() => this.selectObject(objectId)); return; }
    const context = this.options.getContext(), selectedNode = context?.dataset.nodes.find(n => n.id === context.state.selectedId);
    const selected = objectId || selectedNode?.spatialObjectId || this.selectedId;
    this.detailId = selected && this.savedObject(selected) ? selected : undefined;
    this.recentDeleted = false; this.panel.hidden = false; this.options.onVisibility?.(true); this.message(""); this.render();
  }
  showDefinitionTypes(): void { this.show(); if (!this.panel.hidden) this.guard(() => { this.cancelDraft(); this.detailId = undefined; this.render(); }); }
  setLayers(layers: SpatialLayerVisibility): void { this.layers = { ...this.layers, ...layers }; this.applyVisibility(); }
  get isDrawing(): boolean { return this.drawing; } get isVisible(): boolean { return !this.panel.hidden; } getSnapshot(): SpatialSnapshot { return this.snapshot; }
  async load(report = false): Promise<SpatialSnapshot> {
    const generation = ++this.loadGeneration;
    try {
      const snapshot = await this.repository.load(); if (this.disposed || generation !== this.loadGeneration) return this.snapshot;
      this.snapshot = snapshot; this.rebuild(); this.options.onSnapshot(snapshot); if (!this.draft) this.render();
      // Reload never silently advances an existing draft's base revision.
      if (report) this.message(this.draft ? "已读取保存版本；当前修改继续保留" : "已读取保存的对象"); return snapshot;
    } catch (error) { if (!this.disposed && generation === this.loadGeneration) this.message("对象暂时无法读取，请重试", true); throw error; }
  }
  private savedObject(id: string): SpatialObject | undefined { return this.snapshot.objects.find(o => o.id === id && !o.deletedAt); }
  private selectObject(id: string): void {
    if (!this.savedObject(id)) return; this.cancelDraft(); this.detailId = id; this.selectedId = id; this.menuId = undefined; this.message(""); this.render(); this.options.onSelect(id, { fly: false });
  }
  private begin(kind: SpatialKind, original?: SpatialObject): void {
    if (!this.options.getContext()) return; this.cancelDraft(); this.baseRevision = this.snapshot.revision;
    const fields: Fields = { name: original?.name ?? nextSpatialName(kind, this.snapshot.objects.map(o => o.name)), description: original?.description || original?.risk?.description || "",
      responsiblePerson: original?.responsiblePerson || "", lineName: original?.lineName || "", riskType: original?.riskType || "", level: original?.level || original?.risk?.severity || "unassessed", areaId: original?.areaId || "", linkedMediaIds: [...(original?.linkedMediaIds || [])] };
    this.draft = { id: original?.id || crypto.randomUUID(), kind, fields, positions: original ? structuredClone(positionsOf(original)) : [], sources: structuredClone(original?.source.vertices || []),
      original, stage: original ? "name" : "draw", geometryLocked: !!original && (original.geometry.type === "Corridor" || !original.creationSource || original.source.vertices.some(v => !v.anchor)), initial: "", history: [], future: [] };
    this.draft.initial = signature(this.draft); this.detailId = undefined; this.selectedVertex = undefined; this.badEdges = [];
    this.setDrawing(true); this.makeDraftEntities(); this.refreshGeometry(); this.message(""); this.render(); this.applyVisibility();
  }
  private setDrawing(value: boolean): void {
    if (this.drawing !== value) { this.drawing = value; this.options.onDrawing(value); }
    this.options.viewer.canvas.style.cursor = value && this.draft?.stage === "draw" ? "crosshair" : ""; this.hint.hidden = !value; this.handles.hidden = !value;
  }
  private cancelDraft(): void {
    this.cancelDrag(); this.draft = undefined; this.hover = undefined; this.selectedVertex = undefined; this.badEdges = [];
    this.drafts.entities.removeAll(); this.handles.replaceChildren(); this.handlePoints = []; this.preview.setAttribute("hidden", ""); this.setDrawing(false); this.applyVisibility();
  }
  private redraw(): void {
    if (!this.draft) return; this.remember(); this.draft.positions = []; this.draft.sources = []; this.draft.geometryLocked = false; this.draft.stage = "draw";
    this.selectedVertex = undefined; this.badEdges = []; this.setDrawing(true); this.refreshGeometry(); this.message(""); this.render();
  }
  private geometryState(): GeometryState { const d = this.draft!; return structuredClone({ positions: d.positions, sources: d.sources, geometryLocked: d.geometryLocked }); }
  private remember(): void { if (this.draft) { this.draft.future = []; this.draft.history.push(this.geometryState()); if (this.draft.history.length > 100) this.draft.history.shift(); } }
  private undo(): void {
    if (!this.draft || this.saving || !this.draft.history.length) return;
    const current = this.geometryState(), previous = this.draft.history.pop()!;
    (this.draft.future ??= []).push(current); Object.assign(this.draft, previous);
    if (this.draft.geometryLocked) this.draft.stage = "name";
    this.selectedVertex = undefined; this.badEdges = []; this.refreshGeometry(); this.message(""); this.render();
  }
  private redo(): void {
    if (!this.draft || this.saving || !this.draft.future?.length) return;
    const current = this.geometryState(), next = this.draft.future.pop()!;
    this.draft.history.push(current); Object.assign(this.draft, next);
    if (this.draft.geometryLocked) this.draft.stage = "name";
    this.selectedVertex = undefined; this.badEdges = []; this.refreshGeometry(); this.message(""); this.render();
  }
  /** Commands from the shared management toolbar reuse the same validated draft. */
  command(action: "undo" | "redo" | "finish" | "cancel"): void {
    if (!this.active || this.saving) return;
    if (action === "undo") this.undo();
    else if (action === "redo") this.redo();
    else if (action === "finish") this.finish();
    else this.requestClose();
  }
  beginDefinition(kind: SpatialKind): void { this.show(); this.guard(() => this.begin(kind)); }
  editDefinition(id: string): void { this.show(); this.guard(() => { const item = this.savedObject(id); if (item) this.begin(item.kind, item); }); }
  private finish(): void {
    if (!this.draft || this.draft.stage !== "draw" || this.saving) return;
    const validation = validateDraftShape(this.draft.kind, this.draft.positions);
    if (!validation.ok) { this.badEdges = validation.badEdges; this.refreshGeometry(); this.message(validation.message, true); return; }
    this.draft.stage = "name"; this.hover = undefined; this.badEdges = []; this.setDrawing(true); this.refreshGeometry(); this.message(""); this.render();
    this.panel.querySelector<HTMLInputElement>('[data-spatial-field="name"]')?.focus();
  }


  private surfacePick(screen: Cartesian2): SurfacePickResult {
    return strictModelSurfacePick(this.options.viewer, screen, this.options.getModelRegistry?.() || [], this.options.suspendOverlays, this.options.getContext()?.dataset.projectId);
  }
  private showPickFailure(result: Extract<SurfacePickResult, { ok: false }>): void {
    this.message(result.reason === "model-loading" ? "该处模型尚未就绪，请稍后点选" : result.reason === "model-version-unavailable" ? "模型位置已更新，请重新打开配置后点选" : result.reason === "unsupported" ? "当前设备暂不支持模型点选，请换用支持此功能的浏览器" : "这里没有可选模型表面，请换一个位置", true);
  }
  private vertex(result: Extract<SurfacePickResult, { ok: true }>): VertexSource {
    return { pickKind: "model-depth", sourceHeight: result.position.height, sourceRecordId: result.anchor.model.assetId, anchor: result.anchor };
  }
  private click(screen: Cartesian2): void {
    if (!this.active || this.saving || this.pendingLeave) return;
    if (!this.draft) {
      const entity = this.options.viewer.scene.pick(screen)?.id as Entity | undefined;
      if (entity && this.source.entities.contains(entity)) { const id = entity.properties?.spatialObjectId?.getValue(); if (id) { this.options.onSelect(id, { fly: false }); if (!this.panel.hidden) { this.detailId = id; this.render(); } } }
      return;
    }
    if (this.draft.stage !== "draw") return;
    if (this.draft.positions.length >= 1024 && this.draft.kind !== "risk-point") { this.message("边界点已足够多，请完成本次绘制", true); return; }
    const picked = this.surfacePick(screen); if (!picked.ok) { this.showPickFailure(picked); return; }
    this.remember();
    if (this.draft.kind === "risk-point") { this.draft.positions = [picked.position]; this.draft.sources = [this.vertex(picked)]; }
    else { this.draft.positions.push(picked.position); this.draft.sources.push(this.vertex(picked)); }
    this.badEdges = []; this.refreshGeometry(); this.message(""); this.render();
  }
  private screenFromPointer(event: PointerEvent): Cartesian2 {
    const rect = this.options.viewer.canvas.getBoundingClientRect(); return new Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
  }
  private handleDown(event: PointerEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-spatial-vertex],[data-spatial-midpoint]"), draft = this.draft;
    if (!target || !draft || draft.stage !== "name" || draft.geometryLocked || this.pendingLeave || this.saving || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); const screen = this.screenFromPointer(event);
    if (target.dataset.spatialMidpoint !== undefined) {
      if (draft.positions.length >= 1024) return;
      const index = Number(target.dataset.spatialMidpoint), picked = this.surfacePick(screen);
      if (!picked.ok) { this.showPickFailure(picked); return; }
      this.remember(); draft.positions.splice(index + 1, 0, picked.position); draft.sources.splice(index + 1, 0, this.vertex(picked)); this.selectedVertex = index + 1;
      this.badEdges = []; this.refreshGeometry(); this.message(""); this.render(); return;
    }
    const index = Number(target.dataset.spatialVertex); this.selectedVertex = index;
    const controller = this.options.viewer.scene.screenSpaceCameraController;
    this.drag = { index, pointerId: event.pointerId, target, before: this.geometryState(), inputs: controller.enableInputs, lastPick: 0, moved: false, start: screen };
    controller.enableInputs = false; target.setPointerCapture(event.pointerId);
    this.handlePoints.forEach(h => h.element.classList.toggle("is-selected", h.element === target)); this.updateDeleteButton();
  }
  private handleMove(event: PointerEvent): void {
    const drag = this.drag, draft = this.draft; if (!drag || !draft || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); const screen = this.screenFromPointer(event);
    if (Cartesian2.distance(drag.start, screen) > 4) drag.moved = true;
    if (!drag.moved || performance.now() - drag.lastPick < 80) return;
    drag.lastPick = performance.now(); const picked = this.surfacePick(screen);
    if (!picked.ok) { this.showPickFailure(picked); return; }
    draft.positions[drag.index] = picked.position; draft.sources[drag.index] = this.vertex(picked); this.badEdges = []; this.refreshGeometry(false); this.message("");
  }
  private handleUp(event: PointerEvent): void {
    const drag = this.drag, draft = this.draft; if (!drag || !draft || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (drag.moved) {
      const picked = this.surfacePick(this.screenFromPointer(event));
      if (picked.ok) { draft.positions[drag.index] = picked.position; draft.sources[drag.index] = this.vertex(picked); draft.history.push(drag.before); this.message(""); }
      else { Object.assign(draft, drag.before); this.showPickFailure(picked); }
    }
    this.releaseDrag(); this.refreshGeometry(); this.render();
  }
  private releaseDrag(): void {
    if (!this.drag) return; const drag = this.drag; this.drag = undefined;
    this.options.viewer.scene.screenSpaceCameraController.enableInputs = drag.inputs;
    if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  }
  private cancelDrag(): void { if (this.drag) { if (this.draft) Object.assign(this.draft, this.drag.before); this.releaseDrag(); if (this.draft) this.refreshGeometry(); } }
  private deleteVertex(): void {
    const draft = this.draft;
    if (!draft || draft.geometryLocked || draft.kind === "risk-point" || this.selectedVertex === undefined || draft.positions.length <= 3) return;
    this.remember(); draft.positions.splice(this.selectedVertex, 1); draft.sources.splice(this.selectedVertex, 1); this.selectedVertex = undefined;
    this.badEdges = []; this.refreshGeometry(); this.message(""); this.render();
  }
  private updateDeleteButton(): void {
    const control = this.panel.querySelector<HTMLButtonElement>('[data-spatial="delete-vertex"]');
    if (control) { control.disabled = this.selectedVertex === undefined || (this.draft?.positions.length || 0) <= 3; control.textContent = this.selectedVertex === undefined ? "选择顶点后可删除" : "删除此点（第 " + (this.selectedVertex + 1) + " 个）"; }
  }
  private makeDraftEntities(): void {
    this.drafts.entities.removeAll(); if (!this.draft) return; const color = Color.fromCssColorString(colors[this.draft.kind]);
    this.drafts.entities.add({ id: "spatial-draft-line", polyline: { positions: new CallbackProperty(() => this.edgePositions, false), width: 3, material: color, depthFailMaterial: color.withAlpha(.3) } });
    this.drafts.entities.add({ id: "spatial-draft-fill", show: false, polygon: { hierarchy: new CallbackProperty(() => new PolygonHierarchy(this.draftPositions), false), perPositionHeight: true, material: color.withAlpha(.10) } });
  }
  private refreshGeometry(rebuildHandles = true): void {
    const draft = this.draft; if (!draft) return;
    this.draftPositions = draft.positions.map(cart); this.edgePositions = [...this.draftPositions];
    if (draft.stage === "name" && draft.kind !== "risk-point" && !draft.geometryLocked && this.edgePositions.length >= 3) this.edgePositions.push(this.edgePositions[0]);
    const line = this.drafts.entities.getById("spatial-draft-line"); if (line) line.show = !draft.geometryLocked;
    const fill = this.drafts.entities.getById("spatial-draft-fill"); if (fill) fill.show = draft.stage === "name" && draft.kind !== "risk-point" && !draft.geometryLocked && this.draftPositions.length >= 3;
    for (const entity of [...this.drafts.entities.values]) if (entity.id.startsWith("spatial-bad-edge:")) this.drafts.entities.remove(entity);
    for (const edge of this.badEdges) if (this.draftPositions[edge]) this.drafts.entities.add({ id: "spatial-bad-edge:" + edge, polyline: { positions: [this.draftPositions[edge], this.draftPositions[(edge + 1) % this.draftPositions.length]], width: 6, material: Color.fromCssColorString("#FF687D"), depthFailMaterial: Color.fromCssColorString("#FF687D") } });
    if (rebuildHandles) this.buildHandles(); else this.updateHandlePositions();
    this.applyVisibility(); this.positionHandles();
  }
  private buildHandles(): void {
    this.handles.replaceChildren(); this.handlePoints = []; const draft = this.draft; if (!draft || draft.geometryLocked) return;
    this.draftPositions.forEach((position, index) => {
      const node = document.createElement("button"); node.type = "button"; node.className = "spatial-vertex" + (this.selectedVertex === index ? " is-selected" : "");
      node.dataset.spatialVertex = String(index); node.setAttribute("aria-label", draft.kind === "risk-point" ? "风险点位置" : "边界点 " + (index + 1));
      node.title = draft.stage === "name" ? "拖动调整位置" : "已选第 " + (index + 1) + " 点"; node.style.pointerEvents = draft.stage === "name" ? "auto" : "none";
      this.handles.append(node); this.handlePoints.push({ element: node, position });
    });
    if (draft.stage === "name" && draft.kind !== "risk-point") this.draftPositions.forEach((p, index) => {
      const node = document.createElement("button"); node.type = "button"; node.className = "spatial-midpoint"; node.dataset.spatialMidpoint = String(index);
      node.setAttribute("aria-label", "在第 " + (index + 1) + " 条边添加顶点"); node.title = "点击增加顶点"; node.textContent = "+";
      this.handles.append(node); this.handlePoints.push({ element: node, position: Cartesian3.midpoint(p, this.draftPositions[(index + 1) % this.draftPositions.length], new Cartesian3()) });
    });
  }
  private updateHandlePositions(): void {
    const count = this.draftPositions.length;
    this.handlePoints.forEach((handle, i) => { if (i < count) handle.position = this.draftPositions[i]; else { const n = i - count; handle.position = Cartesian3.midpoint(this.draftPositions[n], this.draftPositions[(n + 1) % count], handle.position); } });
  }
  private positionHandles(): void {
    if (!this.active || !this.draft || this.panel.hidden || this.disposed) return;

    const { viewer, host } = this.options, canvasRect = viewer.canvas.getBoundingClientRect(), hostRect = host.getBoundingClientRect(), panelRect = this.panel.getBoundingClientRect();
    const offsetX = canvasRect.left - hostRect.left, offsetY = canvasRect.top - hostRect.top;
    for (const handle of this.handlePoints) {
      const pixel = viewer.scene.cartesianToCanvasCoordinates(handle.position);
      const forward = Cartesian3.dot(Cartesian3.subtract(handle.position, viewer.camera.positionWC, new Cartesian3()), viewer.camera.directionWC) > 0;
      const x = (pixel?.x ?? -10000) + offsetX, y = (pixel?.y ?? -10000) + offsetY;
      const covered = x + hostRect.left >= panelRect.left && x + hostRect.left <= panelRect.right && y + hostRect.top >= panelRect.top && y + hostRect.top <= panelRect.bottom;
      handle.element.hidden = !pixel || !forward || x < 0 || y < 0 || x > hostRect.width || y > hostRect.height || covered;
      handle.element.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-50%)";
    }
    const last = this.draftPositions.at(-1), pixel = last && viewer.scene.cartesianToCanvasCoordinates(last);
    const visible = this.draft.stage === "draw" && this.draft.kind !== "risk-point" && !!pixel && !!this.hover;
    this.preview.toggleAttribute("hidden", !visible);
    if (visible && pixel && this.hover) { this.previewLine.setAttribute("x1", String(pixel.x + offsetX)); this.previewLine.setAttribute("y1", String(pixel.y + offsetY)); this.previewLine.setAttribute("x2", String(this.hover.x + offsetX)); this.previewLine.setAttribute("y2", String(this.hover.y + offsetY)); }
  }
  private async save(): Promise<void> {
    const draft = this.draft, context = this.options.getContext(); if (!draft || !context || this.saving || draft.stage !== "name") return;
    if (!draft.fields.name.trim()) { this.message("请填写名称", true); const input = this.panel.querySelector<HTMLInputElement>('[data-spatial-field="name"]'); input?.setAttribute("aria-invalid", "true"); input?.focus(); return; }
    if (!draft.geometryLocked) {
      const validation = validateDraftShape(draft.kind, draft.positions);
      if (!validation.ok) { this.badEdges = validation.badEdges; this.refreshGeometry(); this.message(validation.message, true); return; }
      if (draft.sources.length !== draft.positions.length || draft.sources.some(v => !v.anchor)) { this.message("部分位置需要重新在模型上点选，请重新绘制", true); return; }
      const models = this.options.getModelRegistry?.() || [];
      if (draft.sources.some(vertex => !models.some(model => model.assetId === vertex.anchor!.model.assetId
        && model.assetVersion === vertex.anchor!.model.assetVersion && model.coordinateTransformVersion === vertex.anchor!.model.coordinateTransformVersion
        && model.projectId === context.dataset.projectId && !model.tileset.isDestroyed() && modelTransformMatches(model)))) {
        this.message("模型已更新或不可用，修改已保留，请重新定位后保存", true); return;
      }
    }
    const now = new Date().toISOString(), f = draft.fields, old = draft.original;
    const object: SpatialObject = {
      ...(old ? structuredClone(old) : {}), id: draft.id, kind: draft.kind, name: f.name.trim(), visible: old?.visible ?? true, projectId: context.dataset.projectId,
      geometry: draft.geometryLocked && old ? structuredClone(old.geometry) : draft.kind === "risk-point" ? { type: "Point", position: structuredClone(draft.positions[0]) } : { type: "Polygon", positions: structuredClone(draft.positions) },
      linkedNodeIds: [...(old?.linkedNodeIds || [])], linkedMediaIds: [...f.linkedMediaIds],
      source: draft.geometryLocked && old ? structuredClone(old.source) : { kind: "user-drawn", sceneCrs: "EPSG:4979", heightDatum: "unknown", vertices: structuredClone(draft.sources) },
      confirmation: { status: "user-confirmed", confirmedAt: now, scope: "geometry-and-description" }, createdAt: old?.createdAt || now, updatedAt: now,
    };
    if (!draft.geometryLocked) object.creationSource = "user_drawn_model_surface";
    const optional = (key: "description" | "responsiblePerson" | "lineName" | "riskType", value: string) => { if (value.trim()) object[key] = value.trim(); else delete object[key]; };
    optional("description", f.description); optional("responsiblePerson", f.responsiblePerson); optional("lineName", f.lineName); optional("riskType", f.riskType);
    if (draft.kind === "risk-point") { object.level = f.level; if (f.areaId) object.areaId = f.areaId; else delete object.areaId; }
    if (context.actorId) { object.createdBy ??= context.actorId; object.updatedBy = context.actorId; }
    this.setSaving(true);
    try {
      const snapshot = await this.repository.upsert(object, this.baseRevision); if (this.disposed) return;
      this.snapshot = snapshot; this.loadGeneration++; this.cancelDraft(); this.rebuild(); this.options.onSnapshot(snapshot);
      this.detailId = object.id; this.selectedId = object.id; this.render(); this.message("已保存" + names[object.kind]); this.options.onSelect(object.id, { fly: false });
    } catch (error) {
      if (!this.disposed) this.message(error instanceof SafetySpatialError && error.status === 409 ? (error.code === "MODEL_VERSION_CHANGED" ? "模型已更新，原位置与修改已保留；请重新定位后保存" : "对象已在其他操作中更新，修改已保留；请取消后重新打开") : "保存失败，修改已保留，请重试", true);
    } finally { if (!this.disposed) this.setSaving(false); }
  }
  private setSaving(value: boolean): void { this.saving = value; this.panel.setAttribute("aria-busy", String(value)); const control = this.panel.querySelector<HTMLButtonElement>('[data-spatial="save"]'); if (control) { control.disabled = value; control.textContent = value ? "正在保存…" : "保存"; } }
  private async remove(id: string): Promise<void> {
    if (!this.savedObject(id) || this.saving) return; this.setSaving(true);
    try { const snapshot = await this.repository.delete(id, this.snapshot.revision); if (this.disposed) return;
      this.snapshot = snapshot; this.loadGeneration++; this.detailId = undefined; this.menuId = undefined;
      this.rebuild(); this.options.onSnapshot(snapshot); this.render(); this.message("已删除，可随时恢复", false, id);
    } catch { if (!this.disposed) this.message("删除失败，对象仍保留，请重试", true); }
    finally { if (!this.disposed) this.setSaving(false); }
  }
  private async restore(id: string): Promise<void> {
    if (this.saving) return; this.setSaving(true);
    try { const snapshot = await this.repository.restore(id, this.snapshot.revision); if (this.disposed) return;
      this.snapshot = snapshot; this.loadGeneration++; this.rebuild(); this.options.onSnapshot(snapshot); this.detailId = id; this.recentDeleted = false; this.render(); this.message("已恢复对象");
    } catch { if (!this.disposed) this.message("恢复失败，请重试", true); }
    finally { if (!this.disposed) this.setSaving(false); }
  }
  private rebuild(): void {
    this.source.entities.removeAll(); this.entities.clear();
    for (const object of this.snapshot.objects) {
      if (object.deletedAt) continue;
      const entity = this.source.entities.add(createSpatialDisplayEntity(object));
      this.entities.set(object.id, entity);
    } this.applyVisibility();
  }
  update(view: SafetyView): void {
    this.filterIds = new Set([...view.nodes, ...view.breadcrumbs].map(n => n.spatialObjectId).filter((id): id is string => !!id)); this.selectedId = view.selected.spatialObjectId;
    const object = this.selectedId ? this.savedObject(this.selectedId) : undefined;
    if (object?.areaId) this.filterIds.add(object.areaId); if (object?.railwayId) this.filterIds.add(object.railwayId); this.applyVisibility();
  }
  setManagementSelection(ids?: readonly string[]): void { this.managementSelection = ids ? new Set(ids) : undefined; this.applyVisibility(); }
  setManagementTopic(value?: { colors: Record<string, string>; visibleIds?: readonly string[] }): void { this.managementTopic = value ? { colors: value.colors, visibleIds: value.visibleIds ? new Set(value.visibleIds) : undefined } : undefined; this.applyVisibility(); }
  private applyVisibility(): void {
    for (const object of this.snapshot.objects) {
      const entity = this.entities.get(object.id); if (!entity) continue;
      const layer = object.kind === "construction-area" ? this.layers.constructionAreas : object.kind === "railway" ? this.layers.railwayAreas : this.layers.riskPoints;
      entity.show = !object.deletedAt && object.visible && layer && (this.managementSelection !== undefined ? (this.managementTopic?.visibleIds?.has(object.id) ?? true) : (this.filterIds?.has(object.id) ?? true)) && !(this.draft?.id === object.id && !this.draft.geometryLocked);
      const selected = this.managementSelection?.has(object.id) ?? this.selectedId === object.id;
      const displayColor = Color.fromCssColorString(selected ? "#F5B45C" : this.managementTopic?.colors[object.id] || colors[object.kind]);
      if (entity.point) { entity.point.color = new ConstantProperty(displayColor); entity.point.pixelSize = new ConstantProperty(selected ? 15 : 12); }
      if (entity.polyline) {
        entity.polyline.material = new ColorMaterialProperty(displayColor);
        if (entity.polygon) entity.polygon.show = new ConstantProperty(this.managementSelection === undefined);
        const width = (this.managementSelection?.has(object.id) ?? this.selectedId === object.id) ? SPATIAL_BOUNDARY_WIDTH.selected : SPATIAL_BOUNDARY_WIDTH.normal;
        const property = entity.polyline.width;
        if (property instanceof ConstantProperty) { if (property.getValue() !== width) property.setValue(width); }
        else entity.polyline.width = new ConstantProperty(width);
      }
    } this.options.viewer.scene.requestRender();
  }


  private render(): void {
    const draft = this.draft, body = this.ref("body");
    this.panel.dataset.stage = draft?.stage || (this.detailId ? "detail" : this.recentDeleted ? "recent" : "choose");
    if (draft) {
      const stage = draft.stage === "draw" ? 2 : 3;
      const steps = '<div class="spatial-steps" aria-label="配置步骤">' + ["选类型", draft.kind === "risk-point" ? "选位置" : "画范围", "命名保存"].map((text, i) => '<span class="' + (i + 1 === stage ? "active" : i + 1 < stage ? "done" : "") + '"><i>' + (i + 1) + '</i>' + text + '</span>').join('<b aria-hidden="true">—</b>') + '</div>';
      const badge = '<div class="spatial-row"><span class="spatial-badge">' + icon(draft.kind) + (draft.original ? "编辑" : "新增") + names[draft.kind] + '</span><small>' + (draft.kind === "risk-point" ? (draft.positions.length ? "位置已选定" : "等待点选") : "已选 " + draft.positions.length + " 点") + '</small></div>';
      if (draft.stage === "draw") {
        const hint = draft.kind === "risk-point" ? (draft.positions.length ? "已选中候选位置" : "在模型上点击风险所在位置") : draft.kind === "railway" ? "沿需要界定的铁路范围边界依次点击" : "沿施工边界依次点击，至少 3 个点";
        body.innerHTML = steps + badge + '<div class="spatial-draw-hint"><strong>' + hint + '</strong><p>' + (draft.kind === "risk-point" ? "可以再次点击调整，确认后进入命名。" : "完成后仍可拖动顶点调整；拖动场景可旋转查看。") + '</p></div><div class="spatial-draw-count"><span>' + (draft.kind === "risk-point" ? (draft.positions.length ? "候选位置已就绪" : "等待选择位置") : '已选 <b>' + draft.positions.length + '</b> 个点') + '</span><small>Esc 取消</small></div><div class="spatial-button-row">' + button("撤销", "undo", false, draft.history.length ? "" : "disabled") + button("重做", "redo", false, draft.future?.length ? "" : "disabled") + button(draft.kind === "risk-point" ? "使用此位置" : "完成绘制", "finish", true, draft.positions.length >= (draft.kind === "risk-point" ? 1 : 3) ? "" : "disabled") + '</div><button type="button" class="spatial-text spatial-cancel" data-spatial="cancel">取消</button>';
        this.hint.textContent = draft.kind === "risk-point" ? "点击模型表面，选择风险位置" : "在模型上依次点选边界";
      } else {
        const f = draft.fields;
        const input = (field: keyof Fields, label: string, value: string) => '<label class="spatial-field">' + label + '<input data-spatial-field="' + field + '" value="' + esc(value) + '" maxlength="' + (field === "name" ? 120 : 200) + '" ' + (field === "name" ? 'required aria-required="true"' : "") + '/></label>';
        let more = draft.kind === "construction-area" ? input("responsiblePerson", "负责人", f.responsiblePerson) : draft.kind === "railway" ? input("lineName", "线路名称", f.lineName) : input("riskType", "风险类型", f.riskType);
        if (draft.kind === "risk-point") {
          const areas = this.snapshot.objects.filter(o => !o.deletedAt && o.kind === "construction-area");
          more += '<label class="spatial-field">所属施工区域<select data-spatial-field="areaId"><option value="">暂不关联</option>' + areas.map(o => '<option value="' + esc(o.id) + '" ' + (o.id === f.areaId ? "selected" : "") + '>' + esc(o.name) + '</option>').join("") + (f.areaId && !areas.some(o => o.id === f.areaId) ? '<option value="' + esc(f.areaId) + '" selected>原关联区域暂不可用</option>' : "") + '</select></label>';
          const media = this.options.getContext()?.dataset.media || [];
          more += '<label class="spatial-field">已有附件<select data-spatial-field="linkedMediaIds"><option value="">暂不关联</option>' + media.map(m => '<option value="' + esc(m.id) + '" ' + (f.linkedMediaIds.includes(m.id) ? "selected" : "") + '>' + esc(m.name) + '</option>').join("") + '</select></label>';
        }
        more += '<label class="spatial-field">' + (draft.kind === "railway" ? "用途说明" : "说明") + '<textarea data-spatial-field="description" rows="3" maxlength="4000">' + esc(f.description) + '</textarea></label>';
        const lockedText = draft.original?.geometry.type === "Corridor" ? "原铁路范围继续保留。调整边界请重新绘制多边形。" : "原位置继续保留。调整位置请重新在模型上点选。";
        body.innerHTML = steps + badge + input("name", "名称 <small>必填</small>", f.name)
          + (draft.kind === "risk-point" ? '<div class="spatial-field"><span>风险等级 <small>可稍后评估</small></span><div class="spatial-levels">' + Object.entries(levels).map(([value, label]) => '<button type="button" data-spatial="level" data-level="' + value + '" class="' + (f.level === value ? "active" : "") + '" aria-pressed="' + (f.level === value) + '">' + label + '</button>').join("") + '</div></div>' : "")
          + '<details class="spatial-more"><summary>更多信息（选填）</summary>' + more + '</details><div class="spatial-draw-hint"><strong>' + (draft.geometryLocked ? "需要调整原范围？" : draft.kind === "risk-point" ? "需要调整位置？" : "边界可以继续调整") + '</strong><p>'
          + (draft.geometryLocked ? lockedText : draft.kind === "risk-point" ? "重新选点后，点击“使用此位置”返回。" : "拖动顶点调整；点击边中点加点。选择顶点后可删除，至少保留 3 个。") + '</p>'
          + (draft.geometryLocked || draft.kind === "risk-point" ? '<button type="button" class="spatial-text" data-spatial="' + (draft.kind === "risk-point" ? "reposition" : "redraw") + '">' + (draft.kind === "risk-point" ? "重新选点" : "重新绘制多边形") + '</button>' : '<button type="button" class="spatial-text" data-spatial="delete-vertex" disabled>选择顶点后可删除</button>')
          + '</div><div class="spatial-button-row spatial-history-row">' + button("撤销", "undo", false, draft.history.length ? "" : "disabled") + button("重做", "redo", false, draft.future?.length ? "" : "disabled") + '</div><div class="spatial-button-row spatial-save-row">' + button("取消", "cancel") + button("保存", "save", true) + '</div>';
        this.updateDeleteButton(); this.hint.textContent = draft.kind === "risk-point" ? "位置已确定，命名后保存" : draft.geometryLocked ? "原范围已保留；可修改名称与说明" : "拖动亮色顶点，可微调边界";
      }
      this.positionHandles(); return;
    }
    const detail = this.detailId && this.savedObject(this.detailId);
    if (detail) {
      const area = detail.areaId && this.savedObject(detail.areaId);
      body.innerHTML = '<span class="spatial-badge is-saved">✓ 已保存</span><h3 class="spatial-detail-title">' + esc(detail.name) + '</h3><p class="spatial-note">场景中的位置与范围已同步更新。</p><dl class="spatial-details"><dt>对象类型</dt><dd>' + names[detail.kind] + '</dd>'
        + (detail.kind === "risk-point" ? '<dt>风险等级</dt><dd>' + levels[detail.level || detail.risk?.severity || "unassessed"] + '</dd><dt>所属区域</dt><dd>' + (area ? esc(area.name) : "未关联区域") + '</dd>' : '<dt>范围状态</dt><dd>' + (detail.geometry.type === "Corridor" ? "原有范围" : "已保存") + '</dd>')
        + (detail.description || detail.risk?.description ? '<dt>说明</dt><dd>' + esc(detail.description || detail.risk?.description || "") + '</dd>' : "")
        + '</dl><div class="spatial-button-row">' + button("返回列表", "choose") + button("编辑", "edit", true, 'data-id="' + esc(detail.id) + '"') + '</div><button type="button" class="spatial-text" data-spatial="more" data-id="' + esc(detail.id) + '">更多 ···</button>'
        + (this.menuId === detail.id ? '<div class="spatial-menu"><button type="button" class="spatial-text is-danger" data-spatial="delete" data-id="' + esc(detail.id) + '">删除对象</button></div>' : "");
      return;
    }
    const objects = this.snapshot.objects.filter(o => this.recentDeleted ? !!o.deletedAt : !o.deletedAt);
    body.innerHTML = (this.recentDeleted ? '<div class="spatial-row"><h3>最近删除</h3><button type="button" class="spatial-text" data-spatial="recent">返回列表</button></div><p class="spatial-note">恢复后保留原有资料关联。</p>'
      : '<div class="spatial-steps"><span class="active"><i>1</i>选类型</span><b>—</b><span><i>2</i>画范围</span><b>—</b><span><i>3</i>命名保存</span></div><div class="spatial-types">' + (["construction-area", "railway", "risk-point"] as const).map(kind => '<button type="button" data-spatial="' + (kind === "construction-area" ? "new-area" : kind === "railway" ? "new-railway" : "new-risk") + '">' + icon(kind) + '<span>' + names[kind] + '</span></button>').join("") + '</div><p class="spatial-note">选择一种类型，直接在模型上开始绘制。</p><div class="spatial-list-heading"><span>已保存对象 <b>' + objects.length + '</b></span><details class="spatial-list-more"><summary aria-label="更多列表操作">···</summary><div><button type="button" class="spatial-text" data-spatial="recent">最近删除</button><button type="button" class="spatial-text" data-spatial="reload">重新读取</button></div></details></div>')
      + '<div class="spatial-list">' + (objects.length ? objects.map(object => '<article class="spatial-object" data-spatial-object="' + esc(object.id) + '">' + icon(object.kind) + '<button type="button" class="spatial-object-name" data-spatial="' + (this.recentDeleted ? "restore-deleted" : "select") + '" data-id="' + esc(object.id) + '"><strong>' + esc(object.name) + '</strong><small>' + names[object.kind] + (object.kind === "risk-point" ? " · " + levels[object.level || object.risk?.severity || "unassessed"] + (object.areaId ? "" : " · 未关联区域") : "") + '</small></button>'
        + (this.recentDeleted ? '<button type="button" class="spatial-text" data-spatial="restore-deleted" data-id="' + esc(object.id) + '">恢复</button>' : '<button type="button" class="spatial-icon-button" data-spatial="edit" data-id="' + esc(object.id) + '" aria-label="编辑' + esc(object.name) + '">✎</button>') + '</article>').join("") : '<p class="spatial-empty">' + (this.recentDeleted ? "暂无删除的对象" : "尚未保存对象<br>请选择上方类型开始绘制") + '</p>') + '</div>';
  }
  debugStats() {
    return { revision: this.snapshot.revision, objects: this.snapshot.objects.map(o => ({ id: o.id, kind: o.kind, name: o.name, deleted: !!o.deletedAt })),
      entities: this.source.entities.values.length, visible: !this.panel.hidden, stage: this.panel.dataset.stage, drawing: this.drawing,
      draftVertices: this.draft?.positions.length || 0, canUndo: !!this.draft?.history.length, canRedo: !!this.draft?.future?.length, draftId: this.draft?.id, draftName: this.draft?.fields.name,
      draftGeometry: this.draft ? structuredClone({ positions: this.draft.positions, sources: this.draft.sources }) : undefined,
      selectedVertex: this.selectedVertex, selectedId: this.selectedId, dirty: !!this.draft && signature(this.draft) !== this.draft.initial,
      confirmDiscard: !!this.pendingLeave, handlerCount: this.disposed ? 0 : 1, postRenderListeners: this.disposed ? 0 : 1, strictModelPicking: true };
  }
  dispose(): void {

    if (this.disposed) return; this.forceHide(); this.disposed = true; this.loadGeneration++; this.events.abort(); this.removePostRender(); this.handler.destroy();
    this.options.viewer.dataSources.remove(this.source, true); this.options.viewer.dataSources.remove(this.drafts, true);
    this.panel.remove(); this.handles.remove(); this.hint.remove(); this.preview.remove(); this.discard.remove();
  }
}
