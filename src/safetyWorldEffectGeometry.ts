import { Cartesian3, Matrix4, Transforms } from "cesium";
import type { SafetyDevice, SafetyNode, SafetyPage, SafetyPosition, SafetyTrackPoint } from "./safetyTypes.ts";

function validPosition(point: SafetyPosition): boolean {
  return Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
    && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.height);
}

export type SafetyInspectionContext = { mediaId: string; trajectoryValid: boolean; deviceId?: string };

/** A displayed flight belongs to the selected recording, never just to the current project. */
export function inspectionDeviceEligible(device: SafetyDevice, page: SafetyPage | undefined, context?: SafetyInspectionContext): boolean {
  if (page !== "inspection" || !context?.trajectoryValid || !context.mediaId || device.mediaId !== context.mediaId
    || device.provenance === "demo" || (context.deviceId && device.id !== context.deviceId)) return false;
  return device.track.some((point, i) => {
    const previous = device.track[i - 1];
    return previous && validPosition(previous) && validPosition(point)
      && Number.isFinite(previous.mediaSeconds) && Number.isFinite(point.mediaSeconds)
      && Number.isFinite(previous.time) && Number.isFinite(point.time)
      && point.time > previous.time && point.time - previous.time <= 5000
      && point.mediaSeconds > previous.mediaSeconds && point.segment === previous.segment;
  });
}

export function sceneLabelPixels(kind: SafetyNode["kind"] | "device", selected = false, largeText = false): number {
  return (selected ? 14 : kind === "section" || kind === "device" ? 13 : 12) + (largeText ? 2 : 0);
}

/** Keep source order and elevations; never bridge missing, excluded, or discontinuous telemetry. */
export function splitActualTrackRuns(track: readonly SafetyTrackPoint[], range: readonly [number, number]): Cartesian3[][] {
  const runs: Cartesian3[][] = [];
  let current: Cartesian3[] = [], previous: SafetyTrackPoint | undefined;
  const flush = () => { if (current.length >= 2) runs.push(current); current = []; previous = undefined; };
  for (const point of track) {
    if (!validPosition(point) || !Number.isFinite(point.time) || point.time < range[0] || point.time > range[1]
      || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) { flush(); continue; }
    if (previous && (point.time <= previous.time || point.time - previous.time > 5000 || point.segment !== previous.segment)) flush();
    current.push(Cartesian3.fromDegrees(point.longitude, point.latitude, point.height));
    previous = point;
  }
  flush();
  return runs;
}

/** Select one existing run for decoration; no resampling or joins. First wins a tie. */
export function selectDecorativeTrackRun(runs: readonly Cartesian3[][]): Cartesian3[] | undefined {
  let selected: Cartesian3[] | undefined;
  for (const run of runs) if (run.length >= 2 && (!selected || run.length > selected.length)) selected = run;
  return selected;
}

/** Display geometry only: surveyed/user boundaries retain each independent elevation. */
export function selectionOutlinePositions(node: SafetyNode, center?: Cartesian3): Cartesian3[] {
  if (node.spatialObjectId && node.boundary && node.boundary.length >= 3) {
    if (!node.boundary.every(validPosition)) return [];
    const positions = node.boundary.map(point => Cartesian3.fromDegrees(point.longitude, point.latitude, point.height + 0.12));
    positions.push(Cartesian3.clone(positions[0]));
    return positions;
  }
  if (!center && !validPosition(node.position)) return [];
  const origin = center ?? Cartesian3.fromDegrees(node.position.longitude, node.position.latitude, node.position.height + 0.6);
  if (![origin.x, origin.y, origin.z].every(Number.isFinite) || Cartesian3.magnitudeSquared(origin) === 0) return [];
  const minimum = node.kind === "project" ? 100 : node.kind === "section" ? 35 : 3;
  const nodeRadius = Math.max(minimum, Number.isFinite(node.radius) ? node.radius! : 12);
  const radius = Math.min(120, Math.max(5, nodeRadius * (node.kind === "project" || node.kind === "section" ? 0.22 : 1.3)));
  const frame = Transforms.eastNorthUpToFixedFrame(origin);
  const positions = Array.from({ length: 64 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    return Matrix4.multiplyByPoint(frame, new Cartesian3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0), new Cartesian3());
  });
  positions.push(Cartesian3.clone(positions[0]));
  return positions;
}
