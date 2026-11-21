import * as Cesium from 'cesium';
import { ClippingPolygonCollection, Matrix4, PixelFormat, type ClippingPolygon } from 'cesium';
import { PRECISE_FRAGMENT_CLIPPING } from '../ownedClippingPolygons';
import { buildPreciseClippingGeometry } from './preciseGeometry';

type Texture = { width: number; destroy(): unknown; isDestroyed(): boolean };
type FrameState = { context: { uniformState?: { inverseView3D: Matrix4 } }; camera: { inverseViewMatrix: Matrix4 } };
type ShaderBuilder = {
  addDefine(name: string, value: undefined, destination: number): void;
  addUniform(type: string, name: string, destination: number): void;
  addVertexLines(source: string): void; addFragmentLines(source: string): void;
};
type Resources = { shaderBuilder: ShaderBuilder; uniformMap: Record<string, () => unknown> };
const renderer = Cesium as unknown as {
  Texture: new (options: object) => Texture;
  PixelDatatype: { FLOAT: number }; Sampler: { NEAREST: object };
  ContextLimits: { maximumTextureSize: number };
};

// Explicit samplers and a bounded traversal avoid ANGLE/D3D11's dynamic pixel
// executable compilation failure with sampler parameters and nested discard.
// No texture interpolation, angular packing, SDF atlas, or footprint dilation.
export const PRECISE_CLIPPING_FRAGMENT_SHADER = `
vec4 engineeringNode(int offset) {
    return texelFetch(engineeringClipNodes, ivec2(offset % engineeringClipNodeWidth, offset / engineeringClipNodeWidth), 0);
}
vec2 engineeringVertex(int offset) {
    return texelFetch(engineeringClipVertices, ivec2(offset % engineeringClipVertexWidth, offset / engineeringClipVertexWidth), 0).xy;
}
bool engineeringInsideRing(vec2 point, int start, int count) {
    vec2 a = engineeringVertex(start + count - 1);
    bool inside = false;
    for (int i = 0; i < count; i++) {
        vec2 b = engineeringVertex(start + i);
        if ((a.y > point.y) != (b.y > point.y)) {
            float crossing = a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y);
            if (point.x < crossing) inside = !inside;
        }
        a = b;
    }
    return inside;
}
bool engineeringInsideFootprint(vec2 point) {
    int node = 0;
    for (int step = 0; step < engineeringClipNodeCount; step++) {
        if (node >= engineeringClipNodeCount) break;
        vec4 bounds = engineeringNode(node * 2);
        vec4 meta = engineeringNode(node * 2 + 1);
        int escape = int(meta.x);
        if (any(lessThan(point, bounds.xy)) || any(greaterThan(point, bounds.zw))) {
            node = escape;
            continue;
        }
        int count = int(meta.z);
        if (count == 0) { node++; continue; }
        if (engineeringInsideRing(point, int(meta.y), count)) return true;
        node = escape;
    }
    return false;
}
void modelClippingPolygonsStage() {
    vec3 p = (engineeringClipFromEye * vec4(v_positionEC, 1.0)).xyz;
    float denominator = p.z - engineeringClipEarth.z;
    if (denominator > 0.0) {
        vec2 point = p.xy - p.z * (p.xy - engineeringClipEarth.xy) / denominator;
        if (engineeringInsideFootprint(point)) discard;
    }
}
`;

/** Exact rings in local metre coordinates. The inherited collection remains the
 * tileset's owned clipping object and keeps Cesium's bounding-volume decisions.
 * Only the guarded pipeline adapter consumes this private opt-in. */
export class PreciseClippingPolygonCollection extends ClippingPolygonCollection {
  private readonly geometry;
  private nodeTexture?: Texture;
  private vertexTexture?: Texture;
  private readonly fromEye = new Matrix4();

  constructor(polygons: ClippingPolygon[]) {
    super({ polygons, inverse: false, enabled: true });
    this.geometry = buildPreciseClippingGeometry(polygons.map(polygon => polygon.positions));
    Object.defineProperty(this, PRECISE_FRAGMENT_CLIPPING, { value: Object.freeze({
      process: (resources: Resources, _model: unknown, frameState: FrameState, destination: { BOTH: number; FRAGMENT: number }) => {
        const shader = resources.shaderBuilder;
        shader.addDefine('ENABLE_CLIPPING_POLYGONS', undefined, destination.BOTH);
        for (const [type, name] of [['highp sampler2D', 'engineeringClipNodes'], ['highp sampler2D', 'engineeringClipVertices'],
          ['mat4', 'engineeringClipFromEye'], ['vec3', 'engineeringClipEarth'], ['int', 'engineeringClipNodeCount'],
          ['int', 'engineeringClipNodeWidth'], ['int', 'engineeringClipVertexWidth']]) {
          shader.addUniform(type, name, destination.FRAGMENT);
        }
        shader.addVertexLines('void modelClippingPolygonsStage(inout ProcessedAttributes attributes) {}');
        shader.addFragmentLines(PRECISE_CLIPPING_FRAGMENT_SHADER);
        resources.uniformMap = { ...resources.uniformMap,
          engineeringClipNodes: () => this.nodeTexture,
          engineeringClipVertices: () => this.vertexTexture,
          // CPU double precision cancels the large ECEF translation before the
          // resulting local camera matrix is uploaded as a float uniform.
          engineeringClipFromEye: () => Matrix4.multiply(this.geometry.worldToLocal,
            frameState.context.uniformState?.inverseView3D ?? frameState.camera.inverseViewMatrix, this.fromEye),
          engineeringClipEarth: () => this.geometry.earth,
          engineeringClipNodeCount: () => this.geometry.nodeCount,
          engineeringClipNodeWidth: () => this.nodeTexture?.width,
          engineeringClipVertexWidth: () => this.vertexTexture?.width,
        };
      },
    }) });
  }

  private makeTexture(data: Float32Array, context: object): Texture {
    const max = renderer.ContextLimits.maximumTextureSize;
    const count = data.length / 4, width = Math.min(1024, max, count), height = Math.ceil(count / width);
    if (height > max || width < 1) throw new Error('工程裁剪纹理超过当前 GPU 容量。');
    const packed = new Float32Array(width * height * 4); packed.set(data);
    return new renderer.Texture({ context, width, height, pixelFormat: PixelFormat.RGBA,
      pixelDatatype: renderer.PixelDatatype.FLOAT, sampler: renderer.Sampler.NEAREST, flipY: false,
      source: { width, height, arrayBufferView: packed } });
  }

  // Cesium's runtime methods are private and omitted from its public d.ts. Their
  // calling convention is protected by the pinned engine/pipeline adapter.
  prepare(context: object): void {
    if (!this.nodeTexture) {
      const nodes = this.makeTexture(this.geometry.nodes, context);
      try { this.vertexTexture = this.makeTexture(this.geometry.vertices, context); }
      catch (error) { nodes.destroy(); throw error; }
      this.nodeTexture = nodes;
    }
    (this as unknown as { _extentsCount: number })._extentsCount = 1;
  }

  update(frameState: FrameState): void { this.prepare(frameState.context); }

  queueCommands(): void { /* Analytic clipping needs no SDF compute pass. */ }

  destroy(): void {
    this.nodeTexture?.destroy(); this.vertexTexture?.destroy();
    this.nodeTexture = undefined; this.vertexTexture = undefined;
    super.destroy();
  }
}
