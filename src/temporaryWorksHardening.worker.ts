/// <reference lib="webworker" />
import { calculateHardening, packHardening, type HardeningParameters } from './temporaryWorksHardening';

self.onmessage=({data}:MessageEvent<HardeningParameters>)=>{
  try {
    const packed=packHardening(calculateHardening(data));
    self.postMessage(packed,{transfer:[packed.vertices.buffer,packed.triangles.buffer]});
  } catch (error) {
    self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)});
  }
};
