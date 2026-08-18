/*
 * IHS data processing functions.
 *
 * Pure data transformations for extracting structured detail and
 * file-field table data from raw IHS API responses. Used by both
 * finsys-client and finhub-adonisjs.
 */

import type { FieldData } from './survey-generator.js'
import {
  IhsValueFormat,
  FileFieldTableType,
} from './ihs-types.js'
import type {
  IhsFieldDetail,
  IhsDetailCategory,
  FileFieldTableData,
  FileFieldTableItem,
  IhsFieldProvenance,
  DocumentRow,
  DocumentFileMetadata,
  InstanceRow,
} from './ihs-types.js'
import { getBaseFieldSpecs, getBaseCategories, getBaseFieldSpecMap } from './catalogs.js'
import { getDocumentTypeGroups } from './document-types.js'
import { allCategories, assertAdapterCategory, type AdapterCategory } from './adapter-categories.js'
import { v1Addresses, v1KeyForAddress, v1AddressHasKeyedEntries, v1MigrationKeys } from './v1-migration-map.js'
import type { CanonicalView, CanonicalInstance } from './canonical-view.js'
import type { TaggedFieldData } from './document-types.js'
import displayNamesData from './data/form-field-display-names.json' with { type: 'json' }
import { resolveDisplayCurrency } from './jurisdiction.js'

// ── Display names ──────────────────────────────────────────────

const displayNames: Record<string, string> = displayNamesData as Record<string, string>

/** Returns the full display name registry (extraction column → human label). */
export function getDisplayNames(): Record<string, string> {
  return displayNames
}

/** Looks up a display name. Falls back to camelCase → Title Case conversion. */
export function getDisplayName(fieldName: string): string {
  if (displayNames[fieldName]) return displayNames[fieldName]
  return fieldName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

// ── Time-period utilities ──────────────────────────────────────

const TIME_PERIOD_REGEX = /T(\d+)$/

export function extractTimePeriods(columnNames: string[]): string[] {
  const periods = new Set<string>()
  for (const col of columnNames) {
    const match = TIME_PERIOD_REGEX.exec(col)
    if (match) periods.add(`T${match[1]}`)
  }
  return [...periods].sort((a, b) => {
    const numA = parseInt(a.slice(1), 10)
    const numB = parseInt(b.slice(1), 10)
    return numA - numB
  })
}

export function groupColumnsByTimePeriod(
  columnNames: string[]
): Record<string, Record<string, string>> {
  const groups: Record<string, Record<string, string>> = {}
  for (const col of columnNames) {
    const match = /^(.+?)(T\d+)$/.exec(col)
    if (!match) continue
    const [, baseName, period] = match
    if (!groups[baseName]) groups[baseName] = {}
    groups[baseName][period] = col
  }
  return groups
}

// ── Field grouping ─────────────────────────────────────────────

/**
 * Groups fields by their catalog-declared document_group (falling back to
 * the field's own name for anything untagged). Was a hardcoded, closed
 * prefix-matching table (FIELD_GROUP_PREFIXES) requiring a code edit for
 * every new document type; now reads the same document_group tag the
 * catalog already carries for document-types.ts, so adding a document
 * type is a catalog-only data change.
 */
export function groupFieldsByPattern(fields: FieldData[]): Record<string, FieldData[]> {
  const groups: Record<string, FieldData[]> = {}
  for (const field of fields) {
    if (!field.name) continue
    const groupName = (field as TaggedFieldData).document_group ?? field.name
    if (!groups[groupName]) groups[groupName] = []
    groups[groupName].push(field)
  }
  return groups
}

/**
 * Human-friendly display names for field groups (when a group combines
 * multiple fields), derived from document-types.ts's catalog-backed
 * registry instead of a hardcoded map.
 */
let cachedGroupDisplayNames: Record<string, string> | null = null

export function getGroupDisplayNames(): Record<string, string> {
  if (!cachedGroupDisplayNames) {
    const names: Record<string, string> = {}
    for (const group of getDocumentTypeGroups()) {
      names[group.documentGroup] = group.label
    }
    cachedGroupDisplayNames = names
  }
  return cachedGroupDisplayNames
}

// ── File-field table building ──────────────────────────────────

/**
 * SYS-3249: the set of canonical field names declared `kind: "money"`.
 *
 * `isNumericField` below is a 17-word substring match over the flat column
 * name, and it misses 51 of the 143 money fields — every `payslip*` amount,
 * `shareCapital`, `retainedEarnings`, every `*Payables`/`*Borrowings`
 * liability, all four `depreciation*`, `ebitda`, `zakat`, `ssmPaidUpCapital`.
 * Those simply never reached the numeric branch, so before this they merely
 * lost thousands separators.
 *
 * Once a value carries a denomination that stops being cosmetic: the
 * formatter would render `₫2,000,000` for a payslip's variable income (which
 * matches "income") beside a bare `15000000` for its gross pay (which matches
 * nothing) — in the same table, from the same document, in the same currency.
 * A bare number that looks authoritative is exactly what the currency exists
 * to prevent, so a partial rendering is worse than none.
 *
 * The category registry is the authority on what is money, so ask it rather
 * than extending the word list — a word list would drift from the vocabulary
 * the moment a category is added. No import cycle: adapter-categories.ts
 * imports nothing but its own JSON.
 */
let cachedMonetaryFieldNames: Set<string> | null = null
function isMonetaryField(fieldName: string): boolean {
  if (!cachedMonetaryFieldNames) {
    // SYS-3333: BOTH spellings, and the legacy half is not optional.
    //
    // This function is handed a FLAT column name and matches it against
    // CANONICAL names — which worked only while the two vocabularies were
    // identical. The moment `payslipGrossPay` became `grossPay` canonically
    // while the flat column kept its own name, the lookup missed and the
    // value rendered as a bare number beside its denominated neighbours. No
    // exception, no log line: exactly the silent degrade SYS-3249's
    // denomination work exists to prevent, reintroduced by a rename.
    //
    // The legacy half is read off each field's own `legacyName`, so it cannot
    // drift from the rename that created it, and it disappears with the flat
    // columns at Phase 6.
    cachedMonetaryFieldNames = new Set(
      allCategories().flatMap((c) =>
        c.fields
          .filter((f) => f.kind === 'money')
          .flatMap((f) => (f.legacyName ? [f.name, f.legacyName] : [f.name]))
      )
    )
  }
  return cachedMonetaryFieldNames.has(fieldName)
}

function isNumericField(fieldName: string): boolean {
  const patterns = [
    'balance',
    'amount',
    'credit',
    'debit',
    'total',
    'revenue',
    'cost',
    'income',
    'expense',
    'liability',
    'asset',
    'equity',
    'profit',
    'loss',
    'cash',
    'tax',
    'interest',
  ]
  const lower = fieldName.toLowerCase()
  return patterns.some((p) => lower.includes(p))
}

/**
 * SYS-3249: `currency` is the ISO 4217 denomination of THIS value, read
 * from its provenance envelope — never from the field definition, and
 * never from a program-level default. It is optional, and absent means
 * "unknown", not "MYR": every pre-SYS-3249 row is absent, and defaulting
 * would render a VND amount as if it were ringgit, which is the exact
 * failure this carries a denomination to prevent.
 *
 * The two-fraction-digit default below is therefore kept ONLY for the
 * unknown case, where it preserves existing behaviour. When a currency IS
 * known the fraction digits come from the currency itself — VND is
 * zero-decimal, so 14,004,792,678,863 renders whole rather than gaining
 * two decimals that do not exist in the currency.
 *
 * The locale stays 'en-US' for now and governs only grouping/ordering,
 * not the decimal count. It becomes jurisdiction-driven under SYS-3258.
 */
/**
 * SYS-3249: grouping, but NO invented decimals.
 *
 * This previously forced `minimumFractionDigits: 2` on everything that
 * reached the numeric branch. That is a claim about precision, and it is
 * wrong in two directions:
 *
 *  - Not every number here is money. `cashConversionCycleDays` rendered as
 *    "45.00" days and `totalShareIssued` as "1,000,000.00" shares.
 *  - Not every currency has two decimal places. VND and JPY have none, so a
 *    money value whose currency we do NOT know is exactly the value we have
 *    no basis to render with two decimals — and every row written before
 *    this change has no recorded currency.
 *
 * So the unknown case now groups and preserves what the value actually has,
 * rather than asserting a precision nobody supplied. Where the currency IS
 * known the formatter above is used instead, and the currency decides — which
 * is the only place that decision legitimately comes from.
 */
const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

/**
 * Formatters are cached because a 122-field financial statement across six
 * periods constructs ~730 of them per render, server-side on the IHS detail
 * path. Measured: ~22.5ms per 1000 construct+format vs ~0.2ms cached.
 * `null` caches a code Intl rejects, so a bad value costs one throw, not one
 * per cell.
 */
const currencyFormatters = new Map<string, Intl.NumberFormat | null>()
function currencyFormatter(code: string): Intl.NumberFormat | null {
  const cached = currencyFormatters.get(code)
  if (cached !== undefined) return cached
  let fmt: Intl.NumberFormat | null = null
  try {
    // `currencyDisplay: 'code'` rather than the default symbol, deliberately.
    // Under en-US, USD renders as "$" while MYR/VND/THB/SGD render as codes —
    // so the ONE currency that gets a bare glyph is the one whose glyph four
    // other currencies also use. On a credit-bureau artifact read across
    // jurisdictions that is the worst possible default. 'code' also makes the
    // success and degraded paths agree on placement.
    fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'code' })
  } catch {
    fmt = null
  }
  currencyFormatters.set(code, fmt)
  return fmt
}

/**
 * SYS-3284/SYS-3285: the ONE money formatter the apps render through.
 *
 * FinHub and finsys-client each had their own. FinHub's hardcoded
 * `Intl.NumberFormat('en-MY', { currency: 'MYR' })` in the IHS views, so a
 * Vietnamese application's amounts read as ringgit. finsys-client had five
 * separate no-currency implementations plus two copy-pasted `myr()` helpers
 * that stamped "RM" unconditionally — including into the text fed to the AI
 * analyst, so the model reasoned about a Vietnamese company in ringgit.
 *
 * Both were reinventing something this package already did correctly for the
 * IHS detail path: a cached formatter using `currencyDisplay: 'code'`, which
 * matters more than it sounds — under en-US, USD renders as "$" while
 * MYR/VND/THB all render as codes, so symbol display gives a bare glyph to
 * the one currency whose glyph four others also use.
 *
 * Currency precedence is `resolveDisplayCurrency`'s: the value's own recorded
 * currency wins, then the jurisdiction's display default, then nothing — and
 * "nothing" prints a grouped number with no denomination, which is honest
 * rather than a guess.
 */
export function formatMoney(
  value: unknown,
  opts: {
    currency?: string | null
    /**
     * REQUIRED, and deliberately not optional.
     *
     * `formatMoney(v, {})` used to return MYR — indistinguishable from
     * `formatMoney(v, { jurisdiction: null })`, which is a different claim.
     * `null` means "a record said nothing, and the platform rule is
     * Malaysia"; an absent argument means "I was never told", and answering
     * that with a confident MYR is the exact bug these helpers replace.
     *
     * Making the key required does not make the caller think harder — it
     * makes the careless call fail to compile. Pass `NO_JURISDICTION_BASIS`
     * when there is genuinely no basis; the result then carries no currency.
     */
    jurisdiction: string | null
  }
): string {
  return formatValue(value, true, resolveDisplayCurrency(opts.currency, opts.jurisdiction))
}

function formatValue(value: unknown, numeric: boolean, currency?: string): string {
  if (value === null || value === undefined || value === '') return '-'
  if (numeric) {
    const num = Number(value)
    if (!isNaN(num)) {
      if (currency) {
        // Normalised before use: extraction output is exactly where stray
        // whitespace and lowercase come from, and Intl rejects " myr " while
        // accepting "MYR". Recovering those is free; leaving them to the
        // degraded path renders a correct value as though it were suspect.
        const code = currency.trim().toUpperCase()
        const fmt = code ? currencyFormatter(code) : null
        if (fmt) return fmt.format(num)
        // Intl does not know this code. Degrade VISIBLY rather than either
        // crashing the whole detail render for one bad field, or dropping the
        // code and presenting a bare number that looks authoritative. Code
        // first, matching the success path.
        return `${code || currency} ${PLAIN_NUMBER_FORMAT.format(num)}`
      }
      return PLAIN_NUMBER_FORMAT.format(num)
    }
  }
  return String(value)
}

function buildTableForGroup(
  groupName: string,
  fields: FieldData[],
  ihsData: Record<string, unknown>,
  fieldProvenance?: Record<string, IhsFieldProvenance>
): FileFieldTableData | null {
  const allColumns: string[] = []
  for (const field of fields) {
    if (field.ihs_column_names) {
      allColumns.push(...field.ihs_column_names)
    }
  }
  if (allColumns.length === 0) return null

  const periods = extractTimePeriods(allColumns)
  const isTimeSeries = periods.length > 0
  const tableType = isTimeSeries ? FileFieldTableType.TIME_SERIES : FileFieldTableType.KEY_VALUE
  const groupDisplayName =
    getGroupDisplayNames()[groupName] || fields[0]?.displayName || getDisplayName(groupName)

  if (isTimeSeries) {
    const columnGroups = groupColumnsByTimePeriod(allColumns)
    const items: FileFieldTableItem[] = []

    for (const [baseName, periodMap] of Object.entries(columnGroups)) {
      const numeric = isNumericField(baseName) || isMonetaryField(baseName)
      const data: Record<string, unknown> = {}
      const formattedData: Record<string, string> = {}
      const confidence: Record<string, number> = {}
      const provenance: Record<string, IhsFieldProvenance> = {}

      for (const period of periods) {
        const colName = periodMap[period]
        const value = colName ? (ihsData[colName] ?? null) : null
        data[period] = value
        // SYS-2741: colName is the exact ihs_field_metadata key (incl. T{n} suffix).
        // SYS-3249: resolved BEFORE formatting — the envelope carries this
        // value's currency, so the formatter needs it in hand.
        const prov = colName ? fieldProvenance?.[colName] : undefined
        formattedData[period] = formatValue(value, numeric, prov?.currency)
        if (prov) {
          provenance[period] = prov
          if (
            prov.origin === 'extracted' &&
            typeof prov.confidence === 'number' &&
            !Number.isNaN(prov.confidence)
          ) {
            confidence[period] = prov.confidence
          }
        }
      }

      items.push({
        displayName: getDisplayName(baseName),
        timePeriods: periods,
        data,
        formattedData,
        type: tableType,
        isNumeric: numeric,
        ...(Object.keys(confidence).length ? { confidence } : {}),
        ...(Object.keys(provenance).length ? { provenance } : {}),
      })
    }

    const hasData = items.some((item) =>
      Object.values(item.data).some((v) => v !== null && v !== undefined && v !== '')
    )
    return { name: groupName, displayName: groupDisplayName, type: tableType, items, hasData }
  } else {
    const items: FileFieldTableItem[] = []
    for (const colName of allColumns) {
      const value = ihsData[colName] ?? null
      const numeric = isNumericField(colName) || isMonetaryField(colName)
      // SYS-2741: single-doc columns (ssmCompanyName, companyName, icName, …) are
      // keyed directly in ihs_field_metadata — lit up here (the value-match interim
      // had to skip these because filename-based OCR lookup was unreliable).
      const prov = fieldProvenance?.[colName]
      items.push({
        displayName: getDisplayName(colName),
        timePeriods: [],
        data: { value },
        formattedData: { value: formatValue(value, numeric, prov?.currency) },
        type: tableType,
        isNumeric: numeric,
        ...(prov &&
        prov.origin === 'extracted' &&
        typeof prov.confidence === 'number' &&
        !Number.isNaN(prov.confidence)
          ? { confidence: { value: prov.confidence } }
          : {}),
        ...(prov ? { provenance: { value: prov } } : {}),
      })
    }
    const hasData = items.some((item) => {
      const v = item.data['value']
      return v !== null && v !== undefined && v !== ''
    })
    return { name: groupName, displayName: groupDisplayName, type: tableType, items, hasData }
  }
}

export function buildFileFieldTables(
  ihsData: Record<string, unknown>,
  fieldProvenance?: Record<string, IhsFieldProvenance>
): Record<string, FileFieldTableData> {
  const specs = getBaseFieldSpecs()
  const fileFields = specs.filter((f) => f.type === 'file' && f.ihs_column_names?.length)
  const grouped = groupFieldsByPattern(fileFields)

  const tables: Record<string, FileFieldTableData> = {}
  for (const [groupName, fields] of Object.entries(grouped)) {
    const table = buildTableForGroup(groupName, fields, ihsData, fieldProvenance)
    if (table && table.hasData) {
      tables[groupName] = table
    }
  }
  return tables
}

// ── Instance-based field grouping (SYS-2886 / Phase 5) ──────────
//
// The catalog's T{n}-suffixed columns (bankBalanceT1..T6) declare a FIXED
// cardinality per category -- at most 6 bank statements, 3 financial-year
// slots, etc (buildFileFieldTables/groupColumnsByTimePeriod above are
// bound to that fixed declaration). groupColumnsByInstance is the
// unbounded counterpart: it takes the RAW sibling-table rows finsys-api
// now exposes per category (SYS-2842's docInstanceStorageService -- one
// row per uploaded document, keyed by a real instanceKey, not a
// pre-declared T{n} slot) and groups them by base metric name, with one
// column per ROW rather than per pre-declared period.
//
// Deliberately requires NO new catalog entries: every T{n} slot for a
// given category declares the identical base column names (verified
// across bank_statement_t1..t6 and the analogous financial/epf/payslip
// entries), so the base names are derived by stripping the existing
// suffixed specs' ihs_column_names rather than duplicating them in the
// catalog. The 129 T{n}-suffixed wide-table columns and their catalog
// entries stay exactly as they are (frozen, not migrated, per the
// epic's Phase 6 scope) -- this is purely additive.

/**
 * Human label for one instance column: "Mar 2026 · Maybank" when a
 * sourceLabel is known, else the bare period/instanceKey.
 */
function instanceColumnLabel(row: InstanceRow): string {
  const period = row.timePeriod || row.instanceKey
  return row.sourceLabel ? `${period} · ${row.sourceLabel}` : period
}

/**
 * Adversarial-review finding (Phase 5): instanceColumnLabel is NOT
 * collision-free -- two distinct rows (distinct instanceKey) can share
 * the same timePeriod + sourceLabel (e.g. two same-bank, same-month
 * statements, or any row lacking sourceLabel that shares a period).
 * Since every consumer keys data/confidence/provenance BY this label
 * (matching FileFieldTableItem's existing contract, where timePeriods'
 * entries are literal object keys into `data`), an undisambiguated
 * collision doesn't just look wrong -- it silently drops one row's
 * value entirely (last-write-wins into the same object key) while
 * `timePeriods` keeps a duplicate entry pointing at the SURVIVING row's
 * value twice. Disambiguates by appending "(2)", "(3)", ... to every
 * occurrence after the first, keeping the common (non-colliding) case's
 * label exactly as before. Both groupColumnsByInstance and
 * buildInstanceTable call this SAME function on the SAME instanceRows
 * array (never the raw per-row instanceColumnLabel directly), so the
 * two independently-computed label lists always agree with each other.
 */
function instanceColumnLabels(rows: InstanceRow[]): string[] {
  const seenCounts = new Map<string, number>()
  return rows.map((row) => {
    const raw = instanceColumnLabel(row)
    const occurrence = (seenCounts.get(raw) ?? 0) + 1
    seenCounts.set(raw, occurrence)
    return occurrence === 1 ? raw : `${raw} (${occurrence})`
  })
}

/**
 * Groups instance rows by base metric name -- the unbounded analog of
 * groupColumnsByTimePeriod. `baseColumnNames` is the category's base
 * (unsuffixed) field list; each returned group maps instance column
 * label -> that metric's value on that row. Labels are disambiguated
 * (see instanceColumnLabels) so two rows can never collide into the
 * same key.
 */
export function groupColumnsByInstance(
  baseColumnNames: string[],
  instanceRows: InstanceRow[]
): Record<string, Record<string, unknown>> {
  const groups: Record<string, Record<string, unknown>> = {}
  for (const baseName of baseColumnNames) {
    groups[baseName] = {}
  }
  if (!instanceRows?.length) return groups
  const labels = instanceColumnLabels(instanceRows)
  instanceRows.forEach((row, i) => {
    const label = labels[i]
    for (const baseName of baseColumnNames) {
      if (Object.prototype.hasOwnProperty.call(row, baseName)) {
        groups[baseName][label] = row[baseName]
      }
    }
  })
  return groups
}

/**
 * Instance-based counterpart to buildFileFieldTables: builds one table
 * per category present in `instancesByCategory`, with one column per
 * instance row (unbounded) instead of one column per pre-declared T{n}
 * slot. Categories absent from `instancesByCategory` are simply skipped
 * -- callers merge this output with buildFileFieldTables' own (or use it
 * standalone once a category has fully cut over).
 *
 * Provenance stays keyed the legacy way (`${baseName}${timePeriod}`, per
 * the epic's established SYS-2842 rule that @finsys/core's exact-string
 * lookup can't change format without a coordinated release) -- so only
 * instances whose timePeriod maps onto a legacy T{n} slot carry a
 * confidence dot; instances beyond that (the very capability this
 * function exists for) simply render with no confidence, same limitation
 * buildFileFieldTables already has today for anything past T6.
 */
function buildInstanceTable(
  groupName: string,
  baseNames: string[],
  groupDisplayName: string,
  instanceRows: InstanceRow[],
  fieldProvenance?: Record<string, IhsFieldProvenance>
): FileFieldTableData | null {
  const columnGroups = groupColumnsByInstance(baseNames, instanceRows)
  const instanceLabels = instanceColumnLabels(instanceRows)

  const items: FileFieldTableItem[] = []
  for (const [baseName, labelMap] of Object.entries(columnGroups)) {
    const hasAny = Object.values(labelMap).some((v) => v !== null && v !== undefined && v !== '')
    if (!hasAny) continue

    const numeric = isNumericField(baseName) || isMonetaryField(baseName)
    const data: Record<string, unknown> = {}
    const formattedData: Record<string, string> = {}
    const confidence: Record<string, number> = {}
    const provenance: Record<string, IhsFieldProvenance> = {}

    for (const [i, row] of instanceRows.entries()) {
      const label = instanceLabels[i]
      const value = labelMap[label] ?? null
      data[label] = value

      const legacyKey = row.timePeriod ? `${baseName}${row.timePeriod}` : undefined
      // SYS-3249: hoisted above the format call — the envelope carries
      // this value's currency.
      const prov = legacyKey ? fieldProvenance?.[legacyKey] : undefined
      formattedData[label] = formatValue(value, numeric, prov?.currency)
      if (prov) {
        provenance[label] = prov
        if (
          prov.origin === 'extracted' &&
          typeof prov.confidence === 'number' &&
          !Number.isNaN(prov.confidence)
        ) {
          confidence[label] = prov.confidence
        }
      }
    }

    items.push({
      displayName: getDisplayName(baseName),
      timePeriods: instanceLabels,
      data,
      formattedData,
      type: FileFieldTableType.TIME_SERIES,
      isNumeric: numeric,
      ...(Object.keys(confidence).length ? { confidence } : {}),
      ...(Object.keys(provenance).length ? { provenance } : {}),
    })
  }

  const hasData = items.some((item) =>
    Object.values(item.data).some((v) => v !== null && v !== undefined && v !== '')
  )
  if (!items.length || !hasData) return null

  return {
    name: groupName,
    displayName: groupDisplayName,
    type: FileFieldTableType.TIME_SERIES,
    items,
    hasData,
  }
}

/**
 * Explicit base-column declaration for a category with NO catalog `file`
 * spec -- e.g. invoice (SYS-2842 Phase 3), which was deliberately never
 * registered in form-field-base-specs.json because getDocumentTypeGroups()
 * is shared with resolveExtractionStatus, which assumes a category's wide-
 * table columns exist to check "is this populated" against -- invoice has
 * none (sibling-table only, no wideTableMirror). Registering it there would
 * silently break resolveExtractionStatus's invoice status reporting. This
 * override lets a category be instance-rendered without entering that
 * shared registry at all.
 */
export interface CategorySpec {
  displayName: string
  baseColumnNames: string[]
}

export function buildFileFieldTablesFromInstances(
  instancesByCategory: Record<string, InstanceRow[]> = {},
  fieldProvenance?: Record<string, IhsFieldProvenance>,
  categoryOverrides?: Record<string, CategorySpec>
): Record<string, FileFieldTableData> {
  const specs = getBaseFieldSpecs()
  const fileFields = specs.filter((f) => f.type === 'file' && f.ihs_column_names?.length)
  const grouped = groupFieldsByPattern(fileFields)

  const tables: Record<string, FileFieldTableData> = {}

  for (const [groupName, fields] of Object.entries(grouped)) {
    const instanceRows = instancesByCategory[groupName]
    if (!instanceRows?.length) continue

    const baseNames = new Set<string>()
    for (const field of fields) {
      for (const col of field.ihs_column_names ?? []) {
        baseNames.add(col.replace(TIME_PERIOD_REGEX, ''))
      }
    }
    const groupDisplayName =
      getGroupDisplayNames()[groupName] || fields[0]?.displayName || getDisplayName(groupName)

    const table = buildInstanceTable(
      groupName, [...baseNames], groupDisplayName, instanceRows, fieldProvenance
    )
    if (table) tables[groupName] = table
  }

  for (const [groupName, spec] of Object.entries(categoryOverrides ?? {})) {
    if (Object.prototype.hasOwnProperty.call(tables, groupName)) continue // catalog-derived takes precedence
    const instanceRows = instancesByCategory[groupName]
    if (!instanceRows?.length) continue

    const table = buildInstanceTable(
      groupName, spec.baseColumnNames, spec.displayName, instanceRows, fieldProvenance
    )
    if (table) tables[groupName] = table
  }

  return tables
}

// ── Documents table (SYS-2766) ─────────────────────────────────
//
// Presentation-agnostic model of the per-document table on the IHS detail page.
// Absorbs the doc-type maps/rules FinHub used to own inline so FinHub and
// finsys-client render the SAME table. Pure transform: file metadata is attached
// upstream by finsys-api (the `documentMetadata` sibling map, SYS-2765).

/** IHS doc-field key → human label. Its keys drive which fields become sections. */
const DOC_DISPLAY_NAMES: Record<string, string> = {
  bankStatements: 'Bank Statements',
  financialStatements: 'Financial Statements',
  form9: 'Form 9',
  epfStatements: 'EPF Statements',
  payslips: 'Payslips',
  ssm: 'SSM Company Profile',
  ic: 'Identity Card',
  ssm_registration_documents: 'Form 9',
  ic_documents: 'Identity Documents (Supplementary)',
  consentForm: 'Consent Form',
  supplementaryDoc: 'Supplementary Documents',
  coreIncomeDoc: 'Core Income Document',
  incomeSupportingDoc: 'Income Supporting Document',
  incomeEPF_iakaun: 'EPF i-Akaun',
  photocopyRegistrationCard: 'Registration Card',
  bankStatementOrSavingPassbook: 'Bank Passbook',
  tnbBills: 'TNB Bills',
}

/** Doc types finsys-api can run extraction on (→ re-extract / view-JSON eligible). */
const EXTRACTABLE_DOC_TYPES = new Set<string>([
  'bankStatements',
  'financialStatements',
  'form9',
  'epfStatements',
  'payslips',
  'ssm',
  'ic',
  'ssm_registration_documents',
  'ic_documents',
])

/** Doc types that accept a replacement upload (SYS-2229 — finsys-api ignores the rest). */
const REUPLOADABLE_DOC_TYPES = new Set<string>(['bankStatements', 'financialStatements'])

/** IHS doc-field key → human label (the fields that become document sections). */
export function getDocDisplayNames(): Record<string, string> {
  return DOC_DISPLAY_NAMES
}

/** Doc types eligible for extraction (re-extract / view-JSON). */
export function getExtractableDocTypes(): Set<string> {
  return EXTRACTABLE_DOC_TYPES
}

/** Doc types eligible for a replacement upload. */
export function getReuploadableDocTypes(): Set<string> {
  return REUPLOADABLE_DOC_TYPES
}

/** Heuristic: does a string look like an opaque id (UUID / long hex), not a real name? */
function isProbablyId(str?: string | null): boolean {
  if (!str) return false
  const clean = str.split('.')[0] // ignore extension
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return true
  if (/^[0-9a-f]{32,128}$/i.test(clean)) return true
  return false
}

/**
 * One entry inside a document-pointer field.
 *
 * EXPORTED as of SYS-3174, and that is the point of exporting it. The host is
 * about to attest these entries as canonical `document-intake` rows, and the
 * alternative to naming the shape here was for it to declare a private copy —
 * which is precisely how this codebase ended up with seven hand-written,
 * mutually-disagreeing lists of "the document fields". Every property is
 * optional because every one of them is genuinely absent on some real row;
 * this describes what is STORED, not what is required.
 */
export interface ParsedDocFile {
  path?: string
  fileName?: string
  documentId?: string
  fileSize?: number | string
  fileType?: string
  createdAt?: string
  month?: number
  year?: number
  /**
   * SYS-2873: the uploader's per-file document-language choice (e.g. "vi",
   * "en"), present only for slots whose catalog entry carries
   * document_language_options. Selects the extraction endpoint upstream;
   * absent on every Malaysia upload.
   */
  documentLanguage?: string
  /**
   * SYS-3174: who uploaded this file — the acting principal, not the subject
   * the document is about.
   *
   * The one genuine gap in this shape. It had no declaration anywhere in this
   * package, while one upload route wrote it ad hoc into a single column's
   * entries — so for every other document the answer was unrecoverable rather
   * than merely missing. Declared here so the next writer finds the spelling
   * instead of inventing a second one.
   *
   * Absent on every entry written before that route existed; a consumer must
   * treat "no uploader recorded" as a real and common state, never as a
   * defect.
   */
  uploadedBy?: string
}

/**
 * Parse one IHS doc field into file entries. Handles the shapes the field takes:
 * a JSON-array string (bank/financial/…, possibly inline-enriched like
 * supplementaryDoc), an already-parsed array, or a bare URL string (ssm/form9/ic).
 */
export function parseFileField(value: unknown): ParsedDocFile[] {
  if (!value) return []
  if (Array.isArray(value)) return value as ParsedDocFile[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as ParsedDocFile[]) : []
    } catch {
      // Plain URL string (form9, ssm, ic) — wrap as a single entry.
      if (value.startsWith('http')) {
        return [{ path: value, documentId: value.split('/').pop() || undefined }]
      }
      return []
    }
  }
  return []
}

function toBytes(value: unknown): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value === 'string') {
    const n = parseInt(value, 10)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/**
 * Build the presentation-agnostic document rows for an IHS. Reads the doc fields
 * named in DOC_DISPLAY_NAMES + the `documentMetadata` sibling map (SYS-2765) and
 * emits a flat DocumentRow[] (all sections, in DOC_DISPLAY_NAMES order). Metadata
 * is taken inline off the entry first (supplementaryDoc is enriched inline), then
 * from `documentMetadata[path]`.
 */
export function buildDocumentRows(ihsData: Record<string, unknown>): DocumentRow[] {
  const metaMap = (ihsData.documentMetadata ?? {}) as Record<string, DocumentFileMetadata>
  const rows: DocumentRow[] = []

  for (const docType of Object.keys(DOC_DISPLAY_NAMES)) {
    const files = parseFileField(ihsData[docType])
    if (files.length === 0) continue

    const label = DOC_DISPLAY_NAMES[docType]
    const extractable = EXTRACTABLE_DOC_TYPES.has(docType)
    const reUploadable = extractable && REUPLOADABLE_DOC_TYPES.has(docType)

    files.forEach((file, index) => {
      const path = file.path ?? null
      const meta = path ? metaMap[path] : undefined

      const documentId = file.documentId || (path ? path.split('/').pop() || null : null)
      const timePeriod = file.month ? `T${file.month}` : file.year ? `T${file.year}` : 'ALL'

      const rawName = file.fileName ?? meta?.fileName ?? undefined
      const fileName = rawName && !isProbablyId(rawName) ? rawName : null

      const rawExt = (rawName ?? '').split('.').pop()
      const ext =
        rawExt && rawExt.length <= 5 && !isProbablyId(rawExt) ? rawExt.toUpperCase() : null
      const mime = file.fileType ?? meta?.fileType
      const fileType = ext || (mime?.split('/').pop()?.toUpperCase() ?? null)

      const fileSize = toBytes(file.fileSize) ?? meta?.fileSize ?? null
      const uploadedAt = file.createdAt ?? meta?.createdAt ?? null

      const periodLabel =
        file.month && file.year
          ? new Date(file.year, file.month - 1).toLocaleDateString('en-MY', {
              year: 'numeric',
              month: 'short',
            })
          : file.year
            ? `Year ${file.year}`
            : null

      const displayName =
        fileName ||
        (periodLabel
          ? `${label} — ${periodLabel}`
          : files.length > 1
            ? `${label} ${index + 1}`
            : label)

      rows.push({
        docType,
        label,
        index,
        displayName,
        documentId,
        path,
        timePeriod,
        periodLabel,
        fileName,
        fileType,
        fileSize,
        uploadedAt,
        capabilities: {
          download: !!documentId,
          viewJson: extractable,
          reExtract: extractable,
          reUpload: reUploadable,
        },
      })
    })
  }

  return rows
}

// ── Documents-table cell formatters (empty-state rules live here) ──
// Single source for the Type / Size / Uploaded strings so FinHub + finsys-client
// render identical cells (em-dash on unknown).

const EM_DASH = '—'

/** Type column: the resolved type label, or em-dash. */
export function formatDocumentType(row: Pick<DocumentRow, 'fileType'>): string {
  return row.fileType ?? EM_DASH
}

/** Size column: human bytes (B / KB / MB), or em-dash when unknown. */
export function formatDocumentSize(bytes: number | null | undefined): string {
  if (!bytes || Number.isNaN(bytes)) return EM_DASH
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Uploaded column: the upload date, else the period label, else em-dash. */
export function formatDocumentUploaded(
  row: Pick<DocumentRow, 'uploadedAt' | 'periodLabel'>
): string {
  if (row.uploadedAt) {
    const d = new Date(row.uploadedAt)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
    }
  }
  return row.periodLabel ?? EM_DASH
}

// ── IHS detail processing ──────────────────────────────────────

function isFileOrFinancialColumn(fieldName: string, fileColumnSet: Set<string>): boolean {
  return (
    fileColumnSet.has(fieldName) ||
    fieldName.startsWith('financials') ||
    fieldName.startsWith('bank_statement')
  )
}


/**
 * SYS-3259: money-ness is DERIVED from the registry, not listed here. A legacy
 * name resolves through the migration map to a canonical field, and the
 * registry says whether that field's `kind` is `money`. That is 471 v1 keys;
 * the hand-written set this replaces named four, so `monthlyNetIncome`,
 * `purchasePriceOTR` and every other money field rendered as a plain string.
 *
 * THE RESIDUAL, named for what it is. The ticket's premise — "Phase 2.6 makes
 * this a deletion" — held for ONE of the four names. `totalFinancing` is
 * `relocated` (the application record) and `approvedAmount` /
 * `monthlyInstallment` are not adapter fields at all; none has a registry
 * entry to derive from. They stay, as the application record's currency
 * fields, until that record carries its own field spec (SYS-3379 / SYS-3412).
 * A test pins that this set contains ONLY names the registry cannot answer.
 */
export const APPLICATION_RECORD_CURRENCY_FIELDS: ReadonlySet<string> = new Set([
  'totalFinancing',
  'approvedAmount',
  'monthlyInstallment',
])

let moneyLegacyNames: Set<string> | null = null

/** Every v1 key whose canonical destination the registry declares as money. */
export function registryMoneyLegacyNames(): ReadonlySet<string> {
  if (moneyLegacyNames) return moneyLegacyNames
  const money = new Set<string>()
  for (const cat of allCategories()) {
    for (const f of cat.fields) if (f.kind === 'money') money.add(`${cat.id}|${f.name}`)
  }
  const names = new Set<string>()
  for (const key of v1MigrationKeys()) {
    if (v1Addresses(key).some((a) => money.has(`${a.category}|${a.field}`))) names.add(key)
  }
  moneyLegacyNames = names
  return names
}

function inferValueFormat(fieldName: string, value: unknown): IhsValueFormat {
  if (APPLICATION_RECORD_CURRENCY_FIELDS.has(fieldName) || registryMoneyLegacyNames().has(fieldName)) {
    return IhsValueFormat.CURRENCY
  }

  const numberFields = new Set([
    'age',
    'noOfDependants',
    'financingTenure',
    'ihsId',
    'programId',
    'borrowerAgentId',
  ])
  if (numberFields.has(fieldName)) return IhsValueFormat.NUMBER

  const tableFields = new Set(['shareholders', 'directors', 'previousDirectors'])
  if (tableFields.has(fieldName)) return IhsValueFormat.TABLE

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return IhsValueFormat.DATE

  return IhsValueFormat.STRING
}

const EXCLUDED_FIELDS = new Set([
  'updatedAt',
  'programIds',
  'borrowerAgentId',
  'programId',
  '__v',
  '_id',
  'id',
])

export function processIhsDetails(ihsData: Record<string, unknown>): IhsFieldDetail[] {
  const specs = getBaseFieldSpecs()
  const fileColumnSet = new Set<string>()
  for (const field of specs) {
    if (field.type === 'file') {
      if (field.name) fileColumnSet.add(field.name)
      if (field.ihs_column_names) {
        for (const col of field.ihs_column_names) {
          fileColumnSet.add(col)
        }
      }
    }
  }

  const specMap = getBaseFieldSpecMap()
  const categories = getBaseCategories()
  const categoryNameMap: Record<string, string> = {}
  for (const cat of categories) {
    categoryNameMap[String(cat.id)] = cat.name
  }

  const details: IhsFieldDetail[] = []

  for (const [key, value] of Object.entries(ihsData)) {
    if (value === null || value === undefined || value === '' || value === 'Not Specified') continue
    if (value === false) continue
    if (EXCLUDED_FIELDS.has(key)) continue
    if (isFileOrFinancialColumn(key, fileColumnSet)) continue

    const spec = specMap.get(key)
    const categoryId = spec?.category ? String(spec.category) : '0'
    const category = categoryNameMap[categoryId] || 'General'

    details.push({
      name: key,
      displayName: getDisplayName(key),
      category,
      value,
      valueFormat: inferValueFormat(key, value),
    })
  }

  return details
}

export function groupDetailsByCategory(details: IhsFieldDetail[]): IhsDetailCategory[] {
  const groups: Record<string, IhsFieldDetail[]> = {}
  for (const detail of details) {
    if (!groups[detail.category]) groups[detail.category] = []
    groups[detail.category].push(detail)
  }

  return Object.entries(groups)
    .filter(([cat]) => cat !== 'Default Category' && cat !== 'General')
    .map(([category, items]) => ({
      category,
      items: items.map((d) => ({
        name: d.name,
        displayName: d.displayName,
        value: d.value,
        valueFormat: d.valueFormat,
      })),
    }))
}

// ── Instance-shaped detail processing (SYS-3334) ────────────────────

/**
 * `processIhsDetails` for a v2 `CanonicalView` — the same output type, the
 * same labels, the same groupings, so a consumer flipping from v1 to v2 sees
 * the panel it had. That parity is the point of an instance-shaped PATH rather
 * than a new panel: the flag flip on finhub is a migration, not a redesign,
 * and it can be checked against a before-picture (`groupDetailsByCategory` of
 * both, on the same subject).
 *
 * HOW PARITY IS ACHIEVED. v1 keyed everything — display name, form-spec
 * category, value format — by the LEGACY column name. This function walks the
 * view (category → instance → field) and asks the v1 migration map, in
 * reverse, which legacy key held each address. Where the map answers, the
 * detail is emitted exactly as v1 would have emitted it. Where it does not —
 * a canonical-only field the wide table never had — the detail is emitted
 * under the canonical name and, having no form spec, lands in `General`,
 * which `groupDetailsByCategory` drops. THAT TOO IS PARITY: v1's flat record
 * carried alt-data keys with no form spec (`arpu`, …), they landed in
 * `General`, and the panel never showed them. A consumer that wants those
 * reads the view directly; this function is the detail panel, not the view.
 *
 * WHAT IS EXCLUDED, AND WHY IT IS DERIVED RATHER THAN LISTED. v1 skipped the
 * file/financial columns because `buildFileFieldTables` renders them. The v2
 * equivalents are the extraction categories of every document type plus
 * `document-intake` — derived from the document-type groups through the map,
 * so a new document type excludes itself. A hand-written list here would be
 * the seventh copy of "which fields are document fields" in this estate.
 *
 * VALUE FILTER is v1's exactly (null / '' / 'Not Specified' / false skipped),
 * applied to the envelope's `value`. Provenance on the envelope is not
 * surfaced here — `IhsFieldDetail` has no slot for it, and adding one is a
 * type change every consumer would inherit; that is its own decision.
 */
export function processIhsDetailsFromView(view: CanonicalView): IhsFieldDetail[] {
  const excluded = documentCategoryIds()
  const specMap = getBaseFieldSpecMap()
  const categoryNameMap: Record<string, string> = {}
  for (const cat of getBaseCategories()) categoryNameMap[String(cat.id)] = cat.name

  const details: IhsFieldDetail[] = []

  for (const [categoryId, category] of Object.entries(view.categories)) {
    if (excluded.has(categoryId as AdapterCategory)) continue
    // Scoped per category: a name can only collide with another of the same
    // category (the reverse map is injective across categories except for a
    // fan-out key, and both fan-out categories are documents).
    const seen = new Set<string>()
    for (const instance of category.instances) {
      for (const [field, envelope] of Object.entries(instance.fields)) {
        const value = envelope.value
        if (value === null || value === undefined || value === '' || value === 'Not Specified') continue
        if (value === false) continue

        // The keyed lookup first. If it misses AND the map holds no keyed
        // entry for this (category, field) at all, the key carries no
        // discriminating power — a single-cardinality category whose adapter
        // wrote 'default' or '' — so the keyless entry is the answer. This
        // rule does not depend on `cardinality`, which the API omits when no
        // manifest is reachable for the producing adapter.
        const legacy =
          v1KeyForAddress(categoryId, field, instance.instanceKey || undefined) ??
          (v1AddressHasKeyedEntries(categoryId, field) ? null : v1KeyForAddress(categoryId, field))

        // The name a v1 consumer keyed on, when there was one. Otherwise a name
        // that cannot collide with a legacy key or with another instance's.
        let name = legacy ?? canonicalDetailName(categoryId, field, instance.instanceKey)
        let displayName = getDisplayName(legacy ?? field)
        if (seen.has(name)) {
          // Two instances of one category resolving to one name: two producers
          // writing the same key (the registry allows several vendors per
          // alt-data category). Not a reason to fail a page render, and not a
          // reason to hide one — a disagreement between producers is exactly
          // what a reviewer should see. The second keeps the same group, under
          // a name that cannot collide and a label that says whose value it is.
          name = `${canonicalDetailName(categoryId, field, instance.instanceKey)}@${instance.adapterId}`
          displayName = `${displayName} (${instance.adapterId})`
        }
        seen.add(name)

        const spec = legacy !== null ? specMap.get(legacy) : undefined
        const categoryKey = spec?.category ? String(spec.category) : '0'

        details.push({
          name,
          displayName,
          category: categoryNameMap[categoryKey] || 'General',
          value,
          valueFormat: inferValueFormat(legacy ?? field, value),
        })
      }
    }
  }
  return details
}

function canonicalDetailName(categoryId: string, field: string, instanceKey: string): string {
  return instanceKey ? `${categoryId}/${instanceKey}/${field}` : `${categoryId}/${field}`
}

let documentCategoryIdsCache: Set<AdapterCategory> | null = null

/**
 * The adapter categories that hold DOCUMENT data — every document type's
 * extraction category (via the migration map: the type's legacy T-slot columns
 * → the category they map into) plus `document-intake` (the pointers). Derived,
 * not listed. A type whose columns map into two categories throws. A type whose
 * columns map NOWHERE (the map is frozen at the v1 surface, so any document
 * type added after it) resolves to null and would NOT be excluded here — that
 * case is caught by the test that pins the seven types by name, not by this
 * function; adding a document type means deciding its extraction category
 * there.
 */
export function documentCategoryIds(): ReadonlySet<AdapterCategory> {
  if (documentCategoryIdsCache) return documentCategoryIdsCache
  const ids = new Set<AdapterCategory>([assertAdapterCategory('document-intake')])
  for (const group of getDocumentTypeGroups()) {
    const target = extractionCategoryOf(group.documentType)
    if (target) ids.add(target)
  }
  documentCategoryIdsCache = ids
  return ids
}

const extractionCategoryCache = new Map<string, AdapterCategory | null>()

/**
 * Which adapter category carries the EXTRACTED values for a document type —
 * `bankStatements` → `finxtract-bank-statement`, `ssm` → `company-profile`.
 * Read off the migration map: the type's legacy extraction columns (the form
 * spec's `ihs_column_names`) and where they went.
 *
 * INTERSECTION, NOT UNION, across the columns. A fan-out key is attested by
 * more than one category — `incorporatedDate` (SYS-2722) by company-profile
 * from the SSM document AND by company-registration from Form 9 — so a single
 * column can name two categories and still be right. The category a document
 * type EXTRACTS INTO is the one every one of its mapped columns names: for
 * Form 9 that is company-registration ({cp,cr} ∩ {cr} ∩ {cr}); for SSM it is
 * company-profile. Unmapped columns do not vote. Null when nothing is mapped.
 * Throws when the intersection is empty or has two members, because then
 * "the" extraction category does not exist and every caller would pick one
 * silently.
 */
export function extractionCategoryOf(documentType: string): AdapterCategory | null {
  if (extractionCategoryCache.has(documentType)) return extractionCategoryCache.get(documentType)!
  const group = getDocumentTypeGroups().find((g) => g.documentType === documentType)
  const votes: Array<Set<string>> = []
  for (const field of group?.fields ?? []) {
    for (const col of field.ihs_column_names ?? []) {
      const cats = new Set<string>(v1Addresses(col).map((a) => a.category))
      if (cats.size > 0) votes.push(cats)
    }
  }
  const common = votes.length === 0
    ? null
    : votes.reduce((acc, cats) => new Set<string>([...acc].filter((c) => cats.has(c))))
  if (common !== null && common.size !== 1) {
    throw new Error(
      `extractionCategoryOf(${documentType}): its mapped columns agree on ${common.size} categories ` +
        `(${[...common].join(', ') || 'none'}); the migration map or the registry is inconsistent.`,
    )
  }
  const result = common === null ? null : assertAdapterCategory([...common][0]!)
  extractionCategoryCache.set(documentType, result)
  return result
}

// ── Instance-shaped document rows (SYS-3378) ─────────────────────────

/**
 * `buildDocumentRows` for a v2 `CanonicalView`. Same `DocumentRow[]`, same
 * grouping and order (DOC_DISPLAY_NAMES), same capabilities — read from the
 * `document-intake` instances instead of the wide pointer columns. This is
 * the Phase 6 blocker SYS-3378 names: until this exists, dropping a pointer
 * column blanks the documents table in both products.
 *
 * WHICH DOCUMENTS. Every `document-intake` instance whose `documentType` is a
 * type the table shows, in intake order — UNIONED with any document the
 * extraction categories know that intake does not (an upload predating the
 * intake writer; measured 1 of 1323 on the sim). The same union, in the same
 * order, that `resolveExtractionStatusFromView` walks, so a consumer aligning
 * status to rows by (docType, index) still can; and both now carry the
 * document hash as `documentId`, so it can join by identity instead.
 *
 * WHAT MOVED. `uploadedAt` comes from the intake instance's own `uploadedAt`
 * field, else its `observedAt` — the attestation IS the upload — with the
 * consumer-supplied `metadata` map (the `documentMetadata` sibling, keyed by
 * path) consulted first, exactly as v1 did, for fileName / fileType /
 * fileSize when the consumer has it. `uploadedBy` is read off the instance.
 *
 * WHAT DID NOT SURVIVE, said plainly. v1's `periodLabel` came from `month` /
 * `year` on the pointer entry, and in practice was the slot ordinal
 * ("Year 1", "Year 2") for financial statements and null elsewhere. Intake
 * instances carry no period, so `timePeriod` is 'ALL' and `periodLabel` is
 * null; the display name falls back to "<label> <n>" as v1's did for every
 * other type. The period a statement covers is a FACT about its content and
 * belongs on the extraction instance (`financialYearEnd`), not on the upload.
 */
export function buildDocumentRowsFromView(
  view: CanonicalView,
  metadata?: Record<string, DocumentFileMetadata>,
): DocumentRow[] {
  const metaMap = metadata ?? {}
  const rows: DocumentRow[] = []
  const intake = view.categories['document-intake']?.instances ?? []

  for (const docType of Object.keys(DOC_DISPLAY_NAMES)) {
    const label = DOC_DISPLAY_NAMES[docType]!
    const extractable = EXTRACTABLE_DOC_TYPES.has(docType)
    const reUploadable = extractable && REUPLOADABLE_DOC_TYPES.has(docType)

    const documents = documentsOfType(view, intake, docType)
    documents.forEach((doc, index) => {
      const path = doc.path
      const meta = path ? metaMap[path] : undefined
      const documentId = doc.hash ?? (path ? path.split('/').pop() || null : null)

      const rawName = meta?.fileName ?? undefined
      const fileName = rawName && !isProbablyId(rawName) ? rawName : null
      const rawExt = (rawName ?? '').split('.').pop()
      const ext = rawExt && rawExt.length <= 5 && !isProbablyId(rawExt) ? rawExt.toUpperCase() : null
      const mime = meta?.fileType
      const fileType = ext || (mime?.split('/').pop()?.toUpperCase() ?? null)
      const fileSize = meta?.fileSize ?? null
      const uploadedAt = meta?.createdAt ?? doc.uploadedAt ?? null

      rows.push({
        docType,
        label,
        index,
        displayName: fileName || (documents.length > 1 ? `${label} ${index + 1}` : label),
        documentId,
        path,
        timePeriod: 'ALL',
        periodLabel: null,
        fileName,
        fileType,
        fileSize,
        uploadedAt,
        ...(doc.uploadedBy ? { uploadedBy: doc.uploadedBy } : {}),
        capabilities: {
          download: !!documentId,
          viewJson: extractable,
          reExtract: extractable,
          reUpload: reUploadable,
        },
      })
    })
  }
  return rows
}

/** One document the view knows about, from intake, from extraction, or both. */
export interface ViewDocument {
  /** The DMS content hash — the join key across intake, extraction and status. Null when neither side carries one. */
  hash: string | null
  path: string | null
  uploadedAt: string | null
  uploadedBy: string | null
  /** The extraction instances for this document (period rows grouped), possibly none. */
  extraction: ReadonlyArray<CanonicalInstance>
  /**
   * 'intake' — an intake instance names this document (upload order, and the
   * only rows a positional job record may be aligned to). 'extraction-only' —
   * no intake row: a pre-writer upload, or a join miss between an intake path
   * and an extraction key. Both are real; the second must stay observable.
   */
  origin: 'intake' | 'extraction-only'
}

/**
 * The documents of one type, in the order both instance-shaped functions use:
 * intake instances first (upload order), then any extracted document no
 * intake instance accounts for. Shared by `buildDocumentRowsFromView` and
 * `resolveExtractionStatusFromView` so their (docType, index) alignment is a
 * property of one function, not a coincidence of two.
 */
export function documentsOfType(
  view: CanonicalView,
  intake: ReadonlyArray<CanonicalInstance>,
  docType: string,
): ViewDocument[] {
  const category = extractionCategoryOf(docType)
  const extracted = category !== null ? (view.categories[category]?.instances ?? []) : []
  const byHash = new Map<string, CanonicalInstance[]>()
  for (const inst of extracted) {
    const h = documentHashOfKey(inst.instanceKey)
    const list = byHash.get(h)
    if (list) list.push(inst)
    else byHash.set(h, [inst])
  }
  const out: ViewDocument[] = []
  const claimed = new Set<string>()
  for (const inst of intake) {
    if (inst.fields.documentType?.value !== docType) continue
    const path = stringOrNull(inst.fields.pathInDms?.value)
    const hash = path ? documentHashOfPath(path) : null
    const extraction = hash !== null ? (byHash.get(hash) ?? []) : []
    if (hash !== null && extraction.length > 0) claimed.add(hash)
    out.push({
      hash,
      path,
      uploadedAt: stringOrNull(inst.fields.uploadedAt?.value) ?? inst.observedAt ?? null,
      uploadedBy: stringOrNull(inst.fields.uploadedBy?.value),
      extraction,
      origin: 'intake',
    })
  }
  for (const [hash, group] of byHash) {
    if (!claimed.has(hash)) out.push({ hash, path: null, uploadedAt: null, uploadedBy: null, extraction: group, origin: 'extraction-only' })
  }
  return out
}

/**
 * The document hash inside an extraction instance key:
 * `bankStatement:<hash>` → `<hash>`, `financialStatement:<hash>#T2` → `<hash>`.
 * A key with no colon is its own hash. The `#…` tail is the per-document
 * period discriminator and is not part of the document's identity.
 */
export function documentHashOfKey(instanceKey: string): string {
  const colon = instanceKey.indexOf(':')
  const afterColon = colon === -1 ? instanceKey : instanceKey.slice(colon + 1)
  const hashAt = afterColon.indexOf('#')
  return hashAt === -1 ? afterColon : afterColon.slice(0, hashAt)
}

/** The DMS path's last segment, query stripped — the document's content hash. */
export function documentHashOfPath(path: string): string | null {
  const tail = path.split('?')[0]!.split('/').pop()
  return tail || null
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}
