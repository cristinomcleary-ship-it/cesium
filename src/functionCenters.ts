/** Navigation only: every entry opens an existing editor or business workspace. */
export type FunctionCenterId = 'data' | 'scene' | 'construction' | 'safety' | 'inspection' | 'presentation';
export type FunctionCenterAction = 'library' | 'display' | 'model-objects' | 'subsurface' | 'plans' | 'tasks' | 'resources' | 'documents' | 'inspection';
export type FunctionCenterEntry = {
  title: string;
  keywords: string;
} & ({ tab: string; action?: never } | { action: FunctionCenterAction; tab?: never });
export type FunctionCenter = {
  id: FunctionCenterId;
  title: string;
  description: string;
  entries: readonly FunctionCenterEntry[];
};

export const FUNCTION_CENTERS: readonly FunctionCenter[] = [
  { id: 'data', title: '数据资源中心', description: '导入图纸、模型与空间数据', entries: [
    { tab: 'tiles', title: '倾斜摄影', keywords: '3D Tiles tileset 实景 摄影' },
    { tab: 'cad', title: 'CAD 图纸', keywords: 'CAD DWG 图纸 导入 坐标' },
    { tab: 'models', title: '工程模型', keywords: 'GLB SKP BIM 素材 模型 导入' },
    { tab: 'gis', title: 'GIS 数据', keywords: 'GIS 地理 空间 数据 导入' },
    { action: 'library', title: '已保存资料', keywords: '资料库 原件 视频 文件 重新载入 删除' },
  ] },
  { id: 'scene', title: '三维场景中心', description: '管理对象显示、标绘与地下场景', entries: [
    { action: 'display', title: '对象目录与显示', keywords: '图层 分组 搜索 定位 隐藏 透明度 颜色' },
    { action: 'model-objects', title: '已布置模型', keywords: '工程 模型 调整 平移 旋转 缩放 位置' },
    { tab: 'markup', title: '标绘', keywords: '标注 绘制 点 线 面' },
    { action: 'subsurface', title: '地下与隐蔽工程', keywords: '地质 地下水 管线 剖切 档案' },
  ] },
  { id: 'construction', title: '施工管理中心', description: '安排作业、临建、资源与资料', entries: [
    { tab: 'temporary-works', title: '临建规划', keywords: '临建设施 便道 硬化 驻地 钢筋加工场 自动 高度' },
    { action: 'plans', title: '计划与进度', keywords: '计划 甘特 周计划 节点 进度' },
    { action: 'tasks', title: '施工任务', keywords: '作业 工点 今日 条件 执行 日志' },
    { action: 'resources', title: '资源安排', keywords: '机械 班组 材料 辅材 试验 台账' },
    { action: 'documents', title: '方案与资料', keywords: '方案 资料 图纸 报审 协同 文件' },
  ] },
  { id: 'safety', title: '安全监测中心', description: '机械、营业线防护与基坑监测', entries: [
    { tab: 'machinery', title: '施工机械', keywords: '机械 吊机 挖机 桩机 配置 台账 姿态 传感器' },
    { tab: 'rail-safety', title: '邻近营业线管控', keywords: '铁路 限界 防护人员 倾覆 风险 侵限' },
    { tab: 'monitoring', title: '基坑监测', keywords: '基坑 围护 支撑 监测点 读数 趋势' },
  ] },
  { id: 'inspection', title: '巡检融合中心', description: '视频融合、巡检记录与取证', entries: [
    { tab: 'videoar', title: '视频 AR', keywords: '视频 无人机 航迹 相机 校准 配准 投影 融合 抽帧' },
    { action: 'inspection', title: '巡检与取证', keywords: '巡检 任务 录像 照片 取证 问题 对比' },
  ] },
  { id: 'presentation', title: '展示汇报中心', description: '项目总览、沙盘与三维汇报', entries: [
    { tab: 'overview', title: '平台总览', keywords: '项目 总览 统计 汇总' },
    { tab: 'sandtable', title: '电子沙盘', keywords: '沙盘 展示 视角 巡游' },
    { tab: 'report', title: '三维汇报', keywords: '报告 汇报 演示 截图 动画 视频 导出' },
  ] },
];

export function matchesFunctionEntry(center: FunctionCenter, entry: FunctionCenterEntry, query: string): boolean {
  const haystack = `${center.title} ${entry.title} ${entry.keywords}`.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}

export function centerForTab(tab: string): FunctionCenterId | undefined {
  return FUNCTION_CENTERS.find(center => center.entries.some(entry => entry.tab === tab))?.id;
}

export interface FunctionCentersOptions {
  /** Return false when a draft, permissions or the current workspace blocks navigation. */
  onAction: (action: FunctionCenterAction) => boolean | Promise<boolean>;
  onError?: (error: unknown) => void;
}

export interface FunctionCentersController {
  openCenter: (id: FunctionCenterId) => void;
  setActiveAction: (action?: FunctionCenterAction) => void;
  dispose: () => void;
}

const installations = new WeakMap<HTMLElement, FunctionCentersController>();

/** Retains the original tab nodes, listeners and data-tab selectors; never owns panel lifecycle. */
export function installFunctionCenters(nav: HTMLElement, options: FunctionCentersOptions): FunctionCentersController {
  const installed = installations.get(nav);
  if (installed) return installed;
  const doc = nav.ownerDocument;
  const shell = nav.closest<HTMLElement>('.shell');
  const header = nav.closest<HTMLElement>('.app-header');
  if (!shell || !header) throw new Error('功能中心需要现有工作台导航。');
  const originalNodes = [...nav.childNodes];
  const originalId = nav.id;
  const originalLabel = nav.getAttribute('aria-label');
  const tabs = new Map([...nav.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')].map(tab => [tab.dataset.tab!, tab]));
  const marker = doc.createComment('Original workbench navigation');
  nav.before(marker);
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'function-centers-toggle';
  toggle.textContent = '功能中心';
  toggle.setAttribute('aria-expanded', 'false');
  if (!nav.id) nav.id = 'workbenchFunctionCenters';
  toggle.setAttribute('aria-controls', nav.id);
  marker.after(toggle);
  nav.classList.add('function-centers');
  nav.setAttribute('aria-label', '功能中心');
  nav.replaceChildren();
  shell.append(nav);
  shell.classList.add('with-function-centers');

  const heading = doc.createElement('div');
  heading.className = 'function-centers-heading';
  const title = doc.createElement('strong'); title.textContent = '功能中心';
  const close = doc.createElement('button');
  close.type = 'button'; close.className = 'function-centers-close'; close.textContent = '×'; close.setAttribute('aria-label', '收起功能中心');
  heading.append(title, close);
  const searchLabel = doc.createElement('label');
  searchLabel.className = 'function-centers-search';
  const searchText = doc.createElement('span'); searchText.textContent = '搜索功能';
  const search = doc.createElement('input');
  search.type = 'search'; search.placeholder = '搜索功能，如机械、便道'; search.autocomplete = 'off';
  searchLabel.append(searchText, search);
  const groupsHost = doc.createElement('div'); groupsHost.className = 'function-centers-groups';
  const empty = doc.createElement('p'); empty.className = 'function-centers-empty'; empty.textContent = '没有匹配的功能，请换一个关键词。'; empty.hidden = true; empty.setAttribute('role', 'status');
  const current = doc.createElement('p'); current.className = 'function-centers-current'; current.setAttribute('aria-live', 'polite');
  nav.append(heading, searchLabel, groupsHost, empty, current);

  const groups = new Map<FunctionCenterId, HTMLDetailsElement>();
  const entries: { center: FunctionCenter; definition: FunctionCenterEntry; button: HTMLButtonElement; row: HTMLDivElement }[] = [];
  let activeAction: FunctionCenterAction | undefined;
  let disposed = false;
  let actionPending = false;
  let navigationRevision = 0;
  let searchExpanded: Map<FunctionCenterId, boolean> | undefined;

  const setDrawer = (open: boolean, restoreFocus = false) => {
    const focusWasInside = nav.contains(doc.activeElement);
    shell.classList.toggle('function-centers-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (!open && (restoreFocus || focusWasInside) && toggle.getClientRects().length) toggle.focus();
  };
  const refreshCurrent = () => {
    const activeTab = [...tabs.values()].find(tab => tab.classList.contains('active'));
    const activeEntry = entries.find(({ definition, button }) => activeAction ? definition.action === activeAction : button === activeTab);
    nav.classList.toggle('has-action-selection', Boolean(activeAction));
    for (const [id, group] of groups) group.classList.toggle('has-current', activeEntry?.center.id === id);
    for (const { definition, button } of entries) if (definition.action) {
      button.classList.toggle('is-current', definition.action === activeAction);
      if (definition.action === activeAction) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    current.textContent = activeEntry ? `当前：${activeEntry.definition.title}` : '选择一个功能开始';
    if (activeEntry) groups.get(activeEntry.center.id)!.open = true;
  };

  for (const center of FUNCTION_CENTERS) {
    const details = doc.createElement('details'); details.className = 'function-center'; details.dataset.center = center.id;
    const summary = doc.createElement('summary');
    const centerTitle = doc.createElement('span'); centerTitle.textContent = center.title;
    const count = doc.createElement('small'); count.className = 'function-center-count';
    summary.append(centerTitle, count);
    const description = doc.createElement('p'); description.textContent = center.description; description.className = 'function-center-description';
    const list = doc.createElement('div'); list.className = 'function-center-entries';
    details.append(summary, description, list); groups.set(center.id, details); groupsHost.append(details);
    for (const definition of center.entries) {
      let button: HTMLButtonElement;
      if (definition.tab) {
        const existing = tabs.get(definition.tab);
        if (!existing) continue;
        button = existing;
      } else {
        button = doc.createElement('button'); button.type = 'button'; button.className = 'function-center-action';
        button.dataset.centerAction = definition.action;
        button.textContent = definition.title;
        button.addEventListener('click', async () => {
          if (actionPending || disposed) return;
          actionPending = true; button.setAttribute('aria-busy', 'true');
          const revision = navigationRevision;
          try {
            const opened = await options.onAction(definition.action!);
            if (opened && !disposed && revision === navigationRevision) {
              activeAction = definition.action;
              refreshCurrent();
              setDrawer(false);
            }
          } catch (error) { options.onError?.(error); }
          finally { actionPending = false; button.removeAttribute('aria-busy'); }
        });
      }
      button.dataset.functionCenter = center.id;
      const row = doc.createElement('div'); row.className = 'function-center-entry'; row.append(button);
      list.append(row); entries.push({ center, definition, button, row });
    }
    count.textContent = String(list.childElementCount);
  }
  // Keep unknown future tabs reachable until explicitly assigned, without inventing a seventh center.
  const retained = [...tabs.values()].filter(tab => !tab.parentElement?.classList.contains('function-center-entry'));
  if (retained.length) {
    const unassigned = doc.createElement('div'); unassigned.className = 'function-centers-unassigned';
    const label = doc.createElement('strong'); label.textContent = '其他工具'; unassigned.append(label, ...retained); groupsHost.append(unassigned);
  }

  const filter = () => {
    const searching = Boolean(search.value.trim());
    if (searching && !searchExpanded) searchExpanded = new Map([...groups].map(([id, group]) => [id, group.open]));
    for (const { center, definition, row } of entries) row.hidden = !matchesFunctionEntry(center, definition, search.value);
    let total = 0;
    for (const [id, group] of groups) {
      const count = entries.filter(entry => entry.center.id === id && !entry.row.hidden && !entry.button.hidden).length;
      group.hidden = count === 0;
      group.querySelector('.function-center-count')!.textContent = String(count);
      if (searching && count) group.open = true;
      else if (!searching && searchExpanded) group.open = searchExpanded.get(id) ?? false;
      total += count;
    }
    empty.hidden = total > 0;
    if (!searching) searchExpanded = undefined;
  };
  const syncTab = () => {
    if (disposed) return;
    ++navigationRevision;
    const activeTab = [...tabs.values()].find(tab => tab.classList.contains('active'));
    activeAction = undefined;
    if (entries.find(entry => entry.button === activeTab)?.row.hidden) { search.value = ''; filter(); }
    refreshCurrent();
    setDrawer(false);
  };
  const observer = new MutationObserver(syncTab);
  for (const tab of tabs.values()) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
  const onToggle = () => { const open = !shell.classList.contains('function-centers-open'); setDrawer(open); if (open) search.focus(); };
  const onClose = () => setDrawer(false, true);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (search.value) { search.value = ''; filter(); search.focus(); }
      else setDrawer(false, true);
    } else if (event.key === 'Enter' && event.target === search) {
      const matches = entries.filter(entry => !entry.row.hidden && !entry.button.hidden && !entry.button.disabled);
      if (matches.length === 1) { event.preventDefault(); matches[0].button.click(); }
    }
  };
  toggle.addEventListener('click', onToggle); close.addEventListener('click', onClose);
  search.addEventListener('input', filter); nav.addEventListener('keydown', onKey);
  syncTab();
  const controller: FunctionCentersController = {
    openCenter(id) {
      search.value = ''; filter();
      const group = groups.get(id);
      if (group) { group.open = true; setDrawer(true); group.querySelector('summary')?.focus(); }
    },
    setActiveAction(action) {
      ++navigationRevision;
      activeAction = action;
      const target = entries.find(entry => action ? entry.definition.action === action : entry.button.classList.contains('active'));
      if (target?.row.hidden) { search.value = ''; filter(); }
      refreshCurrent();
    },
    dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect();
      toggle.removeEventListener('click', onToggle); close.removeEventListener('click', onClose);
      search.removeEventListener('input', filter); nav.removeEventListener('keydown', onKey);
      for (const tab of tabs.values()) delete tab.dataset.functionCenter;
      nav.replaceChildren(...originalNodes); marker.replaceWith(nav); toggle.remove();
      nav.classList.remove('function-centers', 'has-action-selection'); nav.id = originalId;
      if (originalLabel === null) nav.removeAttribute('aria-label'); else nav.setAttribute('aria-label', originalLabel);
      shell.classList.remove('with-function-centers', 'function-centers-open');
      installations.delete(nav);
    },
  };
  installations.set(nav, controller);
  return controller;
}
