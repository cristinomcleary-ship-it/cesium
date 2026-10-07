import { ArcType, Cartesian3, Color, Ellipsoid, Entity, HeightReference, PolygonHierarchy } from "cesium";
import type { SpatialObject } from "./safetySpatialTypes.ts";

/** Visual anti-flicker offset only. Never write these coordinates back to the ledger. */
export const SPATIAL_DISPLAY_OFFSET_METERS = 0.12;
export const SPATIAL_BOUNDARY_WIDTH = { normal: 3, selected: 4 } as const;
const colors = { "construction-area": "#43D9FF", railway: "#FFB957", "risk-point": "#FFB957" };

export function spatialDisplayPositions(object: SpatialObject): Cartesian3[] {
  const positions = object.geometry.type === "Point" ? [object.geometry.position] : object.geometry.positions;
  return positions.map((position, index) => {
    const anchor = object.source.vertices[index]?.anchor?.position;
    // Prefer the original double-precision model-surface anchor, without a round trip.
    const world = anchor ? new Cartesian3(anchor.x, anchor.y, anchor.z)
      : Cartesian3.fromDegrees(position.longitude, position.latitude, position.height);
    const normal = Ellipsoid.WGS84.geodeticSurfaceNormal(world, new Cartesian3());
    return Cartesian3.add(world, Cartesian3.multiplyByScalar(normal, SPATIAL_DISPLAY_OFFSET_METERS, normal), world);
  });
}

/**
 * A surface-height mesh, not a vertical classification volume. Ground classification
 * also colors bridges/buildings above the saved footprint and can create cyan shards.
 * Unverified legacy corridors retain their original centerline; no new closed area
 * or common elevation is inferred from their width. Their full record stays intact.
 */
export function createSpatialDisplayEntity(object: SpatialObject): Entity {
  const positions = spatialDisplayPositions(object), color = Color.fromCssColorString(colors[object.kind]);
  const common = { id: "spatial-geometry:" + object.id, name: object.name, show: object.visible,
    properties: { spatialObjectId: object.id } };
  if (object.geometry.type === "Point") return new Entity({ ...common, position: positions[0],
    point: { pixelSize: 12, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.NONE } });
  const closed = object.geometry.type === "Polygon";
  return new Entity({ ...common,
    ...(closed ? { polygon: { hierarchy: new PolygonHierarchy(positions), perPositionHeight: true,
      heightReference: HeightReference.NONE, material: color.withAlpha(.12), outline: false } } : {}),
    polyline: { positions: closed ? [...positions, positions[0]] : positions,
      width: SPATIAL_BOUNDARY_WIDTH.normal, arcType: ArcType.NONE, clampToGround: false, material: color },
  });
}
