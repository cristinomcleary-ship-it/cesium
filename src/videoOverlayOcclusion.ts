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

// These traversal fields are deliberately isolated to the pinned Cesium 1.144 /
// engine 26.2 adapter. Missing fields fail closed rather than accepting old-view
// geometry. Frame numbers and visibility epochs have different lifetimes.
type FrameScene = { frameState?: { frameNumber?: number } };
type TraversalSource = { _updatedVisibilityFrame?: number; _pass?: number; memoryAdjustedScreenSpaceError?: number };
type CoverageTile = Cesium3DTile & {
  _updatedVisibilityFrame?: number; _visibilityPlaneMask?: number; _inRequestVolume?: boolean;
  _screenSpaceError?: number; _visible?: boolean; _visitedFrame?: number; refine?: number; hasEmptyContent?: boolean;
  hasRenderableContent?: boolean; hasTilesetContent?: boolean; hasImplicitContent?: boolean;
  commandsLength?: number; contentVisibility?: (frameState: unknown) => number;
  getScreenSpaceError?: (frameState: unknown, useParentGeometricError: boolean, progressiveResolutionHeightFraction?: number) => number;
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

/** Tracks current-view geometry and advances visited empty routing nodes that supply no coarse depth. */
export class VideoOverlayTileCoverage {
  private readonly removers: Array<() => void> = [];
  private readonly visibleMeshes = new Set<Cesium3DTile>();
  private readonly emptyRefinements = new Map<CoverageTile, { descriptor?: PropertyDescriptor; applied: NonNullable<CoverageTile['getScreenSpaceError']> }>();
  private renderFrame?: number;
  private renderPass?: number;
  private initialVisibilityEpoch?: number;
  private coverageCache?: { frame: number; pass: number; commands: number; ready: boolean };
  private restored = false;

  constructor(private readonly source: Cesium3DTileset, private readonly scene: Scene, private readonly requireVisibleCoverage = true) {
    this.removers.push(scene.preRender.addEventListener(() => {
      this.renderFrame = frameNumber(scene); this.renderPass = undefined;
      this.initialVisibilityEpoch = (source as unknown as TraversalSource)._updatedVisibilityFrame;
      this.visibleMeshes.clear(); this.coverageCache = undefined;
    }));
    this.removers.push(source.tileVisible.addEventListener(tile => {
      this.coverageCache = undefined;
      if (contentHasDrawableGeometry(tile.content) && this.renderFrame !== undefined && this.renderFrame === frameNumber(scene)) {
        const pass = (source as unknown as TraversalSource)._updatedVisibilityFrame;
        if (this.renderPass !== pass) this.visibleMeshes.clear();
        this.renderPass = pass; this.visibleMeshes.add(tile);
      }
    }));
  }

  invalidate() { this.coverageCache = undefined; }

  private refineEmptyRoutingTile(tile: CoverageTile, targetError: number | undefined): void {
    // BaseTraversal may stop at a low-SSE empty tile even though it has children.
    // It supplies no coarse depth mesh, so advance just this visited routing node
    // and continue requiring actual descendant draw commands before reporting ready.
    if (tile.hasEmptyContent !== true || tile.hasRenderableContent !== false || !tile.children.length
      || tile.hasTilesetContent || tile.hasImplicitContent || tile._visible !== true
      || tile._visitedFrame !== this.renderFrame || !Number.isFinite(tile._screenSpaceError)
      || !Number.isFinite(targetError) || tile._screenSpaceError! > targetError! || this.emptyRefinements.has(tile)) return;
    const original = tile.getScreenSpaceError;
    if (typeof original !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(tile, 'getScreenSpaceError');
    if (descriptor && (!('value' in descriptor) || !descriptor.configurable && !descriptor.writable)
      || !descriptor && !Object.isExtensible(tile)) return;
    const source = this.source as unknown as TraversalSource;
    const applied: typeof original = function (this: CoverageTile, frameState, useParent, fraction) {
      const error = original.call(this, frameState, useParent, fraction);
      const target = source.memoryAdjustedScreenSpaceError;
      return !useParent && fraction === undefined && Number.isFinite(error) && Number.isFinite(target)
        ? Math.max(error, target! + 1) : error;
    };
    Object.defineProperty(tile, 'getScreenSpaceError', descriptor ? { ...descriptor, value: applied }
      : { value: applied, configurable: true, writable: true, enumerable: false });
    this.emptyRefinements.set(tile, { descriptor, applied });
    this.scene.requestRender();
  }

  private refineVisitedEmptyBranches(tile: CoverageTile, epoch: number, targetError: number | undefined): void {
    if (tile._updatedVisibilityFrame !== epoch || tile._visitedFrame !== this.renderFrame
      || tile._visible !== true || tile._inRequestVolume !== true
      || typeof tile._visibilityPlaneMask !== 'number' || tile._visibilityPlaneMask === MASK_OUTSIDE) return;
    this.refineEmptyRoutingTile(tile, targetError);
    for (const child of tile.children) this.refineVisitedEmptyBranches(child as CoverageTile, epoch, targetError);
  }

  isReady(): boolean {
    if (this.restored || this.source.isDestroyed()) return false;
    const source = this.source as unknown as TraversalSource;
    const epoch = source._updatedVisibilityFrame;
    const targetError = source.memoryAdjustedScreenSpaceError;
    if (!this.source.show || this.renderFrame === undefined || this.renderFrame !== frameNumber(this.scene)
      || !Number.isFinite(epoch) || source._pass !== RENDER_PASS) return false;
    if (epoch !== this.renderPass || !this.visibleMeshes.size) {
      // An empty-only current traversal can request descendants, never certify depth.
      if (!this.visibleMeshes.size && Number.isFinite(this.initialVisibilityEpoch) && epoch !== this.initialVisibilityEpoch) {
        this.refineVisitedEmptyBranches(this.source.root as CoverageTile, epoch!, targetError);
      }
      if (this.requireVisibleCoverage || this.visibleMeshes.size > 0 || epoch === this.initialVisibilityEpoch) return false;
    }
    // Cesium clears this counter at traversal start and sets it only after all
    // selected tiles have submitted commands. Never cache inside tileVisible,
    // which fires before tile.update; uniforms and postRender can safely reuse
    // the same completed traversal without walking the hierarchy again.
    const commands = (this.source as unknown as { statistics?: { numberOfCommands?: number } }).statistics?.numberOfCommands;
    const cacheable = typeof commands === 'number' && commands > 0;
    const cached = this.coverageCache;
    if (cacheable && cached?.frame === this.renderFrame && cached.pass === epoch && cached.commands === commands) return cached.ready;
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
      if (!mesh && !external) this.refineEmptyRoutingTile(tile, targetError);
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
        return !external && contentHasDrawableGeometry(tile.content)
          && tile.contentVisibility?.((this.scene as unknown as FrameScene).frameState) === CONTENT_OUTSIDE;
      }
      return tile.children.every(child => covered(child as CoverageTile, tile));
    };
    const ready = covered(this.source.root as CoverageTile);
    if (cacheable) this.coverageCache = { frame: this.renderFrame, pass: epoch!, commands, ready };
    return ready;
  }


  restore() {
    if (this.restored) return;
    this.restored = true;
    for (const remove of this.removers.splice(0)) { try { remove(); } catch { /* Continue releasing the remaining listeners. */ } }
    this.visibleMeshes.clear(); this.coverageCache = undefined;
    for (const [tile, { descriptor, applied }] of this.emptyRefinements) {
      try {
        if (tile.getScreenSpaceError !== applied) continue;
        if (descriptor) Object.defineProperty(tile, 'getScreenSpaceError', descriptor);
        else delete tile.getScreenSpaceError;
      } catch { /* Continue releasing other tile method owners. */ }
    }
    this.emptyRefinements.clear();
    this.renderFrame = this.renderPass = this.initialVisibilityEpoch = undefined;
  }
}

function contentHasDrawableGeometry(content: Cesium3DTileContent | undefined): boolean {
  if (!content || (content as Cesium3DTileContent & { ready?: boolean }).ready === false) return false;
  if (content.innerContents?.length) return content.innerContents.some(contentHasDrawableGeometry);
  return content.trianglesLength > 0 || content.pointsLength > 0 || content.geometryByteLength > 0;
}

/** Owns only temporary material state; it never changes positioning or map visibility. */
export class VideoOverlayOcclusion {
  private readonly shader: CustomShader;
  private readonly previous = new Map<string, unknown>();
  private readonly applied = new Map<string, unknown>();
  private readonly removers: Array<() => void> = [];
  private coverage?: VideoOverlayTileCoverage;
  private warning?: string;
  private error?: string;
  private restored = false;

  constructor(readonly sourceId: string, readonly source: Cesium3DTileset, private readonly scene: Scene) {
    assertVideoOverlayOccluder(source);
    // Do not traverse the entire cached hierarchy on entry. The root is cheap
    // to inspect; loaded and visible descendants are checked by their events
    // before they can contribute to the current frame's coverage.
    contentHasMesh(source.root.content);
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
      // Retain the user's full geometry detail. Readiness and complete-frame
      // presentation handle slow views without reducing source or depth quality.
      if (typeof source.foveatedScreenSpaceError === 'boolean') this.replace('foveatedScreenSpaceError', false);
      if (typeof source.preloadWhenHidden === 'boolean') this.replace('preloadWhenHidden', false);
      for (const key of debugFlags) this.replace(key, false);
      this.coverage = new VideoOverlayTileCoverage(source, scene);
      const inspect = (tile: Cesium3DTile) => {
        this.coverage?.invalidate();
        try { contentHasMesh(tile.content); }
        catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      };
      this.removers.push(source.tileLoad.addEventListener(inspect), source.tileVisible.addEventListener(inspect));
      this.removers.push(source.tileFailed.addEventListener(() => {
        this.coverage?.invalidate();
        // A failed detail request may be offscreen or covered by its parent.
        // Keep traversal running; current-frame coverage decides visibility.
        this.warning = '部分遮挡瓦片加载失败；使用当前可用地表，缺少覆盖时隐藏叠加';
      }));
    } catch (error) { this.restore(); throw error; }
  }

  private replace(key: string, value: unknown) {
    const object = this.source as unknown as Record<string, unknown>;
    this.previous.set(key, object[key]); this.applied.set(key, value);
    if (object[key] !== value) object[key] = value;
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
      return { ...status, ready: this.coverage?.isReady() ?? false, refining, ...(this.warning ? { warning: this.warning } : {}) };
    } catch (error) { return { ...status, error: error instanceof Error ? error.message : String(error) }; }
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    // A stale owner or a deleted scene must not strand the other callbacks or
    // the AR shader. Restore each independently and always clear our references.
    for (const remove of this.removers.splice(0)) { try { remove(); } catch { /* A removed event must not stop the remaining cleanup. */ } }
    this.coverage?.restore(); this.coverage = undefined;
    try {
      if (!this.source.isDestroyed()) {
        const object = this.source as unknown as Record<string, unknown>;
        // Each property has independent ownership. Preserve a new shader/style
        // owner while still restoring debug/point-cloud state left in our care.
        for (const [key, value] of this.previous) {
          try {
            if (object[key] === this.applied.get(key)) {
              // A temporary depth role must not revive a shader released by
              // its original owner while that role was active.
              const restored = key === 'customShader' && (value as CustomShader | undefined)?.isDestroyed() ? undefined : value;
              if (object[key] !== restored) object[key] = restored;
            }
          }
          catch { /* Continue restoring other properties after a failed setter. */ }
        }
        // Only schedules eviction. Cesium keeps the next map frame's selected
        // tiles and releases the unused video-route GPU cache in its render loop.
        try { this.source.trimLoadedTiles(); } catch { /* Host may have removed the source during exit. */ }
      }
    } catch { /* A destroyed source must not strand the shader or scene cleanup. */ }
    finally {
      this.previous.clear(); this.applied.clear();
      try { if (!this.shader.isDestroyed()) this.shader.destroy(); } catch { /* Already disposed by the host. */ }
      try { this.scene.requestRender(); } catch { /* The entire viewer may already be gone. */ }
    }
  }
}
