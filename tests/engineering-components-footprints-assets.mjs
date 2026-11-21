// Real source-package CPU acceptance. Reads models in place; writes only metrics.
// CESIUM_ENGINEERING_ASSETS_DIR=... node --experimental-strip-types tests/engineering-components-footprints-assets.mjs [A001|TN021|full]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Axis, Cartesian3, Matrix4, Transforms } from '@cesium/engine';
import { EngineeringFootprintGeometry } from '../src/engineeringComponents/footprints.ts';

const source = process.env.CESIUM_ENGINEERING_ASSETS_DIR;
if (!source) throw new Error('Set CESIUM_ENGINEERING_ASSETS_DIR to the original, read-only reconstructed package.');
const selected = process.argv[2] ? [process.argv[2]] : ['A001', 'TN021', 'full'];
if (selected.some(name => !['A001', 'TN021', 'full'].includes(name))) throw new Error('Expected A001, TN021, or full.');
const output = resolve('output/engineering-footprints-assets'); await mkdir(output, { recursive: true });
const readJson = async relative => JSON.parse(await readFile(join(source, relative), 'utf8'));
const index = await readJson('structure-library/index.json'), catalog = await readJson('components.json');
const physical = new Set(catalog.components.map(component => component.id));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 100));
const correction = Matrix4.multiply(Axis.Y_UP_TO_Z_UP, Axis.Z_UP_TO_X_UP, new Matrix4());
const world = Matrix4.toArray(Matrix4.multiply(frame, correction, new Matrix4()));
const expected = { A001: [6, 1016], TN021: [199, 7388], full: [25258, 805322] };
const reports = [];
for (const name of selected) {
  const relative = name === 'full' ? 'models/Jiashan.glb' : `${index[name].path}/model.glb`;
  const buffer = await readFile(join(source, relative)), sourceHash = digest(buffer);
  const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)));
  const bindings = json.nodes.flatMap((node, nodeIndex) => node.mesh !== undefined && physical.has(node.extras?.componentId)
    ? [{ componentId: node.extras.componentId, nodeIndices: [nodeIndex] }] : []);
  let declaredTriangleCount = 0;
  for (const binding of bindings) for (const n of binding.nodeIndices) for (const primitive of json.meshes[json.nodes[n].mesh].primitives)
    declaredTriangleCount += (primitive.indices === undefined ? json.accessors[primitive.attributes.POSITION].count : json.accessors[primitive.indices].count) / 3;
  const geometry = new EngineeringFootprintGeometry(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), bindings);
  const result = await geometry.project(world, bindings.map(binding => binding.componentId));
  assert.equal(bindings.length, expected[name][0]); assert.equal(declaredTriangleCount, expected[name][1]);
  assert.equal(result.componentCount, bindings.length); assert.equal(result.triangleCount, declaredTriangleCount);
  assert.ok(result.rawAreaSquareMeters > 0); assert.ok(result.footprints.length > 0);
  assert.ok(Math.abs(result.rawAreaSquareMeters - result.compiledAreaSquareMeters) <= result.rawAreaSquareMeters * 1e-10);
  assert.equal(result.quantizationGridMeters, 1e-8);
  assert.ok(result.maxQuantizationErrorMeters <= 5.01e-9);
  assert.ok(result.quantizationDisplacementBudgetMeters <= 5e-8);
  assert.equal(digest(await readFile(join(source, relative))), sourceHash, 'source GLB must remain unchanged');
  if (name !== 'full') assert.equal(sourceHash, index[name].sha256);
  else assert.equal(sourceHash, '0a767961b6ba11845ef1fd7c8e4932ee3e8c57d771f967d2736cca94d4f70eac');
  const { footprints, ...statistics } = result;
  reports.push({ name, sourceHash, declaredTriangleCount, ...statistics });
  console.log(`PASS ${name}: ${result.componentCount} components, ${result.triangleCount} triangles, ${result.polygons} clipping polygons, ${result.milliseconds.toFixed(1)} ms`);
}
await writeFile(join(output, 'report.json'), JSON.stringify({ timestamp: new Date().toISOString(), reports }, null, 2));
