import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMachineryAsset, defaultMachineryParameters } from './machinery/index';
import { MACHINERY_ASSET_VERSION } from './machineryTypes';
import { MachineryCaptureSession, type MachineryCaptureContext } from './machineryCaptureSession';
import type { MachineryPoseSnapshot } from './machineryPoseRecorder';
const assetPromise = loadMachineryAsset('crane', { baseUrl: new URL('../public/machinery/', import.meta.url).href,
  fetcher: async input => new Response(new Uint8Array(await readFile(fileURLToPath(String(input))))) });
function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; }
const context = (projectId = 'project-a', actorId = 'actor-a'): MachineryCaptureContext => ({ projectId, actorId, active: true, canView: true, canEdit: true,
  records: [{ id: 'machine-a', name: '吊机 A', assetId: 'crane' }, { id: 'machine-b', name: '吊机 B', assetId: 'crane' }] });
async function snapshot(resourceId = 'machine-a', projectId = 'project-a'): Promise<MachineryPoseSnapshot> {
  const asset = await assetPromise;
  return { projectId, resourceId, resourceName: resourceId, asset, state: { schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION,
    parameters: defaultMachineryParameters(asset), proportional: false, visible: true, placement: { longitude: 121, latitude: 31, height: 5, heading: 0 } } };
}
test('recording stays with its started mechanical resource across selection and background live observations', async () => {
  const session = new MachineryCaptureSession(storage()); session.setContext(context());
  const initial = session.remember(await snapshot())!; session.recorder.start(initial);
  session.remember(await snapshot('machine-b'));
  const other = await snapshot('machine-b'); other.state.placement.heading = 20;
  assert.equal(session.observe('machine-b', other.state), false); assert.equal(session.recorder.count, 1);
  const current = structuredClone(initial.state); current.placement.heading = 30;
  assert.equal(session.observe('machine-a', current), true); assert.equal(session.recorder.count, 2);
  assert.equal(session.recorder.activeResource?.resourceId, 'machine-a');
  session.destroy(); assert.equal(session.recorder.isRecording, false); assert.equal(session.recorder.count, 2);
});
test('account/project switches stop but preserve scoped histories and never auto-resume', async () => {
  const saved = storage(), session = new MachineryCaptureSession(saved); session.setContext(context());
  session.recorder.start(session.remember(await snapshot())!); const original = session.recorder;
  session.setContext(context('project-b')); assert.equal(original.isRecording, false); assert.equal(session.recorder.count, 0);
  session.recorder.start(session.remember(await snapshot('machine-a', 'project-b'))!);
  session.setContext(context('project-a', 'actor-b')); assert.equal(session.recorder.count, 0);
  session.setContext(context()); assert.equal(session.recorder, original); assert.equal(session.recorder.count, 1); assert.equal(session.recorder.isRecording, false);
  const reloaded = new MachineryCaptureSession(saved); reloaded.setContext(context()); assert.equal(reloaded.recorder.count, 1); assert.equal(reloaded.recorder.isRecording, false);
  session.destroy(); reloaded.destroy();
});
test('view permission loss hides history and stops recording; regrant restores retained rows', async () => {
  const session = new MachineryCaptureSession(storage()); session.setContext(context()); session.recorder.start(session.remember(await snapshot())!);
  const archive = session.recorder;
  session.setContext({ ...context(), canView: false }); assert.equal(archive.isRecording, false); assert.equal(session.recorder.count, 0);
  const changed = (await snapshot()).state; changed.placement.heading = 90;
  assert.equal(session.observe('machine-a', changed), false);
  session.setContext(context()); assert.equal(session.recorder, archive); assert.equal(session.recorder.count, 1); assert.equal(session.recorder.isRecording, false);
});
test('manual previews retain source convention and actual telemetry timestamps while removed targets stop', async () => {
  const session = new MachineryCaptureSession(storage()); session.setContext(context()); const initial = session.remember(await snapshot())!; session.recorder.start(initial);
  const changed = structuredClone(initial.state); changed.placement.heading = 90;
  const timestamp = '2026-10-29T12:00:00.123Z';
  session.observe('machine-a', changed, { provenance: { heading: { source: 'simulated', sourceId: 'browser-sim', sourceField: 'heading', sampleTimestamp: timestamp } } });
  const change = session.recorder.recent(1)[0].changes.find(field => field.field === 'heading')!;
  assert.equal(change.source, 'simulated'); assert.equal(change.samples[0].sampleTimestamp, timestamp);
  session.setContext({ ...context(), records: [] }); assert.equal(session.recorder.isRecording, false); assert.equal(session.recorder.count, 2);
});


test('removing a 3D instance or changing its asset stops capture even when its resource row remains', async () => {
  for (const assetId of [undefined, 'pile'] as const) {
    const session = new MachineryCaptureSession(storage()); session.setContext(context());
    session.recorder.start(session.remember(await snapshot())!);
    session.setContext({ ...context(), records: [{ id: 'machine-a', name: '吊机 A', assetId }] });
    assert.equal(session.recorder.isRecording, false); assert.equal(session.recorder.count, 1);
  }
});
