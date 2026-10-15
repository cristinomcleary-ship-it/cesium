import test from 'node:test';
import assert from 'node:assert/strict';
import { colorRailSafetyFallProjection } from './railSafetyFallProjectionTexture.ts';

test('a union mask keeps one fill opacity, transparent holes and the chosen range colour', () => {
  const width = 15, height = 15, mask = new Uint8Array(width * height).fill(1);
  mask[7 * width + 7] = 0;
  const pixels = colorRailSafetyFallProjection({ width, height, mask }, { surface: 'model', style: 'fill', opacity: 0.25, lineWidth: 1 }, '#17a0e3');
  assert.deepEqual([...pixels.slice((3 * width + 3) * 4, (3 * width + 3) * 4 + 4)], [23, 160, 227, 64]);
  assert.equal(pixels[(7 * width + 7) * 4 + 3], 0, 'an interior mesh opening is not filled by a hull');
  assert.equal(pixels[(7 * width + 6) * 4 + 3], 255, 'the hole edge gets an outline');
  assert.equal(pixels[3], 255, 'the exterior edge gets an outline');
});

test('outline mode removes the interior without joining independent pieces or filling empty canvas', () => {
  const width = 30, height = 15, mask = new Uint8Array(width * height);
  for (let y = 2; y < 13; y++) for (const start of [2, 18]) for (let x = start; x < start + 10; x++) mask[y * width + x] = 1;
  const pixels = colorRailSafetyFallProjection({ width, height, mask }, { surface: 'absolute', style: 'outline', opacity: 1, lineWidth: 2 }, '#e34b17');
  assert.equal(pixels[(7 * width + 7) * 4 + 3], 0);
  assert.equal(pixels[(7 * width + 15) * 4 + 3], 0);
  assert.equal(pixels[(7 * width + 2) * 4 + 3], 255);
  assert.equal(pixels[(7 * width + 18) * 4 + 3], 255);
});
