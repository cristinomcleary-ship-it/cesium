import {
  Cesium3DTileset, Cesium3DTileColorBlendMode, CustomShader,
  CustomShaderMode, CustomShaderTranslucencyMode, EdgeDisplayMode,
  LightingModel, PointCloudShading,
  SplitDirection, type Cesium3DTile, type Cesium3DTileContent, type Scene,
} from 'cesium';

export type SavedVideoOverlayOcclusion = { enabled: boolean; sourceId: string };
export type VideoOverlayOcclusionStatus = {
  enabled: boolean; sourceId?: string; ready: boolean; error?: string;
  refining?: boolean; warning?: string;
};

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

// These traversal fields are deliberately isolated to the pinned Cesium 1.144 /
// engine 26.2 adapter. Missing fields fail closed rather than accepting old-view
// geometry. Frame numbers and visibility epochs have different lifetimes.
type FrameScene = { frameState?: { frameNumber?: number } };
type TraversalSource = { _updatedVisibilityFrame?: number; _pass?: number; memoryAdjustedScreenSpaceError?: number };
type CoverageTile = Cesium3DTile & {
  _updatedVisibilityFrame?: number; _visibilityPlaneMask?: number; _inRequestVolume?: boolean;
  _screenSpaceError?: number; refine?: number; hasEmptyContent?: boolean;
  hasRenderableContent?: boolean; hasTilesetContent?: boolean; hasImplicitContent?: boolean;
  commandsLength?: number; contentVisibility?: (frameState: unknown) => number;
  getScreenSpaceError?: (frameState: unknown, useParentGeometricError: boolean) => number;
};
const REPLACE = 1, ADD = 0, RENDER_PASS = 0, MASK_OUTSIDE = 0xffffffff, CONTENT_OUTSIDE = -1;
function frameNumber(scene: Scene): number | undefined {
  const frame = (scene as unknown as FrameScene).frameState?.frameNumber;
  return Number.isFinite(frame) ? frame : undefined;
}
function completeContent(content: Cesium3DTileContent | undefined): boolean {
  if (!content || (content as Cesium3DTileContent & { ready?: boolean }).ready === false) return false;
  const inner = content.innerContents;
  // Multiple3DTileContent filters failed requests out of innerContents before
  // becoming ready. Its remaining mesh cannot cover the missing content.
  const expected = (content as Cesium3DTileContent & { _innerContentHeaders?: unknown[] })._innerContentHeaders;
  if (expected && expected.length !== (inner?.length ?? 0)) return false;
  return !inner?.length || inner.every(completeContent);
}
function missingDeclaredContent(content: Cesium3DTileContent | undefined): boolean {
  if (!content) return false;
  const expected = (content as Cesium3DTileContent & { _innerContentHeaders?: unknown[] })._innerContentHeaders;
  return !!expected && expected.length !== (content.innerContents?.length ?? 0)
    || !!content.innerContents?.some(missingDeclaredContent);
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
  private readonly visibleMeshes = new Set<Cesium3DTile>();
  private renderFrame?: number;
  private renderPass?: number;
  private warning?: string;
  private error?: string;
  private restored = false;

  constructor(readonly sourceId: string, readonly source: Cesium3DTileset, private readonly scene: Scene) {
    assertVideoOverlayOccluder(source);
    loadedMeshes(source);
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
      // Replacement traversal retains the parent mesh until its children are
      // ready. Keep requesting coverage while a video camera is always moving.
      this.replace('skipLevelOfDetail', false);
      this.replace('debugFreezeFrame', false);
      this.replace('cullRequestsWhileMoving', false);
      this.replace('foveatedTimeDelay', 0);
      for (const key of debugFlags) this.replace(key, false);
      this.removers.push(scene.preRender.addEventListener(() => {
        this.renderFrame = frameNumber(scene); this.renderPass = undefined; this.visibleMeshes.clear();
      }));
      const inspect = (tile: Cesium3DTile, visible: boolean) => {
        try {
          const mesh = contentHasMesh(tile.content);
          if (visible && mesh && this.renderFrame !== undefined && this.renderFrame === frameNumber(scene)) {
            const pass = (source as unknown as TraversalSource)._updatedVisibilityFrame;
            if (this.renderPass !== pass) this.visibleMeshes.clear();
            this.renderPass = pass; this.visibleMeshes.add(tile);
          }
        }
        catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      };
      this.removers.push(source.tileLoad.addEventListener(tile => inspect(tile, false)), source.tileVisible.addEventListener(tile => inspect(tile, true)));
      this.removers.push(source.tileFailed.addEventListener(() => {
        // A failed detail request may be offscreen or covered by its parent.
        // Keep traversal running; current-frame coverage decides visibility.
        this.warning = '部分遮挡瓦片加载失败；使用当前可用地表，缺少覆盖时隐藏叠加';
      }));
    } catch (error) { this.restore(); throw error; }
  }

  private replace(key: string, value: unknown) {
    const object = this.source as unknown as Record<string, unknown>;
    this.previous.set(key, object[key]); this.applied.set(key, value); object[key] = value;
  }

  private hasCurrentCoverage(): boolean {
    const source = this.source as unknown as TraversalSource;
    const epoch = source._updatedVisibilityFrame;
    const targetError = source.memoryAdjustedScreenSpaceError;
    if (!this.source.show || this.renderFrame === undefined || this.renderFrame !== frameNumber(this.scene)
      || !Number.isFinite(epoch) || epoch !== this.renderPass || source._pass !== RENDER_PASS
      || !this.visibleMeshes.size) return false;
    const covered = (tile: CoverageTile, parent?: CoverageTile): boolean => {
      if (tile._updatedVisibilityFrame !== epoch || typeof tile._visibilityPlaneMask !== 'number') return false;
      if (tile._visibilityPlaneMask === MASK_OUTSIDE) return true;
      // Outside a viewer request volume is not outside the image: it can leave
      // a genuine hole unless a selected replacement ancestor covers it.
      if (tile._inRequestVolume !== true) return false;
      // Match BaseTraversal's explicit ADD-child SSE cull. A tile can be
      // correctly omitted for the current target detail while its box intersects.
      if (parent?.refine === ADD && !parent.hasTilesetContent && !parent.hasImplicitContent
        && !((tile.hasTilesetContent || tile.hasImplicitContent) && tile.children.length > 0)) {
        const error = tile.getScreenSpaceError?.((this.scene as unknown as FrameScene).frameState, true);
        if (Number.isFinite(error) && Number.isFinite(targetError) && error! <= targetError!) return true;
      }
      if (missingDeclaredContent(tile.content)) return false;
      const mesh = this.visibleMeshes.has(tile) && (tile.commandsLength ?? 0) > 0 && completeContent(tile.content);
      const external = tile.hasTilesetContent || tile.hasImplicitContent;
      if (this.visibleMeshes.has(tile) && !mesh) return false;
      if (mesh && tile.refine === REPLACE && !external) return true;
      if (tile.refine !== REPLACE && tile.refine !== ADD) return false;
      if (tile.refine === ADD && tile.hasRenderableContent && !mesh) return false;
      if (mesh && tile.refine === ADD && !external && Number.isFinite(tile._screenSpaceError)
        && Number.isFinite(targetError) && tile._screenSpaceError! <= targetError!) return true;
      if (!tile.children.length) {
        if (mesh && !external) return true;
        if (tile.hasEmptyContent === true && tile.hasRenderableContent === false && !external) return true;
        // A leaf content bounding box may be outside even when its larger tile
        // box intersects. It has no pixels to cover in this view.
        return !external && contentHasMesh(tile.content)
          && tile.contentVisibility?.((this.scene as unknown as FrameScene).frameState) === CONTENT_OUTSIDE;
      }
      return tile.children.every(child => covered(child as CoverageTile, tile));
    };
    return covered(this.source.root as CoverageTile);
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
      // Pending detail/preload requests are not missing current-view coverage.
      // They inform the UI but must never toggle otherwise valid overlay pixels.
      const statistics = object.statistics as Record<string, number> | undefined;
      const refining = !this.source.tilesLoaded || !!statistics && ['numberOfPendingRequests', 'numberOfTilesProcessing', 'numberOfAttemptedRequests']
        .some(key => statistics[key] > 0);
      return { ...status, ready: this.hasCurrentCoverage(), refining, ...(this.warning ? { warning: this.warning } : {}) };
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
