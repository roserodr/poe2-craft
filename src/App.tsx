import { useMemo, useRef, useState } from "react";
import {
  ESSENCES,
  ALL_MODS,
  modTier,
  groupLabel,
  ITEM_CLASSES,
  setItemClass,
} from "./engine/mods";
import type { ModDef } from "./engine/types";
import { newItem, CURRENCY, OMENS } from "./engine/item";
import { RNG } from "./engine/rng";
import { parse, parseCondition } from "./dsl/parser";
import { run, type RunResult } from "./dsl/interpreter";
import { runBatchAsync, type BatchResult, type Stats } from "./dsl/batch";
import type { Cond } from "./dsl/ast";
import { ItemCard } from "./components/ItemCard";
import {
  DEFAULT_PRICES,
  fullPrices,
  totalWithBase,
  formatCost,
  PRICE_LEAGUE,
  PRICE_UPDATED,
  PRICE_SOURCE,
} from "./engine/prices";

const LOG_RENDER_LIMIT = 500; // cap rendered step-log rows so a huge run can't freeze the UI

/** Compact Exalted value for dense table cells (no div suffix). */
function compactEx(ex: number): string {
  if (ex >= 10000) return (ex / 1000).toFixed(0) + "k";
  if (ex >= 1000) return (ex / 1000).toFixed(1) + "k";
  if (ex >= 10) return Math.round(ex).toString();
  return ex.toFixed(1);
}

/** Cost in whichever unit reads best for the magnitude (div once large, else ex). */
function unitCost(ex: number, prices: Record<string, number>): string {
  const div = prices.divine || 0;
  if (div > 0 && ex >= div) {
    const d = ex / div;
    return `${d < 10 ? d.toFixed(1) : Math.round(d)} div`;
  }
  return `${compactEx(ex)} ex`;
}

function fmtCount(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

const PRICE_STORE_KEY = "poe2craft.prices";
function loadPrices(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PRICE_STORE_KEY);
    if (raw) return fullPrices({ ...DEFAULT_PRICES, ...JSON.parse(raw) });
  } catch {
    /* ignore */
  }
  return fullPrices(DEFAULT_PRICES);
}

type BaseUnit = "ex" | "chaos" | "div";
const BASE_AMOUNT_KEY = "poe2craft.baseAmount";
const BASE_UNIT_KEY = "poe2craft.baseUnit";

function loadBaseAmount(): number {
  try {
    const raw = localStorage.getItem(BASE_AMOUNT_KEY);
    if (raw !== null) return Number(raw);
  } catch {
    /* ignore */
  }
  return 1;
}
function loadBaseUnit(): BaseUnit {
  try {
    const raw = localStorage.getItem(BASE_UNIT_KEY);
    if (raw === "chaos" || raw === "div" || raw === "ex") return raw;
  } catch {
    /* ignore */
  }
  return "ex";
}

/** How many Exalted Orbs one unit is worth. */
function unitFactor(unit: BaseUnit, prices: Record<string, number>): number {
  if (unit === "chaos") return prices.chaos || 1;
  if (unit === "div") return prices.divine || 1;
  return 1;
}

const SAMPLE = `# Essence + fracture flow (0.5 mechanics):
# 1. transmute to Magic, then a Greater essence upgrades it to
#    Rare with a guaranteed flat-physical prefix.
# 2. exalt-fill toward 4 mods.
# 3. lock the phys prefix with a Fracturing Orb so it survives.
# 4. desecrate (adds a blank affix) then reveal it.

transmute
essence "greater abrasion"
while affixes < 4 {
  exalt
}
if has prefix "physical damage" and not fractured {
  fracture
}
if not desecrated and not unrevealed and open suffix {
  desecrate
  reveal
}
`;

const BOOTS_SAMPLE = `# Boots: chase movement speed + life
alchemy
while not has "movement speed" {
  chaos
}
if open prefix {
  exalt
}
`;

// per-class default script + success metric
const CLASS_DEFAULTS: Record<string, { sample: string; target: string; base?: string }> = {
  bow: { sample: SAMPLE, target: 'has prefix "increased physical damage"', base: "Heavy Bow" },
  dexIntBoots: { sample: BOOTS_SAMPLE, target: 'has "movement speed"', base: "Daggerfoot Shoes" },
};

const classBases = (key: string) => ITEM_CLASSES.find((c) => c.key === key)!.bases;

export default function App() {
  const [classKey, setClassKey] = useState("bow");
  const bases = classBases(classKey);
  const [baseName, setBaseName] = useState(
    bases.find((b) => b.name === CLASS_DEFAULTS.bow.base)?.name ?? bases[0].name
  );
  const [ilvl, setIlvl] = useState(82);
  const [seed, setSeed] = useState(12345);
  const [script, setScript] = useState(SAMPLE);
  const [target, setTarget] = useState('has prefix "increased physical damage"');
  const [batchRuns, setBatchRuns] = useState(2000);
  const [stopMode, setStopMode] = useState<"none" | "steps" | "cost">("none");
  const [stopValue, setStopValue] = useState(20);

  const [result, setResult] = useState<RunResult | null>(null);
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const [prices, setPrices] = useState<Record<string, number>>(loadPrices);
  const [baseAmount, setBaseAmountState] = useState<number>(loadBaseAmount);
  const [baseUnit, setBaseUnitState] = useState<BaseUnit>(loadBaseUnit);

  function setBaseAmount(value: number) {
    setBaseAmountState(value);
    try {
      localStorage.setItem(BASE_AMOUNT_KEY, String(value));
    } catch {
      /* ignore */
    }
  }
  /** Switch units, preserving the underlying Exalted value. */
  function setBaseUnit(unit: BaseUnit) {
    const exValue = baseAmount * unitFactor(baseUnit, prices);
    const newAmount = Math.round((exValue / unitFactor(unit, prices)) * 1000) / 1000;
    setBaseAmountState(newAmount);
    setBaseUnitState(unit);
    try {
      localStorage.setItem(BASE_AMOUNT_KEY, String(newAmount));
      localStorage.setItem(BASE_UNIT_KEY, unit);
    } catch {
      /* ignore */
    }
  }

  const basePrice = baseAmount * unitFactor(baseUnit, prices); // in Exalted

  function updatePrice(key: string, value: number) {
    const next = { ...prices, [key]: value };
    setPrices(next);
    try {
      localStorage.setItem(PRICE_STORE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  function resetPrices() {
    setPrices(fullPrices(DEFAULT_PRICES));
    try {
      localStorage.removeItem(PRICE_STORE_KEY);
    } catch {
      /* ignore */
    }
  }

  const base = useMemo(
    () => bases.find((b) => b.name === baseName) ?? bases[0],
    [bases, baseName]
  );

  function changeClass(key: string) {
    setItemClass(key); // engine reads from this class now
    setClassKey(key);
    const d = CLASS_DEFAULTS[key];
    const cb = classBases(key);
    setBaseName((d?.base && cb.find((b) => b.name === d.base)?.name) ?? cb[0].name);
    setScript(d?.sample ?? "");
    setTarget(d?.target ?? "");
    setResult(null);
    setBatch(null);
    setError(null);
  }

  function compile() {
    setError(null);
    const program = parse(script);
    let targetCond: Cond | undefined;
    const t = target.trim();
    if (t) targetCond = parseCondition(t);
    return { program, targetCond };
  }

  /** Stop-limit options shared by single and batch runs. */
  function limitOpts() {
    return {
      maxSteps: stopMode === "steps" ? stopValue : undefined,
      maxCost: stopMode === "cost" ? stopValue : undefined,
      prices,
    };
  }

  /** Show the spinner, then run heavy work on the next tick so it can paint. */
  function deferred(fn: () => void) {
    setBusy(true);
    setTimeout(() => {
      try {
        fn();
      } finally {
        setBusy(false);
      }
    }, 20);
  }

  function doRun(useRandomSeed = false) {
    if (busy) return;
    setBatch(null);
    const runSeed = useRandomSeed ? Math.floor(Math.random() * 1e9) : seed;
    if (useRandomSeed) setSeed(runSeed);
    // parse synchronously so syntax errors surface immediately (no spinner)
    let program;
    try {
      program = compile().program;
    } catch (e) {
      setResult(null);
      setError(String(e instanceof Error ? e.message : e));
      return;
    }
    deferred(() => {
      try {
        const item = newItem(base, ilvl);
        setResult(run(program, item, new RNG(runSeed), { collectLog: true, ...limitOpts() }));
      } catch (e) {
        setResult(null);
        setError(String(e instanceof Error ? e.message : e));
      }
    });
  }

  async function doBatch() {
    if (busy) return;
    let compiled;
    try {
      compiled = compile();
    } catch (e) {
      setBatch(null);
      setError(String(e instanceof Error ? e.message : e));
      return;
    }
    cancelRef.current = false;
    setProgress(0);
    setBusy(true);
    setSimulating(true);
    try {
      const res = await runBatchAsync(
        compiled.program,
        base,
        ilvl,
        batchRuns,
        seed,
        { target: compiled.targetCond, ...limitOpts() },
        { cancelled: () => cancelRef.current, onProgress: setProgress }
      );
      if (res) setBatch(res); // null => cancelled, keep previous
    } catch (e) {
      setBatch(null);
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setSimulating(false);
    }
  }

  function cancelBatch() {
    cancelRef.current = true;
  }

  return (
    <div className="app">
      <div className="header">
        <h1>PoE2 Crafting Simulator</h1>
        <span className="sub">
          mod data from Path of Building (PoE2) · references{" "}
          <a href="https://poe2db.tw/us" target="_blank" rel="noreferrer">
            poe2db
          </a>
        </span>
      </div>

      <div className="grid">
        <div>
          <div className="panel">
            <h2>Base & Setup</h2>
            <div className="row">
              <label>
                Item class
                <select value={classKey} onChange={(e) => changeClass(e.target.value)}>
                  {ITEM_CLASSES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Base
                <select value={baseName} onChange={(e) => setBaseName(e.target.value)}>
                  {bases.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name} (lvl {b.level})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Item level
                <input
                  type="number"
                  value={ilvl}
                  min={1}
                  max={100}
                  style={{ width: 70 }}
                  onChange={(e) => setIlvl(Number(e.target.value))}
                />
              </label>
              <label>
                Base price
                <span style={{ display: "flex", gap: 4 }}>
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    value={baseAmount}
                    style={{ width: 80 }}
                    onChange={(e) => setBaseAmount(Number(e.target.value))}
                  />
                  <select
                    value={baseUnit}
                    onChange={(e) => setBaseUnit(e.target.value as BaseUnit)}
                  >
                    <option value="ex">ex</option>
                    <option value="chaos">chaos</option>
                    <option value="div">div</option>
                  </select>
                </span>
              </label>
            </div>
          </div>

          <div className="panel">
            <h2>Crafting Script</h2>
            <textarea value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                Stop after
                <select
                  value={stopMode}
                  onChange={(e) => setStopMode(e.target.value as typeof stopMode)}
                >
                  <option value="none">no limit</option>
                  <option value="steps">N steps</option>
                  <option value="cost">N exalted spent</option>
                </select>
              </label>
              {stopMode !== "none" && (
                <label>
                  {stopMode === "steps" ? "Max steps" : "Max exalted"}
                  <input
                    type="number"
                    min={1}
                    style={{ width: 90 }}
                    value={stopValue}
                    onChange={(e) => setStopValue(Number(e.target.value))}
                  />
                </label>
              )}
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <label>
                Seed
                <input
                  type="number"
                  value={seed}
                  style={{ width: 110 }}
                  onChange={(e) => setSeed(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="row">
              <button onClick={() => doRun(false)} disabled={busy}>
                {busy && !simulating && <span className="spinner" />}
                Run
              </button>
              <button className="secondary" onClick={() => doRun(true)} disabled={busy}>
                Run with random seed
              </button>
            </div>
            {error && <div className="error">{error}</div>}
          </div>

          <div className="panel">
            <h2>Monte Carlo</h2>
            <div className="row">
              <label style={{ flex: 1 }}>
                Target condition (success metric)
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="row">
              <label>
                Runs
                <input
                  type="number"
                  value={batchRuns}
                  min={1}
                  max={200000}
                  style={{ width: 90 }}
                  onChange={(e) => setBatchRuns(Number(e.target.value))}
                />
              </label>
              {simulating ? (
                <>
                  <button disabled>
                    <span className="spinner" />
                    Simulating…
                  </button>
                  <button className="secondary" onClick={cancelBatch}>
                    Cancel
                  </button>
                </>
              ) : (
                <button onClick={doBatch} disabled={busy}>
                  Simulate {batchRuns}×
                </button>
              )}
            </div>
            {simulating && (
              <>
                <div className="progress">
                  <div style={{ width: `${progress * 100}%` }} />
                </div>
                <div className="progress-label">
                  {Math.round(progress * 100)}% — {Math.round(progress * batchRuns).toLocaleString()}{" "}
                  / {batchRuns.toLocaleString()} attempts
                </div>
              </>
            )}
            {batch && <BatchView batch={batch} prices={prices} basePrice={basePrice} />}
          </div>

        </div>

        <div>
          <div className="panel">
            <h2>Result Item</h2>
            <ItemCard item={result ? result.item : newItem(base, ilvl)} />
            {result && (
              <div style={{ marginTop: 10 }}>
                {result.budgetExceeded && (
                  <div className="bad">
                    ⚠ Operation budget exceeded — likely an infinite loop (e.g. a `while`
                    condition that can never be satisfied).
                  </div>
                )}
                {result.stoppedEarly && <div className="muted">Stopped early via `stop`.</div>}
                {result.limitReached && (
                  <div className="good">
                    ■ Stopped at your limit ({stopMode === "steps" ? `${stopValue} steps` : `${stopValue} ex`}).
                  </div>
                )}
                <SpentView
                  spent={result.spent}
                  total={result.totalSpent}
                  prices={prices}
                  basePrice={basePrice}
                />
              </div>
            )}
          </div>

          {result && (
            <div className="panel">
              <h2>Step Log ({result.totalSpent})</h2>
              <div className="log">
                {result.log.slice(0, LOG_RENDER_LIMIT).map((e, i) => (
                  <div key={i} className={`entry ${e.applied ? "" : "fail"}`}>
                    <span className="ln">{e.line}</span>
                    <span className="cur">{e.currency}</span> — {e.note}
                    <span className="muted"> ({e.affixCount} affixes)</span>
                  </div>
                ))}
                {result.log.length > LOG_RENDER_LIMIT && (
                  <div className="muted">
                    …showing first {LOG_RENDER_LIMIT.toLocaleString()} of{" "}
                    {result.totalSpent.toLocaleString()} steps
                  </div>
                )}
                {result.log.length === 0 && <div className="muted">no operations ran</div>}
              </div>
            </div>
          )}

          <PricePanel prices={prices} onChange={updatePrice} onReset={resetPrices} />
          <AffixPanel ilvl={ilvl} />
          <OmenPanel />
          <EssencePanel />
          <HelpPanel />
        </div>
      </div>
    </div>
  );
}

function SpentView({
  spent,
  total,
  prices,
  basePrice,
}: {
  spent: Record<string, number>;
  total: number;
  prices: Record<string, number>;
  basePrice: number;
}) {
  const entries = Object.entries(spent).sort((a, b) => b[1] - a[1]);
  const cost = totalWithBase(spent, prices, basePrice);
  return (
    <table className="stats">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td>{CURRENCY[k]?.label ?? k}</td>
            <td>{v}</td>
            <td className="muted">{formatCost(v * (prices[k] ?? 0), prices)}</td>
          </tr>
        ))}
        {basePrice > 0 && (
          <tr>
            <td className="muted">Base item</td>
            <td className="muted">1</td>
            <td className="muted">{formatCost(basePrice, prices)}</td>
          </tr>
        )}
        <tr>
          <td>
            <b>Total cost</b>
          </td>
          <td>
            <b>{total}</b>
          </td>
          <td className="good">
            <b>{formatCost(cost, prices)}</b>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function BatchView({
  batch,
  prices,
  basePrice,
}: {
  batch: BatchResult;
  prices: Record<string, number>;
  basePrice: number;
}) {
  const entries = Object.entries(batch.avgSpent).sort((a, b) => b[1] - a[1]);
  const metrics = ["avg", "min", "p95", "max"] as const;
  // two right-aligned cells per metric: count, then cost
  const divider = { borderLeft: "1px solid var(--border)", paddingLeft: 8 } as const;
  const cells = (count: number, ex: number, cls: string, key: string) => [
    <td key={key + "n"} className={cls} style={{ textAlign: "right", paddingRight: 3, ...divider }}>
      {fmtCount(count)}×
    </td>,
    <td key={key + "c"} className={cls} style={{ textAlign: "right", paddingRight: 10 }}>
      {unitCost(ex, prices)}
    </td>,
  ];
  // a row where cost = count × price (a single currency or the base item)
  const currencyRow = (label: string, counts: Stats, price: number, cls = "") => (
    <tr key={label} className="mc-row">
      <td className={cls}>{label}</td>
      {metrics.flatMap((m) => cells(counts[m], counts[m] * price, cls, m))}
    </tr>
  );
  const flat = (v: number): Stats => ({ avg: v, min: v, p95: v, max: v });
  const totalAvgCost = batch.cost.avg + basePrice;
  return (
    <div>
      <table className="metrics">
        <tbody>
          <tr>
            <td>Runs</td>
            <td colSpan={8}>{batch.runs}</td>
          </tr>
          <tr>
            <td className="good">Success rate (target met)</td>
            <td className="good" colSpan={8}>
              {(batch.successRate * 100).toFixed(1)}%
            </td>
          </tr>
          {batch.budgetExceededRate > 0 && (
            <tr>
              <td className="bad">Hit op budget</td>
              <td className="bad" colSpan={8}>
                {(batch.budgetExceededRate * 100).toFixed(1)}%
              </td>
            </tr>
          )}
          {batch.limitReachedRate > 0 && (
            <tr>
              <td>Hit stop limit</td>
              <td colSpan={8}>{(batch.limitReachedRate * 100).toFixed(1)}%</td>
            </tr>
          )}
          <tr className="muted mc-head">
            <td style={{ paddingTop: 8 }}>Currency</td>
            {metrics.map((m) => (
              <td
                key={m}
                colSpan={2}
                style={{ paddingTop: 8, textAlign: "right", paddingRight: 10, ...divider }}
              >
                {m === "avg" ? "Avg" : m === "p95" ? "p95" : m === "min" ? "Min" : "Max"}
              </td>
            ))}
          </tr>
          {entries.map(([k]) =>
            currencyRow(CURRENCY[k]?.label ?? k, batch.perCurrency[k] ?? flat(0), prices[k] ?? 0)
          )}
          {basePrice > 0 && currencyRow("Base item", flat(1), basePrice, "muted")}
          {/* Total: count from totalCount, cost from cost (+ base) — not a single price */}
          <tr className="good mc-total">
            <td>Total</td>
            {metrics.flatMap((m) =>
              cells(batch.totalCount[m], batch.cost[m] + basePrice, "good", "t" + m)
            )}
          </tr>
          {batch.successRate > 0 && (
            <tr>
              <td className="good">Per success</td>
              {cells(
                batch.totalCount.avg / batch.successRate,
                totalAvgCost / batch.successRate,
                "good",
                "ps"
              )}
              <td colSpan={6} style={divider}></td>
            </tr>
          )}
        </tbody>
      </table>
      <CostHistogram hist={batch.costHistogram} basePrice={basePrice} />
      {batch.sample && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            Example item from a passing run:
          </div>
          <ItemCard item={batch.sample} />
        </div>
      )}
    </div>
  );
}

function CostHistogram({
  hist,
  basePrice,
}: {
  hist: { lo: number; hi: number; counts: number[] };
  basePrice: number;
}) {
  const peak = Math.max(...hist.counts);
  const maxCount = Math.max(1, peak);
  const n = hist.counts.length;
  const span = hist.hi - hist.lo;
  const H = 64;
  const TICKS = 4; // x-axis: TICKS + 1 evenly spaced labels
  const xLabels = Array.from({ length: TICKS + 1 }, (_, i) =>
    compactEx(hist.lo + basePrice + (span * i) / TICKS)
  );
  const axisStyle = { fontSize: 10, color: "var(--muted)" } as const;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ marginBottom: 4 }}>
        Total cost distribution (ex)
      </div>
      <div style={{ display: "flex" }}>
        {/* y-axis: peak count at top, 0 at bottom */}
        <div
          style={{
            ...axisStyle,
            height: H,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            textAlign: "right",
            paddingRight: 4,
            minWidth: 24,
          }}
        >
          <span>{peak}</span>
          <span>0</span>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 1,
              height: H,
              background: "var(--panel2)",
              border: "1px solid var(--border)",
              padding: "0 1px",
            }}
          >
            {hist.counts.map((c, i) => {
              const lo = hist.lo + basePrice + (span * i) / n;
              const hi = hist.lo + basePrice + (span * (i + 1)) / n;
              const px = c > 0 ? Math.max(2, Math.round((c / maxCount) * H)) : 0;
              return (
                <div
                  key={i}
                  title={`${compactEx(lo)}–${compactEx(hi)} ex: ${c} run${c === 1 ? "" : "s"}`}
                  style={{ flex: 1, height: `${px}px`, background: "var(--accent)" }}
                />
              );
            })}
          </div>
          {/* x-axis ticks */}
          <div style={{ ...axisStyle, display: "flex", justifyContent: "space-between", marginTop: 2 }}>
            {xLabels.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PricePanel({
  prices,
  onChange,
  onReset,
}: {
  prices: Record<string, number>;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="panel help">
      <h2>Currency Prices (Exalted Orbs)</h2>
      <p className="muted">
        Live from{" "}
        <a href={PRICE_SOURCE} target="_blank" rel="noreferrer">
          poe2scout
        </a>{" "}
        — <b>{PRICE_LEAGUE}</b>, updated {PRICE_UPDATED}. Re-run{" "}
        <code>node scripts/fetch-prices.mjs</code> to refresh. Your edits are saved in your
        browser and override the defaults.
      </p>
      <details>
        <summary>Edit prices</summary>
        <table style={{ marginTop: 6 }}>
          <tbody>
            {Object.keys(CURRENCY).map((k) => (
              <tr key={k}>
                <td>{CURRENCY[k].label}</td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    style={{ width: 90 }}
                    value={prices[k] ?? 0}
                    onChange={(e) => onChange(k, Number(e.target.value))}
                  />
                  <span className="muted"> ex</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="secondary" style={{ marginTop: 8 }} onClick={onReset}>
          Reset to defaults
        </button>
      </details>
    </div>
  );
}

function AffixPanel({ ilvl }: { ilvl: number }) {
  const slot = (type: "Prefix" | "Suffix") => {
    const list = ALL_MODS.filter((m) => m.type === type && m.level <= ilvl && m.weight > 0);
    const sum = list.reduce((s, m) => s + m.weight, 0);
    list.sort((a, b) => (a.group === b.group ? b.level - a.level : a.group.localeCompare(b.group)));
    return { list, sum };
  };
  const pre = slot("Prefix");
  const suf = slot("Suffix");

  const rows = (data: { list: ModDef[]; sum: number }, title: string) => (
    <>
      <tr>
        <td colSpan={4} className="muted" style={{ paddingTop: 8 }}>
          {title} — {data.list.length} mods, total weight {data.sum}
        </td>
      </tr>
      <tr className="muted">
        <td>Modifier</td>
        <td>Level</td>
        <td>Weight</td>
        <td>Chance</td>
      </tr>
      {data.list.map((m) => {
        const { tier, count } = modTier(m);
        return (
          <tr key={m.id}>
            <td>
              {m.lines.join(", ")}
              <span className="tier">
                {" "}
                T{tier}/{count}
              </span>
              <div className="tier" style={{ marginLeft: 0 }}>
                affix: <code>{groupLabel(m.group)}</code>
              </div>
            </td>
            <td>{m.level}</td>
            <td>{m.weight}</td>
            <td className="muted">{((100 * m.weight) / data.sum).toFixed(1)}%</td>
          </tr>
        );
      })}
    </>
  );

  return (
    <div className="panel help">
      <h2>Affix Pool</h2>
      <p className="muted">
        Modifiers that can roll on this bow at item level {ilvl}, with spawn weight and the
        per-add chance within each slot. Weights are sourced from{" "}
        <a href="https://poe2db.tw/us/Bows#ModifiersCalc" target="_blank" rel="noreferrer">
          poe2db
        </a>{" "}
        and drive the simulator's weighted rolls. Target an affix unambiguously by using
        its name, e.g. <code>has prefix "Physical Damage Percent"</code>.
      </p>
      <details>
        <summary>
          {pre.list.length} prefixes, {suf.list.length} suffixes
        </summary>
        <div style={{ maxHeight: 360, overflow: "auto", marginTop: 6 }}>
          <table className="stats">
            <tbody>
              {rows(pre, "Prefixes")}
              {rows(suf, "Suffixes")}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function OmenPanel() {
  return (
    <div className="panel help">
      <h2>Omens</h2>
      <p className="muted">
        An omen modifies the next currency use. Attach one (or more) with{" "}
        <code>with "..."</code>, e.g. <code>exalt with "sinistral"</code>,{" "}
        <code>annul with "whittling"</code>. Combine compatible omens with{" "}
        <code>and</code> or another <code>with</code>, e.g.{" "}
        <code>exalt with "greater" and "sinistral"</code> (adds two prefixes).
      </p>
      <details>
        <summary>{Object.keys(OMENS).length} omens</summary>
        <table style={{ marginTop: 6 }}>
          <tbody>
            {Object.values(OMENS).map((o) => (
              <tr key={o.key}>
                <td style={{ color: "var(--accent)" }}>{o.label}</td>
                <td>
                  <code>
                    {o.currency} with "{o.key}"
                  </code>
                </td>
                <td className="muted">{o.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function EssencePanel() {
  const real = ESSENCES.filter((e) => e.rank !== "Corrupted");
  return (
    <div className="panel help">
      <h2>Bow Essences</h2>
      <p className="muted">
        Lesser/Greater essences (<code>essence "abrasion"</code>,{" "}
        <code>essence "greater flames"</code>) go on a <b>Magic</b> item and upgrade it to
        Rare with the mod. <b>Perfect</b> essences (<code>essence "perfect ice"</code>) go on
        a <b>Rare</b> item, removing a random mod then adding theirs. Match is by name words.
      </p>
      <details>
        <summary>{real.length} essences that roll on bows</summary>
        <table style={{ marginTop: 6 }}>
          <tbody>
            {real.map((e) => (
              <tr key={e.key}>
                <td style={{ color: "#7bd6c0" }}>{e.name}</td>
                <td>{e.mod.lines.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function HelpPanel() {
  return (
    <div className="panel help">
      <h2>DSL Reference</h2>
      <details open>
        <summary>Commands & syntax</summary>
        <p>
          <b>Currencies:</b>{" "}
          {Object.keys(CURRENCY)
            .filter((k) => !/[A-Z]/.test(k))
            .map((k) => (
              <code key={k} style={{ marginRight: 4 }}>
                {k}
              </code>
            ))}
        </p>
        <p>
          <b>Tiered orbs:</b> prefix <code>transmute</code>, <code>augment</code>,{" "}
          <code>regal</code>, <code>chaos</code>, or <code>exalt</code> with{" "}
          <code>greater</code> or <code>perfect</code> — e.g. <code>greater exalt</code>,{" "}
          <code>perfect chaos</code>. These force the added modifier to mod level ≥ 35
          (greater) or ≥ 50 (perfect).
        </p>
        <p>
          <b>Omens:</b> attach to a currency with <code>with "..."</code> to alter its
          behavior — e.g. <code>exalt with "sinistral"</code> (add a prefix),{" "}
          <code>annul with "whittling"</code> (remove the lowest mod). See the Omens panel.
        </p>
        <p>
          <b>Control flow:</b>
        </p>
        <table>
          <tbody>
            <tr>
              <td>
                <code>while &lt;cond&gt; {"{ ... }"}</code>
              </td>
              <td>loop while condition is true</td>
            </tr>
            <tr>
              <td>
                <code>until &lt;cond&gt; {"{ ... }"}</code>
              </td>
              <td>loop until condition becomes true</td>
            </tr>
            <tr>
              <td>
                <code>repeat N {"{ ... }"}</code>
              </td>
              <td>run the block N times</td>
            </tr>
            <tr>
              <td>
                <code>if &lt;cond&gt; {"{ }"} else {"{ }"}</code>
              </td>
              <td>conditional</td>
            </tr>
            <tr>
              <td>
                <code>stop</code>
              </td>
              <td>end the script immediately</td>
            </tr>
          </tbody>
        </table>
        <p>
          <b>Conditions:</b>
        </p>
        <table>
          <tbody>
            <tr>
              <td>
                <code>has prefix "Physical Damage Percent"</code>
              </td>
              <td>
                exact match when the text is an affix name (see Affix Pool); otherwise a
                substring over the rolled text
              </td>
            </tr>
            <tr>
              <td>
                <code>has suffix "attack speed"</code> / <code>has "physical"</code>
              </td>
              <td>suffix-only / either (substring when not an exact affix name)</td>
            </tr>
            <tr>
              <td>
                <code>has prefix group "Accuracy Rating"</code>
              </td>
              <td>force exact affix match (same as a bare name)</td>
            </tr>
            <tr>
              <td>
                <code>has prefix "phys" tier &lt;= 2</code>, <code>has tier == 1</code>,{" "}
                <code>has prefix "phys" fractured</code>
              </td>
              <td>tier filter (T1 = best) / fractured filter; text optional</td>
            </tr>
            <tr>
              <td>
                <code>prefixes &gt;= N</code>, <code>suffixes &lt; N</code>,{" "}
                <code>affixes == N</code>
              </td>
              <td>count comparisons</td>
            </tr>
            <tr>
              <td>
                <code>open prefix</code> / <code>open suffix</code>
              </td>
              <td>room for another mod</td>
            </tr>
            <tr>
              <td>
                <code>rarity is rare</code>, <code>corrupted</code>, <code>full</code>
              </td>
              <td>state checks</td>
            </tr>
            <tr>
              <td>
                <code>fractured</code>, <code>desecrated</code>, <code>crafted</code>,{" "}
                <code>unrevealed</code>
              </td>
              <td>a locked / desecrated / essence / unrevealed-desecrated affix is present</td>
            </tr>
            <tr>
              <td>
                <code>not</code>, <code>and</code>, <code>or</code>, <code>( )</code>
              </td>
              <td>combine conditions</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Comments start with <code>#</code> or <code>//</code>. Text matching is
          case-insensitive substring; e.g. <code>has prefix "physical"</code> matches the
          increased-physical-damage prefix.
        </p>
      </details>
    </div>
  );
}
