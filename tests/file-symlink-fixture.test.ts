import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileSymlinkFixture } from './helpers/fileSymlinkFixture.ts';

test('file-link fixture only reports unavailable Windows creation capabilities as skipped', async () => {
  for (const code of ['EPERM', 'EACCES', 'ENOTSUP']) {
    const reasons: string[] = [], error = Object.assign(new Error('fixture creation refused'), { code });
    const created = await createFileSymlinkFixture({ skip: reason => reasons.push(reason ?? '') }, 'ordinary-existing-target', 'new-link', {
      platform: 'win32', create: async () => { throw error; },
    });
    assert.equal(created, false); assert.equal(reasons.length, 1);
    assert.match(reasons[0], new RegExp(code)); assert.match(reasons[0], /assertions were not executed/);
  }
});

test('file-link fixture never hides Unix creation errors or unrelated Windows filesystem failures', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const codes = platform === 'win32' ? ['EINVAL', 'EIO', 'ENOENT', 'EEXIST'] : ['EPERM', 'EACCES', 'ENOTSUP'];
    for (const code of codes) {
      const error = Object.assign(new Error('unexpected fixture failure'), { code });
      await assert.rejects(createFileSymlinkFixture({ skip: () => assert.fail('unexpected skip') }, 'target', 'link', {
        platform, create: async () => { throw error; },
      }), value => value === error);
    }
  }
  await assert.rejects(createFileSymlinkFixture({ skip: () => assert.fail('unexpected skip') }, 'target', 'link', {
    platform: 'win32', create: async () => { throw new Error('no errno'); },
  }), /no errno/);
});

test('successful file-link creation always runs the caller boundary assertions on every platform', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    let called = 0;
    const created = await createFileSymlinkFixture({ skip: () => assert.fail('successful fixture skipped') }, 'target', 'link', {
      platform, create: async (...args) => { assert.deepEqual(args, ['target', 'link', 'file']); called++; },
    });
    assert.equal(created, true); assert.equal(called, 1);
  }
});
