import test from 'node:test';
import assert from 'node:assert/strict';
import { SafetyVideoStatusChanges, safetyVideoRoamStatusKey, type SafetyVideoStatusInput } from './safetyVideoStatus.ts';
import type { SafetyVideoRoamState } from './safetyVideoRoam.ts';

const paused: SafetyVideoStatusInput = {
  sourceKey: 'video:one/generation:1', currentSource: 'blob:video-one', selectedMedia: 'video:one',
  mode: 'replay', bound: true, loading: false, currentTime: 5, duration: 60,
  paused: true, ended: false, rate: 1, readyState: 4,
};

test('panning or zooming a paused scene does not repeatedly publish video controls', () => {
  const changes = new SafetyVideoStatusChanges();
  let publications = 0;
  for (let frame = 0; frame < 1000; frame++) if (changes.changed({ ...paused })) publications++;
  assert.equal(publications, 1, 'only the first status sample is published');
  assert.equal(changes.changed({ ...paused, currentTime: 12 }), true, 'paused seek is immediately visible');
  assert.equal(changes.changed({ ...paused, currentTime: 12 }), false);
});

test('playing media advances controls and stopping suppresses unchanged updates', () => {
  const changes = new SafetyVideoStatusChanges();
  changes.changed(paused);
  for (let tick = 0; tick < 10; tick++) {
    assert.equal(changes.changed({ ...paused, paused: false, currentTime: 5 + tick / 10 }), true);
  }
  const ended = { ...paused, currentTime: 60, ended: true };
  assert.equal(changes.changed(ended), true);
  assert.equal(changes.changed(ended), false);
});

test('metadata, errors, source reloads, rates and availability invalidate paused controls', () => {
  for (const patch of [
    { duration: 70 }, { errorCode: 3, errorMessage: 'decode failed' },
    { sourceKey: 'video:one/generation:2' }, { currentSource: 'blob:video-two' },
    { rate: 2 }, { readyState: 0 }, { bound: false }, { loading: true },
    { selectedMedia: 'video:two' }, { mode: 'live' },
  ]) {
    const changes = new SafetyVideoStatusChanges();
    changes.changed(paused);
    assert.equal(changes.changed({ ...paused, ...patch }), true, JSON.stringify(patch));
  }
});

test('asynchronous roam state changes publish while per-frame timestamps use playback cadence', () => {
  const state: SafetyVideoRoamState = {
    available: true, enabled: true, active: false, state: 'paused', label: '航迹跟随',
    message: '已暂停', missing: [], mode: 'path', userWantsFollow: true, mediaTime: 5, telemetryTimeMs: 5000,
  };
  assert.equal(safetyVideoRoamStatusKey(state), safetyVideoRoamStatusKey({ ...state, mediaTime: 6, telemetryTimeMs: 6000 }));
  for (const patch of [{ state: 'unavailable' }, { available: false }, { missing: ['高程基准待核验'] }, { enabled: false }, { message: '已退出跟随' }]) {
    assert.notEqual(safetyVideoRoamStatusKey(state), safetyVideoRoamStatusKey({ ...state, ...patch }));
  }
});
