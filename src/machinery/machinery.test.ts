import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MACHINERY_ASSET_VERSION, MACHINERY_CATALOG, loadMachineryAsset,
  defaultMachineryParameters, resolveMachineryParameters, computeMachineryGeometry,
  computeMachinerySourcePositions, originalMachineryProportionsMaintained, createMachineryGlb,
} from './index';
import type { LoadedMachineryAsset, MachineryModelId } from './types';

// Explicit URL avoids depending on the invocation working directory.
const publicBase = new URL('../../public/machinery/', import.meta.url);
const requests: string[] = [];
const fileFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  const bytes = await readFile(fileURLToPath(url));
  return new Response(new Uint8Array(bytes), { status: 200 });
};
const cache = new Map<MachineryModelId, Promise<LoadedMachineryAsset>>();
function model(id: MachineryModelId) {
  let result = cache.get(id);
  if (!result) { result = loadMachineryAsset(id, { baseUrl: publicBase.href, fetcher: fileFetch }); cache.set(id, result); }
  return result;
}
function near(actual: number, expected: number, epsilon = 1e-8) { assert.ok(Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`); }
function maxDifference(left: Float64Array, right: Float64Array) { let maximum = 0; for (let i = 0; i < left.length; i++) maximum = Math.max(maximum, Math.abs(left[i] - right[i])); return maximum; }

interface GltfDocument {
  buffers: { byteLength: number }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  accessors: { count: number; type: string; componentType: number; min?: number[]; max?: number[] }[];
  materials: { pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number }; extensions?: Record<string, unknown> }[];
  extras: Record<string, unknown>;
}
function parseGlb(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  assert.equal(view.getUint32(0, true), 0x46546c67); assert.equal(view.getUint32(4, true), 2); assert.equal(view.getUint32(8, true), buffer.byteLength);
  const jsonLength = view.getUint32(12, true); assert.equal(view.getUint32(16, true), 0x4e4f534a);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as GltfDocument;
  const binHeader = 20 + jsonLength; assert.equal(view.getUint32(binHeader + 4, true), 0x004e4942);
  assert.equal(view.getUint32(binHeader, true), document.buffers[0].byteLength);
  assert.equal(binHeader + 8 + document.buffers[0].byteLength, buffer.byteLength);
  const arrays = document.bufferViews.map(range => new Float32Array(buffer, binHeader + 8 + range.byteOffset, range.byteLength / 4));
  return { document, arrays };
}

test('load selects only one model, verifies compact arrays, and shares the backend version', async () => {
  requests.length = 0;
  const crane = await model('crane');
  assert.equal(crane.version, MACHINERY_ASSET_VERSION);
  assert.ok(requests.length >= 2 && requests.every(url => url.includes('/crane/')));
  assert.equal(crane.sourcePositions.length, 40642 * 3); assert.equal(crane.indices.length, 57483 * 3);
  assert.equal(crane.palette.length, 21 * 3); assert.equal(crane.faceColorIndices.length, 57483);
  assert.equal('vertices' in crane, false); // No expanded renderer duplicate is loaded.
});

for (const entry of MACHINERY_CATALOG) {
  test(`${entry.id}: default source identity, ground anchor, linked edits and repeated reset`, async () => {
    const asset = await model(entry.id), defaults = defaultMachineryParameters(asset), sourceCopy = asset.sourcePositions.slice();
    assert.deepEqual(computeMachinerySourcePositions(asset, defaults), sourceCopy);
    near(computeMachineryGeometry(asset, defaults).bounds.min[1], 0, 1e-12);
    for (const definition of asset.config.parameters) {
      if (definition.unit === '°') continue;
      const changed = resolveMachineryParameters(asset, defaults, { [definition.key]: definition.original * 2 });
      near(changed.overall_scale, 2);
      for (const parameter of asset.config.parameters) near(changed[parameter.key], parameter.original * (parameter.unit === '°' ? 1 : 2));
      const source = computeMachinerySourcePositions(asset, changed), anchor = asset.config.reference_dimensions.anchor_m;
      for (let i = 0; i < source.length; i++) near(source[i], anchor[i % 3] + 2 * (sourceCopy[i] - anchor[i % 3]), 1e-12);
      assert.deepEqual(resolveMachineryParameters(asset, changed, { [definition.key]: definition.original * 2 }), changed);
      assert.equal(originalMachineryProportionsMaintained(asset, changed), true);
    }
    for (let i = 0; i < 12; i++) {
      const changed = resolveMachineryParameters(asset, defaults, { overall_scale: 0.75 + i * 0.25 });
      computeMachineryGeometry(asset, changed);
      assert.deepEqual(computeMachinerySourcePositions(asset, defaultMachineryParameters(asset)), sourceCopy);
    }
    assert.deepEqual(asset.sourcePositions, sourceCopy);
  });
}

test('crane independent extension after 2x global scale preserves body and does not scale twice', async () => {
  const asset = await model('crane'), baseline = defaultMachineryParameters(asset);
  const doubled = resolveMachineryParameters(asset, baseline, { overall_scale: 2 });
  const before = computeMachinerySourcePositions(asset, doubled);
  const changed = resolveMachineryParameters(asset, doubled, { boom_length_m: doubled.boom_length_m + 1 }, { proportional: false });
  const after = computeMachinerySourcePositions(asset, changed);
  near(changed.overall_scale, 2);
  let changedCount = 0;
  for (let vertex = 0; vertex < asset.partIds.length; vertex++) {
    const i = vertex * 3;
    if (asset.partIds[vertex] === 0) for (let axis = 0; axis < 3; axis++) assert.equal(after[i + axis], before[i + axis]);
    if (after[i] !== before[i]) changedCount++;
  }
  assert.ok(changedCount > 100);
  assert.equal(originalMachineryProportionsMaintained(asset, changed), false);
  assert.throws(() => resolveMachineryParameters(asset, doubled, { boom_length_m: 0.8 }, { proportional: false }), /几何最小值/);
});

test('crane slew rotates complete upperworks clockwise around measured bearing while chassis stays exact', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const moving = new Uint8Array(asset.partIds.length);
  for (const [start, count] of asset.config.rotation.vertex_ranges) moving.fill(1, start, start + count);
  assert.equal(moving.reduce((sum, value) => sum + value, 0), 19873);
  const [cx, , cz] = asset.config.rotation.pivot_m;
  for (const angle of [90, 180, 270, 37.5]) {
    const params = resolveMachineryParameters(asset, defaults, { boom_rotation_deg: angle });
    const after = computeMachinerySourcePositions(asset, params), before = asset.sourcePositions;
    const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
    assert.equal(params.overall_scale, 1);
    assert.equal(originalMachineryProportionsMaintained(asset, params), true);
    for (let vertex = 0; vertex < moving.length; vertex++) {
      const n = vertex * 3;
      assert.equal(after[n + 1], before[n + 1]);
      if (!moving[vertex]) for (let axis = 0; axis < 3; axis++) assert.equal(after[n + axis], before[n + axis]);
      else {
        const dx = before[n] - cx, dz = before[n + 2] - cz;
        near(after[n], cx + dx * cosine - dz * sine, 1e-12);
        near(after[n + 2], cz + dx * sine + dz * cosine, 1e-12);
        near(Math.hypot(after[n] - cx, after[n + 2] - cz), Math.hypot(dx, dz), 1e-12);
      }
    }
    // Every face lies entirely within one rigid group: no tearing at classification boundaries.
    for (let i = 0; i < asset.indices.length; i += 3) {
      const [a, b, c] = asset.indices.subarray(i, i + 3);
      assert.equal(moving[a], moving[b]); assert.equal(moving[a], moving[c]);
    }
  }
  for (const part of [1, 2, 3]) assert.ok(asset.partIds.every((value, i) => value !== part || moving[i] === 1));
  assert.ok(asset.partIds.every((value, i) => value < 10 || moving[i] === 0));
});

test('crane slew composes with independent extension and scaled pivot; angle never scales', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const [cx, , cz] = asset.config.rotation.pivot_m, anchor = asset.config.reference_dimensions.anchor_m;
  const edited = resolveMachineryParameters(asset, defaults, { boom_length_m: defaults.boom_length_m + 1, outrigger_lateral_m: 1 }, { proportional: false });
  const before = computeMachinerySourcePositions(asset, edited);
  for (const proportional of [true, false]) {
    const rotated = resolveMachineryParameters(asset, edited, { boom_rotation_deg: 90 }, { proportional });
    for (const key of Object.keys(edited)) if (key !== 'boom_rotation_deg') near(rotated[key], edited[key]);
    const scaled = resolveMachineryParameters(asset, rotated, { overall_scale: 2 }, { proportional: false });
    assert.equal(scaled.boom_rotation_deg, 90); near(scaled.boom_length_m, edited.boom_length_m * 2);
    const positions = computeMachinerySourcePositions(asset, scaled);
    for (const [start, count] of asset.config.rotation.vertex_ranges) for (let vertex = start; vertex < start + count; vertex++) {
      const n = vertex * 3;
      near(positions[n], anchor[0] + 2 * (cx - (before[n + 2] - cz) - anchor[0]), 1e-12);
      near(positions[n + 1], anchor[1] + 2 * (before[n + 1] - anchor[1]), 1e-12);
      near(positions[n + 2], anchor[2] + 2 * (cz + (before[n] - cx) - anchor[2]), 1e-12);
    }
    const resized = resolveMachineryParameters(asset, rotated, { boom_length_m: defaults.boom_length_m * 3 }, { proportional: true });
    assert.equal(resized.boom_rotation_deg, 90); near(resized.overall_scale, 3);
    const patch = resolveMachineryParameters(asset, defaults, { boom_rotation_deg: 45, overall_scale: 2 }, { proportional });
    assert.equal(patch.boom_rotation_deg, 45); assert.equal(patch.overall_scale, 2);
  }
});

test('crane rotation wraps360to0, keeps legacy0 exact, rejects invalid angles and resets without drift', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  const legacy = { ...defaults }; delete legacy.boom_rotation_deg;
  assert.deepEqual(resolveMachineryParameters(asset, legacy, {}), defaults);
  assert.deepEqual(computeMachinerySourcePositions(asset, legacy), asset.sourcePositions);
  for (const value of [360, -0, '360']) {
    const parameters = resolveMachineryParameters(asset, defaults, { boom_rotation_deg: value });
    assert.equal(parameters.boom_rotation_deg, 0);
    assert.deepEqual(computeMachinerySourcePositions(asset, parameters), asset.sourcePositions);
  }
  for (const value of [-1, 361, NaN, Infinity, null, '', ' ', true, [], {}]) {
    assert.throws(() => resolveMachineryParameters(asset, defaults, { boom_rotation_deg: value }), /0 至 360/);
  }
  let parameters = defaults;
  for (const angle of [90, 180, 270, 12.25, 359.999, 360, 0]) {
    parameters = resolveMachineryParameters(asset, parameters, { boom_rotation_deg: angle });
    assert.deepEqual(computeMachinerySourcePositions(asset, parameters), computeMachinerySourcePositions(asset, { ...defaults, boom_rotation_deg: parameters.boom_rotation_deg }));
  }
  assert.deepEqual(computeMachinerySourcePositions(asset, parameters), asset.sourcePositions);
  const { document } = parseGlb(createMachineryGlb(asset, { ...defaults, boom_rotation_deg: 90 }));
  assert.equal((document.extras.parameters as Record<string, number>).boom_rotation_deg, 90);
});

test('crane independent foot spacings keep feet dimensions and other parameters', async () => {
  const asset = await model('crane'), base = defaultMachineryParameters(asset), before = computeMachinerySourcePositions(asset, base);
  const params = resolveMachineryParameters(asset, base, { outrigger_lateral_m: base.outrigger_lateral_m + 0.2, outrigger_longitudinal_m: base.outrigger_longitudinal_m + 0.1 }, { proportional: false });
  const after = computeMachinerySourcePositions(asset, params);
  for (let part = 10; part <= 13; part++) {
    const delta: number[][] = [];
    for (let i = 0; i < asset.partIds.length; i++) if (asset.partIds[i] === part) delta.push([after[i * 3] - before[i * 3], after[i * 3 + 1] - before[i * 3 + 1], after[i * 3 + 2] - before[i * 3 + 2]]);
    for (const row of delta) row.forEach((value, axis) => near(value, delta[0][axis], 1e-12));
    near(Math.abs(delta[0][0]), 0.05); near(Math.abs(delta[0][2]), 0.1); near(delta[0][1], 0);
  }
  near(params.boom_length_m, base.boom_length_m); near(params.body_height_m, base.body_height_m);
});

test('pile independent total height preserves lower body; next global scale preserves local ratio', async () => {
  const asset = await model('pile'), base = defaultMachineryParameters(asset);
  const local = resolveMachineryParameters(asset, base, { total_height_m: 3 }, { proportional: false });
  const vertices = computeMachinerySourcePositions(asset, local);
  near(computeMachineryGeometry(asset, local).bounds.size[1], 3);
  for (let i = 0; i < asset.partIds.length; i++) if (asset.partIds[i] === 0) for (let axis = 0; axis < 3; axis++) assert.equal(vertices[i * 3 + axis], asset.sourcePositions[i * 3 + axis]);
  const twice = resolveMachineryParameters(asset, local, { overall_scale: 2 }, { proportional: false });
  near(twice.total_height_m, 6); near(twice.body_height_m, base.body_height_m * 2);
});

test('switching mode without an edit preserves shape and exporting reports actual proportions separately', async () => {
  const asset = await model('crane'), base = defaultMachineryParameters(asset);
  const local = resolveMachineryParameters(asset, base, { boom_length_m: base.boom_length_m + 1 }, { proportional: false });
  const switched = resolveMachineryParameters(asset, local, {}, { proportional: true });
  assert.deepEqual(switched, local);
  assert.equal(maxDifference(computeMachinerySourcePositions(asset, switched), computeMachinerySourcePositions(asset, local)), 0);
  const { document } = parseGlb(createMachineryGlb(asset, switched, { proportional: true }));
  assert.equal(document.extras.editMode, 'proportional'); assert.equal(document.extras.originalProportionsMaintained, false);
  const next = resolveMachineryParameters(asset, switched, { body_height_m: base.body_height_m * 3 }, { proportional: true });
  assert.equal(originalMachineryProportionsMaintained(asset, next), true); near(next.overall_scale, 3);
});

test('invalid numeric edits and float32 overflow fail before replacing geometry', async () => {
  const asset = await model('crane'), base = defaultMachineryParameters(asset);
  for (const value of [null, '', ' ', true, [], {}, NaN, Infinity, -1, 0]) assert.throws(() => resolveMachineryParameters(asset, base, { overall_scale: value }));
  assert.throws(() => resolveMachineryParameters(asset, base, { not_a_parameter: 1 }));
  assert.throws(() => resolveMachineryParameters(asset, base, { overall_scale: 1e40 }), /渲染可表示范围/);
  assert.deepEqual(defaultMachineryParameters(asset), base);
});

test('restored snapshots and GLB metadata cannot claim a height different from actual geometry', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  for (const key of ['overall_height_m', 'body_height_m']) {
    const corrupt = { ...defaults, [key]: 100 };
    assert.throws(() => resolveMachineryParameters(asset, corrupt, {}), /与模型实际尺寸不一致/);
    assert.throws(() => createMachineryGlb(asset, corrupt), /与模型实际尺寸不一致/);
  }
  const local = resolveMachineryParameters(asset, defaults, { boom_length_m: 5 }, { proportional: false });
  assert.deepEqual(resolveMachineryParameters(asset, local, {}, { proportional: true }), local);
  assert.doesNotThrow(() => createMachineryGlb(asset, local, { proportional: true }));
});

for (const entry of MACHINERY_CATALOG) {
  test(`${entry.id}: GLB is metre Y-up at ground anchor, with finite unit normals and linear display colors`, async () => {
    const asset = await model(entry.id), params = defaultMachineryParameters(asset);
    const { document, arrays: [positions, normals, colors] } = parseGlb(createMachineryGlb(asset, params));
    assert.equal(document.extras.units, 'm'); assert.equal(document.extras.coordinateSystem, 'Y-up');
    assert.deepEqual(document.extras.placementAnchor, [0, 0, 0]); assert.equal(document.extras.assetVersion, MACHINERY_ASSET_VERSION);
    near(document.accessors[0].min![1], 0, 1e-8);
    assert.equal(positions.length, normals.length); assert.equal(positions.length, colors.length);
    const appearance = document.extras.appearance as Record<string, unknown>;
    assert.equal(appearance.profile, 'construction-vivid/v1');
    assert.equal(appearance.vertexColorSpace, 'linear RGB');
    assert.equal(appearance.matchedSourceColors, asset.palette.length / 3);
    assert.equal(appearance.sourceArraysModified, false); assert.equal(appearance.texturesRestored, false);
    const displayedColors = new Set<string>();
    for (let i = 0; i < positions.length; i += 3) {
      assert.ok(Number.isFinite(positions[i]) && Number.isFinite(positions[i + 1]) && Number.isFinite(positions[i + 2]));
      near(Math.hypot(normals[i], normals[i + 1], normals[i + 2]), 1, 1e-6);
      for (let axis = 0; axis < 3; axis++) assert.ok(Number.isFinite(colors[i + axis]) && colors[i + axis] >= 0 && colors[i + axis] <= 1);
      displayedColors.add(Array.from(colors.subarray(i, i + 3)).join(','));
    }
    assert.ok(displayedColors.size >= asset.palette.length / 3 - 1, 'paint, metal, rubber and glass remain visually separate');
    assert.deepEqual(document.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
    assert.equal(document.materials[0].pbrMetallicRoughness.metallicFactor, 0);
    assert.ok(document.materials[0].pbrMetallicRoughness.roughnessFactor > 0.5);
    assert.equal(document.materials[0].extensions?.KHR_materials_unlit, undefined, 'surface normals continue to shade the machinery');
    assert.equal(positions.length / 9 + Number(document.extras.removedDegenerateTriangles), asset.indices.length / 3);
  });
}

test('crane display contrasts red body/base boom, charcoal extension and yellow outrigger paint without changing source geometry', async () => {
  const asset = await model('crane'), params = defaultMachineryParameters(asset);
  const source = { positions: asset.sourcePositions.slice(), indices: asset.indices.slice(), colors: asset.faceColorIndices.slice(), palette: asset.palette.slice(), parts: asset.partIds.slice() };
  const { arrays: [positions, , colors] } = parseGlb(createMachineryGlb(asset, params));
  // Independent expected linear values for authored sRGB #F3343E, #303B48,
  // #FFD43B and #76838D. A direct byte/255 export would fail these assertions.
  const red = [0.8962693533742664, 0.03433980680868217, 0.04817182422688942];
  const charcoal = [0.0295568344378088, 0.043735029256973465, 0.06480326669290577];
  const yellow = [1, 0.6583748172794485, 0.043735029256973465];
  const steel = [0.18116424424986022, 0.22696587351009836, 0.26635560480286247];
  const counts = { red: 0, charcoal: 0, yellow: 0, steel: 0 };
  const anchor = asset.config.reference_dimensions.anchor_m;
  let emitted = 0;
  for (let face = 0; face < asset.faceColorIndices.length; face++) {
    const vertices = Array.from(asset.indices.subarray(face * 3, face * 3 + 3));
    const points = vertices.map(vertex => [0, 1, 2].map(axis => Math.fround(asset.sourcePositions[vertex * 3 + axis] - anchor[axis])));
    const ab = points[1].map((value, axis) => value - points[0][axis]), ac = points[2].map((value, axis) => value - points[0][axis]);
    if (Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) === 0) continue;
    const part = asset.partIds[vertices[0]], originalColor = asset.faceColorIndices[face];
    let expected: number[] | undefined;
    if (originalColor === 9) {
      const region = part === 1 ? 'charcoal' : (part >= 10 && part <= 13) || (part >= 20 && part <= 23) ? 'yellow' : 'red';
      expected = { red, charcoal, yellow }[region]; counts[region]++;
    } else if (originalColor === 2) { expected = steel; counts.steel++; }
    for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
      const index = emitted * 9 + corner * 3 + axis;
      assert.equal(positions[index], points[corner][axis]);
      if (expected) near(colors[index], expected[axis], 1e-6);
    }
    emitted++;
  }
  assert.equal(emitted * 9, positions.length);
  for (const [region, count] of Object.entries(counts)) assert.ok(count > 500, `${region} covers its real source surfaces`);
  // Export again at a combined articulation; no source array may inherit the
  // display colors or transform, and resetting must recover the identical GLB.
  const articulated = resolveMachineryParameters(asset, params, { boom_elevation_deg: 30, boom_rotation_deg: 90, boom_length_m: 5 }, { proportional: false });
  createMachineryGlb(asset, articulated, { proportional: false });
  assert.deepEqual(asset.sourcePositions, source.positions); assert.deepEqual(asset.indices, source.indices);
  assert.deepEqual(asset.faceColorIndices, source.colors); assert.deepEqual(asset.palette, source.palette); assert.deepEqual(asset.partIds, source.parts);
  assert.deepEqual(parseGlb(createMachineryGlb(asset, params)).arrays[2], colors);
});

test('malformed manifest, truncated chunk and corrupt RGB are rejected', async () => {
  const manifestUrl = new URL('crane/manifest.json', publicBase), original = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const wrong = { ...original, version: 'wrong-version' };
  const badManifest: typeof fetch = async () => new Response(JSON.stringify(wrong));
  await assert.rejects(loadMachineryAsset('crane', { fetcher: badManifest }), /schema\/version/);
  const truncated: typeof fetch = async input => {
    const url = String(input);
    return url.endsWith('manifest.json') ? new Response(JSON.stringify(original)) : new Response(new Uint8Array(4));
  };
  await assert.rejects(loadMachineryAsset('crane', { fetcher: truncated }), /truncated chunk/);
  const asset = await model('crane'), palette = asset.palette.slice(); palette[0] = NaN;
  assert.throws(() => createMachineryGlb({ ...asset, palette }, defaultMachineryParameters(asset)), /颜色无效/);
});

test('crane stale or torn slew metadata is rejected before using an invalid articulation', async () => {
  const manifestUrl = new URL('crane/manifest.json', publicBase), original = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const corruptions: Array<(manifest: typeof original) => void> = [
    manifest => { delete manifest.config.rotation; },
    manifest => { manifest.config.rotation.vertex_ranges = [[0, manifest.vertexCount + 1]]; },
    manifest => { manifest.config.rotation.vertex_ranges = [[22, 1]]; },
    manifest => { manifest.config.rotation.vertex_ranges = [[0, manifest.vertexCount]]; },
  ];
  for (const corrupt of corruptions) {
    const modified = structuredClone(original); corrupt(modified);
    const fetcher: typeof fetch = async (input, options) => String(input).endsWith('manifest.json') ? new Response(JSON.stringify(modified)) : fileFetch(input, options);
    await assert.rejects(loadMachineryAsset('crane', { baseUrl: publicBase.href, fetcher }), /rotation|boom|outrigger/);
  }
});

test('crane elevation uses the measured hinge and preserves fixed cab and chassis vertices', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const elevation = asset.config.elevation, source = asset.sourcePositions, moving = new Set<number>();
  const addRanges = (ranges: readonly (readonly [number, number])[]) => { for (const [start, count] of ranges) for (let i = start; i < start + count; i++) moving.add(i); };
  for (const ranges of [elevation.boom_vertex_ranges, elevation.hanging_vertex_ranges, elevation.rigging_vertex_ranges]) addRanges(ranges);
  for (const index of [...elevation.rope_upper_vertex_indices, ...elevation.rope_lower_vertex_indices]) moving.add(index);
  for (const cylinder of elevation.hydraulics) { addRanges(cylinder.barrel_vertex_ranges); addRanges(cylinder.rod_vertex_ranges); }
  for (const angle of [0, 30, 60, 90]) {
    const params = resolveMachineryParameters(asset, defaults, { boom_elevation_deg: angle });
    const after = computeMachinerySourcePositions(asset, params);
    // Source vertices37347→40508 form a long telescopic-section edge parallel to its centreline.
    const edge = [0, 1, 2].map(axis => after[40508 * 3 + axis] - after[37347 * 3 + axis]);
    near(Math.atan2(edge[1], Math.hypot(edge[0], edge[2])) * 180 / Math.PI, angle, 1e-6);
    for (let vertex = 0; vertex < asset.partIds.length; vertex++) if (!moving.has(vertex)) for (let axis = 0; axis < 3; axis++) assert.equal(after[vertex * 3 + axis], source[vertex * 3 + axis]);
    for (const [start, count] of elevation.boom_vertex_ranges) for (let vertex = start; vertex < start + count; vertex++) {
      const beforeRadius = Math.hypot(...[0, 1, 2].map(axis => source[vertex * 3 + axis] - elevation.hinge_m[axis]));
      near(Math.hypot(...[0, 1, 2].map(axis => after[vertex * 3 + axis] - elevation.hinge_m[axis])), beforeRadius, 1e-12);
    }
    const geometry = computeMachineryGeometry(asset, params);
    near(params.overall_height_m, geometry.bounds.size[1]); assert.equal(originalMachineryProportionsMaintained(asset, params), true);
    assert.deepEqual(geometry.sourceAnchor, asset.config.reference_dimensions.anchor_m);
    if (angle === 0) assert.ok(geometry.bounds.min[1] < -0.19, 'low hanging hook is reported below the unchanged ground anchor');
  }
});

test('crane hanging block stays upright and rope bundle suspension direction is preserved after elevation', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const elevation = asset.config.elevation;
  const base = resolveMachineryParameters(asset, defaults, { boom_length_m: defaults.boom_length_m + 1 }, { proportional: false });
  const before = computeMachinerySourcePositions(asset, base);
  const mean = (positions: Float64Array, indices: readonly number[], axis: number) => indices.reduce((sum, index) => sum + positions[index * 3 + axis], 0) / indices.length;
  for (const angle of [0, 30, 60, 90]) {
    const after = computeMachinerySourcePositions(asset, resolveMachineryParameters(asset, base, { boom_elevation_deg: angle }, { proportional: false }));
    const first = elevation.hanging_vertex_ranges[0][0], delta = [0, 1, 2].map(axis => after[first * 3 + axis] - before[first * 3 + axis]);
    for (const [start, count] of elevation.hanging_vertex_ranges) for (let vertex = start; vertex < start + count; vertex++) for (let axis = 0; axis < 3; axis++) near(after[vertex * 3 + axis] - before[vertex * 3 + axis], delta[axis], 1e-12);
    for (let axis = 0; axis < 3; axis++) {
      const sourceDirection = mean(before, elevation.rope_upper_vertex_indices, axis) - mean(before, elevation.rope_lower_vertex_indices, axis);
      const posedDirection = mean(after, elevation.rope_upper_vertex_indices, axis) - mean(after, elevation.rope_lower_vertex_indices, axis);
      near(posedDirection, sourceDirection, 1e-12);
    }
  }
});

test('crane hydraulic barrels remain rigid at fixed pins and rods remain rigid at moving boom pins', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const elevation = asset.config.elevation, source = asset.sourcePositions;
  const pitch = (point: readonly number[], degrees: number) => {
    const h = elevation.hinge_m, [kx, ky, kz] = elevation.axis, [x, y, z] = point.map((value, i) => value - h[i]);
    const angle = (degrees - defaults.boom_elevation_deg) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle), dot = x * kx + y * ky + z * kz;
    return [h[0] + x * c + (ky * z - kz * y) * s + kx * dot * (1 - c), h[1] + y * c + (kz * x - kx * z) * s + ky * dot * (1 - c), h[2] + z * c + (kx * y - ky * x) * s + kz * dot * (1 - c)];
  };
  for (const angle of [0, 30, 60, 90]) {
    const after = computeMachinerySourcePositions(asset, resolveMachineryParameters(asset, defaults, { boom_elevation_deg: angle }));
    for (const cylinder of elevation.hydraulics) {
      const attachment = pitch(cylinder.attachment_m, angle);
      for (const [ranges, oldPin, newPin] of [[cylinder.barrel_vertex_ranges, cylinder.base_m, cylinder.base_m], [cylinder.rod_vertex_ranges, cylinder.attachment_m, attachment]] as const) {
        const first = ranges[0][0];
        for (const [start, count] of ranges) for (let vertex = start; vertex < start + count; vertex++) {
          near(Math.hypot(...[0, 1, 2].map(axis => after[vertex * 3 + axis] - newPin[axis])), Math.hypot(...[0, 1, 2].map(axis => source[vertex * 3 + axis] - oldPin[axis])), 1e-12);
          near(Math.hypot(...[0, 1, 2].map(axis => after[vertex * 3 + axis] - after[first * 3 + axis])), Math.hypot(...[0, 1, 2].map(axis => source[vertex * 3 + axis] - source[first * 3 + axis])), 1e-12);
        }
      }
    }
  }
});

test('crane extension fixes winch and base-boom cable guide while elevation composes with slew and scale', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset);
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const elevation = asset.config.elevation;
  const extended = resolveMachineryParameters(asset, defaults, { boom_length_m: 5 }, { proportional: false });
  const extensionGeometry = computeMachinerySourcePositions(asset, extended);
  for (const vertex of elevation.rigging_extension_fixed_vertex_indices) for (let axis = 0; axis < 3; axis++) assert.equal(extensionGeometry[vertex * 3 + axis], asset.sourcePositions[vertex * 3 + axis]);
  const pitched = resolveMachineryParameters(asset, extended, { boom_elevation_deg: 30 }, { proportional: false });
  const before = computeMachinerySourcePositions(asset, pitched);
  for (const vertex of elevation.rigging_fixed_vertex_indices) for (let axis = 0; axis < 3; axis++) assert.equal(before[vertex * 3 + axis], asset.sourcePositions[vertex * 3 + axis]);
  const combined = resolveMachineryParameters(asset, pitched, { boom_rotation_deg: 90, overall_scale: 2 }, { proportional: false });
  const after = computeMachinerySourcePositions(asset, combined), anchor = asset.config.reference_dimensions.anchor_m, [cx, , cz] = asset.config.rotation.pivot_m;
  assert.equal(combined.boom_elevation_deg, 30); assert.equal(combined.boom_rotation_deg, 90); assert.equal(combined.boom_length_m, 10);
  for (const [start, count] of asset.config.rotation.vertex_ranges) for (let vertex = start; vertex < start + count; vertex++) {
    near(after[vertex * 3], anchor[0] + 2 * (cx - (before[vertex * 3 + 2] - cz) - anchor[0]), 1e-12);
    near(after[vertex * 3 + 1], anchor[1] + 2 * (before[vertex * 3 + 1] - anchor[1]), 1e-12);
    near(after[vertex * 3 + 2], anchor[2] + 2 * (cz + (before[vertex * 3] - cx) - anchor[2]), 1e-12);
  }
});

test('crane posed total-height edits reach requested height and legacy elevation restores exact source', async () => {
  const asset = await model('crane'), defaults = defaultMachineryParameters(asset), legacy = { ...defaults }; delete legacy.boom_elevation_deg;
  assert.deepEqual(resolveMachineryParameters(asset, legacy, {}), defaults);
  assert.deepEqual(computeMachinerySourcePositions(asset, legacy), asset.sourcePositions);
  for (const angle of [0, 30, 60, 90]) for (const proportional of [true, false]) {
    const posed = resolveMachineryParameters(asset, defaults, { boom_elevation_deg: angle, boom_rotation_deg: 137 });
    const resized = resolveMachineryParameters(asset, posed, { overall_height_m: 7 }, { proportional });
    assert.equal(resized.boom_elevation_deg, angle); assert.equal(resized.boom_rotation_deg, 137);
    near(resized.overall_height_m, 7); near(computeMachineryGeometry(asset, resized).bounds.size[1], 7);
    assert.equal(originalMachineryProportionsMaintained(asset, resized), true);
  }
  for (const value of [-1, 90.001, 360, NaN, Infinity, null, '', true, [], {}]) assert.throws(() => resolveMachineryParameters(asset, defaults, { boom_elevation_deg: value }), /0 至 90/);
  assert.deepEqual(computeMachinerySourcePositions(asset, defaultMachineryParameters(asset)), asset.sourcePositions);
});

test('invalid elevation baseline, group overlap and fixed cable anchor are rejected by the asset loader', async () => {
  const original = JSON.parse(await readFile(new URL('crane/manifest.json', publicBase), 'utf8'));
  for (const corrupt of [
    (manifest: typeof original) => { manifest.config.elevation.original_degrees = 0; },
    (manifest: typeof original) => { manifest.config.elevation.boom_vertex_ranges = manifest.config.elevation.hanging_vertex_ranges; },
    (manifest: typeof original) => { manifest.config.elevation.rigging_fixed_vertex_indices = [0]; },
  ]) {
    const modified = structuredClone(original); corrupt(modified);
    const fetcher: typeof fetch = async (input, options) => String(input).endsWith('manifest.json') ? new Response(JSON.stringify(modified)) : fileFetch(input, options);
    await assert.rejects(loadMachineryAsset('crane', { baseUrl: publicBase.href, fetcher }), /elevation|anchor/);
  }
});
