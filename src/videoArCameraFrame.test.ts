import assert from "node:assert/strict";
import { test } from "node:test";
import { Cartesian3, Cartographic, Math as CMath } from "cesium";
import { resolveCameraFrame, cameraFrameRay, cameraMatchesTexture, type CameraFrameInput } from "./videoArCameraFrame.ts";
import { resolveDjiHeight } from "./videoArHeight.ts";
const input = (): CameraFrameInput => ({
 sourceIdentity: { session: 1, video: { name: "original.mp4", sizeBytes: 1234, lastModified: 1 }, trajectory: { name: "track.json", sizeBytes: 4321, lastModified: 2 } },
 videoTimeMs:10010,poseTimeMs:10010,videoSampleIndex:300, longitude:120.88,latitude:30.83,rawAbsAltitude:99.117,rawRelativeAltitude:70.001,mappedHeightMeters:99.117,
 resolvedHeight:resolveDjiHeight({mode:"relative",sourceAltitude:99.117,relativeAltitude:70.001,takeoffEllipsoidHeight:29.116,correctionMeters:0}),
 attitude:{yaw:-30,pitch:-30,roll:0},referenceWidth:3840,referenceHeight:2160,djiIntrinsics:{fx:2560,fy:2560,cx:1920,cy:1080},fallbackHorizontalTangent:Math.tan(84*Math.PI/360),fallbackVerticalTangent:Math.tan(53*Math.PI/360),calibrationEnabled:false,manual:{},distortion:{k1:0},
 corrections:{east:0,north:0,height:0,yaw:0,pitch:0,roll:0,footprintScale:1},allowProjection:true,projectionMethod:"model-depth"
});
test("explicit datum is used once and output is detached/deeply immutable",()=>{
 const i=input(),f=resolveCameraFrame(i);assert.ok(Math.abs(f.effectiveHeightMeters-99.117)<1e-7);assert.equal(f.altitudeMode,"relative_takeoff");assert.equal(f.quality.height,"user-declared");assert.equal(f.quality.acceptance,"not-validated");assert.ok(Object.isFrozen(f.intrinsics));assert.ok(Object.isFrozen(f.sourceIdentity.video));
 (i.manual as {fx:number}).fx=100;(i.attitude as {yaw:number}).yaw=20;i.sourceIdentity.video!.name="changed.mp4";assert.equal(f.intrinsics.fx,2560);assert.equal(f.attitude.yaw,-30);assert.equal(f.sourceIdentity.video!.name,"original.mp4");
});
test("disabled corrections never change camera; DJI K beats UI FOV",()=>{
 const a=input(),b=input();b.corrections={east:20,north:10,height:50,yaw:15,pitch:20,roll:10,footprintScale:2};b.manual={fx:3000,fy:3200,cx:1600,cy:900};b.distortion={k1:.05};const f=resolveCameraFrame(a),g=resolveCameraFrame(b);assert.deepEqual(g,f);assert.equal(g.intrinsicsSource.fx,"DJI-estimated");
});
test("enabled manual K, attitude, pixel rays and translated marker use one camera",()=>{
 const i=input();i.calibrationEnabled=true;i.manual={fx:3000,fy:2900,cx:1800,cy:1000};i.corrections.east=12;i.corrections.north=-8;i.corrections.yaw=3;const f=resolveCameraFrame(i);assert.equal(f.intrinsics.fx,3000);assert.equal(f.intrinsicsSource.fx,"manual-unverified");assert.equal(f.attitude.yaw,-27);
 const llh=Cartographic.fromCartesian(new Cartesian3(f.positionEcef.x,f.positionEcef.y,f.positionEcef.z));assert.equal(CMath.toDegrees(llh.longitude),f.longitude);assert.deepEqual(f.originEcef,f.positionEcef);assert.ok(Math.abs(Cartesian3.dot(f.directionEcef as Cartesian3,f.upEcef as Cartesian3))<1e-12);const ray=cameraFrameRay(f,1800/3840,1000/2160);assert.ok(Cartesian3.distance(ray as Cartesian3,f.directionEcef as Cartesian3)<1e-12);
});
test("unknown and incomplete datums are distinct",()=>{
 const i=input();i.resolvedHeight=resolveDjiHeight({mode:"estimated",sourceAltitude:99.117,relativeAltitude:70.001,estimatedDatum:0,correctionMeters:0});const f=resolveCameraFrame(i);assert.equal(f.altitudeMode,"estimated");assert.equal(f.quality.height,"estimated");assert.ok(Math.abs(f.effectiveHeightMeters-70.001)<1e-7);
 i.resolvedHeight=resolveDjiHeight({mode:"relative",sourceAltitude:99.117,relativeAltitude:70.001,correctionMeters:0});const missing=resolveCameraFrame(i);assert.equal(missing.allowProjection,false);assert.equal(missing.quality.height,"missing");
});
test("model texture commit requires same decoded PTS",()=>{const f=resolveCameraFrame(input());assert.equal(cameraMatchesTexture(f,10010),true);assert.equal(cameraMatchesTexture(f,9976.667),false);assert.equal(cameraMatchesTexture(f,NaN),false);assert.equal(cameraMatchesTexture(undefined,10010),false);});

test("raw telemetry wall clock is independent from decoded and pose media PTS",()=>{const i=input();i.rawRecordedAt="2026-08-19 16:20:26.010";const f=resolveCameraFrame(i);assert.equal(f.rawRecordedAt,i.rawRecordedAt);assert.equal(f.videoTimeMs,10010);assert.equal(f.poseTimeMs,10010);});
