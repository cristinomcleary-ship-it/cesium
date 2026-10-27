import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
const read = file => fs.readFile(new URL('../src/' + file, import.meta.url), 'utf8');
const template = async (file, name, replacements = {}) => {
  const source = await read(file), begin = source.indexOf('export const ' + name + ' = `');
  assert.ok(begin >= 0, name);
  const start = source.indexOf('`', begin) + 1, end = source.indexOf('`;', start);
  return source.slice(start, end).replace(/\$\{([^}]+)\}/g, (_, key) => replacements[key] ?? 'fixture');
};
const main = await read('main.ts');
const basePanels = ['cad', 'models', 'tiles', 'gis'].map(name => {
  const match = main.match(new RegExp('<section class="panel(?: active)?" data-panel="' + name + '">[\\s\\S]*?</section>'));
  assert.ok(match, name); return match[0];
}).join('');
const markup = await template('markupTools.ts', 'markupPanelHtml');
const monitoring = await template('foundationPitMonitoring.ts', 'foundationPitMonitoringPanelHtml');
const video = await template('videoModelOverlay.ts', 'videoModelOverlayPanelHtml');
const report = await template('threeDReport.ts', 'threeDReportPanelHtml', { reportComposerPanelHtml: await template('reportComposer.ts', 'reportComposerPanelHtml') });
const sand = await template('electronicSandTable.ts', 'electronicSandTablePanelHtml', {
  electronicSandTablePresentationControlsHtml: await template('electronicSandTablePresentation.ts', 'electronicSandTablePresentationControlsHtml'),
  sandTableFacilitiesHtml: await template('sandTableFacilities.ts', 'sandTableFacilitiesHtml'),
  sandTableProjectControlHtml: await template('sandTableProjectControl.ts', 'sandTableProjectControlHtml'),
});
const result = await build({ entryPoints: [new URL('../src/panelCategories.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Categories', write: false });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 900 } });
  await page.setContent('<style>.hidden{display:none}section.panel{width:340px;padding:12px}</style>' + basePanels + video + markup + monitoring + sand + report);
  await page.addStyleTag({ content: await fs.readFile(new URL('../src/panelCategories.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const retained = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[id]')], classes = nodes.map(node => node.className);
    const input = document.querySelector('#anchorLon'); input.value = '121.333';
    let changes = 0; input.addEventListener('change', () => changes++);
    window.Categories.installWorkbenchCategories();
    const navCount = document.querySelectorAll('.operation-categories').length;
    window.Categories.installWorkbenchCategories();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      sameNodes: nodes.every(node => document.getElementById(node.id) === node),
      sameClasses: nodes.every((node, index) => node.className === classes[index]),
      value: input.value, changes, navCount, idempotent: navCount === document.querySelectorAll('.operation-categories').length,
      labels: [...document.querySelectorAll('.operation-categories')].map(nav => [...nav.querySelectorAll('button')].map(button => button.textContent)),
    };
  });
  assert.ok(retained.sameNodes && retained.sameClasses && retained.idempotent);
  assert.equal(retained.value, '121.333'); assert.equal(retained.changes, 1); assert.equal(retained.navCount, 8);
  for (const panel of ['cad', 'models', 'tiles', 'videoar', 'markup', 'monitoring', 'sandtable']) {
    const root = page.locator(`[data-panel="${panel}"]`), buttons = root.locator(':scope > .operation-categories > button');
    for (let i = 0; i < await buttons.count(); i++) {
      await buttons.nth(i).click();
      await page.waitForTimeout(25);
      assert.equal(await root.locator(':scope > .operation-category[open]').count(), 1, panel);
      assert.equal(await buttons.nth(i).getAttribute('aria-expanded'), 'true', panel);
    }
  }
  const validation = await page.evaluate(() => {
    const control = document.querySelector('#anchorLon'); control.dispatchEvent(new Event('invalid', { bubbles: false, cancelable: true }));
    return control.closest('.operation-category').open;
  });
  assert.ok(validation, 'A required input can reopen its folded category');
  const commonActions = await page.evaluate(() => ['loadCad', 'loadModel', 'loadTiles', 'ccStart', 'ccSave'].every(id => !document.getElementById(id).closest('.operation-category')));
  assert.ok(commonActions, 'Existing load and save actions stay accessible from every category');
  console.log(JSON.stringify({ passed: true, retainedControls: retained.sameNodes, retainedValuesAndListeners: true, categories: retained.labels, validationReveal: validation, commonActions }, null, 2));
} finally { await browser.close(); }
