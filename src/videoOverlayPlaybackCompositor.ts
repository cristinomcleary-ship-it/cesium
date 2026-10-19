/**
 * Native-pixel playback composition. Source video, Cesium and annotations stay on
 * the GPU; Canvas2D remains confined to the separate offline export path.
 */
export type VideoOverlayPlaybackCompositorOptions = {
  canvas?: HTMLCanvasElement;
  onContextLost?: () => void;
  /** Only explicit user-selected export sizes may scale a native source. */
  allowSourceScaling?: boolean;
  /** Cesium may round its CSS/DPR drawing buffer by one pixel. */
  allowOverlayRounding?: boolean;
};

type Gl = WebGLRenderingContext | WebGL2RenderingContext;
type TextureSlot = { texture: WebGLTexture; width: number; height: number };

function dimensions(source: TexImageSource): { width: number; height: number } {
  const item = source as unknown as {
    videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number;
    displayWidth?: number; displayHeight?: number; width?: number; height?: number;
  };
  return {
    width: item.videoWidth ?? item.naturalWidth ?? item.displayWidth ?? item.width ?? 0,
    height: item.videoHeight ?? item.naturalHeight ?? item.displayHeight ?? item.height ?? 0,
  };
}

function compile(gl: Gl, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建原分辨率播放着色器。');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || '着色器编译失败'; gl.deleteShader(shader);
    throw new Error(`原分辨率播放合成器初始化失败：${message}`);
  }
  return shader;
}

/** One source snapshot is paired with one camera/overlay PTS before presentation. */
export class VideoOverlayPlaybackCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: Gl;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly sourceTexture: TextureSlot;
  private readonly overlayTexture: TextureSlot;
  private readonly annotationTexture: TextureSlot;
  private readonly maxDimension: number;
  private readonly position: number;
  private readonly contextLostListener: (event: Event) => void;
  private readonly allowSourceScaling: boolean;
  private readonly allowOverlayRounding: boolean;
  private disposed = false;
  private lost = false;
  private capturedTime?: number;
  private committedTime?: number;
  private overlayRoundingPixels = 1;
  private hasAnnotations = false;

  constructor(width: number, height: number, options: VideoOverlayPlaybackCompositorOptions = {}) {
    this.canvas = options.canvas ?? document.createElement('canvas');
    const attributes: WebGLContextAttributes = {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
      stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    };
    const gl2 = this.canvas.getContext('webgl2', attributes);
    const gl = gl2 ?? this.canvas.getContext('webgl', attributes);
    if (!gl) throw new Error('当前浏览器无法启动 GPU 原分辨率播放，请检查硬件加速。');
    this.gl = gl;
    this.allowSourceScaling = options.allowSourceScaling === true;
    this.allowOverlayRounding = options.allowOverlayRounding === true;
    this.maxDimension = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    try { this.validateSize(width, height); }
    catch (error) { gl.getExtension('WEBGL_lose_context')?.loseContext(); throw error; }
    const vertex = gl2
      ? '#version 300 es\nin vec2 position; out vec2 uv; void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }'
      : 'attribute vec2 position; varying vec2 uv; void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }';
    const fragmentBody = `
      uniform sampler2D sourceImage;
      uniform sampler2D overlayImage;
      uniform sampler2D annotationImage;
      void main(){
        vec4 base = SAMPLE(sourceImage,uv);
        vec4 model = SAMPLE(overlayImage,uv);
        vec4 mark = SAMPLE(annotationImage,uv);
        vec4 merged = model + base * (1. - model.a);
        OUTPUT = mark + merged * (1. - mark.a);
      }`;
    const fragment = gl2
      ? `#version 300 es\nprecision highp float; in vec2 uv; out vec4 result;\n${fragmentBody.replaceAll('SAMPLE', 'texture').replaceAll('OUTPUT', 'result')}`
      : `precision ${gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? 'highp' : 'mediump'} float; varying vec2 uv;\n${fragmentBody.replaceAll('SAMPLE', 'texture2D').replaceAll('OUTPUT', 'gl_FragColor')}`;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
    const textures: TextureSlot[] = [];
    try {
      shaders.push(compile(gl, gl.VERTEX_SHADER, vertex)); shaders.push(compile(gl, gl.FRAGMENT_SHADER, fragment));
      program = gl.createProgram(); if (!program) throw new Error('无法创建原分辨率播放程序。');
      shaders.forEach(shader => gl.attachShader(program!, shader)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`原分辨率播放程序连接失败：${gl.getProgramInfoLog(program) || ''}`);
      buffer = gl.createBuffer(); if (!buffer) throw new Error('无法创建播放顶点缓冲。');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      for (let index = 0; index < 3; index += 1) {
        const texture = gl.createTexture(); if (!texture) throw new Error('无法创建播放纹理。');
        textures.push({ texture, width: 1, height: 1 }); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      }
      gl.useProgram(program);
      ['sourceImage', 'overlayImage', 'annotationImage'].forEach((name, index) => gl.uniform1i(gl.getUniformLocation(program!, name), index));
    } catch (error) {
      textures.forEach(slot => gl.deleteTexture(slot.texture)); if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext(); throw error;
    } finally { shaders.forEach(shader => gl.deleteShader(shader)); }
    this.program = program;
    this.buffer = buffer;
    [this.sourceTexture, this.overlayTexture, this.annotationTexture] = textures;
    this.position = gl.getAttribLocation(program, 'position');
    this.contextLostListener = () => {
      this.lost = true; this.capturedTime = undefined;
      if (!this.disposed) options.onContextLost?.();
    };
    this.canvas.addEventListener('webglcontextlost', this.contextLostListener);
    this.canvas.width = width; this.canvas.height = height;
  }

  get sourceTime(): number | undefined { return this.capturedTime; }
  get presentedTime(): number | undefined { return this.committedTime; }
  get isDisposed(): boolean { return this.disposed; }
  get isContextLost(): boolean { return this.lost || this.gl.isContextLost(); }

  /** Captures the currently decoded video frame without a native-size CPU copy. */
  captureSource(source: TexImageSource, mediaTime: number): boolean {
    if (this.disposed || this.isContextLost || !Number.isFinite(mediaTime)) return false;
    const size = dimensions(source); if (!size.width || !size.height) return false;
    this.validateSize(size.width, size.height);
    if (this.allowSourceScaling) {
      const pixelError = Math.abs(size.width * this.canvas.height - size.height * this.canvas.width) / Math.max(size.width, size.height, this.canvas.width, this.canvas.height);
      if (pixelError > 1) throw new Error('源视频与导出画面宽高比不一致，无法保持完整画面。');
    } else this.validateSourceSize(size.width, size.height);
    this.upload(this.sourceTexture, source, size.width, size.height, 0);
    this.capturedTime = mediaTime; return true;
  }

  /** False leaves the last complete presentation untouched rather than flashing. */
  commit(overlay: HTMLCanvasElement, mediaTime: number, annotations?: HTMLCanvasElement): boolean {
    if (this.disposed || this.isContextLost || !Number.isFinite(mediaTime) || this.capturedTime === undefined || Math.abs(this.capturedTime - mediaTime) > 1e-6) return false;
    this.validateSize(overlay.width, overlay.height);
    const roundingOnly = this.allowOverlayRounding && overlay.width >= this.canvas.width && overlay.height >= this.canvas.height
      && overlay.width - this.canvas.width <= this.overlayRoundingPixels && overlay.height - this.canvas.height <= this.overlayRoundingPixels;
    if (!roundingOnly) this.validateSourceSize(overlay.width, overlay.height);
    if (annotations) this.validateSourceSize(annotations.width, annotations.height);
    this.upload(this.overlayTexture, overlay, overlay.width, overlay.height, 1);
    if (annotations) { this.upload(this.annotationTexture, annotations, annotations.width, annotations.height, 2); this.hasAnnotations = true; }
    else if (this.hasAnnotations) this.clearAnnotations();
    this.draw();
    this.committedTime = mediaTime; return true;
  }

  /** Remove cached model and annotation pixels synchronously on access revocation.
   * The source texture stays available, but this is not a completed fused frame.
   */
  clearOverlay(): boolean {
    if (this.disposed || this.isContextLost) return false;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.overlayTexture.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.overlayTexture.width = 1; this.overlayTexture.height = 1;
    this.clearAnnotations(); this.draw(); this.committedTime = undefined;
    return true;
  }

  private draw(): void {
    const gl = this.gl;
    gl.useProgram(this.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.position); gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
    [this.sourceTexture, this.overlayTexture, this.annotationTexture].forEach((slot, index) => { gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, slot.texture); });
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** CSS client dimensions are integer-rounded before native-resolution upscale.
   * The controller derives this bound only on layout; never accept undersampling.
   */
  setOverlayRoundingPixels(pixels: number): void {
    if (!Number.isSafeInteger(pixels) || pixels < 1) throw new Error('GPU 画面取整范围无效');
    this.overlayRoundingPixels = Math.min(pixels, this.maxDimension);
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.validateSize(width, height);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width; this.canvas.height = height; this.capturedTime = undefined; this.committedTime = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.capturedTime = undefined; this.committedTime = undefined;
    this.canvas.removeEventListener('webglcontextlost', this.contextLostListener);
    const gl = this.gl;
    [this.sourceTexture, this.overlayTexture, this.annotationTexture].forEach(slot => gl.deleteTexture(slot.texture));
    gl.deleteBuffer(this.buffer); gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = 0; this.canvas.height = 0;
  }

  private validateSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || Math.max(width, height) > this.maxDimension) throw new Error(`视频原分辨率 ${width} × ${height} 超出 GPU 合成器支持范围（最大 ${this.maxDimension}）。`);
  }
  private validateSourceSize(width: number, height: number): void {
    if (width !== this.canvas.width || height !== this.canvas.height) throw new Error(`播放帧尺寸 ${width} × ${height} 与原视频 ${this.canvas.width} × ${this.canvas.height} 不一致。`);
  }
  private upload(slot: TextureSlot, source: TexImageSource, width: number, height: number, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (slot.width === width && slot.height === height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); slot.width = width; slot.height = height; }
  }
  private clearAnnotations(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.annotationTexture.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.annotationTexture.width = 1; this.annotationTexture.height = 1;
    this.hasAnnotations = false;
  }
}
