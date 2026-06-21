import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ESSENCES,
  ALL_MODS,
  modTier,
  groupLabel,
  ITEM_CLASSES,
  setItemClass,
} from "./engine/mods";
import type { ModDef, Rarity } from "./engine/types";
import { buildStartItem, CURRENCY, OMENS } from "./engine/item";
import { RNG } from "./engine/rng";
import { parse, parseCondition } from "./dsl/parser";
import { highlightScript, formatScript } from "./dsl/highlight";
import { run, type RunResult } from "./dsl/interpreter";
import {
  runBatchAsync,
  runComparisonsAsync,
  extractComparisons,
  type BatchResult,
  type Stats,
  type ComparisonGroup,
} from "./dsl/batch";
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
import {
  SETTINGS_VERSION,
  encodeSettings,
  decodeSettings,
  loadSaves,
  putSave,
  deleteSave,
  type SimSettings,
  type BaseUnit,
} from "./settings";

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

const SAMPLE = `# Compare two ways to chase a tier-1/2 physical-damage prefix.
# Start Rare with an alchemy, then fill the open prefixes.
# Each 'option' is simulated on its own and the success condition
# is the one on 'compare' — hit "Simulate" to see them side by side.

alchemy
compare has prefix "physical damage" tier <= 2 {
  option "exalt fill" {
    while open prefix {
      exalt
    }
  }
  option "perfect exalt" {
    while open prefix {
      perfect exalt
    }
  }
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

const AMULET_SAMPLE = `# Amulet: chase all-resistances + spirit
alchemy
while not has "all elemental resistances" {
  chaos
}
if open prefix {
  exalt
}
`;

const RING_SAMPLE = `# Ring: chase all-resistances + life
alchemy
while not has "all elemental resistances" {
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
  amulet: { sample: AMULET_SAMPLE, target: 'has "all elemental resistances"', base: "Stellar Amulet" },
  ring: { sample: RING_SAMPLE, target: 'has "all elemental resistances"', base: "Prismatic Ring" },
};

const classBases = (key: string) => ITEM_CLASSES.find((c) => c.key === key)!.bases;

export default function App() {
  const [classKey, setClassKey] = useState("bow");
  const bases = classBases(classKey);
  const [baseName, setBaseName] = useState(
    bases.find((b) => b.name === CLASS_DEFAULTS.bow.base)?.name ?? bases[0].name
  );
  const [ilvl, setIlvl] = useState(82);
  const [startRarity, setStartRarity] = useState<Rarity>("Normal");
  const [startMods, setStartMods] = useState("");
  const [seed, setSeed] = useState(12345);
  const [script, setScript] = useState(SAMPLE);
  const [target, setTarget] = useState('has prefix "increased physical damage"');
  const [batchRuns, setBatchRuns] = useState(2000);
  const [stopMode, setStopMode] = useState<"none" | "steps" | "cost">("none");
  const [stopValue, setStopValue] = useState(20);

  const [result, setResult] = useState<RunResult | null>(null);
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [comparison, setComparison] = useState<ComparisonGroup[] | null>(null);
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

  /** Build the configured starting item (rarity + pre-applied mods). */
  function makeStart(rngSeed: number) {
    return buildStartItem(base, ilvl, startRarity, startMods.split("\n"), new RNG(rngSeed ^ 0x5eed));
  }
  // preview/validation of the start config (errors are seed-independent)
  const startBuild = useMemo(
    () => makeStart(seed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, ilvl, startRarity, startMods, seed]
  );

  function changeClass(key: string) {
    setItemClass(key); // engine reads from this class now
    setClassKey(key);
    const d = CLASS_DEFAULTS[key];
    const cb = classBases(key);
    setBaseName((d?.base && cb.find((b) => b.name === d.base)?.name) ?? cb[0].name);
    setScript(d?.sample ?? "");
    setTarget(d?.target ?? "");
    setStartRarity("Normal");
    setStartMods("");
    setResult(null);
    setBatch(null);
    setComparison(null);
    setError(null);
  }

  // ---- save / load whole-sim settings ----
  const currentSettings: SimSettings = useMemo(
    () => ({
      v: SETTINGS_VERSION,
      classKey,
      baseName,
      ilvl,
      startRarity,
      startMods,
      script,
      target,
      seed,
      batchRuns,
      stopMode,
      stopValue,
      baseAmount,
      baseUnit,
    }),
    [
      classKey, baseName, ilvl, startRarity, startMods, script, target, seed,
      batchRuns, stopMode, stopValue, baseAmount, baseUnit,
    ]
  );
  const shareCode = useMemo(() => encodeSettings(currentSettings), [currentSettings]);
  const [importText, setImportText] = useState("");
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  // named browser-local saves
  const [saves, setSaves] = useState<Record<string, SimSettings>>(loadSaves);
  const [saveName, setSaveName] = useState("");

  function doSaveNamed() {
    const name = saveName.trim();
    if (!name) return;
    const existed = name in saves;
    setSaves(putSave(name, currentSettings));
    setSaveName("");
    setShareMsg(existed ? `Updated "${name}".` : `Saved "${name}".`);
  }
  function doLoadNamed(name: string) {
    const s = saves[name];
    if (!s) return;
    applySettings(s);
    setShareMsg(`Loaded "${name}".`);
  }
  function doDeleteNamed(name: string) {
    setSaves(deleteSave(name));
    setShareMsg(`Deleted "${name}".`);
  }

  function applySettings(s: SimSettings) {
    setItemClass(s.classKey); // engine binds to this class
    setClassKey(s.classKey);
    setBaseName(s.baseName);
    setIlvl(s.ilvl);
    setStartRarity(s.startRarity);
    setStartMods(s.startMods);
    setScript(s.script);
    setTarget(s.target);
    setSeed(s.seed);
    setBatchRuns(s.batchRuns);
    setStopMode(s.stopMode);
    setStopValue(s.stopValue);
    setBaseAmountState(s.baseAmount);
    setBaseUnitState(s.baseUnit);
    try {
      localStorage.setItem(BASE_AMOUNT_KEY, String(s.baseAmount));
      localStorage.setItem(BASE_UNIT_KEY, s.baseUnit);
    } catch {
      /* ignore */
    }
    setResult(null);
    setBatch(null);
    setComparison(null);
    setError(null);
  }

  function doImport() {
    try {
      applySettings(decodeSettings(importText));
      setImportText("");
      setShareMsg("Loaded settings.");
    } catch (e) {
      setShareMsg("Invalid code: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function copyShareCode() {
    try {
      await navigator.clipboard.writeText(shareCode);
      setShareMsg("Copied to clipboard.");
    } catch {
      setShareMsg("Copy failed — select the text manually.");
    }
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
    setComparison(null);
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
        const item = makeStart(runSeed).item;
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
    const opts = { ...limitOpts(), startItem: makeStart(seed).item };
    const control = { cancelled: () => cancelRef.current, onProgress: setProgress };
    const hasCompare = extractComparisons(compiled.program).length > 0;
    try {
      if (hasCompare) {
        // each `compare` block produces a side-by-side group of option results
        const groups = await runComparisonsAsync(
          compiled.program, base, ilvl, batchRuns, seed, opts, control
        );
        if (groups) {
          setComparison(groups);
          setBatch(null);
        }
      } else {
        const res = await runBatchAsync(
          compiled.program, base, ilvl, batchRuns, seed,
          { target: compiled.targetCond, ...opts }, control
        );
        if (res) {
          setBatch(res); // null => cancelled, keep previous
          setComparison(null);
        }
      }
    } catch (e) {
      setBatch(null);
      setComparison(null);
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

      <div className="panel">
        <h2>Save / Load Sim</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          A save captures the full setup (class, base, item level, starting item,
          script, target, seed, runs, stop limit, base price). Saved sims are stored
          in this browser.
        </p>
        <input
          type="text"
          value={saveName}
          placeholder="name this sim…"
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSaveNamed()}
          style={{ width: "100%", maxWidth: 320 }}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={doSaveNamed} disabled={!saveName.trim()}>
            {saveName.trim() && saveName.trim() in saves ? "Update" : "Save"}
          </button>
        </div>
        {Object.keys(saves).length === 0 ? (
          <div className="muted" style={{ marginTop: 4 }}>
            No saved sims yet.
          </div>
        ) : (
          <table className="saves" style={{ marginTop: 6, maxWidth: 420, width: "100%" }}>
            <tbody>
              {Object.keys(saves)
                .sort((a, b) => a.localeCompare(b))
                .map((name) => (
                  <tr key={name}>
                    <td style={{ width: "100%", wordBreak: "break-word" }}>{name}</td>
                    <td>
                      <button
                        className="secondary"
                        style={{ padding: "4px 10px" }}
                        onClick={() => doLoadNamed(name)}
                      >
                        Load
                      </button>
                    </td>
                    <td>
                      <button
                        className="secondary"
                        style={{ padding: "4px 10px" }}
                        title={`Delete "${name}"`}
                        onClick={() => doDeleteNamed(name)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}

        <details style={{ marginTop: 10 }}>
          <summary>Share / import as a code</summary>
          <label style={{ marginTop: 8 }}>
            Sim code
            <textarea
              readOnly
              value={shareCode}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              style={{ minHeight: 56, fontSize: 11 }}
            />
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={copyShareCode}>
              Copy code
            </button>
          </div>
          <label style={{ marginTop: 8 }}>
            Load a sim code
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
              placeholder="paste a sim code here"
              style={{ minHeight: 56, fontSize: 11 }}
            />
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={doImport} disabled={!importText.trim()}>
              Load
            </button>
          </div>
        </details>
        {shareMsg && (
          <div className="muted" style={{ marginTop: 8 }}>
            {shareMsg}
          </div>
        )}
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
            <div className="row">
              <label>
                Starting rarity
                <select
                  value={startRarity}
                  onChange={(e) => setStartRarity(e.target.value as Rarity)}
                >
                  <option value="Normal">Normal (blank)</option>
                  <option value="Magic">Magic</option>
                  <option value="Rare">Rare</option>
                </select>
              </label>
              <label style={{ flex: 1, minWidth: 220 }}>
                Starting modifiers (one per line, e.g. <code>Movement Speed</code>,{" "}
                <code>All Attributes t2</code>, or <code>fractured Movement Speed</code>)
                <textarea
                  value={startMods}
                  onChange={(e) => setStartMods(e.target.value)}
                  spellCheck={false}
                  disabled={startRarity === "Normal"}
                  style={{ minHeight: 60, opacity: startRarity === "Normal" ? 0.5 : 1 }}
                  placeholder={startRarity === "Normal" ? "(choose Magic or Rare to add mods)" : ""}
                />
              </label>
            </div>
            {startBuild.errors.length > 0 && (
              <div className="error">{startBuild.errors.join("\n")}</div>
            )}
          </div>

          <div className="panel">
            <h2>Crafting Script</h2>
            <ScriptEditor value={script} onChange={setScript} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="secondary" onClick={() => setScript(formatScript(script))}>
                Format
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>Run</h2>
            <div className="row">
              <label style={{ flex: 1, minWidth: 220 }}>
                Target condition (success metric)
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  spellCheck={false}
                />
              </label>
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
              <button onClick={() => doRun(false)} disabled={busy}>
                {busy && !simulating && <span className="spinner" />}
                Run with seed
              </button>
              <input
                type="number"
                value={seed}
                title="Seed"
                style={{ width: 110 }}
                onChange={(e) => setSeed(Number(e.target.value))}
              />
            </div>
            <div className="row">
              <button className="secondary" onClick={() => doRun(true)} disabled={busy}>
                Run with random seed
              </button>
            </div>
            <div className="row">
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
              <input
                type="number"
                value={batchRuns}
                min={1}
                max={200000}
                title="Number of runs"
                style={{ width: 90 }}
                onChange={(e) => setBatchRuns(Number(e.target.value))}
              />
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
            {error && <div className="error">{error}</div>}
          </div>

          <div className="panel">
            <h2>Results</h2>
            <div className="muted" style={{ marginBottom: 6 }}>Result item</div>
            <ItemCard item={result ? result.item : startBuild.item} />
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

            {batch && (
              <div style={{ marginTop: 14 }}>
                <div className="muted" style={{ marginBottom: 6 }}>Monte Carlo</div>
                <BatchView batch={batch} prices={prices} basePrice={basePrice} />
              </div>
            )}
            {comparison && (
              <div style={{ marginTop: 14 }}>
                <div className="muted" style={{ marginBottom: 6 }}>Approach comparison</div>
                <ComparisonView groups={comparison} prices={prices} basePrice={basePrice} />
              </div>
            )}

            {result && (
              <details style={{ marginTop: 14 }}>
                <summary>Step log ({result.totalSpent})</summary>
                <div className="log" style={{ marginTop: 6 }}>
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
              </details>
            )}
          </div>

        </div>

        <div>
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

/** Textarea with a syntax-highlight overlay + auto-indent for the crafting DSL. */
function ScriptEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const sync = () => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  const replace = (next: string, caret: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.selectionStart = ta.selectionEnd = caret;
        sync();
      }
    });
  };
  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    if (e.key === "Tab") {
      e.preventDefault();
      replace(value.slice(0, s) + "  " + value.slice(en), s + 2);
    } else if (e.key === "Enter") {
      // keep the current line's indent, and add one level after an opening brace
      e.preventDefault();
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const before = value.slice(lineStart, s);
      const indent = (before.match(/^[ \t]*/) || [""])[0];
      const extra = /\{\s*$/.test(before) ? "  " : "";
      const ins = "\n" + indent + extra;
      replace(value.slice(0, s) + ins + value.slice(en), s + ins.length);
    }
  }
  return (
    <div className="editor">
      <pre
        ref={preRef}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlightScript(value) + "\n" }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        onKeyDown={handleKey}
        spellCheck={false}
      />
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
            <td>{CURRENCY[k]?.label ?? OMENS[k]?.label ?? k}</td>
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

function ComparisonView({
  groups,
  prices,
  basePrice,
}: {
  groups: ComparisonGroup[];
  prices: Record<string, number>;
  basePrice: number;
}) {
  type Opt = ComparisonGroup["options"][number];
  // each row: a labelled metric, how to read it, and which direction is better
  const rows: {
    label: string;
    value: (o: Opt) => number;
    fmt: (o: Opt) => string;
    better: "high" | "low";
  }[] = [
    {
      label: "Success",
      value: (o) => o.result.successRate,
      fmt: (o) => `${(o.result.successRate * 100).toFixed(1)}%`,
      better: "high",
    },
    {
      label: "Avg cost",
      value: (o) => o.result.cost.avg + basePrice,
      fmt: (o) => unitCost(o.result.cost.avg + basePrice, prices),
      better: "low",
    },
    {
      label: "p95 cost",
      value: (o) => o.result.cost.p95 + basePrice,
      fmt: (o) => unitCost(o.result.cost.p95 + basePrice, prices),
      better: "low",
    },
    {
      label: "Cost / success",
      value: (o) =>
        o.result.successRate > 0
          ? (o.result.cost.avg + basePrice) / o.result.successRate
          : Infinity,
      fmt: (o) =>
        o.result.successRate > 0
          ? unitCost((o.result.cost.avg + basePrice) / o.result.successRate, prices)
          : "—",
      better: "low",
    },
    {
      label: "Avg attempts",
      value: (o) => o.result.totalCount.avg,
      fmt: (o) => fmtCount(o.result.totalCount.avg),
      better: "low",
    },
  ];

  return (
    <div style={{ marginTop: 14 }}>
      {groups.map((g, gi) => {
        // overall best: lowest cost per success (no successes => worst)
        const costPerSuccess = (o: ComparisonGroup["options"][number]) =>
          o.result.successRate > 0
            ? (o.result.cost.avg + basePrice) / o.result.successRate
            : Infinity;
        let bestIdx = 0;
        g.options.forEach((o, i) => {
          if (costPerSuccess(o) < costPerSuccess(g.options[bestIdx])) bestIdx = i;
        });
        // best option index per row (for highlighting)
        const bestForRow = rows.map((r) => {
          let bi = 0;
          g.options.forEach((o, i) => {
            const cmp = r.better === "high" ? r.value(o) > r.value(g.options[bi]) : r.value(o) < r.value(g.options[bi]);
            if (cmp) bi = i;
          });
          return bi;
        });
        return (
          <div key={gi} style={{ marginBottom: 20 }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              Comparing approaches for <code>{g.condText}</code> ({g.options[0].result.runs}×)
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="metrics" style={{ minWidth: "min-content" }}>
                <tbody>
                  <tr className="mc-head">
                    <td style={{ minWidth: 90 }} />
                    {g.options.map((o, oi) => (
                      <td
                        key={oi}
                        style={{ textAlign: "right", color: "var(--accent)", minWidth: 90 }}
                      >
                        {oi === bestIdx ? "★ " : ""}
                        {o.name}
                      </td>
                    ))}
                  </tr>
                  {rows.map((r, ri) => (
                    <tr className="mc-row" key={ri}>
                      <td className="muted">{r.label}</td>
                      {g.options.map((o, oi) => (
                        <td
                          key={oi}
                          className={oi === bestForRow[ri] ? "good" : ""}
                          style={{ textAlign: "right" }}
                        >
                          {r.fmt(o)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              style={{
                display: "grid",
                // each card keeps a readable minimum; if the container is too
                // narrow to fit them, the row scrolls horizontally instead of
                // squashing the cards (and their tables) too small to read
                gridTemplateColumns: `repeat(${g.options.length}, minmax(340px, 1fr))`,
                gap: 14,
                marginTop: 12,
                alignItems: "flex-start",
                overflowX: "auto",
              }}
            >
              {g.options.map((o, oi) => (
                <div
                  key={oi}
                  style={{
                    border: `1px solid ${oi === bestIdx ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: 8,
                    padding: 10,
                  }}
                >
                  <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 6 }}>
                    {oi === bestIdx ? "★ " : ""}
                    {o.name}
                  </div>
                  <BatchView batch={o.result} prices={prices} basePrice={basePrice} compact />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BatchView({
  batch,
  prices,
  basePrice,
  compact = false,
}: {
  batch: BatchResult;
  prices: Record<string, number>;
  basePrice: number;
  compact?: boolean;
}) {
  const entries = Object.entries(batch.avgSpent).sort((a, b) => b[1] - a[1]);
  // compact mode (used in side-by-side comparison cards) shows only the Avg column
  const metrics = (compact ? ["avg"] : ["avg", "min", "p95", "max"]) as readonly (
    | "avg"
    | "min"
    | "p95"
    | "max"
  )[];
  const fullSpan = metrics.length * 2;
  // two right-aligned cells per metric: cost (value), then the count in parens
  const divider = { borderLeft: "1px solid var(--border)", paddingLeft: 8 } as const;
  const cells = (count: number, ex: number, cls: string, key: string) => [
    <td key={key + "c"} className={cls} style={{ textAlign: "right", paddingRight: 4, ...divider }}>
      {unitCost(ex, prices)}
    </td>,
    <td
      key={key + "n"}
      className={cls}
      style={{ textAlign: "right", paddingRight: 10, color: "var(--muted)" }}
    >
      ({fmtCount(count)}×)
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
            <td colSpan={fullSpan}>{batch.runs}</td>
          </tr>
          <tr>
            <td className="good">{compact ? "Success" : "Success rate (target met)"}</td>
            <td className="good" colSpan={fullSpan}>
              {(batch.successRate * 100).toFixed(1)}%
            </td>
          </tr>
          {batch.budgetExceededRate > 0 && (
            <tr>
              <td className="bad">Hit op budget</td>
              <td className="bad" colSpan={fullSpan}>
                {(batch.budgetExceededRate * 100).toFixed(1)}%
              </td>
            </tr>
          )}
          {batch.limitReachedRate > 0 && (
            <tr>
              <td>Hit stop limit</td>
              <td colSpan={fullSpan}>{(batch.limitReachedRate * 100).toFixed(1)}%</td>
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
            currencyRow(CURRENCY[k]?.label ?? OMENS[k]?.label ?? k, batch.perCurrency[k] ?? flat(0), prices[k] ?? 0)
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
              {fullSpan > 2 && <td colSpan={fullSpan - 2} style={divider}></td>}
            </tr>
          )}
        </tbody>
      </table>
      <CostHistogram hist={batch.costHistogram} basePrice={basePrice} />
      {!compact && batch.checkpoints.length > 0 && (
        <CheckpointBreakdown checkpoints={batch.checkpoints} prices={prices} />
      )}
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

function CheckpointBreakdown({
  checkpoints,
  prices,
}: {
  checkpoints: {
    label: string;
    avgCostEx: number;
    avgSteps: number;
    reachedFrac: number;
    reachedCostEx: number;
    reachedSteps: number;
  }[];
  prices: Record<string, number>;
}) {
  // "conditional" = average cost among attempts that REACHED the stage (not diluted
  // by attempts that stopped earlier); "per attempt" = averaged over all attempts.
  const [conditional, setConditional] = useState(true);
  const val = (c: (typeof checkpoints)[number]) => (conditional ? c.reachedCostEx : c.avgCostEx);
  const stepVal = (c: (typeof checkpoints)[number]) => (conditional ? c.reachedSteps : c.avgSteps);
  const total = checkpoints.reduce((s, c) => s + val(c), 0);
  const peak = Math.max(1e-9, ...checkpoints.map(val));
  const maxIdx = checkpoints.reduce((m, c, i) => (val(c) > val(checkpoints[m]) ? i : m), 0);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="muted" style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "center" }}>
        <span>
          Cost by stage ({conditional ? "avg among attempts that reached the stage" : "avg per attempt"},
          between <code>checkpoint</code>s):
        </span>
        <button className="secondary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setConditional((v) => !v)}>
          {conditional ? "show per-attempt" : "show per-reached"}
        </button>
      </div>
      <table className="metrics" style={{ width: "100%" }}>
        <tbody>
          {checkpoints.map((c, i) => {
            const pct = total > 0 ? (val(c) / total) * 100 : 0;
            const hot = i === maxIdx && total > 0;
            return (
              <tr key={c.label + i} className="mc-row">
                <td style={{ maxWidth: 220, color: hot ? "var(--bad)" : undefined }}>{c.label}</td>
                <td style={{ width: "40%" }}>
                  <div
                    style={{
                      height: 10,
                      width: `${Math.max(2, (val(c) / peak) * 100)}%`,
                      background: hot ? "var(--bad)" : "var(--accent)",
                      borderRadius: 3,
                    }}
                  />
                </td>
                <td style={{ textAlign: "right", paddingRight: 8 }} className={hot ? "bad" : ""}>
                  {unitCost(val(c), prices)}
                </td>
                <td style={{ textAlign: "right", color: "var(--muted)", paddingRight: 8 }}>
                  {pct.toFixed(0)}%
                </td>
                <td style={{ textAlign: "right", color: "var(--muted)", paddingRight: 8 }}>
                  {fmtCount(stepVal(c))} ops
                </td>
                <td style={{ textAlign: "right", color: "var(--muted)" }}>
                  {(c.reachedFrac * 100).toFixed(0)}% reach
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
        <code>chaos with "whittling"</code>. Combine compatible omens with{" "}
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
                    {(Array.isArray(o.currency) ? o.currency.join("/") : o.currency)} with "{o.key}"
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
          <code>chaos with "whittling"</code> (remove the lowest mod). See the Omens panel.
        </p>
        <p>
          <b>Catalysts</b> (rings &amp; amulets only): <code>catalyst "attribute"</code> adds
          quality (5% per use, caps at 20%) that boosts the values of modifiers carrying that
          tag. Types: attribute, resistance, elemental, physical, caster, attack, life, mana,
          defence, critical, chaos, speed. Using a different type retypes the quality.{" "}
          <code>catalyst "resistance" with "catalysing"</code> applies the full 20% at once.
        </p>
        <p>
          <b>Reveal pick:</b> add <code>pick &lt;cond&gt;</code> to a <code>reveal</code> to
          choose the offered desecration option matching a condition instead of taking one
          at random — e.g. <code>reveal pick has "movement speed"</code> or{" "}
          <code>reveal pick has prefix "evasion" tier &lt;= 2</code>. If no offered option
          matches, it falls back to a random pick.
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
            <tr>
              <td>
                <code>checkpoint "label"</code>
              </td>
              <td>
                mark the end of a stage; a Monte-Carlo run reports the average cost spent in each
                stage (between checkpoints) so you can see which step is most expensive
              </td>
            </tr>
            <tr>
              <td>
                <code>
                  compare &lt;cond&gt; {"{"} option "a" {"{ }"} option "b" {"{ }"} {"}"}
                </code>
              </td>
              <td>
                Monte-Carlo only: runs a separate simulation for each labelled{" "}
                <code>option</code> toward the shared success condition and shows them side by
                side (★ marks the highest success rate). Shared steps outside the block apply
                to every option. A single Run uses the first option.
              </td>
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
                <code>has 2 suffix "resistance" tier == 1</code>,{" "}
                <code>has &gt;= 2 prefix</code>
              </td>
              <td>
                count <em>matching</em> affixes — a leading number (or{" "}
                <code>&lt;op&gt; N</code>) requires that many matches (bare number = at
                least N)
              </td>
            </tr>
            <tr>
              <td>
                <code>prefixes &gt;= N</code>, <code>suffixes &lt; N</code>,{" "}
                <code>affixes == N</code>
              </td>
              <td>count comparisons (all affixes in a slot)</td>
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
