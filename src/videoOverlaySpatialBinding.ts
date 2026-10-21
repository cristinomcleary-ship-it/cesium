import { Cartesian2, Cartesian3, Matrix4, type Viewer } from 'cesium';
import { distortNormalizedPoint, undistortPixel, type CameraIntrinsics, type LensDistortion } from './videoArCamera.ts';
import { overlayLensBounds } from './videoOverlayLens.ts';
import type { VideoOverlayResources } from './videoOverlayResources.ts';

type Point3 = { x: number; y: number; z: number };
export type SpatialVideoProjection = { x: number; y: number; depth: number };
export type SpatialCameraBasis = { position: Point3; direction: Point3; right: Point3; up: Point3 };
export type VideoOverlaySpatialBindingOptions = {
  viewer: Viewer;
  resources: () => VideoOverlayResources | undefined;
  intrinsics: () => CameraIntrinsics | undefined;
  lens: () => LensDistortion | undefined;
};
const finite = (point: Point3 | undefined): point is Point3 => !!point && [point.x, point.y, point.z].every(Number.isFinite);
const xyz = (point: Point3) => new Cartesian3(point.x, point.y, point.z);
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Source image pixel centres agree with the lens compositor's half-pixel rule. */
export function projectSpatialWorldPoint(point: Point3, camera: SpatialCameraBasis, k: CameraIntrinsics, lens: LensDistortion = {}): SpatialVideoProjection | undefined {
  if (!finite(point)) return undefined;
  const relative = { x: point.x - camera.position.x, y: point.y - camera.position.y, z: point.z - camera.position.z };
  const depth = dot(relative, camera.direction);
  if (!Number.isFinite(depth) || depth <= .1) return undefined;
  try {
    const optical = distortNormalizedPoint({ x: dot(relative, camera.right) / depth, y: -dot(relative, camera.up) / depth }, lens);
    const x = (k.fx * optical.x + k.cx + .5) / k.width, y = (k.fy * optical.y + k.cy + .5) / k.height;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, depth } : undefined;
  } catch { return undefined; }
}

/** The displayed canvas contains distorted imagery, but Cesium picking sees the
 * ideal optical frustum. CSS dimensions are required here (not drawing pixels).
 */
export function spatialVideoToScenePoint(u: number, v: number, k: CameraIntrinsics, lens: LensDistortion, width: number, height: number): Cartesian2 {
  if (![u, v, width, height].every(Number.isFinite) || u < 0 || u > 1 || v < 0 || v > 1 || width <= 0 || height <= 0) {
    throw new Error('请在视频画幅内部点选结构');
  }
  const ideal = undistortPixel(k, u * k.width - .5, v * k.height - .5, lens);
  const bounds = overlayLensBounds(k, lens);
  return new Cartesian2((ideal.x - bounds.left) / (bounds.right - bounds.left) * width,
    (ideal.y - bounds.top) / (bounds.bottom - bounds.top) * height);
}

/** Closest point on the exact CAD segment to a forward optical ray. */
export function closestSpatialSegmentPoint(origin: Point3, direction: Point3, start: Point3, end: Point3): Cartesian3 | undefined {
  const v = Cartesian3.subtract(xyz(end), xyz(start), new Cartesian3());
  const w = Cartesian3.subtract(xyz(origin), xyz(start), new Cartesian3());
  const a = dot(direction, direction), b = dot(direction, v), c = dot(v, v), d = dot(direction, w), e = dot(v, w);
  if (a < 1e-12 || c < 1e-16) return undefined;
  const denominator = a * c - b * b;
  let t = Math.abs(denominator) > 1e-12 ? (a * e - b * d) / denominator : e / c;
  t = Math.max(0, Math.min(1, t));
  const rayDistance = (b * t - d) / a;
  if (rayDistance <= .1) return undefined;
  return Cartesian3.add(xyz(start), Cartesian3.multiplyByScalar(v, t, v), v);
}

/** No ray queries are made by project(): cache preparation projects a handful
 * of points, and cached movie playback never invokes this adapter at all.
 */
export class VideoOverlaySpatialBinding {
  constructor(private readonly options: VideoOverlaySpatialBindingOptions) {}

  private camera(): SpatialCameraBasis {
    const camera = this.options.viewer.camera;
    return { position: camera.positionWC, direction: camera.directionWC, right: camera.rightWC, up: camera.upWC };
  }

  targetVisible(targetId: string): boolean { return this.options.resources()?.spatialVisible(targetId) ?? false; }

  project(targetId: string, local: Point3): SpatialVideoProjection | undefined {
    const k = this.options.intrinsics(), resources = this.options.resources();
    if (!k || !resources?.spatialVisible(targetId) || !finite(local)) return undefined;
    const frame = resources.spatialFrame(targetId);
    if (!frame) return undefined;
    return projectSpatialWorldPoint(Matrix4.multiplyByPoint(frame, xyz(local), new Cartesian3()), this.camera(), k, this.options.lens());
  }

  pick(targetId: string, u: number, v: number): Point3 {
    const resources = this.options.resources(), k = this.options.intrinsics();
    if (!resources || !k || !resources.spatialVisible(targetId)) throw new Error('请先进入融合编辑并选择当前可见的模型或 CAD');
    const frame = resources.spatialFrame(targetId);
    if (!frame) throw new Error('关联对象缺少有效空间定位，请重新加载对象');
    const viewer = this.options.viewer, scene = viewer.scene, lens = this.options.lens() ?? {};
    const windowPoint = spatialVideoToScenePoint(u, v, k, lens, viewer.canvas.clientWidth, viewer.canvas.clientHeight);
    // One pixel for surface picking prevents using another pixel's geometry with
    // the cursor's depth. CAD lines have an explicit 9 px tolerance and snap.
    const exactHit = scene.pick(windowPoint, 1, 1);
    const isCad = resources.get(targetId)?.kind === 'CAD';
    const hit = resources.spatialOwnsPick(targetId, exactHit) ? exactHit : isCad ? scene.pick(windowPoint, 9, 9) : undefined;
    if (!resources.spatialOwnsPick(targetId, hit)) throw new Error('未捕捉到所选模型/CAD，请点击该结构的可见表面或图纸线条');
    const lines = resources.spatialPickedLines(targetId, hit);
    let world: Cartesian3 | undefined;
    if (lines.length) {
      const ideal = undistortPixel(k, u * k.width - .5, v * k.height - .5, lens), camera = this.camera();
      const direction = Cartesian3.normalize(new Cartesian3(
        camera.direction.x + ideal.x * camera.right.x - ideal.y * camera.up.x,
        camera.direction.y + ideal.x * camera.right.y - ideal.y * camera.up.y,
        camera.direction.z + ideal.x * camera.right.z - ideal.y * camera.up.z), new Cartesian3());
      let best = 14;
      for (const line of lines) for (let index = 1; index < line.length; index++) {
        const point = closestSpatialSegmentPoint(camera.position, direction, line[index - 1], line[index]);
        const pixel = point && projectSpatialWorldPoint(point, camera, k, lens);
        if (!point || !pixel) continue;
        const distance = Math.hypot((pixel.x - u) * viewer.canvas.clientWidth, (pixel.y - v) * viewer.canvas.clientHeight);
        if (distance < best) { world = point; best = distance; }
      }
      if (!world) throw new Error('未捕捉到有效 CAD 线段，请放大后点选线条');
    } else {
      // Text billboards and missing CPU line data are not geometric surfaces.
      const feature = hit as { id?: { type?: string; polyline?: unknown; label?: unknown; billboard?: unknown } };
      if (isCad && (feature.id?.type === 'POLYLINE' || feature.id?.type === 'TEXT' || feature.id?.polyline || feature.id?.label || feature.id?.billboard)) {
        throw new Error('该 CAD 图元不能提供精确空间落点，请点选可见线段或面');
      }
      if (hit !== exactHit || !scene.pickPositionSupported) throw new Error('此处没有可用的模型表面深度，请重新点选');
      // Cesium 1.144 returns object identity and linear depth from a single
      // model pick pass. Prefer it over independently reconstructed scene depth.
      const snap = !isCad && typeof scene.snap === 'function' ? scene.snap(windowPoint, { width: 1, height: 1 }) : undefined;
      if (snap && resources.spatialOwnsPick(targetId, snap.object)) world = snap.position;
      else if (snap) throw new Error('当前落点属于其他结构，请重新点选所选模型');
      else {
        const previous = scene.pickTranslucentDepth;
        try {
          // Only an authoring click needs translucent depth; never enable this
          // for the normal render loop or offline cache preparation.
          scene.pickTranslucentDepth = true;
          world = scene.pickPosition(windowPoint, new Cartesian3());
        } finally { scene.pickTranslucentDepth = previous; }
      }
      if (!finite(world)) throw new Error('未获得结构表面坐标，请等待模型清晰后重新点选');
    }
    const local = Matrix4.multiplyByPoint(Matrix4.inverse(frame, new Matrix4()), world, new Cartesian3());
    if (!finite(local)) throw new Error('结构坐标无效，请重新点选');
    return { x: local.x, y: local.y, z: local.z };
  }
}
