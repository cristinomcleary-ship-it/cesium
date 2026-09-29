import { Cartesian3, type Viewer } from "cesium";
import { electronicSandTablePresentationControlsHtml } from "./electronicSandTablePresentation";
import { sandTableFacilitiesHtml } from "./sandTableFacilities";
import { sandTableProjectControlHtml } from "./sandTableProjectControl";

export type SandTableLayer = Readonly<{
  id: string;
  name: string;
  kind: string;
  visible: boolean;
}>;

export type SandTableFocusMode = "fit" | "top" | "oblique" | "home";
export type SandTableTourState = "stopped" | "running" | "paused";

export type SandTableViewpoint = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  position: Readonly<{ x: number; y: number; z: number }>;
  heading: number;
  pitch: number;
  roll: number;
}>;

export type ElectronicSandTableOverviewSnapshot = Readonly<{
  totalLayers: number;
  visibleLayers: number;
  hiddenLayers: number;
  savedViewpoints: number;
  tourState: SandTableTourState;
  tourIntervalSeconds: number;
  environment: Readonly<{
    fog: boolean;
    lighting: boolean;
    shadows: boolean;
  }>;
  layers: ReadonlyArray<SandTableLayer>;
  viewpoints: ReadonlyArray<Readonly<Pick<SandTableViewpoint, "id" | "name" | "createdAt">>>;
}>;

export type ElectronicSandTableOverviewListener = (
  snapshot: ElectronicSandTableOverviewSnapshot,
) => void;

export type ElectronicSandTableOptions = {
  getLayers: () => readonly SandTableLayer[];
  setLayerVisibility: (id: string, visible: boolean) => void | Promise<void>;
  locateLayer: (id: string) => void | Promise<void>;
  focusScene: (mode: SandTableFocusMode) => void | Promise<void>;
  root?: ParentNode;
  storageKey?: string;
};

export const electronicSandTablePanelHtml = `
  <section class="panel sand-table-panel" data-panel="sandtable">
    <div class="sand-table-heading">
      <div>
        <strong>电子沙盘</strong>
        <small>PROJECT SITUATION SANDBOX</small>
      </div>
      <span id="sandTableStatus" class="sand-table-status" aria-live="polite">场景已就绪</span>
    </div>

    <div class="sand-table-section">
      <div class="sand-table-section-heading">
        <strong>快捷视角</strong>
        <span>快速掌握项目全局</span>
      </div>
      <div class="sand-table-focus-grid">
        <button type="button" data-sand-table-focus="fit">全景适配</button>
        <button type="button" data-sand-table-focus="top">正射俯视</button>
        <button type="button" data-sand-table-focus="oblique">工程斜视</button>
        <button type="button" data-sand-table-focus="home">数字地球</button>
      </div>
    </div>

    <div class="sand-table-section">
      <div class="sand-table-section-heading">
        <strong>图层态势</strong>
        <span id="sandTableLayerCount">0 个图层</span>
      </div>
      <div id="sandTableLayerList" class="sand-table-layer-list"></div>
      <p id="sandTableLayerEmpty" class="sand-table-empty">暂无已加载图层</p>
    </div>

    <div class="sand-table-section">
      <div class="sand-table-section-heading">
        <strong>收藏视点</strong>
        <span id="sandTableViewpointCount">0 个视点</span>
      </div>
      <div class="sand-table-save-row">
        <input id="sandTableViewpointName" type="text" maxlength="60" placeholder="输入视点名称（可选）" />
        <button id="sandTableSaveViewpoint" type="button">保存当前视点</button>
      </div>
      <div id="sandTableViewpointList" class="sand-table-viewpoint-list"></div>
      <p id="sandTableViewpointEmpty" class="sand-table-empty">尚未收藏视点</p>
    </div>

    <div class="sand-table-section">
      <div class="sand-table-section-heading">
        <strong>自动巡游</strong>
        <span id="sandTableTourState">已停止</span>
      </div>
      <label class="sand-table-interval">
        <span>视点间隔</span>
        <input id="sandTableTourInterval" type="number" min="3" max="30" step="1" value="6" />
        <span>秒</span>
      </label>
      <div class="sand-table-tour-actions">
        <button id="sandTableTourStart" type="button">开始 / 继续</button>
        <button id="sandTableTourPause" type="button">暂停</button>
        <button id="sandTableTourStop" type="button">停止</button>
      </div>
    </div>

    <div class="sand-table-section">
      <div class="sand-table-section-heading">
        <strong>场景效果</strong>
        <span>轻量渲染开关</span>
      </div>
      <div class="sand-table-scene-options">
        <label><input id="sandTableFog" type="checkbox" /> 雾化效果</label>
        <label><input id="sandTableLighting" type="checkbox" /> 太阳光照</label>
        <label><input id="sandTableShadows" type="checkbox" /> 场景阴影</label>
      </div>
    </div>
    ${electronicSandTablePresentationControlsHtml}
    ${sandTableFacilitiesHtml}
    ${sandTableProjectControlHtml}
  </section>
`;

const DEFAULT_STORAGE_KEY = "cesium-electronic-sand-table-viewpoints-v1";
const MAX_LAYERS = 500;
const MAX_VIEWPOINTS = 30;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 60;
const MAX_KIND_LENGTH = 40;
const MIN_TOUR_INTERVAL_SECONDS = 3;
const MAX_TOUR_INTERVAL_SECONDS = 30;

type MutableViewpoint = {
  id: string;
  name: string;
  createdAt: string;
  position: { x: number; y: number; z: number };
  heading: number;
  pitch: number;
  roll: number;
};

function limitedString(value: unknown, limit: number, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, limit) || fallback : fallback;
}

function finiteNumber(value: unknown, maximumAbsoluteValue = 1e12): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= maximumAbsoluteValue;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}

function cloneViewpoint(viewpoint: MutableViewpoint): SandTableViewpoint {
  return {
    ...viewpoint,
    position: { ...viewpoint.position },
  };
}

function safeViewpoint(value: unknown, usedIds: Set<string>): MutableViewpoint | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const position = source.position;
  if (!position || typeof position !== "object") return null;
  const coordinate = position as Record<string, unknown>;
  if (
    !finiteNumber(coordinate.x) ||
    !finiteNumber(coordinate.y) ||
    !finiteNumber(coordinate.z) ||
    !finiteNumber(source.heading, 1000) ||
    !finiteNumber(source.pitch, 1000) ||
    !finiteNumber(source.roll, 1000)
  ) {
    return null;
  }
  const id = limitedString(source.id, MAX_ID_LENGTH);
  if (!id || usedIds.has(id)) return null;
  usedIds.add(id);
  const createdAtValue = limitedString(source.createdAt, 40);
  const createdAt = Number.isFinite(new Date(createdAtValue).getTime())
    ? new Date(createdAtValue).toISOString()
    : new Date().toISOString();
  return {
    id,
    name: limitedString(source.name, MAX_NAME_LENGTH, "未命名视点"),
    createdAt,
    position: { x: coordinate.x, y: coordinate.y, z: coordinate.z },
    heading: source.heading,
    pitch: source.pitch,
    roll: source.roll,
  };
}

function createId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // A deterministic-looking fallback is sufficient for a local-only collection id.
  }
  return `sand-view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return "";
  }
}

export class ElectronicSandTable {
  private readonly viewer: Viewer;
  private readonly options: ElectronicSandTableOptions;
  private readonly root: ParentNode;
  private readonly storageKey: string;
  private readonly cleanups: Array<() => void> = [];
  private readonly overviewListeners = new Set<ElectronicSandTableOverviewListener>();
  private layers: SandTableLayer[] = [];
  private viewpoints: MutableViewpoint[] = [];
  private tourState: SandTableTourState = "stopped";
  private tourIndex = 0;
  private tourTimer: number | undefined;
  private tourFlightActive = false;
  private disposed = false;

  constructor(viewer: Viewer, options: ElectronicSandTableOptions) {
    this.viewer = viewer;
    this.options = options;
    this.root = options.root ?? document;
    this.storageKey = limitedString(options.storageKey, 100, DEFAULT_STORAGE_KEY);
    this.viewpoints = this.loadViewpoints();
    this.bindUi();
    this.listen(document, "visibilitychange", () => {
      if (document.hidden) this.pauseTour();
    });
    this.applyInitialSceneStateToUi();
    this.renderViewpoints();
    this.refreshLayers();
    this.renderTourState();
  }

  refreshLayers() {
    if (this.disposed) return;
    const unique = new Set<string>();
    const next: SandTableLayer[] = [];
    try {
      const source = this.options.getLayers();
      if (Array.isArray(source)) {
        for (const item of source.slice(0, MAX_LAYERS)) {
          const id = limitedString(item?.id, MAX_ID_LENGTH);
          if (!id || unique.has(id)) continue;
          unique.add(id);
          next.push({
            id,
            name: limitedString(item?.name, MAX_NAME_LENGTH, "未命名图层"),
            kind: limitedString(item?.kind, MAX_KIND_LENGTH, "其他"),
            visible: item?.visible === true,
          });
        }
      }
    } catch (error) {
      this.setStatus("图层状态读取失败");
      this.logIsolatedError("读取图层", error);
    }
    this.layers = next;
    this.renderLayers();
    this.applyInitialSceneStateToUi();
    this.notifyOverview();
  }

  getOverviewSnapshot(): ElectronicSandTableOverviewSnapshot {
    const visibleLayers = this.layers.reduce((count, layer) => count + (layer.visible ? 1 : 0), 0);
    return Object.freeze({
      totalLayers: this.layers.length,
      visibleLayers,
      hiddenLayers: this.layers.length - visibleLayers,
      savedViewpoints: this.viewpoints.length,
      tourState: this.tourState,
      tourIntervalSeconds: this.readTourInterval(),
      environment: Object.freeze(this.readEnvironment()),
      layers: Object.freeze(this.layers.map((layer) => Object.freeze({ ...layer }))),
      viewpoints: Object.freeze(
        this.viewpoints.map((viewpoint) =>
          Object.freeze({ id: viewpoint.id, name: viewpoint.name, createdAt: viewpoint.createdAt }),
        ),
      ),
    });
  }

  subscribeOverview(listener: ElectronicSandTableOverviewListener) {
    if (this.disposed) return () => undefined;
    this.overviewListeners.add(listener);
    try {
      listener(this.getOverviewSnapshot());
    } catch (error) {
      this.logIsolatedError("电子沙盘概览订阅", error);
    }
    return () => this.overviewListeners.delete(listener);
  }

  saveCurrentViewpoint(name?: string): SandTableViewpoint | null {
    if (this.disposed) return null;
    try {
      const camera = this.viewer.camera;
      const position = camera.positionWC;
      if (
        !finiteNumber(position.x) ||
        !finiteNumber(position.y) ||
        !finiteNumber(position.z) ||
        !finiteNumber(camera.heading, 1000) ||
        !finiteNumber(camera.pitch, 1000) ||
        !finiteNumber(camera.roll, 1000)
      ) {
        this.setStatus("当前相机姿态无效，未保存");
        return null;
      }
      const viewpoint: MutableViewpoint = {
        id: createId(),
        name: limitedString(name, MAX_NAME_LENGTH, `视点 ${this.viewpoints.length + 1}`),
        createdAt: new Date().toISOString(),
        position: { x: position.x, y: position.y, z: position.z },
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
      };
      this.viewpoints = [viewpoint, ...this.viewpoints].slice(0, MAX_VIEWPOINTS);
      this.persistViewpoints();
      this.renderViewpoints();
      this.renderTourState();
      this.setStatus(`已保存“${viewpoint.name}”`);
      this.notifyOverview();
      return cloneViewpoint(viewpoint);
    } catch (error) {
      this.setStatus("保存视点失败");
      this.logIsolatedError("保存视点", error);
      return null;
    }
  }

  locateViewpoint(id: string) {
    if (this.disposed) return;
    const viewpoint = this.viewpoints.find((item) => item.id === id);
    if (!viewpoint) {
      this.setStatus("视点已不存在");
      return;
    }
    this.flyToViewpoint(viewpoint, false);
  }

  deleteViewpoint(id: string) {
    if (this.disposed) return;
    const next = this.viewpoints.filter((item) => item.id !== id);
    if (next.length === this.viewpoints.length) return;
    this.viewpoints = next;
    this.tourIndex = Math.min(this.tourIndex, Math.max(0, next.length - 1));
    if (!next.length) this.stopTour();
    this.persistViewpoints();
    this.renderViewpoints();
    this.renderTourState();
    this.setStatus("已删除收藏视点");
    this.notifyOverview();
  }

  startTour() {
    if (this.disposed) return;
    if (!this.viewpoints.length) {
      this.setStatus("请先保存至少一个视点");
      return;
    }
    if (this.tourState === "running") return;
    if (this.tourState === "stopped") this.tourIndex = 0;
    this.tourState = "running";
    this.renderTourState();
    this.notifyOverview();
    this.scheduleTour(0);
  }

  pauseTour() {
    if (this.disposed || this.tourState !== "running") return;
    this.tourState = "paused";
    this.clearTourTimer();
    this.cancelTourFlight();
    this.renderTourState();
    this.setStatus("巡游已暂停");
    this.notifyOverview();
  }

  stopTour() {
    if (this.disposed) return;
    const changed = this.tourState !== "stopped" || this.tourIndex !== 0;
    this.tourState = "stopped";
    this.tourIndex = 0;
    this.clearTourTimer();
    this.cancelTourFlight();
    this.renderTourState();
    if (changed) {
      this.setStatus("巡游已停止");
      this.notifyOverview();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.tourState = "stopped";
    this.clearTourTimer();
    this.cancelTourFlight();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Disposing one listener must not block the remaining cleanup.
      }
    }
    this.overviewListeners.clear();
    this.disposed = true;
  }

  private bindUi() {
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-sand-table-focus]")) {
      this.listen(button, "click", () => {
        const mode = button.dataset.sandTableFocus;
        if (mode === "fit" || mode === "top" || mode === "oblique" || mode === "home") {
          this.prepareManualCameraAction();
          this.invokeAction(() => this.options.focusScene(mode), `正在切换到${this.focusLabel(mode)}`);
        }
      });
    }

    const layerList = this.node<HTMLElement>("sandTableLayerList");
    if (layerList) {
      this.listen(layerList, "change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.dataset.sandTableLayerToggle !== "true") return;
        const id = target.dataset.sandTableLayerId ?? "";
        target.disabled = true;
        this.invokeAction(
          () => this.options.setLayerVisibility(id, target.checked),
          target.checked ? "正在显示图层" : "正在隐藏图层",
          () => this.refreshLayers(),
        );
      });
      this.listen(layerList, "click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLButtonElement>("button[data-sand-table-layer-locate]");
        if (!button || !layerList.contains(button)) return;
        const id = button.dataset.sandTableLayerId ?? "";
        this.prepareManualCameraAction();
        this.invokeAction(() => this.options.locateLayer(id), "正在定位图层");
      });
    }

    const nameInput = this.node<HTMLInputElement>("sandTableViewpointName");
    const saveButton = this.node<HTMLButtonElement>("sandTableSaveViewpoint");
    if (saveButton) {
      this.listen(saveButton, "click", () => {
        const saved = this.saveCurrentViewpoint(nameInput?.value);
        if (saved && nameInput) nameInput.value = "";
      });
    }
    if (nameInput) {
      this.listen(nameInput, "keydown", (event) => {
        if (event instanceof KeyboardEvent && event.key === "Enter") {
          event.preventDefault();
          const saved = this.saveCurrentViewpoint(nameInput.value);
          if (saved) nameInput.value = "";
        }
      });
    }

    const viewpointList = this.node<HTMLElement>("sandTableViewpointList");
    if (viewpointList) {
      this.listen(viewpointList, "click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLButtonElement>("button[data-sand-table-viewpoint-action]");
        if (!button || !viewpointList.contains(button)) return;
        const id = button.dataset.sandTableViewpointId ?? "";
        if (button.dataset.sandTableViewpointAction === "locate") this.locateViewpoint(id);
        if (button.dataset.sandTableViewpointAction === "delete") this.deleteViewpoint(id);
      });
    }

    this.listenOptional("sandTableTourStart", "click", () => this.startTour());
    this.listenOptional("sandTableTourPause", "click", () => this.pauseTour());
    this.listenOptional("sandTableTourStop", "click", () => this.stopTour());
    this.listenOptional("sandTableTourInterval", "change", () => {
      const input = this.node<HTMLInputElement>("sandTableTourInterval");
      if (input) input.value = String(this.readTourInterval());
      this.notifyOverview();
    });

    this.bindSceneToggle("sandTableFog", (enabled) => {
      this.viewer.scene.fog.enabled = enabled;
    });
    this.bindSceneToggle("sandTableLighting", (enabled) => {
      this.viewer.scene.globe.enableLighting = enabled;
    });
    this.bindSceneToggle("sandTableShadows", (enabled) => {
      this.viewer.shadows = enabled;
    });
  }

  private bindSceneToggle(id: string, apply: (enabled: boolean) => void) {
    const input = this.node<HTMLInputElement>(id);
    if (!input) return;
    this.listen(input, "change", () => {
      try {
        apply(input.checked);
        this.viewer.scene.requestRender();
        this.setStatus("场景效果已更新");
      } catch (error) {
        this.setStatus("场景效果切换失败");
        this.logIsolatedError("场景效果", error);
        this.applyInitialSceneStateToUi();
      }
      this.notifyOverview();
    });
  }

  private applyInitialSceneStateToUi() {
    try {
      const environment = this.readEnvironment();
      const fog = this.node<HTMLInputElement>("sandTableFog");
      const lighting = this.node<HTMLInputElement>("sandTableLighting");
      const shadows = this.node<HTMLInputElement>("sandTableShadows");
      if (fog) fog.checked = environment.fog;
      if (lighting) lighting.checked = environment.lighting;
      if (shadows) shadows.checked = environment.shadows;
    } catch (error) {
      this.logIsolatedError("读取场景效果", error);
    }
  }

  private readEnvironment() {
    return {
      fog: this.viewer.scene.fog.enabled === true,
      lighting: this.viewer.scene.globe.enableLighting === true,
      shadows: this.viewer.shadows === true,
    };
  }

  private renderLayers() {
    const list = this.node<HTMLElement>("sandTableLayerList");
    const count = this.node<HTMLElement>("sandTableLayerCount");
    const empty = this.node<HTMLElement>("sandTableLayerEmpty");
    if (count) {
      const visible = this.layers.reduce((sum, layer) => sum + (layer.visible ? 1 : 0), 0);
      count.textContent = `${visible}/${this.layers.length} 个可见`;
    }
    if (empty) empty.hidden = this.layers.length > 0;
    if (!list) return;
    const fragment = document.createDocumentFragment();
    for (const layer of this.layers) {
      const row = document.createElement("div");
      row.className = "sand-table-layer-item";
      const toggleLabel = document.createElement("label");
      toggleLabel.className = "sand-table-layer-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = layer.visible;
      checkbox.dataset.sandTableLayerToggle = "true";
      checkbox.dataset.sandTableLayerId = layer.id;
      const text = document.createElement("span");
      text.className = "sand-table-layer-text";
      const name = document.createElement("strong");
      name.textContent = layer.name;
      const kind = document.createElement("small");
      kind.textContent = layer.kind;
      text.append(name, kind);
      toggleLabel.append(checkbox, text);
      const locate = document.createElement("button");
      locate.type = "button";
      locate.className = "sand-table-layer-locate";
      locate.dataset.sandTableLayerLocate = "true";
      locate.dataset.sandTableLayerId = layer.id;
      locate.textContent = "定位";
      row.append(toggleLabel, locate);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  }

  private renderViewpoints() {
    const list = this.node<HTMLElement>("sandTableViewpointList");
    const count = this.node<HTMLElement>("sandTableViewpointCount");
    const empty = this.node<HTMLElement>("sandTableViewpointEmpty");
    if (count) count.textContent = `${this.viewpoints.length} 个视点`;
    if (empty) empty.hidden = this.viewpoints.length > 0;
    if (!list) return;
    const fragment = document.createDocumentFragment();
    for (const viewpoint of this.viewpoints) {
      const row = document.createElement("div");
      row.className = "sand-table-viewpoint-item";
      const details = document.createElement("div");
      details.className = "sand-table-viewpoint-text";
      const name = document.createElement("strong");
      name.textContent = viewpoint.name;
      const date = document.createElement("small");
      date.textContent = formatDate(viewpoint.createdAt);
      details.append(name, date);
      const actions = document.createElement("div");
      actions.className = "sand-table-viewpoint-actions";
      const locate = document.createElement("button");
      locate.type = "button";
      locate.dataset.sandTableViewpointAction = "locate";
      locate.dataset.sandTableViewpointId = viewpoint.id;
      locate.textContent = "定位";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "sand-table-danger";
      remove.dataset.sandTableViewpointAction = "delete";
      remove.dataset.sandTableViewpointId = viewpoint.id;
      remove.textContent = "删除";
      actions.append(locate, remove);
      row.append(details, actions);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  }

  private renderTourState() {
    const state = this.node<HTMLElement>("sandTableTourState");
    if (state) {
      state.textContent =
        this.tourState === "running" ? "巡游中" : this.tourState === "paused" ? "已暂停" : "已停止";
      state.dataset.sandTableTourState = this.tourState;
    }
    const start = this.node<HTMLButtonElement>("sandTableTourStart");
    const pause = this.node<HTMLButtonElement>("sandTableTourPause");
    const stop = this.node<HTMLButtonElement>("sandTableTourStop");
    if (start) start.disabled = this.tourState === "running" || !this.viewpoints.length;
    if (pause) pause.disabled = this.tourState !== "running";
    if (stop) stop.disabled = this.tourState === "stopped";
  }

  private scheduleTour(delayMilliseconds: number) {
    this.clearTourTimer();
    if (this.tourState !== "running" || this.disposed) return;
    this.tourTimer = window.setTimeout(() => {
      this.tourTimer = undefined;
      if (this.tourState !== "running" || !this.viewpoints.length) return;
      this.tourIndex %= this.viewpoints.length;
      const viewpoint = this.viewpoints[this.tourIndex];
      this.tourIndex = (this.tourIndex + 1) % this.viewpoints.length;
      this.flyToViewpoint(viewpoint, true);
    }, Math.max(0, delayMilliseconds));
  }

  private flyToViewpoint(viewpoint: MutableViewpoint, fromTour: boolean) {
    if (!fromTour) this.prepareManualCameraAction();
    const intervalSeconds = this.readTourInterval();
    const durationSeconds = fromTour ? Math.min(2.5, Math.max(0.8, intervalSeconds * 0.4)) : 1.8;
    if (fromTour) this.tourFlightActive = true;
    const finish = () => {
      if (fromTour) this.tourFlightActive = false;
      if (fromTour && this.tourState === "running" && !this.disposed) {
        this.scheduleTour(Math.max(250, (intervalSeconds - durationSeconds) * 1000));
      }
    };
    try {
      this.viewer.camera.flyTo({
        destination: new Cartesian3(viewpoint.position.x, viewpoint.position.y, viewpoint.position.z),
        orientation: {
          heading: viewpoint.heading,
          pitch: viewpoint.pitch,
          roll: viewpoint.roll,
        },
        duration: durationSeconds,
        complete: () => {
          this.setStatus(fromTour ? `巡游：${viewpoint.name}` : `已定位到“${viewpoint.name}”`);
          finish();
        },
        cancel: finish,
      });
    } catch (error) {
      this.tourFlightActive = false;
      this.setStatus("视点定位失败");
      this.logIsolatedError("视点定位", error);
      if (fromTour && this.tourState === "running") this.scheduleTour(intervalSeconds * 1000);
    }
  }

  private cancelTourFlight() {
    if (!this.tourFlightActive) return;
    this.tourFlightActive = false;
    try {
      this.viewer.camera.cancelFlight();
    } catch (error) {
      this.logIsolatedError("取消巡游镜头", error);
    }
  }

  private prepareManualCameraAction() {
    if (this.tourState === "running") {
      this.pauseTour();
      return;
    }
    try {
      this.viewer.camera.cancelFlight();
    } catch (error) {
      this.logIsolatedError("切换镜头", error);
    }
  }

  private clearTourTimer() {
    if (this.tourTimer === undefined) return;
    window.clearTimeout(this.tourTimer);
    this.tourTimer = undefined;
  }

  private readTourInterval() {
    const input = this.node<HTMLInputElement>("sandTableTourInterval");
    return clampInteger(
      input?.value,
      MIN_TOUR_INTERVAL_SECONDS,
      MAX_TOUR_INTERVAL_SECONDS,
      6,
    );
  }

  private loadViewpoints() {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw || raw.length > 500_000) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const usedIds = new Set<string>();
      const result: MutableViewpoint[] = [];
      for (const value of parsed.slice(0, MAX_VIEWPOINTS)) {
        const viewpoint = safeViewpoint(value, usedIds);
        if (viewpoint) result.push(viewpoint);
      }
      return result;
    } catch (error) {
      this.logIsolatedError("读取本机视点", error);
      return [];
    }
  }

  private persistViewpoints() {
    try {
      globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(this.viewpoints.slice(0, MAX_VIEWPOINTS)));
    } catch (error) {
      this.setStatus("视点已保留在本次页面，本机保存失败");
      this.logIsolatedError("保存本机视点", error);
    }
  }

  private invokeAction(
    action: () => void | Promise<void>,
    pendingMessage: string,
    complete?: () => void,
  ) {
    if (this.disposed) return;
    this.setStatus(pendingMessage);
    try {
      const result = action();
      Promise.resolve(result)
        .then(() => {
          if (this.disposed) return;
          this.setStatus("操作完成");
          complete?.();
        })
        .catch((error: unknown) => {
          if (this.disposed) return;
          this.setStatus("操作失败，请重试");
          this.logIsolatedError("沙盘操作", error);
          complete?.();
        });
    } catch (error) {
      this.setStatus("操作失败，请重试");
      this.logIsolatedError("沙盘操作", error);
      complete?.();
    }
  }

  private focusLabel(mode: SandTableFocusMode) {
    if (mode === "fit") return "全景视角";
    if (mode === "top") return "俯视视角";
    if (mode === "oblique") return "斜视视角";
    return "数字地球视角";
  }

  private notifyOverview() {
    if (this.disposed || !this.overviewListeners.size) return;
    const snapshot = this.getOverviewSnapshot();
    for (const listener of this.overviewListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logIsolatedError("电子沙盘概览通知", error);
      }
    }
  }

  private setStatus(message: string) {
    const status = this.node<HTMLElement>("sandTableStatus");
    if (status) status.textContent = limitedString(message, 100, "场景已就绪");
  }

  private node<T extends HTMLElement>(id: string) {
    return this.root.querySelector<T>(`#${id}`);
  }

  private listenOptional(id: string, eventName: string, listener: EventListener) {
    const target = this.node<HTMLElement>(id);
    if (target) this.listen(target, eventName, listener);
  }

  private listen(target: EventTarget, eventName: string, listener: EventListener) {
    target.addEventListener(eventName, listener);
    this.cleanups.push(() => target.removeEventListener(eventName, listener));
  }

  private logIsolatedError(scope: string, error: unknown) {
    try {
      console.warn(`[ElectronicSandTable] ${scope}失败`, error);
    } catch {
      // Diagnostics must never affect the scene.
    }
  }
}
