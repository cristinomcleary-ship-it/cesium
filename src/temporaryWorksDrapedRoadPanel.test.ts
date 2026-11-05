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
