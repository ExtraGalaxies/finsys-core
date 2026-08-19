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
  isValidIhsFieldOrigin,
} from './ihs-types.js'
import type {
  IhsFieldDetail,
  IhsDetailCategory,
  FileFieldTableData,
  FileFieldTableItem,
  IhsFieldProvenance,
  IhsFieldProvenanceWithOriginal,
  IhsFieldOrigin,
  DocumentRow,
  DocumentFileMetadata,
  InstanceRow,
} from './ihs-types.js'
import { getBaseFieldSpecs, getBaseCategories, getBaseFieldSpecMap } from './catalogs.js'
import { getDocumentTypeGroups } from './document-types.js'
import { allCategories, assertAdapterCategory, type AdapterCategory } from './adapter-categories.js'
import {
  v1Addresses,
  v1KeyForAddress,
  v1AddressHasKeyedEntries,
  v1MigrationKeys,
  v1MigrationEntry,
  v1LegacyBaseNameOf,
  v1FanoutAddressOf,
} from './v1-migration-map.js'
import type { V1Address } from './v1-migration-map.js'
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
 *
 * Dropping `false` is INHERITED v1 behavior, not a rule this function
 * chose — and it is no longer hypothetical now that boolean-typed registry
 * fields exist (`telco-carrier.handsetFinancingActive`,
 * `social-media.verifiedBusinessAccount`, `financial-statement.consolidated`):
 * a lender cannot tell "false" from "never asked" in either panel. Left
 * unchanged here because parity with the flat path IS the contract and the
 * flat path drops it too; whether `false` should render is a product
 * decision, not a bug in this processor.
 */
/**
 * L-2 (round 5): the v1 sentinel values this detail panel skips — `null`,
 * `undefined`, `''`, `'Not Specified'`, `false`. Named as its own function so
 * `valueAtPlainAddress`'s multi-instance pick (below) can share the EXACT
 * rule rather than growing its own copy that could silently drift from what
 * a reviewer actually sees rendered here.
 */
function isSentinelValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === 'Not Specified' || value === false
}

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
    for (const instance of category.instances ?? []) {
      for (const [field, envelope] of Object.entries(instance.fields)) {
        const value = envelope.value
        if (isSentinelValue(value)) continue

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
          const base = `${canonicalDetailName(categoryId, field, instance.instanceKey)}@${instance.adapterId}`
          const baseDisplay = `${displayName} (${instance.adapterId})`
          name = base
          displayName = baseDisplay
          // A third (or further) producer sharing the SAME (instanceKey,
          // adapterId, field) collides on the disambiguated name too — it is
          // never itself checked against `seen`. Number it until unique; this
          // loop, not the disambiguation above, is what makes uniqueness hold
          // for N > 2 producers.
          let n = 2
          while (seen.has(name)) {
            name = `${base}#${n}`
            displayName = `${baseDisplay} #${n}`
            n++
          }
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
  const legacyByOrdinal = new Map<number, CanonicalInstance[]>()
  for (const inst of extracted) {
    const h = documentHashOfKey(inst.instanceKey)
    if (h === null) {
      const n = legacyOrdinalOfKey(inst.instanceKey)
      if (n === null) continue // no identity and no slot: nothing to attribute it to
      const list = legacyByOrdinal.get(n)
      if (list) list.push(inst)
      else legacyByOrdinal.set(n, [inst])
      continue
    }
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
  const intakeCount = out.length
  for (const [hash, group] of byHash) {
    if (!claimed.has(hash)) out.push({ hash, path: null, uploadedAt: null, uploadedBy: null, extraction: group, origin: 'extraction-only' })
  }
  // Legacy slot rows: positional, as v1 was — `legacy:T{n}` is the n-th
  // INTAKE document's extraction, but only when that document has no hashed
  // extraction (a hashed run for the same document supersedes its legacy
  // duplicate). A slot beyond the intake documents is an extraction-only
  // document with no identity: a pre-writer subject whose uploads left no
  // intake row, still rendered, still counted, marked as such.
  for (const n of [...legacyByOrdinal.keys()].sort((a, b) => a - b)) {
    const group = legacyByOrdinal.get(n)!
    const target = n >= 1 && n <= intakeCount ? out[n - 1]! : undefined
    if (target && target.extraction.length === 0) out[n - 1] = { ...target, extraction: group }
    else if (!target) out.push({ hash: null, path: null, uploadedAt: null, uploadedBy: null, extraction: group, origin: 'extraction-only' })
    // else: the target already has hashed extraction — the legacy rows are its superseded duplicate.
  }
  return out
}

/**
 * The document identity inside an extraction instance key:
 * `bankStatement:<hash>` → `<hash>`, `financialStatement:<hash>#T2` → `<hash>`.
 * A key with no colon is its own identity. The `#…` tail is the per-document
 * period discriminator and is not part of the identity.
 *
 * NULL for a `legacy:T{n}` key. Those rows were written by the pre-hash path
 * — one per T-slot of the wide table, no document behind them — and on the sim
 * they are the ONLY extraction rows for 143 financial-statement subjects and
 * 33 bank-statement subjects. They carry no identity; `legacyOrdinalOfKey`
 * carries the one thing they do know, their slot.
 */
export function documentHashOfKey(instanceKey: string): string | null {
  if (LEGACY_KEY.test(instanceKey)) return null
  const colon = instanceKey.indexOf(':')
  const afterColon = colon === -1 ? instanceKey : instanceKey.slice(colon + 1)
  const hashAt = afterColon.indexOf('#')
  const id = hashAt === -1 ? afterColon : afterColon.slice(0, hashAt)
  return id === '' ? null : id
}

const LEGACY_KEY = /^legacy:T(\d+)$/

/** `legacy:T3` → 3; null for any other key. The slot ordinal is 1-based, as the wide table's was. */
export function legacyOrdinalOfKey(instanceKey: string): number | null {
  const m = LEGACY_KEY.exec(instanceKey)
  return m ? Number(m[1]) : null
}

/** The DMS path's last segment, query and fragment stripped — the document's content hash. */
export function documentHashOfPath(path: string): string | null {
  const tail = path.split(/[?#]/)[0]!.split('/').pop()
  return tail || null
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

// ── SYS-3334: buildFileFieldTables — the last flat function's instance-shaped sibling ──

const HASH_PERIOD_SUFFIX = /#T(\d+)$/

/**
 * v2's `documentType -> extraction category` map (`extractionCategoryOf`),
 * inverted: which document type OWNS this extraction category's instances.
 * A linear scan over ~7 document types, not worth a cache of its own on top
 * of `extractionCategoryOf`'s.
 */
function documentTypeOfCategory(category: AdapterCategory): string | null {
  for (const group of getDocumentTypeGroups()) {
    if (extractionCategoryOf(group.documentType) === category) return group.documentType
  }
  return null
}

/**
 * A category's instances, positioned as `documentsOfType` orders that
 * category's documents — the 0-based index `instanceRowsFromView` falls
 * back to when an instance carries no period of its own (see `timePeriodOf`).
 */
function instancePositions(view: CanonicalView, category: AdapterCategory): Map<string, number> {
  const docType = documentTypeOfCategory(category)
  if (docType === null) return new Map()
  const intake = view.categories['document-intake']?.instances ?? []
  const documents = documentsOfType(view, intake, docType)
  const positions = new Map<string, number>()
  documents.forEach((doc, i) => {
    for (const inst of doc.extraction) {
      if (!positions.has(inst.instanceKey)) positions.set(inst.instanceKey, i)
    }
  })
  return positions
}

/**
 * `InstanceRow.timePeriod` for one instance, FOUR rules in priority order —
 * widened from three by SYS-3334 F4 (round 2 review):
 *
 * 1. `instance.legacySlot`, VERBATIM, when present AND it matches
 *    `LEGACY_SLOT_SHAPE` (M4, round 4 — see that constant's doc: rejected
 *    outright when it does not, never trimmed or coerced, and rules 2-4
 *    below are consulted exactly as if the member were absent). This is the
 *    actual v1 slot the source row stored (finsys-api's provenance-on-the-wire
 *    fix puts it on the instance) — the uploader-declared slot on the file
 *    entry (bank `month`, EPF `year`, payslip `period`), not a re-derivation
 *    of it. When it is present AND well-shaped, rules 2-4 below are not even
 *    consulted: the wire already answered the question they exist to
 *    approximate.
 * 2. A `#T{n}` suffix on the key IS the period (financial statements:
 *    `financialStatement:<hash>#T2` -> 'T2' — two periods, one document).
 * 3. A `legacy:T{n}` key names its slot directly (`legacyOrdinalOfKey`).
 * 4. Otherwise the instance carries NO period on the wire and no
 *    `legacySlot` either — true of every bank / payslip / EPF instance
 *    (and, in practice, SSM / Form 9 / IC: one document, one
 *    single-cardinality instance, no period at all). RULE: label it by the
 *    instance's 0-based position in `documentsOfType`'s ordering of that
 *    category's documents, as `T{position + 1}`.
 *
 *    THIS IS AN APPROXIMATION, not v1's own numbering — F4's finding, and
 *    the reason rule 1 exists and outranks it. v1's T-number was the
 *    UPLOADER-DECLARED slot (bank `month`, EPF `year`, payslip `period`),
 *    stored on the sibling row as `timePeriod`; upload-order position is a
 *    DIFFERENT fact that happens to equal it only when uploads are ordered,
 *    complete, and unique per slot — an applicant who uploads statements out
 *    of order, skips a month, or replaces one gets a position-derived label
 *    that disagrees with what v1 would have shown. Rule 1 is what removes
 *    the approximation once finsys-api's provenance-on-the-wire fix ships;
 *    until then, this rule is what this function has.
 *
 *    Null only when the instance is absent from that ordering too — no
 *    document type maps to this category (`documentTypeOfCategory` found
 *    none), or the instance has neither a hash nor a legacy ordinal AND
 *    `documentsOfType` could not place it either (its own doc comment: "no
 *    identity and no slot: nothing to attribute it to").
 */
/**
 * M4 (round 4): the ONLY shape `legacySlot` is trusted in — bare `T`
 * followed by a positive integer with no leading zero, no whitespace, no
 * suffix (`'T1'`, `'T23'`; never `'T1 '`, `'1'`, `'2026-06'`, `'T01'`).
 * finsys-api has not shipped this member on any real instance as of
 * 2026-08-19 (see `CanonicalInstance.legacySlot`'s own doc), which makes
 * THIS the cheapest moment to pin the contract — before a real producer
 * exists to violate it. A value that fails this check is REJECTED, not
 * trimmed: trimming `'T1 '` to `'T1'` would silently accept a producer bug
 * that put a stray character on the wire, and this member's whole job is to
 * carry the wire's own claim verbatim. A rejected value is treated as
 * ABSENT — `timePeriodOf` falls through to rule 2, exactly as if
 * `legacySlot` had never been set — so a producer bug renders as a
 * DIFFERENT (derived) period rather than as one that looks legitimate in a
 * column header or a provenance key.
 */
const LEGACY_SLOT_SHAPE = /^T[1-9]\d*$/

function timePeriodOf(instance: CanonicalInstance, positions: Map<string, number>): string | null {
  if (instance.legacySlot && LEGACY_SLOT_SHAPE.test(instance.legacySlot)) return instance.legacySlot
  const hashSuffix = HASH_PERIOD_SUFFIX.exec(instance.instanceKey)
  if (hashSuffix) return `T${hashSuffix[1]}`
  const legacyOrdinal = legacyOrdinalOfKey(instance.instanceKey)
  if (legacyOrdinal !== null) return `T${legacyOrdinal}`
  const position = positions.get(instance.instanceKey)
  return position !== undefined ? `T${position + 1}` : null
}

/**
 * The one category with an obvious per-instance label field, per the
 * registry: `finxtract-bank-statement.issuingBankName` (legacy base name
 * `bankName`) — different statements can be different banks. No other
 * document-extraction category has an analogous field: payslip's
 * `employerName` and financial-statement's `companyName` are constant
 * across one applicant's own documents, so they would not discriminate one
 * instance from another the way a bank name does. Checked against the
 * registry directly (`src/data/adapter-categories.json`), not assumed.
 */
const SOURCE_LABEL_LEGACY_NAME: Partial<Record<AdapterCategory, string>> = {
  'finxtract-bank-statement': 'bankName',
}

/** Numeric ordering for `InstanceRow.timePeriod` (SYS-3334 F5, round 2): `'T1'
 * < 'T2' < … < 'T10'`. Anything that is not a bare `T{n}` — null, or F6's
 * `'#1'`/`'#2'` index fallback — sorts LAST, stable in original order; it
 * carries no period to order BY, so v1's "declared slot" ordering has
 * nothing to say about it either. */
function periodSortValue(period: string | null | undefined): number {
  if (!period) return Number.POSITIVE_INFINITY
  const m = /^T(\d+)$/.exec(period)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

interface InstanceRowPair {
  row: InstanceRow
  instance: CanonicalInstance
}

/**
 * `instanceRowsFromView`'s row-building step, paired with the SOURCE
 * instance and sorted by numeric period (SYS-3334 F5, round 2).
 *
 * WHY PAIRS, NOT TWO ARRAYS. `fieldProvenanceFromView` needs both a row's
 * RESOLVED period (`row.timePeriod` — the full four-rule cascade, F6's
 * `instanceKey: ''` rescue included) and the SAME instance's envelopes,
 * `adapterId`, `observedAt` and `runId` (what a provenance entry is built
 * from) — one pass, one resolved fact, rather than two.
 *
 * CORRECTED (M1, round 4): this comment used to name
 * `buildFileFieldTablesFromView` as the consumer that needed the pairing —
 * it does not; that function only ever calls `instanceRowsFromView`, which
 * keeps `.row` and discards `.instance`. `.instance` was, in fact, dead on
 * every path until M1's fix (below): `fieldProvenanceFromView` used to walk
 * `category.instances` directly and call `timePeriodOf` a SECOND time,
 * which — for a row F6 had rescued from a blank header — recomputed null
 * instead of reusing the rescued period, so the rescued column could never
 * carry a confidence dot. `fieldProvenanceFromView` now consumes THESE
 * pairs instead, making `.instance` load-bearing: one derivation of a row's
 * period, read by every caller that needs it.
 *
 * WHY SORT AT ALL (F5). `instanceRowsFromView` used to return rows in view
 * (extraction-array) order. v1's `extractTimePeriods` sorted its T-slots
 * ASCENDING before rendering, so whenever intake order (which
 * `instancePositions` derives period from) disagreed with the extraction
 * array's own order, the resulting table rendered out of sequence — a
 * later-uploaded, earlier-period document could render AFTER an
 * earlier-uploaded, later-period one. Sorted here, once, so every caller
 * (this function, `buildFileFieldTablesFromView`) sees ascending period
 * order without re-deriving it. Rows without a parseable period (null, or
 * F6's `#n` fallback) sort LAST, stable in their original order — nothing
 * ranks them against a real period, so they should not silently jump ahead
 * of one.
 */
function instanceRowPairsFromView(view: CanonicalView, category: AdapterCategory): InstanceRowPair[] {
  const instances = view.categories[category]?.instances ?? []
  if (instances.length === 0) return []

  const positions = instancePositions(view, category)
  const sourceLabelField = SOURCE_LABEL_LEGACY_NAME[category]

  const pairs: InstanceRowPair[] = instances.map((instance, i) => {
    const row: InstanceRow = {
      instanceKey: instance.instanceKey,
      timePeriod: timePeriodOf(instance, positions),
      sourceLabel: null,
      // The period COORDINATE, when the wire carries one — v1's sidecar rows
      // carried `periodPosition` too (finsys-api's toInstanceRow includes it
      // deliberately), and the finsys-client resolver selects the true
      // current-year row by it. Without this the flat-vs-view rows differ on
      // exactly the column that decides which number a lender scores on.
      ...(instance.periodPosition !== undefined ? { periodPosition: instance.periodPosition } : {}),
    }
    if (row.timePeriod === null && instance.instanceKey === '') {
      // SYS-3334 F6 (round 2): a single-cardinality category's ONE instance
      // carries instanceKey '' by convention (canonical-view.ts's own
      // contract) — and IS slot 1, the same way any other lone document
      // would position-fallback to T1. Without this, `timePeriodOf` answers
      // null, `instanceColumnLabel` falls back to `row.instanceKey` (''),
      // and the table renders a BLANK column header. More than one instance
      // sharing '' is a data anomaly (the contract says '' means "the ONE
      // instance"), so '' cannot mean slot 1 for either of them here —
      // fall back to array position, never to a shared, ambiguous label.
      row.timePeriod = instances.length === 1 ? 'T1' : `#${i + 1}`
    }
    for (const [field, envelope] of Object.entries(instance.fields)) {
      const legacyBase = v1LegacyBaseNameOf(category, field)
      if (legacyBase === null) continue
      row[legacyBase] = envelope.value
    }
    // SYS-3334 F4 (round 2): the wire's OWN per-instance label (finsys-api's
    // provenance-on-the-wire fix) wins over the registry-derived one — it is
    // the actual value the source row carried, not a guess from a field this
    // function happens to recognize. The registry fallback stays for every
    // instance that predates the fix.
    if (instance.sourceLabel) {
      row.sourceLabel = instance.sourceLabel
    } else if (sourceLabelField) {
      const label = row[sourceLabelField]
      if (typeof label === 'string' && label !== '') row.sourceLabel = label
    }
    return { row, instance }
  })

  // Stable sort (guaranteed since ES2019, which every runtime this package
  // targets satisfies) — ties (including every no-period row, all sorting to
  // +Infinity) keep their original relative order.
  pairs.sort((a, b) => periodSortValue(a.row.timePeriod) - periodSortValue(b.row.timePeriod))
  return pairs
}

/**
 * `InstanceRow[]` for one category of a `CanonicalView` — one row per v2
 * instance of that category, ORDERED BY NUMERIC PERIOD (SYS-3334 F5, round
 * 2 — see `instanceRowPairsFromView`'s doc for why; rows without one trail,
 * stable in view order). The bridge `buildFileFieldTablesFromView` needs: it
 * feeds a view into `buildFileFieldTablesFromInstances`, which was built for
 * finsys-api's sibling-table instance rows (one row per uploaded document,
 * keyed by a real instanceKey rather than a pre-declared T{n} slot) and
 * knows nothing about canonical envelopes.
 *
 * `instanceKey` is carried verbatim. `timePeriod` follows the four-rule
 * cascade in `timePeriodOf` (its own doc comment states the position-based
 * fallback rule, and F6's `instanceKey: ''` guard below it, in full — read
 * both before assuming a null or a `#n` here is a bug). `sourceLabel` is the
 * wire's own per-instance label (`instance.sourceLabel`) when present, else
 * the registry-derived one for the one category with an obvious label field
 * (`SOURCE_LABEL_LEGACY_NAME`), else null.
 *
 * Every field envelope becomes `row[legacyBaseName] = value`, via
 * `v1LegacyBaseNameOf`. A field with no legacy base name never had a wide
 * column — SKIPPED, not thrown: `buildFileFieldTablesFromInstances` only
 * ever reads the base names the catalog declares for this category, so an
 * unmapped field would never be looked up even if it were written into the
 * row. (A category with no v1 lineage at all has every field skipped this
 * way and produces rows with no metric keys — `groupColumnsByInstance`
 * treats that as "no data" for every base column, and
 * `buildFileFieldTablesFromInstances` omits the table, same as an empty
 * `instanceRows` array would.) SYS-3334 F1 (round 2): this claim used to be
 * false for exactly one shape — a `mapped-fanout` field (`incorporatedDate`)
 * — because `v1LegacyBaseNameOf` answered null for it despite it having a
 * wide column; fixed at the source in `v1-migration-map.ts`, so the claim
 * above is accurate again rather than merely aspirational.
 */
export function instanceRowsFromView(view: CanonicalView, category: AdapterCategory): InstanceRow[] {
  return instanceRowPairsFromView(view, category).map((p) => p.row)
}

/**
 * v1's assertion-class vocabulary (`IhsFieldOrigin`: 'extracted' | 'derived'
 * | 'manual') is CLOSED; v2's `CanonicalFieldEnvelope.origin` is an open
 * string naming the assertion class the finsys-api resolver ranks
 * ('extraction' | 'form-intake' | 'manual' | …, per `CanonicalAttestation`'s
 * doc comment in canonical-view.ts). The one rename known today is
 * 'extraction' -> 'extracted'. Anything else — absent, or a class this
 * bridge does not recognize — degrades to 'derived'.
 *
 * SYS-3334 F7 (round 2 review): that fallback is NOT "the type's documented
 * meaning" for one real case, 'form-intake', and the earlier wording of this
 * comment overclaimed it. `IhsFieldOrigin`'s own doc (ihs-types.ts) says
 * `derived` means "computed / no-confidence path" — a value nobody attested,
 * produced by a formula. A form-intake value is neither: an APPLICANT typed
 * it, which is a real assertion, just not one the closed v1 vocabulary has a
 * slot for ('manual' means a LENDER correction, not an applicant's own
 * answer — see `CanonicalAttestation`'s doc). 'derived' is the
 * LEAST-WRONG of the three available answers, not a correct one: it is
 * right that a form-intake value carries no extraction confidence, and wrong
 * to imply the value was computed rather than asserted. Widening
 * `IhsFieldOrigin` to a fourth value is the real fix and is not this
 * function's call to make — every consumer of the closed enum would need
 * updating for one bridge function's honesty. Never claim 'extracted' for a
 * string this function does not understand — that would fabricate a
 * confidence-worthy classification, exactly the failure `confidence` exists
 * to prevent.
 */
function legacyOriginOf(origin: string | undefined): IhsFieldOrigin {
  if (origin === 'extraction') return 'extracted'
  if (isValidIhsFieldOrigin(origin)) return origin
  return 'derived'
}

/**
 * The per-(legacy-key) provenance map every instance-shaped file-field
 * function synthesizes from `CanonicalView` envelopes — HOISTED out of
 * `buildFileFieldTablesFromView` (SYS-3334 F3, round 2 review) so it can be
 * called on its own, and FIXED at the same time: the inline version this
 * replaces built its map with a bare `synthesized[key] = entry` inside a
 * loop, so two envelopes landing on the same key SILENTLY collided —
 * whichever was written last won, with no signal that a collision had even
 * happened. Two real shapes produce that collision: a re-extraction (two
 * runs of the SAME document, same key, same period) and two filings that
 * both land on `#T1` (see F5's own doc for why two filings can share a
 * slot).
 *
 * COVERS EVERY CATEGORY, not only document-extraction ones (unlike
 * `buildFileFieldTablesFromView`'s own loop, which only ever walked
 * `getDocumentTypeGroups()`). A scalar field's provenance — an applicant's
 * own `fullName` confidence, say — is exactly as real as a bank statement
 * cell's, and the caller-override contract (`fieldProvenance` beating the
 * synthesized map) should hold for it too.
 *
 * KEYING, two paths — BOTH emitted when both answer (H1, round 4;
 * corrected from "only when (1) has no answer" below):
 *   1. THE EXACT v1 KEY, via `v1KeyForAddress(category, field, instanceKey)`,
 *      with the SAME keyless fallback `processIhsDetailsFromView` uses when
 *      the instance key carries no discriminating power for this field
 *      (`v1AddressHasKeyedEntries`) — copied here rather than imported,
 *      because `processIhsDetailsFromView` is out of scope for this change
 *      (see the brief this function was built against) and duplicating four
 *      lines is safer than reaching into a function nobody may touch. What
 *      the detail panel and a v1 sidecar key on.
 *   2. THE T-SLOT FAMILY'S SHARED BASE + this instance's period, via
 *      `v1LegacyBaseNameOf(category, field)` and `${legacyBase}${period}`.
 *      What `buildInstanceTable` ALWAYS reads (unconditionally, never the
 *      exact key — see its own doc). `period` is `row.timePeriod`, from the
 *      SAME resolved rows `instanceRowsFromView` renders
 *      (`instanceRowPairsFromView` — M1, round 4, corrected below), not a
 *      second derivation that could silently disagree with what the row
 *      shows.
 *
 * H1 (HIGH, round 4): path 2 used to run ONLY when path 1 had no answer —
 * correct for a genuine T-slot family (`bankBalanceT1..T6`, no single v1 key
 * to name), wrong for `ssm`/`form9`/`ic`: their single-instance columns
 * carry NO T-suffix at all, so their exact key (`ssmCompanyName`,
 * `icName`, …) IS already their legacy base, and it beat path 2 to `key`
 * every time. `buildInstanceTable` never looks up the bare base — it always
 * appends the period — so these three document types lost 100% of their
 * provenance through this path (measured: `ssm_documents` 16/16,
 * `ic_documents` 9/9, `form9` 3/3 base columns). Both names point at the
 * SAME cell, so both are now emitted whenever both resolve — gated to
 * document-extraction categories (`documentTypeOfCategory(category) !==
 * null`, the same set `buildInstanceTable` is ever fed): a scalar category's
 * F6-rescued period (an `applicant-identity` sole `''` instance renders
 * `'T1'` too, for `instanceRowsFromView`'s OWN reason — see F6's doc) would
 * otherwise mint a `<base><period>` twin — e.g. `fullNameT1` — that nothing
 * ever reads, purely because path 2's two ingredients both happened to
 * resolve for a field `buildInstanceTable` will never render.
 *
 * NAMED, NOT HIDDEN: the period-suffixed key is per (base, slot), not per
 * instance — `buildInstanceTable`'s own contract (it looks provenance up by
 * `${baseName}${row.timePeriod}`, which does not include `instanceKey`). So
 * two DIFFERENT instances that land on the same slot (the re-extraction and
 * two-filings cases above) necessarily share ONE provenance entry; this is a
 * limitation of `buildInstanceTable`'s key format, not of this function.
 *
 * H2 (HIGH, round 4): a collided key is DROPPED from the returned
 * `provenance`, not resolved to the winner. `collided` still names it, so a
 * caller can log or investigate — but the entry itself is removed: with two
 * instances landing on one slot (a real shape during the `legacySlot`
 * migration window — one instance carrying it, its sibling falling through
 * to the SAME position-fallback slot), rendering the winner's confidence on
 * BOTH columns put a wrong-but-plausible number on the loser's column, which
 * never had that confidence. Absent is honest; wrong-and-confident is not —
 * exactly the property F3 (above) exists to protect, and rendering a
 * winner's number on a loser's column violated it as surely as the silent
 * last-write-wins F3 fixed did.
 *
 * M-5 (round 5): H2 above is why this function no longer picks a temporal
 * winner for a genuine collision at all. Round 2-4 kept a `challengerWins`
 * tie-break (newer `observedAt`, then larger `runId`, then last-in-order) so
 * `provenance[key]` briefly held "the winner" before H2's unconditional
 * delete removed it — but every key that ever REACHES a collision comparison
 * is, by definition, a key H2 deletes at the end, so that comparison's
 * result was never observable in the returned `provenance`: `challengerWins`
 * and the `winnerMeta` map that fed it were computing an answer nobody could
 * ever read. Deleted. A collision is now just recorded (`collidedSet.add`)
 * and left alone — SHIPPED BEHAVIOR, stated plainly: a collided key is
 * reported in `collided` and absent from `provenance`; no winner is chosen,
 * because a winner would be a guess with nowhere left to render it.
 *
 * H-1 (HIGH, round 5): a `mapped-fanout` key's two DIFFERENT attestors
 * (`sharedFanoutOf`, below) are NOT this kind of collision — the fanout's
 * whole design is that BOTH survive. See that function's own doc and the
 * loop below for the address-order tie-break that replaces
 * `challengerWins` for exactly this one case.
 *
 * NO ENTRY when the envelope asserts NEITHER `confidence` NOR `origin` (L1,
 * round 4 — corrected from "none of `confidence`, `origin`, or
 * `originalValue`"): `originalValue` alone used to admit an envelope here
 * too, then stamp it `origin: legacyOriginOf(undefined)` = `'derived'` — the
 * exact fabricated shape this paragraph says never happens, for a field
 * that asserted NOTHING beyond the value an overlay replaced. `confidence`
 * or `origin` is a real assertion; `originalValue` is carried ONTO an entry
 * one of those two justified, never a reason to create one by itself.
 */
/**
 * H-1 (round 5): whether two DIFFERENT (category, field) addresses that just
 * wrote the SAME provenance key are the two attestors of one
 * `mapped-fanout` entry (`incorporatedDate` today) rather than a genuine
 * collision. Returns their positions in the fanout's own `addresses` order
 * when they are; null when they are not (including when either address is
 * not a fanout attestor at all, or the two belong to DIFFERENT fanouts).
 */
function sharedFanoutOf(
  a: { category: string; field: string },
  b: { category: string; field: string },
): { incumbentIndex: number; challengerIndex: number } | null {
  const fa = v1FanoutAddressOf(a.category, a.field)
  const fb = v1FanoutAddressOf(b.category, b.field)
  if (fa === null || fb === null || fa.key !== fb.key) return null
  return { incumbentIndex: fa.index, challengerIndex: fb.index }
}

export function fieldProvenanceFromView(
  view: CanonicalView,
): { provenance: Record<string, IhsFieldProvenanceWithOriginal>; collided: string[] } {
  const provenance: Record<string, IhsFieldProvenanceWithOriginal> = {}
  // H-1: the (category, field) address that WROTE the current entry under
  // each key, so a second write from a DIFFERENT address can be told apart
  // from a second write from the SAME one — see the loop below. (M-5, round
  // 5: this replaces the round 2-4 `winnerMeta` map, which tracked
  // observedAt/runId for a temporal tie-break that H2's unconditional
  // delete made unobservable for every key it was ever consulted on — see
  // this function's own doc.)
  // The VALUE rides along so a fanout co-attestation can be told from a
  // fanout DISAGREEMENT (H-1r5, below): the carve-out is only honest when
  // both attestors say the same thing.
  const originAddress = new Map<string, { category: string; field: string; value: unknown }>()
  const collidedSet = new Set<string>()

  for (const categoryId of Object.keys(view.categories)) {
    const category = categoryId as AdapterCategory
    // H1: gates path 2 (below) to the categories buildInstanceTable ever
    // renders — see the function doc for why a scalar category's rescued
    // period must NOT feed a legacy-base+period key.
    const isDocCategory = documentTypeOfCategory(category) !== null

    for (const { row, instance } of instanceRowPairsFromView(view, category)) {
      // M1: the SAME resolved period the row carries — including F6's
      // rescue — never a second `timePeriodOf` call (see the function doc
      // and `InstanceRowPair`'s own doc for the bug this replaces).
      const period = row.timePeriod

      for (const [field, envelope] of Object.entries(instance.fields)) {
        // L1: `originalValue` alone does not justify synthesizing an entry.
        if (envelope.confidence === undefined && envelope.origin === undefined) {
          continue
        }

        // The keyed lookup first — same keyless fallback rule
        // `processIhsDetailsFromView` uses (see that function's own comment
        // for the reasoning): a miss only falls back to the keyless entry
        // when the map holds no keyed entry for this address AT ALL.
        const exact =
          v1KeyForAddress(categoryId, field, instance.instanceKey || undefined) ??
          (v1AddressHasKeyedEntries(categoryId, field) ? null : v1KeyForAddress(categoryId, field))

        // H1: path 2, computed independently of path 1 and emitted
        // ALONGSIDE it (not only as a fallback) — see the function doc.
        let periodKey: string | null = null
        if (isDocCategory && period !== null) {
          const legacyBase = v1LegacyBaseNameOf(categoryId, field)
          if (legacyBase !== null) periodKey = `${legacyBase}${period}`
        }

        const keys = new Set<string>()
        if (exact !== null) keys.add(exact)
        if (periodKey !== null) keys.add(periodKey)
        if (keys.size === 0) continue

        const entry: IhsFieldProvenanceWithOriginal = {
          source: instance.adapterId,
          confidence: envelope.confidence ?? null,
          // F7/F10: '' is a documented sentinel — see IhsFieldProvenance.observedAt.
          observedAt: instance.observedAt ?? '',
          sourceRunId: instance.runId !== undefined ? String(instance.runId) : null,
          origin: legacyOriginOf(envelope.origin),
          ...(envelope.originalValue !== undefined ? { originalValue: envelope.originalValue } : {}),
        }

        for (const key of keys) {
          const incumbentAddress = originAddress.get(key)
          if (incumbentAddress === undefined) {
            provenance[key] = entry
            originAddress.set(key, { category: categoryId, field, value: envelope.value })
            continue
          }

          // H-1: is this a SECOND write from the address that already holds
          // the key, or from a DIFFERENT address? Only the latter can
          // possibly be a fanout co-attestation rather than a collision.
          const sameAddress = incumbentAddress.category === categoryId && incumbentAddress.field === field
          const fanout = sameAddress ? null : sharedFanoutOf(incumbentAddress, { category: categoryId, field })

          if (fanout) {
            // Two DIFFERENT attestors of the SAME mapped-fanout v1 key —
            // the fanout's whole design is that both survive, so this is
            // NOT a collision WHEN THEY AGREE. Keep whichever address is
            // FIRST in the map's own `addresses` order — the same rule
            // `flatRecordFromView`'s `mapped-fanout` branch uses to pick
            // "the" value. Never a temporal/run-based tie-break: that
            // answers a different question ("which INSTANCE of the SAME
            // address is newest"), and M-5 removed it as dead weight for
            // the genuine-collision case below.
            //
            // H-1r5: when the two attestors DISAGREE on the value, this is
            // a collision after all. Both tables render their OWN value,
            // but the provenance map is keyed by the v1 column, so a single
            // surviving entry would pair one table's value with the OTHER
            // attestor's confidence, source and run — a wrong-but-plausible
            // dot, the exact shape H2 exists to prevent. Absent is honest.
            if (!candidateValuesAgree(incumbentAddress.value, envelope.value)) {
              collidedSet.add(key)
              continue
            }
            if (fanout.challengerIndex < fanout.incumbentIndex) {
              provenance[key] = entry
              originAddress.set(key, { category: categoryId, field, value: envelope.value })
            }
            continue
          }

          // M-5 (round 5): a real collision — the SAME address wrote this
          // key twice, or two DIFFERENT addresses that are not both
          // attestors of one fanout. Recorded and left alone: H2 (round 4,
          // below) unconditionally deletes this key's `provenance` entry
          // regardless of which write it is, so nothing here needs to pick
          // a winner.
          collidedSet.add(key)
        }
      }
    }
  }

  // H2: a collided key is dropped from `provenance` — see the function doc.
  // `collided` (returned below) still names every one of them.
  for (const key of collidedSet) {
    delete provenance[key]
  }

  return { provenance, collided: [...collidedSet] }
}

/**
 * `buildFileFieldTables` for a v2 `CanonicalView` — the fourth and last flat
 * file-field function to get an instance-shaped sibling (the finsys-client
 * migration's last flat surface to gain one; see this module's other
 * SYS-3334 doc comments on
 * `processIhsDetailsFromView` / `resolveExtractionStatusFromView` /
 * `buildDocumentRowsFromView` for the same discipline applied here).
 *
 * MECHANISM. For every document-type group (`getDocumentTypeGroups()`),
 * resolve its extraction category (`extractionCategoryOf`), turn that
 * category's instances into `InstanceRow[]` (`instanceRowsFromView`), and
 * hand the whole map to `buildFileFieldTablesFromInstances` keyed by
 * `documentGroup` — the exact key that function already groups its own
 * catalog output by (`groupFieldsByPattern` groups `type: 'file'` specs by
 * `document_group`, e.g. `bank_statements`, NOT `document_type`, e.g.
 * `bankStatements` — confirmed against the catalog data, not assumed). A
 * document type whose columns map to no extraction category
 * (`extractionCategoryOf` returns null) contributes no table, same as an
 * absent category does today for `buildFileFieldTablesFromInstances`.
 *
 * PROVENANCE, WITHOUT A V1 SIDECAR — now `fieldProvenanceFromView` (SYS-3334
 * F3, round 2). `buildInstanceTable` (inside `buildFileFieldTablesFromInstances`)
 * looks up per-cell provenance in a `fieldProvenance` map keyed by
 * `${legacyBaseName}${timePeriod}` — the exact wide-table column name
 * (`bankBalanceT1`). v1 fed that map from a sidecar finsys-api built
 * alongside the flat record; a `CanonicalView` has no such sidecar, but its
 * own envelopes already carry `confidence` / `origin` per field, plus
 * `adapterId` / `observedAt` / `runId` per instance —
 * `fieldProvenanceFromView` synthesizes the sidecar's shape from those, so
 * confidence dots keep working with NO caller-supplied provenance at all —
 * QUALIFIED (H1/F11, round 4): true once BOTH (a) finsys-api's own
 * provenance-on-the-wire fix ships (as of 2026-08-19 it has not — the wire
 * attaches provenance to 0 of 68k extraction fields) AND (b)
 * `fieldProvenanceFromView` emits both the exact v1 key and the
 * period-suffixed key this lookup actually reads (H1's fix — before it,
 * `ssm`/`form9`/`ic` rendered zero dots regardless of what finsys-api
 * ships, because their exact key won outright and this lookup never sees
 * it). See `fieldProvenanceFromView`'s own doc for the mechanism.
 * The optional `fieldProvenance` parameter still exists (same signature as
 * `buildFileFieldTables`) for a caller that has one anyway; where it and the
 * synthesized map name the same key, the CALLER'S entry wins — an explicit
 * override should beat a derived guess. `fieldProvenanceFromView`'s own
 * `collided` return is dropped here: this function's signature predates F3
 * and changing its return shape is out of scope for a review fix — a caller
 * that needs the collision signal calls `fieldProvenanceFromView` directly.
 *
 * M-4 (round 4, doc corrected round 5): THE OVERRIDE IS VACUOUS ON 28 BASE
 * COLUMNS — stated plainly, because "the caller's entry wins" reads as a
 * universal contract and is not one. `buildInstanceTable` reads ONLY
 * `${legacyBaseName}${timePeriod}` (H1, round 4's own finding), never the
 * bare v1 key — but for ssm (16 columns), ic (9), and form9 (3), the exact
 * v1 key IS the legacy base (their single-instance fields carry no
 * T-suffix at all), so a caller-supplied sidecar keyed by that bare v1 name
 * (`ssmCompanyName`, not `ssmCompanyNameT1`) never reaches the lookup this
 * function actually performs — it silently does nothing, and a `currency`
 * on that same caller entry is lost the identical way (never read, because
 * the entry itself is never read). The synthesized period-suffixed twin
 * (H1) is what actually reaches the cell; a caller wanting to override one
 * of these 28 must key its override the SAME way — `<base>T1`, not the
 * bare v1 name — behavior UNCHANGED by this correction; only the doc was
 * wrong.
 *
 * NOT CARRIED THROUGH: `currency` — the per-observation denomination
 * `IhsFieldProvenance.currency` records on the flat sidecar.
 * `CanonicalFieldEnvelope` has no currency member — v2 does not yet attach
 * one the way the v1 sidecar could — so money values through this path format
 * WITHOUT a currency code (a plain grouped number: `formatValue`'s existing,
 * honest "no denomination known" behavior; it does not invent one). This is
 * a real capability gap, not a bug introduced here, and it already applied
 * to `buildFileFieldTablesFromInstances` before this function existed.
 */
export function buildFileFieldTablesFromView(
  view: CanonicalView,
  fieldProvenance?: Record<string, IhsFieldProvenance>,
): Record<string, FileFieldTableData> {
  const instancesByCategory: Record<string, InstanceRow[]> = {}

  for (const group of getDocumentTypeGroups()) {
    const category = extractionCategoryOf(group.documentType)
    if (category === null) continue

    instancesByCategory[group.documentGroup] = instanceRowsFromView(view, category)
  }

  const { provenance: synthesized } = fieldProvenanceFromView(view)
  const provenance = { ...synthesized, ...(fieldProvenance ?? {}) }
  return buildFileFieldTablesFromInstances(
    instancesByCategory,
    Object.keys(provenance).length > 0 ? provenance : undefined,
  )
}

// ── The v1-shape bridge (SYS-3334) ────────────────────────────────────

/**
 * The record half of the v2 read pair, structurally — core does not import
 * the SDK or any host-side application-record type. `parties` / `facility` /
 * `system` are the three groupings finhub-adonisjs and finsys-client already
 * use for the non-adapter fields the `relocated` keys moved to (the
 * migration map's own NOT-ADAPTER column-audit classes); a caller with a
 * differently-shaped record adapts it to this shape at the call site rather
 * than this package widening to match one host's naming.
 *
 * L-6 (round 5): WHICH KEY LIVES IN WHICH BUCKET IS THE RECORD CONTRACT —
 * this package does not police it, `flatRecordFromView` just walks whichever
 * bucket the map's `relocated` entries and the caller agree on (H-2, round
 * 5: by PRESENCE, `parties` -> `facility` -> `system`, stopping at the first
 * bucket that carries the key at all). In practice: `system` carries the
 * administrative/timestamp keys (`createdAt`, `updatedAt`, `jurisdiction`,
 * `programId`, …), `facility` carries financing terms (`totalFinancing`, …),
 * `parties` carries borrower/lender identity. The ONE normalization
 * `flatRecordFromView` performs on ANY relocated value, regardless of which
 * bucket it came from: a `Date` instance becomes its ISO string — v1 served
 * every relocated timestamp as an ISO string, and a caller assembling this
 * record from an ORM row hands back `Date` objects instead. This is SHAPE,
 * not the value coercion `flatRecordFromView`'s own doc disclaims elsewhere
 * (a `Date` and its ISO string name the same instant; there is no second
 * opinion about what the value IS, only about which JS type carries it). See
 * `normalizeRelocatedValue`.
 */
export interface ApplicationRecordLike {
  applicationId?: number
  status?: string | null
  statusDescription?: string | null
  parties?: Record<string, unknown>
  facility?: Record<string, unknown>
  system?: Record<string, unknown>
}

/**
 * The v1 flat IHS record's SHAPE, re-derived from a `CanonicalView` (+ an
 * optional `ApplicationRecordLike` for the keys the migration map calls
 * `relocated`) — the migration map run FORWARD (v1 key → address → value),
 * so `EvaluationDataFactory`, the SSM panel, `MatchingUtil.isSatisfied`,
 * `jurisdictionOf` and every other v1-flat-shaped reader can consume a v2
 * view through one map instead of each growing its own reverse walk.
 */
export interface FlatRecordFromView {
  /** v1 column name -> value, for every key the map could place from this view/record. */
  record: Record<string, unknown>
  /**
   * v1 keys the map holds but this function could NOT place, one entry per
   * key, NEVER silent — `flatRecordFromView` iterates `v1MigrationKeys()`,
   * not the view, so a key with no v2 value is reported, not dropped. Every
   * non-placed key ends up here exactly once, `disposition` is the map's own
   * `V1Disposition` string (so a caller can filter — "show me only the
   * `needs-decision` residuals"), and `reason` is either the map entry's own
   * `note`/`reason` (retired / vocabulary-gap / needs-decision /
   * mapped-pending-build / structural) or a fact this function discovered
   * about the SUPPLIED view/record for a `mapped` / `mapped-fanout` /
   * `relocated` key that had an address but no value at it today.
   */
  unplaced: { key: string; disposition: string; reason: string }[]
  /**
   * v1 keys that WERE placed, but the placement made a choice a reader
   * should be able to see rather than trust silently: (a) a plain-address
   * `mapped` key where more than one instance of the category carried that
   * field (the first, in the SAME period-sorted order the rendered tables
   * use — M-1, round 5 — was placed; v1's own wide column could hold only
   * one value too, so this is not a new ambiguity, only a newly VISIBLE
   * one); (b) a `mapped-fanout` key (`incorporatedDate`) where more than one
   * attestor address had a value and they DISAGREED (the first address's
   * value, in the map's own address order, was placed); (c) a T-slot family
   * key (M-2, round 5) where more than one row shares the slot (the first,
   * in row order, was placed — a T-slot key names the SLOT, not an
   * INSTANCE, so `buildInstanceTable` can render two columns for the same
   * period label while this can only ever hold one value). Never populated
   * for an `instanceKey` / `instanceKeyPrefix` resolution — those are a
   * single, unambiguous instance by construction (or, for a prefix,
   * "first in order" IS the stated parity contract, not an accident worth
   * flagging every time it fires).
   */
  ambiguous: string[]
  /**
   * The four v1 sidecars, one row per instance, keyed by LEGACY base names —
   * `instanceRowsFromView` verbatim, one call per category. These are the
   * `structural` map entries `bankStatementInstances` / `financialStatementInstances`
   * / `epfStatementInstances` / `payslipInstances`: v1 shipped them as
   * sibling arrays beside the flat record, and they still are one, just not
   * a member of `record` — the flat record's OWN keys never held instance
   * rows, so putting these here rather than flattening them into `record` is
   * the honest shape, not a convenience.
   */
  instances: {
    financialStatementInstances: InstanceRow[]
    bankStatementInstances: InstanceRow[]
    epfStatementInstances: InstanceRow[]
    payslipInstances: InstanceRow[]
  }
}

/** The v1 key's own trailing period suffix — `bankBalanceT1` -> `1`. Matches
 * ONLY the bare `T[1-9]` tail: the `(PriorYear)?` branch `v1-migration-map.ts`'s
 * `TIME_PERIOD_SUFFIX` also carries is UNREACHABLE for a `mapped` entry as of
 * the round 2 map correction (the six `…PriorYearT{n}` keys are
 * `needs-decision` now, not `mapped`) — see that regex's own doc comment. */
const T_SLOT_KEY_SUFFIX = /T([1-9])$/

interface AddressLookup {
  found: boolean
  value?: unknown
  /**
   * Set by the plain-address lookup (more than one instance carries the
   * field) and, since M-2 (round 5), by the T-slot lookup too (more than one
   * row shares the slot) — see `ambiguous` above.
   */
  multiple?: boolean
  /**
   * L-5 (round 5): only ever set by the T-slot lookup, on a miss — names
   * WHICH of its three distinct not-found causes applied (`valueAtTSlot`'s
   * own doc). Unset elsewhere; those callers' `missingReason` locals in
   * `flatRecordFromView` are specific enough on their own.
   */
  reason?: string
}

/**
 * H-2 (round 5): PRESENCE, not nullishness. `record.parties[key] ??
 * record.facility[key] ?? record.system[key]` — the line this replaces —
 * fell through to the NEXT bucket whenever the current one held an explicit
 * `null`, so `parties: { jurisdiction: null }` beside `facility: {
 * jurisdiction: 'X' }` silently returned the WRONG bucket's value, and it
 * was inconsistent about it: a null in the LAST bucket (`system`) still got
 * placed (nothing left to fall through to), so the same "null means try
 * again" rule gave two different answers depending on which bucket happened
 * to hold the null. Walks `parties` -> `facility` -> `system`, the SAME
 * order and the SAME three buckets, but stops at the FIRST one that carries
 * the key AT ALL (`Object.prototype.hasOwnProperty`, never a nullish check)
 * — exactly the rule `valueAtPlainAddress` already applies to a v2 field
 * envelope. A bucket's explicit `null` is a real assertion (v1 served null
 * for an empty relocated column) and is placed as `null`, never treated as
 * "try the next bucket".
 */
function relocatedBucketValue(record: ApplicationRecordLike | undefined, key: string): AddressLookup {
  for (const bucket of [record?.parties, record?.facility, record?.system]) {
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, key)) {
      return { found: true, value: bucket[key] }
    }
  }
  return { found: false }
}

/**
 * L-6 (round 5): the ONE normalization `flatRecordFromView` performs on a
 * relocated value (`ApplicationRecordLike`'s own doc names the reason) — a
 * `Date` instance becomes its ISO string, v1's own shape for every
 * relocated timestamp. Applied uniformly to every relocated key, not only
 * `createdAt`/`updatedAt`, because the record contract does not name here
 * which keys a caller might hand a `Date` for.
 */
function normalizeRelocatedValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value
}

/** A per-call memo of `instanceRowPairsFromView`, keyed by category — see `rowPairsCache` below. */
type RowPairsLookup = (view: CanonicalView, category: AdapterCategory) => InstanceRowPair[]

/**
 * L-4 (round 5): a CALL-LOCAL memo of `instanceRowPairsFromView` — one
 * rebuild per category actually looked up during a single `flatRecordFromView`
 * call, not a module-level cache (a `CanonicalView` is call-scoped data;
 * caching across calls would leak one application's rows into another's
 * lookup, or go stale against a re-fetched view of the SAME application).
 *
 * Paired with M-1 (same finding): once `valueAtPlainAddress` reads row-pair
 * order instead of raw view order, it — like `valueAtTSlot` already did —
 * calls `instanceRowPairsFromView` once per key that shares a category, and
 * most keys DO share one (`finxtract-bank-statement` alone backs 8 T-slot
 * base columns x up to 6 periods). Measured on the round-5 fixture: 504
 * T-slot `mapped` keys with a plain (non-instance) address, each rebuilding
 * `instanceRowPairsFromView` for its category from scratch before this fix.
 * A fresh cache per `flatRecordFromView` call turns that into one rebuild
 * per DISTINCT category actually visited.
 */
function rowPairsCache(): RowPairsLookup {
  const cache = new Map<AdapterCategory, InstanceRowPair[]>()
  return (view, category) => {
    const cached = cache.get(category)
    if (cached) return cached
    const pairs = instanceRowPairsFromView(view, category)
    cache.set(category, pairs)
    return pairs
  }
}

/**
 * L-1 (round 5): whether two candidate values from different attestors count
 * as AGREEING, for `ambiguous` purposes — the SAME rule everywhere a
 * candidate-value comparison happens (this function, the `mapped-fanout`
 * disagreement check below). `===` alone is too strict: v1 stored some
 * values as decimal STRINGS where v2 types the equivalent canonical field as
 * a NUMBER (`flatRecordFromView`'s own "VALUE COERCION: NONE" section names
 * this exact mismatch), so two attestors reporting the literal same fact —
 * one via a v1-shaped string sidecar, one via a v2 numeric envelope — must
 * not read as a disagreement merely because of which JS type carried it.
 *
 * `looksNumeric` gates the numeric comparison so `null`/`undefined`/`false`
 * are never coerced through `Number(...)` (`Number(null) === 0` would read a
 * cleared field as agreeing with a real zero). Falls back to a plain
 * `String()` compare for anything that isn't numeric on both sides.
 */
function looksNumeric(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isNaN(value)
  if (typeof value === 'string' && value.trim() !== '') return !Number.isNaN(Number(value))
  return false
}

function candidateValuesAgree(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (looksNumeric(a) && looksNumeric(b)) return Number(a) === Number(b)
  return String(a) === String(b)
}

/**
 * `mapped` with a plain address: the value of the FIRST instance of
 * `address.category` that carries `address.field` at all —
 * `Object.prototype.hasOwnProperty`, not a truthy/defined check, because a
 * field explicitly asserting a falsy value (0, '', false) is still asserted.
 *
 * M-1 (round 5): "first" means the SAME period-sorted order the rendered
 * file-field tables use (`instanceRowPairsFromView`, via `rowPairsFor` —
 * L-4's call-local cache), not the view's raw extraction-array order, which
 * this used to read directly. Before this fix, a category whose upload
 * order disagreed with its period order (a later upload, earlier period —
 * exactly the shape F5 sorts for) could place THIS scalar from a DIFFERENT
 * document than the one the table's own T1 column shows for the SAME field
 * — one function telling a reader two different facts about the same slot.
 * `valueAtTSlot` already read the resolved rows for this reason; this makes
 * it one derivation for the whole function instead of two that could
 * silently disagree.
 *
 * `multiple: true` (L-1, round 5 — corrected from "more than one instance
 * carries the field"): only when a DIFFERING candidate value exists
 * (`candidateValuesAgree`), never merely because more than one instance
 * carries the field. Two SSM uploads reporting the identical `companyName`
 * are not a disagreement, and flagging them as one buried the keys that
 * genuinely disagree in noise.
 *
 * L-2 (round 5): "first" prefers the first instance whose value is NOT one
 * of `isSentinelValue`'s sentinels — the same rule `processIhsDetailsFromView`
 * applies before ever showing a value to a reviewer. Before this fix, an
 * earlier instance's blank/'Not Specified'/false could win the slot while a
 * LATER instance held the real value, so a scoring consumer of `record`
 * read the sentinel while the detail panel (reading the SAME view through
 * its own, per-instance loop) showed the real name. If every instance
 * carries only a sentinel, the first is placed anyway — v1's own wide
 * column held exactly that, and there is no better answer available.
 */
function valueAtPlainAddress(view: CanonicalView, address: V1Address, rowPairsFor: RowPairsLookup): AddressLookup {
  const instances = rowPairsFor(view, assertAdapterCategory(address.category)).map((p) => p.instance)
  const withField = instances.filter((i) => Object.prototype.hasOwnProperty.call(i.fields, address.field))
  if (withField.length === 0) return { found: false }
  const values = withField.map((i) => i.fields[address.field]!.value)
  const nonSentinelIndex = values.findIndex((v) => !isSentinelValue(v))
  const index = nonSentinelIndex === -1 ? 0 : nonSentinelIndex
  const multiple = values.some((v, i) => i !== index && !candidateValuesAgree(v, values[index]))
  return { found: true, value: values[index], multiple }
}

/** `mapped` with `instanceKey`: the ONE instance whose `instanceKey` equals it. */
function valueAtInstanceKey(view: CanonicalView, address: V1Address): AddressLookup {
  const instances = view.categories[address.category]?.instances ?? []
  const inst = instances.find((i) => i.instanceKey === address.instanceKey)
  if (!inst || !Object.prototype.hasOwnProperty.call(inst.fields, address.field)) return { found: false }
  return { found: true, value: inst.fields[address.field]!.value }
}

/**
 * `mapped` with `instanceKeyPrefix`: the FIRST instance (in view order)
 * whose key EQUALS the prefix, or continues it at a `#`-delimited boundary
 * (`document-intake` keys are `<docType>#<n>`, e.g. `bankStatements#1`). v1
 * held ONE value per pointer column (a JSON array of paths collapsed to a
 * single wide cell); v2 keys one instance per file, so first-in-order is the
 * stated parity choice, not an arbitrary one — the same reason this path
 * never contributes to `ambiguous`.
 *
 * L-3 (round 5): a bare `startsWith(prefix)` — this function's old body —
 * matches any LONGER prefix too: `bankStatements` is a prefix of
 * `bankStatementsExtraordinary`, so a doc type introduced later whose name
 * extends an existing one would silently steal the shorter type's match
 * whenever it sorts first. The `#` boundary makes `bankStatements` match
 * only `bankStatements` itself or `bankStatements#<n>`, never a sibling doc
 * type that merely starts with the same letters.
 */
function valueAtInstanceKeyPrefix(view: CanonicalView, address: V1Address): AddressLookup {
  const instances = view.categories[address.category]?.instances ?? []
  const prefix = address.instanceKeyPrefix!
  const inst = instances.find((i) => i.instanceKey === prefix || i.instanceKey.startsWith(`${prefix}#`))
  if (!inst || !Object.prototype.hasOwnProperty.call(inst.fields, address.field)) return { found: false }
  return { found: true, value: inst.fields[address.field]!.value }
}

/**
 * A T-slot family member (`bankBalanceT1`, …): the row at this exact period,
 * read the same way the rendered file-field tables read it — `base` is the
 * shared legacy name every sibling in the family strips to
 * (`v1LegacyBaseNameOf`, not a second regex-strip here: reusing it means this
 * can never disagree with what `instanceRowsFromView` actually wrote onto the
 * row), and the row itself comes from `rowPairsFor` (L-4's call-local cache
 * of `instanceRowPairsFromView`) — the SAME rows and the SAME `timePeriodOf`
 * cascade the rendered tables use — not a second derivation of "which period
 * is this" that could silently disagree with what a reader sees on the
 * file-field table for the same instance.
 *
 * M-2 (round 5): a T-slot key names a SLOT, not an INSTANCE — `buildInstanceTable`
 * happily renders two columns for two rows sharing one period label, but this
 * function can only ever place ONE value under the key. Before this fix, more
 * than one row sharing `tSlot` silently picked the first (still the rule —
 * v1's own wide column could hold only one value too) with no signal that a
 * second, un-placed row existed; `multiple: true` now surfaces that choice
 * into `ambiguous`, the same way the plain-address lookup already does for
 * its own multi-instance case.
 */
function valueAtTSlot(view: CanonicalView, address: V1Address, tSlot: string, rowPairsFor: RowPairsLookup): AddressLookup {
  // L-5 (round 5): three DISTINCT not-found causes, each its own `reason` —
  // `flatRecordFromView` used to report ONE fixed string ("no T{n}
  // instance") regardless of which of these three actually happened, which
  // reads identically to a reader whether the address has no base name at
  // all, the slot has no row, or the row exists but never carried this
  // field. (The first cause is DEFENSIVE: every T-slot `mapped` key's own
  // address always contributes its base to `v1LegacyBaseNameOf`'s index —
  // see that function's own doc — so it is unreachable via `v1MigrationKeys()`
  // today; named anyway so a future change to that invariant fails loud
  // rather than falling back to a misleading "no row" message.)
  const base = v1LegacyBaseNameOf(address.category, address.field)
  if (base === null) return { found: false, reason: 'no legacy base name' }
  const rows = rowPairsFor(view, assertAdapterCategory(address.category)).map((p) => p.row)
  const withSlot = rows.filter((r) => r.timePeriod === tSlot)
  if (withSlot.length === 0) return { found: false, reason: `no ${tSlot} row` }
  const withField = withSlot.filter((r) => Object.prototype.hasOwnProperty.call(r, base))
  if (withField.length === 0) return { found: false, reason: `${tSlot} row lacks ${base}` }
  return { found: true, value: withField[0]![base], multiple: withField.length > 1 }
}

/**
 * The v1 flat record's shape, re-derived from a `CanonicalView` — the
 * migration map (`src/v1-migration-map.ts`) run FORWARD. `record` is
 * OPTIONAL: pass it to place the `relocated` keys too (the application
 * record's own surface, NOT adapter data — see below); omit it and every
 * `relocated` key reports `unplaced` instead of throwing.
 *
 * ITERATES `v1MigrationKeys()`, NOT `view.categories` — deliberately, so a
 * v1 key with no v2 value today is a REPORTED fact (`unplaced`), never a
 * silently absent one; this is how a parity spec finds its residuals. Per
 * key, dispatch on the map entry's OWN disposition:
 *
 * - `mapped` with `instanceKeyPrefix`: `valueAtInstanceKeyPrefix` (first
 *   instance whose key equals the prefix or continues it at a `#` boundary
 *   (L-3, round 5 — never a bare `startsWith`, which a longer sibling prefix
 *   could steal) — v1 held one path per pointer column, so first-in-order is
 *   the parity choice).
 * - `mapped` with `instanceKey`: `valueAtInstanceKey` (the one instance
 *   naming it).
 * - `mapped`, key ends in a bare `T[1-9]` (`T_SLOT_KEY_SUFFIX` — the
 *   `(PriorYear)?` branch is unreachable for `mapped` post-round-2, see that
 *   const's doc): `valueAtTSlot` — the T-slot family row lookup. A miss
 *   distinguishes THREE causes (L-5, round 5 — see that function's own doc):
 *   `'no legacy base name'`, `'no T{n} row'`, `'T{n} row lacks <base>'`.
 * - `mapped`, anything else: `valueAtPlainAddress` — the single-instance
 *   scalar read, `ambiguous` on a real collision.
 * - `mapped-fanout` (`incorporatedDate` only, today): resolve BOTH addresses
 *   via `valueAtPlainAddress`, in the map's own address order; place the
 *   FIRST one with a value; if a second address also has a value and it
 *   DIFFERS from the first, or either address's own lookup was itself
 *   ambiguous, record `ambiguous`. Neither address having a value → `unplaced`.
 * - `relocated`: the three top-level specials read straight off `record`
 *   (`ihsId` <- `applicationId`, `status` <- `status`, `statusDescription` <-
 *   `statusDescription`); every other relocated key walks `record.parties`
 *   -> `record.facility` -> `record.system`, PRESENCE not nullishness (H-2,
 *   round 5 — `relocatedBucketValue`, corrected from a `??` chain that fell
 *   through an explicit `null` in an earlier bucket to a LATER bucket that
 *   also happened to carry the key, silently returning the wrong bucket's
 *   value). A bucket's `null` is placed as `null` — v1 served null for an
 *   empty relocated column, and that is a real assertion, not "try the next
 *   bucket". `record` undefined, or the key present in NONE of the buckets
 *   -> `unplaced`, reason `` `relocated (surface: ${entry.surface}): not on
 *   the application record` `` (M-3, round 5 — names the surface so a
 *   parity spec can tell "the record genuinely does not carry this" from
 *   "the caller forgot a bucket"; 48 of 51 relocated keys carry
 *   `GET /lender/applications/:ihsId`, 3 carry the consent engine).
 * - `retired`, `vocabulary-gap`, `needs-decision`, `mapped-pending-build`,
 *   `structural`: NEVER placed, regardless of what the view holds —
 *   `unplaced` with the map entry's own `note`/`reason` string (never
 *   empty in the current map for these five dispositions). `structural`
 *   covers seven entries: the four instance sidecars this function DOES
 *   still surface, via the separate `instances` member below (NOT a member
 *   of `record` — v1 shipped them as sibling arrays beside the flat record,
 *   not flat keys, and this function keeps that shape); `documentMetadata`
 *   (v1's sidecar for File name/type/size — v2 carries that as canonical
 *   `document-intake` fields, so it has no destination of its OWN); `fieldProvenance`
 *   (v1's sidecar map — superseded by the per-value envelope; see
 *   `fieldProvenanceFromView`, which is the v2 equivalent for a caller that
 *   wants it); `invoiceInstances` (no invoice category exists in the
 *   registry yet).
 *
 * VALUE COERCION: NONE. Whatever the envelope (or, for a T-slot key, the
 * `InstanceRow`) holds is placed verbatim — v2 types some values v1 stored
 * as strings (e.g. a decimal) as numbers; the consumer's own `coerceFieldValue`
 * already handles both, and stringifying here would be a second, competing
 * opinion about the value's type.
 *
 * THE OVERLAY PROJECTION: nothing to do, deliberately. When `view` was read
 * under the lender-overlay projection (`?overlay=mine`), an overlaid
 * envelope's `value` already IS the overlaid one — the same thing v1's own
 * details-merge did — so every placement above reads it through unchanged.
 * `originalValue` (the attested value an overlay replaced) has no v1-shaped
 * home; a caller that needs it reads `fieldProvenanceFromView`'s
 * `IhsFieldProvenanceWithOriginal.originalValue` instead.
 */
export function flatRecordFromView(view: CanonicalView, record?: ApplicationRecordLike): FlatRecordFromView {
  const out: Record<string, unknown> = {}
  const unplaced: { key: string; disposition: string; reason: string }[] = []
  const ambiguous: string[] = []
  // L-4 (round 5): one row-pairs rebuild per category per CALL, not per key.
  const rowPairsFor = rowPairsCache()

  for (const key of v1MigrationKeys()) {
    const entry = v1MigrationEntry(key)! // key came from the map itself; never null

    if (entry.disposition === 'mapped') {
      const address = entry.address!
      let result: AddressLookup
      let missingReason: string

      if (address.instanceKeyPrefix !== undefined) {
        result = valueAtInstanceKeyPrefix(view, address)
        missingReason = 'mapped: no instance with this key prefix'
      } else if (address.instanceKey !== undefined) {
        result = valueAtInstanceKey(view, address)
        missingReason = 'mapped: no instance with this instance key'
      } else {
        const tSlotMatch = T_SLOT_KEY_SUFFIX.exec(key)
        if (tSlotMatch) {
          const tSlot = `T${tSlotMatch[1]}`
          result = valueAtTSlot(view, address, tSlot, rowPairsFor)
          // L-5 (round 5): `result.reason` names WHICH of the three distinct
          // causes applied; the fallback below is defensive only — every
          // real miss from `valueAtTSlot` sets one.
          missingReason = result.reason ?? `no ${tSlot} instance`
        } else {
          result = valueAtPlainAddress(view, address, rowPairsFor)
          missingReason = 'mapped: no instance carries this field'
        }
      }

      if (result.found) {
        out[key] = result.value
        if (result.multiple) ambiguous.push(key)
      } else {
        unplaced.push({ key, disposition: entry.disposition, reason: missingReason })
      }
    } else if (entry.disposition === 'mapped-fanout') {
      const addresses = entry.addresses!
      let placedValue: unknown
      let placed = false
      let anyMultiple = false
      const foundValues: unknown[] = []

      for (const address of addresses) {
        const r = valueAtPlainAddress(view, address, rowPairsFor)
        if (r.multiple) anyMultiple = true
        if (r.found) {
          foundValues.push(r.value)
          if (!placed) {
            placedValue = r.value
            placed = true
          }
        }
      }

      if (placed) {
        out[key] = placedValue
        // L-1 (round 5): the SAME agreement rule the plain-address lookup
        // uses — a strict `!==` flagged two attestors reporting the
        // identical fact under different JS types (a v1 decimal string vs a
        // v2 typed number) as a disagreement.
        const disagree = foundValues.some((v) => !candidateValuesAgree(v, foundValues[0]))
        if (anyMultiple || disagree) ambiguous.push(key)
      } else {
        unplaced.push({ key, disposition: entry.disposition, reason: 'mapped-fanout: neither address has a value' })
      }
    } else if (entry.disposition === 'relocated') {
      let found: boolean
      let value: unknown
      if (key === 'ihsId') {
        value = record?.applicationId
        found = value !== undefined
      } else if (key === 'status') {
        value = record?.status
        found = value !== undefined
      } else if (key === 'statusDescription') {
        value = record?.statusDescription
        found = value !== undefined
      } else {
        const lookup = relocatedBucketValue(record, key)
        found = lookup.found
        value = lookup.value
      }

      if (found) out[key] = normalizeRelocatedValue(value)
      else {
        // M-3 (round 5): names the SURFACE (`entry.surface` — 48 of 51
        // relocated keys are `GET /lender/applications/:ihsId`, 3 are the
        // consent engine) so a parity spec can tell "the record genuinely
        // does not carry this" from "the caller forgot a bucket" — the old
        // bare string read identically for both.
        unplaced.push({
          key,
          disposition: entry.disposition,
          reason: `relocated (surface: ${entry.surface ?? 'unknown'}): not on the application record`,
        })
      }
    } else {
      // retired, vocabulary-gap, structural, needs-decision, mapped-pending-build:
      // never placed, regardless of what the view holds.
      unplaced.push({ key, disposition: entry.disposition, reason: entry.note ?? entry.reason ?? '' })
    }
  }

  return {
    record: out,
    unplaced,
    ambiguous,
    instances: {
      financialStatementInstances: instanceRowsFromView(view, assertAdapterCategory('financial-statement')),
      bankStatementInstances: instanceRowsFromView(view, assertAdapterCategory('finxtract-bank-statement')),
      epfStatementInstances: instanceRowsFromView(view, assertAdapterCategory('epf-statement')),
      payslipInstances: instanceRowsFromView(view, assertAdapterCategory('payslip')),
    },
  }
}
