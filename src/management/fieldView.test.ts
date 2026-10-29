import test from 'node:test';
import assert from 'node:assert/strict';
import type { ManagementRecord } from '../managementTypes.ts';
import { fieldDirectory, fieldIssues, fieldNavigation, fieldSection, fieldTaskChoices, currentFieldTask, issueMachineryId, machineryTasks } from './fieldView.ts';
const row=(id:string, values:Partial<ManagementRecord>={}):ManagementRecord=>({id,name:id,projectId:'p',revision:1,status:'active',createdAt:'2026-10-14T00:00:00Z',updatedAt:'2026-10-14T00:00:00Z',createdBy:'u',...values});

test('three primary entries preserve separately reachable business modules',()=>{
  assert.deepEqual(fieldNavigation.map(item=>item.id),['scene','inspection','documents']);
  assert.equal(fieldSection('documents','files','scene'),'scene');
  assert.equal(fieldSection('documents','reports','management'),'documents');
  assert.equal(fieldSection('inspection','media','management'),'inspection');
  assert.equal(fieldSection('field','checks','management'),'inspection');
  for(const module of ['overview','plan','resources'] as const)assert.equal(fieldSection(module,'tasks','management'),'more');
  assert.equal(fieldSection('field','today','management'),'more');
});

test('all equipment are counted once, including unplaced and hidden records, excluding both deletion representations',()=>{
  const records=[row('a',{kind:'equipment',name:'汽车吊'}),row('b',{kind:'equipment',availability:'disabled'}),row('a',{kind:'equipment',name:'汽车吊'}),row('gone',{kind:'equipment',status:'deleted'}),row('gone2',{kind:'equipment',deletedAt:'2026-10-14'}),row('crew',{kind:'crew'})];
  const before=JSON.stringify(records);
  assert.deepEqual(fieldDirectory(records).map(record=>record.id),['a','b']);
  assert.deepEqual(fieldDirectory(records,'汽车').map(record=>record.id),['a']);
  assert.deepEqual(fieldDirectory(records,' B ').map(record=>record.id),['b']);
  assert.equal(JSON.stringify(records),before);
});

test('machine lookup finds a user identifier without exposing deleted matches',()=>{
  const records=[row('uuid-1',{kind:'equipment',name:'吊机',equipmentCode:'QZ-001'}),row('uuid-2',{kind:'equipment',name:'旧吊机',equipmentCode:'QZ-001',status:'deleted'}),row('uuid-3',{kind:'equipment',equipmentCode:'QZ-002'})];
  assert.deepEqual(fieldDirectory(records,' qz-001 ').map(record=>record.id),['uuid-1']);
  assert.deepEqual(fieldDirectory(records,'QZ-003'),[]);
});

test('new work cards and historical allocations resolve only explicit IDs among visible tasks',()=>{
  const machine=row('machine',{taskIds:['legacy','not-visible']}),tasks=[row('card',{resourceIds:['machine']}),row('legacy'),row('allocation'),row('name-only',{name:'machine'}),row('deleted',{resourceIds:['machine'],deletedAt:'2026-10-14'})];
  const related=[row('allocation-row',{taskId:'allocation',resourceId:'machine'}),row('cancelled',{taskId:'name-only',resourceId:'machine',status:'cancelled'})];
  assert.deepEqual(machineryTasks(machine,tasks,related).map(task=>task.id),['card','legacy','allocation']);
  assert.deepEqual(machineryTasks(machine,[],related),[]);
});

test('machine issue filtering uses the frozen reference and never names or inferred shared tasks',()=>{
  const issues=[row('frozen',{status:'pending-review',railSafetyRisk:{resourceId:'machine'}}),row('manual',{status:'pending-verification',resourceId:'machine'}),row('unrelated',{name:'machine',taskId:'same',status:'pending-verification'}),row('foreign',{status:'pending-verification',railSafetyRisk:{resourceId:'other'}})];
  assert.equal(issueMachineryId(issues[0]),'machine');
  assert.equal(issueMachineryId(issues[2]),undefined);
  assert.deepEqual(fieldIssues(issues,'machine').map(issue=>issue.id),['frozen','manual']);
  assert.equal(fieldIssues(issues).length,4);
});

test('all terminal problem dispositions and deleted records are excluded from open count',()=>{
  const issues=['closed','false-positive','duplicate','invalid','archived'].map(status=>row(status,{status}));
  issues.push(row('deleted',{status:'pending-review',deletedAt:'2026-10-14'}),row('open',{status:'pending-review'}));
  assert.deepEqual(fieldIssues(issues).map(issue=>issue.id),['open']);
});

test('scene task choices remain independent of documents and honor only explicit workpoint relation',()=>{
  const tasks=[row('a',{areaIds:['point']}),row('b'),row('c',{spatialObjectId:'point'}),row('cancelled',{status:'cancelled',areaIds:['point']}),row('deleted',{deletedAt:'2026-10-14'})];
  assert.deepEqual(fieldTaskChoices(tasks).map(task=>task.id),['a','b','c']);
  assert.deepEqual(fieldTaskChoices(tasks,'point').map(task=>task.id),['a','c']);
  assert.deepEqual(fieldTaskChoices(tasks,'point','b').map(task=>task.id),['a','b','c']);
  assert.deepEqual(fieldTaskChoices(tasks,'point','cancelled').map(task=>task.id),['a','c','cancelled']);
});


test('explicit field plan survives unrelated object choices and never guesses when revoked',()=>{
  const tasks=[row('selected',{resourceIds:['machine-a']}),row('other',{resourceIds:['machine-b']})];
  assert.equal(currentFieldTask(tasks,'selected')?.id,'selected');
  assert.equal(currentFieldTask(tasks),undefined);
  assert.equal(currentFieldTask(tasks,'revoked'),undefined);
  assert.equal(currentFieldTask([row('selected',{deletedAt:'2026-10-15'})],'selected'),undefined);
  assert.equal(currentFieldTask([row('selected',{status:'deleted'})],'selected'),undefined);
});

test('object-linked field findings appear against their selected mechanical object',()=>{
  const issue=row('object-linked',{status:'pending-verification',objectRefs:[{kind:'resources',id:'machine-b'}]});
  assert.equal(issueMachineryId(issue),'machine-b');
  assert.equal(fieldIssues([issue],'machine-a').length,0);
  assert.equal(fieldIssues([issue],'machine-b').length,1);
});


test('single objectRef from new field issues filters by machinery without treating guards as machinery',()=>{
  const issue=row('single-ref',{status:'pending-verification',objectRef:{kind:'resources',id:'machine-b'}});
  const guard=row('guard-ref',{status:'pending-verification',objectRef:{kind:'railSafety',id:'machine-b'}});
  assert.equal(issueMachineryId(issue),'machine-b');
  assert.equal(issueMachineryId(guard),undefined);
  assert.deepEqual(fieldIssues([issue,guard],'machine-b').map(record=>record.id),['single-ref']);
  assert.equal(fieldIssues([issue],'machine-a').length,0);
});
