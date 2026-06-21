import { CURRENCY } from "../engine/item";

export const CURRENCY_NAMES = Object.keys(CURRENCY);

// ---- Statements ----
export type Stmt =
  | { kind: "currency"; name: string; arg?: string; omens?: string[]; pick?: Cond; line: number }
  | { kind: "repeat"; count: number; body: Stmt[]; line: number }
  | { kind: "while"; cond: Cond; body: Stmt[]; line: number }
  | { kind: "until"; cond: Cond; body: Stmt[]; line: number }
  | { kind: "if"; cond: Cond; then: Stmt[]; else: Stmt[]; line: number }
  | { kind: "compare"; cond: Cond; options: CompareOption[]; line: number }
  | { kind: "checkpoint"; label: string; line: number }
  | { kind: "stop"; line: number };

/** One labelled approach within a `compare` block. */
export interface CompareOption {
  name: string;
  body: Stmt[];
  line: number;
}

// ---- Conditions ----
export type Cond =
  | {
      kind: "has";
      slot: "prefix" | "suffix" | "any";
      text: string; // substring match over affix/group/rolled text ("" matches any)
      group?: string; // exact mod-group match (unambiguous), case-insensitive
      tier?: { op: CmpOp; value: number }; // optional tier filter (T1 = best)
      fractured?: boolean; // require the matched mod to be fractured
      count?: { op: CmpOp; value: number }; // require N matches (default: >= 1)
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

/** Render a condition back to (approximately) its DSL source, for display. */
export function condToString(c: Cond): string {
  switch (c.kind) {
    case "has": {
      const parts = ["has"];
      if (c.count) parts.push(`${c.count.op} ${c.count.value}`);
      if (c.slot !== "any") parts.push(c.slot);
      if (c.group) parts.push(`group "${c.group}"`);
      else if (c.text) parts.push(`"${c.text}"`);
      if (c.tier) parts.push(`tier ${c.tier.op} ${c.tier.value}`);
      if (c.fractured) parts.push("fractured");
      return parts.join(" ");
    }
    case "count":
      return `${c.what} ${c.op} ${c.value}`;
    case "open":
      return `open ${c.slot}`;
    case "rarity":
      return `rarity is ${c.value}`;
    case "corrupted":
    case "fractured":
    case "desecrated":
    case "crafted":
    case "unrevealed":
    case "full":
      return c.kind;
    case "not":
      return `not ${condToString(c.inner)}`;
    case "and":
      return `(${condToString(c.left)} and ${condToString(c.right)})`;
    case "or":
      return `(${condToString(c.left)} or ${condToString(c.right)})`;
  }
}
