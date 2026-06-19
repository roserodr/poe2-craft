import type { Stmt, Cond } from "./ast";
import { condToString } from "./ast";
import type { BowBase, Item } from "../engine/types";
import { newItem, cloneItem } from "../engine/item";
import { RNG } from "../engine/rng";
import { run, evalCond, type RunOptions } from "./interpreter";

/** avg / min / p95 / max of a per-attempt quantity across the batch. */
export interface Stats {
  avg: number;
  min: number;
  p95: number;
  max: number;
}

export interface BatchResult {
  runs: number;
  avgSpent: Record<string, number>;
  avgTotal: number;
  successRate: number; // fraction meeting `target`, if provided
  budgetExceededRate: number;
  limitReachedRate: number; // fraction that hit the step/cost limit
  sample?: Item; // an example item from a run that met the target
  // per-currency count distribution (multiply by price for cost)
  perCurrency: Record<string, Stats>;
  // per-attempt total currency count distribution
  totalCount: Stats;
  // per-attempt total currency cost (Exalted, excludes the base item)
  cost: Stats;
  // binned histogram of per-attempt total currency cost (excludes base)
  costHistogram: { lo: number; hi: number; counts: number[] };
}

export interface BatchOptions {
  target?: Cond;
  maxSteps?: number;
  maxCost?: number;
  prices?: Record<string, number>;
  /** template starting item; cloned for each attempt. Defaults to a fresh base. */
  startItem?: Item;
}

interface Acc {
  totals: Record<string, number>;
  grandTotal: number;
  successes: number;
  budgetExceeded: number;
  limitReached: number;
  sample?: Item; // reservoir-sampled item from a passing run
  sampleRng: RNG;
  costs: number[]; // per-attempt currency cost (Exalted)
  totalCounts: number[]; // per-attempt total currency count
  countHist: Map<string, Map<number, number>>; // currency -> (count -> #runs)
}

function newAcc(seed: number): Acc {
  return {
    totals: {},
    grandTotal: 0,
    successes: 0,
    budgetExceeded: 0,
    limitReached: 0,
    sampleRng: new RNG(seed ^ 0x9e3779b9),
    costs: [],
    totalCounts: [],
    countHist: new Map(),
  };
}

/** Execute one attempt and fold the result into the accumulator. */
function step(
  acc: Acc,
  program: Stmt[],
  base: BowBase,
  ilvl: number,
  seed: number,
  i: number,
  runOpts: RunOptions,
  target?: Cond,
  startItem?: Item
) {
  const rng = new RNG(seed + i * 2654435761);
  const item = startItem ? cloneItem(startItem) : newItem(base, ilvl);
  const res = run(program, item, rng, runOpts);
  for (const [k, v] of Object.entries(res.spent)) {
    acc.totals[k] = (acc.totals[k] || 0) + v;
    let h = acc.countHist.get(k);
    if (!h) acc.countHist.set(k, (h = new Map()));
    h.set(v, (h.get(v) || 0) + 1);
  }
  acc.grandTotal += res.totalSpent;
  acc.costs.push(res.cost);
  acc.totalCounts.push(res.totalSpent);
  if (res.budgetExceeded) acc.budgetExceeded++;
  if (res.limitReached) acc.limitReached++;
  if (target && evalCond(target, res.item)) {
    acc.successes++;
    // reservoir sample (k=1): keep a uniformly-random passing item
    if (acc.sampleRng.next() * acc.successes < 1) acc.sample = res.item;
  }
}

/** avg/min/p95/max of a sorted ascending array of `runs` samples. */
function statsFromSorted(sorted: number[], runs: number, p = 0.95): Stats {
  if (sorted.length === 0) return { avg: 0, min: 0, p95: 0, max: 0 };
  let sum = 0;
  for (const x of sorted) sum += x;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * runs) - 1));
  return { avg: sum / runs, min: sorted[0], p95: sorted[i], max: sorted[sorted.length - 1] };
}

/** avg/min/p95/max of a per-currency count histogram over `runs` attempts
 * (runs not present in the histogram count as 0). */
function statsFromHist(hist: Map<number, number>, runs: number, p = 0.95): Stats {
  const entries = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  let used = 0;
  let sum = 0;
  for (const [v, f] of entries) {
    used += f;
    sum += v * f;
  }
  const zeros = runs - used;
  const buckets: [number, number][] = zeros > 0 ? [[0, zeros], ...entries] : entries;
  const rank = Math.min(runs - 1, Math.max(0, Math.ceil(p * runs) - 1));
  let cum = 0;
  let p95 = buckets[buckets.length - 1][0];
  for (const [v, f] of buckets) {
    cum += f;
    if (rank < cum) {
      p95 = v;
      break;
    }
  }
  return { avg: sum / runs, min: buckets[0][0], p95, max: buckets[buckets.length - 1][0] };
}

function finalize(acc: Acc, runs: number, hasTarget: boolean): BatchResult {
  const avgSpent: Record<string, number> = {};
  const perCurrency: Record<string, Stats> = {};
  for (const [k, v] of Object.entries(acc.totals)) avgSpent[k] = v / runs;
  for (const [k, h] of acc.countHist) perCurrency[k] = statsFromHist(h, runs);
  const sortedCosts = [...acc.costs].sort((a, b) => a - b);
  return {
    runs,
    avgSpent,
    avgTotal: acc.grandTotal / runs,
    successRate: hasTarget ? acc.successes / runs : 0,
    budgetExceededRate: acc.budgetExceeded / runs,
    limitReachedRate: acc.limitReached / runs,
    sample: acc.sample,
    perCurrency,
    totalCount: statsFromSorted([...acc.totalCounts].sort((a, b) => a - b), runs),
    cost: statsFromSorted(sortedCosts, runs),
    costHistogram: histogram(sortedCosts, 24),
  };
}

/** Bin a sorted ascending array into `bins` buckets over [min, max]. */
function histogram(sorted: number[], bins: number): { lo: number; hi: number; counts: number[] } {
  const lo = sorted[0] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 0;
  if (hi <= lo) return { lo, hi, counts: [sorted.length] };
  const counts = new Array(bins).fill(0);
  const span = hi - lo;
  for (const c of sorted) {
    let i = Math.floor(((c - lo) / span) * bins);
    if (i >= bins) i = bins - 1;
    counts[i]++;
  }
  return { lo, hi, counts };
}

function runOptionsFrom(opts: BatchOptions): RunOptions {
  return { collectLog: false, maxSteps: opts.maxSteps, maxCost: opts.maxCost, prices: opts.prices };
}

/** Run the program many times from a fresh base to get expected costs and success rate. */
export function runBatch(
  program: Stmt[],
  base: BowBase,
  ilvl: number,
  runs: number,
  seed: number,
  opts: BatchOptions = {}
): BatchResult {
  const acc = newAcc(seed);
  const runOpts = runOptionsFrom(opts);
  for (let i = 0; i < runs; i++)
    step(acc, program, base, ilvl, seed, i, runOpts, opts.target, opts.startItem);
  return finalize(acc, runs, !!opts.target);
}

export interface BatchControl {
  /** return true to abort the run */
  cancelled?: () => boolean;
  /** called between chunks with completed-fraction in [0, 1] */
  onProgress?: (fraction: number) => void;
  /** attempts per chunk before yielding (default 1000) */
  chunkSize?: number;
}

/** Async, chunked, cancellable version of runBatch. Resolves to null if cancelled. */
export async function runBatchAsync(
  program: Stmt[],
  base: BowBase,
  ilvl: number,
  runs: number,
  seed: number,
  opts: BatchOptions = {},
  control: BatchControl = {}
): Promise<BatchResult | null> {
  const acc = newAcc(seed);
  const runOpts = runOptionsFrom(opts);
  // Optional hard cap on attempts between yields; otherwise yield by wall time
  // so even expensive per-attempt scripts can't block the UI for long.
  const chunk = control.chunkSize ?? Infinity;
  const SLICE_MS = 25;
  let last = now();

  for (let i = 0; i < runs; i++) {
    step(acc, program, base, ilvl, seed, i, runOpts, opts.target, opts.startItem);
    const boundary = (i + 1) % chunk === 0 || now() - last >= SLICE_MS;
    if (boundary && i + 1 < runs) {
      if (control.cancelled?.()) return null;
      control.onProgress?.((i + 1) / runs);
      await new Promise((r) => setTimeout(r, 0));
      last = now();
    }
  }
  if (control.cancelled?.()) return null;
  control.onProgress?.(1);
  return finalize(acc, runs, !!opts.target);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ---- comparison (`compare` blocks): run one batch per option arm ----

/** Build the runnable program for one option: keep all non-compare statements,
 * splice in this option's body for the target compare block, and drop other
 * compare blocks (each comparison is evaluated independently). */
function flattenForOption(program: Stmt[], target: Stmt, body: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s of program) {
    if (s.kind === "compare") {
      if (s === target) out.push(...body);
    } else {
      out.push(s);
    }
  }
  return out;
}

export interface ComparisonOptionResult {
  name: string;
  result: BatchResult;
}
export interface ComparisonGroup {
  condText: string; // the shared success condition, rendered
  line: number;
  options: ComparisonOptionResult[];
}

/** Each top-level `compare` block becomes a group of option programs to batch. */
export function extractComparisons(
  program: Stmt[]
): { cond: Cond; condText: string; line: number; options: { name: string; program: Stmt[] }[] }[] {
  const groups = [];
  for (const s of program) {
    if (s.kind === "compare") {
      groups.push({
        cond: s.cond,
        condText: condToString(s.cond),
        line: s.line,
        options: s.options.map((o) => ({ name: o.name, program: flattenForOption(program, s, o.body) })),
      });
    }
  }
  return groups;
}

/** Run a Monte Carlo batch for every option of every compare block, sharing one
 * progress/cancel control. Each option uses its compare block's condition as the
 * success target. Resolves to null if cancelled. */
export async function runComparisonsAsync(
  program: Stmt[],
  base: BowBase,
  ilvl: number,
  runs: number,
  seed: number,
  opts: BatchOptions = {},
  control: BatchControl = {}
): Promise<ComparisonGroup[] | null> {
  const groups = extractComparisons(program);
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  let done = 0;
  const out: ComparisonGroup[] = [];
  for (const g of groups) {
    const options: ComparisonOptionResult[] = [];
    for (const opt of g.options) {
      const result = await runBatchAsync(opt.program, base, ilvl, runs, seed, { ...opts, target: g.cond }, {
        cancelled: control.cancelled,
        chunkSize: control.chunkSize,
        onProgress: (f) => control.onProgress?.((done + f) / total),
      });
      if (!result) return null; // cancelled
      options.push({ name: opt.name, result });
      done++;
      control.onProgress?.(done / total);
    }
    out.push({ condText: g.condText, line: g.line, options });
  }
  return out;
}
