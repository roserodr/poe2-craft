import type { Cond, CmpOp, Stmt } from "./ast";
import type { Item } from "../engine/types";
import { CURRENCY, totalAffixes, MAX_AFFIX, OMENS } from "../engine/item";
import { renderModInline, modTier, groupLabel, AFFIX_NAMES } from "../engine/mods";
import { RNG } from "../engine/rng";

export class RuntimeError extends Error {
  constructor(msg: string, public line?: number) {
    super(line ? `Line ${line}: ${msg}` : msg);
  }
}

class StopSignal {}

export interface LogEntry {
  line: number;
  currency: string;
  note: string;
  applied: boolean;
  affixCount: number;
}

export interface RunResult {
  item: Item;
  log: LogEntry[];
  spent: Record<string, number>;
  totalSpent: number;
  cost: number; // total currency cost in Exalted Orbs (0 if no prices given)
  stoppedEarly: boolean;
  budgetExceeded: boolean;
  limitReached: boolean; // hit the user-configured step/cost limit
}

const DEFAULT_BUDGET = 200_000;
const MAX_LOG = 5_000; // cap collected step-log entries to keep rendering fast

export interface RunOptions {
  /** hard guard against infinite loops (operation count) */
  budget?: number;
  collectLog?: boolean;
  /** stop after this many currency operations (steps) */
  maxSteps?: number;
  /** stop once total currency cost reaches this many Exalted Orbs */
  maxCost?: number;
  /** prices (in Exalted) used for maxCost and the reported cost */
  prices?: Record<string, number>;
}

// ---- condition evaluation ----

/** True if a mod's group matches `name` by raw group id or readable label. */
function matchesGroup(m: { def: { group: string } }, name: string): boolean {
  return m.def.group.toLowerCase() === name || groupLabel(m.def.group).toLowerCase() === name;
}

function modMatches(
  item: Item,
  slot: "prefix" | "suffix" | "any",
  text: string,
  group?: string,
  tier?: { op: CmpOp; value: number },
  fractured?: boolean
): boolean {
  const pools =
    slot === "prefix" ? [item.prefixes] : slot === "suffix" ? [item.suffixes] : [item.prefixes, item.suffixes];
  for (const pool of pools) {
    for (const m of pool) {
      if (fractured && !m.fractured) continue;
      if (group && !matchesGroup(m, group)) continue;
      if (text) {
        if (AFFIX_NAMES.has(text)) {
          // an exact affix name -> match that affix only (unambiguous)
          if (!matchesGroup(m, text)) continue;
        } else {
          // otherwise a fuzzy substring over the affix's tier name + rolled text
          const hay = (m.def.affix + " " + renderModInline(m)).toLowerCase();
          if (!hay.includes(text)) continue;
        }
      }
      if (tier && !cmp(tier.op, modTier(m.def).tier, tier.value)) continue;
      return true;
    }
  }
  return false;
}

function cmp(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a > b;
    case "<":
      return a < b;
  }
}

export function evalCond(c: Cond, item: Item): boolean {
  switch (c.kind) {
    case "has":
      return modMatches(item, c.slot, c.text, c.group, c.tier, c.fractured);
    case "count": {
      const n =
        c.what === "prefixes"
          ? item.prefixes.length
          : c.what === "suffixes"
          ? item.suffixes.length
          : totalAffixes(item);
      return cmp(c.op, n, c.value);
    }
    case "open": {
      const cap = MAX_AFFIX[item.rarity];
      return c.slot === "prefix" ? item.prefixes.length < cap : item.suffixes.length < cap;
    }
    case "rarity":
      return item.rarity.toLowerCase() === c.value;
    case "corrupted":
      return item.corrupted;
    case "fractured":
      return [...item.prefixes, ...item.suffixes].some((m) => m.fractured);
    case "desecrated":
      return [...item.prefixes, ...item.suffixes].some((m) => m.desecrated);
    case "crafted":
      return [...item.prefixes, ...item.suffixes].some((m) => m.essence);
    case "unrevealed":
      return item.unrevealed > 0;
    case "full":
      return item.rarity === "Rare" && totalAffixes(item) >= 6;
    case "not":
      return !evalCond(c.inner, item);
    case "and":
      return evalCond(c.left, item) && evalCond(c.right, item);
    case "or":
      return evalCond(c.left, item) || evalCond(c.right, item);
  }
}

// ---- interpreter ----

class Interp {
  log: LogEntry[] = [];
  spent: Record<string, number> = {};
  ops = 0;
  steps = 0; // currency operations executed
  cost = 0; // accumulated currency cost in Exalted
  budgetExceeded = false;
  stoppedEarly = false;
  limitReached = false;
  collectLog: boolean;
  maxSteps: number;
  maxCost: number;
  prices: Record<string, number>;

  constructor(public item: Item, public rng: RNG, public budget: number, opts: RunOptions) {
    this.collectLog = opts.collectLog ?? true;
    this.maxSteps = opts.maxSteps ?? 0;
    this.maxCost = opts.maxCost ?? 0;
    this.prices = opts.prices ?? {};
  }

  private tick() {
    if (this.ops++ > this.budget) {
      this.budgetExceeded = true;
      throw new StopSignal();
    }
  }

  /** Record a currency op and stop if a user-configured step/cost limit is hit. */
  private accountAndCheckLimit(name: string) {
    this.steps++;
    this.cost += this.prices[name] ?? 0;
    if (
      (this.maxSteps > 0 && this.steps >= this.maxSteps) ||
      (this.maxCost > 0 && this.cost >= this.maxCost)
    ) {
      this.limitReached = true;
      throw new StopSignal();
    }
  }

  runBlock(body: Stmt[]) {
    for (const s of body) this.runStmt(s);
  }

  private runStmt(s: Stmt) {
    switch (s.kind) {
      case "currency": {
        this.tick();
        const def = CURRENCY[s.name];
        const res = def.apply(
          this.item,
          this.rng,
          s.arg,
          s.omens?.map((k) => OMENS[k])
        );
        this.spent[s.name] = (this.spent[s.name] || 0) + 1;
        // Cap the log so a runaway loop can't build a giant array (and freeze
        // the UI when rendered). totalSpent still reflects the true count.
        if (this.collectLog && this.log.length < MAX_LOG) {
          this.log.push({
            line: s.line,
            currency: def.label,
            note: res.note,
            applied: res.applied,
            affixCount: totalAffixes(this.item),
          });
        }
        this.accountAndCheckLimit(s.name);
        break;
      }
      case "repeat": {
        for (let k = 0; k < s.count; k++) {
          this.tick();
          this.runBlock(s.body);
        }
        break;
      }
      case "while": {
        while (evalCond(s.cond, this.item)) {
          this.tick();
          this.runBlock(s.body);
        }
        break;
      }
      case "until": {
        while (!evalCond(s.cond, this.item)) {
          this.tick();
          this.runBlock(s.body);
        }
        break;
      }
      case "if": {
        if (evalCond(s.cond, this.item)) this.runBlock(s.then);
        else this.runBlock(s.else);
        break;
      }
      case "stop":
        this.stoppedEarly = true;
        throw new StopSignal();
    }
  }
}

export function run(program: Stmt[], item: Item, rng: RNG, opts: RunOptions = {}): RunResult {
  const interp = new Interp(item, rng, opts.budget ?? DEFAULT_BUDGET, opts);
  try {
    interp.runBlock(program);
  } catch (e) {
    if (!(e instanceof StopSignal)) throw e;
  }
  const totalSpent = Object.values(interp.spent).reduce((a, b) => a + b, 0);
  return {
    item: interp.item,
    log: interp.log,
    spent: interp.spent,
    totalSpent,
    cost: interp.cost,
    stoppedEarly: interp.stoppedEarly,
    budgetExceeded: interp.budgetExceeded,
    limitReached: interp.limitReached,
  };
}
