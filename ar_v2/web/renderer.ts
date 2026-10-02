import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { checkedMatrix, opticalCamera } from './camera';

export type CameraSpec = { K: number[]; width: number; height: number; T_camera_from_scene: number[] };
export type Pose = CameraSpec & { status: string; geometry_version: string; source_video_hash: string;
  original_frame_id: string | number; original_pts: number; time_base: string | number[];
  camera_profile_id: string; calibration_version: string; provenance?: unknown };
export type FrameImage = Pick<Pose, 'width' | 'height' | 'source_video_hash' | 'original_frame_id' | 'original_pts' | 'time_base' | 'camera_profile_id' | 'calibration_version'> & { image: CanvasImageSource; validMask?: CanvasImageSource };
type Entry = { mesh: THREE.Mesh; base: THREE.MeshBasicMaterial; depth: THREE.ShaderMaterial; id: THREE.ShaderMaterial; fusion: THREE.MeshBasicMaterial };
type SceneManifest = { geometry_version: string; chunks: Array<{ uri: string }> };
const rowFlip = <T extends Float32Array>(data: T, width: number, height: number) => {
  const result = new Float32Array(data.length);
  for (let y = 0; y < height; y++) result.set(data.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
  return result;
};

const depthVertex = `attribute float triangleId; varying vec2 vUv; varying float vZ; varying float vId;
void main(){vUv=uv;vec4 p=modelViewMatrix*vec4(position,1.0);vZ=-p.z;vId=triangleId;gl_Position=projectionMatrix*p;}`;
const depthFragment = `uniform sampler2D baseMap; uniform mat3 uvTransform; uniform float alphaCut; uniform float opacityValue;
varying vec2 vUv;varying float vZ;varying float vId;
void main(){float a=texture2D(baseMap,(uvTransform*vec3(vUv,1.)).xy).a*opacityValue;if(a<alphaCut)discard;
gl_FragColor=vec4(OUTPUT,0.,0.,1.);}`;
const fusionDeclarations = `
uniform bool arEnabled; uniform sampler2D arImage; uniform sampler2D arMask; uniform sampler2D arDepth;
uniform mat4 arCamera; uniform vec4 arK; uniform vec2 arSize; uniform float arRasterPrecision; uniform float arNear; uniform float arFar;
varying vec3 arPosition; varying vec3 arNormal;
float planeZ(vec3 n,float d,vec2 pixel){vec3 q=vec3((pixel.x-arK.z)/arK.x,(pixel.y-arK.w)/arK.y,1.);
float denom=dot(n,q);return abs(denom)>1e-5 ? -d/denom : -1.;}
float fetchZ(vec2 pixel){return texture2D(arDepth,vec2((pixel.x+.5)/arSize.x,1.-(pixel.y+.5)/arSize.y)).r;}
bool sampleOnPlane(vec3 n,float d,vec2 texel){if(any(lessThan(texel,vec2(0.)))||any(greaterThanEqual(texel,arSize)))return false;
float expected=planeZ(n,d,texel), measured=fetchZ(texel);
vec3 ray=vec3((texel.x-arK.z)/arK.x,(texel.y-arK.w)/arK.y,1.);
float denominator=abs(dot(n,ray));
// Float32 operations plus a conservative two raster subpixel steps of the analytic plane gradient.
float gradient=abs(expected)*(abs(n.x)/arK.x+abs(n.y)/arK.y)/max(denominator,1e-5);
float tolerance=64.*1.1920928955078125e-7*abs(expected)+2.*arRasterPrecision*gradient;
return measured>0.&&expected>arNear&&expected<arFar&&abs(expected-measured)<=tolerance;}
`;
const fusionFragment = `
if(arEnabled){vec3 p=(arCamera*vec4(arPosition,1.)).xyz;
 vec2 pixel=vec2(arK.x*p.x/p.z+arK.z,arK.y*p.y/p.z+arK.w);
 if(p.z>arNear&&p.z<arFar&&all(greaterThanEqual(pixel,vec2(-.5)))&&all(lessThan(pixel,arSize-.5))){
  vec2 texel=floor(pixel+.5);vec3 n=normalize(mat3(arCamera)*arNormal);float d=-dot(n,p);
  bool valid=sampleOnPlane(n,d,texel)&&sampleOnPlane(n,d,texel+vec2(1.,0.))&&sampleOnPlane(n,d,texel-vec2(1.,0.))
   &&sampleOnPlane(n,d,texel+vec2(0.,1.))&&sampleOnPlane(n,d,texel-vec2(0.,1.));
  vec2 uv=vec2((pixel.x+.5)/arSize.x,1.-(pixel.y+.5)/arSize.y);
  vec2 lower=floor(pixel);
vec2 maskUV=(lower+.5)/arSize;maskUV.y=1.-maskUV.y;
vec2 stepUV=vec2(1./arSize.x,-1./arSize.y);
bool maskValid=texture2D(arMask,maskUV).r>.99&&texture2D(arMask,maskUV+vec2(stepUV.x,0.)).r>.99
 &&texture2D(arMask,maskUV+vec2(0.,stepUV.y)).r>.99&&texture2D(arMask,maskUV+stepUV).r>.99;
if(valid&&maskValid){vec4 videoColor=texture2D(arImage,uv);
   // CanvasTexture is sRGB; explicitly decode before linear-space replacement.
   vec3 linearVideo=mix(videoColor.rgb/12.92,pow((videoColor.rgb+.055)/1.055,vec3(2.4)),step(vec3(.04045),videoColor.rgb));
   outgoingLight=linearVideo;
  }
 }
}
`;

/** Fixed scene shared by reference RGB, source depth, and direct mesh projection. No Cesium dependency. */
export class FixedSceneRenderer {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly entries: Entry[] = [];
  readonly uniforms = {
    arRasterPrecision: { value: 1 / 256 }, arEnabled: { value: false }, arImage: { value: null as THREE.Texture | null }, arMask: { value: null as THREE.Texture | null },
    arDepth: { value: null as THREE.Texture | null }, arCamera: { value: new THREE.Matrix4() },
    arK: { value: new THREE.Vector4() }, arSize: { value: new THREE.Vector2() }, arNear: { value: .1 }, arFar: { value: 3000 },
  };
  geometryVersion = ''; triangleCount = 0; committed: Pose | null = null;
  private token = 0; private targets: THREE.WebGLRenderTarget[] = []; private activeSlot = -1;
  private white: THREE.DataTexture;
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.NoToneMapping;
    if (!this.renderer.capabilities.isWebGL2 || !this.renderer.extensions.has('EXT_color_buffer_float')) throw new Error('精确融合需要 WebGL2 和浮点颜色附件');
    const gl = this.renderer.getContext();
    const subpixelBits = gl.getParameter(gl.SUBPIXEL_BITS) as number;
    if (subpixelBits < 4) throw new Error('GPU raster precision below the supported bound');
    this.uniforms.arRasterPrecision.value = 2 ** -subpixelBits;
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); this.white.needsUpdate = true;
    this.scene.background = new THREE.Color(0x17202b);
  }
  async load(manifest: SceneManifest, baseUrl: string) {
    if (this.entries.length) throw new Error('Geometry is immutable after loading; create a new renderer for another version');
    this.geometryVersion = manifest.geometry_version;
    const loader = new GLTFLoader();
    for (const chunk of manifest.chunks) {
      const gltf = await loader.loadAsync(new URL(chunk.uri, baseUrl).href);
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        if (Array.isArray(object.material)) throw new Error('Split multi-material primitives before normalization');
        this.addMesh(object);
      });
    }
    if (!this.entries.length) throw new Error('规范化场景没有可渲染网格');
  }
  addMesh(source: THREE.Mesh) {
    const geometry = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone();
    geometry.applyMatrix4(source.matrixWorld);
    const p = geometry.getAttribute('position'), normals = new Float32Array(p.count * 3), ids = new Float32Array(p.count);
    if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(p.count * 2), 2));
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1).sub(a); c.fromBufferAttribute(p, i + 2).sub(a);
      const n = b.cross(c).normalize(); const id = ++this.triangleCount;
      if (id >= 16_777_216) throw new Error('场景超过精确浮点三角面编号范围，请分块缩小 ROI');
      for (let j = i; j < i + 3; j++) { normals.set([n.x, n.y, n.z], j * 3); ids[j] = id; }
    }
    geometry.setAttribute('faceNormal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('triangleId', new THREE.Float32BufferAttribute(ids, 1));
    const original = source.material as THREE.MeshStandardMaterial;
    if (original.transparent && original.alphaTest === 0) throw new Error('首版只接受不透明/alpha-test材质；透明材质需要明确遮挡分类');
    const base = new THREE.MeshBasicMaterial({ color: original.color, map: original.map ?? null, side: original.side,
      vertexColors: original.vertexColors, alphaTest: original.alphaTest, opacity: original.opacity, depthWrite: true, transparent: false });
    if ((original.map?.channel ?? 0) !== 0) throw new Error('The shared RGB/depth material supports TEXCOORD_0 only');
    if (geometry.getAttribute('color')?.itemSize === 4 || original.alphaMap) throw new Error('Vertex alpha and separate alphaMap require an explicit shared depth material');
    if (original.map?.matrixAutoUpdate) original.map.updateMatrix();
    const depthUniforms = { baseMap: { value: original.map ?? this.white }, uvTransform: { value: original.map?.matrix ?? new THREE.Matrix3() },
      alphaCut: { value: original.alphaTest }, opacityValue: { value: original.opacity } };
    const material = (field: string) => new THREE.ShaderMaterial({ uniforms: depthUniforms, vertexShader: depthVertex,
      fragmentShader: depthFragment.replace('OUTPUT', field), side: original.side, depthTest: true, depthWrite: true,
      blending: THREE.NoBlending, toneMapped: false, polygonOffset: false });
    const fusion = base.clone();
    fusion.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 faceNormal;varying vec3 arPosition;varying vec3 arNormal;')
        .replace('#include <project_vertex>', '#include <project_vertex>\narPosition=(modelMatrix*vec4(transformed,1.)).xyz;arNormal=mat3(modelMatrix)*faceNormal;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + fusionDeclarations)
        .replace('#include <opaque_fragment>', fusionFragment + '\n#include <opaque_fragment>');
    };
    fusion.customProgramCacheKey = () => 'ar-v2-fixed-mesh-projection-v1';
    const mesh = new THREE.Mesh(geometry, base); mesh.frustumCulled = false;
    this.scene.add(mesh); this.entries.push({ mesh, base, depth: material('vZ'), id: material('floor(vId+0.5)'), fusion });
  }
  private target(width: number, height: number) {
    const result = new THREE.WebGLRenderTarget(width, height, { format: THREE.RedFormat, type: THREE.FloatType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true, stencilBuffer: false, samples: 0 });
    result.texture.internalFormat = 'R32F'; return result;
  }
  renderDepth(spec: CameraSpec, target: THREE.WebGLRenderTarget, field: 'depth' | 'id' = 'depth') {
    const camera = opticalCamera(spec.K, spec.width, spec.height, spec.T_camera_from_scene);
    for (const e of this.entries) e.mesh.material = e[field];
    const background = this.scene.background; this.scene.background = null;
    this.renderer.setRenderTarget(target); this.renderer.setClearColor(0x000000, 0); this.renderer.clear(true, true, true);
    const gl = this.renderer.getContext();
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('R32F framebuffer 不完整');
    this.renderer.render(this.scene, camera); this.renderer.setRenderTarget(null); this.scene.background = background;
  }
  reference(spec: CameraSpec) {
    const camera = opticalCamera(spec.K, spec.width, spec.height, spec.T_camera_from_scene);
    for (const e of this.entries) e.mesh.material = e.base;
    this.renderer.setRenderTarget(null); this.renderer.setSize(spec.width, spec.height, false); this.renderer.render(this.scene, camera);
    const rgb = this.renderer.domElement.toDataURL('image/png');
    const target = this.target(spec.width, spec.height), raw = new Float32Array(spec.width * spec.height);
    this.renderDepth(spec, target); this.renderer.readRenderTargetPixels(target, 0, 0, spec.width, spec.height, raw);
    const depth = rowFlip(raw, spec.width, spec.height);
    this.renderDepth(spec, target, 'id'); this.renderer.readRenderTargetPixels(target, 0, 0, spec.width, spec.height, raw);
    const ids = Uint32Array.from(rowFlip(raw, spec.width, spec.height), id => id > 0 ? Math.round(id) - 1 : 0xffffffff); target.dispose();
    for (const e of this.entries) e.mesh.material = e.base;
    return { rgb, depth, ids };
  }
  cancel() { this.token++; this.uniforms.arEnabled.value = false; this.committed = null; }
  async commit(frame: FrameImage, pose: Pose) {
    pose = structuredClone(pose);
    frame = { ...frame, time_base: structuredClone(frame.time_base) };
    const token = ++this.token;
    if (!['LOCALIZED', 'TRACKED'].includes(pose.status)) { this.cancel(); return false; }
    if (pose.geometry_version !== this.geometryVersion || !pose.source_video_hash || !pose.camera_profile_id || !pose.calibration_version || pose.original_frame_id == null || !pose.time_base || !Number.isInteger(pose.original_pts)) {
      this.cancel(); throw new Error('帧包的视频、标定或几何身份不匹配');
    }
    for (const key of ['width', 'height', 'source_video_hash', 'original_frame_id', 'original_pts', 'time_base', 'camera_profile_id', 'calibration_version'] as const) {
      if (JSON.stringify(frame[key]) !== JSON.stringify(pose[key])) { this.cancel(); throw new Error(`Frame/pose identity mismatch: ${key}`); }
    }
    const image = frame.image;
    const size = image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };
    if ((size.videoWidth || size.naturalWidth || size.width) !== frame.width || (size.videoHeight || size.naturalHeight || size.height) !== frame.height) {
      this.cancel(); throw new Error('Image dimensions differ from the calibrated frame');
    }
    const snapshot = document.createElement('canvas'); snapshot.width = pose.width; snapshot.height = pose.height;
    snapshot.getContext('2d')!.drawImage(image, 0, 0, pose.width, pose.height);
    const bitmap = await createImageBitmap(snapshot);
    if (token !== this.token) { bitmap.close(); return false; }
    const frozen = document.createElement('canvas'); frozen.width = pose.width; frozen.height = pose.height;
    frozen.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
    const texture = new THREE.CanvasTexture(frozen); texture.flipY = true; texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    let mask: THREE.Texture = this.white;
    if (frame.validMask) {
      const maskCanvas = document.createElement('canvas'); maskCanvas.width = frame.width; maskCanvas.height = frame.height;
      maskCanvas.getContext('2d')!.drawImage(frame.validMask, 0, 0);
      mask = new THREE.CanvasTexture(maskCanvas);
    }
    if (mask !== this.white) { mask.flipY = true; mask.generateMipmaps = false; mask.minFilter = THREE.NearestFilter; mask.magFilter = THREE.NearestFilter; }
    const slot = this.activeSlot === 0 ? 1 : 0;
    if (!this.targets[slot] || this.targets[slot].width !== pose.width || this.targets[slot].height !== pose.height) {
      this.targets[slot]?.dispose(); this.targets[slot] = this.target(pose.width, pose.height);
    }
    try { this.renderDepth(pose, this.targets[slot]); } catch (error) { texture.dispose(); if (mask !== this.white) mask.dispose(); this.cancel(); throw error; }
    const oldImage = this.uniforms.arImage.value, oldMask = this.uniforms.arMask.value;
    this.uniforms.arCamera.value.copy(checkedMatrix(pose.T_camera_from_scene));
    this.uniforms.arK.value.set(pose.K[0], pose.K[4], pose.K[2], pose.K[5]); this.uniforms.arSize.value.set(pose.width, pose.height);
    this.uniforms.arImage.value = texture; this.uniforms.arMask.value = mask; this.uniforms.arDepth.value = this.targets[slot].texture;
    this.activeSlot = slot; this.committed = structuredClone(pose); this.uniforms.arEnabled.value = true;
    oldImage?.dispose(); if (oldMask && oldMask !== this.white) oldMask.dispose();
    for (const e of this.entries) e.mesh.material = e.fusion;
    return true;
  }
  render(camera: THREE.Camera, width: number, height: number) {
    for (const e of this.entries) e.mesh.material = this.uniforms.arEnabled.value ? e.fusion : e.base;
    this.renderer.setRenderTarget(null); this.renderer.setSize(width, height, false); this.renderer.render(this.scene, camera);
  }
  dispose() { this.cancel(); for (const e of this.entries) { e.mesh.geometry.dispose(); e.base.dispose(); e.depth.dispose(); e.id.dispose(); e.fusion.dispose(); }
    this.targets.forEach(target => target.dispose()); this.white.dispose(); this.renderer.dispose(); }
}
