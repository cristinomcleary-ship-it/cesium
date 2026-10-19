import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, lstat, readdir, cp, copyFile, realpath, open } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LibraryRecord, LibrarySettings, SceneView } from "../src/projectLibrary";
import { managementActor, managementResourceReadable } from "./management/actorContext.ts";

type TilesLocation = { root: string; entry: string; aggregate?: unknown } | { error: string };
type Options = { storageRoot?: string; resolveTiles?: (path: string) => TilesLocation };
const validId = /^[a-zA-Z0-9_-]{1,80}$/;
const validSlot = /^[a-zA-Z0-9_-]{1,80}$/;
const maxFileBytes = 16 * 1024 ** 3;
const maxPosFileBytes = 16 * 1024 ** 2;
const kinds = ["CAD", "3D Tiles", "GIS", "Model", "Imagery", "Drone Video"];
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(".." + "/") && !rel.startsWith("..\\") && rel !== ".." && !isAbsolute(rel);
}
async function exists(path: string) { try { await stat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".pending";
  const handle = await open(temp, "wx");
  try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
}
async function bodyJson(request: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const raw of request) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, "资料信息过大");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new HttpError(400, "资料信息不是有效 JSON"); }
}
function settingsValue(value: unknown): LibrarySettings {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 900_000) throw new HttpError(400, "资料参数无效");
  return value as LibrarySettings;
}
function validateRecord(value: unknown, id: string): LibraryRecord {
  const r = value as LibraryRecord;
  if (!r || r.version !== 1 || r.id !== id || !kinds.includes(r.kind) || typeof r.name !== "string" || !r.name.trim() || r.name.length > 500 || typeof r.visible !== "boolean") throw new HttpError(400, "资料记录无效");
  settingsValue(r.settings);
  if (!r.files || typeof r.files !== "object" || Array.isArray(r.files)) throw new HttpError(400, "文件清单无效");
  for (const [slot, file] of Object.entries(r.files)) {
    if (!validSlot.test(slot) || !file || typeof file.name !== "string" || file.name.length > 500 || typeof file.url !== "string" || !file.url.startsWith("/__library/files/" + id + "/" + slot + "/")) throw new HttpError(400, "保存文件地址无效");
  }
  return r;
}
function safeFile(root: string, encoded: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { throw new HttpError(400, "文件路径编码无效"); }
  if (decoded.includes("\0") || decoded.includes(":") || decoded.split(/[\\/]/).some(p => p === ".." || p === ".")) throw new HttpError(400, "文件路径无效");
  const path = resolve(root, decoded);
  if (!inside(root, path)) throw new HttpError(400, "禁止越界访问文件");
  return path;
}
const mime: Record<string, string> = { ".json": "application/json", ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".zip": "application/zip" };

export function createProjectLibrary(projectRoot: string, options: Options = {}) {
  const root = resolve(options.storageRoot ?? join(projectRoot, "project-data"));
  const recordsRoot = join(root, "records");
  const tombstones = join(root, "deleted");
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const promise = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    queues.set(id, promise);
    void promise.finally(() => { if (queues.get(id) === promise) queues.delete(id); }).catch(() => undefined);
    return promise;
  }
  function recordRoot(id: string) {
    if (!validId.test(id)) throw new HttpError(400, "资料编号无效");
    return join(recordsRoot, id);
  }
  async function active(id: string) {
    recordRoot(id);
    if (await exists(join(tombstones, id + ".json"))) throw new HttpError(410, "这份资料已删除，不能被旧页面重新保存");
  }
  async function readRecord(id: string) {
    await active(id);
    try { return validateRecord(JSON.parse(await readFile(join(recordRoot(id), "record.json"), "utf8")), id); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "资料不存在"); throw e; }
  }
  async function list() {
    await mkdir(recordsRoot, { recursive: true });
    const records: LibraryRecord[] = []; const problems: Array<{ id: string; error: string }> = [];
    for (const entry of await readdir(recordsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId.test(entry.name)) continue;
      if (await exists(join(tombstones, entry.name + ".json"))) continue;
      if (!await exists(join(recordsRoot, entry.name, "record.json"))) continue; // interrupted, uncommitted import
      try { records.push(await readRecord(entry.name)); }
      catch { problems.push({ id: entry.name, error: "资料索引无法读取，原文件仍保留，请检查 project-data" }); }
    }
    let view: SceneView | undefined;
    try { view = JSON.parse(await readFile(join(root, "view.json"), "utf8")) as SceneView; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") problems.push({ id: "view", error: "上次视角无法读取，已保留原文件" }); }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { records, problems, view };
  }
  async function save(id: string, value: unknown) {
    return serial(id, async () => {
      await active(id);
      const path = join(recordRoot(id), "record.json");
      if (await exists(path)) throw new HttpError(409, "资料编号已存在，请更新已有资料");
      const record = validateRecord(value, id);
      for (const file of Object.values(record.files)) {
        const path = safeFile(recordRoot(id), file.url.slice(("/__library/files/" + id + "/").length));
        if (!await exists(path)) throw new HttpError(400, "文件尚未保存完成");
      }
      const now = new Date().toISOString();
      record.createdAt = now; record.updatedAt = now;
      await atomicJson(path, record); return record;
    });
  }
  async function patch(id: string, value: Record<string, unknown>) {
    return serial(id, async () => {
      const record = await readRecord(id);
      if ("visible" in value) {
        if (typeof value.visible !== "boolean") throw new HttpError(400, "显示状态无效");
        record.visible = value.visible;
      }
      if ("settings" in value) record.settings = { ...record.settings, ...settingsValue(value.settings) };
      record.updatedAt = new Date().toISOString();
      await atomicJson(join(recordRoot(id), "record.json"), record); return record;
    });
  }
  async function remove(id: string) {
    return serial(id, async () => {
      const dir = recordRoot(id);
      // Persist deletion before removing owned files; stale saves cannot resurrect a deleted record.
      await atomicJson(join(tombstones, id + ".json"), { deletedAt: new Date().toISOString() });
      if (!inside(root, dir)) throw new HttpError(400, "删除路径越界");
      // The durable tombstone is the delete commit. A file in use may be reclaimed on a later delete.
      await rm(dir, { recursive: true, force: true }).catch(error => console.warn("[project-library] deleted record files still in use:", id, (error as Error).message));
    });
  }
  async function upload(id: string, slot: string, name: string, request: IncomingMessage) {
    return serial(id, async () => {
      await active(id);
      if (!validSlot.test(slot)) throw new HttpError(400, "文件槽位无效");
      const cleanName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(-200) || "data.bin";
      const dir = join(recordRoot(id), slot);
      if (await exists(join(recordRoot(id), "record.json"))) throw new HttpError(409, "已保存资料的原文件不可覆盖");
      await mkdir(dir, { recursive: true });
      const output = join(dir, cleanName);
      const temp = join(dir, randomUUID() + ".pending");
      let size = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(size > maxFileBytes ? new HttpError(413, "单个上传文件不能超过 16GB") : null, chunk);
      } });
      try { await pipeline(request, limit, createWriteStream(temp, { flags: "wx" })); await rename(temp, output); }
      catch (error) { await rm(temp, { force: true }); throw error; }
      return { name, url: "/__library/files/" + id + "/" + slot + "/" + encodeURIComponent(cleanName) };
    });
  }
  async function appendVideoPos(id: string, request: IncomingMessage) {
    return serial(id, async () => {
      const record = await readRecord(id);
      if (record.kind !== "Drone Video" || record.settings.video?.mode !== "cc-overlay") throw new HttpError(400, "POS 附件仅用于已保存的 CC 融合方案");
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.startsWith("multipart/form-data;")) throw new HttpError(400, "POS 保存请求格式无效");
      const chunks: Buffer[] = []; let size = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw); size += chunk.length;
        if (size > maxPosFileBytes + 1024 * 1024) throw new HttpError(413, "POS CSV 不能超过 16MB");
        chunks.push(chunk);
      }
      let form: FormData;
      try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData(); }
      catch { throw new HttpError(400, "POS 保存请求格式无效"); }
      if ([...form.keys()].length !== 2 || form.getAll("pos").length !== 1 || form.getAll("settings").length !== 1) throw new HttpError(400, "POS 保存字段无效");
      const file = form.get("pos"), encodedSettings = form.get("settings");
      if (!file || typeof file === "string" || !file.name || file.name.length > 500 || extname(file.name).toLowerCase() !== ".csv" || !file.size) throw new HttpError(400, "请选择有效的 POS CSV 文件");
      if (file.size > maxPosFileBytes) throw new HttpError(413, "POS CSV 不能超过 16MB");
      if (typeof encodedSettings !== "string") throw new HttpError(400, "融合方案参数无效");
      let value: unknown;
      try { value = JSON.parse(encodedSettings); } catch { throw new HttpError(400, "融合方案参数不是有效 JSON"); }
      const settings = settingsValue(value), video = settings.video;
      if (Object.keys(settings).length !== 1 || !video || typeof video !== "object" || Array.isArray(video) || video.mode !== "cc-overlay" || video.version !== 1) throw new HttpError(400, "融合方案参数无效");
      const metadata = (video.fileMetadata as Record<string, { name?: unknown; size?: unknown; lastModified?: unknown }> | undefined)?.pos;
      if (!metadata || metadata.name !== file.name || metadata.size !== file.size || typeof metadata.lastModified !== "number" || !Number.isFinite(metadata.lastModified) || metadata.lastModified < 0) throw new HttpError(400, "POS 文件信息与融合方案不一致");
      const dir = join(recordRoot(id), "pos");
      await mkdir(dir, { recursive: true });
      if (!inside(await realpath(recordRoot(id)), await realpath(dir))) throw new HttpError(400, "POS 附件路径无效");
      const cleanName = randomUUID() + "_" + file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(-160);
      const output = join(dir, cleanName), temp = output + ".pending";
      try {
        const handle = await open(temp, "wx");
        try { await handle.writeFile(Buffer.from(await file.arrayBuffer())); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, output);
        const saved: LibraryRecord = { ...record, files: { ...record.files, pos: { name: file.name, url: "/__library/files/" + id + "/pos/" + encodeURIComponent(cleanName) } }, settings: { ...record.settings, ...settings }, updatedAt: new Date().toISOString() };
        // Publish the new pointer and its matching settings together. Previous
        // POS versions, video and XML remain immutable until the record is deleted.
        await atomicJson(join(recordRoot(id), "record.json"), validateRecord(saved, id));
        return saved;
      } catch (error) {
        await Promise.all([rm(temp, { force: true }), rm(output, { force: true })]);
        throw error;
      }
    });
  }
  async function copySource(id: string, value: Record<string, unknown>) {
    return serial(id, async () => {
      await active(id);
      const dir = recordRoot(id);
      if (await exists(join(dir, "record.json"))) throw new HttpError(409, "已保存资料不可覆盖");
      await mkdir(dir, { recursive: true });
      if (value.type === "tiles") {
        if (typeof value.path !== "string" || !options.resolveTiles) throw new HttpError(400, "倾斜摄影目录无效");
        const found = options.resolveTiles(value.path);
        if ("error" in found) throw new HttpError(400, found.error);
        const source = await realpath(found.root);
        if (source === root || inside(source, root) || inside(root, source)) throw new HttpError(400, "请选择独立的倾斜摄影成果目录");
        const dest = join(dir, "tiles");
        const copied = join(dir, "copy-result.json");
        if (await exists(copied)) return JSON.parse(await readFile(copied, "utf8")) as { name: string; url: string };
        // Copy to an uncommitted staging directory. Interrupted copies never become live datasets.
        const staging = join(dir, "tiles-" + randomUUID() + ".pending");
        await cp(source, staging, { recursive: true, errorOnExist: true, force: false, filter: async (path) => {
          if ((await lstat(path)).isSymbolicLink()) throw new HttpError(400, "成果含符号链接，请先整理为完整的本地成果目录");
          return true;
        } });
        if (await exists(dest)) await rm(dest, { recursive: true, force: true }); // only an uncommitted copy of this record
        await rename(staging, dest);
        let entry = relative(found.root, found.entry).replaceAll("\\", "/");
        if (found.aggregate) { entry = "__aggregate__.json"; await atomicJson(join(dest, entry), found.aggregate); }
        const path = safeFile(dest, entry);
        if (!await exists(path)) throw new HttpError(400, "倾斜摄影入口未完整保存");
        const result = { name: entry, url: "/__library/files/" + id + "/tiles/" + entry.split("/").map(encodeURIComponent).join("/") };
        await atomicJson(copied, result);
        return result;
      }
      if (value.type === "model" && typeof value.url === "string") {
        const match = value.url.match(/^\/__models\/files\/([a-zA-Z0-9_-]+)\/(.+)$/);
        if (!match) throw new HttpError(400, "模型转换结果地址无效");
        const cache = resolve(projectRoot, ".model-cache", match[1]);
        const source = safeFile(cache, match[2]);
        if (!inside(cache, await realpath(source))) throw new HttpError(400, "模型路径无效");
        const dest = join(dir, "data", "model.glb");
        await mkdir(dirname(dest), { recursive: true }); await copyFile(source, dest);
        return { name: "model.glb", url: "/__library/files/" + id + "/data/model.glb" };
      }
      throw new HttpError(400, "不支持的数据来源");
    });
  }
  async function serve(id: string, encoded: string, req: IncomingMessage, res: ServerResponse) {
    await readRecord(id); // only committed, non-deleted assets are served
    const base = recordRoot(id); const path = safeFile(base, encoded);
    if (!inside(base, await realpath(path)) || path.endsWith("record.json") || path.endsWith(".pending")) throw new HttpError(404, "资料文件不存在");
    const info = await stat(path);
    if (!info.isFile()) throw new HttpError(404, "资料文件不存在");
    let start = 0; let end = info.size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) throw new HttpError(416, "无效的文件范围");
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
      else start = Math.max(0, info.size - Number(match[2]));
      end = Math.min(end, info.size - 1);
      if (start > end || start >= info.size) { res.setHeader("Content-Range", "bytes */" + info.size); throw new HttpError(416, "文件范围越界"); }
      res.statusCode = 206; res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + info.size);
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", mime[extname(path).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", Math.max(0, end - start + 1));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "HEAD" || !info.size) { res.end(); return; }
    await pipeline(createReadStream(path, { start, end }), res);
  }
  function send(res: ServerResponse, code: number, value: unknown) {
    if (res.destroyed || res.headersSent) return;
    res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(value));
  }
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/__library")) return next();
    try {
      // Browser requests that write/copy local files must originate in this app.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "不允许跨站访问资料库");
      const method = req.method ?? "GET";
      if (!["GET", "HEAD"].includes(method) && req.headers["x-cesium-library"] !== "1") throw new HttpError(403, "缺少资料库请求标识");
      if (url.pathname === "/__library/records" && method === "GET") {
        const listing = await list(), actor = managementActor(req);
        if (!actor) return send(res, 200, listing);
        const records = listing.records.filter(record => managementResourceReadable(actor, record.kind));
        // Corrupt records have an unknown category, so do not disclose their IDs to a partial-resource session.
        const problems = managementResourceReadable(actor, "unknown") ? listing.problems : [];
        const view = actor.permissions.includes("models") && listing.view ? { ...listing.view } : undefined;
        if (view?.activeVideoId && !records.some(record => record.id === view.activeVideoId && record.kind === "Drone Video")) delete view.activeVideoId;
        if (view?.activeImageryId && !records.some(record => record.id === view.activeImageryId && record.kind === "Imagery")) delete view.activeImageryId;
        return send(res, 200, { records, problems, view });
      }
      if (url.pathname === "/__library/view" && method === "PUT") {
        const value = await bodyJson(req);
        for (const key of ["position", "direction", "up"]) {
          const numbers = value[key];
          if (!Array.isArray(numbers) || numbers.length !== 3 || !numbers.every(n => typeof n === "number" && Number.isFinite(n))) throw new HttpError(400, "视角参数无效");
        }
        if (!["street", "satellite", "none", "custom", "local"].includes(String(value.basemap))) throw new HttpError(400, "底图参数无效");
        await serial("view", () => atomicJson(join(root, "view.json"), value)); return send(res, 200, { ok: true });
      }
      const file = url.pathname.match(/^\/__library\/files\/([^/]+)\/(.+)$/);
      if (file && ["GET", "HEAD"].includes(method)) return await serve(file[1], file[2], req, res);
      const match = url.pathname.match(/^\/__library\/records\/([^/]+)(?:\/(files\/([^/]+)|copy|pos))?$/);
      if (!match) throw new HttpError(404, "资料库接口不存在");
      const id = match[1]; recordRoot(id);
      if (match[3] && method === "POST") return send(res, 200, await upload(id, match[3], url.searchParams.get("name") ?? "data.bin", req));
      if (match[2] === "pos" && method === "POST") return send(res, 200, await appendVideoPos(id, req));
      if (match[2] === "copy" && method === "POST") return send(res, 200, await copySource(id, await bodyJson(req)));
      if (!match[2] && method === "GET") {
        const record = await readRecord(id);
        if (!managementResourceReadable(managementActor(req), record.kind)) throw new HttpError(403, "当前账户没有此类资料权限");
        return send(res, 200, record);
      }
      if (!match[2] && method === "PUT") return send(res, 200, await save(id, await bodyJson(req)));
      if (!match[2] && method === "PATCH") return send(res, 200, await patch(id, await bodyJson(req)));
      if (!match[2] && method === "DELETE") { await remove(id); return send(res, 200, { ok: true }); }
      throw new HttpError(405, "不支持此操作");
    } catch (error) {
      send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : "资料库读写失败，原资料保留" });
    }
  }
  return { middleware, list, save, patch, remove, root };
}
