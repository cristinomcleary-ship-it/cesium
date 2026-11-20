import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFixtureFrames } from '../tools/fixtures/render-fixture-frames.ts';

// Cesium clears the requested bit before it renders, then raises postRender.
// An idle request-render scene must receive the next request from that event.
function scene(requestRenderMode = true) {
  const listeners = new Set<() => void>();
  const owner = {
    requestRenderMode, maximumRenderTimeChange: Infinity,
    pending: false, requests: 0, rendered: 0,
    postRender: { addEventListener(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    requestRender() { this.requests++; this.pending = true; },
    tick() {
      if (this.requestRenderMode && !this.pending) return;
      this.pending = false; this.rendered++;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() { return listeners.size; },
  };
  return owner;
}

for (const requestRenderMode of [true, false]) {
  test(`fixture waits for all five real postRender events in ${requestRenderMode ? 'idle request' : 'continuous'} render mode`, async () => {
    const owner = scene(requestRenderMode);
    let complete = false;
    const waiting = renderFixtureFrames(owner, 5).then(() => { complete = true; });
    assert.equal(owner.requests, 1); assert.equal(owner.rendered, 0);
    for (let i = 1; i <= 4; i++) {
      owner.tick(); await Promise.resolve();
      assert.equal(owner.rendered, i); assert.equal(complete, false);
      assert.equal(owner.requests, i + 1, 'each completed frame requests just the next one');
      assert.equal(owner.listenerCount, 1);
    }
    owner.tick(); await waiting;
    assert.equal(owner.rendered, 5); assert.equal(owner.requests, 5);
    assert.equal(owner.listenerCount, 0); assert.equal(owner.pending, false);
    assert.equal(owner.requestRenderMode, requestRenderMode); assert.equal(owner.maximumRenderTimeChange, Infinity);
    owner.tick(); assert.equal(owner.requests, 5, 'completed wait does not keep a render loop alive');
    if (requestRenderMode) assert.equal(owner.rendered, 5);
  });
}

test('fixture frame wait retains the original 20 second budget and removes its listener on timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = scene();
  let settled = false;
  const pending = renderFixtureFrames(owner, 5, () => ['reported GPU failure']);
  const rejected = assert.rejects(pending, /Synthetic scene frame timeout \(1\/5\): reported GPU failure/).then(() => { settled = true; });
  owner.tick();
  t.mock.timers.tick(19_999); await Promise.resolve();
  assert.equal(settled, false); assert.equal(owner.listenerCount, 1);
  t.mock.timers.tick(1); await rejected;
  assert.equal(owner.listenerCount, 0); assert.equal(owner.requests, 2);
  owner.tick(); assert.equal(owner.requests, 2, 'late frames cannot revive a timed-out wait');
});

test('requestRender errors reject and remove the fixture listener instead of hanging', async () => {
  const owner = scene(), failure = new Error('scene destroyed');
  const request = owner.requestRender.bind(owner);
  owner.requestRender = () => { if (owner.requests === 1) throw failure; request(); };
  const rejected = assert.rejects(renderFixtureFrames(owner, 3), error => error === failure);
  owner.tick(); await rejected;
  assert.equal(owner.listenerCount, 0); assert.equal(owner.requests, 1);
});

test('invalid fixture frame counts do not install listeners or issue render requests', async () => {
  const owner = scene();
  for (const count of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(renderFixtureFrames(owner, count), RangeError);
  assert.equal(owner.listenerCount, 0); assert.equal(owner.requests, 0);
});
