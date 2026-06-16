import { describe, it, expect } from "vitest";
import { parse, parseCondition, ParseError } from "./parser";
import { tokenize, LexError } from "./lexer";

describe("lexer", () => {
  it("tokenizes words, numbers, strings and operators", () => {
    const types = tokenize('chaos 3 "x" >=').map((t) => t.type);
    expect(types).toEqual(["word", "number", "string", "op", "eof"]);
  });

  it("ignores # and // comments", () => {
    const toks = tokenize("chaos # comment\nexalt // another");
    expect(toks.filter((t) => t.type === "word").map((t) => t.value)).toEqual([
      "chaos",
      "exalt",
    ]);
  });

  it("throws on an unterminated string", () => {
    expect(() => tokenize('essence "abc')).toThrow(LexError);
  });
});

describe("parser: statements", () => {
  it("parses a bare currency command", () => {
    expect(parse("chaos")).toEqual([{ kind: "currency", name: "chaos", arg: undefined, line: 1 }]);
  });

  it("allows an optional 'orb' word", () => {
    expect(parse("chaos orb")[0]).toMatchObject({ kind: "currency", name: "chaos" });
  });

  it("parses essence with a string argument", () => {
    expect(parse('essence "greater flames"')[0]).toMatchObject({
      kind: "currency",
      name: "essence",
      arg: "greater flames",
    });
  });

  it("maps tiered orbs 'greater'/'perfect' to camelCase keys", () => {
    expect(parse("greater exalt")[0]).toMatchObject({ name: "greaterExalt" });
    expect(parse("perfect chaos orb")[0]).toMatchObject({ name: "perfectChaos" });
  });

  it("parses a currency with an omen and resolves its canonical key", () => {
    expect(parse('exalt with "sinistral"')[0]).toMatchObject({
      name: "exalt",
      omens: ["sinistral exaltation"],
    });
    expect(parse('annul with "whittling"')[0]).toMatchObject({
      name: "annul",
      omens: ["whittling"],
    });
    expect(parse('perfect chaos with "dextral erasure"')[0]).toMatchObject({
      name: "perfectChaos",
      omens: ["dextral erasure"],
    });
  });

  it("parses multiple omens (with…with and with…and)", () => {
    expect(parse('exalt with "greater" with "sinistral"')[0]).toMatchObject({
      omens: ["greater exaltation", "sinistral exaltation"],
    });
    expect(parse('exalt with "greater" and "dextral"')[0]).toMatchObject({
      omens: ["greater exaltation", "dextral exaltation"],
    });
  });

  it("parses essence and reveal omens", () => {
    expect(parse('essence "perfect abrasion" with "sinistral crystallisation"')[0]).toMatchObject({
      name: "essence",
      arg: "perfect abrasion",
      omens: ["sinistral crystallisation"],
    });
    expect(parse('reveal with "dextral necromancy"')[0]).toMatchObject({
      name: "reveal",
      omens: ["dextral necromancy"],
    });
  });

  it("rejects an omen that doesn't apply to the currency", () => {
    expect(() => parse('chaos with "sinistral exaltation"')).toThrow(ParseError);
    expect(() => parse('exalt with "nonsense"')).toThrow(ParseError);
    expect(() => parse('reveal with "sinistral exaltation"')).toThrow(ParseError);
  });

  it("parses repeat / while / until / if-else / stop", () => {
    const prog = parse(`
      repeat 3 { chaos }
      while open prefix { exalt }
      until rarity is rare { regal }
      if corrupted { stop } else { divine }
    `);
    expect(prog.map((s) => s.kind)).toEqual(["repeat", "while", "until", "if"]);
  });
});

describe("parser: errors", () => {
  it("rejects an unknown command", () => {
    expect(() => parse("frobnicate")).toThrow(ParseError);
  });

  it("rejects a non-tierable greater/perfect orb", () => {
    expect(() => parse("perfect alchemy")).toThrow(ParseError);
  });

  it("rejects an unterminated block", () => {
    expect(() => parse("while corrupted { chaos")).toThrow(ParseError);
  });

  it("gives a helpful error when a condition is left dangling before a statement", () => {
    // dangling 'and' before a `while` -> the `while` is read in condition position
    expect(() => parse("while corrupted and\nwhile corrupted { chaos }")).toThrow(
      /expected a condition but found 'while'/
    );
    // dangling 'or' before a currency command
    expect(() => parse("while corrupted or\nchaos")).toThrow(/expected a condition but found 'chaos'/);
  });
});

describe("parseCondition", () => {
  it("parses has / count / open / rarity / state conditions", () => {
    expect(parseCondition('has prefix "phys"')).toEqual({
      kind: "has",
      slot: "prefix",
      text: "phys",
    });
    expect(parseCondition("suffixes >= 2")).toEqual({
      kind: "count",
      what: "suffixes",
      op: ">=",
      value: 2,
    });
    expect(parseCondition("open suffix")).toEqual({ kind: "open", slot: "suffix" });
    expect(parseCondition("rarity is rare")).toEqual({ kind: "rarity", value: "rare" });
    expect(parseCondition("fractured")).toEqual({ kind: "fractured" });
    expect(parseCondition("desecrated")).toEqual({ kind: "desecrated" });
    expect(parseCondition("crafted")).toEqual({ kind: "crafted" });
    expect(parseCondition("unrevealed")).toEqual({ kind: "unrevealed" });
  });

  it("handles not / and / or with precedence", () => {
    const c = parseCondition('not corrupted and (has "x" or fractured)');
    expect(c.kind).toBe("and");
  });

  it("parses a has condition with a tier filter", () => {
    expect(parseCondition('has prefix "phys" tier <= 2')).toEqual({
      kind: "has",
      slot: "prefix",
      text: "phys",
      tier: { op: "<=", value: 2 },
    });
  });

  it("parses a has condition with an exact affix group", () => {
    expect(parseCondition('has prefix group "Accuracy Rating"')).toEqual({
      kind: "has",
      slot: "prefix",
      text: "",
      group: "accuracy rating",
      tier: undefined,
      fractured: undefined,
    });
  });

  it("parses a tier-only has condition (no text)", () => {
    expect(parseCondition("has tier == 1")).toEqual({
      kind: "has",
      slot: "any",
      text: "",
      tier: { op: "==", value: 1 },
    });
  });

  it("rejects a has condition with neither text nor tier", () => {
    expect(() => parseCondition("has prefix")).toThrow(ParseError);
  });

  it("parses a has condition with a fractured filter", () => {
    expect(parseCondition('has prefix "phys" fractured')).toEqual({
      kind: "has",
      slot: "prefix",
      text: "phys",
      tier: undefined,
      fractured: true,
    });
    expect(parseCondition("has fractured")).toMatchObject({
      slot: "any",
      text: "",
      fractured: true,
    });
  });
});
