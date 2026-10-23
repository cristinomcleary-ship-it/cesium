import type { ManagementCollection, ManagementRecord, ManagementSnapshot } from '../managementTypes.ts';
import type { FieldObjectReference } from '../railwayWorkflowTypes.ts';

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => !!item) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const text = (value: unknown, fallback = '未记录'): string => typeof value === 'string' && value.length ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
const escape = (value: unknown, fallback?: string): string => text(value, fallback).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const active = (record: ManagementRecord) => !record.deletedAt && !['deleted', 'removed'].includes(record.status);
const rows = (snapshot: ManagementSnapshot, kind: ManagementCollection) => snapshot.collections[kind].filter(record => record.projectId === snapshot.projectId && active(record));
const tasks = (record: Record<string, unknown>): string[] => [...(typeof record.taskId === 'string' && record.taskId ? [record.taskId] : []), ...strings(record.taskIds)];
const forTask = (record: Record<string, unknown>, taskId: string) => tasks(record).includes(taskId) || object(record.railSafetyRisk)?.taskId === taskId;
const visibleTask = (snapshot: ManagementSnapshot, taskId: string) => rows(snapshot, 'tasks').find(record => record.id === taskId);
const sameRef = (value: unknown, ref: FieldObjectReference) => object(value)?.kind === ref.kind && object(value)?.id === ref.id;

function refersTo(record: ManagementRecord, ref: FieldObjectReference): boolean {
  if (sameRef(record.objectRef, ref) || objects(record.objectRefs).some(value => sameRef(value, ref))) return true;
  const risk = object(record.railSafetyRisk);
  if (ref.kind === 'resources') return record.resourceId === ref.id || risk?.resourceId === ref.id;
  if (ref.kind === 'railSafety') return risk?.limitId === ref.id || risk?.machineConfigId === ref.id;
  return record.anchorId === ref.id;
}

function objectLinks(snapshot: ManagementSnapshot, ref: FieldObjectReference) {
  return rows(snapshot, 'links').filter(link => link.status === 'active' && (link.sourceKind === ref.kind && link.sourceId === ref.id || ref.kind === 'anchors' && link.anchorId === ref.id));
}

function linked(links: ManagementRecord[], kind: ManagementCollection, record: ManagementRecord) {
  return links.some(link => link.targetKind === kind && link.targetId === record.id);
}

/** No name matching, arbitrary-ID requests or permission expansion: only authorized snapshot records. */
export function fieldObjectRecord(snapshot: ManagementSnapshot, ref: FieldObjectReference): ManagementRecord | undefined {
  return rows(snapshot, ref.kind).find(record => record.id === ref.id);
}

const reusableCategories = new Set(['agreement', 'scheme', 'construction-scheme', 'personnel-certificate', 'certificate', 'qualification']);
const reusable = (record: ManagementRecord) => reusableCategories.has(String(record.workflowCategory)) || reusableCategories.has(String(record.category));
const dailyCategories = new Set(['construction-plan', 'supervision-plan', 'check', 'inspection', 'monitoring', 'rectification', 'daily-record']);

function documentInTask(document: ManagementRecord, links: ManagementRecord[], taskId?: string): boolean {
  if (!taskId || reusable(document)) return true;
  if (tasks(document).length) return forTask(document, taskId);
  return links.some(link => forTask(link, taskId) && link.targetKind === 'documents' && link.targetId === document.id);
}

function versionInTask(version: ManagementRecord, document: ManagementRecord, links: ManagementRecord[], taskId?: string): boolean {
  if (!taskId || reusable(document) || reusable(version)) return true;
  // A new version can deliberately associate an existing document with a different plan.
  if (tasks(version).length) return forTask(version, taskId);
  if (tasks(document).length) return forTask(document, taskId);
  return links.some(link => forTask(link, taskId) && (link.targetKind === 'documentVersions' && link.targetId === version.id || link.targetKind === 'documents' && link.targetId === document.id));
}

export function fieldObjectDocumentVersions(snapshot: ManagementSnapshot, ref: FieldObjectReference, taskId?: string): ManagementRecord[] {
  const links = objectLinks(snapshot, ref);
  const documents = rows(snapshot, 'documents');
  return rows(snapshot, 'documentVersions').filter(version => {
    const document = documents.find(record => record.id === version.documentId);
    if (!document || !versionInTask(version, document, links, taskId)) return false;
    if (refersTo(version, ref) || linked(links, 'documentVersions', version)) return true;
    // Legacy versions without their own object assignment inherit the parent. Explicit
    // version references take precedence, so another object's version is never included.
    if (version.objectRef || objects(version.objectRefs).length) return false;
    return refersTo(document, ref) || linked(links, 'documents', document);
  });
}

/** Omitting taskId opens the object's full file history; a daily record must pass its taskId. */
export function fieldObjectDocuments(snapshot: ManagementSnapshot, ref: FieldObjectReference, taskId?: string): ManagementRecord[] {
  if (!fieldObjectRecord(snapshot, ref) || taskId && !visibleTask(snapshot, taskId)) return [];
  const links = objectLinks(snapshot, ref);
  const versionDocuments = new Set(fieldObjectDocumentVersions(snapshot, ref, taskId).map(version => String(version.documentId)));
  return rows(snapshot, 'documents').filter(record => versionDocuments.has(record.id) || (refersTo(record, ref) || linked(links, 'documents', record)) && documentInTask(record, links, taskId));
}

export function fieldObjectChecks(snapshot: ManagementSnapshot, ref: FieldObjectReference, taskId: string): ManagementRecord[] {
  if (!fieldObjectRecord(snapshot, ref) || !visibleTask(snapshot, taskId)) return [];
  return rows(snapshot, 'checks').filter(record => forTask(record, taskId) && (refersTo(record, ref) || !record.objectRef && record.inspectionObjectId === ref.id));
}

export function fieldObjectIssues(snapshot: ManagementSnapshot, ref: FieldObjectReference, taskId?: string): ManagementRecord[] {
  if (!fieldObjectRecord(snapshot, ref) || taskId && !visibleTask(snapshot, taskId)) return [];
  return rows(snapshot, 'issues').filter(record => refersTo(record, ref) && (!taskId || forTask(record, taskId)));
}

function evidenceReferences(records: ManagementRecord[]): Set<string> {
  return new Set(records.flatMap(record => [
    ...strings(record.evidenceIds),
    ...objects(record.items).flatMap(item => strings(item.evidenceIds)),
    ...objects(record.rounds).flatMap(round => [...strings(round.evidenceIds), ...strings(round.reviewEvidenceIds)]),
  ]));
}

function certificateReferences(record: ManagementRecord): Set<string> {
  return new Set([...strings(object(record.personnel)?.certificateEvidenceIds), ...strings(object(record.guardPersonnel)?.certificateEvidenceIds), ...strings(record.qualificationEvidenceIds)]);
}

/** Daily photographs/check evidence never follow a machine into another day's plan. */
export function fieldObjectEvidence(snapshot: ManagementSnapshot, ref: FieldObjectReference, taskId?: string): ManagementRecord[] {
  const record = fieldObjectRecord(snapshot, ref);
  if (!record || taskId && !visibleTask(snapshot, taskId)) return [];
  const task = taskId ? visibleTask(snapshot, taskId) : undefined;
  const sourceId = object(task?.railwayPlan)?.sourceEvidenceId;
  const links = objectLinks(snapshot, ref);
  const documents = fieldObjectDocuments(snapshot, ref, taskId);
  const versions = fieldObjectDocumentVersions(snapshot, ref, taskId);
  const versionEvidence = new Set(versions.map(version => String(version.evidenceId)));
  const checks = taskId ? fieldObjectChecks(snapshot, ref, taskId) : rows(snapshot, 'checks').filter(check => refersTo(check, ref) || check.inspectionObjectId === ref.id);
  const references = evidenceReferences([...checks, ...fieldObjectIssues(snapshot, ref, taskId)]);
  const certificates = certificateReferences(record);
  return rows(snapshot, 'evidence').filter(evidence => {
    // A workbook can contain several daily plans, and does not need a mapped machine.
    if (evidence.id === sourceId) return true;
    const permanent = certificates.has(evidence.id) || reusable(evidence) && refersTo(evidence, ref);
    const documentEvidence = versionEvidence.has(evidence.id);
    const related = permanent || documentEvidence || references.has(evidence.id) || refersTo(evidence, ref) || linked(links, 'evidence', evidence);
    if (!related || !taskId) return related;
    if (permanent) return true;
    // An explicitly task-scoped daily file cannot be laundered through a shared object.
    if (tasks(evidence).length && !forTask(evidence, taskId)) return documentEvidence && documents.some(document => reusable(document) && versions.some(version => version.documentId === document.id && version.evidenceId === evidence.id));
    return forTask(evidence, taskId) || references.has(evidence.id) || documentEvidence || links.some(link => forTask(link, taskId) && link.targetKind === 'evidence' && link.targetId === evidence.id);
  });
}

const statusLabels: Record<string, string> = {
  draft: '草稿', confirmed: '已确认', active: '已登记', ready: '已上传', published: '平台已发布', 'under-review': '待审核', returned: '已退回', superseded: '已被新版本替代', void: '已作废',
  'pending-verification': '待核实', 'pending-rectification': '待整改', rectifying: '整改中', 'in-rectification': '整改中', 'pending-review': '待复核', closed: '已关闭', 'false-positive': '核实为误报', duplicate: '重复问题',
  'in-progress': '进行中', paused: '已暂停', 'pending-completion': '待完成确认', completed: '已完成', cancelled: '已取消',
};
const resultLabels: Record<string, string> = { pending: '待检查', pass: '无问题', fail: '存在问题', 'not-applicable': '与当日施工无关' };
const status = (value: unknown) => statusLabels[String(value)] || text(value, '状态未记录');
const table = (caption: string, headings: string[], body: string[][]) => `<table><caption>${escape(caption)}</caption><thead><tr>${headings.map(heading => `<th scope="col">${escape(heading)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const paragraph = (value: unknown) => `<p>${escape(value)}</p>`;

function revisionNote(snapshot: ManagementSnapshot, source: ManagementRecord): string {
  const frozen = object(source.objectSnapshot), ref = object(frozen?.ref);
  const notes: string[] = [];
  if (ref && ['resources', 'railSafety', 'anchors'].includes(String(ref.kind)) && typeof ref.id === 'string') {
    const current = fieldObjectRecord(snapshot, { kind: ref.kind as FieldObjectReference['kind'], id: ref.id });
    const name = object(frozen?.data)?.name;
    notes.push(`登记时对象：${text(name)}；修订 ${text(frozen?.revision)}；捕获时间 ${text(frozen?.capturedAt)}。${current ? current.revision === frozen?.revision ? '当前对象修订一致。' : `当前对象修订 ${current.revision}，已发生变化；历史记录保留原快照。` : '当前对象未提供，保留登记时快照。'}`);
    const data = object(frozen?.data), placement = object(object(data?.machinery)?.placement) || object(object(data?.definition)?.station);
    if (placement) notes.push(`登记时模型坐标：经度 ${text(placement.longitude)}，纬度 ${text(placement.latitude)}，椭球高 ${text(placement.height)} m。模型坐标不代替现场测量。`);
  }
  const risk = object(source.railSafetyRisk);
  if (risk) {
    notes.push(`登记时几何筛查：${risk.status === 'overlap' ? '存在交叉' : risk.status === 'touching' ? '边界接触' : '结果未记录'}；捕获时间 ${text(risk.capturedAt)}；待现场核实。`);
    const references = [
      { kind: 'resources' as const, id: risk.resourceId, revision: risk.resourceRevision, name: object(risk.resourceSnapshot)?.name, label: '机械' },
      { kind: 'railSafety' as const, id: risk.machineConfigId, revision: risk.machineConfigRevision, name: object(risk.machineConfigSnapshot)?.name, label: '管控配置' },
      { kind: 'railSafety' as const, id: risk.limitId, revision: risk.limitRevision, name: object(risk.limitSnapshot)?.name, label: '限界' },
    ];
    for (const item of references) {
      if (typeof item.id !== 'string') continue;
      const current = fieldObjectRecord(snapshot, { kind: item.kind, id: item.id });
      notes.push(`${item.label}：${text(item.name)}；登记时修订 ${text(item.revision)}；${current ? `当前修订 ${current.revision}${current.revision === item.revision ? '，版本一致' : '，已变化，原筛查结果不代表当前状态'}` : '当前对象未提供'}。`);
    }
  }
  return notes.map(note => `<p class="rf-revision-note">${escape(note)}</p>`).join('');
}

function documentStatus(snapshot: ManagementSnapshot, document: ManagementRecord, ref?: FieldObjectReference, taskId?: string) {
  const versions = (ref ? fieldObjectDocumentVersions(snapshot, ref, taskId) : rows(snapshot, 'documentVersions').filter(version => versionInTask(version, document, rows(snapshot, 'links').filter(link => link.status === 'active'), taskId))).filter(version => version.documentId === document.id);
  const effective = versions.find(version => version.id === document.effectiveVersionId && version.status === 'published');
  if (effective) return `平台已发布版本 ${text(effective.version)}；依据：${text(effective.publicationBasis)}`;
  const latest = [...versions].sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  return latest ? `版本 ${text(latest.version)}：${status(latest.status)}；无可用的已发布版本` : '已建立资料项，未提供可用版本';
}

/** Printable draft only: no approvals, check conclusions or signatures are invented. */
export function fieldRecordHtml(snapshot: ManagementSnapshot, taskId: string, ref?: FieldObjectReference): string {
  const task = visibleTask(snapshot, taskId);
  if (!task) return '<article class="rf-paper" aria-label="现场记录草稿"><h2>现场记录草稿</h2><p>所选作业未提供或无权查看，请先选择可用作业。</p></article>';
  const selected = ref ? fieldObjectRecord(snapshot, ref) : undefined;
  if (ref && !selected) return '<article class="rf-paper" aria-label="现场记录草稿"><h2>现场记录草稿</h2><p>所选现场对象未提供或无权查看。</p></article>';
  const plan = object(task.railwayPlan);
  const checks = ref ? fieldObjectChecks(snapshot, ref, taskId) : rows(snapshot, 'checks').filter(record => forTask(record, taskId));
  const issues = ref ? fieldObjectIssues(snapshot, ref, taskId) : rows(snapshot, 'issues').filter(record => forTask(record, taskId));
  const links = rows(snapshot, 'links').filter(link => link.status === 'active' && forTask(link, taskId));
  const taskVersionDocuments = new Set(rows(snapshot, 'documentVersions').filter(version => forTask(version, taskId) || !tasks(version).length && linked(links, 'documentVersions', version)).map(version => String(version.documentId)));
  const documents = ref ? fieldObjectDocuments(snapshot, ref, taskId) : rows(snapshot, 'documents').filter(record => forTask(record, taskId) || taskVersionDocuments.has(record.id) || documentInTask(record, links, taskId) && linked(links, 'documents', record));
  const references = evidenceReferences([...checks, ...issues]);
  const versionEvidence = new Set(rows(snapshot, 'documentVersions').filter(version => documents.some(document => document.id === version.documentId) && (forTask(version, taskId) || !tasks(version).length || documents.some(document => document.id === version.documentId && reusable(document)))).map(version => String(version.evidenceId)));
  const evidence = ref ? fieldObjectEvidence(snapshot, ref, taskId) : rows(snapshot, 'evidence').filter(record => record.id === plan?.sourceEvidenceId || forTask(record, taskId) || (!tasks(record).length || forTask(record, taskId)) && (references.has(record.id) || versionEvidence.has(record.id) || linked(links, 'evidence', record)));
  const source = evidence.find(record => record.id === plan?.sourceEvidenceId);
  const fields = [
    ['作业名称', task.name], ['正式计划号（导入值）', plan?.number], ['计划类型', plan?.kind === 'construction' ? '施工计划' : plan?.kind === 'supervision' ? '安全监督计划' : '未登记'],
    ['计划原件', source?.name || '原件未提供或无权查看'], ['计划来源', plan ? `${text(plan.sheetName)}，第 ${text(plan.rowNumber)} 行；${plan.verificationStatus === 'pending' ? '待核验' : text(plan.verificationStatus, '核验状态未记录')}` : '未登记'],
    ['计划日期', task.planStart], ['作业时段', task.workWindowStart || task.workWindowEnd ? `${text(task.workWindowStart)} 至 ${text(task.workWindowEnd)}` : '未记录'],
    ['线路', task.railwayLine], ['里程', task.railwayMileage], ['现场对象', selected?.name || '本作业全部已关联对象'], ['记录范围', '当前可见记录；本预览为草稿'],
  ];
  const checkHtml = checks.length ? checks.map(check => `<section><h3>${escape(check.name)} · ${escape(status(check.status))}</h3>${paragraph(`检查日期：${text(check.businessDate)}；清单版本：${text(check.checklistVersion)}；确认时间：${text(check.confirmedAt)}。`)}${revisionNote(snapshot, check)}${table('检查结果', ['检查项', '结果', '依据／说明'], objects(check.items).map(item => [escape(item.name), escape(resultLabels[String(item.result)] || '结果未记录'), escape(item.basis)]))}</section>`).join('') : paragraph('尚无已保存的检查记录；未检查事项不作合格推定。');
  const issueHtml = issues.length ? issues.map(issue => `<section><h3>${escape(issue.name)} · ${escape(status(issue.status))}</h3>${paragraph(`发现记录时间：${text(issue.createdAt)}；责任人：${text(snapshot.members.find(member => member.id === issue.ownerId)?.displayName, '未指定或不可见')}；整改期限：${text(issue.dueDate)}。`)}${revisionNote(snapshot, issue)}${objects(issue.rounds).map(round => paragraph(`整改说明：${text(round.description)}；提交时间：${text(round.submittedAt)}；复核结果：${round.passed === true ? '通过' : round.passed === false ? '退回' : '待复核'}；复核意见：${text(round.reviewComment)}。`)).join('')}</section>`).join('') : paragraph('本范围暂无已登记问题；不代表现场不存在风险。');
  const evidenceRows = evidence.map(record => [escape(record.name), escape(record.id === plan?.sourceEvidenceId ? '计划原件' : record.workflowCategory === 'personnel-certificate' ? '培训证书（核验状态另行记录）' : dailyCategories.has(String(record.workflowCategory)) ? '作业资料' : '关联附件'), escape(status(record.status)), escape(record.createdAt)]);
  return `<article class="rf-paper" aria-label="现场检查与监护记录草稿"><header><h2>现场检查与监护记录草稿</h2><p>根据已保存数据整理，需由相应人员核对。导入、上传及模型计算不构成施工许可；本预览不生成签名。</p></header><dl>${fields.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><section><h2>检查记录</h2>${checkHtml}</section><section><h2>问题与整改</h2>${issueHtml}</section><section><h2>关联资料</h2>${documents.length ? table('资料及平台版本状态', ['资料名称', '版本状态'], documents.map(document => [escape(document.name), escape(documentStatus(snapshot, document, ref, taskId))])) : paragraph('暂无本范围关联资料。')}</section><section><h2>附件清单</h2>${evidenceRows.length ? table('本次记录引用附件', ['文件名称', '用途', '文件状态', '上传／登记时间'], evidenceRows) : paragraph('暂无可见附件。')}</section><footer><p>已确认检查记录和登记时对象快照保持原样；当前数据变化不会覆盖历史记录。责任人员签认另行办理。</p></footer></article>`;
}
