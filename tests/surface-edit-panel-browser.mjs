/** Isolated DOM acceptance for the surface-edit panel. No scene or project data is loaded. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright'));
const output = resolve(process.env.SURFACE_EDIT_PANEL_BROWSER_OUT || 'output/surface-edit-panel-browser');
await mkdir(output, { recursive: true });
const report = { classification: 'isolated-presentational-panel', status: 'running', checks: [], pageErrors: [] };
const bundle = await build({ bundle: true, format: 'esm', write: false, loader: { '.css': 'empty' },
  stdin: { resolveDir: process.cwd(), contents: `
    import {SurfaceEditPanel} from './src/surfaceEditPanel.ts';
    window.calls=[];window.editable=true;window.targets=[{id:'photo',name:'实际摄影'}];
    const note=(kind,...args)=>{window.calls.push({kind,args});};
    window.panel=new SurfaceEditPanel({root:document.querySelector('#panel'),getTargets:()=>window.targets,canEdit:()=>window.editable,
      onDraw:mode=>note('draw',mode),onClearBoundary:()=>note('clear'),onGenerate:draft=>note('generate',draft),onCancel:()=>note('cancel'),
      onToggle:(...args)=>note('toggle',...args),onDelete:id=>Promise.resolve(note('delete',id)),onLocate:id=>note('locate',id),
      onEdit:id=>note('edit',id),onNew:()=>note('new'),onClose:()=>note('close'),onDraftChanged:()=>note('change')});
    window.panel.setBoundary(4,0);
  ` } });
const script = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/widget.js' ? 'application/javascript' : 'text/html');
  response.end(request.url === '/widget.js' ? script : '<!doctype html><html><meta charset="utf-8"><div id="panel"></div><script type="module" src="/widget.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8l0AAAAASUVORK5CYII=', 'base64');
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.panel);
  async function check(name, run) { await run(); report.checks.push({ name, status: 'passed' }); console.log('PASS', name); }
  await check('sampled defaults and complete draft use the selected target without changing scene state', async () => {
    assert.equal(await page.evaluate(() => window.panel.getBoundarySource()), 'sampled');
    assert.equal(await page.evaluate(() => window.panel.getSelectedTargetId()), 'photo');
    await page.locator('[data-se="name"]').fill('承台开挖');
    await page.locator('[data-se="targetHeight"]').fill('-8');
    await page.locator('[data-se-action="generate"]').click();
    const calls = await page.evaluate(() => window.calls.filter(call => call.kind === 'generate'));
    assert.equal(calls.length, 1); assert.equal(calls[0].args[0].targetHeight, -8);
    assert.equal(calls[0].args[0].boundarySource, 'sampled');
  });
  await check('read-only mode disables mutations but permits locate; user strings remain text', async () => {
    await page.evaluate(() => { window.panel.setPlans([{ id: 'p1', name: '<img src=x onerror=alert(1)>', kind: 'flatten', enabled: true, status: '已显示' }]); window.editable = false; window.panel.setEditable(); });
    assert.equal(await page.locator('[data-se-action="generate"]').isDisabled(), true);
    assert.equal(await page.locator('[data-se-toggle]').isDisabled(), true);
    assert.equal(await page.locator('[data-se="plans"] img').count(), 0);
    await page.locator('[data-se-action="locate"]').click();
    assert.equal(await page.evaluate(() => window.calls.at(-1).kind), 'locate');
    await page.evaluate(() => { window.editable = true; window.panel.setEditable(); });
  });
  await check('busy state preserves cancellation and does not generate draft-change callbacks', async () => {
    const before = await page.evaluate(() => window.calls.length);
    await page.evaluate(() => window.panel.setBusy('正在生成…'));
    assert.equal(await page.locator('[data-se-action="generate"]').isDisabled(), true);
    await page.locator('[data-se-action="cancel"]').click();
    await page.evaluate(() => window.panel.setBusy(null));
    const newCalls = await page.evaluate(before => window.calls.slice(before), before);
    assert.deepEqual(newCalls.map(c => c.kind), ['cancel']);
  });
  await check('valid raster upload is decoded and attached, oversized dimensions block save before decoding', async () => {
    await page.locator('details').nth(1).evaluate(element => { element.open = true; });
    await page.locator('[data-se="groundImage"]').setInputFiles({ name: 'soil.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => document.querySelector('[data-se="ground-image-status"]').textContent.includes('1 × 1'));
    assert.match(await page.evaluate(() => window.panel.getDraft().texture.groundImage), /^data:image\/png;base64,/);
    const huge = Buffer.from(png); huge.writeUInt32BE(40000, 16);
    await page.locator('[data-se="groundImage"]').setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: huge });
    await page.waitForFunction(() => document.querySelector('[data-se="ground-image-status"]').textContent.includes('2048'));
    assert.equal(await page.locator('[data-se-action="generate"]').isDisabled(), true);
    await page.locator('[data-se-action="clear-ground-image"]').click();
    assert.equal(await page.evaluate(() => window.panel.getDraft().texture.groundImage), undefined);
  });
  await check('a late decoded upload cannot overwrite a newly opened draft', async () => {
    await page.evaluate(() => { window.realBitmap = window.createImageBitmap; window.createImageBitmap = () => new Promise(resolve => { window.finishBitmap = () => resolve({ width: 1, height: 1, close() {} }); }); });
    await page.locator('[data-se="groundImage"]').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => !!window.finishBitmap);
    await page.evaluate(() => { window.panel.fill(); window.finishBitmap(); window.createImageBitmap = window.realBitmap; });
    await page.locator('[data-se="name"]').fill('新方案');
    await page.evaluate(() => window.panel.setBoundary(4, 0));
    await page.waitForFunction(() => !document.querySelector('[data-se-action="generate"]').disabled);
    assert.equal(await page.evaluate(() => window.panel.getDraft().texture.groundImage), undefined);
  });
  await check('boundary budget prevents oversized or empty geometry submission', async () => {
    await page.evaluate(() => window.panel.setBoundary(513, 0));
    assert.equal(await page.locator('[data-se-action="generate"]').isDisabled(), true);
    await page.evaluate(() => window.panel.setBoundary(0, 0));
    assert.equal(await page.locator('[data-se-action="hole"]').isDisabled(), true);
  });
  assert.deepEqual(report.pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
