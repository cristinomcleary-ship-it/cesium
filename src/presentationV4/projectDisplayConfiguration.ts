import { BoundingSphere, Cartesian3, Cartographic, Matrix4, Transforms, type Viewer } from "cesium";
import envelope from "./production2-display-envelope.json";
import type { RegisteredPhotogrammetry } from "../safetyModelSurfacePicker";
import type { SafetyDataset } from "../safetyTypes";
import type { SafetyStageRect } from "../safetyScenePresentation";
import type { ProjectDisplayConfiguration } from "./types";

/** Survey-independent DISPLAY settings bound to the exact sampled model and transform.
 * No user geometry, project camera persistence, or engineering matrix is changed here.
 */
export function resolveProjectDisplayConfiguration(
  models: readonly RegisteredPhotogrammetry[], _dataset: SafetyDataset,
  stage: SafetyStageRect, viewer: Viewer,
): ProjectDisplayConfiguration | undefined {
  if (!models.some(m => m.assetId === envelope.assetId && m.assetVersion === envelope.assetVersion
    && m.coordinateTransformVersion === envelope.coordinateTransformVersion)) return;
  const positions = envelope.positions.map(p => new Cartesian3(p[0], p[1], p[2]));
  const baseDepthMeters = 42;
  const sphere = BoundingSphere.fromPoints(positions);
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(sphere.center), new Matrix4());
  const bottom = Math.min(...positions.map(p => Cartographic.fromCartesian(p).height)) - baseDepthMeters;
  const extents = positions.concat(positions.map(p => {
    const c = Cartographic.fromCartesian(p); return Cartesian3.fromRadians(c.longitude, c.latitude, bottom);
  })).map(p => Matrix4.multiplyByPoint(inverse, p, new Cartesian3()));
  const headingDegrees = 68, pitchDegrees = -42.5;
  const heading = headingDegrees * Math.PI / 180, pitch = pitchDegrees * Math.PI / 180;
  const right = new Cartesian3(Math.cos(heading), -Math.sin(heading), 0);
  const direction = new Cartesian3(Math.sin(heading) * Math.cos(pitch), Math.cos(heading) * Math.cos(pitch), Math.sin(pitch));
  const up = Cartesian3.cross(right, direction, new Cartesian3());
  const frustum = viewer.camera.frustum;
  if (!("fovy" in frustum) || !Number.isFinite(frustum.fovy)) return;
  const width = viewer.canvas.clientWidth, height = viewer.canvas.clientHeight;
  const scale = height / (2 * Math.tan(Number(frustum.fovy) / 2));
  const points = extents.map(p => ({ x: Cartesian3.dot(p, right), y: Cartesian3.dot(p, up), d: Cartesian3.dot(p, direction) }));
  // Iteratively center the projected silhouette inside the uncovered stage. The camera
  // target is display configuration; no model, display vertex or user coordinate moves.
  let range = sphere.radius * 4;
  const targetOffset = new Cartesian3();
  for (let iteration = 0; iteration < 14; iteration++) {
    const cx = Cartesian3.dot(targetOffset, right), cy = Cartesian3.dot(targetOffset, up), cd = Cartesian3.dot(targetOffset, direction);
    const xs = points.map(p => width / 2 + (p.x - cx) * scale / (range + p.d - cd));
    const ys = points.map(p => height / 2 - (p.y - cy) * scale / (range + p.d - cd));
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    range *= Math.max((xmax - xmin) / (stage.width * 0.82), (ymax - ymin) / (stage.height * 0.78));
    const dx = ((xmin + xmax) / 2 - (stage.left + stage.width / 2)) * range / scale;
    const dy = ((stage.top + stage.height / 2) - (ymin + ymax) / 2) * range / scale;
    Cartesian3.add(targetOffset, Cartesian3.multiplyByScalar(right, dx, new Cartesian3()), targetOffset);
    Cartesian3.add(targetOffset, Cartesian3.multiplyByScalar(up, dy, new Cartesian3()), targetOffset);
  }
  const target = Matrix4.multiplyByPoint(Transforms.eastNorthUpToFixedFrame(sphere.center), targetOffset, new Cartesian3());
  return {
    displayEnvelope: { id: envelope.id, positions, clippingPositions: envelope.clippingPositions.map(p => new Cartesian3(p[0], p[1], p[2])), heightSource: "sampled-model", baseDepthMeters },
    home: { headingDegrees, pitchDegrees, rangeMeters: range, target, duration: 1.6,
      padding: { left: stage.left, right: Math.max(0, width - stage.left - stage.width),
        top: stage.top, bottom: Math.max(0, height - stage.top - stage.height) } },
  };
}
