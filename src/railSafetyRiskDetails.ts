import type { ManagementRecord } from "./managementTypes";
import type { RailSafetyRiskSnapshot } from "./railSafetyRiskTypes";

const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
const metres = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} m` : "未记录";

/** Authorized server snapshots only; missing/redacted sources produce no details. */
export function railSafetyRiskDetails(record: ManagementRecord): string {
  const risk = record.railSafetyRisk as RailSafetyRiskSnapshot | undefined;
  if (risk?.schemaVersion !== 1 || risk.source !== "browser-geometric-screening") return "";
  const rows = [
    ["机械", risk.resourceSnapshot?.name], ["铁路设备限界", risk.limitSnapshot?.name],
    ["登记时任务", risk.taskSnapshot?.name || "未关联任务"],
    ["筛查关系", risk.status === "overlap" ? "潜在侵限" : "接触边界"],
    ["最远投影距站位", metres(risk.maxDistanceMeters)], ["限界间距", metres(risk.distanceMeters)],
    ["捕获时间", risk.capturedAt], ["登记时间", risk.registeredAt],
  ];
  return `<section class="mg-rail-risk-source" data-role="rail-risk-source"><h3>登记时的机械筛查快照</h3><p class="mg-state-note">人工登记的浏览器几何筛查，待现场核实。此快照用于追溯；当前机械位置或形态变化后，以重新计算的结果为准。</p><dl class="kv-list">${rows.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>${risk.description ? `<p>${escape(risk.description)}</p>` : ""}<details class="mg-source-details"><summary>来源修订与计算说明</summary><p>机械修订 ${escape(risk.resourceRevision)} · 管控配置修订 ${escape(risk.machineConfigRevision)} · 限界修订 ${escape(risk.limitRevision)}${risk.taskRevision ? ` · 任务修订 ${escape(risk.taskRevision)}` : ""}</p><p>固定支承线下完整模型 0°–90° 全方向扫掠外包；服务端校验保存版本，未重新计算几何。</p>${(risk.warnings || []).map(warning => `<p>${escape(warning)}</p>`).join("")}</details></section>`;
}
