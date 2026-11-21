import { buildContactGeometry } from './geometry';
import type { ContactMeshInput } from './types';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ kind: string; id: number; input: ContactMeshInput }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
worker.onmessage = event => {
  const { kind, id, input } = event.data;
  if (kind !== 'build') return;
  try {
    const result = buildContactGeometry(input, { onProgress: message => worker.postMessage({ kind: 'progress', id, message }) });
    worker.postMessage({ kind: 'result', id, result }, [result.nodes.buffer, result.triangles.buffer, result.entities.buffer, result.trianglePositions.buffer]);
  } catch (error) {
    worker.postMessage({ kind: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};
