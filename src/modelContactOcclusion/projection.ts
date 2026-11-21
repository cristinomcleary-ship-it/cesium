import { Matrix4 } from '@cesium/engine';
import { projectEngineeringTriangles, type EngineeringFootprintResult, type EngineeringProjectionGroup } from '../engineeringComponents/footprints';
import type { ContactBuildOptions, ContactMeshInput } from './types';

export type ModelProjectionGeometry = {
  kind: 'projection'; projection: EngineeringFootprintResult; worldFromLocal: number[];
};

/** Keep every original triangle, regardless of shell closure or visibility.
 * Input positions already contain runtime node/instance placement. Only the
 * physical root placement remains, exactly once, in worldFromLocal. */
export async function buildModelProjection(input: ContactMeshInput, options: ContactBuildOptions = {}): Promise<ModelProjectionGeometry> {
  if (input.primitives.length > 200_000) throw new Error('模型投影图元超过 200,000 读取预算。');
  const groups = new Map<string, EngineeringProjectionGroup>();
  let bytes = 0, triangles = 0;
  for (const primitive of input.primitives) {
    if (options.shouldAbort?.()) throw new DOMException('模型投影已取消。', 'AbortError');
    const { positions, indices, groupId, nodeIndex } = primitive;
    if (!(positions instanceof Float64Array) || !(indices instanceof Uint32Array)
      || positions.length % 3 || indices.length % 3 || !groupId || !Number.isSafeInteger(nodeIndex) || nodeIndex < 0)
      throw new Error('模型投影原始三角输入无效。');
    bytes += positions.byteLength + indices.byteLength; triangles += indices.length / 3;
    if (bytes > 512 * 1024 * 1024 || triangles > 3_000_000) throw new Error('模型投影超过 512 MiB / 300 万三角面预算。');
    if (positions.some(value => !Number.isFinite(value)) || indices.some(index => index >= positions.length / 3))
      throw new Error('模型投影坐标或原三角索引无效。');
    let group = groups.get(groupId);
    if (!group) { group = { id: groupId, primitives: [] }; groups.set(groupId, group); }
    group.primitives.push({ positions, indices, transform: Matrix4.toArray(Matrix4.IDENTITY) });
  }
  const projection = await projectEngineeringTriangles(input.worldFromLocal, [...groups.values()], options);
  if (projection.triangleCount !== triangles) throw new Error('模型投影原三角数量不守恒。');
  return { kind: 'projection', projection, worldFromLocal: [...input.worldFromLocal] };
}
