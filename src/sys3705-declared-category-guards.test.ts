import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * SYS-3705 — the three guards on a DECLARED extraction category, each proven
 * to fire. None of them can fire against the shipped catalog (it is
 * consistent, which is the point), so each test swaps in a catalog that
 * breaks exactly one rule and loads the modules fresh against it.
 */

type Entry = Record<string, unknown>

async function loadWith(edit: (specs: Entry[]) => Entry[]) {
  vi.resetModules()
  vi.doMock('./catalogs.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./catalogs.js')>()
    const specs = edit(real.getBaseFieldSpecs().map((s) => ({ ...(s as Entry) })))
    return { ...real, getBaseFieldSpecs: () => specs }
  })
  const processing = await import('./ihs-processing.js')
  const documentTypes = await import('./document-types.js')
  return { ...processing, ...documentTypes }
}

afterEach(() => {
  vi.doUnmock('./catalogs.js')
  vi.resetModules()
})

const tag = (specs: Entry[], name: string, category: string): Entry[] =>
  specs.map((s) => (s.name === name ? { ...s, extraction_category: category } : s))

describe('declared extraction_category guards (SYS-3705)', () => {
  it('the unmodified catalog loads through this harness (the control)', async () => {
    const m = await loadWith((specs) => specs)
    expect(m.extractionCategoryOf('ssm')).toBe('company-profile')
    expect(m.extractionCategoryOf('managementAccounts')).toBe('management-account')
  })

  it('a declaration on a v1 type that AGREES with the map is a cross-check, and does not make the category canonical-named', async () => {
    const m = await loadWith((specs) => tag(specs, 'ssm', 'company-profile'))
    expect(m.extractionCategoryOf('ssm')).toBe('company-profile')
    expect(m.canonicalNamedCategories().has('company-profile' as never)).toBe(false)
  })

  it('a declaration on a v1 type that CONTRADICTS the map throws, rather than one of them winning silently', async () => {
    const m = await loadWith((specs) => tag(specs, 'ssm', 'payslip'))
    expect(() => m.extractionCategoryOf('ssm')).toThrow(/declares extraction_category "payslip" but the migration map derives "company-profile"/)
  })

  it('a lineage-free type declaring a category that HAS v1 lineage throws, rather than rendering two vocabularies in one table', async () => {
    const m = await loadWith((specs) => tag(specs, 'management_account', 'payslip'))
    expect(() => m.canonicalNamedCategories()).toThrow(/fields have v1 legacy names/)
  })

  it('two entries of one type declaring different categories throw at registry build', async () => {
    const m = await loadWith((specs) => [
      ...specs,
      { name: 'management_account_2', type: 'file', ihs_column_names: [], document_type: 'managementAccounts', extraction_category: 'credit-bureau-report' },
    ])
    expect(() => m.getDocumentTypeGroups()).toThrow(/declares extraction_category "credit-bureau-report" but an earlier entry declared "management-account"/)
  })
})
