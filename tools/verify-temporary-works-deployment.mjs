// Read-only deployment verification. Never copies or rewrites a private model.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from './install-temporary-works-assets.mjs';

const manifestLimit = 8 * 1024 * 1024;
const prefix = 'models/temporary-works/';
const failure = message => new Error(message);

async function digest(stream, limit, collect = false) {
  const hash = createHash('sha256'), chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw failure('资源长度超出清单声明或清单大小上限。');
    hash.update(chunk);
    if (collect) chunks.push(Buffer.from(chunk));
  }
  return { bytes, sha256: hash.digest('hex'), ...(collect ? { content: Buffer.concat(chunks) } : {}) };
}

async function localFile(directory, filename, limit, collect = false) {
  let handle;
  try {
    const path = join(directory, filename);
    if ((await lstat(path)).isSymbolicLink()) throw failure('临建资源不能是符号链接。');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw failure('临建资源文件缺失、为空或大小不符合清单。');
    return await digest(handle.createReadStream({ autoClose: false }), limit, collect);
  } catch {
    // OS errors contain local absolute paths. Keep deployment logs free of them.
    throw failure('本机临建资源读取或大小校验失败；请检查所指定的完整原资源包。');
  } finally { await handle?.close(); }
}

async function httpFile(url, kind, limit, timeoutMs, collect = false) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', redirect: 'error',
      headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) throw failure(`资源服务返回 HTTP ${response.status}，部署核验失败。`);
    const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const validMime = kind === 'json' ? /^application\/(?:[a-z0-9.+-]+\+)?json$/.test(mime)
      : kind === 'glb' ? ['model/gltf-binary', 'application/octet-stream'].includes(mime)
      : ['image/png', 'application/octet-stream'].includes(mime);
    if (!validMime) throw failure(mime === 'text/html'
      ? '临建资源请求返回 HTML 网页，原资源包尚未正确接入当前服务。'
      : '临建资源响应 MIME 类型不正确。');
    if (!response.body) throw failure('临建资源响应为空。');
    const result = await digest(response.body, limit, collect);
    if (!result.bytes) throw failure('临建资源响应为空。');
    return result;
  } catch (error) {
    if (error instanceof Error && /^(资源|临建)/.test(error.message)) throw error;
    throw failure('临建资源 HTTP 读取失败或超时，请确认目标服务和端口。');
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

/** The original package is read sequentially; only the small manifest is buffered. */
export async function verifyTemporaryWorksDeployment({ origin, directory, timeoutMs = 120_000 }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw failure('请提供原临建资源包的绝对目录。');
  let base;
  try { base = new URL(origin); } catch { throw failure('请提供有效的 HTTP(S) 服务地址。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw failure('服务地址须为不含凭据、查询和片段的 HTTP(S) 地址。');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('invalid directory');
  } catch { throw failure('原临建资源包目录不存在或不是普通目录。'); }
  const localManifest = await localFile(directory, 'manifest.json', manifestLimit, true);
  let metadata;
  try { metadata = validateManifest(JSON.parse(localManifest.content.toString('utf8'))); }
  catch { throw failure('原临建资源清单不是有效的已核验模型包清单。'); }
  const remoteManifest = await httpFile(new URL(`${prefix}manifest.json`, base), 'json', manifestLimit, timeoutMs, true);
  try { JSON.parse(remoteManifest.content.toString('utf8')); }
  catch { throw failure('临建资源服务未返回有效 JSON 清单。'); }
  if (remoteManifest.bytes !== localManifest.bytes || remoteManifest.sha256 !== localManifest.sha256)
    throw failure('服务中的临建清单与原资源包不一致。');
  let bytes = localManifest.bytes;
  for (const { filename, entry, kind } of metadata) {
    const local = await localFile(directory, filename, entry.bytes);
    if (local.bytes !== entry.bytes || local.sha256 !== entry.sha256)
      throw failure('原临建资源文件与清单的字节数或 SHA-256 不一致。');
    const remote = await httpFile(new URL(`${prefix}${filename}`, base), kind, entry.bytes, timeoutMs);
    if (remote.bytes !== entry.bytes || remote.sha256 !== entry.sha256)
      throw failure('服务中的临建资源与原资源包的字节数或 SHA-256 不一致。');
    bytes += remote.bytes;
  }
  return { ok: true, assets: 3, files: metadata.length + 1, bytes, readOnly: true };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--origin', '--directory'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw failure('用法：node tools/verify-temporary-works-deployment.mjs --origin URL --directory 原包绝对目录');
    options[args[i].slice(2)] = args[++i];
  }
  console.log(JSON.stringify(await verifyTemporaryWorksDeployment(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
