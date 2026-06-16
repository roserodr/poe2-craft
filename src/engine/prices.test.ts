import { describe, it, expect } from "vitest";
import { DEFAULT_PRICES, fullPrices, totalCost, totalWithBase, formatCost } from "./prices";
import { CURRENCY } from "./item";

describe("prices", () => {
  it("default prices cover every currency", () => {
    const full = fullPrices(DEFAULT_PRICES);
    for (const key of Object.keys(CURRENCY)) {
      expect(typeof full[key]).toBe("number");
    }
  });

  it("totalCost sums count * price", () => {
    const prices = { exalt: 1, chaos: 2, divine: 100 };
    expect(totalCost({ exalt: 3, chaos: 2 }, prices)).toBe(7);
    expect(totalCost({}, prices)).toBe(0);
    expect(totalCost({ unknown: 5 }, prices)).toBe(0);
  });

  it("totalWithBase adds the base item price once", () => {
    const prices = { exalt: 1, chaos: 2 };
    expect(totalWithBase({ chaos: 3 }, prices, 5)).toBe(11); // 6 currency + 5 base
    expect(totalWithBase({ chaos: 3 }, prices, 0)).toBe(6);
    expect(totalWithBase({}, prices, 5)).toBe(5);
  });

  it("formatCost shows ex with a divine suffix when large", () => {
    const prices = { divine: 100 };
    expect(formatCost(5, prices, "ex")).toBe("5.00 ex");
    expect(formatCost(250, prices, "ex")).toBe("250.0 ex (2.50 div)");
  });

  it("formatCost in divine mode shows div with ex in parens", () => {
    const prices = { divine: 100 };
    expect(formatCost(250, prices, "div")).toBe("2.50 div (250.0 ex)");
  });

  it("formatCost falls back to ex when no divine price", () => {
    expect(formatCost(250, { divine: 0 }, "div")).toBe("250.0 ex");
  });
});
