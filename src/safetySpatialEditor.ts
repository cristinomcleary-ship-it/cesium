import { CallbackPositionProperty, CallbackProperty, Cartesian2, Cartesian3, Cartographic, ClassificationType, Color, ConstantProperty, CustomDataSource, Entity, Math as CesiumMath, PolygonHierarchy, ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from "cesium";
import { SafetySpatialRepository } from "./safetySpatialRepository";
import { EMPTY_SPATIAL_SNAPSHOT, type SpatialKind, type SpatialObject, type SpatialSnapshot } from "./safetySpatialTypes";
import type { SafetyDataset, SafetyPosition, SafetyState, SafetyView } from "./safetyTypes";
import tokens from "./safetyDesignTokens.json";
import "./safetySpatialEditor.css";

type VertexSource = SpatialObject["source"]["vertices"][number];
type Draft = { id: string; kind: SpatialKind; polygonRail: boolean; positions: SafetyPosition[]; sources: VertexSource[]; original?: SpatialObject };
type EditorOptions = { viewer: Viewer; host: HTMLElement; onSnapshot: (snapshot: SpatialSnapshot) => void; onSelect: (id: string) => void; onDrawing: (drawing: boolean) => void; suspendOverlays: () => () => void; getContext: () => { dataset: SafetyDataset; state: SafetyState; mediaSeconds?: number; mediaId?: string } | undefined };
const names: Record<SpatialKind, string> = { "construction-area": "施工区域", railway: "铁路范围", "risk-point": "风险点" };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const cart = (p: SafetyPosition) => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height);

/** User-owned geometry, isolated persistence, and a draft handler on the existing Viewer. */
export class SafetySpatialEditor {
  private readonly repository = new SafetySpatialRepository();
  private snapshot: SpatialSnapshot = structuredClone(EMPTY_SPATIAL_SNAPSHOT);
  private readonly source = new CustomDataSource("人工空间对象");
  private readonly drafts = new CustomDataSource("空间标绘草稿");
  private readonly handler: ScreenSpaceEventHandler;
  private readonly panel = document.createElement("aside");
  private readonly events = new AbortController();
  private active = false;
  private disposed = false;
  private saving = false;
  private draft?: Draft;
  private drawing = false;
  private hover?: Cartesian3;
  private entities = new Map<string, Entity>();
  private readonly pickPoint = new Cartesian2();
  private selectedId?: string;
  private baseRevision = 0;
  private loadGeneration = 0;

  constructor(private readonly options: EditorOptions) {
    this.source.show = this.drafts.show = false;
    void options.viewer.dataSources.add(this.source); void options.viewer.dataSources.add(this.drafts);
    this.panel.className = "safety-spatial-editor"; this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "区域、铁路与风险标绘");
    this.panel.innerHTML = `<header><div><small>SPATIAL WORKSPACE</small><h2>区域与风险标绘</h2></div><button data-spatial="close" aria-label="关闭标绘面板">×</button></header>
      <p class="spatial-note">在真实场景点选。人工划定范围需现场复核，不代表批准红线或铁路限界。</p>
      <div class="spatial-create"><button data-spatial="new-area">＋ 施工区域</button><button data-spatial="new-railway">＋ 铁路范围</button><button data-spatial="new-risk">＋ 风险点</button></div>
      <div data-spatial-ref="form" hidden>
        <label>对象名称<input data-spatial-field="name" maxlength="120" /></label>
        <label data-spatial-ref="railway-shape">铁路表示<select data-spatial-field="shape"><option value="corridor">中心线＋总宽度</option><option value="polygon">闭合范围</option></select></label>
        <label data-spatial-ref="width">总宽度（米）<input data-spatial-field="width" type="number" min="0.5" max="1000" step="0.5" value="12" /></label>
        <div class="spatial-draw-actions"><button data-spatial="redraw">重新绘制</button><button data-spatial="undo">撤销末点</button><button data-spatial="finish">完成取点</button><button data-spatial="cancel">取消草稿</button></div>
        <p data-spatial-ref="vertices" class="spatial-status"></p>
        <div data-spatial-ref="risk-fields">
          <label>隐患等级<select data-spatial-field="severity"><option value="medium">关注</option><option value="high">高风险</option><option value="low">一般</option></select></label>
          <label>处置状态<select data-spatial-field="status"><option value="open">待复核</option><option value="rectifying">整改中</option><option value="closed">已闭环</option></select></label>
          <label>风险描述<textarea data-spatial-field="description" rows="2" maxlength="2000" placeholder="填写观察事实与待核实事项"></textarea></label>
          <label>关联施工区域<select data-spatial-field="area"></select></label><label>关联铁路范围<select data-spatial-field="railway"></select></label>
          <label>观察来源<select data-spatial-field="time-source"><option value="field-entry">现场人工登记 · 当前时间</option><option value="replay-review">当前原片回放复核 · 指定时刻</option></select></label>
          <p data-spatial-ref="time-note" class="spatial-note"></p>
        </div>
        <label>关联工程点<select data-spatial-field="node"></select></label>
        <label>关联媒体或图纸<select data-spatial-field="media"></select></label>
        <label class="spatial-check"><input data-spatial-field="confirmed" type="checkbox" /> 我已核对本次输入的几何与描述</label>
        <button class="spatial-save" data-spatial="save">确认并保存到本项目</button>
      </div>
      <div class="spatial-list-heading"><strong>已保存对象</strong><button data-spatial="restore">重新读取</button></div><div data-spatial-ref="objects"></div>
      <p data-spatial-ref="message" role="status" class="spatial-status"></p><p class="spatial-note">坐标 EPSG:4979；高度来源逐点记录，高程基准待核验。右键完成，Esc 取消本次取点。</p>`;
    options.host.append(this.panel);
    this.panel.addEventListener("click", e => {
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-spatial]");
      if (!target || this.saving) return;
      const action = target.dataset.spatial!, id = target.dataset.id;
      if (action === "close") this.hide();
      else if (action.startsWith("new-")) this.begin(action === "new-area" ? "construction-area" : action === "new-risk" ? "risk-point" : "railway");
      else if (action === "undo") { this.draft?.positions.pop(); this.draft?.sources.pop(); this.verticesChanged(); }
      else if (action === "finish") this.finish();
      else if (action === "cancel") this.cancel();
      else if (action === "redraw") { if (this.draft) { this.draft.positions = []; this.draft.sources = []; this.startPicking(); } }
      else if (action === "save") void this.save();
      else if (action === "restore") void this.load(true).catch(() => {});
      else if (id && action === "select") this.options.onSelect(id);
      else if (id && action === "edit") { const object = this.snapshot.objects.find(o => o.id === id); if (object) this.begin(object.kind, object); }
      else if (id && action === "delete") void this.remove(id);
      else if (id && action === "visibility") void this.toggleVisibility(id);
    }, { signal: this.events.signal });
    this.panel.addEventListener("change", e => {
      const name = (e.target as HTMLElement).dataset.spatialField;
      if (name === "shape" && this.draft) { this.draft.polygonRail = this.value("shape") === "polygon"; this.draft.positions = []; this.draft.sources = []; this.makeDraftEntities(); this.startPicking(); this.ref("width").hidden = this.draft.polygonRail; }
      if (name === "time-source") this.updateTimeNote();
      if (name === "width") this.makeDraftEntities();
    }, { signal: this.events.signal });
    document.addEventListener("keydown", e => { if (!this.active || !this.draft || (e.target as HTMLElement)?.closest("input,textarea,select")) return; if (e.key === "Escape") { e.preventDefault(); this.cancel(); } }, { signal: this.events.signal });
    this.handler = new ScreenSpaceEventHandler(options.viewer.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => this.click(e.position), ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: { endPosition: Cartesian2 }) => { if (!this.drawing) return; this.hover = options.viewer.camera.pickEllipsoid(e.endPosition, options.viewer.scene.globe.ellipsoid); options.viewer.scene.requestRender(); }, ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction(() => { if (this.drawing) this.finish(); }, ScreenSpaceEventType.RIGHT_CLICK);
  }
  private ref(name: string): HTMLElement { return this.panel.querySelector(`[data-spatial-ref="${name}"]`)!; }
  private field(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement { return this.panel.querySelector(`[data-spatial-field="${name}"]`)!; }
  private value(name: string): string { return this.field(name).value; }
  private message(text: string): void { this.ref("message").textContent = text; }
  setActive(active: boolean): void { this.active = active; this.source.show = active; this.drafts.show = active; if (!active) this.hide(); }
  show(): void { if (!this.active) return; this.panel.hidden = false; this.renderList(); }
  hide(): void { this.cancel(); this.panel.hidden = true; }
  async load(report = false): Promise<SpatialSnapshot> {
    const generation = ++this.loadGeneration;
    try { const snapshot = await this.repository.load(); if (this.disposed || generation !== this.loadGeneration) return this.snapshot; this.snapshot = snapshot; if (this.draft) { this.baseRevision = snapshot.revision; (this.field("confirmed") as HTMLInputElement).checked = false; } this.rebuild(); this.options.onSnapshot(snapshot); this.renderList(); if (report) this.message(`已恢复 ${snapshot.objects.length} 个对象 · 版本 ${snapshot.revision}。未保存草稿保留。`); return snapshot; }
    catch (e) { if (generation !== this.loadGeneration || this.disposed) return this.snapshot; this.message(e instanceof Error ? e.message : "读取失败"); throw e; }
  }
  get isDrawing(): boolean { return this.drawing; }
  getSnapshot(): SpatialSnapshot { return this.snapshot; }
  private begin(kind: SpatialKind, original?: SpatialObject): void {
    const context = this.options.getContext(); if (!context) return;
    this.cancel(); this.baseRevision = this.snapshot.revision;
    const geometry = original?.geometry;
    this.draft = { id: original?.id || crypto.randomUUID(), kind, polygonRail: geometry?.type === "Polygon" && kind === "railway", positions: geometry ? structuredClone(geometry.type === "Point" ? [geometry.position] : geometry.positions) : [], sources: structuredClone(original?.source.vertices || []), original };
    this.ref("form").hidden = false;
    this.field("name").value = original?.name ?? `${names[kind]} ${this.snapshot.objects.filter(o => o.kind === kind).length + 1}`;
    this.field("width").value = geometry?.type === "Corridor" ? String(geometry.widthMeters) : "12";
    this.field("shape").value = this.draft.polygonRail ? "polygon" : "corridor";
    this.ref("railway-shape").hidden = kind !== "railway"; this.ref("width").hidden = kind !== "railway" || this.draft.polygonRail;
    this.ref("risk-fields").hidden = kind !== "risk-point";
    this.field("severity").value = original?.risk?.severity || "medium"; this.field("status").value = original?.risk?.status || "open";
    this.field("description").value = original?.risk?.description || ""; this.field("time-source").value = original?.risk?.observationSource || "field-entry";
    const options = (items: Array<{ id: string; name: string }>) => '<option value="">不关联</option>' + items.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("");
    this.field("area").innerHTML = options(this.snapshot.objects.filter(o => o.kind === "construction-area")); this.field("area").value = original?.areaId || "";
    this.field("railway").innerHTML = options(this.snapshot.objects.filter(o => o.kind === "railway")); this.field("railway").value = original?.railwayId || "";
    this.field("node").innerHTML = options(context.dataset.nodes.filter(n => n.provenance === "real" && !n.navigationDisabledReason && !n.spatialObjectId)); this.field("node").value = original?.linkedNodeIds[0] || "";
    this.field("media").innerHTML = options(context.dataset.media); this.field("media").value = original?.linkedMediaIds[0] || "";
    (this.field("confirmed") as HTMLInputElement).checked = false;
    this.makeDraftEntities(); this.updateTimeNote();
    if (!original) this.startPicking(); else this.verticesChanged();
    this.message(original ? "编辑已保存对象；确认保存后才会更新项目文件。" : "已切换现场巡检。请在真实模型或地形单击取点；区域至少 3 点，中心线至少 2 点。右键完成。");
  }
  private startPicking(): void { this.drawing = true; this.options.onDrawing(true); this.options.viewer.canvas.style.cursor = "crosshair"; this.verticesChanged(); }
  private stopPicking(): void { this.drawing = false; this.hover = undefined; this.options.onDrawing(false); this.options.viewer.canvas.style.cursor = ""; this.options.viewer.scene.requestRender(); }
  private finish(): void {
    if (!this.draft) return;
    const minimum = this.draft.kind === "risk-point" ? 1 : this.draft.kind === "railway" && !this.draft.polygonRail ? 2 : 3;
    if (this.draft.positions.length < minimum) { this.message(`当前需要至少 ${minimum} 个点。`); return; }
    this.stopPicking(); this.verticesChanged(); this.message("取点完成。填写关联信息，核对后点击确认保存。");
  }
  private cancel(): void { this.stopPicking(); this.draft = undefined; this.drafts.entities.removeAll(); this.ref("form").hidden = true; }
  private pick(screen: Cartesian2): { position: SafetyPosition; source: VertexSource } | undefined {
    const { viewer } = this.options, scene = viewer.scene; let position: Cartesian3 | undefined, pickKind: VertexSource["pickKind"] = "ellipsoid";
    const restoreOverlays = this.options.suspendOverlays();
    const sourceShow = this.source.show, draftShow = this.drafts.show;
    const translucentDepth = scene.pickTranslucentDepth;
    scene.pickTranslucentDepth = false;
    this.source.show = this.drafts.show = false;
    try {
      // Render once without our geometry so pickPosition reads the real surface depth.
      // Only committed clicks do this; mouse movement uses an ellipsoid preview.
      scene.requestRender(); viewer.render();
      const picked = scene.pick(screen);
      if (picked && scene.pickPositionSupported) {
        position = scene.pickPosition(screen);
        if (position) pickKind = "model-depth";
      }
    } catch { /* Ground and ellipsoid remain explicit fallbacks. */ }
    finally { scene.pickTranslucentDepth = translucentDepth; this.source.show = sourceShow; this.drafts.show = draftShow; restoreOverlays(); scene.requestRender(); }
    if (!position) { const ray = viewer.camera.getPickRay(screen); if (ray) position = scene.globe.pick(ray, scene); if (position) pickKind = "terrain"; }
    position ??= viewer.camera.pickEllipsoid(screen, scene.globe.ellipsoid);
    if (!position) return;
    const c = Cartographic.fromCartesian(position); if (!Number.isFinite(c.height)) return;
    return { position: { longitude: CesiumMath.toDegrees(c.longitude), latitude: CesiumMath.toDegrees(c.latitude), height: c.height }, source: { pickKind, sourceHeight: c.height } };
  }
  private click(screen: Cartesian2): void {
    if (!this.active) return;
    if (!this.drawing || !this.draft) {
      const entity = this.options.viewer.scene.pick(screen)?.id as Entity | undefined;
      if (entity && this.source.entities.contains(entity)) { const id = entity.properties?.spatialObjectId?.getValue(); if (id) this.options.onSelect(id); }
      return;
    }
    this.pickPoint.x = screen.x; this.pickPoint.y = screen.y;
    const picked = this.pick(this.pickPoint); if (!picked) { this.message("此处未拾取到模型、地形或椭球，请在有效场景内点选。"); return; }
    if (this.draft.positions.length >= 512) { this.message("单个对象最多 512 个顶点。"); return; }
    this.draft.positions.push(picked.position); this.draft.sources.push(picked.source); this.verticesChanged();
    if (this.draft.kind === "risk-point") this.finish();
  }
  private verticesChanged(): void {
    if (!this.draft) return;
    const counts = this.draft.sources.reduce((m, s) => { m[s.pickKind] = (m[s.pickKind] || 0) + 1; return m; }, {} as Record<string, number>);
    this.ref("vertices").textContent = `${this.drawing ? "正在取点" : "已完成取点"} · ${this.draft.positions.length} 点 · 模型 ${counts["model-depth"] || 0} / 地形 ${counts.terrain || 0} / 椭球 ${counts.ellipsoid || 0}`;
    this.options.viewer.scene.requestRender();
  }
  private makeDraftEntities(): void {
    this.drafts.entities.removeAll(); if (!this.draft) return;
    const points = () => { const result = this.draft?.positions.map(cart) || []; if (this.hover && this.drawing) result.push(this.hover); return result; };
    const color = Color.fromCssColorString(tokens.colors.attention);
    this.drafts.entities.add({ id: "spatial-draft-line", polyline: { positions: new CallbackProperty(() => { const p = points(); if (this.draft?.kind === "construction-area" || this.draft?.polygonRail) { if (p.length > 2) p.push(p[0]); } return p; }, false), width: 3, material: color, depthFailMaterial: color.withAlpha(.5) } });
    this.drafts.entities.add({ id: "spatial-draft-cursor", position: new CallbackPositionProperty(() => points().at(-1), false), point: { pixelSize: 9, color, outlineColor: Color.WHITE, outlineWidth: 2 } });
  }
  private updateTimeNote(): void {
    const context = this.options.getContext();
    const replay = this.value("time-source") === "replay-review";
    this.ref("time-note").textContent = replay ? context?.mediaId && Number.isFinite(context.mediaSeconds) ? `明确关联当前原片 ${context.mediaSeconds!.toFixed(2)} 秒；观察时间使用当前回放时标。` : "当前没有可验证的原片回放时标，无法保存为回放复核。" : "观察时间使用本次登记时间；不会自动关联或跳转旧视频。";
  }
  private async save(): Promise<void> {
    const draft = this.draft, context = this.options.getContext(); if (!draft || !context || this.saving) return;
    if (this.drawing) { this.message("请先完成取点。"); return; }
    if (!(this.field("confirmed") as HTMLInputElement).checked) { this.message("请核对几何与描述并勾选确认。"); return; }
    const now = new Date().toISOString(), id = draft.id;
    const mediaId = this.value("media"), nodeId = this.value("node");
    const object: SpatialObject = { id, kind: draft.kind, name: this.value("name").trim(), visible: draft.original?.visible ?? true, projectId: context.dataset.projectId,
      geometry: draft.kind === "risk-point" ? { type: "Point", position: draft.positions[0] } : draft.kind === "railway" && !draft.polygonRail ? { type: "Corridor", positions: draft.positions, widthMeters: Number(this.value("width")) } : { type: "Polygon", positions: draft.positions },
      linkedNodeIds: nodeId ? [nodeId] : [], linkedMediaIds: mediaId ? [mediaId] : [],
      source: { kind: "user-drawn", sceneCrs: "EPSG:4979", heightDatum: "unknown", vertices: draft.sources },
      confirmation: { status: "user-confirmed", confirmedAt: now, scope: "geometry-and-description" }, createdAt: draft.original?.createdAt || this.snapshot.objects.find(o => o.id === id)?.createdAt || now, updatedAt: now };
    if (draft.kind === "risk-point") {
      const replay = this.value("time-source") === "replay-review";
      if (replay && (!context.mediaId || !Number.isFinite(context.mediaSeconds))) { this.message("当前没有可验证的原片时标；请选择现场登记或先打开项目原片。"); return; }
      object.areaId = this.value("area") || undefined; object.railwayId = this.value("railway") || undefined;
      object.risk = { severity: this.value("severity") as "high" | "medium" | "low", status: this.value("status") as "open" | "rectifying" | "closed", description: this.value("description").trim(), observationSource: replay ? "replay-review" : "field-entry",
        observedAt: replay ? context.state.time : (draft.original?.risk?.observationSource === "field-entry" ? draft.original.risk.observedAt : Date.now()),
        ...(replay ? { videoId: context.mediaId, mediaSeconds: context.mediaSeconds } : {}) };
      if (replay && context.mediaId && !object.linkedMediaIds.includes(context.mediaId)) object.linkedMediaIds.push(context.mediaId);
    }
    this.saving = true; this.panel.setAttribute("aria-busy", "true");
    try { this.snapshot = await this.repository.upsert(object, this.baseRevision); this.loadGeneration++; this.rebuild(); this.options.onSnapshot(this.snapshot); this.cancel(); this.renderList(); this.message(`已保存「${object.name}」· 版本 ${this.snapshot.revision}。可刷新页面恢复。`); this.options.onSelect(id); }
    catch (e) { this.message((e instanceof Error ? e.message : "保存失败") + "；草稿已保留。冲突时请重新读取后再核对保存。"); }
    finally { this.saving = false; this.panel.removeAttribute("aria-busy"); }
  }
  private async remove(id: string): Promise<void> {
    const button = this.panel.querySelector<HTMLButtonElement>(`[data-spatial="delete"][data-id="${CSS.escape(id)}"]`);
    if (button?.dataset.confirm !== "yes") { if (button) { button.dataset.confirm = "yes"; button.textContent = "确认删除"; } return; }
    this.saving = true;
    try { this.snapshot = await this.repository.delete(id, this.snapshot.revision); this.loadGeneration++; this.rebuild(); this.options.onSnapshot(this.snapshot); this.renderList(); this.message("已删除对象。其他对象的失效关联会保留提示。"); }
    catch (e) { this.message(e instanceof Error ? e.message : "删除失败"); }
    finally { this.saving = false; }
  }
  private async toggleVisibility(id: string): Promise<void> {
    const object = this.snapshot.objects.find(o => o.id === id); if (!object) return; this.saving = true;
    try { this.snapshot = await this.repository.upsert({ ...object, visible: !object.visible, updatedAt: new Date().toISOString() }, this.snapshot.revision); this.loadGeneration++; this.rebuild(); this.options.onSnapshot(this.snapshot); this.renderList(); }
    catch (e) { this.message(e instanceof Error ? e.message : "更新失败"); } finally { this.saving = false; }
  }
  private rebuild(): void {
    this.source.entities.removeAll(); this.entities.clear();
    for (const object of this.snapshot.objects) {
      const color = Color.fromCssColorString(object.kind === "railway" ? tokens.colors.attention : object.kind === "risk-point" ? tokens.colors.alert : tokens.colors.cyan);
      const common = { id: `spatial-geometry:${object.id}`, name: object.name, show: object.visible, properties: { spatialObjectId: object.id } };
      const g = object.geometry; let entity: Entity;
      if (g.type === "Point") entity = this.source.entities.add({ ...common, position: cart(g.position), point: { pixelSize: 13, color, outlineColor: Color.WHITE, outlineWidth: 2 } });
      else if (g.type === "Corridor") entity = this.source.entities.add({ ...common, corridor: { positions: g.positions.map(cart), width: g.widthMeters, material: color.withAlpha(.22), classificationType: ClassificationType.BOTH }, polyline: { positions: g.positions.map(cart), width: 3, clampToGround: true, material: color } });
      else entity = this.source.entities.add({ ...common, polygon: { hierarchy: new PolygonHierarchy(g.positions.map(cart)), material: color.withAlpha(.14), classificationType: ClassificationType.BOTH }, polyline: { positions: [...g.positions, g.positions[0]].map(cart), width: 3, clampToGround: true, material: color } });
      this.entities.set(object.id, entity);
    }
    this.options.viewer.scene.requestRender();
  }
  update(view: SafetyView): void {
    const ids = new Set([...view.nodes, ...view.breadcrumbs].map(n => n.spatialObjectId).filter(Boolean));
    const selected = view.selected.spatialObjectId; this.selectedId = selected;
    const selectedObject = this.snapshot.objects.find(o => o.id === selected);
    if (selectedObject?.areaId) ids.add(selectedObject.areaId);
    if (selectedObject?.railwayId) ids.add(selectedObject.railwayId);
    for (const object of this.snapshot.objects) { const entity = this.entities.get(object.id); if (!entity) continue; entity.show = object.visible && ids.has(object.id); if (entity.polyline) entity.polyline.width = new ConstantProperty(selected === object.id ? 5 : 3); }
  }
  private renderList(): void {
    this.ref("objects").innerHTML = this.snapshot.objects.length ? this.snapshot.objects.map(o => `<article class="spatial-object" data-spatial-object="${esc(o.id)}"><button class="spatial-object-name" data-spatial="select" data-id="${esc(o.id)}">${esc(o.name)}</button><small>${names[o.kind]} · 人工绘制${o.visible ? "" : " · 已隐藏"}</small><div><button data-spatial="edit" data-id="${esc(o.id)}">编辑</button><button data-spatial="visibility" data-id="${esc(o.id)}">${o.visible ? "隐藏" : "显示"}</button><button data-spatial="delete" data-id="${esc(o.id)}">删除</button></div></article>`).join("") : '<p class="spatial-note">还没有保存对象。从施工区域开始绘制。</p>';
  }
  debugStats() { return { revision: this.snapshot.revision, objects: this.snapshot.objects.map(o => ({ id: o.id, kind: o.kind, name: o.name })), entities: this.source.entities.values.length, draftVertices: this.draft?.positions.length || 0, drawing: this.drawing, selectedId: this.selectedId, handlerCount: this.disposed ? 0 : 1 }; }
  dispose(): void { if (this.disposed) return; this.cancel(); this.disposed = true; this.events.abort(); this.handler.destroy(); this.options.viewer.dataSources.remove(this.source, true); this.options.viewer.dataSources.remove(this.drafts, true); this.panel.remove(); }
}
