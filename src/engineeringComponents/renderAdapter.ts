import { BoundingSphere, PostProcessStage, SceneMode, type Model, type Viewer } from 'cesium';

export type EngineeringNodeBinding = { componentId: string; nodeIndices: readonly number[] };
export type EngineeringRenderState = { visible: boolean; occlusion: boolean };
export type EngineeringDrawCommand = {
  owner: unknown; shaderProgram: unknown; renderState: unknown; primitiveType: number;
  modelMatrix: unknown; boundingVolume?: BoundingSphere; uniformMap?: Record<string, () => unknown>;
  [key: string]: unknown;
};
type RuntimeNode = {
  _id: number; show: boolean; children: number[];
  userAnimated: boolean; morphWeights: number[]; runtimeSkin?: unknown;
  instancingTransformsBuffer?: unknown;
  runtimePrimitives: { drawCommand?: { command: EngineeringDrawCommand } }[];
};
type PickId = { color: unknown; object: { primitive?: unknown; detail?: { model?: unknown; node?: RuntimeNode } } };
type RuntimeModel = Model & {
  _sceneGraph?: { _runtimeNodes: (RuntimeNode | undefined)[] };
  _pickIds?: PickId[];
  _texturesLoaded?: boolean;
  _featureTables?: unknown[];
  _loader?: { texturesLoaded: boolean; incrementallyLoadTextures: boolean };
};

/** The only node adapter for Cesium 1.144 / engine 26.2. No GLB data, transforms,
 * materials or original DrawCommands are changed. Hidden nodes retain their
 * native runtime geometry, used exclusively by the separate occlusion buffer. */
export class EngineeringRenderAdapter {
  readonly model: Model;
  private readonly runtime: RuntimeModel;
  private readonly components = new Map<string, { nodes: RuntimeNode[]; state: EngineeringRenderState }>();
  private readonly nodeComponents = new Map<number, string>();
  private readonly originalShows = new Map<RuntimeNode, boolean>();
  private readonly highlight: PostProcessStage;
  private selected = new Set<string>();
  private lastPickIds?: PickId[];
  private lastPickCount = -1;
  private active = true;
  private suspensionCount = 0;
  private disposed = false;
  private readonly stopWatching: () => void;

  constructor(private readonly viewer: Viewer, model: Model, bindings: readonly EngineeringNodeBinding[]) {
    this.model = model; this.runtime = model as RuntimeModel;
    if (!model.ready || !this.runtime._sceneGraph?._runtimeNodes || !Array.isArray(this.runtime._pickIds)) {
      throw new Error('工程构件渲染需等待模型就绪，且仅支持已锁定的 Cesium 1.144 / engine 26.2 节点接口。');
    }
    const allNodes = this.runtime._sceneGraph._runtimeNodes;
    const collect = (index: number, result: Set<RuntimeNode>, ancestors: Set<number>) => {
      if (!Number.isSafeInteger(index) || index < 0 || ancestors.has(index)) throw new Error(`工程构件节点索引无效或循环：${index}`);
      const node = allNodes[index];
      if (!node || node._id !== index || !Array.isArray(node.children) || !Array.isArray(node.runtimePrimitives)) {
        throw new Error(`工程构件节点 ${index} 不存在或 Cesium 节点接口已改变。`);
      }
      if (result.has(node)) return;
      result.add(node); const path = new Set(ancestors); path.add(index);
      for (const child of node.children) collect(child, result, path);
    };
    // Validate every binding before touching any visibility or adding a stage.
    for (const binding of bindings) {
      if (!binding.componentId || this.components.has(binding.componentId) || !binding.nodeIndices.length) throw new Error('构件映射包含重复编号或空节点列表。');
      const nodes = new Set<RuntimeNode>();
      for (const index of binding.nodeIndices) collect(index, nodes, new Set());
      for (const node of nodes) {
        const previous = this.nodeComponents.get(node._id);
        if (previous) throw new Error(`GLB 节点 ${node._id} 同时属于 ${previous} 和 ${binding.componentId}。`);
        this.nodeComponents.set(node._id, binding.componentId);
        this.originalShows.set(node, node.show);
      }
      this.components.set(binding.componentId, { nodes: [...nodes], state: { visible: true, occlusion: true } });
    }
    this.highlight = new PostProcessStage({ name: `engineering-component-selection-${crypto.randomUUID()}`,
      fragmentShader: `uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
        void main() { vec4 c = texture(colorTexture, v_textureCoordinates);
          if (czm_selected()) c.rgb = mix(c.rgb, vec3(0.05, 0.85, 1.0), 0.62);
          out_FragColor = c; }` });
    this.highlight.enabled = false;
    this.highlight.selected = [];
    viewer.scene.postProcessStages.add(this.highlight);
    this.stopWatching = viewer.scene.preUpdate.addEventListener(() => {
      if (this.runtime.isDestroyed()) { this.highlight.enabled = false; return; }
      const picks = this.runtime._pickIds;
      if (picks !== this.lastPickIds || picks?.length !== this.lastPickCount) this.refreshSelection();
    });
  }

  get componentIds(): readonly string[] { return [...this.components.keys()]; }
  get isDisposed(): boolean { return this.disposed; }

  setState(componentId: string, state: EngineeringRenderState): void {
    this.applyStates([{ componentId, ...state }]);
  }

  /** Whole-line updates validate first, then update nodes and selection once. */
  applyStates(entries: readonly (EngineeringRenderState & { componentId: string })[]): void {
    this.assertAlive();
    for (const state of entries) {
      this.requireComponent(state.componentId);
      if (typeof state.visible !== 'boolean' || typeof state.occlusion !== 'boolean') throw new Error('构件显示和独立遮挡必须是明确的布尔值。');
    }
    let changed = false;
    for (const state of entries) {
      const component = this.requireComponent(state.componentId);
      if (component.state.visible === state.visible && component.state.occlusion === state.occlusion) continue;
      changed = true; component.state = { visible: state.visible, occlusion: state.occlusion };
      if (!this.suspensionCount) for (const node of component.nodes) node.show = state.visible && this.originalShows.get(node) !== false;
    }
    if (!changed) return;
    this.refreshSelection(); this.viewer.scene.requestRender();
  }

  getState(componentId: string): EngineeringRenderState { return { ...this.requireComponent(componentId).state }; }

  setSelection(componentIds: Iterable<string>): void {
    this.assertAlive();
    const selected = new Set(componentIds);
    for (const id of selected) this.requireComponent(id);
    this.selected = selected; this.refreshSelection(); this.viewer.scene.requestRender();
  }

  /** Scope/permission/scene-mode gate; does not alter saved component switches. */
  setActive(active: boolean): void { if (this.disposed || this.active === active) return; this.active = active; this.refreshSelection(); this.viewer.scene.requestRender(); }
  setExternalEnabled(enabled: boolean): void { this.setActive(enabled); }

  suspend(): () => void {
    this.assertAlive(); this.suspensionCount++;
    if (this.suspensionCount === 1) for (const [node, original] of this.originalShows) node.show = original;
    this.refreshSelection(); this.viewer.scene.requestRender(); let released = false;
    return () => {
      if (released || this.disposed) return; released = true; this.suspensionCount--;
      if (!this.suspensionCount && !this.runtime.isDestroyed()) for (const component of this.components.values()) {
        for (const node of component.nodes) node.show = component.state.visible && this.originalShows.get(node) !== false;
      }
      this.refreshSelection(); this.viewer.scene.requestRender();
    };
  }

  componentIdFromPick(pick: unknown): string | undefined {
    if (this.disposed || !pick || typeof pick !== 'object') return;
    const value = pick as PickId['object'];
    if (value.primitive !== this.model || value.detail?.model !== this.model) return;
    return this.nodeComponents.get(value.detail.node?._id ?? -1);
  }

  /** Called after native model update in the separate compute pass. This never
   * inserts commands into the main scene, its picking pass, or shadow maps. */
  getOcclusionCommands(): EngineeringDrawCommand[] {
    if (this.disposed || !this.active || this.suspensionCount || this.runtime.isDestroyed() || !this.model.show || this.viewer.scene.mode !== SceneMode.SCENE3D) return [];
    const result: EngineeringDrawCommand[] = [];
    for (const component of this.components.values()) {
      if (!component.state.occlusion) continue;
      for (const node of component.nodes) for (const primitive of node.runtimePrimitives) {
        const command = primitive.drawCommand?.command;
        if (!command) throw new Error(`工程构件 ${this.nodeComponents.get(node._id)} 的绘制命令尚未就绪。`);
        result.push(command);
      }
    }
    return result;
  }

  /** Reuse is restricted to immutable, fully loaded static GLB geometry.
   * Effects whose uniforms or texture contents can change without a command
   * rebuild always redraw. Model/command transforms are additionally compared
   * by value by the renderer; object identity alone is insufficient. */
  isStaticDepthCacheEligible(): boolean {
    if (this.disposed || this.runtime.isDestroyed()) return false;
    const model = this.model;
    const texturesReady = this.runtime._texturesLoaded || this.runtime._loader?.texturesLoaded || this.runtime._loader?.incrementallyLoadTextures === false;
    if (!texturesReady || model.clippingPlanes || model.clippingPolygons || model.customShader || model.style ||
        model.activeAnimations.length || this.runtime._featureTables?.length !== 0 || model.splitDirection !== 0) return false;
    return this.runtime._sceneGraph!._runtimeNodes.every(node => !node ||
      (!node.userAnimated && !node.runtimeSkin && !node.morphWeights.length && !node.instancingTransformsBuffer));
  }

  getComponentBounds(componentId: string): BoundingSphere | undefined {
    const component = this.requireComponent(componentId);
    let result: BoundingSphere | undefined;
    for (const node of component.nodes) for (const primitive of node.runtimePrimitives) {
      const sphere = primitive.drawCommand?.command.boundingVolume;
      if (sphere) result = result ? BoundingSphere.union(result, sphere, result) : BoundingSphere.clone(sphere);
    }
    return result;
  }

  private refreshSelection(): void {
    if (this.disposed) return;
    const picks = this.runtime._pickIds ?? [];
    this.lastPickIds = picks; this.lastPickCount = picks.length;
    const selectedPicks = picks.filter(pick => {
      const id = this.componentIdFromPick(pick.object);
      return id !== undefined && this.selected.has(id) && this.requireComponent(id).state.visible;
    });
    this.highlight.selected = selectedPicks.length ? [{ pickIds: selectedPicks }] : [];
    this.highlight.enabled = this.active && !this.suspensionCount && selectedPicks.length > 0 && !this.runtime.isDestroyed() && this.model.show;
  }

  private requireComponent(id: string) {
    const component = this.components.get(id);
    if (!component) throw new Error(`未知工程构件：${id}`);
    return component;
  }
  private assertAlive(): void { if (this.disposed || this.runtime.isDestroyed()) throw new Error('工程构件渲染对象已释放。'); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stopWatching();
    if (!this.runtime.isDestroyed()) for (const [node, original] of this.originalShows) node.show = original;
    if (!this.viewer.isDestroyed()) { this.viewer.scene.postProcessStages.remove(this.highlight); this.viewer.scene.requestRender(); }
    this.components.clear(); this.nodeComponents.clear(); this.originalShows.clear(); this.selected.clear();
  }
}
