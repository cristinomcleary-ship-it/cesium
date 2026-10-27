import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoOverlayCacheStore, hashVideoOverlayInputs, serializeVideoOverlayCacheInputs, type VideoOverlayCacheMetadata } from './videoOverlayCacheStore.ts';

class MemoryFile {
  readonly kind = 'file';
  readonly name: string;
  bytes = new Blob();
  failClose = false;
  constructor(name: string) { this.name = name; }
  async getFile() { return new File([this.bytes], this.name); }
  async createWritable() {
    let pending = this.bytes;
    return {
      write: async (data: BlobPart) => { pending = new Blob([data]); },
      close: async () => { if (this.failClose) throw new DOMException('Full', 'QuotaExceededError'); this.bytes = pending; },
      abort: async () => {},
    };
  }
}
class MemoryDirectory {
  readonly kind = 'directory';
  readonly name: string;
  readonly children = new Map<string, MemoryFile | MemoryDirectory>();
  readonly blockedRemovals = new Set<string>();
  constructor(name = '') { this.name = name; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const entry = this.children.get(name);
    if (entry instanceof MemoryDirectory) return entry;
    if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
    const directory = new MemoryDirectory(name); this.children.set(name, directory); return directory;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    const entry = this.children.get(name);
    if (entry instanceof MemoryFile) return entry;
    if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
    const file = new MemoryFile(name); this.children.set(name, file); return file;
  }
  async removeEntry(name: string) {
    if (this.blockedRemovals.has(name)) throw new DOMException('File is busy', 'NoModificationAllowedError');
    if (!this.children.delete(name)) throw new DOMException('Missing', 'NotFoundError');
  }
  async *entries() { yield* this.children.entries(); }
}
const key = (number: number) => number.toString(16).padStart(64, '0');
const metadata: VideoOverlayCacheMetadata = { width: 3840, height: 2160, frames: 120, duration: 2,
  start: 4, end: 6, mimeType: 'video/webm', audioStatus: 'captured', frameRate: 60 };
async function setup() {
  const root = new MemoryDirectory();
  const store = await VideoOverlayCacheStore.open({ root: root as unknown as FileSystemDirectoryHandle });
  const directory = [...root.children.values()][0] as MemoryDirectory;
  return { root, store, directory };
}
async function write(handle: FileSystemFileHandle, bytes: string) {
  const stream = await handle.createWritable(); await stream.write(bytes); await stream.close();
}

test('fingerprints include all source bytes, not names; stable descriptors reuse content and support cancellation', async () => {
  const a = new File(['abc'], 'same.mp4'), b = new File(['abd'], 'same.mp4');
  const one = await hashVideoOverlayInputs({ video: a }, { model: { b: 2, a: 1 }, unused: undefined });
  assert.equal(one, await hashVideoOverlayInputs({ video: new File(['abc'], 'renamed.mp4') }, { model: { a: 1, b: 2 } }));
  assert.notEqual(one, await hashVideoOverlayInputs({ video: b }, { model: { a: 1, b: 2 } }));
  assert.notEqual(one, await hashVideoOverlayInputs({ video: a }, { model: { a: 1, b: 3 } }));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(hashVideoOverlayInputs({ video: a }, {}, abort.signal), { name: 'AbortError' });
  assert.throws(() => serializeVideoOverlayCacheInputs({ invalid: NaN }), /无效数值/);
});

test('large input hashing uses bounded slices and later calls reuse immutable Blob hashes', async () => {
  let largest = 0, slices = 0;
  class TrackedBlob extends Blob {
    override slice(start = 0, end = this.size, contentType?: string) {
      slices++; largest = Math.max(largest, end - start); return super.slice(start, end, contentType);
    }
  }
  const file = new TrackedBlob([new Uint8Array(17 * 1024 * 1024)]);
  await hashVideoOverlayInputs({ video: file }, {});
  assert.equal(slices, 3); assert.equal(largest, 8 * 1024 * 1024);
  await hashVideoOverlayInputs({ video: file }, { newModel: true });
  assert.equal(slices, 3);
});

test('pending movies are invisible; publishing survives a new store instance with frame/time metadata intact', async () => {
  const { root, store } = await setup();
  const job = await store.begin(key(1), { schemeId: 'scheme-a' });
  await write(job.handle, 'encoded-native-60fps');
  assert.equal(await store.get(key(1)), undefined);
  const published = await job.commit(metadata);
  assert.equal(published.file.type, 'video/webm'); assert.equal(published.metadata.frames, 120);
  const reopened = await VideoOverlayCacheStore.open({ root: root as unknown as FileSystemDirectoryHandle });
  assert.equal(await (await reopened.get(key(1)))!.file.text(), 'encoded-native-60fps');
  assert.deepEqual((await reopened.get(key(1)))!.metadata, metadata);
  await job.abort(); // A late cancel cannot delete a published result.
  assert.ok(await store.get(key(1)));
});

test('abort deletes only the partial generation and keeps the previous completed cache', async () => {
  const { store, directory } = await setup();
  const first = await store.begin(key(2)); await write(first.handle, 'first'); await first.commit(metadata);
  const second = await store.begin(key(2)); await write(second.handle, 'partial');
  await second.abort(); await second.abort();
  assert.equal(await (await store.get(key(2)))!.file.text(), 'first');
  assert.equal([...directory.children.keys()].filter(name => name.endsWith('.movie')).length, 1);
  await assert.rejects(second.commit(metadata), /已经结束/);
});

test('cancel before publication and quota failure preserve the old atomic manifest', async () => {
  const { store, directory } = await setup();
  const first = await store.begin(key(3)); await write(first.handle, 'old'); await first.commit(metadata);
  const controller = new AbortController(), second = await store.begin(key(3), { signal: controller.signal });
  await write(second.handle, 'new'); controller.abort();
  await assert.rejects(second.commit(metadata), { name: 'AbortError' }); await second.abort();
  assert.equal(await (await store.get(key(3)))!.file.text(), 'old');
  const third = await store.begin(key(3)); await write(third.handle, 'newest');
  (directory.children.get(`${key(3)}.json`) as MemoryFile).failClose = true;
  await assert.rejects(third.commit(metadata), /空间不足/);
  assert.equal(await (await store.get(key(3)))!.file.text(), 'old');
  assert.equal([...directory.children.keys()].filter(name => name.endsWith('.movie')).length, 1);
});

test('retention keeps two completed versions per scheme without deleting another scheme', async () => {
  const { store } = await setup();
  for (const [id, schemeId] of [[4, 'a'], [5, 'b'], [6, 'a'], [7, 'a']] as const) {
    const job = await store.begin(key(id), { schemeId }); await write(job.handle, `movie-${id}`); await job.commit(metadata);
  }
  assert.equal(await store.get(key(4)), undefined);
  assert.ok(await store.get(key(5))); assert.ok(await store.get(key(6))); assert.ok(await store.get(key(7)));
  await store.removeScheme('a');
  assert.equal(await store.get(key(6)), undefined); assert.equal(await store.get(key(7)), undefined);
  assert.ok(await store.get(key(5)));
});

test('empty, truncated and invalid cache records are never offered for playback', async () => {
  const { store, directory } = await setup();
  const empty = await store.begin(key(8)); await assert.rejects(empty.commit(metadata), /尚未写入完成/);
  const complete = await store.begin(key(9)); await write(complete.handle, 'data'); await complete.commit(metadata);
  const manifest = JSON.parse(await (await directory.getFileHandle(`${key(9)}.json`)).getFile().then(f => f.text()));
  (await directory.getFileHandle(manifest.file)).bytes = new Blob(['truncated']);
  assert.equal(await store.get(key(9)), undefined);
  await assert.rejects(store.get('../escape'), /标识无效/);
  const invalid = await store.begin(key(10)); await write(invalid.handle, 'data');
  await assert.rejects(invalid.commit({ ...metadata, frames: 0 }), /无效/); await invalid.abort();
});

for (const blocked of ['movie', 'manifest']) {
  test(`scheme deletion retains retry ownership after ${blocked} removal fails and finishes after reopening`, async () => {
    const { root, store, directory } = await setup();
    const target = await store.begin(key(11), { schemeId: 'deleted-scheme' });
    await write(target.handle, 'target bytes'); await target.commit(metadata);
    const unrelated = await store.begin(key(12), { schemeId: 'kept-scheme' });
    await write(unrelated.handle, 'keep bytes'); await unrelated.commit(metadata);
    const manifestName = `${key(11)}.json`;
    const manifest = JSON.parse(await (await directory.getFileHandle(manifestName)).getFile().then(file => file.text()));
    directory.blockedRemovals.add(blocked === 'movie' ? manifest.file : manifestName);
    await assert.rejects(store.removeScheme('deleted-scheme'));
    assert.equal(directory.children.has(manifestName), true, 'retry ownership survives any failed deletion');
    assert.equal(directory.children.has(manifest.file), blocked === 'movie');
    const reopened = await VideoOverlayCacheStore.open({ root: root as unknown as FileSystemDirectoryHandle });
    if (blocked === 'manifest') assert.equal(await reopened.get(key(11)), undefined, 'a missing movie is never offered as a playable cache');
    directory.blockedRemovals.clear();
    await reopened.removeScheme('deleted-scheme'); await reopened.removeScheme('deleted-scheme');
    assert.equal(directory.children.has(manifestName), false); assert.equal(directory.children.has(manifest.file), false);
    assert.equal(await (await reopened.get(key(12)))!.file.text(), 'keep bytes');
  });
}
