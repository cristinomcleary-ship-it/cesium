import type { Cartesian2, Viewer } from "cesium";
import type { ManagementRecord } from "./managementTypes";
import { MACHINERY_ASSET_VERSION } from "./machineryTypes";
import {
  MACHINERY_CATALOG, loadMachineryAsset, defaultMachineryParameters,
  resolveMachineryParameters, computeMachineryGeometry,
} from "./machinery/index";
import { MachineryScene, readMachineryState, type MachineryState, type MachineryPlacementPick } from "./machineryScene";
import "./machineryPanel.css";

type Asset = Awaited<ReturnType<typeof loadMachineryAsset>>;
type Placement = MachineryState["placement"];
type Draft = Omit<MachineryState, "placement"> & { placement?: Placement };
type BoomAngle = "boom_rotation_deg" | "boom_elevation_deg";

export type MachineryPanelContext = {
  projectId: string;
  actorId?: string;
  records: readonly ManagementRecord[];
  canEdit: boolean;
  canView: boolean;
  /** Whether the existing Cesium scene is active, independently of panel visibility. */
  active: boolean;
};
export type MachineryPanelOptions = {
  viewer: Viewer;
  host: HTMLElement;
  save: (recordId: string, machinery: MachineryState, expectedRevision: number) => Promise<void>;
  remove: (recordId: string, expectedRevision: number) => Promise<void>;
  createResource?: (name: string) => Promise<{ id: string } | void>;
  onPickingChange?: (picking: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  pickPosition?: (position: Cartesian2) => MachineryPlacementPick | undefined;
};

const copy = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const numberValue = (input: HTMLInputElement) => input.value.trim() === "" ? NaN : Number(input.value);
function savedState(record: ManagementRecord | undefined): MachineryState | undefined {
  return readMachineryState(record?.machinery);
}

/** A resource-bound editor. All rendering uses the supplied project Viewer. */
export class MachineryPanel {
  private readonly root = document.createElement("section");
  private readonly events = new AbortController();
  private readonly scene: MachineryScene;
  private context: MachineryPanelContext = { projectId: "", records: [], canEdit: false, canView: false, active: false };
  private opened = false;
  private destroyed = false;
  private dirty = false;
  private busy = false;
  private loading = false;
  private picking = false;
  private generation = 0;
  private previewGeneration = 0;
  private assetAbort?: AbortController;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private selectedId = "";
  private selectedRevision = 0;
  private asset?: Asset;
  private draft?: Draft;
  private editOrder: string[] = [];
  private pendingAction?: () => void;
  private positionSource = "尚未设置位置";

  constructor(private readonly options: MachineryPanelOptions) {
    this.scene = new MachineryScene(options.viewer, {
      pickPosition: options.pickPosition,
      onError: (recordId, message) => {
        if (!this.destroyed && (!this.selectedId || this.selectedId === recordId)) this.message("已保存模型未载入：" + message, true);
      },
    });
    this.root.className = "machinery-panel";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "施工机械编辑");
    this.root.innerHTML = `
      <header class="mp-heading"><div><span class="mp-eyebrow">资源台账 · 三维实例</span><h2>施工机械</h2></div><button type="button" data-action="close" aria-label="关闭机械编辑">关闭</button></header>
      <div class="mp-content">
        <label class="mp-label">机械资源<select data-role="resource" aria-label="选择机械资源"></select></label>
        <div class="mp-create"><label class="mp-label">新增台账名称<input data-role="create-name" maxlength="120" placeholder="填写机械资源名称"></label><button type="button" data-action="create">创建台账</button></div>
        <p class="mp-help" data-role="empty">先从机械资源台账中选择一条记录。</p>
        <fieldset data-role="editor"><legend>模型与参数</legend>
          <label class="mp-label">模型类型<select data-role="asset"></select></label>
          <div class="mp-boom-rotation mp-boom-angle" data-role="boom-rotation" hidden></div>
          <div class="mp-boom-elevation mp-boom-angle" data-role="boom-elevation" hidden></div>
          <p class="mp-clearance-warning" data-role="boom-clearance-warning" role="status" hidden></p>
          <div class="mp-mode"><label><input type="checkbox" data-role="proportional" checked>保持原比例联动</label><p data-role="mode-note">最后修改的尺寸决定整机比例，其他尺寸同步更新。</p></div>
          <div class="mp-parameters" data-role="parameters"></div>
          <button type="button" data-action="reset">恢复原尺寸</button>
          <p class="mp-help" data-role="dimensions-help">切换模式保留当前外形，后续编辑按所选规则调整。尺寸按模型原始米制数据输入。</p>
        </fieldset>
        <fieldset data-role="placement"><legend>位置与朝向</legend>
          <div class="mp-actions"><button type="button" data-action="pick">在场景中点选位置</button><button type="button" data-action="cancel-pick" hidden>取消点选</button><button type="button" data-action="locate">定位模型</button></div>
          <div class="mp-position-grid">
            <label class="mp-label">经度（°）<input type="number" step="any" data-placement="longitude" min="-180" max="180" placeholder="-180 至 180"></label>
            <label class="mp-label">纬度（°）<input type="number" step="any" data-placement="latitude" min="-90" max="90" placeholder="-90 至 90"></label>
            <label class="mp-label">椭球高（m）<input type="number" step="any" data-placement="height" placeholder="输入模型底部高程"></label>
            <label class="mp-label">整机朝向（°）<input type="number" step="any" data-placement="heading" value="0" placeholder="0 至 360"></label>
          </div>
          <p class="mp-help">整机朝向包含底盘与支腿，以模型 +X 参考方向为准：0° 向北，90° 向东。高程是 WGS84 椭球高；请核对项目高程基准。</p>
          <p class="mp-position-source" data-role="position-source">尚未设置位置</p>
          <label class="mp-visible"><input type="checkbox" data-role="visible" checked>在三维场景显示</label>
        </fieldset>
        <p class="mp-status" data-role="status" role="status" aria-live="polite">选择机械资源后编辑。</p>
        <div class="mp-confirm" data-role="confirm" hidden><p data-role="confirm-text"></p><div class="mp-actions"><button type="button" data-action="confirm-discard">放弃草稿并继续</button><button type="button" data-action="keep-editing">继续编辑</button></div></div>
      </div>
      <footer class="mp-footer"><button type="button" data-action="save" class="mp-primary">保存到资源</button><button type="button" data-action="cancel">取消编辑</button><button type="button" data-action="remove" class="mp-danger">移除三维实例</button></footer>`;
    options.host.append(this.root);
    const assetSelect = this.find<HTMLSelectElement>('[data-role="asset"]');
    for (const entry of MACHINERY_CATALOG) assetSelect.add(new Option(entry.name, entry.id));
    const signal = this.events.signal;
    this.root.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
      if (button && !button.disabled) this.action(button.dataset.action!);
    }, { signal });
    this.find<HTMLSelectElement>('[data-role="resource"]').addEventListener("change", event => {
      const id = (event.target as HTMLSelectElement).value;
      if (!this.requestDiscard(() => { void this.selectResource(id); }, "切换机械资源会放弃当前未保存修改。")) this.find<HTMLSelectElement>('[data-role="resource"]').value = this.selectedId;
    }, { signal });
    assetSelect.addEventListener("change", () => { void this.changeAsset(assetSelect.value as MachineryState["assetId"]); }, { signal });
    this.root.addEventListener("input", event => {
      const input = event.target as HTMLInputElement;
      if (!this.editable || this.busy || this.loading) return;
      if (input.dataset.role === "boom-rotation-slider" || input.dataset.role === "boom-elevation-slider") {
        this.setBoomAngleInput(input.dataset.role === "boom-rotation-slider" ? "boom_rotation_deg" : "boom_elevation_deg", numberValue(input));
      } else if (input.dataset.parameter) {
        if (input.dataset.parameter === "boom_rotation_deg" || input.dataset.parameter === "boom_elevation_deg") this.syncBoomAngleSlider(input.dataset.parameter, numberValue(input));
        this.editOrder = this.editOrder.filter(key => key !== input.dataset.parameter);
        this.editOrder.push(input.dataset.parameter);
        this.dirty = true; this.queuePreview();
      } else if (input.dataset.placement) {
        this.positionSource = "手动输入 · WGS84 椭球高";
        this.dirty = true; this.queuePreview();
      }
    }, { signal });
    this.find<HTMLInputElement>('[data-role="proportional"]').addEventListener("change", event => {
      if (!this.editable || !this.draft) return;
      this.draft.proportional = (event.target as HTMLInputElement).checked;
      this.dirty = true; this.renderMode(); this.message("编辑模式已切换，当前外形保持不变。"); this.updateControls();
    }, { signal });
    this.find<HTMLInputElement>('[data-role="visible"]').addEventListener("change", event => {
      if (!this.editable || !this.draft) return;
      this.draft.visible = (event.target as HTMLInputElement).checked;
      this.dirty = true; void this.preview();
    }, { signal });
    this.updateControls();
  }

  get isOpen() { return this.opened; }
  get hasDraft() { return this.dirty; }
  get isPicking() { return this.picking; }
  get isBusy() { return this.busy; }
  setPresentation(mode: 'workbench' | 'management') { this.root.dataset.presentation = mode; }
  locate(recordId: string) { return this.scene.flyTo(recordId); }
  private get editable() { return this.context.canEdit && this.context.canView && this.context.active && this.opened && !this.destroyed; }
  private find<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error("机械编辑控件缺失：" + selector);
    return element;
  }
  private records() {
    return this.context.records.filter(record => record.projectId === this.context.projectId
      && (record.kind === "equipment" || record.category === "equipment"));
  }
  private record() { return this.records().find(record => record.id === this.selectedId); }
  private setPicking(value: boolean) {
    if (this.picking === value) return;
    this.picking = value; this.options.onPickingChange?.(value);
  }
  private message(text: string, error = false) {
    const status = this.find<HTMLElement>('[data-role="status"]');
    status.textContent = text; status.classList.toggle("is-error", error);
  }
  private clearAsync() {
    ++this.generation; ++this.previewGeneration;
    this.assetAbort?.abort(); this.assetAbort = undefined;
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.cancelPicking(); this.loading = false;
  }
  private clearDraft() {
    this.clearAsync(); this.scene.clearPreview(); this.dirty = false;
    this.asset = undefined; this.draft = undefined; this.editOrder = [];
    this.pendingAction = undefined; this.find<HTMLElement>('[data-role="confirm"]').hidden = true;
  }

  setContext(context: MachineryPanelContext) {
    if (this.destroyed) return;
    const previous = this.context;
    const reset = previous.projectId !== context.projectId || previous.actorId !== context.actorId || (previous.canView && !context.canView)
      || (previous.canEdit && !context.canEdit) || (previous.active && !context.active);
    this.context = context;
    if (reset) { this.clearDraft(); this.selectedId = ""; this.opened = false; this.busy = false; this.options.onOpenChange?.(false); }
    const records = context.canView ? this.records() : [];
    this.scene.setContext({ projectId: context.projectId, records: records.map(record => ({ id: record.id, machinery: savedState(record) })), canView: context.canView, active: context.active });
    this.renderResources();
    // A command callback may refresh the dataset before its promise resolves.
    // Keep that operation's generation/revision until its own completion path runs.
    if (this.opened && context.canView && context.active && !this.busy) {
      const record = this.record();
      if (!record && this.selectedId) { this.clearDraft(); this.selectedId = ""; this.renderEditor(); }
      else if (record && !this.dirty && record.revision !== this.selectedRevision) void this.selectResource(record.id);
      else if (record && this.dirty && record.revision !== this.selectedRevision) this.message("资源已被更新。保存会校验原修订号；可取消编辑后读取最新记录。", true);
    }
    this.root.hidden = !this.opened || !context.canView || !context.active;
    this.updateControls();
  }

  open() {
    if (this.destroyed || !this.context.canView || !this.context.active) return;
    if (!this.opened) this.options.onOpenChange?.(true);
    this.opened = true; this.root.hidden = false; this.renderResources();
    const id = this.record()?.id || this.records()[0]?.id;
    if (id && !this.asset) void this.selectResource(id);
    this.updateControls();
  }
  close(): boolean {
    if (this.destroyed || !this.opened) return true;
    if (this.busy) { this.message("正在保存，请稍后关闭。", true); return false; }
    if (!this.requestDiscard(() => this.closeNow(), "关闭编辑面板会放弃未保存修改，已保存模型仍留在场景中。")) return false;
    return true;
  }
  private closeNow() { this.clearDraft(); this.opened = false; this.root.hidden = true; this.updateControls(); this.options.onOpenChange?.(false); }
  private requestDiscard(action: () => void, text: string): boolean {
    if (!this.dirty) { action(); return true; }
    this.cancelPicking(); this.pendingAction = () => { this.clearDraft(); this.renderEditor(); action(); };
    this.find<HTMLElement>('[data-role="confirm-text"]').textContent = text;
    this.find<HTMLButtonElement>('[data-action="confirm-discard"]').textContent = "放弃草稿并继续";
    this.find<HTMLElement>('[data-role="confirm"]').hidden = false;
    return false;
  }

  async selectResource(id: string): Promise<boolean> {
    if (this.destroyed || !this.opened || !this.context.canView || this.busy) return false;
    if (this.dirty) { this.requestDiscard(() => { this.dirty = false; void this.selectResource(id); }, "切换机械资源会放弃当前未保存修改。"); return false; }
    const record = this.records().find(item => item.id === id);
    this.clearDraft(); this.selectedId = record?.id || ""; this.selectedRevision = record?.revision || 0;
    this.renderResources();
    if (!record) { this.renderEditor(); this.message("请先选择机械资源。"); return false; }
    const saved = savedState(record);
    const draft: Draft = saved || { schemaVersion: 1, assetId: MACHINERY_CATALOG[0].id, assetVersion: MACHINERY_ASSET_VERSION, proportional: true, parameters: {}, visible: true };
    this.draft = draft;
    this.positionSource = saved ? "已保存位置 · WGS84 椭球高" : "尚未设置位置";
    return this.loadAsset(draft.assetId, !!saved);
  }
  private async loadAsset(id: MachineryState["assetId"], keepParameters: boolean): Promise<boolean> {
    const generation = ++this.generation;
    this.assetAbort?.abort(); const abort = new AbortController(); this.assetAbort = abort;
    this.loading = true; this.updateControls(); this.message("正在加载机械模型…");
    try {
      const asset = await loadMachineryAsset(id, { signal: abort.signal });
      if (this.destroyed || generation !== this.generation || !this.draft) return false;
      if (asset.version !== MACHINERY_ASSET_VERSION || (keepParameters && this.draft.assetVersion !== asset.version)) throw new Error("已保存模型版本与当前资产版本不同，请先确认资产版本后编辑。");
      this.asset = asset; this.draft.assetVersion = MACHINERY_ASSET_VERSION;
      this.draft.parameters = keepParameters
        ? { ...defaultMachineryParameters(asset), ...this.draft.parameters }
        : defaultMachineryParameters(asset);
      this.renderEditor(); this.message(this.context.canEdit ? "参数与位置修改会实时预览；设置位置后保存到当前资源。" : "只读查看：当前账号没有机械资源编辑权限。");
      return true;
    } catch (error) {
      if (!abort.signal.aborted && generation === this.generation) this.message("模型加载失败：" + errorText(error), true);
      return false;
    } finally { if (generation === this.generation) { this.loading = false; this.updateControls(); } }
  }
  private async changeAsset(id: MachineryState["assetId"]) {
    if (!this.editable || !this.draft || this.busy) return;
    this.cancelPicking(); this.asset = undefined; this.draft.assetId = id;
    this.draft.proportional = true; this.draft.parameters = {}; this.editOrder = []; this.dirty = true;
    if (await this.loadAsset(id, false)) void this.preview();
  }
  private renderResources() {
    const select = this.find<HTMLSelectElement>('[data-role="resource"]');
    select.replaceChildren(new Option("选择机械资源", ""));
    for (const record of this.records()) select.add(new Option(record.name + (savedState(record) ? " · 已放置" : ""), record.id));
    select.value = this.selectedId;
    this.find<HTMLElement>('[data-role="empty"]').textContent = this.records().length ? "每个三维实例绑定一条机械资源记录。" : "当前项目没有机械资源；可先创建台账记录。";
  }
  private renderMode() {
    this.find<HTMLInputElement>('[data-role="proportional"]').checked = this.draft?.proportional ?? true;
    this.find<HTMLElement>('[data-role="mode-note"]').textContent = this.draft?.proportional
      ? "联动：最后修改的尺寸决定整机原比例，其他尺寸同步更新。" + (this.draft.assetId === "crane" ? "吊臂回转角与仰角独立调整。" : "")
      : "独立调整：按各项定义修改部件或整机。";
  }
  private renderEditor() {
    const list = this.find<HTMLElement>('[data-role="parameters"]'); list.replaceChildren();
    const rotation = this.find<HTMLElement>('[data-role="boom-rotation"]'); rotation.replaceChildren(); rotation.hidden = true;
    const elevation = this.find<HTMLElement>('[data-role="boom-elevation"]'); elevation.replaceChildren(); elevation.hidden = true;
    this.find<HTMLSelectElement>('[data-role="asset"]').value = this.draft?.assetId || MACHINERY_CATALOG[0].id;
    this.find<HTMLElement>('[data-role="dimensions-help"]').textContent = "切换模式保留当前外形，后续编辑按所选规则调整。尺寸按模型原始米制数据输入。" + (this.draft?.assetId === "crane" ? "恢复原尺寸保留吊臂回转角与仰角，整机高度随当前姿态更新。" : "");
    if (this.asset && this.draft) for (const definition of this.asset.config.parameters) {
      const label = document.createElement("label"); label.className = "mp-label";
      const title = document.createElement("span"); title.textContent = definition.label + "（" + definition.unit + "）";
      const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.dataset.parameter = definition.key;
      input.value = String(this.draft.parameters[definition.key]);
      if (definition.min !== undefined) input.min = String(definition.min);
      const note = document.createElement("small"); note.textContent = "原始值 " + definition.original + " " + definition.unit + (definition.description ? " · " + definition.description : "");
      label.append(title, input, note);
      if (definition.key === "boom_rotation_deg" || definition.key === "boom_elevation_deg") {
        const isRotation = definition.key === "boom_rotation_deg", container = isRotation ? rotation : elevation;
        const maximum = isRotation ? "360" : "90";
        container.hidden = false; input.min = "0"; input.max = maximum;
        title.textContent = isRotation ? "吊臂回转角（°）" : "吊臂仰角（°）";
        note.textContent = isRotation ? "0° 为原模型方向，俯视顺时针为正；底盘与支腿不转。"
          : "0° 水平，90° 竖直；底盘与支腿不动。原仰角 " + Number(definition.original.toFixed(2)) + "°。";
        const slider = document.createElement("input"); slider.type = "range"; slider.min = "0"; slider.max = maximum; slider.step = isRotation ? "1" : "0.1";
        slider.dataset.role = isRotation ? "boom-rotation-slider" : "boom-elevation-slider";
        slider.value = input.value; slider.setAttribute("aria-label", isRotation ? "吊臂回转角滑块" : "吊臂仰角滑块");
        const ticks = document.createElement("div"); ticks.className = "mp-angle-ticks"; ticks.setAttribute("aria-hidden", "true");
        for (const tick of isRotation ? ["0°", "180°", "360°"] : ["0° 水平", "45°", "90° 竖直"]) { const text = document.createElement("span"); text.textContent = tick; ticks.append(text); }
        const actions = document.createElement("div"); actions.className = "mp-actions mp-angle-actions";
        const controls = isRotation
          ? [["rotate-boom-left", "逆时针 15°"], ["rotate-boom-right", "顺时针 15°"], ["reset-boom-rotation", "吊臂回正"]]
          : [["lower-boom", "降低 5°"], ["raise-boom", "抬高 5°"], ["reset-boom-elevation", "恢复原仰角"]];
        for (const [action, text] of controls) {
          const button = document.createElement("button"); button.type = "button"; button.dataset.action = action; button.textContent = text; actions.append(button);
        }
        container.append(label, slider, ticks, actions);
      } else list.append(label);
    }
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-placement]")) {
      const key = input.dataset.placement as keyof Placement;
      input.value = this.draft?.placement ? String(this.draft.placement[key]) : key === "heading" ? "0" : "";
    }
    this.find<HTMLInputElement>('[data-role="visible"]').checked = this.draft?.visible ?? true;
    this.find<HTMLElement>('[data-role="position-source"]').textContent = this.positionSource;
    this.updateBoomClearance(); this.renderMode(); this.updateControls();
  }
  private updateControls() {
    const available = !!this.asset && !!this.draft;
    const write = this.editable && !this.busy && !this.loading;
    this.find<HTMLFieldSetElement>('[data-role="editor"]').disabled = !write || !available;
    this.find<HTMLFieldSetElement>('[data-role="placement"]').disabled = !available;
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-placement], [data-role=visible]")) input.disabled = !write;
    this.find<HTMLSelectElement>('[data-role="resource"]').disabled = this.busy || this.loading;
    this.find<HTMLElement>(".mp-create").hidden = !this.options.createResource || !this.context.canEdit;
    this.find<HTMLButtonElement>('[data-action="create"]').disabled = !write;
    this.find<HTMLButtonElement>('[data-action="save"]').disabled = !write || !available || !this.dirty;
    this.find<HTMLButtonElement>('[data-action="save"]').textContent = this.busy ? "正在保存…" : "保存到资源";
    this.find<HTMLButtonElement>('[data-action="remove"]').disabled = !write || !savedState(this.record());
    this.find<HTMLButtonElement>('[data-action="reset"]').disabled = !write || !available;
    this.find<HTMLButtonElement>('[data-action="cancel"]').disabled = this.busy || !this.selectedId;
    this.find<HTMLButtonElement>('[data-action="pick"]').disabled = !write || !available || this.picking;
    this.find<HTMLButtonElement>('[data-action="cancel-pick"]').hidden = !this.picking;
    this.find<HTMLButtonElement>('[data-action="locate"]').disabled = !this.draft?.placement;
    this.root.dataset.dirty = String(this.dirty);
  }
  private collectInputs(requirePosition: boolean): boolean {
    if (!this.asset || !this.draft) return false;
    const changes: Record<string, number> = {};
    const values: Record<string, number> = {};
    for (const definition of this.asset.config.parameters) {
      const input = Array.from(this.root.querySelectorAll<HTMLInputElement>("[data-parameter]")).find(item => item.dataset.parameter === definition.key)!;
      const value = numberValue(input);
      const isAngle = definition.key === "boom_rotation_deg" || definition.key === "boom_elevation_deg";
      const angleMaximum = definition.key === "boom_rotation_deg" ? 360 : 90;
      const valid = Number.isFinite(value) && (isAngle ? value >= 0 && value <= angleMaximum : value > 0 && (definition.min === undefined || (definition.min_exclusive ? value > definition.min : value >= definition.min)));
      input.setAttribute("aria-invalid", String(!valid));
      if (!valid && isAngle) { this.message(definition.label + "请输入 0 至 " + angleMaximum + "° 的有效角度。", true); return false; }
      if (!valid) { this.message(definition.label + "请输入有效正数" + (definition.min === undefined ? "。" : "，必须" + (definition.min_exclusive ? "大于 " : "不小于 ") + definition.min + " " + definition.unit + "。"), true); return false; }
      values[definition.key] = value;
    }
    const keys = [...Object.keys(values).filter(key => !this.editOrder.includes(key)), ...this.editOrder];
    for (const key of keys) if (values[key] !== this.draft.parameters[key]) changes[key] = values[key];
    try {
      if (Object.keys(changes).length) {
        this.draft.parameters = resolveMachineryParameters(this.asset, this.draft.parameters, changes, { proportional: this.draft.proportional });
        for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-parameter]")) input.value = String(this.draft.parameters[input.dataset.parameter!]);
        this.syncBoomAngleSlider("boom_rotation_deg", this.draft.parameters.boom_rotation_deg);
        this.syncBoomAngleSlider("boom_elevation_deg", this.draft.parameters.boom_elevation_deg);
        this.updateBoomClearance();
      }
      this.editOrder = [];
    } catch (error) { this.message(errorText(error), true); return false; }
    const placement = {} as Placement;
    let empty = false;
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-placement]")) {
      const key = input.dataset.placement as keyof Placement, value = numberValue(input);
      const valid = Number.isFinite(value) && (key !== "longitude" || Math.abs(value) <= 180) && (key !== "latitude" || Math.abs(value) <= 90);
      input.setAttribute("aria-invalid", String(!valid));
      if (!valid) empty = true;
      placement[key] = value;
    }
    if (empty) {
      if (requirePosition || this.draft.placement) this.message("请点选位置，或完整填写有效的经度、纬度、椭球高与朝向。", true);
      return !requirePosition && !this.draft.placement;
    }
    placement.heading = ((placement.heading % 360) + 360) % 360;
    this.draft.placement = placement;
    this.find<HTMLElement>('[data-role="position-source"]').textContent = this.positionSource;
    return true;
  }
  private updateBoomClearance() {
    const note = this.find<HTMLElement>('[data-role="boom-clearance-warning"]');
    note.hidden = true; note.textContent = "";
    if (!this.asset || !this.draft || this.draft.assetId !== "crane") return;
    const lowest = computeMachineryGeometry(this.asset, this.draft.parameters).bounds.min[1];
    if (lowest < -0.005) {
      note.hidden = false;
      note.textContent = "模型部件低于站位基准 " + (-lowest).toFixed(2) + " m，请核对吊臂姿态。此提示仅对比站位基准，不代表已检测实际地形。";
    }
  }
  private syncBoomAngleSlider(key: BoomAngle, value: number) {
    const isRotation = key === "boom_rotation_deg";
    const slider = this.root.querySelector<HTMLInputElement>(isRotation ? '[data-role="boom-rotation-slider"]' : '[data-role="boom-elevation-slider"]');
    if (slider && Number.isFinite(value) && value >= 0 && value <= (isRotation ? 360 : 90)) slider.value = String(value);
  }
  private setBoomAngleInput(key: BoomAngle, value: number) {
    if (!this.editable || this.busy || this.loading || this.draft?.assetId !== "crane") return;
    const input = this.root.querySelector<HTMLInputElement>('[data-parameter="' + key + '"]');
    if (!input) return;
    input.value = String(value); this.syncBoomAngleSlider(key, value);
    this.editOrder = this.editOrder.filter(item => item !== key); this.editOrder.push(key);
    this.dirty = true; this.queuePreview();
  }
  private queuePreview() {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => { this.previewTimer = undefined; void this.preview(); }, 220);
    this.message("参数与位置正在预览，尚未保存。"); this.updateControls();
  }
  private async preview() {
    if (!this.editable || !this.asset || !this.draft || !this.collectInputs(false)) return;
    if (!this.draft.placement) { this.message("参数已调整。请点选位置或填写坐标后预览。", false); this.updateControls(); return; }
    const token = ++this.previewGeneration, generation = this.generation;
    try {
      await this.scene.preview(this.selectedId, this.draft as MachineryState, this.asset);
      if (token === this.previewGeneration && generation === this.generation && !this.destroyed) this.message("正在显示未保存预览。点击“保存到资源”保留修改。");
    } catch (error) { if (token === this.previewGeneration && generation === this.generation) this.message("预览未更新：" + errorText(error), true); }
    this.updateControls();
  }
  private startPicking() {
    if (!this.editable || !this.asset || !this.draft || this.busy) return;
    this.setPicking(true); this.updateControls(); this.message("请在场景中点击地表位置；按 Esc 或取消点选退出。");
    const generation = this.generation;
    this.scene.beginPick(point => {
      this.setPicking(false);
      if (generation !== this.generation || !this.editable || !this.draft) return;
      const headingInput = this.find<HTMLInputElement>('[data-placement="heading"]');
      this.draft.placement = { longitude: point.longitude, latitude: point.latitude, height: point.height, heading: Number.isFinite(numberValue(headingInput)) ? numberValue(headingInput) : 0 };
      this.positionSource = point.source === "model" ? "场景表面拾取 · WGS84 椭球高" : point.source === "terrain" ? "地形拾取 · WGS84 椭球高" : "参考椭球拾取 · 不代表实测地表高程";
      for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-placement]")) input.value = String(this.draft.placement[input.dataset.placement as keyof Placement]);
      this.dirty = true; void this.preview();
    }, () => { this.setPicking(false); if (!this.destroyed) { this.updateControls(); this.message("已取消位置点选。"); } });
  }
  cancelPicking() { this.scene.cancelPick(); this.setPicking(false); if (!this.destroyed) this.updateControls(); }

  private async save() {
    if (!this.editable || this.busy || !this.draft || !this.asset || !this.collectInputs(true) || !this.draft.placement) return;
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = undefined; this.cancelPicking();
    const generation = this.generation, id = this.selectedId, revision = this.selectedRevision, state = copy(this.draft as MachineryState);
    this.busy = true; this.updateControls();
    try {
      await this.options.save(id, state, revision);
      if (this.destroyed || generation !== this.generation) return;
      this.dirty = false; this.scene.clearPreview();
      this.message("机械实例已保存到资源台账。");
      const latest = this.record();
      if (latest) this.selectedRevision = latest.revision;
    } catch (error) { if (generation === this.generation) this.message("保存未完成：" + errorText(error) + "。当前草稿已保留。", true); }
    finally { if (generation === this.generation) { this.busy = false; this.updateControls(); } }
  }
  private async remove() {
    if (!this.editable || this.busy || !savedState(this.record())) return;
    const generation = this.generation, id = this.selectedId, revision = this.selectedRevision;
    this.cancelPicking(); this.busy = true; this.updateControls();
    try {
      await this.options.remove(id, revision);
      if (this.destroyed || generation !== this.generation) return;
      this.dirty = false; this.busy = false; await this.selectResource(id); this.message("三维实例已移除，机械资源台账仍保留。");
    } catch (error) { if (generation === this.generation) this.message("移除未完成：" + errorText(error), true); }
    finally { if (generation === this.generation) { this.busy = false; this.updateControls(); } }
  }
  private async create() {
    if (!this.editable || this.busy || !this.options.createResource) return;
    const input = this.find<HTMLInputElement>('[data-role="create-name"]'), name = input.value.trim();
    if (!name) { this.message("请填写机械资源名称。", true); input.focus(); return; }
    const generation = this.generation; this.busy = true; this.updateControls();
    try {
      const created = await this.options.createResource(name);
      if (this.destroyed || generation !== this.generation) return;
      input.value = ""; this.busy = false;
      if (created?.id) await this.selectResource(created.id);
      else { this.dirty = false; await this.selectResource(this.selectedId); this.message("机械资源已创建，请从台账列表选择。", false); }
    } catch (error) {
      if (generation === this.generation) {
        this.busy = false;
        if (!this.asset && this.selectedId) await this.selectResource(this.selectedId);
        this.message("创建未完成：" + errorText(error), true);
      }
    }
    finally { if (generation === this.generation) { this.busy = false; this.updateControls(); } }
  }
  private action(action: string) {
    if (action === "close") this.close();
    else if (action === "save") void this.save();
    else if (action === "create") this.requestDiscard(() => { void this.create(); }, "创建并选择新资源会放弃当前未保存修改。");
    else if (action === "cancel") { const id = this.selectedId; this.dirty = false; void this.selectResource(id); }
    else if (["rotate-boom-left", "rotate-boom-right", "reset-boom-rotation"].includes(action) && this.draft?.assetId === "crane" && this.editable && !this.busy && !this.loading) {
      const input = this.root.querySelector<HTMLInputElement>('[data-parameter="boom_rotation_deg"]');
      if (!input) return;
      const current = numberValue(input);
      if (action !== "reset-boom-rotation" && (!Number.isFinite(current) || current < 0 || current > 360)) { this.message("请先输入 0 至 360° 的有效吊臂回转角。", true); input.focus(); return; }
      this.setBoomAngleInput("boom_rotation_deg", action === "reset-boom-rotation" ? 0 : ((current + (action === "rotate-boom-left" ? -15 : 15)) % 360 + 360) % 360);
    } else if (["lower-boom", "raise-boom", "reset-boom-elevation"].includes(action) && this.asset && this.draft?.assetId === "crane" && this.editable && !this.busy && !this.loading) {
      const input = this.root.querySelector<HTMLInputElement>('[data-parameter="boom_elevation_deg"]');
      if (!input) return;
      const current = numberValue(input);
      if (action !== "reset-boom-elevation" && (!Number.isFinite(current) || current < 0 || current > 90)) { this.message("请先输入 0 至 90° 的有效吊臂仰角。", true); input.focus(); return; }
      const original = defaultMachineryParameters(this.asset).boom_elevation_deg;
      this.setBoomAngleInput("boom_elevation_deg", action === "reset-boom-elevation" ? original : Math.max(0, Math.min(90, current + (action === "lower-boom" ? -5 : 5))));
    } else if (action === "reset" && this.asset && this.draft && this.editable) {
      const preservedAngles: Partial<Record<BoomAngle, number>> = {};
      for (const [key, maximum] of [["boom_rotation_deg", 360], ["boom_elevation_deg", 90]] as const) {
        const input = this.root.querySelector<HTMLInputElement>('[data-parameter="' + key + '"]');
        if (!input) continue;
        const value = numberValue(input);
        if (!Number.isFinite(value) || value < 0 || value > maximum) { this.message("请先输入有效的吊臂角度；恢复原尺寸会保留当前回转角与仰角。", true); input.focus(); return; }
        preservedAngles[key] = value;
      }
      try {
        const defaults = defaultMachineryParameters(this.asset);
        this.draft.parameters = this.draft.assetId === "crane"
          ? resolveMachineryParameters(this.asset, defaults, preservedAngles, { proportional: false })
          : defaults;
      } catch (error) { this.message(errorText(error), true); return; }
      this.draft.proportional = true; this.editOrder = []; this.dirty = true;
      this.renderEditor(); void this.preview();
    } else if (action === "pick") this.startPicking();
    else if (action === "cancel-pick") this.cancelPicking();
    else if (action === "locate") void this.scene.flyTo(this.selectedId);
    else if (action === "remove") {
      this.pendingAction = () => { void this.remove(); };
      this.find<HTMLElement>('[data-role="confirm-text"]').textContent = "移除该资源的三维实例？机械台账与使用记录会保留。";
      this.find<HTMLButtonElement>('[data-action="confirm-discard"]').textContent = "确认移除";
      this.find<HTMLElement>('[data-role="confirm"]').hidden = false;
    } else if (action === "confirm-discard") {
      const proceed = this.pendingAction; this.pendingAction = undefined;
      this.find<HTMLElement>('[data-role="confirm"]').hidden = true; proceed?.();
    } else if (action === "keep-editing") {
      this.pendingAction = undefined; this.find<HTMLElement>('[data-role="confirm"]').hidden = true;
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.clearDraft(); this.destroyed = true; this.events.abort(); this.scene.destroy(); this.root.remove(); this.options.onOpenChange?.(false);
  }
  dispose() { this.destroy(); }
}
