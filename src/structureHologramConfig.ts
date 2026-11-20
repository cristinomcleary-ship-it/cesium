import { Cartesian3, Math as CesiumMath, Matrix3, Matrix4, Transforms, type Model } from 'cesium';

export const STRUCTURE_LIBRARY_URL = '/__structure_library';
const pathKey = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const text = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= limit && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export type StructureBinding = { modelId: string; nodeName?: string; category: string; structureId: string };
export type StructureAnchor = { kind: 'model-local'; position: [number, number, number] }
  | { kind: 'wgs84'; longitude: number; latitude: number; height: number };
export type StructureHologramConfig = { title: string; anchor: StructureAnchor; headingDegrees: number; scale: number };

export function parseStructureCatalog(value: unknown): StructureBinding[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 5000) {
    throw new Error('结构资源目录格式无效。');
  }
  const keys = new Set<string>();
  return value.bindings.map(item => {
    if (!object(item) || !text(item.modelId, 128) || (item.nodeName !== undefined && !text(item.nodeName, 256))
      || typeof item.category !== 'string' || !pathKey.test(item.category)
      || typeof item.structureId !== 'string' || !pathKey.test(item.structureId)) throw new Error('结构资源目录包含无效绑定。');
    const key = JSON.stringify([item.modelId, item.nodeName ?? null]);
    if (keys.has(key)) throw new Error('结构资源目录存在重复构件绑定。');
    keys.add(key);
    return { modelId: item.modelId, nodeName: item.nodeName, category: item.category, structureId: item.structureId };
  });
}

export function findStructureBinding(bindings: readonly StructureBinding[], modelId: string, nodeNames: readonly string[]): StructureBinding | undefined {
  for (const name of nodeNames) {
    const exact = bindings.find(binding => binding.modelId === modelId && binding.nodeName === name);
    if (exact) return exact;
  }
  return bindings.find(binding => binding.modelId === modelId && binding.nodeName === undefined);
}

export function structureAssetUrl(binding: Pick<StructureBinding, 'category' | 'structureId'>,
  asset: 'structure.json' | 'hologram.glb' | 'preview'): string {
  if (!pathKey.test(binding.category) || !pathKey.test(binding.structureId)) throw new Error('结构资源标识无效。');
  return `${STRUCTURE_LIBRARY_URL}/${binding.category}/${binding.structureId}/${asset}`;
}

export function parseStructureConfig(value: unknown): StructureHologramConfig {
  if (!object(value) || value.version !== 1 || !text(value.title, 160) || !object(value.anchor)) throw new Error('结构配置格式无效。');
  const { headingDegrees = 0, scale = 1 } = value;
  if (!finite(headingDegrees) || Math.abs(headingDegrees) > 360 || !finite(scale) || scale < 0.0001 || scale > 10_000) {
    throw new Error('结构投影的旋转或比例超出范围。');
  }
  let anchor: StructureAnchor;
  const input = value.anchor;
  if (input.kind === 'model-local' && Array.isArray(input.position) && input.position.length === 3
    && input.position.every(component => finite(component) && Math.abs(component) <= 1e8)) {
    anchor = { kind: input.kind, position: [input.position[0], input.position[1], input.position[2]] };
  } else if (input.kind === 'wgs84' && finite(input.longitude) && Math.abs(input.longitude) <= 180
    && finite(input.latitude) && Math.abs(input.latitude) <= 90
    && finite(input.height) && Math.abs(input.height) <= 1e7) {
    anchor = { kind: input.kind, longitude: input.longitude, latitude: input.latitude, height: input.height };
  } else {
    throw new Error('结构投影的锚点无效。');
  }
  return { title: value.title, anchor, headingDegrees, scale };
}

type RuntimeNode = { node?: { name?: unknown; index?: unknown }; children?: number[]; sceneGraph?: { _runtimeNodes?: Array<RuntimeNode | undefined> } };
export type EngineeringModelPick = { primitive?: unknown; detail?: { model?: unknown; node?: RuntimeNode } };

/** Cesium 1.144's standalone Model pick exposes a runtime node, while getNode
 * returns the public wrapper. Follow the picked mesh to its named assemblies.
 * Only uniquely named nodes with a matching public index can bind a structure. */
export function pickedEngineeringModelNodeNames(pick: EngineeringModelPick, model: Pick<Model, 'ready' | 'getNode'>): string[] {
  if (pick.primitive !== model || pick.detail?.model !== model || !model.ready) return [];
  const runtime = pick.detail?.node;
  const index = runtime?.node?.index;
  const nodes = runtime?.sceneGraph?._runtimeNodes;
  if (!runtime || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || !Array.isArray(nodes) || nodes[index] !== runtime) return [];
  const nameCounts = new Map<string, number>();
  const parentByIndex = new Map<number, number | undefined>();
  nodes.forEach((candidate, parentIndex) => {
    const name = candidate?.node?.name;
    if (text(name, 256)) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    for (const child of candidate?.children ?? []) parentByIndex.set(child, parentByIndex.has(child) ? undefined : parentIndex);
  });
  const result: string[] = [];
  const visited = new Set<number>();
  for (let cursor: number | undefined = index; cursor !== undefined && !visited.has(cursor); cursor = parentByIndex.get(cursor)) {
    visited.add(cursor);
    const name = nodes[cursor]?.node?.name;
    if (!text(name, 256) || nameCounts.get(name) !== 1) continue;
    const node = model.getNode(name);
    if (node?.name === name && node.id === cursor) result.push(name);
  }
  return result;
}

/** Local points are in the input model's post-axis-conversion coordinates,
 * before Model.scale. World anchors use WGS84 ellipsoid height in metres. */
export function structureProjectionFrame(anchor: StructureAnchor, model: Pick<Model, 'modelMatrix' | 'scale'>): Matrix4 {
  const position = anchor.kind === 'wgs84'
    ? Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, anchor.height)
    : Matrix4.multiplyByPoint(model.modelMatrix, Cartesian3.multiplyByScalar(Cartesian3.fromArray(anchor.position), model.scale, new Cartesian3()), new Cartesian3());
  if (![position.x, position.y, position.z].every(Number.isFinite) || Cartesian3.magnitude(position) < 1_000_000) {
    throw new Error('结构投影锚点未落在有效的地球坐标中。');
  }
  return Transforms.eastNorthUpToFixedFrame(position);
}

export function structureProjectionMatrix(frame: Matrix4, headingDegrees: number): Matrix4 {
  return Matrix4.multiplyByMatrix3(frame, Matrix3.fromRotationZ(CesiumMath.toRadians(headingDegrees)), new Matrix4());
}

/** Load only self-contained version-2 GLBs. Cesium can otherwise resolve URLs
 * embedded in glTF and request assets outside the intended local package. */
export function validateStructureGlb(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 20) throw new Error('投影模型不是有效的 GLB。');
  const view = new DataView(buffer);
  const jsonSize = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength
    || view.getUint32(16, true) !== 0x4e4f534a || jsonSize > 8 * 1024 * 1024 || jsonSize + 20 > buffer.byteLength) {
    throw new Error('投影模型不是有效的 GLB。');
  }
  let gltf: unknown;
  try { gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonSize))); }
  catch { throw new Error('投影模型的 GLB 配置无效。'); }
  if (!object(gltf) || !object(gltf.asset) || gltf.asset.version !== '2.0') throw new Error('投影模型须采用 GLB 2.0。');
  const metadata = object(gltf.extensions) ? gltf.extensions.EXT_structural_metadata : undefined;
  if ([gltf.buffers, gltf.images].some(collection => Array.isArray(collection) && collection.some(entry => object(entry)
    && entry.uri !== undefined && (typeof entry.uri !== 'string' || !/^data:/i.test(entry.uri))))
    || (object(metadata) && metadata.schemaUri !== undefined)) {
    throw new Error('投影 GLB 须嵌入模型与贴图资源。');
  }
}
