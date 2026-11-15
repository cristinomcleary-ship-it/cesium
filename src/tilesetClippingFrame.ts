import { Matrix4, Transforms, type Cesium3DTileset } from 'cesium';

/** Read-only adapter for the pinned Cesium 1.144 clipping reference frame.
 * Its cached clippingPlanesOriginMatrix can still describe the preceding frame
 * during scene.preUpdate, before Cesium marks that cache dirty. Compose from
 * the current public transforms and the unchanged origin established by fromUrl
 * instead; do not update Cesium's private cache or the source tileset.
 */
export function tilesetClippingFrame(tileset: Cesium3DTileset): Matrix4 {
  const initial = (tileset as Cesium3DTileset & {
    readonly _initialClippingPlanesOriginMatrix?: Matrix4;
  })._initialClippingPlanesOriginMatrix;
  const root = tileset.root.transform;
  if (initial) {
    const currentRoot = Matrix4.multiply(tileset.modelMatrix, root, new Matrix4());
    return Matrix4.multiply(currentRoot, initial, new Matrix4());
  }
  // Preserve the previous adapter behaviour if this Cesium compatibility point
  // is absent. Real 1.144 tilesets initialize it before loading their root.
  return Matrix4.equals(root, Matrix4.IDENTITY)
    ? Transforms.eastNorthUpToFixedFrame(tileset.boundingSphere.center)
    : Matrix4.multiply(tileset.modelMatrix, root, new Matrix4());
}
