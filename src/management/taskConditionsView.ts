import type { ManagementCollection, ManagementRecord, TaskConditionKind, TaskConditionRule, TaskConditionsResponse } from '../managementTypes';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const CONDITION_LABELS: Record<TaskConditionKind, string> = {
  predecessors: '前置工序完成', 'preconstruction-checks': '施工前检查', resources: '资源准备', documents: '有效施工资料',
  'external-permit': '外部许可', acceptance: '完工验收', 'blocking-issues': '阻断问题闭环', quantity: '确认完成数量',
};
const sources: Partial<Record<TaskConditionKind, ManagementCollection>> = { predecessors: 'tasks', 'preconstruction-checks': 'checks', resources: 'resourceNeeds', documents: 'documentRequirements', acceptance: 'checks', 'blocking-issues': 'issues' };
export function conditionDraft(task: ManagementRecord): TaskConditionRule[] {
  const policy = task.conditionPolicy as TaskConditionsResponse['policy'];
  if (policy) return structuredClone(policy.rules);
  return (Object.keys(CONDITION_LABELS) as TaskConditionKind[]).map((kind, i) => ({ id: kind, kind, stage: i < 5 ? 'start' : 'completion', mode: '' as TaskConditionRule['mode'], referenceIds: [], note: '' }));
}
export function renderConditionRules(rules: TaskConditionRule[], collections: Record<ManagementCollection, ManagementRecord[]>, taskId?: string): string {
  return rules.map((rule, i) => {
    const source = sources[rule.kind], rows = source ? collections[source].filter(r => source === 'tasks' ? r.id !== taskId : r.taskId === taskId || r.taskIds?.includes(taskId || '')) : [];
    const attr = (key: string) => `data-mg-rule="${key}" data-index="${i}"`;
    return `<fieldset class="mg-condition-rule"><legend>${esc(CONDITION_LABELS[rule.kind])} · ${rule.stage === 'start' ? '开工' : '完工'}</legend><label>适用规则<select ${attr('mode')} aria-label="${esc(CONDITION_LABELS[rule.kind])}适用规则"><option value="">待配置，请明确选择</option>${[['required','强制条件'],['advisory','提示条件'],['not-applicable','不适用']].map(([v,t])=>`<option value="${v}" ${rule.mode===v?'selected':''}>${t}</option>`).join('')}</select></label>${source ? `<label>指定依据（未指定时核对本任务全部适用记录）<select multiple ${attr('referenceIds')} aria-label="${esc(CONDITION_LABELS[rule.kind])}关联依据">${rows.map(r=>`<option value="${esc(r.id)}" ${rule.referenceIds.includes(r.id)?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''}<label>适用说明 / 不适用依据<input ${attr('note')} value="${esc(rule.note)}" aria-label="${esc(CONDITION_LABELS[rule.kind])}说明"></label>${rule.kind === 'external-permit' ? `<label>许可依据<input ${attr('basis')} value="${esc(rule.basis)}"></label><label>许可有效期<input type="date" ${attr('validUntil')} value="${esc(rule.validUntil)}"></label><label>许可证据<select multiple ${attr('evidenceIds')}>${collections.evidence.map(r=>`<option value="${esc(r.id)}" ${rule.evidenceIds?.includes(r.id)?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''}</fieldset>`;
  }).join('');
}
export function renderConditionResults(data: TaskConditionsResponse, stage?: 'start'|'completion'): string {
  const rows = stage ? data.stages[stage] : [...data.stages.start, ...data.stages.completion];
  return `<div class="mg-condition-results" data-policy-version="${data.policy?.version || 0}"><p class="mg-state-note">${data.policy ? `规则版本 ${data.policy.version}` : '规则待配置'} · 服务端数据版本 ${data.dataVersion} · 状态变更时会再次核对</p>${rows.map(r=>`<article class="mg-condition-result" data-condition-status="${r.status}"><b>${r.kind === 'configuration' ? '任务条件尚未配置' : CONDITION_LABELS[r.kind]}</b><span>${{satisfied:'已满足',blocked:'未满足',advisory:'提示', 'not-applicable':'不适用','configuration-required':'待配置'}[r.status]}</span><p>${esc(r.reason)}</p><div>${r.references.map(ref=>`<button type="button" class="small link" data-mg-action="detail" data-kind="${ref.collection}" data-id="${esc(ref.id)}">${esc(ref.name)}</button>`).join('')}</div></article>`).join('')}</div>`;
}
export function renderConditionException(data: TaskConditionsResponse, stage: 'start'|'completion'): string {
  const blocked=data.stages[stage].filter(r=>r.status==='blocked'||r.status==='configuration-required');
  if(!blocked.length)return '';
  return `<details class="mg-condition-exception"><summary>有权人员例外放行</summary><p>普通流转不会豁免条件。选择具体项目并填写理由、依据后，签认人和本次规则版本一并归档。</p>${blocked.map(r=>`<label><input type="checkbox" data-mg-exception="condition" value="${esc(r.id)}">${esc(r.kind==='configuration'?'明确尚未配置的规则':CONDITION_LABELS[r.kind])}</label>`).join('')}<label>豁免理由<textarea data-mg-exception="reason" aria-label="豁免理由"></textarea></label><label>签认依据<textarea data-mg-exception="basis" aria-label="签认依据"></textarea></label></details>`;
}
