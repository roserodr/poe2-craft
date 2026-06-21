import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  buildStartItem,
  resolveCatalyst,
} from "./item";
import {
  ALL_BASES,
  ALL_MODS,
  ESSENCES,
  DESECRATED_MODS,
  groupLabel,
  resolveStartMod,
  setItemClass,
  renderMod,
} from "./mods";
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

  it("reveal turns an unrevealed affix into a concrete mod", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    const concreteBefore = it.prefixes.length + it.suffixes.length;
    CURRENCY.desecrate.apply(it, new RNG(1));
    const r = CURRENCY.reveal.apply(it, new RNG(2));
    expect(r.applied).toBe(true);
    expect(it.unrevealed).toBe(0);
    // a concrete mod was added (regular or Abyssal — the Well offers a mix)
    expect(it.prefixes.length + it.suffixes.length).toBe(concreteBefore + 1);
  });

  it("reveal can produce an Abyssal (desecrated) mod and flags it", () => {
    let sawDesecrated = false;
    for (let seed = 0; seed < 500 && !sawDesecrated; seed++) {
      const it = fresh();
      it.rarity = "Rare";
      it.unrevealed = 1;
      CURRENCY.reveal.apply(it, new RNG(seed));
      if ([...it.prefixes, ...it.suffixes].some((m) => m.desecrated)) sawDesecrated = true;
    }
    expect(sawDesecrated).toBe(true);
  });

  it("reveal fails with nothing to reveal", () => {
    const it = fresh();
    CURRENCY.alchemy.apply(it, new RNG(1));
    expect(CURRENCY.reveal.apply(it, new RNG(1)).applied).toBe(false);
  });

  it("Omen of Light removes a NORMAL modifier obtained from desecration", () => {
    // The Well of Souls reveals a mix of regular and Abyssal mods; ALL of them are
    // desecration-obtained, so Omen of Light must be able to remove a *regular* one
    // (otherwise desecrate→reveal→light loops deadlock).
    let it = fresh();
    let revealed = it.prefixes[0];
    for (let seed = 0; seed < 300; seed++) {
      it = fresh();
      it.rarity = "Rare";
      it.unrevealed = 1;
      CURRENCY.reveal.apply(it, new RNG(seed));
      revealed = [...it.prefixes, ...it.suffixes][0];
      if (revealed && !DESECRATED_MODS.includes(revealed.def)) break; // a regular-pool mod
    }
    expect(DESECRATED_MODS.includes(revealed.def)).toBe(false); // it's a normal mod
    expect(revealed.desecrated).toBe(true); // yet flagged as desecration-obtained
    // Omen of Light annul removes that desecration-obtained normal mod
    const r = CURRENCY.annul.apply(it, new RNG(1), undefined, [OMENS.light]);
    expect(r.applied).toBe(true);
    expect(it.prefixes.length + it.suffixes.length).toBe(0);
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

  it("whittling chaos removes the lowest-level modifier", () => {
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
    CURRENCY.chaos.apply(it, new RNG(3), undefined, omen("whittling"));
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

  it("necromancy forces the revealed mod into a slot", () => {
    for (let seed = 0; seed < 10; seed++) {
      const it = fresh();
      it.rarity = "Rare";
      it.unrevealed = 1;
      const r = CURRENCY.reveal.apply(it, new RNG(seed), undefined, omen("sinistral necromancy"));
      expect(r.applied).toBe(true);
      // a prefix was revealed (regular or desecrated), no suffix added
      expect(it.prefixes.length).toBe(1);
      expect(it.suffixes.length).toBe(0);
    }
  });

  it("omen of light annuls only a desecrated modifier", () => {
    const phys = ALL_MODS.find((m) => m.type === "Prefix")!;
    const it = fresh();
    it.rarity = "Rare";
    addSpecificMod(it, phys, new RNG(1)); // a regular prefix
    // a desecrated suffix
    addSpecificMod(it, DESECRATED_MODS[0], new RNG(2), { desecrated: true });
    const r = CURRENCY.annul.apply(it, new RNG(3), undefined, omen("light"));
    expect(r.applied).toBe(true);
    // the desecrated mod is gone, the regular one stays
    expect([...it.prefixes, ...it.suffixes].some((m) => m.desecrated)).toBe(false);
    expect(it.prefixes.some((m) => m.def.id === phys.id)).toBe(true);
    // with no desecrated mod present, omen of light annul does nothing
    expect(CURRENCY.annul.apply(it, new RNG(4), undefined, omen("light")).applied).toBe(false);
  });

  it("chaos with whittling removes the lowest-level modifier", () => {
    const high = ALL_MODS.filter((m) => m.type === "Prefix").reduce((a, b) => (b.level > a.level ? b : a));
    const low = ALL_MODS.filter((m) => m.type === "Suffix" && m.group !== high.group).reduce((a, b) =>
      b.level < a.level ? b : a
    );
    const it = newItem(BASE, 100);
    it.rarity = "Rare";
    addSpecificMod(it, high, new RNG(1)); // high-level prefix
    addSpecificMod(it, low, new RNG(2)); // low-level suffix
    const r = CURRENCY.chaos.apply(it, new RNG(3), undefined, omen("whittling"));
    expect(r.applied).toBe(true);
    // the low-level mod was removed (and a new one added); the high one stays
    expect([...it.prefixes, ...it.suffixes].some((m) => m.def.id === high.id)).toBe(true);
    expect([...it.prefixes, ...it.suffixes].some((m) => m.def.id === low.id)).toBe(false);
  });

  it('an "ancient" bone reveals only mods of level >= 40', () => {
    for (let seed = 0; seed < 40; seed++) {
      const it = newItem(BASE, 100);
      it.rarity = "Rare";
      CURRENCY.desecrate.apply(it, new RNG(seed), "ancient");
      expect(it.boneMinLevel).toBe(40);
      CURRENCY.reveal.apply(it, new RNG(seed));
      for (const m of [...it.prefixes, ...it.suffixes]) {
        expect(m.def.level).toBeGreaterThanOrEqual(40);
      }
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
});

describe("starting item (rarity + pre-applied mods)", () => {
  const prefixDef = ALL_MODS.find((m) => m.type === "Prefix")!;
  const suffixDef = ALL_MODS.find((m) => m.type === "Suffix")!;
  const prefixName = groupLabel(prefixDef.group);
  const suffixName = groupLabel(suffixDef.group);

  it("resolves an affix name to a mod in that group", () => {
    const def = resolveStartMod(prefixName, 82);
    expect(def).not.toBeNull();
    expect(def!.group).toBe(prefixDef.group);
  });

  it("resolves an explicit tier (t1 = best)", () => {
    const def = resolveStartMod(`${prefixName} t1`, 82);
    expect(def).not.toBeNull();
    // t1 is the highest-level tier in the group
    const maxLevel = Math.max(
      ...ALL_MODS.filter((m) => m.group === prefixDef.group).map((m) => m.level)
    );
    expect(def!.level).toBe(maxLevel);
  });

  it("resolves a mod by a substring of its stat text (not just the group label)", () => {
    const m = ALL_MODS.find((x) => /increased/i.test(x.lines.join(" ")))!;
    const phrase = m.lines[0]
      .toLowerCase()
      .replace(/\([^)]*\)%?/g, "") // strip numeric ranges like (20-30)%
      .replace(/^[^a-z]+/, "")
      .trim();
    const def = resolveStartMod(phrase, 100);
    expect(def).not.toBeNull();
    expect(def!.lines.join(" ").toLowerCase()).toContain(phrase);
  });

  it("returns null for an unknown name", () => {
    expect(resolveStartMod("not a real affix", 82)).toBeNull();
  });

  it("builds a Rare with the requested prefix + suffix", () => {
    const { item, errors } = buildStartItem(BASE, 82, "Rare", [prefixName, suffixName], new RNG(1));
    expect(errors).toEqual([]);
    expect(item.rarity).toBe("Rare");
    expect(item.prefixes.some((m) => m.def.group === prefixDef.group)).toBe(true);
    expect(item.suffixes.some((m) => m.def.group === suffixDef.group)).toBe(true);
    // a fully-formed mod with rolled values, usable by the rest of the engine
    expect(usedGroups(item).size).toBe(2);
  });

  it("locks a starting modifier marked `fractured`", () => {
    const { item, errors } = buildStartItem(
      BASE,
      82,
      "Rare",
      [`fractured ${prefixName}`, suffixName],
      new RNG(1)
    );
    expect(errors).toEqual([]);
    const frac = [...item.prefixes, ...item.suffixes].find((m) => m.def.group === prefixDef.group);
    expect(frac?.fractured).toBe(true);
    // the un-prefixed mod is not fractured
    const plain = [...item.prefixes, ...item.suffixes].find((m) => m.def.group === suffixDef.group);
    expect(plain?.fractured).toBeFalsy();
    expect(hasFractured(item)).toBe(true);
  });

  it("rejects modifiers on a Normal item", () => {
    const { item, errors } = buildStartItem(BASE, 82, "Normal", [prefixName], new RNG(1));
    expect(item.rarity).toBe("Normal");
    expect(totalAffixes(item)).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports unknown starting modifiers", () => {
    const { errors } = buildStartItem(BASE, 82, "Rare", ["bogus mod"], new RNG(1));
    expect(errors.some((e) => /unknown modifier/.test(e))).toBe(true);
  });

  it("enforces the affix cap for the rarity", () => {
    // Magic allows only 1 prefix; two prefixes -> second errors
    const twoPrefix = ALL_MODS.filter((m) => m.type === "Prefix");
    const a = groupLabel(twoPrefix[0].group);
    const b = groupLabel(twoPrefix.find((m) => m.group !== twoPrefix[0].group)!.group);
    const { item, errors } = buildStartItem(BASE, 82, "Magic", [a, b], new RNG(1));
    expect(item.prefixes.length).toBe(1);
    expect(errors.some((e) => /no room/.test(e))).toBe(true);
  });
});

describe("omen resolution", () => {
  it("resolves by currency + partial text", () => {
    expect(resolveOmen("exalt", "sinistral")?.key).toBe("sinistral exaltation");
    expect(resolveOmen("annul", "sinistral")?.key).toBe("sinistral annulment");
    expect(resolveOmen("exalt", "omen of greater exaltation")?.key).toBe("greater exaltation");
    // whittling applies to chaos only
    expect(resolveOmen("chaos", "whittling")?.key).toBe("whittling");
    expect(resolveOmen("annul", "whittling")).toBeNull(); // not annul
    expect(resolveOmen("exalt", "whittling")).toBeNull(); // not exalt
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

describe("catalysts (jewellery quality)", () => {
  const omen = (...keys: string[]) => keys.map((k) => OMENS[k]);
  beforeAll(() => setItemClass("amulet"));
  afterAll(() => setItemClass("bow"));

  const amulet = () => newItem(ALL_BASES[0], 82);

  it("resolves a catalyst by key, tag, or substring", () => {
    expect(resolveCatalyst("attribute")?.tag).toBe("attribute");
    expect(resolveCatalyst("defences")?.key).toBe("defence");
    expect(resolveCatalyst("attr")?.tag).toBe("attribute");
    expect(resolveCatalyst("nonsense")).toBeNull();
  });

  it("adds 5% quality per use up to 20% and records the tag", () => {
    const it = amulet();
    it.rarity = "Rare";
    CURRENCY.catalyst.apply(it, new RNG(1), "attribute");
    expect(it.quality).toBe(5);
    expect(it.qualityTag).toBe("attribute");
    for (let k = 0; k < 10; k++) CURRENCY.catalyst.apply(it, new RNG(1), "attribute");
    expect(it.quality).toBe(20); // capped
  });

  it("omen of catalysing applies the full 20% at once", () => {
    const it = amulet();
    it.rarity = "Rare";
    const r = CURRENCY.catalyst.apply(it, new RNG(1), "resistance", omen("catalysing"));
    expect(r.applied).toBe(true);
    expect(it.quality).toBe(20);
    expect(it.qualityTag).toBe("resistance");
  });

  it("a new catalyst type retypes the quality", () => {
    const it = amulet();
    it.rarity = "Rare";
    CURRENCY.catalyst.apply(it, new RNG(1), "attribute");
    CURRENCY.catalyst.apply(it, new RNG(1), "mana");
    expect(it.qualityTag).toBe("mana");
    expect(it.quality).toBe(10);
  });

  it("quality scales the values of matching-tag mods only", () => {
    const it = amulet();
    it.rarity = "Rare";
    // add a real attribute mod, then catalyse attributes to 20%
    const attrDef = ALL_MODS.find((m) => m.tags.includes("attribute"))!;
    addSpecificMod(it, attrDef, new RNG(2));
    const before = (it.prefixes[0] ?? it.suffixes[0]).values[0];
    CURRENCY.catalyst.apply(it, new RNG(1), "attribute");
    CURRENCY.catalyst.apply(it, new RNG(1), "attribute");
    CURRENCY.catalyst.apply(it, new RNG(1), "attribute");
    CURRENCY.catalyst.apply(it, new RNG(1), "attribute"); // 20%
    const mod = it.prefixes[0] ?? it.suffixes[0];
    const scaled = Number(renderMod(mod, 1 + it.quality / 100)[0].match(/\d+/)![0]);
    expect(scaled).toBe(Math.round(before * 1.2));
  });
});
