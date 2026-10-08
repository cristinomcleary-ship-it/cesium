import { MODEL_OPTIMIZATION_API, type ModelInspection } from "./safetyModelOptimizationTypes.ts";
import type { ModelRegistryEntry } from "./safetySpatialTypes.ts";
import "./safetyModelOptimization.css";

type Options = {
  host: HTMLElement; getModels(): readonly ModelRegistryEntry[];
  onVisibility(visible: boolean): void;
  onCompare(original: boolean): void;
};
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** An honest frontend for the installed processing capabilities; unavailable geometry actions never pretend to succeed. */
export class SafetyModelOptimization {
  private readonly panel = document.createElement("aside");
  private readonly events = new AbortController();
  private request?: AbortController;
  private visible = false;
  private disposed = false;
  private loading = false;
  private original = false;
  private error = "";
  private report?: ModelInspection;
  private modelId?: string;
  constructor(private readonly options: Options) {
    this.panel.className = "safety-model-optimization";
    this.panel.hidden = true; this.panel.setAttribute("aria-label", "模型优化"); options.host.append(this.panel);
    this.panel.addEventListener("click", e => {
      const button = (e.target as Element).closest<HTMLButtonElement>("[data-optimize]");
      if (!button || button.disabled) return;
      const action = button.dataset.optimize;
      if (action === "close") this.close();
      if (action === "inspect") void this.inspect();
      if (action === "original" || action === "display") { this.original = action === "original"; this.options.onCompare(this.original); this.render(); }
      if (action === "export" && this.report) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(this.report, null, 2)], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = `model-inspection-${this.report.source.assetId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }, { signal: this.events.signal });
    this.panel.addEventListener("change", e => { if ((e.target as Element).matches("[data-optimize-model]")) { this.cancelInspection(); this.modelId = (e.target as HTMLSelectElement).value; this.report = undefined; this.error = ""; this.render(); } }, { signal: this.events.signal });
  }
  open(initialOriginal = false): void { if (this.disposed) return; this.original = initialOriginal; this.visible = true; this.panel.hidden = false; this.options.onVisibility(true); this.render(); }
  close(): void { if (!this.visible) return; this.visible = false; this.cancelInspection(); this.panel.hidden = true; this.original = false; this.options.onVisibility(false); }
  get isOpen(): boolean { return this.visible; }
  private cancelInspection(): void { this.request?.abort(); this.request = undefined; this.loading = false; }
  private async inspect(): Promise<void> {
    const model = this.options.getModels().find(m => m.assetId === this.modelId) || this.options.getModels()[0];
    if (!model || this.loading) return;
    this.request?.abort(); const request = this.request = new AbortController();
    this.loading = true; this.error = ""; this.render();
    try {
      const response = await fetch(`${MODEL_OPTIMIZATION_API}/inspect?${new URLSearchParams({ assetId: model.assetId, expectedVersion: model.assetVersion })}`, { signal: request.signal, cache: "no-store" });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "检查失败，请重试");
      if (this.request !== request || !this.visible || this.disposed) return;
      const current = this.options.getModels().find(m => m.assetId === this.modelId);
      if (!current || current.assetId !== model.assetId || current.assetVersion !== model.assetVersion
        || current.coordinateTransformVersion !== model.coordinateTransformVersion || result.source?.assetId !== model.assetId
        || result.source?.assetVersion !== current.assetVersion || result.source?.coordinateTransformVersion !== current.coordinateTransformVersion)
        throw new Error("模型版本或坐标变换已变化，请刷新后重新检查");
      this.report = result as ModelInspection;
    } catch (e) { if (this.request === request && this.visible && !this.disposed && !request.signal.aborted) this.error = e instanceof Error ? e.message : "模型检查失败，原模型保持不变"; }
    finally { if (this.request === request) { this.loading = false; this.request = undefined; if (this.visible) this.render(); } }
  }
  private render(): void {
    const models = this.options.getModels();
    const model = models.find(m => m.assetId === this.modelId) || models[0]; this.modelId = model?.assetId;
    if (this.report && (this.report.source.assetId !== model?.assetId || this.report.source.assetVersion !== model.assetVersion
      || this.report.source.coordinateTransformVersion !== model.coordinateTransformVersion)) this.report = undefined;
    const report = this.report;
    const button = (action: string, text: string, attrs = "") => `<button type="button" data-optimize="${action}" ${attrs}>${text}</button>`;
    const results = report ? `<div class="model-quality-results"><section><h3>显示问题 <span>${report.display.status === "checked" ? "文件检查完成" : "需处理"}</span></h3><p>${report.inventory.tilesetDocuments} 份瓦片索引 · ${report.inventory.binaryTiles} 个 b3dm</p>${report.display.issues.length ? `<ul>${report.display.issues.slice(0, 5).map(i => `<li>${esc(i.summary)}<small>${esc(i.evidence)}</small></li>`).join("")}</ul>` : '<p>未发现缺失引用或无效文件头。画面与 LOD 仍需同镜头检查。</p>'}</section><section><h3>几何缺陷 <span>待处理</span></h3><p>${esc(report.mesh.reason)}</p></section><section><h3>纹理问题 <span>未核验</span></h3><p>${esc(report.texture.reason)}</p></section></div>
      <div class="model-display-comparison"><strong>同镜头显示对照</strong><div>${button("original", "原始显示", `aria-pressed="${this.original}"`)}${button("display", "当前展示", `aria-pressed="${!this.original}"`)}</div><p>仅核对裁切与显示，不代表网格已修复。</p></div>
      <div class="model-candidate-status"><strong>暂无已核验候选版本</strong><p>接入可编辑源网格、处理日志和配准核验后，方可预览与应用。未核验补面不供业务取点。</p></div>
      <div class="model-action-grid">${button("candidate", "预览修复", 'disabled title="无真实候选版本"')}${button("apply", "应用优化", 'disabled title="未完成候选核验"')}${button("rollback", "恢复原版本", 'disabled title="当前已是原版本，尚无优化激活记录"')}</div><div class="model-report-actions">${button("inspect", "重新检查", this.loading ? "disabled" : "")}${button("export", "检查记录")}</div>` : `<div class="model-inspection-start"><strong>${model ? "检查当前工程模型" : "暂无可检查模型"}</strong><p>${model ? "检查文件完整性、瓦片层级和变换，保留原始模型与用户记录。" : "先加载已核验的项目倾斜摄影。"}</p>${button("inspect", this.loading ? "正在检查…" : "检查模型", !model || this.loading ? "disabled" : 'class="model-primary"')}</div>`;
    this.panel.innerHTML = `<header><h2>模型优化</h2>${button("close", "×", 'aria-label="关闭模型优化"')}</header><div class="model-optimization-body">${models.length > 1 ? `<label>当前模型<select data-optimize-model>${models.map(m => `<option value="${esc(m.assetId)}" ${m.assetId === this.modelId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>` : `<strong class="model-source-name">${esc(model?.name || "模型未接入")}</strong>`}<p class="model-version" title="${esc(model?.assetVersion)}">原始版本 ${esc(model?.assetVersion.slice(0, 12) || "未读取")} · 只读保留</p><ol class="model-optimization-steps"><li class="active">检查</li><li>预览</li><li>应用</li></ol>${this.loading ? '<p class="model-inspection-progress" role="status">正在读取实际瓦片文件，请稍候…</p>' : ""}${this.error ? `<p class="model-inspection-error" role="alert">${esc(this.error)}；原模型保持不变</p>` : ""}${results}<p class="model-optimization-note">显示优化和几何修复分别记录；桥孔、涵洞及真实开放边界不可自动封闭。</p></div>`;
  }
  debugStats(): Record<string, unknown> { return { visible: this.visible, loading: this.loading, originalPreview: this.original, modelId: this.modelId, reportId: this.report?.id, activeVersion: this.report?.activeVersion, candidateCount: this.report?.candidates.length || 0, capabilities: this.report?.capabilities, error: this.error }; }
  dispose(): void { if (this.disposed) return; this.close(); this.disposed = true; this.events.abort(); this.panel.remove(); }
}
