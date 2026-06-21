// Profit finder: for each recipe, price the input base + the crafted result
// live, simulate the craft cost via the Monte Carlo engine, and report expected
// profit per item.
//
// Run from the poe2-craft project root:
//   npx vite-node tools/profit-finder/finder.ts
//   npx vite-node tools/profit-finder/finder.ts --runs 8000 --only "MS"

import { setItemClass, ALL_BASES, activeClass } from "../../src/engine/mods";
import { buildStartItem } from "../../src/engine/item";
import { RNG } from "../../src/engine/rng";
import { parse, parseCondition } from "../../src/dsl/parser";
import { runBatch } from "../../src/dsl/batch";
import { fullPrices, DEFAULT_PRICES, PRICE_LEAGUE } from "../../src/engine/prices";
import { getRates, priceQuery, buildQuery, type RateTable, type PriceSummary } from "./trade";
import { RECIPES, type Recipe } from "./recipes";

interface Args {
  runs?: number;
  only?: string;
  league: string;
  offline: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { league: PRICE_LEAGUE, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--runs") a.runs = Number(argv[++i]);
    else if (v === "--only") a.only = argv[++i];
    else if (v === "--league") a.league = argv[++i];
    else if (v === "--offline") a.offline = true;
  }
  return a;
}

interface CraftCost {
  successRate: number;
  /** expected currency cost per *successful* item, in Exalted (excludes base). */
  currencyPerSuccess: number;
  /** human-readable breakdown of currency used per attempt. */
  perAttempt: Record<string, number>;
}

/** Simulate the craft and return cost-per-success metrics. */
function simulate(recipe: Recipe, runs: number): CraftCost {
  setItemClass(recipe.itemClass);
  const base =
    (recipe.baseName && ALL_BASES.find((b) => b.name === recipe.baseName)) || ALL_BASES[0];
  if (!base) throw new Error(`no base for item class "${recipe.itemClass}"`);

  const program = parse(recipe.script);
  const target = parseCondition(recipe.target);
  const prices = fullPrices(DEFAULT_PRICES);

  // Build the starting item template (cloned per attempt inside runBatch).
  const seed = 0x5eed;
  const { item: startItem, errors } = buildStartItem(
    base,
    recipe.ilvl,
    recipe.startRarity,
    recipe.startMods ?? [],
    new RNG(seed)
  );
  if (errors.length) console.warn(`  ⚠ start-item: ${errors.join("; ")}`);

  const res = runBatch(program, base, recipe.ilvl, runs, seed, { target, prices, startItem });
  const currencyPerSuccess = res.successRate > 0 ? res.cost.avg / res.successRate : Infinity;
  return { successRate: res.successRate, currencyPerSuccess, perAttempt: res.avgSpent };
}

const fmtEx = (ex?: number) => (ex == null || !isFinite(ex) ? "—" : `${ex.toFixed(ex < 10 ? 1 : 0)} ex`);
const fmtDiv = (ex: number | undefined, rates: RateTable) =>
  ex == null || !isFinite(ex) ? "—" : `${(ex / (rates.divine || 1)).toFixed(2)} div`;

function summaryLine(label: string, s: PriceSummary, rates: RateTable): string {
  return (
    `${label}: low ${fmtDiv(s.lowEx, rates)} / p25 ${fmtDiv(s.p25Ex, rates)} / median ${fmtDiv(
      s.medianEx,
      rates
    )} / p90 ${fmtDiv(s.p90Ex, rates)}  [${s.count}/${s.total} listings]\n           ${s.url}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const recipes = args.only
    ? RECIPES.filter((r) => r.name.toLowerCase().includes(args.only!.toLowerCase()))
    : RECIPES;
  if (!recipes.length) {
    console.error(`no recipes match --only "${args.only}"`);
    process.exit(1);
  }

  const rates = args.offline ? await getRates("___none___") : await getRates(args.league);
  console.log(`League: ${args.league}   1 div = ${(rates.divine || 0).toFixed(0)} ex\n`);

  const rows: { name: string; profitEx: number; line: string }[] = [];

  for (const recipe of recipes) {
    const runs = args.runs ?? recipe.runs ?? 4000;
    console.log(`▶ ${recipe.name}`);

    // 1. craft simulation
    const craft = simulate(recipe, runs);
    setItemClass(recipe.itemClass); // keep active class for any logging
    console.log(
      `  craft: success ${(craft.successRate * 100).toFixed(1)}%  ` +
        `currency/success ${fmtDiv(craft.currencyPerSuccess, rates)} (${fmtEx(craft.currencyPerSuccess)})`
    );
    const spentParts = Object.entries(craft.perAttempt)
      .filter(([, n]) => n > 0.001)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n.toFixed(2)}×${k}`);
    if (spentParts.length) console.log(`         per attempt: ${spentParts.join(", ")}`);

    // 2. live prices
    let buy: PriceSummary | undefined;
    let sell: PriceSummary | undefined;
    if (!args.offline) {
      try {
        buy = await priceQuery(args.league, buildQuery(recipe.buy), rates);
        console.log("  " + summaryLine("buy base ", buy, rates));
      } catch (e) {
        console.log(`  buy base : price failed — ${(e as Error).message}`);
      }
      try {
        sell = await priceQuery(args.league, buildQuery(recipe.sell), rates);
        console.log("  " + summaryLine("sell item", sell, rates));
        if (recipe.sell.minSockets && sell.total === 0)
          console.log(
            `           (no ${recipe.sell.minSockets}-socket listings right now — too thin to price live)`
          );
      } catch (e) {
        console.log(`  sell item: price failed — ${(e as Error).message}`);
      }
    }

    // 3. profit
    const div = rates.divine || 1;
    // Buy at the realistic cheapest you'd pay (p25 ignores single troll/steal
    // listings); fall back to the floor, then a manual override.
    const liveBuyEx = buy?.count ? buy.p25Ex ?? buy.lowEx : undefined;
    const baseEx = liveBuyEx ?? (recipe.buyOverrideDiv != null ? recipe.buyOverrideDiv * div : undefined);
    if (liveBuyEx == null && recipe.buyOverrideDiv != null)
      console.log(`  buy base : using override ${recipe.buyOverrideDiv} div (${fmtEx(baseEx)})`);
    // Sell value: prefer the live (socket-filtered) median; fall back to override.
    const liveSellEx = sell?.count ? sell.medianEx : undefined;
    const sellEx = liveSellEx ?? (recipe.sellOverrideDiv != null ? recipe.sellOverrideDiv * div : undefined);
    if (liveSellEx == null && recipe.sellOverrideDiv != null)
      console.log(`  sell item: using override ${recipe.sellOverrideDiv} div (${fmtEx(sellEx)})`);
    if (baseEx != null && sellEx != null && isFinite(craft.currencyPerSuccess)) {
      // each successful item consumes (1 / successRate) bases on average.
      const basePerSuccess = craft.successRate > 0 ? baseEx / craft.successRate : Infinity;
      const totalCost = craft.currencyPerSuccess + basePerSuccess;
      const profit = sellEx - totalCost;
      const profitHi = liveSellEx != null && sell?.p90Ex != null ? sell.p90Ex - totalCost : undefined;
      console.log(
        `  ➜ cost/item ${fmtDiv(totalCost, rates)}  sell ${fmtDiv(sellEx, rates)}  ` +
          `PROFIT ${fmtDiv(profit, rates)}` +
          (profitHi != null ? `  (@p90-roll ${fmtDiv(profitHi, rates)})` : "")
      );
      rows.push({
        name: recipe.name,
        profitEx: profit,
        line: `${recipe.name.padEnd(34)} ${fmtDiv(profit, rates).padStart(10)}  (sell ${fmtDiv(
          sellEx,
          rates
        )} − cost ${fmtDiv(totalCost, rates)})`,
      });
    } else if (args.offline) {
      console.log(`  (offline: skipped live prices)`);
    }
    console.log("");
  }

  if (rows.length) {
    rows.sort((a, b) => b.profitEx - a.profitEx);
    console.log("─".repeat(60));
    console.log("PROFIT RANKING (per item, median market prices)");
    console.log("─".repeat(60));
    for (const r of rows) console.log(r.line);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
