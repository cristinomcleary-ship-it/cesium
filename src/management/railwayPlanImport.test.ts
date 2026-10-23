import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ManagementSnapshot, ManagementRecord } from '../managementTypes.ts';
import { MANAGEMENT_COLLECTIONS } from '../managementTypes.ts';

// Load pure parser exports without asking Node to load the browser-only stylesheet.
const source=readFileSync(new URL('./railwayPlanImport.ts',import.meta.url),'utf8').replace("import './railwayPlanImport.css';",'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const parser=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64')) as typeof import('./railwayPlanImport.ts');
const row=(id:string,extra:Record<string,unknown>={}):ManagementRecord=>({id,projectId:'p',revision:1,name:id,status:'active',createdAt:'',updatedAt:'',createdBy:'u',...extra});
const snapshot=():ManagementSnapshot=>({schemaVersion:1,revision:1,projectId:'p',session:{userId:'u',displayName:'u',roles:['owner'],permissions:['read','plan','files'],authMode:'local-owner'},projects:[],members:[],collections:Object.fromEntries(MANAGEMENT_COLLECTIONS.map(key=>[key,[] as ManagementRecord[]])) as ManagementSnapshot['collections'],updatedAt:'',audit:[]});
const headers=['计划编号','施工项目','施工日期','结束日期','开始时间','结束时间','线路','里程','行别','机械编号'];

test('finds actual header after title and blank rows; preserves physical source row',()=>{
  const data=[['月度计划标题'],[],headers,['P-1','起重吊装','2026/10/15','2026/10/16','23:30','01:20','甲线','K1+200','上行','']];
  const detected=parser.detectRailwayPlanHeader(data);assert.equal(detected.headerIndex,2);
  const [record]=parser.previewRailwayPlanRows(data,data,detected.headerIndex,detected.mapping,'supervision',snapshot());
  assert.equal(record.rowNumber,4);assert.equal(record.workWindowStart,'2026-10-15T23:30');assert.equal(record.workWindowEnd,'2026-10-16T01:20');assert.deepEqual(record.errors,[]);
});
test('rejects impossible dates and ambiguous overnight time instead of silently changing dates',()=>{
  assert.equal(parser.railwayPlanDate('2026-02-30'),undefined);
  assert.equal(parser.railwayPlanDate('10月15日'),undefined);
  assert.equal(parser.railwayPlanDate(60),undefined);
  assert.equal(parser.railwayPlanDate(0,true),'1904-01-01');
  assert.equal(parser.railwayPlanDate(1),'1900-01-01');
  assert.equal(parser.railwayPlanTime('24:00'),undefined);
  assert.equal(parser.railwayPlanTime('09:30:15'),undefined);
  assert.equal(parser.railwayPlanTime(.5),'12:00');
  const data=[headers,['P-1','起重吊装','2026-10-15','','23:30','01:20']];const header=parser.detectRailwayPlanHeader(data);
  const [record]=parser.previewRailwayPlanRows(data,data,0,header.mapping,'construction',snapshot());
  assert.ok(record.errors.some(message=>message.includes('跨日')));
});
test('matches only visible equipment IDs/codes, retaining unknown and ambiguous references',()=>{
  const state=snapshot();state.collections.resources=[row('machine-a',{kind:'equipment',equipmentCode:'CR-01'}),row('machine-b',{kind:'equipment',equipmentCode:'DUP'}),row('machine-c',{kind:'equipment',equipmentCode:'DUP'}),row('other-project',{projectId:'other',kind:'equipment',equipmentCode:'HIDDEN'}),row('crew',{kind:'crew',equipmentCode:'PERSON'})];
  const data=[headers,['P-1','吊装','2026-10-15','2026-10-15','09:00','10:00','','','','CR-01，DUP;HIDDEN;PERSON;名称不能猜']];const header=parser.detectRailwayPlanHeader(data);
  const [record]=parser.previewRailwayPlanRows(data,data,0,header.mapping,'supervision',state);
  assert.deepEqual(record.resourceIds,['machine-a']);assert.deepEqual(record.unmatchedResources,['DUP','HIDDEN','PERSON','名称不能猜']);assert.ok(record.warnings.some(message=>message.includes('原文保留')));
});
test('duplicate formal number/kind/date skips existing task and flags repeated rows; input snapshot is untouched',()=>{
  const state=snapshot();state.collections.tasks=[row('existing',{planStart:'2026-10-15',railwayPlan:{kind:'supervision',number:'P-1'}})];
  const before=JSON.stringify(state);const data=[headers,['P-1','吊装','2026-10-15'],['P-1','重复吊装','2026-10-15']];const header=parser.detectRailwayPlanHeader(data);
  const rows=parser.previewRailwayPlanRows(data,data,0,header.mapping,'supervision',state);
  assert.equal(rows[0].duplicateId,'existing');assert.ok(rows[1].errors.some(message=>message.includes('表内')));assert.equal(JSON.stringify(state),before);
  assert.equal(parser.previewRailwayPlanRows(data,data,0,header.mapping,'construction',state)[0].duplicateId,undefined);
});
test('bundled SheetJS reads real XLSX and XLS bytes, keeps formatted codes and Excel dates',()=>{
  const sandbox:{XLSX?:Record<string,any>}={};
  runInNewContext(readFileSync(new URL('../../public/management/vendor/xlsx.full.min.js',import.meta.url),'utf8'),sandbox);
  const xlsx=sandbox.XLSX!;
  for(const bookType of ['xlsx','biff8']){
    const book=xlsx.utils.book_new(),sheet=xlsx.utils.aoa_to_sheet([['虚构计划'],headers,['P-1','吊装',46310,46310,.375,.5,'测试铁路','K1+100','上行',12]]);
    sheet.J3.z='0000';xlsx.utils.book_append_sheet(book,sheet,'当日计划');
    const bytes=xlsx.write(book,{type:'array',bookType}),read=xlsx.read(bytes,{type:'array',cellDates:false});
    const raw=xlsx.utils.sheet_to_json(read.Sheets['当日计划'],{header:1,range:0,raw:true,defval:''});
    const display=xlsx.utils.sheet_to_json(read.Sheets['当日计划'],{header:1,range:0,raw:false,defval:''});
    const header=parser.detectRailwayPlanHeader(raw),[record]=parser.previewRailwayPlanRows(raw,display,header.headerIndex,header.mapping,'construction',snapshot());
    assert.equal(record.resourceText,'0012');assert.equal(record.planStart,'2026-10-15');assert.equal(record.workWindowStart,'2026-10-15T09:00');assert.deepEqual(record.errors,[]);
  }
});

test('partial failure retries only unsaved rows with the same operation key and uploaded original',async()=>{
  const state=snapshot(),calls:Array<{id:string|undefined;key:string;payload:Record<string,unknown>}> = [];let uploads=0,failed=false,saved=0;
  const importer:any=new parser.RailwayPlanImporter({host:{} as HTMLElement,getSnapshot:()=>state,upload:async()=>{uploads++;return row('source');},command:async(_type,payload,id,_revision,key)=>{calls.push({id,key,payload});if(id==='two'&&!failed){failed=true;throw Error('暂时连接失败');}return state;},onSaved:()=>saved++,onTaskSelected:()=>{},toast:()=>{}});
  const data=[headers,['P-1','作业一','2026-10-15'],['P-2','作业二','2026-10-15']],mapping=parser.detectRailwayPlanHeader(data).mapping;
  importer.context='p\u0000u';importer.file=new File(['original'],'plan.xlsx');importer.confirmed=true;importer.sheet='计划';
  importer.rows=parser.previewRailwayPlanRows(data,data,0,mapping,'supervision',state).map((value,index)=>({...value,id:index?'two':'one',key:index?'stable-two':'stable-one',selected:true,state:'pending'}));
  await importer.save();assert.equal(uploads,1);assert.equal(saved,1);assert.equal(importer.rows[1].state,'failed');
  await importer.save();assert.equal(uploads,1);assert.equal(saved,2);assert.deepEqual(calls.map(value=>value.id),['one','two','two']);assert.equal(calls[1].key,calls[2].key);
  assert.deepEqual(calls[1].payload,calls[2].payload);assert.equal((calls[2].payload.railwayPlan as Record<string,unknown>).verificationStatus,'pending');
});

test('account switch while original uploads prevents task writes and stale snapshot application',async()=>{
  const state=snapshot();let writes=0,applied=0;
  const importer:any=new parser.RailwayPlanImporter({host:{} as HTMLElement,getSnapshot:()=>state,upload:async()=>{state.session.userId='other';return row('source');},command:async()=>{writes++;return state;},onSaved:()=>applied++,onTaskSelected:()=>{},toast:()=>{}});
  const data=[headers,['P-1','作业','2026-10-15']],mapping=parser.detectRailwayPlanHeader(data).mapping;
  importer.context='p\u0000u';importer.file=new File(['original'],'plan.xlsx');importer.confirmed=true;
  importer.rows=parser.previewRailwayPlanRows(data,data,0,mapping,'construction',state).map(value=>({...value,id:'task',key:'stable',selected:true,state:'pending'}));
  await importer.save();assert.equal(writes,0);assert.equal(applied,0);
});
