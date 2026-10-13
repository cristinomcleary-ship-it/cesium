export type MachineryModelId = 'crane' | 'pile' | 'excavator';
export type MachineryModelType = 'crane' | 'pile_rig' | 'excavator';
export type Vec3 = [number, number, number];
export type MachineryParameters = Record<string, number>;

export interface MachineryParameterDefinition {
  readonly key: string;
  readonly label: string;
  readonly unit: 'm' | '×';
  readonly original: number;
  readonly min?: number;
  readonly min_exclusive?: boolean;
  readonly step?: number;
  readonly description?: string;
}
export interface MachineryReferenceDimensions {
  readonly body_height_m: number;
  readonly overall_height_m: number;
  readonly ground_y_m: number;
  readonly body_top_y_m: number;
  readonly anchor_m: Vec3;
  readonly definition?: string;
}
interface CommonConfig {
  readonly parameters: readonly MachineryParameterDefinition[];
  readonly local_parameters: readonly MachineryParameterDefinition[];
  readonly reference_dimensions: MachineryReferenceDimensions;
  readonly limitations?: readonly string[];
  readonly limits?: readonly string[];
}
export interface CraneLeg {
  readonly index: number;
  readonly center_m: Vec3;
  readonly longitudinal_sign: -1 | 1;
  readonly lateral_sign: -1 | 1;
  readonly rigid_part_id: number;
  readonly beam_part_id: number;
  readonly beam_inner_z_m: number;
  readonly beam_outer_z_m: number;
}
export interface CraneConfig extends CommonConfig {
  readonly type: 'crane';
  readonly boom: {
    readonly axis: Vec3;
    readonly root_projection_m: number;
    readonly tip_projection_m: number;
    readonly extension_anchor_projection_m: number;
    readonly original_length_m: number;
  };
  readonly outriggers: {
    readonly original_lateral_m: number;
    readonly original_longitudinal_m: number;
    readonly legs: readonly CraneLeg[];
  };
}
export interface PileConfig extends CommonConfig {
  readonly type: 'pile_rig';
  readonly default_total_height_m: number;
  readonly ground_y_m: number;
  readonly fixed_bottom_upper_y_m: number;
  readonly fixed_bottom_height_m: number;
  readonly top_head_height_m: number;
  readonly adjustable_default_span_m: number;
}
export interface ExcavatorConfig extends CommonConfig { readonly type: 'excavator' }
export type MachineryConfig = CraneConfig | PileConfig | ExcavatorConfig;

export interface LoadedMachineryAsset {
  readonly id: MachineryModelId;
  readonly name: string;
  readonly type: MachineryModelType;
  readonly version: string;
  readonly config: MachineryConfig;
  /** Original, uncentred, Y-up coordinates in metres. Never mutate these arrays. */
  readonly sourcePositions: Float64Array;
  readonly indices: Uint32Array;
  readonly partIds: Uint8Array;
  /** Original FBX diffuse numeric RGB values, without texture baking. */
  readonly palette: Float32Array;
  readonly faceColorIndices: Uint8Array;
}
export interface MachineryBounds { min: Vec3; max: Vec3; size: Vec3 }
export interface MachineryGeometry {
  /** Y-up metres relative to the fixed ground anchor, suitable for a glTF mesh. */
  positions: Float64Array;
  indices: Uint32Array;
  bounds: MachineryBounds;
  sourceAnchor: Vec3;
}
export interface MachineryResolveOptions {
  /** Rule for the NEXT edit. Changing the option alone preserves the current shape. */
  proportional?: boolean;
}
export interface MachineryLoadOptions {
  /** e.g. import.meta.env.BASE_URL + 'machinery/' supplied by the caller. */
  baseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}
export interface AssetArrayRange { offset: number; byteLength: number }
export interface MachineryAssetManifest {
  schema: 'machinery-asset/v1';
  version: string;
  id: MachineryModelId;
  name: string;
  type: MachineryModelType;
  config: MachineryConfig;
  vertexCount: number;
  triangleCount: number;
  paletteSize: number;
  byteLength: number;
  arrays: Record<'positions' | 'indices' | 'partIds' | 'palette' | 'faceColorIndices', AssetArrayRange>;
  chunks: Array<{ file: string; byteLength: number; sha256: string }>;
}
