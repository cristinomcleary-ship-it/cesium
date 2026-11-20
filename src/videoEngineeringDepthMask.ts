import * as Cesium from 'cesium';
import { Color, PrimitiveType, type Model } from 'cesium';

type ShaderSource = { sources: string[]; clone(): ShaderSource };
type ShaderProgram = {
  fragmentShaderSource: ShaderSource; vertexShaderSource: ShaderSource;
  _attributeLocations: Record<string, number>; isDestroyed(): boolean; destroy(): void;
};
type RenderOptions = {
  depthTest: { enabled: boolean }; depthMask: boolean; blending: { enabled: boolean };
  colorMask: { red: boolean; green: boolean; blue: boolean; alpha: boolean }; stencilTest: { enabled: boolean };
};
type DrawCommand = {
  pass: number; primitiveType: number; owner: unknown; shaderProgram: ShaderProgram;
  renderState: RenderOptions; modelMatrix: unknown; boundingVolume: unknown; orientedBoundingBox: unknown;
  castShadows: boolean; receiveShadows: boolean; pickId: unknown; snapId: unknown;
};
type FrameState = { context: unknown; passes: { render?: boolean; pick?: boolean; pickVoxel?: boolean; depth?: boolean }; commandList: DrawCommand[] };
type RuntimeModel = Omit<Model, 'update'> & { update: (state: FrameState) => void; _drawCommandsBuilt: boolean };
type Renderer = {
  Pass: { OPAQUE: number; TRANSLUCENT: number };
  DrawCommand: { shallowClone(command: DrawCommand): DrawCommand };
  ShaderSource: { replaceMain(source: string, name: string): string };
  ShaderProgram: { fromCache(options: { context: unknown; vertexShaderSource: ShaderSource; fragmentShaderSource: ShaderSource; attributeLocations: Record<string, number> }): ShaderProgram };
  RenderState: { getState(state: RenderOptions): RenderOptions; fromCache(options: RenderOptions): RenderOptions; removeFromCache(options: RenderOptions): void };
};

// Cesium 1.144 / engine 26.2. Substitute only the session's draw commands:
// preserving the native fragment pipeline keeps authored alpha cutouts, clips,
// skinning and logarithmic depth. Never edit source GLB or share our commands
// with the map, picks or other shadow passes.
const renderer = Cesium as unknown as Renderer;
const writeMask = `
void main() {
  arEngineeringOriginalMain();
  if (out_FragColor.a <= 0.0) { discard; }
  out_FragColor = vec4(0.0);
}`;

export class VideoEngineeringDepthMask {
  private readonly runtime: RuntimeModel;
  private readonly originalUpdate: RuntimeModel['update'];
  private readonly hadOwnUpdate: boolean;
  private readonly originalColor: Color;
  private readonly changedColor: boolean;
  private readonly appliedColor = Color.clone(Color.WHITE);
  private readonly programs = new Map<ShaderProgram, ShaderProgram>();
  private readonly states = new Map<RenderOptions, { state: RenderOptions; options: RenderOptions }>();
  private readonly commands = new WeakMap<DrawCommand, { depth: DrawCommand; program: ShaderProgram; state: RenderOptions }>();
  private disposed = false;
  error?: string;

  constructor(model: Model) {
    this.runtime = model as unknown as RuntimeModel;
    this.originalUpdate = this.runtime.update;
    if (typeof this.originalUpdate !== 'function' || typeof renderer.DrawCommand?.shallowClone !== 'function'
      || typeof renderer.ShaderSource?.replaceMain !== 'function' || typeof renderer.ShaderProgram?.fromCache !== 'function'
      || typeof renderer.RenderState?.removeFromCache !== 'function' || typeof renderer.Pass?.OPAQUE !== 'number') {
      throw new Error('当前 Cesium 渲染接口不支持工程模型遮挡');
    }
    this.hadOwnUpdate = Object.hasOwn(this.runtime, 'update');
    this.originalColor = Color.clone(model.color);
    // An opacity set for map presentation must not prevent a hidden depth source
    // from submitting geometry. Authored GLB material alpha is still respected.
    this.changedColor = !Color.equals(model.color, this.appliedColor);
    if (this.changedColor) model.color = this.appliedColor;
    this.runtime.update = this.update;
  }

  get ready(): boolean { return !this.error && !this.runtime.isDestroyed() && this.runtime.ready && this.runtime._drawCommandsBuilt; }

  private readonly update = (state: FrameState) => {
    const start = state.commandList.length;
    this.originalUpdate.call(this.runtime, state);
    let write = start;
    let seenModel = false, seenTriangles = false;
    for (let index = start; index < state.commandList.length; index++) {
      const source = state.commandList[index];
      if (source.owner !== this.runtime) { state.commandList[write++] = source; continue; }
      if ((!state.passes.render && !state.passes.pick && !state.passes.depth) || state.passes.pickVoxel || this.error) continue;
      if (source.pass !== renderer.Pass.OPAQUE && source.pass !== renderer.Pass.TRANSLUCENT) continue;
      seenModel = true;
      if (source.primitiveType !== PrimitiveType.TRIANGLES && source.primitiveType !== PrimitiveType.TRIANGLE_STRIP
        && source.primitiveType !== PrimitiveType.TRIANGLE_FAN) continue;
      seenTriangles = true;
      try { const mask = this.depthCommand(source, state.context); state.commandList[write++] = mask; }
      catch (error) {
        this.error = `工程模型遮挡渲染失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (state.passes.render && seenModel && !seenTriangles) this.error = '工程遮挡来源需要包含三角网格表面';
    // Do not expose a partially prepared mask within this frame.
    if (this.error) {
      let keep = start;
      for (let index = start; index < write; index++) {
        if (state.commandList[index].owner !== this.runtime) state.commandList[keep++] = state.commandList[index];
      }
      write = keep;
    }
    state.commandList.length = write;
  };

  private depthCommand(source: DrawCommand, context: unknown): DrawCommand {
    const program = source.shaderProgram;
    const originalState = source.renderState;
    let binding = this.commands.get(source);
    if (!binding || binding.program !== program || binding.state !== originalState) {
      let shader = this.programs.get(program);
      if (!shader) {
        const fragment = program.fragmentShaderSource.clone();
        fragment.sources = fragment.sources.map(code => renderer.ShaderSource.replaceMain(code, 'arEngineeringOriginalMain'));
        fragment.sources.push(writeMask);
        shader = renderer.ShaderProgram.fromCache({ context, vertexShaderSource: program.vertexShaderSource,
          fragmentShaderSource: fragment, attributeLocations: program._attributeLocations });
        this.programs.set(program, shader);
      }
      let state = this.states.get(originalState);
      if (!state) {
        const options = renderer.RenderState.getState(originalState);
        options.depthMask = true;
        options.depthTest.enabled = true;
        options.blending.enabled = false;
        options.stencilTest.enabled = false;
        options.colorMask = { red: true, green: true, blue: true, alpha: true };
        state = { state: renderer.RenderState.fromCache(options), options };
        this.states.set(originalState, state);
      }
      const depth = renderer.DrawCommand.shallowClone(source);
      depth.shaderProgram = shader; depth.renderState = state.state; depth.pass = renderer.Pass.OPAQUE;
      depth.castShadows = false; depth.receiveShadows = false; depth.pickId = undefined; depth.snapId = undefined;
      binding = { depth, program, state: originalState };
      this.commands.set(source, binding);
    }
    const { depth } = binding;
    depth.modelMatrix = source.modelMatrix;
    depth.boundingVolume = source.boundingVolume;
    depth.orientedBoundingBox = source.orientedBoundingBox;
    return depth;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (!this.runtime.isDestroyed()) {
        if (this.runtime.update === this.update) {
          if (this.hadOwnUpdate) this.runtime.update = this.originalUpdate;
          else Reflect.deleteProperty(this.runtime, 'update');
        }
        if (this.changedColor && Color.equals(this.runtime.color, this.appliedColor)) this.runtime.color = this.originalColor;
      }
    } finally {
      for (const shader of this.programs.values()) if (!shader.isDestroyed()) shader.destroy();
      for (const { options } of this.states.values()) renderer.RenderState.removeFromCache(options);
      this.programs.clear(); this.states.clear();
    }
  }
}
