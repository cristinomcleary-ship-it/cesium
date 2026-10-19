import {
  createVideoOverlayAnnotation, validateVideoOverlayAnnotation, wrapVideoOverlayAnnotationText,
  type VideoOverlayAnnotation, type VideoOverlayAnnotationType,
} from './videoOverlayAnnotations.ts';
import {
  defaultVideoOverlayEffect, validateVideoOverlayEffect, validateVideoOverlayEffects,
  type SavedVideoOverlayEffect,
} from './videoOverlayEffects.ts';

export type VideoOverlayPresentationEditorOptions = {
  root: HTMLElement;
  getTime: () => number;
  getDuration: () => number;
  onChange: (annotations: VideoOverlayAnnotation[], effects: SavedVideoOverlayEffect[]) => void;
};
type Target = { id: string; name: string };
type Point = { x: number; y: number };
type Drag = { pointerId: number; origin: Point; original: VideoOverlayAnnotation; mode: 'move' | 'start' | 'end' | 'draw' };
const typeLabels: Record<VideoOverlayAnnotationType, string> = { text: '文字', arrow: '箭头', rectangle: '矩形', circle: '圆形' };
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
let effectCounter = 0;

function fullColor(color: string): string {
  const hex = color.slice(1);
  return `#${hex.length <= 4 ? Array.from(hex, c => c + c).join('') : hex}`;
}
function annotationOpacity(annotation: VideoOverlayAnnotation): number {
  const color = fullColor(annotation.color);
  return color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1;
}
function alphaColor(color: string, opacity: number): string {
  return `${fullColor(color).slice(0, 7)}${Math.round(clamp(opacity) * 255).toString(16).padStart(2, '0')}`;
}

/** Self-contained UI; draws only editor handles on a separate, non-export canvas. */
export class VideoOverlayPresentationEditor {
  private readonly options: VideoOverlayPresentationEditorOptions;
  private readonly events = new AbortController();
  private canvasEvents?: AbortController;
  private canvasObserver?: MutationObserver;
  private canvas?: HTMLCanvasElement;
  private originalCanvasStyle?: { pointerEvents: string; touchAction: string; cursor: string };
  private marks: VideoOverlayAnnotation[] = [];
  private cues: SavedVideoOverlayEffect[] = [];
  private targets: Target[] = [];
  private selectedMark = '';
  private selectedCue = '';
  private drag?: Drag;
  private disposed = false;

  constructor(options: VideoOverlayPresentationEditorOptions) {
    this.options = options;
    options.root.innerHTML = `
      <style>
        .cc-ar-editor{font-size:12px;display:grid;gap:8px;color:inherit}
        .cc-ar-editor details{border:1px solid #ffffff25;border-radius:6px;padding:8px}
        .cc-ar-editor summary{cursor:pointer;font-weight:600;margin-bottom:8px}
        .cc-ar-editor .cc-ar-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
        .cc-ar-editor label{display:grid;gap:4px;min-width:0}
        .cc-ar-editor input,.cc-ar-editor select,.cc-ar-editor textarea{box-sizing:border-box;width:100%;min-width:0;font:inherit}
        .cc-ar-editor textarea{resize:vertical;min-height:60px}
        .cc-ar-editor .cc-ar-span{grid-column:1/-1}
        .cc-ar-editor .cc-ar-buttons{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0}
        .cc-ar-editor .cc-ar-check{display:flex;align-items:center;gap:6px;margin:8px 0}
        .cc-ar-editor .cc-ar-check input{width:auto}
        .cc-ar-editor small{display:block;line-height:1.5;opacity:.75}
        .cc-ar-editor [data-editor-error]{color:#ffb3a7;min-height:16px;line-height:1.4}
        .cc-ar-editor button{font:inherit;cursor:pointer}
        .cc-ar-editor fieldset{border:0;padding:0;margin:0;min-width:0}
      </style>
      <div class="cc-ar-editor">
      <details open><summary>视频标注</summary>
        <small>按视频时间显示；标注和展示效果会一同保存并导出。</small>
        <div class="cc-ar-buttons">
          <button type="button" data-add-mark="text">＋文字</button><button type="button" data-add-mark="arrow">＋箭头</button>
          <button type="button" data-add-mark="rectangle">＋矩形</button><button type="button" data-add-mark="circle">＋圆形</button>
        </div>
        <label>选择标注<select data-mark-list aria-label="选择标注"></select></label>
        <div class="cc-ar-buttons"><button type="button" data-delete-mark>删除标注</button><button type="button" data-mark-now>起点设为当前时间</button></div>
        <fieldset data-mark-fields><div class="cc-ar-grid">
          <label class="cc-ar-span">标注文字<textarea data-ann-field="text" maxlength="2000" placeholder="请输入标注内容"></textarea></label>
          <label>颜色<input type="color" data-ann-field="color"></label>
          <label>不透明度<input type="range" min="0" max="1" step="0.01" data-ann-field="opacity" aria-label="标注不透明度"></label>
          <label>字号（1080p）<input type="number" min="8" max="160" step="1" data-ann-field="fontSize"></label>
          <label>线宽（1080p）<input type="number" min="0.5" max="40" step="0.5" data-ann-field="lineWidth"></label>
          <label>开始（秒）<input type="number" min="0" step="0.01" data-ann-field="start"></label>
          <label>结束（秒）<input type="number" min="0" step="0.01" data-ann-field="end"></label>
          <label class="cc-ar-span">展示效果<select data-ann-field="effect"><option value="none">直接出现 / 消失</option><option value="fade">淡入 / 淡出</option><option value="pop">弹出 / 淡出</option></select></label>
          <label>出现时长（秒）<input type="number" min="0" max="3600" step="0.05" data-ann-field="fadeIn"></label>
          <label>消失时长（秒）<input type="number" min="0" max="3600" step="0.05" data-ann-field="fadeOut"></label>
          <label>起点 X（0～1）<input type="number" min="0" max="1" step="0.01" data-ann-field="x"></label>
          <label>起点 Y（0～1）<input type="number" min="0" max="1" step="0.01" data-ann-field="y"></label>
          <label>终点 X（0～1）<input type="number" min="0" max="1" step="0.01" data-ann-field="x2"></label>
          <label>终点 Y（0～1）<input type="number" min="0" max="1" step="0.01" data-ann-field="y2"></label>
        </div></fieldset>
        <label class="cc-ar-check"><input type="checkbox" data-edit-canvas>在画面拖动标注</label>
        <small>选中后拖动已有标注可移动；拖动起点或终点可调整。空白处拖动重新绘制，文字可点击定位。圆形从圆心拖向圆周。</small>
      </details>
      <details open><summary>模型展示效果</summary>
        <small>可为全部工程对象或单独对象设定出现、消失和淡化；多个时段可重复添加。</small>
        <div class="cc-ar-buttons"><button type="button" data-add-cue>＋添加效果</button><button type="button" data-delete-cue>删除效果</button></div>
        <label>选择效果<select data-cue-list aria-label="选择模型效果"></select></label>
        <fieldset data-cue-fields><div class="cc-ar-grid" style="margin-top:8px">
          <label class="cc-ar-span">效果名称<input type="text" data-cue-field="name" maxlength="120"></label>
          <label class="cc-ar-span">作用对象<select data-cue-field="targetId"></select></label>
          <label>开始（秒）<input type="number" min="0" step="0.01" data-cue-field="start"></label>
          <label>结束（秒）<input type="number" min="0" step="0.01" data-cue-field="end"></label>
          <label>出现效果<select data-cue-field="inMode"><option value="instant">直接出现</option><option value="fade">淡入</option></select></label>
          <label>消失效果<select data-cue-field="outMode"><option value="instant">直接消失</option><option value="fade">淡出</option></select></label>
          <label>淡入时长（秒）<input type="number" min="0" step="0.05" data-cue-field="fadeIn"></label>
          <label>淡出时长（秒）<input type="number" min="0" step="0.05" data-cue-field="fadeOut"></label>
          <label class="cc-ar-span">不透明度<input type="range" min="0" max="1" step="0.01" data-cue-field="opacity" aria-label="模型不透明度"></label>
          <label class="cc-ar-check cc-ar-span"><input type="checkbox" data-cue-field="enabled">启用该展示效果</label>
        </div></fieldset>
      </details>
      <div data-editor-error role="status" aria-live="polite"></div>
      </div>`;
    options.root.addEventListener('click', this.handleClick, { signal: this.events.signal });
    options.root.addEventListener('input', this.handleInput, { signal: this.events.signal });
    options.root.addEventListener('change', this.handleChange, { signal: this.events.signal });
    this.render();
  }

  get annotations(): VideoOverlayAnnotation[] { return this.marks.map(value => ({ ...value })); }
  get effects(): SavedVideoOverlayEffect[] { return this.cues.map(value => ({ ...value })); }
  get selectedAnnotationId(): string | undefined { return this.selectedMark || undefined; }

  setValue(annotations: readonly VideoOverlayAnnotation[], effects: readonly SavedVideoOverlayEffect[]) {
    if (this.disposed) return;
    const checked = annotations.map(validateVideoOverlayAnnotation);
    if (new Set(checked.map(value => value.id)).size !== checked.length) throw new Error('标注 ID 重复');
    const cues = validateVideoOverlayEffects(effects);
    this.marks = checked; this.cues = cues;
    if (!this.marks.some(value => value.id === this.selectedMark)) this.selectedMark = this.marks[0]?.id ?? '';
    if (!this.cues.some(value => value.id === this.selectedCue)) this.selectedCue = this.cues[0]?.id ?? '';
    this.error(''); this.render();
  }

  setTargets(targets: readonly Target[]) {
    if (this.disposed) return;
    this.targets = targets.map(value => ({ id: value.id, name: value.name }));
    this.renderTargets();
  }

  mount(canvas: HTMLCanvasElement) {
    if (this.disposed) return;
    this.unmount(); this.canvas = canvas;
    this.originalCanvasStyle = { pointerEvents: canvas.style.pointerEvents, touchAction: canvas.style.touchAction, cursor: canvas.style.cursor };
    this.canvasEvents = new AbortController();
    const signal = this.canvasEvents.signal;
    canvas.addEventListener('pointerdown', this.pointerDown, { signal });
    canvas.addEventListener('pointermove', this.pointerMove, { signal });
    canvas.addEventListener('pointerup', this.pointerEnd, { signal });
    canvas.addEventListener('pointercancel', this.pointerEnd, { signal });
    canvas.addEventListener('lostpointercapture', this.pointerEnd, { signal });
    // The controller resizes this dedicated screen canvas while laying out video.
    // Attribute observation redraws an erased canvas without an animation loop.
    this.canvasObserver = new MutationObserver(() => this.drawSelectionHandles());
    this.canvasObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style'] });
    this.updateCanvasMode();
  }

  unmount() {
    this.canvasEvents?.abort(); this.canvasEvents = undefined;
    this.canvasObserver?.disconnect(); this.canvasObserver = undefined;
    this.cancelDrag();
    if (this.canvas) this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.canvas && this.originalCanvasStyle) Object.assign(this.canvas.style, this.originalCanvasStyle);
    this.canvas = undefined; this.originalCanvasStyle = undefined; this.drag = undefined;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true; this.unmount(); this.events.abort();
    this.options.root.replaceChildren(); this.marks = []; this.cues = []; this.targets = [];
  }

  private query<T extends Element = HTMLElement>(selector: string): T { return this.options.root.querySelector<T>(selector)!; }
  private mark() { return this.marks.find(value => value.id === this.selectedMark); }
  private cue() { return this.cues.find(value => value.id === this.selectedCue); }
  private error(message: string) { this.query('[data-editor-error]').textContent = message; }
  private emit() { this.options.onChange(this.annotations, this.effects); }
  private newId(prefix: string, existing: readonly { id: string }[]): string {
    let id: string = globalThis.crypto?.randomUUID?.() ?? `${prefix}-${++effectCounter}`;
    while (existing.some(value => value.id === id)) id = `${prefix}-${++effectCounter}`;
    return id;
  }
  private interval() {
    const duration = this.options.getDuration(), time = this.options.getTime();
    const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : undefined;
    const start = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, knownDuration ? Math.max(0, knownDuration - 0.05) : Number.MAX_SAFE_INTEGER));
    return { start, end: knownDuration ? Math.max(start + 0.001, Math.min(start + 5, knownDuration)) : start + 5 };
  }

  private optionsFor(select: HTMLSelectElement, values: Array<{ id: string; label: string }>, selected: string) {
    select.replaceChildren();
    if (!values.length) { const option = document.createElement('option'); option.textContent = '尚未添加'; option.value = ''; select.append(option); }
    for (const value of values) { const option = document.createElement('option'); option.value = value.id; option.textContent = value.label; select.append(option); }
    select.value = selected;
  }

  private renderLists() {
    this.optionsFor(this.query<HTMLSelectElement>('[data-mark-list]'), this.marks.map((value, index) => ({ id: value.id, label: `${index + 1}. ${typeLabels[value.type]} ${value.type === 'text' ? value.text.replace(/\s+/g, ' ').slice(0, 20) : ''}（${value.start.toFixed(2)}～${value.end.toFixed(2)}秒）` })), this.selectedMark);
    this.optionsFor(this.query<HTMLSelectElement>('[data-cue-list]'), this.cues.map(value => ({ id: value.id, label: `${value.enabled ? '' : '已停用 · '}${value.name}（${value.start.toFixed(2)}～${value.end.toFixed(2)}秒）` })), this.selectedCue);
    this.query<HTMLButtonElement>('[data-delete-mark]').disabled = !this.mark();
    this.query<HTMLButtonElement>('[data-mark-now]').disabled = !this.mark();
    this.query<HTMLButtonElement>('[data-delete-cue]').disabled = !this.cue();
  }

  private renderTargets() {
    const selected = this.cue()?.targetId ?? '*';
    const values = [{ id: '*', label: '全部已选工程对象' }, ...this.targets.map(value => ({ id: value.id, label: value.name }))];
    if (selected !== '*' && !values.some(value => value.id === selected)) values.push({ id: selected, label: `尚未加载的对象（${selected}）` });
    this.optionsFor(this.query<HTMLSelectElement>('[data-cue-field="targetId"]'), values, selected);
  }

  private renderFields() {
    const mark = this.mark(), cue = this.cue();
    this.query<HTMLFieldSetElement>('[data-mark-fields]').disabled = !mark;
    this.query<HTMLFieldSetElement>('[data-cue-fields]').disabled = !cue;
    for (const input of this.options.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-ann-field]')) {
      const key = input.dataset.annField!;
      const value = mark ? key === 'opacity' ? annotationOpacity(mark) : key === 'color' ? fullColor(mark.color).slice(0, 7) : mark[key as keyof VideoOverlayAnnotation] : '';
      input.value = String(value);
      if (key === 'text') input.disabled = !mark || mark.type !== 'text';
      if (key === 'fontSize') input.disabled = !mark || mark.type !== 'text';
      if (key === 'fadeIn' || key === 'fadeOut') input.disabled = !mark || mark.effect === 'none';
    }
    for (const input of this.options.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-cue-field]')) {
      const key = input.dataset.cueField as keyof SavedVideoOverlayEffect;
      if (key === 'targetId') continue;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!cue?.[key];
      else input.value = String(cue?.[key] ?? '');
      if (key === 'fadeIn') input.disabled = !cue || cue.inMode !== 'fade';
      if (key === 'fadeOut') input.disabled = !cue || cue.outMode !== 'fade';
    }
    this.renderTargets();
    this.drawSelectionHandles();
  }

  private render() { this.renderLists(); this.renderFields(); this.updateCanvasMode(); }
  private updateCanvasMode() {
    if (!this.canvas || !this.originalCanvasStyle) return;
    const enabled = !!this.mark() && this.query<HTMLInputElement>('[data-edit-canvas]').checked;
    Object.assign(this.canvas.style, enabled ? { pointerEvents: 'auto', touchAction: 'none', cursor: 'crosshair' } : this.originalCanvasStyle);
    if (!enabled) this.cancelDrag();
    this.drawSelectionHandles();
  }

  private cancelDrag() {
    const drag = this.drag; this.drag = undefined;
    if (this.canvas && drag) {
      try { this.canvas.releasePointerCapture(drag.pointerId); } catch { /* Already released. */ }
    }
  }

  /** Never draws a second copy of the actual annotation or consults mediaTime.
   * Editors must expose a selectable mark even on its fully transparent first
   * fade frame or outside its active interval. Nothing here reaches export.
   */
  private drawSelectionHandles() {
    const canvas = this.canvas;
    if (!canvas || this.disposed) return;
    const context = canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const mark = this.mark();
    if (!mark || !this.query<HTMLInputElement>('[data-edit-canvas]').checked) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return;
    // Work in CSS pixels so handles stay easy to grab at native 4K resolution.
    const width = rect.width, height = rect.height;
    const x = mark.x * width, y = mark.y * height, x2 = mark.x2 * width, y2 = mark.y2 * height;
    let left = Math.min(x, x2), top = Math.min(y, y2), right = Math.max(x, x2), bottom = Math.max(y, y2);
    context.save();
    try {
      context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
      if (mark.type === 'circle') {
        const radius = Math.hypot(x2 - x, y2 - y);
        left = x - radius; right = x + radius; top = y - radius; bottom = y + radius;
      } else if (mark.type === 'text') {
        const fontSize = mark.fontSize * height / 1080;
        context.font = `600 ${fontSize}px sans-serif`;
        const wrapWidth = Math.max(fontSize, (x2 > x ? x2 : width) - x);
        const lines = wrapVideoOverlayAnnotationText(context, mark.text, wrapWidth);
        left = x; top = y;
        right = x + Math.max(fontSize, ...lines.map(line => context.measureText(line).width));
        bottom = y + lines.length * fontSize * 1.3;
      }
      // Dark underlay keeps the white editor rectangle visible on bright video.
      context.lineJoin = 'round'; context.setLineDash([6, 4]);
      context.strokeStyle = '#102033'; context.lineWidth = 3;
      context.strokeRect(left - 5, top - 5, right - left + 10, bottom - top + 10);
      context.strokeStyle = '#ffffff'; context.lineWidth = 1;
      context.strokeRect(left - 5, top - 5, right - left + 10, bottom - top + 10);
      context.setLineDash([]);
      for (const point of [{ x, y }, { x: x2, y: y2 }]) {
        context.beginPath(); context.arc(point.x, point.y, 5, 0, Math.PI * 2);
        context.fillStyle = '#ffffff'; context.fill();
        context.strokeStyle = '#102033'; context.lineWidth = 2; context.stroke();
      }
    } finally { context.restore(); }
  }

  private readonly handleClick = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || !this.options.root.contains(button)) return;
    try {
      if (button.dataset.addMark) {
        const mark = createVideoOverlayAnnotation(button.dataset.addMark as VideoOverlayAnnotationType, { ...this.interval(), id: this.newId('annotation', this.marks) });
        this.marks.push(mark); this.selectedMark = mark.id;
      } else if (button.hasAttribute('data-delete-mark')) {
        this.marks = this.marks.filter(value => value.id !== this.selectedMark); this.selectedMark = this.marks[0]?.id ?? '';
      } else if (button.hasAttribute('data-mark-now')) {
        const mark = this.mark(); if (!mark) return;
        const interval = this.interval(); Object.assign(mark, interval);
      } else if (button.hasAttribute('data-add-cue')) {
        const cue = defaultVideoOverlayEffect({ ...this.interval(), id: this.newId('effect', this.cues), name: `模型展示 ${this.cues.length + 1}` });
        this.cues.push(cue); this.selectedCue = cue.id;
      } else if (button.hasAttribute('data-delete-cue')) {
        this.cues = this.cues.filter(value => value.id !== this.selectedCue); this.selectedCue = this.cues[0]?.id ?? '';
      } else return;
      this.error(''); this.render(); this.emit();
    } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
  };

  private readonly handleChange = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return;
    if (input.hasAttribute('data-mark-list')) { this.selectedMark = input.value; this.renderFields(); this.updateCanvasMode(); return; }
    if (input.hasAttribute('data-cue-list')) { this.selectedCue = input.value; this.renderFields(); return; }
    if (input.hasAttribute('data-edit-canvas')) { this.updateCanvasMode(); return; }
    if (input instanceof HTMLSelectElement || input.type === 'checkbox') this.changeField(input);
  };

  private readonly handleInput = (event: Event) => {
    const input = event.target;
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && input.type !== 'checkbox') this.changeField(input);
  };

  private changeField(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
    const annKey = input.dataset.annField, cueKey = input.dataset.cueField;
    if (!annKey && !cueKey) return;
    try {
      let value: string | number | boolean = input.value;
      if (input instanceof HTMLInputElement) {
        if (input.type === 'number' || input.type === 'range') {
          value = input.valueAsNumber;
          if (!Number.isFinite(value)) throw new Error('请输入有效数值');
          if (!input.validity.valid) throw new Error(`数值超出允许范围：${input.min || '不限'}～${input.max || '不限'}`);
        } else if (input.type === 'checkbox') value = input.checked;
      }
      if (annKey) {
        const mark = this.mark(); if (!mark) return;
        const patch = annKey === 'opacity' ? { color: alphaColor(mark.color, Number(value)) }
          : annKey === 'color' ? { color: alphaColor(String(value), annotationOpacity(mark)) } : { [annKey]: value };
        const next = validateVideoOverlayAnnotation({ ...mark, ...patch });
        this.marks[this.marks.indexOf(mark)] = next;
      } else if (cueKey) {
        const cue = this.cue(); if (!cue) return;
        this.cues[this.cues.indexOf(cue)] = validateVideoOverlayEffect({ ...cue, [cueKey]: value });
      }
      this.error(''); this.renderLists();
      if (input instanceof HTMLSelectElement) this.renderFields();
      this.drawSelectionHandles();
      this.emit();
    } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
  }

  private point(event: PointerEvent): Point | undefined {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  private readonly pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.query<HTMLInputElement>('[data-edit-canvas]').checked || !this.canvas) return;
    const mark = this.mark(), point = this.point(event); if (!mark || !point) return;
    const rect = this.canvas.getBoundingClientRect();
    const distance = (x: number, y: number) => Math.hypot((point.x - x) * rect.width, (point.y - y) * rect.height);
    let mode: Drag['mode'];
    if (distance(mark.x2, mark.y2) < 14) mode = 'end';
    else if (distance(mark.x, mark.y) < 14) mode = mark.type === 'text' ? 'move' : 'start';
    else {
      const radius = Math.hypot((mark.x2 - mark.x) * rect.width, (mark.y2 - mark.y) * rect.height);
      const within = mark.type === 'circle' ? distance(mark.x, mark.y) <= radius
        : point.x >= Math.min(mark.x, mark.x2) && point.x <= Math.max(mark.x, mark.x2)
          && point.y >= Math.min(mark.y, mark.type === 'text' ? mark.y + mark.fontSize / 1080 * 2 : mark.y2)
          && point.y <= Math.max(mark.y, mark.type === 'text' ? mark.y + mark.fontSize / 1080 * 2 : mark.y2);
      mode = within ? 'move' : 'draw';
    }
    this.drag = { pointerId: event.pointerId, original: { ...mark }, origin: point, mode };
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer or detached canvas. */ }
    event.preventDefault(); event.stopPropagation();
    if (mode === 'draw') this.pointerMove(event);
  };

  private readonly pointerMove = (event: PointerEvent) => {
    const drag = this.drag, point = this.point(event);
    if (!drag || drag.pointerId !== event.pointerId || !point) return;
    const original = drag.original; let patch: Partial<VideoOverlayAnnotation>;
    if (drag.mode === 'move' || drag.mode === 'draw' && original.type === 'text') {
      let dx = point.x - drag.origin.x, dy = point.y - drag.origin.y;
      if (drag.mode === 'draw') { dx = point.x - original.x; dy = point.y - original.y; }
      dx = clamp(dx, -Math.min(original.x, original.x2), 1 - Math.max(original.x, original.x2));
      dy = clamp(dy, -Math.min(original.y, original.y2), 1 - Math.max(original.y, original.y2));
      patch = { x: original.x + dx, y: original.y + dy, x2: original.x2 + dx, y2: original.y2 + dy };
    } else if (drag.mode === 'start') patch = { x: point.x, y: point.y };
    else if (drag.mode === 'end') patch = { x2: point.x, y2: point.y };
    else patch = { x: drag.origin.x, y: drag.origin.y, x2: point.x, y2: point.y };
    const index = this.marks.findIndex(value => value.id === original.id); if (index < 0) return;
    this.marks[index] = validateVideoOverlayAnnotation({ ...original, ...patch });
    this.renderFields(); this.emit(); event.preventDefault(); event.stopPropagation();
  };

  private readonly pointerEnd = (event: PointerEvent) => {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup') this.pointerMove(event);
    this.drag = undefined;
    try { this.canvas?.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    this.drawSelectionHandles();
    event.preventDefault(); event.stopPropagation();
  };
}
