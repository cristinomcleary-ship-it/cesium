import type { Cartesian2, Viewer } from "cesium";
import type { ManagementRecord } from "./managementTypes";
import type { MachineryPlacementPick, MachineryState } from "./machineryScene";
import { readMachineryState } from "./machineryScene";
import type { RailSafetyDefinition, RailSafetyPosition, RailSafetyPositionSample, RailSafetyPositioningResult, RailSafetyRecord } from "./railSafetyTypes";
import { RAIL_SAFETY_MAX_REFERENCES, RAIL_SAFETY_MAX_VERTICES } from "./railSafetyTypes";
import { RailSafetyScene, type RailSafetyMachineResult } from "./railSafetyScene";
import type { RailSafetyFallDemoSnapshot } from "./railSafetyFallDemo";
import { normalizeRailSafetyDisplay, readRailSafetyDisplay, writeRailSafetyDisplay, type RailSafetyDisplaySettings } from "./railSafetyDisplay";
import { RailSafetyPositioningStore, validateRailSafetyPositionSample } from "./railSafetyPositioning";
import { RailSafetyPositioningClient, type RailSafetyPositioningClientStatus } from "./railSafetyPositioningClient";
import type { RailSafetyPositioningSnapshot } from "./railSafetyPositioningTransport";
import { validateRailSafetyDefinition, validateRailSafetyWorkArea } from "./railSafetyValidation";
import { buildRailSafetyTaskView, exportRailSafetyTaskCsv } from "./railSafetyTaskView";
import { renderRailSafetyOperations, type RailSafetyIssueFilter } from "./railSafetyOperationsView";
import { RAIL_SAFETY_RISK_METHOD, RAIL_SAFETY_RISK_CLOSED_STATUSES, type RailSafetyRiskReportPayload, type RailSafetyRiskSnapshot } from "./railSafetyRiskTypes";
import "./railSafetyPanel.css";

type Tab = "machine" | "guard" | "limit";
type Draft = { id: string; name: string; taskId?: string; revision?: number; definition: RailSafetyDefinition };
type FallDemoState = RailSafetyFallDemoSnapshot;
export type RailSafetyPanelContext = {
  projectId: string; actorId?: string; records: readonly ManagementRecord[];
  resources: readonly ManagementRecord[]; tasks: readonly ManagementRecord[];
  canEdit: boolean; canView: boolean; active: boolean;
  canCreateTask?: boolean;
  canReportRisk?: boolean;
  issues?: readonly ManagementRecord[];
  allocations?: readonly ManagementRecord[];
};
export type RailSafetyPanelOptions = {
  viewer: Viewer; host: HTMLElement; workbenchHost?: HTMLElement;
  onDisplayChange?: () => void;
  onDisplayManager?: () => void;
  save: (id: string, name: string, definition: RailSafetyDefinition, revision?: number, taskId?: string) => Promise<void>;
  remove: (id: string, revision: number) => Promise<void>;
  editMachinery: (resourceId: string) => void;
  openTasks?: (taskId?: string) => void;
  openIssue?: (issueId: string) => void;
  reportRisk?: (payload: RailSafetyRiskReportPayload) => Promise<void>;
  pickPosition?: (position: Cartesian2) => MachineryPlacementPick | undefined;
  onOpenChange?: (open: boolean) => void;
  onPickingChange?: (picking: boolean) => void;
  /** The host owns field selection; picking a scene object must not silently open another editor. */
  onSelectObject?: (kind: Tab, id: string) => void;
  onSelectionChange?: (kind: Tab, id: string) => void;
};
export type RailSafetyFieldMachine = RailSafetyMachineResult & { modelReady: boolean; configurationReady: boolean; preparationReason: string };
export type RailSafetyFieldSummary = {
  projectId: string; pending: boolean; selectedResourceId?: string; machines: RailSafetyFieldMachine[];
  machineCount: number; riskCount: number; unknownCount: number; clearCount: number;
  guardCount: number; limitCount: number;
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
  private displayTab: Exclude<keyof RailSafetyDisplaySettings, "colors" | "effects"> = "envelopes";
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
  private readonly positioningClient: RailSafetyPositioningClient;
  private positioningConnection: RailSafetyPositioningClientStatus = { state: "idle", message: "保存人员工作区及设备绑定后读取定位状态" };
  private positioningSnapshot?: RailSafetyPositioningSnapshot;
  private positioningSampleError = "";
  private positionBindings = new Map<string, string>();
  private readonly networkPositionDevices = new Set<string>();
  private positionStates: Array<{ guardId: string; result: RailSafetyPositioningResult }> = [];
  private readonly positioningTimer: ReturnType<typeof setInterval>;
  private pickingPurpose?: "simulation" | "workArea";
  private fallDemo?: FallDemoState;
  private pendingAction?: () => void;
  private workspaceView: "objects" | "tasks" | "issues" = "objects";
  private taskScopeKey = "";
  private issueFilter: RailSafetyIssueFilter = "open";
  private managementHost?: HTMLElement;

  constructor(private readonly options: RailSafetyPanelOptions) {
    this.root.hidden = true; this.root.setAttribute("aria-label", "邻近营业线施工管控");
    this.root.innerHTML = `
      <header class="rs-heading"><div><span class="rs-eyebrow">现场布置 · 空间筛查</span><h2>邻近营业线施工</h2></div><button type="button" data-action="close" aria-label="关闭施工管控">关闭</button></header>
      <div class="rs-stats" data-role="stats"></div>
      <nav class="rs-workspace-tabs" aria-label="管控工作台"><button type="button" data-action="workspace-objects" data-workspace-view="objects">对象配置</button><button type="button" data-action="workspace-tasks" data-workspace-view="tasks">任务总览</button><button type="button" data-action="workspace-issues" data-workspace-view="issues">风险处置</button></nav>
      <nav class="rs-tabs" aria-label="施工管控分类"><button type="button" data-action="tab-machine" data-tab="machine">机械</button><button type="button" data-action="tab-guard" data-tab="guard">防护人员</button><button type="button" data-action="tab-limit" data-tab="limit">安全限界</button></nav>
      <div class="rs-scroll">
        <div data-role="operations" hidden></div>
        <div data-role="object-view">
        <p class="rs-readonly" data-role="readonly" hidden>只读查看 · 当前账号没有施工管控编辑权限</p>
        <div class="rs-toolbar"><label class="rs-label rs-select-label"><span data-role="select-label">机械资源</span><select data-role="selection" aria-label="选择管控对象"></select></label><button type="button" data-action="new">新增</button><button type="button" data-action="locate">定位</button></div>
        <div data-role="priority"></div>
        <section class="rs-demo" data-role="fall-demo" hidden></section>
        <section class="rs-monitor" data-role="monitor" hidden></section>
        <section class="rs-display" aria-label="显示效果">
          <div class="rs-display-heading"><h3>显示效果</h3><button type="button" data-action="reset-display">恢复默认</button></div>
          <nav class="rs-display-tabs" aria-label="显示设置分类"><button type="button" data-action="display-limits" data-display-tab="limits">安全限界</button><button type="button" data-action="display-guards" data-display-tab="guards">人员区域</button><button type="button" data-action="display-envelopes" data-display-tab="envelopes">倾覆影响区</button><button type="button" data-action="display-personnel" data-display-tab="personnel">防护人员</button></nav>
          <div data-role="display-controls"></div>
          <p class="rs-help" data-role="display-storage">调整立即生效，按当前账号和项目记住显示偏好；不改变区域坐标与筛查结果。</p>
        </section>
        <div class="rs-results" data-role="results" aria-live="polite"></div>
        <div data-role="editor"></div>
        <div class="rs-picking" data-role="picking" hidden><p data-role="pick-message">点击场景地面添加顶点。</p><div class="rs-actions"><button type="button" data-action="undo-point">撤销一点</button><button type="button" data-action="finish-polygon">完成区域</button><button type="button" data-action="cancel-pick">取消绘制</button></div></div>
        <div class="rs-layer-controls" aria-label="范围显示开关"><label><input type="checkbox" data-layer="guards" checked>人员及两类区域</label><label><input type="checkbox" data-layer="limits" checked>设备限界</label><label><input type="checkbox" data-layer="envelopes" checked>倾覆外包</label><p>人员图层包含防护责任区与人员工作区；开关只影响显示，隐藏的限界仍参与筛查。</p></div>
        <div class="rs-legend" aria-label="范围图例"><span><i class="rs-dot" data-range-color="limit"></i>设备限界</span><span><i class="rs-dot" data-range-color="responsibility"></i>防护责任区</span><span><i class="rs-dot" data-range-color="envelope"></i>倾覆范围</span><span><i class="rs-dot" data-range-color="risk"></i>全方向潜在相交</span><span><i class="rs-dot" data-range-color="workArea"></i>人员工作区</span><span><i class="rs-dot" data-range-color="support"></i>计算支承区</span><p class="rs-legend-note">区域按所选颜色显示；人员定位点与状态文字继续提示区内、越界或待核实。模拟定位单独标注。</p></div>
        <details class="rs-method"><summary>计算口径与适用范围</summary><p class="rs-note">汇总及相交区按完整模型 0–90° 扫掠的全方向保守外包进行平面筛查，假设固定支承线、水平地面、不滑移和不解体，包含采样余量且忽略首次触地挡止。按角度投影表示当前模型形态，不预测事故运动，也不改变全方向筛查结果。人员责任区仅核对已关联机械站位。</p></details>
        </div>
        <p class="rs-status" data-role="status" role="status">选择机械，或新增防护人员和安全限界。</p>
        <div class="rs-confirm" data-role="confirm" hidden><p data-role="confirm-text"></p><div class="rs-actions"><button type="button" data-action="confirm">放弃草稿并继续</button><button type="button" data-action="keep">继续编辑</button></div></div>
      </div>
      <footer class="rs-footer"><button type="button" data-action="save" class="rs-primary">保存配置</button><button type="button" data-action="cancel">取消编辑</button><button type="button" data-action="remove" class="rs-danger">删除</button></footer>`;
    if (options.onDisplayManager) {
      const layers = this.find('.rs-layer-controls');
      layers.replaceChildren();
      const button = element('button', '', '分类 / 分组显示管理');
      button.type = 'button'; button.addEventListener('click', options.onDisplayManager);
      layers.append(button, element('p', '', '在右侧“场景显示”中统一控制对象、区域和标签；隐藏不影响统计与报警。'));
    }
    options.host.append(this.root);
    this.scene = new RailSafetyScene(options.viewer, {
      pickPosition: options.pickPosition,
      onResults: results => {
        if (this.destroyed || !this.context.canView) return;
        this.results = results; this.renderStats(); this.renderResults(); this.renderOperations(); this.options.onDisplayChange?.();
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
        if (this.destroyed || !this.context.canView || !this.context.active || this.busy || this.picking) return;
        if (this.root.dataset.presentation === "management" && this.options.onSelectObject) { this.options.onSelectObject(kind, id); return; }
        if (!this.opened || this.busy || this.picking) return;
        this.requestDiscard(() => { this.tab = kind; this.displayTab = kind === "limit" ? "limits" : kind === "guard" ? "guards" : "envelopes"; this.select(id); }, "切换对象会放弃尚未保存的修改。");
      },
    });
    this.root.addEventListener("click", event => {
      if ((event.target as Element).closest('[data-role="operations"]')) return;
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
      if (button && !button.disabled) this.action(button.dataset.action!, button);
    }, { signal: this.events.signal });
    this.root.addEventListener("input", event => this.input(event.target as HTMLInputElement), { signal: this.events.signal });
    this.root.addEventListener("change", event => this.change(event.target as HTMLInputElement | HTMLSelectElement), { signal: this.events.signal });
    this.positioningClient = new RailSafetyPositioningClient({
      onSnapshot: snapshot => this.receivePositionSnapshot(snapshot),
      onStatus: status => {
        if (this.destroyed) return;
        this.positioningConnection = status;
        if (status.httpStatus === 401 || status.httpStatus === 403) {
          for (const deviceId of this.networkPositionDevices) this.positioning.removeSample(this.context.projectId, deviceId, "measured");
          this.networkPositionDevices.clear(); this.positioningSnapshot = undefined; this.refreshPositioning();
        }
        this.updatePositioningConnection();
      },
    });
    this.positioningTimer = setInterval(() => this.refreshPositioning(), 1000);
    this.render();
  }

  get isOpen() { return this.opened; }
  get hasDraft() { return this.dirty || this.picking; }
  get isPicking() { return this.picking; }
  get isBusy() { return this.busy; }
  get selectedResourceId() { return this.context.canView && this.tab === "machine" ? this.selectedId : ""; }
  /** Reparent, never recreate: unsaved fields, confirmation state and listeners remain intact. */
  setManagementHost(host?: HTMLElement) {
    if (this.destroyed) return;
    this.managementHost = host;
    this.setPresentation(this.root.dataset.presentation === "workbench" ? "workbench" : "management");
  }
  setPresentation(mode: "workbench" | "management") {
    if (this.destroyed) return;
    this.root.dataset.presentation = mode;
    if (mode === "workbench") this.root.dataset.fieldFocus = "object";
    this.root.dataset.docked = String(mode === "management" && !!this.managementHost);
    const host = mode === "workbench" ? this.options.workbenchHost ?? this.options.host : this.managementHost ?? this.options.host;
    if (this.root.parentElement !== host) host.append(this.root);
  }
  /** A detached, permission-filtered view. Unconfigured resources stay visible as unknown. */
  getFieldSummary(): RailSafetyFieldSummary {
    const empty: RailSafetyFieldSummary = { projectId: this.context.projectId, pending: false, machines: [], machineCount: 0, riskCount: 0, unknownCount: 0, clearCount: 0, guardCount: 0, limitCount: 0 };
    if (this.destroyed || !this.context.canView || !this.context.active) return empty;
    const records = this.records(), resources = [...new Map(this.resources().filter(resource => !resource.deletedAt).map(resource => [resource.id, resource])).values()];
    const results = new Map(this.results.map(result => [result.resourceId, result]));
    const machines = resources.map(resource => {
      const modelReady = !!readMachineryState(resource.machinery);
      const configs = records.filter(record => record.definition.kind === "machine" && record.definition.resourceId === resource.id);
      const config = configs[0]; let validConfig: Extract<RailSafetyDefinition, { kind: "machine" }> | undefined;
      if (configs.length === 1) { try { const definition = validateRailSafetyDefinition(config.definition); if (definition.kind === "machine") validConfig = definition; } catch { /* Invalid configuration is shown as unknown. */ } }
      const configurationReady = !!validConfig;
      const preparationReason = !modelReady ? "尚未设置有效机械模型和站位" : !configs.length ? "尚未保存机械管控配置，请明确选择安全限界" : configs.length > 1 ? "机械存在重复管控配置，需先核对" : !validConfig ? "机械管控配置无效，需先核对" : !validConfig.selectedLimitIds.length ? "尚未选用安全限界" : "";
      const assessed = results.get(resource.id);
      const result: RailSafetyMachineResult = assessed
        ? preparationReason ? { ...assessed, status: "unknown", label: "待核实", message: preparationReason } : assessed
        : { resourceId: resource.id, resourceName: resource.name, recordId: config?.id, status: "unknown", label: "待核实", message: preparationReason || "尚未取得当前配置的计算结果", draft: false, warnings: [], limits: [], guards: [], signature: "" };
      return { ...result, modelReady, configurationReady, preparationReason };
    });
    return clone({ projectId: this.context.projectId, pending: !!this.scene.getSnapshot().pending, selectedResourceId: this.selectedResourceId || undefined, machines, machineCount: machines.length,
      riskCount: machines.filter(machine => machine.status === "overlap" || machine.status === "touching").length,
      unknownCount: machines.filter(machine => machine.status === "unknown" || machine.limits.some(limit => limit.status === "unknown")).length,
      clearCount: machines.filter(machine => machine.status === "clear" && !machine.limits.some(limit => limit.status === "unknown")).length,
      guardCount: records.filter(record => record.definition.kind === "guard").length,
      limitCount: records.filter(record => record.definition.kind === "limit").length });
  }
  /** Select the actual machine, then use the established model-based angle demonstration. */
  openMachineAnalysis(resourceId: string): boolean {
    return this.openFieldObject("machine", resourceId, () => {
      this.root.dataset.fieldFocus = "analysis";
      if (!readMachineryState(this.resources().find(resource => resource.id === resourceId)?.machinery)) {
        this.message("该机械尚未保存有效模型和站位，请先完成机械布置；当前状态为待核实。", true); return;
      }
      const generation = this.generation;
      // The field dock is revealed by its host on the next frame. Scrolling while
      // the parent is hidden leaves these controls below the configuration form.
      requestAnimationFrame(() => {
        if (!this.destroyed && this.opened && generation === this.generation) this.find('[data-role="fall-demo"]').scrollIntoView({ block: "nearest" });
      });
      void this.scene.startFallDemo(resourceId).then(started => {
        // Clicking the demonstration entry should actually demonstrate motion.
        // A late asset load must not restart playback after closing or switching.
        if (started && !this.destroyed && this.opened && generation === this.generation) this.scene.setFallDemo({ playing: true });
      }).catch(error => {
        if (!this.destroyed && this.opened && generation === this.generation) {
          this.message(error instanceof Error ? error.message : "倾覆演示加载失败，请重试。", true);
        }
      });
    });
  }
  /** Risk entry is a read operation. Registering a problem still requires an explicit action. */
  openMachineRisk(resourceId: string): boolean {
    return this.openFieldObject("machine", resourceId, () => {
      this.root.dataset.fieldFocus = "risk";
      this.find('[data-role="results"]').scrollIntoView({ block: "nearest" });
    });
  }
  openDisplayEffects(): boolean {
    if (this.destroyed || !this.context.canView || !this.context.active || this.busy || this.picking) return false;
    this.open();
    return this.requestDiscard(() => {
      this.workspaceView = "objects"; this.root.dataset.fieldFocus = "display";
      this.renderDisplay(); this.controls(); this.find('.rs-display').scrollIntoView({ block: "nearest" });
    }, "切换显示效果会关闭当前配置编辑，请先保存或确认放弃尚未保存的修改。");
  }
  /** An explicit add entry uses the normal empty draft; it never writes or infers a task/limit. */
  openDefinition(kind: "guard" | "limit", id?: string): boolean {
    if (id) return this.openFieldObject(kind, id);
    if (this.destroyed || !this.context.canView || !this.context.active || this.busy) return false;
    if (!this.context.canEdit) {
      const first = this.records().find(record => record.definition.kind === kind);
      return first ? this.openFieldObject(kind, first.id) : false;
    }
    this.open();
    return this.requestDiscard(() => {
      this.tab = kind; this.displayTab = kind === "guard" ? "guards" : "limits";
      this.select(""); this.create();
    }, "新增对象会放弃尚未保存的修改，请先保存或确认放弃。");
  }
  private openFieldObject(tab: Tab, id: string, after?: () => void): boolean {
    if (this.destroyed || !this.context.canView || !this.context.active || this.busy) return false;
    if (tab === "machine" ? !this.resources().some(resource => resource.id === id) : !this.records().some(record => record.id === id && record.definition.kind === tab)) return false;
    this.open();
    return this.requestDiscard(() => {
      this.tab = tab; this.displayTab = tab === "limit" ? "limits" : tab === "guard" ? "guards" : "envelopes";
      this.select(id); after?.();
    }, "切换对象会放弃尚未保存的修改，请先保存或确认放弃。");
  }
  getDisplayObjects() { return this.scene.getDisplayObjects(); }
  setDisplayVisibility(overrides: Record<string, boolean>, labelsVisible: boolean) { this.scene.setDisplayVisibility(overrides, labelsVisible); }
  locateDisplayObject(id: string) { return this.scene.flyTo(id); }
  selectDisplayObject(kind: string, id: string) {
    if (!["machine", "envelope", "limit", "guard", "personnel", "responsibility", "workArea"].includes(kind)) return false;
    const tab: Tab = kind === "envelope" ? "machine" : kind === "limit" ? "limit" : "guard";
    return this.openFieldObject(kind === "machine" ? "machine" : tab, id);
  }
  setMachineryPreview(id: string, state?: MachineryState) { if (!this.destroyed) this.scene.setMachineryPreview(id, state); }
  setLiveStates(states: ReadonlyMap<string, MachineryState>) { if (!this.destroyed) this.scene.setLiveStates(states); }
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
      this.workspaceView = "objects"; this.taskScopeKey = ""; this.issueFilter = "open";
      this.display = readRailSafetyDisplay(context.projectId, context.actorId);
      this.scene.setDisplay(this.display);
      this.find('[data-role="display-storage"]').textContent = "调整立即生效，按当前账号和项目记住显示偏好；不改变区域坐标与筛查结果。";
      this.renderDisplay();
    }
    if (reset) {
      this.positioning.clear(); this.positionStates = []; this.scene.setGuardPositionStates([]); this.scene.stopFallDemo();
      this.positionBindings.clear(); this.networkPositionDevices.clear(); this.positioningSnapshot = undefined; this.positioningSampleError = "";
      ++this.generation; this.scene.cancelPicking(); this.scene.setDraft(undefined);
      this.draft = undefined; this.selectedId = ""; this.dirty = false; this.busy = false; this.results = []; this.concurrentRevision = false;
      this.pendingAction = undefined; this.find('[data-role="confirm"]').hidden = true;
      if (this.opened) this.options.onOpenChange?.(false);
      this.opened = false;
    }
    const bindings = new Map(this.records().filter(record => record.status === "active" && record.definition.kind === "guard" && record.definition.workArea?.deviceId)
      .map(record => [record.definition.kind === "guard" ? record.definition.workArea!.deviceId! : "", record.id]));
    for (const [deviceId, guardId] of this.positionBindings) if (bindings.get(deviceId) !== guardId) {
      this.positioning.removeSample(context.projectId, deviceId); this.networkPositionDevices.delete(deviceId);
    }
    this.positionBindings = bindings;
    this.positioningClient.setContext({ projectId: context.projectId, actorId: context.actorId ?? "", enabled: context.active && context.canView && !!context.actorId && bindings.size > 0 });
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
    this.renderSelection(); this.renderStats(); this.renderResults(); this.renderOperations(); this.controls();
  }
  open() {
    if (this.destroyed || !this.context.canView || !this.context.active) return;
    this.opened = true; this.root.hidden = false;
    this.options.onOpenChange?.(true);
    if (this.workspaceView === "objects" && !this.draft && this.tab === "machine" && this.resources()[0]) this.select(this.resources()[0].id);
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
    ++this.generation; this.scene.cancelPicking(); this.destroyed = true; clearInterval(this.positioningTimer); this.positioningClient.dispose(); this.positioning.clear(); this.events.abort(); this.scene.dispose(); this.root.remove(); this.setPicking(false);
    this.opened = false; this.options.onOpenChange?.(false);
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
    this.workspaceView = "objects";
    this.root.dataset.fieldFocus = "object";
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
    this.options.onSelectionChange?.(this.tab, id);
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
  private render() { this.renderSelection(); this.renderEditor(); this.renderDisplay(); this.renderStats(); this.renderResults(); this.renderOperations(); this.controls(); }
  private taskView() {
    return buildRailSafetyTaskView({ projectId: this.context.projectId, tasks: this.context.tasks, resources: this.resources(), records: this.records(), issues: this.context.issues, allocations: this.context.allocations });
  }
  private get canReportRisk() {
    return !!this.options.reportRisk && !!this.context.canReportRisk && this.context.canView && this.context.active
      && !this.busy && !this.dirty && !this.picking && !this.scene?.getSnapshot().pending;
  }
  private renderOperations() {
    const host = this.find('[data-role="operations"]');
    if (this.workspaceView === "objects" || !this.context.canView) { host.replaceChildren(); return; }
    renderRailSafetyOperations(host, {
      mode: this.workspaceView, taskView: this.taskView(), scopeKey: this.taskScopeKey, issueFilter: this.issueFilter,
      resources: this.resources(), records: this.records(), tasks: this.context.tasks, issues: this.context.issues ?? [],
      results: this.results, canReport: this.canReportRisk, busy: this.busy,
    }, {
      scopeChange: key => { if (!this.busy) { this.taskScopeKey = key; this.renderOperations(); } },
      issueFilterChange: filter => { if (!this.busy) { this.issueFilter = filter; this.renderOperations(); } },
      openTasks: id => this.navigateTask(id),
      selectObject: (kind, id) => { if (!this.busy) { this.tab = kind; this.displayTab = kind === "limit" ? "limits" : kind === "guard" ? "guards" : "envelopes"; this.select(id); } },
      locateMachine: id => { void this.scene.flyTo(id); },
      openIssue: id => this.navigateIssue(id),
      reportRisk: (resourceId, limitId) => { void this.reportRisk(resourceId, limitId); },
      exportCsv: () => this.exportTaskCsv(),
    });
  }
  private navigateTask(taskId?: string) {
    if (!this.options.openTasks || this.busy) return;
    this.requestDiscard(() => { this.closeNow(); this.options.openTasks?.(taskId); }, "打开任务管理会关闭当前面板，请先保存配置，或放弃草稿后继续。");
  }
  private navigateIssue(issueId: string) {
    if (!this.options.openIssue || this.busy || !this.context.issues?.some(issue => issue.id === issueId)) return;
    this.requestDiscard(() => { this.closeNow(); this.options.openIssue?.(issueId); }, "打开处置单会关闭当前面板，请先保存配置，或放弃草稿后继续。");
  }
  private openRiskIssue(resourceId: string, limitId: string) {
    const config = this.records().find(record => record.definition.kind === "machine" && record.definition.resourceId === resourceId);
    return this.context.issues?.find(issue => {
      const source = issue.railSafetyRisk as RailSafetyRiskSnapshot | undefined;
      return issue.projectId === this.context.projectId && source?.schemaVersion === 1 && source.resourceId === resourceId && source.limitId === limitId && source.taskId === config?.taskId
        && !(RAIL_SAFETY_RISK_CLOSED_STATUSES as readonly string[]).includes(issue.status);
    });
  }
  private exportTaskCsv() {
    if (!this.context.canView || this.busy) return;
    const csv = exportRailSafetyTaskCsv(this.taskView(), { exportedAt: new Date().toISOString() });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "邻近营业线任务管控清单.csv";
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
    this.message("已导出当前账号可见的任务管控清单，各任务涉及机械数量不可直接相加。");
  }
  private async reportRisk(resourceId: string, limitId: string) {
    if (this.scene.hasLiveState(resourceId)) { this.message("实时姿态尚未保存，停用关联并保存姿态后可登记。", true); return; }
    if (!this.canReportRisk || !this.options.reportRisk) { this.message("请先保存或取消草稿，并等待当前配置计算完成；登记处置需要现场填报权限。", true); return; }
    const duplicate = this.openRiskIssue(resourceId, limitId);
    if (duplicate) { this.workspaceView = "issues"; this.issueFilter = "open"; this.taskScopeKey = duplicate.taskId || "__unassigned__"; this.renderOperations(); this.controls(); this.message("已有未闭环处置单，请继续办理，避免重复登记。"); return; }
    const state = this.scene.getSnapshot(), result = this.results.find(row => row.resourceId === resourceId);
    const resource = this.resources().find(row => row.id === resourceId), config = this.records().find(row => row.id === result?.recordId && row.definition.kind === "machine");
    const limit = this.records().find(row => row.id === limitId && row.definition.kind === "limit"), relation = result?.limits.find(row => row.id === limitId);
    const task = config?.taskId ? this.context.tasks.find(row => row.id === config.taskId) : undefined;
    if (!resource || !config || !limit || !relation || !result || result.draft || state.pending || result.signature !== state.signature
      || !["overlap", "touching"].includes(relation.status) || !Number.isFinite(relation.distanceMeters) || !Number.isFinite(result.maxDistanceMeters)
      || (config.taskId && !task)) { this.message("当前结果尚不能登记，请核对已保存的机械、限界与任务，并等待筛查完成。", true); return; }
    const generation = this.generation, projectId = this.context.projectId, actorId = this.context.actorId;
    const payload: RailSafetyRiskReportPayload = {
      resourceId, resourceRevision: resource.revision, machineConfigId: config.id, machineConfigRevision: config.revision,
      limitId, limitRevision: limit.revision, ...(task ? { taskId: task.id, taskRevision: task.revision } : {}),
      name: `${resource.name} · ${limit.name} · ${relation.status === "overlap" ? "潜在侵限" : "接触边界"}`.slice(0, 200),
      screening: { schemaVersion: 1, source: "browser-geometric-screening", method: RAIL_SAFETY_RISK_METHOD,
        capturedAt: new Date().toISOString(), status: relation.status as "overlap" | "touching", distanceMeters: relation.distanceMeters!, maxDistanceMeters: result.maxDistanceMeters!, warnings: result.warnings },
    };
    this.busy = true; this.renderOperations(); this.controls(); this.message("正在登记机械筛查风险…");
    try {
      await this.options.reportRisk(payload);
      if (this.destroyed || this.context.projectId !== projectId || this.context.actorId !== actorId || this.generation !== generation) return;
      this.workspaceView = "issues"; this.issueFilter = "open"; this.taskScopeKey = task?.id || "__unassigned__";
      this.message("已登记为待核查处置单。打开处置单可指派、整改和复核，登记不会自动关闭当前几何风险。");
    } catch (error) {
      if (!this.destroyed && this.context.projectId === projectId && this.context.actorId === actorId && this.generation === generation) this.message(errorText(error), true);
    } finally {
      if (!this.destroyed && this.context.projectId === projectId && this.context.actorId === actorId && this.generation === generation) { this.busy = false; this.renderOperations(); this.renderResults(); this.controls(); }
    }
  }
  private renderDisplay() {
    const container = this.find('[data-role="display-controls"]'); container.replaceChildren();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-display-tab]")) {
      const selected = button.dataset.displayTab === this.displayTab;
      button.classList.toggle("is-active", selected); button.setAttribute("aria-pressed", String(selected));
    }
    const grid = element("div", "rs-display-grid");
    const color = (label: string, key: keyof RailSafetyDisplaySettings["colors"]) => {
      const wrapper = element("label", "rs-label rs-color-control"), input = element("input"), output = element("output");
      input.type = "color"; input.value = this.display.colors[key]; input.dataset.display = `colors.${key}`; input.setAttribute("aria-label", label);
      output.dataset.colorOutput = key; output.value = input.value.toUpperCase();
      wrapper.append(element("span", "", label), input, output); grid.append(wrapper);
    };
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
    const effects = (keys: Array<[keyof RailSafetyDisplaySettings["colors"], string]>) => {
      const details = element("details", "rs-range-effects");
      details.append(element("summary", "", "范围动态效果"), element("p", "rs-help", "每类范围可独立选择静态、呼吸或流动。动态效果只改变外观，隐藏范围后暂停动画。"));
      for (const [key, label] of keys) {
        const section = element("fieldset", "rs-effect-section"); section.dataset.rangeEffect = key;
        section.append(element("legend", "", label));
        const before = grid.childElementCount, settings = this.display.effects[key];
        select("效果", `effects.${key}.mode`, settings.mode, [["static", "静态"], ["breathe", "呼吸"], ["flow", "流动"]]);
        range("速度", `effects.${key}.speed`, settings.speed, 0.25, 3, 0.25);
        range("强度", `effects.${key}.intensity`, settings.intensity, 0, 1, 0.05);
        const controls = element("div", "rs-effect-grid");
        while (grid.childElementCount > before) controls.append(grid.children[before]);
        section.append(controls); details.append(section);
      }
      container.append(details);
    };
    if (this.displayTab === "limits") {
      color("安全限界颜色", "limit");
      select("限界展示形式", "limits.representation", this.display.limits.representation, [["plane", "平面"], ["wall", "立面墙"], ["both", "平面 + 立面墙"]]);
      range("墙高（米）", "limits.wallHeight", this.display.limits.wallHeight, 0.5, 100, 0.5);
      range("墙面透明度", "limits.wallOpacity", 1 - this.display.limits.wallOpacity, 0, 1, 0.01);
      container.append(grid, element("p", "rs-help", "墙底沿绘制点高程，向上延伸指定高度；透明度 100% 时墙面完全透明。此设置只改变显示，侵限仍按平面范围筛查。"));
      effects([["limit", "安全限界"]]);
    } else if (this.displayTab === "personnel") {
      select("人员标记", "personnel.representation", this.display.personnel.representation, [["model", "三维防护人员"], ["point", "简洁圆点"]]);
      range("模型比例", "personnel.scale", this.display.personnel.scale, 0.5, 3, 0.1);
      range("模型朝向", "personnel.heading", this.display.personnel.heading, 0, 360, 5);
      container.append(grid, element("p", "rs-help", "人物带安全帽与反光背心，以已保存站位为脚底。模型比例仅为显示大小，不代表实际身高，不改变站位或筛查尺寸。"));
    } else {
      const key = this.displayTab, settings = this.display[key];
      if (key === "guards") { color("防护责任区颜色", "responsibility"); color("人员工作区颜色", "workArea"); }
      else {
        select("查看中的机械范围", "envelopes.representation", this.display.envelopes.representation,
          [["pose", "当前方向 / 倾角投影"], ["overview", "全方向保守外包"], ["both", "投影 + 保守外包"]]);
        color("倾覆范围颜色", "envelope"); color("侵限相交区颜色", "risk"); color("计算支承区颜色", "support");
      }
      select("依附方式", `${key}.surface`, settings.surface, [["model", "依附模型 + 地形"], ["terrain", "仅贴地形"], ["absolute", "原始高程"]]);
      select("范围样式", `${key}.style`, settings.style, [["fill", "填充 + 边线"], ["outline", "仅边线"]]);
      range("填充浓度", `${key}.opacity`, settings.opacity, 0, 1, 0.01);
      range("边线宽度", `${key}.lineWidth`, settings.lineWidth, 1, 8, 0.5);
      container.append(grid, element("p", "rs-help", "依附模型：覆盖已加载的 3D Tiles 与地形表面；仅贴地形：忽略模型，可能被模型遮挡；原始高程：按原有顶点高程显示。"));
      if (key === "envelopes") container.append(element("p", "rs-help", "选择机械并开启“按角度查看范围”，投影随方向和倾角变化；其余机械仍显示全方向外包。潜在侵限汇总始终按全方向保守外包筛查，当前角度投影不替代该结果。"));
      effects(key === "guards" ? [["responsibility", "防护责任区"], ["workArea", "人员工作区"]] : [["envelope", "倾覆范围"], ["risk", "侵限相交区"], ["support", "计算支承区"]]);
    }
    this.updateRangeLegend();
    this.displayControls();
  }
  private updateRangeLegend() {
    for (const dot of this.root.querySelectorAll<HTMLElement>("[data-range-color]")) {
      const key = dot.dataset.rangeColor as keyof RailSafetyDisplaySettings["colors"];
      if (key in this.display.colors) dot.style.background = this.display.colors[key];
    }
  }
  private displayValue(property: string, value: number) {
    return /opacity$|intensity$/i.test(property) ? `${Math.round(value * 100)}%` : property.endsWith("wallHeight") ? `${value} m` : property.endsWith("lineWidth") ? `${value} px` : property.endsWith("speed") ? `${value.toFixed(2).replace(/0$/, "")}×` : property.endsWith("scale") ? `${value.toFixed(1)}×` : `${value}°`;
  }
  private displayControls() {
    const available = !this.destroyed && this.context.canView && this.context.active;
    const area = this.displayTab === "guards" || this.displayTab === "envelopes" ? this.display[this.displayTab] : undefined;
    for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("[data-display], [data-display-tab], [data-action=reset-display]")) {
      const property = control.dataset.display;
      const effectKey = property?.split(".")[1] as keyof RailSafetyDisplaySettings["effects"] | undefined;
      control.disabled = !available
        || !!property?.endsWith("opacity") && area?.style === "outline"
        || (property === "limits.wallHeight" || property === "limits.wallOpacity") && this.display.limits.representation === "plane"
        || (property === "personnel.scale" || property === "personnel.heading") && this.display.personnel.representation === "point"
        || !!property?.startsWith("effects.") && !property.endsWith(".mode") && !!effectKey && this.display.effects[effectKey]?.mode === "static";
    }
  }
  private updateDisplay(input: HTMLInputElement | HTMLSelectElement) {
    if (!this.context.canView || !this.context.active || this.destroyed || !input.dataset.display) return;
    const [group, property, effectField] = input.dataset.display.split(".");
    if (group !== "guards" && group !== "envelopes" && group !== "personnel" && group !== "limits" && group !== "colors" && group !== "effects") return;
    const value = input.type === "range" ? (property === "wallOpacity" ? 1 - Number(input.value) : Number(input.value)) : input.value;
    if (group === "effects" && (!(property in this.display.effects) || !["mode", "speed", "intensity"].includes(effectField))) return;
    const next = group === "effects"
      ? { ...this.display, effects: { ...this.display.effects, [property]: { ...this.display.effects[property as keyof RailSafetyDisplaySettings["effects"]], [effectField]: value } } }
      : { ...this.display, [group]: { ...this.display[group], [property]: value } };
    this.display = normalizeRailSafetyDisplay(next);
    this.applyDisplay(); this.displayControls(); this.updateRangeLegend(); this.updateFallDemo();
    if (group === "colors" && property in this.display.colors) {
      const output = this.root.querySelector<HTMLOutputElement>(`[data-color-output="${property}"]`);
      if (output) output.value = this.display.colors[property as keyof RailSafetyDisplaySettings["colors"]].toUpperCase();
    }
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
    const note = element("p", "rs-stats-note", unknown ? "按全方向保守外包筛查；待核实包括未选限界、配置缺失、计算中，0 不表示安全。" : "按全方向保守外包进行平面筛查，不随演示倾角改变，不代表施工安全批准。"); stats.append(note);
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
    taskSection.append(element("p", "rs-help", "保存后可在任务总览查看机械、人员、限界及待配置项。机械只能选用共用或同任务限界；关联任务不会自动选限界或更新进度。潜在侵限可单独登记处置。"));
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
        workArea.append(element("h3", "", "人员工作区域"));
        const toggle = element("label", "rs-check"), enabled = element("input"); enabled.type = "checkbox"; enabled.dataset.field = "work-area-enabled"; enabled.checked = !!definition.workArea;
        toggle.append(enabled, document.createTextNode("设置独立工作区域")); workArea.append(toggle);
        workArea.append(element("p", "rs-help", "用于判断人员定位是否离开允许活动范围。下方防护责任区用于核对负责机械，两个区域分别绘制，互不替代。"));
        if (definition.workArea) {
          const actions = element("div", "rs-actions"); actions.append(this.actionButton("draw-work-area", definition.workArea.polygon.length ? "重绘人员工作区" : "绘制人员工作区"), this.actionButton("add-work-vertex", "添加工作区顶点")); workArea.append(actions);
          const advanced = element("details", "rs-locator-advanced"); advanced.append(element("summary", "", "既有定位设备配置（高级）"));
          const fields = element("div", "rs-support-grid"); fields.append(this.inputField("定位设备编号", "workArea.deviceId", definition.workArea.deviceId || ""), this.inputField("定位过期时限（秒）", "workArea.staleAfterSeconds", String(definition.workArea.staleAfterSeconds ?? 30), "number")); advanced.append(fields);
          advanced.append(element("p", "rs-help", "设备编号使用字母、数字、冒号、短横线或下划线。同一项目一台设备绑定一人。保存后启用监测；填写编号不会自动连接真实设备。")); workArea.append(advanced);
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
  private receivePositionSnapshot(snapshot: RailSafetyPositioningSnapshot) {
    if (this.destroyed || !this.context.active || !this.context.canView || snapshot.projectId !== this.context.projectId) return;
    this.positioningSnapshot = snapshot; this.positioningSampleError = "";
    const retained = new Set<string>();
    for (const device of snapshot.devices) {
      if (this.positionBindings.get(device.deviceId) !== device.guardId || !device.configured || !device.sample) continue;
      retained.add(device.deviceId);
      const previous = this.positioning.getSample(snapshot.projectId, device.deviceId);
      if (previous?.source === "measured" && Date.parse(previous.timestamp) >= Date.parse(device.sample.timestamp)) continue;
      try { this.positioning.ingest(device.sample); }
      catch (error) { this.positioningSampleError = `设备 ${device.deviceId} 样本未接收：${errorText(error)}`; }
    }
    for (const deviceId of this.networkPositionDevices) if (!retained.has(deviceId)) this.positioning.removeSample(snapshot.projectId, deviceId, "measured");
    this.networkPositionDevices.clear(); for (const deviceId of retained) this.networkPositionDevices.add(deviceId);
    this.refreshPositioning(); this.updatePositioningConnection();
  }
  private updatePositioningConnection() {
    const status = this.root.querySelector<HTMLElement>('[data-role="position-connection"]');
    if (!status) return;
    const saved = this.existing();
    const deviceId = saved?.definition.kind === "guard" ? saved.definition.workArea?.deviceId : undefined;
    const device = this.positioningSnapshot?.devices.find(value => value.guardId === saved?.id && value.deviceId === deviceId);
    let message = this.positioningConnection.message;
    if (this.positioningConnection.state === "connected" && deviceId) message = device?.configured
      ? device.sample ? "定位接口已连接 · 已收到定位样本" : "定位接口已连接 · 等待设备首次上报"
      : "该设备尚未配置服务端接入凭据";
    status.dataset.state = this.positioningSampleError ? "error" : this.positioningConnection.state;
    status.textContent = this.positioningSampleError || message;
  }
  private renderFallDemo() {
    const host = this.find('[data-role="fall-demo"]'); host.replaceChildren(); host.hidden = this.draft?.definition.kind !== "machine";
    if (host.hidden) return;
    host.append(element("h3", "", "机械倾覆 · 按角度查看范围"));
    const actions = element("div", "rs-actions");
    actions.append(this.actionButton("fall-start", "按角度查看范围"), this.actionButton("fall-play", "播放"), this.actionButton("fall-reset", "复位"), this.actionButton("fall-stop", "退出演示")); host.append(actions);
    const controls = element("div", "rs-demo-grid"); controls.dataset.role = "fall-controls";
    for (const [property, title, max, step] of [["direction", "倾覆方向（北0° / 东90°）", 360, 1], ["angle", "倾倒角度", 90, 1]] as const) {
      const wrapper = element("label", "rs-label"), caption = element("span", "rs-range-caption"), output = element("output"); output.dataset.fallOutput = property; caption.append(document.createTextNode(title), output);
      const input = element("input"); input.type = "range"; input.min = "0"; input.max = String(max); input.step = String(step); input.dataset.fall = property; input.setAttribute("aria-label", title); wrapper.append(caption, input); controls.append(wrapper);
    }
    host.append(controls);
    const status = element("p", "rs-help"); status.dataset.role = "fall-status"; status.setAttribute("role", "status"); host.append(status);
    host.append(element("p", "rs-help", "轮廓来自当前机械三角面的水平投影，随连续方向和倾角更新；孔隙按显示分辨率保留。固定支承线几何演示不含滑移、解体和触地后的运动，原机械姿态不变。"));
    this.updateFallDemo();
  }
  private updateFallDemo() {
    const host = this.find('[data-role="fall-demo"]');
    if (host.hidden || !host.children.length) return;
    const state = this.fallDemo, machine = this.draft?.definition.kind === "machine" ? this.draft.definition : undefined;
    const same = !!machine && state?.resourceId === machine.resourceId, loading = !!same && !!state?.loading, active = !!same && !!state?.active && !loading;
    const available = this.context.canView && this.context.active && !this.busy && !this.picking;
    const start = this.find<HTMLButtonElement>('[data-action="fall-start"]'); start.hidden = active; start.disabled = !available || loading; start.textContent = loading ? "正在准备演示…" : "按角度查看范围";
    for (const action of ["fall-play", "fall-reset", "fall-stop"]) { const button = this.find<HTMLButtonElement>(`[data-action="${action}"]`); button.hidden = !active && !loading; button.disabled = !available || action !== "fall-stop" && !active; }
    this.find('[data-action="fall-play"]').textContent = state?.playing ? "暂停" : "播放";
    this.find('[data-role="fall-controls"]').hidden = !active;
    for (const property of ["direction", "angle"] as const) {
      const input = this.find<HTMLInputElement>(`[data-fall="${property}"]`), value = state?.[property] ?? 0;
      input.value = String(value); input.disabled = !available || !active;
      this.find<HTMLOutputElement>(`[data-fall-output="${property}"]`).value = `${Math.round(value)}°`;
    }
    const status = this.find('[data-role="fall-status"]');
    const parts = [state?.playing ? "播放中" : "已暂停"];
    if (Number.isFinite(state?.actualDirection)) parts.push(`方向 ${Math.round(state!.actualDirection!)}°`);
    const projectionMode = this.display.envelopes.representation !== "overview";
    if (projectionMode && state?.projectionBusy) parts.push("投影计算中，画面暂保留上一角度");
    if (projectionMode && state?.projectionReady && Number.isFinite(state.projectionAngle)) {
      parts.push(`当前画面 ${state.projectionAngle!.toFixed(1)}°`);
      if (Number.isFinite(state.projectionAreaMeters2)) parts.push(`投影约 ${state.projectionAreaMeters2!.toFixed(1)} ㎡`);
      if (Number.isFinite(state.projectionCellSizeMeters)) parts.push(`显示网格 ${state.projectionCellSizeMeters!.toFixed(2)} m`);
    }
    if (projectionMode && state?.belowGround) parts.push(`已超过首次触地角 ${state.firstContactAngle?.toFixed(1) ?? "—"}°，当前为几何续转`);
    if (projectionMode && state?.projectionError) parts.push(state.projectionError);
    status.textContent = loading ? "正在读取机械模型并准备演示，完成后可播放、暂停和拖动倾角。" : state?.error ? state.error : active ? parts.join(" · ") : "选择机械后开启，拖动方向和倾角，或播放查看连续变化。汇总仍按全方向外包筛查。";
  }
  private renderMonitor() {
    const host = this.find('[data-role="monitor"]'), guideOpen = host.querySelector<HTMLDetailsElement>('[data-role="locator-guide"]')?.open ?? false;
    host.replaceChildren(); host.hidden = this.draft?.definition.kind !== "guard";
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
    const connection = element("p", "rs-connection"); connection.dataset.role = "position-connection"; connection.setAttribute("role", "status"); host.append(connection);
    const guide = element("details", "rs-locator-guide"); guide.dataset.role = "locator-guide"; guide.open = guideOpen;
    guide.append(element("summary", "", "如何接入现场定位器"));
    const steps = element("ol");
    for (const text of ["绘制人员工作区，绑定定位器的唯一设备编号并保存。", "由管理员为该项目、人员及设备配置服务端接入凭据；每台设备使用独立密钥。", "厂家平台或现场网关将坐标转换为 WGS84，携带采集时间、水平精度和设备编号持续上报。", "本页自动读取新位置并检查工作区；离线显示定位过期，精度覆盖边界时显示待核实。"]) steps.append(element("li", "", text));
    guide.append(steps, element("p", "rs-help", "室内 UWB 的局部坐标需先完成现场坐标标定。需要厂家提供品牌型号、通信协议和一条原始定位报文；填写设备编号本身不会连接设备。"));
    host.append(guide, element("p", "rs-help", "模拟点只在当前会话显示。实测由鉴权接口接收；本页提示越界，尚未配置短信、声光或设备振动联动。"));
    this.updatePositioningConnection();
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
    container.append(element("h3", "", "全方向保守外包 · 几何筛查"));
    if (!results.length) { container.append(element("p", "rs-help", "暂无当前对象的筛查结果。先放置机械并选用限界。")); return; }
    for (const result of results) {
      const card = element("article", "rs-result rs-result-" + result.status); card.dataset.resourceId = result.resourceId; card.dataset.status = result.status;
      const heading = element("div", "rs-result-heading");
      const locate = this.actionButton("locate-result", "定位机械"); locate.dataset.resourceId = result.resourceId;
      const livePose = this.scene.hasLiveState(result.resourceId);
      heading.append(element("strong", "", result.resourceName), element("span", "rs-badge", livePose ? "实时姿态（未保存）" : result.draft ? "草稿预览" : "当前配置"), locate); card.append(heading);
      card.append(element("p", "rs-result-label", result.label), element("p", "rs-help", result.message));
      if (livePose) card.append(element("p", "rs-warning", "实时姿态尚未保存，停用关联并保存姿态后可登记。"));
      if (this.tab === "machine" && this.draft?.definition.kind === "machine" && !this.draft.definition.selectedLimitIds.length) card.append(this.actionButton("choose-limits", "选择安全限界"));
      if (Number.isFinite(result.maxDistanceMeters)) card.append(element("p", "rs-measure", `采样扫掠最远投影距站位 ${result.maxDistanceMeters!.toFixed(2)} m`));
      if (Number.isFinite(result.nearestDistanceMeters)) card.append(element("p", "rs-measure", `限界最近距离 ${result.nearestDistanceMeters!.toFixed(2)} m`));
      for (const limit of result.limits) {
        const line = element("div", "rs-result-line"); line.append(element("span", "", limit.name), element("span", "", ({ unknown: "待核实", overlap: "潜在侵限", touching: "接触边界", clear: "未相交" }[limit.status]) + (Number.isFinite(limit.distanceMeters) ? ` · ${limit.distanceMeters!.toFixed(2)} m` : ""))); card.append(line);
        if (limit.message) card.append(element("p", "rs-help", limit.message));
        if (["overlap", "touching"].includes(limit.status)) {
          const existing = this.openRiskIssue(result.resourceId, limit.id);
          const action = this.actionButton(existing ? "open-risk-issue" : "report-risk", existing ? "查看未闭环处置单" : "登记处置");
          action.dataset.resourceId = result.resourceId; action.dataset.limitId = limit.id;
          if (existing) { action.dataset.issueId = existing.id; action.disabled = this.busy || this.picking; }
          else action.disabled = !this.canReportRisk || result.draft;
          card.append(action);
        }
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
    const objects = this.workspaceView === "objects";
    this.find('[data-role="object-view"]').hidden = !objects;
    this.find('[data-role="operations"]').hidden = objects;
    this.find('.rs-tabs').hidden = !objects;
    this.find('.rs-footer').hidden = !objects;
    this.root.dataset.workspaceView = this.workspaceView;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-workspace-view]')) {
      const active = button.dataset.workspaceView === this.workspaceView;
      button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); button.disabled = this.busy;
    }
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
    if (input.dataset.display) { if (input.type === "range" || input.type === "color") this.updateDisplay(input); return; }
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
    if (action.startsWith("workspace-")) {
      const view = action.slice("workspace-".length);
      if (this.context.canView && this.context.active && ["objects", "tasks", "issues"].includes(view)) {
        this.requestDiscard(() => {
          this.scene.stopFallDemo(); this.clearDraft(); this.workspaceView = view as "objects" | "tasks" | "issues";
          if (view === "objects") this.select(this.selectedId || (this.tab === "machine" ? this.resources()[0]?.id : this.records().find(record => record.definition.kind === this.tab)?.id) || "");
          else { this.renderOperations(); this.controls(); this.message(view === "tasks" ? "任务筛选只改变此处列表，场景与几何筛查保持当前项目完整配置。" : "处置单保存登记时的配置快照；历史结论不替代当前机械筛查结果。"); }
        }, "切换工作台会放弃尚未保存的修改，请先保存或确认放弃。");
      }
      return;
    }
    if (action === "report-risk" && button.dataset.resourceId && button.dataset.limitId) { void this.reportRisk(button.dataset.resourceId, button.dataset.limitId); return; }
    if (action === "open-risk-issue" && button.dataset.issueId) { this.navigateIssue(button.dataset.issueId); return; }
    if (action.startsWith("display-")) {
      const tab = action.slice(8);
      if (this.context.canView && (tab === "guards" || tab === "envelopes" || tab === "personnel" || tab === "limits")) { this.displayTab = tab; this.renderDisplay(); }
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
    if (action === "open-tasks" && this.options.openTasks) { this.navigateTask(); return; }
    if (action === "choose-limits") { const group = this.root.querySelector<HTMLElement>('[data-role="limit-selection"]'); group?.scrollIntoView({ block: "start", behavior: "smooth" }); (group?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? group)?.focus(); return; }
    if (action === "manage-limits") { this.requestDiscard(() => { this.tab = "limit"; this.select(this.records().find(record => record.definition.kind === "limit")?.id || ""); }, "管理限界会切换当前机械，请先保存配置，或放弃当前草稿后继续。"); return; }
    if (action.startsWith("tab-")) { const tab = action.slice(4) as Tab; this.requestDiscard(() => { this.tab = tab; this.displayTab = tab === "limit" ? "limits" : tab === "guard" ? "guards" : "envelopes"; this.select(tab === "machine" ? this.resources()[0]?.id || "" : this.records().find(record => record.definition.kind === tab)?.id || ""); }, "切换分类会放弃当前未保存修改。"); return; }
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
