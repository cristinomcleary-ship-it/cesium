import type { SafetyDataset, SafetyDevice, SafetyNode, SafetySelection, SafetyState, SafetyTrackPoint, SafetyView } from "./safetyTypes.ts";

function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }

/** Interpolation is only for the moving cursor; it never mutates or smooths the measured track. */
export function interpolateDevicePosition(device: SafetyDevice, time: number): SafetyTrackPoint | undefined {
  const track = device.track;
  if (!Number.isFinite(time) || !track.length || time < track[0].time || time > track[track.length - 1].time) return;
  let low = 0; let high = track.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (track[middle].time < time) low = middle + 1; else high = middle; }
  const right = track[low];
  if (right.time === time || low === 0) return { ...right };
  const left = track[low - 1]; const span = right.time - left.time;
  if (span <= 0 || span > 5000 || (left.segment ?? 0) !== (right.segment ?? 0)) return;
  const ratio = (time - left.time) / span;
  let longitudeDelta = right.longitude - left.longitude;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  const longitude = ((left.longitude + longitudeDelta * ratio + 540) % 360) - 180;
  return { longitude, latitude: left.latitude + (right.latitude - left.latitude) * ratio,
    height: left.height + (right.height - left.height) * ratio, time, mediaSeconds: left.mediaSeconds + (right.mediaSeconds - left.mediaSeconds) * ratio, segment: left.segment };
}

export function deriveSafetyView(dataset: SafetyDataset, state: SafetyState): SafetyView {
  const byId = new Map(dataset.nodes.map((node) => [node.id, node]));
  const selected = byId.get(state.selectedId) || byId.get(dataset.projectId) || dataset.nodes[0];
  if (!selected) throw new Error("巡检数据缺少项目节点");
  const ancestors = (node: SafetyNode): SafetyNode[] => {
    const result: SafetyNode[] = []; const seen = new Set<string>(); let current: SafetyNode | undefined = node;
    while (current && !seen.has(current.id)) { seen.add(current.id); result.unshift(current); current = current.parentId ? byId.get(current.parentId) : undefined; }
    return result;
  };
  const inScope = (node: SafetyNode): boolean => ancestors(node).some((parent) => parent.id === selected.id);
  const provenance = (item: { provenance: string }): boolean => state.includeDemo || item.provenance !== "demo";
  const inTime = (timestamp: number): boolean => timestamp >= state.timeRange[0] && timestamp <= state.timeRange[1];
  let nodes = dataset.nodes.filter((node) => inScope(node) && provenance(node));
  const scopeIds = new Set(nodes.map((node) => node.id));
  const alerts = dataset.alerts.filter((alert) => scopeIds.has(alert.nodeId) && provenance(alert) && inTime(alert.timestamp)
    && (state.severity === "all" || alert.severity === state.severity));
  const affected = new Set<string>();
  if (state.severity !== "all") {
    for (const alert of alerts) { const node = byId.get(alert.nodeId); if (node) ancestors(node).forEach((parent) => affected.add(parent.id)); }
    nodes = nodes.filter((node) => affected.has(node.id) || ancestors(node).some((parent) => alerts.some((alert) => alert.nodeId === parent.id)));
  }
  const filteredIds = new Set(nodes.map((node) => node.id));
  const tasks = dataset.tasks.filter((task) => filteredIds.has(task.nodeId) && provenance(task) && inTime(task.timestamp));
  const breadcrumbs = ancestors(selected);
  const ancestorIds = new Set(breadcrumbs.map((node) => node.id));
  const devices = dataset.devices.filter((device) => provenance(device) && (filteredIds.has(device.nodeId) || ancestorIds.has(device.nodeId))
    && (!device.track.length || device.track.some((point, index) => {
      if (inTime(point.time)) return true;
      const next = device.track[index + 1];
      return !!next && (point.segment ?? 0) === (next.segment ?? 0) && next.time - point.time <= 5000
        && point.time <= state.timeRange[1] && next.time >= state.timeRange[0];
    })));
  const selectedAlert = alerts.find((alert) => alert.id === state.selectedAlertId);
  const mediaIds = new Set([...breadcrumbs.flatMap((node) => node.mediaIds), ...selected.mediaIds, ...(selectedAlert?.mediaIds || []),
    ...devices.flatMap((device) => device.mediaId ? [device.mediaId] : [])]);
  return { selected, breadcrumbs, children: nodes.filter((node) => node.parentId === selected.id), nodes, alerts, tasks, devices,
    media: dataset.media.filter((media) => mediaIds.has(media.id) && provenance(media)),
    metrics: { points: nodes.filter((node) => node.kind === "component" && node.componentType === "pile").length,
      alerts: alerts.length, high: alerts.filter((alert) => alert.severity === "high").length,
      completed: tasks.filter((task) => task.status === "complete").length, tasks: tasks.length,
      demoAlerts: alerts.filter((alert) => alert.provenance === "demo").length } };
}

type Listener = (state: SafetyState, view: SafetyView) => void;
export class SafetyStore {
  private _dataset: SafetyDataset;
  private _state: SafetyState;
  private _view: SafetyView;
  private readonly listeners = new Set<Listener>();
  private disposed = false;

  constructor(dataset: SafetyDataset) {
    this._dataset = dataset;
    this._state = { selectedId: dataset.projectId, mode: "presentation", severity: "all", timeRange: [...dataset.timeExtent],
      time: dataset.timeExtent[0], playing: false, includeDemo: true, heatOpacity: .55, cruise: false,
      layers: { boundary: true, markers: true, track: true, heat: false, effects: true, links: true } };
    this._view = deriveSafetyView(dataset, this._state);
  }
  get dataset(): SafetyDataset { return this._dataset; }
  get state(): SafetyState { return this._state; }
  get view(): SafetyView { return this._view; }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener); listener(this._state, this._view);
    return () => { this.listeners.delete(listener); };
  }

  patch(patch: Partial<SafetyState>): void {
    if (this.disposed) return;
    const [minimum, maximum] = this._dataset.timeExtent;
    const next = { ...this._state, ...patch, layers: { ...this._state.layers, ...patch.layers } };
    const range = patch.timeRange || this._state.timeRange;
    const first = Number.isFinite(range[0]) ? clamp(range[0], minimum, maximum) : minimum;
    const last = Number.isFinite(range[1]) ? clamp(range[1], minimum, maximum) : maximum;
    next.timeRange = [Math.min(first, last), Math.max(first, last)];
    next.time = clamp(Number.isFinite(next.time) ? next.time : minimum, next.timeRange[0], next.timeRange[1]);
    next.heatOpacity = clamp(Number.isFinite(next.heatOpacity) ? next.heatOpacity : .55, 0, 1);
    if (!this._dataset.nodes.some((node) => node.id === next.selectedId && (next.includeDemo || node.provenance !== "demo"))) next.selectedId = this._dataset.projectId;
    this._state = next; this._view = deriveSafetyView(this._dataset, next);
    if (next.selectedAlertId && !this._view.alerts.some((alert) => alert.id === next.selectedAlertId)) {
      this._state = { ...next, selectedAlertId: undefined }; this._view = deriveSafetyView(this._dataset, this._state);
    }
    for (const listener of this.listeners) listener(this._state, this._view);
  }

  select(selection: SafetySelection): void {
    if (!this._dataset.nodes.some((node) => node.id === selection.nodeId)) return;
    const alert = selection.alertId ? this._view.alerts.find((entry) => entry.id === selection.alertId && entry.nodeId === selection.nodeId) : undefined;
    this.patch({ selectedId: selection.nodeId, selectedAlertId: alert?.id });
  }

  setDataset(dataset: SafetyDataset): void {
    if (this.disposed) return;
    this._dataset = dataset;
    this.patch({ timeRange: [...dataset.timeExtent], time: dataset.timeExtent[0], playing: false, selectedAlertId: undefined,
      selectedId: dataset.nodes.some((node) => node.id === this._state.selectedId) ? this._state.selectedId : dataset.projectId });
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
}
