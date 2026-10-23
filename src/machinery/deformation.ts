import type { CraneConfig, MachineryParameters, PileConfig, Vec3 } from './types';

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function validateLocal(parameters: MachineryParameters, definitions: CraneConfig['local_parameters']): void {
  for (const definition of definitions) {
    const value = parameters[definition.key];
    const minimum = definition.min ?? 0;
    if (!Number.isFinite(value) || value <= 0 || (definition.min_exclusive ? value <= minimum : value < minimum)) {
      throw new RangeError(`${definition.label}低于当前模型的几何最小值（${minimum} ${definition.unit}，非厂家限值）`);
    }
  }
}

export function deformCraneSource(source: Float64Array, parts: Uint8Array, config: CraneConfig, parameters: MachineryParameters): Float64Array {
  validateLocal(parameters, config.local_parameters);
  const out = new Float64Array(source.length);
  const boom = config.boom, axis = boom.axis, outriggers = config.outriggers;
  const boomDelta = parameters.boom_length_m - boom.original_length_m;
  const lateralDelta = parameters.outrigger_lateral_m - outriggers.original_lateral_m;
  const longitudinalDelta = parameters.outrigger_longitudinal_m - outriggers.original_longitudinal_m;
  for (let i = 0; i < parts.length; i++) {
    const n = i * 3, x = source[n], y = source[n + 1], z = source[n + 2], part = parts[i];
    let qx = x, qy = y, qz = z;
    if (part >= 1 && part <= 3) {
      const projection = x * axis[0] + y * axis[1] + z * axis[2];
      const start = part === 3 ? boom.root_projection_m : boom.extension_anchor_projection_m;
      const weight = part === 2 ? 1 : part === 3
        ? (config.elevation.rigging_extension_fixed_vertex_indices.includes(i) ? 0 : 1)
        : clamp((projection - start) / (boom.tip_projection_m - start));
      qx += axis[0] * boomDelta * weight;
      qy += axis[1] * boomDelta * weight;
      qz += axis[2] * boomDelta * weight;
    } else if ((part >= 10 && part <= 13) || (part >= 20 && part <= 23)) {
      const leg = outriggers.legs[part % 10];
      const weight = part < 20 ? 1 : clamp((z - leg.beam_inner_z_m) / (leg.beam_outer_z_m - leg.beam_inner_z_m));
      qx += leg.longitudinal_sign * longitudinalDelta * 0.5 * weight;
      qz += leg.lateral_sign * lateralDelta * 0.5 * weight;
    }
    out[n] = qx; out[n + 1] = qy; out[n + 2] = qz;
  }
  return out;
}

/** Slew after extension, before the common scale. Never rotate chassis or outriggers. */
export function rotateCraneSource(source: Float64Array, config: CraneConfig, degrees: number): Float64Array {
  if (degrees === 0) return source;
  const output = source.slice(), [cx, , cz] = config.rotation.pivot_m;
  const radians = degrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  for (const [start, count] of config.rotation.vertex_ranges) {
    for (let vertex = start; vertex < start + count; vertex++) {
      const n = vertex * 3, dx = source[n] - cx, dz = source[n + 2] - cz;
      // +X maps to north and +Z maps to east in the platform. Positive is clockwise.
      output[n] = cx + dx * cosine - dz * sine;
      output[n + 2] = cz + dx * sine + dz * cosine;
    }
  }
  return output;
}

function rotateVector(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  const [x, y, z] = vector, [ax, ay, az] = axis, sine = Math.sin(angle), cosine = Math.cos(angle);
  const dot = x * ax + y * ay + z * az;
  return [
    x * cosine + (ay * z - az * y) * sine + ax * dot * (1 - cosine),
    y * cosine + (az * x - ax * z) * sine + ay * dot * (1 - cosine),
    z * cosine + (ax * y - ay * x) * sine + az * dot * (1 - cosine),
  ];
}
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const point = (source: Float64Array, index: number): Vec3 => [source[index * 3], source[index * 3 + 1], source[index * 3 + 2]];

/** Articulate the measured boom hinge while the hanging block remains upright. */
export function elevateCraneSource(source: Float64Array, config: CraneConfig, degrees: number, boomLength: number): Float64Array {
  const elevation = config.elevation;
  if (degrees === elevation.original_degrees) return source;
  const output = source.slice(), angle = (degrees - elevation.original_degrees) * Math.PI / 180;
  const pitch = (p: Vec3): Vec3 => add(elevation.hinge_m, rotateVector(subtract(p, elevation.hinge_m), elevation.axis, angle));
  const write = (index: number, value: Vec3) => { output.set(value, index * 3); };
  const transformRanges = (ranges: readonly (readonly [number, number])[], transform: (p: Vec3) => Vec3) => {
    for (const [start, count] of ranges) for (let i = start; i < start + count; i++) write(i, transform(point(source, i)));
  };
  transformRanges(elevation.boom_vertex_ranges, pitch);
  const extension = boomLength - config.boom.original_length_m;
  const attachment = add(elevation.hanging_attachment_m, config.boom.axis.map(value => value * extension) as Vec3);
  const hangingDelta = subtract(pitch(attachment), attachment);
  const translateHanging = (p: Vec3) => add(p, hangingDelta);
  transformRanges(elevation.hanging_vertex_ranges, translateHanging);
  // Flexible rope ends follow their actual head/block anchors, not a rigid boom tilt.
  for (const index of elevation.rope_upper_vertex_indices) write(index, pitch(point(source, index)));
  for (const index of elevation.rope_lower_vertex_indices) write(index, translateHanging(point(source, index)));
  transformRanges(elevation.rigging_vertex_ranges, pitch);
  for (const index of elevation.rigging_fixed_vertex_indices) write(index, point(source, index));
  for (const cylinder of elevation.hydraulics) {
    const target = pitch(cylinder.attachment_m), before = subtract(cylinder.attachment_m, cylinder.base_m), after = subtract(target, cylinder.base_m);
    const lengthBefore = Math.hypot(...before), lengthAfter = Math.hypot(...after);
    if (lengthAfter < 1e-9) throw new RangeError('吊臂姿态使液压缸两铰点重合，无法生成有效模型');
    const from = before.map(value => value / lengthBefore) as Vec3, to = after.map(value => value / lengthAfter) as Vec3;
    const cross: Vec3 = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]];
    const crossLength = Math.hypot(...cross), dot = Math.max(-1, Math.min(1, from.reduce((sum, value, i) => sum + value * to[i], 0)));
    const rotationAxis = crossLength > 1e-12 ? cross.map(value => value / crossLength) as Vec3 : elevation.axis;
    const rotationAngle = Math.atan2(crossLength, dot);
    // Keep each original barrel/rod rigid. Their overlap changes as a telescopic joint.
    transformRanges(cylinder.barrel_vertex_ranges, p => add(cylinder.base_m, rotateVector(subtract(p, cylinder.base_m), rotationAxis, rotationAngle)));
    transformRanges(cylinder.rod_vertex_ranges, p => add(target, rotateVector(subtract(p, cylinder.attachment_m), rotationAxis, rotationAngle)));
  }
  return output;
}

export function deformPileSource(source: Float64Array, parts: Uint8Array, config: PileConfig, parameters: MachineryParameters): Float64Array {
  validateLocal(parameters, config.local_parameters);
  const height = parameters.total_height_m;
  const out = source.slice();
  if (height === config.default_total_height_m) return out;
  const stretch = (height - config.fixed_bottom_height_m - config.top_head_height_m) / config.adjustable_default_span_m;
  for (let i = 0; i < parts.length; i++) {
    const n = i * 3 + 1;
    if (parts[i] === 1) out[n] = config.fixed_bottom_upper_y_m + (source[n] - config.fixed_bottom_upper_y_m) * stretch;
    else if (parts[i] === 2) out[n] = source[n] + height - config.default_total_height_m;
  }
  return out;
}
