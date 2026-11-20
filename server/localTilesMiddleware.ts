import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { managementActor } from './management/actorContext.ts';
import { assertSameOrigin, boundedJson, HttpBoundaryError, privateJson } from './httpBoundary.ts';

type TilesetResult = { root: string; entry: string; aggregate?: unknown; candidateCount: number; topLevelCount: number };
type Mount = { root: string; entryRelative: string; aggregate?: unknown; device: number; inode: number };
const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return !!path && !path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path);
};
function fileType(path: string) {
  const types: Record<string, string> = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2' };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
function decodedPath(encoded: string) {
  let value: string;
  try { value = decodeURIComponent(encoded); } catch { throw new HttpBoundaryError(400, '文件路径编码无效'); }
  if (!value || /[\x00-\x1f\x7f:]/.test(value) || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..'))
    throw new HttpBoundaryError(404, '文件不存在');
  return value.replaceAll('\\', '/');
}

/** Mount discovery remains in the existing importer. Only the HTTP/file boundary
 * is isolated here; every request is checked against the canonical mounted root. */
export function createLocalTilesMiddleware(findTileset: (path: string) => TilesetResult | { error: string }) {
  const mounts = new Map<string, Mount>();
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { privateJson(response, 400, { ok: false, error: '请求地址无效' }); return; }
    if (!/^\/__local_tiles(?:\/|$)/.test(url.pathname)) return next();
    try {
      assertSameOrigin(request);
      const actor = managementActor(request);
      if (!actor) throw new HttpBoundaryError(401, '请先登录');
      const mountRequest = url.pathname === '/__local_tiles/mount';
      const method = request.method ?? 'GET';
      if (mountRequest ? method !== 'POST' : !['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', mountRequest ? 'POST' : 'GET, HEAD');
        throw new HttpBoundaryError(405, '不支持此操作');
      }
      if (actor.taskIds !== undefined || !actor.permissions.includes(mountRequest ? 'admin' : 'models'))
        throw new HttpBoundaryError(403, '当前账户没有完整模型权限');
      if (mountRequest) {
        const body = await boundedJson(request, 16_384);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'path'))
          throw new HttpBoundaryError(400, '目录参数无效');
        const path = (body as { path?: unknown }).path;
        if (typeof path !== 'string' || !path.trim() || path.length > 4096 || /[\x00-\x1f]/.test(path))
          throw new HttpBoundaryError(400, '未提供有效目录路径');
        const found = findTileset(path.trim());
        if ('error' in found) throw new HttpBoundaryError(400, found.error);
        const root = await realpath(found.root), rootStat = await stat(root);
        if (!rootStat.isDirectory()) throw new HttpBoundaryError(400, '挂载目录无效');
        const entry = found.aggregate ? resolve(root, relative(found.root, found.entry)) : await realpath(found.entry);
        if (!inside(root, entry)) throw new HttpBoundaryError(400, '入口文件超出挂载目录');
        const entryRelative = relative(root, entry).split(sep).map(encodeURIComponent).join('/');
        const id = randomUUID();
        mounts.set(id, { root, entryRelative, aggregate: found.aggregate, device: rootStat.dev, inode: rootStat.ino });
        return privateJson(response, 200, { ok: true, entry: found.entry, url: `/__local_tiles/files/${id}/${entryRelative}`,
          candidateCount: found.candidateCount, topLevelCount: found.topLevelCount, aggregate: Boolean(found.aggregate) });
      }
      const match = url.pathname.match(/^\/__local_tiles\/files\/([^/]+)\/(.+)$/);
      const mount = match && mounts.get(match[1]);
      if (!match || !mount) throw new HttpBoundaryError(404, '目录挂载已失效，请重新加载');
      const path = decodedPath(match[2]);
      const rootNow = await realpath(mount.root), rootStat = await stat(rootNow);
      if (rootNow !== mount.root || rootStat.dev !== mount.device || rootStat.ino !== mount.inode)
        throw new HttpBoundaryError(404, '目录挂载已失效，请重新加载');
      if (match[2] === mount.entryRelative && mount.aggregate) {
        if (method === 'HEAD') {
          response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'private, no-store');
          response.setHeader('Vary', 'Cookie'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.end(); return;
        }
        return privateJson(response, 200, mount.aggregate);
      }
      const requested = resolve(mount.root, path);
      if (!inside(mount.root, requested)) throw new HttpBoundaryError(404, '文件不存在');
      const actual = await realpath(requested);
      if (!inside(mount.root, actual)) throw new HttpBoundaryError(404, '文件不存在');
      const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat(), verifiedPath = await realpath(requested), verified = await stat(verifiedPath), finalRoot = await stat(mount.root);
        // Verify the opened inode, not merely the pre-open pathname. A replaced
        // final symlink or parent directory cannot turn this descriptor into an escape.
        if (!info.isFile() || verifiedPath !== actual || !inside(mount.root, verifiedPath)
          || info.dev !== verified.dev || info.ino !== verified.ino || finalRoot.dev !== mount.device || finalRoot.ino !== mount.inode
          || await realpath(mount.root) !== mount.root)
          throw new HttpBoundaryError(404, '文件不存在');
        response.statusCode = 200;
        response.setHeader('Content-Type', fileType(actual)); response.setHeader('Content-Length', info.size);
        response.setHeader('Last-Modified', info.mtime.toUTCString()); response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('Vary', 'Cookie'); response.setHeader('X-Content-Type-Options', 'nosniff');
        if (method === 'HEAD') { response.end(); return; }
        await pipeline(handle.createReadStream({ autoClose: false }), response);
      } finally { await handle.close(); }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof HttpBoundaryError ? error.status
        : ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ? 404 : 500;
      privateJson(response, status, { ok: false, error: error instanceof HttpBoundaryError ? error.message : status === 404 ? '文件不存在' : '目录或文件读取失败' });
    }
  };
}
