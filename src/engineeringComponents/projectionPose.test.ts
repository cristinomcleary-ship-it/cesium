import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, Matrix3, Matrix4, type Model } from 'cesium';
import { engineeringRuntimeNodeTransforms, engineeringWorldFromGltf } from './projectionPose.ts';

function fixture() {
  const model = { ready: true, destroyed: false, show: false, isDestroyed() { return this.destroyed; },
    minimumPixelSize: 0, activeAnimations: { length: 0 }, scale: 2, maximumScale: undefined as number | undefined,
    modelMatrix: Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(Math.PI / 2), new Cartesian3(100, 200, 300)),
    _sceneGraph: { components: { transform: Matrix4.fromTranslation(new Cartesian3(2, 3, 4)) },
      axisCorrectionMatrix: Matrix4.fromRotationTranslation(Matrix3.fromRotationX(Math.PI / 2)),
      _computedModelMatrix: Matrix4.clone(Matrix4.IDENTITY),
      _runtimeNodes: [{ computedTransform: Matrix4.fromTranslation(new Cartesian3(4, 5, 6)), userAnimated: false }] },
  };
  return { model, asModel: () => model as unknown as Model };
}

test('world projection follows component transform, axis conversion, scale and node ancestry at the current hidden-model placement', () => {
  const f = fixture(), before = Matrix4.toArray(f.model._sceneGraph._computedModelMatrix);
  const world = Matrix4.fromArray(engineeringWorldFromGltf(f.asModel()));
  const nodes = engineeringRuntimeNodeTransforms(f.asModel(), [{ componentId: 'C', nodeIndices: [0] }]);
  const local = Matrix4.multiplyByPoint(Matrix4.fromArray(nodes[0].matrix), new Cartesian3(1, 2, 3), new Cartesian3());
  const point = Matrix4.multiplyByPoint(world, local, new Cartesian3());
  // Manual arithmetic: node -> (5,7,9), scale -> (10,14,18), X90
  // -> (10,-18,14), asset translation -> (12,-15,18), Z90 + placement.
  assert.ok(Cartesian3.equalsEpsilon(point, new Cartesian3(115, 212, 318), 1e-13));
  assert.deepEqual(Matrix4.toArray(f.model._sceneGraph._computedModelMatrix), before, 'read-only projection must not update Cesium matrices');
  Matrix4.setTranslation(f.model.modelMatrix, new Cartesian3(1100, 200, 300), f.model.modelMatrix);
  const moved = Matrix4.multiplyByPoint(Matrix4.fromArray(engineeringWorldFromGltf(f.asModel())), local, new Cartesian3());
  assert.ok(Math.abs(moved.x - point.x - 1000) < 1e-10, 'Model.show=false must not freeze the public placement used by clipping');
});

test('maximumScale limits the physical projection and unsupported screen-sized or animated models are rejected', () => {
  const f = fixture(); f.model.maximumScale = 1;
  const matrix = Matrix4.fromArray(engineeringWorldFromGltf(f.asModel()));
  assert.ok(Math.abs(Matrix4.getMaximumScale(matrix) - 1) < 1e-12);
  f.model.minimumPixelSize = 2; assert.throws(() => engineeringWorldFromGltf(f.asModel()), /静态|真实比例/);
  f.model.minimumPixelSize = 0; f.model.activeAnimations.length = 1;
  assert.throws(() => engineeringWorldFromGltf(f.asModel()), /静态|真实比例/);
  f.model.activeAnimations.length = 0; f.model.scale = NaN;
  assert.throws(() => engineeringWorldFromGltf(f.asModel()), /比例无效/);
});

test('missing, user-modified and invalid pose state cannot silently replace the geometry footprint', () => {
  const f = fixture(); f.model.ready = false;
  assert.throws(() => engineeringWorldFromGltf(f.asModel()), /尚未就绪/); f.model.ready = true;
  Matrix4.setTranslation(f.model.modelMatrix, new Cartesian3(Infinity, 200, 300), f.model.modelMatrix);
  assert.throws(() => engineeringWorldFromGltf(f.asModel()), /无效数值/);
  const bindings = [{ componentId: 'C', nodeIndices: [0] }];
  f.model._sceneGraph._runtimeNodes[0].userAnimated = true;
  assert.throws(() => engineeringRuntimeNodeTransforms(f.asModel(), bindings), /节点变换/);
  f.model._sceneGraph._runtimeNodes.length = 0;
  assert.throws(() => engineeringRuntimeNodeTransforms(f.asModel(), bindings), /节点变换/);
});
