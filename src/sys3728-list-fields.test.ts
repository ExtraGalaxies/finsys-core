import { describe, it, expect } from 'vitest'
import { buildCategoryRegistry, categorySchemaOf, allCategories, isListField } from './adapter-categories.js'
import type { AdapterCategory, CanonicalFieldSpec } from './adapter-categories.js'
import { buildFileFieldTablesFromInstances, buildFileFieldTablesFromView, buildListCell, instanceRowsFromView } from './ihs-processing.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'
import type { FileFieldTableItem, IhsListCell } from './ihs-types.js'
import categoriesData from './data/adapter-categories.json' with { type: 'json' }

/**
 * List fields.
 *
 * Every table a credit-bureau report or a management account prints was
 * declared `type: "string"` and described in prose as "a JSON-encoded list".
 * Nothing machine-readable said it was a list or what its items were, so the
 * table builder emitted the stored JSON as one text cell and both apps printed
 * a wall of JSON. The data itself was right.
 *
 * The fixtures below carry the STRUCTURE finsys-api's mappers write today (the
 * row keys, their order, the JSON types), with every value invented.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
const DMS = 'https://dms.example/dms-general-storage/'
const h = (c: string): string => c.repeat(64)

const fields = (c: AdapterCategory) => categorySchemaOf(c).fields
const field = (c: AdapterCategory, name: string): CanonicalFieldSpec => {
  const f = fields(c).find((x) => x.name === name)
  if (!f) throw new Error(`no field ${name} on ${c}`)
  return f
}
const itemNames = (c: AdapterCategory, name: string) => (field(c, name).items ?? []).map((i) => i.name)

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

// Exactly the shape the management-account mapper stores: one JSON string per period.
const TRADE_RECEIVABLES_T1 = JSON.stringify([
  { code: '1000-000', term: 'EXAMPLE TEXT 56', amount: -1719587.11 },
  { code: '1000-000', term: 'EXAMPLE TEXT 57', amount: -8806 },
])
// A line whose figure did not parse keeps its printed text and has no amount.
const OTHER_DEBTORS_T1 = JSON.stringify([
  { code: 'ABC-000', term: 'EXAMPLE TEXT 60', amount: 1000 },
  { term: 'EXAMPLE TEXT 61', amountAsPrinted: 'illegible' },
])

// The shape finsys-api stores for outstanding credit TODAY: one row per printed
// line, kebab-case keys straight from the extraction, approval / collateral /
// facility lines as separate rows.
const OLD_FLAT_FACILITIES = JSON.stringify([
  { no: '1', date: '01/01/2025', capacity: 'EXAMPLE TEXT 13', 'lender-type': 'EXAMPLE TEXT 14', 'inst-amt-rm': '1,000.00', 'col-type': 'EXAMPLE TEXT 15' },
  { 'col-type': 'EXAMPLE TEXT 16' },
  { sts: 'EXAMPLE TEXT 17', facility: 'EXAMPLE TEXT 18', 'total-outstanding-balance-rm': '1,000.00', 'conduct-of-account-m02': '0' },
])

// The shape finsys-api is moving outstanding credit TO: one row per facility.
const FACILITY_ROWS = JSON.stringify([
  {
    accountNo: '1', approvalDate: '2025-01-01', capacity: 'OWN', lenderType: 'COMMERCIAL BANK', accountLimit: 250000,
    collateralTypes: 'PROPERTY', status: 'O', facility: 'TERM LOAN', balance: 123456.7, balanceUpdated: '2026-06-01',
    instalment: 2500, repaymentTerm: 'MONTHLY', conduct12m: '0 0 0 0 0 0 0 0 0 0 0 0',
  },
  { accountNo: '2', facility: 'OVERDRAFT', accountLimit: 50000, balance: 0 },
])

function view(): CanonicalView {
  return {
    ihsId: 3728,
    categories: {
      'document-intake': {
        cardinality: 'multi',
        instances: [intake('experianReports#1', 'experianReports', h('a')), intake('managementAccounts#1', 'managementAccounts', h('b'))],
      },
      [CBR]: {
        cardinality: 'multi',
        // Wire order deliberately NOT section order: the principal comes last,
        // and pbi-2 precedes pbi-1.
        instances: [
          inst(`experianReport:${h('a')}#pbi-2`, { section: 'pbi-2', subjectRole: 'party', subjectName: 'Person B', bureauScore: 640 }),
          inst(`experianReport:${h('a')}#pbi-1`, {
            section: 'pbi-1', subjectRole: 'party', subjectName: 'Person A', bureauScore: 690,
            outstandingCreditFacilities: OLD_FLAT_FACILITIES,
          }),
          inst(`experianReport:${h('a')}#ccris`, {
            section: 'ccris', subjectRole: 'principal', subjectName: 'Example Sdn Bhd', bureauScore: 712,
            outstandingCreditFacilities: FACILITY_ROWS,
            directorsAndOfficers: JSON.stringify([{ name: 'Person A', designation: 'DIRECTOR', 'appointment-date': '2020-01-01' }]),
          }),
        ],
      },
      [MA]: {
        cardinality: 'multi',
        instances: [
          inst(`managementAccount:${h('b')}`, {
            companyName: 'Example Sdn Bhd', mgmtTotalAssets: 950000,
            mgmtTradeReceivablesItems: TRADE_RECEIVABLES_T1, mgmtOtherDebtorsItems: OTHER_DEBTORS_T1,
          }, { periodPosition: 1 }),
          inst(`managementAccount:${h('b')}`, { companyName: 'Example Sdn Bhd', mgmtTotalAssets: 800000 }, { periodPosition: 2 }),
        ],
      },
    },
  }
}

const item = (group: string, displayName: string): FileFieldTableItem => {
  const table = buildFileFieldTablesFromView(view())[group]
  if (!table) throw new Error(`no table ${group}`)
  const found = table.items.find((i) => i.displayName === displayName)
  if (!found) throw new Error(`no item ${displayName} in ${group}: ${table.items.map((i) => i.displayName).join(', ')}`)
  return found
}
const cell = (it: FileFieldTableItem, label: string): IhsListCell => {
  const c = it.list?.[label]
  if (!c) throw new Error(`no list cell ${label}`)
  return c
}

// ── A. The field model ─────────────────────────────────────────────────

describe('SYS-3728 — list is a field type, with an item schema', () => {
  it('management account: all 36 line-item categories are lists of code / term / amount (money) / amount as printed', () => {
    const lists = fields(MA).filter((f) => f.type === 'list')
    expect(lists).toHaveLength(36)
    expect(lists.every((f) => f.name.endsWith('Items'))).toBe(true)
    for (const f of lists) {
      expect(f.items, f.name).toEqual([
        { name: 'code', displayName: 'Code', type: 'string', maxLength: 256 },
        { name: 'term', displayName: 'Term', type: 'string', maxLength: 256 },
        { name: 'amount', displayName: 'Amount', type: 'number', kind: 'money' },
        // The mapper keeps a figure it could not parse as its printed text.
        { name: 'amountAsPrinted', displayName: 'Amount (as printed)', type: 'string', maxLength: 256 },
      ])
    }
    expect(fields(MA).filter((f) => f.type === 'string').map((f) => f.name)).not.toContainEqual(expect.stringMatching(/Items$/))
  })

  it('credit bureau report: every table is a list, and no scalar is', () => {
    expect(fields(CBR).filter((f) => f.type === 'list').map((f) => f.name)).toEqual([
      'shareholdingInterests', 'directorsAndOfficers', 'shareholdersAndMembers', 'outstandingCreditFacilities',
      'creditApplications', 'specialAttentionAccounts', 'suitsAsDefendant', 'limitedDetailSuitsAsDefendant',
      'suitsAsPlaintiff', 'windingUpActionsAsDefendant', 'windingUpActionsAsPetitioner', 'bankruptcyActions',
      'bankruptcyActionCreditors', 'tradeCreditReferences', 'nonBankLenderFacilities',
    ])
    // Still 76 fields: a type changed, nothing was added or removed.
    expect(fields(CBR)).toHaveLength(76)
  })

  it('outstanding credit is one row per FACILITY, in the fixed shape (the one list NOT mirrored from the producer), with the three amounts as money', () => {
    expect(field(CBR, 'outstandingCreditFacilities').items).toEqual([
      { name: 'accountNo', displayName: 'No.', type: 'string', maxLength: 256 },
      { name: 'approvalDate', displayName: 'Approval Date', type: 'string', maxLength: 256, format: 'date' },
      { name: 'capacity', displayName: 'Capacity', type: 'string', maxLength: 256 },
      { name: 'lenderType', displayName: 'Lender Type', type: 'string', maxLength: 256 },
      { name: 'accountLimit', displayName: 'Limit', type: 'number', kind: 'money' },
      { name: 'collateralTypes', displayName: 'Collateral', type: 'string', maxLength: 256 },
      { name: 'status', displayName: 'Status', type: 'string', maxLength: 256 },
      { name: 'facility', displayName: 'Facility', type: 'string', maxLength: 256 },
      { name: 'balance', displayName: 'Balance', type: 'number', kind: 'money' },
      { name: 'balanceUpdated', displayName: 'Balance Updated', type: 'string', maxLength: 256, format: 'date' },
      { name: 'instalment', displayName: 'Instalment', type: 'number', kind: 'money' },
      { name: 'repaymentTerm', displayName: 'Repayment Term', type: 'string', maxLength: 256 },
      { name: 'conduct12m', displayName: 'Conduct (12 months)', type: 'string', maxLength: 256 },
      { name: 'legalStatus', displayName: 'Legal Status', type: 'string', maxLength: 256 },
      { name: 'statusUpdated', displayName: 'Status Updated', type: 'string', maxLength: 256, format: 'date' },
      { name: 'collateralDetail', displayName: 'Collateral Detail', type: 'string', maxLength: 1024 },
    ])
  })

  it('every other bureau list mirrors the columns the producer declares, camel-cased 1:1', () => {
    const conduct = Array.from({ length: 12 }, (_, i) => `conductOfAccountM${String(i + 1).padStart(2, '0')}`)
    const collateral = ['propertyStatus', 'address', 'districtCityTown', 'postcode', 'state', 'country']
    expect(itemNames(CBR, 'directorsAndOfficers')).toEqual(['name', 'designation', 'appointmentDate'])
    expect(itemNames(CBR, 'shareholdersAndMembers')).toEqual(['name', 'shareholding', 'percentage'])
    expect(itemNames(CBR, 'shareholdingInterests')).toEqual([
      'no', 'name', 'registrationNo', 'incorporationDate', 'paidUpCapital', 'activity', 'position', 'appointed',
      'businessExpiryDate', 'shareholding', 'percentage', 'remark', 'lastUpdatedByExperian',
    ])
    const detail = [
      'no', 'date', 'sts', 'capacity', 'lenderType', 'facility', 'totalOutstandingBalanceRm', 'dateBalanceUpdated', 'limitRm',
      'prinRepymtTerm', 'colType', ...conduct, 'legalSts', 'dateStatusUpdate', ...collateral,
    ]
    expect(itemNames(CBR, 'creditApplications')).toEqual(detail)
    expect(itemNames(CBR, 'specialAttentionAccounts')).toEqual(detail)
    expect(itemNames(CBR, 'nonBankLenderFacilities')).toEqual([
      'no', 'aprvDate', 'capacity', 'accStatus', 'lenderType', 'facility', 'limitRm', 'instalmentAmountRm', 'instalmentTenorMth',
      'dateBalanceUpdated', 'totalOutstandingBalanceRm', 'prinRepymtTerm', 'colType', ...conduct, 'legalStatus', 'dateStatusUpdate',
      ...collateral,
    ])
    for (const f of ['suitsAsDefendant', 'limitedDetailSuitsAsDefendant', 'suitsAsPlaintiff', 'windingUpActionsAsDefendant', 'windingUpActionsAsPetitioner']) {
      expect(itemNames(CBR, f), f).toHaveLength(24)
      expect(itemNames(CBR, f), f).toEqual(expect.arrayContaining(['caseNo', 'plaintiff', 'defendant', 'amountClaimed', 'caseStatus', 'solicitor']))
    }
    expect(itemNames(CBR, 'bankruptcyActions')[0]).toBe('status')
    expect(itemNames(CBR, 'bankruptcyActionCreditors')).toEqual(['creditorsName', 'creditorsIcPpLocalNoRegNo'])
    expect(itemNames(CBR, 'tradeCreditReferences')).toHaveLength(14)
    // Second review: an amount column is a parsed number (money), never printed text; every
    // other column is text, dates ISO (sys3728-airtight pins which).
    const moneyCols = fields(CBR).filter((x) => x.type === 'list' && x.name !== 'outstandingCreditFacilities')
      .flatMap((f) => (f.items ?? []).filter((i) => i.type === 'number').map((i) => `${f.name}.${i.name}:${i.kind}`))
    expect(moneyCols.sort()).toEqual([
      'bankruptcyActions.amountClaimed:money', 'creditApplications.limitRm:money', 'creditApplications.totalOutstandingBalanceRm:money',
      'limitedDetailSuitsAsDefendant.amountClaimed:money', 'nonBankLenderFacilities.instalmentAmountRm:money',
      'nonBankLenderFacilities.limitRm:money', 'nonBankLenderFacilities.totalOutstandingBalanceRm:money',
      'shareholdingInterests.paidUpCapital:money', 'specialAttentionAccounts.limitRm:money',
      'specialAttentionAccounts.totalOutstandingBalanceRm:money', 'suitsAsDefendant.amountClaimed:money',
      'suitsAsPlaintiff.amountClaimed:money', 'tradeCreditReferences.amountDue:money',
      'windingUpActionsAsDefendant.amountClaimed:money', 'windingUpActionsAsPetitioner.amountClaimed:money',
    ])
    // A vendor-specific KEY is mirrored as the producer writes it; its LABEL stays vendor-neutral.
    const updated = field(CBR, 'shareholdingInterests').items!.find((i) => i.name === 'lastUpdatedByExperian')!
    expect(updated.displayName).toBe('Last Updated by Bureau')
  })

  it('a list field declares no kind, unit, range or fact — it is never a scorable quantity', () => {
    const lists = allCategories().flatMap((c) => c.fields).filter((f) => f.type === 'list')
    expect(lists.length).toBe(51)
    for (const f of lists) {
      expect(isListField(f), f.name).toBe(true)
      expect(f.kind, f.name).toBeUndefined()
      expect(f.unit, f.name).toBeUndefined()
      expect(f.range, f.name).toBeUndefined()
      expect(f.fact, f.name).toBeUndefined()
    }
    for (const f of allCategories().flatMap((c) => c.fields).filter((x) => x.type !== 'list')) {
      expect(isListField(f), f.name).toBe(false)
      expect(f.items, f.name).toBeUndefined()
    }
  })

  it('the stored value is still a string: the list-typed fields keep their "JSON-encoded list" wording', () => {
    for (const f of allCategories().flatMap((c) => c.fields).filter((x) => x.type === 'list')) {
      expect(f.description, f.name).toMatch(/^JSON-encoded list/)
    }
  })
})

describe('SYS-3728 — the loader refuses a malformed list declaration', () => {
  type Raw = Parameters<typeof buildCategoryRegistry>[0]
  const base = (fieldOverride: Record<string, unknown>, extra: Record<string, unknown> = {}): Raw =>
    ({
      schemaVersion: '1.0.0',
      categories: [
        {
          id: 'x-cat', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x',
          fields: [
            { name: 'label', type: 'string', description: 'd' },
            { name: 'role', type: 'string', kind: 'enum', description: 'd' },
            { name: 'lines', description: 'JSON-encoded list', type: 'list', items: [{ name: 'code', displayName: 'Code', type: 'string' }], ...fieldOverride },
          ],
          ...extra,
        },
      ],
    }) as unknown as Raw

  it('accepts a well-formed one', () => {
    const reg = buildCategoryRegistry(base({}))
    expect(reg.all[0]!.fields[2]).toMatchObject({ type: 'list', items: [{ name: 'code', displayName: 'Code', type: 'string' }] })
  })

  it.each([
    ['no items', { items: undefined }, /must declare items/],
    ['empty items', { items: [] }, /must declare items/],
    ['duplicate item names', { items: [{ name: 'a', displayName: 'A', type: 'string' }, { name: 'a', displayName: 'A2', type: 'string' }] }, /duplicate item "a"/],
    ['an invalid item type', { items: [{ name: 'a', displayName: 'A', type: 'boolean' }] }, /item "a".*invalid type/],
    ['a money item that is not a number', { items: [{ name: 'a', displayName: 'A', type: 'string', kind: 'money' }] }, /item "a".*money.*number/],
    ['an unknown item kind', { items: [{ name: 'a', displayName: 'A', type: 'number', kind: 'enum' }] }, /item "a".*invalid kind/],
    ['an item with no display name', { items: [{ name: 'a', type: 'string' }] }, /item "a".*displayName/],
    ['an item with no name', { items: [{ displayName: 'A', type: 'string' }] }, /item.*non-empty name/],
    ['an unknown item property', { items: [{ name: 'a', displayName: 'A', type: 'string', unit: 'count' }] }, /item "a".*unknown property "unit"/],
    ['a kind on the list itself', { kind: 'money' }, /list.*kind/],
    ['a unit on the list itself', { unit: 'count' }, /list.*unit/],
    ['a range on the list itself', { range: [0, 1] }, /list.*range/],
    ['a fact on the list itself', { fact: 'lines' }, /list.*fact/],
  ])('refuses %s', (_label, override, message) => {
    expect(() => buildCategoryRegistry(base(override as Record<string, unknown>))).toThrow(message)
  })

  it('refuses items on a field that is not a list', () => {
    const raw = base({})
    ;(raw.categories[0]!.fields[0] as unknown as Record<string, unknown>).items = [{ name: 'a', displayName: 'A', type: 'string' }]
    expect(() => buildCategoryRegistry(raw)).toThrow(/"label".*items.*only a list/)
  })

  it('instanceColumns: accepts a declaration naming its own string / enum fields', () => {
    const reg = buildCategoryRegistry(base({}, { instanceColumns: { labelField: 'label', roleField: 'role', roleOrder: ['a', 'b'], sequenceField: 'label' } }))
    expect(reg.all[0]!.instanceColumns).toEqual({ labelField: 'label', roleField: 'role', roleOrder: ['a', 'b'], sequenceField: 'label' })
  })

  it.each([
    ['a label field it does not declare', { labelField: 'nope' }, /labelField "nope"/],
    ['a list as the label', { labelField: 'lines' }, /labelField "lines".*string/],
    ['a role field that is not an enum', { labelField: 'label', roleField: 'label', roleOrder: ['a'] }, /roleField "label".*enum/],
    ['a role field without an order', { labelField: 'label', roleField: 'role' }, /roleOrder/],
    ['a duplicated role', { labelField: 'label', roleField: 'role', roleOrder: ['a', 'a'] }, /roleOrder/],
    ['an unknown sequence field', { labelField: 'label', sequenceField: 'nope' }, /sequenceField "nope"/],
    ['a list as the sequence', { labelField: 'label', sequenceField: 'lines' }, /sequenceField "lines".*string/],
    ['a list as the document label', { labelField: 'label', documentLabelField: 'lines' }, /documentLabelField "lines".*string/],
    ['an unknown document label field', { labelField: 'label', documentLabelField: 'nope' }, /documentLabelField "nope"/],
    ['an unknown property', { labelField: 'label', sortBy: 'x' }, /unknown property "sortBy"/],
  ])('instanceColumns: refuses %s', (_label, ic, message) => {
    expect(() => buildCategoryRegistry(base({}, { instanceColumns: ic }))).toThrow(message)
  })

  it('the shipped data file loads (its declarations pass every rule above)', () => {
    expect(() => buildCategoryRegistry(categoriesData as unknown as Raw)).not.toThrow()
    expect(categorySchemaOf(CBR).instanceColumns).toEqual({
      labelField: 'subjectName', roleField: 'subjectRole', roleOrder: ['principal', 'party'], sequenceField: 'section',
      documentLabelField: 'reportOrderDate',
    })
    expect(categorySchemaOf(MA).instanceColumns).toBeUndefined()
  })
})

// ── B. The table cell ──────────────────────────────────────────────────

describe('SYS-3728 — a list field renders as rows, never as its JSON', () => {
  it('management account "Trade Receivables": code / term / amount rows, amounts formatted as money', () => {
    const it0 = item('management_accounts', 'Trade Receivables (Lines)')
    expect(it0.isNumeric).toBe(false)
    const c = cell(it0, 'T1')
    expect(c.kind).toBe('list')
    expect(c.columns).toEqual([
      { name: 'code', label: 'Code', numeric: false, money: false },
      { name: 'term', label: 'Term', numeric: false, money: false },
      { name: 'amount', label: 'Amount', numeric: true, money: true },
      // No line needed its printed text, so that column is not shown (first live render).
    ])
    expect(c.rows).toEqual([
      { code: '1000-000', term: 'EXAMPLE TEXT 56', amount: '-1,719,587.11', amountAsPrinted: '-' },
      { code: '1000-000', term: 'EXAMPLE TEXT 57', amount: '-8,806', amountAsPrinted: '-' },
    ])
    expect(c.rawRows).toEqual(JSON.parse(TRADE_RECEIVABLES_T1))
    expect(c.invalid).toBeUndefined()
  })

  it('formattedData is a short count, never the JSON — the compatibility guarantee for an un-updated UI', () => {
    const it0 = item('management_accounts', 'Trade Receivables (Lines)')
    expect(it0.formattedData).toEqual({ T1: '2 entries', T2: '-' })
    // `data` still carries the stored value, unchanged.
    expect(it0.data).toEqual({ T1: TRADE_RECEIVABLES_T1, T2: null })
    // No cell for a period with no value.
    expect(Object.keys(it0.list!)).toEqual(['T1'])
    // Nothing on any table reads as JSON any more.
    for (const t of Object.values(buildFileFieldTablesFromView(view()))) {
      for (const i of t.items) for (const s of Object.values(i.formattedData)) expect(s, `${t.name}/${i.displayName}`).not.toMatch(/^\s*[[{]/)
    }
  })

  it('a line whose figure did not parse shows its printed text in its own declared column', () => {
    const c = cell(item('management_accounts', 'Other Debtors (Lines)'), 'T1')
    expect(c.columns.map((x) => x.name)).toEqual(['code', 'term', 'amount', 'amountAsPrinted'])
    expect(c.rows).toEqual([
      { code: 'ABC-000', term: 'EXAMPLE TEXT 60', amount: '1,000', amountAsPrinted: '-' },
      { code: '-', term: 'EXAMPLE TEXT 61', amount: '-', amountAsPrinted: 'illegible' },
    ])
  })

  it('bureau outstanding credit, in the NEW facility shape: one row per facility, money columns formatted', () => {
    const c = cell(item('credit_bureau_reports', 'Outstanding Credit Facilities'), 'Example Sdn Bhd (principal)')
    expect(c.columns.map((x) => x.name)).toEqual([
      'accountNo', 'approvalDate', 'capacity', 'lenderType', 'accountLimit', 'collateralTypes', 'status', 'facility',
      'balance', 'balanceUpdated', 'instalment', 'repaymentTerm', 'conduct12m',
      // legalStatus, statusUpdated, collateralDetail: declared, filled by no facility here, not shown.
    ])
    expect(c.columns.filter((x) => x.money).map((x) => x.name)).toEqual(['accountLimit', 'balance', 'instalment'])
    expect(c.rows).toHaveLength(2)
    expect(c.rows[0]).toMatchObject({ accountNo: '1', accountLimit: '250,000', balance: '123,456.7', instalment: '2,500', conduct12m: '0 0 0 0 0 0 0 0 0 0 0 0' })
    expect(c.rows[1]).toMatchObject({ accountNo: '2', approvalDate: '-', balance: '0', accountLimit: '50,000' })
  })

  it('bureau outstanding credit, in the OLD flat shape already stored: its keys are undeclared, so the cell is the invalid marker, never the content', () => {
    const it0 = item('credit_bureau_reports', 'Outstanding Credit Facilities')
    const c = cell(it0, 'Person A (party)')
    expect(it0.formattedData['Person A (party)']).toBe('(invalid value)')
    expect(it0.invalid).toEqual({ 'Person A (party)': ['undeclared-item-key'] })
    expect(it0.data['Person A (party)']).toBeNull()
    expect(c).toEqual({ kind: 'list', columns: [{ name: 'value', label: 'Value', numeric: false, money: false }], rows: [{ value: '(invalid value)' }], rawRows: [], invalid: true })
    expect(JSON.stringify(it0)).not.toContain('EXAMPLE TEXT 13')
  })

  it('a kebab-case key already in storage lands in its camel-case column', () => {
    const c = cell(item('credit_bureau_reports', 'Directors and Officers'), 'Example Sdn Bhd (principal)')
    expect(c.rows).toEqual([{ name: 'Person A', designation: 'DIRECTOR', appointmentDate: '2020-01-01' }])
    expect(c.columns.map((x) => x.name)).not.toContain('other')
  })
})

describe('SYS-3728 — a list column is never numeric, whatever its name says', () => {
  it('through the override path with NO numericColumnNames (the name heuristic would say "cash" is numeric)', () => {
    const t = buildFileFieldTablesFromInstances(
      { g: [{ instanceKey: 'x', timePeriod: 'T1', mgmtCashAtBankItems: '[{"code":"1","term":"t","amount":5}]' }] },
      undefined,
      { g: { displayName: 'G', baseColumnNames: ['mgmtCashAtBankItems'], fieldSpecs: { mgmtCashAtBankItems: field(MA, 'mgmtCashAtBankItems') } } },
    )['g']!.items[0]!
    expect(t.isNumeric).toBe(false)
    expect(t.formattedData).toEqual({ T1: '1 entry' })
  })
})

describe('SYS-3728 — buildListCell holds the value to the write contract before rendering it', () => {
  const MARKER = { kind: 'list', columns: [{ name: 'value', label: 'Value', numeric: false, money: false }], rows: [{ value: '(invalid value)' }], rawRows: [], invalid: true }
  const lines = () => field(MA, 'mgmtTradeReceivablesItems')
  const SECRET = 'S3CRET-9f2c'

  it.each([
    ['invalid JSON', `[{"code":"${SECRET}`],
    ['a JSON object, not an array', `{"code":"${SECRET}"}`],
    ['a JSON scalar', '42'],
    ['a row that is not an object', `[{"code":"1"}, "${SECRET}"]`],
    ['an undeclared key', `[{"code":"1","${SECRET}":"x"}]`],
    ['a nested value in a declared column', `[{"code":{"a":"${SECRET}"}}]`],
    ['a number column holding printed text', '[{"amount":"1,000.00"}]'],
    ['a number column holding a hex string', '[{"amount":"0x10"}]'],
    ['a number column holding a boolean', '[{"amount":true}]'],
    ['a string column holding a control character', `[{"term":"${SECRET}\u0000"}]`],
    ['a string column holding a JSON array', `[{"term":"[\\"${SECRET}\\"]"}]`],
  ])('%s → the invalid marker, carrying none of the stored content', (_l, raw) => {
    const c = buildListCell(raw, lines())
    expect(c).toEqual(MARKER)
    expect(JSON.stringify(c)).not.toContain(SECRET)
  })

  it('a non-finite number in an already-parsed array is the invalid marker too', () => {
    expect(buildListCell([{ amount: Number.NaN }], lines())).toEqual(MARKER)
    expect(buildListCell([{ amount: Number.POSITIVE_INFINITY }], lines())).toEqual(MARKER)
  })

  it('a spec that is not a list renders nothing but the marker', () => {
    expect(buildListCell('[]', field(CBR, 'subjectName'))).toEqual(MARKER)
  })

  it('a money column carries the denomination when the cell has one', () => {
    expect(buildListCell('[{"amount":1500.5}]', lines(), 'MYR').rows[0]!.amount).toBe('MYR\u00a01,500.50')
  })

  it('an absent value renders "-", never 0', () => {
    expect(buildListCell([{ code: 'A', amount: null }], lines()).rows[0]).toEqual({ code: 'A', term: '-', amount: '-', amountAsPrinted: '-' })
  })

  it('accepts an already-parsed array', () => {
    expect(buildListCell([{ code: 'A', amount: 1 }], lines()).rows).toEqual([{ code: 'A', term: '-', amount: '1', amountAsPrinted: '-' }])
  })
})

// ── C. Column labels ───────────────────────────────────────────────────

describe('SYS-3728 — a bureau report is labeled by subject, not by a period it does not have', () => {
  it('columns are "<subject> (<role>)", principal first, then parties in section order', () => {
    const score = item('credit_bureau_reports', 'Bureau Score')
    expect(score.timePeriods).toEqual(['Example Sdn Bhd (principal)', 'Person A (party)', 'Person B (party)'])
    expect(score.data).toEqual({ 'Example Sdn Bhd (principal)': 712, 'Person A (party)': 690, 'Person B (party)': 640 })
    expect(score.timePeriods.some((l) => /^T\d/.test(l))).toBe(false)
  })

  it('the rows themselves are untouched: instance rows keep their wire order and their period', () => {
    expect(instanceRowsFromView(view(), CBR).map((r) => [r.timePeriod, r.sourceLabel, r.subjectName])).toEqual([
      ['T1', 'pbi-2', 'Person B'], ['T1', 'pbi-1', 'Person A'], ['T1', 'ccris', 'Example Sdn Bhd'],
    ])
  })

  it('two subjects of one name stay two columns', () => {
    const v = view()
    for (const i of v.categories[CBR]!.instances) i.fields.subjectName = { ...i.fields.subjectName!, value: 'Same Name' }
    const labels = buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items[0]!.timePeriods
    expect(labels).toEqual(['Same Name (principal)', 'Same Name (party)', 'Same Name (party) (2)'])
  })

  it('a subject with no name falls back to the old label, so no column is blank', () => {
    const v = view()
    delete v.categories[CBR]!.instances[0]!.fields.subjectName
    const labels = buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items[0]!.timePeriods
    expect(labels).toEqual(['Example Sdn Bhd (principal)', 'Person A (party)', 'T1 \u00b7 pbi-2'])
  })

  it('two reports on the same subject keep their identity: the report order date joins the label', () => {
    const v = view()
    for (const i of v.categories[CBR]!.instances) i.fields.reportOrderDate = { ...i.fields.section!, value: '2026-01-01' }
    v.categories[CBR]!.instances.push(
      inst(`experianReport:${h('c')}#ccris`, { section: 'ccris', subjectRole: 'principal', subjectName: 'Example Sdn Bhd', bureauScore: 1, reportOrderDate: '2026-06-01' }),
    )
    const score = buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items.find((i) => i.displayName === 'Bureau Score')!
    expect(score.timePeriods).toEqual([
      'Example Sdn Bhd (principal) \u00b7 2026-01-01', 'Person A (party) \u00b7 2026-01-01',
      'Person B (party) \u00b7 2026-01-01', 'Example Sdn Bhd (principal) \u00b7 2026-06-01',
    ])
    expect(score.data['Example Sdn Bhd (principal) \u00b7 2026-06-01']).toBe(1)
    expect(score.data['Example Sdn Bhd (principal) \u00b7 2026-01-01']).toBe(712)
  })

  it('with no order date, the report is named by its position', () => {
    const v = view()
    v.categories[CBR]!.instances.push(
      inst(`experianReport:${h('c')}#ccris`, { section: 'ccris', subjectRole: 'principal', subjectName: 'Example Sdn Bhd', bureauScore: 1 }),
    )
    const labels = buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items[0]!.timePeriods
    expect(labels).toEqual([
      'Example Sdn Bhd (principal) \u00b7 report 1', 'Person A (party) \u00b7 report 1', 'Person B (party) \u00b7 report 1',
      'Example Sdn Bhd (principal) \u00b7 report 2',
    ])
  })

  it('one report: no report identity in the label', () => {
    const v = view()
    for (const i of v.categories[CBR]!.instances) i.fields.reportOrderDate = { ...i.fields.section!, value: '2026-01-01' }
    expect(buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items[0]!.timePeriods).toEqual([
      'Example Sdn Bhd (principal)', 'Person A (party)', 'Person B (party)',
    ])
  })

  it('two reports: each document keeps its principal first', () => {
    const v = view()
    v.categories[CBR]!.instances.unshift(
      inst(`experianReport:${h('c')}#pbi-1`, { section: 'pbi-1', subjectRole: 'party', subjectName: 'Person C', bureauScore: 1 }),
      inst(`experianReport:${h('c')}#iriss`, { section: 'iriss', subjectRole: 'principal', subjectName: 'Person D', bureauScore: 2 }),
    )
    const labels = buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items[0]!.timePeriods
    // Documents keep the order the rows arrive in (the uploaded report, then
    // the one with no intake row); WITHIN each, the principal leads.
    expect(labels).toEqual([
      'Example Sdn Bhd (principal) \u00b7 report 1', 'Person A (party) \u00b7 report 1', 'Person B (party) \u00b7 report 1',
      'Person D (principal) \u00b7 report 2', 'Person C (party) \u00b7 report 2',
    ])
  })

  // The real sections sort correctly by name alone ("ccris" / "iriss" before
  // "pbi-"), so these two use the override path to pin each rule on its own.
  const subjects = (rows: Array<Record<string, unknown>>) =>
    buildFileFieldTablesFromInstances(
      { g: rows.map((r, i) => ({ instanceKey: `doc#${i}`, timePeriod: 'T1', ...r })) },
      undefined,
      { g: { displayName: 'G', baseColumnNames: ['n'], instanceColumns: { labelField: 'who', roleField: 'role', roleOrder: ['principal', 'party'], sequenceField: 'seq' } } },
    )['g']!.items[0]!.timePeriods

  it('the role order decides before the sequence does', () => {
    expect(subjects([
      { who: 'P1', role: 'party', seq: 'a', n: 1 },
      { who: 'Main', role: 'principal', seq: 'z', n: 2 },
    ])).toEqual(['Main (principal)', 'P1 (party)'])
  })

  it('the sequence is compared naturally: pbi-2 before pbi-10', () => {
    expect(subjects([
      { who: 'Ten', role: 'party', seq: 'pbi-10', n: 1 },
      { who: 'Two', role: 'party', seq: 'pbi-2', n: 2 },
    ])).toEqual(['Two (party)', 'Ten (party)'])
  })

  it('an undeclared role sorts after every declared one, and keeps its raw label', () => {
    expect(subjects([
      { who: 'X', role: 'observer', seq: 'a', n: 1 },
      { who: 'P', role: 'party', seq: 'b', n: 2 },
    ])).toEqual(['P (party)', 'X (observer)'])
  })

  it('periodised categories keep their period labels', () => {
    expect(item('management_accounts', 'Total Assets').timePeriods).toEqual(['T1', 'T2'])
  })
})

describe('SYS-3728 — the generated list-name union agrees with the registry', () => {
  it('ListFieldName names exactly the list fields', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(new URL('./vocabulary.generated.ts', import.meta.url), 'utf8')
    const block = text.slice(text.indexOf('export type ListFieldNameLiteral ='), text.indexOf(';', text.indexOf('export type ListFieldNameLiteral =')))
    const names = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()
    const lists = allCategories().flatMap((c) => c.fields).filter((f) => f.type === 'list').map((f) => f.name as string)
    expect(names).toEqual([...new Set(lists)].sort())
    // Compile-time: a list name is a canonical name, and a non-list is not a list name.
    const ok: import('./adapter-categories.js').ListFieldName = 'mgmtTradeReceivablesItems'
    // @ts-expect-error — a number field is not a list
    const bad: import('./adapter-categories.js').ListFieldName = 'bureauScore'
    expect([ok, bad]).toHaveLength(2)
  })
})
