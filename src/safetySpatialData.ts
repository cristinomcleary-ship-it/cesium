import type { SafetyAlert, SafetyDataset, SafetyNode, SafetyPosition, SafetyTrackPoint } from "./safetyTypes.ts";
import type { SpatialObject, SpatialSnapshot } from "./safetySpatialTypes.ts";
import { spatialPositions, validateSpatialSnapshot } from "./safetySpatialValidation.ts";

/** Timestamp consistency allowance, not a claim about camera or survey accuracy. */
export const SPATIAL_REPLAY_TOLERANCE_MS = 50;

/** Map media time only on a finite, strictly ordered source clock; never extrapolate. */
export function spatialReplayTimeAt(track: readonly SafetyTrackPoint[], mediaSeconds: number): number | undefined {
  if (!Number.isFinite(mediaSeconds) || mediaSeconds < 0 || !track.length) return undefined;
  for (let index = 0; index < track.length; index++) {
    const point = track[index], previous = track[index - 1];
    if (!Number.isFinite(point.time) || !Number.isFinite(point.mediaSeconds) || point.mediaSeconds < 0
      || previous && (point.time <= previous.time || point.mediaSeconds <= previous.mediaSeconds)) return undefined;
  }
  if (mediaSeconds < track[0].mediaSeconds || mediaSeconds > track.at(-1)!.mediaSeconds) return undefined;
  for (let index = 0; index < track.length; index++) {
    const point = track[index], next = track[index + 1];
    if (mediaSeconds === point.mediaSeconds) return point.time;
    if (next && mediaSeconds < next.mediaSeconds) {
      // A break in source observations has no verified clock mapping between its endpoints.
      if ((point.segment ?? 0) !== (next.segment ?? 0)) return undefined;
      return point.time + (next.time - point.time) * (mediaSeconds - point.mediaSeconds) / (next.mediaSeconds - point.mediaSeconds);
    }
  }
  return undefined;
}

function anchor(object: SpatialObject): SafetyPosition {
  const points = spatialPositions(object.geometry);
  return points.reduce((total, point) => ({ longitude: total.longitude + point.longitude / points.length,
    latitude: total.latitude + point.latitude / points.length, height: total.height + point.height / points.length }),
  { longitude: 0, latitude: 0, height: 0 });
}
function radius(object: SpatialObject, position: SafetyPosition): number {
  const cos = Math.cos(position.latitude * Math.PI / 180);
  return Math.max(15, object.geometry.type === "Corridor" ? object.geometry.widthMeters / 2 : 0,
    ...spatialPositions(object.geometry).map((point) => Math.hypot((point.longitude - position.longitude) * 111_320 * cos,
      (point.latitude - position.latitude) * 111_320)));
}

/** Merge into the original adapter dataset; never write user geometry into CAD, model or railway sources. */
export function mergeSpatialDataset(base: SafetyDataset, snapshot: SpatialSnapshot): SafetyDataset {
  const validated = validateSpatialSnapshot(snapshot);
  const objects = validated.objects.filter((object) => object.projectId === base.projectId && object.visible);
  const byObject = new Map(objects.map((object) => [object.id, object]));
  const notes: string[] = [];
  const nodes = base.nodes.filter((node) => !node.spatialObjectId);
  const alerts = base.alerts.filter((alert) => !alert.spatialObjectId);
  const nodeNames = new Map([...nodes.map((node) => [node.id, node.name] as const), ...objects.map((object) => [`spatial:${object.id}`, object.name] as const)]);
  const mediaById = new Map(base.media.map((media) => [media.id, media]));
  let start = base.timeExtent[0], end = base.timeExtent[1];
  for (const object of objects) {
    const warning: string[] = [];
    const linkedMedia = object.linkedMediaIds.filter((id) => mediaById.has(id));
    const missingMedia = object.linkedMediaIds.filter((id) => !mediaById.has(id));
    const missingNodes = object.linkedNodeIds.filter((id) => !nodeNames.has(id));
    if (missingMedia.length) warning.push(`关联资料失效：${missingMedia.join("、")}，未自动替换。`);
    if (missingNodes.length) warning.push(`关联对象失效：${missingNodes.join("、")}，未按名称重新绑定。`);
    const area = object.areaId ? byObject.get(object.areaId) : undefined;
    const railway = object.railwayId ? byObject.get(object.railwayId) : undefined;
    if (object.areaId && area?.kind !== "construction-area") warning.push(`关联施工区域 ${object.areaId} 已隐藏、删除或类型不匹配，定位点仍保留。`);
    if (object.railwayId && railway?.kind !== "railway") warning.push(`关联铁路范围 ${object.railwayId} 已隐藏、删除或类型不匹配。`);
    const associations: string[] = [];
    const linkedNodes = object.linkedNodeIds.filter((id) => nodeNames.has(id));
    if (linkedNodes.length) associations.push(`关联工程对象：${linkedNodes.map((id) => `${nodeNames.get(id)}（${id}）`).join("、")}。`);
    if (area?.kind === "construction-area") associations.push(`关联施工区域：${area.name}（spatial:${area.id}）。`);
    if (railway?.kind === "railway") associations.push(`关联铁路范围：${railway.name}（spatial:${railway.id}）。`);
    let mediaSeconds: number | undefined;
    if (object.risk?.observationSource === "replay-review") {
      const risk = object.risk;
      const media = risk.videoId ? mediaById.get(risk.videoId) : undefined;
      const device = base.devices.find((candidate) => candidate.mediaId === risk.videoId);
      const mappedTime = device && risk.mediaSeconds !== undefined ? spatialReplayTimeAt(device.track, risk.mediaSeconds) : undefined;
      if (media?.kind === "video" && linkedMedia.includes(media.id) && mappedTime !== undefined
        && Math.abs(mappedTime - risk.observedAt) <= SPATIAL_REPLAY_TOLERANCE_MS) {
        mediaSeconds = risk.mediaSeconds;
        associations.push(`关联回放：${media.name}（${media.id}），视频 ${mediaSeconds} s；时标对应通过校验，尚未核验该画面的对象取景或视频配准精度。`);
      } else warning.push("关联回放视频、视频时刻或事件时标无法核对，仅保留用户记录，不自动跳转历史画面。");
    } else if (object.risk?.observationSource === "field-entry" && linkedMedia.some((id) => mediaById.get(id)?.kind === "video")) {
      associations.push("已关联视频仅为项目参考资料，未核验为本次风险的事发画面；现场记录不借用历史视频时标，不自动跳转。");
    }
    const point = anchor(object);
    const description = object.kind === "construction-area" ? "人工绘制并确认的施工展示范围；不代表已审批的施工红线。"
      : object.kind === "railway" ? `人工界定的铁路参考范围${object.geometry.type === "Corridor" ? `，中心线两侧合计总宽度 ${object.geometry.widthMeters} m` : ""}；不代表正式营业线实测边界或法定限界。`
        : "人工选取并确认的风险定位点；风险等级及说明由用户输入，未经过现场复核或自动检测。";
    const sources = [...new Set(object.source.vertices.map((vertex) => ({ "model-depth": "模型深度拾取", terrain: "地形拾取", ellipsoid: "椭球回退", manual: "手动输入" }[vertex.pickKind])))];
    const relationDescription = [...associations, ...warning].join(" ");
    const node: SafetyNode = { id: `spatial:${object.id}`, parentId: object.kind === "risk-point" && area?.kind === "construction-area" ? `spatial:${area.id}` : base.projectId,
      kind: object.kind === "risk-point" ? "component" : "section", name: object.name, position: point, radius: radius(object, point),
      provenance: "user", spatialKind: object.kind, spatialObjectId: object.id, mediaIds: linkedMedia,
      description: `${description} 坐标来源：${sources.join("、")}；场景 EPSG:4979，源高程基准未知。${relationDescription}`,
      ...(object.geometry.type === "Polygon" ? { boundary: object.geometry.positions.map((position) => ({ ...position })) } : {}) };
    nodes.push(node);
    if (object.kind === "risk-point" && object.risk) {
      const risk = object.risk;
      const alert: SafetyAlert = { id: `spatial-alert:${object.id}`, nodeId: node.id, spatialObjectId: object.id, title: object.name,
        severity: risk.severity, timestamp: risk.observedAt, status: risk.status, provenance: "user",
        description: `${risk.description}\n人工记录来源：${risk.observationSource === "replay-review" ? "视频回放复核" : "现场人工录入"}。用户确认范围为几何和描述，非正式验收。${relationDescription}`,
        mediaIds: linkedMedia, rectifications: [], ...(mediaSeconds === undefined ? {} : { mediaSeconds }) };
      alerts.push(alert); start = Math.min(start, risk.observedAt); end = Math.max(end, risk.observedAt);
    }
    if (warning.length) notes.push(`[人工标绘] ${object.name}：${warning.join(" ")}`);
  }
  const foreignCount = validated.objects.filter((object) => object.projectId !== base.projectId).length;
  if (foreignCount) notes.push(`[人工标绘] ${foreignCount} 个对象属于其它项目，未混入当前工程。`);
  if (validated.objects.length) notes.unshift(`[人工标绘] 已读取第 ${validated.revision} 版；当前项目显示 ${objects.length} 个用户确认对象。原始 CAD、模型和正式铁路源数据未改写。`);
  return { ...base, nodes, alerts, timeExtent: [start, end], sourceNotes: [...base.sourceNotes.filter((note) => !note.startsWith("[人工标绘]")), ...notes] };
}
