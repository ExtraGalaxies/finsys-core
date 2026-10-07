/**
 * SYS-3840 — the fields that may ever be lender-visible on a bureau record,
 * declared per jurisdiction.
 *
 * Core declares the ELIGIBLE list; a program chooses a subset of it; nothing
 * outside it may ever be chosen. A jurisdiction the list does not declare has
 * not been assessed, and has no lender-visible loan terms at all.
 */
import { describe, expect, it } from 'vitest'
import shippedData from './data/lender-visible-eligible.json' with { type: 'json' }
import {
  LENDER_VISIBLE_ELIGIBLE,
  LenderVisibleRefusal,
  buildLenderVisibleEligible,
  checkLenderVisibleSubset,
  checkLenderVisibleSubsetAgainst,
  isDocumentFieldSpec,
  isLenderVisibilityAssessed,
  lenderVisibleEligibleFor,
  narrowToLenderVisibleEligible,
  narrowToLenderVisibleEligibleAgainst,
} from './lender-visibility.js'
import * as publicApi from './index.js'

/** A document field in the base spec (type "file", carries document_type). */
const DOC = 'bank_statement_t1'
/** A base, non-document field that no list declares. */
const BASE_NOT_ELIGIBLE = 'monthlyGrossIncome'

/** A populated table, so the accept paths can be exercised before any real list has content. */
const table = buildLenderVisibleEligible({
  MY: { version: 2, fields: ['totalFinancing', 'financingTenure'] },
  VN: { version: 7, fields: ['totalFinancing'] },
})

const reasons = (r: ReturnType<typeof checkLenderVisibleSubset>) =>
  r.ok ? 'ok' : r.refusals.map((x) => [x.field, x.reason])

describe('SYS-3840 shipped eligible list', () => {
  it('declares MY only, at version 1, with no fields (empty until assessed)', () => {
    expect(Object.keys(LENDER_VISIBLE_ELIGIBLE)).toEqual(['MY'])
    expect(LENDER_VISIBLE_ELIGIBLE.MY).toEqual({ version: 1, fields: [] })
    expect(shippedData).toEqual({ MY: { version: 1, fields: [] } })
  })

  it('is assessed for MY, and for an absent jurisdiction (absence means Malaysia)', () => {
    expect(isLenderVisibilityAssessed('MY')).toBe(true)
    expect(isLenderVisibilityAssessed(null)).toBe(true)
    expect(isLenderVisibilityAssessed(undefined)).toBe(true)
    expect(lenderVisibleEligibleFor(null)).toBe(LENDER_VISIBLE_ELIGIBLE.MY)
  })

  it('is NOT assessed for VN, TH, an empty string, a wrong case, or an unknown code', () => {
    for (const j of ['VN', 'TH', '', 'my', 'XX', '__proto__', 'constructor']) {
      expect([j, isLenderVisibilityAssessed(j)]).toEqual([j, false])
      expect([j, lenderVisibleEligibleFor(j)]).toEqual([j, null])
    }
  })

  it('is deep-frozen, so no consumer can widen the shared list at runtime', () => {
    expect(Object.isFrozen(LENDER_VISIBLE_ELIGIBLE)).toBe(true)
    expect(Object.isFrozen(LENDER_VISIBLE_ELIGIBLE.MY)).toBe(true)
    expect(Object.isFrozen(LENDER_VISIBLE_ELIGIBLE.MY!.fields)).toBe(true)
    expect(() => (LENDER_VISIBLE_ELIGIBLE.MY!.fields as string[]).push('totalFinancing')).toThrow(TypeError)
    expect(() => {
      ;(LENDER_VISIBLE_ELIGIBLE as Record<string, unknown>).VN = { version: 1, fields: [] }
    }).toThrow(TypeError)
    expect(isLenderVisibilityAssessed('VN')).toBe(false)
  })

  it('exports the list and its validators publicly, but not the loader or the table-taking variants', () => {
    const api = publicApi as Record<string, unknown>
    for (const name of [
      'LENDER_VISIBLE_ELIGIBLE',
      'LenderVisibleRefusal',
      'lenderVisibleEligibleFor',
      'isLenderVisibilityAssessed',
      'checkLenderVisibleSubset',
      'narrowToLenderVisibleEligible',
    ]) {
      expect([name, typeof api[name]]).not.toEqual([name, 'undefined'])
    }
    // A caller-supplied table is a channel for widening the list; only core's own may be used.
    for (const name of ['buildLenderVisibleEligible', 'checkLenderVisibleSubsetAgainst', 'narrowToLenderVisibleEligibleAgainst', 'isDocumentFieldSpec']) {
      expect([name, api[name]]).toEqual([name, undefined])
    }
  })
})

describe('SYS-3840 checkLenderVisibleSubset — shipped list', () => {
  it('accepts an empty subset under MY, and reports the list version it was checked against', () => {
    expect(checkLenderVisibleSubset('MY', [])).toEqual({ ok: true, jurisdiction: 'MY', version: 1, fields: [] })
    expect(checkLenderVisibleSubset(null, [])).toEqual({ ok: true, jurisdiction: 'MY', version: 1, fields: [] })
  })

  it('refuses a non-array', () => {
    for (const v of ['totalFinancing', null, undefined, {}, { 0: 'totalFinancing', length: 1 }, 1]) {
      expect(reasons(checkLenderVisibleSubset('MY', v))).toEqual([[undefined, LenderVisibleRefusal.NotAnArray]])
    }
  })

  it('refuses every jurisdiction the list does not declare, even with an empty subset', () => {
    for (const j of ['VN', 'TH', '', 'XX']) {
      expect([j, reasons(checkLenderVisibleSubset(j, []))]).toEqual([j, [[undefined, LenderVisibleRefusal.UnassessedJurisdiction]]])
    }
  })

  it('refuses a custom name, and names that only exist on Object.prototype', () => {
    for (const f of ['myCustomField', 'constructor', 'toString', '__proto__']) {
      expect(reasons(checkLenderVisibleSubset('MY', [f]))).toEqual([[f, LenderVisibleRefusal.NotInBaseSpec]])
    }
  })

  it('refuses a document field', () => {
    expect(reasons(checkLenderVisibleSubset('MY', [DOC]))).toEqual([[DOC, LenderVisibleRefusal.DocumentField]])
  })

  it('refuses a base field that is not eligible — and, with the list empty, every base field', () => {
    expect(reasons(checkLenderVisibleSubset('MY', [BASE_NOT_ELIGIBLE]))).toEqual([[BASE_NOT_ELIGIBLE, LenderVisibleRefusal.NotEligible]])
    expect(reasons(checkLenderVisibleSubset('MY', ['totalFinancing']))).toEqual([['totalFinancing', LenderVisibleRefusal.NotEligible]])
  })

  it('refuses a non-string entry', () => {
    expect(reasons(checkLenderVisibleSubset('MY', [42]))).toEqual([[42, LenderVisibleRefusal.NotAString]])
  })
})

describe('SYS-3840 checkLenderVisibleSubset — a populated list', () => {
  it('accepts a subset of the eligible list, sorted', () => {
    expect(checkLenderVisibleSubsetAgainst(table, 'MY', ['totalFinancing', 'financingTenure'])).toEqual({
      ok: true,
      jurisdiction: 'MY',
      version: 2,
      fields: ['financingTenure', 'totalFinancing'],
    })
  })

  it('refuses a duplicate rather than silently deduping it', () => {
    const r = checkLenderVisibleSubsetAgainst(table, 'MY', ['totalFinancing', 'totalFinancing'])
    expect(reasons(r)).toEqual([['totalFinancing', LenderVisibleRefusal.Duplicate]])
  })

  it('is per jurisdiction: a field eligible under MY is refused under VN', () => {
    expect(reasons(checkLenderVisibleSubsetAgainst(table, 'VN', ['financingTenure']))).toEqual([
      ['financingTenure', LenderVisibleRefusal.NotEligible],
    ])
    expect(checkLenderVisibleSubsetAgainst(table, 'VN', ['totalFinancing'])).toMatchObject({ ok: true, version: 7 })
    expect(reasons(checkLenderVisibleSubsetAgainst(table, 'TH', []))).toEqual([[undefined, LenderVisibleRefusal.UnassessedJurisdiction]])
  })

  it('names every refused entry, not just the first, and accepts nothing when any is refused', () => {
    const r = checkLenderVisibleSubsetAgainst(table, 'MY', ['totalFinancing', BASE_NOT_ELIGIBLE, 'myCustomField', DOC, 7, 'totalFinancing'])
    expect(reasons(r)).toEqual([
      [BASE_NOT_ELIGIBLE, LenderVisibleRefusal.NotEligible],
      ['myCustomField', LenderVisibleRefusal.NotInBaseSpec],
      [DOC, LenderVisibleRefusal.DocumentField],
      [7, LenderVisibleRefusal.NotAString],
      ['totalFinancing', LenderVisibleRefusal.Duplicate],
    ])
  })
})

describe('SYS-3840 narrowToLenderVisibleEligible — never widens', () => {
  it('returns the intersection with the eligible list, deduped and sorted', () => {
    const input = [BASE_NOT_ELIGIBLE, 'totalFinancing', 'myCustomField', DOC, 42, 'totalFinancing', 'financingTenure']
    expect(narrowToLenderVisibleEligibleAgainst(table, 'MY', input)).toEqual(['financingTenure', 'totalFinancing'])
    expect(narrowToLenderVisibleEligibleAgainst(table, 'VN', input)).toEqual(['totalFinancing'])
  })

  it('yields nothing from the shipped (empty) MY list, whatever is asked for', () => {
    expect(narrowToLenderVisibleEligible('MY', ['totalFinancing', BASE_NOT_ELIGIBLE])).toEqual([])
  })

  it('yields [] for an unassessed jurisdiction, even when the names are eligible elsewhere', () => {
    for (const j of ['TH', '', 'XX']) {
      expect([j, narrowToLenderVisibleEligibleAgainst(table, j, ['totalFinancing'])]).toEqual([j, []])
    }
    expect(narrowToLenderVisibleEligible('VN', ['totalFinancing'])).toEqual([])
  })

  it('yields [] for a non-array, and never throws', () => {
    for (const v of ['totalFinancing', null, undefined, {}, 5]) {
      expect(narrowToLenderVisibleEligibleAgainst(table, 'MY', v)).toEqual([])
    }
  })

  it('every result is in the input AND in the list, for every subset of a mixed pool', () => {
    const pool = ['totalFinancing', 'financingTenure', BASE_NOT_ELIGIBLE, 'myCustomField', DOC]
    const eligible = new Set(table.MY!.fields)
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const input = pool.filter((_, i) => mask & (1 << i))
      for (const f of narrowToLenderVisibleEligibleAgainst(table, 'MY', input)) {
        expect([input, f, input.includes(f) && eligible.has(f)]).toEqual([input, f, true])
      }
    }
  })

  it('returns a fresh array, so a caller cannot reach the list through it', () => {
    const out = narrowToLenderVisibleEligibleAgainst(table, 'MY', ['totalFinancing'])
    out.push('monthlyGrossIncome')
    expect(table.MY!.fields).toEqual(['totalFinancing', 'financingTenure'])
  })
})

describe('SYS-3840 load-time self-check (buildLenderVisibleEligible)', () => {
  const ok = { version: 1, fields: [] as unknown[] }

  it('builds the shipped data, and a valid populated table, deep-frozen', () => {
    expect(buildLenderVisibleEligible(shippedData)).toEqual({ MY: { version: 1, fields: [] } })
    expect(Object.isFrozen(table)).toBe(true)
    expect(Object.isFrozen(table.MY)).toBe(true)
    expect(Object.isFrozen(table.MY!.fields)).toBe(true)
  })

  it('refuses an entry that is not a base field', () => {
    expect(() => buildLenderVisibleEligible({ MY: { version: 1, fields: ['myCustomField'] } })).toThrow(/myCustomField.*not a base field/)
  })

  it('refuses a document field', () => {
    expect(() => buildLenderVisibleEligible({ MY: { version: 1, fields: [DOC] } })).toThrow(new RegExp(`${DOC}.*document field`))
  })

  it('treats a field as a document field when it is a file OR points at a document type', () => {
    expect(isDocumentFieldSpec({ name: 'a', type: 'file' })).toBe(true)
    expect(isDocumentFieldSpec({ name: 'b', type: 'text', document_type: 'bank_statement' })).toBe(true)
    expect(isDocumentFieldSpec({ name: 'c', type: 'text' })).toBe(false)
  })

  it('refuses a duplicate entry', () => {
    expect(() => buildLenderVisibleEligible({ MY: { version: 1, fields: ['totalFinancing', 'totalFinancing'] } })).toThrow(
      /totalFinancing.*more than once/,
    )
  })

  it('refuses a jurisdiction the registry does not declare', () => {
    for (const j of ['XX', 'my', '', '__proto__']) {
      expect(() => buildLenderVisibleEligible(JSON.parse(JSON.stringify({ [j]: ok })))).toThrow(/jurisdiction registry does not declare/)
    }
  })

  it('refuses a non-string entry', () => {
    expect(() => buildLenderVisibleEligible({ MY: { version: 1, fields: [42] } })).toThrow(/not a string/)
  })

  it('refuses a fields value that is not an array', () => {
    for (const fields of ['totalFinancing', null, undefined, {}]) {
      expect(() => buildLenderVisibleEligible({ MY: { version: 1, fields } })).toThrow(/fields must be an array/)
    }
  })

  it('refuses a version that is not a positive integer', () => {
    for (const version of [undefined, 0, -1, 1.5, '1', null]) {
      expect(() => buildLenderVisibleEligible({ MY: { version, fields: [] } })).toThrow(/version must be a positive integer/)
    }
  })

  it('refuses a malformed document or entry', () => {
    for (const raw of [null, [], 'MY', 1]) {
      expect(() => buildLenderVisibleEligible(raw)).toThrow(/must be an object of jurisdiction/)
    }
    for (const entry of [null, [], 'x']) {
      expect(() => buildLenderVisibleEligible({ MY: entry })).toThrow(/must be an object of \{version, fields\}/)
    }
  })
})
