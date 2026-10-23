import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian2, Cartesian3, Ellipsoid, Model } from 'cesium';
import { SubsurfaceTools } from './subsurfaceTools.ts';

type PickResult = { position: Cartesian3; source: string } | undefined;
type Options = {
  previous?: boolean;
  supported?: boolean;
  point?: Cartesian3;
  terrain?: Cartesian3;
  ellipsoid?: Cartesian3;
  model?: boolean;
  failDepth?: Error;
};

function fixture(options: Options = {}) {
  const previous = options.previous ?? false;
  let translucentDepth = previous;
  const transitions: boolean[] = [];
  const calls: string[] = [];
  const screen = new Cartesian2(120, 240);
  const ray = {};
  const scene = {
    get pickTranslucentDepth() { return translucentDepth; },
    set pickTranslucentDepth(value: boolean) { transitions.push(value); translucentDepth = value; },
    pickPositionSupported: options.supported ?? true,
    pick(position: Cartesian2) {
      assert.equal(position, screen);
      assert.equal(translucentDepth, previous, 'ordinary object picking must not enable translucent depth');
      calls.push('object');
      return options.model ? { primitive: Object.create(Model.prototype) } : undefined;
    },
    pickPosition(position: Cartesian2) {
      assert.equal(position, screen);
      assert.equal(translucentDepth, true, 'explicit subsurface depth picking retains transparent-surface support');
      calls.push('depth');
      if (options.failDepth) throw options.failDepth;
      return options.point;
    },
    globe: {
      ellipsoid: Ellipsoid.WGS84,
      pick(actualRay: object, actualScene: unknown) {
        assert.equal(actualRay, ray);
        assert.equal(actualScene, scene);
        assert.equal(translucentDepth, previous, 'terrain fallback runs after restoring the scene setting');
        calls.push('terrain');
        return options.terrain;
      },
    },
  };
  const viewer = {
    scene,
    camera: {
      getPickRay(position: Cartesian2) {
        assert.equal(position, screen);
        assert.equal(translucentDepth, previous);
        calls.push('ray');
        return ray;
      },
      pickEllipsoid(position: Cartesian2, ellipsoid: Ellipsoid) {
        assert.equal(position, screen);
        assert.equal(ellipsoid, Ellipsoid.WGS84);
        assert.equal(translucentDepth, previous, 'ellipsoid fallback must not leave an expensive camera picking mode enabled');
        calls.push('ellipsoid');
        return options.ellipsoid;
      },
    },
  };
  // Bypass UI construction only; call the production picking method on its real prototype.
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), { viewer }) as {
    pickSurfacePosition(position: Cartesian2): PickResult;
  };
  return { scene, transitions, calls, pick: () => tools.pickSurfacePosition(screen) };
}

test('subsurface model picks preserve the actual world point and restore the prior depth mode', () => {
  for (const previous of [false, true]) {
    const point = new Cartesian3(1212345.125, 4567890.25, 3987654.5);
    const original = Cartesian3.clone(point);
    const f = fixture({ previous, point, model: true });
    const result = f.pick();
    assert.equal(result?.position, point, 'return the exact picked opaque/model point, without a new height or offset');
    assert.deepEqual(point, original);
    assert.equal(result?.source, '倾斜摄影/模型表面');
    assert.deepEqual(f.calls, ['object', 'depth']);
    assert.deepEqual(f.transitions, [true, previous]);
    assert.equal(f.scene.pickTranslucentDepth, previous);
  }
});

test('missing depth restores the original mode before terrain, ellipsoid and empty fallbacks', () => {
  const terrain = new Cartesian3(123, 456, 789);
  const ellipsoid = new Cartesian3(100, 200, 300);
  for (const previous of [false, true]) {
    const ground = fixture({ previous, terrain });
    assert.deepEqual(ground.pick(), { position: terrain, source: '地形表面' });
    assert.deepEqual(ground.calls, ['object', 'depth', 'ray', 'terrain']);
    assert.deepEqual(ground.transitions, [true, previous]);
    assert.equal(ground.scene.pickTranslucentDepth, previous);

    const globe = fixture({ previous, ellipsoid });
    assert.deepEqual(globe.pick(), { position: ellipsoid, source: '椭球表面' });
    assert.deepEqual(globe.calls, ['object', 'depth', 'ray', 'terrain', 'ellipsoid']);
    assert.deepEqual(globe.transitions, [true, previous]);
    assert.equal(globe.scene.pickTranslucentDepth, previous);

    const empty = fixture({ previous });
    assert.equal(empty.pick(), undefined);
    assert.deepEqual(empty.transitions, [true, previous]);
    assert.equal(empty.scene.pickTranslucentDepth, previous);
  }
});

test('depth-pick errors restore the scene setting before propagating the original error', () => {
  for (const previous of [false, true]) {
    const error = new Error('depth buffer unavailable');
    const f = fixture({ previous, failDepth: error });
    assert.throws(f.pick, (actual: unknown) => actual === error);
    assert.deepEqual(f.calls, ['object', 'depth']);
    assert.deepEqual(f.transitions, [true, previous]);
    assert.equal(f.scene.pickTranslucentDepth, previous);
  }
});

test('unsupported depth picking leaves the scene mode untouched and uses the existing fallback', () => {
  const terrain = new Cartesian3(123, 456, 789);
  for (const previous of [false, true]) {
    const f = fixture({ previous, supported: false, terrain });
    assert.deepEqual(f.pick(), { position: terrain, source: '地形表面' });
    assert.deepEqual(f.calls, ['object', 'ray', 'terrain']);
    assert.deepEqual(f.transitions, []);
    assert.equal(f.scene.pickTranslucentDepth, previous);
  }
});
