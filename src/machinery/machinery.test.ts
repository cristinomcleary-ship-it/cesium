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
      const changed = resolveMachineryParameters(asset, defaults, { [definition.key]: definition.original * 2 });
      near(changed.overall_scale, 2);
      for (const parameter of asset.config.parameters) near(changed[parameter.key], parameter.original * 2);
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
  test(`${entry.id}: GLB is metre Y-up at ground anchor, with finite unit normals and source palette colors`, async () => {
    const asset = await model(entry.id), params = defaultMachineryParameters(asset);
    const { document, arrays: [positions, normals, colors] } = parseGlb(createMachineryGlb(asset, params));
    assert.equal(document.extras.units, 'm'); assert.equal(document.extras.coordinateSystem, 'Y-up');
    assert.deepEqual(document.extras.placementAnchor, [0, 0, 0]); assert.equal(document.extras.assetVersion, MACHINERY_ASSET_VERSION);
    near(document.accessors[0].min![1], 0, 1e-8);
    assert.equal(positions.length, normals.length); assert.equal(positions.length, colors.length);
    const palette = new Set<string>(); for (let i = 0; i < asset.palette.length; i += 3) palette.add(Array.from(asset.palette.subarray(i, i + 3)).join(','));
    for (let i = 0; i < positions.length; i += 3) {
      assert.ok(Number.isFinite(positions[i]) && Number.isFinite(positions[i + 1]) && Number.isFinite(positions[i + 2]));
      near(Math.hypot(normals[i], normals[i + 1], normals[i + 2]), 1, 1e-6);
      assert.ok(palette.has(Array.from(colors.subarray(i, i + 3)).join(',')));
    }
    assert.equal(positions.length / 9 + Number(document.extras.removedDegenerateTriangles), asset.indices.length / 3);
  });
}

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
