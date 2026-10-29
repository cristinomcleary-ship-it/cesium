import type { Viewer } from 'cesium';
import { SceneVideoRecorder, downloadSceneVideo, supportedSceneVideoFormats,
  type SceneVideoFormat, type SceneVideoResult, type SceneVideoRecorderSnapshot, type SceneVideoRecorderState } from './sceneVideoRecorder';
import './sceneVideoExportUi.css';

export type SceneVideoView = 'current' | 'preset';
export type SceneVideoExportUiOptions = {
  viewer: Viewer; host: HTMLElement; title?: string; presetLabel?: string; fileName?: () => string;
  /** Await camera/model readiness before starting; this component never moves the camera itself. */
  onPrepare?: (view: SceneVideoView, signal: AbortSignal) => void | Promise<void>;
  onStarted?: () => void;
  onFinished?: (state: SceneVideoRecorderState) => void;
  onStateChange?: (snapshot: SceneVideoRecorderSnapshot) => void;
};

/** A self-contained control for explicitly recording the supplied, already visible Cesium scene. */
export class SceneVideoExportUi {
  readonly recorder: SceneVideoRecorder;
  readonly element = document.createElement('section');
  private readonly events = new AbortController();
  private available = true;
  private unavailableReason = '';
  private preparing = false;
  private preparationAbort?: AbortController;
  private generation = 0;
  private destroyed = false;
  private result?: SceneVideoResult;
  private message = '';
  private lastState: SceneVideoRecorderState = 'idle';

  constructor(private readonly options: SceneVideoExportUiOptions) {
    this.element.className = 'scene-video-export';
    this.element.innerHTML = `<h4 data-scene-video-role="title"></h4>
      <div class="sve-settings"><label>录像视角<select data-scene-video-role="view"><option value="current">当前视角</option><option value="preset">机械预设视角</option></select></label>
      <label>视频格式<select data-scene-video-role="format"><option value="webm">WebM</option><option value="mp4">MP4（浏览器支持时）</option></select></label>
      <label>最长时长（秒）<input data-scene-video-role="duration" type="number" min="1" max="120" step="1" value="15"></label></div>
      <p class="sve-help">录下画面中的机械、地形及已显示场景。首帧与编码准备完成后开始计时；录制时保持页面可见及窗口大小不变。视频无音轨，最长 120 秒、最大 128 MiB。</p>
      <div class="sve-actions"><button type="button" data-scene-video-action="start">开始录像</button><button type="button" data-scene-video-action="stop">结束并生成视频</button><button type="button" data-scene-video-action="cancel">取消录像</button><button type="button" data-scene-video-action="download" hidden>下载视频</button></div>
      <p class="sve-status" data-scene-video-role="status" role="status" aria-live="polite"></p>`;
    this.query<HTMLElement>('title').textContent = options.title ?? '机械姿态视频（含场景）';
    const preset = this.query<HTMLSelectElement>('view').options[1];
    preset.textContent = options.presetLabel ?? '机械预设视角'; preset.hidden = !options.onPrepare;
    const supported = supportedSceneVideoFormats();
    for (const option of this.query<HTMLSelectElement>('format').options) option.disabled = !supported.includes(option.value as SceneVideoFormat);
    if (!supported.includes('webm') && supported.includes('mp4')) this.query<HTMLSelectElement>('format').value = 'mp4';
    if (!supported.length) { this.available = false; this.unavailableReason = '当前浏览器不支持场景视频编码，请使用新版 Chrome 或 Edge'; }
    this.recorder = new SceneVideoRecorder(options.viewer, {
      onStateChange: snapshot => {
        this.message = snapshot.message;
        if (snapshot.state === 'recording') this.message += ` · ${snapshot.elapsedSeconds.toFixed(1)} 秒 · ${(snapshot.bytes / 1048576).toFixed(1)} MiB`;
        if (['complete', 'cancelled', 'error'].includes(snapshot.state) && this.lastState !== snapshot.state) {
          try { options.onFinished?.(snapshot.state); } catch { /* State presentation must not strand the recorder. */ }
        }
        this.lastState = snapshot.state; this.render();
        options.onStateChange?.(snapshot);
      },
      onComplete: result => { this.result = result; this.message = `录像完成：${result.durationSeconds.toFixed(1)} 秒，${(result.blob.size / 1048576).toFixed(1)} MiB。点击下载视频。`; this.render(); },
    });
    this.element.addEventListener('click', event => {
      const action = (event.target as Element).closest<HTMLButtonElement>('[data-scene-video-action]')?.dataset.sceneVideoAction;
      if (action === 'start') void this.start();
      else if (action === 'stop') void this.recorder.stop();
      else if (action === 'cancel') this.cancel();
      else if (action === 'download' && this.result) downloadSceneVideo(this.result);
    }, { signal: this.events.signal });
    options.host.append(this.element); this.render();
  }

  setAvailable(available: boolean, reason = ''): void {
    const previousAvailable = this.available, previousReason = this.unavailableReason;
    this.available = available && supportedSceneVideoFormats().length > 0;
    this.unavailableReason = reason || (!this.available ? '当前状态不可录制视频' : '');
    if (!this.available) this.cancel(reason || '当前场景不可用，录像已取消');
    else if (!previousAvailable && (this.message === previousReason || this.message === '当前场景不可用，录像已取消')) this.message = '';
    this.render();
  }

  cancel(reason = '录像已取消，未生成视频'): void {
    this.generation += 1; this.preparationAbort?.abort(new Error(reason)); this.preparationAbort = undefined;
    this.preparing = false; this.result = undefined;
    this.recorder.cancel(reason); this.message = reason; this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancel('录像组件已关闭，录像已取消'); this.destroyed = true;
    this.events.abort(); this.recorder.destroy(); this.element.remove();
  }

  private async start(): Promise<void> {
    if (this.destroyed || !this.available || this.preparing || this.recorder.active) return;
    const generation = ++this.generation;
    this.preparationAbort?.abort();
    const preparation = new AbortController(); this.preparationAbort = preparation;
    this.preparing = true; this.result = undefined; this.message = '正在准备场景和录像视角…'; this.render();
    try {
      await this.options.onPrepare?.(this.query<HTMLSelectElement>('view').value as SceneVideoView, preparation.signal);
      if (this.destroyed || generation !== this.generation || !this.available) return;
      await this.recorder.start({ format: this.query<HTMLSelectElement>('format').value as SceneVideoFormat,
        maxDurationSeconds: Number(this.query<HTMLInputElement>('duration').value), fileName: this.options.fileName?.() ?? '机械姿态-含场景' });
      if (this.destroyed || generation !== this.generation || !this.available || this.recorder.snapshot.state !== 'recording') return;
      this.options.onStarted?.();
    } catch (error) {
      if (generation !== this.generation) return;
      this.recorder.cancel(); this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.preparationAbort === preparation) this.preparationAbort = undefined;
      if (generation === this.generation) { this.preparing = false; this.render(); }
    }
  }

  private query<T extends HTMLElement>(role: string): T { return this.element.querySelector<T>(`[data-scene-video-role="${role}"]`)!; }
  private render(): void {
    if (this.destroyed) return;
    const active = this.recorder?.active ?? false, state = this.recorder?.snapshot.state;
    for (const input of this.element.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.sve-settings input,.sve-settings select')) input.disabled = !this.available || active || this.preparing;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-scene-video-action]')) {
      const action = button.dataset.sceneVideoAction;
      button.disabled = action === 'start' ? !this.available || active || this.preparing
        : action === 'stop' ? state !== 'recording' : action === 'cancel' ? !active && !this.preparing : !this.result;
      if (action === 'download') button.hidden = !this.result;
    }
    this.query<HTMLElement>('status').textContent = !this.available ? this.unavailableReason : this.message || '尚未开始录像。';
    this.element.dataset.state = this.preparing ? 'preparing' : state ?? 'idle';
  }
}
