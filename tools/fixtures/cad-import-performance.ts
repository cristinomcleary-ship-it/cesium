import { readCadImportInWorker } from '../../src/cadImportWorkerClient';
import { CadSpatialBatcher } from '../../src/cadSpatialBatcher';
import { CAD_PRIMITIVE_VERTEX_BUDGET } from '../../src/cadPrimitiveLoader';
import type { CadImportPackage } from '../../src/cadImport';

const root = document.getElementById('fixture')!;
const button = document.getElementById('run')! as HTMLButtonElement;
const status = document.getElementById('status')!;
const results = document.getElementById('results')!;
const report = document.getElementById('report')!;
type Result = { name: string; passed: boolean; detail?: unknown };
let checks: Result[] = [];
function record(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, detail });
  const row = document.createElement('li'); row.textContent = `${passed ? '通过' : '失败'}：${name}`; results.append(row);
  report.textContent = JSON.stringify(checks, null, 2);
  if (!passed) throw new Error(name);
}
function source(): CadImportPackage {
  const entities = Array.from({ length: 60_000 }, (_, i) => ({ type: 'POLYLINE' as const, sourceType: 'LINE', layer: '合成图层',
    vertices: [{ x: i, y: i % 32, z: 0 }, { x: i + .5, y: i % 32 + .5, z: 1 }] }));
  return { format: 'cesium-cad-import', version: 2, source: { name: 'synthetic-worker.dwg', format: 'DWG', generatedAt: '' },
    statistics: { sourceEntities: entities.length, displayEntities: entities.length, skippedEntities: 0, unknownEntities: 0, layers: ['合成图层'] }, entities, warnings: [] };
}
function checkBatches(mode: 'absolute' | 'ground') {
  const count = 100_000, visits = new Uint8Array(count);
  let batches = 0, largest = 0, output = 0;
  const budget = CAD_PRIMITIVE_VERTEX_BUDGET[mode], start = performance.now();
  const batcher = new CadSpatialBatcher<number>({ maxBatchSize: 1000, maxBatchVertices: budget, maxBufferedVertices: 131_072,
    emit(items) { batches++; largest = Math.max(largest, items.length * 128); output += items.length; for (const id of items) visits[id]++; } });
  for (let i = 0; i < count; i++) batcher.add(`cell-${i % 32}`, i, 128);
  batcher.flush();
  record(`${mode}：十万交错图元完整保留，未退化为每图元一个批次`, output === count && visits.every(value => value === 1)
    && largest <= budget && batches < (mode === 'ground' ? 4000 : 2000), { sourceItems: count, batches, largestBatchVertices: largest, budget, elapsedMs: Math.round(performance.now() - start) });
}
button.addEventListener('click', async () => {
  button.disabled = true; root.dataset.state = 'running'; checks = []; results.replaceChildren();
  try {
    status.textContent = '生成合成文件…';
    const drawing = source();
    const file = new File([JSON.stringify(drawing)], 'synthetic-worker.cadimport');
    let beats = 0; const messages: string[] = [];
    const pulse = setInterval(() => { beats++; status.textContent = `后台读取中，界面心跳 ${beats}…`; }, 16);
    let loaded: CadImportPackage;
    const start = performance.now();
    try { loaded = await readCadImportInWorker(file, message => messages.push(message)); }
    finally { clearInterval(pulse); }
    record('真实模块 Worker 完成大文件读取，图元与顺序完整', loaded!.entities.length === drawing.entities.length
      && loaded!.entities.every((entity, i) => entity.vertices.length === 2 && entity.vertices[0].x === i && entity.vertices[1].z === 1)
      && messages.length > 0, { fileBytes: file.size, features: loaded!.entities.length, messages, heartbeats: beats, elapsedMs: Math.round(performance.now() - start) });
    record('后台读取期间界面计时器继续运行', beats > 0, { heartbeats: beats });
    const controller = new AbortController(); let cancelled = false, abortProgress = 0;
    try { await readCadImportInWorker(file, () => { abortProgress++; controller.abort(); }, controller.signal); }
    catch (error) { cancelled = error instanceof Error && error.name === 'AbortError'; }
    record('开始读取后取消明确结束，未返回半份图纸', cancelled && abortProgress > 0, { abortProgress });
    let invalid = '';
    try { await readCadImportInWorker(new File(['{' + ' '.repeat(1_100_000)], 'invalid.cadimport')); }
    catch (error) { invalid = error instanceof Error ? error.message : String(error); }
    record('大文件格式错误明确报告', /有效|格式/.test(invalid), { error: invalid });
    checkBatches('absolute'); checkBatches('ground');
    root.dataset.state = 'passed'; status.textContent = `${checks.length} 项验证通过；不代表现场 WebGL 或 FPS 验收。`;
  } catch (error) {
    root.dataset.state = 'failed'; status.textContent = `验证失败：${error instanceof Error ? error.message : String(error)}`;
  } finally { report.textContent = JSON.stringify({ state: root.dataset.state, checks }, null, 2); button.disabled = false; }
});
