import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { EMPTY_EVENT_SNAPSHOT, SAFETY_EVENTS_API_PATH, type SafetyEventRecord, type SafetyEventSnapshot } from "../src/safetyEventTypes.ts";
import { validateSafetyEventMutation, validateSafetyEventSnapshot } from "../src/safetyEventValidation.ts";
import { SpatialValidationError } from "../src/safetySpatialValidation.ts";

type Receipt = { id: string; signature: string };
type Persisted = SafetyEventSnapshot & { mutations: Receipt[] };
export type SafetyEventStoreOptions = { dataDir?: string; projectId?: string; validateImportedEvent?: (event: SafetyEventRecord) => Promise<boolean> };
class EventStoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly snapshot?: SafetyEventSnapshot) { super(message); }
}
function output(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value));
}

/** Separate event journal. No operation reads, creates, moves, deletes or changes a user definition. */
export function createSafetyEventStore(options: SafetyEventStoreOptions = {}) {
  const dataDir = resolve(options.dataDir || process.env.CESIUM_SAFETY_DATA_DIR || join(process.cwd(), "project-data"));
  const path = join(dataDir, "safety-events.json");
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Persisted> {
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...structuredClone(EMPTY_EVENT_SNAPSHOT), mutations: [] }; throw error; }
    try {
      const parsed = JSON.parse(raw), snapshot = validateSafetyEventSnapshot(parsed), receipts = parsed.mutations;
      if (!Array.isArray(receipts) || receipts.length > 64 || !receipts.every(item => item && typeof item.id === "string" && /^[a-f0-9]{64}$/.test(item.signature))) throw new Error("回执无效");
      return { ...snapshot, mutations: receipts };
    } catch { throw new EventStoreError(500, "STORAGE_CORRUPT", "事件文件损坏或版本不兼容，原文件已保留"); }
  }
  function publicSnapshot(value: Persisted): SafetyEventSnapshot { const { mutations: _receipts, ...snapshot } = value; return snapshot; }
  async function load(): Promise<SafetyEventSnapshot> { return publicSnapshot(await read()); }
  async function atomicWrite(value: Persisted): Promise<void> {
    await mkdir(dataDir, { recursive: true }); const temporary = join(dataDir, `safety-events-${randomUUID()}.pending`);
    try {
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  function mutate(value: unknown): Promise<SafetyEventSnapshot> {
    const mutation = validateSafetyEventMutation(value);
    const task = queue.catch(() => undefined).then(async () => {
      const persisted = await read(), snapshot = publicSnapshot(persisted);
      const signature = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
      const receipt = persisted.mutations.find(item => item.id === mutation.mutationId);
      if (receipt) {
        if (receipt.signature !== signature) throw new EventStoreError(409, "MUTATION_ID_REUSED", "请求编号已用于其他操作，请重新读取", snapshot);
        return snapshot;
      }
      if (mutation.expectedRevision !== snapshot.revision) throw new EventStoreError(409, "REVISION_CONFLICT", "事件已被更新，输入已保留，请重新读取后核对", snapshot);
      const events = [...snapshot.events], now = new Date().toISOString();
      if (mutation.operation === "create") {
        const event = mutation.event;
        if (event.projectId !== (options.projectId || "safety:project")) throw new EventStoreError(400, "PROJECT_MISMATCH", "事件不属于当前项目", snapshot);
        if (events.some(item => item.id === event.id)) throw new EventStoreError(409, "EVENT_EXISTS", "事件编号已存在，未重复创建", snapshot);
        if (event.source.kind === "imported-event") {
          if (!options.validateImportedEvent || !await options.validateImportedEvent(event)) throw new EventStoreError(400, "IMPORT_SOURCE_UNVERIFIED", "导入事件尚未通过现有业务来源核验", snapshot);
        } else if (event.status !== "pending" || event.handling) throw new EventStoreError(400, "INVALID_INITIAL_STATUS", "新人工事件应从待处理开始", snapshot);
        events.push({ ...event, createdAt: event.source.kind === "imported-event" ? event.createdAt : now, updatedAt: now });
      } else {
        const index = events.findIndex(event => event.id === mutation.id);
        if (index < 0) throw new EventStoreError(404, "EVENT_NOT_FOUND", "事件不存在，请重新读取", snapshot);
        if (events[index].status === "completed") throw new EventStoreError(409, "EVENT_COMPLETED", "事件已完成，原处理结果保留", snapshot);
        events[index] = { ...events[index], status: "completed", updatedAt: now,
          handling: { description: mutation.result.description, attachmentIds: mutation.result.attachmentIds || [], handledAt: now,
            ...(mutation.result.handledBy ? { handledBy: mutation.result.handledBy } : {}) } };
      }
      const next = validateSafetyEventSnapshot({ version: 1, revision: snapshot.revision + 1, updatedAt: now, events });
      await atomicWrite({ ...next, mutations: [...persisted.mutations, { id: mutation.mutationId, signature }].slice(-64) });
      return next;
    });
    queue = task; return task;
  }
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    if (new URL(req.url || "/", "http://localhost").pathname !== SAFETY_EVENTS_API_PATH) { next(); return; }
    try {
      if (req.headers.origin) {
        let host = ""; try { host = new URL(req.headers.origin).host; } catch { /* Opaque origin. */ }
        if (!host || host !== req.headers.host) throw new EventStoreError(403, "CROSS_ORIGIN", "不允许跨站读写事件");
      }
      if (req.method === "GET") { output(res, 200, await load()); return; }
      if (req.method !== "POST") throw new EventStoreError(405, "METHOD_NOT_ALLOWED", "事件操作不受支持");
      if (req.headers["x-cesium-library"] !== "1") throw new EventStoreError(403, "MISSING_REQUEST_MARKER", "缺少事件操作标识");
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new EventStoreError(415, "CONTENT_TYPE", "事件请求必须为 JSON");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 1_048_576) throw new EventStoreError(413, "BODY_TOO_LARGE", "事件请求过大"); chunks.push(chunk); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new EventStoreError(400, "INVALID_JSON", "事件请求格式无效"); }
      output(res, 200, await mutate(value));
    } catch (error) {
      if (error instanceof EventStoreError) output(res, error.status, { code: error.code, error: error.message, ...(error.snapshot ? { snapshot: error.snapshot } : {}) });
      else if (error instanceof SpatialValidationError) output(res, 400, { code: "VALIDATION", error: error.message });
      else output(res, 500, { code: "STORAGE_ERROR", error: "保存失败，处理状态未变更，请保留输入后重试" });
    }
  }
  return { load, mutate, middleware, path };
}
export function safetyEventPlugin(options: SafetyEventStoreOptions = {}): Plugin {
  const store = createSafetyEventStore(options);
  return { name: "cesium-safety-events", configureServer(server) { server.middlewares.use(store.middleware); }, configurePreviewServer(server) { server.middlewares.use(store.middleware); } };
}
