import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RailSafetyRecord, RailSafetyPositionSample } from "../../src/railSafetyTypes.ts";
import type { RailSafetyPositioningSnapshot } from "../../src/railSafetyPositioningTransport.ts";
import { RAIL_SAFETY_DEFAULT_STALE_SECONDS } from "../../src/railSafetyTypes.ts";
import { RailSafetyPositioningStore, validateRailSafetyPositionSample } from "../../src/railSafetyPositioning.ts";
import { ManagementError } from "./domain.ts";

export type PositioningDeviceConfig = { projectId: string; guardId: string; deviceId: string; tokenSha256: string; enabled: boolean };
export type PositioningGatewayConfig = { version: 1; devices: PositioningDeviceConfig[] };
const identifier = /^[a-zA-Z0-9:_-]{1,120}$/;
const fail = (status: number, code: string, message: string): never => { throw new ManagementError(status, code, message); };

export function validatePositioningGatewayConfig(input: unknown): PositioningGatewayConfig {
  const invalid = () => fail(500, "POSITIONING_CONFIG_INVALID", "定位网关配置无效，请检查服务端私有配置");
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || Object.keys(value).some(key => !["version", "devices"].includes(key)) || !Array.isArray(value.devices) || value.devices.length > 1024) invalid();
  const devices: PositioningDeviceConfig[] = [], bindings = new Set<string>(), guards = new Set<string>(), hashes = new Set<string>();
  for (const item of value.devices as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid();
    const v = item as Record<string, unknown>;
    if (Object.keys(v).some(key => !["projectId", "guardId", "deviceId", "tokenSha256", "enabled"].includes(key))) invalid();
    if (![v.projectId, v.guardId, v.deviceId].every(id => typeof id === "string" && identifier.test(id)) || typeof v.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.tokenSha256) || typeof v.enabled !== "boolean") invalid();
    const d = v as unknown as PositioningDeviceConfig, binding = JSON.stringify([d.projectId, d.deviceId]), guard = JSON.stringify([d.projectId, d.guardId]);
    if (bindings.has(binding) || guards.has(guard) || hashes.has(d.tokenSha256)) invalid();
    bindings.add(binding); guards.add(guard); hashes.add(d.tokenSha256); devices.push({ ...d });
  }
  return { version: 1, devices };
}

export function loadPositioningGatewayConfig(file = process.env.CESIUM_POSITIONING_CONFIG_FILE): PositioningGatewayConfig {
  if (!file) return { version: 1, devices: [] };
  try { return validatePositioningGatewayConfig(JSON.parse(readFileSync(file, "utf8"))); }
  catch { return fail(500, "POSITIONING_CONFIG_INVALID", "定位网关配置文件无法读取或无效，请检查服务端私有配置"); }
}

/** Latest measured fix only. No browser identity can authorize device ingestion. */
export class PositioningGateway {
  private readonly devices: PositioningDeviceConfig[];
  private readonly samples: RailSafetyPositioningStore;
  private readonly received = new Map<string, string>();
  constructor(config: PositioningGatewayConfig, private readonly now: () => number = Date.now) {
    this.devices = validatePositioningGatewayConfig(config).devices.filter(device => device.enabled);
    this.samples = new RailSafetyPositioningStore(now);
  }
  authenticate(authorization: string | undefined): PositioningDeviceConfig {
    if (!this.devices.length) return fail(503, "POSITIONING_DISABLED", "未配置已启用的定位网关设备");
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/);
    if (!match) return fail(401, "DEVICE_AUTH_REQUIRED", "定位设备凭据无效");
    const actual = createHash("sha256").update(match[1]).digest();
    const device = this.devices.find(d => timingSafeEqual(actual, Buffer.from(d.tokenSha256, "hex")));
    if (!device) return fail(401, "DEVICE_AUTH_REQUIRED", "定位设备凭据无效");
    return { ...device };
  }
  private bound(device: PositioningDeviceConfig, records: readonly RailSafetyRecord[]): boolean {
    const matches = records.filter(record => record.projectId === device.projectId && record.status === "active" && record.definition?.kind === "guard" && record.definition.workArea?.deviceId === device.deviceId);
    return matches.length === 1 && matches[0].id === device.guardId;
  }
  ingest(device: PositioningDeviceConfig, input: unknown, records: readonly RailSafetyRecord[]) {
    let sample: RailSafetyPositionSample;
    try { sample = validateRailSafetyPositionSample(input); }
    catch { return fail(400, "POSITIONING_SAMPLE_INVALID", "定位样本格式无效：须包含明确的 WGS84、时间、精度和实测来源"); }
    if (sample.projectId !== device.projectId || sample.deviceId !== device.deviceId || sample.source !== "measured") return fail(403, "DEVICE_SCOPE_MISMATCH", "定位样本不属于凭据绑定的项目设备，或不是实测来源");
    if (!this.bound(device, records)) return fail(403, "DEVICE_BINDING_INVALID", "定位设备与当前有效人员工作区的绑定不一致");
    const guard = records.find(record => record.id === device.guardId)!;
    const staleSeconds = guard.definition.kind === "guard" ? guard.definition.workArea?.staleAfterSeconds ?? RAIL_SAFETY_DEFAULT_STALE_SECONDS : RAIL_SAFETY_DEFAULT_STALE_SECONDS;
    const receivedAt = this.now();
    if (receivedAt - Date.parse(sample.timestamp) >= staleSeconds * 1000) return fail(422, "POSITIONING_STALE_SAMPLE", "拒绝已超过人员工作区失效时间的定位样本");
    try { this.samples.ingest(sample); }
    catch { return fail(409, "POSITIONING_TIME_CONFLICT", "拒绝重复、乱序或过度超前的定位时间，原样本保持不变"); }
    const time = new Date(receivedAt).toISOString();
    this.received.set(JSON.stringify([device.projectId, device.deviceId]), time);
    return { accepted: true as const, projectId: device.projectId, deviceId: device.deviceId, timestamp: sample.timestamp, receivedAt: time };
  }
  snapshot(projectId: string, visibleRecords: readonly RailSafetyRecord[], allRecords: readonly RailSafetyRecord[]): RailSafetyPositioningSnapshot {
    const devices = visibleRecords.filter(record => record.projectId === projectId && record.status === "active" && record.definition?.kind === "guard" && record.definition.workArea?.deviceId).map(record => {
      const deviceId = record.definition.kind === "guard" ? record.definition.workArea!.deviceId! : "";
      const config = this.devices.find(d => d.projectId === projectId && d.guardId === record.id && d.deviceId === deviceId);
      const configured = !!config && this.bound(config, allRecords);
      const sample = configured ? this.samples.getSample(projectId, deviceId) : undefined;
      return { guardId: record.id, deviceId, configured, ...(sample ? { sample, receivedAt: this.received.get(JSON.stringify([projectId, deviceId])) } : {}) };
    });
    return { schemaVersion: 1, projectId, serverTime: new Date(this.now()).toISOString(), enabled: devices.some(device => device.configured), devices };
  }
}
