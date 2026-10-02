import assert from "node:assert/strict";
import test from "node:test";
import { sameTextureFrame, textureFrameIdentity, videoMediaTimeMs } from "./videoArTextureFrame.ts";

test("video timestamps always use media time with or without RVFC, never the slider timeline", () => {
  assert.equal(videoMediaTimeMs(10.01, 10.025), 10010);
  assert.equal(videoMediaTimeMs(Number.NaN, 10.01), 10010);
  // A flight may start at 0.5 seconds or use duration-scaled playback. Neither
  // 9.51 seconds nor the flight slider belongs to this media timestamp helper.
  assert.notEqual(videoMediaTimeMs(Number.NaN, 10.01), 9510);
  assert.throws(() => videoMediaTimeMs(Number.NaN, Number.NaN), /finite/);
});

test("equal timestamps cannot pair different bitmaps or source sessions", () => {
  const a = textureFrameIdentity(1, "bitmap", "frame:a.jpg", 10010);
  assert.equal(sameTextureFrame(a, textureFrameIdentity(1, "bitmap", "frame:a.jpg", 10010)), true);
  assert.equal(sameTextureFrame(a, textureFrameIdentity(1, "bitmap", "frame:b.jpg", 10010)), false);
  assert.equal(sameTextureFrame(a, textureFrameIdentity(2, "bitmap", "frame:a.jpg", 10010)), false);
  assert.equal(sameTextureFrame(a, textureFrameIdentity(1, "video", "frame:a.jpg", 10010)), false);
  assert.equal(sameTextureFrame(a, textureFrameIdentity(1, "bitmap", "frame:a.jpg", 10043.367)), false);
  assert.equal(sameTextureFrame(a, undefined), false);
  assert.equal(Object.isFrozen(a), true);
});
