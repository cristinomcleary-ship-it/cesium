import test from "node:test";
import assert from "node:assert/strict";
import { resolveDjiHeight } from "./videoArHeight.ts";

const input = { sourceAltitude: 99.221, relativeAltitude: 70.105, correctionMeters: 0 };
test("unknown DJI baseline stays explicitly estimated instead of treating absolute as ellipsoid", () => {
  const result = resolveDjiHeight({ ...input, mode: "estimated", estimatedDatum: 0 });
  assert.equal(result.ellipsoidHeight, 70.105);
  assert.equal(result.estimated, true);
  assert.equal(result.valid, true);
});
test("relative and converted source heights agree only with an explicitly supplied datum", () => {
  const relative = resolveDjiHeight({ ...input, mode: "relative", takeoffEllipsoidHeight: 29.116 });
  const source = resolveDjiHeight({ ...input, mode: "source", sourceToEllipsoidOffset: 0 });
  assert.ok(Math.abs(relative.ellipsoidHeight! - source.ellipsoidHeight!) < 1e-10);
  assert.ok(Math.abs(resolveDjiHeight({ ...input, mode: "source", sourceToEllipsoidOffset: -12, correctionMeters: 2 }).ellipsoidHeight! - 89.221) < 1e-10);
});
test("missing explicit datums cannot silently fall back to zero or terrain", () => {
  for (const mode of ["relative", "source"] as const) {
    const result = resolveDjiHeight({ ...input, mode, estimatedDatum: 12 });
    assert.equal(result.valid, false);
    assert.equal(result.ellipsoidHeight, undefined);
  }
  assert.equal(resolveDjiHeight({ ...input, mode: "relative", takeoffEllipsoidHeight: 0 }).valid, true);
  assert.equal(resolveDjiHeight({ ...input, mode: "estimated" }).valid, false);
});
