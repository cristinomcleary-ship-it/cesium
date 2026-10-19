import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoFramePosCsv, parseVideoPosCsv, sampleVideoPos, VIDEO_POS_HEADER } from './videoFramePos';
import { planOfflineFrameTimes } from './videoOverlayOfflineExport';

const csv = `${VIDEO_POS_HEADER}\nframe_000000.jpg,WGS 84,120,30,100,179,-30,0\nframe_000030.jpg,WGS 84,120.001,30.001,102,-179,-32,2\n`;
test('CC POS uses source frame numbers and actual video PTS, preserving skipped numbers and angle wrap', () => {
  const source = parseVideoPosCsv(csv, { frameRate: 30 });
  assert.deepEqual(source.samples.map(s => s.time), [0, 1]);
  const middle = sampleVideoPos(source, .5);
  assert.equal(middle.x, 120.0005); assert.equal(middle.z, 101); assert.equal(middle.yaw, 180);
  const frames = [{ filename: 'frame_000001.jpg', index: 1, requestedTime: .56, mediaTime: .5, width: 640, height: 360 }];
  const result = createVideoFramePosCsv(frames, source);
  assert.match(result, /frame_000001.jpg,WGS 84,120.0005,30.0005,101,180,-31,1/);
});
test('explicit POS times override FPS, and missing data never becomes zero coordinates or extrapolated priors', () => {
  const source = parseVideoPosCsv(`name,coordinate_system,x,y,z,time_seconds\na.jpg,EPSG:4979,120,30,100,2\nb.jpg,EPSG:4979,121,31,110,3`, { frameRate: NaN });
  assert.equal(sampleVideoPos(source, 2.5).x, 120.5);
  assert.throws(() => sampleVideoPos(source, 1), /未覆盖/);
  assert.throws(() => sampleVideoPos({ samples: [{ ...source.samples[0], time: 0 }, { ...source.samples[1], time: 20 }] }, 5), /缺少连续定位/);
  assert.throws(() => parseVideoPosCsv(csv.replace('120,30,100', ',30,100'), { frameRate: 30 }), /x 无效/);
  assert.throws(() => parseVideoPosCsv(csv.replace('000030', '000000'), { frameRate: 30 }), /严格递增/);
  assert.throws(() => parseVideoPosCsv(csv.replace('120,30', '300,30'), { frameRate: 30 }), /经度/);
});
test('template keeps photo names and explicitly empty coordinates', () => {
  const result = createVideoFramePosCsv([{ filename: 'frame_000000.jpg', index: 0, requestedTime: 0, mediaTime: 0, width: 640, height: 360 }]);
  assert.equal(result, `\uFEFF${VIDEO_POS_HEADER}\r\nframe_000000.jpg,,,,,,,\r\n`);
});
test('offline timeline is complete and independent of renderer wall time, including fractional final frame', () => {
  const plan = planOfflineFrameTimes(2, 4.105, 30);
  assert.equal(plan.length, 64); assert.equal(plan[0].time, 2);
  assert.equal(plan.at(-1)!.timestamp + plan.at(-1)!.duration, 2105000);
  assert.equal(plan.reduce((sum, p) => sum + p.duration, 0), 2105000);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].timestamp, plan[i - 1].timestamp + plan[i - 1].duration);
  assert.equal(planOfflineFrameTimes(0, 61, 30).length, 1830);
});
