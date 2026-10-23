import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSketchupSdk } from './sketchup-sdk-runtime.mjs';
import { loadSketchupApi } from './sketchup/sdk-api.mjs';
import { convertSketchup } from './sketchup/convert.mjs';

async function main() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const sdkIndex = args.indexOf('--sdk');
  const sdkDirectory = sdkIndex >= 0 ? args[sdkIndex + 1] : undefined;
  if (sdkIndex >= 0) args.splice(sdkIndex, 2);
  const sdk = findSketchupSdk(projectRoot, { sdkDirectory });
  if (!sdk.available) throw new Error(`${sdk.reason}。${sdk.details.join('；')}`);
  const api = await loadSketchupApi(sdk.library);
  if (args.length === 1 && args[0] === '--check') {
    api.initialize(); api.terminate();
    process.stdout.write('SKP 后台组件加载成功，不需要启动 SketchUp。\n'); return;
  }
  if (args.length !== 2) throw new Error('用法：node tools/sketchup-headless.mjs 输入.skp 输出.glb [--sdk CSDK目录]');
  const input = resolve(args[0]); const output = resolve(args[1]);
  if (input === output || extname(input).toLowerCase() !== '.skp' || extname(output).toLowerCase() !== '.glb') throw new Error('输入必须是 SKP，输出必须是不同路径的 GLB');
  if (!statSync(input).isFile() || statSync(input).size === 0) throw new Error('输入 SKP 文件不存在或为空');
  const scratch = mkdtempSync(join(dirname(output), '.skp-export-'));
  try {
    const result = convertSketchup(api, input, scratch, basename(input, extname(input)));
    const pending = join(scratch, 'model.glb'); writeFileSync(pending, result.bytes);
    // No success marker or output is published until the complete binary exists.
    const header = readFileSync(pending).subarray(0, 12);
    if (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(8) !== statSync(pending).size) throw new Error('GLB 写入完整性校验失败');
    renameSync(pending, output);
    writeFileSync(`${output}.conversion.json`, JSON.stringify({ ...result.metadata, warnings: result.warnings }, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, ...result.metadata, warnings: result.warnings }) + '\n');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
