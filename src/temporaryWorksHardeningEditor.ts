import {
  Cartesian2, Cartesian3, Cartographic, Color, ConstantProperty, Math as CesiumMath,
  ScreenSpaceEventHandler, ScreenSpaceEventType, type Entity, type Viewer,
} from 'cesium';
import {
  hardeningGeoFromLocal, hardeningLocalFromGeo, hardeningRectangle, hardeningSlopeComponents,
  intersectHardeningDesignPlane, validateHardeningReference,
  type HardeningGeoPoint, type HardeningLocalPoint, type HardeningReference,
} from './temporaryWorksHardeningEditorGeometry';
import './temporaryWorksHardeningEditor.css';

export type { HardeningGeoPoint, HardeningReference } from './temporaryWorksHardeningEditorGeometry';

export type HardeningFacilityExclusion = {
  objectId: string;
  resourceVersion?: string;
  boundary: HardeningGeoPoint[];
  /** User-confirmed actual floor elevation; never inferred from the GLB anchor. */
  floorHeight: number;
  floorThickness: number;
};
export type HardeningEditorValue = {
  name: string;
  reference: HardeningReference;
  /** New outlines may take their initial placement from the selected photogrammetry. */
  initialElevationMode?: 'automatic' | 'manual';
  boundary: HardeningGeoPoint[];
  holes: HardeningGeoPoint[][];
  thickness: number;
  slopeEnabled: boolean;
  gradeEastPct: number;
  gradeNorthPct: number;
  clippingEnabled: boolean;
  acceptedHeightDifference: boolean;
  facilityExclusions: HardeningFacilityExclusion[];
};
export type HardeningEditorFacility = { id: string; name: string; resourceVersion?: string };
export type HardeningEditorOptions = {
  root: HTMLElement;
  viewer: Viewer;
  getModel?(): { id: string; name: string } | undefined;
  /** Return a hit on the selected photogrammetry only; terrain and other objects are not substitutes. */
  pickInitialReference?(screen: Cartesian2): HardeningReference | undefined;
  beginInteractionSession?(): void | (() => void);
  onPreview(value: HardeningEditorValue): void | Promise<void>;
  onCancel?(): void;
  onChange?(): void;
  onError?(error: unknown): void;
};

type DrawTarget = 'outer' | 'hole' | 'facility';
type Drawing = {
  mode: 'rectangle' | 'polygon'; target: DrawTarget;
  points: HardeningLocalPoint[]; hover?: HardeningLocalPoint;
  reference?: HardeningReference; gradeEastPct: number; gradeNorthPct: number;
  automaticReference?: boolean;
  modelId?: string;
  facility?: HardeningEditorFacility;
  floorHeight?: number;
  floorThickness?: number;
};

const form = `
<div class="twh-editor" role="region" aria-label="场地硬化编辑">
  <fieldset data-hde-fieldset><legend>场地设置</legend>
    <div class="twh-grid">
      <label class="twh-wide">场地名称<input data-hde="name" type="text" maxlength="80" placeholder="如 1 号硬化场地"/></label>
      <label>水泥层厚度（m）<input data-hde="thickness" type="number" min="0.001" step="any" placeholder="正值，向顶面以下生成"/></label>
    </div>
    <p class="twh-hint" data-hde-elevation-hint>初始标高自动取自所选倾斜摄影，框选后可用位置调整升降。</p>
    <details class="twh-advanced"><summary>手动标高与坡度（可选）</summary>
    <label class="twh-check"><input data-hde="manual-elevation" type="checkbox"/>手动指定初始标高</label>
    <div data-hde-manual-reference hidden>
    <div class="twh-grid">
      <label>参考点经度（°）<input data-hde="longitude" type="number" min="-180" max="180" step="any"/></label>
      <label>参考点纬度（°）<input data-hde="latitude" type="number" min="-89.9" max="89.9" step="any"/></label>
      <label>参考点场地顶椭球高（m）<input data-hde="height" type="number" step="any" placeholder="手动模式填写"/></label>
    </div>
    <div class="twh-actions"><button type="button" data-hde-action="view-center">取视图中心作为平面参考</button></div>
    <p class="twh-hint">工程标高须按项目已确认的关系换算为椭球高。已有方案保留已保存的标高。</p>
    </div>
    <label class="twh-check"><input data-hde="slope-enabled" type="checkbox"/>设置场地坡度</label>
    <div class="twh-grid" data-hde-slope hidden>
      <label>坡向（°，正北0°、正东90°）<input data-hde="direction" type="number" step="any" value="0"/></label>
      <label>坡率（%，正值向坡向升高）<input data-hde="grade" type="number" step="any" value="0"/></label>
    </div>
    <p class="twh-hint">未设置坡度时为水平场地。水泥层只封闭自身厚度，不自动填土或连接未知地面。</p>
    </details>
  </fieldset>
  <fieldset data-hde-fieldset><legend>框选硬化范围</legend>
    <div class="twh-actions">
      <button type="button" data-hde-action="rectangle">矩形框选</button>
      <button type="button" data-hde-action="polygon">多边形圈选</button>
      <button type="button" data-hde-action="hole">绘制永久保留区</button>
    </div>
    <div class="twh-actions" data-hde-drawing hidden>
      <button type="button" data-hde-action="finish">完成圈选</button>
      <button type="button" data-hde-action="undo">撤销上一点</button>
      <button type="button" data-hde-action="cancel-draw">取消圈选</button>
    </div>
    <p class="twh-hint">直接在所选倾斜摄影上框选：矩形依次选两个对角点；多边形点选边界后点击“完成圈选”或右键。Esc 取消。建议俯视操作，生成后可再调整位置和标高。</p>
    <div class="twh-preview" data-hde-preview></div>
    <ul class="twh-region-list" data-hde-regions></ul>
    <details data-hde-coordinate-details><summary>调整边界点坐标</summary><div class="twh-vertices" data-hde-vertices></div></details>
  </fieldset>
  <fieldset data-hde-fieldset><legend>设施避让与摄影遮挡</legend>
    <p class="twh-hint">已启用自动避让：框选后自动扣除范围内的施工便道、项目驻地、钢筋加工场和已有硬化面，无需逐个点选。设施移动、隐藏或删除后，硬化范围同步更新；驻地庭院等模型轮廓内的空地仍可硬化。</p>
    <details class="twh-advanced"><summary>补充设施地坪避让范围（可选）</summary>
    <label>需要确认地坪范围的设施<select data-hde="facility"><option value="">无可选设施</option></select></label>
    <div class="twh-grid">
      <label>设施地坪顶椭球高（m）<input data-hde="facility-height" type="number" step="any" placeholder="明确确认实际地坪高程"/></label>
      <label>设施地坪厚度（m）<input data-hde="facility-thickness" type="number" min="0.001" step="any" placeholder="正值，不以楼高代替"/></label>
    </div>
    <div class="twh-actions"><button type="button" data-hde-action="facility">绘制随设施避让区</button></div>
    <p class="twh-hint">仅在设施自带底面轮廓之外还需保留地坪时使用。补充范围需填写真实地坪标高和厚度，并随设施移动；永久保留区始终不硬化。</p>
    </details>
    <label class="twh-check"><input data-hde="clipping" type="checkbox" checked/>遮挡所选倾斜摄影图层</label>
    <p class="twh-hint" data-hde-model></p>
    <label class="twh-check"><input data-hde="accept-height" type="checkbox"/>保留已提示的高差，并扣除重叠范围</label>
    <p class="twh-hint">与便道或已有硬化面接界时核对高差；自动避让建筑仅扣除占用轮廓，不代表地坪已接顺。改标高、坡度或边界后需重新确认。</p>
  </fieldset>
  <div class="twh-actions">
    <button type="button" data-hde-action="preview" class="tw-primary">生成 / 更新硬化预览</button>
    <button type="button" data-hde-action="cancel">退出硬化编辑</button>
  </div>
  <p class="twh-status" data-hde-status role="status"></p>
</div>`;

const cloneRing = (ring: readonly HardeningGeoPoint[]) => ring.map(point => ({ ...point }));
const numberValue = (value: string, label: string) => {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`请填写有效的${label}。`);
  return Number(value);
};

/** UI owns outlines and pointer handlers only. Saving and surface composition remain in the parent panel. */
export class TemporaryWorksHardeningEditor {
  private readonly listeners = new AbortController();
  private boundary: HardeningGeoPoint[] = [];
  private holes: HardeningGeoPoint[][] = [];
  private facilityExclusions: HardeningFacilityExclusion[] = [];
  private facilities: HardeningEditorFacility[] = [];
  private handler?: ScreenSpaceEventHandler;
  private finishSession?: () => void;
  private drawing?: Drawing;
  private outlines: Entity[] = [];
  private drawingOutline?: Entity;
  private enabled = true;
  private visible = true;
  private busy = false;
  private disposed = false;
  private invalidVertexFields = new Set<string>();
  private invalidVertexValues = new Map<string, string>();
  private verticesPage = 0;

  constructor(private readonly options: HardeningEditorOptions) {
    options.root.innerHTML = form;
    options.root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-hde-action]');
      if (!button || !options.root.contains(button)) return;
      event.stopPropagation();
      if (button.dataset.hdeAction !== 'cancel' && (!this.enabled || this.busy)) return;
      try { this.action(button.dataset.hdeAction!); }
      catch (error) { this.failure(error); }
    }, { signal: this.listeners.signal });
    options.root.addEventListener('input', event => this.changed(event), { signal: this.listeners.signal });
    options.root.addEventListener('change', event => this.changed(event), { signal: this.listeners.signal });
    this.element<HTMLDetailsElement>('[data-hde-coordinate-details]').addEventListener('toggle', () => this.renderVertices(), { signal: this.listeners.signal });
    document.addEventListener('keydown', event => {
      if (!this.drawing || !this.visible || event.key !== 'Escape') return;
      event.preventDefault(); this.cancelDrawing(); this.setStatus('已取消圈选，原范围保留。');
    }, { signal: this.listeners.signal });
    this.refresh();
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string) {
    const target = this.options.root.querySelector<T>(selector);
    if (!target) throw new Error('场地硬化编辑界面未就绪。');
    return target;
  }
  private field(name: string) { return this.element<HTMLInputElement>(`[data-hde="${name}"]`); }
  private elevationMode(): 'automatic' | 'manual' { return this.field('manual-elevation').checked ? 'manual' : 'automatic'; }
  private reference(): HardeningReference {
    const reference = {
      longitude: numberValue(this.field('longitude').value, '参考点经度'),
      latitude: numberValue(this.field('latitude').value, '参考点纬度'),
      height: numberValue(this.field('height').value, '场地顶椭球高'),
    };
    validateHardeningReference(reference); return reference;
  }
  private slopes() {
    const enabled = this.field('slope-enabled').checked;
    return hardeningSlopeComponents(enabled,
      enabled ? numberValue(this.field('direction').value, '坡向') : 0,
      enabled ? numberValue(this.field('grade').value, '坡率') : 0);
  }

  getValue(): HardeningEditorValue {
    if (this.boundary.length < 3) throw new Error('请先框选硬化场地。');
    const reference = this.reference(), slopes = this.slopes();
    const thickness = numberValue(this.field('thickness').value, '水泥层厚度');
    if (thickness <= 0) throw new Error('水泥层厚度须大于零。');
    if (this.drawing) throw new Error('请先完成或取消当前圈选。');
    if (this.invalidVertexFields.size) throw new Error('请先修正尚未应用的边界点坐标。');
    for (const exclusion of this.facilityExclusions) {
      if (!Number.isFinite(exclusion.floorHeight) || !Number.isFinite(exclusion.floorThickness) || exclusion.floorThickness <= 0)
        throw new Error('随设施避让区的地坪顶标高和正厚度尚未确认，请选择该设施补填，或删除后重新圈定。');
    }
    for (const ring of [this.boundary, ...this.holes, ...this.facilityExclusions.map(exclusion => exclusion.boundary)]) {
      if (ring.length < 3) throw new Error('场地范围至少需要三个有效边界点。');
      for (const point of ring) hardeningLocalFromGeo(point, reference);
    }
    return {
      name: this.field('name').value.trim() || '硬化场地', reference, initialElevationMode: this.elevationMode(),
      boundary: cloneRing(this.boundary), holes: this.holes.map(cloneRing), thickness,
      slopeEnabled: this.field('slope-enabled').checked, ...slopes,
      clippingEnabled: this.field('clipping').checked,
      acceptedHeightDifference: this.field('accept-height').checked,
      facilityExclusions: this.facilityExclusions.map(exclusion => ({ ...exclusion, boundary: cloneRing(exclusion.boundary) })),
    };
  }

  setValue(value?: Partial<HardeningEditorValue>) {
    this.cancelDrawing();
    this.invalidVertexFields.clear(); this.invalidVertexValues.clear(); this.verticesPage = 0;
    this.boundary = cloneRing(value?.boundary ?? []);
    this.holes = (value?.holes ?? []).map(cloneRing);
    this.facilityExclusions = (value?.facilityExclusions ?? []).map(exclusion => ({ ...exclusion, boundary: cloneRing(exclusion.boundary) }));
    this.field('name').value = value?.name ?? '';
    this.field('longitude').value = value?.reference ? String(value.reference.longitude) : '';
    this.field('latitude').value = value?.reference ? String(value.reference.latitude) : '';
    this.field('height').value = value?.reference ? String(value.reference.height) : '';
    this.field('manual-elevation').checked = value?.initialElevationMode === 'manual' ||
      (value?.initialElevationMode !== 'automatic' && !!value?.reference);
    this.field('thickness').value = value?.thickness === undefined ? '' : String(value.thickness);
    this.field('facility').value = '';
    this.field('facility-height').value = '';
    this.field('facility-thickness').value = '';
    this.field('slope-enabled').checked = value?.slopeEnabled === true;
    const east = value?.gradeEastPct ?? 0, north = value?.gradeNorthPct ?? 0;
    this.field('direction').value = String((CesiumMath.toDegrees(Math.atan2(east, north)) + 360) % 360);
    this.field('grade').value = String(Math.hypot(east, north));
    this.field('clipping').checked = value?.clippingEnabled !== false;
    // A previous confirmation is tied to the parent panel's dependency version, not a reusable UI consent.
    this.field('accept-height').checked = false;
    this.refresh(); this.refreshOutlines();
    this.setStatus(value?.boundary?.length ? '已恢复场地范围及标高；修改后请更新预览。' : '选择倾斜摄影后直接框选范围，初始标高自动获取。');
  }

  /** Parent calls only after the current preview's selected-model sample has succeeded. */
  setResolvedReference(reference: HardeningReference) {
    if (this.disposed) return;
    validateHardeningReference(reference);
    this.writeReference(reference);
    this.refresh(); this.refreshOutlines();
  }

  private writeReference(reference: HardeningReference) {
    this.field('longitude').value = String(reference.longitude);
    this.field('latitude').value = String(reference.latitude);
    this.field('height').value = String(reference.height);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.cancelDrawing();
    this.refreshButtons();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.element('.twh-editor').hidden = !visible;
    if (!visible) { this.cancelDrawing(); this.removeOutlines(); }
    else { this.refresh(); this.refreshOutlines(); }
  }
  setFacilities(facilities: readonly HardeningEditorFacility[]) {
    this.facilities = facilities.map(facility => ({ ...facility }));
    const select = this.element<HTMLSelectElement>('[data-hde="facility"]'), selected = select.value;
    select.replaceChildren(new Option(facilities.length ? '选择需要确认地坪的设施' : '无可选设施', ''),
      ...facilities.map(facility => new Option(facility.name, facility.id)));
    if (facilities.some(facility => facility.id === selected)) select.value = selected;
    this.renderRegions();
  }
  setStatus(message: string, error = false) {
    if (this.disposed) return;
    const node = this.element('[data-hde-status]');
    node.textContent = message; node.toggleAttribute('data-error', error);
  }
  /** Parent invalidates height acknowledgement when neighbouring geometry changes. */
  invalidateHeightConfirmation() { this.field('accept-height').checked = false; }
  refresh() {
    if (this.disposed) return;
    this.element('[data-hde-slope]').hidden = !this.field('slope-enabled').checked;
    this.refreshElevationControls();
    const model = this.options.getModel?.();
    this.element('[data-hde-model]').textContent = model ? `关联摄影：${model.name}` : '未关联摄影；仍可预览水泥场地，遮挡将等待明确关联图层。';
    this.refreshButtons(); this.renderPreview(); this.renderRegions(); this.renderVertices();
  }

  private refreshElevationControls() {
    const manual = this.elevationMode() === 'manual';
    this.element('[data-hde-manual-reference]').hidden = !manual;
    const height = this.field('height').value;
    this.element('[data-hde-elevation-hint]').textContent = manual
      ? '使用当前指定标高；保存后可通过位置调整升降。'
      : height.trim() && Number.isFinite(Number(height))
        ? `当前参考标高 ${Number(height).toFixed(3)} m；生成时从所选摄影获取初始标高，之后可通过位置调整升降。`
        : '初始标高自动取自所选倾斜摄影，框选后可用位置调整升降。';
  }

  private refreshButtons() {
    for (const fieldset of this.options.root.querySelectorAll<HTMLFieldSetElement>('[data-hde-fieldset]'))
      fieldset.disabled = !this.enabled || this.busy;
    this.element<HTMLButtonElement>('[data-hde-action="preview"]').disabled = !this.enabled || this.busy;
    this.element<HTMLButtonElement>('[data-hde-action="cancel"]').disabled = false;
    this.element('[data-hde-drawing]').hidden = !this.drawing;
  }
  private failure(error: unknown) {
    if (this.disposed) return;
    this.setStatus(error instanceof Error ? error.message : String(error), true);
    this.options.onError?.(error);
  }
  private changed(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return;
    event.stopPropagation();
    if (!this.enabled || this.busy) return;
    if (input.dataset.hde === 'facility') {
      this.cancelDrawing();
      const selected = this.facilityExclusions.find(exclusion => exclusion.objectId === input.value);
      this.field('facility-height').value = selected && Number.isFinite(selected.floorHeight) ? String(selected.floorHeight) : '';
      this.field('facility-thickness').value = selected && Number.isFinite(selected.floorThickness) ? String(selected.floorThickness) : '';
      return;
    }
    if (event.type === 'change' && input instanceof HTMLInputElement && input.type !== 'checkbox' && !input.dataset.hdeVertex) return;
    // Checkbox input and change both fire; process only change.
    if (event.type === 'input' && input instanceof HTMLInputElement && input.type === 'checkbox') return;
    this.cancelDrawing();
    const confirmation = input.dataset.hde === 'accept-height';
    if (!confirmation && input.dataset.hde !== 'name' && input.dataset.hde !== 'clipping') this.invalidateHeightConfirmation();
    if (input.dataset.hde === 'facility-height' || input.dataset.hde === 'facility-thickness') {
      const selected = this.facilityExclusions.find(exclusion => exclusion.objectId === this.field('facility').value);
      if (selected) {
        const value = input.value.trim() ? Number(input.value) : NaN;
        if (input.dataset.hde === 'facility-height') selected.floorHeight = value; else selected.floorThickness = value;
        this.renderRegions();
      }
    }
    if (input.dataset.hdeVertex) {
      try {
        const [ringKey, indexText, component] = input.dataset.hdeVertex.split(':');
        const ring = this.ringForKey(ringKey), index = Number(indexText);
        const value = numberValue(input.value, component === 'longitude' ? '边界经度' : '边界纬度');
        if (!ring || !ring[index] || !['longitude', 'latitude'].includes(component)) return;
        if (Math.abs(value) > (component === 'longitude' ? 180 : 90)) throw new Error('边界坐标超出有效经纬度范围。');
        ring[index] = { ...ring[index], [component]: value };
        this.invalidVertexFields.delete(input.dataset.hdeVertex);
        this.invalidVertexValues.delete(input.dataset.hdeVertex);
      } catch (error) {
        this.invalidVertexFields.add(input.dataset.hdeVertex); this.invalidVertexValues.set(input.dataset.hdeVertex, input.value);
        this.failure(error); this.options.onChange?.(); return;
      }
    }
    this.element('[data-hde-slope]').hidden = !this.field('slope-enabled').checked;
    this.refreshElevationControls();
    if (!['name', 'clipping', 'accept-height'].includes(input.dataset.hde ?? '')) { this.renderPreview(); this.refreshOutlines(); }
    this.options.onChange?.();
  }
  private action(action: string) {
    switch (action) {
      case 'view-center': this.useViewCenter(); break;
      case 'rectangle': this.startDrawing('rectangle', 'outer'); break;
      case 'polygon': this.startDrawing('polygon', 'outer'); break;
      case 'hole': this.startDrawing('polygon', 'hole'); break;
      case 'facility': this.startDrawing('polygon', 'facility'); break;
      case 'finish': this.finishDrawing(); break;
      case 'undo':
        if (this.drawing) {
          this.drawing.points.pop(); this.drawing.hover = undefined;
          if (!this.drawing.points.length && this.drawing.automaticReference) this.drawing.reference = undefined;
          this.updateDrawingOutline();
        }
        break;
      case 'cancel-draw': this.cancelDrawing(); this.setStatus('已取消圈选，原范围保留。'); break;
      case 'cancel': this.cancelDrawing(); this.options.onCancel?.(); break;
      case 'preview': void this.preview(); break;
      case 'vertices-prev': case 'vertices-next':
        if (this.invalidVertexFields.size) throw new Error('请先修正当前页的边界点坐标。');
        this.verticesPage = Math.max(0, this.verticesPage + (action === 'vertices-next' ? 1 : -1));
        this.renderVertices(); break;
      default:
        if (action.startsWith('remove-hole:')) this.holes.splice(Number(action.split(':')[1]), 1);
        else if (action.startsWith('remove-facility:')) this.facilityExclusions.splice(Number(action.split(':')[1]), 1);
        else if (action.startsWith('remove-vertex:')) {
          const [, key, index] = action.split(':'); this.ringForKey(key)?.splice(Number(index), 1);
        } else return;
        this.invalidVertexFields.clear(); this.invalidVertexValues.clear();
        this.cancelDrawing(); this.invalidateHeightConfirmation(); this.refresh(); this.refreshOutlines(); this.options.onChange?.();
    }
  }
  private async preview() {
    try {
      const value = this.getValue();
      this.busy = true; this.refreshButtons();
      await this.options.onPreview(value);
    } catch (error) { this.failure(error); }
    finally { this.busy = false; if (!this.disposed) this.refreshButtons(); }
  }

  private useViewCenter() {
    const viewer = this.options.viewer;
    const canvas = viewer.canvas;
    const point = viewer.camera.pickEllipsoid(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2), viewer.scene.ellipsoid);
    if (!point) throw new Error('视图中心未落在地球表面，请调整为俯视或手动填写参考经纬度。');
    const location = Cartographic.fromCartesian(point);
    this.field('longitude').value = CesiumMath.toDegrees(location.longitude).toFixed(9);
    this.field('latitude').value = CesiumMath.toDegrees(location.latitude).toFixed(9);
    this.field('manual-elevation').checked = true;
    this.invalidateHeightConfirmation(); this.cancelDrawing(); this.refresh(); this.refreshOutlines();
    this.options.onChange?.();
    this.setStatus('已设置平面参考点；场地顶标高仍由你填写，不使用摄影表面高程。');
  }

  private prepareDrawing(mode: Drawing['mode'], target: DrawTarget): Drawing {
    const automaticReference = target === 'outer' && this.elevationMode() === 'automatic';
    const modelId = automaticReference ? this.options.getModel?.()?.id : undefined;
    if (automaticReference && (!modelId || !this.options.pickInitialReference))
      throw new Error('请先选择已加载的倾斜摄影再框选；也可在可选设置中手动指定标高。');
    const reference = automaticReference ? undefined : this.reference(), slopes = this.slopes();
    if (target !== 'outer' && this.boundary.length < 3) throw new Error('请先绘制场地外边界。');
    const facility = target === 'facility' ? this.facilities.find(item => item.id === this.field('facility').value) : undefined;
    if (target === 'facility' && !facility) throw new Error('请先选择需要确认地坪范围的设施。');
    const floorHeight = target === 'facility' ? numberValue(this.field('facility-height').value, '设施地坪顶椭球高') : undefined;
    const floorThickness = target === 'facility' ? numberValue(this.field('facility-thickness').value, '设施地坪厚度') : undefined;
    if (floorThickness !== undefined && floorThickness <= 0) throw new Error('设施地坪厚度须大于零。');
    return { mode, target, points: [], reference: floorHeight === undefined ? reference : { ...reference!, height: floorHeight },
      ...(target === 'facility' ? { gradeEastPct: 0, gradeNorthPct: 0 } : slopes), facility, floorHeight, floorThickness,
      automaticReference, modelId };
  }
  private startDrawing(mode: Drawing['mode'], target: DrawTarget) {
    const drawing = this.prepareDrawing(mode, target);
    this.cancelDrawing();
    this.drawing = drawing;
    try {
      this.finishSession = this.options.beginInteractionSession?.() || undefined;
      this.handler = new ScreenSpaceEventHandler(this.options.viewer.canvas);
      this.handler.setInputAction((event: { position: Cartesian2 }) => {
        try {
          const point = this.pick(event.position);
          if (!point || !this.drawing) return;
          const previous = this.drawing.points.at(-1);
          if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.001) return;
          if (this.drawing.points.length >= 2048) throw new Error('单个绘制轮廓最多2048点，请简化边界或分区。');
          this.drawing.points.push(point); this.drawing.hover = undefined;
          if (mode === 'rectangle' && this.drawing.points.length === 2) this.finishDrawing();
          else { this.updateDrawingOutline(); this.setStatus(`已选 ${this.drawing.points.length} 点；继续点选，完成后右键或点击“完成圈选”。`); }
        } catch (error) { this.failure(error); }
      }, ScreenSpaceEventType.LEFT_CLICK);
      this.handler.setInputAction((event: { endPosition: Cartesian2 }) => {
        if (!this.drawing) return;
        try {
          const point = this.pick(event.endPosition, false);
          if (this.drawing) this.drawing.hover = point;
          this.updateDrawingOutline();
        } catch (error) { this.failure(error); }
      }, ScreenSpaceEventType.MOUSE_MOVE);
      this.handler.setInputAction(() => {
        try { this.finishDrawing(); } catch (error) { this.failure(error); }
      }, ScreenSpaceEventType.RIGHT_CLICK);
      this.refreshButtons();
      this.setStatus(drawing.automaticReference
        ? '直接在所选倾斜摄影上点选第一个角点，自动获取初始标高；继续框选范围。Esc 取消。'
        : mode === 'rectangle' ? '在当前标高平面上选择矩形两个对角点。Esc 取消。' : '依次点选边界，右键或“完成圈选”结束。Esc 取消。');
    } catch (error) { this.cancelDrawing(); throw error; }
  }
  private pick(screen: Cartesian2, announce = true) {
    const drawing = this.drawing;
    if (!drawing) return;
    if (drawing.automaticReference && this.options.getModel?.()?.id !== drawing.modelId) {
      this.cancelDrawing();
      throw new Error('所选倾斜摄影已变化，本次框选已取消，请在当前图层重新框选。');
    }
    if (!drawing.reference) {
      // Hover must not fix the anchor before the user's first click.
      if (!announce) return;
      const reference = this.options.pickInitialReference?.(screen);
      if (!reference) {
        this.setStatus('未拾取到所选倾斜摄影，请点击已加载的模型表面；也可手动指定标高。', true);
        return;
      }
      validateHardeningReference(reference);
      drawing.reference = { ...reference };
      return { x: 0, y: 0 };
    }
    const ray = this.options.viewer.camera.getPickRay(screen);
    const point = ray && intersectHardeningDesignPlane(ray, drawing.reference, drawing.gradeEastPct, drawing.gradeNorthPct);
    if (!point && announce) this.setStatus('视线与设计平面接近平行或选点过远，请调整为俯视并检查参考点。', true);
    return point;
  }
  private finishDrawing() {
    const drawing = this.drawing;
    if (!drawing) return;
    if (!drawing.reference) throw new Error('请先在所选倾斜摄影上选择第一个角点。');
    if (drawing.automaticReference && this.options.getModel?.()?.id !== drawing.modelId) {
      this.cancelDrawing();
      throw new Error('所选倾斜摄影已变化，本次框选已取消，请重新框选。');
    }
    const local = drawing.mode === 'rectangle'
      ? drawing.points.length >= 2 ? hardeningRectangle(drawing.points[0], drawing.points[1]) : []
      : drawing.points;
    if (local.length < 3) throw new Error(drawing.mode === 'rectangle' ? '请选取两个不同的矩形对角点。' : '多边形至少需要三个点。');
    const reference = drawing.reference;
    const ring = local.map(point => hardeningGeoFromLocal(point, reference));
    if (drawing.target === 'outer') {
      this.boundary = ring;
      if (drawing.automaticReference) this.writeReference(drawing.reference);
      // Keep user-owned exclusions; geometry validation will explicitly report any now outside the boundary.
    } else if (drawing.target === 'hole') this.holes.push(ring);
    else if (drawing.facility) {
      const exclusion = { objectId: drawing.facility.id, resourceVersion: drawing.facility.resourceVersion, boundary: ring,
        floorHeight: drawing.floorHeight!, floorThickness: drawing.floorThickness! };
      const existing = this.facilityExclusions.findIndex(item => item.objectId === exclusion.objectId);
      if (existing < 0) this.facilityExclusions.push(exclusion); else this.facilityExclusions[existing] = exclusion;
    }
    this.invalidVertexFields.clear(); this.invalidVertexValues.clear();
    this.cancelDrawing(); this.invalidateHeightConfirmation(); this.refresh(); this.refreshOutlines();
    this.options.onChange?.();
    this.setStatus(drawing.automaticReference
      ? '范围已更新，初始标高已自动获取。生成预览后可再调整位置和标高。'
      : '范围已更新。生成预览时检查边界、孔洞和重叠高差。');
  }

  cancelDrawing() {
    this.drawing = undefined;
    if (this.handler && !this.handler.isDestroyed()) this.handler.destroy();
    this.handler = undefined;
    const finish = this.finishSession; this.finishSession = undefined; finish?.();
    if (this.drawingOutline && !this.options.viewer.isDestroyed()) this.options.viewer.entities.remove(this.drawingOutline);
    this.drawingOutline = undefined;
    if (!this.disposed && this.options.root?.querySelector('[data-hde-drawing]')) this.refreshButtons();
    this.requestRender();
  }
  private requestRender() { if (!this.options.viewer.isDestroyed()) this.options.viewer.scene.requestRender(); }
  private worldRing(ring: readonly HardeningGeoPoint[], floorHeight?: number) {
    const reference = this.reference(), slope = this.slopes();
    return ring.map(point => {
      const local = hardeningLocalFromGeo(point, reference);
      return Cartesian3.fromDegrees(point.longitude, point.latitude, floorHeight ?? (reference.height + local.x * slope.gradeEastPct / 100 + local.y * slope.gradeNorthPct / 100));
    });
  }
  private updateDrawingOutline() {
    const drawing = this.drawing;
    if (!drawing || this.options.viewer.isDestroyed()) return;
    if (!drawing.reference) {
      if (this.drawingOutline) this.drawingOutline.show = false;
      this.requestRender(); return;
    }
    let points = [...drawing.points, ...(drawing.hover ? [drawing.hover] : [])];
    if (drawing.mode === 'rectangle' && points.length >= 2) {
      try { points = hardeningRectangle(points[0], points.at(-1)!); } catch { points = points.slice(0, 1); }
    }
    if (points.length > 2) points.push(points[0]);
    const reference = drawing.reference;
    const positions = points.map(point => {
      const geo = hardeningGeoFromLocal(point, reference);
      return Cartesian3.fromDegrees(geo.longitude, geo.latitude, reference.height + point.x * drawing.gradeEastPct / 100 + point.y * drawing.gradeNorthPct / 100);
    });
    if (!this.drawingOutline && positions.length >= 2) {
      this.drawingOutline = this.options.viewer.entities.add({ name: '硬化圈选预览',
        polyline: { positions, width: 2, material: Color.YELLOW, depthFailMaterial: Color.YELLOW.withAlpha(0.4), clampToGround: false } });
    } else if (this.drawingOutline) {
      this.drawingOutline.show = positions.length >= 2;
      this.drawingOutline.polyline!.positions = new ConstantProperty(positions);
    }
    this.requestRender();
  }
  private removeOutlines() {
    if (!this.options.viewer.isDestroyed()) for (const outline of this.outlines) this.options.viewer.entities.remove(outline);
    this.outlines = [];
    this.requestRender();
  }
  private refreshOutlines() {
    this.removeOutlines();
    if (!this.visible || this.disposed || this.options.viewer.isDestroyed()) return;
    try {
      const rings = [{ ring: this.boundary, color: Color.CYAN, floorHeight: undefined }, ...this.holes.map(ring => ({ ring, color: Color.ORANGE, floorHeight: undefined })),
        ...this.facilityExclusions.map(item => ({ ring: item.boundary, color: Color.LIME, floorHeight: Number.isFinite(item.floorHeight) ? item.floorHeight : undefined }))];
      for (const { ring, color, floorHeight } of rings) if (ring.length >= 2) {
        this.outlines.push(this.options.viewer.entities.add({ name: '硬化编辑边界',
          polyline: { positions: this.worldRing([...ring, ring[0]], floorHeight), width: 2, material: color, depthFailMaterial: color.withAlpha(0.4), clampToGround: false } }));
      }
      this.requestRender();
    } catch { /* Incomplete numeric input keeps the source outline; it is redrawn once valid. */ }
  }
  private ringForKey(key: string) {
    if (key === 'outer') return this.boundary;
    if (key.startsWith('hole-')) return this.holes[Number(key.slice(5))];
    if (key.startsWith('facility-')) return this.facilityExclusions[Number(key.slice(9))]?.boundary;
  }
  private renderRegions() {
    const list = this.element('[data-hde-regions]'); list.replaceChildren();
    const add = (text: string, action?: string) => {
      const item = document.createElement('li'), label = document.createElement('span'); label.textContent = text; item.append(label);
      if (action) { const button = document.createElement('button'); button.type = 'button'; button.textContent = '删除'; button.dataset.hdeAction = action; item.append(button); }
      list.append(item);
    };
    add(`外边界：${this.boundary.length} 点`);
    this.holes.forEach((hole, index) => add(`永久保留区 ${index + 1}：${hole.length} 点`, `remove-hole:${index}`));
    this.facilityExclusions.forEach((exclusion, index) => {
      const floor = Number.isFinite(exclusion.floorHeight) && Number.isFinite(exclusion.floorThickness) && exclusion.floorThickness > 0
        ? `顶椭球高 ${exclusion.floorHeight} m，厚度 ${exclusion.floorThickness} m` : '地坪标高、厚度待确认';
      add(`随设施避让：${this.facilities.find(facility => facility.id === exclusion.objectId)?.name ?? exclusion.objectId}（${exclusion.boundary.length} 点；${floor}）`, `remove-facility:${index}`);
    });
  }
  private renderVertices() {
    const container = this.element('[data-hde-vertices]'); container.replaceChildren();
    if (!this.element<HTMLDetailsElement>('[data-hde-coordinate-details]').open) return;
    const rings = [{ key: 'outer', name: '外边界', ring: this.boundary },
      ...this.holes.map((ring, index) => ({ key: `hole-${index}`, name: `永久保留区 ${index + 1}`, ring })),
      ...this.facilityExclusions.map((item, index) => ({ key: `facility-${index}`, name: `设施避让区 ${index + 1}`, ring: item.boundary }))];
    const total = rings.reduce((sum, item) => sum + item.ring.length, 0), pageSize = 100;
    this.verticesPage = Math.max(0, Math.min(this.verticesPage, Math.ceil(total / pageSize) - 1));
    let visited = 0;
    for (const { key, name, ring } of rings) {
      const begin = Math.max(0, this.verticesPage * pageSize - visited);
      const end = Math.min(ring.length, (this.verticesPage + 1) * pageSize - visited);
      visited += ring.length;
      if (end <= begin) continue;
      const heading = document.createElement('p'); heading.className = 'twh-outline-title'; heading.textContent = name; container.append(heading);
      for (let i = begin; i < end; i++) {
        const row = document.createElement('div'); row.className = 'twh-vertex';
        const number = document.createElement('span'); number.textContent = String(i + 1); row.append(number);
        for (const component of ['longitude', 'latitude'] as const) {
          const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.value = this.invalidVertexValues.get(`${key}:${i}:${component}`) ?? String(ring[i][component]);
          input.setAttribute('aria-label', `${name}第${i + 1}点${component === 'longitude' ? '经度' : '纬度'}`);
          input.dataset.hdeVertex = `${key}:${i}:${component}`; row.append(input);
        }
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删点'; remove.dataset.hdeAction = `remove-vertex:${key}:${i}`; row.append(remove);
        container.append(row);
      }
    }
    if (total > pageSize) {
      const navigation = document.createElement('div'); navigation.className = 'twh-actions';
      for (const [action, label, disabled] of [['vertices-prev', '上一页', this.verticesPage === 0], ['vertices-next', '下一页', (this.verticesPage + 1) * pageSize >= total]] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.hdeAction = action; button.textContent = label; button.disabled = disabled; navigation.append(button);
      }
      const count = document.createElement('span'); count.textContent = `${this.verticesPage + 1} / ${Math.ceil(total / pageSize)} 页`; navigation.append(count); container.append(navigation);
    }
  }
  private renderPreview() {
    const container = this.element('[data-hde-preview]'); container.replaceChildren();
    if (!this.boundary.length) { const hint = document.createElement('p'); hint.className = 'twh-hint'; hint.textContent = '尚未框选场地'; container.append(hint); return; }
    try {
      // XY reference can be used before the user supplies elevation; the display is explicitly only a plan view.
      const reference = { longitude: this.boundary[0].longitude, latitude: this.boundary[0].latitude, height: 0 };
      const rings = [{ ring: this.boundary, color: '#67e1e1' }, ...this.holes.map(ring => ({ ring, color: '#ffbb6e' })),
        ...this.facilityExclusions.map(item => ({ ring: item.boundary, color: '#83df9d' }))]
        .map(item => ({ ...item, points: item.ring.map(point => hardeningLocalFromGeo(point, reference)) }));
      const all = rings.flatMap(ring => ring.points), xs = all.map(point => point.x), ys = all.map(point => point.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const scale = Math.min(360 / Math.max(1, x1 - x0), 120 / Math.max(1, y1 - y0));
      const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 400 150'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '硬化范围平面预览，橙色为永久保留区，绿色为随设施避让区');
      for (const item of rings) {
        const polygon = document.createElementNS(ns, 'polygon');
        polygon.setAttribute('points', item.points.map(point => `${200 + (point.x - (x0 + x1) / 2) * scale},${75 - (point.y - (y0 + y1) / 2) * scale}`).join(' '));
        polygon.setAttribute('fill', 'none'); polygon.setAttribute('stroke', item.color); polygon.setAttribute('stroke-width', '2'); svg.append(polygon);
      }
      container.append(svg);
    } catch { const note = document.createElement('p'); note.textContent = '边界坐标待修正'; container.append(note); }
  }

  destroy() {
    if (this.disposed) return;
    this.cancelDrawing(); this.removeOutlines(); this.listeners.abort();
    this.disposed = true; this.options.root.replaceChildren();
  }
}
