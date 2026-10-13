import { MACHINERY_ASSET_VERSION, MACHINERY_CATALOG } from './catalog';
import type { LoadedMachineryAsset, MachineryAssetManifest, MachineryConfig, MachineryLoadOptions, MachineryModelId, MachineryModelType } from './types';

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
function fail(message: string): never { throw new Error(`机械模型资产无效：${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}
function finite(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) fail(label);
  return value;
}
function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(label);
  return number;
}
function vector(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 3) fail(label);
  return value.map((entry, i) => finite(entry, `${label}[${i}]`));
}
function definitions(value: unknown, label: string): Set<string> {
  if (!Array.isArray(value) || value.length > 20) fail(label);
  const keys = new Set<string>();
  for (const raw of value) {
    const item = record(raw, label);
    if (typeof item.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(item.key) || keys.has(item.key)) fail(`${label}.key`);
    if (typeof item.label !== 'string' || (item.unit !== 'm' && item.unit !== '×' && item.unit !== '°')) fail(`${label}.label/unit`);
    if (item.unit === '°') {
      if (item.key !== 'boom_rotation_deg' || item.original !== 0 || item.min !== 0 || item.max !== 360) fail(`${label}.rotation`);
    } else finite(item.original, `${label}.original`, true);
    if (item.min !== undefined) finite(item.min, `${label}.min`);
    if (item.max !== undefined) finite(item.max, `${label}.max`);
    if (item.step !== undefined) finite(item.step, `${label}.step`, true);
    keys.add(item.key);
  }
  return keys;
}
function parseConfig(value: unknown, type: MachineryModelType): MachineryConfig {
  const config = record(value, 'config');
  if (config.type !== type) fail('config.type');
  const keys = definitions(config.parameters, 'parameters');
  const localKeys = definitions(config.local_parameters, 'local_parameters');
  for (const key of localKeys) if (!keys.has(key)) fail('local parameter absent from parameter definitions');
  for (const key of ['overall_scale', 'body_height_m', type === 'pile_rig' ? 'total_height_m' : 'overall_height_m']) if (!keys.has(key)) fail(`missing ${key}`);
  const reference = record(config.reference_dimensions, 'reference_dimensions');
  finite(reference.body_height_m, 'body height', true); finite(reference.overall_height_m, 'overall height', true);
  finite(reference.ground_y_m, 'ground'); finite(reference.body_top_y_m, 'body top');
  const anchor = vector(reference.anchor_m, 'anchor');
  if (Math.abs(anchor[1] - (reference.ground_y_m as number)) > 1e-10) fail('anchor must be on original ground');
  if (type === 'crane') {
    if (!keys.has('boom_rotation_deg') || localKeys.has('boom_rotation_deg')) fail('missing independent boom rotation metadata; reload current machinery assets');
    const rotation = record(config.rotation, 'rotation');
    vector(rotation.pivot_m, 'rotation.pivot_m');
    if (!Array.isArray(rotation.vertex_ranges) || !rotation.vertex_ranges.length || rotation.vertex_ranges.length > 10000) fail('rotation.vertex_ranges');
    let end = 0;
    for (const range of rotation.vertex_ranges) {
      if (!Array.isArray(range) || range.length !== 2) fail('rotation vertex range');
      const start = integer(range[0], 'rotation start'), count = integer(range[1], 'rotation count', 1);
      if (start < end) fail('overlapping or unsorted rotation vertex ranges');
      end = start + count;
    }
    for (const key of ['boom_length_m', 'outrigger_lateral_m', 'outrigger_longitudinal_m']) if (!localKeys.has(key)) fail(`missing local ${key}`);
    const boom = record(config.boom, 'boom'), axis = vector(boom.axis, 'boom.axis');
    if (Math.abs(Math.hypot(...axis) - 1) > 1e-6) fail('boom axis not unit length');
    const root = finite(boom.root_projection_m, 'boom root'), tip = finite(boom.tip_projection_m, 'boom tip');
    const start = finite(boom.extension_anchor_projection_m, 'boom extension anchor');
    if (!(root < start && start < tip)) fail('boom projection order');
    finite(boom.original_length_m, 'boom length', true);
    const outriggers = record(config.outriggers, 'outriggers');
    finite(outriggers.original_lateral_m, 'lateral spacing', true); finite(outriggers.original_longitudinal_m, 'longitudinal spacing', true);
    if (!Array.isArray(outriggers.legs) || outriggers.legs.length !== 4) fail('four outriggers required');
    outriggers.legs.forEach((raw, i) => {
      const leg = record(raw, 'leg');
      if (leg.index !== i || leg.rigid_part_id !== 10 + i || leg.beam_part_id !== 20 + i) fail('outrigger part IDs');
      if (![1, -1].includes(leg.longitudinal_sign as number) || ![1, -1].includes(leg.lateral_sign as number)) fail('outrigger direction');
      vector(leg.center_m, 'leg center');
      if (finite(leg.beam_inner_z_m, 'inner beam') === finite(leg.beam_outer_z_m, 'outer beam')) fail('zero beam length');
    });
  } else if (type === 'pile_rig') {
    if (keys.has('boom_rotation_deg')) fail('rotation is only supported by crane');
    if (!localKeys.has('total_height_m')) fail('missing pile height');
    for (const key of ['default_total_height_m', 'fixed_bottom_height_m', 'top_head_height_m', 'adjustable_default_span_m']) finite(config[key], key, true);
    finite(config.ground_y_m, 'pile ground'); finite(config.fixed_bottom_upper_y_m, 'pile platform');
    const total = (config.fixed_bottom_height_m as number) + (config.top_head_height_m as number) + (config.adjustable_default_span_m as number);
    if (Math.abs(total - (config.default_total_height_m as number)) > 1e-8) fail('pile height partition');
  } else if (localKeys.size || keys.has('boom_rotation_deg')) fail('excavator has no verified independent joint controls');
  return value as MachineryConfig;
}

function parseManifest(value: unknown, id: MachineryModelId): MachineryAssetManifest {
  const manifest = record(value, 'manifest');
  const catalog = MACHINERY_CATALOG.find(item => item.id === id);
  if (!catalog || manifest.id !== id || manifest.type !== catalog.type || manifest.name !== catalog.name) fail('model identity');
  if (manifest.schema !== 'machinery-asset/v1' || manifest.version !== MACHINERY_ASSET_VERSION) fail('schema/version');
  parseConfig(manifest.config, catalog.type);
  const vertices = integer(manifest.vertexCount, 'vertexCount', 1, 1_000_000);
  const triangles = integer(manifest.triangleCount, 'triangleCount', 1, 2_000_000);
  const palette = integer(manifest.paletteSize, 'paletteSize', 1, 256);
  const total = integer(manifest.byteLength, 'byteLength', 1, MAX_ASSET_BYTES);
  const arrays = record(manifest.arrays, 'arrays');
  const specifications = [
    ['positions', vertices * 3 * 8, 8], ['indices', triangles * 3 * 4, 4], ['partIds', vertices, 1],
    ['palette', palette * 3 * 4, 4], ['faceColorIndices', triangles, 1],
  ] as const;
  const ranges = specifications.map(([key, expected, alignment]) => {
    const range = record(arrays[key], key), start = integer(range.offset, `${key}.offset`), length = integer(range.byteLength, `${key}.length`);
    if (length !== expected || start % alignment || start + length > total) fail(`${key} buffer range`);
    return [start, start + length];
  }).sort((left, right) => left[0] - right[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('overlapping arrays');
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 64) fail('chunks');
  let byteCount = 0;
  const filenames = new Set<string>();
  for (const raw of manifest.chunks) {
    const chunk = record(raw, 'chunk');
    if (typeof chunk.file !== 'string' || !/^chunk-\d{3}\.bin$/.test(chunk.file) || filenames.has(chunk.file)) fail('chunk file');
    filenames.add(chunk.file);
    byteCount += integer(chunk.byteLength, 'chunk length', 1, 524288);
    if (typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256)) fail('chunk digest');
  }
  if (byteCount !== total) fail('chunk total length');
  return value as MachineryAssetManifest;
}

/** Fetch only the selected model. Callers may cache successful assets by id/version. */
export async function loadMachineryAsset(id: MachineryModelId, options: MachineryLoadOptions = {}): Promise<LoadedMachineryAsset> {
  if (!MACHINERY_CATALOG.some(item => item.id === id)) fail('unknown model');
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('当前环境没有可用的模型加载接口');
  const base = (options.baseUrl ?? '/machinery/').replace(/\/?$/, '/');
  const directory = `${base}${id}/`;
  // Kinematic metadata can evolve while the immutable v1 source geometry stays identical.
  const response = await fetcher(`${directory}manifest.json`, { signal: options.signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`加载${id}模型说明失败（${response.status}）`);
  const manifest = parseManifest(await response.json(), id);
  const chunks = await Promise.all(manifest.chunks.map(async chunk => {
    const result = await fetcher(directory + chunk.file, { signal: options.signal });
    if (!result.ok) throw new Error(`加载${id}模型数据失败（${result.status}）`);
    const bytes = await result.arrayBuffer();
    if (bytes.byteLength !== chunk.byteLength) fail('truncated chunk');
    // Local HTTP deployments may not expose WebCrypto; structural validation still applies.
    if (globalThis.crypto?.subtle) {
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (hex !== chunk.sha256) fail('chunk checksum mismatch');
    }
    return new Uint8Array(bytes);
  }));
  options.signal?.throwIfAborted();
  const buffer = new ArrayBuffer(manifest.byteLength), target = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) { target.set(chunk, offset); offset += chunk.byteLength; }
  const ranges = manifest.arrays;
  const sourcePositions = new Float64Array(buffer, ranges.positions.offset, ranges.positions.byteLength / 8);
  const indices = new Uint32Array(buffer, ranges.indices.offset, ranges.indices.byteLength / 4);
  const partIds = new Uint8Array(buffer, ranges.partIds.offset, ranges.partIds.byteLength);
  const palette = new Float32Array(buffer, ranges.palette.offset, ranges.palette.byteLength / 4);
  const faceColorIndices = new Uint8Array(buffer, ranges.faceColorIndices.offset, ranges.faceColorIndices.byteLength);
  for (const value of sourcePositions) if (!Number.isFinite(value)) fail('nonfinite position');
  for (const index of indices) if (index >= manifest.vertexCount) fail('index outside vertex array');
  for (const value of palette) if (!Number.isFinite(value) || value < 0 || value > 1) fail('invalid RGB');
  for (const value of faceColorIndices) if (value >= manifest.paletteSize) fail('palette index');
  const allowed = manifest.type === 'crane' ? new Set([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]) : new Set(manifest.type === 'pile_rig' ? [0, 1, 2] : [0]);
  for (const value of partIds) if (!allowed.has(value)) fail('invalid part ID');
  if (manifest.config.type === 'crane') {
    const rotating = new Uint8Array(manifest.vertexCount);
    for (const [start, count] of manifest.config.rotation.vertex_ranges) {
      if (start + count > manifest.vertexCount) fail('rotation range outside vertex array');
      rotating.fill(1, start, start + count);
    }
    for (let i = 0; i < partIds.length; i++) {
      if (partIds[i] >= 1 && partIds[i] <= 3 && !rotating[i]) fail('rotation excludes boom or rigging');
      if (partIds[i] >= 10 && rotating[i]) fail('rotation includes outrigger');
    }
    for (let i = 0; i < indices.length; i += 3) {
      if (rotating[indices[i]] !== rotating[indices[i + 1]] || rotating[indices[i]] !== rotating[indices[i + 2]]) fail('rotation splits connected triangle');
    }
  }
  return { id, name: manifest.name, type: manifest.type, version: manifest.version, config: manifest.config, sourcePositions, indices, partIds, palette, faceColorIndices };
}
