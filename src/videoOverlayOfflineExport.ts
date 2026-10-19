import { planVideoOverlayExport, videoOverlayExportFileName, type VideoOverlayExportOptions, type VideoOverlayExportResult, type VideoOverlayExportAudioStatus } from './videoOverlayExport';
import { muxVideoOverlayWebm, type WebmPacket, type WebmSettings } from './videoOverlayWebm';

export type OfflineExportProgress = { phase: 'frames' | 'audio' | 'finalizing'; completed: number; total: number; fraction: number; bytes: number };
export type OfflineExportOptions = Omit<VideoOverlayExportOptions, 'onProgress' | 'format'> & {
  sourceFile?: File;
  /** Resolves only after this source time and its matching WebGL frame are ready. */
  getFrame: (time: number, signal: AbortSignal) => Promise<CanvasImageSource>;
  onProgress?: (progress: OfflineExportProgress) => void;
};

function waitForEncoderQueue(encoder: VideoEncoder | AudioEncoder, limit: number, signal: AbortSignal): Promise<void> {
  if (encoder.encodeQueueSize < limit) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); encoder.removeEventListener('dequeue', dequeue); signal.removeEventListener('abort', abort); };
    const dequeue = () => { if (encoder.encodeQueueSize < limit) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('已取消视频导出', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('编码器处理超时，请降低分辨率后重试')); }, 30000);
    encoder.addEventListener('dequeue', dequeue); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else dequeue();
  });
}

export function planOfflineFrameTimes(start: number, end: number, frameRate: number): { time: number; timestamp: number; duration: number }[] {
  if (![start, end, frameRate].every(Number.isFinite) || start < 0 || end <= start || frameRate < 1 || frameRate > 60) throw new Error('逐帧导出的时间或帧率无效');
  const duration = Math.round((end - start) * 1e6), count = Math.ceil(duration * frameRate / 1e6 - 1e-9);
  if (duration < 1) throw new Error('导出时间范围过短');
  return Array.from({ length: count }, (_, i) => {
    const timestamp = Math.round(i * 1e6 / frameRate);
    return { time: start + i / frameRate, timestamp, duration: Math.min(duration, Math.round((i + 1) * 1e6 / frameRate)) - timestamp };
  });
}

/** Rendering can take any wall time; encoded PTS always follows the source timeline. */
export async function exportVideoOverlayOffline(options: OfflineExportOptions): Promise<VideoOverlayExportResult> {
  const plan = planVideoOverlayExport({ ...options, onProgress: undefined }), times = planOfflineFrameTimes(plan.start, plan.end, plan.frameRate);
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('逐帧导出需要本机 localhost 或 HTTPS 下的新版 Chrome/Edge（WebCodecs）');
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const signal = controller.signal, packets: WebmPacket[] = []; let bytes = 0, encodedFrames = 0, fatal: Error | undefined;
  const frameDurations = new Map(times.map(time => [time.timestamp, time.duration]));
  let encoder: VideoEncoder | undefined, audioEncoder: AudioEncoder | undefined, audio: WebmSettings['audio'];
  let audioStatus: VideoOverlayExportAudioStatus = options.includeAudio === false ? 'silent-requested' : 'silent-unavailable';
  const check = () => { if (fatal) throw fatal; if (signal.aborted) throw new DOMException('已取消视频导出', 'AbortError'); };
  const fail = (error: Error) => { fatal = error; controller.abort(); };
  const packet = (chunk: EncodedVideoChunk | EncodedAudioChunk, track: 1 | 2) => {
    if (signal.aborted) return;
    bytes += chunk.byteLength;
    if (bytes > plan.maxBytes - 1024 * 1024) { fail(new Error('导出文件达到大小上限，请缩短范围或降低分辨率')); return; }
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    packets.push({ data, timestamp: chunk.timestamp, duration: track === 1 ? frameDurations.get(chunk.timestamp) : chunk.duration ?? undefined, track, key: chunk.type === 'key' });
    if (track === 1) encodedFrames++;
  };
  const progress = (phase: OfflineExportProgress['phase'], completed: number) => {
    try { options.onProgress?.({ phase, completed, total: times.length, fraction: completed / times.length, bytes }); } catch { /* UI does not own encoding. */ }
  };
  try {
    check(); let config: VideoEncoderConfig | undefined;
    for (const codec of ['vp09.00.10.08', 'vp8']) {
      const candidate: VideoEncoderConfig = { codec, width: plan.width, height: plan.height, framerate: plan.frameRate, bitrate: plan.videoBitsPerSecond, latencyMode: 'quality' };
      try { if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; } } catch { /* Try next supported codec. */ }
    }
    if (!config) throw new Error('当前浏览器没有可用的逐帧 VP9/VP8 编码器，请使用新版 Chrome/Edge');
    check(); encoder = new VideoEncoder({ output: chunk => packet(chunk, 1), error: fail }); encoder.configure(config);
    options.video.pause();
    for (let index = 0; index < times.length; index++) {
      check(); const time = times[index], canvas = await options.getFrame(time.time, signal); check();
      const frame = new VideoFrame(canvas, { timestamp: time.timestamp, duration: time.duration });
      try { encoder.encode(frame, { keyFrame: index === times.length - 1 || index % Math.max(1, Math.round(plan.frameRate * 2)) === 0 }); }
      finally { frame.close(); }
      // Bounded encoder pressure prevents the renderer from filling VRAM with pending frames.
      if (encoder.encodeQueueSize >= 4) { await waitForEncoderQueue(encoder, 4, signal); check(); }
      progress('frames', index + 1);
    }
    await encoder.flush(); check();
    if (encodedFrames !== times.length) throw new Error(`编码器仅返回 ${encodedFrames}/${times.length} 帧，已停止保存不完整视频`);
    // Decode only bounded local sources. Larger movies remain explicitly silent rather
    // than allocating gigabytes of PCM or silently reverting to real-time capture.
    if (options.includeAudio !== false && options.sourceFile && options.sourceFile.size <= 128 * 1024 * 1024 && options.video.duration <= 600 && typeof AudioEncoder !== 'undefined') {
      progress('audio', times.length);
      let buffer: AudioBuffer | undefined;
      try {
        const context = new OfflineAudioContext(2, 1, 48000);
        buffer = await context.decodeAudioData(await options.sourceFile.arrayBuffer());
      } catch { audioStatus = 'silent-no-audio'; }
      check();
      if (buffer) {
        const channels = Math.min(2, buffer.numberOfChannels), sampleRate = buffer.sampleRate;
        const audioConfig: AudioEncoderConfig = { codec: 'opus', numberOfChannels: channels, sampleRate, bitrate: 128000 };
        if ((await AudioEncoder.isConfigSupported(audioConfig)).supported) {
          audio = { channels, sampleRate };
          audioEncoder = new AudioEncoder({ error: fail, output: (chunk, metadata) => {
            if (metadata?.decoderConfig?.description && audio) {
              const source = metadata.decoderConfig.description;
              const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
              audio.description = new Uint8Array(view);
            }
            packet(chunk, 2);
          } });
          audioEncoder.configure(audioConfig);
          const count = Math.round(plan.duration * sampleRate), first = Math.round(plan.start * sampleRate);
          for (let offset = 0; offset < count; offset += 960) {
            check(); const length = Math.min(960, count - offset), data = new Float32Array(length * channels);
            for (let channel = 0; channel < channels; channel++) data.set(buffer.getChannelData(channel).subarray(first + offset, first + offset + length), channel * length);
            const frame = new AudioData({ format: 'f32-planar', numberOfFrames: length, numberOfChannels: channels, sampleRate, timestamp: Math.round(offset / sampleRate * 1e6), data });
            try { audioEncoder.encode(frame); } finally { frame.close(); }
            if (audioEncoder.encodeQueueSize >= 16) { await waitForEncoderQueue(audioEncoder, 16, signal); check(); }
          }
          await audioEncoder.flush(); check(); audioStatus = 'captured';
        }
      }
    }
    check(); progress('finalizing', times.length);
    const blob = muxVideoOverlayWebm({ ...plan, codec: config.codec === 'vp8' ? 'V_VP8' : 'V_VP9', audio, maxBytes: plan.maxBytes }, packets); check();
    return { blob, fileName: videoOverlayExportFileName(options.fileName ?? 'AR融合视频', blob.type), mimeType: blob.type, silent: audioStatus !== 'captured', audioStatus,
      width: plan.width, height: plan.height, duration: plan.duration, recordedDuration: plan.duration, frames: times.length };
  } catch (error) { if (fatal) throw fatal; throw error; }
  finally {
    options.signal?.removeEventListener('abort', abort); controller.abort();
    if (encoder?.state !== 'closed') encoder?.close(); if (audioEncoder?.state !== 'closed') audioEncoder?.close(); packets.length = 0;
  }
}
