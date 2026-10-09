import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// Exercise the real renderer without a browser-only CSS import in Node.
const source=readFileSync(new URL('./ganttView.ts',import.meta.url),'utf8').replace("import './ganttView.css';",'');
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {ganttDate,buildGanttRows,renderGantt}=await import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
const base={projectId:'p',revision:1,createdAt:'2026-10-01',updatedAt:'2026-10-01',createdBy:'u'};
const task={...base,id:'t',name:'桥墩<script>',status:'published',planStart:'2026-10-09',planEnd:'2026-10-15'};
const approved={...base,id:'b',name:'批准基线',status:'approved',approvedAt:'2026-10-02',items:[{taskId:'t',planStart:'2026-10-05',planEnd:'2026-10-12'}]};
test('invalid calendar dates and inverted ranges do not become valid plans',()=>{assert.equal(ganttDate('2026-02-30'),undefined);assert.equal(ganttDate('2026-1-2'),undefined);assert.equal(buildGanttRows([{...task,planEnd:'2026-10-01'}],[]).length,0);});
test('latest approved per-task baseline preserves immutable inputs and distinguishes offsets',()=>{const draft={...approved,id:'draft',status:'draft',approvedAt:'2026-10-08',items:[{taskId:'t',planStart:'2026-10-01',planEnd:'2026-10-30'}]};const input=JSON.stringify([task,approved,draft]);const row=buildGanttRows([task],[draft,approved])[0];assert.equal(row.startOffset,4);assert.equal(row.endOffset,3);assert.equal(row.baseline.id,'b');assert.equal(JSON.stringify([task,approved,draft]),input);});
test('missing baseline never copies current dates and latest baseline for another task does not erase prior',()=>{assert.equal(buildGanttRows([task],[])[0].baseline,undefined);const other={...approved,id:'new-other',approvedAt:'2026-10-03',items:[{taskId:'other',planStart:'2026-10-05',planEnd:'2026-10-12'}]};assert.equal(buildGanttRows([task],[other,approved])[0].baseline.id,'b');});
test('renderer shows real month/week axis, actual today and both tracks with HTML escaping',()=>{const html=renderGantt([task],[approved],{today:'2026-10-09',canEdit:true});assert.match(html,/2026年10月/);assert.match(html,/10-05/);assert.match(html,/今日 2026-10-09/);assert.match(html,/完成推迟 3 天/);assert.match(html,/mg-gantt-baseline/);assert.match(html,/data-mg-gantt="t"/);assert.match(html,/桥墩&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);});
test('today outside project interval is named without a fictitious center line',()=>{const html=renderGantt([task],[],{today:'2027-01-01',canEdit:false});assert.match(html,/在当前日期范围外/);assert.doesNotMatch(html,/<span class="mg-gantt-today"/);assert.match(html,/aria-disabled="true"/);});
