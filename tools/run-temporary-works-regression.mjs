// Repeatable Node regression suites. Does not connect to production services.
// node tools/run-temporary-works-regression.mjs [related|all] [--root PATH] [--output PATH]
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';

const args = process.argv.slice(2);
const suite = args[0] && !args[0].startsWith('--') ? args.shift() : 'all';
if (!['related', 'all'].includes(suite)) throw new Error('Suite must be related or all.');
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[i + 1];
}
const root = resolve(option('--root', process.cwd()));
const output = resolve(option('--output', join(root, 'output/temporary-works-regression')));
await mkdir(output, { recursive: true });
async function collect(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : /\.test\.(ts|mjs)$/.test(entry.name) ? [relative(root, path).replaceAll('\\', '/')] : [];
  }))).flat();
}
let files = (await Promise.all(['src', 'server', 'tests'].map(name => collect(join(root, name))))).flat().sort();
if (suite === 'related') files = files.filter(file => /^src\/(temporaryWorks|cad|sceneDisplay).*\.test\.ts$/.test(file) || file === 'src/dxfLoader.test.ts');
if (!files.length) throw new Error('No matching tests.');
const command = ['--experimental-transform-types', '--import', './tools/test-module-loader.mjs', '--test', '--test-reporter=tap', '--test-concurrency=4', ...files];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const startedAt = new Date().toISOString();
const logPath = join(output, `${suite}.tap`);
const log = createWriteStream(logPath);
let captured = '';
const child = spawn(process.execPath, command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { captured += data; log.write(data); process.stdout.write(data); });
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)); });
await new Promise(resolve => log.end(resolve));
const summary = {};
for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
  const value = captured.match(new RegExp(`^# ${key} ([\\d.]+)$`, 'm'))?.[1];
  summary[key] = value === undefined ? null : Number(value);
}
const manifest = {
  suite, startedAt, finishedAt: new Date().toISOString(), node: process.version,
  commit: git('rev-parse', 'HEAD'), sourceStatus: git('status', '--porcelain'),
  command: [process.execPath, ...command], exitCode, summary,
  files: files.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') })),
  log: logPath,
};
await writeFile(join(output, `${suite}.json`), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ suite, exitCode, ...summary }));
process.exitCode = exitCode;
