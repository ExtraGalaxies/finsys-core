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
 * Control characters. Refused in EVERY string: C0 except tab and newline,
 * carriage return, DEL, C1, the bidi embeddings / overrides / isolates
 * (U+202A–202E, U+2066–2069: text that renders in a different order than it
 * is stored), and the line / paragraph separators. Tab and newline are allowed
 * only in LONG TEXT — a field or item whose maxLength exceeds the 256 default
 * (addresses and remarks that wrap). A carriage return is refused everywhere:
 * a writer normalizes line endings to "\n".
 */
const CONTROL_ANYWHERE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]', 'u')
const CONTROL_SHORT = new RegExp('[\\u0009\\u000a]')
const LONE_SURROGATE = new RegExp('[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]')

const patternCache = new Map<string, RegExp>()
function fullMatch(source: string): RegExp {
  let re = patternCache.get(source)
  if (!re) {
    re = new RegExp(`^(?:${source})$`, 'u')
    patternCache.set(source, re)
  }
  return re
}

/** A string that is really a serialized array or object. */
function isSerializedStructure(value: string): boolean {
  const t = value.trim()
  if (t[0] !== '[' && t[0] !== '{') return false
  try {
    // Text opening with "[" or "{" that parses is, by JSON's grammar, an array or object.
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

interface StringRules {
  maxLength?: number
  pattern?: string
  jurisdictionPatterns?: Readonly<Partial<Record<string, string>>>
}

/** Every rule a string value is held to, in order; the first failure is the one reported. */
function stringViolation(value: string, rules: StringRules, opts: ValidationOptions): ViolationRule | null {
  if (value.trim() === '') return 'blank-string'
  if (LONE_SURROGATE.test(value)) return 'malformed-text'
  const maxLength = rules.maxLength ?? STRING_MAX_LENGTH_DEFAULT
  if (CONTROL_ANYWHERE.test(value)) return 'control-characters'
  if (maxLength <= STRING_MAX_LENGTH_DEFAULT && CONTROL_SHORT.test(value)) return 'control-characters'
  if (value.length > maxLength) return 'max-length'
  if (isSerializedStructure(value)) return 'serialized-structure'
  if (rules.pattern !== undefined && !fullMatch(rules.pattern).test(value)) return 'pattern-mismatch'
  const j = opts.jurisdiction
  if (isJurisdiction(j)) {
    const source = rules.jurisdictionPatterns?.[j]
    if (source !== undefined && !fullMatch(source).test(value)) return 'pattern-mismatch'
  }
  return null
}

function numberViolation(value: unknown): ViolationRule | null {
  if (typeof value !== 'number') return 'type-mismatch'
  return Number.isFinite(value) ? null : 'non-finite-number'
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
      const rule = numberViolation(value)
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
  for (const [name, value] of Object.entries(fields)) {
    const spec = specs.get(name)
    if (!spec) {
      out.push({ field: '(unknown)', rule: 'unknown-field' })
      continue
    }
    out.push(...validateFieldValue(spec, value, opts))
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
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/
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
  const key = extraction.instanceKey
  if (
    typeof key !== 'string' ||
    key.length > INSTANCE_KEY_MAX_LENGTH ||
    CONTROL_ANYWHERE.test(key) ||
    CONTROL_SHORT.test(key) ||
    LONE_SURROGATE.test(key) ||
    isSerializedStructure(key)
  ) {
    out.push({ field: 'instanceKey', envelope: true, rule: 'invalid-instance-key' })
  }

  const observed = extraction.observedAt
  if (observed !== undefined && (typeof observed !== 'string' || !ISO_DATE_TIME.test(observed) || !Number.isFinite(Date.parse(observed)))) {
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
      periods.forEach((p, period) => {
        if (!isPlainObject(p)) {
          out.push({ field: 'periods', period, envelope: true, rule: 'invalid-period' })
          return
        }
        for (const k of Object.keys(p)) {
          if (!PERIOD_KEYS.has(k)) out.push({ field: '(envelope)', period, envelope: true, rule: 'unknown-field' })
        }
        const position = p.position
        if (typeof position !== 'number' || !Number.isInteger(position) || position < 1) {
          out.push({ field: 'position', period, envelope: true, rule: 'invalid-period' })
        } else if (seen.has(position)) {
          out.push({ field: 'position', period, envelope: true, rule: 'duplicate-period' })
        } else {
          seen.add(position)
        }
        for (const edge of ['start', 'end'] as const) {
          const d = p[edge]
          if (d !== undefined && (typeof d !== 'string' || !ISO_DATE.test(d) || !Number.isFinite(Date.parse(d)))) {
            out.push({ field: edge, period, envelope: true, rule: 'invalid-period' })
          }
        }
        for (const v of fieldViolations(specs, p.values, opts)) out.push({ ...v, period })
        out.push(...confidenceViolations(specs, p.confidence, period))
      })
    }
  }
  return { ok: out.length === 0, violations: out }
}
