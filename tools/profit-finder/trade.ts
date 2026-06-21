// Minimal *anonymous* PoE2 trade2 client for the profit finder.
//
// We only ever send explicit `type_filters` / `stats` queries (never the
// weighted "Trade for these items" queries), so no POESESSID login is needed —
// these clear the trade site's complexity limit for logged-out users.
//
// Ported/condensed from poe2-pricer (src/main/trade + shared/trade/normalize).

const BASE = "https://www.pathofexile.com/api/trade2";
const UA = "poe2-profit-finder/0.1 (personal crafting tool)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- rates: currency value in Exalted Orbs ("divine" = exalted-per-divine) ----

export type RateTable = Record<string, number>;

const STATIC_RATES: RateTable = {
  exalted: 1,
  divine: 175,
  chaos: 14,
  regal: 0.5,
  vaal: 2.7,
  annul: 79,
  alch: 0.1,
  aug: 0.02,
  transmute: 0.01,
  mirror: 800000,
};

/** Live currency rates from poe2scout (CurrentPrice is already Exalted-denominated). */
export async function getRates(league: string): Promise<RateTable> {
  try {
    const rates: RateTable = { exalted: 1 };
    for (let page = 1; page <= 3; page++) {
      const url =
        `https://poe2scout.com/api/poe2/Leagues/${encodeURIComponent(league)}` +
        `/Currencies/ByCategory?Category=currency&page=${page}`;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) break;
      const data = (await res.json()) as {
        Pages?: number;
        Items?: Array<{ ApiId?: string; CurrentPrice?: number }>;
      };
      for (const it of data.Items ?? []) {
        if (it.ApiId && typeof it.CurrentPrice === "number" && it.CurrentPrice > 0)
          rates[it.ApiId] = it.CurrentPrice;
      }
      if (!data.Pages || page >= data.Pages) break;
    }
    return { ...STATIC_RATES, ...rates };
  } catch {
    return STATIC_RATES;
  }
}

// ---- search + fetch ----

interface PricedListing {
  amount: number;
  currency: string;
  account: string;
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function withRetry<T>(fn: () => Promise<Response>, parse: (r: Response) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fn();
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After")) || 5;
      await sleep((retry + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`trade API ${res.status} ${res.statusText}`);
    return parse(res);
  }
  throw new Error("trade API rate-limited after retries");
}

let lastFetch = 0;
// Spacing between trade API calls. Override with PRICER_GATE_MS (e.g. the scanner
// makes many calls and benefits from a wider gap to avoid 429 backoffs).
const GATE_MS = Number(process.env.PRICER_GATE_MS) || 600;
async function gate(minGap = GATE_MS) {
  const gap = Date.now() - lastFetch;
  if (gap < minGap) await sleep(minGap - gap);
  lastFetch = Date.now();
}

export interface PriceSummary {
  total: number; // total online listings matching
  count: number; // listings we actually fetched & priced
  lowEx?: number;
  p25Ex?: number; // robust "cheapest you'd actually pay" (ignores single steals/trolls)
  medianEx?: number;
  p90Ex?: number;
  lowDiv?: number;
  p25Div?: number;
  medianDiv?: number;
  p90Div?: number;
  url: string;
}

function pct(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** Search a query, fetch the cheapest `max` listings, summarize in Exalted/Divine. */
export async function priceQuery(
  league: string,
  query: unknown,
  rates: RateTable,
  max = 30
): Promise<PriceSummary> {
  await gate();
  const search = await withRetry(
    () =>
      fetch(`${BASE}/search/${encodeURIComponent(league)}`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify(query),
      }),
    (r) => r.json() as Promise<{ id: string; result: string[]; total: number }>
  );
  const url = `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}/${search.id}`;
  const ids = (search.result ?? []).slice(0, max);
  const listings: PricedListing[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    await gate();
    const data = await withRetry(
      () =>
        fetch(`${BASE}/fetch/${batch.join(",")}?query=${encodeURIComponent(search.id)}&realm=poe2`, {
          headers: headers(),
        }),
      (r) =>
        r.json() as Promise<{
          result: Array<{
            listing?: { price?: { amount?: number; currency?: string } | null; account?: { name?: string } };
          } | null>;
        }>
    );
    for (const r of data.result ?? []) {
      const p = r?.listing?.price;
      if (p && typeof p.amount === "number" && p.currency)
        listings.push({ amount: p.amount, currency: p.currency, account: r?.listing?.account?.name ?? "" });
    }
  }

  const exs = listings
    .map((l) => (rates[l.currency] != null ? l.amount * rates[l.currency] : undefined))
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const divRate = rates["divine"];
  const toDiv = (ex?: number) => (ex != null && divRate ? ex / divRate : undefined);
  const lowEx = exs[0];
  const p25Ex = pct(exs, 0.25);
  const medEx = pct(exs, 0.5);
  const p90Ex = pct(exs, 0.9);
  return {
    total: search.total ?? 0,
    count: listings.length,
    lowEx,
    p25Ex,
    medianEx: medEx,
    p90Ex,
    lowDiv: toDiv(lowEx),
    p25Div: toDiv(p25Ex),
    medianDiv: toDiv(medEx),
    p90Div: toDiv(p90Ex),
    url,
  };
}

// ---- query builders ----

export interface StatFilter {
  id: string; // e.g. "explicit.stat_2250533757"
  min?: number;
  max?: number;
}

export interface QuerySpec {
  /** trade category, e.g. "armour.boots", "accessory.ring" */
  category?: string;
  /** exact base type, e.g. "Frayed Shoes" */
  baseType?: string;
  rarity?: "normal" | "magic" | "rare" | "nonunique";
  minSockets?: number;
  minIlvl?: number;
  /** min base Evasion / Energy Shield. Set both to 1 to target dex-int (eva/ES)
   * bases without naming a specific base type. */
  minEvasion?: number;
  minEnergyShield?: number;
  stats?: StatFilter[];
}

/** Build a trade2 search body. Sorted cheapest-first so summaries reflect the
 * realistic market entry / exit price. */
export function buildQuery(spec: QuerySpec): unknown {
  const typeFilters: Record<string, unknown> = {};
  // `type` (exact base) and `category` are mutually exclusive on the trade site —
  // sending both yields 0 results. Prefer the exact base when given.
  if (spec.category && !spec.baseType) typeFilters.category = { option: spec.category };
  if (spec.rarity) typeFilters.rarity = { option: spec.rarity };

  const miscFilters: Record<string, unknown> = {};
  // `rune_sockets` is the trade site's "Augmentable Sockets" filter (empty rune
  // sockets) — works on magic items too.
  if (spec.minSockets != null) miscFilters.rune_sockets = { min: spec.minSockets };
  if (spec.minIlvl != null) miscFilters.ilvl = { min: spec.minIlvl };

  const equipFilters: Record<string, unknown> = {};
  if (spec.minEvasion != null) equipFilters.ev = { min: spec.minEvasion };
  if (spec.minEnergyShield != null) equipFilters.es = { min: spec.minEnergyShield };

  const filters: Record<string, unknown> = {};
  if (Object.keys(typeFilters).length) filters.type_filters = { filters: typeFilters };
  if (Object.keys(miscFilters).length) filters.misc_filters = { filters: miscFilters };
  if (Object.keys(equipFilters).length) filters.equipment_filters = { filters: equipFilters };

  const query: Record<string, unknown> = {
    status: { option: "online" },
    filters,
  };
  if (spec.baseType) query.type = spec.baseType;
  if (spec.stats?.length)
    query.stats = [
      {
        type: "and",
        filters: spec.stats.map((s) => ({ id: s.id, value: { min: s.min, max: s.max } })),
      },
    ];

  return { query, sort: { price: "asc" } };
}
