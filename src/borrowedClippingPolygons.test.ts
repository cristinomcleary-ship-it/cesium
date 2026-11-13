import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBorrowedClippingPolygons } from './borrowedClippingPolygons.ts';

test('owned collection release clears nested content aliases and invalidates stale uniform commands', () => {
  const owned = {}, foreign = {};
  const borrower = () => ({ _clippingPolygons: owned as object | undefined, _clippingPolygonsState: 2, resets: 0,
    resetDrawCommands() { this.resets++; }, isDestroyed: () => false });
  const direct = borrower(), nested = borrower(), other = { ...borrower(), _clippingPolygons: foreign };
  const dead = { ...borrower(), isDestroyed: () => true };
  const child = { content: { innerContents: [{ _model: nested }, { _model: other }, { _model: dead }] }, _clippingPolygonsState: 2, clippingPolygonsDirty: false };
  const root = { content: { _model: direct }, children: [child], _clippingPolygonsState: 2, clippingPolygonsDirty: false };
  assert.equal(releaseBorrowedClippingPolygons({ root }, owned), 2);
  for (const model of [direct, nested]) { assert.equal(model._clippingPolygons, undefined); assert.equal(model._clippingPolygonsState, 0); assert.equal(model.resets, 1); }
  for (const tile of [root, child]) { assert.equal(tile._clippingPolygonsState, 0); assert.equal(tile.clippingPolygonsDirty, true); }
  assert.equal(other._clippingPolygons, foreign); assert.equal(other.resets, 0);
  assert.equal(dead._clippingPolygons, owned); assert.equal(dead.resets, 0);
  assert.equal(releaseBorrowedClippingPolygons({ root }, owned), 0);
  assert.equal(direct.resets, 1); assert.equal(nested.resets, 1);
});

test('unloaded tiles and content from a foreign owner remain untouched', () => {
  const tile = { content: { _model: { _clippingPolygons: {}, _clippingPolygonsState: 3, resetDrawCommands() { throw Error('foreign owner touched'); } } }, clippingPolygonsDirty: false, _clippingPolygonsState: 3 };
  assert.equal(releaseBorrowedClippingPolygons({}, {}), 0);
  assert.equal(releaseBorrowedClippingPolygons({ root: tile }, {}), 0);
  assert.equal(tile.clippingPolygonsDirty, false); assert.equal(tile._clippingPolygonsState, 3);
});


test('wide and cyclic loaded content releases exact aliases without argument spreading', () => {
  const owned = {}, foreign = {};
  const model = { _clippingPolygons: owned as object | undefined, _clippingPolygonsState: 1, resets: 0, resetDrawCommands() { this.resets++; } };
  const other = { _clippingPolygons: foreign, resets: 0, resetDrawCommands() { this.resets++; } };
  const shared = { _model: model };
  const content: { innerContents: unknown[] } = { innerContents: Array.from({ length: 150_000 }, () => shared) };
  content.innerContents.push(content, { _model: other });
  const child: { content: unknown; children: unknown[] } = { content, children: [] };
  const root = { children: Array.from({ length: 150_000 }, () => child) };
  child.children.push(root);
  assert.equal(releaseBorrowedClippingPolygons({ root }, owned), 1);
  assert.equal(model.resets, 1); assert.equal(model._clippingPolygons, undefined);
  assert.equal(other._clippingPolygons, foreign); assert.equal(other.resets, 0);
});
