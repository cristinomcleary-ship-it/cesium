import { cadPreviewBounds } from "./safetyCadPreviewBounds.ts";
import type { CadImportEntity, CadImportPackage } from "./cadImport";
import type { SafetyMedia } from "./safetyTypes";

/** Draw the library's already converted CAD geometry; no synthetic construction detail is added. */
export function createSafetyCadPreview(host: HTMLElement, media: SafetyMedia): { dispose(): void; setZoom(scale: number): void; fit(all?: boolean): void } {
  const canvas = document.createElement("canvas"), status = document.createElement("p");
  canvas.style.cssText = "display:block;width:100%;height:100%;min-height:380px;touch-action:none;cursor:grab;background:#f8fafc";
  canvas.setAttribute("aria-label", `${media.name}，原始CAD图纸二维预览，可拖动和缩放`);
  status.textContent = "正在读取原图…"; status.style.cssText = "position:absolute;left:18px;bottom:14px;color:#334155;background:#ffffffdf;padding:8px 12px;font-size:14px;pointer-events:none";
  host.style.position = "relative"; host.replaceChildren(canvas, status);
  const abort = new AbortController(); let disposed = false, entities: CadImportEntity[] = [], originalEntities: CadImportEntity[] = [];
  let zoom = 1, panX = 0, panY = 0, cx = 0, cy = 0, spanX = 1, spanY = 1;
  let drag: { x: number; y: number; panX: number; panY: number } | undefined;
  const draw = () => {
    if (disposed) return;
    const width = Math.max(100, host.clientWidth), height = Math.max(380, host.clientHeight), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#f8fafc"; ctx.fillRect(0, 0, width, height);
    const scale = Math.min((width - 90) / spanX, (height - 90) / spanY) * zoom;
    const x = (value: number) => (value - cx) * scale + width / 2 + panX;
    const y = (value: number) => -(value - cy) * scale + height / 2 + panY;
    ctx.lineWidth = 1.2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const entity of entities) {
      const points = entity.vertices; if (!points.length || entity.type === "POINT") continue;
      const color = /^#[\da-f]{6}$/i.test(entity.color || "") && entity.color!.toUpperCase() !== "#FFFFFF" ? entity.color! : "#334155";
      const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
      const readable = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 160 ? `rgb(${rgb.map(v => Math.round(v * .55)).join(",")})` : color;
      ctx.strokeStyle = readable; ctx.fillStyle = readable;
      if (entity.type === "TEXT") {
        const size = Math.min(100, Math.max(3, (entity.textHeight || spanY / 80) * scale));
        ctx.font = `${size}px "Microsoft YaHei", sans-serif`; ctx.fillText(entity.text || "", x(points[0].x), y(points[0].y));
      } else if (points.length >= 2) {
        ctx.beginPath(); ctx.moveTo(x(points[0].x), y(points[0].y));
        for (const point of points.slice(1)) ctx.lineTo(x(point.x), y(point.y));
        if (entity.closed) ctx.closePath(); ctx.stroke();
      }
    }
  };
  const fitView = (all = false) => {
    const bounds = cadPreviewBounds(originalEntities, media.previewEntityIndices, all); if (!bounds) return false;
    ({ cx, cy, spanX, spanY } = bounds); zoom = 1; panX = panY = 0;
    status.textContent = `项目 CAD 原图 · ${bounds.mode === "selected" ? "当前墩位编号区域" : bounds.mode === "numbered" ? "工程编号区域" : "全部图元"} · 未绑定构件专属图 · 拖动平移，滚轮缩放`;
    return true;
  };
  const observer = new ResizeObserver(draw); observer.observe(host);
  canvas.addEventListener("pointerdown", e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, panX, panY }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; }, { signal: abort.signal });
  canvas.addEventListener("pointermove", e => { if (!drag) return; panX = drag.panX + e.clientX - drag.x; panY = drag.panY + e.clientY - drag.y; draw(); }, { signal: abort.signal });
  const end = () => { drag = undefined; canvas.style.cursor = "grab"; };
  canvas.addEventListener("pointerup", end, { signal: abort.signal }); canvas.addEventListener("pointercancel", end, { signal: abort.signal });
  canvas.addEventListener("wheel", e => { e.preventDefault(); zoom = Math.max(.25, Math.min(30, zoom * Math.exp(-e.deltaY * .0015))); draw(); }, { passive: false, signal: abort.signal });
  void (async () => {
    try {
      const url = new URL(media.previewUrl || "", location.href);
      if (!media.previewUrl || url.origin !== location.origin || !url.pathname.startsWith("/__library/files/")) throw new Error("图纸预览来源不可用");
      const response = await fetch(url, { signal: abort.signal, headers: { "X-Cesium-Library": "1" } });
      if (!response.ok) throw new Error("原图读取失败");
      const data: CadImportPackage = await response.json();
      if (data.format !== "cesium-cad-import" || !Array.isArray(data.entities)) throw new Error("当前图纸格式暂不支持预览");
      entities = data.entities.filter(entity => entity.type !== "POINT" && Array.isArray(entity.vertices) && entity.vertices.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
      originalEntities = data.entities;
      if (!fitView()) throw new Error("图纸没有可预览的线条");
      if (disposed) return; draw();
    } catch (error) { if (!disposed) status.textContent = error instanceof Error ? `${error.message}，可下载原文件。` : "图纸加载失败，可下载原文件。"; }
  })();
  return {
    setZoom(value) { zoom = Math.max(.25, Math.min(30, value)); draw(); },
    fit(all = false) { fitView(all); draw(); },
    dispose() { if (disposed) return; disposed = true; abort.abort(); observer.disconnect(); canvas.remove(); status.remove(); },
  };
}
