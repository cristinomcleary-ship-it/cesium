import type { CraneConfig, MachineryParameters, PileConfig } from './types';

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
      const weight = part === 2 ? 1 : clamp((projection - start) / (boom.tip_projection_m - start));
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
