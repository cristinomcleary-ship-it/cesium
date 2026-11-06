import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { TemporaryWorksPanel } = await import('./temporaryWorksPanel.ts');

const row = (start: string, end: string, gradePct: string) => ({
  querySelector(selector: string) {
    const key = selector.match(/data-grade-field="([^"]+)"/)?.[1];
    return { value: ({ start, end, gradePct } as Record<string, string>)[key!] };
  },
});

test('new draped construction segments ignore stale hidden design grades while retaining station validation', () => {
  const rows = [row('0', '4', ''), row('4', '10', 'Infinity')];
  const panel = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    measuredLength: 10,
    gradeRows: () => rows,
  });
  assert.deepEqual(panel.getGrades(), [
    { start: 0, end: 4, gradePct: 0 }, { start: 4, end: 10, gradePct: 0 },
  ]);
  rows[1] = row('3', '10', '0');
  assert.throws(() => panel.getGrades(), /重叠|连续|衔接|起里程/);
});

test('the draped cross-section stays vertical with no dependence on hidden legacy slope inputs', () => {
  const host = { innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  const values: Record<string, string> = { width: '5', thickness: '.25', treatment: '.5' };
  const panel = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    value(key: string) {
      assert.ok(key in values, `new road must not read hidden input ${key}`);
      return values[key];
    },
    el: () => host,
  });
  panel.crossSection();
  assert.match(host.innerHTML, /处理底宽 5 m/);
  assert.match(host.innerHTML, /地基处理厚 0.5 m · 底面贴合摄影，侧边竖直/);
  assert.doesNotMatch(host.innerHTML, /边坡高宽比/);
});

test('saved draped-road facts distinguish cumulative samples from per-partition work and retain older records', () => {
  const panel = Object.create(TemporaryWorksPanel.prototype);
  const inputs = {
    width: 4, spacing: 2, sampleCount: 520000, refinementLevels: 3,
    feature: { points: [{x:0,y:0},{x:10000,y:0}] },
    design: {treatmentDepth:.4,surfaceToTreatment:.2},
    road: {surfaceMode:'draped',length:10000,grades:[],sampleSpacing:1},
  };
  const old = panel.roadFacts(structuredClone(inputs)).join('\n');
  assert.match(old, /520000 个位置/);
  assert.doesNotMatch(old, /undefined|NaN|自动处理/);
  const restored = structuredClone({...inputs,road:{...inputs.road,samplePartitions:80,samplingBatches:1100,peakWorkingSamples:8000}});
  const latest = panel.roadFacts(restored).join('\n');
  assert.match(latest, /80 个网格分区/);
  assert.match(latest, /1,100 批摄影采样/);
  assert.match(latest, /峰值 8,000 个/);
  assert.match(latest, /累计采样量不受单分区点数上限限制/);
  assert.equal(inputs.road.sampleSpacing,1);
});
