import type { ManagementCollection, ManagementCommand, ManagementRecord } from "../../src/managementTypes.ts";
import { allow, ManagementError, type Actor } from "./domain.ts";

export type RecordSource = { get:(kind:ManagementCollection,id:string)=>ManagementRecord; list:(kind:ManagementCollection)=>ManagementRecord[] };
const referenceFields:Record<string,ManagementCollection>={documentId:"documents",documentVersionId:"documentVersions",versionId:"documentVersions",effectiveVersionId:"documentVersions",evidenceId:"evidence",fileId:"evidence",checkId:"checks",issueId:"issues",duplicateOf:"issues",technicalQueryId:"technicalQueries",meetingId:"meetings",anchorId:"anchors",allocationId:"allocations",resourceId:"resources",batchId:"batches",qualifiedTestId:"tests",wbsId:"wbs"};
const arrayFields:Record<string,ManagementCollection>={evidenceIds:"evidence",qualificationEvidenceIds:"evidence",answerEvidenceIds:"evidence",reviewEvidenceIds:"evidence",progressEntryIds:"progress",predecessorIds:"tasks"};
/** References are enumerated centrally for reads, writes, files and cascades. */
export function recordReferences(record:Record<string,unknown>,kind?:ManagementCollection):{kind:ManagementCollection;id:string}[]{
 const result:{kind:ManagementCollection;id:string}[]=[];
 for(const [key,collection] of Object.entries(referenceFields))if(typeof record[key]==="string"&&record[key])result.push({kind:collection,id:record[key] as string});
 for(const [key,collection] of Object.entries(arrayFields))if(Array.isArray(record[key]))for(const value of record[key] as unknown[])if(typeof value==="string")result.push({kind:collection,id:value});
 if(typeof record.targetKind==="string"&&typeof record.targetId==="string")result.push({kind:record.targetKind as ManagementCollection,id:record.targetId});
 if(kind==="checks"&&typeof record.sourceId==="string")result.push({kind:"checks",id:record.sourceId});
 const policy=record.conditionPolicy as {rules?:Record<string,unknown>[]} | undefined;
 const conditionCollections:Record<string,ManagementCollection>={predecessors:"tasks","preconstruction-checks":"checks",resources:"resourceNeeds",documents:"documentRequirements",acceptance:"checks","blocking-issues":"issues"};
 for(const rule of policy?.rules||[]){const collection=conditionCollections[String(rule.kind)];if(collection&&Array.isArray(rule.referenceIds))for(const key of rule.referenceIds as unknown[])if(typeof key==="string")result.push({kind:collection,id:key});result.push(...recordReferences(rule));}
 if(Array.isArray(record.conditionDecisions))for(const decision of record.conditionDecisions as Record<string,unknown>[]){if(Array.isArray(decision.results))for(const condition of decision.results as Record<string,unknown>[])if(Array.isArray(condition.references))for(const ref of condition.references as {collection:ManagementCollection;id:string}[])result.push({kind:ref.collection,id:ref.id});if(decision.exception&&typeof decision.exception==="object")result.push(...recordReferences(decision.exception as Record<string,unknown>));}

 for(const key of ["items","revisions","rounds","comments","thresholds"])if(Array.isArray(record[key]))for(const value of record[key] as unknown[])if(value&&typeof value==="object")result.push(...recordReferences(value as Record<string,unknown>));
 return result;
}
function directTasks(record:ManagementRecord,kind:ManagementCollection){return [...new Set([...(kind==="tasks"?[record.id]:[]),...(typeof record.taskId==="string"?[record.taskId]:[]),...(Array.isArray(record.taskIds)?record.taskIds:[])])];}
/** Undefined taskIds means project-wide. [] means no task access. No inferred wildcard. */
export function canAccessRecord(actor:Actor,kind:ManagementCollection,record:ManagementRecord,source:RecordSource,write=false):boolean{
 if(actor.taskIds===undefined)return true;
 const allowed=new Set(actor.taskIds),visited=new Set<string>();
 const scope=(collection:ManagementCollection,value:ManagementRecord):Set<string>=>{
  const key=collection+":"+value.id;if(visited.has(key))return new Set();visited.add(key);const tasks=new Set(directTasks(value,collection));
  // Forward references bind versions, reports and indirect records to all their source tasks.
  for(const ref of recordReferences(value,collection)){try{for(const t of scope(ref.kind,source.get(ref.kind,ref.id)))tasks.add(t);}catch{/* Broken references do not manufacture authorization. */}}
  if(collection==="reports"&&Array.isArray(value.sourceRevisions))for(const ref of value.sourceRevisions as {kind:ManagementCollection;data:ManagementRecord}[])for(const t of scope(ref.kind,ref.data))tasks.add(t);
  // A controlled upload may predate its task association. Derive current scope from its consumers.
  if(["evidence","resources","batches"].includes(collection))for(const otherKind of ["documentVersions","documents","checks","progress","dailyLogs","issues","inspections","resourceNeeds","allocations","resourceUsage","tests","materialTransactions","technicalQueries","changes","meetings","actions","links","monitoring"] as ManagementCollection[])for(const other of source.list(otherKind))if(recordReferences(other,otherKind).some(ref=>ref.kind===collection&&ref.id===value.id))for(const t of scope(otherKind,other))tasks.add(t);
  return tasks;
 };
 const tasks=scope(kind,record);if(tasks.size)return [...tasks].every(t=>allowed.has(t));
 if(kind==="evidence")return record.createdBy===actor.id&&actor.permissions.includes("files");
 if(kind==="bookmarks")return record.createdBy===actor.id;
 return kind==="wbs"&&!write;
}
export function authorizeRecord(actor:Actor,kind:ManagementCollection,record:ManagementRecord,source:RecordSource,write=false){if(!canAccessRecord(actor,kind,record,source,write))throw new ManagementError(403,"RECORD_FORBIDDEN","记录或关联对象不在当前任务授权范围");}
export function commandCollection(type:string):ManagementCollection|undefined{
 if(type==="machinery.save"||type==="machinery.remove")return "resources";
 const map:Record<string,ManagementCollection>={wbs:"wbs",task:"tasks",baseline:"baselines",commitment:"commitments",progress:"progress",dailyLog:"dailyLogs",check:"checks",issue:"issues",inspection:"inspections",resource:"resources",need:"resourceNeeds",allocation:"allocations",usage:"resourceUsage",batch:"batches",test:"tests",material:"materialTransactions",document:"documentVersions",link:"links",technical:"technicalQueries",change:"changes",meeting:"meetings",action:"actions",anchor:"anchors",bookmark:"bookmarks",monitoring:"monitoring",report:"reports",evidence:"evidence"};
 if(type==="document.create")return "documents";if(type==="document.requirement"||type==="document.fulfill")return "documentRequirements";return map[type.split(".")[0]];
}
export function authorizeCommand(actor:Actor,m:ManagementCommand,source:RecordSource){
 // Check live capabilities before receipt replay or revision responses as well as in the domain.
 if(m.type==="machinery.save"||m.type==="machinery.remove"){allow(actor,"resource");allow(actor,"models");}
 if(actor.taskIds===undefined)return;
 const kind=commandCollection(m.type);
 if(kind&&m.id){try{authorizeRecord(actor,kind,source.get(kind,m.id),source,true);}catch(e){if(!(e instanceof ManagementError&&e.status===404))throw e;}}
 for(const taskId of [...(typeof m.payload.taskId==="string"?[m.payload.taskId]:[]),...(Array.isArray(m.payload.taskIds)?m.payload.taskIds:[])])if(!actor.taskIds.includes(String(taskId)))throw new ManagementError(403,"TASK_FORBIDDEN","关联任务不在授权范围");
 for(const ref of recordReferences(m.payload,kind))authorizeRecord(actor,ref.kind,source.get(ref.kind,ref.id),source);
 if(m.type==="check.copy"&&typeof m.payload.sourceId==="string")authorizeRecord(actor,"checks",source.get("checks",m.payload.sourceId),source);
}
