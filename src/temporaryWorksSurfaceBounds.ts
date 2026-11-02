import { Cartesian3, type BoundingSphere, type Cartographic, type Ellipsoid } from 'cesium';

/** Cesium's height query travels along the ellipsoid normal. An infinite line
 * that misses the transformed root sphere cannot intersect any model content. */
export function planningSampleMayHit(ellipsoid: Ellipsoid, sphere: BoundingSphere) {
  const surface = new Cartesian3(), normal = new Cartesian3(), delta = new Cartesian3();
  const {center, radius} = sphere;
  const valid = [center.x, center.y, center.z, radius].every(Number.isFinite) && radius > 0;
  return (point: Cartographic) => {
    if (!valid) return true;
    ellipsoid.cartographicToCartesian(point, surface);
    ellipsoid.geodeticSurfaceNormalCartographic(point, normal);
    Cartesian3.subtract(center, surface, delta);
    Cartesian3.cross(delta, normal, delta);
    // The 2 cm Cesium pick footprint and floating-point roundoff both fit inside this margin.
    return Cartesian3.magnitudeSquared(delta) <= (radius + 0.10) ** 2;
  };
}
