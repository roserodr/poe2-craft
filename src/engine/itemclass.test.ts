import { describe, it, expect, afterAll } from "vitest";
import {
  ITEM_CLASSES,
  setItemClass,
  ALL_BASES,
  ALL_MODS,
  ESSENCES,
  resolveStartMod,
} from "./mods";
import { newItem, CURRENCY, totalAffixes, usedGroups } from "./item";
import { RNG } from "./rng";

// This file mutates the active item class; reset to bow when done.
afterAll(() => setItemClass("bow"));

describe("multi-class support", () => {
  it("registers bow, dex/int boots, amulet and ring", () => {
    expect(ITEM_CLASSES.map((c) => c.key)).toContain("bow");
    expect(ITEM_CLASSES.map((c) => c.key)).toContain("dexIntBoots");
    expect(ITEM_CLASSES.map((c) => c.key)).toContain("amulet");
    expect(ITEM_CLASSES.map((c) => c.key)).toContain("ring");
  });

  it('resolves boots "Movement Speed" by stat text (group is MovementVelocity)', () => {
    setItemClass("dexIntBoots");
    const def = resolveStartMod("Movement Speed", 82);
    expect(def).not.toBeNull();
    expect(def!.group).toBe("MovementVelocity");
    // the tier suffix still works
    expect(resolveStartMod("Movement Speed t1", 82)).not.toBeNull();
  });

  it("switches the active dataset to ring (jewellery) with real weights", () => {
    setItemClass("ring");
    expect(ALL_BASES.length).toBeGreaterThan(0);
    for (const b of ALL_BASES) {
      expect(b.aps).toBeUndefined();
      expect((b.armour ?? 0) + (b.evasion ?? 0) + (b.energyShield ?? 0)).toBe(0);
    }
    // bow/boots families are gone; real scraped weights present
    expect(ALL_MODS.some((m) => m.group === "LocalPhysicalDamage")).toBe(false);
    expect(Math.max(...ALL_MODS.map((m) => m.weight))).toBeGreaterThan(1);
    expect(ESSENCES.length).toBeGreaterThan(0);
  });

  it("switches the active dataset to amulet (jewellery)", () => {
    setItemClass("amulet");
    expect(ALL_BASES.length).toBeGreaterThan(0);
    // amulets are jewellery: no weapon or armour base stats, but have implicits
    for (const b of ALL_BASES) {
      expect(b.aps).toBeUndefined();
      expect((b.armour ?? 0) + (b.evasion ?? 0) + (b.energyShield ?? 0)).toBe(0);
    }
    // amulet-only mod families are present; bow/boots families are gone
    expect(ALL_MODS.some((m) => m.group === "BaseSpirit")).toBe(true);
    expect(ALL_MODS.some((m) => m.group === "LocalPhysicalDamage")).toBe(false);
    expect(ALL_MODS.some((m) => m.group === "MovementVelocity")).toBe(false);
    // real scraped weights (not the uniform placeholder)
    expect(Math.max(...ALL_MODS.map((m) => m.weight))).toBeGreaterThan(1);
    expect(ESSENCES.length).toBeGreaterThan(0);
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
