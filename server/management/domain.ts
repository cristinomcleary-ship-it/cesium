import { newCheckItems,recordCheckItems,confirmCheckIntegrity,checklistVersion } from "./checkIntegrity.ts";
import { configureTaskConditions,enforceTaskConditions } from "./taskConditions.ts";
import { MachineryValidationError,validateMachineryMetadata } from "../../src/machineryValidation.ts";
import { RailSafetyValidationError,validateRailSafetyDefinition } from "../../src/railSafetyValidation.ts";
import type { RailSafetyDefinition } from "../../src/railSafetyTypes.ts";
import { randomUUID } from "node:crypto";
import type { ManagementCollection, ManagementCommand, ManagementRecord, ManagementRole, ManagementPermission, ProgressEntry, ProgressRevision, ManagementCheckItem } from "../../src/managementTypes.ts";

export class ManagementError extends Error {
 constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly current?: unknown) { super(message); }
}
export function ensure(test: unknown, code: string, message: string, details?: unknown): asserts test { if (!test) throw new ManagementError(400,code,message,details); }
export const rolePermissions: Record<ManagementRole,ManagementPermission[]> = {
 owner:["read","plan","confirm","field","review","inspect","resource","document","publish","admin","models","files","media"],
 manager:["read","plan","confirm","field","review","inspect","resource","document","publish","models","files","media"],
 planner:["read","plan","confirm","models","files","media"], quality:["read","field","review","models","files","media"],
 inspector:["read","inspect","field","models","files","media"], resource:["read","resource","models","files","media"],
 document:["read","document","publish","models","files","media"], worker:["read","field","models","files","media"], viewer:["read","models","files","media"]
};
export type Actor = { id:string; displayName:string; roles:ManagementRole[]; permissions:ManagementPermission[]; authMode:"local-owner"|"local-account"; taskIds?:string[]; expiresAt?:string };
export function allow(actor:Actor,permission:ManagementPermission) { if(!actor.permissions.includes(permission)) throw new ManagementError(403,"FORBIDDEN",`当前身份无 ${permission} 操作权限`); }
export const str=(value:unknown,label:string,max=4000):string=>{ensure(typeof value==="string"&&value.trim().length>0&&value.length<=max,"INVALID_FIELD",`${label}不能为空或超长`);return value.trim();};
export const id=(value:unknown,label="编号")=>{const result=str(value,label,120);ensure(/^[a-zA-Z0-9:_-]+$/.test(result),"INVALID_ID",`${label}格式无效`);return result;};
export const ids=(value:unknown):string[]=>{ensure(value===undefined||Array.isArray(value),"INVALID_IDS","关联编号应为列表");const result=(value||[]) as unknown[];ensure(result.length<=1000,"TOO_MANY_LINKS","关联过多");return [...new Set(result.map(v=>id(v)))];};
export const num=(value:unknown,label:string,min=0)=>{ensure(typeof value==="number"&&Number.isFinite(value)&&value>=min,"INVALID_NUMBER",`${label}必须是大于等于${min}的有限数值`);return value;};
export function date(value:unknown,label="日期"):string {const s=str(value,label,10);ensure(/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+"T00:00:00Z"))&&new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s,"INVALID_DATE",`${label}须是有效 YYYY-MM-DD 日期`);return s;}
export function instant(value:unknown,label="时间"):string {const s=str(value,label,40);ensure(/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s)),"INVALID_TIME",`${label}须包含明确时区`);return new Date(s).toISOString();}
export function pick(p:Record<string,unknown>,keys:string[]) { return Object.fromEntries(keys.filter(k=>p[k]!==undefined).map(k=>[k,structuredClone(p[k])])); }
export interface DomainContext {
 actor:Actor; projectId:string; now:string; command:ManagementCommand; workingDays:number[]; dataVersion?:number; businessDate?:string;
 list:(kind:ManagementCollection)=>ManagementRecord[];
 get:(kind:ManagementCollection,id:string)=>ManagementRecord;
 save:(kind:ManagementCollection,record:ManagementRecord)=>void;
 member:(id:string,taskIds?:string[],permission?:ManagementPermission)=>void; area:(id:string)=>void; evidence:(id:string)=>void;
 freeze:(payload:Record<string,unknown>)=>Record<string,unknown>;
}
const mutableTaskFields=["name","wbsId","ownerId","planStart","planEnd","targetQuantity","unit","weight","milestone","areaIds","predecessorIds","description"];
function requiredState(record:ManagementRecord,states:string[]) { if(!states.includes(record.status))throw new ManagementError(409,"INVALID_STATE",`当前状态 ${record.status} 不允许该操作`,{allowed:states},record); }
function taskAccess(c:DomainContext,taskId:unknown) {const task=c.get("tasks",id(taskId,"任务"));if(c.actor.taskIds&&!c.actor.taskIds.includes(task.id))throw new ManagementError(403,"TASK_FORBIDDEN","任务不在授权范围");if(c.actor.roles.includes("worker")&&!c.actor.roles.some(r=>["owner","manager","planner"].includes(r))&&["task.start","task.request-completion","progress.create","progress.revise","progress.submit","dailyLog.create"].includes(c.command.type)&&task.ownerId!==c.actor.id)throw new ManagementError(403,"TASK_EXECUTOR_REQUIRED","现场填报人员只能办理本人负责的执行任务");return task;}
function validateLinks(c:DomainContext,p:Record<string,unknown>) {
 if(p.taskId!==undefined)taskAccess(c,p.taskId);
 if(p.taskIds!==undefined)for(const v of ids(p.taskIds))taskAccess(c,v);
 if(p.areaIds!==undefined)for(const v of ids(p.areaIds))c.area(v);
 if(p.ownerId!==undefined)c.member(id(p.ownerId,"负责人"));
 if(p.evidenceIds!==undefined)for(const v of ids(p.evidenceIds))c.evidence(v);
}
export function applyDomain(c:DomainContext):{collection:ManagementCollection;record:ManagementRecord} {
 const {command:m,actor,now}=c,p=m.payload;let collection:ManagementCollection;let r:ManagementRecord;
 const create=(kind:ManagementCollection,fields:Record<string,unknown>,status="draft"):ManagementRecord=>{
  ensure(m.expectedRevision===undefined||m.expectedRevision===0,"REVISION_CONFLICT","新建记录预期修订应为0");
  const key=m.id?id(m.id):randomUUID();ensure(!c.list(kind).some(v=>v.id===key),"ALREADY_EXISTS","编号已存在");
  validateLinks(c,fields);collection=kind;r={...fields,id:key,projectId:c.projectId,revision:1,name:String(fields.name||m.type),status,createdAt:now,updatedAt:now,createdBy:actor.id};return r;
 };
 const load=(kind:ManagementCollection):ManagementRecord=>{
  collection=kind;r=structuredClone(c.get(kind,id(m.id)));if(r.taskId)taskAccess(c,r.taskId);for(const taskId of ids(r.taskIds))taskAccess(c,taskId);if(kind==="tasks")taskAccess(c,r.id);
  if(m.expectedRevision!==r.revision)throw new ManagementError(409,"REVISION_CONFLICT","记录已变化，请核对新版本；当前输入仍可保留",{expected:m.expectedRevision,actual:r.revision},r);r.revision++;r.updatedAt=now;return r;
 };
 const evidence=(v:unknown)=>{const a=ids(v);a.forEach(c.evidence);return a;};
 const reason=()=>str(p.reason,"原因或意见");
 const recheckNeeds=(predicate:(n:ManagementRecord)=>boolean,why:string)=>{for(const n of c.list("resourceNeeds").filter(n=>n.status==="confirmed"&&predicate(n))){n.revision++;n.updatedAt=now;n.status="unconfirmed";n.recheckReason=why;c.save("resourceNeeds",n);}};
 const recheckDocumentRequirements=(versionId:string)=>{for(const requirement of c.list("documentRequirements").filter(v=>v.status==="confirmed"&&v.versionId===versionId)){requirement.revision++;requirement.updatedAt=now;requirement.status="pending-recheck";requirement.recheckReason="适用资料版本已替代或作废，请重新核对";c.save("documentRequirements",requirement);}};
 const taskFields=(v:Record<string,unknown>)=>{
  str(v.name,"任务名称",200);if(v.wbsId)c.get("wbs",id(v.wbsId));
  validateLinks(c,v);if(v.planStart||v.planEnd){date(v.planStart,"计划开始");date(v.planEnd,"计划完成");ensure(String(v.planStart)<=String(v.planEnd),"DATE_CONFLICT","开始日期不能晚于完成日期");}
  if(v.planStart&&v.planEnd){for(const endpoint of [v.planStart,v.planEnd])ensure(c.workingDays.includes(new Date(String(endpoint)+"T00:00:00Z").getUTCDay()),"WORK_CALENDAR_CONFLICT","计划起止日期不在项目工作日历内",{date:endpoint,workingDays:c.workingDays});}
  if(v.targetQuantity!==undefined){num(v.targetQuantity,"目标量",0.0000001);str(v.unit,"单位",30);}
  if(v.weight!==undefined)num(v.weight,"权重",0.0000001);
 };
 const dependencyCheck=(task:ManagementRecord)=>{
  const all=c.list("tasks").filter(v=>v.id!==task.id).concat(task),map=new Map(all.map(v=>[v.id,v]));
  const seen=new Set<string>(),open=new Set<string>();
  const visit=(key:string)=>{if(open.has(key))throw new ManagementError(409,"DEPENDENCY_CYCLE","前置关系形成环路",{taskId:key});if(seen.has(key))return;open.add(key);const v=map.get(key)!;
   for(const dep of ids(v.predecessorIds)){ensure(map.has(dep),"DEPENDENCY_MISSING","前置任务不存在");const prior=map.get(dep)!;ensure(!v.planStart||!prior.planEnd||String(prior.planEnd)<=String(v.planStart),"DEPENDENCY_DATE_CONFLICT","前置任务完成晚于后续开始",{taskId:key,predecessorId:dep});visit(dep);}open.delete(key);seen.add(key);};all.forEach(v=>visit(v.id));
 };
 const permission=m.type.startsWith("task.")||m.type.startsWith("wbs.")||m.type.startsWith("baseline.")||m.type.startsWith("commitment.")?"plan"
  :m.type.startsWith("railSafety.")||m.type.startsWith("resource.")||m.type.startsWith("machinery.")||m.type.startsWith("need.")||m.type.startsWith("allocation.")||m.type.startsWith("usage.")||m.type.startsWith("batch.")||m.type.startsWith("test.")||m.type.startsWith("material.")?"resource"
  :m.type.startsWith("document.")||m.type.startsWith("technical.")||m.type.startsWith("meeting.")||m.type.startsWith("action.")||m.type.startsWith("change.")||m.type.startsWith("link.")?"document"
  :m.type.startsWith("anchor.")?"document":m.type.startsWith("inspection.")||m.type.startsWith("monitoring.")?"inspect"
  :m.type.startsWith("report.")?"confirm":m.type.startsWith("bookmark.")?"read":"field";
 if(["progress.confirm","progress.return","progress.revoke","task.confirm-completion","baseline.approve","commitment.publish","change.confirm"].includes(m.type))allow(actor,"confirm");
 else if(["check.confirm","issue.assign","issue.review","issue.dismiss"].includes(m.type))allow(actor,"review");
 else if(["document.publish","document.void","technical.publish"].includes(m.type))allow(actor,"publish");else if(["task.start","task.request-completion","technical.create","technical.comment","action.complete","document.create","document.version","document.submit","anchor.create","anchor.update"].includes(m.type)){if(!actor.permissions.includes(permission))allow(actor,"field");}else allow(actor,permission);
 switch(m.type){
 case "railSafety.save":{
  allow(actor,"models");
  ensure(Object.keys(p).every(key=>["name","taskId","definition","reason"].includes(key)),"INVALID_RAIL_SAFETY_PAYLOAD","管控命令只允许修改名称、关联任务和定义");
  const name=str(p.name,"管控对象名称",200);if(p.reason!==undefined)str(p.reason,"修改原因",4000);
  const taskId=p.taskId===undefined?undefined:taskAccess(c,p.taskId).id;
  if(actor.taskIds!==undefined&&!taskId)throw new ManagementError(403,"TASK_SCOPE_REQUIRED","受限账号须将管控对象关联到已授权任务");
  let definition:RailSafetyDefinition;
  try{definition=validateRailSafetyDefinition(p.definition);}catch(error){if(error instanceof RailSafetyValidationError)throw new ManagementError(400,error.code,error.message,{field:error.field});throw error;}
  const resourceIds=definition.kind==="machine"?[definition.resourceId]:definition.kind==="guard"?definition.resourceIds:[];
  for(const key of resourceIds){const resource=c.get("resources",key);ensure(resource.kind==="equipment","RAIL_SAFETY_RESOURCE_KIND","只能关联机械设备资源");}
  if(definition.kind==="machine"){
   for(const key of definition.selectedLimitIds){const limit=c.get("railSafety",key);ensure(limit.status==="active"&&(limit.definition as RailSafetyDefinition)?.kind==="limit","RAIL_SAFETY_LIMIT_INVALID","所选限界不存在或已停用");ensure(!limit.taskId||limit.taskId===taskId,"RAIL_SAFETY_TASK_MISMATCH","所选限界属于不同任务");}
   ensure(!c.list("railSafety").some(v=>v.id!==m.id&&v.status==="active"&&(v.definition as RailSafetyDefinition)?.kind==="machine"&&(v.definition as {resourceId?:string}).resourceId===definition.resourceId),"RAIL_SAFETY_MACHINE_EXISTS","该机械已有管控配置，请编辑现有配置");
  }
  const old=m.id?c.list("railSafety").find(v=>v.id===m.id):undefined;
  if(old){load("railSafety");requiredState(r!,["active"]);ensure((r!.definition as RailSafetyDefinition)?.kind===definition.kind,"RAIL_SAFETY_KIND_IMMUTABLE","不能改变已有管控对象类别");if(definition.kind==="machine")ensure((r!.definition as {resourceId:string}).resourceId===definition.resourceId,"RAIL_SAFETY_RESOURCE_IMMUTABLE","不能更换已有配置的机械编号");if(definition.kind==="limit")for(const other of c.list("railSafety")){const d=other.definition as RailSafetyDefinition;if(other.status==="active"&&d?.kind==="machine"&&d.selectedLimitIds.includes(r!.id))ensure(!taskId||other.taskId===taskId,"RAIL_SAFETY_TASK_MISMATCH","此限界已被其他任务或全局机械引用，请先解除引用");}Object.assign(r!,{name,definition});if(taskId)r!.taskId=taskId;else delete r!.taskId;
  }else create("railSafety",{name,...(taskId?{taskId}:{}),definition},"active");
  break;
 }
 case "railSafety.remove":{
  allow(actor,"models");ensure(Object.keys(p).every(key=>key==="reason"),"INVALID_RAIL_SAFETY_PAYLOAD","移除操作只允许填写原因");if(p.reason!==undefined)str(p.reason,"移除原因",4000);
  load("railSafety");requiredState(r!,["active"]);r!.status="deleted";r!.deletedAt=now;r!.deletedBy=actor.id;break;
 }
 case "wbs.create":case "wbs.update":{
  const f=pick(p,["name","parentId","areaIds","description"]);str(f.name,"工作包名称",200);if(f.parentId)c.get("wbs",id(f.parentId));validateLinks(c,f);
  if(m.type.endsWith("create"))create("wbs",f,"active");else Object.assign(load("wbs"),f);
  let parent=r!.parentId;const chain=new Set([r!.id]);while(parent){const key=id(parent);ensure(!chain.has(key),"WBS_CYCLE","工作包不能移入自身后代");chain.add(key);parent=c.get("wbs",key).parentId;}break;}
 case "task.create":create("tasks",{...pick(p,mutableTaskFields),name:str(p.name,"任务名称",200),areaIds:ids(p.areaIds),predecessorIds:ids(p.predecessorIds),planVersion:1});taskFields(r!);dependencyCheck(r!);break;
 case "task.update":{load("tasks");requiredState(r!,["draft","published","in-progress","pending-completion"]);if(r!.status!=="draft")reason();Object.assign(r!,pick(p,mutableTaskFields));r!.areaIds=ids(r!.areaIds);r!.predecessorIds=ids(r!.predecessorIds);r!.planVersion=Number(r!.planVersion)+1;taskFields(r!);dependencyCheck(r!);break;}
 case "task.publish":load("tasks");requiredState(r!,["draft"]);str(r!.ownerId,"负责人");date(r!.planStart);date(r!.planEnd);taskFields(r!);r!.status="published";break;
 case "task.conditions.configure":load("tasks");requiredState(r!,["draft","published","in-progress","pending-completion"]);r!.conditionPolicy=configureTaskConditions(c,r!,p);break;
 case "task.start":load("tasks");requiredState(r!,["published"]);enforceTaskConditions(c,r!,"start");r!.status="in-progress";break;
 case "task.request-completion":load("tasks");requiredState(r!,["in-progress","published"]);r!.status="pending-completion";break;
 case "task.confirm-completion":load("tasks");requiredState(r!,["pending-completion"]);enforceTaskConditions(c,r!,"completion");r!.status="completed";r!.completionConfirmedAt=now;r!.completionConfirmedBy=actor.id;break;
 case "task.cancel":load("tasks");ensure(r!.status!=="completed","INVALID_STATE","已完成任务不能取消");r!.status="cancelled";r!.cancelReason=reason();break;
 case "task.forecast":load("tasks");r!.forecastEnd=date(p.forecastEnd,"预测完成日");r!.forecastReason=reason();break;
 case "baseline.create":{
  const taskIds=ids(p.taskIds);ensure(taskIds.length,"NO_TASKS","请选择基线任务");const items=taskIds.map(t=>{const a=taskAccess(c,t);ensure(a.status!=="draft"&&a.status!=="cancelled","UNPUBLISHED_TASK","基线只能包含已发布任务");return {taskId:a.id,taskRevision:a.revision,...pick(a,["name","planStart","planEnd","targetQuantity","unit","weight","milestone"])};});
  create("baselines",{name:str(p.name,"基线名称",200),items,taskIds,reason:p.reason?reason():"首次基线"});break;}
 case "baseline.approve":load("baselines");requiredState(r!,["draft"]);r!.status="approved";r!.approvedAt=now;r!.approvedBy=actor.id;break;
 case "commitment.create":{const t=taskAccess(c,p.taskId);const start=date(p.weekStart,"周开始"),deadline=date(p.originalDueDate||p.dueDate,"原期限");ensure(start<=deadline,"DATE_CONFLICT","周目标期限不能早于周开始");ensure(["incremental","cumulative"].includes(String(p.basis)),"INVALID_BASIS","明确本周新增或截至日累计口径");const unit=str(p.unit,"单位",30);ensure(!t.unit||unit===t.unit,"UNIT_MISMATCH","周目标单位与任务不一致");create("commitments",{taskId:t.id,name:String(p.name||t.name),weekStart:start,originalDueDate:deadline,dueDate:deadline,targetQuantity:num(p.targetQuantity,"本周目标",0.0000001),unit,basis:p.basis,criterion:str(p.criterion,"兑现判据"),changes:[]});break;}
 case "commitment.publish":load("commitments");requiredState(r!,["draft"]);r!.status="published";r!.publishedAt=now;r!.publishedBy=actor.id;break;
 case "commitment.change":load("commitments");requiredState(r!,["published","rescheduled","cancelled"]);ensure(["reschedule","cancel"].includes(String(p.action)),"INVALID_ACTION","请选择改期或取消");(r!.changes as unknown[]).push({at:now,by:actor.id,action:p.action,reason:reason(),dueDate:p.action==="reschedule"?date(p.dueDate):undefined});if(p.action==="reschedule")r!.dueDate=date(p.dueDate);r!.status=p.action==="cancel"?"cancelled":"rescheduled";break;
 case "progress.create":case "progress.revise":{
  const t=taskAccess(c,m.type==="progress.create"?p.taskId:c.get("progress",id(m.id)).taskId);ensure(t.status!=="draft"&&t.status!=="cancelled","TASK_NOT_EXECUTABLE","任务尚未发布或已取消");
  const unit=str(p.unit,"单位",30);ensure(!t.unit||t.unit===unit,"UNIT_MISMATCH","实绩单位必须与任务计量单位一致");
  const v:ProgressRevision={revision:1,quantity:num(p.quantity,"本次量"),unit,businessDate:date(p.businessDate,"业务日期"),shift:str(p.shift,"班次",60),crew:str(p.crew,"班组",100),measurementKey:str(p.measurementKey,"计量对象或批次",120),explanation:String(p.explanation||""),evidenceIds:evidence(p.evidenceIds),status:"draft",createdAt:now};
  if(m.type==="progress.create"){
   const duplicate=c.list("progress").find(e=>e.taskId===t.id&&(e.revisions as ProgressRevision[]).some(a=>a.businessDate===v.businessDate&&a.shift===v.shift&&a.crew===v.crew&&a.measurementKey===v.measurementKey));
   if(duplicate)throw new ManagementError(409,"DUPLICATE_PROGRESS","同期同班组同计量对象已有实绩，请修订原记录",{entryId:duplicate.id},duplicate);
   create("progress",{taskId:t.id,name:String(p.name||`${t.name} ${v.businessDate}`),entryId:"",revisions:[v],confirmations:[]});r!.entryId=r!.id;
  }else{load("progress");reason();const revisions=r!.revisions as ProgressRevision[];ensure(revisions.at(-1)!.status!=="submitted","PENDING_REVISION","待确认修订应先确认或退回");v.revision=revisions.at(-1)!.revision+1;revisions.push(v);r!.status="draft";r!.revisionReason=p.reason;}break;}
 case "progress.submit":case "progress.return":case "progress.confirm":case "progress.revoke":{
  load("progress");const entry=r! as ProgressEntry,v=entry.revisions.at(-1)!;
  if(m.type==="progress.submit"){ensure(["draft","returned"].includes(v.status),"INVALID_STATE","仅草稿或退回实绩可提交");v.evidenceIds.forEach(c.evidence);v.status="submitted";v.submittedAt=now;r!.status="submitted";}
  if(m.type==="progress.return"){ensure(v.status==="submitted","INVALID_STATE","仅已提交实绩可退回");v.status="returned";v.returnReason=reason();r!.status="returned";}
  if(m.type==="progress.confirm"){ensure(v.status==="submitted","INVALID_STATE","仅已提交实绩可确认");const task=taskAccess(c,entry.taskId);let total=v.quantity;for(const other of c.list("progress") as ProgressEntry[]){if(other.id===entry.id||other.taskId!==entry.taskId)continue;const active=other.confirmations.at(-1);if(active&&!active.revokedAt){const value=other.revisions.find(a=>a.revision===active.entryRevision)!;total+=value.quantity;}}ensure(typeof task.targetQuantity!=="number"||total<=task.targetQuantity,"TARGET_EXCEEDED","确认量将超过批准目标，请先核查或办理目标调整",{target:task.targetQuantity,proposedTotal:total});v.status="confirmed";v.confirmedAt=now;v.confirmedBy=actor.id;entry.confirmations.push({entryRevision:v.revision,confirmedAt:now,confirmedBy:actor.id});r!.status="confirmed";}
  if(m.type==="progress.revoke"){const active=entry.confirmations.at(-1);ensure(active&&!active.revokedAt,"NOT_CONFIRMED","没有可撤销的确认");active.revokedAt=now;active.revokedBy=actor.id;active.reason=reason();r!.status="revoked";}break;}
 case "dailyLog.create":{const t=taskAccess(c,p.taskId),refs=ids(p.progressEntryIds);refs.forEach(e=>ensure(c.get("progress",e).taskId===t.id,"REFERENCE_MISMATCH","日报只能引用本任务实绩"));ensure(refs.length||typeof p.description==="string"&&p.description.trim(),"EMPTY_LOG","请填写执行说明或引用实绩");create("dailyLogs",{name:String(p.name||t.name),taskId:t.id,businessDate:date(p.businessDate),progressEntryIds:refs,description:String(p.description||""),evidenceIds:evidence(p.evidenceIds)},"submitted");break;}
 case "check.create":case "check.copy":{
  const source=m.type==="check.copy"?c.get("checks",id(p.sourceId)):undefined;const input=source?source.items:p.items;ensure(Array.isArray(input)&&input.length>0,"NO_CHECK_ITEMS","请提供检查项目");
  const items=newCheckItems(input);
  const purpose=p.purpose||source?.purpose||"preconstruction";ensure(["preconstruction","quality","safety","acceptance"].includes(String(purpose)),"CHECK_PURPOSE","检查专业或用途无效");
  create("checks",{purpose,name:str(p.name||source?.name,"检查名称",200),taskId:p.taskId||source?.taskId,businessDate:date(p.businessDate),shift:String(p.shift||"日班"),inspectionObjectId:String(p.inspectionObjectId||source?.inspectionObjectId||p.taskId||""),items,sourceId:source?.id,templateVersion:p.templateVersion??source?.templateVersion??1});ensure(Number.isSafeInteger(r!.templateVersion)&&Number(r!.templateVersion)>0,"CHECK_TEMPLATE_VERSION_INVALID","清单模板版本须为正整数");r!.checklistVersion=checklistVersion(r!);break;}
 case "check.record":load("checks");requiredState(r!,["draft"]);r!.items=recordCheckItems(r!,p,evidence);r!.checklistVersion=checklistVersion(r!);break;
 case "check.confirm":load("checks");requiredState(r!,["draft"]);confirmCheckIntegrity(r!,p);for(const item of r!.items as ManagementCheckItem[])(item.evidenceIds||[]).forEach(c.evidence);r!.checklistVersion=checklistVersion(r!);r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;r!.satisfied=(r!.items as ManagementCheckItem[]).every(a=>!a.required||a.result==="pass"||a.result==="not-applicable");break;
 case "issue.create":{
  ensure(["quality","safety","coordination"].includes(String(p.kind)),"INVALID_KIND","问题类型无效");ensure(p.blocksCompletion===undefined||typeof p.blocksCompletion==="boolean","INVALID_BLOCKING_RULE","完工阻断标识须为布尔值");if(p.checkId)c.get("checks",id(p.checkId));
  const issueEvidence=evidence(p.evidenceIds);
  const annotations=p.comparisonAnnotations;ensure(annotations===undefined||Array.isArray(annotations)&&annotations.length<=20,"INVALID_PHOTO_ANNOTATIONS","照片标注须为有限的点列表");
  const comparisonAnnotations=(Array.isArray(annotations)?annotations:[]).map((value:unknown)=>{ensure(value&&typeof value==="object"&&!Array.isArray(value),"INVALID_PHOTO_ANNOTATIONS","照片标注格式无效");const a=value as Record<string,unknown>;ensure(typeof a.evidenceId==="string"&&issueEvidence.includes(a.evidenceId),"INVALID_PHOTO_ANNOTATIONS","标注必须引用本问题已授权的证据");const image=c.get("evidence",a.evidenceId);ensure(String(image.mime).startsWith("image/"),"INVALID_PHOTO_ANNOTATIONS","标注只能关联原始照片");ensure(typeof a.x==="number"&&Number.isFinite(a.x)&&a.x>=0&&a.x<=1&&typeof a.y==="number"&&Number.isFinite(a.y)&&a.y>=0&&a.y<=1,"INVALID_PHOTO_ANNOTATIONS","标注必须位于原始照片范围内");return{evidenceId:a.evidenceId,x:a.x,y:a.y,coordinateSystem:"normalized-original-image",imageSha256:image.sha256};});
  create("issues",{...pick(p,["taskId","taskIds","kind","checkId","riskPointId","positionSnapshot","blocksCompletion","discovery"]),name:str(p.name,"问题描述",1000),evidenceIds:issueEvidence,...(comparisonAnnotations.length?{comparisonAnnotations}:{}),rounds:[],originalDueDate:null},"pending-verification");break;}
 case "issue.assign":load("issues");requiredState(r!,["pending-verification","pending-rectification","rectifying"]);c.member(id(p.ownerId),[...(r!.taskId?[r!.taskId]:[]),...ids(r!.taskIds)],"field");r!.ownerId=id(p.ownerId);r!.dueDate=date(p.dueDate);r!.originalDueDate??=r!.dueDate;r!.verifiedAt??=now;r!.status="pending-rectification";break;
 case "issue.start":load("issues");if(r!.ownerId!==actor.id&&!actor.permissions.includes("review")&&!actor.permissions.includes("confirm"))throw new ManagementError(403,"ISSUE_EXECUTOR_REQUIRED","仅指派执行人或有权管理人员可办理整改");requiredState(r!,["pending-rectification"]);r!.status="rectifying";break;
 case "issue.submit":load("issues");if(r!.ownerId!==actor.id&&!actor.permissions.includes("review")&&!actor.permissions.includes("confirm"))throw new ManagementError(403,"ISSUE_EXECUTOR_REQUIRED","仅指派执行人或有权管理人员可提交整改");requiredState(r!,["pending-rectification","rectifying"]);(r!.rounds as unknown[]).push({round:(r!.rounds as unknown[]).length+1,description:str(p.description,"整改说明"),evidenceIds:evidence(p.evidenceIds),submittedAt:now,submittedBy:actor.id});r!.status="pending-review";break;
 case "issue.review":load("issues");requiredState(r!,["pending-review"]);ensure(typeof p.passed==="boolean","INVALID_RESULT","请选择通过或退回");Object.assign((r!.rounds as Record<string,unknown>[]).at(-1)!,{passed:p.passed,reviewComment:reason(),reviewedAt:now,reviewedBy:actor.id,reviewEvidenceIds:evidence(p.evidenceIds)});r!.status=p.passed?"closed":"rectifying";if(p.passed)r!.closedAt=now;break;
 case "issue.dismiss":load("issues");requiredState(r!,["pending-verification"]);ensure(["false-positive","duplicate"].includes(String(p.disposition)),"INVALID_DISPOSITION","请明确误报或重复");r!.status=String(p.disposition);r!.dispositionReason=reason();if(p.disposition==="duplicate"){const other=c.get("issues",id(p.duplicateOf));ensure(other.id!==r!.id,"INVALID_REFERENCE","不能与自身重复");r!.duplicateOf=other.id;}break;
 case "issue.reschedule":load("issues");ensure(!["closed","false-positive","duplicate"].includes(r!.status),"INVALID_STATE","已归档问题不能改期");r!.dueDate=date(p.dueDate);r!.rescheduleReason=reason();break;
 case "inspection.create":create("inspections",{name:str(p.name,"巡检名称",200),taskId:p.taskId,taskIds:ids(p.taskIds),areaIds:ids(p.areaIds),ownerId:id(p.ownerId),dueDate:date(p.dueDate),scheduledDate:date(p.scheduledDate||p.dueDate),planId:String(p.planId||""),evidenceIds:[],result:""},"planned");break;
 case "inspection.record":load("inspections");requiredState(r!,["planned","recorded"]);r!.result=str(p.result,"巡检结果");r!.evidenceIds=evidence(p.evidenceIds);r!.status="recorded";break;
 case "inspection.confirm":load("inspections");requiredState(r!,["recorded"]);str(r!.result,"结果");ensure((r!.evidenceIds||[]).length>0,"EVIDENCE_REQUIRED","有效巡检记录需要已保存证据");r!.evidenceIds!.forEach(c.evidence);r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;break;
 case "resource.create":case "resource.update":{
  const fields=pick(p,["name","kind","specification","unit","quantity","ownerId","locationDescription","qualificationEvidenceIds","validUntil","availability"]);
  str(fields.name,"资源名称",200);ensure(["crew","equipment","material","auxiliary","test"].includes(String(fields.kind)),"INVALID_KIND","资源类别无效");if(fields.quantity!==undefined)num(fields.quantity,"资源数量");if(fields.validUntil)date(fields.validUntil);fields.qualificationEvidenceIds=evidence(fields.qualificationEvidenceIds);
  if(m.type==="resource.create")create("resources",fields,"active");else{reason();load("resources");ensure(!r!.machinery||fields.kind==="equipment","MACHINERY_RESOURCE_KIND","请先解除三维机械模型，再变更设备资源类别");ensure(fields.kind==="equipment"||!c.list("railSafety").some(v=>{const d=v.definition as RailSafetyDefinition;return v.status==="active"&&(d?.kind==="machine"&&d.resourceId===r!.id||d?.kind==="guard"&&d.resourceIds.includes(r!.id));}),"RAIL_SAFETY_RESOURCE_KIND","请先解除机械管控和防护关联，再变更设备类别");Object.assign(r!,fields);recheckNeeds(n=>n.resourceId===r!.id,"资源状态或资格发生变化，请重新核对");}break;}
 case "machinery.save":case "machinery.remove":{
  allow(actor,"models");load("resources");
  ensure(r!.kind==="equipment","MACHINERY_RESOURCE_KIND","三维机械模型只能关联已有设备资源");
  ensure(Object.keys(p).every(key=>["reason",...(m.type==="machinery.save"?["machinery"]:[])].includes(key)),"INVALID_MACHINERY_PAYLOAD","机械命令只能修改模型数据，不能修改资源业务状态");
  if(p.reason!==undefined)reason();
  if(m.type==="machinery.save"){
   try{r!.machinery=validateMachineryMetadata(p.machinery);}catch(error){if(error instanceof MachineryValidationError)throw new ManagementError(400,error.code,error.message,{field:error.field});throw error;}
  }else{ensure(r!.machinery,"MACHINERY_NOT_ATTACHED","该设备尚未关联三维机械模型");delete r!.machinery;}
  // Preserve qualification, availability, allocations and admission decisions: display geometry
  // neither confirms equipment readiness nor invalidates an existing business confirmation.
  break;}
 case "need.create":case "need.update":{
  const fields=pick(p,["name","taskId","kind","resourceId","quantity","unit","required","ownerId","coordinationNote"]);str(fields.name,"需求名称",200);ensure(["crew","equipment","material","auxiliary","test"].includes(String(fields.kind)),"INVALID_KIND","资源需求类别无效");taskAccess(c,fields.taskId);fields.dueDate=date(p.dueDate);if(fields.quantity!==undefined){num(fields.quantity,"需用量",0.0000001);str(fields.unit,"单位",30);}if(fields.resourceId)c.get("resources",id(fields.resourceId));
  if(m.type==="need.create")create("resourceNeeds",{...fields,required:p.required!==false},"unconfirmed");else{Object.assign(load("resourceNeeds"),fields);r!.status="unconfirmed";r!.changeReason=reason();}break;}
 case "need.confirm":{
  load("resourceNeeds");r!.basis=str(p.basis,"到位与有效性确认依据");r!.evidenceIds=evidence(p.evidenceIds);
  if(["material","auxiliary"].includes(String(r!.kind))){const batch=c.get("batches",id(p.batchId));ensure(batch.status==="accepted","BATCH_NOT_ACCEPTED","材料已到货不等于验收可用");ensure(batch.unit===r!.unit,"UNIT_MISMATCH","批次与需求单位不一致");ensure(!r!.resourceId||r!.resourceId===batch.resourceId,"MATERIAL_MISMATCH","批次不属于本需求指定物料");
   const test=c.list("tests").filter(t=>t.batchId===batch.id&&t.status==="confirmed"&&t.result==="pass"&&(!t.validUntil||String(t.validUntil)>=String(r!.dueDate))).at(-1);ensure(test&&batch.qualifiedTestId===test.id,"TEST_NOT_VALID","尚无适用且有效的合格检验");
   ensure(Number(batch.availableQuantity)>=Number(r!.quantity||0),"QUANTITY_SHORTAGE","检验可用数量不足");r!.batchId=batch.id;r!.testId=test.id;r!.availableQuantity=batch.availableQuantity;
  }else{const resource=c.get("resources",id(p.resourceId||r!.resourceId));ensure(resource.kind===r!.kind,"RESOURCE_KIND_MISMATCH","资源类别与需求不一致");ensure(resource.status==="active"&&resource.availability!=="disabled","RESOURCE_UNAVAILABLE","资源停用或未确认可用");ensure(!resource.validUntil||String(resource.validUntil)>=String(r!.dueDate),"QUALIFICATION_EXPIRED","资格或检查有效期不覆盖需用日");r!.resourceId=resource.id;}
  r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;break;}
 case "allocation.create":{
  const resource=c.get("resources",id(p.resourceId)),task=taskAccess(c,p.taskId);ensure(["crew","equipment","auxiliary"].includes(String(resource.kind)),"RESOURCE_KIND","此资源不支持占用安排");ensure(resource.status==="active"&&resource.availability!=="disabled","RESOURCE_UNAVAILABLE","资源不可用");
  const startsAt=instant(p.startsAt,"占用开始"),endsAt=instant(p.endsAt,"占用结束");ensure(startsAt<endsAt,"DATE_CONFLICT","结束时间须晚于开始");
  const conflicts=c.list("allocations").filter(a=>a.status!=="cancelled"&&a.resourceId===resource.id&&String(a.startsAt)<endsAt&&String(a.endsAt)>startsAt);if(conflicts.length)throw new ManagementError(409,"RESOURCE_CONFLICT","同一资源在该时段已有任务占用",conflicts.map(v=>({id:v.id,taskId:v.taskId,startsAt:v.startsAt,endsAt:v.endsAt})));
  create("allocations",{name:String(p.name||`${resource.name} · ${task.name}`),resourceId:resource.id,taskId:task.id,startsAt,endsAt,ownerId:p.ownerId||task.ownerId},"scheduled");break;}
 case "allocation.cancel":load("allocations");requiredState(r!,["scheduled"]);r!.status="cancelled";r!.reason=reason();break;
 case "usage.create":{
  const resource=c.get("resources",id(p.resourceId)),task=taskAccess(c,p.taskId);
  ensure(["crew","equipment"].includes(String(resource.kind)),"RESOURCE_USAGE_KIND","实际到场或投入只适用于人员和设备，材料须使用收发与检验台账");
  const startAt=instant(p.startAt,"实际开始"),endAt=instant(p.endAt,"实际结束");ensure(startAt<endAt,"DATE_CONFLICT","实际结束须晚于开始");ensure(endAt<=now,"ACTUAL_TIME_FUTURE","实际投入不能登记尚未发生的时间");
  const allocation=p.allocationId?c.get("allocations",id(p.allocationId)):undefined;
  ensure(!allocation||allocation.taskId===task.id&&allocation.resourceId===resource.id,"ALLOCATION_MISMATCH","关联计划必须属于同一任务和同一资源");
  create("resourceUsage",{name:p.name?str(p.name,"记录名称",200):`${resource.name} · ${resource.kind==="crew"?"实际到场":"实际投入"}`,taskId:task.id,resourceId:resource.id,kind:resource.kind,quantity:num(p.quantity,"实际数量",0.0000001),unit:str(p.unit,"实际单位",30),businessDate:date(p.businessDate),startAt,endAt,description:str(p.description,"实际到场或投入说明"),evidenceIds:evidence(p.evidenceIds),allocationId:allocation?.id,resourceRevision:resource.revision,allocationRevision:allocation?.revision,recordedAt:now,recordedBy:actor.id},"recorded");break;}
 case "usage.confirm":{
  load("resourceUsage");requiredState(r!,["recorded"]);
  const resource=c.get("resources",id(r!.resourceId));ensure(resource.kind===r!.kind&&["crew","equipment"].includes(String(resource.kind)),"RESOURCE_USAGE_KIND","资源类别已变化，请核对原实际投入记录");
  if(r!.allocationId){const allocation=c.get("allocations",id(r!.allocationId));ensure(allocation.taskId===r!.taskId&&allocation.resourceId===resource.id,"ALLOCATION_MISMATCH","关联计划与实际投入不一致");}
  r!.confirmationBasis=str(p.basis,"实际到场或投入确认依据");r!.evidenceIds=evidence([...(r!.evidenceIds||[]),...ids(p.evidenceIds)]);r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;break;}
 case "batch.create":create("batches",{name:str(p.name,"批次名称",200),resourceId:p.resourceId?c.get("resources",id(p.resourceId)).id:undefined,batchNumber:str(p.batchNumber,"批号",120),unit:str(p.unit,"单位",30),receivedQuantity:0,availableQuantity:0,locationDescription:String(p.locationDescription||"")},"awaiting-delivery");break;
 case "batch.receive":{
  load("batches");const quantity=num(p.quantity,"到货量",0.0000001);r!.receivedQuantity=Number(r!.receivedQuantity)+quantity;r!.availableQuantity=0;r!.qualifiedTestId=undefined;r!.status="awaiting-acceptance";recheckNeeds(n=>n.batchId===r!.id,"批次新增到货，原检验适用性需重新确认");
  const tx:ManagementRecord={id:randomUUID(),projectId:c.projectId,revision:1,name:`${r!.name} 到货`,status:"recorded",createdAt:now,updatedAt:now,createdBy:actor.id,batchId:r!.id,kind:"receipt",quantity,unit:r!.unit,businessDate:date(p.businessDate),evidenceIds:evidence(p.evidenceIds)};c.save("materialTransactions",tx);break;}
 case "batch.accept":load("batches");requiredState(r!,["awaiting-acceptance","rejected"]);ensure(typeof p.passed==="boolean","INVALID_RESULT","请记录验收结论");r!.status=p.passed?"accepted":"rejected";r!.acceptanceBasis=str(p.basis,"验收依据");r!.evidenceIds=evidence(p.evidenceIds);r!.acceptedAt=now;r!.acceptedBy=actor.id;if(p.passed&&r!.qualifiedTestId){const test=c.get("tests",id(r!.qualifiedTestId));if(test.status==="confirmed"&&test.result==="pass")r!.availableQuantity=Math.max(0,Number(r!.receivedQuantity)-c.list("materialTransactions").filter(t=>t.batchId===r!.id&&["issue","return","correction"].includes(String(t.kind))).reduce((n,t)=>n+(t.kind==="return"?-1:1)*Number(t.quantity),0));}if(!p.passed){r!.availableQuantity=0;r!.qualifiedTestId=undefined;recheckNeeds(n=>n.batchId===r!.id,"批次验收不通过");}break;
 case "test.create":{
  const batch=p.batchId?c.get("batches",id(p.batchId)):undefined;ensure(batch||p.taskId,"TEST_SCOPE_REQUIRED","检验必须关联批次或任务");ensure(["pending","pass","fail"].includes(String(p.result||"pending")),"INVALID_RESULT","检验结果无效");
  create("tests",{name:str(p.name,"检验名称",200),batchId:batch?.id,taskId:p.taskId,result:p.result||"pending",businessDate:date(p.businessDate),validUntil:p.validUntil?date(p.validUntil):undefined,evidenceIds:evidence(p.evidenceIds)});break;}
 case "test.confirm":{
  load("tests");requiredState(r!,["draft"]);ensure(["pass","fail"].includes(String(p.result||r!.result)),"RESULT_PENDING","未明确检验结果");r!.result=p.result||r!.result;r!.evidenceIds=evidence(p.evidenceIds||r!.evidenceIds);ensure(r!.evidenceIds!.length,"EVIDENCE_REQUIRED","检验确认须有已上传的依据报告");r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;
  if(r!.batchId){const batch=structuredClone(c.get("batches",String(r!.batchId)));batch.revision++;batch.updatedAt=now;batch.qualifiedTestId=r!.result==="pass"?r!.id:undefined;batch.availableQuantity=r!.result==="pass"&&batch.status==="accepted"?Math.max(0,Number(batch.receivedQuantity)-c.list("materialTransactions").filter(t=>t.batchId===batch.id&&["issue","return","correction"].includes(String(t.kind))).reduce((n,t)=>n+(t.kind==="return"?-1:1)*Number(t.quantity),0)):0;c.save("batches",batch);recheckNeeds(n=>n.batchId===batch.id,"检验结论或版本已更新，请重新核对");}break;}
 case "material.issue":case "material.return":case "material.correct":{
  const batch=structuredClone(c.get("batches",id(p.batchId)));taskAccess(c,p.taskId);const kind=m.type.split(".")[1],quantity=num(p.quantity,"数量",kind==="correct"?-Number.MAX_SAFE_INTEGER:0.0000001);
  if(kind==="issue"){const approved=batch.qualifiedTestId?c.get("tests",String(batch.qualifiedTestId)):undefined;ensure(batch.status==="accepted"&&Number(batch.availableQuantity)>=quantity&&approved?.status==="confirmed"&&approved.result==="pass"&&(!approved.validUntil||String(approved.validUntil)>=date(p.businessDate)),"BATCH_UNAVAILABLE","有效可用数量不足、未检验或报告已过期");}
  if(kind==="return"){const used=c.list("materialTransactions").filter(t=>t.batchId===batch.id&&t.taskId===p.taskId).reduce((n,t)=>n+(t.kind==="issue"?Number(t.quantity):t.kind==="return"?-Number(t.quantity):0),0);ensure(quantity<=used,"RETURN_EXCEEDS_ISSUE","退回数量超过该任务领用量");}
  if(kind==="correct")reason();const available=Number(batch.availableQuantity)+(kind==="return"?quantity:-quantity);ensure(available>=0&&available<=Number(batch.receivedQuantity),"INVALID_BALANCE","调整后可用量超出批次到货余额");
  create("materialTransactions",{name:String(p.name||`${batch.name} ${kind}`),batchId:batch.id,taskId:p.taskId,kind:kind==="correct"?"correction":kind,quantity,unit:batch.unit,businessDate:date(p.businessDate),reason:String(p.reason||""),evidenceIds:evidence(p.evidenceIds)},"recorded");batch.revision++;batch.updatedAt=now;batch.availableQuantity=available;c.save("batches",batch);break;}
 case "document.create":create("documents",{name:str(p.name,"资料名称",200),category:str(p.category,"资料分类",100),code:String(p.code||""),taskIds:ids(p.taskIds)},"active");break;
 case "document.version":{
  const doc=c.get("documents",id(p.documentId));c.evidence(id(p.evidenceId));const version=c.list("documentVersions").filter(v=>v.documentId===doc.id).length+1;
  create("documentVersions",{name:doc.name,documentId:doc.id,evidenceId:p.evidenceId,version,revisionNote:str(p.revisionNote,"修订说明"),taskIds:ids(p.taskIds||doc.taskIds)});break;}
 case "document.submit":load("documentVersions");requiredState(r!,["draft","returned"]);c.member(id(p.reviewerId));r!.reviewerId=p.reviewerId;r!.dueDate=date(p.dueDate);r!.status="under-review";break;
 case "document.return":load("documentVersions");requiredState(r!,["under-review"]);r!.status="returned";r!.reviewComment=reason();break;
 case "document.publish":{
  load("documentVersions");requiredState(r!,["draft","under-review"]);c.evidence(id(r!.evidenceId));
  for(const old of c.list("documentVersions").filter(v=>v.documentId===r!.documentId&&v.status==="published")){old.revision++;old.updatedAt=now;old.status="superseded";old.supersededAt=now;c.save("documentVersions",old);recheckDocumentRequirements(old.id);}
  r!.status="published";r!.publishedAt=now;r!.publishedBy=actor.id;r!.publicationBasis=str(p.basis||p.reason,"发布依据");const doc=structuredClone(c.get("documents",id(r!.documentId)));doc.revision++;doc.updatedAt=now;doc.effectiveVersionId=r!.id;c.save("documents",doc);break;}
 case "document.void":load("documentVersions");ensure(r!.status!=="void","INVALID_STATE","版本已作废");r!.status="void";r!.voidReason=reason();r!.voidAt=now;{const doc=structuredClone(c.get("documents",id(r!.documentId)));if(doc.effectiveVersionId===r!.id){doc.revision++;doc.updatedAt=now;doc.effectiveVersionId=null;c.save("documents",doc);}recheckDocumentRequirements(r!.id);}break;
 case "document.requirement":create("documentRequirements",{name:str(p.name,"资料交付要求",200),taskId:p.taskId,ownerId:p.ownerId,dueDate:date(p.dueDate),category:String(p.category||"资料")},"pending");break;
 case "document.fulfill":load("documentRequirements");{const v=c.get("documentVersions",id(p.versionId));ensure(v.status==="published","DOCUMENT_NOT_EFFECTIVE","上传或待审资料不能满足交付要求");r!.versionId=v.id;r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;}break;
 case "link.create":{
  const anchor=p.anchorId?c.get("anchors",id(p.anchorId)):undefined;const task=p.taskId?taskAccess(c,p.taskId):anchor?.taskId?taskAccess(c,anchor.taskId):undefined;ensure(task||anchor,"LINK_SOURCE_REQUIRED","请关联任务或独立资料锚点");const targetKind=String(p.targetKind) as ManagementCollection;ensure(["documents","documentVersions","evidence","technicalQueries","issues","actions","anchors"].includes(targetKind),"LINK_KIND","关联类型不受支持");const target=c.get(targetKind,id(p.targetId));ensure(!c.list("links").some(a=>a.status==="active"&&a.taskId===task?.id&&a.anchorId===anchor?.id&&a.targetKind===targetKind&&a.targetId===target.id),"DUPLICATE_LINK","该关联已存在");create("links",{name:target.name,taskId:task?.id,anchorId:anchor?.id,targetKind,targetId:target.id,targetRevision:target.revision},"active");break;}
 case "link.remove":load("links");requiredState(r!,["active"]);r!.status="removed";r!.removedAt=now;break;
 case "technical.create":create("technicalQueries",{name:str(p.name,"技术问题",1000),taskId:p.taskId,taskIds:ids(p.taskIds),ownerId:id(p.ownerId),dueDate:date(p.dueDate),documentVersionId:p.documentVersionId?c.get("documentVersions",id(p.documentVersionId)).id:undefined,comments:[],evidenceIds:evidence(p.evidenceIds)},"open");break;
 case "technical.comment":load("technicalQueries");(r!.comments as unknown[]).push({text:str(p.text,"讨论内容"),at:now,by:actor.id,evidenceIds:evidence(p.evidenceIds)});break;
 case "technical.answer":load("technicalQueries");requiredState(r!,["open","answered"]);r!.answer=str(p.answer,"正式答复草稿");r!.answerEvidenceIds=evidence(p.evidenceIds);r!.status="answered";break;
 case "technical.publish":load("technicalQueries");requiredState(r!,["answered"]);r!.status="published";r!.publishedAt=now;r!.publishedBy=actor.id;break;
 case "change.create":create("changes",{name:str(p.name,"变更事项",500),taskIds:ids(p.taskIds),technicalQueryId:p.technicalQueryId?c.get("technicalQueries",id(p.technicalQueryId)).id:undefined,reason:reason(),impacts:String(p.impacts||""),evidenceIds:evidence(p.evidenceIds)},"proposed");break;
 case "change.confirm":load("changes");requiredState(r!,["proposed"]);r!.status="confirmed";r!.confirmedAt=now;r!.confirmedBy=actor.id;r!.confirmationBasis=str(p.basis,"批准变更依据");break;
 case "meeting.create":create("meetings",{name:str(p.name,"会议名称",200),businessDate:date(p.businessDate),minutes:str(p.minutes,"会议结论"),taskIds:ids(p.taskIds),evidenceIds:evidence(p.evidenceIds)},"recorded");break;
 case "action.create":create("actions",{name:str(p.name,"行动内容",1000),ownerId:id(p.ownerId),dueDate:date(p.dueDate),taskId:p.taskId,meetingId:p.meetingId?c.get("meetings",id(p.meetingId)).id:undefined,issueId:p.issueId?c.get("issues",id(p.issueId)).id:undefined},"open");break;
 case "action.complete":load("actions");requiredState(r!,["open"]);r!.result=str(p.result,"落实结果");r!.evidenceIds=evidence(p.evidenceIds);r!.status="completed";r!.completedAt=now;break;
 case "anchor.create":case "anchor.update":{
  const fields=pick(p,["name","purpose","anchor","position","taskId"]);str(fields.name,"锚点名称",200);ensure(["document","quality"].includes(String(fields.purpose)),"ANCHOR_PURPOSE","锚点用途无效");ensure(p.serverValidated===true,"ANCHOR_UNVERIFIED","资料位置未通过模型版本核验");
  if(m.type==="anchor.create")create("anchors",fields,"saved");else Object.assign(load("anchors"),fields);break;}
 case "bookmark.create":case "bookmark.update":{
  const f=pick(p,["name","camera","layers","filters","selection","modelVersion","viewMode"]);str(f.name,"视角名称",200);ensure(f.camera&&typeof f.camera==="object","CAMERA_REQUIRED","缺少实际镜头上下文");const cam=f.camera as Record<string,unknown>;for(const key of ["position","direction","up"]){ensure(Array.isArray(cam[key])&&(cam[key] as unknown[]).length===3&&(cam[key] as unknown[]).every(v=>typeof v==="number"&&Number.isFinite(v)),"CAMERA_INVALID","镜头位置及方向须为有限3维向量");}ensure(Array.isArray(cam.models)&&cam.models.length>0,"MODEL_CONTEXT_REQUIRED","请保存真实模型上下文");for(const model of cam.models as Record<string,unknown>[]){id(model.assetId);str(model.assetVersion,"模型版本",128);str(model.coordinateTransformVersion,"变换版本",128);}if(m.type==="bookmark.create")create("bookmarks",f,"saved");else Object.assign(load("bookmarks"),f);break;}
 case "monitoring.create":create("monitoring",{name:str(p.name,"监测点",200),taskId:p.taskId,unit:str(p.unit,"单位",30),sourceDescription:str(p.sourceDescription,"数据来源",500),validForSeconds:num(p.validForSeconds,"有效秒数",1),samples:[],thresholds:[]},"not-connected");break;
 case "monitoring.record":load("monitoring");{const sampledAt=instant(p.sampledAt,"采样时间");ensure(sampledAt<=now,"FUTURE_SAMPLE","采样时间不能在未来");ensure(["valid","invalid","disconnected"].includes(String(p.quality)),"INVALID_QUALITY","数据质量标识无效");(r!.samples as unknown[]).push({value:num(p.value,"采样值",-Number.MAX_VALUE),sampledAt,receivedAt:now,quality:p.quality,source:str(p.source,"来源标识")});r!.status=p.quality==="disconnected"?"disconnected":"recorded";}break;
 case "monitoring.threshold":load("monitoring");{const low=p.low===undefined?undefined:num(p.low,"下限",-Number.MAX_VALUE),high=p.high===undefined?undefined:num(p.high,"上限",-Number.MAX_VALUE);ensure(low!==undefined||high!==undefined,"THRESHOLD_EMPTY","至少填写一个阈值");ensure(low===undefined||high===undefined||low<high,"THRESHOLD_ORDER","下限必须小于上限");(r!.thresholds as unknown[]).push({version:(r!.thresholds as unknown[]).length+1,low,high,basis:str(p.basis,"确认依据"),evidenceIds:evidence(p.evidenceIds),confirmedAt:now,confirmedBy:actor.id});}break;
 case "report.freeze":create("reports",{name:str(p.name,"报告名称",200),...c.freeze(p)},"frozen");break;
 case "report.publish":load("reports");requiredState(r!,["frozen"]);r!.status="published";r!.publishedAt=now;r!.publishedBy=actor.id;r!.managerComment=String(p.managerComment||"");break;
 default:throw new ManagementError(400,"UNKNOWN_COMMAND","未知业务命令");
 }
 validateLinks(c,r!);c.save(collection!,r!);return {collection:collection!,record:r!};
}
