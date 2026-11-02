import { calculateRoad, type RoadDatum, type RoadParameters, type RoadSampler, type RoadResult } from './temporaryWorksRoadCalculation';
import type { PlanXY } from './temporaryWorksGeometry';
import { RoadRouteConflict } from './temporaryWorksRoadConflict';
import { unpackRoad, type RoadWorkerResponse } from './temporaryWorksRoadTransfer';

export { roadLength, roadStartDatum, validateRoadGrades } from './temporaryWorksRoadCalculation';
export type { RoadParameters, RoadGradeRange, RoadVertex, RoadResult, RoadSampleBatch, RoadReferenceSource } from './temporaryWorksRoadCalculation';

export async function solvePlanningRoad(points: readonly PlanXY[], parameters: RoadParameters, datum: RoadDatum,
  spacing: number, sample: RoadSampler, { signal }: { signal?: AbortSignal } = {}): Promise<RoadResult> {
  signal?.throwIfAborted();
  if (typeof Worker === 'undefined') return calculateRoad(points, parameters, datum, spacing, sample, signal);
  let worker:Worker;
  try {
    worker = new Worker(new URL('./temporaryWorksRoad.worker.ts', import.meta.url), { type:'module', name:'planning-road' });
  } catch (error) {
    if (error instanceof DOMException && ['NotSupportedError','SecurityError'].includes(error.name))
      return calculateRoad(points,parameters,datum,spacing,sample,signal);
    throw error;
  }
  let abort: (() => void) | undefined;
  let closed = false;
  let packed:Extract<RoadWorkerResponse, { type:'result' }>;
  try {
    packed = await new Promise<Extract<RoadWorkerResponse, { type:'result' }>>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? new DOMException('已取消便道计算', 'AbortError'));
      signal?.addEventListener('abort', abort, { once:true });
      worker.onerror = event => reject(new Error(event.message || '便道后台计算异常中断，请重试。'));
      worker.onmessageerror = () => reject(new Error('便道后台计算结果传输失败，请重试。'));
      worker.onmessage = async ({data}: MessageEvent<RoadWorkerResponse>) => {
        try {
          if (closed) return;
          if (data.type === 'result') return resolve(data);
          if (data.type === 'error') throw data.conflict
            ? new RoadRouteConflict(data.conflict.kind, data.conflict.stations) : new Error(data.message);
          const heights = await sample(data.points, data.batch);
          if (!closed) worker.postMessage({ type:'heights', heights });
        } catch (error) { reject(error); }
      };
      worker.postMessage({ type:'start', points, parameters, datum, spacing });
    });
  } finally {
    closed = true;
    if (abort) signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
  return unpackRoad(packed,signal);
}
