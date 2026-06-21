// Auto-scanner (profit-finder v2): for every item class, estimate which single
// top-tier mod is worth chasing onto a cheap magic base and flipping.
//
// For each group's top tier it computes, with NO network:
//   cycles  = W_slot / weight(top tier)             (attempts to land the target)
//   craft   = cycles * (annul + perfectAugment)     (one re-roll of the slot)
// where W_slot is the total weight of all perfect-eligible (level 50..ilvl) mods
// of that affix slot. A small W_slot / big top-tier weight ⇒ cheap chase (this is
// exactly why 35% MS boots works and +3-skill amulets don't).
//
// NOTE: PoE2 0.5 has no Orb of Scouring, so a magic item is re-rolled with
// Annulment (remove a random mod) + perfect augment — annuls dominate the cost.
//
// Then it resolves the mod's trade stat id from PoB's Data/TradeSiteStats.lua,
// prices only the feasible candidates (magic base + that mod) plus each class's
// base once, and ranks by estimated profit.
//
// Run from the poe2-craft root:
//   npx vite-node tools/profit-finder/scanner.ts
//   npx vite-node tools/profit-finder/scanner.ts --class amulet --max 10
//   npx vite-node tools/profit-finder/scanner.ts --offline   # craft estimates only

import { readFileSync } from "node:fs";
import { setItemClass, ALL_MODS } from "../../src/engine/mods";
import { DEFAULT_PRICES, PRICE_LEAGUE } from "../../src/engine/prices";
import { getRates, priceQuery, buildQuery, type RateTable, type QuerySpec } from "./trade";

const PERFECT_MIN_LEVEL = 50; // perfect transmute/aug force the added mod's level >= 50
// One re-roll of an affix slot on a magic item (no scouring in PoE2 0.5):
// Annulment removes a random mod, perfect augment adds a level>=50 one.
const CYCLE_EX = (DEFAULT_PRICES.annul ?? 79) + (DEFAULT_PRICES.perfectAugment ?? 14);

interface ClassConfig {
  key: string; // craft-engine item class key
  ilvl: number;
  /** trade query to price the cheap input base. */
  buy: QuerySpec;
  /** sell-side filters merged with the per-mod stat (category, sockets, ev/es…). */
  sellBase: QuerySpec;
  /** Does the single-mod magic-flip pattern apply to this class at all? Weapons
   * are priced by TOTAL DPS (need many mods), so a 1-2 mod magic flip never works.
   * See DEMAND_RULES in recipes.ts. */
  flipViable: boolean;
  /** Domain note shown in output (e.g. which mod the market actually requires). */
  demand?: string;
}

const CLASSES: ClassConfig[] = [
  {
    key: "dexIntBoots",
    ilvl: 82,
    buy: { category: "armour.boots", rarity: "normal", minIlvl: 82, minSockets: 2, minEvasion: 1, minEnergyShield: 1 },
    sellBase: { category: "armour.boots", rarity: "magic", minSockets: 2, minEvasion: 1, minEnergyShield: 1 },
    flipViable: true,
    demand: "boots only sell at a premium WITH Movement Speed — ignore non-MS hits",
  },
  {
    key: "amulet",
    ilvl: 82,
    buy: { category: "accessory.amulet", rarity: "normal", minIlvl: 75 },
    sellBase: { category: "accessory.amulet", rarity: "magic" },
    flipViable: true,
  },
  {
    key: "ring",
    ilvl: 82,
    buy: { category: "accessory.ring", rarity: "normal", minIlvl: 75 },
    sellBase: { category: "accessory.ring", rarity: "magic" },
    flipViable: true,
    demand: "bimodal trap — craftable rolls = ~1ex commodity, only god-rolls (mirror) hold value",
  },
  {
    // Weapons are priced by TOTAL DPS (many damage mods together), so a 1-2 mod
    // magic flip never works. Off by default; skipped unless --include-weapons.
    key: "bow",
    ilvl: 82,
    buy: { category: "weapon.bow", rarity: "normal", minIlvl: 80 },
    sellBase: { category: "weapon.bow", rarity: "magic" },
    flipViable: false,
    demand: "weapon value = total DPS, not single mods — magic flips don't apply",
  },
];

interface Args {
  league: string;
  offline: boolean;
  classKey?: string;
  maxPerClass: number;
  feasibleDiv: number;
  includeWeapons: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { league: PRICE_LEAGUE, offline: false, maxPerClass: 8, feasibleDiv: 8, includeWeapons: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--offline") a.offline = true;
    else if (v === "--class") a.classKey = argv[++i];
    else if (v === "--league") a.league = argv[++i];
    else if (v === "--max") a.maxPerClass = Number(argv[++i]);
    else if (v === "--feasible") a.feasibleDiv = Number(argv[++i]);
    else if (v === "--include-weapons") a.includeWeapons = true;
  }
  return a;
}

/** Normalize a mod / trade line: collapse all numbers & ranges to "#". */
function norm(line: string): string {
  return line
    .replace(/\(\d+(?:\.\d+)?-\d+(?:\.\d+)?\)/g, "#") // (a-b) ranges
    .replace(/\d+(?:\.\d+)?/g, "#") // bare numbers
    .replace(/#+/g, "#")
    .replace(/\+/g, "") // engine writes "+#%", trade writes "#%"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Build normalized-text -> trade stat id from PoB's TradeSiteStats.lua. */
function loadTradeStats(): Map<string, string> {
  const path = "../PathOfBuilding-PoE2/src/Data/TradeSiteStats.lua";
  const text = readFileSync(path, "utf8");
  const re = /\["id"\]\s*=\s*"([^"]+)"[\s\S]*?\["text"\]\s*=\s*"([^"]+)"/g;
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, id, txt] = m;
    const key = norm(txt);
    // Prefer explicit.* ids; don't overwrite an explicit with a pseudo/implicit.
    const existing = map.get(key);
    if (!existing || (id.startsWith("explicit.") && !existing.startsWith("explicit."))) map.set(key, id);
  }
  return map;
}

/** Parse the first numeric value (range min or bare number) in a mod line. */
function firstValue(line: string): number {
  const range = line.match(/\((\d+(?:\.\d+)?)-\d+/);
  if (range) return Math.floor(Number(range[1]));
  const num = line.match(/(\d+(?:\.\d+)?)/);
  return num ? Math.floor(Number(num[1])) : 1;
}

interface Candidate {
  classKey: string;
  slot: "Prefix" | "Suffix";
  group: string;
  line: string; // top-tier rolled text
  topWeight: number;
  cycles: number;
  craftEx: number;
  statId?: string;
  sellMin: number;
}

/** Enumerate per-class top-tier chase candidates with analytic craft cost. */
function candidatesFor(cfg: ClassConfig, stats: Map<string, string>): Candidate[] {
  setItemClass(cfg.key);
  const eligible = ALL_MODS.filter((m) => m.level >= PERFECT_MIN_LEVEL && m.level <= cfg.ilvl);
  const wSlot: Record<string, number> = { Prefix: 0, Suffix: 0 };
  for (const m of eligible) wSlot[m.type] += m.weight;

  // top tier (highest level) per group, among perfect-eligible mods
  const byGroup = new Map<string, typeof eligible>();
  for (const m of eligible) {
    const arr = byGroup.get(m.group) ?? [];
    arr.push(m);
    byGroup.set(m.group, arr);
  }

  const out: Candidate[] = [];
  for (const [group, mods] of byGroup) {
    const top = mods.reduce((a, b) => (b.level > a.level ? b : a));
    if (top.lines.length !== 1) continue; // skip hybrids (hard to price by one stat)
    const slotW = wSlot[top.type];
    if (!slotW || !top.weight) continue;
    const cycles = slotW / top.weight;
    out.push({
      classKey: cfg.key,
      slot: top.type as "Prefix" | "Suffix",
      group,
      line: top.lines[0],
      topWeight: top.weight,
      cycles,
      craftEx: cycles * CYCLE_EX,
      statId: stats.get(norm(top.lines[0])),
      sellMin: firstValue(top.lines[0]),
    });
  }
  return out;
}

const fmtDiv = (ex: number | undefined, r: RateTable) =>
  ex == null || !isFinite(ex) ? "—" : `${(ex / (r.divine || 1)).toFixed(2)}d`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stats = loadTradeStats();
  const rates = args.offline ? { exalted: 1, divine: 175 } : await getRates(args.league);
  const classes = args.classKey ? CLASSES.filter((c) => c.key === args.classKey) : CLASSES;
  const feasibleEx = args.feasibleDiv * (rates.divine || 175);

  console.log(`League: ${args.league}   1 div = ${(rates.divine || 0).toFixed(0)} ex`);
  console.log(`Trade stats loaded: ${stats.size}   feasible craft cap: ${args.feasibleDiv} div\n`);

  interface Row {
    label: string;
    profitEx?: number;
    line: string;
  }
  const rows: Row[] = [];

  for (const cfg of classes) {
    if (!cfg.flipViable && !args.includeWeapons) {
      console.log(`▶ ${cfg.key}: skipped — ${cfg.demand} (use --include-weapons to force)\n`);
      continue;
    }
    const all = candidatesFor(cfg, stats);
    // feasible = cheap enough to chase AND priceable (trade id resolved)
    const feasible = all
      .filter((c) => c.craftEx <= feasibleEx && c.statId)
      .sort((a, b) => a.craftEx - b.craftEx)
      .slice(0, args.maxPerClass);

    console.log(
      `▶ ${cfg.key}: ${all.length} top-tier mods, ` +
        `${all.filter((c) => c.craftEx <= feasibleEx).length} feasible, ` +
        `${feasible.length} priced (${all.filter((c) => !c.statId).length} unmapped)`
    );
    if (cfg.demand) console.log(`   demand: ${cfg.demand}`);

    // price the input base once per class
    let baseEx: number | undefined;
    if (!args.offline) {
      try {
        const b = await priceQuery(args.league, buildQuery(cfg.buy), rates);
        baseEx = b.count ? b.p25Ex ?? b.lowEx : undefined;
        console.log(`   base buy: ${fmtDiv(baseEx, rates)} (p25, ${b.count}/${b.total} listings)`);
      } catch (e) {
        console.log(`   base buy: failed — ${(e as Error).message}`);
      }
    }

    for (const c of feasible) {
      let sellEx: number | undefined;
      let total = 0;
      if (!args.offline) {
        try {
          const sell = await priceQuery(
            args.league,
            buildQuery({ ...cfg.sellBase, stats: [{ id: c.statId!, min: c.sellMin }] }),
            rates
          );
          total = sell.total;
          sellEx = sell.count ? sell.medianEx : undefined;
        } catch {
          /* leave undefined */
        }
      }
      const profitEx =
        sellEx != null && baseEx != null ? sellEx - c.craftEx - baseEx : undefined;
      const tag = `${c.classKey} · ${c.line}`;
      rows.push({
        label: tag,
        profitEx,
        line:
          `  ${tag}\n` +
          `     chase ~${c.cycles.toFixed(0)} cycles → craft ${fmtDiv(c.craftEx, rates)}` +
          (args.offline
            ? ""
            : `  sell ${fmtDiv(sellEx, rates)} (${total} listed)  ` +
              `PROFIT ${profitEx != null ? fmtDiv(profitEx, rates) : "—"}`),
      });
    }
    console.log("");
  }

  // report
  if (args.offline) {
    console.log("CHEAPEST CHASES (craft cost only, by class then cost):");
    for (const r of rows.slice(0, 50)) console.log(r.line);
    return;
  }
  const ranked = rows.filter((r) => r.profitEx != null).sort((a, b) => b.profitEx! - a.profitEx!);
  console.log("─".repeat(64));
  console.log("PROFIT RANKING (per item: sell median − craft − base p25)");
  console.log("─".repeat(64));
  for (const r of ranked.slice(0, 20)) console.log(r.line);
  const noMarket = rows.filter((r) => r.profitEx == null);
  if (noMarket.length) console.log(`\n(${noMarket.length} candidates had no live market to price)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
