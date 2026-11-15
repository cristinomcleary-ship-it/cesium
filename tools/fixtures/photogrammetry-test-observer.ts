import type { Cesium3DTileset, Viewer } from 'cesium';

/** Read-only test observation. Match the actual source URL rather than a class
 * imported through a second Vite module URL (whose constructor can differ). */
export function findFixturePhotography(viewer: Viewer, sourceUrl: string): Cesium3DTileset | undefined {
  const matches: Cesium3DTileset[] = [];
  for (let i = 0; i < viewer.scene.primitives.length; i++) {
    const candidate = viewer.scene.primitives.get(i);
    if (candidate?.resource?.url !== sourceUrl) continue;
    if (typeof candidate.isDestroyed !== 'function' || candidate.isDestroyed()
      || !candidate.root || !candidate.modelMatrix || typeof candidate.tilesLoaded !== 'boolean')
      throw new Error('The synthetic source is not a live rendered Tileset');
    matches.push(candidate);
  }
  if (matches.length > 1) throw new Error('The synthetic source was loaded more than once');
  return matches[0];
}

export function fixturePrimitiveDiagnostics(viewer: Viewer) {
  return Array.from({ length: viewer.scene.primitives.length }, (_, index) => {
    const primitive = viewer.scene.primitives.get(index);
    return { constructor: primitive?.constructor?.name, url: primitive?.resource?.url ?? null, show: primitive?.show ?? null,
      hasRoot: !!primitive?.root, hasMatrix: !!primitive?.modelMatrix,
      tilesLoaded: primitive?.tilesLoaded ?? null, contentReady: primitive?.root?.contentReady ?? null,
      destroyed: typeof primitive?.isDestroyed === 'function' ? primitive.isDestroyed() : null };
  });
}

export function requireFixturePhotography(viewer: Viewer, sourceUrl: string): Cesium3DTileset {
  const result = findFixturePhotography(viewer, sourceUrl);
  if (!result) throw new Error(`Synthetic photography is not loaded: ${JSON.stringify(fixturePrimitiveDiagnostics(viewer))}`);
  return result;
}
