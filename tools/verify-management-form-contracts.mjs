import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MANAGEMENT_FORMS } from '../src/management/forms.ts';
const out=path.resolve('output/platform-management');await mkdir(out,{recursive:true});
const checks=[];const check=(name,passed,details)=>checks.push({name,passed,...(details?{details}:{})});
const expects={
 'task.create':'name ownerId planStart planEnd areaIds',
 'task.forecast':'forecastEnd reason',
 'commitment.create':'taskId weekStart originalDueDate targetQuantity unit basis criterion',
 'commitment.change':'action dueDate reason',
 'progress.create':'taskId quantity unit businessDate shift crew measurementKey explanation evidenceIds',
 'progress.revise':'quantity unit businessDate shift crew measurementKey reason',
 'dailyLog.create':'taskId businessDate description progressEntryIds',
 'check.create':'name taskId businessDate items purpose',
 'check.copy':'sourceId businessDate',
 'check.record':'items',
 'issue.create':'name kind checkId riskPointId',
 'issue.assign':'ownerId dueDate',
 'issue.submit':'description evidenceIds',
 'issue.review':'passed reason',
 'issue.reschedule':'dueDate reason',
 'inspection.create':'name ownerId dueDate taskIds areaIds scheduledDate planId',
 'inspection.record':'result evidenceIds',
 'resource.create':'name kind qualificationEvidenceIds locationDescription validUntil availability',
 'resource.update':'name kind reason',
 'need.create':'taskId name kind dueDate quantity unit',
 'need.confirm':'basis batchId resourceId',
 'batch.create':'name batchNumber unit',
 'batch.receive':'quantity businessDate',
 'batch.accept':'passed basis',
 'test.create':'name businessDate batchId taskId result evidenceIds',
 'test.confirm':'result evidenceIds',
 'material.issue':'batchId taskId quantity businessDate',
 'material.return':'batchId taskId quantity businessDate',
 'material.correct':'batchId taskId quantity businessDate reason',
 'document.version':'documentId evidenceId revisionNote',
 'document.submit':'reviewerId dueDate',
 'document.publish':'basis',
 'document.fulfill':'versionId',
 'link.create':'taskId targetKind targetId',
 'technical.create':'name ownerId dueDate documentVersionId',
 'technical.comment':'text',
 'technical.answer':'answer',
 'change.create':'name reason taskIds technicalQueryId impacts',
 'change.confirm':'basis',
 'meeting.create':'name businessDate minutes',
 'action.create':'name ownerId dueDate',
 'action.complete':'result',
 'monitoring.create':'name unit sourceDescription validForSeconds',
 'monitoring.record':'value sampledAt quality source',
 'monitoring.threshold':'low high basis',
 'report.freeze':'name D F taskIds template',
 'report.publish':'managerComment',
 'evidence.register':'recordId fileKey mediaSeconds',
 'anchor.create':'name purpose taskId',
 'anchor.update':'name purpose taskId',
};
const source=await readFile('src/managementTypes.ts','utf8');
const union=source.split('export type ManagementCommandType =')[1].split(';')[0];
const commandNames=[...union.matchAll(/"([\w.-]+)"/g)].map(m=>m[1]);
check('Every declared API command has one form definition',commandNames.every(k=>MANAGEMENT_FORMS[k]),{commandCount:commandNames.length,formCount:Object.keys(MANAGEMENT_FORMS).length,missing:commandNames.filter(k=>!MANAGEMENT_FORMS[k])});
for(const [command,spec] of Object.entries(MANAGEMENT_FORMS)){
 const fields=spec.fields.map(f=>f?.name);
 check(`${command}: unique named inputs`,fields.every(Boolean)&&new Set(fields).size===fields.length,{fields});
}
for(const [command,required]of Object.entries(expects)){
 const fields=MANAGEMENT_FORMS[command]?.fields.map(f=>f.name)||[];
 const missing=required.split(' ').filter(f=>!fields.includes(f));
 check(`${command}: actual API payload field names`,missing.length===0,{missing});
}
for(const command of ['issue.review','batch.accept']){
 const field=MANAGEMENT_FORMS[command].fields.find(f=>f.name==='passed');
 check(`${command}: boolean conversion explicitly declared`,field?.valueType==='boolean'&&JSON.stringify(field.options.map(o=>o[0]))==='["true","false"]');
}
for(const [command,name,values]of [
 ['commitment.create','basis',['incremental','cumulative']],
 ['commitment.change','action',['reschedule','cancel']],
 ['issue.dismiss','disposition',['false-positive','duplicate']],
 ['test.create','result',['pending','pass','fail']],
 ['test.confirm','result',['pass','fail']],
 ['monitoring.record','quality',['valid','invalid','disconnected']],
 ['check.create','purpose',['preconstruction','quality','safety','acceptance']],
]){
 const field=MANAGEMENT_FORMS[command].fields.find(f=>f.name===name);
 check(`${command}.${name}: API enum values`,field?.options?.length===values.length&&values.every(value=>field.options.some(o=>o[0]===value)));
}
check('Name-only task draft does not require assignee',MANAGEMENT_FORMS['task.create'].fields.filter(f=>f.required).every(f=>f.name==='name'));
check('Bootstrap owner role is selectable',MANAGEMENT_FORMS['member.save'].fields.find(f=>f.name==='roles').options.some(o=>o[0]==='owner'));
for(const command of ['anchor.create','anchor.update'])check(`${command}: only verified scene context supplies position`,MANAGEMENT_FORMS[command].requiresSceneContext==='model-surface');
for(const command of ['bookmark.create','bookmark.update'])check(`${command}: actual camera snapshot required`,MANAGEMENT_FORMS[command].requiresSceneContext==='camera');
for(const [command,permission]of [['commitment.publish','confirm'],['change.confirm','confirm'],['report.freeze','confirm'],['report.publish','confirm'],['document.return','document'],['action.create','document']])check(`${command}: UI permission agrees with server action`,MANAGEMENT_FORMS[command].permission===permission);
const result={classification:'cpu-declarative-api-form-contract-only',generatedAt:new Date().toISOString(),passed:checks.every(c=>c.passed),checks,summary:{count:checks.length,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length},notProven:['Actual form submit normalization and UI behavior require browser validation.','Model surface/camera contexts must come from the active SceneAdapter.','Datetime offsets, boolean conversion, report filters and nested item evidence require submit integration.']};
await writeFile(path.join(out,'form-contract-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result.summary,overallPassed:result.passed,failedChecks:checks.filter(c=>!c.passed)},null,2));process.exitCode=result.passed?0:1;
