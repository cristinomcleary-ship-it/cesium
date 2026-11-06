/// <reference lib="webworker" />
import { calculateDesignedRoad } from './temporaryWorksDesignedRoad';
import { packDesignedRoad, type DesignedRoadWorkerRequest, type DesignedRoadWorkerResponse } from './temporaryWorksDesignedRoadTransfer';
import { RoadRouteConflict } from './temporaryWorksRoadConflict';

self.onmessage=async ({data}:MessageEvent<DesignedRoadWorkerRequest>)=>{
  try {
    const result=await calculateDesignedRoad(data.points,data.parameters,data.alignment,{meshSpacing:data.meshSpacing});
    const packed=packDesignedRoad(result);
    self.postMessage(packed,{transfer:[packed.vertices.buffer,packed.triangles.buffer,packed.boundaries.buffer,packed.rings.buffer,packed.polygons.buffer]});
  } catch(error) {
    const message:DesignedRoadWorkerResponse={type:'error',message:error instanceof Error?error.message:String(error),
      conflict:error instanceof RoadRouteConflict?{kind:error.kind,stations:error.stations}:undefined};
    self.postMessage(message);
  }
};
