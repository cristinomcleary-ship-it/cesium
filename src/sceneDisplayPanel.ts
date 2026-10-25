import { SceneDisplayStore, type SceneDisplayGroup } from "./sceneDisplayStore";
import "./sceneDisplayPanel.css";

export type SceneDisplayItem = {
  id: string;
  name: string;
  category: string;
  visible: boolean;
  detail?: string;
  locate?: () => void | Promise<void>;
  edit?: () => void | Promise<void>;
  /** Remove this resource from its owning project and persist the change; reject on failure. */
  remove?: () => void | Promise<void>;
  /** Cancel a pending load while preserving any saved original and display preferences. */
  cancel?: () => void | Promise<void>;
};
export type SceneDisplayPanelOptions = {
  onApply: (overrides: Record<string, boolean>, labelsVisible: boolean) => void;
  onError?: (message: string) => void;
};
type GroupEditor = { kind: "create" | "rename" | "members"; id?: string; name: string };
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A presentation-only directory in the existing workbench's right dock. */
export class SceneDisplayPanel {
  private readonly root = element("section", "scene-display-panel");
  private readonly events = new AbortController();
  private readonly store = new SceneDisplayStore();
  private items: SceneDisplayItem[] = [];
  private selected = new Set<string>();
  private query = "";
  private editor?: GroupEditor;
  private renderedEditor?: GroupEditor;
  private message = "";
  private error = false;
  private applying = false;
  private disposed = false;
  private directorySignature = "";
  private appliedSignature = "";
  private contextRevision = 0;
  private readonly removing = new Set<string>();

  constructor(host: HTMLElement, private readonly options: SceneDisplayPanelOptions) {
    this.root.setAttribute("aria-label", "场景显示管理");
    this.root.innerHTML = `
      <header class="sdp-heading"><div><span>当前项目 · 个人显示</span><h2>场景显示</h2></div><strong data-role="display-count"></strong></header>
      <div class="sdp-toolbar">
        <label class="sdp-search"><span class="sdp-sr-only">搜索场景对象</span><input type="search" data-role="search" placeholder="搜索名称、类型或说明" maxlength="160"></label>
        <div class="sdp-actions"><button type="button" data-action="show-all">全部显示</button><button type="button" data-action="hide-all">全部隐藏</button><button type="button" data-action="select-matches">选择筛选结果</button></div>
        <label class="sdp-label-switch"><input type="checkbox" data-role="labels-visible" checked><span>显示安全、标绘与基坑标签</span></label>
        <nav class="sdp-tabs" aria-label="显示目录"><button type="button" data-action="view-categories">按类型</button><button type="button" data-action="view-groups">我的分组 <span data-role="group-count">0</span></button></nav>
      </div>
      <div class="sdp-selection" data-role="selection-bar"></div>
      <div class="sdp-group-editor" data-role="group-editor" hidden></div>
      <div class="sdp-scroll" data-role="list"></div>
      <footer class="sdp-footer"><p>勾选对象可跨类型建组。分组开关批量调整成员显示，解散分组不会删除对象。</p><p>显示开关只调整个人视图；删除会从当前项目移除对应资源。</p><p class="sdp-status" data-role="status" role="status" hidden></p></footer>`;
    host.append(this.root);
    this.root.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
      if (button && !button.disabled) { event.preventDefault(); event.stopPropagation(); void this.action(button.dataset.action!, button); }
      if ((event.target as HTMLElement).matches("input[type=checkbox]")) event.stopPropagation();
    }, { signal: this.events.signal });
    this.root.addEventListener("input", event => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.role === "search") { this.query = input.value; this.renderList(); }
      else if (input.dataset.role === "group-name" && this.editor) this.editor.name = input.value;
    }, { signal: this.events.signal });
    this.root.addEventListener("change", event => this.change(event.target as HTMLInputElement), { signal: this.events.signal });
    this.root.addEventListener("keydown", event => {
      // Candidate confirmation/cancellation belongs to the IME, including legacy 229 events.
      if (event.isComposing || event.keyCode === 229) {
        if (event.key === "Enter" || event.key === "Escape") event.stopPropagation();
        return;
      }
      if (event.key === "Enter" && (event.target as HTMLElement).dataset.role === "group-name") { event.preventDefault(); this.saveGroupEditor(); }
      if (event.key === "Escape" && this.editor) { event.stopPropagation(); this.editor = undefined; this.render(); }
    }, { signal: this.events.signal });
    this.render();
  }

  /** Move the same directory and preference store into the active workspace dock. */
  mount(host: HTMLElement): void {
    if (!this.disposed && this.root.parentElement !== host) host.append(this.root);
  }

  /** Legacy display entry points use the same personal override, avoiding competing switches. */
  setVisibility(ids: readonly string[], visible: boolean): void {
    if (this.disposed) return;
    this.store.setVisibility(ids, visible); this.render(); this.apply();
  }

  get labelsVisible(): boolean { return this.store.labelsVisible; }
  getOverrides(): Record<string, boolean> { return this.store.getOverrides(); }

  setContext(projectId: string, actorId: string | undefined, items: readonly SceneDisplayItem[]): void {
    if (this.disposed) return;
    const changed = this.store.setContext(projectId, actorId);
    const seen = new Set<string>();
    this.items = items.filter(item => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 500 && !seen.has(item.id) && !!seen.add(item.id)).map(item => ({ ...item, name: item.name || "未命名对象", category: item.category || "其他", visible: item.visible !== false }));
    this.store.setItems(this.items);
    if (changed) {
      this.contextRevision++;
      this.query = ""; this.selected.clear(); this.editor = undefined; this.message = ""; this.error = false;
      this.find<HTMLInputElement>('[data-role="search"]').value = "";
    } else this.selected = new Set([...this.selected].filter(id => seen.has(id)));
    const signature = JSON.stringify([this.store.scopeKey, this.items.map(item => [item.id, item.name, item.category, item.visible, item.detail, !!item.locate, !!item.edit, !!item.remove, !!item.cancel])]);
    if (changed || signature !== this.directorySignature) { this.directorySignature = signature; this.render(); }
    // Hosts may rebuild an underlying renderer while retaining the same logical IDs.
    // Re-publish the current scope on every host update; apply() guards reentrant callbacks.
    this.apply(true);
  }

  /** Re-apply after a host renderer is rebuilt without changing its logical directory. */
  reapply(): void { this.apply(true); }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.events.abort(); this.root.remove(); } }
  private find<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private button(action: string, title: string): HTMLButtonElement { const node = element("button", "", title); node.type = "button"; node.dataset.action = action; return node; }
  private matches(item: SceneDisplayItem): boolean { const query = this.query.trim().toLocaleLowerCase(); return !query || `${item.name} ${item.category} ${item.detail || ""}`.toLocaleLowerCase().includes(query); }
  private item(id: string) { return this.items.find(item => item.id === id); }
  private removalKey(id: string): string { return JSON.stringify([this.store.scopeKey, id]); }
  private setMessage(message: string, error = false): void { this.message = message; this.error = error; this.renderStatus(); if (error) this.options.onError?.(message); }

  private apply(force = false): void {
    if (this.disposed || this.applying || !this.store.scopeKey) return;
    const overrides = this.store.getOverrides();
    const signature = JSON.stringify([this.store.scopeKey, this.items.map(item => [item.id, item.visible]).sort(([a], [b]) => String(a).localeCompare(String(b))), Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)), this.store.labelsVisible]);
    if (!force && signature === this.appliedSignature) return;
    this.appliedSignature = signature; this.applying = true;
    try { this.options.onApply(overrides, this.store.labelsVisible); }
    catch (error) { this.setMessage("显示调整未完成：" + errorText(error), true); }
    finally { this.applying = false; }
  }

  private render(): void {
    this.find('[data-role="display-count"]').textContent = `${this.items.filter(item => this.store.isVisible(item.id)).length} / ${this.items.length} 显示`;
    this.find<HTMLInputElement>('[data-role="labels-visible"]').checked = this.store.labelsVisible;
    this.find('[data-role="group-count"]').textContent = String(this.store.getGroups().length);
    for (const view of ["categories", "groups"] as const) {
      const button = this.find<HTMLButtonElement>(`[data-action="view-${view}"]`); button.classList.toggle("is-active", this.store.view === view); button.setAttribute("aria-pressed", String(this.store.view === view));
    }
    for (const action of ["show-all", "hide-all", "select-matches"]) this.find<HTMLButtonElement>(`[data-action="${action}"]`).disabled = !this.items.length;
    this.renderSelection(); this.renderEditor(); this.renderList(); this.renderStatus();
  }
  private renderStatus(): void {
    const status = this.find('[data-role="status"]'), message = this.store.persistenceError || this.message;
    status.textContent = message; status.hidden = !message; status.classList.toggle("is-error", this.error && !this.store.persistenceError);
  }
  private renderSelection(): void {
    const bar = this.find('[data-role="selection-bar"]'); bar.replaceChildren();
    bar.append(element("span", "", this.editor?.kind === "members" ? `调整成员 · 已选 ${this.selected.size} 项` : `已选 ${this.selected.size} 项`));
    const create = this.button("create-group", "选中项建组"); create.disabled = !this.selected.size || this.editor?.kind === "members";
    const clear = this.button("clear-selection", "清空选择"); clear.disabled = !this.selected.size;
    bar.append(create, clear);
  }
  private renderEditor(): void {
    const host = this.find('[data-role="group-editor"]'); host.hidden = !this.editor;
    // Directory refreshes must retain the live input, its caret and any IME composition.
    if (this.renderedEditor === this.editor) return;
    this.renderedEditor = this.editor;
    host.replaceChildren();
    if (!this.editor) return;
    const editor = this.editor;
    host.append(element("strong", "", editor.kind === "create" ? "创建显示分组" : editor.kind === "rename" ? "重命名分组" : `调整“${editor.name}”成员`));
    if (editor.kind !== "members") {
      const label = element("label"), input = element("input"); label.append(element("span", "sdp-sr-only", "分组名称")); input.type = "text"; input.maxLength = 60; input.value = editor.name; input.dataset.role = "group-name"; input.placeholder = "例如：10号墩施工布置"; label.append(input); host.append(label);
    } else host.append(element("p", "", "在下面各分类勾选或取消成员，再保存。未加载的原成员会从本次新名单移除。"));
    const actions = element("div", "sdp-actions"); actions.append(this.button("save-group", editor.kind === "members" ? "保存成员" : "保存分组"), this.button("cancel-group", "取消")); host.append(actions);
  }
  private renderList(): void {
    const host = this.find('[data-role="list"]'), scrollTop = host.scrollTop; host.replaceChildren();
    if (this.store.view === "groups") this.renderGroups(host);
    else if (!this.items.length) host.append(element("p", "sdp-empty", "当前项目暂无可管理的场景对象。加载工程资料或创建对象后会出现在这里。"));
    else this.renderCategories(host);
    host.scrollTop = scrollTop;
  }
  private renderCategories(host: HTMLElement): void {
    const categories = new Map<string, SceneDisplayItem[]>();
    for (const item of this.items) { if (!categories.has(item.category)) categories.set(item.category, []); categories.get(item.category)!.push(item); }
    let count = 0;
    for (const [category, items] of categories) {
      const matches = items.filter(item => this.matches(item)); if (!matches.length) continue; count += matches.length;
      const section = element("details", "sdp-category"); section.dataset.category = category; section.open = !!this.query.trim() || !this.store.isCategoryCollapsed(category);
      const summary = element("summary"); summary.append(element("strong", "", category), element("span", "sdp-count", `${items.filter(item => this.store.isVisible(item.id)).length}/${items.length}`));
      const actions = element("span", "sdp-category-actions");
      for (const [action, title] of [["category-show", "全显"], ["category-hide", "全隐"]]) { const button = this.button(action, title); button.dataset.category = category; button.setAttribute("aria-label", `${category}${title}`); actions.append(button); }
      summary.append(actions); section.append(summary);
      const rows = element("div", "sdp-rows"); for (const item of matches) rows.append(this.itemRow(item)); section.append(rows);
      section.addEventListener("toggle", () => { if (!this.disposed && !this.query.trim() && section.isConnected) { this.store.setCategoryCollapsed(category, !section.open); this.renderStatus(); } }, { signal: this.events.signal });
      host.append(section);
    }
    if (!count) host.append(element("p", "sdp-empty", "没有匹配对象。试试其他名称或类型。"));
  }
  private itemRow(item: SceneDisplayItem, showCategory = false): HTMLElement {
    const row = element("div", "sdp-item"); row.dataset.displayId = item.id; row.classList.toggle("is-hidden", !this.store.isVisible(item.id));
    const removing = this.removing.has(this.removalKey(item.id)); row.classList.toggle("is-removing", removing); row.setAttribute("aria-busy", String(removing));
    const select = element("input", "sdp-item-select"); select.type = "checkbox"; select.dataset.selectItem = item.id; select.checked = this.selected.has(item.id); select.disabled = removing; select.setAttribute("aria-label", `选择${item.name}加入分组`);
    const name = element("div", "sdp-item-name"); name.append(element("strong", "", item.name)); name.title = item.name;
    const detail = [showCategory ? item.category : "", item.detail || ""].filter(Boolean).join(" · "); if (detail) name.append(element("small", "", detail));
    const visible = this.store.isVisible(item.id), toggle = this.button("item-visibility", visible ? "显示" : "隐藏"); toggle.dataset.itemId = item.id; toggle.className = "sdp-item-visibility"; toggle.disabled = removing; toggle.setAttribute("aria-pressed", String(visible)); toggle.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}${item.name}`);
    row.append(select, name, toggle);
    const tools = element("div", "sdp-item-tools");
    if (item.locate) { const button = this.button("item-locate", "定位"); button.dataset.itemId = item.id; button.title = visible ? "定位此对象" : "先显示此对象再定位"; button.disabled = !visible || removing; tools.append(button); }
    if (item.edit) { const button = this.button("item-edit", "配置"); button.dataset.itemId = item.id; button.disabled = removing; tools.append(button); }
    if (item.remove) { const button = this.button("item-remove", removing ? "删除中…" : "删除"); button.dataset.itemId = item.id; button.className = "sdp-item-remove"; button.disabled = removing; button.title = `从当前项目删除${item.name}`; button.setAttribute("aria-label", `删除${item.name}`); tools.append(button); }
    if (item.cancel) { const button = this.button('item-cancel', '取消加载'); button.dataset.itemId = item.id; button.title = '停止本次加载，保留已保存的原资料'; tools.append(button); }
    if (tools.children.length) row.append(tools); return row;
  }
  private renderGroups(host: HTMLElement): void {
    const groups = this.store.getGroups();
    if (!groups.length) { const empty = element("div", "sdp-empty"); empty.append(element("p", "", "还没有显示分组。可在“按类型”中跨类勾选对象，例如把一台吊机、防护人员和安全限界放在同一组。"), this.button("view-categories", "去选择对象")); host.append(empty); return; }
    let matched = 0;
    for (const group of groups) {
      const all = group.members.flatMap(id => { const item = this.item(id); return item ? [item] : []; });
      const nameMatch = group.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase());
      const members = nameMatch ? all : all.filter(item => this.matches(item)); if (this.query.trim() && !nameMatch && !members.length) continue; matched++;
      const card = element("section", "sdp-group"); card.dataset.groupId = group.id;
      const heading = element("div", "sdp-group-heading"), toggle = element("input"); toggle.type = "checkbox"; toggle.dataset.toggleGroup = group.id;
      const state = this.store.groupState(group.id); toggle.checked = state === "all"; toggle.indeterminate = state === "some"; toggle.disabled = state === "empty"; toggle.setAttribute("aria-label", `切换分组${group.name}显示`);
      heading.append(toggle, element("strong", "", group.name), element("span", "sdp-count", `${all.filter(item => this.store.isVisible(item.id)).length}/${all.length} 显示`)); card.append(heading);
      const actions = element("div", "sdp-actions sdp-group-actions");
      for (const [action, label] of [["group-show", "全显"], ["group-hide", "全隐"], ["rename-group", "重命名"], ["edit-members", "调整成员"], ["dissolve-group", "解散"]]) {
        const button = this.button(action, label); button.dataset.groupId = group.id; if ((action === "group-show" || action === "group-hide") && !all.length) button.disabled = true; actions.append(button);
      }
      card.append(actions);
      if (all.length < group.members.length) card.append(element("p", "sdp-unavailable", `${group.members.length - all.length} 项暂未加载或不可访问；开关仅作用于当前可用成员。`));
      const rows = element("div", "sdp-rows"); for (const item of members) rows.append(this.itemRow(item, true)); card.append(rows); host.append(card);
    }
    if (!matched) host.append(element("p", "sdp-empty", "没有匹配分组或成员。"));
  }
  private change(input: HTMLInputElement): void {
    if (this.disposed) return;
    if (input.dataset.selectItem) {
      if (input.checked) this.selected.add(input.dataset.selectItem); else this.selected.delete(input.dataset.selectItem);
      this.renderSelection();
      for (const checkbox of this.root.querySelectorAll<HTMLInputElement>("[data-select-item]")) checkbox.checked = this.selected.has(checkbox.dataset.selectItem!);
    } else if (input.dataset.role === "labels-visible") { this.store.setLabelsVisible(input.checked); this.render(); this.apply(); }
    else if (input.dataset.toggleGroup) { this.store.setGroupVisibility(input.dataset.toggleGroup, input.checked); this.render(); this.apply(); }
  }
  private group(id: string): SceneDisplayGroup | undefined { return this.store.getGroups().find(group => group.id === id); }
  private async removeItem(id: string): Promise<void> {
    const item = this.item(id), key = this.removalKey(id);
    if (!item?.remove || this.removing.has(key)) return;
    const scope = this.store.scopeKey, revision = this.contextRevision;
    const sameContext = () => !this.disposed && this.store.scopeKey === scope && this.contextRevision === revision;
    this.removing.add(key); this.renderList(); this.setMessage(`正在删除“${item.name}”…`);
    try {
      // The host owns data and renderer teardown. Only update this directory after it succeeds.
      await item.remove();
      this.store.removeItems([id], scope);
      if (!sameContext()) return;
      this.items = this.items.filter(current => current.id !== id);
      this.selected.delete(id);
      this.store.setItems(this.items);
      this.directorySignature = "";
      this.render(); this.apply(); this.setMessage(`已删除“${item.name}”。`);
    } catch (error) {
      if (sameContext()) this.setMessage(`删除“${item.name}”失败：${errorText(error)}`, true);
    } finally {
      this.removing.delete(key);
      // Returning to this project during a pending delete must not leave stale busy controls.
      if (!this.disposed && this.store.scopeKey === scope) this.render();
    }
  }
  private saveGroupEditor(): void {
    if (!this.editor) return;
    try {
      const editor = this.editor;
      if (editor.kind === "create") this.store.createGroup(editor.name, [...this.selected]);
      else if (editor.kind === "rename") this.store.renameGroup(editor.id!, editor.name);
      else this.store.setGroupMembers(editor.id!, [...this.selected]);
      this.editor = undefined; this.selected.clear(); this.store.setView("groups"); this.render(); this.setMessage("分组已保存。成员的当前显隐保持不变。");
    } catch (error) { this.setMessage(errorText(error), true); }
  }
  private async action(action: string, button: HTMLButtonElement): Promise<void> {
    if (this.disposed) return;
    try {
      if (action === "show-all" || action === "hide-all") { this.store.setVisibility(this.items.map(item => item.id), action === "show-all"); this.render(); this.apply(); }
      else if (action === "category-show" || action === "category-hide") { this.store.setVisibility(this.items.filter(item => item.category === button.dataset.category).map(item => item.id), action === "category-show"); this.render(); this.apply(); }
      else if (action === "item-visibility") { const id = button.dataset.itemId!; this.store.setVisibility([id], !this.store.isVisible(id)); this.render(); this.apply(); }
      else if (action === "group-show" || action === "group-hide") { this.store.setGroupVisibility(button.dataset.groupId!, action === "group-show"); this.render(); this.apply(); }
      else if (action === "view-categories" || action === "view-groups") { this.store.setView(action === "view-groups" ? "groups" : "categories"); this.render(); }
      else if (action === "select-matches") { for (const item of this.items.filter(item => this.matches(item))) this.selected.add(item.id); this.render(); }
      else if (action === "clear-selection") { this.selected.clear(); this.render(); }
      else if (action === "create-group") { this.editor = { kind: "create", name: "" }; this.renderEditor(); this.find<HTMLInputElement>('[data-role="group-name"]').focus(); }
      else if (action === "rename-group" || action === "edit-members") {
        const group = this.group(button.dataset.groupId!); if (!group) return;
        this.editor = { kind: action === "rename-group" ? "rename" : "members", id: group.id, name: group.name };
        if (action === "edit-members") { this.selected = new Set(group.members.filter(id => !!this.item(id))); this.query = ""; this.find<HTMLInputElement>('[data-role="search"]').value = ""; this.store.setView("categories"); }
        this.render(); if (action === "rename-group") this.find<HTMLInputElement>('[data-role="group-name"]').focus();
      } else if (action === "dissolve-group") { this.store.removeGroup(button.dataset.groupId!); this.render(); this.setMessage("已解散分组，场景对象与当前显隐保持不变。"); }
      else if (action === "cancel-group") { this.editor = undefined; this.render(); }
      else if (action === "save-group") this.saveGroupEditor();
      else if (action === "item-remove") await this.removeItem(button.dataset.itemId!);
      else if (action === "item-locate" || action === "item-edit" || action === "item-cancel") {
        const item = this.item(button.dataset.itemId!); button.disabled = true;
        try { await (action === "item-locate" ? item?.locate?.() : action === 'item-cancel' ? item?.cancel?.() : item?.edit?.()); } finally { if (!this.disposed) this.render(); }
      }
    } catch (error) { this.setMessage(errorText(error), true); }
  }
}

