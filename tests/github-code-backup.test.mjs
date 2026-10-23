import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubCodeBackup } from '../tools/github-code-backup.mjs';

const sha = '1234567890abcdef1234567890abcdef12345678';
const otherSha = 'abcdef1234567890abcdef1234567890abcdef12';
const url = 'https://github.com/cristinomcleary-ship-it/cesium.git';
const branch = 'backup/local-deploy/20261023T120000000Z-unique-id';
const ref = `refs/heads/${branch}`;

function fixture(overrides = {}) {
  const calls = [];
  let pushed = false, stateReads = 0, headReads = 0;
  const runGit = (args, root) => {
    assert.equal(root, '/existing/project');
    calls.push(args);
    const key = args.join(' ');
    if (overrides.fail?.(args)) throw new Error('https://secret@example.invalid/ must not be exposed');
    if (key === 'remote get-url --all origin') return overrides.fetchUrl ?? url;
    if (key === 'remote get-url --push --all origin') return overrides.pushUrl ?? url;
    if (args[0] === 'status') return overrides.dirty?.(stateReads++) ?? '';
    if (args[0] === 'rev-parse') return overrides.head?.(headReads++) ?? sha;
    if (args[0] === 'ls-remote') {
      assert.deepEqual(args, ['ls-remote', '--heads', 'origin', ref]);
      return pushed ? (overrides.verifiedRef ?? `${sha}\t${ref}`) : (overrides.existingRef ?? '');
    }
    if (args[0] === 'push') {
      assert.deepEqual(args, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`]);
      pushed = true; return 'Done';
    }
    assert.fail(`Unexpected mutating or unknown command: ${key}`);
  };
  return {
    calls,
    backup: (expected = sha) => createGithubCodeBackup('/existing/project', expected, {
      runGit, now: () => new Date('2026-10-23T12:00:00.000Z'), randomId: () => 'unique-id',
    }),
  };
}

test('backs up the fixed clean commit only after checking both remote directions, then verifies the remote SHA', () => {
  const f = fixture();
  assert.deepEqual(f.backup(), { branch, sha, url: `https://github.com/cristinomcleary-ship-it/cesium/tree/${branch}` });
  const names = f.calls.map(args => args[0]);
  assert.deepEqual(names, ['remote', 'remote', 'status', 'rev-parse', 'ls-remote', 'status', 'rev-parse', 'push', 'ls-remote', 'status', 'rev-parse']);
  assert.equal(names.filter(name => name === 'push').length, 1);
  assert.ok(!f.calls.flat().some(value => ['add', 'commit', 'stash', 'bundle', 'checkout', 'reset', 'clean', 'HEAD:'].includes(value)));
});

test('accepts the repository HTTPS and GitHub SSH URL spellings', () => {
  for (const remote of [url, url.slice(0, -4), 'git@github.com:cristinomcleary-ship-it/cesium.git', 'ssh://git@github.com/cristinomcleary-ship-it/cesium.git']) {
    assert.equal(fixture({ fetchUrl: remote, pushUrl: remote }).backup().sha, sha);
  }
});

test('rejects wrong fetch or push destinations and multiple push URLs without publishing', () => {
  for (const override of [
    { fetchUrl: 'https://github.com/other/repository.git' },
    { pushUrl: 'https://github.com/other/repository.git' },
    { pushUrl: `${url}\n${url}` },
    { fetchUrl: `${url}\n${url}` },
    { pushUrl: 'https://token@github.com/cristinomcleary-ship-it/cesium.git' },
    { pushUrl: 'https://github.com.example.invalid/cristinomcleary-ship-it/cesium.git' },
  ]) {
    const f = fixture(override);
    assert.throws(() => f.backup(), /exactly one fetch URL and one push URL/);
    assert.equal(f.calls.some(args => args[0] === 'push'), false);
  }
});

test('dirty files or a different HEAD stop before any push, including changes during the remote check', () => {
  for (const override of [
    { dirty: () => ' M src/main.ts' },
    { dirty: () => '?? local-config.json' },
    { dirty: read => read > 0 ? ' M src/main.ts' : '' },
    { head: () => otherSha },
    { head: read => read > 0 ? otherSha : sha },
  ]) {
    const f = fixture(override);
    assert.throws(() => f.backup(), /not clean|HEAD changed/);
    assert.equal(f.calls.some(args => args[0] === 'push'), false);
  }
});

test('refuses every pre-existing backup ref even if it already points to this SHA', () => {
  for (const existingRef of [`${sha}\t${ref}`, `${otherSha}\t${ref}`]) {
    const f = fixture({ existingRef });
    assert.throws(() => f.backup(), /already exists/);
    assert.equal(f.calls.some(args => args[0] === 'push'), false);
  }
});

test('a failed read or create-only push stops without fallback or credential disclosure', () => {
  for (const command of ['remote', 'ls-remote', 'push']) {
    const f = fixture({ fail: args => args[0] === command });
    assert.throws(() => f.backup(), error => {
      assert.match(error.message, new RegExp(`git ${command} failed`));
      assert.ok(!error.message.includes('secret'));
      return true;
    });
    assert.equal(f.calls.at(-1)[0], command);
    assert.ok(f.calls.filter(args => args[0] === 'push').length <= 1);
  }
});

test('missing, changed, unrelated or ambiguous verification results cannot report a successful backup', () => {
  for (const verifiedRef of ['', `${otherSha}\t${ref}`, `${sha}\trefs/heads/other`, `${sha}\t${ref}\n${sha}\t${ref}`]) {
    const f = fixture({ verifiedRef });
    assert.throws(() => f.backup(), /SHA could not be verified/);
    assert.equal(f.calls.filter(args => args[0] === 'push').length, 1);
  }
});

test('a local change during push is not reported as a fully verified deployment snapshot', () => {
  for (const override of [
    { dirty: read => read > 1 ? ' M src/main.ts' : '' },
    { head: read => read > 1 ? otherSha : sha },
  ]) {
    const f = fixture(override);
    assert.throws(() => f.backup(), /not clean|HEAD changed/);
    assert.equal(f.calls.filter(args => args[0] === 'push').length, 1);
  }
});

test('rejects partial or invalid commit arguments before invoking Git', () => {
  const f = fixture();
  for (const expected of ['HEAD', sha.slice(0, 7), '', '../unsafe']) assert.throws(() => f.backup(expected), /full expected commit SHA/);
  assert.throws(() => createGithubCodeBackup('/existing/project', undefined), /full expected commit SHA/);
  assert.equal(f.calls.length, 0);
});
