import type { Viewer } from 'cesium';
import { addVideoOverlayWebmDuration, videoOverlayExportFileName } from './videoOverlayExport';

export type SceneVideoFormat = 'webm' | 'mp4';
export type SceneVideoRecorderState = 'idle' | 'starting' | 'recording' | 'stopping' | 'complete' | 'cancelled' | 'error';
export type SceneVideoRecorderSnapshot = {
  state: SceneVideoRecorderState; elapsedSeconds: number; bytes: number; mimeType: string; message: string;
};
export type SceneVideoResult = {
  blob: Blob; fileName: string; mimeType: string; width: number; height: number; durationSeconds: number;
};
export type SceneVideoStartOptions = {
  format?: SceneVideoFormat; fileName?: string; frameRate?: number; maxDurationSeconds?: number; maxBytes?: number;
};
export type SceneVideoRecorderOptions = {
  onStateChange?: (snapshot: SceneVideoRecorderSnapshot) => void;
  onComplete?: (result: SceneVideoResult) => void;
};
export const SCENE_VIDEO_LIMITS = Object.freeze({ maxDurationSeconds: 120, maxBytes: 128 * 1024 * 1024, maxPixels: 3840 * 2160 });
const owners = new WeakMap<HTMLCanvasElement, SceneVideoRecorder>();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const mimeCandidates = (format: SceneVideoFormat) => format === 'mp4'
  ? ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4']
  : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];

export function supportedSceneVideoFormats(): SceneVideoFormat[] {
  if (typeof MediaRecorder === 'undefined') return [];
  return (['webm', 'mp4'] as const).filter(format => mimeCandidates(format).some(mime => MediaRecorder.isTypeSupported(mime)));
}

/** Captures the existing Viewer. A bounded 2D encoder buffer holds postRender pixels; it never renders a second scene. */
export class SceneVideoRecorder {
  private current: SceneVideoRecorderSnapshot = { state: 'idle', elapsedSeconds: 0, bytes: 0, mimeType: '', message: '' };
  private encoder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private removers: Array<() => void> = [];
  private renderTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopDeadline?: ReturnType<typeof setTimeout>;
  private startupDeadline?: ReturnType<typeof setTimeout>;
  private finalFrameOne?: number;
  private finalFrameTwo?: number;
  private pendingStopFrame = false;
  private encoderStartedAt = 0;
  private resolveStarted?: () => void;
  private rejectStarted?: (error: Error) => void;
  private startedAt = 0;
  private width = 0;
  private height = 0;
  private maxBytes = SCENE_VIDEO_LIMITS.maxBytes;
  private softBytes = SCENE_VIDEO_LIMITS.maxBytes;
  private fileName = '';
  private generation = 0;
  private destroyed = false;
  private done?: Promise<SceneVideoResult | undefined>;
  private resolve?: (result: SceneVideoResult | undefined) => void;
  private lastResult?: SceneVideoResult;
  private readonly canvas: HTMLCanvasElement;
  private capturedFrames = 0;
  private captureCanvas?: HTMLCanvasElement;

  constructor(private readonly viewer: Viewer, private readonly options: SceneVideoRecorderOptions = {}) { this.canvas = viewer.canvas; }

  get snapshot(): SceneVideoRecorderSnapshot { return { ...this.current }; }
  get active(): boolean { return this.current.state === 'starting' || this.current.state === 'recording' || this.current.state === 'stopping'; }
  get result(): SceneVideoResult | undefined { return this.lastResult; }

  start(options: SceneVideoStartOptions = {}): Promise<void> {
    if (this.destroyed) throw new Error('录像组件已销毁');
    if (this.active) throw new Error('当前录像尚未结束');
    const canvas = this.canvas;
    if (owners.has(canvas)) throw new Error('当前场景正在录制其他视频，请先停止该录像');
    const format = options.format ?? 'webm', frameRate = options.frameRate ?? 24;
    const duration = options.maxDurationSeconds ?? 30, maxBytes = options.maxBytes ?? SCENE_VIDEO_LIMITS.maxBytes;
    this.lastResult = undefined; this.encoderStartedAt = 0;
    this.current = { state: 'idle', elapsedSeconds: 0, bytes: 0, mimeType: '', message: '' };
    try {
      if (this.viewer.isDestroyed()) throw new Error('场景已关闭，无法开始录像');
      if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') throw new Error('浏览器不支持场景录像，请使用新版 Chrome 或 Edge');
      if (document.hidden) throw new Error('请保持当前页面在前台后开始录像');
      if (!['webm', 'mp4'].includes(format)) throw new Error('不支持的视频格式');
      if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 30) throw new Error('录像帧率须为 1–30 fps');
      if (!Number.isFinite(duration) || duration < 1 || duration > SCENE_VIDEO_LIMITS.maxDurationSeconds) throw new Error('录像时长须为 1–120 秒');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > SCENE_VIDEO_LIMITS.maxBytes) throw new Error('录像大小上限须为 1–128 MiB');
      if (canvas.width < 2 || canvas.height < 2 || canvas.width * canvas.height > SCENE_VIDEO_LIMITS.maxPixels) throw new Error('场景画幅无效或超过 4K，请调整窗口大小后重试');
      owners.set(canvas, this);
      this.generation += 1; this.maxBytes = maxBytes; this.width = canvas.width; this.height = canvas.height;
      this.fileName = options.fileName ?? '场景视频';
      const bitRate = Math.round(Math.min(12_000_000, Math.max(2_000_000, this.width * this.height * 4)));
      // Stop before the hard budget to leave room for the encoder's final buffered chunk.
      this.softBytes = Math.max(maxBytes * .5, maxBytes - bitRate / 8 * 2);
      const captureCanvas = document.createElement('canvas'); this.captureCanvas = captureCanvas;
      captureCanvas.width = this.width; captureCanvas.height = this.height;
      const context = captureCanvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('无法创建场景视频编码缓冲区');
      let videoTrack: CanvasCaptureMediaStreamTrack | undefined;
      this.capturedFrames = 0;
      const started = new Promise<void>((resolve, reject) => { this.resolveStarted = resolve; this.rejectStarted = reject; });
      void started.catch(() => undefined);
      this.done = new Promise(resolve => { this.resolve = resolve; });
      let lastStartupFlush = 0;
      const beginEncoder = () => {
        // captureStream requests an initial frame even at 0 fps. Creating it
        // before priming would give the encoder a blank frame/early timestamp.
        this.stream = captureCanvas.captureStream(0);
        videoTrack = this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
        if (!videoTrack?.requestFrame) throw new Error('浏览器不支持同步场景帧录制，请使用新版 Chrome 或 Edge');
        for (const track of this.stream.getTracks()) this.listen(track, 'ended', () => this.fail('场景视频轨道已中断，请重新录制'));
        for (const mime of mimeCandidates(format)) {
          if (!MediaRecorder.isTypeSupported(mime)) continue;
          let recorder: MediaRecorder | undefined;
          try {
            recorder = new MediaRecorder(this.stream!, { mimeType: mime, videoBitsPerSecond: bitRate });
            const actualMime = recorder.mimeType || mime;
            if (!actualMime.toLowerCase().startsWith(`video/${format}`)) continue;
            recorder.start(250);
            this.encoder = recorder; this.current.mimeType = actualMime;
            break;
          } catch {
            if (recorder?.state !== 'inactive') { try { recorder?.stop(); } catch { /* Failed encoder setup. */ } }
          }
        }
        if (!this.encoder) throw new Error(`当前浏览器没有可用的 ${format.toUpperCase()} 编码器${format === 'mp4' ? '，请选择 WebM' : ''}`);
        const encoder = this.encoder;
        this.encoderStartedAt = performance.now(); lastStartupFlush = this.encoderStartedAt;
        this.listen(encoder, 'dataavailable', event => {
          if (!this.active) return;
          const blob = (event as BlobEvent).data;
          if (!blob?.size) return;
          if (this.current.bytes + blob.size > this.maxBytes) { this.fail('编码器超过录像内存上限，请缩短时长后重试'); return; }
          this.chunks.push(blob); this.current.bytes += blob.size;
          if (this.current.state === 'starting') {
            if (this.startupDeadline !== undefined) clearTimeout(this.startupDeadline);
            this.startupDeadline = undefined; this.startedAt = performance.now();
            this.current.state = 'recording'; this.current.message = '正在录制当前三维场景（无音轨）';
            this.deadline = setTimeout(() => { void this.stop('已达到所选时长，录像已结束'); }, duration * 1000);
            this.resolveStarted?.(); this.resolveStarted = undefined; this.rejectStarted = undefined;
          }
          if (this.current.state === 'recording' && this.current.bytes >= this.softBytes) void this.stop('已达到文件大小上限，录像已结束');
          else this.publish();
        });
        this.listen(encoder, 'error', () => this.fail('浏览器视频编码失败，请缩短时长或改用 WebM 重试'));
        this.listen(encoder, 'stop', () => {
          if (this.current.state !== 'stopping') { this.fail('浏览器提前中断录像，请重新录制'); return; }
          void this.finish(this.generation);
        });
      };
      let previousFrame = -Infinity;
      this.removers.push(this.viewer.scene.postRender.addEventListener(() => {
        if (!this.active || (this.current.state === 'stopping' && !this.pendingStopFrame)) return;
        const forced = this.pendingStopFrame;
        if (!forced && performance.now() - previousFrame < 1000 / frameRate - 2) return;
        try {
          // The first GPU readback can block for seconds even after scene.ready.
          // Warm the real pixels BEFORE starting the encoder/recording clock.
          context.drawImage(canvas, 0, 0);
          if (!this.capturedFrames) context.getImageData(0, 0, 1, 1);
          if (!this.encoder) beginEncoder();
          if (!this.active) return;
          videoTrack!.requestFrame(); previousFrame = performance.now(); this.capturedFrames += 1;
          if (forced) {
            this.pendingStopFrame = false; this.stopRendering();
            // Keep the final requested canvas frame alive through a compositor
            // opportunity; stop() in the same postRender task can drop it.
            this.finalFrameOne = requestAnimationFrame(() => {
              this.finalFrameOne = undefined;
              this.finalFrameTwo = requestAnimationFrame(() => {
                this.finalFrameTwo = undefined;
                if (this.current.state !== 'stopping') return;
                this.current.elapsedSeconds = (performance.now() - this.encoderStartedAt) / 1000;
                try { this.encoder!.requestData(); this.encoder!.stop(); }
                catch (error) { this.fail(errorMessage(error)); }
              });
            });
          }
        } catch (error) { this.fail(error instanceof DOMException && error.name === 'SecurityError'
          ? '场景含不允许跨域导出的图像，请使用允许跨域读取的场景资源' : errorMessage(error)); }
      }));
      this.listen(canvas, 'webglcontextlost', () => this.fail('三维场景显卡上下文已丢失，录像已取消；恢复场景后重试'));
      this.listen(document, 'visibilitychange', () => { if (document.hidden) this.fail('页面已离开前台，录像已取消；请保持页面可见'); });
      this.listen(window, 'pagehide', () => this.cancel('页面已离开，录像已取消'));
      this.current.state = 'starting'; this.current.message = '正在准备录像首帧并确认编码，请稍候…';
      this.startupDeadline = setTimeout(() => this.fail('录像首帧或编码准备超过 20 秒，请等待场景稳定后重试'), 20_000);
      this.publish();
      const tick = () => {
        if (!this.active || (this.current.state === 'stopping' && !this.pendingStopFrame)) return;
        try {
          if (this.viewer.isDestroyed()) { this.fail('三维场景已关闭，录像已取消'); return; }
          if (canvas.width !== this.width || canvas.height !== this.height) { this.fail('场景画幅已改变，录像已取消；请保持窗口大小不变后重试'); return; }
          this.viewer.scene.requestRender();
          // MP4 muxers may defer timeslice output until a distant fragment
          // boundary. Flush only while awaiting the first real submitted frame's
          // acknowledgement; otherwise that delay becomes a long static lead-in.
          if (this.current.state === 'starting' && this.encoder && this.capturedFrames > 0
            && performance.now() - lastStartupFlush >= 250) {
            lastStartupFlush = performance.now(); this.encoder.requestData();
          }
          if (this.active && (this.current.state !== 'stopping' || this.pendingStopFrame)) this.renderTimer = setTimeout(tick, 1000 / frameRate);
        } catch (error) { this.fail(errorMessage(error)); }
      };
      tick();
      return started;
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'SecurityError'
        ? '场景含不允许跨域导出的图像，请使用允许跨域读取的场景资源' : errorMessage(error);
      this.fail(message); throw new Error(message);
    }
  }

  stop(message = '正在生成视频文件…'): Promise<SceneVideoResult | undefined> {
    if (this.current.state === 'starting') { this.cancel('录像尚未开始，已取消首帧准备'); return Promise.resolve(undefined); }
    if (this.current.state === 'stopping') return this.done ?? Promise.resolve(undefined);
    if (this.current.state !== 'recording') return Promise.resolve(this.lastResult);
    this.current.elapsedSeconds = (performance.now() - this.startedAt) / 1000;
    this.current.state = 'stopping'; this.current.message = message; this.pendingStopFrame = true;
    if (this.deadline !== undefined) clearTimeout(this.deadline); this.deadline = undefined; this.publish();
    const done = this.done;
    if (this.current.state !== 'stopping') return done ?? Promise.resolve(undefined);
    this.stopDeadline = setTimeout(() => this.fail('浏览器生成视频超时，请缩短时长后重试'), 8000);
    try { this.viewer.scene.requestRender(); } catch (error) { this.fail(errorMessage(error)); }
    return done ?? Promise.resolve(undefined);
  }

  cancel(message = '录像已取消，未生成视频'): void {
    this.lastResult = undefined;
    if (!this.active) { this.done = undefined; return; }
    this.current.elapsedSeconds = this.current.state === 'starting' ? 0 : (performance.now() - this.startedAt) / 1000;
    this.rejectStarted?.(new Error(message)); this.resolveStarted = undefined; this.rejectStarted = undefined;
    this.current.state = 'cancelled'; this.current.message = message;
    this.cleanup(); this.publish(); this.resolve?.(undefined); this.resolve = undefined; this.done = undefined;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.cancel('录像组件已关闭，录像已取消'); this.lastResult = undefined;
  }

  private async finish(generation: number): Promise<void> {
    if (!this.current.bytes) { this.fail('浏览器未生成视频数据，请等待场景加载后重试'); return; }
    try {
      const blob = await addVideoOverlayWebmDuration(new Blob(this.chunks, { type: this.current.mimeType }), this.current.elapsedSeconds);
      if (generation !== this.generation || this.current.state !== 'stopping') return;
      if (blob.size > this.maxBytes) { this.fail('视频文件超过大小上限，请缩短时长重试'); return; }
      const result = { blob, fileName: videoOverlayExportFileName(this.fileName, this.current.mimeType), mimeType: this.current.mimeType,
        width: this.width, height: this.height, durationSeconds: this.current.elapsedSeconds };
      this.lastResult = result; this.current.bytes = blob.size; this.current.state = 'complete'; this.current.message = '录像完成，可下载视频';
      this.cleanup(); this.publish(); this.resolve?.(result); this.resolve = undefined; this.done = undefined;
      try { this.options.onComplete?.(result); } catch { /* Caller errors must not retain capture resources. */ }
    } catch (error) { if (generation === this.generation) this.fail(errorMessage(error)); }
  }

  private listen(target: EventTarget, type: string, callback: EventListener): void {
    target.addEventListener(type, callback); this.removers.push(() => target.removeEventListener(type, callback));
  }
  private publish(): void {
    if (this.current.state === 'recording') this.current.elapsedSeconds = (performance.now() - this.startedAt) / 1000;
    try { this.options.onStateChange?.(this.snapshot); } catch { /* Observers do not own the recording lifecycle. */ }
  }
  private stopRendering(): void {
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.renderTimer = this.deadline = undefined;
  }
  private cleanup(): void {
    this.generation += 1; this.stopRendering(); this.pendingStopFrame = false;
    if (this.startupDeadline !== undefined) clearTimeout(this.startupDeadline);
    this.startupDeadline = undefined;
    if (this.finalFrameOne !== undefined) cancelAnimationFrame(this.finalFrameOne);
    if (this.finalFrameTwo !== undefined) cancelAnimationFrame(this.finalFrameTwo);
    this.finalFrameOne = this.finalFrameTwo = undefined;
    if (this.stopDeadline !== undefined) clearTimeout(this.stopDeadline);
    this.stopDeadline = undefined;
    for (const remove of this.removers.splice(0)) remove();
    if (this.encoder?.state !== 'inactive') { try { this.encoder?.stop(); } catch { /* Already stopped or failed. */ } }
    this.encoder = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined; this.chunks = [];
    if (this.captureCanvas) this.captureCanvas.width = this.captureCanvas.height = 1;
    this.captureCanvas = undefined;
    if (owners.get(this.canvas) === this) owners.delete(this.canvas);
  }
  private fail(message: string): void {
    this.rejectStarted?.(new Error(message)); this.resolveStarted = undefined; this.rejectStarted = undefined;
    if (this.current.state === 'recording') this.current.elapsedSeconds = (performance.now() - this.startedAt) / 1000;
    this.current.state = 'error'; this.current.message = message; this.lastResult = undefined;
    this.cleanup(); this.publish(); this.resolve?.(undefined); this.resolve = undefined; this.done = undefined;
  }
}

export function downloadSceneVideo(result: SceneVideoResult): void {
  const url = URL.createObjectURL(result.blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = result.fileName; anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}
