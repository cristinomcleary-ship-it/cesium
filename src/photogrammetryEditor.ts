import {
  Cartesian2, Cartesian3, Cartographic, Color, ConstantPositionProperty, ConstantProperty,
  Math as CesiumMath, Matrix4, Transforms, VerticalOrigin,
  type Cesium3DTileset, type Entity, type Viewer,
} from 'cesium';
import { beginPickPlacement } from './modelPlacement';
import {
  createPhotogrammetryTransform, getPhotogrammetryPivot, movePhotogrammetryByPoints,
  photogrammetryMatrix, resetPhotogrammetryTransform, setPhotogrammetryPivot,
  type PhotogrammetryTransform,
} from './photogrammetryTransform';
import './photogrammetryEditor.css';

export type PhotogrammetryEditorTarget = { id: string; name: string; tileset: Cesium3DTileset; saved?: unknown };
export type PhotogrammetryEditorHooks = {
  isValid: (id: string, tileset: Cesium3DTileset) => boolean;
  /** The host owns the exact set of scene effects and interactions to pause. */
  acquire: () => () => void;
  save: (id: string, state: PhotogrammetryTransform, matrix: Matrix4) => Promise<void>;
  onCommitted: (id: string) => void;
  notify: (message: string, error?: boolean) => void;
};
type Session = {
  target: PhotogrammetryEditorTarget;
  originalMatrix: Matrix4;
  lastApplied: Matrix4;
  draft: PhotogrammetryTransform;
  release: () => void;
  saving: boolean;
};
type PickKind = 'move-start' | 'move-end' | 'pivot';
const numericFields = ['east', 'north', 'up', 'heading', 'pivotLon', 'pivotLat', 'pivotHeight'] as const;
type NumericField = typeof numericFields[number];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** An explicit preview transaction. Only save() may persist; every other exit
 * restores the exact opening matrix while it is still this session's matrix. */
export class PhotogrammetryEditor {
  private readonly root: HTMLElement;
  private session?: Session;
  private events?: AbortController;
  private pick?: AbortController;
  private pickKind?: PickKind;
  private marker?: Entity;
  private axis?: Entity;
  private inputError?: string;
  private disposed = false;

  constructor(private readonly viewer: Viewer, parent: HTMLElement, private readonly hooks: PhotogrammetryEditorHooks) {
    this.root = document.createElement('section');
    this.root.className = 'photogrammetry-editor'; this.root.hidden = true;
    this.root.setAttribute('aria-label', '倾斜摄影位置调整');
    this.root.innerHTML = `
      <header><div><strong>倾斜摄影位置调整</strong><small data-photogrammetry="name"></small></div><span class="photo-preview-tag">实时预览</span></header>
      <p class="photo-editor-intro">以模型原位置的局部东、北、上方向调整。确认保存前，取消会恢复打开面板时的位置。</p>
      <div class="photo-editor-fields">
        <label>东向 X（米）<input data-photogrammetry="east" type="number" step="any"></label>
        <label>北向 Y（米）<input data-photogrammetry="north" type="number" step="any"></label>
        <label>高程偏移（米）<input data-photogrammetry="up" type="number" step="any"></label>
        <label>旋转角度（度）<input data-photogrammetry="heading" type="number" step="any"></label>
      </div>
      <button type="button" data-photo-action="move-points">地图选择起点 → 终点</button>
      <p class="photo-editor-note">两点选择只计算平面偏移，高程保持当前值。旋转正角度从东向北。</p>
      <fieldset><legend>实际旋转中心</legend><div class="photo-editor-fields">
        <label>经度（度）<input data-photogrammetry="pivotLon" type="number" step="any" min="-180" max="180"></label>
        <label>纬度（度）<input data-photogrammetry="pivotLat" type="number" step="any" min="-90" max="90"></label>
        <label class="photo-field-full">椭球高（米）<input data-photogrammetry="pivotHeight" type="number" step="any"></label>
      </div><button type="button" data-photo-action="pick-pivot">在地图上选择旋转中心</button></fieldset>
      <button type="button" data-photo-action="reset">预览恢复原始位置</button>
      <p class="photo-editor-note">原始位置指首次位置编辑前的位置，包含加载时的经纬度和高程校正。恢复原位也需确认保存。提交新位置后，关联地表方案需重新核对、重建。</p>
      <p data-photogrammetry="status" class="photo-editor-status" role="status" aria-live="polite"></p>
      <footer><button type="button" data-photo-action="cancel">取消调整</button><button type="button" class="photo-editor-save" data-photo-action="save">确认保存</button></footer>`;
    parent.append(this.root);
  }

  get activeId(): string | undefined { return this.session?.target.id; }
  get busy(): boolean { return this.session?.saving ?? false; }
  get isOpen(): boolean { return !!this.session && !this.disposed; }

  open(target: PhotogrammetryEditorTarget): boolean {
    if (this.disposed || this.busy || !this.cancel()) return false;
    if (!this.valid(target)) { this.hooks.notify('该摄影模型当前不可调整，请检查显示状态、项目及编辑权限。', true); return false; }
    let release: (() => void) | undefined;
    try {
      release = this.hooks.acquire();
      if (!this.valid(target)) throw new Error('摄影模型或权限已变化，请重新选择。');
      const originalMatrix = Matrix4.clone(target.tileset.modelMatrix);
      const draft = createPhotogrammetryTransform(originalMatrix, target.tileset.boundingSphere.center, target.saved);
      this.session = { target, originalMatrix, lastApplied: Matrix4.clone(originalMatrix), draft, release, saving: false };
      release = undefined;
      this.events = new AbortController();
      this.root.addEventListener('input', event => this.input(event.target as HTMLInputElement), { signal: this.events.signal });
      this.root.addEventListener('click', event => {
        const action = (event.target as Element).closest<HTMLButtonElement>('[data-photo-action]')?.dataset.photoAction;
        if (action) void this.action(action);
      }, { signal: this.events.signal });
      window.addEventListener('keydown', this.keydown, { capture: true, signal: this.events.signal });
      this.find('name').textContent = target.name;
      this.root.hidden = false; this.inputError = undefined;
      this.status('调整仅用于预览，确认保存后生效。'); this.render(true); this.updateGuides();
      return true;
    } catch (error) {
      if (this.session) this.finish(this.session, true);
      if (release) { try { release(); } catch (releaseError) { this.hooks.notify(errorMessage(releaseError), true); } }
      this.hooks.notify(errorMessage(error), true); return false;
    }
  }

  /** Normal navigation must wait for an in-flight commit. Forced invalidation
   * uses refreshValidity/dispose and never lets a late response touch the scene. */
  cancel(): boolean {
    if (this.busy) return false;
    if (this.session) this.finish(this.session, true);
    return true;
  }

  refreshValidity(): void {
    const session = this.session;
    if (session && (!this.valid(session.target) || !Matrix4.equals(session.target.tileset.modelMatrix, session.lastApplied))) {
      this.finish(session, true);
      if (!this.disposed) this.hooks.notify('摄影调整已退出：模型、项目、权限或当前位置已变化。');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.session) this.finish(this.session, true);
    this.root.remove();
  }

  private valid(target: PhotogrammetryEditorTarget): boolean {
    return !this.disposed && !this.viewer.isDestroyed() && !target.tileset.isDestroyed() && this.hooks.isValid(target.id, target.tileset);
  }

  private current(session: Session): boolean {
    if (this.session !== session || this.disposed) return false;
    this.refreshValidity();
    return this.session === session;
  }

  private keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing || !this.session) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.busy) { this.status('正在保存位置，请等待保存结束。'); return; }
    if (this.pick) this.pick.abort();
    else this.cancel();
  };

  private find<T extends HTMLElement = HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-photogrammetry="${name}"]`)!;
  }

  private values(): Record<NumericField, number> {
    const output = {} as Record<NumericField, number>;
    for (const field of numericFields) {
      const input = this.find<HTMLInputElement>(field), value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value) || !input.checkValidity()) throw new Error('请输入有限数值；经度范围为 ±180°，纬度范围为 ±90°。');
      output[field] = value;
    }
    return output;
  }

  private input(input: HTMLInputElement): void {
    const session = this.session, field = input.dataset.photogrammetry;
    if (!session || session.saving || this.pick || !field || !numericFields.includes(field as NumericField) || !this.current(session)) return;
    try {
      const values = this.values();
      let draft = { ...session.draft };
      // Display rounding must not quantize unrelated high-precision values when
      // the user changes just one field (for example heading after two picks).
      if (field === 'east' || field === 'north' || field === 'up' || field === 'heading') draft[field] = values[field];
      else {
        const actual = Cartographic.fromCartesian(getPhotogrammetryPivot(draft));
        draft = setPhotogrammetryPivot(draft, Cartesian3.fromDegrees(
          field === 'pivotLon' ? values.pivotLon : CesiumMath.toDegrees(actual.longitude),
          field === 'pivotLat' ? values.pivotLat : CesiumMath.toDegrees(actual.latitude),
          field === 'pivotHeight' ? values.pivotHeight : actual.height,
        ));
      }
      this.apply(session, draft); this.status('位置预览已更新，尚未保存。');
    } catch (error) { this.inputError = errorMessage(error); this.status(this.inputError, true); }
  }

  private apply(session: Session, draft: PhotogrammetryTransform): void {
    if (!this.current(session) || session.saving) return;
    const matrix = photogrammetryMatrix(draft);
    const pivot = Cartographic.fromCartesian(getPhotogrammetryPivot(draft));
    if (!pivot || ![pivot.longitude, pivot.latitude, pivot.height].every(Number.isFinite)) throw new Error('旋转中心不能位于地心或无效坐标。');
    session.target.tileset.modelMatrix = Matrix4.clone(matrix);
    session.lastApplied = Matrix4.clone(matrix); session.draft = draft;
    this.inputError = undefined;
    this.render(); this.updateGuides(); this.viewer.scene.requestRender();
  }

  private async action(action: string): Promise<void> {
    const session = this.session;
    if (!session || !this.current(session) || session.saving) return;
    if (action === 'cancel') { if (this.pick) this.pick.abort(); else this.cancel(); return; }
    if (this.pick) return;
    if (this.inputError && action !== 'reset') { this.status(this.inputError, true); return; }
    if (action === 'save') { await this.save(session); return; }
    if (action === 'move-points') { await this.pickPoints(session, false); return; }
    if (action === 'pick-pivot') { await this.pickPoints(session, true); return; }
    if (action === 'reset') {
      try { this.apply(session, resetPhotogrammetryTransform(session.draft)); this.status('已预览原始位置，确认保存后生效。'); }
      catch (error) { this.status(errorMessage(error), true); }
    }
  }

  private async pickPoints(session: Session, pivot: boolean): Promise<void> {
    const controller = new AbortController(); this.pick = controller;
    this.pickKind = pivot ? 'pivot' : 'move-start'; this.render(); this.showGuides(false);
    const choose = () => beginPickPlacement(this.viewer, { signal: controller.signal,
      onInvalidPick: () => { if (this.session === session) this.status('未选中有效位置，请点击模型、地形或地面；Esc 取消选点。', true); } });
    try {
      this.status(pivot ? '请在地图上选择旋转中心，Esc 取消选点。' : '请在地图上选择移动起点，Esc 取消选点。');
      const start = await choose();
      if (!this.current(session) || controller.signal.aborted) return;
      if (pivot) this.apply(session, setPhotogrammetryPivot(session.draft, start));
      else {
        this.pickKind = 'move-end'; this.render(); this.status('起点已选定，请选择移动终点；高程偏移保持不变。');
        const end = await choose();
        if (!this.current(session) || controller.signal.aborted) return;
        this.apply(session, movePhotogrammetryByPoints(session.draft, start, end));
      }
      if (this.session === session) this.status('地图选点已应用到预览，尚未保存。');
    } catch (error) {
      if (this.session !== session) return;
      this.status(controller.signal.aborted ? '已取消选点，位置预览保持不变。' : errorMessage(error), !controller.signal.aborted);
    } finally {
      if (this.pick === controller) {
        this.pick = undefined; this.pickKind = undefined;
        if (this.current(session)) { this.render(); this.showGuides(true); }
      }
    }
  }

  private async save(session: Session): Promise<void> {
    if (this.inputError) { this.status(this.inputError, true); return; }
    try { this.values(); } catch (error) { this.status(errorMessage(error), true); return; }
    if (!this.current(session) || session.saving) return;
    const matrix = Matrix4.clone(session.lastApplied), state = structuredClone(session.draft);
    session.saving = true; this.render(); this.status('正在保存位置…');
    try {
      await this.hooks.save(session.target.id, state, matrix);
      if (!this.current(session)) return;
      const restored = this.finish(session, false);
      // Persistence has already succeeded. A dependent display refresh failure
      // must not restore the old pose or misreport the commit as a failed save.
      try {
        this.hooks.onCommitted(session.target.id);
        this.hooks.notify(restored ? '摄影位置已保存。关联地表方案请重新核对、重建。'
          : '摄影位置已保存，但部分场景效果未能恢复，请检查场景提示。', !restored);
      } catch (error) { this.hooks.notify(`摄影位置已保存，但场景刷新失败：${errorMessage(error)}`, true); }
    } catch (error) {
      if (!this.current(session)) return;
      this.status(`保存失败：${errorMessage(error)}。可重试或取消；尚未确认保存。`, true);
    } finally {
      if (this.session === session) { session.saving = false; this.render(); }
    }
  }

  private finish(session: Session, restore: boolean): boolean {
    if (this.session !== session) return false;
    let restored = true;
    this.session = undefined;
    this.inputError = undefined;
    this.pick?.abort(); this.pick = undefined; this.pickKind = undefined;
    this.events?.abort(); this.events = undefined;
    this.root.hidden = true; this.root.removeAttribute('aria-busy'); delete this.root.dataset.picking;
    try {
      if (restore && !session.target.tileset.isDestroyed()
        && Matrix4.equals(session.target.tileset.modelMatrix, session.lastApplied)) session.target.tileset.modelMatrix = Matrix4.clone(session.originalMatrix);
    } finally {
      this.clearGuides();
      try { session.release(); } catch (error) { restored = false; this.hooks.notify(`场景效果恢复失败：${errorMessage(error)}`, true); }
      if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    }
    return restored;
  }

  private render(force = false): void {
    const session = this.session; if (!session) return;
    const pivot = Cartographic.fromCartesian(getPhotogrammetryPivot(session.draft));
    const values = { east: session.draft.east, north: session.draft.north, up: session.draft.up, heading: session.draft.heading,
      pivotLon: CesiumMath.toDegrees(pivot.longitude), pivotLat: CesiumMath.toDegrees(pivot.latitude), pivotHeight: pivot.height };
    for (const [name, value] of Object.entries(values)) {
      const input = this.find<HTMLInputElement>(name);
      if (force || document.activeElement !== input) input.value = String(Number(value.toFixed(name === 'pivotLon' || name === 'pivotLat' ? 10 : 6)));
      input.disabled = session.saving || !!this.pick;
    }
    this.root.setAttribute('aria-busy', String(session.saving));
    if (this.pickKind) this.root.dataset.picking = this.pickKind; else delete this.root.dataset.picking;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-photo-action]')) {
      button.disabled = session.saving || (!!this.pick && button.dataset.photoAction !== 'cancel');
      if (button.dataset.photoAction === 'cancel') button.textContent = this.pick ? '取消选点' : '取消调整';
      if (button.dataset.photoAction === 'save') button.textContent = session.saving ? '正在保存…' : '确认保存';
    }
  }

  private status(message: string, error = false): void {
    const element = this.find('status'); element.textContent = message;
    element.classList.toggle('photo-editor-error', error);
  }

  private showGuides(show: boolean): void {
    if (this.marker) this.marker.show = show;
    if (this.axis) this.axis.show = show;
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  private updateGuides(): void {
    const session = this.session; if (!session || this.viewer.isDestroyed()) return;
    const position = getPhotogrammetryPivot(session.draft), frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromArray(session.draft.origin));
    const up = Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 0, 25), new Cartesian3());
    if (!this.marker) this.marker = this.viewer.entities.add({
      position, point: { pixelSize: 9, color: Color.CYAN, outlineColor: Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: '摄影旋转中心', font: '13px sans-serif', fillColor: Color.CYAN, showBackground: true,
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -12), disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    else this.marker.position = new ConstantPositionProperty(position);
    const positions = [position, Cartesian3.add(position, up, new Cartesian3())];
    if (!this.axis) this.axis = this.viewer.entities.add({ polyline: { positions, width: 2, material: Color.CYAN } });
    else this.axis.polyline!.positions = new ConstantProperty(positions);
    this.showGuides(!this.pick);
  }

  private clearGuides(): void {
    if (!this.viewer.isDestroyed()) {
      if (this.marker) this.viewer.entities.remove(this.marker);
      if (this.axis) this.viewer.entities.remove(this.axis);
    }
    this.marker = undefined; this.axis = undefined;
  }
}
