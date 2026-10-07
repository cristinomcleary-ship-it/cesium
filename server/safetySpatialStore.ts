import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, readdir, stat, realpath } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { SPATIAL_API_PATH, SPATIAL_MODELS_API_PATH, type ModelRegistryEntry, type SpatialObject, type SpatialMutation, type SpatialSnapshot } from "../src/safetySpatialTypes.ts";
import { emptySpatialSnapshot, SPATIAL_LIMITS, SpatialValidationError, validateModelRegistry, validateSpatialMutation, validateSpatialSnapshot } from "../src/safetySpatialValidation.ts";

type Receipt = { id: string; signature: string };
type Persisted = SpatialSnapshot & { mutations: Receipt[] };
class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly snapshot?: SpatialSnapshot) { super(message); }
}
function output(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value));
}

export type SafetySpatialStoreOptions = {
  dataDir?: string;
  libraryDataDir?: string;
  projectId?: string;
  modelRegistry?: ModelRegistryEntry[] | (() => Promise<ModelRegistryEntry[]>);
};
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const KNOWN_PHOTOGRAMMETRY = "8bc58629-cf26-45de-986e-086479db11a0";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Asset versions use local tile content metadata, never the record's UI-updated timestamp. */
export async function loadProjectModelRegistry(options: SafetySpatialStoreOptions = {}): Promise<ModelRegistryEntry[]> {
  if (options.modelRegistry) return validateModelRegistry(typeof options.modelRegistry === "function" ? await options.modelRegistry() : options.modelRegistry);
  const root = resolve(options.libraryDataDir || process.env.CESIUM_DATA_DIR || join(process.cwd(), "project-data"));
  const ids = [...new Set((process.env.CESIUM_SAFETY_PHOTOGRAMMETRY_IDS || KNOWN_PHOTOGRAMMETRY).split(/[,;\s]+/).filter(Boolean))];
  const models: ModelRegistryEntry[] = [];
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("模型注册编号无效");
    const recordRoot = join(root, "records", id);
    let record: { id: string; name: string; kind: string; files: { tiles?: { url: string } }; settings: { matrix?: number[]; tiles?: { longitudeOffset?: number; latitudeOffset?: number; heightOffset?: number } } };
    try {
      try { await stat(join(root, "deleted", id + ".json")); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      record = JSON.parse(await readFile(join(recordRoot, "record.json"), "utf8"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (record.id !== id || record.kind !== "3D Tiles" || !record.files?.tiles?.url || !record.settings) continue;
    const prefix = `/__library/files/${id}/tiles/`, url = record.files.tiles.url;
    if (!url.startsWith(prefix)) throw new Error("模型注册来源地址不匹配");
    const filename = decodeURIComponent(url.slice(prefix.length));
    if (filename.includes(":") || filename.includes("\\") || filename.split("/").some(part => !part || part === "." || part === "..")) throw new Error("模型注册文件路径无效");
    const actualRecordRoot = await realpath(recordRoot);
    const tilesRoot = await realpath(join(recordRoot, "tiles"));
    if (!tilesRoot.startsWith(actualRecordRoot + sep)) throw new Error("模型瓦片目录越界");
    const entry = await realpath(resolve(tilesRoot, filename));
    if (!entry.startsWith(tilesRoot + sep)) throw new Error("模型注册路径越界");
    const rootJson = await readFile(entry, "utf8"); JSON.parse(rootJson);
    const entries: string[] = [];
    async function walk(folder: string): Promise<void> {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error("模型版本目录不支持符号链接");
        const path = join(folder, item.name);
        if (item.isDirectory()) await walk(path);
        else if (item.isFile()) { const info = await stat(path); entries.push(`${relative(tilesRoot, path).replaceAll("\\", "/")}\0${info.size}\0${info.mtimeMs}`); }
      }
    }
    await walk(tilesRoot); entries.sort();
    const matrix = record.settings.matrix || IDENTITY_MATRIX;
    const coordinateOffsets = { longitude: record.settings.tiles?.longitudeOffset ?? 0, latitude: record.settings.tiles?.latitudeOffset ?? 0, height: record.settings.tiles?.heightOffset ?? 0 };
    models.push({ assetId: id, projectId: options.projectId || "safety:project", name: record.name, url, kind: "photogrammetry", matrix: [...matrix], coordinateOffsets,
      assetVersion: hash(rootJson + "\n" + entries.join("\n")), coordinateTransformVersion: hash(JSON.stringify({ matrix, coordinateOffsets })), capabilitySource: "project-verified" });
  }
  return validateModelRegistry(models);
}

function assertModelVersions(object: SpatialObject, registry: ModelRegistryEntry[]): void {
  for (const vertex of object.source.vertices) {
    const anchor = vertex.anchor, model = registry.find(entry => entry.assetId === anchor?.model.assetId && entry.projectId === object.projectId);
    if (!anchor || !model) throw new StoreError(409, "MODEL_UNAVAILABLE", "项目模型暂不可用于保存，修改已保留，请确认模型已加载");
    if (anchor.model.assetVersion !== model.assetVersion || anchor.model.coordinateTransformVersion !== model.coordinateTransformVersion) {
      throw new StoreError(409, "MODEL_VERSION_CHANGED", "模型版本或位置已变更，原记录未移动；请重新核对并定位");
    }
  }
}

export function createSafetySpatialStore(options: SafetySpatialStoreOptions = {}) {
  const dataDir = resolve(options.dataDir || process.env.CESIUM_SAFETY_DATA_DIR || join(process.cwd(), "project-data"));
  const path = join(dataDir, "safety-spatial.json");
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Persisted> {
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...emptySpatialSnapshot(), mutations: [] }; throw error; }
    try {
      const parsed: unknown = JSON.parse(raw);
      const snapshot = validateSpatialSnapshot(parsed);
      const receipts = (parsed as { mutations?: unknown }).mutations;
      if (!Array.isArray(receipts) || receipts.length > 64 || !receipts.every((entry) => entry && typeof entry.id === "string" && typeof entry.signature === "string" && /^[a-f0-9]{64}$/.test(entry.signature))) throw new Error("保存回执无效");
      return { ...snapshot, mutations: receipts as Receipt[] };
    } catch { throw new StoreError(500, "STORAGE_CORRUPT", "人工标绘文件格式损坏或版本不兼容，原文件已保留，禁止覆盖；请先检查或备份 safety-spatial.json"); }
  }
  async function atomicWrite(value: Persisted): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const temporary = join(dataDir, `safety-spatial-${randomUUID()}.pending`);
    try {
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  function publicSnapshot(value: Persisted): SpatialSnapshot { const { mutations: _mutations, ...snapshot } = value; return snapshot; }
  async function load(): Promise<SpatialSnapshot> { return publicSnapshot(await read()); }
  function mutate(value: unknown): Promise<SpatialSnapshot> {
    const mutation = validateSpatialMutation(value);
    const task = queue.catch(() => undefined).then(async () => {
      const persisted = await read(); const snapshot = publicSnapshot(persisted);
      const signature = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
      const receipt = persisted.mutations.find((item) => item.id === mutation.mutationId);
      if (receipt) {
        if (receipt.signature !== signature) throw new StoreError(409, "MUTATION_ID_REUSED", "保存请求编号已用于另一项操作，请重新读取数据", snapshot);
        return snapshot;
      }
      if (mutation.expectedRevision !== snapshot.revision) throw new StoreError(409, "REVISION_CONFLICT", "空间对象已被另一页面更新；请先读取最新版本，当前草稿不会被覆盖", snapshot);
      const now = new Date().toISOString();
      const objects = [...snapshot.objects];
      if (mutation.operation === "upsert") {
        const index = objects.findIndex((item) => item.id === mutation.object.id);
        const previous = objects[index];
        if (previous?.deletedAt) throw new StoreError(409, "OBJECT_DELETED", "该对象已删除，请先从最近删除中恢复", snapshot);
        if (mutation.object.deletedAt) throw new StoreError(400, "DELETE_INTENT_REQUIRED", "删除需使用明确的删除操作", snapshot);
        if (previous && (previous.projectId !== mutation.object.projectId || previous.kind !== mutation.object.kind)) throw new StoreError(400, "IDENTITY_CHANGED", "已有对象不能更换所属项目或类型", snapshot);
        if (mutation.object.creationSource === "user_drawn_model_surface") assertModelVersions(mutation.object, await loadProjectModelRegistry(options));
        else if (!previous || previous.creationSource || JSON.stringify(previous.geometry) !== JSON.stringify(mutation.object.geometry)
          || JSON.stringify(previous.source) !== JSON.stringify(mutation.object.source)) throw new StoreError(400, "MODEL_SURFACE_REQUIRED", "新增或重绘对象须使用项目倾斜摄影表面；旧来源和位置已保留", snapshot);
        const object = { ...mutation.object, createdAt: previous?.createdAt || now, updatedAt: now };
        if (index >= 0) objects[index] = object; else objects.push(object);
      } else {
        const index = objects.findIndex((item) => item.id === mutation.id);
        if (index === -1) throw new StoreError(404, "OBJECT_NOT_FOUND", "空间对象已不存在，请刷新列表", snapshot);
        if (mutation.operation === "delete") {
          if (objects[index].deletedAt) throw new StoreError(409, "OBJECT_DELETED", "对象已在最近删除中", snapshot);
          objects[index] = { ...objects[index], deletedAt: now, updatedAt: now };
        } else {
          if (!objects[index].deletedAt) throw new StoreError(409, "OBJECT_NOT_DELETED", "对象已恢复，请读取最新记录", snapshot);
          const { deletedAt: _deletedAt, deletedBy: _deletedBy, ...restored } = objects[index];
          objects[index] = { ...restored, updatedAt: now };
        }
      }
      const next = validateSpatialSnapshot({ version: 1, revision: snapshot.revision + 1, updatedAt: now, objects });
      await atomicWrite({ ...next, mutations: [...persisted.mutations, { id: mutation.mutationId, signature }].slice(-64) });
      return next;
    });
    queue = task; return task;
  }
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== SPATIAL_API_PATH && url.pathname !== SPATIAL_MODELS_API_PATH) { next(); return; }
    try {
      if (req.headers.origin) {
        let originHost = ""; try { originHost = new URL(req.headers.origin).host; } catch { /* Opaque origins are rejected. */ }
        if (!originHost || originHost !== req.headers.host) throw new StoreError(403, "CROSS_ORIGIN", "不允许跨站读写人工标绘");
      }
      if (url.pathname === SPATIAL_MODELS_API_PATH) {
        if (req.method !== "GET") throw new StoreError(405, "METHOD_NOT_ALLOWED", "项目模型注册只支持读取");
        output(res, 200, await loadProjectModelRegistry(options)); return;
      }
      if (req.method === "GET") { output(res, 200, await load()); return; }
      if (req.method !== "POST") throw new StoreError(405, "METHOD_NOT_ALLOWED", "人工标绘仅支持读取与单对象保存/删除");
      if (req.headers["x-cesium-library"] !== "1") throw new StoreError(403, "MISSING_REQUEST_MARKER", "缺少本机空间对象请求标识");
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new StoreError(415, "CONTENT_TYPE", "人工标绘请求必须是 JSON");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > SPATIAL_LIMITS.bodyBytes) throw new StoreError(413, "BODY_TOO_LARGE", "人工标绘请求不能超过1MB"); chunks.push(data); }
      let mutation: SpatialMutation;
      try { mutation = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new StoreError(400, "INVALID_JSON", "人工标绘请求不是有效 JSON"); }
      output(res, 200, await mutate(mutation));
    } catch (error) {
      if (error instanceof StoreError) output(res, error.status, { error: error.message, code: error.code, ...(error.snapshot ? { snapshot: error.snapshot } : {}) });
      else if (error instanceof SpatialValidationError) output(res, 400, { error: error.message, code: "VALIDATION" });
      else output(res, 500, { error: "人工标绘保存失败，原文件与当前草稿保留", code: "STORAGE_ERROR" });
    }
  }
  return { load, mutate, middleware, path };
}

export function safetySpatialPlugin(options: SafetySpatialStoreOptions = {}): Plugin {
  const store = createSafetySpatialStore(options);
  return { name: "cesium-safety-spatial", configureServer(server) { server.middlewares.use(store.middleware); },
    configurePreviewServer(server) { server.middlewares.use(store.middleware); } };
}
