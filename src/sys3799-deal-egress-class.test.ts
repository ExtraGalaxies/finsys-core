/**
 * SYS-3799 — a category that describes the deal, not the subject, is never
 * releasable to a bureau.
 *
 * `egressClass: "deal"` sits beside `processor-only`: both are never-egress,
 * for different reasons. `processorOnlyCategories()` stays exactly the
 * processor-only set; `neverEgressCategories()` is every class but
 * `contributable`, so a class added later is barred until someone says
 * otherwise.
 */
import { describe, expect, it } from 'vitest'
import {
  allCategories,
  buildCategoryRegistry,
  CATEGORY_EGRESS_CLASSES,
  categorySchemaOf,
  egressClassOf,
  isNeverEgressCategory,
  isNeverEgressClass,
  isProcessorOnlyCategory,
  neverEgressCategories,
  processorOnlyCategories,
  type CategoryEgressClass,
} from './adapter-categories.js'
import * as publicApi from './index.js'

describe('SYS-3799 egressClass "deal"', () => {
  it('applicant-collateral is deal (pinned: collateral is a deal field, not a subject reporting field)', () => {
    expect(categorySchemaOf('applicant-collateral').egressClass).toBe('deal')
    expect(egressClassOf('applicant-collateral')).toBe('deal')
    expect(isNeverEgressCategory('applicant-collateral')).toBe(true)
  })

  it('a deal category is not processor-only: that set keeps its meaning', () => {
    expect(isProcessorOnlyCategory('applicant-collateral')).toBe(false)
    expect(processorOnlyCategories()).not.toContain('applicant-collateral')
  })

  it('neverEgressCategories() is exactly the categories whose class is not contributable', () => {
    const barred = allCategories().filter((c) => c.egressClass !== 'contributable').map((c) => c.id)
    expect(neverEgressCategories()).toEqual(barred)
    expect([...neverEgressCategories()].sort()).toEqual(['applicant-collateral', 'credit-bureau-report'])
  })

  it('every processor-only category is never-egress', () => {
    for (const id of processorOnlyCategories()) expect(isNeverEgressCategory(id)).toBe(true)
  })

  it('a contributable category is not never-egress', () => {
    expect(isNeverEgressCategory('payslip')).toBe(false)
    expect(isNeverEgressCategory('applicant-income')).toBe(false)
  })

  it('an unknown id is not never-egress here (callers decide unknowns themselves)', () => {
    expect(isNeverEgressCategory('no-such-category')).toBe(false)
  })

  it('only contributable is releasable; every other class, including one not yet declared, is barred', () => {
    for (const klass of CATEGORY_EGRESS_CLASSES) {
      expect([klass, isNeverEgressClass(klass)]).toEqual([klass, klass !== 'contributable'])
    }
    expect(isNeverEgressClass('a-class-added-later' as CategoryEgressClass)).toBe(true)
  })

  it('the loader accepts deal', () => {
    const raw = {
      schemaVersion: '1',
      categories: [
        { id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', egressClass: 'deal', fields: [{ name: 'a', type: 'number', description: 'd' }] },
      ],
    } as unknown as Parameters<typeof buildCategoryRegistry>[0]
    expect(buildCategoryRegistry(raw).all[0]!.egressClass).toBe('deal')
  })

  it('the helpers are part of the public API', () => {
    expect(typeof publicApi.neverEgressCategories).toBe('function')
    expect(typeof publicApi.isNeverEgressCategory).toBe('function')
    expect(publicApi.CATEGORY_EGRESS_CLASSES).toContain('deal')
  })
})
