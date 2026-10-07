import { createSafetyCadPreview } from "./safetyCadPreview.ts";
import type { SafetyMedia } from "./safetyTypes.ts";

const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function safetyMediaUrl(value: string): string | undefined {
  try { const url = new URL(value, location.href); return value.trim() && ["http:", "https:", "blob:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

/** Previews existing files only. Closing never changes the scene, selected object, or media decoder. */
export class SafetyDrawingViewer {
  private readonly dialog = document.createElement("dialog");
  private readonly events = new AbortController();
  private media: SafetyMedia[] = [];
  private index = 0;
  private zoom = 1;
  private opener?: HTMLElement;
  private cad?: ReturnType<typeof createSafetyCadPreview>;
  private cadId?: string;
  constructor(host: HTMLElement, private readonly onWorkbench: () => void) {
    this.dialog.className = "safety-drawing-viewer";
    this.dialog.setAttribute("aria-label", "施工图查看");
    host.append(this.dialog);
    this.dialog.addEventListener("click", e => {
      const action = (e.target as Element)?.closest<HTMLElement>("[data-drawing]")?.dataset.drawing;
      if (action === "close") this.close();
      if (action === "previous" && this.index > 0) { this.index--; this.zoom = 1; this.render(); }
      if (action === "next" && this.index < this.media.length - 1) { this.index++; this.zoom = 1; this.render(); }
      if (action === "zoom-in" || action === "zoom-out" || action === "fit" || action === "fit-all") {
        this.zoom = action === "fit" || action === "fit-all" ? 1 : Math.max(.5, Math.min(3, this.zoom + (action === "zoom-in" ? .25 : -.25)));
        if(action === "fit" || action === "fit-all") this.cad?.fit(action === "fit-all");
        this.renderPreview();
      }
      if (action === "workbench") { this.close(); this.onWorkbench(); }
    }, { signal: this.events.signal });
    this.dialog.addEventListener("cancel", e => { e.preventDefault(); this.close(); }, { signal: this.events.signal });
  }
  open(media: SafetyMedia[], selectedId?: string): void {
    this.media = media.filter(m => m.kind !== "video");
    if (!this.media.length) return;
    this.index = Math.max(0, this.media.findIndex(m => m.id === selectedId)); this.zoom = 1;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.render(); if (!this.dialog.open) this.dialog.showModal();
  }
  private format(): "image" | "pdf" | "cad" | "unsupported" {
    const media = this.media[this.index]; const file = `${media.name} ${media.url.split(/[?#]/)[0]}`.toLowerCase();
    return media.previewUrl ? "cad" : /\.(png|jpe?g|webp|gif|bmp|svg)(?:\s|$)/i.test(file) || media.kind === "photo" ? "image" : /\.pdf(?:\s|$)/i.test(file) ? "pdf" : "unsupported";
  }
  private render(): void {
    this.cad?.dispose(); this.cad = undefined; this.cadId = undefined;
    const item = this.media[this.index], url = safetyMediaUrl(item.url), supported = this.format() !== "unsupported" && !!(url || item.previewUrl);
    this.dialog.innerHTML = `<header><div><h2>${escapeHtml(item.name)}</h2><p>${item.provenance === "demo" ? "示例资料" : item.relation === "object" ? "对象关联资料" : "项目参考资料"}</p></div><button type="button" data-drawing="close" aria-label="关闭图纸">×</button></header><div class="safety-drawing-tools"><div><button type="button" data-drawing="previous" ${this.index === 0 ? "disabled" : ""}>上一张</button><span>${this.index + 1} / ${this.media.length}</span><button type="button" data-drawing="next" ${this.index === this.media.length - 1 ? "disabled" : ""}>下一张</button></div><div><button type="button" data-drawing="zoom-out" ${!supported ? "disabled" : ""} aria-label="缩小">−</button><output data-drawing-zoom>100%</output><button type="button" data-drawing="zoom-in" ${!supported ? "disabled" : ""} aria-label="放大">＋</button><button type="button" data-drawing="fit" ${!supported ? "disabled" : ""}>适合窗口</button>${this.format()==="cad"?'<button type="button" data-drawing="fit-all">查看全图</button>':""}</div>${url ? `<a href="${escapeHtml(url)}" download="${escapeHtml(item.name)}" target="_blank" rel="noopener noreferrer">下载原文件 ↗</a>` : ""}</div><div class="safety-drawing-content" data-drawing-content></div><footer>关闭后返回当前对象${this.format() === "pdf" ? " · PDF 页码与翻页使用文档工具栏" : ""}</footer>`;
    this.renderPreview();
  }
  private renderPreview(): void {
    const item = this.media[this.index], url = safetyMediaUrl(item.url), format = this.format();
    const content = this.dialog.querySelector<HTMLElement>("[data-drawing-content]")!;
    this.dialog.querySelector("[data-drawing-zoom]")!.textContent = `${Math.round(this.zoom * 100)}%`;
    if (format === "cad" && item.previewUrl) {
      if(this.cadId!==item.id || !this.cad){this.cad?.dispose();this.cad=createSafetyCadPreview(content,item);this.cadId=item.id;}
      this.cad.setZoom(this.zoom);
    } else if (!url || format === "unsupported") {
      content.innerHTML = `<div class="safety-drawing-empty"><span>▧</span><h3>${url ? "此文件请在原工作台查看" : "文件暂不可用"}</h3><p>${url ? "当前格式未提供在线预览，可下载原文件或使用已有 CAD 查看功能。" : "请检查资料文件，或选择其他施工图。"}</p><button type="button" data-drawing="workbench">打开原工作台</button></div>`;
    } else if (format === "pdf") {
      const frame = document.createElement("iframe"); frame.title = item.name; frame.src = `${url.split("#")[0]}#zoom=${Math.round(this.zoom * 100)}&toolbar=1`;
      frame.className = "safety-drawing-pdf"; content.replaceChildren(frame);
    } else {
      let img = content.querySelector<HTMLImageElement>("img");
      if (!img || img.dataset.media !== item.id) {
        img = document.createElement("img"); img.alt = item.name; img.dataset.media = item.id; img.src = url;
        img.addEventListener("error", () => { content.innerHTML = '<div class="safety-drawing-empty"><h3>图纸加载失败</h3><p>可下载原文件，或切换其他资料继续查看。</p></div>'; }, { once: true });
        content.replaceChildren(img);
      }
      img.style.width = `${this.zoom * 100}%`;
    }
  }
  close(): void { this.cad?.dispose(); this.cad=undefined; this.cadId=undefined; if (this.dialog.open) this.dialog.close(); this.dialog.replaceChildren(); this.opener?.focus({ preventScroll: true }); }
  dispose(): void { this.close(); this.events.abort(); this.dialog.remove(); }
}
