import type { SpatialKind, SpatialObject, SpatialSnapshot } from "./safetySpatialTypes.ts";

export function spatialFixture(kind: SpatialKind = "construction-area", id = "area-one"): SpatialObject {
  const positions = [
    { longitude: 120.89, latitude: 30.836, height: 12 },
    { longitude: 120.892, latitude: 30.836, height: 12 },
    { longitude: 120.892, latitude: 30.838, height: 12 },
    { longitude: 120.89, latitude: 30.838, height: 12 },
  ];
  const count = kind === "risk-point" ? 1 : kind === "railway" ? 2 : 4;
  const now = "2026-10-07T08:00:00.000Z";
  return { id, kind, name: kind === "construction-area" ? "人工施工区域" : kind === "railway" ? "人工铁路参考范围" : "人工风险记录", visible: true,
    geometry: kind === "risk-point" ? { type: "Point", position: positions[0] } : kind === "railway" ? { type: "Corridor", positions: positions.slice(0, 2), widthMeters: 12 } : { type: "Polygon", positions },
    projectId: "safety:project", linkedNodeIds: [], linkedMediaIds: [],
    source: { kind: "user-drawn", sceneCrs: "EPSG:4979", heightDatum: "unknown", vertices: positions.slice(0, count).map((point) => ({ pickKind: "model-depth", sourceHeight: point.height, sourceRecordId: "tiles-source" })) },
    confirmation: { status: "user-confirmed", scope: "geometry-and-description", confirmedAt: now },
    createdAt: now, updatedAt: now,
    ...(kind === "risk-point" ? { risk: { severity: "high" as const, status: "open" as const, description: "由用户记录的风险描述，待现场复核", observedAt: Date.parse(now), observationSource: "field-entry" as const } } : {}) };
}
export function spatialSnapshot(...objects: SpatialObject[]): SpatialSnapshot {
  return { version: 1, revision: 1, updatedAt: "2026-10-07T08:00:00.000Z", objects };
}
