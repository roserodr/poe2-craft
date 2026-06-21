// Patches real spawn weights into src/data/bow.mods.json from poe2db.
//
// PoB's data encodes bow mods as weight = 1 (eligibility only). poe2db's Bows
// page embeds the full modifier table as JSON, including a "DropChance" field
// which is the real spawn weight. This script scrapes that and overwrites the
// `weight` of each matching mod (matched by affix name + required level).
// (Only weapon class pages embed this data; armour mod weights stay uniform.)
//
//   node scripts/fetch-mod-weights.mjs          # patch bow.mods.json
//   node scripts/fetch-mod-weights.mjs --dry    # report only, no write
//
// Run it after the Lua extractor (which regenerates bow.mods.json with weight 1).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DRY = process.argv.includes("--dry");
const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");

// Each item class's poe2db ModifiersCalc page + the mods file to patch.
const TARGETS = [
  { name: "bow", url: "https://poe2db.tw/us/Bows", file: "bow.mods.json" },
  { name: "dexIntBoots", url: "https://poe2db.tw/us/Boots_dex_int", file: "dexIntBoots.mods.json" },
  { name: "amulet", url: "https://poe2db.tw/us/Amulets", file: "amulet.mods.json" },
  { name: "ring", url: "https://poe2db.tw/us/Rings", file: "ring.mods.json" },
  { name: "evBody", url: "https://poe2db.tw/us/Body_Armours_dex", file: "evBody.mods.json" },
  { name: "gloves", url: "https://poe2db.tw/us/Gloves_str_dex", file: "gloves.mods.json" },
  { name: "esHelm", url: "https://poe2db.tw/us/Helmets_int", file: "esHelm.mods.json" },
  { name: "spear", url: "https://poe2db.tw/us/Spears", file: "spear.mods.json" },
  { name: "sceptre", url: "https://poe2db.tw/us/Sceptres", file: "sceptre.mods.json" },
  { name: "wand", url: "https://poe2db.tw/us/Wands", file: "wand.mods.json" },
];

const RE =
  /"Name":"([^"]*)","Level":"(\d+)","ModGenerationTypeID":"(\d+)","ModFamilyList":\[[^\]]*\],"DropChance":"?(\d+)"?/g;

function key(name, level) {
  return name.trim().toLowerCase() + "|" + level;
}

function mode(arr) {
  const counts = new Map();
  let best = arr[0];
  let bestN = 0;
  for (const v of arr) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

async function patch(target) {
  const html = await fetch(target.url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} fetching ${target.url}`);
    return r.text();
  });

  // name|level -> weight (take the max if it appears more than once)
  const weights = new Map();
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(html)) !== null) {
    const [, name, level, , drop] = m;
    if (!name) continue;
    const k = key(name, level);
    weights.set(k, Math.max(weights.get(k) ?? 0, Number(drop)));
  }

  const file = join(DATA, target.file);
  const mods = JSON.parse(readFileSync(file, "utf8"));

  // First pass: direct match by affix name + level.
  let matched = 0;
  const groupWeights = new Map(); // group -> [weights of matched mods]
  const unmatched = [];
  for (const mod of mods) {
    const w = weights.get(key(mod.affix, String(mod.level)));
    if (w !== undefined) {
      mod.weight = w;
      matched++;
      (groupWeights.get(mod.group) ?? groupWeights.set(mod.group, []).get(mod.group)).push(w);
    } else {
      unmatched.push(mod);
    }
  }

  // Second pass: fall back to the group's typical weight (poe2db sometimes omits
  // a tier PoB still lists). Use the most common weight seen in that group.
  const fallbackUsed = [];
  const stillUnmatched = [];
  for (const mod of unmatched) {
    const ws = groupWeights.get(mod.group);
    if (ws && ws.length) {
      mod.weight = mode(ws);
      fallbackUsed.push(`${mod.type} "${mod.affix}" i${mod.level} (${mod.group}) -> ${mod.weight}`);
    } else {
      stillUnmatched.push(`${mod.type} "${mod.affix}" i${mod.level} (${mod.group})`);
    }
  }

  console.log(
    `\n[${target.name}] scraped ${weights.size} entries; matched ${matched}/${mods.length} directly, ` +
      `${fallbackUsed.length} via group fallback, ${stillUnmatched.length} left unchanged.`
  );
  for (const u of stillUnmatched) console.log("  ! " + u);

  if (!DRY) {
    writeFileSync(file, JSON.stringify(mods) + "\n");
    console.log(`  wrote ${target.file}`);
  }
}

async function main() {
  // ONLY=<name> patches just that class (avoids re-scraping the others).
  const only = process.env.ONLY;
  for (const t of TARGETS) if (!only || t.name === only) await patch(t);
  if (DRY) console.log("\n(dry run — nothing written)");
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
