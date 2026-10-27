/** Presentation-only grouping. Existing elements, event listeners and form values are retained. */
export type PanelCategory = { id: string; title: string; selectors?: string[]; range?: [string, string] };

function directChild(root: HTMLElement, selector: string): HTMLElement | undefined {
  let node = root.querySelector<HTMLElement>(selector);
  while (node?.parentElement && node.parentElement !== root) node = node.parentElement;
  return node?.parentElement === root ? node : undefined;
}

/** Adds an accordion and a compact category directory without cloning any controls. */
export function categorizePanel(root: HTMLElement, categories: readonly PanelCategory[]): void {
  if (root.dataset.operationCategories === 'ready') return;
  const original = [...root.children] as HTMLElement[], assigned = new Set<HTMLElement>();
  const resolved = categories.map(category => {
    const nodes = new Set<HTMLElement>();
    for (const selector of category.selectors || []) {
      const node = directChild(root, selector); if (node) nodes.add(node);
    }
    if (category.range) {
      const first = directChild(root, category.range[0]), last = directChild(root, category.range[1]);
      const start = first ? original.indexOf(first) : -1, end = last ? original.indexOf(last) : -1;
      if (start >= 0 && end >= start) for (const node of original.slice(start, end + 1)) nodes.add(node);
    }
    const ordered = original.filter(node => nodes.has(node) && !assigned.has(node));
    for (const node of ordered) assigned.add(node);
    return { ...category, nodes: ordered };
  }).filter(category => category.nodes.length);
  // A short panel does not need a second navigation layer.
  if (resolved.length < 2) return;
  root.dataset.operationCategories = 'ready';
  const nav = document.createElement('nav'); nav.className = 'operation-categories'; nav.setAttribute('aria-label', '操作与数据分类');
  const groups: HTMLDetailsElement[] = [], buttons: HTMLButtonElement[] = [];
  const firstNode = original.find(node => assigned.has(node))!;
  root.insertBefore(nav, firstNode);
  for (const [index, category] of resolved.entries()) {
    const group = document.createElement('details'); group.className = 'operation-category'; group.dataset.operationCategory = category.id;
    group.id = `operation-${root.dataset.panel || root.id || 'panel'}-${category.id}`;
    const summary = document.createElement('summary'); summary.textContent = category.title;
    const body = document.createElement('div'); body.className = 'operation-category-body';
    group.append(summary, body); root.insertBefore(group, category.nodes[0]);
    for (const node of category.nodes) body.append(node);
    group.open = index === 0;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = category.title;
    button.setAttribute('aria-controls', group.id); button.setAttribute('aria-expanded', String(group.open));
    nav.append(button); groups.push(group); buttons.push(button);
    button.addEventListener('click', () => {
      groups.forEach(candidate => { candidate.open = candidate === group; });
      // Scroll only this panel's directory; never move or reset the Cesium scene.
      nav.scrollIntoView({ block: 'nearest' });
    });
    group.addEventListener('toggle', () => {
      if (group.open) groups.forEach(candidate => { if (candidate !== group) candidate.open = false; });
      groups.forEach((candidate, i) => buttons[i].setAttribute('aria-expanded', String(candidate.open)));
    });
  }
  // Native validation must still be able to reveal a required field in a folded category.
  root.addEventListener('invalid', event => revealPanelControl(event.target as HTMLElement), true);
}

export function revealPanelControl(control: HTMLElement): void {
  const parents: HTMLDetailsElement[] = [];
  for (let node = control.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') parents.push(node as HTMLDetailsElement);
  for (const detail of parents.reverse()) detail.open = true;
}

/** Install once after the workbench HTML exists. Dynamic lists keep their original host elements. */
export function installWorkbenchCategories(root: ParentNode = document): void {
  const install = (selector: string, groups: PanelCategory[]) => { const panel = root.querySelector<HTMLElement>(selector); if (panel) categorizePanel(panel, groups); };
  install('[data-panel="cad"]', [
    { id: 'source', title: '图纸导入', selectors: ['#cadDropzone', '#dwgStatus'] },
    { id: 'position', title: '坐标定位', selectors: ['#cadMode', '#localFields', '#crsFields', '#gaussFields'] },
    { id: 'display', title: '贴合与高程', selectors: ['#cadDisplayMode', '#cadDisplayHint'] },
  ]);
  install('[data-panel="models"]', [
    { id: 'source', title: '模型导入', selectors: ['#modelDropzone', '#converterStatus'] },
    { id: 'position', title: '位置与坐标', range: ['#modelPlacement', '#modelCoordinateHint'] },
  ]);
  install('[data-panel="tiles"]', [
    { id: 'local', title: '本机成果', range: ['#ccFolderZone', '#ccScanStatus'] },
    { id: 'network', title: '网络成果', range: ['#tilesUrl', '#ionAssetId'] },
    { id: 'display', title: '显示与校正', range: ['#tilesQuality', '#tilesSse'] },
  ]);
  install('[data-panel="videoar"]', [
    { id: 'files', title: '方案与原件', selectors: ['#ccSchemeName', '#ccVideoFile', '#ccXmlFile', '#ccManifestFile'] },
    { id: 'frames', title: '抽帧与定位', selectors: ['#ccExtract', '#ccPosFile', '#ccFirstTime'] },
    { id: 'camera', title: '相机与遮挡', selectors: ['#ccSceneReference', '#ccCameraEnabled', '#ccOcclusionEnabled'] },
    { id: 'objects', title: '对象与微调', range: ['h3', '#ccOpacity'] },
    { id: 'presentation', title: '标注与效果', selectors: ['#ccSpatialEditor', '#ccPresentationEditor'] },
    { id: 'output', title: '缓存与导出', selectors: ['#ccBuildPreview', '#ccPreviewStatus', '#ccExport', '#ccDiagnostics'] },
  ]);
  install('[data-panel="markup"]', [
    { id: 'draw', title: '绘制操作', range: ['.markup-section-title', '.markup-draw-state'] },
    { id: 'style', title: '属性与样式', selectors: ['.markup-properties'] },
    { id: 'data', title: '对象与文件', range: ['#markupListCount', '.markup-file-actions'] },
  ]);
  install('[data-panel="monitoring"]', [
    { id: 'model', title: '基坑与围护', selectors: ['#pitName'] },
    { id: 'supports', title: '支撑布置', selectors: ['#pitHasWaler'] },
    { id: 'points', title: '监测布点', selectors: ['#pitPointName'] },
    { id: 'readings', title: '数据录入', selectors: ['#pitRecordTime', '#pitSupportMonitorName'] },
    { id: 'review', title: '趋势与台账', selectors: ['#pitTrendPoint', '#pitPointList'] },
  ]);
  install('[data-panel="sandtable"]', [
    { id: 'views', title: '视角与巡游', selectors: ['[data-sand-table-focus]', '#sandTableViewpointName', '#sandTableTourInterval'] },
    { id: 'display', title: '图层与效果', selectors: ['#sandTableLayerList', '#sandTableFog', '.sand-presentation-controls'] },
    { id: 'facilities', title: '施工布置', selectors: ['.sand-facility-module'] },
    { id: 'management', title: '进度与风险', selectors: ['#sandProjectControl'] },
  ]);
  // Keep the page selector and its existing hidden-state owner outside the content categories.
  install('#reportSlideEditor', [
    { id: 'content', title: '页面内容', range: ['.editor-title', '#reportShowCard'] },
    { id: 'scene', title: '三维场景', range: ['#reportSceneState', '.report-scene-actions + .hint'] },
    { id: 'composition', title: '画面编排', selectors: ['.report-composer-panel'] },
    { id: 'media', title: '图片与视频', range: ['.report-section-title:has(+ label > #reportMediaType)', '#reportClearMedia'] },
    { id: 'annotations', title: '空间标注', range: ['#reportAnnotationState', '#reportAnnotationList'] },
  ]);
}
