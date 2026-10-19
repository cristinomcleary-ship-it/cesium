import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVideoFrameSource, createVideoFrameZip, fingerprintVideoFrameSource, parseVideoFrameManifest, planVideoFrameTimes, verifyVideoFrameSource, type VideoFrameManifest } from './videoFrameExtraction.ts';

function manifest(): VideoFrameManifest {
  return { version: 1, kind: 'cesium-video-frames', source: { name: 'flight.mp4', size: 1234, lastModified: 99, duration: 3, width: 1920, height: 1080 },
    extraction: { start: 0, end: 3, intervalSeconds: 1, requestedCount: 3, width: 960, height: 540 },
    frames: [0, 1, 2].map(index => ({ filename: `frame_${index}.jpg`, index, requestedTime: index + .05, mediaTime: index, width: 960, height: 540 })) };
}
test('frame planning excludes video end and keeps exact subrange/request count', () => {
  assert.deepEqual(planVideoFrameTimes(3), [0, 1, 2]);
  assert.deepEqual(planVideoFrameTimes(10, { start: 2, end: 5, intervalSeconds: 1 }), [2, 3, 4]);
  const count = planVideoFrameTimes(3, { start: .15, end: 2.55, count: 4 });
  assert.equal(count.length, 4); assert.equal(count[0], .15); assert.ok(count[3] < 2.55); assert.ok(count[3] > 2.549);
  assert.deepEqual(planVideoFrameTimes(1, { count: 1 }), [0]);
  assert.throws(() => planVideoFrameTimes(3, { count: 4, intervalSeconds: 1 }), /只能选择一种/);
  assert.throws(() => planVideoFrameTimes(3, { start: 3 }), /有效抽帧范围/);
  assert.throws(() => planVideoFrameTimes(3, { end: 4 }), /有效抽帧范围/);
  assert.throws(() => planVideoFrameTimes(3, { intervalSeconds: .000001 }), /最多/);
});
test('manifest preserves decoded timestamps and rejects ambiguous filenames, times and sizes', () => {
  const source = manifest(); assert.deepEqual(parseVideoFrameManifest(JSON.stringify(source)), source);
  const repeat = structuredClone(source); repeat.frames[1].filename = 'FRAME_0.JPG'; assert.throws(() => parseVideoFrameManifest(repeat), /文件名重复/);
  const path = structuredClone(source); path.frames[0].filename = '../frame.jpg'; assert.throws(() => parseVideoFrameManifest(path), /basename/);
  const repeatTime = structuredClone(source); repeatTime.frames[1].mediaTime = 0; assert.throws(() => parseVideoFrameManifest(repeatTime), /唯一/);
  const size = structuredClone(source); size.frames[1].height = 539; assert.throws(() => parseVideoFrameManifest(size), /尺寸不一致/);
  const range = structuredClone(source); range.frames[2].requestedTime = 4; assert.throws(() => parseVideoFrameManifest(range), /抽帧范围/);
});
test('manifest identity refuses another video even if it has the same filename', () => {
  const data = manifest(), file = { name: 'flight.mp4', size: 1234, lastModified: 99 };
  assert.doesNotThrow(() => assertVideoFrameSource(data, file));
  for (const patch of [{ name: 'other.mp4' }, { size: 1235 }, { lastModified: 100 }]) assert.throws(() => assertVideoFrameSource(data, { ...file, ...patch }), /不匹配/);
});
test('content identity survives stored File reconstruction but rejects equal-size changed contents', async () => {
  const original = new File(['actual movie content'], 'flight.mp4', { lastModified: 99 });
  const data = manifest(); data.source.size = original.size; data.source.fingerprint = await fingerprintVideoFrameSource(original);
  const reopened = new File([await original.arrayBuffer()], 'stored-copy.mp4', { lastModified: 1234567 });
  await verifyVideoFrameSource(data, reopened);
  const other = new File(['different video data'], 'flight.mp4', { lastModified: 99 }); assert.equal(other.size, original.size);
  await assert.rejects(() => verifyVideoFrameSource(data, other), /内容不匹配/);
  const invalid = structuredClone(data); invalid.source.fingerprint!.value = 'bad'; assert.throws(() => parseVideoFrameManifest(invalid), /指纹无效/);
});
test('large video fingerprint reads only bounded first, middle and last samples and includes size', async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024), samples: [number | undefined, number | undefined][] = [], original = new Blob([bytes]);
  const proxy = { size: original.size, slice(start?: number, end?: number) { samples.push([start, end]); return original.slice(start, end); } } as Blob;
  const before = await fingerprintVideoFrameSource(proxy); assert.equal(samples.length, 3);
  assert.equal(samples.reduce((total, [start, end]) => total + end! - start!, 0), 3 * 1024 * 1024);
  bytes[bytes.length - 1] = 1; const after = await fingerprintVideoFrameSource(new Blob([bytes])); assert.notEqual(before.value, after.value);
  const aborter = new AbortController(); aborter.abort(); await assert.rejects(() => fingerprintVideoFrameSource(original, aborter.signal), { name: 'AbortError' });
});
test('stored ZIP contains valid local/central CRC and explicit size cap', async () => {
  const entries = [{ name: 'frame_000000.jpg', bytes: new TextEncoder().encode('123456789') }, { name: 'video-frame-manifest.json', bytes: new TextEncoder().encode('{}') }];
  const bytes = new Uint8Array(await createVideoFrameZip(entries).arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50); assert.equal(view.getUint32(14, true), 0xcbf43926, 'known CRC-32 test vector');
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), 2);
  const centralOffset = view.getUint32(bytes.length - 6, true); assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  assert.equal(view.getUint32(centralOffset + 16, true), 0xcbf43926);
  assert.throws(() => createVideoFrameZip(entries, 50), /超过 128 MB/);
  assert.throws(() => createVideoFrameZip([{ name: '../bad.jpg', bytes: entries[0].bytes }]), /文件名无效/);
});
