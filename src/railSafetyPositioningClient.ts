import { validateRailSafetyPositionSample } from "./railSafetyPositioning.ts";
import type { RailSafetyPositionSample } from "./railSafetyTypes.ts";
import type { RailSafetyPositioningSnapshot } from "./railSafetyPositioningTransport.ts";

export type RailSafetyPositioningClientStatus = { state: "idle" | "loading" | "connected" | "error"; message: string; httpStatus?: number };
export type RailSafetyPositioningClientOptions = {
  onSnapshot: (snapshot: RailSafetyPositioningSnapshot, updates: RailSafetyPositionSample[]) => void;
  onStatus?: (status: RailSafetyPositioningClientStatus) => void;
  intervalMs?: number;
  /** Injectable transport for tests; production uses same-origin fetch and session cookies. */
  fetch?: typeof fetch;
};

function validateSnapshot(input: unknown, projectId: string): RailSafetyPositioningSnapshot {
  if (!input || typeof input !== "object") throw new Error("定位状态响应无效");
  const value = input as RailSafetyPositioningSnapshot;
  if (value.schemaVersion !== 1 || value.projectId !== projectId || typeof value.enabled !== "boolean" || typeof value.serverTime !== "string" || !Number.isFinite(Date.parse(value.serverTime)) || !Array.isArray(value.devices) || value.devices.length > 10_000) throw new Error("定位状态响应无效");
  const seen = new Set<string>();
  const devices = value.devices.map(device => {
    if (!device || typeof device.guardId !== "string" || typeof device.deviceId !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(device.guardId) || !/^[a-zA-Z0-9:_-]{1,120}$/.test(device.deviceId) || typeof device.configured !== "boolean" || seen.has(device.deviceId)) throw new Error("定位设备响应无效");
    seen.add(device.deviceId);
    const sample = device.sample === undefined ? undefined : validateRailSafetyPositionSample(device.sample);
    if (sample && (!device.configured || sample.projectId !== projectId || sample.deviceId !== device.deviceId || sample.source !== "measured")) throw new Error("定位响应超出当前设备绑定");
    if (device.receivedAt !== undefined && (typeof device.receivedAt !== "string" || !Number.isFinite(Date.parse(device.receivedAt)))) throw new Error("定位接收时间无效");
    return { guardId: device.guardId, deviceId: device.deviceId, configured: device.configured, ...(sample ? { sample, receivedAt: device.receivedAt } : {}) };
  });
  return { schemaVersion: 1, projectId, serverTime: value.serverTime, enabled: value.enabled, devices };
}

/** A single in-flight poll. Identity changes and disposal discard even non-abortable late replies. */
export class RailSafetyPositioningClient {
  private scope = "";
  private generation = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private readonly fingerprints = new Map<string, string>();
  constructor(private readonly options: RailSafetyPositioningClientOptions) {}
  setContext(context: { projectId: string; actorId: string; enabled: boolean }) {
    if (this.disposed) return;
    const scope = context.enabled ? JSON.stringify([context.projectId, context.actorId]) : "";
    if (this.scope === scope) return;
    this.stop(); this.scope = scope; this.fingerprints.clear();
    if (scope) void this.poll(context.projectId, this.generation);
    else this.options.onStatus?.({ state: "idle", message: "实时定位读取已停止" });
  }
  private stop() { ++this.generation; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.controller?.abort(); this.controller = undefined; }
  private async poll(projectId: string, generation: number) {
    if (this.disposed || generation !== this.generation) return;
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    this.options.onStatus?.({ state: "loading", message: "正在读取定位网关" });
    let httpStatus: number | undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(`/__management/positioning?projectId=${encodeURIComponent(projectId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { accept: "application/json" } });
      httpStatus = response.status;
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "当前会话无权读取实测定位，请重新登录或核对授权" : "定位网关暂时不可用，已有样本按失效时间判定");
      const snapshot = validateSnapshot(await response.json(), projectId);
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
      const updates: RailSafetyPositionSample[] = [], current = new Set<string>();
      for (const device of snapshot.devices) {
        if (!device.sample) continue;
        current.add(device.deviceId);
        const fingerprint = JSON.stringify(device.sample);
        if (this.fingerprints.get(device.deviceId) !== fingerprint) updates.push(device.sample);
        this.fingerprints.set(device.deviceId, fingerprint);
      }
      for (const deviceId of this.fingerprints.keys()) if (!current.has(deviceId)) this.fingerprints.delete(deviceId);
      this.options.onSnapshot(snapshot, updates);
      this.options.onStatus?.({ state: "connected", message: snapshot.enabled ? "已连接定位网关，按设备采集时间判定状态" : "当前可见人员尚未配置服务端定位设备" });
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.options.onStatus?.({ state: "error", message: controller.signal.aborted ? "定位网关读取超时，已有样本按失效时间判定" : error instanceof Error ? error.message : "定位状态读取失败", ...(httpStatus ? { httpStatus } : {}) });
    } finally {
      clearTimeout(timeout);
      if (!this.disposed && generation === this.generation) {
        this.controller = undefined;
        this.timer = setTimeout(() => void this.poll(projectId, generation), Math.max(250, this.options.intervalMs ?? 2000));
      }
    }
  }
  dispose() { this.disposed = true; this.stop(); this.scope = ""; this.fingerprints.clear(); }
}
