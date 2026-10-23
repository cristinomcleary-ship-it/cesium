import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';

// Exercise the real controller boundary, not just the queue's scoped-flush API.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(workspace + '/.video-overlay-autosave-test-');
assert.ok(resolve(directory).startsWith(workspace + sep), 'temporary fixture stays within this workspace');
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { VideoOverlayAutosave } from "./src/videoOverlayAutosave.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: directory + '/fixture.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { VideoModelOverlay, VideoOverlayAutosave } = await import(pathToFileURL(directory + '/fixture.mjs').href);
  const failedSessions = new Set(['1']), calls = [];
  let currentSnapshot = Object.freeze({ marker: 'B-1' });
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    autoSaveReady: true, accessInvalid: false, sessionGeneration: 2,
    editRevision: 1, persistedRevision: 1, savedId: 'id-B', onSave() {},
    captureSnapshot() { return currentSnapshot; },
  });
  owner.autosave = new VideoOverlayAutosave({ save: async job => {
    calls.push(job);
    if (failedSessions.has(job.session)) throw new Error('offline-' + job.session);
    return job.existingId;
  } });
  const oldSnapshot = Object.freeze({ marker: 'A-unsaved', file: new Blob(['old draft']) });
  await assert.rejects(owner.autosave.submit({ session: '1', revision: 4, snapshot: oldSnapshot, existingId: 'id-A' }), /offline-1/);
  await owner.autosave.submit({ session: '2', revision: 1, snapshot: currentSnapshot, existingId: 'id-B' });
  await owner.flushPendingSave();
  assert.equal(owner.autosave.hasPending, true, 'the old draft still triggers the existing beforeunload guard');
  await assert.rejects(owner.autosave.flush(), /未保存/, 'global flush must still report the retained old failure');
  assert.equal(calls.length, 2, 'switching away from a saved session must not retry or discard the failed old draft');

  // A dirty current session still queues its immutable snapshot and blocks switching on failure.
  currentSnapshot = Object.freeze({ marker: 'B-2' }); owner.editRevision = 2; failedSessions.add('2');
  await assert.rejects(owner.flushPendingSave(), /offline-2/);
  assert.equal(calls.at(-1).snapshot, currentSnapshot);
  owner.persistedRevision = 2;
  await assert.rejects(owner.flushPendingSave(), /未保存/, 'a current retained failure blocks even with no new edits');
  failedSessions.delete('2'); await owner.autosave.retry('2');
  await owner.flushPendingSave();
  assert.equal(owner.autosave.hasPending, true, 'recovering the current session does not discard the old session');

  failedSessions.delete('1'); await owner.autosave.retry('1');
  assert.equal(calls.at(-1).snapshot, oldSnapshot, 'explicit retry preserves the original draft and file reference');
  assert.equal(calls.at(-1).existingId, 'id-A', 'retry never targets the newly opened scheme');
  assert.equal(owner.autosave.hasPending, false);
  await owner.autosave.flush();
  console.log('PASS: controller flush scopes old failures, retains drafts and unload protection, and blocks failed current saves');
} finally {
  await rm(directory, { recursive: true, force: true });
}
