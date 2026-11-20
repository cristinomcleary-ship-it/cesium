import type { IncomingMessage } from 'node:http';
import type { Actor } from './domain.ts';

// A preview grant can revalidate its issuing session even when sandboxed
// resources have an opaque origin and cannot send the application cookie.
const authorizers = new WeakMap<IncomingMessage, () => Actor>();

export function setStructurePreviewAuthorizer(request: IncomingMessage, authorize: () => Actor) {
  authorizers.set(request, authorize);
}

export function structurePreviewAuthorizer(request: IncomingMessage) {
  return authorizers.get(request);
}
