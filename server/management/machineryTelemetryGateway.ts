import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ManagementRecord } from "../../src/managementTypes.ts";
import { validateMachineryMetadata } from "../../src/machineryValidation.ts";
import { ManagementError } from "./domain.ts";

export type MachineryTelemetryDevice = {
  projectId: string; resourceId: string; sourceId: string; tokenSha256: string; enabled: boolean;
};
export type MachineryTelemetryConfig = { version: 1; devices: MachineryTelemetryDevice[] };
export type MachineryTelemetryFrame = {
  schemaVersion: 1; projectId: string; resourceId: string; sourceId: string;
  timestamp: string; mode: "measured" | "simulated"; values: Record<string, number>;
};
export type MachineryTelemetryReceivedFrame = MachineryTelemetryFrame & { sequence: number; receivedAt: string };
const identifier = /^[a-zA-Z0-9:_-]{1,120}$/;
const fieldName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const fail = (status: number, code: string, message: string): never => { throw new ManagementError(status, code, message); };
const recordObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const MACHINERY_TELEMETRY_MAX_AGE_MS = 60_000;
export const MACHINERY_TELEMETRY_FUTURE_MS = 5_000;
const MAX_FRAMES = 2048, MAX_CLOCKS = 65_536;

export function validateMachineryTelemetryConfig(input: unknown): MachineryTelemetryConfig {
  const invalid = () => fail(500, "MACHINERY_TELEMETRY_CONFIG_INVALID", "机械传感器配置无效，请检查服务端私有配置");
  if (!recordObject(input) || input.version !== 1 || Object.keys(input).some(k => !["version", "devices"].includes(k)) || !Array.isArray(input.devices) || input.devices.length > 1024) return invalid();
  const devices: MachineryTelemetryDevice[] = [], bindings = new Set<string>(), hashes = new Set<string>();
  for (const item of input.devices) {
    if (!recordObject(item) || Object.keys(item).some(k => !["projectId", "resourceId", "sourceId", "tokenSha256", "enabled"].includes(k))) return invalid();
    if (![item.projectId, item.resourceId, item.sourceId].every(v => typeof v === "string" && identifier.test(v)) || typeof item.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.tokenSha256) || typeof item.enabled !== "boolean") return invalid();
    const d = item as unknown as MachineryTelemetryDevice, key = JSON.stringify([d.projectId, d.resourceId, d.sourceId]);
    if (bindings.has(key) || hashes.has(d.tokenSha256)) return invalid();
    bindings.add(key); hashes.add(d.tokenSha256); devices.push({ ...d });
  }
  return { version: 1, devices };
}

export function loadMachineryTelemetryConfig(file = process.env.CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE): MachineryTelemetryConfig {
  if (!file) return { version: 1, devices: [] };
  try { return validateMachineryTelemetryConfig(JSON.parse(readFileSync(file, "utf8"))); }
  catch { return fail(500, "MACHINERY_TELEMETRY_CONFIG_INVALID", "机械传感器私有配置文件无法读取或无效"); }
}

/** An optional device configuration failure must never stop the existing platform.
 * Keep the error explicit on this feature, close external ingestion, and retain authorised
 * browser simulation and all unrelated management functions. No private path is returned. */
export function createMachineryTelemetryGateway(config?: MachineryTelemetryConfig, now: () => number = Date.now): MachineryTelemetryGateway {
  try { return new MachineryTelemetryGateway(config ?? loadMachineryTelemetryConfig(), now); }
  catch (error) {
    if (!(error instanceof ManagementError) || error.code !== "MACHINERY_TELEMETRY_CONFIG_INVALID") throw error;
    return new MachineryTelemetryGateway({ version: 1, devices: [] }, now, true);
  }
}

/** Raw channels remain numeric. Mapping, unit conversion, calibrated angles and model limits
 * are applied atomically by the consumer after the user selects their bindings. */
export function validateMachineryTelemetryFrame(input: unknown): MachineryTelemetryFrame {
  const invalid = () => fail(400, "MACHINERY_TELEMETRY_INVALID", "机械回传须包含版本、项目、机械、来源、UTC时间及1至64个有限数值字段");
  if (!recordObject(input) || input.schemaVersion !== 1 || Object.keys(input).some(k => !["schemaVersion", "projectId", "resourceId", "sourceId", "timestamp", "mode", "values"].includes(k))) return invalid();
  if (![input.projectId, input.resourceId, input.sourceId].every(v => typeof v === "string" && identifier.test(v))) return invalid();
  if (typeof input.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.timestamp) || !Number.isFinite(Date.parse(input.timestamp))) return invalid();
  // Date.parse normalises invalid dates such as February 30. Require a real UTC instant.
  if (new Date(input.timestamp).toISOString().slice(0, 19) !== input.timestamp.slice(0, 19)) return invalid();
  if (input.mode !== undefined && input.mode !== "measured" && input.mode !== "simulated") return invalid();
  if (!recordObject(input.values)) return invalid();
  const entries = Object.entries(input.values);
  if (!entries.length || entries.length > 64 || entries.some(([k, v]) => !fieldName.test(k) || ["__proto__", "constructor", "prototype"].includes(k) || typeof v !== "number" || !Number.isFinite(v))) return invalid();
  return { schemaVersion: 1, projectId: input.projectId as string, resourceId: input.resourceId as string, sourceId: input.sourceId as string,
    timestamp: new Date(input.timestamp).toISOString(), mode: input.mode ?? "measured", values: Object.fromEntries(entries) as Record<string, number> };
}

/** Process-local bounded transport. Telemetry never changes a business record or revision. */
export class MachineryTelemetryGateway {
  readonly streamId = randomUUID();
  private readonly devices: MachineryTelemetryDevice[];
  private sequence = 0;
  private frames: MachineryTelemetryReceivedFrame[] = [];
  private clocks = new Map<string, number>();
  constructor(config: MachineryTelemetryConfig, private readonly now: () => number = Date.now, private readonly configurationInvalid = false) {
    this.devices = validateMachineryTelemetryConfig(config).devices.filter(d => d.enabled);
  }
  authenticate(authorization: string | undefined): MachineryTelemetryDevice {
    if (this.configurationInvalid) return fail(503, "MACHINERY_TELEMETRY_CONFIG_INVALID", "机械传感器私有配置无法读取或无效，外部接入已停用；机械手工编辑与页面模拟仍可使用");
    if (!this.devices.length) return fail(503, "MACHINERY_TELEMETRY_DISABLED", "尚未配置外部机械传感器凭据；页面模拟仍可使用");
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/);
    if (!match) return fail(401, "DEVICE_AUTH_REQUIRED", "机械传感器凭据无效");
    const digest = createHash("sha256").update(match[1]).digest();
    const device = this.devices.find(d => timingSafeEqual(digest, Buffer.from(d.tokenSha256, "hex")));
    if (!device) return fail(401, "DEVICE_AUTH_REQUIRED", "机械传感器凭据无效");
    return { ...device };
  }
  private prune() {
    const cutoff = this.now() - MACHINERY_TELEMETRY_MAX_AGE_MS;
    this.frames = this.frames.filter(f => Date.parse(f.timestamp) >= cutoff).slice(-MAX_FRAMES);
    for (const [key, time] of this.clocks) if (time < cutoff) this.clocks.delete(key);
  }
  ingest(input: unknown, record: ManagementRecord, device?: MachineryTelemetryDevice): MachineryTelemetryReceivedFrame {
    const frame = validateMachineryTelemetryFrame(input);
    if (device && (frame.projectId !== device.projectId || frame.resourceId !== device.resourceId || frame.sourceId !== device.sourceId)) return fail(403, "DEVICE_SCOPE_MISMATCH", "回传不属于凭据绑定的项目、机械和来源");
    if (!device && frame.mode !== "simulated") return fail(403, "SIMULATION_REQUIRED", "浏览器会话只允许明确标记的模拟回传");
    if (record.id !== frame.resourceId || record.projectId !== frame.projectId || record.kind !== "equipment" || record.status === "deleted" || !record.machinery) return fail(422, "MACHINERY_TELEMETRY_RESOURCE_INVALID", "机械资源不存在、已删除或尚未保存三维机械初始信息");
    try { validateMachineryMetadata(record.machinery); }
    catch { return fail(422, "MACHINERY_TELEMETRY_RESOURCE_INVALID", "已保存机械初始信息无效，请先重新保存机械参数"); }
    const timestamp = Date.parse(frame.timestamp), now = this.now();
    if (timestamp < now - MACHINERY_TELEMETRY_MAX_AGE_MS) return fail(422, "MACHINERY_TELEMETRY_STALE", "拒绝超过60秒的回传，保留上一有效姿态");
    if (timestamp > now + MACHINERY_TELEMETRY_FUTURE_MS) return fail(422, "MACHINERY_TELEMETRY_FUTURE", "回传时间超前超过5秒，请校准设备时钟");
    this.prune();
    const keys = Object.keys(frame.values).map(field => JSON.stringify([frame.projectId, frame.resourceId, frame.sourceId, frame.mode, field]));
    if (keys.some(key => (this.clocks.get(key) ?? -Infinity) >= timestamp)) return fail(409, "MACHINERY_TELEMETRY_TIME_CONFLICT", "该字段回传重复或乱序；整帧未接受");
    if (this.clocks.size + keys.filter(key => !this.clocks.has(key)).length > MAX_CLOCKS) return fail(429, "MACHINERY_TELEMETRY_CAPACITY", "活跃传感器字段达到上限，请减少来源或稍后重试");
    const received: MachineryTelemetryReceivedFrame = { ...frame, sequence: ++this.sequence, receivedAt: new Date(now).toISOString() };
    for (const key of keys) this.clocks.set(key, timestamp);
    this.frames.push(received); if (this.frames.length > MAX_FRAMES) this.frames.shift();
    return structuredClone(received);
  }
  snapshot(projectId: string, visibleResources: readonly ManagementRecord[], after = 0, streamId?: string) {
    if (!Number.isSafeInteger(after) || after < 0) return fail(400, "MACHINERY_TELEMETRY_CURSOR", "after须为非负整数游标");
    this.prune();
    const ids = new Set(visibleResources.filter(r => r.projectId === projectId && r.kind === "equipment" && r.status !== "deleted" && r.machinery).map(r => r.id));
    const oldest = this.frames[0]?.sequence ?? this.sequence + 1;
    const reset = (!!streamId && streamId !== this.streamId) || after > this.sequence || (after > 0 && after < oldest - 1);
    const frames = this.frames.filter(f => f.projectId === projectId && ids.has(f.resourceId) && (reset || f.sequence > after));
    return { schemaVersion: 1 as const, projectId, serverTime: new Date(this.now()).toISOString(), streamId: this.streamId,
      externalEnabled: this.devices.some(d => d.projectId === projectId && ids.has(d.resourceId)),
      ...(this.configurationInvalid ? { externalConfigurationError: { code: "MACHINERY_TELEMETRY_CONFIG_INVALID", message: "机械传感器私有配置无法读取或无效，外部接入已停用；页面模拟仍可使用" } } : {}),
      cursor: this.sequence, reset, frames: structuredClone(frames) };
  }
}
