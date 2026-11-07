import proj4 from 'proj4';
import { createPlanCoordinateFrame, createRoadCoordinateFrame, type PlanningCadCoordinates } from './temporaryWorksCad';
import type { TemporaryWorksPlan } from './temporaryWorksPanel';

export type TemporaryWorksPositionOffset = { east: number; north: number; up: number };
type Geo = { longitude: number; latitude: number };

/** Position controls are for local adjustments, not relocating a project across projection zones. */
export const MAX_TEMPORARY_WORKS_POSITION_STEP = 10_000;

function checkedGeo(point: Geo): Geo {
  if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) ||
      Math.abs(point.longitude) > 180 || Math.abs(point.latitude) >= 89.9)
    throw new Error('临建位置包含无效经纬度，暂不能调整。');
  return point;
}

function metricFrame(origin: Geo) {
  checkedGeo(origin);
  return proj4('EPSG:4326', `+proj=aeqd +lat_0=${origin.latitude} +lon_0=${origin.longitude} +datum=WGS84 +units=m +no_defs`);
}

/** Move the anchor in ellipsoidal metres; never approximate a metre with a constant degree offset. */
function reanchor(origin: Geo, offset: TemporaryWorksPositionOffset) {
  const old = metricFrame(origin);
  const [longitude, latitude] = old.inverse([offset.east, offset.north]);
  const destination = checkedGeo({ longitude, latitude }), next = metricFrame(destination);
  return (point: Geo): Geo => {
    checkedGeo(point);
    const [longitude, latitude] = next.inverse(old.forward([point.longitude, point.latitude]));
    return checkedGeo({ longitude, latitude });
  };
}

/**
 * Translate immutable saved geometry without sampling photography. CAD frames are changed with
 * the mesh so reopening a designed road cannot silently regenerate it at the original location.
 * The caller must rebuild hardening composition: its stored mesh is derived, not the new coverage.
 */
export function translateTemporaryWorksPlan(plan: TemporaryWorksPlan, offset: TemporaryWorksPositionOffset): TemporaryWorksPlan {
  if (![offset.east, offset.north, offset.up].every(Number.isFinite) ||
      Math.hypot(offset.east, offset.north) > MAX_TEMPORARY_WORKS_POSITION_STEP ||
      Math.abs(offset.up) > MAX_TEMPORARY_WORKS_POSITION_STEP)
    throw new Error('位置调整须为有效米数，单次平移或升降不能超过 10000 米。');
  const result = structuredClone(plan);
  if (!offset.east && !offset.north && !offset.up) return result;
  const horizontal = !!(offset.east || offset.north);
  const origin = plan.glb?.placement ?? plan.hardening?.reference ?? plan.inputs.reference;
  checkedGeo(origin);
  let move = horizontal ? reanchor(origin, offset) : (point: Geo) => checkedGeo({ ...point });
  const oldCoordinates = plan.inputs.coordinates;
  let coordinates: PlanningCadCoordinates = result.inputs.coordinates;
  const first = plan.inputs.feature.points[0];

  // GLBs and hardening have their own authoritative world anchors. Drawing coordinates are
  // retained as source provenance; geographic outlines can still follow the adjusted object.
  if (horizontal && !plan.glb && !plan.hardening && first && oldCoordinates.mode !== 'geographic') {
    const createFrame = plan.kind === 'road' ? createRoadCoordinateFrame : createPlanCoordinateFrame;
    const oldFrame = createFrame(oldCoordinates, first);
    if (oldCoordinates.mode === 'local') {
      coordinates = { ...oldCoordinates, ...move(oldCoordinates) };
    } else {
      // Convert the requested true east/north displacement to the existing survey grid. This
      // preserves its unit, axis order, convergence and previously applied model correction.
      const surveyFrame = createRoadCoordinateFrame(oldCoordinates, first);
      const before = surveyFrame.geoToLocal(origin), after = surveyFrame.geoToLocal(move(origin));
      coordinates = { ...oldCoordinates, modelOffset: {
        east: (oldCoordinates.modelOffset?.east ?? 0) + after.x - before.x,
        north: (oldCoordinates.modelOffset?.north ?? 0) + after.y - before.y,
      } };
    }
    const nextFrame = createFrame(coordinates, first);
    move = point => checkedGeo(nextFrame.localToGeo(oldFrame.geoToLocal(checkedGeo(point))));
    result.inputs.coordinates = coordinates;
  }

  const movePoint = <T extends Geo>(point: T): T => ({ ...point, ...move(point) });
  const level = (height: number): number => {
    if (!Number.isFinite(height) || !Number.isFinite(height + offset.up))
      throw new Error('临建高程无效，原方案保持不变。');
    return height + offset.up;
  };
  const reference = result.inputs.reference;
  result.inputs.reference = { ...movePoint(reference), height: level(reference.height) };
  if (result.inputs.referenceInput.mode === 'geo') {
    result.inputs.referenceInput.first = result.inputs.reference.longitude;
    result.inputs.referenceInput.second = result.inputs.reference.latitude;
  }
  result.inputs.design.referenceHeight = level(result.inputs.design.referenceHeight);
  if (horizontal && oldCoordinates.mode === 'geographic') {
    result.inputs.feature.points = plan.inputs.feature.points.map(point => {
      const p = move(oldCoordinates.axisOrder === 'eastNorth'
        ? { longitude: point.x, latitude: point.y } : { longitude: point.y, latitude: point.x });
      return oldCoordinates.axisOrder === 'eastNorth' ? { x: p.longitude, y: p.latitude } : { x: p.latitude, y: p.longitude };
    });
  }
  if (horizontal) {
    // Observed control points are survey evidence. Do not move those observations and pretend
    // the original registration was revalidated against photography at the new location.
    delete result.inputs.registration;
    delete result.inputs.projectedCheck;
  }
  if (result.inputs.facilityPlacement) result.inputs.facilityPlacement = movePoint(result.inputs.facilityPlacement);
  if (result.inputs.road) {
    if (result.inputs.road.startHeight !== undefined) result.inputs.road.startHeight = level(result.inputs.road.startHeight);
    if (result.inputs.road.endHeight !== undefined) result.inputs.road.endHeight = level(result.inputs.road.endHeight);
  }
  result.mesh.vertices = plan.mesh.vertices.map(vertex => {
    const moved = movePoint(vertex);
    moved.surfaceHeight = level(vertex.surfaceHeight);
    moved.baseHeight = level(vertex.baseHeight);
    moved.formationHeight = level(vertex.formationHeight);
    // Some historical meshes include support heights used by standard buildings. Ground
    // samples, in contrast, remain original evidence and are never synthesized by translation.
    const support = moved as typeof moved & { supportHeight?: number };
    if (support.supportHeight !== undefined) support.supportHeight = level(support.supportHeight);
    return moved;
  });
  if (result.surface) result.surface.footprints = result.surface.footprints.map(footprint => {
    const convert = (point: Geo & { height?: number }) => ({ ...movePoint(point), ...(point.height === undefined ? {} : { height: level(point.height) }) });
    return { ...footprint, outer: footprint.outer.map(convert), holes: footprint.holes?.map(hole => hole.map(convert)) };
  });
  if (result.building) result.building.footprint = result.building.footprint.map(movePoint);
  if (result.buildings) for (const building of result.buildings) building.footprint = building.footprint.map(movePoint);
  if (result.glb) {
    result.glb.placement = { ...movePoint(result.glb.placement), height: level(result.glb.placement.height) };
    result.glb.placementMode = 'manual';
    // The old fit/sample report refers to the previous placement, not this adjusted anchor.
    delete result.glb.autoFit;
  }
  if (result.hardening) {
    const config = result.hardening;
    config.reference = { ...movePoint(config.reference), height: level(config.reference.height) };
    config.boundary = config.boundary.map(movePoint);
    config.holes = config.holes.map(hole => hole.map(movePoint));
    // Exclusions/bindings describe OTHER facilities and must remain at those facilities.
    config.acceptedHeightDifference = false;
    delete config.acceptedDependencies;
  }
  // Cut/fill quantities are based on photography at the previous position. Retain the stored
  // historical values for audit, but suppress them as current quantities after any adjustment.
  result.earthworkDisabled = true;
  result.positionAdjusted = true;
  return result;
}
