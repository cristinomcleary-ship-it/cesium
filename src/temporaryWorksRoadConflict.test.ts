import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRoadStation, markConflictStations, RoadRouteConflict } from './temporaryWorksRoadConflict.ts';

test('CAD conflict highlights use the solver chainage, including arc factors and reversed survey axes', () => {
  const metric = [{x:0,y:0},{x:0,y:8},{x:4,y:8}];
  const cad = [{x:42000,y:39000},{x:34000,y:39000},{x:34000,y:35000}];
  const error = new RoadRouteConflict('crossing', [12,5]);
  assert.match(error.message,/K0\+005\.000.*K0\+012\.000/);
  const [first,second] = markConflictStations(cad,metric,[1.25,1],error.stations);
  assert.deepEqual(first.point,{x:38000,y:39000});
  assert.deepEqual(second.point,{x:34000,y:37000});
  assert.deepEqual(first.from,cad[0]); assert.deepEqual(second.to,cad[2]);
  assert.equal(formatRoadStation(999.9999),'K1+000.000');
});

test('a repeated CAD vertex does not consume station distance or move the marker to another segment', () => {
  const cad=[{x:0,y:0},{x:0,y:0},{x:0,y:10},{x:5,y:10}];
  const marks=markConflictStations(cad,cad,undefined,[2,14]);
  assert.deepEqual(marks.map(m=>m.point),[{x:0,y:2},{x:4,y:10}]);
});
