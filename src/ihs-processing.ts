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
  ['ssm', 'ssm_company_profile'],
  ['form9', 'form9'],
  ['ic', 'ic'],
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
  ssm_company_profile: 'SSM Company Profile',
  ic: 'Identification Card',
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
  ihsData: Record<string, unknown>
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

      for (const period of periods) {
        const colName = periodMap[period]
        const value = colName ? (ihsData[colName] ?? null) : null
        data[period] = value
        formattedData[period] = formatValue(value, numeric)
      }

      items.push({
        displayName: getDisplayName(baseName),
        timePeriods: periods,
        data,
        formattedData,
        type: tableType,
        isNumeric: numeric,
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
      items.push({
        displayName: getDisplayName(colName),
        timePeriods: [],
        data: { value },
        formattedData: { value: formatValue(value, numeric) },
        type: tableType,
        isNumeric: numeric,
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
  ihsData: Record<string, unknown>
): Record<string, FileFieldTableData> {
  const specs = getBaseFieldSpecs()
  const fileFields = specs.filter((f) => f.type === 'file' && f.ihs_column_names?.length)
  const grouped = groupFieldsByPattern(fileFields)

  const tables: Record<string, FileFieldTableData> = {}
  for (const [groupName, fields] of Object.entries(grouped)) {
    const table = buildTableForGroup(groupName, fields, ihsData)
    if (table && table.hasData) {
      tables[groupName] = table
    }
  }
  return tables
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
    if (field.type === 'file' && field.ihs_column_names) {
      for (const col of field.ihs_column_names) {
        fileColumnSet.add(col)
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
