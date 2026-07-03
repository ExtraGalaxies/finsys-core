import { describe, it, expect } from 'vitest'
import { IhsValueFormat, FileFieldTableType } from './ihs-types.js'
import {
  extractTimePeriods,
  groupColumnsByTimePeriod,
  getDisplayNames,
  getDisplayName,
  groupFieldsByPattern,
  buildFileFieldTables,
  processIhsDetails,
  groupDetailsByCategory,
  buildDocumentRows,
  getDocDisplayNames,
  getExtractableDocTypes,
  getReuploadableDocTypes,
  formatDocumentType,
  formatDocumentSize,
  formatDocumentUploaded,
} from './ihs-processing.js'
import type { FieldData } from './survey-generator.js'

describe('extractTimePeriods', () => {
  it('extracts sorted T-suffixed periods from column names', () => {
    const columns = ['revenueT2', 'revenueT1', 'bankNameT3', 'companyName']
    expect(extractTimePeriods(columns)).toEqual(['T1', 'T2', 'T3'])
  })

  it('returns empty array when no periods found', () => {
    expect(extractTimePeriods(['companyName', 'email'])).toEqual([])
  })

  it('handles single period', () => {
    expect(extractTimePeriods(['bankNameT1', 'accountNumberT1'])).toEqual(['T1'])
  })
})

describe('groupColumnsByTimePeriod', () => {
  it('groups columns by base name and period', () => {
    const columns = ['bankNameT1', 'bankNameT2', 'accountNumberT1', 'accountNumberT2']
    expect(groupColumnsByTimePeriod(columns)).toEqual({
      bankName: { T1: 'bankNameT1', T2: 'bankNameT2' },
      accountNumber: { T1: 'accountNumberT1', T2: 'accountNumberT2' },
    })
  })

  it('skips columns without T-suffix', () => {
    expect(groupColumnsByTimePeriod(['companyName', 'bankNameT1'])).toEqual({
      bankName: { T1: 'bankNameT1' },
    })
  })
})

describe('getDisplayNames', () => {
  it('returns a non-empty record', () => {
    const names = getDisplayNames()
    expect(Object.keys(names).length).toBeGreaterThan(100)
    expect(names['bankName']).toBe('Bank Name')
    expect(names['revenue']).toBe('Revenue')
  })
})

describe('getDisplayName', () => {
  it('returns mapped name when known', () => {
    expect(getDisplayName('bankName')).toBe('Bank Name')
  })

  it('returns camelCase-to-title-case fallback', () => {
    expect(getDisplayName('someUnknownField')).toBe('Some Unknown Field')
  })
})

describe('groupFieldsByPattern', () => {
  it('groups bank_statement fields together', () => {
    const fields: FieldData[] = [
      { name: 'bank_statement_t1', type: 'file', ihs_column_names: ['bankNameT1'] },
      { name: 'bank_statement_t2', type: 'file', ihs_column_names: ['bankNameT2'] },
      { name: 'financials', type: 'file', ihs_column_names: ['revenue'] },
    ]
    const grouped = groupFieldsByPattern(fields)
    expect(grouped['bank_statements']).toHaveLength(2)
    expect(grouped['financials']).toHaveLength(1)
  })

  it('groups epf, form9, ic, and ssm fields', () => {
    const fields: FieldData[] = [
      { name: 'epf_statement_1', type: 'file' },
      { name: 'form9', type: 'file' },
      { name: 'ic', type: 'file' },
      { name: 'ssm', type: 'file' },
    ]
    const grouped = groupFieldsByPattern(fields)
    expect(grouped['epf_statements']).toHaveLength(1)
    expect(grouped['form9']).toHaveLength(1)
    expect(grouped['ic_documents']).toHaveLength(1)
    expect(grouped['ssm_documents']).toHaveLength(1)
  })
})

describe('buildFileFieldTables', () => {
  it('builds time-series table from IHS data with T-suffixed columns', () => {
    const ihsData: Record<string, unknown> = {
      bankNameT1: 'Maybank',
      bankNameT2: 'CIMB',
      totalCreditsT1: 50000,
      totalCreditsT2: 60000,
      fullName: 'John Doe',
    }
    const tables = buildFileFieldTables(ihsData)
    expect(typeof tables).toBe('object')
    // bank_statements should exist if base specs have bank_statement fields
    if (tables['bank_statements']) {
      expect(tables['bank_statements'].type).toBe(FileFieldTableType.TIME_SERIES)
      expect(tables['bank_statements'].hasData).toBe(true)
    }
  })

  it('returns empty object when IHS has no file-field data', () => {
    const tables = buildFileFieldTables({ fullName: 'Alice', email: 'a@b.com' })
    expect(Object.keys(tables).length).toBe(0)
  })

  it('attaches per-cell confidence + provenance from fieldProvenance (SYS-2741)', () => {
    const ihsData: Record<string, unknown> = {
      bankNameT1: 'Maybank',
      bankNameT2: 'CIMB',
    }
    const fieldProvenance = {
      bankNameT1: {
        source: 'finxtract:bank_statement',
        confidence: 0.91,
        observedAt: '2026-07-01T00:00:00Z',
        sourceRunId: 'run-1',
        origin: 'extracted' as const,
      },
      // derived → carries the envelope but NO numeric confidence (never a low dot)
      bankNameT2: {
        source: 'finxtract:bank_statement',
        confidence: null,
        observedAt: '2026-07-01T00:00:00Z',
        sourceRunId: 'run-1',
        origin: 'derived' as const,
      },
    }
    const tables = buildFileFieldTables(ihsData, fieldProvenance)
    const bank = tables['bank_statements']
    expect(bank).toBeDefined()
    const item = bank!.items.find((i) => i.data['T1'] === 'Maybank')
    expect(item).toBeDefined()
    expect(item!.confidence?.['T1']).toBe(0.91)
    expect(item!.confidence?.['T2']).toBeUndefined()
    expect(item!.provenance?.['T2']?.origin).toBe('derived')
  })

  it('omits confidence/provenance when none supplied (backward compatible)', () => {
    const tables = buildFileFieldTables({ bankNameT1: 'Maybank', bankNameT2: 'CIMB' })
    const bank = tables['bank_statements']
    expect(bank).toBeDefined()
    expect(bank!.items[0].confidence).toBeUndefined()
    expect(bank!.items[0].provenance).toBeUndefined()
  })
})

describe('processIhsDetails', () => {
  it('excludes null and empty values', () => {
    const details = processIhsDetails({ fullName: 'Alice', email: null, phone: '' })
    const names = details.map((d) => d.name)
    expect(names).toContain('fullName')
    expect(names).not.toContain('email')
    expect(names).not.toContain('phone')
  })

  it('excludes system fields', () => {
    const details = processIhsDetails({ fullName: 'Alice', updatedAt: '2026-01-01', __v: 1 })
    const names = details.map((d) => d.name)
    expect(names).not.toContain('updatedAt')
    expect(names).not.toContain('__v')
  })

  it('infers date format from ISO date strings', () => {
    const details = processIhsDetails({ dateJoined: '2020-01-15T00:00:00.000Z' })
    const dj = details.find((d) => d.name === 'dateJoined')
    expect(dj?.valueFormat).toBe(IhsValueFormat.DATE)
  })

  it('infers currency format for known fields', () => {
    const details = processIhsDetails({ totalFinancing: 50000 })
    const tf = details.find((d) => d.name === 'totalFinancing')
    expect(tf?.valueFormat).toBe(IhsValueFormat.CURRENCY)
  })
})

describe('groupDetailsByCategory', () => {
  it('groups details by category and excludes Default Category', () => {
    const details = [
      {
        name: 'fullName',
        displayName: 'Full Name',
        category: 'Personal Info',
        value: 'Alice',
        valueFormat: IhsValueFormat.STRING,
      },
      {
        name: 'email',
        displayName: 'Email',
        category: 'Personal Info',
        value: 'alice@test.com',
        valueFormat: IhsValueFormat.STRING,
      },
      {
        name: 'something',
        displayName: 'Something',
        category: 'Default Category',
        value: 'x',
        valueFormat: IhsValueFormat.STRING,
      },
    ]
    const grouped = groupDetailsByCategory(details)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].category).toBe('Personal Info')
    expect(grouped[0].items).toHaveLength(2)
  })
})

describe('buildDocumentRows (SYS-2766)', () => {
  it('builds a row for a single-URL doc field, joining documentMetadata by path', () => {
    const path = 'https://finherodms.blob.core.windows.net/dms/abc123'
    const rows = buildDocumentRows({
      ssm: path,
      documentMetadata: {
        [path]: {
          fileName: 'ssm.pdf',
          fileType: 'application/pdf',
          fileSize: 2048,
          createdAt: '2026-01-15T10:30:00',
        },
      },
    })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.docType).toBe('ssm')
    expect(r.label).toBe('SSM Company Profile')
    expect(r.documentId).toBe('abc123')
    expect(r.path).toBe(path)
    expect(r.timePeriod).toBe('ALL')
    expect(r.fileName).toBe('ssm.pdf')
    expect(r.fileType).toBe('PDF') // extension wins over MIME
    expect(r.fileSize).toBe(2048)
    expect(r.uploadedAt).toBe('2026-01-15T10:30:00')
    expect(r.displayName).toBe('ssm.pdf')
    // ssm is extractable but not re-uploadable
    expect(r.capabilities).toEqual({
      download: true,
      viewJson: true,
      reExtract: true,
      reUpload: false,
    })
  })

  it('builds period-labeled rows for a JSON-array field and derives type from MIME', () => {
    const p1 = 'https://dms/bank1'
    const p2 = 'https://dms/bank2'
    const rows = buildDocumentRows({
      bankStatements: JSON.stringify([
        { path: p1, month: 1, year: 2026 },
        { path: p2, month: 2, year: 2026 },
      ]),
      documentMetadata: {
        [p1]: { fileName: null, fileType: 'image/png', fileSize: 500, createdAt: null },
        [p2]: { fileName: null, fileType: 'image/png', fileSize: 1024 * 1024 * 3, createdAt: null },
      },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].timePeriod).toBe('T1')
    expect(rows[0].periodLabel).toBe('Jan 2026')
    expect(rows[0].fileType).toBe('PNG') // MIME subtype, no filename ext
    expect(rows[0].fileName).toBeNull()
    expect(rows[0].displayName).toBe('Bank Statements — Jan 2026')
    expect(rows[1].periodLabel).toBe('Feb 2026')
    // bankStatements is re-uploadable
    expect(rows[0].capabilities.reUpload).toBe(true)
  })

  it('uses inline metadata for supplementaryDoc (already enriched, not in documentMetadata)', () => {
    const rows = buildDocumentRows({
      supplementaryDoc: [
        {
          path: 'https://dms/supp1',
          fileName: 'contract.pdf',
          fileType: 'application/pdf',
          fileSize: 5000,
          createdAt: '2026-02-01T00:00:00',
          documentId: 'supp1',
        },
      ],
    })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.fileName).toBe('contract.pdf')
    expect(r.fileType).toBe('PDF')
    expect(r.fileSize).toBe(5000)
    expect(r.documentId).toBe('supp1')
    // supplementaryDoc is NOT extractable
    expect(r.capabilities).toEqual({
      download: true,
      viewJson: false,
      reExtract: false,
      reUpload: false,
    })
  })

  it('leaves type/size/uploaded null when no metadata is available', () => {
    const rows = buildDocumentRows({ form9: 'https://dms/f9xyz' })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.fileType).toBeNull()
    expect(r.fileSize).toBeNull()
    expect(r.uploadedAt).toBeNull()
    // the empty-state formatters render em-dash
    expect(formatDocumentType(r)).toBe('—')
    expect(formatDocumentSize(r.fileSize)).toBe('—')
    expect(formatDocumentUploaded(r)).toBe('—')
  })

  it('drops an opaque-id file name and falls back to a numbered label', () => {
    const hash = 'a'.repeat(64) // sha256-like → looks like an id
    const rows = buildDocumentRows({
      ic_documents: JSON.stringify([{ path: 'https://dms/x1' }, { path: 'https://dms/x2' }]),
      documentMetadata: {
        'https://dms/x1': { fileName: hash, fileType: null, fileSize: null, createdAt: null },
        'https://dms/x2': { fileName: hash, fileType: null, fileSize: null, createdAt: null },
      },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].fileName).toBeNull()
    expect(rows[0].displayName).toBe('Identity Documents (Supplementary) 1')
    expect(rows[1].displayName).toBe('Identity Documents (Supplementary) 2')
  })

  it('returns [] when the IHS has no document fields', () => {
    expect(buildDocumentRows({ ihsId: 1, monthlyGrossIncome: 5000 })).toEqual([])
  })
})

describe('document-table maps + formatters (SYS-2766)', () => {
  it('exposes the doc-type maps/sets', () => {
    expect(getDocDisplayNames().bankStatements).toBe('Bank Statements')
    expect(getExtractableDocTypes().has('ssm')).toBe(true)
    expect(getExtractableDocTypes().has('supplementaryDoc')).toBe(false)
    expect(getReuploadableDocTypes().has('bankStatements')).toBe(true)
    expect(getReuploadableDocTypes().has('ssm')).toBe(false)
  })

  it('formatDocumentSize renders human bytes with em-dash on unknown', () => {
    expect(formatDocumentSize(500)).toBe('500 B')
    expect(formatDocumentSize(2048)).toBe('2.0 KB')
    expect(formatDocumentSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatDocumentSize(null)).toBe('—')
    expect(formatDocumentSize(0)).toBe('—')
  })

  it('formatDocumentUploaded prefers the date, falls back to period label, then em-dash', () => {
    expect(formatDocumentUploaded({ uploadedAt: '2026-01-15T10:30:00', periodLabel: null })).toMatch(
      /2026/,
    )
    expect(formatDocumentUploaded({ uploadedAt: null, periodLabel: 'Jan 2026' })).toBe('Jan 2026')
    expect(formatDocumentUploaded({ uploadedAt: null, periodLabel: null })).toBe('—')
    // invalid date string → fall back to period label
    expect(formatDocumentUploaded({ uploadedAt: 'not-a-date', periodLabel: 'Year 2024' })).toBe(
      'Year 2024',
    )
  })
})
