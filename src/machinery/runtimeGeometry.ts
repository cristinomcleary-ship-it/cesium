import { Cartesian3, CustomShader, Matrix3, Matrix4, Quaternion, UniformType } from 'cesium';
import { createMachineryAppearance } from './appearance';
import type { LoadedMachineryAsset, MachineryParameters, Vec3 } from './types';

type RuntimeData = { motion: Float64Array; sourceRadius: number; anchorLength: number; normalizedRadius: number };
type Pose = { matrices: Matrix4[]; slew: Matrix4; delta: Cartesian3; scale: number; bound: number };
const cache = new WeakMap<LoadedMachineryAsset, RuntimeData>();
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const vector = (v: readonly number[]) => new Cartesian3(v[0], v[1], v[2]);
const sum = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const difference = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Encode exactly the source engine's order of per-vertex assignments once.
 * xyz are length/lateral/longitudinal coefficients; w is elevation group + 16*slew. */
function dataFor(asset: LoadedMachineryAsset): RuntimeData {
  let data = cache.get(asset); if (data) return data;
  const count = asset.sourcePositions.length / 3, motion = new Float64Array(count * 4);
  const config = asset.config, source = asset.sourcePositions, anchor = config.reference_dimensions.anchor_m;
  let sourceRadius = 0, normalizedRadius = 1;
  for (let i = 0; i < count; i++) {
    const p = source.subarray(i * 3, i * 3 + 3);
    sourceRadius = Math.max(sourceRadius, Math.hypot(...p));
    normalizedRadius = Math.max(normalizedRadius, ...p.map((v, k) => Math.abs(v - anchor[k])));
  }
  if (config.type === 'crane') {
    const fixed = new Set(config.elevation.rigging_extension_fixed_vertex_indices), boom = config.boom;
    for (let i = 0; i < count; i++) {
      const part = asset.partIds[i], n = i * 3, x = source[n], y = source[n + 1], z = source[n + 2];
      if (part >= 1 && part <= 3) {
        const start = part === 3 ? boom.root_projection_m : boom.extension_anchor_projection_m;
        motion[i * 4] = part === 2 ? 1 : part === 3 ? fixed.has(i) ? 0 : 1
          : clamp((x * boom.axis[0] + y * boom.axis[1] + z * boom.axis[2] - start) / (boom.tip_projection_m - start));
      } else if ((part >= 10 && part <= 13) || (part >= 20 && part <= 23)) {
        const leg = config.outriggers.legs[part % 10];
        const weight = part < 20 ? 1 : clamp((z - leg.beam_inner_z_m) / (leg.beam_outer_z_m - leg.beam_inner_z_m));
        motion[i * 4 + 1] = leg.lateral_sign * 0.5 * weight;
        motion[i * 4 + 2] = leg.longitudinal_sign * 0.5 * weight;
      }
    }
    const assign = (ranges: readonly (readonly [number, number])[], mode: number) => {
      for (const [start, length] of ranges) for (let i = start; i < start + length; i++) motion[i * 4 + 3] = mode;
    };
    const e = config.elevation;
    assign(e.boom_vertex_ranges, 1); assign(e.hanging_vertex_ranges, 2);
    for (const i of e.rope_upper_vertex_indices) motion[i * 4 + 3] = 1;
    for (const i of e.rope_lower_vertex_indices) motion[i * 4 + 3] = 2;
    assign(e.rigging_vertex_ranges, 1);
    for (const i of e.rigging_fixed_vertex_indices) motion[i * 4 + 3] = 0;
    if (e.hydraulics.length > 2) throw new Error('当前实时机械着色器最多支持两组液压缸');
    e.hydraulics.forEach((c, index) => { assign(c.barrel_vertex_ranges, 3 + index * 2); assign(c.rod_vertex_ranges, 4 + index * 2); });
    for (const [start, length] of config.rotation.vertex_ranges) for (let i = start; i < start + length; i++) motion[i * 4 + 3] += 16;
  } else if (config.type === 'pile_rig') {
    for (let i = 0; i < count; i++) motion[i * 4] = asset.partIds[i] === 1
      ? (source[i * 3 + 1] - config.fixed_bottom_upper_y_m) / config.adjustable_default_span_m : asset.partIds[i] === 2 ? 1 : 0;
  }
  data = { motion, sourceRadius, anchorLength: Math.hypot(...anchor), normalizedRadius };
  cache.set(asset, data); return data;
}

function pivotRotation(axis: Vec3, angle: number, from: Vec3, to = from): Matrix4 {
  const rotation = Matrix3.fromQuaternion(Quaternion.fromAxisAngle(vector(axis), angle, new Quaternion()));
  const rotated = Matrix3.multiplyByVector(rotation, vector(from), new Cartesian3());
  return Matrix4.fromRotationTranslation(rotation, Cartesian3.subtract(vector(to), rotated, new Cartesian3()));
}

/** Small matrix/uniform calculation only; no per-frame vertex walk or GLB allocation. */
function poseFor(asset: LoadedMachineryAsset, p: Readonly<MachineryParameters>): Pose {
  const config = asset.config, data = dataFor(asset);
  const matrices = Array.from({ length: 7 }, () => Matrix4.clone(Matrix4.IDENTITY));
  let slew = Matrix4.clone(Matrix4.IDENTITY), delta = new Cartesian3(), displacement = 0;
  if (config.type === 'crane') {
    const e = config.elevation, radians = (p.boom_elevation_deg - e.original_degrees) * Math.PI / 180;
    delta = new Cartesian3(p.boom_length_m / p.overall_scale - config.boom.original_length_m,
      p.outrigger_lateral_m / p.overall_scale - config.outriggers.original_lateral_m,
      p.outrigger_longitudinal_m / p.overall_scale - config.outriggers.original_longitudinal_m);
    matrices[1] = pivotRotation(e.axis, radians, e.hinge_m);
    const attachment = sum(e.hanging_attachment_m, config.boom.axis.map(v => v * delta.x));
    const target = Matrix4.multiplyByPoint(matrices[1], vector(attachment), new Cartesian3());
    matrices[2] = Matrix4.fromTranslation(Cartesian3.subtract(target, vector(attachment), new Cartesian3()));
    e.hydraulics.forEach((c, index) => {
      const after = Matrix4.multiplyByPoint(matrices[1], vector(c.attachment_m), new Cartesian3());
      const beforeDirection = Cartesian3.normalize(vector(difference(c.attachment_m, c.base_m)), new Cartesian3());
      const afterDirection = Cartesian3.subtract(after, vector(c.base_m), new Cartesian3());
      if (Cartesian3.magnitude(afterDirection) < 1e-9) throw new RangeError('吊臂姿态使液压缸两铰点重合');
      Cartesian3.normalize(afterDirection, afterDirection);
      const cross = Cartesian3.cross(beforeDirection, afterDirection, new Cartesian3()), length = Cartesian3.magnitude(cross);
      const axis = length > 1e-12 ? [cross.x / length, cross.y / length, cross.z / length] as Vec3 : e.axis;
      const angle = Math.atan2(length, Math.max(-1, Math.min(1, Cartesian3.dot(beforeDirection, afterDirection))));
      matrices[3 + index * 2] = pivotRotation(axis, angle, c.base_m);
      matrices[4 + index * 2] = pivotRotation(axis, angle, c.attachment_m, [after.x, after.y, after.z]);
    });
    // rotateCraneSource maps +X toward +Z for clockwise compass slew.
    slew = pivotRotation([0, 1, 0], -p.boom_rotation_deg * Math.PI / 180, config.rotation.pivot_m);
    displacement = Math.abs(delta.x) + (Math.abs(delta.y) + Math.abs(delta.z)) / 2;
  } else if (config.type === 'pile_rig') {
    delta.x = p.total_height_m / p.overall_scale - config.default_total_height_m;
    // Some source vertices may lie slightly beyond the nominal mast span.
    displacement = Math.abs(delta.x) * 2;
  }
  const translationLength = (m: Matrix4) => Math.hypot(m[12], m[13], m[14]);
  const bound = Math.max(1, (data.sourceRadius + displacement + Math.max(...matrices.map(translationLength))
    + translationLength(slew) + data.anchorLength) * p.overall_scale * 1.05);
  return { matrices, slew, delta, scale: p.overall_scale, bound };
}

/** Mirrors the shader using doubles; tests compare every source vertex with the authoritative engine. */
export function evaluateMachineryRuntimePositions(asset: LoadedMachineryAsset, p: Readonly<MachineryParameters>): Float64Array {
  const data = dataFor(asset), pose = poseFor(asset, p), anchor = vector(asset.config.reference_dimensions.anchor_m);
  const output = new Float64Array(asset.sourcePositions.length), point = new Cartesian3();
  for (let i = 0; i < output.length / 3; i++) {
    point.x = asset.sourcePositions[i * 3]; point.y = asset.sourcePositions[i * 3 + 1]; point.z = asset.sourcePositions[i * 3 + 2];
    const m = data.motion.subarray(i * 4, i * 4 + 4);
    if (asset.config.type === 'crane') {
      const axis = asset.config.boom.axis;
      point.x += axis[0] * pose.delta.x * m[0] + pose.delta.z * m[2];
      point.y += axis[1] * pose.delta.x * m[0];
      point.z += axis[2] * pose.delta.x * m[0] + pose.delta.y * m[1];
      Matrix4.multiplyByPoint(pose.matrices[Math.round(m[3]) % 16], point, point);
      if (m[3] >= 16) Matrix4.multiplyByPoint(pose.slew, point, point);
    } else if (asset.config.type === 'pile_rig') point.y += pose.delta.x * m[0];
    Cartesian3.subtract(point, anchor, point); Cartesian3.multiplyByScalar(point, pose.scale, point);
    output.set([point.x, point.y, point.z], i * 3);
  }
  return output;
}

/** One immutable topology per asset instance, including collapsed source triangles.
 * Zero-area guard triangles define a truthful unit bounds volume. Public model.scale
 * tracks a finite pose bound, while the shader cancels that scale on actual geometry. */
export function createMachineryRuntimeGlb(asset: LoadedMachineryAsset): ArrayBuffer {
  const data = dataFor(asset), appearance = createMachineryAppearance(asset), anchor = asset.config.reference_dimensions.anchor_m;
  const count = asset.indices.length + 6, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), motions = new Float32Array(count * 4);
  for (let i = 0; i < asset.indices.length; i++) {
    const index = asset.indices[i], color = appearance.faceColorIndices[Math.floor(i / 3)] * 3;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = (asset.sourcePositions[index * 3 + k] - anchor[k]) / data.normalizedRadius;
      colors[i * 3 + k] = appearance.palette[color + k];
    }
    motions.set(data.motion.subarray(index * 4, index * 4 + 4), i * 4);
  }
  for (let i = asset.indices.length; i < count; i++) {
    positions.fill(i < asset.indices.length + 3 ? -1 : 1, i * 3, i * 3 + 3);
    motions[i * 4 + 3] = -1;
  }
  const arrays = [positions, colors, motions]; let offset = 0;
  const bufferViews = arrays.map(a => { const view = { buffer: 0, byteOffset: offset, byteLength: a.byteLength, target: 34962 }; offset += a.byteLength; return view; });
  const gltf = {
    asset: { version: '2.0', generator: 'Cesium machinery persistent parameter geometry' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: asset.name, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1, _MOTION: 2 }, mode: 4, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    buffers: [{ byteLength: offset }], bufferViews,
    accessors: arrays.map((_, i) => ({ bufferView: i, componentType: 5126, count, type: i === 2 ? 'VEC4' : 'VEC3', ...(i === 0 ? { min: [-1, -1, -1], max: [1, 1, 1] } : {}) })),
    extras: { modelId: asset.id, assetVersion: asset.version, runtimeGeometry: true, units: 'm', normalizedRadius: data.normalizedRadius,
      sourceTriangleCount: asset.indices.length / 3, geometryOnly: true },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(gltf)), jsonLength = (encoded.byteLength + 3) & ~3;
  const buffer = new ArrayBuffer(28 + jsonLength + offset), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.fill(32, 20, 20 + jsonLength); bytes.set(encoded, 20);
  const bin = 20 + jsonLength; view.setUint32(bin, offset, true); view.setUint32(bin + 4, 0x004e4942, true);
  let cursor = bin + 8;
  for (const a of arrays) { bytes.set(new Uint8Array(a.buffer), cursor); cursor += a.byteLength; }
  return buffer;
}

export function createMachineryRuntimeShader(asset: LoadedMachineryAsset): CustomShader {
  const data = dataFor(asset);
  const uniforms = {
    u_anchor: { type: UniformType.VEC3, value: vector(asset.config.reference_dimensions.anchor_m) },
    u_axis: { type: UniformType.VEC3, value: vector(asset.config.type === 'crane' ? asset.config.boom.axis : [0, 1, 0]) },
    u_normalizedRadius: { type: UniformType.FLOAT, value: data.normalizedRadius },
    u_delta: { type: UniformType.VEC3, value: new Cartesian3() }, u_scale: { type: UniformType.FLOAT, value: 1 },
    u_bound: { type: UniformType.FLOAT, value: 1 }, u_slew: { type: UniformType.MAT4, value: Matrix4.clone(Matrix4.IDENTITY) },
    ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`u_pose${i}`, { type: UniformType.MAT4, value: Matrix4.clone(Matrix4.IDENTITY) }])),
  };
  return new CustomShader({ uniforms,
    vertexShaderText: `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
        vec4 motion = vsInput.attributes.motion;
        if (motion.w < -0.5) { vsOutput.positionMC = vsInput.attributes.positionMC; return; }
        vec3 point = vsInput.attributes.positionMC * u_normalizedRadius + u_anchor;
        ${asset.config.type === 'crane' ? `
        point += u_axis * u_delta.x * motion.x + vec3(u_delta.z * motion.z, 0.0, u_delta.y * motion.y);
        float group = mod(floor(motion.w + 0.5), 16.0);
        if (group < 0.5) point = (u_pose0 * vec4(point, 1.0)).xyz;
        else if (group < 1.5) point = (u_pose1 * vec4(point, 1.0)).xyz;
        else if (group < 2.5) point = (u_pose2 * vec4(point, 1.0)).xyz;
        else if (group < 3.5) point = (u_pose3 * vec4(point, 1.0)).xyz;
        else if (group < 4.5) point = (u_pose4 * vec4(point, 1.0)).xyz;
        else if (group < 5.5) point = (u_pose5 * vec4(point, 1.0)).xyz;
        else point = (u_pose6 * vec4(point, 1.0)).xyz;
        if (motion.w > 15.5) point = (u_slew * vec4(point, 1.0)).xyz;
        ` : asset.config.type === 'pile_rig' ? 'point.y += u_delta.x * motion.x;' : ''}
        vsOutput.positionMC = (point - u_anchor) * u_scale / u_bound;
      }`,
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 normal = cross(dFdx(fsInput.attributes.positionEC), dFdy(fsInput.attributes.positionEC));
        float lengthSquared = dot(normal, normal);
        if (lengthSquared > 1.0e-20) material.normalEC = normal * inversesqrt(lengthSquared);
      }`,
  });
}

export function updateMachineryRuntimeShader(shader: CustomShader, asset: LoadedMachineryAsset, parameters: Readonly<MachineryParameters>): number {
  const pose = poseFor(asset, parameters);
  shader.setUniform('u_delta', pose.delta); shader.setUniform('u_scale', pose.scale); shader.setUniform('u_bound', pose.bound); shader.setUniform('u_slew', pose.slew);
  pose.matrices.forEach((matrix, i) => shader.setUniform(`u_pose${i}`, matrix));
  return pose.bound;
}
