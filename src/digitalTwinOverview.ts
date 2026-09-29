export type DigitalTwinResourceHealth = "healthy" | "warning" | "alarm" | "offline" | "unknown";

export type DigitalTwinResourceRecord = {
  id: string;
  name: string;
  type: string;
  typeLabel?: string;
  health?: DigitalTwinResourceHealth;
  description?: string;
  source?: string;
  updatedAt?: string;
  visible?: boolean;
  tags?: readonly string[];
};

export type DigitalTwinAlertSummary = {
  active: number;
  critical?: number;
  warning?: number;
  message?: string;
};

export type DigitalTwinOverviewSnapshot = {
  projectName?: string;
  generatedAt?: string;
  resources: readonly DigitalTwinResourceRecord[];
  alerts?: DigitalTwinAlertSummary;
};

export type DigitalTwinOverviewOptions = {
  snapshot?: DigitalTwinOverviewSnapshot;
  initiallyOpen?: boolean;
  title?: string;
  onResourceSelect?: (resource: DigitalTwinResourceRecord) => void;
  onOpenChange?: (open: boolean) => void;
};

const HEALTH_LABELS: Record<DigitalTwinResourceHealth, string> = {
  healthy: "健康",
  warning: "预警",
  alarm: "告警",
  offline: "离线",
  unknown: "未知",
};

const TYPE_LABELS: Record<string, string> = {
  cad: "CAD 图纸",
  model: "工程模型",
  tiles: "倾斜摄影",
  tileset: "倾斜摄影",
  imagery: "影像",
  gis: "GIS 数据",
  video: "视频",
  monitoring: "监测数据",
  markup: "标绘",
  other: "其他",
};

let nextInstanceId = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizedHealth(value: DigitalTwinResourceHealth | undefined): DigitalTwinResourceHealth {
  return value && value in HEALTH_LABELS ? value : "unknown";
}

function safeCount(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

function cloneResource(resource: DigitalTwinResourceRecord): DigitalTwinResourceRecord {
  return { ...resource, tags: resource.tags ? [...resource.tags] : undefined };
}

function cloneSnapshot(snapshot: DigitalTwinOverviewSnapshot): DigitalTwinOverviewSnapshot {
  return {
    ...snapshot,
    resources: snapshot.resources.map(cloneResource),
    alerts: snapshot.alerts ? { ...snapshot.alerts } : undefined,
  };
}

function searchableText(resource: DigitalTwinResourceRecord) {
  return [resource.name, resource.type, resource.typeLabel, resource.description, resource.source, ...(resource.tags ?? [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
}

function resourceTypeLabel(resource: DigitalTwinResourceRecord) {
  return resource.typeLabel?.trim() || TYPE_LABELS[resource.type.toLocaleLowerCase()] || resource.type || "未分类";
}

function displayTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

/**
 * A presentation-only project overview. It owns its DOM and filtering state,
 * but deliberately does not read from or mutate Cesium or application state.
 */
export class DigitalTwinOverview {
  readonly root: HTMLElement;

  private snapshot: DigitalTwinOverviewSnapshot = { resources: [] };
  private readonly titleNode: HTMLElement;
  private readonly projectNode: HTMLElement;
  private readonly timestampNode: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly typeSelect: HTMLSelectElement;
  private readonly statValues: Record<"total" | "healthy" | "attention" | "alerts", HTMLElement>;
  private readonly healthSummary: HTMLElement;
  private readonly alertSummary: HTMLElement;
  private readonly resultsSummary: HTMLElement;
  private readonly resourceList: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly listeners: Array<() => void> = [];
  private readonly onResourceSelect?: (resource: DigitalTwinResourceRecord) => void;
  private readonly onOpenChange?: (open: boolean) => void;
  private openState = false;
  private disposed = false;

  constructor(container: HTMLElement, options: DigitalTwinOverviewOptions = {}) {
    const instanceId = ++nextInstanceId;
    const titleId = `digitalTwinOverviewTitle${instanceId}`;
    const searchId = `digitalTwinOverviewSearch${instanceId}`;
    const typeId = `digitalTwinOverviewType${instanceId}`;

    this.onResourceSelect = options.onResourceSelect;
    this.onOpenChange = options.onOpenChange;
    this.root = element("section", "digital-twin-overview");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "false");
    this.root.setAttribute("aria-labelledby", titleId);

    const header = element("header", "digital-twin-overview__header");
    const heading = element("div", "digital-twin-overview__heading");
    const eyebrow = element("small", "digital-twin-overview__eyebrow", "DIGITAL TWIN OVERVIEW");
    this.titleNode = element("h2", "digital-twin-overview__title", options.title ?? "数字孪生项目总览");
    this.titleNode.id = titleId;
    this.projectNode = element("p", "digital-twin-overview__project", "未命名项目");
    heading.append(eyebrow, this.titleNode, this.projectNode);
    const closeButton = element("button", "digital-twin-overview__close", "关闭");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "关闭数字孪生项目总览");
    header.append(heading, closeButton);

    const meta = element("div", "digital-twin-overview__meta");
    meta.append(element("span", "digital-twin-overview__meta-label", "数据更新时间"));
    this.timestampNode = element("time", "digital-twin-overview__timestamp", "尚无快照");
    meta.append(this.timestampNode);

    const stats = element("section", "digital-twin-overview__stats");
    stats.setAttribute("aria-label", "项目资源统计");
    this.statValues = {
      total: this.createStatCard(stats, "资源总数"),
      healthy: this.createStatCard(stats, "健康资源"),
      attention: this.createStatCard(stats, "需关注"),
      alerts: this.createStatCard(stats, "活动告警"),
    };

    const statusSection = element("section", "digital-twin-overview__status");
    const statusHeading = element("h3", "digital-twin-overview__section-title", "健康与告警");
    this.healthSummary = element("div", "digital-twin-overview__health-summary");
    this.alertSummary = element("p", "digital-twin-overview__alert-summary");
    statusSection.append(statusHeading, this.healthSummary, this.alertSummary);

    const controls = element("form", "digital-twin-overview__filters");
    controls.setAttribute("role", "search");
    const searchField = element("label", "digital-twin-overview__filter");
    searchField.htmlFor = searchId;
    searchField.append(element("span", "digital-twin-overview__filter-label", "搜索资源"));
    this.searchInput = element("input", "digital-twin-overview__search");
    this.searchInput.id = searchId;
    this.searchInput.type = "search";
    this.searchInput.autocomplete = "off";
    this.searchInput.placeholder = "名称、来源或标签";
    searchField.append(this.searchInput);
    const typeField = element("label", "digital-twin-overview__filter");
    typeField.htmlFor = typeId;
    typeField.append(element("span", "digital-twin-overview__filter-label", "资源类型"));
    this.typeSelect = element("select", "digital-twin-overview__type-filter");
    this.typeSelect.id = typeId;
    typeField.append(this.typeSelect);
    controls.append(searchField, typeField);

    const resources = element("section", "digital-twin-overview__resources");
    const resourcesHeader = element("div", "digital-twin-overview__resources-header");
    resourcesHeader.append(element("h3", "digital-twin-overview__section-title", "资源目录"));
    this.resultsSummary = element("span", "digital-twin-overview__results-summary", "0 项");
    this.resultsSummary.setAttribute("aria-live", "polite");
    resourcesHeader.append(this.resultsSummary);
    this.resourceList = element("div", "digital-twin-overview__resource-list");
    this.emptyState = element("p", "digital-twin-overview__empty", "暂无资源");
    resources.append(resourcesHeader, this.resourceList, this.emptyState);

    this.root.append(header, meta, stats, statusSection, controls, resources);
    container.append(this.root);

    this.listen(closeButton, "click", () => this.close());
    this.listen(this.searchInput, "input", () => this.renderResourceList());
    this.listen(this.typeSelect, "change", () => this.renderResourceList());
    this.listen(controls, "submit", (event) => event.preventDefault());
    this.listen(document, "keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape" && this.openState) this.close();
    });

    if (options.snapshot) this.setSnapshot(options.snapshot);
    else this.render();
    this.setOpen(options.initiallyOpen ?? false, false);
  }

  get isOpen() {
    return this.openState;
  }

  open() {
    this.setOpen(true, true);
  }

  close() {
    this.setOpen(false, true);
  }

  toggle() {
    this.setOpen(!this.openState, true);
  }

  setSnapshot(snapshot: DigitalTwinOverviewSnapshot) {
    if (this.disposed) return;
    this.snapshot = cloneSnapshot(snapshot);
    this.render();
  }

  resetFilters() {
    if (this.disposed) return;
    this.searchInput.value = "";
    this.typeSelect.value = "";
    this.renderResourceList();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    this.root.remove();
  }

  private setOpen(open: boolean, notify: boolean) {
    if (this.disposed || this.openState === open && this.root.hidden === !open) return;
    const changed = this.openState !== open;
    this.openState = open;
    this.root.hidden = !open;
    this.root.classList.toggle("is-open", open);
    this.root.setAttribute("aria-hidden", String(!open));
    if (open) {
      requestAnimationFrame(() => {
        if (!this.disposed && this.openState) this.searchInput.focus();
      });
    }
    if (notify && changed) this.onOpenChange?.(open);
  }

  private listen(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  private createStatCard(container: HTMLElement, label: string) {
    const card = element("article", "digital-twin-overview__stat-card");
    const value = element("strong", "digital-twin-overview__stat-value", "0");
    card.append(value, element("span", "digital-twin-overview__stat-label", label));
    container.append(card);
    return value;
  }

  private render() {
    this.projectNode.textContent = this.snapshot.projectName?.trim() || "未命名项目";
    const generatedAt = this.snapshot.generatedAt?.trim();
    this.timestampNode.textContent = generatedAt ? displayTimestamp(generatedAt) : "尚无快照";
    if (generatedAt) this.timestampNode.setAttribute("datetime", generatedAt);
    else this.timestampNode.removeAttribute("datetime");

    const healthCounts: Record<DigitalTwinResourceHealth, number> = {
      healthy: 0,
      warning: 0,
      alarm: 0,
      offline: 0,
      unknown: 0,
    };
    for (const resource of this.snapshot.resources) healthCounts[normalizedHealth(resource.health)] += 1;
    const activeAlerts = this.snapshot.alerts ? safeCount(this.snapshot.alerts.active) : healthCounts.alarm;
    this.statValues.total.textContent = String(this.snapshot.resources.length);
    this.statValues.healthy.textContent = String(healthCounts.healthy);
    this.statValues.attention.textContent = String(healthCounts.warning + healthCounts.alarm + healthCounts.offline + healthCounts.unknown);
    this.statValues.alerts.textContent = String(activeAlerts);

    this.healthSummary.replaceChildren();
    for (const health of ["healthy", "warning", "alarm", "offline", "unknown"] as const) {
      const item = element("span", "digital-twin-overview__health-item");
      item.dataset.health = health;
      item.append(
        element("span", "digital-twin-overview__health-label", HEALTH_LABELS[health]),
        element("strong", "digital-twin-overview__health-count", String(healthCounts[health])),
      );
      this.healthSummary.append(item);
    }

    const critical = safeCount(this.snapshot.alerts?.critical);
    const warning = safeCount(this.snapshot.alerts?.warning);
    this.alertSummary.dataset.level = critical > 0 || healthCounts.alarm > 0 ? "alarm" : activeAlerts > 0 ? "warning" : "healthy";
    this.alertSummary.textContent = this.snapshot.alerts?.message?.trim()
      || (activeAlerts > 0 ? `${activeAlerts} 条活动告警，其中严重 ${critical} 条、预警 ${warning} 条。` : "当前没有活动告警。");

    this.renderTypeOptions();
    this.renderResourceList();
  }

  private renderTypeOptions() {
    const selected = this.typeSelect.value;
    const resourcesByType = new Map<string, DigitalTwinResourceRecord>();
    for (const resource of this.snapshot.resources) {
      if (!resourcesByType.has(resource.type)) resourcesByType.set(resource.type, resource);
    }
    this.typeSelect.replaceChildren();
    const all = element("option", undefined, "全部类型");
    all.value = "";
    this.typeSelect.append(all);
    [...resourcesByType.entries()]
      .sort((left, right) => resourceTypeLabel(left[1]).localeCompare(resourceTypeLabel(right[1]), "zh-CN"))
      .forEach(([type, resource]) => {
        const option = element("option", undefined, resourceTypeLabel(resource));
        option.value = type;
        this.typeSelect.append(option);
      });
    this.typeSelect.value = resourcesByType.has(selected) ? selected : "";
  }

  private renderResourceList() {
    const query = this.searchInput.value.trim().toLocaleLowerCase();
    const type = this.typeSelect.value;
    const resources = this.snapshot.resources.filter((resource) => {
      return (!type || resource.type === type) && (!query || searchableText(resource).includes(query));
    });

    this.resourceList.replaceChildren();
    for (const resource of resources) this.resourceList.append(this.createResourceRow(resource));
    this.resultsSummary.textContent = `${resources.length} / ${this.snapshot.resources.length} 项`;
    this.emptyState.hidden = resources.length > 0;
    this.emptyState.textContent = this.snapshot.resources.length ? "没有匹配的资源" : "暂无资源";
  }

  private createResourceRow(resource: DigitalTwinResourceRecord) {
    const health = normalizedHealth(resource.health);
    const row = element("button", "digital-twin-overview__resource-row");
    row.type = "button";
    row.dataset.health = health;
    row.setAttribute("aria-label", `${resource.name}，${resourceTypeLabel(resource)}，${HEALTH_LABELS[health]}`);

    const identity = element("span", "digital-twin-overview__resource-identity");
    identity.append(
      element("strong", "digital-twin-overview__resource-name", resource.name || "未命名资源"),
      element("small", "digital-twin-overview__resource-type", resourceTypeLabel(resource)),
    );
    const details = element("span", "digital-twin-overview__resource-details");
    if (resource.description) details.append(element("span", "digital-twin-overview__resource-description", resource.description));
    if (resource.source) details.append(element("small", "digital-twin-overview__resource-source", resource.source));
    if (resource.updatedAt) {
      const updated = element("time", "digital-twin-overview__resource-updated", displayTimestamp(resource.updatedAt));
      updated.dateTime = resource.updatedAt;
      details.append(updated);
    }
    if (!details.childElementCount) details.append(element("span", "digital-twin-overview__resource-description", "暂无详情"));
    const status = element("span", "digital-twin-overview__resource-status", HEALTH_LABELS[health]);
    status.dataset.health = health;
    if (resource.visible !== undefined) {
      status.append(element("small", "digital-twin-overview__resource-visibility", resource.visible ? "已显示" : "已隐藏"));
    }
    row.append(identity, details, status);
    row.addEventListener("click", () => this.onResourceSelect?.(cloneResource(resource)));
    return row;
  }
}
