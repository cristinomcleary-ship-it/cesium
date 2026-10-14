import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RAIL_SAFETY_DISPLAY, normalizeRailSafetyDisplay, readRailSafetyDisplay, writeRailSafetyDisplay } from "./railSafetyDisplay.ts";

test("untrusted or old display preferences retain independent valid fields and bounded visual sizes", () => {
  const settings = normalizeRailSafetyDisplay({
    guards: { surface: "terrain", style: "outline", opacity: -0.3, lineWidth: 99 },
    envelopes: { surface: "other", style: "fill", opacity: 0.7, lineWidth: "4" },
    personnel: { representation: "point", scale: Infinity, heading: 480 },
  });
  assert.deepEqual(settings.guards, { surface: "terrain", style: "outline", opacity: 0, lineWidth: 8 });
  assert.deepEqual(settings.envelopes, { surface: "model", style: "fill", opacity: 0.7, lineWidth: 3 });
  assert.deepEqual(settings.personnel, { representation: "point", scale: 1, heading: 360 });
  for (const value of [null, [], "legacy", false]) assert.deepEqual(normalizeRailSafetyDisplay(value), DEFAULT_RAIL_SAFETY_DISPLAY);
  const isolated = normalizeRailSafetyDisplay(undefined);
  isolated.guards.opacity = 0.9;
  assert.equal(normalizeRailSafetyDisplay(undefined).guards.opacity, 0.25, "callers cannot mutate shared defaults through normalized results");
});

test("display preferences survive reload only in their project and actor scope, including delimiter-like identifiers", () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  const first = normalizeRailSafetyDisplay({ guards: { surface: "absolute", opacity: 0.63 }, personnel: { scale: 2.1, heading: 135 } });
  const second = normalizeRailSafetyDisplay({ envelopes: { style: "outline" } });
  assert.equal(writeRailSafetyDisplay("project:a", "actor", first, storage), true);
  assert.equal(writeRailSafetyDisplay("project", "a:actor", second, storage), true);
  assert.deepEqual(readRailSafetyDisplay("project:a", "actor", storage), first);
  assert.deepEqual(readRailSafetyDisplay("project", "a:actor", storage), second);
  assert.deepEqual(readRailSafetyDisplay("project:a", "other", storage), DEFAULT_RAIL_SAFETY_DISPLAY);
  assert.deepEqual(readRailSafetyDisplay("project:a", undefined, storage), DEFAULT_RAIL_SAFETY_DISPLAY);
  assert.deepEqual(readRailSafetyDisplay("other", "actor", storage), DEFAULT_RAIL_SAFETY_DISPLAY);
});

test("broken JSON and unavailable browser storage cannot prevent visual settings from working", () => {
  assert.deepEqual(readRailSafetyDisplay("project", "actor", { getItem: () => "{" }), DEFAULT_RAIL_SAFETY_DISPLAY);
  const unavailable = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(readRailSafetyDisplay("project", "actor", unavailable), DEFAULT_RAIL_SAFETY_DISPLAY);
  assert.equal(writeRailSafetyDisplay("project", "actor", DEFAULT_RAIL_SAFETY_DISPLAY, unavailable), false);
  assert.equal(writeRailSafetyDisplay("", "actor", DEFAULT_RAIL_SAFETY_DISPLAY, unavailable), false);
});
