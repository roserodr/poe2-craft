import { describe, it, expect } from "vitest";
import {
  newItem,
  cloneItem,
  totalAffixes,
  addRandomMod,
  addRandomAny,
  usedGroups,
  CURRENCY,
  MIN_MOD_LEVEL,
  hasFractured,
  hasCraftedMod,
  addSpecificMod,
  OMENS,
  resolveOmen,
  baseCurrency,
} from "./item";
import { ALL_BASES, ALL_MODS, ESSENCES, DESECRATED_MODS } from "./mods";
import { RNG } from "./rng";
import type { Item } from "./types";

const BASE = ALL_BASES.find((b) => b.name === "Heavy Bow") ?? ALL_BASES[ALL_BASES.length - 1];

function fresh(ilvl = 82): Item {
  return newItem(BASE, ilvl);
}
/** Apply a currency by key with a fresh seed. */
function apply(it: Item, key: string, seed = 1, arg?: string) {
  return CURRENCY[key].apply(it, new RNG(seed), arg);
}

describe("currency: basic transitions", () => {
  it("transmute upgrades Normal -> Magic with one mod", () => {
    const it = fresh();
    const r = apply(it, "transmute");
    expect(r.applied).toBe(true);
    expect(it.rarity).toBe("Magic");
    expect(totalAffixes(it)).toBe(1);
  });

  it("transmute fails on a non-Normal item", () => {
    const it = fresh();
    apply(it, "transmute");
    expect(apply(it, "transmute").applied).toBe(false);
  });

  it("alchemy upgrades Normal -> Rare with four mods", () => {
    const it = fresh();
    apply(it, "alchemy");
    expect(it.rarity).toBe("Rare");
    expect(totalAffixes(it)).toBe(4);
  });

  it("regal upgrades Magic -> Rare", () => {
    const it = fresh();
    apply(it, "transmute");
    apply(it, "regal");
    expect(it.rarity).toBe("Rare");
    expect(totalAffixes(it)).toBe(2);
  });

  it("augment only works on Magic and respects the 2-mod cap", () => {
    const it = fresh();
    apply(it, "transmute");
    expect(apply(it, "augment").applied).toBe(true);
    expect(totalAffixes(it)).toBe(2);
    expect(apply(it, "augment").applied).toBe(false); // full
  });

  it("exalt adds a mod to a Rare and fails when full (6)", () => {
    const it = fresh();
    apply(it, "alchemy"); // 4 mods
    expect(apply(it, "exalt", 2).applied).toBe(true);
    expect(apply(it, "exalt", 3).applied).toBe(true); // 6
    expect(totalAffixes(it)).toBe(6);
    expect(apply(it, "exalt", 4).applied).toBe(false);
  });

  it("chaos keeps the mod count the same (remove + add)", () => {
    const it = fresh();
    apply(it, "alchemy");
    const before = totalAffixes(it);
    apply(it, "chaos", 9);
    expect(totalAffixes(it)).toBe(before);
  });

  it("annul removes exactly one mod", () => {
    const it = fresh();
    apply(it, "alchemy");
    const before = totalAffixes(it);
    apply(it, "annul", 3);
    expect(totalAffixes(it)).toBe(before - 1);
  });

  it("annul can remove an unrevealed desecrated affix", () => {
    const it = fresh();
    it.rarity = "Rare";
    it.unrevealed = 1; // only affix is the unrevealed one
    const r = apply(it, "annul");
    expect(r.applied).toBe(true);
    expect(it.unrevealed).toBe(0);
    expect(r.note).toMatch(/unrevealed/);
  });

  it("divine keeps the same mods but may change values", () => {
    const it = fresh();
    apply(it, "alchemy");
    const groupsBefore = [...usedGroups(it)].sort();
    apply(it, "divine", 5);
    const groupsAfter = [...usedGroups(it)].sort();
    expect(groupsAfter).toEqual(groupsBefore);
  });

  it("vaal corrupts the item", () => {
    const it = fresh();
    apply(it, "alchemy");
    apply(it, "vaal", 1);
    expect(it.corrupted).toBe(true);
    // nothing works on a corrupted item
    expect(apply(it, "chaos").applied).toBe(false);
  });
});

describe("invariants", () => {
  it("never exceeds 3 prefixes / 3 suffixes", () => {
    for (let seed = 0; seed < 50; seed++) {
      const it = fresh();
      const rng = new RNG(seed);
      CURRENCY.alchemy.apply(it, rng);
      for (let k = 0; k < 10; k++) CURRENCY.exalt.apply(it, rng);
      expect(it.prefixes.length).toBeLessThanOrEqual(3);
      expect(it.suffixes.length).toBeLessThanOrEqual(3);
    }
  });

  it("never has two mods from the same group", () => {
    for (let seed = 0; seed < 50; seed++) {
      const it = fresh();
      const rng = new RNG(seed);
      CURRENCY.alchemy.apply(it, rng);
      for (let k = 0; k < 6; k++) CURRENCY.exalt.apply(it, rng);
      const groups = [...it.prefixes, ...it.suffixes].map((m) => m.def.group);
      expect(new Set(groups).size).toBe(groups.length);
    }
  });

  it("only adds mods available at the item level", () => {
    const it = fresh(5); // very low ilvl
    const rng = new RNG(1);
    for (let k = 0; k < 20; k++) addRandomAny(it, rng);
    for (const m of [...it.prefixes, ...it.suffixes]) {
      expect(m.def.level).toBeLessThanOrEqual(5);
    }
  });
});

describe("greater / perfect tiered orbs", () => {
  it("addRandomMod respects the minimum mod level", () => {
    const it = fresh(100);
    const rng = new RNG(3);
    for (let k = 0; k < 6; k++) addRandomMod(it, "Prefix", rng, MIN_MOD_LEVEL.perfect);
    for (const m of it.prefixes) {
      expect(m.def.level).toBeGreaterThanOrEqual(MIN_MOD_LEVEL.perfect);
    }
  });

  it("perfect exalt only adds mods of level >= 50", () => {
    for (let seed = 0; seed < 20; seed++) {
      const it = fresh(100);
      const rng = new RNG(seed);
      CURRENCY.alchemy.apply(it, rng);
      // wipe then refill via perfect exalt for clean attribution
      it.prefixes = [];
      it.suffixes = [];
      for (let k = 0; k < 4; k++) CURRENCY.perfectExalt.apply(it, new RNG(seed * 7 + k));
      for (const m of [...it.prefixes, ...it.suffixes]) {
        expect(m.def.level).toBeGreaterThanOrEqual(50);
      }
    }
  });

  it("greater/perfect variants exist for each tierable orb", () => {
    for (const base of ["transmute", "augment", "regal", "chaos", "exalt"]) {
      const cap = base[0].toUpperCase() + base.slice(1);
      expect(CURRENCY["greater" + cap]).toBeDefined();
      expect(CURRENCY["perfect" + cap]).toBeDefined();
    }
  });
});

describe("fracturing", () => {
  function rareWith4(seed = 1): Item {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(seed));
    return it;
  }

  it("requires a Rare with 4+ mods", () => {
    const magic = fresh();
    CURRENCY.transmute.apply(magic, new RNG(1));
    expect(CURRENCY.fracture.apply(magic, new RNG(1)).applied).toBe(false);
  });

  it("locks one mod that then survives chaos and annul", () => {
    const it = rareWith4(2);
    expect(CURRENCY.fracture.apply(it, new RNG(2)).applied).toBe(true);
    expect(hasFractured(it)).toBe(true);
    const fracturedMod = [...it.prefixes, ...it.suffixes].find((m) => m.fractured)!;
    // hammer it with chaos/annul; the fractured mod must remain
    for (let k = 0; k < 30; k++) CURRENCY.chaos.apply(it, new RNG(k + 10));
    for (let k = 0; k < 5; k++) CURRENCY.annul.apply(it, new RNG(k + 100));
    const stillThere = [...it.prefixes, ...it.suffixes].some(
      (m) => m.fractured && m.def.id === fracturedMod.def.id
    );
    expect(stillThere).toBe(true);
  });

  it("blocks scour once a mod is fractured", () => {
    const it = rareWith4(3);
    CURRENCY.fracture.apply(it, new RNG(3));
    expect(CURRENCY.scour.apply(it, new RNG(1)).applied).toBe(false);
  });
});

describe("desecration", () => {
  it("desecrate adds an unrevealed affix (no concrete mod yet)", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1)); // 4 mods, room for 2 more
    const before = it.prefixes.length + it.suffixes.length;
    const r = CURRENCY.desecrate.apply(it, new RNG(1));
    expect(r.applied).toBe(true);
    expect(it.unrevealed).toBe(1);
    expect(it.prefixes.length + it.suffixes.length).toBe(before); // no concrete mod added
    expect(totalAffixes(it)).toBe(before + 1); // but it occupies a slot
  });

  it("a desecrated affix can't duplicate a normal affix of the same group", () => {
    const as = ALL_MODS.find((m) => m.group === "LocalIncreasedAttackSpeed")!;
    const desAS = DESECRATED_MODS.find((m) => m.group === "LocalIncreasedAttackSpeed")!;
    expect(desAS).toBeDefined(); // desecrated attack-speed shares the normal group
    const it = fresh();
    it.rarity = "Rare";
    addSpecificMod(it, as, new RNG(1)); // normal attack speed present
    // the desecrated attack-speed mod is blocked (same group)
    expect(addSpecificMod(it, desAS, new RNG(2), { desecrated: true })).toBe(false);
    expect(
      [...it.prefixes, ...it.suffixes].filter((m) => m.def.group === "LocalIncreasedAttackSpeed")
        .length
    ).toBe(1);
  });

  it("desecrate requires a Rare item", () => {
    const it = fresh();
    expect(CURRENCY.desecrate.apply(it, new RNG(1)).applied).toBe(false);
  });

  it("desecrate fails when all 6 slots are used", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    for (let k = 0; k < 2; k++) CURRENCY.exalt.apply(it, new RNG(k + 1)); // up to 6
    expect(totalAffixes(it)).toBe(6);
    expect(CURRENCY.desecrate.apply(it, new RNG(1)).applied).toBe(false);
  });

  it("reveal turns an unrevealed affix into a concrete desecrated mod", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    CURRENCY.desecrate.apply(it, new RNG(1));
    const r = CURRENCY.reveal.apply(it, new RNG(2));
    expect(r.applied).toBe(true);
    expect(it.unrevealed).toBe(0);
    expect([...it.prefixes, ...it.suffixes].some((m) => m.desecrated)).toBe(true);
  });

  it("reveal fails with nothing to reveal", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    expect(CURRENCY.reveal.apply(it, new RNG(1)).applied).toBe(false);
  });

  it("chaos can remove an unrevealed desecrated affix", () => {
    const it = fresh();
    it.rarity = "Rare";
    it.unrevealed = 1; // only affix is the unrevealed one
    const r = CURRENCY.chaos.apply(it, new RNG(1));
    expect(r.applied).toBe(true);
    expect(it.unrevealed).toBe(0); // the unrevealed affix was removed
    expect(it.prefixes.length + it.suffixes.length).toBe(1); // and a new mod added
    expect(r.note).toMatch(/unrevealed/);
  });

  it("fracture cannot target an unrevealed desecrated affix", () => {
    // 3 concrete mods + 1 unrevealed = 4 affixes -> fracture is allowed and
    // must land on one of the 3 concrete mods, never the unrevealed one.
    for (let seed = 0; seed < 20; seed++) {
      const it = fresh();
      it.rarity = "Rare";
      const rng = new RNG(seed);
      for (let k = 0; k < 3; k++) addRandomAny(it, rng); // 3 concrete
      it.unrevealed = 1; // 4 total
      expect(totalAffixes(it)).toBe(4);
      const res = CURRENCY.fracture.apply(it, new RNG(seed + 1));
      expect(res.applied).toBe(true);
      // exactly one concrete mod fractured, unrevealed untouched
      expect([...it.prefixes, ...it.suffixes].filter((m) => m.fractured).length).toBe(1);
      expect(it.unrevealed).toBe(1);
    }
  });
});

describe("essences", () => {
  const greater = ESSENCES.find((e) => e.rank === "Greater")!;
  const perfect = ESSENCES.find((e) => e.rank === "Perfect")!;

  it("non-perfect essence requires Magic and upgrades to Rare with its mod", () => {
    const it = fresh();
    // fails on Normal
    expect(CURRENCY.essence.apply(it, new RNG(1), greater.name).applied).toBe(false);
    CURRENCY.transmute.apply(it, new RNG(1));
    const r = CURRENCY.essence.apply(it, new RNG(1), greater.name);
    expect(r.applied).toBe(true);
    expect(it.rarity).toBe("Rare");
    expect(usedGroups(it).has(greater.mod.group)).toBe(true);
    expect(hasCraftedMod(it)).toBe(true);
  });

  it("perfect essence requires Rare and removes one mod while adding its own", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1)); // Rare, 4 mods
    const before = totalAffixes(it);
    const r = CURRENCY.essence.apply(it, new RNG(1), perfect.name);
    expect(r.applied).toBe(true);
    expect(totalAffixes(it)).toBe(before); // remove 1, add 1
    expect(hasCraftedMod(it)).toBe(true);
  });

  it("perfect essence can remove an unrevealed desecrated affix", () => {
    const it = fresh();
    it.rarity = "Rare";
    it.unrevealed = 1; // the only affix is the unrevealed one
    const r = CURRENCY.essence.apply(it, new RNG(1), perfect.name);
    expect(r.applied).toBe(true);
    expect(it.unrevealed).toBe(0); // removed the unrevealed affix
    expect(r.note).toMatch(/unrevealed/);
    expect(hasCraftedMod(it)).toBe(true); // and added the essence mod
  });

  it("perfect essence fails on a Magic item", () => {
    const it = fresh();
    CURRENCY.transmute.apply(it, new RNG(1));
    expect(CURRENCY.essence.apply(it, new RNG(1), perfect.name).applied).toBe(false);
  });

  it("only one crafted (essence) modifier is allowed", () => {
    const it = fresh();
    CURRENCY.transmute.apply(it, new RNG(1));
    CURRENCY.essence.apply(it, new RNG(1), greater.name); // now Rare with crafted mod
    const second = CURRENCY.essence.apply(it, new RNG(1), perfect.name);
    expect(second.applied).toBe(false);
    expect([...it.prefixes, ...it.suffixes].filter((m) => m.essence).length).toBe(1);
  });

  it("reports an unknown essence name", () => {
    const it = fresh();
    CURRENCY.transmute.apply(it, new RNG(1));
    expect(CURRENCY.essence.apply(it, new RNG(1), "nonsense").applied).toBe(false);
  });
});

describe("omens", () => {
  function rareWithRoom(seed = 1): Item {
    // Magic (1 mod) -> regal to Rare (2 mods): leaves room for both slots
    const it = fresh();
    CURRENCY.transmute.apply(it, new RNG(seed));
    CURRENCY.regal.apply(it, new RNG(seed + 1));
    return it;
  }

  const omen = (...keys: string[]) => keys.map((k) => OMENS[k]);

  it("sinistral exaltation adds a prefix; dextral adds a suffix", () => {
    const a = rareWithRoom(1);
    const pBefore = a.prefixes.length;
    CURRENCY.exalt.apply(a, new RNG(2), undefined, omen("sinistral exaltation"));
    expect(a.prefixes.length).toBe(pBefore + 1);

    const b = rareWithRoom(3);
    const sBefore = b.suffixes.length;
    CURRENCY.exalt.apply(b, new RNG(4), undefined, omen("dextral exaltation"));
    expect(b.suffixes.length).toBe(sBefore + 1);
  });

  it("greater exaltation adds two modifiers", () => {
    const it = rareWithRoom(5);
    const before = totalAffixes(it);
    const r = CURRENCY.exalt.apply(it, new RNG(6), undefined, omen("greater exaltation"));
    expect(r.applied).toBe(true);
    expect(totalAffixes(it)).toBe(before + 2);
  });

  it("combines greater + sinistral exaltation to add two prefixes", () => {
    const it = fresh();
    it.rarity = "Rare"; // empty prefixes, room for 2
    const r = CURRENCY.exalt.apply(
      it,
      new RNG(8),
      undefined,
      omen("greater exaltation", "sinistral exaltation")
    );
    expect(r.applied).toBe(true);
    expect(it.prefixes.length).toBe(2);
    expect(it.suffixes.length).toBe(0);
  });

  it("rejects conflicting omens (sinistral + dextral)", () => {
    const it = fresh();
    it.rarity = "Rare";
    const r = CURRENCY.exalt.apply(
      it,
      new RNG(10),
      undefined,
      omen("sinistral exaltation", "dextral exaltation")
    );
    expect(r.applied).toBe(false);
    expect(r.note).toMatch(/conflicting/);
  });

  it("sinistral/dextral erasure removes a prefix/suffix on chaos", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    const before = it.suffixes.length;
    CURRENCY.chaos.apply(it, new RNG(2), undefined, omen("dextral erasure"));
    // a suffix was removed and a new mod added back, so suffix count is <= before
    expect(it.suffixes.length).toBeLessThanOrEqual(before);
    expect(totalAffixes(it)).toBe(4);
  });

  it("whittling annul removes the lowest-level modifier", () => {
    const it = fresh();
    it.rarity = "Rare";
    // hand-place two known mods of different levels
    const lowMod = ALL_MODS.filter((m) => m.type === "Prefix").reduce((a, b) =>
      b.level < a.level ? b : a
    );
    const highMod = ALL_MODS.filter(
      (m) => m.type === "Suffix" && m.group !== lowMod.group
    ).reduce((a, b) => (b.level > a.level ? b : a));
    addSpecificMod(it, lowMod, new RNG(1));
    addSpecificMod(it, highMod, new RNG(2));
    CURRENCY.annul.apply(it, new RNG(3), undefined, omen("whittling"));
    // the lowest-level mod is gone, the higher remains
    expect([...it.prefixes, ...it.suffixes].some((m) => m.def.id === lowMod.id)).toBe(false);
    expect([...it.prefixes, ...it.suffixes].some((m) => m.def.id === highMod.id)).toBe(true);
  });

  it("crystallisation makes a Perfect essence remove the chosen slot", () => {
    const phys = ALL_MODS.find((m) => m.group === "LocalPhysicalDamage")!; // prefix
    const acc = ALL_MODS.find((m) => m.group === "LocalAccuracyRating")!; // prefix
    const crit = ALL_MODS.find((m) => m.group === "LocalBaseCriticalStrikeChance")!; // suffix
    const it = fresh();
    it.rarity = "Rare";
    addSpecificMod(it, phys, new RNG(1));
    addSpecificMod(it, acc, new RNG(2));
    addSpecificMod(it, crit, new RNG(3)); // 2 prefixes, 1 suffix
    const perfect = ESSENCES.find((e) => e.rank === "Perfect")!;
    const r = CURRENCY.essence.apply(it, new RNG(4), perfect.name, omen("dextral crystallisation"));
    expect(r.applied).toBe(true);
    // the suffix (crit) was removed; both prefixes remain
    expect(it.suffixes.some((m) => m.def.group === "LocalBaseCriticalStrikeChance")).toBe(false);
    expect(r.note).toMatch(/suffix/);
  });

  it("necromancy forces the revealed desecrated mod into a slot", () => {
    for (let seed = 0; seed < 10; seed++) {
      const it = fresh();
      it.rarity = "Rare";
      it.unrevealed = 1;
      const r = CURRENCY.reveal.apply(it, new RNG(seed), undefined, omen("sinistral necromancy"));
      expect(r.applied).toBe(true);
      // a prefix desecrated mod was revealed, no suffix added
      expect(it.prefixes.some((m) => m.desecrated)).toBe(true);
      expect(it.suffixes.length).toBe(0);
    }
  });

  it("abyssal echoes offers more reveal options", () => {
    const plain = fresh();
    plain.rarity = "Rare";
    plain.unrevealed = 1;
    expect(CURRENCY.reveal.apply(plain, new RNG(1)).note).toMatch(/from 3 options/);

    const echo = fresh();
    echo.rarity = "Rare";
    echo.unrevealed = 1;
    expect(
      CURRENCY.reveal.apply(echo, new RNG(1), undefined, omen("abyssal echoes")).note
    ).toMatch(/from 6 options/);
  });

  it("sinistral coronation regal adds a prefix and upgrades to Rare", () => {
    const it = fresh();
    CURRENCY.transmute.apply(it, new RNG(1)); // Magic, 1 mod
    const pBefore = it.prefixes.length;
    CURRENCY.regal.apply(it, new RNG(2), undefined, omen("sinistral coronation"));
    expect(it.rarity).toBe("Rare");
    expect(it.prefixes.length).toBe(pBefore + 1);
  });
});

describe("omen resolution", () => {
  it("resolves by currency + partial text", () => {
    expect(resolveOmen("exalt", "sinistral")?.key).toBe("sinistral exaltation");
    expect(resolveOmen("annul", "sinistral")?.key).toBe("sinistral annulment");
    expect(resolveOmen("exalt", "omen of greater exaltation")?.key).toBe("greater exaltation");
    expect(resolveOmen("chaos", "whittling")).toBeNull(); // wrong currency
  });

  it("baseCurrency strips tier prefixes", () => {
    expect(baseCurrency("perfectExalt")).toBe("exalt");
    expect(baseCurrency("greaterChaos")).toBe("chaos");
    expect(baseCurrency("annul")).toBe("annul");
  });
});

describe("corruption guard & cloneItem", () => {
  it("most currencies fail on a corrupted item", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    CURRENCY.vaal.apply(it, new RNG(1));
    for (const key of ["transmute", "exalt", "chaos", "annul", "divine", "fracture"]) {
      expect(CURRENCY[key].apply(cloneItem(it), new RNG(1)).applied).toBe(false);
    }
  });

  it("cloneItem produces an independent copy", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    const copy = cloneItem(it);
    CURRENCY.annul.apply(copy, new RNG(1));
    expect(totalAffixes(copy)).not.toBe(totalAffixes(it));
  });
});
