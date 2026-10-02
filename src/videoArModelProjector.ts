import * as CesiumRuntime from "cesium";
import {
  Camera, Cartesian2, Cartesian3, Cartesian4, Matrix4, PerspectiveFrustum,
  PostProcessStage, PrimitiveCollection, SceneMode, ShadowMap, ShadowMode, type Viewer, type CullingVolume,
} from "cesium";
import { undistortPixel, validateCameraIntrinsics, type CameraIntrinsics, type LensDistortion } from "./videoArCamera";

export type ModelProjectionFrame = Readonly<{
  origin: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  intrinsics: CameraIntrinsics;
  distortion?: LensDistortion;
  maxDistance?: number;
  opacity?: number;
}>;

/** A detached runtime snapshot. Null means unavailable, never an assumed zero. */
export type ModelProjectionDiagnosticState = Readonly<{
  enabled: boolean;
  ready: boolean;
  status: string;
  destroyed: boolean;
  frameConfigured: boolean;
  visibleTilesetCount: number;
  stageEnabled: boolean;
  depth: Readonly<{
    supported: boolean;
    coverageReady: boolean;
    currentFrameDepth: boolean;
    shaderSourceDepthAccepted: boolean;
    textureAvailable: boolean;
    videoTextureAvailable: boolean;
    stageReady: boolean;
    outOfView: boolean | null;
    nativeDepthTexture: boolean | null;
    textureWidth: number | null;
    textureHeight: number | null;
    configuredSize: number | null;
    near: number;
    far: number;
    sourceFrameNumber: number | null;
    currentSceneFrameNumber: number;
    sourceTilesetCount: number;
    sourceCommandCount: number;
    castCommandCount: number;
    visibleTilesetRequests: Readonly<{
      requested: number | null;
      pending: number | null;
      processing: number | null;
    }>;
    sourceError: string | null;
  }>;
  camera: Readonly<{
    originEcef: Readonly<{ x: number; y: number; z: number }>;
    directionEcef: Readonly<{ x: number; y: number; z: number }>;
    upEcef: Readonly<{ x: number; y: number; z: number }>;
    intrinsics: CameraIntrinsics;
    distortion: LensDistortion;
    opacity: number;
    maxDistance: number;
  }> | null;
  settings: Readonly<{
    normalOffset: boolean | null;
    softShadows: boolean | null;
    shadowMapMaximumDistance: number | null;
    depthToleranceMeters: number;
    texelCenterExtrapolationCapMeters: number;
  }>;
}>;

type GpuTexture = { isDestroyed?: () => boolean; width?: number; height?: number };
type ShadowInternals = ShadowMap & {
  fromLightSource: boolean;
  normalOffset: boolean;
  _shadowMapTexture?: GpuTexture;
  _shadowMapMatrix: Matrix4;
  _usesDepthTexture: boolean;
  _outOfView: boolean;
  _boundingSphere: { radius: number };
  destroy(): void;
  isDestroyed(): boolean;
  passes: Array<{ commandList: SourceCommand[] }>;
  updatePass(context: RuntimeContext, pass: number): void;
};
type RuntimeContext = { defaultTexture: GpuTexture; depthTexture: boolean };
type SourceCommand = { pass: number; castShadows?: boolean };
type ShadowFrameState = { shadowMaps: ShadowMap[]; passes: { render?: boolean; pick?: boolean }; mode: SceneMode; frameNumber: number; commandList: SourceCommand[]; camera: Camera; cullingVolume: CullingVolume };
type SourceTilePass = { pass: number; commandList: SourceCommand[]; camera: Camera; cullingVolume: CullingVolume; ready: boolean };
type ShadowTarget = { show?: boolean; shadows: ShadowMode; isCesium3DTileset?: boolean; isDestroyed?: () => boolean; updateForPass?: (frameState: ShadowFrameState, pass: SourceTilePass) => void; _requestedTiles?: unknown[]; _statistics?: { numberOfPendingRequests: number; numberOfTilesProcessing: number } };
type PrimitiveNode = ShadowTarget | PrimitiveCollection;

// Compatibility boundary for Cesium 1.144 / @cesium/engine 26.2.
// ShadowMap's runtime constructor and analytical depth texture are intentionally
// isolated here: they are private Cesium APIs and require the GPU regression
// check whenever Cesium is upgraded. No per-pixel CPU ray picking is used.
const internalPasses = CesiumRuntime as unknown as { Cesium3DTilePass: { SHADOW: number }; Pass: { CESIUM_3D_TILE: number } };
const MODEL_PROJECTION_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D arVideoTexture;
uniform sampler2D arSourceDepth;
uniform mat4 arEyeToSource;
uniform mat4 arEyeToShadow;
uniform vec4 arIntrinsics;
uniform vec2 arImageSize;
uniform vec4 arLens;
uniform float arK3;
uniform vec2 arNearFar;
uniform vec2 arSourceDepthSize;
uniform float arOpacity;
uniform float arHasSourceDepth;
uniform float arNativeDepth;
in vec2 v_textureCoordinates;

float linearSourceDepth(float depth) {
  float nearValue = arNearFar.x;
  float farValue = arNearFar.y;
  return (nearValue * farValue) / (farValue - depth * (farValue - nearValue));
}

void main() {
  vec4 original = texture(colorTexture, v_textureCoordinates);
  out_FragColor = original;
  if (arHasSourceDepth < 0.5) return;
  float sceneDepth = czm_unpackDepth(texture(depthTexture, v_textureCoordinates));
  if (sceneDepth <= 0.0 || sceneDepth >= 1.0) return;
  vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, sceneDepth);
  if (abs(eye.w) < 0.00000001) return;
  eye /= eye.w;
  vec3 source = (arEyeToSource * eye).xyz;
  float distanceToSource = -source.z;
  if (distanceToSource <= arNearFar.x || distanceToSource >= arNearFar.y) return;

  // Match the FIRST visible source-camera surface. A building cannot cast its
  // video pixels onto the ground behind it, or onto another facade behind it.
  vec4 shadowPosition = arEyeToShadow * eye;
  if (shadowPosition.w <= 0.0) return;
  vec3 shadowUv = shadowPosition.xyz / shadowPosition.w;
  if (any(lessThanEqual(shadowUv, vec3(0.0))) || any(greaterThanEqual(shadowUv, vec3(1.0)))) return;
  // Compare depths at the SAME source-shadow texel center. Comparing the
  // fragment's depth directly with a neighboring texel self-occludes oblique
  // roofs and roads, even when both depth buffers describe the same surface.
  // Raw perspective depth is affine across a planar receiver in shadow UV.
  vec3 shadowDx = dFdx(shadowUv);
  vec3 shadowDy = dFdy(shadowUv);
  float determinant = shadowDx.x*shadowDy.y - shadowDx.y*shadowDy.x;
  vec2 texelCenter = (floor(shadowUv.xy*arSourceDepthSize) + vec2(0.5)) / arSourceDepthSize;
  float expectedDistance = distanceToSource;
  if (abs(determinant) > 0.00000000000001) {
    vec2 depthGradient = vec2(
      shadowDy.y*shadowDx.z - shadowDx.y*shadowDy.z,
      shadowDx.x*shadowDy.z - shadowDy.x*shadowDx.z
    ) / determinant;
    float expectedDepth = shadowUv.z + dot(depthGradient, texelCenter-shadowUv.xy);
    if (expectedDepth > 0.0 && expectedDepth < 1.0) {
      float planeDistance = linearSourceDepth(expectedDepth);
      // Do not extrapolate arbitrarily across silhouettes or grazing faces.
      // This cap limits the texel-center correction; it does NOT relax the
      // occlusion tolerance or accept a different front/back surface.
      if (abs(planeDistance-distanceToSource) <= 2.0) expectedDistance = planeDistance;
    }
  }
  vec4 packedSourceDepth = texture(arSourceDepth, texelCenter);
  float sourceDepth = arNativeDepth > 0.5 ? packedSourceDepth.r : czm_unpackDepth(packedSourceDepth);
  if (sourceDepth <= 0.0 || sourceDepth >= 0.9999999) return;
  float surfaceDistance = linearSourceDepth(sourceDepth);
  // Keep a symmetric, bounded metric tolerance. A hidden rear surface and
  // non-caster ground still fail the same first-surface test.
  if (abs(expectedDistance - surfaceDistance) > 0.35) return;

  // Forward Brown-Conrady maps ideal model rays into the original video.
  // The source image is not rectified/rescaled in a separate intermediate pass.
  vec2 ideal = vec2(source.x, -source.y) / distanceToSource;
  float r2 = dot(ideal, ideal);
  if (r2 > 100.0) return;
  float radial = 1.0 + arLens.x*r2 + arLens.y*r2*r2 + arK3*r2*r2*r2;
  vec2 distorted = ideal * radial + vec2(
    2.0*arLens.z*ideal.x*ideal.y + arLens.w*(r2 + 2.0*ideal.x*ideal.x),
    arLens.z*(r2 + 2.0*ideal.y*ideal.y) + 2.0*arLens.w*ideal.x*ideal.y
  );
  vec2 pixel = distorted * arIntrinsics.xy + arIntrinsics.zw;
  vec2 uv = pixel / arImageSize;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return;
  vec4 video = texture(arVideoTexture, vec2(uv.x, 1.0-uv.y));
  out_FragColor = vec4(mix(original.rgb, video.rgb, clamp(arOpacity*video.a, 0.0, 1.0)), original.a);
}
`;

export class VideoArModelProjector {
  private readonly sourceCamera: Camera;
  private readonly sourceFrustum: PerspectiveFrustum;
  private readonly shadow: ShadowInternals;
  private readonly stage: PostProcessStage;
  private readonly context: RuntimeContext;
  private readonly eyeToSource = new Matrix4();
  private readonly intrinsics = new Cartesian4(1, 1, 0, 0);
  private readonly imageSize = new Cartesian2(1, 1);
  private readonly lens = new Cartesian4();
  private readonly nearFar = new Cartesian2(0.5, 2000);
  private readonly sourceDepthSize = new Cartesian2(2048, 2048);
  private readonly changedTargets = new Map<ShadowTarget, ShadowMode>();
  private readonly driver: { show: boolean; update: (state: ShadowFrameState) => void; isDestroyed: () => boolean; destroy: () => void };
  private previousGlobeShadows?: ShadowMode;
  private frame?: ModelProjectionFrame;
  private enabled = false;
  private destroyed = false;
  private readonly sourceCommands: SourceCommand[] = [];
  private sourceCoverageReady = false;
  private sourceTileCount = 0;
  private sourceCastCount = 0;
  private lastSourceFrame = -1;
  private sourceError = "";
  private k3 = 0;
  private opacity = 1;

  constructor(private readonly viewer: Viewer, private readonly getVideoTexture: () => unknown) {
    this.context = (viewer.scene as unknown as { context: RuntimeContext }).context;
    this.sourceCamera = new Camera(viewer.scene);
    this.sourceFrustum = new PerspectiveFrustum({ fov: Math.PI / 2, aspectRatio: 1, near: 0.5, far: 2000 });
    this.sourceCamera.frustum = this.sourceFrustum;
    const ShadowConstructor = ShadowMap as unknown as new (options: object) => ShadowInternals;
    this.shadow = new ShadowConstructor({
      context: this.context, lightCamera: this.sourceCamera, enabled: true,
      fromLightSource: false, isPointLight: false, cascadesEnabled: false,
      normalOffset: false, softShadows: false, size: 2048, maximumDistance: 2000,
    });
    this.installSourceCastPass();
    this.stage = new PostProcessStage({
      name: "video-ar-model-projector-" + crypto.randomUUID(),
      fragmentShader: MODEL_PROJECTION_SHADER,
      uniforms: {
        arVideoTexture: () => this.videoTexture() ?? this.context.defaultTexture,
        arSourceDepth: () => this.shadow._shadowMapTexture ?? this.context.defaultTexture,
        arEyeToSource: () => Matrix4.multiply(this.sourceCamera.viewMatrix, viewer.scene.camera.inverseViewMatrix, this.eyeToSource),
        arEyeToShadow: () => this.shadow._shadowMapMatrix,
        arIntrinsics: () => this.intrinsics,
        arImageSize: () => this.imageSize,
        arLens: () => this.lens,
        arK3: () => this.k3,
        arNearFar: () => this.nearFar,
        arSourceDepthSize: () => {
          this.sourceDepthSize.x = this.shadow._shadowMapTexture?.width ?? this.shadow.size;
          this.sourceDepthSize.y = this.shadow._shadowMapTexture?.height ?? this.shadow.size;
          return this.sourceDepthSize;
        },
        arOpacity: () => this.opacity,
        arHasSourceDepth: () => this.enabled && this.frame && this.videoTexture() && this.shadow._shadowMapTexture && this.hasCurrentSourceDepth() && !this.shadow._outOfView ? 1 : 0,
        arNativeDepth: () => this.shadow._usesDepthTexture ? 1 : 0,
      },
    });
    this.stage.enabled = false;
    viewer.scene.postProcessStages.add(this.stage);
    this.driver = {
      show: true,
      update: state => {
        if (!this.enabled || !this.frame || this.destroyed || state.mode !== SceneMode.SCENE3D || state.passes.pick || !this.videoTexture()) return;
        this.prepareCasters();
        this.lastSourceFrame = state.frameNumber;
        this.sourceCastCount = 0;
        // Cesium otherwise caches the pass camera by its bounding sphere;
        // a roll-only or intrinsic change would reuse stale caster matrices.
        this.shadow._boundingSphere.radius = -1;
        this.updateSourceTiles(state);
        state.shadowMaps.push(this.shadow);
      },
      isDestroyed: () => this.destroyed,
      destroy: () => {
        // removeAll() may detach this driver without calling the outer owner.
        this.enabled = false;
        this.stage.enabled = false;
        this.restoreCasters();
      },
    };
    viewer.scene.primitives.add(this.driver);
  }

  private videoTexture(): GpuTexture | undefined {
    const texture = this.getVideoTexture() as GpuTexture | undefined;
    return texture && !(texture.isDestroyed?.()) ? texture : undefined;
  }

  private hasCurrentSourceDepth(): boolean {
    const frame = (this.viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState;
    return this.sourceCoverageReady && this.sourceCastCount > 0 && this.lastSourceFrame === frame.frameNumber;
  }

  /** Number of currently shown 3D Tiles targets; hidden datasets stay hidden. */
  get visibleTilesetCount(): number {
    let count = 0;
    this.visit(this.viewer.scene.primitives, target => { if (target.isCesium3DTileset) count++; });
    return count;
  }

  get ready(): boolean {
    return !this.destroyed && this.enabled && Boolean(this.frame && this.videoTexture() && this.shadow._shadowMapTexture)
      && this.hasCurrentSourceDepth() && !this.shadow._outOfView && this.stage.ready;
  }

  get status(): string {
    if (this.destroyed) return "三维投影已关闭";
    if (!this.context.depthTexture) return "当前显卡不支持三维深度投影";
    if (!this.enabled) return "三维模型投影未启用";
    if (!this.frame || !this.videoTexture()) return "等待同步视频帧与相机姿态";
    if (!this.visibleTilesetCount) return "没有显示的倾斜摄影图层；仅已加载三维表面可接受投影";
    if (this.sourceError) return this.sourceError;
    if (!this.sourceCoverageReady) return "正在加载视频相机视野内的三维模型；等待遮挡数据完整";
    if (!this.ready) return "正在准备模型深度";
    return "三维模型表面投影 · 屋顶/立面保形 · 源相机遮挡检测";
  }

  /** Inspect the last rendered source pass without enabling targets or requesting a render. */
  getDiagnosticState(): ModelProjectionDiagnosticState {
    const sceneFrame = (this.viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState.frameNumber;
    const videoTextureAvailable = !this.destroyed && Boolean(this.videoTexture());
    const depthTexture = this.destroyed ? undefined : this.shadow._shadowMapTexture;
    const textureAvailable = Boolean(depthTexture && !depthTexture.isDestroyed?.());
    const currentFrameDepth = !this.destroyed && this.hasCurrentSourceDepth();
    let requested: number | null = 0, pending: number | null = 0, processing: number | null = 0;
    this.visit(this.viewer.scene.primitives, target => {
      if (!target.isCesium3DTileset) return;
      requested = requested !== null && target._requestedTiles !== undefined ? requested + target._requestedTiles.length : null;
      pending = pending !== null && Number.isFinite(target._statistics?.numberOfPendingRequests)
        ? pending + target._statistics!.numberOfPendingRequests : null;
      processing = processing !== null && Number.isFinite(target._statistics?.numberOfTilesProcessing)
        ? processing + target._statistics!.numberOfTilesProcessing : null;
    });
    const vector = (value: Cartesian3) => ({ x: value.x, y: value.y, z: value.z });
    return {
      enabled: this.enabled, ready: this.ready, status: this.status, destroyed: this.destroyed,
      frameConfigured: Boolean(this.frame), visibleTilesetCount: this.visibleTilesetCount,
      stageEnabled: !this.destroyed && this.stage.enabled,
      depth: {
        supported: this.context.depthTexture, coverageReady: this.sourceCoverageReady,
        currentFrameDepth,
        shaderSourceDepthAccepted: this.enabled && Boolean(this.frame) && videoTextureAvailable
          && textureAvailable && currentFrameDepth && !this.shadow._outOfView,
        textureAvailable, videoTextureAvailable, stageReady: !this.destroyed && this.stage.ready,
        outOfView: this.destroyed ? null : this.shadow._outOfView,
        nativeDepthTexture: this.destroyed ? null : this.shadow._usesDepthTexture,
        textureWidth: textureAvailable ? depthTexture?.width ?? null : null,
        textureHeight: textureAvailable ? depthTexture?.height ?? null : null,
        configuredSize: this.destroyed ? null : this.shadow.size,
        near: this.nearFar.x, far: this.nearFar.y,
        sourceFrameNumber: this.lastSourceFrame < 0 ? null : this.lastSourceFrame,
        currentSceneFrameNumber: sceneFrame,
        sourceTilesetCount: this.sourceTileCount, sourceCommandCount: this.sourceCommands.length,
        castCommandCount: this.sourceCastCount,
        visibleTilesetRequests: { requested, pending, processing }, sourceError: this.sourceError || null,
      },
      // Read the applied uniforms and orthonormal camera basis, not caller-owned frame objects.
      camera: this.frame ? {
        originEcef: vector(this.sourceCamera.position), directionEcef: vector(this.sourceCamera.direction),
        upEcef: vector(this.sourceCamera.up),
        intrinsics: { width: this.imageSize.x, height: this.imageSize.y, fx: this.intrinsics.x,
          fy: this.intrinsics.y, cx: this.intrinsics.z, cy: this.intrinsics.w },
        distortion: { k1: this.lens.x, k2: this.lens.y, k3: this.k3, p1: this.lens.z, p2: this.lens.w },
        opacity: this.opacity, maxDistance: this.nearFar.y,
      } : null,
      settings: {
        normalOffset: this.destroyed ? null : this.shadow.normalOffset,
        softShadows: this.destroyed ? null : this.shadow.softShadows,
        shadowMapMaximumDistance: this.destroyed ? null : this.shadow.maximumDistance,
        // The second value caps planar texel-center extrapolation; it is not a depth tolerance.
        depthToleranceMeters: 0.35, texelCenterExtrapolationCapMeters: 2,
      },
    };
  }

  setFrame(frame: ModelProjectionFrame): void {
    if (this.destroyed) return;
    validateCameraIntrinsics(frame.intrinsics);
    for (const vector of [frame.origin, frame.direction, frame.up]) {
      if (![vector.x, vector.y, vector.z].every(Number.isFinite)) throw new Error("投影相机包含无效位置或姿态");
    }
    if (Cartesian3.magnitudeSquared(frame.direction) < 1e-12 || Cartesian3.magnitudeSquared(frame.up) < 1e-12) {
      throw new Error("投影相机方向无效");
    }
    const direction = Cartesian3.normalize(frame.direction, new Cartesian3());
    const right = Cartesian3.cross(direction, frame.up, new Cartesian3());
    if (Cartesian3.magnitudeSquared(right) < 1e-12) throw new Error("投影相机方向与上方向重合");
    Cartesian3.normalize(right, right);
    const up = Cartesian3.normalize(Cartesian3.cross(right, direction, new Cartesian3()), new Cartesian3());
    const distortion = frame.distortion ?? {};
    if (!Object.values(distortion).every(Number.isFinite)) throw new Error("镜头畸变系数无效");
    // Conservative undistorted image bounds. A symmetric depth camera is used
    // only for visibility; image placement uses the exact fx/fy/cx/cy below.
    let horizontal = 0, vertical = 0;
    for (let row = 0; row <= 4; row++) {
      for (let col = 0; col <= 4; col++) {
        const point = undistortPixel(frame.intrinsics, frame.intrinsics.width * col / 4, frame.intrinsics.height * row / 4, distortion);
        horizontal = Math.max(horizontal, Math.abs(point.x));
        vertical = Math.max(vertical, Math.abs(point.y));
      }
    }
    horizontal = Math.max(0.01, horizontal * 1.05);
    vertical = Math.max(0.01, vertical * 1.05);
    this.sourceFrustum.aspectRatio = horizontal / vertical;
    this.sourceFrustum.fov = 2 * Math.atan(Math.max(horizontal, vertical));
    this.sourceFrustum.far = Math.min(10_000, Math.max(10, frame.maxDistance ?? 2000));
    this.nearFar.y = this.sourceFrustum.far;
    Cartesian3.clone(frame.origin, this.sourceCamera.position);
    Cartesian3.clone(direction, this.sourceCamera.direction);
    Cartesian3.clone(up, this.sourceCamera.up);
    Cartesian3.clone(right, this.sourceCamera.right);
    const { width, height, fx, fy, cx, cy } = frame.intrinsics;
    this.intrinsics.x = fx; this.intrinsics.y = fy; this.intrinsics.z = cx; this.intrinsics.w = cy;
    this.imageSize.x = width; this.imageSize.y = height;
    this.lens.x = distortion.k1 ?? 0; this.lens.y = distortion.k2 ?? 0;
    this.lens.z = distortion.p1 ?? 0; this.lens.w = distortion.p2 ?? 0;
    this.k3 = distortion.k3 ?? 0;
    this.opacity = Math.min(1, Math.max(0, frame.opacity ?? 1));
    this.frame = frame;
    this.sourceCoverageReady = false;
    this.viewer.scene.requestRender();
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed) return;
    this.enabled = enabled && this.context.depthTexture && this.viewer.scene.mode === SceneMode.SCENE3D;
    this.stage.enabled = this.enabled;
    if (this.enabled) {
      if (!this.viewer.scene.primitives.contains(this.driver)) this.viewer.scene.primitives.add(this.driver);
      this.prepareCasters();
    }
    else this.restoreCasters();
    this.viewer.scene.requestRender();
  }

  private installSourceCastPass(): void {
    const clearPass = this.shadow.updatePass.bind(this.shadow);
    this.shadow.updatePass = (context, passIndex) => {
      clearPass(context, passIndex);
      const commands = this.shadow.passes[passIndex].commandList;
      if (this.sourceTileCount) {
        // The ordinary scene command list contains VIEWER-selected tile LODs.
        // Replace these in this shadow pass with VIDEO-camera selected tiles.
        // Keep the main color command list untouched (no duplicate tile draw).
        let write = 0;
        for (const command of commands) {
          if (command.pass !== internalPasses.Pass.CESIUM_3D_TILE) commands[write++] = command;
        }
        commands.length = write;
      }
      const scene = this.viewer.scene as unknown as { updateDerivedCommands(command: SourceCommand): void };
      const seen = new Set(commands);
      for (const command of this.sourceCommands) {
        if (!command.castShadows || seen.has(command)) continue;
        scene.updateDerivedCommands(command);
        commands.push(command);
        seen.add(command);
      }
      this.sourceCastCount = commands.length;
    };
  }

  private updateSourceTiles(state: ShadowFrameState): void {
    this.sourceCommands.length = 0;
    this.sourceTileCount = 0;
    this.sourceCoverageReady = true;
    this.sourceError = "";
    const sourceCulling = this.sourceFrustum.computeCullingVolume(
      this.sourceCamera.positionWC, this.sourceCamera.directionWC, this.sourceCamera.upWC,
    );
    this.visit(this.viewer.scene.primitives, target => {
      if (!target.isCesium3DTileset) return;
      this.sourceTileCount++;
      if (!target.updateForPass) {
        this.sourceCoverageReady = false;
        this.sourceError = "当前 Cesium 版本不支持独立视频相机模型通道";
        return;
      }
      const pass: SourceTilePass = {
        pass: internalPasses.Cesium3DTilePass.SHADOW, commandList: this.sourceCommands,
        camera: this.sourceCamera, cullingVolume: sourceCulling, ready: false,
      };
      const previousCamera = state.camera;
      const previousCulling = state.cullingVolume;
      const previousCommands = state.commandList;
      try {
        target.updateForPass(state, pass);
        // The ordinary SHADOW traversal does not return pass.ready in this
        // Cesium version. Wait conservatively for source requests and all
        // in-flight processing; a fallback parent mesh must not hide holes.
        const statistics = target._statistics;
        const settled = target._requestedTiles !== undefined && target._requestedTiles.length === 0
          && statistics !== undefined && statistics.numberOfPendingRequests === 0 && statistics.numberOfTilesProcessing === 0;
        this.sourceCoverageReady = this.sourceCoverageReady && settled;
      } catch {
        this.sourceCoverageReady = false;
        this.sourceError = "源相机三维模型加载失败；已暂停投影以防遮挡错误";
      } finally {
        // Cesium's private updateForPass normally restores these; guard throws.
        state.camera = previousCamera;
        state.cullingVolume = previousCulling;
        state.commandList = previousCommands;
      }
    });
  }

  private visit(collection: PrimitiveCollection, visitor: (target: ShadowTarget) => void): void {
    for (let index = 0; index < collection.length; index++) {
      const primitive = collection.get(index) as PrimitiveNode;
      if (!primitive || primitive.show === false) continue;
      if (primitive instanceof PrimitiveCollection) this.visit(primitive, visitor);
      else if ("shadows" in primitive) visitor(primitive);
    }
  }

  private prepareCasters(): void {
    // Globe depth must not impersonate a building surface if a model is absent.
    // Preserve an existing sunlight setting while temporarily removing globe cast.
    const globe = this.viewer.scene.globe;
    if (this.previousGlobeShadows === undefined) this.previousGlobeShadows = globe.shadows;
    if (globe.shadows === ShadowMode.ENABLED || globe.shadows === ShadowMode.CAST_ONLY) globe.shadows = ShadowMode.RECEIVE_ONLY;
    this.visit(this.viewer.scene.primitives, target => {
      if (!target.isCesium3DTileset) return;
      if (!this.changedTargets.has(target)) this.changedTargets.set(target, target.shadows);
      if (target.shadows === ShadowMode.DISABLED) target.shadows = ShadowMode.CAST_ONLY;
      else if (target.shadows === ShadowMode.RECEIVE_ONLY) target.shadows = ShadowMode.ENABLED;
    });
  }

  private restoreCasters(): void {
    for (const [target, previous] of this.changedTargets) {
      if (!target.isDestroyed?.()) {
        const expected = previous === ShadowMode.DISABLED ? ShadowMode.CAST_ONLY : previous === ShadowMode.RECEIVE_ONLY ? ShadowMode.ENABLED : previous;
        if (target.shadows === expected) target.shadows = previous;
      }
    }
    this.changedTargets.clear();
    if (this.previousGlobeShadows !== undefined) {
      const globe = this.viewer.scene.globe;
      if (globe.shadows === ShadowMode.RECEIVE_ONLY) globe.shadows = this.previousGlobeShadows;
      this.previousGlobeShadows = undefined;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.enabled = false;
    this.stage.enabled = false;
    this.restoreCasters();
    this.viewer.scene.primitives.remove(this.driver);
    this.viewer.scene.postProcessStages.remove(this.stage);
    if (!this.shadow.isDestroyed()) this.shadow.destroy();
    this.destroyed = true;
    this.viewer.scene.requestRender();
  }
}
