import { ModelContactGeometryClient } from './client';
import type { ModelProjectionGeometry } from './projection';

/** The same bounded transfer, cancellation and worker lifetime as contact jobs. */
export class ModelProjectionGeometryClient extends ModelContactGeometryClient<ModelProjectionGeometry> {
  constructor(options: { timeoutMs?: number } = {}) { super({ ...options, effect: 'projection' }); }
}
