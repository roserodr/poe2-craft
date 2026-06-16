import { describe, it, expect } from "vitest";
import { RNG } from "./rng";

describe("RNG", () => {
  it("is deterministic for a given seed", () => {
    const a = new RNG(42);
    const b = new RNG(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds give different sequences", () => {
    const a = new RNG(1);
    const b = new RNG(2);
    expect(a.next()).not.toEqual(b.next());
  });

  it("next() stays within [0, 1)", () => {
    const r = new RNG(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int() stays within inclusive bounds", () => {
    const r = new RNG(123);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(8);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("weighted() returns -1 when total weight is 0", () => {
    const r = new RNG(1);
    expect(r.weighted([0, 0, 0])).toBe(-1);
  });

  it("weighted() only picks non-zero-weight indices", () => {
    const r = new RNG(99);
    const weights = [0, 5, 0, 2];
    for (let i = 0; i < 200; i++) {
      const idx = r.weighted(weights);
      expect([1, 3]).toContain(idx);
    }
  });
});
