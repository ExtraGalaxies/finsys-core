/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Eval-free evaluator for SurveyJS-style `visibleIf` expressions.
 *
 * A tokenizer, a recursive-descent parser and a tree-walking evaluator. It
 * never builds or runs JavaScript source, so a host page needs no
 * `'unsafe-eval'` in its Content-Security-Policy, and an expression can read
 * nothing but the `{field}` values of the data object it is given.
 *
 * It replaces an implementation that rewrote the string into JavaScript and ran
 * it through the `Function` constructor, and it keeps that implementation's
 * semantics for everything a form config is known to use:
 *
 *   - `{field}` reads an OWN property of the data object (missing -> undefined)
 *   - a lone `=` means `==`, which is JavaScript LOOSE equality (`'5' = 5` is
 *     true); `==`, `!=`, `===` and `!==` mean what they mean in JavaScript
 *   - `<  >  <=  >=`, `+ - * / %`, unary `! - +`, `&&`, `||` (both return an
 *     operand, as in JavaScript, and short-circuit) and parentheses
 *   - literals: numbers, 'single' and "double" quoted strings, `true`, `false`,
 *     `null`, `undefined`, and `[array, literals]`
 *   - `{f} anyof [..]`, `{f} allof [..]`, `{f} contains '..'`,
 *     `{f} notcontains '..'`, case-insensitive, each only in that exact shape
 *
 * Anything else is a parse error, and a parse or evaluation error makes the
 * whole expression `false`, exactly as the old `catch` did. That includes
 * words SurveyJS has but the old evaluator never honoured (`and`, `or`, `not`,
 * `empty`, `notempty`, `<>`): they were a JavaScript syntax error and so
 * `false`, and they stay `false`.
 *
 * Deliberately NOT supported, although the old evaluator passed them to
 * JavaScript by accident: property access and method calls (`{a}.length`),
 * `this`, globals, ternaries, `??`, bitwise operators, `typeof`/`in`/
 * `instanceof`, comments, statements after a trailing `;`, regex literals and
 * hex/binary numbers.
 */

type Token =
  | { kind: "num"; value: number; start: number; end: number }
  | { kind: "str"; value: string; quote: "'" | '"'; escapedQuote: boolean; start: number; end: number }
  | { kind: "ref"; value: string; start: number; end: number }
  | { kind: "ident"; value: string; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number }
  | { kind: "eof"; start: number; end: number };

type Node =
  | { t: "lit"; v: unknown }
  | { t: "ref"; key: string }
  | { t: "arr"; items: Node[] }
  | { t: "un"; op: string; a: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "logic"; op: "&&" | "||"; l: Node; r: Node }
  | { t: "anyof"; key: string; items: Node[] }
  | { t: "allof"; key: string; items: Node[] }
  | { t: "contains"; key: string; value: string; negate: boolean };

class ExpressionError extends Error {}

const fail = (message: string): never => {
  throw new ExpressionError(message);
};

const hasOwn = Object.prototype.hasOwnProperty;

// ---------------------------------------------------------------- tokenizer

const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const WORD_CHAR = /[A-Za-z0-9_$]/;
const THREE_CHAR_OPS = new Set(["===", "!=="]);
const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const ONE_CHAR_OPS = new Set(["=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]", ",", ";"]);

function readNumber(src: string, start: number): Token {
  NUMBER.lastIndex = start;
  const m = NUMBER.exec(src);
  if (!m) return fail("bad number");
  const text = m[0];
  const end = start + text.length;
  // `5abc` is a syntax error in JavaScript, not `5` followed by a word.
  if (end < src.length && WORD_CHAR.test(src[end])) return fail("bad number");
  // A leading-zero integer is legacy octal in sloppy JavaScript (`010` is 8),
  // unless it contains an 8 or 9 (`08` is 8, `09` is 9). Kept so a quoted-less
  // employment code such as `{code} == 010` means what it always did. Legacy
  // octal takes no fraction or exponent (`07.5` is a syntax error), whereas the
  // decimal reading does (`08.5` is 8.5).
  const integer = /^\d*/.exec(text)![0];
  const legacyOctal = /^0[0-7]+$/.test(integer);
  if (legacyOctal && text.length > integer.length) return fail("bad number");
  const value = legacyOctal ? parseInt(integer, 8) : Number(text);
  return { kind: "num", value, start, end };
}

function readString(src: string, start: number): Token {
  const quote = src[start] as "'" | '"';
  let out = "";
  let escapedQuote = false;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === quote) return { kind: "str", value: out, quote, escapedQuote, start, end: i + 1 };
    if (ch === "\n" || ch === "\r") return fail("unterminated string");
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = src[i + 1];
    if (esc === undefined) return fail("unterminated string");
    i += 2;
    switch (esc) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0": case "1": case "2": case "3": case "4": case "5": case "6": case "7": {
        // Legacy octal escape: up to three digits when the first is 0-3, up to
        // two when it is 4-7, greedy. `\0` alone is NUL, and `\08` is NUL then
        // "8", because 8 is not an octal digit.
        const max = esc <= "3" ? 3 : 2;
        let digits = esc;
        while (digits.length < max && /[0-7]/.test(src[i] ?? "")) digits += src[i++];
        out += String.fromCharCode(parseInt(digits, 8));
        break;
      }
      case "\r": if (src[i] === "\n") i += 1; break; // line continuation
      case "\n": break; // line continuation
      case "x": {
        const hex = src.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return fail("bad \\x escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        if (src[i] === "{") {
          const close = src.indexOf("}", i);
          const hex = close < 0 ? "" : src.slice(i + 1, close);
          if (!/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return fail("bad \\u escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          i = close + 1;
        } else {
          const hex = src.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      default:
        if (esc === "'") escapedQuote = true;
        out += esc;
    }
  }
  return fail("unterminated string");
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "{") {
      // `{field}`: everything up to the next `}` is the key, trimmed. Not
      // nestable, and `{}` is not a reference.
      const close = src.indexOf("}", i + 1);
      if (close < 0 || close === i + 1) return fail("bad field reference");
      tokens.push({ kind: "ref", value: src.slice(i + 1, close).trim(), start: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(src[i + 1] ?? ""))) {
      const tok = readNumber(src, i);
      tokens.push(tok);
      i = tok.end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const tok = readString(src, i);
      tokens.push(tok);
      i = tok.end;
      continue;
    }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(src);
    if (ident) {
      tokens.push({ kind: "ident", value: ident[0], start: i, end: i + ident[0].length });
      i += ident[0].length;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    // `++` and `--` are JavaScript syntax errors on these operands, not two
    // unary signs.
    if (two === "++" || two === "--") return fail("unsupported operator");
    const op = THREE_CHAR_OPS.has(three) ? three : TWO_CHAR_OPS.has(two) ? two : ONE_CHAR_OPS.has(ch) ? ch : null;
    if (op === null) return fail(`unexpected character ${ch}`);
    tokens.push({ kind: "op", value: op, start: i, end: i + op.length });
    i += op.length;
  }
  tokens.push({ kind: "eof", start: src.length, end: src.length });
  return tokens;
}

// ------------------------------------------------------------------- parser

const LITERAL_WORDS: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    // The old wrapper was `return <expr>;`, so a trailing `;` in a config was
    // harmless. Keep that, and only that: nothing may follow it.
    while (this.isOp(";")) this.next();
    if (this.peek().kind !== "eof") fail("unexpected token");
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t.kind === "op" && ops.includes(t.value);
  }

  private binary(operand: () => Node, ops: string[]): Node {
    let left = operand();
    while (this.isOp(...ops)) {
      const op = (this.next() as { value: string }).value;
      left = { t: "bin", op, l: left, r: operand() };
    }
    return left;
  }

  private or(): Node {
    let left = this.and();
    while (this.isOp("||")) {
      this.next();
      left = { t: "logic", op: "||", l: left, r: this.and() };
    }
    return left;
  }

  private and(): Node {
    let left = this.equality();
    while (this.isOp("&&")) {
      this.next();
      left = { t: "logic", op: "&&", l: left, r: this.equality() };
    }
    return left;
  }

  private equality(): Node {
    return this.binary(() => this.relational(), ["=", "==", "!=", "===", "!=="]);
  }

  private relational(): Node {
    return this.binary(() => this.additive(), ["<", ">", "<=", ">="]);
  }

  private additive(): Node {
    return this.binary(() => this.multiplicative(), ["+", "-"]);
  }

  private multiplicative(): Node {
    return this.binary(() => this.unary(), ["*", "/", "%"]);
  }

  private unary(): Node {
    if (this.isOp("!", "-", "+")) {
      const op = (this.next() as { value: string }).value;
      return { t: "un", op, a: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const tok = this.next();
    switch (tok.kind) {
      case "num":
        return { t: "lit", v: tok.value };
      case "str":
        return { t: "lit", v: tok.value };
      case "ref":
        return this.refOperator(tok);
      case "ident":
        if (hasOwn.call(LITERAL_WORDS, tok.value)) return { t: "lit", v: LITERAL_WORDS[tok.value] };
        return fail(`unknown word ${tok.value}`);
      case "op":
        if (tok.value === "(") {
          const inner = this.or();
          this.expectOp(")");
          return inner;
        }
        if (tok.value === "[") return { t: "arr", items: this.arrayItems() };
        return fail(`unexpected ${tok.value}`);
      default:
        return fail("unexpected end of expression");
    }
  }

  private expectOp(op: string): Token {
    const t = this.next();
    if (t.kind !== "op" || t.value !== op) return fail(`expected ${op}`);
    return t;
  }

  /** Items of an array literal; the opening `[` is already consumed. */
  private arrayItems(): Node[] {
    const items: Node[] = [];
    while (!this.isOp("]")) {
      items.push(this.or());
      if (this.isOp(",")) this.next();
      else if (!this.isOp("]")) fail("expected , or ]");
    }
    this.next();
    return items;
  }

  /**
   * A `{field}`, optionally followed by one of the four SurveyJS array words.
   * The words attach ONLY to a bare `{field}` on the left and, on the right, to
   * an array literal (`anyof`, `allof`) or a non-empty single-quoted string
   * (`contains`, `notcontains`): the shapes the old rewrite recognised.
   * Anything else falls through to a parse error.
   */
  private refOperator(ref: Token & { kind: "ref" }): Node {
    const key = ref.value;
    const t = this.peek();
    if (t.kind !== "ident") return { t: "ref", key };
    const word = t.value.toLowerCase();
    const isArrayWord = word === "anyof" || word === "allof";
    if (!isArrayWord && word !== "contains" && word !== "notcontains") return { t: "ref", key };
    // The old patterns were `\s+word\s+`: whitespace on both sides, so
    // `{a}anyof [..]` and `{a} anyof[..]` were syntax errors.
    if (t.start === ref.end) return fail(`${word} needs whitespace before it`);
    this.next();
    const operand = this.next();
    if (operand.start === t.end) return fail(`${word} needs whitespace after it`);
    if (isArrayWord) {
      if (operand.kind !== "op" || operand.value !== "[") return fail(`${word} needs an array`);
      // The old pattern needed at least one character between the brackets, so
      // `[]` was a syntax error while `[ ]` was an empty array.
      if (this.isOp("]") && this.peek().start === operand.end) return fail(`${word} needs a non-empty array`);
      return { t: word as "anyof" | "allof", key, items: this.arrayItems() };
    }
    // The old pattern was `'([^']+)'`: it stopped at the first quote, so a
    // string holding an escaped quote never matched.
    if (operand.kind !== "str" || operand.quote !== "'" || operand.value === "" || operand.escapedQuote) {
      return fail(`${word} needs a non-empty single-quoted string without an escaped quote`);
    }
    return { t: "contains", key, value: operand.value, negate: word === "notcontains" };
  }
}

// ---------------------------------------------------------------- evaluator

/**
 * `(container || []).includes(item)`: arrays by identity-ish equality
 * (SameValueZero), strings by substring, a missing/falsy container as empty.
 * Any other container (a number, an object) throws, which makes the whole
 * expression `false`, as the old `.includes` call on a non-array did.
 */
function includes(container: unknown, item: unknown): boolean {
  const c = container || [];
  if (Array.isArray(c)) return c.includes(item);
  if (typeof c === "string") return c.includes(item as string);
  throw new TypeError("contains needs an array or a string");
}

function lookup(scope: unknown, key: string): unknown {
  return hasOwn.call(scope as object, key) ? (scope as Record<string, unknown>)[key] : undefined;
}

function run(node: Node, scope: unknown): unknown {
  switch (node.t) {
    case "lit":
      return node.v;
    case "ref":
      return lookup(scope, node.key);
    case "arr":
      return node.items.map((item) => run(item, scope));
    case "un": {
      const a: any = run(node.a, scope);
      return node.op === "!" ? !a : node.op === "-" ? -a : +a;
    }
    case "logic": {
      const l = run(node.l, scope);
      if (node.op === "&&") return l ? run(node.r, scope) : l;
      return l ? l : run(node.r, scope);
    }
    case "bin": {
      const l: any = run(node.l, scope);
      const r: any = run(node.r, scope);
      switch (node.op) {
        // Both `=` and `==` are LOOSE equality, as `{a} = 5` always was.
        case "=":
        case "==": return l == r;
        case "!=": return l != r;
        case "===": return l === r;
        case "!==": return l !== r;
        case "<": return l < r;
        case ">": return l > r;
        case "<=": return l <= r;
        case ">=": return l >= r;
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        default: return l % r;
      }
    }
    case "anyof": {
      const items = node.items.map((item) => run(item, scope));
      return items.includes(lookup(scope, node.key));
    }
    case "allof": {
      const items = node.items.map((item) => run(item, scope));
      return items.every((item) => includes(lookup(scope, node.key), item));
    }
    case "contains": {
      const has = includes(lookup(scope, node.key), node.value);
      return node.negate ? !has : has;
    }
  }
}

/**
 * Parse and evaluate `expression` against `data`. Returns the raw value the
 * expression produces; the caller decides truthiness. Throws on any syntax or
 * evaluation error.
 */
export function evaluateParsed(expression: string, data: unknown): unknown {
  const ast = new Parser(tokenize(expression)).parse();
  return run(ast, data || {});
}
