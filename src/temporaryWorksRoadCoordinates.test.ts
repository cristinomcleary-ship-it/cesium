import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanCoordinateFrame, createRoadCoordinateFrame } from './temporaryWorksCad.ts';

test('road chainage uses the source GK grid metres even near the outside of a projection zone', () => {
  const config = { mode:'gaussKruger', centralMeridian:120, hasZonePrefix:true, zoneNumber:40, unit:'cm', axisOrder:'northEast' } as const;
  const start = { x:335000000, y:4078500000 };
  const end = { x:start.x + 300000, y:start.y + 400000 };
  const road = createRoadCoordinateFrame(config, start), p = road.cadToLocal(end);
  assert.deepEqual(p, { x:4000, y:3000 });
  assert.equal(Math.hypot(p.x, p.y), 5000);
  const geo = road.localToGeo(p), back = road.geoToLocal(geo);
  assert.ok(Math.hypot(p.x-back.x, p.y-back.y) < 0.00001);
  const originalGeo = createPlanCoordinateFrame(config, end).origin;
  assert.ok(Math.abs(originalGeo.longitude - geo.longitude) < 1e-10 && Math.abs(originalGeo.latitude - geo.latitude) < 1e-10);
});

test('local CAD chainage preserves units, handedness and length even far from its georeferencing control', () => {
  const cfg = { mode:'local', referenceX:10, referenceY:20, longitude:121, latitude:31, rotation:90,
    unit:'mm', axisOrder:'northEast' } as const;
  const start = {x:2340010, y:8740020}, end = {x:start.x + 30000, y:start.y+40000};
  const frame = createRoadCoordinateFrame(cfg, start);
  const p = frame.cadToLocal(end);
  assert.ok(Math.abs(p.x+30) < 1e-8 && Math.abs(p.y-40) < 1e-8);
  const geo = frame.localToGeo(p), q = frame.geoToLocal(geo);
  assert.ok(Math.hypot(p.x-q.x,p.y-q.y) < 1e-5);
  const old = createPlanCoordinateFrame(cfg,end).origin;
  assert.ok(Math.abs(geo.longitude-old.longitude)<1e-10 && Math.abs(geo.latitude-old.latitude)<1e-10);
});

test('angular CAD drawings have a metric road frame', () => {
  const f = createRoadCoordinateFrame({mode:'geographic',axisOrder:'eastNorth'}, {x:121,y:0});
  const p = f.cadToLocal({x:121.001,y:0});
  assert.ok(Math.abs(Math.hypot(p.x,p.y)-111.31949)<0.001);
});

test('CGCS2000 standard zone numbers resolve both band widths and reject a mismatched zone', async () => {
  const {cgcs2000ZoneMeridian,inferredZoneNumber} = await import('./coordinateUtils.ts');
  for(const [width,first,last] of [[3,25,45],[6,13,23]] as const) {
    assert.equal(cgcs2000ZoneMeridian(first,width),75);
    assert.equal(cgcs2000ZoneMeridian(last,width),135);
    for(let zone=first;zone<=last;zone++)
      assert.equal(inferredZoneNumber(cgcs2000ZoneMeridian(zone,width),width),zone);
    for(const invalid of [NaN,Infinity,first-1,last+1,first+0.1]) assert.throws(()=>cgcs2000ZoneMeridian(invalid,width),/带号/);
  }
  assert.equal(cgcs2000ZoneMeridian(40,3),120);
  assert.equal(cgcs2000ZoneMeridian(20,6),117);
  assert.throws(()=>cgcs2000ZoneMeridian(40,4 as 3),/带宽/);
});

test('independent CGCS2000 transverse-Mercator control agrees for 3°, 6° and nonstandard project meridians', async () => {
  const {cgcs2000ZoneMeridian,parseLongitude} = await import('./coordinateUtils.ts');
  // Synthetic reference from a separate forward TM series and numerical GRS80
  // meridian integral for (central meridian + 0.125°, 31.2345°). Metres, unprefixed.
  const easting=511908.72389035183, northing=3456980.422100597;
  for(const [centralMeridian,zoneNumber] of [[cgcs2000ZoneMeridian(40,3),40],[cgcs2000ZoneMeridian(20,6),20],[parseLongitude('120°47′30″'),40]]) {
    for(const unit of ['m','cm','mm'] as const) for(const hasZonePrefix of [false,true]) for(const axisOrder of ['eastNorth','northEast'] as const) {
      const scale={m:1,cm:100,mm:1000}[unit];
      const east=(easting+(hasZonePrefix?zoneNumber*1e6:0))*scale, north=northing*scale;
      const point=axisOrder==='eastNorth'?{x:east,y:north}:{x:north,y:east};
      const config={mode:'gaussKruger',centralMeridian,zoneNumber,axisOrder,unit,hasZonePrefix} as const;
      const site=createPlanCoordinateFrame(config,point), road=createRoadCoordinateFrame(config,point);
      for(const frame of [site,road]) {
        const p=frame.localToGeo(frame.cadToLocal(point));
        assert.ok(Math.abs(p.longitude-(centralMeridian+.125))<1e-9);
        assert.ok(Math.abs(p.latitude-31.2345)<1e-9);
      }
    }
  }
});

test('one projected control corrects only model placement, in grid metres, and can be reapplied or cleared', async () => {
  const {checkProjectedControl} = await import('./temporaryWorksCad.ts');
  // CAD X=north, Y=prefixed east, both expressed in cm. The entered shift is always in metres.
  const cfg={mode:'gaussKruger',zoneNumber:40,centralMeridian:120,unit:'cm',hasZonePrefix:true,axisOrder:'northEast'} as const;
  const a={x:345698042.21,y:4051190872.39}, b={x:a.x+60000,y:a.y-80000};
  const offset={east:17.25,north:-9.125};
  const shift=(p:typeof a)=>({x:p.x+offset.north*100,y:p.y+offset.east*100});
  const observed=createRoadCoordinateFrame(cfg,shift(a)).origin;
  const adjusted={...cfg,modelOffset:offset};
  const check=checkProjectedControl(cfg,a,observed);
  assert.ok(Math.abs(check.east-offset.east)<1e-7);
  assert.ok(Math.abs(check.north-offset.north)<1e-7);
  assert.ok(Math.abs(check.distance-Math.hypot(offset.east,offset.north))<1e-7);
  assert.deepEqual(checkProjectedControl(adjusted,a,observed),check);
  for(const create of [createPlanCoordinateFrame,createRoadCoordinateFrame]) {
    for(const [start,end] of [[a,b],[b,a]]) {
      const original=create(cfg,start), corrected=create(adjusted,start);
      const local=original.cadToLocal(end);
      assert.deepEqual(corrected.cadToLocal(end),local);
      const geo=corrected.localToGeo(local),expected=createRoadCoordinateFrame(cfg,shift(end)).origin;
      assert.ok(Math.abs(geo.longitude-expected.longitude)<1e-9 && Math.abs(geo.latitude-expected.latitude)<1e-9);
      const back=corrected.geoToLocal(geo);
      assert.ok(Math.hypot(back.x-local.x,back.y-local.y)<.001);
      const zero=create({...adjusted,modelOffset:{east:0,north:0}},start);
      assert.deepEqual(zero.origin,original.origin);
      assert.deepEqual(zero.cadToLocal(end),local);
      assert.deepEqual(zero.localToGeo(local),original.localToGeo(local));
    }
  }
  assert.throws(()=>createRoadCoordinateFrame({...cfg,modelOffset:{east:NaN,north:0}},a),/平面偏移/);
});
