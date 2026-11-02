import assert from 'node:assert/strict';
import test from 'node:test';
import { FLAG_CLOTH, FLAG_PLATFORM_SIZE, flagPlatformGeometry, NATIONAL_FLAG_STARS, parkedCarGeometry } from './temporaryWorksCourtyard.ts';

test('flag uses the 30 by 20 construction and each small star points towards the large star', () => {
  assert.equal(FLAG_CLOTH.width/FLAG_CLOTH.height,1.5);
  assert.deepEqual(NATIONAL_FLAG_STARS.map(s=>[s.x,s.y,s.r]),[[5,5,3],[10,2,1],[12,4,1],[12,7,1],[10,9,1]]);
  assert.equal(NATIONAL_FLAG_STARS[0].tip,-Math.PI/2);
  for(const s of NATIONAL_FLAG_STARS.slice(1)) assert.equal(s.tip,Math.atan2(5-s.y,5-s.x));
  const asset=flagPlatformGeometry();
  const gold=asset.find(b=>b.color==='#ffde00')!;
  assert.equal(gold.indices.length/3,5*10*2);
  for(const b of asset) for(let i=0;i<b.positions.length;i+=3) {
    assert.ok(Math.abs(b.positions[i]) <= FLAG_PLATFORM_SIZE.width/2+1e-9);
    assert.ok(Math.abs(b.positions[i+1]) <= FLAG_PLATFORM_SIZE.depth/2+1e-9);
    assert.ok(b.positions[i+2]>=0 && Number.isFinite(b.positions[i+2]));
  }
});

test('parked car is a bounded local-metre asset with five-space layout clearance', () => {
  const color='#607e90', asset=parkedCarGeometry(color);
  assert.ok(asset.some(b=>b.color===color));
  let maxX=0, maxY=0, minZ=Infinity, maxZ=-Infinity;
  for(const b of asset) {
    assert.ok(b.indices.length>0 && Math.max(...b.indices)<b.positions.length/3);
    for(let i=0;i<b.positions.length;i+=3) {
      maxX=Math.max(maxX,Math.abs(b.positions[i])); maxY=Math.max(maxY,Math.abs(b.positions[i+1]));
      minZ=Math.min(minZ,b.positions[i+2]); maxZ=Math.max(maxZ,b.positions[i+2]);
    }
  }
  assert.ok(2*maxX<=1.84 && 2*maxY<=4.47 && minZ>=0 && maxZ<=1.55);
  assert.ok(2.6-2*maxX>.75 && 5.2-2*maxY>.70);
});
