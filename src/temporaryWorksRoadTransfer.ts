import type { PlanXY, PlanningTriangle } from './temporaryWorksGeometry';
import type { RoadDatum, RoadParameters, RoadResult, RoadSampleBatch, RoadVertex } from './temporaryWorksRoadCalculation';
import type { RoadRouteConflict } from './temporaryWorksRoadConflict';

export type RoadWorkerRequest = { type:'start'; points:PlanXY[]; parameters:RoadParameters; datum:RoadDatum; spacing:number }
  | { type:'heights'; heights:(number | null | undefined)[] };
type PackedRoad = { type:'result'; result:Omit<RoadResult,'vertices'|'triangles'>; vertices:Float64Array; triangles:Uint32Array };
export type RoadWorkerResponse = { type:'sample'; points:readonly PlanXY[]; batch:RoadSampleBatch } | PackedRoad
  | { type:'error'; message:string; conflict?:Pick<RoadRouteConflict,'kind'|'stations'> };

// Transfer typed buffers once. Cloning a whole mesh of JS objects on the UI thread can itself stall Cesium.
export function packRoad({ vertices, triangles, ...result }: RoadResult): PackedRoad {
  const rows = new Float64Array(vertices.length * 9), indices = new Uint32Array(triangles.length * 3);
  vertices.forEach((v,i) => rows.set([v.x, v.y, v.roadStation, v.roadOffset, v.surfaceHeight, v.baseHeight,
    v.formationHeight, v.groundHeight, Number(v.roadPart === 'slope')], i * 9));
  triangles.forEach((face,i) => indices.set(face,i*3));
  return { type:'result', result, vertices:rows, triangles:indices };
}

export async function unpackRoad(data:PackedRoad, signal?:AbortSignal): Promise<RoadResult> {
  const {vertices:rows, triangles:indices} = data;
  const vertices:RoadVertex[] = [], triangles:PlanningTriangle[] = [];
  // Yield to input/render tasks during materialization, including cancellation after the worker has completed.
  const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < rows.length; i += 9) {
    if (i % (9 * 4096) === 0) { if (i) await nextTask(); signal?.throwIfAborted(); }
    vertices.push({x:rows[i], y:rows[i+1], roadStation:rows[i+2], roadOffset:rows[i+3], surfaceHeight:rows[i+4],
      baseHeight:rows[i+5], formationHeight:rows[i+6], groundHeight:rows[i+7], roadPart:rows[i+8] ? 'slope':'core'});
  }
  for (let i = 0; i < indices.length; i += 3) {
    if (i % (3 * 8192) === 0) { if (i) await nextTask(); signal?.throwIfAborted(); }
    triangles.push([indices[i], indices[i+1], indices[i+2]]);
  }
  return {...data.result, vertices, triangles};
}
