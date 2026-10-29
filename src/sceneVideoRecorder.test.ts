import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Viewer } from 'cesium';
import { SceneVideoRecorder, supportedSceneVideoFormats, type SceneVideoStartOptions } from './sceneVideoRecorder';

function browser(t: TestContext) {
  class Track extends EventTarget { stops = 0; requests = 0; stop() { this.stops++; } requestFrame() { this.requests++; } }
  const tracks: Track[] = [];
  class Recorder extends EventTarget {
    static instances: Recorder[] = [];
    static mp4 = false;
    static flushFirstFrame = false;
    static isTypeSupported(mime: string) { return mime.includes('webm') || this.mp4; }
    state = 'inactive'; mimeType: string; stops = 0; flushes = 0;
    constructor(_stream: unknown, options: MediaRecorderOptions) { super(); this.mimeType = options.mimeType!; Recorder.instances.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.stops++; queueMicrotask(() => { this.data(new Blob(['frame-final'])); this.dispatchEvent(new Event('stop')); }); }
    requestData() { this.flushes++; if (Recorder.flushFirstFrame) this.data(new Blob(['encoded-first-frame'])); }
    data(blob = new Blob(['frame'])) { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob })); }
  }
  const canvas = Object.assign(new EventTarget(), { width: 640, height: 480, captures: 0, captureStream() {
    this.captures++; const track = new Track(); tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  } });
  const buffers: Array<{ width: number; height: number }> = [];
  const documentMock = Object.assign(new EventTarget(), { hidden: false, createElement: () => {
    const buffer = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData() {} }), captureStream: canvas.captureStream.bind(canvas) };
    buffers.push(buffer); return buffer;
  } }), windowMock = new EventTarget();
  let nextFrame = 0; const animationFrames = new Set<number>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => { const id = ++nextFrame; animationFrames.add(id); queueMicrotask(() => { if (animationFrames.delete(id)) callback(performance.now()); }); return id; };
  const cancelAnimationFrame = (id: number) => animationFrames.delete(id);
  for (const [name, value] of Object.entries({ MediaRecorder: Recorder, document: documentMock, window: windowMock, requestAnimationFrame, cancelAnimationFrame })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  let renders = 0, destroyed = false;
  const listeners = new Set<() => void>();
  const viewer = { canvas, isDestroyed: () => destroyed, scene: { postRender: { addEventListener(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback); } }, requestRender: () => { renders++; for (const callback of listeners) callback(); } } } as unknown as Viewer;
  const begin = async (session: SceneVideoRecorder, options: SceneVideoStartOptions = {}) => { const pending = session.start(options); Recorder.instances.at(-1)!.data(new Blob(['header'])); await pending; };
  return { viewer, canvas, tracks, buffers, listeners, Recorder, documentMock, windowMock, begin, renders: () => renders, destroyViewer: () => { destroyed = true; } };
}

test('idle owns no render timer; actual stream finishes final chunks and releases the shared canvas', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = browser(t), states: string[] = [], completed: Blob[] = [];
  const session = new SceneVideoRecorder(env.viewer, { onStateChange: state => states.push(state.state), onComplete: result => completed.push(result.blob) });
  t.after(() => session.destroy()); t.mock.timers.tick(2000);
  assert.equal(env.renders(), 0); assert.equal(env.canvas.captures, 0);
  await env.begin(session, { fileName: '机械姿态', maxDurationSeconds: 5 });
  const second = new SceneVideoRecorder(env.viewer); t.after(() => second.destroy());
  assert.throws(() => second.start(), /正在录制其他/);
  env.Recorder.instances[0].data(); t.mock.timers.tick(500);
  assert.ok(env.renders() > 1);
  const result = await session.stop();
  assert.ok(result); assert.equal(await result.blob.text(), 'headerframeframe-final');
  assert.equal(result.mimeType, 'video/webm;codecs=vp8'); assert.equal(result.fileName, '机械姿态.webm');
  assert.equal(result.width, 640); assert.equal(result.height, 480); assert.equal(completed.length, 1);
  assert.equal(env.tracks[0].stops, 1); assert.equal(states.at(-1), 'complete');
  assert.equal(env.listeners.size, 0); assert.deepEqual([env.buffers[0].width, env.buffers[0].height], [1, 1]);
  const renders = env.renders(); t.mock.timers.tick(30000); assert.equal(env.renders(), renders);
  second.start(); second.cancel(); assert.equal(env.tracks[1].stops, 1);
});

test('cancel, canvas loss, background, resize and viewer destruction release tracks without a partial result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = browser(t), session = new SceneVideoRecorder(env.viewer); t.after(() => session.destroy());
  session.start(); const pending = session.stop(); session.cancel('切换项目');
  assert.equal(await pending, undefined); assert.equal(session.snapshot.state, 'cancelled');
  session.start(); env.canvas.dispatchEvent(new Event('webglcontextlost'));
  assert.equal(session.snapshot.state, 'error'); assert.match(session.snapshot.message, /上下文/);
  session.start(); env.documentMock.hidden = true; env.documentMock.dispatchEvent(new Event('visibilitychange'));
  assert.equal(session.snapshot.state, 'error'); env.documentMock.hidden = false;
  session.start(); env.canvas.width++; t.mock.timers.tick(50); assert.match(session.snapshot.message, /画幅/);
  session.start(); env.destroyViewer(); t.mock.timers.tick(50); assert.match(session.snapshot.message, /关闭/);
  assert.equal(session.result, undefined); assert.ok(env.tracks.every(track => track.stops === 1));
  assert.equal(env.listeners.size, 0); assert.ok(env.buffers.every(buffer => buffer.width === 1 && buffer.height === 1));
  const renders = env.renders(); t.mock.timers.tick(50000); assert.equal(env.renders(), renders);
});

test('time and soft memory limits complete usable output; the hard memory cap discards oversized encoding', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = browser(t), session = new SceneVideoRecorder(env.viewer); t.after(() => session.destroy());
  await env.begin(session, { maxDurationSeconds: 1 }); t.mock.timers.tick(1000);
  assert.equal(session.snapshot.state, 'stopping'); assert.ok(await session.stop());
  await env.begin(session, { maxBytes: 1024 * 1024 }); env.Recorder.instances.at(-1)!.data(new Blob([new Uint8Array(600_000)]));
  assert.equal(session.snapshot.state, 'stopping'); assert.ok(await session.stop());
  await env.begin(session, { maxBytes: 1024 * 1024 }); env.Recorder.instances.at(-1)!.data(new Blob([new Uint8Array(1_048_577)]));
  assert.equal(session.snapshot.state, 'error'); assert.equal(session.result, undefined);
  assert.ok(env.tracks.every(track => track.stops === 1));
});

test('format is the real encoder container, unsupported MP4 does not masquerade as WebM', async t => {
  const env = browser(t), session = new SceneVideoRecorder(env.viewer); t.after(() => session.destroy());
  assert.deepEqual(supportedSceneVideoFormats(), ['webm']);
  await assert.rejects(session.start({ format: 'mp4' }), /请选择 WebM/); assert.equal(env.tracks[0].stops, 1);
  env.Recorder.mp4 = true; await env.begin(session, { format: 'mp4', fileName: 'scene.webm' });
  const result = await session.stop(); assert.ok(result); assert.match(result.mimeType, /^video\/mp4/); assert.equal(result.fileName, 'scene.mp4');
});

test('broken observers, codec errors and repeated destruction cannot retain resources', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = browser(t), session = new SceneVideoRecorder(env.viewer, { onStateChange: () => { throw new Error('observer'); }, onComplete: () => { throw new Error('observer'); } });
  session.start(); env.Recorder.instances[0].dispatchEvent(new Event('error'));
  assert.equal(session.snapshot.state, 'error'); await env.begin(session); assert.ok(await session.stop());
  session.destroy(); session.destroy(); assert.throws(() => session.start(), /已销毁/);
  const renders = env.renders(); t.mock.timers.tick(30000); assert.equal(env.renders(), renders);
  assert.ok(env.tracks.every(track => track.stops === 1));
});

test('first frame preparation and encoder acknowledgement precede the chosen recording duration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = browser(t), session = new SceneVideoRecorder(env.viewer); t.after(() => session.destroy());
  const started = session.start({ maxDurationSeconds: 1 });
  assert.equal(session.snapshot.state, 'starting');
  t.mock.timers.tick(6000); // A slow first GPU readback must not consume a short recording.
  assert.equal(session.snapshot.state, 'starting'); assert.equal(session.snapshot.elapsedSeconds, 0);
  env.Recorder.instances[0].data(new Blob()); assert.equal(session.snapshot.state, 'starting');
  env.Recorder.instances[0].data(new Blob(['encoded-first-frame'])); await started;
  assert.equal(session.snapshot.state, 'recording');
  t.mock.timers.tick(999); assert.equal(session.snapshot.state, 'recording');
  const beforeStop = env.tracks[0].requests;
  t.mock.timers.tick(1); assert.equal(session.snapshot.state, 'stopping');
  assert.ok(env.tracks[0].requests > beforeStop, 'Final postRender bypasses the regular frame-rate throttle');
  assert.equal(env.Recorder.instances[0].stops, 0, 'Encoder remains alive through compositor frame opportunities');
  assert.ok(await session.stop()); assert.equal(env.listeners.size, 0);
});

test('startup timeout, early cancellation and missing final frames release every pending resource', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = browser(t), session = new SceneVideoRecorder(env.viewer); t.after(() => session.destroy());
  const timeout = session.start(); t.mock.timers.tick(20_000);
  await assert.rejects(timeout, /20 秒/); assert.equal(env.listeners.size, 0);
  const cancelled = session.start(); session.cancel('切换项目');
  await assert.rejects(cancelled, /切换项目/); assert.equal(env.listeners.size, 0);
  await env.begin(session); env.listeners.clear(); const stop = session.stop();
  t.mock.timers.tick(8000); assert.equal(await stop, undefined); assert.equal(session.snapshot.state, 'error');
  assert.ok(env.tracks.every(track => track.stops === 1));
  const renders = env.renders(); t.mock.timers.tick(60_000); assert.equal(env.renders(), renders);
});

test('a muxer that defers timeslices is flushed after a real frame, only while waiting for startup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; t.mock.method(performance, 'now', () => now);
  const env = browser(t), session = new SceneVideoRecorder(env.viewer); t.after(() => session.destroy());
  env.Recorder.mp4 = true; env.Recorder.flushFirstFrame = true;
  const started = session.start({ format: 'mp4', maxDurationSeconds: 2 }), encoder = env.Recorder.instances[0];
  assert.ok(env.tracks[0].requests > 0); assert.equal(encoder.flushes, 0);
  now = 249; t.mock.timers.tick(249); assert.equal(encoder.flushes, 0);
  now = 300; t.mock.timers.tick(51); await started;
  assert.equal(encoder.flushes, 1); assert.equal(session.snapshot.state, 'recording');
  now = 1000; t.mock.timers.tick(700); assert.equal(encoder.flushes, 1, 'Recording does not keep forcing muxer flushes');
  session.cancel(); now = 60_000; t.mock.timers.tick(59_000); assert.equal(encoder.flushes, 1);
  assert.equal(env.listeners.size, 0); assert.equal(env.tracks[0].stops, 1);
});
