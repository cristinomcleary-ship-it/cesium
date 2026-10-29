import { Cartesian3, Math as CesiumMath, Matrix4, type Viewer } from 'cesium';
import type { MachineryMetadata } from './machineryTypes';
import { validateMachineryMetadata } from './machineryValidation';
import type { FallSupportRectangle } from './railSafetyGeometry';
import { normalizeRailSafetyDisplay, type RailSafetyDisplaySettings } from './railSafetyDisplay';

export type FallExportSceneReference = { id: string; name: string; kind: string; visible: boolean };
export type FallExportCamera = {
  positionWorld: [number, number, number]; directionWorld: [number, number, number]; upWorld: [number, number, number];
  longitude: number; latitude: number; height: number; headingDegrees: number; pitchDegrees: number; rollDegrees: number;
  fovRadians?: number;
};
export type RailSafetyFallExportProject = {
  schemaVersion: 1; kind: 'cesium-machinery-fall-project'; createdAt: string; projectId: string;
  resourceId: string; resourceName: string; modelState: MachineryMetadata; support?: FallSupportRectangle;
  animation: { directionDegrees: number; startAngleDegrees: 0; endAngleDegrees: 90; speedDegreesPerSecond: 12 };
  camera: FallExportCamera; display: RailSafetyDisplaySettings;
  scene: { mode: 'references-only'; resources: FallExportSceneReference[]; note: string };
};
const SCENE_NOTE = '工程保存相机、机械姿态、倾覆参数及场景资源引用，不包含完整倾斜摄影、地形或影像数据；须在原项目加载对应资源后重播。';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('动画工程格式无效');
  return value as Record<string, unknown>;
};
const number = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('动画工程包含无效数值');
  return value;
};
const text = (value: unknown, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('动画工程缺少有效项目或资源标识');
  return value;
};
const tuple = (value: unknown): [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('动画工程相机向量无效');
  return value.map(v => number(v, -1e10, 1e10)) as [number, number, number];
};
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('动画工程含不支持的字段，请使用平台导出的工程JSON');
};

/** Only named stable references are exported. URLs, credentials, provider objects and arbitrary
 * custom properties are deliberately never copied into a portable project. */
export function safeFallSceneReferences(values: readonly FallExportSceneReference[]): FallExportSceneReference[] {
  if (values.length > 5000) throw new Error('动画工程场景引用超过5000项，请缩小场景后导出');
  return values.map(value => ({ id: text(value.id), name: text(value.name), kind: text(value.kind, 80), visible: value.visible === true }));
}

export function captureFallExportCamera(viewer: Viewer): FallExportCamera {
  const camera = viewer.camera, p = camera.positionCartographic;
  const arr = (v: Cartesian3): [number, number, number] => [v.x, v.y, v.z];
  const frustum = camera.frustum as unknown as { fov?: number };
  return { positionWorld: arr(camera.positionWC), directionWorld: arr(camera.directionWC), upWorld: arr(camera.upWC),
    longitude: CesiumMath.toDegrees(p.longitude), latitude: CesiumMath.toDegrees(p.latitude), height: p.height,
    headingDegrees: CesiumMath.toDegrees(camera.heading), pitchDegrees: CesiumMath.toDegrees(camera.pitch), rollDegrees: CesiumMath.toDegrees(camera.roll),
    ...(typeof frustum.fov === 'number' ? { fovRadians: frustum.fov } : {}) };
}

export function restoreFallExportCamera(viewer: Viewer, camera: FallExportCamera): void {
  viewer.camera.cancelFlight(); viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  viewer.camera.setView({ destination: Cartesian3.fromArray(camera.positionWorld),
    orientation: { direction: Cartesian3.fromArray(camera.directionWorld), up: Cartesian3.fromArray(camera.upWorld) } });
  if (camera.fovRadians !== undefined && 'fov' in viewer.camera.frustum) viewer.camera.frustum.fov = camera.fovRadians;
  viewer.scene.requestRender();
}

export function createFallExportProject(input: {
  projectId: string; resourceId: string; resourceName: string; state: MachineryMetadata; support?: FallSupportRectangle;
  direction: number; camera: FallExportCamera; display: RailSafetyDisplaySettings; resources: readonly FallExportSceneReference[];
}): RailSafetyFallExportProject {
  return parseFallExportProject({ schemaVersion: 1, kind: 'cesium-machinery-fall-project', createdAt: new Date().toISOString(),
    projectId: input.projectId, resourceId: input.resourceId, resourceName: input.resourceName,
    modelState: structuredClone(input.state), ...(input.support ? { support: structuredClone(input.support) } : {}),
    animation: { directionDegrees: ((input.direction % 360) + 360) % 360, startAngleDegrees: 0, endAngleDegrees: 90, speedDegreesPerSecond: 12 },
    camera: input.camera, display: input.display, scene: { mode: 'references-only', resources: safeFallSceneReferences(input.resources), note: SCENE_NOTE } });
}

export function parseFallExportProject(input: unknown): RailSafetyFallExportProject {
  const value = object(input);
  keys(value, ['schemaVersion', 'kind', 'createdAt', 'projectId', 'resourceId', 'resourceName', 'modelState', 'support', 'animation', 'camera', 'display', 'scene']);
  if (value.schemaVersion !== 1 || value.kind !== 'cesium-machinery-fall-project') throw new Error('动画工程版本或类型不支持');
  const createdAt = text(value.createdAt, 40);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('动画工程时间无效');
  const animation = object(value.animation);
  keys(animation, ['directionDegrees', 'startAngleDegrees', 'endAngleDegrees', 'speedDegreesPerSecond']);
  if (animation.startAngleDegrees !== 0 || animation.endAngleDegrees !== 90 || animation.speedDegreesPerSecond !== 12) throw new Error('动画工程运动参数与当前演示版本不兼容');
  const c = object(value.camera);
  keys(c, ['positionWorld', 'directionWorld', 'upWorld', 'longitude', 'latitude', 'height', 'headingDegrees', 'pitchDegrees', 'rollDegrees', 'fovRadians']);
  const positionWorld = tuple(c.positionWorld), directionWorld = tuple(c.directionWorld), upWorld = tuple(c.upWorld);
  if (Math.hypot(...positionWorld) < 6_000_000 || Math.abs(Math.hypot(...directionWorld) - 1) > 0.001 || Math.abs(Math.hypot(...upWorld) - 1) > 0.001 || Math.abs(directionWorld.reduce((sum, n, i) => sum + n * upWorld[i], 0)) > 0.001) throw new Error('动画工程相机位置或朝向无效');
  const camera: FallExportCamera = { positionWorld, directionWorld, upWorld,
    longitude: number(c.longitude, -180, 180), latitude: number(c.latitude, -90, 90), height: number(c.height, -10000, 1e10),
    headingDegrees: number(c.headingDegrees, -360, 360), pitchDegrees: number(c.pitchDegrees, -180, 180), rollDegrees: number(c.rollDegrees, -360, 360),
    ...(c.fovRadians !== undefined ? { fovRadians: number(c.fovRadians, 0.01, Math.PI - 0.01) } : {}) };
  let support: FallSupportRectangle | undefined;
  if (value.support !== undefined) {
    const s = object(value.support); keys(s, ['length', 'width', 'centerX', 'centerZ']);
    support = { length: number(s.length, 1e-6, 1e6), width: number(s.width, 1e-6, 1e6), centerX: number(s.centerX, -1e6, 1e6), centerZ: number(s.centerZ, -1e6, 1e6) };
  }
  const scene = object(value.scene); keys(scene, ['mode', 'resources', 'note']);
  if (scene.mode !== 'references-only' || !Array.isArray(scene.resources) || scene.resources.length > 5000) throw new Error('动画工程场景引用无效');
  const resources = scene.resources.map(item => {
    const ref = object(item); keys(ref, ['id', 'name', 'kind', 'visible']);
    if (typeof ref.visible !== 'boolean') throw new Error('动画工程场景显示状态无效');
    return { id: text(ref.id), name: text(ref.name), kind: text(ref.kind, 80), visible: ref.visible };
  });
  if (new Set(resources.map(r => r.id)).size !== resources.length) throw new Error('动画工程场景引用重复');
  return { schemaVersion: 1, kind: 'cesium-machinery-fall-project', createdAt, projectId: text(value.projectId), resourceId: text(value.resourceId), resourceName: text(value.resourceName),
    modelState: validateMachineryMetadata(value.modelState), ...(support ? { support } : {}),
    animation: { directionDegrees: number(animation.directionDegrees, 0, 359.99999999999994), startAngleDegrees: 0, endAngleDegrees: 90, speedDegreesPerSecond: 12 },
    camera, display: normalizeRailSafetyDisplay(value.display), scene: { mode: 'references-only', resources, note: SCENE_NOTE } };
}

export function validateFallExportReplayScope(project: RailSafetyFallExportProject, projectId: string, resourceIds: readonly string[], resources: readonly FallExportSceneReference[]): void {
  if (project.projectId !== projectId) throw new Error('动画工程属于其他项目，请先打开对应项目');
  if (!resourceIds.includes(project.resourceId)) throw new Error('动画工程引用的机械不存在或不可查看，请先加载原机械资源');
  const current = new Map(resources.map(r => [r.id, r]));
  const missing = project.scene.resources.filter(r => !current.has(r.id) || current.get(r.id)?.kind !== r.kind);
  if (missing.length) throw new Error('场景资源尚未加载或不可查看：' + missing.slice(0, 5).map(r => r.name).join('、') + '。工程JSON不包含完整场景资源。');
  const hidden = project.scene.resources.filter(r => r.visible && current.get(r.id)?.visible !== true);
  if (hidden.length) throw new Error('请先显示工程所需场景资源：' + hidden.slice(0, 5).map(r => r.name).join('、'));
}
