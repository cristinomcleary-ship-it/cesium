import { EngineeringFootprintGeometry, type EngineeringFootprintBinding, type EngineeringRuntimeNodeTransform } from './footprints';

type Request = { kind: 'init'; bytes: ArrayBuffer; bindings: EngineeringFootprintBinding[]; runtime?: EngineeringRuntimeNodeTransform[] }
  | { kind: 'project'; id: number; world: number[]; componentIds: string[] };
const worker = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(value: unknown): void };
let geometry: EngineeringFootprintGeometry | undefined, busy = false;
worker.onmessage = event => {
  const request = event.data;
  if (request.kind === 'init') {
    try { geometry = new EngineeringFootprintGeometry(request.bytes, request.bindings, request.runtime); worker.postMessage({ kind: 'ready' }); }
    catch (error) { worker.postMessage({ kind: 'error', message: String(error) }); }
    return;
  }
  if (busy || !geometry) { worker.postMessage({ kind: 'error', id: request.id, message: '精确轮廓 Worker 未就绪或已有任务' }); return; }
  busy = true;
  void geometry.project(request.world, request.componentIds, message => worker.postMessage({ kind: 'progress', id: request.id, message }))
    .then(result => worker.postMessage({ kind: 'result', id: request.id, result }))
    .catch(error => worker.postMessage({ kind: 'error', id: request.id, message: String(error) }))
    .finally(() => { busy = false; });
};
