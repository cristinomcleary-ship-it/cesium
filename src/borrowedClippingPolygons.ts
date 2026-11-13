type BorrowingModel = {
  isDestroyed?(): boolean;
  _clippingPolygons?: object;
  _clippingPolygonsState?: number;
  resetDrawCommands?(): void;
};
type TileContent = { _model?: BorrowingModel; innerContents?: readonly TileContent[] };
type LoadedTile = {
  content?: TileContent;
  children?: readonly LoadedTile[];
  clippingPolygonsDirty?: boolean;
  _clippingPolygonsState?: number;
};

/** Cesium 1.144 content models borrow the tileset collection, while their shader
 * uniform closures capture the collection at command creation. Releasing an owned
 * collection must release those aliases too: Cesium does not synchronize models
 * when tileset.clippingPolygons is undefined. Only exact aliases of this owner's
 * previous collection are changed, once per ownership transition, never per frame.
 */
export function releaseBorrowedClippingPolygons(resource: object, owned: object): number {
  const root = (resource as { root?: LoadedTile }).root;
  const pending = root ? [root] : [];
  const visited = new Set<LoadedTile>();
  let released = 0;
  while (pending.length) {
    const tile = pending.pop()!;
    if (visited.has(tile)) continue;
    visited.add(tile);
    for (const child of tile.children ?? []) pending.push(child);
    const contents = tile.content ? [tile.content] : [];
    const seen = new Set<TileContent>();
    while (contents.length) {
      const content = contents.pop()!;
      if (seen.has(content)) continue;
      seen.add(content);
      for (const child of content.innerContents ?? []) contents.push(child);
      const model = content._model;
      if (!model || model.isDestroyed?.() || model._clippingPolygons !== owned) continue;
      // Use the borrowed internal slot; the public setter would destroy its owner.
      model._clippingPolygons = undefined;
      model._clippingPolygonsState = 0;
      model.resetDrawCommands?.();
      tile._clippingPolygonsState = 0;
      tile.clippingPolygonsDirty = true;
      released++;
    }
  }
  return released;
}
