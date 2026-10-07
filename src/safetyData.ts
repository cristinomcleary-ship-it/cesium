import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from "cesium";
import proj4 from "proj4";
import { createGaussKrugerToWgs84Converter } from "./coordinateUtils.ts";
import type { CadImportPackage, CadPoint } from "./cadImport.ts";
import type { CadCoordinateOptions } from "./types.ts";
import type { LibraryListing, LibraryRecord } from "./projectLibrary.ts";
import type {
  SafetyAlert, SafetyDataAdapter, SafetyDataset, SafetyDevice, SafetyMedia,
  SafetyNode, SafetyPosition, SafetyTask, SafetyTrackPoint,
} from "./safetyTypes.ts";

const PROJECT_ID = "safety:project";
const DAY = 86_400_000;
const MISSING = [
  "营业线实测中心线、限界与正式施工区段红线尚未接入；页面包络只用于展示。",
  "正式构件唯一编号、模型 feature ID 与 CAD 编号的映射尚未接入；盖梁、墩柱、承台为逻辑节点。",
  "真实设备状态、告警、巡检任务、整改验收接口尚未接入；现有事件和任务明确标为演示。",
  "CAD 与无人机高程基准及坐标转换精度控制点尚未核验；模型清晰度与视频配准另行验证。",
  "点位现场照片、构件专属视频与图纸索引尚未接入；无人机视频仅关联项目，取景范围未经核验。",
];

export function validSafetyPosition(position: SafetyPosition): boolean {
  return Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180
    && Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90
    && Number.isFinite(position.height);
}

/** This adapter only reads local library files; arbitrary URLs from records never become fetch targets. */
export function safeLibraryUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/__library/files/") || /[\\\r\n]/.test(value)) return;
  try {
    const url = new URL(value, "http://library.local");
    if (url.origin !== "http://library.local" || !url.pathname.startsWith("/__library/files/") || url.hash || url.search) return;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.split("/").some((part) => part === ".." || part === ".") || /[\\\r\n]/.test(decoded)) return;
    return url.pathname;
  } catch { return; }
}

export function createSafetyCadConverter(options: CadCoordinateOptions): (point: CadPoint) => SafetyPosition | undefined {
  let convert: (point: CadPoint) => SafetyPosition;
  if (options.mode === "gaussKruger") {
    const toWgs84 = createGaussKrugerToWgs84Converter(options);
    convert = ({ x, y, z = 0 }) => {
      const [longitude, latitude] = toWgs84(x, y);
      return { longitude, latitude, height: z + options.heightOffset };
    };
  } else if (options.mode === "crs") {
    const source = options.sourceCrs.trim() || "EPSG:4326";
    const transform = ["EPSG:4326", "WGS84"].includes(source.toUpperCase()) ? undefined : proj4(source, "EPSG:4326");
    convert = ({ x, y, z = 0 }) => {
      const [longitude, latitude] = transform ? transform.forward([x, y]) : [x, y];
      return { longitude, latitude, height: z + options.heightOffset };
    };
  } else {
    const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(options.longitude, options.latitude, options.altitude));
    const angle = options.rotation * Math.PI / 180;
    convert = ({ x, y, z = 0 }) => {
      const dx = x - options.referenceX; const dy = y - options.referenceY;
      const local = new Cartesian3((dx * Math.cos(angle) - dy * Math.sin(angle)) * options.scale,
        (dx * Math.sin(angle) + dy * Math.cos(angle)) * options.scale, z * options.scale);
      const point = Cartographic.fromCartesian(Matrix4.multiplyByPoint(frame, local, new Cartesian3()));
      return { longitude: CesiumMath.toDegrees(point.longitude), latitude: CesiumMath.toDegrees(point.latitude), height: point.height };
    };
  }
  return (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z ?? 0)) return;
    try { const result = convert(point); return validSafetyPosition(result) ? result : undefined; } catch { return; }
  };
}

function cleanText(value: string): string {
  return value.replace(/\\P/gi, " ").replace(/\\[A-Za-z][^;]*;/g, "").replace(/[{}]/g, "").trim();
}

function center(positions: SafetyPosition[]): SafetyPosition {
  return positions.reduce((result, point) => ({ longitude: result.longitude + point.longitude / positions.length,
    latitude: result.latitude + point.latitude / positions.length, height: result.height + point.height / positions.length }),
  { longitude: 0, latitude: 0, height: 0 });
}

/** A padded CAD point envelope, never an approved construction boundary or model geometry. */
export function safetyEnvelope(positions: SafetyPosition[], paddingMetres = 22): SafetyPosition[] {
  if (!positions.length) return [];
  const origin = center(positions);
  const dy = paddingMetres / 111_320;
  const dx = dy / Math.max(0.01, Math.cos(origin.latitude * Math.PI / 180));
  let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
  for (const point of positions) {
    west = Math.min(west, point.longitude); east = Math.max(east, point.longitude);
    south = Math.min(south, point.latitude); north = Math.max(north, point.latitude);
  }
  return [[west - dx, south - dy], [east + dx, south - dy], [east + dx, north + dy], [west - dx, north + dy]]
    .map(([longitude, latitude]) => ({ longitude, latitude, height: origin.height }));
}

function radius(positions: SafetyPosition[], minimum = 40): number {
  if (!positions.length) return minimum;
  const origin = center(positions); const cos = Math.cos(origin.latitude * Math.PI / 180);
  return Math.max(minimum, ...positions.map((point) => Math.hypot((point.longitude - origin.longitude) * 111_320 * cos,
    (point.latitude - origin.latitude) * 111_320)));
}

export type SafetyCadSource = { record: LibraryRecord; cad: CadImportPackage };
export type SafetyCadAdaptation = { nodes: SafetyNode[]; media: SafetyMedia[]; notes: string[]; coordinateNotes: string[] };

function cadFingerprint(source: SafetyCadSource): string {
  // Contents (rather than filename alone) distinguish revised drawings while deduplicating repeated imports.
  const text = JSON.stringify([source.record.settings.coordinates, source.cad.entities]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${source.cad.source?.name || source.record.name}:${text.length}:${hash >>> 0}`;
}

function describeCoordinates(options: CadCoordinateOptions): string {
  if (options.mode === "gaussKruger") return `CAD 高斯投影，${options.ellipsoid}，中央子午线 ${options.centralMeridian}°，${options.axisOrder}，单位 m，转换 WGS84；源 Z + ${options.heightOffset} m，高程基准未核验。`;
  if (options.mode === "crs") return `CAD 源坐标 ${options.sourceCrs || "EPSG:4326"}，转换 WGS84，源 Z + ${options.heightOffset} m，高程基准未核验。`;
  return `CAD 本地坐标经原有 ENU 转换：锚点 ${options.longitude}, ${options.latitude}，缩放 ${options.scale}，旋转 ${options.rotation}°；场景单位 m，源单位与高程基准待核验。`;
}

export function adaptSafetyCadSources(sources: SafetyCadSource[]): SafetyCadAdaptation {
  const nodes: SafetyNode[] = []; const media: SafetyMedia[] = []; const notes: string[] = []; const coordinateNotes: string[] = [];
  const seen = new Set<string>();
  for (const source of [...sources].sort((a, b) => (b.record.updatedAt || "").localeCompare(a.record.updatedAt || ""))) {
    const { record, cad } = source;
    if (!record.visible || !record.settings.coordinates || !Array.isArray(cad.entities)) continue;
    const fingerprint = cadFingerprint(source);
    if (seen.has(fingerprint)) { notes.push(`已合并重复 CAD 记录 ${record.id}（${record.name}）；原资料库内容保持不变。`); continue; }
    seen.add(fingerprint);
    let convert: ReturnType<typeof createSafetyCadConverter>;
    try { convert = createSafetyCadConverter(record.settings.coordinates); } catch { notes.push(`${record.name} 坐标定义不可用，未生成工程点位。`); continue; }
    const groups = new Map<number, Array<{ index: number; text: string; position: SafetyPosition }>>();
    cad.entities.forEach((entity, index) => {
      if (!entity || entity.type !== "TEXT" || typeof entity.text !== "string") return;
      const text = cleanText(entity.text); const match = /^(\d{1,3})\s*[-－—]\s*(\d{1,3})(?:#|号)?$/.exec(text);
      if (!match) return;
      const position = convert(entity.vertices?.[0]);
      if (!position) return;
      const key = Number(match[1]); const group = groups.get(key) || [];
      group.push({ index, text, position }); groups.set(key, group);
    });
    if (!groups.size) { notes.push(`${record.name} 未找到可识别的“墩号-点号”文字锚点，未臆造工程构件。`); continue; }
    coordinateNotes.push(describeCoordinates(record.settings.coordinates));
    const mediaId = `drawing:${record.id}`;
    const url = safeLibraryUrl(record.files.source?.url) || safeLibraryUrl(record.files.data?.url);
    if (url) media.push({ id: mediaId, name: record.name, kind: "drawing", url, provenance: "real", relation: "project",
      note: "真实项目 CAD 原图；文字锚点可追溯原实体索引，尚无经复核的构件专属图纸索引。", sourceRecordId: record.id });
    const mediaIds = url ? [mediaId] : [];
    const sectionGroups = new Map<number, SafetyNode[]>();
    for (const [number, entries] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const group = Math.floor((number - 1) / 5); const sectionId = `section:${record.id}:${group}`;
      const pierId = `pier:${record.id}:${number}`; const positions = entries.map((entry) => entry.position);
      const pier: SafetyNode = { id: pierId, parentId: sectionId, kind: "pier", name: `${number} 号墩`, position: center(positions),
        provenance: "derived", description: `由 CAD 文字 ${entries.map((entry) => entry.text).join("、")} 推定分组；中心取文字插入点均值，未核验墩位及实体模型绑定。`,
        radius: radius(positions, 24), boundary: safetyEnvelope(positions, 8), mediaIds, sourceRecordId: record.id };
      nodes.push(pier); const section = sectionGroups.get(group) || []; section.push(pier); sectionGroups.set(group, section);
      for (const entry of entries) nodes.push({ id: `cad:${record.id}:${entry.index}`, parentId: pierId, kind: "component",
        name: `${entry.text} 桩位标注`, componentType: "pile", position: entry.position, provenance: "real",
        description: `真实 CAD 文字“${entry.text}”插入点，实体索引 ${entry.index}。桩基分类由编号推定，不能当作已复核的桩心或工程高程；尚未绑定模型构件。`,
        mediaIds, sourceRecordId: record.id, sourceEntityIndex: entry.index, radius: 15 });
      for (const [componentType, name] of [["cap", "盖梁"], ["column", "墩柱"], ["footing", "承台"]] as const) nodes.push({
        id: `${pierId}:${componentType}`, parentId: pierId, kind: "component", componentType, name: `${number} 号墩 · ${name}`, navigationDisabledReason: "尚未接入具有构件编号的 BIM 模型",
        position: { ...pier.position }, provenance: "derived", description: `${name}逻辑导航节点，暂用父级文字包络中心。模型唯一编号及构件定位尚未接入，不代表已定位的工程实体。`,
        mediaIds, sourceRecordId: record.id, radius: 25 });
    }
    for (const [group, piers] of sectionGroups) {
      const positions = piers.flatMap((pier) => pier.boundary || [pier.position]);
      nodes.push({ id: `section:${record.id}:${group}`, parentId: PROJECT_ID, kind: "section", name: `${group * 5 + 1}–${group * 5 + 5} 号墩区段`,
        position: center(positions), radius: radius(positions, 90), boundary: safetyEnvelope(positions), provenance: "derived", mediaIds,
        sourceRecordId: record.id, description: "按 CAD 编号每五座墩推定的展示分组；发光边界为 CAD 标注包络，不是正式施工红线、营业线限界或征地边界。" });
    }
    notes.push(`${record.name}：${groups.size} 个推定墩组，${[...groups.values()].reduce((sum, points) => sum + points.length, 0)} 个真实文字锚点；原 CAD 几何、标高、图层未修改。`);
  }
  return { nodes, media, notes, coordinateNotes: [...new Set(coordinateNotes)] };
}

type UnknownRecord = Record<string, unknown>;
function object(value: unknown): UnknownRecord | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function epoch(value: unknown): number | undefined {
  const numeric = number(value); return numeric !== undefined && numeric >= 946684800000 && numeric <= 7258118400000 ? numeric : undefined;
}
function recordedEpoch(value: unknown, timezone?: unknown): number | undefined {
  // A timestamp without an offset is not assigned the browser's timezone.
  if (typeof value !== "string") return;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return epoch(Date.parse(value));
  if (typeof timezone === "string" && /^[+-]\d{2}:\d{2}$/.test(timezone)) return epoch(Date.parse(value + timezone));
  return;
}

export function adaptSafetyTrajectory(raw: unknown): { track: SafetyTrackPoint[]; notes: string[]; coordinateNote: string } {
  const source = object(raw); const rows = Array.isArray(source?.trajectory_points) ? source.trajectory_points : [];
  const track: SafetyTrackPoint[] = []; let rejected = 0; let inferredTime = 0; let segment = 0;
  const timezone = object(source?.flight_info)?.timezone;
  const firstAnchor = rows.map((row) => object(row)).find((row) => row && epoch(row.source_timestamp_ms) !== undefined && number(row.video_time_ms) !== undefined);
  const base = firstAnchor ? (epoch(firstAnchor.source_timestamp_ms)! - number(firstAnchor.video_time_ms)!) : undefined;
  for (const row of rows) {
    const item = object(row); const position = object(item?.position); const mediaMs = number(item?.video_time_ms);
    const longitude = number(position?.longitude); const latitude = number(position?.latitude); const height = number(position?.altitude);
    let time = epoch(item?.source_timestamp_ms) ?? recordedEpoch(item?.recorded_at, timezone);
    if (time === undefined && base !== undefined && mediaMs !== undefined) { time = base + mediaMs; inferredTime++; }
    if (longitude === undefined || latitude === undefined || height === undefined || mediaMs === undefined || mediaMs < 0 || time === undefined
      || !validSafetyPosition({ longitude, latitude, height })) { rejected++; segment++; continue; }
    const previous = track[track.length - 1];
    if (previous && (time - previous.time > 5000 || time < previous.time)) segment++;
    track.push({ longitude, latitude, height, time, mediaSeconds: mediaMs / 1000, segment });
  }
  // Preserve every valid measured coordinate; chronological sorting does not smooth, decimate or invent flight positions.
  track.sort((a, b) => a.time - b.time || a.mediaSeconds - b.mediaSeconds);
  return { track, notes: [`实际航迹保留 ${track.length} 个有效原始坐标，未平滑或抽稀；忽略 ${rejected} 个缺失坐标/时标的样本。`,
    ...(inferredTime ? [`${inferredTime} 个缺失绝对时标的样本采用已有 source_timestamp_ms 与 video_time_ms 锚点推导时间。`] : [])],
  coordinateNote: `无人机源坐标 ${typeof source?.source_crs === "string" ? source.source_crs : "未声明（按经纬度读取，待核验）"}；经纬度为 °，高度取 position.altitude（m），未用 relative_altitude 替代；高程基准未知。时间优先 source_timestamp_ms（UTC epoch ms），视频时间独立使用 video_time_ms。` };
}

function demoEvents(nodes: SafetyNode[], extent: [number, number]): { alerts: SafetyAlert[]; tasks: SafetyTask[] } {
  const piers = nodes.filter((node) => node.kind === "pier");
  // Keep the demonstration small and anchored to real CAD nodes when available.
  const chosen = [...piers].sort((a, b) => (a.name.startsWith("13 ") ? -1 : b.name.startsWith("13 ") ? 1 : 0)).slice(0, 6)
    .map((pier) => nodes.find((node) => node.parentId === pier.id && node.componentType === "pile") || pier);
  const titles = ["邻线作业距离复核", "防护隔离复查", "吊装作业巡视", "作业面环境检查", "临时设施复查", "设备状态复核"];
  return {
    alerts: chosen.map((node, index) => ({ id: `demo-alert:${node.id}`, nodeId: node.id, title: titles[index],
      severity: index % 3 === 0 ? "high" : index % 3 === 1 ? "medium" : "low", timestamp: extent[0] + (extent[1] - extent[0]) * (index + 1) / (chosen.length + 1),
      status: index % 3 === 2 ? "closed" : index % 3 === 1 ? "rectifying" : "open", provenance: "demo", mediaIds: [...node.mediaIds],
      description: "演示事件，仅用于验证定位、筛选与资料联动；不代表现场存在该隐患，不用于实际施工安全决策。",
      rectifications: index % 3 === 2 ? [{ timestamp: extent[0] + (extent[1] - extent[0]) * .95, text: "演示整改流程：复核记录已归档（无正式验收效力）。" }] : [],
    })),
    tasks: chosen.map((node, index) => ({ id: `demo-task:${node.id}`, nodeId: node.id, name: `${node.name} · 日常巡检（演示）`,
      timestamp: extent[0] + (extent[1] - extent[0]) * (index + 1) / (chosen.length + 1), provenance: "demo",
      status: index % 3 === 0 ? "active" : index % 3 === 1 ? "pending" : "complete" })),
  };
}

export function createSafetyDemoDataset(now = Date.now(), reason = "资料库中暂无可用 CAD 编号点位。"): SafetyDataset {
  const project: SafetyNode = { id: PROJECT_ID, kind: "project", name: "施工安全巡检 · 演示", position: { longitude: 120.89, latitude: 30.836, height: 0 },
    provenance: "demo", description: "完全虚构的交互样例；非真实项目资料。", mediaIds: [], radius: 650 };
  const nodes = [project];
  for (let group = 0; group < 2; group++) {
    const section: SafetyNode = { id: `demo-section:${group}`, parentId: project.id, kind: "section", name: `演示区段 ${group + 1}`,
      position: { longitude: 120.89 + group * .003, latitude: 30.836 + group * .002, height: 0 }, provenance: "demo",
      description: "演示区域，坐标与边界均为合成，不代表工程范围。", mediaIds: [], radius: 220 };
    const piers: SafetyNode[] = [];
    for (let index = 0; index < 3; index++) {
      const pier: SafetyNode = { id: `${section.id}:pier:${index}`, parentId: section.id, kind: "pier", name: `演示 ${group * 3 + index + 1} 号墩`,
        position: { longitude: section.position.longitude + index * .0007, latitude: section.position.latitude + index * .0005, height: 0 },
        provenance: "demo", description: "合成演示墩位，无工程实体。", mediaIds: [], radius: 30 };
      nodes.push(pier); piers.push(pier);
      for (const [componentType, label] of [["cap", "盖梁"], ["column", "墩柱"], ["footing", "承台"], ["pile", "桩基"]] as const) nodes.push({
        id: `${pier.id}:${componentType}`, parentId: pier.id, kind: "component", componentType, name: `${pier.name} · ${label}`,
        position: { ...pier.position }, provenance: "demo", description: "演示逻辑构件，无模型绑定。", mediaIds: [], radius: 25 });
    }
    section.boundary = safetyEnvelope(piers.map((pier) => pier.position), 45); nodes.push(section);
  }
  project.boundary = safetyEnvelope(nodes.filter((node) => node.kind === "section").flatMap((node) => node.boundary || []), 30);
  const extent: [number, number] = [now - DAY, now]; const events = demoEvents(nodes, extent);
  return { version: 1, projectId: PROJECT_ID, name: project.name, nodes, ...events, devices: [], media: [], timeExtent: extent,
    coordinateNote: "演示经纬度 WGS84，单位 ° / m；非工程测量数据。", sourceNotes: [reason, "当前工程导航与事件均明确标为演示；真实设备航迹和媒体未提供时保持为空。"], missingData: [...MISSING] };
}

type Fetcher = typeof fetch;
export class LocalSafetyDataAdapter implements SafetyDataAdapter {
  private readonly fetcher: Fetcher;
  constructor(fetcher: Fetcher = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; }

  async load(signal?: AbortSignal): Promise<SafetyDataset> {
    const notes: string[] = [];
    const read = async (url: string): Promise<unknown> => {
      signal?.throwIfAborted();
      const response = await this.fetcher(url, { signal, cache: "no-store", headers: { "X-Cesium-Library": "1" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json(); signal?.throwIfAborted(); return value;
    };
    let listing: LibraryListing;
    try {
      const raw = await read("/__library/records");
      if (!object(raw) || !Array.isArray((raw as LibraryListing).records)) throw new Error("资料库返回格式无效");
      listing = raw as LibraryListing;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return createSafetyDemoDataset(Date.now(), `本地资料库暂不可读（${error instanceof Error ? error.message : "连接失败"}），原平台功能不受影响；使用可替换演示适配器。`);
    }
    const records = listing.records.filter((record) => record && record.files && record.settings && typeof record.id === "string");
    const sources: SafetyCadSource[] = [];
    for (const record of records.filter((entry) => entry.kind === "CAD" && entry.visible)) {
      const url = safeLibraryUrl(record.files.data?.url);
      if (!url) { notes.push(`${record.name} 缺少安全可读的 CAD 中间文件 URL。`); continue; }
      try {
        const raw = await read(url);
        if ((raw as CadImportPackage)?.format !== "cesium-cad-import" || !Array.isArray((raw as CadImportPackage).entities)) throw new Error("CAD 中间文件格式无效");
        sources.push({ record, cad: raw as CadImportPackage });
      } catch (error) { if (signal?.aborted) throw signal.reason; notes.push(`${record.name} 读取失败：${error instanceof Error ? error.message : "未知错误"}。`); }
    }
    const cad = adaptSafetyCadSources(sources); notes.push(...cad.notes);
    for (const problem of listing.problems || []) notes.push(`资料库记录 ${problem.id}：${problem.error}`);
    const video = records.find((record) => record.id === listing.view?.activeVideoId && record.kind === "Drone Video")
      || records.find((record) => record.kind === "Drone Video" && record.visible);
    const devices: SafetyDevice[] = []; const media = [...cad.media];
    let extent: [number, number] = [Date.now() - DAY, Date.now()];
    if (video) {
      const videoUrl = safeLibraryUrl(video.files.video?.url); const trajectoryUrl = safeLibraryUrl(video.files.source?.url);
      const mediaId = `video:${video.id}`;
      if (videoUrl) media.push({ id: mediaId, name: video.files.video.name, kind: "video", url: videoUrl, provenance: "real", relation: "project",
        sourceRecordId: video.id, note: "真实项目无人机视频，仅项目级关联；未核验当前墩位/构件是否处于取景范围，视频配准精度另行验证。" });
      if (trajectoryUrl) try {
        const trajectory = adaptSafetyTrajectory(await read(trajectoryUrl)); notes.push(...trajectory.notes);
        if (trajectory.track.length) {
          extent = [trajectory.track[0].time, trajectory.track[trajectory.track.length - 1].time];
          devices.push({ id: `drone:${video.id}`, nodeId: PROJECT_ID, name: "无人机 · 实际航迹回放", kind: "drone", provenance: "real", status: "replay",
            track: trajectory.track, mediaId: videoUrl ? mediaId : undefined, coordinateNote: trajectory.coordinateNote });
        } else notes.push("所选无人机数据没有带有效绝对时标及高度的轨迹，不绘制替代飞行线。");
      } catch (error) { if (signal?.aborted) throw signal.reason; notes.push(`无人机轨迹读取失败：${error instanceof Error ? error.message : "未知错误"}。`); }
      notes.push(`无人机资料使用记录 ${video.id}${video.id === listing.view?.activeVideoId ? "（当前活跃视频）" : "（可见资料回退）"}，未重复加载其它同源视频。`);
    }
    if (extent[0] === extent[1]) extent = [extent[0], extent[1] + 1000];
    if (!cad.nodes.length) {
      const fallback = createSafetyDemoDataset(extent[1], "未读取到可用于构件导航的真实 CAD 编号锚点，导航使用明确标记的演示数据。");
      fallback.sourceNotes.push(...notes); fallback.media = media; fallback.devices = devices;
      if (devices.length) { fallback.timeExtent = extent; Object.assign(fallback, demoEvents(fallback.nodes, extent)); }
      fallback.nodes[0].mediaIds = media.map((entry) => entry.id); return fallback;
    }
    const sections = cad.nodes.filter((node) => node.kind === "section"); const positions = sections.map((node) => node.position);
    const firstSourceName = sources.find((source) => source.record.id === sections[0]?.sourceRecordId)?.record.name || "当前项目";
    const projectName = firstSourceName.replace(/\.(dwg|cadimport)$/i, "").replace(/主线中心线$/, "");
    const project: SafetyNode = { id: PROJECT_ID, kind: "project", name: `${projectName} · 邻近营业线施工巡检`, position: center(positions),
      provenance: "derived", description: "由当前已加载 CAD 编号与无人机资料组成的工程样板。区域分组和展示包络来自 CAD 文字；真实营业线位置、正式业务接口待接入。",
      radius: radius(positions, 300), boundary: safetyEnvelope(sections.flatMap((node) => node.boundary || [node.position]), 25), mediaIds: media.map((entry) => entry.id) };
    const nodes = [project, ...cad.nodes];
    return { version: 1, projectId: PROJECT_ID, name: project.name, nodes, ...demoEvents(nodes, extent), devices, media, timeExtent: extent,
      coordinateNote: cad.coordinateNotes.join(" "), sourceNotes: [...notes, ...devices.map((device) => device.coordinateNote),
        "发光包络的展示厚度与动画高度独立于工程坐标，原始 CAD、3D Tiles 和视频投影参数未改动。"], missingData: [...MISSING] };
  }
}
