import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { managementPlugin } from './managementStore.ts';
import { createProjectLibrary } from './projectLibrary.ts';
import { engineeringComponentsAssetsPlugin } from './engineeringComponentsAssets.ts';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

test('real managementPlugin sessions govern engineering assets and retain existing library authorization', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cesium-engineering-auth-test-')));
  const app = join(root, 'app'), assets = join(root, 'assets'), data = join(root, 'data');
  const calls: { actor: string; path: string; method: string; status: number }[] = [];
  let close: (() => Promise<void>) | undefined;
  try {
    await mkdir(app); await mkdir(data); await mkdir(join(assets, 'models'), { recursive: true });
    await mkdir(join(assets, 'structure-library/bridge/A001'), { recursive: true });
    await writeFile(join(app, 'index.html'), '<!doctype html><body>isolated authentication integration</body>');
    const glb = 'glTF-synthetic-auth-model';
    const catalog = JSON.stringify({ schema: 'jiashan/component-library/2.0', modelRevision: 'JS-auth-test',
      components: [{ id: 'A001_cap_01' }], groups: [{ id: 'A001' }], referenceGeometry: [] });
    const index = JSON.stringify({ A001: { path: 'structure-library/bridge/A001', count: 1, sha256: hash(glb) } });
    await writeFile(join(assets, 'models/Jiashan.glb'), glb); await writeFile(join(assets, 'components.json'), catalog);
    await writeFile(join(assets, 'structure-library/index.json'), index);
    await writeFile(join(assets, 'structure-library/bridge/A001/model.glb'), glb);
    await writeFile(join(assets, 'structure-library/bridge/A001/structure.json'), JSON.stringify({ unitId: 'A001', model: 'model.glb', componentIds: ['A001_cap_01'] }));
    const originalRecords = new Map<string, string>();
    for (const [id, kind] of [['model', '3D Tiles'], ['cad', 'CAD'], ['video', 'Drone Video']]) {
      const folder = join(data, 'records', id); await mkdir(join(folder, 'data'), { recursive: true });
      const record = JSON.stringify({ version: 1, id, kind, name: `private ${id}`, visible: false,
        createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
        files: { data: { name: 'source.txt', url: `/__library/files/${id}/data/source.txt` } }, settings: {} });
      originalRecords.set(join(folder, 'record.json'), record);
      await writeFile(join(folder, 'record.json'), record); await writeFile(join(folder, 'data/source.txt'), `synthetic ${id} bytes`);
    }
    const library = createProjectLibrary(data, { storageRoot: data });
    const server = await createServer({ configFile: false, root: app, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, watch: null },
      plugins: [managementPlugin({ dataDir: data, libraryDataDir: data }),
        engineeringComponentsAssetsPlugin({ directory: assets, expectedHashes: { catalog: hash(catalog), fullModel: hash(glb), index: hash(index) } }),
        { name: 'real-library-integration', configureServer(host) { host.middlewares.use(library.middleware); } }] });
    close = () => server.close(); await server.listen();
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    let cookie = '', actorName = 'initial-local-owner', sequence = 0;
    async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1', cookie },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      calls.push({ actor: actorName, path, method, status: response.status });
      let value: any;
      try { value = JSON.parse(text); } catch { value = text; }
      const nextCookie = response.headers.get('set-cookie')?.split(';')[0];
      return { status: response.status, text, value, nextCookie };
    }
    const command = (type: string, payload: Record<string, unknown>, id?: string) => call('/__management/commands',
      { projectId: 'safety:project', type, payload, id, idempotencyKey: `engineering-auth-${++sequence}` });
    // Preserve the existing first-use, loopback-only local owner behavior.
    assert.equal((await call('/__engineering-components/manifest')).status, 200);
    const password = 'Synthetic-Only-Engineering-2026';
    const boot = await command('member.save', { username: 'owner', displayName: 'Owner', password, roles: ['owner'] });
    assert.equal(boot.status, 200, boot.text); cookie = boot.nextCookie!; actorName = 'owner';
    const session = await call('/__management/session'); assert.equal(session.status, 200);
    const task = await command('task.create', { name: 'Synthetic task', ownerId: session.value.userId, planStart: '2026-11-20', planEnd: '2026-11-21' }, 'sample-task');
    assert.equal(task.status, 200, task.text);
    for (const [username, models, files, taskIds] of [
      ['model-reader', true, false, undefined], ['file-reader', false, true, undefined], ['task-model-reader', true, false, ['sample-task']],
    ] as const) {
      const created = await command('member.save', { username, displayName: username, password, roles: ['viewer'],
        resourceAccess: { models, files, media: false }, ...(taskIds ? { taskIds } : {}) });
      assert.equal(created.status, 200, created.text);
    }
    const resources = ['/__engineering-components/manifest', '/__engineering-components/components.json',
      '/__engineering-components/models/Jiashan.glb', '/__engineering-components/structure-library/bridge/A001/model.glb'];
    cookie = ''; actorName = 'anonymous';
    for (const path of [...resources, '/__library/records', '/__library/files/model/data/source.txt']) assert.equal((await call(path)).status, 401, path);
    for (const [username, expected] of [['file-reader', 403], ['model-reader', 200], ['task-model-reader', 403]] as const) {
      const login = await call('/__management/session', { username, password }); assert.equal(login.status, 200, login.text);
      cookie = login.nextCookie!; actorName = username;
      for (const path of resources) {
        const result = await call(path); assert.equal(result.status, expected, `${username}: ${path}: ${result.text}`);
        if (expected !== 200) assert.doesNotMatch(result.text, /glTF-synthetic|A001_cap_01/);
      }
      const list = await call('/__library/records');
      if (username === 'task-model-reader') {
        assert.equal(list.status, 403); assert.equal((await call('/__library/files/model/data/source.txt')).status, 403);
      } else {
        assert.equal(list.status, 200);
        assert.deepEqual(list.value.records.map((entry: { id: string }) => entry.id), [username === 'model-reader' ? 'model' : 'cad']);
        assert.equal((await call('/__library/files/model/data/source.txt')).status, username === 'model-reader' ? 200 : 403);
        assert.equal((await call('/__library/files/cad/data/source.txt')).status, username === 'file-reader' ? 200 : 403);
        assert.equal((await call('/__library/files/video/data/source.txt')).status, 403);
      }
    }
    for (const [file, bytes] of originalRecords) assert.equal(await readFile(file, 'utf8'), bytes, 'new asset access never rewrites existing library records');
    if (process.env.CESIUM_ENGINEERING_ASSETS_TEST_OUTPUT) {
      await mkdir(process.env.CESIUM_ENGINEERING_ASSETS_TEST_OUTPUT, { recursive: true });
      await writeFile(join(process.env.CESIUM_ENGINEERING_ASSETS_TEST_OUTPUT, 'real-management-http.json'),
        JSON.stringify({ actualVite: true, actualManagementPlugin: true, syntheticDataOnly: true, noProductionDataUsed: true, calls }, null, 2));
    }
  } finally { if (close) await close(); await rm(root, { recursive: true, force: true }); }
});
