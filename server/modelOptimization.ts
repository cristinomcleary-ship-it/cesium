import { createHash } from "node:crypto";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { loadProjectModelRegistry, type SafetySpatialStoreOptions } from "./safetySpatialStore.ts";
import { MODEL_OPTIMIZATION_API, type ModelInspection, type ModelInspectionIssue } from "../src/safetyModelOptimizationTypes.ts";
import type { ModelRegistryEntry } from "../src/safetySpatialTypes.ts";

class InspectionError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const contains = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"); };
type Options = SafetySpatialStoreOptions;
type Tile = { content?: { uri?: string; url?: string }; contents?: { uri?: string; url?: string }[]; children?: Tile[]; geometricError?: number; refine?: string; transform?: number[]; boundingVolume?: { box?: number[]; sphere?: number[]; region?: number[] } };

/** Inspects original published files without rewriting a single source byte. It does not infer mesh topology from pictures. */
export async function inspectPublishedModel(model: ModelRegistryEntry, options: Options = {}): Promise<ModelInspection> {
  const libraryRoot = resolve(options.libraryDataDir || process.env.CESIUM_DATA_DIR || join(process.cwd(), "project-data"));
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(model.assetId)) throw new InspectionError(400, "INVALID_ASSET", "模型编号无效");
  const actualLibraryRoot = await realpath(libraryRoot);
  const recordRoot = await realpath(join(libraryRoot, "records", model.assetId));
  if (!contains(actualLibraryRoot, recordRoot) || recordRoot === actualLibraryRoot) throw new InspectionError(400, "INVALID_PATH", "模型记录目录越界");
  const root = await realpath(join(recordRoot, "tiles"));
  if (!contains(recordRoot, root) || root === recordRoot) throw new InspectionError(400, "INVALID_PATH", "模型目录越界");
  const files = new Map<string, number>();
  async function walk(folder: string): Promise<void> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new InspectionError(400, "SYMLINK", "模型检查不跟随符号链接");
      const file = join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) { if (files.size >= 100000) throw new InspectionError(413, "LIMIT", "模型文件过多，需要离线完整检查"); files.set(file, (await stat(file)).size); }
    }
  }
  await walk(root);
  const issues: ModelInspectionIssue[] = [], references = new Set<string>(), errors: number[] = [];
  const refineModes = new Set<string>(); let tilesetDocuments = 0, tileNodes = 0, binaryTiles = 0, externalReferences = 0;
  const issue = (kind: string, summary: string, file: string) => { if (issues.length < 200) issues.push({ category: "display", kind, summary, evidence: relative(root, file).replaceAll("\\", "/") }); };
  function inspectNode(node: Tile, file: string): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) { issue("invalid-node", "瓦片节点格式无效", file); return; }
    tileNodes++;
    if (typeof node.geometricError === "number") { if (!Number.isFinite(node.geometricError) || node.geometricError < 0) issue("geometric-error", "瓦片几何误差配置无效", file); else errors.push(node.geometricError); }
    if (node.refine) { if (typeof node.refine !== "string" || !["ADD", "REPLACE"].includes(node.refine.toUpperCase())) issue("refine", "瓦片细化方式无效", file); else refineModes.add(node.refine.toUpperCase()); }
    if (node.transform && (!Array.isArray(node.transform) || node.transform.length !== 16 || node.transform.some(n => !Number.isFinite(n)))) issue("transform", "瓦片变换矩阵无效", file);
    const b = node.boundingVolume;
    const shapes = [b?.box, b?.sphere, b?.region];
    if (!b || !shapes.some((shape, index) => Array.isArray(shape) && shape.length === [12, 4, 6][index])
      || shapes.some(shape => shape !== undefined && (!Array.isArray(shape) || shape.some(n => !Number.isFinite(n))))
      || (Array.isArray(b.sphere) && b.sphere[3] < 0)) issue("bounding-volume", "瓦片包围体需要检查", file);
    if (node.contents !== undefined && !Array.isArray(node.contents)) issue("invalid-contents", "瓦片内容列表格式无效", file);
    for (const content of [node.content, ...(Array.isArray(node.contents) ? node.contents : [])]) {
      const uri = content?.uri || content?.url; if (!uri) continue;
      if (typeof uri !== "string") { issue("content-uri", "内容引用格式无效", file); continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("//")) { externalReferences++; continue; }
      try {
        const value = decodeURIComponent(uri.split(/[?#]/)[0]);
        const target = resolve(dirname(file), value);
        if (!contains(root, target)) issue("reference-outside", "内容引用越出该模型目录，未访问", file);
        else { references.add(target); if (!files.has(target)) issue("missing-content", `引用内容不存在：${relative(root, target).replaceAll("\\", "/")}`, file); }
      } catch { issue("content-uri", "内容引用编码无效", file); }
    }
    if (node.children !== undefined && !Array.isArray(node.children)) issue("invalid-children", "瓦片子节点列表格式无效", file);
    for (const child of Array.isArray(node.children) ? node.children : []) inspectNode(child, file);
  }
  const entryPrefix = `/__library/files/${model.assetId}/tiles/`;
  if (!model.url.startsWith(entryPrefix)) throw new InspectionError(400, "INVALID_ENTRY", "模型入口与已注册来源不匹配");
  let entry: string;
  try { entry = resolve(root, decodeURIComponent(model.url.slice(entryPrefix.length))); }
  catch { throw new InspectionError(400, "INVALID_ENTRY", "模型入口编码无效"); }
  if (!contains(root, entry) || entry === root) throw new InspectionError(400, "INVALID_ENTRY", "模型入口越界");
  if (!files.has(entry)) issue("missing-entry", "已注册的模型入口文件不存在", entry);
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  for (let i = 0; i < entries.length; i += 16) await Promise.all(entries.slice(i, i + 16).map(async ([file, size]) => {
    const extension = extname(file).toLowerCase();
    if (extension === ".json") {
      try { const doc = JSON.parse(await readFile(file, "utf8")) as { root?: Tile };
        if (doc && typeof doc === "object" && doc.root) { tilesetDocuments++; inspectNode(doc.root, file); }
        else if (file === entry) issue("missing-root", "模型入口缺少有效根瓦片", file);
      }
      catch { issue("invalid-json", "JSON 内容无法解析", file); }
    } else if (extension === ".b3dm") {
      binaryTiles++; const handle = await open(file, "r");
      try { const header = Buffer.alloc(28); const result = await handle.read(header, 0, 28, 0);
        const payloadOffset = result.bytesRead === 28 ? [12,16,20,24].reduce((a,b)=>a+header.readUInt32LE(b),28) : size;
        if (result.bytesRead !== 28 || header.toString("ascii", 0, 4) !== "b3dm" || header.readUInt32LE(4) !== 1 || header.readUInt32LE(8) !== size || payloadOffset + 12 > size) issue("invalid-b3dm", "b3dm 文件头或字节长度不一致", file);
        else {
          const payload = Buffer.alloc(12), read = await handle.read(payload, 0, 12, payloadOffset);
          const length = payload.readUInt32LE(8), remaining = size - payloadOffset;
          if (read.bytesRead !== 12 || payload.toString("ascii", 0, 4) !== "glTF" || ![1, 2].includes(payload.readUInt32LE(4))
            || length < 12 || length > remaining || remaining - length >= 8) issue("invalid-glb-header", "b3dm 内嵌模型文件头或长度无效", file);
        }
      } finally { await handle.close(); }
    }
  }));
  if (!tilesetDocuments) issue("missing-tileset", "未找到可检查的瓦片索引", entry);
  issues.sort((a, b) => `${a.evidence}:${a.kind}:${a.summary}`.localeCompare(`${b.evidence}:${b.kind}:${b.summary}`));
  // Inspect only the saved source project and bounded known cache folders. HTTP callers cannot select arbitrary paths.
  let projectLocated = false, intermediateCacheLocated = false, supportedEditableMeshLocated = false;
  try {
    const record = JSON.parse(await readFile(join(recordRoot, "record.json"), "utf8"));
    const source = record.settings?.localPath;
    if (typeof source === "string" && isAbsolute(source)) {
      const project = resolve(source, "../../..");
      const children = await readdir(project, { withFileTypes: true });
      projectLocated = children.some(e => e.isFile() && e.name.toLowerCase().endsWith(".ccm"));
      if (projectLocated && children.some(e => e.isDirectory() && e.name === "Project files")) {
        let remaining = 5000;
        const hasCache = async (folder: string, depth: number): Promise<boolean> => {
          if (depth < 0 || remaining <= 0) return false;
          for (const item of await readdir(folder, { withFileTypes: true })) {
            if (--remaining < 0) return false;
            if (item.isSymbolicLink()) continue;
            if (item.isFile() && extname(item.name).toLowerCase() === ".3mxb") return true;
            if (item.isDirectory() && await hasCache(join(folder, item.name), depth - 1)) return true;
          }
          return false;
        };
        const projectFiles = join(project, "Project files");
        // ContextCapture also stores thousands of image/features files. Inspect known
        // reconstruction folders first, so those unrelated caches cannot exhaust the budget.
        const reconstructionRoots: string[] = [];
        for (const block of await readdir(projectFiles, { withFileTypes: true })) {
          if (!block.isDirectory() || block.isSymbolicLink() || !/^Block_/i.test(block.name)) continue;
          for (const item of await readdir(join(projectFiles, block.name), { withFileTypes: true })) {
            if (item.isDirectory() && !item.isSymbolicLink() && /^Reconstruction_/i.test(item.name))
              reconstructionRoots.push(join(projectFiles, block.name, item.name));
          }
        }
        for (const candidate of reconstructionRoots.length ? reconstructionRoots : [projectFiles]) {
          if (await hasCache(candidate, 5)) { intermediateCacheLocated = true; break; }
        }
      }
      supportedEditableMeshLocated = children.some(e => e.isFile() && [".obj", ".ply", ".fbx"].includes(extname(e.name).toLowerCase()));
    }
  } catch { /* Source evidence may be unavailable; published files remain usable. */ }
  const reason = projectLocated ? "已找到原摄影工程；可编辑网格导出、受支持的离线处理服务和核验候选尚未接入" : "源网格与离线处理服务未接入，几何修复待处理";
  return { version: 1, id: createHash("sha256").update(model.assetVersion + JSON.stringify(issues)).digest("hex"), checkedAt: new Date().toISOString(), source: structuredClone(model), scope: "published-tiles-readonly",
    inventory: { files: files.size, bytes: entries.reduce((total, [, size]) => total + size, 0), tilesetDocuments, tileNodes, binaryTiles, referencedFiles: references.size, ...(errors.length ? { geometricErrorRange: [errors.reduce((a,b)=>Math.min(a,b),Infinity), errors.reduce((a,b)=>Math.max(a,b),-Infinity)] as [number,number] } : {}), refineModes: [...refineModes].sort(), externalReferences },
    display: { status: issues.length ? "failed" : "checked", issues }, mesh: { status: "unavailable", reason },
    texture: { status: "unavailable", reason: "仅检查发布文件完整性；纹理接缝、重烘焙与原图配准未执行" },
    sourceEvidence: { projectLocated, intermediateCacheLocated, supportedEditableMeshLocated, note: "原工程和缓存的存在不等于已有可核验修复模型；未扫描网格拓扑或封闭桥孔" },
    capabilities: { inspectPublishedTiles: true, compareDisplay: true, createGeometryCandidate: false, activateCandidate: false, rollbackCandidate: false, reason }, activeVersion: model.assetVersion, candidates: [], originalReadonly: true };
}

export function createModelOptimizationService(options: Options = {}) {
  const pending = new Map<string, Promise<ModelInspection>>();
  async function inspect(assetId: string, expectedVersion: string): Promise<ModelInspection> {
    const models = await loadProjectModelRegistry(options); const model = models.find(m => m.assetId === assetId);
    if (!model) throw new InspectionError(404, "MODEL_UNAVAILABLE", "未找到已核验的项目倾斜摄影");
    if (!expectedVersion || model.assetVersion !== expectedVersion) throw new InspectionError(409, "VERSION_CHANGED", "模型版本已变化，请刷新后重新检查");
    const key = `${model.assetId}:${model.assetVersion}:${model.coordinateTransformVersion}`;
    let task = pending.get(key);
    if (!task) {
      task = inspectPublishedModel(model, options).then(async report => {
        const current = (await loadProjectModelRegistry(options)).find(m => m.assetId === model.assetId);
        if (!current || current.assetVersion !== model.assetVersion || current.coordinateTransformVersion !== model.coordinateTransformVersion)
          throw new InspectionError(409, "VERSION_CHANGED", "检查期间模型版本或变换已变化，请刷新后重新检查");
        return report;
      }).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return task;
  }
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith(MODEL_OPTIMIZATION_API + "/")) { next(); return; }
    try {
      if (req.headers.origin) {
        let sameOrigin = false;
        try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* Opaque/invalid origins cannot identify this host. */ }
        if (!sameOrigin) throw new InspectionError(403, "CROSS_ORIGIN", "不允许跨站操作项目模型");
      }
      if (url.pathname === MODEL_OPTIMIZATION_API + "/inspect" && req.method === "GET") { send(res, 200, await inspect(url.searchParams.get("assetId") || "", url.searchParams.get("expectedVersion") || "")); return; }
      if (["candidate", "validate", "activate", "rollback"].some(p => url.pathname === MODEL_OPTIMIZATION_API + "/" + p)) throw new InspectionError(409, "PIPELINE_UNAVAILABLE", "尚无受支持的源网格处理服务及核验候选，未修改当前活动版本或人工数据");
      throw new InspectionError(405, "METHOD_NOT_ALLOWED", "当前模型优化仅支持原始发布瓦片检查与同镜头显示对照");
    } catch (e) { const error = e as InspectionError; send(res, error.status || 500, { error: error.message || "模型检查失败，原模型保持不变", code: error.code || "INSPECTION_FAILED" }); }
  }
  return { inspect, middleware };
}
function send(res: ServerResponse, status: number, value: unknown): void { if (res.destroyed || res.headersSent) return; res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value)); }
export function modelOptimizationPlugin(options: Options = {}): Plugin { const service = createModelOptimizationService(options); return { name: "project-model-optimization", configureServer(server) { server.middlewares.use(service.middleware); }, configurePreviewServer(server) { server.middlewares.use(service.middleware); } }; }
