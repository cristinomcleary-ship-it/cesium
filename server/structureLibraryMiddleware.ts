import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Plugin, ResolvedConfig } from 'vite';
import { assertSameOrigin, HttpBoundaryError, privateJson } from './httpBoundary.ts';
import { managementActor } from './management/actorContext.ts';
import type { Actor } from './management/domain.ts';
import { structurePreviewAuthorizer } from './management/structurePreviewContext.ts';

const libraryPrefix = '/__structure_library';
const previewPrefix = '/__structure_preview';
const structureKey = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const grantKey = /^[a-f0-9]{48}$/;
const grantLifetimeMs = 30 * 60_000;
const grantCapacity = 128;
const notFound = '本机结构库或所选结构资源不可用。';
const invalidPreview = '结构预览已失效，请从工程模型重新打开。';
const previewTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2', '.basis': 'application/octet-stream',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.vtt': 'text/vtt; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

type Directory = { path: string; dev: number; ino: number };
type PreviewGrant = {
  directory: Directory;
  actorId: string;
  expiresAt: number;
  authorize: () => Actor;
  host: string;
  address: string | undefined;
};
type MiddlewareOptions = {
  directory?: string;
  viteRoot?: string;
  servedDirectories?: string[];
  now?: () => number;
};

const within = (parent: string, file: string) => {
  const name = relative(parent, file);
  return !!name && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
};
const withinOrIs = (parent: string, file: string) => within(parent, file) || relative(parent, file) === '';
const canReadModels = (actor?: Actor): actor is Actor => !!actor && actor.taskIds === undefined && actor.permissions.includes('models');

function segments(path: string) {
  if (!path.startsWith('/') || path.length > 2048) throw new HttpBoundaryError(404, notFound);
  let values: string[];
  try { values = path.slice(1).split('/').map(decodeURIComponent); }
  catch { throw new HttpBoundaryError(400, '结构资源路径编码无效。'); }
  if (values.length > 24 || values.some(value => !value || value.length > 240 || value.startsWith('.') || /[ .]$/.test(value)
    || /[\x00-\x1f\x7f/\\:<>"|?*%]/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))) {
    throw new HttpBoundaryError(404, notFound);
  }
  return values;
}

async function directoryIdentity(path: string): Promise<Directory> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new HttpBoundaryError(404, notFound);
  return { path, dev: info.dev, ino: info.ino };
}

async function openAsset(directory: Directory, path: string) {
  const actual = await realpath(path);
  // Refuse links/junctions inside the mounted tree and check the file descriptor
  // against the post-open path and mount identity before serving its bytes.
  if (relative(actual, path) !== '' || !within(directory.path, actual) || !(await stat(actual)).isFile()) {
    throw new HttpBoundaryError(404, notFound);
  }
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const [info, checkedPath, currentDirectory] = await Promise.all([handle.stat(), realpath(path), directoryIdentity(directory.path)]);
    const checked = await stat(checkedPath);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || relative(checkedPath, actual) !== ''
      || !within(directory.path, checkedPath) || checked.dev !== info.dev || checked.ino !== info.ino
      || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino
      || relative(await realpath(directory.path), directory.path) !== '') {
      throw new HttpBoundaryError(404, notFound);
    }
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function byteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) return;
  let start = 0;
  let end = size - 1;
  if (match[1]) {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), end);
  } else if (match[2] && Number(match[2]) > 0) {
    start = Math.max(size - Number(match[2]), 0);
  } else return;
  if (Number.isSafeInteger(start) && start >= 0 && start <= end) return { start, end };
}

async function sendAsset(request: IncomingMessage, response: ServerResponse, directory: Directory, path: string, mime: string, limit?: number) {
  const { handle, info } = await openAsset(directory, path);
  try {
    if (limit !== undefined && info.size > limit) throw new HttpBoundaryError(422, '结构配置文件超过读取上限。');
    const requestedRange = request.method === 'GET' && !request.headers['if-range'] ? request.headers.range : undefined;
    const range = requestedRange ? byteRange(requestedRange, info.size) : undefined;
    if (requestedRange && !range) {
      response.setHeader('Content-Range', `bytes */${info.size}`);
      throw new HttpBoundaryError(416, '资源读取范围无效。');
    }
    response.statusCode = range ? 206 : 200;
    response.setHeader('Content-Type', mime);
    response.setHeader('Content-Length', range ? range.end - range.start + 1 : info.size);
    response.setHeader('Accept-Ranges', 'bytes');
    if (range) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    if (request.method === 'HEAD' || !info.size) response.end();
    else await pipeline(handle.createReadStream({ autoClose: false, start: range?.start ?? 0, end: range?.end ?? info.size - 1 }), response);
  } finally {
    await handle.close();
  }
}

function previewHost(request: IncomingMessage) {
  const host = request.headers.host;
  if (!host || !/^(?:[A-Za-z0-9.-]+|\[::1\])(?::\d{1,5})?$/.test(host)) throw new HttpBoundaryError(400, '结构预览访问地址无效。');
  return host.toLowerCase();
}

function previewPolicy(host: string, key: string) {
  // Bracketed IPv6 does not fit the CSP host-source grammar. For the local
  // IPv6 loopback, the origin sandbox and managed API checks still isolate it.
  const assets = host.startsWith('[') ? "'self'" : `${host}${previewPrefix}/${key}/`;
  return ["sandbox allow-scripts allow-downloads", "default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    `script-src ${assets} 'unsafe-inline' 'wasm-unsafe-eval' blob:`, `style-src ${assets} 'unsafe-inline'`,
    `img-src ${assets} data: blob:`, `font-src ${assets} data:`, `media-src ${assets} data: blob:`,
    `connect-src ${assets} data: blob:`, `worker-src ${assets} blob:`].join('; ');
}

/** Read-only mounted structure resources. Preview grants expire and are tied
 * to the same authenticated project session, host, and structure package. */
export function createStructureLibraryMiddleware(options: MiddlewareOptions) {
  const configured = options.directory?.trim();
  const now = options.now ?? Date.now;
  const grants = new Map<string, PreviewGrant>();

  function verifyPrivateDirectory(path: string, servedDirectories: string[]) {
    const { viteRoot } = options;
    const privateDirectory = viteRoot && ['project-data', 'private-assets'].some(name => within(join(viteRoot, name), path));
    if ((viteRoot && (withinOrIs(viteRoot, path) && !privateDirectory || withinOrIs(path, viteRoot)))
      || servedDirectories.some(root => withinOrIs(root, path) || withinOrIs(path, root))) {
      throw new HttpBoundaryError(422, '结构资源目录须位于项目私有数据目录或应用目录外。');
    }
  }

  async function mountedDirectory() {
    if (!configured) throw new HttpBoundaryError(404, notFound);
    if (!isAbsolute(configured)) throw new HttpBoundaryError(422, 'CESIUM_STRUCTURE_LIBRARY_DIR 须配置为绝对目录。');
    const servedDirectories = options.servedDirectories ?? [];
    verifyPrivateDirectory(resolve(configured), servedDirectories);
    const path = await realpath(configured);
    const canonicalServedDirectories = await Promise.all(servedDirectories.map(root => realpath(root).catch(() => root)));
    verifyPrivateDirectory(path, canonicalServedDirectories);
    return directoryIdentity(path);
  }

  async function issuePreview(request: IncomingMessage, response: ServerResponse, actor: Actor, directory: Directory, base: string) {
    const authorize = structurePreviewAuthorizer(request);
    if (!authorize || !canReadModels(actor)) throw new HttpBoundaryError(403, '当前账号没有结构预览权限。');
    const previewDirectory = await directoryIdentity(join(base, 'preview'));
    const { handle } = await openAsset(directory, join(previewDirectory.path, 'index.html'));
    await handle.close();
    const host = previewHost(request);
    const time = now();
    const expiresAt = Math.min(time + grantLifetimeMs, actor.expiresAt ? Date.parse(actor.expiresAt) : Infinity);
    if (!(expiresAt > time)) throw new HttpBoundaryError(403, invalidPreview);
    for (const [key, grant] of grants) if (grant.expiresAt <= time) grants.delete(key);
    if (grants.size >= grantCapacity) throw new HttpBoundaryError(503, '同时打开的结构预览过多，请稍后重试。');
    const key = randomBytes(24).toString('hex');
    grants.set(key, { directory: previewDirectory, actorId: actor.id, expiresAt, authorize, host, address: request.socket.remoteAddress });
    response.statusCode = 302;
    response.setHeader('Location', `${previewPrefix}/${key}/index.html`);
    response.end();
  }

  async function serveGrantedPreview(request: IncomingMessage, response: ServerResponse, parts: string[]) {
    const [key, ...asset] = parts;
    const grant = grantKey.test(key) ? grants.get(key) : undefined;
    if (!grant || grant.expiresAt <= now()) {
      grants.delete(key);
      throw new HttpBoundaryError(404, invalidPreview);
    }
    if (grant.host !== previewHost(request) || grant.address !== request.socket.remoteAddress) throw new HttpBoundaryError(403, invalidPreview);
    const origin = request.headers.origin;
    if (origin === 'null') {
      response.setHeader('Access-Control-Allow-Origin', 'null');
    } else if (origin) {
      assertSameOrigin(request);
    }
    // CSS, images and classic scripts can carry no Origin from an opaque
    // document. The capability and original session still authorize those reads.
    let actor: Actor | undefined;
    try { actor = grant.authorize(); } catch { /* revoked or expired */ }
    if (!canReadModels(actor) || actor.id !== grant.actorId) {
      grants.delete(key);
      throw new HttpBoundaryError(403, invalidPreview);
    }
    const file = asset.at(-1);
    const mime = file ? previewTypes[extname(file).toLowerCase()] : undefined;
    if (!mime) throw new HttpBoundaryError(404, notFound);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Content-Security-Policy', previewPolicy(grant.host, key));
    await sendAsset(request, response, grant.directory, join(grant.directory.path, ...asset), mime);
  }

  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = (request.url ?? '/').split('?', 1)[0];
    const library = path === libraryPrefix || path.startsWith(libraryPrefix + '/');
    const preview = path === previewPrefix || path.startsWith(previewPrefix + '/');
    if (!library && !preview) return next();
    try {
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        throw new HttpBoundaryError(405, '结构资源仅支持读取。');
      }
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const parts = segments(path.slice((library ? libraryPrefix : previewPrefix).length));
      if (preview) return await serveGrantedPreview(request, response, parts);
      assertSameOrigin(request);
      const actor = managementActor(request);
      if (!actor) throw new HttpBoundaryError(401, '请先登录。');
      if (!canReadModels(actor)) throw new HttpBoundaryError(403, '当前账号没有工程模型查看权限。');
      response.setHeader('Vary', 'Cookie');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      const directory = await mountedDirectory();
      if (parts.length === 1 && parts[0] === 'catalog.json') {
        return await sendAsset(request, response, directory, join(directory.path, 'catalog.json'), previewTypes['.json'], 1024 * 1024);
      }
      const [category, id, file] = parts;
      if (parts.length !== 3 || !structureKey.test(category) || !structureKey.test(id)) throw new HttpBoundaryError(404, notFound);
      const base = join(directory.path, category, id);
      if (file === 'preview') return await issuePreview(request, response, actor, directory, base);
      if (file === 'structure.json') return await sendAsset(request, response, directory, join(base, file), previewTypes['.json'], 64 * 1024);
      if (file === 'hologram.glb') return await sendAsset(request, response, directory, join(base, file), previewTypes['.glb']);
      throw new HttpBoundaryError(404, notFound);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.removeHeader('Content-Length');
      const status = error instanceof HttpBoundaryError ? error.status
        : ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ? 404 : 500;
      privateJson(response, status, { ok: false, error: error instanceof HttpBoundaryError ? error.message : status === 404 ? notFound : '结构资源读取失败。' });
    }
  };
}

export function structureLibraryPlugin(): Plugin {
  let config: ResolvedConfig;
  const attach = (server: { middlewares: { use: (handler: ReturnType<typeof createStructureLibraryMiddleware>) => void } }) => {
    server.middlewares.use(createStructureLibraryMiddleware({
      directory: process.env.CESIUM_STRUCTURE_LIBRARY_DIR,
      viteRoot: config.root,
      servedDirectories: [config.publicDir, resolve(config.root, config.build.outDir)].filter(Boolean),
    }));
  };
  return { name: 'cesium-private-structure-library', configResolved(value) { config = value; }, configureServer: attach, configurePreviewServer: attach };
}
