export type SavedReplaySettings = { flight: string; framePaths: Record<string, string[]>; controls: Record<string, string | boolean>; calibrationSessions?: ControlPointSession[] };
export type SavedReplay = { name: string; settings: SavedReplaySettings; files: Record<string, File> };
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ComponentDatatype,
  ConstantPositionProperty,
  ConstantProperty,
  CustomDataSource,
  EllipsoidTerrainProvider,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  HeadingPitchRange,
  IntersectionTests,
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  Matrix4,
  NearFarScalar,
  Primitive,
  PrimitiveType,
  Ray,
  Transforms,
  type Viewer,
} from "cesium";
import "./videoArFusion.css";
import { VideoArModelProjector, type ModelProjectionDiagnosticMode, type ModelProjectionFrame } from "./videoArModelProjector";
import { VideoArControlPointPicker, type ControlPointFrame } from "./videoArControlPointPicker";
import type { ControlPointSession } from "./videoArControlPointSession";
import { resolveCameraFrame, cameraFrameRay, cameraMatchesTexture, type ResolvedCameraFrame } from "./videoArCameraFrame";
import { resolveDjiHeight, type DjiHeightMode } from "./videoArHeight";
import { videoMediaTimeMs, textureFrameIdentity, sameTextureFrame, type TextureFrameIdentity } from "./videoArTextureFrame";
import {
  geoFootprintCorners,
  matchGeoFootprint,
  matchGeoProjectionMesh,
  parseGeoFootprint,
  parseGeoFootprintCollection,
  parseGeoProjectionMesh,
  type GeoCorner,
  type GeoFootprint,
  type GeoFootprintCollection,
  type GeoProjectionMesh,
  type GeoProjectionMeshCollection,
  type GeoProjectionVideoIdentity,
} from "./videoArGeoreference";
import { buildProjectiveGrid } from "./videoArProjection";
import { cameraPixelToEnuDirection, cameraDirectionToEnu, type CameraIntrinsics, type LensDistortion, type CameraAttitude } from "./videoArCamera";
import { buildRaySurfaceGrid } from "./videoArSurface";
import { VIDEO_AR_VERTEX_SHADER, VIDEO_AR_FRAGMENT_SHADER } from "./videoArShaders";

type Notify = (message: string, error?: boolean) => void;

type Attitude = {
  heading: number;
  pitch: number;
  roll: number;
};

type GimbalAttitude = {
  yaw: number;
  pitch: number;
  roll: number;
};

type DjiSrtDataset = {
  sourceVideoFile: string;
  videoWidth: number;
  videoHeight: number;
  videoFrameCount: number;
  videoDurationMs: number;
  videoFrameRateFps: number;
  videoSizeBytes: number;
};

type DjiSrtPoseProjection = {
  dataset: DjiSrtDataset;
  videoSampleIndex: number;
  videoTimeMs: number;
  relativeAltitudeMeters: number;
  horizontalFovDegrees: number;
  verticalFovDegrees: number;
  fxPx: number;
  fyPx: number;
  cxPx: number;
  cyPx: number;
  quality: "estimated_not_calibrated";
};

type FlightPoint = {
  timestampMs: number;
  /** Unmodified source wall clock; never substituted for media PTS. */
  recordedAt?: string;
  longitude: number;
  latitude: number;
  altitude: number;
  relativeAltitude?: number;
  groundAltitude?: number;
  attitude: Attitude;
  gimbal: GimbalAttitude;
  videoFrame?: string;
  videoFrameTimestampMs?: number;
  videoFrameTimeDeltaMs?: number;
  videoSampleIndex?: number;
  videoTimeMs?: number;
  groundFootprint?: GeoFootprint;
  projectionMesh?: GeoProjectionMesh;
  djiSrtPoseProjection?: DjiSrtPoseProjection;
};

type ParsedTrajectoryMetadata = {
  /** Trusted root-level video identity, independent of per-frame pose validity. */
  readonly sourceVideoDataset?: DjiSrtDataset;
  readonly embeddedFootprints: GeoFootprintCollection;
};

const trajectoryMetadata = new WeakMap<FlightPoint[], ParsedTrajectoryMetadata>();

type ZipEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

type LiveState = {
  longitude: number;
  latitude: number;
  altitude: number;
  attitude: Attitude;
  gimbal: GimbalAttitude;
};

type LivePoseSample = {
  timestampMs: number;
  state: LiveState;
};

type ProjectionSource = "none" | "zip-frames" | "directory-frames" | "independent-video" | "live";

type CameraRayModel = { intrinsics: CameraIntrinsics; distortion: LensDistortion; aircraft?: CameraAttitude };

type EffectiveCameraState = ResolvedCameraFrame;

type ProjectionSurface = {
  readonly positions: readonly Cartesian3[];
  readonly textureCoordinates?: Float32Array;
  readonly textureWeights?: Float32Array;
  readonly indices?: Uint16Array;
  readonly boundingSphere?: BoundingSphere;
  readonly sourceTopFraction: number;
  readonly kind: "projective-quad" | "wgs84-control-mesh" | "camera-ray-mesh";
};

type ReusableMaterialTexture = {
  readonly width?: number;
  readonly height?: number;
  _width?: number;
  _height?: number;
  copyFrom: (options: { source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap }) => void;
  isDestroyed?: () => boolean;
};

type MaterialTextureInternals = Material & {
  _textures?: Record<string, ReusableMaterialTexture | undefined>;
  _defaultTexture?: ReusableMaterialTexture;
  _texturePaths?: Record<string, unknown>;
  _loadedImages?: Array<{ id: string; image: unknown }>;
  update?: (context: unknown) => void;
};

type ParsedGeoreferenceSidecar = {
  footprints: GeoFootprintCollection;
  meshes: GeoProjectionMeshCollection;
  kind: {
    schemaVersion: string;
    hasTelemetry: boolean;
    hasTrajectoryPoints: boolean;
  };
};

const MAX_ZIP_ENTRIES = 20_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TRAJECTORY_POINTS = 100_000;
const MAX_TRAJECTORY_RENDER_POINTS = 5_000;
const MAX_LIVE_TRAJECTORY_POINTS = 5_000;
const MAX_TEXTURE_EDGE = 1024;
const MAX_PREVIEW_EDGE = 480;
const MAX_GROUND_PROJECTION_DISTANCE = 50_000;
const MAX_FRAME_POSE_DELTA_MS = 1_500;
const MAX_MESH_FRAME_DELTA_MS = 50;
const MAX_MESH_PLAYBACK_HOLD_MS = 50;
const MAX_DJI_SRT_POSE_GAP_MS = 250;
const SURFACE_LIFT_METERS = 0.15;
const MESH_CAMERA_BIAS_METERS = 0.08;
const PROJECTION_POSITION_EPSILON_METERS = 0.5;
const MAX_CONTINUOUS_GEOMETRY_FPS = 4;
const LIVE_POSE_HISTORY_MS = 5_000;
const MAX_ATOMIC_FOOTPRINT_DRIFT_METERS = 1;
const PROJECTION_GRID_COLUMNS = 24;
const PROJECTION_GRID_ROWS = 18;
const MAX_DJI_SOURCE_TOP_CROP = 0.35;
const DJI_SOURCE_CROP_STEPS = 28;
const MAX_DJI_PROJECTION_RANGE_FACTOR = 6;
const MIN_DJI_DOWNWARD_DOT = 0.12;
const CAMERA_RESUME_DELAY_MS = 160;
const MAX_GEOREFERENCE_FILE_BYTES = 64 * 1024 * 1024;

function parseGeoreferenceSidecarOffMainThread(buffer: ArrayBuffer) {
  type Response = ({ ok: true } & ParsedGeoreferenceSidecar) | { ok: false; error: string };
  return new Promise<ParsedGeoreferenceSidecar>((resolve, reject) => {
    const worker = new Worker(new URL("./videoArGeoreference.worker.ts", import.meta.url), { type: "module" });
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("三维配准文件解析超时；请减小单个分块"));
    }, 30_000);
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<Response>) => {
      finish();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "三维配准 Worker 启动失败"));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("三维配准 Worker 返回了无法读取的数据"));
    };
    worker.postMessage({ buffer }, [buffer]);
  });
}

export const videoArFusionPanelHtml = `
  <section class="panel video-ar-panel" data-panel="videoar">
    <div class="video-ar-intro">
      <small>VIDEO · TELEMETRY · TERRAIN</small>
      <strong>无人机视频 AR 融合</strong>
      <p>将飞行位置、机体/云台姿态和视频帧同步投影到 Cesium 地形。数据仅在本机读取。</p>
    </div>

    <label class="video-ar-file-button">
      <span>选择飞行数据 ZIP</span>
      <input id="videoArZipFile" type="file" accept=".zip,application/zip" hidden />
    </label>
    <div id="videoArZipSelection" class="video-ar-selection">支持直接选择“飞行轨迹回放数据.zip”，无需解压</div>
    <label id="videoArFlightField" class="hidden">ZIP 内飞行记录<select id="videoArFlightSelect"></select></label>

    <details class="video-ar-source-details">
      <summary>独立 JSON / 视频 / 图片目录</summary>
      <label class="video-ar-file-button secondary-file">
        <span>选择轨迹 JSON（提取器输出的 *_Cesium轨迹*.json）</span>
        <input id="videoArTrajectoryFile" type="file" accept=".json,application/json" hidden />
      </label>
      <div id="videoArTrajectorySelection" class="video-ar-selection">不要选择 *_全部元数据*.json</div>
      <label class="video-ar-file-button secondary-file">
        <span>选择视频（可选）</span>
        <input id="videoArVideoFile" type="file" accept="video/mp4,video/webm,video/quicktime,video/*" hidden />
      </label>
      <div id="videoArVideoSelection" class="video-ar-selection">也可使用轨迹中的逐帧图片</div>
      <label class="video-ar-file-button secondary-file">
        <span>选择图片目录（可选）</span>
        <input id="videoArFramesDirectory" type="file" accept="image/jpeg,image/png,image/webp" webkitdirectory multiple hidden />
      </label>
      <div id="videoArFramesSelection" class="video-ar-selection">选择包含 video_frames 的目录</div>
      <label class="video-ar-file-button secondary-file">
        <span>选择逐帧三维控制网格 / WGS84 四角（可留空）</span>
        <input id="videoArGeoreferenceFile" type="file" accept=".json,application/json" hidden />
      </label>
      <div class="video-ar-selection-row">
        <div id="videoArGeoreferenceSelection" class="video-ar-selection">优先 EPSG:4979 可见表面网格；兼容每帧 TL/TR/BR/BL 四角</div>
        <button id="videoArClearGeoreference" class="video-ar-inline-clear" type="button">清除配准文件</button>
      </div>
      <p class="hint">高楼必须使用含椭球高和显式 triangles 的可见表面网格；仅加密同一地面平面不能修复视差。</p>
    </details>

    <div class="field-grid video-ar-fields">
      <label>水平视场角（普通轨迹）<input id="videoArHfov" type="number" min="1" max="179" step="0.1" value="84" /></label>
      <label>垂直视场角（普通轨迹）<input id="videoArVfov" type="number" min="1" max="179" step="0.1" value="53" /></label>
      <label>高程校正（米）<input id="videoArHeightOffset" type="number" step="0.1" value="0" /></label>
      <label>数据地表高程（普通轨迹）<input id="videoArGroundHeight" type="number" step="0.1" placeholder="自动：轨迹低位高程" /></label>
      <label>视锥诊断距离<input id="videoArFallbackDistance" type="number" min="1" max="5000" step="1" value="60" /></label>
      <label>纹理刷新上限<select id="videoArFps"><option value="8">8 FPS（低配）</option><option value="12" selected>12 FPS（推荐）</option><option value="18">18 FPS</option></select></label>
      <label>播放速度<select id="videoArSpeed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
    </div>
    <details class="video-ar-source-details video-ar-calibration">
      <summary>投影配准校正（位置 / 镜头 / 高程）</summary>
      <p id="videoArCalibrationState" class="hint"></p>
      <label class="check-label"><input id="videoArEnableCalibration" type="checkbox" /> 启用 DJI 手动校准</label>
      <p class="hint">先暂停在清晰的一帧，对照道路交叉口或地面标志调整。勾选后校正才作用于 DJI 估算；实测四角和三维控制网格仍使用原配准。</p>
      <div class="field-grid video-ar-fields">
        <label>方位校正（度）<input id="videoArYawCorrection" type="number" min="-180" max="180" step="0.1" value="0" /></label>
        <label>俯仰校正（度）<input id="videoArPitchCorrection" type="number" min="-45" max="45" step="0.1" value="0" /></label>
        <label>横滚校正（度）<input id="videoArRollCorrection" type="number" min="-45" max="45" step="0.1" value="0" /></label>
        <label>画幅比例<input id="videoArFootprintScale" type="number" min="0.1" max="5" step="0.01" value="1" /></label>
        <label>视频时间校正（秒）<input id="videoArTimeOffset" type="number" min="-120" max="120" step="0.05" value="0" /></label>
        <label>投影东移（米）<input id="videoArEastOffset" type="number" min="-10000" max="10000" step="0.1" value="0" /></label>
        <label>投影北移（米）<input id="videoArNorthOffset" type="number" min="-10000" max="10000" step="0.1" value="0" /></label>
      </div>
      <div class="field-grid video-ar-fields">
        <label>投影表面<select id="videoArSurfaceMode"><option value="terrain">当前高程地形（无高程时使用平面）</option><option value="model">倾斜摄影模型（保留楼体）</option><option value="plane">指定基准平面</option></select></label>
        <label>DJI 高程基准<select id="videoArHeightMode"><option value="estimated">未知基准（估算 / 对照试验）</option><option value="relative">相对高度 + 已知起飞点椭球高</option><option value="source">源高程 + 已知椭球转换量</option></select></label>
        <label>起飞点 / 试算基准椭球高（米）<input id="videoArTakeoffHeight" type="number" min="-1000" max="10000" step="0.1" placeholder="未知模式留空：首帧下方地面估算" /></label>
        <label>源高程 → 椭球高加数（米）<input id="videoArSourceHeightOffset" type="number" step="0.1" placeholder="源高程已是椭球高时明确填 0" /></label>
        <label>投影平面椭球高（米）<input id="videoArSurfaceHeight" type="number" min="-1000" max="10000" step="0.1" placeholder="空白：与起飞点基准相同" /></label>
      </div>
      <details class="video-ar-source-details">
        <summary>镜头标定参数（可选）</summary>
        <p class="hint">使用原视频分辨率的标定值；留空使用轨迹内参。畸变系数默认 0，已去畸变的视频不要重复填写。主点为左上原点像素坐标。</p>
        <div class="field-grid video-ar-fields">
          <label>焦距 fx（像素）<input id="videoArCameraFx" type="number" min="1" step="0.1" placeholder="轨迹 / 视场角" /></label>
          <label>焦距 fy（像素）<input id="videoArCameraFy" type="number" min="1" step="0.1" placeholder="轨迹 / 视场角" /></label>
          <label>主点 cx（像素）<input id="videoArCameraCx" type="number" step="0.1" placeholder="轨迹 / 画面中心" /></label>
          <label>主点 cy（像素）<input id="videoArCameraCy" type="number" step="0.1" placeholder="轨迹 / 画面中心" /></label>
          <label>径向 k1<input id="videoArK1" type="number" step="0.001" value="0" /></label>
          <label>径向 k2<input id="videoArK2" type="number" step="0.001" value="0" /></label>
          <label>径向 k3<input id="videoArK3" type="number" step="0.001" value="0" /></label>
          <label>切向 p1<input id="videoArP1" type="number" step="0.001" value="0" /></label>
          <label>切向 p2<input id="videoArP2" type="number" step="0.001" value="0" /></label>
        </div>
      </details>
      <button id="videoArShowModels" class="secondary" type="button">显示倾斜摄影并启用三维投影</button>
      <p class="hint">模型模式按屋顶、立面和遮挡关系投影。模型需覆盖视频区域；SRT 高度和镜头为估算时，请用下方同名点配准。未加载的区域不会用平面补齐。</p>
      <p id="videoArModelStatus" class="hint" hidden></p>
      <div id="videoArControlPointHost"></div>
      <p id="videoArEffectiveCamera" class="hint">实际相机参数：等待同帧姿态</p>
      <details class="video-ar-source-details">
        <summary>三维投影深度检查</summary>
        <label>检查画面<select id="videoArDepthDiagnostic">
          <option value="off">正常视频投影</option><option value="source-depth">源相机首表面深度</option>
          <option value="observer-depth">观察表面深度（换算至源相机）</option><option value="depth-difference">首表面深度差</option>
          <option value="rejection-reason">投影接受 / 拒绝原因</option><option value="extrapolation-mask">轮廓外推有效范围</option>
        </select></label>
        <p id="videoArDepthLegend" class="hint">仅用于倾斜摄影模型投影。诊断画面不改变相机参数，切换来源后恢复正常投影。</p>
      </details>
      <button id="videoArExportDiagnostics" class="secondary" type="button">导出当前帧诊断与选点记录</button>
      <p class="hint">高程基准独立于手动校准开关。未知模式可填试算基准作同帧对照，但不代表高程已确认。导出含实际相机参数、模型状态和当前画面；检查点精度需另行验收。</p>
      <button id="videoArResetCalibration" class="secondary" type="button">重置手动校准</button>
      <label class="check-label"><input id="videoArLockAspect" type="checkbox" checked /> 按视频宽高比自动约束垂直视场角</label>
      <p class="hint">DJI 相对高度以起飞点为基准，并非每一帧距地高度。视频时间校正只用于普通轨迹；DJI 始终按视频帧时间绑定。自动基准和等效焦距仍属于估算，精确定位请使用实测高程、镜头标定或三维控制网格。</p>
    </details>
    <label class="check-label"><input id="videoArTerrain" type="checkbox" checked /> 启用视频表面投影</label>
    <label class="check-label"><input id="videoArAutoGround" type="checkbox" /> 俯仰缺失时允许按正下方估算（非真实配准）</label>
    <label class="check-label"><input id="videoArAbsoluteGimbal" type="checkbox" checked /> 云台偏航为绝对方位角（DJI 常用）</label>
    <label class="check-label"><input id="videoArShowFrustum" type="checkbox" checked /> 显示相机视锥</label>
    <label class="check-label"><input id="videoArShowTrajectory" type="checkbox" checked /> 显示飞行轨迹</label>

    <div class="video-ar-actions">
      <button class="primary" id="videoArLoad" type="button">加载并定位</button>
      <button class="secondary" id="videoArLocate" type="button" disabled>定位轨迹</button>
      <button class="secondary" id="videoArClear" type="button" disabled>清除 AR</button>
    </div>

    <div class="video-ar-preview" id="videoArPreview">
      <canvas id="videoArCanvasA" width="16" height="9"></canvas>
      <canvas id="videoArCanvasB" width="16" height="9" class="hidden"></canvas>
      <div id="videoArPreviewPlaceholder">等待视频帧</div>
      <video id="videoArSourceVideo" muted playsinline preload="metadata" hidden></video>
      <span id="videoArProjectionMode">未加载</span>
    </div>

    <div class="video-ar-telemetry" aria-live="polite">
      <span><small>位置</small><b id="videoArPosition">--</b></span>
      <span><small>云台</small><b id="videoArGimbal">--</b></span>
      <span><small>帧</small><b id="videoArFrame">0 / 0</b></span>
      <span><small>状态</small><b id="videoArState">待加载</b></span>
    </div>

    <div class="video-ar-player">
      <div class="video-ar-player-buttons">
        <button id="videoArPrevious" type="button" title="上一帧" disabled>｜◀</button>
        <button id="videoArPlay" type="button" title="播放或暂停" disabled>▶</button>
        <button id="videoArNext" type="button" title="下一帧" disabled>▶｜</button>
      </div>
      <input id="videoArProgress" type="range" min="0" max="1000" step="1" value="0" disabled aria-label="回放进度" />
      <div class="video-ar-time"><span id="videoArCurrentTime">00:00</span><span id="videoArDuration">00:00</span></div>
    </div>

    <details class="video-ar-live">
      <summary>实时 WebSocket 接入</summary>
      <label>状态流地址<input id="videoArStatusSocket" type="url" value="ws://localhost:8765" /></label>
      <label>视频流地址<input id="videoArVideoSocket" type="url" value="ws://localhost:8766" /></label>
      <button class="secondary" id="videoArConnectLive" type="button">连接实时流</button>
      <p class="hint">兼容参考后端的 coordinates、gimbal_attitude、drone_status 与 video_frame 消息；后台页只保留最新帧，不排队解码。</p>
    </details>

    <p id="videoArStatus" class="hint video-ar-status" aria-live="polite">请选择飞行数据 ZIP，或展开选择独立文件。</p>
  </section>`;

class BrowserZipReader {
  private constructor(
    private readonly file: File,
    readonly entries: ReadonlyMap<string, ZipEntry>,
  ) {}

  static async open(file: File): Promise<BrowserZipReader> {
    if (file.size < 22) throw new Error("ZIP 文件不完整");
    const tailSize = Math.min(file.size, 65_557);
    const tailOffset = file.size - tailSize;
    const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (readU32(tail, offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error("未找到 ZIP 中央目录");

    const diskNumber = readU16(tail, eocd + 4);
    const centralDisk = readU16(tail, eocd + 6);
    const entryCount = readU16(tail, eocd + 10);
    const centralSize = readU32(tail, eocd + 12);
    const centralOffset = readU32(tail, eocd + 16);
    if (diskNumber !== 0 || centralDisk !== 0) throw new Error("暂不支持分卷 ZIP");
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error("暂不支持 ZIP64 格式");
    }
    if (entryCount > MAX_ZIP_ENTRIES || centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error("ZIP 条目过多或目录异常，已停止读取");
    }
    if (centralOffset + centralSize > file.size) throw new Error("ZIP 中央目录越界");

    const bytes = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const decoder = new TextDecoder("utf-8");
    const entries = new Map<string, ZipEntry>();
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > bytes.length || readU32(bytes, cursor) !== 0x02014b50) {
        throw new Error("ZIP 中央目录损坏");
      }
      const flags = readU16(bytes, cursor + 8);
      const compressionMethod = readU16(bytes, cursor + 10);
      const compressedSize = readU32(bytes, cursor + 20);
      const uncompressedSize = readU32(bytes, cursor + 24);
      const nameLength = readU16(bytes, cursor + 28);
      const extraLength = readU16(bytes, cursor + 30);
      const commentLength = readU16(bytes, cursor + 32);
      const localHeaderOffset = readU32(bytes, cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > bytes.length) throw new Error("ZIP 条目名称越界");
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replaceAll("\\", "/");
      if (name && !name.endsWith("/")) {
        if ((flags & 1) !== 0) throw new Error("ZIP 包含加密条目，无法在浏览器中读取");
        if (compressionMethod !== 0 && compressionMethod !== 8) {
          throw new Error(`ZIP 使用了不支持的压缩方式：${compressionMethod}`);
        }
        if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`ZIP 条目过大：${name}`);
        entries.set(name, { name, flags, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
      }
      cursor = next;
    }
    return new BrowserZipReader(file, entries);
  }

  async readBlob(name: string, mimeType = "application/octet-stream"): Promise<Blob> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`ZIP 中缺少文件：${name.split("/").pop() ?? name}`);
    const headerBytes = new Uint8Array(await this.file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
    if (headerBytes.length !== 30 || readU32(headerBytes, 0) !== 0x04034b50) throw new Error("ZIP 本地条目头损坏");
    const nameLength = readU16(headerBytes, 26);
    const extraLength = readU16(headerBytes, 28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > this.file.size) throw new Error("ZIP 压缩数据越界");
    const compressed = this.file.slice(dataOffset, dataOffset + entry.compressedSize);
    if (entry.compressionMethod === 0) return compressed.slice(0, compressed.size, mimeType);
    if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持 ZIP 解压，请使用最新版 Chrome 或 Edge");
    const stream = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const blob = await new Response(stream).blob();
    if (blob.size !== entry.uncompressedSize) throw new Error(`ZIP 条目解压长度异常：${name}`);
    return blob.slice(0, blob.size, mimeType);
  }

  async readText(name: string): Promise<string> {
    return (await this.readBlob(name, "application/json")).text();
  }
}

function readU16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function finite(value: unknown, fallback = 0) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function timestampToMs(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return value * 1000;
  }
  if (typeof value !== "string") return fallback;
  const compact = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(\d{1,3}))?$/.exec(value.trim());
  if (compact) {
    return Date.UTC(
      Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
      Number(compact[4]), Number(compact[5]), Number(compact[6]),
      Number((compact[7] ?? "0").padEnd(3, "0")),
    );
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function frameTimestampToMs(name: string) {
  const normalized = name.replaceAll("\\", "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const match = /(\d{8}_\d{6}(?:_\d{1,3})?)(?:\.[^.]+)?$/i.exec(fileName);
  if (!match) return undefined;
  const parsed = timestampToMs(match[1], Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseVideoArTrajectory(input: unknown): FlightPoint[] {
  const root = objectValue(input);
  const flightInfo = objectValue(root.flight_info ?? root.flightInfo);
  const videoInfo = objectValue(flightInfo.video);
  const cameraModel = objectValue(flightInfo.camera_model);
  const arProjection = objectValue(flightInfo.ar_projection);
  const arProjectionReadiness = objectValue(arProjection.readiness);
  const declaredArProjectionReady = arProjection.mode === undefined
    ? true
    : arProjection.mode === "dji_srt_pose_terrain_intersection" && arProjectionReadiness.ready === true;
  const sourceVideoFile = typeof flightInfo.video_file === "string"
    ? flightInfo.video_file.replaceAll("\\", "/").split("/").pop()?.trim() ?? ""
    : "";
  const videoWidth = finite(videoInfo.width, Number.NaN);
  const videoHeight = finite(videoInfo.height, Number.NaN);
  const videoFrameCount = finite(videoInfo.frame_count, Number.NaN);
  const videoDurationMs = finite(videoInfo.duration_ms, Number.NaN);
  const videoFrameRateFps = finite(videoInfo.frame_rate_fps, Number.NaN);
  const videoSizeBytes = finite(videoInfo.size_bytes, Number.NaN);
  const djiTimeline = typeof flightInfo.timeline === "string" ? flightInfo.timeline : "";
  const djiGenerator = typeof flightInfo.generator === "string" ? flightInfo.generator : "";
  const sourceVideoDataset: DjiSrtDataset | undefined = root.schema_version === "cesium-dji-trajectory/v1"
    && djiGenerator.startsWith("DJI 航拍视频信息提取器 ")
    && /SRT PTS/i.test(djiTimeline)
    && sourceVideoFile
    && Number.isInteger(videoWidth) && videoWidth >= 16 && videoWidth <= 16_384
    && Number.isInteger(videoHeight) && videoHeight >= 16 && videoHeight <= 16_384
    && Number.isInteger(videoFrameCount) && videoFrameCount > 0 && videoFrameCount <= 10_000_000
    && Number.isFinite(videoDurationMs) && videoDurationMs > 0
    && Number.isFinite(videoFrameRateFps) && videoFrameRateFps > 0 && videoFrameRateFps <= 240
    && Number.isInteger(videoSizeBytes) && videoSizeBytes > 0
    ? {
        sourceVideoFile,
        videoWidth,
        videoHeight,
        videoFrameCount,
        videoDurationMs,
        videoFrameRateFps,
        videoSizeBytes,
      }
    : undefined;
  const djiDataset = sourceVideoDataset
    && cameraModel.intrinsics_status === "estimated_from_35mm_equivalent"
    && declaredArProjectionReady
    ? sourceVideoDataset
    : undefined;
  const declaredCrsValue = flightInfo.source_crs ?? flightInfo.crs ?? root.source_crs ?? root.crs ?? root.coordinate_system;
  if (declaredCrsValue !== undefined) {
    const declaredCrs = String(declaredCrsValue).trim().toUpperCase().replaceAll("_", "-").replaceAll(" ", "");
    const wgs84Compatible = [
      "WGS84", "WGS-84", "EPSG:4326", "4326", "WGS84-3D", "EPSG:4979", "4979",
      "CGCS2000", "EPSG:4490", "4490",
    ].includes(declaredCrs);
    if (!wgs84Compatible) {
      throw new Error(`轨迹坐标系 ${String(declaredCrsValue)} 不能直接叠加到 WGS84 卫星底图，请先完成坐标转换`);
    }
  }
  const altitudeReference = typeof flightInfo.altitude_reference === "string"
    ? flightInfo.altitude_reference.toLowerCase()
    : "";
  const configuredGroundAltitude = finite(
    flightInfo.ground_altitude_m ?? flightInfo.groundAltitude ?? root.ground_altitude_m,
    Number.NaN,
  );
  const declaredGroundAltitude = Number.isFinite(configuredGroundAltitude)
    ? configuredGroundAltitude
    : altitudeReference === "relative" || altitudeReference === "agl"
      ? 0
      : Number.NaN;
  const candidates = Array.isArray(input)
    ? input
    : Array.isArray(root.trajectory_points)
      ? root.trajectory_points
      : Array.isArray(root.points)
        ? root.points
        : [];
  if (!candidates.length) throw new Error("轨迹 JSON 中没有 trajectory_points 数组");
  if (candidates.length > MAX_TRAJECTORY_POINTS) throw new Error(`轨迹点超过 ${MAX_TRAJECTORY_POINTS.toLocaleString()} 个，请先抽稀`);

  const points: FlightPoint[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const raw = objectValue(candidates[index]);
    const position = objectValue(raw.position ?? raw.coordinates ?? raw);
    const longitude = finite(position.longitude ?? position.lon, Number.NaN);
    const latitude = finite(position.latitude ?? position.lat, Number.NaN);
    const altitude = finite(position.altitude ?? position.height, Number.NaN);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(altitude)) continue;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 || altitude < -1_000 || altitude > 100_000) continue;
    const attitude = objectValue(raw.attitude ?? position.attitude);
    const gimbal = objectValue(raw.gimbal_attitude ?? raw.gimbalAttitude ?? raw.gimbal);
    const explicitGimbalYaw = finite(gimbal.yaw ?? gimbal.gimbalYaw, Number.NaN);
    const explicitGimbalPitch = finite(gimbal.pitch ?? gimbal.gimbalPitch, Number.NaN);
    const explicitGimbalRoll = finite(gimbal.roll ?? gimbal.gimbalRoll, Number.NaN);
    const explicitPointTimestamp = raw.source_timestamp_ms ?? raw.timestamp_ms;
    const timestampMs = timestampToMs(explicitPointTimestamp ?? raw.timestamp ?? raw.time, index * 100);
    const videoFrame = typeof raw.video_frame === "string"
      ? raw.video_frame
      : typeof raw.videoFrame === "string"
        ? raw.videoFrame
        : undefined;
    const explicitFrameTimestamp = raw.video_frame_timestamp_ms ?? raw.frame_timestamp_ms;
    const fileNameFrameTimestampMs = videoFrame ? frameTimestampToMs(videoFrame) : undefined;
    const parsedFrameTimestampMs = explicitFrameTimestamp !== undefined
      ? timestampToMs(explicitFrameTimestamp, Number.NaN)
      : explicitPointTimestamp === undefined && videoFrame
        ? fileNameFrameTimestampMs
        : undefined;
    const videoFrameTimestampMs = parsedFrameTimestampMs !== undefined && Number.isFinite(parsedFrameTimestampMs)
      ? parsedFrameTimestampMs
      : undefined;
    const legacyPointTimestampMs = raw.timestamp !== undefined || raw.time !== undefined
      ? timestampToMs(raw.timestamp ?? raw.time, Number.NaN)
      : undefined;
    const declaredFrameDeltaMs = finite(raw.video_frame_time_delta_ms ?? raw.frame_time_delta_ms, Number.NaN);
    const comparablePointTimestampMs = explicitFrameTimestamp !== undefined
      ? timestampMs
      : legacyPointTimestampMs;
    const comparableFrameTimestampMs = explicitFrameTimestamp !== undefined
      ? videoFrameTimestampMs
      : fileNameFrameTimestampMs;
    const videoFrameTimeDeltaMs = Number.isFinite(declaredFrameDeltaMs)
      ? Math.abs(declaredFrameDeltaMs)
      : comparablePointTimestampMs !== undefined
          && Number.isFinite(comparablePointTimestampMs)
          && comparableFrameTimestampMs !== undefined
          && Number.isFinite(comparableFrameTimestampMs)
        ? Math.abs(comparableFrameTimestampMs - comparablePointTimestampMs)
        : undefined;
    const relativeAltitude = finite(
      position.relative_altitude ?? position.relativeAltitude ?? raw.relative_altitude,
      Number.NaN,
    );
    const groundAltitude = Number.isFinite(declaredGroundAltitude)
      ? declaredGroundAltitude
      : Number.isFinite(relativeAltitude)
        ? altitude - relativeAltitude
        : undefined;
    const camera = objectValue(raw.camera);
    const intrinsics = objectValue(camera.estimated_intrinsics ?? camera.estimatedIntrinsics);
    const videoSampleIndex = finite(raw.video_sample_index ?? raw.videoSampleIndex, Number.NaN);
    const videoTimeMs = finite(raw.video_time_ms ?? raw.videoTimeMs, Number.NaN);
    const fxPx = finite(intrinsics.fx_px, Number.NaN);
    const fyPx = finite(intrinsics.fy_px, Number.NaN);
    const cxPx = finite(intrinsics.cx_px, Number.NaN);
    const cyPx = finite(intrinsics.cy_px, Number.NaN);
    const horizontalFovDegrees = finite(intrinsics.horizontal_fov_degrees, Number.NaN);
    const verticalFovDegrees = finite(intrinsics.vertical_fov_degrees, Number.NaN);
    const estimatedHorizontalFov = djiDataset && Number.isFinite(fxPx) && fxPx > 0
      ? CesiumMath.toDegrees(2 * Math.atan(djiDataset.videoWidth / (2 * fxPx)))
      : Number.NaN;
    const estimatedVerticalFov = djiDataset && Number.isFinite(fyPx) && fyPx > 0
      ? CesiumMath.toDegrees(2 * Math.atan(djiDataset.videoHeight / (2 * fyPx)))
      : Number.NaN;
    const djiSrtPoseProjection: DjiSrtPoseProjection | undefined = djiDataset
      && raw.ar_projection_ready !== false
      && Number.isInteger(videoSampleIndex) && videoSampleIndex >= 0 && videoSampleIndex < djiDataset.videoFrameCount
      && Number.isFinite(videoTimeMs) && videoTimeMs >= 0 && videoTimeMs <= djiDataset.videoDurationMs + 500
      && Number.isFinite(relativeAltitude) && relativeAltitude > 0 && relativeAltitude <= 20_000
      && Number.isFinite(explicitGimbalYaw) && Math.abs(explicitGimbalYaw) <= 3_600
      && Number.isFinite(explicitGimbalPitch) && Math.abs(explicitGimbalPitch) <= 180
      && Number.isFinite(explicitGimbalRoll) && Math.abs(explicitGimbalRoll) <= 180
      && intrinsics.quality === "estimated_not_calibrated"
      && typeof intrinsics.method === "string" && /35mm-equivalent/i.test(intrinsics.method)
      && Number.isFinite(fxPx) && fxPx > 0 && Number.isFinite(fyPx) && fyPx > 0
      && Number.isFinite(cxPx) && Math.abs(cxPx - djiDataset.videoWidth / 2) <= 1
      && Number.isFinite(cyPx) && Math.abs(cyPx - djiDataset.videoHeight / 2) <= 1
      && Number.isFinite(horizontalFovDegrees) && horizontalFovDegrees > 1 && horizontalFovDegrees < 179
      && Number.isFinite(verticalFovDegrees) && verticalFovDegrees > 1 && verticalFovDegrees < 179
      && Math.abs(horizontalFovDegrees - estimatedHorizontalFov) <= 0.05
      && Math.abs(verticalFovDegrees - estimatedVerticalFov) <= 0.05
      && (videoFrameTimeDeltaMs === undefined || videoFrameTimeDeltaMs <= 1)
      ? {
          dataset: djiDataset,
          videoSampleIndex,
          videoTimeMs,
          relativeAltitudeMeters: relativeAltitude,
          horizontalFovDegrees,
          verticalFovDegrees,
          fxPx,
          fyPx,
          cxPx,
          cyPx,
          quality: "estimated_not_calibrated",
        }
      : undefined;
    points.push({
      timestampMs,
      recordedAt: typeof raw.recorded_at === "string" ? raw.recorded_at : undefined,
      longitude,
      latitude,
      altitude,
      relativeAltitude: Number.isFinite(relativeAltitude) ? relativeAltitude : undefined,
      groundAltitude,
      attitude: {
        heading: finite(attitude.heading ?? attitude.head ?? position.heading),
        pitch: finite(attitude.pitch ?? position.pitch),
        roll: finite(attitude.roll ?? position.roll),
      },
      gimbal: {
        yaw: Number.isFinite(explicitGimbalYaw)
          ? explicitGimbalYaw
          : finite(attitude.heading ?? position.heading),
        pitch: Number.isFinite(explicitGimbalPitch) ? explicitGimbalPitch : 0,
        roll: Number.isFinite(explicitGimbalRoll) ? explicitGimbalRoll : 0,
      },
      videoFrame,
      videoFrameTimestampMs,
      videoFrameTimeDeltaMs,
      videoSampleIndex: Number.isInteger(videoSampleIndex) && videoSampleIndex >= 0 ? videoSampleIndex : undefined,
      videoTimeMs: Number.isFinite(videoTimeMs) && videoTimeMs >= 0 ? videoTimeMs : undefined,
      djiSrtPoseProjection,
    });
  }
  if (!points.length) throw new Error("轨迹 JSON 中没有有效的 WGS84 位置");
  points.sort((a, b) => a.timestampMs - b.timestampMs);
  const embeddedFootprints = parseGeoFootprintCollection(input);
  if (embeddedFootprints.items.length) {
    const usedFootprints = new Set<GeoFootprint>();
    for (const point of points) {
      const footprint = matchGeoFootprint(
        embeddedFootprints,
        point.videoFrame,
        point.videoFrameTimestampMs ?? point.timestampMs,
        MAX_FRAME_POSE_DELTA_MS,
      );
      if (footprint && !usedFootprints.has(footprint)) {
        point.groundFootprint = footprint;
        usedFootprints.add(footprint);
      }
    }
  }
  // Dense meshes are intentionally loaded from a separate sidecar and parsed
  // in a Worker. Embedded per-frame meshes can otherwise monopolize the UI
  // thread before the AR panel has a chance to apply its safety bounds.
  const base = points[0].timestampMs;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].timestampMs < base) points[index].timestampMs = base + index * 100;
  }
  trajectoryMetadata.set(points, { sourceVideoDataset, embeddedFootprints });
  return points;
}

function interpolateAngleDegrees(left: number, right: number, amount: number) {
  const delta = ((right - left + 540) % 360) - 180;
  return left + delta * amount;
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function mimeFromName(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export class VideoArFusion {
  private readonly dataSource = new CustomDataSource("video-ar-fusion");
  private readonly dataSourceReady: Promise<CustomDataSource>;
  private readonly abortController = new AbortController();
  private readonly projectionMaterial: Material;
  private modelProjector?: VideoArModelProjector;
  private modelProjectionFrame?: ModelProjectionFrame;
  private effectiveCamera?: EffectiveCameraState;
  private projectionDecision = "";
  private holdingPreviousProjection = false;
  private committedModelCamera?: ResolvedCameraFrame;
  private activeTextureFrame?: TextureFrameIdentity;
  private committedModelTextureFrame?: TextureFrameIdentity;
  private uploadedTextureFrame?: TextureFrameIdentity;
  private pendingTextureFrame?: TextureFrameIdentity;
  private currentBitmapFrame?: TextureFrameIdentity;
  private textureNeedsRefresh = false;
  private liveMediaTimeOriginMs?: number;
  private liveBitmapSequence = 0;
  private calibrationSessions: ControlPointSession[] = [];
  onGetProjectionModels?: () => unknown[];
  private modelProjectionAllowed = false;
  private controlPointPicker?: VideoArControlPointPicker;
  private controlPointPicking = false;
  private calibrationFrame?: Omit<ControlPointFrame, "image">;
  private calibrationReferenceHeight?: number;
  onShowProjectionModels?: () => number;

  private readonly projectionAppearance: MaterialAppearance;
  private readonly canvasA: HTMLCanvasElement;
  private readonly canvasB: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private textureCanvas: HTMLCanvasElement;
  private previewCanvas: HTMLCanvasElement;
  private textureWidth = 0;
  private textureHeight = 0;
  private mediaSourceWidth = 0;
  private mediaSourceHeight = 0;
  private sourceAspectRatio?: number;
  private lastVideoTextureTime = Number.NaN;
  private decodedVideoTime = Number.NaN;
  private usesDecodedFrameCallbacks = false;
  private pendingVideoTextureTime = Number.NaN;
  private stableTextureUpload = false;
  private pendingTextureUpload = false;
  private pendingTextureCanvas?: HTMLCanvasElement;
  private awaitingDecodedTexture = false;
  private textureUploadWarningShown = false;
  private droneEntity?: ReturnType<CustomDataSource["entities"]["add"]>;
  private trajectoryEntity?: ReturnType<CustomDataSource["entities"]["add"]>;
  private projectionPrimitive?: Primitive;
  private projectionCandidate?: Primitive;
  private projectionCandidateSurface?: ProjectionSurface;
  private pendingProjectionSurface?: ProjectionSurface;
  private pendingProjectionAtomic = false;
  private removeTerrainProgressListener: () => void;
  private removeTerrainProviderListener: () => void;
  private terrainRefreshTimer = 0;
  private readonly removeProjectionPostRenderListener: () => void;
  private readonly removeCameraMoveStartListener: () => void;
  private readonly removeCameraMoveEndListener: () => void;
  private projectionVisible = false;
  private projectionAtomicSwapPending = false;
  private projectionGeometryBuildFailed = false;
  private lastProjectionSurface?: ProjectionSurface;
  private frustumRaysEntity?: ReturnType<CustomDataSource["entities"]["add"]>;
  private frustumOutlineEntity?: ReturnType<CustomDataSource["entities"]["add"]>;
  private cameraAxisEntity?: ReturnType<CustomDataSource["entities"]["add"]>;
  private points: FlightPoint[] = [];
  private projectionMeshPoints: FlightPoint[] = [];
  private projectionMeshVideoPoints: FlightPoint[] = [];
  private projectionSource: ProjectionSource = "none";
  private requireExactFootprint = false;
  private independentDjiPoseProjection = false;
  private independentVideoExactTimeline = false;
  private exactMediaBinding = false;
  private meshSourceVideoDurationMs?: number;
  private meshVideoFrameReady = true;
  private independentDjiPoseProjectionReason = "";
  private independentVideoFirstTimeMs = 0;
  private liveTrajectory: Cartesian3[] = [];
  private currentIndex = -1;
  private playbackMs = 0;
  private durationMs = 0;
  private playing = false;
  private panelActive = false;
  private animationFrame = 0;
  private lastAnimationTime = 0;
  private lastProjectionUpdate = 0;
  private lastProjectionGeometryBuildTime = 0;
  private projectionGeometryTimer = 0;
  private throttledProjectionSurface?: ProjectionSurface;
  private throttledProjectionAtomic = false;
  private cameraInteracting = false;
  private cameraResumeTimer = 0;
  private loadGeneration = 0;
  private zipReader: BrowserZipReader | null = null;
  private replayZipFile: File | null = null;
  private restoringReplay = false;
  private replaySettingsReady = false;
  private replaySelectionPending = false;
  onReplayLoaded?: (snapshot: SavedReplay) => Promise<void>;
  onReplaySettingsChanged?: (controls: Record<string, string | boolean>, sessions: ControlPointSession[], requireSaved?: boolean) => void | Promise<void>;

  private resetCalibration() {
      this.element<HTMLSelectElement>("#videoArHeightMode").value = "estimated";
      this.element<HTMLInputElement>("#videoArSourceHeightOffset").value = "";
      this.controlPointPicker?.cancel();
      for (const id of ["HeightOffset", "YawCorrection", "PitchCorrection", "RollCorrection", "TimeOffset", "EastOffset", "NorthOffset", "K1", "K2", "K3", "P1", "P2"]) this.element<HTMLInputElement>("#videoAr" + id).value = "0";
      for (const id of ["CameraFx", "CameraFy", "CameraCx", "CameraCy", "TakeoffHeight", "SurfaceHeight"]) this.element<HTMLInputElement>("#videoAr" + id).value = "";
      this.element<HTMLInputElement>("#videoArFootprintScale").value = "1";
      this.element<HTMLInputElement>("#videoArEnableCalibration").checked = false;
      this.element<HTMLSelectElement>("#videoArSurfaceMode").value = "terrain";
      this.element<HTMLSelectElement>("#videoArDepthDiagnostic").value = "off";
      this.updateDepthDiagnostic();
  }

  private updateDepthDiagnostic() {
    const mode = this.element<HTMLSelectElement>("#videoArDepthDiagnostic").value as ModelProjectionDiagnosticMode;
    this.modelProjector?.setDiagnosticMode(mode);
    const legends: Record<ModelProjectionDiagnosticMode, string> = {
      off: "仅用于倾斜摄影模型投影。诊断画面不改变相机参数，切换来源后恢复正常投影。",
      "source-depth": "源相机首表面距离；按源相机光轴米计，亮度由近到远，范围见导出记录。",
      "observer-depth": "当前观察表面换算至源相机光轴的距离；与源深度使用同一单位。",
      "depth-difference": "纹素中心修正后的观察深度减源首表面深度：红为正、蓝为负，显示范围 ±2 米；遮挡判定仍为 ±0.35 米。",
      "rejection-reason": "绿：接受；灰：源通道未就绪；深蓝：无观察表面；橙：源视锥外；紫：无源深度；红：首表面深度不符；青：视频 UV 越界。计数不等于真实有效覆盖率。",
      "extrapolation-mask": "绿：局部连续性检查允许外推；红：禁止；黑：不可用。局部连续不代表几何或配准精度已验证。",
    };
    this.element("#videoArDepthLegend").textContent = legends[mode];
    this.viewer.scene.requestRender();
  }

  /** Captures resolved state; form values alone are never evidence of rendered parameters. */
  getDiagnostics(includeSessions = true) {
    const camera = this.effectiveCamera;
    const fileInfo = (file: File | null) => file ? { name: file.name, sizeBytes: file.size, lastModified: file.lastModified } : null;
    return structuredClone({
      schema: "video-ar-diagnostics/v1", exportedAt: new Date().toISOString(),
      acceptance: "not-validated-with-independent-real-checkpoints",
      effectiveCamera: camera ?? null,
      committedModelCamera: this.committedModelCamera ?? null,
      textureFrames: { active: this.activeTextureFrame ?? null, uploaded: this.uploadedTextureFrame ?? null,
        committedModel: this.committedModelTextureFrame ?? null, pending: this.pendingTextureFrame ?? null,
        refreshRequested: this.textureNeedsRefresh },
      projectionDecision: this.projectionDecision,
      calibrationFrameState: { available: Boolean(this.calibrationFrame), frameTime: this.calibrationFrame?.frameTime ?? null, cameraInteracting: this.cameraInteracting, picking: this.controlPointPicking, selectionPending: this.replaySelectionPending },
      media: { source: this.projectionSource,
        video: this.projectionSource === "live" ? null : fileInfo(this.videoFile),
        trajectory: this.projectionSource === "live" ? null : fileInfo(this.trajectoryFile),
        liveConnected: this.liveOnline, liveFrameTimestampMs: this.liveFrameTimestampMs ?? null,
        decodedTimeSeconds: Number.isFinite(this.decodedVideoTime) ? this.decodedVideoTime : null,
        textureTimeSeconds: Number.isFinite(this.lastVideoTextureTime) ? this.lastVideoTextureTime : null,
        playbackTimeSeconds: this.playbackMs / 1000, width: this.mediaSourceWidth, height: this.mediaSourceHeight,
        seeking: this.video.seeking, readyState: this.video.readyState,
        poseMinusDecodedMs: camera?.poseVideoTimeMs !== undefined && Number.isFinite(this.decodedVideoTime) ? camera.poseVideoTimeMs - this.decodedVideoTime * 1000 : null,
        synchronizationNote: "PTS alignment is not independent verification of sensor/telemetry latency" },
      rendering: { selectedSurface: this.element<HTMLSelectElement>("#videoArSurfaceMode").value,
        panelActive: this.panelActive, enabled: this.element<HTMLInputElement>("#videoArTerrain").checked,
        flatPrimitiveExists: Boolean(this.projectionPrimitive), flatPrimitiveVisible: Boolean(this.projectionPrimitive?.show),
        parameterMeaning: "effectiveCamera is the resolved camera; model.camera is the applied projector uniform state. Neither alone proves a pixel was rendered.",
        textureTransactionPending: this.textureTransactionPending(),
        geometryBuildFailed: this.projectionGeometryBuildFailed,
        awaitingDecodedTexture: this.awaitingDecodedTexture,
        pendingTextureTimeSeconds: Number.isFinite(this.pendingVideoTextureTime) ? this.pendingVideoTextureTime : null,
        holdingPreviousProjection: Boolean(this.holdingPreviousProjection || this.textureTransactionPending()),
        modelProjectionAllowed: this.modelProjectionAllowed, model: this.modelProjector?.getDiagnosticState() ?? null,
        models: this.onGetProjectionModels?.() ?? [],
        modeText: this.element("#videoArProjectionMode").textContent,
        hasElevationTerrain: this.hasElevationTerrain(), showFrustum: this.element<HTMLInputElement>("#videoArShowFrustum").checked },
      inputs: this.replayControls(),
      controlPointSessions: includeSessions ? this.calibrationSessions : [],
      observer: { positionEcef: { ...this.viewer.camera.positionWC }, direction: { ...this.viewer.camera.directionWC }, up: { ...this.viewer.camera.upWC } },
    });
  }

  private exportDiagnostics() {
    this.pause();
    const images: Record<string, string> = {};
    try {
      // Read immediately after render so the drawing buffer has not been cleared.
      this.viewer.render();
      images.scenePng = this.viewer.scene.canvas.toDataURL("image/png");
      if (this.mediaSourceWidth && this.mediaSourceHeight) images.cpuTextureCanvasPng = this.textureCanvas.toDataURL("image/png");
      images.note = "Scene captured immediately after render. CPU texture canvas may contain a staged frame; inspect rendering.textureTransactionPending and media.textureTimeSeconds.";
    } catch (error) { images.captureError = error instanceof Error ? error.message : String(error); }
    const snapshot = this.getDiagnostics();
    const blob = new Blob([JSON.stringify({ ...snapshot, images }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url;
    link.download = `视频AR诊断_${(snapshot.effectiveCamera?.frameTime ?? 0).toFixed(3)}s_${Date.now()}.json`;
    link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.notify("已导出当前实际参数与画面；独立检查点验收状态见记录");
  }

  private invalidateCameraFrame() {
    this.effectiveCamera = undefined;
    this.committedModelCamera = undefined;
    this.activeTextureFrame = undefined;
    this.committedModelTextureFrame = undefined;
    this.currentBitmapFrame = undefined;
    this.controlPointPicker?.restoreLastSession();
    this.calibrationFrame = undefined;
    this.calibrationReferenceHeight = undefined;
    this.modelProjectionFrame = undefined;
    this.modelProjectionAllowed = false;
    this.modelProjector?.setEnabled(false);
  }

  private newReplaySelection() {
    this.calibrationSessions = [];
    this.replaySelectionPending = true;
    this.loadGeneration += 1;
    this.replaySettingsReady = false;
    this.pause();
    this.resetCalibration();
    this.invalidateCameraFrame();
  }

  private replayControls() {
    const controls: Record<string, string | boolean> = {};
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id^="videoAr"], select[id^="videoAr"]').forEach(input => {
      if (input.type === "file" || /Socket|Progress|FlightSelect|DepthDiagnostic/i.test(input.id)) return;
      controls[input.id] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
    });
    return controls;
  }

  private saveReplayControls() {
    if (this.points.length && this.replaySettingsReady && !this.restoringReplay) {
      void Promise.resolve(this.onReplaySettingsChanged?.(this.replayControls(), structuredClone(this.calibrationSessions)))
        .catch(error => this.reportError("配准设置未保存", error));
    }
  }

  private async recordCalibrationSession(session: ControlPointSession) {
    const index = this.calibrationSessions.findIndex(existing => existing.id === session.id);
    if (index < 0) this.calibrationSessions.push(structuredClone(session));
    else this.calibrationSessions[index] = structuredClone(session);
    if (!this.points.length || !this.replaySettingsReady || this.restoringReplay || !this.onReplaySettingsChanged) {
      throw new Error("记录保留在当前会话中，但视频尚未保存到资料库；请先保存回放，或导出诊断记录");
    }
    await this.onReplaySettingsChanged(this.replayControls(), structuredClone(this.calibrationSessions), true);
  }

  private snapshotReplay(name: string): SavedReplay {
    const files: Record<string, File> = {};
    const framePaths: Record<string, string[]> = {};
    if (this.zipReader && this.replayZipFile) files.source = this.replayZipFile;
    else {
      if (this.trajectoryFile) files.source = this.trajectoryFile;
      if (this.videoFile) files.video = this.videoFile;
      const slots = new Map<File, string>();
      for (const [path, file] of this.frameFiles) {
        let slot = slots.get(file);
        if (!slot) {
          slot = "frame_" + slots.size;
          slots.set(file, slot); files[slot] = file; framePaths[slot] = [];
        }
        framePaths[slot].push(path);
      }
    }
    if (this.georeferenceFile) files.georeference = this.georeferenceFile;
    const controls = this.replayControls();
    return { name, files, settings: { flight: this.element<HTMLSelectElement>("#videoArFlightSelect").value, framePaths, controls, calibrationSessions: structuredClone(this.calibrationSessions) } };
  }

  async restoreReplay(files: Record<string, File>, settings: SavedReplaySettings) {
    this.restoringReplay = true;
    try {
      this.clear();
      // Old saved records predate these controls: never inherit the preceding video's calibration.
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id^="videoAr"], select[id^="videoAr"]').forEach(input => {
        if (input.type === "file" || /Socket|Progress|FlightSelect/i.test(input.id)) return;
        if (input instanceof HTMLInputElement) {
          if (input.type === "checkbox") input.checked = input.defaultChecked;
          else input.value = input.defaultValue;
        } else input.selectedIndex = Math.max(0, [...input.options].findIndex(option => option.defaultSelected));
      });
      this.zipReader = null; this.replayZipFile = null;
      this.frameFiles.clear(); this.trajectoryFile = null; this.videoFile = null;
      const source = files.source;
      if (!source) throw new Error("缺少已保存的回放数据");
      if (source.name.toLowerCase().endsWith(".zip")) {
        await this.prepareZip(source);
        if (!this.zipReader) throw new Error("已保存 ZIP 无法建立索引");
        this.element<HTMLSelectElement>("#videoArFlightSelect").value = settings.flight;
      } else {
        this.trajectoryFile = source;
        this.element("#videoArTrajectorySelection").textContent = source.name;
        this.element("#videoArFlightField").classList.add("hidden");
      }
      this.videoFile = files.video ?? null;
      this.georeferenceFile = files.georeference ?? null;
      for (const [slot, paths] of Object.entries(settings.framePaths ?? {})) {
        if (!files[slot]) throw new Error("回放图片缺失：" + slot);
        for (const path of paths) this.frameFiles.set(path, files[slot]);
      }
      for (const [id, value] of Object.entries(settings.controls ?? {})) {
        const input = document.getElementById(id);
        if (!id.startsWith("videoAr") || /Socket|Progress|FlightSelect/i.test(id)) continue;
        if (input instanceof HTMLInputElement && input.type !== "file") {
          if (input.type === "checkbox") input.checked = value === true;
          else input.value = String(value);
        } else if (input instanceof HTMLSelectElement) input.value = String(value);
      }
      // Migrate an old explicit takeoff setting without turning guessed baselines into confirmed heights.
      if (!("videoArHeightMode" in (settings.controls ?? {}))) {
        this.element<HTMLSelectElement>("#videoArHeightMode").value = "estimated";
        // This field used to be gated by calibration. Do not activate old, disabled values during migration.
        if (settings.controls?.videoArEnableCalibration !== true) this.element<HTMLInputElement>("#videoArTakeoffHeight").value = "";
      }
      this.element("#videoArVideoSelection").textContent = this.videoFile?.name ?? "使用已保存逐帧图片";
      this.element("#videoArGeoreferenceSelection").textContent = this.georeferenceFile?.name ?? "无独立配准文件";
      this.element("#videoArFramesSelection").textContent = "已恢复 " + new Set(this.frameFiles.values()).size + " 个图片文件";
      await this.loadSelectedSource();
      if (!this.points.length) throw new Error("回放未能通过轨迹与媒体校验，原资料已保留");
      this.calibrationSessions = Array.isArray(settings.calibrationSessions) ? structuredClone(settings.calibrationSessions) : [];
      this.controlPointPicker?.restoreLastSession(this.calibrationSessions.at(-1));
      this.pause();
    } finally { this.restoringReplay = false; }
  }

  private zipFramePrefix = "";
  private trajectoryFile: File | null = null;
  private videoFile: File | null = null;
  private georeferenceFile: File | null = null;
  private frameFiles = new Map<string, File>();
  private videoObjectUrl: string | null = null;
  private removePreparedVideoListeners?: () => void;
  private frameLoadInFlight = false;
  private frameGeometryRetryTimer = 0;
  private frameGeometryRetryName: string | null = null;
  private frameGeometryRetryAttempts = 0;
  private requestedFrameName: string | null = null;
  private requestedFramePoint: FlightPoint | null = null;
  private displayedFrameName: string | null = null;
  private displayedFramePoint: FlightPoint | null = null;
  private frameRequestVersion = 0;
  private frameBlobCache = new Map<string, Blob>();
  private statusSocket: WebSocket | null = null;
  private videoSocket: WebSocket | null = null;
  private liveState: LiveState | null = null;
  private latestLiveFrame: { base64: string; mime: string; timestampMs?: number; footprint?: GeoFootprint; projectionMesh?: GeoProjectionMesh } | null = null;
  private liveDecodeInFlight = false;
  private liveDecodeTimer = 0;
  private lastLiveDecodeTime = 0;
  private liveFrameGeneration = 0;
  private liveFrameAvailable = false;
  private liveGeometryTimer = 0;
  private lastLiveGeometryTime = 0;
  private liveSessionId = 0;
  private liveOnline = false;
  private liveStatusDeviceSn?: string;
  private liveVideoDeviceSn?: string;
  private livePoseHistory: LivePoseSample[] = [];
  private liveFramePose: LiveState | null = null;
  private liveFrameTimestampMs?: number;
  private liveFrameFootprint?: GeoFootprint;
  private liveFrameProjectionMesh?: GeoProjectionMesh;
  private liveRequiresExactFootprint = false;
  private liveRequiresProjectionMesh = false;
  private lastLiveMessageParseTime = 0;
  private lastLiveTrajectoryRenderTime = 0;
  private automaticGroundHeight?: number;
  private liveGroundHeight?: number;
  private djiProjectionGroundHeight?: number;
  private djiGroundTerrainProvider?: Viewer["terrainProvider"];
  private footprintPositionCache = new Map<string, Cartesian3[]>();
  private projectionMeshSurfaceCache = new Map<GeoProjectionMesh, { surface: ProjectionSurface; corners: Cartesian3[] }>();

  constructor(
    private readonly viewer: Viewer,
    private readonly notify: Notify,
    private readonly setApplicationStatus: (message: string) => void,
  ) {
    this.canvasA = this.element<HTMLCanvasElement>("#videoArCanvasA");
    this.canvasB = this.element<HTMLCanvasElement>("#videoArCanvasB");
    this.video = this.element<HTMLVideoElement>("#videoArSourceVideo");
    this.textureCanvas = this.canvasA;
    this.previewCanvas = this.canvasB;
    this.projectionMaterial = Material.fromType(Material.ImageType, {
      image: this.canvasA,
      repeat: new Cartesian2(1, 1),
      color: Color.WHITE,
    });
    this.projectionMaterial.translucent = false;
    this.projectionAppearance = new MaterialAppearance({
      material: this.projectionMaterial,
      materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: false,
      closed: false,
      flat: true,
      faceForward: true,
      vertexShaderSource: VIDEO_AR_VERTEX_SHADER,
      fragmentShaderSource: VIDEO_AR_FRAGMENT_SHADER,
      renderState: {
        depthTest: { enabled: true },
        depthMask: true,
        cull: { enabled: false },
        polygonOffset: { enabled: true, factor: -1, units: -1 },
      },
    });
    this.dataSourceReady = this.viewer.dataSources.add(this.dataSource);
    this.removeProjectionPostRenderListener = this.viewer.scene.postRender.addEventListener(() => {
      this.finishProjectionCandidate();
      const status = this.element<HTMLElement>("#videoArModelStatus");
      status.hidden = this.element<HTMLSelectElement>("#videoArSurfaceMode").value !== "model";
      if (!status.hidden) {
        const message = this.modelProjector?.status ?? "请加载视频，并显示覆盖拍摄区域的倾斜摄影图层";
        if (status.textContent !== message) status.textContent = message;
        const ready = String(this.modelProjector?.ready ?? false);
        if (status.dataset.ready !== ready) status.dataset.ready = ready;
      }
    });
    const refreshTerrain = () => {
      if (this.terrainRefreshTimer || this.controlPointPicking || !this.panelActive || !this.points.length || this.playing) return;
      this.terrainRefreshTimer = window.setTimeout(() => {
        this.terrainRefreshTimer = 0;
        if (this.panelActive && !this.playing && !this.controlPointPicking) this.refreshCurrentGeometry();
      }, 250);
    };
    this.removeTerrainProgressListener = this.viewer.scene.globe.tileLoadProgressEvent.addEventListener(refreshTerrain);
    this.removeTerrainProviderListener = this.viewer.scene.globe.terrainProviderChanged.addEventListener(refreshTerrain);
    this.removeCameraMoveStartListener = this.viewer.camera.moveStart.addEventListener(() => {
      if (!this.panelActive) return;
      this.cameraInteracting = true;
      if (this.cameraResumeTimer) window.clearTimeout(this.cameraResumeTimer);
      this.cameraResumeTimer = 0;
      this.cancelPendingProjectionUpdates();
      this.clearLiveGeometryTimer();
    });
    this.removeCameraMoveEndListener = this.viewer.camera.moveEnd.addEventListener(() => {
      if (!this.cameraInteracting) return;
      this.cameraInteracting = false;
      if (this.cameraResumeTimer) window.clearTimeout(this.cameraResumeTimer);
      this.cameraResumeTimer = window.setTimeout(() => {
        this.cameraResumeTimer = 0;
        if (!this.panelActive) return;
        if (this.points.length) {
          this.updateAtPlayback(this.playbackMs, true);
          if (this.videoObjectUrl && this.video.readyState >= 2) this.drawTexture(this.video);
        } else if (this.liveState && this.liveOnline) {
          this.scheduleLiveDecode();
          this.scheduleLiveSceneUpdate(true);
        }
        this.viewer.scene.requestRender();
      }, CAMERA_RESUME_DELAY_MS);
    });
    this.controlPointPicker = new VideoArControlPointPicker(viewer, this.element<HTMLElement>("#videoArControlPointHost"), {
      getFrame: () => {
        if (this.replaySelectionPending) return undefined;
        if (!this.controlPointPicking) {
          this.pause();
          // A final decoded-frame callback may arrive just after pause. Resolve that exact frame before freezing.
          if (this.points.length) this.updateAtPlayback(this.playbackMs, true);
        }
        if (!this.calibrationFrame || !this.mediaSourceWidth || !this.mediaSourceHeight || this.video.seeking) return undefined;
        if (!this.videoObjectUrl && (this.pendingTextureUpload || !sameTextureFrame(this.activeTextureFrame, this.uploadedTextureFrame))) return undefined;
        const time = this.videoObjectUrl ? videoMediaTimeMs(this.decodedVideoTime, this.video.currentTime) / 1000
          : (this.currentBitmapFrame?.mediaTimeMs ?? this.playbackMs) / 1000;
        if (Math.abs(time - this.calibrationFrame.frameTime) > 0.05) return undefined;
        return { ...this.calibrationFrame, image: this.videoObjectUrl ? this.video : this.textureCanvas, context: this.getDiagnostics(false) };
      },
      onStart: () => { this.pause(); this.controlPointPicking = true; this.cancelPendingProjectionUpdates(); this.applyVisibility(); },
      onEnd: () => { this.controlPointPicking = false; this.applyVisibility(); },
      onRecord: session => this.recordCalibrationSession(session),
      onApply: result => {
        const alreadyCalibrated = !this.independentDjiPoseProjection || this.element<HTMLInputElement>("#videoArEnableCalibration").checked;
        if (!alreadyCalibrated && this.calibrationFrame) {
          for (const id of ["CameraFx", "CameraFy", "CameraCx", "CameraCy", "SurfaceHeight"]) this.element<HTMLInputElement>("#videoAr" + id).value = "";
          for (const id of ["K1", "K2", "K3", "P1", "P2"]) this.element<HTMLInputElement>("#videoAr" + id).value = "0";
          this.element<HTMLInputElement>("#videoArFootprintScale").value = "1";
        }
        // Keep a solved camera anchored to the datum used while selecting points,
        // even if a terrain provider later supplies a different automatic height.
        if (this.calibrationReferenceHeight !== undefined) this.element<HTMLInputElement>("#videoArTakeoffHeight").value = this.calibrationReferenceHeight.toFixed(6);
        const adjustments: Record<string, number> = {
          EastOffset: result.positionDeltaENU.x, NorthOffset: result.positionDeltaENU.y, HeightOffset: result.positionDeltaENU.z,
          YawCorrection: result.attitudeDelta.yaw, PitchCorrection: result.attitudeDelta.pitch, RollCorrection: result.attitudeDelta.roll,
        };
        for (const [id, delta] of Object.entries(adjustments)) {
          const input = this.element<HTMLInputElement>("#videoAr" + id);
          input.value = ((alreadyCalibrated ? Number(input.value) || 0 : 0) + delta).toFixed(6);
        }
        this.element<HTMLInputElement>("#videoArEnableCalibration").checked = true;
        result.session.applicationStatus = "applied";
        result.session.appliedAt = new Date().toISOString();
        const sessionIndex = this.calibrationSessions.findIndex(session => session.id === result.session.id);
        if (sessionIndex >= 0) this.calibrationSessions[sessionIndex] = structuredClone(result.session);
        this.refreshCurrentGeometry(); this.updateControls(); this.saveReplayControls();
        this.notify("配准已应用：拟合 RMS " + result.rmsePx.toFixed(2) + " 像素；独立检查点结果见已保存记录，尚未验收");
      },
    });
    this.bindUi();
  }

  setPanelActive(active: boolean) {
    this.panelActive = active;
    this.dataSource.show = active;
    if (!active) this.controlPointPicker?.cancel();
    if (!active && this.playing) this.pause();
    if (!active) {
      this.cancelPendingProjectionUpdates();
      this.projectionAtomicSwapPending = false;
      this.clearLiveGeometryTimer();
      this.clearLiveFrameQueue();
      this.cameraInteracting = false;
      if (this.cameraResumeTimer) window.clearTimeout(this.cameraResumeTimer);
      this.cameraResumeTimer = 0;
    }
    if (active) {
      if (this.liveState && (this.statusSocket || this.videoSocket)) this.scheduleLiveSceneUpdate(true);
      if (this.latestLiveFrame && this.videoSocket) this.scheduleLiveDecode();
      if (this.points.length) {
        this.updateAtPlayback(this.playbackMs, true);
        if (this.videoObjectUrl && this.video.readyState >= 2) this.drawTexture(this.video);
        this.viewer.scene.requestRender();
      }
    }
    this.applyVisibility();
  }

  clear() {
    this.calibrationSessions = [];
    this.effectiveCamera = undefined;
    this.committedModelCamera = undefined;
    this.activeTextureFrame = undefined;
    this.committedModelTextureFrame = undefined;
    this.currentBitmapFrame = undefined;
    this.controlPointPicker?.restoreLastSession();
    this.calibrationFrame = undefined;
    this.modelProjectionFrame = undefined;
    this.modelProjectionAllowed = false;
    this.modelProjector?.setEnabled(false);
    this.loadGeneration += 1;
    this.pause();
    this.disconnectLive();
    this.points = [];
    this.projectionMeshPoints = [];
    this.projectionMeshVideoPoints = [];
    this.projectionSource = "none";
    this.requireExactFootprint = false;
    this.independentDjiPoseProjection = false;
    this.independentVideoExactTimeline = false;
    this.exactMediaBinding = false;
    this.meshSourceVideoDurationMs = undefined;
    this.meshVideoFrameReady = true;
    this.independentDjiPoseProjectionReason = "";
    this.independentVideoFirstTimeMs = 0;
    this.liveTrajectory = [];
    this.currentIndex = -1;
    this.playbackMs = 0;
    this.durationMs = 0;
    this.requestedFrameName = null;
    this.requestedFramePoint = null;
    this.displayedFrameName = null;
    this.displayedFramePoint = null;
    this.frameRequestVersion += 1;
    this.resetStaticFrameGeometryRetry();
    this.frameBlobCache.clear();
    this.footprintPositionCache.clear();
    this.projectionMeshSurfaceCache.clear();
    this.automaticGroundHeight = undefined;
    this.liveGroundHeight = undefined;
    this.djiProjectionGroundHeight = undefined;
    this.liveState = null;
    this.liveStatusDeviceSn = undefined;
    this.liveVideoDeviceSn = undefined;
    this.livePoseHistory = [];
    this.liveFramePose = null;
    this.liveFrameTimestampMs = undefined;
    this.liveFrameFootprint = undefined;
    this.liveFrameProjectionMesh = undefined;
    this.liveRequiresExactFootprint = false;
    this.liveRequiresProjectionMesh = false;
    this.lastLiveMessageParseTime = 0;
    this.lastLiveTrajectoryRenderTime = 0;
    this.automaticGroundHeight = undefined;
    this.liveGroundHeight = undefined;
    this.djiProjectionGroundHeight = undefined;
    this.cameraInteracting = false;
    if (this.cameraResumeTimer) window.clearTimeout(this.cameraResumeTimer);
    this.cameraResumeTimer = 0;
    this.removeProjectionPrimitive();
    this.dataSource.entities.removeAll();
    this.droneEntity = undefined;
    this.trajectoryEntity = undefined;
    this.projectionVisible = false;
    this.frustumRaysEntity = undefined;
    this.frustumOutlineEntity = undefined;
    this.cameraAxisEntity = undefined;
    this.releaseVideo();
    this.clearCanvases();
    this.setBusy(false);
    this.updateControls();
    this.setStatus("AR 场景已清除");
    this.viewer.scene.requestRender();
  }

  destroy() {
    this.removeProjectionPostRenderListener();
    this.removeTerrainProgressListener();
    this.removeTerrainProviderListener();
    window.clearTimeout(this.terrainRefreshTimer);
    this.removeCameraMoveStartListener();
    this.removeCameraMoveEndListener();
    this.clear();
    this.controlPointPicker?.destroy();
    this.modelProjector?.destroy();
    this.abortController.abort();
    this.viewer.dataSources.remove(this.dataSource, true);
    if (!this.projectionMaterial.isDestroyed()) this.projectionMaterial.destroy();
  }

  private element<T extends Element>(selector: string) {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`视频 AR 界面缺少元素：${selector}`);
    return element;
  }

  private bindUi() {
    const signal = this.abortController.signal;
    this.element<HTMLInputElement>("#videoArZipFile").addEventListener("change", () => void this.prepareZip(), { signal });
    this.element<HTMLInputElement>("#videoArTrajectoryFile").addEventListener("change", (event) => {
      this.newReplaySelection();
      this.trajectoryFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
      this.element("#videoArTrajectorySelection").textContent = this.trajectoryFile?.name ?? "尚未选择轨迹";
      if (this.trajectoryFile) {
        this.zipReader = null;
        this.resetGeoreferenceSelection();
      }
    }, { signal });
    this.element<HTMLInputElement>("#videoArVideoFile").addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const selected = input.files?.[0] ?? null;
      if (selected && this.zipReader) {
        input.value = "";
        this.videoFile = null;
        this.element("#videoArVideoSelection").textContent = "ZIP 模式固定使用 ZIP 内同步帧；独立视频未接入";
        this.setStatus("为防止跨航次错配，独立视频不能覆盖 ZIP 内同步帧", true);
        return;
      }
      this.newReplaySelection();
      this.videoFile = selected;
      this.element("#videoArVideoSelection").textContent = this.videoFile?.name ?? "也可使用轨迹中的逐帧图片";
    }, { signal });
    this.element<HTMLInputElement>("#videoArFramesDirectory").addEventListener("change", (event) => {
      this.frameFiles.clear();
      const files = [...((event.currentTarget as HTMLInputElement).files ?? [])];
      for (const file of files) {
        this.frameFiles.set(file.name, file);
        const relative = file.webkitRelativePath.replaceAll("\\", "/");
        if (relative) {
          this.frameFiles.set(relative, file);
          const videoFramesIndex = relative.toLowerCase().lastIndexOf("/video_frames/");
          if (videoFramesIndex >= 0) this.frameFiles.set(relative.slice(videoFramesIndex + "/video_frames/".length), file);
        }
      }
      this.element("#videoArFramesSelection").textContent = files.length ? `已索引 ${files.length.toLocaleString()} 个文件` : "选择包含 video_frames 的目录";
    }, { signal });
    this.element<HTMLInputElement>("#videoArGeoreferenceFile").addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const selected = input.files?.[0] ?? null;
      if (selected && /(?:全部元数据|Cesium轨迹)/i.test(selected.name)) {
        input.value = "";
        this.georeferenceFile = null;
        this.element("#videoArGeoreferenceSelection").textContent = `已忽略 ${selected.name}：它不是三维配准 sidecar`;
        this.setStatus("文件用途不匹配：请把 *_Cesium轨迹*.json 选到“轨迹 JSON”，配准文件没有时留空", true);
        return;
      }
      this.georeferenceFile = selected;
      this.element("#videoArGeoreferenceSelection").textContent = this.georeferenceFile?.name
        ?? "优先 EPSG:4979 可见表面网格；兼容每帧 TL/TR/BR/BL 四角";
    }, { signal });
    this.element("#videoArClearGeoreference").addEventListener("click", () => {
      this.resetGeoreferenceSelection();
      this.setStatus("三维配准文件已清除；可继续加载轨迹和视频");
    }, { signal });
    this.element("#videoArLoad").addEventListener("click", () => void this.loadSelectedSource(), { signal });
    this.element("#videoArLocate").addEventListener("click", () => this.locate(), { signal });
    this.element("#videoArClear").addEventListener("click", () => this.clear(), { signal });
    this.element("#videoArPlay").addEventListener("click", () => void (this.playing ? this.pause() : this.play()), { signal });
    this.element("#videoArPrevious").addEventListener("click", () => this.step(-1), { signal });
    this.element("#videoArNext").addEventListener("click", () => this.step(1), { signal });
    this.element<HTMLInputElement>("#videoArProgress").addEventListener("input", (event) => {
      this.pause();
      const ratio = finite((event.currentTarget as HTMLInputElement).value) / 1000;
      this.seek(ratio * this.durationMs);
    }, { signal });
    this.element<HTMLSelectElement>("#videoArSpeed").addEventListener("change", () => {
      this.video.playbackRate = this.playbackSpeed();
    }, { signal });
    for (const selector of [
      "#videoArHfov", "#videoArVfov", "#videoArHeightOffset", "#videoArGroundHeight",
      "#videoArFallbackDistance", "#videoArTerrain", "#videoArAutoGround", "#videoArAbsoluteGimbal",
      "#videoArYawCorrection", "#videoArPitchCorrection", "#videoArFootprintScale",
      "#videoArTimeOffset", "#videoArEastOffset", "#videoArNorthOffset", "#videoArLockAspect",
      "#videoArHeightMode", "#videoArSourceHeightOffset", "#videoArEnableCalibration", "#videoArRollCorrection", "#videoArTakeoffHeight", "#videoArSurfaceHeight", "#videoArSurfaceMode",
      "#videoArCameraFx", "#videoArCameraFy", "#videoArCameraCx", "#videoArCameraCy",
      "#videoArK1", "#videoArK2", "#videoArK3", "#videoArP1", "#videoArP2",
    ]) {
      this.element(selector).addEventListener("change", () => { this.refreshCurrentGeometry(); this.updateControls(); this.saveReplayControls(); }, { signal });
    }
    this.element("#videoArDepthDiagnostic").addEventListener("change", () => this.updateDepthDiagnostic(), { signal });
    this.element("#videoArExportDiagnostics").addEventListener("click", () => this.exportDiagnostics(), { signal });
    this.element("#videoArShowModels").addEventListener("click", () => {
      const count = this.onShowProjectionModels?.() ?? 0;
      if (!count) { this.notify("请先在工程模型中加载覆盖视频区域的倾斜摄影模型", true); return; }
      this.element<HTMLSelectElement>("#videoArSurfaceMode").value = "model";
      this.element<HTMLInputElement>("#videoArTerrain").checked = true;
      this.refreshCurrentGeometry(); this.updateControls(); this.saveReplayControls();
      this.notify("已显示 " + count + " 个倾斜摄影模型；可用同名点校正位置与高度");
    }, { signal });
    this.element("#videoArResetCalibration").addEventListener("click", () => {
      const surfaceMode = this.element<HTMLSelectElement>("#videoArSurfaceMode").value;
      this.resetCalibration();
      this.element<HTMLSelectElement>("#videoArSurfaceMode").value = surfaceMode;
      this.refreshCurrentGeometry(); this.updateControls(); this.saveReplayControls();
    }, { signal });
    this.element<HTMLInputElement>("#videoArShowFrustum").addEventListener("change", () => this.applyVisibility(), { signal });
    this.element<HTMLInputElement>("#videoArShowTrajectory").addEventListener("change", () => this.applyVisibility(), { signal });
    this.element("#videoArConnectLive").addEventListener("click", () => {
      if (this.statusSocket || this.videoSocket) this.disconnectLive();
      else this.connectLive();
    }, { signal });
  }

  private async prepareZip(savedFile?: File) {
    const file = savedFile ?? this.element<HTMLInputElement>("#videoArZipFile").files?.[0];
    if (!file) return;
    if (!savedFile) this.newReplaySelection();
    const generation = ++this.loadGeneration;
    this.pause();
    this.setBusy(true, "正在索引 ZIP（不会整体解压）…");
    try {
      const reader = await BrowserZipReader.open(file);
      if (generation !== this.loadGeneration) return;
      const trajectories = [...reader.entries.keys()].filter((name) => /(^|\/)trajectory_[^/]*\.json$/i.test(name)).sort();
      if (!trajectories.length) throw new Error("ZIP 中未找到 trajectory_*.json");
      this.zipReader = reader;
      this.replayZipFile = file;
      this.trajectoryFile = null;
      this.videoFile = null;
      this.resetGeoreferenceSelection();
      this.element<HTMLInputElement>("#videoArVideoFile").value = "";
      this.element("#videoArVideoSelection").textContent = "ZIP 模式固定使用 ZIP 内同步帧";
      const select = this.element<HTMLSelectElement>("#videoArFlightSelect");
      select.replaceChildren(...trajectories.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name.split("/").slice(-2).join(" / ");
        return option;
      }));
      this.element("#videoArFlightField").classList.remove("hidden");
      this.element("#videoArZipSelection").textContent = `${file.name} · ${trajectories.length} 条飞行记录`;
      this.setStatus("ZIP 索引完成，点击“加载并定位”开始回放");
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.zipReader = null;
      this.element("#videoArFlightField").classList.add("hidden");
      this.reportError("飞行数据 ZIP 读取失败", error);
    } finally {
      if (generation === this.loadGeneration) this.setBusy(false);
    }
  }

  private resetGeoreferenceSelection() {
    this.georeferenceFile = null;
    this.element<HTMLInputElement>("#videoArGeoreferenceFile").value = "";
    this.element("#videoArGeoreferenceSelection").textContent = "优先 EPSG:4979 可见表面网格；兼容每帧 TL/TR/BR/BL 四角";
  }

  private async loadSelectedSource() {
    this.replaySelectionPending = true;
    this.invalidateCameraFrame();
    this.replaySettingsReady = false;
    const generation = ++this.loadGeneration;
    this.pause();
    this.disconnectLive();
    this.removeProjectionPrimitive();
    this.points = [];
    this.projectionMeshPoints = [];
    this.projectionMeshVideoPoints = [];
    this.projectionSource = "none";
    this.releaseVideo();
    this.clearCanvases();
    this.frameBlobCache.clear();
    this.footprintPositionCache.clear();
    this.projectionMeshSurfaceCache.clear();
    this.projectionSource = "none";
    this.requireExactFootprint = false;
    this.independentDjiPoseProjection = false;
    this.independentVideoExactTimeline = false;
    this.exactMediaBinding = false;
    this.meshSourceVideoDurationMs = undefined;
    this.meshVideoFrameReady = true;
    this.independentDjiPoseProjectionReason = "";
    this.independentVideoFirstTimeMs = 0;
    this.setBusy(true, "正在校验轨迹与媒体索引…");
    this.setApplicationStatus("正在加载视频 AR 数据…");
    try {
      let text: string;
      let label: string;
      let projectionSource: ProjectionSource;
      let trajectoryEntry: string | undefined;
      this.zipFramePrefix = "";
      if (this.zipReader) {
        const entry = this.element<HTMLSelectElement>("#videoArFlightSelect").value;
        if (!entry) throw new Error("请选择 ZIP 内的飞行记录");
        trajectoryEntry = entry;
        text = await this.zipReader.readText(entry);
        label = entry.split("/").slice(-2, -1)[0] ?? "飞行记录";
        this.zipFramePrefix = `${entry.slice(0, entry.lastIndexOf("/") + 1)}video_frames/`;
        projectionSource = "zip-frames";
      } else if (this.trajectoryFile) {
        text = await this.trajectoryFile.text();
        label = this.trajectoryFile.name.replace(/\.json$/i, "");
        projectionSource = this.videoFile
          ? "independent-video"
          : this.frameFiles.size
            ? "directory-frames"
            : "none";
      } else {
        throw new Error("请先选择飞行数据 ZIP 或轨迹 JSON");
      }
      if (generation !== this.loadGeneration) return;
      const parsed = JSON.parse(text) as unknown;
      const points = parseVideoArTrajectory(parsed);
      const metadata = trajectoryMetadata.get(points);
      const externalGeoreferenceAttached = await this.attachSelectedGeoreference(points, trajectoryEntry, generation);
      if (!externalGeoreferenceAttached && metadata?.embeddedFootprints.items.length) {
        this.validateProjectionVideoIdentity(
          metadata.embeddedFootprints.sourceVideo,
          metadata.sourceVideoDataset,
          "轨迹 JSON 内嵌地理角点",
          true,
        );
      }
      if (generation !== this.loadGeneration) return;
      if (!this.zipReader && this.videoFile) await this.prepareVideo(this.videoFile, generation);
      else this.releaseVideo();
      if (generation !== this.loadGeneration) return;
      this.projectionSource = projectionSource;
      await this.initializeFlight(points, label, generation);
      if (generation === this.loadGeneration && !this.restoringReplay && this.onReplayLoaded) {
        this.setStatus("正在保存回放文件，完成前请不要退出…");
        await this.onReplayLoaded(this.snapshotReplay(label));
        if (generation !== this.loadGeneration) return;
        this.setStatus("回放已保存到本机");
      }
      if (generation === this.loadGeneration) { this.replaySettingsReady = true; this.saveReplayControls(); }
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.resetFailedLoadState();
      this.reportError("视频 AR 加载失败", error);
    } finally {
      if (generation === this.loadGeneration) {
        this.setBusy(false);
        this.setApplicationStatus("Cesium 已就绪");
      }
    }
  }

  private resetFailedLoadState() {
    this.invalidateCameraFrame();
    this.pause();
    this.removeProjectionPrimitive();
    this.dataSource.entities.removeAll();
    this.points = [];
    this.projectionMeshPoints = [];
    this.projectionMeshVideoPoints = [];
    this.requireExactFootprint = false;
    this.independentDjiPoseProjection = false;
    this.independentVideoExactTimeline = false;
    this.exactMediaBinding = false;
    this.meshSourceVideoDurationMs = undefined;
    this.meshVideoFrameReady = true;
    this.independentDjiPoseProjectionReason = "";
    this.independentVideoFirstTimeMs = 0;
    this.currentIndex = -1;
    this.playbackMs = 0;
    this.durationMs = 0;
    this.requestedFrameName = null;
    this.requestedFramePoint = null;
    this.displayedFrameName = null;
    this.displayedFramePoint = null;
    this.frameRequestVersion += 1;
    this.frameBlobCache.clear();
    this.footprintPositionCache.clear();
    this.projectionMeshSurfaceCache.clear();
    this.droneEntity = undefined;
    this.trajectoryEntity = undefined;
    this.frustumRaysEntity = undefined;
    this.frustumOutlineEntity = undefined;
    this.cameraAxisEntity = undefined;
    this.releaseVideo();
    this.clearCanvases();
    this.updateControls();
    this.viewer.scene.requestRender();
  }

  private validateProjectionVideoIdentity(
    identity: GeoProjectionVideoIdentity | undefined,
    dataset: DjiSrtDataset | undefined,
    label: string,
    allowTrajectoryDatasetFallback: boolean,
  ) {
    if (identity && dataset) {
      const toleranceMs = Math.max(500, 3_000 / dataset.videoFrameRateFps);
      if (
        identity.fileName.trim().toLocaleLowerCase() !== dataset.sourceVideoFile.trim().toLocaleLowerCase()
        || identity.sizeBytes !== dataset.videoSizeBytes
        || Math.abs(identity.durationMs - dataset.videoDurationMs) > toleranceMs
      ) throw new Error(`${label} 的 source_video 与轨迹根级视频身份不一致`);
    }
    if (!this.videoFile) return;
    const effectiveIdentity = identity ?? (allowTrajectoryDatasetFallback && dataset
      ? {
          fileName: dataset.sourceVideoFile,
          sizeBytes: dataset.videoSizeBytes,
          durationMs: dataset.videoDurationMs,
        }
      : undefined);
    if (!effectiveIdentity) {
      throw new Error(`${label} 必须声明 source_video.file_name、size_bytes 和 duration_ms，已阻止跨视频错配`);
    }
    const selectedName = this.videoFile.name.trim().toLocaleLowerCase();
    const declaredName = effectiveIdentity.fileName.trim().toLocaleLowerCase();
    if (selectedName !== declaredName || this.videoFile.size !== effectiveIdentity.sizeBytes) {
      throw new Error(`${label} 属于 ${effectiveIdentity.fileName}，与当前所选视频不一致`);
    }
    this.meshSourceVideoDurationMs = effectiveIdentity.durationMs;
  }

  private async attachSelectedGeoreference(points: FlightPoint[], trajectoryEntry: string | undefined, generation: number) {
    let buffer: ArrayBuffer | undefined;
    let label = "";
    if (this.georeferenceFile) {
      if (this.georeferenceFile.size > MAX_GEOREFERENCE_FILE_BYTES) {
        throw new Error("三维配准 JSON 超过 64MB；为防止页面卡死，请按时间分块或改用二进制 sidecar");
      }
      buffer = await this.georeferenceFile.arrayBuffer();
      label = this.georeferenceFile.name;
    } else if (this.zipReader && trajectoryEntry) {
      const directory = trajectoryEntry.slice(0, trajectoryEntry.lastIndexOf("/") + 1);
      const candidates = [...this.zipReader.entries.keys()]
        .filter((name) => name.startsWith(directory) && /(^|\/)(?:frame_footprints|video_frame_corners|ground_footprints|frame_georeference|frame_projection_meshes|video_projection_mesh)[^/]*\.json$/i.test(name))
        .sort();
      if (candidates.length > 1) throw new Error("ZIP 内存在多个逐帧三维配准文件，请只保留一个或在界面中明确选择");
      if (candidates[0]) {
        const sidecarBlob = await this.zipReader.readBlob(candidates[0], "application/json");
        if (sidecarBlob.size > MAX_GEOREFERENCE_FILE_BYTES) {
          throw new Error("ZIP 内三维配准 JSON 超过 64MB；请按时间分块");
        }
        buffer = await sidecarBlob.arrayBuffer();
        label = candidates[0].split("/").pop() ?? candidates[0];
      }
    }
    if (!buffer || generation !== this.loadGeneration) return false;
    const parsed = await parseGeoreferenceSidecarOffMainThread(buffer);
    if (generation !== this.loadGeneration) return;
    const footprintCollection = parsed.footprints;
    const meshCollection = parsed.meshes;
    if (!footprintCollection.items.length && !meshCollection.items.length) {
      if (parsed.kind.schemaVersion === "dji-video-telemetry/v1" || parsed.kind.hasTelemetry) {
        throw new Error(`${label} 是提取器的“全部元数据”，不是三维配准文件；请选择 *_Cesium轨迹*.json 作为轨迹，配准项留空`);
      }
      if (parsed.kind.hasTrajectoryPoints) {
        throw new Error(`${label} 是轨迹 JSON，不是三维配准 sidecar；请将它选择到“轨迹 JSON”`);
      }
      throw new Error(`${label} 中没有逐帧 EPSG:4979 控制网格或 WGS84 地理角点`);
    }
    const identity = meshCollection.items.length ? meshCollection.sourceVideo : footprintCollection.sourceVideo;
    const dataset = trajectoryMetadata.get(points)?.sourceVideoDataset;
    this.validateProjectionVideoIdentity(identity, dataset, label, false);
    // An explicitly selected sidecar is the sole exact-georeference source.
    // Do not silently fill its gaps with unverified embedded corner planes.
    for (const point of points) point.groundFootprint = undefined;
    let matchedFootprints = 0;
    let matchedMeshes = 0;
    const usedFootprints = new Set<GeoFootprint>();
    const usedMeshes = new Set<GeoProjectionMesh>();
    for (const point of points) {
      const footprint = matchGeoFootprint(
        footprintCollection,
        point.videoFrame,
        point.videoFrameTimestampMs ?? point.timestampMs,
        MAX_FRAME_POSE_DELTA_MS,
      );
      if (footprint && !usedFootprints.has(footprint)) {
        point.groundFootprint = footprint;
        usedFootprints.add(footprint);
        matchedFootprints += 1;
      }
      const mesh = matchGeoProjectionMesh(
        meshCollection,
        point.videoSampleIndex,
        point.videoFrame,
        point.videoTimeMs,
        point.videoFrameTimestampMs ?? point.timestampMs,
        MAX_MESH_FRAME_DELTA_MS,
      );
      if (mesh && !usedMeshes.has(mesh)) {
        point.projectionMesh = mesh;
        usedMeshes.add(mesh);
        matchedMeshes += 1;
      }
    }
    if (!matchedFootprints && !matchedMeshes) throw new Error(`${label} 的视频样本/帧名/PTS 与当前轨迹不匹配，已阻止跨航次投影`);
    if (usedMeshes.size !== meshCollection.items.length || usedFootprints.size !== footprintCollection.items.length) {
      throw new Error(`${label} 含有无法一一匹配当前轨迹的配准帧，已拒绝部分覆盖或跨视频数据`);
    }
    this.element("#videoArGeoreferenceSelection").textContent = [
      label,
      matchedMeshes ? `三维网格 ${matchedMeshes.toLocaleString()} 帧` : "",
      matchedFootprints ? `四角 ${matchedFootprints.toLocaleString()} 帧` : "",
    ].filter(Boolean).join(" · ");
    return true;
  }

  private async prepareVideo(file: File, generation: number) {
    this.releaseVideo();
    this.awaitingDecodedTexture = true;
    const url = URL.createObjectURL(file);
    this.videoObjectUrl = url;
    this.video.src = url;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.load();
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          this.video.removeEventListener("loadedmetadata", loaded);
          this.video.removeEventListener("error", failed);
          if (error) reject(error); else resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error("浏览器无法解码该视频格式"));
        this.video.addEventListener("loadedmetadata", loaded, { once: true });
        this.video.addEventListener("error", failed, { once: true });
        if (this.video.readyState >= 1) finish();
      });
    } catch (error) {
      if (this.videoObjectUrl === url) this.releaseVideo();
      throw error;
    }
    if (generation !== this.loadGeneration) {
      this.releaseVideo();
      return;
    }
    this.mediaSourceWidth = this.video.videoWidth;
    this.mediaSourceHeight = this.video.videoHeight;
    let frameCallback = 0;
    this.usesDecodedFrameCallbacks = typeof this.video.requestVideoFrameCallback === "function";
    const drawFirstDecodedFrame = (forceUpload = false) => {
      if (generation !== this.loadGeneration || this.videoObjectUrl !== url || this.video.readyState < 2) return;
      if (this.usesDecodedFrameCallbacks && !Number.isFinite(this.decodedVideoTime)) return;
      if (this.points.length && this.projectionSource === "independent-video") {
        this.updateAtPlayback(this.playbackMs, true);
      }
      this.drawTexture(this.video, forceUpload);
    };
    const decoded = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (generation !== this.loadGeneration || this.videoObjectUrl !== url) return;
      this.decodedVideoTime = metadata.mediaTime;
      frameCallback = this.video.requestVideoFrameCallback(decoded);
      const interval = 1000 / Math.min(this.targetFps(), MAX_CONTINUOUS_GEOMETRY_FPS);
      if (this.points.length && this.panelActive && !this.cameraInteracting && !this.video.seeking
          && (!this.playing || now - this.lastProjectionUpdate >= interval || this.awaitingDecodedTexture)) {
        this.lastProjectionUpdate = now;
        this.updateAtPlayback(this.playbackMs, !this.playing);
        this.drawTexture(this.video, !this.playing);
        this.viewer.scene.requestRender();
      }
    };
    if (this.usesDecodedFrameCallbacks) frameCallback = this.video.requestVideoFrameCallback(decoded);
    const seeking = () => {
      this.decodedVideoTime = Number.NaN;
      this.awaitingDecodedTexture = true;
      this.cancelPendingProjectionUpdates();
    };
    this.video.addEventListener("seeking", seeking);
    const loadedData = () => drawFirstDecodedFrame();
    const seeked = () => drawFirstDecodedFrame(true);
    this.video.addEventListener("seeked", seeked);
    this.removePreparedVideoListeners = () => {
      if (frameCallback) this.video.cancelVideoFrameCallback(frameCallback);
      this.video.removeEventListener("seeking", seeking);
      this.video.removeEventListener("loadeddata", loadedData);
      this.video.removeEventListener("seeked", seeked);
    };
    if (this.video.readyState >= 2) drawFirstDecodedFrame();
    else this.video.addEventListener("loadeddata", loadedData, { once: true });
  }

  private validateIndependentDjiPoseProjection(points: FlightPoint[]): {
    enabled: boolean;
    reason: string;
    firstVideoTimeMs?: number;
  } {
    if (this.projectionSource !== "independent-video" || !this.videoFile || !this.videoObjectUrl) {
      return { enabled: false, reason: "未选择独立视频" };
    }
    const posePoints = points.filter((point) => point.djiSrtPoseProjection);
    if (posePoints.length !== points.length) {
      return {
        enabled: false,
        reason: `DJI SRT 投影字段不完整（有效 ${posePoints.length.toLocaleString()} / ${points.length.toLocaleString()} 帧）`,
      };
    }
    const firstPose = points[0].djiSrtPoseProjection!;
    const dataset = firstPose.dataset;
    if (dataset.videoFrameCount !== points.length) {
      return {
        enabled: false,
        reason: `视频声明 ${dataset.videoFrameCount.toLocaleString()} 帧，但轨迹只有 ${points.length.toLocaleString()} 帧`,
      };
    }
    const selectedName = this.videoFile.name.trim().toLocaleLowerCase();
    const declaredName = dataset.sourceVideoFile.trim().toLocaleLowerCase();
    if (selectedName !== declaredName || this.videoFile.size !== dataset.videoSizeBytes) {
      return { enabled: false, reason: "所选视频与轨迹 JSON 中记录的 DJI 源视频不一致" };
    }
    if (this.video.videoWidth !== dataset.videoWidth || this.video.videoHeight !== dataset.videoHeight) {
      return {
        enabled: false,
        reason: `视频分辨率 ${this.video.videoWidth}×${this.video.videoHeight} 与提取结果 ${dataset.videoWidth}×${dataset.videoHeight} 不一致`,
      };
    }
    const browserDurationMs = this.video.duration * 1000;
    const durationToleranceMs = Math.max(500, 3_000 / dataset.videoFrameRateFps);
    if (!Number.isFinite(browserDurationMs) || Math.abs(browserDurationMs - dataset.videoDurationMs) > durationToleranceMs) {
      return { enabled: false, reason: "视频时长与 DJI 提取结果不一致，已阻止跨视频错配" };
    }
    let previousVideoTimeMs = -1;
    let previousTimestampMs = Number.NaN;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const pose = point.djiSrtPoseProjection!;
      if (
        pose.dataset.sourceVideoFile !== dataset.sourceVideoFile
        || pose.dataset.videoSizeBytes !== dataset.videoSizeBytes
        || pose.videoSampleIndex !== index
        || (index > 0 && pose.videoTimeMs <= previousVideoTimeMs)
      ) return { enabled: false, reason: `第 ${(index + 1).toLocaleString()} 帧的 PTS/样本序号不连续` };
      if (index > 0) {
        const videoDeltaMs = pose.videoTimeMs - previousVideoTimeMs;
        const timestampDeltaMs = point.timestampMs - previousTimestampMs;
        if (videoDeltaMs > MAX_DJI_SRT_POSE_GAP_MS || Math.abs(videoDeltaMs - timestampDeltaMs) > 2) {
          return { enabled: false, reason: `第 ${(index + 1).toLocaleString()} 帧存在不可信的 PTS 间隔` };
        }
      }
      previousVideoTimeMs = pose.videoTimeMs;
      previousTimestampMs = point.timestampMs;
    }
    const lastPose = points[points.length - 1].djiSrtPoseProjection!;
    const endCoverageGapMs = dataset.videoDurationMs - lastPose.videoTimeMs;
    if (firstPose.videoTimeMs > MAX_DJI_SRT_POSE_GAP_MS || endCoverageGapMs < 0 || endCoverageGapMs > durationToleranceMs) {
      return { enabled: false, reason: "DJI SRT PTS 没有完整覆盖所选视频" };
    }
    return { enabled: true, reason: "", firstVideoTimeMs: firstPose.videoTimeMs };
  }

  private validateIndependentExactTimeline(
    points: FlightPoint[],
    djiValidation: { enabled: boolean; reason: string; firstVideoTimeMs?: number },
  ): { enabled: boolean; reason: string; firstVideoTimeMs?: number } {
    if (djiValidation.enabled) return djiValidation;
    if (this.projectionSource !== "independent-video" || !this.videoFile || !this.videoObjectUrl) {
      return { enabled: false, reason: "未选择独立视频" };
    }
    const trajectoryStart = points[0].timestampMs;
    const anchors = points.flatMap((point) => {
      const videoTimeMs = point.videoTimeMs ?? point.projectionMesh?.videoTimeMs;
      return videoTimeMs === undefined ? [] : [{ point, videoTimeMs }];
    });
    if (anchors.length < 2) return { enabled: false, reason: "精确配准至少需要两个覆盖视频时间线的 video_time_ms 锚点" };
    let previousVideoTime = -1;
    let previousTimestamp = Number.NaN;
    let videoOriginMs = Number.NaN;
    for (let index = 0; index < anchors.length; index += 1) {
      const { point, videoTimeMs: videoTime } = anchors[index];
      if (!Number.isFinite(videoTime) || videoTime < 0 || (index > 0 && videoTime <= previousVideoTime)) {
        return { enabled: false, reason: `第 ${(index + 1).toLocaleString()} 个 video_time_ms 不连续` };
      }
      const currentOrigin = videoTime - (point.timestampMs - trajectoryStart);
      if (index === 0) videoOriginMs = currentOrigin;
      else if (Math.abs(currentOrigin - videoOriginMs) > MAX_MESH_FRAME_DELTA_MS) {
        return { enabled: false, reason: `第 ${(index + 1).toLocaleString()} 个 PTS 与轨迹绝对时间不一致` };
      }
      if (index > 0) {
        const videoDelta = videoTime - previousVideoTime;
        const telemetryDelta = point.timestampMs - previousTimestamp;
        const tolerance = Math.max(5, Math.min(50, videoDelta * 0.02));
        if (Math.abs(videoDelta - telemetryDelta) > tolerance) {
          return { enabled: false, reason: `第 ${(index + 1).toLocaleString()} 个 PTS 与轨迹时间不一致` };
        }
      }
      previousVideoTime = videoTime;
      previousTimestamp = point.timestampMs;
    }
    const browserDurationMs = this.video.duration * 1000;
    const trajectoryDurationMs = points[points.length - 1].timestampMs - trajectoryStart;
    const coverageTolerance = Math.max(
      500,
      Math.min(2_000, 2 * (anchors[anchors.length - 1].videoTimeMs - anchors[anchors.length - 2].videoTimeMs)),
    );
    if (
      !Number.isFinite(browserDurationMs)
      || videoOriginMs < -MAX_MESH_FRAME_DELTA_MS
      || videoOriginMs > coverageTolerance
      || Math.abs(browserDurationMs - (videoOriginMs + trajectoryDurationMs)) > coverageTolerance
    ) return { enabled: false, reason: "video_time_ms 未完整覆盖所选视频" };
    return { enabled: true, reason: "", firstVideoTimeMs: videoOriginMs };
  }

  private async initializeFlight(points: FlightPoint[], label: string, generation: number) {
    await this.dataSourceReady;
    if (generation !== this.loadGeneration) return;
    if (this.videoObjectUrl && this.meshSourceVideoDurationMs !== undefined) {
      const decodedDurationMs = this.video.duration * 1000;
      if (!Number.isFinite(decodedDurationMs) || Math.abs(decodedDurationMs - this.meshSourceVideoDurationMs) > 500) {
        throw new Error("三维网格 source_video.duration_ms 与浏览器解码视频不一致，已阻止跨视频错配");
      }
    }
    // Validate into local state first. No partially accepted trajectory may be
    // reachable from playback controls if an identity/coverage check throws.
    const projectionMeshPoints = points.filter((point) => point.projectionMesh);
    const projectionMeshVideoPoints = projectionMeshPoints
      .filter((point) => point.videoTimeMs !== undefined || point.projectionMesh?.videoTimeMs !== undefined)
      .sort((left, right) => (
        (left.projectionMesh?.videoTimeMs ?? left.videoTimeMs!)
        - (right.projectionMesh?.videoTimeMs ?? right.videoTimeMs!)
      ));
    const exactFootprintPoints = points.filter((point) => point.groundFootprint).length;
    const exactMeshPoints = points.filter((point) => point.projectionMesh).length;
    const exactGeoreferencePoints = points.filter((point) => point.projectionMesh || point.groundFootprint).length;
    const djiTimelineValidation = this.validateIndependentDjiPoseProjection(points);
    if (
      this.videoObjectUrl
      && exactGeoreferencePoints > 0
      && !djiTimelineValidation.enabled
      && this.meshSourceVideoDurationMs === undefined
    ) throw new Error("独立视频精确配准缺少可验证的 source_video 身份");
    const exactTimelineValidation = exactGeoreferencePoints
      ? this.validateIndependentExactTimeline(points, djiTimelineValidation)
      : djiTimelineValidation;
    if (this.videoObjectUrl && exactMeshPoints > 0 && !exactTimelineValidation.enabled) {
      throw new Error(`三维网格视频时间线校验失败：${exactTimelineValidation.reason}`);
    }
    if (this.videoObjectUrl && exactMeshPoints > 0) {
      const meshTimes = projectionMeshVideoPoints.map((point) => point.projectionMesh?.videoTimeMs ?? point.videoTimeMs!);
      const decodedDurationMs = this.video.duration * 1000;
      const maximumGap = meshTimes.slice(1).reduce(
        (largest, time, index) => Math.max(largest, time - meshTimes[index]),
        0,
      );
      if (
        meshTimes.length < 2
        || meshTimes[0] > MAX_MESH_PLAYBACK_HOLD_MS
        || Math.abs(decodedDurationMs - meshTimes[meshTimes.length - 1]) > MAX_MESH_PLAYBACK_HOLD_MS
        || maximumGap > MAX_MESH_PLAYBACK_HOLD_MS * 2
      ) throw new Error("三维网格 PTS 覆盖不连续；必须逐帧生成，且任意解码时刻距网格不超过 50ms");
    }
    if (this.videoObjectUrl && exactMeshPoints === 0 && exactFootprintPoints > 0 && exactFootprintPoints !== points.length) {
      throw new Error("独立视频 WGS84 四角没有逐轨迹点完整覆盖，已拒绝稀疏角点复用");
    }
    const djiPoseValidation: { enabled: boolean; reason: string; firstVideoTimeMs?: number } = exactGeoreferencePoints === 0
      ? exactTimelineValidation
      : { enabled: false, reason: exactMeshPoints ? "已使用优先级更高的 EPSG:4979 三维控制网格" : "已使用优先级更高的 WGS84 同帧角点" };
    this.removeProjectionPrimitive();
    // removeProjectionPrimitive() cancels stale transactions. Preserve the
    // wait for the newly prepared media so an empty/default texture can never
    // be promoted with the first mesh.
    this.awaitingDecodedTexture = Boolean(
      this.videoObjectUrl && (this.video.readyState < 2 || !this.stableTextureUpload),
    );
    this.dataSource.entities.removeAll();
    this.points = points;
    this.replaySelectionPending = false;
    this.projectionMeshPoints = projectionMeshPoints;
    this.projectionMeshVideoPoints = projectionMeshVideoPoints;
    this.independentDjiPoseProjection = djiPoseValidation.enabled;
    this.independentVideoExactTimeline = exactTimelineValidation.enabled;
    this.exactMediaBinding = Boolean(this.videoObjectUrl && exactGeoreferencePoints && exactTimelineValidation.enabled);
    this.independentDjiPoseProjectionReason = djiPoseValidation.reason;
    this.independentVideoFirstTimeMs = exactTimelineValidation.enabled
      ? exactTimelineValidation.firstVideoTimeMs ?? 0
      : 0;
    this.requireExactFootprint = exactGeoreferencePoints > 0
      || (this.projectionSource === "independent-video" && !this.independentDjiPoseProjection);
    this.automaticGroundHeight = this.estimateGroundHeight(points);
    this.liveGroundHeight = undefined;
    this.djiProjectionGroundHeight = undefined;
    this.currentIndex = -1;
    this.playbackMs = 0;
    this.durationMs = Math.max(0, points[points.length - 1].timestampMs - points[0].timestampMs);
    this.liveTrajectory = [];
    this.frameBlobCache.clear();
    this.footprintPositionCache.clear();
    this.projectionMeshSurfaceCache.clear();
    this.requestedFrameName = null;
    this.requestedFramePoint = null;
    this.displayedFrameName = null;
    this.displayedFramePoint = null;
    this.frameRequestVersion += 1;
    this.createSceneEntities(label);
    this.createTrajectory(points);
    this.seek(0, true);
    this.updateControls();
    this.locate();
    const framePoints = points.filter((point) => point.videoFrame);
    const synchronizedFramePoints = framePoints.filter((point) => this.frameIsSynchronized(point));
    const rejectedFramePoints = framePoints.length - synchronizedFramePoints.length;
    const media = this.videoObjectUrl
      ? exactMeshPoints
        ? `独立视频 · EPSG:4979 三维控制网格 ${exactMeshPoints.toLocaleString()} 帧`
        : exactFootprintPoints
          ? `独立视频 · WGS84 同帧角点 ${exactFootprintPoints.toLocaleString()}`
        : this.independentDjiPoseProjection
          ? `独立视频 · DJI SRT 姿态 + 地形求交 ${points.length.toLocaleString()} 帧（估算）`
          : `独立视频 · 投影已关闭：${this.independentDjiPoseProjectionReason || "无同帧三维配准"}`
      : framePoints.length
        ? `逐帧图片 · 有效 ${synchronizedFramePoints.length.toLocaleString()} · 三维网格 ${exactMeshPoints.toLocaleString()} · WGS84 四角 ${exactFootprintPoints.toLocaleString()} · 拒绝旧帧 ${rejectedFramePoints.toLocaleString()}`
        : "无视频纹理";
    const groundLabel = this.automaticGroundHeight === undefined ? "未识别地表基准" : `自动地表 ${this.automaticGroundHeight.toFixed(2)}m`;
    const projectionUnavailable = this.videoObjectUrl
      ? exactGeoreferencePoints === 0 && !this.independentDjiPoseProjection
      : framePoints.length > 0 && synchronizedFramePoints.length === 0;
    this.setStatus(`已加载 ${points.length.toLocaleString()} 个轨迹点 · ${media} · ${groundLabel}`, projectionUnavailable);
    this.notify("视频 AR 数据已加载");
  }

  private createSceneEntities(label: string) {
    this.droneEntity = this.dataSource.entities.add({
      id: "video-ar-drone",
      name: `${label} · 无人机`,
      position: Cartesian3.ZERO,
      point: {
        color: Color.fromCssColorString("#44e5ff"),
        outlineColor: Color.fromCssColorString("#071826"),
        outlineWidth: 3,
        pixelSize: 11,
        scaleByDistance: new NearFarScalar(100, 1.35, 50_000, 0.55),
        disableDepthTestDistance: 8_000,
      },
      label: {
        text: "视频 AR 相机",
        font: "13px Microsoft YaHei, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        pixelOffset: new Cartesian2(0, -22),
        scaleByDistance: new NearFarScalar(100, 1, 20_000, 0.45),
        disableDepthTestDistance: 8_000,
      },
    });
    this.frustumRaysEntity = this.dataSource.entities.add({
      id: "video-ar-frustum-rays",
      polyline: { positions: [], width: 1.5, material: Color.fromCssColorString("#50d8ff").withAlpha(0.7) },
    });
    this.frustumOutlineEntity = this.dataSource.entities.add({
      id: "video-ar-frustum-outline",
      polyline: { positions: [], width: 2.5, material: Color.fromCssColorString("#ffd35a") },
    });
    this.cameraAxisEntity = this.dataSource.entities.add({
      id: "video-ar-camera-axis",
      polyline: { positions: [], width: 3, material: Color.fromCssColorString("#ff5b66") },
    });
    this.applyVisibility();
  }

  private createTrajectory(points: FlightPoint[]) {
    const stride = Math.max(1, Math.ceil(points.length / MAX_TRAJECTORY_RENDER_POINTS));
    const positions: Cartesian3[] = [];
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      positions.push(Cartesian3.fromDegrees(
        point.longitude,
        point.latitude,
        this.renderedAltitude(point.longitude, point.latitude, point.altitude, point.djiSrtPoseProjection?.relativeAltitudeMeters),
      ));
    }
    const last = points[points.length - 1];
    const lastPosition = Cartesian3.fromDegrees(
      last.longitude,
      last.latitude,
      this.renderedAltitude(last.longitude, last.latitude, last.altitude, last.djiSrtPoseProjection?.relativeAltitudeMeters),
    );
    if (!positions.length || !Cartesian3.equals(positions[positions.length - 1], lastPosition)) positions.push(lastPosition);
    this.trajectoryEntity = this.dataSource.entities.add({
      id: "video-ar-trajectory",
      name: "视频 AR 飞行轨迹",
      polyline: {
        positions,
        width: 3,
        material: Color.fromCssColorString("#32e3aa").withAlpha(0.92),
      },
    });
    this.applyVisibility();
  }

  private refreshCurrentGeometry() {
    // A terrain/camera refresh can make a pending freeze ready; do not cancel its short wait.
    // A completed selection is invalidated, while source changes still use unconditional cancel().
    this.controlPointPicker?.cancelActiveSelection();
    if (this.points.length) {
      this.createTrajectoryReplacement();
      this.updateAtPlayback(this.playbackMs, true);
      if (this.modelProjectionAllowed && this.videoObjectUrl && this.video.readyState >= 2) this.drawTexture(this.video, true);
    } else if (this.liveState && this.panelActive && this.liveOnline && this.hasOpenStatusSocket()) {
      this.updateSceneGeometry(this.liveFramePose ?? this.liveState, true, "", true, this.liveFrameFootprint, undefined, this.liveFrameProjectionMesh);
    }
  }

  private createTrajectoryReplacement() {
    if (this.trajectoryEntity) this.dataSource.entities.remove(this.trajectoryEntity);
    this.createTrajectory(this.points);
  }

  private numberInput(selector: string, fallback: number) {
    const value = finite(this.element<HTMLInputElement>(selector).value, fallback);
    return Number.isFinite(value) ? value : fallback;
  }

  private optionalNumberInput(selector: string) {
    const raw = this.element<HTMLInputElement>(selector).value.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  private estimateGroundHeight(points: FlightPoint[]) {
    if (!points.length) return undefined;
    const declared = points
      .map((point) => point.groundAltitude)
      .filter((height): height is number => height !== undefined && Number.isFinite(height))
      .sort((left, right) => left - right);
    if (declared.length) return declared[Math.floor(declared.length / 2)];
    const heights = points.map((point) => point.altitude).filter(Number.isFinite).sort((left, right) => left - right);
    if (!heights.length) return undefined;
    // A low percentile is robust to one bad GNSS sample while retaining the
    // take-off/landing datum that DJI absolute-altitude exports commonly use.
    return heights[Math.floor((heights.length - 1) * 0.02)];
  }

  private sourceGroundHeight() {
    const configured = this.optionalNumberInput("#videoArGroundHeight");
    return configured ?? this.automaticGroundHeight ?? this.liveGroundHeight;
  }

  private hasElevationTerrain() {
    const provider = this.viewer.terrainProvider;
    return Boolean(provider) && !(provider instanceof EllipsoidTerrainProvider);
  }

  private renderedGroundHeight(longitude: number, latitude: number) {
    if (!this.hasElevationTerrain()) return 0;
    const loadedHeight = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(longitude, latitude));
    return Number.isFinite(loadedHeight) ? loadedHeight! : 0;
  }

  private djiReferenceHeight() {
    if (this.djiGroundTerrainProvider !== this.viewer.terrainProvider) {
      this.djiProjectionGroundHeight = undefined;
      this.djiGroundTerrainProvider = this.viewer.terrainProvider;
    }
    const anchor = this.points[0];
    if (!anchor) return undefined;
    if (this.djiProjectionGroundHeight === undefined) {
      const height = this.hasElevationTerrain()
        ? this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(anchor.longitude, anchor.latitude)) : 0;
      if (Number.isFinite(height)) this.djiProjectionGroundHeight = height;
    }
    return this.djiProjectionGroundHeight;
  }

  private resolveHeight(sourceAltitude: number, relativeAltitude: number) {
    const selected = this.element<HTMLSelectElement>("#videoArHeightMode").value;
    const mode: DjiHeightMode = selected === "source" || selected === "relative" ? selected : "estimated";
    return resolveDjiHeight({
      mode, sourceAltitude, relativeAltitude,
      estimatedDatum: this.optionalNumberInput("#videoArTakeoffHeight") ?? this.djiReferenceHeight(),
      estimatedDatumSource: this.optionalNumberInput("#videoArTakeoffHeight") === undefined ? "first-frame-ground" : "user-candidate",
      takeoffEllipsoidHeight: this.optionalNumberInput("#videoArTakeoffHeight"),
      sourceToEllipsoidOffset: this.optionalNumberInput("#videoArSourceHeightOffset"),
      correctionMeters: this.element<HTMLInputElement>("#videoArEnableCalibration").checked ? this.numberInput("#videoArHeightOffset", 0) : 0,
    });
  }

  private renderedAltitude(longitude: number, latitude: number, sourceAltitude: number, relativeAltitude?: number) {
    if (this.independentDjiPoseProjection) {
      const relative = relativeAltitude ?? sourceAltitude - (this.automaticGroundHeight ?? 0);
      // Keep the trajectory marker finite while an incomplete datum blocks video projection.
      return this.resolveHeight(sourceAltitude, relative).ellipsoidHeight ?? sourceAltitude;
    }
    const heightOffset = this.numberInput("#videoArHeightOffset", 0);
    const sourceGround = this.sourceGroundHeight();
    if (sourceGround === undefined) return sourceAltitude + heightOffset;
    return this.renderedGroundHeight(longitude, latitude) + sourceAltitude - sourceGround + heightOffset;
  }

  private frameIsSynchronized(point: FlightPoint) {
    return Boolean(point.videoFrame)
      && (point.videoFrameTimeDeltaMs === undefined || point.videoFrameTimeDeltaMs <= MAX_FRAME_POSE_DELTA_MS);
  }

  private playbackSpeed() {
    return Math.min(4, Math.max(0.25, this.numberInput("#videoArSpeed", 1)));
  }

  private targetFps() {
    return Math.min(24, Math.max(4, this.numberInput("#videoArFps", 12)));
  }

  private async play() {
    this.controlPointPicker?.cancel();
    if (!this.points.length || !this.panelActive) return;
    if (this.playbackMs >= this.durationMs) this.seek(0, true);
    if (this.videoObjectUrl) {
      this.video.playbackRate = this.playbackSpeed();
      try {
        await this.video.play();
      } catch (error) {
        this.reportError("视频无法开始播放", error);
        return;
      }
    }
    this.playing = true;
    this.lastAnimationTime = performance.now();
    this.lastProjectionUpdate = 0;
    this.updateControls();
    this.scheduleAnimation();
  }

  private pause() {
    const wasPlaying = this.playing || !this.video.paused;
    this.playing = false;
    this.video.pause();
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    if (wasPlaying && !this.controlPointPicking && this.panelActive && this.points.length && this.videoObjectUrl
      && this.video.readyState >= 2 && !this.video.seeking && Number.isFinite(this.decodedVideoTime)) {
      this.updateAtPlayback(this.playbackMs, true);
      this.drawTexture(this.video, true);
    }
    this.updateControls();
  }

  private scheduleAnimation() {
    if (!this.playing || this.animationFrame) return;
    this.animationFrame = requestAnimationFrame((time) => this.animate(time));
  }

  private animate(time: number) {
    this.animationFrame = 0;
    if (!this.playing || !this.panelActive) return;
    const elapsed = Math.max(0, Math.min(250, time - this.lastAnimationTime));
    this.lastAnimationTime = time;
    if (this.videoObjectUrl && Number.isFinite(this.video.duration) && this.video.duration > 0) {
      this.playbackMs = this.independentVideoExactTimeline
        ? Math.min(this.durationMs, Math.max(0, this.video.currentTime * 1000 - this.independentVideoFirstTimeMs))
        : Math.min(this.durationMs, (this.video.currentTime / this.video.duration) * this.durationMs);
    } else {
      this.playbackMs = Math.min(this.durationMs, this.playbackMs + elapsed * this.playbackSpeed());
    }
    const effectiveFps = this.independentDjiPoseProjection
      ? Math.min(this.targetFps(), MAX_CONTINUOUS_GEOMETRY_FPS)
      : this.targetFps();
    const interval = 1000 / effectiveFps;
    if (!(this.videoObjectUrl && this.usesDecodedFrameCallbacks) && (time - this.lastProjectionUpdate >= interval || this.playbackMs >= this.durationMs)) {
      this.lastProjectionUpdate = time;
      if (!this.cameraInteracting && !(this.videoObjectUrl && this.usesDecodedFrameCallbacks)) {
        this.updateAtPlayback(this.playbackMs);
        if (this.videoObjectUrl && this.video.readyState >= 2) this.drawTexture(this.video);
      }
    }
    if (this.playbackMs >= this.durationMs || (this.videoObjectUrl && this.video.ended)) this.pause();
    else this.scheduleAnimation();
  }

  private seek(milliseconds: number, force = false) {
    this.controlPointPicker?.cancel();
    this.playbackMs = Math.min(this.durationMs, Math.max(0, milliseconds));
    let requestedVideoSeek = false;
    if (this.videoObjectUrl && Number.isFinite(this.video.duration) && this.video.duration > 0) {
      const target = this.independentVideoExactTimeline
        ? Math.min(this.video.duration, (this.independentVideoFirstTimeMs + this.playbackMs) / 1000)
        : this.durationMs
          ? (this.playbackMs / this.durationMs) * this.video.duration
          : 0;
      const seekThresholdSeconds = force ? 0.0005 : 0.008;
      if (Math.abs(this.video.currentTime - target) > seekThresholdSeconds) {
        this.decodedVideoTime = Number.NaN;
        this.cancelPendingProjectionUpdates();
        this.video.currentTime = target;
        requestedVideoSeek = true;
        this.awaitingDecodedTexture = true;
      }
    }
    if (!requestedVideoSeek) this.updateAtPlayback(this.playbackMs, force);
    if (this.videoObjectUrl && this.video.readyState >= 2 && !requestedVideoSeek && !this.video.seeking) {
      this.drawTexture(this.video, force);
    }
  }

  private step(direction: number) {
    if (!this.points.length) return;
    this.pause();
    const index = Math.min(this.points.length - 1, Math.max(0, (this.currentIndex < 0 ? 0 : this.currentIndex) + direction));
    this.seek(this.points[index].timestampMs - this.points[0].timestampMs, true);
  }

  private updateAtPlayback(milliseconds: number, force = false) {
    if (!this.points.length) return;
    if (this.videoObjectUrl && this.usesDecodedFrameCallbacks) {
      if (!Number.isFinite(this.decodedVideoTime) || this.video.seeking) return;
      milliseconds = this.independentVideoExactTimeline
        ? this.decodedVideoTime * 1000 - this.independentVideoFirstTimeMs
        : this.video.duration > 0 ? this.decodedVideoTime / this.video.duration * this.durationMs : 0;
      this.playbackMs = Math.max(0, Math.min(this.durationMs, milliseconds));
    }
    const mediaTimeOffset = this.videoObjectUrl && !this.independentDjiPoseProjection && !this.exactMediaBinding
      ? Math.min(120_000, Math.max(-120_000, this.numberInput("#videoArTimeOffset", 0) * 1000))
      : 0;
    const targetTimestamp = this.points[0].timestampMs + milliseconds + mediaTimeOffset;
    let index = this.pointIndexAt(targetTimestamp);
    const current = this.points[index];
    let state = this.stateAtTimestamp(targetTimestamp);
    if (this.videoObjectUrl) {
      const projectionMesh = this.projectionMeshAtTimestamp(
        targetTimestamp,
        Number.isFinite(this.decodedVideoTime) ? this.decodedVideoTime * 1000 : this.video.currentTime * 1000,
      );
      const holdLastMeshFrame = this.projectionMeshPoints.length > 0 && !projectionMesh;
      this.meshVideoFrameReady = !holdLastMeshFrame;
      // A mesh timeline is authoritative. Falling back to a four-corner plane
      // for a missing mesh frame would combine different geometry/depth models
      // and can put a decoded frame on the wrong surface.
      const footprint = this.projectionMeshPoints.length
        ? undefined
        : this.footprintAtTimestamp(targetTimestamp);
      const djiPosePoint = !projectionMesh && !footprint && this.independentDjiPoseProjection
        ? this.djiPosePointAtTimestamp(targetTimestamp)
        : undefined;
      if (djiPosePoint) {
        state = this.stateFromPoint(djiPosePoint);
        index = djiPosePoint.videoSampleIndex ?? index;
      }
      const allowProjection = Boolean(projectionMesh || footprint || djiPosePoint);
      const blockReason = allowProjection
        ? ""
        : this.projectionMeshPoints.length
          ? "等待 50ms 内同帧三维网格：保持上一已配准画面"
        : this.independentDjiPoseProjection
          ? "未投影：当前视频 PTS 没有可信的同帧 DJI 姿态"
          : "未投影：独立视频缺少当前画面的同帧三维配准";
      this.updateSceneGeometry(
        state,
        allowProjection,
        blockReason,
        force,
        footprint,
        djiPosePoint?.djiSrtPoseProjection,
        projectionMesh,
        holdLastMeshFrame,
        djiPosePoint?.recordedAt ?? current.recordedAt,
      );
      if (force || index !== this.currentIndex) this.currentIndex = index;
    } else if (force || index !== this.currentIndex) {
      this.currentIndex = index;
      this.requestFrame(current, state);
    }
    this.updateTelemetry(state);
    this.updateProgress();
  }

  private stateFromPoint(point: FlightPoint): LiveState {
    return {
      longitude: point.longitude,
      latitude: point.latitude,
      altitude: point.altitude,
      attitude: { ...point.attitude },
      gimbal: { ...point.gimbal },
    };
  }

  private djiPosePointAtTimestamp(targetTimestamp: number) {
    const index = this.pointIndexAt(targetTimestamp);
    const point = [this.points[index], this.points[index + 1]].filter(Boolean)
      .sort((a, b) => Math.abs(a.timestampMs - targetTimestamp) - Math.abs(b.timestampMs - targetTimestamp))[0];
    if (!point?.djiSrtPoseProjection) return undefined;
    if (Math.abs(targetTimestamp - point.timestampMs) > MAX_DJI_SRT_POSE_GAP_MS) return undefined;
    return point;
  }

  private stateAtTimestamp(targetTimestamp: number): LiveState {
    const index = this.pointIndexAt(targetTimestamp);
    const current = this.points[index];
    const next = this.points[Math.min(index + 1, this.points.length - 1)];
    const span = Math.max(1, next.timestampMs - current.timestampMs);
    const amount = Math.min(1, Math.max(0, (targetTimestamp - current.timestampMs) / span));
    return {
      longitude: current.longitude + (next.longitude - current.longitude) * amount,
      latitude: current.latitude + (next.latitude - current.latitude) * amount,
      altitude: current.altitude + (next.altitude - current.altitude) * amount,
      attitude: {
        heading: interpolateAngleDegrees(current.attitude.heading, next.attitude.heading, amount),
        pitch: current.attitude.pitch + (next.attitude.pitch - current.attitude.pitch) * amount,
        roll: current.attitude.roll + (next.attitude.roll - current.attitude.roll) * amount,
      },
      gimbal: {
        yaw: interpolateAngleDegrees(current.gimbal.yaw, next.gimbal.yaw, amount),
        pitch: current.gimbal.pitch + (next.gimbal.pitch - current.gimbal.pitch) * amount,
        roll: current.gimbal.roll + (next.gimbal.roll - current.gimbal.roll) * amount,
      },
    };
  }

  private footprintTime(point: FlightPoint, footprint: GeoFootprint) {
    return footprint.timestampMs ?? point.videoFrameTimestampMs ?? point.timestampMs;
  }

  private interpolateCorner(left: GeoCorner, right: GeoCorner, amount: number): GeoCorner {
    const height = left.height !== undefined && right.height !== undefined
      ? left.height + (right.height - left.height) * amount
      : undefined;
    return {
      longitude: left.longitude + (right.longitude - left.longitude) * amount,
      latitude: left.latitude + (right.latitude - left.latitude) * amount,
      ...(height === undefined ? {} : { height }),
    };
  }

  private footprintAtTimestamp(targetTimestamp: number) {
    const index = this.pointIndexAt(targetTimestamp);
    const current = this.points[index];
    const next = this.points[Math.min(index + 1, this.points.length - 1)];
    const currentFootprint = current.groundFootprint;
    const nextFootprint = next.groundFootprint;
    if (currentFootprint && nextFootprint && currentFootprint.crs === nextFootprint.crs) {
      const currentTime = this.footprintTime(current, currentFootprint);
      const nextTime = this.footprintTime(next, nextFootprint);
      const span = nextTime - currentTime;
      if (span > 0 && span <= MAX_FRAME_POSE_DELTA_MS * 4 && targetTimestamp >= currentTime && targetTimestamp <= nextTime) {
        const amount = (targetTimestamp - currentTime) / span;
        return {
          topLeft: this.interpolateCorner(currentFootprint.topLeft, nextFootprint.topLeft, amount),
          topRight: this.interpolateCorner(currentFootprint.topRight, nextFootprint.topRight, amount),
          bottomRight: this.interpolateCorner(currentFootprint.bottomRight, nextFootprint.bottomRight, amount),
          bottomLeft: this.interpolateCorner(currentFootprint.bottomLeft, nextFootprint.bottomLeft, amount),
          crs: currentFootprint.crs,
          timestampMs: targetTimestamp,
        } satisfies GeoFootprint;
      }
    }
    const nearby = [
      currentFootprint ? { footprint: currentFootprint, delta: Math.abs(this.footprintTime(current, currentFootprint) - targetTimestamp) } : undefined,
      nextFootprint ? { footprint: nextFootprint, delta: Math.abs(this.footprintTime(next, nextFootprint) - targetTimestamp) } : undefined,
    ].filter((value): value is { footprint: GeoFootprint; delta: number } => Boolean(value))
      .sort((left, right) => left.delta - right.delta)[0];
    return nearby && nearby.delta <= MAX_FRAME_POSE_DELTA_MS ? nearby.footprint : undefined;
  }

  private projectionMeshAtTimestamp(targetTimestamp: number, videoTimeMs?: number) {
    const useVideoTime = videoTimeMs !== undefined && Number.isFinite(videoTimeMs) && this.projectionMeshVideoPoints.length > 0;
    const points = useVideoTime ? this.projectionMeshVideoPoints : this.projectionMeshPoints;
    if (!points.length) return undefined;
    const readTime = useVideoTime
      ? (point: FlightPoint) => point.projectionMesh?.videoTimeMs ?? point.videoTimeMs!
      : (point: FlightPoint) => point.timestampMs;
    const target = useVideoTime ? videoTimeMs : targetTimestamp;
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (readTime(points[middle]) < target) low = middle + 1;
      else high = middle;
    }
    const candidates = [points[low - 1], points[low]]
      .filter((point): point is FlightPoint => Boolean(point?.projectionMesh));
    const nearest = candidates.sort((left, right) => (
      Math.abs(readTime(left) - target) - Math.abs(readTime(right) - target)
    ))[0];
    return nearest && Math.abs(readTime(nearest) - target) <= MAX_MESH_PLAYBACK_HOLD_MS
      ? nearest.projectionMesh
      : undefined;
  }

  private explicitProjectionCorners(footprint: GeoFootprint) {
    const terrainKey = this.hasElevationTerrain() ? "terrain" : "ellipsoid";
    const source = geoFootprintCorners(footprint);
    const key = `${terrainKey}|${footprint.crs}|${source.map((corner) => (
      `${corner.longitude.toFixed(9)},${corner.latitude.toFixed(9)},${corner.height?.toFixed(3) ?? ""}`
    )).join("|")}`;
    const cached = this.footprintPositionCache.get(key);
    if (cached) return cached;
    const sequential = source.map((corner) => {
      const loadedHeight = this.hasElevationTerrain()
        ? this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(corner.longitude, corner.latitude))
        : undefined;
      // A supplied height is part of the georeference and must never be
      // flattened back to the ellipsoid/terrain. This is especially important
      // for roof control points. Terrain is only a fallback for 2D corners.
      const height = corner.height ?? (Number.isFinite(loadedHeight) ? loadedHeight! : 0);
      return Cartesian3.fromDegrees(corner.longitude, corner.latitude, height + SURFACE_LIFT_METERS);
    });
    // Public footprint order is TL,TR,BR,BL; the scene math uses TL,TR,BL,BR.
    const positions = [sequential[0], sequential[1], sequential[3], sequential[2]];
    this.footprintPositionCache.set(key, positions);
    while (this.footprintPositionCache.size > 16) {
      this.footprintPositionCache.delete(this.footprintPositionCache.keys().next().value as string);
    }
    return positions;
  }

  private explicitProjectionMesh(mesh: GeoProjectionMesh, cameraOrigin: Cartesian3) {
    const cached = this.projectionMeshSurfaceCache.get(mesh);
    if (cached) return cached;
    const vertexCount = mesh.positionsWgs84.length / 3;
    const positions = new Array<Cartesian3>(vertexCount);
    const textureCoordinates = new Float32Array(vertexCount * 2);
    const closestCornerIndices = [0, 0, 0, 0];
    const closestCornerDistances = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const desiredUv = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    for (let index = 0; index < vertexCount; index += 1) {
      const positionOffset = index * 3;
      const uvOffset = index * 2;
      const exactPosition = Cartesian3.fromDegrees(
        mesh.positionsWgs84[positionOffset],
        mesh.positionsWgs84[positionOffset + 1],
        mesh.positionsWgs84[positionOffset + 2],
      );
      // Render a decal a few centimetres toward the calibrated camera. This
      // leaves the georeference cache untouched while preventing coplanar
      // ground/roof/facade samples from fighting Cesium terrain or 3D Tiles.
      const towardCamera = Cartesian3.subtract(cameraOrigin, exactPosition, new Cartesian3());
      const distanceToCamera = Cartesian3.magnitude(towardCamera);
      positions[index] = Number.isFinite(distanceToCamera) && distanceToCamera > MESH_CAMERA_BIAS_METERS
        ? Cartesian3.add(
            exactPosition,
            Cartesian3.multiplyByScalar(towardCamera, MESH_CAMERA_BIAS_METERS / distanceToCamera, towardCamera),
            new Cartesian3(),
          )
        : exactPosition;
      const u = mesh.textureCoordinates[uvOffset];
      const v = mesh.textureCoordinates[uvOffset + 1];
      textureCoordinates[uvOffset] = u;
      textureCoordinates[uvOffset + 1] = 1 - v;
      desiredUv.forEach(([cornerU, cornerV], cornerIndex) => {
        const distance = (u - cornerU) ** 2 + (v - cornerV) ** 2;
        if (distance < closestCornerDistances[cornerIndex]) {
          closestCornerDistances[cornerIndex] = distance;
          closestCornerIndices[cornerIndex] = index;
        }
      });
    }
    const surface: ProjectionSurface = {
      positions,
      textureCoordinates,
      indices: mesh.indices,
      boundingSphere: BoundingSphere.fromPoints(positions),
      sourceTopFraction: 0,
      kind: "wgs84-control-mesh",
    };
    const result = {
      surface,
      corners: closestCornerIndices.map((index) => positions[index]),
    };
    this.projectionMeshSurfaceCache.set(mesh, result);
    while (this.projectionMeshSurfaceCache.size > 3) {
      this.projectionMeshSurfaceCache.delete(this.projectionMeshSurfaceCache.keys().next().value as GeoProjectionMesh);
    }
    return result;
  }

  private projectionMeshMatchesMedia(mesh: GeoProjectionMesh) {
    return !mesh.imageWidthPx
      || !mesh.imageHeightPx
      || !this.mediaSourceWidth
      || !this.mediaSourceHeight
      || (mesh.imageWidthPx === this.mediaSourceWidth && mesh.imageHeightPx === this.mediaSourceHeight);
  }

  private isUsableProjectionMesh(origin: Cartesian3, surface: ProjectionSurface) {
    if (!surface.textureCoordinates || !surface.indices || surface.positions.length < 3 || surface.indices.length < 3) return false;
    const sphere = surface.boundingSphere ?? BoundingSphere.fromPoints([...surface.positions]);
    return [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius].every(Number.isFinite)
      && Cartesian3.distance(origin, sphere.center) + sphere.radius <= MAX_GROUND_PROJECTION_DISTANCE;
  }

  private pointIndexAt(timestampMs: number) {
    let low = 0;
    let high = this.points.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.points[middle].timestampMs <= timestampMs) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private updateSceneGeometry(
    state: LiveState,
    allowProjection = true,
    projectionBlockReason = "",
    forceProjectionGeometry = false,
    groundFootprint?: GeoFootprint,
    djiSrtPoseProjection?: DjiSrtPoseProjection,
    projectionMesh?: GeoProjectionMesh,
    holdPreviousProjection = false,
    rawRecordedAt?: string,
  ) {
    if (this.controlPointPicking || (this.cameraInteracting && (this.videoObjectUrl || this.liveOnline))) return;
    this.ensureLiveEntities();
    const modelMode = this.element<HTMLSelectElement>("#videoArSurfaceMode").value === "model" && !groundFootprint && !projectionMesh;
    const calibrated = !groundFootprint && !projectionMesh && (!djiSrtPoseProjection || this.element<HTMLInputElement>("#videoArEnableCalibration").checked);
    const heightOffset = calibrated ? this.numberInput("#videoArHeightOffset", 0) : 0;
    const sourceGroundHeight = this.sourceGroundHeight();
    const currentTerrainGroundHeight = this.hasElevationTerrain()
      ? this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(state.longitude, state.latitude)) : 0;
    const resolvedHeight = djiSrtPoseProjection ? this.resolveHeight(state.altitude, djiSrtPoseProjection.relativeAltitudeMeters) : undefined;
    if (resolvedHeight && !resolvedHeight.valid) {
      allowProjection = false;
      projectionBlockReason = "未投影：" + resolvedHeight.blockReason;
    }
    const loadedTerrainGroundHeight = resolvedHeight ? resolvedHeight.datumHeight : currentTerrainGroundHeight;
    const djiTerrainGroundReady = resolvedHeight ? resolvedHeight.valid : !this.hasElevationTerrain() || Number.isFinite(loadedTerrainGroundHeight);
    const datumHeight = Number.isFinite(loadedTerrainGroundHeight) ? loadedTerrainGroundHeight! : 0;
    const renderGroundHeight = calibrated ? this.optionalNumberInput("#videoArSurfaceHeight") ?? datumHeight : datumHeight;
    const agl = djiSrtPoseProjection
      ? djiSrtPoseProjection.relativeAltitudeMeters + heightOffset
      : sourceGroundHeight === undefined ? undefined : state.altitude - sourceGroundHeight + heightOffset;
    const renderAltitude = resolvedHeight ? resolvedHeight.ellipsoidHeight ?? state.altitude
      : agl === undefined ? state.altitude + heightOffset : datumHeight + agl;
    const configuredHfov = CesiumMath.toRadians(Math.min(179, Math.max(1, djiSrtPoseProjection?.horizontalFovDegrees ?? this.numberInput("#videoArHfov", 84))));
    const configuredVfov = CesiumMath.toRadians(Math.min(179, Math.max(1, djiSrtPoseProjection?.verticalFovDegrees ?? this.numberInput("#videoArVfov", 53))));
    const horizontalTangent = Math.tan(configuredHfov / 2);
    const lockAspect = this.element<HTMLInputElement>("#videoArLockAspect").checked;
    const verticalTangent = !djiSrtPoseProjection && lockAspect && this.sourceAspectRatio ? horizontalTangent / this.sourceAspectRatio : Math.tan(configuredVfov / 2);
    const hfov = 2 * Math.atan(horizontalTangent), vfov = 2 * Math.atan(verticalTangent);
    const absoluteGimbal = Boolean(djiSrtPoseProjection) || this.element<HTMLInputElement>("#videoArAbsoluteGimbal").checked;
    const width = djiSrtPoseProjection?.dataset.videoWidth ?? (this.mediaSourceWidth || 1600);
    const height = djiSrtPoseProjection?.dataset.videoHeight ?? (this.mediaSourceHeight || 900);
    const fileInfo = (file: File | null) => file ? { name: file.name, sizeBytes: file.size, lastModified: file.lastModified } : null;
    let camera: ResolvedCameraFrame;
    let frameIdentity: TextureFrameIdentity | undefined;
    try {
      frameIdentity = this.currentTextureFrame();
      camera = resolveCameraFrame({
        sourceIdentity: { session: this.loadGeneration, video: this.projectionSource === "live" ? null : fileInfo(this.videoFile), trajectory: this.projectionSource === "live" ? null : fileInfo(this.trajectoryFile) },
        videoTimeMs: frameIdentity?.mediaTimeMs ?? this.playbackMs, poseTimeMs: djiSrtPoseProjection?.videoTimeMs, videoSampleIndex: djiSrtPoseProjection?.videoSampleIndex, rawRecordedAt,
        longitude: state.longitude, latitude: state.latitude, rawAbsAltitude: state.altitude, rawRelativeAltitude: djiSrtPoseProjection?.relativeAltitudeMeters,
        mappedHeightMeters: renderAltitude, resolvedHeight, attitude: state.gimbal,
        aircraft: absoluteGimbal ? undefined : { yaw: state.attitude.heading, pitch: state.attitude.pitch, roll: state.attitude.roll },
        referenceWidth: width, referenceHeight: height,
        djiIntrinsics: djiSrtPoseProjection ? { fx: djiSrtPoseProjection.fxPx, fy: djiSrtPoseProjection.fyPx, cx: djiSrtPoseProjection.cxPx, cy: djiSrtPoseProjection.cyPx } : undefined,
        fallbackHorizontalTangent: horizontalTangent, fallbackVerticalTangent: verticalTangent, calibrationEnabled: calibrated,
        manual: { fx: this.optionalNumberInput("#videoArCameraFx"), fy: this.optionalNumberInput("#videoArCameraFy"), cx: this.optionalNumberInput("#videoArCameraCx"), cy: this.optionalNumberInput("#videoArCameraCy") },
        distortion: { k1: this.numberInput("#videoArK1", 0), k2: this.numberInput("#videoArK2", 0), k3: this.numberInput("#videoArK3", 0), p1: this.numberInput("#videoArP1", 0), p2: this.numberInput("#videoArP2", 0) },
        corrections: { east: Math.min(10000, Math.max(-10000, this.numberInput("#videoArEastOffset", 0))), north: Math.min(10000, Math.max(-10000, this.numberInput("#videoArNorthOffset", 0))), height: heightOffset,
          yaw: this.numberInput("#videoArYawCorrection", 0), pitch: this.numberInput("#videoArPitchCorrection", 0), roll: this.numberInput("#videoArRollCorrection", 0), footprintScale: Math.min(5, Math.max(.1, this.numberInput("#videoArFootprintScale", 1))) },
        allowProjection, projectionMethod: projectionMesh ? "measured-3d-mesh" : groundFootprint ? "measured-corners" : modelMode ? "model-depth" : "terrain-or-plane",
      });
    } catch {
      this.calibrationFrame = undefined; this.effectiveCamera = undefined; this.committedModelCamera = undefined;
      this.activeTextureFrame = undefined; this.committedModelTextureFrame = undefined;
      this.hideProjectionPrimitive(); this.modelProjector?.setEnabled(false);
      this.element("#videoArProjectionMode").textContent = "未投影：相机参数无效，请检查高程、内参与畸变系数";
      return;
    }
    this.effectiveCamera = camera;
    this.activeTextureFrame = frameIdentity;
    const vector = (p: { x: number; y: number; z: number }) => new Cartesian3(p.x, p.y, p.z);
    const origin = vector(camera.positionEcef), attitude = camera.attitude;
    const yawDegrees = attitude.yaw, pitchDegrees = attitude.pitch, rollDegrees = attitude.roll;
    const model: CameraRayModel = { intrinsics: camera.intrinsics, distortion: camera.distortion, aircraft: camera.aircraft };
    const rayAt = (u: number, v: number) => vector(cameraFrameRay(camera, u, v));
    const measuredDirections = { corners: [rayAt(0, 0), rayAt(1, 0), rayAt(0, 1), rayAt(1, 1)], center: vector(camera.directionEcef), rayAt };
    const safeDjiProjection = djiSrtPoseProjection && !modelMode
      ? this.safeDjiProjectionDirections(origin, yawDegrees, pitchDegrees, rollDegrees, hfov, vfov, Math.max(0, renderAltitude - renderGroundHeight), model) : undefined;
    const markerCamera = modelMode && this.committedModelCamera ? this.committedModelCamera : camera;
    if (this.droneEntity) this.droneEntity.position = new ConstantPositionProperty(vector(markerCamera.positionEcef));
    this.calibrationReferenceHeight = djiSrtPoseProjection ? datumHeight : undefined;
    this.calibrationFrame = !this.replaySelectionPending && allowProjection && !model.aircraft && !groundFootprint && !projectionMesh ? {
      origin, attitude, intrinsics: camera.intrinsics, distortion: camera.distortion,
      width, height, sourceKey: this.loadGeneration, frameTime: camera.frameTime,
    } : undefined;
    const terrainPreferred = this.element<HTMLInputElement>("#videoArTerrain").checked;
    this.modelProjectionAllowed = false;
    if (!modelMode) this.modelProjector?.setEnabled(false);
    const autoGround = !djiSrtPoseProjection && this.element<HTMLInputElement>("#videoArAutoGround").checked;
    const fallbackDistance = Math.min(5_000, Math.max(1, this.numberInput("#videoArFallbackDistance", 60)));
    const manualGroundHeight = this.optionalNumberInput("#videoArGroundHeight") !== undefined;
    const groundDescription = djiSrtPoseProjection
      ? `实际椭球高 ${renderAltitude.toFixed(2)}m · ${resolvedHeight!.explanation}${calibrated ? " · 手动校准已启用" : ""}`
      : sourceGroundHeight === undefined
        ? "椭球基面"
        : `${manualGroundHeight ? "手动" : "自动"}数据基准 ${sourceGroundHeight.toFixed(1)}m · AGL ${agl!.toFixed(1)}m`;
    let projectionDirections = safeDjiProjection?.directions ?? measuredDirections;
    const sourceTopFraction = safeDjiProjection?.sourceTopFraction ?? 0;
    let projectionCorners: Cartesian3[] | undefined;
    let projectionSurface: ProjectionSurface | undefined;
    let projectionMode = "";

    if (!allowProjection) {
      projectionMode = projectionBlockReason || "未投影：媒体与地理数据未通过同步校验";
    } else if (terrainPreferred && projectionMesh) {
      if (!this.projectionMeshMatchesMedia(projectionMesh)) {
        projectionMode = `未投影：三维控制网格画幅 ${projectionMesh.imageWidthPx}×${projectionMesh.imageHeightPx} 与解码视频 ${this.mediaSourceWidth}×${this.mediaSourceHeight} 不一致`;
      } else {
        const explicitMesh = this.explicitProjectionMesh(projectionMesh, origin);
        if (this.isUsableProjectionMesh(origin, explicitMesh.surface)) {
          projectionSurface = explicitMesh.surface;
          projectionCorners = explicitMesh.corners;
          const center = explicitMesh.corners.reduce(
            (sum, corner) => Cartesian3.add(sum, corner, sum),
            new Cartesian3(),
          );
          Cartesian3.divideByScalar(center, explicitMesh.corners.length, center);
          projectionDirections = {
            ...measuredDirections,
            center: Cartesian3.normalize(Cartesian3.subtract(center, origin, new Cartesian3()), new Cartesian3()),
          };
          const quality = projectionMesh.reprojectionRmsePx === undefined
            ? ""
            : ` · 重投影 RMSE ${projectionMesh.reprojectionRmsePx.toFixed(2)}px`;
          projectionMode = `EPSG:4979 同帧三维可见表面网格 · ${(projectionMesh.positionsWgs84.length / 3).toLocaleString()} 顶点 / ${(projectionMesh.indices.length / 3).toLocaleString()} 三角${quality}`;
        } else {
          projectionMode = "未投影：三维控制网格与相机跨度异常";
        }
      }
    } else if (terrainPreferred && modelMode) {
      try {
        this.modelProjectionFrame = { origin, direction: vector(camera.directionEcef), up: vector(camera.upEcef), intrinsics: camera.intrinsics, distortion: camera.distortion, maxDistance: 2500 };
        if (!this.modelProjector) {
          this.modelProjector = new VideoArModelProjector(this.viewer, () => this.readyMaterialTexture(this.textureCanvas));
          this.updateDepthDiagnostic();
        }
        this.modelProjectionAllowed = true;
        if (this.projectionPrimitive || this.projectionCandidate || this.pendingProjectionSurface) this.removeProjectionPrimitive();
        this.commitModelCamera();
        projectionMode = "倾斜摄影三维表面投影 · 屋顶 / 立面 / 遮挡检测 · " + groundDescription
          + (resolvedHeight?.estimated ? " · 高度尚未确认" : "");
      } catch (error) {
        this.modelProjectionAllowed = false;
        this.modelProjectionFrame = undefined;
        this.modelProjector?.setEnabled(false);
        this.removeProjectionPrimitive();
        projectionMode = error instanceof Error ? error.message : "三维投影初始化失败";
      }
    } else if (djiSrtPoseProjection && !safeDjiProjection) {
      projectionMode = "未投影：镜头过于接近地平线，可靠地面区域不足";
    } else if (djiSrtPoseProjection && !djiTerrainGroundReady) {
      projectionMode = "未投影：正在等待相机位置处的 Cesium 地形高程";
    } else if (terrainPreferred && groundFootprint) {
      const explicitCorners = this.explicitProjectionCorners(groundFootprint);
      if (this.isUsableGroundProjection(origin, explicitCorners)) {
        projectionCorners = explicitCorners;
        const center = explicitCorners.reduce(
          (sum, corner) => Cartesian3.add(sum, corner, sum),
          new Cartesian3(),
        );
        Cartesian3.divideByScalar(center, explicitCorners.length, center);
        projectionDirections = {
          ...measuredDirections,
          center: Cartesian3.normalize(Cartesian3.subtract(center, origin, new Cartesian3()), new Cartesian3()),
        };
        projectionMode = `${groundFootprint.crs} 同帧地理角点投影`;
      } else {
        projectionMode = "未投影：同帧地理角点与相机位置跨度异常";
      }
    } else if (terrainPreferred) {
      const useTerrain = this.hasElevationTerrain() && this.element<HTMLSelectElement>("#videoArSurfaceMode").value !== "plane";
      const maximumDistance = djiSrtPoseProjection
        ? Math.max(120, Math.min(1_500, Math.max(0, renderAltitude - renderGroundHeight) * MAX_DJI_PROJECTION_RANGE_FACTOR))
        : MAX_GROUND_PROJECTION_DISTANCE;
      const intersect = (direction: Cartesian3) => {
        if (-Cartesian3.dot(direction, this.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(origin, new Cartesian3())) < 0.005) return undefined;
        try {
          // A missing elevation tile stays a hole. Mixing successful terrain hits
          // with a fallback plane would stretch the image across two surfaces.
          const hit = useTerrain
            ? this.viewer.scene.globe.pick(new Ray(origin, direction), this.viewer.scene)
            : this.pickGround(origin, direction, state.longitude, state.latitude, renderGroundHeight, true);
          if (!hit || Cartesian3.distance(origin, hit) > maximumDistance) return undefined;
          return hit;
        } catch { return undefined; }
      };
      const sample = (directions: typeof measuredDirections) => buildRaySurfaceGrid(
        PROJECTION_GRID_COLUMNS, PROJECTION_GRID_ROWS, sourceTopFraction,
        (u, v) => {
          try {
            const direction = directions.rayAt(u, v);
            const hit = intersect(direction);
            if (!hit) return undefined;
            // Move along the same source ray: depth bias must not shift the pixel.
            const position = Cartesian3.subtract(hit, Cartesian3.multiplyByScalar(direction, MESH_CAMERA_BIAS_METERS, new Cartesian3()), new Cartesian3());
            const depth = Cartesian3.dot(Cartesian3.subtract(position, origin, new Cartesian3()), directions.center);
            return { position, depth };
          } catch { return undefined; }
        },
      );
      let grid = sample(projectionDirections);
      let nadir = false;
      if (!grid.indices.length && autoGround) {
        projectionDirections = this.cameraDirections(origin, yawDegrees, -90, 0, hfov, vfov, 0, { ...model, aircraft: undefined });
        grid = sample(projectionDirections);
        nadir = true;
      }
      if (grid.indices.length) {
        const positions = grid.positions.map(point => new Cartesian3(point.x, point.y, point.z));
        const textureCoordinates = grid.textureCoordinates.slice();
        for (let index = 1; index < textureCoordinates.length; index += 2) textureCoordinates[index] = 1 - textureCoordinates[index];
        projectionSurface = { positions, textureCoordinates, textureWeights: grid.textureWeights, indices: grid.indices,
          sourceTopFraction, kind: "camera-ray-mesh" };
        // Diagnostic outline follows the nearest surviving source-image corners.
        projectionCorners = [[0,sourceTopFraction],[1,sourceTopFraction],[0,1],[1,1]].map(([u,v]) => {
          let closest = 0, distance = Infinity;
          for (let index=0; index<positions.length; index++) {
            const delta = Math.hypot(grid.textureCoordinates[index*2]-u, grid.textureCoordinates[index*2+1]-v);
            if (delta<distance) { closest=index;distance=delta; }
          }
          return positions[closest];
        });
        projectionMode = (djiSrtPoseProjection ? "DJI SRT " : nadir ? "正下方估算（非真实配准） " : "姿态估算 ")
          + "相机射线网格 · " + (useTerrain ? "当前高程地形" : "基准平面估算") + " · " + groundDescription
          + (Object.values(model.distortion).some(value=>value !== 0) ? " · 镜头去畸变" : "")
          + (grid.rejectedTriangles ? " · 未命中或深度突变区域已留空" : "")
          + (sourceTopFraction ? " · 顶部裁切 " + (sourceTopFraction*100).toFixed(1) + "%" : "");
      } else {
        projectionMode = useTerrain ? "未投影：地形尚未覆盖相机视野或视线无法落地，请等待地形加载或选择已知基准平面"
          : "未投影：视线无法落到基准平面，请检查高度、俯仰和镜头参数";
      }
    } else {
      projectionMode = "地面投影已关闭（仅显示视锥）";
    }

    if (projectionCorners && allowProjection) {
      const [topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner] = projectionCorners;
      const footprintWidth = (
        Cartesian3.distance(topLeftCorner, topRightCorner)
        + Cartesian3.distance(bottomLeftCorner, bottomRightCorner)
      ) / 2;
      const footprintHeight = (
        Cartesian3.distance(topLeftCorner, bottomLeftCorner)
        + Cartesian3.distance(topRightCorner, bottomRightCorner)
      ) / 2;
      projectionMode += ` · 画幅 ${footprintWidth.toFixed(1)}×${footprintHeight.toFixed(1)}m`;
    }

    const debugCorners = projectionCorners ?? measuredDirections.corners.map((direction) => Cartesian3.add(
      origin,
      Cartesian3.multiplyByScalar(direction, fallbackDistance, new Cartesian3()),
      new Cartesian3(),
    ));
    const [topLeft, topRight, bottomLeft, bottomRight] = debugCorners;
    if (projectionCorners && allowProjection) {
      const [projectedTopLeft, projectedTopRight, projectedBottomLeft, projectedBottomRight] = projectionCorners;
      this.setProjectionGeometry(
        projectionSurface ?? {
          positions: [projectedTopLeft, projectedTopRight, projectedBottomLeft, projectedBottomRight],
          sourceTopFraction,
          kind: "projective-quad",
        },
        forceProjectionGeometry,
        Boolean(projectionMesh || groundFootprint || djiSrtPoseProjection),
      );
    } else if (this.modelProjectionAllowed) {
      // Model surfaces are rendered by the depth projector; never create a flat fallback.
    } else if (!holdPreviousProjection) {
      this.hideProjectionPrimitive();
    } else {
      // A seek may already have created a candidate for another timestamp.
      // Cancel every uncommitted geometry/texture together and keep only the
      // last coherent primitive; otherwise that candidate could later be
      // promoted with the old GPU frame.
      this.cancelPendingProjectionUpdates();
      this.projectionAtomicSwapPending = false;
      if (this.projectionPrimitive) {
        this.projectionVisible = true;
        this.projectionPrimitive.show = this.panelActive;
      }
    }
    const showFrustum = this.element<HTMLInputElement>("#videoArShowFrustum").checked;
    if (showFrustum && this.frustumRaysEntity?.polyline) {
      this.frustumRaysEntity.polyline.positions = new ConstantProperty([
        origin, topLeft, origin, topRight, origin, bottomRight, origin, bottomLeft,
      ]);
    }
    if (showFrustum && this.frustumOutlineEntity?.polyline) {
      this.frustumOutlineEntity.polyline.positions = new ConstantProperty([topLeft, topRight, bottomRight, bottomLeft, topLeft]);
    }
    if (showFrustum && this.cameraAxisEntity?.polyline) {
      const axisLength = projectionCorners
        ? Math.min(...projectionCorners.map((corner) => Cartesian3.distance(origin, corner)))
        : fallbackDistance;
      const axisEnd = Cartesian3.add(origin, Cartesian3.multiplyByScalar(projectionDirections.center, axisLength, new Cartesian3()), new Cartesian3());
      this.cameraAxisEntity.polyline.positions = new ConstantProperty([origin, axisEnd]);
    }
    this.projectionDecision = !terrainPreferred ? "视频表面投影已关闭" : projectionBlockReason || projectionMode;
    this.holdingPreviousProjection = holdPreviousProjection;
    this.element("#videoArProjectionMode").textContent = projectionBlockReason || projectionMode;
    this.applyVisibility();
  }

  private isUsableGroundProjection(origin: Cartesian3, corners: Cartesian3[]) {
    if (corners.length !== 4) return false;
    for (const corner of corners) {
      if (![corner.x, corner.y, corner.z].every(Number.isFinite)) return false;
      const distance = Cartesian3.distance(origin, corner);
      if (distance < 0.5 || distance > MAX_GROUND_PROJECTION_DISTANCE) return false;
    }
    const topEdge = Cartesian3.subtract(corners[1], corners[0], new Cartesian3());
    const leftEdge = Cartesian3.subtract(corners[2], corners[0], new Cartesian3());
    return Cartesian3.magnitude(Cartesian3.cross(topEdge, leftEdge, new Cartesian3())) > 0.01;
  }

  private createProjectionGeometry(surface: ProjectionSurface) {
    let renderedPositions: readonly Cartesian3[];
    let textureCoordinates: Float32Array;
    let textureWeights: Float32Array;
    let indices: Uint16Array;
    if (surface.kind !== "projective-quad") {
      if (!surface.textureCoordinates || !surface.indices) throw new Error("三维控制网格拓扑缺失");
      renderedPositions = surface.positions;
      textureCoordinates = surface.textureCoordinates;
      textureWeights = surface.textureWeights ?? new Float32Array(surface.positions.length).fill(1);
      indices = surface.indices;
    } else {
      if (surface.positions.length !== 4) throw new Error("四角投影几何无效");
      const positions = surface.positions as readonly [Cartesian3, Cartesian3, Cartesian3, Cartesian3];
      const localOrigin = positions.reduce(
        (sum, position) => Cartesian3.add(sum, position, sum),
        new Cartesian3(),
      );
      Cartesian3.divideByScalar(localOrigin, positions.length, localOrigin);
      const localToWorld = Transforms.eastNorthUpToFixedFrame(localOrigin);
      const worldToLocal = Matrix4.inverseTransformation(localToWorld, new Matrix4());
      const localCorners = positions.map((position) => {
        const local = Matrix4.multiplyByPoint(worldToLocal, position, new Cartesian3());
        return { x: local.x, y: local.y, z: local.z };
      }) as [
        { x: number; y: number; z: number },
        { x: number; y: number; z: number },
        { x: number; y: number; z: number },
        { x: number; y: number; z: number },
      ];
      const grid = buildProjectiveGrid(
        localCorners,
        PROJECTION_GRID_COLUMNS,
        PROJECTION_GRID_ROWS,
        surface.sourceTopFraction,
      );
      renderedPositions = grid.points.map((point) => Matrix4.multiplyByPoint(
        localToWorld,
        Cartesian3.fromElements(point.x, point.y, point.z, new Cartesian3()),
        new Cartesian3(),
      ));
      textureCoordinates = new Float32Array(grid.textureCoordinates);
      textureWeights = new Float32Array(grid.textureWeights);
      indices = new Uint16Array(grid.indices);
    }
    const positionValues = new Float64Array(renderedPositions.length * 3);
    const normalValues = new Float32Array(renderedPositions.length * 3);
    const normal = new Cartesian3();
    for (let index = 0; index < renderedPositions.length; index += 1) {
      const worldPoint = renderedPositions[index];
      const offset = index * 3;
      positionValues[offset] = worldPoint.x;
      positionValues[offset + 1] = worldPoint.y;
      positionValues[offset + 2] = worldPoint.z;
      this.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(worldPoint, normal);
      normalValues[offset] = normal.x;
      normalValues[offset + 1] = normal.y;
      normalValues[offset + 2] = normal.z;
    }
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: positionValues,
    });
    attributes.normal = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values: normalValues,
    });
    (attributes as GeometryAttributes & { projectionWeight: GeometryAttribute }).projectionWeight = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: textureWeights,
    });
    attributes.st = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 2,
      values: textureCoordinates,
    });
    return new Geometry({
      attributes,
      indices,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: surface.boundingSphere ?? BoundingSphere.fromVertices(positionValues),
    });
  }

  private setProjectionGeometry(
    surface: ProjectionSurface,
    force = false,
    atomicSwap = false,
    commitStagedTextureIfCurrent = false,
  ) {
    if (
      surface.positions.length < 3
      || (surface.kind === "projective-quad" && surface.positions.length !== 4)
      || (surface.kind !== "projective-quad" && (!surface.textureCoordinates || !surface.indices))
    ) {
      this.hideProjectionPrimitive();
      return;
    }
    const sameNumbers = (left?: Float32Array | Uint16Array, right?: Float32Array | Uint16Array) => {
      if (left === right) return true;
      if (!left || !right) return left === right;
      return left.length === right.length && left.every((value, index) => value === right[index]);
    };
    const closeTo = (reference?: ProjectionSurface) => reference === surface || Boolean(
      reference
      && reference.kind === surface.kind
      && reference.positions.length === surface.positions.length
      && surface.positions.every((position, index) => Cartesian3.distance(position, reference.positions[index]) < PROJECTION_POSITION_EPSILON_METERS)
      && Math.abs(reference.sourceTopFraction - surface.sourceTopFraction) < 1e-5
      && sameNumbers(reference.textureCoordinates, surface.textureCoordinates)
      && sameNumbers(reference.textureWeights, surface.textureWeights)
      && sameNumbers(reference.indices, surface.indices)
    );
    if (
      atomicSwap
      && this.projectionPrimitive
      && this.lastProjectionSurface
      && (
        this.lastProjectionSurface.kind !== surface.kind
        || this.lastProjectionSurface.positions.length !== surface.positions.length
        || surface.positions.some((position, index) => Cartesian3.distance(position, this.lastProjectionSurface!.positions[index]) > MAX_ATOMIC_FOOTPRINT_DRIFT_METERS)
        || Math.abs(this.lastProjectionSurface.sourceTopFraction - surface.sourceTopFraction) >= 1e-5
      )
    ) {
      // Keep the previous primitive and GPU texture visible. drawTexture only
      // stages the new frame while this transaction is pending; the texture
      // and ready geometry are committed together in finishProjectionCandidate.
      this.projectionAtomicSwapPending = true;
    }
    if (this.projectionPrimitive && closeTo(this.lastProjectionSurface)) {
      this.projectionGeometryBuildFailed = false;
      const commitStagedTexture = commitStagedTextureIfCurrent && this.pendingTextureUpload;
      this.cancelPendingProjectionUpdates(commitStagedTexture);
      if (commitStagedTexture) this.flushPendingTextureUpload();
      this.projectionVisible = true;
      this.projectionPrimitive.show = this.panelActive;
      return;
    }
    const continuousMedia = Boolean(this.videoObjectUrl) || this.liveOnline;
    if (!force && continuousMedia && this.projectionPrimitive && !this.projectionCandidate) {
      const minimumInterval = 1000 / MAX_CONTINUOUS_GEOMETRY_FPS;
      const wait = minimumInterval - (performance.now() - this.lastProjectionGeometryBuildTime);
      if (wait > 0) {
        this.throttledProjectionSurface = surface;
        this.throttledProjectionAtomic ||= atomicSwap;
        this.projectionAtomicSwapPending ||= atomicSwap;
        if (!this.projectionGeometryTimer) {
          this.projectionGeometryTimer = window.setTimeout(() => {
            this.projectionGeometryTimer = 0;
            const latest = this.throttledProjectionSurface;
            const latestAtomic = this.throttledProjectionAtomic;
            this.throttledProjectionSurface = undefined;
            this.throttledProjectionAtomic = false;
            if (latest) this.setProjectionGeometry(latest, true, latestAtomic);
          }, wait);
        }
        this.projectionVisible = true;
        this.projectionPrimitive.show = this.panelActive;
        return;
      }
    }
    if (force && this.projectionGeometryTimer) {
      window.clearTimeout(this.projectionGeometryTimer);
      this.projectionGeometryTimer = 0;
      this.throttledProjectionSurface = undefined;
      this.throttledProjectionAtomic = false;
    }
    if (this.projectionCandidate) {
      const wasVisible = this.projectionVisible;
      this.pendingProjectionSurface = closeTo(this.projectionCandidateSurface) ? undefined : surface;
      this.pendingProjectionAtomic = Boolean(this.pendingProjectionSurface) && (this.pendingProjectionAtomic || atomicSwap);
      this.projectionVisible = true;
      if (this.projectionPrimitive) this.projectionPrimitive.show = this.panelActive && wasVisible;
      this.viewer.scene.requestRender();
      return;
    }

    let primitive: Primitive | undefined;
    try {
      const geometry = this.createProjectionGeometry(surface);
      primitive = new Primitive({
        geometryInstances: new GeometryInstance({
          id: "video-ar-projection",
          geometry,
        }),
        appearance: this.projectionAppearance,
        show: false,
        asynchronous: false,
        allowPicking: false,
        releaseGeometryInstances: true,
        // The grid is already small. Keeping explicit st/normal attributes
        // avoids Cesium's optional compression path changing custom UV data.
        compressVertices: false,
      });
      this.viewer.scene.primitives.add(primitive);
      this.lastProjectionGeometryBuildTime = performance.now();
      this.projectionCandidate = primitive;
      this.projectionCandidateSurface = surface;
      this.projectionGeometryBuildFailed = false;
      this.projectionVisible = true;
      if (this.projectionPrimitive) this.projectionPrimitive.show = this.panelActive;
      this.viewer.scene.requestRender();
    } catch (error) {
      if (primitive) this.disposeProjectionPrimitive(primitive);
      this.projectionAtomicSwapPending = false;
      this.pendingTextureUpload = false;
      this.pendingTextureCanvas = undefined;
      this.pendingVideoTextureTime = Number.NaN;
      this.pendingTextureFrame = undefined;
      this.textureNeedsRefresh = true;
      if (!this.videoObjectUrl) {
        // Static/live bitmaps are closed after drawTexture returns. Any build
        // failure must invalidate the displayed marker so a later retry reloads
        // and stages the pixels instead of leaving awaitingDecodedTexture stuck.
        this.displayedFrameName = null;
        this.displayedFramePoint = null;
        this.scheduleStaticFrameGeometryRetry();
      }
      this.projectionVisible = Boolean(this.projectionPrimitive);
      if (this.projectionPrimitive) this.projectionPrimitive.show = this.panelActive;
      if (this.projectionPrimitive) {
        // Do not upload the new decoded frame into the surviving old geometry.
        // A later successful geometry build will clear this guard and stage the
        // frame as part of a new atomic transaction.
        this.projectionGeometryBuildFailed = true;
        this.awaitingDecodedTexture = true;
      }
      console.warn("[Video AR] Projection geometry update skipped", error);
    }
  }

  private finishProjectionCandidate() {
    const candidate = this.projectionCandidate;
    if (!candidate || candidate.isDestroyed() || !candidate.ready) return;
    if (this.awaitingDecodedTexture) return;
    const pending = this.pendingProjectionSurface;
    const pendingAtomic = this.pendingProjectionAtomic;
    this.pendingProjectionSurface = undefined;
    this.pendingProjectionAtomic = false;
    if (pending) {
      this.projectionCandidate = undefined;
      this.projectionCandidateSurface = undefined;
      candidate.show = false;
      this.disposeProjectionPrimitive(candidate);
      this.setProjectionGeometry(pending, true, pendingAtomic, true);
      return;
    }
    const previous = this.projectionPrimitive;
    if (!this.flushPendingTextureUpload()) {
      this.projectionCandidate = undefined;
      this.projectionCandidateSurface = undefined;
      this.projectionAtomicSwapPending = false;
      candidate.show = false;
      this.disposeProjectionPrimitive(candidate);
      if (previous) previous.show = this.panelActive && this.projectionVisible;
      this.markStaticFrameTextureFailure();
      return;
    }
    this.projectionPrimitive = candidate;
    this.lastProjectionSurface = this.projectionCandidateSurface;
    this.projectionCandidate = undefined;
    this.projectionCandidateSurface = undefined;
    this.projectionAtomicSwapPending = false;
    candidate.show = this.panelActive && !this.controlPointPicking && this.projectionVisible;
    if (previous) {
      previous.show = false;
      this.disposeProjectionPrimitive(previous);
    }
    if (!this.videoObjectUrl) this.resetStaticFrameGeometryRetry();
    this.viewer.scene.requestRender();
  }

  private hideProjectionPrimitive() {
    this.modelProjectionAllowed = false;
    this.modelProjector?.setEnabled(false);
    this.cancelPendingProjectionUpdates();
    this.projectionAtomicSwapPending = false;
    this.projectionVisible = false;
    if (this.projectionPrimitive) this.projectionPrimitive.show = false;
  }

  private removeProjectionPrimitive() {
    this.cancelPendingProjectionUpdates();
    this.resetStaticFrameGeometryRetry();
    this.lastProjectionGeometryBuildTime = 0;
    this.projectionAtomicSwapPending = false;
    this.projectionGeometryBuildFailed = false;
    const primitive = this.projectionPrimitive;
    this.projectionPrimitive = undefined;
    this.projectionVisible = false;
    this.lastProjectionSurface = undefined;
    if (primitive) {
      primitive.show = false;
      this.disposeProjectionPrimitive(primitive);
    }
  }

  private cancelPendingProjectionUpdates(preservePendingTexture = false) {
    if (this.projectionGeometryTimer) window.clearTimeout(this.projectionGeometryTimer);
    this.projectionGeometryTimer = 0;
    this.throttledProjectionSurface = undefined;
    this.throttledProjectionAtomic = false;
    this.pendingProjectionSurface = undefined;
    this.pendingProjectionAtomic = false;
    const candidate = this.projectionCandidate;
    this.projectionCandidate = undefined;
    this.projectionCandidateSurface = undefined;
    this.projectionAtomicSwapPending = false;
    const discardedStagedTexture = !preservePendingTexture && this.pendingTextureUpload;
    if (!preservePendingTexture) {
      this.pendingTextureUpload = false;
      this.pendingTextureCanvas = undefined;
      this.pendingVideoTextureTime = Number.NaN;
      this.pendingTextureFrame = undefined;
    }
    // Force the decoded frame to be uploaded again after camera interaction or
    // panel reactivation. For still-frame sources, invalidate the decoded-name
    // cache so the same bitmap is safely reloaded from the bounded blob cache.
    // The old GPU pixels still exist: retain their committed identity so a
    // paused selection can close without waiting for another decode callback.
    if (!preservePendingTexture) this.textureNeedsRefresh = true;
    if (discardedStagedTexture && !this.videoObjectUrl) {
      this.displayedFrameName = null;
      this.displayedFramePoint = null;
    }
    if (candidate && candidate !== this.projectionPrimitive) this.disposeProjectionPrimitive(candidate);
    if (this.projectionPrimitive) this.projectionPrimitive.show = this.panelActive && !this.controlPointPicking && this.projectionVisible;
  }

  private disposeProjectionPrimitive(primitive: Primitive) {
    try {
      this.viewer.scene.primitives.remove(primitive);
    } catch {
      // The scene can already be tearing down during a page unload.
    }
    try {
      if (!primitive.isDestroyed()) primitive.destroy();
    } catch {
      // Cleanup must never take down another Cesium module.
    }
  }

  private cameraDirections(
    origin: Cartesian3, yawDegrees: number, pitchDegrees: number, rollDegrees: number,
    hfov: number, vfov: number, sourceTopFraction = 0, model?: CameraRayModel,
  ) {
    const intrinsics = model?.intrinsics ?? { width: 2, height: 2, fx: 1 / Math.tan(hfov / 2), fy: 1 / Math.tan(vfov / 2), cx: 1, cy: 1 };
    const attitude = { yaw: yawDegrees, pitch: pitchDegrees, roll: rollDegrees };
    const transform = Transforms.eastNorthUpToFixedFrame(origin);
    const toWorld = (enu: { x: number; y: number; z: number }) => {
      const world = Matrix4.multiplyByPointAsVector(transform, new Cartesian3(enu.x, enu.y, enu.z), new Cartesian3());
      return Cartesian3.normalize(world, world);
    };
    const rayAt = (u: number, v: number) => toWorld(cameraPixelToEnuDirection(
      intrinsics, u * intrinsics.width, v * intrinsics.height, attitude, model?.distortion, model?.aircraft,
    ));
    return {
      corners: [rayAt(0, sourceTopFraction), rayAt(1, sourceTopFraction), rayAt(0, 1), rayAt(1, 1)],
      center: toWorld(cameraDirectionToEnu({ x: 0, y: 0 }, attitude, model?.aircraft)),
      rayAt,
    };
  }

  private safeDjiProjectionDirections(
    origin: Cartesian3,
    yawDegrees: number,
    pitchDegrees: number,
    rollDegrees: number,
    hfov: number,
    vfov: number,
    relativeAltitudeMeters: number,
    model?: CameraRayModel,
  ) {
    if (!Number.isFinite(relativeAltitudeMeters) || relativeAltitudeMeters <= 2) return undefined;
    const localUp = this.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(origin, new Cartesian3());
    const maximumDistance = Math.max(
      120,
      Math.min(1_500, relativeAltitudeMeters * MAX_DJI_PROJECTION_RANGE_FACTOR),
    );
    const minimumDownwardDot = Math.max(
      MIN_DJI_DOWNWARD_DOT,
      Math.min(0.95, relativeAltitudeMeters / maximumDistance),
    );
    for (let step = 0; step <= DJI_SOURCE_CROP_STEPS; step += 1) {
      const sourceTopFraction = (step / DJI_SOURCE_CROP_STEPS) * MAX_DJI_SOURCE_TOP_CROP;
      const directions = this.cameraDirections(
        origin,
        yawDegrees,
        pitchDegrees,
        rollDegrees,
        hfov,
        vfov,
        sourceTopFraction,
        model,
      );
      const stable = directions.corners.every((direction) => {
        const downwardDot = -Cartesian3.dot(direction, localUp);
        const projectedDistance = relativeAltitudeMeters / downwardDot;
        return Number.isFinite(downwardDot)
          && downwardDot >= minimumDownwardDot
          && Number.isFinite(projectedDistance)
          && projectedDistance <= maximumDistance;
      });
      if (stable) return { directions, sourceTopFraction };
    }
    return undefined;
  }

  private pickGround(
    origin: Cartesian3,
    direction: Cartesian3,
    longitude: number,
    latitude: number,
    referenceHeight?: number,
    preferReferencePlane = false,
  ) {
    try {
      const ray = new Ray(origin, direction);
      if (this.hasElevationTerrain() && !preferReferencePlane) {
        const terrain = this.viewer.scene.globe.pick(ray, this.viewer.scene);
        if (terrain) return terrain;
      }
      if (referenceHeight !== undefined) {
        const ellipsoid = this.viewer.scene.globe.ellipsoid;
        const planePoint = Cartesian3.fromDegrees(longitude, latitude, referenceHeight, ellipsoid);
        const normal = ellipsoid.geodeticSurfaceNormal(planePoint, new Cartesian3());
        const denominator = Cartesian3.dot(direction, normal);
        if (Math.abs(denominator) < 1e-8) return undefined;
        const distance = Cartesian3.dot(Cartesian3.subtract(planePoint, origin, new Cartesian3()), normal) / denominator;
        if (!Number.isFinite(distance) || distance <= 0) return undefined;
        return Ray.getPoint(ray, distance, new Cartesian3());
      }
      const globe = this.viewer.scene.globe.pick(ray, this.viewer.scene);
      if (globe) return globe;
      const interval = IntersectionTests.rayEllipsoid(ray, this.viewer.scene.globe.ellipsoid);
      if (!interval || interval.start < 0) return undefined;
      return Ray.getPoint(ray, interval.start, new Cartesian3());
    } catch {
      return undefined;
    }
  }

  private ensureLiveEntities() {
    if (this.droneEntity) return;
    this.createSceneEntities("实时视频 AR");
  }

  private requestFrame(point: FlightPoint, telemetryState: LiveState) {
    if (this.videoObjectUrl) return;
    const name = point.videoFrame;
    if (!name) {
      this.cancelFrameRequest();
      this.updateSceneGeometry(telemetryState, false, "未投影：当前轨迹点没有视频帧");
      return;
    }
    if (!this.frameIsSynchronized(point)) {
      this.cancelFrameRequest();
      const seconds = (point.videoFrameTimeDeltaMs! / 1000).toFixed(1);
      this.updateSceneGeometry(telemetryState, false, `未投影：视频帧与轨迹相差 ${seconds}s`);
      return;
    }
    if (this.projectionMeshPoints.length > 0 && !point.projectionMesh) {
      // Once a flight uses visible-surface meshes, a missing mesh must not load
      // a new bitmap onto a four-corner/estimated surface. Cancel only pending
      // work and preserve the last coherent image + mesh pair.
      this.requestedFrameName = null;
      this.requestedFramePoint = null;
      this.frameRequestVersion += 1;
      this.cancelPendingProjectionUpdates();
      this.element("#videoArProjectionMode").textContent = "等待同帧三维网格（保持上一已配准画面）";
      this.viewer.scene.requestRender();
      return;
    }
    if (this.requireExactFootprint && !point.projectionMesh && !point.groundFootprint) {
      this.cancelFrameRequest();
      this.updateSceneGeometry(telemetryState, false, "未投影：当前视频帧缺少同帧三维配准");
      return;
    }
    this.requestedFramePoint = point;
    if (name === this.displayedFrameName) {
      this.requestedFrameName = name;
      this.commitFramePose(point);
      return;
    }
    this.element("#videoArProjectionMode").textContent = this.projectionVisible
      ? "正在同步下一帧（保持上一已配准画面）…"
      : "正在同步视频帧与相机姿态…";
    this.viewer.scene.requestRender();
    if (name === this.requestedFrameName && this.frameLoadInFlight) return;
    if (name !== this.requestedFrameName) this.resetStaticFrameGeometryRetry();
    this.requestedFrameName = name;
    this.frameRequestVersion += 1;
    if (!this.frameLoadInFlight) void this.loadRequestedFrame();
  }

  private cancelFrameRequest() {
    this.resetStaticFrameGeometryRetry();
    this.requestedFrameName = null;
    this.requestedFramePoint = null;
    this.frameRequestVersion += 1;
    this.hideProjectionPrimitive();
    this.viewer.scene.requestRender();
  }

  private resetStaticFrameGeometryRetry() {
    if (this.frameGeometryRetryTimer) window.clearTimeout(this.frameGeometryRetryTimer);
    this.frameGeometryRetryTimer = 0;
    this.frameGeometryRetryName = null;
    this.frameGeometryRetryAttempts = 0;
  }

  private markStaticFrameTextureFailure() {
    if (this.videoObjectUrl || !this.requestedFrameName) return;
    this.displayedFrameName = null;
    this.displayedFramePoint = null;
    this.scheduleStaticFrameGeometryRetry();
  }

  private scheduleStaticFrameGeometryRetry() {
    const name = this.requestedFrameName;
    if (!name || this.videoObjectUrl || !this.panelActive) return;
    if (this.frameGeometryRetryName !== name) {
      if (this.frameGeometryRetryTimer) window.clearTimeout(this.frameGeometryRetryTimer);
      this.frameGeometryRetryTimer = 0;
      this.frameGeometryRetryName = name;
      this.frameGeometryRetryAttempts = 0;
    }
    if (this.frameGeometryRetryTimer || this.frameGeometryRetryAttempts >= 2) return;
    this.frameGeometryRetryAttempts += 1;
    const version = this.frameRequestVersion;
    this.frameGeometryRetryTimer = window.setTimeout(() => {
      this.frameGeometryRetryTimer = 0;
      if (
        this.panelActive
        && !this.videoObjectUrl
        && this.requestedFrameName === name
        && this.frameRequestVersion === version
        && this.displayedFrameName !== name
        && !this.frameLoadInFlight
      ) void this.loadRequestedFrame();
    }, 200 * this.frameGeometryRetryAttempts);
  }

  private currentTextureFrame() {
    return this.videoObjectUrl
      ? textureFrameIdentity(this.loadGeneration, "video", "video", videoMediaTimeMs(this.decodedVideoTime, this.video.currentTime))
      : this.currentBitmapFrame;
  }

  private commitFramePose(point: FlightPoint) {
    const frameTimestamp = point.videoFrameTimestampMs ?? point.timestampMs;
    this.currentBitmapFrame = textureFrameIdentity(this.loadGeneration, "bitmap", "frame:" + point.videoFrame,
      point.videoTimeMs ?? Math.max(0, frameTimestamp - this.points[0].timestampMs));
    this.updateSceneGeometry(this.stateAtTimestamp(frameTimestamp), true, "", false, point.groundFootprint, undefined, point.projectionMesh, false, point.recordedAt);
  }

  private async loadRequestedFrame() {
    const name = this.requestedFrameName;
    const requestedPoint = this.requestedFramePoint;
    if (!name || !requestedPoint || name === this.displayedFrameName) return;
    const generation = this.loadGeneration;
    const version = this.frameRequestVersion;
    this.frameLoadInFlight = true;
    try {
      let blob = this.frameBlobCache.get(name);
      if (!blob) {
        if (this.zipReader) {
          const path = `${this.zipFramePrefix}${name}`;
          blob = await this.zipReader.readBlob(path, mimeFromName(name));
        } else {
          blob = this.frameFiles.get(name);
        }
      }
      if (!blob) throw new Error(`找不到视频帧：${name}`);
      if (generation !== this.loadGeneration || version !== this.frameRequestVersion || this.requestedFrameName !== name) return;
      const bitmap = await createImageBitmap(blob);
      try {
        if (generation === this.loadGeneration && version === this.frameRequestVersion && this.requestedFrameName === name) {
          this.mediaSourceWidth = bitmap.width;
          this.mediaSourceHeight = bitmap.height;
          this.sourceAspectRatio = bitmap.width / bitmap.height;
          this.displayedFrameName = name;
          this.displayedFramePoint = this.requestedFramePoint ?? requestedPoint;
          this.commitFramePose(this.displayedFramePoint);
          this.drawTexture(bitmap, false, this.currentBitmapFrame);
          if (!this.frameBlobCache.has(name)) {
            this.frameBlobCache.set(name, blob);
            while (this.frameBlobCache.size > 4) this.frameBlobCache.delete(this.frameBlobCache.keys().next().value as string);
          }
        }
      } finally {
        bitmap.close();
      }
    } catch (error) {
      if (generation === this.loadGeneration && version === this.frameRequestVersion && this.requestedFrameName === name) {
        this.hideProjectionPrimitive();
        this.setStatus(error instanceof Error ? error.message : "视频帧读取失败", true);
      }
    } finally {
      this.frameLoadInFlight = false;
      if (
        this.requestedFrameName
        && this.requestedFramePoint
        && (this.requestedFrameName !== name || this.frameRequestVersion !== version)
      ) void this.loadRequestedFrame();
    }
  }

  private readyMaterialTexture(canvas: HTMLCanvasElement) {
    const material = this.projectionMaterial as MaterialTextureInternals;
    const texture = material._textures?.image;
    const width = texture?.width ?? texture?._width;
    const height = texture?.height ?? texture?._height;
    const pending = material._loadedImages?.some((item) => item.id === "image") ?? false;
    if (
      this.projectionMaterial.uniforms.image !== canvas
      || material._texturePaths?.image !== canvas
      || pending
      || !texture
      || texture === material._defaultTexture
      || typeof texture.copyFrom !== "function"
      || texture.isDestroyed?.() === true
      || width !== canvas.width
      || height !== canvas.height
    ) return undefined;
    return texture;
  }

  private primeMaterialTexture(canvas: HTMLCanvasElement) {
    const material = this.projectionMaterial as MaterialTextureInternals;
    const context = (this.viewer.scene as unknown as { context?: unknown }).context;
    if (!context || typeof material.update !== "function" || this.projectionMaterial.isDestroyed()) return undefined;
    this.projectionMaterial.uniforms.image = canvas;
    try {
      // The first update queues a new Canvas identity; the second consumes that
      // queue and creates the real texture.  No Viewer-wide render setting is
      // changed, so the AR module remains isolated from the rest of the app.
      material.update(context);
      material.update(context);
      return this.readyMaterialTexture(canvas);
    } catch (error) {
      if (!this.textureUploadWarningShown) {
        this.textureUploadWarningShown = true;
        console.warn("[Video AR] Unable to initialize the reusable video texture", error);
      }
      return undefined;
    }
  }

  private textureTransactionPending() {
    return Boolean(
      this.projectionCandidate
      || (this.projectionPrimitive && (
        this.projectionAtomicSwapPending
        || this.pendingProjectionSurface
        || this.throttledProjectionSurface
        || this.projectionGeometryTimer
      ))
    );
  }

  private flushPendingTextureUpload() {
    if (!this.pendingTextureUpload) return true;
    const resizedCanvas = this.pendingTextureCanvas;
    const previousCanvas = this.textureCanvas;
    const previousWidth = this.textureWidth;
    const previousHeight = this.textureHeight;
    if (resizedCanvas) {
      this.textureCanvas = resizedCanvas;
      this.textureWidth = resizedCanvas.width;
      this.textureHeight = resizedCanvas.height;
      this.projectionMaterial.uniforms.image = resizedCanvas;
    }
    const texture = this.readyMaterialTexture(this.textureCanvas)
      ?? this.primeMaterialTexture(this.textureCanvas);
    if (!texture && resizedCanvas) {
      this.textureCanvas = previousCanvas;
      this.textureWidth = previousWidth;
      this.textureHeight = previousHeight;
      this.projectionMaterial.uniforms.image = previousCanvas;
      this.primeMaterialTexture(previousCanvas);
    }
    if (!texture) return false;
    try {
      texture.copyFrom({ source: this.textureCanvas });
      this.pendingTextureUpload = false;
      this.pendingTextureCanvas = undefined;
      if (Number.isFinite(this.pendingVideoTextureTime)) this.lastVideoTextureTime = this.pendingVideoTextureTime;
      this.uploadedTextureFrame = this.pendingTextureFrame;
      this.pendingTextureFrame = undefined;
      this.pendingVideoTextureTime = Number.NaN;
      this.textureNeedsRefresh = false;
      this.stableTextureUpload = true;
      return true;
    } catch (error) {
      if (resizedCanvas) {
        this.textureCanvas = previousCanvas;
        this.textureWidth = previousWidth;
        this.textureHeight = previousHeight;
        this.projectionMaterial.uniforms.image = previousCanvas;
        this.primeMaterialTexture(previousCanvas);
      }
      this.stableTextureUpload = false;
      if (!this.textureUploadWarningShown) {
        this.textureUploadWarningShown = true;
        console.warn("[Video AR] Deferred texture commit failed; keeping the previous projection", error);
      }
      return false;
    }
  }

  private drawTexture(source: HTMLVideoElement | ImageBitmap, forceUpload = false, bitmapFrame?: TextureFrameIdentity) {
    if (this.controlPointPicking || this.cameraInteracting) return;
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sourceWidth || !sourceHeight) return;
    this.mediaSourceWidth = sourceWidth;
    this.mediaSourceHeight = sourceHeight;
    if (source instanceof HTMLVideoElement && source.seeking) return;
    const frameIdentity = source instanceof HTMLVideoElement ? this.currentTextureFrame() : bitmapFrame;
    if (!frameIdentity || frameIdentity.sourceSession !== this.loadGeneration) return;
    if (this.projectionGeometryBuildFailed) return;
    if (source instanceof HTMLVideoElement && this.projectionMeshPoints.length > 0 && !this.meshVideoFrameReady) {
      return;
    }
    if (
      source instanceof HTMLVideoElement
      && !forceUpload
      && !this.textureNeedsRefresh
      && !this.pendingTextureUpload
      && sameTextureFrame(frameIdentity, this.uploadedTextureFrame)
    ) return;
    const scale = Math.min(1, MAX_TEXTURE_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));
    const nextAspectRatio = sourceWidth / sourceHeight;
    const aspectChanged = this.sourceAspectRatio === undefined
      || Math.abs(this.sourceAspectRatio - nextAspectRatio) > 0.001;
    this.sourceAspectRatio = nextAspectRatio;

    if (width !== this.textureWidth || height !== this.textureHeight) {
      // Canvas identity changes only when the media resolution changes.  This
      // lets Cesium allocate one correctly sized Texture, after which every
      // frame is uploaded into that same GPU object with copyFrom below.
      const nextTextureCanvas = document.createElement("canvas");
      nextTextureCanvas.width = width;
      nextTextureCanvas.height = height;
      const bootstrap = nextTextureCanvas.getContext("2d", { alpha: false });
      if (!bootstrap) throw new Error("无法创建视频纹理画布");
      bootstrap.drawImage(source, 0, 0, width, height);
      if (this.textureTransactionPending()) {
        this.pendingTextureCanvas = nextTextureCanvas;
        this.pendingTextureUpload = true;
        this.pendingVideoTextureTime = frameIdentity.mediaTimeMs / 1000;
        this.pendingTextureFrame = frameIdentity;
        this.awaitingDecodedTexture = false;
      } else {
        const previousCanvas = this.textureCanvas;
        const previousWidth = this.textureWidth;
        const previousHeight = this.textureHeight;
        this.textureCanvas = nextTextureCanvas;
        this.textureWidth = width;
        this.textureHeight = height;
        this.projectionMaterial.uniforms.image = nextTextureCanvas;
        const newTextureReady = Boolean(this.primeMaterialTexture(nextTextureCanvas));
        this.stableTextureUpload = newTextureReady;
        if (!newTextureReady) {
          this.textureCanvas = previousCanvas;
          this.textureWidth = previousWidth;
          this.textureHeight = previousHeight;
          this.projectionMaterial.uniforms.image = previousCanvas;
          this.stableTextureUpload = Boolean(this.primeMaterialTexture(previousCanvas));
          this.markStaticFrameTextureFailure();
        }
        this.pendingTextureUpload = false;
        this.pendingTextureCanvas = undefined;
        if (newTextureReady) {
          this.awaitingDecodedTexture = false;
          this.lastVideoTextureTime = frameIdentity.mediaTimeMs / 1000;
          this.uploadedTextureFrame = frameIdentity;
          this.pendingTextureFrame = undefined;
          this.textureNeedsRefresh = false;
        }
      }
    } else {
      // Always stage decoded media in the bounded, reusable canvas.  Direct
      // HTMLVideoElement -> WebGL uploads can produce black frames on some
      // hardware-decoder/browser combinations; the canvas path is consistent
      // and 4K sources are already capped to MAX_TEXTURE_EDGE above.
      const staging = this.textureCanvas.getContext("2d", { alpha: false });
      if (!staging) throw new Error("无法创建视频纹理画布");
      staging.drawImage(source, 0, 0, width, height);
      if (this.textureTransactionPending()) {
        this.pendingTextureUpload = true;
        this.pendingTextureCanvas = undefined;
        this.pendingVideoTextureTime = frameIdentity.mediaTimeMs / 1000;
        this.pendingTextureFrame = frameIdentity;
        this.awaitingDecodedTexture = false;
      } else {
        const uploadSource = this.textureCanvas;
        const texture = this.readyMaterialTexture(this.textureCanvas)
          ?? this.primeMaterialTexture(this.textureCanvas);
        if (texture) {
          try {
            texture.copyFrom({ source: uploadSource });
            this.pendingTextureUpload = false;
            this.pendingTextureCanvas = undefined;
            this.pendingVideoTextureTime = Number.NaN;
            this.lastVideoTextureTime = frameIdentity.mediaTimeMs / 1000;
            this.uploadedTextureFrame = frameIdentity;
            this.pendingTextureFrame = undefined;
            this.textureNeedsRefresh = false;
            this.stableTextureUpload = true;
            this.awaitingDecodedTexture = false;
          } catch (error) {
            this.stableTextureUpload = false;
            this.markStaticFrameTextureFailure();
            if (!this.textureUploadWarningShown) {
              this.textureUploadWarningShown = true;
              console.warn("[Video AR] Stable texture upload unavailable; keeping the last valid frame", error);
            }
          }
        } else this.markStaticFrameTextureFailure();
      }
    }

    if (this.modelProjectionAllowed && this.modelProjectionFrame && this.stableTextureUpload) this.commitModelCamera();
    // Failed or mismatched uploads must also refresh visibility; otherwise a
    // previously enabled projector can outlive its valid image-camera pair.
    this.applyVisibility();
    this.updateTexturePreview(source, sourceWidth, sourceHeight);
    this.element<HTMLElement>("#videoArPreview").dataset.textureUpload = this.stableTextureUpload ? "stable" : "warming";
    this.element("#videoArPreviewPlaceholder").classList.add("hidden");
    this.viewer.scene.requestRender();
    if (aspectChanged && this.videoObjectUrl && this.points.length) {
      this.updateAtPlayback(this.playbackMs, true);
    }
  }

  private updateTexturePreview(source: HTMLVideoElement | ImageBitmap, sourceWidth: number, sourceHeight: number) {
    // The GPU texture canvas may be detached; hide both actual DOM staging canvases.
    this.canvasA.classList.add("hidden");
    this.canvasB.classList.add("hidden");
    this.textureCanvas.classList.add("hidden");
    if (source instanceof HTMLVideoElement) {
      this.previewCanvas.classList.add("hidden");
      this.video.hidden = false;
      return;
    }
    this.video.hidden = true;
    const previewScale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(2, Math.round(sourceWidth * previewScale));
    const height = Math.max(2, Math.round(sourceHeight * previewScale));
    if (this.previewCanvas.width !== width || this.previewCanvas.height !== height) {
      this.previewCanvas.width = width;
      this.previewCanvas.height = height;
    }
    const context = this.previewCanvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建视频预览画布");
    context.drawImage(source, 0, 0, width, height);
    this.previewCanvas.classList.remove("hidden");
  }

  private clearCanvases() {
    for (const canvas of [this.canvasA, this.canvasB]) {
      const context = canvas.getContext("2d");
      context?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 16;
      canvas.height = 9;
      canvas.classList.toggle("hidden", canvas === this.canvasB);
    }
    this.video.hidden = true;
    this.textureCanvas = this.canvasA;
    this.previewCanvas = this.canvasB;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.mediaSourceWidth = 0;
    this.mediaSourceHeight = 0;
    this.sourceAspectRatio = undefined;
    this.lastVideoTextureTime = Number.NaN;
    this.pendingVideoTextureTime = Number.NaN;
    this.uploadedTextureFrame = undefined;
    this.pendingTextureFrame = undefined;
    this.currentBitmapFrame = undefined;
    this.textureNeedsRefresh = false;
    this.stableTextureUpload = false;
    this.pendingTextureUpload = false;
    this.pendingTextureCanvas = undefined;
    this.awaitingDecodedTexture = false;
    delete this.element<HTMLElement>("#videoArPreview").dataset.textureUpload;
    this.projectionMaterial.uniforms.image = this.canvasA;
    this.element("#videoArPreviewPlaceholder").classList.remove("hidden");
    this.element("#videoArProjectionMode").textContent = "未加载";
  }

  private locate() {
    const positions = this.points.length
      ? this.points.filter((_, index) => index % Math.max(1, Math.ceil(this.points.length / 2_000)) === 0)
        .map((point) => Cartesian3.fromDegrees(
          point.longitude,
          point.latitude,
          this.renderedAltitude(point.longitude, point.latitude, point.altitude, point.djiSrtPoseProjection?.relativeAltitudeMeters),
        ))
      : this.liveTrajectory;
    if (!positions.length) return;
    const sphere = BoundingSphere.fromPoints(positions);
    const range = Math.max(80, sphere.radius * 2.6);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.2,
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-38), range),
    });
  }

  private commitModelCamera() {
    const camera = this.effectiveCamera;
    const matches = sameTextureFrame(this.activeTextureFrame, this.uploadedTextureFrame)
      && cameraMatchesTexture(camera, this.uploadedTextureFrame?.mediaTimeMs ?? Number.NaN);
    if (!this.modelProjectionAllowed || !this.modelProjectionFrame || !this.modelProjector || !matches || !this.stableTextureUpload) return;
    this.modelProjector.setFrame(this.modelProjectionFrame);
    this.committedModelCamera = camera;
    this.committedModelTextureFrame = this.uploadedTextureFrame;
    if (camera) {
      if (this.droneEntity) this.droneEntity.position = new ConstantPositionProperty(new Cartesian3(camera.positionEcef.x, camera.positionEcef.y, camera.positionEcef.z));
      this.updateTelemetry({ longitude: camera.longitude, latitude: camera.latitude, altitude: camera.sourceAltitude,
        attitude: { heading: camera.attitude.yaw, pitch: camera.attitude.pitch, roll: camera.attitude.roll }, gimbal: camera.attitude });
    }
  }

  private applyVisibility() {
    const showFrustum = this.element<HTMLInputElement>("#videoArShowFrustum").checked;
    const showTrajectory = this.element<HTMLInputElement>("#videoArShowTrajectory").checked;
    const liveRenderable = this.liveOnline && this.hasOpenStatusSocket();
    const cameraRenderable = this.panelActive && !this.controlPointPicking && (this.points.length > 0 || liveRenderable);
    this.modelProjector?.setEnabled(cameraRenderable && this.modelProjectionAllowed && this.stableTextureUpload
      && sameTextureFrame(this.committedModelTextureFrame, this.uploadedTextureFrame)
      && cameraMatchesTexture(this.committedModelCamera, this.uploadedTextureFrame?.mediaTimeMs ?? Number.NaN));
    if (this.projectionPrimitive) {
      this.projectionPrimitive.show = cameraRenderable && this.projectionVisible;
    }
    if (this.droneEntity) this.droneEntity.show = cameraRenderable;
    if (this.frustumRaysEntity) this.frustumRaysEntity.show = cameraRenderable && showFrustum;
    if (this.frustumOutlineEntity) this.frustumOutlineEntity.show = cameraRenderable && showFrustum;
    if (this.cameraAxisEntity) this.cameraAxisEntity.show = cameraRenderable && showFrustum;
    if (this.trajectoryEntity) this.trajectoryEntity.show = this.panelActive && !this.controlPointPicking && showTrajectory;
    this.viewer.scene.requestRender();
  }

  private hasOpenStatusSocket() {
    return this.statusSocket?.readyState === WebSocket.OPEN;
  }

  private hasOpenVideoSocket() {
    return this.videoSocket?.readyState === WebSocket.OPEN;
  }

  private clearLiveFrameQueue() {
    this.liveFrameGeneration += 1;
    this.liveFrameAvailable = false;
    this.liveFramePose = null;
    this.liveFrameTimestampMs = undefined;
    this.liveFrameFootprint = undefined;
    this.liveFrameProjectionMesh = undefined;
    this.latestLiveFrame = null;
    if (this.liveDecodeTimer) window.clearTimeout(this.liveDecodeTimer);
    this.liveDecodeTimer = 0;
  }

  private updateTelemetry(state: LiveState) {
    const camera = this.modelProjectionAllowed && this.committedModelCamera ? this.committedModelCamera : this.effectiveCamera;
    this.element("#videoArPosition").textContent = camera
      ? `${camera.longitude.toFixed(6)}, ${camera.latitude.toFixed(6)} · ${camera.height && !camera.height.valid ? "未投影：缺少高程基准" : "实际椭球高 " + camera.ellipsoidHeight.toFixed(2) + "m"} · 源高程 ${camera.sourceAltitude.toFixed(2)}m`
      : `${state.longitude.toFixed(6)}, ${state.latitude.toFixed(6)} · 源高程 ${state.altitude.toFixed(2)}m · 等待实际投影参数`;
    const gimbal = camera?.attitude ?? state.gimbal;
    this.element("#videoArGimbal").textContent = `${camera ? "实际" : "源"} Y ${gimbal.yaw.toFixed(1)}° · P ${gimbal.pitch.toFixed(1)}° · R ${gimbal.roll.toFixed(1)}°`;
    this.element("#videoArEffectiveCamera").textContent = camera
      ? `PTS ${camera.frameTime.toFixed(3)}s · K fx/fy ${camera.intrinsics.fx.toFixed(2)} / ${camera.intrinsics.fy.toFixed(2)} · 视场 ${camera.horizontalFovDegrees.toFixed(2)}° × ${camera.verticalFovDegrees.toFixed(2)}° · ${camera.height?.explanation ?? "普通轨迹高程映射"}${camera.height && !camera.height.valid ? " · 基准缺失，已停止投影" : ""}`
      : "实际相机参数：等待同帧姿态";
    this.element("#videoArFrame").textContent = this.points.length ? `${this.currentIndex + 1} / ${this.points.length}` : "实时";
  }

  private updateProgress() {
    const progress = this.element<HTMLInputElement>("#videoArProgress");
    progress.value = String(this.durationMs ? Math.round((this.playbackMs / this.durationMs) * 1000) : 0);
    this.element("#videoArCurrentTime").textContent = formatTime(this.playbackMs);
    this.element("#videoArDuration").textContent = formatTime(this.durationMs);
  }

  private updateControls() {
    const loaded = this.points.length > 0;
    const correctionsInactive = this.independentDjiPoseProjection && !this.element<HTMLInputElement>("#videoArEnableCalibration").checked;
    for (const name of ["HeightOffset", "YawCorrection", "PitchCorrection", "RollCorrection", "EastOffset", "NorthOffset", "FootprintScale", "CameraFx", "CameraFy", "CameraCx", "CameraCy", "K1", "K2", "K3", "P1", "P2", "SurfaceHeight"]) {
      const control = this.element<HTMLInputElement>("#videoAr" + name);
      control.setAttribute("aria-description", correctionsInactive ? "DJI 手动校准关闭：当前输入不生效" : "校正作用于当前相机");
      control.title = correctionsInactive ? "未生效：请先启用 DJI 手动校准" : "";
      control.closest("label")?.classList.toggle("video-ar-inactive-calibration", correctionsInactive);
    }
    this.element("#videoArCalibrationState").textContent = correctionsInactive ? "DJI 手动校准关闭：位置、角度、镜头及高程校正均未生效。高程基准模式单独生效。" : "校正按当前数据类型生效；实测网格与四角使用原配准。";
    const timeOffset = this.element<HTMLInputElement>("#videoArTimeOffset");
    const lockTimeOffset = this.independentDjiPoseProjection || this.exactMediaBinding;
    timeOffset.disabled = lockTimeOffset;
    if (lockTimeOffset) timeOffset.value = "0";
    timeOffset.title = lockTimeOffset
      ? "同帧精确配准使用视频 PTS，禁止叠加人工时间偏移"
      : "普通轨迹可手动校正媒体时间";
    this.element<HTMLButtonElement>("#videoArPlay").disabled = !loaded;
    this.element<HTMLButtonElement>("#videoArPrevious").disabled = !loaded;
    this.element<HTMLButtonElement>("#videoArNext").disabled = !loaded;
    this.element<HTMLInputElement>("#videoArProgress").disabled = !loaded;
    this.element<HTMLButtonElement>("#videoArLocate").disabled = !loaded && !this.liveTrajectory.length;
    this.element<HTMLButtonElement>("#videoArClear").disabled = !loaded && !this.liveState;
    this.element("#videoArPlay").textContent = this.playing ? "❚❚" : "▶";
    if (!loaded && !this.liveState) {
      this.element("#videoArEffectiveCamera").textContent = "实际相机参数：等待同帧姿态";
      this.element("#videoArPosition").textContent = "--";
      this.element("#videoArGimbal").textContent = "--";
      this.element("#videoArFrame").textContent = "0 / 0";
      this.element("#videoArState").textContent = "待加载";
      this.element<HTMLInputElement>("#videoArProgress").value = "0";
      this.element("#videoArCurrentTime").textContent = "00:00";
      this.element("#videoArDuration").textContent = "00:00";
    }
  }

  private setBusy(busy: boolean, message?: string) {
    this.element<HTMLButtonElement>("#videoArLoad").disabled = busy;
    this.element<HTMLInputElement>("#videoArZipFile").disabled = busy;
    this.element<HTMLInputElement>("#videoArGeoreferenceFile").disabled = busy;
    this.element<HTMLButtonElement>("#videoArClearGeoreference").disabled = busy;
    if (message) this.setStatus(message);
  }

  private setStatus(message: string, error = false) {
    const status = this.element("#videoArStatus");
    status.textContent = message;
    status.classList.toggle("error", error);
    this.element("#videoArState").textContent = message.length > 22 ? `${message.slice(0, 22)}…` : message;
  }

  private reportError(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(`${prefix}：${message}`, true);
    this.notify(`${prefix}：${message}`, true);
  }

  private releaseVideo() {
    this.removePreparedVideoListeners?.();
    this.decodedVideoTime = Number.NaN;
    this.usesDecodedFrameCallbacks = false;
    this.removePreparedVideoListeners = undefined;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.videoObjectUrl) URL.revokeObjectURL(this.videoObjectUrl);
    this.videoObjectUrl = null;
    this.lastVideoTextureTime = Number.NaN;
    this.pendingVideoTextureTime = Number.NaN;
    this.uploadedTextureFrame = undefined;
    this.pendingTextureFrame = undefined;
    this.textureNeedsRefresh = false;
    this.awaitingDecodedTexture = false;
  }

  private connectLive() {
    try {
      const statusUrl = this.validSocketUrl(this.element<HTMLInputElement>("#videoArStatusSocket").value);
      const videoUrl = this.validSocketUrl(this.element<HTMLInputElement>("#videoArVideoSocket").value);
      this.loadGeneration += 1;
      this.invalidateCameraFrame();
      this.calibrationSessions = [];
      this.replaySettingsReady = false;
      this.independentDjiPoseProjection = false;
      this.independentVideoExactTimeline = false;
      this.playbackMs = 0;
      this.pause();
      this.releaseVideo();
      this.clearCanvases();
      this.frameBlobCache.clear();
      this.footprintPositionCache.clear();
      this.projectionMeshSurfaceCache.clear();
      this.points = [];
      this.projectionMeshPoints = [];
      this.projectionMeshVideoPoints = [];
      this.exactMediaBinding = false;
      this.meshSourceVideoDurationMs = undefined;
      this.meshVideoFrameReady = true;
      this.durationMs = 0;
      this.currentIndex = -1;
      this.removeProjectionPrimitive();
      this.dataSource.entities.removeAll();
      this.droneEntity = undefined;
      this.trajectoryEntity = undefined;
      this.frustumRaysEntity = undefined;
      this.frustumOutlineEntity = undefined;
      this.cameraAxisEntity = undefined;
      this.liveTrajectory = [];
      this.livePoseHistory = [];
      this.liveFramePose = null;
      this.liveFrameTimestampMs = undefined;
      this.liveMediaTimeOriginMs = undefined;
      this.liveBitmapSequence = 0;
      this.liveFrameFootprint = undefined;
      this.liveFrameProjectionMesh = undefined;
      this.liveRequiresExactFootprint = false;
      this.liveRequiresProjectionMesh = false;
      this.lastLiveMessageParseTime = 0;
      this.latestLiveFrame = null;
      this.liveFrameAvailable = false;
      this.lastLiveGeometryTime = 0;
      this.lastLiveTrajectoryRenderTime = 0;
      this.liveOnline = false;
      this.projectionSource = "live";
      this.liveStatusDeviceSn = undefined;
      this.liveVideoDeviceSn = undefined;
      this.automaticGroundHeight = undefined;
      this.liveGroundHeight = undefined;
      this.liveState = {
        longitude: 0, latitude: 0, altitude: 0,
        attitude: { heading: 0, pitch: 0, roll: 0 },
        gimbal: { yaw: 0, pitch: 0, roll: 0 },
      };
      const sessionId = ++this.liveSessionId;
      this.statusSocket = this.openSocket(statusUrl, false, sessionId);
      this.videoSocket = this.openSocket(videoUrl, true, sessionId);
      this.element("#videoArConnectLive").textContent = "断开实时流";
      this.setStatus("正在连接实时状态与视频流…");
      this.updateControls();
    } catch (error) {
      this.disconnectLive();
      this.reportError("实时流连接失败", error);
    }
  }

  private validSocketUrl(value: string) {
    const url = new URL(value.trim());
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("WebSocket 地址必须以 ws:// 或 wss:// 开头");
    return url.toString();
  }

  private openSocket(url: string, video: boolean, sessionId: number) {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      if (sessionId !== this.liveSessionId) return;
      this.setStatus(video ? "视频流已连接，等待状态数据…" : "实时状态已连接");
    });
    socket.addEventListener("message", (event) => {
      if (sessionId !== this.liveSessionId) return;
      if (video && (!this.panelActive || !this.liveOnline)) return;
      if (typeof event.data !== "string" || event.data.length > 12 * 1024 * 1024) return;
      if (video) {
        // Drop superseded frames before JSON.parse and mesh validation. A legal
        // 12MB message with thousands of control points must not be able to
        // monopolize the UI thread when the producer sends faster than render.
        const now = performance.now();
        const minimumParseInterval = 1000 / Math.min(MAX_CONTINUOUS_GEOMETRY_FPS, this.targetFps());
        if (now - this.lastLiveMessageParseTime < minimumParseInterval) return;
        this.lastLiveMessageParseTime = now;
      }
      try {
        const message = JSON.parse(event.data) as { type?: string; data?: unknown };
        if (video) this.handleLiveVideoMessage(message);
        else this.handleLiveStatusMessage(message);
      } catch (error) {
        console.warn("[Video AR] WebSocket message ignored", error);
      }
    });
    socket.addEventListener("error", () => {
      if (sessionId === this.liveSessionId) this.setStatus(video ? "实时视频连接异常" : "实时状态连接异常", true);
    });
    socket.addEventListener("close", () => {
      if (sessionId === this.liveSessionId && (video ? this.videoSocket : this.statusSocket) === socket) {
        if (video) {
          this.videoSocket = null;
          this.liveVideoDeviceSn = undefined;
          this.clearLiveFrameQueue();
          this.hideProjectionPrimitive();
          this.applyVisibility();
        }
        else {
          this.statusSocket = null;
          this.liveStatusDeviceSn = undefined;
          this.liveOnline = false;
          this.clearLiveGeometryTimer();
          this.clearLiveFrameQueue();
          this.hideProjectionPrimitive();
          this.applyVisibility();
        }
        if (!this.statusSocket && !this.videoSocket) this.element("#videoArConnectLive").textContent = "连接实时流";
        this.setStatus(video ? "实时视频已断开" : "实时状态已断开", true);
      }
    });
    return socket;
  }

  private handleLiveStatusMessage(message: { type?: string; data?: unknown }) {
    if (!this.liveState) return;
    const data = objectValue(message.data);
    const deviceSn = typeof data.device_sn === "string" ? data.device_sn.trim() : "";
    if (deviceSn) {
      if (this.liveVideoDeviceSn && this.liveVideoDeviceSn !== deviceSn) {
        this.clearLiveFrameQueue();
        this.hideProjectionPrimitive();
        this.setStatus(`已阻止跨设备投影：状态 ${deviceSn}，视频 ${this.liveVideoDeviceSn}`, true);
        return;
      }
      this.liveStatusDeviceSn = deviceSn;
    }
    let poseTimestampMs = timestampToMs(data.timestamp, Date.now());
    if (message.type === "drone_status" && data.is_online === false) {
      this.liveOnline = false;
      this.clearLiveGeometryTimer();
      this.clearLiveFrameQueue();
      this.hideProjectionPrimitive();
      if (this.frustumRaysEntity) this.frustumRaysEntity.show = false;
      if (this.frustumOutlineEntity) this.frustumOutlineEntity.show = false;
      if (this.cameraAxisEntity) this.cameraAxisEntity.show = false;
      this.setStatus("实时设备离线，投影已暂停");
      this.viewer.scene.requestRender();
      return;
    }
    if (message.type === "coordinates" || message.type === "drone_status") {
      const coordinates = objectValue(data.coordinates ?? data);
      poseTimestampMs = timestampToMs(coordinates.timestamp ?? data.timestamp, poseTimestampMs);
      const longitude = finite(coordinates.longitude, Number.NaN);
      const latitude = finite(coordinates.latitude, Number.NaN);
      const altitude = finite(coordinates.altitude, Number.NaN);
      if (Number.isFinite(longitude) && Number.isFinite(latitude) && Number.isFinite(altitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90) {
        this.liveState.longitude = longitude;
        this.liveState.latitude = latitude;
        this.liveState.altitude = altitude;
        const reportedGround = finite(
          coordinates.ground_altitude_m ?? coordinates.groundAltitude ?? data.ground_altitude_m,
          Number.NaN,
        );
        const reportedRelative = finite(
          coordinates.relative_altitude ?? coordinates.relativeAltitude ?? data.relative_altitude,
          Number.NaN,
        );
        if (Number.isFinite(reportedGround)) this.liveGroundHeight = reportedGround;
        else if (Number.isFinite(reportedRelative)) this.liveGroundHeight = altitude - reportedRelative;
        else if (this.liveGroundHeight === undefined) this.liveGroundHeight = altitude;
        this.liveState.attitude = {
          heading: finite(coordinates.heading, this.liveState.attitude.heading),
          pitch: finite(coordinates.pitch, this.liveState.attitude.pitch),
          roll: finite(coordinates.roll, this.liveState.attitude.roll),
        };
        this.liveOnline = message.type === "coordinates" || data.is_online !== false;
      }
      const combinedGimbal = objectValue(data.gimbal_attitude);
      if (Object.keys(combinedGimbal).length) {
        this.applyLiveGimbal(combinedGimbal);
        poseTimestampMs = timestampToMs(combinedGimbal.timestamp ?? data.timestamp, poseTimestampMs);
      }
    } else if (message.type === "gimbal_attitude") {
      const gimbal = objectValue(data.gimbal_attitude ?? data);
      this.applyLiveGimbal(gimbal);
      poseTimestampMs = timestampToMs(gimbal.timestamp ?? data.timestamp, poseTimestampMs);
    } else if (message.type === "error") {
      this.setStatus(`实时后端错误：${String(data.error ?? "未知错误")}`, true);
      return;
    }
    if (this.liveState.longitude === 0 && this.liveState.latitude === 0) return;
    this.recordLivePose(poseTimestampMs, this.liveState);
    if (!this.liveFramePose && this.liveFrameTimestampMs !== undefined) {
      this.liveFramePose = this.livePoseAt(this.liveFrameTimestampMs);
      this.liveFrameAvailable = Boolean(this.liveFramePose);
    }
    this.scheduleLiveSceneUpdate();
  }

  private scheduleLiveSceneUpdate(force = false) {
    if (!this.panelActive || !this.liveOnline || !this.hasOpenStatusSocket() || !this.liveState || (this.liveState.longitude === 0 && this.liveState.latitude === 0)) return;
    if (force) {
      this.clearLiveGeometryTimer();
      this.flushLiveSceneUpdate();
      return;
    }
    if (this.liveGeometryTimer) return;
    const geometryFps = Math.min(MAX_CONTINUOUS_GEOMETRY_FPS, this.targetFps());
    const wait = Math.max(0, 1000 / geometryFps - (performance.now() - this.lastLiveGeometryTime));
    this.liveGeometryTimer = window.setTimeout(() => {
      this.liveGeometryTimer = 0;
      this.flushLiveSceneUpdate();
    }, wait);
  }

  private flushLiveSceneUpdate() {
    if (!this.panelActive || !this.liveOnline || !this.hasOpenStatusSocket() || !this.liveState || (this.liveState.longitude === 0 && this.liveState.latitude === 0)) return;
    this.lastLiveGeometryTime = performance.now();
    const videoReady = this.hasOpenVideoSocket() && this.liveFrameAvailable && Boolean(this.liveFramePose);
    this.updateSceneGeometry(
      videoReady ? this.liveFramePose! : this.liveState,
      videoReady,
      videoReady ? "" : this.liveFrameTimestampMs === undefined
        ? "未投影：等待实时视频帧…"
        : "未投影：等待视频采集时刻的姿态…",
      false,
      videoReady ? this.liveFrameFootprint : undefined,
      undefined,
      videoReady ? this.liveFrameProjectionMesh : undefined,
    );
    const position = Cartesian3.fromDegrees(
      this.liveState.longitude,
      this.liveState.latitude,
      this.renderedAltitude(this.liveState.longitude, this.liveState.latitude, this.liveState.altitude),
    );
    const previous = this.liveTrajectory[this.liveTrajectory.length - 1];
    if (!previous || Cartesian3.distance(previous, position) > 1) {
      this.liveTrajectory.push(position);
      if (this.liveTrajectory.length > MAX_LIVE_TRAJECTORY_POINTS) this.liveTrajectory.splice(0, 500);
      const now = performance.now();
      if (!this.trajectoryEntity || now - this.lastLiveTrajectoryRenderTime >= 500) {
        this.lastLiveTrajectoryRenderTime = now;
        this.updateLiveTrajectoryEntity();
      }
    }
    this.updateTelemetry(this.liveState);
    this.element("#videoArState").textContent = "实时融合中";
    this.element<HTMLButtonElement>("#videoArLocate").disabled = false;
    this.element<HTMLButtonElement>("#videoArClear").disabled = false;
  }

  private clearLiveGeometryTimer() {
    if (this.liveGeometryTimer) window.clearTimeout(this.liveGeometryTimer);
    this.liveGeometryTimer = 0;
  }

  private applyLiveGimbal(gimbal: Record<string, unknown>) {
    if (!this.liveState) return;
    this.liveState.gimbal = {
      yaw: finite(gimbal.yaw ?? gimbal.gimbalYaw, this.liveState.gimbal.yaw),
      pitch: finite(gimbal.pitch ?? gimbal.gimbalPitch, this.liveState.gimbal.pitch),
      roll: finite(gimbal.roll ?? gimbal.gimbalRoll, this.liveState.gimbal.roll),
    };
  }

  private cloneLiveState(state: LiveState): LiveState {
    return {
      longitude: state.longitude,
      latitude: state.latitude,
      altitude: state.altitude,
      attitude: { ...state.attitude },
      gimbal: { ...state.gimbal },
    };
  }

  private recordLivePose(timestampMs: number, state: LiveState) {
    if (!Number.isFinite(timestampMs)) return;
    const sample = { timestampMs, state: this.cloneLiveState(state) };
    const last = this.livePoseHistory[this.livePoseHistory.length - 1];
    if (last && Math.abs(last.timestampMs - timestampMs) < 0.5) {
      this.livePoseHistory[this.livePoseHistory.length - 1] = sample;
    } else {
      this.livePoseHistory.push(sample);
      if (last && timestampMs < last.timestampMs) {
        this.livePoseHistory.sort((left, right) => left.timestampMs - right.timestampMs);
      }
    }
    const newest = this.livePoseHistory[this.livePoseHistory.length - 1]?.timestampMs ?? timestampMs;
    const firstUseful = this.livePoseHistory.findIndex((item) => item.timestampMs >= newest - LIVE_POSE_HISTORY_MS);
    if (firstUseful > 0) this.livePoseHistory.splice(0, firstUseful);
    if (this.livePoseHistory.length > 300) this.livePoseHistory.splice(0, this.livePoseHistory.length - 300);
  }

  private livePoseAt(frameTimestampMs: number) {
    const history = this.livePoseHistory;
    if (!history.length) return null;
    const timeOffsetMs = Math.min(120_000, Math.max(-120_000, this.numberInput("#videoArTimeOffset", 0) * 1000));
    const target = frameTimestampMs + timeOffsetMs;
    if (target <= history[0].timestampMs) {
      return history[0].timestampMs - target <= MAX_FRAME_POSE_DELTA_MS
        ? this.cloneLiveState(history[0].state)
        : null;
    }
    const last = history[history.length - 1];
    if (target >= last.timestampMs) {
      return target - last.timestampMs <= MAX_FRAME_POSE_DELTA_MS
        ? this.cloneLiveState(last.state)
        : null;
    }
    let low = 0;
    let high = history.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (history[middle].timestampMs <= target) low = middle;
      else high = middle;
    }
    const left = history[low];
    const right = history[high];
    const span = right.timestampMs - left.timestampMs;
    if (span <= 0 || span > MAX_FRAME_POSE_DELTA_MS * 2) {
      const nearest = target - left.timestampMs <= right.timestampMs - target ? left : right;
      return Math.abs(nearest.timestampMs - target) <= MAX_FRAME_POSE_DELTA_MS
        ? this.cloneLiveState(nearest.state)
        : null;
    }
    const amount = (target - left.timestampMs) / span;
    return {
      longitude: left.state.longitude + (right.state.longitude - left.state.longitude) * amount,
      latitude: left.state.latitude + (right.state.latitude - left.state.latitude) * amount,
      altitude: left.state.altitude + (right.state.altitude - left.state.altitude) * amount,
      attitude: {
        heading: interpolateAngleDegrees(left.state.attitude.heading, right.state.attitude.heading, amount),
        pitch: left.state.attitude.pitch + (right.state.attitude.pitch - left.state.attitude.pitch) * amount,
        roll: left.state.attitude.roll + (right.state.attitude.roll - left.state.attitude.roll) * amount,
      },
      gimbal: {
        yaw: interpolateAngleDegrees(left.state.gimbal.yaw, right.state.gimbal.yaw, amount),
        pitch: left.state.gimbal.pitch + (right.state.gimbal.pitch - left.state.gimbal.pitch) * amount,
        roll: left.state.gimbal.roll + (right.state.gimbal.roll - left.state.gimbal.roll) * amount,
      },
    };
  }

  private updateLiveTrajectoryEntity() {
    if (!this.trajectoryEntity) {
      this.trajectoryEntity = this.dataSource.entities.add({
        id: "video-ar-trajectory",
        polyline: { positions: this.liveTrajectory, width: 3, material: Color.fromCssColorString("#32e3aa").withAlpha(0.92) },
      });
    } else if (this.trajectoryEntity.polyline) {
      this.trajectoryEntity.polyline.positions = new ConstantProperty([...this.liveTrajectory]);
    }
    this.applyVisibility();
  }

  private handleLiveVideoMessage(message: { type?: string; data?: unknown }) {
    if (message.type !== "video_frame") return;
    const data = objectValue(message.data);
    if (typeof data.frame !== "string" || data.frame.length > 10 * 1024 * 1024) return;
    const deviceSn = typeof data.device_sn === "string" ? data.device_sn.trim() : "";
    if (deviceSn) {
      if (this.liveStatusDeviceSn && this.liveStatusDeviceSn !== deviceSn) {
        this.clearLiveFrameQueue();
        this.hideProjectionPrimitive();
        this.setStatus(`已阻止跨设备投影：状态 ${this.liveStatusDeviceSn}，视频 ${deviceSn}`, true);
        return;
      }
      if (this.liveVideoDeviceSn && this.liveVideoDeviceSn !== deviceSn) {
        this.clearLiveFrameQueue();
        this.hideProjectionPrimitive();
        this.setStatus(`视频设备已变化：${this.liveVideoDeviceSn} → ${deviceSn}，投影已暂停`, true);
        return;
      }
      this.liveVideoDeviceSn = deviceSn;
    }
    const format = typeof data.format === "string" ? data.format.toLowerCase() : "jpeg";
    const parsedTimestamp = timestampToMs(data.timestamp ?? data.frame_timestamp, Number.NaN);
    let footprint: GeoFootprint | undefined;
    let projectionMesh: GeoProjectionMesh | undefined;
    try {
      footprint = parseGeoFootprint(data, data.source_crs);
      projectionMesh = parseGeoProjectionMesh(data, data.source_crs);
      if (footprint) {
        const footprintTimestamp = footprint.timestampMs;
        if (!Number.isFinite(parsedTimestamp) && footprintTimestamp === undefined) {
          throw new Error("实时地理角点缺少视频帧时间戳");
        }
        if (
          Number.isFinite(parsedTimestamp)
          && footprintTimestamp !== undefined
          && Math.abs(footprintTimestamp - parsedTimestamp) > MAX_FRAME_POSE_DELTA_MS
        ) throw new Error("实时地理角点与视频帧时间差超过 1.5 秒");
        footprint = {
          ...footprint,
          timestampMs: footprintTimestamp ?? parsedTimestamp,
        };
      }
      if (projectionMesh) {
        const meshTimestamp = projectionMesh.timestampMs;
        if (!Number.isFinite(parsedTimestamp) && meshTimestamp === undefined) {
          throw new Error("实时三维控制网格缺少视频帧时间戳");
        }
        if (
          Number.isFinite(parsedTimestamp)
          && meshTimestamp !== undefined
          && Math.abs(meshTimestamp - parsedTimestamp) > MAX_MESH_FRAME_DELTA_MS
        ) throw new Error("实时三维控制网格与视频帧 PTS 相差超过 50ms");
        projectionMesh = {
          ...projectionMesh,
          timestampMs: meshTimestamp ?? parsedTimestamp,
        };
      }
    } catch (error) {
      if (!this.liveRequiresProjectionMesh) {
        this.clearLiveFrameQueue();
        this.hideProjectionPrimitive();
      }
      this.setStatus(error instanceof Error ? error.message : "实时三维配准数据无效", true);
      return;
    }
    if (projectionMesh) {
      this.liveRequiresProjectionMesh = true;
      this.liveRequiresExactFootprint = true;
    } else if (this.liveRequiresProjectionMesh) {
      // A mesh-bearing stream is permanently mesh-only for this connection.
      // Reject the new frame and retain the previous atomic image+mesh pair;
      // never downgrade a building surface to a four-corner plane.
      this.setStatus("实时流已启用三维网格模式，缺少同帧网格的画面已拒绝（保持上一帧）", true);
      return;
    } else if (footprint) this.liveRequiresExactFootprint = true;
    else if (this.liveRequiresExactFootprint) {
      this.clearLiveFrameQueue();
      this.hideProjectionPrimitive();
      this.setStatus("实时流已启用精确配准模式，缺少同帧网格/角点的帧已拒绝", true);
      return;
    }
    const effectiveTimestamp = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : projectionMesh?.timestampMs ?? footprint?.timestampMs;
    this.latestLiveFrame = {
      base64: data.frame,
      mime: format.includes("png") ? "image/png" : format.includes("webp") ? "image/webp" : "image/jpeg",
      timestampMs: effectiveTimestamp,
      footprint,
      projectionMesh,
    };
    if (this.panelActive) this.scheduleLiveDecode();
  }

  private scheduleLiveDecode() {
    if (
      this.liveDecodeInFlight
      || this.liveDecodeTimer
      || !this.latestLiveFrame
      || !this.panelActive
      || this.cameraInteracting
      || !this.liveOnline
      || !this.hasOpenStatusSocket()
      || !this.hasOpenVideoSocket()
    ) return;
    const wait = Math.max(0, 1000 / this.targetFps() - (performance.now() - this.lastLiveDecodeTime));
    this.liveDecodeTimer = window.setTimeout(() => {
      this.liveDecodeTimer = 0;
      void this.decodeLatestLiveFrame();
    }, wait);
  }

  private async decodeLatestLiveFrame() {
    const frame = this.latestLiveFrame;
    if (
      !frame
      || !this.panelActive
      || this.cameraInteracting
      || !this.liveOnline
      || !this.hasOpenStatusSocket()
      || !this.hasOpenVideoSocket()
    ) return;
    const sessionId = this.liveSessionId;
    const frameGeneration = this.liveFrameGeneration;
    this.latestLiveFrame = null;
    this.liveDecodeInFlight = true;
    try {
      const bitmap = await createImageBitmap(base64ToBlob(frame.base64, frame.mime));
      try {
        if (
          sessionId === this.liveSessionId
          && frameGeneration === this.liveFrameGeneration
          && this.panelActive
          && !this.cameraInteracting
          && this.liveOnline
          && this.hasOpenStatusSocket()
          && this.hasOpenVideoSocket()
        ) {
          const framePose = frame.timestampMs === undefined
            ? this.liveState ? this.cloneLiveState(this.liveState) : null
            : this.livePoseAt(frame.timestampMs);
          if (this.liveRequiresProjectionMesh && (!frame.projectionMesh || !framePose)) {
            this.setStatus("实时三维网格帧缺少同步姿态，已拒绝并保持上一帧", true);
            return;
          }
          if (frame.projectionMesh && framePose) {
            const dimensionsMatch = frame.projectionMesh.imageWidthPx === bitmap.width
              && frame.projectionMesh.imageHeightPx === bitmap.height;
            const validationOrigin = Cartesian3.fromDegrees(
              framePose.longitude,
              framePose.latitude,
              framePose.altitude,
            );
            const meshSurface = this.explicitProjectionMesh(frame.projectionMesh, validationOrigin).surface;
            if (!dimensionsMatch || !this.isUsableProjectionMesh(validationOrigin, meshSurface)) {
              this.setStatus(
                dimensionsMatch
                  ? "实时三维网格空间跨度异常，已拒绝并保持上一帧"
                  : `实时三维网格画幅 ${frame.projectionMesh.imageWidthPx}×${frame.projectionMesh.imageHeightPx} 与解码画面 ${bitmap.width}×${bitmap.height} 不一致，已保持上一帧`,
                true,
              );
              return;
            }
          }
          this.mediaSourceWidth = bitmap.width;
          this.mediaSourceHeight = bitmap.height;
          this.sourceAspectRatio = bitmap.width / bitmap.height;
          this.liveFrameTimestampMs = frame.timestampMs;
          if (frame.timestampMs !== undefined && this.liveMediaTimeOriginMs === undefined) this.liveMediaTimeOriginMs = frame.timestampMs;
          this.currentBitmapFrame = textureFrameIdentity(this.loadGeneration, "bitmap", "live:" + ++this.liveBitmapSequence,
            frame.timestampMs === undefined ? 0 : Math.max(0, frame.timestampMs - this.liveMediaTimeOriginMs!));
          this.liveFrameFootprint = frame.footprint;
          this.liveFrameProjectionMesh = frame.projectionMesh;
          this.liveFramePose = framePose;
          this.liveFrameAvailable = Boolean(this.liveFramePose);
          this.lastLiveDecodeTime = performance.now();
          this.scheduleLiveSceneUpdate(true);
          this.drawTexture(bitmap, false, this.currentBitmapFrame);
        }
      } finally {
        bitmap.close();
      }
    } catch (error) {
      console.warn("[Video AR] Live frame decode skipped", error);
    } finally {
      this.liveDecodeInFlight = false;
      if (this.cameraInteracting && !this.latestLiveFrame) this.latestLiveFrame = frame;
      if (this.latestLiveFrame) this.scheduleLiveDecode();
    }
  }

  private disconnectLive() {
    if (this.projectionSource === "live") this.invalidateCameraFrame();
    this.liveSessionId += 1;
    this.liveOnline = false;
    for (const socket of [this.statusSocket, this.videoSocket]) {
      if (!socket) continue;
      try {
        socket.close(1000, "Video AR stopped");
      } catch {
        // A WebSocket can reject close() while its constructor is still failing.
      }
    }
    this.statusSocket = null;
    this.videoSocket = null;
    this.liveStatusDeviceSn = undefined;
    this.liveVideoDeviceSn = undefined;
    this.clearLiveFrameQueue();
    this.clearLiveGeometryTimer();
    this.hideProjectionPrimitive();
    if (this.frustumRaysEntity) this.frustumRaysEntity.show = false;
    if (this.frustumOutlineEntity) this.frustumOutlineEntity.show = false;
    if (this.cameraAxisEntity) this.cameraAxisEntity.show = false;
    this.element("#videoArConnectLive").textContent = "连接实时流";
    this.viewer.scene.requestRender();
  }
}
