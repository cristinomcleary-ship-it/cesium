import assert from "node:assert/strict";
import test from "node:test";
import { makeControlPointSession, summarizeResiduals, type RecordedControlPoint } from "./videoArControlPointSession.ts";
import { projectControlPoint, refineCameraPose } from "./videoArControlPoints.ts";
const frame = { originEcef: { x: 6378237, y: 0, z: 0 }, frameTime: 10.01, sourceKey: "real-source-identity-is-required",
  intrinsics: { width: 1920, height: 1080, fx: 1200, fy: 1200, cx: 960, cy: 540 },
  attitude: { yaw: 2, pitch: -86, roll: 1 }, context: { synthetic: true, modelVersion: "fixture-v1" } };
const truth = { position: { x: 3, y: -2, z: 1 }, attitude: { yaw: 0, pitch: -90, roll: 0 }, intrinsics: frame.intrinsics };
const controls: RecordedControlPoint[] = [[-30,-20,-100],[30,-20,-100],[30,20,-100],[-30,20,-100],[5,3,-75],[15,-12,-88]].map(([x,y,z]) => {
  const world = { x,y,z }, pixel = projectControlPoint(truth, world);
  return { pixelX: pixel.pixelX, pixelY: pixel.pixelY, world, worldEcef: { x:6378237+z,y:x,z:y }, role: "fit" };
});
test("holdout mismatch remains visible even when fitted controls are exact", () => {
  const solution = refineCameraPose({ initialPosition:{x:0,y:0,z:0}, initialAttitude:frame.attitude, intrinsics:frame.intrinsics, controls });
  const checks: RecordedControlPoint[] = controls.slice(0,2).map(p=>({...p,role:"check",pixelX:p.pixelX+25}));
  const session = makeControlPointSession({ frame, points:[...controls,...checks], solution });
  assert.ok(session.summary.after!.fit.rmsePx! < 0.01);
  assert.ok(Math.abs(session.summary.after!.check.rmsePx!-25)<0.01);
  assert.equal(session.summary.after!.fit.count,6);assert.equal(session.summary.after!.check.count,2);
  assert.equal(session.acceptance,"not-validated"); assert.equal(session.applicationStatus,"not-confirmed");
  assert.deepEqual(solution,session.solution);
});
test("behind-camera checks are counted as invalid instead of silently excluded", () => {
  const session=makeControlPointSession({frame,points:[...controls,{...controls[0],role:"check",world:{x:0,y:0,z:100}}]});
  assert.equal(session.summary.before.check.invalidCount,1);assert.equal(session.summary.before.check.rmsePx,null);
  assert.match(session.points.at(-1)!.before.reason!,/behind/);
  assert.equal(session.summary.after,null);
});
test("session JSON preserves original pixels, coordinate frame, source and model evidence", () => {
  const session=makeControlPointSession({frame,points:controls});
  const roundtrip=JSON.parse(JSON.stringify(session)); assert.deepEqual(roundtrip,session);
  assert.equal(session.frame.frameTime,10.01);assert.equal(session.frame.context!.modelVersion,"fixture-v1");
  session.frame.originEcef={x:0,y:0,z:0};session.points[0].worldEcef={x:0,y:0,z:0};
  assert.equal(frame.originEcef.x,6378237);assert.notEqual(controls[0].worldEcef.x,0);
});
test("P95 is nearest-rank and incomplete/empty checks never claim zero error", () => {
  const values=Array.from({length:20},(_,i)=>({valid:true,errorPx:i+1}));
  const stats=summarizeResiduals(values);assert.equal(stats.p95Px,19);assert.equal(stats.maxErrorPx,20);
  assert.equal(summarizeResiduals([]).rmsePx,null);
  assert.equal(summarizeResiduals([...values,{valid:false,reason:"behind"}]).rmsePx,null);
});
test("roles and invalid coordinates cannot silently change the fitted/check population", () => {
  assert.throws(()=>makeControlPointSession({frame,points:[{...controls[0],role:"unknown" as "fit"}]}),/role/);
  assert.throws(()=>makeControlPointSession({frame,points:[{...controls[0],pixelX:NaN}]}),/finite/);
});
