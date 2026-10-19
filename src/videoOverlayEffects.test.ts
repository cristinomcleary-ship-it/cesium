import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultVideoOverlayEffect, evaluateVideoOverlayEffect, evaluateVideoOverlayEffects,
  validateVideoOverlayEffect, validateVideoOverlayEffects,
  type SavedVideoOverlayEffect,
} from './videoOverlayEffects.ts';

const cue = (overrides: Partial<SavedVideoOverlayEffect> = {}) => defaultVideoOverlayEffect({
  id: 'cad-cue', name: '设计图', targetId: 'cad', start: 2, end: 8,
  inMode: 'fade', outMode: 'fade', fadeIn: 2, fadeOut: 2, opacity: .8, ...overrides,
});
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test('old saved plans have no effects and preserve the selected resources at full alpha', () => {
  assert.deepEqual(validateVideoOverlayEffects(), []);
  assert.deepEqual(evaluateVideoOverlayEffects([], 0, ['cad', 'model']), {
    cad: { opacity: 1, visible: true }, model: { opacity: 1, visible: true },
  });
});

test('validation clones serializable cues, normalizes names and rejects duplicate IDs', () => {
  const original = cue({ id: ' cue ', name: ' 标注对象 ', targetId: ' model ' });
  const saved = validateVideoOverlayEffects([original]);
  assert.notEqual(saved[0], original);
  assert.equal(saved[0].id, 'cue'); assert.equal(saved[0].name, '标注对象'); assert.equal(saved[0].targetId, 'model');
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
  assert.throws(() => validateVideoOverlayEffects([original, original]), /ID 重复/);
  assert.throws(() => validateVideoOverlayEffects(null), /无效/);
  assert.throws(() => validateVideoOverlayEffects({ effects: [] }), /无效/);
});

test('malformed time, alpha, target, mode and durations are rejected before saving or loading', () => {
  for (const patch of [
    { id: '' }, { name: ' ' }, { targetId: '' }, { enabled: 'true' },
    { start: -1 }, { start: Infinity }, { start: NaN }, { end: 2 }, { end: 0 },
    { end: '8' }, { inMode: 'pop' }, { outMode: '' }, { fadeIn: -1 },
    { fadeOut: Infinity }, { opacity: -0.1 }, { opacity: 1.1 }, { opacity: NaN },
  ]) assert.throws(() => validateVideoOverlayEffect({ ...cue(), ...patch }), /无效/, JSON.stringify(patch));
  assert.throws(() => validateVideoOverlayEffect([]), /无效/);
});

test('fade envelope includes the start, excludes the end and respects maximum alpha', () => {
  const effect = cue();
  const expected = new Map([[-1, 0], [1.99, 0], [2, 0], [3, .4], [4, .8], [5, .8], [6, .8], [7, .4], [8, 0], [9, 0]]);
  for (const [time, opacity] of expected) {
    const actual = evaluateVideoOverlayEffect(effect, time);
    near(actual.opacity, opacity); assert.equal(actual.visible, opacity > 0);
  }
});

test('instant appear and disappear have no fade regardless of stored fade durations', () => {
  const effect = cue({ inMode: 'instant', outMode: 'instant', fadeIn: 50, fadeOut: 50 });
  assert.deepEqual(evaluateVideoOverlayEffect(effect, 2), { opacity: .8, visible: true });
  assert.deepEqual(evaluateVideoOverlayEffect(effect, 7.9999), { opacity: .8, visible: true });
  assert.deepEqual(evaluateVideoOverlayEffect(effect, 8), { opacity: 0, visible: false });
});

test('one-sided fade and zero-duration fade allow explicit disappear or constant dimming', () => {
  const effect = cue({ inMode: 'instant', fadeOut: 2 });
  near(evaluateVideoOverlayEffect(effect, 2).opacity, .8);
  near(evaluateVideoOverlayEffect(effect, 7).opacity, .4);
  const constant = cue({ fadeIn: 0, fadeOut: 0, opacity: .2 });
  near(evaluateVideoOverlayEffect(constant, 2).opacity, .2);
  near(evaluateVideoOverlayEffect(constant, 7.99).opacity, .2);
  assert.equal(evaluateVideoOverlayEffect(cue({ opacity: 0 }), 5).visible, false);
});

test('long fades fit short clips in proportion and can reach their chosen maximum', () => {
  const effect = cue({ start: 0, end: 3, fadeIn: 4, fadeOut: 2 });
  near(evaluateVideoOverlayEffect(effect, 1).opacity, .4);
  near(evaluateVideoOverlayEffect(effect, 2).opacity, .8);
  near(evaluateVideoOverlayEffect(effect, 2.5).opacity, .4);
  const enormous = cue({ start: 0, end: 2, fadeIn: Number.MAX_VALUE, fadeOut: Number.MAX_VALUE });
  near(evaluateVideoOverlayEffect(enormous, 1).opacity, .8);
  near(evaluateVideoOverlayEffect(enormous, .5).opacity, .4);
});

test('disabled cues are neutral even outside their interval and never hide other tracks', () => {
  const disabled = cue({ enabled: false });
  assert.deepEqual(evaluateVideoOverlayEffect(disabled, 100), { opacity: 1, visible: true });
  assert.deepEqual(evaluateVideoOverlayEffects([disabled], 100, ['cad']), { cad: { opacity: 1, visible: true } });
  near(evaluateVideoOverlayEffects([disabled, cue()], 3, ['cad']).cad.opacity, .4);
});

test('multiple intervals for one object form a union while global effects multiply its alpha', () => {
  const first = cue({ start: 0, end: 2, fadeIn: 0, fadeOut: 0 });
  const second = cue({ id: 'second', start: 4, end: 6, fadeIn: 0, fadeOut: 0, opacity: .6 });
  const global = cue({ id: 'all', targetId: '*', start: 0, end: 10, fadeIn: 0, fadeOut: 0, opacity: .5 });
  const effects = [first, second, global];
  near(evaluateVideoOverlayEffects(effects, 1, ['cad', 'model']).cad.opacity, .4);
  near(evaluateVideoOverlayEffects(effects, 3, ['cad', 'model']).cad.opacity, 0);
  near(evaluateVideoOverlayEffects(effects, 5, ['cad', 'model']).cad.opacity, .3);
  near(evaluateVideoOverlayEffects(effects, 5, ['cad', 'model']).model.opacity, .5);
  near(evaluateVideoOverlayEffects(effects, 11, ['cad', 'model']).model.opacity, 0);
});

test('depth occluder is omitted even if it has a specific effect or a global track hides models', () => {
  const effects = [cue({ targetId: '*', start: 0, end: 1 }), cue({ id: 'depth', targetId: 'survey' })];
  const actual = evaluateVideoOverlayEffects(effects, 5, ['cad', 'survey', 'model', 'cad'], { occluderId: 'survey' });
  assert.deepEqual(actual, { cad: { opacity: 0, visible: false }, model: { opacity: 0, visible: false } });
  assert.equal(Object.hasOwn(actual, 'survey'), false);
});

test('evaluation is order-independent and never compounds alpha on repeated rendering or seeking', () => {
  const effects = Object.freeze([Object.freeze(cue())]);
  const evaluate = (time: number) => evaluateVideoOverlayEffects(effects, time, ['cad']).cad;
  const preview = evaluate(3);
  for (let index = 0; index < 100; index++) assert.deepEqual(evaluate(3), preview);
  for (const time of [7, 8, 2, 5, 3, 0, 3]) assert.deepEqual(evaluate(time), evaluateVideoOverlayEffect(effects[0], time));
  assert.deepEqual(evaluate(3), preview);
  assert.equal(effects[0].opacity, .8);
});

test('unknown resource tracks stay isolated and unusual resource IDs remain safe own properties', () => {
  const effect = cue({ targetId: 'missing' });
  const actual = evaluateVideoOverlayEffects([effect], 50, ['model', '__proto__', '*']);
  assert.deepEqual(actual.model, { opacity: 1, visible: true });
  assert.equal(Object.hasOwn(actual, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal(Object.hasOwn(actual, '*'), false);
});

test('invalid evaluation timestamps fail consistently across preview and export', () => {
  for (const time of [NaN, Infinity, -Infinity]) {
    assert.throws(() => evaluateVideoOverlayEffect(cue(), time), /时间/);
    assert.throws(() => evaluateVideoOverlayEffects([], time, []), /时间/);
  }
});
