import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const requestPath = process.argv[2];
if (!requestPath) throw new Error('Usage: node tools/ar-v2-render.mjs requests.json');
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch {
  if (!request.playwright_module) throw new Error('Set runtime.playwright_module or install playwright');
  playwright = require(request.playwright_module);
}
const root = path.resolve(request.project_root);
const output = path.resolve(request.output_dir);
function outputFile(relative) {
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep)) throw new Error('Output path escapes artifact directory');
  fs.mkdirSync(path.dirname(target), { recursive: true }); return target;
}
function json(relative, value) { fs.writeFileSync(outputFile(relative), JSON.stringify(value, null, 2) + '\n'); }
const server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: request.port ?? 5198, strictPort: true, hmr: false, watch: null, fs: { allow: [root, output] } }, logLevel: 'warn' });
let browser;
try {
  await server.listen();
  browser = await playwright.chromium.launch({ executablePath: request.browser_executable, headless: true, args: ['--disable-background-timer-throttling'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()); });
  page.on('pageerror', error => console.error(error));
  await page.goto(`http://127.0.0.1:${request.port ?? 5198}/ar_v2/reference.html`);
  await page.waitForFunction(() => window.arV2Reference, { timeout: 60000 });
  const probe = await page.evaluate(() => window.arV2Reference.probe());
  json('environment/webgl-probe.json', probe); console.log('PROBE ' + JSON.stringify(probe));
  const regression = await page.evaluate(() => window.arV2Reference.regression());
  json('environment/renderer-regression.json', regression); console.log('REGRESSION ' + JSON.stringify(regression));
  if (regression.status !== 'PASSED') throw new Error('Renderer regression failed');
  if (!request.references?.length) process.exitCode = 0;
  else {
    const sceneUrl = `http://127.0.0.1:${request.port ?? 5198}/@fs/${path.join(output, 'scene/scene_manifest.json').replaceAll('\\', '/')}`;
    const loaded = await page.evaluate(url => window.arV2Reference.init(url), sceneUrl);
    console.log('SCENE ' + JSON.stringify(loaded));
    const manifestPath = outputFile('references/manifest.jsonl');
    const partialPath = manifestPath + '.partial'; fs.writeFileSync(partialPath, '');
    for (let index = 0; index < request.references.length; index++) {
      const spec = request.references[index];
      const data = await page.evaluate(spec => window.arV2Reference.render(spec), spec);
      const prefix = `references/${spec.id}`;
      const record = { ...spec, geometry_version: loaded.geometry_version, rgb: `${prefix}.png`, depth_z: `${prefix}.depth.f32`, triangle_id: `${prefix}.triangle.u32`, valid_mask: `${prefix}.mask.u8` };
      for (const [key, field] of [['rgb', 'rgb'], ['depth', 'depth_z'], ['ids', 'triangle_id'], ['mask', 'valid_mask']]) fs.writeFileSync(outputFile(record[field]), Buffer.from(data[key], 'base64'));
      fs.appendFileSync(partialPath, JSON.stringify(record) + '\n');
      if (request.job_status_path && fs.existsSync(request.job_status_path)) {
        const status = JSON.parse(fs.readFileSync(request.job_status_path, 'utf8'));
        status.phase = 'render-references'; status.progress = { kind: 'references', completed: index + 1, total: request.references.length };
        fs.writeFileSync(request.job_status_path + '.tmp', JSON.stringify(status)); fs.renameSync(request.job_status_path + '.tmp', request.job_status_path);
      }
      console.log(`REFERENCE ${index + 1}/${request.references.length} ${spec.id}`);
    }
    fs.renameSync(partialPath, manifestPath);
    json('references/render-report.json', { status: 'COMPLETED', ...loaded, references: request.references.length, probe });
  }
} finally { await browser?.close(); await server.close(); }
