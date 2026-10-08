import { Cartesian3 } from "cesium";
import type { LibraryRecord } from "./projectLibrary.ts";
import type { VideoRoamTrack } from "./presentationV5/video-roam.js";

/** This is a source/clock contract, not optical or survey-grade registration. */
export type SafetyVideoRoamAudit = {
  recordId: string; videoId: string; source: string; sampleCount: number;
  recordingMatched: boolean; timelineMatched: boolean; heightReference?: string;
  mediaOffsetSeconds: number; telemetryEpochAtMediaZeroMs?: number;
  sourceMediaRange?: [number, number]; maxTimeOriginResidualMs?: number;
  altitudeMode?: string; cameraAttitude: "unverified"; opticalRegistration: false;
  missing: string[]; notes: string[];
};
export type SafetyVideoRoamData = {
  available: boolean; track?: VideoRoamTrack; audit: SafetyVideoRoamAudit;
  maxGapSeconds: number; maxSegmentMeters: number; label: string;
};
export type DecodedRecordingMetadata = { name: string; sizeBytes: number; width: number; height: number; durationSeconds: number };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const inputNumber = (value: unknown): number | undefined => typeof value === "number" ? number(value)
  : typeof value === "string" && value.trim() ? number(Number(value)) : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const leaf = (value: string) => value.replaceAll("\\", "/").split("/").at(-1);

/** A saved AR estimate is NOT a verified vertical reference. Optional explicit
 * provenance can be supplied by an actual surveyed/asset-adaptation service. */
function resolveHeight(record: LibraryRecord, root: Record<string, unknown>, flight: Record<string, unknown>) {
  const video = object(record.settings.video), explicit = object(video?.roamVerticalReference);
  const reference = text(flight.altitude_reference)?.toLowerCase();
  const crs = text(flight.source_crs ?? root.source_crs)?.toUpperCase().replaceAll(" ", "");
  if (["ellipsoid", "ellipsoidal", "wgs84-ellipsoidal"].includes(reference || "") || (crs === "EPSG:4979" && !reference)) {
    return { description: "源数据明确声明 WGS84 椭球高（m）", convert: (position: Record<string, unknown>) => number(position.altitude) };
  }
  if (explicit?.status !== "verified" || explicit.recordId !== record.id || explicit.targetReference !== "EPSG:4979"
    || !text(explicit.evidence) || !text(explicit.sourceReference)) return;
  if (explicit.method === "source-offset" && number(explicit.sourceToEllipsoidOffsetMeters) !== undefined) {
    const offset = number(explicit.sourceToEllipsoidOffsetMeters)!;
    return { description: `已核验 ${explicit.sourceReference} → WGS84 椭球高；依据 ${explicit.evidence}`,
      convert: (position: Record<string, unknown>) => number(position.altitude) === undefined ? undefined : number(position.altitude)! + offset };
  }
  if (explicit.method === "takeoff-relative" && number(explicit.takeoffEllipsoidHeightMeters) !== undefined) {
    const takeoff = number(explicit.takeoffEllipsoidHeightMeters)!;
    return { description: `已核验起飞点椭球高 + 相对高度；依据 ${explicit.evidence}`,
      convert: (position: Record<string, unknown>) => number(position.relative_altitude) === undefined ? undefined : number(position.relative_altitude)! + takeoff };
  }
}

/** Read-only normalization for the existing DJI SRT recording format. Strictly
 * reject ambiguous association/datum; never infer a clock from a filename. */
export function adaptSafetyVideoRoam(record: LibraryRecord, raw: unknown, decoded: DecodedRecordingMetadata,
  videoId = `video:${record.id}`): SafetyVideoRoamData {
  const root = object(raw) || {}, flight = object(root.flight_info) || {}, declaredVideo = object(flight.video) || {};
  const controls = object(object(record.settings.video)?.controls) || {};
  const offset = controls.videoArTimeOffset === undefined ? 0 : inputNumber(controls.videoArTimeOffset);
  const audit: SafetyVideoRoamAudit = { recordId: record.id, videoId, source: record.files.source?.url || "",
    sampleCount: 0, recordingMatched: false, timelineMatched: false, mediaOffsetSeconds: offset ?? 0,
    altitudeMode: text(controls.videoArHeightMode), cameraAttitude: "unverified", opticalRegistration: false, missing: [], notes: [] };
  const result: SafetyVideoRoamData = { available: false, audit, maxGapSeconds: .25, maxSegmentMeters: 250, label: "未关联同录像航迹" };
  const rows = Array.isArray(root.trajectory_points) ? root.trajectory_points : [];
  const declaredDuration = number(declaredVideo.duration_ms), frameRate = number(declaredVideo.frame_rate_fps);
  const fileName = text(flight.video_file);
  audit.sampleCount = rows.length;
  audit.recordingMatched = record.kind === "Drone Video" && videoId === `video:${record.id}`
    && !!record.files.video && record.files.video.name === decoded.name && !!fileName && leaf(fileName) === decoded.name
    && number(declaredVideo.size_bytes) === decoded.sizeBytes && decoded.sizeBytes > 0
    && number(declaredVideo.width) === decoded.width && decoded.width >= 16
    && number(declaredVideo.height) === decoded.height && decoded.height >= 16
    && declaredDuration !== undefined && declaredDuration > 0 && Number.isFinite(decoded.durationSeconds)
    && Math.abs(declaredDuration / 1000 - decoded.durationSeconds) <= .1;
  if (!audit.recordingMatched) audit.missing.push("录像与轨迹的资料编号、文件大小、实际解码尺寸或时长未通过一致性核验");
  const declaredCrs = text(flight.source_crs ?? root.source_crs)?.toUpperCase().replaceAll(" ", "");
  if (!["WGS84", "WGS-84", "EPSG:4326", "EPSG:4979"].includes(declaredCrs || "")) audit.missing.push("源经纬度尚未明确转换到 WGS84");
  const height = resolveHeight(record, root, flight);
  if (!height) audit.missing.push("高程基准未知：缺少有来源的椭球高或已核验的起飞点/源高程转换；估算地面不能用于漫游");
  else audit.heightReference = height.description;
  const knownTimeline = root.schema_version === "cesium-dji-trajectory/v1" && /SRT PTS/i.test(text(flight.timeline) || "")
    && /^DJI 航拍视频信息提取器 /u.test(text(flight.generator) || "");
  if (!knownTimeline || offset === undefined || Math.abs(offset) > 120) audit.missing.push("缺少可靠的 SRT 媒体时序或明确的视频偏移");
  if (rows.length < 2 || rows.length > 1_000_000) { audit.missing.push("至少需要两个有效连续样本，当前遥测样本数不适用"); return result; }
  let previousMedia = -Infinity, previousUtc = -Infinity, origin: number | undefined, maximumResidual = 0, invalid = false;
  const samples: VideoRoamTrack["samples"] = [];
  for (const row of rows) {
    const item = object(row) || {}, position = object(item.position) || {};
    const mediaMs = number(item.video_time_ms), utc = number(item.source_timestamp_ms);
    const longitude = number(position.longitude), latitude = number(position.latitude), altitude = number(position.altitude);
    if (mediaMs === undefined || mediaMs < 0 || utc === undefined || utc < 946684800000 || mediaMs <= previousMedia || utc <= previousUtc
      || longitude === undefined || Math.abs(longitude) > 180 || latitude === undefined || Math.abs(latitude) > 90 || altitude === undefined) { invalid = true; break; }
    origin ??= utc - mediaMs;
    maximumResidual = Math.max(maximumResidual, Math.abs(utc - mediaMs - origin));
    previousMedia = mediaMs; previousUtc = utc;
    const ellipsoidHeight = height?.convert(position);
    if (height && (ellipsoidHeight === undefined || !Number.isFinite(ellipsoidHeight) || ellipsoidHeight < -1000 || ellipsoidHeight > 100000)) { invalid = true; break; }
    const timeSeconds = mediaMs / 1000 - (offset ?? 0);
    if (ellipsoidHeight !== undefined && timeSeconds >= 0) samples.push({ timeSeconds,
      position: Cartesian3.fromDegrees(longitude, latitude, ellipsoidHeight) });
  }
  audit.maxTimeOriginResidualMs = maximumResidual;
  if (!invalid && origin !== undefined) {
    audit.telemetryEpochAtMediaZeroMs = origin + (offset ?? 0) * 1000;
    audit.sourceMediaRange = [number(object(rows[0])?.video_time_ms)! / 1000, previousMedia / 1000];
  }
  const coverageTolerance = frameRate && frameRate > 0 ? Math.max(.25, 2 / frameRate) : .25;
  const start = audit.sourceMediaRange?.[0], end = audit.sourceMediaRange?.[1];
  audit.timelineMatched = knownTimeline && !invalid && maximumResidual <= 2 && offset !== undefined && Math.abs(offset) <= 120
    && start !== undefined && end !== undefined && declaredDuration !== undefined && start <= coverageTolerance
    && Math.abs(declaredDuration / 1000 - end) <= coverageTolerance;
  if (!audit.timelineMatched) audit.missing.push("遥测时间必须严格递增、与媒体 PTS 一致并覆盖录像；当前时间关联未通过核验");
  audit.notes.push("时间取逐样本 video_time_ms；source_timestamp_ms 仅用于媒体秒到遥测 UTC 的显式映射，不解析文件名或本地时区。",
    "DJI 媒体间隙阈值沿用现有 250ms 策略，空间跳变上限250m仅为拒绝插值策略，不表示安全距离。",
    "云台角未具备完整轴/安装关系及光学标定证据；当前适配器只允许保持开启时视向的航迹跟随。",
    "同录像核验依据资料库绑定、文件大小、实际解码元数据和导出时序，未声称已进行原片内容哈希认证。");
  if (height && !invalid && samples.length < 2) audit.missing.push("视频偏移后没有两个落在本录像媒体时间轴内的有效位置样本");
  if (audit.missing.length || samples.length < 2) return result;
  result.available = true; result.label = "航迹跟随 · 无相机姿态";
  result.track = { id: `video-roam:${record.id}:${record.updatedAt}`, videoId, timeBasis: "media-seconds", source: audit.source, samples };
  return result;
}

/** Library files only: no external URL or traversal from persisted metadata. */
export function roamLibraryFile(recordId: string, value: unknown, slot: "source" | "video"): string | undefined {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]+$/.test(recordId)) return;
  try {
    const url = new URL(value, "http://library.local");
    if (url.origin !== "http://library.local" || url.search || url.hash || !url.pathname.startsWith(`/__library/files/${recordId}/${slot}/`)) return;
    if (decodeURIComponent(url.pathname).split("/").some(part => part === "." || part === "..") || /[\\\r\n]/.test(decodeURIComponent(url.pathname))) return;
    return url.pathname;
  } catch { return; }
}

export async function loadSafetyVideoRoamSource(recordId: string, signal?: AbortSignal,
  request: typeof fetch = fetch): Promise<{ record: LibraryRecord; raw: unknown; sizeBytes: number }> {
  if (!/^[a-zA-Z0-9-]+$/.test(recordId)) throw new Error("录像资料编号无效");
  const recordResponse = await request(`/__library/records/${encodeURIComponent(recordId)}`, { signal, cache: "no-store" });
  if (!recordResponse.ok) throw new Error("读取录像资料失败");
  const record = await recordResponse.json() as LibraryRecord;
  if (record.id !== recordId || record.kind !== "Drone Video" || !record.files || !record.settings) throw new Error("录像资料来源不匹配");
  const source = roamLibraryFile(recordId, record.files.source?.url, "source"), video = roamLibraryFile(recordId, record.files.video?.url, "video");
  if (!source || !video) throw new Error("缺少本录像对应的原片或遥测文件");
  const [rawResponse, head] = await Promise.all([request(source, { signal, cache: "no-store" }), request(video, { signal, method: "HEAD", cache: "no-store" })]);
  if (!rawResponse.ok || !head.ok) throw new Error("读取原片或遥测数据失败");
  const length = head.headers.get("content-length"), sizeBytes = length ? Number(length) : NaN;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("原片大小无法核验，不能确认同录像关联");
  return { record, raw: await rawResponse.json(), sizeBytes };
}
