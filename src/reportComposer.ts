import "./reportComposer.css";

export type ReportElementType = "text" | "image" | "video" | "shape" | "table" | "bar" | "line" | "pie" | "metric" | "button";
export type ReportElementAnimation = "none" | "fade" | "slideLeft" | "slideRight" | "rise" | "zoom";
export type ReportElementActionType = "none" | "gotoPage" | "flyToPage" | "toggleLayer" | "openUrl";

export type ReportElementAction = {
  type: ReportElementActionType;
  target: string;
  targetName: string;
  url: string;
};

export type ReportOverlayElement = {
  id: string;
  type: ReportElementType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  content: string;
  data: string;
  source: string;
  mediaName: string;
  color: string;
  background: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  fontSize: number;
  fontWeight: number;
  textAlign: "left" | "center" | "right";
  opacity: number;
  animation: ReportElementAnimation;
  animationDelay: number;
  action: ReportElementAction;
};

export type ReportComposerSlide = {
  id: string;
  elements: ReportOverlayElement[];
  showCard: boolean;
};

export type ReportComposerPageOption = { id: string; title: string };
export type ReportComposerLayerOption = { id: string; name: string; kind: string; visible: boolean };

type ReportComposerHost = {
  getSlide: () => ReportComposerSlide | null;
  getPages: () => ReportComposerPageOption[];
  getLayers: () => ReportComposerLayerOption[];
  loadImage: (file: File) => Promise<string>;
  changed: () => void;
  executeAction: (action: ReportElementAction) => void;
  toast: (message: string, error?: boolean) => void;
  beginInteractionSession?: () => (() => void);
};

type DragState = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  elementX: number;
  elementY: number;
  elementWidth: number;
  elementHeight: number;
  canvasWidth: number;
  canvasHeight: number;
};

const ELEMENT_TYPES: Array<{ type: ReportElementType; icon: string; label: string }> = [
  { type: "text", icon: "T", label: "文字" },
  { type: "image", icon: "▧", label: "图片" },
  { type: "video", icon: "▶", label: "视频" },
  { type: "shape", icon: "■", label: "色块" },
  { type: "table", icon: "▦", label: "表格" },
  { type: "bar", icon: "▥", label: "柱状图" },
  { type: "line", icon: "⌁", label: "折线图" },
  { type: "pie", icon: "◕", label: "饼图" },
  { type: "metric", icon: "88", label: "指标" },
  { type: "button", icon: "↗", label: "按钮" },
];

const TYPE_LABEL = Object.fromEntries(ELEMENT_TYPES.map((item) => [item.type, item.label])) as Record<ReportElementType, string>;
const TYPE_SET = new Set<ReportElementType>(ELEMENT_TYPES.map((item) => item.type));
const ANIMATION_SET = new Set<ReportElementAnimation>(["none", "fade", "slideLeft", "slideRight", "rise", "zoom"]);
const ACTION_SET = new Set<ReportElementActionType>(["none", "gotoPage", "flyToPage", "toggleLayer", "openUrl"]);
const ALIGN_SET = new Set<ReportOverlayElement["textAlign"]>(["left", "center", "right"]);

export const reportComposerPanelHtml = `
  <details class="report-composer-panel" open>
    <summary><span>自由页面编排</span><small id="reportComposerCount">0 个组件</small></summary>
    <p class="hint">文字、图片、视频、表格、统计图和按钮都可直接放到三维画面上，并用鼠标拖动、缩放。</p>
    <div class="report-template-row">
      <select id="reportComposerTemplate" aria-label="页面模板">
        <option value="cover">工程封面</option>
        <option value="story">图文说明</option>
        <option value="dashboard">数据看板</option>
        <option value="progress">施工进度</option>
        <option value="blank">空白画布</option>
      </select>
      <button id="reportApplyTemplate">应用模板</button>
    </div>
    <div class="report-component-palette">
      ${ELEMENT_TYPES.map((item) => `<button data-report-add-element="${item.type}"><b>${item.icon}</b><span>${item.label}</span></button>`).join("")}
    </div>
    <button id="reportComposerToggle" class="report-composer-toggle">在三维画面上编排</button>
    <div id="reportElementList" class="report-element-list"></div>
    <div id="reportElementProperties" class="report-element-properties hidden">
      <div class="report-property-heading"><strong id="reportElementTypeName">组件属性</strong><span id="reportElementPosition"></span></div>
      <label id="reportElementContentField"><span id="reportElementContentLabel">内容</span><textarea id="reportElementContent" rows="3" maxlength="3000"></textarea></label>
      <label id="reportElementDataField" class="hidden"><span id="reportElementDataLabel">数据</span><textarea id="reportElementData" rows="5" maxlength="8000" placeholder="名称,数值"></textarea></label>
      <label id="reportElementSourceField" class="hidden">媒体网址<input id="reportElementSource" type="url" placeholder="https://..." /></label>
      <label id="reportElementImageFileField" class="report-file-button hidden">选择本地图片<input id="reportElementImageFile" type="file" accept="image/png,image/jpeg,image/webp" hidden /></label>
      <label id="reportElementVideoFileField" class="report-file-button hidden">选择本地视频（仅本次打开有效）<input id="reportElementVideoFile" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" hidden /></label>
      <div class="field-grid report-position-grid">
        <label>X %<input id="reportElementX" type="number" min="0" max="100" step="0.1" /></label>
        <label>Y %<input id="reportElementY" type="number" min="0" max="100" step="0.1" /></label>
        <label>宽度 %<input id="reportElementWidth" type="number" min="4" max="100" step="0.1" /></label>
        <label>高度 %<input id="reportElementHeight" type="number" min="4" max="100" step="0.1" /></label>
        <label>旋转 °<input id="reportElementRotation" type="number" min="-180" max="180" step="1" /></label>
        <label>圆角 px<input id="reportElementRadius" type="number" min="0" max="100" step="1" /></label>
      </div>
      <div class="field-grid report-style-grid">
        <label>文字/图形色<input id="reportElementColor" type="color" /></label>
        <label>背景色<input id="reportElementBackground" type="color" /></label>
        <label>边框色<input id="reportElementBorderColor" type="color" /></label>
        <label>边框宽度<input id="reportElementBorderWidth" type="number" min="0" max="20" step="1" /></label>
        <label>字号<input id="reportElementFontSize" type="number" min="8" max="160" step="1" /></label>
        <label>字重<select id="reportElementFontWeight"><option value="400">常规</option><option value="600">半粗</option><option value="800">粗体</option></select></label>
        <label>对齐<select id="reportElementTextAlign"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
        <label>透明度<input id="reportElementOpacity" type="range" min="0.1" max="1" step="0.05" /></label>
      </div>
      <div class="field-grid report-animation-grid">
        <label>入场动画<select id="reportElementAnimation"><option value="none">无</option><option value="fade">淡入</option><option value="slideLeft">左侧滑入</option><option value="slideRight">右侧滑入</option><option value="rise">上浮</option><option value="zoom">缩放出现</option></select></label>
        <label>延迟（秒）<input id="reportElementAnimationDelay" type="number" min="0" max="30" step="0.1" /></label>
      </div>
      <div id="reportElementActionPanel" class="report-action-panel hidden">
        <label>点击动作<select id="reportElementActionType"><option value="none">无动作</option><option value="gotoPage">跳转汇报页</option><option value="flyToPage">飞往页面视角</option><option value="toggleLayer">显示/隐藏图层</option><option value="openUrl">打开网页链接</option></select></label>
        <label id="reportActionPageField" class="hidden">目标汇报页<select id="reportElementActionPage"></select></label>
        <label id="reportActionLayerField" class="hidden">目标工程图层<select id="reportElementActionLayer"></select></label>
        <label id="reportActionUrlField" class="hidden">网页地址<input id="reportElementActionUrl" type="url" placeholder="https://..." /></label>
      </div>
      <div class="report-element-actions">
        <button id="reportElementBackward">下移一层</button><button id="reportElementForward">上移一层</button>
        <button id="reportElementDuplicate">复制</button><button id="reportElementDelete" class="danger">删除</button>
      </div>
    </div>
  </details>`;

export const reportComposerWorkspaceHtml = `
  <div id="reportComposerWorkspace" class="report-composer-workspace" aria-hidden="true">
    <div class="report-composer-workspace-bar"><span>自由编排画布 · 拖动组件，右下角缩放</span><button id="reportComposerDone">完成编排</button></div>
    <div id="reportComposerCanvas" class="report-composer-canvas"></div>
  </div>`;

export const reportComposerPresentationHtml = `<div id="reportLiveElements" class="report-live-elements"></div>`;

function composerById<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`三维汇报编排控件缺失：${id}`);
  return element as T;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function color(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function safeMediaSource(value: string, type: "image" | "video") {
  try {
    if (type === "image" && /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(value)) return value;
    if (value.startsWith("blob:")) return value;
    const url = new URL(value, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
  } catch { /* Invalid sources render as a placeholder. */ }
  return "";
}

function defaultAction(): ReportElementAction {
  return { type: "none", target: "", targetName: "", url: "" };
}

function createElement(type: ReportElementType, index = 0): ReportOverlayElement {
  const offset = (index % 6) * 2;
  const common: ReportOverlayElement = {
    id: crypto.randomUUID(),
    type,
    name: TYPE_LABEL[type],
    x: 8 + offset,
    y: 15 + offset,
    width: 28,
    height: 14,
    rotation: 0,
    zIndex: index + 1,
    content: TYPE_LABEL[type],
    data: "",
    source: "",
    mediaName: "",
    color: "#eaf7ff",
    background: "#071522",
    borderColor: "#3c7088",
    borderWidth: 1,
    borderRadius: 10,
    fontSize: 24,
    fontWeight: 600,
    textAlign: "left",
    opacity: 0.92,
    animation: "fade",
    animationDelay: 0,
    action: defaultAction(),
  };
  if (type === "text") return { ...common, content: "双击属性输入汇报文字", width: 38, height: 12, fontSize: 30, fontWeight: 800, background: "#081a2a" };
  if (type === "image") return { ...common, content: "图片", width: 36, height: 32, background: "#0b1c29" };
  if (type === "video") return { ...common, content: "视频", width: 38, height: 30, background: "#02070d" };
  if (type === "shape") return { ...common, content: "", width: 28, height: 18, color: "#45d9f5", background: "#147a9a", borderColor: "#55dff7", opacity: 0.7 };
  if (type === "table") return { ...common, content: "工程数据", data: "项目,计划,完成\n土方,100,82\n支护,100,65\n主体,100,38", width: 38, height: 32, fontSize: 14 };
  if (type === "bar" || type === "line" || type === "pie") return { ...common, content: "施工进度", data: "土方,82\n支护,65\n主体,38\n安装,22", width: 36, height: 30, color: "#54dcf5", fontSize: 14 };
  if (type === "metric") return { ...common, content: "82%", data: "总体完成率", width: 19, height: 16, color: "#63e6b4", fontSize: 38, fontWeight: 800, textAlign: "center" };
  return { ...common, content: "查看重点区域", width: 18, height: 8, color: "#07131f", background: "#53dff6", borderColor: "#9af0ff", fontSize: 15, fontWeight: 800, textAlign: "center" };
}

export function normalizeReportOverlayElements(value: unknown): ReportOverlayElement[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 160).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const source = raw as Partial<ReportOverlayElement>;
    const type = TYPE_SET.has(source.type as ReportElementType) ? source.type as ReportElementType : "text";
    const fallback = createElement(type, index);
    const actionSource = source.action && typeof source.action === "object" ? source.action as Partial<ReportElementAction> : {};
    const actionType = ACTION_SET.has(actionSource.type as ReportElementActionType) ? actionSource.type as ReportElementActionType : "none";
    const width = clamp(source.width, fallback.width, 4, 100);
    const height = clamp(source.height, fallback.height, type === "shape" ? .5 : 4, 100);
    return [{
      ...fallback,
      id: typeof source.id === "string" ? source.id : crypto.randomUUID(),
      name: typeof source.name === "string" ? source.name.slice(0, 80) : fallback.name,
      x: clamp(source.x, fallback.x, 0, 100 - width),
      y: clamp(source.y, fallback.y, 0, 100 - height),
      width,
      height,
      rotation: clamp(source.rotation, 0, -180, 180),
      zIndex: Math.round(clamp(source.zIndex, index + 1, 0, 999)),
      content: typeof source.content === "string" ? source.content.slice(0, 3000) : fallback.content,
      data: typeof source.data === "string" ? source.data.slice(0, 8000) : fallback.data,
      source: typeof source.source === "string" ? source.source.slice(0, 4_000_000) : "",
      mediaName: typeof source.mediaName === "string" ? source.mediaName.slice(0, 200) : "",
      color: color(source.color, fallback.color),
      background: color(source.background, fallback.background),
      borderColor: color(source.borderColor, fallback.borderColor),
      borderWidth: clamp(source.borderWidth, fallback.borderWidth, 0, 20),
      borderRadius: clamp(source.borderRadius, fallback.borderRadius, 0, 100),
      fontSize: clamp(source.fontSize, fallback.fontSize, 8, 160),
      fontWeight: Math.round(clamp(source.fontWeight, fallback.fontWeight, 300, 900) / 100) * 100,
      textAlign: ALIGN_SET.has(source.textAlign as ReportOverlayElement["textAlign"]) ? source.textAlign as ReportOverlayElement["textAlign"] : fallback.textAlign,
      opacity: clamp(source.opacity, fallback.opacity, 0.1, 1),
      animation: ANIMATION_SET.has(source.animation as ReportElementAnimation) ? source.animation as ReportElementAnimation : "none",
      animationDelay: clamp(source.animationDelay, 0, 0, 30),
      action: {
        type: actionType,
        target: typeof actionSource.target === "string" ? actionSource.target.slice(0, 200) : "",
        targetName: typeof actionSource.targetName === "string" ? actionSource.targetName.slice(0, 300) : "",
        url: typeof actionSource.url === "string" ? actionSource.url.slice(0, 2000) : "",
      },
    }];
  });
}

function dataRows(value: string) {
  return value.split(/\r?\n/).map((line) => line.split(/[,\t|]/).map((cell) => cell.trim())).filter((row) => row.some(Boolean)).slice(0, 20);
}

function numericSeries(value: string) {
  return dataRows(value).map((row, index) => ({ label: row[0] || `数据${index + 1}`, value: Number(row[1]) })).filter((item) => Number.isFinite(item.value)).slice(0, 12);
}

function renderChart(element: ReportOverlayElement) {
  const series = numericSeries(element.data);
  if (!series.length) return '<div class="report-overlay-placeholder">请输入“名称,数值”数据</div>';
  const maximum = Math.max(...series.map((item) => Math.abs(item.value)), 1);
  if (element.type === "bar") {
    const gap = 100 / series.length;
    const bars = series.map((item, index) => {
      const height = Math.max(2, Math.abs(item.value) / maximum * 62);
      const x = index * gap + gap * 0.18;
      return `<g><rect x="${x.toFixed(2)}" y="${(72 - height).toFixed(2)}" width="${(gap * .64).toFixed(2)}" height="${height.toFixed(2)}" rx="1.5"></rect><text x="${(x + gap * .32).toFixed(2)}" y="87">${escapeHtml(item.label.slice(0, 8))}</text><text class="value" x="${(x + gap * .32).toFixed(2)}" y="${Math.max(8, 68 - height).toFixed(2)}">${item.value}</text></g>`;
    }).join("");
    return `<div class="report-overlay-chart-title">${escapeHtml(element.content)}</div><svg class="report-overlay-chart" viewBox="0 0 100 92" preserveAspectRatio="none">${bars}</svg>`;
  }
  if (element.type === "line") {
    const gap = series.length === 1 ? 0 : 92 / (series.length - 1);
    const points = series.map((item, index) => `${4 + index * gap},${72 - Math.abs(item.value) / maximum * 58}`).join(" ");
    const dots = series.map((item, index) => `<circle cx="${4 + index * gap}" cy="${72 - Math.abs(item.value) / maximum * 58}" r="2"></circle><text x="${4 + index * gap}" y="87">${escapeHtml(item.label.slice(0, 7))}</text>`).join("");
    return `<div class="report-overlay-chart-title">${escapeHtml(element.content)}</div><svg class="report-overlay-chart" viewBox="0 0 100 92" preserveAspectRatio="none"><polyline points="${points}"></polyline>${dots}</svg>`;
  }
  const total = series.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1;
  const palette = ["#4edcf5", "#6c8fff", "#63e6b4", "#ffd166", "#ff7c91", "#ad7bff"];
  let cursor = 0;
  const stops = series.map((item, index) => {
    const start = cursor;
    cursor += Math.max(0, item.value) / total * 100;
    return `${palette[index % palette.length]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  }).join(",");
  return `<div class="report-overlay-chart-title">${escapeHtml(element.content)}</div><div class="report-pie-layout"><div class="report-pie" style="background:conic-gradient(${stops})"></div><div class="report-pie-legend">${series.map((item, index) => `<span><i style="background:${palette[index % palette.length]}"></i>${escapeHtml(item.label)} ${item.value}</span>`).join("")}</div></div>`;
}

function renderElementInner(element: ReportOverlayElement, live: boolean, localVideoUrl?: string) {
  if (element.type === "text" || element.type === "shape") return `<div class="report-overlay-text">${escapeHtml(element.content)}</div>`;
  if (element.type === "metric") return `<div class="report-overlay-metric"><strong>${escapeHtml(element.content)}</strong><span>${escapeHtml(element.data)}</span></div>`;
  if (element.type === "image") {
    const source = safeMediaSource(element.source, "image");
    return source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(element.mediaName || element.content)}" />` : '<div class="report-overlay-placeholder">▧<span>选择图片或填写网址</span></div>';
  }
  if (element.type === "video") {
    const source = safeMediaSource(localVideoUrl || element.source, "video");
    return source && live ? `<video src="${escapeHtml(source)}" controls playsinline></video>` : `<div class="report-overlay-placeholder video">▶<span>${escapeHtml(element.mediaName || "填写视频网址或选择文件")}</span></div>`;
  }
  if (element.type === "table") {
    const rows = dataRows(element.data);
    if (!rows.length) return '<div class="report-overlay-placeholder">请输入表格数据</div>';
    return `<div class="report-overlay-table-title">${escapeHtml(element.content)}</div><table><thead><tr>${rows[0].map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  if (element.type === "bar" || element.type === "line" || element.type === "pie") return renderChart(element);
  return live ? `<button class="report-overlay-action-button" data-report-action-element="${escapeHtml(element.id)}">${escapeHtml(element.content)}</button>` : `<div class="report-overlay-action-button">${escapeHtml(element.content)}</div>`;
}

function elementStyle(element: ReportOverlayElement) {
  return `left:${element.x}%;top:${element.y}%;width:${element.width}%;height:${element.height}%;z-index:${element.zIndex};transform:rotate(${element.rotation}deg);color:${element.color};background:${element.background};border:${element.borderWidth}px solid ${element.borderColor};border-radius:${element.borderRadius}px;opacity:${element.opacity};font-size:${element.fontSize}px;font-weight:${element.fontWeight};text-align:${element.textAlign};--report-element-delay:${element.animationDelay}s`;
}

function renderElement(element: ReportOverlayElement, live: boolean, selected: boolean, localVideoUrl?: string) {
  return `<div class="report-overlay-element type-${element.type} animation-${element.animation}${selected ? " selected" : ""}" data-report-element-id="${escapeHtml(element.id)}" style="${elementStyle(element)}">${renderElementInner(element, live, localVideoUrl)}${live ? "" : '<span class="report-overlay-drag-label">拖动</span><i class="report-overlay-resize" title="缩放"></i>'}</div>`;
}

function templateElements(template: string): ReportOverlayElement[] {
  if (template === "blank") return [];
  if (template === "cover") {
    const title = createElement("text", 0);
    Object.assign(title, { content: "项目建设成果三维汇报", x: 7, y: 24, width: 48, height: 16, fontSize: 44, background: "#071522", borderColor: "#4bdcf5", borderWidth: 1, animation: "slideLeft" });
    const subtitle = createElement("text", 1);
    Object.assign(subtitle, { content: "BIM + GIS · 数字孪生 · 工程可视化", x: 7, y: 43, width: 37, height: 8, fontSize: 18, color: "#72dff3", background: "#071522", animationDelay: .2 });
    const line = createElement("shape", 2);
    Object.assign(line, { x: 7, y: 21, width: 10, height: .8, borderWidth: 0, borderRadius: 2, background: "#4bdcf5", opacity: 1 });
    return [title, subtitle, line];
  }
  if (template === "story") {
    const title = createElement("text", 0);
    Object.assign(title, { content: "重点区域说明", x: 5, y: 11, width: 38, height: 11, fontSize: 34, animation: "slideLeft" });
    const body = createElement("text", 1);
    Object.assign(body, { content: "在这里输入方案背景、设计思路和关键控制点。右侧图片可以替换为现场照片、效果图或施工示意图。", x: 5, y: 25, width: 34, height: 30, fontSize: 18, fontWeight: 400, animation: "rise", animationDelay: .15 });
    const image = createElement("image", 2);
    Object.assign(image, { x: 57, y: 14, width: 38, height: 52, animation: "slideRight", animationDelay: .1 });
    return [title, body, image];
  }
  if (template === "dashboard") {
    const title = createElement("text", 0);
    Object.assign(title, { content: "项目数据总览", x: 4, y: 8, width: 35, height: 9, fontSize: 30, animation: "slideLeft" });
    const metrics = [["82%", "总体完成率", "#63e6b4"], ["126", "在场人员", "#54dcf5"], ["3", "风险预警", "#ff7c91"]].map((values, index) => {
      const item = createElement("metric", index + 1);
      Object.assign(item, { content: values[0], data: values[1], color: values[2], x: 4 + index * 20, y: 20, width: 17, height: 15, animation: "zoom", animationDelay: index * .12 });
      return item;
    });
    const bar = createElement("bar", 4);
    Object.assign(bar, { content: "分项工程进度", x: 4, y: 40, width: 42, height: 38, animation: "rise", animationDelay: .25 });
    const pie = createElement("pie", 5);
    Object.assign(pie, { content: "资源投入", data: "人员,45\n机械,28\n材料,27", x: 51, y: 20, width: 31, height: 33, animation: "rise", animationDelay: .35 });
    return [title, ...metrics, bar, pie];
  }
  const title = createElement("text", 0);
  Object.assign(title, { content: "施工进度计划", x: 4, y: 8, width: 34, height: 9, fontSize: 30 });
  const table = createElement("table", 1);
  Object.assign(table, { content: "关键节点", data: "节点,计划日期,完成率\n围护施工,2026-08-20,100%\n土方开挖,2026-09-10,82%\n主体结构,2026-10-30,38%", x: 4, y: 22, width: 43, height: 42, animation: "slideLeft" });
  const line = createElement("line", 2);
  Object.assign(line, { content: "周完成趋势", data: "第1周,22\n第2周,36\n第3周,58\n第4周,82", x: 52, y: 22, width: 39, height: 36, animation: "slideRight" });
  const button = createElement("button", 3);
  Object.assign(button, { content: "飞往施工重点", x: 52, y: 63, width: 18, height: 8, animation: "fade", animationDelay: .4 });
  return [title, table, line, button];
}

export class ReportComposer {
  private selectedElementId: string | null = null;
  private editing = false;
  private reportTabActive = false;
  private dragState: DragState | null = null;
  private readonly localVideoUrls = new Map<string, string>();
  private restoreEditingSession: (() => void) | null = null;
  private readonly onPointerMove = (event: PointerEvent) => this.handlePointerMove(event);
  private readonly onPointerUp = () => this.finishDrag();
  private readonly onPointerCancel = () => this.finishDrag();
  private readonly onWindowBlur = () => this.finishDrag();
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);

  constructor(private readonly host: ReportComposerHost) {
    this.bindControls();
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("keydown", this.onKeyDown);
  }

  dispose() {
    this.exitEditing();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("keydown", this.onKeyDown);
    for (const url of new Set(this.localVideoUrls.values())) URL.revokeObjectURL(url);
    this.localVideoUrls.clear();
  }

  setReportTabActive(active: boolean) {
    this.reportTabActive = active;
    if (!active) this.exitEditing();
    this.updateWorkspaceVisibility();
  }

  exitEditing() {
    const restore = this.restoreEditingSession;
    this.restoreEditingSession = null;
    this.editing = false;
    try { restore?.(); } catch (error) { console.warn("[3D report composer] Unable to restore scene interaction", error); }
    this.updateWorkspaceVisibility();
    this.updateToggleButton();
  }

  private enterEditing() {
    if (this.editing) return true;
    try {
      this.restoreEditingSession = this.host.beginInteractionSession?.() ?? null;
    } catch (error) {
      console.error("[3D report composer] Unable to begin scene interaction session", error);
      this.host.toast("无法暂停当前场景工具，请先结束正在进行的选点或编辑", true);
      return false;
    }
    this.editing = true;
    this.updateWorkspaceVisibility();
    this.updateToggleButton();
    return true;
  }

  copyTransientVideoSource(sourceElementId: string, targetElementId: string) {
    const source = this.localVideoUrls.get(sourceElementId);
    if (source) this.localVideoUrls.set(targetElementId, source);
  }

  releaseTransientMediaForElements(elements: ReportOverlayElement[]) {
    elements.forEach((element) => this.releaseTransientVideo(element.id));
  }

  clearTransientMedia() {
    for (const url of new Set(this.localVideoUrls.values())) URL.revokeObjectURL(url);
    this.localVideoUrls.clear();
  }

  refresh() {
    const slide = this.host.getSlide();
    if (!slide) {
      this.selectedElementId = null;
      if (this.editing || this.restoreEditingSession) this.exitEditing();
    } else if (!slide.elements.some((element) => element.id === this.selectedElementId)) {
      this.selectedElementId = slide.elements.at(-1)?.id ?? null;
    }
    this.renderElementList();
    this.renderProperties();
    this.renderWorkspace();
    this.updateToggleButton();
  }

  renderPresentation(elements: ReportOverlayElement[]) {
    const root = composerById<HTMLElement>("reportLiveElements");
    root.innerHTML = elements.slice().sort((a, b) => a.zIndex - b.zIndex).map((element) => renderElement(element, true, false, this.localVideoUrls.get(element.id))).join("");
    root.querySelectorAll<HTMLButtonElement>("[data-report-action-element]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const element = elements.find((candidate) => candidate.id === button.dataset.reportActionElement);
      if (element) this.host.executeAction(element.action);
    }));
  }

  private bindControls() {
    document.querySelectorAll<HTMLButtonElement>("[data-report-add-element]").forEach((button) => button.addEventListener("click", () => this.addElement(button.dataset.reportAddElement as ReportElementType)));
    composerById<HTMLButtonElement>("reportComposerToggle").addEventListener("click", () => {
      if (!this.host.getSlide()) return this.host.toast("请先新建汇报页", true);
      if (this.editing) this.exitEditing(); else this.enterEditing();
    });
    composerById<HTMLButtonElement>("reportComposerDone").addEventListener("click", () => this.exitEditing());
    composerById<HTMLButtonElement>("reportApplyTemplate").addEventListener("click", () => this.applyTemplate());
    composerById<HTMLButtonElement>("reportElementDuplicate").addEventListener("click", () => this.duplicateSelected());
    composerById<HTMLButtonElement>("reportElementDelete").addEventListener("click", () => this.deleteSelected());
    composerById<HTMLButtonElement>("reportElementForward").addEventListener("click", () => this.changeLayer(1));
    composerById<HTMLButtonElement>("reportElementBackward").addEventListener("click", () => this.changeLayer(-1));
    this.bindText("reportElementContent", (element, value) => { element.content = value.slice(0, 3000); });
    this.bindText("reportElementData", (element, value) => { element.data = value.slice(0, 8000); });
    this.bindText("reportElementSource", (element, value) => {
      element.source = value.trim().slice(0, 4000);
      element.mediaName = "";
      this.releaseTransientVideo(element.id);
    });
    this.bindNumber("reportElementX", (element, value) => { element.x = clamp(value, element.x, 0, 100 - element.width); });
    this.bindNumber("reportElementY", (element, value) => { element.y = clamp(value, element.y, 0, 100 - element.height); });
    this.bindNumber("reportElementWidth", (element, value) => { element.width = clamp(value, element.width, 4, 100 - element.x); });
    this.bindNumber("reportElementHeight", (element, value) => { element.height = clamp(value, element.height, element.type === "shape" ? .5 : 4, 100 - element.y); });
    this.bindNumber("reportElementRotation", (element, value) => { element.rotation = clamp(value, element.rotation, -180, 180); });
    this.bindNumber("reportElementRadius", (element, value) => { element.borderRadius = clamp(value, element.borderRadius, 0, 100); });
    this.bindNumber("reportElementBorderWidth", (element, value) => { element.borderWidth = clamp(value, element.borderWidth, 0, 20); });
    this.bindNumber("reportElementFontSize", (element, value) => { element.fontSize = clamp(value, element.fontSize, 8, 160); });
    this.bindNumber("reportElementAnimationDelay", (element, value) => { element.animationDelay = clamp(value, element.animationDelay, 0, 30); });
    this.bindNumber("reportElementOpacity", (element, value) => { element.opacity = clamp(value, element.opacity, .1, 1); }, "input");
    this.bindText("reportElementColor", (element, value) => { element.color = color(value, element.color); }, "input");
    this.bindText("reportElementBackground", (element, value) => { element.background = color(value, element.background); }, "input");
    this.bindText("reportElementBorderColor", (element, value) => { element.borderColor = color(value, element.borderColor); }, "input");
    this.bindText("reportElementFontWeight", (element, value) => { element.fontWeight = clamp(value, element.fontWeight, 300, 900); }, "change");
    this.bindText("reportElementTextAlign", (element, value) => { if (ALIGN_SET.has(value as ReportOverlayElement["textAlign"])) element.textAlign = value as ReportOverlayElement["textAlign"]; }, "change");
    this.bindText("reportElementAnimation", (element, value) => { if (ANIMATION_SET.has(value as ReportElementAnimation)) element.animation = value as ReportElementAnimation; }, "change");
    composerById<HTMLSelectElement>("reportElementActionType").addEventListener("change", (event) => {
      const element = this.selectedElement();
      if (!element) return;
      const type = (event.currentTarget as HTMLSelectElement).value as ReportElementActionType;
      element.action.type = ACTION_SET.has(type) ? type : "none";
      element.action.target = "";
      element.action.targetName = "";
      if (type === "gotoPage" || type === "flyToPage") element.action.target = this.host.getPages()[0]?.id ?? "";
      if (type === "toggleLayer") {
        const layer = this.host.getLayers()[0];
        element.action.target = layer?.id ?? "";
        element.action.targetName = layer ? JSON.stringify([layer.kind, layer.name]) : "";
      }
      this.notifyChange(true);
    });
    composerById<HTMLSelectElement>("reportElementActionPage").addEventListener("change", (event) => {
      const element = this.selectedElement();
      if (!element) return;
      element.action.target = (event.currentTarget as HTMLSelectElement).value;
      this.notifyChange();
    });
    composerById<HTMLSelectElement>("reportElementActionLayer").addEventListener("change", (event) => {
      const element = this.selectedElement();
      if (!element) return;
      const selected = (event.currentTarget as HTMLSelectElement).selectedOptions[0];
      element.action.target = selected?.value ?? "";
      element.action.targetName = selected?.dataset.fallback ?? "";
      this.notifyChange();
    });
    this.bindText("reportElementActionUrl", (element, value) => { element.action.url = value.trim().slice(0, 2000); });
    composerById<HTMLInputElement>("reportElementImageFile").addEventListener("change", (event) => void this.loadImage((event.currentTarget as HTMLInputElement).files?.[0]));
    composerById<HTMLInputElement>("reportElementVideoFile").addEventListener("change", (event) => this.loadVideo((event.currentTarget as HTMLInputElement).files?.[0]));
  }

  private bindText(id: string, mutate: (element: ReportOverlayElement, value: string) => void, eventName: "input" | "change" = "input") {
    composerById<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).addEventListener(eventName, (event) => {
      const element = this.selectedElement();
      if (!element) return;
      mutate(element, (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
      this.notifyChange();
    });
  }

  private bindNumber(id: string, mutate: (element: ReportOverlayElement, value: string) => void, eventName: "input" | "change" = "change") {
    this.bindText(id, mutate, eventName);
  }

  private notifyChange(refreshProperties = false) {
    this.host.changed();
    this.renderWorkspace();
    if (refreshProperties) this.renderProperties();
  }

  private addElement(type: ReportElementType) {
    const slide = this.host.getSlide();
    if (!slide || !TYPE_SET.has(type)) return this.host.toast("请先新建汇报页", true);
    if (!this.enterEditing()) return;
    const element = createElement(type, slide.elements.length);
    slide.elements.push(element);
    this.selectedElementId = element.id;
    this.host.changed();
    this.refresh();
  }

  private applyTemplate() {
    const slide = this.host.getSlide();
    if (!slide) return this.host.toast("请先新建汇报页", true);
    if (slide.elements.length && !window.confirm("应用模板会替换本页自由组件，是否继续？")) return;
    if (!this.enterEditing()) return;
    const template = composerById<HTMLSelectElement>("reportComposerTemplate").value;
    this.releaseTransientMediaForElements(slide.elements);
    slide.elements.splice(0, slide.elements.length, ...templateElements(template));
    slide.showCard = false;
    this.selectedElementId = slide.elements[0]?.id ?? null;
    this.host.changed();
    this.refresh();
    this.host.toast(template === "blank" ? "已清空自由画布" : "页面模板已应用，可直接拖动修改");
  }

  private selectedElement() {
    return this.host.getSlide()?.elements.find((element) => element.id === this.selectedElementId) ?? null;
  }

  private duplicateSelected() {
    const slide = this.host.getSlide();
    const selected = this.selectedElement();
    if (!slide || !selected) return;
    const copy = structuredClone(selected);
    copy.id = crypto.randomUUID();
    copy.name = `${selected.name}副本`.slice(0, 80);
    copy.x = Math.min(100 - copy.width, copy.x + 2);
    copy.y = Math.min(100 - copy.height, copy.y + 2);
    copy.zIndex = Math.max(0, ...slide.elements.map((element) => element.zIndex)) + 1;
    const videoUrl = this.localVideoUrls.get(selected.id);
    if (videoUrl) this.localVideoUrls.set(copy.id, videoUrl);
    slide.elements.push(copy);
    this.selectedElementId = copy.id;
    this.host.changed();
    this.refresh();
  }

  private deleteSelected() {
    const slide = this.host.getSlide();
    const selected = this.selectedElement();
    if (!slide || !selected) return;
    slide.elements.splice(slide.elements.indexOf(selected), 1);
    this.releaseTransientVideo(selected.id);
    this.selectedElementId = slide.elements.at(-1)?.id ?? null;
    this.host.changed();
    this.refresh();
  }

  private changeLayer(direction: number) {
    const element = this.selectedElement();
    if (!element) return;
    element.zIndex = Math.round(clamp(element.zIndex + direction, element.zIndex, 0, 999));
    this.notifyChange(true);
    this.renderElementList();
  }

  private async loadImage(file: File | undefined) {
    const element = this.selectedElement();
    if (!file || !element || element.type !== "image") return;
    try {
      element.source = await this.host.loadImage(file);
      element.mediaName = file.name;
      this.host.changed();
      this.refresh();
      this.host.toast("图片已加入自由画布");
    } catch (error) {
      this.host.toast(error instanceof Error ? error.message : "图片读取失败", true);
    } finally {
      composerById<HTMLInputElement>("reportElementImageFile").value = "";
    }
  }

  private loadVideo(file: File | undefined) {
    const element = this.selectedElement();
    if (!file || !element || element.type !== "video") return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) return this.host.toast("请选择视频文件", true);
    this.releaseTransientVideo(element.id);
    const url = URL.createObjectURL(file);
    this.localVideoUrls.set(element.id, url);
    element.source = "";
    element.mediaName = file.name;
    this.host.changed();
    this.refresh();
    this.host.toast("本地视频已加入；导出文件不会复制视频本体");
    composerById<HTMLInputElement>("reportElementVideoFile").value = "";
  }

  private releaseTransientVideo(elementId: string) {
    const url = this.localVideoUrls.get(elementId);
    if (!url) return;
    this.localVideoUrls.delete(elementId);
    if (![...this.localVideoUrls.values()].includes(url)) URL.revokeObjectURL(url);
  }

  private renderElementList() {
    const root = composerById<HTMLElement>("reportElementList");
    const elements = this.host.getSlide()?.elements ?? [];
    composerById<HTMLElement>("reportComposerCount").textContent = `${elements.length} 个组件`;
    if (!elements.length) {
      root.innerHTML = '<div class="report-empty compact">选择上方组件或应用模板</div>';
      return;
    }
    root.innerHTML = elements.slice().sort((a, b) => b.zIndex - a.zIndex).map((element) => `<button class="report-element-list-row${element.id === this.selectedElementId ? " active" : ""}" data-report-element-list-id="${escapeHtml(element.id)}"><span>${escapeHtml(TYPE_LABEL[element.type])}</span><strong>${escapeHtml((element.content || element.name).slice(0, 28))}</strong><small>层 ${element.zIndex}</small></button>`).join("");
    root.querySelectorAll<HTMLButtonElement>("[data-report-element-list-id]").forEach((button) => button.addEventListener("click", () => {
      this.selectedElementId = button.dataset.reportElementListId!;
      this.renderElementList();
      this.renderProperties();
      this.renderWorkspace();
    }));
  }

  private renderProperties() {
    const element = this.selectedElement();
    const root = composerById<HTMLElement>("reportElementProperties");
    root.classList.toggle("hidden", !element);
    if (!element) return;
    composerById<HTMLElement>("reportElementTypeName").textContent = `${TYPE_LABEL[element.type]}属性`;
    composerById<HTMLElement>("reportElementPosition").textContent = `${element.x.toFixed(1)}%, ${element.y.toFixed(1)}%`;
    const contentField = composerById<HTMLElement>("reportElementContentField");
    contentField.classList.toggle("hidden", element.type === "image" || element.type === "video");
    composerById<HTMLElement>("reportElementContentLabel").textContent = element.type === "button" ? "按钮文字" : element.type === "metric" ? "指标数值" : element.type === "shape" ? "色块文字（可选）" : "标题/内容";
    composerById<HTMLTextAreaElement>("reportElementContent").value = element.content;
    const dataVisible = element.type === "table" || element.type === "bar" || element.type === "line" || element.type === "pie" || element.type === "metric";
    composerById<HTMLElement>("reportElementDataField").classList.toggle("hidden", !dataVisible);
    composerById<HTMLElement>("reportElementDataLabel").textContent = element.type === "metric" ? "指标说明" : element.type === "table" ? "表格数据（首行为表头）" : "图表数据（每行：名称,数值）";
    composerById<HTMLTextAreaElement>("reportElementData").value = element.data;
    const mediaVisible = element.type === "image" || element.type === "video";
    composerById<HTMLElement>("reportElementSourceField").classList.toggle("hidden", !mediaVisible);
    const sourceInput = composerById<HTMLInputElement>("reportElementSource");
    sourceInput.value = /^https?:/i.test(element.source) ? element.source : "";
    sourceInput.placeholder = element.source.startsWith("data:image/") ? `已嵌入 ${element.mediaName || "本地图片"}` : "https://...";
    composerById<HTMLElement>("reportElementImageFileField").classList.toggle("hidden", element.type !== "image");
    composerById<HTMLElement>("reportElementVideoFileField").classList.toggle("hidden", element.type !== "video");
    const numericValues: Array<[string, number]> = [["reportElementX", element.x], ["reportElementY", element.y], ["reportElementWidth", element.width], ["reportElementHeight", element.height], ["reportElementRotation", element.rotation], ["reportElementRadius", element.borderRadius], ["reportElementBorderWidth", element.borderWidth], ["reportElementFontSize", element.fontSize], ["reportElementOpacity", element.opacity], ["reportElementAnimationDelay", element.animationDelay]];
    numericValues.forEach(([id, value]) => { composerById<HTMLInputElement>(id).value = String(value); });
    composerById<HTMLInputElement>("reportElementHeight").min = element.type === "shape" ? "0.5" : "4";
    composerById<HTMLInputElement>("reportElementColor").value = element.color;
    composerById<HTMLInputElement>("reportElementBackground").value = element.background;
    composerById<HTMLInputElement>("reportElementBorderColor").value = element.borderColor;
    composerById<HTMLSelectElement>("reportElementFontWeight").value = String(element.fontWeight);
    composerById<HTMLSelectElement>("reportElementTextAlign").value = element.textAlign;
    composerById<HTMLSelectElement>("reportElementAnimation").value = element.animation;
    const actionPanel = composerById<HTMLElement>("reportElementActionPanel");
    actionPanel.classList.toggle("hidden", element.type !== "button");
    if (element.type !== "button") return;
    composerById<HTMLSelectElement>("reportElementActionType").value = element.action.type;
    const pages = this.host.getPages();
    const pageSelect = composerById<HTMLSelectElement>("reportElementActionPage");
    pageSelect.innerHTML = pages.map((page) => `<option value="${escapeHtml(page.id)}">${escapeHtml(page.title)}</option>`).join("");
    pageSelect.value = element.action.target;
    const layers = this.host.getLayers();
    const layerSelect = composerById<HTMLSelectElement>("reportElementActionLayer");
    layerSelect.innerHTML = layers.map((layer) => `<option value="${escapeHtml(layer.id)}" data-fallback="${escapeHtml(JSON.stringify([layer.kind, layer.name]))}">${escapeHtml(layer.name)} · ${layer.visible ? "显示" : "隐藏"}</option>`).join("");
    layerSelect.value = element.action.target;
    composerById<HTMLInputElement>("reportElementActionUrl").value = element.action.url;
    const pageAction = element.action.type === "gotoPage" || element.action.type === "flyToPage";
    composerById<HTMLElement>("reportActionPageField").classList.toggle("hidden", !pageAction);
    composerById<HTMLElement>("reportActionLayerField").classList.toggle("hidden", element.action.type !== "toggleLayer");
    composerById<HTMLElement>("reportActionUrlField").classList.toggle("hidden", element.action.type !== "openUrl");
  }

  private renderWorkspace() {
    const slide = this.host.getSlide();
    const canvas = composerById<HTMLElement>("reportComposerCanvas");
    canvas.innerHTML = slide?.elements.slice().sort((a, b) => a.zIndex - b.zIndex).map((element) => renderElement(element, false, element.id === this.selectedElementId, this.localVideoUrls.get(element.id))).join("") ?? "";
    canvas.querySelectorAll<HTMLElement>("[data-report-element-id]").forEach((node) => {
      node.addEventListener("pointerdown", (event) => this.beginDrag(event, node.dataset.reportElementId!, (event.target as HTMLElement).closest(".report-overlay-resize") ? "resize" : "move"));
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectedElementId = node.dataset.reportElementId!;
        this.renderElementList();
        this.renderProperties();
        this.renderWorkspace();
      });
    });
    this.updateWorkspaceVisibility();
  }

  private beginDrag(event: PointerEvent, id: string, mode: "move" | "resize") {
    if (event.button !== 0) return;
    const element = this.host.getSlide()?.elements.find((candidate) => candidate.id === id);
    const canvas = composerById<HTMLElement>("reportComposerCanvas");
    if (!element) return;
    const bounds = canvas.getBoundingClientRect();
    this.selectedElementId = id;
    this.dragState = { id, mode, startX: event.clientX, startY: event.clientY, elementX: element.x, elementY: element.y, elementWidth: element.width, elementHeight: element.height, canvasWidth: bounds.width || 1, canvasHeight: bounds.height || 1 };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  private handlePointerMove(event: PointerEvent) {
    const drag = this.dragState;
    if (!drag) return;
    const element = this.host.getSlide()?.elements.find((candidate) => candidate.id === drag.id);
    const node = composerById<HTMLElement>("reportComposerCanvas").querySelector<HTMLElement>(`[data-report-element-id="${CSS.escape(drag.id)}"]`);
    if (!element || !node) return this.finishDrag();
    const deltaX = (event.clientX - drag.startX) / drag.canvasWidth * 100;
    const deltaY = (event.clientY - drag.startY) / drag.canvasHeight * 100;
    if (drag.mode === "move") {
      element.x = clamp(drag.elementX + deltaX, element.x, 0, 100 - element.width);
      element.y = clamp(drag.elementY + deltaY, element.y, 0, 100 - element.height);
    } else {
      element.width = clamp(drag.elementWidth + deltaX, element.width, 4, 100 - element.x);
      element.height = clamp(drag.elementHeight + deltaY, element.height, element.type === "shape" ? .5 : 4, 100 - element.y);
    }
    node.style.left = `${element.x}%`;
    node.style.top = `${element.y}%`;
    node.style.width = `${element.width}%`;
    node.style.height = `${element.height}%`;
    composerById<HTMLElement>("reportElementPosition").textContent = `${element.x.toFixed(1)}%, ${element.y.toFixed(1)}%`;
    composerById<HTMLInputElement>("reportElementX").value = element.x.toFixed(1);
    composerById<HTMLInputElement>("reportElementY").value = element.y.toFixed(1);
    composerById<HTMLInputElement>("reportElementWidth").value = element.width.toFixed(1);
    composerById<HTMLInputElement>("reportElementHeight").value = element.height.toFixed(1);
  }

  private finishDrag() {
    if (!this.dragState) return;
    this.dragState = null;
    this.host.changed();
    this.renderElementList();
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (!this.editing || !this.reportTabActive || !this.selectedElement()) return;
    const target = event.target as HTMLElement;
    if (target.matches("input,textarea,select")) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.duplicateSelected();
      return;
    }
    const element = this.selectedElement();
    if (!element || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 2 : .5;
    if (event.key === "ArrowLeft") element.x = clamp(element.x - step, element.x, 0, 100 - element.width);
    if (event.key === "ArrowRight") element.x = clamp(element.x + step, element.x, 0, 100 - element.width);
    if (event.key === "ArrowUp") element.y = clamp(element.y - step, element.y, 0, 100 - element.height);
    if (event.key === "ArrowDown") element.y = clamp(element.y + step, element.y, 0, 100 - element.height);
    this.notifyChange(true);
  }

  private updateWorkspaceVisibility() {
    const active = this.editing && this.reportTabActive && Boolean(this.host.getSlide());
    const workspace = composerById<HTMLElement>("reportComposerWorkspace");
    workspace.classList.toggle("active", active);
    workspace.setAttribute("aria-hidden", String(!active));
  }

  private updateToggleButton() {
    const button = composerById<HTMLButtonElement>("reportComposerToggle");
    button.classList.toggle("active", this.editing);
    button.textContent = this.editing ? "收起画面编排" : "在三维画面上编排";
    button.disabled = !this.host.getSlide();
  }
}
