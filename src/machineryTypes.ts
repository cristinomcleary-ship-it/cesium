/** Versioned display geometry attached to an existing equipment resource.
 * This is neither equipment qualification nor a construction acceptance record. */
export const MACHINERY_ASSET_VERSION = "2026-10-13-v1" as const;
export const MACHINERY_ASSET_IDS = ["crane", "pile", "excavator"] as const;
export type MachineryAssetId = typeof MACHINERY_ASSET_IDS[number];
export type MachineryPlacement = {
  longitude: number;
  latitude: number;
  /** Scene ground anchor height in metres above the WGS84 ellipsoid. A picked surface height
   * is stored as returned by Cesium; no conversion to a project's engineering datum is implied. */
  height: number;
  /** Clockwise degrees from north for the source +X reference axis, in [0, 360).
   * Source forward directions are not calibrated; this is not a surveyed machine heading. */
  heading: number;
};
export type MachineryMetadata = {
  schemaVersion: 1;
  assetId: MachineryAssetId;
  assetVersion: typeof MACHINERY_ASSET_VERSION;
  /** Editing policy for the next change; switching policy preserves the current shape. */
  proportional: boolean;
  /** Complete resolved parameter set. Distances are metres; overall_scale is a multiplier.
   * Crane boom_rotation_deg is clockwise degrees relative to the source boom pose in [0, 360),
   * independent of the chassis placement.heading and overall_scale. Legacy omission means 0.
   * Crane boom_elevation_deg is the boom centreline angle above horizontal in [0, 90];
   * legacy omission preserves the source angle. These are visual pose controls, not rated limits. */
  parameters: Record<string, number>;
  placement: MachineryPlacement;
  visible: boolean;
};
