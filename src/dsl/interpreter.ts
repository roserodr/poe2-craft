import type { Cond, CmpOp, Stmt } from "./ast";
import type { Item } from "../engine/types";
import { CURRENCY, totalAffixes, MAX_AFFIX, OMENS, cloneItem, addSpecificMod } from "../engine/item";
import type { ModDef } from "../engine/types";
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

/** Cost charged to one `checkpoint "label"` segment (since the previous checkpoint). */
export interface CheckpointSpan {
  label: string;
  cost: number; // currency cost in Exalted accumulated in this segment
  steps: number; // currency operations in this segment
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
  marks: CheckpointSpan[]; // per-stage cost, delimited by `checkpoint` statements
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

/** Count the affixes on `item` that match the slot/text/group/tier/fractured filter. */
function countMatches(
  item: Item,
  slot: "prefix" | "suffix" | "any",
  text: string,
  group?: string,
  tier?: { op: CmpOp; value: number },
  fractured?: boolean
): number {
  const pools =
    slot === "prefix" ? [item.prefixes] : slot === "suffix" ? [item.suffixes] : [item.prefixes, item.suffixes];
  let n = 0;
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
      n++;
    }
  }
  return n;
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
    case "has": {
      const n = countMatches(item, c.slot, c.text, c.group, c.tier, c.fractured);
      return c.count ? cmp(c.count.op, n, c.count.value) : n >= 1;
    }
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
  marks: CheckpointSpan[] = []; // per-`checkpoint` segment costs
  private markCostBase = 0; // cost at the previous checkpoint
  private markStepBase = 0; // steps at the previous checkpoint
  budgetExceeded = false;
  stoppedEarly = false;
  limitReached = false;
  collectLog: boolean;
  maxSteps: number;
  maxCost: number;
  prices: Record<string, number>;
  // dedicated RNG for simulating reveal options during `pick` evaluation; kept
  // separate so the main craft RNG stream stays deterministic.
  private scratch = new RNG(0x9e3779b9);

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

  /** Record a currency op (plus any omens) and stop if a step/cost limit is hit. */
  private accountAndCheckLimit(name: string, omens?: string[]) {
    this.steps++;
    this.cost += this.prices[name] ?? 0;
    for (const o of omens ?? []) this.cost += this.prices[o] ?? 0;
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

  /** Close the trailing segment (cost after the last checkpoint). Only emitted
   * when checkpoints are in use, so plain scripts carry no marks. */
  finalizeMarks() {
    if (this.marks.length === 0) return;
    const cost = this.cost - this.markCostBase;
    const steps = this.steps - this.markStepBase;
    if (cost > 0 || steps > 0) this.marks.push({ label: "(after last checkpoint)", cost, steps });
  }

  private runStmt(s: Stmt) {
    switch (s.kind) {
      case "currency": {
        this.tick();
        const def = CURRENCY[s.name];
        const pick = s.pick;
        const chooser = pick
          ? (options: ModDef[], it: Item): number => {
              for (let i = 0; i < options.length; i++) {
                const clone = cloneItem(it);
                // reveal consumes the unrevealed slot, freeing room for the mod
                clone.unrevealed = Math.max(0, clone.unrevealed - 1);
                // mirror reveal's flagging: ANY desecration-revealed mod is desecrated
                if (addSpecificMod(clone, options[i], this.scratch, { desecrated: true }) && evalCond(pick, clone)) {
                  return i;
                }
              }
              return -1;
            }
          : undefined;
        const res = def.apply(
          this.item,
          this.rng,
          s.arg,
          s.omens?.map((k) => OMENS[k]),
          chooser
        );
        this.spent[s.name] = (this.spent[s.name] || 0) + 1;
        // omens are consumed per use too — track + price them separately
        for (const o of s.omens ?? []) this.spent[o] = (this.spent[o] || 0) + 1;
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
        this.accountAndCheckLimit(s.name, s.omens);
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
      case "compare": {
        // A comparison is a Monte-Carlo-only construct; a single run just takes
        // the first option's body as the default path so the script still runs.
        if (s.options.length > 0) this.runBlock(s.options[0].body);
        break;
      }
      case "checkpoint": {
        // close the current segment: charge cost/steps since the last checkpoint
        this.marks.push({
          label: s.label,
          cost: this.cost - this.markCostBase,
          steps: this.steps - this.markStepBase,
        });
        this.markCostBase = this.cost;
        this.markStepBase = this.steps;
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
  interp.finalizeMarks();
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
    marks: interp.marks,
  };
}
