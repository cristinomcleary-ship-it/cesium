import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { managementActor } from './management/actorContext.ts';
import { assertSameOrigin, boundedJson, HttpBoundaryError, privateJson } from './httpBoundary.ts';

export const RENDER_DIAGNOSTIC_LIMITS = Object.freeze({ bodyBytes: 256 * 1024, detailsCharacters: 32_768, layers: 512,
  actorPerMinute: 6, totalPerMinute: 30, actors: 256, queued: 8, records: 20, retainedBytes: 2 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000, directoryEntries: 4096 });
type Limits = { -readonly [K in keyof typeof RENDER_DIAGNOSTIC_LIMITS]: number };
type Options = { root: string; now?: () => number; limits?: Partial<Record<keyof Limits, number>> };
type Report = { occurredAt: string; details: string; cesiumVersion: string; activeModule?: string;
  canvas: { width: number; height: number; clientWidth: number; clientHeight: number };
  camera: { longitude: number; latitude: number; height: number };
  layers: Array<{ id: string; name: string; kind: string; visible: boolean; destroyed: boolean }>;
  sectionEnabled: boolean; excavationClippingEnabled: boolean };
const fail = () => { throw new HttpBoundaryError(400, '诊断记录格式无效'); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>, keys = new Set([...required, ...optional]);
  if (Object.keys(v).some(k => !keys.has(k)) || required.some(k => !Object.hasOwn(v, k))) return fail();
  return v;
}
function string(value: unknown, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > limit) fail();
}
function finite(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail();
}
function validateReport(value: unknown, limits: Limits): Report {
  const v = object(value, ['occurredAt', 'details', 'cesiumVersion', 'canvas', 'camera', 'layers', 'sectionEnabled', 'excavationClippingEnabled'], ['activeModule']);
  string(v.occurredAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v.occurredAt) || !Number.isFinite(Date.parse(v.occurredAt))) fail();
  string(v.details, limits.detailsCharacters); string(v.cesiumVersion, 40);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(v.cesiumVersion)) fail();
  if (v.activeModule !== undefined) { string(v.activeModule, 80); if (!/^[\w-]+$/.test(v.activeModule)) fail(); }
  const canvas = object(v.canvas, ['width', 'height', 'clientWidth', 'clientHeight']);
  Object.values(canvas).forEach(n => finite(n, 0, 131_072));
  const camera = object(v.camera, ['longitude', 'latitude', 'height']);
  finite(camera.longitude, -180, 180); finite(camera.latitude, -90, 90); finite(camera.height, -100_000, 1e10);
  if (!Array.isArray(v.layers) || v.layers.length > limits.layers) return fail();
  for (const raw of v.layers) {
    const layer = object(raw, ['id', 'name', 'kind', 'visible', 'destroyed']);
    string(layer.id, 512); string(layer.name, 512); string(layer.kind, 40);
    if (!['CAD', '3D Tiles', 'GIS', 'Model', 'Imagery', 'Drone Video'].includes(layer.kind)
      || typeof layer.visible !== 'boolean' || typeof layer.destroyed !== 'boolean') fail();
  }
  if (typeof v.sectionEnabled !== 'boolean' || typeof v.excavationClippingEnabled !== 'boolean') fail();
  return v as Report;
}

/** Error names and stack shape remain useful; credentials, routes and local
 * filenames never need to become diagnostic storage or an HTTP response. */
export function redactRenderErrorDetails(details: string): string {
  return details
    .replace(/\b(?:https?|file|blob):\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n<>"']+/g, '[path]')
    .replace(/(^|[\s"'(])(?:\\\\|\/)[^\s<>"')]+/gm, '$1[path]')
    .replace(/\bBearer\s+[A-Za-z\d._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:authorization|cookie|set-cookie)\b["']?\s*[:=][^\r\n]*/gi, '[credential]')
    .replace(/\b(?:password|passwd|token|access_token|refresh_token|api[-_]?key|secret)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '[credential]')
    .replace(/[A-Za-z\d._%+-]+@[A-Za-z\d.-]+\.[A-Za-z]{2,}/g, '[email]');
}

export function createRenderDiagnosticsMiddleware(options: Options) {
  const root = resolve(options.root), now = options.now ?? Date.now;
  const limits: Limits = { ...RENDER_DIAGNOSTIC_LIMITS };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value <= 0 || value > limits[key as keyof Limits]) throw new Error('诊断限额无效');
    limits[key as keyof Limits] = value;
  }
  const salt = randomBytes(32), actors = new Map<string, { time: number; count: number }>();
  let globalWindow = { time: now(), count: 0 }, queued = 0, queue: Promise<unknown> = Promise.resolve();
  function admit(id: string) {
    const time = now();
    for (const [key, value] of actors) if (time - value.time >= 60_000) actors.delete(key);
    if (time - globalWindow.time >= 60_000) globalWindow = { time, count: 0 };
    const entry = actors.get(id) ?? { time, count: 0 };
    if (entry.count >= limits.actorPerMinute || globalWindow.count >= limits.totalPerMinute || !actors.has(id) && actors.size >= limits.actors)
      throw new HttpBoundaryError(429, '诊断上报过于频繁，请稍后重试');
    entry.count++; globalWindow.count++; actors.set(id, entry);
  }
  async function storageRoot() {
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpBoundaryError(503, '诊断存储目录不可用');
  }
  async function retain(extraBytes: number) {
    await storageRoot();
    const archives: Array<{ name: string; size: number; time: number }> = [];
    let count = 0, otherBytes = 0, otherCount = 0;
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (++count > limits.directoryEntries) throw new HttpBoundaryError(503, '诊断存储目录超过检查上限');
      const info = await lstat(join(root, entry.name));
      if (!info.isFile() || info.isSymbolicLink()) throw new HttpBoundaryError(503, '诊断存储包含非普通文件');
      const match = /^(\d{13})(?:-[\da-f-]{36})?\.json$/.exec(entry.name);
      if (match) archives.push({ name: entry.name, size: info.size, time: Number(match[1]) });
      else if (entry.name !== 'latest.json') { otherBytes += info.size; otherCount++; }
    }
    // Reserve both latest.json and the newly accepted history entry before writing.
    let bytes = otherBytes + extraBytes * 2, retained = otherCount + 2;
    archives.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
    for (const archive of archives) {
      if (now() - archive.time > limits.retentionMs || retained + 1 > limits.records || bytes + archive.size > limits.retainedBytes)
        await unlink(join(root, archive.name));
      else { retained++; bytes += archive.size; }
    }
    if (retained > limits.records || bytes > limits.retainedBytes) throw new HttpBoundaryError(503, '诊断存储已达保留上限');
  }
  function sanitized(report: Report) {
    let details = redactRenderErrorDetails(report.details);
    for (const layer of report.layers) for (const identity of [layer.id, layer.name])
      if (identity.length >= 4) details = details.split(identity).join('[layer]');
    return { ...report, details, camera: { longitude: '[redacted]', latitude: '[redacted]', height: '[redacted]' },
      layers: report.layers.map(layer => ({ ...layer, id: createHmac('sha256', salt).update(layer.id).digest('hex').slice(0, 16), name: '[redacted]' })) };
  }
  async function write(report: Report) {
    const content = JSON.stringify(sanitized(report), null, 2) + '\n';
    const bytes = Buffer.byteLength(content);
    if (bytes > limits.bodyBytes) throw new HttpBoundaryError(413, '诊断记录超过大小限制');
    await retain(bytes);
    const archive = join(root, `${now()}-${randomUUID()}.json`), pending = join(root, 'latest.pending');
    try {
      await writeFile(archive, content, { flag: 'wx', mode: 0o600 });
      await writeFile(pending, content, { flag: 'wx', mode: 0o600 });
      await rename(pending, join(root, 'latest.json'));
    } catch (error) {
      await unlink(archive).catch(() => undefined); await unlink(pending).catch(() => undefined); throw error;
    }
  }
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { privateJson(response, 400, { ok: false, error: '请求地址无效' }); return; }
    if (!/^\/__diagnostics(?:\/|$)/.test(url.pathname)) return next();
    try {
      assertSameOrigin(request);
      const actor = managementActor(request), method = request.method ?? 'GET';
      if (!actor) throw new HttpBoundaryError(401, '请先登录');
      const post = url.pathname === '/__diagnostics/render-error', latest = url.pathname === '/__diagnostics/render-error/latest';
      if (!post && !latest) throw new HttpBoundaryError(404, '诊断接口不存在');
      if (post ? method !== 'POST' : !['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', post ? 'POST' : 'GET, HEAD'); throw new HttpBoundaryError(405, '不支持此操作');
      }
      if (!actor.permissions.includes(post ? 'read' : 'admin')) throw new HttpBoundaryError(403, '当前账户没有诊断权限');
      if (post) {
        admit(actor.id);
        if (queued >= limits.queued) throw new HttpBoundaryError(429, '诊断上报队列已满');
        const report = validateReport(await boundedJson(request, limits.bodyBytes), limits);
        if (queued >= limits.queued) throw new HttpBoundaryError(429, '诊断上报队列已满');
        queued++;
        const task = queue.catch(() => undefined).then(() => write(report)); queue = task;
        try { await task; } finally { queued--; }
        return privateJson(response, 200, { ok: true });
      }
      // Legacy latest.json is never returned unsanitized. Do not rewrite old logs on reads.
      await queue.catch(() => undefined); await storageRoot();
      const latestPath = join(root, 'latest.json'), before = await lstat(latestPath);
      if (!before.isFile() || before.isSymbolicLink()) throw new HttpBoundaryError(503, '诊断存储记录不可用');
      const handle = await open(latestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat(), after = await lstat(latestPath);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino
          || after.dev !== info.dev || after.ino !== info.ino) throw new HttpBoundaryError(503, '诊断存储记录已变化');
        if (!info.isFile() || info.size > limits.bodyBytes) throw new HttpBoundaryError(413, '诊断记录超过大小限制');
        const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
        // Current sanitized records retain the same top-level fields but redact camera values.
        const current = parsed as Report;
        const projected = current && typeof current === 'object' && current.camera?.longitude === ('[redacted]' as unknown)
          ? validateReport({ ...current, camera: { longitude: 0, latitude: 0, height: 0 } }, limits) : validateReport(current, limits);
        if (method === 'HEAD') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'private, no-store');
          response.setHeader('Vary', 'Cookie'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.end(); return;
        }
        return privateJson(response, 200, sanitized(projected));
      } finally { await handle.close(); }
    } catch (error) {
      const status = error instanceof HttpBoundaryError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      if (status === 429) response.setHeader('Retry-After', '60');
      privateJson(response, status, { ok: false, error: error instanceof HttpBoundaryError ? error.message : status === 404 ? '暂无渲染异常记录' : '诊断存储不可用' });
    }
  };
}
