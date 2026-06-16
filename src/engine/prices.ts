import { CURRENCY } from "./item";
import priceData from "../data/prices.json";

/** Costs are expressed in Exalted Orbs. Default values are fetched live from
 * the PoE2 economy (poe2scout) by scripts/fetch-prices.mjs into prices.json. */
export const PRICE_UNIT = priceData.unit;
export const PRICE_LEAGUE = priceData.league;
export const PRICE_UPDATED = priceData.updated;
export const PRICE_SOURCE = priceData.source;

export const DEFAULT_PRICES: Record<string, number> = priceData.prices;

/** Always return a full price map, filling any missing currency with 0. */
export function fullPrices(prices: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(CURRENCY)) out[key] = prices[key] ?? 0;
  return out;
}

/** Total cost in Exalted Orbs for a `spent` count map. */
export function totalCost(
  spent: Record<string, number>,
  prices: Record<string, number>
): number {
  let total = 0;
  for (const [k, n] of Object.entries(spent)) total += n * (prices[k] ?? 0);
  return total;
}

/** Currency cost plus the one-time cost of the base item being crafted. */
export function totalWithBase(
  spent: Record<string, number>,
  prices: Record<string, number>,
  basePrice: number
): number {
  return totalCost(spent, prices) + (basePrice || 0);
}

export type CostUnit = "ex" | "div";

function fmtEx(ex: number): string {
  return `${ex.toFixed(ex < 10 ? 2 : 1)} ex`;
}
function fmtDiv(ex: number, div: number): string {
  const d = div > 0 ? ex / div : 0;
  return `${d.toFixed(d < 10 ? 2 : 1)} div`;
}

/** Pretty-print a cost (stored in Exalted) in the chosen display unit, with the
 * other unit shown in parentheses for context. */
export function formatCost(
  ex: number,
  prices: Record<string, number>,
  unit: CostUnit = "ex"
): string {
  const div = prices.divine || 0;
  if (unit === "div") {
    if (div <= 0) return fmtEx(ex);
    return `${fmtDiv(ex, div)} (${fmtEx(ex)})`;
  }
  // ex primary; show div equivalent once it's meaningfully large
  if (div > 0 && ex >= div) return `${fmtEx(ex)} (${fmtDiv(ex, div)})`;
  return fmtEx(ex);
}
