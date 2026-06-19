// Shareable sim settings: the full setup encoded as a base64 JSON string.
import type { Rarity } from "./engine/types";
import { ITEM_CLASSES } from "./engine/mods";

export type BaseUnit = "ex" | "chaos" | "div";

export const SETTINGS_VERSION = 1;

export interface SimSettings {
  v: number;
  classKey: string;
  baseName: string;
  ilvl: number;
  startRarity: Rarity;
  startMods: string;
  script: string;
  target: string;
  seed: number;
  batchRuns: number;
  stopMode: "none" | "steps" | "cost";
  stopValue: number;
  baseAmount: number;
  baseUnit: BaseUnit;
}

/** UTF-8-safe base64 encode/decode (works for any unicode in the script). */
function b64encode(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64: string): string {
  const bin = atob(b64.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeSettings(s: SimSettings): string {
  return b64encode(JSON.stringify(s));
}

/** Normalize a partial/untrusted settings object, filling defaults + validating class. */
export function normalizeSettings(obj: Partial<SimSettings>): SimSettings {
  if (!obj || typeof obj !== "object") throw new Error("not a settings object");
  if (!ITEM_CLASSES.some((c) => c.key === obj.classKey)) {
    throw new Error(`unknown item class "${obj.classKey}"`);
  }
  return {
    v: SETTINGS_VERSION,
    classKey: obj.classKey!,
    baseName: String(obj.baseName ?? ""),
    ilvl: Number(obj.ilvl ?? 82),
    startRarity: (obj.startRarity ?? "Normal") as Rarity,
    startMods: String(obj.startMods ?? ""),
    script: String(obj.script ?? ""),
    target: String(obj.target ?? ""),
    seed: Number(obj.seed ?? 0),
    batchRuns: Number(obj.batchRuns ?? 2000),
    stopMode: (obj.stopMode ?? "none") as "none" | "steps" | "cost",
    stopValue: Number(obj.stopValue ?? 20),
    baseAmount: Number(obj.baseAmount ?? 0),
    baseUnit: (obj.baseUnit ?? "ex") as BaseUnit,
  };
}

/** Parse + validate an encoded settings string; throws on malformed input. */
export function decodeSettings(str: string): SimSettings {
  return normalizeSettings(JSON.parse(b64decode(str)) as Partial<SimSettings>);
}

// ---- named saves persisted in the browser (localStorage) ----
const SAVES_KEY = "poe2craft.saves";

/** All named saves currently in the browser, keyed by name. */
export function loadSaves(): Record<string, SimSettings> {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, SimSettings> = {};
    for (const [name, s] of Object.entries(obj)) {
      try {
        out[name] = normalizeSettings(s as Partial<SimSettings>);
      } catch {
        /* skip a corrupt or stale-class entry */
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistSaves(saves: Record<string, SimSettings>) {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(saves));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/** Store (or overwrite) a named save; returns the updated map. */
export function putSave(name: string, settings: SimSettings): Record<string, SimSettings> {
  const saves = loadSaves();
  saves[name] = settings;
  persistSaves(saves);
  return saves;
}

/** Remove a named save; returns the updated map. */
export function deleteSave(name: string): Record<string, SimSettings> {
  const saves = loadSaves();
  delete saves[name];
  persistSaves(saves);
  return saves;
}
