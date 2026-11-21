import { Matrix4, type Model } from 'cesium';
import type { EngineeringBinding } from './catalog';

type RuntimeNode = { computedTransform: Matrix4; userAnimated?: boolean };
type RuntimeModel = Model & { _sceneGraph?: {
  components: { transform: Matrix4 }; axisCorrectionMatrix: Matrix4;
  _runtimeNodes: (RuntimeNode | undefined)[];
} };

/** Same transform order as the pinned ModelSceneGraph. Compute from the current
 * public placement even when Model.show=false prevents Cesium's update loop. */
export function engineeringWorldFromGltf(model: Model): number[] {
  const runtime = model as RuntimeModel, graph = runtime._sceneGraph;
  if (!model.ready || model.isDestroyed() || !graph?.components?.transform || !graph.axisCorrectionMatrix) throw new Error('工程模型尚未就绪，无法核对摄影遮挡坐标。');
  if (model.minimumPixelSize !== 0 || model.activeAnimations.length) throw new Error('摄影遮挡要求静态工程模型和真实比例，不能使用屏幕最小尺寸或动画。');
  const scale = Math.min(model.scale, model.maximumScale ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('工程模型比例无效，摄影遮挡未更新。');
  const matrix = Matrix4.multiplyTransformation(model.modelMatrix, graph.components.transform, new Matrix4());
  Matrix4.multiplyTransformation(matrix, graph.axisCorrectionMatrix, matrix);
  Matrix4.multiplyByUniformScale(matrix, scale, matrix);
  const values = Matrix4.toArray(matrix);
  if (values.some(value => !Number.isFinite(value))) throw new Error('工程模型定位矩阵含无效数值。');
  return values;
}

export function engineeringRuntimeNodeTransforms(model: Model, bindings: readonly EngineeringBinding[]) {
  const nodes = (model as RuntimeModel)._sceneGraph?._runtimeNodes;
  if (!nodes) throw new Error('工程节点变换尚未就绪。');
  const indices = new Set(bindings.flatMap(binding => [...binding.nodeIndices]));
  return [...indices].map(nodeIndex => {
    const node = nodes[nodeIndex];
    if (!node?.computedTransform || node.userAnimated) throw new Error('工程节点变换已被修改，无法按原交付几何计算摄影遮挡。');
    return { nodeIndex, matrix: Matrix4.toArray(node.computedTransform) };
  });
}
