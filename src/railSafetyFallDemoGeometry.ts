import { Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix3, Matrix4, Quaternion, Transforms } from 'cesium';
import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import type { FallSupportRectangle, Point2 } from './railSafetyGeometry';
import { prepareRailSafetyFallProjection, resolveRailSafetyFallAxis, type PreparedRailSafetyFallProjection } from './railSafetyFallProjection';

export type PreparedRailSafetyFallDemo = {
  readonly initialPosition: Cartesian3;
  readonly initialOrientation: Quaternion;
  readonly tangentToWorld: Matrix4;
  /** Shared complete posed mesh used by the footprint worker. */
  readonly projection: PreparedRailSafetyFallProjection;
  /** Counterclockwise in the station's east/north tangent plane, in metres. */
  readonly supportPolygon: readonly Readonly<Point2>[];
  readonly supportSource: 'user-defined' | 'model-outriggers' | 'model-base-estimate';
};

export type RailSafetyFallDemoPose = {
  /** Set directly on an Entity showing the current posed machinery GLB, with scale 1. */
  position: Cartesian3;
  orientation: Quaternion;
  pivot: [Cartesian3, Cartesian3];
  /** Normalized compass bearing of the continuous geometric support line. */
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
  const projection = prepareRailSafetyFallProjection(asset, state, supportOverride);
  const p = state.placement, theta = CesiumMath.toRadians(p.heading);
  const initialPosition = Cartesian3.fromDegrees(p.longitude, p.latitude, p.height);
  return {
    initialPosition,
    initialOrientation: Transforms.headingPitchRollQuaternion(initialPosition, new HeadingPitchRoll(theta, 0, 0)),
    tangentToWorld: Transforms.eastNorthUpToFixedFrame(initialPosition),
    supportPolygon: projection.supportPolygon,
    supportSource: projection.supportSource,
    projection,
  };
}

/** Rotate the complete already-posed GLB around the hull support line for any
 * requested compass bearing (0 north, 90 east). A corner direction contacts a
 * support corner; it is not snapped to a discrete physical edge. The projection
 * worker resolves this exact same line and rigid rotation. */
export function computeRailSafetyFallDemoPose(
  prepared: PreparedRailSafetyFallDemo,
  directionDegrees: number,
  angleDegrees: number,
): RailSafetyFallDemoPose {
  if (!Number.isFinite(angleDegrees) || angleDegrees < 0 || angleDegrees > 90) throw new RangeError('倾覆演示角度须在 0–90° 之间');
  const selected = resolveRailSafetyFallAxis(prepared.projection, directionDegrees);
  const a = selected.start, b = selected.end;
  const start = Matrix4.multiplyByPoint(prepared.tangentToWorld, new Cartesian3(a.x, a.y, 0), new Cartesian3());
  const end = Matrix4.multiplyByPoint(prepared.tangentToWorld, new Cartesian3(b.x, b.y, 0), new Cartesian3());
  const result: RailSafetyFallDemoPose = {
    position: Cartesian3.clone(prepared.initialPosition),
    orientation: Quaternion.clone(prepared.initialOrientation),
    pivot: [start, end],
    actualDirectionDegrees: selected.direction,
    angleDegrees,
  };
  if (angleDegrees === 0) return result;
  const axis = Matrix4.multiplyByPointAsVector(prepared.tangentToWorld, new Cartesian3(b.x - a.x, b.y - a.y, 0), new Cartesian3());
  Cartesian3.normalize(axis, axis);
  // Positive rotation around the support tangent tips local up toward its normal.
  const rotation = Quaternion.fromAxisAngle(axis, CesiumMath.toRadians(angleDegrees));
  const matrix = Matrix3.fromQuaternion(rotation);
  const offset = Cartesian3.subtract(prepared.initialPosition, start, new Cartesian3());
  Matrix3.multiplyByVector(matrix, offset, offset);
  Cartesian3.add(start, offset, result.position);
  Quaternion.multiply(rotation, prepared.initialOrientation, result.orientation);
  Quaternion.normalize(result.orientation, result.orientation);
  return result;
}
