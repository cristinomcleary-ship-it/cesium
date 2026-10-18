import {
  Cesium3DTileset, Cesium3DTileColorBlendMode, CustomShader,
  CustomShaderMode, CustomShaderTranslucencyMode, EdgeDisplayMode,
  LightingModel, PointCloudShading,
  SplitDirection, type Cesium3DTile, type Cesium3DTileContent,
} from 'cesium';

export type SavedVideoOverlayOcclusion = { enabled: boolean; sourceId: string };
export type VideoOverlayOcclusionStatus = { enabled: boolean; sourceId?: string; ready: boolean; error?: string };

export function validateVideoOverlayOcclusion(value?: SavedVideoOverlayOcclusion): SavedVideoOverlayOcclusion {
  if (value === undefined) return { enabled: false, sourceId: '' };
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean'
    || typeof value.sourceId !== 'string' || (value.enabled && !value.sourceId.trim())) {
    throw new Error('地表遮挡设置无效：请明确选择已加载的倾斜摄影');
  }
  return { enabled: value.enabled, sourceId: value.sourceId };
}

function contentHasMesh(content: Cesium3DTileContent | undefined): boolean {
  if (!content) return false;
  if ((content as Cesium3DTileContent & { ready?: boolean }).ready === false) return false;
  if (content.pointsLength > 0) throw new Error('地表遮挡仅支持网格倾斜摄影，不支持点云');
  if (content.innerContents?.length) {
    let mesh = false;
    for (const inner of content.innerContents) mesh = contentHasMesh(inner) || mesh;
    return mesh;
  }
  if (content.trianglesLength > 0) return true;
  // Empty and external tileset containers have no geometry of their own.
  if (content.geometryByteLength === 0) return false;
  throw new Error('此倾斜摄影包含暂不支持的遮挡内容类型');
}

function loadedMeshes(source: Cesium3DTileset): boolean {
  const pending = [source.root];
  let mesh = false;
  while (pending.length) {
    const tile = pending.pop();
    if (!tile) continue;
    mesh = contentHasMesh(tile.content) || mesh;
    for (const child of tile.children) pending.push(child);
  }
  return mesh;
}

/** Compatibility only. Account access and import identity are checked by the resource owner. */
export function assertVideoOverlayOccluder(resource: unknown): asserts resource is Cesium3DTileset {
  if (!(resource instanceof Cesium3DTileset)) throw new Error('地表遮挡源必须是已加载的 Cesium 3D Tiles 倾斜摄影');
  if (resource.isDestroyed()) throw new Error('地表遮挡源已移除，请重新加载倾斜摄影');
  if (resource.classificationType !== undefined) throw new Error('分类瓦片不能作为地表遮挡源，请选择网格倾斜摄影');
  if (resource.customShader?.vertexShaderText?.trim()) throw new Error('遮挡源含自定义顶点变形，暂不能安全用于地表遮挡');
  for (const clipping of [resource.clippingPlanes, resource.clippingPolygons]) {
    if (clipping?.enabled && clipping.length > 0) throw new Error('遮挡源正在剖切或开挖，请先关闭其裁剪后再启用地表遮挡');
  }
}

const debugFlags = [
  'debugColorizeTiles', 'debugWireframe', 'debugShowBoundingVolume',
  'debugShowContentBoundingVolume', 'debugShowViewerRequestVolume', 'debugShowGeometricError',
  'debugShowRenderingStatistics', 'debugShowMemoryUsage', 'debugShowUrl', 'showOutline',
] as const;

/** Owns only temporary material state; it never changes positioning or map visibility. */
export class VideoOverlayOcclusion {
  private readonly shader: CustomShader;
  private readonly previous = new Map<string, unknown>();
  private readonly applied = new Map<string, unknown>();
  private readonly removers: Array<() => void> = [];
  private meshSeen = false;
  private error?: string;
  private restored = false;

  constructor(readonly sourceId: string, readonly source: Cesium3DTileset) {
    assertVideoOverlayOccluder(source);
    this.meshSeen = loadedMeshes(source);
    this.shader = new CustomShader({
      mode: CustomShaderMode.REPLACE_MATERIAL,
      lightingModel: LightingModel.UNLIT,
      translucencyMode: CustomShaderTranslucencyMode.OPAQUE,
      // Opaque pass writes depth. Transparent black replaces any farther color,
      // regardless of draw order, and remains transparent through the lens pass.
      fragmentShaderText: `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        material.diffuse = vec3(0.0);
        material.emissive = vec3(0.0);
        material.alpha = 0.0;
      }`,
    });
    try {
      this.replace('customShader', this.shader);
      // Styles can discard alpha-zero features, and Cesium does not define their
      // combination with a custom shader. Retain the exact user-owned style.
      this.replace('style', undefined);
      this.replace('colorBlendMode', Cesium3DTileColorBlendMode.HIGHLIGHT);
      this.replace('splitDirection', SplitDirection.NONE);
      this.replace('edgeDisplayMode', EdgeDisplayMode.SURFACES_ONLY);
      this.replace('pointCloudShading', new PointCloudShading({ attenuation: false, eyeDomeLighting: false }));
      for (const key of debugFlags) this.replace(key, false);
      const inspect = (tile: Cesium3DTile) => {
        try { this.meshSeen = contentHasMesh(tile.content) || this.meshSeen; }
        catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      };
      this.removers.push(source.tileLoad.addEventListener(inspect), source.tileVisible.addEventListener(inspect));
      this.removers.push(source.tileFailed.addEventListener(() => { this.error = '遮挡源瓦片加载失败，请重新进入融合重试'; }));
    } catch (error) { this.restore(); throw error; }
  }

  private replace(key: string, value: unknown) {
    const object = this.source as unknown as Record<string, unknown>;
    this.previous.set(key, object[key]); this.applied.set(key, value); object[key] = value;
  }

  getStatus(): VideoOverlayOcclusionStatus {
    const status: VideoOverlayOcclusionStatus = { enabled: true, sourceId: this.sourceId, ready: false };
    if (this.restored || this.source.isDestroyed()) return { ...status, error: '地表遮挡源已移除或会话已结束' };
    if (this.error) return { ...status, error: this.error };
    if (this.source.customShader !== this.shader) return { ...status, error: '遮挡源材质已被其他功能修改，请重新进入融合' };
    try {
      assertVideoOverlayOccluder(this.source);
      const object = this.source as unknown as Record<string, unknown>;
      for (const [key, value] of this.applied) {
        if (object[key] !== value) return { ...status, error: '遮挡源显示状态已被其他功能修改，请重新进入融合' };
      }
      // tilesLoaded is refreshed after post processing in our pinned engine. During
      // a camera jump it can still describe the previous frame, so also check
      // the current traversal's counters before revealing any overlay pixels.
      const statistics = object.statistics as Record<string, number> | undefined;
      const currentReady = !!statistics && ['numberOfPendingRequests', 'numberOfTilesProcessing', 'numberOfAttemptedRequests']
        .every(key => statistics[key] === 0);
      return { ...status, ready: this.source.tilesLoaded && currentReady && this.meshSeen };
    } catch (error) { return { ...status, error: error instanceof Error ? error.message : String(error) }; }
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    for (const remove of this.removers.splice(0)) remove();
    if (!this.source.isDestroyed()) {
      const object = this.source as unknown as Record<string, unknown>;
      // Each property has independent ownership. Preserve a new shader/style
      // owner while still restoring debug/point-cloud state left in our care.
      for (const [key, value] of this.previous) {
        if (object[key] === this.applied.get(key)) object[key] = value;
      }
    }
    if (!this.shader.isDestroyed()) this.shader.destroy();
  }
}
