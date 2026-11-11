// Selected local runtime. Keep the existing build, data workspace and port 5289.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const runRoot = launcherRoot;
const projectRoot = path.resolve(runRoot, '..', '..');
const deployedSource = path.join(runRoot, 'releases', 'model-ar-84300b4');
const variants = {
  baseline: { source: deployedSource, build: path.join(deployedSource, 'dist') },
  candidate: { source: deployedSource, build: path.join(deployedSource, 'dist') },
};
if (process.argv.includes('--help')) {
  console.log('Usage: node scene-acceptance-server.mjs --variant baseline|candidate [--check]\n'
    + 'Prepare the independent data copy with prepare-scene-sandbox.py first.\n'
    + 'Server binds only 127.0.0.1:5289 and keeps all writes under scene-sandbox.\n'
    + '--check validates paths and exits without loading Vite or opening a port.\n'
    + 'Baseline and candidate use the same copied dataset/origin sequentially.');
  process.exit(0);
}
const variantIndex = process.argv.indexOf('--variant');
const variant = process.argv[variantIndex + 1];
if (variantIndex < 0 || !Object.hasOwn(variants, variant)) throw new Error('Explicit baseline or candidate variant required');
if (variant !== 'candidate') throw new Error('Desktop entry requires the candidate variant');
const selection = variants[variant];
const sandbox = path.join(runRoot, 'workspace');
const dataRoot = path.join(sandbox, 'project-data');
const within = (parent, target) => {
  const relative = path.relative(parent, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
if (!within(fs.realpathSync(runRoot), fs.realpathSync(dataRoot))) throw new Error('Data copy is not inside this run');
const preparation = JSON.parse(fs.readFileSync(path.join(runRoot, 'data-preparation.json'), 'utf8'));
if (preparation.dataRoot !== dataRoot || preparation.sqliteIntegrity !== 'ok' || preparation.copiesAreIndependent !== true) {
  throw new Error('Independent, consistent data preparation evidence required');
}
for (const required of [path.join(dataRoot, 'management.sqlite'), path.join(selection.source, 'vite.config.ts'), path.join(selection.build, 'index.html')]) {
  if (!fs.statSync(required).isFile()) throw new Error(`Required file missing: ${required}`);
}
for (const key of ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR']) process.env[key] = dataRoot;
// Converter tools/configuration use the source installation; caches keep the existing cwd.
process.env.CESIUM_MODEL_CONVERTER_ROOT = projectRoot;
delete process.env.CESIUM_ACCEPTANCE_READONLY_LIBRARY;
const indexPath = path.join(selection.build, 'index.html');
const identity = {
  acceptanceOnly: true, variant, pid: process.pid, source: selection.source,
  sourceCommit: execFileSync(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe'), ['-C', selection.source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  build: selection.build, indexSha256: createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex'),
  dataRoot, url: 'http://127.0.0.1:5289/', authPreservedFromBackup: true,
  modelConverterRoot: process.env.CESIUM_MODEL_CONVERTER_ROOT,
  sketchupSdkEnvironment: process.env.CESIUM_SKETCHUP_SDK_DIR ?? null,
};
if (identity.sourceCommit !== '84300b4dedccc3f0116f03332c3ada914da95485' || identity.indexSha256 !== '53a2d2f0eaa1249c473416f7e699466eca31210cfb031cddfa605e88e7b170d7') throw new Error('Candidate identity mismatch');
if (process.argv.includes('--check')) { console.log(JSON.stringify(identity, null, 2)); process.exit(0); }

// All Vite configuration side effects and model/imagery/diagnostic caches use this cwd.
process.chdir(sandbox);
const vitePath = path.join(selection.source, 'node_modules/vite/dist/node/index.js');
const { loadConfigFromFile, preview } = await import(pathToFileURL(vitePath).href);
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'production', isPreview: true }, path.join(selection.source, 'vite.config.ts'), selection.source);
if (!loaded) throw new Error('Could not load the selected original Vite configuration');
const guard = {
  name: 'private-acceptance-copy-guard', enforce: 'pre',
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const host = request.headers.host;
      if (host !== '127.0.0.1:5289' && host !== 'localhost:5289') {
        response.statusCode = 403; response.end('Local acceptance origin required'); return;
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1:5289');
      if (url.pathname === '/__acceptance/identity' && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(identity)); return;
      }
      // Imports use the original middleware's headless-only validation.
      next();
    });
  },
};
const server = await preview({
  ...loaded.config, configFile: false, root: sandbox, envFile: false,
  plugins: [guard, ...(loaded.config.plugins || [])],
  build: { ...loaded.config.build, outDir: selection.build, emptyOutDir: false },
  preview: { ...loaded.config.preview, host: '127.0.0.1', port: 5289, strictPort: true, open: false, cors: false },
});
fs.writeFileSync(path.join(launcherRoot, 'server-identity.json'), JSON.stringify({ ...identity, startedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify(identity));
let closing = false;
const close = async () => { if (closing) return; closing = true; await server.close(); process.exit(0); };
process.once('SIGINT', close); process.once('SIGTERM', close);
