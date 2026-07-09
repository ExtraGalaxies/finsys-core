import { describe, it, expect } from 'vitest'
import { getDocumentTypeGroups, isDocumentType, assertDocumentType } from './document-types.js'

describe('document-types', () => {
  describe('getDocumentTypeGroups', () => {
    it('derives all 7 known document types from the catalog, in declaration order', () => {
      const groups = getDocumentTypeGroups()
      expect(groups.map((g) => g.documentType)).toEqual([
        'bankStatements',
        'financialStatements',
        'form9',
        'ssm',
        'ic',
        'epfStatements',
        'payslips',
      ])
    })

    it('groups every per-period bank statement entry under one documentType', () => {
      const groups = getDocumentTypeGroups()
      const bank = groups.find((g) => g.documentType === 'bankStatements')
      expect(bank).toBeDefined()
      // 6 catalog entries (bank_statement_t1..t6) collapse into one group
      expect(bank!.fields.length).toBe(6)
      expect(bank!.fields.map((f) => f.name)).toEqual([
        'bank_statement_t1',
        'bank_statement_t2',
        'bank_statement_t3',
        'bank_statement_t4',
        'bank_statement_t5',
        'bank_statement_t6',
      ])
    })

    it('preserves the exact pre-existing snake_case documentGroup values consumers depend on', () => {
      // finsys-client's ihs_controller.ts specifically special-cases the
      // literal string "ssm_documents" -- this must never silently change.
      const groups = getDocumentTypeGroups()
      const byType = Object.fromEntries(groups.map((g) => [g.documentType, g.documentGroup]))
      expect(byType).toEqual({
        bankStatements: 'bank_statements',
        financialStatements: 'financials',
        form9: 'form9',
        ssm: 'ssm_documents',
        ic: 'ic_documents',
        epfStatements: 'epf_statements',
        payslips: 'payslip_statements',
      })
    })

    it('preserves the exact pre-existing display labels (behavior-identical to the old GROUP_DISPLAY_NAMES map)', () => {
      const groups = getDocumentTypeGroups()
      const byType = Object.fromEntries(groups.map((g) => [g.documentType, g.label]))
      expect(byType).toEqual({
        bankStatements: 'Bank Statements',
        financialStatements: 'Audited Financial Statements',
        form9: 'Form 9 / Section 17 / Form D',
        ssm: 'SSM Company Information',
        ic: 'Identification Card',
        epfStatements: 'EPF Statements',
        payslips: 'Payslip Statements',
      })
    })

    it('tags url_string types (singleton documents) and path_array types (multi-file documents) correctly', () => {
      const groups = getDocumentTypeGroups()
      const byType = Object.fromEntries(groups.map((g) => [g.documentType, g.wireFormat]))
      expect(byType.form9).toBe('url_string')
      expect(byType.ssm).toBe('url_string')
      expect(byType.ic).toBe('url_string')
      expect(byType.bankStatements).toBe('path_array')
      expect(byType.financialStatements).toBe('path_array')
      expect(byType.epfStatements).toBe('path_array')
      expect(byType.payslips).toBe('path_array')
    })
  })

  describe('isDocumentType / assertDocumentType', () => {
    it('recognizes every known document type', () => {
      for (const g of getDocumentTypeGroups()) {
        expect(isDocumentType(g.documentType)).toBe(true)
      }
    })

    it('rejects an unknown document type', () => {
      expect(isDocumentType('invoices')).toBe(false)
      expect(isDocumentType('')).toBe(false)
    })

    it('assertDocumentType returns the id when valid', () => {
      expect(assertDocumentType('ssm')).toBe('ssm')
    })

    it('assertDocumentType throws with the full known list when invalid', () => {
      expect(() => assertDocumentType('invoices')).toThrow(/Unknown document type: "invoices"/)
      expect(() => assertDocumentType('invoices')).toThrow(/bankStatements/)
    })
  })
})
