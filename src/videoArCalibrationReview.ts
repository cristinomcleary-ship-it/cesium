import { reprojectControlPointSessionCpu } from "./videoArCpuReprojection.ts";
import type { ControlPointSession } from "./videoArControlPointSession.ts";
const escape = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const number = (value: number | undefined | null) => Number.isFinite(value) ? value!.toFixed(2) : "缺失 / 无效";
/** Self-contained, offline evidence; only a matching captured frame may be embedded. */
export function calibrationReviewHtml(session: ControlPointSession, originalFramePng?: string, scenePng?: string, sceneNote = "未捕获同帧 Cesium 画面") {
  const report = reprojectControlPointSessionCpu(session);
  const safeImage = (uri: string | undefined) => uri && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(uri) ? uri : undefined;
  const original = safeImage(originalFramePng), scene = safeImage(scenePng);
  const overlay = (phase: "before" | "after") => {
    const marks = report.points.map(point => {
      if (![point.observed.pixelX, point.observed.pixelY].every(Number.isFinite)) return "";
      const p = point[phase], observed = point.observed, color = point.role === "check" ? "#18e8ff" : point.fitMembership === "outlier" ? "#ff9e31" : "#ffee55";
      const common = `<circle cx="${observed.pixelX}" cy="${observed.pixelY}" r="10" fill="none" stroke="${color}" stroke-width="3"/><text x="${observed.pixelX + 12}" y="${observed.pixelY - 12}" fill="${color}" font-size="30">${point.index}</text>`;
      return common + (p?.valid ? `<path d="M ${observed.pixelX} ${observed.pixelY} L ${p.predictedPixelX} ${p.predictedPixelY}" stroke="#ff4141" stroke-width="3"/><path d="M ${p.predictedPixelX! - 9} ${p.predictedPixelY} h 18 M ${p.predictedPixelX} ${p.predictedPixelY! - 9} v 18" stroke="#ff4141" stroke-width="3"/>` : "");
    }).join("");
    return `<svg viewBox="0 0 ${report.image.width} ${report.image.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CPU ${phase} 重投影检查图">${original ? `<image href="${original}" width="${report.image.width}" height="${report.image.height}"/>` : `<rect width="100%" height="100%" fill="#222"/>`} ${marks}</svg>`;
  };
  const rows = report.points.map(point => `<tr><td>${point.index}</td><td>${point.role === "check" ? "检查点" : point.fitMembership === "outlier" ? "拟合异常点（仍保留）" : "拟合点"}</td><td>${number(point.observed.pixelX)}, ${number(point.observed.pixelY)}</td><td>${number(point.before.errorPx1080)}</td><td>${number(point.after?.errorPx1080)}</td><td>${escape(point.after?.reason ?? point.before.reason ?? "")}</td></tr>`).join("");
  const summary = report.summary.after?.normalized1080;
  const data = JSON.stringify({ session, independentCpu: report }, null, 2);
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>视频 AR 同帧 CPU 检查</title><style>body{margin:24px;background:#111923;color:#e9eff6;font:16px/1.6 system-ui}main{max-width:1500px;margin:auto}section{border:1px solid #3b4a5b;padding:16px;margin:16px 0}svg,img{width:100%;height:auto;display:block}table{border-collapse:collapse;width:100%}th,td{border:1px solid #45586b;padding:8px;text-align:left}a{color:#66d9ff}.warning{color:#ffd37b}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:800px){.columns{grid-template-columns:1fr}}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main>
<h1>视频 AR 同帧 CPU 检查</h1><p>PTS ${number(session.frame.frameTime)} 秒 · ${report.image.width} × ${report.image.height} · 记录 ${escape(session.id)}</p>
<p class="warning">尚未通过真实独立检查点验收。检查点未进入求解；若据此调参，须另留新的最终检查点。单帧校准不证明整段视频有效。</p>
<p>黄圈：拟合点；橙圈：被剔除的拟合点；青圈：检查点；红十字与连线：独立 CPU 预测及偏差。${original ? "原视频帧已嵌入。" : "原帧图像缺失：只有坐标图，不能冒充真实画面叠加。"}</p>
<div class="columns"><section><h2>求解前</h2>${overlay("before")}</section><section><h2>求解后</h2>${overlay("after")}</section></div>
<p>按原画幅宽度等比换算至 1920 像素，当前参考高度 ${number(report.image.normalizedHeight)}。全部拟合点 RMS ${number(summary?.fitAll.rmsePx)}px；保留内点 RMS ${number(summary?.fitInliers.rmsePx)}px；检查点 RMS ${number(summary?.checks.rmsePx)}px / P95 ${number(summary?.checks.p95Px)}px / 最大 ${number(summary?.checks.maxErrorPx)}px。</p>
<table><thead><tr><th>点号</th><th>用途</th><th>原像素</th><th>求解前误差（等比1920）</th><th>求解后误差（等比1920）</th><th>无效原因</th></tr></thead><tbody>${rows}</tbody></table>
<section><h2>Cesium 同帧对照</h2><p>${escape(sceneNote)}</p>${scene ? `<img alt="当前同帧 Cesium 投影" src="${scene}">` : "<p>缺失</p>"}</section>
<p><a download="frame_${session.frame.frameTime.toFixed(3)}_cpu-and-control-points.json" href="data:application/json;charset=utf-8,${encodeURIComponent(data)}">下载原始点、相机和 CPU 检查 JSON</a></p><details><summary>相机及验收边界</summary><pre>${escape(JSON.stringify({ cameras: report.cameras, notes: report.notes, context: session.frame.context }, null, 2))}</pre></details></main></html>`;
}
