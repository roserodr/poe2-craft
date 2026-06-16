import type { ItemBase, ModDef, ModRange, RolledMod } from "./types";
import { RNG } from "./rng";

import bowBases from "../data/bow.bases.json";
import bowMods from "../data/bow.mods.json";
import bowEssences from "../data/bow.essences.json";
import bowDesecrated from "../data/desecrated.json";

import bootBases from "../data/dexIntBoots.bases.json";
import bootMods from "../data/dexIntBoots.mods.json";
import bootEssences from "../data/dexIntBoots.essences.json";
import bootDesecrated from "../data/dexIntBoots.desecrated.json";

export interface EssenceDef {
  key: string;
  name: string;
  rank: string;
  type: string;
  tierLevel: number;
  mod: ModDef;
}

export interface ItemClass {
  key: string;
  name: string;
  kind: "weapon" | "armour";
  bases: ItemBase[];
  mods: ModDef[];
  essences: EssenceDef[];
  desecrated: ModDef[];
}

export const ITEM_CLASSES: ItemClass[] = [
  {
    key: "bow",
    name: "Bow",
    kind: "weapon",
    bases: bowBases as ItemBase[],
    mods: bowMods as ModDef[],
    essences: bowEssences as EssenceDef[],
    desecrated: bowDesecrated as ModDef[],
  },
  {
    key: "dexIntBoots",
    name: "Dex/Int Boots",
    kind: "armour",
    bases: bootBases as ItemBase[],
    mods: bootMods as ModDef[],
    essences: bootEssences as EssenceDef[],
    desecrated: bootDesecrated as ModDef[],
  },
];

// ---- active item class (live bindings the engine reads) ----
export let activeClass: ItemClass = ITEM_CLASSES[0];
export let ALL_MODS: ModDef[] = activeClass.mods;
export let ALL_BASES: ItemBase[] = activeClass.bases;
export let ESSENCES: EssenceDef[] = activeClass.essences;
export let DESECRATED_MODS: ModDef[] = activeClass.desecrated;
export let AFFIX_NAMES: Set<string> = new Set();
let GROUP_TIERS: Record<string, ModDef[]> = {};

function rebuildDerived() {
  GROUP_TIERS = {};
  for (const m of ALL_MODS) (GROUP_TIERS[m.group] = GROUP_TIERS[m.group] || []).push(m);
  for (const g of Object.keys(GROUP_TIERS)) GROUP_TIERS[g].sort((a, b) => b.level - a.level);
  AFFIX_NAMES = new Set<string>();
  for (const m of [...ALL_MODS, ...DESECRATED_MODS]) {
    AFFIX_NAMES.add(m.group.toLowerCase());
    AFFIX_NAMES.add(groupLabel(m.group).toLowerCase());
  }
}

export function setItemClass(key: string) {
  const cls = ITEM_CLASSES.find((c) => c.key === key);
  if (!cls) return;
  activeClass = cls;
  ALL_MODS = cls.mods;
  ALL_BASES = cls.bases;
  ESSENCES = cls.essences;
  DESECRATED_MODS = cls.desecrated;
  rebuildDerived();
}

const RANGE_RE = /\(([\d.]+)-([\d.]+)\)/g;

/** Extract the numeric range placeholders from a mod's lines, in reading order. */
export function modRanges(def: ModDef): ModRange[] {
  const ranges: ModRange[] = [];
  for (const line of def.lines) {
    let m: RegExpExecArray | null;
    RANGE_RE.lastIndex = 0;
    while ((m = RANGE_RE.exec(line)) !== null) {
      const lo = parseFloat(m[1]);
      const hi = parseFloat(m[2]);
      const int = Number.isInteger(lo) && Number.isInteger(hi);
      ranges.push({ lo, hi, int });
    }
  }
  return ranges;
}

/** Roll fresh values for every range in a mod definition. */
export function rollMod(def: ModDef, rng: RNG): RolledMod {
  const ranges = modRanges(def);
  const values = ranges.map((r) =>
    r.int ? rng.int(r.lo, r.hi) : Math.round((r.lo + rng.next() * (r.hi - r.lo)) * 10) / 10
  );
  return { def, values };
}

/** Re-roll values (Divine Orb) while keeping the same mods. */
export function divineMod(mod: RolledMod, rng: RNG): RolledMod {
  return rollMod(mod.def, rng);
}

/** Render a mod's lines with its concrete rolled values substituted in. */
export function renderMod(mod: RolledMod): string[] {
  let idx = 0;
  return mod.def.lines.map((line) => {
    RANGE_RE.lastIndex = 0;
    return line.replace(RANGE_RE, () => {
      const v = mod.values[idx++];
      return String(v);
    });
  });
}

export function renderModInline(mod: RolledMod): string {
  return renderMod(mod).join(", ");
}

/** Human-readable affix name derived from a mod group id, e.g.
 * "LocalAccuracyRating" -> "Accuracy Rating". Unique per group. */
export function groupLabel(group: string): string {
  return group
    .replace(/^Local/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .trim();
}

export function modTier(def: ModDef): { tier: number; count: number } {
  const list = GROUP_TIERS[def.group] || [def];
  const idx = list.findIndex((m) => m.id === def.id);
  return { tier: idx < 0 ? 1 : idx + 1, count: list.length };
}

// initialize derived structures for the default class
setItemClass(activeClass.key);
