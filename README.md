# PoE2 Bow Crafting Simulator

A web app that simulates Path of Exile 2 crafting on bows, driven by a small
domain-specific language (DSL). Write a crafting recipe like:

```
alchemy
while not has prefix "increased physical damage" {
  chaos
}
if open prefix {
  exalt
}
```

…and either run it once (with a full step-by-step log and the resulting item)
or Monte-Carlo it thousands of times to get expected currency cost and the
probability of hitting a target.

## Running

```
npm install
npm run dev        # dev server
npm run build      # typecheck + production build
npm test           # run the Vitest unit suite
npm run test:watch # watch mode
```

## Affix pool

The **Affix Pool** panel lists every modifier that can roll on the current bow
at its item level, grouped into prefixes/suffixes with tier, required level,
spawn weight, and the per-add chance within each slot.

Spawn weights come from [poe2db](https://poe2db.tw/us/Bows#ModifiersCalc) (its
`DropChance` field) and drive the simulator's weighted rolls. PoB's own data
only encodes eligibility (weight 1), so weights are patched in by
`scripts/fetch-mod-weights.mjs` — **run it after the Lua extractor** (which
resets `bowMods.json` to weight 1):

```
luajit tools\extract-item-data.lua     # regenerate all classes from PoB (weights = 1)
node scripts/fetch-mod-weights.mjs     # patch real weights from poe2db (all classes)
```

`fetch-mod-weights.mjs` patches every class listed in its `TARGETS` from the
matching poe2db ModifiersCalc page (e.g. `/us/Bows`, `/us/Boots_dex_int`) — add
a new class's URL there.

## Tests

Unit tests live next to the code as `*.test.ts` and run under
[Vitest](https://vitest.dev). They cover the seeded RNG, mod rolling/rendering,
every currency (including Greater/Perfect tiers, fracturing, desecration, and
the essence rules), affix-cap / one-mod-per-group / one-crafted-mod invariants,
the DSL lexer/parser/interpreter, the Monte-Carlo batch runner, and price
formatting. **When adding new functionality, add tests alongside it.**

## The DSL

**Currencies** (each is one command): `transmute`, `augment`, `alchemy`,
`regal`, `exalt`, `chaos`, `annul`, `divine`, `vaal`, `whetstone`,
`fracture`, `desecrate`, `essence "<name>"`,
`scour` (sim-only reset, not a real PoE2 orb).

**Tiered orbs (0.5 "Runes of Aldur"):** prefix `transmute`, `augment`, `regal`,
`chaos`, or `exalt` with `greater` or `perfect` — e.g. `greater exalt`,
`perfect chaos`. They work like the base orb but force the added modifier to be
at least mod level **35** (greater) or **50** (perfect), per poe2db.

**Omens** modify the next currency use. Attach one with `with "..."` (matched by
name within that currency, so partial text works):

- `exalt with "sinistral"` / `"dextral"` — add a prefix / suffix
- `exalt with "greater exaltation"` — add two modifiers
- `exalt with "homogenising"` — add a mod sharing a tag with an existing one
- `regal with "sinistral"` / `"dextral"` — Regal adds a prefix / suffix
- `chaos with "sinistral erasure"` / `"dextral erasure"` — remove a prefix / suffix
- `annul with "sinistral"` / `"dextral"` — remove a prefix / suffix
- `annul with "whittling"` — remove the lowest-level modifier
- `essence "perfect …" with "sinistral"` / `"dextral"` — Perfect essence removes a prefix / suffix (Crystallisation)
- `reveal with "sinistral"` / `"dextral"` — revealed desecrated mod is a prefix / suffix (Necromancy)
- `reveal with "abyssal echoes"` — the reveal offers more options (6 instead of 3)

They compose with tiers, e.g. `perfect exalt with "dextral"`, and **multiple
omens can be combined** with `and` or another `with` — e.g.
`exalt with "greater" and "sinistral"` adds two prefixes. Conflicting omens
(prefix + suffix) are rejected. The full list is in the in-app **Omens** panel.

### Essence / Fracturing / Desecration

- **`essence "<name>"`** — applies a *guaranteed* modifier. Lesser/normal/Greater
  essences go on a **Magic** item and upgrade it to **Rare** with the mod
  (`essence "abrasion"`, `essence "greater flames"`). **Perfect** essences go on
  a **Rare** item, removing a random modifier and then adding theirs
  (`essence "perfect ice"`). Match by name words, rank optional. The granted mod
  and its tiers come straight from PoB's `Essence.lua` (only essences that
  actually roll on bows are loaded). An item may hold only **one** crafted
  (essence) modifier — a second essence is rejected.
- **`fracture`** (Fracturing Orb) — on a Rare with 4+ mods, locks one *random*
  modifier. Fractured mods survive `chaos`, `annul`, and can't be `scour`ed.
- **`desecrate`** (a Bone) — on a Rare with an open affix, adds a blank
  **unrevealed** desecrated affix (occupies a slot but isn't a concrete mod yet).
- **`reveal`** (Well of Souls) — resolves one unrevealed affix, choosing one of
  up to 3 random options from the desecrated pool.
- **Fracture interaction:** a Fracturing Orb can't target an unrevealed
  desecrated affix — it only fractures the other (concrete) affixes. So with 3
  real mods + 1 unrevealed (4 total), fracture always lands on one of the 3.
- **Chaos**, **Annulment**, and **Perfect essences** *can* remove an unrevealed
  desecrated affix — Fracturing is the only thing that can't touch them.

New conditions: `fractured`, `desecrated`, `crafted`, and `unrevealed` test
whether such an affix is present.

**Control flow:**

- `while <cond> { ... }` / `until <cond> { ... }`
- `repeat N { ... }`
- `if <cond> { ... } else { ... }`
- `stop`

**Conditions:** `has prefix "text"`, `has suffix "text"`, `has "text"`
(case-insensitive substring over affix name / mod group / rolled text). Add an
If the quoted text is an exact **affix name** (as shown in the Affix Pool panel,
e.g. `has prefix "Physical Damage Percent"`) it matches that affix only;
otherwise it's a fuzzy substring over the rolled text (e.g. `has "physical"`).
This avoids overlap — "Accuracy Rating" appears in the rolled text of three
affixes, but the exact name targets just one. (`group "..."` still works and is
equivalent to a bare exact name.) There's also an
optional **tier** filter (T1 = best): `has prefix "physical" tier <= 2`,
`has tier == 1`, and an optional **`fractured`** flag to require the matched
affix be fractured: `has prefix "physical" fractured`, `has fractured` (text is
optional when a tier or fractured filter is given);
`prefixes >= N`, `suffixes < N`, `affixes == N`; `open prefix`, `open suffix`;
`rarity is rare`, `corrupted`, `fractured`, `desecrated`, `crafted`, `full`;
combined with `not` / `and` / `or` / `( )`.

Comments start with `#` or `//`.

An operation budget guards against `while` loops that can never terminate.

### Stop limit

Independently of the script, you can cap a run with **Stop after** → either *N
steps* (currency operations) or *N exalted spent*. When the cap is hit the run
halts gracefully and is flagged (single run shows a note; Monte Carlo reports
the fraction of attempts that hit the limit). This is separate from the `stop`
keyword and the infinite-loop budget.

## Cost metrics

Currency usage is costed in **Exalted Orbs** (the PoE2 base trade currency).
The single-run view shows total cost; the Monte Carlo view shows average cost
per attempt and **average cost per success** (avg cost ÷ success rate) — the
headline number for comparing crafting recipes. The Monte Carlo shows a cost
matrix — rows for each currency, the base item, and the total; columns for
**Average / Min / p95 / Max** per attempt (plus cost-per-success), and a small
**bar histogram** of the total-cost distribution. Runs asynchronously
in chunks with a live **progress bar** (% and attempts done) and a **Cancel**
button to abort a long run. When a target is set it also shows an **example item
from a passing run** (reservoir-sampled, so it's a representative success). Costs display in Exalted Orbs,
with a Divine-equivalent shown in parentheses once a value is large enough. The
**Base price** field (Base & Setup) adds the one-time cost of the white base
item to every run's total (and to each Monte-Carlo attempt); it can be entered
in exalt, chaos, or divine (converted to Exalted via the live prices).

### Live prices

`src/data/prices.json` holds the default prices and is generated by:

```
node scripts/fetch-prices.mjs
```

This pulls the current league's Currency-Exchange values from the
[poe2scout](https://poe2scout.com) community API (same economy data as
poe.ninja, but with a clean documented JSON API — poe.ninja's own economy
endpoint is served by runtime-obfuscated chunks and isn't reachable without a
headless browser). Run it on a schedule to keep prices fresh. A handful of
near-vendor orbs (transmute/augment/alchemy/regal/whetstone) aren't tracked
individually and use documented estimates; `essence` and `desecrate` map to a
representative item since those mechanics span many tiers/bones. The price
table in the UI is editable and saved per-browser, overriding the defaults.

## Data

The app supports multiple **item classes** (pick one in *Base & Setup*):
currently **Bow** and **Dex/Int Boots** (evasion/energy-shield). Each class has
its own generated `<key>.bases.json`, `<key>.mods.json`, `<key>.essences.json`
plus a hand-authored `<key>.desecrated.json`. Add a class by adding a config to
`CLASSES` in `tools/extract-item-data.lua` and registering it in
`ITEM_CLASSES` (`src/engine/mods.ts`).

These generated files come from the Path of Building (PoE2) data tables — do not
hand-edit them. `src/data/desecrated.json` is **hand-maintained** from the
community/poe2db desecrated-modifier lists (the bow Abyss mods tied to
Ulaman, Amanamu, and Kurgal), since this PoB build does not tag a desecrated
pool. To regenerate the generated files after updating the local
`PathOfBuilding-PoE2` checkout:

```
C:\Users\roser\Claude\tools\luajit-inst\bin\luajit.exe ^
  C:\Users\roser\Claude\tools\extract-bow-data.lua
```

The extractor pulls bow bases from `Bases/bow.lua` and every mod with a
positive spawn weight on a Bow item-class from `ModItem.lua`.

## Notes / accuracy

- Affix caps: Magic = 1 prefix + 1 suffix, Rare = 3 + 3.
- One mod per mod-group per item; spawn chance is weighted by PoB spawn weights.
- Mod availability is gated by item level (tier `level` ≤ item level).
- Currency behaviour follows current PoE2 rules (e.g. Chaos = remove one random
  mod + add one random mod on a Rare). Exact developer weights and some
  mechanics are approximations.
