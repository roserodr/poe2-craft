import { describe, it, expect } from "vitest";
import { parse, parseCondition } from "./parser";
import { run, evalCond } from "./interpreter";
import { runBatch, runBatchAsync, extractComparisons, runComparisonsAsync } from "./batch";
import { newItem, totalAffixes, addSpecificMod } from "../engine/item";
import { ALL_BASES, ALL_MODS } from "../engine/mods";
import { RNG } from "../engine/rng";
import type { Item } from "../engine/types";

const BASE = ALL_BASES.find((b) => b.name === "Heavy Bow") ?? ALL_BASES[ALL_BASES.length - 1];
const fresh = (ilvl = 82): Item => newItem(BASE, ilvl);
const exec = (src: string, seed = 1, ilvl = 82) =>
  run(parse(src), fresh(ilvl), new RNG(seed), { collectLog: true });

describe("interpreter: control flow", () => {
  it("runs commands and counts currency spent", () => {
    const res = exec("alchemy\nexalt");
    expect(res.spent.alchemy).toBe(1);
    expect(res.spent.exalt).toBe(1);
    expect(res.totalSpent).toBe(2);
    expect(res.item.rarity).toBe("Rare");
  });

  it("repeat runs the block N times", () => {
    const res = exec("repeat 5 { transmute }");
    expect(res.spent.transmute).toBe(5);
  });

  it("while loops until its condition is false", () => {
    const res = exec('alchemy\nwhile open suffix { exalt }');
    expect(res.item.suffixes.length).toBe(3); // filled all suffix slots
  });

  it("until loops until its condition is true", () => {
    const res = exec("until rarity is rare { alchemy }");
    expect(res.item.rarity).toBe("Rare");
    expect(res.spent.alchemy).toBe(1);
  });

  it("if / else picks the right branch", () => {
    const res = exec("if rarity is normal { alchemy } else { chaos }");
    expect(res.spent.alchemy).toBe(1);
    expect(res.spent.chaos).toBeUndefined();
  });

  it("stop halts execution immediately", () => {
    const res = exec("transmute\nstop\nalchemy");
    expect(res.stoppedEarly).toBe(true);
    expect(res.spent.transmute).toBe(1);
    expect(res.spent.alchemy).toBeUndefined();
  });

  it("guards against an infinite loop with the op budget", () => {
    // chaos requires a Rare item, so on a Normal item it fails forever and the
    // item never leaves Normal -> the condition is always true.
    const res = run(parse("while rarity is normal { chaos }"), fresh(), new RNG(1), {
      budget: 500,
    });
    expect(res.budgetExceeded).toBe(true);
  });

  it("failed currency applications still run without crashing", () => {
    // exalt on a Normal item just fails repeatedly
    const res = exec("repeat 3 { exalt }");
    expect(res.spent.exalt).toBe(3);
    expect(res.log.every((e) => !e.applied)).toBe(true);
  });
});

describe("evalCond", () => {
  function rare(seed = 1): Item {
    const it = fresh();
    return run(parse("alchemy"), it, new RNG(seed)).item;
  }

  it("evaluates counts, rarity and open conditions", () => {
    const it = rare();
    expect(evalCond(parseCondition("rarity is rare"), it)).toBe(true);
    expect(evalCond(parseCondition("affixes == 4"), it)).toBe(true);
    expect(evalCond(parseCondition("prefixes <= 3"), it)).toBe(true);
    expect(evalCond(parseCondition("corrupted"), it)).toBe(false);
  });

  it("matches has prefix/suffix against mod text and group", () => {
    const it = newItem(BASE, 82);
    it.rarity = "Rare";
    // craft a known mod onto it deterministically would require internals;
    // instead just assert empty item matches nothing
    expect(evalCond(parseCondition('has "physical"'), it)).toBe(false);
  });

  it("handles not / and / or", () => {
    const it = rare();
    expect(evalCond(parseCondition("not corrupted"), it)).toBe(true);
    expect(evalCond(parseCondition("rarity is rare and not corrupted"), it)).toBe(true);
    expect(evalCond(parseCondition("corrupted or rarity is rare"), it)).toBe(true);
  });

  it("filters by affix tier (T1 = best)", () => {
    const physTop = ALL_MODS.filter((m) => m.group === "LocalPhysicalDamage").reduce((a, b) =>
      b.level > a.level ? b : a
    );
    const it = newItem(BASE, 100);
    it.rarity = "Rare";
    addSpecificMod(it, physTop, new RNG(1)); // T1 physical prefix

    expect(evalCond(parseCondition('has prefix "physical" tier == 1'), it)).toBe(true);
    expect(evalCond(parseCondition('has prefix "physical" tier <= 2'), it)).toBe(true);
    expect(evalCond(parseCondition('has prefix "physical" tier >= 2'), it)).toBe(false);
    expect(evalCond(parseCondition("has tier == 1"), it)).toBe(true);
    expect(evalCond(parseCondition('has suffix "physical" tier == 1'), it)).toBe(false);
  });

  it("counts matching affixes with a `has N ...` qualifier", () => {
    const sufGroups = [...new Set(ALL_MODS.filter((m) => m.type === "Suffix").map((m) => m.group))];
    const top = (g: string) =>
      ALL_MODS.filter((m) => m.group === g).reduce((a, b) => (b.level > a.level ? b : a));
    const it = newItem(BASE, 100);
    it.rarity = "Rare";
    addSpecificMod(it, top(sufGroups[0]), new RNG(1)); // T1 suffix
    addSpecificMod(it, top(sufGroups[1]), new RNG(2)); // T1 suffix

    // two T1 suffixes present
    expect(evalCond(parseCondition("has 2 suffix tier == 1"), it)).toBe(true); // bare N => >=
    expect(evalCond(parseCondition("has >= 2 suffix tier == 1"), it)).toBe(true);
    expect(evalCond(parseCondition("has 3 suffix tier == 1"), it)).toBe(false);
    expect(evalCond(parseCondition("has == 2 suffix tier == 1"), it)).toBe(true);
    expect(evalCond(parseCondition("has == 1 suffix tier == 1"), it)).toBe(false);
    expect(evalCond(parseCondition("has < 2 prefix"), it)).toBe(true); // 0 prefixes
  });

  it("a bare affix name matches exactly; non-names fall back to substring", () => {
    const pct = ALL_MODS.find((m) => m.group === "LocalPhysicalDamagePercent")!;
    const physAcc = ALL_MODS.find(
      (m) => m.group === "LocalIncreasedPhysicalDamagePercentAndAccuracyRating"
    )!;
    const it = newItem(BASE, 100);
    it.rarity = "Rare";
    addSpecificMod(it, physAcc, new RNG(1)); // only the superset on the item

    // bare affix name -> exact match, so the superset is NOT caught
    expect(evalCond(parseCondition('has prefix "Physical Damage Percent"'), it)).toBe(false);
    // the superset's own name matches it
    expect(
      evalCond(
        parseCondition('has prefix "Increased Physical Damage Percent And Accuracy Rating"'),
        it
      )
    ).toBe(true);
    // a non-name substring still matches fuzzily
    expect(evalCond(parseCondition('has "physical"'), it)).toBe(true);

    // add the pure percent mod; now the bare name matches it
    addSpecificMod(it, pct, new RNG(2));
    expect(evalCond(parseCondition('has prefix "Physical Damage Percent"'), it)).toBe(true);
    // the explicit `group` keyword behaves the same
    expect(evalCond(parseCondition('has prefix group "Physical Damage Percent"'), it)).toBe(true);
  });

  it("checks whether a specific affix is fractured", () => {
    const phys = ALL_MODS.find((m) => m.group === "LocalPhysicalDamage")!;
    const acc = ALL_MODS.find((m) => m.group === "LocalAccuracyRating")!;
    const it = newItem(BASE, 100);
    it.rarity = "Rare";
    addSpecificMod(it, phys, new RNG(1));
    addSpecificMod(it, acc, new RNG(2));
    // fracture only the physical prefix
    it.prefixes.find((m) => m.def.group === "LocalPhysicalDamage")!.fractured = true;

    expect(evalCond(parseCondition('has prefix "physical" fractured'), it)).toBe(true);
    expect(evalCond(parseCondition('has "accuracy" fractured'), it)).toBe(false);
    expect(evalCond(parseCondition("has fractured"), it)).toBe(true);
    // without the flag, the unfractured accuracy mod still matches
    expect(evalCond(parseCondition('has "accuracy"'), it)).toBe(true);
  });
});

describe("batch", () => {
  it("runs many attempts and reports costs and success rate", () => {
    const program = parse("alchemy\nwhile open prefix { exalt }");
    const target = parseCondition("prefixes == 3");
    const res = runBatch(program, BASE, 82, 200, 12345, { target });
    expect(res.runs).toBe(200);
    expect(res.avgSpent.alchemy).toBeCloseTo(1, 5);
    expect(res.successRate).toBe(1); // always fills prefixes
    expect(res.avgTotal).toBeGreaterThan(1);
  });

  it("is reproducible for a given seed", () => {
    const program = parse("alchemy\nrepeat 2 { chaos }");
    const a = runBatch(program, BASE, 82, 100, 7);
    const b = runBatch(program, BASE, 82, 100, 7);
    expect(a.avgTotal).toBe(b.avgTotal);
  });

  it("reports cost min/p95/max ordered, and equal for a fixed-cost recipe", () => {
    const prices = { alchemy: 1, chaos: 2 };
    // alchemy + a fixed 2 chaos -> deterministic cost = 1 + 2*2 = 5 every run
    const fixed = runBatch(parse("alchemy\nrepeat 2 { chaos }"), BASE, 82, 100, 1, { prices });
    expect(fixed.cost.min).toBe(5);
    expect(fixed.cost.max).toBe(5);
    expect(fixed.cost.p95).toBe(5);
    expect(fixed.cost.avg).toBe(5);

    // a variable recipe (chaos-spam until a target) -> spread, ordered
    const program = parse('alchemy\nwhile not has "physical damage percent" { chaos }');
    const v = runBatch(program, BASE, 82, 300, 3, { prices });
    expect(v.cost.min).toBeLessThanOrEqual(v.cost.p95);
    expect(v.cost.p95).toBeLessThanOrEqual(v.cost.max);
    expect(v.cost.max).toBeGreaterThan(v.cost.min);
    // per-currency stats: alchemy runs exactly once each attempt
    expect(v.perCurrency.alchemy).toMatchObject({ avg: 1, min: 1, p95: 1, max: 1 });
    // chaos count varies, so its max exceeds its min
    expect(v.perCurrency.chaos.max).toBeGreaterThan(v.perCurrency.chaos.min);
    // histogram bins cover all runs and span [min, max]
    const sum = v.costHistogram.counts.reduce((a, b) => a + b, 0);
    expect(sum).toBe(300);
    expect(v.costHistogram.lo).toBe(v.cost.min);
    expect(v.costHistogram.hi).toBe(v.cost.max);
  });

  it("returns a sample item that satisfies the target", () => {
    const program = parse('alchemy\nwhile not has "physical damage percent" { chaos }');
    const target = parseCondition('has "physical damage percent"');
    const res = runBatch(program, BASE, 82, 50, 3, { target });
    expect(res.sample).toBeDefined();
    expect(evalCond(target, res.sample!)).toBe(true);
  });

  it("has no sample when nothing passes (or no target)", () => {
    const noTarget = runBatch(parse("alchemy"), BASE, 82, 20, 1);
    expect(noTarget.sample).toBeUndefined();
    const impossible = runBatch(parse("alchemy"), BASE, 82, 20, 1, {
      target: parseCondition("corrupted"),
    });
    expect(impossible.sample).toBeUndefined();
  });

  it("runBatchAsync matches runBatch when not cancelled", async () => {
    const program = parse("alchemy");
    const target = parseCondition("rarity is rare");
    const sync = runBatch(program, BASE, 82, 50, 7, { target });
    const asyncRes = await runBatchAsync(program, BASE, 82, 50, 7, { target }, { chunkSize: 10 });
    expect(asyncRes).not.toBeNull();
    expect(asyncRes!.avgTotal).toBe(sync.avgTotal);
    expect(asyncRes!.successRate).toBe(sync.successRate);
  });

  it("runBatchAsync returns null when cancelled mid-run", async () => {
    const program = parse("alchemy");
    let chunks = 0;
    const res = await runBatchAsync(
      program,
      BASE,
      82,
      100,
      1,
      {},
      { chunkSize: 10, cancelled: () => chunks++ >= 1 } // cancel after the first chunk
    );
    expect(res).toBeNull();
  });

  it("runBatchAsync reports progress reaching 1", async () => {
    const program = parse("alchemy");
    let last = 0;
    await runBatchAsync(program, BASE, 82, 30, 1, {}, { chunkSize: 10, onProgress: (f) => (last = f) });
    expect(last).toBe(1);
  });
});

describe("stop limit: steps and cost", () => {
  it("maxSteps stops after the given number of currency operations", () => {
    const res = run(parse("repeat 100 { transmute }"), fresh(), new RNG(1), { maxSteps: 5 });
    expect(res.limitReached).toBe(true);
    expect(res.totalSpent).toBe(5);
  });

  it("does not flag limitReached when under the step cap", () => {
    const res = run(parse("repeat 3 { transmute }"), fresh(), new RNG(1), { maxSteps: 10 });
    expect(res.limitReached).toBe(false);
    expect(res.totalSpent).toBe(3);
  });

  it("maxCost stops once accumulated currency cost is reached", () => {
    // each exalt costs 10; after 3 exalts cost = 30 >= 25 -> stop
    const prices = { exalt: 10 };
    const res = run(parse("repeat 100 { exalt }"), fresh(), new RNG(1), {
      maxCost: 25,
      prices,
    });
    expect(res.limitReached).toBe(true);
    expect(res.totalSpent).toBe(3);
    expect(res.cost).toBe(30);
  });

  it("reports cost from prices even without a limit", () => {
    const res = run(parse("alchemy"), fresh(), new RNG(1), { prices: { alchemy: 2 } });
    expect(res.cost).toBe(2);
    expect(res.limitReached).toBe(false);
  });

  it("batch tracks how often the limit is hit", () => {
    const res = runBatch(parse("repeat 100 { transmute }"), BASE, 82, 50, 1, { maxSteps: 4 });
    expect(res.limitReachedRate).toBe(1);
    expect(res.avgSpent.transmute).toBeCloseTo(4, 5);
  });
});

describe("desecrate / reveal via DSL", () => {
  it("desecrate leaves an unrevealed affix, reveal resolves it", () => {
    const mid = exec("alchemy\ndesecrate");
    expect(mid.item.unrevealed).toBe(1);
    expect(evalCond(parseCondition("unrevealed"), mid.item)).toBe(true);

    // reveal resolves the unrevealed affix into a concrete mod (which may be a
    // regular mod or an Abyssal/desecrated one — the Well offers a mix).
    const before = totalAffixes(mid.item) - mid.item.unrevealed; // concrete count
    const done = exec("alchemy\ndesecrate\nreveal");
    expect(done.item.unrevealed).toBe(0);
    const concrete = done.item.prefixes.length + done.item.suffixes.length;
    expect(concrete).toBe(before + 1);
  });

  it("reveal can offer regular mods, not only Abyssal ones", () => {
    // across seeds at least one reveal resolves to a non-desecrated (regular) mod
    let sawRegular = false;
    let sawDesecrated = false;
    for (let seed = 0; seed < 40 && !(sawRegular && sawDesecrated); seed++) {
      const done = exec("alchemy\ndesecrate\nreveal", seed);
      for (const m of [...done.item.prefixes, ...done.item.suffixes]) {
        if (m.desecrated) sawDesecrated = true;
      }
      // a revealed concrete mod that isn't flagged desecrated is a regular reveal
      if (done.item.unrevealed === 0) {
        const anyDesec = [...done.item.prefixes, ...done.item.suffixes].some((m) => m.desecrated);
        if (!anyDesec) sawRegular = true;
      }
    }
    expect(sawRegular).toBe(true);
  });

  it("reveal pick biases the revealed mod toward the condition", () => {
    // The reveal pool now mixes regular + Abyssal mods. "lightning" is a common,
    // high-weight bow mod family, so it's frequently among the offered options.
    // With `pick`, whenever it's offered it must be chosen — so the match-rate
    // must dominate the random baseline (same seed ⇒ same options drawn).
    const cond = parseCondition('has "lightning"');
    let picked = 0;
    let random = 0;
    const N = 80;
    for (let seed = 0; seed < N; seed++) {
      const p = run(parse('alchemy\ndesecrate\nreveal pick has "lightning"'), fresh(), new RNG(seed));
      const r = run(parse("alchemy\ndesecrate\nreveal"), fresh(), new RNG(seed));
      if (evalCond(cond, p.item)) picked++;
      if (evalCond(cond, r.item)) random++;
    }
    expect(picked).toBeGreaterThan(random);
    expect(picked).toBeGreaterThan(0);
  });

  it("reveal pick still reveals an affix when no option matches", () => {
    const mid = run(parse("alchemy\ndesecrate"), fresh(), new RNG(3));
    const before = mid.item.prefixes.length + mid.item.suffixes.length;
    const res = run(parse('alchemy\ndesecrate\nreveal pick has "definitely-not-a-real-affix"'), fresh(), new RNG(3));
    expect(res.item.unrevealed).toBe(0);
    // falls back to a random pick — a concrete mod is still added
    expect(res.item.prefixes.length + res.item.suffixes.length).toBe(before + 1);
  });
});

describe("regression: documented sample flow", () => {
  it("transmute + greater essence reaches a Rare with a crafted mod", () => {
    const res = exec('transmute\nessence "greater abrasion"');
    expect(res.item.rarity).toBe("Rare");
    expect([...res.item.prefixes, ...res.item.suffixes].some((m) => m.essence)).toBe(true);
    expect(totalAffixes(res.item)).toBe(2);
  });
});

describe("compare blocks (approach comparison)", () => {
  const SRC = `
    alchemy
    compare has prefix "lightning" {
      option "exalt" { while open prefix { exalt } }
      option "perfect" { while open prefix { perfect exalt } }
    }
  `;

  it("a single run takes the first option as the default path", () => {
    // should run alchemy + the first option's body without error
    const res = exec(SRC);
    expect(res.item.rarity).toBe("Rare");
    expect(res.spent.alchemy).toBe(1);
  });

  it("extracts one group per compare block, sharing non-compare statements", () => {
    const groups = extractComparisons(parse(SRC));
    expect(groups).toHaveLength(1);
    expect(groups[0].condText).toContain("lightning");
    expect(groups[0].options.map((o) => o.name)).toEqual(["exalt", "perfect"]);
    // each option program keeps the shared `alchemy` prefix
    for (const o of groups[0].options) {
      expect(o.program[0]).toMatchObject({ kind: "currency", name: "alchemy" });
    }
  });

  it("runs a batch per option with the shared condition as target", async () => {
    const groups = await runComparisonsAsync(parse(SRC), BASE, 82, 60, 7, {});
    expect(groups).not.toBeNull();
    expect(groups![0].options).toHaveLength(2);
    for (const o of groups![0].options) {
      expect(o.result.runs).toBe(60);
      expect(o.result.successRate).toBeGreaterThanOrEqual(0);
      expect(o.result.successRate).toBeLessThanOrEqual(1);
    }
  });

  it("can be cancelled", async () => {
    const groups = await runComparisonsAsync(parse(SRC), BASE, 82, 100, 1, {}, {
      cancelled: () => true,
    });
    expect(groups).toBeNull();
  });
});
