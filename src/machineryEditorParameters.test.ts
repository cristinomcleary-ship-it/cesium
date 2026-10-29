import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMachineryAsset, defaultMachineryParameters, resolveMachineryParameters } from './machinery/index';
import { machineryParameterForEditor, machineryParameterFromEditor } from './machineryEditorParameters';
import { canonicalBoomToSource } from './machineryTelemetry';
const assetPromise = loadMachineryAsset('crane', { baseUrl: new URL('../public/machinery/', import.meta.url).href,
  fetcher: async input => new Response(new Uint8Array(await readFile(fileURLToPath(String(input))))) });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('legacy source angles display canonical and exact save round trips never move existing machinery', async () => {
  const asset = await assetPromise;
  for (const previousStored of [0, 15, 180, 269.123456789, 359.999999999]) {
    const shown = machineryParameterForEditor(asset, 'boom_rotation_deg', previousStored);
    assert.ok(shown >= 0 && shown < 360);
    assert.equal(machineryParameterFromEditor(asset, 'boom_rotation_deg', shown, previousStored), previousStored);
    if (shown === 0) assert.equal(machineryParameterFromEditor(asset, 'boom_rotation_deg', 360, previousStored), previousStored);
  }
});
test('manual 0, 90 and 180 use the sensor convention without a second 180-degree rotation', async () => {
  const asset = await assetPromise;
  assert.equal(asset.config.type, 'crane'); if (asset.config.type !== 'crane') return;
  const yaw = Math.atan2(asset.config.boom.axis[2], asset.config.boom.axis[0]) * 180 / Math.PI;
  for (const shown of [0, 90, 180, 270, 360]) {
    const stored = machineryParameterFromEditor(asset, 'boom_rotation_deg', shown);
    near(stored, canonicalBoomToSource(asset, shown));
    near((yaw + stored) % 360, (shown + 180) % 360);
    near(machineryParameterForEditor(asset, 'boom_rotation_deg', stored), shown % 360);
  }
});
test('resetting dimensions preserves displayed relative yaw and independent elevation', async () => {
  const asset = await assetPromise;
  const defaults = defaultMachineryParameters(asset);
  const parameters = resolveMachineryParameters(asset, defaults, {
    boom_rotation_deg: machineryParameterFromEditor(asset, 'boom_rotation_deg', 0), boom_elevation_deg: 30,
  }, { proportional: false });
  near(machineryParameterForEditor(asset, 'boom_rotation_deg', parameters.boom_rotation_deg), 0);
  assert.equal(parameters.boom_elevation_deg, 30);
  assert.equal(machineryParameterForEditor(asset, 'boom_elevation_deg', 30), 30);
  assert.equal(machineryParameterFromEditor(asset, 'boom_length_m', 12, 3), 12);
});
test('calibrated front axis is applied once consistently to manual editor and telemetry', async () => {
  const asset = await assetPromise;
  for (const front of [0, 25, 180]) {
    const stored = machineryParameterFromEditor(asset, 'boom_rotation_deg', 90, undefined, front);
    near(machineryParameterForEditor(asset, 'boom_rotation_deg', stored, front), 90);
    near(stored, canonicalBoomToSource(asset, 90, front));
  }
});


test('editor input rejects out-of-range and nonfinite yaw before normalization; 360 remains a valid zero', async () => {
  const asset = await assetPromise;
  for (const value of [-1, 361, NaN, Infinity, -Infinity]) assert.throws(() => machineryParameterFromEditor(asset, 'boom_rotation_deg', value), /0 至 360/);
  near(machineryParameterFromEditor(asset, 'boom_rotation_deg', 360), machineryParameterFromEditor(asset, 'boom_rotation_deg', 0));
});
