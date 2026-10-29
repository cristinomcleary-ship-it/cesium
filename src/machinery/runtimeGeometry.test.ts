import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadMachineryAsset } from './assets.ts';
import { computeMachineryGeometry, defaultMachineryParameters, resolveMachineryParameters } from './engine.ts';
import { createMachineryRuntimeGlb, createMachineryRuntimeShader, evaluateMachineryRuntimePositions, updateMachineryRuntimeShader } from './runtimeGeometry.ts';
import type { MachineryModelId } from './types.ts';
const fetcher: typeof fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://test.local');
  return new Response(new Uint8Array(await readFile(new URL(`../../public/${url.pathname.slice(1)}`, import.meta.url))));
};

test('persistent GPU coefficients and matrices reproduce every authoritative source vertex across mixed machinery poses', async () => {
  for (const id of ['crane', 'pile', 'excavator'] as MachineryModelId[]) {
    const asset = await loadMachineryAsset(id, { fetcher }), defaults = defaultMachineryParameters(asset);
    const cases = id === 'crane' ? [
      {}, { boom_rotation_deg: 90 }, { boom_rotation_deg: 359, boom_elevation_deg: 0 },
      { boom_rotation_deg: 1, boom_elevation_deg: 90 }, { overall_scale: 4, boom_length_m: 20, boom_elevation_deg: 35, boom_rotation_deg: 213 },
      { overall_scale: 0.2, boom_length_m: 2, outrigger_lateral_m: 1, outrigger_longitudinal_m: 1.5, boom_elevation_deg: 17, boom_rotation_deg: 78 },
    ] : id === 'pile' ? [{}, { total_height_m: 60 }, { overall_scale: 10, total_height_m: 80 }] : [{}, { overall_scale: 3.7 }];
    const shader = createMachineryRuntimeShader(asset);
    try {
      for (const patch of cases) {
        const p = resolveMachineryParameters(asset, defaults, patch, { proportional: false });
        const expected = computeMachineryGeometry(asset, p).positions, actual = evaluateMachineryRuntimePositions(asset, p);
        let maxError = 0;
        for (let i = 0; i < expected.length; i++) maxError = Math.max(maxError, Math.abs(expected[i] - actual[i]));
        assert.ok(maxError < 1e-8, `${id} ${JSON.stringify(patch)} vertex error ${maxError}`);
        const bound = updateMachineryRuntimeShader(shader, asset, p);
        for (let i = 0; i < actual.length; i += 3) assert.ok(Math.hypot(actual[i], actual[i + 1], actual[i + 2]) <= bound,
          `${id} dynamic model scale must enclose GPU-deformed geometry`);
      }
    } finally { shader.destroy(); }
  }
});

test('runtime GLB topology stays immutable, carries all triangles and has truthful finite unit bounds', async () => {
  const asset = await loadMachineryAsset('crane', { fetcher });
  const bytes = createMachineryRuntimeGlb(asset), view = new DataView(bytes);
  const jsonLength = view.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  assert.equal(view.getUint32(8, true), bytes.byteLength);
  assert.equal(json.accessors[0].count, asset.indices.length + 6);
  assert.deepEqual(json.meshes[0].primitives[0].attributes, { POSITION: 0, COLOR_0: 1, _MOTION: 2 });
  const points = new Float32Array(bytes, 28 + jsonLength, json.accessors[0].count * 3);
  for (const value of points) assert.ok(Number.isFinite(value) && Math.abs(value) <= 1);
  assert.deepEqual(json.accessors[0].min, [-1, -1, -1]); assert.deepEqual(json.accessors[0].max, [1, 1, 1]);
  assert.deepEqual(createMachineryRuntimeGlb(asset), bytes);
});
