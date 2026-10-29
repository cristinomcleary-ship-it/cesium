import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultMachineryParameters, loadMachineryAsset, resolveMachineryParameters } from './machinery/index';
import type { LoadedMachineryAsset } from './machinery/types';
import { MACHINERY_ASSET_VERSION } from './machineryTypes';
import { canonicalBoomToSource, MachineryTelemetryState, defaultMachineryTelemetryConfig } from './machineryTelemetry';
import { MachineryPoseRecorder, machineryPoseBeijingTime, machineryPoseCsvCell, poseProvenanceFromTelemetry, type MachineryPoseSnapshot } from './machineryPoseRecorder';

let assetPromise: Promise<LoadedMachineryAsset> | undefined;
const time = Date.parse('2026-10-29T02:30:00.123Z');
async function input(): Promise<MachineryPoseSnapshot> {
  const asset = await (assetPromise ??= loadMachineryAsset('crane', {
    baseUrl: new URL('../public/machinery/', import.meta.url).href,
    fetcher: async url => new Response(new Uint8Array(await readFile(fileURLToPath(String(url))))),
  }));
  return { projectId: 'p1', resourceId: 'crane1', resourceName: '01号吊机', asset,
    state: { schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION, proportional: false,
      parameters: defaultMachineryParameters(asset), placement: { longitude: 120, latitude: 30, height: 10, heading: 90 }, visible: true } };
}
function edited(source: MachineryPoseSnapshot, changes: Record<string, number>): MachineryPoseSnapshot {
  return { ...source, state: { ...source.state, parameters: resolveMachineryParameters(source.asset, source.state.parameters, changes, { proportional: false }) } };
}
function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test('explicit start captures one complete snapshot, subsequent records contain only changes in canonical units', async () => {
  const source = await input();
  source.state.parameters = resolveMachineryParameters(source.asset, source.state.parameters,
    { boom_rotation_deg: canonicalBoomToSource(source.asset, 0) }, { proportional: false });
  const recorder = new MachineryPoseRecorder({ now: () => time, timeZone: 'Asia/Shanghai' });
  assert.equal(recorder.observe(source), false); assert.equal(recorder.count, 0);
  assert.equal(recorder.start(source), true);
  const first = recorder.snapshot().entries[0];
  assert.equal(first.kind, 'initial'); assert.equal(first.localTime, '2026-10-29 10:30:00');
  assert.equal(first.recordedAt, '2026-10-29T02:30:00.123Z');
  assert.equal(first.changes.find(c => c.field === 'boom_rotation_deg')?.value, 0);
  assert.ok(first.changes.every(change => change.previous === null));
  assert.equal(recorder.observe(source), false, 'unchanged samples do not become a false activity log');
  const next = edited(source, { boom_length_m: 38 }); recorder.observe(next);
  const changed = recorder.snapshot().entries[1];
  assert.deepEqual(changed.changes.map(c => c.field).sort(), ['boom_length_m', 'overall_height_m']);
  assert.match(changed.description, /2026-10-29 10:30:00 01号吊机：.*吊臂伸长至38 m/);
  assert.equal(changed.changes.find(c => c.field === 'boom_length_m')?.unit, 'm');
  assert.equal(changed.changes.find(c => c.field === 'boom_length_m')?.source, 'manual');
});

test('per-field acquisition timestamps are retained exactly across partial telemetry and stale data', async () => {
  const source = await input(), config = defaultMachineryTelemetryConfig('p1', 'crane1');
  config.bindings = ['boom_length_m', 'boom_elevation_deg'].map(target => ({ target, enabled: true, sourceId: 'device', sourceField: target, scale: 1, offset: 0 }));
  const engine = new MachineryTelemetryState(source.asset, source.state, config);
  engine.apply({ schemaVersion: 1, projectId: 'p1', resourceId: 'crane1', sourceId: 'device', mode: 'measured', timestamp: '2026-10-29T02:29:50.000Z', values: { boom_length_m: 35, boom_elevation_deg: 60 } }, time);
  const recorder = new MachineryPoseRecorder({ now: () => time, timeZone: 'Asia/Shanghai' });
  recorder.start({ ...source, state: engine.state, provenance: poseProvenanceFromTelemetry(engine.fieldStatus(time)) });
  engine.apply({ schemaVersion: 1, projectId: 'p1', resourceId: 'crane1', sourceId: 'device', mode: 'measured', timestamp: '2026-10-29T02:29:58.000Z', values: { boom_length_m: 38 } }, time);
  const provenance = poseProvenanceFromTelemetry(engine.fieldStatus(time));
  assert.equal(provenance.boom_elevation_deg.sampleTimestamp, '2026-10-29T02:29:50.000Z');
  assert.equal(provenance.boom_length_m.sampleTimestamp, '2026-10-29T02:29:58.000Z');
  recorder.observe({ ...source, state: engine.state, provenance });
  const last = recorder.snapshot().entries.at(-1)!;
  const boom = last.changes.find(change => change.field === 'boom_length_m')!;
  assert.equal(boom.source, 'measured'); assert.equal(boom.samples[0].sampleTimestamp, '2026-10-29T02:29:58.000Z');
  assert.equal(last.recordedAt, '2026-10-29T02:30:00.123Z');
  assert.ok(!last.changes.some(change => change.field === 'boom_elevation_deg'));
  const derived = last.changes.find(change => change.field === 'overall_height_m')!;
  assert.deepEqual(derived.derivedFrom, ['boom_length_m']); assert.equal(derived.source, 'measured');
  assert.equal(derived.samples[0].sampleTimestamp, boom.samples[0].sampleTimestamp);
});

test('simulated, manual and measured sources remain separate and do not invent sample times', async () => {
  const source = await input(), recorder = new MachineryPoseRecorder({ now: () => time });
  recorder.start(source);
  const next = edited(source, { boom_length_m: 7 });
  recorder.observe({ ...next, provenance: { boom_length_m: { source: 'simulated', sourceId: 'browser-sim', sourceField: 'length', sampleTimestamp: '2026-10-29T02:29:59Z' } } });
  const simulated = recorder.snapshot().entries[1].changes.find(c => c.field === 'boom_length_m')!;
  assert.equal(simulated.source, 'simulated'); assert.equal(simulated.samples[0].sampleTimestamp, '2026-10-29T02:29:59.000Z');
  const manual = recorder.snapshot().entries[0].changes.find(c => c.field === 'boom_length_m')!;
  assert.equal(manual.source, 'manual'); assert.equal(manual.samples[0].sampleTimestamp, null);
  assert.throws(() => recorder.observe({ ...edited(next, { boom_length_m: 8 }), provenance: { boom_length_m: { source: 'measured', sampleTimestamp: '2026-02-30T00:00:00Z' } } }), /采样时间/);
  assert.equal(recorder.count, 2);
});

test('recording remains attached to its start resource and stops without clearing existing records', async () => {
  const source = await input(), recorder = new MachineryPoseRecorder({ now: () => time });
  recorder.start(source);
  assert.equal(recorder.observe({ ...edited(source, { boom_length_m: 8 }), resourceId: 'other' }), false);
  assert.equal(recorder.observe({ ...edited(source, { boom_length_m: 8 }), projectId: 'other' }), false);
  assert.equal(recorder.activeResource?.resourceId, 'crane1');
  assert.equal(recorder.observe(edited(source, { boom_length_m: 8 })), true);
  recorder.stop(); assert.equal(recorder.count, 2);
  assert.equal(recorder.observe(edited(source, { boom_length_m: 9 })), false);
  recorder.start({ ...source, resourceId: 'other' }); assert.equal(recorder.count, 3);
  assert.equal(recorder.snapshot().entries[2].kind, 'initial');
});

test('bounded recorder stops at capacity and never rotates or truncates old records', async () => {
  const source = await input(), recorder = new MachineryPoseRecorder({ maxEntries: 2, now: () => time });
  recorder.start(source); const original = recorder.snapshot().entries[0];
  recorder.observe(edited(source, { boom_length_m: 8 }));
  assert.equal(recorder.isRecording, false); assert.match(recorder.status, /上限.*停止/);
  assert.equal(recorder.start(source), false); assert.equal(recorder.observe(source), false);
  assert.equal(recorder.count, 2); assert.deepEqual(recorder.snapshot().entries[0], original);
  recorder.clear(); assert.equal(recorder.count, 0); assert.equal(recorder.start(source), true);
});

test('persistent history survives re-creation without automatic recording or export deletion', async () => {
  const source = await input(), storage = memoryStorage();
  const options = { now: () => time, storage, storageKey: 'actor-a:project-a' };
  const first = new MachineryPoseRecorder(options); first.start(source); first.observe(edited(source, { boom_length_m: 8 }));
  const restored = new MachineryPoseRecorder(options);
  assert.equal(restored.count, 2); assert.equal(restored.isRecording, false);
  assert.deepEqual(restored.snapshot(), first.snapshot());
  restored.exportCsv(); restored.exportJson(); assert.equal(restored.count, 2);
  const isolated = new MachineryPoseRecorder({ ...options, storageKey: 'actor-b:project-a' }); assert.equal(isolated.count, 0);
  restored.clear(); assert.equal(new MachineryPoseRecorder(options).count, 0);
});

test('storage quota failure stops capture while retaining the complete in-memory history for export', async () => {
  const source = await input(); let writes = 0;
  const storage = { getItem: () => null, setItem: () => { if (++writes > 3) throw new Error('QuotaExceededError'); } };
  const recorder = new MachineryPoseRecorder({ storage, storageKey: 'quota', now: () => time });
  recorder.start(source); recorder.observe(edited(source, { boom_length_m: 8 }));
  assert.equal(recorder.count, 2); assert.equal(recorder.isRecording, false); assert.equal(recorder.isPersisted, false);
  assert.match(recorder.status, /写入失败.*停止.*全部记录仍在本页面/);
  assert.equal(JSON.parse(recorder.exportJson()).entries.length, 2); assert.equal(recorder.start(source), false);
});

test('JSON retains full numeric precision, CSV has BOM, actual times, quoted multiline text and formula protection', async () => {
  const source = await input(); source.resourceName = '=HYPERLINK("bad")\n吊机';
  const recorder = new MachineryPoseRecorder({ now: () => time, timeZone: 'Asia/Shanghai' });
  const value = 38.123456789; recorder.start(edited(source, { boom_length_m: value }));
  assert.equal(JSON.parse(recorder.exportJson()).entries[0].changes.find((c: { field: string }) => c.field === 'boom_length_m').value, value);
  const csv = recorder.exportCsv(); assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('38.123456789')); assert.ok(csv.includes('2026-10-29T02:30:00.123Z'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")\n吊机"'));
  for (const value of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '\t=1', '\n@evil']) assert.ok(machineryPoseCsvCell(value).startsWith('"\''));
  assert.equal(machineryPoseCsvCell(-10), '"-10"');
});

test('small floating noise is ignored but accumulated changes are compared against the last recorded value', async () => {
  const source = await input(), recorder = new MachineryPoseRecorder({ now: () => time });
  recorder.start(source);
  const a = { ...source, state: { ...source.state, placement: { ...source.state.placement, longitude: 120 + 1e-10 } } };
  assert.equal(recorder.observe(a), false);
  const b = { ...source, state: { ...source.state, placement: { ...source.state.placement, longitude: 120 + 2e-9 } } };
  assert.equal(recorder.observe(b), true); assert.equal(recorder.count, 2);
  const entry = recorder.snapshot().entries[1]; assert.deepEqual(entry.changes.map(c => c.field), ['longitude']);
  assert.equal(entry.changes[0].value, 120 + 2e-9);
});

test('corrupt saved history is not silently overwritten and failed start cannot enable recording', async () => {
  const source = await input(), storage = memoryStorage(); storage.data.set('corrupt', '{bad');
  const recorder = new MachineryPoseRecorder({ storage, storageKey: 'corrupt', now: () => time });
  assert.equal(recorder.start(source), false); assert.equal(storage.data.get('corrupt'), '{bad'); assert.match(recorder.status, /禁止开始/);
  recorder.clear(); assert.equal(recorder.start(source), true);
  const other = new MachineryPoseRecorder({ now: () => time });
  assert.throws(() => other.start({ ...source, provenance: { heading: { source: 'measured', sampleTimestamp: 'invalid' } } }), /采样时间/);
  assert.equal(other.isRecording, false); assert.equal(other.count, 0);
});

test('incremental persistence encodes only the current 50-entry block and a small index', async () => {
  const source = await input(), storage = memoryStorage(), writes: { key: string; size: number }[] = [];
  const traced = { ...storage, setItem: (key: string, value: string) => { writes.push({ key, size: value.length }); storage.setItem(key, value); } };
  const recorder = new MachineryPoseRecorder({ storage: traced, storageKey: 'blocks', now: () => time });
  recorder.start(source);
  for (let i = 1; i <= 150; i++) recorder.observe({ ...source, state: { ...source.state, placement: { ...source.state.placement, heading: (90 + i) % 360 } } });
  assert.equal(recorder.count, 151);
  const index = JSON.parse(storage.getItem('blocks')!); assert.equal(index.schemaVersion, 2); assert.equal(index.count, 151);
  assert.ok(writes.filter(write => write.key === 'blocks').every(write => write.size < 250), 'index size does not grow with record count');
  const lastWrites = writes.slice(-2);
  assert.ok(lastWrites[0].key.endsWith(':3')); assert.ok(lastWrites[0].size < 2000, 'entry 151 writes a fresh one-entry block, not all 151 records');
  const firstBlockWrites = writes.filter(write => write.key.endsWith(':0')).length;
  assert.equal(firstBlockWrites, 50, 'completed blocks are not rewritten by later entries');
  const restored = new MachineryPoseRecorder({ storage, storageKey: 'blocks', now: () => time });
  assert.deepEqual(restored.snapshot(), recorder.snapshot());
  restored.clear(); assert.equal([...storage.data.keys()].length, 1, 'explicit clear removes only old generation blocks');
});

test('complete final block survives a failed index update at the block boundary', async () => {
  const source = await input(), storage = memoryStorage(); let failIndex = false;
  const traced = { ...storage, setItem: (key: string, value: string) => { if (failIndex && key === 'boundary') throw new Error('Quota'); storage.setItem(key, value); } };
  const recorder = new MachineryPoseRecorder({ storage: traced, storageKey: 'boundary', now: () => time });
  recorder.start(source);
  for (let i = 1; i < 50; i++) recorder.observe({ ...source, state: { ...source.state, placement: { ...source.state.placement, heading: i } } });
  assert.equal(recorder.count, 50); failIndex = true;
  recorder.observe({ ...source, state: { ...source.state, placement: { ...source.state.placement, heading: 51 } } });
  assert.equal(recorder.count, 51); assert.equal(recorder.isRecording, false);
  const restored = new MachineryPoseRecorder({ storage, storageKey: 'boundary', now: () => time });
  assert.equal(restored.count, 51); assert.match(restored.status, /恢复末尾/);
  assert.deepEqual(restored.snapshot(), recorder.snapshot());
});

test('legacy full-history archives migrate only after all new blocks have been written', async () => {
  const source = await input(), storage = memoryStorage();
  const legacy = new MachineryPoseRecorder({ now: () => time }); legacy.start(source);
  storage.setItem('legacy', legacy.exportJson());
  const restored = new MachineryPoseRecorder({ storage, storageKey: 'legacy', now: () => time });
  assert.equal(restored.count, 1); assert.equal(JSON.parse(storage.getItem('legacy')!).schemaVersion, 1);
  restored.start(source); assert.equal(JSON.parse(storage.getItem('legacy')!).schemaVersion, 2);
  assert.equal(new MachineryPoseRecorder({ storage, storageKey: 'legacy', now: () => time }).count, 2);
});

test('process table exports identifiers, readable model types, precise before/after values and actual acquisition times in Beijing time', async () => {
  const source = { ...await input(), equipmentCode: 'CR-001' }; let now = time;
  const recorder = new MachineryPoseRecorder({ now: () => now, timeZone: 'America/New_York' });
  recorder.start(source); now += 2_000;
  const next = edited(source, { boom_length_m: 38.123456789 });
  recorder.observe({ ...next, provenance: { boom_length_m: { source: 'simulated', sourceId: 'browser-sim', sourceField: 'length', sampleTimestamp: '2026-10-29T02:30:01.456Z' } } });
  const csv = recorder.exportProcessCsv({ resourceId: source.resourceId });
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('"CR-001","01号吊机","吊机"'));
  assert.ok(csv.includes('"2026-10-29 10:30:02.123"'));
  assert.ok(csv.includes('"模拟","2026-10-29 10:30:01.456","browser-sim","length"'));
  assert.ok(csv.includes(`"${source.state.parameters.boom_length_m}","38.123456789","m"`));
  assert.match(csv, /开始记录，初始姿态/);
  assert.match(csv, /吊臂伸长至38\.123457 m/);
  assert.equal(recorder.count, 2); assert.equal(recorder.isRecording, true, 'export does not stop or clear ongoing recording');
});

test('process filters use recorded time with inclusive second bounds and never include another resource or invent a range-start pose', async () => {
  const source = await input(); let now = time;
  const recorder = new MachineryPoseRecorder({ now: () => now }); recorder.start(source);
  now += 1_000; recorder.observe(edited(source, { boom_length_m: 38 }));
  now += 1_000; recorder.start({ ...source, resourceId: 'other', resourceName: '另一台机械' });
  const filter = { resourceId: source.resourceId, from: machineryPoseBeijingTime('2026-10-29T10:30:01'), to: machineryPoseBeijingTime('2026-10-29T10:30:01', true) };
  assert.equal(recorder.countMatching(filter), 1);
  const csv = recorder.exportProcessCsv(filter);
  assert.ok(csv.includes('"2","姿态变化"')); assert.ok(!csv.includes('"初始姿态"')); assert.ok(!csv.includes('另一台机械'));
  assert.equal(recorder.countMatching(), 3);
  assert.throws(() => recorder.exportProcessCsv({ resourceId: 'missing' }), /没有已记录/);
  assert.throws(() => recorder.exportProcessCsv({ from: '2026-10-29T03:00:00Z', to: '2026-10-29T02:00:00Z' }), /开始时间不能晚于/);
  assert.throws(() => recorder.exportProcessCsv({ from: '2026-10-29T10:30:00' }), /必须包含时区/);
});

test('cached filter counts include appended observations and reset after explicit history clear', async () => {
  const source = await input(), recorder = new MachineryPoseRecorder({ now: () => time });
  const filter = { resourceId: source.resourceId };
  assert.equal(recorder.countMatching(filter), 0);
  recorder.start(source); assert.equal(recorder.countMatching(filter), 1);
  recorder.observe(edited(source, { boom_length_m: 38 })); assert.equal(recorder.countMatching(filter), 2);
  recorder.start({ ...source, resourceId: 'other' }); assert.equal(recorder.countMatching(filter), 2);
  assert.equal(recorder.countMatching(), 3);
  recorder.clear(); assert.equal(recorder.countMatching(filter), 0);
  recorder.start(source); assert.equal(recorder.countMatching(filter), 1);
});

test('Beijing range input validates calendar dates without depending on the browser time zone', () => {
  assert.equal(machineryPoseBeijingTime(''), undefined);
  assert.equal(machineryPoseBeijingTime('2026-10-29T10:30'), '2026-10-29T02:30:00.000Z');
  assert.equal(machineryPoseBeijingTime('2026-10-29T10:30:00', true), '2026-10-29T02:30:00.999Z');
  assert.throws(() => machineryPoseBeijingTime('2026-02-30T10:30:00'), /有效的北京时间/);
  assert.throws(() => machineryPoseBeijingTime('2026-10-29T24:00:00'), /有效的北京时间/);
});

test('process history preserves recorded identifiers, safely exports malicious text and leaves legacy missing identifiers explicit', async () => {
  const source = await input(), storage = memoryStorage(), recorder = new MachineryPoseRecorder({ storage, storageKey: 'identifiers', now: () => time });
  recorder.start(source);
  recorder.observe({ ...edited(source, { boom_length_m: 38 }), equipmentCode: '=SUM(1,2)', resourceName: '@machine' });
  const restored = new MachineryPoseRecorder({ storage, storageKey: 'identifiers', now: () => time });
  assert.equal(restored.snapshot().entries[0].equipmentCode, undefined);
  assert.equal(restored.snapshot().entries[1].equipmentCode, '=SUM(1,2)');
  const csv = restored.exportProcessCsv();
  assert.ok(csv.includes('"未记录","01号吊机","吊机"'));
  assert.ok(csv.includes('"\'=SUM(1,2)","\'@machine","吊机"'));
  assert.equal(restored.isRecording, false);
});
