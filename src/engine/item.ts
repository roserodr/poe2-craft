import type { AffixType, BowBase, Item, ModDef, RolledMod, Rarity } from "./types";
import { ALL_MODS, DESECRATED_MODS, ESSENCES, rollMod, divineMod, resolveStartMod, activeClass } from "./mods";
import { RNG } from "./rng";

export const MAX_AFFIX: Record<string, number> = {
  Normal: 0,
  Magic: 1,
  Rare: 3,
};

export function newItem(base: BowBase, ilvl: number): Item {
  return {
    base,
    rarity: "Normal",
    ilvl,
    quality: 0,
    corrupted: false,
    prefixes: [],
    suffixes: [],
    unrevealed: 0,
  };
}

/**
 * Build a starting item at a given rarity with a set of pre-applied modifiers.
 * Each spec is an affix name (optionally with a `tN` tier — see resolveStartMod),
 * and may be prefixed with `fractured` to lock that modifier (e.g.
 * `fractured Movement Speed t1`). Returns the item plus any errors (unknown names,
 * duplicate groups, full slots, or mods on a Normal item) so the UI can surface
 * them. Mods are rolled with the provided RNG so the start is reproducible by seed.
 */
export function buildStartItem(
  base: BowBase,
  ilvl: number,
  rarity: Rarity,
  specs: string[],
  rng: RNG
): { item: Item; errors: string[] } {
  const item = newItem(base, ilvl);
  item.rarity = rarity;
  const errors: string[] = [];
  const wanted = specs.map((s) => s.trim()).filter(Boolean);
  if (rarity === "Normal" && wanted.length > 0) {
    errors.push("a Normal item can't have modifiers — choose Magic or Rare");
    return { item, errors };
  }
  for (const raw of wanted) {
    // optional leading `fractured` keyword locks the modifier
    const fractured = /^fractured\s+/i.test(raw);
    const spec = raw.replace(/^fractured\s+/i, "");
    const def = resolveStartMod(spec, ilvl);
    if (!def) {
      errors.push(`unknown modifier: "${spec}"`);
      continue;
    }
    if (usedGroups(item).has(def.group)) {
      errors.push(`"${spec}" duplicates another starting modifier's group`);
      continue;
    }
    if (!addSpecificMod(item, def, rng, { fractured })) {
      const slot = def.type === "Prefix" ? "prefix" : "suffix";
      errors.push(`no room for "${spec}" (too many ${slot}es for ${rarity})`);
    }
  }
  return { item, errors };
}

export function cloneItem(it: Item): Item {
  return {
    ...it,
    prefixes: it.prefixes.map((m) => ({ ...m, values: [...m.values] })),
    suffixes: it.suffixes.map((m) => ({ ...m, values: [...m.values] })),
  };
}

export function allMods(it: Item): RolledMod[] {
  return [...it.prefixes, ...it.suffixes];
}

export function usedGroups(it: Item): Set<string> {
  return new Set(allMods(it).map((m) => m.def.group));
}

/** Total affix slots in use, including unrevealed desecrated affixes. */
export function totalAffixes(it: Item): number {
  return it.prefixes.length + it.suffixes.length + it.unrevealed;
}
/** Max total affixes for the rarity (e.g. Rare = 6). */
function affixCap(it: Item): number {
  return MAX_AFFIX[it.rarity] * 2;
}
export function openPrefix(it: Item): boolean {
  return it.prefixes.length < MAX_AFFIX[it.rarity] && totalAffixes(it) < affixCap(it);
}
export function openSuffix(it: Item): boolean {
  return it.suffixes.length < MAX_AFFIX[it.rarity] && totalAffixes(it) < affixCap(it);
}
export function hasUnrevealed(it: Item): boolean {
  return it.unrevealed > 0;
}

/** Which affix slots can still take a mod, respecting per-rarity caps. */
function openSlots(it: Item): AffixType[] {
  const slots: AffixType[] = [];
  if (openPrefix(it)) slots.push("Prefix");
  if (openSuffix(it)) slots.push("Suffix");
  return slots;
}

/** Greater/Perfect orbs force the added modifier to be at least this mod level. */
export const MIN_MOD_LEVEL = { base: 0, greater: 35, perfect: 50 };

/** Add one random eligible mod into the given slot. `minLvl` is the floor a
 * Greater/Perfect orb imposes on the mod's required level. Returns true on success. */
export function addRandomMod(it: Item, slot: AffixType, rng: RNG, minLvl = 0): boolean {
  const used = usedGroups(it);
  const pool = ALL_MODS.filter(
    (m) =>
      m.type === slot &&
      m.level <= it.ilvl &&
      m.level >= minLvl &&
      m.weight > 0 &&
      !used.has(m.group)
  );
  if (pool.length === 0) return false;
  const idx = rng.weighted(pool.map((m) => m.weight));
  if (idx < 0) return false;
  const rolled = rollMod(pool[idx], rng);
  if (slot === "Prefix") it.prefixes.push(rolled);
  else it.suffixes.push(rolled);
  return true;
}

/** Add a random mod into any open slot (prefix or suffix), slot chosen by combined weight. */
export function addRandomAny(it: Item, rng: RNG, minLvl = 0): boolean {
  const slots = openSlots(it);
  if (slots.length === 0) return false;
  // Weight slot choice by the total available weight in each, mirroring real odds.
  const used = usedGroups(it);
  const poolFor = (slot: AffixType) =>
    ALL_MODS.filter(
      (m) =>
        m.type === slot &&
        m.level <= it.ilvl &&
        m.level >= minLvl &&
        m.weight > 0 &&
        !used.has(m.group)
    );
  const pools = slots.map(poolFor);
  const weights = pools.map((p) => p.reduce((s, m) => s + m.weight, 0));
  const si = rng.weighted(weights);
  if (si < 0) return false;
  return addRandomMod(it, slots[si], rng, minLvl);
}

/** Remove a random NON-fractured mod (fractured mods are locked). */
export function removeRandomMod(it: Item, rng: RNG): RolledMod | null {
  const removable: RolledMod[] = allMods(it).filter((m) => !m.fractured);
  if (removable.length === 0) return null;
  const target = removable[rng.int(0, removable.length - 1)];
  const pi = it.prefixes.indexOf(target);
  if (pi >= 0) return it.prefixes.splice(pi, 1)[0];
  const si = it.suffixes.indexOf(target);
  return it.suffixes.splice(si, 1)[0];
}

/** Remove a random affix, counting unrevealed desecrated affixes as targets
 * (Chaos can hit them; Fracturing can't). Fractured mods are never removed. */
export function removeRandomAffix(
  it: Item,
  rng: RNG
): { kind: "mod"; mod: RolledMod } | { kind: "unrevealed" } | null {
  const concrete = allMods(it).filter((m) => !m.fractured);
  const total = concrete.length + it.unrevealed;
  if (total === 0) return null;
  const i = rng.int(0, total - 1);
  if (i < concrete.length) {
    const target = concrete[i];
    const pi = it.prefixes.indexOf(target);
    if (pi >= 0) it.prefixes.splice(pi, 1);
    else it.suffixes.splice(it.suffixes.indexOf(target), 1);
    return { kind: "mod", mod: target };
  }
  it.unrevealed -= 1;
  return { kind: "unrevealed" };
}

/** Remove a random desecrated modifier (Omen of Light). Fractured never removed. */
export function removeRandomDesecrated(it: Item, rng: RNG): RolledMod | null {
  const removable = allMods(it).filter((m) => m.desecrated && !m.fractured);
  if (removable.length === 0) return null;
  const target = removable[rng.int(0, removable.length - 1)];
  const pi = it.prefixes.indexOf(target);
  if (pi >= 0) return it.prefixes.splice(pi, 1)[0];
  return it.suffixes.splice(it.suffixes.indexOf(target), 1)[0];
}

/** Remove a random NON-fractured mod of a specific slot type. */
export function removeRandomModOfType(it: Item, slot: AffixType, rng: RNG): RolledMod | null {
  const arr = slot === "Prefix" ? it.prefixes : it.suffixes;
  const removable = arr.filter((m) => !m.fractured);
  if (removable.length === 0) return null;
  const target = removable[rng.int(0, removable.length - 1)];
  arr.splice(arr.indexOf(target), 1);
  return target;
}

/** Roll and place a specific mod into its slot, applying flags. Returns false if no room. */
export function addSpecificMod(
  it: Item,
  def: ModDef,
  rng: RNG,
  flags: Partial<Pick<RolledMod, "fractured" | "desecrated" | "essence">> = {}
): boolean {
  const slot = def.type;
  if (slot === "Prefix" ? !openPrefix(it) : !openSuffix(it)) return false;
  if (usedGroups(it).has(def.group)) return false;
  const rolled = { ...rollMod(def, rng), ...flags };
  if (slot === "Prefix") it.prefixes.push(rolled);
  else it.suffixes.push(rolled);
  return true;
}

export function hasFractured(it: Item): boolean {
  return allMods(it).some((m) => m.fractured);
}

/** An item may carry only one "crafted" (essence-granted) modifier. */
export function hasCraftedMod(it: Item): boolean {
  return allMods(it).some((m) => m.essence);
}

/** Remove the lowest required-level non-fractured concrete mod (Omen of Whittling).
 * Optionally restrict to a single slot. */
export function removeLowestMod(it: Item, rng: RNG, slot?: AffixType): RolledMod | null {
  const pool = slot ? (slot === "Prefix" ? it.prefixes : it.suffixes) : allMods(it);
  const candidates = pool.filter((m) => !m.fractured);
  if (candidates.length === 0) return null;
  const minLevel = Math.min(...candidates.map((m) => m.def.level));
  const lowest = candidates.filter((m) => m.def.level === minLevel);
  const target = lowest[rng.int(0, lowest.length - 1)];
  const pi = it.prefixes.indexOf(target);
  if (pi >= 0) it.prefixes.splice(pi, 1);
  else it.suffixes.splice(it.suffixes.indexOf(target), 1);
  return target;
}

// ---- Omens: each modifies the next use of a specific currency ----
export interface Omen {
  key: string; // canonical, lowercase, no "omen of"
  label: string;
  currency: string | string[]; // base currency(ies) it modifies: exalt|chaos|annul|regal
  desc: string;
}

export const OMENS: Record<string, Omen> = {
  "sinistral exaltation": { key: "sinistral exaltation", label: "Omen of Sinistral Exaltation", currency: "exalt", desc: "Exalted Orb adds a prefix" },
  "dextral exaltation": { key: "dextral exaltation", label: "Omen of Dextral Exaltation", currency: "exalt", desc: "Exalted Orb adds a suffix" },
  "greater exaltation": { key: "greater exaltation", label: "Omen of Greater Exaltation", currency: "exalt", desc: "Exalted Orb adds two modifiers" },
  "sinistral erasure": { key: "sinistral erasure", label: "Omen of Sinistral Erasure", currency: "chaos", desc: "Chaos Orb removes a prefix" },
  "dextral erasure": { key: "dextral erasure", label: "Omen of Dextral Erasure", currency: "chaos", desc: "Chaos Orb removes a suffix" },
  "sinistral annulment": { key: "sinistral annulment", label: "Omen of Sinistral Annulment", currency: "annul", desc: "Annulment removes a prefix" },
  "dextral annulment": { key: "dextral annulment", label: "Omen of Dextral Annulment", currency: "annul", desc: "Annulment removes a suffix" },
  whittling: { key: "whittling", label: "Omen of Whittling", currency: "chaos", desc: "Chaos Orb removes the lowest-level modifier" },
  light: { key: "light", label: "Omen of Light", currency: "annul", desc: "Annulment removes only a desecrated modifier" },
  "sinistral crystallisation": { key: "sinistral crystallisation", label: "Omen of Sinistral Crystallisation", currency: "essence", desc: "Perfect Essence removes a prefix" },
  "dextral crystallisation": { key: "dextral crystallisation", label: "Omen of Dextral Crystallisation", currency: "essence", desc: "Perfect Essence removes a suffix" },
  "sinistral necromancy": { key: "sinistral necromancy", label: "Omen of Sinistral Necromancy", currency: "reveal", desc: "Revealed desecrated modifier is a prefix" },
  "dextral necromancy": { key: "dextral necromancy", label: "Omen of Dextral Necromancy", currency: "reveal", desc: "Revealed desecrated modifier is a suffix" },
  "abyssal echoes": { key: "abyssal echoes", label: "Omen of Abyssal Echoes", currency: "reveal", desc: "Reveal offers additional modifier options" },
  catalysing: { key: "catalysing", label: "Omen of Catalysing", currency: "catalyst", desc: "Catalyst applies the maximum quality at once" },
};

// ---- catalysts (jewellery quality that boosts a modifier type) ----
const CATALYST_STEP = 5; // quality added per catalyst use
const CATALYST_MAX = 20; // quality cap on jewellery

export const CATALYSTS: Record<string, { label: string; tag: string }> = {
  attribute: { label: "Attribute Catalyst", tag: "attribute" },
  resistance: { label: "Resistance Catalyst", tag: "resistance" },
  elemental: { label: "Elemental Catalyst", tag: "elemental_damage" },
  physical: { label: "Physical Catalyst", tag: "physical" },
  caster: { label: "Caster Catalyst", tag: "caster" },
  attack: { label: "Attack Catalyst", tag: "attack" },
  life: { label: "Life Catalyst", tag: "life" },
  mana: { label: "Mana Catalyst", tag: "mana" },
  defence: { label: "Defence Catalyst", tag: "defences" },
  critical: { label: "Critical Catalyst", tag: "critical" },
  chaos: { label: "Chaos Catalyst", tag: "chaos" },
  speed: { label: "Speed Catalyst", tag: "speed" },
};

/** Resolve a catalyst arg (dsl key, tag, or substring) to its definition. */
export function resolveCatalyst(raw: string): { key: string; label: string; tag: string } | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  for (const [key, v] of Object.entries(CATALYSTS)) {
    if (key === s || v.tag === s || key.includes(s)) return { key, ...v };
  }
  return null;
}

const REVEAL_OPTIONS = 3;
const REVEAL_OPTIONS_ECHOES = 6;

/** Base currency for a (possibly tiered) currency key, e.g. "perfectExalt" -> "exalt". */
export function baseCurrency(name: string): string {
  const m = name.match(/^(?:greater|perfect)([A-Z]\w*)$/);
  return m ? m[1][0].toLowerCase() + m[1].slice(1) : name;
}

/** Find the omen for a base currency matching the typed text (all words as substrings). */
export function resolveOmen(currencyBase: string, raw: string): Omen | null {
  const terms = raw
    .toLowerCase()
    .replace(/\bomen of\b/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return null;
  const matches = Object.values(OMENS).filter(
    (o) =>
      (Array.isArray(o.currency) ? o.currency.includes(currencyBase) : o.currency === currencyBase) &&
      terms.every((t) => o.key.includes(t))
  );
  return matches[0] ?? null;
}

export interface CurrencyResult {
  applied: boolean;
  note: string;
}

/** Each currency operates in place on the item. Returns whether it did anything.
 * `arg` is an optional command argument (e.g. essence name); `omen` modifies behavior. */
export const CURRENCY: Record<
  string,
  {
    label: string;
    desc: string;
    takesArg?: boolean;
    apply: (
      it: Item,
      rng: RNG,
      arg?: string,
      omens?: Omen[],
      chooser?: (options: ModDef[], it: Item) => number,
    ) => CurrencyResult;
  }
> = {
  alchemy: {
    label: "Orb of Alchemy",
    desc: "Normal → Rare with four random modifiers",
    apply(it, rng) {
      if (it.corrupted) return fail("item is corrupted");
      if (it.rarity !== "Normal") return fail("requires a Normal item");
      it.rarity = "Rare";
      let added = 0;
      for (let k = 0; k < 4; k++) if (addRandomAny(it, rng)) added++;
      return ok(`upgraded to Rare with ${added} mods`);
    },
  },
  annul: {
    label: "Orb of Annulment",
    desc: "Remove a random modifier (can hit an unrevealed desecrated affix)",
    apply(it, rng, _arg, omens = []) {
      if (it.corrupted) return fail("item is corrupted");
      const e = omenEffects(omens);
      if ("error" in e) return fail(e.error);
      if (e.onlyDesecrated) {
        const r = removeRandomDesecrated(it, rng);
        return r ? ok(`removed desecrated "${r.def.affix}"`) : fail("no desecrated modifier to remove");
      }
      if (e.lowest) {
        const r = removeLowestMod(it, rng, e.removeSlot);
        return r
          ? ok(`removed lowest ${e.removeSlot ? e.removeSlot.toLowerCase() + " " : ""}"${r.def.affix}" (i${r.def.level})`)
          : fail("no mods to remove");
      }
      if (e.removeSlot) {
        const r = removeRandomModOfType(it, e.removeSlot, rng);
        return r
          ? ok(`removed ${e.removeSlot.toLowerCase()} "${r.def.affix}"`)
          : fail(`no ${e.removeSlot.toLowerCase()} to remove`);
      }
      const removed = removeRandomAffix(it, rng);
      if (!removed) return fail("no mods to remove");
      return ok(
        removed.kind === "mod"
          ? `removed "${removed.mod.def.affix}"`
          : "removed an unrevealed desecrated affix"
      );
    },
  },
  divine: {
    label: "Divine Orb",
    desc: "Re-roll the numeric values of all modifiers",
    apply(it, rng) {
      if (it.corrupted) return fail("item is corrupted");
      const mods = allMods(it);
      if (mods.length === 0) return fail("no mods to divine");
      it.prefixes = it.prefixes.map((m) => divineMod(m, rng));
      it.suffixes = it.suffixes.map((m) => divineMod(m, rng));
      return ok("re-rolled mod values");
    },
  },
  vaal: {
    label: "Vaal Orb",
    desc: "Corrupt the item (unpredictable outcome)",
    apply(it, rng) {
      if (it.corrupted) return fail("already corrupted");
      it.corrupted = true;
      const roll = rng.next();
      if (roll < 0.25) return ok("corrupted — no change");
      if (roll < 0.5) {
        const removed = removeRandomMod(it, rng);
        return ok(removed ? `corrupted — lost "${removed.def.affix}"` : "corrupted — no change");
      }
      if (roll < 0.75) {
        if (it.rarity === "Rare" && totalAffixes(it) < 6 && addRandomAny(it, rng))
          return ok("corrupted — gained a modifier");
        return ok("corrupted — no change");
      }
      it.prefixes = it.prefixes.map((m) => divineMod(m, rng));
      it.suffixes = it.suffixes.map((m) => divineMod(m, rng));
      return ok("corrupted — re-rolled values");
    },
  },
  whetstone: {
    label: "Blacksmith's Whetstone",
    desc: "Add 5% quality (max 20%)",
    apply(it) {
      if (it.corrupted) return fail("item is corrupted");
      if (it.quality >= 20) return fail("already 20% quality");
      it.quality = Math.min(20, it.quality + 5);
      return ok(`quality now ${it.quality}%`);
    },
  },
  fracture: {
    label: "Fracturing Orb",
    desc: "Lock a random modifier on a Rare item with 4+ mods (it can no longer be removed)",
    apply(it, rng) {
      if (it.corrupted) return fail("item is corrupted");
      if (it.rarity !== "Rare") return fail("requires a Rare item");
      if (totalAffixes(it) < 4) return fail("requires at least 4 modifiers");
      const candidates = allMods(it).filter((m) => !m.fractured);
      if (candidates.length === 0) return fail("all mods already fractured");
      const target = candidates[rng.int(0, candidates.length - 1)];
      target.fractured = true;
      return ok(`fractured "${target.def.affix}" (locked)`);
    },
  },
  desecrate: {
    label: "Bone (Desecration)",
    desc:
      'Add an unrevealed desecrated affix (Rare, open affix). The bone tier sets the ' +
      'min mod level of the reveal: desecrate "preserved" (any), desecrate "ancient" (≥40).',
    takesArg: true,
    apply(it, _rng, arg) {
      if (it.corrupted) return fail("item is corrupted");
      if (it.rarity !== "Rare") return fail("requires a Rare item");
      if (totalAffixes(it) >= affixCap(it)) return fail("no open affix");
      const tier = (arg ?? "").trim().toLowerCase();
      it.boneMinLevel = tier.includes("ancient") ? 40 : 0; // ancient cuts low tiers
      it.unrevealed += 1;
      return ok(`added an unrevealed desecrated affix${tier ? ` (${tier})` : ""}`);
    },
  },
  reveal: {
    label: "Reveal Desecrated (Well of Souls)",
    desc: "Reveal an unrevealed affix, choosing one of up to 3 options (a mix of regular and Abyssal mods)",
    apply(it, rng, _arg, omens = [], chooser) {
      if (it.corrupted) return fail("item is corrupted");
      if (it.unrevealed <= 0) return fail("no unrevealed desecrated affix");
      const e = omenEffects(omens);
      if ("error" in e) return fail(e.error);
      // candidates: the desecrated (Abyssal) pool *plus* the regular mod pool —
      // the Well of Souls offers a mix of normal and desecrated-only modifiers.
      // Each candidate's group must be free and its slot must have room (the
      // unrevealed affix being consumed frees a generic slot). Regular mods are
      // item-level gated; desecrated mods are not. A Necromancy omen restricts
      // the revealed mod to a prefix/suffix.
      const used = usedGroups(it);
      const slotHasRoom = (m: ModDef) =>
        m.type === "Prefix"
          ? it.prefixes.length < MAX_AFFIX[it.rarity]
          : it.suffixes.length < MAX_AFFIX[it.rarity];
      const eligible = (m: ModDef) => {
        if (used.has(m.group)) return false;
        if (e.addSlot && m.type !== e.addSlot) return false;
        return slotHasRoom(m);
      };
      // bone tier sets a minimum mod level (Ancient = 40), stripping low REGULAR
      // tiers. Desecrated/abyssal mods are not tiered (level 1) and not item-level
      // gated, so the bone-tier minLvl does NOT apply to them.
      const minLvl = it.boneMinLevel ?? 0;
      const candidates = [
        ...DESECRATED_MODS.filter((m) => eligible(m)),
        ...ALL_MODS.filter((m) => m.weight > 0 && m.level >= minLvl && m.level <= it.ilvl && eligible(m)),
      ];
      if (candidates.length === 0) {
        it.unrevealed -= 1;
        return ok("revealed — no eligible mod, affix lost");
      }
      // draw up to N distinct options by weight, then pick one (Omen of Abyssal
      // Echoes offers more options). Abyssal mods carry a typical mod weight, so
      // they compete on equal footing with regular mods in this single pool.
      const maxOptions = e.echoes ? REVEAL_OPTIONS_ECHOES : REVEAL_OPTIONS;
      const pool = [...candidates];
      const options: ModDef[] = [];
      for (let i = 0; i < maxOptions && pool.length > 0; i++) {
        const idx = rng.weighted(pool.map((m) => m.weight));
        if (idx < 0) break;
        options.push(pool.splice(idx, 1)[0]);
      }
      const picked = chooser ? chooser(options, it) : -1;
      const chosen =
        picked >= 0 && picked < options.length
          ? options[picked]
          : options[rng.int(0, options.length - 1)];
      it.unrevealed -= 1;
      // ANY modifier obtained from desecration is a desecrated mod — whether it
      // came from the Abyssal-only pool or the regular pool. Flag all reveals so
      // Omen of Light (removeRandomDesecrated) can remove them.
      addSpecificMod(it, chosen, rng, { desecrated: true });
      return ok(`revealed "${chosen.affix}" (from ${options.length} option${options.length > 1 ? "s" : ""})`);
    },
  },
  catalyst: {
    label: "Catalyst",
    desc:
      'Add quality to a ring/amulet, boosting modifiers of a type. Caps at 20%; ' +
      'a new type retypes existing quality. Usage: catalyst "attribute"',
    takesArg: true,
    apply(it, _rng, arg, omens = []) {
      if (it.corrupted) return fail("item is corrupted");
      if (activeClass.kind !== "jewellery")
        return fail("catalysts only apply to rings and amulets");
      if (!arg) return fail('catalyst needs a type, e.g. catalyst "attribute"');
      const cat = resolveCatalyst(arg);
      if (!cat) return fail(`unknown catalyst "${arg}"`);
      const e = omenEffects(omens);
      if ("error" in e) return fail(e.error);
      const before = it.quality;
      const sameType = it.qualityTag === cat.tag;
      it.qualityTag = cat.tag;
      it.quality = e.catalysing ? CATALYST_MAX : Math.min(CATALYST_MAX, it.quality + CATALYST_STEP);
      if (sameType && it.quality === before)
        return ok(`already at maximum ${cat.tag} quality (${it.quality}%)`);
      return ok(`${cat.label}: quality ${it.quality}% boosting ${cat.tag} mods`);
    },
  },
  essence: {
    label: "Essence",
    desc:
      'Guaranteed modifier. Lesser/Greater: Magic → Rare, adding the mod. ' +
      'Perfect: on a Rare, removes a random mod then adds the mod. ' +
      'Usage: essence "abrasion", essence "perfect flames"',
    takesArg: true,
    apply(it, rng, arg, omens = []) {
      if (it.corrupted) return fail("item is corrupted");
      if (!arg) return fail('essence needs a name, e.g. essence "abrasion"');
      const eff = omenEffects(omens);
      if ("error" in eff) return fail(eff.error);
      const terms = arg.toLowerCase().split(/\s+/).filter(Boolean);
      const match = ESSENCES.find((e) => {
        const hay = (e.name + " " + e.rank + " " + e.type).toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
      if (!match) return fail(`no essence matches "${arg}"`);
      if (match.mod.level > it.ilvl)
        return fail(`${match.name} requires item level ${match.mod.level}`);
      if (hasCraftedMod(it))
        return fail("item already has a crafted (essence) modifier");

      const slot = match.mod.type;
      const granted =
        match.mod.affix && match.mod.affix !== "Essences"
          ? match.mod.affix
          : match.mod.lines[0];

      if (match.rank === "Perfect") {
        // Perfect essences: only on Rare; remove a random affix, then add theirs.
        if (it.rarity !== "Rare") return fail("Perfect essences require a Rare item");
        if (usedGroups(it).has(match.mod.group))
          return fail("item already has that modifier");
        // A Crystallisation omen forces the removal into a prefix/suffix.
        // Otherwise: if the essence's own slot is full of concrete mods we free
        // that slot specifically; else remove any affix (unrevealed included).
        const slotTypeFull =
          (slot === "Prefix" ? it.prefixes.length : it.suffixes.length) >= MAX_AFFIX[it.rarity];
        let removedNote: string;
        if (eff.removeSlot) {
          const removed = removeRandomModOfType(it, eff.removeSlot, rng);
          if (!removed) return fail(`no ${eff.removeSlot.toLowerCase()} to remove`);
          removedNote = `${eff.removeSlot.toLowerCase()} "${removed.def.affix}"`;
        } else if (slotTypeFull) {
          const removed = removeRandomModOfType(it, slot, rng);
          if (!removed) return fail("could not remove a modifier to make room");
          removedNote = `"${removed.def.affix}"`;
        } else {
          const removed = removeRandomAffix(it, rng);
          if (!removed) return fail("could not remove a modifier to make room");
          removedNote =
            removed.kind === "mod"
              ? `"${removed.mod.def.affix}"`
              : "an unrevealed desecrated affix";
        }
        if (!addSpecificMod(it, match.mod, rng, { essence: true }))
          return fail("no room for the essence modifier");
        return ok(`${match.name}: removed ${removedNote}, guaranteed "${granted}"`);
      }

      // Lesser / normal / Greater essences: only on Magic; add mod, upgrade to Rare.
      if (it.rarity !== "Magic") return fail("this essence requires a Magic item");
      it.rarity = "Rare";
      if (!addSpecificMod(it, match.mod, rng, { essence: true }))
        return ok(`${match.name}: upgraded to Rare (already had that modifier)`);
      return ok(`${match.name}: upgraded to Rare, guaranteed "${granted}"`);
    },
  },
  scour: {
    label: "Orb of Scouring (sim only)",
    desc: "Reset item to Normal — not a real PoE2 orb, for experimentation",
    apply(it) {
      if (it.corrupted) return fail("item is corrupted");
      if (hasFractured(it)) return fail("cannot scour an item with fractured mods");
      it.rarity = "Normal";
      it.prefixes = [];
      it.suffixes = [];
      it.unrevealed = 0;
      return ok("reset to Normal");
    },
  },
};

function ok(note: string): CurrencyResult {
  return { applied: true, note };
}
function fail(note: string): CurrencyResult {
  return { applied: false, note };
}

// ---- Greater / Perfect tiered orbs --------------------------------------
// Greater and Perfect variants behave exactly like their base orb but force
// the added modifier to be at least a minimum mod level (poe2db: 35 / 50).

const minNote = (minLvl: number) => (minLvl > 0 ? ` (mod level ≥ ${minLvl})` : "");

/** Combined effects of a set of omens applied to one orb. */
interface OmenEffects {
  count: number; // how many mods to add
  addSlot?: AffixType; // force added mods into this slot
  removeSlot?: AffixType; // restrict removal to this slot
  lowest: boolean; // removal targets the lowest-level mod
  echoes: boolean; // reveal offers extra options (Abyssal Echoes)
  catalysing: boolean; // catalyst applies maximum quality at once
  onlyDesecrated: boolean; // annulment removes only a desecrated mod (Omen of Light)
}

function omenEffects(omens: Omen[]): OmenEffects | { error: string } {
  const e: OmenEffects = { count: 1, lowest: false, echoes: false, catalysing: false, onlyDesecrated: false };
  for (const o of omens) {
    switch (o.key) {
      case "greater exaltation":
        e.count = 2;
        break;
      case "sinistral exaltation":
      case "sinistral necromancy":
        if (e.addSlot === "Suffix") return { error: "conflicting omens (prefix and suffix)" };
        e.addSlot = "Prefix";
        break;
      case "dextral exaltation":
      case "dextral necromancy":
        if (e.addSlot === "Prefix") return { error: "conflicting omens (prefix and suffix)" };
        e.addSlot = "Suffix";
        break;
      case "sinistral erasure":
      case "sinistral annulment":
      case "sinistral crystallisation":
        if (e.removeSlot === "Suffix") return { error: "conflicting omens (prefix and suffix)" };
        e.removeSlot = "Prefix";
        break;
      case "dextral erasure":
      case "dextral annulment":
      case "dextral crystallisation":
        if (e.removeSlot === "Prefix") return { error: "conflicting omens (prefix and suffix)" };
        e.removeSlot = "Suffix";
        break;
      case "whittling":
        e.lowest = true;
        break;
      case "light":
        e.onlyDesecrated = true;
        break;
      case "abyssal echoes":
        e.echoes = true;
        break;
      case "catalysing":
        e.catalysing = true;
        break;
    }
  }
  return e;
}

function pluralize(w: string): string {
  return w.endsWith("ix") ? w.slice(0, -2) + "ixes" : w + "s";
}

/** Add `count` mods honoring a forced slot. */
function addWithOmens(it: Item, rng: RNG, minLvl: number, e: OmenEffects): { added: number; note: string } {
  let added = 0;
  for (let k = 0; k < e.count; k++) {
    let did = false;
    if (e.addSlot)
      did =
        (e.addSlot === "Prefix" ? openPrefix(it) : openSuffix(it)) &&
        addRandomMod(it, e.addSlot, rng, minLvl);
    else did = addRandomAny(it, rng, minLvl);
    if (did) added++;
  }
  const word = e.addSlot ? e.addSlot.toLowerCase() : "modifier";
  const note = added === 1 ? `added a ${word}` : `added ${added} ${pluralize(word)}`;
  return { added, note };
}

function applyTransmute(it: Item, rng: RNG, minLvl: number): CurrencyResult {
  if (it.corrupted) return fail("item is corrupted");
  if (it.rarity !== "Normal") return fail("requires a Normal item");
  it.rarity = "Magic";
  const added = addRandomAny(it, rng, minLvl);
  return ok(added ? "upgraded to Magic" : "upgraded to Magic (no eligible mod)");
}
function applyAugment(it: Item, rng: RNG, minLvl: number): CurrencyResult {
  if (it.corrupted) return fail("item is corrupted");
  if (it.rarity !== "Magic") return fail("requires a Magic item");
  if (totalAffixes(it) >= 2) return fail("no open affix");
  return addRandomAny(it, rng, minLvl) ? ok("added a modifier") : fail("no eligible mod");
}
function applyRegal(it: Item, rng: RNG, minLvl: number, omens: Omen[] = []): CurrencyResult {
  if (it.corrupted) return fail("item is corrupted");
  if (it.rarity !== "Magic") return fail("requires a Magic item");
  const e = omenEffects(omens);
  if ("error" in e) return fail(e.error);
  it.rarity = "Rare";
  const r = addWithOmens(it, rng, minLvl, e);
  return ok(r.added ? `upgraded to Rare, ${r.note}` : "upgraded to Rare (no eligible mod)");
}
function applyExalt(it: Item, rng: RNG, minLvl: number, omens: Omen[] = []): CurrencyResult {
  if (it.corrupted) return fail("item is corrupted");
  if (it.rarity !== "Rare") return fail("requires a Rare item");
  if (totalAffixes(it) >= 6) return fail("no open affix");
  const e = omenEffects(omens);
  if ("error" in e) return fail(e.error);
  const r = addWithOmens(it, rng, minLvl, e);
  return r.added ? ok(r.note) : fail("no eligible modifier");
}
function applyChaos(it: Item, rng: RNG, minLvl: number, omens: Omen[] = []): CurrencyResult {
  if (it.corrupted) return fail("item is corrupted");
  if (it.rarity !== "Rare") return fail("requires a Rare item");
  const e = omenEffects(omens);
  if ("error" in e) return fail(e.error);
  let removedNote: string;
  if (e.lowest) {
    const r = removeLowestMod(it, rng, e.removeSlot);
    if (!r) return fail("no mods to remove");
    removedNote = `lowest ${e.removeSlot ? e.removeSlot.toLowerCase() + " " : ""}"${r.def.affix}" (i${r.def.level})`;
  } else if (e.removeSlot) {
    const r = removeRandomModOfType(it, e.removeSlot, rng);
    if (!r) return fail(`no ${e.removeSlot.toLowerCase()} to remove`);
    removedNote = `${e.removeSlot.toLowerCase()} "${r.def.affix}"`;
  } else {
    const removed = removeRandomAffix(it, rng);
    if (!removed) return fail("no mods to remove");
    removedNote =
      removed.kind === "mod" ? `"${removed.mod.def.affix}"` : "an unrevealed desecrated affix";
  }
  addRandomAny(it, rng, minLvl);
  return ok(`removed ${removedNote}, added a modifier`);
}

const TIERABLE: Record<
  string,
  {
    name: string;
    desc: string;
    fn: (it: Item, rng: RNG, minLvl: number, omens?: Omen[]) => CurrencyResult;
  }
> = {
  transmute: {
    name: "Orb of Transmutation",
    desc: "Normal → Magic with one random modifier",
    fn: applyTransmute,
  },
  augment: {
    name: "Orb of Augmentation",
    desc: "Add a modifier to a Magic item",
    fn: applyAugment,
  },
  regal: { name: "Regal Orb", desc: "Magic → Rare, adding one modifier", fn: applyRegal },
  exalt: { name: "Exalted Orb", desc: "Add a random modifier to a Rare item", fn: applyExalt },
  chaos: {
    name: "Chaos Orb",
    desc: "Remove a random modifier and add a new one (Rare)",
    fn: applyChaos,
  },
};

const TIERS: { prefix: string; label: string; minLvl: number }[] = [
  { prefix: "", label: "", minLvl: MIN_MOD_LEVEL.base },
  { prefix: "greater", label: "Greater ", minLvl: MIN_MOD_LEVEL.greater },
  { prefix: "perfect", label: "Perfect ", minLvl: MIN_MOD_LEVEL.perfect },
];

for (const [base, spec] of Object.entries(TIERABLE)) {
  for (const tier of TIERS) {
    const key = tier.prefix ? tier.prefix + base[0].toUpperCase() + base.slice(1) : base;
    CURRENCY[key] = {
      label: tier.label + spec.name,
      desc: spec.desc + minNote(tier.minLvl),
      apply: (it, rng, _arg, omens) => spec.fn(it, rng, tier.minLvl, omens),
    };
  }
}
