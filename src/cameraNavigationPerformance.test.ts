import test from 'node:test';
import assert from 'node:assert/strict';
import { detectsSoftwareRenderer, installCameraNavigationPerformance } from './cameraNavigationPerformance.ts';

type Update = (this: unknown, ...args: unknown[]) => unknown;

function fixture(previous = true) {
  let depth = previous;
  const changes: boolean[] = [];
  const controller: { update?: Update } = {};
  const scene = {
    get useDepthPicking() { return depth; },
    set useDepthPicking(value: boolean) { changes.push(value); depth = value; },
    screenSpaceCameraController: controller,
  };
  return { scene, controller, changes };
}

test('navigation scope preserves receiver, arguments, result and the prior depth-picking setting', () => {
  for (const previous of [false, true]) {
    const f = fixture(previous), receiver = {}, result = {}, args = [{ frame: 1 }, 'input', 7];
    const original: Update = function (...received) {
      assert.equal(this, receiver);
      assert.deepEqual(received, args);
      assert.equal(f.scene.useDepthPicking, false);
      return result;
    };
    f.controller.update = original;
    const handle = installCameraNavigationPerformance(f.scene);
    assert.equal(handle.enabled, true);
    assert.equal(handle.installed, true);
    assert.equal(f.controller.update!.apply(receiver, args), result);
    assert.equal(f.scene.useDepthPicking, previous, 'subsequent explicit scene picks retain their original mode');
    assert.deepEqual(f.changes, [false, previous]);
    handle.dispose();
    assert.equal(f.controller.update, original);
    assert.equal(handle.enabled, false);
    assert.equal(handle.installed, false);
    assert.equal(handle.disposed, true);
    handle.dispose();
    assert.equal(f.controller.update, original);
  }
});

test('navigation errors propagate unchanged after restoring depth picking', () => {
  for (const previous of [false, true]) {
    const f = fixture(previous), error = new Error('controller failure');
    const original: Update = () => {
      assert.equal(f.scene.useDepthPicking, false);
      throw error;
    };
    f.controller.update = original;
    const handle = installCameraNavigationPerformance(f.scene);
    assert.throws(() => f.controller.update!(), (actual: unknown) => actual === error);
    assert.equal(f.scene.useDepthPicking, previous);
    assert.deepEqual(f.changes, [false, previous]);
    handle.dispose();
  }
});

test('tracked or non-world cameras can retain ordinary depth picking through the per-call predicate', () => {
  const f = fixture(), result = {};
  let eligible = false;
  const depths: boolean[] = [];
  f.controller.update = () => { depths.push(f.scene.useDepthPicking); return result; };
  const handle = installCameraNavigationPerformance(f.scene, { shouldUseLightweightNavigation: () => eligible });
  assert.equal(f.controller.update!(), result);
  assert.deepEqual(f.changes, []);
  eligible = true;
  assert.equal(f.controller.update!(), result);
  assert.deepEqual(depths, [true, false]);
  assert.equal(f.scene.useDepthPicking, true);
  handle.dispose();

  const fallback = installCameraNavigationPerformance(f.scene, { shouldUseLightweightNavigation: () => { throw new Error('camera disposed'); } });
  f.changes.length = 0;
  assert.equal(f.controller.update!(), result);
  assert.deepEqual(f.changes, [], 'predicate errors preserve normal navigation');
  fallback.dispose();
});

test('disabled or unsupported controller versions are left untouched', () => {
  const f = fixture(), original: Update = () => 17;
  f.controller.update = original;
  const disabled = installCameraNavigationPerformance(f.scene, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.installed, false);
  assert.equal(f.controller.update, original);
  assert.equal(f.controller.update(), 17);
  assert.deepEqual(f.changes, []);
  disabled.dispose();
  assert.equal(f.controller.update, original);

  for (const update of [undefined, null, 12]) {
    const controller = { update };
    const handle = installCameraNavigationPerformance({ useDepthPicking: true, screenSpaceCameraController: controller });
    assert.equal(handle.enabled, false);
    assert.equal(handle.installed, false);
    handle.dispose();
    assert.equal(controller.update, update);
  }
});

test('disposal preserves later owners and makes an externally-retained wrapper inert', () => {
  const f = fixture(), depths: boolean[] = [];
  f.controller.update = () => { depths.push(f.scene.useDepthPicking); return 'original'; };
  const handle = installCameraNavigationPerformance(f.scene);
  const ours = f.controller.update!;
  const replacement: Update = function (...args) { return ours.apply(this, args); };
  f.controller.update = replacement;
  assert.equal(handle.installed, false);
  handle.dispose();
  assert.equal(f.controller.update, replacement);
  assert.equal(f.controller.update(), 'original');
  assert.deepEqual(depths, [true]);
  assert.deepEqual(f.changes, [], 'the disposed wrapper does not alter scene state when called by a later owner');
});

test('software renderer detection recognizes known renderers and falls back to the existing WebGL context', () => {
  for (const renderer of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
    'llvmpipe (LLVM 18.1.8, 256 bits)', 'softpipe', 'Mesa swrast',
    'Software Rasterizer', 'Software Renderer', 'Microsoft Basic Render Driver',
  ]) {
    const calls: string[] = [], key = 37446;
    const context = {
      getExtension(name: string) { assert.equal(name, 'WEBGL_debug_renderer_info'); return { UNMASKED_RENDERER_WEBGL: key }; },
      getParameter(parameter: number) { assert.equal(parameter, key); return renderer; },
    };
    for (const webgl2 of [false, true]) {
      calls.length = 0;
      assert.equal(detectsSoftwareRenderer({ getContext(type) { calls.push(type); return type === 'webgl2' && !webgl2 ? null : context; } }), true, renderer);
      assert.deepEqual(calls, webgl2 ? ['webgl2'] : ['webgl2', 'webgl']);
    }
  }
});

test('unknown hardware and unavailable renderer information do not enable the compatibility adapter', () => {
  for (const renderer of ['ANGLE (NVIDIA GeForce RTX 4060, Direct3D11)', 'Intel(R) UHD Graphics', 'Apple M3', '', undefined]) {
    assert.equal(detectsSoftwareRenderer({ getContext: () => ({ getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }), getParameter: () => renderer }) }), false);
  }
  for (const context of [null, {}, { getExtension: () => null, getParameter: () => 'SwiftShader' }, {
    getExtension() { throw new Error('privacy restriction'); }, getParameter: () => 'SwiftShader',
  }, { getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }), getParameter() { throw new Error('context lost'); } }]) {
    assert.equal(detectsSoftwareRenderer({ getContext: () => context }), false);
  }
  assert.equal(detectsSoftwareRenderer({ getContext() { throw new Error('canvas unavailable'); } }), false);
});
