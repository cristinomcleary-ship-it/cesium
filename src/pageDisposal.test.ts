import test from 'node:test';
import assert from 'node:assert/strict';
import { disposeOnPageLeave } from './pageDisposal';

function pagehide(persisted = false) {
  return Object.assign(new Event('pagehide'), { persisted });
}

test('cancelling a leave confirmation retains live scene owners and their draft', () => {
  const page = new EventTarget(), owner = { destroyed: false, draft: 'unsaved placement' };
  let disposals = 0;
  page.addEventListener('beforeunload', event => event.preventDefault());
  disposeOnPageLeave(() => { owner.destroyed = true; owner.draft = ''; disposals++; }, undefined, page);
  assert.equal(page.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);
  assert.equal(owner.destroyed, false);
  assert.equal(owner.draft, 'unsaved placement');
  page.dispatchEvent(pagehide()); page.dispatchEvent(pagehide());
  assert.equal(owner.destroyed, true); assert.equal(disposals, 1);
});

test('a cached page remains usable and is disposed after its later actual exit', () => {
  const page = new EventTarget(); let disposals = 0;
  disposeOnPageLeave(() => { disposals++; }, undefined, page);
  page.dispatchEvent(pagehide(true)); page.dispatchEvent(new Event('pageshow'));
  assert.equal(disposals, 0);
  page.dispatchEvent(pagehide(false)); assert.equal(disposals, 1);
});

test('manual owner disposal removes its page lifecycle subscription', () => {
  const page = new EventTarget(), events = new AbortController(); let disposals = 0;
  disposeOnPageLeave(() => { disposals++; }, events.signal, page);
  events.abort(); page.dispatchEvent(pagehide()); assert.equal(disposals, 0);
});
