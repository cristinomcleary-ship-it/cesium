/** Real-time recording of frames already synchronized by VideoModelOverlay. */
export type VideoOverlayExportResolution = '1080p' | '720p' | 'source';
export type VideoOverlayExportAudioStatus = 'captured' | 'silent-no-audio' | 'silent-unavailable' | 'silent-requested';
export type VideoOverlayExportState = 'waiting' | 'recording' | 'paused' | 'finishing' | 'complete' | 'cancelled' | 'error';
export type VideoOverlayExportProgress = {
  state: VideoOverlayExportState; fraction: number; mediaTime: number; bytes: number;
  frames: number; mimeType: string; silent: boolean; audioStatus: VideoOverlayExportAudioStatus;
};
export type VideoOverlayExportResult = {
  blob: Blob; fileName: string; mimeType: string; silent: boolean;
  audioStatus: VideoOverlayExportAudioStatus; width: number; height: number;
  /** Requested source-video interval, in seconds. MediaRecorder is real-time, not frame-exact. */
  duration: number; recordedDuration: number; frames: number;
};
export type VideoOverlayExportOptions = {
  video: HTMLVideoElement;
  overlayCanvas: HTMLCanvasElement;
  range: { start: number; end: number };
  resolution?: VideoOverlayExportResolution;
  /** Maximum committed frame rate; MediaRecorder output remains variable-rate. */
  frameRate?: number;
  /** A human-readable stem, without an extension. */
  fileName?: string;
  includeAudio?: boolean;
  /** Useful when an installation's MP4 encoder is unavailable despite advertised support. */
  format?: 'auto' | 'webm';
  maxBytes?: number;
  maxWallTimeSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (progress: VideoOverlayExportProgress) => void;
};

export const VIDEO_OVERLAY_EXPORT_LIMITS = Object.freeze({
  maxBytes: 512 * 1024 * 1024, maxDuration: 30 * 60, maxPixels: 3840 * 2160,
});
type ExportPlan = {
  start: number; end: number; duration: number; width: number; height: number;
  frameRate: number; videoBitsPerSecond: number; maxBytes: number; maxWallTimeSeconds: number;
};
type CaptureVideo = HTMLVideoElement & { captureStream?: () => MediaStream };
type RequestedFrameTrack = MediaStreamTrack & { requestFrame?: () => void };

export function planVideoOverlayExport(options: VideoOverlayExportOptions): ExportPlan {
  const { video, range } = options;
  if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth < 2 || video.videoHeight < 2) {
    throw new Error('请先加载可播放的视频，再导出融合视频');
  }
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)
    || range.start < 0 || range.end <= range.start || range.end > video.duration + .001) {
    throw new Error('导出时间范围无效，结束时间须晚于开始时间且不超过视频时长');
  }
  const end = Math.min(range.end, video.duration), duration = end - range.start;
  if (duration > VIDEO_OVERLAY_EXPORT_LIMITS.maxDuration) throw new Error('一次最多实时导出 30 分钟，请缩短时间范围');
  const frameRate = options.frameRate ?? 30;
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 60) throw new Error('导出帧率须在 1–60 fps 之间');
  const resolution = options.resolution ?? '1080p';
  if (!['1080p', '720p', 'source'].includes(resolution)) throw new Error('导出分辨率无效');
  const landscape = video.videoWidth >= video.videoHeight;
  const maximum = resolution === '720p' ? [1280, 720] : resolution === '1080p' ? [1920, 1080] : [video.videoWidth, video.videoHeight];
  if (!landscape && resolution !== 'source') maximum.reverse();
  const scale = Math.min(1, maximum[0] / video.videoWidth, maximum[1] / video.videoHeight);
  // Even dimensions are accepted by H.264 and avoid padding/encoder-specific failures.
  const width = Math.max(2, Math.floor(video.videoWidth * scale / 2) * 2);
  const height = Math.max(2, Math.floor(video.videoHeight * scale / 2) * 2);
  if (width * height > VIDEO_OVERLAY_EXPORT_LIMITS.maxPixels) throw new Error('原始画幅超过 4K 导出上限，请选择 1080p 或 720p');
  const maxBytes = options.maxBytes ?? VIDEO_OVERLAY_EXPORT_LIMITS.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > VIDEO_OVERLAY_EXPORT_LIMITS.maxBytes) {
    throw new Error('导出大小上限须在 1–512 MiB 之间');
  }
  const videoBitsPerSecond = Math.round(Math.min(12_000_000, Math.max(1_500_000, 6_000_000 * width * height / (1920 * 1080))));
  const estimatedBytes = duration * (videoBitsPerSecond + (options.includeAudio === false ? 0 : 128_000)) / 8;
  if (estimatedBytes > maxBytes * .85) throw new Error('所选范围预计超过导出大小上限，请缩短范围或降低分辨率');
  const maxWallTimeSeconds = options.maxWallTimeSeconds ?? Math.min(3600, duration * 3 + 60);
  if (!Number.isFinite(maxWallTimeSeconds) || maxWallTimeSeconds < duration || maxWallTimeSeconds > 3600) {
    throw new Error('导出等待上限须不短于所选时长，且不超过一小时');
  }
  return { start: range.start, end, duration, width, height, frameRate, videoBitsPerSecond, maxBytes, maxWallTimeSeconds };
}

/** Explicit H.264 candidates; a generic MP4 container does not prove its codec. */
export function videoOverlayExportMimeTypes(audio: boolean, format: 'auto' | 'webm' = 'auto'): string[] {
  const audioMp4 = audio ? ',mp4a.40.2' : '', audioWebm = audio ? ',opus' : '';
  const mp4 = ['avc1.640033', 'avc1.42E028', 'avc1'].map(codec => `video/mp4;codecs=${codec}${audioMp4}`);
  return [...(format === 'webm' ? [] : mp4), `video/webm;codecs=vp9${audioWebm}`, `video/webm;codecs=vp8${audioWebm}`, 'video/webm'];
}
export function videoOverlayExportFileName(stem: string, mimeType: string): string {
  const extension = mimeType.toLowerCase().startsWith('video/mp4') ? 'mp4' : mimeType.toLowerCase().startsWith('video/webm') ? 'webm' : undefined;
  if (!extension) throw new Error('浏览器返回了不支持的导出格式');
  const clean = stem.replace(/\.(mp4|webm)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120);
  return `${clean || 'AR融合视频'}.${extension}`;
}

/**
 * Chromium's streaming WebM omits Duration. Add it to its initial Segment Info
 * without loading/copying the video payload into an ArrayBuffer. Other layouts
 * are returned unchanged, never guessed at or rewritten as if they were WebM.
 */
export async function addVideoOverlayWebmDuration(blob: Blob, seconds: number): Promise<Blob> {
  if (!blob.type.toLowerCase().startsWith('video/webm') || !Number.isFinite(seconds) || seconds <= 0) return blob;
  const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const vint = (offset: number, id = false) => {
    const first = bytes[offset]; if (!first) return undefined;
    let width = 1; while (width <= 8 && !(first & (1 << (8 - width)))) width += 1;
    if (width > (id ? 4 : 8) || offset + width > bytes.length) return undefined;
    let value = BigInt(id ? first : first & ((1 << (8 - width)) - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
    return { width, value: Number(value), unknown: !id && value === (1n << BigInt(7 * width)) - 1n };
  };
  const element = (offset: number) => {
    const id = vint(offset, true); if (!id) return undefined;
    const size = vint(offset + id.width); if (!size) return undefined;
    return { id: id.value, size: size.value, sizeWidth: size.width, sizeOffset: offset + id.width,
      data: offset + id.width + size.width, unknown: size.unknown };
  };
  const ebml = element(0); if (ebml?.id !== 0x1a45dfa3 || ebml.unknown) return blob;
  const segment = element(ebml.data + ebml.size);
  if (segment?.id !== 0x18538067 || !segment.unknown) return blob;
  const info = element(segment.data);
  if (info?.id !== 0x1549a966 || info.unknown || info.data + info.size > bytes.length) return blob;
  let scale = 1_000_000;
  for (let offset = info.data; offset < info.data + info.size;) {
    const child = element(offset); if (!child || child.unknown || child.data + child.size > info.data + info.size) return blob;
    if (child.id === 0x4489) return blob;
    if (child.id === 0x2ad7b1) {
      scale = 0; for (let i = 0; i < child.size; i++) scale = scale * 256 + bytes[child.data + i];
    }
    offset = child.data + child.size;
  }
  if (!Number.isFinite(scale) || scale <= 0) return blob;
  // Refuse indexed layouts because adding header bytes would move their offsets.
  for (let offset = info.data + info.size; offset < bytes.length;) {
    const next = element(offset); if (!next) return blob;
    if (next.id === 0x1f43b675) break;
    if (next.id === 0x114d9b74 || next.id === 0x1c53bb6b || next.unknown || next.data + next.size > bytes.length) return blob;
    offset = next.data + next.size;
  }
  const duration = new Uint8Array(11); duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, seconds * 1_000_000_000 / scale, false);
  const newSize = info.size + duration.length;
  if (BigInt(newSize) >= (1n << BigInt(7 * info.sizeWidth)) - 1n) return blob;
  const sizeBytes = new Uint8Array(info.sizeWidth);
  let encoded = BigInt(newSize) | (1n << BigInt(7 * info.sizeWidth));
  for (let i = sizeBytes.length - 1; i >= 0; i--) { sizeBytes[i] = Number(encoded & 255n); encoded >>= 8n; }
  return new Blob([blob.slice(0, info.sizeOffset), sizeBytes, blob.slice(info.data, info.data + info.size), duration, blob.slice(info.data + info.size)], { type: blob.type });
}

/**
 * The controller owns seeking, playback, buffering and restoration. Only call
 * commitFrame after its matching Cesium postRender has completed. Passing the
 * controller's held video frame avoids copying a newer decoded frame by mistake.
 * No RAF/timer here independently samples the video or the WebGL canvas.
 */
export class VideoOverlayExportSession {
  readonly done: Promise<VideoOverlayExportResult>;
  readonly plan: ExportPlan;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly stream: MediaStream;
  private readonly videoTrack: RequestedFrameTrack;
  private readonly tracks = new Set<MediaStreamTrack>();
  private readonly removers: Array<() => void> = [];
  private readonly chunks: Blob[] = [];
  private recorder?: MediaRecorder;
  private recorderRemovers: Array<() => void> = [];
  private resolve!: (result: VideoOverlayExportResult) => void;
  private reject!: (error: Error) => void;
  private state: VideoOverlayExportState = 'waiting';
  private audioStatus: VideoOverlayExportAudioStatus = 'silent-unavailable';
  private mimeType = '';
  private bytes = 0;
  private frames = 0;
  private lastMediaTime: number;
  private firstMediaTime?: number;
  private paused = false;
  private startedAt?: number;
  private pauseStarted?: number;
  private pauseMilliseconds = 0;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private cleaned = false;
  private readonly options: VideoOverlayExportOptions;

  constructor(options: VideoOverlayExportOptions) {
    this.options = options;
    this.plan = planVideoOverlayExport(options);
    this.lastMediaTime = this.plan.start;
    if (options.signal?.aborted) throw new DOMException('已取消视频导出', 'AbortError');
    if (typeof MediaRecorder === 'undefined' || typeof MediaStream === 'undefined') throw new Error('浏览器不支持视频录制，请使用新版 Chromium/Chrome/Edge');
    if (document.hidden) throw new Error('请保持当前标签页在前台后开始导出');
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.plan.width; this.canvas.height = this.plan.height;
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法创建视频合成画布');
    this.context = context;
    let stream: MediaStream | undefined;
    try {
      if (typeof this.canvas.captureStream !== 'function') throw new Error('浏览器不支持同步画布录制，请使用新版 Chromium/Chrome/Edge');
      stream = this.canvas.captureStream(0);
      for (const track of stream.getTracks()) this.tracks.add(track);
      const videoTrack = stream.getVideoTracks()[0] as RequestedFrameTrack | undefined;
      if (!videoTrack?.requestFrame) throw new Error('浏览器缺少逐帧录制接口，无法保证视频与工程叠加同步');
      this.stream = stream; this.videoTrack = videoTrack;
      this.captureAudio();
    } catch (error) {
      for (const track of this.tracks) track.stop();
      this.canvas.width = this.canvas.height = 1;
      throw error;
    }
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // A caller may await done only after driving playback; cancellation must not
    // produce an unhandled rejection while the controller is restoring its view.
    void this.done.catch(() => undefined);
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.fail(new Error('标签页已离开前台，已停止导出；请保持当前页可见后重试'));
    });
    if (options.signal) this.listen(options.signal, 'abort', () => this.cancel());
    this.deadline = setTimeout(() => this.fail(new Error('视频导出等待超时，请缩短范围或在场景加载完成后重试')), this.plan.maxWallTimeSeconds * 1000);
    this.progress();
  }

  private listen(target: EventTarget, type: string, callback: EventListener) {
    target.addEventListener(type, callback); this.removers.push(() => target.removeEventListener(type, callback));
  }
  private captureAudio() {
    if (this.options.includeAudio === false) { this.audioStatus = 'silent-requested'; return; }
    const capture = (this.options.video as CaptureVideo).captureStream;
    if (!capture) return;
    try {
      const source = capture.call(this.options.video);
      const audio = source.getAudioTracks().filter(track => track.readyState === 'live');
      for (const track of source.getTracks()) this.tracks.add(track);
      for (const track of audio) this.stream.addTrack(track);
      // The unused video track belongs to this helper's capture, not the media element.
      for (const track of source.getVideoTracks()) track.stop();
      this.audioStatus = audio.length ? 'captured' : 'silent-no-audio';
    } catch { this.audioStatus = 'silent-unavailable'; }
  }
  private progress() {
    // Observers must not strand a recorder/stream when rendering a progress UI fails.
    try { this.options.onProgress?.({
      state: this.state, fraction: this.state === 'complete' ? 1 : Math.max(0, Math.min(1, (this.lastMediaTime - this.plan.start) / this.plan.duration)),
      mediaTime: this.lastMediaTime, bytes: this.bytes, frames: this.frames, mimeType: this.mimeType,
      silent: this.audioStatus !== 'captured', audioStatus: this.audioStatus,
    }); } catch { /* Progress notification does not own recording lifecycle. */ }
  }
  private attachRecorder(recorder: MediaRecorder) {
    const data = (event: Event) => {
      const blob = (event as BlobEvent).data;
      if (this.cleaned || !blob?.size) return;
      if (this.bytes + blob.size > this.plan.maxBytes) { this.fail(new Error('导出文件达到大小上限，已停止录制；请缩短范围或降低分辨率')); return; }
      this.chunks.push(blob); this.bytes += blob.size; this.progress();
    };
    const error = () => this.fail(new Error('浏览器视频编码失败，请缩短范围、降低分辨率或改用 WebM 后重试'));
    const stop = () => {
      if (this.cleaned) return;
      if (!this.stopping) { this.fail(new Error('浏览器提前停止录制，未生成完整的视频；请重试')); return; }
      if (!this.bytes) { this.fail(new Error('浏览器未生成有效视频数据')); return; }
      const actualMime = recorder.mimeType || this.mimeType;
      let fileName: string;
      try { fileName = videoOverlayExportFileName(this.options.fileName ?? 'AR融合视频', actualMime); }
      catch (cause) { this.fail(cause instanceof Error ? cause : new Error(String(cause))); return; }
      const now = performance.now();
      const pausedFor = this.pauseMilliseconds + (this.pauseStarted === undefined ? 0 : now - this.pauseStarted);
      const result: VideoOverlayExportResult = {
        blob: new Blob(this.chunks, { type: actualMime }), fileName, mimeType: actualMime,
        silent: this.audioStatus !== 'captured', audioStatus: this.audioStatus,
        width: this.plan.width, height: this.plan.height, duration: this.plan.duration,
        recordedDuration: Math.max(0, (now - (this.startedAt ?? now) - pausedFor) / 1000), frames: this.frames,
      };
      void addVideoOverlayWebmDuration(result.blob, result.recordedDuration).then(blob => {
        if (this.cleaned) return;
        if (blob.size > this.plan.maxBytes) { this.fail(new Error('导出文件达到大小上限，请缩短范围或降低分辨率')); return; }
        result.blob = blob; this.bytes = blob.size;
        this.state = 'complete'; this.cleanup(); this.progress(); this.resolve(result);
      }, () => this.fail(new Error('无法完成视频文件，请重试')));
    };
    for (const [type, callback] of [['dataavailable', data], ['error', error], ['stop', stop]] as const) {
      recorder.addEventListener(type, callback); this.recorderRemovers.push(() => recorder.removeEventListener(type, callback));
    }
  }
  private begin(): boolean {
    for (const mimeType of videoOverlayExportMimeTypes(this.audioStatus === 'captured', this.options.format)) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      let recorder: MediaRecorder | undefined;
      try {
        recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: this.plan.videoBitsPerSecond, audioBitsPerSecond: 128_000 });
        this.recorder = recorder; this.mimeType = recorder.mimeType || mimeType; this.attachRecorder(recorder);
        recorder.start(1000); this.startedAt = performance.now(); this.state = 'recording';
        return true;
      } catch {
        for (const remove of this.recorderRemovers.splice(0)) remove();
        if (recorder?.state !== 'inactive') { try { recorder?.stop(); } catch { /* A rejected encoder has no active session. */ } }
        this.recorder = undefined;
      }
    }
    this.fail(new Error('浏览器没有可用的 MP4/H.264 或 WebM 编码器，请使用新版 Chromium/Chrome/Edge'));
    return false;
  }

  /** Returns true only when a new, synchronized frame was handed to the recorder. */
  commitFrame(mediaTime: number, videoFrame: CanvasImageSource = this.options.video, overlayFrame: CanvasImageSource = this.options.overlayCanvas): boolean {
    if (this.cleaned || this.stopping || this.paused) return false;
    const tolerance = Math.max(.12, 2 / this.plan.frameRate);
    if (!Number.isFinite(mediaTime)) { this.fail(new Error('导出帧时间无效')); return false; }
    if (mediaTime < this.plan.start - .001) return false;
    if (mediaTime > this.plan.end + .001) { void this.finish(); return false; }
    if (this.firstMediaTime === undefined && mediaTime > this.plan.start + tolerance) { this.fail(new Error('导出未从所选起点开始，请重新定位到开始帧后重试')); return false; }
    if (this.firstMediaTime !== undefined && mediaTime < this.lastMediaTime - .001) { this.fail(new Error('导出期间视频时间倒退，已停止录制')); return false; }
    if (this.firstMediaTime !== undefined && mediaTime <= this.lastMediaTime + .000001) return false;
    if (this.firstMediaTime !== undefined && mediaTime < this.plan.end - .001
      && mediaTime - this.lastMediaTime < 1 / this.plan.frameRate - .001) return false;
    if (this.options.video.playbackRate !== 1) { this.fail(new Error('实时导出须使用 1× 播放速度')); return false; }
    try {
      const { width, height } = this.plan;
      this.context.globalAlpha = 1; this.context.globalCompositeOperation = 'source-over';
      this.context.fillStyle = '#000'; this.context.fillRect(0, 0, width, height);
      this.context.drawImage(videoFrame, 0, 0, width, height);
      this.context.drawImage(overlayFrame, 0, 0, width, height);
      // Check origin cleanliness once. A tainted canvas can otherwise silently
      // stop its capture track after drawImage succeeds.
      if (this.firstMediaTime === undefined) this.context.getImageData(0, 0, 1, 1);
      if (!this.recorder && !this.begin()) return false;
      this.videoTrack.requestFrame!();
      this.firstMediaTime ??= mediaTime; this.lastMediaTime = mediaTime; this.frames += 1; this.progress();
      if (mediaTime >= this.plan.end - .001) void this.finish();
      return true;
    } catch (cause) {
      const message = cause instanceof DOMException && cause.name === 'SecurityError'
        ? '视频或叠加画面不允许跨域导出，请使用本地视频及允许跨域读取的模型资源'
        : '无法合成当前视频帧，请等待视频与工程模型加载完成后重试';
      this.fail(new Error(message)); return false;
    }
  }

  /**
   * Pair with controller buffering: pause recording while the source video is held.
   * Captured audio follows the media element's live clock, so pause/resume both
   * together. Browser capture/encoder latency means sample-exact A/V sync is not
   * promised; commitFrame synchronizes the visual layers only.
   */
  setPaused(paused: boolean): void {
    if (this.cleaned || this.stopping || this.paused === paused) return;
    this.paused = paused;
    try {
      if (this.recorder && paused && this.recorder.state === 'recording') {
        this.recorder.pause(); this.pauseStarted = performance.now(); this.state = 'paused';
      } else if (this.recorder && !paused && this.recorder.state === 'paused') {
        this.recorder.resume();
        if (this.pauseStarted !== undefined) this.pauseMilliseconds += performance.now() - this.pauseStarted;
        this.pauseStarted = undefined; this.state = 'recording';
      }
      this.progress();
    } catch { this.fail(new Error('无法暂停或继续视频录制，请重试')); }
  }

  /** Finalizes the selected interval. Use cancel() for an incomplete recording. */
  finish(): Promise<VideoOverlayExportResult> {
    if (this.cleaned || this.stopping) return this.done;
    if (!this.recorder || !this.frames || this.lastMediaTime < this.plan.end - Math.max(.12, 2 / this.plan.frameRate)) {
      this.fail(new Error('所选时间范围尚未录制完整，未生成截短文件')); return this.done;
    }
    this.stopping = true; this.state = 'finishing'; this.progress();
    // Allow the final requested canvas frame to reach the encoder. This timer
    // never samples another frame and is cancelled on abort/cleanup.
    this.stopTimer = setTimeout(() => {
      if (this.cleaned) return;
      try { this.recorder!.stop(); } catch { this.fail(new Error('视频录制无法完成，请重试')); }
    }, Math.ceil(1000 / this.plan.frameRate));
    return this.done;
  }
  cancel(): void { this.fail(new DOMException('已取消视频导出', 'AbortError')); }
  private fail(error: Error) {
    if (this.cleaned) return;
    this.state = error.name === 'AbortError' ? 'cancelled' : 'error';
    this.cleanup(); this.progress(); this.reject(error);
  }
  private cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
    for (const remove of this.removers.splice(0)) remove();
    for (const remove of this.recorderRemovers.splice(0)) remove();
    if (this.recorder?.state !== 'inactive') { try { this.recorder?.stop(); } catch { /* Already stopped by the browser. */ } }
    for (const track of this.tracks) { try { track.stop(); } catch { /* An ended track needs no action. */ } }
    this.tracks.clear(); this.chunks.length = 0;
    this.canvas.width = this.canvas.height = 1;
  }
}

export function createVideoOverlayExport(options: VideoOverlayExportOptions): VideoOverlayExportSession {
  return new VideoOverlayExportSession(options);
}

/** The recording session itself creates no object URLs. This download owns one. */
export function downloadVideoOverlayExport(result: VideoOverlayExportResult): void {
  const url = URL.createObjectURL(result.blob), link = document.createElement('a');
  const release = () => URL.revokeObjectURL(url);
  try {
    link.href = url; link.download = result.fileName; link.hidden = true;
    document.body.append(link); link.click();
  } catch (error) { release(); throw error; }
  finally { link.remove(); }
  // Keep it alive long enough for Chromium's download to consume the Blob.
  setTimeout(release, 30_000);
}
