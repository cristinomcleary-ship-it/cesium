import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
  if (!runtimeModules) throw new Error('Install playwright or set CODEX_PRIMARY_RUNTIME_NODE_MODULES to run the browser regression.');
  ({ chromium } = require(`${runtimeModules}/playwright`));
}
const bundle = await build({
  stdin: { contents: 'export { SceneDisplayPanel } from "./src/sceneDisplayPanel.ts"; export { SceneDisplayStore } from "./src/sceneDisplayStore.ts";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'iife', globalName: 'DisplayTest', loader: { '.css': 'empty' },
});
const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><main id="host" style="width:360px;height:700px"></main></body></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text || bundle.outputFiles[0].text });
  await page.evaluate(() => {
    window.calls = 0; window.reported = [];
    window.panel = new DisplayTest.SceneDisplayPanel(document.querySelector('#host'), { onApply: () => {}, onError: text => reported.push(text) });
    window.rows = [
      { id: 'asset:A', name: '吊机 A', category: '模型', visible: true, remove: () => { calls++; return new Promise(resolve => window.finish = resolve); } },
      { id: 'asset:B', name: '桥墩 B', category: '模型', visible: true },
    ];
    panel.setContext('project-1', 'actor-1', rows);
    panel.setVisibility(['asset:A'], false);
  });
  assert.equal(await page.locator('[data-action=item-remove]').count(), 1, 'only resources with a remove callback expose deletion');
  assert.equal(await page.locator('[data-action=item-remove]').isEnabled(), true, 'hidden resources remain removable');
  await page.locator('[data-select-item="asset:A"]').check();
  await page.locator('[data-select-item="asset:B"]').check();
  await page.locator('[data-action=create-group]').click();
  await page.locator('[data-role=group-name]').fill('施工资源');
  await page.locator('[data-action=save-group]').click();
  await page.locator('[data-action=view-categories]').click();
  await page.locator('[data-select-item="asset:A"]').check();
  await page.locator('[data-action=create-group]').click();
  await page.locator('[data-role=group-name]').fill('吊机单组');
  await page.locator('[data-action=save-group]').click();
  assert.equal(await page.locator('[data-action=item-remove]').count(), 2);
  await page.locator('[data-action=item-remove]').first().click();
  await page.evaluate(() => {
    document.querySelectorAll('[data-action=item-remove]').forEach(button => button.click());
    panel.setContext('project-1', 'actor-1', rows);
  });
  assert.equal(await page.evaluate(() => calls), 1, 'pending deletion cannot run twice across duplicate group rows or refreshes');
  assert.equal(await page.locator('[data-action=item-remove]:disabled').count(), 2);
  await page.evaluate(() => finish());
  await page.waitForFunction(() => !document.querySelector('[data-display-id="asset:A"]'));
  assert.equal(await page.locator('[data-display-id="asset:B"]').count(), 1, 'other resource is retained');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scene-display:v1:["project-1","actor-1"]')));
  assert.deepEqual(saved.overrides, {});
  assert.deepEqual(saved.groups.map(group => group.members), [['asset:B'], []], 'delete removes exact membership but keeps groups');
  assert.equal(await page.locator('.sdp-unavailable').count(), 0, 'deleted resources are not shown as temporarily unavailable');
  assert.match(await page.locator('[data-role=status]').innerText(), /已删除/);

  await page.evaluate(() => {
    panel.setContext('project-1', 'actor-1', [{ id: 'asset:B', name: '桥墩 B', category: '模型', visible: true, remove: async () => { throw new Error('资源仍被占用'); } }]);
  });
  await page.locator('[data-action=item-remove]').click();
  await page.waitForFunction(() => document.querySelector('[data-role=status]').textContent.includes('删除“桥墩 B”失败'));
  assert.equal(await page.locator('[data-display-id="asset:B"]').count(), 1, 'failure retains the resource row');
  assert.equal(await page.locator('[data-action=item-remove]').isEnabled(), true, 'failed removal can be retried');
  assert.match(await page.locator('[data-role=status]').innerText(), /资源仍被占用/);

  await page.evaluate(() => {
    rows = [{ id: 'shared-id', name: '原项目资源', category: '模型', visible: true, remove: () => new Promise(resolve => window.finish = resolve) }];
    panel.setContext('original', 'actor', rows); panel.setVisibility(['shared-id'], false);
  });
  await page.locator('[data-select-item="shared-id"]').check();
  await page.locator('[data-action=create-group]').click();
  await page.locator('[data-role=group-name]').fill('原项目分组');
  await page.locator('[data-action=save-group]').click();
  await page.locator('[data-action=item-remove]').click();
  await page.evaluate(() => {
    panel.setContext('another', 'actor', [{ id: 'shared-id', name: '另一项目资源', category: '模型', visible: true, remove: async () => {} }]);
    panel.setVisibility(['shared-id'], false);
    window.otherBefore = localStorage.getItem('scene-display:v1:["another","actor"]');
    finish();
  });
  await page.waitForTimeout(30);
  assert.equal(await page.locator('[data-display-id="shared-id"]').count(), 1, 'completion in previous project cannot remove the current project row');
  assert.equal(await page.evaluate(() => localStorage.getItem('scene-display:v1:["another","actor"]') === otherBefore), true, 'current project preferences remain untouched');
  const oldSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('scene-display:v1:["original","actor"]')));
  assert.deepEqual(oldSaved.overrides, {});
  assert.deepEqual(oldSaved.groups[0].members, [], 'captured old scope is cleaned even after navigation');
  assert.equal(await page.locator('[data-role=status]').isVisible(), false, 'previous project status is not shown in current project');

  await page.evaluate(() => {
    panel.setContext('returning', 'actor', [{ ...rows[0], remove: () => new Promise(resolve => window.finish = resolve) }]);
  });
  await page.locator('[data-action=item-remove]').click();
  await page.evaluate(() => {
    panel.setContext('away', 'actor', []);
    panel.setContext('returning', 'actor', rows);
  });
  assert.equal(await page.locator('[data-action=item-remove]').isEnabled(), false);
  await page.evaluate(() => finish());
  await page.waitForFunction(() => !document.querySelector('[data-action=item-remove]').disabled);
  assert.equal(await page.locator('[data-role=status]').isVisible(), false, 'returning to project does not show stale completion messages');

  await page.evaluate(() => panel.setContext('signature', 'actor', [{ id: 'asset:fixed', name: '固定模型', category: '模型', visible: true }]));
  assert.equal(await page.locator('[data-action=item-remove]').count(), 0);
  await page.evaluate(() => panel.setContext('signature', 'actor', [{ id: 'asset:fixed', name: '固定模型', category: '模型', visible: true, remove: async () => {} }]));
  assert.equal(await page.locator('[data-action=item-remove]').count(), 1, 'callback availability refreshes identical directory signature');
  await page.evaluate(() => panel.setContext('signature', 'actor', [{ id: 'asset:fixed', name: '固定模型', category: '模型', visible: true }]));
  assert.equal(await page.locator('[data-action=item-remove]').count(), 0);

  await page.evaluate(() => {
    panel.setContext('dispose', 'actor', [{ ...rows[0], remove: () => new Promise(resolve => window.finish = resolve) }]);
  });
  await page.locator('[data-action=item-remove]').click();
  await page.evaluate(() => { panel.dispose(); finish(); });
  await page.waitForTimeout(30);
  assert.deepEqual(errors, []);
  console.log('PASS scene display delete: one click, pending deduplication, failure retention, exact preference cleanup, scope isolation, callback refresh, disposal.');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
