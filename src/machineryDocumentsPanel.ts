import { MACHINERY_DOCUMENT_CATEGORIES, MachineryDocumentSession, machineryDocumentUrl, type MachineryDocumentCategory, type MachineryDocumentContext } from './machineryDocuments';
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
export class MachineryDocumentsPanel {
  private readonly root = element('section', 'rs-documents');
  private readonly session: MachineryDocumentSession;
  private readonly events = new AbortController();
  private category: MachineryDocumentCategory = 'performance';
  private deletingId = '';
  private scope = '';
  constructor(host: HTMLElement, onBusyChange?: () => void) {
    this.root.setAttribute('aria-label', '机械资料档案'); host.append(this.root);
    this.session = new MachineryDocumentSession(() => { this.render(); onBusyChange?.(); });
    this.root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-document-action]');
      if (!button || button.disabled) return;
      event.stopPropagation();
      const action = button.dataset.documentAction;
      if (action === 'category') { this.category = button.dataset.category as MachineryDocumentCategory; this.deletingId = ''; this.render(); }
      if (action === 'refresh') { this.session.message = ''; this.session.error = false; void this.session.refresh(); }
      if (action === 'retry-delete') void this.session.remove(button.dataset.id || '');
      if (action === 'delete') { this.deletingId = button.dataset.id || ''; this.render(); }
      if (action === 'keep') { this.deletingId = ''; this.render(); }
      if (action === 'confirm-delete') { const id = this.deletingId; this.deletingId = ''; void this.session.remove(id); }
    }, { signal: this.events.signal });
    this.root.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      if (input.type !== 'file') return;
      const files = [...(input.files || [])]; input.value = ''; void this.session.upload(files, this.category);
    }, { signal: this.events.signal });
    this.render();
  }
  get isBusy() { return this.session.busy; }
  setContext(context: MachineryDocumentContext) {
    const scope = JSON.stringify([context.projectId, context.actorId, context.resourceId]);
    if (scope !== this.scope) { this.scope = scope; this.deletingId = ''; this.category = 'performance'; }
    this.session.setContext(context);
  }
  dispose() { this.session.dispose(); this.events.abort(); this.root.remove(); }
  private button(action: string, text: string) { const button = element('button', '', text); button.type = 'button'; button.dataset.documentAction = action; return button; }
  private render() {
    const session = this.session, context = session.context; this.root.replaceChildren();
    if (!context.resourceId) { this.root.append(element('p', 'rs-empty', '选择一台机械后上传或查看其资料。')); return; }
    const heading = element('div', 'rs-documents-heading'); heading.append(element('strong', '', context.resourceName || '当前机械'));
    const refresh = this.button('refresh', '刷新'); refresh.disabled = session.loading || session.busy || !context.canView; heading.append(refresh); this.root.append(heading);
    if (!context.canView) { this.root.append(element('p', 'rs-empty', '当前账号没有机械资料查看权限。')); return; }
    const nav = element('nav', 'rs-document-tabs'); nav.setAttribute('aria-label', '机械资料分类');
    for (const [category, name] of Object.entries(MACHINERY_DOCUMENT_CATEGORIES)) {
      const count = session.records.filter(record => record.machineryDocumentCategory === category).length;
      const button = this.button('category', `${name} ${count}`); button.dataset.category = category; button.classList.toggle('is-active', this.category === category); button.setAttribute('aria-pressed', String(this.category === category)); button.disabled = session.busy; nav.append(button);
    }
    this.root.append(nav);
    const upload = element('label', 'rs-document-upload'); upload.append(element('span', '', `上传${MACHINERY_DOCUMENT_CATEGORIES[this.category]}`));
    const input = element('input'); input.type = 'file'; input.multiple = true; input.disabled = !context.canEdit || session.busy; input.setAttribute('aria-label', `上传${MACHINERY_DOCUMENT_CATEGORIES[this.category]}`); upload.append(input);
    this.root.append(upload, element('p', 'rs-help', context.canEdit ? '可上传 PDF、图片、Word、Excel 等资料，单个文件不超过 100 MB。上传后自动保存到当前机械。' : '当前账号可查看资料，无上传与删除权限。'));
    const records = session.records.filter(record => record.machineryDocumentCategory === this.category), list = element('div', 'rs-document-list');
    if (session.loading && !records.length) list.append(element('p', 'rs-help', '正在读取机械资料…'));
    else if (!records.length) list.append(element('p', 'rs-empty', `尚未上传${MACHINERY_DOCUMENT_CATEGORIES[this.category]}。`));
    for (const record of records) {
      const card = element('article', 'rs-document-card'); card.append(element('strong', '', record.name));
      card.append(element('p', 'rs-help', `${Number.isFinite(Number(record.size)) ? (Number(record.size) / 1024 / 1024).toFixed(2) + ' MB · ' : ''}${record.createdAt.slice(0, 10)}`));
      const actions = element('div', 'rs-actions'), url = machineryDocumentUrl(record, context.projectId);
      const previewable = record.mime === 'application/pdf' || /^image\/(png|jpeg|gif|webp|bmp)$/.test(String(record.mime));
      if (previewable) { const preview = element('a', '', '预览'); preview.href = url; preview.target = '_blank'; preview.rel = 'noopener noreferrer'; actions.append(preview); }
      const download = element('a', '', '下载'); download.href = url; download.download = record.name; actions.append(download);
      if (context.canEdit) { const remove = this.button('delete', '删除'); remove.dataset.id = record.id; remove.disabled = session.busy; actions.append(remove); }
      card.append(actions);
      if (this.deletingId === record.id) {
        const confirm = element('div', 'rs-document-confirm'); confirm.append(element('p', '', '删除此资料及平台本地存储文件？'));
        const yes = this.button('confirm-delete', '确认删除'), no = this.button('keep', '取消'); yes.disabled = no.disabled = session.busy; confirm.append(yes, no); card.append(confirm);
      }
      list.append(card);
    }
    this.root.append(list);
    for (const record of session.pendingDeletions) {
      const pending = element('div', 'rs-document-confirm'); pending.append(element('p', '', `${record.name}：资料已移除，本地文件仍待清理。关闭占用文件后可重试。`));
      const retry = this.button('retry-delete', '重试清理本地文件'); retry.dataset.id = record.id; retry.disabled = session.busy || !context.canEdit; pending.append(retry); this.root.append(pending);
    }
    if (session.message) { const status = element('p', 'rs-status' + (session.error ? ' is-error' : ''), session.message); status.setAttribute('role', 'status'); this.root.append(status); }
  }
}
