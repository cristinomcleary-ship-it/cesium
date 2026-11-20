import * as Cesium from 'cesium';
import { BoundingRectangle, BoundingSphere, Cartesian2, Cartesian3, Color, ComponentDatatype, Geometry, GeometryAttribute, GeometryAttributes,
  Intersect, Matrix3, Matrix4, PerspectiveOffCenterFrustum, PixelFormat, PostProcessStage, PrimitiveType, SceneMode, type Viewer } from 'cesium';
import { EngineeringRenderAdapter, type EngineeringDrawCommand } from './renderAdapter';

type ShaderSource = { sources: string[]; clone(): ShaderSource };
type ShaderProgram = { vertexShaderSource: ShaderSource; fragmentShaderSource: ShaderSource; _attributeLocations: Record<string, number>; destroy(): void; isDestroyed(): boolean };
type Resource = { destroy(): void; isDestroyed(): boolean };
type Texture = Resource & { width: number; height: number };
type Framebuffer = Resource;
type RenderOptions = {
  depthTest: { enabled: boolean; func?: number }; depthMask: boolean; blending: { enabled: boolean };
  colorMask: { red: boolean; green: boolean; blue: boolean; alpha: boolean }; stencilTest: { enabled: boolean };
  cull: { enabled: boolean }; viewport?: BoundingRectangle; [key: string]: unknown;
};
type DrawCommand = EngineeringDrawCommand & { shaderProgram: ShaderProgram; renderState: RenderOptions; framebuffer?: Framebuffer;
  execute(context: Context, state?: PassState): void; vertexArray?: Resource };
type Frustum = { near: number; far: number; clone(): Frustum };
type Context = { depthTexture: boolean; defaultTexture: Texture; drawingBufferWidth: number; drawingBufferHeight: number;
  uniformState: { updateCamera(camera: unknown): void; updateFrustum(frustum: unknown): void; updatePass(pass: number): void };
  createViewportQuadCommand(shader: string, options?: object): DrawCommand;
  readPixels(options: object): Uint8Array };
type PassState = { framebuffer?: Framebuffer; viewport?: BoundingRectangle };
type FrameState = { mode: number; passes: { render?: boolean; pick?: boolean }; frameNumber: number; commandList: unknown[] };
type Renderer = {
  VERSION: string; Pass: { COMPUTE: number; OPAQUE: number }; BufferUsage: { STATIC_DRAW: number };
  PixelDatatype: { UNSIGNED_BYTE: number; UNSIGNED_INT: number }; Sampler: { NEAREST: unknown };
  Texture: new (options: object) => Texture; Framebuffer: new (options: object) => Framebuffer;
  PassState: new (context: Context) => PassState;
  ClearCommand: new (options: object) => { execute(context: Context, state?: PassState): void };
  DrawCommand: { new (options: object): DrawCommand; shallowClone(command: EngineeringDrawCommand): DrawCommand };
  VertexArray: { fromGeometry(options: object): Resource };
  ShaderProgram: { fromCache(options: object): ShaderProgram };
  ShaderSource: { replaceMain(code: string, replacement: string): string };
  RenderState: { getState(state: unknown): RenderOptions; fromCache(options: object): RenderOptions; removeFromCache(options: object): void };
};
const renderer = Cesium as unknown as Renderer;

export type EngineeringDetectionPlane = { center: Cartesian3; normal: Cartesian3; width: number; height: number; color?: Color };
export type EngineeringOcclusionStats = { frameNumber: number; commands: number; candidates?: number; culled?: number; width: number; height: number;
  depthReused?: boolean; depthDraws?: number;
  /** CPU submission time; deliberately not presented as GPU execution time. */ milliseconds: number; near: number; far: number; error?: string };

/** A single-context analytical pass. Native color, depth, picking and shadows
 * are untouched. Source geometry is shared, drawn into an owned FBO first;
 * only the explicit detection plane is depth-tested against that buffer. Its
 * surviving color is composited over the normal scene, matching the offline
 * reference's color / independent-depth / detection ordering. */
export class EngineeringOcclusionRenderer {
  private readonly context: Context;
  private readonly stage: PostProcessStage;
  private readonly driver: { update(state: FrameState): void; isDestroyed(): boolean; destroy(): void };
  private readonly adapters = new Set<EngineeringRenderAdapter>();
  private readonly programs = new Map<ShaderProgram, ShaderProgram>();
  private readonly states = new Map<unknown, { options: RenderOptions; state: RenderOptions }>();
  private commands = new WeakMap<object, { command: DrawCommand; shader: ShaderProgram; state: unknown }>();
  private framebuffer?: Framebuffer;
  private colorTexture?: Texture;
  private depthTexture?: Texture;
  private readonly passState: PassState;
  private plane?: EngineeringDetectionPlane;
  private planeCommand?: DrawCommand;
  private planeState?: RenderOptions;
  private enabled = false;
  private suspensionCount = 0;
  private disposed = false;
  private stats: EngineeringOcclusionStats = { frameNumber: -1, commands: 0, width: 0, height: 0, milliseconds: 0, near: 0, far: 0 };
  private readonly clear;
  private readonly compute;
  private cachedDepth?: { keys: unknown[]; matrices: Float64Array; near: number; far: number };

  constructor(private readonly viewer: Viewer) {
    this.context = (viewer.scene as unknown as { context: Context }).context;
    if (renderer.VERSION !== '1.144' && renderer.VERSION !== '1.144.0') throw new Error(`工程独立遮挡仅支持已核验的 Cesium 1.144，当前为 ${renderer.VERSION}。`);
    if (!this.context.depthTexture || !renderer.Framebuffer || !renderer.DrawCommand?.shallowClone || !renderer.ShaderSource?.replaceMain) {
      throw new Error('当前浏览器缺少独立工程深度缓冲支持。');
    }
    this.passState = new renderer.PassState(this.context);
    this.clear = new renderer.ClearCommand({ color: Color.TRANSPARENT, depth: 1 });
    this.compute = { pass: renderer.Pass.COMPUTE, owner: this, execute: () => this.renderIndependentPass() };
    this.stage = new PostProcessStage({ name: `engineering-independent-occlusion-${crypto.randomUUID()}`,
      fragmentShader: `uniform sampler2D colorTexture; uniform sampler2D engineeringDetection; in vec2 v_textureCoordinates;
        void main() { vec4 base = texture(colorTexture, v_textureCoordinates);
          vec4 mark = texture(engineeringDetection, v_textureCoordinates);
          out_FragColor = vec4(mix(base.rgb, mark.rgb, mark.a), base.a + mark.a * (1.0-base.a)); }`,
      uniforms: { engineeringDetection: () => this.colorTexture ?? this.context.defaultTexture } });
    this.stage.enabled = false; viewer.scene.postProcessStages.add(this.stage);
    this.driver = {
      update: state => {
        if (!this.enabled || this.suspensionCount || !this.plane || this.disposed || !state.passes.render || state.passes.pick) return;
        if (state.mode !== SceneMode.SCENE3D) { this.stage.enabled = false; return; }
        this.stats.frameNumber = state.frameNumber;
        state.commandList.push(this.compute);
      },
      isDestroyed: () => this.disposed,
      destroy: () => { this.dispose(); },
    };
    viewer.scene.primitives.add(this.driver);
  }

  add(adapter: EngineeringRenderAdapter): () => void {
    if (this.disposed) throw new Error('工程独立遮挡渲染器已释放。');
    this.adapters.add(adapter); this.cachedDepth = undefined; this.viewer.scene.requestRender();
    let removed = false;
    return () => { if (removed) return; removed = true; this.adapters.delete(adapter); this.cachedDepth = undefined; if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender(); };
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) this.stats.error = undefined;
    this.enabled = enabled; this.syncEnabled();
  }

  setDetectionPlane(value?: EngineeringDetectionPlane): void {
    if (value) {
      const numbers = [...Cartesian3.pack(value.center, []), ...Cartesian3.pack(value.normal, []), value.width, value.height];
      if (numbers.some(number => !Number.isFinite(number)) || value.width <= 0 || value.height <= 0 || Cartesian3.magnitude(value.normal) < 1e-10) {
        throw new Error('独立遮挡检测面的位置、方向和尺寸无效。');
      }
      this.plane = { ...value, center: Cartesian3.clone(value.center), normal: Cartesian3.normalize(value.normal, new Cartesian3()), color: Color.clone(value.color ?? Color.ORANGE.withAlpha(0.75)) };
    } else this.plane = undefined;
    this.syncEnabled();
  }

  /** SceneEffectsCoordinator-compatible lease. Latest component and plane
   * settings are used on release; no historical scene snapshot is replayed. */
  suspend(): () => void {
    this.suspensionCount++; this.syncEnabled(); let released = false;
    return () => { if (released || this.disposed) return; released = true; this.suspensionCount--; this.syncEnabled(); };
  }

  getStats(): EngineeringOcclusionStats { return { ...this.stats }; }

  private syncEnabled(): void {
    if (this.disposed) return;
    this.cachedDepth = undefined;
    this.stage.enabled = this.enabled && this.suspensionCount === 0 && !!this.plane;
    this.viewer.scene.requestRender();
  }

  private ensureFramebuffer(): void {
    const { drawingBufferWidth: width, drawingBufferHeight: height } = this.context;
    if (this.colorTexture?.width === width && this.colorTexture?.height === height) return;
    this.cachedDepth = undefined;
    this.framebuffer?.destroy(); this.framebuffer = undefined; this.colorTexture = this.depthTexture = undefined;
    let color: Texture | undefined, depth: Texture | undefined;
    try {
      color = new renderer.Texture({ context: this.context, width, height, pixelFormat: PixelFormat.RGBA, pixelDatatype: renderer.PixelDatatype.UNSIGNED_BYTE, sampler: renderer.Sampler.NEAREST });
      depth = new renderer.Texture({ context: this.context, width, height, pixelFormat: PixelFormat.DEPTH_COMPONENT, pixelDatatype: renderer.PixelDatatype.UNSIGNED_INT, sampler: renderer.Sampler.NEAREST });
      this.framebuffer = new renderer.Framebuffer({ context: this.context, colorTextures: [color], depthTexture: depth });
      this.colorTexture = color; this.depthTexture = depth;
    } catch (error) { color?.destroy(); depth?.destroy(); throw error; }
    this.passState.framebuffer = this.framebuffer; this.passState.viewport = new BoundingRectangle(0, 0, width, height);
    this.stats.width = width; this.stats.height = height;
  }

  private deriveDepth(source: EngineeringDrawCommand): DrawCommand {
    const shader = source.shaderProgram as ShaderProgram;
    let binding = this.commands.get(source);
    if (!binding || binding.shader !== shader || binding.state !== source.renderState) {
      let program = this.programs.get(shader);
      if (!program) {
        const fragment = shader.fragmentShaderSource.clone();
        fragment.sources = fragment.sources.map(code => renderer.ShaderSource.replaceMain(code, 'engineeringOriginalMain'));
        fragment.sources.push('void main() { engineeringOriginalMain(); if (out_FragColor.a <= 0.0) discard; }');
        program = renderer.ShaderProgram.fromCache({ context: this.context, vertexShaderSource: shader.vertexShaderSource,
          fragmentShaderSource: fragment, attributeLocations: shader._attributeLocations });
        this.programs.set(shader, program);
      }
      let state = this.states.get(source.renderState);
      if (!state) {
        const options = renderer.RenderState.getState(source.renderState);
        options.depthMask = true; options.depthTest.enabled = true; options.blending.enabled = false; options.stencilTest.enabled = false;
        options.colorMask = { red: false, green: false, blue: false, alpha: false };
        state = { options, state: renderer.RenderState.fromCache(options) }; this.states.set(source.renderState, state);
      }
      const command = renderer.DrawCommand.shallowClone(source);
      command.shaderProgram = program; command.renderState = state.state;
      command.castShadows = false; command.receiveShadows = false; command.pickId = undefined; command.snapId = undefined;
      // Map presentation opacity must not make a physical occluder disappear.
      // Authored glTF alpha masks remain in the unchanged fragment pipeline.
      if (source.uniformMap?.model_color) {
        const color = new Color();
        command.uniformMap = { ...source.uniformMap, model_color: () => { Color.clone(source.uniformMap!.model_color() as Color, color); color.alpha = 1; return color; } };
      }
      binding = { command, shader, state: source.renderState }; this.commands.set(source, binding);
    }
    binding.command.modelMatrix = source.modelMatrix; binding.command.boundingVolume = source.boundingVolume;
    binding.command.framebuffer = this.framebuffer;
    return binding.command;
  }

  private preparePlane(): DrawCommand {
    if (!this.planeCommand) {
      const attributes = new GeometryAttributes();
      attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3, values: new Float32Array([-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0]) });
      const geometry = new Geometry({ attributes,
        indices: new Uint16Array([0,1,2,0,2,3]), primitiveType: PrimitiveType.TRIANGLES });
      const array = renderer.VertexArray.fromGeometry({ context: this.context, geometry, attributeLocations: { position: 0 }, bufferUsage: renderer.BufferUsage.STATIC_DRAW });
      let program: ShaderProgram | undefined;
      try {
        program = renderer.ShaderProgram.fromCache({ context: this.context,
          vertexShaderSource: 'in vec3 position; void main() { gl_Position = czm_modelViewProjection * vec4(position, 1.0); }',
          fragmentShaderSource: 'uniform vec4 detectionColor; void main() { out_FragColor = detectionColor; }', attributeLocations: { position: 0 } });
        this.planeState = renderer.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: false, cull: { enabled: false } });
        this.planeCommand = new renderer.DrawCommand({ owner: this, vertexArray: array, primitiveType: PrimitiveType.TRIANGLES,
          shaderProgram: program, renderState: this.planeState, modelMatrix: new Matrix4(),
          uniformMap: { detectionColor: () => this.plane!.color } });
      } catch (error) { array.destroy(); program?.destroy(); throw error; }
    }
    const plane = this.plane!, normal = plane.normal;
    const axis = Cartesian3.mostOrthogonalAxis(normal, new Cartesian3());
    const right = Cartesian3.normalize(Cartesian3.cross(axis, normal, new Cartesian3()), new Cartesian3());
    const up = Cartesian3.cross(normal, right, new Cartesian3());
    Cartesian3.multiplyByScalar(right, plane.width, right); Cartesian3.multiplyByScalar(up, plane.height, up);
    const rotation = Matrix3.fromArray([...Cartesian3.pack(right, []), ...Cartesian3.pack(up, []), ...Cartesian3.pack(normal, [])]);
    this.planeCommand.modelMatrix = Matrix4.fromRotationTranslation(rotation, plane.center);
    this.planeCommand.framebuffer = this.framebuffer;
    return this.planeCommand;
  }

  private renderIndependentPass(): void {
    if (!this.enabled || this.suspensionCount || !this.plane || this.disposed) return;
    const start = performance.now(), context = this.context, camera = this.viewer.camera;
    try {
      this.ensureFramebuffer();
      const candidates = [...this.adapters].flatMap(adapter => adapter.getOcclusionCommands());
      const volume = camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
      const commands = candidates.filter(command => !command.boundingVolume || volume.computeVisibility(command.boundingVolume) !== Intersect.OUTSIDE);
      const cache = this.staticDepthSnapshot(commands);
      if (cache && this.cachedDepth && this.sameSnapshot(cache, this.cachedDepth)) {
        this.stats = { ...this.stats, commands: commands.length, candidates: candidates.length, culled: candidates.length - commands.length,
          depthReused: true, depthDraws: 0, milliseconds: performance.now() - start, near: this.cachedDepth.near, far: this.cachedDepth.far, error: undefined };
        if (!this.stage.enabled) { this.stage.enabled = true; this.viewer.scene.requestRender(); }
        return;
      }
      this.cachedDepth = undefined;
      this.clear.execute(context, this.passState);
      let nearest = Infinity, farthest = 0;
      const measure = (sphere: BoundingSphere) => {
        const distance = Cartesian3.dot(Cartesian3.subtract(sphere.center, camera.positionWC, new Cartesian3()), camera.directionWC);
        nearest = Math.min(nearest, distance - sphere.radius); farthest = Math.max(farthest, distance + sphere.radius);
      };
      for (const source of commands) {
        if (![PrimitiveType.TRIANGLES, PrimitiveType.TRIANGLE_STRIP, PrimitiveType.TRIANGLE_FAN].includes(source.primitiveType)) throw new Error('独立工程遮挡仅接受三角网格构件。');
        if (source.boundingVolume) measure(source.boundingVolume);
      }
      const alignment = Cartesian3.dot(this.plane.normal, camera.directionWC);
      const planeDepthRadius = Math.hypot(this.plane.width, this.plane.height) / 2 * Math.sqrt(Math.max(0, 1 - alignment * alignment));
      measure(new BoundingSphere(this.plane.center, planeDepthRadius));
      const frustum = (camera.frustum as unknown as Frustum).clone();
      frustum.near = Math.max(0.05, camera.frustum.near, nearest * 0.5);
      if (camera.frustum instanceof PerspectiveOffCenterFrustum) {
        const offCenter = frustum as unknown as PerspectiveOffCenterFrustum, ratio = frustum.near / camera.frustum.near;
        offCenter.left = offCenter.left! * ratio; offCenter.right = offCenter.right! * ratio;
        offCenter.top = offCenter.top! * ratio; offCenter.bottom = offCenter.bottom! * ratio;
      }
      frustum.far = Math.max(frustum.near + 1, farthest * 1.1);
      context.uniformState.updateCamera(camera); context.uniformState.updateFrustum(frustum); context.uniformState.updatePass(renderer.Pass.OPAQUE);
      for (const source of commands) this.deriveDepth(source).execute(context, this.passState);
      this.preparePlane().execute(context, this.passState);
      this.stats = { ...this.stats, commands: commands.length, candidates: candidates.length, culled: candidates.length - commands.length,
        depthReused: false, depthDraws: commands.length, milliseconds: performance.now() - start, near: frustum.near, far: frustum.far, error: undefined };
      if (cache) this.cachedDepth = { ...cache, near: frustum.near, far: frustum.far };
      if (!this.stage.enabled) { this.stage.enabled = true; this.viewer.scene.requestRender(); }
    } catch (error) {
      this.cachedDepth = undefined;
      if (this.framebuffer) this.clear.execute(context, this.passState);
      this.stats.error = error instanceof Error ? error.message : String(error);
      // Cesium has already selected this frame's post-process output. Keep
      // its stage valid with the cleared transparent texture; the controller
      // disables detection before the next frame in preUpdate.
    } finally {
      context.uniformState.updateCamera(camera); context.uniformState.updatePass(renderer.Pass.COMPUTE);
    }
  }

  private staticDepthSnapshot(commands: readonly EngineeringDrawCommand[]): { keys: unknown[]; matrices: Float64Array } | undefined {
    if (![...this.adapters].every(adapter => adapter.isStaticDepthCacheEligible())) return;
    const scene = this.viewer.scene, camera = this.viewer.camera, plane = this.plane!;
    const keys: unknown[] = [this.context.drawingBufferWidth, this.context.drawingBufferHeight,
      ...Matrix4.toArray(camera.viewMatrix), ...Matrix4.toArray(camera.frustum.projectionMatrix),
      scene.verticalExaggeration, scene.verticalExaggerationRelativeHeight,
      ...Cartesian3.pack(plane.center, []), ...Cartesian3.pack(plane.normal, []), plane.width, plane.height,
      plane.color?.red, plane.color?.green, plane.color?.blue, plane.color?.alpha];
    // DrawCommands and their matrices are mutable. Capture identities for all
    // rebuilt resources, and scalar values for every transform/bounding sphere.
    const matrices = new Float64Array(commands.length * 20);
    let offset = 0;
    for (const command of commands) {
      const matrix = command.modelMatrix as Matrix4 | undefined, sphere = command.boundingVolume;
      if (!matrix || !sphere) return;
      keys.push(command, command.shaderProgram, command.renderState, command.vertexArray, command.uniformMap,
        command.primitiveType, command.count, command.offset, command.instanceCount);
      for (let i = 0; i < 16; i++) matrices[offset++] = matrix[i];
      matrices[offset++] = sphere.center.x; matrices[offset++] = sphere.center.y;
      matrices[offset++] = sphere.center.z; matrices[offset++] = sphere.radius;
    }
    return { keys, matrices };
  }

  private sameSnapshot(a: { keys: unknown[]; matrices: Float64Array }, b: { keys: unknown[]; matrices: Float64Array }): boolean {
    return a.keys.length === b.keys.length && a.matrices.length === b.matrices.length &&
      a.keys.every((value, index) => value === b.keys[index]) && a.matrices.every((value, index) => value === b.matrices[index]);
  }

  /** Explicit diagnostic readback only. Coordinates use drawing-buffer pixels,
   * bottom-left origin. Never used in the normal interactive render loop. */
  readDetectionPixel(x: number, y: number): number[] {
    if (!this.framebuffer) throw new Error('独立遮挡帧尚未生成。');
    return [...this.context.readPixels({ x, y, width: 1, height: 1, framebuffer: this.framebuffer })];
  }

  readDepthPixel(x: number, y: number): number {
    if (!this.depthTexture || !this.framebuffer) throw new Error('独立遮挡深度尚未生成。');
    const color = new renderer.Texture({ context: this.context, width: 1, height: 1, pixelFormat: PixelFormat.RGBA });
    const framebuffer = new renderer.Framebuffer({ context: this.context, colorTextures: [color] });
    let command: DrawCommand | undefined;
    const options = { viewport: new BoundingRectangle(0, 0, 1, 1) };
    try {
      command = this.context.createViewportQuadCommand(`uniform sampler2D engineeringDepth; uniform vec2 sampleUv;
        void main() { float d = texture(engineeringDepth, sampleUv).r; out_FragColor = d >= 1.0 ? vec4(1.0) : czm_packDepth(d); }`,
        { uniformMap: { engineeringDepth: () => this.depthTexture, sampleUv: () => new Cartesian2((x + 0.5) / this.depthTexture!.width, (y + 0.5) / this.depthTexture!.height) },
          framebuffer, renderState: renderer.RenderState.fromCache(options) });
      command.execute(this.context);
      const bytes = this.context.readPixels({ width: 1, height: 1, framebuffer });
      if (bytes.every(value => value === 255)) return 1;
      return bytes[0] / 255 + bytes[1] / 65025 + bytes[2] / 16581375 + bytes[3] / 4228250625;
    } finally { command?.shaderProgram.destroy(); framebuffer.destroy(); renderer.RenderState.removeFromCache(options); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.enabled = false;
    this.cachedDepth = undefined;
    if (!this.viewer.isDestroyed()) { this.viewer.scene.primitives.remove(this.driver); this.viewer.scene.postProcessStages.remove(this.stage); }
    this.framebuffer?.destroy(); this.framebuffer = undefined; this.colorTexture = this.depthTexture = undefined;
    this.planeCommand?.shaderProgram.destroy(); this.planeCommand?.vertexArray?.destroy();
    if (this.planeState) renderer.RenderState.removeFromCache(renderer.RenderState.getState(this.planeState));
    for (const program of this.programs.values()) if (!program.isDestroyed()) program.destroy();
    for (const value of this.states.values()) renderer.RenderState.removeFromCache(value.options);
    this.programs.clear(); this.states.clear(); this.adapters.clear(); this.commands = new WeakMap();
  }
}
