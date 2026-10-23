import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

// Reproduce the real Studio -> Workspace callback order without browser/network state.
// AR treats denied access as revocation, so an intermediate denial is destructive.
const workspaceRoot = resolve(process.cwd());
const directory = await mkdtemp(`${workspaceRoot}/.management-snapshot-access-test-`);
assert.ok(resolve(directory).startsWith(workspaceRoot + sep));
try {
  await build({ stdin: { contents: 'export { ManagementWorkspace } from "./src/managementWorkspace.ts"; export { ManagementStudio } from "./src/managementStudio.ts";', resolveDir: workspaceRoot, loader: 'ts' },
    outfile: `${directory}/fixture.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
  const { ManagementWorkspace, ManagementStudio } = await import(pathToFileURL(`${directory}/fixture.mjs`).href);
  const source = ts.createSourceFile('managementWorkspace.ts', await readFile('src/managementWorkspace.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  let configuration;
  function visit(node) {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'ManagementStudio') configuration = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(configuration, 'the production Studio callbacks exist');
  const callbacks = ['onSessionChange', 'onSnapshot', 'onContextInvalidated'];
  const fields = callbacks.map(name => {
    const value = configuration.properties.find(node => node.name?.getText(source) === name);
    assert.ok(value && ts.isPropertyAssignment(value), name);
    return `${name}: ${value.initializer.getText(source)}`;
  });
  const code = ts.transpileModule(`return { ${fields.join(',')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let access = { models: true, files: true, media: true };
  const transitions = [], notifications = [], machineryContexts = [];
  const workspace = Object.assign(Object.create(ManagementWorkspace.prototype), {
    session: null, data: undefined, active: false, disposed: false, mode: 'management', machineryContextGeneration: 0, machineryContextSignature: '',
    machinery: { setContext(value) { machineryContexts.push(value); } }, railSafety: { setContext() {} },
    safety: {
      getManagementResourceAccess: () => ({ ...access }),
      setManagementResourceAccess(value) {
        access = { ...value };
        transitions.push({ ...access, actor: workspace.session?.userId, project: workspace.data?.projectId, snapshotActor: workspace.data?.session.userId });
      },
    },
    workbench: { onChange() { notifications.push({ ...access }); } },
  });
  const studio = Object.assign(Object.create(ManagementStudio.prototype), {
    snapshot: undefined, sessionSignature: '', disposed: false, loadSequence: 0,
    conditions: new Map(), conditionErrors: new Map(), options: new Function(code).call(workspace),
    invalidateMetrics() {}, updatePlayer() {}, resetFieldTools() {}, clearDraftCache() {}, ref: () => ({ innerHTML: '' }), render() {},
  });
  const snapshot = (actor, permissions, projectId = 'safety:project', revision = 1) => ({
    projectId, revision, session: { userId: actor, permissions }, members: [],
    collections: { resources: [{ id: `${actor}-equipment` }], railSafety: [], tasks: [], issues: [], allocations: [] },
  });
  const full = ['models', 'files', 'media', 'resource'];
  function takeSnapshot(data) {
    transitions.length = 0; notifications.length = 0; machineryContexts.length = 0;
    studio.applySnapshot(data);
    return transitions.map(value => ({ ...value }));
  }
  let changes = takeSnapshot(snapshot('owner', full));
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { models: true, files: true, media: true, actor: 'owner', project: 'safety:project', snapshotActor: 'owner' }, 'initial authorized snapshot never emits a false resource gate');
  assert.deepEqual(notifications, [{ models: true, files: true, media: true }], 'AR refresh sees only the complete authorized context');
  assert.equal(machineryContexts[0].records[0].id, 'owner-equipment');
  assert.deepEqual(takeSnapshot(snapshot('owner', full)), [], 'identical refresh does not churn resource access');

  changes = takeSnapshot(snapshot('second-owner', full));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].models, true);
  assert.equal(changes[0].files, true);
  assert.equal(changes[0].actor, changes[0].snapshotActor, 'account switch never publishes the new session with the old data');
  assert.equal(machineryContexts[0].records[0].id, 'second-owner-equipment');

  changes = takeSnapshot(snapshot('limited', ['files', 'media']));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].models, false, 'an actually restricted new account is revoked');
  assert.equal(changes[0].files, true);
  assert.deepEqual(notifications, [{ models: false, files: true, media: true }]);
  changes = takeSnapshot(snapshot('limited', [], 'safety:project', 2));
  assert.equal(changes[0].models, false);
  assert.equal(changes[0].files, false, 'same-account permission changes remain immediate');

  changes = takeSnapshot(snapshot('third-owner', full, 'another-project'));
  assert.equal(changes[0].models, false);
  assert.equal(changes[0].files, false, 'a snapshot for an unsupported project does not grant scene access');
  takeSnapshot(snapshot('third-owner', full, 'safety:project'));
  transitions.length = 0; notifications.length = 0;
  studio.invalidateAccess();
  assert.equal(workspace.session, null);
  assert.equal(workspace.data, undefined);
  assert.deepEqual(access, { models: false, files: false, media: false }, 'null session immediately clears access without waiting for a snapshot');
  assert.ok(transitions.length >= 1 && transitions.every(value => !value.models && !value.files && !value.media));
  assert.ok(notifications.length >= 1 && notifications.every(value => !value.models && !value.files));
  console.log('PASS: atomic authorized initialization/account snapshots; immediate restricted-account, permission, project and null-session revocation');
} finally {
  await rm(directory, { recursive: true, force: true });
}
