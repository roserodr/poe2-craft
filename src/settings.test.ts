import { describe, it, expect } from "vitest";
import { encodeSettings, decodeSettings, SETTINGS_VERSION, type SimSettings } from "./settings";

const SAMPLE: SimSettings = {
  v: SETTINGS_VERSION,
  classKey: "amulet",
  baseName: "Stellar Amulet",
  ilvl: 81,
  startRarity: "Rare",
  startMods: "fractured All Attributes t1\n+1 to Level of all Skills",
  script: 'alchemy\nwhile not has "spirit" {\n  chaos\n}',
  target: 'has "all elemental resistances"',
  seed: 424242,
  batchRuns: 5000,
  stopMode: "cost",
  stopValue: 100,
  baseAmount: 2.5,
  baseUnit: "div",
};

describe("sim settings round-trip", () => {
  it("encodes and decodes back to the same settings", () => {
    const code = encodeSettings(SAMPLE);
    expect(typeof code).toBe("string");
    expect(decodeSettings(code)).toEqual(SAMPLE);
  });

  it("preserves multi-line scripts and unicode", () => {
    const s = { ...SAMPLE, script: "chaos # ✓ café —\nexalt" };
    expect(decodeSettings(encodeSettings(s)).script).toBe(s.script);
  });

  it("rejects an unknown item class", () => {
    const code = encodeSettings({ ...SAMPLE, classKey: "nonexistent-class" });
    expect(() => decodeSettings(code)).toThrow(/unknown item class/);
  });

  it("throws on malformed (non-base64 / non-JSON) input", () => {
    expect(() => decodeSettings("!!!not valid!!!")).toThrow();
  });

  it("fills defaults for missing optional fields", () => {
    // a minimal object with only a valid class still decodes
    const code = encodeSettings({ classKey: "bow" } as SimSettings);
    const out = decodeSettings(code);
    expect(out.classKey).toBe("bow");
    expect(out.stopMode).toBe("none");
    expect(out.baseUnit).toBe("ex");
  });
});
