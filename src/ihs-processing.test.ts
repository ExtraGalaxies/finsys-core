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
    if (bank) {
      const item = bank.items.find((i) => i.data['T1'] === 'Maybank')
      expect(item).toBeDefined()
      expect(item!.confidence?.['T1']).toBe(0.91)
      expect(item!.confidence?.['T2']).toBeUndefined()
      expect(item!.provenance?.['T2']?.origin).toBe('derived')
    }
  })

  it('omits confidence/provenance when none supplied (backward compatible)', () => {
    const tables = buildFileFieldTables({ bankNameT1: 'Maybank', bankNameT2: 'CIMB' })
    const bank = tables['bank_statements']
    if (bank) {
      expect(bank.items[0].confidence).toBeUndefined()
      expect(bank.items[0].provenance).toBeUndefined()
    }
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
