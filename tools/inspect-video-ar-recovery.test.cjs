const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectRecovery } = require('./inspect-video-ar-recovery.cjs');

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-ar-inspection-test-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    assert.match(relative, /^video-ar-inspection-test-[^\\/]+$/);
    return fs.rm(dir, { recursive: true, force: true });
  });
  const originalFiles = new Map();
  const put = async (relative, value) => {
    const filename = path.join(dir, relative);
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, data);
    originalFiles.set(filename, data);
  };
  const video = { id: 'new-video', kind: 'Drone Video', settings: { video: { controls: {
    videoArSurfaceMode: 'terrain', videoArHeightMode: 'estimated', videoArEnableCalibration: false,
  }, calibrationSessions: [] } }, files: { video: { name: 'original.mp4' }, source: { name: 'trajectory.json' } } };
  await put('view.json', { activeVideoId: video.id });
  await put('records/new-video/record.json', video);
  await put('records/new-video/video/original.mp4', 'original video bytes');
  await put('records/new-video/source/trajectory.json', 'original trajectory bytes');
  await put('records/model/record.json', { id: 'model', kind: '3D Tiles', visible: false,
    files: { tiles: { name: 'tileset.json' } } });
  await put('records/model/tiles/tileset.json', '{}');
  await put('baseline.json', { activeVideoId: 'deleted-video',
    activeVideo: { sha256: sha('original video bytes') },
    trajectory: { sha256: sha('original trajectory bytes') }, modelEntry: { sha256: sha('{}') } });
  return { dir, put, video, originalFiles };
}

test('uses current active record, compares bytes separately from ID, and leaves every input unchanged', async t => {
  const f = await fixture(t);
  const report = await inspectRecovery({ dataDir: f.dir, baselinePath: path.join(f.dir, 'baseline.json') });
  assert.equal(report.inspectionStatus, 'complete');
  assert.equal(report.activeVideoId, 'new-video');
  assert.equal(report.historicalComparison.sameActiveRecord, false);
  assert.equal(report.historicalComparison.sameVideoBytes, true);
  assert.equal(report.historicalComparison.sameTrajectoryBytes, true);
  assert.equal(report.historicalComparison.runtimeEvidenceReused, false);
  assert.equal(report.sessions.length, 0);
  assert.ok(report.gaps.some(gap => gap.includes('No saved point pairs')));
  assert.ok(report.gaps.some(gap => gap.includes('not model')));
  assert.ok(report.gaps.some(gap => gap.includes('No saved visible')));
  for (const [filename, original] of f.originalFiles) assert.equal(await fs.readFile(filename, 'utf8'), original);
});

test('saved solved sessions are candidate evidence, never accepted accuracy or zero missing error', async t => {
  const f = await fixture(t);
  f.video.settings.video.calibrationSessions = [{ id: 'points', frame: { frameTime: 29.996633 },
    status: 'solved-not-accepted', solution: {}, summary: { rmsePx: 0 },
    points: [...Array.from({ length: 8 }, () => ({ role: 'fit' })),
      ...Array.from({ length: 6 }, () => ({ role: 'check' }))] }];
  await f.put('records/new-video/record.json', f.video);
  const report = await inspectRecovery({ dataDir: f.dir });
  assert.equal(report.sessions[0].fitCount, 8);
  assert.equal(report.sessions[0].checkCount, 6);
  assert.equal(report.sessions[0].acceptance, 'not-validated');
  assert.deepEqual(report.keyframes.find(frame => frame.requestedSeconds === 30).candidateSessions, ['points']);
  for (const frame of report.keyframes) {
    assert.equal(frame.rmsPx1080, null);
    assert.equal(frame.p95Px1080, null);
    assert.equal(frame.maxPx1080, null);
    assert.equal(frame.validCoverage, null);
  }
});

test('missing active records and malformed paths are reported instead of falling back to historical IDs', async t => {
  const f = await fixture(t);
  await f.put('view.json', { activeVideoId: 'missing-video' });
  const missing = await inspectRecovery({ dataDir: f.dir });
  assert.equal(missing.activeVideoId, 'missing-video');
  assert.equal(missing.inspectionStatus, 'incomplete');
  assert.ok(missing.errors.some(error => error.includes('ENOENT')));
  await f.put('view.json', { activeVideoId: '../baseline.json' });
  const invalid = await inspectRecovery({ dataDir: f.dir });
  assert.equal(invalid.inspectionStatus, 'incomplete');
  assert.ok(invalid.errors.some(error => error.includes('Invalid record ID')));
  assert.equal(invalid.bindings.activeRecord, undefined);
});

test('a settings save between snapshot read and later file checks is detected', async t => {
  const f = await fixture(t);
  const filename = path.join(f.dir, 'records/new-video/record.json');
  const originalRecord = await fs.readFile(filename);
  const readFile = fs.readFile.bind(fs);
  let changed = false;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    const result = await readFile(file, ...args);
    if (file === filename && !changed) {
      changed = true;
      const updated = structuredClone(f.video);
      updated.settings.video.controls.videoArSurfaceMode = 'model';
      await fs.writeFile(filename, JSON.stringify(updated));
    }
    return result;
  });
  const report = await inspectRecovery({ dataDir: f.dir });
  assert.equal(report.savedControls.videoArSurfaceMode, 'terrain');
  assert.equal(report.bindings.activeRecord.sha256, sha(originalRecord));
  assert.equal(report.inspectionStatus, 'incomplete');
  assert.ok(report.errors.some(error => error.includes('activeRecord: changed during inspection')));
});