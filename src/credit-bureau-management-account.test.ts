import { describe, it, expect } from 'vitest'
import { categoriesAttestingFact, categorySchemaOf, isAdapterCategory } from './adapter-categories.js'
import {
  buildDocumentRowsFromView,
  buildFileFieldTablesFromView,
  canonicalNamedCategories,
  documentCategoryIds,
  documentsOfType,
  extractionCategoryOf,
  fieldProvenanceFromView,
  flatRecordFromView,
  getDocDisplayNames,
  getExtractableDocTypes,
  instanceRowsFromView,
  processIhsDetailsFromView,
} from './ihs-processing.js'
import { resolveExtractionStatus, resolveExtractionStatusFromView, DocExtractionStatus } from './extraction-status.js'
import { ExtractionJobStatus } from './extraction.js'
import { getDocumentTypeGroups } from './document-types.js'
import type { AdapterCategory } from './adapter-categories.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'

/**
 * SYS-3705 — credit-bureau-report and management-account, and the generic
 * fix that lets any category with NO v1 lineage render at all.
 *
 * Before this, a document type reached its extraction category only through
 * the frozen v1 migration map, and a field reached a table only through its
 * v1 legacy base name. A category born after the map had neither, so it
 * resolved to no category, rendered no table, and produced instance rows with
 * no metric keys — silently. The proof that the fix leaves every v1-lineage
 * category's rows byte-identical is sys3705-v1-lineage-golden.test.ts (its
 * doc says exactly which outputs, and which parts of them, it covers);
 * this file pins what the fix DOES.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
const DMS = 'https://dms.example/dms-general-storage/'
const h = (c: string): string => c.repeat(64)

const fields = (category: string) => categorySchemaOf(category as AdapterCategory).fields
const field = (category: string, name: string) => {
  const f = fields(category).find((x) => x.name === name)
  if (!f) throw new Error(`no field ${name} on ${category}`)
  return f
}

const inst = (
  instanceKey: string,
  values: Record<string, unknown>,
  extra: Partial<CanonicalInstance> = {},
): CanonicalInstance => ({
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

/** One bureau report (a company plus one party) and one two-period management account. */
function fixture(): CanonicalView {
  return {
    ihsId: 3705,
    categories: {
      'document-intake': {
        cardinality: 'multi',
        instances: [intake('experianReports#1', 'experianReports', h('a')), intake('managementAccounts#1', 'managementAccounts', h('b'))],
      },
      [CBR]: {
        cardinality: 'multi',
        instances: [
          inst(`experianReport:${h('a')}#pbi-1`, {
            section: 'pbi-1', subjectRole: 'party', subjectName: 'A Director', subjectRelationship: 'DIRECTOR', bureauScore: 690,
          }),
          inst(`experianReport:${h('a')}#ccris`, {
            section: 'ccris', subjectRole: 'principal', subjectName: 'Example Sdn Bhd', bureauScore: 712,
            securedOutstandingBalance: 1321922, directorsAndOfficers: '[{"name":"A Director"}]',
            notACanonicalField: 'must not render',
          }),
        ],
      },
      [MA]: {
        cardinality: 'multi',
        instances: [
          // Wire order deliberately NOT period order: the table must sort.
          inst(`managementAccount:${h('b')}#T2`, { companyName: 'Example Sdn Bhd', mgmtPeriodEnd: '2024-12-31', mgmtTotalAssets: 800000 }, { periodPosition: 2 }),
          inst(`managementAccount:${h('b')}#T1`, {
            companyName: 'Example Sdn Bhd', mgmtPeriodEnd: '2025-12-31', mgmtTotalAssets: 950000,
            mgmtCashAtBankItems: '[{"term":"Current account","amount":12000}]',
          }, { periodPosition: 1 }),
        ],
      },
    },
  }
}

describe('credit-bureau-report (SYS-3705)', () => {
  it('is registered, with its own canonical table and no v1 lineage', () => {
    expect(isAdapterCategory(CBR)).toBe(true)
    expect(categorySchemaOf(CBR).canonicalTable).toBe('ihs_alt_data_credit_bureau_report')
    expect(categorySchemaOf(CBR).legacyId).toBeUndefined()
    expect(fields(CBR).filter((f) => f.legacyName !== undefined)).toEqual([])
  })

  it('never co-attests an applicant fact — a report subject is a third party as often as the applicant', () => {
    expect(fields(CBR).filter((f) => f.fact !== undefined)).toEqual([])
  })

  it('carries the section and a principal/party role on every instance', () => {
    expect(field(CBR, 'section').type).toBe('string')
    expect(field(CBR, 'subjectRole')).toMatchObject({ type: 'string', kind: 'enum' })
  })

  it('types the score and every count as a number, and every printed amount as money', () => {
    expect(field(CBR, 'bureauScore')).toMatchObject({ type: 'number', unit: 'score' })
    const money = fields(CBR).filter((f) => f.kind === 'money').map((f) => f.name)
    expect(money).toEqual([
      'corporationPaidUpCapital',
      'securedOutstandingBalance',
      'unsecuredOutstandingBalance',
      'liabilitiesOutstanding',
      'liabilitiesTotalLimit',
      'liabilitiesFecLimit',
      'outstandingCreditTotalBalance',
      'outstandingCreditTotalLimit',
      'creditApplicationsTotalLimit',
      'nonBankLenderTotalLimit',
      'nonBankLenderTotalOutstanding',
    ])
    const counts = fields(CBR).filter((f) => f.unit === 'count')
    expect(counts.length).toBe(21)
    for (const f of counts) expect(f.type, f.name).toBe('number')
  })

  it('carries every list-shaped section as a JSON-string field (the SSM directors/shareholders precedent)', () => {
    const lists = [
      'shareholdingInterests', 'directorsAndOfficers', 'shareholdersAndMembers', 'outstandingCreditFacilities',
      'creditApplications', 'specialAttentionAccounts', 'suitsAsDefendant', 'limitedDetailSuitsAsDefendant',
      'suitsAsPlaintiff', 'windingUpActionsAsDefendant', 'windingUpActionsAsPetitioner', 'bankruptcyActions',
      'bankruptcyActionCreditors', 'tradeCreditReferences', 'nonBankLenderFacilities',
    ]
    for (const name of lists) {
      expect(field(CBR, name).type, name).toBe('string')
      expect(field(CBR, name).description, name).toMatch(/^JSON-encoded list/)
    }
  })

  it('declares 76 fields', () => {
    expect(fields(CBR)).toHaveLength(76)
  })
})

describe('management-account (SYS-3705)', () => {
  it('is registered, with its own canonical table and no v1 lineage', () => {
    expect(isAdapterCategory(MA)).toBe(true)
    expect(categorySchemaOf(MA).canonicalTable).toBe('ihs_alt_data_management_account')
    expect(fields(MA).filter((f) => f.legacyName !== undefined)).toEqual([])
  })

  it("attests the applicant company's name, like every other company document", () => {
    expect(field(MA, 'companyName').fact).toBe('companyName')
    expect(categoriesAttestingFact('companyName')).toContain(MA)
  })

  it('namespaces every other field, because the audited statement already owns the bare accounting names', () => {
    const unprefixed = fields(MA).map((f) => f.name).filter((n) => n !== 'companyName' && !n.startsWith('mgmt'))
    expect(unprefixed).toEqual([])
  })

  it('types every printed total as money and every line-item category as a JSON-string list', () => {
    const money = fields(MA).filter((f) => f.kind === 'money')
    const items = fields(MA).filter((f) => f.name.endsWith('Items'))
    expect(money).toHaveLength(18)
    expect(items).toHaveLength(36)
    for (const f of money) expect(f.type, f.name).toBe('number')
    for (const f of items) {
      expect(f.type, f.name).toBe('string')
      expect(f.description, f.name).toMatch(/^JSON-encoded list/)
    }
    // Everything that is neither: the seven header fields saying what the period is.
    expect(fields(MA).length - money.length - items.length).toBe(7)
  })

  it('carries a host-computed revenue total, declared as NOT printed, because the statement prints revenue only as lines', () => {
    const f = field(MA, 'mgmtRevenueTotal')
    expect(f).toMatchObject({ type: 'number', kind: 'money' })
    expect(f.description).toMatch(/NOT printed/)
    expect(f.description).toMatch(/Absent if any line fails to parse/)
    // Placed with the P&L totals, ahead of cost of goods sold.
    const names = fields(MA).map((x) => x.name)
    expect(names.indexOf('mgmtRevenueTotal')).toBe(names.indexOf('mgmtCostOfGoodsSold') - 1)
  })
})

describe('document types (SYS-3705)', () => {
  it('registers both types as extractable, with a documents-table label, and neither as re-uploadable', () => {
    expect(getDocDisplayNames().experianReports).toBe('Credit Bureau Report')
    expect(getDocDisplayNames().managementAccounts).toBe('Management Accounts')
    expect(getExtractableDocTypes().has('experianReports')).toBe(true)
    expect(getExtractableDocTypes().has('managementAccounts')).toBe(true)
  })

  it('resolves each type to its category through the catalog declaration, and only those two are canonical-named', () => {
    expect(extractionCategoryOf('experianReports')).toBe(CBR)
    expect(extractionCategoryOf('managementAccounts')).toBe(MA)
    expect([...canonicalNamedCategories()].sort()).toEqual([CBR, MA])
    expect(documentCategoryIds().has(CBR)).toBe(true)
    expect(documentCategoryIds().has(MA)).toBe(true)
  })

  it('on the FLAT status path, an uploaded new-type document is never extracted from data — only a job record moves it', () => {
    const rec = { managementAccounts: '[{"path":"https://x/a"}]', experianReports: 'https://x/b' }
    const pick = (jobs?: Array<{ fileType: string; status: string }>) =>
      resolveExtractionStatus(rec, jobs).documents
        .filter((d) => d.fileType === 'managementAccounts' || d.fileType === 'experianReports')
        .map((d) => [d.fileType, d.status, d.totalColumns, d.populatedColumns.length])
    expect(pick()).toEqual([
      ['experianReports', DocExtractionStatus.Unknown, 0, 0],
      ['managementAccounts', DocExtractionStatus.Unknown, 0, 0],
    ])
    expect(pick([])).toEqual([
      ['experianReports', DocExtractionStatus.Uploaded, 0, 0],
      ['managementAccounts', DocExtractionStatus.Uploaded, 0, 0],
    ])
    expect(pick([
      { fileType: 'experianReports', status: ExtractionJobStatus.Failed },
      { fileType: 'managementAccounts', status: ExtractionJobStatus.Succeeded },
    ])).toEqual([
      ['experianReports', DocExtractionStatus.Failed, 0, 0],
      ['managementAccounts', DocExtractionStatus.Extracted, 0, 0],
    ])
  })

  it('declares no v1 columns — the flat path has nothing to read for either', () => {
    for (const t of ['experianReports', 'managementAccounts']) {
      const group = getDocumentTypeGroups().find((g) => g.documentType === t)!
      expect(group.fields.flatMap((f) => f.ihs_column_names ?? [])).toEqual([])
    }
  })
})

describe('the lineage fallback — a category with no v1 lineage renders under its canonical names (SYS-3705)', () => {
  it('management account: one row per period, keyed by canonical name, period from the coordinate, in period order', () => {
    const rows = instanceRowsFromView(fixture(), MA)
    expect(rows.map((r) => [r.timePeriod, r.periodPosition, r.mgmtTotalAssets, r.mgmtPeriodEnd])).toEqual([
      ['T1', 1, 950000, '2025-12-31'],
      ['T2', 2, 800000, '2024-12-31'],
    ])
    expect(rows[0]!.companyName).toBe('Example Sdn Bhd')
  })

  it('management account: a coordinate that names no column (non-integer) yields no period rather than an invented one', () => {
    const v = fixture()
    v.categories[MA]!.instances = [inst('managementAccount:x', { mgmtTotalAssets: 1 }, { periodPosition: 2.5 })]
    expect(instanceRowsFromView(v, MA)[0]!.timePeriod).toBeNull()
  })

  it('credit-bureau report: one row per subject entry, labeled by section, stray fields skipped', () => {
    const rows = instanceRowsFromView(fixture(), CBR)
    expect(rows.map((r) => [r.timePeriod, r.sourceLabel, r.subjectName])).toEqual([
      ['T1', 'pbi-1', 'A Director'],
      ['T1', 'ccris', 'Example Sdn Bhd'],
    ])
    expect(rows.some((r) => 'notACanonicalField' in r)).toBe(false)
  })

  it('renders a table per type, columns in registry order, numeric from the registry type and not the field name', () => {
    const tables = buildFileFieldTablesFromView(fixture())

    const ma = tables['management_accounts']!
    expect(ma.displayName).toBe('Management Accounts')
    const assets = ma.items.find((i) => i.displayName === 'Total Assets')!
    expect(assets.timePeriods).toEqual(['T1', 'T2'])
    expect(assets.data).toEqual({ T1: 950000, T2: 800000 })
    expect(assets.formattedData).toEqual({ T1: '950,000', T2: '800,000' })
    expect(assets.isNumeric).toBe(true)
    // "cash" is in the name, and the name heuristic would call it numeric; the registry says string.
    const cash = ma.items.find((i) => i.displayName === 'Cash at Bank (Lines)')!
    expect(cash.isNumeric).toBe(false)
    expect(ma.items.map((i) => i.displayName)).toEqual(['Company Name', 'Period End', 'Total Assets', 'Cash at Bank (Lines)'])

    const cbr = tables['credit_bureau_reports']!
    const score = cbr.items.find((i) => i.displayName === 'Bureau Score')!
    expect(score.timePeriods).toEqual(['T1 · pbi-1', 'T1 · ccris'])
    expect(score.data).toEqual({ 'T1 · pbi-1': 690, 'T1 · ccris': 712 })
  })

  it('joins extractions to their uploads, so the documents table and extraction status see them', () => {
    const v = fixture()
    const intakeRows = v.categories['document-intake']!.instances
    expect(documentsOfType(v, intakeRows, 'experianReports').map((d) => [d.hash, d.extraction.length, d.origin])).toEqual([
      [h('a'), 2, 'intake'],
    ])
    expect(documentsOfType(v, intakeRows, 'managementAccounts').map((d) => [d.hash, d.extraction.length])).toEqual([[h('b'), 2]])

    const status = resolveExtractionStatusFromView(v).documents.filter((d) => ['experianReports', 'managementAccounts'].includes(d.fileType))
    expect(status.map((d) => [d.fileType, d.status, d.totalColumns])).toEqual([
      ['experianReports', DocExtractionStatus.Extracted, 76],
      ['managementAccounts', DocExtractionStatus.Extracted, 61],
    ])

    const rows = buildDocumentRowsFromView(v).filter((r) => ['experianReports', 'managementAccounts'].includes(r.docType))
    expect(rows.map((r) => [r.docType, r.documentId, r.capabilities])).toEqual([
      ['experianReports', h('a'), { download: true, viewJson: true, reExtract: true, reUpload: false }],
      ['managementAccounts', h('b'), { download: true, viewJson: true, reExtract: true, reUpload: false }],
    ])
  })

  it('carries NO provenance or confidence on any cell, even when a v1 document writes the key its name-plus-period spells', () => {
    // The synthesized provenance map is keyed by v1 column name + period.
    // Form 9's companyName writes `companyNameT1`, which is exactly what the
    // management account's companyName cell in period T1 would look up — so
    // without a guard the management-account table borrows Form 9's
    // confidence dot for a value Form 9 never attested.
    const v = fixture()
    v.categories['document-intake']!.instances.push(intake('form9#1', 'form9', h('c')))
    v.categories['company-registration'] = {
      cardinality: 'single',
      instances: [inst(`form9:${h('c')}`, { companyName: 'Example Sdn Bhd', companyRegNo: '201501042079' })],
    }
    const tables = buildFileFieldTablesFromView(v)
    // Precondition: Form 9's key IS in the map, and its own table carries the dot.
    expect(fieldProvenanceFromView(v).provenance['companyNameT1']).toBeDefined()
    expect(tables['form9']!.items.find((i) => i.displayName === 'Company Name')!.confidence).toEqual({ T1: 0.97 })

    for (const group of ['credit_bureau_reports', 'management_accounts']) {
      const table = tables[group]!
      expect(table.items.length, group).toBeGreaterThan(0)
      for (const item of table.items) {
        expect(item.provenance, `${group} / ${item.displayName}`).toBeUndefined()
        expect(item.confidence, `${group} / ${item.displayName}`).toBeUndefined()
      }
    }
  })

  it('stays out of the detail panel, the v1 flat record, and the provenance map', () => {
    const v = fixture()
    // Document categories render in their own tables, never the detail panel.
    expect(processIhsDetailsFromView(v)).toEqual([])
    // flatRecordFromView is v1-map driven by design: no v1 key, no flat value.
    const record = flatRecordFromView(v).record
    expect(Object.values(record)).not.toContain(950000)
    expect(Object.values(record)).not.toContain(712)
    // No confidence dots yet: the provenance map is keyed by v1 column names.
    expect(fieldProvenanceFromView(v).provenance).toEqual({})
  })
})
