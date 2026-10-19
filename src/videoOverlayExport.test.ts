import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  addVideoOverlayWebmDuration, createVideoOverlayExport, planVideoOverlayExport, videoOverlayExportFileName, videoOverlayExportMimeTypes,
  type VideoOverlayExportOptions,
} from './videoOverlayExport.ts';

const options = (overrides: Partial<VideoOverlayExportOptions> = {}): VideoOverlayExportOptions => ({
  video: { duration: 20, videoWidth: 3840, videoHeight: 2160, playbackRate: 1 } as HTMLVideoElement,
  overlayCanvas: {} as HTMLCanvasElement, range: { start: 1, end: 4 }, ...overrides,
});

test('export planning preserves aspect, defaults to 1080p, and bounds dimensions, time and memory', () => {
  assert.deepEqual([planVideoOverlayExport(options()).width, planVideoOverlayExport(options()).height], [1920, 1080]);
  assert.deepEqual([planVideoOverlayExport(options({ resolution: '720p' })).width, planVideoOverlayExport(options({ resolution: '720p' })).height], [1280, 720]);
  const portrait = options({ video: { duration: 20, videoWidth: 2160, videoHeight: 3840 } as HTMLVideoElement });
  assert.deepEqual([planVideoOverlayExport(portrait).width, planVideoOverlayExport(portrait).height], [1080, 1920]);
  const small = planVideoOverlayExport(options({ video: { duration: 20, videoWidth: 641, videoHeight: 361 } as HTMLVideoElement }));
  assert.deepEqual([small.width, small.height], [640, 360]);
  assert.throws(() => planVideoOverlayExport(options({ range: { start: 4, end: 1 } })), /时间范围/);
  assert.throws(() => planVideoOverlayExport(options({ range: { start: 1, end: 21 } })), /时间范围/);
  assert.throws(() => planVideoOverlayExport(options({ maxBytes: 1024 * 1024 })), /大小上限/);
  assert.throws(() => planVideoOverlayExport(options({ frameRate: NaN })), /帧率/);
  assert.throws(() => planVideoOverlayExport(options({ video: { duration: Infinity, videoWidth: 2, videoHeight: 2 } as HTMLVideoElement })), /加载/);
  assert.throws(() => planVideoOverlayExport(options({ video: { duration: 2000, videoWidth: 640, videoHeight: 360 } as HTMLVideoElement, range: { start: 0, end: 1801 } })), /30 分钟/);
  assert.throws(() => planVideoOverlayExport(options({ video: { duration: 20, videoWidth: 7680, videoHeight: 4320 } as HTMLVideoElement, resolution: 'source' })), /4K/);
});

test('MIME candidates require explicit H.264 for MP4 and file extension follows the actual container', () => {
  assert.ok(videoOverlayExportMimeTypes(true).slice(0, 3).every(mime => mime.includes('avc1') && mime.includes('mp4a.40.2')));
  assert.ok(videoOverlayExportMimeTypes(false, 'webm').every(mime => mime.startsWith('video/webm') && !mime.includes('opus')));
  assert.equal(videoOverlayExportFileName('flight.mp4', 'video/webm;codecs=vp9'), 'flight.webm');
  assert.equal(videoOverlayExportFileName('a/b:<c>.webm', 'video/mp4;codecs=avc1'), 'a_b__c_.mp4');
  assert.throws(() => videoOverlayExportFileName('flight', 'video/unknown'), /不支持/);
});

test('streaming WebM receives finite duration metadata without changing cluster bytes or unknown formats', async () => {
  const prefix = Buffer.from('1a45dfa3801853806701ffffffffffffff1549a966872ad7b1830f4240', 'hex');
  const cluster = Buffer.from('1f43b67501ffffffffffffffe78100a3858100008000', 'hex');
  const source = new Blob([prefix, cluster], { type: 'video/webm;codecs=vp9' });
  const fixed = await addVideoOverlayWebmDuration(source, 3.025), bytes = Buffer.from(await fixed.arrayBuffer());
  assert.equal(fixed.size, source.size + 11); assert.equal(fixed.type, source.type);
  assert.equal(bytes[21], 0x92); assert.equal(bytes.readDoubleBE(prefix.length + 3), 3025);
  assert.deepEqual(bytes.subarray(prefix.length + 11), cluster);
  assert.equal(await addVideoOverlayWebmDuration(fixed, 4), fixed);
  const mp4 = new Blob([prefix, cluster], { type: 'video/mp4' });
  assert.equal(await addVideoOverlayWebmDuration(mp4, 3), mp4);
  const malformed = new Blob(['not a webm'], { type: 'video/webm' });
  assert.equal(await addVideoOverlayWebmDuration(malformed, 3), malformed);
  const indexed = new Blob([prefix, Buffer.from('114d9b7480', 'hex'), cluster], { type: 'video/webm' });
  assert.equal(await addVideoOverlayWebmDuration(indexed, 3), indexed);
});

function installBrowser(t: TestContext, withAudio = false) {
  class Track {
    readyState = 'live'; requests = 0; stops = 0; kind: string;
    constructor(kind: string) { this.kind = kind; }
    stop() { this.stops += 1; this.readyState = 'ended'; }
    requestFrame() { this.requests += 1; }
  }
  class Stream {
    tracks: Track[];
    constructor(tracks: Track[] = []) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    addTrack(track: Track) { this.tracks.push(track); }
  }
  class Recorder extends EventTarget {
    static instances: Recorder[] = [];
    static isTypeSupported(mime: string) { return mime.startsWith('video/webm;codecs=vp8'); }
    mimeType: string; state = 'inactive'; stops = 0;
    constructor(_stream: Stream, settings: MediaRecorderOptions) { super(); this.mimeType = settings.mimeType!; Recorder.instances.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive'; this.stops += 1;
      queueMicrotask(() => { this.data(new Blob(['encoded-video'])); this.dispatchEvent(new Event('stop')); });
    }
    data(blob: Blob) { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob })); }
  }
  const videoTrack = new Track('video'), sourceVideo = new Track('video'), sourceAudio = new Track('audio');
  const draws: unknown[] = [];
  const context = { fillRect() {}, drawImage(source: unknown) { draws.push(source); }, getImageData() {} };
  const canvas = { width: 0, height: 0, getContext: () => context, captureStream: () => new Stream([videoTrack]) };
  const documentMock = Object.assign(new EventTarget(), { hidden: false, createElement: () => canvas });
  for (const [name, value] of Object.entries({ document: documentMock, MediaStream: Stream, MediaRecorder: Recorder })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
  const video = { duration: 4, videoWidth: 640, videoHeight: 360, playbackRate: 1,
    captureStream: () => new Stream(withAudio ? [sourceVideo, sourceAudio] : [sourceVideo]),
  } as unknown as HTMLVideoElement;
  return { video, canvas, videoTrack, sourceVideo, sourceAudio, Recorder, documentMock, draws };
}

test('only committed paired frames are captured; buffering pauses recorder; final data survives cleanup', async t => {
  const env = installBrowser(t, true), states: string[] = [];
  const session = createVideoOverlayExport(options({ video: env.video, range: { start: 0, end: 1 },
    onProgress: progress => states.push(progress.state),
  }));
  assert.equal(env.videoTrack.requests, 0); assert.equal(env.Recorder.instances.length, 0);
  const held = {} as HTMLCanvasElement, overlay = {} as HTMLCanvasElement;
  assert.equal(session.commitFrame(0, held, overlay), true);
  assert.deepEqual(env.draws, [held, overlay]); assert.equal(env.videoTrack.requests, 1);
  assert.equal(session.commitFrame(0, held, overlay), false);
  assert.equal(session.commitFrame(.01, held, overlay), false);
  assert.equal(env.videoTrack.requests, 1);
  session.setPaused(true); assert.equal(env.Recorder.instances[0].state, 'paused');
  assert.equal(session.commitFrame(.5, held, overlay), false);
  session.setPaused(false); assert.equal(env.Recorder.instances[0].state, 'recording');
  assert.equal(session.commitFrame(1, held, overlay), true);
  const result = await session.done;
  assert.equal(await result.blob.text(), 'encoded-video'); assert.equal(result.frames, 2);
  assert.equal(result.audioStatus, 'captured'); assert.equal(result.silent, false); assert.match(result.fileName, /\.webm$/);
  assert.equal(env.videoTrack.readyState, 'ended'); assert.equal(env.sourceAudio.readyState, 'ended');
  assert.equal(env.sourceVideo.readyState, 'ended'); assert.equal(env.canvas.width, 1);
  assert.ok(states.includes('paused')); assert.equal(states.at(-1), 'complete');
  assert.equal(session.commitFrame(1), false); session.cancel();
});

test('cancel and abort discard incomplete recordings and release every owned track', async t => {
  const env = installBrowser(t, true), signal = new AbortController();
  const session = createVideoOverlayExport(options({ video: env.video, range: { start: 0, end: 1 }, signal: signal.signal }));
  session.commitFrame(0); signal.abort();
  await assert.rejects(session.done, { name: 'AbortError' });
  assert.equal(env.videoTrack.readyState, 'ended'); assert.equal(env.sourceAudio.readyState, 'ended');
  assert.equal(env.canvas.width, 1); assert.equal(env.Recorder.instances[0].state, 'inactive');
  assert.throws(() => createVideoOverlayExport(options({ video: env.video, signal: signal.signal })), { name: 'AbortError' });
});

test('incomplete intervals, background tabs, backwards clocks and oversized output fail closed', async t => {
  const env = installBrowser(t);
  const make = () => createVideoOverlayExport(options({ video: env.video, range: { start: 0, end: 3 }, maxBytes: 1024 * 1024 }));
  const incomplete = make(); incomplete.commitFrame(0); await assert.rejects(incomplete.finish(), /录制完整/);
  const background = make(); env.documentMock.hidden = true; env.documentMock.dispatchEvent(new Event('visibilitychange'));
  await assert.rejects(background.done, /前台/); env.documentMock.hidden = false;
  const backwards = make(); backwards.commitFrame(0); backwards.commitFrame(1); backwards.commitFrame(.5);
  await assert.rejects(backwards.done, /时间倒退/);
  const oversized = make(); oversized.commitFrame(0); env.Recorder.instances.at(-1)!.data(new Blob([new Uint8Array(1024 * 1024 + 1)]));
  await assert.rejects(oversized.done, /大小上限/);
});

test('failed progress observers cannot strand recording cleanup and silent status is explicit', async t => {
  const env = installBrowser(t);
  const session = createVideoOverlayExport(options({ video: env.video, range: { start: 0, end: 1 }, includeAudio: false,
    onProgress: () => { throw new Error('broken UI'); },
  }));
  session.commitFrame(0); session.commitFrame(1);
  const result = await session.done;
  assert.equal(result.audioStatus, 'silent-requested'); assert.equal(result.silent, true); assert.equal(env.videoTrack.readyState, 'ended');
});
