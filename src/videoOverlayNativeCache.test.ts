import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeCacheDimensions, nativeCacheFallbackBitrate, normalizeNativeCacheRange, prepareNativeVideoCache, sourceTimeForCacheFrame } from './videoOverlayNativeCache.ts';

test('source PTS retain 60 fps and irregular frame spacing instead of rounding to a 30 fps grid', () => {
  const range = { start: 17.123456, end: 20 };
  const timestamps = [0, 1 / 60, 2 / 60, 0.041711, 0.095, 0.111111];
  const actual = timestamps.map(timestamp => sourceTimeForCacheFrame(timestamp, range));
  actual.forEach((time, index) => assert.ok(Math.abs(time - range.start - timestamps[index]) < 1e-12));
  assert.equal(new Set(actual).size, timestamps.length);
});

test('range is clipped to the source end without changing a fractional trim boundary', () => {
  assert.deepEqual(normalizeNativeCacheRange({ start: 0.123456, end: 100 }, 2.345678), { start: 0.123456, end: 2.345678 });
  for (const range of [{ start: -1, end: 2 }, { start: 2, end: 2 }, { start: 3, end: 4 }, { start: 0, end: Infinity }]) {
    assert.throws(() => normalizeNativeCacheRange(range, 2));
  }
});

test('cache rejects downscaling and odd-size rounding; accepts exact 4K and original odd dimensions', () => {
  assert.doesNotThrow(() => assertNativeCacheDimensions(3840, 2160, 3840, 2160));
  assert.doesNotThrow(() => assertNativeCacheDimensions(1001, 563, 1001, 563));
  assert.throws(() => assertNativeCacheDimensions(1920, 1080, 3840, 2160), /分辨率/);
  assert.throws(() => assertNativeCacheDimensions(1000, 562, 1001, 563), /分辨率/);
});

test('already-cancelled preparation never reads a source or opens a target file', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareNativeVideoCache({ signal: controller.signal } as never), { name: 'AbortError' });
});

test('fallback encoding budget scales with native 4K/high frame rate and never undercuts a high source bitrate', () => {
  assert.ok(nativeCacheFallbackBitrate(3840, 2160, 60, 100_000_000) >= 125_000_000);
  assert.ok(nativeCacheFallbackBitrate(3840, 2160, 120, 0) > nativeCacheFallbackBitrate(3840, 2160, 60, 0));
  assert.ok(nativeCacheFallbackBitrate(1920, 1080, 30, 100_000_000) >= 125_000_000);
  assert.ok(Number.isFinite(nativeCacheFallbackBitrate(3840, 2160, NaN, NaN)));
});
