import { deformCraneSource, deformPileSource, elevateCraneSource, rotateCraneSource } from './deformation';
import type { LoadedMachineryAsset, MachineryBounds, MachineryGeometry, MachineryParameters, MachineryParameterDefinition, MachineryResolveOptions, Vec3 } from './types';

function positive(raw: unknown, label: string): number {
  if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim())) {
    throw new RangeError(`${label}必须是大于 0 的有限数值`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label}必须是大于 0 的有限数值`);
  return value;
}

function parameterValue(raw: unknown, definition: MachineryParameterDefinition): number {
  if (definition.unit !== '°') return positive(raw, definition.label);
  const maximum = definition.max ?? 360;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim())) {
    throw new RangeError(`${definition.label}必须是 0 至 ${maximum} 度的有限数值`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new RangeError(`${definition.label}必须是 0 至 ${maximum} 度的有限数值`);
  return (definition.key === 'boom_rotation_deg' && value === 360) || Object.is(value, -0) ? 0 : value;
}

export function defaultMachineryParameters(asset: LoadedMachineryAsset): MachineryParameters {
  return Object.fromEntries(asset.config.parameters.map(parameter => [parameter.key, parameter.original]));
}

function parametersWithDefaults(asset: LoadedMachineryAsset, parameters: Readonly<Record<string, unknown>>): MachineryParameters {
  const result = defaultMachineryParameters(asset);
  const definitions = new Map(asset.config.parameters.map(definition => [definition.key, definition]));
  for (const [key, raw] of Object.entries(parameters)) {
    const definition = definitions.get(key);
    if (!definition) throw new RangeError(`此模型不支持参数：${key}`);
    result[key] = parameterValue(raw, definition);
  }
  return result;
}

/** Rebuild from the immutable source on every edit; never deform the previous output. */
export function computeMachinerySourcePositions(asset: LoadedMachineryAsset, parameters: Readonly<MachineryParameters>): Float64Array {
  const values = parametersWithDefaults(asset, parameters), config = asset.config;
  const scale = positive(values.overall_scale, '整体倍率');
  const localParameters: MachineryParameters = {};
  let uniform = true;
  for (const definition of config.local_parameters) {
    const value = positive(values[definition.key], definition.label) / scale;
    localParameters[definition.key] = value;
    uniform = uniform && Math.abs(value - definition.original) <= Math.max(1, Math.abs(definition.original)) * 1e-12;
  }
  let local = asset.sourcePositions;
  if (!uniform) {
    if (config.type === 'crane') local = deformCraneSource(local, asset.partIds, config, localParameters);
    else if (config.type === 'pile_rig') local = deformPileSource(local, asset.partIds, config, localParameters);
  }
  if (config.type === 'crane') {
    local = elevateCraneSource(local, config, values.boom_elevation_deg, localParameters.boom_length_m);
    local = rotateCraneSource(local, config, values.boom_rotation_deg);
  }
  const output = new Float64Array(local.length), anchor = config.reference_dimensions.anchor_m;
  if (scale === 1) output.set(local);
  else for (let i = 0; i < local.length; i++) output[i] = anchor[i % 3] + scale * (local[i] - anchor[i % 3]);
  for (const value of output) if (!Number.isFinite(value)) throw new RangeError('尺寸超出可表示范围，无法生成有效模型');
  return output;
}

function indexedBounds(positions: Float64Array, indices: Uint32Array): MachineryBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const index of indices) {
    const start = index * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[start + axis];
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max, size: max.map((value, axis) => value - min[axis]) as Vec3 };
}

/** Normalize only the derived mesh: the saved source coordinate arrays remain unchanged. */
export function computeMachineryGeometry(asset: LoadedMachineryAsset, parameters: Readonly<MachineryParameters>): MachineryGeometry {
  const positions = computeMachinerySourcePositions(asset, parameters);
  const anchor = asset.config.reference_dimensions.anchor_m;
  for (let i = 0; i < positions.length; i++) {
    positions[i] -= anchor[i % 3];
    // WebGL/glTF positions are float32. Float64 finiteness alone does not guarantee renderability.
    if (!Number.isFinite(Math.fround(positions[i]))) throw new RangeError('尺寸超出三维渲染可表示范围');
  }
  return { positions, indices: asset.indices, bounds: indexedBounds(positions, asset.indices), sourceAnchor: [...anchor] };
}

function synchronize(asset: LoadedMachineryAsset, parameters: MachineryParameters): MachineryParameters {
  const actual = computeMachineryGeometry(asset, parameters).bounds;
  const output = { ...parameters };
  output.body_height_m = asset.config.reference_dimensions.body_height_m * output.overall_scale;
  if (asset.type === 'pile_rig') output.total_height_m = actual.size[1];
  else output.overall_height_m = actual.size[1];
  return output;
}

function multiply(asset: LoadedMachineryAsset, current: MachineryParameters, factor: number): MachineryParameters {
  const next: MachineryParameters = {};
  for (const definition of asset.config.parameters) next[definition.key] = definition.unit === '°' ? current[definition.key] : current[definition.key] * factor;
  return synchronize(asset, next);
}

/**
 * `changes` is an edit patch, not a persisted parameter snapshot. Restore snapshots as `current`.
 * In proportional mode the last changed dimension drives the source ratio. An empty patch
 * preserves shape and parameter values: switching the editing rule is not a geometry reset.
 */
export function resolveMachineryParameters(
  asset: LoadedMachineryAsset,
  current: Readonly<MachineryParameters>,
  changes: Readonly<Record<string, unknown>>,
  options: MachineryResolveOptions = {},
): MachineryParameters {
  const original = defaultMachineryParameters(asset);
  const definitions = new Map(asset.config.parameters.map(definition => [definition.key, definition]));
  let result = parametersWithDefaults(asset, current);
  const entries = Object.entries(changes).map(([key, raw]) => {
    const definition = definitions.get(key);
    if (!definition) throw new RangeError(`此模型不支持参数：${key}`);
    return [key, parameterValue(raw, definition)] as const;
  });
  if (!entries.length) {
    const geometry = computeMachineryGeometry(asset, result);
    const expected: MachineryParameters = {
      body_height_m: asset.config.reference_dimensions.body_height_m * result.overall_scale,
      [asset.type === 'pile_rig' ? 'total_height_m' : 'overall_height_m']: geometry.bounds.size[1],
    };
    for (const [key, value] of Object.entries(expected)) {
      if (Math.abs(result[key] - value) > Math.max(1, Math.abs(value)) * 1e-8) {
        throw new RangeError(`保存参数 ${key} 与模型实际尺寸不一致，请重新调整尺寸后保存`);
      }
    }
    return result;
  }
  if (options.proportional !== false) {
    const dimensions = entries.filter(([key]) => definitions.get(key)!.unit !== '°');
    for (const [key, value] of entries) if (definitions.get(key)!.unit === '°') result[key] = value;
    if (!dimensions.length) return synchronize(asset, result);
    const [key, value] = dimensions[dimensions.length - 1];
    const posedOriginal = { ...original };
    for (const definition of definitions.values()) if (definition.unit === '°') posedOriginal[definition.key] = result[definition.key];
    const baseline = key === 'overall_height_m' ? computeMachineryGeometry(asset, posedOriginal).bounds.size[1] : original[key];
    const scale = value / baseline;
    result = Object.fromEntries(Object.entries(original).map(([name, baseline]) => [name, definitions.get(name)!.unit === '°' ? result[name] : baseline * scale]));
    return synchronize(asset, result);
  }
  for (const [key, value] of entries) {
    if (key === 'overall_scale') result = multiply(asset, result, value / result.overall_scale);
    else if (key === 'body_height_m') result = multiply(asset, result, value / result.body_height_m);
    else if (key === 'overall_height_m') result = multiply(asset, result, value / computeMachineryGeometry(asset, result).bounds.size[1]);
    else result = synchronize(asset, { ...result, [key]: value });
  }
  return result;
}

/** Editing mode and actual current proportions are distinct when toggling without an edit. */
export function originalMachineryProportionsMaintained(asset: LoadedMachineryAsset, parameters: Readonly<MachineryParameters>): boolean {
  const current = parametersWithDefaults(asset, parameters), scale = current.overall_scale;
  return asset.config.parameters.every(definition => {
    if (definition.unit === '°') return true;
    // A posed crane's total height is derived from elevation, not a source-shape dimension.
    if (asset.type === 'crane' && definition.key === 'overall_height_m') return true;
    const expected = definition.original * scale;
    return Math.abs(current[definition.key] - expected) <= Math.max(1, Math.abs(expected)) * 1e-9;
  });
}
