import assert from 'node:assert/strict';
import test from 'node:test';
import { InheritedTextureWriterPool } from '../tools/sketchup/texture-writer-pool.mjs';

test('inherited paints share encoding within one material but isolate repeated faces and projected texture IDs', () => {
  let next = 100n;
  const released = [];
  const pool = new InheritedTextureWriterPool(() => ({ ptr: next++ }), (writer) => released.push(writer.ptr));
  const root = { ptr: 1n }, otherRoot = { ptr: 2n };
  const red = { ptr: 10n }, blue = { ptr: 20n };
  const encoded = new Map();
  const encode = (owner, paint, sdkTextureId, pixels) => {
    const context = pool.get(owner, paint);
    const key = `${context.namespace}:${sdkTextureId}`;
    if (!encoded.has(key)) encoded.set(key, pixels);
    return encoded.get(key);
  };
  assert.equal(encode(root, red, 1, 'red pixels'), 'red pixels');
  assert.equal(encode(root, { ptr: 10n }, 1, 'must reuse'), 'red pixels');
  assert.equal(encoded.size, 1, 'another face using the same SDK texture ID is not re-encoded');
  assert.equal(encode(root, blue, 1, 'blue pixels'), 'blue pixels', 'the same shared face under another paint cannot see the old texture');
  assert.equal(encode(root, red, 2, 'projected red pixels'), 'projected red pixels');
  assert.equal(encoded.size, 3, 'a distinct projected texture ID remains distinct');
  assert.notEqual(pool.get(root, red).writer, pool.get(otherRoot, red).writer);
  const otherWriter = pool.get(otherRoot, red).writer;
  const oldNamespace = pool.get(root, red).namespace;
  pool.release(root);
  assert.equal(released.length, 2);
  assert.ok(!released.includes(otherWriter.ptr), 'unrelated root remains alive');
  pool.release(root);
  assert.equal(released.length, 2, 'cleanup is not repeated');
  assert.notEqual(pool.get(root, red).namespace, oldNamespace, 'recycled native owner pointers cannot reuse old encoded image keys');
  pool.release(root);
  pool.release(otherRoot);
  assert.equal(new Set(released).size, 4);
});

test('a native release failure still clears ownership and releases all remaining material writers', () => {
  let next = 1n;
  const released = [];
  const pool = new InheritedTextureWriterPool(() => ({ ptr: next++ }), ({ ptr }) => {
    released.push(ptr);
    if (ptr === 1n) throw new Error('native release failed');
  });
  const root = { ptr: 100n };
  pool.get(root, { ptr: 10n }); pool.get(root, { ptr: 20n });
  assert.throws(() => pool.release(root), AggregateError);
  assert.deepEqual(released, [1n, 2n]);
  pool.release(root);
  assert.deepEqual(released, [1n, 2n]);
});
