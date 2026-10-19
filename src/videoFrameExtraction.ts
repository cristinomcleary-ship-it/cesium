/** Video frames and their decoded presentation times form one portable CC input. */
export interface VideoFrameFingerprint { algorithm: 'sha256-samples-v1'; value: string }
export interface VideoFrameManifest {
  version: 1;
  kind: 'cesium-video-frames';
  source: { name: string; size: number; lastModified: number; duration: number; width: number; height: number; fingerprint?: VideoFrameFingerprint };
  extraction: { start: number; end: number; intervalSeconds?: number; requestedCount: number; width: number; height: number };
  frames: VideoExtractedFrame[];
}
export interface VideoExtractedFrame { filename: string; index: number; requestedTime: number; mediaTime: number; width: number; height: number }
export interface VideoFrameExtractionOptions {
  start?: number; end?: number; intervalSeconds?: number; count?: number; maxWidth?: number;
  signal?: AbortSignal; onProgress?: (progress: { completed: number; total: number; time: number; bytes: number }) => void;
}
/** Structural types also work in browsers without TypeScript File System Access declarations. */
export interface VideoFrameDirectory {
  name: string;
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<VideoFrameDirectory>;
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<{
    write(data: Blob | Uint8Array<ArrayBuffer> | string): Promise<void>; close(): Promise<void>; abort(): Promise<void>;
  }> }>;
  removeEntry(name: string, options: { recursive: boolean }): Promise<void>;
}
export interface VideoFrameExtractionResult {
  manifest: VideoFrameManifest;
  output: { kind: 'directory'; name: string } | { kind: 'zip'; name: string; blob: Blob };
}
export const VIDEO_FRAME_ZIP_LIMIT = 128 * 1024 * 1024;
export const VIDEO_FRAME_MAX_COUNT = 5000;
const MANIFEST_NAME = 'video-frame-manifest.json';
function finite(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(`${name}无效`);
  return value;
}
function integer(value: unknown, name: string, minimum = 1): number {
  const result = finite(value, name, minimum); if (!Number.isSafeInteger(result)) throw new Error(`${name}必须是整数`); return result;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}格式无效`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error(`${name}无效`); return value;
}
function abortIfNeeded(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('已取消视频抽帧', 'AbortError'); }

export function parseVideoFrameManifest(input: string | unknown): VideoFrameManifest {
  const value = object(typeof input === 'string' ? JSON.parse(input) : input, '抽帧清单');
  if (value.version !== 1 || value.kind !== 'cesium-video-frames') throw new Error('不是受支持的平台抽帧清单');
  const source = object(value.source, '原视频'), extraction = object(value.extraction, '抽帧设置');
  const duration = finite(source.duration, '视频时长', Number.EPSILON);
  const start = finite(extraction.start, '开始时间'), end = finite(extraction.end, '结束时间');
  const width = integer(extraction.width, '照片宽度'), height = integer(extraction.height, '照片高度');
  if (end <= start || end > duration + 1e-6) throw new Error('抽帧时间范围超出原视频');
  const requestedCount = integer(extraction.requestedCount, '抽帧数量');
  if (requestedCount > VIDEO_FRAME_MAX_COUNT) throw new Error('抽帧数量超过上限');
  const intervalSeconds = extraction.intervalSeconds === undefined ? undefined : finite(extraction.intervalSeconds, '抽帧间隔', Number.EPSILON);
  let fingerprint: VideoFrameFingerprint | undefined;
  if (source.fingerprint !== undefined) {
    const supplied = object(source.fingerprint, '视频指纹');
    if (supplied.algorithm !== 'sha256-samples-v1' || typeof supplied.value !== 'string' || !/^[a-f0-9]{64}$/.test(supplied.value)) throw new Error('视频内容指纹无效');
    fingerprint = { algorithm: 'sha256-samples-v1', value: supplied.value };
  }
  if (!Array.isArray(value.frames) || !value.frames.length || value.frames.length > requestedCount) throw new Error('照片清单数量无效');
  const filenames = new Set<string>(); let lastTime = -1, lastRequested = -1;
  const frames = value.frames.map((entry, index): VideoExtractedFrame => {
    const frame = object(entry, '照片'), filename = text(frame.filename, '照片文件名');
    if (!/^[^/\\\x00-\x1f]+\.(jpe?g|png)$/i.test(filename) || filename === '.' || filename === '..') throw new Error('照片文件名必须是 JPEG/PNG basename');
    const key = filename.toLocaleLowerCase('en-US'); if (filenames.has(key)) throw new Error(`照片文件名重复：${filename}`); filenames.add(key);
    const mediaTime = finite(frame.mediaTime, '实际帧时间'), requestedTime = finite(frame.requestedTime, '请求帧时间');
    if (mediaTime <= lastTime || mediaTime >= duration + 1e-6) throw new Error('实际帧时间必须唯一、递增且位于视频范围内');
    if (requestedTime <= lastRequested || requestedTime < start || requestedTime >= end + 1e-6) throw new Error('请求帧时间必须递增且位于抽帧范围内');
    if (integer(frame.index, '照片序号', 0) !== index || frame.width !== width || frame.height !== height) throw new Error('照片序号或尺寸不一致');
    lastTime = mediaTime; lastRequested = requestedTime;
    return { filename, index, requestedTime, mediaTime, width, height };
  });
  return { version: 1, kind: 'cesium-video-frames', source: {
    name: text(source.name, '原视频名称'), size: integer(source.size, '原视频大小'), lastModified: integer(source.lastModified, '原视频修改时间', 0), duration,
    width: integer(source.width, '视频宽度'), height: integer(source.height, '视频高度'), ...(fingerprint ? { fingerprint } : {}),
  }, extraction: { start, end, ...(intervalSeconds === undefined ? {} : { intervalSeconds }), requestedCount, width, height }, frames };
}

/** Metadata-only check for older manifests; prefer verifyVideoFrameSource for current files. */
export function assertVideoFrameSource(manifest: VideoFrameManifest, file: Pick<File, 'name' | 'size' | 'lastModified'>): void {
  const { source } = parseVideoFrameManifest(manifest);
  if (source.name !== file.name || source.size !== file.size || source.lastModified !== file.lastModified) {
    throw new Error('抽帧清单与当前视频不匹配（名称、大小或修改时间不同），请选择抽帧时的原视频');
  }
}

/** A bounded content fingerprint survives File reconstruction and renamed copies.
 * This is a sampled identity check, not a cryptographic hash of the entire movie. */
export async function fingerprintVideoFrameSource(file: Blob, signal?: AbortSignal): Promise<VideoFrameFingerprint> {
  abortIfNeeded(signal);
  if (!file.size || !globalThis.crypto?.subtle) throw new Error('视频内容校验需要本机 localhost 或 HTTPS 浏览器环境');
  const sampleBytes = 1024 * 1024;
  const samples = file.size <= sampleBytes * 3 ? [{ offset: 0, length: file.size }] : [0, Math.floor((file.size - sampleBytes) / 2), file.size - sampleBytes].map(offset => ({ offset, length: sampleBytes }));
  const prefix = new TextEncoder().encode(JSON.stringify({ algorithm: 'sha256-samples-v1', size: file.size, samples }));
  const bytes = new Uint8Array(prefix.length + samples.reduce((sum, sample) => sum + sample.length, 0)); bytes.set(prefix); let position = prefix.length;
  for (const sample of samples) { abortIfNeeded(signal); bytes.set(new Uint8Array(await file.slice(sample.offset, sample.offset + sample.length).arrayBuffer()), position); position += sample.length; }
  abortIfNeeded(signal);
  const digest = await crypto.subtle.digest('SHA-256', bytes); abortIfNeeded(signal);
  return { algorithm: 'sha256-samples-v1', value: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') };
}

export async function verifyVideoFrameSource(manifest: VideoFrameManifest, file: File, signal?: AbortSignal): Promise<void> {
  const checked = parseVideoFrameManifest(manifest);
  if (!checked.source.fingerprint) { assertVideoFrameSource(checked, file); return; }
  if (checked.source.size !== file.size) throw new Error('抽帧清单与当前视频大小不匹配，请选择抽帧时的原视频');
  const actual = await fingerprintVideoFrameSource(file, signal);
  if (actual.value !== checked.source.fingerprint.value) throw new Error('抽帧清单与当前视频内容不匹配，请选择抽帧时的原视频');
}

/** End is exclusive, including for count mode, so duration never requests a nonexistent frame. */
export function planVideoFrameTimes(duration: number, options: Pick<VideoFrameExtractionOptions, 'start' | 'end' | 'intervalSeconds' | 'count'> = {}): number[] {
  finite(duration, '视频时长', Number.EPSILON);
  const start = finite(options.start ?? 0, '开始时间'), end = finite(options.end ?? duration, '结束时间');
  if (start >= end || end > duration) throw new Error('请输入位于视频时长内的有效抽帧范围');
  if (options.count !== undefined && options.intervalSeconds !== undefined) throw new Error('抽帧数量与间隔只能选择一种');
  let count: number, interval: number;
  if (options.count !== undefined) {
    count = integer(options.count, '抽帧数量');
    interval = count === 1 ? 0 : (end - start - Math.min(0.0001, (end - start) / 1000000)) / (count - 1);
  } else {
    interval = finite(options.intervalSeconds ?? 1, '抽帧间隔', Number.EPSILON); count = Math.ceil((end - start) / interval - 1e-10);
  }
  if (count < 1 || count > VIDEO_FRAME_MAX_COUNT) throw new Error(`单次抽帧最多 ${VIDEO_FRAME_MAX_COUNT} 张，请缩短范围或加大间隔`);
  // Do not turn a requested 2.1 s boundary into 2.0999999999999996 s:
  // decoders correctly choose the previous frame for the latter timestamp.
  return Array.from({ length: count }, (_, index) => Number((start + index * interval).toFixed(9)));
}

export async function pickVideoFrameDirectory(): Promise<VideoFrameDirectory | undefined> {
  const picker = (globalThis as unknown as { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<VideoFrameDirectory> }).showDirectoryPicker;
  return picker ? picker.call(globalThis, { mode: 'readwrite' }) : undefined;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
/** JPEG is already compressed; stored ZIP avoids another large compression workspace. */
export function createVideoFrameZip(entries: readonly { name: string; bytes: Uint8Array<ArrayBuffer> }[], limit = VIDEO_FRAME_ZIP_LIMIT): Blob {
  if (entries.length > VIDEO_FRAME_MAX_COUNT + 1) throw new Error('ZIP 文件数量超过上限');
  const encoder = new TextEncoder(), parts: BlobPart[] = [], central: BlobPart[] = [];
  let offset = 0, centralSize = 0;
  for (const entry of entries) {
    if (/[\\/\x00-\x1f]/.test(entry.name) || !entry.name) throw new Error('ZIP 文件名无效');
    const name = encoder.encode(entry.name), size = entry.bytes.byteLength, crc = crc32(entry.bytes);
    if (offset + 30 + name.length + size + centralSize + 46 + name.length + 22 > limit) throw new Error('ZIP 超过 128 MB，请选择文件夹导出、缩小照片尺寸或减少抽帧数量');
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(12, 33, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); local.set(name, 30);
    parts.push(local, entry.bytes);
    const header = new Uint8Array(46 + name.length), hv = new DataView(header.buffer);
    hv.setUint32(0, 0x02014b50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 20, true); hv.setUint16(8, 0x0800, true); hv.setUint16(14, 33, true);
    hv.setUint32(16, crc, true); hv.setUint32(20, size, true); hv.setUint32(24, size, true); hv.setUint16(28, name.length, true); hv.setUint32(42, offset, true); header.set(name, 46);
    central.push(header); centralSize += header.length; offset += local.length + size;
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer); ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function waitForMedia(video: HTMLVideoElement, event: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); video.removeEventListener(event, success); video.removeEventListener('error', failed); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const success = () => finish(), failed = () => finish(new Error('视频无法解码，请使用浏览器支持的 MP4/WebM 原视频'));
    const abort = () => finish(new DOMException('已取消视频抽帧', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('视频读取超时')), 20000);
    video.addEventListener(event, success, { once: true }); video.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Copy pixels and their real PTS atomically, including paused seeks with no rVFC. */
function captureDecodedFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, requestedTime: number, signal?: AbortSignal): Promise<number> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    let callback = 0, finished = false;
    const finish = (error?: Error, mediaTime?: number) => {
      if (finished) return; finished = true;
      clearTimeout(timer); if (callback) video.cancelVideoFrameCallback(callback);
      signal?.removeEventListener('abort', abort); video.removeEventListener('error', failed); video.removeEventListener('seeked', seeked);
      error ? reject(error) : resolve(mediaTime!);
    };
    const abort = () => finish(new DOMException('已取消视频抽帧', 'AbortError'));
    const failed = () => finish(new Error('视频帧解码失败'));
    const capture = (mediaTime?: number): boolean => {
      if (finished || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - requestedTime) > 1e-5) return false;
      let frame: VideoFrame | undefined;
      try {
        // Omitting timestamp makes WebCodecs retain the decoded playback PTS.
        // Never label a paused seek with its requested currentTime.
        if (typeof VideoFrame !== 'undefined') {
          try { frame = new VideoFrame(video); mediaTime = frame.timestamp / 1e6; } catch { /* rVFC metadata is the fallback on older browsers. */ }
        }
        if (mediaTime === undefined || !Number.isFinite(mediaTime) || mediaTime < 0) return false;
        const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('浏览器无法创建抽帧画布');
        context.drawImage(frame ?? video, 0, 0, canvas.width, canvas.height); finish(undefined, mediaTime); return true;
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return true; }
      finally { frame?.close(); }
    };
    const seeked = () => { capture(); };
    const decoded: VideoFrameRequestCallback = (_now, metadata) => {
      callback = 0; if (!finished && !capture(metadata.mediaTime)) callback = video.requestVideoFrameCallback(decoded);
    };
    const timer = setTimeout(() => finish(new Error(`无法取得 ${requestedTime.toFixed(3)} 秒的实际解码帧，请使用最新版 Chrome/Edge 或加大抽帧间隔`)), 20000);
    signal?.addEventListener('abort', abort, { once: true }); video.addEventListener('error', failed, { once: true });
    video.addEventListener('seeked', seeked);
    callback = video.requestVideoFrameCallback(decoded);
    // Register before seeking: paused videos may submit the frame before seeked.
    try { video.currentTime = requestedTime; }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function jpeg(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  abortIfNeeded(signal);
  const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG 编码失败')), 'image/jpeg', .95));
  abortIfNeeded(signal); return result;
}
async function writeFrameFile(directory: VideoFrameDirectory, name: string, data: Blob | string, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal); const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try { abortIfNeeded(signal); await writer.write(data); abortIfNeeded(signal); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function extractVideoFrames(file: File, options: VideoFrameExtractionOptions = {}, destination?: VideoFrameDirectory): Promise<VideoFrameExtractionResult> {
  abortIfNeeded(options.signal);
  if (!file.size) throw new Error('请选择原始航拍视频');
  const fingerprint = await fingerprintVideoFrameSource(file, options.signal);
  const video = document.createElement('video'), canvas = document.createElement('canvas');
  if (typeof video.requestVideoFrameCallback !== 'function') throw new Error('抽帧需要支持实际帧时间的新版 Chrome/Edge 浏览器');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  // A separate attached decoder prevents interference with the playing AR video.
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;pointer-events:none';
  video.setAttribute('aria-hidden', 'true'); document.body.append(video);
  const url = URL.createObjectURL(file); let directory: VideoFrameDirectory | undefined, completed = false;
  const stem = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'video';
  const folder = `${stem}_frames_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const metadata = waitForMedia(video, 'loadedmetadata', options.signal); video.src = url; video.load(); await metadata;
    const times = planVideoFrameTimes(video.duration, options);
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频未提供有效的画面尺寸');
    const maxWidth = options.maxWidth === undefined ? video.videoWidth : integer(options.maxWidth, '照片最大宽度');
    const ratio = Math.min(1, maxWidth / video.videoWidth); canvas.width = Math.max(1, Math.round(video.videoWidth * ratio)); canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
    const manifest: VideoFrameManifest = { version: 1, kind: 'cesium-video-frames', source: {
      name: file.name, size: file.size, lastModified: file.lastModified, duration: video.duration, width: video.videoWidth, height: video.videoHeight, fingerprint,
    }, extraction: { start: options.start ?? 0, end: options.end ?? video.duration, requestedCount: times.length, width: canvas.width, height: canvas.height,
      ...(options.count === undefined ? { intervalSeconds: options.intervalSeconds ?? 1 } : {}) }, frames: [] };
    if (destination) directory = await destination.getDirectoryHandle(folder, { create: true });
    const entries: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = []; let bytes = 0;
    for (let index = 0; index < times.length; index++) {
      abortIfNeeded(options.signal);
      const requestedTime = times[index], mediaTime = await captureDecodedFrame(video, canvas, requestedTime, options.signal);
      if (!Number.isFinite(mediaTime) || mediaTime < 0 || mediaTime >= video.duration + 1e-6) throw new Error('解码器返回了无效帧时间');
      const previous = manifest.frames.at(-1);
      if (previous && mediaTime < previous.mediaTime) throw new Error('视频解码时间发生倒退，抽帧已停止');
      // A requested interval below frame duration can address the same decoded frame.
      if (!previous || mediaTime > previous.mediaTime) {
        const frameIndex = manifest.frames.length, filename = `frame_${String(frameIndex).padStart(6, '0')}.jpg`, blob = await jpeg(canvas, options.signal);
        if (!directory && bytes + blob.size > VIDEO_FRAME_ZIP_LIMIT - 1024 * 1024) throw new Error('ZIP 超过 128 MB，请改用文件夹导出、缩小照片尺寸或减少抽帧数量');
        if (directory) await writeFrameFile(directory, filename, blob, options.signal);
        else entries.push({ name: filename, bytes: new Uint8Array(await blob.arrayBuffer()) });
        bytes += blob.size; manifest.frames.push({ filename, index: frameIndex, requestedTime, mediaTime, width: canvas.width, height: canvas.height });
      }
      options.onProgress?.({ completed: index + 1, total: times.length, time: mediaTime, bytes });
    }
    const checked = parseVideoFrameManifest(manifest), json = JSON.stringify(checked, null, 2);
    abortIfNeeded(options.signal);
    if (directory) { await writeFrameFile(directory, MANIFEST_NAME, json, options.signal); completed = true; return { manifest: checked, output: { kind: 'directory', name: folder } }; }
    entries.push({ name: MANIFEST_NAME, bytes: new TextEncoder().encode(json) });
    const blob = createVideoFrameZip(entries); abortIfNeeded(options.signal); completed = true;
    return { manifest: checked, output: { kind: 'zip', name: `${stem}_frames.zip`, blob } };
  } finally {
    video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); canvas.width = 1; canvas.height = 1;
    if (directory && !completed) await destination!.removeEntry(folder, { recursive: true }).catch(() => {});
  }
}
