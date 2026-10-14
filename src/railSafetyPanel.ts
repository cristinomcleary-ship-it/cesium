import type { Cartesian2, Viewer } from "cesium";
import type { ManagementRecord } from "./managementTypes";
import type { MachineryPlacementPick, MachineryState } from "./machineryScene";
import { readMachineryState } from "./machineryScene";
import type { RailSafetyDefinition, RailSafetyPosition, RailSafetyPositionSample, RailSafetyPositioningResult, RailSafetyRecord } from "./railSafetyTypes";
import { RAIL_SAFETY_MAX_REFERENCES, RAIL_SAFETY_MAX_VERTICES } from "./railSafetyTypes";
import { RailSafetyScene, type RailSafetyMachineResult } from "./railSafetyScene";
import { normalizeRailSafetyDisplay, readRailSafetyDisplay, writeRailSafetyDisplay, type RailSafetyDisplaySettings } from "./railSafetyDisplay";
import { RailSafetyPositioningStore, validateRailSafetyPositionSample } from "./railSafetyPositioning";
import { validateRailSafetyWorkArea } from "./railSafetyValidation";
import "./railSafetyPanel.css";

type Tab = "machine" | "guard" | "limit";
type Draft = { id: string; name: string; taskId?: string; revision?: number; definition: RailSafetyDefinition };
type FallDemoState = { active: boolean; loading: boolean; resourceId?: string; resourceName?: string; direction: number; actualDirection?: number; angle: number; playing: boolean; error?: string; maxAngle: number };
export type RailSafetyPanelContext = {
  projectId: string; actorId?: string; records: readonly ManagementRecord[];
  resources: readonly ManagementRecord[]; tasks: readonly ManagementRecord[];
  canEdit: boolean; canView: boolean; active: boolean;
  canCreateTask?: boolean;
};
export type RailSafetyPanelOptions = {
  viewer: Viewer; host: HTMLElement;
  save: (id: string, name: string, definition: RailSafetyDefinition, revision?: number, taskId?: string) => Promise<void>;
  remove: (id: string, revision: number) => Promise<void>;
  editMachinery: (resourceId: string) => void;
  openTasks?: () => void;
  pickPosition?: (position: Cartesian2) => MachineryPlacementPick | undefined;
  onOpenChange?: (open: boolean) => void;
  onPickingChange?: (picking: boolean) => void;
};
const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const numeric = (value: string) => value.trim() === "" ? NaN : Number(value);
const asInput = (value: number) => Number.isFinite(value) ? String(value) : "";
function positionValid(point: RailSafetyPosition) {
  return Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
    && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.height);
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}

/** One workbench panel; all geometry is rendered in the supplied platform Viewer. */
export class RailSafetyPanel {
  private readonly root = element("section", "rail-safety-panel");
  private readonly events = new AbortController();
  private readonly scene: RailSafetyScene;
  private context: RailSafetyPanelContext = { projectId: "", records: [], resources: [], tasks: [], canEdit: false, canView: false, active: false };
  private tab: Tab = "machine";
  private display = normalizeRailSafetyDisplay(undefined);
  private displayTab: keyof RailSafetyDisplaySettings = "envelopes";
  private draft?: Draft;
  private selectedId = "";
  private opened = false;
  private destroyed = false;
  private dirty = false;
  private busy = false;
  private picking = false;
  private concurrentRevision = false;
  private generation = 0;
  private results: RailSafetyMachineResult[] = [];
  private readonly positioning = new RailSafetyPositioningStore();
  private positionStates: Array<{ guardId: string; result: RailSafetyPositioningResult }> = [];
  private readonly positioningTimer: ReturnType<typeof setInterval>;
  private pickingPurpose?: "simulation" | "workArea";
  private fallDemo?: FallDemoState;
  private pendingAction?: () => void;

  constructor(private readonly options: RailSafetyPanelOptions) {
    this.root.hidden = true; this.root.setAttribute("aria-label", "邻近营业线施工管控");
    this.root.innerHTML = `
      <header class="rs-heading"><div><span class="rs-eyebrow">现场布置 · 空间筛查</span><h2>邻近营业线施工</h2></div><button type="button" data-action="close" aria-label="关闭施工管控">关闭</button></header>
      <div class="rs-stats" data-role="stats"></div>
      <nav class="rs-tabs" aria-label="施工管控分类"><button type="button" data-action="tab-machine" data-tab="machine">机械</button><button type="button" data-action="tab-guard" data-tab="guard">防护人员</button><button type="button" data-action="tab-limit" data-tab="limit">安全限界</button></nav>
      <div class="rs-scroll">
        <p class="rs-readonly" data-role="readonly" hidden>只读查看 · 当前账号没有施工管控编辑权限</p>
        <div class="rs-toolbar"><label class="rs-label rs-select-label"><span data-role="select-label">机械资源</span><select data-role="selection" aria-label="选择管控对象"></select></label><button type="button" data-action="new">新增</button><button type="button" data-action="locate">定位</button></div>
        <div data-role="priority"></div>
        <section class="rs-demo" data-role="fall-demo" hidden></section>
        <section class="rs-monitor" data-role="monitor" hidden></section>
        <section class="rs-display" aria-label="显示效果">
          <div class="rs-display-heading"><h3>显示效果</h3><button type="button" data-action="reset-display">恢复默认</button></div>
          <nav class="rs-display-tabs" aria-label="显示设置分类"><button type="button" data-action="display-guards" data-display-tab="guards">防护责任区</button><button type="button" data-action="display-envelopes" data-display-tab="envelopes">倾覆影响区</button><button type="button" data-action="display-personnel" data-display-tab="personnel">防护人员</button></nav>
          <div data-role="display-controls"></div>
          <p class="rs-help" data-role="display-storage">调整立即生效，按当前账号和项目记住显示偏好；不改变区域坐标与筛查结果。</p>
        </section>
        <div class="rs-results" data-role="results" aria-live="polite"></div>
        <div data-role="editor"></div>
        <div class="rs-picking" data-role="picking" hidden><p data-role="pick-message">点击场景地面添加顶点。</p><div class="rs-actions"><button type="button" data-action="undo-point">撤销一点</button><button type="button" data-action="finish-polygon">完成区域</button><button type="button" data-action="cancel-pick">取消绘制</button></div></div>
        <div class="rs-layer-controls" aria-label="范围显示开关"><label><input type="checkbox" data-layer="guards" checked>人员及两类区域</label><label><input type="checkbox" data-layer="limits" checked>设备限界</label><label><input type="checkbox" data-layer="envelopes" checked>倾覆外包</label><p>人员图层包含防护责任区与人员工作区；开关只影响显示，隐藏的限界仍参与筛查。</p></div>
        <div class="rs-legend" aria-label="范围图例"><span><i class="rs-dot rs-purple"></i>设备限界</span><span><i class="rs-dot rs-blue"></i>防护责任区</span><span><i class="rs-dot rs-orange"></i>倾覆外包</span><span><i class="rs-dot rs-red"></i>潜在相交</span><span><i class="rs-dot rs-work-area-dot"></i>人员工作区（按状态变色）</span><p class="rs-legend-note">工作区：绿＝区内，红＝越界，橙＝边界待核实，灰＝无有效定位；紫＝未保存草稿。模拟定位单独标注。</p></div>
        <details class="rs-method"><summary>计算口径与适用范围</summary><p class="rs-note">倾覆落点外包用于平面几何筛查，按固定支承边、水平地面、不滑移和不解体假设计算。外包含采样余量，忽略首次触地后的停止，不是实际倒伏预测。人员责任区仅核对已关联机械的站位，不能代替整个作业范围的防护确认。</p></details>
        <p class="rs-status" data-role="status" role="status">选择机械，或新增防护人员和安全限界。</p>
        <div class="rs-confirm" data-role="confirm" hidden><p data-role="confirm-text"></p><div class="rs-actions"><button type="button" data-action="confirm">放弃草稿并继续</button><button type="button" data-action="keep">继续编辑</button></div></div>
      </div>
      <footer class="rs-footer"><button type="button" data-action="save" class="rs-primary">保存配置</button><button type="button" data-action="cancel">取消编辑</button><button type="button" data-action="remove" class="rs-danger">删除</button></footer>`;
    options.host.append(this.root);
    this.scene = new RailSafetyScene(options.viewer, {
      pickPosition: options.pickPosition,
      onResults: results => {
        if (this.destroyed || !this.context.canView) return;
        this.results = results; this.renderStats(); this.renderResults();
      },
      onFallDemoChange: state => { if (!this.destroyed) { this.fallDemo = state; this.updateFallDemo(); } },
      onPickingChange: picking => {
        if (this.destroyed) return;
        this.setPicking(picking);
      },
      onPickProgress: progress => {
        if (this.destroyed) return;
        this.find('[data-role="pick-message"]').textContent = progress.message || (progress.kind === "point" ? this.pickingPurpose === "simulation" ? "模拟定位：点选人员当前位置，仅用于本地测试，不改变已保存站位。按 Esc 取消。" : "在模型表面或地面点选人员站位。按 Esc 取消。" : `${this.pickingPurpose === "workArea" ? "人员工作区域：" : ""}已选 ${progress.points.length} 个顶点；至少 3 个，按顺序沿边界点选。`);
        this.find<HTMLButtonElement>('[data-action="undo-point"]').hidden = progress.kind === "point";
        this.find<HTMLButtonElement>('[data-action="finish-polygon"]').hidden = progress.kind === "point";
        this.find<HTMLButtonElement>('[data-action="finish-polygon"]').disabled = progress.points.length < 3;
      },
      onSelect: (kind, id) => {
        if (!this.opened || this.busy || this.picking) return;
        this.requestDiscard(() => { this.tab = kind; this.displayTab = kind === "guard" ? "guards" : "envelopes"; this.select(id); }, "切换对象会放弃尚未保存的修改。");
      },
    });
    this.root.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
      if (button && !button.disabled) this.action(button.dataset.action!, button);
    }, { signal: this.events.signal });
    this.root.addEventListener("input", event => this.input(event.target as HTMLInputElement), { signal: this.events.signal });
    this.root.addEventListener("change", event => this.change(event.target as HTMLInputElement | HTMLSelectElement), { signal: this.events.signal });
    this.positioningTimer = setInterval(() => this.refreshPositioning(), 1000);
    this.render();
  }

  get isOpen() { return this.opened; }
  get hasDraft() { return this.dirty || this.picking; }
  get isPicking() { return this.picking; }
  get isBusy() { return this.busy; }
  setPresentation(mode: "workbench" | "management") { this.root.dataset.presentation = mode; }
  setMachineryPreview(id: string, state?: MachineryState) { if (!this.destroyed) this.scene.setMachineryPreview(id, state); }
  /** Adapter entry point; device identity alone does not establish a live connection. */
  ingestPositionSample(input: unknown): RailSafetyPositionSample {
    if (this.destroyed || !this.context.canView || !this.context.active) throw new Error("当前项目不可查看，拒绝定位样本");
    const sample = validateRailSafetyPositionSample(input);
    if (sample.projectId !== this.context.projectId) throw new Error("定位样本不属于当前项目");
    if (!this.records().some(record => record.definition.kind === "guard" && record.definition.workArea?.deviceId === sample.deviceId)) throw new Error("当前项目没有已保存的对应设备绑定");
    const accepted = this.positioning.ingest(sample); this.refreshPositioning(); return accepted;
  }
  private get editable() { return !this.destroyed && this.opened && this.context.canView && this.context.canEdit && this.context.active; }
  private find<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private records(): RailSafetyRecord[] {
    return this.context.canView ? this.context.records.filter(record => record.projectId === this.context.projectId && record.status !== "deleted" && record.definition && typeof record.definition === "object") as RailSafetyRecord[] : [];
  }
  private resources() { return this.context.canView ? this.context.resources.filter(record => record.projectId === this.context.projectId && record.status !== "deleted" && (record.kind === "equipment" || record.category === "equipment")) : []; }
  private existing(id = this.draft?.id) { return this.records().find(record => record.id === id); }

  setContext(context: RailSafetyPanelContext) {
    if (this.destroyed) return;
    const previous = this.context;
    const displayScopeChanged = previous.projectId !== context.projectId || previous.actorId !== context.actorId;
    const reset = previous.projectId !== context.projectId || previous.actorId !== context.actorId || (previous.canView && !context.canView) || (previous.canEdit && !context.canEdit) || (previous.active && !context.active);
    this.context = context;
    if (displayScopeChanged) {
      this.display = readRailSafetyDisplay(context.projectId, context.actorId);
      this.scene.setDisplay(this.display);
      this.find('[data-role="display-storage"]').textContent = "调整立即生效，按当前账号和项目记住显示偏好；不改变区域坐标与筛查结果。";
      this.renderDisplay();
    }
    if (reset) {
      this.positioning.clear(); this.positionStates = []; this.scene.setGuardPositionStates([]); this.scene.stopFallDemo();
      ++this.generation; this.scene.cancelPicking(); this.scene.setDraft(undefined);
      this.draft = undefined; this.selectedId = ""; this.dirty = false; this.busy = false; this.results = []; this.concurrentRevision = false;
      this.pendingAction = undefined; this.find('[data-role="confirm"]').hidden = true;
      if (this.opened) this.options.onOpenChange?.(false);
      this.opened = false;
    }
    this.scene.setContext({ projectId: context.projectId, sessionKey: context.actorId, records: this.records(), resources: this.resources(), canView: context.canView, active: context.active });
    this.refreshPositioning(true);
    if (!reset && this.draft && !this.busy) {
      const saved = this.existing();
      const resourceMissing = this.draft.definition.kind === "machine" && !this.resources().some(resource => resource.id === (this.draft!.definition as { resourceId: string }).resourceId);
      if (resourceMissing || (this.draft.revision !== undefined && !saved)) { this.clearDraft(); this.selectedId = ""; this.renderEditor(); this.message("当前对象已被删除或不再可见，请重新选择。", true); }
      else if (saved && saved.revision !== this.draft.revision) {
        if (this.dirty || this.picking || this.concurrentRevision) {
          this.concurrentRevision = true;
          this.message("该对象已有新修订。当前绘制与草稿仍使用原版本；保存会检查冲突，取消编辑可读取最新记录。", true);
        }
        else this.loadDraft(saved);
      }
    }
    this.root.hidden = !this.opened || !context.canView || !context.active;
    if (reset) this.renderEditor();
    this.renderSelection(); this.renderStats(); this.renderResults(); this.controls();
  }
  open() {
    if (this.destroyed || !this.context.canView || !this.context.active) return;
    const wasOpen = this.opened; this.opened = true; this.root.hidden = false;
    if (!wasOpen) this.options.onOpenChange?.(true);
    if (!this.draft && this.tab === "machine" && this.resources()[0]) this.select(this.resources()[0].id);
    else this.render();
  }
  close(): boolean {
    if (!this.opened || this.destroyed) return true;
    if (this.busy) { this.message("正在保存，请稍后关闭。", true); return false; }
    return this.requestDiscard(() => this.closeNow(), "关闭面板会放弃尚未保存的配置。已保存的范围仍显示在场景中。");
  }
  private closeNow() { this.scene.stopFallDemo(); this.clearDraft(); this.opened = false; this.root.hidden = true; this.options.onOpenChange?.(false); }
  dispose() {
    if (this.destroyed) return;
    ++this.generation; this.scene.cancelPicking(); this.destroyed = true; clearInterval(this.positioningTimer); this.positioning.clear(); this.events.abort(); this.scene.dispose(); this.root.remove(); this.setPicking(false);
  }
  private setPicking(value: boolean) { if (this.picking !== value) { this.picking = value; this.options.onPickingChange?.(value); } if (!value) this.pickingPurpose = undefined; this.find('[data-role="picking"]').hidden = !value; this.controls(); }
  private message(text: string, error = false) { const node = this.find('[data-role="status"]'); node.textContent = text; node.classList.toggle("is-error", error); }
  private clearDraft() { ++this.generation; this.scene.cancelPicking(); this.scene.setDraft(undefined); this.draft = undefined; this.dirty = false; this.concurrentRevision = false; this.pendingAction = undefined; this.find('[data-role="confirm"]').hidden = true; }
  private requestDiscard(action: () => void, message: string): boolean {
    if (this.busy) return false;
    if (!this.dirty && !this.picking) { action(); return true; }
    this.confirm(() => { this.clearDraft(); action(); }, message, "放弃草稿并继续", this.picking); return false;
  }
  private confirm(action: () => void, message: string, label: string, keepPicking = false) { if (!keepPicking) this.scene.cancelPicking(); this.pendingAction = action; this.find('[data-role="confirm-text"]').textContent = message; this.find('[data-action="confirm"]').textContent = label; this.find('[data-role="confirm"]').hidden = false; this.find('[data-role="confirm"]').scrollIntoView({ block: "nearest" }); }
  private loadDraft(record: RailSafetyRecord) { this.draft = { id: record.id, name: record.name, taskId: record.taskId, revision: record.revision, definition: clone(record.definition) }; this.dirty = false; this.concurrentRevision = false; this.renderEditor(); }
  private select(id: string) {
    this.scene.stopFallDemo();
    this.clearDraft(); this.selectedId = id;
    if (this.tab === "machine") {
      const resource = this.resources().find(record => record.id === id);
      if (resource) {
        const saved = this.records().find(record => record.definition.kind === "machine" && record.definition.resourceId === id);
        if (saved) this.loadDraft(saved);
        else this.draft = { id: crypto.randomUUID(), name: resource.name, definition: { schemaVersion: 1, kind: "machine", resourceId: id, selectedLimitIds: [], inspectionStatus: "unknown" } };
      }
    } else {
      const saved = this.records().find(record => record.id === id && record.definition.kind === this.tab);
      if (saved) this.loadDraft(saved);
    }
    this.scene.setSelected(this.tab, id);
    this.render(); this.message(this.draft ? "修改仅在预览中生效，保存后写入项目。" : "请选择对象，或新增人员与限界。");
  }
  private create() {
    if (!this.editable || this.tab === "machine") return;
    this.requestDiscard(() => {
      this.clearDraft(); this.selectedId = "";
      this.draft = { id: crypto.randomUUID(), name: "", definition: this.tab === "guard"
        ? { schemaVersion: 1, kind: "guard", station: { longitude: NaN, latitude: NaN, height: NaN }, polygon: [], resourceIds: [] }
        : { schemaVersion: 1, kind: "limit", polygon: [] } };
      this.dirty = true; this.render(); this.message(this.tab === "guard" ? "填写姓名，设置站位并绘制责任区域，再关联负责机械。" : "填写限界名称，按顺序点选或输入区域顶点。"); this.find<HTMLInputElement>('[data-field="name"]').focus();
    }, "新增对象会放弃当前未保存的修改。");
  }
  private render() { this.renderSelection(); this.renderEditor(); this.renderDisplay(); this.renderStats(); this.renderResults(); this.controls(); }
  private renderDisplay() {
    const container = this.find('[data-role="display-controls"]'); container.replaceChildren();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-display-tab]")) {
      const selected = button.dataset.displayTab === this.displayTab;
      button.classList.toggle("is-active", selected); button.setAttribute("aria-pressed", String(selected));
    }
    const grid = element("div", "rs-display-grid");
    const select = (label: string, property: string, value: string, options: [string, string][]) => {
      const wrapper = element("label", "rs-label"), input = element("select");
      wrapper.append(element("span", "", label)); input.dataset.display = property;
      for (const [id, title] of options) input.add(new Option(title, id));
      input.value = value; wrapper.append(input); grid.append(wrapper);
    };
    const range = (label: string, property: string, value: number, min: number, max: number, step: number) => {
      const wrapper = element("label", "rs-label rs-display-range"), caption = element("span", "rs-range-caption");
      const output = element("output", "", this.displayValue(property, value)); output.dataset.displayOutput = property;
      caption.append(document.createTextNode(label), output);
      const input = element("input"); input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value); input.dataset.display = property; input.setAttribute("aria-label", label);
      wrapper.append(caption, input); grid.append(wrapper);
    };
    if (this.displayTab === "personnel") {
      select("人员标记", "personnel.representation", this.display.personnel.representation, [["model", "三维防护人员"], ["point", "简洁圆点"]]);
      range("模型比例", "personnel.scale", this.display.personnel.scale, 0.5, 3, 0.1);
      range("模型朝向", "personnel.heading", this.display.personnel.heading, 0, 360, 5);
      container.append(grid, element("p", "rs-help", "人物带安全帽与反光背心，以已保存站位为脚底。模型比例仅为显示大小，不代表实际身高，不改变站位或筛查尺寸。"));
    } else {
      const key = this.displayTab, settings = this.display[key];
      select("依附方式", `${key}.surface`, settings.surface, [["model", "依附模型 + 地形"], ["terrain", "仅贴地形"], ["absolute", "原始高程"]]);
      select("范围样式", `${key}.style`, settings.style, [["fill", "填充 + 边线"], ["outline", "仅边线"]]);
      range("填充浓度", `${key}.opacity`, settings.opacity, 0, 1, 0.01);
      range("边线宽度", `${key}.lineWidth`, settings.lineWidth, 1, 8, 0.5);
      container.append(grid, element("p", "rs-help", "依附模型：覆盖已加载的 3D Tiles 与地形表面；仅贴地形：忽略模型，可能被模型遮挡；原始高程：按原有顶点高程显示。"));
    }
    this.displayControls();
  }
  private displayValue(property: string, value: number) {
    return property.endsWith("opacity") ? `${Math.round(value * 100)}%` : property.endsWith("lineWidth") ? `${value} px` : property.endsWith("scale") ? `${value.toFixed(1)}×` : `${value}°`;
  }
  private displayControls() {
    const available = !this.destroyed && this.context.canView && this.context.active;
    const area = this.displayTab === "personnel" ? undefined : this.display[this.displayTab];
    for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("[data-display], [data-display-tab], [data-action=reset-display]")) {
      const property = control.dataset.display;
      control.disabled = !available
        || !!property?.endsWith("opacity") && area?.style === "outline"
        || (property === "personnel.scale" || property === "personnel.heading") && this.display.personnel.representation === "point";
    }
  }
  private updateDisplay(input: HTMLInputElement | HTMLSelectElement) {
    if (!this.context.canView || !this.context.active || this.destroyed || !input.dataset.display) return;
    const [group, property] = input.dataset.display.split(".");
    if (group !== "guards" && group !== "envelopes" && group !== "personnel") return;
    const next = { ...this.display, [group]: { ...this.display[group], [property]: input.type === "range" ? Number(input.value) : input.value } };
    this.display = normalizeRailSafetyDisplay(next);
    this.applyDisplay(); this.displayControls();
    const output = this.root.querySelector<HTMLOutputElement>(`[data-display-output="${input.dataset.display}"]`);
    if (output) output.value = this.displayValue(input.dataset.display, Number(input.value));
  }
  private applyDisplay() {
    this.scene.setDisplay(this.display);
    const stored = writeRailSafetyDisplay(this.context.projectId, this.context.actorId, this.display);
    this.find('[data-role="display-storage"]').textContent = stored
      ? "调整立即生效，按当前账号和项目记住显示偏好；不改变区域坐标与筛查结果。"
      : "显示已更新；当前浏览器无法记住偏好，刷新后可能恢复先前设置。不改变区域坐标与筛查结果。";
  }
  private renderSelection() {
    const select = this.find<HTMLSelectElement>('[data-role="selection"]'); select.replaceChildren(new Option(this.tab === "machine" ? "选择机械" : this.tab === "guard" ? "选择防护人员" : "选择安全限界", ""));
    const records = this.tab === "machine" ? this.resources() : this.records().filter(record => record.definition.kind === this.tab);
    for (const record of records) select.add(new Option(record.name || "未命名", record.id));
    select.value = this.selectedId;
    this.find('[data-role="select-label"]').textContent = this.tab === "machine" ? "现场机械资源" : this.tab === "guard" ? "防护人员" : "铁路设备安全限界";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tab]")) { const selected = button.dataset.tab === this.tab; button.classList.toggle("is-active", selected); button.setAttribute("aria-pressed", String(selected)); }
  }
  private renderStats() {
    const stats = this.find('[data-role="stats"]'); stats.replaceChildren();
    const resources = this.resources(), assessed = new Map(this.results.map(result => [result.resourceId, result]));
    const risk = resources.filter(resource => ["overlap", "touching"].includes(assessed.get(resource.id)?.status || "")).length;
    const unknown = resources.filter(resource => !assessed.has(resource.id) || assessed.get(resource.id)?.status === "unknown" || assessed.get(resource.id)?.limits.some(limit => limit.status === "unknown")).length;
    for (const [key, label, value, tone] of [["machines", "机械", resources.length, ""], ["guards", "防护人员", this.records().filter(record => record.definition.kind === "guard").length, ""], ["risk", "潜在侵限", risk, risk ? "is-risk" : ""], ["unknown", "待核实", unknown, unknown ? "is-unknown" : ""]] as const) {
      const card = element("div", "rs-stat " + tone); card.dataset.stat = key; card.append(element("strong", "", String(value)), element("span", "", label)); stats.append(card);
    }
    const note = element("p", "rs-stats-note", unknown ? "待核实包括未选限界、配置缺失、计算中；潜在侵限为 0 不表示安全。" : "统计为当前平面几何筛查结果，不代表施工安全批准。"); stats.append(note);
    if (this.positionStates.length) {
      const measured = this.positionStates.filter(({ result }) => result.isAlarm && result.source === "measured").length;
      const simulated = this.positionStates.filter(({ result }) => result.isAlarm && result.source === "simulated").length;
      const pending = this.positionStates.filter(({ result }) => result.state !== "inside" && result.state !== "outside").length;
      const monitor = element("p", "rs-position-summary" + (measured || simulated ? " is-alarm" : ""), `人员定位：实测越界 ${measured} · 模拟越界 ${simulated} · 待核实 ${pending}`); monitor.dataset.role = "position-summary"; monitor.setAttribute("role", "status"); stats.append(monitor);
    }
  }
  private inputField(label: string, field: string, value: string, type = "text") {
    const wrapper = element("label", "rs-label"); wrapper.append(element("span", "", label));
    const input = element("input"); input.type = type; input.dataset.field = field; input.value = value;
    if (type === "number") input.step = "any"; else input.maxLength = 120;
    wrapper.append(input); return wrapper;
  }
  private actionButton(action: string, text: string) { const button = element("button", "", text); button.type = "button"; button.dataset.action = action; return button; }
  private renderEditor() {
    const container = this.find('[data-role="editor"]'); container.replaceChildren();
    this.find('[data-role="priority"]').replaceChildren();
    this.renderMonitor();
    this.renderFallDemo();
    const draft = this.draft;
    if (!draft) { container.append(element("p", "rs-empty", this.tab === "machine" ? "请先在施工机械中建立机械资源并放置模型。" : "新增对象后，在场景中点选站位或绘制区域。")); return; }
    const definition = draft.definition;
    const form = element("fieldset", "rs-form"); form.dataset.role = "form";
    form.append(this.inputField(definition.kind === "guard" ? "防护人员姓名" : definition.kind === "limit" ? "限界名称" : "机械配置名称", "name", draft.name));
    const taskSection = element("section", "rs-task-section"); taskSection.dataset.role = "task-section";
    const taskLabel = element("label", "rs-label"); taskLabel.append(element("span", "", "关联施工任务（可选）"));
    const task = element("select"); task.dataset.field = "taskId"; task.add(new Option("未关联任务", ""));
    const tasks = this.context.tasks.filter(record => record.projectId === this.context.projectId && record.status !== "deleted");
    for (const record of tasks) task.add(new Option(record.name || "未命名任务", record.id));
    if (draft.taskId && !Array.from(task.options).some(option => option.value === draft.taskId)) task.add(new Option("原关联任务不可用", draft.taskId));
    task.value = draft.taskId || ""; taskLabel.append(task); taskSection.append(taskLabel);
    taskSection.append(element("p", "rs-help", "把当前人员、机械或限界归入施工任务，便于按任务管理。机械只能选用未关联任务或同任务的限界；关联任务不会自动选限界、更新进度或产生告警。"));
    if (!tasks.length) {
      taskSection.append(element("p", "rs-warning", "当前项目暂无可见施工任务，可先不关联并保存。任务在“项目统筹平台 → 计划进度 → 任务”中创建。"));
      if (!this.context.canCreateTask) taskSection.append(element("p", "rs-help", "新建任务需要计划进度编辑权限，请联系项目管理员或计划人员。"));
    }
    form.append(taskSection);
    if (definition.kind === "machine") this.renderMachine(form, definition);
    else {
      if (definition.kind === "guard") {
        const station = element("section", "rs-section"); station.append(element("h3", "", "人员站位"));
        const actions = element("div", "rs-actions"); actions.append(this.actionButton("pick-station", "场景点选站位")); station.append(actions);
        const grid = element("div", "rs-position-grid");
        for (const [key, label] of [["longitude", "经度（°）"], ["latitude", "纬度（°）"], ["height", "椭球高（m）"]] as const) grid.append(this.inputField(label, "station." + key, asInput(definition.station[key]), "number"));
        station.append(grid); form.append(station);
        const workArea = element("section", "rs-section rs-work-area"); workArea.dataset.role = "work-area";
        workArea.append(element("h3", "", "人员工作区域 · 定位越界监测"));
        const toggle = element("label", "rs-check"), enabled = element("input"); enabled.type = "checkbox"; enabled.dataset.field = "work-area-enabled"; enabled.checked = !!definition.workArea;
        toggle.append(enabled, document.createTextNode("设置独立工作区域")); workArea.append(toggle);
        workArea.append(element("p", "rs-help", "用于判断人员定位是否离开允许活动范围。下方防护责任区用于核对负责机械，两个区域分别绘制，互不替代。"));
        if (definition.workArea) {
          const actions = element("div", "rs-actions"); actions.append(this.actionButton("draw-work-area", definition.workArea.polygon.length ? "重绘人员工作区" : "绘制人员工作区"), this.actionButton("add-work-vertex", "添加工作区顶点")); workArea.append(actions);
          const fields = element("div", "rs-support-grid"); fields.append(this.inputField("定位设备编号", "workArea.deviceId", definition.workArea.deviceId || ""), this.inputField("定位过期时限（秒）", "workArea.staleAfterSeconds", String(definition.workArea.staleAfterSeconds ?? 30), "number")); workArea.append(fields);
          workArea.append(element("p", "rs-help", "设备编号使用字母、数字、冒号、短横线或下划线。同一项目一台设备绑定一人。保存后启用监测；填写编号不会自动连接真实设备。"));
          const vertices = element("div", "rs-vertices"); vertices.dataset.role = "work-vertices"; workArea.append(vertices);
        }
        form.append(workArea);
      }
      const polygon = element("section", "rs-section"); polygon.append(element("h3", "", definition.kind === "guard" ? "防护责任区 · 核对负责机械" : "安全限界区域"));
      const actions = element("div", "rs-actions"); actions.append(this.actionButton("draw-polygon", definition.polygon.length ? "重新绘制区域" : "场景绘制区域"), this.actionButton("add-vertex", "添加顶点")); polygon.append(actions);
      polygon.append(element("p", "rs-help", "按边界顺序设置至少 3 个顶点，无需重复起点。坐标为 WGS84，经纬度单位 °，椭球高单位 m。"));
      const vertices = element("div", "rs-vertices"); vertices.dataset.role = "vertices"; polygon.append(vertices); form.append(polygon);
      if (definition.kind === "guard") {
        const group = element("section", "rs-section"); group.append(element("h3", "", "负责机械")); this.appendChecks(group, this.resources(), definition.resourceIds, "resource"); form.append(group);
      }
    }
    container.append(form);
    if (!tasks.length && this.options.openTasks) container.append(this.actionButton("open-tasks", this.context.canCreateTask ? "前往任务管理创建" : "查看任务管理"));
    if (definition.kind !== "machine") this.renderVertices();
    if (definition.kind === "guard" && definition.workArea) this.renderVertices("workArea");
    this.controls();
  }
  private renderMachine(form: HTMLElement, definition: Extract<RailSafetyDefinition, { kind: "machine" }>) {
    this.renderLimitSelection(definition);
    const resource = this.resources().find(record => record.id === definition.resourceId), state = readMachineryState(resource?.machinery);
    const overview = element("section", "rs-machine-card");
    overview.append(element("strong", "", state ? ({ crane: "吊机", pile: "桩机", excavator: "挖机" }[state.assetId] || state.assetId) + " · 已设置模型" : "尚未设置有效机械模型"));
    if (state) overview.append(element("p", "rs-help", `整机朝向 ${state.placement.heading.toFixed(1)}° · 站位 ${state.placement.longitude.toFixed(6)}, ${state.placement.latitude.toFixed(6)}`));
    overview.append(this.actionButton("edit-machinery", "调整机械尺寸与姿态")); form.append(overview);
    const inspectionLabel = element("label", "rs-label"); inspectionLabel.append(element("span", "", "报验标记（手动记录）"));
    const inspection = element("select"); inspection.dataset.field = "inspectionStatus";
    for (const [id, label] of [["unknown", "未标记"], ["reported", "已报验"], ["unreported", "未报验"]]) inspection.add(new Option(label, id));
    inspection.value = definition.inspectionStatus || "unknown"; inspectionLabel.append(inspection); form.append(inspectionLabel);
    const support = element("details", "rs-section rs-advanced"); support.append(element("summary", "", "支承尺寸修正（高级）")); support.open = !!definition.support;
    const toggle = element("label", "rs-check"); const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.dataset.field = "support-enabled"; checkbox.checked = !!definition.support; toggle.append(checkbox, document.createTextNode("手动修正支承尺寸")); support.append(toggle);
    support.append(element("p", "rs-help", "默认采用模型支承估计。手动修正仅改变倒伏计算的支承矩形，不改变机械外观。尺寸沿模型源坐标轴输入，需核对实际支承位置。"));
    const grid = element("div", "rs-support-grid"); grid.dataset.role = "support-inputs"; grid.hidden = !definition.support;
    for (const [key, label] of [["length", "模型 X 向长度（m）"], ["width", "模型 Z 向宽度（m）"], ["centerX", "模型 X 向中心偏移（m）"], ["centerZ", "模型 Z 向中心偏移（m）"]] as const) grid.append(this.inputField(label, "support." + key, asInput(definition.support?.[key] ?? (key.startsWith("center") ? 0 : NaN)), "number"));
    support.append(grid, element("p", "rs-help", "模型原始朝向为 0° 时，+X 指向北、+Z 指向东；坐标轴未核定为实际车头朝向。未填写有效尺寸时不生成当前草稿结论。")); form.append(support);
  }
  private availableLimits() {
    return this.records().filter(record => record.definition.kind === "limit" && (!record.taskId || record.taskId === this.draft?.taskId));
  }
  private renderLimitSelection(definition: Extract<RailSafetyDefinition, { kind: "machine" }>) {
    const host = this.find('[data-role="priority"]'); host.replaceChildren();
    const section = element("fieldset", "rs-limit-selection"); section.dataset.role = "limit-selection"; section.tabIndex = -1;
    section.append(element("legend", "", "本机安全限界 · 必选筛查范围"));
    const summary = element("p", "rs-warning"); summary.dataset.role = "limit-summary"; section.append(summary);
    const limits = this.availableLimits();
    this.appendChecks(section, limits, definition.selectedLimitIds, "limit");
    const actions = element("div", "rs-actions");
    const all = this.actionButton("select-all-limits", "选用当前项目全部限界"); all.disabled = !limits.length; all.title = "只选用当前账号可见且与本机任务相容的限界，点击保存后生效";
    actions.append(all, this.actionButton("manage-limits", "绘制 / 管理限界")); section.append(actions);
    section.append(element("p", "rs-help", "列表仅含当前项目可见、未关联任务或同任务限界。显示场景范围不等于选用；勾选后须保存配置。")); host.append(section);
    this.updateLimitSummary();
  }
  private updateLimitSummary() {
    const summary = this.root.querySelector<HTMLElement>('[data-role="limit-summary"]');
    if (!summary || this.draft?.definition.kind !== "machine") return;
    const selected = this.draft.definition.selectedLimitIds, allowed = new Set(this.availableLimits().map(record => record.id));
    summary.textContent = !selected.length ? "尚未选用安全限界：当前结果为待核实，不能据此判定安全。" : selected.some(id => !allowed.has(id)) ? `已选 ${selected.length} 个限界，存在不可用或其他任务引用，请取消失效选项后保存。` : `已选 ${selected.length} 个限界${this.dirty ? " · 尚未保存" : ""}。`;
  }
  private refreshPositioning(forceScene = false) {
    if (this.destroyed) return;
    const records = this.records();
    const states = this.context.active && this.context.canView ? records.filter(record => record.definition.kind === "guard").map(record => ({ guardId: record.id, result: this.positioning.evaluate(record, records) })) : [];
    if (JSON.stringify(states) === JSON.stringify(this.positionStates)) { if (forceScene) this.scene.setGuardPositionStates(states); return; }
    this.positionStates = states; this.scene.setGuardPositionStates(states); this.renderStats(); this.renderMonitor();
  }
  private renderFallDemo() {
    const host = this.find('[data-role="fall-demo"]'); host.replaceChildren(); host.hidden = this.draft?.definition.kind !== "machine";
    if (host.hidden) return;
    host.append(element("h3", "", "机械倾覆演示"));
    const actions = element("div", "rs-actions");
    actions.append(this.actionButton("fall-start", "演示本机倾覆"), this.actionButton("fall-play", "播放"), this.actionButton("fall-reset", "复位"), this.actionButton("fall-stop", "退出演示")); host.append(actions);
    const controls = element("div", "rs-demo-grid"); controls.dataset.role = "fall-controls";
    for (const [property, title, max, step] of [["direction", "期望倾覆方向（北0° / 东90°）", 360, 5], ["angle", "倾倒角度", 90, 1]] as const) {
      const wrapper = element("label", "rs-label"), caption = element("span", "rs-range-caption"), output = element("output"); output.dataset.fallOutput = property; caption.append(document.createTextNode(title), output);
      const input = element("input"); input.type = "range"; input.min = "0"; input.max = String(max); input.step = String(step); input.dataset.fall = property; input.setAttribute("aria-label", title); wrapper.append(caption, input); controls.append(wrapper);
    }
    host.append(controls);
    const status = element("p", "rs-help"); status.dataset.role = "fall-status"; status.setAttribute("role", "status"); host.append(status);
    host.append(element("p", "rs-help", "仅演示绕支承边的刚体运动，不模拟首次触地或动力学；不改变已保存机械姿态与侵限筛查结果。"));
    this.updateFallDemo();
  }
  private updateFallDemo() {
    const host = this.find('[data-role="fall-demo"]');
    if (host.hidden || !host.children.length) return;
    const state = this.fallDemo, machine = this.draft?.definition.kind === "machine" ? this.draft.definition : undefined;
    const same = !!machine && state?.resourceId === machine.resourceId, active = !!same && !!state?.active, loading = !!same && !!state?.loading;
    const available = this.context.canView && this.context.active && !this.busy && !this.picking;
    const start = this.find<HTMLButtonElement>('[data-action="fall-start"]'); start.hidden = active; start.disabled = !available || loading; start.textContent = loading ? "正在准备演示…" : "演示本机倾覆";
    for (const action of ["fall-play", "fall-reset", "fall-stop"]) { const button = this.find<HTMLButtonElement>(`[data-action="${action}"]`); button.hidden = !active && !loading; button.disabled = !available || action !== "fall-stop" && !active; }
    this.find('[data-action="fall-play"]').textContent = state?.playing ? "暂停" : "播放";
    this.find('[data-role="fall-controls"]').hidden = !active;
    for (const property of ["direction", "angle"] as const) {
      const input = this.find<HTMLInputElement>(`[data-fall="${property}"]`), value = state?.[property] ?? 0;
      input.value = String(value); input.disabled = !available || !active;
      this.find<HTMLOutputElement>(`[data-fall-output="${property}"]`).value = `${Math.round(value)}°`;
    }
    this.find('[data-role="fall-status"]').textContent = state?.error ? state.error : active ? `${state?.playing ? "播放中" : "已暂停"}${Number.isFinite(state?.actualDirection) ? ` · 实际支承边方向 ${Math.round(state!.actualDirection!)}°` : ""}` : "选择当前机械后启动，可播放、暂停和手动拖动角度。";
  }
  private renderMonitor() {
    const host = this.find('[data-role="monitor"]'); host.replaceChildren(); host.hidden = this.draft?.definition.kind !== "guard";
    if (host.hidden || !this.draft) return;
    const saved = this.existing(), result = this.positionStates.find(state => state.guardId === this.draft!.id)?.result;
    const title = element("div", "rs-monitor-heading"); title.append(element("h3", "", "人员定位监测"), element("span", "rs-badge", result?.source === "simulated" ? "模拟样本" : result?.source === "measured" ? "实测来源样本" : "无实时样本")); host.append(title);
    const labels = { inside: "工作区内", outside: "已离开工作区", uncertain: "精度不足 · 待核实", stale: "定位过期", unconfigured: "尚未配置", "no-fix": "等待定位" };
    const status = element("p", "rs-monitor-status", result ? labels[result.state] : "请先保存人员工作区与设备绑定"); status.dataset.role = "position-status"; status.dataset.state = result?.state || "unconfigured"; status.setAttribute("role", result?.isAlarm ? "alert" : "status"); host.append(status);
    host.classList.toggle("is-alarm", !!result?.isAlarm);
    if (result) host.append(element("p", "rs-help", result.reason));
    if (result?.sample) {
      const sample = result.sample;
      host.append(element("p", "rs-help", `设备 ${sample.deviceId} · ${new Date(sample.timestamp).toLocaleTimeString("zh-CN", { hour12: false })} · 水平精度 ±${sample.accuracyMeters.toFixed(1)} m`));
    }
    const actions = element("div", "rs-actions"); const simulate = this.actionButton("simulate-position", "点选模拟定位"); simulate.dataset.simulation = "true"; actions.append(simulate); host.append(actions);
    if (result?.source === "simulated") actions.append(this.actionButton("clear-simulation", "清除模拟样本"));
    const configured = saved?.definition.kind === "guard" && !!saved.definition.workArea?.deviceId && saved.definition.workArea.polygon.length >= 3;
    if (!configured) host.append(element("p", "rs-warning", "先绘制独立工作区域、填写设备编号并保存，才能进行定位模拟。"));
    if (this.dirty) host.append(element("p", "rs-warning", "工作区或人员配置存在未保存修改，监测继续使用已保存边界；保存后才切换监测范围。"));
    if (result?.source === "measured") host.append(element("p", "rs-warning", "已有实测定位，模拟不会覆盖该设备的实测样本。"));
    host.append(element("p", "rs-help", "模拟点仅在当前会话显示，不写入人员站位、不连接真实设备。实测标签仅标识适配器来源；实际设备接入需另行完成。"));
    simulate.disabled = !configured || result?.source === "measured" || !this.context.canView || !this.context.active || this.busy || this.picking;
  }
  private simulatePosition() {
    if (this.busy || this.picking || !this.context.canView || !this.context.active || this.draft?.definition.kind !== "guard") return;
    const saved = this.existing();
    if (saved?.definition.kind !== "guard" || !saved.definition.workArea?.deviceId || this.positioning.getSample(this.context.projectId, saved.definition.workArea.deviceId)?.source === "measured") return;
    const id = saved.id, revision = saved.revision, deviceId = saved.definition.workArea.deviceId, generation = this.generation;
    this.scene.stopFallDemo();
    this.scene.beginPickPoint(point => {
      if (this.destroyed || this.generation !== generation || this.draft?.id !== id || this.existing()?.revision !== revision) return;
      try {
        this.ingestPositionSample({ projectId: this.context.projectId, deviceId, coordinateSystem: "WGS84", position: { longitude: point.longitude, latitude: point.latitude, height: point.height }, timestamp: new Date().toISOString(), accuracyMeters: 0.5, source: "simulated" });
        const result = this.positionStates.find(state => state.guardId === id)?.result;
        this.message(`模拟定位：${result?.reason || "样本已接收"}。仅为本地测试。`, !!result?.isAlarm);
      } catch (error) { this.message("模拟定位未接收：" + errorText(error), true); }
    });
    this.pickingPurpose = "simulation";
    this.find('[data-role="pick-message"]').textContent = "模拟定位：点选人员当前位置，仅用于本地测试，不改变已保存站位。模拟水平精度为 0.5 m；按 Esc 取消。";
    this.find('[data-role="picking"]').scrollIntoView({ block: "nearest" });
  }
  private appendChecks(group: HTMLElement, records: readonly ManagementRecord[], selectedIds: string[], type: "resource" | "limit") {
    const list = element("div", "rs-check-list");
    if (!records.length) list.append(element("p", "rs-help", type === "limit" ? "暂无限界，请先在“安全限界”中绘制。" : "暂无机械资源，请先建立机械。"));
    for (const record of records) {
      const label = element("label", "rs-check"), checkbox = element("input"); checkbox.type = "checkbox"; checkbox.dataset.reference = type; checkbox.value = record.id; checkbox.checked = selectedIds.includes(record.id);
      label.append(checkbox, document.createTextNode(record.name || record.id)); list.append(label);
    }
    for (const id of selectedIds.filter(id => !records.some(record => record.id === id))) {
      const label = element("label", "rs-check is-missing"), checkbox = element("input"); checkbox.type = "checkbox"; checkbox.dataset.reference = type; checkbox.value = id; checkbox.checked = true;
      label.append(checkbox, document.createTextNode("原引用已删除、不可见或不属于当前任务 · " + id)); list.append(label);
    }
    group.append(list);
  }
  private renderVertices(target: "responsibility" | "workArea" = "responsibility") {
    if (!this.draft || this.draft.definition.kind === "machine") return;
    const polygon = target === "workArea" && this.draft.definition.kind === "guard" ? this.draft.definition.workArea?.polygon : this.draft.definition.polygon;
    if (!polygon) return;
    const container = this.find(`[data-role="${target === "workArea" ? "work-vertices" : "vertices"}"]`); container.replaceChildren();
    polygon.forEach((point, index) => {
      const row = element("div", "rs-vertex"); row.dataset.vertex = String(index); row.append(element("span", "rs-vertex-number", String(index + 1)));
      for (const [key, label] of [["longitude", "经度"], ["latitude", "纬度"], ["height", "椭球高"]] as const) {
        const input = element("input"); input.type = "number"; input.step = "any"; input.dataset.coordinate = key; input.dataset.vertexIndex = String(index); input.dataset.polygon = target; input.value = asInput(point[key]); input.placeholder = label; input.setAttribute("aria-label", `${target === "workArea" ? "工作区" : "责任区或限界"}顶点 ${index + 1} ${label}`); row.append(input);
      }
      const remove = this.actionButton(target === "workArea" ? "remove-work-vertex" : "remove-vertex", "×"); remove.dataset.index = String(index); remove.setAttribute("aria-label", `删除${target === "workArea" ? "工作区" : ""}顶点 ${index + 1}`); row.append(remove); container.append(row);
    });
    if (!polygon.length) container.append(element("p", "rs-empty", "还没有区域顶点。"));
    this.controls();
  }
  private renderResults() {
    const container = this.find('[data-role="results"]'); container.replaceChildren();
    if (!this.context.canView) return;
    let results = this.results;
    if (this.tab === "machine" && this.selectedId) results = results.filter(result => result.resourceId === this.selectedId);
    else if (this.tab === "guard" && this.draft?.definition.kind === "guard") results = results.filter(result => this.draft!.definition.kind === "guard" && this.draft!.definition.resourceIds.includes(result.resourceId));
    else if (this.tab === "limit" && this.draft) results = results.filter(result => result.limits.some(limit => limit.id === this.draft!.id));
    container.append(element("h3", "", "倾覆落点外包 · 几何筛查"));
    if (!results.length) { container.append(element("p", "rs-help", "暂无当前对象的筛查结果。先放置机械并选用限界。")); return; }
    for (const result of results) {
      const card = element("article", "rs-result rs-result-" + result.status); card.dataset.resourceId = result.resourceId; card.dataset.status = result.status;
      const heading = element("div", "rs-result-heading");
      const locate = this.actionButton("locate-result", "定位机械"); locate.dataset.resourceId = result.resourceId;
      heading.append(element("strong", "", result.resourceName), element("span", "rs-badge", result.draft ? "草稿预览" : "当前配置"), locate); card.append(heading);
      card.append(element("p", "rs-result-label", result.label), element("p", "rs-help", result.message));
      if (this.tab === "machine" && this.draft?.definition.kind === "machine" && !this.draft.definition.selectedLimitIds.length) card.append(this.actionButton("choose-limits", "选择安全限界"));
      if (Number.isFinite(result.maxDistanceMeters)) card.append(element("p", "rs-measure", `采样最远落点距站位（估计） ${result.maxDistanceMeters!.toFixed(2)} m`));
      if (Number.isFinite(result.nearestDistanceMeters)) card.append(element("p", "rs-measure", `限界最近距离 ${result.nearestDistanceMeters!.toFixed(2)} m`));
      for (const limit of result.limits) {
        const line = element("div", "rs-result-line"); line.append(element("span", "", limit.name), element("span", "", ({ unknown: "待核实", overlap: "潜在侵限", touching: "接触边界", clear: "未相交" }[limit.status]) + (Number.isFinite(limit.distanceMeters) ? ` · ${limit.distanceMeters!.toFixed(2)} m` : ""))); card.append(line);
        if (limit.message) card.append(element("p", "rs-help", limit.message));
      }
      const guardNames = result.guards.map(guard => guard.name + (!guard.known ? "（无法核对）" : guard.containsStation ? "（站位在责任区内）" : "（站位不在责任区内）"));
      card.append(element("p", "rs-help", guardNames.length ? "关联防护：" + guardNames.join("、") : "未关联防护人员。"));
      for (const guard of result.guards.filter(item => !item.known)) if (guard.message) card.append(element("p", "rs-warning", guard.name + "：" + guard.message));
      if (result.warnings.length || result.supportSource) {
        const details = element("details", "rs-result-details"); details.append(element("summary", "", "计算依据与说明"));
        if (result.supportSource) details.append(element("p", "rs-help", "支承来源：" + ({ "model-outriggers": "模型支腿", "model-base-estimate": "模型底部估计", "user-defined": "用户修正" }[result.supportSource] || result.supportSource)));
        for (const warning of result.warnings) details.append(element("p", "rs-warning", warning));
        card.append(details);
      }
      container.append(card);
    }
  }
  private controls() {
    this.displayControls();
    this.updateFallDemo();
    const write = this.editable && !this.busy && !this.picking;
    const form = this.root.querySelector<HTMLFieldSetElement>('[data-role="form"]'); if (form) form.disabled = !write;
    const limits = this.root.querySelector<HTMLFieldSetElement>('[data-role="limit-selection"]'); if (limits) limits.disabled = !write;
    const allLimits = this.root.querySelector<HTMLButtonElement>('[data-action="select-all-limits"]'); if (allLimits) allLimits.disabled = !write || !this.availableLimits().length;
    const simulate = this.root.querySelector<HTMLButtonElement>('[data-action="simulate-position"]'), saved = this.existing();
    if (simulate) simulate.disabled = !this.context.canView || !this.context.active || this.busy || this.picking || saved?.definition.kind !== "guard" || !saved.definition.workArea?.deviceId || saved.definition.workArea.polygon.length < 3 || this.positioning.getSample(this.context.projectId, saved.definition.workArea.deviceId)?.source === "measured";
    const clearSimulation = this.root.querySelector<HTMLButtonElement>('[data-action="clear-simulation"]'); if (clearSimulation) clearSimulation.disabled = this.busy || this.picking || !this.context.canView || !this.context.active;
    this.find('[data-role="readonly"]').hidden = this.context.canEdit;
    this.find<HTMLSelectElement>('[data-role="selection"]').disabled = this.busy || this.picking;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.disabled = this.busy || this.picking;
    const newButton = this.find<HTMLButtonElement>('[data-action="new"]'); newButton.hidden = this.tab === "machine"; newButton.disabled = !write;
    this.find<HTMLButtonElement>('[data-action="locate"]').disabled = !this.draft || this.busy || this.picking;
    this.find<HTMLButtonElement>('[data-action="save"]').disabled = !write || !this.draft || !this.dirty;
    this.find('[data-action="save"]').textContent = this.busy ? "正在保存…" : "保存配置";
    this.find<HTMLButtonElement>('[data-action="cancel"]').disabled = this.busy || (!this.draft && !this.picking);
    this.find<HTMLButtonElement>('[data-action="remove"]').disabled = !write || this.draft?.revision === undefined;
    this.root.dataset.dirty = String(this.dirty || this.picking); this.root.dataset.tab = this.tab; this.root.dataset.busy = String(this.busy);
    // Viewing existing geometry remains available for readers; machinery editing needs write access.
    const edit = this.root.querySelector<HTMLButtonElement>('[data-action="edit-machinery"]'); if (edit) edit.disabled = !write;
  }
  private input(input: HTMLInputElement) {
    if (input.dataset.fall) { if (this.context.canView && this.context.active && !this.busy && !this.picking) this.scene.setFallDemo({ [input.dataset.fall]: Number(input.value), playing: false }); return; }
    if (input.dataset.display) { if (input.type === "range") this.updateDisplay(input); return; }
    if (!this.editable || this.busy || this.picking || !this.draft) return;
    const field = input.dataset.field, definition = this.draft.definition;
    if (field === "name") this.draft.name = input.value;
    else if (field?.startsWith("station.") && definition.kind === "guard") definition.station[field.slice(8) as keyof RailSafetyPosition] = numeric(input.value);
    else if (field === "workArea.deviceId" && definition.kind === "guard" && definition.workArea) definition.workArea.deviceId = input.value.trim() || undefined;
    else if (field === "workArea.staleAfterSeconds" && definition.kind === "guard" && definition.workArea) definition.workArea.staleAfterSeconds = numeric(input.value);
    else if (field?.startsWith("support.") && definition.kind === "machine" && definition.support) definition.support[field.slice(8) as keyof typeof definition.support] = numeric(input.value);
    else if (input.dataset.coordinate && input.dataset.vertexIndex !== undefined && definition.kind !== "machine") {
      const polygon = input.dataset.polygon === "workArea" && definition.kind === "guard" ? definition.workArea?.polygon : definition.polygon;
      const point = polygon?.[Number(input.dataset.vertexIndex)]; if (!point) return;
      point[input.dataset.coordinate as keyof RailSafetyPosition] = numeric(input.value);
    } else return;
    this.changed();
  }
  private change(input: HTMLInputElement | HTMLSelectElement) {
    if (input.dataset.display) { if (input.type !== "range") this.updateDisplay(input); return; }
    if (input.dataset.layer && this.context.canView) {
      this.scene.setLayers({ [input.dataset.layer]: (input as HTMLInputElement).checked }); return;
    }
    if (input.dataset.role === "selection") {
      const id = input.value;
      if (!this.requestDiscard(() => this.select(id), "切换对象会放弃当前未保存修改。")) input.value = this.selectedId;
      return;
    }
    if (!this.editable || this.busy || this.picking || !this.draft) return;
    const definition = this.draft.definition;
    if (input.dataset.field === "taskId") { this.draft.taskId = input.value || undefined; if (definition.kind === "machine") this.renderLimitSelection(definition); }
    else if (input.dataset.field === "inspectionStatus" && definition.kind === "machine") definition.inspectionStatus = input.value as "unknown" | "reported" | "unreported";
    else if (input.dataset.field === "work-area-enabled" && definition.kind === "guard") {
      definition.workArea = (input as HTMLInputElement).checked ? { polygon: [], staleAfterSeconds: 30 } : undefined; this.renderEditor();
    }
    else if (input.dataset.field === "support-enabled" && definition.kind === "machine") {
      definition.support = (input as HTMLInputElement).checked ? { length: NaN, width: NaN, centerX: 0, centerZ: 0 } : undefined;
      this.renderEditor();
    } else if (input.dataset.reference) {
      const selected = Array.from(this.root.querySelectorAll<HTMLInputElement>(`[data-reference="${input.dataset.reference}"]:checked`)).map(node => node.value);
      if (definition.kind === "machine" && input.dataset.reference === "limit") definition.selectedLimitIds = selected;
      else if (definition.kind === "guard" && input.dataset.reference === "resource") definition.resourceIds = selected;
      else return;
    } else return;
    this.changed();
  }
  private changed() {
    if (!this.draft) return;
    this.dirty = true; this.scene.setDraft({ id: this.draft.id, name: this.draft.name || "未命名草稿", taskId: this.draft.taskId, definition: clone(this.draft.definition) }); this.updateLimitSummary(); this.renderMonitor(); this.controls();
  }
  private action(action: string, button: HTMLButtonElement) {
    if (action.startsWith("display-")) {
      const tab = action.slice(8);
      if (this.context.canView && (tab === "guards" || tab === "envelopes" || tab === "personnel")) { this.displayTab = tab; this.renderDisplay(); }
      return;
    }
    if (action === "reset-display") {
      if (this.context.canView && this.context.active) { this.display = normalizeRailSafetyDisplay(undefined); this.applyDisplay(); this.renderDisplay(); }
      return;
    }
    if (action === "close") { this.close(); return; }
    if (action === "keep") { this.pendingAction = undefined; this.find('[data-role="confirm"]').hidden = true; return; }
    if (action === "confirm") { const pending = this.pendingAction; this.pendingAction = undefined; this.find('[data-role="confirm"]').hidden = true; pending?.(); return; }
    if (action === "cancel-pick") { this.scene.cancelPicking(); return; }
    if (action === "cancel" && this.picking) { this.scene.cancelPicking(); return; }
    if (action === "undo-point") { this.scene.undoPoint(); return; }
    if (action === "finish-polygon") { this.scene.finishPolygon(); return; }
    if (this.busy || this.picking) return;
    if (action.startsWith("fall-") && this.context.canView && this.context.active) {
      if (action === "fall-start" && this.draft?.definition.kind === "machine") void this.scene.startFallDemo(this.draft.definition.resourceId);
      else if (action === "fall-play") this.scene.setFallDemo({ playing: !this.fallDemo?.playing });
      else if (action === "fall-reset") this.scene.resetFallDemo();
      else if (action === "fall-stop") this.scene.stopFallDemo();
      return;
    }
    if (action === "simulate-position") { this.simulatePosition(); return; }
    if (action === "clear-simulation") {
      const saved = this.existing();
      if (this.context.canView && this.context.active && saved?.definition.kind === "guard" && saved.definition.workArea?.deviceId) { this.positioning.removeSample(this.context.projectId, saved.definition.workArea.deviceId, "simulated"); this.refreshPositioning(); this.message("模拟样本已清除，等待新的定位数据。"); }
      return;
    }
    if (action === "open-tasks" && this.options.openTasks) { this.requestDiscard(() => { this.closeNow(); this.options.openTasks?.(); }, "打开任务管理会关闭当前面板，请先保存配置，或放弃当前草稿后继续。"); return; }
    if (action === "choose-limits") { const group = this.root.querySelector<HTMLElement>('[data-role="limit-selection"]'); group?.scrollIntoView({ block: "start", behavior: "smooth" }); (group?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? group)?.focus(); return; }
    if (action === "manage-limits") { this.requestDiscard(() => { this.tab = "limit"; this.select(this.records().find(record => record.definition.kind === "limit")?.id || ""); }, "管理限界会切换当前机械，请先保存配置，或放弃当前草稿后继续。"); return; }
    if (action.startsWith("tab-")) { const tab = action.slice(4) as Tab; this.requestDiscard(() => { this.tab = tab; this.displayTab = tab === "guard" ? "guards" : "envelopes"; this.select(tab === "machine" ? this.resources()[0]?.id || "" : this.records().find(record => record.definition.kind === tab)?.id || ""); }, "切换分类会放弃当前未保存修改。"); return; }
    if (action === "locate" && this.draft) { void this.scene.flyTo(this.draft.definition.kind === "machine" ? this.draft.definition.resourceId : this.draft.id); return; }
    if (action === "locate-result" && button.dataset.resourceId) { void this.scene.flyTo(button.dataset.resourceId); return; }
    if (action === "cancel") { this.requestDiscard(() => this.select(this.selectedId), "取消编辑会恢复已保存配置。" ); return; }
    if (!this.editable) return;
    if (action === "select-all-limits" && this.draft?.definition.kind === "machine") {
      const selected = [...new Set([...this.draft.definition.selectedLimitIds, ...this.availableLimits().map(record => record.id)])];
      if (selected.length > RAIL_SAFETY_MAX_REFERENCES) { this.message(`本机最多选用 ${RAIL_SAFETY_MAX_REFERENCES} 个限界，请按实际施工范围逐项勾选。`, true); return; }
      this.draft.definition.selectedLimitIds = selected;
      this.changed(); this.renderLimitSelection(this.draft.definition); this.controls(); this.message("已在草稿中选用当前项目所有相容限界，请核对后点击保存配置。不可用的原引用需手动取消。" ); return;
    }
    if (action === "new") { this.create(); return; }
    if (action === "save") { void this.save(); return; }
    if (action === "remove") { this.confirm(() => { void this.remove(); }, "删除后该对象将不再参与当前配置。关联引用会显示待核实，历史审计记录保留。", "确认删除"); return; }
    if (!this.draft) return;
    const definition = this.draft.definition;
    if (action === "edit-machinery" && definition.kind === "machine") { const id = definition.resourceId; this.requestDiscard(() => { this.closeNow(); this.options.editMachinery(id); }, "打开机械参数会放弃当前未保存的管控配置。请先保存，或确认放弃。"); }
    else if (action === "pick-station" && definition.kind === "guard") {
      const id = this.draft.id, generation = this.generation;
      this.scene.beginPickPoint(point => { if (!this.editable || this.generation !== generation || this.draft?.id !== id || this.draft.definition.kind !== "guard") return; this.draft.definition.station = { longitude: point.longitude, latitude: point.latitude, height: point.height }; this.renderEditor(); this.changed(); this.message("人员站位已点选；保存后生效。"); });
    } else if (action === "draw-work-area" && definition.kind === "guard" && definition.workArea) {
      const id = this.draft.id, generation = this.generation;
      this.scene.beginPolygon(points => { if (!this.editable || this.generation !== generation || this.draft?.id !== id || this.draft.definition.kind !== "guard" || !this.draft.definition.workArea) return; this.draft.definition.workArea.polygon = points.map(point => ({ longitude: point.longitude, latitude: point.latitude, height: point.height })); this.renderVertices("workArea"); this.changed(); this.message("人员工作区域已绘制；保存后用于定位越界监测，防护责任区保持独立。" ); });
      this.pickingPurpose = "workArea"; this.find('[data-role="pick-message"]').textContent = "绘制人员工作区域：沿允许活动范围边界依次点选至少 3 个顶点。";
      this.find('[data-role="picking"]').scrollIntoView({ block: "nearest" });
    } else if (action === "add-work-vertex" && definition.kind === "guard" && definition.workArea) {
      if (definition.workArea.polygon.length >= RAIL_SAFETY_MAX_VERTICES) { this.message(`一个工作区域最多 ${RAIL_SAFETY_MAX_VERTICES} 个顶点。`, true); return; }
      definition.workArea.polygon.push({ longitude: NaN, latitude: NaN, height: NaN }); this.renderVertices("workArea"); this.changed();
    } else if (action === "remove-work-vertex" && definition.kind === "guard" && definition.workArea) {
      definition.workArea.polygon.splice(Number(button.dataset.index), 1); this.renderVertices("workArea"); this.changed();
    } else if (action === "draw-polygon" && definition.kind !== "machine") {
      const id = this.draft.id, generation = this.generation;
      this.scene.beginPolygon(points => { if (!this.editable || this.generation !== generation || this.draft?.id !== id || this.draft.definition.kind === "machine") return; this.draft.definition.polygon = points.map(point => ({ longitude: point.longitude, latitude: point.latitude, height: point.height })); this.renderVertices(); this.changed(); this.message("区域已绘制；保存后生效。"); });
    } else if (action === "add-vertex" && definition.kind !== "machine") {
      if (definition.polygon.length >= RAIL_SAFETY_MAX_VERTICES) { this.message(`一个区域最多 ${RAIL_SAFETY_MAX_VERTICES} 个顶点。`, true); return; }
      definition.polygon.push({ longitude: NaN, latitude: NaN, height: NaN }); this.renderVertices(); this.changed();
    } else if (action === "remove-vertex" && definition.kind !== "machine") { definition.polygon.splice(Number(button.dataset.index), 1); this.renderVertices(); this.changed(); }
  }
  private validateDraft(): string | undefined {
    const draft = this.draft; if (!draft) return "请选择对象。";
    if (!draft.name.trim()) return "请填写对象名称。";
    if (draft.name.trim().length > 120) return "名称最多 120 个字符。";
    const definition = draft.definition;
    if (definition.kind !== "machine") {
      if (definition.kind === "guard" && !positionValid(definition.station)) return "请设置有效的人员站位，经纬度和椭球高都需要填写。";
      if (definition.kind === "guard" && definition.workArea) {
        try { validateRailSafetyWorkArea(definition.workArea); } catch (error) { return errorText(error); }
        if (definition.workArea.deviceId && this.records().some(record => record.id !== draft.id && record.definition.kind === "guard" && record.definition.workArea?.deviceId === definition.workArea!.deviceId)) return "该定位设备已绑定本项目其他人员，请使用独立设备编号。";
      }
      if (definition.polygon.length < 3 || definition.polygon.length > RAIL_SAFETY_MAX_VERTICES) return `区域需要 3 至 ${RAIL_SAFETY_MAX_VERTICES} 个顶点。`;
      if (!definition.polygon.every(positionValid)) return "请完整填写每个区域顶点的有效经纬度和椭球高。";
    } else if (definition.support) {
      if (!Object.values(definition.support).every(Number.isFinite) || definition.support.length <= 0 || definition.support.width <= 0) return "支承长度、宽度必须为有效正数，中心偏移必须填写数值。";
    }
    return;
  }
  private async save() {
    if (!this.editable || this.busy || !this.draft || !this.dirty) return;
    const error = this.validateDraft(); if (error) { this.message(error, true); return; }
    const draft = clone(this.draft), generation = ++this.generation;
    this.scene.cancelPicking(); this.busy = true; this.controls(); this.message("正在保存当前配置…");
    try {
      await this.options.save(draft.id, draft.name.trim(), draft.definition, draft.revision, draft.taskId);
      if (this.destroyed || generation !== this.generation || !this.context.canEdit) return;
      this.dirty = false; this.scene.setDraft(undefined);
      const saved = this.existing(draft.id);
      if (saved) this.loadDraft(saved); else this.draft = { ...draft, name: draft.name.trim(), revision: (draft.revision ?? 0) + 1 };
      this.selectedId = draft.definition.kind === "machine" ? draft.definition.resourceId : draft.id;
      this.renderSelection(); this.renderEditor(); this.message("配置已保存。筛查使用当前机械姿态和已选限界。" );
    } catch (error) { if (!this.destroyed && generation === this.generation) this.message("保存失败：" + errorText(error), true); }
    finally { if (!this.destroyed && generation === this.generation) { this.busy = false; this.controls(); } }
  }
  private async remove() {
    if (!this.editable || this.busy || !this.draft || this.draft.revision === undefined) return;
    const id = this.draft.id, revision = this.draft.revision, generation = ++this.generation;
    this.busy = true; this.controls(); this.message("正在删除…");
    try {
      await this.options.remove(id, revision);
      if (this.destroyed || generation !== this.generation) return;
      this.scene.setDraft(undefined); this.draft = undefined; this.dirty = false; this.selectedId = "";
      this.render(); this.message("对象已删除。原关联对象需要重新核对。" );
    } catch (error) { if (!this.destroyed && generation === this.generation) this.message("删除失败：" + errorText(error), true); }
    finally { if (!this.destroyed && generation === this.generation) { this.busy = false; this.controls(); } }
  }
}
