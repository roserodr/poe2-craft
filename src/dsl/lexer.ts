export type TokenType =
  | "word"
  | "number"
  | "string"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "op"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
  line: number;
}

export class LexError extends Error {
  constructor(msg: string, public line: number) {
    super(`Line ${line}: ${msg}`);
  }
}

const OPS = [">=", "<=", "==", "!=", ">", "<"];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const push = (type: TokenType, value: string, pos: number) =>
    tokens.push({ type, value, pos, line });

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // comments: # ... or // ...
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "{") {
      push("lbrace", c, i);
      i++;
      continue;
    }
    if (c === "}") {
      push("rbrace", c, i);
      i++;
      continue;
    }
    if (c === "(") {
      push("lparen", c, i);
      i++;
      continue;
    }
    if (c === ")") {
      push("rparen", c, i);
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let str = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\n") throw new LexError("unterminated string", line);
        str += src[i++];
      }
      if (i >= src.length) throw new LexError("unterminated string", line);
      i++; // closing quote
      push("string", str, start);
      continue;
    }
    const two = src.slice(i, i + 2);
    const opMatch = OPS.find((o) => (o.length === 2 ? two === o : src[i] === o));
    if (opMatch) {
      push("op", opMatch, i);
      i += opMatch.length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      push("number", src.slice(start, i), start);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      push("word", src.slice(start, i).toLowerCase(), start);
      continue;
    }
    throw new LexError(`unexpected character '${c}'`, line);
  }
  push("eof", "", i);
  return tokens;
}
