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
 * as absent, never as "".
 */

import {
  categorySchemaOf,
  STRING_MAX_LENGTH_DEFAULT,
  LIST_MAX_ITEMS_DEFAULT,
  type AdapterCategory,
  type CanonicalFieldSpec,
  type ListItemSpec,
} from './adapter-categories.js'
import { isJurisdiction } from './jurisdiction.js'
import { isAllowedCurrency } from './currency.js'

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
}

// ── Text rules ─────────────────────────────────────────────────────────

/**
 * Characters that are not text anyone printed. Refused in EVERY string:
 *   - format characters (\p{Cf}): zero-width space / joiners, LRM / RLM / ALM,
 *     soft hyphen, BOM, word joiner, invisible operators, bidi embeddings /
 *     overrides / isolates, interlinear annotation, tag characters;
 *   - private use (\p{Co}) and unassigned code points (\p{Cn}, which includes
 *     every noncharacter: U+FFFE/FFFF, U+FDD0–FDEF);
 *   - the fillers that Unicode classes as letters or symbols but render as
 *     nothing: Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and the braille
 *     blank U+2800.
 * ZWJ / ZWNJ are refused too, including inside a word: the data this guards is
 * Malay, English, Chinese, Thai and Vietnamese, none of which needs them, and
 * "a joiner is fine here" is exactly the judgement a denylist cannot make.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u115f\u1160\u3164\uffa0\u2800]/u

/**
 * Control characters (\p{Cc}: C0, DEL, C1) and the line / paragraph
 * separators. Tab and newline are allowed only in LONG TEXT (maxLength above
 * the 256 default: addresses and remarks that wrap); a carriage return never —
 * a writer normalizes line endings to "\n".
 */
const CONTROL_ANYWHERE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u
const CONTROL_SHORT = /[\t\n]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
/** More than four combining marks on one base: never language, only rendering abuse ("zalgo"). */
const COMBINING_OVERFLOW = /\p{M}{5,}/u
/** A value is blank when nothing in it is a letter, number, punctuation or symbol. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u

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
 *   - Any string whose first visible character is "{" is refused.
 *   - A SHORT string (maxLength ≤ 256) whose first visible character is "[" is
 *     refused.
 *   - LONG TEXT may open with a bracketed tag ("[CANCELLED] …", "[REDACTED] …")
 *     — and nothing that looks like a sequence: "[" is refused when what
 *     follows (after spaces) is "[", "{", a quote, "]", or a number, or when
 *     the bracket is never closed. So "[1] Case withdrawn" is refused as well;
 *     a writer that needs it writes "(1) …" or "No. 1 …".
 *
 * Structure NOT at the start ("Name: [{…}]") is not detected; that belongs to
 * the per-field format rules where a format is provable.
 */
const LONG_TEXT_SEQUENCE = /^\[\s*(?:[[{"'‘“\]]|[-+]?\d)/u
function isSerializedStructure(value: string, longText: boolean): boolean {
  const t = value.trimStart()
  if (t[0] === '{') return true
  if (t[0] !== '[') return false
  if (!longText) return true
  return LONG_TEXT_SEQUENCE.test(t) || !t.includes(']')
}

interface StringRules {
  maxLength?: number
  pattern?: string
  jurisdictionPatterns?: Readonly<Partial<Record<string, string>>>
  format?: 'date' | 'year'
}

/** The text rules every string is held to — field, list item and instance key alike. */
function textViolation(value: string, longText: boolean): ViolationRule | null {
  if (LONE_SURROGATE.test(value)) return 'malformed-text'
  if (INVISIBLE.test(value)) return 'invisible-characters'
  if (CONTROL_ANYWHERE.test(value)) return 'control-characters'
  if (!longText && CONTROL_SHORT.test(value)) return 'control-characters'
  if (COMBINING_OVERFLOW.test(value)) return 'excessive-combining-marks'
  if (!VISIBLE.test(value)) return 'blank-string'
  return null
}

/** Every rule a string value is held to, in order; the first failure is the one reported. */
function stringViolation(value: string, rules: StringRules, opts: ValidationOptions): ViolationRule | null {
  const maxLength = rules.maxLength ?? STRING_MAX_LENGTH_DEFAULT
  const longText = maxLength > STRING_MAX_LENGTH_DEFAULT
  const text = textViolation(value, longText)
  if (text) return text
  if (value.length > maxLength) return 'max-length'
  if (isSerializedStructure(value, longText)) return 'serialized-structure'
  if (rules.format !== undefined && !isCalendarValue(value, rules.format)) return 'invalid-date'
  if (rules.pattern !== undefined && !fullMatch(rules.pattern).test(value)) return 'pattern-mismatch'
  const j = opts.jurisdiction
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

interface NumberRules {
  unit?: string
  range?: readonly [number, number]
}

/**
 * A number's domain:
 *   - a finite number, never text;
 *   - `unit: "count"`, and `unit: "score"` WITHOUT a declared range, are
 *     non-negative safe integers (a score with a range, like the 0..1
 *     geolocation scores, is held to its range instead);
 *   - every other number has magnitude at most NUMBER_MAX_MAGNITUDE;
 *   - a declared `range` is enforced, inclusive.
 */
function numberViolation(value: unknown, rules: NumberRules = {}): ViolationRule | null {
  if (typeof value !== 'number') return 'type-mismatch'
  if (!Number.isFinite(value)) return 'non-finite-number'
  const integral = rules.unit === 'count' || (rules.unit === 'score' && rules.range === undefined)
  if (integral) {
    if (!Number.isSafeInteger(value)) return 'not-an-integer'
    if (value < 0) return 'out-of-range'
  } else if (Math.abs(value) > NUMBER_MAX_MAGNITUDE) {
    return 'unsafe-magnitude'
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
 * A list value as its rows, or why it is not one. A list is an array, or a
 * JSON string of an array (the stored form).
 */
export function parseListValue(value: unknown): { rows: unknown[] } | { rule: 'type-mismatch' | 'list-not-array' } {
  if (Array.isArray(value)) return { rows: value }
  if (typeof value !== 'string') return { rule: 'type-mismatch' }
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? { rows: parsed } : { rule: 'list-not-array' }
  } catch {
    return { rule: 'list-not-array' }
  }
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

function listViolations(spec: CanonicalFieldSpec, value: unknown, opts: ValidationOptions): Violation[] {
  const field = spec.name
  const parsed = parseListValue(value)
  if ('rule' in parsed) return [{ field, rule: parsed.rule }]
  const out: Violation[] = []
  if (parsed.rows.length > (spec.maxItems ?? LIST_MAX_ITEMS_DEFAULT)) out.push({ field, rule: 'max-items' })
  const items = spec.items ?? []
  parsed.rows.forEach((row, item) => {
    if (!isPlainObject(row)) {
      out.push({ field, item, rule: 'list-item-not-object' })
      return
    }
    const { values, undeclared, duplicated } = matchListRow(row, items)
    if (undeclared) out.push({ field, item, rule: 'undeclared-item-key' })
    for (const key of duplicated) out.push({ field, item, key, rule: 'duplicate-item-key' })
    for (const it of items) {
      const v = values.get(it.name)
      if (v === null || v === undefined) continue
      const rule = it.type === 'number'
        ? numberViolation(v)
        : typeof v === 'string'
          ? stringViolation(v, it, opts)
          : 'type-mismatch'
      if (rule) out.push({ field, item, key: it.name, rule })
    }
  })
  return out
}

// ── Fields ────────────────────────────────────────────────────────────

/**
 * Every violation of one value against its field spec. `null` / `undefined`
 * is absent and has none.
 */
export function validateFieldValue(spec: CanonicalFieldSpec, value: unknown, opts: ValidationOptions = {}): Violation[] {
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
      return listViolations(spec, value, opts)
    case 'string': {
      if (typeof value !== 'string') return [{ field, rule: 'type-mismatch' }]
      const rule = stringViolation(value, spec, opts)
      if (rule) return [{ field, rule }]
      if (spec.kind === 'currency' && !isAllowedCurrency(value)) return [{ field, rule: 'currency-not-allowed' }]
      if (spec.kind === 'enum' && opts.enumMembership !== 'skip') {
        const labels = opts.enumValues?.[field]
        if (!labels) return [{ field, rule: 'enum-labels-missing' }]
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

function fieldViolations(specs: Map<string, CanonicalFieldSpec>, fields: unknown, opts: ValidationOptions): Violation[] {
  if (!isPlainObject(fields)) return [{ field: '(values)', envelope: true, rule: 'type-mismatch' }]
  const out: Violation[] = []
  const valid = new Set<string>()
  for (const [name, value] of Object.entries(fields)) {
    const spec = specs.get(name)
    if (!spec) {
      out.push({ field: '(unknown)', rule: 'unknown-field' })
      continue
    }
    const v = validateFieldValue(spec, value, opts)
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
 * Validate a category's field values — the contract a writer enforces before
 * persisting. `ok` is true exactly when there are no violations.
 */
export function validateCanonicalFields(
  category: AdapterCategory,
  fields: Record<string, unknown>,
  opts: ValidationOptions = {},
): ValidationResult {
  const violations = fieldViolations(fieldsOf(category), fields, opts)
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
 * characters, no leading structure), with no leading or trailing whitespace.
 * `''` is allowed — the single-cardinality convention (canonical-view.ts).
 */
export function isValidInstanceKey(key: unknown): key is string {
  if (typeof key !== 'string') return false
  if (key === '') return true
  if (key.length > INSTANCE_KEY_MAX_LENGTH || key !== key.trim()) return false
  return textViolation(key, false) === null && !isSerializedStructure(key, false)
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

export function validateAdapterExtraction(
  category: AdapterCategory,
  extraction: ValidatableExtraction,
  opts: ValidationOptions = {},
): ValidationResult {
  const specs = fieldsOf(category)
  const out: Violation[] = []
  if (!isPlainObject(extraction)) {
    return { ok: false, violations: [{ field: '(envelope)', envelope: true, rule: 'type-mismatch' }] }
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

  out.push(...fieldViolations(specs, extraction.values, opts))
  out.push(...confidenceViolations(specs, extraction.confidence))

  const periods = extraction.periods
  if (periods !== undefined) {
    if (!Array.isArray(periods)) {
      out.push({ field: 'periods', envelope: true, rule: 'invalid-period' })
    } else {
      const seen = new Set<number>()
      const maxPeriods = categorySchemaOf(category).maxPeriods ?? PERIOD_POSITION_CEILING
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
          if (d !== undefined && (typeof d !== 'string' || !isCalendarDate(d))) {
            out.push({ field: edge, period, envelope: true, rule: 'invalid-period' })
            edgesValid = false
          }
        }
        if (edgesValid && typeof p.start === 'string' && typeof p.end === 'string' && p.start > p.end) {
          out.push({ field: 'start', period, envelope: true, rule: 'date-order' })
        }
        for (const v of fieldViolations(specs, p.values, opts)) out.push({ ...v, period })
        out.push(...confidenceViolations(specs, p.confidence, period))
      })
    }
  }
  return { ok: out.length === 0, violations: out }
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

/** The plain-data JSON round-trip of `input`, or `not-plain-data`. See the writer contract above. */
export function normalizeForWrite<T>(input: T): SnapshotResult<T> {
  if (!isPlainData(input, new Set(), 0)) {
    return { ok: false, violations: [{ field: '(input)', envelope: true, rule: 'not-plain-data' }] }
  }
  return { ok: true, snapshot: JSON.parse(JSON.stringify(input)) as T }
}

export type PreparedExtraction<T> =
  | { ok: true; snapshot: T; violations: [] }
  | { ok: false; violations: Violation[] }

/**
 * Snapshot, then validate the snapshot. The ONE entry point a writer calls;
 * persist `snapshot` only when `ok`.
 */
export function prepareExtractionForWrite<T extends ValidatableExtraction>(
  category: AdapterCategory,
  extraction: T,
  opts: ValidationOptions = {},
): PreparedExtraction<T> {
  const snap = normalizeForWrite(extraction)
  if (!snap.ok) return { ok: false, violations: snap.violations }
  const r = validateAdapterExtraction(category, snap.snapshot, opts)
  return r.ok ? { ok: true, snapshot: snap.snapshot, violations: [] } : { ok: false, violations: r.violations }
}
