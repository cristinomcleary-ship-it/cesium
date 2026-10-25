import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundingSphere, Cartesian3, CustomShader, JulianDate, Matrix4, PrimitiveCollection, Transforms, type Cesium3DTileset, type Viewer } from 'cesium';
import { ElectronicSandTablePresentation } from './electronicSandTablePresentation.ts';
import { VideoOverlayResources } from './videoOverlayResources.ts';
import type { ImportRecord } from './types.ts';

type ContourState = { tileset: Cesium3DTileset; shader: CustomShader; previousCustomShader?: CustomShader; name: string };
type ContourOwner = { tilesetContours: Map<Cesium3DTileset, ContourState>; releaseTilesetContour(state: ContourState): void };

// Call the production release method while avoiding unrelated DOM setup. Shader
// creation/destruction is real Cesium, including its destroyed-object contract.
function contour(previousCustomShader?: CustomShader) {
  const center = Cartesian3.fromDegrees(120, 30, 25), shader = new CustomShader({});
  const tileset = { customShader: shader, show: true, isDestroyed: () => false,
    modelMatrix: Transforms.eastNorthUpToFixedFrame(center), boundingSphere: new BoundingSphere(center, 20) } as unknown as Cesium3DTileset;
  const state = { tileset, shader, previousCustomShader, name: 'survey contour' };
  const owner = Object.assign(Object.create(ElectronicSandTablePresentation.prototype), {
    tilesetContours: new Map([[tileset, state]]),
  }) as ContourOwner;
  return { owner, state, tileset, shader };
}

test('contour exit restores a live original shader exactly and releases only its own shader', () => {
  const previous = new CustomShader({}), h = contour(previous), matrix = h.tileset.modelMatrix;
  h.owner.releaseTilesetContour(h.state);
  assert.equal(h.tileset.customShader, previous); assert.equal(previous.isDestroyed(), false);
  assert.equal(h.shader.isDestroyed(), true); assert.equal(h.owner.tilesetContours.size, 0);
  assert.equal(h.tileset.modelMatrix, matrix); assert.equal(h.tileset.show, true);
  previous.destroy();
});

test('contour exit never reinstalls a destroyed previous shader and preserves a replacement owner', () => {
  for (const replaced of [false, true]) {
    const previous = new CustomShader({}), h = contour(previous);
    previous.destroy();
    const external = replaced ? new CustomShader({}) : undefined;
    if (external) h.tileset.customShader = external;
    assert.doesNotThrow(() => { h.owner.releaseTilesetContour(h.state); h.owner.releaseTilesetContour(h.state); });
    assert.equal(h.tileset.customShader, external); assert.equal(h.shader.isDestroyed(), true);
    assert.equal(h.owner.tilesetContours.size, 0);
    if (external) { assert.equal(external.isDestroyed(), false); external.destroy(); }
  }
});

test('AR exit after contour cleanup does not revive the contour shader released during its temporary override', async () => {
  const h = contour(), matrix = Matrix4.clone(h.tileset.modelMatrix);
  const imported = { id: 'survey', name: 'survey', kind: '3D Tiles', visible: true, resource: h.tileset } as ImportRecord;
  const viewer = { clock: { currentTime: JulianDate.now() }, scene: { primitives: new PrimitiveCollection(), requestRender() {} } } as unknown as Viewer;
  const session = await VideoOverlayResources.create({ viewer, imports: () => [imported], getRecord: () => undefined });
  session.setSelection(['survey']); session.setTimelineOpacity({ survey: { opacity: .5, visible: true } });
  const arShader = h.tileset.customShader!;
  assert.notEqual(arShader, h.shader);
  h.owner.releaseTilesetContour(h.state);
  assert.equal(h.shader.isDestroyed(), true); assert.equal(h.tileset.customShader, arShader);
  assert.doesNotThrow(() => session.restore());
  assert.equal(h.tileset.customShader, undefined, 'the model renders with its original material, without the released contour override');
  assert.equal(arShader.isDestroyed(), true);
  assert.ok(Matrix4.equals(h.tileset.modelMatrix, matrix)); assert.equal(h.tileset.show, true); assert.equal(imported.visible, true);
});
