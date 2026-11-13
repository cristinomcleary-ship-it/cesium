/** Private opt-in for collections created by our clipping manager. Other Cesium
 * clipping owners retain the upstream shader, including inverse clipping. */
export const OWNED_FRAGMENT_CLIPPING = '__cesiumPlatformFragmentClippingV1';
export function markOwnedFragmentClipping<T extends object>(collection: T): T {
  Object.defineProperty(collection, OWNED_FRAGMENT_CLIPPING, { value: true });
  return collection;
}
