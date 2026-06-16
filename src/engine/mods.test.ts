import { describe, it, expect } from "vitest";
import {
  ALL_MODS,
  ALL_BASES,
  ESSENCES,
  DESECRATED_MODS,
  modRanges,
  rollMod,
  renderMod,
  modTier,
  groupLabel,
  AFFIX_NAMES,
} from "./mods";
import { RNG } from "./rng";
import type { ModDef } from "./types";

describe("data integrity", () => {
  it("loads bow bases and mods", () => {
    expect(ALL_BASES.length).toBeGreaterThan(0);
    expect(ALL_MODS.length).toBeGreaterThan(0);
  });

  it("every mod has positive weight and a valid type", () => {
    for (const m of ALL_MODS) {
      expect(m.weight).toBeGreaterThan(0);
      expect(["Prefix", "Suffix"]).toContain(m.type);
      expect(m.lines.length).toBeGreaterThan(0);
    }
  });

  it("essences resolve to a real mod with lines", () => {
    expect(ESSENCES.length).toBeGreaterThan(0);
    for (const e of ESSENCES) {
      expect(e.mod.lines.length).toBeGreaterThan(0);
      expect(["Prefix", "Suffix"]).toContain(e.mod.type);
    }
  });

  it("desecrated mods are flagged", () => {
    for (const m of DESECRATED_MODS) expect(m.desecrated).toBe(true);
  });
});

describe("modRanges / rollMod / renderMod", () => {
  const phys = ALL_MODS.find((m) => m.group === "LocalPhysicalDamage")!;

  it("extracts ranges from placeholder text", () => {
    const ranges = modRanges(phys);
    expect(ranges.length).toBeGreaterThan(0);
    for (const r of ranges) expect(r.hi).toBeGreaterThanOrEqual(r.lo);
  });

  it("rolls one value per range, within bounds", () => {
    const rng = new RNG(5);
    const ranges = modRanges(phys);
    for (let i = 0; i < 100; i++) {
      const rolled = rollMod(phys, rng);
      expect(rolled.values.length).toBe(ranges.length);
      rolled.values.forEach((v, idx) => {
        expect(v).toBeGreaterThanOrEqual(ranges[idx].lo);
        expect(v).toBeLessThanOrEqual(ranges[idx].hi);
      });
    }
  });

  it("renders values back into the text with no placeholders left", () => {
    const rolled = rollMod(phys, new RNG(1));
    const lines = renderMod(rolled);
    for (const line of lines) expect(line).not.toMatch(/\([\d.]+-[\d.]+\)/);
  });

  it("renders a fixed value for a flat mod", () => {
    const fixed: ModDef = {
      id: "x",
      type: "Prefix",
      affix: "Test",
      group: "X",
      level: 1,
      weight: 1,
      lines: ["Adds (5-5) to (10-10) Fire Damage"],
      tags: [],
    };
    expect(renderMod(rollMod(fixed, new RNG(1)))[0]).toBe("Adds 5 to 10 Fire Damage");
  });
});

describe("groupLabel", () => {
  it("turns group ids into readable affix names", () => {
    expect(groupLabel("LocalAccuracyRating")).toBe("Accuracy Rating");
    expect(groupLabel("LocalPhysicalDamagePercent")).toBe("Physical Damage Percent");
    expect(groupLabel("IncreasedWeaponElementalDamagePercent")).toBe(
      "Increased Weapon Elemental Damage Percent"
    );
  });

  it("produces a unique label for every bow group", () => {
    const groups = [...new Set(ALL_MODS.map((m) => m.group))];
    const labels = new Set(groups.map(groupLabel));
    expect(labels.size).toBe(groups.length);
  });

  it("AFFIX_NAMES contains readable labels and raw ids (lowercased)", () => {
    expect(AFFIX_NAMES.has("physical damage percent")).toBe(true);
    expect(AFFIX_NAMES.has("localphysicaldamagepercent")).toBe(true);
    expect(AFFIX_NAMES.has("physical")).toBe(false);
  });
});

describe("modTier", () => {
  it("ranks the highest-level mod in a group as T1", () => {
    const group = ALL_MODS.filter((m) => m.group === "LocalPhysicalDamage");
    const highest = group.reduce((a, b) => (b.level > a.level ? b : a));
    const { tier, count } = modTier(highest);
    expect(tier).toBe(1);
    expect(count).toBe(group.length);
  });
});
