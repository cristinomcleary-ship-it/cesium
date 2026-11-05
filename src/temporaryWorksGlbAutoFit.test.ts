import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Cartographic, Math as CesiumMath, Matrix4, Transforms } from 'cesium';
import { fitTemporaryWorksGlbToBoundary } from './temporaryWorksGlbAutoFit.ts';
import { getTemporaryWorksGlbModelMatrix, type TemporaryWorksGlbResource } from './temporaryWorksGlb.ts';
import { glbFootprintsInsideSite } from './temporaryWorksGlbSite.ts';
import type { PlanXY } from './temporaryWorksGeometry.ts';

const asset: TemporaryWorksGlbResource = {
  id: 'camp', name: 'Offset Y-up building', url: 'test.glb', upAxis: 'Y',
  bounds: { min: [100, 7, 200], max: [120, 12, 210] }, anchor: [100, 7, 200],
  dimensions: { length: 20, width: 10, height: 5 },
  footprints: [{ outer: [[100, 200], [120, 200], [120, 210], [100, 210]] }],
};
const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const rectangle = (x: number, y: number, length: number, width: number): PlanXY[] => [
  { x, y }, { x: x + length, y }, { x: x + length, y: y + width }, { x, y: y + width },
];
const rotate = (p: PlanXY, degrees: number, center: PlanXY = { x: 0, y: 0 }) => {
  const a = degrees * Math.PI / 180;
  return { x: center.x + p.x * Math.cos(a) - p.y * Math.sin(a), y: center.y + p.x * Math.sin(a) + p.y * Math.cos(a) };
};

test('rotated CAD rectangle drives placement, independent horizontal size and original height', () => {
  const site = rectangle(-30, -10, 60, 20).map(p => rotate(p, 37, { x: 250, y: -80 }));
  const original = JSON.stringify({ asset, site });
  const fit = fitTemporaryWorksGlbToBoundary(asset, site, { clearanceMetres: 0 });
  assert.equal(fit.method, 'rectangle'); assert.equal(fit.scaleMode, 'xyz');
  near(fit.headingDeg, 37); near(fit.scale.x, 3); near(fit.scale.y, 2);
  near(fit.dimensions.length, 60); near(fit.dimensions.width, 20); near(fit.dimensions.height, 5);
  near(fit.coverageRatio, 1);
  assert.ok(glbFootprintsInsideSite(fit.footprints, site));
  for (const corner of site) assert.ok(fit.footprints[0].some(p => Math.hypot(p.x - corner.x, p.y - corner.y) < 1e-6));
  assert.equal(JSON.stringify({ asset, site }), original, 'source model and CAD data must remain intact');
});

test('Y-up source positive Z points south, and the eccentric source anchor is not mistaken for footprint centre', () => {
  const site = rectangle(10, 20, 40, 20);
  const fit = fitTemporaryWorksGlbToBoundary(asset, site, { clearanceMetres: 0 });
  near(fit.headingDeg, 0); near(fit.anchor.x, 10); near(fit.anchor.y, 40);
  assert.ok(glbFootprintsInsideSite(fit.footprints, site));
  const opposite = fitTemporaryWorksGlbToBoundary(asset, site, { clearanceMetres: 0, flip180: true });
  near(opposite.headingDeg, 180); near(opposite.anchor.x, 50); near(opposite.anchor.y, 20);
  assert.ok(glbFootprintsInsideSite(opposite.footprints, site));
  near(opposite.coverageRatio, fit.coverageRatio);
});

test('Z-up source preserves north axis and uses the corresponding source anchor component', () => {
  const zAsset: TemporaryWorksGlbResource = { ...asset, upAxis: 'Z', anchor: [100, 200, 7], bounds: { min: [100, 200, 7], max: [120, 210, 12] } };
  const fit = fitTemporaryWorksGlbToBoundary(zAsset, rectangle(10, 20, 40, 20), { clearanceMetres: 0 });
  near(fit.anchor.x, 10); near(fit.anchor.y, 20); near(fit.headingDeg, 0);
});

test('audited structural footprint controls fit even when scene bounds contain distant auxiliary objects', () => {
  const withHelpers = { ...asset, dimensions: { length: 200, width: 100, height: 50 }, bounds: { min: [0, 0, 0] as [number, number, number], max: [200, 50, 100] as [number, number, number] } };
  const fit = fitTemporaryWorksGlbToBoundary(withHelpers, rectangle(0, 0, 40, 20), { clearanceMetres: 0 });
  near(fit.scale.x, 2); near(fit.scale.y, 2); near(fit.dimensions.height, 50);
  near(fit.dimensions.length, 400); near(fit.dimensions.width, 200);
  near(fit.footprintArea, 800); near(fit.coverageRatio, 1);
});

test('default 5 cm reserve survives conversion from CAD metre frame to actual Cesium model matrix', () => {
  const site = rectangle(-60, -20, 120, 40).map(p => rotate(p, 25));
  const fit = fitTemporaryWorksGlbToBoundary(asset, site);
  near(fit.dimensions.length, 119.9); near(fit.dimensions.width, 39.9);
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121.5, 31.2, 30));
  const inverse = Matrix4.inverseTransformation(frame, new Matrix4());
  const worldAnchor = Matrix4.multiplyByPoint(frame, new Cartesian3(fit.anchor.x, fit.anchor.y, 0), new Cartesian3());
  const geo = Cartographic.fromCartesian(worldAnchor);
  const model = getTemporaryWorksGlbModelMatrix(asset, {
    longitude: CesiumMath.toDegrees(geo.longitude), latitude: CesiumMath.toDegrees(geo.latitude), height: geo.height,
    headingDeg: fit.headingDeg, scaleMode: fit.scaleMode, dimensions: fit.dimensions,
  });
  const actual = asset.footprints.map(ring => ring.outer.map(([x, z]) => {
    const p = Matrix4.multiplyByPoint(inverse, Matrix4.multiplyByPoint(model, new Cartesian3(x, asset.anchor[1], z), new Cartesian3()), new Cartesian3());
    return { x: p.x, y: p.y };
  }));
  assert.ok(glbFootprintsInsideSite(actual, site), 'actual world model stays within CAD after ENU frame conversion');
  near(actual[0][1].x, fit.footprints[0][1].x, 0.002);
  near(actual[0][1].y, fit.footprints[0][1].y, 0.002);
});

test('concave L site is fitted inside a full arm rather than crossing the notch or centring in empty space', () => {
  const site = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 12 }, { x: 0, y: 12 }];
  const fit = fitTemporaryWorksGlbToBoundary(asset, site, { clearanceMetres: 0 });
  assert.equal(fit.method, 'inscribed'); assert.match(fit.message, /未保证最大覆盖或无畸变/);
  assert.ok(glbFootprintsInsideSite(fit.footprints, site));
  assert.ok(fit.coverageRatio > 0.55 && fit.coverageRatio <= 0.600001, `unexpected L-site coverage ${fit.coverageRatio}`);
  assert.ok(fit.footprints[0].every(p => p.x <= 4 + 1e-6) || fit.footprints[0].every(p => p.y <= 4 + 1e-6));
});

test('complete-edge containment prevents bridging a U-site recess although all rectangle corners are inside', () => {
  const site = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }, { x: 8, y: 12 }, { x: 8, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 12 }, { x: 0, y: 12 }];
  assert.equal(glbFootprintsInsideSite([rectangle(1, 1, 10, 10)], site), false, 'regression fixture has inside corners but an outside edge');
  const fit = fitTemporaryWorksGlbToBoundary(asset, site);
  assert.ok(glbFootprintsInsideSite(fit.footprints, site));
  assert.ok(fit.coverageRatio > 0.35 && fit.coverageRatio < 0.44);
  assert.ok(fit.footprints[0].every(p => p.x <= 4) || fit.footprints[0].every(p => p.x >= 8) || fit.footprints[0].every(p => p.y <= 4));
});

test('footprint holes reduce reported coverage without using the scene bounds as occupied area', () => {
  const courtyard = { ...asset, footprints: [{ ...asset.footprints[0], holes: [[[105, 203], [115, 203], [115, 207], [105, 207]]] as [number, number][][] }] };
  const fit = fitTemporaryWorksGlbToBoundary(courtyard, rectangle(0, 0, 40, 20), { clearanceMetres: 0 });
  near(fit.footprintArea, 640); near(fit.coverageRatio, 0.8);
});

test('180 degree entrance flip refits an asymmetric footprint instead of rotating it outside a concave site', () => {
  const site = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 12 }, { x: 0, y: 12 }];
  const asymmetric: TemporaryWorksGlbResource = {
    ...asset, anchor: [0, 0, 0], bounds: { min: [0, 0, -12], max: [12, 5, 0] }, dimensions: { length: 12, width: 12, height: 5 },
    footprints: [{ outer: site.map(p => [p.x, -p.y]) }],
  };
  const forward = fitTemporaryWorksGlbToBoundary(asymmetric, site, { clearanceMetres: 0 });
  const reversed = fitTemporaryWorksGlbToBoundary(asymmetric, site, { clearanceMetres: 0, flip180: true });
  near(forward.coverageRatio, 1);
  near(reversed.headingDeg, (forward.headingDeg + 180) % 360);
  assert.ok(reversed.coverageRatio < forward.coverageRatio);
  assert.ok(glbFootprintsInsideSite(reversed.footprints, site));
});

test('200-vertex curved CAD uses bounded search and still checks complete unmodified boundary', () => {
  const site = Array.from({ length: 200 }, (_, i) => {
    const angle = i * Math.PI * 2 / 200, radius = 40 + 12 * Math.cos(3 * angle);
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
  const original = JSON.stringify(site), started = performance.now();
  const fit = fitTemporaryWorksGlbToBoundary(asset, site);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `dense outline search took ${elapsed.toFixed(0)} ms`);
  assert.equal(fit.method, 'inscribed');
  assert.ok(fit.coverageRatio > 0.25 && fit.coverageRatio < 1);
  assert.ok(glbFootprintsInsideSite(fit.footprints, site));
  assert.equal(JSON.stringify(site), original);
});

test('all separate building footprints must stay inside and restored placement reproduces geometry', () => {
  const multiple = { ...asset, footprints: [
    { outer: [[100, 200], [106, 200], [106, 210], [100, 210]] as [number, number][] },
    { outer: [[114, 200], [120, 200], [120, 210], [114, 210]] as [number, number][] },
  ] };
  const site = rectangle(0, 0, 40, 20).reverse();
  const fit = fitTemporaryWorksGlbToBoundary(multiple, [...site, site[0]], { clearanceMetres: 0 });
  assert.equal(fit.footprints.length, 2); near(fit.coverageRatio, 0.6);
  assert.ok(glbFootprintsInsideSite(fit.footprints, site));
  assert.deepEqual(fitTemporaryWorksGlbToBoundary(JSON.parse(JSON.stringify(multiple)), JSON.parse(JSON.stringify(site)), { clearanceMetres: 0 }), fit);
});

test('invalid or degenerate CAD/source geometry fails before producing a placement', () => {
  assert.throws(() => fitTemporaryWorksGlbToBoundary(asset, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), /边界|面积/);
  assert.throws(() => fitTemporaryWorksGlbToBoundary(asset, rectangle(0, 0, 0.01, 0.01)), /无法/);
  assert.throws(() => fitTemporaryWorksGlbToBoundary(asset, rectangle(0, 0, 10, 10), { clearanceMetres: -1 }), /余量/);
  assert.throws(() => fitTemporaryWorksGlbToBoundary({ ...asset, footprints: [] }, rectangle(0, 0, 10, 10)), /底面/);
  assert.throws(() => fitTemporaryWorksGlbToBoundary(asset, [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }]), /自交/);
});
