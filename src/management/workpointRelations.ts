import type {ManagementRecord, ManagementSnapshot} from '../managementTypes';
const ids=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
/** Operates only on the server-authorized snapshot. Never expands access by fetching arbitrary IDs. */
export function workpointRelations(pointId:string, collections:ManagementSnapshot['collections'], anchorTaskId?:string) {
 const tasks=collections.tasks.filter(r=>ids(r.areaIds).includes(pointId)||r.spatialObjectId===pointId||r.id===anchorTaskId);
 const taskIds=new Set(tasks.map(r=>r.id));
 const belongs=(r:ManagementRecord)=>taskIds.has(String(r.taskId))||ids(r.taskIds).some(id=>taskIds.has(id))||r.spatialObjectId===pointId||r.riskPointId===pointId||(r.discovery as {spatialObjectId?:string}|undefined)?.spatialObjectId===pointId;
 const links=collections.links.filter(r=>r.status==='active'&&(belongs(r)||r.anchorId===pointId));
 const linked=(kind:string,r:ManagementRecord)=>links.some(l=>l.targetKind===kind&&l.targetId===r.id);
 const documents=collections.documents.filter(r=>belongs(r)||linked('documents',r));
 const versions=collections.documentVersions.filter(r=>linked('documentVersions',r));
 const tests=collections.tests.filter(r=>belongs(r)||linked('tests',r));
 const batches=collections.batches.filter(r=>belongs(r)||tests.some(t=>t.batchId===r.id));
 const evidenceIds=new Set([...tasks,...tests,...collections.inspections.filter(belongs),...collections.issues.filter(belongs)].flatMap(r=>ids(r.evidenceIds)));
 return {tasks,documents,versions,links,tests,batches,resourceNeeds:collections.resourceNeeds.filter(belongs),resourceUsage:collections.resourceUsage.filter(belongs),checks:collections.checks.filter(belongs),inspections:collections.inspections.filter(belongs),issues:collections.issues.filter(belongs),evidence:collections.evidence.filter(r=>belongs(r)||evidenceIds.has(r.id)||linked('evidence',r))};
}
