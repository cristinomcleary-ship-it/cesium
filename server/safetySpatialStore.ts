import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { SPATIAL_API_PATH, type SpatialMutation, type SpatialSnapshot } from "../src/safetySpatialTypes.ts";
import { emptySpatialSnapshot, SPATIAL_LIMITS, SpatialValidationError, validateSpatialMutation, validateSpatialSnapshot } from "../src/safetySpatialValidation.ts";

type Receipt = { id: string; signature: string };
type Persisted = SpatialSnapshot & { mutations: Receipt[] };
class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly snapshot?: SpatialSnapshot) { super(message); }
}
function output(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value));
}

export function createSafetySpatialStore(options: { dataDir?: string } = {}) {
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
        const object = { ...mutation.object, createdAt: index >= 0 ? objects[index].createdAt : now, updatedAt: now };
        if (index >= 0) objects[index] = object; else objects.push(object);
      } else {
        const index = objects.findIndex((item) => item.id === mutation.id);
        if (index === -1) throw new StoreError(404, "OBJECT_NOT_FOUND", "空间对象已不存在，请刷新列表", snapshot);
        objects.splice(index, 1);
      }
      const next = validateSpatialSnapshot({ version: 1, revision: snapshot.revision + 1, updatedAt: now, objects });
      await atomicWrite({ ...next, mutations: [...persisted.mutations, { id: mutation.mutationId, signature }].slice(-64) });
      return next;
    });
    queue = task; return task;
  }
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== SPATIAL_API_PATH) { next(); return; }
    try {
      if (req.headers.origin) {
        let originHost = ""; try { originHost = new URL(req.headers.origin).host; } catch { /* Opaque origins are rejected. */ }
        if (!originHost || originHost !== req.headers.host) throw new StoreError(403, "CROSS_ORIGIN", "不允许跨站读写人工标绘");
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

export function safetySpatialPlugin(options: { dataDir?: string } = {}): Plugin {
  const store = createSafetySpatialStore(options);
  return { name: "cesium-safety-spatial", configureServer(server) { server.middlewares.use(store.middleware); },
    configurePreviewServer(server) { server.middlewares.use(store.middleware); } };
}
