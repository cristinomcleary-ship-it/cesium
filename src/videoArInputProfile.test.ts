import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoArInputProfile } from "./videoArInputProfile.ts";
const matrix = [1,0,0,0,0,1,0,0,0,0,1,0,10,20,30,1];
function diagnostics() { return {
  media: { video: { name: "original.mp4", sizeBytes: 1000, lastModified: 7 }, trajectory: { name: "telemetry.json", sizeBytes: 800, lastModified: 8 },
    decodedTimeSeconds: 10, width: 3840, height: 2160, readyState: 4 },
  sourceMetadata: { sourceSession:5, sourceCrs: "EPSG:4979", altitudeReference: "ellipsoid", recordingMatched: true, timelineMatched: true, associationBasis: "metadata and PTS coverage", timeline: "SRT PTS", generator: "source" },
  effectiveCamera: { sourceIdentity: { session: 5, calibration: "camera-config" }, videoTimeMs: 10000, poseTimeMs: 10000,
    ellipsoidHeight: 100, altitudeMode: "verified_absolute", height: { mode: "source", valid: true, sourceToEllipsoidOffset: 0, explanation: "user declared source" },
    intrinsics: { width:3840,height:2160,fx:2000,fy:2000,cx:1920,cy:1080 }, distortion: {k1:0,k2:0,p1:0,p2:0},
    intrinsicsSource: {fx:"DJI-estimated"}, provenance: {distortion:"zero-assumption"}, attitude: {yaw:0,pitch:-90,roll:0} },
  textureFrames: { active: { sourceSession:5,mediaTimeMs:10000 } }, rendering: {models:[{id:"model-one",modelMatrix:matrix,savedRecord:{updatedAt:"2026-01-01"}}]},
}; }
test("runtime facts may be verified while source declarations and calibration remain estimates", () => {
  const d = diagnostics(), before = structuredClone(d), p = buildVideoArInputProfile({diagnostics:d});
  const entry = (id:string) => p.entries.find(e=>e.id===id)!;
  assert.equal(entry("video-identity").status,"verified"); assert.equal(entry("media-pts").status,"verified");
  assert.equal(entry("model-transform").status,"verified");
  for (const id of ["coordinate-system","vertical-datum","camera-intrinsics","camera-distortion","attitude-definition"]) assert.equal(entry(id).status,"estimated",id);
  assert.equal(entry("mounting-relation").status,"missing");
  assert.equal(p.capabilities.originalPlayback.available,true); assert.equal(p.capabilities.verifiedModelFusion.available,false);
  assert.equal(p.accuracy.pixelRms,null); assert.equal(p.accuracy.heightMeters,null); assert.deepEqual(d,before);
});
test("missing inputs remain null and empty camera defaults cannot manufacture confidence", () => {
  const p = buildVideoArInputProfile({diagnostics:{}});
  assert.ok(p.entries.every(e=>e.status==="missing")); assert.ok(p.entries.every(e=>e.value===null));
  assert.equal(p.capabilities.originalPlayback.available,false); assert.equal(p.capabilities.trajectoryFollow.available,false);
});
test("old-source same PTS and inconsistent frame times are not verified", () => {
  const d = diagnostics(); d.textureFrames.active.sourceSession=4;
  assert.equal(buildVideoArInputProfile({diagnostics:d}).entries.find(e=>e.id==="media-pts")!.status,"estimated");
  d.textureFrames.active.sourceSession=5; d.textureFrames.active.mediaTimeMs=9000;
  assert.equal(buildVideoArInputProfile({diagnostics:d}).entries.find(e=>e.id==="media-pts")!.status,"estimated");
});
test("profile identity follows actual input version and model transform, independent of export time or current PTS", () => {
  const d = diagnostics(), p = buildVideoArInputProfile({diagnostics:d,generatedAt:"one"});
  assert.equal(buildVideoArInputProfile({diagnostics:d,generatedAt:"two"}).id,p.id);
  d.media.decodedTimeSeconds=30; d.effectiveCamera.videoTimeMs=30000;
  assert.equal(buildVideoArInputProfile({diagnostics:d}).id,p.id);
  d.rendering.models[0].modelMatrix=[...matrix]; d.rendering.models[0].modelMatrix[12]=11;
  assert.notEqual(buildVideoArInputProfile({diagnostics:d}).id,p.id);
});

test("roam capability requires the same saved recording, not a stale successful audit", () => {
  const d = { ...diagnostics(), media: { ...diagnostics().media, recordId: "record-new" } };
  const roamAudit = { recordId:"record-old", videoId:"video:record-old", source:"/source", sampleCount:100,
    recordingMatched:true,timelineMatched:true,heightReference:"declared ellipsoid",mediaOffsetSeconds:0,
    cameraAttitude:"unverified" as const,opticalRegistration:false as const,missing:[],notes:[] };
  assert.equal(buildVideoArInputProfile({diagnostics:d,roamAudit}).capabilities.trajectoryFollow.available,false);
  roamAudit.recordId="record-new";roamAudit.videoId="video:record-new";
  const p=buildVideoArInputProfile({diagnostics:d,roamAudit});
  assert.equal(p.capabilities.trajectoryFollow.available,true);assert.equal(p.capabilities.verifiedModelFusion.available,false);
});

test("a previous camera and texture pair cannot pass PTS verification for a new source session", () => {
  const d=diagnostics();d.sourceMetadata.sourceSession=6;
  assert.equal(buildVideoArInputProfile({diagnostics:d}).entries.find(e=>e.id==="media-pts")!.status,"estimated");
});
