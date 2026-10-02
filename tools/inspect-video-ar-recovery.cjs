// Inspect persisted project state without launching Cesium or modifying project-data.
// Historical reports are comparison inputs, never the source of the active record ID.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const keyframeSeconds = [10.01, 30, 60, 90, 114];
const readJson = async filename => JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));

async function readJsonSnapshot(filename) {
  const bytes = await fs.readFile(filename);
  return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')),
    binding: { path: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

function childPath(parent, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:]/.test(name)) {
    throw new Error('Invalid record ID or file name: ' + String(name));
  }
  return path.join(parent, name);
}

async function fingerprint(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { path: filename, bytes: (await fs.stat(filename)).size, sha256: hash.digest('hex') };
}

async function inspectRecovery({ dataDir, baselinePath }) {
  dataDir = path.resolve(dataDir);
  const report = {
    schema: 'video-ar-recovery-inspection/v1', capturedAt: new Date().toISOString(), dataDir,
    scope: 'Persisted settings and files only; no live browser, decoder, depth or accuracy measurement.',
    acceptance: 'not-validated', activeVideoId: null, savedControls: null, sessions: [], models: [],
    bindings: {}, historicalComparison: null, gaps: [], errors: [],
    notes: [
      'File SHA256 binds current bytes. A model entry hash does not cover the full tile tree.',
      'Saved point roles and solutions are unverified records, not proof of manual confirmation or independent accuracy.',
      'Keyframe metrics and coverage are null because this inspection does not measure reprojection or visible-surface truth.',
      'Run again after saving points. Do not reuse historical runtime-camera results for a different active record or configuration.',
    ],
  };
  const bind = async (key, filename) => {
    try { report.bindings[key] = await fingerprint(filename); }
    catch (error) { report.errors.push(key + ': ' + error.message); }
  };
  const readRecord = async id => {
    const recordDir = childPath(path.join(dataDir, 'records'), id);
    const filename = path.join(recordDir, 'record.json');
    const { value: record, binding } = await readJsonSnapshot(filename);
    if (record.id !== id) throw new Error('Record ID does not match its directory: ' + id);
    return { record, recordDir, binding };
  };
  const bindSlot = async (key, recordDir, record, slot) => {
    if (!record.files?.[slot]?.name) {
      report.errors.push(key + ': missing saved ' + slot + ' file');
      return;
    }
    await bind(key, childPath(path.join(recordDir, slot), record.files[slot].name));
  };
  const viewPath = path.join(dataDir, 'view.json');

  try {
    const { value: view, binding } = await readJsonSnapshot(viewPath);
    report.bindings.view = binding;
    report.activeVideoId = view.activeVideoId || null;
    if (!report.activeVideoId) report.gaps.push('No active video is saved in view.json.');
    else {
      const { record, recordDir, binding } = await readRecord(report.activeVideoId);
      if (record.kind !== 'Drone Video') throw new Error('Active record is not a Drone Video.');
      report.bindings.activeRecord = binding;
      await bindSlot('activeVideo', recordDir, record, 'video');
      await bindSlot('trajectory', recordDir, record, 'source');
      report.savedControls = record.settings?.video?.controls ?? {};
      const sessions = record.settings?.video?.calibrationSessions ?? [];
      if (!Array.isArray(sessions)) throw new Error('Saved calibrationSessions is not an array.');
      report.sessions = sessions.map(session => ({
        id: session?.id ?? null, frameTime: session?.frame?.frameTime ?? null,
        sourceKey: session?.frame?.sourceKey ?? null,
        fitCount: Array.isArray(session?.points) ? session.points.filter(p => p?.role === 'fit').length : 0,
        checkCount: Array.isArray(session?.points) ? session.points.filter(p => p?.role === 'check').length : 0,
        status: session?.status ?? null, applicationStatus: session?.applicationStatus ?? null,
        hasSolution: Boolean(session?.solution), acceptance: 'not-validated',
      }));
      if (!sessions.length) report.gaps.push('No saved point pairs. At 10.01s collect 8–12 fit points and at least 6 independent checkpoints.');
      if (report.savedControls.videoArSurfaceMode !== 'model') report.gaps.push('Saved projection mode is not model; use the existing model projection control before model registration.');
      if (!report.savedControls.videoArHeightMode || report.savedControls.videoArHeightMode === 'estimated') {
        report.gaps.push('Height datum remains estimated; no fixed +29.116m or other height correction is inferred.');
      }
    }
  } catch (error) { report.errors.push('active project: ' + error.message); }

  try {
    const entries = await fs.readdir(path.join(dataDir, 'records'), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === report.activeVideoId) continue;
      try {
        const { record, recordDir, binding } = await readRecord(entry.name);
        if (record.kind !== '3D Tiles') continue;
        report.models.push({ id: record.id, name: record.name, visible: record.visible === true,
          settings: record.settings ?? null });
        report.bindings['modelRecord:' + record.id] = binding;
        await bindSlot('modelEntry:' + record.id, recordDir, record, 'tiles');
      } catch (error) { report.errors.push('record ' + entry.name + ': ' + error.message); }
    }
  } catch (error) { report.errors.push('record listing: ' + error.message); }
  if (!report.models.some(model => model.visible)) report.gaps.push('No saved visible 3D Tiles model; enable it through the existing model visibility control.');

  report.keyframes = keyframeSeconds.map(requestedSeconds => ({
    requestedSeconds,
    // Decoded PTS may differ slightly from requested seek time. These are candidate records only.
    candidateSessions: report.sessions.filter(session => typeof session.frameTime === 'number'
      && Math.abs(session.frameTime - requestedSeconds) <= 0.05).map(session => session.id),
    acceptance: 'not-validated', rmsPx1080: null, p95Px1080: null, maxPx1080: null, validCoverage: null,
  }));
  if (baselinePath) {
    try {
      const baseline = await readJson(baselinePath);
      const equal = (current, old) => current?.sha256 && old?.sha256 ? current.sha256 === old.sha256 : null;
      report.historicalComparison = {
        path: path.resolve(baselinePath), activeVideoId: baseline.activeVideoId ?? null,
        sameActiveRecord: baseline.activeVideoId ? baseline.activeVideoId === report.activeVideoId : null,
        sameVideoBytes: equal(report.bindings.activeVideo, baseline.activeVideo),
        sameTrajectoryBytes: equal(report.bindings.trajectory, baseline.trajectory),
        models: report.models.map(model => ({ id: model.id,
          sameEntryBytes: equal(report.bindings['modelEntry:' + model.id], baseline.modelEntry) })),
        runtimeEvidenceReused: false,
      };
    } catch (error) { report.errors.push('historical comparison: ' + error.message); }
  }
  // Detect concurrent record/view changes so a mixed snapshot is not presented as a stable saved state.
  for (const [key, before] of Object.entries(report.bindings)) {
    if (key !== 'view' && key !== 'activeRecord' && !key.startsWith('modelRecord:')) continue;
    try {
      if ((await fingerprint(before.path)).sha256 !== before.sha256) report.errors.push(key + ': changed during inspection; rerun after saving.');
    } catch (error) { report.errors.push(key + ': ' + error.message); }
  }
  report.inspectionStatus = report.errors.length ? 'incomplete' : 'complete';
  return report;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  let dataDir = process.env.CESIUM_DATA_DIR || path.join(root, 'project-data');
  let baselinePath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
    else if (args[i] === '--baseline' && args[i + 1]) baselinePath = args[++i];
    else throw new Error('Usage: node tools/inspect-video-ar-recovery.cjs [--data-dir DIR] [--baseline SOURCE_BINDINGS_JSON]');
  }
  const report = await inspectRecovery({ dataDir, baselinePath });
  // A fresh directory avoids overwriting baseline reports or a previous inspection.
  const outputRoot = path.join(root, 'output', 'video-ar-recovery');
  await fs.mkdir(outputRoot, { recursive: true });
  const run = await fs.mkdtemp(path.join(outputRoot, 'run-'));
  const reportPath = path.join(run, 'state.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ reportPath, activeVideoId: report.activeVideoId,
    inspectionStatus: report.inspectionStatus, acceptance: report.acceptance,
    savedSessionCount: report.sessions.length, gaps: report.gaps, errors: report.errors }, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

module.exports = { inspectRecovery };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
