import { tokenize, type Token } from "./lexer";
import { CURRENCY_NAMES, type Cond, type CmpOp, type Stmt, type CompareOption } from "./ast";
import { baseCurrency, resolveOmen } from "../engine/item";

export class ParseError extends Error {
  constructor(msg: string, public line: number) {
    super(`Line ${line}: ${msg}`);
  }
}

const CMP_OPS: CmpOp[] = [">=", "<=", "==", "!=", ">", "<"];

class Parser {
  private t: Token[];
  private i = 0;
  constructor(src: string) {
    this.t = tokenize(src);
  }

  private peek(): Token {
    return this.t[this.i];
  }
  private next(): Token {
    return this.t[this.i++];
  }
  private at(type: string, value?: string): boolean {
    const tk = this.peek();
    return tk.type === type && (value === undefined || tk.value === value);
  }
  private eatWord(w: string): boolean {
    if (this.at("word", w)) {
      this.next();
      return true;
    }
    return false;
  }
  private expect(type: string, value?: string): Token {
    if (!this.at(type, value)) {
      const tk = this.peek();
      throw new ParseError(
        `expected ${value ?? type} but found '${tk.value || tk.type}'`,
        tk.line
      );
    }
    return this.next();
  }

  parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.at("eof")) {
      stmts.push(this.parseStmt());
    }
    return stmts;
  }

  parseConditionOnly(): Cond {
    const c = this.parseCond();
    this.expect("eof");
    return c;
  }

  private parseBlock(): Stmt[] {
    this.expect("lbrace");
    const stmts: Stmt[] = [];
    while (!this.at("rbrace") && !this.at("eof")) {
      stmts.push(this.parseStmt());
    }
    this.expect("rbrace");
    return stmts;
  }

  private parseStmt(): Stmt {
    const tk = this.peek();
    if (tk.type !== "word") {
      throw new ParseError(`expected a command but found '${tk.value || tk.type}'`, tk.line);
    }
    const line = tk.line;
    const w = tk.value;

    if (w === "repeat") {
      this.next();
      const n = this.expect("number");
      const count = Math.floor(parseFloat(n.value));
      const body = this.parseBlock();
      return { kind: "repeat", count, body, line };
    }
    if (w === "while" || w === "until") {
      this.next();
      const cond = this.parseCond();
      const body = this.parseBlock();
      return { kind: w, cond, body, line } as Stmt;
    }
    if (w === "if") {
      this.next();
      const cond = this.parseCond();
      const then = this.parseBlock();
      let elseBody: Stmt[] = [];
      if (this.eatWord("else")) {
        if (this.at("word", "if")) {
          elseBody = [this.parseStmt()];
        } else {
          elseBody = this.parseBlock();
        }
      }
      return { kind: "if", cond, then, else: elseBody, line };
    }
    if (w === "compare") {
      this.next();
      const cond = this.parseCond();
      this.expect("lbrace");
      const options: CompareOption[] = [];
      while (this.at("word", "option")) {
        const optLine = this.peek().line;
        this.next(); // 'option'
        const name = this.expect("string").value;
        const body = this.parseBlock();
        options.push({ name, body, line: optLine });
      }
      if (options.length < 2) {
        throw new ParseError("a compare block needs at least two `option` arms", line);
      }
      this.expect("rbrace");
      return { kind: "compare", cond, options, line };
    }
    if (w === "stop") {
      this.next();
      return { kind: "stop", line };
    }
    if (w === "checkpoint" || w === "mark") {
      this.next();
      const label = this.expect("string").value;
      return { kind: "checkpoint", label, line };
    }
    // tiered orbs: `greater exalt`, `perfect chaos`
    if (w === "greater" || w === "perfect") {
      this.next();
      const baseTok = this.peek();
      if (baseTok.type !== "word") {
        throw new ParseError(`expected an orb name after '${w}'`, line);
      }
      const base = baseTok.value;
      const key = w + base[0].toUpperCase() + base.slice(1);
      if (!CURRENCY_NAMES.includes(key)) {
        throw new ParseError(`'${w} ${base}' is not a valid tiered orb`, line);
      }
      this.next();
      this.eatWord("orb");
      const omens = this.parseOmens(key, line);
      const pick = this.parsePick(key, line);
      return { kind: "currency", name: key, omens, pick, line };
    }

    // otherwise: a currency command
    if (CURRENCY_NAMES.includes(w)) {
      this.next();
      // optional string argument, e.g. essence "greater abrasion"
      let arg: string | undefined;
      if (this.at("string")) arg = this.next().value;
      // allow an optional "orb" word for readability: `chaos orb`
      this.eatWord("orb");
      const omens = this.parseOmens(w, line);
      const pick = this.parsePick(w, line);
      return { kind: "currency", name: w, arg, omens, pick, line };
    }
    throw new ParseError(`unknown command '${w}'`, line);
  }

  /** Parse optional `with "<omen>"[, "<omen>"][ with "<omen>"]` clauses. */
  private parseOmens(currencyKey: string, line: number): string[] | undefined {
    const keys: string[] = [];
    const readOne = () => {
      const raw = this.expect("string").value;
      const omen = resolveOmen(baseCurrency(currencyKey), raw);
      if (!omen) {
        throw new ParseError(`no omen matching "${raw}" applies to '${currencyKey}'`, line);
      }
      if (!keys.includes(omen.key)) keys.push(omen.key);
    };
    while (this.eatWord("with")) {
      readOne();
      while (this.eatWord("and")) readOne();
    }
    return keys.length ? keys : undefined;
  }

  /** Parse optional `pick <cond>` clause (only valid on `reveal`). */
  private parsePick(currencyKey: string, line: number): Cond | undefined {
    if (!this.eatWord("pick")) return undefined;
    if (baseCurrency(currencyKey) !== "reveal") {
      throw new ParseError(`'pick' only applies to 'reveal', not '${currencyKey}'`, line);
    }
    return this.parseCond();
  }

  // ---- conditions (precedence: or < and < not < primary) ----
  private parseCond(): Cond {
    return this.parseOr();
  }
  private parseOr(): Cond {
    let left = this.parseAnd();
    while (this.eatWord("or")) {
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }
  private parseAnd(): Cond {
    let left = this.parseNot();
    while (this.eatWord("and")) {
      const right = this.parseNot();
      left = { kind: "and", left, right };
    }
    return left;
  }
  private parseNot(): Cond {
    if (this.eatWord("not")) {
      return { kind: "not", inner: this.parseNot() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Cond {
    if (this.at("lparen")) {
      this.next();
      const c = this.parseCond();
      this.expect("rparen");
      return c;
    }
    const tk = this.peek();
    const line = tk.line;
    if (tk.type !== "word") {
      throw new ParseError(`expected a condition but found '${tk.value || tk.type}'`, line);
    }
    const w = tk.value;

    if (w === "has") {
      this.next();
      // optional count qualifier: `has 2 ...` (>= 2) or `has >= 2 ...` / `has == 2 ...`
      let count: { op: CmpOp; value: number } | undefined;
      if (this.at("op") || this.at("number")) {
        const op = this.at("op") ? this.parseCmp() : ">=";
        const n = this.expect("number");
        count = { op, value: parseFloat(n.value) };
      }
      let slot: "prefix" | "suffix" | "any" = "any";
      if (this.eatWord("prefix")) slot = "prefix";
      else if (this.eatWord("suffix")) slot = "suffix";
      let text = "";
      let group: string | undefined;
      if (this.eatWord("group")) {
        group = this.expect("string").value.toLowerCase();
      } else if (this.at("string")) {
        text = this.next().value.toLowerCase();
      }
      let tier: { op: CmpOp; value: number } | undefined;
      if (this.eatWord("tier")) {
        const op = this.parseCmp();
        const n = this.expect("number");
        tier = { op, value: parseFloat(n.value) };
      }
      const fractured = this.eatWord("fractured") || undefined;
      const hasMatcher = text || group || tier || fractured || slot !== "any";
      if (!hasMatcher) {
        throw new ParseError(
          '`has` needs a slot, "text", `group "..."`, a tier comparison, or `fractured`',
          line
        );
      }
      return { kind: "has", slot, text, group, tier, fractured, count };
    }
    if (w === "open") {
      this.next();
      if (this.eatWord("prefix")) return { kind: "open", slot: "prefix" };
      if (this.eatWord("suffix")) return { kind: "open", slot: "suffix" };
      throw new ParseError("expected 'prefix' or 'suffix' after 'open'", line);
    }
    if (w === "prefixes" || w === "suffixes" || w === "affixes") {
      this.next();
      const op = this.parseCmp();
      const n = this.expect("number");
      return { kind: "count", what: w, op, value: parseFloat(n.value) };
    }
    if (w === "rarity") {
      this.next();
      this.eatWord("is");
      const v = this.expect("word").value;
      if (v !== "normal" && v !== "magic" && v !== "rare") {
        throw new ParseError(`unknown rarity '${v}'`, line);
      }
      return { kind: "rarity", value: v };
    }
    if (w === "corrupted") {
      this.next();
      return { kind: "corrupted" };
    }
    if (w === "fractured") {
      this.next();
      return { kind: "fractured" };
    }
    if (w === "desecrated") {
      this.next();
      return { kind: "desecrated" };
    }
    if (w === "crafted") {
      this.next();
      return { kind: "crafted" };
    }
    if (w === "unrevealed") {
      this.next();
      return { kind: "unrevealed" };
    }
    if (w === "full") {
      this.next();
      return { kind: "full" };
    }
    // A statement keyword / currency here means the previous condition was left
    // dangling (missing `{ }`, or a trailing and/or/not).
    const STMT_WORDS = ["while", "until", "if", "else", "repeat", "stop", "with"];
    if (STMT_WORDS.includes(w) || CURRENCY_NAMES.includes(w)) {
      throw new ParseError(
        `expected a condition but found '${w}' — check for a missing '{ }' or a dangling and/or/not`,
        line
      );
    }
    throw new ParseError(`unknown condition '${w}'`, line);
  }
  private parseCmp(): CmpOp {
    const tk = this.peek();
    if (tk.type === "op" && CMP_OPS.includes(tk.value as CmpOp)) {
      this.next();
      return tk.value as CmpOp;
    }
    throw new ParseError(`expected a comparison operator but found '${tk.value || tk.type}'`, tk.line);
  }
}

export function parse(src: string): Stmt[] {
  return new Parser(src).parseProgram();
}

export function parseCondition(src: string): Cond {
  return new Parser(src).parseConditionOnly();
}
