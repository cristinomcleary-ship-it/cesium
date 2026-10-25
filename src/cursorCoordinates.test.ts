import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorCoordinates, type CursorPosition } from './cursorCoordinates.ts';

test('1,000 pointer events in one second cause only ten terrain samples and retain the final position', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const samples: CursorPosition[] = [], texts: string[] = [];
  const coordinates = new CursorCoordinates({ sample: position => { samples.push({ ...position }); return String(position.x); }, publish: text => texts.push(text) });
  const reusedPosition = { x: 0, y: 7 };
  for (let index = 0; index < 1000; index++) {
    reusedPosition.x = index;
    coordinates.move(reusedPosition);
    context.mock.timers.tick(1);
  }
  assert.equal(samples.length, 10);
  assert.deepEqual(samples.at(-1), { x: 999, y: 7 });
  assert.equal(texts.at(-1), '999');
  context.mock.timers.tick(60_000);
  assert.equal(samples.length, 10, 'an idle cursor has no polling work');
  coordinates.dispose();
});

test('camera movement cancels queued work and its end samples the latest cursor with the final camera', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let camera = 'old';
  const samples: string[] = [];
  const coordinates = new CursorCoordinates({ sample: position => { samples.push(`${camera}:${position.x}`); return samples.at(-1); }, publish() {} });
  coordinates.move({ x: 1, y: 2 });
  context.mock.timers.tick(50);
  coordinates.setCameraMoving(true);
  for (let index = 0; index < 1000; index++) {
    coordinates.move({ x: index, y: 2 });
    context.mock.timers.tick(1);
  }
  assert.deepEqual(samples, [], 'navigation never triggers status-bar terrain intersections');
  camera = 'final';
  coordinates.setCameraMoving(false);
  context.mock.timers.tick(100);
  assert.deepEqual(samples, ['final:999']);
  coordinates.setCameraMoving(false);
  context.mock.timers.tick(100);
  assert.equal(samples.length, 1, 'duplicate moveEnd events do not create more work');
  coordinates.setCameraMoving(true);
  camera = 'zoomed';
  coordinates.setCameraMoving(false);
  context.mock.timers.tick(100);
  assert.deepEqual(samples, ['final:999', 'zoomed:999'], 'wheel/keyboard movement refreshes without pointer movement');
  coordinates.dispose();
});

test('keeps real sampled text and avoids rewriting unchanged or missing intersections', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let result: string | undefined = '经度 120.000000 · 纬度 30.000000 · 高程 127.4m';
  const texts: string[] = [], samples: CursorPosition[] = [];
  const coordinates = new CursorCoordinates({ sample: position => { samples.push({ ...position }); return result; }, publish: text => texts.push(text) });
  const position = { x: 21, y: 42 };
  coordinates.move(position);
  position.x = 100;
  context.mock.timers.tick(100);
  assert.deepEqual(samples[0], { x: 21, y: 42 }, 'reused events cannot mutate a pending sample');
  coordinates.move(position); context.mock.timers.tick(100);
  result = undefined;
  coordinates.move(position); context.mock.timers.tick(100);
  assert.deepEqual(texts, ['经度 120.000000 · 纬度 30.000000 · 高程 127.4m']);
  coordinates.dispose();
});

test('disposing cancels pending samples and camera changes without touching explicit picks', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const explicitPick = () => { calls++; return 'terrain'; };
  const coordinates = new CursorCoordinates({ sample: explicitPick, publish() {} });
  coordinates.move({ x: 1, y: 2 });
  coordinates.dispose(); coordinates.dispose();
  coordinates.move({ x: 3, y: 4 });
  coordinates.setCameraMoving(true); coordinates.setCameraMoving(false);
  context.mock.timers.tick(1000);
  assert.equal(calls, 0);
  assert.equal(explicitPick(), 'terrain');
  assert.equal(calls, 1);
});
