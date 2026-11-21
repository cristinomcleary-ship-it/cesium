import { computeMachineryGeometry } from './machinery/engine';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { convexHull, intersectPolygons, pointInPolygon, projectWgs84ToLocal, unprojectLocalToWgs84, type Point2 } from './railSafetyGeometry';
import { RAIL_SAFETY_CONSTRUCTION_LABELS, RAIL_SAFETY_DECLARED_CONSTRUCTION_LABELS, type RailSafetyDeclaredConstructionClass, type RailSafetyAttachedRange, type RailSafetyConstructionClass, type RailSafetyMachine, type RailSafetyPosition } from './railSafetyTypes';

export type RailSafetyRangeStatus = 'unknown' | 'overlap' | 'touching' | 'clear';
export type RailSafetyRangeAlarm = { kind: 'classification' | 'zone' | 'activity'; classification?: RailSafetyConstructionClass; message: string };
export type RailSafetyWorkRange = { origin: RailSafetyPosition; polygon: Point2[]; source: 'model-rotation' | 'model-footprint' | 'user-defined'; radiusMeters?: number; heightMeters: number };
export type RailSafetyLimitAssessment = { name: string; limitType?: 'equipment' | 'line'; status: RailSafetyRangeStatus; workStatus?: RailSafetyRangeStatus };
export type RailSafetyConstructionAssessment = {
  declaredClass?: RailSafetyDeclaredConstructionClass; classification: RailSafetyConstructionClass | 'unknown'; classifications?: RailSafetyConstructionClass[]; classificationComplete: boolean;
  classificationReasons: string[]; alarms: RailSafetyRangeAlarm[]; activityStatus: 'unconfigured' | 'inside' | 'outside' | 'unknown';
};
const rank: Record<RailSafetyConstructionClass, number> = { C: 0, B: 1, window: 2, A: 3 };
const touches = (status?: RailSafetyRangeStatus) => status === 'overlap' || status === 'touching';
const enu = (x: number, z: number, heading: number): Point2 => {
  const angle = heading * Math.PI / 180;
  return { x: x * Math.sin(angle) + z * Math.cos(angle), y: x * Math.cos(angle) - z * Math.sin(angle) };
};

/** Preserve each surveyed height relative to the saved station, with clockwise compass rotation. */
export function transformAttachedRange(range: RailSafetyAttachedRange, placement: MachineryMetadata['placement']): RailSafetyPosition[] {
  const angle = (placement.heading - range.anchor.heading) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return range.polygon.map(position => {
    const point = projectWgs84ToLocal(position, range.anchor);
    return { ...unprojectLocalToWgs84({ x: point.x * c + point.y * s, y: -point.x * s + point.y * c }, placement),
      height: placement.height + position.height - range.anchor.height };
  });
}

/** Full horizontal slew disk around the measured bearing, plus the current static chassis footprint.
 * The disk is circumscribed (not inscribed), so the space between samples cannot silently exclude a contact. */
export function computeMachineryWorkRange(asset: LoadedMachineryAsset, state: MachineryMetadata): RailSafetyWorkRange {
  if (state.assetId !== asset.id || state.assetVersion !== asset.version) throw new Error('机械模型版本不匹配，无法计算工作范围');
  const mesh = computeMachineryGeometry(asset, state.parameters), used = new Set(mesh.indices);
  const origin = { longitude: state.placement.longitude, latitude: state.placement.latitude, height: state.placement.height };
  const sourcePoints: Point2[] = [];
  for (const index of used) sourcePoints.push({ x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 2] });
  if (!sourcePoints.length || sourcePoints.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.hypot(p.x, p.y) > 1000)) throw new Error('机械模型工作范围无效');
  let radiusMeters: number | undefined;
  if (asset.config.type === 'crane') {
    const config = asset.config, anchor = config.reference_dimensions.anchor_m, scale = state.parameters.overall_scale;
    const pivot = { x: (config.rotation.pivot_m[0] - anchor[0]) * scale, y: (config.rotation.pivot_m[2] - anchor[2]) * scale };
    radiusMeters = 0;
    for (const [start, count] of config.rotation.vertex_ranges) for (let index = start; index < start + count; index++) {
      if (used.has(index)) radiusMeters = Math.max(radiusMeters, Math.hypot(mesh.positions[index * 3] - pivot.x, mesh.positions[index * 3 + 2] - pivot.y));
    }
    if (!radiusMeters) throw new Error('无法识别吊机回转范围');
    const segments = 96, radius = radiusMeters / Math.cos(Math.PI / segments);
    for (let i = 0; i < segments; i++) {
      const angle = 2 * Math.PI * i / segments;
      sourcePoints.push({ x: pivot.x + radius * Math.cos(angle), y: pivot.y + radius * Math.sin(angle) });
    }
  }
  return { origin, polygon: convexHull(sourcePoints).map(p => enu(p.x, p.y, state.placement.heading)),
    source: radiusMeters === undefined ? 'model-footprint' : 'model-rotation', radiusMeters, heightMeters: mesh.bounds.max[1] };
}

/** Independent channels preserve known hazards when a limit, geometry, or activity boundary is unavailable. */
export function assessMachineryConstruction(input: {
  state: MachineryMetadata; definition?: RailSafetyMachine; limits: readonly RailSafetyLimitAssessment[]; workRange?: RailSafetyWorkRange;
}): RailSafetyConstructionAssessment {
  const { state, definition, limits, workRange } = input;
  const declaredClass = state.constructionClass;
  const classificationComplete = !!definition?.selectedLimitIds.length && limits.length === definition.selectedLimitIds.length
    && limits.every(limit => limit.status !== 'unknown' && limit.workStatus !== undefined && limit.workStatus !== 'unknown');
  const hits: Array<{ classification: RailSafetyConstructionClass; reason: string }> = [];
  for (const limit of limits) {
    if (limit.limitType === 'line' && touches(limit.status)) hits.push({ classification: 'window', reason: `倾覆范围触及铁路线路安全限界「${limit.name}」` });
    if (touches(limit.workStatus)) hits.push({ classification: 'A', reason: `工作范围触及安全限界「${limit.name}」` });
    if (limit.limitType !== 'line' && touches(limit.status)) hits.push({ classification: 'B', reason: `倾覆范围触及铁路设备安全限界「${limit.name}」` });
  }
  hits.sort((a, b) => rank[b.classification] - rank[a.classification]);
  const classification: RailSafetyConstructionAssessment['classification'] = hits.length ? hits[0].classification : classificationComplete ? 'C' : 'unknown';
  const classifications = [...new Set(hits.map(hit => hit.classification))];
  if (classification === 'C') classifications.push('C');
  const classificationReasons = [...new Set(hits.map(hit => hit.reason))];
  if (classification === 'C') classificationReasons.push('工作范围和倾覆范围均未触及关联安全限界');
  if (!classificationComplete) classificationReasons.push('关联限界或机械范围不完整，当前分类待核实');
  const alarms: RailSafetyRangeAlarm[] = [];
  // A declaration grants all lower levels; the combined declaration additionally records B work.
  // Evaluate each observed level separately so an A intrusion never hides a concurrent window intrusion.
  const declaredRank = declaredClass ? rank[declaredClass === 'B+window' ? 'window' : declaredClass] : undefined;
  if (declaredClass && declaredRank !== undefined) for (const observed of classifications) {
    if (rank[observed] <= declaredRank) continue;
    const reasons = [...new Set(hits.filter(hit => hit.classification === observed).map(hit => hit.reason))];
    alarms.push({ kind: 'classification', classification: observed, message: `申报${RAIL_SAFETY_DECLARED_CONSTRUCTION_LABELS[declaredClass]}，当前范围已触及${RAIL_SAFETY_CONSTRUCTION_LABELS[observed]}：${reasons.join('；')}` });
  }
  const zoneHits = new Map<RailSafetyConstructionClass, string[]>();
  if (declaredClass && declaredRank !== undefined && workRange) for (const zone of definition?.constructionZones ?? []) {
    if (rank[zone.classification] <= declaredRank) continue;
    try {
      const intersection = intersectPolygons(workRange.polygon, zone.polygon.map(p => projectWgs84ToLocal(p, workRange.origin)));
      if (intersection.relation !== 'disjoint') zoneHits.set(zone.classification, [...(zoneHits.get(zone.classification) ?? []), zone.name]);
    } catch { classificationReasons.push(`施工分类区「${zone.name}」超出本地计算范围，待核实`); }
  }
  if (declaredClass) for (const observed of [...zoneHits.keys()].sort((a, b) => rank[b] - rank[a])) {
    const names = [...new Set(zoneHits.get(observed)!)].map(name => `「${name}」`).join('、');
    alarms.push({ kind: 'zone', classification: observed, message: `工作范围触及${RAIL_SAFETY_CONSTRUCTION_LABELS[observed]}范围${names}（申报${RAIL_SAFETY_DECLARED_CONSTRUCTION_LABELS[declaredClass]}）` });
  }
  let activityStatus: RailSafetyConstructionAssessment['activityStatus'] = 'unconfigured';
  if (definition?.activityPolygon) {
    try {
      const area = definition.activityPolygon;
      const horizontal = (position: RailSafetyPosition) => {
        if (![position.longitude, position.latitude].every(Number.isFinite) || Math.abs(position.longitude) > 180 || Math.abs(position.latitude) >= 89.9) throw new Error('活动范围坐标无效');
        return { longitude: position.longitude, latitude: position.latitude, height: 0 };
      };
      const origin = horizontal(area[0]), station = horizontal(state.placement), corners = area.map(horizontal);
      const angle = (point: RailSafetyPosition) => {
        const latitude = point.latitude * Math.PI / 180, base = origin.latitude * Math.PI / 180;
        const dlat = latitude - base, dlon = (point.longitude - origin.longitude) * Math.PI / 180;
        const haversine = Math.sin(dlat / 2) ** 2 + Math.cos(base) * Math.cos(latitude) * Math.sin(dlon / 2) ** 2;
        return 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
      };
      // A small spherical cap containing every corner also contains all its short edges and interior.
      // This excludes far-away stations without the local projector's 20 km bound or any height dependence.
      const radius = Math.max(...corners.map(angle)), margin = 1 / 6371008.8;
      if (radius < Math.PI / 2 && angle(station) > radius + margin) activityStatus = 'outside';
      else {
        const polygon = corners.map(p => projectWgs84ToLocal(p, origin));
        activityStatus = pointInPolygon(projectWgs84ToLocal(station, origin), polygon) === 'outside' ? 'outside' : 'inside';
      }
      if (activityStatus === 'outside') alarms.push({ kind: 'activity', message: '机械站位超出已设置的活动范围' });
    } catch { activityStatus = 'unknown'; }
  }
  return { declaredClass, classification, classifications, classificationComplete, classificationReasons, alarms, activityStatus };
}
