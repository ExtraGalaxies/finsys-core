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
import { allCategories } from './adapter-categories.js'
import type { TaggedFieldData } from './document-types.js'
import displayNamesData from './data/form-field-display-names.json' with { type: 'json' }

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
    cachedMonetaryFieldNames = new Set(
      allCategories().flatMap((c) => c.fields.filter((f) => f.kind === 'money').map((f) => f.name))
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

interface ParsedDocFile {
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


function inferValueFormat(fieldName: string, value: unknown): IhsValueFormat {
  const currencyFields = new Set([
    'totalFinancing',
    'monthlyGrossIncome',
    'approvedAmount',
    'monthlyInstallment',
  ])
  if (currencyFields.has(fieldName)) return IhsValueFormat.CURRENCY

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
