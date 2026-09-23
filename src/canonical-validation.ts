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
 * SYS-3728: THE canonical write contract — one validator, used by every writer
 * before it persists and by every reader before it renders.
 *
 * WHY IT EXISTS. A credit-bureau table reached storage as a JSON array in a
 * field declared `string`, and every check passed, because a JSON array IS a
 * valid string. The declaration was wrong, and nothing compared a value against
 * what its declaration actually meant. This does, for every rule the registry
 * can state: type, finiteness, length, format, control characters, closed
 * sets, list shape and list columns.
 *
 * WHAT IT NEVER DOES. A violation names the field, the list row, the declared
 * column and the rule — NEVER the value, and never an undeclared field or key
 * name (both are attacker-controlled text). The data this guards is sensitive;
 * a validation log must not become a second copy of it.
 *
 * ABSENT IS NOT INVALID. `null` and `undefined` are skipped: a field the source
 * did not print is omitted. A BLANK string is a violation — absent is written
 * as absent, never as "" — and so is a PLACEHOLDER ("-", "N/A", "nil", "see
 * attached"): a reader renders absent as "-" already, so a stored "-" says
 * nothing a missing value does not, and a stored "N/A" is text pretending to
 * be a value.
 *
 * EVERY EXPORTED VALIDATOR JUDGES A SNAPSHOT. Each one first proves its input
 * is plain data and copies it (`normalizeForWrite`), then judges the copy: a
 * getter, a `toJSON` or a sparse array cannot make the verdict describe
 * something other than what JSON would store. Only `prepareExtractionForWrite`
 * RETURNS that copy, so it is the only one a writer may persist from — the
 * others are check-only.
 */

import {
  categorySchemaOf,
  STRING_MAX_LENGTH_DEFAULT,
  LIST_MAX_ITEMS_DEFAULT,
  type AdapterCategory,
  type CanonicalFieldSpec,
  type CategoryPeriodFields,
  type CategoryRequirement,
  type ListItemSpec,
} from './adapter-categories.js'
import { isJurisdiction } from './jurisdiction.js'
import { isAllowedCurrency, minorUnitsOf, MONEY_MAX_DECIMALS } from './currency.js'

export { STRING_MAX_LENGTH_DEFAULT, LIST_MAX_ITEMS_DEFAULT }

export type ViolationRule =
  | 'unknown-field'
  | 'type-mismatch'
  | 'non-finite-number'
  | 'serialized-structure'
  | 'control-characters'
  | 'malformed-text'
  | 'blank-string'
  | 'max-length'
  | 'pattern-mismatch'
  | 'enum-not-member'
  | 'enum-labels-missing'
  | 'currency-not-allowed'
  | 'list-not-array'
  | 'list-item-not-object'
  | 'undeclared-item-key'
  | 'duplicate-item-key'
  | 'max-items'
  | 'invalid-instance-key'
  | 'invalid-observed-at'
  | 'invalid-confidence'
  | 'invalid-period'
  | 'duplicate-period'
  | 'invisible-characters'
  | 'excessive-combining-marks'
  | 'out-of-range'
  | 'not-an-integer'
  | 'unsafe-magnitude'
  | 'invalid-date'
  | 'date-order'
  | 'not-plain-data'
  | 'placeholder'
  | 'non-ascii-space'
  | 'untrimmed'
  | 'implausible-date'
  | 'currency-mismatch'
  | 'currency-missing'
  | 'period-mismatch'
  | 'excess-precision'
  | 'empty-row'
  | 'empty-instance'
  | 'missing-identity'
  | 'missing-required'
  | 'malformed-list'
  /**
   * Reported by a WRITER, never by this validator: a value the source printed
   * that the writer could not read as its declared type (an unparseable or
   * foreign-currency amount, an impossible date, an identifier that fails its
   * pattern, an unknown enum label). The writer omits the value and reports
   * this, so the write is refused rather than the value silently lost. Named
   * here so every writer reports it under one spelling.
   */
  | 'unreadable-printed-value'

/**
 * One broken rule. `field` is the canonical field (or envelope key), or
 * `'(unknown)'` / `'(envelope)'` for a name nothing declares — such a name is
 * not echoed. `item` is the list row index; `key` the DECLARED column name;
 * `period` the index into `periods`; `envelope` marks a violation of the
 * writer's envelope rather than a category field.
 */
export interface Violation {
  field: string
  rule: ViolationRule
  item?: number
  key?: string
  period?: number
  envelope?: true
}

export interface ValidationResult {
  ok: boolean
  violations: Violation[]
}

export interface ValidationOptions {
  /**
   * The document's or application's jurisdiction. Selects which
   * `jurisdictionPatterns` apply. Matched STRICTLY (`isJurisdiction`): an
   * absent, unknown or lowercase code applies jurisdiction-independent rules
   * only. This deliberately does NOT follow `resolveJurisdiction`'s "absent
   * means Malaysia" — that rule is right for rendering a legacy record and
   * wrong for accepting data: an unproven jurisdiction must not be held to
   * Malaysia's formats, nor pass because it happens to match them.
   */
  jurisdiction?: string | null
  /** The adapter manifest's `enumValues` — the closed label set per enum field. */
  enumValues?: Readonly<Record<string, ReadonlyArray<string>>>
  /**
   * `'require'` (default): an enum field present without a label set in
   * `enumValues` is a violation (`enum-labels-missing`) — a writer cannot
   * claim membership of a set it did not supply. `'skip'`: membership is not
   * checked (a reader that holds no manifest); every string rule still is.
   */
  enumMembership?: 'require' | 'skip'
  /**
   * The clock a date's plausibility is measured against (default: now). A
   * date may not be after this day plus one (UTC — the extra day is the time
   * zones ahead of it), or, for a `mayBeFuture` field, after this day plus
   * `FUTURE_DATE_HORIZON_YEARS`. Injectable so a test freezes it rather than
   * inheriting whatever day the suite runs on.
   */
  now?: Date
}

/** The options, with the clock resolved once per call into the two date ceilings. */
interface Context extends ValidationOptions {
  pastCeiling: string
  futureCeiling: string
  /** Each JSON-text list parsed once per call, however many rules read it. */
  lists: Map<string, ListParse>
}

// ── Text rules ─────────────────────────────────────────────────────────

/**
 * Characters that are not text anyone printed. Refused in EVERY string:
 *   - every Default_Ignorable_Code_Point: zero-width space / joiners, LRM /
 *     RLM / ALM, soft hyphen, BOM, word joiner, invisible operators, bidi
 *     controls, the combining grapheme joiner U+034F, every variation selector
 *     (U+FE00–FE0F, U+E0100–E01EF), the Mongolian free variation selectors,
 *     the Khmer inherent vowels U+17B4/17B5, the Hangul fillers (U+115F,
 *     U+1160, U+3164, U+FFA0), tag characters;
 *   - every other format character (\p{Cf}), private use (\p{Co}) and
 *     unassigned code point (\p{Cn}, which includes every noncharacter:
 *     U+FFFE/FFFF, U+FDD0–FDEF);
 *   - the braille blank U+2800, a symbol that renders as nothing.
 * ZWJ / ZWNJ are refused too, including inside a word: the data this guards is
 * Malay, English, Chinese, Thai and Vietnamese, none of which needs them, and
 * "a joiner is fine here" is exactly the judgement a denylist cannot make.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\u2800]/u

/**
 * Control characters (\p{Cc}: C0, DEL, C1) and the line / paragraph
 * separators. Tab and newline are allowed only in LONG TEXT (maxLength above
 * the 256 default: addresses and remarks that wrap); a carriage return never —
 * a writer normalizes line endings to "\n".
 */
const CONTROL_ANYWHERE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u
const CONTROL_SHORT = /[\t\n]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
/**
 * Every space separator but U+0020: no-break, en / em / thin / hair, narrow
 * no-break, medium mathematical, ideographic, Ogham. Each looks like a space
 * and compares unequal to one, so "ALI BIN ABU" and "ALI\u00a0BIN ABU" would
 * be two subjects. A writer maps them to U+0020 (`normalizePrintedText`).
 */
const NON_ASCII_SPACE = /(?! )\p{Zs}/u
const NON_ASCII_SPACE_ALL = /(?! )\p{Zs}/gu
/** Stored text is trimmed: leading or trailing whitespace is a second spelling of the same value. */
const UNTRIMMED = /^\s|\s$/u
/** A combining mark with no base to combine with is not text. */
const LEADING_MARK = /^\p{M}/u
/**
 * More than two stacked NONSPACING marks on one base: never language, only
 * rendering abuse ("zalgo"). Counted after NFC, which composes Vietnamese to
 * precomposed letters; Thai (vowel + tone) and Tamil / Indic (spacing vowel
 * signs are \p{Mc} and not counted) stay within two.
 */
const COMBINING_OVERFLOW = /[\p{Mn}\p{Me}]{3,}/u
/** A value is blank when nothing in it is a letter, number, punctuation or symbol. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
/**
 * Words that stand in for a value the source did not give, compared
 * case-insensitively with spaces, dots, slashes, hyphens and underscores
 * removed ("N/A", "n.a.", "N A" are all "na"). Closed on purpose: adding a
 * word here refuses every value that spells it, in every category.
 */
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set(['na', 'nil', 'null', 'none', 'seeattached', 'notapplicable', 'notavailable'])

/**
 * A placeholder: text with no letter and no number in it ("-", "–", "—", ".",
 * "*", "?"), or one of `PLACEHOLDER_WORDS`. Not a value — a writer omits it.
 */
export function isPlaceholderText(value: string): boolean {
  if (!LETTER_OR_NUMBER.test(value)) return true
  return PLACEHOLDER_WORDS.has(value.toLowerCase().replace(/[\s./\\_-]+/gu, ''))
}

/** A line break with the whitespace around it (CR, LF, CRLF, U+2028, U+2029). */
const LINE_BREAK_RUN = /\s*[\r\n\u2028\u2029]\s*/gu
const CR_OR_SEPARATOR = /\r\n?|[\u2028\u2029]/gu

/**
 * A value's line breaks as its field allows them. SHORT text (a name, an
 * identifier) is one line: every line break, with the whitespace around it,
 * becomes one space — "SYNTHETIC TRADING\nSDN BHD" is the name
 * "SYNTHETIC TRADING SDN BHD" wrapped by the page, not two values. LONG text
 * (an address, a remark) keeps its lines, each ending "\n": CRLF, CR and the
 * Unicode line / paragraph separators become "\n".
 */
export function normalizeLineBreaks(value: string, longText: boolean): string {
  return longText ? value.replace(CR_OR_SEPARATOR, '\n') : value.replace(LINE_BREAK_RUN, ' ')
}

/**
 * THE writer-side text rule: printed text as the validator will accept it,
 * or `undefined` when there is none. NFC; line breaks as the field allows
 * them (`normalizeLineBreaks` — short text by default; pass `longText` for a
 * field or item whose maxLength exceeds the 256 default); every non-ASCII
 * space separator mapped to U+0020; trimmed; and absent when what is left is
 * blank or a placeholder. It does not repair anything else — an invisible or
 * control character, or leading structure, is still the validator's to
 * refuse.
 *
 * A placeholder is absent even where it could be a value: a subject named
 * "NA" is read as "not available", because the report prints exactly that
 * for a missing name, and storing it as a name would be the worse error.
 */
export function normalizePrintedText(value: unknown, opts: { longText?: boolean } = {}): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = normalizeLineBreaks(value.normalize('NFC'), opts.longText === true).replace(NON_ASCII_SPACE_ALL, ' ').trim()
  if (text === '' || !VISIBLE.test(text) || isPlaceholderText(text)) return undefined
  return text
}

const patternCache = new Map<string, RegExp>()
function fullMatch(source: string): RegExp {
  let re = patternCache.get(source)
  if (!re) {
    re = new RegExp(`^(?:${source})$`, 'u')
    patternCache.set(source, re)
  }
  return re
}

/**
 * Structure is keyed on the LEADING VISIBLE CHARACTER, not on parseability —
 * a parse test catches only the one serializer its author thought of, and
 * misses Python's repr, JS literals, trailing commas and the truncated array
 * that started all this.
 *
 * "Leading visible" means after whitespace, combining marks and
 * default-ignorable / format characters (each refused on its own as well, but
 * this rule does not depend on that), and "{" / "[" include their fullwidth
 * and small-form lookalikes (｛ ﹛ ❴ ⦃, ［ ⁅ ⟦).
 *
 *   - Any string whose first visible character opens an object is refused.
 *   - A string may open with a bracketed tag or name ("[CANCELLED] …",
 *     "[ACME] SDN BHD") — and nothing that looks like a sequence: the bracket
 *     is refused when what follows (after spaces) is a bracket, a brace, a
 *     quote, a closing bracket, or a number, or when it is never closed. So
 *     "[1] Case withdrawn" is refused as well; a writer that needs it writes
 *     "(1) …" or "No. 1 …".
 *   - A SHORT string (maxLength ≤ 256) that opens with a bracket is refused,
 *     further, when it parses as JSON or carries a JSON structural marker
 *     anywhere (`":`, `{"`, `[{`, `":[` — fullwidth quotes and brackets
 *     folded to ASCII first): a short field has no business holding either.
 *     (Round 3 relaxed this from "every leading bracket": a company printed
 *     "[ACME] SDN BHD" is a name, and refusing it refused a real value.)
 *   - A value that is a JSON STRING LITERAL ('"[{\"a\":1}]"') is decoded and
 *     held to the same rule: a double-encoded table is still a table.
 *
 * Structure NOT at the start ("Name: [{…}]") is not detected; that belongs to
 * the per-field format rules where a format is provable.
 */
const LEADING_NOISE = /^[\s\p{M}\p{Default_Ignorable_Code_Point}\p{Cf}]+/u
const OBJECT_OPENERS = '{\uff5b\ufe5b\u2774\u2983'
const ARRAY_OPENERS = '[\uff3b\u2045\u27e6'
const ARRAY_CLOSER = /[\]\uff3d\u2046\u27e7]/u
const LONG_TEXT_SEQUENCE = /^.\s*(?:[[{"'‘“\]\uff3b\uff3d\uff5b\u2045\u27e6\uff02]|[-+]?\p{Nd})/u
/** A JSON structural marker, anywhere in the text: a key's close-quote-colon, or an object opening inside a sequence. */
const JSON_MARKER = /":|\{"|\[\{|\[\s*\{/u
/** Fullwidth and small-form lookalikes of the JSON punctuation, folded to ASCII before `JSON_MARKER` is tried. */
const FOLD_JSON_PUNCTUATION: Readonly<Record<string, string>> = {
  '\uff02': '"', '\u201c': '"', '\u201d': '"', '\uff1a': ':', '\ufe55': ':',
  '\uff5b': '{', '\ufe5b': '{', '\u2774': '{', '\u2983': '{',
  '\uff3b': '[', '\u2045': '[', '\u27e6': '[',
}
const FOLDABLE = /[\uff02\u201c\u201d\uff1a\ufe55\uff5b\ufe5b\u2774\u2983\uff3b\u2045\u27e6]/gu
function looksLikeJson(text: string): boolean {
  const folded = text.replace(FOLDABLE, (c) => FOLD_JSON_PUNCTUATION[c] ?? c).replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '')
  if (JSON_MARKER.test(folded)) return true
  try {
    JSON.parse(folded)
    return true
  } catch {
    return false
  }
}
const STRING_LITERAL_DEPTH = 4
/** Exported for its own tests (not from the package index): every caller runs the text rules first. */
export function isSerializedStructure(value: string, longText: boolean, depth = 0): boolean {
  const t = value.replace(LEADING_NOISE, '')
  const first = t[0]
  if (first === undefined) return false
  if (OBJECT_OPENERS.includes(first)) return true
  if (ARRAY_OPENERS.includes(first)) {
    if (LONG_TEXT_SEQUENCE.test(t) || !ARRAY_CLOSER.test(t.slice(1))) return true
    return !longText && looksLikeJson(t)
  }
  if ((first === '"' || first === '\uff02') && depth < STRING_LITERAL_DEPTH) {
    try {
      const inner: unknown = JSON.parse(first === '"' ? t.trimEnd() : `"${t.slice(1, -1)}"`)
      if (typeof inner === 'string') return isSerializedStructure(inner, longText, depth + 1)
    } catch {
      // Not a JSON string literal: a value that merely opens with a quote.
    }
  }
  return false
}

interface StringRules {
  maxLength?: number
  pattern?: string
  jurisdictionPatterns?: Readonly<Partial<Record<string, string>>>
  format?: 'date' | 'year'
  mayBeFuture?: true
}

/** The text rules every string is held to — field, list item and instance key alike. */
function textViolation(value: string, longText: boolean): ViolationRule | null {
  if (LONE_SURROGATE.test(value)) return 'malformed-text'
  if (INVISIBLE.test(value)) return 'invisible-characters'
  if (CONTROL_ANYWHERE.test(value)) return 'control-characters'
  if (!longText && CONTROL_SHORT.test(value)) return 'control-characters'
  if (LEADING_MARK.test(value)) return 'malformed-text'
  if (NON_ASCII_SPACE.test(value)) return 'non-ascii-space'
  if (!VISIBLE.test(value)) return 'blank-string'
  if (UNTRIMMED.test(value)) return 'untrimmed'
  if (COMBINING_OVERFLOW.test(value)) return 'excessive-combining-marks'
  return null
}

/** Every rule a string value is held to, in order; the first failure is the one reported. */
function stringViolation(value: string, rules: StringRules, ctx: Context): ViolationRule | null {
  const maxLength = rules.maxLength ?? STRING_MAX_LENGTH_DEFAULT
  const longText = maxLength > STRING_MAX_LENGTH_DEFAULT
  const text = textViolation(value, longText)
  if (text) return text
  if (value.length > maxLength) return 'max-length'
  if (isSerializedStructure(value, longText)) return 'serialized-structure'
  if (isPlaceholderText(value)) return 'placeholder'
  if (rules.format !== undefined) {
    if (!isCalendarValue(value, rules.format)) return 'invalid-date'
    if (!isPlausibleDate(value, rules.format, rules.mayBeFuture ? ctx.futureCeiling : ctx.pastCeiling)) return 'implausible-date'
  }
  if (rules.pattern !== undefined && !fullMatch(rules.pattern).test(value)) return 'pattern-mismatch'
  const j = ctx.jurisdiction
  if (isJurisdiction(j)) {
    const source = rules.jurisdictionPatterns?.[j]
    if (source !== undefined && !fullMatch(source).test(value)) return 'pattern-mismatch'
  }
  return null
}

// ── Dates ─────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_YEAR = /^\d{4}$/
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/

/** A real calendar date, year 0001–9999 — checked by arithmetic, not by Date's lenient parser. */
function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!
  return d <= days
}

function isCalendarValue(value: string, format: 'date' | 'year'): boolean {
  if (format === 'year') return ISO_YEAR.test(value) && Number(value) >= 1
  return isCalendarDate(value)
}

/** No dated value in a credit record is older than this. */
export const DATE_FLOOR = '1900-01-01'
/** How far ahead a `mayBeFuture` date may lie: a hearing, an expiry, a financial year still running. */
export const FUTURE_DATE_HORIZON_YEARS = 10

/**
 * The latest plausible day, as ISO YYYY-MM-DD: the clock's UTC day plus one
 * (past-only), or plus `FUTURE_DATE_HORIZON_YEARS` (mayBeFuture). An invalid
 * clock yields a ceiling below every date — fail closed, never open.
 */
function dateCeiling(now: Date, future: boolean): string {
  const t = now.getTime()
  if (!Number.isFinite(t)) return '0000-00-00'
  const d = new Date(Date.UTC(now.getUTCFullYear() + (future ? FUTURE_DATE_HORIZON_YEARS : 0), now.getUTCMonth(), now.getUTCDate() + (future ? 0 : 1)))
  return d.toISOString().slice(0, 10)
}

/** A calendar-valid date or year, within [DATE_FLOOR, ceiling]. ISO text compares in date order. */
function isPlausibleDate(value: string, format: 'date' | 'year', ceiling: string): boolean {
  if (format === 'year') return value >= DATE_FLOOR.slice(0, 4) && value <= ceiling.slice(0, 4)
  return value >= DATE_FLOOR && value <= ceiling
}

function contextOf(opts: ValidationOptions): Context {
  const now = opts.now ?? new Date()
  return { ...opts, pastCeiling: dateCeiling(now, false), futureCeiling: dateCeiling(now, true), lists: new Map() }
}

/** An ISO 8601 instant: a real date, hour 00–23, minute and second 00–59, offset within ±14:00. */
function isInstant(value: string): boolean {
  const m = ISO_DATE_TIME.exec(value)
  if (!m) return false
  if (!isCalendarDate(m[1]!)) return false
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || (m[4] !== undefined && Number(m[4]) > 59)) return false
  if (m[6] !== undefined) {
    const hours = Number(m[7])
    const minutes = Number(m[8])
    if (minutes > 59 || hours > 14 || (hours === 14 && minutes > 0)) return false
  }
  return true
}

// ── Numbers ───────────────────────────────────────────────────────────

/** The largest magnitude a non-integer quantity may carry: a quadrillion, past any real balance. */
export const NUMBER_MAX_MAGNITUDE = 1e15

/**
 * SYS-3728 round 4: the most decimals a ratio (`unit: "ratio"`) may carry —
 * the storage scale of a ratio column (DECIMAL(12,6)). More is refused
 * (`excess-precision`), never rounded: 4e-7 would be stored as 0, and float
 * noise (0.14300000000000002) would be stored as a value nobody printed. A
 * writer derives a ratio by an exact decimal shift, not float division.
 */
export const RATIO_MAX_DECIMALS = 6

interface NumberRules {
  unit?: string
  range?: readonly [number, number]
  kind?: string
}

/**
 * The decimals a number carries, as JSON writes it (its shortest round-trip
 * form — the text the storage driver sends). 1e-7 carries seven.
 */
export function decimalsOf(n: number): number {
  const s = String(Math.abs(n))
  const e = s.indexOf('e')
  if (e < 0) return (s.split('.')[1] ?? '').length
  const mantissa = (s.slice(0, e).split('.')[1] ?? '').length
  return Math.max(0, mantissa - Number(s.slice(e + 1)))
}

/**
 * A number's domain:
 *   - a finite number, never text;
 *   - `unit: "count"`, and `unit: "score"` unless its declared range lies
 *     within the unit interval, are non-negative safe integers — a bureau
 *     score is whole points; a 0..1 score (the geolocation scores) is a
 *     fraction, held to its range;
 *   - every other number has magnitude at most NUMBER_MAX_MAGNITUDE (1e15,
 *     inside DECIMAL(18,2)'s 9,999,999,999,999,999.99);
 *   - money (`kind: "money"`, a field or a list item) carries at most
 *     MONEY_MAX_DECIMALS (2, the storage scale) — `excess-precision`, never
 *     rounded; the extraction-level rules hold it to its currency's own minor
 *     units as well (VND: none);
 *   - a ratio (`unit: "ratio"`) carries at most RATIO_MAX_DECIMALS (6) —
 *     `excess-precision`, never rounded;
 *   - a declared `range` is enforced, inclusive (a count stored in an INT
 *     column declares [0, 2147483647]).
 */
function numberViolation(value: unknown, rules: NumberRules = {}): ViolationRule | null {
  if (typeof value !== 'number') return 'type-mismatch'
  if (!Number.isFinite(value)) return 'non-finite-number'
  const integral = rules.unit === 'count' || (rules.unit === 'score' && !(rules.range !== undefined && rules.range[1] <= 1))
  if (integral) {
    if (!Number.isSafeInteger(value)) return 'not-an-integer'
    if (value < 0) return 'out-of-range'
  } else if (Math.abs(value) > NUMBER_MAX_MAGNITUDE) {
    return 'unsafe-magnitude'
  } else if (rules.kind === 'money' && decimalsOf(value) > MONEY_MAX_DECIMALS) {
    return 'excess-precision'
  } else if (rules.unit === 'ratio' && decimalsOf(value) > RATIO_MAX_DECIMALS) {
    return 'excess-precision'
  }
  if (rules.range !== undefined && (value < rules.range[0] || value > rules.range[1])) return 'out-of-range'
  return null
}

// ── Lists ─────────────────────────────────────────────────────────────

/** `appointment-date` → `appointmentDate`: the one alias a stored key may use for its item. */
export function kebabToCamel(key: string): string {
  return key.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The longest JSON text a list may be stored as: 1,000,000 UTF-16 code units.
 * Checked BEFORE the text is parsed, so an oversized value costs a length
 * read, not a parse. A 500-row facility table is ~300 KB; a list that needs
 * more is not a list any report prints.
 */
export const LIST_TEXT_MAX_LENGTH = 1_000_000

/** JSON.parse reviver: every string in the parsed value is stored NFC. */
const nfcReviver = (_key: string, v: unknown): unknown => (typeof v === 'string' ? v.normalize('NFC') : v)

/**
 * Whether valid JSON text declares one key twice in one object. JSON.parse
 * keeps the last silently, so `{"name":"x","name":"A"}` is one value to this
 * parser and possibly the other to the next one. Called only on text that has
 * already parsed.
 */
function jsonHasDuplicateKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [] // null: an array
  let expectKey = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const top = stack[stack.length - 1]
      if (expectKey && top) {
        const key = JSON.parse(text.slice(i, j + 1)) as string
        if (top.has(key)) return true
        top.add(key)
        expectKey = false
      }
      i = j
    } else if (c === '{') {
      stack.push(new Set())
      expectKey = true
    } else if (c === '[') {
      stack.push(null)
      expectKey = false
    } else if (c === '}' || c === ']') {
      stack.pop()
      expectKey = false
    } else if (c === ',') {
      expectKey = stack[stack.length - 1] != null
    }
  }
  return false
}

/**
 * The deepest a list's JSON text may nest: the array (1), a row object (2),
 * and room for a cell that is itself wrongly structured (3, 4) to be refused
 * for what it is. Anything deeper is `malformed-list`, found by a linear scan
 * BEFORE the text is parsed — so a hostile "[[[[…" costs one pass, never a
 * recursive parse or a RangeError.
 */
export const LIST_MAX_DEPTH = 4

/** Whether JSON-ish text opens more than `max` brackets / braces at once (outside strings). Never throws, never loops past the end. */
function nestsDeeperThan(text: string, max: number): boolean {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 34 /* " */) {
      i++
      while (i < text.length && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 /* \ */ ? 2 : 1
    } else if (c === 91 /* [ */ || c === 123 /* { */) {
      if (++depth > max) return true
    } else if (c === 93 /* ] */ || c === 125 /* } */) {
      depth--
    }
  }
  return false
}

export type ListParse =
  | { rows: unknown[] }
  | { rule: 'type-mismatch' | 'list-not-array' | 'max-length' | 'duplicate-item-key' | 'malformed-list' }

/**
 * A list value as its rows, or why it is not one. A list is an array, or a
 * JSON string of an array (the stored form) — at most LIST_TEXT_MAX_LENGTH
 * long, nested at most LIST_MAX_DEPTH deep, with no object declaring a key
 * twice. Parsed strings are NFC.
 */
export function parseListValue(value: unknown): ListParse {
  if (Array.isArray(value)) return { rows: value }
  if (typeof value !== 'string') return { rule: 'type-mismatch' }
  if (value.length > LIST_TEXT_MAX_LENGTH) return { rule: 'max-length' }
  if (nestsDeeperThan(value, LIST_MAX_DEPTH)) return { rule: 'malformed-list' }
  let parsed: unknown
  try {
    // ASCII text with no \u escape can only hold ASCII strings, which are
    // already NFC: the reviver (a call per node) is spent only where it can
    // change something.
    parsed = MAY_NEED_NFC.test(value) ? JSON.parse(value, nfcReviver) : JSON.parse(value)
  } catch {
    return { rule: 'list-not-array' }
  }
  if (!Array.isArray(parsed)) return { rule: 'list-not-array' }
  if (jsonHasDuplicateKeys(value)) return { rule: 'duplicate-item-key' }
  return { rows: parsed }
}

const MAY_NEED_NFC = /[^\u0000-\u007f]|\\u/

/** `parseListValue`, once per distinct text per validation call. */
function parseListCached(value: unknown, ctx: Context): ListParse {
  if (typeof value !== 'string') return parseListValue(value)
  let parsed = ctx.lists.get(value)
  if (!parsed) {
    parsed = parseListValue(value)
    ctx.lists.set(value, parsed)
  }
  return parsed
}

/**
 * One row's values under its declared items: exact item names first, then a
 * kebab-case key for an item not already given. Returns the matched values
 * and the violations of the key set itself.
 */
export function matchListRow(
  row: Record<string, unknown>,
  items: ReadonlyArray<ListItemSpec>,
): { values: Map<string, unknown>; undeclared: boolean; duplicated: string[] } {
  const declared = new Set(items.map((i) => i.name))
  const values = new Map<string, unknown>()
  let undeclared = false
  const duplicated: string[] = []
  for (const [k, v] of Object.entries(row)) if (declared.has(k)) values.set(k, v)
  for (const [k, v] of Object.entries(row)) {
    if (declared.has(k)) continue
    const camel = kebabToCamel(k)
    if (camel !== k && declared.has(camel)) {
      if (values.has(camel)) duplicated.push(camel)
      else values.set(camel, v)
    } else {
      undeclared = true
    }
  }
  return { values, undeclared, duplicated }
}

function listViolations(spec: CanonicalFieldSpec, value: unknown, ctx: Context): Violation[] {
  const field = spec.name
  const parsed = parseListCached(value, ctx)
  if ('rule' in parsed) return [{ field, rule: parsed.rule }]
  const out: Violation[] = []
  if (parsed.rows.length > (spec.maxItems ?? LIST_MAX_ITEMS_DEFAULT)) out.push({ field, rule: 'max-items' })
  const items = spec.items ?? []
  parsed.rows.forEach((row, item) => {
    if (!isPlainObject(row)) {
      out.push({ field, item, rule: 'list-item-not-object' })
      return
    }
    // A row with nothing in it is not a printed row: a writer that emits one
    // has lost whatever the row held, or invented a row the source never had.
    if (!Object.values(row).some((v) => v !== null && v !== undefined)) {
      out.push({ field, item, rule: 'empty-row' })
      return
    }
    const { values, undeclared, duplicated } = matchListRow(row, items)
    if (undeclared) out.push({ field, item, rule: 'undeclared-item-key' })
    for (const key of duplicated) out.push({ field, item, key, rule: 'duplicate-item-key' })
    for (const it of items) {
      const v = values.get(it.name)
      if (v === null || v === undefined) continue
      const rule = itemViolation(it, v, ctx)
      if (rule) out.push({ field, item, key: it.name, rule })
    }
  })
  return out
}

function itemViolation(it: ListItemSpec, v: unknown, ctx: Context): ViolationRule | null {
  if (it.type === 'number') return numberViolation(v, it)
  return typeof v === 'string' ? stringViolation(v, it, ctx) : 'type-mismatch'
}

/**
 * The first rule one list-row value breaks under its item spec, or null —
 * judged on its snapshot, like every exported validator. For a writer that
 * must decide per cell whether a printed value is storable (a mapper that
 * omits an identifier it cannot store rather than refuse the whole document).
 */
export function validateListItemValue(it: ListItemSpec, value: unknown, opts: ValidationOptions = {}): ViolationRule | null {
  if (value === null || value === undefined) return null
  const snap = snapshotOf(value)
  if (!snap.ok) return 'not-plain-data'
  return itemViolation(it, snap.snapshot, contextOf(opts))
}

// ── Fields ────────────────────────────────────────────────────────────

/**
 * Every violation of one value against its field spec. `null` / `undefined`
 * is absent and has none.
 */
export function validateFieldValue(spec: CanonicalFieldSpec, value: unknown, opts: ValidationOptions = {}): Violation[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'number' && !Number.isFinite(value)) return [{ field: spec.name, rule: 'non-finite-number' }]
  const snap = snapshotOf(value)
  if (!snap.ok) return [{ field: spec.name, rule: 'not-plain-data' }]
  return fieldValueViolations(spec, snap.snapshot, contextOf(opts))
}

function fieldValueViolations(spec: CanonicalFieldSpec, value: unknown, ctx: Context): Violation[] {
  if (value === null || value === undefined) return []
  const field = spec.name
  switch (spec.type) {
    case 'number': {
      const rule = numberViolation(value, spec)
      return rule ? [{ field, rule }] : []
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [{ field, rule: 'type-mismatch' }]
    case 'list':
      return listViolations(spec, value, ctx)
    case 'string': {
      if (typeof value !== 'string') return [{ field, rule: 'type-mismatch' }]
      const rule = stringViolation(value, spec, ctx)
      if (rule) return [{ field, rule }]
      if (spec.kind === 'currency' && !isAllowedCurrency(value)) return [{ field, rule: 'currency-not-allowed' }]
      if (spec.kind === 'enum' && ctx.enumMembership !== 'skip') {
        // An ARRAY of labels, matched exactly: a string "label set" would
        // answer `includes` by substring.
        const labels: unknown = ctx.enumValues?.[field]
        if (!Array.isArray(labels)) return [{ field, rule: 'enum-labels-missing' }]
        if (!labels.includes(value)) return [{ field, rule: 'enum-not-member' }]
      }
      return []
    }
    default:
      return [{ field, rule: 'type-mismatch' }]
  }
}

function fieldsOf(category: AdapterCategory): Map<string, CanonicalFieldSpec> {
  return new Map(categorySchemaOf(category).fields.map((f) => [f.name as string, f]))
}

function fieldViolations(specs: Map<string, CanonicalFieldSpec>, fields: unknown, ctx: Context): Violation[] {
  if (!isPlainObject(fields)) return [{ field: '(values)', envelope: true, rule: 'type-mismatch' }]
  const out: Violation[] = []
  const valid = new Set<string>()
  for (const [name, value] of Object.entries(fields)) {
    const spec = specs.get(name)
    if (!spec) {
      out.push({ field: '(unknown)', rule: 'unknown-field' })
      continue
    }
    const v = fieldValueViolations(spec, value, ctx)
    out.push(...v)
    if (v.length === 0 && value !== null && value !== undefined) valid.add(name)
  }
  // A start that follows its end: checked only between two VALID dates, so it
  // never reports on a value already refused for itself.
  for (const name of valid) {
    const after = specs.get(name)?.notAfter
    if (after !== undefined && valid.has(after) && String(fields[name]) > String(fields[after])) {
      out.push({ field: name, rule: 'date-order' })
    }
  }
  return out
}

/**
 * CHECK-ONLY: a category's field values against their specs, judged on a
 * plain-data snapshot. `ok` is true exactly when there are no violations. The
 * extraction-level rules (currency and period consistency) need the whole
 * extraction and live in `validateAdapterExtraction`. A writer does not
 * persist from this — it calls `prepareExtractionForWrite` and persists the
 * snapshot that returns.
 */
export function validateCanonicalFields(
  category: AdapterCategory,
  fields: Record<string, unknown>,
  opts: ValidationOptions = {},
): ValidationResult {
  const snap = normalizeForWrite(fields)
  if (!snap.ok) return { ok: false, violations: snap.violations }
  const violations = fieldViolations(fieldsOf(category), snap.snapshot, contextOf(opts))
  return { ok: violations.length === 0, violations }
}

// ── The envelope ──────────────────────────────────────────────────────

/** The storage column's width (instance_key VARCHAR(200)). */
const INSTANCE_KEY_MAX_LENGTH = 200
/** A period position past this is not a reporting period, whatever the category. */
const PERIOD_POSITION_CEILING = 100

/**
 * An instance key: a string of at most 200 characters (the column), held to
 * the same text rules as a short field (no invisible, control or malformed
 * characters, no leading structure), with no leading or trailing whitespace,
 * already NFC, and not a path — no "/", no "\\", no "..". Every key a writer
 * mints (`experianReport:<sha256>#<section>`, `managementAccount:<id>`,
 * `legacy:T1`, `line-mobile-1`) is none of those.
 * `''` is allowed — the single-cardinality convention (canonical-view.ts).
 */
export function isValidInstanceKey(key: unknown): key is string {
  if (typeof key !== 'string') return false
  if (key === '') return true
  if (key.length > INSTANCE_KEY_MAX_LENGTH || key !== key.trim()) return false
  // Not a path: no separator and no parent segment, whatever consumes the key.
  if (/[/\\]/.test(key) || key.includes('..')) return false
  return key === key.normalize('NFC') && textViolation(key, false) === null && !isSerializedStructure(key, false)
}
const EXTRACTION_KEYS = new Set(['instanceKey', 'values', 'observedAt', 'confidence', 'periods'])
const PERIOD_KEYS = new Set(['position', 'start', 'end', 'values', 'confidence'])

function confidenceViolations(specs: Map<string, CanonicalFieldSpec>, confidence: unknown, period?: number): Violation[] {
  const at = period === undefined ? {} : { period }
  if (confidence === undefined) return []
  if (!isPlainObject(confidence)) return [{ field: 'confidence', ...at, envelope: true, rule: 'invalid-confidence' }]
  const out: Violation[] = []
  for (const [name, c] of Object.entries(confidence)) {
    if (!specs.has(name)) out.push({ field: 'confidence', ...at, envelope: true, rule: 'unknown-field' })
    else if (c !== null && (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1)) {
      out.push({ field: 'confidence', ...at, envelope: true, rule: 'invalid-confidence' })
    }
  }
  return out
}

/**
 * The shape a writer hands to persistence (`AdapterExtraction` plus the
 * per-field `confidence` the host attaches). The BOUNDARY, exactly:
 *
 *   ENVELOPE (host / adapter bookkeeping, validated here as envelope):
 *     instanceKey, observedAt, confidence, periods[].position,
 *     periods[].start, periods[].end, periods[].confidence
 *   CATEGORY FIELDS (validated against the registry):
 *     values, periods[].values
 *
 * Nothing else may be present: an undeclared top-level or period key is a
 * violation, reported as `(envelope)` without its name. ihsId, adapterId,
 * adapterVersion and adapterRunId are the host's own columns, passed beside
 * the instances rather than in them, and are not part of this shape.
 */
export interface ValidatableExtraction {
  instanceKey: unknown
  values: unknown
  observedAt?: unknown
  confidence?: unknown
  periods?: unknown
}

/**
 * CHECK-ONLY: the whole extraction — envelope, fields and the extraction-level
 * consistency rules — judged on its plain-data snapshot. A writer persists
 * from `prepareExtractionForWrite`, never from this.
 */
export function validateAdapterExtraction(
  category: AdapterCategory,
  extraction: ValidatableExtraction,
  opts: ValidationOptions = {},
): ValidationResult {
  const snap = normalizeForWrite(extraction)
  if (!snap.ok) return { ok: false, violations: snap.violations }
  // Judged as `prepareExtractionForWrite` would store it, so the check and
  // the write can never disagree about one extraction.
  const ctx = contextOf(opts)
  normalizeSnapshot(category, snap.snapshot, ctx)
  const violations = extractionViolations(category, snap.snapshot, ctx)
  return { ok: violations.length === 0, violations }
}

function extractionViolations(category: AdapterCategory, extraction: unknown, ctx: Context): Violation[] {
  const schema = categorySchemaOf(category)
  const specs = fieldsOf(category)
  const out: Violation[] = []
  if (!isPlainObject(extraction)) {
    return [{ field: '(envelope)', envelope: true, rule: 'type-mismatch' }]
  }
  for (const k of Object.keys(extraction)) {
    if (!EXTRACTION_KEYS.has(k)) out.push({ field: '(envelope)', envelope: true, rule: 'unknown-field' })
  }

  // The key may be '' — the single-cardinality convention (canonical-view.ts).
  if (!isValidInstanceKey(extraction.instanceKey)) {
    out.push({ field: 'instanceKey', envelope: true, rule: 'invalid-instance-key' })
  }

  const observed = extraction.observedAt
  if (observed !== undefined && (typeof observed !== 'string' || !isInstant(observed))) {
    out.push({ field: 'observedAt', envelope: true, rule: 'invalid-observed-at' })
  }

  out.push(...fieldViolations(specs, extraction.values, ctx))
  out.push(...confidenceViolations(specs, extraction.confidence))

  const periods = extraction.periods
  if (periods !== undefined) {
    if (!Array.isArray(periods)) {
      out.push({ field: 'periods', envelope: true, rule: 'invalid-period' })
    } else {
      const seen = new Set<number>()
      const maxPeriods = schema.maxPeriods ?? PERIOD_POSITION_CEILING
      periods.forEach((p, period) => {
        if (!isPlainObject(p)) {
          out.push({ field: 'periods', period, envelope: true, rule: 'invalid-period' })
          return
        }
        for (const k of Object.keys(p)) {
          if (!PERIOD_KEYS.has(k)) out.push({ field: '(envelope)', period, envelope: true, rule: 'unknown-field' })
        }
        const position = p.position
        if (typeof position !== 'number' || !Number.isInteger(position) || position < 1 || position > maxPeriods) {
          out.push({ field: 'position', period, envelope: true, rule: 'invalid-period' })
        } else if (seen.has(position)) {
          out.push({ field: 'position', period, envelope: true, rule: 'duplicate-period' })
        } else {
          seen.add(position)
        }
        let edgesValid = true
        for (const edge of ['start', 'end'] as const) {
          const d = p[edge]
          if (d === undefined) continue
          if (typeof d !== 'string' || !isCalendarDate(d)) {
            out.push({ field: edge, period, envelope: true, rule: 'invalid-period' })
            edgesValid = false
          } else if (!isPlausibleDate(d, 'date', ctx.futureCeiling)) {
            out.push({ field: edge, period, envelope: true, rule: 'implausible-date' })
            edgesValid = false
          }
        }
        if (edgesValid && typeof p.start === 'string' && typeof p.end === 'string' && p.start > p.end) {
          out.push({ field: 'start', period, envelope: true, rule: 'date-order' })
        }
        for (const v of fieldViolations(specs, p.values, ctx)) out.push({ ...v, period })
        out.push(...confidenceViolations(specs, p.confidence, period))
      })
    }
  }
  out.push(...consistencyViolations(schema.fields, schema.periodFields, extraction, ctx))
  out.push(...presenceViolations(schema.requiredAnyOf, extraction))
  return out
}

/**
 * What an instance must carry at all:
 *   - `empty-instance`: an instance with no value anywhere — top-level or in
 *     any period — and a period with no value of its own. Either is a row
 *     that says nothing, which a reader cannot tell from one whose values
 *     were lost.
 *   - the category's `requiredAnyOf` groups: each needs one of its fields
 *     present (top-level or in a period), for instances its `when` selects —
 *     `missing-identity` for an identity group, else `missing-required`.
 */
function presenceViolations(
  required: ReadonlyArray<CategoryRequirement> | undefined,
  extraction: Record<string, unknown>,
): Violation[] {
  const out: Violation[] = []
  const scopes: Record<string, unknown>[] = []
  if (isPlainObject(extraction.values)) scopes.push(extraction.values)
  const periods = Array.isArray(extraction.periods) ? extraction.periods : []
  const presentIn = (values: Record<string, unknown>) => Object.keys(values).filter((k) => present(values[k]))
  const seen = new Set<string>(scopes.length > 0 ? presentIn(scopes[0]!) : [])
  periods.forEach((p, period) => {
    const values = isPlainObject(p) && isPlainObject(p.values) ? p.values : undefined
    if (!values) return
    scopes.push(values)
    const own = presentIn(values)
    if (own.length === 0) out.push({ field: '(values)', period, envelope: true, rule: 'empty-instance' })
    for (const k of own) seen.add(k)
  })
  if (seen.size === 0) return [{ field: '(values)', envelope: true, rule: 'empty-instance' }]
  for (const group of required ?? []) {
    if (group.when !== undefined) {
      const when = group.when
      if (!scopes.some((v) => v[when.field] === when.equals)) continue
    }
    if (!group.anyOf.some((f) => seen.has(f))) {
      out.push({ field: group.anyOf[0]!, rule: group.identity ? 'missing-identity' : 'missing-required' })
    }
  }
  return out
}

// ── Extraction-level consistency ─────────────────────────────────────

const isIsoDate = (v: unknown): v is string => typeof v === 'string' && isCalendarDate(v)
const present = (v: unknown): boolean => v !== null && v !== undefined

/**
 * Whether a scope (one `values` object) states an amount of money: a money
 * field, or a money column of any list row, holding a NUMBER. A value refused
 * for itself (a printed "RM 1") is reported once, as what it is, not again as
 * money without a currency.
 */
function statesMoney(fields: ReadonlyArray<CanonicalFieldSpec>, values: Record<string, unknown>, ctx: Context): boolean {
  for (const f of fields) {
    const v = values[f.name]
    if (!present(v)) continue
    if (f.kind === 'money' && typeof v === 'number') return true
    if (f.type === 'list') {
      const money = (f.items ?? []).filter((i) => i.kind === 'money').map((i) => i.name)
      if (money.length === 0) continue
      const parsed = parseListCached(v, ctx)
      if (!('rows' in parsed)) continue
      for (const row of parsed.rows) {
        if (!isPlainObject(row)) continue
        const { values: cells } = matchListRow(row, f.items!)
        if (money.some((m) => typeof cells.get(m) === 'number')) return true
      }
    }
  }
  return false
}

/** Every money value in one scope carrying more decimals than `minor` — only where `minor` is below the field rule's own bound. */
function minorUnitViolations(
  fields: ReadonlyArray<CanonicalFieldSpec>,
  values: Record<string, unknown>,
  minor: number,
  period: number | undefined,
  ctx: Context,
): Violation[] {
  if (minor >= MONEY_MAX_DECIMALS) return []
  const at = period === undefined ? {} : { period }
  const out: Violation[] = []
  for (const f of fields) {
    const v = values[f.name]
    if (f.kind === 'money' && typeof v === 'number' && Number.isFinite(v) && decimalsOf(v) > minor) {
      out.push({ field: f.name, ...at, rule: 'excess-precision' })
    }
    if (f.type !== 'list' || !present(v)) continue
    const money = (f.items ?? []).filter((i) => i.kind === 'money')
    if (money.length === 0) continue
    const parsed = parseListCached(v, ctx)
    if (!('rows' in parsed)) continue
    parsed.rows.forEach((row, item) => {
      if (!isPlainObject(row)) return
      const { values: cells } = matchListRow(row, f.items!)
      for (const m of money) {
        const c = cells.get(m.name)
        if (typeof c === 'number' && Number.isFinite(c) && decimalsOf(c) > minor) out.push({ field: f.name, item, key: m.name, ...at, rule: 'excess-precision' })
      }
    })
  }
  return out
}

/**
 * The rules no single field can state, because they compare fields:
 *
 *   - CURRENCY (a category with a `kind: "currency"` field): every currency the
 *     extraction states — top-level `values` and each period's — is one
 *     currency (`currency-mismatch`); and a scope that states money states a
 *     currency, its own or the top level's (`currency-missing`). An amount
 *     with no denomination is a number, not money.
 *   - PERIOD EXTENT (a category declaring `periodFields`): an envelope
 *     `periods[].start` / `.end` equals the period's own start / end field
 *     when both are given, and a year field is the year of the end field
 *     (`period-mismatch`). Compared only between well-formed values, so a
 *     value refused for itself is not reported twice.
 */
function consistencyViolations(
  fields: ReadonlyArray<CanonicalFieldSpec>,
  periodFields: CategoryPeriodFields | undefined,
  extraction: Record<string, unknown>,
  ctx: Context,
): Violation[] {
  const out: Violation[] = []
  const top = isPlainObject(extraction.values) ? extraction.values : {}
  const periods = Array.isArray(extraction.periods) ? extraction.periods : []
  const scoped = periods.map((p, period) => ({ period, p: isPlainObject(p) ? p : {} }))
    .map(({ period, p }) => ({ period, p, values: isPlainObject(p.values) ? p.values : {} }))

  const currency = fields.find((f) => f.kind === 'currency')?.name
  if (currency !== undefined) {
    const stated = [top[currency], ...scoped.map((s) => s.values[currency])].filter(isAllowedCurrency)
    if (new Set(stated).size > 1) out.push({ field: currency, rule: 'currency-mismatch' })
    const topCurrency = isAllowedCurrency(top[currency])
    if (!topCurrency && statesMoney(fields, top, ctx)) out.push({ field: currency, rule: 'currency-missing' })
    for (const { period, values } of scoped) {
      if (!topCurrency && !isAllowedCurrency(values[currency]) && statesMoney(fields, values, ctx)) {
        out.push({ field: currency, period, rule: 'currency-missing' })
      }
    }
    // Money within its own currency's minor units. The field rule already
    // holds every amount to MONEY_MAX_DECIMALS; this adds the currencies with
    // fewer (VND has none).
    out.push(...minorUnitViolations(fields, top, minorUnitsOf(top[currency]), undefined, ctx))
    for (const { period, values } of scoped) {
      const own = isAllowedCurrency(values[currency]) ? values[currency] : top[currency]
      out.push(...minorUnitViolations(fields, values, minorUnitsOf(own), period, ctx))
    }
  }

  if (periodFields !== undefined) {
    const yearOf = (values: Record<string, unknown>, period?: number) => {
      const { year, end } = periodFields
      if (year === undefined || end === undefined) return
      const y = values[year]
      const e = values[end]
      if (typeof y === 'string' && ISO_YEAR.test(y) && isIsoDate(e) && e.slice(0, 4) !== y) {
        out.push({ field: year, ...(period === undefined ? {} : { period }), rule: 'period-mismatch' })
      }
    }
    yearOf(top)
    for (const { period, p, values } of scoped) {
      for (const edge of ['start', 'end'] as const) {
        const name = periodFields[edge]
        if (name === undefined) continue
        const envelope = p[edge]
        const own = values[name] ?? top[name]
        if (isIsoDate(envelope) && isIsoDate(own) && envelope !== own) {
          out.push({ field: edge, period, envelope: true, rule: 'period-mismatch' })
        }
      }
      yearOf(values, period)
    }
  }
  return out
}

// ── The snapshot: validate exactly what is stored ────────────────────

/**
 * THE WRITER CONTRACT, in full:
 *
 *   const r = prepareExtractionForWrite(category, extraction, opts)
 *   if (!r.ok) → refuse (log r.violations; they carry no values)
 *   else       → persist r.snapshot — THAT object, never `extraction`
 *
 * Why a snapshot. A validator that walks an in-memory value and then lets the
 * caller serialize it is checking a different thing from the one stored: a
 * `toJSON` (on a class, on an array, or planted on Object.prototype), a getter
 * that answers differently the second time, a sparse array whose holes become
 * nulls, a NaN that JSON silently writes as null — each passes the walk and
 * stores something else. So the input is first proven to be PLAIN DATA, then
 * round-tripped through JSON, and the round-tripped copy is what is validated
 * and what is persisted.
 *
 * What the copy changes, and only this:
 *   - every string is NFC (canonically equivalent text, one spelling of it);
 *   - line breaks as each field allows them (`normalizeLineBreaks`): a short
 *     value's collapse to one space, a long value's become "\n";
 *   - a list stored as JSON text is RE-SERIALIZED from its parse
 *     (`prepareExtractionForWrite` only): the caller's spacing, escapes and key
 *     order are not what is stored, so no consumer can parse it differently.
 * Nothing else is repaired: a non-ASCII space, untrimmed text or a
 * placeholder is refused, not rewritten — `normalizePrintedText` is the
 * writer's tool for those, applied where the text is read from its source.
 *
 * Plain data: null, booleans, finite numbers, strings; arrays that are dense,
 * of `Array.prototype`, with no own properties but their indices and length;
 * objects whose prototype is `Object.prototype` or null, with only enumerable
 * string-keyed data properties (no getters / setters, no symbols); no `toJSON`
 * reachable from any object or array (own or inherited); no cycles; depth at
 * most 32. `undefined` in an object is dropped, as JSON drops it.
 */
const SNAPSHOT_MAX_DEPTH = 32

function isPlainData(value: unknown, seen: Set<object>, depth: number): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false // function, bigint, symbol, undefined
  if (depth > SNAPSHOT_MAX_DEPTH || seen.has(value)) return false
  if ('toJSON' in value) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1) return false // a hole, or an extra own property
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, i)
        if (!d || !('value' in d) || !isPlainData(d.value, seen, depth + 1)) return false
      }
      return true
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const d = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in d) || !d.enumerable) return false
      if (d.value === undefined) continue
      if (!isPlainData(d.value, seen, depth + 1)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
}

export type SnapshotResult<T> = { ok: true; snapshot: T } | { ok: false; violations: Violation[] }

/** The plain-data, NFC JSON round-trip of `input`, or `not-plain-data`. See the writer contract above. */
export function normalizeForWrite<T>(input: T): SnapshotResult<T> {
  if (!isPlainData(input, new Set(), 0)) {
    return { ok: false, violations: [{ field: '(input)', envelope: true, rule: 'not-plain-data' }] }
  }
  return { ok: true, snapshot: JSON.parse(JSON.stringify(input), nfcReviver) as T }
}

/** `normalizeForWrite` for one value, without a JSON round-trip for a primitive. */
function snapshotOf(value: unknown): SnapshotResult<unknown> {
  if (typeof value === 'string') return { ok: true, snapshot: value.normalize('NFC') }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return isPlainData(value, new Set(), 0) ? { ok: true, snapshot: value } : { ok: false, violations: [] }
  }
  return normalizeForWrite(value)
}

const isLongText = (maxLength: number | undefined): boolean => (maxLength ?? STRING_MAX_LENGTH_DEFAULT) > STRING_MAX_LENGTH_DEFAULT

/** One list row's string cells with their line breaks as their items allow (`normalizeLineBreaks`), in place. */
function normalizeRowLineBreaks(row: unknown, items: ReadonlyMap<string, ListItemSpec>): void {
  if (!isPlainObject(row)) return
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'string') continue
    const it = items.get(k) ?? items.get(kebabToCamel(k))
    if (it?.type === 'string') row[k] = normalizeLineBreaks(v, isLongText(it.maxLength))
  }
}

/**
 * The snapshot's values as they are stored, in place: every string field's
 * and string list cell's line breaks as its spec allows (`normalizeLineBreaks`:
 * a short value's become one space, a long value's "\n"), and every JSON-text
 * list re-serialized from its parse. A list that does not parse cleanly is
 * left for the validator to refuse.
 */
function normalizeSnapshotValues(fields: ReadonlyArray<CanonicalFieldSpec>, values: unknown, ctx: Context): void {
  if (!isPlainObject(values)) return
  for (const f of fields) {
    const v = values[f.name]
    if (f.type === 'string' && typeof v === 'string') {
      values[f.name] = normalizeLineBreaks(v, isLongText(f.maxLength))
      continue
    }
    if (f.type !== 'list') continue
    const items = new Map((f.items ?? []).map((i) => [i.name, i] as const))
    if (Array.isArray(v)) {
      for (const row of v) normalizeRowLineBreaks(row, items)
      continue
    }
    if (typeof v !== 'string') continue
    const parsed = parseListCached(v, ctx)
    if (!('rows' in parsed)) continue
    for (const row of parsed.rows) normalizeRowLineBreaks(row, items)
    const text = JSON.stringify(parsed.rows)
    values[f.name] = text
    // The re-serialization of a clean parse is the same rows, so the
    // validator reads them without parsing the text a second time.
    ctx.lists.set(text, parsed)
  }
}

/** `normalizeSnapshotValues` over an extraction's top-level and period values. */
function normalizeSnapshot(category: AdapterCategory, snapshot: unknown, ctx: Context): void {
  if (!isPlainObject(snapshot)) return
  const fields = categorySchemaOf(category).fields
  normalizeSnapshotValues(fields, snapshot.values, ctx)
  if (Array.isArray(snapshot.periods)) for (const p of snapshot.periods) if (isPlainObject(p)) normalizeSnapshotValues(fields, p.values, ctx)
}

export type PreparedExtraction<T> =
  | { ok: true; snapshot: T; violations: [] }
  | { ok: false; violations: Violation[] }

/**
 * Snapshot, then validate the snapshot. The ONE entry point a writer calls,
 * and the only validator that returns what it judged: persist `snapshot`
 * only when `ok`.
 */
export function prepareExtractionForWrite<T extends ValidatableExtraction>(
  category: AdapterCategory,
  extraction: T,
  opts: ValidationOptions = {},
): PreparedExtraction<T> {
  const snap = normalizeForWrite(extraction)
  if (!snap.ok) return { ok: false, violations: snap.violations }
  const snapshot = snap.snapshot as T
  const ctx = contextOf(opts)
  normalizeSnapshot(category, snapshot, ctx)
  const violations = extractionViolations(category, snapshot, ctx)
  return violations.length === 0 ? { ok: true, snapshot, violations: [] } : { ok: false, violations }
}
