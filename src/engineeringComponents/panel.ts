import './panel.css';

export type EngineeringTreeRow = {
  id: string; name: string; depth: number; group: boolean; expanded: boolean; selected: boolean;
  count: number; visible: boolean | 'mixed'; occlusionEnabled: boolean | 'mixed'; reference?: boolean;
};
export type EngineeringPanelActions = {
  close(): void; connect(id: string): void; disconnect(): void; scope(id: string): void;
  select(id: string, group: boolean): void; expand(id: string): void;
  setState(id: string | null, group: boolean, key: 'visible' | 'occlusionEnabled', value: boolean): void;
  search(value: string): void; locate(): void; pick(enabled: boolean): void;
  detection(enabled: boolean, offset: number): void; alignDetection(): void;
  exportState(): void; importState(file: File): void;
};

const ROW_HEIGHT = 34;

/** Virtual rows keep the complete engineering catalogue without thousands of DOM controls. */
export class EngineeringComponentPanel {
  readonly root: HTMLElement;
  private rows: EngineeringTreeRow[] = [];
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private destroyed = false;
  private bound = false;
  constructor(private actions: EngineeringPanelActions) {
    this.root = document.createElement('section');
    this.root.className = 'engineering-components-panel hidden';
    this.root.id = 'engineeringComponentsPanel';
    this.root.setAttribute('aria-label', '工程构件管理');
    this.root.innerHTML = `<header><strong>工程构件</strong><button type="button" data-ec-action="close" aria-label="关闭工程构件">×</button></header>
      <div class="ec-connect"><label>已定位模型<select data-ec="instance" aria-label="选择已定位工程模型"></select></label><button type="button" data-ec-action="connect">接入构件</button><button type="button" data-ec-action="disconnect" disabled>解除接入</button></div>
      <p class="ec-status" data-ec="status" role="status">选择已加载的重构模型，核验后接入构件。</p>
      <div class="ec-controls"><label>查看范围<select data-ec="scope" disabled><option value="all">全线全部构件</option><option value="A001">A001# 墩 · 样板</option><option value="TN021">TN021 隧道 · 样板</option></select></label>
      <input type="search" data-ec="search" placeholder="搜索编号、名称或构件类型" aria-label="搜索工程构件" disabled>
      <div class="ec-actions"><label><input type="checkbox" data-ec="pick" disabled> 三维选择</label><button type="button" data-ec-action="locate" disabled>定位所选</button></div>
      <div class="ec-bulk"><span data-ec="scope-label">当前范围</span><label><input type="checkbox" data-ec="all-visible" disabled> 显示</label><label><input type="checkbox" data-ec="all-occlusion" disabled> 参与遮挡</label></div></div>
      <div class="ec-tree-head"><span>构件树</span><span>显示</span><span>遮挡</span></div>
      <div class="ec-tree" role="tree" aria-label="工程构件树" tabindex="0"><div class="ec-tree-content"></div></div>
      <p class="ec-selection" data-ec="selection">未选择构件</p>
      <details class="ec-detection"><summary>独立遮挡检测</summary><label><input type="checkbox" data-ec="detection" disabled> 显示检测面</label><label>前后偏移（米）<input type="number" data-ec="offset" min="-200" max="200" step="0.5" value="0" disabled></label><button type="button" data-ec-action="align" disabled>按当前视角放置</button><small>橙色检测面使用构件的独立遮挡状态；隐藏的构件也可以遮住其后的检测面。</small></details>
      <footer><span data-ec="saved"></span><button type="button" data-ec-action="export" disabled>导出状态</button><label class="ec-file">导入状态<input type="file" data-ec="import" accept="application/json,.json" disabled></label></footer>`;
    document.body.append(this.root);
    this.viewport = this.root.querySelector('.ec-tree')!;
    this.content = this.root.querySelector('.ec-tree-content')!;
    this.viewport.addEventListener('scroll', this.renderRows);
    this.root.addEventListener('click', this.click);
    this.root.addEventListener('change', this.change);
    this.root.querySelector('[data-ec="search"]')!.addEventListener('input', () => actions.search(this.input('search').value));
  }
  get isOpen() { return !this.root.classList.contains('hidden'); }
  open() { this.root.classList.remove('hidden'); this.renderRows(); }
  close() { this.root.classList.add('hidden'); this.input('pick').checked = false; }
  setStatus(message: string, error = false) { const el = this.root.querySelector<HTMLElement>('[data-ec="status"]')!; el.textContent = message; el.classList.toggle('error', error); }
  setSaved(message: string) { this.root.querySelector('[data-ec="saved"]')!.textContent = message; }
  setInstances(items: readonly { id: string; name: string }[], selected?: string) {
    const select = this.root.querySelector<HTMLSelectElement>('[data-ec="instance"]')!;
    const value = selected ?? select.value;
    if (JSON.stringify([...select.options].map(o => [o.value, o.text])) !== JSON.stringify(items.map(i => [i.id, i.name]))) select.replaceChildren(...items.map(item => new Option(item.name, item.id)));
    if ([...select.options].some(o => o.value === value)) select.value = value;
    this.root.querySelector<HTMLButtonElement>('[data-ec-action="connect"]')!.disabled = !items.length || this.bound;
  }
  setBusy(busy: boolean) { this.root.querySelector<HTMLButtonElement>('[data-ec-action="connect"]')!.disabled = busy || this.bound; }
  setBound(bound: boolean, units: readonly { id: string; name?: string }[] = []) {
    this.bound = bound;
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('.ec-controls input,.ec-controls select,.ec-controls button,.ec-detection input,.ec-detection button,footer input,footer button').forEach(el => { el.disabled = !bound; });
    this.root.querySelector<HTMLButtonElement>('[data-ec-action="disconnect"]')!.disabled = !bound;
    this.root.querySelector<HTMLButtonElement>('[data-ec-action="connect"]')!.disabled = bound;
    this.root.querySelector<HTMLSelectElement>('[data-ec="instance"]')!.disabled = bound;
    if (units.length) {
      const scope = this.root.querySelector<HTMLSelectElement>('[data-ec="scope"]')!;
      scope.replaceChildren(new Option('全线全部构件', 'all'), ...units.map(unit => new Option(unit.name ?? unit.id, unit.id)));
    }
    if (!bound) { this.rows = []; this.renderRows(); this.setSaved(''); }
  }
  setScope(scope: string) { this.root.querySelector<HTMLSelectElement>('[data-ec="scope"]')!.value = scope; this.viewport.scrollTop = 0; }
  setSelection(description: string) { this.root.querySelector('[data-ec="selection"]')!.textContent = description; }
  setPick(active: boolean) { this.input('pick').checked = active; }
  setDetection(active: boolean) { this.input('detection').checked = active; }
  setRows(rows: EngineeringTreeRow[], summary: { count: number; visible: boolean | 'mixed'; occlusionEnabled: boolean | 'mixed' }, label: string) {
    this.rows = rows;
    this.root.querySelector('[data-ec="scope-label"]')!.textContent = `${label} · ${summary.count.toLocaleString()} 件`;
    for (const [selector, value] of [['all-visible', summary.visible], ['all-occlusion', summary.occlusionEnabled]] as const) { const input = this.input(selector); input.checked = value === true; input.indeterminate = value === 'mixed'; }
    this.renderRows();
  }
  reveal(id: string) { const index = this.rows.findIndex(row => !row.group && row.id === id); if (index >= 0) { this.viewport.scrollTop = Math.max(0, index * ROW_HEIGHT - this.viewport.clientHeight / 2); this.renderRows(); } }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.viewport.removeEventListener('scroll', this.renderRows); this.root.remove(); }
  private input(name: string) { return this.root.querySelector<HTMLInputElement>(`[data-ec="${name}"]`)!; }
  private renderRows = () => {
    this.content.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - 4);
    const end = Math.min(this.rows.length, start + Math.ceil((this.viewport.clientHeight || 340) / ROW_HEIGHT) + 8);
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) {
      const row = this.rows[index], el = document.createElement('div');
      el.className = 'ec-row' + (row.selected ? ' selected' : ''); el.style.top = `${index * ROW_HEIGHT}px`;
      el.dataset.componentId = row.id; el.dataset.group = String(row.group); el.setAttribute('role', 'treeitem'); el.setAttribute('aria-level', String(row.depth + 1)); el.setAttribute('aria-selected', String(row.selected));
      if (row.group) el.setAttribute('aria-expanded', String(row.expanded));
      const label = document.createElement('div'); label.className = 'ec-row-label'; label.style.paddingLeft = `${Math.min(row.depth, 8) * 12}px`;
      const expander = document.createElement('button'); expander.type = 'button'; expander.dataset.ecAction = 'expand'; expander.textContent = row.group ? row.expanded ? '▾' : '▸' : '·'; expander.disabled = !row.group; expander.setAttribute('aria-label', row.expanded ? '折叠' : '展开');
      const name = document.createElement('button'); name.type = 'button'; name.dataset.ecAction = 'select'; name.textContent = row.name; name.title = `${row.id}${row.group ? ' · ' + row.count + ' 件' : ''}`;
      label.append(expander, name); el.append(label);
      for (const key of ['visible', 'occlusionEnabled'] as const) {
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.ecState = key;
        input.checked = row[key] === true; input.indeterminate = row[key] === 'mixed'; input.setAttribute('aria-label', `${row.name}${key === 'visible' ? '显示' : '参与遮挡'}`);
        input.disabled = row.reference === true && key === 'occlusionEnabled'; el.append(input);
      }
      fragment.append(el);
    }
    this.content.replaceChildren(fragment);
  };
  private click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-ec-action]'); if (!button) return;
    const row = button.closest<HTMLElement>('[data-component-id]'), action = button.dataset.ecAction;
    if (action === 'close') this.actions.close();
    else if (action === 'connect') this.actions.connect(this.root.querySelector<HTMLSelectElement>('[data-ec="instance"]')!.value);
    else if (action === 'disconnect') this.actions.disconnect();
    else if (action === 'expand' && row) this.actions.expand(row.dataset.componentId!);
    else if (action === 'select' && row) this.actions.select(row.dataset.componentId!, row.dataset.group === 'true');
    else if (action === 'locate') this.actions.locate();
    else if (action === 'align') this.actions.alignDetection();
    else if (action === 'export') this.actions.exportState();
  };
  private change = (event: Event) => {
    const input = event.target as HTMLInputElement, row = input.closest<HTMLElement>('[data-component-id]');
    if (input.dataset.ecState && row) this.actions.setState(row.dataset.componentId!, row.dataset.group === 'true', input.dataset.ecState as 'visible' | 'occlusionEnabled', input.checked);
    else if (input.dataset.ec === 'all-visible' || input.dataset.ec === 'all-occlusion') this.actions.setState(null, true, input.dataset.ec === 'all-visible' ? 'visible' : 'occlusionEnabled', input.checked);
    else if (input.dataset.ec === 'scope') this.actions.scope(input.value);
    else if (input.dataset.ec === 'pick') this.actions.pick(input.checked);
    else if (input.dataset.ec === 'detection' || input.dataset.ec === 'offset') this.actions.detection(this.input('detection').checked, Number(this.input('offset').value));
    else if (input.dataset.ec === 'import' && input.files?.[0]) { this.actions.importState(input.files[0]); input.value = ''; }
  };
}
