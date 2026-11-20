import {
  CustomShader, CustomShaderMode, CustomShaderTranslucencyMode, LightingModel, Matrix4, Model,
  ScreenSpaceEventHandler, ScreenSpaceEventType, ShadowMode, type Cartesian2, type Viewer,
} from 'cesium';
import {
  findStructureBinding, parseStructureCatalog, parseStructureConfig, pickedEngineeringModelNodeNames,
  STRUCTURE_LIBRARY_URL, structureAssetUrl, structureProjectionFrame, structureProjectionMatrix,
  validateStructureGlb, type EngineeringModelPick, type StructureBinding, type StructureHologramConfig,
} from './structureHologramConfig';
import './structureHolograms.css';

type EngineeringModel = { id: string; model: Model };
type Hooks = {
  getModels: () => EngineeringModel[];
  getContextKey: () => string;
  acquirePicking: () => () => void;
  notify: (message: string, error?: boolean) => void;
};
type Projection = {
  target: EngineeringModel;
  binding: StructureBinding;
  controller: AbortController;
  config?: StructureHologramConfig;
  frame?: Matrix4;
  shader?: CustomShader;
  model?: Model;
};
type Session = {
  context: string;
  controller: AbortController;
  bindings?: StructureBinding[];
  handler?: ScreenSpaceEventHandler;
  releasePick?: () => void;
  projection?: Projection;
};
type PanelState = 'loading-catalog' | 'picking' | 'loading-model' | 'ready' | 'error';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_GLB_BYTES = 64 * 1024 * 1024;

const SCAN_SHADER = `
  void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    float h = fsInput.attributes.positionMC.y;
    float scan = 1.0 - smoothstep(0.04, 0.22, abs(fract(h * 0.6 - float(czm_frameNumber) * 0.011) - 0.5));
    vec3 cyan = vec3(0.045, 0.66, 0.9);
    material.diffuse = cyan * (0.64 + 0.36 * scan);
    material.emissive = cyan * (0.12 + 0.42 * scan);
    material.alpha = 0.40 + 0.30 * scan;
  }
`;

async function readLocalAsset(url: string, signal: AbortSignal, limit: number, contentTypes: readonly string[], label: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const advertisedBytes = Number(response.headers.get('content-length'));
  if (!response.ok || !contentType || !contentTypes.includes(contentType) || advertisedBytes > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new Error('当前账号无法读取本机结构资源。');
    if (advertisedBytes > limit) throw new Error(`${label}超过可加载大小。`);
    throw new Error(`${label}不可用，请检查本机结构资源目录。`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { void reader.cancel().catch(() => {}); throw new Error(`${label}超过可加载大小。`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function readJson(url: string, signal: AbortSignal, label: string): Promise<unknown> {
  const bytes = await readLocalAsset(url, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), MAX_JSON_BYTES, ['application/json'], label);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`${label}无法解析。`); }
}

function waitForReady(model: Model, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (model.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const aborted = () => fail(signal.reason);
    const removeReady = model.readyEvent.addEventListener(ready);
    const removeError = model.errorEvent.addEventListener(fail);
    const cleanup = () => { removeReady(); removeError(); signal.removeEventListener('abort', aborted); };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** One on-demand projection. The original model, stored project, camera and
 * preview webpage remain owned by their existing systems. */
export class StructureHolograms {
  private readonly root = document.createElement('section');
  private readonly events = new AbortController();
  private session?: Session;
  get isPicking(): boolean { return !!this.session?.releasePick; }

  constructor(private readonly viewer: Viewer, host: HTMLElement, private readonly hooks: Hooks) {
    this.root.id = 'structureHologramPanel';
    this.root.className = 'structure-hologram';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', '构件全息投影');
    this.root.innerHTML = `
      <header><strong>构件全息投影</strong><button type="button" data-hologram-action="close">关闭</button></header>
      <p role="status" aria-live="polite" data-hologram-field="status"></p>
      <div class="structure-hologram-model" data-hologram-field="summary" hidden>
        <strong data-hologram-field="title"></strong><small data-hologram-field="model-id"></small>
      </div>
      <div class="structure-hologram-controls" data-hologram-field="controls" hidden>
        <label>旋转 <output data-hologram-field="rotation-value">0°</output><input data-hologram-field="rotation" type="range" min="-180" max="180" step="1" value="0"></label>
        <label>缩放 <output data-hologram-field="scale-value">1.00×</output><input data-hologram-field="scale" type="range" min="0.25" max="4" step="0.05" value="1"></label>
      </div>
      <footer><button type="button" data-hologram-action="pick">选择构件</button>
        <a data-hologram-field="preview" target="_blank" rel="noopener noreferrer" hidden>打开结构交互网页</a></footer>`;
    host.append(this.root);
    this.root.addEventListener('click', event => {
      const action = (event.target as Element).closest<HTMLElement>('[data-hologram-action]')?.dataset.hologramAction;
      if (action === 'close') this.close();
      else if (action === 'pick' && this.session) {
        if (this.session.bindings) this.beginPicking(this.session);
        else this.open();
      }
    }, { signal: this.events.signal });
    this.root.addEventListener('input', () => this.updateProjectionPose(), { signal: this.events.signal });
  }

  open(): void {
    if (this.events.signal.aborted || this.viewer.isDestroyed()) return;
    this.close();
    const session: Session = { context: this.hooks.getContextKey(), controller: new AbortController() };
    this.session = session;
    this.root.hidden = false;
    this.setStatus('loading-catalog', '正在读取本机结构资源目录…');
    window.addEventListener('keydown', this.keydown, { capture: true, signal: session.controller.signal });
    void this.loadCatalog(session);
  }

  close(): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    session.controller.abort();
    this.endPicking(session);
    if (session.handler && !session.handler.isDestroyed()) session.handler.destroy();
    this.releaseProjection(session);
    this.root.hidden = true;
  }

  refreshValidity(): void {
    if (this.session) this.current(this.session);
  }

  dispose(): void {
    this.close();
    this.events.abort();
    this.root.remove();
  }

  private current(session: Session): boolean {
    if (session !== this.session) return false;
    const projection = session.projection;
    const source = projection?.target;
    if (this.viewer.isDestroyed() || this.hooks.getContextKey() !== session.context
      || (source && (source.model.isDestroyed() || !source.model.show
        || !this.hooks.getModels().some(item => item.id === source.id && item.model === source.model)))) {
      this.close(); return false;
    }
    if (projection?.frame && projection.config?.anchor.kind === 'model-local') {
      try {
        const frame = structureProjectionFrame(projection.config.anchor, projection.target.model);
        if (!Matrix4.equals(projection.frame, frame)) {
          projection.frame = frame;
          if (projection.model?.ready) this.applyPose(projection);
        }
      } catch { this.close(); return false; }
    }
    return session === this.session;
  }

  private keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing || !this.session) return;
    event.preventDefault(); event.stopImmediatePropagation(); this.close();
  };

  private field<T extends HTMLElement = HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-hologram-field="${name}"]`)!;
  }

  private setStatus(state: PanelState, message: string): void {
    this.root.dataset.state = state;
    this.field('status').textContent = message;
    const pick = this.root.querySelector<HTMLButtonElement>('[data-hologram-action="pick"]')!;
    pick.disabled = state === 'loading-catalog' || this.isPicking;
    pick.textContent = this.session?.bindings ? '重新选择构件' : '重新读取目录';
  }

  private async loadCatalog(session: Session): Promise<void> {
    try {
      const bindings = parseStructureCatalog(await readJson(`${STRUCTURE_LIBRARY_URL}/catalog.json`, session.controller.signal, '结构资源目录'));
      if (!this.current(session)) return;
      if (!bindings.length) throw new Error('结构资源目录还没有配置工程构件绑定。');
      session.bindings = bindings;
      this.beginPicking(session);
    } catch (error) {
      if (this.current(session)) this.setStatus('error', errorText(error));
    }
  }

  private beginPicking(session: Session): void {
    if (!this.current(session) || session.releasePick || !session.bindings) return;
    if (!this.hooks.getModels().some(item => !item.model.isDestroyed() && item.model.show)) {
      this.setStatus('error', '请先在场景中显示已保存的工程 GLB 模型。'); return;
    }
    try {
      session.releasePick = this.hooks.acquirePicking();
      this.releaseProjection(session);
      if (!session.handler) {
        session.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
        session.handler.setInputAction((event: { position: Cartesian2 }) => this.onPick(session, event.position), ScreenSpaceEventType.LEFT_CLICK);
      }
      this.setStatus('picking', '请在三维场景中点击已关联的工程构件。');
    } catch (error) {
      this.endPicking(session);
      this.setStatus('error', errorText(error));
    }
  }

  private endPicking(session: Session): void {
    const release = session.releasePick;
    session.releasePick = undefined;
    try { release?.(); }
    catch (error) { this.hooks.notify(errorText(error), true); }
  }

  private onPick(session: Session, position: Cartesian2): void {
    if (!this.current(session) || !session.bindings) return;
    const projection = session.projection;
    if (!session.releasePick && !projection?.model?.ready) return;
    let picked: EngineeringModelPick | undefined;
    try { picked = this.viewer.scene.pick(position, 1, 1); }
    catch { return; }
    if (!session.releasePick) {
      if (projection?.model && picked?.primitive === projection.model) {
        window.open(structureAssetUrl(projection.binding, 'preview'), '_blank', 'noopener,noreferrer');
      }
      return;
    }
    const target = picked && this.hooks.getModels().find(item => item.model === picked.primitive && !item.model.isDestroyed() && item.model.show);
    if (!picked || !target) { this.setStatus('picking', '请点击场景中的工程 GLB 模型。'); return; }
    const binding = findStructureBinding(session.bindings, target.id, pickedEngineeringModelNodeNames(picked, target.model));
    if (!binding) { this.setStatus('picking', '所选工程构件尚未关联本机结构资源，请选择已关联的构件。'); return; }
    this.endPicking(session);
    const next: Projection = { target, binding, controller: new AbortController() };
    session.projection = next;
    this.root.dataset.modelId = target.id;
    this.root.dataset.structureId = binding.structureId;
    if (binding.nodeName) this.root.dataset.nodeName = binding.nodeName;
    this.setStatus('loading-model', '正在加载构件的全息模型…');
    void this.loadProjection(session, next);
  }

  private async loadProjection(session: Session, projection: Projection): Promise<void> {
    const signal = projection.controller.signal;
    let objectUrl: string | undefined;
    const revokeUrl = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    };
    try {
      const config = parseStructureConfig(await readJson(structureAssetUrl(projection.binding, 'structure.json'), signal, '构件结构配置'));
      if (signal.aborted || !this.current(session)) return;
      projection.config = config;
      projection.frame = structureProjectionFrame(config.anchor, projection.target.model);
      this.field('title').textContent = config.title;
      this.field('model-id').textContent = `工程模型 ID · ${projection.target.id}`;
      this.field('summary').hidden = false;
      const preview = this.field<HTMLAnchorElement>('preview');
      preview.setAttribute('href', structureAssetUrl(projection.binding, 'preview'));
      preview.hidden = false;
      const bytes = await readLocalAsset(structureAssetUrl(projection.binding, 'hologram.glb'),
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]), MAX_GLB_BYTES, ['model/gltf-binary', 'application/octet-stream'], '投影 GLB');
      if (signal.aborted || !this.current(session)) return;
      validateStructureGlb(bytes);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      signal.addEventListener('abort', revokeUrl, { once: true });
      const model = await Model.fromGltfAsync({
        url: objectUrl, modelMatrix: structureProjectionMatrix(projection.frame, config.headingDegrees), scale: config.scale,
        minimumPixelSize: 0, shadows: ShadowMode.DISABLED, incrementallyLoadTextures: false,
        enableVerticalExaggeration: false, id: { structureHologramId: projection.binding.structureId },
      });
      if (signal.aborted || !this.current(session)) { if (!model.isDestroyed()) model.destroy(); return; }
      projection.model = model;
      projection.shader = new CustomShader({ mode: CustomShaderMode.REPLACE_MATERIAL, lightingModel: LightingModel.UNLIT,
        translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT, fragmentShaderText: SCAN_SHADER });
      model.customShader = projection.shader;
      this.applyPose(projection);
      this.viewer.scene.primitives.add(model);
      this.viewer.scene.requestRender();
      await waitForReady(model, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      if (signal.aborted || !this.current(session)) return;
      this.field('controls').hidden = false;
      this.setStatus('ready', '拖动滑块调整投影，点击投影或按钮打开结构交互网页。');
    } catch (error) {
      if (signal.aborted || !this.current(session)) return;
      this.releaseModel(projection);
      this.setStatus('error', errorText(error));
    } finally {
      signal.removeEventListener('abort', revokeUrl);
      revokeUrl();
    }
  }

  private updateProjectionPose(): void {
    const session = this.session;
    if (!session || !this.current(session) || !session.projection?.model?.ready) return;
    this.applyPose(session.projection);
  }

  private applyPose(projection: Projection): void {
    if (!projection.config || !projection.frame || !projection.model) return;
    const rotation = this.field<HTMLInputElement>('rotation').valueAsNumber;
    const scale = this.field<HTMLInputElement>('scale').valueAsNumber;
    projection.model.modelMatrix = structureProjectionMatrix(projection.frame, projection.config.headingDegrees + rotation);
    projection.model.scale = projection.config.scale * scale;
    this.root.dataset.rotation = String(rotation);
    this.root.dataset.scale = String(scale);
    this.field('rotation-value').textContent = `${rotation}°`;
    this.field('scale-value').textContent = `${scale.toFixed(2)}×`;
    this.viewer.scene.requestRender();
  }

  private releaseModel(projection: Projection): void {
    const model = projection.model;
    projection.model = undefined;
    if (model && !model.isDestroyed()) {
      if (!this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(model);
      if (!model.isDestroyed()) model.destroy();
    }
    if (projection.shader && !projection.shader.isDestroyed()) projection.shader.destroy();
    projection.shader = undefined;
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  private releaseProjection(session: Session): void {
    if (session.projection) {
      session.projection.controller.abort();
      this.releaseModel(session.projection);
      session.projection = undefined;
    }
    for (const key of ['modelId', 'structureId', 'nodeName', 'rotation', 'scale']) delete this.root.dataset[key];
    this.field<HTMLInputElement>('rotation').value = '0';
    this.field<HTMLInputElement>('scale').value = '1';
    this.field('controls').hidden = true;
    this.field('summary').hidden = true;
    const preview = this.field<HTMLAnchorElement>('preview');
    preview.hidden = true; preview.removeAttribute('href');
  }
}
