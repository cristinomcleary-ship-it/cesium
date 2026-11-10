import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Cartesian2, Cartesian3, Color, ColorBlendMode, Matrix4 } from 'cesium';

// Execute the shipped signature method; GL/video encoding is covered separately
// by the browser acceptance. No controller constructor or DOM is needed here.
const workspace = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(workspace, '.video-overlay-cache-signature-'));
let VideoModelOverlay, applyModelAppearance;
try {
  await build({ stdin: { contents: 'export { VideoModelOverlay } from "./src/videoModelOverlay.ts"; export { applyModelAppearance } from "./src/modelAppearance.ts";', resolveDir: workspace, loader: 'ts' },
    outfile: join(directory, 'fixture.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  ({ VideoModelOverlay, applyModelAppearance } = await import(pathToFileURL(join(directory, 'fixture.mjs')).href));
} finally { await rm(directory, { recursive: true, force: true }); }

const translated = x => Matrix4.fromTranslation(new Cartesian3(x, 0, 0));
const range = { start: 0, end: 2 };
function fixture() {
  const model = { modelMatrix: translated(1), scale: 1 };
  const item = { id: 'model', kind: 'Model', resource: model };
  const record = { updatedAt: 'saved-version', files: { model: { name: 'model.glb' } }, settings: { matrix: Matrix4.toArray(model.modelMatrix), opacity: 1 } };
  const owner = Object.assign(Object.create(VideoModelOverlay.prototype), {
    selected: new Set(['model']), occlusion: { enabled: false }, resourceMatricesBeforeAR: new Map(),
    options: { getImports: () => [item], getRecord: () => record },
    adjustments: { model: { east: 0, north: 0, up: 0, heading: 0, tiltEast: 8, tiltNorth: -6 } },
    opacity: 1, readTiming: () => ({ intervalSeconds: 1 }), el: () => ({ checked: false }),
    metadata: { width: 640, height: 360 },
  });
  return { owner, model, item, record, signature: () => owner.cacheSignature(range) };
}

test('unsaved map placement invalidates cache despite stale persisted matrix', () => {
  const { model, record, signature } = fixture(), previous = signature();
  const persisted = structuredClone(record);
  model.modelMatrix = translated(12);
  assert.deepEqual(record, persisted, 'Simulate a delayed or failed library PATCH');
  assert.notEqual(signature(), previous);
  assert.deepEqual(JSON.parse(signature()).resources[0].matrix, Matrix4.toArray(model.modelMatrix));
});

test('temporary AR transforms do not change the base placement fingerprint across entry and exit', () => {
  const { owner, model, signature } = fixture();
  model.modelMatrix = translated(12);
  const before = signature();
  owner.resourceMatricesBeforeAR.set('model', Matrix4.toArray(model.modelMatrix));
  owner.restoreScene = () => {};
  model.modelMatrix = translated(99); // The AR scheme temporarily transforms the displayed resource.
  assert.equal(signature(), before);
  owner.adjustments.model.tiltEast += 0.1;
  assert.notEqual(signature(), before, 'Scheme tilt still independently invalidates the cache');
  owner.adjustments.model.tiltEast = 8;
  model.modelMatrix = translated(12);
  owner.restoreScene = undefined;
  assert.equal(signature(), before, 'Cache-player installation and exit restore the original fingerprint');
});

test('resources without a runtime matrix retain saved placement and other cache dependencies', () => {
  const { owner, model, item, record, signature } = fixture();
  item.kind = 'CAD'; delete model.modelMatrix;
  const before = signature();
  assert.deepEqual(JSON.parse(before).resources[0].matrix, record.settings.matrix);
  owner.restoreScene = () => {};
  assert.equal(signature(), before);
  for (const change of [() => { record.settings.opacity = 0.5; }, () => { record.files.model.name = 'replacement.glb'; },
    () => { record.updatedAt = 'new-version'; }, () => { model.scale = 2; }]) {
    const previous = signature(); change(); assert.notEqual(signature(), previous);
  }
});

test('whole-group angles and the saved common pivot each invalidate baked frames', () => {
  const { owner, signature } = fixture();
  const before = signature();
  owner.groupAdjustment = { anchor: [6378137, 0, 0], values: { east: 0, north: 0, up: 0, heading: 0, tiltEast: .1, tiltNorth: -.2 } };
  const tilted = signature(); assert.notEqual(tilted, before);
  owner.groupAdjustment.values.tiltNorth += .1;
  const otherAxis = signature(); assert.notEqual(otherAxis, tilted);
  owner.groupAdjustment.anchor[1] += 10;
  assert.notEqual(signature(), otherAxis);
  owner.groupAdjustment = undefined; assert.equal(signature(), before);
});

test('draped CAD cache depends on receiving models even when they are not visible overlays', () => {
  const { owner, model, item, record, signature } = fixture();
  const cad = { id: 'cad', kind: 'CAD', resource: {} };
  const cadRecord = { settings: { displayMode: 'model' }, files: {} };
  owner.options = { getImports: () => [cad, item], getRecord: id => id === 'cad' ? cadRecord : record };
  owner.selected = new Set(['cad']);
  const before = signature();
  model.modelMatrix = translated(8);
  assert.notEqual(signature(), before, 'Hidden receiver movement must invalidate frozen CAD geometry');
});


test('annotation changes retain the base movie while resource presentation changes invalidate it', () => {
  const { owner, signature } = fixture();
  const base = signature();
  owner.annotations = [{ text: 'new label' }];
  owner.spatialAnnotations = [{ targetId: 'model', points: [{ x: 1, y: 2, z: 3 }] }];
  assert.equal(signature(), base);
  owner.annotations[0].text = 'edited label'; owner.spatialAnnotations = [];
  assert.equal(signature(), base, 'Deleting or editing marks cannot discard frame alignment');
  owner.effects = [{ targetId: 'model', opacity: 0.5 }];
  assert.notEqual(signature(), base, 'Model visibility/fade effects remain part of the base movie');
});


test('unsaved user appearance changes invalidate the base cache without depending on a library PATCH', () => {
  const { model, record, signature } = fixture();
  Object.assign(model, { color: Color.clone(Color.WHITE), colorBlendMode: ColorBlendMode.HIGHLIGHT, colorBlendAmount: 0.5,
    isDestroyed: () => false, imageBasedLighting: { imageBasedLightingFactor: new Cartesian2(1, 1) } });
  const base = signature(), saved = structuredClone(record);
  applyModelAppearance(model, { version: 1, colorMode: 'replace', color: '#ff0000', lighting: 'bright', brightness: 1.5 });
  assert.notEqual(signature(), base); assert.deepEqual(record, saved);
  const applied = signature(); model.color.alpha = 0.25;
  assert.equal(signature(), applied, 'Temporary AR transparency must not alter the saved user appearance fingerprint');
});
