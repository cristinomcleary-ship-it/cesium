import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Plugin, ResolvedConfig } from 'vite';
import { HttpBoundaryError, privateJson } from './httpBoundary.ts';

const assetPath = 'models/temporary-works/';
const manifestLimit = 8 * 1024 * 1024;
const unavailable = '临建资源未连接或文件缺失，请核验原临建资源包及 CESIUM_TEMPORARY_WORKS_ASSETS_DIR 配置；请勿删除原方案或资料。';
const invalid = '临建资源包读取失败，请使用临建资源校验命令检查原资源包；请勿删除原方案或资料。';
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
type MiddlewareOptions = {
  /** Existing public/dist location when no explicit read-only mount was selected. */
  staticDirectory: string;
  directory?: string;
  base?: string;
};
type Root = { path: string; dev: number; ino: number };
type Manifest = { fingerprint: string; bytes: Buffer; names: Set<string> };

/** Serves the original private bundle without copying it into a new checkout.
 * No directory discovery, writes, model conversion, or saved-plan migration. */
export function createTemporaryWorksAssetsMiddleware(options: MiddlewareOptions) {
  const base = options.base && options.base !== './' ? new URL(options.base, 'http://localhost').pathname : '/';
  const prefix = `${base.endsWith('/') ? base : base + '/'}${assetPath}`;
  const configured = options.directory?.trim();
  let rootPromise: Promise<Root> | undefined;
  let manifest: Manifest | undefined;
  let manifestLoad: Promise<Manifest> | undefined;

  const root = () => rootPromise ??= (async () => {
    if (!isAbsolute(configured!)) throw new HttpBoundaryError(422, '请将 CESIUM_TEMPORARY_WORKS_ASSETS_DIR 设置为原临建资源包的绝对目录。');
    const path = await realpath(resolve(configured!)), info = await stat(path);
    if (!info.isDirectory()) throw new HttpBoundaryError(404, unavailable);
    return { path, dev: info.dev, ino: info.ino };
  })().catch(error => { rootPromise = undefined; throw error; });

  async function openFile(name: string): Promise<{ handle: FileHandle; info: Stats }> {
    const mounted = await root(), requested = join(mounted.path, name);
    const actual = await realpath(requested);
    if (!within(mounted.path, actual)) throw new HttpBoundaryError(404, unavailable);
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat(), checkedPath = await realpath(requested), checked = await stat(checkedPath);
      const currentRoot = await stat(mounted.path);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || checkedPath !== actual || !within(mounted.path, checkedPath)
        || checked.dev !== info.dev || checked.ino !== info.ino
        || currentRoot.dev !== mounted.dev || currentRoot.ino !== mounted.ino
        || await realpath(mounted.path) !== mounted.path) throw new HttpBoundaryError(404, unavailable);
      return { handle, info };
    } catch (error) { await handle.close(); throw error; }
  }

  async function readManifest(): Promise<Manifest> {
    const { handle, info } = await openFile('manifest.json');
    try {
      const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (manifest?.fingerprint === fingerprint) return manifest;
      if (info.size > manifestLimit) throw new HttpBoundaryError(422, invalid);
      // Bound the actual read as well as its initial stat if the file grows.
      const buffer = Buffer.alloc(Number(info.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      const final = await handle.stat();
      if (length !== Number(info.size) || final.size !== info.size || final.mtimeMs !== info.mtimeMs)
        throw new HttpBoundaryError(422, invalid);
      const bytes = buffer.subarray(0, length);
      let document: { schemaVersion?: unknown; assets?: unknown; logo?: unknown };
      try { document = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpBoundaryError(422, invalid); }
      if (!document || document.schemaVersion !== 1 || !Array.isArray(document.assets) || document.assets.length > 64)
        throw new HttpBoundaryError(422, invalid);
      const names = new Set<string>(['manifest.json']);
      const add = (entry: unknown, extensions: string[]) => {
        const url = entry && typeof entry === 'object' ? (entry as { url?: unknown }).url : undefined;
        if (typeof url !== 'string') throw new HttpBoundaryError(422, invalid);
        const name = url.startsWith(assetPath) ? url.slice(assetPath.length)
          : url.startsWith('/' + assetPath) ? url.slice(assetPath.length + 1) : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || !extensions.some(extension => name.endsWith(extension)))
          throw new HttpBoundaryError(422, invalid);
        names.add(name);
      };
      for (const entry of document.assets) add(entry, ['.glb']);
      if (document.logo !== undefined) add(document.logo, ['.png', '.jpg', '.jpeg']);
      // Integrity/geometry validation stays in the existing read-only deployment
      // checker. Runtime does not rehash or buffer large GLBs per request.
      manifest = { fingerprint, bytes, names };
      return manifest;
    } finally { await handle.close(); }
  }
  const loadManifest = () => manifestLoad ??= readManifest().finally(() => { manifestLoad = undefined; });

  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const pathname = (request.url ?? '/').split('?')[0];
    if (!pathname.startsWith(prefix)) return next();
    try {
      let name: string;
      try { name = decodeURIComponent(pathname.slice(prefix.length)); }
      catch { throw new HttpBoundaryError(400, '临建资源路径编码无效。'); }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new HttpBoundaryError(404, unavailable);
      const method = request.method ?? 'GET';
      if (!['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', 'GET, HEAD'); throw new HttpBoundaryError(405, '临建资源仅支持读取。');
      }
      if (!configured) {
        // Preserve Vite's existing serving/cache behavior for installed packages.
        // Only intercept absent files, which would otherwise become SPA HTML.
        if (!(await stat(join(options.staticDirectory, name))).isFile()) throw new HttpBoundaryError(404, unavailable);
        return next();
      }
      const bundle = await loadManifest();
      if (!bundle.names.has(name)) throw new HttpBoundaryError(404, unavailable);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (name === 'manifest.json') {
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Content-Length', bundle.bytes.length);
        response.end(method === 'HEAD' ? undefined : bundle.bytes); return;
      }
      const { handle, info } = await openFile(name);
      try {
        const etag = `W/"${createHash('sha256').update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`).digest('hex')}"`;
        response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        response.setHeader('ETag', etag);
        response.setHeader('Content-Type', name.endsWith('.glb') ? 'model/gltf-binary' : name.endsWith('.png') ? 'image/png' : 'image/jpeg');
        response.setHeader('Last-Modified', info.mtime.toUTCString());
        if (request.headers['if-none-match']?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
          response.statusCode = 304; response.end(); return;
        }
        response.setHeader('Content-Length', info.size);
        if (method === 'HEAD') { response.end(); return; }
        await pipeline(handle.createReadStream({ autoClose: false }), response);
      } finally { await handle.close(); }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.removeHeader('Content-Length'); response.removeHeader('ETag'); response.removeHeader('Last-Modified');
      const status = error instanceof HttpBoundaryError ? error.status
        : ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ? 404 : 500;
      privateJson(response, status, { ok: false, error: error instanceof HttpBoundaryError ? error.message : status === 404 ? unavailable : invalid });
    }
  };
}

export function temporaryWorksAssetsPlugin(): Plugin {
  let config: ResolvedConfig;
  const attach = (server: { middlewares: { use: (handler: ReturnType<typeof createTemporaryWorksAssetsMiddleware>) => void } }, preview: boolean) => {
    server.middlewares.use(createTemporaryWorksAssetsMiddleware({
      directory: process.env.CESIUM_TEMPORARY_WORKS_ASSETS_DIR,
      staticDirectory: join(preview ? resolve(config.root, config.build.outDir) : config.publicDir, assetPath),
      base: config.base,
    }));
  };
  return {
    name: 'temporary-works-private-assets',
    configResolved(value) { config = value; },
    configureServer(server) { attach(server, false); },
    configurePreviewServer(server) { attach(server, true); },
  };
}
