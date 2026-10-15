import type { ManagementCommandType, ManagementRecord, ManagementSnapshot } from '../managementTypes';
import './railwayPlanImport.css';

type PlanKind = 'construction' | 'supervision';
type Cell = string | number | boolean | null | undefined;
type Workbook = { SheetNames: string[]; Sheets: Record<string, unknown>; Workbook?: { WBProps?: { date1904?: boolean } } };
type Xlsx = { read(data: ArrayBuffer, options: Record<string, unknown>): Workbook; utils: { sheet_to_json(sheet: unknown, options: Record<string, unknown>): Cell[][]; aoa_to_sheet(rows: Cell[][]): unknown; book_new(): Workbook; book_append_sheet(book: Workbook, sheet: unknown, name: string): void }; write(book: Workbook, options: Record<string, unknown>): ArrayBuffer };
declare global { interface Window { XLSX?: Xlsx } }
export type RailwayPlanImporterOptions = {
  host: HTMLElement;
  getSnapshot: () => ManagementSnapshot | undefined;
  upload: (file: File, meta: Record<string, unknown>) => Promise<ManagementRecord>;
  command: (type: ManagementCommandType, payload: Record<string, unknown>, id: string | undefined, revision: number | undefined, key: string) => Promise<ManagementSnapshot>;
  onSaved: (snapshot: ManagementSnapshot) => void;
  onTaskSelected: (id: string) => void;
  toast: (message: string) => void;
};
const FIELDS = [
  ['number', '计划编号 *', ['计划编号','计划号','日计划号','施工计划号','监督计划号','计划序号']],
  ['name', '作业名称 *', ['施工项目','施工内容','作业名称','项目名称','施工项目名称','作业内容']],
  ['date', '开始 / 作业日期 *', ['施工日期','作业日期','计划日期','开始日期','计划开始日期','日期']],
  ['endDate', '结束日期（跨日必填）', ['结束日期','完成日期','计划结束日期','计划完成日期']],
  ['startTime', '开始时间', ['开始时间','施工开始时间','作业开始时间','计划开始时间']],
  ['endTime', '结束时间', ['结束时间','施工结束时间','作业结束时间','计划结束时间']],
  ['line', '线路', ['线路','线名','线路名称','铁路线路']],
  ['mileage', '里程 / 地点', ['里程','施工里程','施工地点','作业地点','地点']],
  ['track', '行别', ['行别','上下行','股道']],
  ['resources', '机械 ID / 编号', ['机械编号','设备编号','资源编号','机械id','设备id','机械设备','施工机械']],
] as const;
type Field = typeof FIELDS[number][0];
export type RailwayPlanMapping = Partial<Record<Field, number>>;
export type RailwayPlanPreviewRow = { rowNumber: number; number: string; name: string; planStart: string; planEnd: string; workWindowStart?: string; workWindowEnd?: string; railwayLine: string; railwayMileage: string; railwayTrack: string; resourceText: string; resourceIds: string[]; unmatchedResources: string[]; errors: string[]; warnings: string[]; duplicateId?: string };
type ImportRow = RailwayPlanPreviewRow & { id: string; key: string; selected: boolean; state: 'pending' | 'saved' | 'failed'; saveError?: string };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const normalized = (value: Cell) => String(value ?? '').trim().replace(/[\s（）():：*＊]/g, '').toLowerCase();
let xlsxPromise: Promise<Xlsx> | undefined;
function getXlsx(): Promise<Xlsx> {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = new Promise<Xlsx>((resolve, reject) => {
    const script = document.createElement('script'); script.src = `${import.meta.env.BASE_URL}management/vendor/xlsx.full.min.js`; script.async = true;
    const timer = window.setTimeout(() => failed(), 20000);
    const failed = () => { clearTimeout(timer); script.remove(); xlsxPromise = undefined; reject(Error('Excel 解析组件读取失败，请检查部署文件后重试。')); };
    script.onerror = failed;
    script.onload = () => { clearTimeout(timer); if (window.XLSX) resolve(window.XLSX); else failed(); };
    document.head.append(script);
  });
  return xlsxPromise;
}

/** Dates are civil dates; no browser timezone conversion or inferred cross-midnight date. */
export function railwayPlanDate(value: Cell, date1904 = false): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < (date1904 ? 0 : 1) || value > 100000 || (!date1904 && Math.floor(value) === 60)) return;
    const whole = Math.floor(value);
    const offset = date1904 ? whole + 1462 : whole;
    const day = new Date(Date.UTC(1899, 11, 30) + (offset + (!date1904 && whole < 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10);
    return day;
  }
  const match = String(value ?? '').trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:[ T].*)?$/);
  if (!match) return;
  const day = `${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0,10) === day ? day : undefined;
}
export function railwayPlanTime(value: Cell): string | undefined {
  if (typeof value === 'number') {
    const fraction = value - Math.floor(value), minutes = fraction * 1440, rounded = Math.round(minutes);
    if (!Number.isFinite(value) || value < 0 || Math.abs(minutes-rounded) > .0001 || rounded >= 1440) return;
    return `${String(Math.floor(rounded/60)).padStart(2,'0')}:${String(rounded%60).padStart(2,'0')}`;
  }
  const match = String(value ?? '').trim().match(/(?:^|[ T])(\d{1,2})[:：](\d{2})(?::(\d{2}))?$/);
  if (!match || +match[1] > 23 || +match[2] > 59 || (match[3] && +match[3] !== 0)) return;
  return `${match[1].padStart(2,'0')}:${match[2]}`;
}
export function detectRailwayPlanHeader(rows: Cell[][]): { headerIndex: number; mapping: RailwayPlanMapping } {
  let best = { headerIndex: 0, mapping: {} as RailwayPlanMapping, score: -1 };
  for (let index=0; index<Math.min(rows.length,40); index++) {
    const mapping: RailwayPlanMapping = {};
    for (const [key,,aliases] of FIELDS) {
      const position = rows[index].findIndex(value => (aliases as readonly string[]).some(alias => normalized(value) === normalized(alias)));
      if (position>=0) mapping[key]=position;
    }
    const score = Object.keys(mapping).length + (mapping.name!==undefined?2:0) + (mapping.number!==undefined?2:0);
    if (score>best.score) best={headerIndex:index,mapping,score};
  }
  return {headerIndex:best.headerIndex,mapping:best.mapping};
}
function resourceCodes(resource: ManagementRecord): string[] {
  return [resource.id, resource.equipmentCode, resource.code, resource.resourceCode].filter((v): v is string => typeof v==='string'&&Boolean(v.trim())).map(v=>v.trim());
}
export function previewRailwayPlanRows(raw: Cell[][], display: Cell[][], headerIndex: number, mapping: RailwayPlanMapping, kind: PlanKind, snapshot: ManagementSnapshot, date1904=false): RailwayPlanPreviewRow[] {
  const rows: RailwayPlanPreviewRow[] = [], seen = new Set<string>();
  const resources=snapshot.collections.resources.filter(resource=>resource.projectId===snapshot.projectId&&resource.kind==='equipment'&&resource.status!=='deleted'&&!resource.deletedAt);
  for(let index=headerIndex+1; index<raw.length; index++) {
    const cells=raw[index]||[], shown=display[index]||cells;
    if(!cells.some(value=>String(value??'').trim()))continue;
    const get=(key:Field):Cell=>mapping[key]===undefined?undefined:cells[mapping[key]!];
    const text=(key:Field)=>String(mapping[key]===undefined?'':shown[mapping[key]!]??get(key)??'').trim();
    const number=text('number'),name=text('name'),errors:string[]=[],warnings:string[]=[];
    const planStart=railwayPlanDate(get('date'),date1904)||'', hasEnd=String(get('endDate')??'').trim()!=='';
    const planEnd=hasEnd?(railwayPlanDate(get('endDate'),date1904)||''):planStart;
    if(!number)errors.push('缺少计划编号'); if(!name)errors.push('缺少作业名称');
    if(number.length>200)errors.push('计划编号超过 200 字'); if(name.length>200)errors.push('作业名称超过 200 字');
    if(!planStart)errors.push('开始日期无效（需完整年月日）'); if(!planEnd)errors.push('结束日期无效');
    if(planStart&&planEnd&&planEnd<planStart)errors.push('结束日期早于开始日期');
    if(!hasEnd&&planStart)warnings.push('未指定结束日期，按单日计划预览；跨日请补充结束日期');
    const startValue=get('startTime'),endValue=get('endTime');
    const startFilled=String(startValue??'').trim()!=='',endFilled=String(endValue??'').trim()!=='';
    let workWindowStart:string|undefined,workWindowEnd:string|undefined;
    if(startFilled||endFilled){
      const startTime=railwayPlanTime(startValue),endTime=railwayPlanTime(endValue);
      const startDate=typeof startValue==='string'?railwayPlanDate(startValue,date1904):typeof startValue==='number'&&startValue>=1?railwayPlanDate(startValue,date1904):undefined;
      const endDate=typeof endValue==='string'?railwayPlanDate(endValue,date1904):typeof endValue==='number'&&endValue>=1?railwayPlanDate(endValue,date1904):undefined;
      if(!startTime||!endTime)errors.push('开始与结束时间需同时提供有效时分（秒须为 00）');
      else if(planStart&&planEnd){workWindowStart=`${startDate||planStart}T${startTime}`;workWindowEnd=`${endDate||planEnd}T${endTime}`;
        if(workWindowEnd<=workWindowStart)errors.push('结束时间须晚于开始时间；跨日请填写次日日期');
        if(workWindowStart.slice(0,10)<planStart||workWindowEnd.slice(0,10)>planEnd)errors.push('作业时段超出计划日期范围');
      }
    }else warnings.push('原表未提供作业时段，保留为待补充');
    const resourceText=text('resources'),resourceIds:string[]=[],unmatchedResources:string[]=[];
    for(const code of [...new Set(resourceText.split(/[,，;；、\n]/).map(value=>value.trim()).filter(Boolean))]){
      const found=resources.filter(resource=>resourceCodes(resource).includes(code));
      if(found.length===1)resourceIds.push(found[0].id);else unmatchedResources.push(code);
    }
    if(unmatchedResources.length)warnings.push(`机械待关联：${unmatchedResources.join('、')}（原文保留）`);
    if(resourceText.length>4000||unmatchedResources.length>100||unmatchedResources.some(value=>value.length>200))errors.push('机械原文过长或数量过多，请拆分并核对');
    const signature=JSON.stringify([kind,number,planStart]);
    const duplicate=snapshot.collections.tasks.find(task=>{const meta=task.railwayPlan as Record<string,unknown>|undefined;return task.projectId===snapshot.projectId&&meta?.kind===kind&&meta.number===number&&(meta.businessDate||task.planStart)===planStart;});
    if(seen.has(signature)&&number&&planStart)errors.push('表内计划类型、编号和日期重复，请核对');
    seen.add(signature);
    if(duplicate)warnings.push('同类型、编号和日期的作业已存在，将跳过');
    const railwayLine=text('line'),railwayMileage=text('mileage'),railwayTrack=text('track');
    if([railwayLine,railwayMileage,railwayTrack].some(value=>value.length>200))errors.push('线路、地点或行别超过 200 字');
    rows.push({rowNumber:index+1,number,name,planStart,planEnd,workWindowStart,workWindowEnd,railwayLine,railwayMileage,railwayTrack,resourceText,resourceIds:[...new Set(resourceIds)],unmatchedResources,errors,warnings,duplicateId:duplicate?.id});
  }
  return rows;
}

export class RailwayPlanImporter {
  private dialog?:HTMLDialogElement;
  private file?:File;
  private workbook?:Workbook;
  private sheet='';
  private raw:Cell[][]=[];
  private display:Cell[][]=[];
  private headerIndex=0;
  private mapping:RailwayPlanMapping={};
  private kind:PlanKind='supervision';
  private rows:ImportRow[]=[];
  private busy=false;
  private started=false;
  private confirmed=false;
  private error='';
  private progress='';
  private context='';
  private source?:ManagementRecord;
  private sequence=0;
  private disposed=false;
  private returnFocus?:HTMLElement;
  constructor(private options:RailwayPlanImporterOptions){}
  get hasDraft():boolean{return !!this.dialog?.open&&(this.busy||!!this.file&&(!this.started||this.rows.some(row=>row.selected&&row.state!=='saved'&&!row.duplicateId)));}
  private currentContext(){const snapshot=this.options.getSnapshot();return snapshot?`${snapshot.projectId}\u0000${snapshot.session.userId}`:'';}
  private isCurrent(sequence=this.sequence){return !this.disposed&&sequence===this.sequence&&this.context===this.currentContext();}
  open():void{
    if(this.disposed)return;
    const snapshot=this.options.getSnapshot();if(!snapshot){this.options.toast('请先打开项目并登录。');return;}
    if(this.context&&this.context!==this.currentContext())this.reset();
    this.context=this.currentContext();
    if(this.dialog?.open)return;
    this.returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    const dialog=document.createElement('dialog');this.dialog=dialog;dialog.className='rg-plan-dialog';dialog.setAttribute('aria-label','导入施工及安全监督计划');
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    dialog.addEventListener('click',event=>{const action=(event.target as Element).closest<HTMLElement>('[data-rgp-action]')?.dataset.rgpAction;if(action==='close')this.close();else if(action==='save')void this.save();else if(action==='sample')void this.sample();else if(action==='reset'){if(this.busy)return;this.reset();this.render();}else if(action==='select-task'){const id=(event.target as Element).closest<HTMLElement>('[data-task-id]')?.dataset.taskId;if(id&&this.isCurrent()){this.close();this.options.onTaskSelected(id);}}});
    dialog.addEventListener('change',event=>this.change(event));
    this.options.host.append(dialog);this.render();dialog.showModal();
  }
  close():void{if(this.busy){this.options.toast('正在读取或保存计划，请等待本次操作完成。');return;}const dialog=this.dialog;this.dialog=undefined;if(dialog){dialog.close();dialog.remove();}if(this.returnFocus?.isConnected)this.returnFocus.focus();}
  dispose():void{this.disposed=true;++this.sequence;this.busy=false;this.close();this.reset();}
  private reset(){++this.sequence;this.file=undefined;this.workbook=undefined;this.sheet='';this.raw=[];this.display=[];this.rows=[];this.mapping={};this.source=undefined;this.confirmed=false;this.started=false;this.error='';this.progress='';this.context=this.currentContext();}
  private render(){
    const dialog=this.dialog;if(!dialog)return;
    const locked=this.busy||this.started, snapshot=this.options.getSnapshot(),permission=!!snapshot?.session.permissions.includes('plan')&&!!snapshot?.session.permissions.includes('files');
    const pending=this.rows.filter(row=>row.selected&&!row.errors.length&&!row.duplicateId&&row.state!=='saved');
    const saved=this.rows.filter(row=>row.state==='saved');
    dialog.innerHTML=`<header><div><h2>导入施工 / 安全监督计划</h2><p>保留 Excel 原表，核对字段后生成待核验的作业草稿。</p></div><button data-rgp-action="close" ${this.busy?'disabled':''}>返回工作台</button></header><div class="rg-plan-body"><section class="rg-plan-section"><h3>1 · 选择原始计划表</h3><div class="rg-plan-toolbar"><label>计划类型<select data-rgp="kind" ${locked?'disabled':''}><option value="supervision" ${this.kind==='supervision'?'selected':''}>安全监督计划</option><option value="construction" ${this.kind==='construction'?'selected':''}>施工计划</option></select></label><label>Excel 文件（.xlsx / .xls，最大 20 MB）<input data-rgp="file" type="file" accept=".xlsx,.xls" ${locked?'disabled':''}></label><button data-rgp-action="sample" ${locked?'disabled':''}>载入虚构示例表格</button>${this.file?`<button data-rgp-action="reset" ${this.busy?'disabled':''}>导入另一份</button>`:''}</div>${this.file?`<p class="rg-plan-source">原文件：${escape(this.file.name)} · ${(this.file.size/1024).toFixed(1)} KB${this.source?' · 原件已保存':''}</p>`:''}</section>${this.workbook?`<section class="rg-plan-section"><h3>2 · 核对工作表与字段</h3><div class="rg-plan-toolbar"><label>工作表<select data-rgp="sheet" ${locked?'disabled':''}>${this.workbook.SheetNames.map(name=>`<option value="${escape(name)}" ${name===this.sheet?'selected':''}>${escape(name)}</option>`).join('')}</select></label><label>表头所在行<input data-rgp="header" type="number" min="1" max="${Math.max(1,this.raw.length)}" value="${this.headerIndex+1}" ${locked?'disabled':''}></label></div><p>已尝试跳过合并标题行。请确认表头行与映射；原表未映射内容仍保留在 Excel 中。</p><div class="rg-plan-mapping">${FIELDS.map(([key,label])=>`<label>${label}<select data-rgp-map="${key}" ${locked?'disabled':''}><option value="">不导入此列</option>${(this.raw[this.headerIndex]||[]).map((_,index)=>`<option value="${index}" ${this.mapping[key]===index?'selected':''}>${index+1}列 · ${escape(this.display[this.headerIndex]?.[index]||`未命名列 ${index+1}`)}</option>`).join('')}</select></label>`).join('')}</div></section><section class="rg-plan-section"><h3>3 · 确认导入行</h3><p>共 ${this.rows.length} 行 · 已保存 ${saved.length} 行 · 待保存 ${pending.length} 行 · 异常 ${this.rows.filter(row=>row.errors.length).length} 行 · 已存在 ${this.rows.filter(row=>row.duplicateId).length} 行。异常行不会导入，可修正原表后重新选择。</p><div class="rg-plan-table-wrap"><table><thead><tr><th>选择</th><th>原表行 / 编号</th><th>作业 / 位置</th><th>日期 / 时段</th><th>机械关联</th><th>核对结果</th></tr></thead><tbody>${this.rows.length?this.rows.map(row=>`<tr><td><input type="checkbox" aria-label="导入第 ${row.rowNumber} 行" data-rgp-row="${row.rowNumber}" ${row.selected?'checked':''} ${locked||row.errors.length||row.duplicateId?'disabled':''}></td><td>第 ${row.rowNumber} 行<br>${escape(row.number||'未识别')}</td><td>${escape(row.name||'未识别')}<small>${escape([row.railwayLine,row.railwayTrack,row.railwayMileage].filter(Boolean).join(' · ')||'位置待补充')}</small></td><td>${escape(row.planStart||'无效')} — ${escape(row.planEnd||'无效')}<small>${escape(row.workWindowStart&&row.workWindowEnd?`${row.workWindowStart.slice(11)} — ${row.workWindowEnd.slice(11)}`:'时段待补充')}</small></td><td>${row.resourceIds.length} 台已匹配<small>${escape(row.resourceText||'原表未填写')}</small></td><td>${row.state==='saved'?'<span class="rg-plan-success">已保存待核验草稿</span>':''}${row.duplicateId?`<button class="rg-plan-mini" data-rgp-action="select-task" data-task-id="${escape(row.duplicateId)}" ${this.busy?'disabled':''}>查看已有作业</button>`:''}${row.errors.map(message=>`<div class="rg-plan-error">${escape(message)}</div>`).join('')}${row.warnings.map(message=>`<div class="rg-plan-warning">${escape(message)}</div>`).join('')}${row.saveError?`<div class="rg-plan-error">${escape(row.saveError)}</div>`:''}</td></tr>`).join(''):'<tr><td colspan="6">该表头之后没有数据，请检查工作表和表头行。</td></tr>'}</tbody></table></div><label class="rg-plan-check" style="margin-top:14px"><input type="checkbox" data-rgp="confirm" ${this.confirmed?'checked':''} ${locked?'disabled':''}>我已核对选中行、日期和字段对应关系；导入不代表正式计划已核验或允许施工。</label></section>`:''}${!permission?'<div class="rg-plan-alert">当前账号需要计划管理和文件访问权限，才能保存原表与作业草稿。</div>':''}${this.error?`<div class="rg-plan-alert" role="alert">${escape(this.error)}</div>`:''}${this.progress?`<div class="rg-plan-alert" role="status">${escape(this.progress)}</div>`:''}</div><footer><span>原始文件与来源行一并保存；作业状态为草稿，正式计划核验状态为待核验。</span><div class="rg-plan-actions">${saved.length?`<button data-rgp-action="select-task" data-task-id="${escape(saved[0].id)}" ${this.busy?'disabled':''}>查看已导入作业</button>`:''}<button class="rg-plan-primary" data-rgp-action="save" ${this.busy||!this.confirmed||!pending.length||!permission?'disabled':''}>${this.busy?'处理中…':this.started?'重试未保存行':`保存 ${pending.length} 条作业草稿`}</button></div></footer>`;
  }
  private change(event:Event){
    if(this.busy||this.started)return;
    const input=event.target as HTMLInputElement|HTMLSelectElement;
    if(input.dataset.rgp==='file'){const file=(input as HTMLInputElement).files?.[0];if(file)void this.read(file);return;}
    if(input.dataset.rgp==='kind'){this.kind=input.value as PlanKind;this.preview();}
    else if(input.dataset.rgp==='sheet'){this.sheet=input.value;this.readSheet();}
    else if(input.dataset.rgp==='header'){const value=Number(input.value);if(!Number.isInteger(value)||value<1||value>this.raw.length)return;this.headerIndex=value-1;this.mapping=detectRailwayPlanHeader([this.raw[this.headerIndex]||[]]).mapping;this.preview();}
    else if(input.dataset.rgp==='confirm'){this.confirmed=(input as HTMLInputElement).checked;this.render();}
    else if(input.dataset.rgpMap){const field=input.dataset.rgpMap as Field;if(input.value==='')delete this.mapping[field];else this.mapping[field]=Number(input.value);this.preview();}
    else if(input.dataset.rgpRow){const row=this.rows.find(row=>row.rowNumber===Number(input.dataset.rgpRow));if(row)row.selected=(input as HTMLInputElement).checked;this.confirmed=false;this.render();}
  }
  private async read(file:File){
    if(this.busy)return;
    if(!/\.(xlsx|xls)$/i.test(file.name)||file.size>20*1024*1024||!file.size){this.error='请选择不超过 20 MB 的非空 .xlsx 或 .xls 文件。';this.render();return;}
    this.reset();this.busy=true;this.progress='正在读取 Excel 原表…';this.render();const sequence=this.sequence;
    try{
      const [xlsx,buffer]=await Promise.all([getXlsx(),file.arrayBuffer()]);if(!this.isCurrent(sequence))return;
      const book=xlsx.read(buffer,{type:'array',cellDates:false,cellFormula:false,cellHTML:false,sheetRows:5002});
      if(!book.SheetNames.length)throw Error('Excel 中没有可读取的工作表。');
      this.file=file;this.workbook=book;this.sheet=book.SheetNames[0];this.readSheet();this.progress='请核对解析结果，尤其是日期、跨日时段与机械编号。';
    }catch(error){if(this.isCurrent(sequence))this.error=error instanceof Error?error.message:'Excel 读取失败';}
    finally{if(sequence===this.sequence){this.busy=false;this.render();}}
  }
  private readSheet(){
    if(!this.workbook||!window.XLSX)return;
    const sheet=this.workbook.Sheets[this.sheet];
    const reference=(sheet as Record<string,unknown>)['!ref'];
    const endColumn=String(reference||'').split(':').pop()?.match(/^([A-Z]+)/)?.[1]||'A';
    if([...endColumn].reduce((value,char)=>value*26+char.charCodeAt(0)-64,0)>256){this.raw=[];this.display=[];this.rows=[];this.error='工作表超过 256 列，请移除无关格式列或拆分后再导入。';this.render();return;}
    this.raw=window.XLSX.utils.sheet_to_json(sheet,{header:1,range:0,raw:true,defval:'',blankrows:true});
    this.display=window.XLSX.utils.sheet_to_json(sheet,{header:1,range:0,raw:false,defval:'',blankrows:true});
    if(this.raw.length>5000){this.error='单张工作表超过 5000 行，请拆分后导入，避免遗漏。';this.rows=[];this.render();return;}
    const detected=detectRailwayPlanHeader(this.raw);this.headerIndex=detected.headerIndex;this.mapping=detected.mapping;this.preview();
  }
  private preview(){
    const snapshot=this.options.getSnapshot();if(!snapshot||!this.isCurrent())return;
    if(this.raw.length>5000){this.rows=[];this.error='单张工作表超过 5000 行，请拆分后导入，避免遗漏。';this.render();return;}
    this.confirmed=false;this.error='';
    this.rows=previewRailwayPlanRows(this.raw,this.display,this.headerIndex,this.mapping,this.kind,snapshot,this.workbook?.Workbook?.WBProps?.date1904).map(row=>({...row,id:crypto.randomUUID(),key:crypto.randomUUID(),selected:!row.errors.length&&!row.duplicateId,state:'pending'}));
    this.render();
  }
  private async sample(){
    if(this.busy||this.started)return;this.busy=true;this.progress='正在准备虚构示例…';this.render();const sequence=this.sequence;
    try{
      const xlsx=await getXlsx();if(!this.isCurrent(sequence))return;
      const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const book=xlsx.utils.book_new();xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet([['虚构示例 — 仅用于体验导入流程'],['计划编号','施工项目','施工日期','结束日期','开始时间','结束时间','线路','里程','行别','机械编号'],[`示例-${today}-01`,'示例工点吊装',today,today,'09:00','11:30','示例铁路','K12+300—K12+400','上行','待关联机械编号'],[`示例-${today}-02`,'示例工点巡查',today,today,'14:00','15:00','示例铁路','K12+500','下行','']]),'示例计划');
      const data=xlsx.write(book,{bookType:'xlsx',type:'array'});this.busy=false;
      await this.read(new File([data],`虚构示例计划_${today}.xlsx`,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    }catch(error){if(this.isCurrent(sequence)){this.error=error instanceof Error?error.message:'示例读取失败';this.busy=false;this.render();}}
    finally{if(sequence===this.sequence&&this.busy){this.busy=false;this.render();}}
  }
  private async save(){
    if(this.busy||!this.file||!this.confirmed||!this.isCurrent())return;
    const snapshot=this.options.getSnapshot();if(!snapshot?.session.permissions.includes('plan')||!snapshot.session.permissions.includes('files'))return;
    const pending=this.rows.filter(row=>row.selected&&!row.errors.length&&!row.duplicateId&&row.state!=='saved');if(!pending.length)return;
    this.busy=true;this.started=true;this.error='';this.progress='保存 Excel 原件…';this.render();const sequence=this.sequence;
    try{
      if(!this.source){const source=await this.options.upload(this.file,{workflowCategory:this.kind==='construction'?'construction-plan':'supervision-plan'});if(!this.isCurrent(sequence))return;this.source=source;}
      for(let index=0;index<pending.length;index++){
        if(!this.isCurrent(sequence))return;
        const row=pending[index];row.saveError=undefined;this.progress=`正在保存 ${index+1} / ${pending.length}：${row.name}`;this.render();
        const meta={kind:this.kind,number:row.number,sourceEvidenceId:this.source!.id,sheetName:this.sheet,rowNumber:row.rowNumber,verificationStatus:'pending',resourceText:row.resourceText,unmatchedResources:row.unmatchedResources};
        const payload:Record<string,unknown>={name:row.name,planStart:row.planStart,planEnd:row.planEnd,resourceIds:row.resourceIds,areaIds:[],railwayPlan:meta};
        for(const field of ['railwayLine','railwayMileage','railwayTrack','workWindowStart','workWindowEnd'] as const)if(row[field])payload[field]=row[field];
        try{
          const result=await this.options.command('task.create',payload,row.id,undefined,row.key);if(!this.isCurrent(sequence))return;
          row.state='saved';this.options.onSaved(result);
        }catch(error){if(!this.isCurrent(sequence))return;row.state='failed';row.saveError=error instanceof Error?error.message:'保存失败，请重试';}
      }
      if(this.isCurrent(sequence)){const saved=this.rows.filter(row=>row.state==='saved').length,failed=this.rows.filter(row=>row.state==='failed').length;this.progress=`已保存 ${saved} 条待核验作业草稿${failed?`，${failed} 条失败。修复权限或项目配置后可重试未保存行。`:'。可进入作业查看并继续补充现场关联。'}`;this.options.toast(this.progress);}
    }catch(error){if(this.isCurrent(sequence))this.error=error instanceof Error?error.message:'原件保存失败，可保留本窗口重试';}
    finally{if(sequence===this.sequence){this.busy=false;this.render();}}
  }
}
