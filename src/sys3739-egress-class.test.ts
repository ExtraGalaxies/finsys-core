/**
 * SYS-3739 — every category declares whether a CRA may ever receive it.
 *
 * `egressClass` is the category half of the processor-only rule: a record is
 * releasable to a bureau only if its program is a controller relationship AND
 * its category is not processor-only. Declared on the category, required, and
 * refused by the loader when absent — so a new category cannot ship without
 * someone deciding which side of that line it sits on.
 */
import { describe, expect, it } from 'vitest'
import categoriesData from './data/adapter-categories.json' with { type: 'json' }
import {
  allCategories,
  buildCategoryRegistry,
  categorySchemaOf,
  egressClassOf,
  processorOnlyCategories,
  isProcessorOnlyCategory,
} from './adapter-categories.js'
import * as publicApi from './index.js'

type Raw = Parameters<typeof buildCategoryRegistry>[0]

function raw(extra: Record<string, unknown>): Raw {
  return {
    schemaVersion: '1',
    categories: [
      { id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', fields: [{ name: 'a', type: 'number', description: 'd' }], ...extra },
    ],
  } as unknown as Raw
}

describe('SYS-3739 egressClass', () => {
  it('every shipped category declares a valid egressClass in the data file', () => {
    const cats = (categoriesData as { categories: Array<{ id: string; egressClass?: unknown }> }).categories
    for (const c of cats) {
      expect([c.id, c.egressClass]).toEqual([c.id, expect.stringMatching(/^(contributable|processor-only)$/)])
    }
  })

  it('credit-bureau-report is processor-only (pinned — a bureau report bought as a processor is never contributable)', () => {
    expect(categorySchemaOf('credit-bureau-report').egressClass).toBe('processor-only')
    expect(egressClassOf('credit-bureau-report')).toBe('processor-only')
    expect(isProcessorOnlyCategory('credit-bureau-report')).toBe(true)
  })

  it('processorOnlyCategories() is exactly the categories declared processor-only', () => {
    const declared = allCategories().filter((c) => c.egressClass === 'processor-only').map((c) => c.id)
    expect(processorOnlyCategories()).toEqual(declared)
    expect(processorOnlyCategories()).toContain('credit-bureau-report')
  })

  it('every other shipped category is contributable', () => {
    for (const c of allCategories()) {
      if (c.id === 'credit-bureau-report') continue
      expect([c.id, c.egressClass]).toEqual([c.id, 'contributable'])
    }
  })

  it('an unknown id is not processor-only and has no egress class (callers decide unknowns themselves)', () => {
    expect(isProcessorOnlyCategory('no-such-category')).toBe(false)
    expect(egressClassOf('no-such-category')).toBeNull()
  })

  it('the loader carries a declared egressClass through', () => {
    expect(buildCategoryRegistry(raw({ egressClass: 'processor-only' })).all[0]!.egressClass).toBe('processor-only')
    expect(buildCategoryRegistry(raw({ egressClass: 'contributable' })).all[0]!.egressClass).toBe('contributable')
  })

  it.each([
    ['missing', {}],
    ['empty', { egressClass: '' }],
    ['unknown value', { egressClass: 'shareable' }],
    ['wrong type', { egressClass: true }],
  ])('the loader refuses a category whose egressClass is %s', (_label, extra) => {
    expect(() => buildCategoryRegistry(raw(extra))).toThrow(/egressClass/)
  })

  it('the helpers are part of the public API', () => {
    expect(typeof publicApi.processorOnlyCategories).toBe('function')
    expect(typeof publicApi.egressClassOf).toBe('function')
    expect(typeof publicApi.isProcessorOnlyCategory).toBe('function')
  })
})
