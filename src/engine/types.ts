export type Rarity = "Normal" | "Magic" | "Rare";
export type AffixType = "Prefix" | "Suffix";

export interface ItemBase {
  name: string;
  str: number;
  dex: number;
  int: number;
  level: number;
  // weapon stats (weapons only)
  physMin?: number;
  physMax?: number;
  critBase?: number;
  aps?: number;
  // armour stats (armour only)
  armour?: number;
  evasion?: number;
  energyShield?: number;
  implicit?: string;
}
/** @deprecated use ItemBase */
export type BowBase = ItemBase;

/** A range placeholder parsed out of an affix line, e.g. "(5-8)". */
export interface ModRange {
  lo: number;
  hi: number;
  /** true if both bounds are integers (roll whole numbers) */
  int: boolean;
}

export interface ModDef {
  id: string;
  type: AffixType;
  affix: string; // display name e.g. "Heated"
  group: string; // mod group; only one mod per group per item
  level: number; // min item level
  weight: number; // spawn weight on bows
  lines: string[]; // raw stat lines with (lo-hi) placeholders
  tags: string[];
  desecrated?: boolean; // from the desecrated (Bone) pool
  boss?: string; // desecrated mods are tied to a boss (Ulaman/Amanamu/Kurgal)
}

/** A mod actually present on an item, with concrete rolled values. */
export interface RolledMod {
  def: ModDef;
  /** one value per range placeholder, in reading order across all lines */
  values: number[];
  /** locked by a Fracturing Orb — survives chaos/annul/scour */
  fractured?: boolean;
  /** added by Desecration (a Bone) */
  desecrated?: boolean;
  /** guaranteed by an Essence */
  essence?: boolean;
}

export interface Item {
  base: BowBase;
  rarity: Rarity;
  ilvl: number;
  quality: number;
  corrupted: boolean;
  prefixes: RolledMod[];
  suffixes: RolledMod[];
  /** count of unrevealed desecrated affixes (added by a Bone, not yet revealed) */
  unrevealed: number;
}
