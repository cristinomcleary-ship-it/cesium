import type { Conversion, Input, Output, StreamTargetChunk, VideoSample } from 'mediabunny';

export type NativeVideoCacheRange = { start: number; end: number };
export type NativeVideoCacheProgress = {
  frames: number;
  /** Absolute time on the source video timeline, in seconds. */
  sourceTime: number;
  /** Rendering/encoding progress; only resolution of prepareNativeVideoCache means the file is complete. */
  progress: number;
};
export type NativeVideoCacheResult = NativeVideoCacheRange & {
  width: number;
  height: number;
  frames: number;
  duration: number;
  mimeType: string;
  audioStatus: 'preserved' | 'none' | 'excluded';
  audioTracks: number;
};
export type NativeVideoCacheOptions = {
  sourceFile: File;
  range: NativeVideoCacheRange;
  /** Must equal the source's display dimensions, including its rotation metadata. */
  width: number;
  height: number;
  /** False only when the user explicitly disables audio in the export controls. Defaults to true. */
  includeAudio?: boolean;
  signal: AbortSignal;
  /**
   * The borrowed source frame remains valid until this promise settles. Render the complete fusion at time and
   * return a canvas of exactly width × height. There is deliberately no HTMLVideoElement seek or frame-rate option.
   */
  getFrame: (
    time: number, signal: AbortSignal, source: CanvasImageSource,
  ) => Promise<HTMLCanvasElement | OffscreenCanvas>;
  /** A fresh, unpublished file owned by the caller's cache transaction. */
  target: FileSystemFileHandle;
  onProgress?: (progress: NativeVideoCacheProgress) => void;
};

export function normalizeNativeCacheRange(range: NativeVideoCacheRange, sourceEnd: number): NativeVideoCacheRange {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
    throw new Error('缓存时间范围无效。');
  }
  if (!Number.isFinite(sourceEnd) || sourceEnd <= range.start) throw new Error('缓存范围内没有视频画面。');
  return { start: range.start, end: Math.min(range.end, sourceEnd) };
}

export function assertNativeCacheDimensions(width: number, height: number, sourceWidth: number, sourceHeight: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width !== sourceWidth || height !== sourceHeight) {
    throw new Error(`缓存必须保持源视频分辨率 ${sourceWidth} × ${sourceHeight}，不能缩小为 ${width} × ${height}。`);
  }
}

/** Generous fallback for encoders without constant-quality control; never use a low fixed bitrate at 4K/60 fps. */
export function nativeCacheFallbackBitrate(width: number, height: number, frameRate: number, sourceBitrate: number): number {
  const cadence = Number.isFinite(frameRate) && frameRate > 0 ? Math.max(60, frameRate) : 60;
  const sourceFloor = Number.isFinite(sourceBitrate) && sourceBitrate > 0 ? sourceBitrate * 1.25 : 0;
  return Math.ceil(Math.max(4_000_000, width * height * cadence * 0.3, sourceFloor));
}

/** Conversion supplies clipped, zero-based timestamps; reconstruct source time without an fps grid. */
export function sourceTimeForCacheFrame(timestamp: number, range: NativeVideoCacheRange): number {
  if (!Number.isFinite(timestamp) || timestamp < -0.000001 || timestamp >= range.end - range.start + 0.000001) {
    throw new Error('解码帧时间戳超出缓存范围。');
  }
  return range.start + Math.max(0, timestamp);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('融合缓存准备已取消。', 'AbortError');
}

/**
 * Sequential demux/decode → full-resolution fusion → encode, with the source PTS and duration of every frame.
 * The compressed file is streamed to disk with bounded write chunks, never collected in an in-memory Blob.
 * This is high-quality encoding, not mathematically lossless encoding. All source audio tracks must survive.
 *
 * On rejection every writer/codec is settled before returning. The caller must then abort its cache transaction
 * (remove the unpublished file); a FileSystemFileHandle alone cannot portably remove its directory entry.
 */
export async function prepareNativeVideoCache(options: NativeVideoCacheOptions): Promise<NativeVideoCacheResult> {
  const { sourceFile, width, height, signal, getFrame, target, onProgress, includeAudio = true } = options;
  throwIfAborted(signal);
  const media = await import('mediabunny');
  throwIfAborted(signal);

  let input: Input | undefined;
  let output: Output | undefined;
  let conversion: Conversion | undefined;
  let writable: FileSystemWritableFileStream | undefined;
  let settleWriterPromise: Promise<void> | undefined;
  let cancellation: Promise<void> | undefined;
  let succeeded = false;
  let frames = 0;
  let lastSourceTime = options.range.start;

  // StreamTarget normally closes its stream on cancellation as well as on success. This adapter commits the
  // filesystem write only during successful mux finalization; all other close paths abort its temporary write.
  const settleWriter = (commit: boolean): Promise<void> => {
    if (!writable) return Promise.resolve();
    return settleWriterPromise ??= commit ? writable.close().catch(async error => {
      try { await writable!.abort(); } catch { /* An errored/closed stream may already have released its writer. */ }
      throw error;
    }) : writable.abort();
  };
  const cancel = () => {
    try { input?.dispose(); } catch { /* Still close encoders and the filesystem writer below. */ }
    cancellation ??= (async () => {
      try { await conversion?.cancel(); } finally { await output?.cancel(); }
    })();
    // The same promise is awaited in finally. Do not produce an unhandled rejection from an event listener.
    void cancellation.catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });

  try {
    input = new media.Input({ source: new media.BlobSource(sourceFile, { maxCacheSize: 8 * 1024 * 1024 }), formats: media.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('源文件没有可用于融合的视频轨道。');
    const [sourceWidth, sourceHeight, sourceEnd, audioTracks, packetStats, declaredBitrate] = await Promise.all([
      video.getDisplayWidth(), video.getDisplayHeight(), video.computeDuration(), input.getAudioTracks(),
      video.computePacketStats(240), video.getAverageBitrate(),
    ]);
    throwIfAborted(signal);
    assertNativeCacheDimensions(width, height, sourceWidth, sourceHeight);
    const range = normalizeNativeCacheRange(options.range, sourceEnd);
    const duration = range.end - range.start;
    const bitrate = nativeCacheFallbackBitrate(width, height, packetStats.averagePacketRate,
      Math.max(packetStats.averageBitrate, declaredBitrate ?? 0));
    lastSourceTime = range.start;
    writable = await target.createWritable({ keepExistingData: false });
    throwIfAborted(signal);

    const stream = new WritableStream<StreamTargetChunk>({
      write: chunk => writable!.write(chunk),
      close: () => settleWriter(output?.state === 'finalizing' && !signal.aborted),
      abort: () => settleWriter(false),
    });
    output = new media.Output({
      format: new media.WebMOutputFormat(),
      target: new media.StreamTarget(stream, { chunked: true, chunkSize: 1024 * 1024 }),
    });

    const process = async (sample: VideoSample): Promise<HTMLCanvasElement | OffscreenCanvas> => {
      throwIfAborted(signal);
      const sourceTime = sourceTimeForCacheFrame(sample.timestamp, range);
      assertNativeCacheDimensions(sample.displayWidth, sample.displayHeight, width, height);
      // Do not use toCanvasImageSource(): some of its temporary frames auto-close in the next microtask.
      const source = sample.toVideoFrame();
      try {
        assertNativeCacheDimensions(source.displayWidth, source.displayHeight, width, height);
        const canvas = await getFrame(sourceTime, signal, source);
        throwIfAborted(signal);
        assertNativeCacheDimensions(canvas.width, canvas.height, width, height);
        frames++;
        lastSourceTime = sourceTime;
        onProgress?.({ frames, sourceTime, progress: Math.min(0.999, (sourceTime - range.start + sample.duration) / duration) });
        return canvas;
      } finally {
        source.close();
      }
    };
    conversion = await media.Conversion.init({
      input,
      output,
      tracks: 'all',
      trim: range,
      video: track => track.id !== video.id ? { discard: true } : {
        codec: 'vp9',
        // Quantizer 16 is high quality on both VP9 scales (old Chromium 0–63, current Chromium 0–255).
        // Encoders without quantizer mode use the source-aware high-bitrate fallback, never a reduced resolution.
        quality: new media.Quality({ quantizer: 16, bitrate }),
        allowTransformationMetadata: false,
        processedWidth: width,
        processedHeight: height,
        // Omit frameRate: Conversion retains source frame timestamps/durations, including VFR and 60+ fps.
        process,
      },
      // Preserve all audio tracks and channel counts. Unsupported audio is a hard error below.
      audio: includeAudio ? { codec: 'opus', quality: new media.Quality('very-high') } : { discard: true },
      showWarnings: false,
    });
    throwIfAborted(signal);
    const discardedAudio = conversion.discardedTracks.filter(item => item.track.isAudioTrack());
    if (includeAudio && discardedAudio.length) {
      throw new Error(`无法保留 ${discardedAudio.length} 条源音轨（${discardedAudio.map(item => item.reason).join('、')}）；已停止生成，避免得到无声缓存。`);
    }
    if (!conversion.isValid || conversion.discardedTracks.some(item => item.track.id === video.id)) {
      throw new Error('当前浏览器无法按源分辨率解码并编码融合缓存；请使用支持 WebCodecs / VP9 的浏览器。');
    }
    await conversion.execute();
    throwIfAborted(signal);
    if (frames === 0) throw new Error('缓存范围内没有解码出视频帧。');
    succeeded = true;
    onProgress?.({ frames, sourceTime: lastSourceTime, progress: 1 });
    return { ...range, width, height, frames, duration, mimeType: 'video/webm',
      audioStatus: !includeAudio ? 'excluded' : audioTracks.length ? 'preserved' : 'none',
      audioTracks: includeAudio ? audioTracks.length : 0 };
  } catch (error) {
    if (signal.aborted) throw new DOMException('融合缓存准备已取消。', 'AbortError');
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    try { input?.dispose(); } catch { /* Writer/encoder cleanup must continue if disposal unexpectedly fails. */ }
    if (!succeeded) {
      // Output.cancel is idempotent and waits for an already-running cancellation; Conversion.cancel alone does not.
      try { await conversion?.cancel(); } catch { /* Preserve the actual render/decode/write error. */ }
      try { await output?.cancel(); } catch { /* A failed filesystem write can also reject cancellation. */ }
      try { await cancellation; } catch { /* The original failure is reported above. */ }
      try { await settleWriter(false); } catch { /* The caller's transaction removes the partial file. */ }
    }
  }
}
