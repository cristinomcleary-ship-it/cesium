import { MANAGEMENT_API, type ManagementCommandType, type ManagementRecord, type ManagementSnapshot, type ManagementCheckItem } from '../managementTypes';
import type { FieldObjectReference, GuardPersonnel } from '../railwayWorkflowTypes';
import { fieldObjectRecord, fieldObjectDocuments, fieldObjectDocumentVersions, fieldObjectEvidence, fieldObjectChecks, fieldObjectIssues, fieldRecordHtml } from './railwayFieldData';
import './railwayFieldOperations.css';

type Options = {
  host: HTMLElement;
  getSnapshot(): ManagementSnapshot | undefined;
  getObject(): FieldObjectReference | undefined;
  getTaskId(): string | undefined;
  command(type: ManagementCommandType, payload: Record<string, unknown>, id: string | undefined, revision: number | undefined, key: string): Promise<ManagementSnapshot>;
  upload(file: File, meta: Record<string, unknown>): Promise<ManagementRecord>;
  onSaved(snapshot: ManagementSnapshot): void;
  openForm(type: ManagementCommandType, record?: ManagementRecord, prefill?: Record<string, unknown>): void;
  showRecord(kind: string, id: string): void;
  editObject(object: FieldObjectReference): void;
  locateObject(object: FieldObjectReference): void;
  toast(message: string): void;
};
const e = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const str = (value: unknown) => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const day = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const b = (action: string, label: string, attrs = '', cls = '') => `<button type="button" data-rf-action="${action}" ${attrs} class="${cls}">${label}</button>`;
const resultLabels: Record<string, string> = { pending: '待检查', pass: '无问题', fail: '存在问题', 'not-applicable': '与当日作业无关' };
const personnelFields = ['name', 'unit', 'phone', 'role', 'certificateNumber', 'trainingOrganization', 'trainingDate', 'validUntil'] as const;
const personnelInput = (profile: GuardPersonnel | undefined, fallbackName: string): GuardPersonnel => ({ ...Object.fromEntries(personnelFields.filter(key => typeof profile?.[key] === 'string').map(key => [key, profile![key]])), name: profile?.name || fallbackName, certificateEvidenceIds: [...(profile?.certificateEvidenceIds || [])] });
const categories = ['安全协议', '施工方案', '人员证书', '机械资料', '培训交底', '现场调查', '检查记录', '整改资料', '其他资料'];
type UploadItem = { file: File; evidence?: ManagementRecord; documentId: string; versionId: string; createKey: string; versionKey: string; created: boolean; saved: boolean; error?: string };

/** Business actions attach to the selected live object. No second browser-local business store. */
export class RailwayFieldOperations {
  private readonly dialog = document.createElement('dialog');
  private readonly events = new AbortController();
  private tab: 'documents' | 'checks' | 'information' = 'documents';
  private dirty = false;
  private busy = false;
  private disposed = false;
  private context = '';
  private lastObject = '';
  private cleanup?: () => void;
  constructor(private readonly options: Options) {
    this.dialog.className = 'rf-dialog';
    this.dialog.setAttribute('aria-label', '现场对象业务');
    options.host.append(this.dialog);
    options.host.addEventListener('click', event => {
      const el = (event.target as Element).closest<HTMLElement>('[data-rf-action]');
      if (!el || el.matches(':disabled')) return;
      void this.action(el).catch(error => this.options.toast(error instanceof Error ? error.message : String(error)));
    }, { signal: this.events.signal });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, { signal: this.events.signal });
    this.dialog.addEventListener('input', event => { if ((event.target as Element).closest('form')) this.dirty = true; }, { signal: this.events.signal });
    this.dialog.addEventListener('change', event => { if ((event.target as Element).closest('form')) this.dirty = true; }, { signal: this.events.signal });
  }
  get hasDraft() { return this.dialog.open && (this.busy || this.dirty); }
  close(): boolean {
    if (this.busy) { this.options.toast('正在保存，请等待后端回执。'); return false; }
    if (this.dirty && !window.confirm('放弃当前尚未保存的输入？已保存的原件会保留。')) return false;
    this.finish(); return true;
  }
  dispose() { this.disposed = true; this.events.abort(); this.cleanup?.(); this.dialog.remove(); }
  private finish() { this.cleanup?.(); this.cleanup = undefined; this.dirty = false; this.busy = false; this.dialog.close(); this.dialog.replaceChildren(); }
  private signature() { const s = this.options.getSnapshot(); return JSON.stringify([s?.projectId, s?.session.userId, s?.session.permissions, this.options.getTaskId(), this.options.getObject()]); }
  private current() { if (this.disposed || this.signature() !== this.context) throw new Error('项目、账号、作业或对象已变化，请重新打开当前操作；已保存资料保留。'); }
  private snapshot() { const snapshot = this.options.getSnapshot(); if (!snapshot) throw new Error('请先登录并读取当前项目。'); return snapshot; }
  private object() { const ref = this.options.getObject(); const record = ref && fieldObjectRecord(this.snapshot(), ref); if (!ref || !record) throw new Error('请先点击当前授权范围内的机械、防护人员或资料位置。'); return { ref, record }; }
  private task() { const id = this.options.getTaskId(); const task = this.snapshot().collections.tasks.find(r => r.id === id); if (!task) throw new Error('请先在顶部明确选择今日作业，检查与问题将关联该作业。'); return task; }
  private permitted(permission: 'files' | 'field' | 'resource' | 'document' | 'models') { const p = this.options.getSnapshot()?.session.permissions || []; return p.includes(permission) || permission === 'document' && p.includes('field'); }
  private repaint() { const s = this.options.getSnapshot(); if (s) this.options.onSaved(s); }
  private async commit(type: ManagementCommandType, payload: Record<string, unknown>, id?: string, revision?: number, key: string = crypto.randomUUID()) {
    this.current(); const snapshot = await this.options.command(type, payload, id, revision, key); this.current(); this.options.onSaved(snapshot); return snapshot;
  }
  private show(title: string, body: string, footer = '') {
    if (this.dialog.open && !this.close()) return false;
    this.context = this.signature(); this.dirty = false;
    this.dialog.innerHTML = `<header><div><h2>${e(title)}</h2><p>当前项目 · ${e(this.options.getSnapshot()?.projects.find(p => p.id === this.options.getSnapshot()?.projectId)?.name || '')}</p></div>${b('close', '×', 'aria-label="关闭窗口"', 'rf-close')}</header><div class="rf-dialog-body">${body}</div><footer><span class="rf-feedback" role="status"></span>${footer || b('close', '关闭')}</footer>`;
    this.dialog.showModal(); return true;
  }
  private error(message: string) { const output = this.dialog.querySelector('.rf-feedback'); if (output) output.textContent = message; }
  private buttonBusy(button: HTMLButtonElement, busy: boolean) { this.busy = busy; button.disabled = busy; button.dataset.busy = String(busy); this.dialog.querySelectorAll('form').forEach(form => { form.inert = busy; }); }
  renderObject(): string {
    const s = this.options.getSnapshot(), ref = this.options.getObject(), r = s && ref && fieldObjectRecord(s, ref);
    if (!s || !ref || !r) return '<div class="rf-empty">点击三维机械或防护人员，查看资料、开展检查和记录问题。</div>';
    const key = `${s.projectId}:${s.session.userId}:${ref.kind}:${ref.id}`;
    if (this.lastObject !== key) { this.lastObject = key; this.tab = 'documents'; }
    const guard = ref.kind === 'railSafety' && (r.definition as { kind?: string })?.kind === 'guard';
    const profile = r.personnel as GuardPersonnel | undefined;
    const taskId = this.options.getTaskId(), docs = fieldObjectDocuments(s, ref), evidence = fieldObjectEvidence(s, ref, taskId), checks = taskId ? fieldObjectChecks(s, ref, taskId) : [];
    const issues = fieldObjectIssues(s, ref, taskId);
    const guardSummary = guard ? `<div class="rf-person"><span class="rf-kicker">防护人员档案</span><h2>${e(profile?.name || r.name)}</h2><p>${e(profile?.role || '岗位待补充')} · ${e(profile?.unit || '单位待补充')}</p><span class="rf-chip">${profile?.certificateEvidenceIds?.length ? '证书已关联 · 待核验' : '待关联培训合格证书'}</span></div>` : '';
    let body = '';
    if (this.tab === 'documents') body = `${guard ? `<div class="rf-note"><strong>营业线培训合格证书</strong><p>证书原件与个人信息关联保存；人物模型表示计划岗位，到岗事实通过当日检查记录。</p><div class="rf-actions">${b('certificate', '查看证书')}${b('upload-certificate', '上传证书', this.permitted('files') && this.permitted('resource') && this.permitted('models') && this.permitted('document') ? '' : 'disabled')}${b('profile', '编辑个人信息', this.permitted('files') && this.permitted('resource') && this.permitted('models') ? '' : 'disabled')}</div></div>` : ''}<div class="rf-section-title"><strong>关联资料 · ${docs.length}</strong>${b('upload', '上传资料', this.permitted('files') && this.permitted('document') ? '' : 'disabled')}</div>${docs.map(doc => this.documentRow(doc)).join('') || '<p class="rf-empty">尚未关联文件。已有 PDF / Word 可直接上传，不必重新填写。</p>'}${evidence.length ? `<details class="rf-evidence-list"><summary>关联原件与证据 · ${evidence.length}</summary>${evidence.map(file => this.evidenceRow(file)).join('')}</details>` : ''}<div class="rf-actions">${b('link', '关联已有资料', s.session.permissions.includes('document') && this.permitted('files') && this.permitted('models') ? '' : 'disabled')}${b('record', '同步记录预览', taskId ? '' : 'disabled title="请先选择今日作业"')}</div>`;
    if (this.tab === 'checks') body = `<p class="rf-note">${taskId ? '仅显示当前对象、当前作业的检查记录。新清单初始全部为待检查，逐项填写实际结论。' : '请在顶部选择今日作业，再开展检查。'}</p>${checks.map(check => `<div class="rf-card"><strong>${e(check.name)}</strong><small>${e(check.businessDate)} · ${check.status === 'confirmed' ? '已确认，保留原记录' : '待填写 / 确认'}</small><p>${this.checkSummary(check)}</p><div class="rf-actions">${check.status === 'draft' ? b('check-edit', '填写检查结果', `data-id="${e(check.id)}" ${this.permitted('field') ? '' : 'disabled'}`) : ''}${b('detail-check', '查看记录 / 签认', `data-id="${e(check.id)}"`)}</div></div>`).join('') || '<p class="rf-empty">尚无对应检查清单。</p>'}<div class="rf-actions">${b('check-new', '建立检查清单', taskId && this.permitted('field') ? '' : 'disabled')}${b('issue', '记录问题', taskId && this.permitted('field') ? '' : 'disabled')}${b('record', '预览同步记录', taskId ? '' : 'disabled')}</div>${issues.length ? `<div class="rf-section-title">当前对象的问题</div>${issues.map(issue => `<div class="rf-card"><strong>${e(issue.name)}</strong><small>${e(issue.status)} · ${e(issue.updatedAt?.slice(0, 10))}</small>${b('detail-issue', '查看与办理整改', `data-id="${e(issue.id)}"`)}</div>`).join('')}` : ''}`;
    if (this.tab === 'information') body = guard ? `<dl class="rf-facts">${Object.entries({ '姓名': profile?.name || r.name, '所属单位': profile?.unit, '岗位': profile?.role, '联系电话': profile?.phone, '培训合格证书编号': profile?.certificateNumber, '培训 / 发证单位': profile?.trainingOrganization, '培训合格日期': profile?.trainingDate, '证书载明有效期': profile?.validUntil }).map(([k, v]) => `<div><dt>${k}</dt><dd>${e(v || '待补充 / 未载明')}</dd></div>`).join('')}</dl><div class="rf-actions">${b('profile', '编辑人员档案', this.permitted('files') && this.permitted('resource') && this.permitted('models') ? '' : 'disabled')}${b('edit-object', '调整岗位与工作区域')}</div><p class="rf-note">未接入人员定位。证书是否符合本次作业要求及人员到岗情况需分别核验。</p>` : `<dl class="rf-facts"><div><dt>对象编号</dt><dd>${e(r.id)}</dd></div><div><dt>记录修订</dt><dd>${r.revision}</dd></div><div><dt>更新时间</dt><dd>${e(r.updatedAt)}</dd></div></dl><div class="rf-actions">${b('edit-object', '编辑模型与布置')}${b('locate', '定位当前对象')}</div><p class="rf-note">模型调整不会改写既有检查和问题记录中的对象快照。</p>`;
    return `<section class="rf-object">${guardSummary}<div class="rf-primary-actions">${b('checks', '开始检查', taskId ? '' : 'title="先选择今日作业"', 'primary')}${b('upload', '上传资料', this.permitted('files') && this.permitted('document') ? '' : 'disabled')}</div><div class="rf-tabs">${([['documents', '资料'], ['checks', '检查'], ['information', '信息']] as const).map(([id, label]) => b('tab', label, `data-tab="${id}" aria-selected="${this.tab === id}"`, this.tab === id ? 'active' : '')).join('')}</div>${body}</section>`;
  }
  private checkSummary(record: ManagementRecord) { const items = (record.items || []) as ManagementCheckItem[]; return `已记录 ${items.filter(i => i.result !== 'pending').length} / ${items.length} 项 · 存在问题 ${items.filter(i => i.result === 'fail').length} 项`; }
  private documentVersions(id: string) { const snapshot = this.snapshot(), ref = this.options.getObject(); return (ref ? fieldObjectDocumentVersions(snapshot, ref) : snapshot.collections.documentVersions).filter(v => v.documentId === id).sort((a, b) => Number(b.version) - Number(a.version)); }
  private documentRow(doc: ManagementRecord) {
    const versions = this.documentVersions(doc.id);
    const latest = versions[0]; return `<div class="rf-file"><span class="rf-file-icon">资料</span><div><strong>${e(doc.name)}</strong><small>${e(doc.category)} · ${latest ? `V${e(latest.version)} · ${latest.status === 'published' ? '已发布版' : '未发布版'}` : '等待上传原件'}</small></div>${b('document', '查看', `data-id="${e(doc.id)}"`)}</div>`;
  }
  private evidenceRow(file: ManagementRecord) { return `<div class="rf-file"><span class="rf-file-icon">${e(str(file.originalName || file.name).split('.').pop()?.toUpperCase().slice(0, 4))}</span><div><strong>${e(file.name)}</strong><small>${e(file.createdAt?.slice(0, 10))} · 原件</small></div>${b('evidence', '打开', `data-id="${e(file.id)}"`)}</div>`; }
  renderConditions(): string {
    const s = this.options.getSnapshot(), taskId = this.options.getTaskId(), task = s?.collections.tasks.find(t => t.id === taskId);
    if (!s || !task) return '<div class="rf-empty"><h3>选择今日作业</h3><p>在顶部选择既有作业，或导入 Excel 施工计划、安全监督计划，再查看关联条件与材料。</p></div>';
    const source = task.railwayPlan as { number?: string; kind?: string; unmatchedResources?: string[] } | undefined;
    const ids = new Set(strings(task.resourceIds)), machines = s.collections.resources.filter(r => ids.has(r.id) && (r.kind === 'equipment' || r.machinery));
    const checks = s.collections.checks.filter(c => c.taskId === task.id), issues = s.collections.issues.filter(i => i.taskId === task.id && !['closed', 'false-positive', 'duplicate'].includes(i.status));
    return `<section class="rf-conditions"><span class="rf-kicker">今日作业</span><h2>${e(task.name)}</h2><p>${e(source?.number || task.permitReference || '未关联正式计划号')}<br>${e(task.workWindowStart || task.planStart || '日期待核实')} — ${e(task.workWindowEnd || task.planEnd || '')}</p><div class="rf-counts"><div><b>${machines.length}</b><small>关联机械</small></div><div><b>${checks.length}</b><small>检查记录</small></div><div><b>${issues.length}</b><small>未闭问题</small></div></div><div class="rf-note">${source ? 'Excel 原表已关联，正式计划有效性仍待核验。' : '当前作业卡尚未登记 Excel 正式计划来源。'}文件关联、检查记录与正式手续分别核对。</div>${source?.unmatchedResources?.length ? `<p class="rf-warning">待关联机械编号：${source.unmatchedResources.map(e).join('、')}</p>` : ''}<div class="rf-card"><strong>计划与责任</strong><p>${e(task.railwayLine || '线路待补充')} · ${e(task.railwayMileage || '里程待补充')}</p>${b('task', '打开作业资料')}</div><div class="rf-card"><strong>现场检查</strong><p>${checks.length ? `${checks.filter(c => c.status === 'confirmed').length}份已确认，${checks.filter(c => c.status !== 'confirmed').length}份待填写 / 确认` : '尚无当日检查记录'}</p>${b('record', '查看同步记录')}</div><div class="rf-note">无几何交叉、资料上传成功或问题关闭均不代表取得施工许可。签认与正式手续沿用现有业务权限。</div></section>`;
  }
  openUpload(category = '其他资料'): void {
    const s = this.snapshot(), ref = this.options.getObject(), r = ref && fieldObjectRecord(s, ref), taskId = this.options.getTaskId();
    if (!this.permitted('files') || !this.permitted('document')) throw new Error('当前账号没有文件上传或资料登记权限。');
    const refs: FieldObjectReference[] = [...s.collections.resources.filter(x => x.kind === 'equipment' || x.machinery).map(x => ({ kind: 'resources' as const, id: x.id })), ...s.collections.railSafety.filter(x => x.status === 'active').map(x => ({ kind: 'railSafety' as const, id: x.id })), ...s.collections.anchors.filter(x => !x.deletedAt).map(x => ({ kind: 'anchors' as const, id: x.id }))];
    const related = ref ? fieldObjectDocuments(s, ref) : s.collections.documents;
    if (!this.show('上传已有资料', `<form data-rf-upload-form><div class="rf-note">${r ? '当前对象：' + e(r.name) : '项目资料'}${taskId ? ' · 作业：' + e(s.collections.tasks.find(t => t.id === taskId)?.name) : ''}。原文件保存到项目后端，不覆盖既有版本。</div><div class="rf-form-grid"><label>资料类别<select name="category">${categories.map(c => `<option ${c === category ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label>作为新资料或新增版本<select name="documentId"><option value="">新建资料</option>${related.map(doc => `<option value="${e(doc.id)}">${e(doc.name)} · 新增版本</option>`).join('')}</select></label></div><label class="rf-drop"><strong>选择 PDF / Word 文件，可多选</strong><small>安全协议仅 PDF；培训证书可 PDF / 图片；计划表从顶部 Excel 导入入口办理。</small><input type="file" name="files" multiple accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"></label><div data-rf-upload-list></div><label>版本说明<input name="note" value="上传已有资料" required maxlength="1000"></label><fieldset><legend>关联对象（同一原件可多处引用）</legend><div class="rf-object-choices">${refs.map(x => `<label><input type="checkbox" name="object" value="${e(x.kind + '|' + x.id)}" ${ref?.kind === x.kind && ref.id === x.id ? 'checked' : ''}>${e(fieldObjectRecord(s, x)?.name || x.id)}</label>`).join('') || '<small>尚无现场对象，可先保存为项目资料。</small>'}</div></fieldset></form>`, b('close', '取消') + '<button type="submit" data-rf-save-upload class="primary">保存原件与关联</button>')) return;
    const form = this.dialog.querySelector<HTMLFormElement>('form')!, input = form.elements.namedItem('files') as HTMLInputElement;
    let items: UploadItem[] = [], frozen: { category: string; refs: FieldObjectReference[]; note: string; documentId: string } | undefined;
    const paint = () => { this.dialog.querySelector('[data-rf-upload-list]')!.innerHTML = items.map(item => `<div class="rf-upload-item"><span>${e(item.file.name)}</span><small>${item.saved ? '已保存' : item.error ? e(item.error) : `${(item.file.size / 1048576).toFixed(2)} MB · 待保存`}</small></div>`).join(''); };
    const choose = (files: File[]) => { if (frozen) return; items = files.map(file => ({ file, documentId: 'document:' + crypto.randomUUID(), versionId: 'document-version:' + crypto.randomUUID(), createKey: crypto.randomUUID(), versionKey: crypto.randomUUID(), created: false, saved: false })); this.dirty = true; paint(); };
    input.onchange = () => choose([...input.files || []]);
    const drop = this.dialog.querySelector<HTMLElement>('.rf-drop')!;
    drop.ondragover = ev => { ev.preventDefault(); drop.classList.add('drag'); }; drop.ondragleave = () => drop.classList.remove('drag'); drop.ondrop = ev => { ev.preventDefault(); drop.classList.remove('drag'); choose([...ev.dataTransfer?.files || []]); };
    const button = this.dialog.querySelector<HTMLButtonElement>('[data-rf-save-upload]')!;
    button.onclick = async () => {
      if (!form.reportValidity() || !items.length) { if (!items.length) this.error('请先选择文件。'); return; }
      try {
        this.current(); const data = new FormData(form), cat = String(data.get('category'));
        if (!frozen) {
          const refs = data.getAll('object').map(v => { const [kind, ...id] = String(v).split('|'); return { kind, id: id.join('|') } as FieldObjectReference; });
          const documentId = String(data.get('documentId') || '');
          if (documentId && items.length !== 1) throw new Error('给现有资料增加版本时，请每次选择一个文件。');
          const accept = cat === '安全协议' ? /\.pdf$/i : cat === '人员证书' ? /\.(pdf|png|jpe?g)$/i : /\.(pdf|docx?)$/i;
          if (items.some(item => !accept.test(item.file.name))) throw new Error('文件格式与资料类别不符。协议为 PDF；其他资料为 PDF/Word，人员证书可使用图片。');
          frozen = { category: cat, refs, note: String(data.get('note')), documentId };
          form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(el => { el.disabled = true; });
        }
        this.buttonBusy(button, true); this.error('正在保存，成功项不会重复提交。');
        for (const item of items) {
          if (item.saved) continue;
          item.error = undefined;
          try {
            if (!item.evidence) { item.evidence = await this.options.upload(item.file, { taskId, objectRefs: frozen.refs, workflowCategory: frozen.category === '安全协议' ? 'agreement' : frozen.category === '人员证书' ? 'personnel-certificate' : 'other' }); this.current(); }
            const documentId = frozen.documentId || item.documentId;
            if (!frozen.documentId && !item.created) { await this.commit('document.create', { name: item.file.name, category: frozen.category, taskIds: taskId ? [taskId] : [], objectRefs: frozen.refs, workflowCategory: frozen.category === '安全协议' ? 'agreement' : frozen.category === '人员证书' ? 'personnel-certificate' : 'other' }, documentId, undefined, item.createKey); item.created = true; }
            await this.commit('document.version', { documentId, evidenceId: item.evidence.id, revisionNote: frozen.note, taskIds: taskId ? [taskId] : [], objectRefs: frozen.refs }, item.versionId, undefined, item.versionKey);
            if (frozen.category === '人员证书') for (const target of frozen.refs.filter(x => x.kind === 'railSafety')) {
              const guard = fieldObjectRecord(this.snapshot(), target); if (!guard || (guard.definition as { kind?: string })?.kind !== 'guard') continue;
              const personnel = guard.personnel as GuardPersonnel | undefined;
              if (!personnel?.certificateEvidenceIds.includes(item.evidence.id)) await this.commit('railSafety.personnel', { personnel: { ...personnelInput(personnel, guard.name), certificateEvidenceIds: [...(personnel?.certificateEvidenceIds || []), item.evidence.id] } }, guard.id, guard.revision);
            }
            item.saved = true;
          } catch (error) { item.error = error instanceof Error ? error.message : String(error); paint(); throw error; }
          paint();
        }
        this.busy = false; this.dirty = false; this.finish(); this.repaint(); this.options.toast(`已保存 ${items.length} 份原件及关联，资料版本保持待核验状态。`);
      } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
      finally { this.buttonBusy(button, false); }
    };
  }
  private editProfile() {
    const { ref, record } = this.object(); if (ref.kind !== 'railSafety' || (record.definition as { kind?: string })?.kind !== 'guard') throw new Error('请先选择防护人员。');
    const profile = record.personnel as GuardPersonnel | undefined;
    const fields: Array<[keyof GuardPersonnel, string, string]> = [['name', '姓名', 'text'], ['unit', '所属单位', 'text'], ['role', '岗位', 'text'], ['phone', '联系电话', 'tel'], ['certificateNumber', '营业线培训合格证书编号', 'text'], ['trainingOrganization', '培训 / 发证单位', 'text'], ['trainingDate', '培训合格日期', 'date'], ['validUntil', '证书载明有效期（未载明可留空）', 'date']];
    if (!this.show('防护人员信息与培训证书', `<form data-rf-profile><div class="rf-form-grid">${fields.map(([key, label, type]) => `<label>${label}<input name="${key}" type="${type}" value="${e(profile?.[key] || (key === 'name' ? record.name : ''))}" ${key === 'name' ? 'required' : ''}></label>`).join('')}</div><div class="rf-note">已关联 ${profile?.certificateEvidenceIds.length || 0} 份证书原件。上传和填写不代表完成资格核验。到岗情况通过当日检查记录，不写入长期人员档案。</div></form>`, b('close', '取消') + '<button type="button" data-rf-profile-save class="primary">保存人员档案</button>')) return;
    const form = this.dialog.querySelector<HTMLFormElement>('form')!, button = this.dialog.querySelector<HTMLButtonElement>('[data-rf-profile-save]')!;
    const key = crypto.randomUUID(); button.onclick = async () => { if (!form.reportValidity()) return; this.buttonBusy(button, true); try { await this.commit('railSafety.personnel', { personnel: { ...Object.fromEntries(new FormData(form)), certificateEvidenceIds: profile?.certificateEvidenceIds || [] } }, record.id, record.revision, key); this.dirty = false; this.busy = false; this.finish(); this.options.toast('人员档案已保存，三维人物名称同步更新。'); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); } finally { this.buttonBusy(button, false); } };
  }
  private newCheck() {
    const { ref, record } = this.object(), task = this.task();
    if (!this.show('建立对象检查清单', `<form data-rf-check-new><div class="rf-note">${e(task.name)} · ${e(record.name)}。请依据本项目适用的已确认清单填写项点，系统不自动生成“合格”结论。</div><label>清单名称<input name="name" value="${e(record.name)}现场检查" required maxlength="200"></label><div class="rf-form-grid"><label>检查日期<input type="date" name="businessDate" value="${day()}" required></label><label>模板版本<input type="number" name="templateVersion" value="1" min="1" step="1" required></label></div><label>检查项点（每行一项）<textarea name="items" rows="7" required placeholder="粘贴本项目适用的检查项点，每行一项"></textarea></label><label class="rf-inline"><input type="checkbox" name="allowNotApplicable">清单允许填写“与当日作业无关”（填写时必须说明依据）</label></form>`, b('close', '取消') + '<button type="button" data-rf-check-create class="primary">保存清单，逐项检查</button>')) return;
    const form = this.dialog.querySelector<HTMLFormElement>('form')!, button = this.dialog.querySelector<HTMLButtonElement>('[data-rf-check-create]')!;
    const id = 'check:' + crypto.randomUUID(), key = crypto.randomUUID(); let prepared: Record<string, unknown> | undefined;
    button.onclick = async () => { if (!form.reportValidity()) return; this.buttonBusy(button, true); try { if (!prepared) { const data = new FormData(form), names = String(data.get('items')).split(/\r?\n/).map(v => v.trim()).filter(Boolean); if (!names.length || names.length > 100) throw new Error('请填写1—100条检查项点。'); prepared = { name: data.get('name'), taskId: task.id, objectRef: ref, businessDate: data.get('businessDate'), templateVersion: Number(data.get('templateVersion')), purpose: 'safety', inspectionObjectId: ref.id, items: names.map(name => ({ id: crypto.randomUUID(), name, required: true, allowNotApplicable: data.get('allowNotApplicable') === 'on' })) }; form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea').forEach(el => { el.disabled = true; }); } const snapshot = await this.commit('check.create', prepared, id, undefined, key); this.busy = false; this.dirty = false; this.finish(); const check = snapshot.collections.checks.find(r => r.id === id); if (check) this.editCheck(check); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); } finally { this.buttonBusy(button, false); } };
  }
  private editCheck(record: ManagementRecord) {
    const items = record.items as ManagementCheckItem[], ref = this.options.getObject(), taskId = this.options.getTaskId();
    const evidence = ref ? fieldObjectEvidence(this.snapshot(), ref, taskId) : [];
    if (!this.show(record.name, `<form data-rf-check-results><div class="rf-note">逐项记录现场事实。已签认的记录不在此修改；当前清单版本 ${e(record.templateVersion || 1)}。已有但不在当前候选列表中的证据引用会保留。</div>${items.map((item, i) => `<fieldset><legend>${i + 1}. ${e(item.name)}</legend><label>检查结果<select name="result-${i}">${['pending', 'pass', 'fail', ...(item.allowNotApplicable ? ['not-applicable'] : [])].map(value => `<option value="${value}" ${item.result === value ? 'selected' : ''}>${resultLabels[value]}</option>`).join('')}</select></label><label>现场情况 / 判断依据<textarea name="basis-${i}" rows="2">${e(item.basis || '')}</textarea></label>${evidence.length ? `<label>关联证据（可多选）<select multiple name="evidence-${i}">${evidence.map(file => `<option value="${e(file.id)}" ${item.evidenceIds?.includes(file.id) ? 'selected' : ''}>${e(file.name)}</option>`).join('')}</select></label>` : ''}</fieldset>`).join('')}</form>`, b('close', '取消') + '<button type="button" data-rf-check-save class="primary">保存结果并同步记录</button>')) return;
    const form = this.dialog.querySelector<HTMLFormElement>('form')!, button = this.dialog.querySelector<HTMLButtonElement>('[data-rf-check-save]')!;
    button.onclick = async () => { if (!form.reportValidity()) return; this.buttonBusy(button, true); try { const data = new FormData(form); const results = items.map((item, i) => ({ id: item.id, result: data.get(`result-${i}`), basis: data.get(`basis-${i}`), evidenceIds: evidence.length ? [...new Set([...data.getAll(`evidence-${i}`).map(String), ...(item.evidenceIds || []).filter(id => !evidence.some(file => file.id === id))])] : item.evidenceIds || [] })); const snapshot = await this.commit('check.record', { checklistVersion: record.checklistVersion, items: results }, record.id, record.revision); const saved = snapshot.collections.checks.find(r => r.id === record.id); this.busy = false; this.dirty = false; this.finish(); this.tab = 'checks'; this.repaint(); this.options.toast(saved && (saved.items as ManagementCheckItem[]).some(i => i.result === 'fail') ? '结果已保存。存在问题项请继续记录问题，填写责任与处置要求。' : '检查结果已保存，同步记录已更新。'); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); } finally { this.buttonBusy(button, false); } };
  }
  private newIssue() {
    const { ref, record } = this.object(), task = this.task(), evidence = fieldObjectEvidence(this.snapshot(), ref, task.id);
    if (!this.show('记录对象现场问题', `<form data-rf-issue><div class="rf-note">自动关联：${e(task.name)} · ${e(record.name)}。保存发现时的对象修订，后续模型变化不会覆盖。</div><label>现场发现与处理要求<textarea name="name" required maxlength="1000" rows="5" placeholder="填写实际发现、位置及需要核对或整改的事项"></textarea></label><label>关联证据<select name="evidenceIds" multiple>${evidence.map(file => `<option value="${e(file.id)}">${e(file.name)}</option>`).join('')}</select><small>已有证据仅引用一次；可使用现场视频取证，或在问题详情中补充已有证据。</small></label></form>`, b('close', '取消') + '<button type="button" data-rf-issue-save class="primary">保存发现，进入核查处置</button>')) return;
    const form = this.dialog.querySelector<HTMLFormElement>('form')!, button = this.dialog.querySelector<HTMLButtonElement>('[data-rf-issue-save]')!;
    const id = 'issue:' + crypto.randomUUID(), key = crypto.randomUUID(); button.onclick = async () => { if (!form.reportValidity()) return; this.buttonBusy(button, true); try { const data = new FormData(form); await this.commit('issue.create', { name: data.get('name'), kind: 'safety', taskId: task.id, objectRef: ref, evidenceIds: data.getAll('evidenceIds') }, id, undefined, key); this.busy = false; this.dirty = false; this.finish(); this.options.showRecord('issues', id); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); } finally { this.buttonBusy(button, false); } };
  }
  private linkDocument() {
    const { ref, record } = this.object(), docs = this.snapshot().collections.documents;
    if (!this.show('关联已有资料', `<form data-rf-link><div class="rf-note">对象：${e(record.name)}。引用已有原件，不重复上传。</div><label>选择资料<select name="documentId" required><option value="">请选择</option>${docs.map(doc => `<option value="${e(doc.id)}">${e(doc.name)}</option>`).join('')}</select></label></form>`, b('close', '取消') + '<button type="button" data-rf-link-save class="primary">保存关联</button>')) return;
    const form = this.dialog.querySelector<HTMLFormElement>('form')!, button = this.dialog.querySelector<HTMLButtonElement>('[data-rf-link-save]')!;
    const id = 'link:' + crypto.randomUUID(), key = crypto.randomUUID();
    button.onclick = async () => { if (!form.reportValidity()) return; this.buttonBusy(button, true); try { const data = new FormData(form); await this.commit('link.create', { sourceKind: ref.kind, sourceId: ref.id, targetKind: 'documents', targetId: data.get('documentId'), taskId: this.options.getTaskId() }, id, undefined, key); this.busy = false; this.dirty = false; this.finish(); this.options.toast('原资料已关联到当前对象。'); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); } finally { this.buttonBusy(button, false); } };
  }
  private openEvidence(id: string) {
    const s = this.snapshot(), record = s.collections.evidence.find(r => r.id === id); if (!record) throw new Error('原件不存在或无查看权限。');
    const url = `${MANAGEMENT_API}/files/${encodeURIComponent(id)}/original?projectId=${encodeURIComponent(s.projectId)}`, mime = str(record.mime);
    this.show(record.name, `<p class="rf-note">原始上传文件 · ${e(record.createdAt)}。签章、培训资格或内容有效性需另行核验。</p>${mime === 'application/pdf' ? `<iframe class="rf-preview" src="${e(url)}" title="${e(record.name)}"></iframe>` : mime.startsWith('image/') ? `<img class="rf-preview-image" src="${e(url)}" alt="${e(record.name)}">` : '<p class="rf-empty">此类型保留原件，请下载后使用原软件查看。</p>'}`, `<a class="rf-download" href="${e(url)}" target="_blank" rel="noopener">打开 / 下载原件</a>` + b('close', '关闭'));
  }
  openRecord() {
    const task = this.task(), snapshot = structuredClone(this.snapshot()), html = fieldRecordHtml(snapshot, task.id, this.options.getObject());
    if (!this.show('现场检查与监护 · 同步草稿', `<div class="rf-note">本预览固定打开时的数据。检查确认与正式签认分别办理，原始签字文件可上传关联。</div>${html}`, b('print', '打印 / 另存 PDF', '', 'primary'))) return;
    const print = this.dialog.querySelector<HTMLButtonElement>('[data-rf-action="print"]')!;
    print.onclick = () => { const w = window.open('', '_blank'); if (!w) { this.options.toast('请允许打开打印窗口。'); return; } w.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${e(task.name)}_现场记录草稿</title><style>body{font:12px/1.8 "Microsoft YaHei",sans-serif;padding:25px;color:#26343d}h1,h2{text-align:center;font-size:19px}h3{font-size:14px}table{width:100%;border-collapse:collapse;margin:15px 0}td,th{border:1px solid #bbb;padding:7px;text-align:left;font-size:11px}small{color:#777}.rf-note{color:#666}section{break-inside:avoid} @media print{body{padding:0}}</style></head><body>${html}</body></html>`); w.document.close(); let printed = false; const once = () => { if (!printed && !w.closed) { printed = true; w.print(); } }; w.addEventListener('load', once, { once: true }); window.setTimeout(once, 500); };
  }
  private async action(el: HTMLElement) {
    const action = el.dataset.rfAction, id = el.dataset.id;
    if (action === 'close') { this.close(); return; }
    if (action === 'print') return;
    if (action === 'tab') { this.tab = el.dataset.tab as typeof this.tab; this.repaint(); }
    else if (action === 'checks') { this.tab = 'checks'; this.repaint(); }
    else if (action === 'upload') this.openUpload();
    else if (action === 'upload-certificate') this.openUpload('人员证书');
    else if (action === 'profile') this.editProfile();
    else if (action === 'certificate') { const { record } = this.object(), ids = (record.personnel as GuardPersonnel | undefined)?.certificateEvidenceIds || []; if (ids.length) this.openEvidence(ids[0]); else this.options.toast('当前人员尚未关联培训合格证书，请由有资料登记权限的人员上传。'); }
    else if (action === 'evidence' && id) this.openEvidence(id);
    else if (action === 'document' && id) {
      const versions = this.documentVersions(id);
      this.show('资料版本与原件', `<p class="rf-note">上传版本与有效发布状态分别管理。历史版本保留。</p>${versions.map(v => `<div class="rf-card"><strong>V${e(v.version)} · ${v.status === 'published' ? '已发布' : '待审 / 历史版本'}</strong><p>${e(v.revisionNote)} · ${e(v.createdAt?.slice(0, 10))}</p>${b('evidence', '打开原件', `data-id="${e(v.evidenceId)}"`)}${b('document-detail', '查看版本办理', `data-id="${e(v.id)}"`)}</div>`).join('') || '<p class="rf-empty">尚无上传版本。</p>'}`);
    }
    else if (action === 'document-detail' && id) { if (this.close()) this.options.showRecord('documentVersions', id); }
    else if (action === 'detail-check' && id) this.options.showRecord('checks', id);
    else if (action === 'detail-issue' && id) this.options.showRecord('issues', id);
    else if (action === 'check-new') this.newCheck();
    else if (action === 'check-edit' && id) { const r = this.snapshot().collections.checks.find(r => r.id === id); if (r?.status === 'draft') this.editCheck(r); }
    else if (action === 'issue') this.newIssue();
    else if (action === 'link') this.linkDocument();
    else if (action === 'record') this.openRecord();
    else if (action === 'task') this.options.showRecord('tasks', this.task().id);
    else if (action === 'edit-object') this.options.editObject(this.object().ref);
    else if (action === 'locate') this.options.locateObject(this.object().ref);
  }
}
