import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundingSphere, Cartographic, Ellipsoid } from 'cesium';
import { planningSampleMayHit } from './temporaryWorksSurfaceBounds.ts';

test('height broad phase rejects only guaranteed misses, including elevated and transformed models', () => {
  const ellipsoid = Ellipsoid.WGS84, position = Cartographic.fromDegrees(121.3,31.4,500);
  const sphere = new BoundingSphere(ellipsoid.cartographicToCartesian(position), 30);
  const mayHit = planningSampleMayHit(ellipsoid,sphere);
  assert.equal(mayHit(Cartographic.fromDegrees(121.3,31.4)), true);
  assert.equal(mayHit(Cartographic.fromDegrees(121.3002,31.4)), true);
  assert.equal(mayHit(Cartographic.fromDegrees(121.302,31.4)), false);
  assert.equal(planningSampleMayHit(ellipsoid,new BoundingSphere(sphere.center,0))(position),true);
});
