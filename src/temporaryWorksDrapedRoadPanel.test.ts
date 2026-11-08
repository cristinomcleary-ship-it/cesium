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

test('manual designed-road elevation requires a top height and validates grade drafts only while enabled', () => {
  const rows = [row('not-a-number', '4', ''), row('3', '10', 'Infinity')];
  const enabled={checked:false};
  let height='';
  const status={textContent:'',error:false,removeAttribute(){this.error=false;},toggleAttribute(_name:string,active:boolean){this.error=active;}};
  const panel = Object.assign(Object.create(TemporaryWorksPanel.prototype), {
    measuredLength: 10,
    gradeRows: () => rows,
    input(key:string){assert.equal(key,'road-grades-enabled');return enabled;},
    value(key:string){if(key==='elevation-mode')return 'manual';assert.equal(key,'road-elevation');return height;},
    el(key:string){assert.equal(key,'grade-status');return status;},
  });
  const draft=panel.gradeDraft();
  assert.deepEqual(panel.getDesignedGrades(),[{start:0,end:10,gradePct:0}]);
  assert.deepEqual(panel.gradeDraft(),draft,'disabled invalid drafts remain available for later editing');
  panel.gradeStatus();
  assert.match(status.textContent,/全线平坡.*草稿纵坡不参与计算/);
  assert.match(status.textContent,/请填写起点路面顶标高/);
  assert.throws(()=>panel.num('road-elevation','起点路面顶椭球高'),/起点路面顶椭球高/);
  height='100';
  assert.equal(panel.num('road-elevation','起点路面顶椭球高'),100);
  panel.gradeStatus();assert.match(status.textContent,/终点顶椭球高 100 m/);

  enabled.checked=true;
  assert.throws(()=>panel.getDesignedGrades(),/有效数值/);
  panel.gradeStatus();assert.equal(status.error,true);
  rows[0]=row('0','4','1');rows[1]=row('4','10','-1');
  assert.deepEqual(panel.getDesignedGrades(),[{start:0,end:4,gradePct:1},{start:4,end:10,gradePct:-1}]);
  panel.gradeStatus();assert.equal(status.error,false);assert.match(status.textContent,/终点顶椭球高 99\.98 m/);
  rows[1]=row('3','10','-1');
  assert.throws(()=>panel.getDesignedGrades(),/重叠|连续|衔接|起里程/);
  enabled.checked=false;
  assert.deepEqual(panel.getDesignedGrades(),[{start:0,end:10,gradePct:0}]);
  assert.equal(panel.gradeDraft()[1].start,'3','turning off grades must not rewrite the inactive draft');
});

test('the new designed cross-section stacks structural layers downward with vertical sides and no photography datum', () => {
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
  assert.match(host.innerHTML, /硬化层厚 0.25 m/);
  assert.match(host.innerHTML, /地基处理厚 0.5 m/);
  assert.match(host.innerHTML, /结构层自设计顶标高向下生成，侧边竖直/);
  assert.doesNotMatch(host.innerHTML, /底面贴合摄影/);
  const layers=Array.from(host.innerHTML.matchAll(/<polygon points="([^"]+)"/g),match=>
    match[1].trim().split(/\s+/).map(point=>point.split(',').map(Number)));
  assert.equal(layers.length,2);
  for(const points of layers) {
    assert.equal(points[0][0],points[3][0]);assert.equal(points[1][0],points[2][0]);
    assert.equal(points[0][1],points[1][1]);assert.equal(points[2][1],points[3][1]);
    assert.ok(points[2][1]>points[0][1],'each displayed layer extends below its own top');
  }
  assert.equal(layers[0][2][1],layers[1][0][1],'hardening bottom joins treatment top without an artificial gap');
  const hardeningHeight=layers[0][2][1]-layers[0][0][1],treatmentHeight=layers[1][2][1]-layers[1][0][1];
  assert.ok(Math.abs(treatmentHeight/hardeningHeight-2)<1e-12,'drawing preserves the entered thickness ratio');
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
