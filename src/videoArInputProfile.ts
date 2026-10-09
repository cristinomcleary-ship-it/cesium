import type { SafetyVideoRoamAudit } from "./safetyVideoRoamData.ts";

export type InputVerification = "verified" | "estimated" | "missing";
export type VideoArInputEntry = {
  id: string; label: string; status: InputVerification; value: unknown | null;
  basis: string[]; impact: string; supplement: { target: "video-settings" | "model-quality" | "calibration" | "source-data"; label: string };
};
export type VideoArInputProfile = {
  schema: "video-ar-input-profile/v1"; id: string; generatedAt: string;
  identityScope: string; entries: VideoArInputEntry[];
  capabilities: {
    originalPlayback: { available: boolean; reason: string };
    trajectoryFollow: { available: boolean; reason: string };
    verifiedModelFusion: { available: false; reason: string };
  };
  missing: string[]; estimated: string[];
  accuracy: { pixelRms: null; pixelP95: null; pixelMax: null; geographicMeters: null; heightMeters: null; acceptance: "not-validated" };
};
export type VideoArInputProfileInput = { diagnostics: unknown; roamAudit?: SafetyVideoRoamAudit | null; generatedAt?: string };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const txt = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
/** Stable archive identity over declared inputs; NOT a media-content cryptographic hash. */
function identity(value: unknown): string {
  const text = JSON.stringify(value); let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `input-config-fnv1a32-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Read-only profile of actual main-platform diagnostics. Runtime consistency is not survey/calibration acceptance. */
export function buildVideoArInputProfile(input: VideoArInputProfileInput): VideoArInputProfile {
  const d = obj(input.diagnostics), media = obj(d.media), camera = obj(d.effectiveCamera), source = obj(camera.sourceIdentity);
  const metadata = obj(d.sourceMetadata), video = obj(media.video), trajectory = obj(media.trajectory), height = obj(camera.height);
  const intrinsics = obj(camera.intrinsics), distortion = obj(camera.distortion), provenance = obj(camera.provenance);
  const texture = obj(obj(d.textureFrames).active), models = arr(obj(d.rendering).models).map(obj), roam = input.roamAudit;
  const matched = metadata.recordingMatched === true, timelineMatched = metadata.timelineMatched === true;
  const sourceCrs = txt(metadata.sourceCrs), altitudeReference = txt(metadata.altitudeReference);
  const entries: VideoArInputEntry[] = [];
  const add = (id: string, label: string, status: InputVerification, value: unknown, basis: string[], impact: string,
    target: VideoArInputEntry["supplement"]["target"], action: string) => entries.push({ id, label, status, value: value === undefined || value === null ? null : structuredClone(value), basis, impact, supplement: { target, label: action } });
  const videoPresent = !!txt(video.name) && finite(video.sizeBytes) && video.sizeBytes > 0;
  add("video-identity", "视频身份", matched && videoPresent ? "verified" : videoPresent ? "estimated" : "missing", videoPresent ? { ...video, sourceSession: source.session ?? null } : null,
    [matched ? "当前录像与轨迹声明通过文件元数据一致性校验。" : "只读取了当前文件元数据，尚无同录像匹配证明。", "文件名、大小和加载会话不是原片内容哈希。"],
    "未核验同录像身份时不能沿用其他录像的相机与轨迹。", "source-data", "补充原片及对应遥测文件");
  const pts = finite(media.decodedTimeSeconds) && media.decodedTimeSeconds >= 0 ? media.decodedTimeSeconds * 1000 : null;
  const sameSession = source.session !== undefined && source.session === texture.sourceSession && metadata.sourceSession === source.session;
  const ptsMatched = pts !== null && finite(camera.videoTimeMs) && finite(texture.mediaTimeMs) && sameSession
    && Math.abs(camera.videoTimeMs - pts) < .1 && Math.abs(texture.mediaTimeMs - pts) < .1;
  add("media-pts", "媒体 PTS 与帧身份", ptsMatched ? "verified" : pts !== null ? "estimated" : "missing",
    pts === null ? null : { decodedTimeMs: pts, cameraTimeMs: camera.videoTimeMs ?? null, textureTimeMs: texture.mediaTimeMs ?? null, sourceSession: texture.sourceSession ?? null },
    [ptsMatched ? "解码纹理、相机参数与当前会话具有相同媒体 PTS。" : "当前未具备完整的解码帧、相机和纹理同帧证据。", "该检查不证明遥测传感器延迟为零，也不证明画面已成功投影。"],
    "同帧关系缺失时须拒绝组合新图像与旧相机/深度。", "video-settings", "查看帧同步诊断");
  add("trajectory-time", "轨迹时间关联", timelineMatched && matched ? "verified" : txt(trajectory.name) ? "estimated" : "missing",
    txt(trajectory.name) ? { ...trajectory, timeline: metadata.timeline ?? null, generator: metadata.generator ?? null, poseTimeMs: camera.poseTimeMs ?? null, rawRecordedAt: camera.rawRecordedAt ?? null } : null,
    [timelineMatched && matched ? String(metadata.runtimeAssociationBasis || metadata.associationBasis || "同录像时序的现有校验通过。") : "缺少覆盖当前录像且通过核验的媒体时间关联。", "装饰动画周期不能替代真实遥测时间。"],
    "无法可靠按视频媒体时间选择轨迹姿态。", "source-data", "补充带媒体时间的对应轨迹");
  add("coordinate-system", "轨迹坐标系与单位", sourceCrs ? "estimated" : "missing", sourceCrs ? { declaredSourceCrs: sourceCrs, runtimeScene: "EPSG:4978 / m", geographicInterface: "EPSG:4979 / degrees,m" } : null,
    [sourceCrs ? `来源声明 ${sourceCrs}；声明和运行时转换成功不等于外业坐标精度已核验。` : "原始轨迹未提供可追溯的坐标系声明。"],
    "坐标系或轴序不清会产生整体位置偏差。", "source-data", "补充轨迹坐标系、轴序与单位依据");
  const hasHeight = finite(camera.ellipsoidHeight) || finite(height.ellipsoidHeight);
  add("vertical-datum", "垂直基准", hasHeight ? "estimated" : "missing", hasHeight ? { declaredReference: altitudeReference, mode: height.mode ?? camera.altitudeMode ?? null,
    effectiveEllipsoidHeight: camera.ellipsoidHeight ?? height.ellipsoidHeight ?? null, sourceToEllipsoidOffset: height.sourceToEllipsoidOffset ?? null, datumHeight: height.datumHeight ?? null } : null,
    [String(height.explanation || camera.datumSource || "缺少可靠高程基准。"), "用户输入转换量、source/relative 模式或首帧估计地面都不自动构成外业高程核验。"],
    "未补齐可靠高程依据前，模型融合的垂直位置不能验收。", "calibration", "补充源高程基准、起飞点椭球高或转换依据");
  const modelValues = models.map(m => ({ id: m.id ?? null, name: m.name ?? null, matrix: m.modelMatrix ?? null, savedRecord: m.savedRecord ?? null,
    versionEvidence: m.versionEvidence ?? null }));
  const validMatrices = modelValues.length > 0 && modelValues.every(m => arr(m.matrix).length === 16 && arr(m.matrix).every(finite));
  add("model-transform", "模型身份与变换", validMatrices ? "verified" : models.length ? "estimated" : "missing", modelValues.length ? modelValues : null,
    [validMatrices ? "已读取当前真实模型的 16 项变换矩阵及资料库版本引用。" : "当前没有完整的工程模型变换记录。", "仅核验运行时变换可追溯，不证明模型源坐标、原点或配准正确；未进行模型内容哈希认证。"],
    "模型变换改变后必须使旧深度和投影候选失效。", "model-quality", "查看模型版本、加载质量与坐标依据");
  const hasK = [intrinsics.width, intrinsics.height, intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy].every(finite);
  add("camera-intrinsics", "相机内参 K", hasK ? "estimated" : "missing", hasK ? intrinsics : null,
    [JSON.stringify(camera.intrinsicsSource ?? provenance.intrinsics ?? "缺少相机内参来源"), "DJI 估计、FOV 推算或手工输入不是独立标定证据；像素原点为原始图像左上角。"],
    "缺少与原片分辨率绑定的 K 会影响边缘与尺度。", "calibration", "补充相机标定及原图尺寸");
  const hasD = Object.keys(distortion).length > 0 && Object.values(distortion).every(v => v === undefined || finite(v));
  add("camera-distortion", "镜头畸变 D", hasD ? "estimated" : "missing", hasD ? distortion : null,
    [String(provenance.distortion || "缺少镜头畸变来源"), "全零畸变只是当前模型假设，不代表已完成去畸变。"],
    "镜头畸变未知时不能把图像边缘残差视为已解决。", "calibration", "补充镜头畸变标定及整流记录");
  const attitude = obj(camera.attitude), hasAttitude = [attitude.yaw, attitude.pitch, attitude.roll].every(finite);
  add("attitude-definition", "姿态轴序与角度定义", hasAttitude ? "estimated" : "missing", hasAttitude ? { attitude, aircraft: camera.aircraft ?? null, declaration: metadata.attitudeDefinition ?? null } : null,
    ["当前运行约定：NED yaw/pitch/roll（度）转 ENU；不能据此推定遥测使用同一约定。", txt(metadata.attitudeDefinition) || "缺少源姿态定义依据。"],
    "姿态定义错误会造成方向、俯仰和旋转偏差。", "source-data", "补充姿态轴序、正方向和云台定义");
  add("mounting-relation", "相机安装关系", txt(metadata.mountingRelation) ? "estimated" : "missing", txt(metadata.mountingRelation),
    [txt(metadata.mountingRelation) ? "已保留来源安装关系声明，仍需校验。" : "缺少相机与机体/云台的安装旋转和平移依据。"],
    "不能把机体姿态直接认定为光学相机姿态。", "calibration", "补充相机安装旋转、杆臂与时间延迟标定");
  add("independent-checkpoints", "独立检查点与精度", "missing", null,
    ["现有控制点会话和画面贴合不构成全片独立验收。最终检查点不得参与拟合或调参。"],
    "需要至少 6 个覆盖地面、桥面、屋顶的独立检查点及全片多时刻结果。", "calibration", "采集独立检查点并运行配准验收");
  const playback = finite(media.width) && finite(media.height) && media.width > 0 && media.height > 0 && finite(media.readyState) && media.readyState >= 2;
  const roamMatches = !!roam && !!txt(media.recordId) && roam.recordId === media.recordId && roam.videoId === `video:${media.recordId}`;
  const follow = roamMatches && !!roam?.recordingMatched && !!roam.timelineMatched && !!roam.heightReference && roam.missing.length === 0;
  return { schema: "video-ar-input-profile/v1", id: identity({ videoRecordId: media.recordId ?? null, video, trajectory, calibration: source.calibration ?? null, models: modelValues, metadata }),
    generatedAt: input.generatedAt ?? new Date().toISOString(), identityScope: "配置指纹 + 文件元数据/资料库引用；不是原片或模型内容哈希。", entries,
    capabilities: { originalPlayback: { available: playback, reason: playback ? "原视频解码可用；独立于三维配准。" : "等待原视频源和有效解码帧。" },
      trajectoryFollow: { available: follow, reason: follow ? "同录像、媒体时序和高程条件符合现有航迹跟随约束；不是光学配准验收。" : !roamMatches && roam ? "航迹核验属于其他录像或当前录像资料编号未知，已拒绝沿用。" : roam?.missing.join("；") || "尚未得到当前录像的航迹跟随核验结果。" },
      verifiedModelFusion: { available: false, reason: "缺少绑定当前输入版本的独立检查点与全片精度报告；运行时投影不等于经核验的模型融合。" } },
    missing: entries.filter(e => e.status === "missing").map(e => e.id), estimated: entries.filter(e => e.status === "estimated").map(e => e.id),
    accuracy: { pixelRms: null, pixelP95: null, pixelMax: null, geographicMeters: null, heightMeters: null, acceptance: "not-validated" } };
}
