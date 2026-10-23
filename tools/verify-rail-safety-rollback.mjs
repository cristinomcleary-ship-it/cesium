/** Read an isolated browser database through the retained data-compatible revision.
 * node --experimental-transform-types tools/verify-rail-safety-rollback.mjs <test-db> <rollback-worktree>
 * The source is opened read-only; SQLite backup creates a consistent private copy.
 */
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const sourcePath = resolve(process.argv[2] || '');
const codePath = resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) throw new Error('Provide an isolated test database and the data-compatible rollback worktree');
const output = resolve('output/rail-safety-rollback');
await mkdir(output, { recursive: true }); await mkdir('tmp', { recursive: true });
const dataDir = await mkdtemp(resolve('tmp/rail-safety-rollback-data-'));
const copyPath = join(dataDir, 'management.sqlite');
const source = new DatabaseSync(sourcePath, { readOnly: true });
try { await backup(source, copyPath); } finally { source.close(); }
const fingerprint = () => {
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const tables = ['records', 'record_versions', 'audit', 'receipts'];
    const contents = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    return { sha256: createHash('sha256').update(JSON.stringify(contents)).digest('hex'), counts: Object.fromEntries(tables.map(table => [table, contents[table].length])) };
  } finally { db.close(); }
};
const before = fingerprint();
const { createManagementStore } = await import(pathToFileURL(join(codePath, 'server/managementStore.ts')).href);
const store = createManagementStore({ dataDir, libraryDataDir: dataDir });
let snapshot;
try { snapshot = store.load('safety:project', store.localActor()); } finally { store.close(); }
assert.ok(snapshot.collections.railSafety.length > 0, 'new definitions remain readable');
assert.ok(snapshot.collections.resources.some(record => record.machinery), 'original machinery remains readable');
const after = fingerprint(); assert.deepEqual(after, before, 'reading the rollback copy must not change records, history, audit or receipts');
const report = { status: 'passed', testedAt: new Date().toISOString(),
  rollbackCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codePath, encoding: 'utf8' }).trim(),
  rollbackTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: codePath, encoding: 'utf8' }).trim(),
  source: 'isolated browser acceptance database; opened read-only and copied with SQLite backup',
  sourcePath, copyPath, originalProductionDataReadOrModified: false,
  newDefinitions: snapshot.collections.railSafety.length,
  machinery: snapshot.collections.resources.filter(record => record.machinery).length,
  before, after,
  limitation: 'Verifies retained data-layer rollback; not compatibility with d0ed4a5 or earlier code.' };
await writeFile(join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, rollbackCommit: report.rollbackCommit, newDefinitions: report.newDefinitions, machinery: report.machinery, unchanged: before.sha256 === after.sha256 }));
