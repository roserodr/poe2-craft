import type { QuerySpec } from "./trade";

/**
 * A craftable "recipe": buy a cheap input base, run a known crafting script to
 * hit a target outcome, then sell the result. The profit finder prices the buy
 * and sell sides live, simulates the craft cost, and reports expected profit.
 *
 * Stat ids come from PoB's Data/TradeSiteStats.lua (search the "text" lines).
 * Common ones:
 *   explicit.stat_2250533757  = #% increased Movement Speed
 */
export interface Recipe {
  name: string;
  /** craft engine item class key (see ITEM_CLASSES in src/engine/mods.ts) */
  itemClass: string;
  /** base used by the simulator. Defaults to the first base of the class. */
  baseName?: string;
  ilvl: number;
  startRarity: "Normal" | "Magic" | "Rare";
  /** pre-applied starting modifiers (affix names, see buildStartItem). */
  startMods?: string[];
  /** crafting DSL script (same language as the simulator app). */
  script: string;
  /** DSL success condition: a craft "succeeds" (becomes sellable) when this holds. */
  target: string;
  /** Monte Carlo attempts (more = steadier cost estimate). */
  runs?: number;
  /** trade query to price the INPUT base you buy. */
  buy: QuerySpec;
  /** Manual base price (in Divine) used for the profit math instead of the live
   * median. Use for scarce bases where one troll listing skews the live price.
   * The live `buy` query is still shown for reference. */
  buyOverrideDiv?: number;
  /** trade query to price the OUTPUT item you sell. */
  sell: QuerySpec;
  /** Manual sell price (in Divine) for the profit math, for when the exact
   * product (e.g. a 2-socket magic item) is too thinly listed to price live.
   * The live `sell` query is still shown for reference. */
  sellOverrideDiv?: number;
}

const MOVE_SPEED = "explicit.stat_2250533757";
const TOTAL_ELE_RES = "pseudo.pseudo_total_elemental_resistance";
const SPELL_SKILLS = "explicit.stat_124131830"; // +# to Level of all Spell Skills
const PROJECTILE_SKILLS = "explicit.stat_1202301673"; // +# to Level of all Projectile Skills
const MAX_LIFE = "explicit.stat_3299347043"; // # to maximum Life
const EVA_ES_PCT = "explicit.stat_1999113824"; // #% increased Evasion and Energy Shield
const AR_EV_ES_PCT = "explicit.stat_3523867985"; // #% increased Armour, Evasion and Energy Shield
const DEFLECTION = "explicit.stat_3033371881"; // Gain Deflection Rating equal to #% of Evasion Rating
const MAX_ES = "explicit.stat_3489782002"; // +# to maximum Energy Shield
const TO_SPIRIT = "explicit.stat_3981240776"; // +# to Spirit (live trade id)
const PHYS_ATK = "explicit.stat_3032590688"; // Adds # to # Physical Damage to Attacks
const LIGHT_ATK = "explicit.stat_1754445556"; // Adds # to # Lightning damage to Attacks
const ATTACK_SPEED = "explicit.stat_681332047"; // #% increased Attack Speed

export const RECIPES: Recipe[] = [
  {
    // The user's known earner: buy cheap 2-socket normal dex/int boots, perfect
    // transmute + perfect aug + annul-chase a single 35%+ Movement Speed suffix.
    name: "35% MS + res 2-socket eva/ES boots",
    itemClass: "dexIntBoots",
    // Any evasion/ES (dex-int) boots base — the buy/sell queries target eva/ES
    // bases via the ev+es filters rather than a single base type. Daggerfoot is
    // just a representative base for the (base-agnostic) mod simulation.
    baseName: "Daggerfoot Shoes",
    ilvl: 82,
    startRarity: "Normal",
    // Sell as a MAGIC item: 35% MS prefix + a resist suffix. A magic item caps at
    // 1 prefix + 1 suffix. PoE2 0.5 has NO Orb of Scouring, so you can't reset a
    // magic item — you re-roll with ANNULMENT (remove a random mod) + perfect
    // augment. This matches the real method (perfect transmute/aug + annuls) and
    // makes annul orbs the dominant cost.
    script: `
      perfect transmute
      perfect augment
      while not (has prefix "Movement Speed" tier == 1 and has suffix "Resistance") {
        annul
        perfect augment
      }
    `,
    target: `has prefix "Movement Speed" tier == 1 and has suffix "Resistance"`,
    runs: 4000,
    // ilvl-82, 2-socket normal eva/ES boots (any base) — ~5-10 div.
    buy: {
      category: "armour.boots",
      rarity: "normal",
      minSockets: 2,
      minIlvl: 82,
      minEvasion: 1,
      minEnergyShield: 1,
    },

    // Magic Daggerfoot, 35% MS + a meaningful resist suffix, with 2 augmentable
    // (empty rune) sockets — the valuable version. minSockets uses the trade
    // site's "Augmentable Sockets" filter (rune_sockets), which works on magic.
    sell: {
      category: "armour.boots",
      rarity: "magic",
      minSockets: 2,
      minEvasion: 1,
      minEnergyShield: 1,
      stats: [
        { id: MOVE_SPEED, min: 35 },
        { id: TOTAL_ELE_RES, min: 25 },
      ],
    },
    sellOverrideDiv: 40, // your real sale price; 2-socket magic is thinly listed
  },

  {
    // Multi-mod RARE craft (demand-mined from poe.ninja: 80% of builds want the
    // "% Armour, Evasion & ES" mod + resists on evasion chests). Start from a
    // 3-socket normal high-evasion base; perfect transmute → Greater Essence of
    // Enhancement guarantees the ArEvES% prefix (Magic→Rare) → exalt-fill the rest,
    // chasing 2 resist suffixes. Essence anchors the key mod; exalts add the rest.
    name: "ArEvES% + 2-res rare evasion chest",
    itemClass: "evBody",
    baseName: "Slipstrike Vest",
    ilvl: 82,
    startRarity: "Normal",
    script: `
      perfect transmute
      essence "greater enhancement"
      exalt
      exalt
      exalt
      exalt
    `,
    target: `has prefix "Armour, Evasion and Energy Shield" and has 2 suffix "Resistance"`,
    runs: 4000,
    buy: { category: "armour.chest", rarity: "normal", minSockets: 3, minIlvl: 82, minEvasion: 1 },
    // Priced at 2+ sockets (a live lower bound): 3-socket rares of this spec
    // aren't sitting on the market (they sell fast — real demand), so the actual
    // 3-socket product is worth more than this shows.
    sell: {
      category: "armour.chest",
      rarity: "rare",
      minSockets: 2,
      minEvasion: 1,
      stats: [
        { id: AR_EV_ES_PCT, min: 60 },
        { id: TOTAL_ELE_RES, min: 50 },
      ],
    },
  },

  {
    // ES helmet, ALL-T1. Whittling fails for the 3rd prefix (it removes the
    // LOWEST-level mod, and the %ES level-65 prefixes are lower than the level-82
    // resists, so whittling strips them). So (user-designed):
    //  1. T1 flat ES via perfect transmute/aug + plain annul; FRACTURE-lock it.
    //  2. 2nd prefix = T1 pure %ES via sinistral annul + perfect exalt (targeted —
    //     no level conflict; capped at 2 prefixes to leave the 3rd slot OPEN).
    //  3. resists via perfect exalt + dextral annul.
    //  4. 3rd prefix = %ES-life hybrid via ANCIENT RIBS (desecrate) + necromancy
    //     (force a prefix reveal) + abyssal echoes + Omen of Light to clear misses
    //     — a safe re-rollable slot that dodges the whittling/annul churn.
    name: "ES helmet ALL-T1 (fracture + rib finish)",
    itemClass: "esHelm",
    baseName: "Ancestral Tiara",
    ilvl: 84,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has prefix "maximum Energy Shield" tier == 1 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has prefix "maximum Energy Shield" tier == 1 fractured { stop }
      while not (has 2 suffix "Resistance" tier == 1 and has < 3 suffix) {
        if has 2 suffix { annul with "dextral annulment" }
        else { perfect exalt with "dextral" }
      }
      while not has 3 suffix "Resistance" tier == 1 {
        desecrate "ancient"
        reveal with "abyssal echoes" and "dextral necromancy" pick has 3 suffix "Resistance" tier == 1
        if not has 3 suffix "Resistance" tier == 1 { annul with "light" }
      }
    `,
    // Suffix study: fracture T1 flat ES, then land 3 distinct STRICT-T1 resists.
    // Here: 2 resists via exalt/annul (leaving the 3rd slot OPEN), then DESECRATE the
    // 3rd (ancient rib + dextral necromancy reveal + Omen of Light safe re-roll). The
    // desecrate stage now averages ~2 reveals (~0.58 desecrate/attempt). ~337 div.
    // TWO BUGS this fixes (both essential): (1) the reveal `pick` must be COUNT-based
    // `has 3 suffix "Resistance" tier == 1` -- the naive `has suffix "Resistance"
    // tier == 1` is already true from the 2 existing resists, so the chooser always
    // selected option[0] (junk) -> churn. (2) Stage A MUST leave the 3rd slot open
    // (`has < 3 suffix`): the regal/exalt before it can fill all 3 suffix slots with
    // a non-desecrated junk resist, which Light can't remove + reveal can't place ->
    // permanent op-budget deadlock. ALT: all 3 via `greater chaos with "whittling"
    // and "dextral erasure"` (chaos whittle + chaos suffix-removal, 2 omens/orb) =
    // ~277 div, marginally cheaper. Whittling is CHAOS-only (not annul). Prefix
    // build-out (2nd %ES + ribbed %ES-life hybrid) still to fold on for the full helmet.
    target: `has 3 suffix "Resistance" tier == 1`,
    runs: 4000,
    buy: { category: "armour.helmet", rarity: "normal", minIlvl: 84 },
    sell: {
      category: "armour.helmet",
      rarity: "rare",
      minEnergyShield: 300,
      // genuine all-T1: high flat ES + 3 strong resists (total ele res floor).
      // NOTE: finder prices the cheapest-30 (sort asc), so this reflects the floor,
      // not the mirror-tier ceiling — the true sell needs a sort-desc query.
      stats: [{ id: TOTAL_ELE_RES, min: 90 }],
    },
  },

  {
    // FULL 6xT1 GOD ES helmet: 3 T1 ES prefixes (flat ES [fractured] + pure %ES +
    // %ES-life hybrid) + 3 distinct T1 resists. Keeper-safety RULE: Omen of Light
    // removes a RANDOM desecrated mod item-wide (ignores slot omens), so only ONE
    // desecrated mod may exist at the finish. Hence build prefixes + first 2 resists
    // NON-desecrated, and desecrate ONLY the final resist (its reveal-junk is then the
    // sole desecrated mod -> Light is safe). Order: fracture flat ES -> 2 resists
    // (exalt/annul) so suffixes are filled -> whittle+sinistral-erasure the 2 extra
    // prefixes to T1 (suffixes full forces the chaos add onto prefixes) -> desecrate
    // the 3rd resist (one suffix slot kept open).
    // EFFICIENCY (user 2026-06-20): `annul x3` resets to the bare fractured prefix;
    // `perfect exalt with "dextral" and "greater exaltation"` adds TWO suffixes per
    // orb while no resist is present -> fewer orbs to fill the suffix side.
    name: "FULL 6xT1 god ES helmet (desecrate finish)",
    itemClass: "esHelm",
    baseName: "Ancestral Tiara",
    ilvl: 84,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has prefix "maximum Energy Shield" tier == 1 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has prefix "maximum Energy Shield" tier == 1 fractured { stop }
      annul
      annul
      annul
      while not (has 2 suffix "Resistance" tier == 1 and has < 3 suffix) {
        if has 2 suffix { annul }
        else {
          if has 0 suffix "Resistance" tier == 1 { perfect exalt with "dextral" and "greater exaltation" }
          else { perfect exalt with "dextral" }
        }
      }
      while not has 3 suffix "Resistance" tier == 1 {
        desecrate "ancient"
        reveal with "abyssal echoes" and "dextral necromancy" pick has 3 suffix "Resistance" tier == 1
        if not has 3 suffix "Resistance" tier == 1 { annul with "light" }
      }
      while not (has prefix "LocalEnergyShieldPercent" tier == 1 and has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1) {
        if has 3 prefix { greater chaos with "whittling" and "sinistral erasure" }
        else { perfect exalt with "sinistral" }
      }
    `,
    target: `has prefix "maximum Energy Shield" tier == 1 and has prefix "LocalEnergyShieldPercent" tier == 1 and has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1 and has 3 suffix "Resistance" tier == 1`,
    runs: 4000,
    buy: { category: "armour.helmet", rarity: "normal", minIlvl: 84 },
    sell: {
      category: "armour.helmet",
      rarity: "rare",
      minEnergyShield: 300,
      stats: [{ id: TOTAL_ELE_RES, min: 90 }],
    },
  },

  {
    // FULL 6xT1 god ES helmet, FLIPPED (user 2026-06-20): whittle the RESISTS (chaos
    // whittling + dextral erasure, suffixes filled fast w/ greater exaltation), then
    // DESECRATE the prefixes. Rationale: pure %ES (lvl 65) is BELOW the lvl-78 ES
    // hybrids, so whittling (keeps highest level) fights it; desecration picks the
    // specific group deterministically. KEEPER CONSTRAINT: Omen of Light removes a
    // RANDOM desecrated mod item-wide, so desecrating BOTH prefixes lets Light eat the
    // first one (MEASURED: 0.3% success, 12k desecrate/attempt -- catastrophic). SAFE
    // FORM: whittle the resists, then build the 2nd prefix as EITHER desired ES% mod
    // (pure %ES OR %ES-life hybrid) and DESECRATE the complement. Since the annul x3
    // reset leaves NO un-fractured prefix (flat ES is fractured = removal-immune),
    // `greater chaos with "sinistral erasure"` is a safe one-orb reroll (remove the
    // wrong prefix + add a new one; suffixes are full so the add lands on a prefix) --
    // chaos (~44ex) is far cheaper than perfect exalt (398ex) + whittling churn. The
    // desecrate then targets whichever ES% prefix is still missing; only the reveal-
    // junk is desecrated so Light stays safe. PERFECT CHAOS (lvl>=50 re-add, vs greater
    // lvl>=35) on the resist whittle AND the prefix reroll ~halves the orb count (the
    // lvl-50 floor strips junk low tiers so the random re-add lands a usable T1 far more
    // often) -- worth the pricier orb because each bundles an expensive omen (whittling
    // 867 / sinistral erasure 1278). Net ~288 div (was 358 with greater chaos). NOTE:
    // the resist-whittle stage's chaos
    // re-add can land junk in an open PREFIX slot (suffixes full -> add goes to a
    // prefix), so the prefix stage gates on `has < 3 prefix` and strips junk with
    // sinistral annul -> it exits at exactly [flat ES + one T1 ES%] with a slot open
    // for the desecrate (else the desecrate deadlocks on a full, non-desecrated slot).
    name: "FULL 6xT1 god ES helmet (whittle resists, desecrate prefixes)",
    itemClass: "esHelm",
    baseName: "Ancestral Tiara",
    ilvl: 84,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has prefix "maximum Energy Shield" tier == 1 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has prefix "maximum Energy Shield" tier == 1 fractured { stop }
      annul
      annul
      annul
      checkpoint "flat ES + fracture"
      while not has 3 suffix "Resistance" tier == 1 {
        if has 3 suffix { perfect chaos with "whittling" and "dextral erasure" }
        else { perfect exalt with "dextral" and "greater exaltation" }
      }
      checkpoint "3 resists (whittle)"
      while not ((has prefix "LocalEnergyShieldPercent" tier == 1 or has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1) and has < 3 prefix) {
        if has 3 prefix { annul with "sinistral annulment" }
        else if has 2 prefix { perfect chaos with "sinistral erasure" }
        else { perfect exalt with "sinistral" }
      }
      checkpoint "2nd ES prefix (chaos reroll)"
      while not (has prefix "LocalEnergyShieldPercent" tier == 1 and has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1) {
        desecrate "ancient"
        reveal with "abyssal echoes" and "sinistral necromancy" pick (has prefix "LocalEnergyShieldPercent" tier == 1 and has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1)
        if not (has prefix "LocalEnergyShieldPercent" tier == 1 and has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1) { annul with "light" }
      }
      checkpoint "complement ES prefix (desecrate)"
    `,
    target: `has prefix "maximum Energy Shield" tier == 1 and has prefix "LocalEnergyShieldPercent" tier == 1 and has prefix "LocalIncreasedEnergyShieldAndLife" tier == 1 and has 3 suffix "Resistance" tier == 1`,
    runs: 4000,
    buy: { category: "armour.helmet", rarity: "normal", minIlvl: 84 },
    sell: {
      category: "armour.helmet",
      rarity: "rare",
      minEnergyShield: 300,
      stats: [{ id: TOTAL_ELE_RES, min: 90 }],
    },
  },

  {
    // FULL 6x-T1 GOD evasion chest (user-designed sequence). Stages:
    //  1. perfect transmute + (annul + perfect augment) until 2 T1 affixes
    //     (an evasion prefix + a resist suffix) on the magic item.
    //  2. perfect regal -> rare.
    //  3. build 3 evasion prefixes: perfect exalt w/ sinistral to add; if prefixes
    //     are full but not all evasion, sinistral annul removes a wrong one, retry.
    //  4. build 2 resist suffixes (leaving the 3rd suffix slot OPEN).
    //  5. finish the 6th = a Deflection suffix via ancient ribs + abyssal echoes +
    //     Omen of Light (safe, re-rollable). All adds are perfect = T1.
    // Final: 3 evasion prefixes + 2 resists + deflection = 6xT1. ~191 div guaranteed
    // (100% — loops always complete). Smart version: the deflection desecration
    // finisher replaces a brutal ~330-div churn for a 3rd distinct resist (naive
    // 3-resist symmetric fill/fix = ~525 div). Output is a mirror-tier god chest.
    name: "FULL 6xT1 god evasion chest",
    itemClass: "evBody",
    baseName: "Slipstrike Vest",
    ilvl: 84,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not (has prefix "Evasion" and has suffix "Resistance") {
        annul
        perfect augment
      }
      perfect regal
      while not (has 3 prefix "Evasion" and has < 1 prefix "Life" and has < 1 prefix "Mana") {
        if has 3 prefix { annul with "sinistral" } else { perfect exalt with "sinistral" }
      }
      while not has 2 suffix "Resistance" {
        if has 2 suffix { annul with "dextral" } else { perfect exalt with "dextral" }
      }
      while not has suffix "Deflection" {
        desecrate "ancient"
        reveal with "abyssal echoes" pick has suffix "Deflection"
        if not has suffix "Deflection" { annul with "light" }
      }
    `,
    target: `has 3 prefix "Evasion" and has < 1 prefix "Life" and has < 1 prefix "Mana" and has 2 suffix "Resistance" and has suffix "Deflection"`,
    runs: 800,
    buy: { category: "armour.chest", rarity: "normal", minSockets: 3, minIlvl: 84, minEvasion: 1 },
    sell: {
      category: "armour.chest",
      rarity: "rare",
      minSockets: 3,
      minEvasion: 2500,
      stats: [{ id: DEFLECTION, min: 21 }, { id: TOTAL_ELE_RES, min: 70 }],
    },
    // The exact 6xT1 god chest doesn't list (sells instantly / mirror-tier). A
    // lesser 3-sock+deflection chest already hit 550d, so this is conservative.
    sellOverrideDiv: 500,
  },

  {
    // The 5-T1 BASE BUILD (the expensive omen/high-tier-orb stage before the
    // desecration finish): essence-anchor ArEvES, then perfect exalts with
    // sinistral/dextral omens to force prefixes/suffixes, chasing 3 evasion prefixes
    // + 2 resist suffixes (66% of perfect prefixes are evasion, 34% of suffixes are
    // resist). Single-pass (failures = partial chests that still resell). Measures
    // the cost to reach the 5-T1 base; add the ~11 div desecration finish for the
    // full god chest.
    name: "evasion chest 5-T1 base build",
    itemClass: "evBody",
    baseName: "Slipstrike Vest",
    ilvl: 84,
    startRarity: "Normal",
    script: `
      perfect transmute
      essence "greater enhancement"
      perfect exalt with "sinistral"
      perfect exalt with "sinistral"
      perfect exalt with "dextral"
      perfect exalt with "dextral"
    `,
    target: `has 3 prefix "Evasion" and has < 1 prefix "Life" and has < 1 prefix "Mana" and has 2 suffix "Resistance"`,
    runs: 6000,
    buy: { category: "armour.chest", rarity: "normal", minSockets: 3, minIlvl: 84, minEvasion: 1 },
    sell: {
      category: "armour.chest",
      rarity: "rare",
      minSockets: 3,
      minEvasion: 2000,
      stats: [{ id: AR_EV_ES_PCT, min: 60 }, { id: TOTAL_ELE_RES, min: 50 }],
    },
  },

  {
    // DESECRATION AS A FINISHER (user's insight): build 5 T1 mods first (3 evasion
    // prefixes + 2 resist suffixes — modeled as a pre-built startItem, the expensive
    // omen/high-tier-orb part), then fill the LAST slot by fishing a Deflection suffix
    // with ancient ribs + abyssal echoes + `reveal pick`, clearing misses with Omen of
    // Light. Light removes ONLY the desecrated mod, so the 5 T1 mods are NEVER at risk —
    // a deterministic, safe finish. VALIDATED: 100% success, ~11-15 div (~1.5 Light
    // clears dominate), the 5 T1 mods protected. This is the CORRECT use of desecration
    // (vs fishing from scratch, which wastes the base). BUT for EVASION CHESTS it stays
    // -EV: the market caps ~5 div, so deflection adds less than the ~12 div Light cost.
    // The METHOD is sound; it pays off on a HIGHER-VALUE item where the finishing T1 mod
    // adds > ~12 div. Kept as the finisher template.
    name: "evasion chest FINISH (deflection via desecrate)",
    itemClass: "evBody",
    baseName: "Slipstrike Vest",
    ilvl: 84,
    startRarity: "Rare",
    startMods: [
      "LocalEvasionRating", // +flat Evasion (T1)
      "LocalEvasionRatingIncreasePercent", // % increased Evasion (T1)
      "LocalIncreasedEvasionAndBase", // +flat & % Evasion hybrid (T1) — NOT the
      // ev+life hybrid, whose evasion roll is much smaller → lower total EV
      "FireResistance", // T1 fire res
      "ColdResistance", // T1 cold res
    ],
    script: `
      while not has suffix "Deflection" tier <= 2 {
        desecrate "ancient"
        reveal with "abyssal echoes" pick has suffix "Deflection" tier <= 2
        if not has suffix "Deflection" tier <= 2 { annul with "light" }
      }
    `,
    target: `has suffix "Deflection" tier <= 2`,
    runs: 3000,
    buy: { category: "armour.chest", rarity: "normal", minSockets: 3, minIlvl: 84, minEvasion: 1 },
    // the real god product: 3-socket, high total evasion (2000+), T1/T2 deflection.
    // These sell from ~10 to 550 div (the tightest deflection+resist combos sell so
    // fast they don't list — price the partial spec + lean on the high end).
    sell: {
      category: "armour.chest",
      rarity: "rare",
      minSockets: 3,
      minEvasion: 2000,
      stats: [{ id: DEFLECTION, min: 21 }],
    },
  },

  // Tested & removed: "evasion chest w/ deflection (desecrate fish)" — essence ArEvES
  // then ancient ribs + abyssal echoes + `reveal pick "Deflection"`, clearing misses
  // with Omen of Light. The desecration mechanic now WORKS (Light clears regular
  // reveals, 100% success), but it's -19 div/chest: ~2.5 Light clears @ 1436 ex
  // (~16 div) dominate, for a ~1-5 div item. Deflection is a REGULAR mod (cheap via
  // plain exalt), so desecration only adds expensive targeting. Desecration pays off
  // ONLY for abyssal-EXCLUSIVE mods (evBody has none authored). Removed (slow + -EV).

  {
    // Demand-mined (corrected): +Spirit ALONE is commodity (~1ex even at top tier),
    // but +Spirit + +3 skills together sells 33-150 div, and +3-skill amulets are
    // ~1ex. So BUY a cheap +3-spell-skills magic amulet and ADD a spirit prefix:
    // regal to rare, then exalt to fill, chasing a high +Spirit prefix. +3 is the
    // craftable cap (no corruption needed); the combo's scarcity is the moat.
    name: "+Spirit + +3 skills amulet (combo)",
    itemClass: "amulet",
    baseName: "Stellar Amulet",
    ilvl: 80,
    startRarity: "Magic",
    startMods: ["Spell Skills"], // the cheap +3 spell skills base you buy
    // Plain regal+exalt beats perfect-regal/greater-exalt here: tiered orbs force
    // a HIGH Spirit tier, but the bottleneck is Spirit APPEARING at all (one prefix
    // among many), not its tier — so success barely moves (2.5%→3.0%) while currency
    // jumps ~10x (0.5→5 div). Since failed attempts resell as +3-skills amulets, real
    // cost ≈ currency, so the cheap orbs win.
    script: `
      regal
      exalt
      exalt
    `,
    target: `has prefix "to Spirit" tier <= 3 and has suffix "Spell Skill"`,
    runs: 5000,
    buy: { category: "accessory.amulet", rarity: "magic", stats: [{ id: SPELL_SKILLS, min: 3 }] },
    sell: {
      category: "accessory.amulet",
      rarity: "rare",
      stats: [
        { id: TO_SPIRIT, min: 40 },
        { id: SPELL_SKILLS, min: 3 },
      ],
    },
  },

  {
    // GOD CRIT SPEAR (3 specific T1 flat eles + T1 %crit/crit-mult/AS) — Akoyan Spear,
    // ilvl 81 (excludes LocalPhysicalDamagePercent T1 L82 so the L81 eles are top-level,
    // no whittle-immune squat). ~13.2k div. The 3 eles are whittled (12.1k -- low-weight
    // ~0.8% each so coupon-collector hell, but whittle's targeted lowest-removal keeps
    // found eles) and the ONE desecrate finishes the suffix complement (644 div).
    // ALLOCATION IS OPTIMAL (measured): moving the desecrate onto an ele drops the ele
    // stage to ~2.5k BUT explodes the suffix stage to ~64k -- crit-mult (L73)/AS (L77)
    // are low-level so they can't be whittled (whittle eats the lowest) AND random
    // reroll destroys held progress, so 2 specific suffixes are pathological without the
    // deterministic desecrate. Eles CAN be whittled; suffixes NEED the desecrate -> keep
    // it here. To go cheaper, relax the ASK: see the weapon-ele% (~5k) and T2 (~5.3k)
    // variants below. GROUP IDS: %crit=LocalBaseCriticalStrikeChance; eles=LocalFireDamage
    // /LocalColdDamage/LocalLightningDamage; crit-mult=LocalCriticalStrikeMultiplier;
    // AS=LocalIncreasedAttackSpeed.
    name: "god crit spear (3 ele prefix + crit/AS, desecrate)",
    itemClass: "spear",
    baseName: "Akoyan Spear",
    ilvl: 81,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has suffix "LocalBaseCriticalStrikeChance" tier == 1 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has suffix "LocalBaseCriticalStrikeChance" tier == 1 fractured { stop }
      annul
      annul
      annul
      checkpoint "T1 crit + fracture"
      while not (has prefix "LocalFireDamage" tier == 1 and has prefix "LocalColdDamage" tier == 1 and has prefix "LocalLightningDamage" tier == 1) {
        if has 3 prefix { perfect chaos with "whittling" and "sinistral erasure" }
        else { perfect exalt with "sinistral" and "greater exaltation" }
      }
      checkpoint "3 ele prefixes (whittle)"
      while not ((has suffix "LocalCriticalStrikeMultiplier" tier == 1 or has suffix "LocalIncreasedAttackSpeed" tier == 1) and has < 3 suffix) {
        if has 3 suffix { annul with "dextral annulment" }
        else if has 2 suffix { perfect chaos with "dextral erasure" }
        else { perfect exalt with "dextral" }
      }
      checkpoint "2nd suffix (chaos reroll)"
      while not (has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1) {
        desecrate "ancient"
        reveal with "abyssal echoes" and "dextral necromancy" pick (has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1)
        if not (has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1) { annul with "light" }
      }
      checkpoint "complement suffix (desecrate)"
    `,
    target: `has suffix "LocalBaseCriticalStrikeChance" tier == 1 and has prefix "LocalFireDamage" tier == 1 and has prefix "LocalColdDamage" tier == 1 and has prefix "LocalLightningDamage" tier == 1 and has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1`,
    runs: 3000,
    buy: { category: "weapon.spear", rarity: "normal", minIlvl: 82 },
    sell: { category: "weapon.spear", rarity: "rare" },
  },

  {
    // Same crit spear, but RELAXED to tier <= 2 on every rolled mod (ele damages,
    // %crit, crit dmg bonus, attack speed) to show the cost cliff vs strict T1.
    // Accepting T1-OR-T2 roughly doubles each target's hittable weight and removes
    // the "one specific top roll" wall that makes the strict version mirror-tier.
    name: "crit spear T2-relaxed (3 ele prefix + crit/AS)",
    itemClass: "spear",
    baseName: "Akoyan Spear",
    ilvl: 81,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has suffix "LocalBaseCriticalStrikeChance" tier <= 2 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has suffix "LocalBaseCriticalStrikeChance" tier <= 2 fractured { stop }
      annul
      annul
      annul
      checkpoint "T2 crit + fracture"
      while not (has prefix "LocalFireDamage" tier <= 2 and has prefix "LocalColdDamage" tier <= 2 and has prefix "LocalLightningDamage" tier <= 2) {
        if has 3 prefix { perfect chaos with "whittling" and "sinistral erasure" }
        else { perfect exalt with "sinistral" and "greater exaltation" }
      }
      checkpoint "3 ele prefixes (whittle)"
      while not ((has suffix "LocalCriticalStrikeMultiplier" tier <= 2 or has suffix "LocalIncreasedAttackSpeed" tier <= 2) and has < 3 suffix) {
        if has 3 suffix { annul with "dextral annulment" }
        else if has 2 suffix { perfect chaos with "dextral erasure" }
        else { perfect exalt with "dextral" }
      }
      checkpoint "2nd suffix (chaos reroll)"
      while not (has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2) {
        desecrate "ancient"
        reveal with "abyssal echoes" and "dextral necromancy" pick (has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2)
        if not (has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2) { annul with "light" }
      }
      checkpoint "complement suffix (desecrate)"
    `,
    target: `has suffix "LocalBaseCriticalStrikeChance" tier <= 2 and has prefix "LocalFireDamage" tier <= 2 and has prefix "LocalColdDamage" tier <= 2 and has prefix "LocalLightningDamage" tier <= 2 and has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2`,
    runs: 3000,
    buy: { category: "weapon.spear", rarity: "normal", minIlvl: 82 },
    sell: { category: "weapon.spear", rarity: "rare" },
  },

  {
    // Cheaper crit spear: accept weapon-ele% (IncreasedWeaponElementalDamagePercent,
    // L81 w500 ~= 4.4% of the prefix pool, ~5.5x likelier than a flat ele AND a top
    // DPS mod) as the 3rd prefix instead of a third low-weight flat ele. Two flat eles
    // (fire+cold) + weapon-ele% + the proven crit/AS suffix finish (chaos reroll +
    // desecrate). The desecrate STAYS on the suffix side -- crit-multi (L73) & AS (L77)
    // are low-level and can't be whittled (whittle eats the lowest); the L81 eles can.
    name: "crit spear (2 flat ele + weapon-ele%)",
    itemClass: "spear",
    baseName: "Akoyan Spear",
    ilvl: 81,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has suffix "LocalBaseCriticalStrikeChance" tier == 1 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has suffix "LocalBaseCriticalStrikeChance" tier == 1 fractured { stop }
      annul
      annul
      annul
      checkpoint "T1 crit + fracture"
      while not (has prefix "LocalFireDamage" tier == 1 and has prefix "LocalColdDamage" tier == 1 and has prefix "IncreasedWeaponElementalDamagePercent" tier == 1) {
        if has 3 prefix { perfect chaos with "whittling" and "sinistral erasure" }
        else { perfect exalt with "sinistral" and "greater exaltation" }
      }
      checkpoint "2 ele + weapon-ele% prefixes (whittle)"
      while not ((has suffix "LocalCriticalStrikeMultiplier" tier == 1 or has suffix "LocalIncreasedAttackSpeed" tier == 1) and has < 3 suffix) {
        if has 3 suffix { annul with "dextral annulment" }
        else if has 2 suffix { perfect chaos with "dextral erasure" }
        else { perfect exalt with "dextral" }
      }
      checkpoint "2nd suffix (chaos reroll)"
      while not (has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1) {
        desecrate "ancient"
        reveal with "abyssal echoes" and "dextral necromancy" pick (has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1)
        if not (has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1) { annul with "light" }
      }
      checkpoint "complement suffix (desecrate)"
    `,
    target: `has suffix "LocalBaseCriticalStrikeChance" tier == 1 and has prefix "LocalFireDamage" tier == 1 and has prefix "LocalColdDamage" tier == 1 and has prefix "IncreasedWeaponElementalDamagePercent" tier == 1 and has suffix "LocalCriticalStrikeMultiplier" tier == 1 and has suffix "LocalIncreasedAttackSpeed" tier == 1`,
    runs: 3000,
    buy: { category: "weapon.spear", rarity: "normal", minIlvl: 82 },
    sell: { category: "weapon.spear", rarity: "rare" },
  },

  {
    // Practical-floor crit spear: BOTH levers stacked -- substitute weapon-ele% for the
    // 3rd flat ele AND relax every rolled mod to tier <= 2. Strong real-world spear
    // (2 flat ele + %ele + crit/AS) at a fraction of the strict-god cost.
    name: "crit spear FLOOR (2 ele + weapon-ele%, T2)",
    itemClass: "spear",
    baseName: "Akoyan Spear",
    ilvl: 81,
    startRarity: "Normal",
    script: `
      perfect transmute
      perfect augment
      while not has suffix "LocalBaseCriticalStrikeChance" tier <= 2 {
        annul
        perfect augment
      }
      perfect regal
      perfect exalt
      fracture
      if not has suffix "LocalBaseCriticalStrikeChance" tier <= 2 fractured { stop }
      annul
      annul
      annul
      checkpoint "T2 crit + fracture"
      while not (has prefix "LocalFireDamage" tier <= 2 and has prefix "LocalColdDamage" tier <= 2 and has prefix "IncreasedWeaponElementalDamagePercent" tier <= 2) {
        if has 3 prefix { perfect chaos with "whittling" and "sinistral erasure" }
        else { perfect exalt with "sinistral" and "greater exaltation" }
      }
      checkpoint "2 ele + weapon-ele% prefixes (whittle)"
      while not ((has suffix "LocalCriticalStrikeMultiplier" tier <= 2 or has suffix "LocalIncreasedAttackSpeed" tier <= 2) and has < 3 suffix) {
        if has 3 suffix { annul with "dextral annulment" }
        else if has 2 suffix { perfect chaos with "dextral erasure" }
        else { perfect exalt with "dextral" }
      }
      checkpoint "2nd suffix (chaos reroll)"
      while not (has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2) {
        desecrate "ancient"
        reveal with "abyssal echoes" and "dextral necromancy" pick (has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2)
        if not (has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2) { annul with "light" }
      }
      checkpoint "complement suffix (desecrate)"
    `,
    target: `has suffix "LocalBaseCriticalStrikeChance" tier <= 2 and has prefix "LocalFireDamage" tier <= 2 and has prefix "LocalColdDamage" tier <= 2 and has prefix "IncreasedWeaponElementalDamagePercent" tier <= 2 and has suffix "LocalCriticalStrikeMultiplier" tier <= 2 and has suffix "LocalIncreasedAttackSpeed" tier <= 2`,
    runs: 3000,
    buy: { category: "weapon.spear", rarity: "normal", minIlvl: 82 },
    sell: { category: "weapon.spear", rarity: "rare" },
  },

  {
    // MINION SCEPTRE — BUY-HALF COMBO (demand-mined 2026-06-20; the profitable play).
    // Live pricing showed each mod is a COMMODITY alone (+4 minion skills 275 listed
    // ~0.03 div; ally-damage commodity) but the COMBO "+4 Minion Skills + high ally
    // damage" is SCARCE-premium: 15 listed, ~20 div median / 95 p90. So craft-from-
    // scratch loses (the +4-skills whittle chase is ~465 div), but BUY the cheap half:
    // a MAGIC sceptre with +4 Minion Skills (p25 ~0.46 div) then ESSENCE OF COMMAND
    // (Magic->Rare) adds the ally-damage prefix (75-89%) -> the scarce combo for the
    // price of a magic base + 1 essence. This is the +Spirit/+3-skills amulet pattern:
    // cheap commodity half (bought) + deterministic essence anchor (crafted), value in
    // the COMBINATION. +4 minion skills = GlobalIncreaseMinionSpellSkillGemLevelWeapon
    // (T1); ally-damage = AlliesInPresenceAllDamage (essence). Sell stat ids: minion
    // skills explicit.stat_2162097452, ally-dmg% explicit.stat_1798257884.
    name: "minion sceptre combo (buy +4 skills magic, essence ally-dmg)",
    itemClass: "sceptre",
    baseName: "Shrine Sceptre",
    ilvl: 80,
    startRarity: "Magic",
    startMods: ["GlobalIncreaseMinionSpellSkillGemLevelWeapon t1"],
    script: `
      essence "greater command"
      while not has 3 suffix { perfect exalt with "dextral" and "greater exaltation" }
    `,
    target: `has prefix "AlliesInPresenceAllDamage" and has suffix "GlobalIncreaseMinionSpellSkillGemLevelWeapon" tier == 1`,
    runs: 3000,
    buy: {
      category: "weapon.sceptre",
      rarity: "magic",
      stats: [{ id: "explicit.stat_2162097452", min: 4 }],
    },
    sell: {
      category: "weapon.sceptre",
      rarity: "rare",
      stats: [
        { id: "explicit.stat_2162097452", min: 4 },
        { id: "explicit.stat_1798257884", min: 80 },
      ],
    },
  },

  {
    // CRIT CASTER WAND — buy-half (price-probed 2026-06-20). Correction: wands DO roll
    // +skill levels (GlobalIncrease[Element]SpellSkillGemLevelWeapon, +5 element / +4
    // all -- the WEAPON variant, distinct from the belt group). +skills alone is a
    // commodity (~0), and +skills+spell-dmg is near-commodity (median 0.1-0.5), BUT the
    // GOD TRIPLE "+5 Fire Spell Skills + spell damage + spell crit damage" is scarce-
    // premium (3 listed, ~15 div median / 40 p90) -- thinner/riskier than the sceptre.
    // VERDICT: -EV (~-888 div) -- DOCUMENTED CAUTION, not a winner. The combo IS scarce-
    // premium (3 listed, 15 div median / 40 p90) and the +5-fire-skills magic buy-half is
    // ~free (p25 0.04 div), BUT crafting the other two mods (spell-dmg WeaponSpellDamage
    // w50 + crit-dmg) onto the anchor has NO essence anchor and they're low-weight, so it
    // takes ~93 whittles = ~903 div craft >> 15 div sell. The buy-half play only profits
    // when the CRAFTED half is cheap (a single essence-anchored or high-weight mod, as on
    // the sceptre's ally-damage essence); here it's two low-weight unanchorable mods. The
    // combo's scarcity reflects exactly this craft cost. (No fracture: +5 fire skills L81
    // is the highest wand suffix so whittling never removes it; fracture also needs 4+
    // mods.) Group ids: fire-skills GlobalIncreaseFireSpellSkillGemLevelWeapon, spell-dmg
    // WeaponSpellDamage, crit-dmg SpellCriticalStrikeMultiplier.
    name: "crit caster wand (buy +5 fire-skills magic, craft spell-dmg+crit)",
    itemClass: "wand",
    baseName: "Bone Wand",
    ilvl: 81,
    startRarity: "Magic",
    startMods: ["GlobalIncreaseFireSpellSkillGemLevelWeapon t1"],
    script: `
      perfect regal
      while not has prefix "WeaponSpellDamage" tier <= 2 {
        if has 3 prefix { perfect chaos with "whittling" and "sinistral erasure" }
        else { perfect exalt with "sinistral" }
      }
      while not has suffix "SpellCriticalStrikeMultiplier" {
        if has 3 suffix { perfect chaos with "whittling" and "dextral erasure" }
        else { perfect exalt with "dextral" }
      }
    `,
    target: `has suffix "GlobalIncreaseFireSpellSkillGemLevelWeapon" tier == 1 and has prefix "WeaponSpellDamage" tier <= 2 and has suffix "SpellCriticalStrikeMultiplier"`,
    runs: 3000,
    buy: {
      category: "weapon.wand",
      rarity: "magic",
      stats: [{ id: "explicit.stat_591105508", min: 5 }],
    },
    sell: {
      category: "weapon.wand",
      rarity: "rare",
      stats: [
        { id: "explicit.stat_591105508", min: 5 },
        { id: "explicit.stat_2974417149", min: 70 },
        { id: "explicit.stat_274716455", min: 20 },
      ],
    },
  },
];

void PHYS_ATK;
void LIGHT_ATK;
void ATTACK_SPEED;
void DEFLECTION;
void MAX_ES;

// Reference the mapped stat ids kept for documented (rejected) candidates so the
// linter doesn't flag them; see DEMAND_RULES below for why they were dropped.
void MAX_LIFE;
void EVA_ES_PCT;

/**
 * DEMAND RULES (user domain knowledge — what the scanner's math can't know).
 * A cheap chase only profits if the finished magic base actually has a buyer.
 *
 * - BOOTS: only worth a premium with Movement Speed. A 2-socket boots with T1
 *   Life / Eva-ES% / resist but NO move speed sells for little — so those
 *   (equally cheap) chases are NOT viable flips. (Tested: T1 Life ~10.8 div and
 *   T1 Eva/ES% ~5.0 div craft, but no demand → dropped.)
 * - WEAPONS (bows, etc.): priced almost entirely by TOTAL DPS, which needs
 *   several damage mods working together — i.e. a finished rare, not a 1-2 mod
 *   magic. The single-mod magic-flip pattern does NOT apply to weapons.
 * - The pattern fits gear where ONE iconic mod + a good base makes a sought
 *   crafting base (boots+MS is the standout). Apply this filter before adding a
 *   recipe from a scanner hit.
 * - ANCHOR RULE (why the evasion chest works but gloves don't): a multi-mod rare
 *   craft is only +EV when the key high-demand mod can be DETERMINISTICALLY anchored
 *   (an essence) — then you pay for one guaranteed mod and gamble cheaply on the
 *   rest. Evasion chest: Greater Essence of Enhancement guarantees the ArEvES%
 *   prefix. No anchor ⇒ you must hit multiple high mods by random fill ⇒ near-0%.
 * - HELMETS (defensive, checked live): low value. Achievable ES%>=80+life+res =
 *   1-5ex; high triple-roll only ~1 div, thin. Easy crafts flood cheap. The
 *   valuable helmets need special INSTILLED mods ("Raven-Touched" = a rune shard).
 * - GLOVES, OFFENSIVE (user-suggested: crit dmg + added phys/elemental to attacks):
 *   the high spec (phys>=10 + lightning>=30 + attack speed) genuinely sells 3-80 div
 *   — BUT there's NO essence for added damage, so it's a pure gamble. SIMULATED:
 *   regal+exalt-fill hits the spec ~0% of runs → cost/success >1000 div for a ~20 div
 *   item = massively -EV. Like rings: bimodal (commodity floor / mirror-tier jackpot),
 *   uncraftable middle. A variance/jackpot play, not a reliable flip.
 * - RINGS are a TRAP for flips: bimodal market with no profitable middle.
 *   Anything craftable (resists, decent flat damage — e.g. phys>=10 + lightning>=30)
 *   sits at the ~1 ex commodity floor (thousands listed); only near-max god-rolls
 *   (e.g. lightning>=50) hold value, and those are MIRROR-tier jackpots, not a
 *   steady craft. High demand (86% want all-res) ≠ profit when supply is trivial.
 */
export const DEMAND_RULES = true;

// ── Investigated & rejected (kept as templates / cautionary results) ──────────
//
// +3 spell-skills magic Stellar Amulet: MEASURED at -40 div. A transmute/aug
// chase only profits when the target mod is a LARGE fraction of the
// perfect-eligible pool for its affix slot. 35% MS is ~1/10 of perfect boots
// PREFIX rolls (~23 cycles). A specific skill suffix is a tiny slice of the huge
// amulet SUFFIX pool → ~296 cycles → ~40 div in perfect orbs for a ~1 div item.
// Rule of thumb: chase-flips need a small perfect-eligible affix pool OR a
// deterministic method (an essence). There is no essence for skill levels or
// movement speed; boots MS works only because its prefix pool is small.
export const REJECTED_CANDIDATES = [
  {
    name: "+3 spell skills magic Stellar Amulet",
    itemClass: "amulet",
    baseName: "Stellar Amulet",
    ilvl: 80,
    startRarity: "Normal" as const,
    script: `
      perfect transmute
      perfect augment
      while not has suffix "Spell Skill" {
        scour
        perfect transmute
        perfect augment
      }
    `,
    target: `has suffix "Spell Skill"`,
    runs: 2000,
    buy: { baseType: "Stellar Amulet", rarity: "normal" as const, minIlvl: 75 },
    sell: {
      baseType: "Stellar Amulet",
      rarity: "magic" as const,
      stats: [{ id: SPELL_SKILLS, min: 3 }],
    },
  },
] satisfies Recipe[];

void PROJECTILE_SKILLS; // reserved for future projectile-skills candidate
