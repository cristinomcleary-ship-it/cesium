import type { ManagementRecord } from '../managementTypes';
import './ganttView.css';
const DAY = 86_400_000;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export type GanttOptions = { today: string; canEdit: boolean };
export type GanttSchedule = { start: number; end: number; startDate: string; endDate: string };
export type GanttRow = { task: ManagementRecord; current: GanttSchedule; baseline?: GanttSchedule & { name: string; id: string; revision: number }; startOffset?: number; endOffset?: number };
export function ganttDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : undefined;
}
function schedule(record: Record<string, unknown>): GanttSchedule | undefined {
  const start = ganttDate(record.planStart), end = ganttDate(record.planEnd);
  if (start === undefined || end === undefined || end < start) return;
  return { start, end, startDate: String(record.planStart), endDate: String(record.planEnd) };
}
/** Approved baselines are immutable input snapshots. A missing task baseline is
 * left missing; current dates never impersonate an approved baseline. */
export function buildGanttRows(tasks: ManagementRecord[], baselines: ManagementRecord[]): GanttRow[] {
  const approved = baselines.filter(b => b.status === 'approved').slice().sort((a,b) => String(b.approvedAt || b.updatedAt).localeCompare(String(a.approvedAt || a.updatedAt)) || b.revision-a.revision || a.id.localeCompare(b.id));
  return tasks.flatMap(task => {
    const current = schedule(task); if (!current) return [];
    const row: GanttRow = { task, current };
    for (const baseline of approved) {
      const item = Array.isArray(baseline.items) ? (baseline.items as Record<string,unknown>[]).find(x => x.taskId === task.id) : undefined;
      const plan = item && schedule(item); if (!plan) continue;
      row.baseline = { ...plan, name: baseline.name, id: baseline.id, revision: baseline.revision };
      row.startOffset = Math.round((current.start-plan.start)/DAY); row.endOffset = Math.round((current.end-plan.end)/DAY); break;
    }
    return [row];
  });
}
export function renderGantt(tasks: ManagementRecord[], baselines: ManagementRecord[], options: GanttOptions): string {
  const rows = buildGanttRows(tasks, baselines), omitted = tasks.length-rows.length;
  if (!rows.length) return '<div class="mg-gantt-empty">尚无有效计划起止日期。保存任务计划后显示日期轴；批准基线单独保留。</div>';
  const all = rows.flatMap(r => [r.current.start,r.current.end,...(r.baseline?[r.baseline.start,r.baseline.end]:[])]);
  let start = Math.min(...all); start -= ((new Date(start).getUTCDay()+6)%7)*DAY;
  const end = Math.max(...all)+DAY*3, range = Math.max(7*DAY,end-start), months: Array<{date:number;label:string}> = [], weeks: Array<{date:number;label:string}> = [];
  const dayLabel = (timestamp:number) => new Date(timestamp).toISOString().slice(0,10);
  let month = new Date(start); month = new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),1));
  while (month.getTime() <= start+range) { const at = Math.max(start,month.getTime());months.push({date:at,label:`${month.getUTCFullYear()}年${month.getUTCMonth()+1}月`});month.setUTCMonth(month.getUTCMonth()+1); }
  // A long project keeps a readable real calendar instead of drawing thousands of ticks.
  const weeklyStep = range > 366*DAY ? 28 : range > 120*DAY ? 14 : 7;
  for (let date=start;date<=start+range;date+=weeklyStep*DAY) weeks.push({date,label:dayLabel(date).slice(5)});
  const percent = (date:number) => (date-start)/range*90;
  const today = ganttDate(options.today), hasToday = today!==undefined && today>=start && today<=start+range;
  const line = hasToday ? `<span class="mg-gantt-today" style="left:${percent(today!)}%" title="今日 ${esc(options.today)}"></span>` : '';
  const delta=(days:number)=>days===0?'不变':`${days>0?'推迟':'提前'} ${Math.abs(days)} 天`;
  const track=(plan:GanttSchedule,cls:string,title:string,id?:string)=>`<span class="${cls}" style="left:${percent(plan.start)}%;width:${Math.max(.3,(plan.end-plan.start+DAY)/range*90)}%" title="${esc(title)}" ${id?`data-mg-gantt="${esc(id)}" data-range-ms="${range}" role="button" tabindex="${options.canEdit?'0':'-1'}" aria-disabled="${!options.canEdit}" aria-label="${esc(title)}；拖动仅预览，使用调整按钮确认保存"`:''}></span>`;
  return `<section class="mg-gantt-view" aria-label="真实日期计划与批准基线"><div class="mg-gantt-legend"><span><i class="current"></i>当前计划</span><span><i class="approved"></i>批准基线</span><span><i class="now"></i>今日 ${esc(options.today)}${hasToday?'':'（在当前日期范围外）'}</span><span>拖动先预览，保存后生效</span></div><div class="mg-gantt-scroll"><div class="mg-gantt-sheet"><div class="mg-gantt-calendar"><strong>任务与日期</strong><div class="mg-gantt-axis"><div class="mg-gantt-months">${months.map(t=>`<span style="left:${percent(t.date)}%">${esc(t.label)}</span>`).join('')}</div><div class="mg-gantt-weeks">${weeks.map(t=>`<span style="left:${percent(t.date)}%">${t.label}</span>`).join('')}</div>${line}</div><span>调整</span></div>${rows.map(row=>{const baseline=row.baseline;const currentTitle=`${row.task.name} · 当前 ${row.current.startDate} 至 ${row.current.endDate}`;return `<article class="mg-gantt-row" data-gantt-task="${esc(row.task.id)}"><div class="mg-gantt-label"><b title="${esc(row.task.name)}">${esc(row.task.name)}</b><span>当前 ${row.current.startDate} — ${row.current.endDate}</span>${baseline?`<span>基线 ${baseline.startDate} — ${baseline.endDate}</span><small title="${esc(baseline.name)} · 修订 ${baseline.revision}">开始${delta(row.startOffset!)} · 完成${delta(row.endOffset!)}</small>`:'<small>尚无该任务的批准基线</small>'}</div><div class="gantt mg-gantt-track">${weeks.map(t=>`<i class="mg-gantt-grid" style="left:${percent(t.date)}%"></i>`).join('')}${line}${baseline?track(baseline,'mg-gantt-baseline',`${baseline.name} · 批准基线 ${baseline.startDate} 至 ${baseline.endDate}`):''}${track(row.current,'bar mg-gantt-bar',currentTitle,row.task.id)}</div><button type="button" class="small link" data-mg-action="edit-task" data-id="${esc(row.task.id)}" ${options.canEdit?'':'disabled'} aria-label="调整${esc(row.task.name)}的计划">调整</button></article>`;}).join('')}</div></div><p class="mg-gantt-note">${rows.length} 项有效计划${omitted?` · ${omitted} 项日期未配置或无效，未绘制`:''}。基线取各任务最近批准版本；未配置可计算依赖网络时不显示关键路径。</p></section>`;
}
