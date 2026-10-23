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
  assert.deepEqual(settings.envelopes, { surface: "model", style: "fill", opacity: 0.7, lineWidth: 3, representation: "pose" });
  assert.deepEqual(settings.personnel, { representation: "point", scale: 1, heading: 360 });
  assert.deepEqual(settings.limits, { representation: "plane", wallHeight: 5, wallOpacity: 0.22 });
  for (const value of [null, [], "legacy", false]) assert.deepEqual(normalizeRailSafetyDisplay(value), DEFAULT_RAIL_SAFETY_DISPLAY);
  const isolated = normalizeRailSafetyDisplay(undefined);
  isolated.guards.opacity = 0.9;
  isolated.limits.wallHeight = 60;
  isolated.colors.limit = "#000000";
  assert.equal(normalizeRailSafetyDisplay(undefined).guards.opacity, 0.25, "callers cannot mutate shared defaults through normalized results");
  assert.equal(normalizeRailSafetyDisplay(undefined).limits.wallHeight, 5);
  assert.equal(normalizeRailSafetyDisplay(undefined).colors.limit, "#c78bff");
});

test("limit wall preferences clamp finite bounds and independently default unknown or nonfinite fields", () => {
  for (const representation of ["plane", "wall", "both"] as const) {
    assert.deepEqual(normalizeRailSafetyDisplay({ limits: { representation, wallHeight: 12.5, wallOpacity: 0.6 } }).limits,
      { representation, wallHeight: 12.5, wallOpacity: 0.6 });
  }
  for (const [wallHeight, wallOpacity, height, opacity] of [
    [-1, -1, 0.5, 0], [0, 0, 0.5, 0], [0.5, 1, 0.5, 1], [100, 1, 100, 1], [1000, 5, 100, 1],
  ]) {
    assert.deepEqual(normalizeRailSafetyDisplay({ limits: { representation: "wall", wallHeight, wallOpacity } }).limits,
      { representation: "wall", wallHeight: height, wallOpacity: opacity });
  }
  for (const value of [NaN, Infinity, -Infinity, "5", null, undefined, {}, []]) {
    const settings = normalizeRailSafetyDisplay({ limits: { representation: "both", wallHeight: value, wallOpacity: value } });
    assert.deepEqual(settings.limits, { representation: "both", wallHeight: 5, wallOpacity: 0.22 });
  }
  for (const representation of ["unknown", "", false, 1, null, []]) {
    assert.deepEqual(normalizeRailSafetyDisplay({ limits: { representation, wallHeight: 10, wallOpacity: 0.8 } }).limits,
      { representation: "plane", wallHeight: 10, wallOpacity: 0.8 });
  }
  for (const limits of [null, [], "legacy", false]) {
    assert.deepEqual(normalizeRailSafetyDisplay({ limits }).limits, DEFAULT_RAIL_SAFETY_DISPLAY.limits);
  }
});

test("display preferences survive reload only in their project and actor scope, including delimiter-like identifiers", () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  const first = normalizeRailSafetyDisplay({ colors: { responsibility: "#123456", workArea: "#ABCDEF", limit: "#010203", envelope: "#112233", risk: "#000000", support: "#ffffff" }, limits: { representation: "both", wallHeight: 12.5, wallOpacity: 0.6 }, guards: { surface: "absolute", opacity: 0.63 }, personnel: { scale: 2.1, heading: 135 } });
  const second = normalizeRailSafetyDisplay({ colors: { responsibility: "#fedcba", envelope: "#987654" }, limits: { representation: "wall", wallHeight: 0.5, wallOpacity: 0 }, envelopes: { style: "outline" } });
  assert.equal(writeRailSafetyDisplay("project:a", "actor", first, storage), true);
  assert.equal(writeRailSafetyDisplay("project", "a:actor", second, storage), true);
  assert.deepEqual(readRailSafetyDisplay("project:a", "actor", storage), first);
  assert.deepEqual(readRailSafetyDisplay("project", "a:actor", storage), second);
  assert.deepEqual(readRailSafetyDisplay("project:a", "other", storage), DEFAULT_RAIL_SAFETY_DISPLAY);
  assert.deepEqual(readRailSafetyDisplay("project:a", undefined, storage), DEFAULT_RAIL_SAFETY_DISPLAY);
  assert.deepEqual(readRailSafetyDisplay("other", "actor", storage), DEFAULT_RAIL_SAFETY_DISPLAY);
});

test("existing v1 browser preferences acquire default limits and colours while preserving all other settings", () => {
  const old = {
    guards: { surface: "absolute", style: "outline", opacity: 0.8, lineWidth: 7 },
    envelopes: { surface: "terrain", style: "outline", opacity: 0.3, lineWidth: 5 },
    personnel: { representation: "point", scale: 2.3, heading: 127 },
  };
  const key = 'rail-safety-display:v1:["project","actor"]';
  const entries = new Map([[key, JSON.stringify(old)]]);
  const storage = { getItem: (name: string) => entries.get(name) ?? null, setItem: (name: string, value: string) => { entries.set(name, value); } };
  const restored = readRailSafetyDisplay("project", "actor", storage);
  assert.deepEqual(restored, { ...old, envelopes: { ...old.envelopes, representation: "pose" }, effects: DEFAULT_RAIL_SAFETY_DISPLAY.effects, limits: DEFAULT_RAIL_SAFETY_DISPLAY.limits, colors: DEFAULT_RAIL_SAFETY_DISPLAY.colors });
  assert.deepEqual(JSON.parse(entries.get(key)!), old, "reading old settings does not rewrite browser storage");
  restored.limits = { representation: "both", wallHeight: 20, wallOpacity: 0.45 };
  assert.equal(writeRailSafetyDisplay("project", "actor", restored, storage), true);
  assert.deepEqual(readRailSafetyDisplay("project", "actor", storage), restored);
  assert.equal(entries.size, 1, "wall settings continue using the existing project/actor preference key");
});

test("range colours accept only six-digit hex values and default invalid entries independently", () => {
  const colors = normalizeRailSafetyDisplay({ colors: {
    responsibility: "#000000", workArea: "#FfFfFf", limit: "#aBcD09",
    envelope: "#123456", risk: "#fedcba", support: "#0011aa",
  } }).colors;
  assert.deepEqual(colors, {
    responsibility: "#000000", workArea: "#ffffff", limit: "#abcd09",
    envelope: "#123456", risk: "#fedcba", support: "#0011aa",
  });
  for (const invalid of [null, undefined, 0, false, {}, [], "", "red", "#fff", "#12345678", "123456", "#gg1122", " #123456", "#123456 ", "#123456\n", "rgb(1,2,3)", "var(--color)"]) {
    for (const key of Object.keys(DEFAULT_RAIL_SAFETY_DISPLAY.colors)) {
      const normalized = normalizeRailSafetyDisplay({ colors: { ...colors, [key]: invalid } }).colors;
      assert.deepEqual(normalized, { ...colors, [key]: DEFAULT_RAIL_SAFETY_DISPLAY.colors[key as keyof typeof colors] }, `invalid ${key} only resets itself`);
    }
  }
  for (const invalid of [null, [], "#123456", false]) {
    assert.deepEqual(normalizeRailSafetyDisplay({ colors: invalid }).colors, DEFAULT_RAIL_SAFETY_DISPLAY.colors);
  }
});

test("wall-era v1 preferences migrate colours without rewriting stored visual settings", () => {
  const previous = {
    limits: { representation: "both", wallHeight: 8, wallOpacity: 0.35 },
    guards: { surface: "terrain", style: "outline", opacity: 0.5, lineWidth: 5 },
    envelopes: { surface: "absolute", style: "fill", opacity: 0.6, lineWidth: 6 },
    personnel: { representation: "model", scale: 1.5, heading: 90 },
  };
  const key = 'rail-safety-display:v1:["p","a"]';
  const entries = new Map([[key, JSON.stringify(previous)]]);
  const storage = { getItem: (name: string) => entries.get(name) ?? null, setItem: (name: string, value: string) => { entries.set(name, value); } };
  const migrated = readRailSafetyDisplay("p", "a", storage);
  assert.deepEqual(migrated, { ...previous, envelopes: { ...previous.envelopes, representation: "pose" }, effects: DEFAULT_RAIL_SAFETY_DISPLAY.effects, colors: DEFAULT_RAIL_SAFETY_DISPLAY.colors });
  assert.deepEqual(JSON.parse(entries.get(key)!), previous);
  migrated.colors.limit = "#abcdef";
  assert.equal(writeRailSafetyDisplay("p", "a", migrated, storage), true);
  assert.deepEqual(readRailSafetyDisplay("p", "a", storage), migrated);
  assert.equal(entries.size, 1, "colour settings use the existing project/actor preference key");
});

test("envelope representation accepts the three display modes and defaults legacy or invalid values to pose", () => {
  for (const representation of ["overview", "pose", "both"] as const) {
    const normalized = normalizeRailSafetyDisplay({
      envelopes: { representation, surface: "absolute", style: "outline", opacity: 0.8, lineWidth: 7 },
      guards: { representation, surface: "terrain", style: "fill", opacity: 0.4, lineWidth: 2 },
    });
    assert.deepEqual(normalized.envelopes, { representation, surface: "absolute", style: "outline", opacity: 0.8, lineWidth: 7 });
    assert.deepEqual(normalized.guards, { surface: "terrain", style: "fill", opacity: 0.4, lineWidth: 2 }, "the angle display mode belongs only to machinery envelopes");
  }
  for (const representation of [undefined, null, false, 0, [], {}, "", "wall", "POSE"]) {
    assert.deepEqual(normalizeRailSafetyDisplay({ envelopes: { representation, surface: "terrain", opacity: 0.3 } }).envelopes,
      { ...DEFAULT_RAIL_SAFETY_DISPLAY.envelopes, surface: "terrain", opacity: 0.3, representation: "pose" });
  }
});

test("envelope representation survives project and actor scoped storage without changing other visual preferences", () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  for (const representation of ["overview", "pose", "both"] as const) {
    const settings = normalizeRailSafetyDisplay({
      envelopes: { representation, surface: "terrain", style: "outline", opacity: 0.34, lineWidth: 5 },
      colors: { envelope: "#abcdef" }, limits: { representation: "both", wallHeight: 8, wallOpacity: 0.35 },
    });
    assert.equal(writeRailSafetyDisplay("project", representation, settings, storage), true);
    assert.deepEqual(readRailSafetyDisplay("project", representation, storage), settings);
    assert.deepEqual(readRailSafetyDisplay("other", representation, storage), DEFAULT_RAIL_SAFETY_DISPLAY);
  }
  assert.equal(entries.size, 3);
  assert.equal(readRailSafetyDisplay("project", "overview", storage).envelopes.representation, "overview");
  assert.equal(readRailSafetyDisplay("project", "both", storage).envelopes.representation, "both");
});

test("broken JSON and unavailable browser storage cannot prevent visual settings from working", () => {
  assert.deepEqual(readRailSafetyDisplay("project", "actor", { getItem: () => "{" }), DEFAULT_RAIL_SAFETY_DISPLAY);
  const unavailable = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(readRailSafetyDisplay("project", "actor", unavailable), DEFAULT_RAIL_SAFETY_DISPLAY);
  assert.equal(writeRailSafetyDisplay("project", "actor", DEFAULT_RAIL_SAFETY_DISPLAY, unavailable), false);
  assert.equal(writeRailSafetyDisplay("", "actor", DEFAULT_RAIL_SAFETY_DISPLAY, unavailable), false);
});


test("range effects migrate as static per category and independently validate mode, speed and intensity", () => {
  const previous = normalizeRailSafetyDisplay({ colors: { responsibility: "#112233" }, guards: { opacity: 0.7 } });
  assert.deepEqual(previous.effects, DEFAULT_RAIL_SAFETY_DISPLAY.effects);
  const effects = normalizeRailSafetyDisplay({ effects: {
    responsibility: { mode: "breathe", speed: 2.5, intensity: 0.8 },
    workArea: { mode: "flow", speed: -2, intensity: 5 },
    limit: { mode: "unknown", speed: Infinity, intensity: "0.2" },
    envelope: { mode: "flow", speed: 30, intensity: -2 },
    risk: null,
  } }).effects;
  assert.deepEqual(effects.responsibility, { mode: "breathe", speed: 2.5, intensity: 0.8 });
  assert.deepEqual(effects.workArea, { mode: "flow", speed: 0.25, intensity: 1 });
  assert.deepEqual(effects.limit, { mode: "static", speed: 1, intensity: 0.55 });
  assert.deepEqual(effects.envelope, { mode: "flow", speed: 3, intensity: 0 });
  assert.deepEqual(effects.risk, DEFAULT_RAIL_SAFETY_DISPLAY.effects.risk);
  effects.risk.mode = "flow";
  assert.equal(DEFAULT_RAIL_SAFETY_DISPLAY.effects.risk.mode, "static");
});

test("effect preferences persist in the existing actor and project scope without altering colours or geometry preferences", () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  const settings = normalizeRailSafetyDisplay({ effects: { envelope: { mode: "flow", speed: 1.75, intensity: 0.25 } }, colors: { envelope: "#123456" }, envelopes: { representation: "both" } });
  writeRailSafetyDisplay("project", "actor", settings, storage);
  assert.deepEqual(readRailSafetyDisplay("project", "actor", storage), settings);
  assert.deepEqual(readRailSafetyDisplay("project", "different", storage).effects, DEFAULT_RAIL_SAFETY_DISPLAY.effects);
  assert.deepEqual([...entries.keys()], ['rail-safety-display:v1:["project","actor"]']);
});
