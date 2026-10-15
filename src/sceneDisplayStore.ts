/** Personal presentation preferences. No scene geometry or business records are stored here. */
export type SceneDisplayGroup = { id: string; name: string; members: string[] };
type DisplayPreferences = {
  version: 1;
  overrides: Record<string, boolean>;
  labelsVisible: boolean;
  groups: SceneDisplayGroup[];
  view: "categories" | "groups";
  collapsedCategories: string[];
};
type DisplayStorage = Pick<Storage, "getItem" | "setItem">;
const MAX_ITEMS = 5000, MAX_GROUPS = 100, MAX_NAME = 60;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter(identifier))].slice(0, MAX_ITEMS) : [];
const defaults = (): DisplayPreferences => ({ version: 1, overrides: {}, labelsVisible: true, groups: [], view: "categories", collapsedCategories: [] });

export function normalizeSceneDisplayPreferences(value: unknown): DisplayPreferences {
  const input = record(value), result = defaults();
  if (input.version !== 1) return result;
  result.overrides = Object.fromEntries(Object.entries(record(input.overrides)).filter((entry): entry is [string, boolean] => identifier(entry[0]) && typeof entry[1] === "boolean").slice(0, MAX_ITEMS));
  result.labelsVisible = typeof input.labelsVisible === "boolean" ? input.labelsVisible : true;
  result.view = input.view === "groups" ? "groups" : "categories";
  result.collapsedCategories = ids(input.collapsedCategories).slice(0, 100);
  const seenIds = new Set<string>();
  for (const candidate of Array.isArray(input.groups) ? input.groups.slice(0, MAX_GROUPS) : []) {
    const group = record(candidate);
    if (!identifier(group.id) || seenIds.has(group.id) || typeof group.name !== "string" || !group.name.trim()) continue;
    seenIds.add(group.id); result.groups.push({ id: group.id, name: group.name.trim().slice(0, MAX_NAME), members: ids(group.members) });
  }
  return result;
}

/** Group switches are batch actions over the same per-item state, never an extra hiding gate. */
export class SceneDisplayStore {
  private scope?: string;
  private preferences = defaults();
  private items = new Map<string, boolean>();
  private error?: string;
  private readonly storage?: DisplayStorage;

  constructor(storage?: DisplayStorage) { this.storage = storage; }

  get labelsVisible() { return this.preferences.labelsVisible; }
  get persistenceError() { return this.error; }
  get view() { return this.preferences.view; }
  get scopeKey() { return this.scope ?? ""; }

  setContext(projectId: string, actorId?: string): boolean {
    const scope = `scene-display:v1:${JSON.stringify([projectId, actorId ?? null])}`;
    if (this.scope === scope) return false;
    this.scope = scope; this.preferences = defaults(); this.items.clear(); this.error = undefined;
    try {
      const saved = (this.storage ?? globalThis.localStorage).getItem(scope);
      if (saved) this.preferences = normalizeSceneDisplayPreferences(JSON.parse(saved));
    } catch { this.error = "浏览器无法读取显示偏好，当前使用默认显示。"; }
    return true;
  }

  setItems(items: readonly { id: string; visible: boolean }[]): void {
    // Absent objects may simply be loading or temporarily unavailable. Keep their saved preferences.
    this.items = new Map(items.filter(item => identifier(item.id)).slice(0, MAX_ITEMS).map(item => [item.id, item.visible !== false]));
  }

  isVisible(id: string): boolean {
    return Object.hasOwn(this.preferences.overrides, id) ? this.preferences.overrides[id] : this.items.get(id) ?? false;
  }
  getOverrides(): Record<string, boolean> { return { ...this.preferences.overrides }; }
  getGroups(): SceneDisplayGroup[] { return this.preferences.groups.map(group => ({ ...group, members: [...group.members] })); }
  isCategoryCollapsed(category: string): boolean { return this.preferences.collapsedCategories.includes(category); }

  setVisibility(itemIds: readonly string[], visible: boolean): void {
    const overrides = new Map(Object.entries(this.preferences.overrides));
    let changed = false;
    for (const id of new Set(itemIds)) {
      if (!this.items.has(id) || overrides.get(id) === visible) continue;
      overrides.set(id, visible); changed = true;
    }
    if (!changed) return;
    this.preferences.overrides = Object.fromEntries([...overrides].slice(-MAX_ITEMS)); this.persist();
  }
  setLabelsVisible(visible: boolean): void {
    if (this.preferences.labelsVisible === visible) return;
    this.preferences.labelsVisible = visible; this.persist();
  }
  setView(view: "categories" | "groups"): void {
    if (this.preferences.view === view) return;
    this.preferences.view = view; this.persist();
  }
  setCategoryCollapsed(category: string, collapsed: boolean): void {
    if (!identifier(category) || this.isCategoryCollapsed(category) === collapsed) return;
    const next = new Set(this.preferences.collapsedCategories); if (collapsed) next.add(category); else next.delete(category);
    this.preferences.collapsedCategories = [...next].slice(-100); this.persist();
  }

  createGroup(name: string, memberIds: readonly string[]): SceneDisplayGroup {
    if (this.preferences.groups.length >= MAX_GROUPS) throw new Error(`最多创建 ${MAX_GROUPS} 个显示分组。`);
    const title = this.groupName(name), members = this.currentMembers(memberIds);
    if (!members.length) throw new Error("请先勾选至少一个场景对象，再建立分组。");
    const group = { id: `display-group:${crypto.randomUUID()}`, name: title, members };
    this.preferences.groups.push(group); this.persist(); return { ...group, members: [...members] };
  }
  renameGroup(id: string, name: string): void {
    const group = this.group(id), title = this.groupName(name, id);
    if (group.name === title) return; group.name = title; this.persist();
  }
  setGroupMembers(id: string, memberIds: readonly string[]): void {
    const group = this.group(id), members = this.currentMembers(memberIds);
    if (!members.length) throw new Error("分组至少保留一个当前场景对象；不再需要时可解散分组。");
    group.members = members; this.persist();
  }
  removeGroup(id: string): void {
    const next = this.preferences.groups.filter(group => group.id !== id);
    if (next.length === this.preferences.groups.length) return;
    this.preferences.groups = next; this.persist();
  }
  groupState(id: string): "all" | "some" | "none" | "empty" {
    const members = this.group(id).members.filter(member => this.items.has(member));
    if (!members.length) return "empty";
    const visible = members.filter(member => this.isVisible(member)).length;
    return visible === members.length ? "all" : visible ? "some" : "none";
  }
  setGroupVisibility(id: string, visible: boolean): void { this.setVisibility(this.group(id).members, visible); }

  private group(id: string): SceneDisplayGroup {
    const group = this.preferences.groups.find(group => group.id === id);
    if (!group) throw new Error("分组已移除，请重新选择。"); return group;
  }
  private groupName(value: string, currentId?: string): string {
    const name = value.trim();
    if (!name || name.length > MAX_NAME) throw new Error(`分组名称需要 1 至 ${MAX_NAME} 个字符。`);
    if (this.preferences.groups.some(group => group.id !== currentId && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("已有同名分组，请换一个名称。");
    return name;
  }
  private currentMembers(memberIds: readonly string[]): string[] { return ids([...memberIds]).filter(id => this.items.has(id)); }
  private persist(): void {
    try {
      if (!this.scope) return;
      (this.storage ?? globalThis.localStorage).setItem(this.scope, JSON.stringify(this.preferences)); this.error = undefined;
    } catch { this.error = "显示调整已生效，但浏览器无法保存偏好；刷新后可能恢复先前设置。"; }
  }
}
