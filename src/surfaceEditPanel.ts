import { SURFACE_EDIT_LIMITS, type SurfaceEditDraft, type SurfaceEditListItem, type SurfaceEditPlan, type SurfaceEditTexture } from './surfaceEditTypes';
import { validateSurfaceTextureDimensions, validateSurfaceTextureHeader } from './surfaceEditTextureInput';
import './surfaceEdit.css';

type ActionResult = void | Promise<unknown>;
export type SurfaceEditPanelOptions = {
  root: HTMLElement;
  getTargets: () => Array<{ id: string; name: string }>;
  canEdit: () => boolean;
  onDraw: (mode: 'polygon' | 'rectangle' | 'hole') => ActionResult;
  onClearBoundary: () => ActionResult;
  onGenerate: (draft: SurfaceEditDraft) => ActionResult;
  onCancel: () => ActionResult;
  onToggle: (id: string, enabled: boolean) => ActionResult;
  onDelete: (id: string) => ActionResult;
  onLocate: (id: string) => ActionResult;
  onEdit: (id: string) => ActionResult;
  onNew: () => ActionResult;
  onClose: () => ActionResult;
  onDraftChanged?: () => void;
};
type ImageSlot = 'ground' | 'wall';
const DEFAULT_TEXTURE: SurfaceEditTexture = { ground: 'soil', wall: 'soil', scaleMeters: 2 };

async function decodeSize(file: File): Promise<{ width: number; height: number }> {
  // ImageBitmap releases its decoded pixel allocation deterministically after inspection.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try { return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close(); }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('贴图读取失败。'));
    reader.onerror = () => reject(new Error('贴图读取失败。'));
    reader.onabort = () => reject(new Error('贴图读取已取消。'));
    reader.readAsDataURL(file);
  });
}

/** Presentational panel only. The host owns geometry, scene effects, access and persistence. */
export class SurfaceEditPanel {
  private readonly root: HTMLElement;
  private readonly events = new AbortController();
  private readonly imageSequence: Record<ImageSlot, number> = { ground: 0, wall: 0 };
  private readonly imagePending = new Set<ImageSlot>();
  private readonly imageErrors = new Map<ImageSlot, string>();
  private customImages: { ground?: string; wall?: string } = {};
  private disposed = false;
  private busy: string | null = null;
  private pointCount = 0;
  private editableOverride: boolean | undefined;

  constructor(private readonly options: SurfaceEditPanelOptions) {
    this.root = options.root;
    this.root.classList.add('surface-edit-panel');
    this.root.setAttribute('aria-label', '地表编辑');
    this.root.innerHTML = `
      <header class="surface-edit-header"><div><strong>地表编辑</strong><small>开挖与局部压平</small></div><button type="button" data-se-action="close" aria-label="关闭地表编辑">完成</button></header>
      <div class="surface-edit-body">
        <div class="surface-edit-context"><span data-se="mode-label">新建方案</span><button type="button" data-se-action="new" data-se-edit>新建</button></div>
        <label>方案名称<input data-se="name" maxlength="80" placeholder="例如：3号墩承台开挖" required /></label>
        <div class="surface-edit-grid">
          <label>处理方式<select data-se="kind"><option value="excavation">地表开挖</option><option value="flatten">局部压平</option></select></label>
          <label>摄影图层<select data-se="targetId" required></select></label>
        </div>
        <details open><summary>范围与高程</summary>
          <div class="surface-edit-buttons"><button type="button" data-se-action="polygon" data-se-edit>绘制多边形</button><button type="button" data-se-action="rectangle" data-se-edit>绘制矩形</button><button type="button" data-se-action="hole" data-se-edit>添加保留区</button><button type="button" data-se-action="clear" data-se-edit>清除范围</button></div>
          <p class="surface-edit-boundary" data-se="boundary" role="status">尚未绘制范围</p>
          <label><span data-se="height-label">坑底标高（米）</span><input data-se="targetHeight" type="number" step="0.1" value="0" required /></label>
          <p class="surface-edit-hint">采用场景高程基准（基准点椭球高）。地表起伏由边界高程表达。</p>
          <label>边界高程<select data-se="boundarySource"><option value="sampled">贴合摄影边界（有限采样）</option><option value="picked">使用已拾取边界高程</option><option value="manual">统一边界标高</option></select></label>
          <p class="surface-edit-hint">只处理边界；超限请分区或输入已知标高。</p>
          <label data-se="manual-height" hidden>边界标高（米）<input data-se="boundaryHeight" type="number" step="0.1" value="0" required /></label>
          <label class="surface-edit-check"><input data-se="clipTerrain" type="checkbox" checked /><span>同步开挖底层地形</span></label>
          <label class="surface-edit-check"><input data-se="bottomVisible" type="checkbox" checked /><span data-se="bottom-label">显示坑底面</span></label>
        </details>
        <details><summary>土体与地面材质</summary>
          <p class="surface-edit-hint">可直接使用内置材质，也可替换图片。</p>
          <div class="surface-edit-grid"><label>地面材质<select data-se="ground"><option value="soil">土面</option><option value="sand">砂土</option><option value="gravel">碎石</option></select></label><label>侧壁材质<select data-se="wall"><option value="soil">土壁</option><option value="sand">砂土</option></select></label></div>
          <label>纹理重复尺寸（米）<input data-se="scaleMeters" type="number" min="0.1" max="100" step="0.1" value="2" required /></label>
          <div class="surface-edit-image-field"><label>地面贴图<input data-se="groundImage" type="file" accept="image/png,image/jpeg,image/webp" /></label><div><span data-se="ground-image-status">使用内置材质</span><button type="button" data-se-action="clear-ground-image" data-se-edit>恢复内置</button></div></div>
          <div class="surface-edit-image-field"><label>侧壁贴图<input data-se="wallImage" type="file" accept="image/png,image/jpeg,image/webp" /></label><div><span data-se="wall-image-status">使用内置材质</span><button type="button" data-se-action="clear-wall-image" data-se-edit>恢复内置</button></div></div>
          <p class="surface-edit-hint">PNG / JPEG / WebP；单张不超过 2 MB，宽高均不超过 2048 像素。</p>
        </details>
        <p class="surface-edit-permission" data-se="permission" hidden>当前项目仅可查看，编辑操作不可用。</p>
        <div class="surface-edit-progress" data-se="progress" role="status" aria-live="polite" hidden></div>
        <div class="surface-edit-submit"><button type="button" data-se-action="generate" class="surface-edit-primary" data-se-edit>生成并保存</button><button type="button" data-se-action="cancel">取消操作</button></div>
        <p class="surface-edit-status" data-se="status" role="status" aria-live="polite" hidden></p>
        <details open class="surface-edit-plans"><summary>已保存方案 <span data-se="plan-count">0</span></summary><div data-se="plans"></div></details>
        <p class="surface-edit-hint">关闭效果恢复原摄影。视频 AR 中暂不显示地表编辑效果，退出后恢复。</p>
      </div>`;
    this.root.addEventListener('click', event => this.onClick(event), { signal: this.events.signal });
    this.root.addEventListener('change', event => this.onChange(event), { signal: this.events.signal });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); this.invoke(() => this.options.onCancel()); }
    }, { signal: this.events.signal });
    this.fill(); this.setPlans([]); this.setEditable();
  }

  private find<T extends HTMLElement = HTMLElement>(key: string): T {
    const found = this.root.querySelector<T>(`[data-se="${key}"]`);
    if (!found) throw new Error(`缺少地表编辑控件：${key}`);
    return found;
  }
  private editable(): boolean { return !this.disposed && (this.editableOverride ?? true) && this.options.canEdit(); }
  private invoke(action: () => ActionResult): void {
    if (this.disposed) return;
    try { Promise.resolve(action()).catch(error => { if (!this.disposed) this.setStatus(error instanceof Error ? error.message : String(error), true); }); }
    catch (error) { this.setStatus(error instanceof Error ? error.message : String(error), true); }
  }
  private onClick(event: MouseEvent): void {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-se-action]');
    if (!button || !this.root.contains(button) || button.disabled) return;
    const action = button.dataset.seAction, id = button.dataset.seId;
    if (!['close', 'cancel', 'locate'].includes(action ?? '') && (!this.editable() || this.busy || this.imagePending.size)) return;
    if (action === 'close') { this.invalidateImageLoads(); this.invoke(() => this.options.onClose()); }
    else if (action === 'cancel') { this.invalidateImageLoads(); this.invoke(() => this.options.onCancel()); }
    else if (action === 'generate') this.invoke(() => this.options.onGenerate(this.getDraft()));
    else if (action === 'polygon' || action === 'rectangle' || action === 'hole') this.invoke(() => this.options.onDraw(action));
    else if (action === 'clear') this.invoke(() => this.options.onClearBoundary());
    else if (action === 'new') this.invoke(() => this.options.onNew());
    else if (action === 'clear-ground-image' || action === 'clear-wall-image') this.clearImage(action === 'clear-ground-image' ? 'ground' : 'wall');
    else if (id && action === 'edit') this.invoke(() => this.options.onEdit(id));
    else if (id && action === 'delete') this.invoke(() => this.options.onDelete(id));
    else if (id && action === 'locate') this.invoke(() => this.options.onLocate(id));
  }
  private onChange(event: Event): void {
    const field = event.target as HTMLInputElement | HTMLSelectElement;
    if (field.disabled || !this.editable() || this.busy) return;
    if (field.dataset.seToggle) {
      const id = field.dataset.seToggle, checked = (field as HTMLInputElement).checked;
      // The host returns the authoritative enabled state through setPlans.
      (field as HTMLInputElement).checked = !checked;
      this.invoke(() => this.options.onToggle(id, checked)); return;
    }
    if (field.dataset.se === 'groundImage' || field.dataset.se === 'wallImage') {
      const slot = field.dataset.se === 'groundImage' ? 'ground' : 'wall';
      const file = (field as HTMLInputElement).files?.[0];
      if (file) void this.loadImage(slot, file);
      return;
    }
    if (!field.dataset.se) return;
    this.refreshConditionalFields();
    this.invoke(() => this.options.onDraftChanged?.());
  }

  refreshTargets(): void {
    if (this.disposed) return;
    const field = this.find<HTMLSelectElement>('targetId'), selected = field.value;
    const targets = this.options.getTargets();
    field.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = targets.length ? '请选择摄影图层' : '请先加载倾斜摄影'; field.append(placeholder);
    for (const target of targets) { const option = document.createElement('option'); option.value = target.id; option.textContent = target.name; field.append(option); }
    if (targets.some(target => target.id === selected)) field.value = selected;
    else if (selected) { const missing = document.createElement('option'); missing.value = selected; missing.textContent = '原摄影图层暂不可用'; missing.disabled = true; field.append(missing); field.value = selected; }
    else if (targets.length === 1) field.value = targets[0].id;
  }

  getSelectedTargetId(): string { return this.find<HTMLSelectElement>('targetId').value; }
  getBoundarySource(): SurfaceEditDraft['boundarySource'] {
    const selected = this.find<HTMLSelectElement>('boundarySource').value;
    return selected === 'manual' ? 'manual' : selected === 'picked' ? 'picked' : 'sampled';
  }

  getDraft(): SurfaceEditDraft {
    if (!this.editable()) throw new Error('当前项目没有地表编辑权限。');
    if (this.imagePending.size) throw new Error('贴图仍在检查，请稍候。');
    if (this.imageErrors.size) throw new Error([...this.imageErrors.values()][0]);
    const number = (key: string) => {
      const field = this.find<HTMLInputElement>(key);
      const value = Number(field.value);
      if (!field.value.trim() || !Number.isFinite(value) || !field.checkValidity()) { field.focus(); throw new Error('请输入控件范围内的有效标高和纹理尺寸。'); }
      return value;
    };
    const name = this.find<HTMLInputElement>('name').value.trim(), targetId = this.find<HTMLSelectElement>('targetId').value;
    if (!name) { this.find('name').focus(); throw new Error('请填写方案名称。'); }
    if (!this.options.getTargets().some(target => target.id === targetId)) throw new Error('请选择当前已加载的倾斜摄影图层。');
    const boundarySource = this.getBoundarySource();
    return {
      name, targetId, kind: this.find<HTMLSelectElement>('kind').value === 'flatten' ? 'flatten' : 'excavation',
      targetHeight: number('targetHeight'), boundarySource,
      boundaryHeight: boundarySource === 'manual' ? number('boundaryHeight') : 0,
      clipTerrain: this.find<HTMLInputElement>('clipTerrain').checked, bottomVisible: this.find<HTMLInputElement>('bottomVisible').checked,
      texture: { ground: this.find<HTMLSelectElement>('ground').value as SurfaceEditTexture['ground'], wall: this.find<HTMLSelectElement>('wall').value as SurfaceEditTexture['wall'],
        scaleMeters: number('scaleMeters'), groundImage: this.customImages.ground, wallImage: this.customImages.wall },
    };
  }

  fill(plan?: SurfaceEditPlan): void {
    if (this.disposed) return;
    this.invalidateImageLoads(); this.imageErrors.clear();
    this.find('mode-label').textContent = plan ? `编辑：${plan.name}` : '新建方案';
    this.find<HTMLInputElement>('name').value = plan?.name ?? '';
    this.find<HTMLSelectElement>('kind').value = plan?.kind ?? 'excavation';
    this.refreshTargets();
    if (plan) {
      const field = this.find<HTMLSelectElement>('targetId');
      if (!Array.from(field.options).some(option => option.value === plan.targetId)) { const option = document.createElement('option'); option.value = plan.targetId; option.textContent = '原摄影图层暂不可用'; option.disabled = true; field.append(option); }
      field.value = plan.targetId;
    }
    this.find<HTMLInputElement>('targetHeight').value = String(plan?.targetHeight ?? 0);
    this.find<HTMLSelectElement>('boundarySource').value = plan ? 'picked' : 'sampled';
    this.find<HTMLInputElement>('boundaryHeight').value = String(plan?.boundary[0]?.height ?? 0);
    this.find<HTMLInputElement>('clipTerrain').checked = plan?.clipTerrain ?? true;
    this.find<HTMLInputElement>('bottomVisible').checked = plan?.bottomVisible ?? true;
    const texture = plan?.texture ?? DEFAULT_TEXTURE;
    this.find<HTMLSelectElement>('ground').value = texture.ground;
    this.find<HTMLSelectElement>('wall').value = texture.wall;
    this.find<HTMLInputElement>('scaleMeters').value = String(texture.scaleMeters);
    this.customImages = { ground: texture.groundImage, wall: texture.wallImage };
    for (const slot of ['ground', 'wall'] as const) {
      this.find<HTMLInputElement>(`${slot}Image`).value = '';
      this.find(`${slot}-image-status`).textContent = this.customImages[slot] ? '使用已保存贴图' : '使用内置材质';
    }
    this.setBoundary(plan ? plan.boundary.length + plan.holes.reduce((sum, ring) => sum + ring.length, 0) : 0, plan?.holes.length ?? 0);
    this.refreshConditionalFields(); this.setStatus(''); this.setEditable();
  }

  setBoundary(pointCount: number, holeCount: number, message?: string): void {
    if (this.disposed) return;
    this.pointCount = pointCount;
    const counts = pointCount ? `边界共 ${pointCount} / ${SURFACE_EDIT_LIMITS.boundaryPoints} 点 · ${holeCount} 个保留区` : `尚未绘制范围 · 边界上限 ${SURFACE_EDIT_LIMITS.boundaryPoints} 点`;
    this.find('boundary').textContent = message ? `${message} ${counts}` : counts;
    this.setEditable();
  }
  setPlans(plans: readonly SurfaceEditListItem[]): void {
    if (this.disposed) return;
    this.find('plan-count').textContent = String(plans.length);
    const host = this.find('plans'); host.replaceChildren();
    if (!plans.length) { const empty = document.createElement('p'); empty.className = 'surface-edit-hint'; empty.textContent = '尚无保存的开挖或压平方案。'; host.append(empty); }
    for (const plan of plans) {
      const card = document.createElement('article'); card.className = 'surface-edit-plan';
      const heading = document.createElement('div'); heading.className = 'surface-edit-plan-heading';
      const label = document.createElement('label'); label.className = 'surface-edit-check';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = plan.enabled; checkbox.dataset.seToggle = plan.id; checkbox.setAttribute('aria-label', `${plan.name}效果`);
      const name = document.createElement('strong'); name.textContent = plan.name; label.append(checkbox, name);
      const kind = document.createElement('span'); kind.textContent = plan.kind === 'excavation' ? '开挖' : '压平'; heading.append(label, kind);
      const status = document.createElement('p'); status.className = 'surface-edit-plan-status'; status.textContent = plan.status;
      const actions = document.createElement('div'); actions.className = 'surface-edit-buttons';
      for (const [action, text] of [['locate', '定位'], ['edit', '编辑'], ['delete', '删除']]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.seAction = action; button.dataset.seId = plan.id; button.textContent = text;
        if (action !== 'locate') button.dataset.seEdit = '';
        if (action === 'delete') button.className = 'surface-edit-danger';
        actions.append(button);
      }
      card.append(heading, status, actions); host.append(card);
    }
    this.setEditable();
  }
  setBusy(message: string | null): void {
    if (this.disposed) return;
    this.busy = message;
    const progress = this.find('progress'); progress.textContent = message ?? ''; progress.hidden = !message;
    this.root.setAttribute('aria-busy', String(Boolean(message))); this.setEditable();
  }
  setStatus(message: string, isError = false): void {
    if (this.disposed) return;
    const status = this.find('status'); status.textContent = message; status.hidden = !message; status.classList.toggle('surface-edit-error', isError);
  }
  setEditable(editable?: boolean): void {
    if (this.disposed) return;
    if (editable !== undefined) this.editableOverride = editable;
    const canEdit = this.editable(), disabled = !canEdit || Boolean(this.busy) || this.imagePending.size > 0;
    this.find('permission').hidden = canEdit;
    for (const field of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) field.disabled = disabled;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-se-edit]')) button.disabled = disabled;
    const generate = this.root.querySelector<HTMLButtonElement>('[data-se-action="generate"]')!;
    generate.disabled ||= this.pointCount < 3 || this.pointCount > SURFACE_EDIT_LIMITS.boundaryPoints || this.imageErrors.size > 0;
    const hole = this.root.querySelector<HTMLButtonElement>('[data-se-action="hole"]')!; hole.disabled ||= this.pointCount < 3;
    this.find<HTMLInputElement>('boundaryHeight').disabled ||= this.find<HTMLSelectElement>('boundarySource').value !== 'manual';
  }

  private refreshConditionalFields(): void {
    const excavation = this.find<HTMLSelectElement>('kind').value === 'excavation';
    this.find('height-label').textContent = excavation ? '坑底标高（米）' : '压平标高（米）';
    this.find('bottom-label').textContent = excavation ? '显示坑底面' : '显示平整面';
    this.find('manual-height').hidden = this.find<HTMLSelectElement>('boundarySource').value !== 'manual';
    this.setEditable();
  }
  private clearImage(slot: ImageSlot): void {
    this.imageSequence[slot]++; this.imagePending.delete(slot); this.imageErrors.delete(slot);
    delete this.customImages[slot];
    this.find<HTMLInputElement>(`${slot}Image`).value = '';
    this.find(`${slot}-image-status`).textContent = '使用内置材质';
    this.setEditable(); this.invoke(() => this.options.onDraftChanged?.());
  }
  private invalidateImageLoads(): void {
    for (const slot of ['ground', 'wall'] as const) {
      this.imageSequence[slot]++;
      if (this.imagePending.has(slot)) this.find(`${slot}-image-status`).textContent = this.customImages[slot] ? '保留原贴图' : '使用内置材质';
    }
    this.imagePending.clear();
    this.setEditable();
  }
  private async loadImage(slot: ImageSlot, file: File): Promise<void> {
    const token = ++this.imageSequence[slot];
    this.imagePending.add(slot); this.imageErrors.delete(slot);
    this.find(`${slot}-image-status`).textContent = '正在检查图片…'; this.setEditable();
    const current = () => !this.disposed && token === this.imageSequence[slot] && this.editable();
    try {
      if (file.size > SURFACE_EDIT_LIMITS.imageBytes) throw new Error('贴图超过 2 MB，请压缩后重新选择。');
      validateSurfaceTextureHeader(file.type, new Uint8Array(await file.arrayBuffer()), file.size);
      if (!current()) return;
      const size = await decodeSize(file);
      validateSurfaceTextureDimensions(size);
      if (!current()) return;
      const url = await readDataUrl(file);
      if (!current()) return;
      this.customImages[slot] = url;
      this.find(`${slot}-image-status`).textContent = `${file.name} · ${size.width} × ${size.height}`;
      this.invoke(() => this.options.onDraftChanged?.());
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : '贴图读取失败，请检查图片。';
      this.imageErrors.set(slot, message); this.find(`${slot}-image-status`).textContent = message; this.setStatus(message, true);
    } finally {
      if (!this.disposed && token === this.imageSequence[slot]) { this.imagePending.delete(slot); this.setEditable(); }
    }
  }
  destroy(): void {
    if (this.disposed) return;
    this.invalidateImageLoads(); this.disposed = true; this.events.abort();
    this.customImages = {}; this.imageErrors.clear(); this.root.replaceChildren(); this.root.classList.remove('surface-edit-panel');
  }
}
