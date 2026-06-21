// Print a sample crafted item from each recipe (a Monte-Carlo run that met the
// target), so you can see the actual rolled affixes.
//   npx vite-node tools/profit-finder/samples.ts [--only <substr>]

import { setItemClass, ALL_BASES, renderModInline } from "../../src/engine/mods";
import { buildStartItem, newItem } from "../../src/engine/item";
import { RNG } from "../../src/engine/rng";
import { parse, parseCondition } from "../../src/dsl/parser";
import { runBatch } from "../../src/dsl/batch";
import { fullPrices, DEFAULT_PRICES } from "../../src/engine/prices";
import { RECIPES, type Recipe } from "./recipes";
import type { Item, RolledMod } from "../../src/engine/types";

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1].toLowerCase() : undefined;
})();

function line(m: RolledMod): string {
  const tags = [m.fractured && "fractured", m.desecrated && "desecrated", m.essence && "essence"]
    .filter(Boolean)
    .join(",");
  return `${renderModInline(m)}${tags ? `  [${tags}]` : ""}`;
}

function sampleFor(recipe: Recipe): Item | undefined {
  setItemClass(recipe.itemClass);
  const base = (recipe.baseName && ALL_BASES.find((b) => b.name === recipe.baseName)) || ALL_BASES[0];
  const program = parse(recipe.script);
  const target = parseCondition(recipe.target);
  const prices = fullPrices(DEFAULT_PRICES);
  const seed = 0x5eed;
  const start = recipe.startMods?.length
    ? buildStartItem(base, recipe.ilvl, recipe.startRarity, recipe.startMods, new RNG(seed)).item
    : undefined;
  // enough runs to land a passing sample even for low-success recipes
  const res = runBatch(program, base, recipe.ilvl, recipe.runs ?? 4000, seed, {
    target,
    prices,
    startItem: start,
  });
  return res.sample;
}

for (const recipe of RECIPES) {
  if (only && !recipe.name.toLowerCase().includes(only)) continue;
  console.log(`\n═══ ${recipe.name}  (${recipe.itemClass}, ${recipe.baseName ?? "?"}) ═══`);
  const it = sampleFor(recipe);
  if (!it) {
    console.log("  (no passing sample — raise runs)");
    continue;
  }
  console.log(`  ${it.rarity}  ${it.base.name}`);
  for (const m of it.prefixes) console.log(`   P  ${line(m)}`);
  for (const m of it.suffixes) console.log(`   S  ${line(m)}`);
}
