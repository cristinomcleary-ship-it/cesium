import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installStagedBuild } from '../tools/install-staged-build.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cesium-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'output', 'deploy-build-test');
  const put = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  put('dist/index.html', 'old'); put('dist/models/user.glb', 'user-model');
  put('project-data/settings.json', 'user-settings');
  put('output/deploy-build-test/index.html', 'new');
  put('output/deploy-build-test/assets/new.js', 'new-script');
  return { root, stage, put, read: relative => fs.readFileSync(path.join(root, relative), 'utf8') };
}

test('installs the new build while preserving unmatched models and settings without an old-build copy', t => {
  const f = fixture(t);
  assert.equal(installStagedBuild(f.root, f.stage).installedFiles, 2);
  assert.equal(f.read('dist/index.html'), 'new');
  assert.equal(f.read('dist/assets/new.js'), 'new-script');
  assert.equal(f.read('dist/models/user.glb'), 'user-model');
  assert.equal(f.read('project-data/settings.json'), 'user-settings');
  assert.equal(fs.existsSync(f.stage), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['dist', 'output', 'project-data']);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'output')), []);
});

test('data-root collision is rejected before replacing any deployed file', t => {
  const f = fixture(t);
  f.put('output/deploy-build-test/models/user.glb', 'overwritten');
  assert.throws(() => installStagedBuild(f.root, f.stage, ['dist/models']), /data directory/);
  assert.equal(f.read('dist/index.html'), 'old');
  assert.equal(f.read('dist/models/user.glb'), 'user-model');
});

test('linked destination directories cannot redirect installation into project data', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'project-data'), path.join(f.root, 'dist', 'assets'), 'junction');
  assert.throws(() => installStagedBuild(f.root, f.stage), /linked build path/);
  assert.equal(f.read('dist/index.html'), 'old');
  assert.equal(f.read('project-data/settings.json'), 'user-settings');
});

test('a data-root alias into dist is protected before any deployed file changes', t => {
  const f = fixture(t);
  f.put('dist/assets/new.js', 'user-data');
  const alias = path.join(f.root, 'external-data');
  fs.symlinkSync(path.join(f.root, 'dist', 'assets'), alias, 'junction');
  assert.throws(() => installStagedBuild(f.root, f.stage, [alias]), /data directory/);
  assert.equal(f.read('dist/index.html'), 'old');
  assert.equal(f.read('dist/assets/new.js'), 'user-data');
});

test('missing entry point, unexpected path types and non-staging paths leave the old app untouched', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.stage, 'index.html'));
  assert.throws(() => installStagedBuild(f.root, f.stage), /no index.html/);
  f.put('output/deploy-build-test/index.html', 'new');
  f.put('dist/assets', 'user-file');
  assert.throws(() => installStagedBuild(f.root, f.stage), /Unexpected build path type/);
  assert.throws(() => installStagedBuild(f.root, path.join(f.root, 'project-data')), /dedicated/);
  assert.equal(f.read('dist/index.html'), 'old');
});
