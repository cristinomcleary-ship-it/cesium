import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Color, ColorMaterialProperty, Ellipsoid, Entity, ImageMaterialProperty, JulianDate, Material, PolygonGeometryUpdater, WallGeometryUpdater, type Scene } from 'cesium';
import { createRailSafetyEffectMaterial, isRailSafetyEffectAnimated, isRailSafetyEffectMaterialAnimated, RailSafetyEffectMaterialProperty, RailSafetyEffectRenderLoop } from './railSafetyEffects.ts';
import type { RailSafetyRangeEffect } from './railSafetyDisplay';

const effect = (mode: RailSafetyRangeEffect['mode'] = 'flow'): RailSafetyRangeEffect => ({ mode, speed: 1, intensity: 0.55 });

test('static, zero-intensity and zero-opacity settings use constant native materials', () => {
  for (const settings of [effect('static'), { ...effect(), intensity: 0 }]) {
    const material = createRailSafetyEffectMaterial({ color: Color.RED.withAlpha(0.4), effect: settings });
    assert.ok(material instanceof ColorMaterialProperty);
    assert.equal(material.isConstant, true);
    assert.equal(isRailSafetyEffectMaterialAnimated(material), false);
    assert.equal(material.getValue(JulianDate.now()).color.alpha, 0.4);
  }
  const transparent = createRailSafetyEffectMaterial({ color: Color.RED.withAlpha(0), effect: effect() });
  assert.ok(transparent instanceof ColorMaterialProperty);
  assert.equal(transparent.getValue(JulianDate.now()).color.alpha, 0);
  assert.equal(isRailSafetyEffectAnimated(effect(), 0), false);
  const image = { width: 2, height: 2 } as HTMLCanvasElement;
  const staticImage = createRailSafetyEffectMaterial({ color: Color.WHITE.withAlpha(0.4), effect: effect('static'), image });
  assert.ok(staticImage instanceof ImageMaterialProperty);
  assert.equal(staticImage.getValue(JulianDate.now()).image, image);
  assert.equal(staticImage.getValue(JulianDate.now()).color.alpha, 0.4);
});

test('animated properties keep constant material parameters and an explicit animation marker', () => {
  for (const mode of ['breathe', 'flow'] as const) {
    const color = Color.fromCssColorString('#126abc')!.withAlpha(0.27), settings = effect(mode);
    const material = createRailSafetyEffectMaterial({ color, effect: settings });
    assert.ok(material instanceof RailSafetyEffectMaterialProperty);
    assert.equal(material.isConstant, true, 'ground polygons keep their existing geometry');
    assert.equal(isRailSafetyEffectMaterialAnimated(material), true);
    const first = material.getValue(JulianDate.fromIso8601('2026-01-01T00:00:00Z'));
    assert.equal(first.mode, mode === 'flow' ? 2 : 1);
    assert.equal(first.speed, 1);
    assert.equal(first.intensity, 0.55);
    assert.ok(Color.equals(first.color, color));
    assert.deepEqual(material.getValue(JulianDate.fromIso8601('2050-01-01T00:00:00Z')), first,
      'viewer time scrubbing does not alter the material definition or require geometry rebuilds');
    color.alpha = 0.9; settings.intensity = 1;
    assert.equal(material.getValue().color!.alpha, 0.27, 'callers cannot mutate the material through its input objects');
    assert.equal(material.getValue().intensity, 0.55);
    const reused = { color: Color.BLACK.clone(), image: {} as HTMLCanvasElement };
    const reusedColor = reused.color;
    assert.equal(material.getValue(undefined, reused), reused);
    assert.equal(reused.color, reusedColor);
    assert.equal('image' in reused, false);
  }
});

test('material speed, intensity and alpha bounds preserve transparent input and exact mask identity', () => {
  const image = { width: 8, height: 4 } as HTMLCanvasElement;
  const material = new RailSafetyEffectMaterialProperty({ color: Color.WHITE.withAlpha(0), image,
    effect: { mode: 'flow', speed: 99, intensity: 99 } });
  assert.equal(material.animated, false);
  const values = material.getValue();
  assert.equal(values.color!.alpha, 0);
  assert.equal(values.mode, 0);
  assert.equal(values.speed, 3);
  assert.equal(values.intensity, 1);
  assert.equal(values.image, image);
  const small = new RailSafetyEffectMaterialProperty({ color: Color.WHITE.withAlpha(0.2), image,
    effect: { mode: 'breathe', speed: -3, intensity: -1 } });
  assert.equal(small.getValue().speed, 0.25);
  assert.equal(small.getValue().intensity, 0);
  assert.equal(small.getValue().color!.alpha, 0.2);
  assert.equal(small.animated, false);
  const bad = new RailSafetyEffectMaterialProperty({ color: Color.WHITE, effect: { mode: 'flow', speed: NaN, intensity: Infinity } });
  assert.equal(bad.getValue().speed, 1);
  assert.equal(bad.getValue().intensity, 0.55);
});

test('Cesium accepts both registered shader fabrics with strict uniforms, frame clock and unchanged mask coordinates', () => {
  const names = ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas'] as const;
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  class Canvas {}
  for (const name of names) Object.defineProperty(globalThis, name, { value: Canvas, configurable: true });
  try {
    for (const masked of [false, true]) {
      const property = new RailSafetyEffectMaterialProperty({ color: Color.WHITE.withAlpha(0.3), effect: effect(),
        ...(masked ? { image: new Canvas() as HTMLCanvasElement } : {}) });
      const material = new Material({ fabric: { type: property.getType() }, strict: true });
      assert.equal(material.isTranslucent(), true);
      assert.match(material.shaderSource, /czm_frameNumber/);
      assert.match(material.shaderSource, /materialInput\.st\.s \* 6\.0/);
      assert.match(material.shaderSource, /surface\.a \* clamp\(modulation, 0\.0, 1\.0\)/,
        'animation can only attenuate the base opacity, including transparent mask pixels');
      if (masked) {
        assert.match(material.shaderSource, /texture\(image_\d+, materialInput\.st\)/);
        assert.doesNotMatch(material.shaderSource, /fract\(|texture\([^,]+,.*phase/,
          'mask holes and boundary stay at their existing UV positions');
      }
      material.destroy();
    }
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test('equal material definitions can share a batch while colors, mode, speed and masks remain independent', () => {
  const options = { color: Color.YELLOW.withAlpha(0.4), effect: effect() };
  const first = new RailSafetyEffectMaterialProperty(options);
  assert.ok(first.equals(new RailSafetyEffectMaterialProperty(options)));
  for (const changed of [
    { ...options, color: Color.YELLOW.withAlpha(0.5) },
    { ...options, effect: effect('breathe') },
    { ...options, effect: { ...effect(), speed: 2 } },
    { ...options, image: {} as HTMLCanvasElement },
  ]) assert.equal(first.equals(new RailSafetyEffectMaterialProperty(changed)), false);
});

test('native ground polygon and wall updaters stay static with animated shader materials', () => {
  const context = { depthTexture: true, stencilBuffer: true };
  const scene = { context, frameState: { context }, ellipsoid: Ellipsoid.WGS84 } as unknown as Scene;
  const positions = Cartesian3.fromDegreesArray([121, 31, 121.001, 31, 121.001, 31.001, 121, 31.001]);
  const material = createRailSafetyEffectMaterial({ color: Color.CYAN.withAlpha(0.3), effect: effect() });
  const ground = new PolygonGeometryUpdater(new Entity({ polygon: { hierarchy: positions, material } }), scene) as
    PolygonGeometryUpdater & { isDynamic: boolean; onTerrain: boolean; destroy(): void };
  const wall = new WallGeometryUpdater(new Entity({ wall: { positions, minimumHeights: [0, 0, 0, 0], maximumHeights: [5, 5, 5, 5], material } }), scene) as
    WallGeometryUpdater & { isDynamic: boolean; destroy(): void };
  try {
    assert.equal(ground.onTerrain, true);
    assert.equal(ground.isDynamic, false, 'Cesium uses the static ground material batch');
    assert.equal(wall.isDynamic, false);
    assert.ok(ground.createFillGeometryInstance(JulianDate.now()).geometry);
    assert.ok(wall.createFillGeometryInstance(JulianDate.now()).geometry);
  } finally { ground.destroy(); wall.destroy(); }
});

function loopFixture() {
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let id = 0, renders = 0, hidden = false;
  const visibility = {
    get hidden() { return hidden; },
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) { listeners.add(listener); },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) { listeners.delete(listener); },
  } as Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  const loop = new RailSafetyEffectRenderLoop({
    requestRender: () => { renders++; }, schedule: callback => { const handle = ++id; frames.set(handle, callback); return handle; },
    cancel: handle => { frames.delete(handle); }, visibility,
  });
  return {
    loop, frames, listeners, get renders() { return renders; },
    tick() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(1000); },
    hidden(value: boolean) { hidden = value; for (const listener of listeners) {
      if (typeof listener === 'function') listener(new globalThis.Event('visibilitychange'));
      else listener.handleEvent(new globalThis.Event('visibilitychange'));
    } },
  };
}

test('render loop owns one frame only while visible animated layers are enabled, then releases it', () => {
  const f = loopFixture();
  assert.equal(f.loop.active, false); assert.equal(f.frames.size, 0);
  f.loop.setActive(false); assert.equal(f.frames.size, 0);
  f.loop.setActive(true); f.loop.setActive(true);
  assert.equal(f.loop.active, true); assert.equal(f.loop.running, true); assert.equal(f.frames.size, 1);
  f.tick(); assert.equal(f.renders, 1); assert.equal(f.frames.size, 1);
  f.hidden(true); assert.equal(f.loop.active, false); assert.equal(f.loop.running, false); assert.equal(f.frames.size, 0);
  f.tick(); assert.equal(f.renders, 1);
  f.hidden(false); assert.equal(f.frames.size, 1);
  f.tick(); assert.equal(f.renders, 2);
  f.loop.setActive(false); assert.equal(f.frames.size, 0); assert.equal(f.loop.pendingFrame, false);
  f.hidden(true); f.hidden(false); assert.equal(f.frames.size, 0, 'showing the tab does not animate static or hidden layers');
  f.loop.dispose(); assert.equal(f.listeners.size, 0);
  f.loop.setActive(true); assert.equal(f.frames.size, 0);
});

test('cancelled callbacks cannot reanimate a hidden or disposed scene', () => {
  const f = loopFixture();
  f.loop.setActive(true);
  const late = [...f.frames.values()][0];
  f.loop.setActive(false); f.loop.setActive(true);
  late(1000);
  assert.equal(f.renders, 0); assert.equal(f.frames.size, 1, 'old callback cannot clear or multiply the new frame');
  const last = [...f.frames.values()][0];
  f.loop.dispose(); f.loop.dispose(); last(2000);
  assert.equal(f.renders, 0); assert.equal(f.frames.size, 0); assert.equal(f.loop.active, false);
});

test('CPU environments without requestAnimationFrame create no timer fallback', () => {
  assert.equal(typeof globalThis.requestAnimationFrame, 'undefined');
  const loop = new RailSafetyEffectRenderLoop({ requestRender: () => assert.fail('no browser scheduler exists') });
  loop.setActive(true);
  assert.equal(loop.active, false); assert.equal(loop.running, false); assert.equal(loop.pendingFrame, false);
  loop.dispose();
});
