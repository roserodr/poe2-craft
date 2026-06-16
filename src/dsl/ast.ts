import { CURRENCY } from "../engine/item";

export const CURRENCY_NAMES = Object.keys(CURRENCY);

// ---- Statements ----
export type Stmt =
  | { kind: "currency"; name: string; arg?: string; omens?: string[]; line: number }
  | { kind: "repeat"; count: number; body: Stmt[]; line: number }
  | { kind: "while"; cond: Cond; body: Stmt[]; line: number }
  | { kind: "until"; cond: Cond; body: Stmt[]; line: number }
  | { kind: "if"; cond: Cond; then: Stmt[]; else: Stmt[]; line: number }
  | { kind: "stop"; line: number };

// ---- Conditions ----
export type Cond =
  | {
      kind: "has";
      slot: "prefix" | "suffix" | "any";
      text: string; // substring match over affix/group/rolled text ("" matches any)
      group?: string; // exact mod-group match (unambiguous), case-insensitive
      tier?: { op: CmpOp; value: number }; // optional tier filter (T1 = best)
      fractured?: boolean; // require the matched mod to be fractured
    }
  | { kind: "count"; what: "prefixes" | "suffixes" | "affixes"; op: CmpOp; value: number }
  | { kind: "open"; slot: "prefix" | "suffix" }
  | { kind: "rarity"; value: "normal" | "magic" | "rare" }
  | { kind: "corrupted" }
  | { kind: "fractured" } // any fractured (locked) mod present
  | { kind: "desecrated" } // any desecrated mod present
  | { kind: "crafted" } // a crafted (essence) mod present
  | { kind: "unrevealed" } // an unrevealed desecrated affix present
  | { kind: "full" } // rare with 6 mods
  | { kind: "not"; inner: Cond }
  | { kind: "and"; left: Cond; right: Cond }
  | { kind: "or"; left: Cond; right: Cond };

export type CmpOp = ">=" | "<=" | "==" | "!=" | ">" | "<";
