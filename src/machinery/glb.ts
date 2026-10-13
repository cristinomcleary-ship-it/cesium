import { computeMachineryGeometry, resolveMachineryParameters, originalMachineryProportionsMaintained } from './engine';
import { createMachineryAppearance } from './appearance';
import type { LoadedMachineryAsset, MachineryParameters, MachineryResolveOptions, Vec3 } from './types';

/** Create a self-contained Y-up, metre GLB around the immutable ground placement anchor. */
export function createMachineryGlb(
  asset: LoadedMachineryAsset,
  parameters: Readonly<MachineryParameters>,
  options: MachineryResolveOptions = {},
): ArrayBuffer {
  // A saved snapshot must describe the mesh actually being exported. The empty
  // patch validates derived measurements without changing its shape or edit mode.
  const values = resolveMachineryParameters(asset, parameters, {}, options);
  const geometry = computeMachineryGeometry(asset, values);
  const source = new Float32Array(geometry.positions);
  for (const value of source) if (!Number.isFinite(value)) throw new RangeError('模型尺寸超出 GLB 可表示范围');
  if (asset.faceColorIndices.length * 3 !== geometry.indices.length || asset.palette.length % 3) throw new Error('模型颜色数量不一致');
  for (const value of asset.palette) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('模型颜色无效');
  for (const index of asset.faceColorIndices) if (index * 3 + 2 >= asset.palette.length) throw new Error('模型颜色索引无效');
  const appearance = createMachineryAppearance(asset);
  const faceCount = geometry.indices.length / 3;
  const kept = new Uint32Array(faceCount), faceNormals = new Float32Array(faceCount * 3);
  let keptCount = 0;
  for (let face = 0; face < faceCount; face++) {
    const ia = geometry.indices[face * 3] * 3, ib = geometry.indices[face * 3 + 1] * 3, ic = geometry.indices[face * 3 + 2] * 3;
    const ax = source[ib] - source[ia], ay = source[ib + 1] - source[ia + 1], az = source[ib + 2] - source[ia + 2];
    const bx = source[ic] - source[ia], by = source[ic + 1] - source[ia + 1], bz = source[ic + 2] - source[ia + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, length = Math.hypot(nx, ny, nz);
    // Original source is unchanged; zero-area triangles have no drawable surface.
    if (length === 0) continue;
    if (!Number.isFinite(length)) throw new Error('模型三角面无效');
    kept[keptCount] = face;
    faceNormals[keptCount * 3] = nx / length; faceNormals[keptCount * 3 + 1] = ny / length; faceNormals[keptCount * 3 + 2] = nz / length;
    keptCount++;
  }
  if (!keptCount) throw new RangeError('当前尺寸无法生成可显示的三角面');
  const positions = new Float32Array(keptCount * 9), normals = new Float32Array(keptCount * 9), colors = new Float32Array(keptCount * 9);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < keptCount; k++) {
    const face = kept[k], color = appearance.faceColorIndices[face] * 3;
    for (let corner = 0; corner < 3; corner++) {
      const src = geometry.indices[face * 3 + corner] * 3, dst = k * 9 + corner * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = source[src + axis];
        positions[dst + axis] = value; normals[dst + axis] = faceNormals[k * 3 + axis]; colors[dst + axis] = appearance.palette[color + axis];
        min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
      }
    }
  }
  const arrays = [positions, normals, colors];
  let byteOffset = 0;
  const bufferViews = arrays.map(array => {
    const view = { buffer: 0, byteOffset, byteLength: array.byteLength, target: 34962 };
    byteOffset += array.byteLength; return view;
  });
  const accessors = arrays.map((_array, index) => ({ bufferView: index, componentType: 5126, count: keptCount * 3, type: 'VEC3', ...(index === 0 ? { min, max } : {}) }));
  const gltf = {
    asset: { version: '2.0', generator: 'Cesium railway machinery parameter engine' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: asset.name, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, mode: 4, material: 0 }] }],
    materials: [{ name: 'Construction vivid colors with source material regions', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    buffers: [{ byteLength: byteOffset }], bufferViews, accessors,
    extras: {
      modelId: asset.id, assetVersion: asset.version, units: 'm', coordinateSystem: 'Y-up',
      placementAnchor: [0, 0, 0], originalSourceAnchor: geometry.sourceAnchor,
      forwardReference: '+X model reference axis; not a certified machine heading',
      parameters: values, editMode: options.proportional === false ? 'independent' : 'proportional',
      editModeMeaning: 'Rule for the next edit; toggling mode alone preserves the current shape',
      originalProportionsMaintained: originalMachineryProportionsMaintained(asset, values),
      sourceTriangleCount: faceCount, removedDegenerateTriangles: faceCount - keptCount,
      appearance: appearance.metadata,
      geometryOnly: true,
    },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(gltf)), jsonLength = (encoded.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonLength + 8 + byteOffset;
  const buffer = new ArrayBuffer(total), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(encoded, 20);
  const bin = 20 + jsonLength;
  view.setUint32(bin, byteOffset, true); view.setUint32(bin + 4, 0x004e4942, true);
  let cursor = bin + 8;
  for (const array of arrays) { bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), cursor); cursor += array.byteLength; }
  return buffer;
}
