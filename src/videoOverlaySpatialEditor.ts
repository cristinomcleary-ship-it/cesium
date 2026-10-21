import {
  createSpatialAnnotation, validateSpatialAnnotations,
  type SpatialAnnotation, type SpatialAnnotationKind,
} from './videoOverlaySpatialAnnotations';

type Target = { id: string; name: string };
type Point = { x: number; y: number; z: number };
type ScreenPoint = { x: number; y: number };
type Draft = {
  kind: SpatialAnnotationKind; target: Target; points: Point[]; screen: ScreenPoint[];
  interval: { start: number; end: number }; original?: SpatialAnnotation;
};
export type VideoOverlaySpatialEditorOptions = {
  root: HTMLElement;
  getTime: () => number;
  getDuration: () => number;
  onChange: (marks: SpatialAnnotation[]) => void;
  pick: (targetId: string, u: number, v: number) => Point;
  onBeginPick?: () => void;
};
const labels: Record<SpatialAnnotationKind, string> = { label: '引线标签', route: '线形走向', area: '区域面' };
const minimum: Record<SpatialAnnotationKind, number> = { label: 1, route: 2, area: 3 };
let counter = 0;

/** Target-local geometry is authoritative. Screen coordinates exist only for unfinished editor handles. */
export class VideoOverlaySpatialEditor {
  private readonly options: VideoOverlaySpatialEditorOptions;
  private readonly events = new AbortController();
  private canvasEvents?: AbortController;
  private observer?: MutationObserver;
  private canvas?: HTMLCanvasElement;
  private previousStyle?: { pointerEvents: string; touchAction: string; cursor: string };
  private marks: SpatialAnnotation[] = [];
  private targets: Target[] = [];
  private selected = '';
  private target = '';
  private draft?: Draft;
  private disposed = false;

  constructor(options: VideoOverlaySpatialEditorOptions) {
    this.options = options;
    options.root.innerHTML = `
      <style>
        .cc-spatial-editor{display:grid;gap:8px;font-size:12px;color:inherit}
        .cc-spatial-editor>details{border:1px solid #78d6ff50;border-radius:6px;padding:9px}
        .cc-spatial-editor summary{cursor:pointer;font-weight:600;margin-bottom:8px}
        .cc-spatial-editor label{display:grid;gap:4px;min-width:0}
        .cc-spatial-editor input,.cc-spatial-editor select,.cc-spatial-editor textarea{box-sizing:border-box;width:100%;min-width:0;font:inherit}
        .cc-spatial-editor textarea{min-height:56px;resize:vertical}
        .cc-spatial-editor .sp-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:8px 0}
        .cc-spatial-editor .sp-span{grid-column:1/-1}
        .cc-spatial-editor .sp-buttons{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
        .cc-spatial-editor button{font:inherit;cursor:pointer}
        .cc-spatial-editor small{display:block;line-height:1.5;opacity:.8;margin:5px 0}
        .cc-spatial-editor fieldset{border:0;padding:0;margin:0;min-width:0}
        .cc-spatial-editor .sp-check{display:flex;align-items:center;gap:6px}
        .cc-spatial-editor .sp-check input{width:auto}
        .cc-spatial-editor .sp-draft{border-left:3px solid #62dbff;padding:6px 8px;background:#44b6d61a}
        .cc-spatial-editor [data-sp-error],.cc-spatial-editor [data-sp-missing]{color:#ffca91;line-height:1.5}
        .cc-spatial-editor [hidden]{display:none!important}
      </style>
      <div class="cc-spatial-editor"><details open><summary>结构标绘（模型 / CAD）</summary>
        <small>暂停融合视频，在已叠加的结构上点选。标绘绑定对象空间位置，随镜头和对象平移、旋转同步变化。</small>
        <label>绘制对象<select data-sp-target aria-label="结构标绘对象"></select></label>
        <div class="sp-buttons">
          <button type="button" data-sp-add="label">＋引线标签</button>
          <button type="button" data-sp-add="route">＋线形走向</button>
          <button type="button" data-sp-add="area">＋区域面</button>
        </div>
        <div class="sp-draft" data-sp-draft hidden>
          <div data-sp-progress role="status"></div>
          <div class="sp-buttons"><button type="button" data-sp-finish>完成绘制（Enter）</button><button type="button" data-sp-undo>撤回上一点</button><button type="button" data-sp-cancel>取消（Esc）</button></div>
          <small>点击目标结构继续取点；区域最后一点无需重复首点。绘制期间请保持当前视频帧。</small>
        </div>
        <label>已有标绘<select data-sp-list aria-label="选择结构标绘"></select></label>
        <small data-sp-binding></small><small data-sp-missing></small>
        <div class="sp-buttons"><button type="button" data-sp-repick>重新选点</button><button type="button" data-sp-copy>复制</button><button type="button" data-sp-delete>删除</button></div>
        <fieldset data-sp-fields>
          <label>名称 / 说明<textarea data-sp-field="text" maxlength="2000" placeholder="如：6号墩盖梁 / 邻近营业线施工范围"></textarea></label>
          <div class="sp-grid">
            <label>标绘颜色<input type="color" data-sp-field="color"></label>
            <label class="sp-check"><input type="checkbox" data-sp-field="visible">显示此标绘</label>
            <label>开始（秒）<input type="number" min="0" step="0.01" data-sp-field="start"></label>
            <label>结束（秒）<input type="number" min="0" step="0.01" data-sp-field="end"></label>
          </div>
          <div class="sp-buttons"><button type="button" data-sp-now>从当前时间显示 5 秒</button><button type="button" data-sp-all>整段视频显示</button></div>
          <details><summary>样式与位置</summary><div class="sp-grid">
            <label>字号（1080p）<input type="number" min="8" max="160" step="1" data-sp-field="fontSize"></label>
            <label>线宽（1080p）<input type="number" min="0.5" max="40" step="0.5" data-sp-field="lineWidth"></label>
            <label data-sp-area>区域填充不透明度<input type="range" min="0" max="1" step="0.01" data-sp-field="fillOpacity" aria-label="区域填充不透明度"></label>
            <label data-sp-route class="sp-check"><input type="checkbox" data-sp-field="flow">流动方向箭头</label>
            <label>文字水平偏移<input type="number" min="-4000" max="4000" step="5" data-sp-field="offsetX"></label>
            <label>文字垂直偏移<input type="number" min="-4000" max="4000" step="5" data-sp-field="offsetY"></label>
            <label>淡入（秒）<input type="number" min="0" max="3600" step="0.05" data-sp-field="fadeIn"></label>
            <label>淡出（秒）<input type="number" min="0" max="3600" step="0.05" data-sp-field="fadeOut"></label>
          </div><small>文字偏移只调整排版，不移动结构锚点；尺寸按 1080p 比例适配预览和导出。</small></details>
        </fieldset>
        <small>采用透视说明样式：标绘绘制在融合画面上层，不参与遮挡裁切。关联对象隐藏或不可用时，标绘同步隐藏；修改后重新生成完整融合缓存。</small>
        <div data-sp-error role="status" aria-live="polite"></div>
      </details></div>`;
    const signal = this.events.signal;
    options.root.addEventListener('click', this.handleClick, { signal });
    options.root.addEventListener('input', this.handleInput, { signal });
    options.root.addEventListener('change', this.handleChange, { signal });
    document.addEventListener('keydown', this.keyDown, { signal, capture: true });
    this.render();
  }

  get editing(): boolean { return !!this.draft; }
  get annotations(): SpatialAnnotation[] { return structuredClone(this.marks); }

  /** Called before seek, camera edits or cache preparation; completed geometry is untouched. */
  cancelPicking() {
    if (!this.draft || this.disposed) return;
    this.draft = undefined; this.error(''); this.render();
  }

  setValue(marks: readonly SpatialAnnotation[]) {
    if (this.disposed) return;
    this.marks = validateSpatialAnnotations(marks);
    this.draft = undefined;
    if (!this.mark()) this.selected = this.marks[0]?.id ?? '';
    this.error(''); this.render();
  }

  setTargets(targets: readonly Target[]) {
    if (this.disposed) return;
    this.targets = targets.map(value => ({ ...value }));
    if (!this.targets.some(value => value.id === this.target)) this.target = this.targets[0]?.id ?? '';
    if (this.draft && !this.targets.some(value => value.id === this.draft?.target.id)) {
      this.draft = undefined; this.error('绘制对象已隐藏或移除，本次未完成的绘制已取消。'); this.render(); return;
    }
    this.renderTargets(); this.renderBinding(); this.renderDraft();
  }

  mount(canvas: HTMLCanvasElement) {
    if (this.disposed) return;
    this.unmount(); this.canvas = canvas;
    this.previousStyle = { pointerEvents: canvas.style.pointerEvents, touchAction: canvas.style.touchAction, cursor: canvas.style.cursor };
    this.canvasEvents = new AbortController();
    canvas.addEventListener('pointerdown', this.pointerDown, { signal: this.canvasEvents.signal });
    this.observer = new MutationObserver(() => this.drawDraft());
    this.observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    this.renderDraft();
  }

  unmount() {
    this.canvasEvents?.abort(); this.canvasEvents = undefined;
    this.observer?.disconnect(); this.observer = undefined;
    if (this.canvas) {
      const context = this.canvas.getContext('2d');
      if (context) this.clearCanvas(context, this.canvas);
      if (this.previousStyle) Object.assign(this.canvas.style, this.previousStyle);
    }
    this.canvas = undefined; this.previousStyle = undefined; this.draft = undefined;
    if (!this.disposed) this.render();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true; this.unmount(); this.events.abort();
    this.options.root.replaceChildren(); this.marks = []; this.targets = [];
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T { return this.options.root.querySelector<T>(selector)!; }
  private mark() { return this.marks.find(value => value.id === this.selected); }
  private error(value: string) { this.query('[data-sp-error]').textContent = value; }
  private emit() { this.options.onChange(this.annotations); }
  private id() { return globalThis.crypto?.randomUUID?.() ?? `spatial-${Date.now()}-${++counter}`; }
  private interval() {
    const duration = this.options.getDuration(), now = this.options.getTime();
    const limit = Number.isFinite(duration) && duration > 0 ? duration : undefined;
    const start = Math.max(0, Math.min(Number.isFinite(now) ? now : 0, limit ? Math.max(0, limit - 0.05) : 86_399_995));
    return { start, end: limit ? Math.max(start + 0.001, Math.min(start + 5, limit)) : start + 5 };
  }
  private optionsFor(select: HTMLSelectElement, values: { id: string; label: string }[], selected: string, empty: string) {
    select.replaceChildren();
    if (!values.length) values = [{ id: '', label: empty }];
    for (const value of values) {
      const option = document.createElement('option'); option.value = value.id; option.textContent = value.label; select.append(option);
    }
    select.value = selected;
  }
  private renderTargets() {
    this.optionsFor(this.query<HTMLSelectElement>('[data-sp-target]'), this.targets.map(value => ({ id: value.id, label: value.name })), this.target, '请先选择参与融合的模型 / CAD');
    this.query<HTMLSelectElement>('[data-sp-target]').disabled = !!this.draft;
    this.options.root.querySelectorAll<HTMLButtonElement>('[data-sp-add]').forEach(button => { button.disabled = !this.target || !!this.draft; });
  }
  private renderList() {
    this.optionsFor(this.query<HTMLSelectElement>('[data-sp-list]'), this.marks.map((value, index) => ({
      id: value.id, label: `${index + 1}. ${value.visible ? '' : '已隐藏 · '}${labels[value.kind]} · ${value.text.replace(/\s+/g, ' ').slice(0, 22) || value.targetName}`,
    })), this.selected, '尚未添加结构标绘');
    this.query<HTMLSelectElement>('[data-sp-list]').disabled = !!this.draft;
    for (const key of ['repick', 'copy', 'delete']) this.query<HTMLButtonElement>(`[data-sp-${key}]`).disabled = !this.mark() || !!this.draft;
  }
  private renderBinding() {
    const mark = this.mark();
    this.query('[data-sp-binding]').textContent = mark ? `绑定对象：${mark.targetName} · ${mark.points.length} 个空间锚点` : '';
    this.query('[data-sp-missing]').textContent = mark && !this.targets.some(value => value.id === mark.targetId)
      ? '关联对象尚未加载、未参与融合或已移除。该标绘保留，当前隐藏；重新选点可绑定新的绘制对象。' : '';
  }
  private renderFields() {
    const mark = this.mark();
    this.query<HTMLFieldSetElement>('[data-sp-fields]').disabled = !mark || !!this.draft;
    for (const input of this.options.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-sp-field]')) {
      const key = input.dataset.spField as keyof SpatialAnnotation;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!mark?.[key];
      else if (key === 'color' && mark) { const hex = mark.color.slice(1); input.value = `#${hex.length <= 4 ? Array.from(hex.slice(0, 3), character => character + character).join('') : hex.slice(0, 6)}`; }
      else input.value = String(mark?.[key] ?? '');
    }
    this.query('[data-sp-area]').hidden = mark?.kind !== 'area';
    this.query('[data-sp-route]').hidden = mark?.kind !== 'route';
    this.renderBinding();
  }
  private renderDraft() {
    const draft = this.draft;
    this.query('[data-sp-draft]').hidden = !draft;
    this.query('[data-sp-progress]').textContent = draft ? `${labels[draft.kind]} · ${draft.target.name}：已选 ${draft.points.length} 点${draft.kind === 'label' ? '，点击结构确定标签锚点' : `，至少需要 ${minimum[draft.kind]} 点`}` : '';
    this.query<HTMLButtonElement>('[data-sp-finish]').disabled = !draft || draft.points.length < minimum[draft.kind];
    this.query<HTMLButtonElement>('[data-sp-undo]').disabled = !draft?.points.length;
    if (this.canvas) {
      this.canvas.hidden = !draft;
      // Discard the helper bitmap on completion/cancel. Keep this outside
      // drawDraft: the width observer redraws only and must not reset itself.
      if (!draft) this.canvas.width = this.canvas.width;
      Object.assign(this.canvas.style, { pointerEvents: draft ? 'auto' : 'none', touchAction: draft ? 'none' : '', cursor: draft ? 'crosshair' : '' });
    }
    this.drawDraft();
  }
  private render() { this.renderTargets(); this.renderList(); this.renderFields(); this.renderDraft(); }

  private begin(kind: SpatialAnnotationKind, original?: SpatialAnnotation) {
    if (!original && this.marks.length >= 500) throw new Error('最多支持 500 条结构标绘，请先删除不需要的标绘。');
    const target = this.targets.find(value => value.id === this.target);
    if (!target) throw new Error('请先选择参与融合的模型或 CAD 对象。');
    this.options.onBeginPick?.();
    if (!this.canvas || !this.canvas.isConnected) throw new Error('请先进入融合编辑，暂停到目标结构清晰可见的画面，再开始标绘。');
    this.draft = { kind, target: { ...target }, points: [], screen: [], interval: this.interval(), original: original ? structuredClone(original) : undefined };
    this.error(''); this.render();
  }
  private finish() {
    const draft = this.draft;
    if (!draft || draft.points.length < minimum[draft.kind]) throw new Error(`请至少选取 ${draft ? minimum[draft.kind] : 1} 个结构点。`);
    const mark = createSpatialAnnotation(draft.kind, {
      ...draft.interval, fadeIn: 0, text: draft.kind === 'label' ? '结构说明' : draft.kind === 'route' ? '线路走向' : '施工区域',
      ...draft.original, id: draft.original?.id ?? this.id(), targetId: draft.target.id, targetName: draft.target.name,
      points: draft.points.map(point => ({ ...point })),
    });
    const index = this.marks.findIndex(value => value.id === mark.id);
    if (index >= 0) this.marks[index] = mark; else this.marks.push(mark);
    this.selected = mark.id; this.draft = undefined;
    this.error(''); this.render(); this.emit();
  }
  private replace(mark: SpatialAnnotation, patch: Partial<SpatialAnnotation>) {
    const next = validateSpatialAnnotations([{ ...mark, ...patch }])[0];
    this.marks[this.marks.indexOf(mark)] = next;
    this.error(''); this.renderList(); this.renderBinding(); this.emit();
  }
  private readonly handleClick = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || !this.options.root.contains(button) || button.disabled) return;
    try {
      if (button.dataset.spAdd) return this.begin(button.dataset.spAdd as SpatialAnnotationKind);
      if (button.hasAttribute('data-sp-cancel')) { this.draft = undefined; this.error(''); this.render(); return; }
      if (button.hasAttribute('data-sp-undo')) { this.draft?.points.pop(); this.draft?.screen.pop(); this.error(''); this.renderDraft(); return; }
      if (button.hasAttribute('data-sp-finish')) return this.finish();
      const mark = this.mark(); if (!mark) return;
      if (button.hasAttribute('data-sp-repick')) return this.begin(mark.kind, mark);
      if (button.hasAttribute('data-sp-delete')) { this.marks = this.marks.filter(value => value.id !== mark.id); this.selected = this.marks[0]?.id ?? ''; }
      else if (button.hasAttribute('data-sp-copy')) { if (this.marks.length >= 500) throw new Error('最多支持 500 条结构标绘。'); const copy = createSpatialAnnotation(mark.kind, { ...structuredClone(mark), id: this.id(), text: `${mark.text}（副本）`.slice(0, 2000), offsetX: Math.min(4000, mark.offsetX + 20) }); this.marks.push(copy); this.selected = copy.id; }
      else if (button.hasAttribute('data-sp-now')) { this.replace(mark, this.interval()); this.renderFields(); return; }
      else if (button.hasAttribute('data-sp-all')) {
        const duration = this.options.getDuration();
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('请先载入视频，读取完整时长。');
        this.replace(mark, { start: 0, end: duration }); this.renderFields(); return;
      } else return;
      this.error(''); this.render(); this.emit();
    } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
  };
  private readonly handleChange = (event: Event) => {
    const input = event.target;
    if (input instanceof HTMLSelectElement && input.hasAttribute('data-sp-target')) { this.target = input.value; return; }
    if (input instanceof HTMLSelectElement && input.hasAttribute('data-sp-list')) {
      this.selected = input.value; const mark = this.mark();
      if (mark && this.targets.some(value => value.id === mark.targetId)) this.target = mark.targetId;
      this.error(''); this.render(); return;
    }
    if (input instanceof HTMLInputElement && input.type === 'checkbox') this.changeField(input);
  };
  private readonly handleInput = (event: Event) => {
    const input = event.target;
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && input.type !== 'checkbox') this.changeField(input);
  };
  private changeField(input: HTMLInputElement | HTMLTextAreaElement) {
    const key = input.dataset.spField, mark = this.mark(); if (!key || !mark || this.draft) return;
    try {
      let value: string | boolean | number = input.value;
      if (input instanceof HTMLInputElement) {
        if (input.type === 'checkbox') value = input.checked;
        else if (input.type === 'number' || input.type === 'range') {
          value = input.valueAsNumber;
          if (!Number.isFinite(value) || !input.validity.valid) throw new Error('请输入允许范围内的有效数值。');
        }
      }
      this.replace(mark, { [key]: value });
    } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
  }
  private readonly keyDown = (event: KeyboardEvent) => {
    if (!this.draft) return;
    if (event.key === 'Escape') { this.draft = undefined; this.error(''); this.render(); event.preventDefault(); event.stopImmediatePropagation(); return; }
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable) return;
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation();
      try { this.finish(); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
    }
  };
  private readonly pointerDown = (event: PointerEvent) => {
    const draft = this.draft, canvas = this.canvas;
    if (!draft || !canvas || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    try {
      if (draft.points.length >= 256) throw new Error('单条标绘最多支持 256 个点，请完成当前标绘。');
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      const local = this.options.pick(draft.target.id, x, y);
      if (![local.x, local.y, local.z].every(Number.isFinite)) throw new Error('未获得有效结构坐标，请在目标模型或 CAD 上重新选点。');
      const previous = draft.points.at(-1);
      if (previous && Math.hypot(local.x - previous.x, local.y - previous.y, local.z - previous.z) < 0.001) throw new Error('该点与上一点重合，请选择不同位置。');
      draft.points.push({ ...local }); draft.screen.push({ x, y });
      this.error(''); this.renderDraft();
      if (draft.kind === 'label') this.finish();
    } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
  };
  /** The editor owns this context exclusively. Every redraw starts with an
   * empty bitmap and drawing state, including completion and cancellation. */
  private clearCanvas(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    if (typeof context.reset === 'function') context.reset();
    else { context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height); context.restore(); context.beginPath(); }
  }

  private drawDraft() {
    const canvas = this.canvas; if (!canvas || this.disposed) return;
    const context = canvas.getContext('2d'); if (!context) return;
    this.clearCanvas(context, canvas);
    const draft = this.draft, rect = canvas.getBoundingClientRect();
    if (!draft?.screen.length || rect.width <= 0 || rect.height <= 0) return;
    context.save();
    try {
      context.setTransform(canvas.width / rect.width, 0, 0, canvas.height / rect.height, 0, 0);
      const points = draft.screen.map(point => ({ x: point.x * rect.width, y: point.y * rect.height }));
      context.strokeStyle = '#73e3ff'; context.lineWidth = 2; context.setLineDash([6, 4]);
      context.beginPath(); context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      if (draft.kind === 'area' && points.length >= 3) context.closePath();
      context.stroke(); context.setLineDash([]);
      points.forEach((point, index) => {
        context.beginPath(); context.arc(point.x, point.y, 5, 0, Math.PI * 2);
        context.fillStyle = '#ffffff'; context.fill(); context.strokeStyle = '#0f5269'; context.stroke();
        context.font = 'bold 12px sans-serif'; context.textAlign = 'left'; context.textBaseline = 'bottom';
        context.lineWidth = 3; context.strokeStyle = '#082535'; context.strokeText(String(index + 1), point.x + 9, point.y - 4);
        context.fillText(String(index + 1), point.x + 9, point.y - 4); context.lineWidth = 2;
      });
    } finally { context.restore(); }
  }
}
