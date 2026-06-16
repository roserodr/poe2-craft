import { describe, it, expect, afterAll } from "vitest";
import {
  ITEM_CLASSES,
  setItemClass,
  ALL_BASES,
  ALL_MODS,
  ESSENCES,
} from "./mods";
import { newItem, CURRENCY, totalAffixes, usedGroups } from "./item";
import { RNG } from "./rng";

// This file mutates the active item class; reset to bow when done.
afterAll(() => setItemClass("bow"));

describe("multi-class support", () => {
  it("registers bow and dex/int boots", () => {
    expect(ITEM_CLASSES.map((c) => c.key)).toContain("bow");
    expect(ITEM_CLASSES.map((c) => c.key)).toContain("dexIntBoots");
  });

  it("switches the active dataset to dex/int boots", () => {
    setItemClass("dexIntBoots");
    expect(ALL_BASES.length).toBeGreaterThan(0);
    // boots are armour bases (evasion/ES), not weapons
    for (const b of ALL_BASES) {
      expect(b.aps).toBeUndefined();
      expect((b.evasion ?? 0) + (b.energyShield ?? 0)).toBeGreaterThan(0);
    }
    // movement speed is a boots-only mod family
    expect(ALL_MODS.some((m) => m.group === "MovementVelocity")).toBe(true);
    // bow-only mods are gone
    expect(ALL_MODS.some((m) => m.group === "LocalPhysicalDamage")).toBe(false);
    expect(ESSENCES.length).toBeGreaterThan(0);
  });

  it("crafts a boots item with the boots mod pool", () => {
    setItemClass("dexIntBoots");
    const it = newItem(ALL_BASES[ALL_BASES.length - 1], 82);
    CURRENCY.alchemy.apply(it, new RNG(1));
    expect(it.rarity).toBe("Rare");
    expect(totalAffixes(it)).toBe(4);
    const bootGroups = new Set(ALL_MODS.map((m) => m.group));
    for (const m of [...it.prefixes, ...it.suffixes]) {
      expect(bootGroups.has(m.def.group)).toBe(true);
    }
    // one mod per group still holds
    const groups = [...usedGroups(it)];
    expect(new Set(groups).size).toBe(groups.length);
  });

  it("switches back to bow", () => {
    setItemClass("bow");
    expect(ALL_MODS.some((m) => m.group === "LocalPhysicalDamage")).toBe(true);
    expect(ALL_BASES.some((b) => b.aps !== undefined)).toBe(true);
  });
});
