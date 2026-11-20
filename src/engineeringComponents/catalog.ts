/** Read-only indices over the delivered model ledger. Never rewrites source geometry. */
export type EngineeringScope = { kind: 'all' } | { kind: 'component' | 'group' | 'unit'; id: string };
export type EngineeringItem = Readonly<{
  id: string; name: string; parentId: string; unitId: string | null;
  kind: 'component' | 'reference'; type: string; typeName: string;
  defaultVisible: boolean; defaultOcclusion: boolean;
  geometryNode: string; geometryMesh: string; designStatus?: string;
  bounds?: readonly [readonly number[], readonly number[]];
}>;
export type EngineeringGroup = Readonly<{ id: string; name: string; parentId: string | null }>;
export type EngineeringUnitAsset = Readonly<{ id: string; path: string; count: number; sha256: string }>;
export type EngineeringStructure = Readonly<{
  unitId: string; model: string; componentIds: readonly string[]; linkedSupportIds: readonly string[];
  sourceLocalCoordinates: true; coordinateFrame: string;
}>;
export type EngineeringBinding = Readonly<{ componentId: string; nodeIndices: readonly number[] }>;
export type EngineeringModelBindings = Readonly<{
  bindings: readonly EngineeringBinding[];
  nodeToComponent: ReadonlyMap<number, string>;
  componentToNodes: ReadonlyMap<string, readonly number[]>;
  nodeCount: number; meshCount: number; unitId?: string;
}>;

const MAX_ITEMS = 1_000_000, MAX_GROUPS = 100_000, MAX_DEPTH = 256;
const fail = (message: string): never => { throw new Error(`工程构件台账：${message}`); };
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f]/.test(value)) return fail(`${label} 无效`);
  return value;
}
function optionalId(value: unknown, label: string): string | null { return value === null || value === undefined ? null : string(value, label); }
function array(value: unknown, label: string, limit = MAX_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > limit) return fail(`${label} 必须是有界数组（最多 ${limit} 项）`);
  return value;
}
function boolean(value: unknown, label: string): boolean { return typeof value === 'boolean' ? value : fail(`${label} 必须是布尔值`); }
function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : fail(`${label} 必须是范围内的非负整数`);
}
function relativePath(value: unknown, label: string): string {
  const path = string(value, label);
  if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('%') || path.split('/').some(part => !part || part === '.' || part === '..')) return fail(`${label} 必须是包内相对路径`);
  return path;
}
function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return fail(`${label} 必须是 SHA256`);
  return value.toLowerCase();
}
function uniqueStrings(value: unknown, label: string): readonly string[] {
  const values = array(value, label).map((id, index) => string(id, `${label}[${index}]`));
  if (new Set(values).size !== values.length) return fail(`${label} 包含重复编号`);
  return Object.freeze(values);
}
function addMember(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key); if (existing) existing.push(value); else map.set(key, [value]);
}

/** An ordering checksum, not a cryptographic substitute for the supplied package SHA256. */
function orderFingerprint(ids: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const id of ids) for (const character of `${id.length}:${id}`) {
    hash ^= BigInt(character.codePointAt(0)!); hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `ids-v1:${hash.toString(16).padStart(16, '0')}`;
}

export class EngineeringCatalog {
  readonly schema = 'jiashan/component-library/2.0';
  readonly revision: string;
  readonly fingerprint: string;
  readonly orderFingerprint: string;
  readonly geometryFile: string;
  readonly components: readonly EngineeringItem[];
  readonly references: readonly EngineeringItem[];
  readonly items: readonly EngineeringItem[];
  readonly groups: readonly EngineeringGroup[];
  readonly itemsById: ReadonlyMap<string, EngineeringItem>;
  readonly groupsById: ReadonlyMap<string, EngineeringGroup>;
  readonly itemIndexById: ReadonlyMap<string, number>;
  readonly rootGroupIds: readonly string[];
  readonly childrenByGroup: ReadonlyMap<string, readonly string[]>;
  readonly groupMembers: ReadonlyMap<string, readonly string[]>;
  readonly unitMembers: ReadonlyMap<string, readonly string[]>;
  readonly unitAssets: ReadonlyMap<string, EngineeringUnitAsset>;
  private readonly physicalIds: readonly string[];

  constructor(raw: unknown, options: { assetFingerprint: string; structureIndex?: unknown }) {
    const data = object(raw, '根节点');
    if (data.schema !== this.schema) fail('不支持的 schema');
    if (data.units !== 'm') fail('仅接受交付包的米制单位');
    this.revision = string(data.modelRevision, 'modelRevision');
    this.fingerprint = sha256(options.assetFingerprint, 'assetFingerprint');
    this.geometryFile = relativePath(data.geometryFile, 'geometryFile');
    const groups = new Map<string, EngineeringGroup>(), children = new Map<string, string[]>();
    for (const rawGroup of array(data.groups, 'groups', MAX_GROUPS)) {
      const group = object(rawGroup, 'group'), id = string(group.id, 'group.id');
      if (groups.has(id)) fail(`重复 groupId：${id}`);
      groups.set(id, Object.freeze({ id, name: string(group.name, `${id}.name`), parentId: optionalId(group.parentId, `${id}.parentId`) }));
      children.set(id, []);
    }
    const roots: string[] = [];
    for (const group of groups.values()) {
      if (group.parentId === null) roots.push(group.id);
      else { if (!groups.has(group.parentId)) fail(`${group.id} 的父组不存在：${group.parentId}`); addMember(children, group.parentId, group.id); }
    }
    // Iterative traversal avoids a malicious/corrupt tree overflowing the JS stack.
    const topological: string[] = [], queue = roots.map(id => ({ id, depth: 0 }));
    for (let index = 0; index < queue.length; index++) {
      const { id, depth } = queue[index]; if (depth > MAX_DEPTH) fail('组层级超过限制');
      topological.push(id);
      for (const child of children.get(id)!) queue.push({ id: child, depth: depth + 1 });
    }
    if (topological.length !== groups.size) fail('分组存在循环');
    const items = new Map<string, EngineeringItem>(), components: EngineeringItem[] = [], references: EngineeringItem[] = [], units = new Map<string, string[]>();
    for (const [kind, values] of [['component', array(data.components, 'components')], ['reference', array(data.referenceGeometry ?? [], 'referenceGeometry')]] as const) {
      for (const rawItem of values) {
        const item = object(rawItem, kind), id = string(item.id, `${kind}.id`);
        if (items.has(id) || groups.has(id)) fail(`重复构件/分组编号：${id}`);
        const parentId = string(item.parentId, `${id}.parentId`);
        if (!groups.has(parentId)) fail(`${id} 的父组不存在：${parentId}`);
        const unitId = kind === 'component' ? optionalId(item.unitId, `${id}.unitId`) : null;
        const defaultVisible = boolean(item.visible, `${id}.visible`), defaultOcclusion = boolean(item.occlusion, `${id}.occlusion`);
        if (kind === 'reference' && defaultOcclusion) fail(`参考几何不能作为实体遮挡源：${id}`);
        let geometryNode = id, geometryMesh = id;
        if (kind === 'component') {
          const geometry = object(item.geometryRef, `${id}.geometryRef`);
          if (relativePath(geometry.file, `${id}.geometryRef.file`) !== this.geometryFile) fail(`${id} 引用了未知几何文件`);
          geometryNode = string(geometry.node, `${id}.geometryRef.node`); geometryMesh = string(geometry.mesh, `${id}.geometryRef.mesh`);
        }
        let bounds: EngineeringItem['bounds'];
        if (item.bounds_m !== undefined) {
          const values = array(item.bounds_m, `${id}.bounds_m`, 2);
          if (values.length !== 2) fail(`${id} 包围范围必须为两个点`);
          const points = values.map(point => {
            const coordinates = array(point, `${id}.bounds_m.point`, 3);
            if (coordinates.length !== 3 || coordinates.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail(`${id} 包围范围含无效坐标`);
            return Object.freeze(coordinates as number[]);
          });
          if (points[0].some((value, axis) => value > points[1][axis])) fail(`${id} 包围范围上下限颠倒`);
          bounds = Object.freeze([points[0], points[1]]) as EngineeringItem['bounds'];
        }
        const normalized: EngineeringItem = Object.freeze({ id, name: string(item.name, `${id}.name`), parentId, unitId, kind,
          type: string(kind === 'component' ? item.type : item.mode, `${id}.type`),
          typeName: kind === 'component' ? string(item.typeName, `${id}.typeName`) : '参考几何',
          defaultVisible, defaultOcclusion, geometryNode, geometryMesh, bounds,
          ...(typeof item.designStatus === 'string' ? { designStatus: item.designStatus } : {}),
        });
        items.set(id, normalized); (kind === 'component' ? components : references).push(normalized);
        addMember(children, parentId, id); if (unitId !== null) addMember(units, unitId, id);
      }
    }
    if (items.size > MAX_ITEMS) fail('实体与参考几何总量超过限制');
    const members = new Map<string, readonly string[]>();
    for (const id of topological.reverse()) {
      const leaves: string[] = [];
      for (const child of children.get(id)!) {
        if (groups.has(child)) { for (const leaf of members.get(child)!) leaves.push(leaf); }
        else leaves.push(child);
      }
      members.set(id, Object.freeze(leaves));
    }
    const unitAssets = new Map<string, EngineeringUnitAsset>();
    if (options.structureIndex !== undefined) {
      for (const [id, value] of Object.entries(object(options.structureIndex, 'structure-library/index.json'))) {
        string(id, 'unitId'); const entry = object(value, id);
        const count = integer(entry.count, `${id}.count`, MAX_ITEMS);
        if (!units.has(id)) fail(`结构库含未知单元：${id}`);
        if (count !== units.get(id)!.length) fail(`${id} 的单元成员数量不一致`);
        unitAssets.set(id, Object.freeze({ id, path: relativePath(entry.path, `${id}.path`), count, sha256: sha256(entry.sha256, `${id}.sha256`) }));
      }
      for (const id of units.keys()) if (!unitAssets.has(id)) fail(`结构库缺少单元：${id}`);
    }
    this.components = Object.freeze(components); this.references = Object.freeze(references);
    this.items = Object.freeze([...components, ...references]); this.groups = Object.freeze([...groups.values()]);
    this.itemsById = items; this.groupsById = groups; this.itemIndexById = new Map(this.items.map((item, index) => [item.id, index]));
    this.rootGroupIds = Object.freeze(roots); this.childrenByGroup = new Map([...children].map(([id, values]) => [id, Object.freeze(values)]));
    this.groupMembers = members; this.unitMembers = new Map([...units].map(([id, values]) => [id, Object.freeze(values)])); this.unitAssets = unitAssets;
    this.physicalIds = Object.freeze(components.map(item => item.id)); this.orderFingerprint = orderFingerprint(this.items.map(item => item.id));
  }

  /** All means physical engineering components; references keep their delivered display state. */
  getMembers(scope: EngineeringScope): readonly string[] {
    if (scope.kind === 'all') return this.physicalIds;
    if (scope.kind === 'component') { if (!this.itemsById.has(scope.id)) return fail(`未知构件：${scope.id}`); return [scope.id]; }
    const members = scope.kind === 'group' ? this.groupMembers.get(scope.id) : scope.kind === 'unit' ? this.unitMembers.get(scope.id) : undefined;
    return members ?? fail(`未知范围：${scope.id}`);
  }

  /** Parent-first ordering is useful for expanding the tree after a scene pick. */
  getAncestors(id: string): readonly string[] {
    const item = this.itemsById.get(id) ?? this.groupsById.get(id); if (!item) return fail(`未知对象：${id}`);
    const result: string[] = []; let parent = item.parentId;
    while (parent !== null) { result.push(parent); parent = this.groupsById.get(parent)!.parentId; }
    return result.reverse();
  }
}

export function parseEngineeringCatalog(raw: unknown, options: { assetFingerprint: string; structureIndex?: unknown }): EngineeringCatalog {
  return new EngineeringCatalog(raw, options);
}

export function parseEngineeringStructure(raw: unknown, catalog: EngineeringCatalog, expectedUnitId?: string): EngineeringStructure {
  const data = object(raw, 'structure.json'), unitId = string(data.unitId, 'structure.unitId');
  if (expectedUnitId !== undefined && unitId !== expectedUnitId) fail('结构包 unitId 与请求不一致');
  const expected = catalog.getMembers({ kind: 'unit', id: unitId });
  const componentIds = uniqueStrings(data.componentIds, `${unitId}.componentIds`), expectedSet = new Set(expected);
  if (componentIds.length !== expected.length || componentIds.some(id => !expectedSet.has(id))) fail(`${unitId} 的结构包成员与完整台账不一致`);
  const linkedSupportIds = uniqueStrings(data.linkedSupportIds ?? [], `${unitId}.linkedSupportIds`);
  for (const id of linkedSupportIds) if (catalog.itemsById.get(id)?.kind !== 'component') fail(`未知关联支承：${id}`);
  if (data.sourceLocalCoordinates !== true) fail('结构包必须保留原局部坐标');
  return Object.freeze({ unitId, componentIds, linkedSupportIds, model: relativePath(data.model, `${unitId}.model`),
    sourceLocalCoordinates: true, coordinateFrame: string(data.coordinateFrame, `${unitId}.coordinateFrame`) });
}

/** Reads only the JSON chunk of a complete GLB; does not decode, normalize or modify geometry. */
export function readGlbJson(buffer: ArrayBuffer): unknown {
  if (buffer.byteLength < 20) return fail('GLB 文件头不完整');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return fail('GLB magic/version 无效');
  if (view.getUint32(8, true) !== buffer.byteLength) return fail('GLB 文件长度与头部不一致');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 || jsonLength > buffer.byteLength - 20) return fail('GLB JSON chunk 无效');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 20, jsonLength)));
}

/** Validate the original GLB JSON chunk before attaching its unmodified bytes to Cesium. */
export function createEngineeringModelBindings(catalog: EngineeringCatalog, rawGltf: unknown, options: { unitId?: string } = {}): EngineeringModelBindings {
  const gltf = object(rawGltf, 'glTF'), asset = object(gltf.asset, 'glTF.asset');
  if (asset.version !== '2.0') fail('GLB 必须使用 glTF 2.0');
  const nodes = array(gltf.nodes, 'glTF.nodes', MAX_ITEMS + MAX_GROUPS + 1).map((value, index) => object(value, `node[${index}]`));
  const meshes = array(gltf.meshes, 'glTF.meshes').map((value, index) => object(value, `mesh[${index}]`));
  const expected = options.unitId === undefined ? catalog.items.map(item => item.id) : catalog.getMembers({ kind: 'unit', id: options.unitId });
  const expectedSet = new Set(expected), nodeToComponent = new Map<number, string>(), componentToNodes = new Map<string, readonly number[]>();
  const names = new Set<string>(), parents = new Map<number, number>(), children: number[][] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], name = string(node.name, `node[${index}].name`);
    if (names.has(name)) fail(`GLB 节点名重复：${name}`); names.add(name);
    const nodeChildren = array(node.children ?? [], `${name}.children`).map(child => integer(child, `${name}.child`, nodes.length - 1));
    for (const child of nodeChildren) { if (parents.has(child)) fail(`GLB 节点有重复父级：${child}`); parents.set(child, index); }
    children.push(nodeChildren);
    if (node.mesh === undefined) continue;
    const meshIndex = integer(node.mesh, `${name}.mesh`, meshes.length - 1), mesh = meshes[meshIndex];
    const id = string(object(node.extras, `${name}.extras`).componentId, `${name}.componentId`);
    const item = catalog.itemsById.get(id) ?? fail(`GLB 含未知构件：${id}`);
    if (!expectedSet.has(id)) fail(`GLB 含超出当前范围的构件：${id}`);
    if (componentToNodes.has(id)) fail(`GLB 重复绑定构件：${id}`);
    if (name !== item.geometryNode || mesh.name !== item.geometryMesh) fail(`${id} 的节点/mesh 名称与台账不一致`);
    if (!array(mesh.primitives, `${id}.primitives`).length) fail(`${id} 没有 primitive`);
    nodeToComponent.set(index, id); componentToNodes.set(id, Object.freeze([index]));
  }
  const scenes = array(gltf.scenes, 'glTF.scenes', MAX_GROUPS), sceneIndex = integer(gltf.scene ?? 0, 'glTF.scene', scenes.length - 1);
  const roots = array(object(scenes[sceneIndex], 'glTF.scene').nodes, 'scene.nodes').map(root => integer(root, 'scene.root', nodes.length - 1));
  const seen = new Set<number>(), queue = roots.map(index => ({ index, depth: 0 }));
  for (let offset = 0; offset < queue.length; offset++) {
    const { index, depth } = queue[offset]; if (seen.has(index)) fail('GLB 节点循环或场景根重复');
    if (depth > MAX_DEPTH) fail('GLB 节点层级超过限制'); seen.add(index);
    for (const child of children[index]) queue.push({ index: child, depth: depth + 1 });
  }
  if (seen.size !== nodes.length) fail('GLB 包含不可达或循环节点');
  for (const id of expected) if (!componentToNodes.has(id)) fail(`GLB 缺少构件：${id}`);
  return Object.freeze({ bindings: Object.freeze([...componentToNodes].map(([componentId, nodeIndices]) => Object.freeze({ componentId, nodeIndices }))),
    nodeToComponent, componentToNodes, nodeCount: nodes.length, meshCount: meshes.length, ...(options.unitId === undefined ? {} : { unitId: options.unitId }) });
}
