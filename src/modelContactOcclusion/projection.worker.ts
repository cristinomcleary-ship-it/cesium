import { buildModelProjection } from './projection';
import type { ContactMeshInput } from './types';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ kind: string; id: number; input: ContactMeshInput }>) => void) | null;
  postMessage(message: unknown): void;
};
worker.onmessage = event => {
  const { kind, id, input } = event.data;
  if (kind !== 'build') return;
  void buildModelProjection(input, { onProgress: message => worker.postMessage({ kind: 'progress', id, message }) })
    .then(result => worker.postMessage({ kind: 'result', id, result }))
    .catch(error => worker.postMessage({ kind: 'error', id, message: error instanceof Error ? error.message : String(error) }));
};
