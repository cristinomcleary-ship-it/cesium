export type ProjectControlLayer = Readonly<{
  id: string;
  name: string;
  kind: string;
  visible: boolean;
}>;

export type ProgressTaskStatus = "not-started" | "in-progress" | "paused" | "completed";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type RiskStatus = "open" | "handling" | "resolved" | "closed";

export type ProgressTask = Readonly<{
  id: string;
  name: string;
  planStart: string;
  planEnd: string;
  progress: number;
  weight: number;
  status: ProgressTaskStatus;
  owner: string;
  layerId: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectRisk = Readonly<{
  id: string;
  name: string;
  category: string;
  level: RiskLevel;
  status: RiskStatus;
  owner: string;
  dueDate: string;
  layerId: string;
  description: string;
  measure: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectControlOverviewSnapshot = Readonly<{
  totalTasks: number;
  completedTasks: number;
  delayedTasks: number;
  overallProgress: number;
  totalRisks: number;
  activeRisks: number;
  highRisks: number;
  overdueRisks: number;
  tasks: ReadonlyArray<ProgressTask>;
  risks: ReadonlyArray<ProjectRisk>;
}>;

export type ProjectControlOverviewListener = (snapshot: ProjectControlOverviewSnapshot) => void;

export type SandTableProjectControlOptions = {
  getLayers: () => readonly ProjectControlLayer[];
  locateLayer: (id: string) => void | Promise<void>;
  root?: ParentNode;
  storage?: Storage | null;
  storageKey?: string;
};

export const sandTableProjectControlHtml = `
  <div class="sand-project-control" id="sandProjectControl">
    <div class="sand-project-control__heading">
      <div><strong>项目管控</strong><small>PROGRESS &amp; RISK CONTROL</small></div>
      <span id="sandProjectControlStatus" aria-live="polite">业务台账已就绪</span>
    </div>
    <div class="sand-project-control__tabs" role="tablist" aria-label="项目管控模块">
      <button type="button" class="active" data-project-control-tab="progress" role="tab" aria-selected="true">项目进度</button>
      <button type="button" data-project-control-tab="risk" role="tab" aria-selected="false">风险管控 <b id="sandRiskTabBadge">0</b></button>
    </div>

    <section class="sand-project-control__pane active" data-project-control-pane="progress">
      <div class="sand-control-stats">
        <article><strong id="sandProgressOverall">0%</strong><span>总体进度</span></article>
        <article><strong id="sandProgressTaskTotal">0</strong><span>任务总数</span></article>
        <article><strong id="sandProgressTaskDone">0</strong><span>已完成</span></article>
        <article class="warning"><strong id="sandProgressTaskDelayed">0</strong><span>已延期</span></article>
      </div>
      <div class="sand-control-toolbar">
        <select id="sandProgressFilter" aria-label="进度状态筛选">
          <option value="all">全部任务</option><option value="active">进行中</option><option value="delayed">已延期</option><option value="completed">已完成</option><option value="paused">已暂停</option>
        </select>
        <input id="sandProgressSearch" maxlength="80" placeholder="搜索任务或责任人" />
        <button type="button" id="sandProgressCreate">新增任务</button>
      </div>
      <form id="sandProgressForm" class="sand-control-form" hidden>
        <input id="sandProgressId" type="hidden" />
        <label class="wide">任务名称<input id="sandProgressName" maxlength="120" required /></label>
        <label>计划开始<input id="sandProgressStart" type="date" required /></label>
        <label>计划完成<input id="sandProgressEnd" type="date" required /></label>
        <label>完成率（%）<input id="sandProgressValue" type="number" min="0" max="100" step="1" value="0" required /></label>
        <label>任务权重<input id="sandProgressWeight" type="number" min="1" max="100" step="1" value="1" required /></label>
        <label>任务状态<select id="sandProgressStatus"><option value="not-started">未开始</option><option value="in-progress">进行中</option><option value="paused">已暂停</option><option value="completed">已完成</option></select></label>
        <label>责任人<input id="sandProgressOwner" maxlength="60" /></label>
        <label class="wide">关联场景图层<select id="sandProgressLayer"></select></label>
        <label class="wide">任务说明<textarea id="sandProgressNotes" rows="2" maxlength="500"></textarea></label>
        <div class="sand-control-form__actions wide"><button type="submit" class="primary">保存任务</button><button type="button" id="sandProgressCancel">取消</button></div>
      </form>
      <div id="sandProgressList" class="sand-control-list"></div>
      <p id="sandProgressEmpty" class="sand-table-empty">尚未建立项目进度任务</p>
    </section>

    <section class="sand-project-control__pane" data-project-control-pane="risk" hidden>
      <div class="sand-control-stats">
        <article><strong id="sandRiskActive">0</strong><span>活动风险</span></article>
        <article class="danger"><strong id="sandRiskHigh">0</strong><span>高/重大</span></article>
        <article class="warning"><strong id="sandRiskOverdue">0</strong><span>逾期未闭环</span></article>
        <article><strong id="sandRiskClosed">0</strong><span>已闭环</span></article>
      </div>
      <div class="sand-control-toolbar">
        <select id="sandRiskFilter" aria-label="风险状态筛选"><option value="active">活动风险</option><option value="high">高/重大风险</option><option value="overdue">逾期风险</option><option value="closed">已闭环</option><option value="all">全部风险</option></select>
        <input id="sandRiskSearch" maxlength="80" placeholder="搜索风险或责任人" />
        <button type="button" id="sandRiskCreate">新增风险</button>
      </div>
      <form id="sandRiskForm" class="sand-control-form" hidden>
        <input id="sandRiskId" type="hidden" />
        <label class="wide">风险名称<input id="sandRiskName" maxlength="120" required /></label>
        <label>风险类别<select id="sandRiskCategory"><option>安全</option><option>质量</option><option>进度</option><option>成本</option><option>环境</option><option>其他</option></select></label>
        <label>风险等级<select id="sandRiskLevel"><option value="low">低</option><option value="medium">一般</option><option value="high">高</option><option value="critical">重大</option></select></label>
        <label>处置状态<select id="sandRiskStatus"><option value="open">待处置</option><option value="handling">处置中</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select></label>
        <label>责任人<input id="sandRiskOwner" maxlength="60" /></label>
        <label>整改期限<input id="sandRiskDueDate" type="date" required /></label>
        <label class="wide">关联场景图层<select id="sandRiskLayer"></select></label>
        <label class="wide">风险描述<textarea id="sandRiskDescription" rows="2" maxlength="800"></textarea></label>
        <label class="wide">管控措施<textarea id="sandRiskMeasure" rows="2" maxlength="800" placeholder="填写拟采取或已完成的整改措施"></textarea></label>
        <div class="sand-control-form__actions wide"><button type="submit" class="primary">保存风险</button><button type="button" id="sandRiskCancel">取消</button></div>
      </form>
      <div id="sandRiskList" class="sand-control-list"></div>
      <p id="sandRiskEmpty" class="sand-table-empty">当前没有符合条件的风险记录</p>
    </section>
  </div>
`;

type StoredState = { version: 1; tasks: ProgressTask[]; risks: ProjectRisk[] };
const DEFAULT_STORAGE_KEY = "cesium-sand-table-project-control-v1";
const MAX_TASKS = 500;
const MAX_RISKS = 1_000;
const MAX_LAYERS = 500;
const MAX_STORAGE_LENGTH = 1_048_576;
const SNAPSHOT_LIMIT = 200;

const TASK_STATUSES: readonly ProgressTaskStatus[] = ["not-started", "in-progress", "paused", "completed"];
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const RISK_STATUSES: readonly RiskStatus[] = ["open", "handling", "resolved", "closed"];

const taskStatusLabel: Readonly<Record<ProgressTaskStatus, string>> = {
  "not-started": "未开始", "in-progress": "进行中", paused: "已暂停", completed: "已完成",
};
const riskStatusLabel: Readonly<Record<RiskStatus, string>> = {
  open: "待处置", handling: "处置中", resolved: "已解决", closed: "已关闭",
};
const riskLevelLabel: Readonly<Record<RiskLevel, string>> = {
  low: "低", medium: "一般", high: "高", critical: "重大",
};

function cleanText(value: unknown, maximum: number, fallback = "") {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, maximum) || fallback
    : fallback;
}

function cleanDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isFinite(parsed.getTime()) ? value : "";
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function dateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function createId(prefix: string) {
  try { if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`; } catch { /* local fallback */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeIso(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function safeTask(value: unknown): ProgressTask | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = cleanText(source.id, 128);
  const name = cleanText(source.name, 120);
  const planStart = cleanDate(source.planStart);
  const planEnd = cleanDate(source.planEnd);
  if (!id || !name || !planStart || !planEnd || planStart > planEnd) return null;
  const now = new Date().toISOString();
  const sourceProgress = boundedInteger(source.progress, 0, 100, 0);
  const requestedStatus = enumValue(source.status, TASK_STATUSES, "not-started");
  const status = sourceProgress >= 100 || requestedStatus === "completed" ? "completed" : requestedStatus;
  const progress = status === "completed" ? 100 : sourceProgress;
  return Object.freeze({
    id, name, planStart, planEnd, progress, weight: boundedInteger(source.weight, 1, 100, 1), status,
    owner: cleanText(source.owner, 60), layerId: cleanText(source.layerId, 128), notes: cleanText(source.notes, 500),
    createdAt: safeIso(source.createdAt, now), updatedAt: safeIso(source.updatedAt, now),
  });
}

function safeRisk(value: unknown): ProjectRisk | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = cleanText(source.id, 128);
  const name = cleanText(source.name, 120);
  const dueDate = cleanDate(source.dueDate);
  if (!id || !name || !dueDate) return null;
  const now = new Date().toISOString();
  return Object.freeze({
    id, name, category: cleanText(source.category, 30, "其他"), level: enumValue(source.level, RISK_LEVELS, "medium"),
    status: enumValue(source.status, RISK_STATUSES, "open"), owner: cleanText(source.owner, 60), dueDate,
    layerId: cleanText(source.layerId, 128), description: cleanText(source.description, 800), measure: cleanText(source.measure, 800),
    createdAt: safeIso(source.createdAt, now), updatedAt: safeIso(source.updatedAt, now),
  });
}

function isTaskDelayed(task: ProgressTask, today = dateKey()) {
  return task.status !== "completed" && task.progress < 100 && task.planEnd < today;
}

function isRiskActive(risk: ProjectRisk) {
  return risk.status === "open" || risk.status === "handling";
}

function isRiskOverdue(risk: ProjectRisk, today = dateKey()) {
  return isRiskActive(risk) && risk.dueDate < today;
}

export class SandTableProjectControl {
  private readonly options: SandTableProjectControlOptions;
  private readonly root: ParentNode;
  private readonly storage: Storage | null;
  private readonly storageKey: string;
  private readonly cleanups: Array<() => void> = [];
  private readonly listeners = new Set<ProjectControlOverviewListener>();
  private tasks: ProgressTask[] = [];
  private risks: ProjectRisk[] = [];
  private layers: ProjectControlLayer[] = [];
  private disposed = false;

  constructor(options: SandTableProjectControlOptions) {
    this.options = options;
    this.root = options.root ?? document;
    if (options.storage !== undefined) this.storage = options.storage;
    else {
      let browserStorage: Storage | null = null;
      try { browserStorage = globalThis.localStorage; } catch { /* private browsing or blocked storage */ }
      this.storage = browserStorage;
    }
    this.storageKey = cleanText(options.storageKey, 120, DEFAULT_STORAGE_KEY);
    this.restore();
    this.bindUi();
    this.refreshLayers();
    this.render();
  }

  refreshLayers() {
    if (this.disposed) return;
    const used = new Set<string>();
    const next: ProjectControlLayer[] = [];
    try {
      for (const item of this.options.getLayers().slice(0, MAX_LAYERS)) {
        const id = cleanText(item?.id, 128);
        if (!id || used.has(id)) continue;
        used.add(id);
        next.push(Object.freeze({ id, name: cleanText(item?.name, 120, "未命名图层"), kind: cleanText(item?.kind, 40, "其他"), visible: item?.visible === true }));
      }
    } catch (error) {
      this.report("图层目录读取失败", error);
    }
    this.layers = next;
    this.renderLayerOptions("sandProgressLayer");
    this.renderLayerOptions("sandRiskLayer");
  }

  getOverviewSnapshot(): ProjectControlOverviewSnapshot {
    const totalWeight = this.tasks.reduce((sum, task) => sum + task.weight, 0);
    const weightedProgress = this.tasks.reduce((sum, task) => sum + task.progress * task.weight, 0);
    const overallProgress = totalWeight ? Math.round(weightedProgress / totalWeight) : 0;
    const delayedTasks = this.tasks.filter((task) => isTaskDelayed(task)).length;
    const active = this.risks.filter(isRiskActive);
    return Object.freeze({
      totalTasks: this.tasks.length,
      completedTasks: this.tasks.filter((task) => task.status === "completed" || task.progress >= 100).length,
      delayedTasks,
      overallProgress,
      totalRisks: this.risks.length,
      activeRisks: active.length,
      highRisks: active.filter((risk) => risk.level === "high" || risk.level === "critical").length,
      overdueRisks: active.filter((risk) => isRiskOverdue(risk)).length,
      tasks: Object.freeze(this.tasks.slice(0, SNAPSHOT_LIMIT).map((task) => Object.freeze({ ...task }))),
      risks: Object.freeze(this.risks.slice(0, SNAPSHOT_LIMIT).map((risk) => Object.freeze({ ...risk }))),
    });
  }

  subscribeOverview(listener: ProjectControlOverviewListener) {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    try { listener(this.getOverviewSnapshot()); } catch (error) { this.report("项目管控订阅", error); }
    return () => this.listeners.delete(listener);
  }

  locateTask(id: string) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return this.setStatus("任务已不存在", true);
    this.showPane("progress");
    this.highlightItem(`progress:${id}`);
    if (task.layerId) void this.locateLayer(task.layerId, `任务“${task.name}”`);
    else this.setStatus(`已选中任务“${task.name}”；该任务未关联场景图层`);
  }

  locateRisk(id: string) {
    const risk = this.risks.find((item) => item.id === id);
    if (!risk) return this.setStatus("风险记录已不存在", true);
    this.showPane("risk");
    this.highlightItem(`risk:${id}`);
    if (risk.layerId) void this.locateLayer(risk.layerId, `风险“${risk.name}”`);
    else this.setStatus(`已选中风险“${risk.name}”；该风险未关联场景图层`);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      try { cleanup(); } catch { /* isolated listener cleanup */ }
    }
    this.listeners.clear();
  }

  private bindUi() {
    this.root.querySelectorAll<HTMLButtonElement>("[data-project-control-tab]").forEach((button) => {
      this.listen(button, "click", () => this.showPane(button.dataset.projectControlTab === "risk" ? "risk" : "progress"));
    });
    this.listenNode("sandProgressCreate", "click", () => this.openTaskForm());
    this.listenNode("sandProgressCancel", "click", () => this.closeForm("sandProgressForm"));
    this.listenNode("sandRiskCreate", "click", () => this.openRiskForm());
    this.listenNode("sandRiskCancel", "click", () => this.closeForm("sandRiskForm"));
    this.listenNode("sandProgressFilter", "change", () => this.renderTasks());
    this.listenNode("sandProgressSearch", "input", () => this.renderTasks());
    this.listenNode("sandRiskFilter", "change", () => this.renderRisks());
    this.listenNode("sandRiskSearch", "input", () => this.renderRisks());
    const taskForm = this.node<HTMLFormElement>("sandProgressForm");
    if (taskForm) this.listen(taskForm, "submit", (event) => { event.preventDefault(); this.saveTaskFromForm(); });
    const riskForm = this.node<HTMLFormElement>("sandRiskForm");
    if (riskForm) this.listen(riskForm, "submit", (event) => { event.preventDefault(); this.saveRiskFromForm(); });
    const taskList = this.node<HTMLElement>("sandProgressList");
    if (taskList) this.listen(taskList, "click", (event) => this.handleTaskAction(event));
    const riskList = this.node<HTMLElement>("sandRiskList");
    if (riskList) this.listen(riskList, "click", (event) => this.handleRiskAction(event));
  }

  private render() {
    this.renderTasks();
    this.renderRisks();
    this.renderStats();
  }

  private renderStats() {
    const snapshot = this.getOverviewSnapshot();
    this.setText("sandProgressOverall", `${snapshot.overallProgress}%`);
    this.setText("sandProgressTaskTotal", snapshot.totalTasks);
    this.setText("sandProgressTaskDone", snapshot.completedTasks);
    this.setText("sandProgressTaskDelayed", snapshot.delayedTasks);
    this.setText("sandRiskActive", snapshot.activeRisks);
    this.setText("sandRiskHigh", snapshot.highRisks);
    this.setText("sandRiskOverdue", snapshot.overdueRisks);
    this.setText("sandRiskClosed", this.risks.filter((risk) => risk.status === "closed" || risk.status === "resolved").length);
    this.setText("sandRiskTabBadge", snapshot.highRisks);
  }

  private renderTasks() {
    const root = this.node<HTMLElement>("sandProgressList");
    if (!root) return;
    root.replaceChildren();
    const filter = this.node<HTMLSelectElement>("sandProgressFilter")?.value ?? "all";
    const keyword = (this.node<HTMLInputElement>("sandProgressSearch")?.value ?? "").trim().toLocaleLowerCase().slice(0, 80);
    const visible = this.tasks.filter((task) => {
      if (keyword && !`${task.name} ${task.owner} ${task.notes}`.toLocaleLowerCase().includes(keyword)) return false;
      if (filter === "active" && task.status !== "in-progress" && task.status !== "not-started") return false;
      if (filter === "delayed" && !isTaskDelayed(task)) return false;
      if (filter === "completed" && task.status !== "completed") return false;
      if (filter === "paused" && task.status !== "paused") return false;
      return true;
    });
    for (const task of visible.slice(0, SNAPSHOT_LIMIT)) root.append(this.taskRow(task));
    const empty = this.node<HTMLElement>("sandProgressEmpty");
    if (empty) { empty.hidden = visible.length > 0; empty.textContent = this.tasks.length ? "当前筛选条件下没有任务" : "尚未建立项目进度任务"; }
  }

  private taskRow(task: ProgressTask) {
    const delayed = isTaskDelayed(task);
    const row = document.createElement("article");
    row.className = `sand-control-item${delayed ? " is-delayed" : ""}`;
    row.dataset.projectControlId = `progress:${task.id}`;
    const header = document.createElement("div"); header.className = "sand-control-item__header";
    const name = document.createElement("strong"); name.textContent = task.name;
    const badge = document.createElement("span"); badge.className = delayed ? "danger" : task.status; badge.textContent = delayed ? "已延期" : taskStatusLabel[task.status];
    header.append(name, badge);
    const dates = document.createElement("small"); dates.textContent = `${task.planStart} 至 ${task.planEnd} · ${task.owner || "未指定责任人"}`;
    const progress = document.createElement("div"); progress.className = "sand-control-progress";
    const bar = document.createElement("i"); bar.style.width = `${task.progress}%`;
    const value = document.createElement("b"); value.textContent = `${task.progress}%`;
    progress.append(bar, value);
    const actions = this.actionRow(task.id, Boolean(task.layerId), ["locate", "edit", "delete"]);
    row.append(header, dates, progress, actions);
    return row;
  }

  private renderRisks() {
    const root = this.node<HTMLElement>("sandRiskList");
    if (!root) return;
    root.replaceChildren();
    const filter = this.node<HTMLSelectElement>("sandRiskFilter")?.value ?? "active";
    const keyword = (this.node<HTMLInputElement>("sandRiskSearch")?.value ?? "").trim().toLocaleLowerCase().slice(0, 80);
    const visible = this.risks.filter((risk) => {
      if (keyword && !`${risk.name} ${risk.owner} ${risk.category} ${risk.description} ${risk.measure}`.toLocaleLowerCase().includes(keyword)) return false;
      if (filter === "active" && !isRiskActive(risk)) return false;
      if (filter === "high" && (!isRiskActive(risk) || (risk.level !== "high" && risk.level !== "critical"))) return false;
      if (filter === "overdue" && !isRiskOverdue(risk)) return false;
      if (filter === "closed" && risk.status !== "closed" && risk.status !== "resolved") return false;
      return true;
    });
    for (const risk of visible.slice(0, SNAPSHOT_LIMIT)) root.append(this.riskRow(risk));
    const empty = this.node<HTMLElement>("sandRiskEmpty");
    if (empty) empty.hidden = visible.length > 0;
  }

  private riskRow(risk: ProjectRisk) {
    const overdue = isRiskOverdue(risk);
    const row = document.createElement("article");
    row.className = `sand-control-item sand-risk-item level-${risk.level}${overdue ? " is-overdue" : ""}`;
    row.dataset.projectControlId = `risk:${risk.id}`;
    const header = document.createElement("div"); header.className = "sand-control-item__header";
    const name = document.createElement("strong"); name.textContent = risk.name;
    const badge = document.createElement("span"); badge.className = `level-${risk.level}`; badge.textContent = `${riskLevelLabel[risk.level]}风险`;
    header.append(name, badge);
    const meta = document.createElement("small"); meta.textContent = `${risk.category} · ${riskStatusLabel[risk.status]} · 期限 ${risk.dueDate}${overdue ? "（已逾期）" : ""}`;
    const owner = document.createElement("p"); owner.textContent = `责任人：${risk.owner || "未指定"}${risk.measure ? ` · 措施：${risk.measure}` : ""}`;
    const actionNames = isRiskActive(risk) ? ["locate", "handle", "close", "edit", "delete"] : ["locate", "edit", "delete"];
    row.append(header, meta, owner, this.actionRow(risk.id, Boolean(risk.layerId), actionNames));
    return row;
  }

  private actionRow(id: string, canLocate: boolean, actions: string[]) {
    const root = document.createElement("div"); root.className = "sand-control-item__actions";
    const labels: Record<string, string> = { locate: "定位", edit: "编辑", delete: "删除", handle: "处置", close: "关闭" };
    for (const action of actions) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.action = action; button.dataset.id = id; button.textContent = labels[action] ?? action;
      if (action === "delete") button.className = "danger";
      if (action === "locate" && !canLocate) { button.disabled = true; button.title = "尚未关联场景图层"; }
      root.append(button);
    }
    return root;
  }

  private handleTaskAction(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-action][data-id]");
    if (!button) return;
    const id = button.dataset.id ?? "";
    if (button.dataset.action === "locate") this.locateTask(id);
    if (button.dataset.action === "edit") this.openTaskForm(this.tasks.find((task) => task.id === id));
    if (button.dataset.action === "delete") this.deleteTask(id);
  }

  private handleRiskAction(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-action][data-id]");
    if (!button) return;
    const id = button.dataset.id ?? "";
    const risk = this.risks.find((item) => item.id === id);
    if (!risk) return;
    if (button.dataset.action === "locate") this.locateRisk(id);
    if (button.dataset.action === "edit") this.openRiskForm(risk);
    if (button.dataset.action === "delete") this.deleteRisk(id);
    if (button.dataset.action === "handle") this.patchRiskStatus(id, "handling");
    if (button.dataset.action === "close") this.patchRiskStatus(id, "closed");
  }

  private saveTaskFromForm() {
    const name = cleanText(this.value("sandProgressName"), 120);
    const planStart = cleanDate(this.value("sandProgressStart"));
    const planEnd = cleanDate(this.value("sandProgressEnd"));
    if (!name || !planStart || !planEnd) return this.setStatus("请完整填写任务名称和计划日期", true);
    if (planStart > planEnd) return this.setStatus("计划完成日期不能早于计划开始日期", true);
    const existingId = cleanText(this.value("sandProgressId"), 128);
    const existing = this.tasks.find((task) => task.id === existingId);
    if (!existing && this.tasks.length >= MAX_TASKS) return this.setStatus(`任务数量已达到 ${MAX_TASKS} 条上限`, true);
    const now = new Date().toISOString();
    const progress = boundedInteger(this.value("sandProgressValue"), 0, 100, 0);
    const task = safeTask({
      id: existing?.id ?? createId("progress"), name, planStart, planEnd, progress,
      weight: boundedInteger(this.value("sandProgressWeight"), 1, 100, 1),
      status: progress >= 100 ? "completed" : this.value("sandProgressStatus"),
      owner: this.value("sandProgressOwner"), layerId: this.value("sandProgressLayer"), notes: this.value("sandProgressNotes"),
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    });
    if (!task) return this.setStatus("任务数据校验失败", true);
    this.tasks = existing ? this.tasks.map((item) => item.id === existing.id ? task : item) : [task, ...this.tasks];
    this.commit(existing ? "任务已更新" : "任务已创建");
    this.closeForm("sandProgressForm");
  }

  private saveRiskFromForm() {
    const name = cleanText(this.value("sandRiskName"), 120);
    const dueDate = cleanDate(this.value("sandRiskDueDate"));
    if (!name || !dueDate) return this.setStatus("请完整填写风险名称和整改期限", true);
    const existingId = cleanText(this.value("sandRiskId"), 128);
    const existing = this.risks.find((risk) => risk.id === existingId);
    if (!existing && this.risks.length >= MAX_RISKS) return this.setStatus(`风险数量已达到 ${MAX_RISKS} 条上限`, true);
    const now = new Date().toISOString();
    const risk = safeRisk({
      id: existing?.id ?? createId("risk"), name, dueDate, category: this.value("sandRiskCategory"), level: this.value("sandRiskLevel"),
      status: this.value("sandRiskStatus"), owner: this.value("sandRiskOwner"), layerId: this.value("sandRiskLayer"),
      description: this.value("sandRiskDescription"), measure: this.value("sandRiskMeasure"),
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    });
    if (!risk) return this.setStatus("风险数据校验失败", true);
    this.risks = existing ? this.risks.map((item) => item.id === existing.id ? risk : item) : [risk, ...this.risks];
    this.commit(existing ? "风险记录已更新" : "风险记录已创建");
    this.closeForm("sandRiskForm");
  }

  private deleteTask(id: string) {
    const next = this.tasks.filter((task) => task.id !== id);
    if (next.length === this.tasks.length) return;
    this.tasks = next; this.commit("任务已删除");
  }

  private deleteRisk(id: string) {
    const next = this.risks.filter((risk) => risk.id !== id);
    if (next.length === this.risks.length) return;
    this.risks = next; this.commit("风险记录已删除");
  }

  private patchRiskStatus(id: string, status: RiskStatus) {
    const now = new Date().toISOString();
    this.risks = this.risks.map((risk) => risk.id === id ? Object.freeze({ ...risk, status, updatedAt: now }) : risk);
    this.commit(status === "closed" ? "风险已关闭并计入闭环" : "风险已转入处置中");
  }

  private openTaskForm(task?: ProgressTask) {
    const form = this.node<HTMLFormElement>("sandProgressForm"); if (!form) return;
    form.hidden = false;
    this.setValue("sandProgressId", task?.id ?? ""); this.setValue("sandProgressName", task?.name ?? "");
    this.setValue("sandProgressStart", task?.planStart ?? dateKey()); this.setValue("sandProgressEnd", task?.planEnd ?? dateKey());
    this.setValue("sandProgressValue", task?.progress ?? 0); this.setValue("sandProgressWeight", task?.weight ?? 1);
    this.setValue("sandProgressStatus", task?.status ?? "not-started"); this.setValue("sandProgressOwner", task?.owner ?? "");
    this.setValue("sandProgressLayer", task?.layerId ?? ""); this.setValue("sandProgressNotes", task?.notes ?? "");
    this.node<HTMLInputElement>("sandProgressName")?.focus();
  }

  private openRiskForm(risk?: ProjectRisk) {
    const form = this.node<HTMLFormElement>("sandRiskForm"); if (!form) return;
    form.hidden = false;
    this.setValue("sandRiskId", risk?.id ?? ""); this.setValue("sandRiskName", risk?.name ?? ""); this.setValue("sandRiskCategory", risk?.category ?? "安全");
    this.setValue("sandRiskLevel", risk?.level ?? "medium"); this.setValue("sandRiskStatus", risk?.status ?? "open");
    this.setValue("sandRiskOwner", risk?.owner ?? ""); this.setValue("sandRiskDueDate", risk?.dueDate ?? dateKey()); this.setValue("sandRiskLayer", risk?.layerId ?? "");
    this.setValue("sandRiskDescription", risk?.description ?? ""); this.setValue("sandRiskMeasure", risk?.measure ?? "");
    this.node<HTMLInputElement>("sandRiskName")?.focus();
  }

  private closeForm(id: string) {
    const form = this.node<HTMLFormElement>(id); if (!form) return;
    form.reset(); form.hidden = true;
  }

  private showPane(name: "progress" | "risk") {
    this.root.querySelectorAll<HTMLElement>("[data-project-control-pane]").forEach((pane) => {
      const active = pane.dataset.projectControlPane === name; pane.hidden = !active; pane.classList.toggle("active", active);
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-project-control-tab]").forEach((button) => {
      const active = button.dataset.projectControlTab === name; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
    });
  }

  private renderLayerOptions(id: string) {
    const select = this.node<HTMLSelectElement>(id); if (!select) return;
    const current = select.value;
    select.replaceChildren(new Option("不关联场景图层", ""));
    for (const layer of this.layers) select.add(new Option(`${layer.name} · ${layer.kind}${layer.visible ? "" : "（隐藏）"}`, layer.id));
    if (current && !this.layers.some((layer) => layer.id === current)) select.add(new Option("原关联图层已移除", current));
    select.value = current;
  }

  private async locateLayer(id: string, label: string) {
    try { await this.options.locateLayer(id); this.setStatus(`已在沙盘定位${label}`); }
    catch (error) { this.setStatus(error instanceof Error ? error.message : "场景定位失败", true); this.report("关联图层定位", error); }
  }

  private highlightItem(id: string) {
    const selector = `[data-project-control-id="${CSS.escape(id)}"]`;
    const row = this.root.querySelector<HTMLElement>(selector);
    if (!row) return;
    row.classList.remove("is-selected"); void row.offsetWidth; row.classList.add("is-selected"); row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private commit(message: string) {
    const persisted = this.persist();
    this.render();
    this.setStatus(persisted ? message : `${message}；仅在当前会话保存`, !persisted);
    this.notify();
  }

  private restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey); if (!raw || raw.length > MAX_STORAGE_LENGTH) return;
      const value = JSON.parse(raw) as Partial<StoredState>;
      if (value.version !== 1) return;
      const ids = new Set<string>();
      const tasks: ProgressTask[] = [];
      for (const valueTask of (Array.isArray(value.tasks) ? value.tasks : []).slice(0, MAX_TASKS)) {
        const task = safeTask(valueTask);
        if (!task || ids.has(task.id)) continue;
        ids.add(task.id);
        tasks.push(task);
      }
      const risks: ProjectRisk[] = [];
      for (const valueRisk of (Array.isArray(value.risks) ? value.risks : []).slice(0, MAX_RISKS)) {
        const risk = safeRisk(valueRisk);
        if (!risk || ids.has(risk.id)) continue;
        ids.add(risk.id);
        risks.push(risk);
      }
      this.tasks = tasks;
      this.risks = risks;
    } catch (error) { this.report("恢复项目管控数据", error); }
  }

  private persist() {
    if (!this.storage) return false;
    try {
      const payload = JSON.stringify({ version: 1, tasks: this.tasks, risks: this.risks } satisfies StoredState);
      if (payload.length > MAX_STORAGE_LENGTH) throw new Error("本机项目管控目录超过容量限制");
      this.storage.setItem(this.storageKey, payload);
      return true;
    } catch (error) {
      this.report("保存项目管控数据", error);
      return false;
    }
  }

  private notify() {
    const snapshot = this.getOverviewSnapshot();
    for (const listener of this.listeners) { try { listener(snapshot); } catch (error) { this.report("通知项目管控概览", error); } }
  }

  private setStatus(message: string, error = false) {
    const node = this.node<HTMLElement>("sandProjectControlStatus"); if (!node) return;
    node.textContent = cleanText(message, 160, error ? "操作失败" : "已更新"); node.classList.toggle("error", error);
  }

  private value(id: string) { return this.node<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id)?.value ?? ""; }
  private setValue(id: string, value: string | number) { const node = this.node<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id); if (node) node.value = String(value); }
  private setText(id: string, value: string | number) { const node = this.node<HTMLElement>(id); if (node) node.textContent = String(value); }
  private node<T extends Element>(id: string) { return this.root.querySelector<T>(`#${id}`); }
  private listenNode(id: string, type: string, listener: EventListener) { const node = this.node<HTMLElement>(id); if (node) this.listen(node, type, listener); }
  private listen(target: EventTarget, type: string, listener: EventListener) { target.addEventListener(type, listener); this.cleanups.push(() => target.removeEventListener(type, listener)); }
  private report(context: string, error: unknown) { console.warn(`[Sand table project control] ${context}`, error); }
}
