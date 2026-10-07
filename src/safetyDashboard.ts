import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { SafetyAlert, SafetyDataset, SafetyMedia, SafetyNode, SafetyProvenance, SafetySelection, SafetyState, SafetyView } from "./safetyTypes";
import { applySafetyVisualTokens, safetyVisualTokens } from "./safetyVisualConfig";
import "./safetyDashboard.css";

echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer]);

export type SafetyDashboardLayer = { id: string; name: string; kind: string; visible: boolean };
export type SafetyDashboardOptions = {
  onSelect(selection: SafetySelection): void;
  onPatch(patch: Partial<SafetyState>): void;
  onExit(): void;
  onEarth(): void;
  onMedia(media: SafetyMedia): void;
  onVideoSettings?(): void;
  onAuthoring?(): void;
  onRefresh(): void;
  onLayerToggle(id: string, visible: boolean): void;
};

const provenanceNames: Record<SafetyProvenance, string> = { real: "真实数据", derived: "源数据推导", demo: "演示数据", user: "用户标绘" };
const severityNames = { high: "高风险", medium: "中风险", low: "低风险" };
const statusNames = { open: "待处置", rectifying: "整改中", closed: "已闭环" };
const kindNames = { project: "项目", section: "施工区段", pier: "桥墩", component: "构件" };
const componentNames = { cap: "盖梁", column: "墩柱", footing: "承台", pile: "桩基" };
const layerNames: Record<keyof SafetyState["layers"], string> = {
  boundary: "区段边界", markers: "点位标签", track: "实际航迹", heat: "隐患热力", effects: "动态特效", links: "展示连线",
};
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const timeText = (value: number, full = false) => Number.isFinite(value)
  ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(full ? { second: "2-digit" } : {}) }).format(new Date(value))
  : "时间未接入";
const clockText = (value: number) => Number.isFinite(value)
  ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value))
  : "--:--:--";
const badge = (source: SafetyProvenance) => `<span class="safety-source safety-source-${source}">${provenanceNames[source]}</span>`;
const empty = (text: string) => `<div class="safety-empty">${escapeHtml(text)}</div>`;

function safeMediaUrl(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

/** A dashboard shell over the existing Viewer. It never creates a Viewer or media decoder. */
export class SafetyDashboard {
  readonly videoHost: HTMLDivElement;
  private readonly root: HTMLDivElement;
  private readonly options: SafetyDashboardOptions;
  private readonly trend: echarts.ECharts;
  private readonly distribution: echarts.ECharts;
  private readonly observer: ResizeObserver;
  private readonly onClickBound: (event: MouseEvent) => void;
  private readonly onChangeBound: (event: Event) => void;
  private readonly onInputBound: (event: Event) => void;
  private dataset?: SafetyDataset;
  private state?: SafetyState;
  private view?: SafetyView;
  private lastDataset?: SafetyDataset;
  private lastRenderKey = "";
  private lastLayersKey = "";
  private visible = true;
  private disposed = false;
  private updateCount = 0;
  private renderCount = 0;
  private videoStatus = "选择已关联的视频以显示既有播放预览";
  private activeTab: "overview" | "tasks" | "risks" = "overview";

  constructor(host: HTMLElement, options: SafetyDashboardOptions) {
    this.options = options;
    this.root = document.createElement("div");
    this.root.className = "safety-dashboard";
    applySafetyVisualTokens(this.root);
    const layout = safetyVisualTokens.layout;
    for (const [name, value] of Object.entries({ margin: layout.left.x, "panel-width": layout.left.width, "header-top": layout.header.y, "header-height": layout.header.height, "panel-top": layout.left.y, "stage-top": layout.stage.y, "stage-gap": layout.stage.x - layout.left.x - layout.left.width, "footer-height": layout.footer.height, "footer-bottom": safetyVisualTokens.referenceViewport.height - layout.footer.y - layout.footer.height, "panel-bottom": safetyVisualTokens.referenceViewport.height - layout.left.bottom })) this.root.style.setProperty(`--safety-${name}`, `${value}px`);
    this.root.dataset.mode = "presentation";
    this.root.setAttribute("aria-label", "邻近营业线施工安全巡检大屏");
    this.root.innerHTML = `
      <header class="safety-header">
        <nav class="safety-topnav" aria-label="巡检工作导航"><button type="button" class="is-active" data-action="tab" data-tab="overview">项目总览</button><button type="button" data-action="tab" data-tab="tasks">巡检任务</button><button type="button" data-action="tab" data-tab="risks">风险态势</button></nav>
        <div class="safety-brand"><h1>邻近营业线施工安全巡检</h1><span>RAILWAY CONSTRUCTION · DIGITAL TWIN</span></div>
        <div class="safety-header-actions"><button type="button" data-action="authoring">区域与风险标绘</button><button class="safety-workbench-button" type="button" data-action="exit">原有工作台 ↗</button></div>
      </header>
      <div class="safety-sidebar-toggles"><button type="button" data-action="sidebar-toggle" data-side="left" aria-expanded="false">☰ 项目与任务</button><button type="button" data-action="sidebar-toggle" data-side="right" aria-expanded="false">现场与风险 ☰</button></div>
      <aside class="safety-panel safety-left" aria-label="项目与施工点位">
        <section class="safety-card safety-overview-card"><div class="safety-card-heading"><h2>项目运行概况</h2><button type="button" data-action="refresh" class="safety-icon-button" title="重新读取工程资料" aria-label="刷新项目数据">↻</button></div><div class="safety-card-body safety-panel-scroll"><h3 data-ref="projectName" class="safety-project-name">工程数字孪生</h3><div class="safety-project-subline"><span data-ref="projectSource"></span><span class="safety-status"><i></i><span data-ref="connection">正在载入</span></span></div><div data-ref="metrics" class="safety-metrics"></div><details class="safety-data-notes"><summary>数据来源与工程基准 <span>＋</span></summary><div data-ref="sourceNotes"></div></details></div></section>
        <section class="safety-card safety-hierarchy-card" data-ref="hierarchySection"><div class="safety-card-heading"><h2>施工区段与构件</h2></div><div class="safety-card-body safety-panel-scroll"><div class="safety-section-caption"><span data-ref="hierarchyCount"></span><span>按源数据定位</span></div><div data-ref="hierarchy" class="safety-node-list"></div></div></section>
        <section class="safety-card safety-tasks-card" data-ref="tasksSection"><div class="safety-card-heading"><h2>巡检任务与趋势</h2><span data-ref="taskCount"></span></div><div class="safety-card-body safety-panel-scroll"><details class="safety-task-disclosure" data-ref="taskDisclosure"><summary>巡检任务列表 <span>展开查看 ⌄</span></summary><div data-ref="tasks" class="safety-task-list"></div></details><details class="safety-trend-disclosure" data-ref="trendDisclosure" open><summary>隐患事件趋势 <span>单位：条</span></summary><div data-ref="trend" class="safety-chart safety-trend-chart" role="img" aria-label="当前隐患事件趋势，点击时段筛选"></div></details></div></section>
      </aside>
      <div class="safety-scene-hud"><div class="safety-scene-toolbar"><div data-ref="breadcrumbs" class="safety-breadcrumbs" aria-label="项目层级导航"></div><div class="safety-scene-actions"><button type="button" data-action="earth">◎ 地球</button><button type="button" data-action="locate">⌖ 定位</button></div></div><div class="safety-scene-caption"><span class="safety-live-dot"></span><span data-ref="sceneCaption">三维工程现场</span><span data-ref="coordinateSummary" class="safety-coordinate-summary">真实坐标场景</span></div><div class="safety-scene-bottom"><div class="safety-selected-card"><span class="safety-eyebrow">当前选中对象</span><strong data-ref="selectedName">项目总览</strong><div data-ref="selectedMeta" class="safety-selected-meta"></div></div><div data-ref="heatLegend" class="safety-heat-legend" hidden><span>隐患事件密度</span><b>位置邻域 · 事件条数</b><div></div><small>低<span>高</span></small></div></div><div class="safety-notice" data-ref="notice" role="status" hidden></div></div>
      <aside class="safety-panel safety-right" aria-label="现场视频与风险处置">
        <section class="safety-card safety-video-card"><div class="safety-card-heading"><h2>现场画面联动</h2><button type="button" class="safety-video-badge" data-action="video-settings">视频设置 ↗</button></div><div class="safety-card-body safety-panel-scroll"><div data-ref="videoHost" class="safety-video-host"><div class="safety-video-empty"><span aria-hidden="true">▷</span><strong>暂无对象关联视频</strong><p>选择已绑定媒体的对象查看</p></div></div><p class="safety-video-status" data-ref="videoStatus"></p><div data-ref="videoChoices" class="safety-video-choices"></div></div></section>
        <section class="safety-card safety-risk-card" data-ref="riskSection"><div class="safety-card-heading"><h2 data-ref="riskHeading">风险与选中详情</h2><span data-ref="alertCount"></span></div><div class="safety-card-body safety-panel-scroll"><details class="safety-risk-disclosure" data-ref="riskDisclosure" open><summary>告警列表与筛选 <span>⌄</span></summary><div class="safety-risk-tools"><label class="safety-filter-label"><select data-action="severity" aria-label="风险等级筛选"><option value="all">全部风险</option><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option></select></label><label class="safety-check-label"><input type="checkbox" data-action="include-demo">含演示</label></div><div class="safety-risk-summary"><div data-ref="distribution" class="safety-chart safety-distribution-chart" role="img" aria-label="隐患风险分布，点击扇区筛选"></div><div data-ref="riskSummary" class="safety-risk-summary-text"></div></div><div data-ref="alerts" class="safety-alert-list"></div></details><div class="safety-selected-detail"><div data-ref="detailSource" class="safety-detail-source"></div><div data-ref="detail" class="safety-detail"></div><div data-ref="media" class="safety-media"></div></div></div></section>
        <section class="safety-card safety-devices-card"><div class="safety-card-heading"><h2>设备与飞行状态</h2></div><div class="safety-card-body safety-panel-scroll"><div class="safety-section-caption"><span data-ref="deviceCount"></span><span>依实录数据回放</span></div><div data-ref="devices" class="safety-device-list"></div></div></section>
      </aside>
      <footer class="safety-bottom"><div class="safety-mode-switch" role="group" aria-label="显示模式"><button type="button" data-action="mode" data-mode="presentation" class="is-active">汇报展示</button><button type="button" data-action="mode" data-mode="inspection">现场巡检</button></div><div class="safety-playback"><button type="button" class="safety-play-button" data-action="play" aria-label="开始历史回放" title="历史回放播放，与装饰动画独立">▶</button><div class="safety-playback-body"><div class="safety-time-labels"><span><b data-ref="playbackTime">--:--:--</b><small>历史回放</small></span><span data-ref="timeRangeLabel"></span></div><input class="safety-timeline" type="range" data-action="time" min="0" max="1" value="0" step="1" aria-label="历史回放时刻"></div></div><div class="safety-bottom-actions"><button type="button" data-action="motion-toggle" aria-pressed="false">暂停装饰</button><button type="button" data-action="cruise" aria-pressed="false">自动巡游</button><details class="safety-popover safety-time-popover"><summary>时间范围 ⌃</summary><div class="safety-popover-body"><h3>筛选时间范围</h3><label>开始<input type="range" data-action="range-start" aria-label="筛选开始时间"><output data-ref="rangeStart"></output></label><label>结束<input type="range" data-action="range-end" aria-label="筛选结束时间"><output data-ref="rangeEnd"></output></label><button type="button" data-action="range-reset">恢复全部时间</button><p class="safety-footnote">场景、统计、任务及告警共用此范围。</p></div></details><details class="safety-popover safety-layer-popover"><summary>图层与标注 ⌃</summary><div class="safety-popover-body"><h3>当前对象工程标注</h3><label class="safety-layer"><input type="checkbox" data-action="engineering-annotations"><span>显示选中对象标注</span></label><p class="safety-footnote">仅当前所选对象；切换对象后恢复简洁显示。</p><h3>巡检场景图层</h3><div data-ref="effectLayers" class="safety-layer-list"></div><label class="safety-opacity">热力透明度<input type="range" min="0.1" max="1" step="0.05" value="0.65" data-action="opacity" aria-label="热力透明度"></label><h3>已加载工程资料</h3><div data-ref="libraryLayers" class="safety-layer-list"></div></div></details></div></footer>`;
    host.append(this.root);
    this.videoHost = this.ref<HTMLDivElement>("videoHost");
    this.ref("videoStatus").textContent = this.videoStatus;
    this.ref("libraryLayers").innerHTML = empty("尚无已加载工程图层");
    this.trend = echarts.init(this.ref("trend"), undefined, { renderer: "canvas" });
    this.distribution = echarts.init(this.ref("distribution"), undefined, { renderer: "canvas" });
    this.trend.on("click", (params) => {
      const data = params.data as { range?: [number, number] } | undefined;
      if (data?.range) this.options.onPatch({ timeRange: data.range, time: data.range[0], playing: false });
    });
    this.distribution.on("click", (params) => {
      const severity = params.name === "高风险" ? "high" : params.name === "中风险" ? "medium" : params.name === "低风险" ? "low" : undefined;
      if (severity) this.options.onPatch({ severity: this.state?.severity === severity ? "all" : severity });
    });
    this.observer = new ResizeObserver(() => {
      if (!this.visible || this.disposed) return;
      this.trend.resize();
      this.distribution.resize();
    });
    this.observeCharts();
    this.onClickBound = (event) => this.handleClick(event);
    this.onChangeBound = (event) => this.handleChange(event);
    this.onInputBound = (event) => this.handleInput(event);
    this.root.addEventListener("click", this.onClickBound);
    this.root.addEventListener("change", this.onChangeBound);
    this.root.addEventListener("input", this.onInputBound);
  }

  private ref<T extends HTMLElement = HTMLElement>(name: string): T {
    const result = this.root.querySelector<T>(`[data-ref="${name}"]`);
    if (!result) throw new Error(`SafetyDashboard missing ${name}`);
    return result;
  }

  private observeCharts(): void {
    this.observer.observe(this.ref("trend"));
    this.observer.observe(this.ref("distribution"));
  }

  update(dataset: SafetyDataset, state: SafetyState, view: SafetyView): void {
    if (this.disposed) return;
    this.updateCount++;
    this.dataset = dataset;
    this.state = state;
    this.view = view;
    this.updatePlayback();
    const key = JSON.stringify([state.selectedId, state.selectedAlertId, state.mode, state.severity, state.timeRange, state.includeDemo, state.layers, state.engineeringAnnotations]);
    if (key === this.lastRenderKey && dataset === this.lastDataset) return;
    this.lastRenderKey = key;
    this.lastDataset = dataset;
    if (!this.visible) return;
    this.renderCount++;
    this.root.dataset.mode = state.mode;
    this.root.dataset.selection = state.selectedAlertId ? "alert" : view.selected.kind === "project" ? "overview" : "object";
    this.ref("riskHeading").textContent = state.selectedAlertId ? "告警详情与处置" : view.selected.kind === "project" ? "风险与选中详情" : "所选对象与资料";
    this.ref<HTMLDetailsElement>("riskDisclosure").open = view.selected.kind === "project" && !state.selectedAlertId;
    this.ref("projectName").textContent = dataset.name;
    this.ref("projectName").title = dataset.name;
    this.ref("projectSource").innerHTML = badge(dataset.nodes.find((node) => node.id === dataset.projectId)?.provenance ?? "derived");
    this.ref("connection").textContent = "项目已载入";
    if (!this.root.classList.contains("has-error")) this.ref("notice").hidden = true;
    this.ref("breadcrumbs").innerHTML = view.breadcrumbs.map((node, index) => `${index ? '<span class="safety-breadcrumb-divider">/</span>' : ""}<button type="button" data-action="select" data-node="${escapeHtml(node.id)}" ${index === view.breadcrumbs.length - 1 ? 'aria-current="location"' : ""}>${escapeHtml(node.name)}</button>`).join("");
    this.ref("sceneCaption").textContent = `${kindNames[view.selected.kind]}视角 · ${state.mode === "presentation" ? "汇报展示" : "现场巡检"}`;
    this.ref("coordinateSummary").textContent = "工程模型保持真实坐标 / 标高";
    this.ref("coordinateSummary").title = dataset.coordinateNote;
    this.ref("selectedName").textContent = view.selected.name;
    this.ref("selectedMeta").innerHTML = `${badge(view.selected.provenance)}<span title="${escapeHtml(view.selected.id)}">${view.selected.sourceEntityIndex !== undefined ? "CAD 来源定位点" : kindNames[view.selected.kind]}</span>`;
    this.ref("heatLegend").hidden = !state.layers.heat;
    this.renderMetrics(view);
    this.renderHierarchy(view);
    this.renderTasks(view);
    this.renderDevices(view);
    this.renderAlerts(view);
    this.renderDetail(view);
    this.renderNotes(dataset);
    this.renderLayers(state);
    this.renderFilters(state, dataset);
    this.renderCharts(view, state);
    this.renderTab();
  }

  private renderMetrics(view: SafetyView): void {
    const metrics = view.metrics;
    this.ref("metrics").innerHTML = [
      ["施工点位", metrics.points, "处", ""], ["隐患事件", metrics.alerts, "条", "cyan"],
      ["高风险事件", metrics.high, "条", "amber"], ["任务完成", metrics.tasks ? `${metrics.completed}/${metrics.tasks}` : "—", "项", ""],
    ].map(([label, value, unit, tone]) => `<div class="safety-metric ${tone ? `safety-metric-${tone}` : ""}"><span>${label}</span><strong>${value}<small>${unit}</small></strong></div>`).join("");
    this.ref("riskSummary").innerHTML = `<strong>${metrics.alerts}<small>条事件</small></strong><span>当前范围 · 已接入</span><span class="safety-demo-count">${metrics.demoAlerts ? `含 ${metrics.demoAlerts} 条演示事件` : "未包含演示事件"}</span>`;
  }

  private nodeItem(node: SafetyNode, selected = false): string {
    const kind = node.spatialKind === "construction-area" ? "标绘施工区" : node.spatialKind === "railway" ? "标绘营业线" : node.spatialKind === "risk-point" ? "标绘风险点" : node.componentType ? componentNames[node.componentType] : kindNames[node.kind];
    const unavailable = node.navigationDisabledReason || (node.kind === "component" && ["cap", "column", "footing"].includes(node.componentType ?? "") && !node.modelFeatureId ? "尚未接入独立构件模型与编号映射" : undefined);
    const reason = unavailable ? `${kind} · ${unavailable}` : selected ? "当前对象" : `${kind} · ${node.kind === "component" ? "查看来源点位" : "点击进入"}`;
    return `<button type="button" class="safety-node ${selected ? "is-selected" : ""}" data-action="select" data-node="${escapeHtml(node.id)}" title="${escapeHtml(unavailable || node.id)}" ${unavailable ? 'disabled aria-disabled="true"' : ""}><span class="safety-node-symbol" aria-hidden="true">${node.kind === "section" ? "⌁" : node.kind === "pier" ? "Ⅱ" : "◇"}</span><span class="safety-node-copy"><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(reason)}</small></span><span class="safety-node-end">${badge(node.provenance)}<span aria-hidden="true">${unavailable ? "—" : "›"}</span></span></button>`;
  }

  private renderHierarchy(view: SafetyView): void {
    const children = view.children;
    this.ref("hierarchyCount").textContent = `${children.length} 个对象`;
    const current = view.selected.kind !== "project" ? this.nodeItem(view.selected, true) : "";
    this.ref("hierarchy").innerHTML = current + (children.length ? children.map((node) => this.nodeItem(node)).join("") : empty("已到达当前对象的末级，可通过上方路径返回"));
  }

  private renderTasks(view: SafetyView): void {
    this.ref("taskCount").textContent = `${view.metrics.completed} / ${view.metrics.tasks}`;
    const labels = { pending: "待执行", active: "执行中", complete: "已完成" };
    this.ref("tasks").innerHTML = view.tasks.length ? view.tasks.map((task) => `<button type="button" class="safety-task" data-action="select" data-node="${escapeHtml(task.nodeId)}"><span class="safety-task-dot ${task.status}"></span><span><strong>${escapeHtml(task.name)}</strong><small>${timeText(task.timestamp)} ${badge(task.provenance)}</small></span><em class="safety-task-state ${task.status}">${labels[task.status]}</em></button>`).join("") : empty("当前范围没有已接入的巡检任务");
  }

  private renderDevices(view: SafetyView): void {
    const labels = { replay: "轨迹回放", online: "在线", offline: "离线", unknown: "状态未接入" };
    this.ref("deviceCount").textContent = `${view.devices.length} 台已关联`;
    this.ref("devices").innerHTML = view.devices.length ? view.devices.map((device) => `<button type="button" class="safety-device" data-action="device" data-device="${escapeHtml(device.id)}" title="${escapeHtml(device.coordinateNote)}"><span class="safety-device-icon" aria-hidden="true">${device.kind === "drone" ? "✣" : "▣"}</span><span><strong>${escapeHtml(device.name)}</strong><small>${badge(device.provenance)} ${device.track.length ? `${device.track.length} 个实录坐标` : "无已接入航迹"}</small></span><em class="${device.status === "online" ? "is-online" : ""}">${labels[device.status]}</em></button>`).join("") : empty("当前对象尚未关联设备数据");
  }

  private renderAlerts(view: SafetyView): void {
    this.ref("alertCount").textContent = `${view.metrics.alerts} 条`;
    this.ref("alerts").innerHTML = view.alerts.length ? view.alerts.map((alert) => `<button type="button" class="safety-alert safety-severity-${alert.severity} ${alert.id === this.state?.selectedAlertId ? "is-selected" : ""}" data-action="alert" data-alert="${escapeHtml(alert.id)}" data-node="${escapeHtml(alert.nodeId)}"><span class="safety-alert-top"><b class="safety-severity">${severityNames[alert.severity]}</b><time>${timeText(alert.timestamp)}</time><em>${statusNames[alert.status]}</em></span><strong>${escapeHtml(alert.title)}</strong><span class="safety-alert-bottom"><span>${escapeHtml(this.dataset?.nodes.find((node) => node.id === alert.nodeId)?.name ?? alert.nodeId)}</span>${badge(alert.provenance)}</span></button>`).join("") : empty("当前筛选范围内无已接入事件");
  }

  private renderDetail(view: SafetyView): void {
    const alert = view.alerts.find((item) => item.id === this.state?.selectedAlertId);
    this.ref("detailSource").innerHTML = badge(alert?.provenance ?? view.selected.provenance);
    const position = view.selected.position;
    const coordinates = `${position.longitude.toFixed(6)}°E / ${position.latitude.toFixed(6)}°N`;
    this.ref("detail").innerHTML = alert ? this.alertDetail(alert) : `<h4>${escapeHtml(view.selected.name)}</h4><p>${escapeHtml(view.selected.description)}</p><dl><dt>唯一编号</dt><dd>${escapeHtml(view.selected.id)}</dd><dt>对象类型</dt><dd>${view.selected.componentType ? componentNames[view.selected.componentType] : kindNames[view.selected.kind]}</dd><dt>场景经纬度</dt><dd>${coordinates}</dd><dt>场景高程</dt><dd>${position.height.toFixed(2)} m</dd></dl><p class="safety-footnote">高程基准见数据来源说明；展示范围与工程尺寸分开处理。</p>`;
    const media = view.media.filter((item) => item.kind !== "video" || item.relation === "object" || view.selected.kind === "project");
    this.ref("videoChoices").innerHTML = media.filter((item) => item.kind === "video").map((item) => `<button type="button" data-action="media" data-media="${escapeHtml(item.id)}" title="${escapeHtml(item.note)}"><span aria-hidden="true">▷</span><span>${escapeHtml(item.name)}</span>${badge(item.provenance)}</button>`).join("");
    this.ref("media").innerHTML = media.length ? `<div class="safety-section-title safety-media-title"><h3>关联资料</h3><span>${media.length} 项</span></div>${media.map((item) => this.mediaItem(item)).join("")}` : '<p class="safety-footnote">当前对象尚无关联照片、视频或构件资料。</p>';
  }

  private alertDetail(alert: SafetyAlert): string {
    return `<h4>${escapeHtml(alert.title)}</h4><div class="safety-detail-tags"><span class="safety-severity-${alert.severity}">${severityNames[alert.severity]}</span><span>${statusNames[alert.status]}</span><span>${escapeHtml(alert.id)}</span></div><p>${escapeHtml(alert.description)}</p><h5>整改记录</h5>${alert.rectifications.length ? `<ol class="safety-rectifications">${alert.rectifications.map((item) => `<li><time>${timeText(item.timestamp)}</time><p>${escapeHtml(item.text)}</p></li>`).join("")}</ol>` : '<p class="safety-footnote">尚无已接入整改记录。</p>'}`;
  }

  private mediaItem(media: SafetyMedia): string {
    const url = safeMediaUrl(media.url);
    const kinds = { video: "视频", photo: "照片", drawing: "图纸", document: "资料" };
    const relation = media.relation === "object" ? "对象关联" : "项目参考";
    const body = `${media.kind === "photo" && url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(media.name)}" loading="lazy">` : `<span class="safety-media-icon" aria-hidden="true">${media.kind === "video" ? "▷" : media.kind === "drawing" ? "▧" : "▤"}</span>`}<span class="safety-media-copy"><strong>${escapeHtml(media.name)}</strong><small>${kinds[media.kind]} · ${relation} ${badge(media.provenance)}</small><span>${escapeHtml(media.note)}</span></span>`;
    if (media.kind === "video") return `<button type="button" class="safety-media-item" data-action="media" data-media="${escapeHtml(media.id)}">${body}</button>`;
    return url ? `<a class="safety-media-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${body}<span aria-label="打开资料">↗</span></a>` : `<div class="safety-media-item is-unavailable">${body}<span>待接入</span></div>`;
  }

  private renderNotes(dataset: SafetyDataset): void {
    this.ref("sourceNotes").innerHTML = `<p>${escapeHtml(dataset.coordinateNote)}</p><div class="safety-source-key">${badge("real")}${badge("derived")}${badge("user")}${badge("demo")}</div><ul>${dataset.sourceNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>${dataset.missingData.length ? `<h4>待接入 / 尚未验证</h4><ul>${dataset.missingData.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}<p>模型清晰度、视频配准精度需单独验证；本次界面展示不构成精度验证结果。</p>`;
  }

  private renderLayers(state: SafetyState): void {
    this.ref("effectLayers").innerHTML = (Object.keys(layerNames) as Array<keyof SafetyState["layers"]>).map((key) => `<label class="safety-layer"><input type="checkbox" data-action="effect-layer" data-layer="${key}" ${state.layers[key] ? "checked" : ""}><span>${layerNames[key]}</span>${key === "links" ? '<small>展示用途</small>' : ""}</label>`).join("");
  }

  private renderFilters(state: SafetyState, dataset: SafetyDataset): void {
    this.root.querySelector<HTMLSelectElement>('[data-action="severity"]')!.value = state.severity;
    this.root.querySelector<HTMLInputElement>('[data-action="include-demo"]')!.checked = state.includeDemo;
    this.root.querySelector<HTMLInputElement>('[data-action="engineering-annotations"]')!.checked = state.engineeringAnnotations;
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="mode"]').forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === state.mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
    });
    for (const [action, value, ref] of [["range-start", state.timeRange[0], "rangeStart"], ["range-end", state.timeRange[1], "rangeEnd"]] as const) {
      const input = this.root.querySelector<HTMLInputElement>(`[data-action="${action}"]`)!;
      input.min = String(dataset.timeExtent[0]);
      input.max = String(Math.max(dataset.timeExtent[0] + 1, dataset.timeExtent[1]));
      input.step = "1";
      input.value = String(value);
      this.ref(ref).textContent = timeText(value, true);
    }
    this.ref("timeRangeLabel").textContent = `${timeText(state.timeRange[0])} — ${timeText(state.timeRange[1])}`;
  }

  private updatePlayback(): void {
    const state = this.state;
    if (!state) return;
    this.ref("playbackTime").textContent = clockText(state.time);
    const slider = this.root.querySelector<HTMLInputElement>('[data-action="time"]')!;
    slider.min = String(state.timeRange[0]);
    slider.max = String(Math.max(state.timeRange[0] + 1, state.timeRange[1]));
    slider.value = String(state.time);
    slider.style.setProperty("--progress", `${Math.max(0, Math.min(100, (state.time - state.timeRange[0]) / Math.max(1, state.timeRange[1] - state.timeRange[0]) * 100))}%`);
    const play = this.root.querySelector<HTMLButtonElement>('[data-action="play"]')!;
    play.textContent = state.playing ? "Ⅱ" : "▶";
    play.setAttribute("aria-label", state.playing ? "暂停历史回放" : "开始历史回放");
    play.setAttribute("aria-pressed", String(state.playing));
    const cruise = this.root.querySelector<HTMLButtonElement>('[data-action="cruise"]')!;
    cruise.classList.toggle("is-active", state.cruise);
    cruise.setAttribute("aria-pressed", String(state.cruise));
    cruise.textContent = state.cruise ? "停止巡游" : "自动巡游";
    const motion = this.root.querySelector<HTMLButtonElement>('[data-action="motion-toggle"]')!;
    motion.textContent = state.animationPaused ? "继续装饰" : "暂停装饰";
    motion.setAttribute("aria-pressed", String(state.animationPaused));
    motion.title = "只暂停光圈、扫描与装饰流光，不改变历史回放及选中对象";
    this.root.querySelector<HTMLInputElement>('[data-action="opacity"]')!.value = String(state.heatOpacity);
  }

  private renderCharts(view: SafetyView, state: SafetyState): void {
    const span = Math.max(1, state.timeRange[1] - state.timeRange[0]);
    const bins = Array.from({ length: 8 }, (_, i) => {
      const start = state.timeRange[0] + span * i / 8;
      const end = state.timeRange[0] + span * (i + 1) / 8;
      return { value: view.alerts.filter((alert) => alert.timestamp >= start && (i === 7 ? alert.timestamp <= end : alert.timestamp < end)).length, range: [start, end] as [number, number] };
    });
    this.trend.setOption({
      animation: false, backgroundColor: "transparent", textStyle: { fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' },
      grid: { top: 12, right: 16, bottom: 26, left: 28 },
      tooltip: { trigger: "axis", confine: true, backgroundColor: safetyVisualTokens.colors.panel, borderColor: "#265675", textStyle: { color: safetyVisualTokens.colors.text, fontSize: safetyVisualTokens.typographyPx.secondaryMinimum }, valueFormatter: (value: unknown) => `${value} 条` },
      xAxis: { type: "category", boundaryGap: false, data: bins.map((bin) => clockText(bin.range[0]).slice(0, 5)), axisLine: { lineStyle: { color: "#21415b" } }, axisTick: { show: false }, axisLabel: { color: safetyVisualTokens.colors.mutedText, fontSize: safetyVisualTokens.typographyPx.secondaryMinimum, interval: 3 } },
      yAxis: { type: "value", minInterval: 1, splitNumber: 3, axisLabel: { color: safetyVisualTokens.colors.mutedText, fontSize: safetyVisualTokens.typographyPx.secondaryMinimum }, splitLine: { lineStyle: { color: "rgba(94,153,181,.10)", type: "dashed" } } },
      series: [{ name: "隐患事件", type: "line", smooth: false, symbol: "circle", symbolSize: 7, data: bins, lineStyle: { color: safetyVisualTokens.colors.cyan, width: 2 }, itemStyle: { color: safetyVisualTokens.colors.cyan, borderWidth: 2, borderColor: "#12374d" }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "rgba(44,202,228,.28)" }, { offset: 1, color: "rgba(44,202,228,.01)" }]) } }],
    }, { notMerge: true, lazyUpdate: false });
    const data = [
      { name: "高风险", value: view.metrics.high, itemStyle: { color: safetyVisualTokens.colors.attention } },
      { name: "中风险", value: view.alerts.filter((alert) => alert.severity === "medium").length, itemStyle: { color: safetyVisualTokens.colors.cyan } },
      { name: "低风险", value: view.alerts.filter((alert) => alert.severity === "low").length, itemStyle: { color: safetyVisualTokens.colors.blue } },
    ];
    this.distribution.setOption({
      animation: false, backgroundColor: "transparent", tooltip: { trigger: "item", confine: true, formatter: "{b}：{c} 条", backgroundColor: safetyVisualTokens.colors.panel, borderColor: "#265675", textStyle: { color: safetyVisualTokens.colors.text, fontSize: safetyVisualTokens.typographyPx.secondaryMinimum } },
      series: [{ name: "隐患事件", type: "pie", radius: ["66%", "86%"], center: ["50%", "50%"], avoidLabelOverlap: true, stillShowZeroSum: false, label: { show: false }, labelLine: { show: false }, itemStyle: { borderColor: "#071b2e", borderWidth: 3 }, emphasis: { scale: true, scaleSize: 3 }, emptyCircleStyle: { color: "#153348" }, data }],
    }, { notMerge: true, lazyUpdate: false });
  }

  private renderTab(): void {
    this.root.dataset.tab = this.activeTab;
    this.ref<HTMLDetailsElement>("taskDisclosure").open = this.activeTab === "tasks";
    this.ref<HTMLDetailsElement>("trendDisclosure").open = this.activeTab !== "tasks";
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="tab"]').forEach((button) => {
      const active = button.dataset.tab === this.activeTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  private handleClick(event: MouseEvent): void {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!target || !this.root.contains(target)) return;
    if (target instanceof HTMLButtonElement && target.disabled) return;
    const action = target.dataset.action;
    const state = this.state;
    if (action === "exit") this.options.onExit();
    else if (action === "refresh") this.options.onRefresh();
    else if (action === "earth") this.options.onEarth();
    else if (action === "video-settings") this.options.onVideoSettings?.();
    else if (action === "authoring") this.options.onAuthoring?.();
    else if (action === "motion-toggle" && state) this.options.onPatch({ animationPaused: !state.animationPaused });
    else if (action === "sidebar-toggle") {
      const side = target.dataset.side === "left" ? "left" : "right";
      const expanded = this.root.classList.toggle(`is-${side}-expanded`);
      target.setAttribute("aria-expanded", String(expanded));
      this.trend.resize(); this.distribution.resize();
    }
    else if (action === "select" && target.dataset.node) this.options.onSelect({ nodeId: target.dataset.node });
    else if (action === "alert" && target.dataset.node) this.options.onSelect({ nodeId: target.dataset.node, alertId: target.dataset.alert });
    else if (action === "locate" && state) this.options.onSelect({ nodeId: state.selectedId, alertId: state.selectedAlertId, fly: true });
    else if (action === "mode" && (target.dataset.mode === "presentation" || target.dataset.mode === "inspection")) this.options.onPatch({ mode: target.dataset.mode });
    else if (action === "play" && state) this.options.onPatch({ playing: !state.playing });
    else if (action === "cruise" && state) this.options.onPatch({ cruise: !state.cruise });
    else if (action === "range-reset" && this.dataset) this.options.onPatch({ timeRange: [...this.dataset.timeExtent], severity: "all", playing: false });
    else if (action === "media") {
      const media = this.dataset?.media.find((item) => item.id === target.dataset.media);
      if (media) this.options.onMedia(media);
    } else if (action === "device") {
      const device = this.dataset?.devices.find((item) => item.id === target.dataset.device);
      if (device) {
        this.options.onSelect({ nodeId: device.nodeId });
        const media = this.dataset?.media.find((item) => item.id === device.mediaId);
        if (media) this.options.onMedia(media);
      }
    } else if (action === "tab") {
      const tab = target.dataset.tab;
      if (tab === "overview" || tab === "tasks" || tab === "risks") {
        this.activeTab = tab;
        const side = tab === "risks" ? "right" : "left";
        this.root.classList.add(`is-${side}-expanded`);
        this.root.querySelector(`[data-action="sidebar-toggle"][data-side="${side}"]`)?.setAttribute("aria-expanded", "true");
        this.renderTab();
        if (tab === "overview" && this.dataset) this.options.onSelect({ nodeId: this.dataset.projectId });
        const section = tab === "tasks" ? this.ref("tasksSection") : tab === "risks" ? this.ref("riskSection") : this.ref("hierarchySection");
        section.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    }
  }

  private handleChange(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    const state = this.state;
    if (!state || !input.dataset.action) return;
    const action = input.dataset.action;
    if (action === "severity" && ["all", "high", "medium", "low"].includes(input.value)) this.options.onPatch({ severity: input.value as SafetyState["severity"] });
    else if (action === "include-demo") this.options.onPatch({ includeDemo: (input as HTMLInputElement).checked });
    else if (action === "engineering-annotations") this.options.onPatch({ engineeringAnnotations: (input as HTMLInputElement).checked });
    else if (action === "effect-layer" && input.dataset.layer && input.dataset.layer in state.layers) {
      this.options.onPatch({ layers: { ...state.layers, [input.dataset.layer]: (input as HTMLInputElement).checked } });
    } else if (action === "library-layer" && input.dataset.layer) this.options.onLayerToggle(input.dataset.layer, (input as HTMLInputElement).checked);
    else if (action === "range-start" || action === "range-end") {
      const value = Number(input.value);
      const range: [number, number] = action === "range-start" ? [Math.min(value, state.timeRange[1]), state.timeRange[1]] : [state.timeRange[0], Math.max(value, state.timeRange[0])];
      this.options.onPatch({ timeRange: range, time: Math.max(range[0], Math.min(range[1], state.time)), playing: false });
    }
  }

  private handleInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.dataset.action === "time") this.options.onPatch({ time: Number(input.value), playing: false });
    else if (input.dataset.action === "opacity") this.options.onPatch({ heatOpacity: Number(input.value) });
    else if (input.dataset.action === "range-start") this.ref("rangeStart").textContent = timeText(Number(input.value), true);
    else if (input.dataset.action === "range-end") this.ref("rangeEnd").textContent = timeText(Number(input.value), true);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.root.hidden = !visible;
    this.observer.disconnect();
    if (visible) {
      this.observeCharts();
      this.lastRenderKey = "";
      if (this.dataset && this.state && this.view) this.update(this.dataset, this.state, this.view);
      this.trend.resize();
      this.distribution.resize();
    }
  }

  setLoading(text: string): void {
    if (this.disposed) return;
    this.ref("connection").textContent = text || (this.dataset ? "本机项目已载入" : "等待载入项目");
    this.root.classList.remove("has-error");
    const notice = this.ref("notice");
    notice.hidden = !text;
    notice.textContent = text;
  }

  setError(text: string): void {
    if (this.disposed) return;
    this.root.classList.toggle("has-error", !!text);
    const notice = this.ref("notice");
    notice.hidden = !text;
    notice.textContent = text;
    if (text) this.ref("connection").textContent = "部分数据尚未载入";
  }

  setVideoStatus(text: string): void {
    if (this.disposed || text === this.videoStatus) return;
    this.videoStatus = text;
    this.ref("videoStatus").textContent = text;
    this.ref("videoStatus").title = text;
  }

  setLayers(layers: SafetyDashboardLayer[]): void {
    if (this.disposed) return;
    const key = JSON.stringify(layers);
    if (key === this.lastLayersKey) return;
    this.lastLayersKey = key;
    this.ref("libraryLayers").innerHTML = layers.length ? layers.map((layer) => `<label class="safety-layer" title="${escapeHtml(layer.name)}"><input type="checkbox" data-action="library-layer" data-layer="${escapeHtml(layer.id)}" ${layer.visible ? "checked" : ""}><span>${escapeHtml(layer.name)}</span><small>${escapeHtml(layer.kind)}</small></label>`).join("") : empty("尚无已加载工程图层");
  }

  debugStats(): { disposed: boolean; visible: boolean; chartCount: number; resizeObserverCount: number; listenerCount: number; updateCount: number; renderCount: number; mediaDecoderCount: number } {
    return { disposed: this.disposed, visible: this.visible, chartCount: this.disposed ? 0 : 2, resizeObserverCount: this.disposed || !this.visible ? 0 : 1, listenerCount: this.disposed ? 0 : 3, updateCount: this.updateCount, renderCount: this.renderCount, mediaDecoderCount: 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.observer.disconnect();
    this.root.removeEventListener("click", this.onClickBound);
    this.root.removeEventListener("change", this.onChangeBound);
    this.root.removeEventListener("input", this.onInputBound);
    this.trend.dispose();
    this.distribution.dispose();
    this.root.remove();
  }
}
