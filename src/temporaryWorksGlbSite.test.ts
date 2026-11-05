import assert from 'node:assert/strict';
import test from 'node:test';
import {glbFootprintsInsideSite} from './temporaryWorksGlbSite.ts';
const xy=(pairs:number[][])=>pairs.map(([x,y])=>({x,y}));
const square=xy([[0,0],[10,0],[10,10],[0,10]]);
test('CAD site check accepts complete footprints, boundary contact and several independent buildings',()=>{
  assert.equal(glbFootprintsInsideSite([xy([[0,0],[3,0],[3,3],[0,3]]),xy([[6,6],[8,6],[8,8],[6,8]])],square),true);
  assert.equal(glbFootprintsInsideSite([xy([[9,9],[11,9],[11,11],[9,11]])],square),false);
});
test('a building crossing a concave CAD recess fails even when every building vertex is inside',()=>{
  const notch=xy([[0,0],[10,0],[10,10],[6,10],[6,4],[4,4],[4,10],[0,10]]);
  const bridge=xy([[2,2],[8,2],[8,8],[2,8]]);
  assert.equal(glbFootprintsInsideSite([bridge],notch),false);
});
test('reversing CAD winding leaves the containment decision unchanged',()=>{
  const building=xy([[2,2],[8,2],[8,8],[2,8]]);
  assert.equal(glbFootprintsInsideSite([building],square.slice().reverse()),true);
  assert.equal(glbFootprintsInsideSite([],square),false);
});
