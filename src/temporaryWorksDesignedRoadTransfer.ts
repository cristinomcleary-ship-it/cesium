import type { DesignedRoadAlignment, DesignedRoadFootprint, DesignedRoadParameters, DesignedRoadResult, DesignedRoadVertex } from './temporaryWorksDesignedRoad';
import type { PlanXY, PlanningTriangle } from './temporaryWorksGeometry';
import type { RoadRouteConflict } from './temporaryWorksRoadConflict';

export type DesignedRoadWorkerRequest = { points:PlanXY[]; parameters:DesignedRoadParameters; alignment:DesignedRoadAlignment; meshSpacing?:number };
export type PackedDesignedRoad = {
  type:'result';
  result:Omit<DesignedRoadResult,'vertices'|'triangles'|'footprintsXY'>;
  vertices:Float64Array; triangles:Uint32Array; boundaries:Float64Array; rings:Uint32Array; polygons:Uint32Array;
};
export type DesignedRoadWorkerResponse = PackedDesignedRoad | {type:'error';message:string;conflict?:Pick<RoadRouteConflict,'kind'|'stations'>};

export function packDesignedRoad({vertices,triangles,footprintsXY,...result}:DesignedRoadResult):PackedDesignedRoad {
  const rows=new Float64Array(vertices.length*7),indices=new Uint32Array(triangles.length*3);
  vertices.forEach((v,i)=>rows.set([v.x,v.y,v.roadStation,v.roadOffset,v.surfaceHeight,v.baseHeight,v.formationHeight],i*7));
  triangles.forEach((t,i)=>indices.set(t,i*3));
  const rings=footprintsXY.flatMap(p=>[p.outer,...p.holes]);
  const boundaries=new Float64Array(rings.reduce((n,r)=>n+r.length*2,0));
  let index=0;
  for(const ring of rings)for(const p of ring){boundaries[index++]=p.x;boundaries[index++]=p.y;}
  return {type:'result',result,vertices:rows,triangles:indices,boundaries,rings:Uint32Array.from(rings.map(r=>r.length)),polygons:Uint32Array.from(footprintsXY.map(p=>1+p.holes.length))};
}

export async function unpackDesignedRoad(data:PackedDesignedRoad,signal?:AbortSignal):Promise<DesignedRoadResult> {
  const vertices:DesignedRoadVertex[]=[],triangles:PlanningTriangle[]=[],footprintsXY:DesignedRoadFootprint[]=[];
  const yieldTask=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
  for(let i=0;i<data.vertices.length;i+=7) {
    if(i%(7*4096)===0){if(i)await yieldTask();signal?.throwIfAborted();}
    const a=data.vertices;
    vertices.push({x:a[i],y:a[i+1],roadStation:a[i+2],roadOffset:a[i+3],surfaceHeight:a[i+4],baseHeight:a[i+5],formationHeight:a[i+6],roadPart:'core'});
  }
  for(let i=0;i<data.triangles.length;i+=3) {
    if(i%(3*8192)===0){if(i)await yieldTask();signal?.throwIfAborted();}
    triangles.push([data.triangles[i],data.triangles[i+1],data.triangles[i+2]]);
  }
  let ringAt=0,position=0;
  for(const count of data.polygons) {
    const rings:PlanXY[][]=[];
    for(let r=0;r<count;r++) {
      const ring:PlanXY[]=[];
      for(let i=0;i<data.rings[ringAt];i++) {ring.push({x:data.boundaries[position++],y:data.boundaries[position++]});}
      rings.push(ring);ringAt++;
    }
    footprintsXY.push({outer:rings[0],holes:rings.slice(1)});
    signal?.throwIfAborted();
  }
  return {...data.result,vertices,triangles,footprintsXY};
}
