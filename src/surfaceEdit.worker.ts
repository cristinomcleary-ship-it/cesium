/// <reference lib="webworker" />
import { buildSurfaceEditGeometry, type SurfaceEditGeometryInput, type SurfaceEditGeometryResult } from './surfaceEditGeometry';

export type SurfaceEditWorkerResponse =
  | { type: 'complete'; result: SurfaceEditGeometryResult }
  | { type: 'error'; message: string };

self.onmessage = ({ data }: MessageEvent<{ input: SurfaceEditGeometryInput }>) => {
  try {
    const result = buildSurfaceEditGeometry(data.input);
    const transfer = [result.surface, result.walls].flatMap(mesh =>
      [mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer]) as ArrayBuffer[];
    const response: SurfaceEditWorkerResponse = { type: 'complete', result };
    self.postMessage(response, { transfer });
  } catch (error) {
    const response: SurfaceEditWorkerResponse = { type: 'error', message: error instanceof Error ? error.message : String(error) };
    self.postMessage(response);
  }
};
