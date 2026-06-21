# Profit Finder

Finds profitable crafting plays by combining the **crafting simulator** (this
project's engine) with **live trade prices** (the same trade2 API the price
checker uses).

For each *recipe* (a base you buy + a crafting script + the item you sell) it:

1. **Buys** — prices the input base on the trade site (cheapest listings).
2. **Crafts** — Monte-Carlo simulates the script with live currency prices to get
   the expected **currency cost per finished item** and the success rate.
3. **Sells** — prices the crafted result on the trade site.
4. **Profit** = sell − (craft currency + base ÷ success rate).

Results are printed per recipe and ranked.

## Run

From the `poe2-craft` project root:

```bash
npx vite-node tools/profit-finder/finder.ts                 # all recipes, live prices
npx vite-node tools/profit-finder/finder.ts --runs 8000     # steadier cost estimate
npx vite-node tools/profit-finder/finder.ts --only "MS"     # recipes whose name contains "MS"
npx vite-node tools/profit-finder/finder.ts --offline       # simulate only, skip trade API
npx vite-node tools/profit-finder/finder.ts --league "Standard"
```

No login is required: the finder only sends explicit `type_filters` / `stats`
queries (never the weighted "Trade for these items" queries that need a POESESSID).

## Adding / tuning recipes

Edit `recipes.ts`. A recipe carries:

- `script` / `target` — the same crafting DSL as the simulator app. Prototype it
  in the web app first (`npm run dev`), then paste it here.
- `buy` / `sell` — trade `QuerySpec`s (`category`, `baseType`, `rarity`,
  `minSockets`, `minIlvl`, `stats`). Stat ids come from
  `PathOfBuilding-PoE2/src/Data/TradeSiteStats.lua` — grep the `"text"` lines
  (e.g. Movement Speed = `explicit.stat_2250533757`).

### The sell query defines the product — tune it

The estimate is only as good as the `sell` query. A loose query like "any boots
with ≥35% MS" sorts to a **1 ex floor** of junk rares and *understates* the real
product, which is usually a **clean** item (e.g. 35% MS with open suffixes on a
desirable base) that buyers finish themselves. The finder prints the live trade
**URL** for both sides — open it, tighten the filters until the listings match
what you'd actually sell, then translate those filters back into the `sell` spec
and re-run.

## Demand mining (finding multi-mod rare craft targets)

Single-mod magic flips are niche. For richer **rare** crafts, mine what top
builds actually equip:

```bash
cd ../../poe2-pricer    # the miner reuses the pricer's poe.ninja pipeline
npx vite-node src/main/builds/demand-miner.ts            # fetch (resumable) + per-slot report
npx vite-node src/main/builds/demand-miner.ts --report   # aggregate cache only
npx vite-node src/main/builds/demand-miner.ts --slot BodyArmour
```

It caches each build to `tools/profit-finder/.demand-cache/<version>/` and prints,
per slot, the most-used bases + most-common mods = craft targets with real demand.
(Found e.g. evasion chests: 80% want `% Armour, Evasion & ES` + resists.)

### Investigation workflow (start here for any slot)

1. **Demand-mine the slot** → the printed top mods ARE your candidate craft targets.
   Don't guess an archetype — read what top builds actually run. The value axis is
   **commodity vs scarce-premium**, NOT offensive vs defensive: a mod that's
   sufficient at one easy roll (attack speed — yes it's offensive — plus life,
   single resists) stays commodity-priced even at high demand. Value lives in
   **scarce high rolls / combinations** (big added phys+lightning together, crit,
   +skill levels) that are hard to hit at once.
2. **Value-curve test** each candidate spec on the trade site: cheap floor vs a
   fat high-roll tail? (bimodal = trap; steady premium = good.)
3. **Anchor check**: can the key mod be guaranteed by an essence? No anchor + a
   multi-high-roll target = a gamble, not a craft (see the ANCHOR RULE in
   `recipes.ts` DEMAND_RULES).
4. If it passes, add the item class (below) + a recipe; simulate + price it.

### Adding an item class to the craft engine (to simulate its crafts)

Done once per class (example: evasion body armour, key `evBody`):
1. `tools/extract-item-data.lua` — add a `CLASSES` config, then
   `ONLY=evBody tools/luajit-inst/bin/luajit.exe tools/extract-item-data.lua`
   (the `ONLY` filter leaves other classes' scraped weights intact).
2. `scripts/fetch-mod-weights.mjs` — add a poe2db `TARGETS` entry, then
   `ONLY=evBody node scripts/fetch-mod-weights.mjs` (real spawn weights).
3. Create an empty `src/data/evBody.desecrated.json` (`[]`).
4. `src/engine/mods.ts` — add the imports + an `ITEM_CLASSES` entry.

Then write a recipe with `itemClass: "evBody"` and a multi-step DSL script
(essence + exalts, etc.). Example in `recipes.ts`:
"ArEvES% + 2-res rare evasion chest" — ~0.8 div/chest, sells ~1 div median /
~20 div on good rolls (a cheap, high-variance volume craft).

## Auto-scanner (`scanner.ts`)

Hunts for new plays automatically instead of hand-authoring recipes. For every
item class it takes each mod group's **top tier** and computes, with no network:

```
cycles = W_slot / weight(top tier)          # perfect transmute+aug chase
craft  = cycles * (perfectTransmute + perfectAugment)
```

where `W_slot` is the total weight of all perfect-eligible (level 50..ilvl) mods
of that affix slot. It resolves the mod's trade stat id from PoB's
`Data/TradeSiteStats.lua` (text → id), prices only the **feasible** candidates
(craft under `--feasible` divine) plus each class's base once, and ranks by
estimated profit = `sell median − craft − base p25`.

```bash
npx vite-node tools/profit-finder/scanner.ts --offline          # craft estimates only (fast, no network)
npx vite-node tools/profit-finder/scanner.ts --class amulet --max 10
PRICER_GATE_MS=1500 npx vite-node tools/profit-finder/scanner.ts # wider gap if the trade API 429s
```

Flags: `--class <key>`, `--max <n>` (priced candidates per class), `--feasible
<div>` (craft-cost cap), `--league`, `--offline`. It's a coarse first pass — use
it to surface candidates, then promote the good ones to a precise `recipes.ts`
entry (real Monte-Carlo craft cost + tuned buy/sell queries).

## Opportunity analysis (what makes a chase-flip profitable)

Investigated several analogs to the boots play. The decisive factor for a
**transmute/aug chase** flip is how big a slice the target mod is of the
*perfect-eligible* (level ≥ 50) pool for its affix slot:

| Play | Cycles | Craft cost | Sell | Verdict |
|------|-------:|-----------:|------|---------|
| 35% MS + res, 2-sock eva/ES boots | ~23 | ~3 div | ~40 div | ✅ ~30 div profit |
| +3 spell-skills magic Stellar Amulet | ~296 | ~40 div | ~1 div | ❌ measured −40 div |

35% MS is ~1/10 of perfect boots **prefix** rolls, so it lands in ~23 cycles. A
specific skill **suffix** is a tiny slice of the much larger amulet suffix pool →
~296 cycles → the perfect orbs alone cost ~40 div for a ~1 div item.

**Demand rules (market knowledge the math can't see):**
- **Boots** are only worth a premium **with Movement Speed**. A 2-socket boots
  with T1 Life / Eva-ES% / resist but no MS sells for little — those (equally
  cheap) chases are not viable flips. Ignore non-MS boots hits.
- **Weapons** (bows, etc.) are priced by **total DPS**, which needs several damage
  mods together (a finished rare), so the 1-2 mod magic-flip pattern doesn't apply.
  The scanner skips weapons unless you pass `--include-weapons`.
- The pattern fits gear where **one iconic mod + a good base** makes a sought
  crafting base. Boots+MS is the standout; cheap-to-chase ≠ sellable.

**Rules of thumb for new recipes:**
- Chase-flips need either a *small* perfect-eligible affix pool, or a
  **deterministic** method. Essences guarantee a specific mod in one step — but
  there is **no essence for movement speed or skill levels** (checked
  `*.essences.json`); those must be chased.
- Scarcity makes the margin: the boots product stacks ilvl 82 (gates 35% MS) +
  2 augmentable sockets + an eva/ES base + a resist suffix. 2-socket magic MS
  boots are **never** sitting on the market (they sell instantly) — a sign of
  real demand, which is why the override is needed to value them.
- Same boots craft, **other defence-type bases** (str/int, str/dex, …) is the
  most promising untested variant: identical cheap craft, likely-similar fast
  market, possibly less competition. Swap the `ev`/`es` filters for `ar`+`es`,
  `ar`+`ev`, etc.

`REJECTED_CANDIDATES` in `recipes.ts` keeps the measured-unprofitable amulet play
as a template (it is **not** run by default).

## Gotchas (learned building this)

- On boots, **Movement Speed is a PREFIX**; 35% (`Hellion's`) is the level-82 top
  tier, so the item level must be 82 for it to roll.
- Trade `type` (exact base) and `category` are **mutually exclusive** — sending
  both returns 0 results.
- The socket filter id is **`rune_sockets`** = the trade site's "Augmentable
  Sockets" (empty rune sockets). It works on magic items too.
- To target dex-int (evasion/ES) bases without naming a base type, use the
  `equipment_filters` **`ev`** + **`es`** filters (`minEvasion` / `minEnergyShield`
  in a `QuerySpec`) — both > 0 means a base with evasion *and* energy shield.
