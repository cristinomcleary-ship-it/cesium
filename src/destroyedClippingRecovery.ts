type ClippingCollection = { isDestroyed(): boolean };
type ClippingHost = {
  isDestroyed?(): boolean;
  clippingPlanes?: ClippingCollection;
  clippingPolygons?: ClippingCollection;
  _clippingPlanes?: ClippingCollection;
  _clippingPolygons?: ClippingCollection;
  resetDrawCommands?(): void;
  root?: unknown;
  children?: readonly unknown[];
  content?: unknown;
  innerContents?: readonly unknown[];
  _model?: unknown;
};

/** Error-only adapter for Cesium 1.144 / engine 26.2.
 *
 * Tile content models borrow their tileset's clipping collections. Clearing a
 * destroyed collection from the tileset alone does not clear those references:
 * Model3DTileContent.update only synchronizes clipping when the tileset still
 * has a collection. Retained draw commands can then read deleted textures.
 * Clear only references proven destroyed, including loaded composite contents,
 * without invoking public setters that would destroy the collection again.
 * This never runs in the frame loop and never destroys a model or live owner.
 */
export function recoverDestroyedClippingReferences(resource: object): number {
  const pending: unknown[] = [resource];
  const visited = new Set<object>();
  let detached = 0;
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const host = value as ClippingHost;
    if (host.isDestroyed?.()) continue;
    let changed = false;
    for (const [publicKey, privateKey] of [
      ['clippingPlanes', '_clippingPlanes'], ['clippingPolygons', '_clippingPolygons'],
    ] as const) {
      const collection = host[privateKey] ?? host[publicKey];
      if (!collection?.isDestroyed()) continue;
      host[privateKey] = undefined;
      changed = true;
      detached++;
    }
    if (changed) host.resetDrawCommands?.();
    if (host.root) pending.push(host.root);
    if (host.content) pending.push(host.content);
    if (host._model) pending.push(host._model);
    for (const child of host.children ?? []) pending.push(child);
    for (const child of host.innerContents ?? []) pending.push(child);
  }
  return detached;
}
