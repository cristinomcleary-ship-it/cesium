#!/usr/bin/env node
// Read-only loopback preview. It never proxies requests to the running platform.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { syntheticGround, syntheticMaterials, syntheticTileset } from './fixtures.mjs';

export const previewRoot = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(previewRoot, '../..');
export const assetNames = Object.freeze(['manifest.json', 'camp.glb', 'steel.glb', 'wall.glb', 'cr24-logo.png']);
const assetPrefix = '/models/temporary-works/';

export function parseOptions(argv, cwd = process.cwd()) {
  const options = { host: '127.0.0.1', port: 5288, assets: path.join(repositoryRoot, 'public/models/temporary-works'), explicitAssets: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { options.help = true; continue; }
    if (!['--port', '--assets'].includes(key)) throw new Error(`未知参数 ${key}。使用 --help 查看说明。`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少参数。`);
    if (key === '--assets') { options.assets = path.resolve(cwd, value); options.explicitAssets = true; }
    else {
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535 || Number(value) === 5173)
        throw new Error('验证端口须为 1024–65535，且不能使用正式平台端口 5173。');
      options.port = Number(value);
    }
  }
  return options;
}

export function assetNameForRequest(rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent((rawUrl ?? '').split('?')[0]); } catch { return undefined; }
  if (!pathname.startsWith(assetPrefix)) return undefined;
  const name = pathname.slice(assetPrefix.length);
  return assetNames.includes(name) ? name : undefined;
}

/** Only the five runtime files may be read, including when a directory contains symlinks. */
export async function resolveAssetFile(directory, name) {
  if (!assetNames.includes(name)) throw Object.assign(new Error('不允许读取此资源。'), { code: 'EACCES' });
  const root = await fs.promises.realpath(directory);
  const target = await fs.promises.realpath(path.join(root, name));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    throw Object.assign(new Error('资源链接不能指向资源目录之外。'), { code: 'EACCES' });
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw Object.assign(new Error('资源不是普通文件。'), { code: 'EACCES' });
  return { path: target, size: stat.size };
}

export function requestPolicy(method, url) {
  if (!['GET', 'HEAD'].includes(method ?? '')) return 405;
  if (/^\/(?:api|__management|__library|__safety)(?:\/|\?|$)/i.test(url ?? '')) return 404;
  return 0;
}

function dependencyDirectories() {
  const require = createRequire(import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const result = new Set([fs.realpathSync(path.join(repositoryRoot, 'node_modules'))]);
  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    // Some development environments link individual packages across worktrees.
    // Allow their actual package directory, never the surrounding repository.
    let directory = path.dirname(fs.realpathSync(require.resolve(name)));
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) { result.add(directory); break; }
      directory = path.dirname(directory);
    }
  }
  return [...result];
}

export async function previewViteConfig(options) {
  const C = await import('cesium');
  const { viteStaticCopy } = await import('vite-plugin-static-copy');
  const fixtures = new Map([
    ['/fixtures/tileset.json', syntheticTileset(C)], ['/fixtures/ground.gltf', syntheticGround()],
    ['/fixtures/materials.gltf', syntheticMaterials()],
  ]);
  return {
    configFile: false, root: previewRoot, publicDir: false,
    cacheDir: path.join(previewRoot, 'node_modules/.vite'),
    define: { CESIUM_BASE_URL: JSON.stringify('/cesiumStatic') },
    optimizeDeps: { entries: [path.join(previewRoot, 'app.ts')], include: ['cesium'] },
    server: {
      host: '127.0.0.1', middlewareMode: true, hmr: false, cors: false,
      fs: { strict: true, allow: [previewRoot, path.join(repositoryRoot, 'src'), ...dependencyDirectories()] },
    },
    plugins: [
      { name: 'read-only-local-validation', configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const status = requestPolicy(req.method, req.url);
          if (status) { res.statusCode = status; res.end(status === 405 ? 'Read-only validation host' : 'Production API unavailable'); return; }
          const url = req.url?.split('?')[0];
          if (fixtures.has(url)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify(fixtures.get(url))); return;
          }
          if (!url?.startsWith(assetPrefix)) { next(); return; }
          const name = assetNameForRequest(req.url);
          if (!name) { res.statusCode = 403; res.end('Asset not allowed'); return; }
          void resolveAssetFile(options.assets, name).then(file => {
            res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Length', file.size);
            res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : name.endsWith('.png') ? 'image/png' : 'model/gltf-binary');
            if (req.method === 'HEAD') { res.end(); return; }
            const stream = fs.createReadStream(file.path);
            stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
          }, error => { res.statusCode = error.code === 'EACCES' ? 403 : 404; res.end('Private runtime asset unavailable; use --assets with an existing runtime directory.'); });
        });
      } },
      viteStaticCopy({ targets: ['Workers', 'Assets', 'ThirdParty', 'Widgets'].map(name => ({
        src: path.join(repositoryRoot, 'node_modules/cesium/Build/Cesium', name).replaceAll('\\', '/'), dest: 'cesiumStatic',
      })) }),
    ],
  };
}

export async function startPreview(options) {
  if (options.host !== '127.0.0.1') throw new Error('验证页只允许绑定 127.0.0.1。');
  if (options.explicitAssets && !fs.statSync(options.assets).isDirectory()) throw new Error('--assets 必须指向已有运行资源目录。');
  const { createServer } = await import('vite');
  const vite = await createServer(await previewViteConfig(options));
  const server = createHttpServer(vite.middlewares);
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); }); }
  catch (error) { await vite.close(); throw error; }
  let closing;
  const close = () => closing ??= (async () => {
    const closeHttp = new Promise(resolve => server.close(resolve));
    // Shutdown belongs to this isolated host only. Do not leave keep-alive
    // requests or the dependency optimizer waiting on one another.
    server.closeAllConnections();
    await Promise.all([closeHttp, vite.close()]);
  })();
  return { server, vite, close };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(`Usage: node tools/designed-surfaces-preview/server.mjs [--port 5288] [--assets "existing runtime directory"]

仅供本机隔离验证：固定监听 127.0.0.1；无生产 API、无业务文件写入。
方案只存页面内存，刷新清空。亮度偏好仅存此独立端口的本地浏览器。
默认只读 public/models/temporary-works 下五个运行文件；缺失时仍可验证合成场景。
--assets 指向已经安装的私有运行资源目录，绝不指向源模型目录或压缩包。
页面的地面为合成 3D Tiles，不能代替真实摄影、现场尺寸或性能验收。
关闭终端或按 Ctrl+C 退出；不要改用正式服务端口 5173。`);
    return;
  }
  const running = await startPreview(options);
  console.log(`隔离验证页 http://${options.host}:${options.port}/ （合成地面，非真实摄影验收）`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  return running;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
