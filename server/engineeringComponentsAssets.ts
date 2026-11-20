import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Plugin, ResolvedConfig } from 'vite';
import { managementActor } from './management/actorContext.ts';
import { assertSameOrigin, HttpBoundaryError, privateJson } from './httpBoundary.ts';

/** Audited delivery identities. SKP and source-editing files are never published. */
export const JIASHAN_ENGINEERING_HASHES = Object.freeze({
  catalog: '6a67f04afee76771071bea579cc097851ac7151c22f0854fbe98ba657b559443',
  fullModel: '0a767961b6ba11845ef1fd7c8e4932ee3e8c57d771f967d2736cca94d4f70eac',
  index: '1ae37fb9a85f42273bb2e82211550579450a7faffc49a61c6729b43454ffec49',
});
type Hashes = { catalog: string; fullModel: string; index: string };
export type EngineeringAssetsOptions = {
  directory?: string;
  base?: string;
  /** Explicit alternative delivery identity, primarily for synthetic tests. */
  expectedHashes?: Hashes;
};
type Root = { path: string; dev: number; ino: number };
type Unit = { id: string; count: number; sha256: string; path: string };
type Verified = { signature: string; sha256: string; bytes: number };
type Bundle = {
  catalog: Verified; fullModel: Verified; index: Verified;
  modelRevision: string; componentCount: number; referenceCount: number; groupCount: number;
  units: Unit[]; names: Map<string, string | undefined>; fingerprint: string;
};
const missing = '工程构件资源尚未连接，请配置原始重构模型包后重试。';
const invalid = '工程构件资源与已核验版本不一致，请检查原始模型包。';
const absent = '工程构件资源不存在或不可读取。';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const signature = (info: Stats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const within = (root: string, file: string) => {
  const part = relative(root, file);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};

/** Read-only source mount. No scanning, copying, conversion, database writes or public fallback. */
export function createEngineeringComponentsAssetsMiddleware(options: EngineeringAssetsOptions = {}) {
  const base = options.base && options.base !== './' ? new URL(options.base, 'http://localhost').pathname : '/';
  const prefix = `${base.endsWith('/') ? base : base + '/'}__engineering-components`;
  const directory = options.directory?.trim();
  const expected = options.expectedHashes ?? JIASHAN_ENGINEERING_HASHES;
  let mounted: Root | undefined;
  let bundle: Bundle | undefined;
  let pending: Promise<Bundle> | undefined;
  const verified = new Map<string, Verified>();

  async function root(): Promise<Root> {
    if (!directory || !isAbsolute(directory)) throw new HttpBoundaryError(422, missing);
    const path = await realpath(resolve(directory)), info = await stat(path);
    if (!info.isDirectory()) throw new HttpBoundaryError(404, missing);
    if (mounted && (path !== mounted.path || info.dev !== mounted.dev || info.ino !== mounted.ino))
      throw new HttpBoundaryError(404, absent);
    return mounted ??= { path, dev: info.dev, ino: info.ino };
  }

  async function openFile(name: string): Promise<{ handle: FileHandle; info: Stats }> {
    const mount = await root(), requested = join(mount.path, name), actual = await realpath(requested);
    if (!within(mount.path, actual)) throw new HttpBoundaryError(404, absent);
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat(), checkedPath = await realpath(requested), checked = await stat(checkedPath);
      const current = await root();
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || current.path !== mount.path
        || checkedPath !== actual || !within(mount.path, checkedPath) || checked.dev !== info.dev || checked.ino !== info.ino)
        throw new HttpBoundaryError(404, absent);
      return { handle, info };
    } catch (error) { await handle.close(); throw error; }
  }

  async function checkFile(name: string, handle: FileHandle, info: Stats, required?: string): Promise<Verified> {
    const key = signature(info), cached = verified.get(name);
    if (cached?.signature === key && (!required || cached.sha256 === required)) return cached;
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
    if (signature(await handle.stat()) !== key) throw new HttpBoundaryError(409, invalid);
    const hash = digest.digest('hex');
    if (required && hash !== required) throw new HttpBoundaryError(422, invalid);
    const result = { signature: key, sha256: hash, bytes: info.size };
    verified.set(name, result); return result;
  }

  async function readJson(name: string, limit: number, required?: string) {
    const { handle, info } = await openFile(name);
    try {
      if (info.size > limit) throw new HttpBoundaryError(422, invalid);
      // A bounded positional read cannot expand indefinitely if a source is replaced.
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== info.size || signature(await handle.stat()) !== signature(info)) throw new HttpBoundaryError(409, invalid);
      const content = bytes.subarray(0, length), hash = sha256(content);
      if (required && hash !== required) throw new HttpBoundaryError(422, invalid);
      const identity = { signature: signature(info), sha256: hash, bytes: length };
      let value: unknown;
      try { value = JSON.parse(content.toString('utf8')); } catch { throw new HttpBoundaryError(422, invalid); }
      verified.set(name, identity);
      return { value, identity };
    } finally { await handle.close(); }
  }

  async function loadBundle(): Promise<Bundle> {
    if (bundle) {
      // Recheck identity on every request; the large contents are hashed only on change.
      for (const [name, entry] of [['components.json', bundle.catalog], ['models/Jiashan.glb', bundle.fullModel], ['structure-library/index.json', bundle.index]] as const) {
        const { handle, info } = await openFile(name);
        try { if (signature(info) !== entry.signature) { bundle = undefined; break; } }
        finally { await handle.close(); }
      }
      if (bundle) return bundle;
    }
    const catalog = await readJson('components.json', 64 * 1024 * 1024, expected.catalog);
    const value = catalog.value as { schema?: unknown; modelRevision?: unknown; components?: unknown; referenceGeometry?: unknown; groups?: unknown } | null;
    if (value?.schema !== 'jiashan/component-library/2.0' || typeof value.modelRevision !== 'string'
      || !Array.isArray(value.components) || !Array.isArray(value.referenceGeometry) || !Array.isArray(value.groups))
      throw new HttpBoundaryError(422, invalid);
    const index = await readJson('structure-library/index.json', 1024 * 1024, expected.index);
    if (!index.value || typeof index.value !== 'object' || Array.isArray(index.value)) throw new HttpBoundaryError(422, invalid);
    const entries = Object.entries(index.value);
    if (!entries.length || entries.length > 4096) throw new HttpBoundaryError(422, invalid);
    const names = new Map<string, string | undefined>([
      ['components.json', expected.catalog], ['models/Jiashan.glb', expected.fullModel], ['structure-library/index.json', expected.index],
    ]);
    const units: Unit[] = entries.map(([id, raw]) => {
      const entry = raw as { path?: unknown; count?: unknown; sha256?: unknown } | null;
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !entry || typeof entry.path !== 'string'
        || !new RegExp(`^structure-library/(?:bridge|tunnel)/${id}$`).test(entry.path)
        || !Number.isSafeInteger(entry.count) || Number(entry.count) < 1
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new HttpBoundaryError(422, invalid);
      names.set(`${entry.path}/model.glb`, entry.sha256);
      names.set(`${entry.path}/structure.json`, undefined);
      return { id, path: entry.path, count: Number(entry.count), sha256: entry.sha256 };
    });
    const { handle, info } = await openFile('models/Jiashan.glb');
    let fullModel: Verified;
    try { fullModel = await checkFile('models/Jiashan.glb', handle, info, expected.fullModel); }
    finally { await handle.close(); }
    bundle = { catalog: catalog.identity, fullModel, index: index.identity, units, names,
      modelRevision: value.modelRevision, componentCount: value.components.length,
      referenceCount: value.referenceGeometry.length, groupCount: value.groups.length,
      fingerprint: sha256([catalog.identity.sha256, fullModel.sha256, index.identity.sha256].join('\n')) };
    return bundle;
  }
  const getBundle = () => pending ??= loadBundle().finally(() => { pending = undefined; });

  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const pathname = (request.url ?? '/').split('?')[0];
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) return next();
    try {
      assertSameOrigin(request);
      const actor = managementActor(request);
      if (!actor) throw new HttpBoundaryError(401, '请先登录');
      if (actor.taskIds !== undefined || !actor.permissions.includes('models')) throw new HttpBoundaryError(403, '当前账户没有完整工程模型权限');
      const method = request.method ?? 'GET';
      if (!['GET', 'HEAD'].includes(method)) {
        request.resume(); response.setHeader('Allow', 'GET, HEAD'); throw new HttpBoundaryError(405, '工程构件资源仅支持读取。');
      }
      let name: string;
      try { name = decodeURIComponent(pathname.slice(prefix.length + 1)); }
      catch { throw new HttpBoundaryError(400, '工程构件路径编码无效。'); }
      if (!name || !/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..'))
        throw new HttpBoundaryError(404, absent);
      const manifest = name === 'manifest' || name === 'manifest.json';
      if (!directory) {
        if (manifest) { privateJson(response, 200, method === 'HEAD' ? undefined : { schema: 'cesium/engineering-assets/1', available: false, message: missing }); return; }
        throw new HttpBoundaryError(404, missing);
      }
      const data = await getBundle();
      if (manifest) {
        const asset = (path: string, item: Verified) => ({ url: `${prefix}/${path}`, sha256: item.sha256, bytes: item.bytes });
        const payload = { schema: 'cesium/engineering-assets/1', available: true, modelRevision: data.modelRevision,
          fingerprint: data.fingerprint, assetFingerprint: data.fingerprint,
          componentCount: data.componentCount, referenceCount: data.referenceCount, groupCount: data.groupCount,
          componentsUrl: `${prefix}/components.json`, structuresUrl: `${prefix}/structure-library/index.json`,
          fullModelUrl: `${prefix}/models/Jiashan.glb`, fullModelSha256: data.fullModel.sha256,
          catalog: asset('components.json', data.catalog), fullModel: asset('models/Jiashan.glb', data.fullModel), index: asset('structure-library/index.json', data.index),
          units: data.units.map(unit => ({ id: unit.id, count: unit.count, sha256: unit.sha256,
            modelUrl: `${prefix}/${unit.path}/model.glb`, structureUrl: `${prefix}/${unit.path}/structure.json` })) };
        privateJson(response, 200, method === 'HEAD' ? undefined : payload); return;
      }
      if (!data.names.has(name)) throw new HttpBoundaryError(404, absent);
      let requiredHash = data.names.get(name);
      // Structure documents have no hash in the index; validate their public contract before publication.
      if (name.endsWith('/structure.json')) {
        const unit = data.units.find(entry => name === `${entry.path}/structure.json`)!;
        const parsed = await readJson(name, 2 * 1024 * 1024);
        const doc = parsed.value as { unitId?: unknown; model?: unknown; componentIds?: unknown } | null;
        if (doc?.unitId !== unit.id || doc.model !== 'model.glb' || !Array.isArray(doc.componentIds)
          || doc.componentIds.length !== unit.count || doc.componentIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.~-]+$/.test(id)))
          throw new HttpBoundaryError(422, invalid);
        requiredHash = parsed.identity.sha256;
      }
      const { handle, info } = await openFile(name);
      try {
        const identity = await checkFile(name, handle, info, requiredHash), etag = `"${identity.sha256}"`;
        response.setHeader('Cache-Control', 'private, no-cache'); response.setHeader('Vary', 'Cookie');
        response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Type', name.endsWith('.glb') ? 'model/gltf-binary' : 'application/json; charset=utf-8');
        response.setHeader('ETag', etag); response.setHeader('Last-Modified', info.mtime.toUTCString());
        if (request.headers['if-none-match']?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) {
          response.statusCode = 304; response.end(); return;
        }
        const ifRange = request.headers['if-range'];
        const range = !ifRange || ifRange === etag || ifRange === info.mtime.toUTCString() ? request.headers.range : undefined;
        let start = 0, end = info.size - 1;
        if (range !== undefined) {
          const match = range.length <= 128 && range.match(/^bytes=(\d*)-(\d*)$/);
          if (!match || (!match[1] && !match[2]) || info.size === 0) throw new HttpBoundaryError(416, '仅支持有效的单段字节范围。');
          if ([match[1], match[2]].some(value => value && !Number.isSafeInteger(Number(value))))
            throw new HttpBoundaryError(416, '字节范围数值无效。');
          if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, info.size - suffix); if (!Number.isSafeInteger(suffix) || suffix < 1) start = NaN; }
          else { start = Number(match[1]); if (match[2]) end = Math.min(info.size - 1, Number(match[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= info.size || end < start)
            throw new HttpBoundaryError(416, '字节范围超出资源。');
          response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        }
        response.setHeader('Content-Length', Math.max(0, end - start + 1));
        if (method === 'HEAD' || info.size === 0) { response.end(); return; }
        await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
      } catch (error) {
        if (error instanceof HttpBoundaryError && error.status === 416) response.setHeader('Content-Range', `bytes */${info.size}`);
        throw error;
      } finally { await handle.close(); }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.removeHeader('Content-Length'); response.removeHeader('ETag'); response.removeHeader('Last-Modified');
      const status = error instanceof HttpBoundaryError ? error.status
        : ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ? 404 : 500;
      privateJson(response, status, { ok: false, available: false,
        error: error instanceof HttpBoundaryError ? error.message : status === 404 ? absent : invalid });
    }
  };
}

export function engineeringComponentsAssetsPlugin(options: EngineeringAssetsOptions = {}): Plugin {
  let config: ResolvedConfig;
  const attach = (server: { middlewares: { use: (handler: ReturnType<typeof createEngineeringComponentsAssetsMiddleware>) => void } }) => {
    server.middlewares.use(createEngineeringComponentsAssetsMiddleware({ ...options,
      directory: options.directory ?? process.env.CESIUM_ENGINEERING_ASSETS_DIR, base: options.base ?? config.base }));
  };
  // Management's pre-plugin attaches the trusted actor before this ordinary plugin.
  return { name: 'engineering-components-private-assets', configResolved(value) { config = value; },
    configureServer: attach, configurePreviewServer: attach };
}
