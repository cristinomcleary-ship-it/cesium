import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSurfaceTextureDimensions, validateSurfaceTextureHeader } from './surfaceEditTextureInput.ts';

function png(width: number, height: number) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function webp(kind: string, data: number[]) {
  const bytes = new Uint8Array(20 + data.length), view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70]); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 69, 66, 80], 8);
  bytes.set([...kind].map(c => c.charCodeAt(0)), 12); view.setUint32(16, data.length, true); bytes.set(data, 20); return bytes;
}

test('texture upload bounds reject large compressed raster dimensions before decoding', () => {
  assert.deepEqual(validateSurfaceTextureHeader('image/png', png(2048, 1024)), { width: 2048, height: 1024 });
  assert.throws(() => validateSurfaceTextureHeader('image/png', png(40000, 40000)), /2048/);
  assert.throws(() => validateSurfaceTextureHeader('image/png', png(0, 2)), /2048/);
  assert.throws(() => validateSurfaceTextureHeader('image/png', png(2, 2), 2 * 1024 * 1024 + 1), /2 MB/);
});
test('texture upload rejects unsupported types, mismatched signatures and malformed length fields', () => {
  assert.throws(() => validateSurfaceTextureHeader('image/svg+xml', png(1, 1)), /PNG/);
  assert.throws(() => validateSurfaceTextureHeader('image/jpeg', png(1, 1)), /PNG/);
  assert.throws(() => validateSurfaceTextureHeader('image/jpeg', new Uint8Array([255, 216, 255, 192, 255, 255])), /PNG/);
  assert.throws(() => validateSurfaceTextureHeader('image/webp', webp('VP8X', [0, 0])), /PNG/);
});
test('JPEG progressive dimensions are read after non-image segments', () => {
  const bytes = new Uint8Array([255, 216, 255, 224, 0, 4, 1, 2, 255, 194, 0, 8, 8, 4, 0, 8, 0, 0]);
  assert.deepEqual(validateSurfaceTextureHeader('image/jpeg', bytes), { width: 2048, height: 1024 });
});
test('WebP lossy, lossless and extended headers are supported; animation is rejected', () => {
  assert.deepEqual(validateSurfaceTextureHeader('image/webp', webp('VP8 ', [0, 0, 0, 157, 1, 42, 0, 4, 0, 2])), { width: 1024, height: 512 });
  assert.deepEqual(validateSurfaceTextureHeader('image/webp', webp('VP8L', [47, 255, 192, 63, 0])), { width: 256, height: 256 });
  assert.deepEqual(validateSurfaceTextureHeader('image/webp', webp('VP8X', [0, 0, 0, 0, 255, 3, 0, 255, 1, 0])), { width: 1024, height: 512 });
  assert.throws(() => validateSurfaceTextureHeader('image/webp', webp('VP8X', [2, 0, 0, 0, 255, 3, 0, 255, 1, 0])), /静态/);
});
test('actual decoded dimensions receive the same second-pass limit', () => {
  assert.deepEqual(validateSurfaceTextureDimensions({ width: 2048, height: 2048 }), { width: 2048, height: 2048 });
  assert.throws(() => validateSurfaceTextureDimensions({ width: 2048, height: 2049 }), /2048/);
  assert.throws(() => validateSurfaceTextureDimensions({ width: NaN, height: 1 }), /2048/);
});
