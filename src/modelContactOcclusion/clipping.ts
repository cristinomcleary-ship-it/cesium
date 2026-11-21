import * as Cesium from 'cesium';
import { Cartesian3, ClippingPolygonCollection, Intersect, Matrix4, PixelFormat, type ClippingPolygon } from 'cesium';
import { PRECISE_FRAGMENT_CLIPPING } from '../ownedClippingPolygons';
import { PreciseClippingPolygonCollection } from '../engineeringComponents/preciseClipping';
import type { ContactVolume } from './types';

type Texture = { width: number; destroy(): unknown; isDestroyed(): boolean };
type FrameState = { context: { uniformState?: { inverseView3D: Matrix4; model?: Matrix4 } }; camera: { inverseViewMatrix: Matrix4 } };
type PhotographyModel = { modelMatrix: Matrix4; sceneGraph?: { components: { transform: Matrix4 } }; _sceneGraph?: { components: { transform: Matrix4 } } };
type ShaderBuilder = { addDefine(name: string, value: undefined, destination: number): void; addUniform(type: string, name: string, destination: number): void; addVertexLines(source: string): void; addFragmentLines(source: string): void };
type Resources = { shaderBuilder: ShaderBuilder; uniformMap: Record<string, () => unknown> };
type Destination = { BOTH: number; FRAGMENT: number };
type Hook = { process(resources: Resources, model: unknown, state: FrameState, destination: Destination): void };
const renderer = Cesium as unknown as {
  Texture: new (options: object) => Texture; PixelDatatype: { FLOAT: number }; Sampler: { NEAREST: object }; ContextLimits: { maximumTextureSize: number };
};

/** Every final test uses all three coordinates. Bounds only reject candidates;
 * leaf tests use original triangles, including concavity and disconnected gaps. */
export const CONTACT_FRAGMENT_SHADER = `
vec4 contactNode(int offset) {
    return texelFetch(contactNodes, ivec2(offset % contactNodeWidth, offset / contactNodeWidth), 0);
}
vec4 contactEntity(int offset) {
    return texelFetch(contactEntities, ivec2(offset % contactEntityWidth, offset / contactEntityWidth), 0);
}
vec3 contactVertex(int offset) {
    return texelFetch(contactTriangles, ivec2(offset % contactTriangleWidth, offset / contactTriangleWidth), 0).xyz;
}
float contactSegmentDistance2(vec3 p, vec3 a, vec3 b) {
    vec3 d = b - a;
    float n = dot(d,d);
    float t = n > 0.0 ? clamp(dot(p-a,d)/n,0.0,1.0) : 0.0;
    vec3 difference = p-a-t*d;
    return dot(difference,difference);
}
float contactTriangleDistance2(vec3 p, vec3 a, vec3 b, vec3 c) {
    vec3 ab=b-a, ac=c-a, n=cross(ab,ac), ap=p-a;
    float n2=dot(n,n);
    float edge=min(contactSegmentDistance2(p,a,b),min(contactSegmentDistance2(p,b,c),contactSegmentDistance2(p,c,a)));
    if (n2==0.0) return edge;
    float height=dot(ap,n);
    vec3 q=p-n*(height/n2);
    if (dot(cross(ab,q-a),n)>=0.0 && dot(cross(c-b,q-b),n)>=0.0 && dot(cross(a-c,q-c),n)>=0.0) return height*height/n2;
    return edge;
}
float contactEdge(vec3 a, vec3 b, vec3 p) {
    return (b.y-a.y)*(p.z-a.z)-(b.z-a.z)*(p.y-a.y);
}
bool contactOwnEdge(vec3 a, vec3 b, float value) {
    return value>0.0 || (value==0.0 && (b.z>a.z || (b.z==a.z && b.y<a.y)));
}
bool contactRayHit(vec3 p, vec3 a, vec3 b, vec3 c) {
    float area=(b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y);
    if (area==0.0) return false;
    if (area<0.0) { vec3 swap=b; b=c; c=swap; }
    float ea=contactEdge(b,c,p), eb=contactEdge(c,a,p), ec=contactEdge(a,b,p);
    if (!contactOwnEdge(b,c,ea) || !contactOwnEdge(c,a,eb) || !contactOwnEdge(a,b,ec)) return false;
    return (ea*a.x+eb*b.x+ec*c.x)/abs(area)>p.x;
}
bool contactPointBounds(vec3 p, vec3 low, vec3 high, float epsilon) {
    return all(greaterThanEqual(p,low-vec3(epsilon))) && all(lessThanEqual(p,high+vec3(epsilon)));
}
bool contactOneEntity(vec3 p, float epsilon, ivec4 contactLayout, int entityIndex) {
    vec4 entity=contactEntity(contactLayout.y+entityIndex);
    int node=int(entity.x), end=int(entity.y), crossings=0;
    bool solid=entity.z>0.5;
    for (int step=0;step<end-int(entity.x);step++) {
        if (node>=end) break;
        int index=(contactLayout.x+node)*3;
        vec4 low=contactNode(index), high=contactNode(index+1), meta=contactNode(index+2);
        bool surface=contactPointBounds(p,low.xyz,high.xyz,epsilon);
        bool ray=solid && p.x<=high.x && p.y>=low.y && p.y<=high.y && p.z>=low.z && p.z<=high.z;
        if (!surface && !ray) { node=int(low.w); continue; }
        int count=int(high.w);
        if (count==0) { node++; continue; }
        for (int i=0;i<count;i++) {
            int triangle=(contactLayout.z+int(meta.x)+i)*3;
            vec3 a=contactVertex(triangle),b=contactVertex(triangle+1),c=contactVertex(triangle+2);
            if (surface && contactTriangleDistance2(p,a,b,c)<=epsilon*epsilon) return true;
            if (ray && contactRayHit(p,a,b,c)) crossings++;
        }
        node=int(low.w);
    }
    return solid && (crossings % 2)==1;
}
bool contactModelContains(vec3 p,float epsilon,ivec4 contactLayout) {
    int node=0;
    for (int step=0;step<contactLayout.w;step++) {
        if (node>=contactLayout.w) break;
        int index=(contactLayout.x+node)*3;
        vec4 low=contactNode(index),high=contactNode(index+1),meta=contactNode(index+2);
        if (!contactPointBounds(p,low.xyz,high.xyz,epsilon)) { node=int(low.w); continue; }
        if (high.w==0.0) { node++; continue; }
        if (contactOneEntity(p,epsilon,contactLayout,int(meta.x))) return true;
        node=int(low.w);
    }
    return false;
}
`;

/** Owned composition: legacy footprints keep their existing 2D semantics while
 * engineering contributions are only finite 3D volumes/original surface contact.
 * No engineering footprint proxy is ever fed to the legacy fragment predicate. */
export class ContactClippingPolygonCollection extends ClippingPolygonCollection {
  private legacy?: PreciseClippingPolygonCollection;
  private textures?: [Texture, Texture, Texture];
  private readonly packed: [Float32Array, Float32Array, Float32Array];
  private readonly layouts: number[][];
  private readonly worldToLocal: Matrix4[];
  private readonly fromModel: Matrix4[];
  private readonly fromLegacyModel: Matrix4[];
  private readonly volumes: readonly ContactVolume[];

  constructor(legacyPolygons: ClippingPolygon[], volumes: readonly ContactVolume[]) {
    super({ polygons: legacyPolygons, inverse: false, enabled: true });
    if (!volumes.length || volumes.length > 32) throw new Error('三维接触集合需要 1–32 个完整模型贡献。');
    // Native length is a getter in the pinned runtime (declared as a field in
    // Cesium's d.ts). Volume-only contributions still activate its model stage;
    // no fictitious polygon is inserted into the actual geometry storage.
    Object.defineProperty(this, 'length', { get: () => Math.max(legacyPolygons.length, 1) });
    let nodes = 0, triangles = 0, entities = 0;
    for (const { geometry: g, worldFromLocal } of volumes) {
      if (worldFromLocal.length !== 16 || worldFromLocal.some(v => !Number.isFinite(v)) || g.nodes.length % 12 || g.triangles.length % 12 || g.entities.length % 4
        || !g.nodes.length || !g.triangles.length || !g.entities.length || g.stats.sourceTriangles !== g.stats.packedTriangles || g.stats.packedTriangles !== g.triangles.length / 12) throw new Error('三维接触贡献不完整，未创建裁剪集合。');
      nodes += g.nodes.length; triangles += g.triangles.length; entities += g.entities.length;
    }
    if (triangles / 12 > 6_000_000 || nodes / 12 >= 2 ** 24) throw new Error('合并三维接触超过完整 GPU 几何预算，未截断贡献。');
    this.volumes = volumes.map(value => ({ geometry: value.geometry, worldFromLocal: [...value.worldFromLocal] }));
    this.packed = [new Float32Array(nodes), new Float32Array(triangles), new Float32Array(entities)];
    this.layouts = []; this.worldToLocal = []; this.fromModel = []; this.fromLegacyModel = [];
    let n = 0, t = 0, e = 0;
    for (const volume of this.volumes) {
      const g = volume.geometry;
      this.layouts.push([n / 12, e / 4, t / 12, g.entityTreeEnd]);
      this.packed[0].set(g.nodes, n); this.packed[1].set(g.triangles, t); this.packed[2].set(g.entities, e);
      n += g.nodes.length; t += g.triangles.length; e += g.entities.length;
      const world = Matrix4.fromArray(volume.worldFromLocal as number[]), shifted = Matrix4.multiplyByTranslation(world, new Cartesian3(...g.origin), new Matrix4());
      const determinant = shifted[0] * (shifted[5] * shifted[10] - shifted[9] * shifted[6])
        - shifted[4] * (shifted[1] * shifted[10] - shifted[9] * shifted[2]) + shifted[8] * (shifted[1] * shifted[6] - shifted[5] * shifted[2]);
      if (Math.abs(determinant) < 1e-30) throw new Error('三维接触模型变换不可逆。');
      this.worldToLocal.push(Matrix4.inverse(shifted, new Matrix4())); this.fromModel.push(new Matrix4()); this.fromLegacyModel.push(new Matrix4());
    }
    if (legacyPolygons.length) this.legacy = new PreciseClippingPolygonCollection(legacyPolygons);
    Object.defineProperty(this, PRECISE_FRAGMENT_CLIPPING, { value: Object.freeze({
      process: (resources: Resources, model: unknown, state: FrameState, destination: Destination) => this.process(resources, model, state, destination),
    }) });
  }

  private process(resources: Resources, model: unknown, state: FrameState, destination: Destination) {
    const shader = resources.shaderBuilder;
    shader.addDefine('ENABLE_CLIPPING_POLYGONS', undefined, destination.BOTH);
    shader.addVertexLines('void modelClippingPolygonsStage(inout ProcessedAttributes attributes) {}');
    if (this.legacy) {
      const wrapper: Resources = { uniformMap: resources.uniformMap, shaderBuilder: {
        addDefine() {}, addVertexLines() {},
        addUniform: (...args) => shader.addUniform(...args),
        addFragmentLines: source => shader.addFragmentLines(source.replace('void modelClippingPolygonsStage()', 'void contactLegacyClip()')),
      } };
      (this.legacy as unknown as Record<string, Hook>)[PRECISE_FRAGMENT_CLIPPING].process(wrapper, model, state, destination);
      resources.uniformMap = wrapper.uniformMap;
    }
    for (const [type, name] of [['highp sampler2D', 'contactNodes'], ['highp sampler2D', 'contactTriangles'], ['highp sampler2D', 'contactEntities'],
      ['int', 'contactNodeWidth'], ['int', 'contactTriangleWidth'], ['int', 'contactEntityWidth']]) shader.addUniform(type, name, destination.FRAGMENT);
    resources.uniformMap = { ...resources.uniformMap, contactNodes: () => this.textures?.[0], contactTriangles: () => this.textures?.[1], contactEntities: () => this.textures?.[2],
      contactNodeWidth: () => this.textures?.[0].width, contactTriangleWidth: () => this.textures?.[1].width, contactEntityWidth: () => this.textures?.[2].width };
    const lines = [CONTACT_FRAGMENT_SHADER, 'void modelClippingPolygonsStage() {'];
    if (this.legacy) lines.push('contactLegacyClip();');
    this.volumes.forEach((volume, i) => {
      shader.addUniform('mat4', `contactFromModel${i}`, destination.FRAGMENT);
      shader.addUniform('mat4', `contactFromLegacyModel${i}`, destination.FRAGMENT);
      shader.addUniform('float', `contactEpsilon${i}`, destination.FRAGMENT);
      // v_positionMC is already available after Cesium's instance, skin/morph
      // and custom-vertex stages. Compose world transforms in CPU doubles so a
      // far camera never enters the contact calculation. Transforming EC back
      // into local coordinates loses coplanarity through float cancellation.
      resources.uniformMap[`contactFromModel${i}`] = () => {
        const drawModel = state.context.uniformState?.model;
        if (!drawModel) throw new Error('当前绘制缺少模型矩阵，无法计算实际接触。');
        return Matrix4.multiply(this.worldToLocal[i], drawModel, this.fromModel[i]);
      };
      resources.uniformMap[`contactFromLegacyModel${i}`] = () => {
        // LegacyInstancingStageVS already folds instance * axis * node into
        // positionMC, and uses this modified root matrix instead of czm_model.
        const photography = model as PhotographyModel, graph = photography.sceneGraph ?? photography._sceneGraph;
        if (!photography.modelMatrix || !graph?.components.transform) throw new Error('摄影实例根变换未就绪。');
        const root = Matrix4.multiply(photography.modelMatrix, graph.components.transform, this.fromLegacyModel[i]);
        return Matrix4.multiply(this.worldToLocal[i], root, root);
      };
      resources.uniformMap[`contactEpsilon${i}`] = () => volume.geometry.numericalTolerance;
      lines.push(`#ifdef USE_LEGACY_INSTANCING
vec3 contactPoint${i} = (contactFromLegacyModel${i} * vec4(v_positionMC,1.0)).xyz;
#else
vec3 contactPoint${i} = (contactFromModel${i} * vec4(v_positionMC,1.0)).xyz;
#endif
if (contactModelContains(contactPoint${i}, contactEpsilon${i}, ivec4(${this.layouts[i].join(',')}))) discard;`);
    });
    lines.push('}'); shader.addFragmentLines(lines.join('\n'));
  }

  private texture(data: Float32Array, context: object): Texture {
    const max = renderer.ContextLimits.maximumTextureSize, count = data.length / 4, width = Math.min(1024, max, count), height = Math.ceil(count / width);
    if (width < 1 || height > max) throw new Error('三维接触纹理超过当前 GPU 容量，原有效集合应保持。');
    const packed = new Float32Array(width * height * 4); packed.set(data);
    return new renderer.Texture({ context, width, height, pixelFormat: PixelFormat.RGBA, pixelDatatype: renderer.PixelDatatype.FLOAT,
      sampler: renderer.Sampler.NEAREST, flipY: false, source: { width, height, arrayBufferView: packed } });
  }

  /** Complete all allocations before the shared owner replaces its live object. */
  prepare(context: object): void {
    if (!this.textures) {
      const allocated: Texture[] = [];
      try { for (const data of this.packed) allocated.push(this.texture(data, context)); this.legacy?.prepare(context); }
      catch (error) { for (const texture of allocated) if (!texture.isDestroyed()) texture.destroy(); throw error; }
      this.textures = allocated as [Texture, Texture, Texture];
    }
    (this as unknown as { _extentsCount: number })._extentsCount = 1;
  }
  update(frameState: FrameState): void { this.prepare(frameState.context); }
  queueCommands(): void { /* Analytic 3D contact and legacy rings use no SDF pass. */ }
  computeIntersectionWithBoundingVolume(): Intersect { return Intersect.INTERSECTING; }
  destroy(): void {
    if (this.textures) for (const texture of this.textures) if (!texture.isDestroyed()) texture.destroy();
    this.textures = undefined; this.legacy?.destroy(); this.legacy = undefined; super.destroy();
  }
}
