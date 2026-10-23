// A small glTF 2.0 writer. Geometry is already tessellated by SketchUp's SDK.
// No SKP file parsing is implemented here.
const INCH_TO_METRE = 0.0254;
export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4; const col = Math.floor(i / 4);
    return a[row] * b[col * 4] + a[row + 4] * b[col * 4 + 1] + a[row + 8] * b[col * 4 + 2] + a[row + 12] * b[col * 4 + 3];
  });
}

export function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) throw new Error('模型包含无效的组件变换');
  const result = [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
  ];
  if (result.some((value) => !Number.isFinite(value))) throw new Error('模型包含非有限坐标');
  return result;
}

function determinant(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

function transformNormal(m, n) {
  const d = determinant(m);
  if (Math.abs(d) < 1e-15) throw new Error('模型包含零缩放组件');
  const [x, y, z] = n;
  // Inverse transpose, including SketchUp's homogeneous scale in m[15].
  const nx = ((m[5] * m[10] - m[6] * m[9]) * x + (m[2] * m[9] - m[1] * m[10]) * y + (m[1] * m[6] - m[2] * m[5]) * z) * m[15] / d;
  const ny = ((m[6] * m[8] - m[4] * m[10]) * x + (m[0] * m[10] - m[2] * m[8]) * y + (m[2] * m[4] - m[0] * m[6]) * z) * m[15] / d;
  const nz = ((m[4] * m[9] - m[5] * m[8]) * x + (m[1] * m[8] - m[0] * m[9]) * y + (m[0] * m[5] - m[1] * m[4]) * z) * m[15] / d;
  const length = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error('模型包含无效法向量');
  return [nx / length, nz / length, -ny / length];
}

function colourChannel(value) {
  const srgb = Math.max(0, Math.min(1, value));
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export class GlbWriter {
  constructor({ maxTriangles = 5_000_000 } = {}) {
    this.maxTriangles = maxTriangles;
    this.triangles = 0;
    this.batches = new Map();
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }

  addFace(mesh, matrix, material, { back = false, doubleSided = true } = {}) {
    const positions = mesh.positions;
    const normals = mesh.normals;
    const uv = back ? mesh.backUV : mesh.frontUV;
    if (positions.length % 3 || normals.length !== positions.length || mesh.indices.length % 3) throw new Error('SDK 返回的网格数据不完整');
    this.triangles += mesh.indices.length / 3;
    if (this.triangles > this.maxTriangles) throw new Error(`模型超过 ${this.maxTriangles.toLocaleString('en-US')} 个三角面，请先拆分模型后导入`);
    const key = `${material.key}:${doubleSided}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { material, doubleSided, positions: [], normals: [], uv: [] };
      this.batches.set(key, batch);
    }
    const mirrored = determinant(matrix) / matrix[15] ** 3 < 0;
    const reverse = mirrored !== back;
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const ids = reverse ? [mesh.indices[index], mesh.indices[index + 2], mesh.indices[index + 1]] : mesh.indices.slice(index, index + 3);
      for (const id of ids) {
        if (!Number.isSafeInteger(id) || id < 0 || id * 3 + 2 >= positions.length) throw new Error('SDK 返回的网格索引越界');
        const offset = id * 3;
        const p = transformPoint(matrix, positions.slice(offset, offset + 3));
        // SketchUp: Z-up/inches. glTF: Y-up/metres. This rotation preserves handedness.
        const world = [p[0] * INCH_TO_METRE, p[2] * INCH_TO_METRE, -p[1] * INCH_TO_METRE];
        world.forEach((value, axis) => { this.min[axis] = Math.min(this.min[axis], value); this.max[axis] = Math.max(this.max[axis], value); });
        batch.positions.push(...world);
        const normal = transformNormal(matrix, normals.slice(offset, offset + 3));
        batch.normals.push(...normal.map((value) => back ? -value : value));
        if (material.image) {
          if (!uv || uv.length !== positions.length) throw new Error('贴图缺少对应的 UV 坐标，已停止转换以免生成错贴模型');
          const q = uv[offset + 2];
          if (!Number.isFinite(q) || Math.abs(q) < 1e-12) throw new Error('模型包含无效的贴图坐标');
          const st = [uv[offset] / q, 1 - uv[offset + 1] / q];
          if (st.some((value) => !Number.isFinite(value))) throw new Error('模型包含非有限贴图坐标');
          batch.uv.push(...st);
        }
      }
    }
  }

  finish(name = 'SketchUp model') {
    if (!this.triangles) throw new Error('SKP 中没有可显示的面；只有线条或隐藏对象的模型无法放置');
    // Anchor the footprint centre at the model's lowest visible surface. Large
    // survey coordinates are subtracted BEFORE float32 conversion to keep detail.
    const anchor = [(this.min[0] + this.max[0]) / 2, this.min[1], (this.min[2] + this.max[2]) / 2];
    const buffers = []; let byteLength = 0;
    const doc = { asset: { version: '2.0', generator: 'Cesium standalone SketchUp C SDK bridge' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }], meshes: [{ primitives: [] }], materials: [], accessors: [], bufferViews: [], buffers: [], extras: { placementAnchor: 'bottom-centre', originalAnchorMetresYUp: anchor, triangleCount: this.triangles } };
    const addBuffer = (data, target) => {
      const padding = (4 - byteLength % 4) % 4;
      if (padding) { buffers.push(Buffer.alloc(padding)); byteLength += padding; }
      const id = doc.bufferViews.length;
      doc.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, ...(target ? { target } : {}) });
      buffers.push(data); byteLength += data.length;
      return id;
    };
    const addFloats = (values, width, bounds = false) => {
      const data = Buffer.alloc(values.length * 4);
      const min = Array(width).fill(Infinity); const max = Array(width).fill(-Infinity);
      values.forEach((value, index) => {
        const rounded = Math.fround(value);
        if (!Number.isFinite(rounded)) throw new Error('模型坐标过大，不能转换为 GLB');
        data.writeFloatLE(rounded, index * 4);
        min[index % width] = Math.min(min[index % width], rounded); max[index % width] = Math.max(max[index % width], rounded);
      });
      const id = doc.accessors.length;
      doc.accessors.push({ bufferView: addBuffer(data, 34962), componentType: 5126, count: values.length / width, type: `VEC${width}`, ...(bounds ? { min, max } : {}) });
      return id;
    };
    const imageCache = new Map();
    for (const batch of this.batches.values()) {
      if (!batch.positions.length) continue;
      batch.positions = batch.positions.map((value, index) => value - anchor[index % 3]);
      const { material } = batch;
      const rgba = material.rgba ?? [0.72, 0.74, 0.78, 1];
      const pbr = { baseColorFactor: [...(material.image ? [1, 1, 1] : rgba.slice(0, 3).map(colourChannel)), rgba[3]], metallicFactor: 0, roughnessFactor: 0.9 };
      if (material.image) {
        doc.images ??= []; doc.textures ??= []; doc.samplers ??= [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
        let texture = imageCache.get(material.imageKey ?? material.key);
        if (texture === undefined) {
          const image = doc.images.length;
          doc.images.push({ bufferView: addBuffer(material.image), mimeType: 'image/png' });
          texture = doc.textures.length; doc.textures.push({ source: image, sampler: 0 });
          imageCache.set(material.imageKey ?? material.key, texture);
        }
        pbr.baseColorTexture = { index: texture };
      }
      const materialId = doc.materials.length;
      doc.materials.push({ pbrMetallicRoughness: pbr, doubleSided: batch.doubleSided, alphaMode: rgba[3] < 1 || material.transparent ? 'BLEND' : 'OPAQUE' });
      const attributes = { POSITION: addFloats(batch.positions, 3, true), NORMAL: addFloats(batch.normals, 3) };
      if (material.image) attributes.TEXCOORD_0 = addFloats(batch.uv, 2);
      doc.meshes[0].primitives.push({ attributes, material: materialId, mode: 4 });
    }
    doc.buffers.push({ byteLength });
    const jsonRaw = Buffer.from(JSON.stringify(doc));
    const json = Buffer.concat([jsonRaw, Buffer.alloc((4 - jsonRaw.length % 4) % 4, 0x20)]);
    const bin = Buffer.concat([...buffers, Buffer.alloc((4 - byteLength % 4) % 4)]);
    const total = 12 + 8 + json.length + 8 + bin.length;
    if (total > 0xffff_ffff) throw new Error('转换结果超过 GLB 4GB 限制，请拆分模型');
    const header = Buffer.alloc(12); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
    const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(json.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
    return { bytes: Buffer.concat([header, jsonHeader, json, binHeader, bin]), metadata: doc.extras };
  }
}
