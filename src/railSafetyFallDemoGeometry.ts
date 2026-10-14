import { Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix3, Matrix4, Quaternion, Transforms } from 'cesium';
import { computeMachineryGeometry } from './machinery/engine';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { convexHull, polygonArea, type FallSupportRectangle, type Point2 } from './railSafetyGeometry';

export type PreparedRailSafetyFallDemo = {
  readonly initialPosition: Cartesian3;
  readonly initialOrientation: Quaternion;
  readonly tangentToWorld: Matrix4;
  /** Counterclockwise in the station's east/north tangent plane, in metres. */
  readonly supportPolygon: readonly Readonly<Point2>[];
  readonly supportSource: 'user-defined' | 'model-outriggers' | 'model-base-estimate';
};

export type RailSafetyFallDemoPose = {
  /** Set directly on an Entity showing the current posed machinery GLB, with scale 1. */
  position: Cartesian3;
  orientation: Quaternion;
  pivot: [Cartesian3, Cartesian3];
  /** Compass bearing of the selected support edge's outward normal. */
  actualDirectionDegrees: number;
  angleDegrees: number;
};

/** Capture current posed support geometry without retaining or changing saved state.
 * This uses the same contact convention as computeMachineryFallEnvelope: crane
 * support feet 10–13, otherwise the lowest indexed vertices, or a user rectangle.
 * It is a rigid geometric demonstration, with no load/stability/contact simulation. */
export function prepareRailSafetyFallDemo(
  asset: LoadedMachineryAsset,
  state: MachineryMetadata,
  supportOverride?: FallSupportRectangle,
): PreparedRailSafetyFallDemo {
  const p = state.placement;
  if (asset.id !== state.assetId || asset.version !== state.assetVersion) throw new RangeError('机械资产与保存参数版本不匹配');
  if (![p.longitude, p.latitude, p.height, p.heading].every(Number.isFinite)
    || Math.abs(p.longitude) > 180 || Math.abs(p.latitude) >= 89.9 || Math.abs(p.height) > 100_000) {
    throw new RangeError('机械站位或朝向无效');
  }
  const mesh = computeMachineryGeometry(asset, state.parameters);
  const used = [...new Set(mesh.indices)];
  if (!used.length) throw new RangeError('机械模型没有可用于演示的实体顶点');
  const vertices = used.map(index => ({ x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 2], h: mesh.positions[index * 3 + 1], part: asset.partIds[index] }));
  if (vertices.some(v => ![v.x, v.y, v.h].every(Number.isFinite) || Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.h)) > 1000)) {
    throw new RangeError('机械尺寸超出本地演示可支持范围');
  }
  const height = mesh.bounds.size[1], groundTolerance = Math.max(1e-5, height * 1e-6);
  if (vertices.some(v => v.h < -groundTolerance)) throw new RangeError('当前机械姿态有部件低于假定地面，请核对模型地面基准');
  let support: Point2[];
  let supportSource: PreparedRailSafetyFallDemo['supportSource'];
  if (supportOverride) {
    const s = supportOverride;
    if (![s.length, s.width, s.centerX, s.centerZ].every(Number.isFinite) || s.length <= 0 || s.width <= 0
      || Math.max(s.length, s.width, Math.abs(s.centerX), Math.abs(s.centerZ)) > 1000) {
      throw new RangeError('自定义支承尺寸或中心偏移无效');
    }
    support = [
      { x: s.centerX - s.length / 2, y: s.centerZ - s.width / 2 },
      { x: s.centerX + s.length / 2, y: s.centerZ - s.width / 2 },
      { x: s.centerX + s.length / 2, y: s.centerZ + s.width / 2 },
      { x: s.centerX - s.length / 2, y: s.centerZ + s.width / 2 },
    ];
    supportSource = 'user-defined';
  } else if (asset.type === 'crane') {
    const bottom: Point2[] = [];
    for (let part = 10; part <= 13; part++) {
      const points = vertices.filter(v => v.part === part);
      const min = points.reduce((value, v) => Math.min(value, v.h), Infinity);
      if (!points.length || min > Math.max(0.01 * state.parameters.overall_scale, groundTolerance)) {
        throw new RangeError('无法识别四个落地支腿，请填写实际支承矩形');
      }
      const tolerance = Math.max(1e-6, height * 1e-5);
      for (const point of points) if (point.h <= min + tolerance) bottom.push({ x: point.x, y: point.y });
    }
    support = convexHull(bottom); supportSource = 'model-outriggers';
  } else {
    const min = vertices.reduce((value, v) => Math.min(value, v.h), Infinity);
    const tolerance = Math.max(1e-6, height * 1e-5);
    support = convexHull(vertices.filter(v => v.h <= min + tolerance).map(v => ({ x: v.x, y: v.y })));
    supportSource = 'model-base-estimate';
  }
  if (support.length < 3 || Math.abs(polygonArea(support)) < 1e-8) throw new RangeError('无法得到有效地面支承区域，请填写实际支承矩形');
  const theta = CesiumMath.toRadians(p.heading), cosine = Math.cos(theta), sine = Math.sin(theta);
  // Cesium's built-in GLB axis correction maps source +X north, +Y up, +Z east.
  // The +X/+Z -> east/north conversion reverses winding; rebuild a CCW hull.
  const supportPolygon = convexHull(support.map(v => ({ x: v.x * sine + v.y * cosine, y: v.x * cosine - v.y * sine })));
  const initialPosition = Cartesian3.fromDegrees(p.longitude, p.latitude, p.height);
  return {
    initialPosition,
    initialOrientation: Transforms.headingPitchRollQuaternion(initialPosition, new HeadingPitchRoll(theta, 0, 0)),
    tangentToWorld: Transforms.eastNorthUpToFixedFrame(initialPosition),
    supportPolygon,
    supportSource,
  };
}

/** Rotate the complete already-posed GLB around the horizontal support edge whose
 * outward normal is closest to a requested compass bearing (0 north, 90 east).
 * Edges, rather than an arbitrary centre axis, keep the demonstrated pivot fixed.
 * The actual edge bearing is returned because a discrete support hull need not
 * have an edge normal exactly at the requested bearing. */
export function computeRailSafetyFallDemoPose(
  prepared: PreparedRailSafetyFallDemo,
  directionDegrees: number,
  angleDegrees: number,
): RailSafetyFallDemoPose {
  if (!Number.isFinite(directionDegrees)) throw new RangeError('倾覆演示方向必须为有限角度');
  if (!Number.isFinite(angleDegrees) || angleDegrees < 0 || angleDegrees > 90) throw new RangeError('倾覆演示角度须在 0–90° 之间');
  const direction = CesiumMath.toRadians(((directionDegrees % 360) + 360) % 360);
  const east = Math.sin(direction), north = Math.cos(direction), polygon = prepared.supportPolygon;
  let best = -Infinity, selected = -1, normalEast = 0, normalNorth = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length <= 1e-9) continue;
    // Right-hand normal of a CCW edge points out of the support hull.
    const nx = dy / length, ny = -dx / length, alignment = nx * east + ny * north;
    if (alignment > best + 1e-12) { best = alignment; selected = i; normalEast = nx; normalNorth = ny; }
  }
  if (selected < 0) throw new RangeError('倾覆演示缺少有效支承边');
  const a = polygon[selected], b = polygon[(selected + 1) % polygon.length];
  const start = Matrix4.multiplyByPoint(prepared.tangentToWorld, new Cartesian3(a.x, a.y, 0), new Cartesian3());
  const end = Matrix4.multiplyByPoint(prepared.tangentToWorld, new Cartesian3(b.x, b.y, 0), new Cartesian3());
  const result: RailSafetyFallDemoPose = {
    position: Cartesian3.clone(prepared.initialPosition),
    orientation: Quaternion.clone(prepared.initialOrientation),
    pivot: [start, end],
    actualDirectionDegrees: (CesiumMath.toDegrees(Math.atan2(normalEast, normalNorth)) + 360) % 360,
    angleDegrees,
  };
  if (angleDegrees === 0) return result;
  const axis = Matrix4.multiplyByPointAsVector(prepared.tangentToWorld, new Cartesian3(b.x - a.x, b.y - a.y, 0), new Cartesian3());
  Cartesian3.normalize(axis, axis);
  // Positive rotation around a CCW edge tips local up toward its outward normal.
  const rotation = Quaternion.fromAxisAngle(axis, CesiumMath.toRadians(angleDegrees));
  const matrix = Matrix3.fromQuaternion(rotation);
  const offset = Cartesian3.subtract(prepared.initialPosition, start, new Cartesian3());
  Matrix3.multiplyByVector(matrix, offset, offset);
  Cartesian3.add(start, offset, result.position);
  Quaternion.multiply(rotation, prepared.initialOrientation, result.orientation);
  Quaternion.normalize(result.orientation, result.orientation);
  return result;
}
