import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkbenchLeave, type WorkbenchNavigationState } from './workbenchNavigation.ts';

function fixture(overrides: Partial<WorkbenchNavigationState> = {}) {
  let closes = 0; const notices: string[] = [];
  return { state: { modelBusy: false, markupPicking: false, pitPicking: false,
    closeTemporaryWorks: () => { closes++; return true; }, notify: text => notices.push(text), ...overrides } as WorkbenchNavigationState,
    notices, closes: () => closes };
}
test('blocked placement/drawing never discards another editor or starts navigation', () => {
  for (const key of ['modelBusy', 'markupPicking', 'pitPicking'] as const) {
    const f = fixture({ [key]: true });
    assert.equal(prepareWorkbenchLeave('cad', f.state), false);
    assert.equal(f.closes(), 0); assert.equal(f.notices.length, 1);
  }
});
test('cancelled temporary draft navigation remains cancelled and current editor can stay open', () => {
  const f = fixture({ closeTemporaryWorks: () => false });
  assert.equal(prepareWorkbenchLeave('tiles', f.state), false);
  assert.equal(prepareWorkbenchLeave(undefined, f.state), false);
  assert.equal(prepareWorkbenchLeave('temporary-works', f.state), true);
});
test('the active gesture can return to its own editor while completed gestures allow leaving', () => {
  for (const [key, tab] of [['modelBusy', 'models'], ['markupPicking', 'markup'], ['pitPicking', 'monitoring']] as const) {
    const f = fixture({ [key]: true });
    assert.equal(prepareWorkbenchLeave(tab, f.state), true);
  }
  const f = fixture(); assert.equal(prepareWorkbenchLeave('videoar', f.state), true); assert.equal(f.closes(), 1);
});
