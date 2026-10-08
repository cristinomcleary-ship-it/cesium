import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { SafetyAlert, SafetyDataset, SafetyMedia, SafetyNode, SafetySelection, SafetyState, SafetyView } from "./safetyTypes.ts";
import platformTokens from "./safetyPlatformTokens.json";
import { applySafetyVisualTokens } from "./safetyVisualConfig.ts";
import { SafetyDrawingViewer } from "./safetyDrawingViewer.ts";
import "./safetyDashboardV3.css";
import "./safetyDashboardV5.css";
echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer]);
export type SafetyDashboardPage = "overview" | "inspection" | "events" | "components";
export type SafetyDashboardLayer = { id: string; name: string; kind: string; visible: boolean };
export type SafetyDashboardMediaSource = SafetyMedia & { mode: "live" | "replay"; recordedAt?: number; durationSeconds?: number };
export type SafetyDashboardMediaState = { selectedId?: string; mode?: "live" | "replay"; canPlay?: boolean; playing?: boolean; rate?: number; updatedAt?: number; hasTrack?: boolean; currentTimeSeconds?: number; durationSeconds?: number; error?: string };
export type SafetyDashboardVideoRoamState = { available: boolean; enabled: boolean; active: boolean; state: string; label: string; message?: string; missing?: string[]; mode?: "path" | "camera"; userWantsFollow?: boolean; mediaTime?: number; telemetryTimeMs?: number };
export type SafetyPresentationStatus = { mode?: "showcase" | "reality"; ok: boolean; state?: string; message?: string; authoring?: boolean };
export type SafetyDashboardOptions = {
  onSelect(selection: SafetySelection): void; onPatch(patch: Partial<SafetyState>): void;
  onHome?(): void; onExit(): void; onEarth(): void; onMedia(media: SafetyMedia, selection?: SafetySelection): void | Promise<void>;
  onVideoSettings?(): void; onModelOptimization?(): void; onTextScaleChange?(large: boolean): void; onVideoRoamChange?(enabled: boolean): void; onAuthoring?(): void; onRefresh(): void; onLayerToggle(id: string, visible: boolean): void;
  onPageChange?(page: SafetyDashboardPage): boolean | void; onInspectionModeChange?(mode: "live" | "replay"): void;
  onHandleEvent?(id: string, text: string): Promise<void>;
  onEventFilter?(status: "all" | SafetyAlert["status"], query: string): void; onPlaybackRateChange?(rate: number): void; onMediaSeekSeconds?(seconds: number): void;
  onSpatialLayers?(patch: { constructionAreas?: boolean; railwayAreas?: boolean; riskPoints?: boolean }): void;
};
const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const date = (v: number): string => Number.isFinite(v) ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(v) : "时间未录入";
const clock = (v: number): string => Number.isFinite(v) ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(v) : "—";
const elapsedTime = (seconds: number): string => { const value=Math.max(0,Math.floor(seconds)); const h=Math.floor(value/3600),m=Math.floor(value/60)%60,s=value%60; return `${h?`${String(h).padStart(2,"0")}:`:""}${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`; };
const pageNames = { overview: "项目总览", inspection: "无人机巡检", events: "风险管控", components: "构件资料" };
const components = { cap: "盖梁", column: "墩柱", footing: "承台", pile: "桩基" };
const statuses = { open: "待处理", rectifying: "处理中", closed: "已完成", all: "全部" };
const grades = { unassessed: "待评估", high: "重大", medium: "较高", low: "一般" };
const paths: Record<string, string> = {
 home:'<path d="m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10"/>', drone:'<path d="m8 8 8 8m0-8-8 8M9 12h6M12 9v6"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="M12 8v5m0 3h.01"/>', bridge:'<path d="M3 10h18M3 14h18M6 14v7m12-7v7M5 10V5m14 5V5M5 6c4 5 10 5 14 0"/>',
 polygon:'<path d="m5 4 14 2 1 12-12 3-5-9 2-8Z"/>', camera:'<path d="M3 7h4l2-3h6l2 3h4v13H3V7Z"/><circle cx="12" cy="13" r="4"/>',
 layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5"/>', pin:'<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
 file:'<path d="M6 2h8l5 5v15H6V2Z"/><path d="M14 2v6h5M9 12h7m-7 4h7"/>', settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
 chart:'<path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4"/>', cap:'<path d="m3 7 9-4 9 4-9 4-9-4Zm0 0v5l9 4 9-4V7M8 14v7m8-7v7"/>', column:'<path d="m7 3 5-2 5 2v18l-5 2-5-2V3Zm0 0 5 2 5-2M12 5v18"/>', footing:'<path d="m2 12 10-5 10 5-10 5-10-5Zm0 0v6l10 5 10-5v-6M12 17v6M8 9V3h8v6"/>', pile:'<path d="m4 4 4-2 4 2-4 2-4-2Zm0 0v15l4 3 4-3V4M8 6v16m7-19 4-2 3 2-3 2-4-2Zm0 0v15l4 3 3-3V3M19 5v16"/>'
};
const icon = (key: string) => `<svg class="v3-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[key] || paths.file}</svg>`;
const empty = (title: string, note = "", symbol = "file") => `<div class="v3-empty">${icon(symbol)}<strong>${esc(title)}</strong>${note ? `<p>${esc(note)}</p>` : ""}</div>`;
const tag = (item: { provenance: string }) => `<span class="v3-badge">${item.provenance === "demo" ? "示例" : item.provenance === "user" ? "人工记录" : item.provenance === "derived" ? "参考点位" : "已接入"}</span>`;
const btn = (action: string, text: string, attrs = "", cls = "") => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
const card = (title: string, symbol: string, body: string, cls = "", action = "") => `<section class="v3-card ${cls}"><header><h2>${icon(symbol)}${title}</h2>${action}</header><div class="v3-card-body">${body}</div></section>`;
const prefKey = "cesium-safety-display-preferences-v3";

/** Four workspaces sharing an existing Viewer, one video node and the controller's timeline. */
export class SafetyDashboard {
 readonly videoHost: HTMLDivElement;
 private readonly root = document.createElement("div");
 private readonly events = new AbortController();
 private readonly trend: echarts.ECharts;
 private readonly distribution: echarts.ECharts;
 private readonly observer: ResizeObserver;
 private readonly drawing: SafetyDrawingViewer;
 private dataset?: SafetyDataset; private state?: SafetyState; private view?: SafetyView; private lastDataset?: SafetyDataset; private lastKey = "";
 private visible = true; private disposed = false; private updates = 0; private renders = 0;
 private page: SafetyDashboardPage = "overview"; private authoring = false; private inspectionMode: "live" | "replay" = "live";
 private mediaSources?: SafetyDashboardMediaSource[]; private mediaState: SafetyDashboardMediaState = {}; private videoStatus = "暂未关联视频";
 private eventError = ""; private spatialLayers = { constructionAreas: true, railwayAreas: true, riskPoints: true };
 private layers: SafetyDashboardLayer[] = []; private eventStatus: "all" | SafetyAlert["status"] = "open"; private eventSearch = ""; private riskTab = "events";
 private handleId?: string; private readonly drafts = new Map<string,string>(); private readonly errors = new Map<string,string>(); private readonly pending = new Set<string>(); private readonly saved = new Set<string>();
 private pierId?: string; private category?: keyof typeof components; private pierSearch = "";
 private preferences: { reduced?: boolean; largeText?: boolean } = {}; private preferencesApplied = false;
 private presentationStatus?: SafetyPresentationStatus;
 private roamState: SafetyDashboardVideoRoamState = {available:false,enabled:false,active:false,state:"unavailable",label:"未关联同录像航迹"};
 private optimizationVisible = false; private lastRoamUiKey = "";
 constructor(host: HTMLElement, private readonly options: SafetyDashboardOptions) {
  this.root.className = "safety-dashboard safety-dashboard-v3 safety-dashboard-v5"; applySafetyVisualTokens(this.root);
  for (const [key,value] of Object.entries(platformTokens.colors)) this.root.style.setProperty(`--v3-${key}`,value);
  const nav=(key:SafetyDashboardPage,symbol:string)=>btn("tab",icon(symbol)+pageNames[key],`data-tab="${key}"`,"v3-nav");
  const pages=(names:string,body:string)=>`<div data-pages="${names}" class="v3-page-panels">${body}</div>`;
  this.root.innerHTML=`<header class="v3-header"><nav aria-label="主导航左侧">${nav("overview","home")}${nav("inspection","drone")}</nav><div class="v3-brand"><h1>邻近营业线施工安全数字孪生平台</h1><p><span data-ref="projectName">工程项目</span> · <span data-ref="pageName">项目总览</span></p></div><nav class="v3-nav-right" aria-label="主导航右侧">${nav("events","shield")}${nav("components","bridge")}</nav></header>
  <div class="v3-sidebar-toggles">${btn("sidebar-toggle","☰ 列表",'data-side="left" aria-expanded="false"')}${btn("sidebar-toggle","详情 ☰",'data-side="right" aria-expanded="false"')}</div>
  <aside class="v3-sidebar v3-left" aria-label="项目与任务">${pages("overview",card("工程概况","bridge",'<div data-ref="metrics" class="v3-metrics"></div><div data-ref="spatialCounts" class="v5-spatial-counts"></div>',"v5-overview-metrics")+card("施工区段","polygon",'<div data-ref="areas"></div>',"v3-area-card",btn("authoring","配置 ›","","v3-text-button"))+card("巡检任务","chart",'<div data-ref="taskCharts" class="v3-task-stats"><div data-ref="distribution" class="v3-donut"></div><div data-ref="taskSummary"></div></div><div data-ref="trend" class="v3-trend"></div><p data-ref="taskStatus" class="v3-muted"></p>',"v5-overview-tasks",btn("tab","查看 ›",'data-tab="inspection"',"v3-text-button")))}
  ${pages("inspection",card("巡检任务","drone",'<div class="v3-segmented">'+btn("inspection-mode","实时画面",'data-inspection-mode="live"')+btn("inspection-mode","历史回放",'data-inspection-mode="replay"')+'</div><div data-ref="mediaSources"></div><p class="v3-muted v5-list-note" data-ref="inspectionNote">选择记录后查看画面。</p>',"v3-full-card"))}
  ${pages("events",card("风险处置","shield",'<div class="v3-segmented">'+btn("risk-tab","告警事件",'data-risk-tab="events"')+btn("risk-tab","人工风险点",'data-risk-tab="points"')+'</div><div data-ref="eventFilters" class="v3-status-filters"></div><details data-ref="eventSearchBox" class="v3-search"><summary>搜索与筛选</summary><label>事件名称<input data-action="event-search" type="search" placeholder="搜索事件"></label><label>事件等级<select data-action="severity"><option value="all">全部等级</option><option value="high">重大</option><option value="medium">较高</option><option value="low">一般</option></select></label></details><div data-ref="alerts"></div><p data-ref="eventNote" class="v3-muted"></p>',"v3-full-card"))}
  ${pages("components",card("构件资料","bridge",'<label class="v3-field">选择墩位<input type="search" data-action="pier-search" placeholder="查找墩位"></label><div data-ref="piers" class="v3-piers"></div><h3 class="v3-field-title">选择构件类别</h3><div data-ref="categories" class="v3-components"></div><p class="v3-muted">选择构件类别，查看已有参数与施工图。</p>',"v3-full-card"))}</aside>
  <div class="safety-scene-hud"><div data-ref="breadcrumbs" class="v3-breadcrumbs"></div><div class="v3-scene-actions" hidden></div><div class="v3-scene-status" data-ref="presentationStatus" role="status" hidden></div><div class="v3-notice" data-ref="notice" role="status" hidden></div><div class="v3-legend" data-ref="legend" hidden></div><div data-ref="roamScene" class="v5-roam-scene" hidden>${icon("drone")}<strong data-ref="roamSceneLabel"></strong><span data-ref="roamSceneTime"></span>${btn("roam-stop","退出跟随","","v3-text-button")}</div></div>
  <aside class="v3-sidebar v3-right" aria-label="现场与详情"><section class="v3-card v3-video-card" data-ref="videoCard"><header><h2>${icon("camera")}<span data-ref="videoHeading">现场视频</span></h2>${btn("video-settings","选择视频 ›","","v3-text-button")}</header><div class="v3-card-body"><div data-ref="videoEmpty" class="v5-video-empty"><span>${icon("camera")}</span><div><strong>暂无可用画面</strong><p>请选择已有视频，模型仍可操作。</p></div></div><div data-ref="videoHost" class="v3-video-host"><div class="v3-video-empty">${icon("camera")}<strong>暂无可用画面</strong><p>选择已有视频，或继续查看模型</p></div></div><div class="v3-video-caption"><strong data-ref="mediaName">暂未关联视频</strong><span data-ref="mediaUpdated"></span></div><p data-ref="videoStatus" class="v3-muted"></p><div data-ref="roamControls" class="v5-roam-controls" hidden>${btn("video-roam",icon("drone")+"视频漫游",'aria-pressed="false" disabled',"v5-roam-toggle")}<span data-ref="roamStatus">未关联同录像航迹</span></div><div data-ref="videoActions" class="v3-video-actions"></div>${pages("overview",btn("tab","进入现场巡检 ›",'data-tab="inspection"',"v3-text-button"))}</div></section>
  ${pages("overview",card("风险事件","shield",'<div data-ref="summaryAlerts"></div>',"",btn("tab","查看 ›",'data-tab="events"',"v3-text-button"))+card("设备状态","drone",'<div data-ref="devices"></div><div data-ref="summaryObject" class="v5-selected-summary"></div>'))}
  ${pages("events components",card('<span data-ref="detailHeading">事件详情</span>',"file",'<div data-ref="detail"></div><div data-ref="media"></div><section data-ref="handleForm" class="v3-handle-form" hidden><div class="v3-workflow"><span>✓ 发现</span><b>2 处理</b><span>3 完成</span></div><label class="v3-field">处理说明 <small>必填</small><textarea data-action="handle-text" maxlength="4000" rows="6" placeholder="简要说明现场采取的处理措施"></textarea></label><p data-ref="handleStatus" class="v3-form-status" role="status"></p><div class="v3-button-row">'+btn("handle-cancel","返回详情","","v3-secondary")+btn("handle-save","保存处理结果","","v3-primary")+'</div></section><div data-ref="detailActions" class="v3-button-row"></div>',"v3-full-card"))}</aside>
  <section data-ref="timeline" class="v3-timeline-panel" data-pages="overview inspection"><div class="v3-timeline-title"><span data-ref="timelineHeading">暂无可回放记录</span><span data-ref="trackStatus"></span>${btn("timeline-records","选择回放 ›","","v3-text-button")}</div><div class="v3-timeline-controls">${btn("play","▶",'aria-label="播放" title="播放"',"v3-primary")}<b data-ref="playbackTime">00:00</b><div class="v5-scrub"><input type="range" data-action="time" min="0" max="1" step="1" aria-label="共享回放时间轴"><div data-ref="timelineMarkers" class="v5-timeline-markers"></div></div><span data-ref="rangeEnd">时长未读取</span><label><span class="v3-sr-only">播放速度</span><select data-action="playback-rate"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div><span data-ref="rangeStart" class="v3-sr-only">00:00</span></section>
  <div class="v3-toolbar" aria-label="模型工具"><div class="v3-segmented">${btn("mode","展示",'data-mode="presentation"')}${btn("mode","实景",'data-mode="inspection"')}</div>${btn("home",icon("home"),'title="回到总览" aria-label="回到总览"',"v5-icon-tool")}${btn("layers",icon("layers"),'title="图层" aria-label="图层"',"v5-icon-tool")}${btn("authoring",icon("polygon")+"区域配置")}${btn("model-optimization",icon("bridge")+"模型优化")}${btn("motion-toggle","Ⅱ",'title="暂停装饰" aria-label="暂停装饰"',"v5-icon-tool")}${btn("settings",icon("settings"),'title="显示设置" aria-label="显示设置"',"v5-icon-tool")}</div><div data-ref="connection" class="v3-footer-note">正在载入项目</div>${btn("exit","原有工作台 ↗","","v3-workbench")}
  <div data-ref="popoverBackdrop" class="v3-popover-backdrop" hidden></div><aside data-ref="popover" class="v3-popover" hidden><header><h2 data-ref="popoverTitle">显示设置</h2>${btn("popover-close","×",'aria-label="关闭工具"')}</header><div data-ref="popoverBody"></div>${btn("popover-close","完成","","v3-primary v3-wide")}</aside>`;
  host.append(this.root);this.videoHost=this.ref<HTMLDivElement>("videoHost");this.drawing=new SafetyDrawingViewer(host,()=>options.onExit());
  this.trend=echarts.init(this.ref("trend"),undefined,{renderer:"canvas"});this.distribution=echarts.init(this.ref("distribution"),undefined,{renderer:"canvas"});
  this.trend.on("click",p=>{const range=(p.data as {range?:[number,number]})?.range;if(range)options.onPatch({timeRange:range,time:range[0],playing:false});});
  this.observer=new ResizeObserver(()=>this.resizeCharts());this.observer.observe(this.ref("trend"));this.observer.observe(this.ref("distribution"));
  this.root.addEventListener("click",e=>this.click(e),{signal:this.events.signal});this.root.addEventListener("change",e=>this.change(e),{signal:this.events.signal});this.root.addEventListener("input",e=>this.input(e),{signal:this.events.signal});
  try{const p=JSON.parse(localStorage.getItem(prefKey)||"{}");this.preferences={reduced:typeof p.reduced==="boolean"?p.reduced:undefined,largeText:p.largeText===true};}catch{/* Preferences are optional. */}
  this.root.classList.toggle("v3-large-text",!!this.preferences.largeText);queueMicrotask(()=>{if(!this.disposed)this.options.onTextScaleChange?.(!!this.preferences.largeText);});this.renderPage();
 }
 private ref<T extends HTMLElement=HTMLElement>(name:string):T{return this.root.querySelector<T>(`[data-ref="${name}"]`)!;}
 private resizeCharts():void{if(!this.visible||this.disposed)return;if(this.ref("trend").offsetWidth)this.trend.resize();if(this.ref("distribution").offsetWidth)this.distribution.resize();}
 update(dataset:SafetyDataset,state:SafetyState,view:SafetyView):void{
  if(this.disposed)return;const previous=this.state;this.dataset=dataset;this.state=state;this.view=view;this.updates++;
  if(state.page && (!previous || previous.page!==state.page))this.page=state.page;
  this.eventStatus=state.eventStatus||"all";this.eventSearch=state.eventQuery||"";
  if(!this.preferencesApplied){this.preferencesApplied=true;queueMicrotask(()=>{if(!this.disposed)this.options.onPatch({reducedMotion:this.preferences.reduced??matchMedia("(prefers-reduced-motion: reduce)").matches});});}
  if(!previous||previous.selectedId!==state.selectedId)this.syncComponent();
  if(!state.page&&!this.authoring&&previous&&previous.selectedId!==state.selectedId){if(state.selectedAlertId)this.page="events";else if((view.selected.kind==="component"||view.selected.kind==="pier")&&!view.selected.spatialKind){this.page="components";this.syncComponent();}}
  this.playback();const key=JSON.stringify([this.page,state.selectedId,state.selectedAlertId,state.mode,state.severity,state.eventStatus,state.eventQuery,state.timeRange,state.includeDemo,state.layers,state.animationPaused,state.reducedMotion,state.engineeringAnnotations]);
  if(key===this.lastKey&&dataset===this.lastDataset)return;this.lastKey=key;this.lastDataset=dataset;if(this.visible)this.render();
 }
 private refresh():void{this.lastKey="";if(this.dataset&&this.state&&this.view)this.render();}
 private render():void{if(!this.dataset||!this.state||!this.view||this.disposed)return;this.renders++;this.root.dataset.mode=this.appliedMode()||"unavailable";this.ref("projectName").textContent=this.dataset.name;this.ref("projectName").title=this.dataset.name;this.ref("breadcrumbs").innerHTML=btn("home",icon("pin")+esc(this.dataset.name),"","v3-breadcrumb-project")+`<span>›</span><span>${pageNames[this.page]}</span>`;this.overview();this.inspection();this.eventList();this.componentList();this.detail();this.renderPage();this.playback();}
 private renderPage():void{this.root.dataset.page=this.page;this.ref("pageName").textContent=pageNames[this.page];this.root.querySelectorAll<HTMLElement>("[data-pages]").forEach(e=>e.hidden=!e.dataset.pages!.split(" ").includes(this.page));this.root.querySelectorAll<HTMLElement>('[data-action="tab"]').forEach(e=>{e.classList.toggle("is-active",e.dataset.tab===this.page);e.setAttribute("aria-pressed",String(e.dataset.tab===this.page));});this.ref("videoCard").hidden=!["overview","inspection"].includes(this.page);this.ref("legend").hidden=true;this.ref("timeline").hidden=this.authoring||!(this.page==="overview"||(this.page==="inspection"&&!!this.mediaState.selectedId&&this.inspectionMode==="replay"));this.ref("videoCard").classList.toggle("is-empty",!this.sources().some(m=>m.id===this.mediaState.selectedId));this.renderRoam();this.resizeCharts();}
 private realEvents(): SafetyAlert[] { return (this.view?.alerts || []).filter(a => a.provenance !== "demo"); }
 private nodeSummary(node: SafetyNode): string {
  if (node.spatialKind === "risk-point") return `人工风险点 · ${grades[node.riskLevel || "unassessed"]}`;
  if (node.spatialKind === "construction-area") return "施工区域 · 已保存";
  if (node.spatialKind === "railway") return "铁路范围 · 已保存";
  return node.kind==="section" ? "参考区段 · 状态未录入" : node.modelFeatureId ? "模型构件 · 已关联" : node.kind === "pier" ? "参考墩位 · 可查看资料" : node.kind === "component" ? "构件资料 · 未绑定模型" : "工程项目";
 }
 private nodeItem(node: SafetyNode): string { return btn("node", `<span><strong>${esc(node.name)}</strong><small>${esc(this.nodeSummary(node))}</small></span><span class="v3-chevron">›</span>`, `data-node="${esc(node.id)}" title="${esc(node.name)}"`, `v3-list-item ${this.state?.selectedId === node.id ? "is-selected" : ""}`); }
 private overview(): void {
  const ds=this.dataset!,view=this.view!,spatial=ds.nodes.filter(n=>n.spatialObjectId&&n.provenance!=="demo");
  const boundComponents=ds.nodes.filter(n=>n.kind==="component"&&!n.eventId&&!n.spatialKind&&n.modelFeatureId&&n.provenance!=="demo");
  this.ref("metrics").innerHTML=[["总构件数量",boundComponents.length?String(boundComponents.length):"未接入","bridge"],["施工中的","未接入","polygon"],["风险事件",this.eventError?"未读取":String(this.realEvents().length),"shield"]].map(([label,value,symbol])=>`<div><span class="v5-metric-icon">${icon(symbol)}</span><b class="${/^\d+$/.test(value)?"":"is-unavailable"}">${value}</b><span>${label}</span></div>`).join("");
  this.ref("spatialCounts").innerHTML=[["施工区","construction-area"],["铁路范围","railway"],["人工风险点","risk-point"]].map(([label,kind])=>`<span>${label} <b>${spatial.filter(n=>n.spatialKind===kind).length}</b></span>`).join("");
  const areas=spatial.filter(n=>n.spatialKind!=="risk-point"),sections=ds.nodes.filter(n=>n.kind==="section"&&!n.spatialKind&&n.provenance!=="demo");
  this.ref("areas").innerHTML=areas.length||sections.length?[...areas,...sections].map(n=>this.nodeItem(n)).join(""):empty("尚未定义区域和风险点","","polygon")+btn("authoring","＋ 开始配置","","v3-primary v3-wide");
  const tasks=view.tasks.filter(t=>t.provenance!=="demo");
  this.ref("taskCharts").hidden=!tasks.length;this.ref("trend").hidden=!tasks.length;
  this.ref("taskSummary").innerHTML=tasks.length?["complete","active","pending"].map((status,i)=>`<span class="v5-task-status"><i></i>${["已完成","进行中","待执行"][i]}<b>${tasks.filter(t=>t.status===status).length}</b></span>`).join(""):"";
  this.ref("taskStatus").innerHTML=tasks.length?"巡检任务趋势（项） · 当前时间范围":empty("暂无巡检任务统计","接入真实任务记录后显示状态和趋势。","chart");
  this.charts(tasks);
  const alerts=this.realEvents().filter(a=>a.status!=="closed");
  this.ref("summaryAlerts").innerHTML=this.eventError?empty("事件记录暂未载入","已有工程场景仍可操作。","shield")+btn("refresh","重新读取","","v3-text-button"):alerts.length?alerts.slice(0,3).map(a=>this.eventItem(a,true)).join(""):empty("暂无待处理事件","","shield");
  const devices=ds.devices.filter(d=>d.provenance!=="demo"),liveDevices=devices.filter(d=>d.status!=="replay"),replayDevices=devices.filter(d=>d.status==="replay");
  this.ref("devices").innerHTML=liveDevices.length?liveDevices.map(d=>`<div class="v5-device-row">${icon(d.kind)}<strong>${esc(d.name)}</strong><span data-status="${d.status}">${{online:"在线",offline:"离线",unknown:"状态未接入",replay:"回放记录"}[d.status]}</span></div>`).join(""):empty("实时设备状态未接入",replayDevices.length?`已有 ${replayDevices.length} 条关联录像，可进入巡检查看。`:"未接入设备不会计入在线数量。","drone");
  this.root.classList.toggle("v5-no-live-devices",!liveDevices.length);this.root.classList.toggle("v5-few-events",alerts.length<2);
  const selected=view.selected;this.ref("summaryObject").hidden=selected.kind==="project";
  this.ref("summaryObject").innerHTML=selected.kind==="project"?"":`<small>当前对象</small><strong title="${esc(selected.name)}">${esc(selected.name)}</strong>${btn("locate",icon("pin"),'title="定位当前对象" aria-label="定位当前对象"',"v3-text-button")}`;
  const connection=`${this.eventError?"事件服务暂不可用 · ":""}${spatial.length?"人工配置已载入":"施工范围待配置"} · ${this.realEvents().length?"事件数据已接入":"事件记录待接入"}`;this.ref("connection").textContent=connection;this.ref("connection").title=connection;
  const records=this.sources().filter(m=>m.mode==="replay"&&Number.isFinite(m.recordedAt));
  const markers=[...this.realEvents().map(a=>({time:a.timestamp,id:a.id,title:a.title,action:"alert"})),...records.map(m=>({time:m.recordedAt!,id:m.id,title:m.name,action:"media"}))].filter(m=>m.time>=this.state!.timeRange[0]&&m.time<=this.state!.timeRange[1]);
  this.ref("timelineMarkers").innerHTML=markers.map(m=>btn(m.action,"",`data-${m.action==="alert"?"alert":"media"}="${esc(m.id)}" style="left:${100*(m.time-this.state!.timeRange[0])/Math.max(1,this.state!.timeRange[1]-this.state!.timeRange[0])}%" title="${esc(m.title)} · ${date(m.time)}" aria-label="${esc(m.title)}"`,"v5-timeline-mark")).join("");
 }
 private charts(tasks: SafetyView["tasks"]): void {
  if(!tasks.length){this.distribution.clear();this.trend.clear();return;}
  const colors=platformTokens.colors, animation=this.visible&&!this.state!.animationPaused&&!this.state!.reducedMotion;
  const counts=["complete","active","pending"].map(status=>tasks.filter(t=>t.status===status).length);
  this.distribution.setOption({animation,animationDuration:300,tooltip:{trigger:"item",formatter:"{b}：{c} 项"},series:[{type:"pie",radius:["66%","84%"],center:["50%","50%"],silent:!tasks.length,label:{show:false},data:tasks.length?counts.map((value,index)=>({value,name:["已完成","进行中","待开始"][index],itemStyle:{color:[colors.cyan,colors.blue,colors.attention][index]}})):[{value:1,name:"尚未接入",itemStyle:{color:"#183849"}}]}]},true);
  const [start,end]=this.state!.timeRange, step=Math.max(1,(end-start)/6);
  const bins=Array.from({length:7},(_,i)=>{const a=start+step*i,b=i===6?end+1:a+step;return {value:tasks.filter(t=>t.timestamp>=a&&t.timestamp<b).length,range:[a,Math.min(end,b)] as [number,number]};});
  this.trend.setOption({animation,animationDuration:300,grid:{left:28,right:10,top:10,bottom:24},tooltip:{trigger:"axis",valueFormatter:(v:unknown)=>`${v} 项`},xAxis:{type:"category",data:bins.map(b=>new Date(b.range[0]).toLocaleDateString("zh-CN",{month:"numeric",day:"numeric"})),axisLine:{lineStyle:{color:"#23485d"}},axisTick:{show:false},axisLabel:{color:colors.muted,fontSize:14,interval:2}},yAxis:{type:"value",min:0,minInterval:1,axisLabel:{color:colors.muted,fontSize:14},splitLine:{lineStyle:{color:"#173548"}}},series:[{type:"line",smooth:true,showSymbol:!!tasks.length,data:tasks.length?bins:[],lineStyle:{color:colors.cyan,width:2},itemStyle:{color:colors.cyan},areaStyle:{color:"rgba(67,217,255,.13)"}}]},true);
 }
 private sources(): SafetyDashboardMediaSource[] { return this.mediaSources || (this.dataset?.media || []).filter(m=>m.kind==="video"&&m.provenance!=="demo").map(m=>({...m,mode:"replay" as const})); }
 private inspection(): void {
  const sources=this.sources().filter(m=>m.mode===this.inspectionMode).map(m=>({ ...m,
   durationSeconds: Number.isFinite(m.durationSeconds) && m.durationSeconds! > 0 ? m.durationSeconds : m.id===this.mediaState.selectedId ? this.mediaState.durationSeconds : undefined,
  }));
  this.ref("mediaSources").innerHTML=sources.length?sources.map(m=>btn("media",`<span class="v3-source-icon">${icon(m.mode==="live"?"camera":"drone")}</span><span><strong>${esc(m.name)}</strong><small>${m.recordedAt?date(m.recordedAt):m.mode==="live"?"实时接入":"录制时间未录入"}${Number.isFinite(m.durationSeconds)&&m.durationSeconds!>0?` · ${elapsedTime(m.durationSeconds!)}`:""}</small></span><span class="v3-chevron">›</span>`,`data-media="${esc(m.id)}" title="${esc(m.name)}"`,`v3-list-item v3-source ${m.id===this.mediaState.selectedId?"is-selected":""}`)).join(""):empty(this.inspectionMode==="live"?"暂未接入实时画面":"暂无巡检回放",this.inspectionMode==="live"?"可切换历史回放，查看已导入的巡检记录。":"导入已有视频后，可在这里选择和回放。","camera");
  this.root.querySelectorAll<HTMLElement>('[data-action="inspection-mode"]').forEach(e=>e.classList.toggle("is-active",e.dataset.inspectionMode===this.inspectionMode));
  const source=this.sources().find(m=>m.id===this.mediaState.selectedId);
  this.ref("videoHeading").textContent=this.page==="inspection"?(this.inspectionMode==="live"?"实时画面":"历史回放"):"现场视频";
  this.ref("inspectionNote").textContent=sources.length?`${sources.length} 条${this.inspectionMode==="live"?"实时来源":"历史记录"} · 选择后查看`:(this.inspectionMode==="live"?"可切换历史回放":"可从已有工作台导入视频");
  this.ref("videoCard").classList.toggle("is-empty",!source);this.ref("videoEmpty").hidden=!!source;this.ref("mediaName").title=source?.name||"";
  this.ref("mediaName").textContent=source?.name||"暂未关联视频";
  this.ref("mediaUpdated").textContent=this.mediaState.updatedAt?`更新于 ${clock(this.mediaState.updatedAt)}`:"";
  this.ref("videoStatus").textContent=this.mediaState.error||this.videoStatus;
  this.ref("videoActions").innerHTML=this.page==="inspection"&&source?btn("video-settings","视频 AR 设置 ↗","","v3-text-button"):"";this.renderRoam();
 }
 private eventItem(alert: SafetyAlert, compact=false): string {
  return btn("alert",`<span class="v3-event-dot" data-grade="${alert.severity}"></span><span><strong>${esc(alert.title)}</strong><small>${date(alert.timestamp)} · ${statuses[alert.status]}</small>${compact?"":`<small>${alert.positionAvailable===false?"位置未关联":esc(this.dataset?.nodes.find(n=>n.id===alert.nodeId)?.name||"对象待关联")}</small>`}</span>${compact?"":`<span class="v3-status" data-status="${alert.status}">${statuses[alert.status]}</span>`}`,`data-alert="${esc(alert.id)}"`,`v3-list-item v3-event ${this.state?.selectedAlertId===alert.id?"is-selected":""}`);
 }
 private eventList(): void {
  this.ref("eventFilters").hidden=this.riskTab!=="events";this.ref("eventSearchBox").hidden=this.riskTab!=="events";
  this.ref("eventFilters").innerHTML=(Object.keys(statuses) as Array<keyof typeof statuses>).map(status=>btn("event-filter",statuses[status],`data-status="${status}"`,status===this.eventStatus?"is-active":"")).join("");
  this.root.querySelectorAll<HTMLElement>('[data-action="risk-tab"]').forEach(e=>e.classList.toggle("is-active",e.dataset.riskTab===this.riskTab));
  if(this.riskTab==="points"){
   const points=this.dataset!.nodes.filter(n=>n.spatialKind==="risk-point"&&n.provenance!=="demo");
   this.ref("alerts").innerHTML=points.length?points.map(n=>this.nodeItem(n)).join(""):empty("暂无人工风险点","在区域配置中点选位置，并记录需要关注的事项。","pin");
   this.ref("eventNote").textContent="人工风险点不会自动生成告警事件。";return;
  }
  const events=this.realEvents().filter(a=>(this.eventStatus==="all"||a.status===this.eventStatus)&&(!this.eventSearch||`${a.title} ${a.description}`.toLocaleLowerCase().includes(this.eventSearch.toLocaleLowerCase())));
  this.ref("alerts").innerHTML=this.eventError?empty("事件记录暂未载入","请检查服务后重试，当前不能确认事件数量。","shield")+btn("refresh","重新读取","","v3-text-button"):events.length?events.map(a=>this.eventItem(a)).join(""):empty("暂无匹配事件","可以调整筛选，或接入实际巡检事件记录。","shield");
  this.ref("eventNote").textContent=this.eventError?"事件服务暂不可用":`当前 ${events.length} 条记录 · 与场景筛选一致`;
  const severity=this.root.querySelector<HTMLSelectElement>('[data-action="severity"]')!;severity.value=this.state!.severity;
 }
 private syncComponent(): void {
  const selected=this.view?.selected;if(!selected)return;
  if(selected.kind==="pier"&&!selected.spatialKind)this.pierId=selected.id;
  if(selected.kind==="component"&&!selected.spatialKind){this.pierId=selected.parentId;this.category=selected.componentType;}
 }
 private selectedComponent(): SafetyNode|undefined { return this.dataset?.nodes.find(n=>n.kind==="component"&&n.parentId===this.pierId&&n.componentType===this.category); }
 private componentList(): void {
  const piers=this.dataset!.nodes.filter(n=>n.kind==="pier"&&!n.spatialKind&&n.provenance!=="demo"&&(!this.pierSearch||n.name.toLowerCase().includes(this.pierSearch.toLowerCase())));
  this.ref("piers").innerHTML=piers.length?piers.map(n=>btn("pier",esc(n.name),`data-node="${esc(n.id)}"`,n.id===this.pierId?"is-selected":"")).join(""):empty("暂无可用墩位","接入 CAD 锚点或模型墩位后，可按构件类别查看资料。","bridge");
  this.ref("categories").innerHTML=(Object.entries(components) as Array<[keyof typeof components,string]>).map(([key,name])=>btn("component",`${icon(key)}<strong>${name}</strong>`,`data-component="${key}" ${this.pierId?"":"disabled"}`,key===this.category?"is-selected":"")).join("");
 }
 private associated(ids: string[]): SafetyMedia[] { return this.dataset!.media.filter(m=>ids.includes(m.id)&&m.provenance!=="demo"); }
 private mediaItems(media: SafetyMedia[]): string { return media.length?`<h3 class="v3-field-title">关联资料</h3><div class="v3-media-list">${media.map(m=>btn("media",`${icon(m.kind==="video"?"camera":"file")}<span><strong>${esc(m.name)}</strong><small>${m.relation==="object"?"对象关联资料":"项目参考资料"}</small></span>`,`data-media="${esc(m.id)}"`,"v3-list-item")).join("")}</div>`:""; }
 private detail(): void {
  const body=this.ref("detail"),media=this.ref("media"),actions=this.ref("detailActions"),form=this.ref("handleForm");form.hidden=true;actions.innerHTML="";media.innerHTML="";
  if(this.page==="components"){
   this.ref("detailHeading").textContent="构件详情";const pier=this.dataset!.nodes.find(n=>n.id===this.pierId),node=this.selectedComponent();
   if(!pier||!this.category){body.innerHTML=empty("选择墩位与构件类别","盖梁、墩柱、承台和桩基均可查看已有资料。","bridge");return;}
   const files=this.associated(node?.mediaIds||pier.mediaIds);
   body.innerHTML=`<div class="v3-detail-icon">${icon(this.category)}</div><h3 class="v3-detail-title">${esc(pier.name)} · ${components[this.category]}</h3><p class="v3-muted">${node?.modelFeatureId?"已绑定模型构件":"可查看资料 · 尚未绑定 BIM 构件"}</p><dl class="v3-properties"><div><dt>构件类别</dt><dd>${components[this.category]}</dd></div><div><dt>混凝土等级</dt><dd>未录入</dd></div><div><dt>构件尺寸</dt><dd>未录入</dd></div><div><dt>施工状态</dt><dd>未录入</dd></div></dl>`;
   media.innerHTML=this.mediaItems(files);const drawing=files.find(m=>m.kind!=="video");
   actions.innerHTML=drawing?btn("media","查看施工图",`data-media="${esc(drawing.id)}"`,"v3-primary v3-wide"):empty("暂未关联施工图","可先查看其他构件，或在原工作台导入资料。","file");return;
  }
  this.ref("detailHeading").textContent=this.handleId?"处理事件":"事件详情";
  const alert=this.realEvents().find(a=>a.id===this.state!.selectedAlertId);
  if(!alert){const node=this.view!.selected;body.innerHTML=this.riskTab==="points"&&node.spatialKind==="risk-point"?`<h3 class="v3-detail-title">${esc(node.name)}</h3><span class="v3-grade" data-grade="${node.riskLevel||"unassessed"}">${grades[node.riskLevel||"unassessed"]}</span><p class="v3-muted">人工记录的关注点，不代表已发生告警事件。</p>${btn("locate",icon("pin")+"定位风险点","","v3-secondary")}`:empty("选择一个事件","查看现场证据，并记录处理结果。","shield");return;}
  const isHandling=this.handleId===alert.id;this.ref("detailHeading").textContent=isHandling?"处理事件":"事件详情";
  body.innerHTML=`<div class="v3-detail-status"><span class="v3-grade" data-grade="${alert.severity}">${grades[alert.severity]}</span><span class="v3-status" data-status="${alert.status}">${statuses[alert.status]}</span>${tag(alert)}</div><h3 class="v3-detail-title">${esc(alert.title)}</h3><dl class="v3-properties"><div><dt>发现时间</dt><dd>${date(alert.timestamp)}</dd></div><div><dt>发生位置</dt><dd>${alert.positionAvailable===false?"尚未关联":esc(this.dataset!.nodes.find(n=>n.id===alert.nodeId)?.name||"尚未关联")}</dd></div><div><dt>记录来源</dt><dd>${esc(alert.sourceLabel||(alert.provenance==="user"?"人工事件记录":"巡检事件接口"))}</dd></div></dl>${alert.description?`<p class="v3-description">${esc(alert.description)}</p>`:""}${!isHandling&&alert.rectifications.length?`<h3 class="v3-field-title">处理记录</h3><ol class="v3-records">${alert.rectifications.map(r=>`<li><small>${date(r.timestamp)}</small><p>${esc(r.text)}</p></li>`).join("")}</ol>`:""}`;
  if(isHandling){form.hidden=false;const textarea=this.root.querySelector<HTMLTextAreaElement>('[data-action="handle-text"]')!;if(textarea.dataset.eventId!==alert.id){textarea.value=this.drafts.get(alert.id)||"";textarea.dataset.eventId=alert.id;}textarea.disabled=this.pending.has(alert.id);const save=this.root.querySelector<HTMLButtonElement>('[data-action="handle-save"]')!;save.disabled=this.pending.has(alert.id);save.textContent=this.pending.has(alert.id)?"正在保存…":"保存处理结果";this.ref("handleStatus").textContent=this.errors.get(alert.id)||"保存后由事件服务确认处理结果。";return;}
  media.innerHTML=this.mediaItems(this.associated(alert.mediaIds));
  actions.innerHTML=(alert.positionAvailable===false?"":btn("locate",icon("pin")+"定位","","v3-secondary"))+(alert.status!=="closed"?btn("handle-start","处理此事件",`data-alert="${esc(alert.id)}" ${this.options.onHandleEvent?"":"disabled title=\"事件服务尚未接入\""}`,"v3-primary"):"<p class=\"v3-success\">✓ 处理结果已保存</p>");
 }
 private playback(): void {
  if(!this.state)return;const state=this.state,canPlay=this.inspectionMode==="replay"&&!!this.mediaState.canPlay;
  const duration=this.mediaState.durationSeconds,elapsed=this.mediaState.currentTimeSeconds||0,knownDuration=duration!==undefined&&Number.isFinite(duration)&&duration>0;
  const slider=this.root.querySelector<HTMLInputElement>('[data-action="time"]')!;
  slider.min="0";slider.max=String(knownDuration?duration:1);slider.step="0.01";slider.value=String(elapsed);slider.disabled=!canPlay||!knownDuration;
  const playing=!!this.mediaState.playing;
  const play=this.root.querySelector<HTMLButtonElement>('[data-action="play"]')!;play.disabled=!canPlay;play.textContent=playing?"Ⅱ":"▶";play.title=playing?"暂停":"播放";play.setAttribute("aria-label",playing?"暂停":"播放");
  this.ref("playbackTime").textContent=canPlay?elapsedTime(elapsed):"00:00";this.ref("rangeStart").textContent="00:00";this.ref("rangeEnd").textContent=knownDuration?elapsedTime(duration):"时长未读取";
  const source=this.sources().find(m=>m.id===this.mediaState.selectedId),replays=this.sources().filter(m=>m.mode==="replay");
  this.ref("timelineHeading").textContent=source?.name||(replays.length?"选择历史录像开始回放":this.realEvents().length?"事件时间线 · 选择标记查看":"暂无可回放记录");this.ref("timelineHeading").title=source?.name||"";this.ref("trackStatus").textContent=source?(this.mediaState.hasTrack?(this.roamState.available?"航迹已核验":"遥测时间已关联 · 三维航迹待核验"):"未关联航迹 · 视频独立播放"):"";
  this.ref("timelineMarkers").hidden=this.page!=="overview"||canPlay;this.ref("timeline").hidden=this.authoring||!(this.page==="overview"||(this.page==="inspection"&&!!source&&this.inspectionMode==="replay"));
  const rate=this.root.querySelector<HTMLSelectElement>('[data-action="playback-rate"]')!;rate.value=String(this.mediaState.rate||1);rate.disabled=!canPlay;
  this.syncPresentationControls();
  this.root.querySelectorAll<HTMLElement>('[data-action="motion-toggle"]').forEach(e=>{e.textContent=state.animationPaused?"▷":"Ⅱ";e.title=state.animationPaused?"恢复装饰":"暂停装饰";e.setAttribute("aria-label",e.title);e.setAttribute("aria-pressed",String(state.animationPaused));});
 }
 private popover(kind:"layers"|"settings"): void {
  this.ref("popover").hidden=false;this.ref("popoverBackdrop").hidden=false;this.root.dataset.overlay=kind;this.ref("popoverTitle").textContent=kind==="layers"?"图层":"显示设置";
  if(kind==="layers"){
   const names={markers:"参考位置标记",track:"当前巡检轨迹",heat:"事件热力",effects:"选中光圈",links:"航迹流光"};
   this.ref("popoverBody").innerHTML=`<div class="v3-button-row v5-view-actions">${btn("locate",icon("pin")+"定位当前对象","","v3-secondary")}${btn("earth","◎ 地球视角","","v3-secondary")}</div><div class="v3-options">${Object.entries({constructionAreas:"施工区域",railwayAreas:"铁路范围",riskPoints:"风险标记"}).map(([id,name])=>`<label><span>${name}</span><input type="checkbox" data-action="spatial-layer" data-layer="${id}" ${this.spatialLayers[id as keyof typeof this.spatialLayers]?"checked":""}></label>`).join("")}${Object.entries(names).map(([id,name])=>`<label><span>${name}</span><input type="checkbox" data-action="effect-layer" data-layer="${id}" ${this.state!.layers[id as keyof typeof names]?"checked":""}></label>`).join("")}<label><span>工程标注</span><input type="checkbox" data-action="engineering-annotations" ${this.state!.engineeringAnnotations?"checked":""}></label>${this.layers.map(layer=>`<label><span>${esc(layer.name)}</span><input type="checkbox" data-action="asset-layer" data-layer="${esc(layer.id)}" ${layer.visible?"checked":""}></label>`).join("")}</div><p class="v3-muted">工程标注仅显示当前选中对象，避免遮挡模型。</p>`;
  }else this.ref("popoverBody").innerHTML=`<div class="v3-options"><label><span>显示模式</span><select data-action="preference-mode"><option value="presentation" ${this.appliedMode()==="presentation"?"selected":""}>科技展示</option><option value="inspection" ${this.appliedMode()==="inspection"?"selected":""}>实景巡检</option></select></label><label><span>减少装饰动画</span><input type="checkbox" data-action="preference-motion" ${this.state!.reducedMotion?"checked":""}></label><label><span>较大字体</span><input type="checkbox" data-action="preference-font" ${this.preferences.largeText?"checked":""}></label></div><p class="v3-muted">动画与文字偏好会保留；进入项目总览时使用展示外观。</p>`;
 }
 private closePopover(): void { this.ref("popover").hidden=true;this.ref("popoverBackdrop").hidden=true;delete this.root.dataset.overlay; }
 private async chooseMedia(id:string): Promise<void> {
  const media=this.sources().find(m=>m.id===id)||this.dataset?.media.find(m=>m.id===id);if(!media)return;
  if(media.kind!=="video") {
   const alert=this.realEvents().find(a=>a.id===this.state?.selectedAlertId);
   const selected=this.view?.selected, node=(this.page==="components"?this.selectedComponent():undefined)||selected;
   let files=this.associated(alert?.mediaIds||node?.mediaIds||[]).filter(m=>m.kind!=="video");
   if(!files.some(m=>m.id===id))files=[media];
   const pier=selected?.kind==="pier"?selected:selected?.kind==="component"?this.dataset?.nodes.find(n=>n.id===selected.parentId&&n.kind==="pier"):undefined;
   if(pier){
    const scope=new Set([pier.id]);let added=true;
    while(added){added=false;for(const entry of this.dataset!.nodes)if(entry.parentId&&scope.has(entry.parentId)&&!scope.has(entry.id)){scope.add(entry.id);added=true;}}
    files=files.map(file=>{
     if(!file.previewUrl||!file.sourceRecordId)return file;
     const indices=[...new Set(this.dataset!.nodes.filter(n=>scope.has(n.id)&&n.sourceRecordId===file.sourceRecordId&&Number.isInteger(n.sourceEntityIndex)&&n.sourceEntityIndex!>=0).map(n=>n.sourceEntityIndex!))].sort((a,b)=>a-b);
     return indices.length?{...file,previewEntityIndices:indices}:file;
    });
   }
   this.drawing.open(files,id);return;
  }
  const retained=this.state?{nodeId:this.state.selectedId,alertId:this.state.selectedAlertId,fly:false}:undefined;
  if(this.page!=="inspection"&&this.setPage("inspection",true)===false)return;const source=this.sources().find(m=>m.id===id);this.inspectionMode=source?.mode||"replay";this.options.onInspectionModeChange?.(this.inspectionMode);
  try{await this.options.onMedia(media,retained);}catch{this.setVideoStatus("画面暂未能载入，请重新选择或检查视频文件。");}this.refresh();
 }
 private async saveHandle(): Promise<void> {
  const id=this.handleId;if(!id||this.pending.has(id)||!this.options.onHandleEvent)return;const text=(this.drafts.get(id)||"").trim();if(!text){this.errors.set(id,"请填写处理说明后保存。");this.detail();return;}
  this.pending.add(id);this.errors.delete(id);this.detail();
  try{await this.options.onHandleEvent(id,text);this.drafts.delete(id);this.errors.delete(id);this.saved.add(id);if(this.handleId===id)this.handleId=undefined;const input=this.root.querySelector<HTMLTextAreaElement>('[data-action="handle-text"]')!;if(input.dataset.eventId===id){input.value="";delete input.dataset.eventId;}}
  catch{this.errors.set(id,"保存失败，已保留处理说明。请检查连接后重试。");}
  finally{this.pending.delete(id);if(!this.disposed)this.refresh();}
 }
 private click(event:MouseEvent): void {
  if(event.target===this.ref("popoverBackdrop")){this.closePopover();return;}
  const element=(event.target as Element)?.closest<HTMLButtonElement>("[data-action]");if(!element||element.disabled)return;const action=element.dataset.action,state=this.state;
  if(action==="tab")this.setPage(element.dataset.tab as SafetyDashboardPage,true);
  else if(action==="exit")this.options.onExit();else if(action==="earth")this.options.onEarth();else if(action==="refresh")this.options.onRefresh();
  else if(action==="model-optimization"){this.closePopover();this.options.onModelOptimization?.();}
  else if(action==="video-roam")this.options.onVideoRoamChange?.(!this.roamState.enabled);
  else if(action==="roam-stop")this.options.onVideoRoamChange?.(false);
  else if(action==="timeline-records"){if(this.setPage("inspection",true)!==false){this.inspectionMode="replay";this.options.onInspectionModeChange?.("replay");this.refresh();}}
  else if(action==="authoring")this.options.onAuthoring?.();else if(action==="video-settings")this.options.onVideoSettings?.();
  else if(action==="sidebar-toggle"){const side=element.dataset.side!;const open=this.root.classList.toggle(`v3-${side}-open`);this.root.classList.remove(`v3-${side==="left"?"right":"left"}-open`);element.setAttribute("aria-expanded",String(open));}
  else if(action==="popover-close")this.closePopover();else if((action==="layers"||action==="settings")&&state)this.popover(action);
  else if(action==="media")void this.chooseMedia(element.dataset.media!);
  else if(action==="home"&&this.dataset){if(this.options.onHome)this.options.onHome();else if(this.setPage("overview",true)!==false){this.options.onPatch({mode:"presentation"});this.options.onSelect({nodeId:this.dataset.projectId});}}
  else if(action==="locate"&&state)this.options.onSelect({nodeId:state.selectedId,alertId:state.selectedAlertId,fly:true});
  else if(action==="node"||action==="pier"){const id=element.dataset.node!;if(action==="pier"){this.pierId=id;this.category=undefined;}this.options.onSelect({nodeId:id});this.refresh();}
  else if(action==="alert"){const alert=this.realEvents().find(a=>a.id===element.dataset.alert);if(alert&&this.setPage("events",true)!==false){this.riskTab="events";this.handleId=undefined;this.options.onSelect({nodeId:alert.nodeId,alertId:alert.id,fly:alert.positionAvailable!==false});}}
  else if(action==="component"){this.category=element.dataset.component as keyof typeof components;const node=this.selectedComponent();if(node)this.options.onSelect({nodeId:node.id,fly:!!node.modelFeatureId});this.refresh();}
  else if(action==="inspection-mode"){this.inspectionMode=element.dataset.inspectionMode as "live"|"replay";this.options.onInspectionModeChange?.(this.inspectionMode);this.refresh();}
  else if(action==="risk-tab"){this.riskTab=element.dataset.riskTab!;this.refresh();}
  else if(action==="event-filter"){this.eventStatus=element.dataset.status as typeof this.eventStatus;this.options.onEventFilter?.(this.eventStatus,this.eventSearch);this.refresh();}
  else if(action==="handle-start"){this.handleId=element.dataset.alert;this.detail();}
  else if(action==="handle-cancel"){this.handleId=undefined;this.detail();}
  else if(action==="handle-save")void this.saveHandle();
  else if(action==="mode")this.options.onPatch({mode:element.dataset.mode as SafetyState["mode"]});
  else if(action==="motion-toggle"&&state)this.options.onPatch({animationPaused:!state.animationPaused});
  else if(action==="play"&&state)this.options.onPatch({playing:!this.mediaState.playing});
 }
 private change(event:Event): void {
  const input=event.target as HTMLInputElement|HTMLSelectElement,action=input.dataset.action,state=this.state;if(!action||!state)return;
  if(action==="severity")this.options.onPatch({severity:input.value as SafetyState["severity"]});
  else if(action==="playback-rate")this.options.onPlaybackRateChange?.(Number(input.value));
  else if(action==="effect-layer")this.options.onPatch({layers:{...state.layers,[input.dataset.layer!]: (input as HTMLInputElement).checked}});
  else if(action==="spatial-layer"){const key=input.dataset.layer as keyof typeof this.spatialLayers;this.spatialLayers[key]=(input as HTMLInputElement).checked;this.options.onSpatialLayers?.({[key]:this.spatialLayers[key]});}
  else if(action==="asset-layer")this.options.onLayerToggle(input.dataset.layer!,(input as HTMLInputElement).checked);
  else if(action==="engineering-annotations")this.options.onPatch({engineeringAnnotations:(input as HTMLInputElement).checked});
  else if(action==="preference-mode"){this.options.onPatch({mode:input.value as SafetyState["mode"]});this.syncPresentationControls();}
  else if(action==="preference-motion"){this.preferences.reduced=(input as HTMLInputElement).checked;this.options.onPatch({reducedMotion:this.preferences.reduced});this.storePreferences();}
  else if(action==="preference-font"){this.preferences.largeText=(input as HTMLInputElement).checked;this.root.classList.toggle("v3-large-text",this.preferences.largeText);this.storePreferences();this.options.onTextScaleChange?.(!!this.preferences.largeText);this.resizeCharts();}
 }
 private input(event:Event): void {
  const input=event.target as HTMLInputElement|HTMLTextAreaElement,action=input.dataset.action;
  if(action==="time")this.options.onMediaSeekSeconds?.(Number(input.value));
  else if(action==="event-search"){this.eventSearch=input.value.trim();this.options.onEventFilter?.(this.eventStatus,this.eventSearch);this.eventList();}
  else if(action==="pier-search"){this.pierSearch=input.value.trim();this.componentList();}
  else if(action==="handle-text"&&this.handleId){this.drafts.set(this.handleId,input.value);this.errors.delete(this.handleId);this.ref("handleStatus").textContent="保存后由事件服务确认处理结果。";}
 }
 private appliedMode(): SafetyState["mode"]|undefined {
  if(!this.presentationStatus)return this.state?.mode;
  return this.presentationStatus.mode==="showcase"?"presentation":this.presentationStatus.mode==="reality"?"inspection":undefined;
 }
 private syncPresentationControls(): void {
  const mode=this.appliedMode();this.root.dataset.mode=mode||"unavailable";
  this.root.querySelectorAll<HTMLElement>('[data-action="mode"]').forEach(e=>{const selected=e.dataset.mode===mode;e.classList.toggle("is-active",selected);e.setAttribute("aria-pressed",String(selected));});
  const select=this.root.querySelector<HTMLSelectElement>('[data-action="preference-mode"]');if(select)select.value=mode||"";
 }
 /** Runtime output is authoritative; a requested theme cannot claim an unapplied material/crop. */
 setPresentationStatus(status:SafetyPresentationStatus): void {
  this.presentationStatus={...status};this.syncPresentationControls();
  const element=this.ref("presentationStatus");element.hidden=status.ok;
  element.textContent=status.ok?"":status.message||"展示暂不可用，可继续查看实景";
  element.classList.toggle("is-error",!status.ok);
 }
 private storePreferences(): void {try{localStorage.setItem(prefKey,JSON.stringify(this.preferences));}catch{/* Display preferences do not block project work. */}}
 setModelOptimizationVisible(visible:boolean): void {this.optimizationVisible=visible;this.root.classList.toggle("is-optimizing",visible);if(visible)this.closePopover();}
 setVideoRoamState(state:SafetyDashboardVideoRoamState): void {const changed=this.roamState.available!==state.available||JSON.stringify(this.roamState.missing)!==JSON.stringify(state.missing);this.roamState={...state};this.renderRoam();if(changed)this.playback();}
 private renderRoam(): void {
  const state=this.roamState,visible=this.page==="inspection"&&!!this.mediaState.selectedId;
  const key=JSON.stringify([visible,state.available,state.enabled,state.active,state.state,state.label,state.message,state.missing,Math.floor(state.mediaTime||0)]);if(key===this.lastRoamUiKey)return;this.lastRoamUiKey=key;
  this.ref("roamControls").hidden=!visible;
  const button=this.root.querySelector<HTMLButtonElement>('[data-action="video-roam"]')!;
  button.disabled=!state.available;button.classList.toggle("is-active",state.enabled);button.setAttribute("aria-pressed",String(state.enabled));
  const message=[state.message,...(state.missing||[])].filter(Boolean).join("；");button.title=message||state.label;
  this.ref("roamStatus").textContent=state.available?state.label:message?`未关联同录像航迹 · ${/高程|椭球|高度|height/i.test(message)?"高程基准待核验":state.missing?.[0]||state.message}`:"未关联同录像航迹";this.ref("roamStatus").title=message;
  this.ref("roamScene").hidden=!visible||!state.enabled;
  if(this.ref("roamSceneLabel").textContent!==state.label)this.ref("roamSceneLabel").textContent=state.label;
  const time=elapsedTime(state.mediaTime||0);if(this.ref("roamSceneTime").textContent!==time)this.ref("roamSceneTime").textContent=time;
 }
 setPage(page:SafetyDashboardPage,notify=false): boolean {
  if(!Object.hasOwn(pageNames,page))return false;if(notify&&this.options.onPageChange?.(page)===false)return false;
  this.page=page;this.closePopover();this.root.classList.remove("v3-left-open","v3-right-open");this.refresh();this.renderPage();return true;
 }
 setAuthoring(active:boolean): void {this.authoring=active;this.root.classList.toggle("is-authoring",active);if(active)this.setPage("overview");this.renderPage();}
 setMediaSources(sources:SafetyDashboardMediaSource[]): void {this.mediaSources=sources.filter(m=>m.provenance!=="demo");if(this.dataset)this.inspection();}
 setMediaState(state:SafetyDashboardMediaState): void {
  const previous=this.mediaState, oldMode=this.inspectionMode;this.mediaState={...state};if(state.mode)this.inspectionMode=state.mode;
  if(this.dataset && (previous.selectedId!==state.selectedId||previous.error!==state.error||previous.durationSeconds!==state.durationSeconds||oldMode!==this.inspectionMode))this.inspection();
  const updated=state.updatedAt?`更新于 ${clock(state.updatedAt)}`:"";if(this.ref("mediaUpdated").textContent!==updated)this.ref("mediaUpdated").textContent=updated;
  this.playback();
 }
 setVisible(visible:boolean): void {this.visible=visible;this.root.hidden=!visible;if(!visible){this.closePopover();this.drawing.close();this.observer.disconnect();}else{this.observer.observe(this.ref("trend"));this.observer.observe(this.ref("distribution"));this.refresh();this.resizeCharts();}}
 setLoading(text:string): void {this.notice(text,false);}
 setError(text:string): void {this.notice(text,true);}
 private notice(text:string,error:boolean): void {const el=this.ref("notice");el.hidden=!text;el.innerHTML=text?`<span>${esc(text)}</span>${error?btn("refresh","重试","","v3-text-button"):""}`:"";el.classList.toggle("is-error",error);}
 setEventError(error?:string): void {this.eventError=error||"";this.refresh();}
 setVideoStatus(text:string): void {this.videoStatus=text;this.ref("videoStatus").textContent=text;}
 setLayers(layers:SafetyDashboardLayer[]): void {this.layers=layers;if(this.root.dataset.overlay==="layers"&&this.state)this.popover("layers");}
 debugStats(): Record<string,unknown> {return {page:this.page,chartCount:this.disposed?0:2,updates:this.updates,renders:this.renders,visible:this.visible,authoring:this.authoring,presentationStatus:this.presentationStatus,appliedMode:this.appliedMode(),reducedMotion:!!this.state?.reducedMotion,hasVideoHost:!!this.videoHost.isConnected,mediaMode:this.inspectionMode,eventStatus:this.eventStatus,pendingEventSaves:this.pending.size,eventDraftCount:this.drafts.size,optimizationVisible:this.optimizationVisible,roam:this.roamState};}
 dispose(): void {if(this.disposed)return;this.disposed=true;this.events.abort();this.observer.disconnect();this.trend.dispose();this.distribution.dispose();this.drawing.dispose();this.root.remove();}
}
