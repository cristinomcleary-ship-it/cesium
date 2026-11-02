/// <reference lib="webworker" />
import { calculateRoad } from './temporaryWorksRoadCalculation';
import { RoadRouteConflict } from './temporaryWorksRoadConflict';
import { packRoad, type RoadWorkerRequest, type RoadWorkerResponse } from './temporaryWorksRoadTransfer';

let waiting: ((heights:(number | null | undefined)[])=>void) | undefined;
const send = (message:RoadWorkerResponse, transfer:Transferable[] = []) => self.postMessage(message, {transfer});
self.onmessage = async ({data}:MessageEvent<RoadWorkerRequest>) => {
  if (data.type === 'heights') {
    const accept = waiting;
    waiting = undefined;
    accept?.(data.heights);
    return;
  }
  try {
    const road = await calculateRoad(data.points, data.parameters, data.datum, data.spacing, (points,batch) =>
      new Promise(resolve => { waiting=resolve; send({type:'sample', points, batch}); }));
    const packed = packRoad(road);
    send(packed, [packed.vertices.buffer, packed.triangles.buffer]);
  } catch (e) {
    send({type:'error', message:e instanceof Error ? e.message:String(e),
      conflict:e instanceof RoadRouteConflict ? {kind:e.kind, stations:e.stations} : undefined});
  }
};
