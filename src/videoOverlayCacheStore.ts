/** Persistent native-size movies. Only a closed movie with a committed manifest is playable. */
export type VideoOverlayCacheMetadata = {
  width: number; height: number; frames: number; duration: number;
  start: number; end: number; mimeType: string; audioStatus: string;
  frameRate?: number; fileName?: string;
};
export type VideoOverlayCachedMovie = { file: File; metadata: VideoOverlayCacheMetadata };
export type VideoOverlayCacheTransaction = {
  handle: FileSystemFileHandle;
  /** The producer must close its writable stream before publishing. */
  commit(metadata: VideoOverlayCacheMetadata): Promise<VideoOverlayCachedMovie>;
  /** Call after the producer has stopped and closed/aborted its writable stream. */
  abort(): Promise<void>;
};
type CacheManifest = {
  version: 1; key: string; file: string; bytes: number; createdAt: number;
  schemeId: string; metadata: VideoOverlayCacheMetadata;
};
type DirectoryWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
const DIRECTORY = 'cesium-ar-fused-movies-v1';
const CHUNK_BYTES = 8 * 1024 * 1024;
const blobHashes = new WeakMap<Blob, string>();
const utf8 = new TextEncoder();
const isNotFound = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('融合缓存任务已取消', 'AbortError');
};
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
async function digest(text: string) { return hex(await crypto.subtle.digest('SHA-256', utf8.encode(text))); }

/** Stable JSON: property insertion order and omitted optional fields do not change a cache key. */
export function serializeVideoOverlayCacheInputs(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('融合缓存参数含无效数值');
      return item;
    }
    if (item === undefined) return null;
    if (typeof item !== 'object') throw new Error('融合缓存参数必须是可保存的数据');
    if (seen.has(item)) throw new Error('融合缓存参数不能循环引用');
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map(normalize);
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error('融合缓存参数必须是普通对象');
      }
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined) result[key] = normalize(entry);
      }
      return result;
    } finally { seen.delete(item); }
  };
  return JSON.stringify(normalize(value));
}

/** Hash every byte without reading a multi-GB video into memory. This is a versioned hash chain. */
async function hashBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  aborted(signal);
  const known = blobHashes.get(blob); if (known) return known;
  let chain = await digest(`cesium-ar-blob-v1/${blob.size}/${CHUNK_BYTES}`);
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    aborted(signal);
    const bytes = await blob.slice(offset, Math.min(blob.size, offset + CHUNK_BYTES)).arrayBuffer();
    aborted(signal);
    const part = hex(await crypto.subtle.digest('SHA-256', bytes));
    chain = await digest(`${chain}/${offset}/${bytes.byteLength}/${part}`);
  }
  aborted(signal); blobHashes.set(blob, chain); return chain;
}

export async function hashVideoOverlayInputs(
  files: Record<string, Blob | undefined>, descriptor: unknown, signal?: AbortSignal,
): Promise<string> {
  aborted(signal);
  const serialized = serializeVideoOverlayCacheInputs(descriptor);
  const fingerprints: Record<string, { size: number; hash: string }> = {};
  for (const name of Object.keys(files).sort()) {
    const file = files[name]; if (!file) continue;
    fingerprints[name] = { size: file.size, hash: await hashBlob(file, signal) };
  }
  aborted(signal);
  const result = await digest(serializeVideoOverlayCacheInputs({ version: 1, files: fingerprints, descriptor: serialized }));
  aborted(signal); return result;
}

function cacheKey(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('融合缓存标识无效');
  return key;
}
function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'AbortError') return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error('本机融合缓存空间不足，请清除不需要的缓存或释放磁盘空间后重试');
  }
  return error instanceof Error ? error : new Error('无法读写本机融合缓存');
}
function validMetadata(value: unknown): value is VideoOverlayCacheMetadata {
  if (!value || typeof value !== 'object') return false;
  const m = value as VideoOverlayCacheMetadata;
  return Number.isSafeInteger(m.width) && m.width > 0 && Number.isSafeInteger(m.height) && m.height > 0
    && Number.isSafeInteger(m.frames) && m.frames > 0 && Number.isFinite(m.duration) && m.duration > 0
    && Number.isFinite(m.start) && m.start >= 0 && Number.isFinite(m.end) && m.end > m.start
    && Math.abs(m.end - m.start - m.duration) < .01
    && ['video/webm', 'video/mp4'].includes(m.mimeType) && typeof m.audioStatus === 'string'
    && (m.frameRate === undefined || Number.isFinite(m.frameRate) && m.frameRate > 0);
}

/** OPFS stores bytes; a small, atomically closed manifest publishes a completed generation. */
export class VideoOverlayCacheStore {
  private readonly directory: FileSystemDirectoryHandle;
  private readonly versionsPerScheme: number;
  private lastCreatedAt = 0;
  private constructor(directory: FileSystemDirectoryHandle, versionsPerScheme = 2) {
    this.directory = directory; this.versionsPerScheme = versionsPerScheme;
  }

  static async open(options: { root?: FileSystemDirectoryHandle; versionsPerScheme?: number } = {}): Promise<VideoOverlayCacheStore> {
    const keep = options.versionsPerScheme ?? 2;
    if (!Number.isInteger(keep) || keep < 1 || keep > 10) throw new Error('融合缓存保留数量无效');
    try {
      if (!options.root && (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function')) {
        throw new Error('当前浏览器不支持持久融合缓存，请在本机 localhost 或 HTTPS 下使用新版 Chrome/Edge');
      }
      const root = options.root ?? await navigator.storage.getDirectory();
      return new VideoOverlayCacheStore(await root.getDirectoryHandle(DIRECTORY, { create: true }), keep);
    } catch (error) { throw storageError(error); }
  }

  private async readManifest(key: string): Promise<CacheManifest | undefined> {
    let file: File;
    try { file = await (await this.directory.getFileHandle(`${cacheKey(key)}.json`)).getFile(); }
    catch (error) { if (isNotFound(error)) return undefined; throw storageError(error); }
    if (file.size > 65536) return undefined;
    let m: CacheManifest;
    try { m = JSON.parse(await file.text()); } catch { return undefined; }
    if (m?.version !== 1 || m.key !== key || !new RegExp(`^${key}-[a-f0-9-]+\\.movie$`).test(m.file)
      || !Number.isSafeInteger(m.bytes) || m.bytes <= 0 || !Number.isFinite(m.createdAt)
      || typeof m.schemeId !== 'string' || !validMetadata(m.metadata)) return undefined;
    return m;
  }

  async get(key: string): Promise<VideoOverlayCachedMovie | undefined> {
    const manifest = await this.readManifest(key); if (!manifest) return undefined;
    try {
      const file = await (await this.directory.getFileHandle(manifest.file)).getFile();
      if (file.size !== manifest.bytes) return undefined;
      // OPFS filenames are intentionally format-neutral; preserve the encoded MIME type without copying bytes.
      return { file: new File([file], manifest.metadata.fileName ?? `AR融合.${manifest.metadata.mimeType === 'video/mp4' ? 'mp4' : 'webm'}`,
        { type: manifest.metadata.mimeType, lastModified: file.lastModified }), metadata: manifest.metadata };
    } catch (error) { if (isNotFound(error)) return undefined; throw storageError(error); }
  }

  async begin(key: string, options: { schemeId?: string; signal?: AbortSignal; requiredBytes?: number } = {}): Promise<VideoOverlayCacheTransaction> {
    cacheKey(key); aborted(options.signal);
    if (options.requiredBytes !== undefined) {
      if (!Number.isFinite(options.requiredBytes) || options.requiredBytes < 0) throw new Error('融合缓存容量估算无效');
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate(); aborted(options.signal);
        if (estimate.quota !== undefined && estimate.usage !== undefined && options.requiredBytes > estimate.quota - estimate.usage) {
          throw new Error('本机可用缓存空间不足以保存这段融合视频，请释放磁盘空间或删除旧缓存');
        }
      }
    }
    const fileName = `${key}-${crypto.randomUUID()}.movie`;
    let handle: FileSystemFileHandle;
    try { handle = await this.directory.getFileHandle(fileName, { create: true }); }
    catch (error) { throw storageError(error); }
    let state: 'pending' | 'committing' | 'committed' | 'aborted' = 'pending';
    let committed: VideoOverlayCachedMovie | undefined;
    const abort = async () => {
      if (state === 'committed' || state === 'aborted') return;
      if (state === 'committing') throw new Error('融合缓存正在发布，请等待发布结束后再清理');
      await this.removeFile(fileName); state = 'aborted';
    };
    if (options.signal?.aborted) { await abort(); aborted(options.signal); }
    return { handle, abort, commit: async metadata => {
      if (state === 'committed') return committed!;
      if (state !== 'pending') throw new Error('融合缓存任务已经结束');
      aborted(options.signal);
      if (!validMetadata(metadata)) throw new Error('融合缓存的帧数、时间或尺寸无效');
      state = 'committing';
      let writer: FileSystemWritableFileStream | undefined;
      let previous: CacheManifest | undefined;
      try {
        const file = await handle.getFile();
        if (file.size <= 0) throw new Error('融合视频尚未写入完成，不能发布缓存');
        this.lastCreatedAt = Math.max(Date.now(), this.lastCreatedAt + 1);
        const manifest: CacheManifest = { version: 1, key, file: fileName, bytes: file.size, createdAt: this.lastCreatedAt,
          schemeId: options.schemeId ?? key, metadata: JSON.parse(JSON.stringify(metadata)) };
        previous = await this.readManifest(key);
        aborted(options.signal);
        const marker = await this.directory.getFileHandle(`${key}.json`, { create: true });
        writer = await marker.createWritable();
        await writer.write(JSON.stringify(manifest)); aborted(options.signal);
        await writer.close(); writer = undefined;
        state = 'committed';
        committed = { file: new File([file], metadata.fileName ?? `AR融合.${metadata.mimeType === 'video/mp4' ? 'mp4' : 'webm'}`,
          { type: metadata.mimeType, lastModified: file.lastModified }), metadata: manifest.metadata };
        // A cleanup error must not turn an already published movie into a failed recording.
        if (previous && previous.file !== fileName) await this.removeFile(previous.file).catch(error => console.warn('[AR cache] Old generation cleanup failed', error));
        await this.prune(manifest.schemeId, key).catch(error => console.warn('[AR cache] Cache retention cleanup failed', error));
        return committed;
      } catch (error) {
        await writer?.abort().catch(() => {});
        state = 'pending';
        await abort().catch(cleanup => console.warn('[AR cache] Partial cleanup failed', cleanup));
        throw storageError(error);
      }
    } };
  }

  private async removeFile(name: string): Promise<void> {
    try { await this.directory.removeEntry(name); } catch (error) { if (!isNotFound(error)) throw storageError(error); }
  }

  async remove(key: string): Promise<void> {
    const manifest = await this.readManifest(key);
    // Unpublish first, so an interrupted delete never advertises a missing movie.
    await this.removeFile(`${cacheKey(key)}.json`);
    if (manifest) await this.removeFile(manifest.file);
  }

  private async manifests(): Promise<CacheManifest[]> {
    const result: CacheManifest[] = [];
    for await (const [name, handle] of (this.directory as DirectoryWithEntries).entries()) {
      if (handle.kind !== 'file' || !/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const manifest = await this.readManifest(name.slice(0, -5));
      if (manifest) result.push(manifest);
    }
    return result;
  }

  private async prune(schemeId: string, currentKey: string): Promise<void> {
    const candidates = (await this.manifests()).filter(m => m.schemeId === schemeId && m.key !== currentKey)
      .sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
    for (const candidate of candidates.slice(this.versionsPerScheme - 1)) await this.remove(candidate.key);
  }

  async removeScheme(schemeId: string): Promise<void> {
    for (const manifest of await this.manifests()) if (manifest.schemeId === schemeId) await this.remove(manifest.key);
  }
}
