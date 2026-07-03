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
} from './ihs-types.js'
import { getBaseFieldSpecs, getBaseCategories, getBaseFieldSpecMap } from './catalogs.js'
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

const FIELD_GROUP_PREFIXES: [string, string][] = [
  ['bank_statement', 'bank_statements'],
  ['financials', 'financials'],
  ['epf_statement', 'epf_statements'],
  ['payslip_statement', 'payslip_statements'],
  ['ssm', 'ssm_documents'],
  ['form9', 'form9'],
  ['ic', 'ic_documents'],
]

export function groupFieldsByPattern(fields: FieldData[]): Record<string, FieldData[]> {
  const groups: Record<string, FieldData[]> = {}
  for (const field of fields) {
    if (!field.name) continue
    let groupName = field.name
    for (const [prefix, group] of FIELD_GROUP_PREFIXES) {
      if (field.name.startsWith(prefix)) {
        groupName = group
        break
      }
    }
    if (!groups[groupName]) groups[groupName] = []
    groups[groupName].push(field)
  }
  return groups
}

/** Human-friendly display names for field groups (when a group combines multiple fields). */
const GROUP_DISPLAY_NAMES: Record<string, string> = {
  bank_statements: 'Bank Statements',
  financials: 'Audited Financial Statements',
  epf_statements: 'EPF Statements',
  payslip_statements: 'Payslip Statements',
  form9: 'Form 9 / Section 17 / Form D',
  ssm_documents: 'SSM Company Information',
  ic_documents: 'Identification Card',
}

/** Returns human-friendly display names for field groups. */
export function getGroupDisplayNames(): Record<string, string> {
  return GROUP_DISPLAY_NAMES
}

// ── File-field table building ──────────────────────────────────

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

function formatValue(value: unknown, numeric: boolean): string {
  if (value === null || value === undefined || value === '') return '-'
  if (numeric) {
    const num = Number(value)
    if (!isNaN(num))
      return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
    GROUP_DISPLAY_NAMES[groupName] || fields[0]?.displayName || getDisplayName(groupName)

  if (isTimeSeries) {
    const columnGroups = groupColumnsByTimePeriod(allColumns)
    const items: FileFieldTableItem[] = []

    for (const [baseName, periodMap] of Object.entries(columnGroups)) {
      const numeric = isNumericField(baseName)
      const data: Record<string, unknown> = {}
      const formattedData: Record<string, string> = {}
      const confidence: Record<string, number> = {}
      const provenance: Record<string, IhsFieldProvenance> = {}

      for (const period of periods) {
        const colName = periodMap[period]
        const value = colName ? (ihsData[colName] ?? null) : null
        data[period] = value
        formattedData[period] = formatValue(value, numeric)
        // SYS-2741: colName is the exact ihs_field_metadata key (incl. T{n} suffix).
        const prov = colName ? fieldProvenance?.[colName] : undefined
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
      const numeric = isNumericField(colName)
      // SYS-2741: single-doc columns (ssmCompanyName, companyName, icName, …) are
      // keyed directly in ihs_field_metadata — lit up here (the value-match interim
      // had to skip these because filename-based OCR lookup was unreliable).
      const prov = fieldProvenance?.[colName]
      items.push({
        displayName: getDisplayName(colName),
        timePeriods: [],
        data: { value },
        formattedData: { value: formatValue(value, numeric) },
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
