import { describe, it, expect } from 'vitest'
import { buildCategoryRegistry, categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory, CanonicalFieldSpec } from './adapter-categories.js'
import { buildFileFieldTablesFromView, buildListCell, formatRatio, periodHeadingLabel } from './ihs-processing.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'
import type { FileFieldTableData, FileFieldTableItem } from './ihs-types.js'

/**
 * SYS-3728, the first live render (FinSys Client + FinHub, 2026-09-24). Each
 * case below is a defect seen on screen with every earlier test green:
 *
 *   - a ratio stored as a fraction (0.7402) printed "0.74" beside a report
 *     that prints "74.02%";
 *   - the facility table's "No." (the report's row number) was labelled
 *     "Account No.";
 *   - management-account period columns were headed "T1" / "T2";
 *   - a declared list column no row fills ("Amount (as printed)") took a
 *     column of dashes on every line;
 *   - "Report Section" (ccris / pbi-1) and "Subject Role" (principal / party)
 *     were rows, repeating what the column headings already say;
 *   - codes a category itself defines ("own", "BS,PL") printed as codes.
 *
 * All values invented.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
const DMS = 'https://dms.example/dms-general-storage/'
const h = (c: string): string => c.repeat(64)

const field = (c: AdapterCategory, name: string): CanonicalFieldSpec => {
  const f = categorySchemaOf(c).fields.find((x) => x.name === name)
  if (!f) throw new Error(`no field ${name} on ${c}`)
  return f
}

const inst = (instanceKey: string, values: Record<string, unknown>, extra: Partial<CanonicalInstance> = {}): CanonicalInstance => ({
  instanceKey,
  adapterId: 'fixture',
  adapterVersion: 1,
  fields: Object.fromEntries(
    Object.entries(values).map(([k, value]) => [k, { value: value as string, confidentiality: 'internal', origin: 'extraction', confidence: 0.97 }]),
  ),
  ...extra,
})
const intake = (key: string, documentType: string, hash: string): CanonicalInstance =>
  inst(key, { documentType, pathInDms: `${DMS}${hash}`, uploadedAt: '2026-09-01T00:00:00.000Z' })

const FACILITIES = JSON.stringify([
  { accountNo: '1', approvalDate: '2020-01-01', capacity: 'OWN', lenderType: 'COMMERCIAL BANK', accountLimit: 1500000, status: 'O', facility: 'TRMLOAN', balance: 1321922 },
  { accountNo: '2', facility: 'OVERDRAFT', accountLimit: 50000, balance: 0 },
])
const SALES = JSON.stringify([
  { code: '5000-000', term: 'SALES - HARDWARE', amount: 100000.1 },
  { code: '5010-000', term: 'SALES - SERVICE', amount: 20000.2 },
])

function view(ma: Array<Record<string, unknown>> = [
  { companyName: 'Example Sdn Bhd', mgmtPeriodYear: '2025', mgmtPeriodEnd: '2025-12-31', mgmtPeriodStart: '2025-01-01', mgmtPeriodSource: 'own', mgmtStatementsRead: 'BS,PL', mgmtRevenueTotal: 120000.3, mgmtSalesRevenueItems: SALES },
  { companyName: 'Example Sdn Bhd', mgmtPeriodYear: '2024', mgmtPeriodEnd: '2024-12-31', mgmtPeriodStart: '2024-01-01', mgmtPeriodSource: 'comparative', mgmtStatementsRead: 'PL', mgmtRevenueTotal: 90000 },
]): CanonicalView {
  return {
    ihsId: 3728,
    categories: {
      'document-intake': {
        cardinality: 'multi',
        instances: [intake('experianReports#1', 'experianReports', h('a')), intake('managementAccounts#1', 'managementAccounts', h('b'))],
      },
      [CBR]: {
        cardinality: 'multi',
        instances: [
          inst(`experianReport:${h('a')}#pbi-1`, { section: 'pbi-1', subjectRole: 'party', subjectName: 'Person A', bankruptcyRecordsCount: 0 }),
          inst(`experianReport:${h('a')}#ccris`, {
            section: 'ccris', subjectRole: 'principal', subjectName: 'Example Sdn Bhd', bureauScore: 712,
            securedOutstandingToLimitRatio: 0.7402, unsecuredOutstandingToLimitRatio: 1.5,
            outstandingCreditFacilities: FACILITIES,
          }),
        ],
      },
      [MA]: {
        cardinality: 'multi',
        instances: ma.map((values, i) => inst(`managementAccount:${h('b')}`, values, { periodPosition: i + 1 })),
      },
    },
  }
}

const table = (group: string, v: CanonicalView = view()): FileFieldTableData => {
  const t = buildFileFieldTablesFromView(v)[group]
  if (!t) throw new Error(`no table ${group}`)
  return t
}
const item = (t: FileFieldTableData, displayName: string): FileFieldTableItem => {
  const found = t.items.find((i) => i.displayName === displayName)
  if (!found) throw new Error(`no item ${displayName}: ${t.items.map((i) => i.displayName).join(', ')}`)
  return found
}
const PRINCIPAL = 'Example Sdn Bhd (principal)'

describe('R1 — a ratio is stored as a fraction and read as the percentage the report prints', () => {
  it('formatRatio: a fraction as a percentage, at most two decimals', () => {
    expect(formatRatio(0.7402)).toBe('74.02%')
    expect(formatRatio(1.5)).toBe('150%')
    expect(formatRatio(0)).toBe('0%')
    expect(formatRatio(0.123456)).toBe('12.35%')
    expect(formatRatio(12.345678)).toBe('1,234.57%')
    expect(formatRatio(null)).toBe('-')
  })

  it('a bureau ratio cell reads 74.02%, and its stored value is still the fraction', () => {
    const ratio = item(table('credit_bureau_reports'), 'Secured Outstanding / Limit')
    expect(ratio.formattedData[PRINCIPAL]).toBe('74.02%')
    expect(ratio.data[PRINCIPAL]).toBe(0.7402)
    expect(ratio.isNumeric).toBe(true)
    expect(item(table('credit_bureau_reports'), 'Unsecured Outstanding / Limit').formattedData[PRINCIPAL]).toBe('150%')
  })

  it('a number that is not a ratio is untouched (a score, a count)', () => {
    const t = table('credit_bureau_reports')
    expect(item(t, 'Bureau Score').formattedData[PRINCIPAL]).toBe('712')
    expect(item(t, 'Bankruptcy Records').formattedData['Person A (party)']).toBe('0')
  })
})

describe('R2 — the facility table\'s first column is the report\'s row number', () => {
  it('is labelled "No.", not "Account No."', () => {
    const accountNo = field(CBR, 'outstandingCreditFacilities').items!.find((i) => i.name === 'accountNo')!
    expect(accountNo.displayName).toBe('No.')
    const cell = item(table('credit_bureau_reports'), 'Outstanding Credit Facilities').list![PRINCIPAL]!
    expect(cell.columns[0]).toMatchObject({ name: 'accountNo', label: 'No.' })
  })
})

describe('R3 — a declared list column no row fills is not shown', () => {
  it('management-account lines have no "Amount (as printed)" column when every amount parsed', () => {
    const cell = item(table('management_accounts'), 'Sales Revenue (Lines)').list!['T1']!
    expect(cell.columns.map((c) => c.name)).toEqual(['code', 'term', 'amount'])
  })

  it('it appears when one line was unreadable', () => {
    const cell = buildListCell(
      JSON.stringify([{ code: '1', term: 'A', amount: 5 }, { term: 'B', amountAsPrinted: 'illegible' }]),
      field(MA, 'mgmtSalesRevenueItems'),
    )
    expect(cell.columns.map((c) => c.name)).toEqual(['code', 'term', 'amount', 'amountAsPrinted'])
    expect(cell.rows[0]!.amountAsPrinted).toBe('-')
  })

  it('facilities show only the columns some facility fills, in declared order', () => {
    const cell = item(table('credit_bureau_reports'), 'Outstanding Credit Facilities').list![PRINCIPAL]!
    expect(cell.columns.map((c) => c.name)).toEqual([
      'accountNo', 'approvalDate', 'capacity', 'lenderType', 'accountLimit', 'status', 'facility', 'balance',
    ])
  })

  it('an invalid cell keeps its one marker column', () => {
    const cell = buildListCell('[{"nope":1}]', field(MA, 'mgmtSalesRevenueItems'))
    expect(cell.invalid).toBe(true)
    expect(cell.columns.map((c) => c.name)).toEqual(['value'])
  })
})

describe('R4 — what the column headings already say is not repeated as a row', () => {
  it('no "Report Section" and no "Subject Role" row; the columns are still ordered and labelled by them', () => {
    const t = table('credit_bureau_reports')
    const names = t.items.map((i) => i.displayName)
    expect(names).not.toContain('Report Section')
    expect(names).not.toContain('Subject Role')
    expect(t.items[0]!.timePeriods).toEqual([PRINCIPAL, 'Person A (party)'])
    expect(names).toContain('Subject Name')
  })
})

describe('R5 — a code the category itself defines reads as words', () => {
  it('period source and statements read', () => {
    const t = table('management_accounts')
    expect(item(t, 'Period Source').formattedData).toEqual({ T1: 'Own statement', T2: 'Comparative' })
    expect(item(t, 'Period Source').data).toEqual({ T1: 'own', T2: 'comparative' })
    expect(item(t, 'Statements Read').formattedData).toEqual({ T1: 'Balance sheet, Profit & loss', T2: 'Profit & loss' })
  })

  it('the labels are declared on the field', () => {
    expect(field(MA, 'mgmtPeriodSource').valueLabels).toEqual({ own: 'Own statement', comparative: 'Comparative' })
    expect(field(MA, 'mgmtStatementsRead').valueLabels).toEqual({
      BS: 'Balance sheet', PL: 'Profit & loss', 'BS,PL': 'Balance sheet, Profit & loss',
    })
  })

  it('printed bureau text stays as printed', () => {
    expect(field(CBR, 'amlCftScreening').valueLabels).toBeUndefined()
  })
})

describe('R6 — a management-account period column is headed by its period', () => {
  const fmt = (iso: string) => `<${iso}>`

  it('the table carries each column\'s year and end', () => {
    expect(table('management_accounts').periodHeadings).toEqual({
      T1: { year: '2025', end: '2025-12-31' },
      T2: { year: '2024', end: '2024-12-31' },
    })
  })

  it('the heading reads "FY<year> · to <end>" with the app\'s own date style', () => {
    expect(periodHeadingLabel({ year: '2025', end: '2025-12-31' }, fmt)).toBe('FY2025 · to <2025-12-31>')
    expect(periodHeadingLabel({ year: '2025', end: null }, fmt)).toBe('FY2025')
    expect(periodHeadingLabel({ year: null, end: '2025-12-31' }, fmt)).toBe('to <2025-12-31>')
    expect(periodHeadingLabel({ year: null, end: null }, fmt)).toBeNull()
    expect(periodHeadingLabel(undefined, fmt)).toBeNull()
  })

  it('a period with neither year nor end has no heading (the app keeps T<n>)', () => {
    const t = table('management_accounts', view([{ companyName: 'Example Sdn Bhd', mgmtRevenueTotal: 1 }]))
    expect(t.periodHeadings).toEqual({ T1: { year: null, end: null } })
  })

  it('a table of subjects has none', () => {
    expect(table('credit_bureau_reports').periodHeadings).toBeUndefined()
  })
})

describe('R5b — the loader holds valueLabels to its shape', () => {
  type Raw = Parameters<typeof buildCategoryRegistry>[0]
  const base = (override: Record<string, unknown>): Raw =>
    ({
      schemaVersion: '1.0.0',
      categories: [{
        id: 'x-cat', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x',
        fields: [{ name: 'code', type: 'string', description: 'd', ...override }],
      }],
    }) as unknown as Raw

  it('accepts a string field\'s map and freezes it', () => {
    const f = buildCategoryRegistry(base({ valueLabels: { a: 'Alpha' } })).all[0]!.fields[0]!
    expect(f.valueLabels).toEqual({ a: 'Alpha' })
    expect(Object.isFrozen(f.valueLabels)).toBe(true)
  })

  it.each([
    ['on a number', { type: 'number', valueLabels: { '1': 'One' } }, /only a string field/],
    ['an empty map', { valueLabels: {} }, /non-empty object/],
    ['an array', { valueLabels: ['a'] }, /non-empty object/],
    ['a blank label', { valueLabels: { a: ' ' } }, /invalid label/],
    ['an untrimmed label', { valueLabels: { a: ' A' } }, /invalid label/],
    ['a non-string label', { valueLabels: { a: 1 } }, /invalid label/],
  ])('refuses %s', (_l, override, message) => {
    expect(() => buildCategoryRegistry(base(override))).toThrow(message)
  })
})
