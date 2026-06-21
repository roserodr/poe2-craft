// Fetches current PoE2 currency prices (in Exalted Orbs) and writes
// src/data/prices.json. Source: poe2scout.com community API, which exposes
// the same Currency-Exchange data shown on poe.ninja but with a clean,
// documented JSON API (poe.ninja's own economy endpoint is behind
// runtime-obfuscated chunks and isn't reachable without a headless browser).
//
//   node scripts/fetch-prices.mjs
//
// Run it on a schedule (cron / GH Action) to keep prices fresh.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://poe2scout.com/api";
const REALM = "poe2";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "prices.json");

// Map our currency keys -> the poe2scout ApiId to read CurrentPrice from.
// `category` tells the fetcher which list to look in.
const API_MAP = {
  exalt: { id: "exalted", category: "currency" },
  chaos: { id: "chaos", category: "currency" },
  annul: { id: "annul", category: "currency" },
  divine: { id: "divine", category: "currency" },
  vaal: { id: "vaal", category: "currency" },
  fracture: { id: "fracturing-orb", category: "currency" },
  // Greater / Perfect tiered orbs
  greaterTransmute: { id: "greater-orb-of-transmutation", category: "currency" },
  perfectTransmute: { id: "perfect-orb-of-transmutation", category: "currency" },
  greaterAugment: { id: "greater-orb-of-augmentation", category: "currency" },
  perfectAugment: { id: "perfect-orb-of-augmentation", category: "currency" },
  greaterRegal: { id: "greater-regal-orb", category: "currency" },
  perfectRegal: { id: "perfect-regal-orb", category: "currency" },
  greaterChaos: { id: "greater-chaos-orb", category: "currency" },
  perfectChaos: { id: "perfect-chaos-orb", category: "currency" },
  greaterExalt: { id: "greater-exalted-orb", category: "currency" },
  perfectExalt: { id: "perfect-exalted-orb", category: "currency" },
  // representative single picks (these mechanics span many tiers/bones):
  essence: { id: "essence-of-abrasion", category: "essences" }, // bow phys essence
  desecrate: { id: "amanamus-gaze", category: "abyss" }, // cheapest boss bone
  // Omens (in poe2scout's "ritual" category, ApiId = omen-of-<key with '-'>).
  // Keyed by our OMENS keys (item.ts). Untracked ones fall back to ESTIMATES.
  "sinistral erasure": { id: "omen-of-sinistral-erasure", category: "ritual" },
  "dextral erasure": { id: "omen-of-dextral-erasure", category: "ritual" },
  "sinistral annulment": { id: "omen-of-sinistral-annulment", category: "ritual" },
  "dextral annulment": { id: "omen-of-dextral-annulment", category: "ritual" },
  whittling: { id: "omen-of-whittling", category: "ritual" },
  light: { id: "omen-of-light", category: "ritual" },
  "abyssal echoes": { id: "omen-of-abyssal-echoes", category: "ritual" },
  "dextral crystallisation": { id: "omen-of-dextral-crystallisation", category: "ritual" },
  "sinistral crystallisation": { id: "omen-of-sinistral-crystallisation", category: "ritual" },
};

// Currencies poe2scout doesn't track individually (near-vendor cheap).
// Documented estimates in Exalted Orbs; tweak as needed.
const ESTIMATES = {
  transmute: 0.05,
  augment: 0.1,
  alchemy: 0.3,
  regal: 0.3,
  whetstone: 0.05,
  scour: 0,
  // Greater low-orbs aren't individually tracked on poe2scout:
  greaterTransmute: 2,
  greaterAugment: 2,
  // Omens poe2scout doesn't list (exalt/regal/reveal-slot omens). Rough estimates.
  "sinistral exaltation": 150,
  "dextral exaltation": 150,
  "greater exaltation": 40,
  "sinistral coronation": 30,
  "dextral coronation": 30,
  "sinistral necromancy": 25,
  "dextral necromancy": 25,
  catalysing: 25,
};

function get(url) {
  return fetch(url, { headers: { "User-Agent": "poe2-craft/price-fetch" } }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  });
}

async function fetchCategory(league, category) {
  const url = `${API}/${REALM}/Leagues/${encodeURIComponent(
    league
  )}/Currencies/ByCategory?Category=${category}&perPage=200`;
  const data = await get(url);
  const byId = {};
  for (const it of data.Items || []) byId[it.ApiId] = it.CurrentPrice;
  return byId;
}

async function main() {
  const leagues = await get(`${API}/${REALM}/Leagues`);
  const current =
    leagues.find((l) => l.IsCurrent && !/^HC/i.test(l.Value)) ||
    leagues.find((l) => l.IsCurrent) ||
    leagues[0];
  const league = current.Value;
  console.log(`Current league: ${league} (Divine ≈ ${current.DivinePrice?.toFixed(0)} ex)`);

  const cats = [...new Set(Object.values(API_MAP).map((m) => m.category))];
  const tables = {};
  for (const c of cats) tables[c] = await fetchCategory(league, c);

  const prices = {};
  const provenance = {};
  for (const [key, { id, category }] of Object.entries(API_MAP)) {
    const price = tables[category]?.[id];
    if (typeof price === "number") {
      prices[key] = Math.round(price * 100) / 100;
      provenance[key] = `live: ${id}`;
    } else {
      console.warn(`! no live price for ${key} (${category}/${id})`);
    }
  }
  for (const [key, val] of Object.entries(ESTIMATES)) {
    prices[key] = val;
    provenance[key] = "estimate (not individually tracked)";
  }

  const out = {
    unit: "Exalted Orb",
    league,
    updated: new Date().toISOString().slice(0, 10),
    source: "https://poe2scout.com",
    prices,
    provenance,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT}`);
  console.log(prices);
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
