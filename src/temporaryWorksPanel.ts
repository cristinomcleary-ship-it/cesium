import { RoadRouteConflict, markConflictStations, type RoadConflictMark } from "./temporaryWorksRoadConflict";
import { Matrix4, ScreenSpaceEventHandler, ScreenSpaceEventType, type Cartesian2, type Cesium3DTileset, type Viewer } from "cesium";
import { checkProjectedControl, createPlanCoordinateFrame, createRoadCoordinateFrame, readPlanningCad, type PlanningCadCoordinates, type PlanningCadFeature } from "./temporaryWorksCad";
import { buildPlanningMesh, calculatePlanningEarthwork, refinePlanningCoverage, type PlanningDesign } from "./temporaryWorksGeometry";
import { formatRoadStation as stationLabel, pickPlanningReference, renderPlanningMesh, withPlanningSurface, type PlanningLocation } from "./temporaryWorksScene";
import { roadLength, validateRoadGrades, type RoadGradeRange, type RoadReferenceSource } from "./temporaryWorksRoad";
import { cgcs2000ZoneMeridian, parseLongitude } from "./coordinateUtils";
import { fitPlanningControls, renderPlanningCadPreview, type PlanningCadPreviewInput } from "./temporaryWorksPlacement";
import { renderRoadSectionPreview } from "./temporaryWorksRoadSectionView";
import { solveDrapedRoad } from "./temporaryWorksDrapedRoad";
import { loadTemporaryWorksGlbManifest, getTemporaryWorksGlbFootprints, type TemporaryWorksGlbConfig, type TemporaryWorksGlbManifest, type TemporaryWorksGlbResourceId } from "./temporaryWorksGlb";
import { glbFootprintsInsideSite } from "./temporaryWorksGlbSite";
import { fitTemporaryWorksGlbToBoundary } from "./temporaryWorksGlbAutoFit";
import { glbGroundSamplePoints, summarizeGlbGroundSamples } from "./temporaryWorksGlbGrounding";
import { renderTemporaryWorksGlb } from "./temporaryWorksGlbScene";
import { temporaryWorksFormHtml } from "./temporaryWorksForm";
import "./temporaryWorksPanel.css";

type Kind = "road" | "camp" | "steel";
type FacilityMode = "glb" | "standard" | "cad" | "pad";
const FACILITY_MODES = {glb:"真实 GLB 模型", standard:"标准设施模型", cad:"CAD 建筑轮廓", pad:"仅硬化场坪"};
type Unit = "m" | "cm" | "mm";
type Triangle = [number, number, number];
type Building = { footprint: PlanningLocation[]; height: number };
type Vertex = PlanningLocation & { surfaceHeight: number; baseHeight: number; groundHeight: number; formationHeight: number;
  roadOffset?: number; roadStation?: number; roadPart?: "core" | "slope" };
type Model = { id: string; name: string; tileset: Cesium3DTileset };
type MeshHandle = ReturnType<typeof renderPlanningMesh> | ReturnType<typeof renderTemporaryWorksGlb>;
type Metrics = Pick<ReturnType<typeof calculatePlanningEarthwork>, "planArea" | "coveredArea" | "excludedArea" | "cutVolume" | "fillVolume">;
type RegistrationAudit = ReturnType<typeof fitPlanningControls> & {
  second: {cad:{x:number;y:number};geo:PlanningLocation};
};
type ProjectedCheck = ReturnType<typeof checkProjectedControl> & {cad:{x:number;y:number};geo:PlanningLocation};
type RoadAudit = {
  surfaceMode?: "draped";
  missingTriangles?: number;
  steepTriangles?: number;
  unresolvedTriangles?: number;
  maxObservedDeviation?: number;
  sampleSpacing?: number;
  surfaceTolerance?: number;
  maxSlope?: number;
  datumMode?: "road-start" | "road-coverage";
  referenceSource?: RoadReferenceSource;
  referenceDistance?: number;
  pavementStationRange?: [number, number];
  bendJoin?: "round-union";
  samplingBatches?: number;
  length: number; reversed: boolean; grades: RoadGradeRange[]; slopeHeight: number; slopeWidth: number; referenceStation: number;
  hardeningBottomWidth: number; formationWidth: number; pavementArea: number; coveredPavementArea: number;
};

const KIND_NAMES = { road: "施工便道", camp: "项目驻地", steel: "钢筋加工场" };
const valueText = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
function roadDatumDescription(road: RoadAudit) {
  if (road.referenceSource === "nearby")
    return `起点缺测，取距起点 ${valueText(road.referenceDistance!)} m 的模型表面高程，校准桩号为 ${stationLabel(0)}`;
  if (road.referenceSource === "entry")
    return `起点及其邻域缺测，在首个有效路面桩号 ${stationLabel(road.referenceStation)} 取高并校准`;
  return `取 ${stationLabel(road.referenceStation)} 处的模型表面高程`;
}
const defaultLogoUrl = () => `${import.meta.env?.BASE_URL ?? "/"}models/temporary-works/cr24-logo.png`;
const newId = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
const fileExtension = (name: string) => name.split(".").pop()?.toLowerCase() || "";
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};

export interface TemporaryWorksPlan {
  id: string;
  name: string;
  kind: Kind;
  visible: boolean;
  createdAt: string;
  modelId: string;
  modelName: string;
  inputs: {
    cadName: string;
    modelMatrix: number[];
    modelRootTransform: number[];
    feature: PlanningCadFeature;
    coordinates: PlanningCadCoordinates;
    registration?: RegistrationAudit;
    projectedCheck?: ProjectedCheck;
    reference: PlanningLocation & { height: number };
    referenceInput: { mode: "geo" | "cad"; first: number; second: number };
    design: PlanningDesign;
    width?: number;
    road?: RoadAudit;
    facilityMode?: FacilityMode;
    facilityPlacement?: NonNullable<MeshHandle["standardPlacement"]>;
    campYard?: boolean;
    campLayout?: {flag:boolean; spaces:number};
    spacing: number;
    sampleCount: number;
    refinementLevels: number;
    budgetLimited: boolean;
    sectionName?: string;
    sectionFeature?: string;
    sectionUnit?: Unit;
    thicknessSource?: string;
    structures?: { feature: string; layer: string; included: boolean }[];
  };
  mesh: { vertices: Vertex[]; triangles: Triangle[] };
  building?: Building;
  buildings?: Building[];
  metrics: Metrics;
  sectionAttachment?: File;
  glb?: TemporaryWorksGlbConfig;
  earthworkDisabled?: boolean;
}

export interface TemporaryWorksStore {
  list(projectId: string): Promise<TemporaryWorksPlan[]>;
  put(projectId: string, plan: TemporaryWorksPlan): Promise<void>;
  updateExisting(projectId: string, id: string, update: (plan: TemporaryWorksPlan) => TemporaryWorksPlan): Promise<TemporaryWorksPlan>;
  remove(projectId: string, id: string): Promise<void>;
}

function canAddStandardFacility(plan: TemporaryWorksPlan) {
  return plan.kind !== "road" && (!plan.inputs.facilityMode || plan.inputs.facilityMode === "pad")
    && !plan.building && !plan.buildings?.length && !plan.inputs.structures?.length;
}

export type TemporaryWorksDisplayItem = { id: string; name: string; typeName: string; visible: boolean };
export interface TemporaryWorksPanelOptions {
  root: HTMLElement;
  viewer: Viewer;
  getTilesets(): Model[];
  store: TemporaryWorksStore;
  beginInteractionSession?(): void | (() => void);
  toast?(message: string, error?: boolean): void;
  onPlansChanged?(): void;
  onVisibilityChange?(id: string, visible: boolean): void;
  onRequestRemove?(id: string): Promise<void>;
  canEdit?(): boolean;
  onRequestClose?(): void;
}

const compactNumber = (value: number) => String(Number(value.toFixed(6)));

function drawFeature(host: HTMLElement, feature?: PlanningCadFeature, endpointLabels = false, reversed = false, conflict: readonly RoadConflictMark[] = []) {
  host.replaceChildren();
  if (!feature || feature.points.length < 2) return;
  const bounds = feature.points.reduce((b, p) => ({
    minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
    minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
  const scale = Math.min(360 / Math.max(w, 1e-12), 94 / Math.max(h, 1e-12));
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  const stride = Math.max(1, Math.ceil(feature.points.length / 3000));
  const previewPoints = feature.points.filter((_, i) => i % stride === 0 || i === feature.points.length - 1);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 400 120");
  svg.dataset.centerX = String(cx); svg.dataset.centerY = String(cy); svg.dataset.scale = String(scale);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", feature.closed ? "所选闭合 CAD 范围" : "所选 CAD 线形");
  svg.style.width = "100%";
  svg.style.maxHeight = "120px";
  const shape = document.createElementNS(ns, feature.closed ? "polygon" : "polyline");
  shape.setAttribute("points", previewPoints.map(p => `${200 + (p.x - cx) * scale},${60 - (p.y - cy) * scale}`).join(" "));
  shape.setAttribute("fill", feature.closed ? "rgba(45,183,173,.19)" : "none");
  shape.setAttribute("stroke", "#53ddcd");
  shape.setAttribute("stroke-width", "2.1");
  svg.append(shape);
  if (endpointLabels) {
    const points = feature.points;
    const first = reversed ? points.at(-1)! : points[0], last = reversed ? points[0] : points.at(-1)!;
    for (const [which, point, text, color] of [["start", first, "起点", "#68ecac"], ["end", last, "终点", "#ffb95c"]] as const) {
      const x = 200 + (point.x - cx) * scale, y = 60 - (point.y - cy) * scale;
      const group = document.createElementNS(ns, "g");
      group.setAttribute("data-route-endpoint", which);
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(y)); dot.setAttribute("r", "4");
      dot.setAttribute("fill", color); dot.setAttribute("stroke", "#112436");
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(Math.min(388, Math.max(12, x))));
      const yOffset = y < 26 ? 16 : which === "start" || y > 88 ? -8 : 16;
      label.setAttribute("y", String(y + yOffset)); label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "12"); label.setAttribute("fill", color);
      label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "#0a1521"); label.setAttribute("stroke-width", "3");
      label.textContent = text; group.append(dot, label); svg.append(group);
    }
  }
  for (const [index, mark] of conflict.entries()) {
    const color = index === 0 ? "#ff9b70" : "#f6d76e";
    const at = (p: {x:number;y:number}) => [200 + (p.x - cx) * scale, 60 - (p.y - cy) * scale];
    const [x,y] = at(mark.point);
    const g = document.createElementNS(ns,"g");
    g.setAttribute("data-road-conflict-segment",String(index+1));
    const seg = document.createElementNS(ns,"polyline");
    seg.setAttribute("points",[at(mark.from),at(mark.to)].map(p => p.join(",")).join(" "));
    seg.setAttribute("fill","none"); seg.setAttribute("stroke",color); seg.setAttribute("stroke-width","3.5");
    const circle = document.createElementNS(ns,"circle");
    circle.setAttribute("cx",String(x)); circle.setAttribute("cy",String(y));
    circle.setAttribute("r",index===0?"5":"7"); circle.setAttribute("fill","none"); circle.setAttribute("stroke",color);
    const title = document.createElementNS(ns,"title"); title.textContent = stationLabel(mark.station);
    g.append(title,seg,circle); svg.append(g);
  }
  host.append(svg);
  const caption = element("small", `${endpointLabels ? "完整 CAD 中心线（平面）　" : ""}X ${valueText(bounds.minX)} ～ ${valueText(bounds.maxX)}　Y ${valueText(bounds.minY)} ～ ${valueText(bounds.maxY)}（图纸坐标）`);
  host.append(caption);
  if (conflict.length) {
    const note = element("p", conflict.map((p, i) =>
      `${i + 1}. ${stationLabel(p.station)}（CAD X=${valueText(p.point.x)}，Y=${valueText(p.point.y)}）`).join("　"));
    note.dataset.roadConflictDetails = ""; note.className = "tw-conflict-note";
    host.append(note);
  }
}

function featureLabel(f: PlanningCadFeature, n: number) {
  const type = f.id.startsWith("chain-") ? f.sourceType : `原始 ${f.sourceType}`;
  return `${n + 1}. ${f.layer} · ${type} · ${f.closed ? "闭合" : "开放"} · ${f.points.length} 点 · ${f.id}`;
}

function showAttachment(host: HTMLElement, file: File, url: string) {
  host.replaceChildren();
  if (fileExtension(file.name) === "pdf") {
    const object = element("object");
    object.type = "application/pdf";
    object.data = url;
    object.setAttribute("aria-label", `典型断面图 · ${file.name}`);
    host.append(object);
    const link = element("a", "打开 PDF 原图");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    host.append(link);
  } else {
    const img = element("img");
    img.alt = `典型断面图 · ${file.name}`;
    img.src = url;
    host.append(img);
  }
}

/** Project plans are stored after explicit save. Edits always retire their corresponding preview. */
export class TemporaryWorksPanel {
  private projectId: string | null = null;
  private active = false;
  private disposed = false;
  private readonly listeners = new AbortController();
  private generation = 0;
  private analysis?: AbortController;
  private cadRead?: AbortController;
  private sectionRead?: AbortController;
  private pickHandler?: ScreenSpaceEventHandler;
  private finishPicking?: () => void;
  private busySave = false;
  private upgrading?: string;
  private cadPick?: AbortController;
  private overlayJob?: AbortController;
  private overlay?: Awaited<ReturnType<typeof renderPlanningCadPreview>>;
  private overlaySource?: () => boolean;
  private registration?: RegistrationAudit;
  private projected?: {check:ProjectedCheck; applied:boolean; sourceValid:()=>boolean};
  private editAccess = false;
  private cadFile?: File;
  private sectionFile?: File;
  private cad: PlanningCadFeature[] = [];
  private sections: PlanningCadFeature[] = [];
  private roadFeature?: PlanningCadFeature;
  private reversed = false;
  private measuredLength = 0;
  private thicknessSource?: string;
  private sectionUrl?: string;
  private reviewUrl?: string;
  private preview?: { record: TemporaryWorksPlan; handle: MeshHandle; checkSource(): void; replaceId?: string };
  private readonly records = new Map<string, TemporaryWorksPlan>();
  private readonly handles = new Map<string, MeshHandle>();
  private readonly pendingDelete = new Set<string>();
  private readonly overrides = new Map<string, boolean>();
  private selectedModel = "";
  private lastCadInfo = "";
  private inspecting?: string;
  private upgradeEnabled = true;
  private manifest?: TemporaryWorksGlbManifest;
  private glbEditing?: string;
  private glbLogo: string | undefined = defaultLogoUrl();
  private glbLogoReadToken = 0;
  private glbAutoFit?: TemporaryWorksGlbConfig["autoFit"];

  constructor(private readonly options: TemporaryWorksPanelOptions) {
    this.options.root.innerHTML = temporaryWorksFormHtml;
    const on = (type: string, fn: (event: Event) => void) => options.root.addEventListener(type, fn, { signal: this.listeners.signal });
    on("click", event => this.click(event));
    on("input", event => this.edited(event));
    on("change", event => this.changed(event));
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !this.active) return;
      if (this.pickHandler || this.cadPick || this.analysis || this.overlayJob) this.cancel();
    }, { signal: this.listeners.signal });
    this.updateFields(); this.featurePreview();
    this.refresh();
    this.list();
    this.buttons();
    void this.loadGlbResources();
  }

  private el<T extends HTMLElement = HTMLElement>(key: string) {
    const target = this.options.root.querySelector<T>(`#tw-${key}`);
    if (!target) throw new Error(`临建规划界面缺少 ${key}`);
    return target;
  }
  private input(k: string) { return this.el<HTMLInputElement>(k); }
  private select(k: string) { return this.el<HTMLSelectElement>(k); }
  private value(k: string) { return this.input(k).value.trim(); }
  private num(k: string, label: string) {
    const value = this.value(k);
    if (!value || !Number.isFinite(Number(value))) throw new Error(`请填写有效的${label}。`);
    return Number(value);
  }
  private kind(): Kind { return this.select("kind").value as Kind; }
  private isGlb() { return this.kind() !== "road" && this.facilityMode() === "glb"; }
  private newPlan(plan: TemporaryWorksPlan) { return !!plan.glb || plan.inputs?.road?.surfaceMode === "draped"; }
  private visible(plan: TemporaryWorksPlan) { return (this.overrides.get(plan.id) ?? plan.visible) && (!this.newPlan(plan) || this.upgradeEnabled); }
  private resourceId() { return this.value("glb-resource") as TemporaryWorksGlbResourceId; }
  private resource() { return this.manifest?.assets.find(asset => asset.id === this.resourceId()); }
  private facilityMode() { return this.select("facility-mode").value as FacilityMode; }
  private feature() { return this.cad.find(f => f.id === this.value("feature")); }
  private editable() { return this.projectId !== null && this.options.canEdit?.() !== false; }
  private model() {
    const model = this.options.getTilesets().find(m => m.id === this.value("model"));
    if (!model) throw new Error("请在场景中加载、显示并选择本次使用的倾斜摄影模型。");
    return model;
  }
  private status(message: string, error = false) {
    const status = this.el("status");
    status.textContent = message;
    status.toggleAttribute("data-error", error);
    if (error) this.options.toast?.(message, true);
  }
  private failure(error: unknown) {
    this.status(error instanceof Error ? error.message : String(error), true);
  }
  private buttons() {
    if (this.disposed) return;
    this.input("run").disabled = !this.upgradeEnabled || !this.editable() || (!this.isGlb() && !this.feature()) || !!(this.analysis || this.cadRead || this.sectionRead) || this.busySave;
    this.input("place-facility").disabled = !this.upgradeEnabled || !this.editable() || !!(this.analysis || this.cadRead || this.sectionRead) || this.busySave;
    this.input("glb-use-boundary").disabled = this.resourceId() === "wall" || !this.upgradeEnabled || !this.editable() || !!(this.analysis || this.cadRead || this.sectionRead) || this.busySave;
    for (const key of ["cad", "section"]) {
      const hasFile = !!this.input(key).files?.length;
      this.input("remove-" + key).disabled = !hasFile || this.busySave;
      this.input("replace-" + key).disabled = !hasFile || this.busySave;
    }
    this.input("save").disabled = !this.editable() || !this.preview || this.busySave;
    this.el("draft-actions").hidden = !this.preview;
    if (this.preview) {
      const visible = this.preview.handle.show;
      const visibility = this.el<HTMLButtonElement>("draft-visibility");
      visibility.textContent = visible ? "隐藏模型预览" : "显示模型预览";
      visibility.setAttribute("aria-pressed", String(visible));
      visibility.disabled = this.busySave;
      this.input("discard-draft").disabled = this.busySave;
      this.input("draft-drawing").disabled = this.busySave || !!this.overlayJob;
    }
    this.input("cancel").disabled = !this.analysis && !this.pickHandler && !this.cadPick && !this.overlayJob;
    this.input("place-preview").disabled = !this.feature() || !this.value("model") || !!(this.analysis || this.cadRead || this.overlayJob);
    this.input("place-zoom").disabled = !this.overlay;
    this.input("place-hide").disabled = !this.overlay && !this.overlayJob;
    this.input("pick").disabled = !this.projectId || !!this.analysis;
  }

  open() { this.active = true; this.refresh(); this.list(); }
  close() {
    this.active = false;
    this.clearOverlay();
    this.cancel(false);
    this.dropPreview();
    this.clearReview();
  }
  destroy() {
    if (this.disposed) return;
    this.cancel(false);
    this.listeners.abort();
    void this.setProject(null);
    if (this.sectionUrl) URL.revokeObjectURL(this.sectionUrl);
    this.disposed = true;
    this.options.root.replaceChildren();
  }

  async setProject(projectId: string | null) {
    const editable = projectId !== null && this.options.canEdit?.() !== false;
    const permissionChanged = editable !== this.editAccess;
    this.editAccess = editable;
    if (projectId === this.projectId) {
      if (permissionChanged) { this.list(); this.buttons(); }
      return;
    }
    this.clearOverlay(); this.registration = undefined; this.projected=undefined;
    this.projectId = projectId;
    try { this.upgradeEnabled = !projectId || localStorage.getItem(`cesium-temporary-works-upgrade:${projectId}`) !== "off"; }
    catch { this.upgradeEnabled = true; }
    const token = ++this.generation;
    this.cancel(false);
    this.cadRead?.abort(); this.cadRead = undefined;
    this.sectionRead?.abort(); this.sectionRead = undefined;
    this.dropPreview(); this.clearReview();
    for (const handle of this.handles.values()) handle.destroy();
    this.records.clear(); this.handles.clear(); this.overrides.clear();
    this.busySave = false;
    this.cadFile = this.sectionFile = undefined;
    this.cad = []; this.sections = []; this.roadFeature = undefined; this.reversed = false; this.measuredLength = 0; this.thicknessSource = undefined;
    if (this.sectionUrl) URL.revokeObjectURL(this.sectionUrl);
    this.sectionUrl = undefined; this.selectedModel = ""; this.lastCadInfo = "";
    this.options.root.innerHTML = temporaryWorksFormHtml;
    this.input("upgrade-enabled").checked = this.upgradeEnabled;
    this.glbEditing = undefined; this.glbAutoFit = undefined; this.glbLogo = defaultLogoUrl(); this.glbLogoReadToken++;
    this.updateGlbResource();
    this.refresh(); this.list(); this.updateFields(); this.featurePreview();
    this.options.onPlansChanged?.();
    if (!projectId) { this.status("请选择项目后打开临建规划。"); return; }
    try {
      const plans = await this.options.store.list(projectId);
      if (this.generation !== token) return;
      for (const plan of plans) {
        if (this.records.has(plan.id)) continue;
        this.records.set(plan.id, plan);
        try { this.restoreDrawing(plan); }
        catch (error) { this.failure(error); }
      }
      this.list(); this.options.onPlansChanged?.();
    } catch (error) { if (token === this.generation) this.failure(error); }
    this.buttons();
  }

  refresh() {
    const s = this.select("model");
    const previous = this.selectedModel || s.value;
    const items = this.options.getTilesets();
    if (this.projected && !this.projected.sourceValid()) {
      this.resetProjected(); this.clearOverlay("模型位置已更改。请重新复核投影位置。");
      this.dropPreview(); this.input("confirmed").checked = false; this.projectionReadout();
    }
    if (this.overlaySource && !this.overlaySource()) this.clearOverlay("模型或定位已变更，请重新预览。");
    const current = items.find(m => m.id === previous)?.id ?? (!previous && items.length === 1 ? items[0].id : "");
    if (previous && previous !== current) { this.cancel(false); this.dropPreview(); }
    if (this.preview) {
      try { this.preview.checkSource(); }
      catch (error) { this.dropPreview(); this.failure(error); }
    }
    const placeholder = items.length ? "选择倾斜摄影模型" : "请先加载并显示倾斜摄影";
    const unchanged = s.options.length === items.length + 1 && s.options[0]?.text === placeholder &&
      items.every((item, i) => s.options[i + 1].value === item.id && s.options[i + 1].text === item.name);
    if (!unchanged)
      s.replaceChildren(new Option(placeholder, ""), ...items.map(m => new Option(m.name, m.id)));
    if (s.value !== current) s.value = current;
    this.selectedModel = current;
    for (const [id, handle] of this.handles) {
      const plan = this.records.get(id);
      if (plan?.glb && "setTileset" in handle) handle.setTileset(items.find(item => item.id === plan.modelId)?.tileset);
    }
    this.buttons();
  }
  getDisplayItems(): TemporaryWorksDisplayItem[] {
    return [...this.records.values()].map(p => ({ id: p.id, name: p.name, typeName: p.glb?.resourceId === "wall" ? "独立宣传墙" : KIND_NAMES[p.kind], visible: p.visible }));
  }
  setPlanVisible(id: string, visible: boolean) {
    if (!this.records.has(id)) return;
    const handle = this.handles.get(id), record = this.records.get(id)!;
    const renderedVisible = visible && (!this.newPlan(record) || this.upgradeEnabled);
    if ((this.overrides.get(id) ?? record.visible) === visible && (!handle || handle.show === renderedVisible)) return;
    this.overrides.set(id, visible);
    if (handle) handle.show = renderedVisible;
    this.list();
  }
  private async changePlanVisibility(id: string, visible: boolean) {
    const record = this.records.get(id), projectId = this.projectId, token = this.generation;
    if (!record) return;
    if (this.newPlan(record) && projectId && this.editable()) {
      const saved = await this.options.store.updateExisting(projectId,id,stored=>({...stored,visible}));
      if (token !== this.generation || !this.records.has(id)) return;
      this.records.set(id,saved);
    }
    this.setPlanVisible(id,visible);
    this.options.onVisibilityChange?.(id,visible);
  }
  locatePlan(id: string) { this.handles.get(id)?.zoom(); }
  inspectPlan(id: string) {
    const plan = this.records.get(id);
    if (!plan) return;
    this.cancel(false); this.dropPreview(); this.review(plan, true);
  }
  private draw(plan: TemporaryWorksPlan): MeshHandle {
    if (plan.glb) {
      const handle = renderTemporaryWorksGlb(this.options.viewer, {
        id: plan.id, ...plan.glb,
        tileset: this.options.getTilesets().find(item => item.id === plan.modelId)?.tileset,
        onStatus: message => { if (!this.disposed) this.el("glb-clip-status").textContent = message.message; },
      });
      handle.show = this.visible(plan);
      return handle;
    }
    const road = plan.inputs.road;
    let standard: {boundary: PlanningLocation[]} | undefined;
    if (plan.kind !== "road" && plan.inputs.facilityMode === "standard") {
      const outline = plan.inputs.feature.points;
      const frame = createPlanCoordinateFrame(plan.inputs.coordinates, outline[0]);
      standard = {boundary:outline.map(p => frame.localToGeo(frame.cadToLocal(p)))};
    }
    const h = renderPlanningMesh(this.options.viewer, plan.kind, plan.mesh.vertices, plan.mesh.triangles, plan.buildings ?? plan.building,
      road ? { width: plan.inputs.width!, length: road.length } : undefined, plan.inputs.campYard === true, standard);
    h.xray = this.input("xray").checked;
    h.show = this.visible(plan);
    return h;
  }
  private restoreDrawing(plan: TemporaryWorksPlan) {
    const handle = this.draw(plan);
    this.handles.set(plan.id, handle);
    handle.ready.catch(error => {
      if (this.handles.get(plan.id) !== handle) return;
      this.handles.delete(plan.id);
      handle.destroy();
      this.failure(error);
    });
  }
  private stopPick() {
    this.cadPick?.abort(); this.cadPick = undefined;
    this.el("cad-preview").removeAttribute("data-picking");
    if (this.pickHandler && !this.pickHandler.isDestroyed()) this.pickHandler.destroy();
    this.pickHandler = undefined;
    this.finishPicking?.(); this.finishPicking = undefined;
    this.options.viewer.canvas.classList.remove("tw-picking");
  }
  private cancel(announce = true) {
    this.el("cad-preview").querySelectorAll("[data-road-conflict-segment], [data-road-conflict-details]").forEach(item => item.remove());
    const working = this.analysis || this.pickHandler || this.cadPick || this.overlayJob;
    if (this.overlayJob) this.clearOverlay("已取消图纸预览。");
    this.analysis?.abort(); this.analysis = undefined;
    this.stopPick();
    if (announce && working) this.status("已取消。");
    this.buttons();
  }
  private dropPreview() {
    if (this.preview) {
      this.preview.handle.destroy();
      this.preview = undefined;
      this.el("metrics").replaceChildren();
    }
    this.buttons();
  }
  private clearReview() {
    this.inspecting = undefined;
    if (this.reviewUrl) URL.revokeObjectURL(this.reviewUrl);
    this.reviewUrl = undefined;
    this.el("metrics").replaceChildren();
  }
  private group(name: string, visible: boolean) {
    this.options.root.querySelectorAll<HTMLElement>(`[data-tw-group="${name}"]`).forEach(el => { el.hidden = !visible; });
  }
  private updateFields() {
    const mode = this.value("coord");
    this.group("projection", mode === "gaussKruger"); this.group("local", mode === "local");
    const zone = this.value("projection-source") === "zone", projected = mode === "gaussKruger";
    this.group("zone", projected && (zone || this.input("prefix").checked));
    this.group("meridian", projected && !zone);
    this.group("bandwidth", projected && zone);
    this.projectionReadout();
    this.group("linear", mode !== "geographic");
    const isRoad = this.kind() === "road";
    this.input("name").placeholder = `如 1 号${KIND_NAMES[this.kind()]}`;
    this.el("finished-label").textContent = isRoad ? "校准桩号处路面顶相对标高（m）" : "基准点处硬化顶面相对标高（m）";
    this.el("plan-file-label").textContent = isRoad ? "道路中心线 CAD" : "场地平面规划 CAD";
    this.el("section-title").textContent = isRoad ? "便道断面与分段纵坡" : "典型断面与开挖底面";
    this.el("hardening-label").textContent = isRoad ? "硬化层厚度（m）" : "硬化面至地基处理顶面（m）";
    this.el("treatment-label").textContent = isRoad ? "地基处理深度（m）" : "处理顶面以下另挖深度（m）";
    this.group("road", isRoad); this.group("site", !isRoad);
    const glb = this.isGlb();
    this.group("glb", glb);
    this.el("datum-section").hidden = glb || isRoad;
    this.el("design-section").hidden = glb;
    this.options.root.querySelector<HTMLElement>(".tw-workbench")!.dataset.glb = String(glb);
    this.el("section-title").textContent = isRoad ? "贴地便道结构与施工里程分段" : "历史方案参数";
    this.el("hardening-label").textContent = "硬化层厚度（m）";
    this.el("treatment-label").textContent = "地基处理厚度（m）";

    this.input("glb-cancel-edit").hidden = !this.glbEditing;
    this.input("glb-clipping").disabled = this.resourceId() === "wall";
    this.input("glb-use-boundary").disabled = this.resourceId() === "wall" || !!this.analysis;
    this.input("glb-flip").disabled = this.resourceId() === "wall" || this.value("glb-placement-mode") !== "cad-auto";
    this.select("glb-placement-mode").disabled = this.resourceId() === "wall";
    if (this.resourceId() === "wall") this.input("glb-clipping").checked = false;
    const facilityMode = this.facilityMode();
    this.group("building", !isRoad && facilityMode === "cad");
    this.group("building-height", !isRoad && facilityMode === "cad");
    this.group("camp-yard", this.kind() === "camp" && facilityMode === "standard");
    this.el("place-facility").textContent = facilityMode === "pad" ? "在摄影场景中生成场坪" : "在摄影场景中生成模型";
    if (!isRoad) {
      const buildingHint = this.kind() === "camp" ? "办公楼、宿舍和门卫室" : "加工厂房、围栏和大门";
      this.el("facility-hint").textContent = facilityMode === "glb" ? "项目部和钢筋棚默认按所选 CAD 闭合轮廓自动确定位置、朝向和长宽，并读取摄影表面高程；也可切换手动精确布置。独立宣传墙采用手动位置。" : facilityMode === "standard" ? `选择${KIND_NAMES[this.kind()]}的场地边界，系统沿场界方向布置${buildingHint}。填写坐标和标高后可在主场景查看。`
        : facilityMode === "cad" ? "选择场地边界，再勾选图纸上的房屋或厂房轮廓并填写建筑高度。"
        : "按所选场地边界和标高生成硬化面，用于单独复核场坪及土方。";
    }
    this.group("sec-cad", this.sections.length > 0);
    const geographic = this.value("ref-mode") === "geo";
    this.el("ref-first-label").textContent = geographic ? "基准点经度（°）" : "基准点 CAD X";
    this.el("ref-second-label").textContent = geographic ? "基准点纬度（°）" : "基准点 CAD Y";
    this.buttons();
  }

  private edited(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || ["file", "checkbox"].includes(input.type)) return;
    if (!input.id.startsWith("tw-") && !input.dataset.gradeField) return;
    this.cancel(false); this.dropPreview(); this.clearReview();
    const k = input.id.slice(3);
    if (["glb-length","glb-width","glb-height"].includes(k) && this.value("glb-scale-mode") === "uniform") this.scaleGlbDimensions(k.slice(4) as "length"|"width"|"height");
    if (["glb-lon","glb-lat","glb-elevation","glb-heading","glb-length","glb-width","glb-height"].includes(k)) this.useManualGlbPlacement();
    if (["width", "anchor-x", "anchor-y", "anchor-lon", "anchor-lat", "rotation", "meridian", "zone", "b-x", "b-y", "b-lon", "b-lat"].includes(k))
      this.clearOverlay();
    if (k.startsWith("gk-") || k === "zone" || k === "meridian") { this.resetProjected(); this.clearOverlay(); }
    if (k.startsWith("anchor-") || k.startsWith("b-") || k === "rotation") this.resetRegistration();
    if (["anchor-x","anchor-y"].includes(k)) delete this.input("anchor-x").dataset.autoControl;
    if (["b-x","b-y"].includes(k)) delete this.input("b-x").dataset.autoControl;
    if (["gk-x","gk-y"].includes(k)) delete this.input("gk-x").dataset.autoControl;
    if (["meridian","zone"].includes(k)) this.projectionReadout();
    if (k === "thickness") { this.thicknessSource = undefined; this.updateSectionLabel(); }
    if (k !== "name") this.input("confirmed").checked = false;
    if (input.dataset.gradeField) this.gradeStatus();
    if (["width", "thickness", "treatment", "slope-height", "slope-width"].includes(k)) this.crossSection();
  }
  private changed(event: Event) {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !el.id.startsWith("tw-")) return;
    const k = el.id.slice(3);
    if (el instanceof HTMLInputElement && el.type !== "file" && el.type !== "checkbox") return;
    if (k === "upgrade-enabled") {
      this.upgradeEnabled = this.input("upgrade-enabled").checked;
      let preferenceSaved = true;
      try { if (this.projectId) localStorage.setItem(`cesium-temporary-works-upgrade:${this.projectId}`, this.upgradeEnabled ? "on" : "off"); }
      catch { preferenceSaved = false; }
      this.cancel(false); this.dropPreview();
      for (const [id, handle] of this.handles) { const plan = this.records.get(id); if (plan && this.newPlan(plan)) handle.show = this.visible(plan); }
      this.buttons(); this.list();
      this.status((this.upgradeEnabled ? "真实模型、摄影遮挡和贴地便道已启用。" : "新增功能已暂停显示，对应摄影遮挡已撤销。") + (preferenceSaved ? "" : "浏览器未能保存开关状态，刷新前请检查存储权限。"), !preferenceSaved);
      return;
    }
    if (k === "glb-logo") { void this.readGlbLogo(); return; }
    if (k === "glb-resource") {
      this.glbLogoReadToken++;
      this.select("kind").value = this.resourceId() === "steel" ? "steel" : "camp";
      this.select("facility-mode").value = "glb";
      this.updateGlbResource();
      this.input("glb-brand-visible").checked = this.resourceId() === "wall";
      this.input("glb-clipping").checked = this.resourceId() !== "wall";
      this.select("glb-placement-mode").value = this.resourceId() === "wall" ? "manual" : "cad-auto";
      this.glbAutoFit = undefined;
    }
    if (k === "glb-scale-mode") { if (this.value(k) === "uniform") this.scaleGlbDimensions(); this.useManualGlbPlacement(); }
    if (k === "glb-placement-mode" || k === "glb-flip") {
      this.glbAutoFit = undefined;
      this.el("glb-fit-status").textContent = this.value("glb-placement-mode") === "manual" ? "手动模式：保留当前坐标、旋转及尺寸，生成时不会自动覆盖。" : "生成时将按所选闭合轮廓重新适配，并读取摄影表面高程。";
    }
    if (k === "xray") {
      if (this.preview) this.preview.handle.xray = this.input("xray").checked;
      for (const h of this.handles.values()) h.xray = this.input("xray").checked;
      return;
    }
    const chooseSiteBoundary = k === "kind" && this.kind() !== "road" && !!this.cadFile;
    if (k === "kind") {
      this.input("finished").value = "";
      this.select("facility-mode").value = "glb";
      if (this.kind() !== "road") { this.select("glb-resource").value = this.kind(); this.updateGlbResource(); this.input("glb-brand-visible").checked = false; }
      if (chooseSiteBoundary) {
        this.select("layer").value = "";
        this.input("ref-x").value = ""; this.input("ref-y").value = "";
      }
    }
    if ((k === "facility-mode" || k === "kind") && this.facilityMode() !== "cad")
      this.select("building").selectedIndex = -1;
    if (k === "building" && [...this.select("building").selectedOptions].some(o => o.value))
      this.select("facility-mode").value = "cad";
    this.cancel(false); this.dropPreview(); this.clearReview();
    if (k !== "confirmed") this.input("confirmed").checked = false;
    if (["cad","kind","layer","model","building","facility-mode","feature","coord","unit","axis","prefix","band-width","projection-source"].includes(k)) this.clearOverlay();
    if (["coord","unit","axis"].includes(k)) this.resetRegistration();
    if (["coord","unit","axis","cad","model","projection-source","band-width","prefix"].includes(k)) this.resetProjected();
    if (k === "cad") { void this.readPlan(); return; }
    if (k === "section") { void this.readSection(); return; }
    if (k === "model") {
      this.selectedModel = this.value("model");
      this.input("gk-lon").value = ""; this.input("gk-lat").value = "";
    }
    if (k === "kind" && this.kind() === "road" && (this.sectionFile || this.sectionRead || this.input("section").files?.length)) {
      this.input("section").value = ""; void this.readSection();
    }
    if (k === "kind" || k === "layer") {
      this.rebuildFeatures();
      if (chooseSiteBoundary) this.select("feature").value = "";
    }
    if (["feature", "layer", "kind", "coord", "axis", "unit"].includes(k)) {
      this.featurePreview();
      this.updateSectionLabel();
      this.input("confirmed").checked = false;
    }
    if (["sec-profile", "sec-unit"].includes(k)) {
      this.input("confirmed").checked = false;
      this.sectionPreview();
    }
    if (k === "ref-mode") { this.input("ref-x").value = ""; this.input("ref-y").value = ""; }
    this.updateFields(); this.crossSection();
    if (chooseSiteBoundary) this.status(`请为${KIND_NAMES[this.kind()]}重新选择场地边界，并核对基准点。`);
    if (this.kind() !== "road" && (k === "layer" || k === "feature") && this.feature()) {
      const boundary = this.feature()!;
      this.status(`${KIND_NAMES[this.kind()]}场界：${boundary.layer || "未命名图层"} · ${boundary.id}。请核对场坪定位及标高。`);
    }
  }

  private click(event: Event) {
    const b = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!b || b.disabled) return;
    const action = b.dataset.twAction;
    if (action) {
      const id = b.closest<HTMLElement>("[data-plan-id]")?.dataset.planId;
      if (!id) return;
      const record = this.records.get(id);
      if (!record) return;
      if (action === "standardize") void this.addStandardFacility(id).catch(e => this.failure(e));
      if (action === "inspect") this.inspectPlan(id);
      if (action === "edit") this.editGlbPlan(id);
      if (action === "locate") this.locatePlan(id);
      if (action === "hide") {
        const visible = !(this.overrides.get(id) ?? record.visible);
        void this.changePlanVisibility(id, visible).catch(error=>this.failure(error));
      }
      if (action === "delete") {
        const remove = this.options.onRequestRemove;
        void (remove ? remove(id) : this.removePlan(id)).catch(error => this.failure(error));
      }
      return;
    }
    try {
      if (b.hasAttribute("data-remove-grade")) {
        b.closest("[data-grade-row]")?.remove(); this.gradeEdited(); return;
      }
      switch (b.id.slice(3)) {
        case "glb-pick": this.pick("glb"); break;
        case "glb-use-boundary": void this.useGlbBoundary(); break;
        case "glb-sample-height": void this.sampleGlbHeight(); break;
        case "glb-reset-size": this.updateGlbResource(); this.useManualGlbPlacement(); this.cancel(false); this.dropPreview(); break;
        case "glb-clear-logo": this.cancel(false); this.glbLogoReadToken++; this.glbLogo = undefined; this.input("glb-logo").value = ""; this.dropPreview(); break;
        case "glb-cancel-edit": this.cancel(false); this.glbEditing = undefined; this.dropPreview(); this.updateFields(); break;
        case "close": this.close(); this.options.onRequestClose?.(); break;
        case "pick": this.pick(); break;
        case "pick-a": this.pick("A"); break;
        case "pick-b": this.pick("B"); break;
        case "cad-a": this.pickDrawingControl("A"); break;
        case "cad-b": this.pickDrawingControl("B"); break;
        case "control-fit": this.fitControls(); break;
        case "gk-cad": this.pickDrawingControl("复核点"); break;
        case "gk-pick": this.pick("projected"); break;
        case "gk-check": this.checkProjected(); break;
        case "gk-apply": this.applyProjected(); break;
        case "gk-reset":
          this.cancel(false); this.resetProjected(); this.clearOverlay(); this.dropPreview(); this.clearReview();
          this.input("confirmed").checked = false; this.projectionReadout(); break;
        case "draft-drawing":
          if (this.overlay) this.overlay.zoom();
          else void this.previewPlacement();
          break;
        case "place-preview": void this.previewPlacement(); break;
        case "place-hide": this.clearOverlay("图纸预览已隐藏。"); this.buttons(); break;
        case "place-zoom": this.overlay?.zoom(); break;
        case "preview-camp":
        case "preview-steel": {
          const kind = b.id === "tw-preview-camp" ? "camp" : "steel";
          const generation = this.generation;
          void import("./temporaryWorksReference").then(module => {
            if (this.active && this.generation === generation) module.openFacilityReference(kind);
          }).catch(e => { if (this.active && this.generation === generation) this.failure(e); });
          break;
        }
        case "cancel": this.cancel(); break;
        case "draft-visibility":
          if (this.preview) {
            const visible = !this.preview.handle.show;
            this.preview.handle.show = visible;
            this.preview.record.visible = visible;
            this.buttons();
          }
          break;
        case "discard-draft":
          this.dropPreview();
          this.status("已移除模型预览，可以调整参数后重新计算。");
          break;
        case "replace-cad": this.input("cad").click(); break;
        case "replace-section": this.input("section").click(); break;
        case "remove-cad": this.removeFile("cad"); break;
        case "remove-section": this.removeFile("section"); break;
        case "add-grade": this.addGrade(); break;
        case "reverse": this.reverseRoute(); break;
        case "measure-depth": this.applyThickness(); break;
        case "place-facility": {
          if (this.isGlb()) { void this.run(); break; }
          if (!this.value("model")) throw new Error("请先加载并选择要布置设施的倾斜摄影模型。");
          if (!this.cadFile || !this.feature()?.closed) throw new Error("请导入场地平面图，选择一个闭合场界，再填写场坪坐标与标高。");
          if (!this.input("confirmed").checked) {
            this.input("confirmed").closest("details")?.setAttribute("open","");
            this.input("confirmed").focus();
            throw new Error("请先填写场坪高程基准与断面参数，勾选“已核对设计标高、断面参数与坡度”后计算。");
          }
          void this.run(); break;
        }
        case "run": void this.run(); break;
        case "save": void this.save(); break;
      }
    } catch (error) { this.failure(error); }
  }

  private removeFile(key: "cad" | "section") {
    this.cancel(false); this.dropPreview(); this.clearReview();
    this.input(key).value = "";
    if (key === "cad") {
      void this.readPlan();
      this.status("已移除草稿平面图及对应范围，可重新选择图纸。");
    } else {
      void this.readSection();
      this.status("已移除草稿断面图及其取值，可重新选择或手工输入。");
    }
  }

  private async readPlan() {
    this.clearOverlay(); this.resetProjected();
    if (this.cadFile || this.cadRead) {
      for (const key of ["gk-lon","gk-lat","gk-x","gk-y"]) this.input(key).value = "";
    }
    if ((this.cadFile || this.cadRead) && this.value("ref-mode") === "cad") {
      this.input("ref-x").value = "";
      this.input("ref-y").value = "";
    }
    this.cadRead?.abort(); this.cadRead = undefined;
    const file = this.input("cad").files?.[0];
    this.cadFile = undefined; this.cad = []; this.lastCadInfo = "";
    this.rebuildLayers(); this.updateFields();
    this.input("confirmed").checked = false;
    if (!file) return;
    const task = new AbortController();
    this.cadRead = task; this.buttons();
    try {
      this.status(`正在读取平面图「${file.name}」…`);
      const parsed = await readPlanningCad(file, task.signal);
      if (task.signal.aborted) return;
      this.cad = parsed.features; this.cadFile = file;
      this.lastCadInfo = [`${file.name} · ${parsed.features.length} 个线形`, ...parsed.warnings.slice(0, 3)].join("　");
      this.rebuildLayers(); this.updateFields();
      const choices = this.select("feature").options.length - 1;
      if (!choices) this.status("未找到与当前设施类型匹配的线形，请检查图层或设施类型。");
      else if (this.feature()) this.status("请核对所选图层、图元和坐标定位方式。");
      else this.status(`有 ${choices} 个可用图元，请按图层选择规划范围或组合中心线。`);
    } catch (error) { if (!task.signal.aborted) this.failure(error); }
    finally { if (this.cadRead === task) this.cadRead = undefined; this.buttons(); }
  }
  private eligible(f: PlanningCadFeature) {
    return this.kind() === "road" ? !f.closed && f.points.length >= 2 : f.closed && f.points.length >= 3;
  }
  private rebuildLayers() {
    const layer = this.select("layer");
    const names = [...new Set(this.cad.map(f => f.layer))];
    layer.replaceChildren(new Option("全部图层", ""), ...names.map(n => new Option(n || "未命名图层", n)));
    this.rebuildFeatures(); this.featurePreview();
  }
  private rebuildFeatures() {
    const s = this.select("feature");
    const old = s.value;
    const filtered = this.cad.filter(f => this.eligible(f) && (!this.value("layer") || f.layer === this.value("layer")));
    this.fillFeatures(s, filtered, this.kind() === "road" ? "选择一条未闭合道路中心线" : "选择场地闭合边界");
    if (filtered.some(f => f.id === old)) s.value = old;
    else if (filtered.length === 1) s.value = filtered[0].id;
    const buildings = this.select("building");
    const prior = new Set([...buildings.selectedOptions].map(o => o.value));
    this.fillFeatures(buildings, this.cad.filter(f => f.closed && f.points.length >= 3), "选择建筑轮廓");
    for (const option of buildings.options) option.selected = prior.has(option.value);
  }
  private fillFeatures(select: HTMLSelectElement, features: PlanningCadFeature[], first: string) {
    const fragment = document.createDocumentFragment();
    fragment.append(new Option(first, ""));
    features.forEach((f, n) => fragment.append(new Option(featureLabel(f, n), f.id)));
    select.replaceChildren(fragment);
  }
  private featurePreview() {
    const feature = this.feature();
    const road = this.kind() === "road" && feature && !feature.closed ? feature : undefined;
    const lastLength = this.measuredLength, changed = road !== this.roadFeature;
    if (changed && this.roadFeature) this.input("finished").value = "";
    this.roadFeature = road;
    if (changed) this.reversed = false;
    let length = 0, issue = "";
    if (road) {
      try {
        const mode = this.value("coord");
        if (mode === "geographic") {
          const frame = createRoadCoordinateFrame(this.coordinates(), road.points[0]);
          length = roadLength(road.points.map(frame.cadToLocal));
        } else {
          const unit = this.value("unit") as Unit;
          const factor = { m: 1, cm: .01, mm: .001 }[unit];
          length = roadLength(road.points.map(p => ({ x: (p.x - road.points[0].x) * factor, y: (p.y - road.points[0].y) * factor })), road.stationFactors);
        }
      } catch (error) { issue = error instanceof Error ? error.message : String(error); }
    }
    this.measuredLength = length;
    drawFeature(this.el("cad-preview"), feature, !!road, this.reversed);
    this.el("cad-info").textContent = this.lastCadInfo;
    this.el("road-length").textContent = length ? `中心线平面长度 ${valueText(length)} m` : issue || "选择道路中心线后显示长度";
    const first = road?.points[0], last = road?.points.at(-1);
    for (const [key, suggested] of [["anchor", feature?.points[0]], ["b", feature?.points.at(-1)], ["gk",feature?.points[0]]] as const) {
      const x = this.input(key+"-x"), y = this.input(key+"-y");
      if (this.value(key+"-lon") || this.value(key+"-lat")) continue;
      if (!x.dataset.autoControl && (x.value || y.value)) continue;
      x.value = suggested ? String(suggested.x) : ""; y.value = suggested ? String(suggested.y) : "";
      x.dataset.autoControl = "true";
    }
    const start = this.reversed ? last : first, end = this.reversed ? first : last;
    const xy = (p: {x:number;y:number}) => `CAD X=${p.x}，Y=${p.y}`;
    const source = road?.id.startsWith("chain-") ? "所选组合线路" : "CAD";
    this.el("road-start").textContent = start ? `起点 ${stationLabel(0)}　${source} ${this.reversed ? "末点" : "首点"} · ${xy(start)}` : "";
    this.el("road-end").textContent = end ? `终点 ${length ? stationLabel(length) : ""}　${source} ${this.reversed ? "首点" : "末点"} · ${xy(end)}` : "";
    this.input("reverse").disabled = !length;
    this.input("add-grade").disabled = !length;
    const rows = this.gradeRows();
    if (changed || !length || !lastLength) this.setGrades(length ? [{start:0,end:length,gradePct:0}] : []);
    else if (length !== lastLength && rows.length === 1 && Number(rows[0].querySelector<HTMLInputElement>('[data-grade-field="start"]')?.value) === 0) {
      const endInput = rows[0].querySelector<HTMLInputElement>('[data-grade-field="end"]')!;
      if (Math.abs(Number(endInput.value) - lastLength) <= .001) endInput.value = compactNumber(length);
    }
    this.gradeStatus(); this.crossSection(); this.projectionReadout();
  }
  private gradeRows() { return Array.from(this.el("grades").querySelectorAll<HTMLElement>("[data-grade-row]")); }
  private getGrades() {
    const rows = this.gradeRows().map(row => {
      const get = (k: keyof RoadGradeRange) => {
        const v = row.querySelector<HTMLInputElement>(`[data-grade-field="${k}"]`)!.value;
        return v.trim() ? Number(v) : NaN;
      };
      // New roads follow sampled photography. Hidden legacy grades must not
      // reject a construction segment or influence its restored chainage.
      return { start: get("start"), end: get("end"), gradePct: 0 };
    });
    return validateRoadGrades(rows, this.measuredLength);
  }
  private appendGrade(grade: RoadGradeRange) {
    const row = element("div"); row.className = "tw-grade-grid"; row.setAttribute("data-grade-row", "");
    const names = { start: "起里程（m）", end: "止里程（m）", gradePct: "纵坡（%）" };
    for (const key of ["start", "end", "gradePct"] as const) {
      const field = element("input"); field.dataset.gradeField = key; field.type = "number"; field.step = "any";
      if (key !== "gradePct") field.min = "0";
      field.value = key === "gradePct" ? String(grade[key]) : compactNumber(grade[key]);
      field.setAttribute("aria-label", names[key]);
      row.append(field);
    }
    const del = element("button", "×"); del.type = "button"; del.setAttribute("data-remove-grade", ""); del.setAttribute("aria-label", "删除该坡段");
    row.append(del); this.el("grades").append(row);
  }
  private setGrades(grades: RoadGradeRange[]) {
    this.el("grades").replaceChildren();
    for (const grade of grades) this.appendGrade(grade);
  }
  private gradeStatus() {
    const info = this.el("grade-status"); info.removeAttribute("data-error");
    if (!this.measuredLength) { info.textContent = "请先选取 CAD 中心线。"; return; }
    try {
      const grades = this.getGrades();
      info.textContent = `${grades.length} 个施工里程段覆盖全长；高程将逐点跟随摄影表面。`;
    } catch (error) {
      info.textContent = error instanceof Error ? error.message : String(error); info.toggleAttribute("data-error", true);
    }
  }
  private gradeEdited() {
    this.cancel(false); this.dropPreview(); this.clearReview();
    this.input("confirmed").checked = false; this.gradeStatus();
  }
  private addGrade() {
    const rows = this.gradeRows(), last = rows.at(-1), length = this.measuredLength;
    if (!length) return;
    if (!last) this.appendGrade({start:0,end:length,gradePct:0});
    else {
      const first = last.querySelector<HTMLInputElement>('[data-grade-field="start"]')!, end = last.querySelector<HTMLInputElement>('[data-grade-field="end"]')!;
      const slope = last.querySelector<HTMLInputElement>('[data-grade-field="gradePct"]')!;
      if (!end.value || !first.value || Number(end.value) <= Number(first.value)) throw new Error("请先填写末段的起、止里程。");
      const stop = Number(end.value);
      if (stop > length + .001) throw new Error("末段结束里程超出路线长度，请先修正。");
      let start = stop;
      if (Math.abs(stop - length) <= .001) {
        start = (Number(first.value) + length) / 2; end.value = compactNumber(start);
      }
      this.appendGrade({start,end:length,gradePct:Number(slope.value) || 0});
    }
    this.gradeEdited();
  }
  private reverseRoute() {
    const length = this.measuredLength;
    if (!this.roadFeature || !length) return;
    const grades = this.getGrades();
    this.clearOverlay();
    this.reversed = !this.reversed;
    this.setGrades(grades.reverse().map(g => ({start:length - g.end, end:length - g.start, gradePct:-g.gradePct})));
    this.input("finished").value = "";
    this.featurePreview(); this.gradeEdited();
    this.status("已交换起终点和里程分段。便道高程仍逐点贴合摄影表面。");
  }
  private crossSection() {
    const values = ["width", "thickness", "treatment"].map(k => this.value(k) === "" ? NaN : Number(this.value(k)));
    const [width, hard, treatment] = values;
    renderRoadSectionPreview(this.el("road-section-preview"), {
      width, hardeningDepth: hard, treatmentDepth: treatment, slopeHeight: 1, slopeWidth: 0, surfaceMode: "draped",
    });
  }

  private async readSection() {
    this.sectionRead?.abort(); this.sectionRead = undefined;
    if (this.thicknessSource) this.input("thickness").value = "";
    this.thicknessSource = undefined; this.sections = []; this.sectionFile = undefined;
    this.input("confirmed").checked = false;
    if (this.sectionUrl) URL.revokeObjectURL(this.sectionUrl);
    this.sectionUrl = undefined; this.select("sec-profile").replaceChildren(); this.sectionPreview(); this.updateFields();
    const file = this.input("section").files?.[0];
    if (!file) return;
    const ext = fileExtension(file.name);
    if (["pdf", "jpeg", "jpg", "png", "webp"].includes(ext)) {
      if (file.size > 32 * 1024 * 1024) { this.failure(new Error("典型断面附件超过 32 MB，请裁取本次采用的断面页。")); return; }
      const mime = ext === "pdf" ? "application/pdf" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      this.sectionFile = file; this.sectionUrl = URL.createObjectURL(file.slice(0, file.size, mime));
      showAttachment(this.el("section-preview"), file, this.sectionUrl);
      this.updateSectionLabel(); this.status("请对照断面原图录入并核对厚度与设计坡度。");
      return;
    }
    if (!["dxf", "dwg", "cadimport"].includes(ext)) { this.failure(new Error("典型断面支持 DXF、DWG、PDF、PNG、JPEG 或 WebP。")); return; }
    const task = new AbortController();
    this.sectionRead = task; this.buttons();
    try {
      this.status(`正在读取典型断面「${file.name}」…`);
      const parsed = await readPlanningCad(file, task.signal);
      if (task.signal.aborted) return;
      const features = parsed.features.filter(f => f.points.length > 1);
      this.sections = features; this.sectionFile = file;
      const sel = this.select("sec-profile"); this.fillFeatures(sel, features, "选择竖向尺寸线");
      if (features.length === 1) sel.value = features[0].id;
      this.sectionPreview(); this.updateFields();
      this.status(features.length ? "可从竖线读取硬化层厚度，或对照图纸手工录入。" : "未找到可用断面线，请对照原图手工录入参数。");
    } catch (error) { if (!task.signal.aborted) this.failure(error); }
    finally { if (this.sectionRead === task) this.sectionRead = undefined; this.buttons(); }
  }
  private sectionPreview() {
    const f = this.sections.find(v => v.id === this.value("sec-profile"));
    drawFeature(this.el("section-preview"), f); this.updateSectionLabel();
  }
  private updateSectionLabel() {
    const parts = [];
    if (this.sectionFile) parts.push(this.sectionFile.name);
    if (this.thicknessSource) parts.push(`厚度取自 ${this.thicknessSource}`);
    this.el("section-summary").textContent = parts.join(" · ");
  }
  private applyThickness() {
    const feature = this.sections.find(f => f.id === this.value("sec-profile"));
    if (!feature) throw new Error("请先在典型断面中选取对应图线。");
    const unit = this.value("sec-unit") as Unit;
    const p = feature.points;
    const scale = { m: 1, cm: .01, mm: .001 }[unit];
    const top = p.reduce((a, b) => b.y > a.y ? b : a);
    const bottom = p.reduce((a, b) => b.y < a.y ? b : a);
    const dy = top.y - bottom.y;
    if (feature.closed || dy <= 0 || !p.every(v => Math.abs(v.x - top.x) <= Math.max(dy * 0.001, 1e-8)))
      throw new Error("请选取端点分别位于硬化面和处理顶面的竖向线，或手工输入垂直距离。");
    this.input("thickness").value = String(Number((dy * scale).toPrecision(12)));
    this.thicknessSource = `${feature.layer}/${feature.id}（${unit}）`;

    this.cancel(false); this.dropPreview(); this.clearReview(); this.input("confirmed").checked = false;
    this.updateSectionLabel(); this.status("已将选定图线尺寸写入设计参数，请核对后勾选确认。");
  }

  private pick(target: "A" | "B" | "projected" | "reference" | "glb" = "reference") {
    const model = this.model();
    this.cancel(false); this.dropPreview(); this.clearReview();
    this.clearOverlay();
    const done = this.options.beginInteractionSession?.();
    if (typeof done === "function") this.finishPicking = done;
    try {
      this.pickHandler = new ScreenSpaceEventHandler(this.options.viewer.canvas);
      this.options.viewer.canvas.classList.add("tw-picking");
      this.pickHandler.setInputAction((event: { position: Cartesian2 }) => {
        try {
          if (model.tileset !== this.model().tileset) { this.cancel(); return; }
          const p = pickPlanningReference(this.options.viewer, model.tileset, event.position);
          if (!p) { this.status("此处没有拾取到所选倾斜摄影表面，请在模型上重新点选。"); return; }
          if (target === "glb") {
            this.useManualGlbPlacement();
            this.input("glb-lon").value = String(p.longitude); this.input("glb-lat").value = String(p.latitude);
            this.stopPick(); void this.sampleGlbHeight(); return;
          }
          if (target !== "reference") {
            const key = target === "projected" ? "gk" : target === "A" ? "anchor" : "b";
            this.input(key+"-lon").value = String(p.longitude); this.input(key+"-lat").value = String(p.latitude);
            this.input("confirmed").checked = false;
            if (target === "projected") this.resetProjected(); else this.resetRegistration();
            this.stopPick(); this.updateFields();
            this.status(`已拾取摄影模型上的${target==="projected"?"复核点":"控制点 "+target}，请核对对应的 CAD 坐标。`);
            return;
          }
          this.select("ref-mode").value = "geo";
          this.input("ref-x").value = String(p.longitude); this.input("ref-y").value = String(p.latitude);
          this.stopPick(); this.updateFields();
          this.status("已拾取基准位置，计算时将复采该位置的倾斜摄影高程作为相对零点。");
        } catch (error) { this.cancel(false); this.failure(error); }
      }, ScreenSpaceEventType.LEFT_CLICK);
      this.status(`请在所选倾斜摄影模型上单击${target === "reference" ? "场地高程基准点" : target==="projected" ? "与 CAD 对应的复核点" : "与 CAD 对应的控制点 "+target}，按 Esc 取消。`); this.buttons();
    } catch (error) { this.stopPick(); this.buttons(); throw error; }
  }
  private resetRegistration() {
    this.registration = undefined;
    const note = this.el("control-status");
    note.textContent = "校准参数已更改。使用两点定位时，请重新应用校准。";
    note.removeAttribute("data-warning");
  }

  private fitControls() {
    const input = (k: string) => this.num(k, this.input(k).labels?.[0]?.textContent || k);
    const first = {cad:{x:input("anchor-x"),y:input("anchor-y")},geo:{longitude:input("anchor-lon"),latitude:input("anchor-lat")}};
    const second = {cad:{x:input("b-x"),y:input("b-y")},geo:{longitude:input("b-lon"),latitude:input("b-lat")}};
    const fit = fitPlanningControls(first, second, this.value("unit") as Unit, this.value("axis") as PlanningCadCoordinates["axisOrder"]);
    this.cancel(false); this.clearOverlay(); this.dropPreview(); this.clearReview();
    this.input("rotation").value = String(fit.rotation);
    this.input("confirmed").checked = false;
    this.registration = {...fit, second};
    const large = fit.residual > Math.max(.25, fit.drawingDistance*.002);
    const note = this.el("control-status");
    note.toggleAttribute("data-warning", large);
    note.textContent = `逆时针旋转 ${valueText(fit.rotation)}°。图纸基线 ${valueText(fit.drawingDistance)} m，模型基线 ${valueText(fit.modelDistance)} m，B 点平面偏差 ${valueText(fit.residual)} m。${large ? "两条基线长度有差异，请核对同名点、轴序与单位。" : "可预览叠图核对位置。"}`;
    this.status(note.textContent);
  }

  private pickDrawingControl(which: "A"|"B"|"复核点") {
    const feature = this.feature(), host = this.el("cad-preview"), svg = host.querySelector("svg");
    if (!feature || !svg) throw new Error("请先选择图纸中的线形或场地边界。");
    this.cancel(false); this.clearOverlay(); this.dropPreview(); this.clearReview();
    const task = this.cadPick = new AbortController();
    host.dataset.picking = which; host.scrollIntoView({block:"nearest"});
    this.status(`请在二维图上点击${which==="复核点" ? which : "控制点 "+which}附近的顶点，或按 Esc 取消。`); this.buttons();
    svg.addEventListener("click", event => {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const local = new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
      const scale = Number(svg.dataset.scale);
      const x = (local.x-200)/scale+Number(svg.dataset.centerX), y = (60-local.y)/scale+Number(svg.dataset.centerY);
      let nearest = feature.points[0], distance = Infinity;
      for (const p of feature.points) {
        const d = Math.hypot(p.x-x,p.y-y);
        if (d < distance) { distance = d; nearest = p; }
      }
      if (distance*scale > 12) { this.status("请点选图线上可辨认的顶点。"); return; }
      const key = which === "复核点" ? "gk" : which === "A" ? "anchor" : "b";
      delete this.input(key+"-x").dataset.autoControl;
      this.input(key+"-x").value = String(nearest.x); this.input(key+"-y").value = String(nearest.y);
      this.input("confirmed").checked = false;
      if (which === "复核点") this.resetProjected(); else this.resetRegistration();
      this.stopPick(); this.buttons();
      this.status(`已选${which==="复核点" ? which : "控制点 "+which}，CAD X=${nearest.x}，Y=${nearest.y}。请核对摄影模型上的同名点。`);
    }, {signal:task.signal});
  }

  private clearOverlay(message = "选择图元并填写坐标后，可预览完整便道中心线或场地轮廓。") {
    this.overlayJob?.abort(); this.overlayJob = undefined;
    this.overlay?.destroy(); this.overlay = undefined; this.overlaySource = undefined;
    const note = this.el("overlay-status");
    note.textContent = message; note.dataset.state = "idle";
    delete note.dataset.covered; delete note.dataset.samples;
    delete note.dataset.coveredAxisLines; delete note.dataset.missingAxisLines;
    this.input("place-hide").disabled = true; this.input("place-zoom").disabled = true;
  }

  private async previewPlacement() {
    this.cancel(false); this.clearOverlay();
    if (this.kind() !== "road") this.dropPreview();
    if (!this.preview) this.clearReview();
    const task = new AbortController();
    this.overlayJob = task;
    const note = this.el("overlay-status");
    try {
      const model = this.model().tileset, feature = this.feature();
      if (!feature) throw new Error("请先选择参与规划的 CAD 图元。");
      const matrix = Matrix4.clone(model.modelMatrix), rootMatrix = Matrix4.clone(model.root.transform);
      const valid = () => !model.isDestroyed() && model.show && this.options.getTilesets().some(m=>m.tileset===model) &&
        Matrix4.equals(model.modelMatrix,matrix) && Matrix4.equals(model.root.transform,rootMatrix);
      this.overlaySource = valid;
      const coordinates = this.coordinates(), kind = this.kind();
      const ids = new Set(Array.from(this.select("building").selectedOptions,o=>o.value));
      const input: PlanningCadPreviewInput = {coordinates, kind, feature, reversed:this.reversed,
        buildings:kind==="road"?[]:this.cad.filter(f=>f.closed && ids.has(f.id))};
      if (kind==="road" && this.value("width")) {
        const width = this.num("width","路面宽度");
        if (width<=0) throw new Error("路面宽度应大于零，或留空只核对中心线。");
        input.width=width;
      }
      note.dataset.state = "loading"; note.textContent = "正在选定摄影模型上读取图纸预览高程…";
      this.status(note.textContent); this.buttons();
      const handle = await renderPlanningCadPreview(this.options.viewer,model,input,task.signal);
      if (task.signal.aborted || !valid()) { handle.destroy(); throw new Error("模型或定位已改变，请重新预览。"); }
      this.overlay = handle;
      note.dataset.state = "ready"; note.dataset.covered = String(handle.coveredCount); note.dataset.samples = String(handle.sampleCount);
      const counts = `${handle.sampleCount} 个预览取样位置中有 ${handle.coveredCount} 个落在模型上。`;
      if (kind === "road") {
        note.dataset.coveredAxisLines = String(handle.coveredAxisLineCount);
        note.dataset.missingAxisLines = String(handle.missingAxisLineCount);
        const coverage = handle.coveredAxisLineCount
          ? handle.missingAxisLineCount ? "青色实线为有模型高程的中心线段，橙色虚线为超出覆盖或缺测的线段。" : "中心线各预览样段均有模型高程，以青色实线显示。"
          : "中心线未取得连续的模型高程，全线以橙色虚线显示。请核对投影、起终点和所选模型。";
        const missing = handle.missingAxisLineCount ? "虚线高度仅供平面定位，贴地便道只在有效实测网格内生成。" : "";
        note.textContent = `已显示完整 CAD 中心线。${coverage}${missing}${input.width ? "黄色横尺标示有效取样处的路宽。" : ""}${counts}`;
      } else {
        note.textContent = handle.lineCount
          ? `青色为场界，橙色为选定的建筑轮廓。${counts}`
          : "图纸在所选模型上没有连续的有效线段。可定位到图纸，再核对控制点、投影和模型覆盖。";
      }
      if (handle.lineCount) handle.zoom();
      this.status(note.textContent);
    } catch (error) {
      if (!task.signal.aborted) {
        this.clearOverlay();
        note.dataset.state = "error"; note.textContent = error instanceof Error ? error.message : String(error);
        this.failure(error);
      }
    } finally {
      if (this.overlayJob===task) this.overlayJob=undefined;
      this.buttons();
    }
  }

  private resetProjected() {
    this.projected = undefined;
    this.input("gk-apply").disabled = this.input("gk-reset").disabled = true;
    this.el("gk-status").textContent = "当前使用图纸原始投影位置。";
  }

  private checkProjected() {
    const crs = this.coordinates(), model = this.model().tileset;
    if (crs.mode !== "gaussKruger") throw new Error("请先选择国家 2000 高斯平面坐标。");
    const cad = {x:this.num("gk-x","复核点 CAD X"), y:this.num("gk-y","复核点 CAD Y")};
    const geo = {longitude:this.num("gk-lon","实景同名点经度"), latitude:this.num("gk-lat","实景同名点纬度")};
    const check = {...checkProjectedControl(crs,cad,geo),cad,geo};
    const matrix = Matrix4.clone(model.modelMatrix), root = Matrix4.clone(model.root.transform);
    const sourceValid = () => !model.isDestroyed() && model.show && this.options.getTilesets().some(m=>m.tileset===model)
      && Matrix4.equals(matrix,model.modelMatrix) && Matrix4.equals(root,model.root.transform);
    this.projected = {check, applied:this.projected?.applied ?? false, sourceValid};
    const note = this.el("gk-status");
    note.textContent = `从原始投影到模型同名点：东 ${valueText(check.east)} m，北 ${valueText(check.north)} m，平面差 ${valueText(check.distance)} m。`;
    this.input("gk-apply").disabled = this.projected.applied;
    this.status(note.textContent);
  }

  private applyProjected() {
    if (!this.projected || !this.projected.sourceValid()) throw new Error("请先对当前摄影模型复核同名点。");
    this.cancel(false); this.clearOverlay(); this.dropPreview(); this.clearReview();
    this.projected.applied = true;
    this.input("gk-reset").disabled = false; this.input("gk-apply").disabled = true;
    this.input("confirmed").checked = false;
    this.el("gk-status").textContent = `当前方案已平移：东 ${valueText(this.projected.check.east)} m，北 ${valueText(this.projected.check.north)} m。可预览或恢复原位置。`;
    this.projectionReadout();
  }

  private projectionReadout() {
    if (this.value("coord") !== "gaussKruger") return;
    const note = this.el("projection-readout"), feature = this.feature();
    note.textContent = "请按项目测量资料填写中央子午线，或选择分带方式和带号。";
    if (!feature) return;
    try {
      const crs = this.coordinates();
      if (crs.mode !== "gaussKruger") return;
      const road = this.kind() === "road", point = road && this.reversed ? feature.points.at(-1)! : feature.points[0];
      const frame = (road ? createRoadCoordinateFrame : createPlanCoordinateFrame)(crs,feature.points[0]);
      const where = frame.localToGeo(frame.cadToLocal(point));
      note.textContent = `中央子午线 ${valueText(crs.centralMeridian)}°，图纸 X 为${crs.axisOrder==="eastNorth"?"东":"北"}坐标。${road?"道路起点":"场界首点"}经度 ${where.longitude.toFixed(8)}°、纬度 ${where.latitude.toFixed(8)}°。`;
    } catch (error) {
      if (error instanceof Error) note.textContent = error.message;
    }
  }

  private coordinates(): PlanningCadCoordinates {
    const mode = this.value("coord");
    const axisOrder = this.value("axis") as "eastNorth" | "northEast";
    const unit = this.value("unit") as Unit;
    if (mode === "geographic") return { mode, axisOrder };
    if (mode === "gaussKruger") {
      const hasZonePrefix = this.input("prefix").checked;
      const byZone = this.value("projection-source") === "zone";
      const zoneNumber = byZone || hasZonePrefix ? this.num("zone","带号") : 0;
      const bandWidth = Number(this.value("band-width")) as 3 | 6;
      const centralMeridian = byZone ? cgcs2000ZoneMeridian(zoneNumber,bandWidth) : parseLongitude(this.value("meridian"));
      return { mode, axisOrder, unit, centralMeridian, hasZonePrefix, zoneNumber, ...(byZone ? {bandWidth} : {}),
        ...(this.projected?.applied ? {modelOffset:{east:this.projected.check.east,north:this.projected.check.north}} : {}) };
    }
    return { mode: "local", unit, axisOrder, referenceX: this.num("anchor-x", "已知点 CAD X"), referenceY: this.num("anchor-y", "已知点 CAD Y"),
      longitude: this.num("anchor-lon", "已知点经度"), latitude: this.num("anchor-lat", "已知点纬度"), rotation: this.num("rotation", "坐标旋转角") };
  }

  private async loadGlbResources() {
    try {
      this.manifest = await loadTemporaryWorksGlbManifest();
      if (!this.disposed) this.updateGlbResource(!this.glbEditing && !this.value("glb-length"));
    } catch (error) {
      if (!this.disposed) { this.el("glb-asset-info").textContent = "模型资源清单未加载，可重试生成时重新读取。"; this.failure(error); }
    }
  }
  private updateGlbResource(resetSize = true) {
    const resource = this.resource();
    if (!resource) return;
    const d = resource.dimensions;
    if (resetSize) {
      this.input("glb-length").value = String(d.length);
      this.input("glb-width").value = String(d.width);
      this.input("glb-height").value = String(d.height);
    }
    this.el("glb-asset-info").textContent = `${resource.name} · 核验尺寸 ${valueText(d.length)} × ${valueText(d.width)} × ${valueText(d.height)} m · ${resource.footprints.length} 个底面轮廓`;
  }
  private scaleGlbDimensions(dimension: "length"|"width"|"height" = "length") {
    const resource = this.resource(), target = Number(this.value("glb-" + dimension));
    if (!resource || !(target > 0)) return;
    const scale = target / resource.dimensions[dimension];
    for (const key of ["length","width","height"] as const)
      if (key !== dimension) this.input("glb-"+key).value = String(resource.dimensions[key] * scale);
  }
  private async readGlbLogo() {
    const logoToken = ++this.glbLogoReadToken;
    const file = this.input("glb-logo").files?.[0];
    this.cancel(false); this.dropPreview();
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 4 * 1024 * 1024) {
      this.failure(new Error("LOGO 请使用不超过 4 MB 的 PNG、JPEG 或 WebP 图片。")); return;
    }
    const token = this.generation;
    try {
      const data = await new Promise<string>((resolve,reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
      });
      if (token === this.generation && logoToken === this.glbLogoReadToken && !this.disposed) {
        // A preview may have started while FileReader was pending. It still contains the previous logo.
        this.cancel(false); this.dropPreview();
        this.glbLogo = data; this.input("glb-brand-visible").checked = true;
        this.status("LOGO 已读取，请重新生成预览后保存。");
      }
    } catch (error) { if (token === this.generation && logoToken === this.glbLogoReadToken) this.failure(error); }
  }
  private useManualGlbPlacement() {
    this.select("glb-placement-mode").value = "manual";
    this.glbAutoFit = undefined;
    this.input("glb-flip").disabled = true;
    this.el("glb-fit-status").textContent = "手动模式：保留当前坐标、旋转及尺寸，生成时不会自动覆盖。";
  }
  private describeGlbAutoFit(audit: NonNullable<TemporaryWorksGlbConfig["autoFit"]>) {
    const surface = audit.surface;
    const ground = surface.status === "sampled"
      ? `摄影取高 ${surface.validCount}/${surface.sampleCount} 点有效；表面高差 ${valueText(surface.maximum!-surface.minimum!)} m；采用最高有效高程 ${valueText(surface.maximum!)} m 防止采样点嵌入。摄影表面可能包含地物，水平底面在低处可能悬空，仍须现场核验。`
      : "未取得摄影高程，仅完成平面适配；须填写实测椭球高，尚未完成摄影落位验收。";
    return `${audit.featureLayer} / ${audit.featureId} · ${audit.message} · X/Y 缩放 ${valueText(audit.scale.x)} / ${valueText(audit.scale.y)}，原高度保留；底面覆盖所选轮廓 ${valueText(audit.coverageRatio*100)}%。${ground}`;
  }
  private async applyGlbBoundaryFit(job: AbortController, feature: PlanningCadFeature, coordinates: PlanningCadCoordinates) {
    const resource = this.resource();
    if (!resource || resource.id === "wall") throw new Error("请先选择项目部或钢筋棚资源。");
    if (!feature.closed || feature.points.length < 3) throw new Error("请先导入并选择驻地或钢筋厂的 CAD 闭合轮廓，核对图纸坐标；无图纸时请选择手动布置。");
    const frame = createPlanCoordinateFrame(coordinates, feature.points[0]);
    const flip180 = this.input("glb-flip").checked;
    const fit = fitTemporaryWorksGlbToBoundary(resource, feature.points.map(frame.cadToLocal), {flip180});
    const anchor = frame.localToGeo(fit.anchor);
    for (const [key,value] of Object.entries({lon:anchor.longitude,lat:anchor.latitude,heading:fit.headingDeg,length:fit.dimensions.length,width:fit.dimensions.width,height:fit.dimensions.height}))
      this.input("glb-"+key).value = String(value);
    this.select("glb-scale-mode").value = fit.scaleMode;
    const audit: NonNullable<TemporaryWorksGlbConfig["autoFit"]> = {
      featureId:feature.id,featureLayer:feature.layer,method:fit.method,flip180,scale:fit.scale,
      coverageRatio:fit.coverageRatio,targetArea:fit.targetArea,footprintArea:fit.footprintArea,message:fit.message,
      surface:{status:"unavailable",sampleCount:0,validCount:0},
    };
    this.glbAutoFit = audit;
    this.el("glb-fit-status").textContent = this.describeGlbAutoFit(audit);
    const model = this.options.getTilesets().find(item => item.id === this.value("model"));
    if (model) {
      // withPlanningSurface uses an isolated scene containing only the selected photography.
      // Saved models, the current preview, and clipping are not sampled as ground.
      const groups = fit.footprints.map(ring => glbGroundSamplePoints([ring]));
      const points = groups.flat().map(frame.localToGeo);
      if (points.length > 2048) throw new Error("建筑底面过于复杂，自动摄影取高采样量超限，请核对模型轮廓。");
      this.status(`正在按建筑底面读取 ${points.length} 个摄影表面高程…`);
      const heights = await this.readGlbSurface(model,points,job);
      job.signal.throwIfAborted();
      let offset = 0;
      for (const [index,group] of groups.entries()) {
        try { summarizeGlbGroundSamples(heights.slice(offset,offset+group.length)); }
        catch (error) { throw new Error(`第 ${index+1} 个建筑底面：${error instanceof Error ? error.message : String(error)}`); }
        offset += group.length;
      }
      const surface = summarizeGlbGroundSamples(heights);
      audit.surface = surface;
      this.input("glb-elevation").value = String(surface.maximum);
      this.el("glb-fit-status").textContent = this.describeGlbAutoFit(audit);
    }
    job.signal.throwIfAborted();
    return audit;
  }
  private async useGlbBoundary() {
    if (!this.upgradeEnabled || !this.editable() || this.busySave || this.cadRead || this.sectionRead) return;
    this.select("glb-placement-mode").value = "cad-auto";
    this.input("glb-flip").disabled = false;
    await this.runGlb();
  }
  private async sampleGlbHeight() {
    this.useManualGlbPlacement();
    this.cancel(false); this.dropPreview();
    const job = new AbortController(); this.analysis = job; this.buttons();
    try {
      const model = this.model(), point = {longitude:this.num("glb-lon","底面基准经度"),latitude:this.num("glb-lat","底面基准纬度")};
      this.status("正在读取底面基准位置的摄影高程…");
      const height = (await this.readGlbSurface(model,[point],job))[0];
      job.signal.throwIfAborted();
      if (height === null || !Number.isFinite(height)) throw new Error("底面基准点没有有效摄影高程，请重新选点或填写实测椭球高。");
      this.input("glb-elevation").value = String(height);
      this.status("已读取底面摄影高程。核对尺寸、旋转和底面位置后生成预览。");
    } catch (error) { if (!job.signal.aborted) this.failure(error); }
    finally { if (this.analysis === job) this.analysis = undefined; this.buttons(); }
  }
  private readGlbSurface(model: Model, points: PlanningLocation[], job: AbortController) {
    return withPlanningSurface(this.options.viewer,model.tileset,{signal:job.signal},sample => sample(points));
  }
  private editGlbPlan(id: string) {
    const plan = this.records.get(id);
    if (!plan?.glb || !this.editable()) return;
    this.cancel(false); this.dropPreview(); this.clearReview();
    this.glbEditing = id; this.glbLogoReadToken++;
    const glb = plan.glb, p = glb.placement;
    this.select("kind").value = glb.resourceId === "steel" ? "steel" : "camp";
    this.select("facility-mode").value = "glb"; this.select("glb-resource").value = glb.resourceId;
    this.select("model").value = plan.modelId; this.selectedModel = plan.modelId;
    this.select("feature").value = "";
    this.input("name").value = plan.name;
    for (const [key,value] of Object.entries({lon:p.longitude,lat:p.latitude,elevation:p.height,heading:p.headingDeg,length:p.dimensions.length,width:p.dimensions.width,height:p.dimensions.height})) this.input("glb-"+key).value=String(value);
    this.select("glb-scale-mode").value = p.scaleMode;
    this.select("glb-placement-mode").value = glb.placementMode ?? "manual";
    this.glbAutoFit = glb.autoFit ? structuredClone(glb.autoFit) : undefined;
    this.input("glb-flip").checked = glb.autoFit?.flip180 ?? false;
    this.el("glb-fit-status").textContent = this.glbAutoFit ? this.describeGlbAutoFit(this.glbAutoFit) : "已恢复保存的位置与尺寸；此方案按手动方式保留，不会重新自动缩放。";
    this.input("glb-clipping").checked = glb.clippingEnabled;
    this.input("glb-brand-visible").checked = glb.branding?.visible === true;
    this.input("glb-brand-text").value = glb.branding?.text ?? ""; this.glbLogo = glb.branding?.logoUrl;
    this.updateFields();
    this.status(`正在编辑「${plan.name}」。生成预览并保存后替换此方案。`);
  }
  private async runGlb() {
    this.cancel(false); this.dropPreview(); this.clearReview(); this.clearOverlay();
    const job = new AbortController(); this.analysis = job; this.buttons();
    try {
      if (!this.manifest) this.manifest = await loadTemporaryWorksGlbManifest();
      job.signal.throwIfAborted();
      const resource = this.resource();
      if (!resource) throw new Error("未找到所选真实模型，请检查资源清单。");
      const model = this.options.getTilesets().find(item => item.id === this.value("model")), generation = this.generation;
      const matrix = Matrix4.clone(model?.tileset.modelMatrix ?? Matrix4.IDENTITY), rootTransform = Matrix4.clone(model?.tileset.root.transform ?? Matrix4.IDENTITY);
      const checkSource = () => {
        if (generation !== this.generation || !this.editable() || (model && (this.options.getTilesets().find(m=>m.id===model.id)?.tileset !== model.tileset || !Matrix4.equals(matrix,model.tileset.modelMatrix) || !Matrix4.equals(rootTransform,model.tileset.root.transform)))) throw new Error("摄影模型、项目或权限已变化，请重新生成预览。");
      };
      const old = this.glbEditing ? this.records.get(this.glbEditing) : undefined;
      const selectedFeature = this.feature();
      const coordinates: PlanningCadCoordinates = selectedFeature ? this.coordinates() : old?.inputs.coordinates ?? {mode:"geographic",axisOrder:"eastNorth"};
      const automatic = resource.id !== "wall" && this.value("glb-placement-mode") === "cad-auto";
      if (automatic) {
        const boundary = selectedFeature ?? (old?.inputs.feature.sourceType !== "GLB" ? old?.inputs.feature : undefined);
        if (!boundary) throw new Error("请先选择驻地或钢筋厂的 CAD 闭合轮廓并核对坐标；无图纸时请选择手动精确布置。");
        await this.applyGlbBoundaryFit(job,boundary,coordinates);
        job.signal.throwIfAborted(); checkSource();
      }
      const glb: TemporaryWorksGlbConfig = {
        resourceId:this.resourceId(), clippingEnabled:this.resourceId() !== "wall" && this.input("glb-clipping").checked,
        placementMode:automatic ? "cad-auto" : "manual",autoFit:automatic ? this.glbAutoFit : undefined,
        placement:{longitude:this.num("glb-lon","底面基准经度"),latitude:this.num("glb-lat","底面基准纬度"),height:this.num("glb-elevation","底面椭球高"),
          headingDeg:this.num("glb-heading","平面旋转角"),scaleMode:this.value("glb-scale-mode") as "uniform"|"xyz",
          dimensions:{length:this.num("glb-length","目标长度"),width:this.num("glb-width","目标宽度"),height:this.num("glb-height","目标高度")}},
        branding:{visible:this.input("glb-brand-visible").checked,text:this.value("glb-brand-text"),logoUrl:this.glbLogo},
      };
      if (glb.clippingEnabled && !model) throw new Error("启用摄影遮挡时，请先加载并选择倾斜摄影模型；独立坐标布置可先关闭摄影遮挡。");
      const footprints = getTemporaryWorksGlbFootprints(resource,glb.placement);
      if (selectedFeature && !selectedFeature.closed) throw new Error("临建场地请选择 CAD 闭合场界。");
      const feature: PlanningCadFeature = selectedFeature ?? old?.inputs.feature ?? {id:"manual-glb-footprint",layer:"建筑底面",sourceType:"GLB",closed:true,points:footprints[0].outer.map(p=>({x:p.longitude,y:p.latitude}))};
      if (feature.sourceType !== "GLB") {
        const siteFrame = createPlanCoordinateFrame(coordinates,feature.points[0]);
        if (!glbFootprintsInsideSite(footprints.map(part=>part.outer.map(siteFrame.geoToLocal)),feature.points.map(siteFrame.cadToLocal)))
          throw new Error("实际建筑底面超出所选 CAD 场界，请调整位置、旋转或目标尺寸后重试。");
      }
      const p = glb.placement;
      const record: TemporaryWorksPlan = {
        id:old?.id ?? newId(),name:this.value("name") || resource.name,kind:glb.resourceId === "steel" ? "steel" : "camp",visible:true,createdAt:old?.createdAt ?? new Date().toISOString(),
        modelId:model?.id ?? "",modelName:model?.name ?? "未关联摄影模型",glb,earthworkDisabled:true,mesh:{vertices:[],triangles:[]},metrics:{planArea:0,coveredArea:0,excludedArea:0,cutVolume:0,fillVolume:0},
        inputs:{cadName:selectedFeature ? this.cadFile?.name ?? "CAD 场界" : old?.inputs.cadName ?? "底面基准点定位",modelMatrix:Matrix4.toArray(matrix),modelRootTransform:Matrix4.toArray(rootTransform),
          feature,coordinates,reference:{longitude:p.longitude,latitude:p.latitude,height:p.height},referenceInput:{mode:"geo",first:p.longitude,second:p.latitude},
          design:{reference:{x:0,y:0},referenceHeight:p.height,finishedOffset:0,surfaceToTreatment:0,treatmentDepth:0},facilityMode:"glb",spacing:0,sampleCount:glb.autoFit?.surface.sampleCount ?? 0,refinementLevels:0,budgetLimited:false},
      };
      this.status(`正在加载「${resource.name}」并关联建筑底面摄影遮挡…`);
      const handle = this.draw(record), discard = () => handle.destroy();
      job.signal.addEventListener("abort",discard,{once:true});
      try { await handle.ready; job.signal.throwIfAborted(); checkSource(); }
      catch (error) { discard(); throw error; }
      finally { job.signal.removeEventListener("abort",discard); }
      this.preview = {record,handle,checkSource,replaceId:old?.id};
      this.review(record,false); handle.zoom();
      this.status(glb.autoFit ? `真实模型已按图纸轮廓生成预览。${this.describeGlbAutoFit(glb.autoFit)} 保存后可独立编辑。` : "真实模型预览已生成。底面基准点、实际尺寸与摄影遮挡需在场景中核对，保存后可独立编辑。");
    } catch (error) { if (!job.signal.aborted) this.failure(error); }
    finally { if (this.analysis === job) this.analysis = undefined; this.buttons(); }
  }

  private async run() {
    if (!this.upgradeEnabled || !this.editable() || this.busySave || this.cadRead || this.sectionRead) return;
    if (this.isGlb()) { await this.runGlb(); return; }
    if (this.kind() !== "road") { this.failure(new Error("新增临建设施请使用真实 GLB 资源布置。历史设施和土方数据仍可查看、显示或删除。")); return; }
    this.cancel(false); this.dropPreview(); this.clearReview();
    if (this.kind() !== "road") this.clearOverlay();
    const job = new AbortController();
    this.analysis = job; this.buttons();
    let markConflict: ((e: RoadRouteConflict) => void) | undefined;
    try {
      const model = this.model(), kind = this.kind(), feature = this.feature(), file = this.cadFile;
      if (!feature || !file) throw new Error("请先导入 CAD 平面规划图并选取规划线形。");
      if (kind !== "road" && !feature.closed) throw new Error("项目驻地和钢筋加工场需要闭合场地边界。");
      if (!this.input("confirmed").checked) throw new Error("请核对设计标高和断面尺寸后勾选确认。");
      if (kind !== "road" && this.input("section").files?.length && !this.sectionFile) throw new Error("断面图未成功读取，请重新选择文件。");
      const coordinates = this.coordinates(), roadLine = kind === "road";
      if (roadLine && feature.closed) throw new Error("便道需要选择未闭合的 CAD 中心线。");
      const frame = (roadLine ? createRoadCoordinateFrame : createPlanCoordinateFrame)(coordinates, feature.points[0]);
      const points = feature.points.map(frame.cadToLocal);
      const reversed = roadLine && this.reversed;
      if (reversed) points.reverse();
      const factors = coordinates.mode === "geographic" ? undefined : feature.stationFactors;
      const stationFactors = reversed ? factors?.slice().reverse() : factors;
      if (roadLine) {
        markConflict = error => {
          const raw = reversed ? [...feature.points].reverse() : feature.points;
          const marks = markConflictStations(raw, points, stationFactors, error.stations);
          drawFeature(this.el("cad-preview"), feature, true, reversed, marks);
        };
      }
      const refMode = !roadLine && this.value("ref-mode") === "geo" ? "geo" : "cad";
      const routeStart = reversed ? feature.points.at(-1)! : feature.points[0];
      const first = roadLine ? routeStart.x : this.num("ref-x", "基准点第一坐标");
      const second = roadLine ? routeStart.y : this.num("ref-y", "基准点第二坐标");
      const localRef = roadLine ? points[0] : refMode === "geo"
        ? frame.geoToLocal({ longitude: first, latitude: second }) : frame.cadToLocal({ x: first, y: second });
      const location = refMode === "geo" ? { longitude: first, latitude: second } : frame.localToGeo(localRef);
      const design: PlanningDesign = { reference: localRef, referenceHeight: NaN,
        finishedOffset: roadLine ? 0 : this.num("finished", "硬化面相对标高"), surfaceToTreatment: this.num("thickness", "硬化层厚度"),
        treatmentDepth: this.num("treatment", "地基处理深度"),
        ...(roadLine ? { centerline: points } : { gradeEastPct: this.num("grade-east", "向东坡度"), gradeNorthPct: this.num("grade-north", "向北坡度") }),
      };
      const roadInput = roadLine ? { width: this.num("width", "路面宽度"), hardeningDepth: design.surfaceToTreatment,
        treatmentDepth: design.treatmentDepth, slopeHeight: 1,
        slopeWidth: 0, grades: this.getGrades(), stationFactors } : undefined;
      if (roadInput && roadInput.width <= 0) throw new Error("路面宽度须大于零。");
      if (design.surfaceToTreatment < 0 || design.treatmentDepth < 0) throw new Error("硬化层厚度和地基处理厚度均须大于或等于零。");
      const mode = kind === "road" ? undefined : this.facilityMode();
      const selected = new Set([...this.select("building").selectedOptions].map(o => o.value));
      const buildingFeatures = mode === "cad" ? this.cad.filter(f => f.closed && selected.has(f.id)) : [];
      if (mode === "cad" && !buildingFeatures.length) throw new Error("请选择至少一个建筑闭合轮廓，或切换为自动布置标准模型、仅生成硬化场坪。");
      const buildingHeight = buildingFeatures.length ? this.num("building-height", kind === "camp" ? "房屋高度" : "厂房高度") : 0;
      if (buildingFeatures.length && (buildingHeight <= 0 || buildingHeight > 300)) throw new Error("房屋或厂房的建模高度应大于零且不超过 300 米。");
      const buildings = buildingFeatures.map(f => ({ footprint: f.points.map(p => frame.localToGeo(frame.cadToLocal(p))), height: buildingHeight }));
      const spacing = this.num("grid", "采样间距");
      const name = this.value("name") || `${KIND_NAMES[kind]} · ${feature.layer}`;
      const matrix = Matrix4.clone(model.tileset.modelMatrix), rootTransform = Matrix4.clone(model.tileset.root.transform);
      const checkSource = () => {
        if (this.model().tileset !== model.tileset || !Matrix4.equals(matrix, model.tileset.modelMatrix) ||
            !Matrix4.equals(rootTransform, model.tileset.root.transform)) throw new Error("倾斜摄影模型或定位已变化，请重新计算。");
      };
      const progress = (label: string) => (done: number, total: number) => {
        if (!job.signal.aborted) this.status(`${label} · ${done} / ${total} 个位置`);
      };
      this.status(`正在采样「${model.name}」的基准点和设计范围…`);
      const { mesh, metrics, road, sampleCount, refinementLevels, budgetLimited } = await withPlanningSurface(this.options.viewer, model.tileset, { signal: job.signal }, async (sample, surfaceSignal) => {
        const initial = roadInput ? undefined : buildPlanningMesh({kind:"boundary",points},spacing);
        const [height, ...ground] = roadInput ? [null] : await sample([location, ...(initial?.points.map(frame.localToGeo) ?? [])], progress("采样实景表面"));
        job.signal.throwIfAborted();
        if (roadInput) {
          this.status("正在沿中心线和横断面采样摄影表面，生成贴地便道…");
          let samplingBatches = 0;
          const r = await solveDrapedRoad(points,{...roadInput,stationBreaks:roadInput.grades.flatMap(g=>[g.start,g.end])},spacing,
            (extra, batch) => {
              ++samplingBatches;
              if (batch.phase === "datum") return sample(extra.map(frame.localToGeo), progress("搜索起点附近的模型表面"));
              const stage = batch.phase === "initial" ? `第 ${batch.chunk} 个网格分区 · 读取路基表面` : "全线模型覆盖边缘加密";
              return sample(extra.map(frame.localToGeo), done => {
                if (!job.signal.aborted) this.status(`${stage} ${batch.offset+done} / ${batch.total}，累计已读取 ${batch.completed+done} 个网格位置`);
              });
            }, {signal: surfaceSignal});
          job.signal.throwIfAborted();
          design.reference = r.vertices.length ? {x:r.vertices[0].x,y:r.vertices[0].y} : points[0];
          design.referenceHeight = r.vertices[0]?.groundHeight ?? 0;
          const audit: RoadAudit = {surfaceMode:"draped", missingTriangles:r.missingTriangles,steepTriangles:r.steepTriangles,unresolvedTriangles:r.unresolvedTriangles,maxObservedDeviation:r.maxObservedDeviation,sampleSpacing:r.sampleSpacing,surfaceTolerance:r.surfaceTolerance,maxSlope:r.maxSlope, length:r.length, reversed, bendJoin:r.bendJoin, samplingBatches, grades:roadInput.grades, slopeHeight:roadInput.slopeHeight, slopeWidth:roadInput.slopeWidth,
            referenceStation:r.vertices[0]?.roadStation ?? 0, hardeningBottomWidth:r.hardeningBottomWidth, formationWidth:r.formationWidth,
            pavementArea:r.pavementArea, coveredPavementArea:r.coveredPavementArea};
          const vertices: Vertex[] = [];
          let firstPavementStation = Infinity, lastPavementStation = -Infinity;
          for (let i = 0; i < r.vertices.length; i++) {
            if (i > 0 && i % 4096 === 0) {
              progress("生成三维便道")(i, r.vertices.length);
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              job.signal.throwIfAborted();
            }
            const { x, y, ...levels } = r.vertices[i];
            if (levels.roadPart === "core") {
              firstPavementStation = Math.min(firstPavementStation, levels.roadStation);
              lastPavementStation = Math.max(lastPavementStation, levels.roadStation);
            }
            vertices.push({ ...frame.localToGeo({x, y}), ...levels });
          }
          if (Number.isFinite(firstPavementStation)) audit.pavementStationRange = [firstPavementStation, lastPavementStation];
          return { mesh:{vertices,triangles:r.triangles}, metrics:{planArea:r.planArea,coveredArea:r.coveredArea,excludedArea:r.excludedArea,cutVolume:0,fillVolume:0},
            road:audit, sampleCount:r.sampleCount,refinementLevels:r.refinementLevels,budgetLimited:r.budgetLimited };
        }
        if (height === null || !Number.isFinite(height)) throw new Error("基准点未落在所选模型的有效表面，请检查坐标或重新拾取。");
        design.referenceHeight = height;
        const refined = await refinePlanningCoverage(initial!, ground, extra => sample(extra.map(frame.localToGeo), progress("细化模型覆盖边缘")));
        const result = calculatePlanningEarthwork(refined.mesh, refined.ground, design);
        const { planArea, coveredArea, excludedArea, cutVolume, fillVolume } = result;
        const vertices: Vertex[] = [], remap = new Map<number, number>();
        const triangles = result.triangles.map(triangle => triangle.map(i => {
          const prev = remap.get(i);
          if (prev !== undefined) return prev;
          const index = vertices.length; remap.set(i, index);
          vertices.push({ ...frame.localToGeo(refined.mesh.points[i]), surfaceHeight: result.finishedHeights[i],
            baseHeight: result.treatmentTopHeights[i], groundHeight: refined.ground[i]!, formationHeight: result.formationHeights[i] });
          return index;
        }) as Triangle);
        return {mesh:{vertices,triangles},metrics:{planArea,coveredArea,excludedArea,cutVolume,fillVolume},road:undefined,
          sampleCount:refined.mesh.points.length,refinementLevels:refined.levels,budgetLimited:refined.budgetLimited};
      });
      job.signal.throwIfAborted();
      checkSource();
      if (!this.editable()) throw new Error("项目权限已变化，请重新打开临建规划。");
      const {planArea, cutVolume, fillVolume} = metrics;
      if (!mesh.triangles.length) throw new Error(`所选范围没有形成有效覆盖网格。规划面积 ${valueText(planArea)} m²，有效覆盖面积 0 m²。请核对定位、摄影覆盖和间距。`);
      const sampleLocation = road ? frame.localToGeo(design.reference) : location;
      const record: TemporaryWorksPlan = {
        id: newId(), name, kind, modelId: model.id, modelName: model.name, visible: true, createdAt: new Date().toISOString(),
        mesh, metrics, earthworkDisabled:roadLine,
        ...(buildings.length === 1 ? { building: buildings[0] } : buildings.length ? { buildings } : {}),
        inputs: { cadName: file.name, modelMatrix: Matrix4.toArray(matrix), modelRootTransform: Matrix4.toArray(rootTransform),
          ...(mode ? {facilityMode:mode} : {}),
          ...(kind === "camp" && mode !== "pad" ? {campYard:this.input("camp-yard").checked} : {}),
          feature, coordinates, ...(this.registration ? {registration:this.registration} : {}),
          ...(this.projected?.applied ? {projectedCheck:this.projected.check} : {}), reference: { ...sampleLocation, height: design.referenceHeight },
          referenceInput: road?.datumMode === "road-coverage"
            ? {mode:"geo", first:sampleLocation.longitude, second:sampleLocation.latitude}
            : {mode:refMode, first, second}, design, width: roadInput?.width, road, spacing, sampleCount, refinementLevels, budgetLimited,
          ...(roadInput ? {} : {sectionName:this.sectionFile?.name, thicknessSource:this.thicknessSource}) },
        ...(roadInput ? {} : {sectionAttachment:this.sectionFile}),
      };
      const handle = this.draw(record);
      const discard = () => handle.destroy();
      job.signal.addEventListener("abort", discard, {once:true});
      try {
        await handle.ready;
        job.signal.throwIfAborted();
        if (mode === "standard" && !handle.standardPlacement)
          throw new Error("当前有效场坪未能容纳完整标准模型。请检查场界或切换布置方式。");
        checkSource();
      } catch (error) {
        discard();
        throw error;
      } finally {
        job.signal.removeEventListener("abort", discard);
      }
      if (handle.standardPlacement) record.inputs.facilityPlacement = handle.standardPlacement;
      if (record.inputs.campYard && handle.yard) record.inputs.campLayout = {flag:handle.yard.flag, spaces:handle.yard.spaces};
      if (buildingFeatures.length) record.inputs.structures = buildingFeatures.map((f, i) => ({ feature: f.id, layer: f.layer, included: handle.structureBuilt[i] }));
      this.preview = { record, handle, checkSource };
      this.review(record, false); handle.zoom();
      const discarded = mode === "cad" ? buildings.length - handle.builtStructureCount : 0;
      const buildingNote = discarded ? `${discarded} 个建筑轮廓位于有效范围外，已舍弃。` : "";
      const datumNote = road?.datumMode === "road-coverage" ? roadDatumDescription(road) + "。" : "";
      const previewName = road ? "预览已生成 · 三维便道仅含有效覆盖网格"
        : mode === "standard" ? `预览已生成 · ${KIND_NAMES[kind]}标准模型已放入摄影场景` : "预览已生成";
      this.status(road?.surfaceMode === "draped" ? `${previewName} · 处理底面贴合摄影表面，未生成面积 ${valueText(metrics.excludedArea)} m²。缺测 ${road.missingTriangles}、陡坎 ${road.steepTriangles}、贴合未通过 ${road.unresolvedTriangles} 个网格；请核对后保存。`
        : `${previewName} · 预计挖方 ${valueText(cutVolume)} m³，填方 ${valueText(fillVolume)} m³。${datumNote}${buildingNote}核对后可保存方案。`);
    } catch (error) {
      if (!job.signal.aborted) {
        if (error instanceof RoadRouteConflict) markConflict?.(error);
        this.failure(error);
      }
    }
    finally { if (this.analysis === job) this.analysis = undefined; this.buttons(); }
  }

  private review(plan: TemporaryWorksPlan, saved: boolean) {
    this.clearReview();
    this.inspecting = saved ? plan.id : undefined;
    const { metrics: m, inputs } = plan, d = inputs.design;
    const host = this.el("metrics");
    host.append(element("strong", `${saved ? "已保存" : "预览"} · ${plan.name}`));
    const dl = element("dl");
    const row = (label: string, value: string) => dl.append(element("dt", label), element("dd", value));
    if (!plan.earthworkDisabled) {
      row("历史预计挖方", `${valueText(m.cutVolume)} m³`);
      row("历史预计填方", `${valueText(m.fillVolume)} m³`);
    }
    if (plan.glb) {
      const p = plan.glb.placement;
      row("三维资源", plan.glb.resourceId === "wall" ? "独立宣传墙" : KIND_NAMES[plan.kind]);
      row("建筑底面基准点", `${p.longitude.toFixed(8)}°，${p.latitude.toFixed(8)}° · 椭球高 ${valueText(p.height)} m`);
      row("目标尺寸 · 长×宽×高", `${valueText(p.dimensions.length)} × ${valueText(p.dimensions.width)} × ${valueText(p.dimensions.height)} m`);
      row("平面旋转", `${valueText(p.headingDeg)}°（东→北）`);
      row("缩放方式", p.scaleMode === "uniform" ? "等比例" : "XYZ 独立缩放");
      row("布置方式", plan.glb.placementMode === "cad-auto" ? "CAD 轮廓自动布置（保留原模型高度）" : "手动精确布置");
      if (plan.glb.autoFit) row("图纸适配与取高记录", this.describeGlbAutoFit(plan.glb.autoFit));
      row("摄影遮挡", plan.glb.clippingEnabled ? "按建筑底面自动关联；实际状态见摄影遮挡提示" : "已关闭");
      row("关联场界", `${inputs.cadName} · ${inputs.feature.layer} · ${inputs.feature.id}`);
      host.append(dl);
      if (saved) { host.closest("details")?.setAttribute("open", ""); this.status(`正在查看已保存方案「${plan.name}」。`); }
      return;
    }
    if (inputs.facilityMode) row("场景布置方式", FACILITY_MODES[inputs.facilityMode]);
    if (inputs.facilityPlacement) {
      const place = inputs.facilityPlacement;
      row("标准模型布置中心", `${place.longitude.toFixed(7)}°，${place.latitude.toFixed(7)}°`);
      row("模型比例", `${valueText(place.scale * 100)}%`);
    }
    if (inputs.campLayout) {
      row("驻地国旗台", inputs.campLayout.flag ? "1 座" : "可用空地不足");
      row("驻地停车区", inputs.campLayout.spaces ? `${inputs.campLayout.spaces} 个车位` : "未找到可容纳车位和通车空间的空地");
    }
    if (inputs.road) {
      if (inputs.road.surfaceMode === "draped") {
        row("高程方式", "逐点贴合摄影表面，向上叠加结构层");
        row("地基处理 / 硬化厚度", `${valueText(d.treatmentDepth)} / ${valueText(d.surfaceToTreatment)} m`);
        row("未生成网格", `缺测 ${inputs.road.missingTriangles ?? 0} · 陡坎 ${inputs.road.steepTriangles ?? 0} · 贴合未通过 ${inputs.road.unresolvedTriangles ?? 0}`);
      }
      row("道路中心线长度", `${valueText(inputs.road.length)} m`);
      if (inputs.road.referenceSource) {
        const r = inputs.road;
        row("高程校准方式", roadDatumDescription(r));
        row("校准桩号处路面顶", `${stationLabel(r.referenceStation)} · 相对校准零点 ${valueText(d.finishedOffset)} m`);
        if (r.pavementStationRange) {
          const [first, last] = r.pavementStationRange;
          row("有效路面首、末桩号", `${stationLabel(first)}、${stationLabel(last)}（中间缺测部分另行剔除）`);
          const endHeight = r.grades.reduce((z,g) =>
            z + Math.max(0, Math.min(last, g.end) - Math.max(r.referenceStation, g.start)) * g.gradePct / 100, d.finishedOffset);
          row("末个有效桩号路面顶", `${valueText(endHeight)} m（相对同一校准零点）`);
        }
      } else if (inputs.road.datumMode === "road-start") {
        const terminal = inputs.road.grades.reduce((z,g) => z + (g.end-g.start)*g.gradePct / 100, d.finishedOffset);
        row("起点便道顶标高", `${valueText(d.finishedOffset)} m（相对起点摄影表面）`);
        row("终点便道顶标高", `${valueText(terminal)} m（同一零点）`);
      }
      row("设计路面面积", `${valueText(inputs.road.pavementArea)} m²`);
      row("有效路面面积", `${valueText(inputs.road.coveredPavementArea)} m²`);
    }
    row(inputs.road ? "处理底设计占地" : "CAD 规划面积", `${valueText(m.planArea)} m²`);
    row("模型有效覆盖面积", `${valueText(m.coveredArea)} m²`);
    row("舍弃面积（含缺测边缘）", `${valueText(m.excludedArea)} m²`);
    row("有效覆盖率", `${(m.coveredArea / m.planArea * 100).toFixed(1)}%`);
    host.append(dl);
    const detail = element("details");
    detail.append(element("summary", "查看计算依据"));
    const crs = inputs.coordinates;
    const order = crs.axisOrder === "eastNorth" ? "东、北" : "北、东";
    const binding = crs.mode === "local" ? `工程独立坐标，单位 ${crs.unit}，控制点 (${crs.referenceX}, ${crs.referenceY}) 对应 (${crs.longitude}°, ${crs.latitude}°)，旋转 ${crs.rotation}°`
      : crs.mode === "geographic" ? "WGS84 经纬度" : `CGCS2000 高斯投影，单位 ${crs.unit}，${crs.bandWidth ? crs.bandWidth+"°分带、第"+crs.zoneNumber+"带，" : ""}中央子午线 ${crs.centralMeridian}°，${crs.hasZonePrefix ? `含带号 ${crs.zoneNumber}` : "坐标不含带号"}`;
    const facts = [
      `平面图：${inputs.cadName} · 图层 ${inputs.feature.layer} · 图元 ${inputs.feature.id}。`,
      `坐标定位：${binding}。CAD 轴序为${order}。`,
      ...(inputs.projectedCheck ? [`已按摄影同名点平移：向东 ${valueText(inputs.projectedCheck.east)} m、向北 ${valueText(inputs.projectedCheck.north)} m。复核点 CAD (${inputs.projectedCheck.cad.x}, ${inputs.projectedCheck.cad.y})，模型经、纬度 (${inputs.projectedCheck.geo.longitude.toFixed(8)}°, ${inputs.projectedCheck.geo.latitude.toFixed(8)}°)。`] : []),
      ...(inputs.registration ? [`平面两点校准：图纸基线 ${valueText(inputs.registration.drawingDistance)} m、模型基线 ${valueText(inputs.registration.modelDistance)} m，B 点偏差 ${valueText(inputs.registration.residual)} m。`] : []),
      `摄影模型：${plan.modelName}。基准点经度 ${inputs.reference.longitude.toFixed(8)}°、纬度 ${inputs.reference.latitude.toFixed(8)}°，模型椭球高 ${valueText(inputs.reference.height)} m，对应相对标高 ±0.000。`,
      inputs.road?.surfaceMode === "draped" ? "结构底面高程逐点来自摄影表面；处理顶面=摄影高程+处理厚度；硬化顶面=处理顶面+硬化厚度。"
        : `${inputs.road?.referenceSource ? "校准桩号处" : "基准点"}相对标高：硬化顶面 ${valueText(d.finishedOffset)} m，地基处理顶面 ${valueText(d.finishedOffset - d.surfaceToTreatment)} m，开挖计量底面 ${valueText(d.finishedOffset - d.surfaceToTreatment - d.treatmentDepth)} m。`,
      ...(inputs.road ? this.roadFacts(inputs) : [
        inputs.width !== undefined ? `便道宽 ${valueText(inputs.width)} m，沿线纵坡 ${valueText(d.longitudinalPct ?? 0)}%，${d.sectionProfile ? "按 CAD 断面折线计算横向标高" : `双向路拱横坡 ${valueText(d.crossfallPct ?? 0)}%`}。`
          : `设计面向东坡度 ${valueText(d.gradeEastPct ?? 0)}%，向北坡度 ${valueText(d.gradeNorthPct ?? 0)}%。`,
        `典型断面：${inputs.sectionName || "手工录入已核对的设计参数"}${inputs.sectionFeature ? ` · 横断线 ${inputs.sectionFeature}（${inputs.sectionUnit}）` : ""}${inputs.thicknessSource ? ` · 厚度图线 ${inputs.thicknessSource}` : ""}。`,
      ]),
      `采样间距 ${valueText(inputs.road?.sampleSpacing ?? inputs.spacing)} m，${inputs.sampleCount} 个网格采样点，覆盖边缘细化 ${inputs.refinementLevels} 级。${inputs.budgetLimited ? "已达到采样点上限，混合网格按缺测处理。" : ""}`,
      ...(plan.earthworkDisabled ? [] : ["历史土方结果随原方案保留。"]),
    ];
    const structures = inputs.structures ?? [];
    if (structures.length) {
      facts.push(`建筑高度 ${valueText((plan.building ?? plan.buildings![0]).height)} m。选定 ${structures.length} 个轮廓，${structures.filter(s => s.included).length} 个与有效硬化范围相交。`);
      for (const structure of structures) facts.push(`${structure.layer} · ${structure.feature} · ${structure.included ? "按有效硬化范围建模" : "位于范围外，已舍弃"}。`);
    }
    for (const fact of facts) detail.append(element("p", fact));
    if (saved && plan.sectionAttachment instanceof Blob) {
      this.reviewUrl = URL.createObjectURL(plan.sectionAttachment);
      const a = element("a", "下载保存的典型断面原图"); a.href = this.reviewUrl;
      a.download = inputs.sectionName || "典型断面"; detail.append(a);
    }
    host.append(detail);
    if (saved) {
      host.closest("details")?.setAttribute("open", "");
      host.scrollIntoView({ block: "nearest" });
      this.status(`正在查看已保存方案「${plan.name}」。`);
    }
  }
  private roadFacts(inputs: TemporaryWorksPlan["inputs"]) {
    const r = inputs.road!, path = inputs.feature.points, design = inputs.design;
    if (r.surfaceMode === "draped") return [
      `CAD 中心线长度 ${valueText(r.length)} m，原图里程与起终点方向保留。`,
      `路宽 ${valueText(inputs.width!)} m，处理厚度 ${valueText(design.treatmentDepth)} m，硬化厚度 ${valueText(design.surfaceToTreatment)} m，竖向厚度逐点一致。`,
      `有效网格高程全部来自选定摄影表面。缺测、陡坎和未满足贴合精度的部分不生成。`,
      `表面取样 ${inputs.sampleCount} 个位置，初始采样间距 ${valueText(r.sampleSpacing ?? inputs.spacing)} m，细化 ${inputs.refinementLevels} 级，已生成网格最大探针偏差 ${valueText(r.maxObservedDeviation ?? 0)} m。`,
      `贴合容差 ${valueText(r.surfaceTolerance ?? .02)} m，最大允许坡率 ${valueText(r.maxSlope ?? 1)}。实测穿透检查采用 0.00001 m 数值阈值；探针之间更小的摄影突起仍须在实际场景复核。`,
      ...r.grades.map(g=>`${stationLabel(g.start)} ～ ${stationLabel(g.end)} · 施工里程分段`),
    ];
    const source = inputs.feature.id.startsWith("chain-") ? "所选组合线路" : "CAD";
    const start = r.reversed ? path.at(-1)! : path[0], end = r.reversed ? path[0] : path.at(-1)!;
    return [
      `中心线长度 ${valueText(r.length)} m。起点 ${stationLabel(0)} 为 ${source} ${r.reversed ? "末点" : "首点"}（X=${start.x}，Y=${start.y}），终点 ${stationLabel(r.length)} 为 ${source} ${r.reversed ? "首点" : "末点"}（X=${end.x}，Y=${end.y}）。`,
      r.referenceSource
        ? `路面顶相对标高 ${valueText(design.finishedOffset)} m 施加于原设计桩号 ${stationLabel(r.referenceStation)}。缺测段跳过建模与计量，后续有覆盖路段按原纵坡接续。`
        : r.datumMode === "road-start"
        ? `起点 ${stationLabel(0)} 的摄影表面为 ±0.000 m。输入起点便道顶相对标高 ${valueText(design.finishedOffset)} m，各变坡点连续累计高差。`
        : `基准点在中心线上的对应里程为 ${stationLabel(r.referenceStation)}。各坡段在变坡点连续，按该基准点里程处的硬化面设计标高起算。`,
      `路面宽 ${valueText(inputs.width!)} m，硬化厚 ${valueText(design.surfaceToTreatment)} m，地基处理深 ${valueText(design.treatmentDepth)} m，路基边坡高宽比 ${r.slopeHeight}∶${r.slopeWidth}。硬化层底宽 ${valueText(r.hardeningBottomWidth)} m，处理底宽 ${valueText(r.formationWidth)} m。`,
      ...(r.samplingBatches ? [`摄影表面高程分 ${r.samplingBatches} 批读取，全线按同一套里程和高程基准计量。`] : []),
      ...(r.bendJoin === "round-union" ? ["弯道外侧按圆角接顺，内侧重合区域已合并，面积和挖填方各计一次。"] : []),
      ...r.grades.map(g => `${stationLabel(g.start)} ～ ${stationLabel(g.end)}　纵坡 ${g.gradePct > 0 ? "+" : ""}${g.gradePct}%。`),
    ];
  }
  private list() {
    const list = this.el("plans");
    list.replaceChildren();
    if (!this.records.size) { list.textContent = "当前项目还没有已保存的临建方案。"; return; }
    const plans = [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const p of plans) {
      const row = element("div"); row.className = "tw-plan-row"; row.dataset.planId = p.id;
      const visible = this.overrides.get(p.id) ?? p.visible;
      const label = element("div"); label.append(element("strong", p.name), element("small", `　${p.glb?.resourceId === "wall" ? "独立宣传墙" : KIND_NAMES[p.kind]} · ${this.newPlan(p) && !this.upgradeEnabled ? "功能已暂停" : visible ? "已显示" : "已隐藏"}${p.earthworkDisabled ? "" : ` · 历史挖方 ${valueText(p.metrics.cutVolume)} m³`}`));
      if (p.kind !== "road") {
        const boundary = p.inputs.feature;
        label.append(element("small", `场界：${p.inputs.cadName} / ${boundary.layer || "未命名图层"} / ${boundary.id}`));
      }
      const actions = element("div");
      const buttons = [["inspect", "复核"], ["locate", "定位"], ["hide", visible ? "隐藏" : "显示"]];
      if (p.glb) buttons.unshift(["edit", "编辑"]);
      if (canAddStandardFacility(p)) buttons.push(["standardize", "补建标准模型"]);
      buttons.push(["delete", "删除"]);
      for (const [action, text] of buttons) {
        const b = element("button", text); b.type = "button"; b.dataset.twAction = action; b.setAttribute("aria-label", `${text} · ${p.name}`);
        if (action === "hide") b.setAttribute("aria-pressed", String(visible));
        if (action === "locate" && !visible) { b.disabled = true; b.title = "显示此设施后可定位"; }
        if (action === "delete" || action === "standardize" || action === "edit") b.disabled = !this.editable();
        if (action === "standardize" && this.upgrading) b.disabled = true;
        if (action === "delete" && this.upgrading === JSON.stringify([this.projectId,p.id])) b.disabled = true;
        if (this.pendingDelete.has(JSON.stringify([this.projectId, p.id]))) b.disabled = true;
        actions.append(b);
      }
      const handle = this.handles.get(p.id);
      if (p.glb && handle && "status" in handle) label.append(element("small", handle.status.message));
      row.append(label, actions); list.append(row);
    }
  }
  private async addStandardFacility(id: string) {
    const projectId = this.projectId, old = this.records.get(id), token = this.generation;
    if (!projectId || !this.editable() || !old || !canAddStandardFacility(old)) return;
    const key = JSON.stringify([projectId,id]);
    if (this.upgrading || this.pendingDelete.has(key)) return;
    this.upgrading = key; this.list();
    const inputs = {...old.inputs, facilityMode:"standard" as const};
    if (old.kind === "camp") inputs.campYard = old.inputs.campYard ?? true;
    let candidate: MeshHandle | undefined;
    try {
      candidate = this.draw({...old, inputs});
      candidate.show = false;
      await candidate.ready;
      const placement = candidate.standardPlacement;
      if (!placement) throw new Error("场坪未能容纳完整标准模型，原方案已保留。");
      if (this.generation !== token || !this.editable()) return;
      const yard = candidate.yard;
      const current = await this.options.store.updateExisting(projectId, id, stored => {
        if (this.generation !== token || !this.editable() || stored.createdAt !== old.createdAt || !canAddStandardFacility(stored))
          throw new Error("方案或项目权限已变更，请重新打开方案。");
        return {...stored, inputs:{...stored.inputs, facilityMode:"standard", facilityPlacement:placement,
          ...(stored.kind === "camp" ? {campYard:inputs.campYard, campLayout:yard ? {flag:yard.flag,spaces:yard.spaces} : undefined} : {})}};
      });
      if (this.generation !== token) return;
      const visible = this.overrides.get(id) ?? current.visible;
      this.handles.get(id)?.destroy();
      this.records.set(id, current); this.handles.set(id, candidate);
      candidate.show = visible;
      const finished = candidate; candidate = undefined;
      if (visible) finished.zoom();
      if (!this.preview) this.review(current, true);
      this.options.onPlansChanged?.();
      this.status(`已在「${current.name}」的场坪上补建标准模型。${visible ? "" : "方案当前已隐藏，点击“显示”即可查看。"}`);
    } catch (error) {
      if (this.generation === token && !this.disposed) this.failure(error);
    } finally {
      candidate?.destroy(); this.upgrading = undefined;
      if (!this.disposed) this.list();
    }
  }
  private async save() {
    const projectId = this.projectId, draft = this.preview, token = this.generation;
    if (!projectId || !this.editable() || !draft || this.busySave) return;
    this.busySave = true; this.buttons();
    try {
      draft.checkSource();
      const plan = draft.replaceId
        ? await this.options.store.updateExisting(projectId, draft.replaceId, stored => ({...draft.record,id:stored.id,createdAt:stored.createdAt,visible:stored.visible}))
        : draft.record;
      if (!draft.replaceId) await this.options.store.put(projectId, plan);
      if (this.generation !== token) return;
      if (draft.replaceId) { this.handles.get(draft.replaceId)?.destroy(); draft.handle.show = this.visible(plan); }
      this.glbEditing = undefined;
      this.records.set(plan.id, plan);
      if (this.preview === draft) {
        this.handles.set(plan.id, draft.handle); this.preview = undefined;
      } else this.restoreDrawing(plan);
      this.list(); this.updateFields(); this.options.onPlansChanged?.(); this.review(plan, true);
      this.status(`已保存「${plan.name}」，可在已保存方案或场景显示中管理。`);
    } catch (error) { if (this.generation === token) this.failure(error); }
    finally { if (this.generation === token) { this.busySave = false; this.buttons(); } }
  }
  async removePlan(id: string): Promise<boolean> {
    const projectId = this.projectId, record = this.records.get(id);
    if (!record || !projectId || !this.editable()) throw new Error("当前项目无法删除这项临建设施，请核对账号权限。");
    const key = JSON.stringify([projectId, id]);
    if (this.upgrading === key || this.pendingDelete.has(key) || !window.confirm(`删除「${record.name}」的三维模型及方案记录？`)) return false;
    this.pendingDelete.add(key); this.list();
    try {
      await this.options.store.remove(projectId, id);
      if (!this.disposed && this.projectId === projectId) {
        this.handles.get(id)?.destroy(); this.handles.delete(id); this.records.delete(id); this.overrides.delete(id);
        if (this.preview?.replaceId === id) this.dropPreview();
        if (this.glbEditing === id) { this.glbEditing = undefined; this.updateFields(); }
        if (this.inspecting === id) this.clearReview();
        this.options.onPlansChanged?.(); this.status(`已删除「${record.name}」。`);
      }
      return true;
    } finally {
      this.pendingDelete.delete(key);
      if (!this.disposed && this.projectId === projectId) this.list();
    }
  }
}
