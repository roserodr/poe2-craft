// Lightweight syntax highlighting + auto-formatting for the crafting DSL.
import { CURRENCY_NAMES } from "./ast";

const FLOW = new Set(["while", "until", "repeat", "if", "else", "stop", "compare", "option"]);
const COND = new Set([
  "has", "open", "rarity", "is", "not", "and", "or", "with", "pick", "tier", "group",
  "fractured", "desecrated", "corrupted", "crafted", "unrevealed", "full",
  "prefix", "suffix", "prefixes", "suffixes", "affixes",
]);
// base orb words (the tiered keys are camelCase like "greaterExalt" — skip those,
// scripts spell them "greater exalt"), plus the tier modifiers.
const CURRENCY = new Set([...CURRENCY_NAMES.filter((k) => /^[a-z]+$/.test(k)), "greater", "perfect"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// order matters: comment, string, number, word, whitespace, single other char
const TOKEN_RE = /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\]|\\.)*"?)|(\d+(?:\.\d+)?)|([A-Za-z_]+)|(\s+)|([^\s])/g;

/** Turn DSL source into highlighted HTML (escaped, with token <span>s). */
export function highlightScript(src: string): string {
  let out = "";
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    const [tok, comment, str, num, word] = m;
    if (comment) out += `<span class="tok-comment">${esc(tok)}</span>`;
    else if (str) out += `<span class="tok-string">${esc(tok)}</span>`;
    else if (num) out += `<span class="tok-number">${esc(tok)}</span>`;
    else if (word) {
      if (CURRENCY.has(word)) out += `<span class="tok-currency">${esc(word)}</span>`;
      else if (FLOW.has(word)) out += `<span class="tok-flow">${esc(word)}</span>`;
      else if (COND.has(word)) out += `<span class="tok-cond">${esc(word)}</span>`;
      else out += esc(word);
    } else out += esc(tok); // whitespace or an operator/brace
  }
  return out;
}

/** Re-indent the script by brace depth (2 spaces per level); trims trailing space. */
export function formatScript(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      out.push("");
      continue;
    }
    // a line that opens with `}` closes a block before it prints
    const d = line.startsWith("}") ? Math.max(0, depth - 1) : depth;
    out.push("  ".repeat(d) + line);
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    depth = Math.max(0, depth + open - close);
  }
  return out.join("\n");
}
