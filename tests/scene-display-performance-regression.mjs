import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
  if (!runtimeModules) throw new Error('Install playwright or set CODEX_PRIMARY_RUNTIME_NODE_MODULES.');
  ({ chromium } = require(`${runtimeModules}/playwright`));
}
const bundle = await build({
  stdin: { contents: 'export { SceneDisplayPanel } from "./src/sceneDisplayPanel.ts";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'iife', globalName: 'DisplayTest', loader: { '.css': 'empty' },
});
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><body><main id="host" style="width:400px;height:700px"></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text || bundle.outputFiles[0].text });
  const initial = await page.evaluate(() => {
    localStorage.setItem('scene-display:v1:["large","owner"]', JSON.stringify({ version: 1, collapsedCategories: ['工程模型', '监测点'] }));
    window.elementCreates = 0; window.toggleRegistrations = 0;
    const createElement = document.createElement.bind(document), addListener = EventTarget.prototype.addEventListener;
    document.createElement = (...args) => { elementCreates++; return createElement(...args); };
    EventTarget.prototype.addEventListener = function(type, ...args) {
      if (type === 'toggle') toggleRegistrations++;
      return addListener.call(this, type, ...args);
    };
    window.applied = []; window.located = [];
    window.panel = new DisplayTest.SceneDisplayPanel(document.querySelector('#host'), { onApply: overrides => applied.push(overrides) });
    window.items = Array.from({ length: 1500 }, (_, i) => ({
      id: `item:${i}`, name: `模型 ${i}`, category: i < 1000 ? '工程模型' : '监测点', visible: true,
      locate: () => located.push(`old:${i}`), remove: async () => {},
    }));
    const before = elementCreates;
    panel.setContext('large', 'owner', items);
    return { rowCount: document.querySelectorAll('[data-display-id]').length, elements: elementCreates - before, toggleRegistrations };
  });
  assert.equal(initial.rowCount, 0, 'collapsed catalogues do not build hidden object rows');
  assert(initial.elements < 100, `collapsed catalogues should build only category controls, got ${initial.elements}`);
  assert.equal(initial.toggleRegistrations, 1, 'one delegated toggle listener owns all categories');
  assert.equal(await page.locator('[data-role=display-count]').innerText(), '1500 / 1500 显示');

  await page.locator('details[data-category="工程模型"] > summary > strong').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-display-id]').length === 1000);
  await page.locator('[data-display-id="item:0"] [data-action=item-locate]').click();
  assert.deepEqual(await page.evaluate(() => located), ['old:0']);
  await page.evaluate(() => panel.setContext('large', 'owner', items.map(item => ({ ...item, locate: () => located.push(`new:${item.id}`) }))));
  await page.locator('[data-display-id="item:0"] [data-action=item-locate]').click();
  assert.deepEqual(await page.evaluate(() => located), ['old:0', 'new:item:0'], 'indexed callbacks refresh even if directory metadata stays the same');
  await page.locator('details[data-category="工程模型"] > summary > strong').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('scene-display:v1:["large","owner"]')).collapsedCategories.includes('工程模型'));

  const refreshes = await page.evaluate(() => {
    const before = elementCreates;
    for (let iteration = 0; iteration < 20; iteration++) panel.setContext('large', 'owner', items.map(item => ({ ...item, detail: `revision ${iteration}` })));
    return { elements: elementCreates - before, toggleRegistrations, rows: document.querySelectorAll('[data-display-id]').length };
  });
  assert.equal(refreshes.rows, 0);
  assert.equal(refreshes.toggleRegistrations, 1, 'refreshes do not accumulate listeners retaining detached category DOM');
  assert(refreshes.elements < 2000, `20 collapsed refreshes built ${refreshes.elements} elements`);
  await page.locator('details[data-category="工程模型"] [data-action=category-hide]').click();
  assert.equal(await page.locator('[data-role=display-count]').innerText(), '500 / 1500 显示', 'closed category batch controls still affect every member');
  assert.equal(await page.locator('[data-display-id]').count(), 0);

  await page.locator('[data-role=search]').fill('模型 1499');
  assert.equal(await page.locator('[data-display-id="item:1499"]').count(), 1, 'search reveals matches from a collapsed category');
  await page.locator('[data-select-item="item:1499"]').check();
  await page.locator('[data-role=search]').fill('');
  assert.equal(await page.locator('[data-display-id]').count(), 0, 'clearing search restores saved collapsed state');
  await page.locator('details[data-category="监测点"] > summary > strong').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-display-id]').length === 500);
  assert.equal(await page.locator('[data-select-item="item:1499"]').isChecked(), true, 'lazy rows retain selection across search and expansion');
  await page.locator('[data-display-id="item:1499"] [data-action=item-remove]').click();
  await page.waitForFunction(() => !document.querySelector('[data-display-id="item:1499"]'));
  assert.equal(await page.locator('[data-role=display-count]').innerText(), '499 / 1499 显示');

  await page.evaluate(() => panel.setContext('other', 'owner', [{ id: 'item:0', name: '另一项目', category: '工程模型', visible: true, locate: () => located.push('other') }]));
  await page.locator('[data-action=item-locate]').click();
  assert.equal(await page.evaluate(() => located.at(-1)), 'other', 'the item index never retains a previous project callback');
  await page.evaluate(() => panel.dispose());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'PASS', initial, refreshes, checks: ['lazy category rows', 'constant listener registration', 'latest callbacks', 'batch visibility', 'search', 'selection', 'deletion', 'scope isolation'] }));
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
