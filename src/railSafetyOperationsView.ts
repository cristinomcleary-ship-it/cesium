import type { ManagementRecord } from './managementTypes.ts';
import type { RailSafetyRecord } from './railSafetyTypes.ts';
import type { RailSafetyMachineResult } from './railSafetyScene.ts';
import { selectRailSafetyTaskScope, type RailSafetyTaskScope, type RailSafetyTaskSummary, type RailSafetyTaskView } from './railSafetyTaskView.ts';
import { RAIL_SAFETY_RISK_CLOSED_STATUSES, type RailSafetyRiskSnapshot } from './railSafetyRiskTypes.ts';
import './railSafetyOperationsView.css';

export type RailSafetyIssueFilter = 'open' | 'all' | 'archived';
export type RailSafetyOperationsData = {
  mode: 'tasks' | 'issues'; taskView: RailSafetyTaskView; scopeKey: string; issueFilter: RailSafetyIssueFilter;
  resources: readonly ManagementRecord[]; records: readonly RailSafetyRecord[]; issues: readonly ManagementRecord[];
  tasks?: readonly ManagementRecord[]; results: readonly RailSafetyMachineResult[]; canReport: boolean; busy: boolean;
};
export type RailSafetyOperationsActions = {
  scopeChange(key: string): void; issueFilterChange(filter: RailSafetyIssueFilter): void; openTasks(taskId?: string): void;
  selectObject(kind: 'machine' | 'guard' | 'limit', id: string): void; locateMachine(id: string): void;
  openIssue(id: string): void; reportRisk(resourceId: string, limitId: string): void; exportCsv(): void;
};

const CLOSED = new Set<string>([...RAIL_SAFETY_RISK_CLOSED_STATUSES, 'cancelled', 'deleted']);
const ISSUE_STATUS: Record<string, string> = {
  'pending-verification': '待核查', 'pending-rectification': '待整改', rectifying: '整改中',
  'in-rectification': '整改中', 'pending-review': '待复核', closed: '已关闭',
  'false-positive': '误报归档', duplicate: '重复归档', cancelled: '已取消',
};
const RISK_STATUS = { unknown: '待核实', overlap: '潜在侵限', touching: '接触边界', clear: '未相交' } as const;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => typeof value === 'string' && value ? value : fallback;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = content;
  return result;
}
function button(label: string, action: string, run: () => void, disabled = false, values: Record<string, string> = {}): HTMLButtonElement {
  const result = node('button', '', label); result.type = 'button'; result.disabled = disabled;
  result.dataset.action = action;
  for (const [key, value] of Object.entries(values)) result.dataset[key] = value;
  result.addEventListener('click', event => { event.stopPropagation(); if (!result.disabled) run(); });
  return result;
}
function hasRiskSnapshot(record: ManagementRecord): boolean {
  return isObject(record.railSafetyRisk) && record.railSafetyRisk.schemaVersion === 1;
}
/** A malformed historical row remains visible, but must not offer references we cannot validate. */
function snapshot(record: ManagementRecord): RailSafetyRiskSnapshot | undefined {
  const value = record.railSafetyRisk;
  if (!isObject(value) || value.schemaVersion !== 1
    || !['resourceId', 'machineConfigId', 'limitId', 'capturedAt'].every(key => typeof value[key] === 'string' && !!value[key])
    || !['resourceRevision', 'machineConfigRevision', 'limitRevision'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)
    || !['overlap', 'touching'].includes(String(value.status))) return undefined;
  return value as RailSafetyRiskSnapshot;
}
function formatInstant(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return `${new Date(value).toLocaleString('zh-CN', { hour12: false })}（本机时间）`;
}
function visible<T extends ManagementRecord>(rows: readonly T[], projectId: string): T[] {
  return rows.filter(row => row.projectId === projectId && row.status !== 'deleted');
}
function sourceWarnings(risk: RailSafetyRiskSnapshot, data: RailSafetyOperationsData): string[] {
  const projectId = data.taskView.projectId;
  const refs: Array<{ label: string; id: string; revision: number; rows: readonly ManagementRecord[] }> = [
    { label: '机械资源', id: risk.resourceId, revision: risk.resourceRevision, rows: data.resources },
    { label: '机械配置', id: risk.machineConfigId, revision: risk.machineConfigRevision, rows: data.records },
    { label: '安全限界', id: risk.limitId, revision: risk.limitRevision, rows: data.records },
  ];
  if (risk.taskId) refs.push({ label: '关联任务', id: risk.taskId, revision: risk.taskRevision ?? -1, rows: data.tasks ?? [] });
  return refs.flatMap(ref => {
    const current = ref.rows.find(row => row.id === ref.id && row.projectId === projectId && row.status !== 'deleted');
    if (!current) return [`${ref.label}当前不可见或已移除，请核对历史依据。`];
    return current.revision !== ref.revision ? [`${ref.label}已更新（登记时 v${ref.revision} → 当前 v${current.revision}），此单保留原筛查快照。`] : [];
  });
}
function counts(scope: RailSafetyTaskScope): HTMLElement {
  const grid = node('dl', 'rs-ops-counts');
  const values: Array<[string, string, number]> = [
    ['resources', '涉及机械', scope.resourceIds.length], ['configured', '本范围已配置', scope.configuredResourceIds.length],
    ['missing', '待绑定配置', scope.missingConfigurationResourceIds.length], ['guards', '防护人员配置', scope.guardIds.length],
    ['own-limits', '专属限界', scope.ownLimitIds.length], ['shared-limits', '共用可选限界', scope.sharedLimitIds.length],
    ['open-issues', '未闭环风险单', scope.openIssueIds.length],
  ];
  for (const [key, label, count] of values) {
    const cell = node('div', key === 'missing' && count > 0 ? 'rs-ops-count is-attention' : 'rs-ops-count');
    const value = node('dd', '', String(count)); value.dataset.count = key;
    cell.append(node('dt', '', label), value); grid.append(cell);
  }
  return grid;
}
function issueCounts(scope: RailSafetyTaskScope): HTMLElement {
  const grid = node('dl', 'rs-ops-counts');
  const values: Array<[string, string, number]> = [
    ['open-issues', '未闭环', scope.openIssueIds.length],
    ['pending-verification', '待核查', scope.pendingVerificationIssueIds.length],
    ['archived', '已归档', scope.issueIds.length - scope.openIssueIds.length],
  ];
  for (const [key, label, count] of values) {
    const cell = node('div', 'rs-ops-count');
    const value = node('dd', '', String(count)); value.dataset.count = key;
    cell.append(node('dt', '', label), value); grid.append(cell);
  }
  return grid;
}
function taskCard(task: RailSafetyTaskSummary, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): HTMLElement {
  const card = node('article', 'rs-ops-card rs-ops-task'); card.dataset.taskId = task.taskId;
  const heading = node('div', 'rs-ops-card-heading');
  heading.append(node('strong', '', task.name), node('span', 'rs-badge', task.statusLabel)); card.append(heading);
  card.append(node('p', 'rs-help', `计划 ${task.planStart || '未设置'} 至 ${task.planEnd || '未设置'}${task.forecastEnd ? ` · 预测完成 ${task.forecastEnd}` : ''}`));
  card.append(counts(task));
  const controls = node('div', 'rs-actions');
  controls.append(
    button(data.scopeKey === task.taskId ? '正在查看' : '查看任务范围', 'view-task-scope', () => actions.scopeChange(task.taskId), data.busy || data.scopeKey === task.taskId, { taskId: task.taskId }),
    button('任务详情', 'open-task-detail', () => actions.openTasks(task.taskId), data.busy, { taskId: task.taskId }),
  );
  card.append(controls); return card;
}
function mechanicalCard(resource: ManagementRecord, scope: RailSafetyTaskScope, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): HTMLElement {
  const config = data.records.find(row => row.status !== 'deleted' && row.projectId === data.taskView.projectId
    && row.definition.kind === 'machine' && row.definition.resourceId === resource.id && scope.recordIds.includes(row.id));
  const result = config ? data.results.find(row => row.resourceId === resource.id && row.recordId === config.id) : undefined;
  const card = node('article', `rs-ops-card rs-ops-machine${result && (result.status === 'overlap' || result.status === 'touching') ? ' is-risk' : ''}`);
  card.dataset.resourceId = resource.id; card.dataset.status = result?.status ?? 'unknown';
  const heading = node('div', 'rs-ops-card-heading');
  heading.append(node('strong', '', resource.name || '未命名机械'), node('span', 'rs-badge', config ? '已保存配置' : '待绑定配置'));
  card.append(heading);
  const gap = scope.configurationGaps.find(row => row.resourceId === resource.id);
  if (gap) card.append(node('p', 'rs-warning', gap.message));
  if (!resource.machinery) card.append(node('p', 'rs-warning', '尚未放置机械模型，暂无法计算倾覆范围。'));
  if (config && !result) card.append(node('p', 'rs-help', '当前配置尚无可用筛查结果，计算完成后更新。'));
  if (result) {
    card.append(node('p', 'rs-ops-result-title', `${result.draft ? '草稿预览 · ' : ''}${result.label}`), node('p', 'rs-help', result.message));
    if (result.draft) card.append(node('p', 'rs-warning', '草稿筛查不能登记风险；请先保存或取消修改。'));
    for (const limit of result.limits) {
      const line = node('div', 'rs-ops-risk-line'); line.dataset.limitId = limit.id;
      line.append(node('p', '', `${limit.name} · ${RISK_STATUS[limit.status]}${Number.isFinite(limit.distanceMeters) ? ` · ${limit.distanceMeters!.toFixed(2)} m` : ''}`));
      if (limit.message) line.append(node('p', 'rs-help', limit.message));
      if (limit.status === 'overlap' || limit.status === 'touching') {
        const existing = visible(data.issues, data.taskView.projectId).find(issue => {
          const risk = snapshot(issue);
          return !CLOSED.has(issue.status) && risk?.resourceId === resource.id && risk.limitId === limit.id && risk.taskId === config?.taskId;
        });
        if (existing) line.append(button('查看未闭环风险单', 'open-risk-issue', () => actions.openIssue(existing.id), data.busy, { issueId: existing.id }));
        else line.append(button('登记风险处置单', 'report-risk', () => actions.reportRisk(resource.id, limit.id),
          data.busy || !data.canReport || result.draft, { resourceId: resource.id, limitId: limit.id }));
      }
      card.append(line);
    }
  }
  const controls = node('div', 'rs-actions');
  controls.append(button(config ? '查看 / 配置机械' : '配置机械管控', 'select-safety-object', () => actions.selectObject('machine', resource.id), data.busy, { kind: 'machine', id: resource.id }));
  controls.append(button('定位机械', 'locate-ops-machine', () => actions.locateMachine(resource.id), data.busy || !resource.machinery, { resourceId: resource.id }));
  card.append(controls); return card;
}
function objectList(title: string, ids: readonly string[], kind: 'guard' | 'limit', key: string, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): HTMLElement {
  const details = node('details', 'rs-ops-object-list'); details.dataset.opsDetail = key;
  details.append(node('summary', '', `${title} · ${ids.length}`));
  const records = visible(data.records, data.taskView.projectId).filter(row => ids.includes(row.id) && row.definition.kind === kind);
  if (!records.length) details.append(node('p', 'rs-help', '当前范围暂无此类配置。'));
  for (const record of records) {
    const line = node('div', 'rs-ops-object-row');
    line.append(node('span', '', record.name), button('查看配置', 'select-safety-object', () => actions.selectObject(kind, record.id), data.busy, { kind, id: record.id }));
    details.append(line);
  }
  if (key === 'shared-limits') details.append(node('p', 'rs-help', '共用限界仅列为候选，仍需在每台机械配置中明确选用。'));
  return details;
}
function renderTasks(host: HTMLElement, scope: RailSafetyTaskScope, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): void {
  const taskList = data.taskView.tasks.filter(task => !data.scopeKey || task.taskId === data.scopeKey);
  if (taskList.length) {
    const details = node('details', 'rs-ops-object-list'); details.dataset.opsDetail = 'tasks'; details.open = true;
    details.append(node('summary', '', `任务卡片 · ${taskList.length}`));
    for (const task of taskList) details.append(taskCard(task, data, actions));
    host.append(details);
  } else if (!data.taskView.tasks.length) host.append(node('p', 'rs-empty', '尚无可见施工任务。可打开任务管理建立任务，再关联机械、人员配置和限界。'));
  const machinery = node('section', 'rs-ops-section'); machinery.append(node('h3', '', `涉及机械 · ${scope.resourceIds.length}`));
  const resources = visible(data.resources, data.taskView.projectId).filter(row => scope.resourceIds.includes(row.id));
  if (!resources.length) machinery.append(node('p', 'rs-empty', '当前范围没有关联机械。'));
  for (const resource of resources) machinery.append(mechanicalCard(resource, scope, data, actions));
  host.append(machinery);
  host.append(objectList('防护人员配置', scope.guardIds, 'guard', 'guards', data, actions));
  host.append(objectList('专属安全限界', scope.ownLimitIds, 'limit', 'own-limits', data, actions));
  host.append(objectList('共用可选安全限界', scope.sharedLimitIds, 'limit', 'shared-limits', data, actions));
}
function issueCard(issue: ManagementRecord, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): HTMLElement {
  const card = node('article', 'rs-ops-card rs-ops-issue'); card.dataset.issueId = issue.id; card.dataset.status = issue.status;
  const heading = node('div', 'rs-ops-card-heading');
  heading.append(node('strong', '', issue.name || '机械风险处置单'), node('span', 'rs-badge', ISSUE_STATUS[issue.status] || issue.status)); card.append(heading);
  const risk = snapshot(issue);
  if (risk) {
    const resourceName = isObject(risk.resourceSnapshot) ? text(risk.resourceSnapshot.name, '机械名称未记录') : '机械名称未记录';
    const limitName = isObject(risk.limitSnapshot) ? text(risk.limitSnapshot.name, '限界名称未记录') : '限界名称未记录';
    card.append(node('p', 'rs-ops-result-title', `${resourceName} · ${limitName}`));
    card.append(node('p', 'rs-help', `登记依据：${RISK_STATUS[risk.status]}${Number.isFinite(risk.distanceMeters) ? ` · ${risk.distanceMeters.toFixed(2)} m` : ''}`));
    card.append(node('p', 'rs-help', `筛查快照：${formatInstant(risk.capturedAt)}`));
    if (risk.taskId) card.append(node('p', 'rs-help', `登记时任务：${isObject(risk.taskSnapshot) ? text(risk.taskSnapshot.name, risk.taskId) : risk.taskId}`));
    const warnings = sourceWarnings(risk, data);
    for (const warning of warnings) card.append(node('p', 'rs-warning', warning));
    if (warnings.length) card.dataset.sourceChanged = 'true';
    const resource = visible(data.resources, data.taskView.projectId).find(row => row.id === risk.resourceId);
    const controls = node('div', 'rs-actions');
    controls.append(button('查看 / 办理处置单', 'open-risk-issue', () => actions.openIssue(issue.id), data.busy, { issueId: issue.id }));
    controls.append(button('定位当前机械', 'locate-ops-machine', () => actions.locateMachine(risk.resourceId), data.busy || !resource?.machinery, { resourceId: risk.resourceId }));
    card.append(controls);
  } else {
    card.append(node('p', 'rs-warning', '历史快照字段不完整，请打开处置单核对原始记录。'));
    card.append(button('查看处置单', 'open-risk-issue', () => actions.openIssue(issue.id), data.busy, { issueId: issue.id }));
  }
  return card;
}
function renderIssues(host: HTMLElement, scope: RailSafetyTaskScope, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): void {
  const label = node('label', 'rs-label', '处置状态');
  const select = node('select'); select.dataset.role = 'issue-filter'; select.disabled = data.busy;
  for (const [value, name] of [['open', '未闭环'], ['all', '全部状态'], ['archived', '已关闭 / 已归档']] as const) {
    const option = node('option', '', name); option.value = value; select.append(option);
  }
  select.value = data.issueFilter;
  select.addEventListener('change', () => actions.issueFilterChange(select.value as RailSafetyIssueFilter));
  label.append(select); host.append(label);
  host.append(node('p', 'rs-note', '处置单保留登记时的几何筛查快照；当前现场状态需另行核实。'));
  const issues = visible(data.issues, data.taskView.projectId).filter(issue => hasRiskSnapshot(issue) && scope.issueIds.includes(issue.id)
    && (data.issueFilter === 'all' || (data.issueFilter === 'archived' ? CLOSED.has(issue.status) : !CLOSED.has(issue.status))))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
  const heading = node('h3', 'rs-ops-list-heading', `机械风险处置单 · ${issues.length}`); host.append(heading);
  if (!issues.length) host.append(node('p', 'rs-empty', '当前查看范围和状态下没有机械风险处置单。可从任务总览或机械筛查结果主动登记潜在侵限、接触边界情况。'));
  for (const issue of issues) host.append(issueCard(issue, data, actions));
}

/** Read-only grouping of authorized records. It never changes scene visibility or screening inputs. */
export function renderRailSafetyOperations(host: HTMLElement, data: RailSafetyOperationsData, actions: RailSafetyOperationsActions): void {
  const detailState = new Map(Array.from(host.querySelectorAll<HTMLDetailsElement>('details[data-ops-detail]')).map(detail => [detail.dataset.opsDetail!, detail.open]));
  const view = node('div', 'rs-ops');
  if (data.mode === 'tasks') {
    const toolbar = node('div', 'rs-ops-toolbar');
    toolbar.append(button('任务管理', 'open-tasks', () => actions.openTasks(), data.busy), button('导出任务汇总 CSV', 'export-task-csv', actions.exportCsv, data.busy));
    view.append(toolbar);
  }
  const label = node('label', 'rs-label', '查看范围');
  const select = node('select'); select.dataset.role = 'task-filter'; select.disabled = data.busy;
  const options = [{ value: '', name: '全部可见数据' }, ...data.taskView.tasks.map(task => ({ value: task.taskId, name: task.name })), { value: '__unassigned__', name: '未关联可见任务' }];
  if (!options.some(option => option.value === data.scopeKey)) options.push({ value: data.scopeKey, name: '原任务当前不可见，请重新选择' });
  for (const entry of options) { const option = node('option', '', entry.name); option.value = entry.value; select.append(option); }
  select.value = data.scopeKey;
  select.addEventListener('change', () => actions.scopeChange(select.value)); label.append(select); view.append(label);
  const scope = selectRailSafetyTaskScope(data.taskView, !data.scopeKey ? { kind: 'all' }
    : data.scopeKey === '__unassigned__' ? { kind: 'unassigned' } : { kind: 'task', taskId: data.scopeKey });
  if (!scope) view.append(node('p', 'rs-empty', '所选任务已不可见或已移除。请重新选择查看范围；当前没有展开其他任务的数据。'));
  else {
    const summary = node('section', `rs-ops-summary${data.mode === 'issues' ? ' rs-ops-summary-compact' : ''}`); summary.dataset.role = 'task-scope-summary';
    if (data.mode === 'issues') summary.append(issueCounts(scope));
    else summary.append(node('h3', '', scope.name), counts(scope));
    view.append(summary);
    if (data.mode === 'tasks') view.append(node('p', 'rs-help', '以上仅统计当前账号可见的已保存绑定；涉及机械可跨任务，各任务数量不可相加。已有配置不代表安全通过，筛选不会隐藏场景对象或停止侵限筛查。'));
    if (data.mode === 'tasks') renderTasks(view, scope, data, actions);
    else renderIssues(view, scope, data, actions);
  }
  for (const detail of view.querySelectorAll<HTMLDetailsElement>('details[data-ops-detail]')) if (detailState.has(detail.dataset.opsDetail!)) detail.open = detailState.get(detail.dataset.opsDetail!)!;
  host.replaceChildren(view);
}
