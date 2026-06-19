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

import amuletBases from "../data/amulet.bases.json";
import amuletMods from "../data/amulet.mods.json";
import amuletEssences from "../data/amulet.essences.json";
import amuletDesecrated from "../data/amulet.desecrated.json";

import ringBases from "../data/ring.bases.json";
import ringMods from "../data/ring.mods.json";
import ringEssences from "../data/ring.essences.json";
import ringDesecrated from "../data/ring.desecrated.json";

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
  kind: "weapon" | "armour" | "jewellery";
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
  {
    key: "amulet",
    name: "Amulet",
    kind: "jewellery",
    bases: amuletBases as ItemBase[],
    mods: amuletMods as ModDef[],
    essences: amuletEssences as EssenceDef[],
    desecrated: amuletDesecrated as ModDef[],
  },
  {
    key: "ring",
    name: "Ring",
    kind: "jewellery",
    bases: ringBases as ItemBase[],
    mods: ringMods as ModDef[],
    essences: ringEssences as EssenceDef[],
    desecrated: ringDesecrated as ModDef[],
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
export function renderMod(mod: RolledMod, scale = 1): string[] {
  let idx = 0;
  return mod.def.lines.map((line) => {
    RANGE_RE.lastIndex = 0;
    return line.replace(RANGE_RE, () => {
      const v = mod.values[idx++];
      if (scale === 1) return String(v);
      const s = v * scale;
      return String(Number.isInteger(v) ? Math.round(s) : Math.round(s * 10) / 10);
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

/**
 * Resolve a starting-mod spec to a concrete ModDef for the current class.
 * Spec is an affix name — the group label or raw group id, or a substring of the
 * modifier's stat text (e.g. "Movement Speed" matches the MovementVelocity group) —
 * with an optional trailing tier like "Movement Speed t1" (t1 = best). Without a
 * tier, picks the best tier whose required level is ≤ ilvl (falling back to the
 * lowest tier). Returns null if nothing matches.
 */
export function resolveStartMod(spec: string, ilvl: number): ModDef | null {
  let s = spec.trim().toLowerCase();
  if (!s) return null;
  let tierIdx = -1;
  const tm = s.match(/^(.*?)\s+t(\d+)$/);
  if (tm) {
    s = tm[1].trim();
    tierIdx = parseInt(tm[2], 10) - 1;
  }
  const groups = Object.keys(GROUP_TIERS);
  // 1. exact group id / label, 2. label substring, 3. stat-text substring
  let group =
    groups.find((g) => g.toLowerCase() === s || groupLabel(g).toLowerCase() === s) ??
    groups.find((g) => groupLabel(g).toLowerCase().includes(s)) ??
    groups.find((g) => GROUP_TIERS[g].some((t) => t.lines.join(" ").toLowerCase().includes(s)));
  if (!group) return null;
  const tiers = GROUP_TIERS[group]; // sorted best (highest level) first
  if (tierIdx >= 0) return tiers[tierIdx] ?? null;
  return tiers.find((t) => t.level <= ilvl) ?? tiers[tiers.length - 1] ?? null;
}

// initialize derived structures for the default class
setItemClass(activeClass.key);
