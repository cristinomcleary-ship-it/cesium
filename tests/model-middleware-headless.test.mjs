import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { GlbWriter, IDENTITY } from '../tools/sketchup/glb-writer.mjs';

const compiled = await build({ entryPoints: [fileURLToPath(new URL('../server/modelMiddleware.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { createModelMiddleware } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const writer = new GlbWriter();
writer.addFace({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }, IDENTITY, { key: 'default' });
const glb = writer.finish().bytes;

async function serverFixture(config, action) {
  const directory = mkdtempSync(join(tmpdir(), 'models-headless-'));
  let server;
  try {
    const setup = typeof config === 'function' ? config(directory) : config;
    if (setup) writeFileSync(join(directory, 'model-converters.json'), JSON.stringify(setup));
    const middleware = createModelMiddleware(directory);
    server = createServer((request, response) => { void middleware(request, response, () => { response.statusCode = 404; response.end(); }); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    await action(base, directory);
  } finally {
    if (server) await new Promise((done) => { server.closeAllConnections(); server.close(done); });
    rmSync(directory, { recursive: true, force: true });
  }
}

test('old desktop configuration is blocked before upload or any process launch', async () => {
  await serverFixture((directory) => {
    const executable = join(directory, 'SketchUp.exe'); writeFileSync(executable, 'desktop');
    return { skp: { executable, args: ['{input}', '{output}'], validated: true, headless: true } };
  }, async (base, directory) => {
    const status = await (await fetch(`${base}/__models/status`)).json();
    assert.equal(status.converters.skp, false);
    assert.match(status.converterStatus.skp.reason, /已停用/);
    const imported = await fetch(`${base}/__models/import?extension=skp&name=test.skp`, { method: 'POST', body: 'test' });
    assert.equal(imported.status, 422);
    assert.deepEqual(readdirSync(join(directory, '.model-cache')), []);
  });
});

test('unmarked wrappers and RubyStartup launch configurations cannot launch a desktop app', async () => {
  for (const args of [['{input}', '{output}'], ['{input}', '{output}', '-RubyStartup', 'sketchup_export_glb.rb']]) {
    await serverFixture({ skp: { executable: process.execPath, args, validated: true } }, async (base) => {
      const response = await fetch(`${base}/__models/import?extension=skp`, { method: 'POST', body: 'test' });
      assert.equal(response.status, 422);
    });
  }
});

test('missing SDK has actionable status, while native GLB upload and retrieval continue working', async () => {
  await serverFixture(null, async (base) => {
    const status = await (await fetch(`${base}/__models/status`)).json();
    assert.equal(status.converters.skp, false);
    assert.match(status.converterStatus.skp.reason, /后台转换/);
    const response = await fetch(`${base}/__models/import?extension=glb&name=模型.glb`, { method: 'POST', body: glb });
    assert.equal(response.status, 200);
    const imported = await response.json();
    assert.equal(imported.converted, false);
    assert.deepEqual(Buffer.from(await (await fetch(new URL(imported.url, base))).arrayBuffer()), glb);
  });
});

test('verified independent headless converter runs and returns conversion diagnostics', async () => {
  await serverFixture((directory) => {
    const script = join(directory, 'converter.mjs');
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; const output=process.argv[3]; writeFileSync(output,Buffer.from('${glb.toString('base64')}','base64')); writeFileSync(output+'.conversion.json',JSON.stringify({warnings:['fixture diagnostic']}));`);
    return { skp: { executable: process.execPath, args: [script, '{input}', '{output}'], headless: true, validated: true } };
  }, async (base) => {
    const response = await fetch(`${base}/__models/import?extension=skp&name=测试.skp`, { method: 'POST', body: 'SKP fixture' });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const imported = await response.json();
    assert.equal(imported.converted, true); assert.deepEqual(imported.warnings, ['fixture diagnostic']);
    assert.deepEqual(Buffer.from(await (await fetch(new URL(imported.url, base))).arrayBuffer()), glb);
  });
});

test('invalid converter output is not published and failed job directory is removed', async () => {
  await serverFixture((directory) => {
    const script = join(directory, 'converter.mjs'); writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[3],'incomplete');`);
    return { skp: { executable: process.execPath, args: [script, '{input}', '{output}'], headless: true, validated: true } };
  }, async (base, directory) => {
    const response = await fetch(`${base}/__models/import?extension=skp`, { method: 'POST', body: 'SKP fixture' });
    assert.equal(response.status, 500);
    await response.json();
    // Cleanup follows response sending in the middleware finally block.
    await new Promise((done) => setTimeout(done, 30));
    assert.deepEqual(readdirSync(resolve(directory, '.model-cache')), []);
    assert.equal(existsSync(join(directory, 'SketchUp.exe')), false);
  });
});
