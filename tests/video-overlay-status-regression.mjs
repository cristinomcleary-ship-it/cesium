import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';

// Paused request-render scenes can finish all loading before a throttle expires.
// Exercise the actual controller formatter with no subsequent render or timer.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(workspace + '/.video-overlay-status-test-');
assert.ok(resolve(directory).startsWith(workspace + sep));
const originalPerformance = globalThis.performance;
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: directory + '/fixture.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { VideoModelOverlay } = await import(pathToFileURL(directory + '/fixture.mjs').href);
  let now = 1000, writes = 0, text = '';
  globalThis.performance = { now: () => now };
  const element = { get textContent() { return text; }, set textContent(value) { writes++; text = value; } };
  let status = { enabled: true, ready: false };
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    occlusion: { enabled: true, sourceId: 'explicit-survey' },
    resources: { getOcclusionStatus: () => status },
    checkOcclusionSource() {}, el: () => element,
  });
  owner.updateOcclusionStatus();
  assert.match(text, /点击.*开始融合/);
  owner.restoreScene = () => {};
  now += 10; owner.updateOcclusionStatus();
  assert.match(text, /正在加载/, 'entering a paused scene must immediately replace inactive status');
  now += 10; status = { enabled: true, ready: true }; owner.updateOcclusionStatus();
  assert.match(text, /实景遮挡已生效/, 'the final ready render within 250 ms must not leave loading text forever');
  const finalWrites = writes;
  for (let frame = 0; frame < 20; frame++) owner.updateOcclusionStatus();
  assert.equal(writes, finalWrites, 'unchanged completed coverage does not cause repeated DOM writes');
  status = { enabled: true, ready: true, refining: true }; owner.updateOcclusionStatus();
  assert.match(text, /正在补充细节/);
  status = { enabled: true, ready: false, error: 'fixture access revoked' }; owner.updateOcclusionStatus();
  assert.match(text, /fixture access revoked/, 'a fast failure transition is shown immediately');
  owner.restoreScene = undefined; owner.updateOcclusionStatus();
  assert.match(text, /点击.*开始融合/, 'exit restores inactive instructions immediately');
  console.log('PASS: paused occlusion status follows the last completed render, failure and exit without redundant DOM writes');
} finally {
  globalThis.performance = originalPerformance;
  await rm(directory, { recursive: true, force: true });
}
